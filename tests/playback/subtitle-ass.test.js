import { createPlaybackState } from './runtime-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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

test('PlaybackInfo and authenticated HLS deliver external ASS as native WebVTT without AV work', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'subtitle_ass');
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(hlsReference.media, 'base64'), '/fixture.ass': Buffer.from(reference.inputs.ass, 'base64'),
    '/fixture.ssa': Buffer.from(reference.inputs.ssa, 'base64') });
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated ASS fixture.' });
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), `mediamanager-ass-hls-${randomBytes(4).toString('hex')}-`));
  const state = await createPlaybackState({ TranscodingTempPath: cacheDirectory });
  let runtime;
  try {
    await seed(database);
    const processes = [];
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap,
      hlsOptions: { onProcess: process => processes.push(process) } });
    const user = await runtime.users.createUser({ Name: 'AssReader', Password: 'isolated-ass-password' });
    await runtime.users.updatePolicy(user.Id, { ...library.user.Policy, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true });

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await (await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="ASS HLS", Device="Isolated", DeviceId="ass-hls", Version="1"' },
    body: JSON.stringify({ Username: 'AssReader', Pw: 'isolated-ass-password' }) })).json();
    const headers = { Authorization: `MediaBrowser Token="${login.AccessToken}"`, 'Content-Type': 'application/json' };
    const infoResponse = await fetch(origin + `/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers,
      body: JSON.stringify({ DeviceProfile: hlsProfile, MediaSourceId: itemId, SubtitleStreamIndex: 3 }) });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json(), source = info.MediaSources[0];
    assert.equal(source.SupportsTranscoding, true);
    assert.equal(source.MediaStreams.find(stream => stream.Index === 3).DeliveryMethod, 'Hls');
    assert.equal(source.MediaStreams.find(stream => stream.Index === 4).DeliveryMethod, 'Hls');
    assert.match(source.TranscodingUrl, /SubtitleMethod=Hls/u);
    const masterUrl = new URL(source.TranscodingUrl, origin);
    const masterResponse = await fetch(masterUrl, { headers });
    assert.equal(masterResponse.status, 200);
    const master = await masterResponse.text();
    assert.match(master, /#EXT-X-MEDIA:TYPE=SUBTITLES[^\r\n]+Subtitles\/3\/subtitles\.m3u8/u);
    const subtitleUrl = new URL(/URI="([^"]+)"/u.exec(master)[1], masterUrl);
    const playlistResponse = await fetch(subtitleUrl, { headers });
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.text();
    const segmentUrl = new URL(playlist.split(/\r?\n/u).find(line => line && !line.startsWith('#')), subtitleUrl);
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
  } finally {
    await runtime?.close(); await fixture.close(); await state.close(); if (!runtime) await database.close();
    assert.equal(path.dirname(cacheDirectory), tmpdir()); await rm(cacheDirectory, { recursive: true, force: true });
  }
});
