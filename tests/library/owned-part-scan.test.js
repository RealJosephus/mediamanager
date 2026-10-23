import { testFileSystem } from '../storage/plugin-files.js';
import { failBaseItemDelete } from '../database/postgres-faults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createOwnedFolderValidationFixture, ownedStatePaths, ownedRefreshOptions, withoutSaveTime } from '../helpers/owned-folder-validation-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { LibraryService } from '../../src/library/library-service.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
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
const stackInputFile = new URL('./fixtures/post-scan-composition/stack-replacement-input.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceJson = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
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
  let library, validationFixture, lifecycleFixture, referenceOwner, rootOwner;
  t.after(async () => {
    referenceOwner?.release(); rootOwner?.release(); await validationFixture?.close(); await lifecycleFixture?.close();
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
  const [userRoot] = await database.rows('BaseItems', { where: { Id: userRootId } });
  library = new LibraryService({fileSystem: testFileSystem, ...await ownedStatePaths(t), store, programDataPath,
    userRoot, serverId: 'owned-part-scan' });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] });
  ignoreRule.normalizePath = true;
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule });
  const resolverPipeline = new DirectoryItemResolverPipeline({
    programDataPath,
    resolvers: [createVideoFileResolver()]
  });
  validationFixture = createOwnedFolderValidationFixture({
    ignoreRule,
    store,
    library,
    vfs,
    identityMap,
    refreshes: new ProviderRefreshService(),
    programDataPath,
    resolverPipeline,
    lifecycleFixture, configuration: { LibraryScanFanoutConcurrency: 1 }
  });
  const { validation, itemCreation, metadata, errors } = validationFixture;
  const reference = await itemCreation.getItemById(rootId);
  referenceOwner = itemCreation.retainItem(reference);
  return { database, library, adapter, vfs, validation, metadata, errors, reference };
}

async function state(database) {
  return (await database.rows('BaseItems')).filter(value => [movieNativeType, videoNativeType].includes(value.Type))
    .map(withoutSaveTime)
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
    assert.equal(part.ParentId, null, 'cross-type owned parts retain the native five-field construction');
    assert.equal(part.TopParentId, null);
    assert.equal(part.PrimaryVersionId, null);
    assert.equal(part.ExtraType, null);
  }
  return primary;
}

function stackProjection(stages, directory, parentId) {
  const api = /^[A-Za-z]:[\\/]/u.test(directory) ? path.win32 : path.posix;
  const relative = value => {
    const result = api.relative(directory, value);
    assert.ok(result && !result.startsWith('..') && !api.isAbsolute(result), `stack path is inside the observed media directory: ${value}`);
    return result.replaceAll('\\', '/');
  };
  const identities = new Map([[idKey(parentId), '$PARENT']]);
  for (const stage of stages) for (const row of stage.sql.BaseItems) {
    if ([movieNativeType, videoNativeType].includes(row.Type)) identities.set(idKey(row.Id), row.Type + ':' + relative(row.Path));
  }
  const identity = value => !nonemptyId(value) ? null : identities.get(idKey(value)) ?? idKey(value);
  return stages.map(stage => ({ name: stage.name, failed: stage.exception != null, files: stage.files,
    items: stage.sql.BaseItems.filter(row => [movieNativeType, videoNativeType].includes(row.Type)).map(row => {
      const data = JSON.parse(row.Data ?? '{}');
      return { identity: identity(row.Id), Name: row.Name, OwnerId: identity(row.OwnerId), ParentId: identity(row.ParentId),
        TopParentId: identity(row.TopParentId), PrimaryVersionId: identity(row.PrimaryVersionId),
        IsInMixedFolder: Boolean(row.IsInMixedFolder), ExtraType: row.ExtraType,
        AdditionalParts: (data.AdditionalParts ?? []).map(relative),
        LocalAlternateVersions: (data.LocalAlternateVersions ?? []).map(relative) };
    }).sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0),
    links: stage.sql.LinkedChildren.filter(link => identities.has(idKey(link.ParentId)) && idKey(link.ParentId) !== idKey(parentId))
      .map(link => ({ parent: identity(link.ParentId), child: identity(link.ChildId), type: Number(link.ChildType), order: Number(link.SortOrder) }))
      .sort((left, right) => left.parent < right.parent ? -1 : left.parent > right.parent ? 1 : left.order - right.order)
  }));
}

