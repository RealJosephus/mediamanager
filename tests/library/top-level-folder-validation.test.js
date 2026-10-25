import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';
import { collectionFolderNativeType, physicalFolderNativeType, newNativeItemEntity,
  refreshCollectionFolderLocations } from '../../src/library/index.js';
import { publishNativeItemLinks, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { collectionTypeFromMarkers } from '../../src/library/top-level-folder-validation.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const mediaPath = 'Z:\\TopLevel\\Movies';
const key = value => String(value).replaceAll('-', '').toLowerCase();

async function cleanupPostgres(schema) {
  if (!schema) return;
  const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
  } finally { await client.end(); }
}

async function fixture(t, dialect) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-top-level-'));
  const schema = `top_level_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const storage = new StorageRegistry();
  let database, runtime;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [async () => {
      if (!runtime) return;
      const relationSchema = runtime.linkedChildren.schemaName;
      await runtime.close();
      const observer = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
      await observer.connect();
      try {
        assert.equal((await observer.query('SELECT to_regnamespace($1) AS namespace', [relationSchema])).rows[0].namespace, null,
          'Normal runtime shutdown releases its cached roots and every owned relation.');
      } finally { await observer.end(); }
    }, () => storage.close(), () => database?.close(),
      () => cleanupPostgres(schema), async () => {
        assert.equal(path.dirname(path.resolve(stateRoot)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(stateRoot).startsWith('mediamanager-top-level-'));
        await rm(stateRoot, { recursive: true, force: true });
      }]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Top-level fixture cleanup failed.');
  });
  const firstPath = path.join(stateRoot, 'root', 'default', 'Oracle Movies');
  await mkdir(firstPath, { recursive: true });
  await writeFile(path.join(firstPath, 'movies.collection'), '');
  await writeFile(path.join(firstPath, 'root.mblink'), mediaPath);

  database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  storage.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await storage.createInstance('media', 'memory', {});
  await adapter.mkdir('/Movies');
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: mediaPath, accessRoot: '/media/Movies', style: 'windows',
    returnAccess: 'isolated top-level validation fixture' });
  const ignoreIdentityMap = await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap,
    identityRoots: [mediaPath] });
  const errors = [];
  runtime = await createTestRuntime({
    database,
    vfs,
    identityMap,
    ignoreIdentityMap,
    programDataPath: stateRoot,
    configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true,
      EnableCaseSensitiveItemIds: false },
    serverId: `top-level-${dialect}`,
    onError: error => errors.push(error)
  });
  const tasks = runtime.libraryScanLifecycle.postScanTasks;
  assert.deepEqual(tasks.map(task => task.name), ['Splashscreen', 'Artists', 'CollectionPosterVerify', 'Collections', 'Genres', 'MusicGenres', 'Studios', 'CleanDatabase']);
  assert.equal(runtime.libraryScanLifecycle.capabilities.runsPostScanTasks, true);
  return { runtime, database, adapter, stateRoot, firstPath, errors };
}

async function rowsByType(database, type) {
  return (await database.rows('BaseItems')).filter(row => row.Type === type);
}

async function createLinkRelation(linkedChildren, parentId, rows) {
  return linkedChildren.withSession(async session => {
    const writer = await linkedChildren.createWriter({ session, parentId });
    try {
      for (const row of rows) await writer.append(row);
      return await writer.finish();
    } catch (error) {
      try { await writer.abort(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
      throw error;
    }
  });
}

async function readLinkRelation(linkedChildren, handle) {
  return linkedChildren.withSession(async session => {
    const rows = [];
    for await (const page of linkedChildren.pages(handle, { session })) rows.push(...page);
    return rows.map(({ ItemId, Type, Path, LibraryItemId }) => ({ ItemId, Type, Path, LibraryItemId }));
  });
}

async function privateLinkSetCount(linkedChildren) {
  // Root initialization can still be retiring replaced cache resources.
  // Observe both baselines only after the owned collector and raw links drain.
  await linkedChildren.flushOwnedReleases();
  await linkedChildren.flushReleases();
  return linkedChildren.withSession(async session => BigInt((await session.client.query(
    `SELECT count(*) AS count FROM "${linkedChildren.schemaName}".sets`)).rows[0].count));
}

function testFolder(nativeType, Id) {
  const item = newNativeItemEntity(nativeType); item.Id = Id; return item;
}

test('postgres: poster maintenance loads user-root libraries and persists local images through the real refresh host',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database, firstPath, errors } = await fixture(t, 'postgres');
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    const [collection] = await rowsByType(database, collectionFolderNativeType);
    assert.ok(collection);
    const root = await runtime.libraryScanHost.getUserRootFolder();
    await runtime.libraryScanHost.withChildSnapshot(root, async children => {
      const ids = [];
      for await (const page of children.pages()) ids.push(...page.map(item => key(item.Id)));
      assert.deepEqual(ids, [key(collection.Id)]);
    }, { includeItemTypes: [collectionFolderNativeType] });
    assert.deepEqual(await database.rows('BaseItemImageInfos', { where: { ItemId: collection.Id } }), []);
    const poster = path.join(firstPath, 'poster.png');
    const bytes = await sharp(Buffer.from([255, 0, 0, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    await writeFile(poster, bytes);
    const seen = [], refresh = runtime.metadataScanner.refreshLiveItem.bind(runtime.metadataScanner);
    runtime.metadataScanner.refreshLiveItem = async (item, options) => {
      seen.push(item); return refresh(item, options);
    };
    const progress = [];
    await runtime.collectionPosterVerifyPostScanTask.run({ reportProgress: value => progress.push(value) });
    assert.equal(seen.length, 1); assert.equal(key(seen[0].Id), key(collection.Id));
    const images = await database.rows('BaseItemImageInfos', { where: { ItemId: collection.Id } });
    assert.equal(images.length, 1); assert.equal(images[0].ImageType, 0); assert.equal(images[0].Path, poster);
    assert.deepEqual(await readFile(poster), bytes);
    assert.deepEqual(progress, [100, 100]);
    await runtime.collectionPosterVerifyPostScanTask.run();
    assert.equal(seen.length, 1, 'A persisted primary relationship prevents a redundant refresh.');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.collectionPosterVerifyPostScanTask.run({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(seen.length, 1); assert.deepEqual(errors, []);
  });

test('postgres: poster root selection excludes owned and alternate libraries in SQL',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database } = await fixture(t, 'postgres');
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    const [collection] = await rowsByType(database, collectionFolderNativeType);
    const root = await runtime.libraryScanHost.getUserRootFolder();
    for (const [Id, fields] of [
      ['ba400000-0000-0000-0000-000000000101', { OwnerId: collection.Id }],
      ['ba400000-0000-0000-0000-000000000102', { PrimaryVersionId: collection.Id }]
    ]) await database.insert('BaseItems', { ...collection, Id, ...fields });
    await runtime.libraryScanHost.withChildSnapshot(root, async children => {
      const ids = [];
      for await (const page of children.pages()) ids.push(...page.map(item => key(item.Id)));
      assert.deepEqual(ids, [key(collection.Id)]);
    });
    const refreshed = [];
    runtime.metadataScanner.refreshLiveItem = async item => refreshed.push(item.Id);
    await runtime.collectionPosterVerifyPostScanTask.run();
    assert.deepEqual(refreshed.map(key), [key(collection.Id)]);
  });

test('collection markers use case-sensitive enum names and skip invalid marker files', () => {
  assert.equal(collectionTypeFromMarkers([
    { IsDirectory: false, Path: 'Z:\\Library\\00-invalid.collection' },
    { IsDirectory: false, Path: 'Z:\\Library\\TVSHOWS.collection' },
    { IsDirectory: false, Path: 'Z:\\Library\\tvshows.COLLECTION' }
  ]), 'tvshows');
  assert.equal(collectionTypeFromMarkers([
    { IsDirectory: false, Path: 'Z:\\Library\\MOVIES.collection' },
    { IsDirectory: true, Path: 'Z:\\Library\\movies.collection' }
  ]), null);
});

test('postgres: collection links flatten physical folders in order with native comparison and owned leases',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime } = await fixture(t, 'postgres');
    const linkedChildren = runtime.linkedChildren, baselineSets = await privateLinkSetCount(linkedChildren);
    const collection = testFolder(collectionFolderNativeType, randomUUID());
    const physicalA = testFolder(physicalFolderNativeType, randomUUID());
    const physicalB = testFolder(physicalFolderNativeType, randomUUID());
    const shared = randomUUID(), missing = randomUUID(), empty = '00000000-0000-0000-0000-000000000000';
    const first = [
      { ItemId: shared, Type: 0, Path: 'ignored/first', LibraryItemId: 'first-library' },
      { ItemId: null, Type: 1, Path: 'relative/legacy/', LibraryItemId: 'legacy-library' },
      { ItemId: shared, Type: 0, Path: 'ignored/duplicate', LibraryItemId: 'duplicate-library' }
    ];
    const second = [
      { ItemId: shared, Type: 0, Path: 'ignored/cross-folder-duplicate', LibraryItemId: null },
      { ItemId: empty, Type: 0, Path: 'ignored/empty-guid', LibraryItemId: 'empty-guid-library' },
      { ItemId: missing, Type: 1, Path: 'ignored/missing-target', LibraryItemId: 'missing-library' }
    ];
    const flattened = [...first, ...second];
    const current = flattened.map((row, index) => ({ ...row,
      Path: row.ItemId == null
        ? process.platform === 'win32' ? 'RELATIVE/LEGACY' : 'relative/legacy'
        : `different/ignored/${index}`,
      LibraryItemId: `different-library-${index}`
    }));
    collection.PhysicalLocationsList = ['collection', 'physical-a', 'physical-b'];
    collection.PhysicalFolderIds = [physicalA.Id, physicalB.Id];
    const loaded = {
      item: collection, linkedChildren,
      async rootFolderResolveArgs(setLocations) { assert.equal(setLocations, true); return { files: [] }; },
      async physicalFolders(enableCache) { assert.equal(enableCache, false); return [physicalA, physicalB]; }
    };

    try {
      publishNativeItemLinks(physicalA, await createLinkRelation(linkedChildren, physicalA.Id, first));
      publishNativeItemLinks(physicalB, await createLinkRelation(linkedChildren, physicalB.Id, second));
      publishNativeItemLinks(collection, await createLinkRelation(linkedChildren, collection.Id, current));

      const equal = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(equal, { updateType: ItemUpdateType.None, requiresSave: false });
      assert.equal(collection.LinkedChildrenLoaded, true);
      assert.deepEqual(await readLinkRelation(linkedChildren, collection.LinkedChildren), flattened,
        'raw duplicates, missing targets and physical-folder order remain observable before persistence');

      const changedSecond = second.map(row => ({ ...row }));
      changedSecond.at(-1).Type = 2;
      publishNativeItemLinks(physicalB, await createLinkRelation(linkedChildren, physicalB.Id, changedSecond));
      const changed = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(changed, { updateType: ItemUpdateType.None, requiresSave: true });
      assert.deepEqual(await readLinkRelation(linkedChildren, collection.LinkedChildren), [...first, ...changedSecond]);

      collection.PhysicalFolderIds = [physicalB.Id, physicalA.Id];
      const idsOnly = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(idsOnly, { updateType: ItemUpdateType.None, requiresSave: true },
        'an ID-only repair relies on ForceSave without adding MetadataImport');
      assert.deepEqual(collection.PhysicalFolderIds, [physicalA.Id, physicalB.Id]);
      const stableIds = [...collection.PhysicalFolderIds];
      const stable = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(stable, { updateType: ItemUpdateType.None, requiresSave: false });
      assert.deepEqual(collection.PhysicalFolderIds, stableIds);

      const beforeFailure = await readLinkRelation(linkedChildren, collection.LinkedChildren);
      publishNativeItemLinks(physicalB, null);
      await assert.rejects(refreshCollectionFolderLocations(loaded));
      assert.deepEqual(await readLinkRelation(linkedChildren, collection.LinkedChildren), beforeFailure,
        'a failed flatten preserves the complete collection relation');
      assert.deepEqual(collection.PhysicalFolderIds, stableIds);
    } finally {
      for (const item of [collection, physicalA, physicalB]) releaseNativeItemLinks(item);
      await linkedChildren.flushReleases();
    }
    assert.equal(await privateLinkSetCount(linkedChildren), baselineSets,
      'published, replaced, failed and iterator leases all return to the session baseline');
  });

test('postgres: collection refresh cold-loads unknown links and publishes authoritative empty state',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database } = await fixture(t, 'postgres');
    const linkedChildren = runtime.linkedChildren, baselineSets = await privateLinkSetCount(linkedChildren);
    const collection = testFolder(collectionFolderNativeType, randomUUID());
    const physical = testFolder(physicalFolderNativeType, randomUUID());
    const childId = randomUUID();
    collection.PhysicalLocationsList = ['collection', 'physical'];
    collection.PhysicalFolderIds = [physical.Id];
    for (const row of [
      { Id: collection.Id, Type: collectionFolderNativeType, IsFolder: true },
      { Id: physical.Id, Type: physicalFolderNativeType, IsFolder: true },
      { Id: childId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', IsFolder: false }
    ]) await database.insert('BaseItems', postgresTestRow('BaseItems', { ...row, Data: '{}' }));
    for (const ParentId of [collection.Id, physical.Id]) await database.insert('LinkedChildren', {
      ParentId, ChildId: childId, ChildType: 0, SortOrder: 0
    });
    let folders = [physical];
    const loaded = { item: collection, linkedChildren,
      async rootFolderResolveArgs() { return { files: [] }; },
      async physicalFolders() { return folders; } };

    try {
      assert.equal(collection.LinkedChildrenLoaded, false);
      assert.equal(physical.LinkedChildrenLoaded, false);
      const unchanged = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(unchanged, { updateType: ItemUpdateType.None, requiresSave: false });
      assert.equal(collection.LinkedChildrenLoaded, true);
      assert.equal(physical.LinkedChildrenLoaded, false, 'temporary cold source handles do not rewrite physical folders');
      assert.deepEqual(await readLinkRelation(linkedChildren, collection.LinkedChildren), [
        { ItemId: childId, Type: 0, Path: null, LibraryItemId: null }
      ]);

      folders = []; collection.PhysicalFolderIds = [];
      const emptied = await refreshCollectionFolderLocations(loaded);
      assert.deepEqual(emptied, { updateType: ItemUpdateType.None, requiresSave: true },
        'a links-only change upgrades the owner refresh to ForceSave');
      assert.deepEqual(await readLinkRelation(linkedChildren, collection.LinkedChildren), []);
      assert.equal(collection.LinkedChildrenLoaded, true, 'empty is authoritative after native-style assignment');
    } finally {
      for (const item of [collection, physical]) releaseNativeItemLinks(item);
      await linkedChildren.flushReleases();
    }
    assert.equal(await privateLinkSetCount(linkedChildren), baselineSets);
  });

test('postgres: a fresh collection publishes empty physical IDs before owned refresh forces reason 11',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database, adapter, stateRoot, firstPath, errors } = await fixture(t, 'postgres');
    const identityOptions = { programDataPath: stateRoot, enableCaseSensitiveItemIds: false };
    const collectionId = nativeGuid(getNewItemId(firstPath, collectionFolderNativeType, identityOptions));
    const physicalId = nativeGuid(getNewItemId(mediaPath, physicalFolderNativeType, identityOptions));
    await adapter.write('/Movies/Feature.mkv', Buffer.from('fixture'));
    let phase = 1;
    const events = [];
    runtime.library.on('ItemAdded', ({ Item }) => {
      if (Item.Type === 'CollectionFolder') events.push({ phase, action: 'added', ids: [...Item.PhysicalFolderIds] });
    });
    runtime.library.on('ItemUpdated', ({ Item, UpdateReason }) => {
      if (Item.Type === 'CollectionFolder') events.push({ phase, action: 'updated', reason: UpdateReason,
        ids: [...Item.PhysicalFolderIds] });
    });

    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    assert.deepEqual(events, [
      { phase: 1, action: 'added', ids: [] },
      { phase: 1, action: 'updated', reason: 2, ids: [physicalId] },
      { phase: 1, action: 'updated', reason: 11, ids: [physicalId] }
    ]);
    assert.deepEqual((await runtime.library.getItemRecord(collectionId)).PhysicalFolderIds.map(key), [key(physicalId)]);

    phase = 2;
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    assert.equal(events.some(event => event.phase === 2 && event.action === 'updated' && (event.reason & 8) !== 0), false);
    assert.deepEqual(errors, []);
    assert.equal((await database.rows('BaseItems', { where: { Id: collectionId } })).length, 1);
  });

for (const dialect of ['postgres']) test(`${dialect}: top-level validation persists configured collections and shared physical roots`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database, adapter, stateRoot, firstPath, errors } = await fixture(t, dialect);
    const identityOptions = { programDataPath: stateRoot, enableCaseSensitiveItemIds: false };
    const firstId = nativeGuid(getNewItemId(firstPath, collectionFolderNativeType, identityOptions));
    const physicalId = nativeGuid(getNewItemId(mediaPath, physicalFolderNativeType, identityOptions));

    assert.equal(runtime.libraryScanner.capabilities.reconcilesTopLevelConfiguration, true);
    assert.equal(runtime.libraryScanner.capabilities.runsMetadataProbeRefresh, true);
    assert.equal(runtime.libraryScanner.capabilities.runsPostScanTasks, true);
    assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);

    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    let userRoots = await rowsByType(database, 'MediaBrowser.Controller.Entities.UserRootFolder');
    let collections = await rowsByType(database, collectionFolderNativeType);
    let physical = await rowsByType(database, physicalFolderNativeType);
    assert.equal(userRoots.length, 1);
    assert.equal(userRoots[0].Name, 'Media Folders');
    assert.equal(collections.length, 1);
    assert.equal(collections[0].Id, firstId);
    assert.equal(collections[0].ParentId, userRoots[0].Id);
    assert.equal(physical.length, 0, 'an empty configured media root is not persisted');
    let collection = await runtime.library.getItemRecord(firstId);
    assert.equal(collection.CollectionType, 'movies');
    assert.deepEqual(collection.PhysicalLocationsList, [firstPath, mediaPath]);
    assert.deepEqual(collection.PhysicalFolderIds, []);

    await adapter.write('/Movies/Feature.mkv', Buffer.from('fixture'));
    const secondPath = path.join(stateRoot, 'root', 'default', 'Oracle Movies Full');
    await mkdir(secondPath, { recursive: true });
    await writeFile(path.join(secondPath, 'movies.collection'), '');
    await writeFile(path.join(secondPath, 'root.mblink'), mediaPath);
    const secondId = nativeGuid(getNewItemId(secondPath, collectionFolderNativeType, identityOptions));

    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    userRoots = await rowsByType(database, 'MediaBrowser.Controller.Entities.UserRootFolder');
    assert.deepEqual(errors, []);
    collections = await rowsByType(database, collectionFolderNativeType);
    physical = await rowsByType(database, physicalFolderNativeType);
    assert.equal(userRoots.length, 1);
    assert.equal(collections.length, 2);
    assert.equal(physical.length, 1);
    assert.equal(physical[0].Id, physicalId);
    assert.equal(physical[0].TopParentId, physicalId);
    const aggregate = (await rowsByType(database, 'MediaBrowser.Controller.Entities.AggregateFolder'))[0];
    assert.equal(physical[0].ParentId, aggregate.Id);
    for (const id of [firstId, secondId]) {
      collection = await runtime.library.getItemRecord(id);
      assert.equal(collection.CollectionType, 'movies');
      assert.deepEqual(collection.PhysicalLocationsList, [id === firstId ? firstPath : secondPath, mediaPath]);
      assert.deepEqual(collection.PhysicalFolderIds.map(key), [key(physicalId)]);
    }
    const ancestors = await database.rows('AncestorIds');
    assert.ok(ancestors.some(row => key(row.ItemId) === key(physicalId) && key(row.ParentItemId) === key(aggregate.Id)));
    assert.ok(ancestors.some(row => key(row.ItemId) === key(physicalId) && key(row.ParentItemId) === key(firstId)));
    assert.ok(ancestors.some(row => key(row.ItemId) === key(firstId) && key(row.ParentItemId) === key(userRoots[0].Id)));
    assert.ok(ancestors.some(row => key(row.ItemId) === key(secondId) && key(row.ParentItemId) === key(userRoots[0].Id)));

    await rm(firstPath, { recursive: true, force: true });
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    assert.equal((await database.rows('BaseItems', { where: { Id: firstId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: secondId } })).length, 1);
    assert.equal((await database.rows('BaseItems', { where: { Id: physicalId } })).length, 0,
      'the native persistence deletion closure removes descendants of the stale collection');
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    assert.equal((await database.rows('BaseItems', { where: { Id: physicalId } })).length, 1,
      'the next aggregate pass reconstructs the still-configured shared physical root');
    collection = await runtime.library.getItemRecord(secondId);
    assert.deepEqual(collection.PhysicalFolderIds.map(key), [key(physicalId)]);

    await unlink(path.join(secondPath, 'root.mblink'));
    await runtime.libraryScanLifecycle.validateTopLibraryFolders();
    assert.equal((await database.rows('BaseItems', { where: { Id: physicalId } })).length, 0,
      'a physical root removed from top-level configuration is deleted');
    collection = await runtime.library.getItemRecord(secondId);
    assert.deepEqual(collection.PhysicalLocationsList, [secondPath]);
    assert.deepEqual(collection.PhysicalFolderIds, []);
    assert.deepEqual(errors, []);
  });
