import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { idKey } from '../../src/library/records.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { readTestLinkIds, assignTestLinks, captureTestEvent } from './collection-test-consumers.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString,
  postgresTestRow } from '../database/postgres-fixture.js';

const boxSetType = 'MediaBrowser.Controller.Entities.Movies.BoxSet';
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const movieIds = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];

test('postgres: metadata scan captures bounded typed pages, continues a failure and releases cancelled traversal owners', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, database, dataPath } = await setup(t),folderId='bc310000-0000-0000-0000-000000000000';
  const folderPath=path.join(dataPath,'collections');await fs.mkdir(folderPath,{recursive:true});
  await database.insert('BaseItems',postgresTestRow('BaseItems',{Id:folderId,Type:'MediaBrowser.Controller.Entities.Folder',
    Name:'Metadata Scan Root',Path:folderPath,IsFolder:true,Data:'{}'}));
  const children = Array.from({ length: 257 }, (_, index) => postgresTestRow('BaseItems', {
    Id: 'bc310000-0000-0000-0000-' + String(index+1).padStart(12,'0'), ParentId: folderId,
    Type: movieType, Name: `Scan ${index}`, SortName: String(index).padStart(4,'0'),
    Path: `https://media.invalid/scan/${index}`, IsMovie: true, Data: '{}'
  }));
  await database.insertBatch('BaseItems', children);
  let active=0,maximumActive=0,attempted=0,maximumRows=0;
  const original=database.client.query;
  database.client.query=async(...args)=>{const result=await original(...args);
    for(const batch of Array.isArray(result)?result:[result]) maximumRows=Math.max(maximumRows,batch.rows?.length??0);
    return result;};
  runtime.metadataScanner.configuration.LibraryScanFanoutConcurrency=500;
  runtime.metadata.refresh=async reference=>{
    maximumActive=Math.max(maximumActive,++active);attempted++;
    try { await new Promise(resolve=>setImmediate(resolve));
      if(idKey(reference)===idKey(children[128].Id))throw Object.assign(new Error('Expected child failure'),{name:'IOException'});
      return {changed:false,Failures:0};
    }finally{active--;}
  };
  try {
    const progress=[],result=await runtime.metadataScanner.refreshChildren(folderId,{},
      {recursive:false,reportProgress:value=>progress.push(value)});
    assert.equal(attempted,257);assert.equal(result.attemptedCount,257);assert.equal(result.errors.length,1);
    assert.equal(result.errors[0].itemId,children[128].Id);assert.equal(active,0);assert.ok(maximumActive<=128);
    assert.ok(maximumActive>1);assert.ok(maximumRows<=128,`A typed page returned ${maximumRows} rows`);
    assert.equal(progress.at(-1),100);assert.ok(progress.every((value,index)=>!index||value>=progress[index-1]));
    const cancelled=await runtime.metadataScanner.refreshChildren(folderId,{signal:AbortSignal.abort(new Error('Cancelled scan'))},
      {recursive:false});
    assert.equal(cancelled.attemptedCount,0);assert.equal(cancelled.cancelled,true);assert.equal(attempted,257);
  } finally { database.client.query=original; }
});

async function setup(t, { externalData = false, cacheSize } = {}) {
  const output = validationOutputRoot(); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'collection-runtime-'));
  const programDataPath = path.join(root, 'program'), configurationDirectoryPath = path.join(root, 'config'),
    dataPath = path.join(externalData ? root : programDataPath, 'data'), metadataPath = path.join(programDataPath, 'metadata');
  let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('collection-runtime-'));
      await fs.rm(root, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Collection runtime cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true });
  await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><ContentTypes/></ServerConfiguration>');
  database = await createPostgresTestDatabase(null, 'collection_rt');
  for (const [index, Id] of movieIds.entries()) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: movieType, Name: `Movie ${index + 1}`, SortName: `movie ${index + 1}`, MediaType: 'Video',
    Path: `Z:\\CollectionMedia\\Movie${index + 1}.mkv`, IsMovie: true, IsFolder: false,
    OfficialRating: index === 0 ? 'PG' : 'R', DateCreated: '2026-10-13 00:00:00.0000000',
    DateModified: '2026-10-13 00:00:00.0000000', Data: '{}'
  }));
  const configuration = { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, IsStartupWizardCompleted: true,
    ...(cacheSize === undefined ? {} : { CacheSize: cacheSize }) }, errors = [];
  runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath, dataPath, metadataPath,
    configuration, serverId: 'collection-runtime', onError: error => errors.push(error) });
  runtime.libraryConfiguration.sleep = async () => {};
  const queued = [];
  runtime.metadata.queue = async (id, options, priority) => { queued.push({ id: idKey(id), options: { ...options }, priority }); };
  return { root, runtime, database, programDataPath, configurationDirectoryPath, dataPath, metadataPath,
    configuration, errors, queued };
}

