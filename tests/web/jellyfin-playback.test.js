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

const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const location = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};
const playbackReport = request => {
  const body = request.postDataJSON();
  return Object.fromEntries(['ItemId', 'MediaSourceId', 'PlaySessionId', 'PositionTicks', 'IsPaused',
    'PlayMethod', 'Failed', 'EventName'].filter(key => Object.hasOwn(body ?? {}, key)).map(key => [key, body[key]]));
};

test('designated Jellyfin Web decodes video, reports progress and resumes the persisted position through the production entry', {
  skip: !enabled, timeout: 360000
}, async t => {
  const output = path.join(validationOutputRoot(), `jellyfin-playback-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const report = { steps: [], preparation: {}, requests: [], playbackReports: [], negotiationRequests: [],
    pageErrors: [], consoleErrors: [], cleanup: [] };
  let fixture, client, browser, page, failure;
  const sanitize = text => {
    for (const secret of fixture?.secrets ?? [process.env.MEDIAMANAGER_TEST_POSTGRES]) if (secret) text = text.replaceAll(secret, '[credential redacted]');
    return text.replace(/([?&](?:api_?key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  try {
    const supplied = await browserInputs(), web = await jellyfinWebInputs();
    report.browser = { revision: supplied.revision, version: supplied.browserVersion };
    report.client = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    fixture = await createWebServerFixture({ populated: true, resumePlayback: true, preparation: report.preparation, signal: t.signal });
    report.source = fixture.source;
    report.media = fixture.media;
    const configurationResponse = await fixture.administratorRequest('/System/Configuration');
    assert.equal(configurationResponse.status, 200);
    const configuration = await configurationResponse.json();
    report.resumePolicy = Object.fromEntries(Object.keys(fixture.source.resumePolicy).map(key => [key, configuration[key]]));
    assert.deepEqual(report.resumePolicy, fixture.source.resumePolicy);
    const movieId = fixture.media.item.Id;
    assert.ok(fixture.media.item.RunTimeTicks >= report.resumePolicy.MinResumeDurationSeconds * 10000000);
    client = await serveWebClient(web.runtime);
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: supplied.executable });
    assert.equal(browser.version(), supplied.browserVersion);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    // The unmodified client requests notification permission after sign-in.
    await context.grantPermissions(['notifications'], { origin: client.origin });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push({ at: new Date().toISOString(), message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => report.requests.push({ ...location(request.url()), at: new Date().toISOString(), method: request.method(), failure: request.failure()?.errorText }));
    page.on('response', response => report.requests.push({ ...location(response.url()), at: new Date().toISOString(), method: response.request().method(),
      status: response.status(), contentType: response.headers()['content-type'] ?? null,
      contentRange: response.headers()['content-range'] ?? null }));
    page.on('request', request => {
      if (request.method() === 'POST' && /\/Sessions\/Playing(?:\/Progress|\/Stopped)?$/iu.test(new URL(request.url()).pathname)) {
        report.playbackReports.push({ ...location(request.url()), at: new Date().toISOString(), body: playbackReport(request) });
      }
      if (request.method() === 'POST' && /\/Items\/[^/]+\/PlaybackInfo$/iu.test(new URL(request.url()).pathname)) {
        report.negotiationRequests.push({ ...location(request.url()), body: request.postDataJSON() });
      }
    });
    const api = (pattern, method = 'GET', predicate = () => true) => page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === fixture.origin && pattern.test(url.pathname) && response.request().method() === method && predicate(response);
    });
    const json = async (response, expected = 200) => {
      if (expected === 204) { assert.equal(response.status(), 204); return null; }
      const text = await response.text();
      assert.equal(response.status(), expected, text);
      return text ? JSON.parse(text) : null;
    };
    const videoState = () => page.locator('video.htmlvideoplayer').evaluate(video => ({ currentTime: video.currentTime,
      duration: video.duration, readyState: video.readyState, paused: video.paused, ended: video.ended,
      width: video.videoWidth, height: video.videoHeight, error: video.error ? { code: video.error.code, message: video.error.message } : null }));

    await page.goto(`${client.origin}/index.html`);
    report.notificationPermission = await page.evaluate(() => Notification.permission);
    assert.equal(report.notificationPermission, 'granted');
    await page.locator('#selectServerPage .btnAddServer').click();
    await page.locator('#txtServerHost').fill(fixture.origin);
    await page.locator('.addServerForm button[type="submit"]').click();
    await page.locator('#loginPage').waitFor({ state: 'visible' });
    await page.locator('#txtManualName').fill(fixture.username);
    await page.locator('#txtManualPassword').fill(fixture.password);
    const [authentication] = await Promise.all([
      api(/\/Users\/AuthenticateByName$/iu, 'POST'),
      api(/\/(?:UserViews|Users\/[^/]+\/Views)$/iu),
      page.locator('.manualLoginForm button[type="submit"]').click()
    ]);
    const login = await json(authentication);
    fixture.secrets.add(login.AccessToken);
    assert.equal(login.User.Id, fixture.userId);
    await page.waitForURL(/#\/home(?:[?]|$)/u);
    await page.locator(`#indexPage a[aria-label="${fixture.media.libraryName}"]`).click();
    const movie = page.locator(`.page:not(.hide) .card[data-id="${movieId}"] .cardText a[title="${fixture.media.name}"]`).first();
    const [details] = await Promise.all([api(new RegExp(`/Items/${movieId}$`, 'iu')), movie.click()]);
    report.initialDetail = await json(details);
    assert.equal(report.initialDetail.UserData.PlaybackPositionTicks, 0);
    assert.equal(report.initialDetail.UserData.Played, false);
    const play = page.locator('#itemDetailPage:visible .btnPlay');
    await play.waitFor({ state: 'visible' });
    report.steps.push('visible-password-login', 'scanned-movie-details');
    report.userDataBefore = await fixture.savedUserData(movieId);
    const [negotiation, started, progress] = await Promise.all([
      api(new RegExp(`/Items/${movieId}/PlaybackInfo$`, 'iu'), 'POST').then(async response => {
        report.firstNegotiation = await json(response); return response;
      }),
      api(/\/Sessions\/Playing$/iu, 'POST').then(async response => {
        report.firstStart = playbackReport(response.request()); await json(response, 204); return response;
      }),
      api(/\/Sessions\/Playing\/Progress$/iu, 'POST', response => Number(playbackReport(response.request()).PositionTicks) >= 10000000),
      page.waitForFunction(() => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && !video.paused && !video.error && video.readyState >= 2 && video.currentTime >= 4 && video.videoWidth > 0;
      }),
      play.click()
    ]);
    report.firstNegotiation = await json(negotiation);
    await json(started, 204);
    await json(progress, 204);
    report.firstStart = playbackReport(started.request());
    report.firstProgress = playbackReport(progress.request());
    report.firstVideo = await videoState();
    assert.equal(report.firstVideo.error, null);
    assert.ok(report.firstVideo.currentTime >= 4);
    const video = fixture.media.preparation.output.packetEvidence.find(stream => stream.type === 'video').output;
    assert.equal(report.firstVideo.width, video.width);
    assert.equal(report.firstVideo.height, video.height);
    assert.equal(report.firstStart.PlayMethod, 'DirectPlay');
    assert.ok(report.firstNegotiation.MediaSources.some(source => source.SupportsDirectPlay));
    const delivery = report.requests.filter(request => request.origin === fixture.origin
      && /\/(?:Videos\/[^/]+\/stream(?:\.[^/]+)?|Items\/[^/]+\/File)$/iu.test(request.path)
      && [200, 206].includes(request.status));
    assert.ok(delivery.length > 0, 'Actual browser media delivery must accompany advancing decoded video.');
    report.mediaDelivery = delivery;
    report.userDataDuring = await fixture.savedUserData(movieId);
    assert.ok(report.userDataDuring.length > 0);
    assert.ok(report.userDataDuring.every(row => row.PlaybackPositionTicks > 0n && row.Played === false && row.PlayCount === 1));
    report.steps.push('direct-play-negotiated', 'decoded-video-advancing', 'actual-media-response', 'progress-http-and-postgres');
    await page.screenshot({ path: path.join(output, 'playing.png'), fullPage: true });

    // The designated player's real viewbeforehide handler stops playback on Back.
    const [stopped] = await Promise.all([api(/\/Sessions\/Playing\/Stopped$/iu, 'POST'), page.goBack()]);
    await json(stopped, 204);
    report.firstStop = playbackReport(stopped.request());
    const savedTicks = BigInt(report.firstStop.PositionTicks);
    assert.ok(savedTicks >= 10000000n);
    report.userDataStopped = await fixture.savedUserData(movieId);
    assert.ok(report.userDataStopped.every(row => row.PlaybackPositionTicks === savedTicks && row.Played === false && row.PlayCount === 1));
    report.steps.push('browser-back-stopped-player', 'stopped-position-persisted');

    const cacheSource = 'src/utils/query/queryClient.ts';
    const cachePolicy = await readFile(path.join(web.root, 'source', cacheSource), 'utf8');
    const freshness = /const MAX_STALENESS = (\d+) \* 1000;/u.exec(cachePolicy);
    assert.ok(freshness);
    const waitingSince = Date.now();
    await delay(Number(freshness[1]) * 1000 + 1000);
    report.cacheReadback = { source: cacheSource, declaredMs: Number(freshness[1]) * 1000, waitedMs: Date.now() - waitingSince };
    const [readback] = await Promise.all([api(new RegExp(`/Items/${movieId}$`, 'iu')), page.reload()]);
    report.resumeDetail = await json(readback);
    assert.equal(BigInt(report.resumeDetail.UserData.PlaybackPositionTicks), savedTicks);
    assert.equal(report.resumeDetail.UserData.Played, false);
    await play.waitFor({ state: 'visible' });
    assert.equal(await play.getAttribute('title'), 'Resume');
    assert.deepEqual(await fixture.savedUserData(movieId), report.userDataStopped);
    report.steps.push('fresh-server-position-readback', 'visible-resume-action');
    await page.screenshot({ path: path.join(output, 'resume.png'), fullPage: true });

    const [resumedNegotiation, resumedStart] = await Promise.all([
      api(new RegExp(`/Items/${movieId}/PlaybackInfo$`, 'iu'), 'POST').then(async response => {
        report.resumedNegotiation = await json(response);
        report.resumeRequestedPosition = response.request().postDataJSON().StartTimeTicks;
        return response;
      }),
      api(/\/Sessions\/Playing$/iu, 'POST'),
      page.waitForFunction(position => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && !video.paused && !video.error && video.readyState >= 2 && video.currentTime >= position + 2;
      }, Number(savedTicks) / 10000000),
      play.click()
    ]);
    report.resumedNegotiation = await json(resumedNegotiation);
    await json(resumedStart, 204);
    report.resumedStart = playbackReport(resumedStart.request());
    report.resumedVideo = await videoState();
    assert.equal(report.resumedStart.PlayMethod, 'DirectPlay');
    assert.equal(BigInt(report.resumeRequestedPosition), savedTicks);
    report.resumeStartPositionDifferenceTicks = String(BigInt(report.resumedStart.PositionTicks) - savedTicks);
    assert.ok(report.resumedVideo.currentTime >= Number(savedTicks) / 10000000 + 2);
    report.steps.push('resume-request-from-ui', 'decoded-video-resumed-from-saved-position');
    const [resumedStop] = await Promise.all([api(/\/Sessions\/Playing\/Stopped$/iu, 'POST'), page.goBack()]);
    await json(resumedStop, 204);
    report.resumedStop = playbackReport(resumedStop.request());
    report.userDataAfter = await fixture.savedUserData(movieId);
    assert.ok(report.userDataAfter.every(row => row.PlaybackPositionTicks === BigInt(report.resumedStop.PositionTicks)
      && row.PlaybackPositionTicks > savedTicks && row.Played === false && row.PlayCount === 2));
    report.steps.push('second-stop-progress-persisted');
  } catch (error) {
    failure = error;
    report.failure = { name: error.name, message: error.message, stack: error.stack };
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true,
        mask: [page.locator('input[type="password"]'), page.locator('#txtManualName')] }).catch(() => {});
      await writeFile(path.join(output, 'failure.html'), sanitize(await page.content())).catch(() => {});
      report.lastVideo = await page.locator('video.htmlvideoplayer').first().evaluate(video => ({ currentTime: video.currentTime,
        readyState: video.readyState, paused: video.paused, error: video.error?.message })).catch(() => null);
    }
  } finally {
    if (client) { report.resources = Object.fromEntries(client.resources); report.clientErrors = client.errors; }
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture]]) {
      if (!resource) continue;
      try { await resource.close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { failure ??= error; report.cleanup.push({ name, closed: false, error: error.message }); }
    }
    report.runtimeErrors = fixture?.errors ?? [];
    await writeFile(path.join(output, 'report.json'), sanitize(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)));
  }
  if (failure) throw new Error(sanitize(failure.message));
});
