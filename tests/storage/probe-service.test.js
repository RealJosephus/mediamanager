import { testFileSystem } from './plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from '../metadata/relations-fixture.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { ProbeService } from '../../src/library/probe-service.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import atlTags from './fixtures/audio-tags/atl.json' with { type: 'json' };
import { taggedWave } from './fixtures/audio-tags/tagged-wave.mjs';

const id = '11111111-1111-1111-1111-111111111111';
function wave(samples = 800) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
async function setup(t, options = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-probe-state-'));
  const schema = `probe_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let database, registry, store, service, library, linkedChildren, itemCreation;
  const contextLoaders = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders, before: [() => service?.close()],
      after: [() => registry?.close(),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        () => database?.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`),
        () => store ? store.close() : database?.close(), () => removeMetadataTestRoot(stateRoot, 'mediamanager-probe-state-')] });
  });
  const source = new SqliteDatabase(':memory:', { create: true });
  const record = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : '']));
  await source.insert('BaseItems', { ...record, Id: id, Name: 'Probe fixture', Path: 'Z:\\isolated\\audio.wav', MediaType: 'Audio', Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Data: '{"UnknownExtension":{"preserve":true,"nullable":null,"precise":9007199254740993}}' });
  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  try {
    await transferDatabase(source, database, { instanceBinding: { serverId: id.replaceAll('-', ''),
      originIdentityDigest: createHash('sha256').update('Isolated synthetic probe service source').digest('hex') } });
  } finally { source.close(); }
  registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('fixture', 'memory', {});
  await adapter.write('/audio.wav', wave());
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/network', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\isolated', accessRoot: '/network', style: 'windows', returnAccess: 'isolated fixture only' });
  store = new DomainStore(database);
  service = new ProbeService({ store, vfs, identityMap, mediaEncoder: await createTestMediaEncoder(t), ...options });
  const attachMetadata = async () => {
    const spoolRoot = path.join(stateRoot, 'metadata-spool');
    linkedChildren = await openMetadataRelations(database, spoolRoot);
    library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'fixture', programDataPath: stateRoot });
    const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap }), contextLoaders);
    itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
    service.library = service.updates.library = library;
    return { library, loadContext };
  };
  return { database, adapter, service, stateRoot, attachMetadata };
}

