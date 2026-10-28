import { createPlaybackState } from './runtime-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { bindStreaming } from '../../src/http/playback-routes.js';
import { hlsPlan, masterPlaylist, subtitlePlaylist } from '../../src/playback/hls.js';
import { negotiateSource } from '../../src/playback/profile.js';
import { extractionFixture } from './extraction-fixture.js';
import hlsReference from './fixtures/hls-reference.json' with { type: 'json' };
import native from './fixtures/hls-subtitle-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { projectHlsRequestIdentities, projectPlaybackRequestUrl } from '../helpers/playback-transport-projection.js';

const id = '22222222222222222222222222222222';
const token = 'fixture-token';
const session = 'fixture-session';
const english = Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\nEnglish first\r\n\r\n2\r\n00:00:30,000 --> 00:00:30,021\r\nEnglish tail\r\n');
const chinese = Buffer.from('WEBVTT\r\n\r\n00:00:02.000 --> 00:00:04.000\r\nChinese forced\r\n');
const subtitleStreams = [
  { Type: 'Subtitle', Index: 3, Codec: 'subrip', Language: 'eng', Title: 'English', DisplayTitle: 'English - Default - SUBRIP - External', IsDefault: true,
    IsForced: false, IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: 'Z:\\Hls\\english.srt' },
  { Type: 'Subtitle', Index: 4, Codec: 'webvtt', Language: 'zho', Title: 'Chinese', DisplayTitle: 'Chinese - Forced - WEBVTT - External', IsDefault: false,
    IsForced: true, IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: 'Z:\\Hls\\forced.vtt' },
  { Type: 'Subtitle', Index: 5, Codec: 'pgssub', Language: 'jpn', DisplayTitle: 'Japanese PGS', IsDefault: false,
    IsForced: false, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: true },
];
const profile = {
  Name: 'Subtitle manifest fixture', MaxStreamingBitrate: 10000000,
  DirectPlayProfiles: [{ Type: 'Video', Container: 'avi', VideoCodec: 'h264', AudioCodec: 'aac' }],
  TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'aac', EnableSubtitlesInManifest: true }],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls', Language: 'eng' }, { Format: 'vtt', Method: 'Hls', Language: 'zho' }],
};

function sourceFixture() {
  const source = structuredClone(hlsReference.source);
  source.ETag = 'b0bb246c056d549f0003c6e60385415e';
  source.MediaStreams.push(...structuredClone(subtitleStreams));
  source.DefaultSubtitleStreamIndex = 3;
  return source;
}

function streamingOptions(urlText) {
  const url = new URL(urlText.replaceAll('<token>', token).replaceAll('<session>', session), 'http://localhost');
  const options = bindStreaming({ params: {}, query: url.searchParams }, 'Videos');
  return { ...options, AccessToken: token, CanDeliverHlsSubtitle: stream => stream.IsExternal && ['subrip', 'webvtt'].includes(stream.Codec) };
}

const normalized = value => projectHlsRequestIdentities(value, { token, playSessionId: session });

