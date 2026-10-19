import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

const preference = 'useEpisodeImagesInNextUpAndResume';
const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const requestPath = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};

test('designated Jellyfin Web connects, logs in, browses home and persists a visible setting through production PostgreSQL', { skip: !enabled, timeout: 240000 }, async () => {
  const output = path.join(validationOutputRoot(), `jellyfin-web-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const report = { steps: [], requests: [], pageErrors: [], consoleErrors: [], cleanup: [] };
  let fixture, client, browser, page, failure;
  const sanitize = text => {
    if (process.env.MEDIAMANAGER_TEST_POSTGRES) text = text.replaceAll(process.env.MEDIAMANAGER_TEST_POSTGRES, '[database credential redacted]');
    for (const secret of fixture?.secrets ?? []) if (secret) text = text.replaceAll(secret, '[credential redacted]');
    return text.replace(/([?&](?:api_key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  try {
    const browserSupply = await browserInputs();
    const web = await jellyfinWebInputs();
    report.client = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    const cacheSource = 'src/utils/query/queryClient.ts';
    const cachePolicy = await readFile(path.join(web.root, 'source', cacheSource), 'utf8');
    const staleTime = /const MAX_STALENESS = (\d+) \* 1000;/u.exec(cachePolicy);
    assert.ok(staleTime, 'The designated client must declare its query-cache freshness period.');
    const staleTimeMs = Number(staleTime[1]) * 1000;
    report.cacheReadback = { source: cacheSource, sourceHead: web.receipt.sourceHead, staleTimeMs };
    report.browser = { revision: browserSupply.revision, version: browserSupply.browserVersion };
    fixture = await createWebServerFixture();
    report.source = fixture.source;
    client = await serveWebClient(web.runtime);
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: browserSupply.executable });
    report.browser.actualVersion = browser.version();
    assert.equal(report.browser.actualVersion, browserSupply.browserVersion);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => {
      report.pageErrors.push(error.message);
      (report.pageErrorStacks ??= []).push(error.stack);
    });
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('response', response => report.requests.push({ ...requestPath(response.url()), method: response.request().method(), status: response.status() }));
    page.on('requestfailed', request => report.requests.push({ ...requestPath(request.url()), method: request.method(), failure: request.failure()?.errorText }));

    // A fresh client selects its startup route before accepting server details.
    // Follow its visible connection flow instead of racing that navigation.
    await page.goto(`${client.origin}/index.html`);
    await page.locator('#selectServerPage .btnAddServer').click();
    await page.locator('#txtServerHost').fill(fixture.origin);
    await page.locator('.addServerForm button[type="submit"]').click();
    await page.locator('#loginPage').waitFor({ state: 'visible' });
    // With no publicly listed users, the client already shows this form.
    await page.locator('#txtManualName').fill(fixture.username);
    await page.locator('#txtManualPassword').fill(fixture.password);
    const [authentication] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
        && /\/Users\/AuthenticateByName$/iu.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
        .then(async response => {
          assert.equal(response.status(), 200);
          const result = await response.json();
          fixture.secrets.add(result.AccessToken);
          return result;
        }),
      page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
        && /\/(?:UserViews|Users\/[^/]+\/Views)$/iu.test(new URL(response.url()).pathname) && response.status() === 200)
        .then(async response => {
          report.viewsResponse = {
            requestAccept: response.request().headers().accept ?? null,
            contentType: response.headers()['content-type'] ?? null,
            status: response.status(),
            body: await response.text()
          };
          const body = JSON.parse(report.viewsResponse.body);
          report.viewsResponse.body = body;
          assert.ok(Array.isArray(body.Items), 'UserViews must return its Items array to the client.');
        }),
      page.locator('.manualLoginForm button[type="submit"]').click()
    ]);
    assert.equal(authentication.User.Id, fixture.userId);
    await page.waitForURL(/#\/home(?:[?]|$)/u);
    await page.locator('#indexPage').waitFor({ state: 'visible' });
    const userMenu = page.locator('button[aria-controls="app-user-menu"]');
    await userMenu.waitFor({ state: 'visible' });
    report.steps.push('connected', 'password-login', 'home-library-views');
    await page.screenshot({ path: path.join(output, 'home.png'), fullPage: true });

    await userMenu.click();
    await page.locator('#app-user-menu a[href="#/mypreferencesmenu"]').click();
    await page.locator('a.lnkDisplayPreferences').click();
    const checkbox = page.locator('#displayPreferencesPage input[name="episodeImagesInNextUp"]');
    await checkbox.waitFor({ state: 'visible' });
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    const saved = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
      && /\/DisplayPreferences\/usersettings$/iu.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST');
    const configured = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
      && /\/Users(?:\/[^/]+)?\/Configuration$/iu.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST');
    await page.locator('#displayPreferencesPage button[type="submit"]').click();
    const [savedResponse, configurationResponse] = await Promise.all([saved, configured]);
    assert.equal(savedResponse.status(), 204);
    assert.equal(configurationResponse.status(), 204);
    const rows = await fixture.savedPreference(preference);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Value, 'true');
    report.steps.push('display-setting-saved', 'postgres-value-confirmed');
    report.preference = { key: preference, value: rows[0].Value };

    // This client's persisted query cache remains fresh after its legacy settings
    // POST. Wait for its declared TTL; a full reload then awaits setUserInfo's
    // fetchQuery before useDisplaySettingForm initializes the visible values.
    const waitingSince = Date.now();
    await delay(staleTimeMs + 1000);
    report.cacheReadback.waitedMs = Date.now() - waitingSince;
    const reloaded = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
      && /\/DisplayPreferences\/usersettings$/iu.test(new URL(response.url()).pathname)
      && response.request().method() === 'GET' && response.status() === 200);
    await page.reload();
    assert.equal((await (await reloaded).json()).CustomPrefs[preference], 'true');
    await checkbox.waitFor({ state: 'visible' });
    assert.equal(await checkbox.isChecked(), true);
    report.steps.push('server-readback', 'reloaded-ui');
    await page.screenshot({ path: path.join(output, 'saved-display.png'), fullPage: true });
    assert.deepEqual(client.errors, []);
  } catch (error) {
    failure = error;
    report.failure = { name: error.name, message: error.message, stack: error.stack };
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true,
      mask: [page.locator('input[type="password"]'), page.locator('#txtManualName')] }).catch(error => {
      report.screenshotError = error.message;
    });
  } finally {
    if (client) report.resources = Object.fromEntries(client.resources);
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture]]) {
      if (!resource) continue;
      try { await resource.close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { report.cleanup.push({ name, closed: false, error: error.message }); failure ??= error; }
    }
    report.runtimeErrors = fixture?.errors ?? [];
    await writeFile(path.join(output, 'report.json'), sanitize(JSON.stringify(report, null, 2)));
  }
  if (failure) throw new Error(sanitize(failure.message));
});
