import { createPlaybackState } from './runtime-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { decodeSubtitle, convertSubtitle } from '../../src/playback/subtitles.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/subtitle-ass-reference.json' with { type: 'json' };
import hlsReference from './fixtures/hls-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { assertProjectedEqual, observeComparison } from '../comparison-observations.js';
import { errorObservation } from '../helpers/error-observation.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';

const inputs = Object.fromEntries(Object.entries(reference.inputs).map(([format, bytes]) => [format, decodeSubtitle(Buffer.from(bytes, 'base64'))]));
const cases = [
  ['', {}],
  ['-crop', { startPositionTicks: 50000000n, endPositionTicks: 80000000n }],
  ['-preserve', { startPositionTicks: 50000000n, endPositionTicks: 80000000n, copyTimestamps: true }],
];

test('ASS and SSA conversion preserves the frozen SubtitleEdit observations', t => {
  for (const inputFormat of ['ass', 'ssa']) for (const outputFormat of ['srt', 'vtt', 'json']) for (const [suffix, options] of cases) {
    const name = `${inputFormat}-${outputFormat}${suffix}`;
    assertProjectedEqual(t, name, convertSubtitle(inputs[inputFormat], inputFormat, outputFormat, options), reference.records[name].text,
      outputFormat === 'json' ? parseLosslessJson : undefined);
  }
  for (const inputFormat of ['ass', 'ssa']) {
    assert.equal(convertSubtitle(inputs[inputFormat], inputFormat, 'subrip'), reference.records[`${inputFormat}-srt`].text);
    assert.equal(convertSubtitle(inputs[inputFormat], inputFormat, 'webvtt'), reference.records[`${inputFormat}-vtt`].text);
  }
  assert.match(reference.records['ass-srt'].text, /\{\\pos\(400,570\)\}First, comma\r\nSecond line/u);
  assert.match(reference.records['ssa-vtt'].text, /Before <i>italic<\/i> after/u);
  assert.match(reference.records['ass-vtt'].text, /Before italic after/u);
});

const itemId = '22222222222222222222222222222222';
const assStream = { Type: 'Subtitle', Index: 3, Codec: 'ass', Language: 'eng', Title: 'ASS fixture', IsDefault: true, IsForced: false,
  IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: 'Z:\\Hls\\fixture.ass' };
const ssaStream = { Type: 'Subtitle', Index: 4, Codec: 'ssa', Language: 'fra', Title: 'SSA fixture', IsDefault: false, IsForced: false,
  IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: 'Z:\\Hls\\fixture.ssa' };
const hlsProfile = {
  Name: 'ASS HLS fixture', MaxStreamingBitrate: 10000000,
  DirectPlayProfiles: [{ Type: 'Video', Container: 'avi', VideoCodec: 'h264', AudioCodec: 'aac' }],
  TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'aac', EnableSubtitlesInManifest: true }],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls', Language: 'eng' }, { Format: 'vtt', Method: 'Hls', Language: 'fra' }],
};

