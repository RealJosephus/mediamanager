import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from './relations-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { UserDataService } from '../../src/sessions/user-data.js';
import { MetadataRegistry, MetadataSaveHost, MetadataRefreshHost, createMetadataContextLoader } from '../../src/metadata/index.js';
import { activate as activateNfo } from '../../plugins/nfo/index.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { onMetadataChanged } from '../../src/metadata/metadata-changed.js';
import { nativePersonIdentity } from '../../src/library/metadata-context.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { cloneNativeItemEntity } from '../../src/library/native-item-entity.js';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { applyNfoUserData } from '../../plugins/nfo/user-data-import.js';
import { nativeDate, dtoDate } from '../../src/sessions/user-data.js';

const ids = Object.fromEntries(['folder', 'collection', 'movie', 'series', 'season', 'episode', 'user', 'otherUser', 'actor', 'credit', 'root', 'userRoot'].map((key, i) => [key, `D1111111-1111-1111-1111-${String(i + 1).padStart(12, '0')}`]));
ids.actor = nativePersonIdentity('Actor', { programDataPath: 'Z:\\FixtureState' }).Id;
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const record = (id, type, values) => ({ ...empty('BaseItems'), Id: id, Type: `MediaBrowser.Controller.Entities.${type}`, Name: type, Data: '{}', ...values });
const bytes = async (vfs, path) => { const handle = await vfs.openRead(path); try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); } finally { await handle.close(); } };

for (const postgres of [true]) test('native PostgreSQL image dimensions and internal Person artwork persist without a media filesystem fallback', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { db, store, adapter, refresh, loadContext, library, vfs, identityMap, linkedChildren, spoolRoot, contextLoaders } = await setup(t, postgres);
  const original = await readFile(new URL('../images/fixtures/processor/original-http.png', import.meta.url));
  await adapter.write('/movie-poster.png', original);
  await refresh.refresh(ids.movie, { MetadataRefreshMode: 'None', ImageRefreshMode: 'ValidationOnly' });
  const row = (await db.rows('BaseItemImageInfos', { where: { ItemId: ids.movie } }))[0];
  assert.equal(row.Width, 1); assert.equal(row.Height, 1); assert.deepEqual(row.Blurhash, Buffer.alloc(0));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'person-image-state-')); t.after(() => rm(directory, { recursive: true, force: true }));
  library.options.metadataPath = directory;
  // Keep this controlled metadata-root change and the library expander aligned.
  library.options.expandPath = createVirtualPathExpander(library.options);
  await db.update('BaseItems', { Id: ids.actor }, { Path: path.join(directory, 'People', 'A', 'Actor'), IsFolder: false });
  const loadPerson = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap }), contextLoaders);
  const loaded = await loadPerson(ids.actor); assert.equal(loaded.context.accessPath, undefined); assert.equal(loaded.saveLocalMetadataEnabled, true);
  const manager = new MetadataImages({ fetch: async () => new Response(original, { headers: { 'content-type': 'image/png' } }) });
  const images = [];
  await manager.saveRemote(loaded, images, { Type: 'Primary', Url: 'https://isolated.invalid/person.png' });
  assert.equal(images[0].Path, path.join(directory, 'People', 'A', 'Actor', 'folder.png'));
  await manager.updateImages(loaded, images); await persistMetadata(store, loaded, { Item: loaded.item, Images: images });
  const after = await loadPerson(ids.actor); assert.equal(after.context.images[0].Width, 1); assert.equal(after.context.images[0].Height, 1);
  assert.deepEqual(await after.imageAssets.read(after.context.images[0].Path), original);
  await db.update('BaseItems', { Id: ids.movie }, { Path: path.join(directory, 'unmapped-movie.mkv') });
  await assert.rejects(loadPerson(ids.movie), error => error.code === 'not-found');
});

