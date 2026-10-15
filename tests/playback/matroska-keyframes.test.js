import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { PlaybackService } from '../../src/playback/service.js';
import { extractMatroskaKeyframes, MatroskaKeyframeService } from '../../src/playback/matroska-keyframes.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import reference from './fixtures/hls-reference.json' with { type: 'json' };

const itemId = '22222222-2222-2222-2222-222222222222';
const sourceId = itemId.replaceAll('-', '');
const hlsOptions = { MediaSourceId: sourceId, VideoCodec: 'copy', AudioCodec: 'copy', SegmentContainer: 'ts', SegmentLength: 6,
  QueryString: `MediaSourceId=${sourceId}&SegmentContainer=ts` };

function id(value) { return Buffer.from(value, 'hex'); }

function sizeVint(value, width) {
  value = BigInt(value);
  width ??= Array.from({ length: 8 }, (_, index) => index + 1).find(length => value < (1n << BigInt(7 * length)) - 1n);
  if (!width || value >= (1n << BigInt(7 * width)) - 1n) throw new Error('Test EBML size is too large.');
  const bytes = Buffer.alloc(width);
  let encoded = value | 1n << BigInt(7 * width);
  for (let index = width - 1; index >= 0; index--) { bytes[index] = Number(encoded & 0xffn); encoded >>= 8n; }
  return bytes;
}

function uint(value, width) {
  value = BigInt(value);
  width ??= Math.max(1, Math.ceil(value.toString(2).length / 8));
  const bytes = Buffer.alloc(width);
  for (let index = width - 1; index >= 0; index--) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
  return bytes;
}

function element(identifier, payload, { unknown = false } = {}) {
  payload = Buffer.from(payload);
  return Buffer.concat([id(identifier), unknown ? Buffer.from([0xff]) : sizeVint(payload.length), payload]);
}

function float64(value) { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return bytes; }

function seekEntry(identifier, position) {
  return element('4dbb', Buffer.concat([element('53ab', id(identifier)), element('53ac', uint(position, 8))]));
}

function cue(time, track, clusterPosition, includeClusterPosition = true, duplicateFields = false, reverseCueFields = false) {
  const trackPosition = element('b7', Buffer.concat([...(track == null ? [] : [element('f7', uint(track))]),
    ...(duplicateFields && track != null ? [element('f7', uint(99))] : []), ...(includeClusterPosition ? [element('f1', uint(clusterPosition, 8))] : [])]));
  const timeElement = element('b3', uint(time));
  return element('bb', Buffer.concat(reverseCueFields ? [trackPosition, timeElement]
    : [timeElement, ...(duplicateFields ? [element('b3', uint(999999))] : []), trackPosition]));
}

