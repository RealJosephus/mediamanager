import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createOwnedFolderValidationFixture, ownedStatePaths, ownedRefreshOptions, withoutSaveTime } from '../helpers/owned-folder-validation-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey } from '../../src/library/records.js';
import { createVideoFileResolver, movieNativeType } from '../../src/library/video-file-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Movies\\Film';
const rootId = 'A7100000-0000-0000-0000-000000000001';
const aggregateId = 'A7100000-0000-0000-0000-000000000002';
const userRootId = 'A7100000-0000-0000-0000-000000000003';
const collectionId = 'A7100000-0000-0000-0000-000000000004';
const manualParentId = 'A7100000-0000-0000-0000-000000000005';
const linkedAlternateId = 'A7100000-0000-0000-0000-000000000006';
const folderNativeType = 'MediaBrowser.Controller.Entities.Folder';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

const itemId = name => nativeGuid(getNewItemId(`${rootPath}\\${name}`, movieNativeType, {
  programDataPath,
  enableCaseSensitiveItemIds: false
}));

function row(Id, Type, values = {}) {
  return {
    ...blank,
    Id,
    Type,
    Name: values.Name ?? Type.split('.').at(-1),
    CleanName: values.CleanName ?? '',
    SortName: values.SortName ?? '',
    IsFolder: values.IsFolder ?? false,
    MediaType: values.MediaType ?? 'Unknown',
    Data: values.Data ?? (Type.includes('CollectionFolder') ? JSON.stringify({}) : null),
    ...values
  };
}

