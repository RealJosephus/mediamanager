import { testFileSystem } from './plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import samples from './fixtures/probe-lifecycle/native.json' with { type: 'json' };
import selection from './fixtures/probe-lifecycle/selection.json' with { type: 'json' };
import { ProbeService } from '../../src/library/probe-service.js';
import { missingProbeInfo, probeFetchDecision, probeFileProtocol, probeFileChanged } from '../../src/storage/probe-lifecycle.js';
import { externalCandidates } from '../../src/storage/external-streams.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { dateTicks, MIN_DATE } from '../../src/library/records.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { probeRaw } from '../../src/storage/ffprobe.js';
import { createApplication } from '../../src/http/application.js';
import { PlaybackService } from '../../src/playback/service.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { makeBlurayFiles } from './fixtures/bluray-disc-info/fixture.js';

const blurayInput = JSON.parse(await readFile(new URL('./fixtures/bluray-disc-info/input.json', import.meta.url)));

const id = '71717171-7171-7171-7171-717171717171';
const identity = 'Z:\\media\\sample.wav';
const date = '2026-09-26T00:00:00.0000000Z';
function wave(samples = 800) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

test('RFC3339 AList timestamps preserve native 100 ns change threshold across offsets', () => {
  const item = { DateModified: date };
  assert.equal(probeFileChanged(item, '2026-09-26T08:00:01.000000099+08:00'), false);
  assert.equal(probeFileChanged(item, '2026-09-26T08:00:01.000000100+08:00'), true);
  assert.equal(probeFileChanged(item, '2026-09-25T23:00:00.999999900-01:00'), false);
});

test('probe change detection, early fetch gates and lyric discovery match actual native methods', async t => {
  for (const { input, expected } of samples) await t.test(input.name, async () => {
    const item = { ...input.item, Id: id, IsFileProtocol: probeFileProtocol(input.item), SupportsLocalMetadata: probeFileProtocol(input.item) && input.item.SourceType !== 'Channel' };
    const vfs = {
      async stat() { if (input.modified == null) throw Object.assign(new Error('Missing fixture file'), { code: 'not-found' }); return { kind: 'file', modified: input.modified }; },
      async list(directory) { return { entries: (directory === '/metadata' ? input.internalFiles ?? [] : input.files ?? []).map(file => ({ name: path.win32.basename(file), kind: 'file' })) }; },
    };
    const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\media', accessRoot: '/media', style: 'windows', returnAccess: 'Synthetic fixture mapped only during isolated tests' });
    const service = new ProbeService({ store: {}, vfs, identityMap, bridge: {} });
    const loaded = { item, context: { accessPath: '/media/' + path.win32.basename(item.Path), externalStreamDirectories: input.internalFiles ? [{ identityPath: 'Z:\\metadata', virtualPath: '/metadata' }] : [] } };
    assert.equal(await service.hasChanged(loaded), expected.changed);
    assert.equal(missingProbeInfo(item), expected.missing);
    assert.equal(probeFetchDecision(item, { EnableRemoteContentProbe: input.remote }) == null ? 'ProberBoundary' : 'None', expected.gate);
    if (expected.lyricStreams != null) {
      const candidates = await externalCandidates(vfs, loaded.context.accessPath, item.Path, { types: ['Lyric'], additionalDirectories: loaded.context.externalStreamDirectories });
      assert.deepEqual(candidates.map((entry, index) => ({ Type: 'Lyric', Path: entry.identityPath, Language: entry.parsed.Language, Index: index + 3, IsExternal: false })), expected.lyricStreams);
    }
    await service.close();
  });
});

async function fixture(t, backend = 'postgres', probe, configuration) {
  const schema = `probe_lifecycle_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let database, source, store, adapters, library, linkedChildren, itemCreation, service, host, directory;
  const contextLoaders = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      before: [() => host?.close(), () => service?.close?.()],
      after: [() => adapters?.close(),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`),
        () => store ? store.close() : database?.close(),
        () => directory && removeMetadataTestRoot(directory, 'probe-lifecycle-state-')] });
  });
  source = new SqliteDatabase(':memory:', { create: true });
  const record = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : '']));
  await source.insert('BaseItems', { ...record, Id: id, Name: 'Locked fixture title', Path: identity, MediaType: 'Audio', Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
    DateModified: date, DateLastRefreshed: date, Data: '{"UnknownExtension":{"precise":9007199254740993}}' });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  try {
    await transferDatabase(source, database, { instanceBinding: { serverId: id.replaceAll('-', ''),
      originIdentityDigest: createHash('sha256').update('Isolated synthetic probe lifecycle source').digest('hex') } });
  } finally { source.close(); }
  adapters = new StorageRegistry(); adapters.registerType('fixture', () => new MemoryStorageAdapter());
  await adapters.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(adapters); vfs.mount({ path: '/media', instanceId: 'fixture', root: '/', capabilities: { create: true, replace: true, delete: true } });
  const adapter = { write: (name, bytes, options) => vfs.write('/media' + name, bytes, options), delete: name => vfs.delete('/media' + name) };
  await adapter.write('/sample.wav', wave());
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\media', accessRoot: '/media', style: 'windows', returnAccess: 'Synthetic fixture mapped only during isolated tests' });
  directory = await mkdtemp(path.join(os.tmpdir(), 'probe-lifecycle-state-'));
  const spoolRoot = path.join(directory, 'metadata-spool');
  linkedChildren = await openMetadataRelations(database, spoolRoot);
  store = new DomainStore(database);
  library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'fixture', programDataPath: directory });
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap, configuration }), contextLoaders);
  itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  service = probe ?? new ProbeService({ store, vfs, identityMap, loadContext, library });
  const registry = new MetadataRegistry();
  host = new MetadataRefreshHost({ registry, store, linkedChildren, vfs, loadContext, probe: service, now: () => date });
  host.updates.library = library;

  return { database, store, adapter, vfs, service, registry, host, loadContext, library };
}

