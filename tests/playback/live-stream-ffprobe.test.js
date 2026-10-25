import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LiveStreamProbe } from '../../src/playback/live-stream-probe.js';
import { readLiveMediaInfoCache } from '../../src/playback/live-stream-info.js';
import { probeLiveRaw } from '../../src/storage/ffprobe.js';
import { NativeHttpInput } from '../../packages/plugin-sdk/live-tv/raw-input.js';
import { md5Guid } from '../../src/core/identity.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function wave() {
  const samples = 8000, result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) result.writeInt16LE((index * 37 % 2000) - 1000, 44 + index * 2);
  return result;
}
const source = (url, changes = {}) => ({ Id: 'original-wave', Path: url, Protocol: 'Http', SupportsProbing: true,
  IsInfiniteStream: true, RunTimeTicks: null, AnalyzeDurationMs: 0, RequiredHttpHeaders: { 'X-Original-Input': 'controlled' },
  MediaStreams: [{ Type: 'Video', Index: -1 }, { Type: 'Audio', Index: -1 }], ...changes });

test('real ffprobe consumes retained original HTTP bytes through the private bridge, writes typed cache and releases every reader', { timeout: 60000 }, async t => {
  const root = path.join(validationOutputRoot(), 'live-original-ffprobe-' + randomUUID()); await mkdir(root);
  const original = wave(), requests = [], calls = [], errors = [], readers = [], cacheKey = 'original retained wave';
  let input, owner, probe, server, publicUrl, failure;
  const started = performance.now();
  try {
    server = createServer((request, response) => {
      requests.push({ method: request.method, route: request.url, inputHeader: request.headers['x-original-input'] });
      if (request.headers['x-original-input'] !== 'controlled') { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', 'audio/wav'); response.setHeader('Content-Length', original.length); response.end(original);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port + '/original.wav';
    let upstreamClosed = 0;
    input = new NativeHttpInput(signal => fetch(url, { signal, headers: { 'X-Original-Input': 'controlled' } }), () => { upstreamClosed++; }, { primeFirstBytes: true });
    owner = await input.acquire(new AbortController().signal);
    probe = new LiveStreamProbe({ cachePath: root, mediaEncoder: await createTestMediaEncoder(t), probeOptions: { timeoutMs: 15000 }, onError: error => errors.push(error),
      probe: async (target, options) => {
        publicUrl = target;
        const result = await probeLiveRaw(target, options); calls.push({ elapsedMs: performance.now() - started, target, result }); return result;
      } });
    const openRead = async ({ signal }) => {
      const lease = await input.acquire(signal), record = { closes: 0 }; readers.push(record); let closing;
      return { stream: lease.stream, close: () => closing ??= (async () => { record.closes++; await lease.close(); })() };
    };
    const item = source(url); await probe.addMediaInfo(item, { cacheKey, openRead });
    assert.equal(calls.length, 1); assert.ok(calls[0].elapsedMs >= 2990); assert.equal(calls[0].result.exitCode, 0);
    assert.equal(calls[0].result.raw.streams[0].codec_name, 'pcm_s16le'); assert.equal(calls[0].result.raw.format.format_name, 'wav');
    assert.match(publicUrl, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/u);
    assert.equal((await fetch(publicUrl)).status, 404, 'The private probe URL is revoked when ffprobe returns.');
    assert.ok(readers.length > 0); assert.ok(readers.every(reader => reader.closes === 1));
    assert.equal(upstreamClosed, 0, 'Private reader completion cannot close the still-owned public reservation.');
    assert.equal(item.MediaStreams.length, 1); assert.equal(item.MediaStreams[0].Type, 'Audio'); assert.equal(item.MediaStreams[0].Index, -1);
    assert.equal(item.MediaStreams[0].Language, null); assert.equal(item.RunTimeTicks, null); assert.equal(item.AnalyzeDurationMs, 3000);
    const filename = path.join(root, 'mediainfo', md5Guid(cacheKey) + '.json'), before = await readFile(filename), typed = readLiveMediaInfoCache(before);
    assert.equal(typed.MediaStreams[0].Index, 0); assert.equal(typed.MediaStreams[0].Codec, 'pcm_s16le');
    assert.deepEqual([typed.MediaStreams[0].LocalizedDefault, typed.MediaStreams[0].LocalizedExternal, typed.MediaStreams[0].LocalizedOriginal], ['Default', 'External', 'Original']);
    assert.equal(typed.VideoType, undefined, 'An unspecified nullable native VideoType cannot become VideoFile.');
    const hit = source(url); await probe.addMediaInfo(hit, { cacheKey, openRead: () => { throw new Error('A typed cache hit cannot open a byte reader.'); } });
    assert.equal(calls.length, 1); assert.deepEqual(await readFile(filename), before);
    // Native DTO serialization omits nullable properties. Compare every model
    // value at that consumer boundary, retaining the separate exact cache bytes.
    assert.deepEqual(parseLosslessJson(stringifyNativeJson(hit)), parseLosslessJson(stringifyNativeJson(item)));
    assert.deepEqual(await readdir(root), ['mediainfo']); assert.deepEqual(requests, [{ method: 'GET', route: '/original.wav', inputHeader: 'controlled' }]);
    await owner.close(); await input.close(); assert.equal(upstreamClosed, 1); assert.deepEqual(errors, []);
    await writeFile(path.join(root, 'receipt.json'), stringifyNativeJson({ passed: true, input: { length: original.length, sha256: sha(original), preparation: 'handwritten PCM WAV, no encoder process' },
      calls, requests, readers, cacheSha256: sha(before), source: item, upstreamClosed, actualFfprobeExecuted: true,
      actualNativeEncoderExecuted: false, publicHttpRoutesCompared: false, recordingOrTranscodingStarted: false, phaseAcceptance: false, releaseAcceptance: false }) + '\n');
  } catch (error) { failure = error; }
  finally {
    for (const resource of [probe, owner, input]) try { await resource?.close(); } catch (error) { failure ??= error; }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (failure) await writeFile(path.join(root, 'failure.json'), stringifyNativeJson({ error: failure.stack, requests, calls, readers, publicUrl, errors: errors.map(error => error.stack) }) + '\n');
  }
  if (failure) throw failure;
});

test('real original URL ffprobe forwards required HTTP headers and cancellation closes the process and upstream request', { timeout: 30000 }, async () => {
  const entered = Promise.withResolvers(), disconnected = Promise.withResolvers(), requests = [], controller = new AbortController();
  const bytes = wave(); let server;
  try {
    server = createServer((request, response) => {
      requests.push({ route: request.url, key: request.headers['x-original-input'] });
      if (request.headers['x-original-input'] !== 'controlled') { response.writeHead(403); response.end(); return; }
      if (request.url === '/held.wav') { response.once('close', () => disconnected.resolve()); entered.resolve(); return; }
      response.setHeader('Content-Type', 'audio/wav'); response.setHeader('Content-Length', bytes.length); response.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
    const options = { executable: validationExecutable('ffprobe'), timeoutMs: 10000, requiredHttpHeaders: { 'X-Original-Input': 'controlled' } };
    const result = await probeLiveRaw(origin + '/original.wav', options); assert.equal(result.exitCode, 0); assert.equal(result.raw.streams[0].codec_name, 'pcm_s16le');
    const pending = probeLiveRaw(origin + '/held.wav', { ...options, signal: controller.signal }); const rejected = assert.rejects(pending, { code: 'cancelled' });
    await Promise.race([entered.promise, pending.then(() => { throw new Error('The held original input unexpectedly completed probing.'); })]);
    controller.abort(); await rejected; await disconnected.promise;
    assert.deepEqual(requests, [{ route: '/original.wav', key: 'controlled' }, { route: '/held.wav', key: 'controlled' }]);
  } finally { controller.abort(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});
