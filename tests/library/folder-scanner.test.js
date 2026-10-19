import { testFileSystem } from '../storage/plugin-files.js';
import { decodeNativeTextBytes } from '../../src/database/native-text.js';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { LibraryService, FolderScanService } from '../../src/library/index.js';
import { loadPostgresRowsByPaths } from '../../src/library/postgres-library-query.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { inertResolvedItemLifecycle } from './resolved-item-lifecycle-fixture.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';

const test = (name, options, run) => typeof options === 'function'
  ? nodeTest(name, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, options)
  : nodeTest(name, { ...options, skip: options?.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES }, run);

const FOLDER_TYPE = 'MediaBrowser.Controller.Entities.Folder';
const ROOT_ID = 'E1000000-0000-0000-0000-000000000001';
const FOREIGN_ID = 'E1000000-0000-0000-0000-000000000002';
const AGGREGATE_ID = 'E1000000-0000-0000-0000-000000000003';
const COLLECTION_ID = 'E1000000-0000-0000-0000-000000000004';
const USER_ID = 'E1000000-0000-0000-0000-000000000005';
const OWNER_REFERENCE_ID = 'E1000000-0000-0000-0000-000000000006';
const PATH_COLLECTION_ID = 'E1000000-0000-0000-0000-000000000007';
const USER_ROOT_ID = 'E1000000-0000-0000-0000-000000000008';
const PROGRAM_DATA_PATH = 'C:\\ProgramData\\MediaManager';
const ROOT_PATH = 'Z:\\Library';

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    const value = type === 'DateTime' ? '2026-09-27 00:00:00'
      : column.nullable ? null
        : type === 'bool' ? false
          : column.type === 'TEXT' ? ''
            : type === 'long' || type === 'uint' ? 0n : 0;
    return [column.name, value];
  }));
}

function item(Id, Type, values = {}) {
  const leaf = Type === 'Movie';
  return {
    ...blank('BaseItems'),
    Id,
    Type: leaf ? 'MediaBrowser.Controller.Entities.Movies.Movie' : `MediaBrowser.Controller.Entities.${Type}`,
    Name: Type,
    CleanName: Type.toLowerCase(),
    SortName: Type.toLowerCase(),
    PresentationUniqueKey: Id,
    IsFolder: !leaf,
    MediaType: leaf ? 'Video' : 'Unknown',
    Data: '{}',
    ...values
  };
}

const key = value => String(value).replaceAll('-', '').toLowerCase();
const folderId = (identityPath, enableCaseSensitiveItemIds = false) => nativeGuid(getNewItemId(identityPath, FOLDER_TYPE, {
  programDataPath: PROGRAM_DATA_PATH,
  enableCaseSensitiveItemIds
}));

async function databaseFor() {
  const schema = `folder_scan_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  return {
    database: await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true }),
    schema
  };
}

async function fixture(t, dialect, {
  pageSize = 100,
  configuration = {},
  rootPath = ROOT_PATH,
  clock = () => new Date('2026-09-27T01:02:03.456Z'),
  resolvedItemLifecycle = inertResolvedItemLifecycle
} = {}) {
  const { database, schema } = await databaseFor();
  const registry = new StorageRegistry();
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('library', 'memory', { pageSize });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({
    identityRoot: rootPath,
    accessRoot: '/library',
    style: 'windows',
    returnAccess: 'Isolated folder scanner fixture'
  });
  const store = new DomainStore(database);
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'folder-scanner-test', configuration });
  const refreshes = new ProviderRefreshService();
  await database.insert('BaseItems', item(ROOT_ID, 'Folder', { Name: 'Library', CleanName: 'library', SortName: 'library',
    Path: rootPath, TopParentId: ROOT_ID }));
  const scanner = new FolderScanService({
    ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] }),
    store,
    library,
    vfs,
    identityMap,
    refreshes,
    resolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH,
    configuration,
    clock,
    onError: error => { throw error; }
  });
  const reference = await library.getItemRecord(ROOT_ID);
  t.after(async () => {
    await scanner.close();
    await registry.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });
  return { database, store, library, refreshes, registry, adapter, vfs, identityMap, scanner, reference };
}

async function rows(database, table) {
  return (await database.rows(table)).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function folderRows(database) {
  return (await database.rows('BaseItems')).filter(row => row.Type === FOLDER_TYPE)
    .toSorted((left, right) => String(left.Path).localeCompare(String(right.Path)));
}

async function bounded(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Operation exceeded ${milliseconds}ms`)), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}

for (const dialect of ['postgres']) test(`${dialect}: recursive generic folder scanning is deterministic, idempotent and ignores files`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, library, adapter, scanner, reference, refreshes } = await fixture(t, dialect);
    await adapter.mkdir('/Alpha');
    await adapter.mkdir('/Alpha/Deep');
    await adapter.mkdir('/Beta');
    await adapter.write('/ignored.mkv', Buffer.from('not a library item'));
    await adapter.write('/Alpha/also-ignored.txt', Buffer.from('not a library item'));

    assert.equal(scanner.supports(reference), true);
    assert.equal(scanner.supports({ ...reference, Type: 'CollectionFolder' }), false);
    assert.equal(scanner.supports({ ...reference, Type: 'Movie', IsFolder: false }), false);
    assert.equal(scanner.supports({ ...reference, NativeType: 'Plugin.Entities.Folder' }), false);
    assert.ok(scanner.capabilities && typeof scanner.capabilities === 'object');

    const lifecycle = [];
    refreshes.on('RefreshStarted', ({ Item }) => lifecycle.push(['started', key(Item.Id)]));
    refreshes.on('RefreshProgress', ({ Item, Progress }) => lifecycle.push(['progress', key(Item.Id), Progress]));
    refreshes.on('RefreshCompleted', ({ Item }) => lifecycle.push(['completed', key(Item.Id)]));

    scanner.queue(reference);
    await scanner.whenIdle();

    const alphaId = folderId('Z:\\Library\\Alpha');
    const deepId = folderId('Z:\\Library\\Alpha\\Deep');
    const betaId = folderId('Z:\\Library\\Beta');
    const byPath = new Map((await folderRows(database)).map(row => [row.Path, row]));
    assert.deepEqual([...byPath.keys()], [ROOT_PATH, 'Z:\\Library\\Alpha', 'Z:\\Library\\Alpha\\Deep', 'Z:\\Library\\Beta']);
    assert.equal(key(byPath.get('Z:\\Library\\Alpha').Id), key(alphaId));
    assert.equal(key(byPath.get('Z:\\Library\\Alpha\\Deep').Id), key(deepId));
    assert.equal(key(byPath.get('Z:\\Library\\Beta').Id), key(betaId));
    assert.equal(key(byPath.get('Z:\\Library\\Alpha').ParentId), key(ROOT_ID));
    assert.equal(key(byPath.get('Z:\\Library\\Alpha\\Deep').ParentId), key(alphaId));
    assert.equal(key(byPath.get('Z:\\Library\\Beta').ParentId), key(ROOT_ID));
    for (const path of ['Z:\\Library\\Alpha', 'Z:\\Library\\Alpha\\Deep', 'Z:\\Library\\Beta']) {
      assert.equal(key(byPath.get(path).TopParentId), key(ROOT_ID));
    }
    assert.equal((await database.rows('BaseItems')).some(row => /ignored|also-ignored/.test(row.Path ?? '')), false);

    const ancestors = await database.rows('AncestorIds');
    assert.deepEqual(ancestors.filter(row => key(row.ItemId) === key(alphaId)).map(row => key(row.ParentItemId)).toSorted(), [key(ROOT_ID)]);
    assert.deepEqual(ancestors.filter(row => key(row.ItemId) === key(deepId)).map(row => key(row.ParentItemId)).toSorted(),
      [key(ROOT_ID), key(alphaId)].toSorted());
    assert.deepEqual(ancestors.filter(row => key(row.ItemId) === key(betaId)).map(row => key(row.ParentItemId)).toSorted(), [key(ROOT_ID)]);

    const rootLifecycle = lifecycle.filter(event => event[1] === key(ROOT_ID));
    assert.equal(rootLifecycle[0][0], 'started');
    assert.equal(rootLifecycle.at(-1)[0], 'completed');
    assert.ok(rootLifecycle.some(event => event[0] === 'progress' && event[2] > 0 && event[2] < 100),
      'a recursive scan reports useful intermediate progress');
    assert.equal(refreshes.getRefreshProgress(ROOT_ID), null);

    const beforeItems = await rows(database, 'BaseItems');
    const beforeAncestors = await rows(database, 'AncestorIds');
    const changes = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => changes.push([name, event.Item.Id]));
    lifecycle.length = 0;
    const proof = await scanner.scan(ROOT_ID);
    assert.equal(proof.structurallyComplete, true);
    assert.deepEqual(proof.incompleteReasons, []);
    assert.ok(Object.isFrozen(proof));
    assert.ok(Object.isFrozen(proof.incompleteReasons));
    assert.deepEqual(await rows(database, 'BaseItems'), beforeItems);
    assert.deepEqual(await rows(database, 'AncestorIds'), beforeAncestors);
    assert.deepEqual(changes, [], 'an unchanged second scan does not publish library changes');
    assert.equal(lifecycle[0][0], 'started');
    assert.equal(lifecycle.at(-1)[0], 'completed');
  });

