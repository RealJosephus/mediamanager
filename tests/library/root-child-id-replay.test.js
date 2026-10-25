import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { withPostgresCachedFolderChildren } from '../../src/library/postgres-cached-folder-children.js';
import { cachedFolderChildrenSnapshot, clearFolderChildIds, releaseCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { createMetadataChildren } from '../../src/library/metadata-children.js';
import { physicalCollectionFolders } from '../../src/library/collection-physical-folders.js';
import { idKey } from '../../src/library/records.js';
import { assignTestLinks, readTestLinks } from './collection-test-consumers.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = value => `46b10000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const type = value => 'MediaBrowser.Controller.Entities.' + value;
const row = (Id, Type, ParentId, values = {}) => postgresTestRow('BaseItems', {
  Id, Type: type(Type), ParentId, Name: Type + ' ' + Id.slice(-2), IsFolder: true, Path: '/children/' + Id.slice(-2), Data: '{}', ...values,
});

async function setup(t) {
  const database = await createPostgresTestDatabase(null, 'root_child_ids', { max: 1 });
  const linkedChildren = new PostgresLinkedChildrenStore({ database });
  await linkedChildren.initialize();
  const store = new DomainStore(database), library = new LibraryService({ store, linkedChildren, serverId: 'root-child-ids',
    configuration: { CacheSize: 8 }, userRoot: { Id: id(2), Type: type('UserRootFolder'), Path: '/children/root', Data: '{}' } });
  const manager = new ItemCreationService({ store, library, linkedChildren, loadContext: async () => { throw new Error('Metadata is outside this child-cache read.'); } });
  library.itemCreation = manager;
  const owners = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures = [];
    for (const action of [...owners.map(owner => () => owner.release()), () => manager.close(), () => library.close(),
      () => linkedChildren.flushOwnedReleases(), () => linkedChildren.close()]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Root child-ID owners failed to close.');
  };
  t.after(async () => { try { await close(); } finally { await dropPostgresTestDatabase(database); } });
  const root = async value => {
    const item = await manager.getItemById(value); owners.push(manager.retainItem(item)); return item;
  };
  const snapshot = (item, operation) => store.run(session => withPostgresCachedFolderChildren({ session, library, item }, operation));
  const values = item => snapshot(item, async source => {
    const result = [];
    for await (const page of source.pages()) result.push(...page.map(child => ({ Id: idKey(child.Id), Name: child.Name })));
    return result;
  });
  return { database, linkedChildren, library, manager, root, snapshot, values, close };
}

for (const rootType of ['AggregateFolder', 'UserRootFolder']) test(`postgres: ${rootType} replays fixed child IDs through the current manager and exact mutable branches`, {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t), rootId = rootType === 'AggregateFolder' ? id(1) : id(2);
  await f.database.insertBatch('BaseItems', [row(rootId, rootType, null),
    row(id(10), 'CollectionFolder', rootId, { Name: 'Stored first', SortName: 'a' }),
    row(id(11), 'CollectionFolder', rootId, { Name: 'Stored second', SortName: 'z' })]);
  const root = await f.root(rootId);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: 'Stored first' }, { Id: idKey(id(11)), Name: 'Stored second' }]);
  const alias = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(alias, { Id: id(10), Name: 'Current manager first', Path: '/live/first', ParentId: id(99),
    ForcedSortName: 'zzzz', PhysicalLocationsList: ['/media/current'] });
  await assignTestLinks(f, alias, [{ ItemId: null, Type: 0, Path: '/unresolved', LibraryItemId: null }]);
  f.manager.registerItem(alias);
  const currentHandle = alias.LinkedChildren;
  await f.database.insert('BaseItems', row(id(12), 'CollectionFolder', rootId, { Name: 'New repository sibling', SortName: '0' }));
  await f.database.update('BaseItems', { Id: id(11) }, { SortName: '0' });
  releaseCachedFolderChildren(root);
  await f.snapshot(root, async source => {
    await source.withPage({}, async page => {
      assert.deepEqual(page.entries.map(entry => idKey(entry.item.Id)), [idKey(id(10)), idKey(id(11))]);
      assert.equal(page.entries[0].item, alias);
      assert.equal(page.entries[0].item.ParentId, id(99));
      assert.equal(page.entries[0].item.LinkedChildren, currentHandle);
      await f.linkedChildren.recordResolution(currentHandle, 1n, id(80));
      await source.flush();
      assert.equal((await readTestLinks(page.entries[0].item))[0].ItemId, id(80));
    });
  });
  const warm = newNativeItemEntity(type('Folder')); warm.Id = id(90); warm.Name = 'Explicit warm child';
  setFolderChildren(root, [warm]);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(90)), Name: 'Explicit warm child' }]);
  releaseCachedFolderChildren(root);
  assert.equal((await f.values(root))[0].Name, alias.Name, 'An explicit warm assignment must not overwrite the stored ID list.');
  f.manager.unregisterItem(id(11));
  await f.database.delete('BaseItems', { Id: id(11) });
  releaseCachedFolderChildren(root);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: alias.Name }]);
  await f.database.insert('BaseItems', row(id(11), 'CollectionFolder', rootId, { Name: 'Reappeared second', SortName: '0' }));
  releaseCachedFolderChildren(root);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: alias.Name }, { Id: idKey(id(11)), Name: 'Reappeared second' }],
    'Missing resolutions do not erase the original IDs or their order.');
  setFolderChildren(root, null);
  const reset = await f.values(root);
  if (rootType === 'AggregateFolder') assert.deepEqual(reset.map(child => child.Name), ['Reappeared second', 'New repository sibling', 'Stored first']);
  else assert.deepEqual(reset.map(child => child.Name), [alias.Name, 'Reappeared second']);
  clearFolderChildIds(root); releaseCachedFolderChildren(root);
  assert.deepEqual((await f.values(root)).map(child => child.Name), ['Reappeared second', 'New repository sibling', 'Stored first']);
  await f.close();
  assert.equal((await f.database.client.query('SELECT to_regnamespace($1) AS namespace', [f.linkedChildren.schemaName])).rows[0].namespace, null);
});