function matroska({ seekPrefix = false, noSeekHead = false, omitCuesSeek = false, noVideoCues = false,
  emptyCues = false, unknownSegment = false, unknownCues = false, omitClusterPositions = false, outOfOrder = false,
  duplicateFields = false, reverseInfoFields = false, reverseTrackFields = false, reverseCueFields = false,
  omitCueTrack = false, duration = 35000, timestampScale = 1000000, cueTimes } = {}) {
  const timestampElement = element('2ad7b1', uint(timestampScale));
  const durationElement = element('4489', float64(duration));
  const info = element('1549a966', Buffer.concat(reverseInfoFields ? [durationElement, timestampElement] : [timestampElement,
    ...(duplicateFields ? [element('2ad7b1', uint(BigInt(timestampScale) + 1n))] : []), durationElement,
    ...(duplicateFields ? [element('4489', float64(duration + 1))] : [])]));
  const videoFields = reverseTrackFields ? [element('83', uint(1)), element('d7', uint(2))]
    : [element('d7', uint(2)), ...(duplicateFields ? [element('d7', uint(99))] : []), element('83', uint(1)),
      ...(duplicateFields ? [element('83', uint(2))] : [])];
  const tracks = element('1654ae6b', Buffer.concat([
    element('ae', Buffer.concat([element('d7', uint(1)), element('83', uint(2))])),
    element('ae', Buffer.concat(videoFields))
  ]));
  const prefix = seekPrefix ? element('ec', Buffer.alloc(31, 0)) : Buffer.alloc(0);
  const placeholder = Buffer.concat([seekEntry('1549a966', 0), seekEntry('1654ae6b', 0), ...(omitCuesSeek ? [] : [seekEntry('1c53bb6b', 0)])]);
  const placeholderHead = noSeekHead ? Buffer.alloc(0) : element('114d9b74', placeholder);
  const firstClusterPosition = BigInt(prefix.length + placeholderHead.length + info.length + tracks.length);
  const clusterA = element('1f43b675', Buffer.from([0]));
  const clusterB = element('1f43b675', Buffer.from([1]));
  const cueRows = cueTimes?.map(time => [time, 2]) ?? (outOfOrder ? [[0, 2], [10427, 2], [7000, 2], [20854, 2], [31240, 2]]
    : [[0, noVideoCues ? 1 : 2], [7000, 1], [10427, noVideoCues ? 1 : 2], [20854, noVideoCues ? 1 : 2], [31240, noVideoCues ? 1 : 2]]);
  const cuesPayload = emptyCues ? Buffer.alloc(0) : Buffer.concat(cueRows.map(([time, track], index) =>
    cue(time, omitCueTrack ? null : track, firstClusterPosition + BigInt(index > 2 ? clusterA.length : 0), !omitClusterPositions, duplicateFields, reverseCueFields)));
  const cues = element('1c53bb6b', cuesPayload, { unknown: unknownCues });
  const infoPosition = BigInt(prefix.length + placeholderHead.length);
  const tracksPosition = infoPosition + BigInt(info.length);
  const cuesPosition = tracksPosition + BigInt(tracks.length + clusterA.length + clusterB.length);
  const seekHead = noSeekHead ? Buffer.alloc(0) : element('114d9b74', Buffer.concat([
    seekEntry('1549a966', infoPosition), seekEntry('1654ae6b', tracksPosition), ...(omitCuesSeek ? [] : [seekEntry('1c53bb6b', cuesPosition)])
  ]));
  assert.equal(seekHead.length, placeholderHead.length);
  const payload = Buffer.concat([prefix, seekHead, info, tracks, clusterA, clusterB, cues]);
  const segment = element('18538067', payload, { unknown: unknownSegment });
  return Buffer.concat([element('1a45dfa3', element('4282', Buffer.from('matroska'))), segment]);
}

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
}