test('DVD directory probe persists first-file media information, summed duration and disc-local external streams', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t, 'postgres', undefined, { DummyChapterDuration: 0 });
  const media = state.vfs.resolve('/media').adapter;
  await media.mkdir('/Disc.Edition'); await media.mkdir('/Disc.Edition/VIDEO_TS');
  const header = Buffer.alloc(197); header[0] = 1; header[4] = 71; header[196] = 71;
  await state.adapter.write('/Disc.Edition/VIDEO_TS/VTS_01_1.VOB', header);
  await state.adapter.write('/Disc.Edition/VIDEO_TS/VTS_02_1.VOB', Buffer.from('second'));
  for (const name of ['Disc.Edition.en.srt', 'Disc.Edition.en.wav', 'Disc.en.srt']) {
    await state.adapter.write('/Disc.Edition/' + name, Buffer.from(name));
  }
  await state.adapter.write('/Disc.Edition.en.srt', Buffer.from('outside the disc'));
  await state.database.update('BaseItems', { Id: id }, {
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: 'Z:\\media\\Disc.Edition',
    Data: JSON.stringify({ VideoType: 'Dvd' })
  });
  const [initial] = await state.database.rows('BaseItems', { where: { Id: id } });
  let laterDuration = '2.5';
  state.service.probe = async (_bridge, source) => {
    if (source.endsWith('/VTS_01_1.VOB')) {
      // Metadata writers may change the directory while its media stays fixed.
      await state.adapter.write('/Disc.Edition/movie.nfo', Buffer.from('<movie/>'));
      return { raw: { format: { duration: '1.25', size: '777', bit_rate: '1000000', format_name: 'mpegts' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480 },
          { index: 1, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'first.ttf' } }],
        chapters: [{ start_time: '0', tags: { title: 'First file chapter' } }] } };
    }
    if (source.endsWith('/VTS_02_1.VOB')) return { raw: {
      format: { duration: laterDuration, size: '888', bit_rate: '2000000', format_name: 'matroska' },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
      chapters: [{ start_time: '1', tags: { title: 'Not imported' } }]
    } };
    if (source === '/media/Disc.Edition/Disc.Edition.en.srt') return { raw: {
      streams: [{ index: 0, codec_type: 'subtitle', codec_name: 'subrip' }]
    } };
    assert.equal(source, '/media/Disc.Edition/Disc.Edition.en.wav');
    return { raw: { format: { duration: '4' }, streams: [
      { index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '8000', channels: 1 }
    ] } };
  };
  const result = await state.service.refresh(id, { force: true });
  assert.equal(result.changed, true); assert.equal(result.sourceConsistency, 'unversioned');
  assert.deepEqual(result.externalStreamFailures, []);
  const [saved] = await state.database.rows('BaseItems', { where: { Id: id } });
  assert.equal(saved.RunTimeTicks, 37500000n); assert.equal(saved.Size, 777n); assert.equal(saved.TotalBitrate, 1000000);
  assert.equal(saved.Width, 720); assert.equal(saved.Height, 480);
  assert.equal(dateTicks(saved.DateModified), dateTicks(initial.DateModified));
  const data = JSON.parse(saved.Data);
  assert.equal(data.VideoType, 'Dvd'); assert.equal(data.Timestamp, 'Valid'); assert.equal(data.Container, 'ts');
  assert.deepEqual(data.SubtitleFiles, ['Z:\\media\\Disc.Edition\\Disc.Edition.en.srt']);
  assert.deepEqual(data.AudioFiles, ['Z:\\media\\Disc.Edition\\Disc.Edition.en.wav']);
  const streams = await state.database.rows('MediaStreamInfos', { where: { ItemId: id }, orderBy: [{ column: 'StreamIndex', direction: 'ASC' }] });
  assert.deepEqual(streams.map(stream => [stream.StreamType, stream.IsExternal, stream.Codec]),
    [[2, true, 'subrip'], [0, true, 'pcm_s16le'], [1, false, 'mpeg2video']]);
  assert.deepEqual((await state.database.rows('AttachmentStreamInfos', { where: { ItemId: id } })).map(row => row.Filename), ['first.ttf']);
  assert.deepEqual((await state.database.rows('Chapters', { where: { ItemId: id } })).map(row => [row.Name, row.StartPositionTicks]),
    [['First file chapter', 0n]]);
  laterDuration = '3.5';
  await state.adapter.write('/Disc.Edition/VIDEO_TS/VTS_02_1.VOB', Buffer.from('new second file'));
  const refreshed = await state.service.refresh(id);
  assert.equal(refreshed.changed, true, 'a stable directory version cannot cache its VOB children');
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 47500000n);
});

test('DVD later-file failure, cancellation and source drift leave persisted media information intact', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t);
  const media = state.vfs.resolve('/media').adapter;
  await media.mkdir('/Disc'); await media.mkdir('/Disc/VIDEO_TS');
  await state.adapter.write('/Disc/VIDEO_TS/VTS_01_1.VOB', Buffer.from('first'));
  await state.adapter.write('/Disc/VIDEO_TS/VTS_02_1.VOB', Buffer.from('second'), { modified: new Date(date) });
  await state.database.update('BaseItems', { Id: id }, {
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: 'Z:\\media\\Disc',
    RunTimeTicks: 123000000n, Width: 320, Height: 240, Data: JSON.stringify({ VideoType: 'Dvd' })
  });
  const tables = ['BaseItems', 'MediaStreamInfos', 'AttachmentStreamInfos', 'Chapters'];
  const snapshot = () => Promise.all(tables.map(table => state.database.rows(table)));
  const before = await snapshot(), capabilities = state.vfs.capabilities.bind(state.vfs);
  const active = new Set(), open = state.vfs.openRead.bind(state.vfs);
  state.vfs.openRead = async (...args) => {
    const handle = await open(...args); active.add(handle);
    return { ...handle, close: async () => { try { await handle.close(); } finally { active.delete(handle); } } };
  };
  for (const mode of ['failure', 'cancel', 'version-change', 'unversioned-change']) await t.test(mode, async () => {
    const controller = new AbortController(), failure = new Error('Second VOB could not be probed.');
    state.vfs.capabilities = source => ({ ...capabilities(source), reliableVersion: mode !== 'unversioned-change' });
    state.service.probe = async (_bridge, source, options) => {
      const handle = await state.vfs.openRead(source, { signal: options.signal });
      try {
        for await (const _ of handle.stream) { /* Consume the real selected VOB. */ }
        if (source.endsWith('/VTS_02_1.VOB')) {
          if (mode === 'failure') throw failure;
          if (mode === 'cancel') controller.abort();
          else await state.adapter.write('/Disc/VIDEO_TS/VTS_02_1.VOB', Buffer.from('other!'), {
            modified: new Date(mode === 'unversioned-change' ? '2026-10-19T00:00:00Z' : date)
          });
        }
        return { raw: { format: { duration: '1', size: '5', format_name: 'mpeg' },
          streams: [{ index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480 }] } };
      } finally { await handle.close(); }
    };
    await assert.rejects(state.service.refresh(id, { force: true, signal: controller.signal }),
      mode === 'failure' ? error => error === failure : { code: mode === 'cancel' ? 'cancelled' : 'version-changed' });
    assert.equal(active.size, 0);
    assert.deepEqual(await snapshot(), before);
    await state.adapter.write('/Disc/VIDEO_TS/VTS_02_1.VOB', Buffer.from('second'), { modified: new Date(date) });
  });
});