async function databaseFor(dialect) {
  const schema = `local_versions_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return { database: await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true }), schema };
}

async function fixture(t, dialect) {
  const { database, schema } = await databaseFor(dialect);
  const store = new DomainStore(database);
  const registry = new StorageRegistry();
  let library, validationFixture, lifecycleFixture, itemCreation, referenceOwner;
  t.after(async () => {
    referenceOwner?.release(); await validationFixture?.close();
    await itemCreation?.close();
    await lifecycleFixture?.close();
    await library?.close();
    await registry.close();
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await database.close();
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('movies', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/movies', instanceId: 'movies', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: rootPath, accessRoot: '/movies', style: 'windows', returnAccess: 'Local version scan fixture' });
  await database.insert('BaseItems', row(aggregateId, 'MediaBrowser.Controller.Entities.AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(userRootId, 'MediaBrowser.Controller.Entities.UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(rootId, folderNativeType, {
    Name: 'Film', Path: rootPath, ParentId: aggregateId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await database.insert('BaseItems', row(collectionId, 'MediaBrowser.Controller.Entities.CollectionFolder', {
    Name: 'Movies', ParentId: userRootId, IsFolder: true,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [rootId], PhysicalLocationsList: [rootPath] })
  }));
  library = new LibraryService({fileSystem: testFileSystem, ...await ownedStatePaths(t), store, serverId: 'local-version-scan', programDataPath, userRoot: row(userRootId, 'MediaBrowser.Controller.Entities.UserRootFolder', { IsFolder: true }) });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] });
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule });
  itemCreation = new ItemCreationService({ store, library, linkedChildren:lifecycleFixture.linkedChildren, loadContext: lifecycleFixture.loadContext });
  library.itemCreation = itemCreation;
  const linkedChildReferences = new LinkedChildReferenceService({ store, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates });
  library.itemDeletion = new ItemDeletionService({ store, library, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates, linkedChildReferences, vfs,
    externalData: { async deleteInternalItemFiles() {}, async deleteItemFiles() {} } });
  const resolverPipeline = new DirectoryItemResolverPipeline({
    programDataPath,
    resolvers: [createVideoFileResolver()]
  });
  validationFixture = createOwnedFolderValidationFixture({
    ignoreRule, lifecycleFixture, configuration: { LibraryScanFanoutConcurrency: 1 },
    store,
    library,
    vfs,
    identityMap,
    refreshes: new ProviderRefreshService(),
    programDataPath,
    resolverPipeline,
    resolvedItemLifecycle: lifecycleFixture.lifecycle,
    itemCreation, itemDeletion: library.itemDeletion,
    linkedChildReferences
  });
  const reference = await itemCreation.getItemById(rootId);
  referenceOwner = itemCreation.retainItem(reference);
  const { validation, errors } = validationFixture;
  return { database, adapter, vfs, validation, metadata: validationFixture.metadata,
    loadContext: lifecycleFixture.loadContext, errors, reference };
}

async function versionState(database) {
  const items = (await database.rows('BaseItems')).filter(value => value.Type === movieNativeType)
    .map(withoutSaveTime)
    .toSorted((left, right) => String(left.Path).localeCompare(String(right.Path)));
  const links = (await database.rows('LinkedChildren')).toSorted((left, right) =>
    `${left.ParentId}:${left.SortOrder}`.localeCompare(`${right.ParentId}:${right.SortOrder}`));
  return { items, links };
}

function assertFamily(state, primaryName, alternateNames) {
  const primary = state.items.find(item => item.Path === `${rootPath}\\${primaryName}`);
  assert.ok(primary, `missing primary ${primaryName}`);
  assert.equal(primary.OwnerId, null);
  assert.equal(primary.PrimaryVersionId, null);
  const data = JSON.parse(primary.Data);
  assert.deepEqual(data.LocalAlternateVersions, alternateNames.map(name => `${rootPath}\\${name}`));
  const localLinks = state.links.filter(link => Number(link.ChildType) === 2 && idKey(link.ParentId) === idKey(primary.Id));
  assert.deepEqual(localLinks.map(link => idKey(link.ChildId)), alternateNames.map(name => idKey(itemId(name))));
  for (const name of alternateNames) {
    const alternate = state.items.find(item => item.Path === `${rootPath}\\${name}`);
    assert.equal(idKey(alternate.OwnerId), idKey(primary.Id));
    assert.equal(idKey(alternate.PrimaryVersionId), idKey(primary.Id));
    assert.deepEqual(JSON.parse(alternate.Data).LocalAlternateVersions, []);
  }
  return primary;
}

const dbFailure = (error, dialect) => dialect === 'postgres' ? error.code === '23503' : error.errcode === 787;

for (const dialect of ['postgres']) test(`${dialect}: local movie versions persist, regroup and retain the native failed replacement prefix`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));

  const created = await validation.validateChildren(reference, ownedRefreshOptions);
  assert.equal(created.created.length, 1, 'native CreateItems publishes only the resolved primary, not synthesized alternates');
  let state = await versionState(database);
  const resolutionPrimary = assertFamily(state, 'Film - 2160p.mkv', ['Film - 1080p.mkv']);
  const stable = structuredClone(state);
  assert.equal((await validation.validateChildren(reference, ownedRefreshOptions)).created.length, 0);
  assert.deepEqual(await versionState(database), stable);

  await adapter.write('/Other.mkv', Buffer.from('other'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  state = await versionState(database);
  assert.equal(state.items.length, 3);
  assert.ok(state.items.every(item => item.OwnerId == null && item.PrimaryVersionId == null));
  assert.equal(state.links.some(link => Number(link.ChildType) === 2), false);
  assert.deepEqual(JSON.parse(state.items.find(item => item.Id === resolutionPrimary.Id).Data).LocalAlternateVersions, []);

  await adapter.delete('/Other.mkv');
  await validation.validateChildren(reference, ownedRefreshOptions);
  state = await versionState(database);
  assertFamily(state, 'Film - 2160p.mkv', ['Film - 1080p.mkv']);

  await database.insert('BaseItems', row(manualParentId, 'MediaBrowser.Controller.Playlists.Playlist', { IsFolder: true }));
  await database.insert('BaseItems', row(linkedAlternateId, movieNativeType, {
    Name: 'Remote linked alternate', Path: 'https://example.invalid/remote.mkv', MediaType: 'Video',
    Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile', LocalAlternateVersions: [] })
  }));
  await database.insert('LinkedChildren', { ParentId: manualParentId, SortOrder: 0, ChildId: resolutionPrimary.Id, ChildType: 0 });
  await database.insert('LinkedChildren', { ParentId: resolutionPrimary.Id, SortOrder: 4, ChildId: linkedAlternateId, ChildType: 3 });
  validation.itemCreation.unregisterItem(resolutionPrimary.Id);

  await adapter.write('/Film.mkv', Buffer.from('exact'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  state = await versionState(database);
  const exactPrimary = assertFamily(state, 'Film.mkv', ['Film - 2160p.mkv', 'Film - 1080p.mkv']);
  assert.ok(state.links.some(link => idKey(link.ParentId) === idKey(manualParentId)
    && idKey(link.ChildId) === idKey(exactPrimary.Id) && Number(link.ChildType) === 0));
  const linkedAlternate = state.items.find(item => idKey(item.Id) === idKey(linkedAlternateId));
  assert.equal(idKey(linkedAlternate.PrimaryVersionId), idKey(exactPrimary.Id));
  assert.equal(state.links.some(link => idKey(link.ParentId) === idKey(exactPrimary.Id)
    && idKey(link.ChildId) === idKey(linkedAlternateId) && Number(link.ChildType) === 3), false,
  'native transfers the row but clears the old primary arrays without recreating ChildType=3');

  await adapter.delete('/Film.mkv');
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), error => dbFailure(error, dialect));
  state = await versionState(database);
  const promoted = assertFamily(state, 'Film - 2160p.mkv', ['Film - 1080p.mkv']);
  assert.ok(state.items.some(item => item.Path === `${rootPath}\\Film.mkv`),
    'the source deletion fails after the replacement prefix commits');
  assert.ok(state.links.some(link => idKey(link.ParentId) === idKey(manualParentId)
    && idKey(link.ChildId) === idKey(promoted.Id) && Number(link.ChildType) === 0));
  assert.equal(idKey(state.items.find(item => idKey(item.Id) === idKey(linkedAlternateId)).PrimaryVersionId), idKey(exactPrimary.Id));
});

for (const dialect of ['postgres']) test(`${dialect}: a missing alternate remains when its initial repository save hits a manual reference`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  let state = await versionState(database);
  const primary = assertFamily(state, 'Film - 2160p.mkv', ['Film - 1080p.mkv']);
  await database.insert('BaseItems', row(manualParentId, 'MediaBrowser.Controller.Playlists.Playlist', { IsFolder: true }));
  await database.insert('LinkedChildren', { ParentId: manualParentId, SortOrder: 1,
    ChildId: itemId('Film - 1080p.mkv'), ChildType: 0 });
  await database.insert('LinkedChildren', { ParentId: manualParentId, SortOrder: 2,
    ChildId: primary.Id, ChildType: 0 });
  const before = await versionState(database);
  await adapter.delete('/Film - 1080p.mkv');
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), { code: '23503' });
  assert.deepEqual(await versionState(database), before,
    'UpdateFromResolvedItem saves the primary before ordinary deletion could reroute its alternate');
  await database.delete('LinkedChildren', { ParentId: manualParentId, SortOrder: 1 });
  await validation.validateChildren(reference, ownedRefreshOptions);
  state = await versionState(database);
  const promoted = assertFamily(state, 'Film - 2160p.mkv', []);
  assert.equal(state.items.some(item => item.Path === `${rootPath}\\Film - 1080p.mkv`), false);
  assert.equal(state.links.some(link => idKey(link.ChildId) === idKey(itemId('Film - 1080p.mkv'))), false);
  assert.equal(state.links.filter(link => idKey(link.ParentId) === idKey(manualParentId)
    && idKey(link.ChildId) === idKey(promoted.Id) && Number(link.ChildType) === 0).length, 1,
  'removing the blocking reference leaves the existing primary reference untouched');
});

for (const dialect of ['postgres']) test(`${dialect}: a post-promotion link failure retains only the committed target prerequisite`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, metadata, loadContext, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const sourceId = itemId('Film - 2160p.mkv');
  await database.insert('BaseItems', row(manualParentId, 'MediaBrowser.Controller.Playlists.Playlist', { IsFolder: true }));
  await database.insert('LinkedChildren', { ParentId: manualParentId, SortOrder: 0, ChildId: sourceId, ChildType: 0 });
  const before = await versionState(database);
  await adapter.delete('/Film - 2160p.mkv');
  await adapter.write('/Film.mkv', Buffer.from('exact'));
  await database.client.query(`CREATE FUNCTION fail_manual_reroute() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD."ChildType"=0 THEN RAISE EXCEPTION 'controlled local-version link failure'; END IF; RETURN NEW; END $$`);
  await database.client.query('CREATE TRIGGER fail_manual_reroute BEFORE UPDATE ON "LinkedChildren" FOR EACH ROW EXECUTE FUNCTION fail_manual_reroute()');
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), /controlled local-version link failure/u);
  await database.client.query('DROP TRIGGER fail_manual_reroute ON "LinkedChildren"');
  await database.client.query('DROP FUNCTION fail_manual_reroute()');
  const failed = await versionState(database), target = failed.items.find(item => idKey(item.Id) === idKey(itemId('Film.mkv')));
  assert.ok(target, 'the new primary prerequisite committed before the later relation failure');
  assert.equal(target.OwnerId, null);
  assert.equal(target.PrimaryVersionId, null);
  assert.ok(failed.items.some(item => idKey(item.Id) === idKey(sourceId)), 'the failed replacement did not delete its source');
  assert.ok(failed.links.some(link => idKey(link.ParentId) === idKey(manualParentId)
    && idKey(link.ChildId) === idKey(sourceId) && Number(link.ChildType) === 0),
  'the failing bulk reroute did not partially rewrite the manual reference');
  for (const link of before.links.filter(value => idKey(value.ParentId) === idKey(sourceId))) {
    assert.ok(failed.links.some(value => idKey(value.ParentId) === idKey(link.ParentId)
      && idKey(value.ChildId) === idKey(link.ChildId) && Number(value.ChildType) === Number(link.ChildType)),
    'the old family remains intact until its per-action transfer starts');
  }
  await validation.validateChildren(reference, ownedRefreshOptions);
  assert.deepEqual(errors, [], 'retry repairs an existing unowned alternate through its metadata lifecycle');
  const primary = assertFamily(await versionState(database), 'Film.mkv', ['Film - 1080p.mkv']);
  const child = await loadContext(itemId('Film - 1080p.mkv'));
  try {
    // A later writer changes persisted ownership after a live child was
    // loaded. Carrying that child must not overwrite the foreign owner.
    await database.update('BaseItems', { Id: child.item.Id }, { OwnerId: manualParentId });
    const beforeConflict = await versionState(database);
    await assert.rejects(metadata.refreshOwnedItem(primary.Id, child.item, ownedRefreshOptions,
      { copyTitleMetadata: false, videoContext: child }), { code: 'metadata-conflict' });
    assert.deepEqual(await versionState(database), beforeConflict);
  } finally { await child.dispose(); }
});

for (const dialect of ['postgres']) test(`${dialect}: a weak snapshot cannot add, promote or drop a local version`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, vfs, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const before = await versionState(database);
  const list = vfs.list.bind(vfs);
  vfs.list = async (path, options) => ({ ...await list(path, options), consistency: 'weak', snapshot: null, deletionSafe: false });
  await adapter.write('/Film.mkv', Buffer.from('exact'));
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), { code: 'not-supported' });
  assert.deepEqual(await versionState(database), before);
  await adapter.delete('/Film.mkv');
  await adapter.delete('/Film - 2160p.mkv');
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), { code: 'not-supported' });
  assert.deepEqual(await versionState(database), before);
  vfs.list = list;
  await validation.validateChildren(reference, ownedRefreshOptions);
  assertFamily(await versionState(database), 'Film - 1080p.mkv', []);
});