test('postgres: managed collection creation and member edits persist XML and survive runtime restart', {
  skip: !postgresTestConnectionString,
}, async t => {
  const state = await setup(t), { runtime, database, queued } = state;
  const created = await runtime.collections.create({ Name: 'Managed Collection', IsLocked: true, ItemIdList: [] });
  assert.equal(created.Type, 'BoxSet'); assert.equal(created.Name, 'Managed Collection'); assert.equal(created.IsLocked, true);
  assert.equal(path.dirname(created.Path), path.join(state.dataPath, 'collections'));
  assert.equal((await database.rows('BaseItems', { where: { Id: created.Id } }))[0].Type, boxSetType);
  await runtime.collections.add(created.Id, [movieIds[0], movieIds[0], movieIds[1]]);
  assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: created.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId)),
  movieIds.map(idKey));
  assert.deepEqual(await readTestLinkIds(created),
    [movieIds[0], movieIds[0], movieIds[1]].map(idKey));
  assert.equal(queued.length, 2); assert.equal(queued[1].options.ForceSave, true);
  const sidecar = path.join(created.Path, 'collection.xml');
  const xml = await fs.readFile(sidecar, 'utf8');
  assert.match(xml, /Movie1\.mkv/); assert.match(xml, /Movie2\.mkv/);
  await runtime.collections.remove(created.Id, [movieIds[0]]);
  const links = (await database.rows('LinkedChildren', { where: { ParentId: created.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId));
  assert.deepEqual(links, movieIds.map(idKey));
  const folder = (await runtime.libraryConfiguration.getVirtualFolders()).find(value => value.CollectionType === 'boxsets');
  assert.ok(folder); assert.deepEqual(folder.Locations, [path.join(state.dataPath, 'collections')]);
  const persistedXml = await fs.readFile(sidecar, 'utf8');
  await runtime.close();
  const reopenedDatabase = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
  let reopened;
  try {
    reopened = await createRuntime({ database: reopenedDatabase, programDataPath: state.programDataPath,
      configurationDirectoryPath: state.configurationDirectoryPath, dataPath: state.dataPath, metadataPath: state.metadataPath,
      configuration: state.configuration, serverId: 'collection-runtime-reopen' });
    const item = await reopened.itemCreation.getItemById(created.Id);
    assert.equal(item.Type, 'BoxSet'); assert.equal(item.Name, created.Name); assert.equal(item.IsLocked, true);
    assert.deepEqual(await readTestLinkIds(item), links);
    assert.equal(await fs.readFile(path.join(item.Path, 'collection.xml'), 'utf8'), persistedXml);
    assert.equal(typeof reopened.libraryScanner?.queue, 'function');
    assert.equal(reopened.libraryScanner?.capabilities.completeLibraryScan, false);
  } finally { if (reopened) await reopened.close(); else await reopenedDatabase.close(); }
});

