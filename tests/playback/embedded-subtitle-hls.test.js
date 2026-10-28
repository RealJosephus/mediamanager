import { createPlaybackState } from './runtime-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { decodeSubtitle, convertSubtitle } from '../../src/playback/subtitles.js';
import { extractionFixture } from './extraction-fixture.js';
import extractionReference from './fixtures/extraction-reference.json' with { type: 'json' };
import hlsReference from './fixtures/hls-reference.json' with { type: 'json' };
import embeddedReference from './fixtures/embedded-subtitle-hls-reference.json' with { type: 'json' };
import library from '../library/fixtures/reference-media.json' with { type: 'json' };

const item = '22222222-2222-2222-2222-222222222222';
const itemId = item.replaceAll('-', '');
const embeddedAss = {
  Type: 'Subtitle', Index: 2, Codec: 'ass', Language: 'eng', Title: 'Embedded ASS', IsDefault: true, IsForced: false,
  IsExternal: false, IsTextSubtitleStream: true, SupportsExternalStream: true,
};
const embeddedPgs = {
  Type: 'Subtitle', Index: 3, Codec: 'pgssub', Language: 'jpn', Title: 'Embedded PGS', IsDefault: false, IsForced: false,
  IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: true,
};
const profile = {
  Name: 'Embedded subtitle HLS fixture', MaxStreamingBitrate: 10000000,
  DirectPlayProfiles: [{ Type: 'Video', Container: 'avi', VideoCodec: 'h264', AudioCodec: 'aac' }],
  TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'aac', EnableSubtitlesInManifest: true }],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'Hls', Language: 'eng' }, { Format: 'vtt', Method: 'Hls', Language: 'jpn' }],
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
  await database.delete('MediaStreamInfos', { ItemId: item, StreamIndex: 2 });
  await database.insert('MediaStreamInfos', probeStreamRow(item, embeddedAss));
  await database.insert('MediaStreamInfos', probeStreamRow(item, embeddedPgs));
}

const media = Buffer.from(extractionReference.sources.find(value => value.name === 'media.mkv').media, 'base64');
const extractedAss = Buffer.from(extractionReference.outputs.find(value => value.source === 'media.mkv' && value.type === 'subtitle' && value.index === 2).bytes, 'base64');

test('the frozen embedded ASS packet copy converts to the native WebVTT bytes', () => {
  const text = decodeSubtitle(extractedAss);
  assert.equal(convertSubtitle(text, 'ass', 'vtt', { endPositionTicks: 300210000n, copyTimestamps: true }), embeddedReference.nativeVtt);
});

test('embedded ASS retains its negotiation restriction while an explicit authenticated HLS subtitle request delivers WebVTT', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `embedded_subtitle_hls_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture({ '/source.mkv': media });
  fixture.identityMap = new IdentityAccessMap();
  fixture.identityMap.addPrefix({ identityRoot: 'Z:\\Hls', accessRoot: '/', style: 'windows', returnAccess: 'Isolated embedded subtitle fixture.' });
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), `mediamanager-embedded-subtitle-${randomBytes(4).toString('hex')}-`));
  const extractionProcesses = [], hlsProcesses = [];
  const state = await createPlaybackState({ TranscodingTempPath: cacheDirectory });
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId,
      programDataPath: state.root, vfs: fixture.vfs, identityMap: fixture.identityMap,
      extractionOptions: { onProcess: process => extractionProcesses.push(process) }, hlsOptions: { onProcess: process => hlsProcesses.push(process) } });
    const user = await runtime.users.createUser({ Name: 'EmbeddedAssPostgres', Password: 'isolated-embedded-ass-password' });
    await runtime.users.updatePolicy(user.Id, { ...library.user.Policy, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true });

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await (await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="Embedded ASS HLS", Device="Isolated", DeviceId="embedded-ass-postgres", Version="1"' },
    body: JSON.stringify({ Username: 'EmbeddedAssPostgres', Pw: 'isolated-embedded-ass-password' }) })).json();
    const headers = { Authorization: `MediaBrowser Token="${login.AccessToken}"`, 'Content-Type': 'application/json' };
    const infoResponse = await fetch(origin + `/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers,
      body: JSON.stringify({ DeviceProfile: profile, MediaSourceId: itemId, SubtitleStreamIndex: 2 }) });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json(), source = info.MediaSources[0];
    assert.equal(source.SupportsTranscoding, false);
    assert.equal(source.MediaStreams.find(stream => stream.Index === 2).DeliveryMethod, 'Encode');
    assert.equal(source.MediaStreams.find(stream => stream.Index === 3).DeliveryMethod, 'Encode');
    assert.equal(source.TranscodingUrl, undefined);
    const subtitleUrl = new URL(`/Videos/${itemId}/${source.Id}/Subtitles/2/subtitles.m3u8?SegmentLength=30`, origin);
    const playlistResponse = await fetch(subtitleUrl, { headers });
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.text();
    const segmentUrl = new URL(playlist.split(/\r?\n/u).find(line => line && !line.startsWith('#')), subtitleUrl);
    const anonymousReads = fixture.requests.length;
    const anonymousUrl = new URL(segmentUrl); anonymousUrl.searchParams.delete('ApiKey');
    const anonymous = await fetch(anonymousUrl); assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
    assert.equal(fixture.requests.length, anonymousReads, 'Authentication must run before embedded extraction.');
    const segmentResponse = await fetch(segmentUrl, { headers });
    assert.equal(segmentResponse.status, 200);
    assert.equal(segmentResponse.headers.get('content-type'), 'text/vtt');
    assert.equal(await segmentResponse.text(), embeddedReference.nativeHlsVtt);
    assert.deepEqual(hlsProcesses, [], 'Subtitle rendition requests must not start an AV HLS process.');
    const subtitleProcesses = extractionProcesses.filter(process => process.args.includes('-map'));
    assert.equal(subtitleProcesses.length, 1);
    const args = subtitleProcesses[0].args;
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:2']);
    assert.deepEqual(args.slice(args.indexOf('-c:s'), args.indexOf('-c:s') + 2), ['-c:s', 'copy']);
    assert.equal(args.includes('-an') && args.includes('-vn') && args.includes('[private source]'), true);
    assert.equal(fixture.requests.every(request => request.authorization == null), true, 'The private VFS lease must not expose the client token.');
  } finally {
    if (database) {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    if (runtime) await runtime.close(); else await database?.close();
    await fixture.close(); await state.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