async function blurayFixture(t) {
  const state = await fixture(t, 'postgres', undefined, { DummyChapterDuration: 0 });
  const media = state.vfs.resolve('/media').adapter;
  for (const name of ['/Disc', '/Disc/BDMV', '/Disc/BDMV/CLIPINF', '/Disc/BDMV/PLAYLIST', '/Disc/BDMV/STREAM']) await media.mkdir(name);
  const header = Buffer.alloc(197); header[0] = 1; header[4] = 71; header[196] = 71;
  const files = makeBlurayFiles(blurayInput, header);
  for (const [name, bytes] of files) await state.adapter.write('/Disc/' + name, bytes, { modified: new Date(date) });
  await state.database.update('BaseItems', { Id: id }, {
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: 'Z:\\media\\Disc',
    RunTimeTicks: 123000000n, Width: 320, Height: 240, Data: JSON.stringify({ VideoType: 'BluRay' })
  });
  const active = new Set(), open = state.vfs.openRead.bind(state.vfs);
  state.vfs.openRead = async (...args) => {
    const handle = await open(...args); active.add(handle);
    return { ...handle, close: async () => { try { await handle.close(); } finally { active.delete(handle); } } };
  };
  return { ...state, files, active };
}

const blurayFirstRaw = () => ({ format: { duration: '1.25', size: '777', bit_rate: '1000000', format_name: 'mpegts' },
  streams: [{ index: 0, id: '0x1011', codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 576 },
    { index: 1, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'first.ttf' } }],
  chapters: [{ start_time: '0.5', tags: { title: 'Not the playlist chapter' } }] });
const blurayReferenceRaw = channels => ({ format: { duration: '99', size: '888', bit_rate: '2000000', format_name: 'matroska' },
  streams: [{ index: 0, id: '0x1100', codec_type: 'audio', codec_name: 'ac3', channels,
    channel_layout: channels === 6 ? '5.1(side)' : 'stereo', sample_rate: '48000', bit_rate: '448000' },
  { index: 1, id: '0x1011', codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }] });

test('Blu-ray probe persists the playlist with reference audio and first-file scalars, attachments and external subtitles', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await blurayFixture(t);
  await state.adapter.write('/Disc/Disc.en.srt', Buffer.from('disc-local subtitle'));
  await state.adapter.write('/Disc.en.srt', Buffer.from('outside the disc'));
  const [initial] = await state.database.rows('BaseItems', { where: { Id: id } });
  let channels = 6;
  state.service.probe = async (_bridge, source) => {
    if (source.endsWith('/00001.m2ts')) {
      await state.adapter.write('/Disc/movie.nfo', Buffer.from('<movie/>'));
      return { raw: blurayFirstRaw() };
    }
    if (source.endsWith('/00002.m2ts')) return { raw: blurayReferenceRaw(channels) };
    assert.equal(source, '/media/Disc/Disc.en.srt');
    return { raw: { streams: [{ index: 0, codec_type: 'subtitle', codec_name: 'subrip' }] } };
  };
  const result = await state.service.refresh(id, { force: true });
  assert.equal(result.changed, true); assert.equal(result.sourceConsistency, 'unversioned');
  assert.deepEqual(result.externalStreamFailures, []);
  const [saved] = await state.database.rows('BaseItems', { where: { Id: id } });
  assert.equal(saved.RunTimeTicks, 35000000n); assert.equal(saved.Size, 777n); assert.equal(saved.TotalBitrate, 1000000);
  assert.deepEqual([saved.Width, saved.Height], [720, 480]);
  assert.equal(dateTicks(saved.DateModified), dateTicks(initial.DateModified));
  const data = JSON.parse(saved.Data);
  assert.equal(data.VideoType, 'BluRay'); assert.equal(data.Container, 'ts'); assert.equal(data.Timestamp, 'Valid');
  assert.deepEqual(data.SubtitleFiles, ['Z:\\media\\Disc\\Disc.en.srt']);
  const streams = await state.database.rows('MediaStreamInfos', { where: { ItemId: id }, orderBy: [{ column: 'StreamIndex', direction: 'ASC' }] });
  assert.deepEqual(streams.map(stream => [stream.StreamType, stream.IsExternal, stream.Codec]),
    [[2, true, 'subrip'], [1, false, 'mpeg2video'], [1, false, 'mpeg2video'], [0, false, 'AC3'], [2, false, 'pgssub'], [2, false, 'SUB']]);
  assert.deepEqual(streams.filter(stream => stream.StreamType === 1).map(stream => [stream.Width, stream.Height]), [[720, 480], [0, 480]]);
  const audio = streams.find(stream => stream.StreamType === 0);
  assert.deepEqual([audio.Channels, audio.ChannelLayout, audio.SampleRate, audio.BitRate, audio.Language], [6, '5.1', 48000, 448000, 'eng']);
  assert.deepEqual((await state.database.rows('AttachmentStreamInfos', { where: { ItemId: id } })).map(row => row.Filename), ['first.ttf']);
  assert.deepEqual((await state.database.rows('Chapters', { where: { ItemId: id }, orderBy: [{ column: 'ChapterIndex', direction: 'ASC' }] }))
    .map(row => row.StartPositionTicks), [0n, 15000000n]);
  channels = 2;
  await state.adapter.write('/Disc/BDMV/STREAM/00002.m2ts', Buffer.from('changed reference'));
  const repeated = await state.service.refresh(id);
  assert.equal(repeated.changed, true, 'directory revisions do not cache the reference clip');
  assert.equal((await state.database.rows('MediaStreamInfos', { where: { ItemId: id, StreamType: 0 } }))[0].Channels, 2);
  assert.equal(state.active.size, 0);
});

