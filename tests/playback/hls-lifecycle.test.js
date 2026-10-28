import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HlsService, hlsPlan, hlsArguments, masterPlaylist } from '../../src/playback/hls.js';
import { negotiateSource } from '../../src/playback/profile.js';
import { PlaybackService } from '../../src/playback/service.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/hls-reference.json' with { type: 'json' };
import oracle from './fixtures/hls-oracle.json' with { type: 'json' };

async function eventually(condition) { for (let index = 0; index < 300; index++) { if (await condition()) return; await delay(10); } assert.fail('The asynchronous operation did not finish.'); }

test('native HLS StreamBuilder URLs and explicit packet-copy eligibility', () => {
  for (const entry of reference.profiles) {
    const source = structuredClone(entry.source);
    negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, entry.profile, { ...entry.options, CanHls: (source, options) => { try { hlsPlan(source, options); return true; } catch { return false; } }, DeviceId: 'remux-fixture', PlaySessionId: 'fixture-session', AccessToken: 'fixture-token' });
    const native = oracle.find(value => value.name === entry.name);
    if (['wrong-codec', 'no-video-copy'].includes(entry.name)) { assert.ok(native.url); assert.equal(source.SupportsTranscoding, false); }
    else assert.equal(source.TranscodingUrl, native.url, entry.name);
  }
  for (const options of [{ SegmentContainer: 'webm' }, { VideoCodec: 'hevc' }, { AllowVideoStreamCopy: false }, { AudioChannels: 1 }, { AudioSampleRate: 48000 }, { SubtitleStreamIndex: 0, SubtitleMethod: 'Encode' }]) assert.throws(() => hlsPlan(reference.source, options));
  const execution = { threads: 0, version: '8.0', maxMuxingQueueSize: 2048 };
  const plan = hlsPlan(reference.source, { SegmentContainer: 'mp4' }), args = hlsArguments('http://127.0.0.1:1/' + 'a'.repeat(64), plan, tmpdir(), 5, 300000000n, execution);
  assert.equal(args[args.indexOf('-ss') + 1], '00:00:25.021');
  assert.equal(args[args.indexOf('-codec:v:0') + 1], 'copy'); assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy');
  assert.throws(() => hlsArguments('file:///media.mkv', plan, tmpdir(), 0, 0n, execution));
});

