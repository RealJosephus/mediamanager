import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { EMPTY_ID, idKey, nonemptyId } from '../../src/library/records.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { parentChainForItem, collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { LibraryService, DirectoryItemResolverPipeline } from '../../src/library/index.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { createFolderValidationScanFixture } from '../helpers/folder-validation-scan-fixture.js';

import { itemListColumn, itemListFields } from '../../src/library/item-list-columns.js';

const root = new URL('./fixtures/item-list-columns/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const names = new Map(native.results.map(value => [input.find(sample => sample.name === value.name).item.type, value.nativeType]));
const nativeType = type => names.get(type) ?? 'MediaBrowser.Controller.Entities.' + type;
const related = definition => {
  const { id, type, ...values } = definition;
  return applyNativeItemValues(newNativeItemEntity(nativeType(type)), values, { Id: id, Name: type });
};
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const rowFor = definition => ({ ...blank, Id: definition.Id, Type: definition.NativeType, Name: definition.Name, SortName: definition.Name,
  Path: definition.Path ?? null, ParentId: nonemptyId(definition.ParentId) ? definition.ParentId : null,
  OwnerId: nonemptyId(definition.OwnerId) ? definition.OwnerId : null, IsFolder: definition.IsFolder,
  Tags: (definition.Tags ?? []).join('|'), Data: JSON.stringify({ PhysicalLocationsList: definition.PhysicalLocationsList ?? [], PhysicalFolderIds: definition.PhysicalFolderIds ?? [] }) });

test('native nullable list save seals actual CreateItems, literal collection lookup and verified deterministic identities', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(native.actualFrozenItemListColumns, true); assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
  assert.equal(input.length, 12); assert.equal(native.results.length, 12);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.deepEqual(native.results.filter(value => value.exception != null).map(value => [value.name, value.exception, value.exceptionParameter]), [['Genres-null', 'ArgumentNullException', 'source'], ['Studios-null', 'ArgumentNullException', 'source'], ['Tags-null', 'ArgumentNullException', 'collection'], ['Artists-null', 'ArgumentNullException', 'source'], ['AlbumArtists-null', 'ArgumentNullException', 'source']]);
});
test('nullable list comparison rejects wrong inferred collections, lost values and failed NULL policy', () => {
  const expected = native.results.find(value => value.name === 'Genres-values');
  for (const mutate of [value => value.ancestors.pop(), value => value.maps.pop(), value => value.collectionIds.push(input[0].collections[1].id), value => { value.storedDataIsNull = !value.storedDataIsNull; }]) {
    const changed = structuredClone(expected); mutate(changed);
    assert.throws(() => compare(changed, expected), assert.AssertionError);
  }
});
async function databaseFor(t, dialect) {
  const schema = 'scan_item_save_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => { if (dialect === 'postgres') { await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); } await store.close(); });
  return { database, store };
}
function stateFor(sample) {
  const item = related(sample.item), parents = sample.parents.map(related), folders = sample.collections.map(related);
  if (!Object.hasOwn(sample.item, 'ParentId')) item.ParentId = parents[0]?.Id ?? EMPTY_ID;
  parents.forEach((parent, index) => { parent.ParentId = parents[index + 1]?.Id ?? EMPTY_ID; });
  const items = [item, ...parents, ...folders];
  return { item, parents, folders, state: { items, byId: new Map(items.map(item => [idKey(item.Id), item])) } };
}
async function seedRelations(database, sample, { item, parents, folders }) {
  const definitions = new Map([item, ...parents, ...folders].map(value => [idKey(value.Id), value]));
  for (const persisted of sample.persistedItems) await database.insert('BaseItems', definitions.has(idKey(persisted.id))
    ? { ...rowFor(definitions.get(idKey(persisted.id))), ParentId: null, OwnerId: null } : { ...blank, Id: persisted.id, Type: nativeType('Folder'), Name: 'Seed' });
  for (const persisted of sample.persistedItems) {
    const definition = definitions.get(idKey(persisted.id));
    if (definition) {
      const row = rowFor(definition);
      await database.update('BaseItems', { Id: persisted.id }, { ParentId: row.ParentId, OwnerId: row.OwnerId });
    }
  }
  for (const value of sample.values) { await database.insert('ItemValues', { ItemValueId: value.id, Type: value.type, Value: value.value, CleanValue: value.cleanValue });
    for (const ItemId of value.items) await database.insert('ItemValuesMap', { ItemId, ItemValueId: value.id }); }
  for (const ParentItemId of sample.ancestors) await database.insert('AncestorIds', { ItemId: sample.item.id, ParentItemId });
}
async function capture(database, sample) {
  const values = await database.rows('ItemValues'), seeded = new Set(sample.values.map(value => idKey(value.id)));
  const valueId = id => { const value = values.find(value => idKey(value.ItemValueId) === idKey(id)); assert.ok(value);
    return seeded.has(idKey(id)) ? id.toLowerCase() : '$NEW/' + value.Type + '/' + value.Value; };
  const stored = (await database.rows('BaseItems')).find(row => idKey(row.Id) === idKey(sample.item.id));
  assert.ok(stored, 'The real creation path must preserve the native deterministic identity.');
  return { values: values.map(value => ({ id: valueId(value.ItemValueId), type: value.Type, value: value.Value, cleanValue: value.CleanValue })).sort((a, b) => ordinal(a.id, b.id)),
    maps: (await database.rows('ItemValuesMap')).map(row => ({ itemId: row.ItemId.toLowerCase(), valueId: valueId(row.ItemValueId) })).sort((a, b) => ordinal(a.itemId, b.itemId) || ordinal(a.valueId, b.valueId)),
    ancestors: (await database.rows('AncestorIds')).map(row => ({ itemId: row.ItemId.toLowerCase(), parentId: row.ParentItemId.toLowerCase() })).sort((a, b) => ordinal(a.itemId, b.itemId) || ordinal(a.parentId, b.parentId)),
    storedDataIsNull: stored.Data === null,
    columns: Object.fromEntries(['Artists', 'AlbumArtists', 'Genres', 'Studios', 'Tags', 'ProductionLocations'].map(key => [key, stored[key]])) };
}
for (const sample of input) test('native mapper display columns ' + sample.name, () => {
  const expected = native.results.find(value => value.name === sample.name), item = related(sample.item);
  let columns, error;
  try { columns = Object.fromEntries(itemListFields.map(field => [field, itemListColumn(item, field)])); }
  catch (failure) { error = failure; }
  assert.equal(error?.nativeException ?? null, expected.mapperException);
  assert.equal(error?.parameterName ?? null, expected.mapperParameter);
  if (!error) compare(columns, expected.mapperColumns);
});
const savedProjection = expected => Object.fromEntries(['values', 'maps', 'ancestors', 'storedDataIsNull', 'columns'].map(key => [key, expected[key]]));
for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: actual collection discovery feeds metadata save ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, store } = await databaseFor(t, dialect), current = stateFor(sample), expected = native.results.find(value => value.name === sample.name);
    await seedRelations(database, sample, current);
    const { item, state, folders } = current;
    const collections = collectionFoldersForItem(item, state, folders);
    compare(collections.map(value => value.Id), expected.collectionIds);
    if (!(await database.rows('BaseItems', { where: { Id: item.Id } })).length) await database.insert('BaseItems', rowFor(item));
    const loaded = { item, snapshot: (await database.rows('BaseItems', { where: { Id: item.Id } }))[0], relationships: {},
      parents: parentChainForItem(item, state), collectionFolders: collections, sortName: () => item.Name };
    const before = {};
    for (const table of ['BaseItems', 'ItemValues', 'ItemValuesMap', 'AncestorIds']) before[table] = await database.rows(table);
    if (expected.exception) {
      await assert.rejects(persistMetadata(store, loaded, { Item: item }), failure => failure.nativeException === expected.exception
        && failure.parameterName === expected.exceptionParameter);
      for (const [table, rows] of Object.entries(before)) compare(await database.rows(table), rows);
      return;
    }
    await persistMetadata(store, loaded, { Item: item });
    compare(await capture(database, sample), savedProjection(expected));
  });

