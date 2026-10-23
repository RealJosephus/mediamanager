import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { createTmdbMissingEpisodeProvider } from '../../plugins/tmdb/missing-episodes.js';
import { createPresentationUniqueKey } from '../../src/library/presentation-key.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { persistedTmdbCleanupLifecycle, createTmdbTestServices } from './tmdb-missing-test-lifecycle.js';

const ids = Object.fromEntries(['folder', 'firstCollection', 'secondCollection', 'series', 'season', 'owned', 'physical', 'foreign',
  'otherSeries', 'otherSeason', 'otherOwned'].map((name, index) => [name, `F1111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`]));
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const nativeType = Type => ['Folder', 'CollectionFolder', 'AggregateFolder', 'UserRootFolder'].includes(Type)
  ? `MediaBrowser.Controller.Entities.${Type}` : `MediaBrowser.Controller.Entities.TV.${Type}`;
const item = (Id, Type, values = {}) => ({ ...empty('BaseItems'), Id, Type: nativeType(Type), Name: Type, Data: '{}', ...values });
const nFormat = value => value.replaceAll('-', '');

async function fixture(t) {
  const schema = `tmdb_missing_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(db);
  let services, storage;
  t.after(async () => {
    await services?.close(); await storage?.close();
    await db.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await db.close();
  });
  const aggregate = 'F1111111-1111-1111-1111-000000000097';
  const userRoot = 'F1111111-1111-1111-1111-000000000098';
  await db.insert('BaseItems', item(aggregate, 'AggregateFolder', { IsFolder: true }));
  await db.insert('BaseItems', item(userRoot, 'UserRootFolder', { IsFolder: true, Path: 'D:\\unused-instance\\root\\default' }));
  await db.insert('BaseItems', item(ids.folder, 'Folder', { IsFolder: true, ParentId: aggregate, Path: 'Z:\\Series' }));
  for (const collection of [ids.firstCollection, ids.secondCollection]) {
    await db.insert('BaseItems', item(collection, 'CollectionFolder', {
      IsFolder: true, ParentId: userRoot, Path: `D:\\unused-instance\\root\\default\\${collection}`,
      Data: JSON.stringify({ PhysicalFolderIds: [ids.folder], PhysicalLocationsList: ['Z:\\Series'] }),
    }));
  }
  await db.insert('BaseItems', item(ids.series, 'Series', {
    IsFolder: true, ParentId: ids.folder, TopParentId: ids.folder, DateLastRefreshed: '2026-09-01 00:00:00',
  }));
  await db.insert('BaseItems', item(ids.season, 'Season', { IsFolder: true, ParentId: ids.series, TopParentId: ids.folder,
    Path: 'Z:\\Series\\Season1', IndexNumber: 1 }));
  await db.insert('BaseItems', item(ids.owned, 'Episode', {
    IsVirtualItem: true, ParentId: ids.season, TopParentId: ids.folder, ParentIndexNumber: 1, IndexNumber: 1,
  }));
  await db.insert('BaseItems', item(ids.physical, 'Episode', {
    Path: 'Z:\\Series\\S01E02.mkv', ParentId: ids.season, TopParentId: ids.folder, ParentIndexNumber: 1, IndexNumber: 2,
  }));
  await db.insert('BaseItems', item(ids.foreign, 'Episode', {
    IsVirtualItem: true, ParentId: ids.season, TopParentId: ids.folder, ParentIndexNumber: 1, IndexNumber: 3,
  }));
  await db.insert('BaseItems', item(ids.otherSeries, 'Series', { IsFolder: true }));
  await db.insert('BaseItems', item(ids.otherSeason, 'Season', { IsFolder: true, ParentId: ids.otherSeries, IndexNumber: 1 }));
  await db.insert('BaseItems', item(ids.otherOwned, 'Episode', {
    IsVirtualItem: true, ParentId: ids.otherSeason, ParentIndexNumber: 1, IndexNumber: 1,
  }));
  for (const [Id, ProviderId, ProviderValue] of [[ids.series, 'Tmdb', '42'], [ids.owned, 'tmDB', '101'], [ids.physical, 'Tmdb', '102'],
    [ids.foreign, 'Tvdb', '103'], [ids.otherOwned, 'Tmdb', '201']]) await db.insert('BaseItemProviders', { ItemId: Id, ProviderId, ProviderValue });
  for (const ParentItemId of [ids.folder, ids.series, ids.season]) await db.insert('AncestorIds', { ItemId: ids.owned, ParentItemId });
  await db.insert('BaseItemImageInfos', { ...empty('BaseItemImageInfos'), Id: 'F1111111-1111-1111-1111-000000000099', ItemId: ids.owned,
    ImageType: 0, Path: 'https://image.invalid/still.jpg' });
  await db.insert('LinkedChildren', { ParentId: ids.series, SortOrder: 0, ChildId: ids.owned, ChildType: 0 });
  await db.insert('LinkedChildren', { ParentId: ids.owned, SortOrder: 0, ChildId: ids.foreign, ChildType: 0 });
  storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\Series', accessRoot: '/fixture/series', style: 'windows', returnAccess: 'isolated TMDB opt-in controls' });
  const userRootRecord = (await db.rows('BaseItems', { where: { Id: userRoot } }))[0];
  services = await createTmdbTestServices({ store, vfs, identityMap, serverId: 'tmdb-missing-test', userRoot: userRootRecord });
  const { loadContext } = services;
  const loaded = await loadContext(ids.series);
  const seriesKey = createPresentationUniqueKey(loaded.item, loaded);
  await db.update('BaseItems', { Id: ids.season }, { SeriesId: ids.series, SeriesName: 'Series', SeriesPresentationUniqueKey: seriesKey });
  for (const Id of [ids.owned, ids.physical, ids.foreign]) await db.update('BaseItems', { Id }, {
    SeriesId: ids.series, SeriesName: 'Series', SeriesPresentationUniqueKey: seriesKey, SeasonId: ids.season, SeasonName: 'Season',
  });
  await loaded.dispose();
  return { db, ...services, vfs };
}

async function refreshFixture(t, current, configuration) {
  let networkCalls = 0;
  const client = new Proxy({ configuration }, {
    get(target, property) {
      if (property in target) return target[property];
      if (property === 'series') return async () => { networkCalls++; return null; };
      return async () => { networkCalls++; throw new Error(`Unexpected TMDB call: ${String(property)}`); };
    },
  });
  const registry = new MetadataRegistry();
  const images = { merge: async () => false };
  const updates = { update: async () => [] };
  const lifecycle = persistedTmdbCleanupLifecycle(current);
  registry.register(createTmdbPlugin({ client, lifecycle }));
  const host = new MetadataRefreshHost({ registry, loadContext: current.loadContext, store: current.store, linkedChildren: current.linkedChildren, vfs: current.vfs, images, updates,
    now: () => '2026-09-27T00:00:00Z' });
  current.registerHost(host);
  const result = await host.refresh(ids.series, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
  return { result, networkCalls };
}

async function assertOwnedRemoved(db) {
  assert.equal((await db.rows('BaseItems', { where: { Id: ids.owned } })).length, 0);
  for (const table of ['BaseItemProviders', 'BaseItemImageInfos', 'AncestorIds']) {
    assert.equal((await db.rows(table, { where: { ItemId: ids.owned } })).length, 0);
  }
  assert.equal((await db.rows('LinkedChildren', { where: { ChildId: ids.owned } })).length, 0);
  assert.equal((await db.rows('LinkedChildren', { where: { ParentId: ids.owned } })).length, 0);
  for (const retained of [ids.physical, ids.foreign, ids.otherOwned]) {
    assert.equal((await db.rows('BaseItems', { where: { Id: retained } })).length, 1);
  }
}

async function assertOwnedPresent(db) {
  assert.equal((await db.rows('BaseItems', { where: { Id: ids.owned } })).length, 1);
  assert.equal((await db.rows('BaseItemProviders', { where: { ItemId: ids.owned } })).length, 1);
  assert.equal((await db.rows('BaseItemImageInfos', { where: { ItemId: ids.owned } })).length, 1);
  assert.equal((await db.rows('AncestorIds', { where: { ItemId: ids.owned } })).length, 3);
  assert.equal((await db.rows('LinkedChildren', { where: { ChildId: ids.owned } })).length, 1);
  assert.equal((await db.rows('LinkedChildren', { where: { ParentId: ids.owned } })).length, 1);
}

for (const postgres of [true]) test('PostgreSQL TMDB missing-episode library opt-in cleanup', async t => {
  await t.test('metadata context exposes every matching raw CollectionFolder id', async t => {
    const current = await fixture(t, postgres);
    const loaded = await current.loadContext(ids.series);
    assert.deepEqual(new Set(loaded.context.collectionFolderIds), new Set([ids.firstCollection, ids.secondCollection]));
  });

  await t.test('active imports with an empty enabled-library list clean owned rows and dependent relations without network', async t => {
    const current = await fixture(t, postgres);
    const { result, networkCalls } = await refreshFixture(t, current, tmdbConfiguration({ ImportUnairedEpisodes: true }));
    assert.equal(result.changed, true);
    assert.equal(Boolean(result.UpdateType & ItemUpdateType.MetadataImport), true);
    assert.equal(result.Failures, 0);
    assert.equal(networkCalls, 0);
    await assertOwnedRemoved(current.db);
  });

  await t.test('one uppercase N-format match enters active fetch and keeps the series when TMDB returns null', async t => {
    const current = await fixture(t, postgres);
    const configuration = tmdbConfiguration({ ImportMissingEpisodes: true,
      EnabledMissingEpisodeLibraries: [nFormat(ids.secondCollection).toUpperCase()] });
    const loaded = await current.loadContext(ids.series);
    // This control isolates provider opt-in. A missing native key independently
    // requires BeforeSave to import metadata before the unsupported provider runs.
    await current.db.update('BaseItems', { Id: ids.series }, { PresentationUniqueKey: createPresentationUniqueKey(loaded.item, loaded) });
    const provider = createTmdbMissingEpisodeProvider({ configuration });
    assert.equal(provider.hasChanged(loaded.item, loaded.context), true);
    const { result, networkCalls } = await refreshFixture(t, current, configuration);
    assert.equal(result.changed, false);
    assert.equal(result.Failures, 0);
    assert.equal(networkCalls, 1);
    await assertOwnedPresent(current.db);
  });

  await t.test('a hyphenated configured id is not treated as a native N-format match', async t => {
    const current = await fixture(t, postgres);
    const configuration = tmdbConfiguration({ ImportUnairedEpisodes: true,
      EnabledMissingEpisodeLibraries: [ids.firstCollection] });
    const loaded = await current.loadContext(ids.series);
    const provider = createTmdbMissingEpisodeProvider({ configuration });
    assert.equal(provider.hasChanged(loaded.item, loaded.context), true);
    const { result, networkCalls } = await refreshFixture(t, current, configuration);
    assert.equal(result.changed, true);
    assert.equal(result.Failures, 0);
    assert.equal(networkCalls, 0);
    await assertOwnedRemoved(current.db);
  });
});

test('global-off cleanup remains selected independently of library membership', async t => {
  const current = await fixture(t);
  const configuration = tmdbConfiguration({ EnabledMissingEpisodeLibraries: [nFormat(ids.firstCollection)] });
  const loaded = await current.loadContext(ids.series);
  const provider = createTmdbMissingEpisodeProvider({ configuration });
  assert.equal(provider.hasChanged(loaded.item, loaded.context), true);
  const result = await provider.fetch(loaded.item, { ...loaded.context,
    lifecycle: persistedTmdbCleanupLifecycle(current) });
  assert.equal(Boolean(result.UpdateType & ItemUpdateType.MetadataImport), true);
  await assertOwnedRemoved(current.db);
});