test('an external SAMI stream negotiates a separate WebVTT HLS rendition', () => {
  const source = structuredClone(reference.source);
  const stream = { Type: 'Subtitle', Index: 3, Codec: 'sami', Path: 'Z:\\Hls\\source.ko.smi', Language: 'kor',
    IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true };
  source.MediaStreams.push(stream);
  const profile = { ...structuredClone(reference.profiles[0].profile), SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls' }] };
  const playback = new PlaybackService({ getEncodingOptions: () => defaultConfiguration('encoding') });
  const deliverable = value => playback.canDeliverHlsSubtitle(source, value);
  negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, profile, { SubtitleStreamIndex: stream.Index,
    CanHls: (value, options) => { try { hlsPlan(value, { ...options, CanDeliverHlsSubtitle: deliverable }); return true; } catch { return false; } } });
  assert.equal(source.SupportsTranscoding, true);
  assert.equal(stream.DeliveryMethod, 'Hls');
  const options = { SegmentContainer: 'ts', SubtitleStreamIndex: stream.Index, SubtitleMethod: 'Hls', CanDeliverHlsSubtitle: deliverable };
  assert.ok(hlsPlan(source, options).streams.every(value => value.type !== 'Subtitle'), 'SAMI remains a separate text rendition.');
  assert.match(masterPlaylist(source, options), /#EXT-X-MEDIA:TYPE=SUBTITLES[^\r\n]+Subtitles\/3\/subtitles\.m3u8/u);
  stream.Path = 'Z:\\Hls\\source.ko.sami';
  assert.throws(() => hlsPlan(source, options), { code: 'not-supported' }, 'The unimplemented .sami fallback is not advertised by its codec alone.');
});

test('real HLS network input sharing, version isolation, concurrency, cancellation and shutdown', async t => {
  const encoding = defaultConfiguration('encoding'), mediaEncoder = await createTestMediaEncoder(t, { configuration: encoding });
  const bytes = Buffer.from(reference.media, 'base64'), fixture = await extractionFixture({ '/source.mkv': bytes }, { delayMs: 300 });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-lifecycle-')), processes = [], exited = new Set();
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder, getCacheDirectory: async () => directory, getEncodingOptions: () => encoding, maxConcurrentJobs: 1, idleTimeoutMs: 5000,
    onProcess: ({ args }) => processes.push(args), onProgress: ({ phase, sequence }) => { if (phase === 'exit') exited.add(sequence); } });
  const server = http.createServer(async (request, response) => {
    const params = new URL(request.url, 'http://localhost').searchParams, controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try { await hls.segment(reference.source, '/source.mkv', { SegmentContainer: 'ts', SegmentLength: Number(params.get('length') ?? 6), DeviceId: params.get('device') ?? 'device', PlaySessionId: params.get('session') ?? 'session', CurrentRuntimeTicks: BigInt(params.get('runtime') ?? 0) }, 0, request, response, { signal: controller.signal }); }
    catch (error) { if (!response.headersSent && !controller.signal.aborted) { response.statusCode = error.code === 'busy' ? 429 : 503; response.end(); } else response.destroy(); }
    finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  const gets = () => fixture.requests.filter(request => request.method === 'GET').length;
  try {
    const abort = new AbortController(), first = fetch(origin, { signal: abort.signal }).catch(() => undefined);
    await eventually(() => gets() > 0);
    const shared = fetch(origin).then(async response => ({ status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }));
    await delay(20); abort.abort(); await first;
    const sharedResult = await shared; assert.equal(sharedResult.status, 200); assert.equal(sharedResult.bytes.length, 359644); assert.equal(processes.length, 1);
    // A returned segment can precede process exit. Check retention only after completion,
    // then cross the short idle window used by the active-process cancellation controls.
    await eventually(() => exited.has(1));
    hls.idleTimeoutMs = 80; hls.ping('SESSION', false);
    await delay(120); assert.equal(hls.hasJob('SESSION'), true, 'Native completed jobs retain their cache until stopped.');
    const cached = await fetch(origin); assert.equal(cached.status, 200); await cached.arrayBuffer(); assert.equal(processes.length, 1);
    const currentDirectories = await readdir(directory);
    const restarted = new HlsService({ vfs: fixture.vfs, mediaEncoder, getCacheDirectory: async () => directory, getEncodingOptions: () => encoding });
    await restarted.initialize(); assert.deepEqual(await readdir(directory), currentDirectories, 'Another live runtime owns this cache.'); await restarted.close();
    hls.idleTimeoutMs = 5000;
    fixture.replace('/source.mkv', bytes);
    const changed = await fetch(origin); assert.equal(changed.status, 200); await changed.arrayBuffer(); assert.equal(processes.length, 2, 'A new VFS version starts a new job.');
    const resegmented = await fetch(origin + '/?length=3'); assert.equal(resegmented.status, 200); await resegmented.arrayBuffer();
    assert.equal(processes.length, 3, 'A changed byte-producing plan starts a new job instead of returning a cached segment.');
    assert.equal(processes.at(-1)[processes.at(-1).indexOf('-hls_time') + 1], '3');
    const resegmentedCached = await fetch(origin + '/?length=3'); assert.equal(resegmentedCached.status, 200); await resegmentedCached.arrayBuffer();
    assert.equal(processes.length, 3, 'An identical byte-producing plan reuses its completed segment.');
    await hls.stop('unrelated-device', 'SESSION'); assert.equal(hls.hasJob('session'), false);
    const shifted = await fetch(origin + '/?session=timeline&length=3&runtime=60000000'); assert.equal(shifted.status, 200); await shifted.arrayBuffer();
    const canonical = await fetch(origin + '/?session=timeline&length=3&runtime=0'); assert.equal(canonical.status, 200); await canonical.arrayBuffer();
    assert.equal(processes.length, 5, 'A changed segment-number timeline cannot return bytes from another seek position.');
    assert.ok(processes.at(-2).includes('-ss')); assert.ok(!processes.at(-1).includes('-ss'));
    await hls.stop('unrelated-device', 'timeline');
    assert.deepEqual(await readdir(directory), []);
    hls.idleTimeoutMs = 80;
    fixture.setDelay(1000);
    let before = gets(); const waiting = fetch(origin + '/?session=busy').then(async response => { await response.arrayBuffer(); return response.status; });
    await eventually(() => gets() > before);
    assert.equal((await fetch(origin + '/?session=another')).status, 429);
    await hls.stop('wrong-device', 'busy'); assert.equal(await waiting, 503); assert.equal(hls.hasJob('busy'), false);
    before = gets(); const pinged = fetch(origin + '/?session=pinged').then(async response => { await response.arrayBuffer(); return response.status; });
    await eventually(() => gets() > before); hls.ping('pinged', false);
    assert.equal(await pinged, 503, 'Native named HLS check-ins arm the idle timer during an active read.');
    assert.equal(hls.hasJob('pinged'), false);
    before = gets(); const idleAbort = new AbortController(), idle = fetch(origin + '/?session=idle', { signal: idleAbort.signal }).catch(() => undefined);
    await eventually(() => gets() > before); idleAbort.abort(); await idle;
    await eventually(() => !hls.hasJob('idle')); assert.ok(fixture.closedReads > 0);
    before = gets(); const closing = fetch(origin + '/?session=shutdown').then(async response => { await response.arrayBuffer(); return response.status; });
    await eventually(() => gets() > before); await hls.close(); assert.equal(await closing, 503);
    assert.equal(hls.supports(reference.source, { SegmentContainer: 'ts' }), false); assert.deepEqual(await readdir(directory), []);
    assert.equal(fixture.requests.some(request => request.authorization), false);
  } finally {
    await hls.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});

test('weak-version HLS output is shared only by overlapping readers and discarded after their response group', async t => {
  const encoding = defaultConfiguration('encoding'), mediaEncoder = await createTestMediaEncoder(t, { configuration: encoding });
  const bytes = Buffer.from(reference.media, 'base64'), fixture = await extractionFixture({ '/source.mkv': bytes }, { reliableVersion: false, advisoryVersion: true, delayMs: 200 });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-unversioned-')), processes = [];
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder, getCacheDirectory: async () => directory, getEncodingOptions: () => encoding, idleTimeoutMs: 80, onProcess: ({ args }) => processes.push(args) });
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try { await hls.segment(reference.source, '/source.mkv', { SegmentContainer: 'ts', DeviceId: 'unversioned-device', PlaySessionId: 'unversioned-session', CurrentRuntimeTicks: 0n }, 0, request, response, { signal: controller.signal }); }
    catch (error) { if (!response.headersSent && !controller.signal.aborted) { response.statusCode = 503; response.end(); } else response.destroy(); }
    finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(fixture.adapter.capabilities.reliableVersion, false);
    assert.notEqual((await fixture.adapter.stat('/source.mkv')).version, null, 'The backend exposes only an advisory version.');
    const overlapping = await Promise.all([fetch(origin), fetch(origin)]);
    for (const response of overlapping) { assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 359644); }
    await eventually(async () => (await readdir(directory)).length === 0);
    assert.equal(processes.length, 1, 'Overlapping readers share one weak-version process.');
    assert.equal(hls.hasJob('unversioned-session'), true, 'Evicting weak-version bytes retains playback activity.');
    assert.equal(hls.getTranscodingInfo('unversioned-device').Container, 'ts');
    fixture.replace('/source.mkv', bytes);
    const later = await fetch(origin); assert.equal(later.status, 200); assert.equal((await later.arrayBuffer()).byteLength, 359644);
    await eventually(async () => (await readdir(directory)).length === 0);
    assert.equal(processes.length, 2, 'An unversioned source starts a fresh copy process for a later request.');
    hls.ping('unversioned-session', true);
    await delay(120);
    assert.equal(hls.hasJob('unversioned-session'), true, 'Completed playback activity survives the active-process idle window.');
    assert.equal(hls.getTranscodingInfo('unversioned-device').Container, 'ts');
    await hls.stop('wrong-device', 'unversioned-session'); assert.equal(hls.hasJob('unversioned-session'), false);
  } finally {
    await hls.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});

