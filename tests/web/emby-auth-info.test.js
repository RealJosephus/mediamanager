import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { nativeGuid } from '../../src/users/native.js';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { embyWebInputs } from '../../tools/validation/emby-web-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

const enabled = process.env.MEDIAMANAGER_EMBY_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const requestPath = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};

test('unmodified hosted Emby Web discovers, authenticates, reads info and reconnects with the native legacy switch disabled', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const output = path.join(validationOutputRoot(), `emby-auth-info-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const report = { steps: [], requests: [], sockets: [], systemInfo: [], capabilities: [], userSettings: [], infoErrors: [], pageErrors: [], consoleErrors: [], externalScripts: [], externalScriptErrors: [], cleanup: [] };
  const resourceChecks = [];
  let fixture, client, browser, page, failure;
  const sanitize = value => {
    for (const secret of [process.env.MEDIAMANAGER_TEST_POSTGRES, ...(fixture?.secrets ?? [])]) {
      if (secret) value = value.replaceAll(secret, '[credential redacted]');
    }
    return value.replace(/([?&](?:api_key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  const waitForKeepAlive = async since => {
    const deadline = Date.now() + 30000;
    while (!report.sockets.slice(since).some(socket => socket.messages.some(message => message.MessageType === 'ForceKeepAlive'))) {
      assert.ok(Date.now() < deadline, 'The actual Emby socket did not receive its authenticated keepalive.');
      await delay(100);
    }
  };
  try {
    const supply = await browserInputs(), web = await embyWebInputs();
    const externalInputs = new Map(web.receipt.externalResources.flatMap(resource => [[resource.url, resource], [resource.resolvedUrl, resource]]));
    report.client = { origin: web.receipt.origin, version: web.receipt.version,
      runtimeManifest: web.receipt.runtimeManifest.sha256, declaredChecksumDifferences: web.receipt.declaredChecksumDifferences };
    fixture = await createWebServerFixture({ legacyAuthorization: false });
    report.source = fixture.source;
    // This auth/info consumer uses a regular user without live TV access. Live
    // TV provider/channel behavior has a separate, still unverified contract.
    const userResponse = await fixture.administratorRequest(`/Users/${fixture.userId}`);
    assert.equal(userResponse.status, 200);
    const user = await userResponse.json();
    assert.equal((await fixture.administratorRequest(`/Users/${fixture.userId}/Policy`, {
      method: 'POST', body: { ...user.Policy, EnableLiveTvAccess: false },
    })).status, 204);
    report.permissions = { liveTvAccess: false };
    const configuration = await fixture.administratorRequest('/System/Configuration');
    assert.equal(configuration.status, 200);
    assert.equal((await configuration.json()).EnableLegacyAuthorization, false);
    client = await serveWebClient(web.runtime);
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: supply.executable });
    assert.equal(browser.version(), supply.browserVersion);
    report.browser = { revision: supply.revision, version: browser.version() };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', hasTouch: true });
    await context.grantPermissions(['notifications'], { origin: client.origin });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push({ message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('response', response => {
      report.requests.push({ ...requestPath(response.url()), method: response.request().method(), status: response.status() });
      if (new URL(response.url()).origin === fixture.origin
        && /\/(?:Sessions\/Capabilities\/Full|UserSettings\/[^/]+(?:\/Partial)?)$/iu.test(new URL(response.url()).pathname)) {
        resourceChecks.push((async () => {
          const observation = { ...requestPath(response.url()), method: response.request().method(), status: response.status(),
            contentType: response.request().headers()['content-type'], body: await response.text() };
          if (/\/Sessions\//iu.test(observation.path)) {
            const input = JSON.parse(response.request().postData());
            observation.supportedCommands = input.SupportedCommands;
            observation.playableMediaTypes = input.PlayableMediaTypes;
            report.capabilities.push(observation);
          }
          else report.userSettings.push(observation);
        })().catch(error => report.infoErrors.push(error.message)));
      }
      if (new URL(response.url()).origin === fixture.origin && response.status() === 200
        && /\/System\/Info(?:\/Public)?$/iu.test(new URL(response.url()).pathname)) {
        resourceChecks.push((async () => {
          const body = await response.json();
          report.systemInfo.push({ ...requestPath(response.url()), body });
          assert.equal(body.Version, '4.9.5.0');
          assert.equal(body.ProductName, 'MediaManager');
          assert.equal(body.Id, fixture.source.serverId);
        })().catch(error => report.infoErrors.push(error.message)));
      }
      if (response.request().resourceType() !== 'script' || new URL(response.url()).origin === client.origin) return;
      resourceChecks.push((async () => {
        const expected = externalInputs.get(response.url());
        assert.ok(expected, `Unbound external client script: ${response.url()}`);
        assert.equal(response.status(), 200);
        const bytes = await response.body(), sha256 = createHash('sha256').update(bytes).digest('hex');
        report.externalScripts.push({ url: response.url(), bytes: bytes.length, sha256 });
        assert.equal(sha256, expected.sha256, 'The browser received a different external client script.');
        assert.equal(bytes.length, expected.bytes);
      })().catch(error => report.externalScriptErrors.push(error.message)));
    });
    page.on('requestfailed', request => report.requests.push({ ...requestPath(request.url()), method: request.method(), failure: request.failure()?.errorText }));
    page.on('websocket', socket => {
      const observation = { ...requestPath(socket.url()), messages: [], errors: [] };
      report.sockets.push(observation);
      socket.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          observation.messages.push({ MessageType: message.MessageType, ...(message.MessageType === 'ForceKeepAlive' ? { Data: message.Data } : {}) });
        } catch (error) { observation.errors.push(error.message); }
      });
      socket.on('socketerror', error => observation.errors.push(String(error)));
    });
    await page.goto(`${client.origin}/index.html`);
    await page.locator('.btnWelcomeNext').click();
    await page.locator('.btnSkipConnect').click();
    // Both actions are the client's own visible connection wizard.
    const serverHost = page.locator('.txtServerHost:visible');
    const addServer = page.getByText('Add Server', { exact: true }).filter({ visible: true });
    await serverHost.or(addServer).first().waitFor({ state: 'visible' });
    if (!await serverHost.count()) await addServer.click();
    await page.locator('.txtServerHost').fill(`${fixture.origin}/emby`);
    await page.locator('.txtServerPort').fill('');
    await page.locator('.manualServerForm button[type="submit"]').click();
    const loginForm = page.locator('form:visible:has(.txtUserName)');
    await loginForm.locator('.txtUserName').waitFor({ state: 'visible' });
    report.steps.push('connection-wizard', 'server-discovery-with-emby-prefix');
    await loginForm.locator('.txtUserName').fill(fixture.username);
    await loginForm.locator('.txtPassword').fill(fixture.password);
    const [authenticated] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
        && /\/emby\/Users\/authenticatebyname$/iu.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST').then(async response => {
          assert.equal(response.status(), 200);
          const body = await response.json();
          fixture.secrets.add(body.AccessToken);
          report.authentication = { userId: body.User.Id, serverId: body.ServerId, sessionId: body.SessionInfo.Id,
            request: requestPath(response.url()), contentType: response.request().headers()['content-type'] };
          return body;
        }),
      loginForm.locator('button[type="submit"]').click(),
    ]);
    assert.equal(authenticated.User.Id, fixture.userId);
    assert.equal(authenticated.ServerId, fixture.source.serverId);
    await page.waitForURL(/#.*\/home(?:[?]|$)/u);
    await waitForKeepAlive(0);
    report.steps.push('password-login', 'home', 'authenticated-websocket');
    const capabilityDeadline = Date.now() + 30000;
    while (!report.capabilities.some(request => request.method === 'POST')
      || !report.userSettings.some(request => request.method === 'GET')) {
      assert.ok(Date.now() < capabilityDeadline, 'The real client must finish reporting capabilities and loading user settings.');
      await delay(100);
    }
    await Promise.all(resourceChecks);
    assert.ok(report.capabilities.some(request => request.method === 'POST' && request.status === 204));
    assert.ok(report.userSettings.some(request => request.method === 'GET' && request.status === 200));
    await page.screenshot({ path: path.join(output, 'home.png'), fullPage: true });
    const infoRequests = report.requests.filter(request => request.origin === fixture.origin && /\/System\/Info$/iu.test(request.path));
    assert.ok(infoRequests.some(request => request.status === 200), 'The real client must consume private System Info.');
    const discovery = report.requests.filter(request => request.origin === fixture.origin && /\/web\/(?:manifest\.json|index\.html|strings\/en-US\.json)$/iu.test(request.path));
    assert.equal(new Set(discovery.filter(request => request.status === 200).map(request => request.path)).size, 3);
    const devices = await fixture.application.store.run(db => db.rows('Devices', { where: { UserId: nativeGuid(fixture.userId) } }));
    assert.equal(devices.length, 1);
    assert.equal(devices[0].AppName, 'Emby Web');
    assert.equal(devices[0].AppVersion, web.receipt.version);
    report.device = { appName: devices[0].AppName, appVersion: devices[0].AppVersion, deviceName: devices[0].DeviceName };
    const sessionsResponse = await fixture.administratorRequest('/Sessions');
    assert.equal(sessionsResponse.status, 200);
    const session = (await sessionsResponse.json()).find(session => session.Id === authenticated.SessionInfo.Id);
    assert.deepEqual(session.SupportedCommands, report.capabilities.find(request => request.status === 204).supportedCommands);
    const socketCount = report.sockets.length;
    const reconnected = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
      && /\/System\/Info$/iu.test(new URL(response.url()).pathname)
      && new URL(response.url()).searchParams.has('api_key') && response.status() === 200);
    await page.reload();
    const savedInfo = await (await reconnected).json();
    assert.equal(savedInfo.Id, fixture.source.serverId);
    assert.equal(savedInfo.ProductName, 'MediaManager');
    assert.equal(savedInfo.Version, '4.9.5.0');
    await page.waitForURL(/#.*\/home(?:[?]|$)/u);
    await waitForKeepAlive(socketCount);
    assert.equal(await page.locator('.txtUserName:visible').count(), 0);
    report.steps.push('stored-token-info-readback', 'authenticated-reload-and-websocket-reconnect');
    await page.locator('.headerSettingsButton:visible').click();
    await page.getByText('App Settings', { exact: true }).filter({ visible: true }).click();
    await page.locator('.view:visible').getByText('Display', { exact: true }).click();
    const toggle = page.locator('input[data-settingmethod="enableAutoFolderJumpThrough"]:visible');
    await toggle.waitFor({ state: 'visible' });
    const initial = await toggle.isChecked();
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
        && /\/usersettings\/[^/]+\/Partial$/iu.test(new URL(response.url()).pathname) && response.request().method() === 'POST'),
      toggle.locator('..').click(),
    ]);
    assert.equal(saved.status(), 204);
    assert.equal(await toggle.isChecked(), !initial);
    const settings = await fixture.application.displayPreferences.getUserSettings(fixture.userId);
    assert.equal(settings.get('enableAutoFolderJumpThrough'), String(!initial));
    report.steps.push('visible-display-setting-save', 'postgres-setting-readback');
    const settingsSocketCount = report.sockets.length;
    await page.reload();
    await toggle.waitFor({ state: 'visible' });
    await waitForKeepAlive(settingsSocketCount);
    assert.equal(await toggle.isChecked(), !initial);
    report.steps.push('setting-reload-readback');
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    await Promise.all(resourceChecks);
    assert.deepEqual(report.infoErrors, []);
    assert.deepEqual(report.externalScriptErrors, []);
    // Page and console errors remain diagnostics. Actual UI, API, persisted
    // settings and socket observations establish this interaction's result.
    assert.deepEqual(report.requests.filter(request => request.origin === fixture.origin && request.status >= 400), []);
    assert.deepEqual(client.errors, []);
    assert.ok(report.sockets.every(socket => socket.errors.length === 0));
  } catch (error) {
    failure = error;
    report.failure = { name: error.name, message: error.message, stack: error.stack };
    if (page) {
      report.failure.url = page.url();
      report.failure.visibleText = await page.locator('body').innerText().catch(() => 'Unavailable');
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true,
        mask: [page.locator('input[type="password"]'), page.locator('.txtUserName')] }).catch(error => { report.screenshotError = error.message; });
    }
  } finally {
    if (client) report.resources = Object.fromEntries(client.resources);
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture]]) {
      if (!resource) continue;
      try { await resource.close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { report.cleanup.push({ name, closed: false, error: error.message }); failure ??= error; }
    }
    await Promise.all(resourceChecks);
    if (report.infoErrors.length) failure ??= new Error(report.infoErrors.join('\n'));
    if (report.externalScriptErrors.length) failure ??= new Error(report.externalScriptErrors.join('\n'));
    report.clientErrors = client?.errors ?? [];
    report.runtimeErrors = fixture?.errors ?? [];
    await writeFile(path.join(output, 'report.json'), sanitize(JSON.stringify(report, null, 2)) + '\n');
  }
  if (failure) throw new Error(sanitize(failure.message));
});