test('Blu-ray metadata or reference failures skip technical saving, while absent playlists, first-file failure, cancellation and drift fail without replacement', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await blurayFixture(t);
  const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
  await state.database.insert('MediaStreamInfos', { ...empty('MediaStreamInfos'), ItemId: id, StreamIndex: 0, StreamType: 1,
    Codec: 'mpeg2video', Width: 320, Height: 240 });
  await state.database.insert('AttachmentStreamInfos', { ...empty('AttachmentStreamInfos'), ItemId: id, Index: 1, Filename: 'stored.ttf' });
  await state.database.insert('Chapters', { ...empty('Chapters'), ItemId: id, ChapterIndex: 0, Name: 'Stored chapter', StartPositionTicks: 0n });
  const tables = ['BaseItems', 'MediaStreamInfos', 'AttachmentStreamInfos', 'Chapters'];
  const snapshot = () => Promise.all(tables.map(table => state.database.rows(table)));
  const before = await snapshot();
  for (const mode of ['malformed', 'no-playlist', 'first-failure', 'reference-failure', 'both-failure', 'same-file-failure', 'cancel', 'source-drift']) await t.test(mode, async () => {
    const controller = new AbortController(), failure = new Error('The selected Blu-ray media could not be probed.');
    if (mode === 'malformed') await state.adapter.write('/Disc/BDMV/CLIPINF/00001.clpi', Buffer.from('bad CLPI'));
    if (mode === 'no-playlist') for (const name of ['00000', '00001']) await state.adapter.delete(`/Disc/BDMV/PLAYLIST/${name}.mpls`);
    if (mode === 'same-file-failure') for (const name of ['00001', '00002']) await state.adapter.delete(`/Disc/BDMV/PLAYLIST/${name}.mpls`);
    state.service.probe = async (_bridge, source, options) => {
      assert.ok(!['malformed', 'no-playlist'].includes(mode), 'unusable disc metadata must not start probing');
      const handle = await state.vfs.openRead(source, { signal: options.signal });
      try {
        for await (const _ of handle.stream) { /* Consume the actual selected file before injecting a boundary failure. */ }
        if (source.endsWith('/00001.m2ts')) {
          if (['first-failure', 'both-failure', 'same-file-failure'].includes(mode)) throw failure;
          return { raw: blurayFirstRaw() };
        }
        assert.ok(source.endsWith('/00002.m2ts'));
        if (mode === 'reference-failure' || mode === 'both-failure') throw failure;
        if (mode === 'cancel') controller.abort();
        if (mode === 'source-drift') await state.adapter.write('/Disc/BDMV/STREAM/00002.m2ts', Buffer.from('changed during probe'));
        return { raw: blurayReferenceRaw(2) };
      } finally { await handle.close(); }
    };
    if (['malformed', 'reference-failure', 'both-failure'].includes(mode)) {
      const loaded = await state.loadContext(id);
      try {
        const result = await state.service.refreshMetadata(loaded, { MetadataRefreshMode: 'FullRefresh', signal: controller.signal });
        assert.equal(result.changed, false); assert.equal(result.UpdateType, ItemUpdateType.MetadataImport);
        assert.equal(result.reason, mode === 'malformed' ? 'bluray-info-unavailable' : 'bluray-reference-unavailable');
      } finally { await loaded.dispose(); }
    } else await assert.rejects(state.service.refresh(id, { force: true, signal: controller.signal }),
      mode.endsWith('failure') ? error => error === failure
        : { code: mode === 'cancel' ? 'cancelled' : mode === 'source-drift' ? 'version-changed' : 'invalid-response' });
    assert.deepEqual(await snapshot(), before); assert.equal(state.active.size, 0);
    for (const [name, bytes] of state.files) await state.adapter.write('/Disc/' + name, bytes, { modified: new Date(date) });
  });
});

test('ISO probe preserves disc classification and does not interpret image bytes as transport timestamps', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t);
  await state.adapter.delete('/sample.wav');
  await state.adapter.write('/sample.img', Buffer.alloc(2048), { modified: date });
  await state.database.update('BaseItems', { Id: id }, {
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: 'Z:\\media\\sample.img',
    DateModified: nativeDate((await state.vfs.stat('/media/sample.img')).modified),
    Data: JSON.stringify({ VideoType: 'Iso', IsoType: 'BluRay' })
  });
  let probes = 0;
  state.service.probe = async (_bridge, source) => {
    assert.equal(source, '/media/sample.img'); probes++;
    return { raw: { format: { duration: '2', size: '2048', format_name: 'mpegts' },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'mpeg2video', width: 720, height: 480,
        r_frame_rate: '25/1', avg_frame_rate: '25/1' }] } };
  };
  const openRead = state.vfs.openRead.bind(state.vfs);
  state.vfs.openRead = (source, options) => {
    assert.notEqual(source, '/media/sample.img', 'ISO transport timestamps must not inspect image headers');
    return openRead(source, options);
  };
  const refreshed = await state.service.refresh(id, { force: true });
  assert.equal(refreshed.changed, true); assert.equal(probes, 1);
  const [stored] = await state.database.rows('BaseItems', { where: { Id: id } });
  const data = JSON.parse(stored.Data);
  assert.equal(data.VideoType, 'Iso'); assert.equal(data.IsoType, 'BluRay'); assert.equal(data.Timestamp ?? null, null);
  assert.equal(stored.RunTimeTicks, 20000000n); assert.equal(stored.Width, 720); assert.equal(stored.Height, 480);
  assert.equal((await state.database.rows('MediaStreamInfos', { where: { ItemId: id } }))[0].Codec, 'mpeg2video');
});