for (const dialect of ['postgres']) test(`${dialect}: scanned folders use real parents and literal user-root collection paths`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect);
    await database.insert('BaseItems', item(AGGREGATE_ID, 'AggregateFolder'));
    await database.insert('BaseItems', item(USER_ROOT_ID, 'UserRootFolder'));
    await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: AGGREGATE_ID });
    await database.insert('BaseItems', item(COLLECTION_ID, 'CollectionFolder', {
      ParentId: USER_ROOT_ID,
      Data: JSON.stringify({ PhysicalFolderIds: [ROOT_ID], PhysicalLocationsList: ['z:\\library'] })
    }));
    await database.insert('BaseItems', item(PATH_COLLECTION_ID, 'CollectionFolder', {
      ParentId: USER_ROOT_ID,
      Data: JSON.stringify({ PhysicalLocationsList: ['z:/library/'] })
    }));
    await database.insert('AncestorIds', { ItemId: ROOT_ID, ParentItemId: PATH_COLLECTION_ID });
    await adapter.mkdir('/NativeAncestors');

    await scanner.scan(reference);

    const childId = folderId('Z:\\Library\\NativeAncestors');
    const ancestors = (await database.rows('AncestorIds')).filter(row => key(row.ItemId) === key(childId))
      .map(row => key(row.ParentItemId)).toSorted();
    assert.deepEqual(ancestors, [ROOT_ID, AGGREGATE_ID, COLLECTION_ID].map(key).toSorted());
  });

for (const dialect of ['postgres']) test(`${dialect}: strong snapshots delete only safe managed leaves and publish after commit`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, store, library, adapter, scanner, reference } = await fixture(t, dialect);
    await adapter.mkdir('/Managed');
    await adapter.mkdir('/Protected');
    await adapter.mkdir('/StillPresent');
    await adapter.mkdir('/OwnerProtected');
    await adapter.mkdir('/LinkedProtected');
    await adapter.mkdir('/CompactReferenceProtected');
    const outsideId = folderId('X:\\Outside');
    const misplacedId = folderId('Z:\\Library\\Nested\\Misplaced');
    await database.insert('BaseItems', item(outsideId, 'Folder', {
      Name: 'Outside',
      CleanName: 'outside',
      SortName: 'outside',
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      Path: 'X:\\Outside',
      Data: JSON.stringify({ SourceType: 'Library' })
    }));
    await database.insert('BaseItems', item(misplacedId, 'Folder', {
      Name: 'Misplaced',
      CleanName: 'misplaced',
      SortName: 'misplaced',
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      Path: 'Z:\\Library\\Nested\\Misplaced',
      Data: JSON.stringify({ SourceType: 'Library' })
    }));
    const unsafeInitial = await scanner.scan(reference);
    assert.equal(unsafeInitial.structurallyComplete, false);
    assert.ok(unsafeInitial.incompleteReasons.some(reason => reason.code === 'unsafe-deletion-skipped'));
    const managedId = folderId('Z:\\Library\\Managed');
    const protectedId = folderId('Z:\\Library\\Protected');
    const ownerProtectedId = folderId('Z:\\Library\\OwnerProtected');
    const linkedProtectedId = folderId('Z:\\Library\\LinkedProtected');
    const compactReferenceProtectedId = folderId('Z:\\Library\\CompactReferenceProtected');
    assert.equal((await database.rows('BaseItems', { where: { Id: outsideId } })).length, 1,
      'a deterministic-looking direct child outside the scanned root cannot be deleted');
    assert.equal((await database.rows('BaseItems', { where: { Id: misplacedId } })).length, 1,
      'a nested identity path mislabeled as a direct database child cannot be deleted');

    await database.insert('BaseItems', item(FOREIGN_ID, 'Movie', {
      Name: 'Foreign child', CleanName: 'foreign child', SortName: 'foreign child', Path: 'Z:\\Library\\Protected\\foreign.mkv',
      ParentId: protectedId, TopParentId: ROOT_ID, PrimaryVersionId: key(compactReferenceProtectedId)
    }));
    await database.insert('AncestorIds', { ItemId: FOREIGN_ID, ParentItemId: ROOT_ID });
    await database.insert('AncestorIds', { ItemId: FOREIGN_ID, ParentItemId: protectedId });
    await database.insert('BaseItems', item(OWNER_REFERENCE_ID, 'Movie', {
      Name: 'External owner reference',
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      OwnerId: ownerProtectedId,
      Path: 'Z:\\Library\\external-owner-reference.mkv'
    }));
    await database.insert('LinkedChildren', {
      ParentId: ROOT_ID,
      SortOrder: 0,
      ChildId: linkedProtectedId,
      ChildType: 0
    });

    let transactionPending = false;
    const transaction = store.transaction.bind(store);
    store.transaction = operation => {
      transactionPending = true;
      return transaction(operation).finally(() => { transactionPending = false; });
    };
    const events = [];
    library.on('ItemRemoved', ({ Item, Parent }) => events.push({ kind: 'removed', Item, Parent, transactionPending }));
    library.on('ItemAdded', ({ Item, Parent }) => events.push({ kind: 'added', Item, Parent, transactionPending }));

    await adapter.delete('/Managed');
    await adapter.delete('/Protected');
    await adapter.delete('/OwnerProtected');
    await adapter.delete('/LinkedProtected');
    await adapter.delete('/CompactReferenceProtected');
    const protectedResult = await scanner.scan(reference);
    assert.equal(protectedResult.structurallyComplete, false);
    assert.ok(Object.isFrozen(protectedResult.incompleteReasons));
    assert.ok(protectedResult.incompleteReasons.every(Object.isFrozen));
    assert.ok(protectedResult.incompleteReasons.some(reason => reason.code === 'unsafe-deletion-skipped'));
    assert.ok(protectedResult.incompleteReasons.some(reason => reason.code === 'external-reference-deletion-skipped'));
    assert.equal((await database.rows('BaseItems', { where: { Id: managedId } })).length, 0,
      'an absent scanner-managed leaf is removed after a strong snapshot');
    assert.equal((await database.rows('BaseItems', { where: { Id: protectedId } })).length, 1,
      'a managed folder with a foreign descendant is retained rather than cascading it');
    assert.equal((await database.rows('BaseItems', { where: { Id: FOREIGN_ID } })).length, 1);
    assert.equal((await database.rows('BaseItems', { where: { Id: ownerProtectedId } })).length, 1,
      'an external OwnerId reference conservatively protects a missing managed folder');
    assert.equal((await database.rows('BaseItems', { where: { Id: linkedProtectedId } })).length, 1,
      'a LinkedChildren reference conservatively protects a missing managed folder');
    assert.equal((await database.rows('BaseItems', { where: { Id: compactReferenceProtectedId } })).length, 1,
      'a compact GUID reference conservatively protects a missing managed folder');
    assert.equal(events.filter(event => event.kind === 'removed' && key(event.Item.Id) === key(managedId)).length, 1);
    assert.ok(events.every(event => event.transactionPending === false), 'library notifications are emitted after the transaction commits');

    await adapter.mkdir('/AddedAfterCommit');
    await scanner.scan(reference);
    const addedId = folderId('Z:\\Library\\AddedAfterCommit');
    const added = events.find(event => event.kind === 'added' && key(event.Item.Id) === key(addedId));
    assert.ok(added);
    assert.equal(added.transactionPending, false);
    assert.equal(key(added.Parent.Id), key(ROOT_ID));

    await adapter.mkdir('/TypeConflict');
    await scanner.scan(reference);
    const conflictId = folderId('Z:\\Library\\TypeConflict');
    await adapter.delete('/TypeConflict');
    await adapter.write('/TypeConflict', Buffer.from('unsupported file replacement'));
    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: conflictId } })).length, 1,
      'an unsupported file replacement cannot authorize deleting the old folder identity');

    const userProtectedId = folderId('Z:\\Library\\StillPresent');
    await database.insert('Users', { ...blank('Users'), Id: USER_ID, InternalId: 1, Username: 'Folder user data',
      NormalizedUsername: 'FOLDER USER DATA' });
    await database.insert('UserData', { ...blank('UserData'), UserId: USER_ID, ItemId: userProtectedId,
      CustomDataKey: key(userProtectedId), IsFavorite: true });
    await adapter.delete('/StillPresent');
    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: userProtectedId } })).length, 1,
      'a missing folder with user data is conservatively retained');
  });