test('HLS subtitle delivery, master renditions and subtitle playlist match the current native instance', () => {
  const source = sourceFixture();
  const initialUrl = native.playbackInfo.source.TranscodingUrl;
  for (const name of ['master', 'externalEnabled', 'externalDisabled', 'selectedForced', 'dropEnabled']) {
    const expected = native[name];
    const url = new URL(initialUrl.replaceAll('<token>', token).replaceAll('<session>', session), 'http://localhost');
    if (name === 'externalEnabled') { url.searchParams.set('SubtitleMethod', 'External'); url.searchParams.set('EnableSubtitlesInManifest', 'true'); }
    if (name === 'externalDisabled') { url.searchParams.set('SubtitleMethod', 'External'); url.searchParams.set('EnableSubtitlesInManifest', 'false'); }
    if (name === 'selectedForced') url.searchParams.set('SubtitleStreamIndex', '4');
    if (name === 'dropEnabled') { url.searchParams.set('SubtitleMethod', 'Drop'); url.searchParams.set('EnableSubtitlesInManifest', 'true'); }
    assert.equal(normalized(masterPlaylist(source, streamingOptions(url.pathname + url.search), url.search.slice(1))), expected.text, name);
  }
  assert.equal(normalized(subtitlePlaylist(source, 30, token)), native.subtitlePlaylist.text);
  assert.throws(() => subtitlePlaylist({ ...source, RunTimeTicks: 0 }, 30, token), { code: 'invalid-request' });
  assert.throws(() => subtitlePlaylist(source, 0, token), { code: 'invalid-request' });
  assert.throws(() => subtitlePlaylist(source, 86401, token), { code: 'invalid-request' });
  assert.throws(() => subtitlePlaylist({ ...source, RunTimeTicks: 1000010000000n }, 1, token), { code: 'invalid-request' });
  assert.doesNotThrow(() => hlsPlan(source, streamingOptions(initialUrl)));
  const unavailable = sourceFixture(); unavailable.MediaStreams[3].IsExternal = false;
  assert.throws(() => hlsPlan(unavailable, streamingOptions(initialUrl)), { code: 'not-supported' });
});

test('StreamBuilder negotiation selects the native Hls subtitle profile without mapping subtitles into AV output', () => {
  const source = sourceFixture();
  negotiateSource(source, { Id: id, MediaType: 'Video' }, profile, {
    SubtitleStreamIndex: 3, DeviceId: 'subtitle-manifest', PlaySessionId: session, AccessToken: token, EnableRemuxing: true,
    CanRemux: () => false, CanExtractSubtitle: () => true,
    CanHls: (mediaSource, options) => { try { hlsPlan(mediaSource, { ...options, CanDeliverHlsSubtitle: stream => stream.IsExternal }); return true; } catch { return false; } },
  });
  assert.equal(source.SupportsTranscoding, true);
  assert.equal(projectPlaybackRequestUrl(source.TranscodingUrl, { token, playSessionId: session }), native.playbackInfo.source.TranscodingUrl);
  assert.deepEqual(source.TranscodeReasons, ['ContainerNotSupported', 'SubtitleCodecNotSupported']);
  assert.deepEqual(source.MediaStreams.filter(stream => [3, 4].includes(stream.Index)).map(stream => ({ Index: stream.Index, Codec: stream.Codec,
    DisplayTitle: stream.DisplayTitle, Language: stream.Language, IsForced: stream.IsForced,
    IsTextSubtitleStream: stream.IsTextSubtitleStream, DeliveryMethod: stream.DeliveryMethod })), native.playbackInfo.source.subtitles);
  const plan = hlsPlan(source, { ...streamingOptions(source.TranscodingUrl), CanDeliverHlsSubtitle: stream => stream.IsExternal });
  assert.deepEqual(plan.streams.map(stream => stream.type), ['Video', 'Audio']);
});

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
  for (const stream of subtitleStreams.slice(0, 2)) await database.insert('MediaStreamInfos', probeStreamRow('22222222-2222-2222-2222-222222222222', stream));
}