test('Video STRM default refresh preserves technical fields and embedded streams while replacing external data', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t, 'postgres', undefined, { DummyChapterDuration: 0 });
  const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
    .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
  const target = 'rtsp://media.invalid/current-video';
  await state.adapter.delete('/sample.wav');
  await state.adapter.write('/sample.strm', Buffer.from(`# video shortcut\n${target}\n`), { modified: date });
  await state.adapter.write('/sample.en.forced.srt', Buffer.from('1\n00:00:00,000 --> 00:00:00,100\nLocal subtitle\n'));
  await state.database.update('BaseItems', { Id: id }, {
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Path: 'Z:\\media\\sample.strm',
    DateModified: nativeDate((await state.vfs.stat('/media/sample.strm')).modified),
    RunTimeTicks: 250000000n, TotalBitrate: 123456, Width: 640, Height: 360,
    Data: JSON.stringify({ IsShortcut: true, VideoType: 'VideoFile', Container: 'mkv', Timestamp: 'Valid' })
  });
  await state.database.insertBatch('MediaStreamInfos', [
    { ...empty('MediaStreamInfos'), ItemId: id, StreamIndex: 0, StreamType: 1, Codec: 'h264', Width: 640, Height: 360, IsAvc: true },
    { ...empty('MediaStreamInfos'), ItemId: id, StreamIndex: 1, StreamType: 2, Codec: 'subrip' },
    { ...empty('MediaStreamInfos'), ItemId: id, StreamIndex: 2, StreamType: 2, Codec: 'subrip', IsExternal: true, Path: 'Z:\\media\\removed.srt' }
  ]);
  await state.database.insert('AttachmentStreamInfos', { ...empty('AttachmentStreamInfos'), ItemId: id, Index: 3, Filename: 'old.ttf' });
  await state.database.insert('Chapters', { ...empty('Chapters'), ItemId: id, ChapterIndex: 0, Name: 'Stored chapter', StartPositionTicks: 0n });
  const oldChapters = await state.database.rows('Chapters', { where: { ItemId: id } });
  state.service.probe = async (bridge, source, options) => {
    assert.equal(source, '/media/sample.en.forced.srt');
    return probeRaw(bridge, source, options);
  };
  state.service.probeRemote = async () => { throw new Error('Default shortcut refresh must not probe remote media.'); };
  const result = await state.service.refresh(id, { force: true, metadataRefreshMode: 'ValidationOnly' });
  assert.equal(result.changed, true); assert.equal(result.mediaInfo, null);
  assert.deepEqual(result.externalStreamFailures, []);
  const [saved] = await state.database.rows('BaseItems', { where: { Id: id } });
  assert.equal(saved.Name, 'Locked fixture title');
  assert.equal(saved.RunTimeTicks, 250000000n); assert.equal(saved.TotalBitrate, 123456);
  assert.equal(saved.Width, 640); assert.equal(saved.Height, 360);
  const data = JSON.parse(saved.Data);
  assert.equal(data.ShortcutPath, target); assert.equal(data.Container, 'mkv'); assert.equal(data.Timestamp, 'Valid');
  assert.equal(data.DefaultVideoStreamIndex, 1); assert.equal(data.HasSubtitles, true);
  assert.deepEqual(data.SubtitleFiles, ['Z:\\media\\sample.en.forced.srt']);
  const streams = await state.database.rows('MediaStreamInfos', { where: { ItemId: id }, orderBy: [{ column: 'StreamIndex', direction: 'ASC' }] });
  assert.deepEqual(streams.map(stream => [stream.StreamIndex, stream.StreamType, stream.IsExternal, stream.Codec]),
    [[0, 2, true, 'subrip'], [1, 1, false, 'h264'], [2, 2, false, 'subrip']]);
  assert.equal(streams[1].IsAvc, true);
  assert.deepEqual(await state.database.rows('AttachmentStreamInfos', { where: { ItemId: id } }), []);
  assert.deepEqual(await state.database.rows('Chapters', { where: { ItemId: id } }), oldChapters);
  await state.service.refresh(id, { force: true, metadataRefreshMode: 'FullRefresh' });
  assert.deepEqual(await state.database.rows('Chapters', { where: { ItemId: id } }), []);
  assert.equal((await state.library.getItemRecord(id)).ShortcutPath, target);
});