for (const rootType of ['AggregateFolder', 'UserRootFolder']) test(`postgres: cold ${rootType} Children keep their occurrence until release admits the current manager alias`, {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t), rootId = rootType === 'AggregateFolder' ? id(1) : id(2);
  await f.database.insertBatch('BaseItems', [row(rootId, rootType, null),
    row(id(10), 'CollectionFolder', rootId, { Name: 'Stored cold occurrence' })]);
  const root = await f.root(rootId);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: 'Stored cold occurrence' }]);
  const alias = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(alias, { Id: id(10), Name: 'Current manager alias', ParentId: id(99), Path: '/current/manager' });
  f.manager.registerItem(alias);
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: 'Stored cold occurrence' }],
    'Registering a same-Guid manager value must not replace already populated Children.');
  releaseCachedFolderChildren(root);
  await f.snapshot(root, source => source.withPage({}, async page => {
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].item, alias, 'The retained original ID now resolves through the formal manager.');
    assert.equal(page.entries[0].item.ParentId, id(99));
  }));
  alias.Name = 'Current manager mutation';
  assert.deepEqual(await f.values(root), [{ Id: idKey(id(10)), Name: alias.Name }],
    'Once replayed, that exact manager occurrence remains mutable inside populated Children.');
});

test('postgres: empty UserRoot IDs remain empty while empty Aggregate IDs reload after releasing Children', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(1), 'AggregateFolder', null), row(id(2), 'UserRootFolder', null)]);
  const aggregate = await f.root(id(1)), userRoot = await f.root(id(2));
  assert.deepEqual(await f.values(aggregate), []); assert.deepEqual(await f.values(userRoot), []);
  await f.database.insertBatch('BaseItems', [row(id(10), 'Folder', id(1)), row(id(11), 'CollectionFolder', id(2))]);
  releaseCachedFolderChildren(aggregate); releaseCachedFolderChildren(userRoot);
  assert.deepEqual((await f.values(aggregate)).map(child => child.Id), [idKey(id(10))]);
  assert.deepEqual(await f.values(userRoot), []);
  clearFolderChildIds(userRoot); releaseCachedFolderChildren(userRoot);
  assert.deepEqual((await f.values(userRoot)).map(child => child.Id), [idKey(id(11))]);
});

