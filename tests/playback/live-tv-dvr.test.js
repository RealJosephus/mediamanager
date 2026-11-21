import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
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