test('refresh host provider selection follows 90 actual MetadataService.GetProviders results', async t => {
  let current, checks = [], fetched = [];
  const monitor = name => { checks.push(name); if (current.change === 'failure') throw new Error('Isolated change-monitor failure'); return current.change.split(',').includes(name); };
  const probe = { supportsMetadata: () => true, hasChanged: async () => monitor('probe'), refreshMetadata: async () => { fetched.push('probe'); return { UpdateType: 1, changed: false }; } };
  const state = await fixture(t, 'postgres', probe);
  await state.database.update('BaseItems', { Id: id }, { MediaType: 'Video', Type: 'MediaBrowser.Controller.Entities.Movies.Movie', RunTimeTicks: 1n });
  for (const kind of ['local', 'remote']) state.registry.register({ id: kind, name: kind, providers: [{ id: kind, name: kind, kind, itemTypes: ['Movie'], hasChanged: () => monitor(kind),
    async getMetadata() { fetched.push(kind); return { HasMetadata: false }; } }] });
  const load = state.host.loadContext;
  const controlledLoad = Object.assign(async (...args) => { const loaded = await load(...args); loaded.libraryOptions.AutomaticRefreshIntervalDays = current.flag === 'requires' ? 1 : 0; return loaded; }, load);
  controlledLoad.withContext = async (reference, options, operation) => {
    const loaded = await controlledLoad(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  state.host.loadContext = controlledLoad;
  state.host.now = () => '2026-09-28T00:00:00Z';
  for (const sample of selection) await t.test(`${sample.mode}/${sample.flag}/${sample.change}`, async () => {
    current = sample; checks = []; fetched = [];
    // The native selection oracle creates a fresh Movie for each row. Previous
    // saves retain a live cache entry, so reload the actual repository fixture.
    state.library.itemCreation.unregisterItem(id);
    await state.library.options.linkedChildren.flushReleases();
    const expectedLastRefresh = sample.flag === 'first' ? MIN_DATE : date;
    await state.database.update('BaseItems', { Id: id }, { DateLastRefreshed: expectedLastRefresh });
    await state.library.itemCreation.withItem(id, item => {
      assert.equal(dateTicks(item.DateLastRefreshed), dateTicks(expectedLastRefresh));
    });
    await state.host.refresh(id, { MetadataRefreshMode: sample.mode, ImageRefreshMode: 'None', ReplaceAllMetadata: sample.flag === 'replace', ForceSave: sample.flag === 'force' });
    assert.deepEqual(checks.toSorted(), sample.checks.toSorted());
    const expected = sample.selected.filter(name => name !== 'remote' || sample.mode !== 'ValidationOnly' || sample.flag === 'replace').sort((a, b) => Number(b === 'probe') - Number(a === 'probe'));
    assert.deepEqual(fetched, expected);
  });
});

test('real ffprobe refresh lifecycle, lyrics, locks and native SQLite return on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0,
}, async t => {
  const backend = 'postgres';
  const state = await fixture(t, backend);
  let probes = 0; state.service.probe = async (...args) => { probes++; return probeRaw(...args); };
  await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]Isolated lyric'));
  await state.host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: true });
  assert.equal(probes, 0); assert.equal((await state.database.rows('MediaStreamInfos')).length, 0);
  assert.equal(await state.loadContext.withContext(id, {}, loaded => state.service.hasChanged(loaded)), true);
  const firstRefresh = await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' });
  assert.equal(firstRefresh.Failures, 0, firstRefresh.ErrorMessage);
  assert.equal(probes, 1);
  let row = (await state.database.rows('BaseItems'))[0];
  assert.equal(row.RunTimeTicks, 1000000n); assert.deepEqual(JSON.parse(row.Data).LyricFiles, ['Z:\\media\\sample.en.lrc']); assert.equal(JSON.parse(row.Data).HasLyrics, true);
  let streams = await state.database.rows('MediaStreamInfos');
  assert.deepEqual(streams.filter(stream => stream.StreamType === 5).map(stream => [stream.StreamIndex, stream.Path, stream.Language, stream.IsExternal]), [[1, 'Z:\\media\\sample.en.lrc', 'eng', false]]);
  await state.host.refresh(id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }); assert.equal(probes, 1);
  await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]Changed lyric bytes, same discovered path'));
  await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' }); assert.equal(probes, 1);
  await state.adapter.write('/sample.txt', Buffer.from('Second external lyric'));
  await state.host.refresh(id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' }); assert.equal(probes, 2);
  assert.equal((await state.database.rows('MediaStreamInfos')).filter(stream => stream.StreamType === 5).length, 1);
  assert.equal(JSON.parse((await state.database.rows('BaseItems'))[0].Data).LyricFiles.length, 2);
  await state.database.update('BaseItems', { Id: id }, { IsLocked: true }); await state.adapter.write('/sample.wav', wave(1600));
  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: true }); assert.equal(probes, 3);
  row = (await state.database.rows('BaseItems'))[0]; streams = await state.database.rows('MediaStreamInfos');
  assert.equal(row.RunTimeTicks, 2000000n); assert.equal(row.Name, 'Locked fixture title');
  assert.equal(Object.hasOwn(JSON.parse(row.Data), 'UnknownExtension'), false, 'typed native JSON drops undeclared extension data');
  if (process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE) {
    const directory = path.resolve(process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE, backend); await mkdir(directory, { recursive: true });
    await exportCurrentSqlite(state.database, path.join(directory, 'with-lyrics.db'), { testOnlyAllowSyntheticEnvelope: true });
    await writeFile(path.join(directory, 'expected.json'), JSON.stringify({ item: { Name: row.Name, Path: row.Path, IsLocked: row.IsLocked, RunTimeTicks: row.RunTimeTicks.toString(),
      Container: JSON.parse(row.Data).Container, LyricFiles: JSON.parse(row.Data).LyricFiles, HasLyrics: JSON.parse(row.Data).HasLyrics }, streams: streams.map(stream => ({ Index: stream.StreamIndex,
      Type: ['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric'][stream.StreamType], Codec: stream.Codec, Path: stream.Path, Language: stream.Language, IsExternal: stream.IsExternal })) }, null, 2));
  }
  await state.adapter.delete('/sample.en.lrc'); await state.adapter.delete('/sample.txt');
  await state.host.refresh(id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }); assert.equal(probes, 4);
  assert.deepEqual(JSON.parse((await state.database.rows('BaseItems'))[0].Data).LyricFiles, []);
  assert.equal((await state.database.rows('MediaStreamInfos')).some(stream => stream.StreamType === 5), false);
  const temporary = !process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE;
  const directory = temporary ? await mkdtemp(path.join(os.tmpdir(), 'probe-lifecycle-return-')) : path.resolve(process.env.MEDIAMANAGER_PROBE_LIFECYCLE_EVIDENCE, backend);
  await mkdir(directory, { recursive: true });
  try {
    await exportCurrentSqlite(state.database, path.join(directory, 'current.db'), { testOnlyAllowSyntheticEnvelope: true });
    const returned = new SqliteDatabase(path.join(directory, 'current.db'), { readOnly: true });
    try { assert.deepEqual(returned.rows('BaseItems'), await state.database.rows('BaseItems')); assert.deepEqual(returned.rows('MediaStreamInfos'), await state.database.rows('MediaStreamInfos')); }
    finally { await returned.close(); }
  } finally { if (temporary) await rm(directory, { recursive: true }); }
});

