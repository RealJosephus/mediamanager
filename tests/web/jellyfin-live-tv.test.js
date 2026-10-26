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
import { md5Guid } from '../../src/core/identity.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';
import { configureLiveTv, descriptorSnapshot, location, mediaRows, observeProductionUpgrades, prepareOriginal, savedChannelData, serveOriginal, sha256, until } from './fixtures/live-tv/scenario.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite', 'jellyfinWeb', 'browser'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });

// Real M3U Guide preparation also scans the official HDHomeRun provider.
test('designated Jellyfin Web browses official M3U live TV and opens, decodes, stops and reconnects to the original through production PostgreSQL', {
  skip: !enabled, timeout: 360000,
}, async t => discovery.run(async () => {
  const output = path.join(validationOutputRoot(), 'jellyfin-live-tv-' + randomUUID()); await mkdir(output);
  const report = { steps: [], preparation: {}, requests: [], upstream: [], pageErrors: [], consoleErrors: [], webSockets: [], transitions: [],
    negotiations: [], opens: [], playback: [], userData: [], observations: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false,
    actualDesignatedClientExecuted: false, actualNativeHostExecuted: false, nativeSharedHttpStreamOpenExecuted: false,
    productionRemuxOrRecordingExecuted: false, boundary: 'Actual designated Web + production PG/official M3U/Guide/auth/Open/probe/session + direct original HTTP bytes. Separate HTTP/oracle tests establish native equivalence. Browser UI playback is mandatory; anonymous HTTP is a separate negative authorization observation. No recording, encoded provider, HLS or production packet-copy path is admitted.' };
  let fixture, media, upstream, client, browser, page, channel, failure, web, supplied, upgradeSockets;
  const pendingBodies = new Set();
  const sanitize = text => {
    for (const secret of fixture?.secrets ?? [process.env.MEDIAMANAGER_TEST_POSTGRES]) if (secret) text = text.replaceAll(secret, '[credential redacted]');
    return text.replace(/([?&](?:api_?key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  const mark = async step => { report.steps.push(step); await writeFile(path.join(output, 'progress.json'), JSON.stringify(report.steps) + '\n'); };
  const observe = label => {
    const streams = fixture.application.liveStreams.snapshot(); report.observations.push({ label, at: new Date().toISOString(), streams }); return streams;
  };
  const transition = async (kind, action) => {
    const interval = { kind, startedAt: new Date().toISOString() }; report.transitions.push(interval);
    try { return await action(); } finally { interval.finishedAt = new Date().toISOString(); }
  };
  const videoState = () => page.locator('video.htmlvideoplayer').evaluate(video => ({ currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : String(video.duration), readyState: video.readyState, paused: video.paused, ended: video.ended,
    width: video.videoWidth, height: video.videoHeight, error: video.error ? { code: video.error.code, message: video.error.message } : null }));
  try {
    supplied = await browserInputs(); web = await jellyfinWebInputs();
    report.browser = { revision: supplied.revision, expectedVersion: supplied.browserVersion };
    report.client = { sourceHead: web.receipt.sourceHead, runtimeManifestSha256: web.receipt.runtimeManifest.sha256,
      buildReceiptSha256: sha256(await readFile(path.join(web.root, 'receipts/build-receipt.json'))) };
    report.client.sourceBindings = [];
    for (const relative of ['src/components/playback/playbackmanager.js', 'src/apps/legacy/controllers/livetv/livetvchannels.js',
      'src/apps/legacy/controllers/livetv/livetvsuggested.js', 'src/apps/legacy/controllers/livetv.html', 'src/RootAppRouter.tsx',
      'src/components/layoutManager.js', 'src/apps/modern/features/libraries/components/LibraryPage.tsx',
      'src/apps/modern/features/libraries/components/LibraryViewMenu.tsx', 'src/apps/modern/features/libraries/constants/libraryRoutes.ts',
      'src/utils/query/queryClient.ts']) {
      const bytes = await readFile(path.join(web.root, 'source', relative)); report.client.sourceBindings.push({ relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
    media = await prepareOriginal(report, { signal: t.signal }); upstream = await serveOriginal(media.bytes, report.upstream);
    fixture = await createWebServerFixture({ populated: false, preparation: report.preparation, signal: t.signal }); report.source = fixture.source;
    upgradeSockets = observeProductionUpgrades(report);
    for (const entry of fixture.application.networkHost.listeners) upgradeSockets.attach(entry.server, 'initial-production-server');
    t.signal.throwIfAborted();
    channel = await configureLiveTv(fixture, upstream, report);
    assert.deepEqual(observe('configured channel before browser'), []);
    client = await serveWebClient(web.runtime); assert.notEqual(client.origin, fixture.origin);
    t.signal.throwIfAborted();
    browser = await chromium.launch({ headless: true, executablePath: supplied.executable });
    report.browser.actualVersion = browser.version(); assert.equal(browser.version(), supplied.browserVersion);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.grantPermissions(['notifications'], { origin: client.origin }); page = await context.newPage(); page.setDefaultTimeout(45000);
    report.browser.userAgent = await page.evaluate(() => navigator.userAgent);
    page.on('pageerror', error => report.pageErrors.push({ at: new Date().toISOString(), message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ at: new Date().toISOString(), text: message.text() }); });
    page.on('requestfailed', request => report.requests.push({ ...location(request.url()), at: new Date().toISOString(), method: request.method(), type: request.resourceType(), failure: request.failure()?.errorText }));
    page.on('response', response => {
      const request = response.request(), info = { ...location(response.url()), at: new Date().toISOString(), method: request.method(), type: request.resourceType(), status: response.status(),
        contentType: response.headers()['content-type'] ?? null, contentLength: response.headers()['content-length'] ?? null, contentRange: response.headers()['content-range'] ?? null };
      report.requests.push(info);
      if (info.origin === fixture.origin && (info.path.startsWith('/LiveTv/') || /\/Items\/[^/]+(?:\/PlaybackInfo)?$/iu.test(info.path)
        || /\/LiveStreams\//iu.test(info.path) || /\/Sessions\/Playing/iu.test(info.path))) {
        const pending = response.text().then(text => { info.responseBody = text; }).catch(error => { info.responseReadError = error.message; });
        pendingBodies.add(pending); pending.finally(() => pendingBodies.delete(pending));
      }
    });
    page.on('request', request => {
      const url = new URL(request.url()); if (url.origin !== fixture.origin || request.method() !== 'POST') return;
      if (/\/Items\/[^/]+\/PlaybackInfo$/iu.test(url.pathname)) report.negotiations.push({ ...location(request.url()), at: new Date().toISOString(), body: request.postDataJSON() });
      if (/\/LiveStreams\/Open$/iu.test(url.pathname)) report.opens.push({ ...location(request.url()), at: new Date().toISOString(), body: request.postDataJSON() });
      if (/\/Sessions\/Playing(?:\/Progress|\/Stopped)?$/iu.test(url.pathname)) report.playback.push({ path: url.pathname, at: new Date().toISOString(), body: request.postDataJSON() });
    });
    page.on('websocket', socket => {
      const url = new URL(socket.url()), record = { ...location(socket.url()), createdAt: new Date().toISOString(), received: [], sent: [],
        hasToken: [...url.searchParams].some(([name, value]) => /^(?:api_?key|token)$/iu.test(name) && value.length > 0) };
      report.webSockets.push(record);
      const frame = event => {
        const text = typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8');
        let value; try { value = JSON.parse(text); } catch { value = { unparsed: text }; }
        return { at: new Date().toISOString(), bytes: Buffer.byteLength(text), value };
      };
      socket.on('framereceived', event => record.received.push(frame(event))); socket.on('framesent', event => record.sent.push(frame(event)));
      socket.on('socketerror', error => { record.error = error; }); socket.on('close', () => { record.closedAt = new Date().toISOString(); });
    });
    const api = (pattern, method = 'GET', match = () => true) => page.waitForResponse(response => {
      const url = new URL(response.url()); return url.origin === fixture.origin && pattern.test(url.pathname) && response.request().method() === method && match(response);
    });
    const json = async (response, status = 200) => {
      assert.equal(response.status(), status);
      if (status === 204) return null;
      const text = await response.text(); return text ? JSON.parse(text) : null;
    };

    // This separate HTTP probe uses a fresh browser context with no login token.
    const negative = await browser.newContext();
    try {
      const before = report.upstream.length, response = await negative.request.get(fixture.origin + '/Items/' + channel.Id + '/PlaybackInfo');
      report.anonymousPlayback = { status: response.status(), body: await response.text(), transport: 'Pinned browser APIRequestContext, not a Web UI action' };
      assert.equal(response.status(), 401); assert.equal(report.upstream.length, before); assert.deepEqual(observe('anonymous playback rejected'), []);
    } finally { await negative.close(); }

    await page.goto(client.origin + '/index.html'); report.actualDesignatedClientExecuted = true;
    assert.equal(await page.evaluate(() => Notification.permission), 'granted');
    await page.locator('#selectServerPage .btnAddServer').click(); await page.locator('#txtServerHost').fill(fixture.origin);
    await page.locator('.addServerForm button[type="submit"]').click(); await page.locator('#loginPage').waitFor({ state: 'visible' });
    await page.locator('#txtManualName').fill(fixture.username); await page.locator('#txtManualPassword').fill(fixture.password);
    const [authenticated, viewsResponse] = await Promise.all([api(/\/Users\/AuthenticateByName$/iu, 'POST'), api(/\/(?:UserViews|Users\/[^/]+\/Views)$/iu),
      page.locator('.manualLoginForm button[type="submit"]').click()]);
    const login = await json(authenticated); fixture.secrets.add(login.AccessToken); report.authenticatedAt = new Date().toISOString();
    assert.equal(login.User.Id, fixture.userId); report.sessionId = login.SessionInfo.Id; report.views = await json(viewsResponse);
    const liveView = report.views.Items.find(item => item.CollectionType === 'livetv'); assert.ok(liveView);
    await page.waitForURL(/#\/home(?:[?]|$)/u); await page.locator('#indexPage').waitFor({ state: 'visible' });
    await page.locator('#indexPage a[aria-label="' + liveView.Name + '"]').click();
    await page.locator('#liveTvPage').waitFor({ state: 'visible' });
    await page.locator('button[aria-controls="library-view-menu"]').click();
    const [channelResponse] = await Promise.all([api(/\/LiveTv\/Channels$/iu), page.getByRole('menuitem', { name: 'Channels', exact: true }).click()]);
    report.channelList = await json(channelResponse); assert.equal(report.channelList.Items.length, 1); assert.equal(report.channelList.Items[0].Id, channel.Id);
    const channelCard = page.locator('#liveTvPage .card[data-id="' + channel.Id + '"] .cardText a').first();
    const [details] = await Promise.all([api(new RegExp('/Items/' + channel.Id + '$', 'iu')), channelCard.click()]);
    report.detail = await json(details); assert.equal(report.detail.Type, 'TvChannel'); assert.equal(report.detail.Name, upstream.name);
    const play = page.locator('#itemDetailPage:visible .btnPlay'); await play.waitFor({ state: 'visible' });
    report.mediaRowsBefore = await mediaRows(fixture.application); report.userData.push({ phase: 'before', rows: await savedChannelData(fixture, channel.Id) });
    assert.equal(report.upstream.filter(record => record.route === '/original.mp4').length, 0, 'Guide and browsing cannot acquire original media bytes.');
    await page.screenshot({ path: path.join(output, 'channel.png'), fullPage: true }); await mark('visible-login-live-tv-channels-details');

    const playOnce = async label => {
      // The unmodified Web requests AutoOpenLiveStream. Its opened response no
      // longer advertises OpenToken, so bind the cache through a separate real
      // public GET before playback, keeping both observations and side effects.
      const before = await descriptorSnapshot(fixture.application), originalsBefore = report.upstream.filter(record => record.route === '/original.mp4').length;
      const pathname = '/Items/' + channel.Id + '/PlaybackInfo?UserId=' + fixture.userId;
      const descriptorResponse = await fixture.administratorRequest(pathname);
      const descriptorText = await descriptorResponse.text(); assert.equal(descriptorResponse.status, 200, descriptorText);
      const descriptor = JSON.parse(descriptorText), after = await descriptorSnapshot(fixture.application);
      const observation = { label, transport: 'Separate administrator HTTP GET with explicit playback user; not a client request or an open',
        request: { method: 'GET', pathname }, response: { status: descriptorResponse.status, body: descriptor }, before, after,
        changedTables: Object.keys(before.database).filter(name => stringifyNativeJson(before.database[name]) !== stringifyNativeJson(after.database[name])) };
      (report.descriptorObservations ??= []).push(observation);
      assert.deepEqual(after.mediaRows, before.mediaRows); assert.deepEqual(after.database.UserData, before.database.UserData);
      assert.deepEqual(after.files, before.files);
      assert.equal(report.upstream.filter(record => record.route === '/original.mp4').length, originalsBefore);
      assert.deepEqual(observe(label + ' descriptor GET before playback'), []);
      const advertised = descriptor.MediaSources.find(source => source.RequiresOpening && typeof source.OpenToken === 'string' && source.OpenToken.length > 0);
      assert.ok(advertised, label + ': the separate public descriptor must advertise the actual open token.');
      assert.equal(advertised.LiveStreamId, undefined);
      const sourceCount = report.upstream.length;
      const opensBefore = report.opens.length;
      const [negotiationResponse, startResponse, progressResponse] = await Promise.all([
        api(new RegExp('/Items/' + channel.Id + '/PlaybackInfo$', 'iu'), 'POST'), api(/\/Sessions\/Playing$/iu, 'POST'),
        api(/\/Sessions\/Playing\/Progress$/iu, 'POST', response => Number(response.request().postDataJSON()?.PositionTicks) >= 10000000),
        page.waitForFunction(() => { const video = document.querySelector('video.htmlvideoplayer'); return video && !video.paused && !video.error && video.readyState >= 2 && video.currentTime >= 4 && video.videoWidth > 0; }),
        play.click(),
      ]);
      const negotiation = await json(negotiationResponse); await json(startResponse, 204); await json(progressResponse, 204);
      assert.equal(negotiationResponse.request().postDataJSON().AutoOpenLiveStream, true);
      assert.equal(report.opens.length, opensBefore, 'The actual AutoOpen client must reuse the returned LiveStreamId without another explicit Open request.');
      const source = negotiation.MediaSources.find(source => source.Id === advertised.Id), playing = startResponse.request().postDataJSON(), progress = progressResponse.request().postDataJSON(), video = await videoState();
      assert.ok(source); assert.equal(source.RequiresOpening, true); assert.equal(typeof source.LiveStreamId, 'string'); assert.ok(source.LiveStreamId.length > 0);
      assert.equal(source.Protocol, 'Http'); assert.equal(source.Path, upstream.origin + '/original.mp4');
      assert.equal(source.SupportsTranscoding, false); assert.equal(source.TranscodingUrl, undefined); assert.equal(source.RequiresClosing, true);
      assert.ok(source.MediaStreams.some(stream => stream.Codec === 'h264')); assert.ok(source.MediaStreams.some(stream => stream.Codec === 'aac'));
      assert.equal(playing.ItemId, channel.Id); assert.equal(playing.LiveStreamId, source.LiveStreamId); assert.equal(playing.PlayMethod, 'DirectPlay');
      assert.equal(progress.LiveStreamId, source.LiveStreamId); assert.ok(progress.PositionTicks >= 10000000);
      assert.equal(video.error, null); assert.ok(video.currentTime >= 4); assert.equal(video.width, report.mediaPreparation.output.packetEvidence.find(stream => stream.type === 'video').output.width);
      assert.equal(video.height, report.mediaPreparation.output.packetEvidence.find(stream => stream.type === 'video').output.height);
      const active = observe(label + ' playing'); assert.equal(active.length, 1); assert.equal(active[0].ConsumerCount, 1); assert.equal(active[0].ReaderCount, 0, 'Direct original playback has no retained byte reader.');
      const browserBytes = report.upstream.slice(sourceCount).filter(record => record.route === '/original.mp4' && record.userAgent === report.browser.userAgent && record.method === 'GET' && [200, 206].includes(record.status));
      assert.ok(browserBytes.length > 0, 'The actual browser must request the original independently of ffprobe.');
      for (const record of browserBytes) assert.equal(record.sha256, sha256(media.bytes.subarray(record.start, record.end + 1)));
      const rows = await savedChannelData(fixture, channel.Id); assert.ok(rows.length > 0); assert.ok(rows.every(row => row.PlayCount >= 1 && row.Played === false && row.PlaybackPositionTicks === 0n));
      report.userData.push({ phase: label + ' playing', rows });
      const openToken = advertised.OpenToken;
      const cache = path.join(fixture.application.liveStreamProbe.cachePath, 'mediainfo', md5Guid(openToken) + '.json'), cacheBytes = await readFile(cache);
      const result = { label, negotiation, open: { transport: 'Actual client PlaybackInfo AutoOpenLiveStream', sourceId: source.Id, liveStreamId: source.LiveStreamId,
        observedOpenToken: advertised.OpenToken, explicitClientOpenRequests: report.opens.length - opensBefore }, playing, progress, video, browserBytes,
        cache: { filename: cache, bytes: cacheBytes.length, sha256: sha256(cacheBytes), binding: 'Separate real public pre-open descriptor matched to actual client AutoOpen source ID' } };
      (report.playbackResults ??= []).push(result); await page.screenshot({ path: path.join(output, label + '-playing.png'), fullPage: true });
      const [stoppedResponse] = await transition(label + '-history-stop', () => Promise.all([api(/\/Sessions\/Playing\/Stopped$/iu, 'POST'), page.goBack()]));
      await json(stoppedResponse, 204); result.stopped = stoppedResponse.request().postDataJSON();
      assert.equal(result.stopped.LiveStreamId, source.LiveStreamId); assert.ok(result.stopped.PositionTicks > 0);
      await until(() => fixture.application.liveStreams.snapshot(), value => value.length === 0, label + ' client stop closes public stream');
      assert.deepEqual(observe(label + ' stopped'), []); await play.waitFor({ state: 'visible' }); assert.equal(await play.getAttribute('title'), 'Play');
      result.rowsAfter = await savedChannelData(fixture, channel.Id); assert.ok(result.rowsAfter.length > 0); assert.ok(result.rowsAfter.every(row => row.Played === false && row.PlaybackPositionTicks === 0n));
      return result;
    };
    const first = await playOnce('first'); assert.ok(first.rowsAfter.every(row => row.PlayCount === 1)); await mark('client-open-direct-original-decoded-progress-stop');
    const stoppedRows = await savedChannelData(fixture, channel.Id); report.mediaRowsAfterFirst = await mediaRows(fixture.application);
    assert.deepEqual(report.mediaRowsAfterFirst, report.mediaRowsBefore, 'Opening/probing cannot persist a new library item or stream row.');
    assert.ok(report.webSockets.some(socket => socket.hasToken && socket.received.some(frame => frame.value.MessageType === 'ForceKeepAlive')));
    await until(() => report.webSockets, sockets => sockets.some(socket => socket.hasToken && socket.received.some(frame => frame.value.MessageType === 'UserDataChanged')), 'real client UserDataChanged notification');
    await transition('production-restart', async () => {
      const previous = fixture.application.networkHost.listeners;
      await fixture.restart();
      assert.ok(previous.every(entry => !entry.server.listening));
      for (const entry of fixture.application.networkHost.listeners) upgradeSockets.attach(entry.server, 'reopened-production-server');
    }); await mark('same-production-entry-reopened');
    const policySource = 'src/utils/query/queryClient.ts', policyBytes = await readFile(path.join(web.root, 'source', policySource));
    const freshness = /const MAX_STALENESS = (\d+) \* 1000;/u.exec(policyBytes.toString('utf8')); assert.ok(freshness);
    const waitingSince = Date.now(), declaredMs = Number(freshness[1]) * 1000;
    await delay(declaredMs + 1000); report.cacheReadback = { source: policySource, sha256: sha256(policyBytes), declaredMs, waitedMs: Date.now() - waitingSince };
    const [readback] = await transition('browser-reload', () => Promise.all([api(new RegExp('/Items/' + channel.Id + '$', 'iu')), page.reload()]));
    report.reconnectedDetail = await json(readback); assert.equal(report.reconnectedDetail.Id, channel.Id); assert.equal(report.reconnectedDetail.UserData.PlayCount, 1);
    assert.equal(report.reconnectedDetail.UserData.PlaybackPositionTicks, 0); assert.deepEqual(await savedChannelData(fixture, channel.Id), stoppedRows);
    await play.waitFor({ state: 'visible' });
    const restart = report.transitions.find(value => value.kind === 'production-restart');
    await until(() => report.webSockets, sockets => sockets.some(socket => socket.hasToken && socket.createdAt >= restart.startedAt
      && socket.received.some(frame => frame.value.MessageType === 'ForceKeepAlive')), 'same browser authenticated WebSocket reconnection');
    const second = await playOnce('reconnected'); assert.equal(second.cache.sha256, first.cache.sha256); assert.ok(second.rowsAfter.every(row => row.PlayCount === 2));
    for (const owner of ['initial-production-server', 'reopened-production-server']) assert.ok(report.productionUpgradeSockets.some(socket => socket.server === owner), 'Actual socket upgrade on ' + owner);
    report.mediaRowsAfter = await mediaRows(fixture.application); assert.deepEqual(report.mediaRowsAfter, report.mediaRowsBefore);
    await mark('same-browser-session-reconnected-replayed-stopped');
    assert.equal(report.requests.filter(request => request.origin === fixture.origin && /(?:master|main)\.m3u8|\/LiveTv\/LiveStreamFiles\//iu.test(request.path)).length, 0);
  } catch (error) {
    failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack };
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, mask: [page.locator('input[type="password"]'), page.locator('#txtManualName')] }).catch(() => {});
      await writeFile(path.join(output, 'failure.html'), sanitize(await page.content())).catch(() => {}); report.lastVideo = await videoState().catch(() => null);
    }
  } finally {
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture],
      ['production-upgrade-sockets', upgradeSockets], ['original-http', upstream], ['controlled-media', media]]) {
      if (!resource) continue;
      try {
        await transition('cleanup-' + name, () => resource.close());
        if (name === 'browser') assert.equal(browser.isConnected(), false);
        if (name === 'production-instance-and-schema') {
          assert.ok(fixture.application.networkHost.listeners.every(entry => !entry.server.listening));
          assert.deepEqual(fixture.application.liveStreams.snapshot(), []); assert.deepEqual(fixture.application.liveTvTuners.getLiveStreams(), []);
        }
        report.cleanup.push({ name, closed: true });
      } catch (error) { failure ??= error; report.cleanup.push({ name, closed: false, error: error.stack }); }
    }
    await Promise.allSettled([...pendingBodies]);
    if (client && web) try {
      report.resources = Object.fromEntries(client.resources);
      const manifest = JSON.parse(await readFile(path.join(web.root, web.receipt.runtimeManifest.path)));
      for (const [relative, actual] of client.resources) {
        const declared = manifest.files.find(entry => entry.path === relative); assert.ok(declared, 'Every served client resource belongs to the sealed runtime.');
        assert.equal(actual.sha256, declared.sha256); assert.equal(actual.bytes, declared.bytes);
      }
      report.client.observedResourcesMatchManifest = true;
    } catch (error) { failure ??= error; report.cleanup.push({ name: 'client-resource-identity', error: error.stack }); }
    report.runtimeErrors = fixture?.errors ?? [];
    report.clientErrors = client?.errors ?? [];
    report.passed = !failure;
    await writeFile(path.join(output, 'report.json'), sanitize(stringifyNativeJson(report)) + '\n');
  }
  if (failure) throw new Error(sanitize(failure.message));
}, { signal: t.signal }));