async function setup(t, postgres = true, configuration = {}) {
  const schema = `metadata_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(db);
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Fixture', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated test source' });
  const nfoConfiguration = { UserId: ids.user, SaveImagePathsInNfo: true };
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-runtime-state-'));
  const libraryOptions = new Map([[ids.collection.replaceAll('-', '').toLowerCase(), { SaveLocalMetadata: true, MetadataSavers: ['Nfo'], PreferredMetadataLanguage: 'fr', MetadataCountryCode: 'FR' }]]);
  const spoolRoot = path.join(stateRoot, 'metadata-spool'), contextLoaders = [];
  const linkedChildren = await openMetadataRelations(db, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'metadata-test',
    userRoot: { Id: ids.userRoot }, libraryOptions, programDataPath: stateRoot });
  const extensions=[];
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap, configuration: { PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US', ...configuration }, contextExtensions:()=>extensions }), contextLoaders);
  const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  const userData = new UserDataService({ store });
  const registry = new MetadataRegistry();
  const plugin=await activateNfo({paths:{},configuration:nfoConfiguration,logger:{},register(kind,value){
    if(kind==='metadata')registry.register(value);else if(kind==='context')extensions.push(value);
  }});
  await plugin.connect({metadata:{},metadataVfs:vfs,store,userData,spoolRoot,fileSystem:testFileSystem});
  const errors = []; const logger = { error: error => errors.push(error.message) };
  const saver = new MetadataSaveHost({ registry, loadContext, logger });
  const refresh = new MetadataRefreshHost({ registry, loadContext, store, linkedChildren, vfs, userData, logger, now: () => '2026-09-26T12:00:00Z' });
  saver.start(userData);
  t.after(() => closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
    before: [() => refresh.close(), () => saver.dispose()], after: [() => storage.close(),
      () => db.client.query(`DROP SCHEMA "${schema}" CASCADE`), () => db.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`),
      () => store.close(), () => removeMetadataTestRoot(stateRoot, 'metadata-runtime-state-')] }));
  for (const [key, name] of [['user', 'Configured'], ['otherUser', 'Event user']]) await db.insert('Users', { ...empty('Users'), Id: ids[key], Username: name, NormalizedUsername: name.toUpperCase(), InternalId: key === 'user' ? 1 : 2 });
  // Native library membership uses the real ParentId root and persisted paths;
  // PhysicalFolderIds is a separate query relation and does not select options.
  await db.insert('BaseItems', record(ids.root, 'AggregateFolder', { IsFolder: true }));
  await db.insert('BaseItems', record(ids.userRoot, 'UserRootFolder', { IsFolder: true }));
  await db.insert('BaseItems', record(ids.folder, 'Folder', { Path: 'Z:\\Fixture', ParentId: ids.root, IsFolder: true }));
  await db.insert('BaseItems', record(ids.collection, 'CollectionFolder', { IsFolder: true, ParentId: ids.userRoot, PreferredMetadataLanguage: 'es',
    Data: JSON.stringify({ PhysicalFolderIds: [ids.folder], PhysicalLocationsList: ['Z:\\Fixture'] }) }));
  await db.insert('BaseItems', record(ids.movie, 'Movies.Movie', { Name: 'Stored title', Path: 'Z:\\Fixture\\movie.mkv', ParentId: ids.folder, TopParentId: ids.folder, MediaType: 'Video',
    RunTimeTicks: 9007199254740993n, ProductionYear: 2000, Overview: 'Stored overview', IsInMixedFolder: true, DateCreated: '2020-01-01 00:00:00', Data: '{"VideoType":"VideoFile","Extension":{"precision":9007199254740993}}' }));
  await db.insert('BaseItems', record(ids.series, 'TV.Series', { Name: 'Series', Path: 'Z:\\Fixture\\Series', ParentId: ids.folder, TopParentId: ids.folder, IsFolder: true, PreferredMetadataLanguage: 'ja', Data: '{"DisplayOrder":"DVD"}' }));
  await db.insert('BaseItems', record(ids.season, 'TV.Season', { Name: 'Season', Path: 'Z:\\Fixture\\Series\\Season 2', ParentId: ids.series, TopParentId: ids.folder, SeriesId: ids.series, IsFolder: true, IndexNumber: 2 }));
  await db.insert('BaseItems', record(ids.episode, 'TV.Episode', { Name: 'Episode', Path: 'Z:\\Fixture\\Series\\Season 2\\ep.mkv', ParentId: ids.season, TopParentId: ids.folder, SeasonId: ids.season, SeriesId: ids.series, IndexNumber: 3, ParentIndexNumber: 2, MediaType: 'Video' }));
  await db.insert('BaseItems', record(ids.actor, 'Person', { Name: 'Actor', Path: 'Z:\\Fixture\\actor', Data: '{}' }));
  for (const [id, value] of [[ids.movie, '11'], [ids.series, '12'], [ids.season, '13'], [ids.actor, '14']]) await db.insert('BaseItemProviders', { ItemId: id, ProviderId: 'Tmdb', ProviderValue: value });
  await db.insert('Peoples', { Id: ids.credit, Name: 'Actor', PersonType: 'Actor' });
  await db.insert('PeopleBaseItemMap', { ItemId: ids.movie, PeopleId: ids.credit, Role: 'Lead', SortOrder: 1, ListOrder: 0 });
  await db.insert('MediaStreamInfos', { ...empty('MediaStreamInfos'), ItemId: ids.movie, StreamIndex: 0, StreamType: 1, Codec: 'h264', IsDefault: true, AverageFrameRate: 24 });
  await db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), ItemId: ids.movie, Path: 'Z:\\Fixture\\poster.jpg', ImageType: 0, Width: 300, Height: 400 });
  await adapter.write('/movie.mkv', Buffer.from('fixture'));
  return { db, store, vfs, identityMap, library, adapter, loadContext, registry, saver, refresh, userData, errors, stateRoot, linkedChildren, spoolRoot, contextLoaders };
}