for (const dialect of ['postgres']) test(`${dialect}: weak and failed directory listings never authorize deletion or partial mutation`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const current = await fixture(t, dialect, { pageSize: 1 });
    const { database, adapter, vfs, scanner, reference } = current;
    await adapter.mkdir('/First');
    await adapter.mkdir('/First/Nested');
    await adapter.mkdir('/KeepOnWeak');
    const initial = await scanner.scan(reference);
    assert.equal(initial.added, 3, 'scan results aggregate mutations from every recursive directory plan');
    const weakId = folderId('Z:\\Library\\KeepOnWeak');
    const nestedId = folderId('Z:\\Library\\First\\Nested');

    await adapter.delete('/KeepOnWeak');
    const list = vfs.list.bind(vfs);
    vfs.list = async (path, options) => {
      const result = await list(path, options);
      return path === '/library' ? { ...result, consistency: 'weak', snapshot: null, deletionSafe: false } : result;
    };
    await adapter.mkdir('/ObservedOnWeak');
    const weak = await scanner.scan(reference);
    assert.equal(weak.structurallyComplete, false);
    assert.ok(weak.incompleteReasons.some(reason => reason.code === 'weak-directory-snapshot'
      && reason.itemId === ROOT_ID && reason.path === ROOT_PATH));
    assert.ok(Object.isFrozen(weak.incompleteReasons));
    assert.ok(weak.incompleteReasons.every(Object.isFrozen));
    assert.equal((await database.rows('BaseItems', { where: { Id: weakId } })).length, 1,
      'a complete but weak listing cannot delete a previously managed child');
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId('Z:\\Library\\ObservedOnWeak') } })).length, 1,
      'a weak listing can still add an observed directory without inferring absence');
    vfs.list = list;

    await adapter.mkdir('/KeepOnExplicitUnsafeSnapshot');
    await scanner.scan(reference);
    const explicitUnsafeId = folderId('Z:\\Library\\KeepOnExplicitUnsafeSnapshot');
    await adapter.delete('/KeepOnExplicitUnsafeSnapshot');
    const unsafeListPage = adapter.listPage.bind(adapter);
    adapter.listPage = async (path, options) => ({ ...await unsafeListPage(path, options), deletionSafe: false });
    const explicitUnsafe = await scanner.scan(reference);
    assert.equal(explicitUnsafe.skippedDeletion, true,
      'an adapter snapshot that explicitly disallows deletion remains non-authoritative through VFS');
    assert.equal(explicitUnsafe.structurallyComplete, false);
    assert.ok(explicitUnsafe.incompleteReasons.some(reason => reason.code === 'weak-directory-snapshot'));
    assert.equal((await database.rows('BaseItems', { where: { Id: explicitUnsafeId } })).length, 1,
      'VFS must not promote snapshot consistency into deletion authority');
    adapter.listPage = unsafeListPage;

    await adapter.delete('/First/Nested');
    vfs.list = async (path, options) => {
      const result = await list(path, options);
      return path === '/library/First' ? { ...result, consistency: 'weak', snapshot: null, deletionSafe: false } : result;
    };
    const nestedWeak = await scanner.scan(reference);
    assert.equal(nestedWeak.skippedDeletion, true,
      'a nested weak snapshot propagates its conservative deletion result to the root scan');
    assert.equal(nestedWeak.structurallyComplete, false);
    assert.ok(nestedWeak.incompleteReasons.some(reason => reason.code === 'weak-directory-snapshot'
      && reason.path === 'Z:\\Library\\First'));
    assert.equal((await database.rows('BaseItems', { where: { Id: nestedId } })).length, 1);
    vfs.list = list;

    await adapter.mkdir('/PageOneCandidate');
    const beforeItems = await rows(database, 'BaseItems');
    const beforeAncestors = await rows(database, 'AncestorIds');
    const listPage = adapter.listPage.bind(adapter);
    adapter.listPage = async (path, options) => {
      if (path === '/' && options.cursor) throw Object.assign(new Error('Injected second-page failure'), { code: 'unavailable' });
      return listPage(path, options);
    };
    await assert.rejects(scanner.scan(reference), { code: 'unavailable' });
    assert.deepEqual(await rows(database, 'BaseItems'), beforeItems, 'a failed current-directory enumeration writes no partial entries');
    assert.deepEqual(await rows(database, 'AncestorIds'), beforeAncestors);
  });

test('folder scanner retries one database hierarchy race against a fresh storage listing', async t => {
  const current = await fixture(t, 'postgres');
  const { database, adapter, vfs, scanner, reference } = current;
  await adapter.mkdir('/Concurrent');
  const list = vfs.list.bind(vfs);
  let rootLists = 0;
  vfs.list = async (path, options) => {
    const result = await list(path, options);
    if (path === '/library' && ++rootLists === 1) {
      await database.insert('BaseItems', item(FOREIGN_ID, 'Movie', {
        Name: 'Concurrent foreign item',
        ParentId: ROOT_ID,
        TopParentId: ROOT_ID,
        Path: 'Z:\\Library\\concurrent-foreign.mkv'
      }));
    }
    return result;
  };

  await scanner.scan(reference);

  assert.equal(rootLists, 2, 'the current directory is fully re-enumerated after a database snapshot conflict');
  assert.equal((await database.rows('BaseItems', { where: { Id: folderId('Z:\\Library\\Concurrent') } })).length, 1);
  assert.equal((await database.rows('BaseItems', { where: { Id: FOREIGN_ID } })).length, 1);
});

test('a folder becoming unsupported after enumeration rolls back a pending deletion', async t => {
  const current = await fixture(t, 'postgres');
  const { database, adapter, vfs, scanner, reference } = current;
  await adapter.mkdir('/ManagedRace');
  await adapter.mkdir('/Keeper');
  await scanner.scan(reference);
  const managedId = folderId('Z:\\Library\\ManagedRace');
  await adapter.delete('/ManagedRace');
  const list = vfs.list.bind(vfs);
  let changed = false;
  vfs.list = async (path, options) => {
    const result = await list(path, options);
    if (path === '/library' && !changed) {
      changed = true;
      await database.update('BaseItems', { Id: ROOT_ID }, { IsVirtualItem: true });
    }
    return result;
  };

  await assert.rejects(scanner.scan(reference), { code: 'version-changed' });

  assert.equal((await database.rows('BaseItems', { where: { Id: managedId } })).length, 1,
    'an unsupported root cannot authorize a deletion captured while it was supported');
});