test('postgres: runtime close stops public configuration admission and drains admitted collection dependencies', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime } = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  runtime.collections.fileSystem = { ...fs, mkdir: async (...args) => {
    if (String(args[0]).endsWith('collections')) { entered.resolve(); await release.promise; }
    return fs.mkdir(...args);
  } };
  let configurationClosed = false;
  const original = runtime.libraryConfiguration.close.bind(runtime.libraryConfiguration);
  runtime.libraryConfiguration.close = async () => { await original(); configurationClosed = true; };
  const pending = runtime.collections.create({ Name: 'Admitted', ItemIdList: [] }); await entered.promise;
  const closing = runtime.close();
  try {
    await assert.rejects(runtime.collections.create({ Name: 'Late', ItemIdList: [] }), { status: 503 });
    await assert.rejects(runtime.libraryConfiguration.addVirtualFolder('Late', 'boxsets', {}), { status: 503 });
    assert.equal(configurationClosed, false);
  } finally { release.resolve(); await pending; await closing; }
  assert.equal(configurationClosed, true);
});

test('postgres: collection state supports an explicit DataPath through storage while rejecting unmapped media paths', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, root, dataPath, database } = await setup(t, { externalData: true });
  const collection = await runtime.collections.create({ Name: 'External State', ItemIdList: [] });
  assert.equal(path.dirname(collection.Path), path.join(dataPath, 'collections'));
  const mappedDirectory = path.join(dataPath, 'MappedMedia'); await runtime.fileSystem.mkdir(mappedDirectory);
  const mappedFolder = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  mappedFolder.Id = '44444444-4444-4444-4444-444444444444'; mappedFolder.Name = 'MappedMedia'; mappedFolder.Path = mappedDirectory;
  await runtime.itemCreation.saveItems([mappedFolder]);
  assert.equal((await database.rows('BaseItems', { where: { Id: mappedFolder.Id } })).length, 1);
  const directory = path.join(root, 'UnmappedMedia'); await fs.mkdir(directory);
  const mediaFolder = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  mediaFolder.Id = '33333333-3333-3333-3333-333333333333'; mediaFolder.Name = 'UnmappedMedia'; mediaFolder.Path = directory;
  await assert.rejects(runtime.itemCreation.saveItems([mediaFolder]), { code: 'not-found' });
  assert.deepEqual(await database.rows('BaseItems', { where: { Id: mediaFolder.Id } }), []);
  assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test('postgres: native ancestor collection roots support XML read, restart and deletion with parent notification', {
  skip: !postgresTestConnectionString,
}, async t => {
  const state = await setup(t), { runtime, database, programDataPath } = state;
  const aggregate = await runtime.libraryScanHost.getAggregateFolder();
  const parentId = '33333333-3333-3333-3333-333333333333';
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: parentId, ParentId: aggregate.Id, Type: 'MediaBrowser.Controller.Entities.Folder',
    Path: programDataPath, IsFolder: true, Name: 'Ancestor collections', SortName: 'ancestor collections', Data: '{}',
  }));
  const collection = await runtime.collections.create({ Name: 'Ancestor Collection', ItemIdList: [] });
  assert.equal(path.dirname(collection.Path), programDataPath);
  assert.equal(idKey(collection.ParentId), idKey(parentId));
  collection.Name = 'Renamed Collection';
  await runtime.collections.add(collection.Id, movieIds);
  const sidecar = path.join(collection.Path, 'collection.xml');
  const xml = await fs.readFile(sidecar, 'utf8');
  assert.match(xml, /Renamed Collection/); assert.match(xml, /Movie1\.mkv/); assert.match(xml, /Movie2\.mkv/);
  await runtime.close();
  const reopenedDatabase = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
  let reopened;
  try {
    reopened = await createRuntime({ database: reopenedDatabase, programDataPath,
      configurationDirectoryPath: state.configurationDirectoryPath, dataPath: state.dataPath, metadataPath: state.metadataPath,
      configuration: state.configuration, serverId: 'collection-runtime', onError: error => state.errors.push(error) });
    const cold = await reopened.itemCreation.getItemById(collection.Id);
    const loaded = await reopened.metadata.loadContext(cold.Id);
    assert.equal(loaded.context.localRoot, programDataPath);
    assert.equal(loaded.context.managedCollectionDirectoryRoot, programDataPath);
    const provider = reopened.metadata.registry.discover({ item: loaded.item, kind: 'local', includeDisabled: true })
      .find(value => value.id === 'BoxSetXmlProvider');
    assert.ok(provider);
    const parsed = await provider.getMetadata(loaded.item, loaded.context);
    assert.equal(parsed.HasMetadata, true); assert.equal(parsed.Item.Name, 'Renamed Collection');
    assert.equal(await reopened.linkedChildren.count(parsed.Item.LinkedChildren), 2n);
    releaseNativeItemLinks(parsed.Item); await reopened.linkedChildren.flushReleases();
    const parentContext = await reopened.metadata.loadContext(parentId);
    assert.equal(parentContext.context.localPath, programDataPath);
    assert.equal(parentContext.context.localRoot, programDataPath);
    await parentContext.dispose(); await loaded.dispose();
    const removed = [];
    reopened.library.on('ItemRemoved', event => removed.push({ item: idKey(event.Item.Id), parent: idKey(event.Parent?.Id) }));
    await reopened.itemDeletion.deleteItem(cold, { DeleteFileLocation: true });
    assert.deepEqual(removed, [{ item: idKey(cold.Id), parent: idKey(parentId) }]);
    assert.deepEqual(await reopenedDatabase.rows('BaseItems', { where: { Id: cold.Id } }), []);
    await assert.rejects(fs.stat(collection.Path), { code: 'ENOENT' });
    assert.equal((await fs.stat(programDataPath)).isDirectory(), true);
    assert.equal((await reopenedDatabase.rows('BaseItems', { where: { Id: parentId } })).length, 1);
    for (const Id of movieIds) assert.equal((await reopenedDatabase.rows('BaseItems', { where: { Id } })).length, 1);
    assert.deepEqual(state.errors, []);
  } finally { if (reopened) await reopened.close(); else await reopenedDatabase.close(); }
});