test('authenticated HTTP serves native master, subtitle manifest and timed WebVTT bytes without starting AV work', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'hls_subtitles');
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(hlsReference.media, 'base64'), '/english.srt': english, '/forced.vtt': chinese });
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture.' });
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), `mediamanager-subtitle-hls-${randomBytes(4).toString('hex')}-`));
  const state = await createPlaybackState({ TranscodingTempPath: cacheDirectory });
  let runtime;
  try {
    await seed(database);
    const processes = [];
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap,
      hlsOptions: { onProcess: process => processes.push(process) } });
    const user = await runtime.users.createUser({ Name: 'SubtitleReader', Password: 'isolated-subtitle-password' });
    await runtime.users.updatePolicy(user.Id, { ...library.user.Policy, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true });

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await (await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="Subtitle Manifest", Device="Isolated", DeviceId="subtitle-manifest", Version="1"' },
    body: JSON.stringify({ Username: 'SubtitleReader', Pw: 'isolated-subtitle-password' }) })).json();
    const headers = { Authorization: `MediaBrowser Token="${login.AccessToken}"`, 'Content-Type': 'application/json' };
    const infoResponse = await fetch(origin + `/Items/${id}/PlaybackInfo`, { method: 'POST', headers,
      body: JSON.stringify({ DeviceProfile: profile, MediaSourceId: id, SubtitleStreamIndex: 3 }) });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json(), actualSession = info.PlaySessionId;
    const identities = { token: login.AccessToken, playSessionId: actualSession };
    assert.equal(projectPlaybackRequestUrl(info.MediaSources[0].TranscodingUrl, identities), native.playbackInfo.source.TranscodingUrl);
    assert.deepEqual(info.MediaSources[0].MediaStreams.filter(stream => stream.Type === 'Subtitle').map(stream => ({ Index: stream.Index, Codec: stream.Codec,
      DisplayTitle: stream.DisplayTitle, Language: stream.Language, IsForced: stream.IsForced,
      IsTextSubtitleStream: stream.IsTextSubtitleStream, DeliveryMethod: stream.DeliveryMethod })), native.playbackInfo.source.subtitles);
    const masterUrl = new URL(info.MediaSources[0].TranscodingUrl, origin);
    const master = await fetch(masterUrl, { headers });
    assert.equal(master.status, 200); assert.equal(master.headers.get('content-type'), native.master.contentType);
    const masterText = await master.text(); assert.equal(projectHlsRequestIdentities(masterText, identities), native.master.text);
    const mediaLine = masterText.split(/\r?\n/).find(line => line.startsWith('#EXT-X-MEDIA'));
    const subtitleUrl = new URL(/URI="([^"]+)"/.exec(mediaLine)[1], masterUrl);
    const manifest = await fetch(subtitleUrl, { headers });
    assert.equal(manifest.status, 200); assert.equal(manifest.headers.get('content-type'), native.subtitlePlaylist.contentType);
    const manifestText = await manifest.text(); assert.equal(projectHlsRequestIdentities(manifestText, identities), native.subtitlePlaylist.text);
    const segmentUrl = new URL(manifestText.split(/\r?\n/).find(line => line && !line.startsWith('#')), subtitleUrl);
    const segment = await fetch(segmentUrl, { headers });
    assert.equal(segment.status, 200); assert.equal(segment.headers.get('content-type'), native.subtitleSegment.contentType);
    assert.equal(await segment.text(), native.subtitleSegment.text);
    const missing = await fetch(new URL(subtitleUrl.pathname, origin), { headers });
    assert.equal(missing.status, native.missingLength.status); assert.equal(missing.headers.get('content-type'), native.missingLength.contentType);
    const missingProblem = parseLosslessJson(await missing.text()), nativeProblem = parseLosslessJson(native.missingLength.text);
    for (const value of [missingProblem, nativeProblem]) { assert.equal(typeof value.traceId, 'string'); assert.ok(value.traceId.length > 0); }
    assert.deepEqual(projectProblemTrace(missingProblem, missing.status), projectProblemTrace(nativeProblem, native.missingLength.status));
    const zero = new URL(subtitleUrl); zero.searchParams.set('SegmentLength', '0');
    const invalid = await fetch(zero, { headers });
    assert.equal(invalid.status, native.zeroLength.status); assert.equal(invalid.headers.get('content-type'), native.zeroLength.contentType);
    assert.equal(await invalid.text(), native.zeroLength.text);
    await database.update('BaseItems', { Id: '22222222-2222-2222-2222-222222222222' }, { RunTimeTicks: 1000010000000n });
    const excessive = new URL(subtitleUrl); excessive.searchParams.set('SegmentLength', '1');
    assert.equal((await fetch(excessive, { headers })).status, 400);
    assert.deepEqual(processes, [], 'Manifest and sidecar delivery must not start ffmpeg.');
    assert.equal(fixture.requests.every(request => request.authorization == null), true);
  } finally {
    await runtime?.close(); await fixture.close(); await state.close();
    if (!runtime) await database.close();
    assert.equal(path.dirname(cacheDirectory), tmpdir());
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
