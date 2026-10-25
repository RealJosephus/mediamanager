import { validationExecutable } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { extractionFixture } from './extraction-fixture.js';
import library from '../library/fixtures/reference-media.json' with { type: 'json' };

const itemId = '22222222-2222-2222-2222-222222222222';
const itemRouteId = itemId.replaceAll('-', '');
const fixtureRead = async (name, sha256) => {
  const bytes = await readFile(new URL('./fixtures/vobsub-delivery/' + name, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
  return bytes;
};
const nativeHttp = JSON.parse(await fixtureRead('native-http.json', '63b20a16948cf0433d29a03d9756b01800ffc40e66d768c7d7bb1e2d7861b322'));
assert.equal(nativeHttp.records['advertised-vobsub'].status, 400);
assert.equal(nativeHttp.records['manual-mks'].status, 200);
const nativePackets = JSON.parse(nativeHttp.records['manual-mks'].probe.stdout);
const recordedInput = JSON.parse(await fixtureRead('input.json', '07dbda5582284806967f80241ea88513cb74cf8327319f3601e03ec0ef7de40e'));
const mediaBytes = await fixtureRead('source.mkv', '4a9a6e3be221f0d08506ca6bbd6d3ad73819c82605871e9fd981b7bf14399a6c');
assert.equal(createHash('sha256').update(mediaBytes).digest('hex'), recordedInput.combined.sha256);
const sourcePath = 'Z:\\Extraction\\source.mkv';
const authorization = token => `MediaBrowser Client="VobSubDeliveryTest", Device="Isolated", DeviceId="vobsub-delivery-test", Version="1"${token ? `, Token="${token}"` : ''}`;
const mediaTables = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'BaseItemProviders', 'ItemValues', 'ItemValuesMap',
  'BaseItemImageInfos', 'BaseItemMetadataFields', 'Peoples', 'PeopleBaseItemMap', 'MediaStreamInfos', 'Chapters', 'UserData'];
const domains = { userViews: 'root/default', metadata: 'metadata', libraries: 'library-content', collections: 'data/collections' };
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
async function snapshot(database, root) {
  const tables = {}, filesystem = {};
  for (const table of mediaTables) tables[table] = (await database.rows(table)).map(json).sort();
  for (const [domain, relative] of Object.entries(domains)) {
    const entries = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false);
        const relativePath = path.relative(path.join(root, relative), filename).replaceAll('\\', '/');
        if (entry.isDirectory()) { entries.push({ path: relativePath, type: 'directory' }); await visit(filename); }
        else {
          const bytes = await readFile(filename);
          entries.push({ path: relativePath, type: 'file', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      }
    }
    let exists = true;
    try { await visit(path.join(root, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    filesystem[domain] = { exists, entries: entries.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  }
  return { tables, filesystem };
}

async function seed(database) {
  for (const [table, rows] of Object.entries(library.tables)) {
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
  await database.update('BaseItems', { Id: itemId }, {
    Path: sourcePath, Size: BigInt(mediaBytes.length), TotalBitrate: 600000,
    Data: JSON.stringify({ VideoType: 'VideoFile', Container: 'mkv', Size: mediaBytes.length, IsHD: false,
      IsShortcut: false, HasSubtitles: true, SubtitleFiles: [], RemoteTrailers: [] }),
  });
  for (const stream of [
    { Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true, IsExternal: false, Width: 320, Height: 240, TimeBase: '1/1000', AverageFrameRate: 29.97003 },
    { Type: 'Audio', Index: 1, Codec: 'aac', IsDefault: true, IsExternal: false, Channels: 2, SampleRate: 44100, TimeBase: '1/1000' },
    { Type: 'Audio', Index: 2, Codec: 'aac', IsDefault: true, IsExternal: false, Channels: 2, SampleRate: 44100, TimeBase: '1/1000' },
    { Type: 'Subtitle', Index: 3, Codec: 'dvdsub', IsDefault: true, IsForced: false, IsExternal: false,
      IsTextSubtitleStream: false, SupportsExternalStream: true, Language: 'eng', Width: 720, Height: 480, TimeBase: '1/1000' },
  ]) await database.insert('MediaStreamInfos', probeStreamRow(itemId, stream));
}

function packets(bytes) {
  const result = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_packets', '-show_streams', '-show_data_hash', 'sha256',
    '-show_entries', 'stream=codec_name,width,height:packet=pts,dts,duration,size,flags,data_hash', '-of', 'json', '-i', 'pipe:0'],
  { input: bytes, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return packetProjection(JSON.parse(result.stdout));
}

function packetProjection(value) {
  return {
    streams: value.streams.map(stream => ({ codec_name: stream.codec_name, width: stream.width, height: stream.height,
      default: stream.disposition.default, language: stream.tags?.language })),
    packets: value.packets.map(packet => ({ pts: packet.pts, dts: packet.dts, duration: packet.duration,
      size: packet.size, flags: packet.flags, data_hash: packet.data_hash })),
  };
}

test('PostgreSQL: native VobSub advertisement fails and authenticated manual MKS remains readable', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `vobsub_delivery_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture({ '/source.mkv': mediaBytes });
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'vobsub-delivery-'));
  let database, runtime;
  const runtimeErrors = [], responses = [], stages = [];
  const cleanup = { runtimeClosed: false, databaseClosed: false, portReleased: false, schemasRemoved: false,
    auditClientClosed: false, fixtureClosed: false, isolatedDirectoryRemoved: false };
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: library.serverId, programDataPath: isolatedRoot,
      vfs: fixture.vfs, identityMap: fixture.identityMap, onError: error => runtimeErrors.push(error) });
    const user = await runtime.users.createUser({ Name: 'VobSubDeliveryAdmin', Password: 'isolated-vobsub-delivery-password' });
    await runtime.users.updatePolicy(user.Id, { ...library.user.Policy });

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST',
      headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: 'VobSubDeliveryAdmin', Pw: 'isolated-vobsub-delivery-password' }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).AccessToken;
    const before = await snapshot(database, isolatedRoot);
    stages.push({ stage: 'beforePlayback', ...before });
    const profile = { MaxStreamingBitrate: 10_000_000,
      DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'h264', AudioCodec: 'aac' }],
      TranscodingProfiles: [], ContainerProfiles: [], CodecProfiles: [],
      SubtitleProfiles: [{ Format: 'vobsub', Container: 'mks', Method: 'External' }] };
    const playback = await fetch(origin + `/Items/${itemRouteId}/PlaybackInfo`, { method: 'POST',
      headers: { Authorization: authorization(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ MediaSourceId: itemRouteId, SubtitleStreamIndex: 3,
        EnableDirectPlay: true, EnableDirectStream: false, EnableTranscoding: false, DeviceProfile: profile }) });
    const playbackText = await playback.text();
    assert.equal(playback.status, 200, playbackText);
    const source = JSON.parse(playbackText).MediaSources[0];
    const subtitle = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === 3);
    assert.equal(subtitle.DeliveryMethod, 'External');
    assert.equal(subtitle.Codec.toLowerCase(), 'dvdsub');
    const advertised = new URL(subtitle.DeliveryUrl, origin);
    assert.match(advertised.pathname, /\/Stream\.vobsub$/u);
    assert.equal(advertised.searchParams.get('ApiKey'), token);
    assert.deepEqual(await snapshot(database, isolatedRoot), before);

    const anonymous = new URL(advertised);
    anonymous.searchParams.delete('ApiKey');
    const rejected = await fetch(anonymous);
    assert.equal(rejected.status, 401);
    assert.deepEqual(await snapshot(database, isolatedRoot), before);
    const response = await fetch(advertised);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expectedError = nativeHttp.records['advertised-vobsub'];
    assert.equal(response.status, expectedError.status);
    assert.equal(response.headers.get('content-type'), expectedError.headers['content-type']);
    assert.equal(bytes.length, expectedError.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedError.sha256);
    assert.equal(bytes.toString('utf8'), expectedError.bodyUtf8);
    responses.push({ suffix: 'vobsub', status: response.status, contentType: response.headers.get('content-type'),
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const afterAdvertisement = await snapshot(database, isolatedRoot);
    assert.deepEqual(afterAdvertisement, before);
    stages.push({ stage: 'afterAdvertisement', ...afterAdvertisement });
    for (const suffix of ['mks', 'MKS']) {
      const manual = new URL(advertised);
      manual.pathname = manual.pathname.replace('/Stream.vobsub', '/Stream.' + suffix);
      const delivered = await fetch(manual);
      const deliveredBytes = Buffer.from(await delivered.arrayBuffer());
      assert.equal(delivered.status, nativeHttp.records['manual-mks'].status);
      assert.equal(delivered.headers.get('content-type'), nativeHttp.records['manual-mks'].headers['content-type']);
      const projection = packets(deliveredBytes);
      assert.deepEqual(projection, packetProjection(nativePackets));
      responses.push({ suffix, status: delivered.status, contentType: delivered.headers.get('content-type'),
        bytes: deliveredBytes.length, packetProjection: projection });
      const afterManual = await snapshot(database, isolatedRoot);
      assert.deepEqual(afterManual, before);
      stages.push({ stage: 'afterManual' + suffix, ...afterManual });
    }
    assert.equal(runtimeErrors.length, 1);
    assert.equal(runtimeErrors[0].status, 400);
    assert.equal(fixture.requests.some(entry => entry.authorization), false);
  } finally {
    if (runtime) { await runtime.close(); cleanup.runtimeClosed = true; cleanup.portReleased = runtime.networkHost.listeners.every(entry => !entry.server.listening); }
    else await database?.close();
    try { await database.rows('BaseItems'); }
    catch (error) { cleanup.databaseClosed = /not open|closed/i.test(error.message); }
    if (database) {
      const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
      await client.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
        cleanup.schemasRemoved = (await client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',
          [[schema, schema + '__mm']])).rows.length === 0;
      }
      finally { await client.end(); }
      try { await client.query('SELECT 1'); }
      catch (error) { cleanup.auditClientClosed = error.message === 'Client was closed and is not queryable'; }
    }
    await fixture.close(); cleanup.fixtureClosed = true;
    // Only this freshly created fixture directory may be removed.
    assert.equal(path.dirname(path.resolve(isolatedRoot)), path.resolve(tmpdir()));
    assert.match(path.basename(isolatedRoot), /^vobsub-delivery-/u);
    await rm(isolatedRoot, { recursive: true });
    cleanup.isolatedDirectoryRemoved = true;
    if (process.env.MEDIAMANAGER_VOBSUB_DELIVERY_EVIDENCE) {
      const directory = path.resolve(process.env.MEDIAMANAGER_VOBSUB_DELIVERY_EVIDENCE);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'postgres.json'), JSON.stringify({ phaseAcceptance: false, dialect: 'postgres', schema,
        responses, stages, cleanup,
        runtimeErrors: runtimeErrors.map(error => ({ name: error.name, message: error.message, status: error.status })),
        boundary: 'Actual runtime HTTP, authentication, copy-only extraction and ffprobe packet comparison. Candidate twelve media tables plus UserData and four filesystem domains remain unchanged; the original native HTTP recording has no table/filesystem snapshots. Complete Matroska container bytes and real client presentation are not compared.' }, null, 2) + '\n');
    }
    assert.deepEqual(cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true, schemasRemoved: true,
      auditClientClosed: true, fixtureClosed: true, isolatedDirectoryRemoved: true });
  }
});
