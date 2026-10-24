import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { cloneNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from '../metadata/children-fixture.js';

const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const parentId = 'fc1c0000-0000-0000-0000-000000000001';
const childId = 'fc1c0000-0000-0000-0000-000000000002';
const childPath = 'Z:\\ChildSelection\\ExactDeletion\\Movie.mkv';
const project = item => ({ Id: item.Id, Name: item.Name, Path: item.Path });

async function fixtureFor(t) {
  const fixture = await setupChildrenFixture(t);
  useIdentityPathReversalControl(fixture);
  await fixture.seed({ target: 'parent', items: [
    { key: 'parent', type: 'Folder', Id: parentId, Name: 'Parent', Path: 'Z:\\ChildSelection\\ExactDeletion' },
    { key: 'child', type: 'Movie', Id: childId, Name: 'Persisted native child', Path: childPath, parent: 'parent',
      VideoType: 'VideoFile', IsShortcut: false, IsPlaceHolder: false, AdditionalParts: [],
      LocalAlternateVersions: [], LinkedAlternateVersions: [] }
  ] });
  const external = [], removed = [];
  const externalData = {
    async deleteInternalItemFiles(item) { external.push({ phase: 'internal', ...project(item) }); },
    async deleteItemFiles(item) { external.push({ phase: 'external', ...project(item) }); }
  };
  fixture.library.on('ItemRemoved', event => removed.push(project(event.Item)));
  const deletion = new ItemDeletionService({ ...fixture, itemCreation: fixture.library.itemCreation,
    updates: fixture.host.updates, externalData, linkedChildReferences: { async reroute() {} }, now: () => fixture.now });
  fixture.library.itemDeletion = deletion;
  return { ...fixture, deletion, external, removed };
}

async function emptyOwnedSelectionState(fixture) {
  await fixture.linkedChildren.flushOwnedReleases();
  await fixture.linkedChildren.flushReleases();
  await fixture.linkedChildren.withSession(async session => {
    for (const table of ['item_states', 'item_cohorts', 'pins']) assert.equal(BigInt((await session.client.query(
      `SELECT count(*) AS count FROM "${fixture.linkedChildren.schemaName}".${table}`)).rows[0].count), 0n, table);
  });
}

for (const cachedChildren of [false, true]) test('postgres: DeleteItem preserves '
  + (cachedChildren ? 'explicit independent Children' : 'cold repository Children')
  + ' when a different same-ID manager cache entity exists', options, async t => {
  const fixture = await fixtureFor(t), creator = fixture.library.itemCreation;
  const parent = await creator.getItemById(parentId), cached = await creator.getItemById(childId);
  const exact = cachedChildren ? cloneNativeItemEntity(cached) : null;
  if (exact) { exact.Name = 'Exact captured native child'; setFolderChildren(parent, [exact]); }
  cached.Name = 'Different manager cached child';
  cached.Path = 'Z:\\ChildSelection\\WrongCache\\Other.mkv';
  assert.equal(creator.getCachedItemById(childId), cached);
  const expectedChild = { Id: childId, Name: exact?.Name ?? 'Persisted native child', Path: childPath };
  // Native LibraryManager.DeleteItem (555-557, 599-602, 621-626) consumes the
  // GetRecursiveChildren result directly. It does not look these IDs up again.
  try {
    await fixture.store.run(async session => {
      const before = (await session.client.query('SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind=\'r\' ORDER BY relname')).rows;
      await fixture.library.deleteItem(parent, { DeleteFileLocation: false }, null);
      assert.deepEqual((await session.client.query('SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind=\'r\' ORDER BY relname')).rows, before);
    });
    assert.deepEqual(fixture.external, [
      { phase: 'internal', Id: parentId, Name: 'Parent', Path: parent.Path },
      { phase: 'internal', ...expectedChild },
      { phase: 'external', Id: parentId, Name: 'Parent', Path: parent.Path },
      { phase: 'external', ...expectedChild }
    ]);
    assert.deepEqual(fixture.removed, [expectedChild, { Id: parentId, Name: 'Parent', Path: parent.Path }]);
    assert.deepEqual(await fixture.database.rows('BaseItems', { whereIn: { Id: [parentId, childId] } }), []);
    assert.equal(creator.getCachedItemById(childId), null);
    await emptyOwnedSelectionState(fixture);
  } finally { if (exact) releaseNativeItemLinks(exact); await fixture.linkedChildren.flushReleases(); }
});

test('postgres: exact child selection keeps an actual SQL primary when its temporary metadata context also fails after release', options, async t => {
  const fixture = await fixtureFor(t), parent = await fixture.library.itemCreation.getItemById(parentId);
  const originalLoader = fixture.loadContext;
  let primary, cleanup, disposed = 0;
  fixture.deletion.loadContext = Object.assign(async (...args) => {
    const loaded = await originalLoader(...args);
    if ((typeof args[0] === 'string' ? args[0] : args[0].Id) === childId) {
      const dispose = loaded.dispose.bind(loaded);
      loaded.dispose = async (...options) => {
        await dispose(...options); disposed += 1;
        if (!cleanup) await fixture.store.run(async session => {
          try { await session.client.query('SELECT 1 / 0'); } catch (error) { cleanup = error; throw error; }
        });
      };
    }
    return loaded;
  }, originalLoader);
  fixture.database.queryHook = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    const values = typeof args[0] === 'string' ? args[1] : args[0].values;
    if (!primary && /^INSERT INTO "mm_delete_logical_/u.test(text) && values?.[0] === 1n) {
      try { await fixture.database.client.query("SELECT 'invalid-integer'::integer"); }
      catch (error) { primary = error; throw error; }
    }
    return fixture.database.client.query(...args);
  };
  try {
    await fixture.store.run(async session => {
      const before = (await session.client.query('SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind=\'r\' ORDER BY relname')).rows;
      await assert.rejects(fixture.library.deleteItem(parent, { DeleteFileLocation: false }, null), error => {
        assert.equal(primary?.code, '22P02'); assert.equal(cleanup?.code, '22012');
        assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, cleanup]); return true;
      });
      assert.deepEqual((await session.client.query('SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind=\'r\' ORDER BY relname')).rows, before);
    });
  } finally { fixture.database.queryHook = null; }
  assert.equal(disposed, 1);
  assert.deepEqual(fixture.external, []); assert.deepEqual(fixture.removed, []);
  assert.equal((await fixture.database.rows('BaseItems', { whereIn: { Id: [parentId, childId] } })).length, 2);
  await emptyOwnedSelectionState(fixture);
});