test('actual network ffprobe persists native streams, version cache and current SQLite export', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0
}, async t => {
  const { database, adapter, service } = await setup(t);
  const first = await service.refresh(id);
  assert.equal(first.changed, true);
  assert.equal(first.sourceConsistency, 'versioned');
  assert.equal((await database.rows('BaseItems'))[0].RunTimeTicks, 1000000n);
  assert.equal((await database.rows('MediaStreamInfos'))[0].Codec, 'pcm_s16le');
  assert.equal(JSON.parse((await database.rows('BaseItems'))[0].Data).UnknownExtension.preserve, true);
  assert.equal(JSON.parse((await database.rows('BaseItems'))[0].Data).UnknownExtension.nullable, null);
  assert.match((await database.rows('BaseItems'))[0].Data, /"precise":9007199254740993/u);
  assert.equal((await service.refresh(id)).reason, 'unchanged-version');
  await adapter.write('/audio.wav', wave(1600));
  assert.equal((await service.refresh(id)).reason, 'source-changed');
  assert.equal((await database.rows('BaseItems'))[0].RunTimeTicks, 2000000n);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probe-return-'));
  try {
    await exportCurrentSqlite(database, path.join(directory, 'current.db'), { testOnlyAllowSyntheticEnvelope: true });
    const current = new SqliteDatabase(path.join(directory, 'current.db'), { readOnly: true });
    try { assert.deepEqual(current.rows('MediaStreamInfos'), await database.rows('MediaStreamInfos')); assert.deepEqual(current.rows('BaseItems'), await database.rows('BaseItems')); }
    finally { current.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test('actual network ffprobe persists its emitted common audio-tag subset', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true }).status !== 0
}, async t => {
  const { database, adapter, service, stateRoot, attachMetadata } = await setup(t);
  await adapter.write('/audio.wav', taggedWave());
  const { library, loadContext } = await attachMetadata();
  service.loadContext = loadContext;
  await service.refresh(id, { force: true });
  const item = (await database.rows('BaseItems', { where: { Id: id } }))[0];
  assert.equal(item.Name, atlTags.Title);
  assert.equal(item.Album, atlTags.Album);
  assert.equal(item.Artists, atlTags.Artist.replaceAll('\u001f', ';'));
  assert.equal(item.AlbumArtists, atlTags.AlbumArtist);
  assert.equal(item.Genres, atlTags.Genre.replaceAll('\u001f', ';'));
  assert.equal(item.IndexNumber, atlTags.TrackNumber);
  assert.equal(item.ParentIndexNumber, atlTags.DiscNumber);
  assert.equal(item.ProductionYear, atlTags.Year);
  assert.match(item.PremiereDate, /^2024-02-29/u);
  assert.equal(item.NormalizationGain, -7.25);
  const providers = Object.fromEntries((await database.rows('BaseItemProviders', { where: { ItemId: id } })).map(row => [row.ProviderId, row.ProviderValue]));
  assert.equal(providers.MusicBrainzRecording, atlTags.AdditionalFields.MUSICBRAINZ_TRACKID);
  assert.equal(providers.MusicBrainzAlbum, atlTags.AdditionalFields.MUSICBRAINZ_ALBUMID);
  const people = await database.rows('Peoples');
  const credits = (await database.rows('PeopleBaseItemMap', { where: { ItemId: id } })).toSorted((left, right) => left.ListOrder - right.ListOrder).map(row => {
    const person = people.find(entry => entry.Id === row.PeopleId);
    return [person.Name, person.PersonType];
  });
  assert.deepEqual(credits, [['Album Artist', 'AlbumArtist'], ['Artist One;Artist Two', 'Artist'], ['Composer One', 'Composer']]);
  const loaded = await service.loadContext(id);
  for (const [name] of credits) {
    const personId = loaded.personIdentity(name).Id;
    const person = (await database.rows('BaseItems', { where: { Id: personId } }))[0];
    assert.equal(person.Type, 'MediaBrowser.Controller.Entities.Person');
    assert.equal(person.Name, name);
    assert.notEqual(person.DateLastSaved, null);
    assert.equal((await stat(library.options.expandPath(person.Path))).isDirectory(), true);
  }
  // ATL preserves ID3v2.4 value boundaries. The pinned ffprobe emits joined
  // semicolon text; with custom delimiters disabled, that text remains exact.
  // This fallback does not claim complete ATL multi-value tag compatibility.
  assert.equal(atlTags.Artist, 'Artist One\u001fArtist Two');
  assert.equal(atlTags.Genre, 'Rock\u001fPop');
});

