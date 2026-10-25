import test from 'node:test';
import { openConfiguredPluginHost } from '../plugins/configuration-host.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { readFile } from 'node:fs/promises';
import { tableDefinition } from '../../src/database/model.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { parseConfigurationXml, defaultConfiguration } from '../../src/core/configuration-xml.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';


const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const itemId = 'E1111111-1111-1111-1111-111111111111';
const failureFields = error => ({ message: error?.message, code: error?.code ?? null,
  status: error?.status ?? error?.statusCode ?? null,
  ...(error?.cause !== undefined && { cause: failureFields(error.cause) }),
  ...(Array.isArray(error?.errors) && { errors: error.errors.map(failureFields) }) });
const errorDiagnostic = error => ({ ...error, ...failureFields(error), name: error?.name, stack: error?.stack });

async function readMetadata(configurationDirectoryPath, onError = () => {}) {
  const store = new NamedConfigurationStore({ configurationDirectoryPath, onError });
  try { return { metadata: await store.getConfiguration('metadata') }; }
  finally { await store.close(); }
}

test('metadata native configuration files load typed metadata, NFO and TMDB settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const programDataPath = path.join(directory, 'data');
  await mkdir(path.join(directory, 'config'), { recursive: true });
  await mkdir(path.join(programDataPath, 'plugins', 'configurations'), { recursive: true });
  await writeFile(path.join(directory, 'config', 'metadata.xml'), '<MetadataConfiguration><UseFileCreationTimeForDateAdded>false</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  await writeFile(path.join(directory, 'config', 'xbmcmetadata.xml'), '<XbmcMetadataOptions><UserId>00000000000000000000000000000001</UserId><SaveImagePathsInNfo>false</SaveImagePathsInNfo><ReleaseDateFormat>yyyy-MM-dd</ReleaseDateFormat></XbmcMetadataOptions>');
  await writeFile(path.join(programDataPath, 'plugins', 'configurations', 'Jellyfin.Plugin.Tmdb.xml'), '<PluginConfiguration><IncludeAdult>true</IncludeAdult><MaxCastMembers>5</MaxCastMembers><EnabledMissingEpisodeLibraries><string>one</string><string>two</string></EnabledMissingEpisodeLibraries></PluginConfiguration>');
  const host = await openConfiguredPluginHost({ programDataPath }); t.after(()=>host.close());
  const result = { ...await readMetadata(path.join(directory, 'config')), nfo:host.get('nfo').effectiveConfiguration, tmdb:host.get('tmdb').effectiveConfiguration };
  assert.equal(result.metadata.UseFileCreationTimeForDateAdded, false);
  assert.equal(result.nfo.SaveImagePathsInNfo, false); assert.equal(result.nfo.UserId.length, 32);
  assert.equal(result.tmdb.MaxCastMembers, 5); assert.equal(result.tmdb.IncludeAdult, true); assert.deepEqual(result.tmdb.EnabledMissingEpisodeLibraries, ['one', 'two']);
});

