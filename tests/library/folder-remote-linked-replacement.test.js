import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import { createOwnedFolderValidationFixture, ownedRefreshOptions } from '../helpers/owned-folder-validation-fixture.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, mapRecord, nonemptyId, sameId } from '../../src/library/records.js';
import { createVideoFileResolver, movieNativeType } from '../../src/library/video-file-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';

const oracleRoot = new URL('./fixtures/folder-remote-linked-replacement/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const [oracleInput, oracle, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => JSON.parse(await readFile(new URL(file, oracleRoot), 'utf8'))));
const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Movies\\Film';
const rootId = 'B7300000-0000-0000-0000-000000000001';
const aggregateId = 'B7300000-0000-0000-0000-000000000002';
const userRootId = 'B7300000-0000-0000-0000-000000000003';
const collectionId = 'B7300000-0000-0000-0000-000000000004';
const remoteId = 'B7300000-0000-0000-0000-000000000005';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
    : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

function row(Id, Type, values = {}) {
  return {
    ...blank, Id, Type, Name: values.Name ?? Type.split('.').at(-1), CleanName: '', SortName: '',
    IsFolder: values.IsFolder ?? false, MediaType: values.MediaType ?? 'Unknown',
    Data: values.Data ?? (Type.includes('CollectionFolder') ? JSON.stringify({}) : null), ...values
  };
}

const movie = async (value, path) => {
  const [stored] = await value.database.rows('BaseItems', { where: { Path: path } });
  return stored && mapRecord(stored);
};
const linkTo = (links, parentId, childId, type) => links.some(link => sameId(link.ParentId, parentId)
  && sameId(link.ChildId, childId) && Number(link.ChildType) === type);
const dbFailure = (error, dialect) => dialect === 'postgres' ? error.code === '23503' : error.errcode === 787;
const position = (trace, predicate) => trace.findIndex(predicate);

async function fixture(t, dialect, versionCount, { manual = true } = {}) {
  const schema = `remote_linked_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database), registry = new StorageRegistry();
  let validationFixture, itemCreation, lifecycleFixture, library, referenceOwner;
  t.after(async () => {
    referenceOwner?.release(); await validationFixture?.close(); await itemCreation?.close(); await lifecycleFixture?.close(); await library?.close();
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
  vfs.mount({ path: '/movies', instanceId: 'movies', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: rootPath, accessRoot: '/movies', style: 'windows', returnAccess: 'remote linked fixture' });
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
  library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'remote-linked-replacement', programDataPath });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] });
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule });
  itemCreation = new ItemCreationService({ store, library, linkedChildren:lifecycleFixture.linkedChildren, loadContext: lifecycleFixture.loadContext });
  library.itemCreation = itemCreation;
  const linkedChildReferences = new LinkedChildReferenceService({ store, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates });
  const trace = [];
  const update = lifecycleFixture.updates.update.bind(lifecycleFixture.updates);
  lifecycleFixture.updates.update = async (loaded, result, reason, options) => {
    trace.push({ phase: 'save:start', id: idKey(result.Item.Id) });
    const value = await update(loaded, result, reason, options);
    trace.push({ phase: 'save:end', id: idKey(result.Item.Id) });
    return value;
  };
  const externalData = {
    async deleteInternalItemFiles(item) { trace.push({ phase: 'cleanup:internal', id: idKey(item.Id) }); },
    async deleteItemFiles(item) { trace.push({ phase: 'cleanup:external', id: idKey(item.Id) }); }
  };
  const itemDeletion = new ItemDeletionService({ store, library, itemCreation,
    loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates,
    linkedChildReferences, vfs, externalData });
  library.itemDeletion = itemDeletion;
  const createItems = itemCreation.createItems.bind(itemCreation);
  itemCreation.createItems = async (items, ...args) => {
    trace.push({ phase: 'create:start', ids: items.map(item => idKey(item.Id)) });
    const value = await createItems(items, ...args);
    trace.push({ phase: 'create:end', ids: items.map(item => idKey(item.Id)) });
    return value;
  };
  validationFixture = createOwnedFolderValidationFixture({
    ignoreRule, lifecycleFixture, configuration: { LibraryScanFanoutConcurrency: 1 },
    store, library, vfs, identityMap, refreshes: new ProviderRefreshService(), programDataPath,
    resolverPipeline: new DirectoryItemResolverPipeline({ programDataPath, resolvers: [createVideoFileResolver()] }),
    resolvedItemLifecycle: lifecycleFixture.lifecycle, itemCreation, itemDeletion: library.itemDeletion, linkedChildReferences
  });
  const reference = await itemCreation.getItemById(rootId);
  referenceOwner = itemCreation.retainItem(reference);
  const { validation, errors } = validationFixture;
  for (const name of ['Film - 2160p.mkv', 'Film - 1080p.mkv', ...(versionCount === 3 ? ['Film - 720p.mkv'] : [])]) {
    await adapter.write(`/${name}`, Buffer.from(name));
  }
  await validation.validateChildren(reference, ownedRefreshOptions);
  const source = await movie({ database }, `${rootPath}\\Film - 2160p.mkv`);
  assert.ok(source && !nonemptyId(source.PrimaryVersionId) && !nonemptyId(source.OwnerId));
  const manualId = manual ? randomUUID() : null;
  if (manual) {
    await database.insert('BaseItems', row(manualId, 'MediaBrowser.Controller.Entities.Movies.BoxSet', {
      Name: 'Manual incoming', IsFolder: true, Data: JSON.stringify({ SourceType: 'Library' })
    }));
    await database.insert('LinkedChildren', { ParentId: manualId, SortOrder: 0, ChildId: source.Id, ChildType: 0 });
  }
  await database.insert('BaseItems', row(remoteId, movieNativeType, {
    Name: 'Remote linked alternate', Path: 'https://media.invalid/film-linked.mkv', ParentId: aggregateId,
    PrimaryVersionId: source.Id, MediaType: 'Video',
    Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile', AdditionalParts: [], LocalAlternateVersions: [] })
  }));
  await database.insert('LinkedChildren', { ParentId: source.Id, SortOrder: versionCount - 1, ChildId: remoteId, ChildType: 3 });
  itemCreation.unregisterItem(source.Id);
  await itemCreation.getItemById(source.Id); await itemCreation.getItemById(remoteId);
  if (manual) await itemCreation.getItemById(manualId);
  trace.length = 0;
  return { database, adapter, validation, errors, reference, source, manualId, trace };
}

test('remote linked replacement native oracle is sealed and records the requested branch', async () => {
  assert.equal(oracle.actualFrozenRemoteLinkedReplacement, true);
  assert.deepEqual(oracle.results.map(result => result.name), oracleInput.map(sample => sample.name));
  for (const file of provenance.fixtureFiles) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file.path, repository))).digest('hex'),
      file.sha256, file.path);
  }
  const [two, three, exact] = oracle.results;
  for (const result of oracle.results) assert.ok(result.beforeLinks.some(link => link.parentId === result.ids.oldPrimary
    && link.childId === result.ids.remote && link.childType === 3));
  assert.equal(two.stages[0].exception, null);
  assert.equal(two.stages[0].rows.some(row => row.id === two.ids.remote), false);
  assert.deepEqual(two.stages[0].trace.slice(0, 2).map(call => [call.action, call.id ?? call.ids?.[0]]),
    [['external-files', two.ids.remote], ['delete', two.ids.remote]]);
  assert.equal(three.stages[0].exception, 'DbUpdateException');
  assert.equal(three.stages[0].rows.some(row => row.id === three.ids.remote), false);
  assert.equal(three.stages[0].trace.some(call => call.action === 'delete' && call.ids?.includes(three.ids.oldPrimary)), false);
  assert.equal(exact.stages[0].exception, null);
  assert.equal(exact.stages[0].rows.find(row => row.id === exact.ids.remote).path, 'https://media.invalid/film-linked.mkv');
  assert.equal(exact.stages[0].links.some(link => link.childType === 3), false);
  assert.equal(exact.stages[1].exception, 'DbUpdateException');
  assert.ok(exact.stages[1].rows.find(row => row.id === exact.ids.remote));
});

for (const dialect of ['postgres']) {
  const candidate = (name, fn) => test(`${dialect}: ${name}`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, t => fn(t, dialect));

  candidate('two-version replacement deletes a missing HTTP linked alternate and succeeds', async (t, dialect) => {
    const value = await fixture(t, dialect, 2);
    await value.adapter.delete('/Film - 2160p.mkv');
    await value.validation.validateChildren(value.reference, ownedRefreshOptions);
    const target = await movie(value, `${rootPath}\\Film - 1080p.mkv`);
    assert.ok(target && !nonemptyId(target.PrimaryVersionId) && !nonemptyId(target.OwnerId));
    assert.equal((await value.database.rows('BaseItems', { where: { Id: value.source.Id } })).length, 0);
    assert.equal((await value.database.rows('BaseItems', { where: { Id: remoteId } })).length, 0);
    const links = await value.database.rows('LinkedChildren');
    assert.ok(linkTo(links, value.manualId, target.Id, 0));
    assert.equal(links.some(link => Number(link.ChildType) === 3), false);
    const remoteCleanupAt = position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(remoteId));
    const targetSaveAt = position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(target.Id));
    const sourceCleanupAt = position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(value.source.Id));
    const createAt = position(value.trace,
      entry => entry.phase === 'create:start' && entry.ids.includes(idKey(target.Id)));
    assert.ok(remoteCleanupAt >= 0 && remoteCleanupAt < targetSaveAt && targetSaveAt < sourceCleanupAt
      && sourceCleanupAt < createAt,
    `native prefix is remote cleanup -> target promotion -> source cleanup -> CreateItems: ${JSON.stringify(value.trace)}`);
    assert.equal(position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(remoteId)), -1,
    'the deleted HTTP linked alternate is never routed through UpdateItem');
  });

  candidate('outgoing ChildType=3 alone activates the two-version native delete path', async (t, dialect) => {
    const value = await fixture(t, dialect, 2, { manual: false });
    await value.adapter.delete('/Film - 2160p.mkv');
    await value.validation.validateChildren(value.reference, ownedRefreshOptions);
    const target = await movie(value, `${rootPath}\\Film - 1080p.mkv`);
    assert.ok(target && !nonemptyId(target.PrimaryVersionId) && !nonemptyId(target.OwnerId));
    assert.equal((await value.database.rows('BaseItems', { where: { Id: value.source.Id } })).length, 0);
    assert.equal((await value.database.rows('BaseItems', { where: { Id: remoteId } })).length, 0);
    const remoteCleanupAt = position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(remoteId));
    const targetSaveAt = position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(target.Id));
    const sourceCleanupAt = position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(value.source.Id));
    const createAt = position(value.trace,
      entry => entry.phase === 'create:start' && entry.ids.includes(idKey(target.Id)));
    assert.ok(remoteCleanupAt >= 0 && remoteCleanupAt < targetSaveAt && targetSaveAt < sourceCleanupAt
      && sourceCleanupAt < createAt, JSON.stringify(value.trace));
  });

  candidate('three-version replacement deletes the HTTP alternate before the native FK failure', async (t, dialect) => {
    const value = await fixture(t, dialect, 3);
    await value.adapter.delete('/Film - 2160p.mkv');
    await assert.rejects(value.validation.validateChildren(value.reference, ownedRefreshOptions),
      error => dbFailure(error, dialect));
    assert.equal((await value.database.rows('BaseItems', { where: { Id: remoteId } })).length, 0);
    assert.equal((await value.database.rows('BaseItems', { where: { Id: value.source.Id } })).length, 1);
    const target = await movie(value, `${rootPath}\\Film - 1080p.mkv`);
    const remaining = await movie(value, `${rootPath}\\Film - 720p.mkv`);
    const links = await value.database.rows('LinkedChildren');
    assert.ok(linkTo(links, value.manualId, target.Id, 0));
    const createAt = position(value.trace,
      entry => entry.phase === 'create:start' && entry.ids.includes(idKey(target.Id)));
    const remainingSaveAt = position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(remaining.Id));
    const remoteSaveAt = position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(remoteId));
    const remoteCleanupAt = position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(remoteId));
    const targetSaveAt = position(value.trace,
      entry => entry.phase === 'save:start' && entry.id === idKey(target.Id));
    assert.ok(createAt >= 0 && createAt < remainingSaveAt && remainingSaveAt < remoteSaveAt
      && remoteSaveAt < remoteCleanupAt && remoteCleanupAt < targetSaveAt,
    `native failed prefix is target create -> local transfer -> remote save/delete -> target FK save: ${JSON.stringify(value.trace)}`);
    assert.equal(position(value.trace,
      entry => entry.phase === 'cleanup:external' && entry.id === idKey(value.source.Id)), -1,
    'the real target-save FK failure precedes old-primary cleanup');
  });

  candidate('exact-primary demotion loses the remote link and its later removal keeps the native failed prefix', async (t, dialect) => {
    const value = await fixture(t, dialect, 2);
    await value.adapter.write('/Film.mkv', Buffer.from('exact'));
    await value.validation.validateChildren(value.reference, ownedRefreshOptions);
    const exact = await movie(value, `${rootPath}\\Film.mkv`);
    let [remote] = await value.database.rows('BaseItems', { where: { Id: remoteId } });
    let links = await value.database.rows('LinkedChildren');
    assert.equal(idKey(remote.PrimaryVersionId), idKey(exact.Id));
    assert.equal(links.some(link => Number(link.ChildType) === 3), false);
    assert.ok(linkTo(links, value.manualId, exact.Id, 0));
    await value.adapter.delete('/Film.mkv');
    await assert.rejects(value.validation.validateChildren(value.reference, ownedRefreshOptions),
      error => dbFailure(error, dialect));
    [remote] = await value.database.rows('BaseItems', { where: { Id: remoteId } });
    links = await value.database.rows('LinkedChildren');
    assert.equal(idKey(remote.PrimaryVersionId), idKey(exact.Id));
    assert.ok(linkTo(links, value.manualId, value.source.Id, 0));
    const [source] = await value.database.rows('BaseItems', { where: { Id: value.source.Id } });
    assert.ok(!source.OwnerId && !source.PrimaryVersionId);
  });

  candidate('outgoing ChildType=3 alone activates exact-primary demotion', async (t, dialect) => {
    const value = await fixture(t, dialect, 2, { manual: false });
    await value.adapter.write('/Film.mkv', Buffer.from('exact'));
    await value.validation.validateChildren(value.reference, ownedRefreshOptions);
    const exact = await movie(value, `${rootPath}\\Film.mkv`);
    const [remote] = await value.database.rows('BaseItems', { where: { Id: remoteId } });
    const links = await value.database.rows('LinkedChildren');
    assert.ok(exact && remote);
    assert.equal(idKey(remote.PrimaryVersionId), idKey(exact.Id));
    assert.equal(links.some(link => Number(link.ChildType) === 3), false);
  });
}
