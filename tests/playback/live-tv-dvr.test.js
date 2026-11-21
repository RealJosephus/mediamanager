import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { M3uTuner } from '../../plugins/m3u/tuner.js';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { LiveTvMediaSources } from '../../src/library/live-tv-media-sources.js';
import { LiveTvTunerService } from '../../src/library/live-tv-tuner-service.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { recordTransportStream } from '../../src/media-execution/recording.js';
import { LiveStreamReadBridge } from '../../src/playback/live-stream-bridge.js';
import { LiveStreamProbe } from '../../src/playback/live-stream-probe.js';
import { LiveStreamsService } from '../../src/playback/live-streams.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { localStateStorage } from '../helpers/local-state-storage.js';

test('DVR follows relative HLS playlists and segments with the original HTTP headers', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-dvr-hls-'));
  const storage = await localStateStorage(root);
  const ffmpeg = validationExecutable('ffmpeg');
  const finished = Promise.withResolvers(), errors = [], transitions = [];
  const requests = [];
  let dvr;
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, agent: request.headers['user-agent'], token: request.headers['x-channel'] });
    if (request.headers['user-agent'] !== 'Dvr fixture' || request.headers['x-channel'] !== 'owned') {
      response.writeHead(403).end(); return;
    }
    const manifest = playlists.get(request.url);
    if (manifest) { response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(manifest); return; }
    if (request.url === '/lineup/media/segments/intro.ts?v=1') {
      response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(segment); return;
    }
    response.writeHead(404).end();
  });
  t.after(async () => {
    await dvr?.close();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const playlists = new Map([
    ['/lineup/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nmedia/variant.m3u8\n'],
    ['/lineup/media/variant.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nsegments/intro.ts?v=1\n#EXT-X-ENDLIST\n'],
  ]);
  const generated = await captureMediaProcess(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'mpeg2video', '-f', 'mpegts', 'pipe:1',
  ], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  const segment = generated.stdout;
  assert.ok(segment.length > 1880);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');

  const timer = { Id: 'owned', ChannelId: 'channel', Name: 'Relative HLS', StartDate: new Date().toISOString(),
    EndDate: new Date(Date.now() + 60000).toISOString(), PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
  const source = { Protocol: 'Http', Path: `http://127.0.0.1:${server.address().port}/lineup/master.m3u8`,
    Container: 'hls', RequiresOpening: true, RequiredHttpHeaders: { 'User-Agent': 'Dvr fixture', 'X-Channel': 'owned' } };
  let released = 0;
  dvr = new LiveTvDvr({
    fileSystem: storage.fileSystem, dataPath: root,
    timers: {
      readRecordingTimers: async () => [timer],
      async updateRecordingTimer(_timer, change) {
        transitions.push(change);
        dvr.syncTimers(change ? [{ ...timer, ...change }] : []);
        return true;
      },
    },
    library: { itemCreation: { getItemById: async () => ({ Id: 'channel', Type: 'LiveTvChannel' }) } },
    mediaSources: { getMediaSources: async () => [source] },
    liveStreams: { openOwned: async () => ({ MediaSource: source, release: () => { released++; } }) },
    mediaEncoder: { ready: true, encoderPath: ffmpeg, getEncodingOptions: () => ({ EncodingThreadCount: 0 }) },
    configuration: { getConfiguration: async () => ({}), release() {} },
    runBackground: operation => operation().finally(finished.resolve), onError: error => errors.push(error),
  });
  await dvr.start(); await finished.promise;
  assert.deepEqual(errors, []);
  assert.deepEqual(transitions.map(change => change.Status), ['InProgress', 'Completed']);
  assert.equal(released, 1);
  const recording = await readFile(transitions.at(-1).RecordingPath);
  assert.ok(recording.length > 1880 && recording.length % 188 === 0 && recording[0] === 0x47);
  assert.deepEqual(new Set(requests.map(request => request.path)), new Set([...playlists.keys(), '/lineup/media/segments/intro.ts?v=1']));
  assert.ok(requests.every(request => request.agent === 'Dvr fixture' && request.token === 'owned'));
});

test('DVR reads nested manifests and byte-range segments through the authorized file mount', { timeout: 30000 }, async t => {
  const ffmpeg = validationExecutable('ffmpeg');
  const media = await captureMediaProcess(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-c:v', 'mpeg2video', '-f', 'mpegts', 'pipe:1',
  ], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
  assert.equal(media.exitCode, 0, media.stderr.toString());
  assert.ok(media.stdout.length > 1880);
  for (const backend of ['local', 'vfs']) await t.test(backend, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-dvr-mapped-hls-'));
    const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    const fileSystem = new StorageFileSystem({ vfs, identityMap }), observed = [];
    let dvr, bridge;
    t.after(async () => {
      await dvr?.close();
      await bridge?.close();
      await registry.close();
      await rm(root, { recursive: true, force: true });
    });
    registry.registerType('local', config => LocalAdapter.open(config));
    registry.registerType('vfs', () => new MemoryStorageAdapter());
    const disk = await registry.createInstance('output', 'local', { root, writable: true });
    const adapter = backend === 'local' ? disk : await registry.createInstance('input', 'vfs', {});
    const writes = { create: true, replace: true, mkdir: true };
    vfs.mount({ path: '/disk', instanceId: 'output', capabilities: writes });
    vfs.mount({ path: '/tuner', instanceId: backend === 'local' ? 'output' : 'input', capabilities: writes });
    vfs.mount({ path: '/tuner/other-mount', instanceId: 'output', capabilities: {} });
    const tuner = path.join(root, 'virtual');
    const bind = (identityRoot, accessRoot) => identityMap.addPrefix({ identityRoot, accessRoot,
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated mapped HLS fixture' });
    bind(root, '/disk'); bind(tuner, '/tuner');
    const master = path.join(tuner, 'master.m3u8');
    const variant = path.join(tuner, 'renditions', 'primary.m3u8');
    const segment = path.join(tuner, 'segments', 'intro clip.ts');
    await fileSystem.mkdir(path.dirname(variant), { recursive: true });
    await fileSystem.mkdir(path.dirname(segment), { recursive: true });
    await fileSystem.writeFile(master, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nrenditions/primary.m3u8\n');
    await fileSystem.writeFile(variant, '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n'
      + `#EXT-X-BYTERANGE:${media.stdout.length}@188\n../segments/intro%20clip.ts?copy=1\n#EXT-X-ENDLIST\n`);
    await fileSystem.writeFile(segment, Buffer.concat([Buffer.alloc(188), media.stdout]));
    const openRead = adapter.openRead.bind(adapter);
    t.mock.method(adapter, 'openRead', (filename, options) => {
      observed.push({ filename, range: options.range });
      return openRead(filename, options);
    });
    const timer = { Id: 'mapped', ChannelId: 'channel', Name: 'Mapped HLS', StartDate: new Date().toISOString(),
      EndDate: new Date(Date.now() + 60000).toISOString(), PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
    const source = { Protocol: 'File', Path: master, RequiresOpening: true };
    const finished = Promise.withResolvers(), errors = [], transitions = [];
    dvr = new LiveTvDvr({
      fileSystem, dataPath: root,
      timers: {
        readRecordingTimers: async () => [timer],
        updateRecordingTimer: async (_timer, change) => {
          transitions.push(change);
          dvr.syncTimers(change ? [{ ...timer, ...change }] : []);
          return true;
        },
      },
      library: { itemCreation: { getItemById: async () => ({ Id: 'channel', Type: 'LiveTvChannel' }) } },
      mediaSources: { getMediaSources: async () => [source] },
      liveStreams: { openOwned: async () => ({ MediaSource: source, release() {} }) },
      mediaEncoder: { ready: true, encoderPath: ffmpeg, getEncodingOptions: () => ({ EncodingThreadCount: 0 }) },
      configuration: { getConfiguration: async () => ({}), release() {} },
      runBackground: operation => operation().finally(finished.resolve), onError: error => errors.push(error),
    });
    await dvr.start(); await finished.promise;
    assert.deepEqual(errors, []);
    assert.deepEqual(transitions.map(change => change.Status), ['InProgress', 'Completed']);
    const recorded = await readFile(transitions.at(-1).RecordingPath);
    assert.ok(recorded.length > 1880 && recorded.length % 188 === 0 && recorded[0] === 0x47);
    assert.deepEqual(new Set(observed.map(entry => entry.filename)), new Set(['/master.m3u8', '/renditions/primary.m3u8', '/segments/intro clip.ts']));
    assert.ok(observed.some(entry => entry.filename.endsWith('.ts') && entry.range?.start === 188n));

    if (backend === 'vfs') {
      bridge = new LiveStreamReadBridge();
      const lease = await bridge.leaseMappedHls(vfs, '/tuner/master.m3u8', { signal: t.signal });
      assert.equal((await fetch(new URL('other-mount/behind-overlay.ts', lease.url))).status, 403);
      await fileSystem.writeFile(variant, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://example.invalid/segment.ts\n#EXT-X-ENDLIST\n');
      assert.equal((await fetch(new URL('renditions/primary.m3u8', lease.url))).status, 403);
      await lease.release();
    }
  });
});

test('DVR probes and records MPEG-TS from the original UDP channel selected by M3U', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-dvr-udp-'));
  const storage = await localStateStorage(root), errors = [], transitions = [], probes = [];
  const encoderPath = validationExecutable('ffmpeg'), mediaEncoder = { ready: true, encoderPath,
    probePath: validationExecutable('ffprobe'), getEncodingOptions: () => ({ EncodingThreadCount: 0 }) };
  const probe = new LiveStreamProbe({ cachePath: root, mediaEncoder, probeOptions: { timeoutMs: 5000 }, onError: error => errors.push(error) });
  const sender = createSocket('udp4'), reservation = createSocket('udp4');
  let dvr, pulse, mediaSources, liveStreams, tuners;
  const tuner = new M3uTuner({ cachePath: root, isLocalNetwork: () => true, logger: { error: error => errors.push(error) } });
  t.after(async () => {
    clearInterval(pulse);
    await dvr?.close();
    await liveStreams?.close();
    await probe.close();
    await mediaSources?.close();
    await tuners?.close();
    await tuner.close();
    sender.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  sender.on('error', error => errors.push(error));
  sender.bind(0, '127.0.0.1'); await once(sender, 'listening');
  reservation.bind(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const location = `udp://127.0.0.1:${port}?fifo_size=10000&overrun_nonfatal=1`;
  const playlist = path.join(root, 'lineup.m3u');
  await writeFile(playlist, '#EXTM3U\n#EXTINF:-1 tvg-id="udp-1",UDP channel\n' + location + '\n');
  const configuration = { TunerHosts: [{ Type: 'm3u', Id: 'udp', Url: playlist, TunerCount: 1, EnableStreamLooping: true }] };
  tuner.connect({ fileSystem: storage.fileSystem, liveTv: { admitRead: () => ({ getConfiguration: async () => configuration, release() {} }) } });
  tuners = new LiveTvTunerService({ plugins: { entries: () => [tuner] }, sources: { addProviderMetadata() {}, getPrograms() {} } });
  const [channel] = await tuners.getChannels({ enableCache: true });
  const item = { Type: 'LiveTvChannel', Id: '12345678-1234-1234-1234-567890abcdef', SourceType: 'LiveTV', ServiceName: 'Emby',
    ChannelType: 'TV', ExternalId: channel.Id };
  const library = { itemCreation: { getItemById: async () => item }, getLiveMediaSources: async () => [] };
  const getLocalApiUrl = () => 'http://127.0.0.1:1';
  mediaSources = new LiveTvMediaSources({ tuners, library, getLocalApiUrl });
  const [candidate] = await mediaSources.getMediaSources(item);
  assert.equal(candidate.Protocol, 'Udp');
  assert.equal(candidate.Path, location);
  liveStreams = new LiveStreamsService({ tuners, library, getLocalApiUrl, onError: error => errors.push(error),
    probe: { async addMediaInfo(source, options) {
      assert.equal(options.openRead, undefined);
      assert.equal(source.Id, candidate.Id);
      assert.equal(source.Path, candidate.Path);
      await probe.addMediaInfo(source, { ...options, addProbeDelay: false });
      probes.push(source.MediaStreams[0].Codec);
    } },
  });
  const media = await captureMediaProcess(encoderPath, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=10',
    '-c:v', 'mpeg2video', '-threads', '1', '-f', 'mpegts', 'pipe:1',
  ], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024 });
  assert.equal(media.exitCode, 0, media.stderr.toString());
  let offset = 0;
  pulse = setInterval(() => {
    for (let packet = 0; packet < 4; packet++) {
      const end = Math.min(offset + 1316, media.stdout.length);
      sender.send(media.stdout.subarray(offset, end), port, '127.0.0.1');
      offset = end === media.stdout.length ? 0 : end;
    }
  }, 10);
  const timer = { Id: 'udp-recording', ChannelId: channel.Id, Name: 'UDP DVR', StartDate: new Date().toISOString(),
    EndDate: new Date(Date.now() + 8000).toISOString(), PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
  const finished = Promise.withResolvers();
  dvr = new LiveTvDvr({ library, mediaSources, liveStreams, mediaEncoder, fileSystem: storage.fileSystem, dataPath: root,
    timers: { readRecordingTimers: async () => [timer], async updateRecordingTimer(_timer, change) {
      transitions.push(change);
      dvr.syncTimers(change ? [{ ...timer, ...change }] : []);
      return true;
    } },
    configuration: { getConfiguration: async () => configuration, release() {} },
    runBackground: operation => operation().finally(finished.resolve), onError: error => errors.push(error),
  });
  await dvr.start(); await finished.promise;
  assert.deepEqual(errors, []);
  assert.deepEqual(probes, ['mpeg2video']);
  assert.deepEqual(transitions.map(change => change.Status), ['InProgress', 'Completed']);
  assert.deepEqual(tuners.getLiveStreams(), []);
  const bytes = await readFile(transitions.at(-1).RecordingPath);
  assert.ok(bytes.length > 18800 && bytes.length % 188 === 0 && bytes[0] === 0x47);
  await assert.rejects(recordTransportStream(mediaEncoder, { Protocol: 'Http' }, location), { code: 'not-supported' });
  await assert.rejects(recordTransportStream(mediaEncoder, candidate, 'tcp://127.0.0.1:1'), { code: 'not-supported' });
});