test('Audio STRM refresh stores the target without probing and explicit playback refresh probes the remote audio', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t);
  const shortcut = 'Z:\\media\\sample.strm';
  let payload = wave(), requests = 0;
  const upstream = createServer((request, response) => {
    requests++;
    const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
    if (start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` }); response.end(); return;
    }
    const bytes = payload.subarray(start, end + 1);
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(bytes.length),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {})
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}/audio.wav`;
  await state.database.update('BaseItems', { Id: id }, { Path: shortcut, Data: JSON.stringify({ IsShortcut: true }) });
  await state.adapter.write('/sample.strm', Buffer.from(`\uFEFF# a remote audio source\r\n \t${target}\t \r\nhttps://unused.invalid/second.wav`));
  state.service.probe = async () => { throw new Error('A shortcut file must not be sent to the local media prober.'); };
  const options = { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' };
  const readItem = async () => (await state.database.rows('BaseItems', { where: { Id: id } }))[0];
  const refresh = async extra => {
    const result = await state.host.refresh(id, { ...options, ...extra });
    assert.equal(result.Failures, 0, result.ErrorMessage);
    return readItem();
  };
  let row = await refresh();
  assert.equal(JSON.parse(row.Data).ShortcutPath, target);
  assert.equal(row.RunTimeTicks, null);
  assert.deepEqual(await state.database.rows('MediaStreamInfos', { where: { ItemId: id } }), []);
  assert.equal(requests, 0, 'ordinary metadata refresh never contacts the remote target');
  const [source] = await state.library.getMediaSources(id);
  assert.equal(source.Protocol, 'File'); assert.equal(source.Path, shortcut); assert.equal(source.IsRemote, false);

  for (const invalid of ['# no target\r\n \t', 'file:///private/audio.wav', `../audio.wav\n${target}`]) {
    await state.adapter.write('/sample.strm', Buffer.from(invalid));
    row = await refresh();
    assert.equal(JSON.parse(row.Data).ShortcutPath, target, 'empty or invalid first lines preserve the saved target');
    assert.equal(requests, 0);
  }
  await state.adapter.write('/sample.strm', Buffer.from(target));
  await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]Remote audio lyric'));
  row = await refresh({ EnableRemoteContentProbe: true });
  assert.equal(row.RunTimeTicks, 1000000n);
  assert.equal(JSON.parse(row.Data).Container, 'wav');
  assert.equal(JSON.parse(row.Data).ShortcutPath, target);
  let streams = await state.database.rows('MediaStreamInfos', { where: { ItemId: id } });
  assert.equal(streams.find(stream => stream.StreamType === 0)?.Codec, 'pcm_s16le');
  assert.equal(streams.find(stream => stream.StreamType === 5)?.Path, 'Z:\\media\\sample.en.lrc');
  assert.ok(requests > 0, 'explicit remote probing read the real HTTP audio');

  const requestsBeforeDefault = requests;
  payload = wave(1600);
  row = await refresh();
  assert.equal(row.RunTimeTicks, 1000000n);
  assert.deepEqual(await state.database.rows('MediaStreamInfos', { where: { ItemId: id } }), streams);
  assert.equal(requests, requestsBeforeDefault);
  const playback = new PlaybackService({ library: state.library, probe: state.service });
  await playback.sources(await state.library.getItemRecord(id));
  assert.equal((await readItem()).RunTimeTicks, 2000000n,
    'playback probes a shortcut again even when a saved audio stream already exists');
  assert.equal(JSON.parse((await readItem()).Data).ShortcutPath, target);
});

test('Audio shortcut probe failure preserves the read target while cancellation prevents the final target save', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const state = await fixture(t);
  await state.database.update('BaseItems', { Id: id }, {
    Path: 'Z:\\media\\sample.strm', Data: JSON.stringify({ IsShortcut: true }),
    PresentationUniqueKey: id.replaceAll('-', '')
  });
  const target = 'https://media.invalid/failed-audio.wav';
  await state.adapter.write('/sample.strm', Buffer.from(target));
  const options = { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', EnableRemoteContentProbe: true };
  state.service.probeRemote = async url => {
    assert.equal(url, target);
    throw new Error('Isolated remote audio probe failure');
  };
  const failed = await state.host.refresh(id, options);
  assert.equal(failed.Failures, 1); assert.equal(failed.ErrorMessage, 'Isolated remote audio probe failure');
  const before = await state.database.rows('BaseItems', { where: { Id: id } });
  assert.equal(JSON.parse(before[0].Data).ShortcutPath, target);
  assert.equal(before[0].RunTimeTicks, null);
  assert.deepEqual(await state.database.rows('MediaStreamInfos', { where: { ItemId: id } }), []);

  await state.adapter.write('/sample.strm', Buffer.from('https://media.invalid/cancelled-audio.wav'));
  let started;
  const running = new Promise(resolve => { started = resolve; });
  state.service.probeRemote = async (_url, { signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = state.host.refresh(id, { ...options, signal: controller.signal });
  await running; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'cancelled');
  assert.deepEqual(await state.database.rows('BaseItems', { where: { Id: id } }), before);
  assert.deepEqual(await state.database.rows('MediaStreamInfos', { where: { ItemId: id } }), []);
});

test('probe failure retains the native file-date save, later cancellation rolls back and refresh remains usable', async t => {
  const state = await fixture(t);
  // The correct native key isolates key changes. File-date metadata imports
  // remain independent of the probe transaction and survive probe failure.
  await state.database.update('BaseItems', { Id: id }, { PresentationUniqueKey: id.replaceAll('-', '').toLowerCase() });
  state.service.probe = async () => { throw new Error('Isolated probe failure'); };
  const failed = await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(failed.Failures, 1); assert.equal(failed.ErrorMessage, 'Isolated probe failure');
  assert.equal(failed.UpdateType, ItemUpdateType.None | ItemUpdateType.MetadataImport);
  const before = await state.database.rows('BaseItems');
  // The fixture file has no timestamp. Native FileSystemMetadata exposes
  // MinValue, so Audio BeforeSave independently imports the changed date.
  assert.equal(before[0].DateModified, null); assert.equal(before[0].DateLastSaved, '2026-09-26 00:00:00');
  assert.equal((await state.database.rows('BaseItems'))[0].RunTimeTicks, null); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  let started;
  const running = new Promise(resolve => { started = resolve; });
  state.service.probe = async (_bridge, _path, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const controller = new AbortController();
  const refresh = state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal });
  await running; controller.abort(); await assert.rejects(refresh, { name: 'AbortError' });
  assert.deepEqual(await state.database.rows('BaseItems'), before); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  state.service.probe = probeRaw;
  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal((await state.database.rows('BaseItems'))[0].RunTimeTicks, 1000000n);
});

test('metadata refresh reports one committed probe update on success and after a later cancellation', async t => {
  const state = await fixture(t);
  const events = [];
  state.library.on('ItemUpdated', event => events.push(event));
  state.service.probe = async () => ({ raw: {
    format: { duration: '1', size: '1644', format_name: 'wav' },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
  } });

  await state.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
  assert.equal(events.length, 1, 'the final metadata update owns the successful notification');
  assert.equal(events[0].Item.Id, id);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);

  events.length = 0;
  await state.adapter.write('/sample.wav', wave(1600));
  state.service.probe = async () => ({ raw: {
    format: { duration: '2', size: '3244', format_name: 'wav' },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
  } });
  const controller = new AbortController();
  const refreshMetadata = state.service.refreshMetadata.bind(state.service);
  state.service.refreshMetadata = async (...args) => {
    const result = await refreshMetadata(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(state.host.refresh(id, {
    MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal
  }), error => error.name === 'AbortError' || error.code === 'cancelled');
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 20000000n,
    'the probe transaction committed before the later cancellation');
  assert.equal(events.length, 1, 'the committed probe falls back to its own update notification');
  assert.equal(events[0].Item.Id, id);
});

test('a failing probe fallback reporter cannot replace the final persistence error', async t => {
  const state = await fixture(t);
  const conflict = Object.assign(new Error('Injected final persistence conflict'), { status: 409 });
  const reportingFailure = new Error('Injected fallback reporting failure');
  const logged = [];
  let fallbackCalls = 0;
  state.host.logger = {
    error(error, message) {
      logged.push([error, message]);
      throw new Error('Injected logger failure');
    }
  };
  state.host.probe = {
    supportsMetadata: () => true,
    async refreshMetadata(_loaded, _options, { onCommitted }) {
      onCommitted(() => { fallbackCalls++; throw reportingFailure; });
      return { changed: true, UpdateType: 2 };
    }
  };
  state.host.updates.update = async () => { throw conflict; };

  await assert.rejects(state.host.refresh(id, {
    MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None'
  }), error => error === conflict);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(logged, [[reportingFailure, 'Error reporting committed probe update']]);
});

test('cancelling a queued probe waiter is prompt and does not cancel the shared owner or later waiter', async t => {
  const state = await fixture(t);
  let started, release;
  const ownerStarted = new Promise(resolve => { started = resolve; });
  const ownerRelease = new Promise(resolve => { release = resolve; });
  let probes = 0;
  state.service.probe = async () => {
    probes++;
    started();
    await ownerRelease;
    return { raw: { format: { duration: '1', size: '1644', format_name: 'wav' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }] } };
  };
  const owner = state.service.refresh(id, { force: true });
  await ownerStarted;
  const controller = new AbortController();
  const cancelled = state.service.refresh(id, { force: true, signal: controller.signal });
  const later = state.service.refresh(id);
  controller.abort();
  let timeout;
  const outcome = await Promise.race([
    cancelled.then(() => 'resolved', error => error.code),
    new Promise(resolve => { timeout = setTimeout(resolve, 500, 'timeout'); timeout.unref(); }),
  ]);
  clearTimeout(timeout);
  release();
  const [ownerResult, laterResult] = await Promise.all([owner, later]);
  assert.equal(outcome, 'cancelled');
  assert.equal(ownerResult.changed, true);
  assert.equal(laterResult.reason, 'unchanged-version');
  assert.equal(probes, 1);
});

