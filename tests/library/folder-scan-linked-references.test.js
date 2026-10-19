import { testFileSystem } from '../storage/plugin-files.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import { createOwnedFolderValidationFixture, ownedStatePaths, ownedRefreshOptions } from '../helpers/owned-folder-validation-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, mapRecord, nonemptyId } from '../../src/library/records.js';
import { createVideoFileResolver, movieNativeType } from '../../src/library/video-file-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Movies\\Film';
const rootId = 'B7200000-0000-0000-0000-000000000001';
const aggregateId = 'B7200000-0000-0000-0000-000000000002';
const userRootId = 'B7200000-0000-0000-0000-000000000003';
const collectionId = 'B7200000-0000-0000-0000-000000000004';
const linkedAlternateId = 'B7200000-0000-0000-0000-000000000005';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

const inTransaction = database => database.inTransaction;
const itemId = (name, nativeType = movieNativeType, parent = rootPath) => nativeGuid(getNewItemId(`${parent}\\${name}`, nativeType, {
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

async function fixture(t, dialect) {
  const schema = `folder_scan_linked_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const linkedChildren=new PostgresLinkedChildrenStore({database});await linkedChildren.initialize();
  const store = new DomainStore(database), registry = new StorageRegistry();
  let validationFixture, itemCreation, lifecycleFixture, library, referenceOwner;
  t.after(async () => {
    referenceOwner?.release(); await validationFixture?.close();
    await itemCreation?.close();
    await lifecycleFixture?.close();
    await library?.close();await linkedChildren.flushReleases();await linkedChildren.close();
    await registry.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('movies', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/movies', instanceId: 'movies', capabilities: {
    create: true, replace: true, mkdir: true, delete: true
  } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: rootPath, accessRoot: '/movies', style: 'windows', returnAccess: 'Linked scan fixture' });
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
  library = new LibraryService({fileSystem: testFileSystem, ...await ownedStatePaths(t), store, linkedChildren, serverId: 'linked-folder-scan', programDataPath });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] });
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, linkedChildren, vfs, identityMap, ignoreRule });
  itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext: lifecycleFixture.loadContext });
  library.itemCreation = itemCreation;
  const linkedChildReferences = new LinkedChildReferenceService({ store, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates });
  const trace = [], control = { active: false, cancelOnLinkedSaver: false, controller: null, failLinkedImage: null };
  const record = value => { if (control.active) trace.push(value); };
  const outside = phase => assert.equal(inTransaction(database), false, `${phase} must run outside a database transaction`);
  const updates = lifecycleFixture.updates;
  const update = updates.update.bind(updates);
  updates.update = async (loaded, result, reason, options) => {
    outside('repository update');
    record({ phase: 'save:start', id: idKey(result.Item.Id) });
    const value = await update(loaded, result, reason, options);
    record({ phase: 'save:end', id: idKey(result.Item.Id) });
    return value;
  };
  const runMetadataSavers = updates.runMetadataSavers.bind(updates);
  updates.runMetadataSavers = async (loaded, reason, options) => {
    outside('linked saver');
    record({ phase: 'saver:start', id: idKey(loaded.item.Id) });
    const value = await runMetadataSavers(loaded, reason, options);
    record({ phase: 'saver:end', id: idKey(loaded.item.Id) });
    if (control.cancelOnLinkedSaver && loaded.item.Type === 'Playlist') control.controller.abort();
    return value;
  };
  const updateImages = lifecycleFixture.images.updateImages.bind(lifecycleFixture.images);
  lifecycleFixture.images.updateImages = async (loaded, images, options) => {
    outside('image update');
    record({ phase: 'image:start', id: idKey(loaded.item.Id) });
    if (control.failLinkedImage && loaded.item.Type === 'Playlist') throw control.failLinkedImage;
    const value = await updateImages(loaded, images, options);
    record({ phase: 'image:end', id: idKey(loaded.item.Id) });
    return value;
  };
  const reroute = linkedChildReferences.reroute.bind(linkedChildReferences);
  linkedChildReferences.reroute = async (fromId, toId) => {
    outside('linked reroute');
    const target = await itemCreation.getItemById(toId);
    record({ phase: 'reroute', from: idKey(fromId), to: idKey(toId),
      targetOwner: target?.OwnerId, targetPrimary: target?.PrimaryVersionId });
    return reroute(fromId, toId);
  };
  const externalData = {
    async deleteInternalItemFiles(item) { outside('internal cleanup'); record({ phase: 'cleanup:internal', id: idKey(item.Id) }); },
    async deleteItemFiles(item) { outside('external cleanup'); record({ phase: 'cleanup:external', id: idKey(item.Id) }); }
  };
  const itemDeletion = new ItemDeletionService({ store, library, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates, linkedChildReferences, vfs, externalData });
  library.itemDeletion = itemDeletion;
  const deleteItem = itemDeletion.deleteItem.bind(itemDeletion);
  itemDeletion.deleteItem = async (item, ...args) => {
    outside('ordinary delete'); record({ phase: 'delete:start', id: idKey(item.Id) });
    const value = await deleteItem(item, ...args);
    record({ phase: 'delete:end', id: idKey(item.Id) });
    return value;
  };
  const createItems = itemCreation.createItems.bind(itemCreation);
  itemCreation.createItems = async (items, ...args) => {
    outside('CreateItems'); record({ phase: 'create:start', ids: items.map(item => idKey(item.Id)) });
    const value = await createItems(items, ...args);
    record({ phase: 'create:end', ids: items.map(item => idKey(item.Id)) });
    return value;
  };
  for (const [event, phase] of [['ItemAdded', 'event:added'], ['ItemUpdated', 'event:updated'], ['ItemRemoved', 'event:removed']]) {
    library.on(event, value => record({ phase, id: idKey(value.Item.Id) }));
  }
  const resolverPipeline = new DirectoryItemResolverPipeline({ programDataPath, resolvers: [createVideoFileResolver()] });
  validationFixture = createOwnedFolderValidationFixture({
    ignoreRule, lifecycleFixture, configuration: { LibraryScanFanoutConcurrency: 1 },
    store, library, vfs, identityMap, refreshes: new ProviderRefreshService(), programDataPath,
    resolverPipeline, resolvedItemLifecycle: lifecycleFixture.lifecycle, itemCreation, itemDeletion: library.itemDeletion, linkedChildReferences
  });
  const reference = await itemCreation.getItemById(rootId);
  referenceOwner = itemCreation.retainItem(reference);
  const { validation, errors } = validationFixture;
  return {
    database, store, adapter, vfs, validation, errors, reference, library, itemCreation, linkedChildReferences, trace, control,
    startTrace() { trace.length = 0; control.active = true; },
    stopTrace() { control.active = false; }
  };
}

async function insertManualReference(value, childId, sortOrder = 0,
  Type = 'MediaBrowser.Controller.Playlists.Playlist') {
  const parentId = randomUUID();
  await value.database.insert('BaseItems', row(parentId, Type, {
    Name: 'Manual parent', IsFolder: true, Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await value.database.insert('LinkedChildren', { ParentId: parentId, SortOrder: sortOrder, ChildId: childId, ChildType: 0 });
  return parentId;
}

async function movieAt(value, path) {
  const [stored] = await value.database.rows('BaseItems', { where: { Path: path } });
  return stored && mapRecord(stored);
}

const position = (trace, predicate) => trace.findIndex(predicate);

function linkedTest(name, run) {
  for (const dialect of ['postgres']) test(`${dialect}: ${name}`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, t => run(t, dialect));
}

linkedTest('two-version removal deletes first, promotes, reroutes, transfers and creates with warm cache parity', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const target = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  await insertManualReference(value, source.Id);
  await value.database.insert('BaseItems', row(linkedAlternateId, movieNativeType, {
    Name: 'Linked alternate', Path: `${rootPath}\\Linked.remote`,
    PrimaryVersionId: source.Id, MediaType: 'Video', Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile', LocalAlternateVersions: [] })
  }));
  await value.adapter.write('/Linked.remote', Buffer.from('linked'));
  await value.database.insert('LinkedChildren', { ParentId: source.Id, SortOrder: 9,
    ChildId: linkedAlternateId, ChildType: 3 });
  value.itemCreation.unregisterItem(source.Id);
  await value.itemCreation.getItemById(source.Id);
  await value.itemCreation.getItemById(target.Id);
  await value.adapter.delete('/Film - 2160p.mkv');
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  const deleteAt = position(value.trace, entry => entry.phase === 'delete:start' && entry.id === idKey(source.Id));
  const promoteAt = position(value.trace, entry => entry.phase === 'save:start' && entry.id === idKey(target.Id));
  const rerouteAt = position(value.trace, entry => entry.phase === 'reroute' && entry.from === idKey(source.Id));
  const transferAt = position(value.trace, entry => entry.phase === 'save:start' && entry.id === idKey(linkedAlternateId));
  const cleanupAt = position(value.trace, entry => entry.phase === 'cleanup:external' && entry.id === idKey(source.Id));
  const createAt = position(value.trace, entry => entry.phase === 'create:start' && entry.ids.includes(idKey(target.Id)));
  assert.ok(deleteAt >= 0 && deleteAt < promoteAt && promoteAt < rerouteAt && rerouteAt < transferAt
    && transferAt < cleanupAt && cleanupAt < createAt,
  `two-version order is DeleteItem -> promote -> reroute -> linked transfer -> source cleanup -> CreateItems: ${JSON.stringify(value.trace)}`);
  const rerouteFrame = value.trace[rerouteAt];
  assert.ok(!nonemptyId(rerouteFrame.targetOwner));
  assert.ok(!nonemptyId(rerouteFrame.targetPrimary));
  assert.equal(await value.itemCreation.getItemById(source.Id), null, 'the warmed deleted source is evicted');
  const liveTarget = await value.itemCreation.getItemById(target.Id);
  const targetLinks = await value.database.rows('LinkedChildren', { where: { ParentId: target.Id } });
  const liveLinked = await value.itemCreation.getItemById(linkedAlternateId);
  assert.equal(idKey(liveLinked.PrimaryVersionId), idKey(target.Id),
    'the surviving linked alternate row was transferred to the new primary');
  assert.equal(targetLinks.some(link => Number(link.ChildType) === 3 && idKey(link.ChildId) === idKey(linkedAlternateId)), false);
  assert.deepEqual(liveTarget.LinkedAlternateVersions, [],
    'native clears the old primary arrays and does not recreate its ChildType=3 link');
});

linkedTest('manual rows owned by a generic Folder reroute even without a Folder-specific saver', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const target = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  const manualParent = await insertManualReference(value, source.Id, 0, folderNativeType);
  await value.adapter.delete('/Film - 2160p.mkv');
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const [link] = await value.database.rows('LinkedChildren', { where: { ParentId: manualParent, ChildType: 0 } });
  assert.equal(idKey(link.ChildId), idKey(target.Id));
});

linkedTest('linked demotion creates its target before transfer, old-source save and reroute', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const alternate = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  await insertManualReference(value, source.Id);
  await value.itemCreation.getItemById(source.Id);
  await value.adapter.write('/Film.mkv', Buffer.from('exact'));
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  const targetId = itemId('Film.mkv');
  const createAt = position(value.trace, entry => entry.phase === 'create:end' && entry.ids.includes(idKey(targetId)));
  const transferAt = position(value.trace, entry => entry.phase === 'save:start' && entry.id === idKey(alternate.Id));
  const sourceSaveAt = position(value.trace, entry => entry.phase === 'save:start' && entry.id === idKey(source.Id));
  const rerouteAt = position(value.trace, entry => entry.phase === 'reroute' && entry.from === idKey(source.Id));
  assert.ok(createAt >= 0 && createAt < transferAt && transferAt < sourceSaveAt && sourceSaveAt < rerouteAt,
    `demotion order is target create/promote -> transfer -> old-source save -> reroute: ${JSON.stringify(value.trace)}`);
  const storedSource = await movieAt(value, source.Path);
  assert.equal(idKey(storedSource.PrimaryVersionId), idKey(targetId));
  assert.equal(idKey(storedSource.OwnerId), idKey(targetId));
});

linkedTest('linked parent image failure keeps the committed reroute prefix and does not retry or delete the source', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const target = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  const manualParent = await insertManualReference(value, source.Id);
  const failure = new Error('controlled linked image failure');
  value.control.failLinkedImage = failure;
  await value.adapter.delete('/Film - 2160p.mkv');
  value.startTrace();
  await assert.rejects(value.validation.validateChildren(value.reference, ownedRefreshOptions), error => error === failure);
  value.stopTrace();
  assert.equal(value.trace.filter(entry => entry.phase === 'reroute' && entry.from === idKey(source.Id)).length, 1,
    'the failed linked action is not replayed');
  assert.equal(value.trace.some(entry => entry.phase === 'cleanup:internal' && entry.id === idKey(source.Id)), false);
  assert.ok(await value.itemCreation.getItemById(source.Id));
  const promoted = await value.itemCreation.getItemById(target.Id);
  assert.ok(!nonemptyId(promoted.OwnerId) && !nonemptyId(promoted.PrimaryVersionId));
  const [link] = await value.database.rows('LinkedChildren', { where: { ParentId: manualParent, ChildType: 0 } });
  assert.equal(idKey(link.ChildId), idKey(target.Id), 'the DB reroute commits before the failing parent image update');
});

linkedTest('one scope batches every prerequisite before serial linked actions and accepts a scheduled same-path stale owner', async (t, dialect) => {
  const value = await fixture(t, dialect);
  for (const title of ['Film', 'Other']) {
    await value.vfs.mkdir(`/movies/${title}`);
    for (const name of [`${title} - 1080p.mkv`, `${title} - 2160p.mkv`]) {
      await value.adapter.write(`/${title}/${name}`, Buffer.from(name));
    }
  }
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const filmParent = `${rootPath}\\Film`, otherParent = `${rootPath}\\Other`;
  const filmSource = await movieAt(value, `${filmParent}\\Film - 2160p.mkv`);
  const otherSource = await movieAt(value, `${otherParent}\\Other - 2160p.mkv`);
  await insertManualReference(value, filmSource.Id);
  await insertManualReference(value, otherSource.Id);
  await value.adapter.write('/Film/Film.mkv', Buffer.from('film'));
  await value.adapter.write('/Other/Other.mkv', Buffer.from('other'));
  const filmTargetId = itemId('Film.mkv', movieNativeType, filmParent);
  const otherTargetId = itemId('Other.mkv', movieNativeType, otherParent);
  const staleId = itemId('Film.mkv', folderNativeType, filmParent);
  await value.database.insert('BaseItems', row(staleId, folderNativeType, {
    Name: 'Stale folder', Path: `${filmParent}\\Film.mkv`, ParentId: rootId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  const create = value.trace.find(entry => entry.phase === 'create:end');
  assert.deepEqual(new Set(create.ids), new Set([idKey(filmTargetId), idKey(otherTargetId)]));
  const reroutes = value.trace.map((entry, index) => ({ entry, index })).filter(value => value.entry.phase === 'reroute');
  const sourceSaves = value.trace.map((entry, index) => ({ entry, index })).filter(value => value.entry.phase === 'save:start'
    && [idKey(filmSource.Id), idKey(otherSource.Id)].includes(value.entry.id));
  assert.equal(reroutes.length, 2, JSON.stringify(value.trace));
  assert.ok(position(value.trace, entry => entry === create) < reroutes[0].index,
    'the complete prerequisite batch commits before the first action');
  assert.ok(sourceSaves[0].index < reroutes[0].index && reroutes[0].index < sourceSaves[1].index
    && sourceSaves[1].index < reroutes[1].index,
    'linked actions execute to completion serially');
  assert.equal((await value.database.rows('BaseItems', { where: { Id: staleId } })).length, 0);
  assert.ok(await movieAt(value, `${filmParent}\\Film.mkv`), 'the scheduled stale owner does not reject its replacement path');
});

linkedTest('parent scope publishes before a child linked action', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.vfs.mkdir('/movies/Sub');
  await value.vfs.mkdir('/movies/Sub/Film');
  for (const name of ['Film - 1080p.mkv', 'Film - 2160p.mkv', 'Other.mkv']) {
    await value.adapter.write(name === 'Other.mkv' ? '/Sub/' + name : '/Sub/Film/' + name, Buffer.from(name));
  }
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const filmPath = `${rootPath}\\Sub\\Film`;
  const source = await movieAt(value, `${filmPath}\\Film - 2160p.mkv`);
  assert.ok(source, 'the parent directory remains a traversed Folder scope');
  await insertManualReference(value, source.Id);
  await value.adapter.write('/Sub/Film/Film.mkv', Buffer.from('exact'));
  await value.vfs.mkdir('/movies/New');
  const newFolderId = itemId('New', folderNativeType);
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  const parentPublish = position(value.trace, entry => entry.phase === 'event:added' && entry.id === idKey(newFolderId));
  const childAction = position(value.trace, entry => entry.phase === 'reroute' && entry.from === idKey(source.Id));
  assert.ok(parentPublish >= 0 && parentPublish < childAction,
    `the parent scope commits and publishes before child linked work starts: ${JSON.stringify(value.trace)}`);
});

linkedTest('a child linked failure preserves the already published parent directory', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.vfs.mkdir('/movies/Sub');
  await value.vfs.mkdir('/movies/Sub/Film');
  await value.adapter.write('/Sub/Film/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Sub/Film/Film - 2160p.mkv', Buffer.from('2160'));
  await value.adapter.write('/Sub/Other.mkv', Buffer.from('other'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Sub\\Film\\Film - 2160p.mkv`);
  await insertManualReference(value, source.Id);
  await value.adapter.write('/Sub/Film/Film.mkv', Buffer.from('exact'));
  await value.vfs.mkdir('/movies/New');
  const newFolderId = itemId('New', folderNativeType);
  const failure = new Error('controlled child reroute failure');
  value.linkedChildReferences.reroute = async () => { throw failure; };
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  assert.ok(value.errors.includes(failure), 'recursive child errors are reported after the parent has committed');
  assert.equal((await value.database.rows('BaseItems', { where: { Id: newFolderId } })).length, 1);
  assert.ok(await value.itemCreation.getItemById(source.Id));
});

linkedTest('a missing alternate save fails before the linked saver can cancel deletion', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Film - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Film - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const primary = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const alternate = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  const manualParent = await insertManualReference(value, alternate.Id);
  await value.itemCreation.getItemById(alternate.Id);
  await value.adapter.delete('/Film - 1080p.mkv');
  const controller = new AbortController();
  value.control.cancelOnLinkedSaver = true;
  value.control.controller = controller;
  const before = await value.database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId', direction: 'ASC' }, { column: 'SortOrder', direction: 'ASC' }] });
  value.startTrace();
  await assert.rejects(value.validation.validateChildren(value.reference, { ...ownedRefreshOptions, signal: controller.signal }),
    { code: '23503' });
  value.stopTrace();
  assert.equal(controller.signal.aborted, false, 'the linked saver was never reached');
  assert.ok(value.trace.some(entry => entry.phase === 'save:start' && entry.id === idKey(primary.Id)));
  assert.equal(value.trace.some(entry => entry.phase === 'reroute' || entry.phase === 'delete:start'), false);
  assert.equal((await value.database.rows('BaseItems', { where: { Id: alternate.Id } })).length, 1);
  assert.deepEqual(await value.database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId', direction: 'ASC' }, { column: 'SortOrder', direction: 'ASC' }] }), before);
  assert.equal((await value.database.rows('LinkedChildren', { where: { ParentId: manualParent } }))[0].ChildId, alternate.Id);
});

linkedTest('three-version replacement with a manual reference preserves the frozen failure after its committed prefix', async (t, dialect) => {
  const value = await fixture(t, dialect);
  for (const name of ['Film - 720p.mkv', 'Film - 1080p.mkv', 'Film - 2160p.mkv']) {
    await value.adapter.write('/' + name, Buffer.from(name));
  }
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const target = await movieAt(value, `${rootPath}\\Film - 1080p.mkv`);
  await insertManualReference(value, source.Id);
  await value.adapter.delete('/Film - 2160p.mkv');
  value.startTrace();
  let failure;
  try { await value.validation.validateChildren(value.reference, ownedRefreshOptions); } catch (error) { failure = error; }
  value.stopTrace();
  assert.ok(failure, 'the frozen three-version boundary still fails');
  assert.equal(failure.code, '23503',
    `${failure?.name}/${failure?.code}/${failure?.message} ${JSON.stringify(value.trace)}`);
  const promoteAt = position(value.trace, entry => entry.phase === 'create:end' && entry.ids.includes(idKey(target.Id)));
  const rerouteAt = position(value.trace, entry => entry.phase === 'reroute' && entry.from === idKey(source.Id));
  const remaining = await movieAt(value, `${rootPath}\\Film - 720p.mkv`);
  const transferAt = position(value.trace, entry => entry.phase === 'save:end' && entry.id === idKey(remaining.Id));
  const targetSaveAt = position(value.trace, entry => entry.phase === 'save:start' && entry.id === idKey(target.Id));
  assert.ok(promoteAt >= 0 && promoteAt < rerouteAt && rerouteAt < transferAt && transferAt < targetSaveAt,
    `the real FK follows create/promote -> reroute -> remaining save -> target save: ${JSON.stringify(value.trace)}`);
  assert.equal(value.trace.some(entry => entry.phase.startsWith('cleanup:') && entry.id === idKey(source.Id)), false,
    'the target save fails before source cleanup');
  assert.ok(await value.itemCreation.getItemById(source.Id),
    `the old primary remains after the committed prefix: ${failure?.name}/${failure?.code}/${failure?.message} ${JSON.stringify(value.trace)}`);
  const promoted = await value.itemCreation.getItemById(target.Id);
  assert.ok(!nonemptyId(promoted.OwnerId) && !nonemptyId(promoted.PrimaryVersionId));
});

linkedTest('slash-variant alternate strings do not classify an old primary as a replacement', async (t, dialect) => {
  const value = await fixture(t, dialect);
  for (const name of ['Film - 720p.mkv', 'Film - 1080p.mkv', 'Film - 2160p.mkv']) {
    await value.adapter.write('/' + name, Buffer.from(name));
  }
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const source = await movieAt(value, `${rootPath}\\Film - 2160p.mkv`);
  const [stored] = await value.database.rows('BaseItems', { where: { Id: source.Id } });
  const data = JSON.parse(stored.Data);
  data.LocalAlternateVersions = [`${rootPath.replaceAll('\\', '/')}\\Film - 720p.mkv`];
  await value.database.update('BaseItems', { Id: source.Id }, { Data: JSON.stringify(data) });
  value.itemCreation.unregisterItem(source.Id);
  await insertManualReference(value, source.Id);
  await value.adapter.delete('/Film - 2160p.mkv');
  value.startTrace();
  let failure;
  try { await value.validation.validateChildren(value.reference, ownedRefreshOptions); } catch (error) { failure = error; }
  value.stopTrace();
  const deleteAt = position(value.trace, entry => entry.phase === 'delete:start' && entry.id === idKey(source.Id));
  const createAt = position(value.trace, entry => entry.phase === 'create:start');
  assert.ok(deleteAt >= 0, `the old primary follows ordinary DeleteItem: ${JSON.stringify(value.trace)}`);
  assert.ok(createAt < 0 || deleteAt < createAt,
    `OrdinalIgnoreCase does not normalize slash variants into deferred replacement: ${JSON.stringify(value.trace)}`);
  assert.equal(failure, undefined);
  assert.equal((await value.database.rows('BaseItems', { where: { Id: source.Id } })).length, 0);
  assert.equal((await value.database.rows('LinkedChildren')).some(link => idKey(link.ChildId) === idKey(source.Id)), false,
    'ordinary deletion removes the old primary and its incoming manual reference');
});

for (const type of ['movie', 'folder']) linkedTest(`a missing ${type} removes its manual reference through ordinary deletion`, async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.adapter.write('/Other.mkv', Buffer.from('other'));
  if (type === 'folder') await value.vfs.mkdir('/movies/Loose');
  else await value.adapter.write('/Film.mkv', Buffer.from('film'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const suffix = type === 'folder' ? 'Loose' : 'Film.mkv';
  const source = await movieAt(value, `${rootPath}\\${suffix}`);
  const manualParent = await insertManualReference(value, source.Id);
  await value.itemCreation.getItemById(source.Id);
  await value.adapter.delete('/' + suffix, { recursive: type === 'folder' });
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  assert.equal(await value.itemCreation.getItemById(source.Id), null);
  assert.equal((await value.database.rows('BaseItems', { where: { Id: source.Id } })).length, 0);
  assert.deepEqual(await value.database.rows('LinkedChildren', { where: { ParentId: manualParent } }), []);
  assert.equal((await value.vfs.stat('/movies/Other.mkv')).kind, 'file');
});

linkedTest('same-path stale Folder deletion precedes creation and clears its old manual reference', async (t, dialect) => {
  const value = await fixture(t, dialect);
  const targetPath = `${rootPath}\\Film.mkv`;
  const staleId = itemId('Film.mkv', folderNativeType);
  await value.database.insert('BaseItems', row(staleId, folderNativeType, {
    Name: 'Stale folder', Path: targetPath, ParentId: rootId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await value.adapter.write('/Film.mkv', Buffer.from('film'));
  const manualParent = await insertManualReference(value, staleId);
  await value.itemCreation.getItemById(staleId);
  value.startTrace();
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  value.stopTrace();
  assert.equal(await value.itemCreation.getItemById(staleId), null);
  const replacement = await movieAt(value, targetPath);
  assert.equal(replacement.Type, 'Movie');
  assert.equal(idKey(replacement.Id), idKey(itemId('Film.mkv')));
  assert.deepEqual(await value.database.rows('LinkedChildren', { where: { ParentId: manualParent } }), []);
  const deleted = position(value.trace, entry => entry.phase === 'delete:end' && entry.id === idKey(staleId));
  const created = position(value.trace, entry => entry.phase === 'create:start' && entry.ids.includes(idKey(replacement.Id)));
  assert.ok(deleted >= 0 && deleted < created);
  assert.equal((await value.vfs.stat('/movies/Film.mkv')).kind, 'file');
});

linkedTest('a weak collapsed version snapshot is not promoted into an eager linked action', async (t, dialect) => {
  const value = await fixture(t, dialect);
  await value.vfs.mkdir('/movies/Nested');
  await value.adapter.write('/Nested/Nested - 1080p.mkv', Buffer.from('1080'));
  await value.adapter.write('/Nested/Nested - 2160p.mkv', Buffer.from('2160'));
  await value.validation.validateChildren(value.reference, ownedRefreshOptions);
  const sourcePath = `${rootPath}\\Nested\\Nested - 2160p.mkv`;
  const source = await movieAt(value, sourcePath);
  assert.ok(source);
  const manualParent = await insertManualReference(value, source.Id);
  await value.adapter.delete('/Nested/Nested - 2160p.mkv');
  const list = value.vfs.list.bind(value.vfs);
  value.vfs.list = async (path, options) => {
    const listing = await list(path, options);
    return path === '/movies/Nested'
      ? { ...listing, consistency: 'weak', snapshot: null, deletionSafe: false }
      : listing;
  };
  value.startTrace();
  await assert.rejects(value.validation.validateChildren(value.reference, ownedRefreshOptions),
    error => error?.code === 'not-supported');
  value.stopTrace();
  assert.ok(await movieAt(value, sourcePath), 'the missing version survives the weak nested absence');
  const [link] = await value.database.rows('LinkedChildren', { where: { ParentId: manualParent, ChildType: 0 } });
  assert.equal(idKey(link.ChildId), idKey(source.Id), 'its manual link remains attached while deletion is withheld');
  assert.equal(value.trace.some(entry => entry.phase === 'delete:start'), false);
});