test('HLS response backpressure permits concurrent reads and drains readers before cache removal', async t => {
  const encoding = defaultConfiguration('encoding'), mediaEncoder = await createTestMediaEncoder(t, { configuration: encoding });
  for (const reliableVersion of [true, false]) for (const action of ['finish', 'cancel', 'stop', 'close']) {
    const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') }, { reliableVersion });
    const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-backpressure-')), processes = [];
    const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder, getCacheDirectory: async () => directory, getEncodingOptions: () => encoding, onProcess: entry => processes.push(entry) });
    let slowResponse, slowFinished = false;
    const server = http.createServer(async (request, response) => {
      if (request.url === '/slow') {
        slowResponse = response;
        // Hold the real HTTP writable above its high-water mark. This makes
        // response backpressure deterministic without changing HLS or ffmpeg.
        response.cork();
      }
      const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
      request.once('aborted', abort); response.once('close', abort);
      try {
        await hls.segment(reference.source, '/source.mkv', { SegmentContainer: 'ts', DeviceId: 'device', PlaySessionId: 'session', CurrentRuntimeTicks: 0n }, 0, request, response, { signal: controller.signal });
      } catch { response.destroy(); }
      finally {
        request.removeListener('aborted', abort); response.removeListener('close', abort);
        if (request.url === '/slow') slowFinished = true;
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
    const slow = fetch(origin + '/slow', { signal: controller.signal })
      .then(async response => ({ status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }))
      .catch(error => ({ error }));
    try {
      await eventually(() => slowResponse?.writableNeedDrain);
      const concurrent = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      assert.equal(concurrent.status, 200);
      const bytes = Buffer.from(await concurrent.arrayBuffer()); assert.equal(bytes.length, 359644);
      assert.equal(processes.length, 1, 'Concurrent responses share the same packet-copy process.');
      assert.equal(slowFinished, false, 'The first reader is still backpressured.');
      assert.equal((await readdir(directory)).length, 1, 'An active reader retains its cache.');
      if (action === 'finish') {
        slowResponse.uncork(); const actual = await slow;
        assert.equal(actual.status, 200); assert.deepEqual(actual.bytes, bytes);
      } else if (action === 'cancel') { controller.abort(); assert.ok((await slow).error); }
      else {
        if (action === 'stop') await hls.stop('device', 'session'); else await hls.close();
        assert.equal(slowResponse.destroyed, true, action + ' closes the blocked HTTP response.');
        assert.ok((await slow).error);
        assert.equal(hls.hasJob('session'), false);
        assert.deepEqual(await readdir(directory), []);
      }
      await eventually(() => slowFinished);
      if (!reliableVersion) await eventually(async () => (await readdir(directory)).length === 0);
    } finally {
      controller.abort(); await slow;
      await hls.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();
      assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
    }
  }
});

test('HLS startup removes abandoned owned caches and preserves unrelated directories', async t => {
  const encoding = defaultConfiguration('encoding'), mediaEncoder = await createTestMediaEncoder(t, { configuration: encoding });
  const fixture = await extractionFixture({}), directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-restart-'));
  const abandoned = path.join(directory, 'mediamanager-hls-abandoned'), foreign = path.join(directory, 'mediamanager-hls-foreign');
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder, getCacheDirectory: async () => directory, getEncodingOptions: () => encoding });
  try {
    await mkdir(abandoned); await mkdir(foreign);
    await writeFile(path.join(abandoned, 'owner.json'), JSON.stringify({ kind: 'mediamanager-hls', pid: process.pid, id: 'terminated-runtime' }));
    await writeFile(path.join(abandoned, 'segment0.ts'), 'abandoned output');
    await writeFile(path.join(foreign, 'keep.txt'), 'unrelated data');
    await hls.initialize();
    assert.deepEqual(await readdir(directory), ['mediamanager-hls-foreign']);
    assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'unrelated data');
  } finally { await hls.close(); await fixture.close(); assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
});