test('PostgreSQL probe writes return current technical fields to native SQLite', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { database, service } = await setup(t, { probe: async () => ({ raw: { format: { duration: '12', format_name: 'wav' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'flac', channels: 2, sample_rate: '96000', bits_per_raw_sample: '24' }] } }) });
  await service.refresh(id);
  const streams = await database.rows('MediaStreamInfos');
  assert.equal(streams[0].BitDepth, 24);
  assert.equal((await database.rows('BaseItems'))[0].RunTimeTicks, 120000000n);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probe-pg-return-'));
  try {
    await exportCurrentSqlite(database, path.join(directory, 'current.db'), { testOnlyAllowSyntheticEnvelope: true });
    const current = new SqliteDatabase(path.join(directory, 'current.db'), { readOnly: true });
    try { assert.deepEqual(current.rows('MediaStreamInfos'), streams); assert.deepEqual(current.rows('BaseItems'), await database.rows('BaseItems')); }
    finally { current.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test('PostgreSQL probe technical save failure preserves earlier credits and Person commits', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, service, stateRoot, attachMetadata } = await setup(t, { probe: async () => ({ raw: {
    format: { duration: '2', format_name: 'matroska', tags: { title: 'Probe title', 'WM/MediaCredits': 'Committed Actor' } },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'ffv1', width: 32, height: 32 }]
  } }) });
  await database.update('BaseItems', { Id: id }, { MediaType: 'Video', Type: 'MediaBrowser.Controller.Entities.Movies.Movie' });
  const before = (await database.rows('BaseItems', { where: { Id: id } }))[0];
  const events = [];
  const { library, loadContext } = await attachMetadata();
  service.loadContext = loadContext;
  service.updates.on('ItemAdded', event => events.push(event.Item.Name));
  await database.client.query(`CREATE FUNCTION "${database.schemaName}".test_probe_stream_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected probe stream save failure'; END $$`);
  await database.client.query(`CREATE TRIGGER test_probe_stream_failure BEFORE INSERT ON "MediaStreamInfos"
    FOR EACH ROW EXECUTE FUNCTION "${database.schemaName}".test_probe_stream_failure()`);

  await assert.rejects(service.refresh(id, { force: true, replaceAllMetadata: true }), /Injected probe stream save failure/u);
  assert.deepEqual((await database.rows('BaseItems', { where: { Id: id } }))[0], before);
  assert.deepEqual(await database.rows('MediaStreamInfos'), []);
  const loaded = await service.loadContext(id);
  assert.deepEqual(loaded.context.people.map(person => person.Name), ['Committed Actor']);
  const identity = loaded.personIdentity('Committed Actor');
  const person = (await database.rows('BaseItems', { where: { Id: identity.Id } }))[0];
  assert.equal(person.Name, 'Committed Actor');
  assert.notEqual(person.DateLastSaved, null);
  assert.equal((await stat(identity.Path)).isDirectory(), true);
  assert.deepEqual(events, ['Committed Actor', 'Committed Actor']);
});

test('direct probe commits publish immediately while metadata-owned probes transfer one-shot notification ownership', async t => {
  const events = [];
  const library = { reportItemUpdated(...args) { events.push(args); } };
  const { service } = await setup(t, { library, probe: async () => ({ raw: {
    format: { duration: '1', size: '100', format_name: 'wav' },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }]
  } }) });
  await service.refresh(id, { force: true });
  assert.equal(events.length, 1);
  assert.equal(events[0][0].Id, id);
  assert.equal(events[0][0].Type, 'Audio');
  assert.equal(events[0][1], null);
  assert.equal(events[0][2], 2);

  let reportCommitted;
  const loaded = {
    item: (await service.store.run(database => database.rows('BaseItems', { where: { Id: id } })))[0],
    context: { accessPath: '/network/audio.wav' }
  };
  await service.refreshMetadata(loaded, { MetadataRefreshMode: 'FullRefresh' }, {
    onCommitted: report => { reportCommitted = report; }
  });
  assert.equal(events.length, 1, 'metadata refresh owns the committed probe notification');
  assert.equal(typeof reportCommitted, 'function');
  reportCommitted();
  reportCommitted();
  assert.equal(events.length, 2, 'the transferred fallback can publish the commit only once');
});

