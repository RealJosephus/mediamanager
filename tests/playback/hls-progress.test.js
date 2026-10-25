import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HlsService, createHlsProgressParser, hlsArguments, hlsPlan, parseHlsProgressLine } from '../../src/playback/hls.js';
import { extractionFixture } from './extraction-fixture.js';
import media from './fixtures/hls-reference.json' with { type: 'json' };
import oracle from './fixtures/hls-progress-oracle.json' with { type: 'json' };

async function eventually(condition, message) {
  for (let index = 0; index < 500; index++) { if (await condition()) return; await delay(10); }
  assert.fail(message);
}

const normalized = value => value && Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry === undefined ? null : typeof entry === 'bigint' ? Number(entry) : entry]));

test('HLS ffmpeg status parsing matches the frozen JobLogger oracle', () => {
  for (const entry of oracle) {
    const actual = parseHlsProgressLine(entry.Line, entry.RuntimeTicks == null ? null : BigInt(entry.RuntimeTicks), BigInt(entry.StartTimeTicks));
    const expected = entry.Reports[0] && { ...entry.Reports[0], ...(entry.Reports[0].Framerate == null ? {} : { Framerate: Math.fround(entry.Reports[0].Framerate) }) };
    assert.deepEqual(normalized(actual), expected, entry.Name);
  }
  const args = hlsArguments('http://127.0.0.1:1/' + 'a'.repeat(64), hlsPlan(media.source, { SegmentContainer: 'ts' }), tmpdir(), 0, 0n, { threads: 0, version: '8.0', maxMuxingQueueSize: 2048 });
  assert.deepEqual(args.slice(0, 8), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '0.5', '-protocol_whitelist']);
  assert.equal(args.includes('-progress'), false, 'The higher precision progress protocol does not match JobLogger display parsing.');
  const reports = [], parser = createHlsProgressParser(100000000n, 20000000n, value => reports.push(value));
  parser.write('frame=30 fps=12.34 size=123kB time=00:00:'); assert.deepEqual(reports, []);
  parser.write('01.500000 bitrate=671.7kbits/s\r'); parser.write('\nframe=31 fps=13.5 size=N/A time=00:00:02.'); parser.end('000000 bitrate=N/A');
  assert.deepEqual(reports.map(normalized), [
    { TranscodingPositionTicks: 35000000, Framerate: Math.fround(12.34), CompletionPercentage: 35, BytesTranscoded: 125952, Bitrate: 687821 },
    { TranscodingPositionTicks: 40000000, Framerate: Math.fround(13.5), CompletionPercentage: 40, BytesTranscoded: null, Bitrate: null }
  ]);
});

async function progressHarness(t, chunkDelayMs) {
  const bytes = Buffer.from(media.media, 'base64');
  const fixture = await extractionFixture({ '/source.mkv': bytes }, { chunkBytes: 16384, chunkDelayMs });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-progress-')), events = [], errors = [];
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getCacheDirectory: async () => directory, getEncodingOptions: () => defaultConfiguration('encoding'), onProgress: event => events.push(event), onError: error => errors.push(error) });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), container = url.searchParams.get('container') ?? 'ts', session = url.searchParams.get('session') ?? 'progress-session';
    const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try {
      await hls.segment(media.source, '/source.mkv', { DeviceId: 'progress-device', PlaySessionId: session, VideoCodec: 'copy', AudioCodec: 'copy', SegmentContainer: container, SegmentLength: 6, CurrentRuntimeTicks: 0n, ActualSegmentLengthTicks: 60000000n }, 0, request, response, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) errors.push(error);
      if (!response.headersSent) { response.statusCode = 503; response.end(); } else response.destroy();
    } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { fixture, directory, events, errors, hls, server, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { await hls.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close(); assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); } };
}

test('real slow packet-copy HLS publishes running stats and resets them on completion', async t => {
  const harness = await progressHarness(t, 30);
  try {
    const responsePromise = fetch(harness.origin).then(async response => { const bytes = await response.arrayBuffer(); return { status: response.status, size: bytes.byteLength }; });
    await eventually(() => harness.events.some(event => event.phase === 'progress' && event.CompletionPercentage > 0), 'ffmpeg did not publish a running status line.');
    const event = harness.events.findLast(value => value.phase === 'progress' && value.CompletionPercentage > 0);
    assert.equal(event.BytesTranscoded, undefined); assert.equal(event.Bitrate, undefined, 'Native HLS reports N/A for output bytes and bitrate.');
    assert.ok(event.TranscodingPositionTicks > 0n); assert.ok(event.Framerate >= 0);
    const running = harness.hls.getTranscodingInfo('PROGRESS-DEVICE');
    assert.equal(running.Framerate, event.Framerate); assert.equal(running.CompletionPercentage, event.CompletionPercentage);
    assert.ok(running.Bitrate > 0, 'N/A progress bitrate falls back to the planned output bitrate.');
    const response = await responsePromise; assert.equal(response.status, 200); assert.ok(response.size > 0);
    await eventually(() => harness.events.some(value => value.phase === 'exit'), 'ffmpeg did not reach its exit transition.');
    const completed = harness.hls.getTranscodingInfo('progress-device');
    assert.equal(Object.hasOwn(completed, 'Framerate'), false); assert.equal(Object.hasOwn(completed, 'CompletionPercentage'), false);
    assert.equal(harness.hls.hasJob('progress-session'), true, 'A completed native job remains active until stop or replacement.');
    await harness.hls.stop('wrong-device', 'PROGRESS-SESSION'); assert.equal(harness.hls.getTranscodingInfo('progress-device'), undefined);
    assert.deepEqual(harness.errors, []);
  } finally { await harness.close(); }
});

test('running HLS replacement selects the newest job and cancellation clears activity', async t => {
  const harness = await progressHarness(t, 100);
  try {
    const first = fetch(harness.origin + '/?container=ts&session=replace-session').then(async response => { await response.arrayBuffer(); return response.status; }).catch(() => 0);
    await eventually(() => harness.events.some(event => event.phase === 'progress' && event.sequence === 1), 'The first ffmpeg job did not start reporting.');
    const second = fetch(harness.origin + '/?container=mp4&session=replace-session').then(async response => { await response.arrayBuffer(); return response.status; }).catch(() => 0);
    await eventually(() => harness.events.some(event => event.phase === 'start' && event.sequence === 2), 'The replacement ffmpeg job did not start.');
    assert.equal(harness.hls.getTranscodingInfo('progress-device').Container, 'mp4');
    await eventually(() => harness.events.some(event => event.phase === 'progress' && event.sequence === 2), 'The replacement ffmpeg job did not report progress.');
    await harness.hls.stop('unrelated-device', 'REPLACE-SESSION');
    assert.equal(harness.hls.getTranscodingInfo('progress-device'), undefined); assert.equal(harness.hls.hasJob('replace-session'), false);
    assert.ok([0, 200, 503].includes(await first)); assert.ok([0, 200, 503].includes(await second));
    assert.ok(harness.events.some(event => event.phase === 'exit' && event.sequence === 1)); assert.ok(harness.events.some(event => event.phase === 'exit' && event.sequence === 2));
    await eventually(async () => (await readdir(harness.directory)).length === 0, 'Cancelled HLS cache was not removed.');
    assert.equal(harness.errors.every(error => ['cancelled', 'not-found', 'ABORT_ERR'].includes(error.code)), true, harness.errors.map(error => `${error.code}:${error.message}`).join('\n'));
  } finally { await harness.close(); }
});