test('folder scanner retries one changing storage snapshot by fully re-enumerating the directory', async t => {
  const current = await fixture(t, 'postgres', { pageSize: 1 });
  const { database, adapter, scanner, reference } = current;
  await adapter.mkdir('/BeforeRaceA');
  await adapter.mkdir('/BeforeRaceB');
  const listPage = adapter.listPage.bind(adapter);
  let injected = false;
  let firstPages = 0;
  adapter.listPage = async (path, options) => {
    const page = await listPage(path, options);
    if (path === '/' && options.cursor == null) {
      firstPages++;
      if (!injected) {
        injected = true;
        await adapter.mkdir('/AppearedDuringEnumeration');
      }
    }
    return page;
  };

  await scanner.scan(reference);

  assert.equal(firstPages, 2, 'a changed storage snapshot starts a fresh full listing exactly once');
  const paths = (await folderRows(database)).map(row => row.Path);
  assert.ok(paths.includes('Z:\\Library\\BeforeRaceA'));
  assert.ok(paths.includes('Z:\\Library\\BeforeRaceB'));
  assert.ok(paths.includes('Z:\\Library\\AppearedDuringEnumeration'));
});

for (const dialect of ['postgres']) test(dialect + ': Windows case-only siblings are ambiguous even with case-sensitive item IDs',
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const current = await fixture(t, dialect, { configuration: { EnableCaseSensitiveItemIds: true } });
    const { database, adapter, scanner, reference } = current;
    await adapter.mkdir('/Case');
    await adapter.mkdir('/case');
    const beforeItems = await rows(database, 'BaseItems');
    const beforeAncestors = await rows(database, 'AncestorIds');

    await assert.rejects(scanner.scan(reference), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, /ambiguous native paths/u);
      return true;
    });

    assert.deepEqual(await rows(database, 'BaseItems'), beforeItems);
    assert.deepEqual(await rows(database, 'AncestorIds'), beforeAncestors);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId('Z:\\Library\\Case', true) } })).length, 0);
  });

for (const dialect of ['postgres']) test(dialect + ': native Windows paths reject an off-parent Unicode path owner',
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const current = await fixture(t, dialect, { configuration: { EnableCaseSensitiveItemIds: true } });
    const { database, adapter, scanner, reference } = current;
    const targetPath = 'Z:\\Library\\ÄCaseConflict';
    const targetId = folderId(targetPath, true);
    await database.insert('BaseItems', item(FOREIGN_ID, 'Movie', {
      Name: 'Off-parent path owner',
      Path: 'z:\\library\\discard\\..\\.\\äcaseconflict\\\\',
      ParentId: null,
      TopParentId: null
    }));
    await adapter.mkdir('/ÄCaseConflict');

    await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });

    assert.equal((await database.rows('BaseItems', { where: { Id: FOREIGN_ID } })).length, 1);
    assert.equal((await database.rows('BaseItems', { where: { Id: targetId } })).length, 0,
      'the scanner cannot create a second logical owner for an ordinal-ignore-case path');
  });

for (const dialect of ['postgres']) test(dialect + ': a path owner inserted during VFS enumeration wins before atomic reconciliation',
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const current = await fixture(t, dialect, { configuration: { EnableCaseSensitiveItemIds: true } });
  const { database, adapter, vfs, scanner, reference } = current;
  const targetPath = 'Z:\\Library\\Alpha';
  const targetId = folderId(targetPath, true);
  await adapter.mkdir('/Alpha');
  const list = vfs.list.bind(vfs);
  let inserted = false;
  vfs.list = async (path, options) => {
    const result = await list(path, options);
    if (path === '/library' && !inserted) {
      inserted = true;
      await database.insert('BaseItems', item(FOREIGN_ID, 'Movie', {
        Name: 'Concurrent off-parent path owner',
        Path: 'z:\\library\\alpha',
        ParentId: null,
        TopParentId: null
      }));
    }
    return result;
  };

  await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });

  assert.equal((await database.rows('BaseItems', { where: { Id: FOREIGN_ID } })).length, 1,
    'the independent owner committed during enumeration is preserved');
  assert.equal((await database.rows('BaseItems', { where: { Id: targetId } })).length, 0,
    'the scan-wide transaction rolls back its conflicting deterministic folder');
});

test('a case-only folder rename preserves existing metadata and identity spelling during validation', async t => {
  const now = new Date('2026-09-27T01:02:03.456Z');
  const current = await fixture(t, 'postgres', { clock: () => now });
  const { database, library, adapter, scanner, reference } = current;
  await adapter.mkdir('/Original');
  await scanner.scan(reference);
  const id = folderId('Z:\\Library\\Original');
  const [before] = await database.rows('BaseItems', { where: { Id: id } });
  const updates = [];
  library.on('ItemUpdated', event => updates.push(event));

  await adapter.rename('/Original', '/original');
  await scanner.scan(reference);

  const [after] = await database.rows('BaseItems', { where: { Id: id } });
  assert.deepEqual(after, before);
  assert.equal(updates.length, 0);
});

test('an empty physical top folder is non-destructive while an authoritative nested empty folder is reconciled', async t => {
  const current = await fixture(t, 'postgres');
  const { database, adapter, scanner, reference } = current;
  await adapter.mkdir('/Parent');
  await adapter.mkdir('/Parent/Child');
  await scanner.scan(reference);
  const parentId = folderId('Z:\\Library\\Parent');
  const childId = folderId('Z:\\Library\\Parent\\Child');

  await adapter.delete('/Parent/Child');
  await scanner.scan(reference);
  assert.equal((await database.rows('BaseItems', { where: { Id: childId } })).length, 0,
    'an authoritative nested empty listing removes its missing child');

  await adapter.delete('/Parent');
  const emptyTop = await scanner.scan(reference);
  assert.equal(emptyTop.structurallyComplete, false);
  assert.deepEqual(emptyTop.incompleteReasons, [{
    code: 'empty-top-folder-protected', itemId: ROOT_ID, path: ROOT_PATH
  }]);
  assert.ok(Object.isFrozen(emptyTop.incompleteReasons));
  assert.ok(Object.isFrozen(emptyTop.incompleteReasons[0]));
  assert.equal((await database.rows('BaseItems', { where: { Id: parentId } })).length, 1,
    'a completely empty physical root preserves its previous database children');
});

test('the global queue retains distinct Folder requests instead of replacing them with the latest one', async t => {
  const { scanner } = await fixture(t, 'postgres');
  const first = ROOT_ID;
  const second = 'E1000000-0000-0000-0000-000000000010';
  const third = 'E1000000-0000-0000-0000-000000000011';
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  scanner.scan = async (reference, { signal } = {}) => {
    calls.push(key(reference));
    if (key(reference) === key(first)) {
      await Promise.race([gate, new Promise((resolve, reject) => signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }))]);
    }
  };

  scanner.queue(first);
  await new Promise(resolve => setImmediate(resolve));
  scanner.queue(second);
  scanner.queue(third);
  release();
  await scanner.whenIdle();

  assert.deepEqual(calls, [first, second, third].map(key));
});

test('an earlier folder queue call reserves the scan tail before a following direct call', async t => {
  const { scanner, reference } = await fixture(t, 'postgres');
  const original = scanner.scan.bind(scanner);
  const calls = [];
  scanner.scan = (current, options) => {
    calls.push(current.marker);
    return original(current, options);
  };

  const queued = scanner.queue({ ...reference, marker: 'queued-first' });
  const direct = scanner.scan({ ...reference, marker: 'direct-second' });
  await Promise.all([queued, direct]);
  assert.deepEqual(calls, ['queued-first', 'direct-second']);
});