async function sendResult(result) {
  const server = http.createServer(async (request, response) => {
    try { await result.send(request, response); }
    catch (error) { if (!response.headersSent) { response.statusCode = error.status ?? 500; response.end(error.message); } else response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/main.m3u8`);
    return { status: response.status, text: await response.text() };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function responseText(result) {
  const response = await sendResult(result);
  assert.equal(response.status, 200);
  return response.text;
}

test('bounded version-bound VFS ranges match the frozen native Matroska sample', async () => {
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') });
  try {
    const actual = await extractMatroskaKeyframes(fixture.vfs, '/source.mkv');
    assert.equal(actual.TotalDuration, 300210000n);
    assert.deepEqual(actual.KeyframeTicks, [0n, 16680000n, 25030000n, 34700000n, 50150000n, 66830000n, 75180000n, 84850000n,
      100300000n, 116980000n, 125330000n, 135000000n, 150450000n, 167130000n, 175480000n, 185150000n, 200600000n,
      217280000n, 225630000n, 235300000n, 250750000n, 267430000n, 275780000n, 285450000n]);
    const ranges = fixture.requests.filter(request => request.method === 'GET');
    assert.equal(ranges.length, 2);
    for (const request of ranges) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.range);
      assert.ok(match); assert.ok(BigInt(match[2]) - BigInt(match[1]) + 1n <= 65536n);
      assert.equal(request.ifMatch, '"revision-1"');
    }
  } finally { await fixture.close(); }
});

test('SeekHead scanning, Segment-relative cue positions, video selection, and unknown Segment size are supported', async () => {
  for (const seekPrefix of [false, true]) {
    const fixture = await extractionFixture({ '/source.mkv': matroska({ seekPrefix, unknownSegment: true }) });
    try {
      const actual = await extractMatroskaKeyframes(fixture.vfs, '/source.mkv');
      assert.equal(actual.TotalDuration, 350000000n);
      assert.deepEqual(actual.KeyframeTicks, [0n, 104270000n, 208540000n, 312400000n]);
    } finally { await fixture.close(); }
  }
  const nativeEdges = [
    { bytes: matroska({ omitClusterPositions: true }), ticks: [0n, 104270000n, 208540000n, 312400000n] },
    { bytes: matroska({ outOfOrder: true }), ticks: [0n, 104270000n, 70000000n, 208540000n, 312400000n] },
    { bytes: matroska({ duplicateFields: true }), ticks: [0n, 104270000n, 208540000n, 312400000n] }
  ];
  for (const edge of nativeEdges) {
    const fixture = await extractionFixture({ '/source.mkv': edge.bytes });
    try { assert.deepEqual((await extractMatroskaKeyframes(fixture.vfs, '/source.mkv')).KeyframeTicks, edge.ticks); }
    finally { await fixture.close(); }
  }
  const reversedInfo = await extractionFixture({ '/source.mkv': matroska({ reverseInfoFields: true }) });
  try { assert.equal((await extractMatroskaKeyframes(reversedInfo.vfs, '/source.mkv')).TotalDuration, 0n); }
  finally { await reversedInfo.close(); }
  for (const bytes of [matroska({ reverseTrackFields: true }), matroska({ reverseCueFields: true })]) {
    const fixture = await extractionFixture({ '/source.mkv': bytes });
    try { await assert.rejects(extractMatroskaKeyframes(fixture.vfs, '/source.mkv'), { code: 'invalid-response' }); }
    finally { await fixture.close(); }
  }
});

test('Duration scaling preserves CLR binary64 intermediates and midpoint-to-even Int64 conversion', async () => {
  const fixture = await extractionFixture({ '/source.mkv': matroska({ duration: 20270069252096, timestampScale: 581862 }) });
  try { assert.equal((await extractMatroskaKeyframes(fixture.vfs, '/source.mkv')).TotalDuration, 117943830351630832n); }
  finally { await fixture.close(); }
});

test('CueTime scaling rejects an Int64 multiplication overflow instead of persisting wrapped native ticks', async () => {
  const fixture = await extractionFixture({ '/source.mkv': matroska({ timestampScale: 100000000, cueTimes: [0, 1000000000000] }) });
  try { await assert.rejects(extractMatroskaKeyframes(fixture.vfs, '/source.mkv'), /overflows the Int64 scaling intermediate/); }
  finally { await fixture.close(); }
});

test('missing SeekHead targets, unknown metadata sizes, truncated lengths, and wrong-track cues never become stored success', async () => {
  for (const bytes of [matroska({ noSeekHead: true }), matroska({ omitCuesSeek: true }), matroska({ unknownCues: true }), matroska().subarray(0, -1)]) {
    const fixture = await extractionFixture({ '/source.mkv': bytes });
    try { await assert.rejects(extractMatroskaKeyframes(fixture.vfs, '/source.mkv'), { code: 'invalid-response' }); }
    finally { await fixture.close(); }
  }
  for (const bytes of [matroska({ noVideoCues: true }), matroska({ emptyCues: true }), matroska({ omitCueTrack: true })]) {
    const fixture = await extractionFixture({ '/source.mkv': bytes });
    try { assert.deepEqual((await extractMatroskaKeyframes(fixture.vfs, '/source.mkv')).KeyframeTicks, []); }
    finally { await fixture.close(); }
  }
});

test('cancellation and source version changes reject extraction without a result', async () => {
  const delayed = await extractionFixture({ '/source.mkv': matroska() }, { delayMs: 100 });
  try {
    const controller = new AbortController();
    const pending = extractMatroskaKeyframes(delayed.vfs, '/source.mkv', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { code: 'cancelled' });
  } finally { await delayed.close(); }

  const changed = await extractionFixture({ '/source.mkv': matroska() });
  try {
    const openRead = changed.adapter.openRead.bind(changed.adapter);
    let replaced = false;
    changed.adapter.openRead = async (...args) => {
      const handle = await openRead(...args);
      if (!replaced) { replaced = true; changed.replace('/source.mkv', matroska()); }
      return handle;
    };
    await assert.rejects(extractMatroskaKeyframes(changed.vfs, '/source.mkv'), { code: 'version-changed' });
  } finally { await changed.close(); }

  const unreliable = await extractionFixture({ '/source.mkv': matroska() }, { reliableVersion: false });
  try {
    await assert.rejects(extractMatroskaKeyframes(unreliable.vfs, '/source.mkv'), { code: 'not-supported' });
    assert.equal(unreliable.requests.length, 0);
  } finally { await unreliable.close(); }
});

test('failed KeyframeData replacement rolls back the old native row', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'mkv_keyframe_fail');
  await seed(database);
  await database.insert('KeyframeData', { ItemId: itemId, TotalDuration: 1n, KeyframeTicks: '[0]' });
  const store = new DomainStore(database);
  const fixture = await extractionFixture({ '/source.mkv': matroska() });
  const service = new MatroskaKeyframeService({ store, vfs: fixture.vfs });
  const withConnection = database.withConnection.bind(database);
  database.withConnection = operation => withConnection(session => {
    const insert = session.insert.bind(session);
    session.insert = (table, values) => {
      if (table === 'KeyframeData') throw new Error('injected KeyframeData insert failure');
      return insert(table, values);
    };
    return operation(session);
  });
  try {
    await assert.rejects(service.get(itemId, '/source.mkv'), /injected KeyframeData insert failure/);
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), [
      { ItemId: itemId, TotalDuration: 1n, KeyframeTicks: '[0]' }
    ]);
  } finally { database.withConnection = withConnection; await fixture.close(); await store.close(); }
});

test('a source change at the transactional persistence recheck falls back without storing a row', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'mkv_keyframe_change');
  await seed(database);
  const store = new DomainStore(database);
  const fixture = await extractionFixture({ '/source.mkv': matroska() });
  const service = new MatroskaKeyframeService({ store, vfs: fixture.vfs });
  const stat = fixture.adapter.stat.bind(fixture.adapter);
  let calls = 0;
  fixture.adapter.stat = async (...args) => {
    calls++;
    if (calls === 3) fixture.replace('/source.mkv', matroska());
    return stat(...args);
  };
  try {
    assert.equal(await service.get(itemId, '/source.mkv'), undefined);
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), []);
  } finally { await fixture.close(); await store.close(); }
});

test('a native AbortError from the initial stat cancels the owner without poisoning a waiter', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'mkv_keyframe_abort');
  await seed(database);
  const store = new DomainStore(database);
  const fixture = await extractionFixture({ '/source.mkv': matroska() });
  const stat = fixture.adapter.stat.bind(fixture.adapter);
  let statCalls = 0;
  let initialStatStarted;
  const started = new Promise(resolve => { initialStatStarted = resolve; });
  fixture.adapter.stat = async (path, options = {}) => {
    statCalls++;
    if (statCalls === 1) {
      initialStatStarted();
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted.', 'AbortError')), { once: true });
      });
    }
    return stat(path, options);
  };
  const service = new MatroskaKeyframeService({ store, vfs: fixture.vfs });
  try {
    const controller = new AbortController();
    const owner = service.get(itemId, '/source.mkv', { signal: controller.signal });
    await started;
    const waiter = service.get(itemId, '/source.mkv');
    controller.abort();
    await assert.rejects(owner, { code: 'cancelled' });
    assert.equal((await waiter).TotalDuration, 350000000n);
    assert.equal(statCalls, 4);
  } finally { await fixture.close(); await store.close(); }
});

test('an owner cancellation does not poison waiters and a changed path is re-extracted serially', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const database = await createPostgresTestDatabase(t, 'mkv_keyframe_owner');
  await seed(database);
  const store = new DomainStore(database);
  const fixture = await extractionFixture({ '/source.mkv': matroska() }, { delayMs: 100 });
  const service = new MatroskaKeyframeService({ store, vfs: fixture.vfs });
  try {
    const controller = new AbortController();
    const owner = service.get(itemId, '/source.mkv', { signal: controller.signal });
    const waiter = service.get(itemId, '/source.mkv');
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(owner, { code: 'cancelled' });
    assert.equal((await waiter).TotalDuration, 350000000n);
    assert.equal((await database.rows('KeyframeData', { where: { ItemId: itemId } }))[0].TotalDuration, 350000000n);

    fixture.setDelay(0);
    fixture.replace('/other.mkv', matroska({ duration: 40000 }));
    await database.delete('KeyframeData', { ItemId: itemId });
    const [first, second] = await Promise.all([service.get(itemId, '/source.mkv'), service.get(itemId, '/other.mkv')]);
    assert.equal(first.TotalDuration, 350000000n);
    assert.equal(second.TotalDuration, 400000000n);
    assert.equal((await database.rows('KeyframeData', { where: { ItemId: itemId } }))[0].TotalDuration, 400000000n);
  } finally { await fixture.close(); await store.close(); }
});

test('a missing row is extracted once, atomically stored, and used by concurrent HLS main requests on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'mkv_keyframes');
  let store;
  const fixture = await extractionFixture({ '/source.mkv': matroska({ seekPrefix: true }) });
  try {
    await seed(database);
    store = new DomainStore(database);
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated Matroska fixture.' });
    const library = { store,
      getItemRecord: async () => ({ Id: itemId, MediaType: 'Video' }),
      getMediaSources: async () => [structuredClone(reference.source)] };
    const hls = { encodingOptions: { AllowOnDemandMetadataBasedKeyframeExtractionForExtensions: ['.mkv'] }, initialize: async () => true };
    const playback = new PlaybackService({ library, hls, vfs: fixture.vfs, identityMap });
    const [first, second] = await Promise.all([
      responseText(await playback.hlsStream(itemId, 'main', hlsOptions)),
      responseText(await playback.hlsStream(itemId, 'main', hlsOptions))
    ]);
    for (const text of [first, second]) {
      assert.match(text, /#EXT-X-TARGETDURATION:11/);
      assert.match(text, /#EXTINF:10\.427000[\s\S]+runtimeTicks=104270000&actualSegmentLengthTicks=104270000/);
    }
    assert.equal(fixture.requests.filter(request => request.method === 'GET').length, 1, 'Concurrent requests share one bounded extraction.');
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), [{
      ItemId: itemId, TotalDuration: 350000000n, KeyframeTicks: '[0,104270000,208540000,312400000]'
    }]);

    await database.delete('KeyframeData', { ItemId: itemId });
    const openRead = fixture.adapter.openRead.bind(fixture.adapter);
    let replaceDuringRead = true;
    fixture.adapter.openRead = async (...args) => {
      const handle = await openRead(...args);
      if (replaceDuringRead) { replaceDuringRead = false; fixture.replace('/source.mkv', matroska({ seekPrefix: true })); }
      return handle;
    };
    const versionFallback = await responseText(await playback.hlsStream(itemId, 'main', hlsOptions));
    assert.match(versionFallback, /#EXT-X-TARGETDURATION:6/);
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), []);
    fixture.adapter.openRead = openRead;

    const unsupportedSource = structuredClone(reference.source);
    unsupportedSource.MediaStreams.find(stream => stream.Type === 'Video').Codec = 'vp9';
    library.getMediaSources = async () => [unsupportedSource];
    const beforeUnsupported = fixture.requests.length;
    const unsupported = await sendResult(await playback.hlsStream(itemId, 'main', hlsOptions));
    assert.equal(unsupported.status, 400);
    assert.equal(fixture.requests.length, beforeUnsupported, 'A failed packet-copy plan does not read Matroska metadata.');
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), []);

    library.getMediaSources = async () => [structuredClone(reference.source)];
    fixture.replace('/source.mkv', matroska({ noSeekHead: true }));
    const malformedFallback = await responseText(await playback.hlsStream(itemId, 'main', hlsOptions));
    assert.match(malformedFallback, /#EXT-X-TARGETDURATION:6/);
    assert.deepEqual(await database.rows('KeyframeData', { where: { ItemId: itemId } }), []);

    const webmSource = structuredClone(reference.source); webmSource.Path = 'Z:\\Hls\\source.webm';
    library.getMediaSources = async () => [webmSource];
    hls.encodingOptions.AllowOnDemandMetadataBasedKeyframeExtractionForExtensions = ['webm'];
    const before = fixture.requests.length;
    const fallback = await responseText(await playback.hlsStream(itemId, 'main', hlsOptions));
    assert.match(fallback, /#EXT-X-TARGETDURATION:6/);
    assert.equal(fixture.requests.length, before, 'The native metadata extractor does not accept WebM.');
  } finally {
    await fixture.close();
    await store?.close();
  }
});
