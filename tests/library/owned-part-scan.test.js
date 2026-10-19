import { testFileSystem } from '../storage/plugin-files.js';
import { failBaseItemDelete } from '../database/postgres-faults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderScanService, folderScanIncompleteReasonCodes } from '../../src/library/folder-scan-service.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, mapRecord, nonemptyId } from '../../src/library/records.js';
import { updateFromResolvedItem } from '../../src/library/resolved-item-update.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { createVideoFileResolver, movieNativeType, videoNativeType } from '../../src/library/video-file-resolver.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Movies\\Film';
const rootId = 'A7300000-0000-0000-0000-000000000001';
const aggregateId = 'A7300000-0000-0000-0000-000000000002';
const userRootId = 'A7300000-0000-0000-0000-000000000003';
const collectionId = 'A7300000-0000-0000-0000-000000000004';
const folderNativeType = 'MediaBrowser.Controller.Entities.Folder';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

function deterministicId(name, nativeType) {
  return nativeGuid(getNewItemId(`${rootPath}\\${name}`, nativeType, {
    programDataPath,
    enableCaseSensitiveItemIds: false
  }));
}

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
  const schema = `owned_parts_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return { database: await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true
  }), schema };
}

async function fixture(t, dialect, collectionType = 'movies') {
  const { database, schema } = await databaseFor(dialect);
  const store = new DomainStore(database);
  const registry = new StorageRegistry();
  let library, scanner;
  t.after(async () => {
    await scanner?.close();
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
  identityMap.addPrefix({ identityRoot: rootPath, accessRoot: '/movies', style: 'windows', returnAccess: 'Owned-part scan fixture' });
  await database.insert('BaseItems', row(aggregateId, 'MediaBrowser.Controller.Entities.AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(userRootId, 'MediaBrowser.Controller.Entities.UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', row(rootId, folderNativeType, {
    Name: 'Film', Path: rootPath, ParentId: aggregateId, TopParentId: rootId, IsFolder: true,
    Data: JSON.stringify({ SourceType: 'Library' })
  }));
  await database.insert('BaseItems', row(collectionId, 'MediaBrowser.Controller.Entities.CollectionFolder', {
    Name: 'Movies', ParentId: userRootId, IsFolder: true,
    Data: JSON.stringify({ CollectionType: collectionType, PhysicalFolderIds: [rootId], PhysicalLocationsList: [rootPath] })
  }));
  library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'owned-part-scan' });
  const lifecycle = {
    async apply(id, { resolved, markIrreversible }) {
      markIrreversible();
      return store.transaction(async db => {
        const [stored] = await db.rows('BaseItems', { where: { Id: id }, limit: 1 });
        const item = mapRecord(stored), updated = { ...item };
        const updateType = updateFromResolvedItem(updated, resolved);
        if (updateType <= ItemUpdateType.None) return Object.freeze({ changed: false });
        const data = { ...item.Data };
        for (const field of ['AdditionalParts', 'LocalAlternateVersions', 'VideoType']) data[field] = updated[field];
        await db.update('BaseItems', { Id: stored.Id }, {
          IsInMixedFolder: updated.IsInMixedFolder,
          Data: JSON.stringify(data)
        });
        return Object.freeze({ changed: true });
      });
    }
  };
  const resolverPipeline = new DirectoryItemResolverPipeline({
    programDataPath,
    resolvers: [createVideoFileResolver()]
  });
  scanner = new FolderScanService({
    ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] }),
    store,
    library,
    vfs,
    identityMap,
    refreshes: new ProviderRefreshService(),
    programDataPath,
    resolverPipeline,
    resolvedItemLifecycle: lifecycle
  });
  const reference = mapRecord((await database.rows('BaseItems', { where: { Id: rootId } }))[0]);
  return { database, library, adapter, vfs, scanner, reference };
}

async function state(database) {
  return (await database.rows('BaseItems')).filter(value => [movieNativeType, videoNativeType].includes(value.Type))
    .toSorted((left, right) => String(left.Path).localeCompare(String(right.Path)));
}

function assertStack(items, primaryName, partNames) {
  const primary = items.find(item => item.Type === movieNativeType && item.Path === `${rootPath}\\${primaryName}`);
  assert.ok(primary, `missing stack primary ${primaryName}`);
  assert.equal(primary.OwnerId, null);
  assert.equal(primary.PrimaryVersionId, null);
  assert.deepEqual(JSON.parse(primary.Data).AdditionalParts, partNames.map(name => `${rootPath}\\${name}`));
  for (const name of partNames) {
    const part = items.find(item => idKey(item.Id) === idKey(deterministicId(name, videoNativeType)));
    assert.ok(part, `missing owned part ${name}`);
    assert.equal(part.Type, videoNativeType);
    assert.equal(idKey(part.OwnerId), idKey(primary.Id));
    assert.equal(idKey(part.ParentId), idKey(rootId));
    assert.equal(idKey(part.TopParentId), idKey(rootId));
    assert.equal(part.PrimaryVersionId, null);
    assert.equal(part.ExtraType, null);
  }
  return primary;
}

for (const dialect of ['postgres']) test(`${dialect}: stacked movie parts persist, reorder, promote and collapse atomically`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));

  const created = await scanner.scan(reference);
  assert.equal(created.added, 1, 'only the stack primary is a direct CreateItems addition');
  let items = await state(database);
  assertStack(items, 'Film cd1.mkv', ['Film cd2.mkv']);
  const stable = structuredClone(items);
  assert.deepEqual((await scanner.scan(reference)).added, 0);
  assert.deepEqual(await state(database), stable);

  await adapter.write('/Film cd0.mkv', Buffer.from('zero'));
  await scanner.scan(reference);
  items = await state(database);
  assertStack(items, 'Film cd0.mkv', ['Film cd1.mkv', 'Film cd2.mkv']);
  assert.equal(items.some(item => idKey(item.Id) === idKey(deterministicId('Film cd1.mkv', movieNativeType))), false,
    'the demoted path no longer retains its Movie identity');

  await adapter.delete('/Film cd0.mkv');
  await scanner.scan(reference);
  items = await state(database);
  assertStack(items, 'Film cd1.mkv', ['Film cd2.mkv']);

  await adapter.write('/Film cd10.mkv', Buffer.from('ten'));
  await scanner.scan(reference);
  items = await state(database);
  assertStack(items, 'Film cd1.mkv', ['Film cd10.mkv', 'Film cd2.mkv']);

  await adapter.delete('/Film cd1.mkv');
  await scanner.scan(reference);
  items = await state(database);
  assertStack(items, 'Film cd10.mkv', ['Film cd2.mkv']);
  assert.equal(items.some(item => item.Path === `${rootPath}\\Film cd1.mkv`), false);
  assert.equal(items.some(item => idKey(item.Id) === idKey(deterministicId('Film cd10.mkv', videoNativeType))), false,
    'the promoted path no longer retains its owned Video identity');

  await adapter.delete('/Film cd2.mkv');
  await scanner.scan(reference);
  items = await state(database);
  const standalone = items.find(item => item.Path === `${rootPath}\\Film cd10.mkv`);
  assert.equal(standalone.Type, movieNativeType);
  assert.deepEqual(JSON.parse(standalone.Data).AdditionalParts, []);
  assert.equal(items.length, 1);
});

for (const dialect of ['postgres']) test(`${dialect}: weak snapshots preserve an existing owned-part family`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, vfs, scanner, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await scanner.scan(reference);
  const before = await state(database);
  await adapter.delete('/Film cd2.mkv');
  const list = vfs.list.bind(vfs);
  vfs.list = async (path, options) => ({ ...await list(path, options), consistency: 'weak', snapshot: null, deletionSafe: false });
  const weak = await scanner.scan(reference);
  assert.equal(weak.structurallyComplete, false);
  assert.ok(weak.incompleteReasons.some(reason => reason.code === 'weak-directory-snapshot'));
  assert.deepEqual(await state(database), before);
  vfs.list = list;
  await scanner.scan(reference);
  const after = await state(database);
  assert.equal(after.length, 1);
  assert.deepEqual(JSON.parse(after[0].Data).AdditionalParts, []);
});

for (const dialect of ['postgres']) test(`${dialect}: owned-part insertion failure rolls back its complete stack`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await scanner.scan(reference);
  const before = await state(database);
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  const insert = database.insert.bind(database);
  database.insert = async (table, values) => {
    if (table === 'BaseItems' && values.Type === videoNativeType && values.OwnerId != null) {
      throw new Error('controlled owned-part insert failure');
    }
    return insert(table, values);
  };
  await assert.rejects(scanner.scan(reference), /controlled owned-part insert failure/u);
  database.insert = insert;
  assert.deepEqual(await state(database), before);
  await scanner.scan(reference);
  assertStack(await state(database), 'Film cd1.mkv', ['Film cd2.mkv']);
});

for (const dialect of ['postgres']) test(`${dialect}: each stacked movie version persists its own parts through cold reads and repeat scans`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, library, adapter, scanner, reference } = await fixture(t, dialect);
  for (const name of ['Film - Director cd1.mkv', 'Film - Director cd2.mkv',
    'Film - Theatrical cd1.mkv', 'Film - Theatrical cd2.mkv']) {
    await adapter.write(`/${name}`, Buffer.from(name));
  }
  await scanner.scan(reference);
  const items = await state(database);
  const primary = items.find(item => item.Type === movieNativeType
    && item.Path === `${rootPath}\\Film - Director cd1.mkv`);
  const alternate = items.find(item => item.Type === movieNativeType
    && item.Path === `${rootPath}\\Film - Theatrical cd1.mkv`);
  const part = items.find(item => item.Type === videoNativeType
    && item.Path === `${rootPath}\\Film - Director cd2.mkv`);
  const alternatePart = items.find(item => item.Type === videoNativeType
    && item.Path === `${rootPath}\\Film - Theatrical cd2.mkv`);
  assert.ok(primary);
  assert.ok(alternate);
  assert.ok(part);
  assert.ok(alternatePart);
  assert.equal(items.length, 4);
  assert.deepEqual(JSON.parse(primary.Data).AdditionalParts, [`${rootPath}\\Film - Director cd2.mkv`]);
  assert.deepEqual(JSON.parse(primary.Data).LocalAlternateVersions, [`${rootPath}\\Film - Theatrical cd1.mkv`]);
  assert.deepEqual(JSON.parse(alternate.Data).AdditionalParts, [`${rootPath}\\Film - Theatrical cd2.mkv`]);
  assert.equal(idKey(alternate.OwnerId), idKey(primary.Id));
  assert.equal(idKey(alternate.PrimaryVersionId), idKey(primary.Id));
  for (const [owner, ownedPart] of [[primary, part], [alternate, alternatePart]]) {
    assert.equal(idKey(ownedPart.OwnerId), idKey(owner.Id));
    assert.equal(idKey(ownedPart.ParentId), idKey(rootId));
    assert.equal(idKey(ownedPart.TopParentId), idKey(rootId));
    assert.equal(ownedPart.PrimaryVersionId, null);
    assert.equal(ownedPart.ExtraType, null);
    const coldOwner = await library.getItemRecord(owner.Id);
    const coldPart = await library.getItemRecord(ownedPart.Id);
    assert.equal(coldOwner.NativeType, movieNativeType);
    assert.deepEqual(coldOwner.AdditionalParts, [ownedPart.Path]);
    for (const field of ['OwnerId', 'PrimaryVersionId']) {
      if (nonemptyId(owner[field])) assert.equal(idKey(coldOwner[field]), idKey(owner[field]));
      else assert.ok(!nonemptyId(coldOwner[field]), `${field} remains an empty relationship`);
    }
    assert.equal(coldPart.NativeType, videoNativeType);
    assert.equal(coldPart.Path, ownedPart.Path);
    assert.equal(idKey(coldPart.OwnerId), idKey(owner.Id));
    assert.equal(idKey(coldPart.ParentId), idKey(rootId));
  }
  const repeated = await scanner.scan(reference);
  assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
    { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(await state(database), items);
});

for (const dialect of ['postgres']) test(`${dialect}: home-video stack promotion reuses the Video identity safely`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, dialect, 'homevideos');
  await adapter.write('/Holiday pt1.mp4', Buffer.from('one'));
  await adapter.write('/Holiday pt2.mp4', Buffer.from('two'));
  await scanner.scan(reference);
  let items = await state(database);
  const primary = items.find(item => item.Path === `${rootPath}\\Holiday pt1.mp4`);
  const part = items.find(item => item.Path === `${rootPath}\\Holiday pt2.mp4`);
  assert.equal(primary.Type, videoNativeType);
  assert.equal(part.Type, videoNativeType);
  assert.equal(primary.OwnerId, null);
  assert.equal(idKey(part.OwnerId), idKey(primary.Id));
  assert.deepEqual(JSON.parse(primary.Data).AdditionalParts, [`${rootPath}\\Holiday pt2.mp4`]);

  await adapter.delete('/Holiday pt1.mp4');
  await scanner.scan(reference);
  items = await state(database);
  assert.equal(items.length, 1);
  assert.equal(items[0].Path, `${rootPath}\\Holiday pt2.mp4`);
  assert.equal(items[0].OwnerId, null);
  assert.equal(items[0].PrimaryVersionId, null);
  assert.deepEqual(JSON.parse(items[0].Data).AdditionalParts ?? [], []);
});

for (const dialect of ['postgres']) test(`${dialect}: an external reference protects a missing owned part until released`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await scanner.scan(reference);
  const partId = deterministicId('Film cd2.mkv', videoNativeType);
  const referenceId = randomUUID();
  await database.insert('BaseItems', row(referenceId, 'Plugin.Entities.ExternalReference', {
    Name: 'External reference', Path: 'X:\\External\\Reference', SeriesId: partId, IsFolder: false
  }));
  await adapter.delete('/Film cd2.mkv');

  const protectedResult = await scanner.scan(reference);

  assert.equal(protectedResult.structurallyComplete, false);
  assert.ok(protectedResult.incompleteReasons.some(reason =>
    reason.code === folderScanIncompleteReasonCodes.EXTERNAL_REFERENCE_DELETION_SKIPPED
      && idKey(reason.itemId) === idKey(partId)));
  assert.ok((await state(database)).some(item => idKey(item.Id) === idKey(partId)));

  await database.delete('BaseItems', { Id: referenceId });
  const removed = await scanner.scan(reference);
  assert.equal(removed.structurallyComplete, true);
  assert.equal((await state(database)).some(item => idKey(item.Id) === idKey(partId)), false);
});

for (const dialect of ['postgres']) test(`${dialect}: owned-part deletion failure rolls back the declaring path array`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, scanner, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await scanner.scan(reference);
  const before = await state(database);
  const partId = deterministicId('Film cd2.mkv', videoNativeType);
  await adapter.delete('/Film cd2.mkv');
  const restoreDelete = await failBaseItemDelete(database, partId, 'controlled owned-part delete failure');
  try {
    await assert.rejects(scanner.scan(reference), /controlled owned-part delete failure/u);
  } finally {
    await restoreDelete();
  }

  assert.deepEqual(await state(database), before);
  await scanner.scan(reference);
  const after = await state(database);
  assert.equal(after.length, 1);
  assert.deepEqual(JSON.parse(after[0].Data).AdditionalParts ?? [], []);
});