test('postgres: registered Collection task runs through the post-scan lifecycle with frozen names and a failed-group creation prefix', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const { runtime, database, programDataPath, queued } = await setup(t);
  const registrations = runtime.libraryScanLifecycle.postScanTasks;
  const posterIndex = registrations.indexOf(runtime.collectionPosterVerifyPostScanTask);
  assert.equal(registrations[posterIndex + 1], runtime.collectionPostScanTask);
  assert.notEqual(runtime.libraryScanner?.capabilities.completeLibraryScan, true);
  const original = await runtime.collections.create({ Name: 'A', ItemIdList: [] });
  const aggregate = await runtime.libraryScanHost.getAggregateFolder(), userRoot = await runtime.libraryScanHost.getUserRootFolder();
  const physicalId = '9a000000-0000-0000-0000-000000000001', libraryId = '9a000000-0000-0000-0000-000000000002';
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: physicalId, ParentId: aggregate.Id, Type: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true,
    Name: 'Task physical root', SortName: 'zzz task physical root', Path: programDataPath, Data: '{}',
  }));
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: libraryId, ParentId: userRoot.Id, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', IsFolder: true,
    Name: 'Task library', SortName: 'task library', Path: path.join(programDataPath, 'root', 'default', 'Task library'),
    Data: JSON.stringify({ PhysicalFolderIds: [physicalId], PhysicalLocationsList: [programDataPath] }),
  }));
  runtime.library.options.libraryOptions.set(idKey(libraryId), { AutomaticallyAddToCollection: true });
  const members = Array.from({ length: 6 }, (_, index) => '9a000000-0000-0000-0000-' + String(index + 100).padStart(12, '0'));
  for (const [index, Id] of members.entries()) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id, ParentId: physicalId, TopParentId: physicalId, Type: movieType, IsMovie: true, MediaType: 'Video',
      Name: 'Task movie ' + index, SortName: String(index).padStart(3, '0'), Path: 'Z:\\TaskMedia\\Movie' + index + '.mkv',
      Data: JSON.stringify({ TmdbCollectionName: ['A', 'B', 'C'][Math.floor(index / 2)] }),
      DateCreated: '2026-10-14 00:00:00.0000000', DateModified: '2026-10-14 00:00:00.0000000',
    }));
    await database.insert('AncestorIds', { ItemId: Id, ParentItemId: physicalId });
  }
  const created = [], added = [], pending = [], failures = [];
  runtime.collections.on('CollectionCreated', ({ Collection }) => created.push({ id: Collection.Id, name: Collection.Name }));
  runtime.collections.on('ItemsAddedToCollection', ({ Collection, Items }) => {
    const entry = { id: Collection.Id, ids: undefined }; added.push(entry);
    pending.push(captureTestEvent(Items).then(ids => { entry.ids = ids; }));
    if (Collection.Id === original.Id) Collection.Name = 'B';
  });
  const update = runtime.collections.updateRepository.bind(runtime.collections);
  let removed = false;
  runtime.collections.updateRepository = async item => {
    await update(item);
    if (item.Id === original.Id && !removed) {
      removed = true;
      await database.delete('AncestorIds', { ItemId: members[2], ParentItemId: physicalId });
      await database.delete('BaseItems', { Id: members[2] });
    }
  };
  runtime.collectionPostScanTask.logger = { error: error => failures.push(error) };
  runtime.libraryScanLifecycle.postScanTasks = [runtime.collectionPostScanTask];
  await runtime.libraryScanLifecycle.runPostScanTasks();
  await Promise.all(pending);
  assert.equal(original.Name, 'B', 'Only the independent manager cache instance was renamed.');
  assert.deepEqual(created.map(item => item.name), ['B', 'C']);
  assert.notEqual(created[0].id, original.Id, 'The initial repository Name snapshot must not follow a cache mutation.');
  assert.equal(failures.length, 1); assert.equal(failures[0].status, 400);
  assert.deepEqual(added.map(entry => entry.ids), [members.slice(0, 2).map(idKey), members.slice(4).map(idKey)]);
  const rows = await database.rows('BaseItems', { where: { Type: boxSetType } });
  assert.deepEqual(rows.map(item => item.Name).toSorted(), ['A', 'B', 'C']);
  assert.equal((await database.rows('LinkedChildren', { where: { ParentId: created[0].id } })).length, 0);
  assert.equal((await database.rows('LinkedChildren', { where: { ParentId: created[1].id } })).length, 2);
  assert.equal(queued.filter(entry => entry.options.ForceSave).length, 2);
  assert.equal((await fs.stat(path.join(programDataPath, 'data', 'collections', 'B [boxset]'))).isDirectory(), true);
});

