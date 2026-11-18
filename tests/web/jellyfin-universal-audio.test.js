import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const audioFixture = new URL('../playback/fixtures/flac-copy-current/assets/upstream/subset/60 - mono audio.flac', import.meta.url);

test('designated Jellyfin Web starts an audio track through the universal stream and decodes it', {
  skip: !enabled, timeout: 240000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'jellyfin-universal-audio-' + randomUUID());
  await mkdir(output);
  const report = { preparation: {}, cleanup: [], mediaResponses: [], requests: [], browserErrors: [] };
  let fixture, client, browser, primary;
  const redact = value => {
    let text = String(value);
    for (const secret of fixture?.secrets ?? [process.env.MEDIAMANAGER_TEST_POSTGRES]) {
      if (secret) text = text.replaceAll(secret, '[credential]');
    }
    return text.replace(/([?&](?:api_?key|token)=)[^&\s"']+/giu, '$1[credential]');
  };
  try {
    const supplied = await browserInputs(), web = await jellyfinWebInputs();
    report.client = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    fixture = await createWebServerFixture({ audioFixture, preparation: report.preparation, signal: t.signal });
    const { item: song, files, name } = fixture.media;
    report.source = fixture.source;
    report.sourceSha256 = files[name].sha256;
    assert.equal(report.sourceSha256, '20539fbbd6ae28cea2b2182a4c60c6c70cbb710a136199fc83200c4e5fa00b1c');
    assert.ok(song.MediaStreams.some(stream => stream.Type === 'Audio' && stream.Codec === 'flac'));
    report.item = { id: song.Id, name: song.Name, runtime: song.RunTimeTicks, streams: song.MediaStreams };

    client = await serveWebClient(web.runtime);
    report.origins = { client: client.origin, server: fixture.origin };
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: supplied.executable });
    assert.equal(browser.version(), supplied.browserVersion);
    report.browser = { revision: supplied.revision, version: browser.version() };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.grantPermissions(['notifications'], { origin: client.origin });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.browserErrors.push(redact(error.message)));
    page.on('console', message => {
      if (message.type() === 'error') report.browserErrors.push(redact(message.text()));
    });
    const universal = `/audio/${song.Id}/universal`.toLowerCase();
    const delivery = url => url.origin === fixture.origin && url.pathname.toLowerCase() === universal;
    page.on('response', response => {
      const url = new URL(response.url());
      const observation = { path: url.pathname, origin: url.origin, method: response.request().method(),
        status: response.status(), contentType: response.headers()['content-type'],
        contentRange: response.headers()['content-range'], queryKeys: [...url.searchParams.keys()] };
      if (url.origin === fixture.origin) report.requests.push(observation);
      if (delivery(url)) report.mediaResponses.push(observation);
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      const observation = { path: url.pathname, origin: url.origin, method: request.method(), failure: request.failure()?.errorText };
      if (url.origin === fixture.origin) report.requests.push(observation);
      if (delivery(url)) report.mediaResponses.push(observation);
    });

    await page.goto(client.origin + '/index.html');
    await page.locator('#selectServerPage .btnAddServer').click();
    await page.locator('#txtServerHost').fill(fixture.origin);
    await page.locator('.addServerForm button[type="submit"]').click();
    await page.locator('#txtManualName').fill(fixture.username);
    await page.locator('#txtManualPassword').fill(fixture.password);
    const [login] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.toLowerCase() === '/users/authenticatebyname'),
      page.locator('.manualLoginForm button[type="submit"]').click(),
    ]);
    assert.equal(login.status(), 200);
    const authenticated = await login.json();
    fixture.secrets.add(authenticated.AccessToken);
    assert.equal(authenticated.User.Id, fixture.userId);
    await page.waitForURL(/#\/home(?:[?]|$)/u);
    await page.locator(`#indexPage a[aria-label="${fixture.media.libraryName}"]`).click();
    await page.locator('button[aria-controls="library-view-menu"]').click();
    await page.getByRole('menuitem', { name: 'Songs', exact: true }).click();
    const play = page.locator(`.listItem[data-id="${song.Id}"]:visible .listItemBody.itemAction`);
    await play.waitFor({ state: 'visible' });
    assert.equal(await play.getAttribute('data-action'), 'playallfromhere');
    const [media, decoded] = await Promise.all([
      page.waitForResponse(response => delivery(new URL(response.url())) && response.request().method() === 'GET'),
      page.waitForFunction(expected => {
        const audio = document.querySelector('audio.mediaPlayerAudio');
        if (!audio?.currentSrc || audio.error || audio.readyState < 2 || audio.currentTime <= 0
          || new URL(audio.currentSrc).pathname.toLowerCase() !== expected) return false;
        return { currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState };
      }, universal),
      play.click(),
    ]);
    assert.ok([200, 206].includes(media.status()));
    assert.equal(media.headers()['content-type'], 'audio/flac');
    report.decoded = await decoded.jsonValue();
    report.resources = Object.fromEntries(client.resources);
    assert.ok(Object.keys(report.resources).some(name => name.endsWith('.js')));
  } catch (error) { primary = new Error(redact(error.message)); throw primary; }
  finally {
    const failures = [];
    for (const [name, close] of [['Chromium', () => browser?.close()], ['Web files', () => client?.close()],
      ['runtime and PostgreSQL', () => fixture?.close()]]) {
      try { await close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { failures.push(new Error(redact(error.message))); report.cleanup.push({ name, closed: false }); }
    }
    await writeFile(path.join(output, 'report.json'), redact(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n'));
    if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures, 'Audio Web fixture cleanup failed.');
  }
});