for (const postgres of [true]) test('native PostgreSQL MetadataSaveHost substitutes NFO artwork paths and skips identical writes', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const fixture = await setup(t, postgres, { PathSubstitutions: [{ From: 'Z:\\Fixture', To: '/kodi/media' }] });
  await fixture.db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: 'D1111111-1111-1111-1111-000000000201', ItemId: ids.movie, Path: 'Z:\\Fixture\\fanart.jpg', ImageType: 2, Width: 1920, Height: 1080 });
  await fixture.db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: 'D1111111-1111-1111-1111-000000000202', ItemId: ids.actor, Path: 'Z:\\Fixture\\people\\actor.jpg', ImageType: 0, Width: 300, Height: 450 });
  let nfoWrites = 0; const write = fixture.adapter.write.bind(fixture.adapter);
  fixture.adapter.write = async (pathname, data, options) => { if (pathname.endsWith('.nfo')) nfoWrites++; return write(pathname, data, options); };
  const first = await fixture.saver.save({ Id: ids.movie }, 'MetadataDownload', ['Nfo']);
  const second = await fixture.saver.save({ Id: ids.movie }, 'MetadataDownload', ['Nfo']);
  assert.equal(first[0].result.changed, true); assert.equal(second[0].result.changed, false); assert.equal(nfoWrites, 1);
  const nfo = await bytes(fixture.vfs, '/fixture/movie.nfo');
  assert.match(nfo, /<poster>\/kodi\/media\\poster\.jpg<\/poster>/);
  assert.match(nfo, /<fanart>\/kodi\/media\\fanart\.jpg<\/fanart>/);
  assert.match(nfo, /<thumb>\/kodi\/media\\people\\actor\.jpg<\/thumb>/);
  const context = (await fixture.loadContext(ids.movie)).context;
  assert.deepEqual(context.images.map(image => image.Path).sort(), ['Z:\\Fixture\\fanart.jpg', 'Z:\\Fixture\\poster.jpg']);
  assert.equal(context.people[0].ImagePath, 'Z:\\Fixture\\people\\actor.jpg');
});

