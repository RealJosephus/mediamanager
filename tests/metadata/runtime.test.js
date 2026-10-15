import test from 'node:test';
import {PluginHost} from '../../src/plugins/host.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { readFile } from 'node:fs/promises';
import { tableDefinition } from '../../src/database/model.js';
import { loadMetadataConfiguration } from '../../src/metadata/configuration-loader.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';


const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const itemId = 'E1111111-1111-1111-1111-111111111111';

test('metadata native configuration files load typed metadata, NFO and TMDB settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const programDataPath = path.join(directory, 'data');
  await mkdir(path.join(directory, 'config'), { recursive: true });
  await mkdir(path.join(programDataPath, 'plugins', 'configurations'), { recursive: true });
  await writeFile(path.join(directory, 'config', 'metadata.xml'), '<MetadataConfiguration><UseFileCreationTimeForDateAdded>false</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  await writeFile(path.join(directory, 'config', 'xbmcmetadata.xml'), '<XbmcMetadataOptions><UserId>00000000000000000000000000000001</UserId><SaveImagePathsInNfo>false</SaveImagePathsInNfo><ReleaseDateFormat>yyyy-MM-dd</ReleaseDateFormat></XbmcMetadataOptions>');
  await writeFile(path.join(programDataPath, 'plugins', 'configurations', 'Jellyfin.Plugin.Tmdb.xml'), '<PluginConfiguration><IncludeAdult>true</IncludeAdult><MaxCastMembers>5</MaxCastMembers><EnabledMissingEpisodeLibraries><string>one</string><string>two</string></EnabledMissingEpisodeLibraries></PluginConfiguration>');
  const host = await PluginHost.open({ programDataPath }); t.after(()=>host.close());
  const result = { ...await loadMetadataConfiguration({ programDataPath }), nfo:host.get('nfo').effectiveConfiguration, tmdb:host.get('tmdb').effectiveConfiguration };
  assert.equal(result.metadata.UseFileCreationTimeForDateAdded, false);
  assert.equal(result.nfo.SaveImagePathsInNfo, false); assert.equal(result.nfo.UserId.length, 32);
  assert.equal(result.tmdb.MaxCastMembers, 5); assert.equal(result.tmdb.IncludeAdult, true); assert.deepEqual(result.tmdb.EnabledMissingEpisodeLibraries, ['one', 'two']);
});

test('native metadata creation-date configuration defaults to true and reports malformed Boolean XML', async t => {
  assert.equal((await loadMetadataConfiguration()).metadata.UseFileCreationTimeForDateAdded, true);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-date-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await loadMetadataConfiguration({ configurationDirectoryPath: directory })).metadata.UseFileCreationTimeForDateAdded, true);
  await writeFile(path.join(directory, 'metadata.xml'), '<MetadataConfiguration><UseFileCreationTimeForDateAdded>invalid</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  const errors = [], configuration = await loadMetadataConfiguration({ configurationDirectoryPath: directory, onError: error => errors.push(error.message) });
  assert.equal(configuration.metadata.UseFileCreationTimeForDateAdded, true);
  assert.equal(errors.length, 1); assert.match(errors[0], /Invalid.*Boolean/u);
});



