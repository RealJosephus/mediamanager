import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { HlsService } from '../../src/playback/hls.js';
import { RemuxService } from '../../src/playback/remux.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';

const timeoutMs = 2500;
const source = { Protocol: 'Http', Path: '/owned.ts', LiveStreamId: 'owned', IsInfiniteStream: true, Container: 'ts',
  AnalyzeDurationMs: 100, MediaStreams: [{ Type: 'Video', Index: 0, Codec: 'h264', IsAVC: true, NalLengthSize: '0', Width: 160, Height: 96 }] };
const playback = { LiveInput: true, Container: 'ts', SegmentLength: 1, MinSegments: 1, VideoCodec: 'h264' };
const segmentUris = manifest => manifest.split(/\r?\n/u).filter(line => line.endsWith('.ts'));

function liveInput(bytes) {
  const input = { stalled: false, opened: 0, closed: 0 };
  input.openRead = async ({ signal }) => {
    input.opened++;
    return { close: () => { input.closed++; }, stream: (async function* () {
      const initial = 188 * 550, chunk = 188 * 32;
      yield bytes.subarray(0, initial);
      for (let offset = initial; offset < bytes.length; offset += chunk) {
        await delay(75, undefined, { signal });
        if (input.stalled) { await once(signal, 'abort'); return; }
        yield bytes.subarray(offset, offset + chunk);
      }
    })() };
  };
  return input;
}

async function eventually(t, condition) {
  for (const end = performance.now() + 10000; performance.now() < end;) {
    if (await condition()) return;
    await delay(40, undefined, { signal: t.signal });
  }
  assert.fail('Timed out waiting for the live transcode condition.');
}

async function serve(t, handler, errors) {
  const server = http.createServer((request, response) => {
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    void handler(request, response, controller.signal).catch(error => {
      errors.push(error);
      if (response.headersSent) response.destroy();
      else response.writeHead(error?.code === 'timeout' ? 504 : 503).end(String(error));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (route = '/', signal = t.signal) => fetch(origin + route, { signal });
}

test('live transcodes keep producing past the execution deadline and release stalled inputs', { timeout: 40000 }, async t => {
  const encoding = defaultConfiguration('encoding');
  const mediaEncoder = await createTestMediaEncoder(t, { configuration: encoding });
  const result = await captureMediaProcess(validationExecutable('ffmpeg'), [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=20:duration=120', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-threads', '1', '-g', '10', '-sc_threshold', '0', '-muxdelay', '0', '-f', 'mpegts', 'pipe:1',
  ], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 16 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.ok(result.stdout.length > 1024 * 1024);

  await t.test('HLS keeps adding playable segments and reaps a stalled job despite pings', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-live-hls-timeout-'));
    const input = liveInput(result.stdout), errors = [], stopped = [], launches = [];
    const hls = new HlsService({ vfs: {}, mediaEncoder, getCacheDirectory: () => directory,
      getEncodingOptions: () => encoding, timeoutMs, idleTimeoutMs: 1200, onError: error => errors.push(error),
      onProcess: () => launches.push(performance.now()), onEventStop: (id, session) => stopped.push([id, session]) });
    t.after(async () => { await hls.close(); await rm(directory, { recursive: true, force: true }); });
    const read = await serve(t, async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const segment = /^\/hls\/([a-f0-9]{32})\/([^/]+)$/u.exec(url.pathname);
      if (segment) {
        const artifact = hls.eventArtifact(segment[1], segment[2]);
        if (artifact) await artifact.send(request, response);
        else response.writeHead(404).end();
        return;
      }
      const session = url.searchParams.get('session') ?? 'live';
      await hls.eventPlaylist(source, undefined, { ...playback, PlaySessionId: session }, request, response, { openRead: input.openRead });
    }, errors);
    const playlist = async (route) => {
      const response = await read(route), manifest = await response.text();
      assert.equal(response.status, 200, manifest);
      assert.match(manifest, /#EXT-X-PLAYLIST-TYPE:EVENT/u);
      assert.doesNotMatch(manifest, /#EXT-X-ENDLIST/u);
      return segmentUris(manifest);
    };
    let pings = 0;
    const keepAlive = setInterval(() => { pings++; hls.ping('live', false); }, 100);
    try {
      const first = await playlist();
      assert.ok(first.length > 0);
      await delay(timeoutMs + 300, undefined, { signal: t.signal });
      assert.ok(pings >= 24);
      assert.equal(hls.hasJob('live'), true);
      const later = await playlist();
      assert.ok(later.length > first.length);
      const segment = await read('/' + later.at(-1)), bytes = Buffer.from(await segment.arrayBuffer());
      assert.equal(segment.status, 200);
      assert.ok(bytes.length > 188 && bytes[0] === 0x47);
      assert.equal(launches.length, 1);
      input.stalled = true;
      await eventually(t, async () => stopped.length === 1 && (await readdir(directory)).length === 0);
      assert.equal(hls.hasJob('live'), false);
      assert.equal(input.closed, 1);
      assert.equal((await read('/' + later.at(-1))).status, 404);
    } finally { clearInterval(keepAlive); }

    input.stalled = false;
    await playlist('/?session=idle');
    await eventually(t, async () => stopped.length === 2 && (await readdir(directory)).length === 0);
    assert.deepEqual(stopped, [['owned', 'live'], ['owned', 'idle']]);
    assert.equal(input.closed, 2);
    assert.deepEqual(errors, []);
  });

  await t.test('progressive remux keeps sending bytes, then handles a stall, cancellation and close', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-live-remux-timeout-'));
    const input = liveInput(result.stdout), errors = [], launches = [];
    const remux = new RemuxService({ vfs: {}, mediaEncoder, getCacheDirectory: () => directory,
      timeoutMs, onError: error => errors.push(error), onProcess: () => launches.push(performance.now()) });
    t.after(async () => { await remux.close(); await rm(directory, { recursive: true, force: true }); });
    const read = await serve(t, (request, response, signal) => remux.stream(source, undefined,
      { ...playback, PlaySessionId: 'live' }, request, response, { signal, openRead: input.openRead }), errors);
    const openBody = async signal => {
      const response = await read('/', signal);
      assert.equal(response.status, 200);
      return response.body.getReader();
    };
    const next = async reader => {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      return value.byteLength;
    };
    const reader = await openBody();
    assert.ok(await next(reader) > 0);
    while (performance.now() < launches[0] + timeoutMs + 250) assert.ok(await next(reader) > 0);
    assert.equal(remux.jobs.hasJob('live'), true);
    assert.ok(await next(reader) > 0);
    assert.equal(launches.length, 1);
    input.stalled = true;
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* Drain output before the stall. */ } });
    await eventually(t, async () => input.closed === 1 && (await readdir(directory)).length === 0);
    assert.equal(remux.jobs.hasJob('live'), false);
    assert.deepEqual(errors.map(error => error.code), ['timeout']);

    input.stalled = false;
    const controller = new AbortController();
    const cancelled = await openBody(AbortSignal.any([t.signal, controller.signal]));
    assert.ok(await next(cancelled) > 0);
    controller.abort();
    await eventually(t, async () => input.closed === 2 && (await readdir(directory)).length === 0);
    const closing = await openBody();
    assert.ok(await next(closing) > 0);
    await remux.close();
    assert.equal(input.closed, 3);
    assert.deepEqual(await readdir(directory), []);
  });
});