for (const postgres of [true]) test('native PostgreSQL metadata context, real user event and refresh transaction', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { db, store, vfs, adapter, loadContext, saver, refresh, userData, errors } = await setup(t, postgres);
  const loaded = await loadContext(ids.movie);
  assert.equal(loaded.item.MetadataLanguage, 'es'); assert.equal(loaded.item.MetadataCountryCode, 'FR');
  assert.equal(loaded.context.accessPath, '/fixture/movie.mkv'); assert.equal(loaded.context.people[0].ProviderIds.Tmdb, '14');
  assert.equal(loaded.context.mediaStreams[0].Codec, 'h264'); assert.equal(loaded.context.images[0].Path, 'Z:\\Fixture\\poster.jpg');
  await db.update('BaseItems', { Id: ids.series }, { OfficialRating: 'TV-MA' });
  const episode = await loadContext(ids.episode);
  assert.equal(episode.lookup.MetadataLanguage, 'ja'); assert.equal(episode.lookup.SeriesDisplayOrder, 'DVD');
  assert.equal(episode.lookup.SeriesProviderIds.Tmdb, '12'); assert.equal(episode.lookup.SeasonProviderIds.Tmdb, '13');
  onMetadataChanged(episode.item, await episode.parentalRating(episode.item));
  await persistMetadata(store, episode, { Item: episode.item });
  const episodeRow = (await db.rows('BaseItems', { where: { Id: ids.episode } }))[0];
  assert.equal(episodeRow.InheritedParentalRatingValue, 17); assert.equal(episodeRow.InheritedParentalRatingSubValue, 1);
  await userData.update(ids.user, ids.movie, { PlayCount: 7, PlaybackPositionTicks: 123000000n }); await saver.drain();
  await assert.rejects(vfs.stat('/fixture/movie.nfo'), { code: 'not-found' }, 'UpdateUserData is not an NFO saver reason');
  await userData.setFavorite(ids.user, ids.movie, true); await saver.drain();
  const saved = await bytes(vfs, '/fixture/movie.nfo');
  assert.match(saved, /<playcount>7<\/playcount>/); assert.match(saved, /<name>Actor<\/name>/); assert.match(saved, /<codec>h264<\/codec>/);
  await userData.update(ids.otherUser, ids.movie, { PlayCount: 99 });
  await userData.setFavorite(ids.otherUser, ids.movie, true); await saver.drain();
  assert.match(await bytes(vfs, '/fixture/movie.nfo'), /<playcount>7<\/playcount>/);
  await db.insert('BaseItemMetadataFields', { ItemId: ids.movie, Id: 5 });
  await adapter.write('/movie.nfo', Buffer.from('<movie><title>Imported title</title><plot>Imported overview</plot><year>2024</year><runtime>5</runtime><genre>Drama</genre><actor><name>New actor</name><role>Novel</role><type>Writer</type></actor><tmdbid>22</tmdbid></movie>'));
  const result = await refresh.refresh(ids.movie, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
  assert.equal(result.changed, true); assert.equal(result.Failures, 0);
  const after = await loadContext(ids.movie);
  assert.equal(after.item.Name, 'Stored title'); assert.equal(after.item.Overview, 'Imported overview'); assert.equal(after.item.ProductionYear, 2024);
  assert.equal(after.item.RunTimeTicks, 9007199254740993n); assert.equal(after.item.ProviderIds.Tmdb, '22');
  assert.deepEqual(after.item.Genres, ['Drama']); assert.equal(after.context.people[0].Name, 'New actor');
  const savedMovie = (await db.rows('BaseItems', { where: { Id: ids.movie } }))[0];
  assert.doesNotMatch(savedMovie.Data, /"Extension"|"precision"/u, 'typed SaveItems drops unknown JSON properties');
  assert.equal(savedMovie.RunTimeTicks, 9007199254740993n, 'declared Int64 column remains lossless');
  assert.equal((await db.rows('ItemValues')).some(value => value.Type === 2 && value.Value === 'Drama'), true);
  // The independent BaseItem owned-image wrapper inspects the deliberately
  // missing outdated poster before the single-item image validation removes it.
  assert.deepEqual(errors, ['The storage object does not exist.']);
  if (process.env.MEDIAMANAGER_METADATA_EVIDENCE) await writeFile(path.join(process.env.MEDIAMANAGER_METADATA_EVIDENCE, 'postgres-state.json'), JSON.stringify({
    Item: after.item, People: after.context.people, Streams: after.context.mediaStreams, UserData: after.context.userData,
    BaseItems: await db.rows('BaseItems'), Providers: await db.rows('BaseItemProviders'), Credits: await db.rows('PeopleBaseItemMap'),
    Values: await db.rows('ItemValues'), ValueLinks: await db.rows('ItemValuesMap'), SavedNfo: await bytes(vfs, '/fixture/movie.nfo'),
  }, (_, value) => typeof value === 'bigint' ? { int64: value.toString() } : value, 2));
});