test('the global queue registers one runner before synchronous scan re-entry', async t => {
  const { scanner } = await fixture(t, 'postgres');
  const second = 'E1000000-0000-0000-0000-000000000013';
  const calls = [];
  let active = 0;
  let maxActive = 0;
  scanner.scan = reference => {
    calls.push(key(reference));
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls.length === 1) scanner.queue(second);
    return new Promise(resolve => setImmediate(() => {
      active--;
      resolve();
    }));
  };

  scanner.queue(ROOT_ID);
  await scanner.whenIdle();
  assert.deepEqual(calls, [ROOT_ID, second].map(key));
  assert.equal(maxActive, 1);
});

test('the global queue cancels an active duplicate and coalesces pending duplicates to the latest reference', async t => {
  const { scanner } = await fixture(t, 'postgres');
  const otherId = 'E1000000-0000-0000-0000-000000000012';
  const calls = [];
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  scanner.scan = async (reference, { signal } = {}) => {
    calls.push({ id: key(reference.Id), marker: reference.marker });
    if (calls.length !== 1) return;
    started();
    await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  };

  scanner.queue({ Id: ROOT_ID, marker: 'active' });
  await firstStarted;
  scanner.queue({ Id: ROOT_ID, marker: 'superseded' });
  scanner.queue({ Id: otherId, marker: 'other' });
  scanner.queue({ Id: ROOT_ID, marker: 'latest' });
  await scanner.whenIdle();

  assert.deepEqual(calls, [
    { id: key(ROOT_ID), marker: 'active' },
    { id: key(ROOT_ID), marker: 'latest' },
    { id: key(otherId), marker: 'other' }
  ]);
});

test('folder scanner caller cancellation and close abort bounded in-flight work', async t => {
  const current = await fixture(t, 'postgres');
  const { vfs, scanner, reference } = current;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  vfs.list = (path, { signal } = {}) => new Promise((resolve, reject) => {
    entered();
    const cancelled = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    if (signal?.aborted) cancelled();
    else signal?.addEventListener('abort', cancelled, { once: true });
  });

  const controller = new AbortController();
  const scan = scanner.scan(reference, { signal: controller.signal });
  await started;
  controller.abort();
  await bounded(assert.rejects(scan, error => error?.code === 'cancelled' || error?.name === 'AbortError'));

  let queued;
  const queuedStarted = new Promise(resolve => { queued = resolve; });
  vfs.list = (path, { signal } = {}) => new Promise((resolve, reject) => {
    queued();
    const cancelled = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    if (signal?.aborted) cancelled();
    else signal?.addEventListener('abort', cancelled, { once: true });
  });
  scanner.queue(reference);
  await queuedStarted;
  await bounded(scanner.close());
  await bounded(scanner.whenIdle());
});

test('direct folder scans serialize enumeration and refresh lifecycle ownership', async t => {
  const { vfs, scanner, reference, refreshes } = await fixture(t, 'postgres');
  const firstEntered = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const list = vfs.list.bind(vfs);
  let rootCalls = 0;
  let activeLists = 0;
  let maximumActiveLists = 0;
  vfs.list = async (...args) => {
    if (args[0] !== '/library') return list(...args);
    rootCalls++;
    activeLists++;
    maximumActiveLists = Math.max(maximumActiveLists, activeLists);
    try {
      if (rootCalls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return await list(...args);
    } finally { activeLists--; }
  };
  const lifecycle = [];
  refreshes.on('RefreshStarted', ({ Item }) => {
    if (key(Item.Id) === key(ROOT_ID)) lifecycle.push('started');
  });
  refreshes.on('RefreshCompleted', ({ Item }) => {
    if (key(Item.Id) === key(ROOT_ID)) lifecycle.push('completed');
  });

  const first = scanner.scan(reference);
  await firstEntered.promise;
  const second = scanner.scan(reference);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rootCalls, 1, 'a second direct scan waits before starting VFS work');
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(maximumActiveLists, 1);
  assert.equal(rootCalls, 2);
  assert.deepEqual(lifecycle, ['started', 'completed', 'started', 'completed']);
});

test('folder scanner close aborts a direct scan and rejects new work with service unavailable', async t => {
  const { vfs, scanner, reference } = await fixture(t, 'postgres');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  vfs.list = (_path, { signal } = {}) => new Promise((resolve, reject) => {
    entered();
    const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

  const active = scanner.scan(reference);
  await started;
  await bounded(scanner.close());
  await assert.rejects(active, error => error?.code === 'cancelled');
  await assert.rejects(scanner.scan(reference), error => error?.status === 503 && error?.code === 'closed');
  assert.throws(() => scanner.queue(reference), error => error?.status === 503 && error?.code === 'closed');
});

test('a folder scan collaborator may await close without waiting on itself', async () => {
  const started = Promise.withResolvers();
  let scanner;
  const store = {
    async run() {
      started.resolve();
      await scanner.close();
      return {};
    }
  };
  scanner = new FolderScanService({
    store,
    library: {},
    vfs: {},
    identityMap: {},
    refreshes: {},
    resolvedItemLifecycle: inertResolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH
  });

  const active = scanner.scan({ Id: ROOT_ID });
  await started.promise;
  await bounded(assert.rejects(active, error => error?.code === 'cancelled' || error?.name === 'AbortError'), 250);
});

test('folder scan collaborators fail fast on nested scheduling and idle waits', async () => {
  const nestedFailures = [];
  const expected = new Error('stop after re-entry checks');
  let scanner;
  const store = {
    async run() {
      assert.throws(() => scanner.queue(ROOT_ID), error => error.code === 'invalid-operation');
      nestedFailures.push(scanner.scan({ Id: ROOT_ID }).then(() => null, error => error));
      nestedFailures.push(scanner.whenIdle().then(() => null, error => error));
      throw expected;
    }
  };
  scanner = new FolderScanService({
    store,
    library: {},
    vfs: {},
    identityMap: {},
    refreshes: {},
    resolvedItemLifecycle: inertResolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH
  });

  await assert.rejects(scanner.scan({ Id: ROOT_ID }), error => error === expected);
  for (const failure of nestedFailures) assert.equal((await failure).code, 'invalid-operation');
  await scanner.close();
});

test('nested folder scanner instances retain the active ancestor for reentrant close detection', async () => {
  const options = owner => ({
    store: owner,
    library: {},
    vfs: {},
    identityMap: {},
    refreshes: {},
    resolvedItemLifecycle: inertResolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH
  });
  let outer;
  const inner = new FolderScanService(options({
    async run() {
      await outer.close();
      throw Object.assign(new Error('inner stopped'), { code: 'cancelled' });
    }
  }));
  outer = new FolderScanService(options({
    async run() { return inner.scan({ Id: ROOT_ID }); }
  }));

  const outcome = await Promise.race([
    outer.scan({ Id: ROOT_ID }).then(() => ({ status: 'completed' }), error => ({ status: error.code })),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 250))
  ]);
  assert.equal(outcome.status, 'cancelled');
  await Promise.all([outer.close(), inner.close()]);
});

test('folder scan scheduling contains an asynchronously rejecting error reporter', async () => {
  const scanner = new FolderScanService({
    store: {},
    library: {},
    vfs: {},
    identityMap: {},
    refreshes: {},
    resolvedItemLifecycle: inertResolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH,
    onError: async () => { throw new Error('reporter failure'); }
  });
  scanner.scan = async () => { throw new Error('scan failure'); };

  scanner.queue(ROOT_ID);
  await scanner.whenIdle();
  await new Promise(resolve => setImmediate(resolve));
  await scanner.close();
});

test('folder scan scheduling reports a non-cancellation failure that wins the close race', async () => {
  const entered = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const failure = new Error('folder scan failed before close');
  const reported = [];
  const scanner = new FolderScanService({
    store: {},
    library: {},
    vfs: {},
    identityMap: {},
    refreshes: {},
    resolvedItemLifecycle: inertResolvedItemLifecycle,
    programDataPath: PROGRAM_DATA_PATH,
    onError: error => reported.push(error)
  });
  scanner.scan = () => {
    entered.resolve();
    return operation.promise;
  };

  const queued = scanner.queue(ROOT_ID);
  await entered.promise;
  operation.reject(failure);
  const closing = scanner.close();
  await queued;
  await closing;
  assert.deepEqual(reported, [failure]);
});