test('postgres: child-ID replay requires the formal manager rather than substituting a request same-ID row', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(2), 'UserRootFolder', null), row(id(10), 'CollectionFolder', id(2))]);
  const root = await f.root(id(2)); await f.values(root); releaseCachedFolderChildren(root);
  f.library.itemCreation = null;
  try { await assert.rejects(f.values(root), /requires the formal item manager/u); }
  finally { f.library.itemCreation = f.manager; }
});

test('postgres: raw collection membership uses live replayed locations in SQL and preserves null-list short circuits', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(1), 'AggregateFolder', null), row(id(2), 'UserRootFolder', null),
    row(id(3), 'Folder', id(1), { Path: '/media/current' }),
    row(id(10), 'CollectionFolder', id(2), { Data: '{"PhysicalLocationsList":["/media/stored"]}' })]);
  const root = await f.root(id(2)); await f.values(root);
  const target = await f.manager.getItemById(id(3)), alias = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(alias, { Id: id(10), Name: 'Manager locations', Path: '/config/live', ParentId: id(99), PhysicalLocationsList: ['/media/current'] });
  f.manager.registerItem(alias); releaseCachedFolderChildren(root);
  assert.deepEqual(await f.library.getCollectionFolders(target), [alias]);
  alias.PhysicalLocationsList[0] = '/media/other';
  assert.deepEqual(await f.library.getCollectionFolders(target), []);
  alias.PhysicalLocationsList = null; target.Path = alias.Path;
  assert.deepEqual(await f.library.getCollectionFolders(target), [alias]);
  target.Path = '/media/missing';
  await assert.rejects(f.library.getCollectionFolders(target), { status: 500, message: "Value cannot be null. (Parameter 'source')" });
});

test('postgres: complete root ID capture and manager replay cross the SQL boundary only in bounded pages', {
  skip: !postgresTestConnectionString, timeout: 180000,
}, async t => {
  const f = await setup(t), definitions = Array.from({ length: 257 }, (_, index) =>
    row(id(100 + index), 'CollectionFolder', id(2), { SortName: String(index).padStart(4, '0') }));
  await f.database.insert('BaseItems', row(id(2), 'UserRootFolder', null));
  await f.database.insertBatch('BaseItems', definitions);
  const root = await f.root(id(2)), original = f.database.client.query;
  let maximumRows = 0;
  f.database.client.query = async (...args) => {
    const result = await original(...args);
    for (const batch of Array.isArray(result) ? result : [result]) maximumRows = Math.max(maximumRows, batch.rows?.length ?? 0);
    return result;
  };
  try {
    assert.deepEqual((await f.values(root)).map(child => child.Id), definitions.map(child => idKey(child.Id)));
    releaseCachedFolderChildren(root);
    assert.deepEqual((await f.values(root)).map(child => child.Id), definitions.map(child => idKey(child.Id)));
    assert.equal(maximumRows, 128);
  } finally { f.database.client.query = original; }
});

test('postgres: root navigation visibility cannot replace replayed manager occurrences with a request directory cache', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(2), 'UserRootFolder', null), row(id(10), 'CollectionFolder', id(2))]);
  const root = await f.root(id(2)); await f.values(root);
  const alias = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(alias, { Id: id(10), Name: 'Live restricted library', Path: '/manager/library', ParentId: id(99),
    PhysicalLocationsList: ['/media/current'], Tags: ['blocked-live'] });
  f.manager.registerItem(alias); releaseCachedFolderChildren(root);
  const user = { Id: id(90), Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
    BlockedTags: ['blocked-live'], AllowedTags: [], BlockUnratedItems: [] }, Configuration: {} };
  await f.library.store.run(async session => {
    const state = await f.library.loadNavigation(session, user, { includeUserData: false });
    try { assert.deepEqual(f.library.rootChildren(state, user), []); }
    finally { await state.dispose({ session }); }
  });
  assert.equal(cachedFolderChildrenSnapshot(root), undefined, 'SQL readers do not publish a second JS Children authority.');
  await f.snapshot(root, source => source.withPage({}, page => {
    assert.equal(page.entries[0].item, alias);
    assert.equal(page.entries[0].item.Name, 'Live restricted library');
    assert.deepEqual(page.entries[0].item.Tags, ['blocked-live']);
  }));
  user.Policy.BlockedTags = [];
  await f.library.store.run(async session => {
    const state = await f.library.loadNavigation(session, user, { includeUserData: false });
    try { assert.deepEqual(f.library.rootChildren(state, user), [alias]); }
    finally { await state.dispose({ session }); }
  });
});