test('runtime injects the complete active TMDB missing-episode lifecycle', async t => {
  let runtime, storage;
  t.after(async () => { try { await runtime?.close(); } finally { await storage?.close(); } });
  const database = await createPostgresTestDatabase(t, 'metadata_runtime_lifecycle');
  storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('tmdb-runtime', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/tmdb-runtime', instanceId: 'tmdb-runtime', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  let requests=0;
  runtime = await createRuntime({ database, vfs, identityMap,
    pluginOptions:{options:{tmdb:{fetch:async url=>{if(url.pathname.endsWith('/configuration'))return Response.json({images:{}});requests++;return Response.json({seasons:[]});}}}},
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'tmdb-runtime-lifecycle' });
  const seriesId = 'E1000000-0000-0000-0000-000000000001';
  const collectionId = 'E1000000-0000-0000-0000-000000000002';
  await database.insert('BaseItems', { ...empty('BaseItems'), Id: seriesId,
    Type: 'MediaBrowser.Controller.Entities.TV.Series', Name: 'Runtime Series', IsFolder: true, Data: '{}' });
  await database.insert('BaseItemProviders', { ItemId: seriesId, ProviderId: 'Tmdb', ProviderValue: '42' });
  await runtime.plugins.configure('tmdb',{ImportMissingEpisodes:true,EnabledMissingEpisodeLibraries:[collectionId.replaceAll('-','')]});
  const provider=runtime.metadata.registry.discover({item:{Type:'Series'},kind:'custom'}).find(provider=>provider.id==='TmdbMissingEpisodeProvider');
  let result;
  await runtime.metadata.loadContext.withContext(seriesId, {}, async loaded => {
    result = await provider.fetch(loaded.item, { collectionFolderIds: [collectionId] });
  });
  assert.equal(result.UpdateType, ItemUpdateType.None);
  assert.equal(requests, 1);
});

test('createRuntime starts metadata hosts and saves committed user data through real service events', async t => {
  let runtime, storage;
  const metadataPath = await mkdtemp(path.join(os.tmpdir(), 'metadata-runtime-owned-'));
  t.after(async () => { try { await runtime?.close(); } finally { try { await storage?.close(); } finally { await rm(metadataPath, { recursive: true, force: true }); } } });
  const database = await createPostgresTestDatabase(t, 'metadata_runtime_services');
  const folderId = 'E1111111-1111-1111-1111-111111111112', collectionId = 'E1111111-1111-1111-1111-111111111113';
  const rootId = 'E1111111-1111-1111-1111-111111111115', userRootId = 'E1111111-1111-1111-1111-111111111116';
  for (const [Id, Type] of [[rootId, 'AggregateFolder'], [userRootId, 'UserRootFolder']]) await database.insert('BaseItems', {
    ...empty('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...empty('BaseItems'), Id: folderId, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Fixture', Path: 'Z:\\Fixture', ParentId: rootId, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...empty('BaseItems'), Id: collectionId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Movies', ParentId: userRootId, IsFolder: true,
    Data: JSON.stringify({ PhysicalFolderIds: [folderId], PhysicalLocationsList: ['Z:\\Fixture'] }) });
  await database.insert('BaseItems', { ...empty('BaseItems'), Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Runtime movie',
    Path: 'Z:\\Fixture\\movie.mkv', ParentId: folderId, TopParentId: folderId, MediaType: 'Video', IsInMixedFolder: true, Data: '{}', RunTimeTicks: 5000000000n,
    // ValidationOnly checks NFO changes after first-refresh persistence. This
    // existing item has a prior refresh/save, and the incoming NFO is newer.
    DateLastRefreshed: '2026-09-26 10:00:00', DateLastSaved: '2026-09-26 10:00:00' });
  storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Fixture', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated runtime fixture' });
  const errors = [];
  runtime = await createRuntime({ database, metadataPath, configuration: { UICulture: 'en-US' }, serverId: 'runtime-metadata', serverName: 'Runtime metadata',
    vfs, identityMap, libraryOptions: new Map([[collectionId.replaceAll('-', '').toLowerCase(), { SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }]]), onError: error => errors.push(error.message) });
  assert.equal(runtime.metadata.supports('Movie'), true); assert.equal(runtime.metadata.supports('Folder'), true);
  assert.equal(runtime.metadata.registry.plugins().some(plugin => plugin.id === 'local-xml'), true);
  assert.equal(runtime.metadata.registry.plugins().some(plugin => plugin.id === 'playlist-items'), true);
  assert.equal(runtime.itemDeletion.linkedChildReferences, runtime.linkedChildReferences);
  assert.equal(runtime.metadata.externalData, runtime.externalData); assert.equal(runtime.probe.externalData, runtime.externalData);
  assert.equal(runtime.userData.listenerCount('UserDataSaved') >= 1, true);
  const user = await runtime.users.createUser({ Name: 'Metadata user' });
  await runtime.plugins.configure('nfo',{UserId:user.Id});
  await vfs.write('/fixture/movie.nfo', Buffer.from('<movie><title>Runtime movie</title></movie>'));
  const loaded = await runtime.metadata.loadContext(itemId);
  assert.equal(loaded.context.accessPath, '/fixture/movie.mkv');
  await loaded.dispose();
  await runtime.metadata.saver.save(itemId, 'MetadataEdit');
  await runtime.userData.setFavorite(user.Id, itemId, true); await runtime.metadata.saver.drain();
  await runtime.metadata.loadContext.withContext(itemId, {}, async current => {
    assert.equal(current.context.userData.IsFavorite, true);
  });
  const handle = await vfs.openRead('/fixture/movie.nfo');
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); assert.match(Buffer.concat(chunks).toString(), /<isuserfavorite>true<\/isuserfavorite>/); }
  finally { await handle.close(); }
  await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsAdministrator: true });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const login = async (name, device) => {
    const response = await fetch(base + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `MediaBrowser Client="Metadata tests", Device="Fixture", DeviceId="${device}", Version="1"` }, body: JSON.stringify({ Username: name, Pw: '' }) });
    assert.equal(response.status, 200); return (await response.json()).AccessToken;
  };
  const token = await login('Metadata user', 'admin');
  await vfs.write('/fixture/movie.nfo', Buffer.from('<movie><title>Title from HTTP refresh</title><plot>Imported through the runtime</plot><year>2025</year></movie>'), { modified: '2026-09-26T12:00:00Z' });
  const post = async (id, token) => fetch(`${base}/Items/${id}/Refresh?metadataRefreshMode=ValidationOnly`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal((await post(itemId, token)).status, 204); await runtime.metadata.drain();
  assert.deepEqual(errors, []);
  const row = (await database.rows('BaseItems', { where: { Id: itemId } }))[0];
  assert.equal(row.Overview, 'Imported through the runtime'); assert.equal(row.ProductionYear, 2025);
  // ValidationOnly fills empty fields and preserves the existing nonempty name.
  assert.equal(row.Name, 'Runtime movie');
  await database.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: 'E1111111-1111-1111-1111-111111111114', ItemId: itemId, ImageType: 4, Path: 'Z:\\Fixture\\missing-logo.png', Width: 100, Height: 100 });
  await vfs.write('/fixture/movie-poster.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { modified: '2026-09-26T13:00:00Z' });
  const validate = await fetch(`${base}/Items/${itemId}/Refresh?metadataRefreshMode=None&imageRefreshMode=ValidationOnly`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal(validate.status, 204); await runtime.metadata.drain();
  const images = await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } });
  assert.deepEqual(images.map(image => [image.ImageType, image.Path, image.Width, image.Height]), [[0, 'Z:\\Fixture\\movie-poster.png', 0, 0]]);
  assert.equal((await post('E1111111-1111-1111-1111-111111111199', token)).status, 404);
  await runtime.users.createUser({ Name: 'Reader' });
  const readerToken = await login('Reader', 'reader');
  assert.equal((await post(itemId, readerToken)).status, 403);
  // BaseItem now runs its independent owned-item image wrapper before the
  // single-item validation removes the deliberately missing outdated logo.
  assert.deepEqual(errors, ['The storage object does not exist.']);
});