const scanSamples = input.filter(sample => sample.parents.length > 0 && !['Season', 'Episode'].includes(sample.item.type)
  && !['stale-persisted-ancestor', 'repeat-create'].includes(sample.name));
for (const dialect of ['postgres']) for (const sample of scanSamples) test(`${dialect}: Folder validation creates native relations ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, store } = await databaseFor(t, dialect), current = stateFor(sample), expected = native.results.find(value => value.name === sample.name);
    const userRootId = '97b00000-0000-0000-0000-000000000008';
    await seedRelations(database, sample, current);
    await database.insert('BaseItems', { ...blank, Id: userRootId, Type: nativeType('UserRootFolder'), Name: 'User root', IsFolder: true, Data: '{}' });
    for (const folder of current.folders) await database.update('BaseItems', { Id: folder.Id }, { ParentId: userRootId });
    const registry = new StorageRegistry(); registry.registerType('memory', options => new MemoryStorageAdapter(options));
    const adapter = await registry.createInstance('library', 'memory', {}), vfs = new VirtualFileSystem(registry);
    vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} });
    const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Library', accessRoot: '/library', style: 'windows', returnAccess: 'Isolated creation control' });
    if (current.item.IsFolder) await adapter.mkdir('/Child'); else await adapter.write('/Child', Buffer.from('isolated source'));
    const programDataPath = 'C:\\ProgramData\\MediaManager', configuration = { EnableCaseSensitiveItemIds: sample.caseSensitive === true };
    const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'item-list-columns', configuration });
    const lists = Object.fromEntries(itemListFields.map(field => [field, sample.item[field]]));
    const claim = candidate => ({ nativeType: expected.nativeType, primary: candidate, consumedPaths: [candidate], traversal: 'none',
      draft: { Name: sample.item.type, IsFolder: current.item.IsFolder, MediaType: ['Audio', 'AudioBook'].includes(sample.item.type) ? 'Audio' : current.item.IsFolder ? 'Unknown' : 'Video', SourceType: 'Library', data: lists } });
    const resolver = { id: 'controlled-item', priority: 10, nativeTypes: { [expected.nativeType]: { isFolder: current.item.IsFolder } },
      resolveDirectory: ({ candidate }) => claim(candidate), resolveFile: ({ candidate }) => claim(candidate) };
    const resolverPipeline = new DirectoryItemResolverPipeline({ programDataPath, configuration, resolvers: [resolver] });
    const lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, configuration });
    const validationFixture = createFolderValidationScanFixture({ store, library, vfs, identityMap,
      ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: ['Z:\\Library'] }),
      programDataPath, configuration, resolverPipeline, lifecycleFixture });
    t.after(async () => { await validationFixture.close(); await lifecycleFixture.close(); await registry.close(); });
    const calls = []; library.on('ItemAdded', ({ Item, Parent }) => calls.push({ action: 'added', id: Item.Id.toLowerCase(), parentId: Parent?.Id.toLowerCase() }));
    const validate = () => validationFixture.itemCreation.withItem(current.parents[0].Id, parent =>
      validationFixture.validation.validateChildren(parent, { refreshChildMetadata: false }));
    const before = {};
    for (const table of ['BaseItems', 'ItemValues', 'ItemValuesMap', 'AncestorIds']) before[table] = await database.rows(table);
    if (expected.exception) {
      await assert.rejects(validate(), failure => failure.nativeException === expected.exception
        && failure.parameterName === expected.exceptionParameter);
      for (const [table, rows] of Object.entries(before)) compare(await database.rows(table), rows);
      compare(calls, []); return;
    }
    const receipt = await validate(); assert.equal(receipt.created.length, 1);
    compare(await capture(database, sample), savedProjection(expected)); compare(calls, expected.calls);
    const second = await validate(); assert.equal(second.created.length, 0);
    compare(await capture(database, sample), savedProjection(expected)); assert.equal(calls.length, 1);
  });