test('probe shutdown cancels active and queued refreshes before persistence', async t => {
  const state = await fixture(t);
  const before = await state.database.rows('BaseItems');
  let started; const running = new Promise(resolve => { started = resolve; });
  state.service.probe = async (_bridge, _path, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const first = state.service.refresh(id), second = state.service.refresh(id);
  const settled = Promise.allSettled([first, second]);
  await running; await state.service.close();
  for (const result of await settled) { assert.equal(result.status, 'rejected'); assert.match(result.reason.name, /Abort|Storage/u); }
  assert.deepEqual(await state.database.rows('BaseItems'), before); assert.deepEqual(await state.database.rows('MediaStreamInfos'), []);
  await assert.rejects(state.service.refresh(id), { name: 'AbortError' });
});

test('queued Refresh HTTP drives real VFS probe lifecycle on PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0,
}, async t => {
  const state = await fixture(t), errors = [];
  let probes = 0; state.service.probe = async (...args) => { probes++; return probeRaw(...args); };
  const application = await createApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, library: state.library, metadata: state.host,
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true }), authorize(_auth, { policy }) { assert.equal(policy, 'RequiresElevation'); } }, onError: error => errors.push(error) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  try {
    for (const [mode, expectedProbes] of [['None', 0], ['FullRefresh', 1], ['Default', 1], ['ValidationOnly', 2]]) {
      if (mode === 'ValidationOnly') await state.adapter.write('/sample.en.lrc', Buffer.from('[00:00.00]HTTP fixture lyric'));
      const response = await fetch(`${origin}/Items/${id.replaceAll('-', '')}/Refresh?metadataRefreshMode=${mode}`, { method: 'POST' });
      assert.equal(response.status, 204, await response.text()); await state.host.drain(); assert.equal(probes, expectedProbes, mode);
    }
    const streams = await state.database.rows('MediaStreamInfos'); assert.equal(streams.length, 2); assert.equal(streams.find(row => row.StreamType === 5).Language, 'eng');
    assert.deepEqual(errors, []);
  } finally { await new Promise(resolve => application.server.close(resolve)); }
});

async function observeProbeContextRelease(state, { cleanupFailure = false } = {}) {
  const load = state.service.loadContext;
  const releases = [];
  state.service.loadContext = Object.assign(async (...args) => {
    const loaded = await load(...args), dispose = loaded.dispose.bind(loaded);
    loaded.dispose = async () => {
      await dispose(); releases.push(loaded.item.Id);
      if (cleanupFailure) await state.database.client.query('SELECT 1/0');
    };
    return loaded;
  }, load);
  const sets = () => state.library.options.linkedChildren.relationDatabase.withConnection(async database =>
    BigInt((await database.client.query('SELECT count(*)::text AS count FROM ' + state.library.options.linkedChildren.sets)).rows[0].count));
  return { releases, sets };
}

const releasedProbeInfo = () => ({ raw: {
  format: { duration: '1', size: '1644', format_name: 'wav' },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
} });

test('direct probe closes an actual Folder context before its not-probeable early return', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state);
  await state.database.update('BaseItems', { Id: id }, { Type: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true });
  const before = await ownership.sets();
  assert.deepEqual(await state.service.refresh(id, { force: true }), { changed: false, reason: 'not-probeable' });
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe closes its native-fields-present context without invoking the prober', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state);
  await state.database.update('BaseItems', { Id: id }, { RunTimeTicks: 1n, TotalBitrate: 1 });
  state.service.probe = async () => { throw new Error('Native fields should skip probing.'); };
  assert.deepEqual(await state.service.refresh(id), { changed: false, reason: 'native-fields-present' });
  assert.deepEqual(ownership.releases, [id]);
});

test('direct probe success and its cached early return each release their operation context', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state), before = await ownership.sets();
  let probes = 0;
  state.service.probe = async () => { probes++; return releasedProbeInfo(); };
  assert.equal((await state.service.refresh(id, { force: true })).changed, true);
  assert.equal((await state.service.refresh(id)).reason, 'unchanged-version');
  assert.equal(probes, 1);
  assert.deepEqual(ownership.releases, [id, id]);
  assert.equal(await ownership.sets(), before);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);
});

test('direct probe preserves a failure identity while releasing its operation context', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state), before = await ownership.sets();
  const failure = new Error('Exact direct probe failure.');
  state.service.probe = async () => { throw failure; };
  await assert.rejects(state.service.refresh(id, { force: true }), error => error === failure);
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe retains its primary failure and the actual SQL cleanup failure', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state, { cleanupFailure: true }), before = await ownership.sets();
  const failure = new Error('Primary direct probe failure.');
  state.service.probe = async () => { throw failure; };
  await assert.rejects(state.service.refresh(id, { force: true }), error => error instanceof AggregateError &&
    error.cause === failure && error.errors.length === 2 && error.errors[0] === failure && error.errors[1].code === '22012');
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
});

test('direct probe propagates a cleanup failure after retaining its committed success', async t => {
  const state = await fixture(t), ownership = await observeProbeContextRelease(state, { cleanupFailure: true }), before = await ownership.sets();
  state.service.probe = async () => releasedProbeInfo();
  await assert.rejects(state.service.refresh(id, { force: true }), { code: '22012' });
  assert.deepEqual(ownership.releases, [id]);
  assert.equal(await ownership.sets(), before);
  assert.equal((await state.database.rows('BaseItems', { where: { Id: id } }))[0].RunTimeTicks, 10000000n);
});