test('postgres: metadata physical children consume the shared root ID replay and exact manager branches', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(2), 'UserRootFolder', null), row(id(10), 'CollectionFolder', id(2))]);
  const root = await f.root(id(2)); await f.values(root);
  const alias = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(alias, { Id: id(10), Name: 'Metadata manager library', Path: '/manager/library', ParentId: id(99) });
  await assignTestLinks(f, alias, [{ ItemId: null, Type: 0, Path: '/metadata/unresolved', LibraryItemId: null }]);
  f.manager.registerItem(alias); releaseCachedFolderChildren(root);
  const children = await createMetadataChildren({ store: f.library.store, library: f.library,
    linkedChildren: f.linkedChildren }).physical(root, { preserveDuplicates: true });
  try {
    assert.equal(await children.count(), 1n);
    await children.withItemAtOrdinal(1n, async item => {
      assert.equal(item, alias);
      await f.linkedChildren.recordResolution(item.LinkedChildren, 1n, id(80));
      item.Name = 'Changed by metadata consumer';
    });
  } finally { await children.close(); }
  assert.equal((await f.values(root))[0].Name, 'Changed by metadata consumer');
  assert.equal((await readTestLinks(alias))[0].ItemId, id(80));
});

test('postgres: collection physical-folder selection and cached IDs resolve the current manager Folder type and path', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(1), 'AggregateFolder', null), row(id(10), 'Folder', id(1)),
    row(id(20), 'CollectionFolder', null, { Path: '/collection/config', Data: '{"PhysicalLocationsList":["/manager/physical/"]}' })]);
  const aggregate = await f.root(id(1)); await f.values(aggregate);
  const alias = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.MusicArtist');
  Object.assign(alias, { Id: id(10), Name: 'Current physical artist', Path: '/manager/physical', ParentId: null });
  assert.equal(alias.IsFolder, false, 'OfType<Folder> includes a root MusicArtist even when IsFolder is false.');
  f.manager.registerItem(alias); releaseCachedFolderChildren(aggregate);
  await f.library.store.run(async session => {
    const state = await f.library.load(session, null, { includeUserData: false, baseRows: await session.rows('BaseItems') });
    try {
      const item = state.byId.get(idKey(id(20)));
      const findByPath = () => { throw new Error('The shared root replay must match the live path before repository fallback.'); };
      assert.deepEqual(await physicalCollectionFolders(item, state, { session, findByPath }), [alias]);
      item.PhysicalFolderIds = [id(10), id(10)];
      assert.deepEqual(await physicalCollectionFolders(item, state, { session, enableCache: true, findByPath }), [alias, alias]);
      const first = Object.assign(newNativeItemEntity(type('Folder')), { Id: id(30), Name: 'First location branch', Path: '/physical/first' });
      const later = Object.assign(newNativeItemEntity(type('Folder')), { Id: id(30).toUpperCase(), Name: 'Earlier root branch', Path: '/physical/later' });
      const other = Object.assign(newNativeItemEntity(type('Folder')), { Id: id(31), Name: 'Second location identity', Path: later.Path });
      await assignTestLinks(f, first, [{ ItemId: null, Type: 0, Path: '/first/unresolved', LibraryItemId: null }]);
      await assignTestLinks(f, later, [{ ItemId: null, Type: 0, Path: '/later/unresolved', LibraryItemId: null }]);
      const firstHandle = first.LinkedChildren;
      setFolderChildren(aggregate, [later, other, first]);
      item.PhysicalLocationsList = [first.Path, later.Path];
      const selected = await physicalCollectionFolders(item, state, { session, findByPath });
      assert.deepEqual(selected, [first, other], 'Location order precedes root order, and SQL keeps the first exact same-Guid occurrence.');
      assert.equal(selected[0].LinkedChildren, firstHandle);
      await f.linkedChildren.recordResolution(selected[0].LinkedChildren, 1n, id(80));
      assert.equal((await readTestLinks(first))[0].ItemId, id(80));
      assert.equal((await readTestLinks(later))[0].ItemId, null);
    } finally { await state.dispose({ session }); }
  });
});