test('postgres: collection root selection hydrates bounded repository pages in native order', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, database } = await setup(t);
  const parent = await runtime.libraryScanHost.getAggregateFolder(), ids = [];
  const { items: initial, hasMore: initialHasMore } = await runtime.libraryScanHost.getCachedChildrenPage(parent, { limit: 128 });
  assert.ok(initial.length < 128);
  assert.equal(initialHasMore, false);
  for (let index = 0; index < 260; index++) {
    const Id = `aaaaaaaa-aaaa-aaaa-aaaa-${String(index + 1).padStart(12, '0')}`;
    ids.push(Id);
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id, ParentId: parent.Id, Type: 'MediaBrowser.Controller.Entities.Folder',
      IsFolder: true, Name: `Paged root ${index}`, SortName: `paged root ${260 - index}`, Data: '{}'
    }));
  }
  const projections = [], originalLoad = runtime.library.load.bind(runtime.library);
  runtime.library.load = async (db, user, options) => {
    projections.push(options.baseRows.filter(row => row.ParentId && idKey(row.ParentId) === idKey(parent.Id)).length);
    return originalLoad(db, user, options);
  };
  const selected = [];
  for (let startIndex = 0; startIndex < 384; startIndex += 128) {
    const { items: page, hasMore } = await runtime.libraryScanHost.getCachedChildrenPage(parent, { startIndex, limit: 128 });
    assert.ok(page.length <= 128); selected.push(...page.map(item => idKey(item.Id)));
    assert.equal(hasMore, startIndex < 256);
  }
  const expected = ids.map((Id, index) => ({ Id, SortName: `paged root ${260 - index}` }))
    .sort((left, right) => left.SortName < right.SortName ? -1 : left.SortName > right.SortName ? 1 : 0)
    .map(item => idKey(item.Id));
  const seededIds = new Set(ids.map(idKey));
  assert.deepEqual(selected.filter(id => seededIds.has(id)), expected);
  assert.equal(selected.length, ids.length + initial.length);
  assert.deepEqual(selected.filter(id => !seededIds.has(id)), initial.map(item => idKey(item.Id)));
  assert.deepEqual(projections, [128, 128, 4 + initial.length]);
});