test('metadata transaction rolls back all changes and rejects stale base rows', async t => {
  const { db, store, loadContext } = await setup(t);
  const loaded = await loadContext(ids.movie);
  const result = { Item: cloneNativeItemEntity(loaded.item), People: loaded.context.people };
  result.Item.Name = 'Must roll back'; result.Item.LockedFields = ['unimplemented-field'];
  await assert.rejects(persistMetadata(store, loaded, result), /Unknown native metadata field/);
  assert.equal((await db.rows('BaseItems', { where: { Id: ids.movie } }))[0].Name, 'Stored title');
  assert.equal((await db.rows('BaseItemProviders', { where: { ItemId: ids.movie } }))[0].ProviderValue, '11');
  await db.update('BaseItems', { Id: ids.movie }, { Overview: 'Concurrent edit' });
  await assert.rejects(persistMetadata(store, loaded, { Item: loaded.item, People: [] }), error => error.code === 'metadata-conflict');
  assert.equal((await db.rows('PeopleBaseItemMap', { where: { ItemId: ids.movie } })).length, 1);
});

test('a committed metadata update has no fallible store operation before its event', async t => {
  const { db, store, loadContext, library } = await setup(t);
  const loaded = await loadContext(ids.movie);
  let writerBoundaryActive = false, baselinePublishedInsideBoundary = false;
  const guardedStore = {
    serializeWrites: (operation, options) => store.serializeWrites(async database => {
      writerBoundaryActive = true;
      try {
        const result = await operation(database);
        baselinePublishedInsideBoundary ||= loaded.snapshot?.Overview === 'Committed before the event';
        return result;
      } finally { writerBoundaryActive = false; }
    }, options),
    transaction: (...args) => store.transaction(...args),
    run() { throw new Error('Unexpected post-commit store operation'); }
  };
  const updates = new MetadataUpdateHost({ store: guardedStore, library,
    images: { async updateImages() {} }, now: () => '2026-10-06T12:00:00Z' });
  const events = [];
  updates.on('ItemUpdated', event => {
    assert.equal(writerBoundaryActive, false, 'event observers must not inherit the writer connection scope');
    events.push(event);
  });
  loaded.item.Overview = 'Committed before the event';

  await updates.update(loaded, { Item: loaded.item, Images: loaded.context.images },
    ItemUpdateType.MetadataImport);

  assert.equal((await db.rows('BaseItems', { where: { Id: ids.movie } }))[0].Overview,
    'Committed before the event');
  assert.equal(baselinePublishedInsideBoundary, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].UpdateReason, ItemUpdateType.MetadataImport);
});

test('failed remote replacement retains local fields and does not advance refresh timestamp', async t => {
  const { db, registry, adapter, refresh, loadContext } = await setup(t);
  await adapter.write('/movie.nfo', Buffer.from('<movie><plot>Local content</plot></movie>'));
  registry.register({ id: 'failed', name: 'Failed', providers: [{ id: 'FailedMovie', name: 'Failed', kind: 'remote', itemTypes: ['Movie'], getMetadata: async () => { throw new Error('offline'); } }] });
  const result = await refresh.refresh(ids.movie, { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: true, RemoveOldMetadata: true });
  assert.equal(result.Failures, 1);
  const item = (await loadContext(ids.movie)).item;
  assert.equal(item.Name, 'Stored title'); assert.equal(item.Overview, 'Stored overview'); assert.equal(item.ProviderIds.Tmdb, '11');
  assert.equal((await db.rows('BaseItems', { where: { Id: ids.movie } }))[0].DateLastRefreshed, null);
});