test('folder scan preserves an error whose code accessor throws', async t => {
  const { scanner, reference, vfs } = await fixture(t, 'postgres');
  const hostile = {};
  Object.defineProperty(hostile, 'code', { get() { throw new Error('code accessor failed'); } });
  vfs.list = async () => { throw hostile; };

  await assert.rejects(scanner.scan(reference), error => error === hostile);
});

test('asynchronous descendants of a completed folder scan are not active re-entry', async t => {
  const { scanner, reference, vfs } = await fixture(t, 'postgres');
  const list = vfs.list.bind(vfs);
  const releaseDescendant = Promise.withResolvers();
  const descendant = Promise.withResolvers();
  let calls = 0;
  vfs.list = async (...args) => {
    calls++;
    if (calls === 1) {
      setImmediate(async () => {
        await releaseDescendant.promise;
        try {
          await scanner.queue(reference);
          descendant.resolve();
        } catch (error) { descendant.reject(error); }
      });
    }
    return list(...args);
  };

  await scanner.scan(reference);
  releaseDescendant.resolve();
  await bounded(descendant.promise);
  assert.equal(calls, 2);
});

test('postgres: folder scanner close aborts bounded lock contention',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, scanner, reference } = await fixture(t, 'postgres');
    const blocker = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema: database.schemaName
    });
    const query = database.client.query.bind(database.client);
    let observeLock;
    const lockObserved = new Promise(resolve => { observeLock = resolve; });
    database.client.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (/^LOCK TABLE\b/u.test(sql ?? '')) observeLock();
      return query(...args);
    };

    try {
      await blocker.withConnection(async blockingSession => {
        await blockingSession.client.query('BEGIN');
        try {
          await blockingSession.client.query(
            `SELECT 1 FROM "${database.schemaName}"."BaseItems" WHERE "Id" = $1 FOR UPDATE`, [ROOT_ID]);

          const active = scanner.scan(reference);
          const rejected = assert.rejects(active,
            error => error?.code === 'cancelled' || error?.name === 'AbortError');
          await bounded(lockObserved);
          await bounded(scanner.close());
          await bounded(rejected);
        } finally {
          await blockingSession.client.query('ROLLBACK').catch(() => {});
        }
      });
    } finally {
      database.client.query = query;
      await blocker.close();
    }
  });

test('postgres: folder scanner close bounds an exclusive lock during pre-enumeration reads',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, scanner, reference } = await fixture(t, 'postgres');
    const blocker = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema: database.schemaName
    });
    const query = database.client.query.bind(database.client);
    let observeRead;
    const readObserved = new Promise(resolve => { observeRead = resolve; });
    database.client.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (/\bFROM\s+(?:"[^"]+"\.)?"BaseItems"(?:\s|$)/u.test(sql ?? '')) observeRead();
      return query(...args);
    };

    try {
      await blocker.withConnection(async blockingSession => {
        await blockingSession.client.query('BEGIN');
        try {
          await blockingSession.client.query(
            `LOCK TABLE "${database.schemaName}"."BaseItems" IN ACCESS EXCLUSIVE MODE`);

          const active = scanner.scan(reference);
          const rejected = assert.rejects(active,
            error => error?.code === 'cancelled' || error?.name === 'AbortError' || error?.code === '55P03');
          await bounded(readObserved);
          await bounded(scanner.close());
          await bounded(rejected);
          assert.equal(database.inTransaction, false);
        } finally {
          await blockingSession.client.query('ROLLBACK').catch(() => {});
        }
      });
    } finally {
      database.client.query = query;
      await blocker.close();
    }
  });

test('postgres: folder scanner bounds a cascade row-lock wait without partial mutation',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, 'postgres');
    await adapter.mkdir('/Keep');
    await adapter.mkdir('/Locked');
    await scanner.scan(reference);
    const lockedId = folderId('Z:\\Library\\Locked');
    const imageId = 'E1000000-0000-0000-0000-000000000013';
    await database.insert('BaseItemImageInfos', {
      ...blank('BaseItemImageInfos'),
      Id: imageId,
      ItemId: lockedId,
      ImageType: 0,
      Path: 'Z:\\Library\\Locked\\poster.jpg',
      Width: 1,
      Height: 1
    });
    await adapter.delete('/Locked');

    const blocker = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema: database.schemaName
    });
    const query = database.client.query.bind(database.client);
    let observeDelete;
    const deleteObserved = new Promise(resolve => { observeDelete = resolve; });
    database.client.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (/\bDELETE FROM\s+(?:"[^"]+"\.)?"BaseItems"(?:\s|$)/u.test(sql ?? '')) observeDelete();
      return query(...args);
    };

    try {
      await blocker.withConnection(async blockingSession => {
        await blockingSession.client.query('BEGIN');
        try {
          const locked = await blockingSession.client.query(
            `SELECT 1 FROM "${database.schemaName}"."BaseItemImageInfos" WHERE "Id" = $1 FOR UPDATE`, [imageId]);
          assert.equal(locked.rowCount, 1);

          const active = scanner.scan(reference);
          const rejected = assert.rejects(active,
            error => error?.code === 'cancelled' || error?.name === 'AbortError' || error?.code === '55P03');
          await bounded(deleteObserved, 5000);
          await bounded(scanner.close());
          await bounded(rejected);
          assert.equal((await database.rows('BaseItems', { where: { Id: lockedId } })).length, 1);
          assert.equal((await database.rows('BaseItemImageInfos', { where: { Id: imageId } })).length, 1);
        } finally {
          await blockingSession.client.query('ROLLBACK').catch(() => {});
        }
      });
    } finally {
      database.client.query = query;
      await blocker.close();
    }
  });

test('postgres: close waits for an already committed scan response and still publishes its journal',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, adapter, scanner, reference, library } = await fixture(t, 'postgres');
    await adapter.mkdir('/Committed');
    const committedId = folderId('Z:\\Library\\Committed');
    const events = [];
    library.on('ItemAdded', ({ Item }) => events.push(Item.Id));

    const query = database.client.query.bind(database.client);
    let writeLocked = false;
    let observeCommit;
    const commitObserved = new Promise(resolve => { observeCommit = resolve; });
    let releaseCommit;
    const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    database.client.query = async (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (/^LOCK TABLE\b/u.test(sql ?? '')) writeLocked = true;
      const result = await query(...args);
      if (writeLocked && sql === 'COMMIT') {
        observeCommit();
        await commitGate;
      }
      return result;
    };

    try {
      const active = scanner.scan(reference);
      await bounded(commitObserved, 5000);
      let closed = false;
      const closing = scanner.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(closed, false, 'close must wait for the committed transaction result to settle');

      releaseCommit();
      await bounded(closing);
      await bounded(active);
      assert.equal((await database.rows('BaseItems', { where: { Id: committedId } })).length, 1);
      assert.deepEqual(events.map(key), [key(committedId)]);
    } finally {
      releaseCommit();
      database.client.query = query;
    }
  });

test('postgres: bounded path owners preserve native Windows and POSIX normalization', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database } = await fixture(t, 'postgres');
  const windowsId = randomUUID().toUpperCase();
  const posixId = randomUUID().toUpperCase();
  await database.insert('BaseItems', item(windowsId, 'Movie', {
    Path: 'q:/foreign/draft/.././\u00c4Case\\\\'
  }));
  await database.insert('BaseItems', item(posixId, 'Movie', {
    Path: '/srv/media/drafts/.././movie.mkv//'
  }));

  const matched = await loadPostgresRowsByPaths(database, [
    'Q:\\FOREIGN\\\u00e4cASE',
    '/srv/media/movie.mkv'
  ]);

  assert.deepEqual(new Set(matched.map(row => key(row.Id))), new Set([key(windowsId), key(posixId)]));
  for (let index = 0; index < 12; index++) {
    await database.insert('BaseItems', item(randomUUID().toUpperCase(), 'Movie', {
      Path: `/srv/duplicate/${index}/../movie.mkv`
    }));
  }
  const collisions = await loadPostgresRowsByPaths(database, ['/srv/duplicate/movie.mkv']);
  assert.equal(collisions.length, 2, 'at most two owners per requested native path are transferred to Node');
});