test('failed or changed probes preserve all previously stored media information', async t => {
  let mode = 'normal';
  let fixture;
  fixture = await setup(t, { probe: async () => {
    if (mode === 'fail') throw new Error('probe failed');
    if (mode === 'changed') await fixture.adapter.write('/audio.wav', wave(1600));
    return { raw: { format: { duration: '1', size: '100', format_name: 'wav' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000', bits_per_sample: 16 }] } };
  } });
  await fixture.service.refresh(id);
  const before = await fixture.database.rows('BaseItems');
  const streams = await fixture.database.rows('MediaStreamInfos');
  mode = 'fail';
  await assert.rejects(fixture.service.refresh(id, { force: true }), /probe failed/);
  mode = 'changed';
  await assert.rejects(fixture.service.refresh(id, { force: true }), { code: 'version-changed' });
  assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  assert.deepEqual(await fixture.database.rows('MediaStreamInfos'), streams);
});

test('embedded subtitle filters retain native stream indexes and validation-only preserves chapters', async t => {
  const raw = { format: { duration: '30', format_name: 'matroska' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
    { index: 3, codec_type: 'audio', codec_name: 'aac' }], chapters: [{ start_time: '0', tags: { title: 'Original' } }] };
  const { database, service, stateRoot, attachMetadata } = await setup(t, { probe: async()=>({raw}) });
  await database.update('BaseItems',{Id:id},{MediaType:'Video',Type:'MediaBrowser.Controller.Entities.Movies.Movie'});
  const { library, loadContext: baseLoad } = await attachMetadata();
  let allowance='AllowAll';
  service.loadContext=Object.assign(async (...args)=>{const loaded=await baseLoad(...args);loaded.libraryOptions={...defaultLibraryOptions(),AllowEmbeddedSubtitles:allowance};return loaded;},baseLoad);
  await service.refresh(id,{force:true});
  for (const [mode,indexes] of [['AllowText',[0,2,3]],['AllowImage',[0,1,3]],['AllowNone',[0,3]]]) {
    allowance=mode;await service.refresh(id,{force:true});
    assert.deepEqual((await database.rows('MediaStreamInfos',{orderBy:[{column:'StreamIndex',direction:'ASC'}]})).map(row=>row.StreamIndex),indexes);
  }
  const before=await database.rows('Chapters');raw.chapters=[{start_time:'10',tags:{title:'Changed'}}];
  await service.refresh(id,{force:true,metadataRefreshMode:'ValidationOnly'});assert.deepEqual(await database.rows('Chapters'),before);
});

test('AudioFileProber explicit ffprobe fallbacks persist title, album, year and track while respecting locks',async t=>{
  const raw={format:{duration:'2',format_name:'flac',tags:{title:'  Fallback title  ',album:'  Album  ',date:'2020',track:'4/9',disc:'2/3',genre:'Unapplied ATL field'}},streams:[{codec_type:'audio',codec_name:'flac',index:0}],chapters:[{start_time:'0',tags:{title:'Book chapter'}}]};
  const { database,service,stateRoot,attachMetadata }=await setup(t,{probe:async()=>({raw})});
  await database.update('BaseItems',{Id:id},{Type:'MediaBrowser.Controller.Entities.AudioBook',Genres:'Keep genre',Data:'bad{'});
  const { library,loadContext }=await attachMetadata();
  service.loadContext=loadContext;
  await service.refresh(id,{force:true});
  let item=(await database.rows('BaseItems',{where:{Id:id}}))[0];
  assert.equal(item.Data,null);
  assert.equal(item.Name,'Fallback title');assert.equal(item.Album,'Album');assert.equal(item.ProductionYear,2020);assert.equal(item.IndexNumber,4);assert.equal(item.ParentIndexNumber,2);assert.equal(item.Genres,'Keep genre');assert.match(item.PremiereDate,/^2020-01-01/u);
  assert.equal((await database.rows('Chapters'))[0].Name,'Book chapter');
  await database.insert('BaseItemMetadataFields',{ItemId:id,Id:5});raw.format.tags.title='Locked replacement';await service.refresh(id,{force:true,replaceAllMetadata:true});
  assert.equal((await database.rows('BaseItems',{where:{Id:id}}))[0].Name,'Fallback title');
  await database.update('BaseItems',{Id:id},{IsLocked:true});raw.format.tags.album='Locked album';raw.format.tags.date='2025';await service.refresh(id,{force:true,replaceAllMetadata:true});
  item=(await database.rows('BaseItems',{where:{Id:id}}))[0];assert.equal(item.Album,'Album');assert.equal(item.ProductionYear,2020);
});

test('transport timestamps use a bounded VFS read and preserve native enum values',async t=>{
  const {database,adapter,service}=await setup(t,{probe:async()=>({raw:{format:{format_name:'mpegts',duration:'1'},streams:[{index:0,codec_type:'video',codec_name:'mpeg2video',width:720,height:480}]}})});
  await database.update('BaseItems',{Id:id},{MediaType:'Video',Type:'MediaBrowser.Controller.Entities.Video'});
  for(const [type,first,sync] of [['None',71,false],['Zero',0,true],['Valid',1,true]]){
    const bytes=Buffer.alloc(197);bytes[0]=first;if(sync){bytes[4]=71;bytes[196]=71;}
    await adapter.write('/audio.wav',bytes);await service.refresh(id,{force:true});
    assert.equal(JSON.parse((await database.rows('BaseItems',{where:{Id:id}}))[0].Data).Timestamp,type);
  }
});
