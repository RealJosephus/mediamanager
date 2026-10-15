import { testFileSystem } from '../storage/plugin-files.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, mapRecord } from '../../src/library/records.js';
import { persistItemRelations, itemSaveRelations } from '../../src/library/item-relations.js';
import { loadUserViewsNativeContract } from './fixtures/user-views/native-contract.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const id = number => `98900000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const row = (Id, Type, values = {}) => ({ ...Object.fromEntries(tableDefinition('BaseItems').columns
  .filter(column => !column.generated).map(column => [column.name, column.nullable ? null
    : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0])),
  Id, Type: 'MediaBrowser.Controller.Entities.' + Type, Name: Type, Data: '{}', ...values });

test('all 17 recorded UserViews derive native ancestors and inherited tags from actual collection folder paths',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const { native: stages, summary, manifest } = await loadUserViewsNativeContract();
  assert.equal(summary.passed, true);
  const native = stages.afterShutdown.database;
  const db = await createPostgresTestDatabase(t, 'user_view_relations_native');
  const store = new DomainStore(db);
  const programDataPath = path.join(manifest.referenceRoot, 'data');
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'item-relations-test', programDataPath, configuration: { UICulture: 'en-US' } });
  try {
    // These are copied observations. The frozen native database stays closed.
    for (const source of native.baseItems) await db.insert('BaseItems', { ...source, ParentId: null, OwnerId: null });
    for (const source of native.baseItems) await db.update('BaseItems', { Id: source.Id }, { ParentId: source.ParentId, OwnerId: source.OwnerId });
    const state = await library.load(db, null, { includeUserData: false, baseRows: await db.rows('BaseItems') });
    const views = state.items.filter(item => item.Type === 'UserView');
    assert.equal(views.length, 17);
    let inherited = 0;
    let isolated = 0;
    for (const view of views) {
      const parents = [];
      let parent = state.byId.get(idKey(view.ParentId));
      while (parent) { parents.push(parent); parent = state.byId.get(idKey(parent.ParentId)); }
      const collectionFolders = await library.getCollectionFolders(view);
      const actual = itemSaveRelations(view, { parents, collectionFolders });
      const expectedIds = native.ancestorIds.filter(entry => idKey(entry.ItemId) === idKey(view.Id)).map(entry => idKey(entry.ParentItemId)).sort();
      const expectedTags = native.itemValueLinks.filter(entry => idKey(entry.ItemId) === idKey(view.Id))
        .map(entry => native.itemValues.find(value => idKey(value.ItemValueId) === idKey(entry.ItemValueId)))
        .filter(value => value.Type === 6).map(value => value.Value).sort();
      assert.deepEqual(actual.ancestorIds.map(idKey).sort(), expectedIds, view.Name);
      assert.deepEqual([...actual.inheritedTags].sort(), expectedTags, view.Name);
      if (actual.inheritedTags.length) inherited++;
      if (!actual.ancestorIds.length) isolated++;
    }
    assert.equal(inherited, 5);
    assert.equal(isolated, 6);
  } finally { await library.close(); await store.close(); }
});

test('real parents and collections deduplicate GUIDs and tags without inheriting DisplayParentId', () => {
  const view = { Id: id(1), Type: 'UserView', DisplayParentId: id(2), Tags: ['Permit', '\u0085', '\ufeff', ' permit '] };
  const relation = itemSaveRelations(view, { parents: [{ Id: id(3), Tags: ['permit', 'Parent'] }],
    collectionFolders: [{ Id: id(3).toUpperCase(), Tags: ['PARENT', 'Collection'] }] });
  assert.deepEqual(relation, { ancestorIds: [id(3)], inheritedTags: ['Permit', '\ufeff', ' permit ', 'Parent', 'Collection'] });
  assert.deepEqual(itemSaveRelations({ ...view, Tags: [] }), { ancestorIds: [], inheritedTags: [] });
});

test('UserView creation and replacement persist valid ancestors, exact values and remove stale maps',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'user_view_relations_persist');
  const store = new DomainStore(db);
  const view = mapRecord(row(id(1), 'UserView', { Tags: 'Permit' }));
  const collection = { Id: id(2), Type: 'CollectionFolder', Tags: ['Parent'] };
  const stale = id(3), directValue = id(4), inheritedValue = id(5), reusedValue = id(6);
  try {
    for (const source of [row(view.Id, 'UserView'), row(collection.Id, 'CollectionFolder'), row(stale, 'Folder')]) await db.insert('BaseItems', source);
    for (const source of [{ ItemValueId: directValue, Type: 4, Value: 'Permit', CleanValue: 'permit' },
      { ItemValueId: inheritedValue, Type: 6, Value: 'permit', CleanValue: 'permit' },
      { ItemValueId: reusedValue, Type: 6, Value: 'Parent', CleanValue: 'parent' }]) await db.insert('ItemValues', source);
    await db.insert('ItemValuesMap', { ItemId: view.Id, ItemValueId: directValue });
    await db.insert('ItemValuesMap', { ItemId: view.Id, ItemValueId: inheritedValue });
    await db.insert('AncestorIds', { ItemId: view.Id, ParentItemId: stale });
    const result = await store.transaction(connection => persistItemRelations(connection, view,
      { collectionFolders: [collection, { Id: id(999), Tags: [] }] }));
    assert.deepEqual(result, { ancestorIds: [collection.Id], inheritedTags: ['Permit', 'Parent'] });
    assert.deepEqual(await db.rows('AncestorIds'), [{ ItemId: view.Id, ParentItemId: collection.Id }]);
    const values = await db.rows('ItemValues');
    const created = values.filter(value => value.Type === 6 && value.Value === 'Permit');
    assert.equal(created.length, 1);
    assert.notEqual(created[0].ItemValueId, inheritedValue);
    assert.equal(created[0].CleanValue, 'permit');
    const expectedIds = [directValue, created[0].ItemValueId, reusedValue].sort();
    assert.deepEqual((await db.rows('ItemValuesMap')).map(map => map.ItemValueId).sort(), expectedIds);
    const before = await db.rows('ItemValues');
    await store.transaction(connection => persistItemRelations(connection, view, { collectionFolders: [collection] }));
    assert.deepEqual(await db.rows('ItemValues'), before);
    await store.transaction(connection => persistItemRelations(connection, { ...view, Tags: [] }));
    assert.deepEqual(await db.rows('AncestorIds'), []);
    assert.deepEqual(await db.rows('ItemValuesMap'), []);
    assert.deepEqual(await db.rows('ItemValues'), before);
  } finally { await store.close(); }
});