test('postgres: folder scans keep path ownership and relation values bounded to the active plan', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, 'postgres');
  await database.update('BaseItems', { Id: ROOT_ID }, { Tags: 'BoundedTag' });
  for (let index = 0; index < 64; index++) {
    await database.insert('BaseItems', item(randomUUID().toUpperCase(), 'Movie', {
      Name: `Foreign ${index}`,
      CleanName: `foreign ${index}`,
      SortName: `foreign ${index}`,
      Path: `Q:\\Foreign\\${index}`,
      ParentId: null,
      TopParentId: null
    }));
    await database.insert('ItemValues', {
      ...blank('ItemValues'),
      ItemValueId: randomUUID().toUpperCase(),
      Type: 2,
      Value: `Foreign value ${index}`,
      CleanValue: `foreign value ${index}`
    });
  }

  const rowReads = [];
  const watched = new Set(['BaseItems', 'ItemValues', 'AncestorIds', 'UserData', 'LinkedChildren']);
  const databaseRows = database.rows.bind(database);
  database.rows = (table, options) => {
    if (watched.has(table)) {
      rowReads.push({ table, options });
      const bounded = Object.keys(options?.where ?? {}).length > 0
        || Object.keys(options?.whereIn ?? {}).length > 0
        || options?.limit !== undefined;
      if (!bounded) throw new Error(`Folder scan attempted an unbounded PostgreSQL ${table} read.`);
    }
    return databaseRows(table, options);
  };
  const pathQueries = [];
  const linkedReferenceQueries = [];
  const valueWrites = [];
  const query = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const result = await query(...args);
    if (/^\s*SELECT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:"[^"]+"\.)?"LinkedChildren"\s+WHERE\b/u.test(text ?? '')) {
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      assert.equal(values.length, 2, 'the link check transfers only one key and its active subtree keys');
      assert.match(values[0], /^[a-f0-9]{32}$/u);
      assert.ok(Array.isArray(values[1]) && values[1].length > 0 && values[1].length < 16, 'the link predicate remains within the small active subtree');
      assert.ok(values[1].every(value => /^[a-f0-9]{32}$/u.test(value)) && values[1].includes(values[0]));
      assert.equal(result.rows.length, 1);
      assert.equal(typeof result.rows[0].present, 'boolean');
      linkedReferenceQueries.push({ table: 'LinkedChildren', key: values[0], subtree: [...values[1]], present: result.rows[0].present });
    }
    if (text?.includes('folder-scan-path-owners')) {
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      pathQueries.push({ candidates: values[0].length, rows: result.rows.length });
    }
    if (/INSERT INTO\s+(?:"[^"]+"\.)?"ItemValues"\s/u.test(text ?? '')) {
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      valueWrites.push(values[2].map(bytes => decodeNativeTextBytes(bytes)));
    }
    return result;
  };
  t.after(() => {
    database.rows = databaseRows;
    database.client.query = query;
  });

  for (const entry of ['/Gone', '/Kept', '/Deep', '/Deep/Child']) await adapter.mkdir(entry);
  await scanner.scan(reference);
  rowReads.length = 0; linkedReferenceQueries.length = 0;
  await scanner.scan(reference);
  assert.deepEqual(rowReads.filter(call => ['UserData', 'LinkedChildren'].includes(call.table)), [],
    'an unchanged scan does not inspect deletion references');
  assert.deepEqual(linkedReferenceQueries, [], 'an unchanged scan does not execute a SQL deletion-reference check');
  rowReads.length = 0; linkedReferenceQueries.length = 0;
  await adapter.delete('/Gone');
  await adapter.mkdir('/Added');
  await scanner.scan(reference);

  assert.ok(pathQueries.length >= 4, 'each reconciliation performs a bounded collision read and final ownership read');
  assert.ok(pathQueries.every(call => call.candidates > 0 && call.candidates < 16),
    'path predicates contain only paths from the active scan plan');
  assert.ok(pathQueries.every(call => call.rows < 16),
    'foreign path rows are filtered in PostgreSQL instead of transferred to Node');
  assert.ok(valueWrites.some(values => values.includes('BoundedTag')),
    'inherited tags exercise the batched relation-value mutation');
  assert.ok(valueWrites.every(values => values.length < 16 && values.every(value => !value.startsWith('Foreign value '))),
    'relation mutations use only values from the active scan plan');
  for (const table of ['UserData', 'LinkedChildren']) {
    assert.ok(rowReads.some(call => call.table === table) || linkedReferenceQueries.some(call => call.table === table),
      table + ' is inspected when a missing managed subtree must be checked');
  }
  const gone = key(folderId('Z:\\Library\\Gone'));
  assert.deepEqual(new Set(linkedReferenceQueries.map(call => call.key)), new Set([gone]), 'only the missing active subtree is checked for SQL link references');
  assert.ok(linkedReferenceQueries.every(call => call.subtree.length === 1 && call.subtree[0] === gone && call.present === false));
  for (const field of ['ParentId', 'OwnerId']) assert.ok(rowReads.some(call => call.table === 'BaseItems'
    && key(call.options?.where?.[field]) === gone), field + ' is inspected for the exact missing subtree root');
  assert.equal((await databaseRows('BaseItems', { where: { Id: folderId('Z:\\Library\\Gone') } })).length, 0);
  assert.equal((await databaseRows('BaseItems', { where: { Id: folderId('Z:\\Library\\Added') } })).length, 1);
});

test('a missing managed folder-only subtree cascades and publishes removals from leaves to root', async t => {
  const { database, library, adapter, scanner, reference } = await fixture(t, 'postgres');
  for (const path of ['/Cascade', '/Cascade/Child', '/Cascade/Child/Grandchild', '/Survivor']) {
    await adapter.mkdir(path);
  }
  await scanner.scan(reference);
  const cascadeId = folderId('Z:\\Library\\Cascade');
  const childId = folderId('Z:\\Library\\Cascade\\Child');
  const grandchildId = folderId('Z:\\Library\\Cascade\\Child\\Grandchild');
  const removed = [];
  library.on('ItemRemoved', ({ Item, Parent }) => removed.push({ item: key(Item.Id), parent: key(Parent.Id) }));

  await adapter.delete('/Cascade');
  await scanner.scan(reference);

  for (const Id of [cascadeId, childId, grandchildId]) {
    assert.equal((await database.rows('BaseItems', { where: { Id } })).length, 0);
  }
  assert.deepEqual(removed, [
    { item: key(grandchildId), parent: key(childId) },
    { item: key(childId), parent: key(cascadeId) },
    { item: key(cascadeId), parent: key(ROOT_ID) }
  ], 'the post-commit removal journal preserves descendant-before-parent order');
});

