import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const location = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};
const guid = value => value.replaceAll('-', '').toLowerCase();

test('two designated Jellyfin Web sessions remotely pause, resume and stop decoded video with persisted progress', {
  skip: !enabled, timeout: 360000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'jellyfin-remote-control-' + randomUUID());
  await mkdir(output, { recursive: true });
  const report = { steps: [], actors: {}, requests: [], sockets: [], pageErrors: [], consoleErrors: [],
    preparation: {}, cleanup: [] };
  let fixture, client, browser, failure, failed = false;
  const pages = {};
  const sanitize = text => {
    for (const secret of fixture?.secrets ?? [process.env.MEDIAMANAGER_TEST_POSTGRES]) {
      if (secret) text = text.replaceAll(secret, '[credential redacted]');
    }
    return text.replace(/([?&](?:api_?key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  const api = (page, pattern, method = 'GET', predicate = () => true) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === fixture.origin && pattern.test(url.pathname)
      && response.request().method() === method && predicate(response);
  });
  const body = async (response, status = 200) => {
    if (status === 204) { assert.equal(response.status(), 204); return null; }
    const text = await response.text();
    assert.equal(response.status(), status, text);
    return text === '' ? null : JSON.parse(text);
  };
  const videoState = () => pages.receiver.locator('video.htmlvideoplayer').evaluate(video => ({
    paused: video.paused, ended: video.ended, currentTime: video.currentTime, readyState: video.readyState,
    width: video.videoWidth, height: video.videoHeight, error: video.error ? { code: video.error.code, message: video.error.message } : null,
  }));
  try {
    const supplied = await browserInputs(), web = await jellyfinWebInputs();
    report.browser = { revision: supplied.revision, version: supplied.browserVersion };
    report.client = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    fixture = await createWebServerFixture({ populated: true, resumePlayback: true, preparation: report.preparation, signal: t.signal });
    report.source = fixture.source;
    report.media = fixture.media;
    client = await serveWebClient(web.runtime);
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: supplied.executable });
    assert.equal(browser.version(), supplied.browserVersion);
    for (const actor of ['receiver', 'controller']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
      await context.grantPermissions(['notifications'], { origin: client.origin });
      const page = await context.newPage(); pages[actor] = page;
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => report.pageErrors.push({ actor, error: errorObservation(error) }));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ actor, text: message.text() }); });
      page.on('response', response => report.requests.push({ actor, ...location(response.url()),
        method: response.request().method(), status: response.status() }));
      page.on('requestfailed', request => report.requests.push({ actor, ...location(request.url()),
        method: request.method(), failure: request.failure()?.errorText }));
      page.on('websocket', socket => {
        const observation = { actor, ...location(socket.url()), messages: [], openedAt: new Date().toISOString() };
        report.sockets.push(observation);
        socket.on('framereceived', event => {
          const text = typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8');
          try { observation.messages.push(JSON.parse(text)); }
          catch { observation.messages.push({ unparsed: text }); }
        });
        socket.on('socketerror', error => { observation.error = error; });
        socket.on('close', () => { observation.closedAt = new Date().toISOString(); });
      });
      await page.goto(client.origin + '/index.html');
      await page.locator('#selectServerPage .btnAddServer').click();
      await page.locator('#txtServerHost').fill(fixture.origin);
      await page.locator('.addServerForm button[type="submit"]').click();
      await page.locator('#loginPage').waitFor({ state: 'visible' });
      await page.locator('#txtManualName').fill(fixture.username);
      await page.locator('#txtManualPassword').fill(fixture.password);
      const [authentication] = await Promise.all([
        api(page, /\/Users\/AuthenticateByName$/iu, 'POST'),
        api(page, /\/(?:UserViews|Users\/[^/]+\/Views)$/iu),
        page.locator('.manualLoginForm button[type="submit"]').click(),
      ]);
      const login = await body(authentication); fixture.secrets.add(login.AccessToken);
      assert.equal(login.User.Id, fixture.userId);
      report.actors[actor] = { sessionId: login.SessionInfo.Id, deviceId: login.SessionInfo.DeviceId, userId: login.User.Id };
      await page.waitForURL(/#\/home(?:[?]|$)/u);
      await page.locator('#indexPage').waitFor({ state: 'visible' });
    }
    assert.notEqual(report.actors.receiver.sessionId, report.actors.controller.sessionId);
    assert.notEqual(report.actors.receiver.deviceId, report.actors.controller.deviceId);
    report.steps.push('two-independent-browser-password-logins');
    const receiver = pages.receiver, controller = pages.controller, movieId = fixture.media.item.Id;
    await receiver.locator(`#indexPage a[aria-label="${fixture.media.libraryName}"]`).click();
    const card = receiver.locator(`.page:not(.hide) .card[data-id="${movieId}"] .cardText a[title="${fixture.media.name}"]`).first();
    const [detail] = await Promise.all([api(receiver, new RegExp(`/Items/${movieId}$`, 'iu')), card.click()]);
    report.initialDetail = await body(detail);
    const [negotiation, start] = await Promise.all([
      api(receiver, new RegExp(`/Items/${movieId}/PlaybackInfo$`, 'iu'), 'POST'),
      api(receiver, /\/Sessions\/Playing$/iu, 'POST'),
      receiver.waitForFunction(() => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && !video.paused && !video.error && video.readyState >= 2 && video.currentTime >= 4 && video.videoWidth > 0;
      }),
      receiver.locator('#itemDetailPage:visible .btnPlay').click(),
    ]);
    report.negotiation = await body(negotiation);
    await body(start, 204);
    report.started = start.request().postDataJSON();
    assert.equal(report.started.PlayMethod, 'DirectPlay');
    assert.equal(report.started.ItemId, movieId);
    // The client reads this value from the actual media URL. A static direct
    // stream has no playSessionId query parameter, so it reports an empty ID.
    const deliveryUrl = new URL(await receiver.locator('video.htmlvideoplayer').evaluate(video => video.currentSrc));
    const deliveryPlaySessionId = [...deliveryUrl.searchParams].find(([name]) => name.toLowerCase() === 'playsessionid')?.[1] ?? '';
    report.mediaDelivery = { ...location(deliveryUrl.href), playSessionId: deliveryPlaySessionId };
    assert.equal(report.started.PlaySessionId, deliveryPlaySessionId);
    assert.ok(report.negotiation.MediaSources.some(source => source.SupportsDirectPlay));
    report.playing = await videoState();
    assert.equal(report.playing.error, null);
    const video = fixture.media.preparation.output.packetEvidence.find(stream => stream.type === 'video').output;
    assert.equal(report.playing.width, video.width);
    assert.equal(report.playing.height, video.height);
    assert.ok(report.requests.some(request => request.actor === 'receiver' && request.origin === fixture.origin
      && /\/(?:Videos\/[^/]+\/stream(?:\.[^/]+)?|Items\/[^/]+\/File)$/iu.test(request.path) && [200, 206].includes(request.status)));
    report.steps.push('receiver-decoded-direct-play');

    const targetId = report.actors.receiver.sessionId;
    // The modern toolbar is visible on this designated client's home page;
    // its legacy header remains mounted and hidden in the same document.
    const castButton = controller.getByRole('button', { name: 'Cast to Device', exact: true });
    report.remoteUi = { castEntry: await castButton.getAttribute('aria-controls') };
    const [targets] = await Promise.all([api(controller, /\/Sessions$/iu), castButton.click()]);
    report.targets = await body(targets);
    const target = report.targets.find(session => session.Id === targetId);
    assert.ok(target, 'The actual controllable-session response must contain the playing receiver.');
    assert.equal(target.NowPlayingItem.Id, movieId);
    assert.equal(target.SupportsRemoteControl, true);
    assert.equal(target.DeviceId, report.actors.receiver.deviceId);
    const targetLabel = target.Client ? `${target.DeviceName} - ${target.Client}` : target.DeviceName;
    report.remoteUi.targetLabel = targetLabel;
    await controller.locator('#app-remote-play-menu:visible').getByRole('menuitem').filter({ hasText: targetLabel }).click();
    const cast = controller.locator('button[aria-controls="app-remote-play-active-menu"]:visible');
    await cast.waitFor({ state: 'visible' });
    await cast.click();
    await controller.locator('#app-remote-play-active-menu:visible').getByRole('menuitem', { name: 'Remote Control', exact: true }).click();
    const remote = controller.locator('#nowPlayingPage:visible');
    await remote.locator('.nowPlayingPageTitle').filter({ hasText: fixture.media.name }).waitFor({ state: 'visible' });
    const toggle = remote.locator('.btnPlayPause');
    await toggle.waitFor({ state: 'visible' });
    report.steps.push('receiver-selected-in-cast-menu', 'remote-control-ui-opened');
    const remoteCommand = new RegExp(`/Sessions/${targetId}/Playing/PlayPause$`, 'iu');
    const [pauseCommand, pauseProgress] = await Promise.all([
      api(controller, remoteCommand, 'POST'),
      api(receiver, /\/Sessions\/Playing\/Progress$/iu, 'POST', response => response.request().postDataJSON().IsPaused === true),
      receiver.waitForFunction(() => document.querySelector('video.htmlvideoplayer')?.paused === true),
      toggle.click(),
    ]);
    await body(pauseCommand, 204); await body(pauseProgress, 204);
    report.pause = { route: location(pauseCommand.url()), progress: pauseProgress.request().postDataJSON(), video: await videoState() };
    assert.equal(report.pause.progress.ItemId, report.started.ItemId);
    assert.equal(report.pause.progress.MediaSourceId, report.started.MediaSourceId);
    assert.equal(report.pause.progress.PlaySessionId, report.started.PlaySessionId);
    assert.equal(report.pause.video.error, null);
    assert.equal(report.pause.video.paused, true);
    report.pausedUserData = await fixture.savedUserData(movieId);
    assert.ok(report.pausedUserData.length > 0);
    assert.ok(report.pausedUserData.every(row => row.PlaybackPositionTicks === BigInt(report.pause.progress.PositionTicks) && row.PlayCount === 1));
    await remote.locator('.btnPlayPause .play_circle_filled').waitFor({ state: 'visible' });
    report.steps.push('pause-ui-http-ws-video-and-postgres');
    await controller.screenshot({ path: path.join(output, 'paused-remote.png'), fullPage: true });

    const [unpauseCommand, unpauseProgress] = await Promise.all([
      api(controller, remoteCommand, 'POST'),
      api(receiver, /\/Sessions\/Playing\/Progress$/iu, 'POST', response => response.request().postDataJSON().IsPaused === false),
      receiver.waitForFunction(position => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && !video.paused && !video.error && video.currentTime >= position + 1;
      }, report.pause.video.currentTime),
      toggle.click(),
    ]);
    await body(unpauseCommand, 204); await body(unpauseProgress, 204);
    report.resumed = { progress: unpauseProgress.request().postDataJSON(), video: await videoState() };
    assert.equal(report.resumed.progress.ItemId, report.started.ItemId);
    assert.equal(report.resumed.progress.MediaSourceId, report.started.MediaSourceId);
    assert.equal(report.resumed.progress.PlaySessionId, report.started.PlaySessionId);
    assert.equal(report.resumed.video.error, null);
    assert.equal(report.resumed.video.paused, false);
    await remote.locator('.btnPlayPause .pause_circle_filled').waitFor({ state: 'visible' });
    report.steps.push('resume-ui-http-ws-and-advancing-video');

    const [stopCommand, stopReport] = await Promise.all([
      api(controller, new RegExp(`/Sessions/${targetId}/Playing/Stop$`, 'iu'), 'POST'),
      api(receiver, /\/Sessions\/Playing\/Stopped$/iu, 'POST'),
      remote.locator('.btnStop').click(),
    ]);
    await body(stopCommand, 204); await body(stopReport, 204);
    report.stopped = stopReport.request().postDataJSON();
    assert.equal(report.stopped.ItemId, movieId);
    assert.equal(report.stopped.MediaSourceId, report.started.MediaSourceId);
    assert.equal(report.stopped.PlaySessionId, report.started.PlaySessionId);
    report.stoppedUserData = await fixture.savedUserData(movieId);
    assert.ok(report.stoppedUserData.length > 0);
    assert.ok(report.stoppedUserData.every(row => row.PlaybackPositionTicks === BigInt(report.stopped.PositionTicks)
      && row.PlaybackPositionTicks >= BigInt(report.pause.progress.PositionTicks) && row.PlayCount === 1));
    await receiver.waitForFunction(() => {
      const video = document.querySelector('video.htmlvideoplayer');
      return !video || video.paused;
    });
    const commands = report.sockets.filter(socket => socket.actor === 'receiver').flatMap(socket => socket.messages)
      .filter(message => message.MessageType === 'Playstate');
    report.receivedCommands = commands;
    assert.deepEqual(commands.map(message => message.Data.Command), ['PlayPause', 'PlayPause', 'Stop']);
    assert.ok(commands.every(message => guid(message.Data.ControllingUserId) === guid(fixture.userId)));
    report.steps.push('stop-ui-http-ws-player-and-postgres', 'ordered-authorized-remote-commands');
    assert.deepEqual(client.errors, []);
  } catch (error) {
    failure = error; failed = true; report.failure = errorObservation(error);
    for (const [actor, page] of Object.entries(pages)) {
      await page.screenshot({ path: path.join(output, actor + '-failure.png'), fullPage: true,
        mask: [page.locator('input[type="password"]'), page.locator('#txtManualName')] }).catch(() => {});
      await writeFile(path.join(output, actor + '-failure.html'), sanitize(await page.content())).catch(() => {});
    }
  } finally {
    if (client) report.resources = Object.fromEntries(client.resources);
    const cleanupErrors = [];
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture]]) {
      if (!resource) continue;
      try { await resource.close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { cleanupErrors.push(error); report.cleanup.push({ name, closed: false, error: errorObservation(error) }); }
    }
    if (cleanupErrors.length) {
      failure = new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'Remote control verification or cleanup failed.',
        failed ? { cause: failure } : {});
      failed = true;
    }
    report.runtimeErrors = fixture?.errors ?? [];
    await writeFile(path.join(output, 'report.json'), sanitize(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)));
  }
  if (failed) throw new Error(sanitize(failure?.message ?? String(failure)), { cause: errorObservation(failure) });
});