test('postgres: live visibility preserves own-country short circuits and complete matching-folder tag consumption', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(1), 'AggregateFolder', null), row(id(2), 'UserRootFolder', null),
    row(id(3), 'Folder', id(1), { Path: '/media/current' })]);
  const root = await f.root(id(2)), first = newNativeItemEntity(type('CollectionFolder')), late = newNativeItemEntity(type('CollectionFolder'));
  Object.assign(first, { Id: id(10), Path: '/views/first', PhysicalLocationsList: ['/media/current'],
    PreferredMetadataCountryCode: 'US', Tags: ['blocked-live'] });
  Object.assign(late, { Id: id(11), Path: '/views/late', PhysicalLocationsList: null, Tags: [] });
  setFolderChildren(root, [first, late]);
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  Object.assign(item, { Id: id(20), ParentId: id(3), Path: '/media/current/unsaved.mkv', OfficialRating: 'PG', PreferredMetadataCountryCode: 'US' });
  const user = { Id: id(90), Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
    BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] }, Configuration: {} };
  await f.library.store.run(async session => {
    const state = await f.library.load(session, user, { includeUserData: false, baseRows: await session.rows('BaseItems') });
    try {
      assert.equal(await f.library.isItemVisible(item, user, state, { checkStandaloneParents: false }), true,
        'An own country does not enumerate an invalid matching directory source.');
      item.PreferredMetadataCountryCode = null;
      await assert.rejects(f.library.isItemVisible(item, user, state, { checkStandaloneParents: false }), { status: 500 });
      late.PhysicalLocationsList = ['/media/current']; late.Tags = null;
      user.Policy.BlockedTags = ['blocked-live'];
      await assert.rejects(f.library.isItemVisible(item, user, state, { checkStandaloneParents: false }),
        { status: 500 },
        'GetInheritedTags consumes a later null list before testing an earlier blocked tag.');
    } finally { await state.dispose({ session }); }
  });
});

test('postgres: anonymous navigation chooses first-ID positions and exact last slots in SQL without consuming root links', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const f = await setup(t);
  await f.database.insertBatch('BaseItems', [row(id(1), 'AggregateFolder', null, { Data: '{"IsRoot":true}' }),
    row(id(2), 'UserRootFolder', null)]);
  const aggregate = await f.root(id(1)), root = await f.root(id(2));
  assert.equal(aggregate.IsRoot, true, 'Virtual children belong to the actual initialized Aggregate root.');
  const occurrence = (Id, Name, Type = 'Folder') => Object.assign(newNativeItemEntity(type(Type)), { Id, Name });
  const first = occurrence(id(10), 'first occurrence'), second = occurrence(id(11), 'second identity'),
    last = occurrence(id(10).toUpperCase(), 'last physical occurrence'), disabled = occurrence(id(12), 'disabled', 'CollectionFolder'),
    virtual = occurrence(id(10), 'exact virtual winner');
  await assignTestLinks(f, virtual, [{ ItemId: null, Type: 0, Path: '/virtual/unresolved', LibraryItemId: null }]);
  aggregate.VirtualChildren.splice(0, aggregate.VirtualChildren.length, virtual);
  setFolderChildren(root, [first, second, last, disabled]); root.LinkedChildren = null;
  f.library.options.libraryOptions = new Map([[idKey(disabled.Id), { Enabled: false }]]);
  await f.library.store.run(async session => {
    const state = await f.library.load(session, null, { includeUserData: false, baseRows: await session.rows('BaseItems') });
    try {
      const selected = await f.library.navigationChildren(state, null);
      assert.deepEqual(selected, [virtual, second]);
      assert.equal(root.LinkedChildren, null);
      await f.linkedChildren.recordResolution(virtual.LinkedChildren, 1n, id(80));
      assert.equal((await readTestLinks(selected[0]))[0].ItemId, id(80));
    } finally { await state.dispose({ session }); }
  });
});
