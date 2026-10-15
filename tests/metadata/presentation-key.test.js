import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from './relations-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import { createPresentationUniqueKey } from '../../src/library/presentation-key.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
import { nativePersonIdentity } from '../../src/library/identity.js';

const bytes = await readFile(new URL('./fixtures/presentation-key/native.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a71ce54be60a852b9e3a2c969cde20db4d9f79b58bb3acc37636169542fd8115');
const native = JSON.parse(bytes);
assert.equal(native.actualFrozenCreatePresentationUniqueKey, true);
assert.equal(native.actualFrozenMetadataService, true);
assert.equal(native.actualFrozenLibraryContextMethods, true);
assert.equal(native.direct.length, 80); assert.equal(native.metadata.length, 24); assert.equal(native.contexts.length, 5);
assert.ok([...native.direct, ...native.metadata, ...native.contexts].every(sample => sample.error == null));
const episodeBytes = await readFile(new URL('./fixtures/episode-before-save/native.json', import.meta.url));
assert.equal(createHash('sha256').update(episodeBytes).digest('hex'), '5ad5dcc1487cf3f6fd0d85f134c04bd3bfafab2ace8f66c5f208b1f97433951e');
const episodeNative = JSON.parse(episodeBytes);
assert.equal(episodeNative.actualFrozenEpisodeMetadataService, true);
assert.equal(episodeNative.results.length, 8);
assert.ok(episodeNative.results.every(sample => sample.error == null && sample.actualServiceType === 'MediaBrowser.Providers.TV.EpisodeMetadataService'));

test('presentation keys match 80 actual entity virtual-method controls without conflating user-data keys', async t => {
  for (const [index, sample] of native.direct.entries()) await t.test(`${index}: ${sample.name}`, () => {
    const item = { ...sample.item, ProviderIds: sample.ProviderIds, SourceType: sample.SourceType, ExternalId: sample.ExternalId,
      PreferredMetadataLanguage: sample.PreferredMetadataLanguage, PrimaryVersionId: sample.primaryVersionId,
      IndexNumber: sample.IndexNumber, SeriesId: sample.seriesId };
    const metadataLanguage = sample.PreferredMetadataLanguage || sample.collections.find(folder => folder.PreferredMetadataLanguage)?.PreferredMetadataLanguage || sample.language;
    assert.equal(createPresentationUniqueKey(item, { libraryOptions: { EnableAutomaticSeriesGrouping: sample.grouping },
      metadataLanguage, collectionFolders: sample.collections, series: sample.series }), sample.key);
  });
});

const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column =>
  [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
const record = (Id, type, fields = {}) => ({ ...empty, Id, Type: `MediaBrowser.Controller.Entities.${type}`, Name: type,
  SortName: type.toLowerCase(), CleanName: type.toLowerCase(), Data: '{}', IsFolder: ['Folder', 'AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'TV.Series'].includes(type), ...fields });
const now = '2026-10-03T10:00:00Z';
async function fixture(t) {
  const schema = 'presentation_key_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  let directory, storage, library, linkedChildren, itemCreation;
  const contextLoaders = [];
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders,
      after: [() => storage?.close(), () => store.close()] });
    if (directory) {
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('mm-presentation-key-'));
      await rm(directory, { recursive: true, force: false });
    }
    const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try { await client.connect(); for (const name of [schema, schema + '__mm']) await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
      assert.equal((await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])', [[schema, schema + '__mm']])).rows.length, 0);
    } finally { await client.end(); }
  });
  directory = await mkdtemp(path.join(os.tmpdir(), 'mm-presentation-key-'));
  storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Fixture', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated presentation-key controls' });
  for (const name of ['Other', 'Libraries']) {
    const accessRoot = '/' + name.toLowerCase(); vfs.mount({ path: accessRoot, instanceId: 'fixture', capabilities: {} });
    identityMap.addPrefix({ identityRoot: 'Z:\\' + name, accessRoot, style: 'windows', returnAccess: 'isolated context controls without media reads' });
  }
  const spoolRoot = path.join(directory, 'metadata-spool');
  linkedChildren = await openMetadataRelations(database, spoolRoot);
  library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, serverId: 'presentation-key-test', programDataPath: directory });
  const loadContext = trackMetadataContexts(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap, configuration: { PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US' } }), contextLoaders);
  itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  return { database, store, library, linkedChildren, loadContext, vfs };
}

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: actual EpisodeMetadataService range correction precedes initial save and preserves this refresh's provider range`, options, async t => {
    const { database, store, loadContext, vfs, linkedChildren } = await fixture(t, dialect);
    const project = item => ({ key: item.PresentationUniqueKey, index: item.IndexNumber ?? null, end: item.IndexNumberEnd ?? null });
    for (const sample of episodeNative.results) await t.test(sample.control.Name, async () => {
      // Each native control constructs an independent entity. Release the
      // preceding control before reusing its repository ID in this fixture.
      await loadContext.close(); await loadContext.library.itemCreation.close();
      const Id = sample.before.Id.toUpperCase(), events = [], registry = new MetadataRegistry();
      await database.insert('BaseItems', record(Id, 'TV.Episode', { IndexNumber: sample.before.IndexNumber, SeasonName: sample.before.SeasonName,
        PresentationUniqueKey: sample.before.PresentationUniqueKey, DateLastRefreshed: sample.control.First ? null : sample.before.DateLastRefreshed,
        Data: JSON.stringify({ IndexNumberEnd: sample.before.IndexNumberEnd }) }));
      registry.register({ id: 'range-control', name: 'Range control', providers: [{ id: 'range-control', name: 'Range control', kind: 'custom', itemTypes: ['Episode'],
        hasChanged: () => sample.control.ProviderEnd != null,
        async fetch(item) {
          events.push({ kind: 'provider-before', ...project(item) });
          if (sample.control.First) assert.deepEqual(project((await loadContext(Id)).item), project(item), 'first repository save commits the corrected initial range before provider fetch');
          if (sample.control.ProviderEnd != null) {
            item.IndexNumber = sample.control.ProviderIndex; item.IndexNumberEnd = sample.control.ProviderEnd;
            events.push({ kind: 'provider-after', ...project(item) }); return ItemUpdateType.MetadataImport;
          }
          return ItemUpdateType.None;
        }
      }] });
      const host = new MetadataRefreshHost({ registry, loadContext, store, linkedChildren, vfs, now: () => now });
      host.updates.on('ItemUpdated', event => events.push({ kind: 'save', reason: event.UpdateReason, ...project(event.Item) }));
      host.updates.on('UserDataReattached', event => events.push({ kind: 'reattach', ...project(event.Item) }));
      try {
        const result = await host.refresh(Id, { MetadataRefreshMode: sample.control.Mode === 0 ? 'None' : 'Default', ImageRefreshMode: 'None' });
        assert.equal(result.UpdateType, sample.result); assert.equal(result.Failures, 0);
        assert.deepEqual(events, sample.events.map(event => ({ kind: event.kind,
          ...(event.kind === 'save' ? { reason: event.reason } : {}), ...project(event.item) })));
        assert.deepEqual(project((await loadContext(Id)).item), project(sample.item));
      } finally { await host.close(); await database.delete('BaseItems', { Id }); }
    });
  });
  test(`${dialect}: metadata context matches actual library and BaseItem language methods despite stale query ancestors`, options, async t => {
    for (const sample of native.contexts) await t.test(sample.name, async t => {
      const { database, library, loadContext } = await fixture(t, dialect);
      for (const row of sample.rows) {
        const { PhysicalLocationsList, PhysicalFolderIds, ...fields } = row;
        const Data = row.Type === 'CollectionFolder' ? JSON.stringify({ PhysicalLocationsList, PhysicalFolderIds }) : '{}';
        await database.insert('BaseItems', record(row.Id.toUpperCase(), row.Type === 'Series' ? 'TV.Series' : row.Type, { ...fields, Id: row.Id.toUpperCase(), ParentId: nonemptyId(row.ParentId) ? row.ParentId : null,
          Type: row.Type === 'Series' ? 'MediaBrowser.Controller.Entities.TV.Series' : `MediaBrowser.Controller.Entities.${row.Type}`, Data }));
      }
      for (const ParentItemId of sample.staleQueryAncestorIds) await database.insert('AncestorIds', { ItemId: sample.itemId, ParentItemId });
      library.options.libraryOptions = new Map(sample.configuredOptions.filter(entry => !entry.missing).map(entry => [idKey(entry.id), entry.value]));
      const loaded = await loadContext(sample.itemId);
      assert.deepEqual(loaded.collectionFolders.map(folder => idKey(folder.Id)), sample.actualFolders.map(idKey));
      assert.deepEqual(Object.fromEntries(Object.keys(sample.options).map(key => [key, loaded.libraryOptions[key]])), sample.options);
      assert.equal(loaded.item.MetadataLanguage, sample.language); assert.equal(loaded.item.MetadataCountryCode, sample.country);
      assert.equal(createPresentationUniqueKey(loaded.item, loaded), sample.key);
    });
  });
  test(`${dialect}: actual metadata host matches 24 native generic first/existing None/Default key-save controls`, options, async t => {
    const { database, store, library, loadContext, vfs, linkedChildren } = await fixture(t, dialect);
    for (const sample of native.metadata) await t.test(sample.name, async t => {
      await loadContext.close(); await library.itemCreation.close();
      const Id = sample.item.Id.toUpperCase(), events = [], registry = new MetadataRegistry();
      // This recording projects keys and save order, excluding path hooks.
      // A current instance directory gives the real Person hook no path change.
      const personPath = sample.kind === 'Person' ? nativePersonIdentity(sample.item.Name, library.options).Path : null;
      if (personPath) await mkdir(personPath, { recursive: true });
      await database.insert('BaseItems', record(Id, sample.kind === 'Movie' ? 'Movies.Movie' : sample.kind, {
        Name: sample.item.Name, ProductionYear: 2000, Path: personPath,
        PresentationUniqueKey: sample.initial === 'correct' ? sample.item.PresentationUniqueKey : sample.initial === 'stale' ? 'old-key' : null,
        DateLastRefreshed: sample.first ? null : '2026-10-03 09:00:00'
      }));
      registry.register({ id: 'key-control', name: 'Key control', providers: [{ id: 'key-control', name: 'Key control', kind: 'custom', itemTypes: [sample.kind],
        async fetch(item) {
          events.push({ kind: 'provider', key: item.PresentationUniqueKey });
          assert.equal((await database.rows('BaseItems', { where: { Id } }))[0].PresentationUniqueKey, sample.item.PresentationUniqueKey);
          return ItemUpdateType.None;
        }
      }] });
      const host = new MetadataRefreshHost({ registry, loadContext, store, linkedChildren, vfs, now: () => now });
      host.updates.on('ItemUpdated', event => events.push({ kind: 'save', reason: event.UpdateReason, key: event.Item.PresentationUniqueKey }));
      host.updates.on('UserDataReattached', () => events.push({ kind: 'reattach' }));
      try {
        const result = await host.refresh(Id, { MetadataRefreshMode: sample.mode === 0 ? 'None' : 'Default', ImageRefreshMode: 'None' });
        assert.equal(result.UpdateType, sample.result);
        assert.equal(result.Failures, 0);
        assert.deepEqual(events, sample.events.map(event => ({ kind: event.kind,
          ...(event.kind === 'save' ? { reason: event.reason, key: event.item.PresentationUniqueKey }
            : event.kind === 'provider' ? { key: event.item.PresentationUniqueKey } : {}) })));
        assert.equal((await database.rows('BaseItems', { where: { Id } }))[0].PresentationUniqueKey, sample.item.PresentationUniqueKey);
      } finally { await host.close(); await database.delete('BaseItems', { Id }); }
    });
  });
  test(`${dialect}: metadata context supplies actual library folders and stored parent-series keys`, options, async t => {
    const { database, library, loadContext } = await fixture(t, dialect);
    const Id = '99700000-0000-0000-0000-000000000001', root = '99700000-0000-0000-0000-000000000002', userRoot = '99700000-0000-0000-0000-000000000003', physical = '99700000-0000-0000-0000-000000000004';
    const collectionIds = ['ABCDEF01-0000-0000-0000-000000000002', 'ABCDEF01-0000-0000-0000-000000000001'];
    await database.insert('BaseItems', record(root, 'AggregateFolder'));
    await database.insert('BaseItems', record(userRoot, 'UserRootFolder'));
    await database.insert('BaseItems', record(physical, 'Folder', { ParentId: root, Path: 'Z:\\Fixture' }));
    for (const [index, collection] of collectionIds.entries()) {
      await database.insert('BaseItems', record(collection, 'CollectionFolder', { ParentId: userRoot, SortName: String(index),
        Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalLocationsList: ['Z:\\Fixture'] }) }));
    }
    library.options.libraryOptions = new Map(collectionIds.map(collection => [idKey(collection), { EnableAutomaticSeriesGrouping: true, PreferredMetadataLanguage: 'zh-CN' }]));
    await database.insert('BaseItems', record(Id, 'TV.Series', { Name: 'THE İ SERIES', ParentId: physical, Path: 'Z:\\Fixture\\show' }));
    const loaded = await loadContext(Id);
    assert.deepEqual(loaded.collectionFolders.map(folder => idKey(folder.Id)).sort(), collectionIds.map(idKey).sort());
    assert.equal(createPresentationUniqueKey(loaded.item, loaded), native.direct.find(sample => sample.name === 'series-name-True-THE İ SERIES').key);
    await database.update('BaseItems', { Id }, { PresentationUniqueKey: 'stored-series-key' });
    const seasonId = '99700000-0000-0000-0000-000000000005';
    await database.insert('BaseItems', record(seasonId, 'TV.Season', { ParentId: Id, SeriesId: Id, IndexNumber: -1 }));
    const season = await loadContext(seasonId);
    assert.equal(createPresentationUniqueKey(season.item, season), 'stored-series-key--001');
    await database.update('BaseItems', { Id: seasonId }, { SeriesId: physical });
    const invalid = await loadContext(seasonId);
    assert.equal(invalid.series, undefined);
    assert.equal(createPresentationUniqueKey(invalid.item, invalid), idKey(seasonId));
  });
}