test('full metadata fill replaces provider credits, cast locks preserve stored mappings, and None ForceSave persists', async t => {
  const { db, registry, refresh, loadContext } = await setup(t);
  refresh.images.fetch = async () => new Response('Injected retryable image failure', { status: 500 });
  let calls = 0;
  registry.register({ id: 'credits', name: 'Credits', providers: [{ id: 'CreditsMovie', name: 'Credits', kind: 'remote', itemTypes: ['Movie'], getMetadata: async () => {
    calls++; return { HasMetadata: true, Item: { Type: 'Movie', Name: 'Fetched movie' }, People: [{ Name: 'Fetched actor', Type: 'Actor', Role: 'Lead' }] };
  } }] });
  await refresh.refresh(ids.movie, { MetadataRefreshMode: 'FullRefresh' });
  assert.equal((await loadContext(ids.movie)).context.people[0].Name, 'Fetched actor');
  await db.insert('BaseItemMetadataFields', { ItemId: ids.movie, Id: 0 });
  registry.plugins().find(plugin => plugin.id === 'credits').providers[0].getMetadata = async () => ({ HasMetadata: true, Item: { Type: 'Movie' }, People: [] });
  await refresh.refresh(ids.movie, { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: true });
  assert.equal((await loadContext(ids.movie)).context.people[0].Name, 'Fetched actor');
  const result = await refresh.refresh(ids.movie, { MetadataRefreshMode: 'None', ForceSave: true, ReplaceAllMetadata: true });
  assert.equal(result.changed, true); assert.equal(calls, 1);
});

test('native collection alias and distinct accented people retain provider IDs and remote image paths', async t => {
  const { db, registry, refresh, loadContext } = await setup(t);
  await db.update('BaseItems', { Id: ids.movie }, { Data: '{"TmdbCollectionName":"Old collection"}' });
  assert.equal((await loadContext(ids.movie)).item.TmdbCollectionName, 'Old collection');
  registry.register({ id: 'mapping', name: 'Mapping', providers: [{ id: 'MappingMovie', name: 'Mapping', kind: 'remote', itemTypes: ['Movie'], getMetadata: async () => ({
    HasMetadata: true, Item: { Type: 'Movie', TmdbCollectionName: 'New collection', HomePageUrl: 'https://fixture/not-persisted' }, People: [
      { Name: 'Jose', Type: 'Actor', ProviderIds: { Tmdb: '123' }, ImageUrl: 'https://fixture/jose.jpg' },
      { Name: 'José', Type: 'Actor', ProviderIds: { Tmdb: '456' }, ImageUrl: 'https://fixture/jose-accent.jpg' },
    ],
  }) }] });
  await refresh.refresh(ids.movie, { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: true });
  const loaded = await loadContext(ids.movie);
  assert.equal(loaded.item.TmdbCollectionName, 'New collection');
  assert.deepEqual(loaded.context.people.map(person => person.ProviderIds.Tmdb), ['123', '456']);
  assert.deepEqual(loaded.context.people.map(person => person.ImagePath), ['https://fixture/jose.jpg', 'https://fixture/jose-accent.jpg']);
  const data = JSON.parse((await db.rows('BaseItems', { where: { Id: ids.movie } }))[0].Data);
  assert.equal(data.TmdbCollectionName, 'New collection'); assert.equal(Object.hasOwn(data, 'CollectionName'), false); assert.equal(Object.hasOwn(data, 'HomePageUrl'), false);
  assert.equal(loaded.item.HomePageUrl, null);
});