for (const dialect of ['postgres']) test(`${dialect}: movie stack replacement matches actual native owned persistence`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000
}, async t => {
  const input = await readFile(stackInputFile), scenario = JSON.parse(input)[0];
  const output = path.join(validationOutputRoot(), 'owned-stack-replacement-' + randomUUID());
  const receipt = await recordOracle({ project: 'tests/library/fixtures/post-scan-composition/Oracle.csproj', output,
    args: [fileURLToPath(stackInputFile), '{output}/native.json', '{output}/cases'] });
  const bytes = await readFile(path.join(output, 'native.json')), native = parseLosslessJson(bytes.toString('utf8'));
  assert.equal(native.inputSha256, hash(input));
  assert.equal(receipt.outputs.find(file => path.basename(file.filename) === 'native.json').sha256, hash(bytes));
  assert.ok(native.assemblies.some(assembly => assembly.name === 'jellyfin' && assembly.sha256 === receipt.jellyfinDll.sha256));
  assert.equal(native.results.length, 1);
  const expected = native.results[0];
  assert.equal(expected.Name, scenario.Name);
  assert.equal(expected.controls.collectionType, 'movies');
  for (const collection of ['metadataProviders', 'imageProviders', 'metadataSavers']) assert.deepEqual(expected.controls[collection], []);
  for (const service of ['MediaBrowser.Providers.Movies.MovieMetadataService', 'MediaBrowser.Providers.Videos.VideoMetadataService']) {
    assert.ok(expected.controls.metadataServices.includes(service));
  }
  assert.equal(expected.release.completed, true);
  const { database, adapter, vfs, validation, metadata, errors, reference } = await fixture(t, dialect);
  const stages = [];
  for (const step of scenario.StackReplacement.Steps) {
    for (const name of step.Write ?? []) {
      const value = Buffer.from(name);
      await adapter.write('/' + name, value);
    }
    for (const name of step.Delete ?? []) await adapter.delete('/' + name);
    let exception = null;
    try {
      if (step.RefreshBeforeScan) {
        const owner = (await state(database)).find(item => item.Type === movieNativeType);
        assert.ok(owner, 'the actual persisted primary exists before its explicit owned refresh');
        await metadata.refresh(owner.Id, ownedRefreshOptions);
      }
      await validation.validateChildren(reference, ownedRefreshOptions);
    } catch (error) { exception = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
    const sql = {};
    for (const table of Object.keys(expected.stages[0].sql.result)) sql[table] = await database.rows(table);
    const files = [];
    for (const file of (await vfs.list('/movies')).entries) {
      assert.equal(file.kind, 'file');
      const handle = await vfs.openRead('/movies/' + file.name, { ifMatch: file.version });
      try {
        const digest = createHash('sha256');
        for await (const bytes of handle.stream) digest.update(bytes);
        files.push({ name: file.name, sha256: digest.digest('hex') });
      } finally { await handle.close(); }
    }
    stages.push({ name: step.Name, exception, sql,
      errors: errors.splice(0).map(error => ({ name: error.name, code: error.code, message: error.message, stack: error.stack })),
      files: files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0) });
    await writeFile(path.join(output, 'candidate.json'), evidenceJson({ directory: rootPath, stages }));
  }
  const actualProjection = stackProjection(stages, rootPath, rootId);
  const nativeProjection = stackProjection(expected.stages.map(stage => ({ name: stage.Name, exception: stage.exception,
    files: stage.files, sql: stage.sql.result })), expected.directory, expected.parentId);
  await writeFile(path.join(output, 'comparison.json'), evidenceJson({ actual: actualProjection, native: nativeProjection }));
  assert.deepEqual(actualProjection, nativeProjection,
    'compare real source files, persisted owned declarations, entity rows and version relations; full SQL/errors are retained separately');
});
for (const dialect of ['postgres']) test(`${dialect}: weak snapshots preserve an existing owned-part family`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, vfs, validation, metadata, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const before = await state(database);
  await adapter.delete('/Film cd2.mkv');
  const list = vfs.list.bind(vfs);
  vfs.list = async (path, options) => ({ ...await list(path, options), consistency: 'weak', snapshot: null, deletionSafe: false });
  await assert.rejects(validation.validateChildren(reference, ownedRefreshOptions), { code: 'not-supported' });
  assert.deepEqual(await state(database), before);
  vfs.list = list;
  await metadata.refresh(before.find(item => item.Type === movieNativeType).Id, ownedRefreshOptions);
  await validation.validateChildren(reference, ownedRefreshOptions);
  const after = await state(database);
  assert.equal(after.length, 1);
  assert.deepEqual(JSON.parse(after[0].Data).AdditionalParts, []);
});

for (const dialect of ['postgres']) test(`${dialect}: owned-part insertion failure retains the independently saved owner declaration`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const before = await state(database);
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  const insert = database.insert.bind(database);
  database.insert = async (table, values) => {
    if (table === 'BaseItems' && values.Type === videoNativeType && values.OwnerId != null) {
      throw new Error('controlled owned-part insert failure');
    }
    return insert(table, values);
  };
  try { await validation.validateChildren(reference, ownedRefreshOptions); }
  finally { database.insert = insert; }
  assert.ok(errors.some(error => /controlled owned-part insert failure/u.test(error.message)));
  const failed = await state(database);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].Id, before[0].Id);
  assert.deepEqual(JSON.parse(failed[0].Data).AdditionalParts, [`${rootPath}\\Film cd2.mkv`]);
  assert.equal((await adapter.stat('/Film cd2.mkv')).kind, 'file');
  await validation.validateChildren(reference, ownedRefreshOptions);
  assertStack(await state(database), 'Film cd1.mkv', ['Film cd2.mkv']);
});

