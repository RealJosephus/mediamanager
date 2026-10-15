import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService, FolderScanService, DirectoryItemResolverPipeline } from '../../src/library/index.js';
import { idKey, mapRecord } from '../../src/library/records.js';
import { collectionFoldersForItem, parentChainForItem, userRootFolders } from '../../src/library/collection-membership.js';
import { buildScanCollectionContext, configuredItemType, inheritedItemType } from '../../src/library/scan-context.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';

const compare = (actual, expected) => assert.deepEqual(actual, expected);
const hash = value => createHash('sha256').update(value).digest('hex');
const fixtures = [];
for (const [name, count, flag] of [['native-scan-context', 28, 'actualFrozenNativeScanContext'], ['native-scan-context-edges', 43, 'actualFrozenNativeScanContextEdges']]) {
  const root = new URL('./fixtures/' + name + '/', import.meta.url);
  const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
  fixtures.push({ input, native });
  test(name + ' seals actual manager getter calls and live options/order controls', async () => {
    for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
    assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
    assert.equal(native[flag], true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
    assert.equal(input.length, count); assert.equal(native.results.length, count);
    assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
    compare(native.results.map(value => value.name), input.map(value => value.name));
    compare(native.results.map(value => value.exception), input.map(value => value.expectException ?? null));
  });
}
const userRootId = '97910000-0000-0000-0000-000000000099';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const nativeType = type => type === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
  : type === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder' : 'MediaBrowser.Controller.Entities.' + type;
function controlledState(sample) {
  const entity = definition => ({ ...definition, Id: definition.id, Type: definition.type, NativeType: nativeType(definition.type), IsFolder: definition.type !== 'Movie' });
  const item = entity(sample.item), parents = sample.parents.map(entity), collections = sample.collections.map(entity);
  if (!Object.hasOwn(sample.item, 'ParentId')) item.ParentId = parents[0]?.Id ?? null;
  parents.forEach((parent, index) => { parent.ParentId = parents[index + 1]?.Id ?? null; });
  const userRoot = { Id: userRootId, Type: 'UserRootFolder', NativeType: nativeType('UserRootFolder'), IsFolder: true };
  collections.forEach((collection, index) => { collection.ParentId = userRoot.Id; collection.SortName = String(index).padStart(3, '0'); });
  const items = [item, ...parents, ...collections, userRoot];
  const options = Object.fromEntries([...collections, item].filter(value => value.Type === 'CollectionFolder')
    .map(value => [idKey(value.Id), { MetadataCountryCode: value.country ?? 'CONTROL' }]));
  return { item, items, options, state: { items, byId: new Map(items.map(value => [idKey(value.Id), value])) } };
}
function projection(item, state, options, sample) {
  const selected = collectionFoldersForItem(item, state);
  const context = buildScanCollectionContext({ root: item, collectionFolders: selected, libraryOptions: options, state,
    configuration: { ContentTypes: sample.contentTypes === undefined ? [] : sample.contentTypes } });
  return { collectionIds: selected.map(value => value.Id.toLowerCase()), country: context.libraryOptions.MetadataCountryCode ?? null,
    configured: configuredItemType(item, context.contentTypeOverrides), inherited: inheritedItemType(item, parentChainForItem(item, state), userRootFolders(state), context.contentTypeOverrides),
    contentType: context.collectionType };
}
async function capture(action) {
  try { return { exception: null, parameterName: null, result: await action() }; }
  catch (error) { return { exception: error.nativeException ?? error.name, parameterName: error.parameterName ?? null, result: null }; }
}
const expectedProjection = value => ({ exception: value.exception, parameterName: value.parameterName, result: value.result });
test('context comparison detects changed user-root order, options selection and override value', () => {
  const expected = fixtures[0].native.results.find(value => value.name === 'first-high-id-movies');
  for (const change of [value => value.result.collectionIds.reverse(), value => { value.result.country = 'BB'; }, value => { value.result.contentType = null; }]) {
    const actual = structuredClone(expected); change(actual);
    assert.throws(() => compare(expectedProjection(actual), expectedProjection(expected)), assert.AssertionError);
  }
});
for (const fixture of fixtures) for (const sample of fixture.input) {
  const expected = expectedProjection(fixture.native.results.find(value => value.name === sample.name));
  test('live native manager context projection ' + sample.name, async () => {
    const current = controlledState(sample);
    compare(await capture(() => projection(current.item, current.state, current.options, sample)), expected);
  });
}
async function databaseFor(t, dialect) {
  const schema = 'native_scan_context_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => { if (dialect === 'postgres') { await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); } await store.close(); });
  return { database, store };
}
function rowFor(item) {
  return { ...blank, Id: item.Id, Type: item.NativeType, Name: item.Type, SortName: item.SortName ?? 'item', Path: item.Path ?? null,
    IsFolder: item.IsFolder, ParentId: null, OwnerId: null,
    Data: item.Type === 'PlaylistsFolder' ? null : JSON.stringify({ CollectionType: item.CollectionType ?? null,
      PhysicalLocationsList: item.PhysicalLocationsList === undefined ? [] : item.PhysicalLocationsList,
      PhysicalFolderIds: item.PhysicalFolderIds ?? [] }) };
}
async function seed(database, current) {
  const unique = new Map(current.items.map(item => [idKey(item.Id), item]));
  for (const item of unique.values()) await database.insert('BaseItems', rowFor(item));
  for (const item of unique.values()) await database.update('BaseItems', { Id: item.Id }, {
    ParentId: item.ParentId && idKey(item.ParentId) !== '00000000000000000000000000000000' ? item.ParentId : null,
    OwnerId: item.OwnerId ?? null });
}
for (const dialect of ['postgres']) for (const fixture of fixtures) for (const sample of fixture.input) {
  test(dialect + ': hydrated native collection/options/type context ' + sample.name,
    { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
      const { database, store } = await databaseFor(t, dialect), current = controlledState(sample);
      await seed(database, current);
      const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'native-scan-context', libraryOptions: current.options }); t.after(() => library.close());
      const before = await database.rows('BaseItems'), state = await store.run(db => library.load(db, null, {
        includeUserData: false,
        baseRows: before,
      }));
      compare(await capture(() => projection(state.byId.get(idKey(current.item.Id)), state, current.options, sample)),
        expectedProjection(fixture.native.results.find(value => value.name === sample.name)));
      compare(await database.rows('BaseItems'), before);
    });
}
for (const dialect of ['postgres']) for (const name of ['first-high-id-movies', 'first-low-id-music', 'first-missing-type', 'physical-location-case', 'override-invalid-first', 'override-numeric-value']) {
  test(dialect + ': actual scanner receives frozen native ordered context ' + name,
    { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
      const fixture = fixtures[0], sample = fixture.input.find(value => value.name === name), native = fixture.native.results.find(value => value.name === name);
      const { database, store } = await databaseFor(t, dialect), current = controlledState(sample); await seed(database, current);
      const registry = new StorageRegistry(); registry.registerType('memory', options => new MemoryStorageAdapter(options));
      const adapter = await registry.createInstance('library', 'memory', {}), vfs = new VirtualFileSystem(registry);
      vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} }); await adapter.write('/Film.mkv', Buffer.from('native context control'));
      const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: current.item.Path, accessRoot: '/library', style: 'windows', returnAccess: 'Isolated native context scan control' });
      const configuration = { ContentTypes: sample.contentTypes ?? [] }, library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'native-scan-context-scanner', libraryOptions: current.options, configuration });
      const seen = [], observer = { id: 'ordered-context-observer', priority: 1, nativeTypes: { 'MediaBrowser.Controller.Entities.Folder': { isFolder: true } },
        resolveMultiple: ({ collectionContext }) => { seen.push({ ids: collectionContext.collectionFolderIds.map(value => value.toLowerCase()),
          country: collectionContext.libraryOptions.MetadataCountryCode ?? null, type: collectionContext.collectionType }); return null; } };
      const programDataPath = 'C:\\ProgramData\\MediaManager', resolverPipeline = new DirectoryItemResolverPipeline({ programDataPath, configuration, resolvers: [observer, createVideoFileResolver()] });
      const lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, configuration });
      const scanner = new FolderScanService({ store, library, vfs, identityMap, refreshes: new ProviderRefreshService(),
        ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [current.item.Path] }),
        programDataPath, configuration, resolverPipeline, resolvedItemLifecycle: lifecycleFixture.lifecycle });
      t.after(async () => { await scanner.close(); await lifecycleFixture.close(); await library.close(); await registry.close(); });
      const receipt = await scanner.scan(mapRecord((await database.rows('BaseItems', { where: { Id: current.item.Id } }))[0]), { Recursive: false });
      assert.ok(seen.length > 0); for (const value of seen) compare(value, { ids: native.result.collectionIds, country: native.result.country, type: native.result.contentType });
      assert.equal(receipt.added, native.result.contentType === 'movies' ? 1 : 0);
      const rows = (await database.rows('BaseItems', { where: { ParentId: current.item.Id } }));
      assert.equal(rows.length, native.result.contentType === 'movies' ? 1 : 0);
      if (rows.length) assert.equal(rows[0].Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
    });
}