test('native metadata creation-date configuration defaults to true and reports malformed Boolean XML', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-date-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await readMetadata(directory)).metadata.UseFileCreationTimeForDateAdded, true);
  const filename = path.join(directory, 'metadata.xml');
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  const original = Buffer.from('<MetadataConfiguration><UseFileCreationTimeForDateAdded>invalid</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  let parseFailure;
  assert.throws(() => parseConfigurationXml(original, 'metadata'), error => { parseFailure = error; return true; });
  await writeFile(filename, original);
  const errors = [], configuration = await readMetadata(directory, error => errors.push(error));
  assert.equal(configuration.metadata.UseFileCreationTimeForDateAdded, true);
  assert.deepEqual(configuration.metadata, defaultConfiguration('metadata'));
  const retained = await readFile(filename);
  assert.deepEqual(retained, original);
  const coldErrors = [], cold = await readMetadata(directory, error => coldErrors.push(error));
  assert.deepEqual(cold, configuration);
  for (const error of coldErrors) assert.deepEqual(failureFields(error), failureFields(parseFailure),
    'Cold load diagnostics belong to the actual rejected Boolean input.');
  await writeFile(filename, '<MetadataConfiguration><UseFileCreationTimeForDateAdded>false</UseFileCreationTimeForDateAdded></MetadataConfiguration>');
  const recoveredErrors = [], recovered = await readMetadata(directory, error => recoveredErrors.push(error));
  assert.deepEqual(recovered.metadata, { ...defaultConfiguration('metadata'), UseFileCreationTimeForDateAdded: false });
  assert.deepEqual(recoveredErrors, []);
  t.diagnostic(JSON.stringify({ input: original.toString('base64'), retained: retained.toString('base64'),
    parseFailure: errorDiagnostic(parseFailure), errors: errors.map(errorDiagnostic), coldErrors: coldErrors.map(errorDiagnostic) }));
  for (const error of errors) assert.deepEqual(failureFields(error), failureFields(parseFailure),
    'Only the actual rejected Boolean parser boundary may classify its diagnostics.');
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
  runtime = await createTestRuntime({ database, vfs, identityMap,
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
  const errors = []; let phase = 'startup';
  runtime = await createTestRuntime({ database, metadataPath, configuration: { UICulture: 'en-US' }, serverId: 'runtime-metadata', serverName: 'Runtime metadata',
    vfs, identityMap, libraryOptions: new Map([[collectionId.replaceAll('-', '').toLowerCase(), { SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }]]), onError: error => errors.push({ phase, error }) });
  assert.equal(runtime.metadata.supports('Movie'), true); assert.equal(runtime.metadata.supports('Folder'), true);
  assert.equal(runtime.metadata.registry.plugins().some(plugin => plugin.id === 'local-xml'), true);
  assert.equal(runtime.metadata.registry.plugins().some(plugin => plugin.id === 'playlist-items'), true);
  const user = await runtime.users.createUser({ Name: 'Metadata user' });
  await runtime.plugins.configure('nfo',{UserId:user.Id});
  await vfs.write('/fixture/movie.nfo', Buffer.from('<movie><title>Runtime movie</title></movie>'));
  const loaded = await runtime.metadata.loadContext(itemId);
  assert.equal(loaded.context.accessPath, '/fixture/movie.mkv');
  await loaded.dispose();
  await runtime.metadata.saver.save(itemId, 'MetadataEdit');
  await runtime.userData.setFavorite(user.Id, itemId, true); await runtime.metadata.saver.drain();
  await runtime.metadata.loadContext.withContext(itemId, {}, async current => {
    assert.equal((await current.context.getUserData(current.item, user.Id)).IsFavorite, true);
  });
  const handle = await vfs.openRead('/fixture/movie.nfo');
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); assert.match(Buffer.concat(chunks).toString(), /<isuserfavorite>true<\/isuserfavorite>/); }
  finally { await handle.close(); }
  await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsAdministrator: true });
  const base = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
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
  const imageFailures = [], stat = vfs.stat.bind(vfs);
  vfs.stat = async (pathname, ...args) => {
    try { return await stat(pathname, ...args); }
    catch (error) { if (pathname === '/fixture/missing-logo.png') imageFailures.push({ pathname, error }); throw error; }
  };
  phase = 'image-validation';
  const validate = await fetch(`${base}/Items/${itemId}/Refresh?metadataRefreshMode=None&imageRefreshMode=ValidationOnly`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal(validate.status, 204); await runtime.metadata.drain();
  const images = await database.rows('BaseItemImageInfos', { where: { ItemId: itemId } });
  assert.deepEqual(images.map(image => [image.ImageType, image.Path, image.Width, image.Height]), [[0, 'Z:\\Fixture\\movie-poster.png', 0, 0]]);
  vfs.stat = stat;
  assert.ok(imageFailures.some(({ error }) => error.code === 'not-found'), 'The actual missing stored image must fail its storage read.');
  phase = 'missing-item';
  assert.equal((await post('E1111111-1111-1111-1111-111111111199', token)).status, 404);
  phase = 'reader-authentication';
  await runtime.users.createUser({ Name: 'Reader' });
  const readerToken = await login('Reader', 'reader');
  phase = 'forbidden';
  assert.equal((await post(itemId, readerToken)).status, 403);
  // BaseItem now runs its independent owned-item image wrapper before the
  // single-item validation removes the deliberately missing outdated logo.
  phase = 'close'; await runtime.close();
  t.diagnostic(JSON.stringify({ imageFailures: imageFailures.map(({ pathname, error }) => ({ pathname, error: errorDiagnostic(error) })),
    errors: errors.map(({ phase, error }) => ({ phase, error: errorDiagnostic(error) })) }));
  for (const entry of errors) {
    if (entry.phase === 'image-validation') {
      assert.equal(entry.error.code, 'not-found');
      assert.ok(imageFailures.some(({ error }) => isDeepStrictEqual(failureFields(error), failureFields(entry.error))),
        'Only an actual missing-image storage failure may classify its diagnostics.');
    } else if (entry.phase === 'missing-item') assert.equal(entry.error.status ?? entry.error.statusCode, 404);
    else if (entry.phase === 'forbidden') assert.equal(entry.error.status ?? entry.error.statusCode, 403);
    else assert.fail('Successful operations, authentication and normal close must not hide failures.');
  }
});
