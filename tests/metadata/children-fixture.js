import { testFileSystem } from '../storage/plugin-files.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader, metadataFields } from '../../src/library/metadata-context.js';
import { cleanValue, idKey } from '../../src/library/records.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const now = '2026-10-04T12:00:00.0000000Z';
const lists = ['Genres', 'Studios', 'Artists', 'AlbumArtists', 'Tags', 'ProductionLocations'];
const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const nativeType = type => type === 'LiveTvProgram' ? 'MediaBrowser.Controller.LiveTv.LiveTvProgram'
  : `MediaBrowser.Controller.Entities.${['Series', 'Season', 'Episode'].includes(type) ? 'TV.'
    : ['Audio', 'MusicArtist', 'MusicAlbum', 'MusicGenre'].includes(type) ? 'Audio.' : ['Movie', 'BoxSet'].includes(type) ? 'Movies.' : ''}${type}`;
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);

// These older C# fixtures explicitly control ApplicationHost.ReverseVirtualPath
// as an identity function. Apply that control to every recursively loaded item.
export function useIdentityPathReversalControl(fixture) {
  const original = fixture.loadContext;
  const loadContext = Object.assign(async (...args) => {
    const loaded = await original(...args);
    loaded.reversePath = value => value;
    loaded.reloadMetadataContext = loadContext;
    return loaded;
  }, original);
  loadContext.withContext = async (reference, options, operation) => {
    const loaded = await loadContext(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  fixture.loadContext = fixture.host.loadContext = loadContext;
}

export async function setupChildrenFixture(t) {
  const schema = 'metadata_children_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const configuration = { MetadataCountryCode: 'US', DisplaySpecialsWithinSeasons: true };
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-children-state-'));
  const spoolRoot = path.join(stateRoot, 'metadata-spool');
  await mkdir(spoolRoot);
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  await linkedChildren.initialize();
  const store = new DomainStore(database), library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'metadata-children', configuration,
    programDataPath: stateRoot });
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\ChildSelection', accessRoot: '/fixture/selection', style: 'windows', returnAccess: 'isolated child-selection controls' });
  identityMap.addPrefix({ identityRoot: 'Z:\\ChildrenMetadata', accessRoot: '/fixture/aggregate', style: 'windows', returnAccess: 'isolated child-aggregation controls' });
  // This isolated Z: namespace has no ancestor .ignore files. Declare that
  // through a separate fixture adapter, leaving D: instance state unmapped.
  await storage.createInstance('ignore-ancestors', 'memory', {});
  vfs.mount({ path: '/ignore-ancestors', instanceId: 'ignore-ancestors', capabilities: {} });
  identityMap.addPrefix({ identityRoot: 'Z:\\', accessRoot: '/ignore-ancestors', style: 'windows',
    returnAccess: 'Known empty ancestors of the controlled metadata namespace.' });
  const contextLoader = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, vfs, identityMap, configuration, spoolRoot });
  const contexts = new Set(), states = new Set();
  const trackContextLoader = loader => {
    const tracked = Object.assign(async (...args) => {
      const loaded = await loader(...args);
      if (!contexts.has(loaded)) {
        const dispose = loaded.dispose.bind(loaded); contexts.add(loaded);
        loaded.dispose = async (...options) => {
          try { await dispose(...options); } finally { contexts.delete(loaded); }
        };
        loaded.loadDraftContext = item => tracked(item.Id, { draft: item });
        loaded.reloadMetadataContext = tracked;
        const loadState = loaded.loadLibraryState?.bind(loaded);
        if (loadState) loaded.loadLibraryState = async (...options) => trackState(await loadState(...options));
      }
      return loaded;
    }, loader);
    tracked.withContext = async (reference, options, operation) => {
      const loaded = await tracked(reference, options);
      try { return await operation(loaded); } finally { await loaded.dispose(); }
    };
    return tracked;
  };
  const trackState = value => {
    if (!states.has(value)) {
      const dispose = value.dispose.bind(value); states.add(value);
      value.dispose = async (...options) => { try { await dispose(...options); } finally { states.delete(value); } };
    }
    return value;
  };
  const loadContext = trackContextLoader(contextLoader);
  const itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = itemCreation;
  const registry = new MetadataRegistry(), host = new MetadataRefreshHost({ registry, store, linkedChildren, vfs, loadContext, now: () => now });
  t.after(async () => {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => host.close());
    for (const loaded of [...contexts]) await attempt(() => loaded.dispose());
    for (const state of [...states]) await attempt(() => state.dispose());
    contexts.clear(); states.clear();
    await attempt(() => itemCreation.close());
    if (library.itemCreation !== itemCreation) await attempt(() => library.itemCreation?.close());
    await attempt(() => library.close()); await attempt(() => linkedChildren.flushReleases());
    await attempt(() => linkedChildren.close()); await attempt(() => storage.close());
    await attempt(() => database.client.query(`DROP SCHEMA "${schema}" CASCADE`));
    await attempt(() => database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`));
    await attempt(() => store.close()); await attempt(() => rm(stateRoot, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, 'Children fixture resources failed to close.');
  });
  const seed = async scenario => {
    await itemCreation.close();
    for (const table of ['LinkedChildren', 'AncestorIds', 'BaseItemMetadataFields', 'BaseItemProviders', 'ItemValuesMap', 'ItemValues', 'BaseItems']) {
      const primaryKey = tableDefinition(table).primaryKey;
      for (const row of await database.rows(table)) await database.delete(table, Object.fromEntries(primaryKey.map(key => [key, row[key]])));
    }
    configuration.DisplaySpecialsWithinSeasons = scenario.displaySpecials ?? true;
    const definitions = scenario.items;
    for (const [index, definition] of definitions.entries()) {
      const { key, type, parent, links, ancestors, LockedFields, ProviderIds, ...fields } = definition;
      const row = { ...empty, ...fields, Id: definition.Id, Name: Object.hasOwn(definition, 'Name') ? definition.Name : key ?? type, Path: definition.Path ?? null,
        ParentId: parent ? definitions.find(item => item.key === parent).Id : definition.ParentId ?? null,
        Type: nativeType(type), IsFolder: ['Folder', 'Series', 'Season', 'MusicAlbum', 'BoxSet', 'PhotoAlbum', 'AggregateFolder', 'UserRootFolder', 'CollectionFolder'].includes(type)
          || type === 'MusicArtist' && Boolean(parent ?? definition.ParentId),
        DateLastRefreshed: definition.DateLastRefreshed ?? now, SortName: definition.SortName ?? String(index).padStart(3, '0'), CleanName: cleanValue(definition.Name ?? key ?? type), Data: '{}'
      };
      const data = {};
      for (const [key, value] of Object.entries(row)) if (!Object.hasOwn(empty, key)) { data[key] = value; delete row[key]; }
      for (const list of lists) if (Array.isArray(row[list])) row[list] = row[list].join('|');
      row.Data = encode(data);
      await database.insert('BaseItems', row);
      for (const [ProviderId, ProviderValue] of Object.entries(ProviderIds ?? {})) await database.insert('BaseItemProviders', { ItemId: definition.Id, ProviderId, ProviderValue });
      for (const field of LockedFields ?? []) await database.insert('BaseItemMetadataFields', { ItemId: definition.Id, Id: metadataFields.indexOf(field) });
      for (const [type, list] of ['Artists', 'AlbumArtists', 'Genres', 'Studios', 'Tags'].entries()) for (const value of new Set(definition[list] ?? [])) {
        let record = (await database.rows('ItemValues', { where: { Type: type, Value: value } }))[0];
        if (!record) record = await database.insert('ItemValues', { ItemValueId: randomUUID(), Type: type, Value: value, CleanValue: cleanValue(value) });
        const { ItemValueId } = record;
        await database.insert('ItemValuesMap', { ItemValueId, ItemId: definition.Id });
      }
    }
    for (const definition of definitions) {
      for (const [SortOrder, child] of (definition.links ?? []).entries()) await database.insert('LinkedChildren', { ParentId: definition.Id, SortOrder, ChildType: 0, ChildId: definitions.find(item => item.key === child).Id });
      for (const ancestor of definition.ancestors ?? []) await database.insert('AncestorIds', { ItemId: definition.Id, ParentItemId: definitions.find(item => item.key === ancestor).Id });
    }
    return definitions.find(item => item.key === scenario.target).Id;
  };
  const state = () => store.run(async db => {
    const value = await library.load(db, null, { baseRows: await db.rows('BaseItems') });
    return trackState(value);
  });
  return { database, store, library, linkedChildren, loadContext, trackContextLoader, registry, host, seed, state, configuration, storage, adapter, vfs, identityMap, now, idKey, stateRoot, spoolRoot };
}