for (const dialect of ['postgres']) test(`${dialect}: each stacked movie version persists its own parts through cold reads and repeat scans`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, library, adapter, validation, errors, reference } = await fixture(t, dialect);
  for (const name of ['Film - Director cd1.mkv', 'Film - Director cd2.mkv',
    'Film - Theatrical cd1.mkv', 'Film - Theatrical cd2.mkv']) {
    await adapter.write(`/${name}`, Buffer.from(name));
  }
  await validation.validateChildren(reference, ownedRefreshOptions);
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
    assert.equal(ownedPart.ParentId, null);
    assert.equal(ownedPart.TopParentId, null);
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
    assert.ok(!nonemptyId(coldPart.ParentId));
  }
  const repeated = await validation.validateChildren(reference, ownedRefreshOptions);
  assert.equal(repeated.created.length, 0);
  assert.deepEqual(await state(database), items);
});

for (const dialect of ['postgres']) test(`${dialect}: home-video stack promotion reuses the Video identity safely`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, errors, reference } = await fixture(t, dialect, 'homevideos');
  await adapter.write('/Holiday pt1.mp4', Buffer.from('one'));
  await adapter.write('/Holiday pt2.mp4', Buffer.from('two'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  let items = await state(database);
  const primary = items.find(item => item.Path === `${rootPath}\\Holiday pt1.mp4`);
  const part = items.find(item => item.Path === `${rootPath}\\Holiday pt2.mp4`);
  assert.equal(primary.Type, videoNativeType);
  assert.equal(part.Type, videoNativeType);
  assert.equal(primary.OwnerId, null);
  assert.equal(idKey(part.OwnerId), idKey(primary.Id));
  assert.deepEqual(JSON.parse(primary.Data).AdditionalParts, [`${rootPath}\\Holiday pt2.mp4`]);

  await adapter.delete('/Holiday pt1.mp4');
  await validation.validateChildren(reference, ownedRefreshOptions);
  items = await state(database);
  assert.equal(items.length, 1);
  assert.equal(items[0].Path, `${rootPath}\\Holiday pt2.mp4`);
  assert.equal(items[0].OwnerId, null);
  assert.equal(items[0].PrimaryVersionId, null);
  assert.deepEqual(JSON.parse(items[0].Data).AdditionalParts ?? [], []);
});

for (const dialect of ['postgres']) test(`${dialect}: an informational series reference does not own a missing part`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, metadata, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const partId = deterministicId('Film cd2.mkv', videoNativeType);
  const referenceId = randomUUID();
  await database.insert('BaseItems', row(referenceId, 'Plugin.Entities.ExternalReference', {
    Name: 'External reference', Path: 'X:\\External\\Reference', SeriesId: partId, IsFolder: false
  }));
  await adapter.delete('/Film cd2.mkv');

  const owner = (await state(database)).find(item => item.Type === movieNativeType);
  await metadata.refresh(owner.Id, ownedRefreshOptions);
  assert.deepEqual(errors, []);
  assert.equal((await state(database)).some(item => idKey(item.Id) === idKey(partId)), false);
  assert.equal((await database.rows('BaseItems', { where: { Id: referenceId } }))[0].SeriesId, partId,
    'SeriesId has no native FK or ownership semantics; the unrelated row is retained');
});

for (const dialect of ['postgres']) test(`${dialect}: owned-part deletion failure leaves its row and declaration available for a later refresh`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, validation, metadata, errors, reference } = await fixture(t, dialect);
  await adapter.write('/Film cd1.mkv', Buffer.from('one'));
  await adapter.write('/Film cd2.mkv', Buffer.from('two'));
  await validation.validateChildren(reference, ownedRefreshOptions);
  const before = await state(database);
  const partId = deterministicId('Film cd2.mkv', videoNativeType);
  await adapter.delete('/Film cd2.mkv');
  const restoreDelete = await failBaseItemDelete(database, partId, 'controlled owned-part delete failure');
  try {
    await metadata.refresh(before.find(item => item.Type === movieNativeType).Id, ownedRefreshOptions);
    assert.ok(errors.some(error => /controlled owned-part delete failure/u.test(error.message)));
  } finally {
    await restoreDelete();
  }

  const failed = await state(database);
  assert.ok(failed.some(item => idKey(item.Id) === idKey(partId)));
  assert.deepEqual(JSON.parse(failed.find(item => item.Type === movieNativeType).Data).AdditionalParts,
    [`${rootPath}\\Film cd2.mkv`]);
  await metadata.refresh(before.find(item => item.Type === movieNativeType).Id, ownedRefreshOptions);
  await validation.validateChildren(reference, ownedRefreshOptions);
  const after = await state(database);
  assert.equal(after.length, 1);
  assert.deepEqual(JSON.parse(after[0].Data).AdditionalParts ?? [], []);
});