async function seed(database) {
  for (const [table, rows] of Object.entries(hlsReference.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
        value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  await database.insert('MediaStreamInfos', probeStreamRow('22222222-2222-2222-2222-222222222222', assStream));
  await database.insert('MediaStreamInfos', probeStreamRow('22222222-2222-2222-2222-222222222222', ssaStream));
}

test('ASS playback negotiation preserves the AV boundary while authenticated subtitle renditions deliver native WebVTT', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'subtitle_ass');
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(hlsReference.media, 'base64'), '/fixture.ass': Buffer.from(reference.inputs.ass, 'base64'),
    '/fixture.ssa': Buffer.from(reference.inputs.ssa, 'base64') });
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated ASS fixture.' });
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), `mediamanager-ass-hls-${randomBytes(4).toString('hex')}-`));
  const state = await createPlaybackState({ TranscodingTempPath: cacheDirectory });
  const readers = [], processes = [], cleanup = [], cleanupErrors = [], diagnostics = [];
  const openRead = fixture.adapter.openRead.bind(fixture.adapter);
  fixture.adapter.openRead = async (...args) => {
    const handle = await openRead(...args), reader = { path: args[0], closed: false }; readers.push(reader);
    return { ...handle, async close() { await handle.close(); reader.closed = true; } };
  };
  let runtime, accessToken, failed = false, primary;
  const observe = (label, value) => {
    try { t.diagnostic(label + ' ' + filterEvidenceJson(value, new Set([accessToken].filter(Boolean))).trim()); } catch { /* Diagnostics do not replace a business result. */ }
  };
  const inputBytes = { '/source.mkv': Buffer.from(hlsReference.media, 'base64'), '/fixture.ass': Buffer.from(reference.inputs.ass, 'base64'),
    '/fixture.ssa': Buffer.from(reference.inputs.ssa, 'base64') };
  const readInputs = async () => {
    const result = [];
    for (const [name, expected] of Object.entries(inputBytes)) {
      const handle = await fixture.vfs.openRead(name), chunks = [];
      try { for await (const bytes of handle.stream) chunks.push(bytes); } finally { await handle.close(); }
      const bytes = Buffer.concat(chunks); assert.deepEqual(bytes, expected, name + ': unchanged original source bytes');
      result.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return result;
  };
  try {
    await seed(database);
    const before = await readInputs(); observe('ass-input-before', before);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap,
      extractionOptions: { onProcess: process => processes.push({ kind: 'extraction', ...process }) },
      remuxOptions: { onProcess: process => processes.push({ kind: 'remux', ...process }) },
      hlsOptions: { onProcess: process => processes.push({ kind: 'hls', ...process }) }, onError: error => diagnostics.push(errorObservation(error)) });
    const user = await runtime.users.createUser({ Name: 'AssReader', Password: 'isolated-ass-password' });
    await runtime.users.updatePolicy(user.Id, { ...library.user.Policy, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true });
    const { Policy } = await runtime.users.getUser(user.Id); observe('ass-policy', Policy);
    assert.equal(Policy.EnableVideoPlaybackTranscoding, false); assert.equal(Policy.EnablePlaybackRemuxing, true);

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const loginResponse = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="ASS HLS", Device="Isolated", DeviceId="ass-hls", Version="1"' },
    body: JSON.stringify({ Username: 'AssReader', Pw: 'isolated-ass-password' }) });
    assert.equal(loginResponse.status, 200); const login = await loginResponse.json(); accessToken = login.AccessToken;
    const headers = { Authorization: `MediaBrowser Token="${login.AccessToken}"`, 'Content-Type': 'application/json' };
    const me = await fetch(origin + '/Users/Me', { headers }); assert.equal(me.status, 200);
    assert.equal((await me.json()).Id.replaceAll('-', '').toLowerCase(), user.Id.replaceAll('-', '').toLowerCase());
    const infoResponse = await fetch(origin + `/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers,
      body: JSON.stringify({ DeviceProfile: hlsProfile, MediaSourceId: itemId, SubtitleStreamIndex: 3 }) });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json(), source = info.MediaSources[0];
    observe('ass-public-playback-info', info);
    // Native profile negotiation requires Encode for ASS/SSA -> VTT. R6 does
    // not advertise that AV branch. MediaInfoHelper's broader native flag is
    // not claimed to be an executable Node capability or equal to this flag.
    assert.equal(source.SupportsTranscoding, false);
    assert.equal(source.MediaStreams.find(stream => stream.Index === 3).DeliveryMethod, 'Encode');
    assert.equal(source.MediaStreams.find(stream => stream.Index === 4).DeliveryMethod, 'Encode');
    assert.equal(source.TranscodingUrl, undefined);
    const subtitleUrl = new URL(`/Videos/${itemId}/${source.Id}/Subtitles/3/subtitles.m3u8?SegmentLength=30`, origin);
    const anonymousPlaylist = await fetch(subtitleUrl); assert.equal(anonymousPlaylist.status, 401); await anonymousPlaylist.arrayBuffer();
    const playlistResponse = await fetch(subtitleUrl, { headers });
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.text();
    observe('ass-subtitle-playlist', { status: playlistResponse.status, headers: Object.fromEntries(playlistResponse.headers), text: playlist });
    const segmentUrl = new URL(playlist.split(/\r?\n/u).find(line => line && !line.startsWith('#')), subtitleUrl);
    const anonymousUrl = new URL(segmentUrl); anonymousUrl.searchParams.delete('ApiKey');
    const anonymousSegment = await fetch(anonymousUrl); assert.equal(anonymousSegment.status, 401); await anonymousSegment.arrayBuffer();
    const segmentResponse = await fetch(segmentUrl, { headers });
    assert.equal(segmentResponse.status, 200); assert.equal(segmentResponse.headers.get('content-type'), reference.records['ass-vtt-hls-full'].contentType);
    assert.equal(segmentResponse.headers.get('content-length'), reference.records['ass-vtt-hls-full'].contentLength);
    assert.equal(await segmentResponse.text(), reference.records['ass-vtt-hls-full'].text);
    for (const format of ['srt', 'vtt', 'json']) {
      const response = await fetch(origin + `/Videos/${itemId}/${itemId}/Subtitles/4/Stream.${format}?startPositionTicks=50000000&endPositionTicks=80000000`, { headers });
      const expected = reference.records[`ssa-${format}-crop`];
      assert.equal(response.status, expected.status, format); assert.equal(response.headers.get('content-type'), expected.contentType, format);
      const bytes = Buffer.from(await response.arrayBuffer()), length = response.headers.get('content-length');
      if (format === 'json') {
        observeComparison(t, format + ' delivered Content-Length', length, expected.contentLength);
        assert.equal(length == null, expected.contentLength == null, format + ' retains the native length-header presence');
        if (length != null) assert.equal(Number(length), bytes.length, format + ' length matches the actual body');
      } else assert.equal(length, expected.contentLength, format);
      assertProjectedEqual(t, format, bytes.toString('utf8'), expected.text, format === 'json' ? parseLosslessJson : undefined);
    }
    assert.deepEqual(processes, []);
    assert.equal(fixture.requests.every(request => request.authorization == null), true);
    const after = await readInputs(); observe('ass-input-after', after); assert.deepEqual(after, before);
  } catch (error) { failed = true; primary = error; observe('ass-failure', errorObservation(error));
  } finally {
    for (const [label, operation] of [
      ['runtime', async () => { await runtime?.close(); if (runtime) assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening)); }],
      ['source', () => fixture.close()], ['state', () => state.close()], ['database', () => database.close()],
      ['hls-cache', async () => { assert.equal(path.dirname(cacheDirectory), tmpdir()); await rm(cacheDirectory, { recursive: true, force: true }); }],
    ]) try { await operation(); cleanup.push({ label, closed: true }); } catch (error) { cleanupErrors.push(error); cleanup.push({ label, error: errorObservation(error) }); }
    observe('ass-lifecycle', { readers, processes, requests: fixture.requests, diagnostics, cleanup });
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
    primary?.message ?? 'ASS subtitle consumer cleanup failed.', { cause: failed ? primary : cleanupErrors[0] });
  if (failed) throw primary;
  assert.ok(readers.every(reader => reader.closed), 'Every actual source reader finished its close.');
});