for (const postgres of [true]) for (const failPerson of [false, true]) test(`native PostgreSQL provider people follow the committed parent/NFO boundary${failPerson ? ' after person failure' : ''}`, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const fixture = await setup(t, postgres), { db, registry, refresh, loadContext, vfs } = fixture;
  await db.update('BaseItems', { Id: ids.movie }, { DateLastRefreshed: '2026-10-04 12:00:00' });
  const personId = (await loadContext(ids.movie)).personIdentity('NFO Person').Id;
  registry.register({ id: 'nfo-person-order', name: 'NFO Person Order', providers: [{ id: 'NfoPersonOrderMovie', name: 'NFO Person Order', kind: 'remote', itemTypes: ['Movie'],
    getMetadata: async () => ({ HasMetadata: true, Item: { Type: 'Movie', Name: 'Saved Parent' }, People: [{ Name: 'NFO Person', Type: 'Actor', Role: 'Lead' }] }) }] });
  const originalUpdate = db.update.bind(db);
  db.update = async (table, where, changes) => {
    if (failPerson && table === 'BaseItems' && where.Id === personId) throw new Error('Injected final person save failure');
    return originalUpdate(table, where, changes);
  };
  const parentEvents = [];
  refresh.updates.on('ItemUpdated', ({ Item }) => { if (Item.Id === ids.movie) parentEvents.push(Item.Name); });
  const operation = refresh.refresh(ids.movie, { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: true });
  if (failPerson) await assert.rejects(operation, /Injected final person save failure/); else await operation;
  const nfo = await bytes(vfs, '/fixture/movie.nfo'), after = await loadContext(ids.movie);
  assert.match(nfo, /<name>Actor<\/name>/); assert.doesNotMatch(nfo, /<name>NFO Person<\/name>/);
  assert.equal(after.item.Name, 'Saved Parent'); assert.deepEqual(parentEvents, ['Saved Parent']);
  assert.deepEqual(after.context.people.map(person => person.Name), ['NFO Person']);
  assert.equal((await db.rows('BaseItems', { where: { Id: personId } }))[0].DateLastSaved == null, failPerson);
});

test('CLR whitespace normalization preserves distinct native person identities and credit roles', async t => {
  const { loadContext, refresh, stateRoot } = await setup(t);
  const loaded = await loadContext(ids.movie);
  const people = [
    { Name: '\u0085Alice\u0085', Type: 'Actor', Role: '\u0085Lead\u0085', ProviderIds: { Tmdb: '81' } },
    { Name: '\uFEFFAlice\uFEFF', Type: 'Actor', Role: '\uFEFFLead\uFEFF', ProviderIds: { Tmdb: '82' } },
  ];
  await refresh.updates.updatePeople(loaded, people);
  const after = await loadContext(ids.movie);
  assert.deepEqual(after.context.people.map(person => [person.Name, person.Role, person.ProviderIds.Tmdb]), [
    ['Alice', 'Lead', '81'], ['\uFEFFAlice\uFEFF', '\uFEFFLead\uFEFF', '82'],
  ]);
  assert.equal(loaded.personIdentity('\u0085Alice\u0085').Path, path.join(stateRoot, 'metadata', 'People', 'A', 'Alice'));
  assert.equal(loaded.personIdentity('\uFEFFAlice\uFEFF').Path, path.join(stateRoot, 'metadata', 'People', 'A', '\uFEFFAlice\uFEFF'));
});

for (const postgres of [true]) test('native PostgreSQL metadata persists Person SortName without alphanumeric rules', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { db, loadContext, refresh } = await setup(t, postgres);
  const loaded = await loadContext(ids.movie);
  const names = ['The 2', 'A-2', 'Émile', '中文'];
  await refresh.updates.updatePeople(loaded, names.map(Name => ({ Name, Type: 'Actor' })));
  for (const name of names) {
    const identity = loaded.personIdentity(name);
    const row = (await db.rows('BaseItems', { where: { Id: identity.Id } }))[0];
    assert.equal(row.Type, 'MediaBrowser.Controller.Entities.Person');
    assert.equal(row.SortName, name, name);
  }
});

