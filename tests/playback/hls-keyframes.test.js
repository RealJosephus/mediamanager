import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaybackService } from '../../src/playback/service.js';
import { computeKeyframeSegments, formatHlsDurationTicks, hlsDurationUrlTicks, HlsService, hlsPlan, mainPlaylist, storedKeyframeData } from '../../src/playback/hls.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPlaybackState } from './runtime-state.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };
import reference from './fixtures/hls-reference.json' with { type: 'json' };
import oracle from './fixtures/hls-keyframe-oracle.json' with { type: 'json' };
import durationFormatOracle from './fixtures/hls-duration-format-oracle.json' with { type: 'json' };
import urlTicksOracle from './fixtures/hls-url-ticks-oracle.json' with { type: 'json' };

const itemId = '22222222-2222-2222-2222-222222222222';
const sourceId = itemId.replaceAll('-', '');
const options = { MediaSourceId: sourceId, VideoCodec: 'copy', AudioCodec: 'copy', SegmentContainer: 'ts', SegmentLength: 6 };

async function seed(database) {
  for (const [table, rows] of Object.entries(reference.tables)) {
    const columns = tableDefinition(table).columns, pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
        value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  await database.insert('KeyframeData', { ItemId: itemId, TotalDuration: 350000000n, KeyframeTicks: '[0,104270000,208540000,312400000]' });
}

test('keyframe segment calculation matches the frozen Jellyfin oracle without Int64 precision loss', () => {
  for (const entry of oracle) {
    const actual = computeKeyframeSegments({ TotalDuration: BigInt(entry.totalDuration), KeyframeTicks: entry.keyframeTicks.map(BigInt) }, entry.desiredSegmentLengthMs);
    assert.deepEqual(actual.map(String), entry.segments, entry.name);
  }
  assert.deepEqual(storedKeyframeData({ TotalDuration: 350000000n, KeyframeTicks: '[0,104270000, 208540000,312400000]' }), {
    TotalDuration: 350000000n, KeyframeTicks: [0n, 104270000n, 208540000n, 312400000n] });
  assert.deepEqual(storedKeyframeData({ TotalDuration: 1n, KeyframeTicks: null }), { TotalDuration: 1n, KeyframeTicks: [] });
  for (const value of ['[01]', '[1.0]', '[1e3]', '["1"]', '[9223372036854775808]', 'null']) assert.throws(() => storedKeyframeData({ TotalDuration: 1n, KeyframeTicks: value }));
});

test('HLS duration formatting matches frozen .NET custom numeric formatting', () => {
  for (const entry of durationFormatOracle) {
    assert.equal(formatHlsDurationTicks(BigInt(entry.ticks)), entry.formatted, entry.ticks);
    if (entry.urlTicks === 'overflow') assert.throws(() => hlsDurationUrlTicks(BigInt(entry.ticks)), RangeError, entry.ticks);
    else assert.equal(hlsDurationUrlTicks(BigInt(entry.ticks)), BigInt(entry.urlTicks), entry.ticks);
  }
  const keyframes = { TotalDuration: 120000005n, KeyframeTicks: [0n, 60000005n] };
  assert.match(mainPlaylist(reference.source, { ...options, KeyframeData: keyframes }), /#EXTINF:6\.000001, nodesc/);
  const largeKeyframes = { TotalDuration: BigInt(urlTicksOracle.totalDuration),
    KeyframeTicks: urlTicksOracle.keyframeTicks.map(BigInt) };
  const largeOptions = { ...options, SegmentLength: 86400, KeyframeData: largeKeyframes };
  const large = mainPlaylist(reference.source, largeOptions,
    `MediaSourceId=${sourceId}&SegmentContainer=ts`);
  assert.equal(large, urlTicksOracle.playlist);
  assert.deepEqual(hlsPlan(reference.source, largeOptions).keyframeStarts,
    urlTicksOracle.runtimeTicks.map(BigInt));
});

test('the VOD playlist uses native keyframe boundaries and preserves one canonical cache timeline', () => {
  const keyframes = { TotalDuration: 350000000n, KeyframeTicks: [0n, 104270000n, 208540000n, 312400000n] };
  const query = 'MediaSourceId=' + sourceId + '&SegmentContainer=ts';
  const text = mainPlaylist(reference.source, { ...options, KeyframeData: keyframes }, query);
  assert.equal(text, '#EXTM3U\r\n#EXT-X-PLAYLIST-TYPE:VOD\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:11\r\n#EXT-X-MEDIA-SEQUENCE:0\r\n' +
    '#EXTINF:10.427000, nodesc\r\nhls1/main/0.ts?' + query + '&runtimeTicks=0&actualSegmentLengthTicks=104270000\r\n' +
    '#EXTINF:10.427000, nodesc\r\nhls1/main/1.ts?' + query + '&runtimeTicks=104270000&actualSegmentLengthTicks=104270000\r\n' +
    '#EXTINF:10.386000, nodesc\r\nhls1/main/2.ts?' + query + '&runtimeTicks=208540000&actualSegmentLengthTicks=103860000\r\n' +
    '#EXTINF:3.760000, nodesc\r\nhls1/main/3.ts?' + query + '&runtimeTicks=312400000&actualSegmentLengthTicks=37600000\r\n#EXT-X-ENDLIST\r\n');
  const plan = hlsPlan(reference.source, { ...options, KeyframeData: keyframes });
  assert.deepEqual(plan.keyframeStarts, [0n, 104270000n, 208540000n, 312400000n]);
  const emptyStored = mainPlaylist(reference.source, { ...options, KeyframeData: { TotalDuration: 0n, KeyframeTicks: [] } }, query);
  assert.match(emptyStored, /#EXT-X-TARGETDURATION:6\r\n/);
  assert.equal((emptyStored.match(/#EXTINF:/g) ?? []).length, 6, 'An invalid empty stored timeline falls back to the source runtime.');
});

test('PlaybackService reads native KeyframeData only for configured metadata extraction extensions', async t => {
  const queries = [];
  const row = { ItemId: itemId, TotalDuration: 350000000n, KeyframeTicks: '[0,104270000,208540000,312400000]' };
  const source = structuredClone(reference.source);
  const library = {
    store: { run: operation => operation({ rows: async (table, request) => { queries.push([table, request]); return [row]; } }) },
    getItemRecord: async () => ({ Id: itemId, MediaType: 'Video' }),
    getMediaSources: async () => [source]
  };
  const hls = { getEncodingOptions: () => ({ AllowOnDemandMetadataBasedKeyframeExtractionForExtensions: ['..MKV'] }), initialize: async () => true };
  const playback = new PlaybackService({ library, hls, getEncodingOptions: () => defaultConfiguration('encoding') });
  const result = await playback.hlsStream(itemId, 'main', { ...options, QueryString: 'MediaSourceId=' + sourceId + '&SegmentContainer=ts' });
  const server = http.createServer((request, response) => result.send(request, response));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/main.m3u8`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /#EXTINF:10\.427000[\s\S]+runtimeTicks=104270000&actualSegmentLengthTicks=104270000/);
  assert.deepEqual(queries, [['KeyframeData', { where: { ItemId: itemId }, limit: 1 }]]);

  source.Path = 'Z:\\Hls\\source.mp4'; queries.length = 0;
  const fallback = await playback.hlsStream(itemId, 'main', { ...options, QueryString: 'MediaSourceId=' + sourceId + '&SegmentContainer=ts' });
  const fallbackServer = http.createServer((request, response) => fallback.send(request, response));
  fallbackServer.listen(0, '127.0.0.1'); await once(fallbackServer, 'listening');
  t.after(() => new Promise(resolve => fallbackServer.close(resolve)));
  const fallbackText = await (await fetch(`http://127.0.0.1:${fallbackServer.address().port}/main.m3u8`)).text();
  assert.match(fallbackText, /#EXTINF:6\.000000/);
  assert.deepEqual(queries, []);
});

test('keyframe playlist segments share one canonical packet-copy cache timeline', async t => {
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-keyframe-hls-')), processes = [];
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getCacheDirectory: async () => directory, getEncodingOptions: () => defaultConfiguration('encoding'), onProcess: value => processes.push(value.args) });
  const timelines = [
    { TotalDuration: 350000000n, KeyframeTicks: [0n, 104270000n, 208540000n, 312400000n] },
    { TotalDuration: 350000000n, KeyframeTicks: [0n, 120000000n, 240000000n] }
  ];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), index = Number(url.pathname.slice(1)), changed = url.searchParams.has('changed');
    const plan = computeKeyframeSegments(timelines[changed ? 1 : 0], 6000);
    const runtimeTicks = plan.slice(0, index).reduce((sum, value) => sum + value, 0n);
    try {
      await hls.segment(reference.source, '/source.mkv', { ...options, DeviceId: 'keyframes', PlaySessionId: 'keyframes-session', KeyframeData: timelines[changed ? 1 : 0],
        CurrentRuntimeTicks: runtimeTicks, ActualSegmentLengthTicks: plan[index] }, index, request, response);
    } catch (error) { if (!response.headersSent) { response.statusCode = 503; response.end(error.message); } else response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const index of [0, 1]) { const response = await fetch(origin + '/' + index); assert.equal(response.status, 200); await response.arrayBuffer(); }
    assert.equal(processes.length, 1, 'Adjacent keyframe URLs retain the same timeline identity.');
    const changed = await fetch(origin + '/0?changed=1'); assert.equal(changed.status, 200); await changed.arrayBuffer();
    assert.equal(processes.length, 2, 'Changed persisted keyframe metadata cannot reuse an earlier segment mapping.');
    for (const args of processes) { assert.equal(args[args.indexOf('-codec:v:0') + 1], 'copy'); assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy'); }
  } finally {
    await hls.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});

test('stored keyframes drive the real HLS HTTP result on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const schema = `hls_keyframes_${randomBytes(8).toString('hex')}`;
  let database, runtime, fixture;
  const state = await createPlaybackState();
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') });
    fixture.identityMap = new IdentityAccessMap();
    fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture.' });
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: libraryFixture.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap });
    const result = await runtime.playback.hlsStream(itemId, 'main', { ...options, QueryString: 'MediaSourceId=' + sourceId + '&SegmentContainer=ts' });
    const server = http.createServer((request, response) => result.send(request, response));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/main.m3u8`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /#EXT-X-TARGETDURATION:11/);
    assert.match(text, /#EXTINF:10\.427000[\s\S]+runtimeTicks=104270000&actualSegmentLengthTicks=104270000/);
    assert.equal(fixture.requests.length, 0, 'A main playlist reads stored metadata without opening the media object.');
  } finally {
    await runtime?.close(); await fixture?.close();
    const cleanup = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}", "${schema}__mm" CASCADE`); }
    finally { try { await cleanup.close(); } finally { await state.close(); } }
  }
});