for (const dialect of ['postgres']) for (const sample of fixtures[1].input.filter(value => value.name.startsWith('deep-'))) {
  test(dialect + ': recursive scanner keeps actual intermediate parents ' + sample.name,
    { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
      const native = fixtures[1].native.results.find(value => value.name === sample.name);
      const { database, store } = await databaseFor(t, dialect), current = controlledState(sample);
      const scanRoot = current.items.find(item => idKey(item.Id) === idKey(sample.parents[1].id));
      current.items = current.items.filter(item => ![sample.item.id, sample.parents[0].id].some(id => idKey(id) === idKey(item.Id)));
      await seed(database, current);
      const registry = new StorageRegistry(); registry.registerType('memory', options => new MemoryStorageAdapter(options));
      const adapter = await registry.createInstance('library', 'memory', {}), vfs = new VirtualFileSystem(registry);
      vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} });
      await adapter.mkdir('/A'); await adapter.mkdir('/A/B'); await adapter.write('/A/B/Film.mkv', Buffer.from('deep native context control'));
      const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: scanRoot.Path, accessRoot: '/library', style: 'windows', returnAccess: 'Isolated native deep context scan control' });
      const configuration = { ContentTypes: sample.contentTypes }, library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'native-deep-scan-context', libraryOptions: current.options, configuration });
      const seen = [], observer = { id: 'deep-context-observer', priority: 1, nativeTypes: { 'MediaBrowser.Controller.Entities.Folder': { isFolder: true } },
        resolveMultiple: ({ parent, collectionContext, available }) => {
          seen.push({ path: parent.Path, type: collectionContext.collectionType });
          const directories = available.filter(candidate => candidate.entry.kind === 'directory');
          return directories.length ? { items: directories.map(candidate => ({
            nativeType: 'MediaBrowser.Controller.Entities.Folder', primary: candidate, consumedPaths: [candidate], traversal: 'children',
            draft: { Name: candidate.entry.name, IsFolder: true, MediaType: 'Unknown', SourceType: 'Library' }
          })), extraFiles: available.filter(candidate => candidate.entry.kind === 'file') } : null;
        } };
      const programDataPath = 'C:\\ProgramData\\MediaManager', resolverPipeline = new DirectoryItemResolverPipeline({ programDataPath, configuration, resolvers: [observer, createVideoFileResolver()] });
      const lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, configuration });
      const scanner = new FolderScanService({ store, library, vfs, identityMap, refreshes: new ProviderRefreshService(),
        ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [scanRoot.Path] }),
        programDataPath, configuration, resolverPipeline, resolvedItemLifecycle: lifecycleFixture.lifecycle });
      t.after(async () => { await scanner.close(); await lifecycleFixture.close(); await library.close(); await registry.close(); });
      await scanner.scan(scanRoot);
      compare(seen.filter(value => value.path === sample.item.Path), [{ path: sample.item.Path, type: native.result.contentType }]);
      const videos = await database.rows('BaseItems', { where: { Path: sample.item.Path + '\\Film.mkv' } });
      assert.equal(videos.length, native.result.contentType === 'movies' ? 1 : 0);
      if (videos.length) assert.equal(videos[0].Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
    });
}