test('a second database snapshot conflict fails without partially applying scanner changes', async t => {
  const { database, library, adapter, vfs, scanner, reference } = await fixture(t, 'postgres');
  await adapter.mkdir('/NeverCommitted');
  const targetId = folderId('Z:\\Library\\NeverCommitted');
  const injectedIds = [
    'E2000000-0000-0000-0000-000000000001',
    'E2000000-0000-0000-0000-000000000002'
  ];
  const changes = [];
  for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => changes.push([name, event.Item.Id]));
  const list = vfs.list.bind(vfs);
  let rootLists = 0;
  vfs.list = async (path, options) => {
    const result = await list(path, options);
    if (path === '/library' && rootLists < injectedIds.length) {
      const Id = injectedIds[rootLists++];
      await database.insert('BaseItems', item(Id, 'Movie', {
        Name: `Concurrent item ${rootLists}`,
        ParentId: ROOT_ID,
        TopParentId: ROOT_ID,
        Path: `Z:\\Library\\concurrent-${rootLists}.mkv`
      }));
    }
    return result;
  };

  await assert.rejects(scanner.scan(reference), { code: 'version-changed' });

  assert.equal(rootLists, 2, 'the scanner retries exactly once before surfacing the second conflict');
  assert.equal((await database.rows('BaseItems', { where: { Id: targetId } })).length, 0,
    'the desired folder is never inserted by either conflicted transaction');
  assert.equal((await database.rows('AncestorIds', { where: { ItemId: targetId } })).length, 0);
  for (const Id of injectedIds) assert.equal((await database.rows('BaseItems', { where: { Id } })).length, 1);
  assert.deepEqual(changes, [], 'a failed double-conflict scan publishes no library mutations');
});

test('a deep second conflict rolls back earlier folder mutations and post-commit events', async t => {
  const { database, library, adapter, vfs, scanner, reference } = await fixture(t, 'postgres');
  await adapter.mkdir('/Existing');
  await scanner.scan(reference);
  const existingId = folderId('Z:\\Library\\Existing');
  const rootTargetId = folderId('Z:\\Library\\RootWouldRollback');
  await adapter.mkdir('/RootWouldRollback');
  const injectedIds = [
    'E4000000-0000-0000-0000-000000000001',
    'E4000000-0000-0000-0000-000000000002'
  ];
  const events = [];
  for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push([name, event.Item.Id]));
  const list = vfs.list.bind(vfs);
  let nestedLists = 0;
  vfs.list = async (path, options) => {
    const result = await list(path, options);
    if (path === '/library/Existing' && nestedLists < injectedIds.length) {
      const Id = injectedIds[nestedLists++];
      await database.insert('BaseItems', item(Id, 'Movie', {
        Name: `Nested concurrent item ${nestedLists}`,
        ParentId: existingId,
        TopParentId: ROOT_ID,
        Path: `Z:\\Library\\Existing\\concurrent-${nestedLists}.mkv`
      }));
    }
    return result;
  };

  await assert.rejects(scanner.scan(reference), { code: 'version-changed' });

  assert.equal(nestedLists, 2);
  assert.equal((await database.rows('BaseItems', { where: { Id: rootTargetId } })).length, 0,
    'a root mutation performed before the deep conflict is rolled back');
  assert.equal((await database.rows('AncestorIds', { where: { ItemId: rootTargetId } })).length, 0);
  for (const Id of injectedIds) assert.equal((await database.rows('BaseItems', { where: { Id } })).length, 1);
  assert.deepEqual(events, [], 'a rolled-back scan publishes no library mutation event');
});

test('repository children racing a newly planned folder retry before any stale lifecycle side effect', async t => {
  const lifecycleCalls = [];
  const resolvedItemLifecycle = {
    async apply(id) {
      lifecycleCalls.push(id);
      return { branch: 'images', changed: false, imagesChanged: false, saves: [] };
    }
  };
  const { database, adapter, vfs, scanner, reference } = await fixture(t, 'postgres', { resolvedItemLifecycle });
  await adapter.mkdir('/Future');
  await adapter.mkdir('/Future/Child');
  const futureId = folderId('Z:\\Library\\Future');
  const childId = folderId('Z:\\Library\\Future\\Child');
  const list = vfs.list.bind(vfs);
  let injected = false;
  vfs.list = async (pathname, options) => {
    const result = await list(pathname, options);
    if (!injected && pathname === '/library/Future') {
      injected = true;
      await database.insert('BaseItems', item(futureId, 'Folder', {
        Name: 'Future', CleanName: 'future', SortName: 'future', ParentId: ROOT_ID, TopParentId: ROOT_ID,
        Path: 'Z:\\Library\\Future'
      }));
      await database.insert('BaseItems', item(childId, 'Folder', {
        Name: 'Child', CleanName: 'child', SortName: 'child', ParentId: futureId, TopParentId: ROOT_ID,
        Path: 'Z:\\Library\\Future\\Child'
      }));
    }
    return result;
  };

  await scanner.scan(reference);

  assert.equal(injected, true);
  assert.deepEqual(lifecycleCalls.map(key), [key(futureId), key(childId)],
    'only the fresh retry runs lifecycle work for the concurrently committed hierarchy');
});

test('scan cancellation during a no-token lifecycle lets direct siblings finish before recursion', async t => {
  const controller = new AbortController();
  const calls = [];
  const resolvedItemLifecycle = {
    async apply(id) {
      calls.push(id);
      controller.abort();
      return { branch: 'images', changed: false, imagesChanged: false, saves: [] };
    }
  };
  const { adapter, scanner, reference } = await fixture(t, 'postgres', { resolvedItemLifecycle });
  await adapter.mkdir('/Alpha');
  await adapter.mkdir('/Beta');
  await scanner.scan(reference);

  await assert.rejects(scanner.scan(reference, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls.length, 2,
    'native direct siblings finish their no-token lifecycle before the folder-level cancellation check');
});

test('Windows scans reject case-only siblings in one VFS listing atomically', async t => {
  const current = await fixture(t, 'postgres', { configuration: { EnableCaseSensitiveItemIds: false } });
  const { database, adapter, scanner, reference } = current;
  await adapter.mkdir('/Ambiguous');
  await adapter.mkdir('/ambiguous');
  const beforeItems = await rows(database, 'BaseItems');
  const beforeAncestors = await rows(database, 'AncestorIds');

  await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });

  assert.deepEqual(await rows(database, 'BaseItems'), beforeItems);
  assert.deepEqual(await rows(database, 'AncestorIds'), beforeAncestors,
    'ambiguous native paths are rejected before any folder or ancestor mutation');
  assert.equal((await database.rows('BaseItems', { where: { Id: folderId('Z:\\Library\\Ambiguous') } })).length, 0);
});

test('folder scanning treats a forward-slash UNC identity root as a Windows path', async t => {
  const rootPath = '//Server/Share/Library';
  const { database, adapter, scanner, reference } = await fixture(t, 'postgres', { rootPath });
  await adapter.mkdir('/ForwardSlashChild');

  await scanner.scan(reference);

  assert.equal((await database.rows('BaseItems', {
    where: { Id: folderId(`${rootPath}/ForwardSlashChild`) }
  })).length, 1);
});

test('every semantic BaseItems reference field protects a missing managed folder', async t => {
  const { database, adapter, scanner, reference } = await fixture(t, 'postgres');
  const cases = [
    ['PrimaryVersionId', 'PrimaryProtected', 'E3000000-0000-0000-0000-000000000001'],
    ['SeriesId', 'SeriesProtected', 'E3000000-0000-0000-0000-000000000002'],
    ['SeasonId', 'SeasonProtected', 'E3000000-0000-0000-0000-000000000003'],
    ['TopParentId', 'TopParentProtected', 'E3000000-0000-0000-0000-000000000004']
  ].map(([field, name, referenceId]) => ({
    field,
    name,
    referenceId,
    targetId: folderId(`Z:\\Library\\${name}`)
  }));
  await adapter.mkdir('/Keeper');
  for (const { name } of cases) await adapter.mkdir(`/${name}`);
  await scanner.scan(reference);

  for (const { field, name, referenceId, targetId } of cases) {
    await database.insert('BaseItems', item(referenceId, 'Movie', {
      Name: `${field} reference`,
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      Path: `Z:\\Library\\${name}-reference.mkv`,
      [field]: targetId
    }));
    await adapter.delete(`/${name}`);
  }

  const result = await scanner.scan(reference);

  assert.equal(result.skippedDeletion, true);
  for (const { field, referenceId, targetId } of cases) {
    assert.equal((await database.rows('BaseItems', { where: { Id: targetId } })).length, 1,
      `${field} conservatively retains its referenced missing folder`);
    assert.equal((await database.rows('BaseItems', { where: { Id: referenceId } })).length, 1);
  }
});