for (const postgres of [true]) test('native PostgreSQL refresh imports original remote/local artwork and preserves the provider zero-ID user branch', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { adapter, vfs, refresh, loadContext, userData, db } = await setup(t, postgres);
  const original = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.writeHead(200, { 'content-type': 'image/png' }); response.end(original); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await adapter.write('/custom-logo.png', original);
  await userData.update(ids.user, ids.movie, { PlayCount: 7 });
  const nfo = `<movie><plot>Imported artwork</plot><thumb>http://127.0.0.1:${server.address().port}/poster.png</thumb><thumb aspect="clearlogo">Z:\\Fixture\\custom-logo.png</thumb><playcount>99</playcount></movie>`;
  await adapter.write('/movie.nfo', Buffer.from(nfo));
  const result = await refresh.refresh(ids.movie, { MetadataRefreshMode: 'Default' });
  assert.equal(result.Failures, 0); assert.equal(requests, 1);
  const loaded = await loadContext(ids.movie);
  assert.equal(loaded.item.Overview, 'Imported artwork'); assert.equal(loaded.context.userData.PlayCount, 7);
  assert.deepEqual(loaded.context.images.map(image => [image.Type, image.Path]).sort(), [['Logo', 'Z:\\Fixture\\custom-logo.png'], ['Primary', 'Z:\\Fixture\\movie-poster.png']]);
  assert.deepEqual(await loaded.imageAssets.read('Z:\\Fixture\\movie-poster.png'), original);
  assert.match(await bytes(vfs, '/fixture/movie.nfo'), /<playcount>7<\/playcount>/);
  assert.equal((await db.rows('BaseItemImageInfos', { where: { ItemId: ids.movie } })).length, 2);
});

for (const postgres of [true]) test('native PostgreSQL existing-item NFO parser imports ordered user events and exact ticks', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { userData, loadContext, store, saver } = await setup(t, postgres);
  await userData.update(ids.user, ids.movie, { PlayCount: 7, LastPlayedDate: '2020-01-02T00:00:00Z' }); await saver.drain();
  const events = []; userData.on('UserDataSaved', event => events.push(event));
  const xml = '<movie><watched>true</watched><playcount>12</playcount><lastplayed>2024-04-03T12:13:14.1234567+08:00</lastplayed><watched>0</watched><playcount>2147483648</playcount><lastplayed>invalid</lastplayed></movie>';
  const parsed = await loadContext.withContext(ids.movie, {}, loaded => parseNfo(xml, { item: loaded.item }));
  assert.deepEqual(await applyNfoUserData(parsed, { configuration: { UserId: ids.user }, userData, store }), { applied: 4, ignored: 0 });
  assert.deepEqual(events.map(event => [event.SaveReason, event.UserData.Played, event.UserData.PlayCount, dtoDate(event.UserData.LastPlayedDate).replace('.0000000Z', 'Z')]), [
    ['Import', true, 7, '2020-01-02T00:00:00Z'], ['Import', true, 12, '2020-01-02T00:00:00Z'],
    ['Import', true, 12, '2024-04-03T04:13:14.1234567Z'], ['Import', false, 12, '2024-04-03T04:13:14.1234567Z'],
  ]);
  await saver.drain();
  const data = await loadContext.withContext(ids.movie, {}, loaded => loaded.context.userData);
  assert.equal(data.LastPlayedDate, nativeDate('2024-04-03T04:13:14.1234567Z')); assert.equal(data.Played, false);
});

test('authoritative locale fallback preserves empty server configuration strings', async t => {
  const fixture = await setup(t);
  await fixture.db.update('BaseItems', { Id: ids.collection }, { PreferredMetadataLanguage: '' });
  fixture.library.options.libraryOptions.set(ids.collection.replaceAll('-', '').toLowerCase(), {});
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, configuration: { PreferredMetadataLanguage: '', MetadataCountryCode: '' } }), fixture.contextLoaders);
  const loaded = await loadContext(ids.movie);
  assert.equal(loaded.item.MetadataLanguage, ''); assert.equal(loaded.item.MetadataCountryCode, '');
});