test('postgres: collection root lookup continues after a full SQL page contains an unknown native type', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, database, dataPath } = await setup(t);
  const parent = await runtime.libraryScanHost.getAggregateFolder();
  for (let index = 0; index < 127; index++) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(index + 1).padStart(12, '0')}`,
      ParentId: parent.Id, Type: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true,
      Name: `Paged root ${index}`, Path: path.join(dataPath, `unrelated-root-${index}`),
      SortName: `00 root ${String(index).padStart(3, '0')}`, Data: '{}'
    }));
  }
  const unknownId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: unknownId, ParentId: parent.Id, Type: 'Removed.Plugin.UnsupportedFolder', IsFolder: true,
    Name: 'Removed plugin root', Path: path.join(dataPath, 'removed-plugin-root'),
    SortName: '00 root 063 removed plugin', Data: '{}'
  }));
  const collectionRootId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const collectionsPath = path.join(dataPath, 'collections');
  await fs.mkdir(collectionsPath, { recursive: true });
  await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: collectionRootId, ParentId: parent.Id, Type: 'MediaBrowser.Controller.Entities.Folder',
    IsFolder: true, Name: 'Collections', Path: collectionsPath, SortName: '01 collection root', Data: '{}'
  }));
  const first = await runtime.libraryScanHost.getCachedChildrenPage(parent, { startIndex: 0, limit: 128 });
  assert.equal(first.items.length, 127);
  assert.equal(first.hasMore, true);
  assert.equal(first.items.some(item => idKey(item.Id) === idKey(unknownId)), false);
  assert.equal(first.items.some(item => idKey(item.Id) === idKey(collectionRootId)), false);
  const second = await runtime.libraryScanHost.getCachedChildrenPage(parent, { startIndex: 128, limit: 128 });
  assert.equal(second.items.some(item => idKey(item.Id) === idKey(collectionRootId)), true);
  assert.equal(second.hasMore, false);
  const pages = [], original = runtime.libraryScanHost.getCachedChildrenPage.bind(runtime.libraryScanHost);
  runtime.libraryScanHost.getCachedChildrenPage = async (root, options) => {
    pages.push(options.startIndex);
    return original(root, options);
  };
  const selected = await runtime.collections.getCollectionsFolder(false);
  assert.equal(idKey(selected.Id), idKey(collectionRootId));
  assert.deepEqual(pages, [0, 128]);
});

test('postgres: collection path references select the latest default-visible item', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { runtime, database } = await setup(t);
  const collection = await runtime.collections.create({ Name: 'Path Reference', ItemIdList: [] });
  const identity = 'Z:\\CollectionMedia\\Shared.mkv';
  for (const [index, Id] of movieIds.entries()) await database.update('BaseItems', { Id }, {
    Path: identity, DateCreated: `202${index + 4}-10-13 00:00:00.0000000`
  });
  for (const [index, Id] of ['33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'].entries()) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id, Type: movieType, Name: 'Excluded reference', Path: identity, IsMovie: true,
      OwnerId: index === 0 ? collection.Id : null, PrimaryVersionId: index === 1 ? movieIds[0] : null,
      DateCreated: '2026-10-13 00:00:00.0000000', Data: '{}'
    }));
  }
  await assignTestLinks(runtime, collection, [{ ItemId: '99999999-9999-9999-9999-999999999999', Path: identity, Type: 0 }]);
  await runtime.collections.add(collection.Id, [movieIds[0]]);
  assert.deepEqual(await readTestLinkIds(collection), [movieIds[1], movieIds[0]].map(idKey));
  assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: collection.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId)),
  [movieIds[1], movieIds[0]].map(idKey));
});
