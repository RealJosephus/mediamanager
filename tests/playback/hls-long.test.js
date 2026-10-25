import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HlsService } from '../../src/playback/hls.js';
import { extractionFixture } from './extraction-fixture.js';
import media from './fixtures/hls-reference.json' with { type: 'json' };
import reference from './fixtures/hls-long-reference.json' with { type: 'json' };
import switches from './fixtures/hls-switch-reference.json' with { type: 'json' };

test('native long HLS segment cleanup, copy seek and regeneration through a slow VFS input', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-long-')), cache = path.join(directory, 'cache');
  let fixture, hls, server; const errors = [], processes = [];
  let encoding = { ...defaultConfiguration('encoding'), EnableSegmentDeletion: false, SegmentKeepSeconds: 20 };
  try {
    await writeFile(path.join(directory, 'source.mkv'), Buffer.from(media.media, 'base64'));
    const creation = spawnSync(validationExecutable('ffmpeg'), ['-v', 'error', '-y', '-stream_loop', '20', '-i', path.join(directory, 'source.mkv'), '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-t', '600', '-map_metadata', '-1', '-map_chapters', '-1', path.join(directory, 'long.mkv')], { windowsHide: true, encoding: 'utf8' });
    assert.equal(creation.status, 0, creation.stderr);
    fixture = await extractionFixture({ '/long.mkv': await readFile(path.join(directory, 'long.mkv')) }, { chunkBytes: 32768, chunkDelayMs: 50 });
    hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getCacheDirectory: async () => cache,
      getEncodingOptions: () => encoding, onError: error => errors.push(error), onProcess: value => processes.push(value) });
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost'), index = Number(url.pathname.slice(1)), controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
      request.once('aborted', abort); response.once('close', abort);
      try { await hls.segment(reference.source, '/long.mkv', { DeviceId: 'long-hls', PlaySessionId: 'long-session', VideoCodec: 'copy', AudioCodec: 'copy', SegmentContainer: url.searchParams.get('container') ?? 'ts', SegmentLength: 6, CurrentRuntimeTicks: BigInt(Math.max(index, 0)) * 60000000n, ActualSegmentLengthTicks: 60000000n }, index, request, response, { signal: controller.signal }); }
      catch (error) { errors.push(error); if (!response.headersSent) { response.statusCode = 503; response.end(); } else response.destroy(); }
      finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    const get = async (expected, agent, container = 'ts') => {
      const response = await fetch(origin + '/' + expected.index + '?container=' + container, { headers: agent ? { 'User-Agent': agent } : {} }), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, expected.status);
      assert.equal(Number(response.headers.get('content-length')), bytes.length);
      if (expected.index !== -1) {
        assert.equal(bytes.length, expected.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
      } else assert.equal(response.headers.get('content-type'), 'video/mp4');
      return bytes;
    };
    await get(reference.first); await get(reference.sought);
    const jobs = await readdir(cache); assert.equal(jobs.length, 1); const output = path.join(cache, jobs[0]);
    assert.ok((await readdir(output)).includes('segment0.ts'));
    encoding = { ...defaultConfiguration('encoding'), EnableSegmentDeletion: true, SegmentKeepSeconds: 20 };
    const deadline = Date.now() + 27000;
    while ((await readdir(output)).includes('segment0.ts') && Date.now() < deadline) await delay(100);
    assert.ok(!(await readdir(output)).includes('segment0.ts'), 'The native 20-second cleanup cycle deletes old downloaded segments.');
    assert.ok((await readdir(output)).some(file => /^segment3\d\.ts$/.test(file)), 'Current segments remain available.');
    await get(reference.back); assert.ok((await readdir(output)).includes('segment0.ts')); assert.equal(processes.length, 3);
    await get(switches.other, 'different-agent'); await get(switches.cached);
    assert.equal(processes.length, 4, 'Replacing a task leaves complete cached segments readable.');
    const init = await get(switches.init, undefined, 'mp4'), fragment = await get(switches.changed, undefined, 'mp4');
    // Init muxer tags can change with FFmpeg versions. Bind the actual HTTP
    // length and decode it with the byte-exact native fragment, then compare
    // the frozen native streams, timestamps and packet payload hashes.
    const joined = path.join(directory, 'delivered.mp4'); await writeFile(joined, Buffer.concat([init, fragment]));
    const probe = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', joined],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(probe.status, 0, probe.stderr);
    const parsed = JSON.parse(probe.stdout), native = media.records.find(record => record.name === 'mp4').segments[1];
    const projection = { streams: parsed.streams.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels']
      .filter(key => value[key] != null).map(key => [key, value[key]]))),
      packets: parsed.packets.map(value => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags']
        .filter(key => value[key] != null).map(key => [key, value[key]]))) };
    assert.equal(parsed.packets.length, native.packetCount);
    assert.equal(createHash('sha256').update(JSON.stringify(projection)).digest('hex'), native.packetHash);
    assert.equal(processes.length, 5, 'A different container starts immediately instead of waiting for the old process.');
    await hls.stop('long-hls', 'long-session'); assert.deepEqual(await readdir(cache), []); assert.deepEqual(errors, []);
  } finally {
    await hls?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await fixture?.close();
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});
