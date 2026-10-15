import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { StorageError } from '../../src/storage/errors.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

const ids = { aggregate: 'a7400000-0000-0000-0000-000000000001', root: 'a7400000-0000-0000-0000-000000000002',
  userRoot: 'a7400000-0000-0000-0000-000000000003', collection: 'a7400000-0000-0000-0000-000000000004',
};
const identityRoot = 'Z:\\Movies\\Film';
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const row = (Id, type, values = {}) => ({ ...blank, Id, Type: 'MediaBrowser.Controller.Entities.' + type,
  Name: type, IsFolder: true, Data: '{}', ...values });

async function fixture(t, dialect, { knownAncestors = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-ignore-runtime-'));
  const programDataPath = path.join(directory, 'data');
  const movieId = nativeGuid(getNewItemId(identityRoot + '\\Film.mkv', 'MediaBrowser.Controller.Entities.Movies.Movie', { programDataPath }));
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES, schema = 'scan_ignore_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const registry = new StorageRegistry(); let runtime;
  t.after(async () => {
    if (runtime) await runtime.close(); else await database.close();
    await registry.close();
    if (dialect === 'postgres') {
      const cleanup = await PostgresDatabase.open({ connectionString, schema });
      try { await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`); await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); }
      finally { await cleanup.close(); }
    }
    await rm(directory, { recursive: true });
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {}), vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'Controlled runtime media namespace' });
  const ignoreIdentityMap = knownAncestors
    ? await knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots: [identityRoot] }) : identityMap;
  await adapter.write('/Film.mkv', Buffer.from('controlled ordinary media'));
  await adapter.write('/Film-trailer.mkv', Buffer.from('controlled trailer'));
  await database.insert('BaseItems', row(ids.aggregate, 'AggregateFolder'));
  await database.insert('BaseItems', row(ids.userRoot, 'UserRootFolder'));
  await database.insert('BaseItems', row(ids.root, 'Folder', { Path: identityRoot, ParentId: ids.aggregate, TopParentId: ids.root }));
  await database.insert('BaseItems', row(ids.collection, 'CollectionFolder', { ParentId: ids.userRoot,
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.root], PhysicalLocationsList: [identityRoot] }) }));
  await database.insert('BaseItems', row(movieId, 'Movies.Movie', { Name: 'Film', IsFolder: false, MediaType: 'Video',
    Path: identityRoot + '\\Film.mkv', ParentId: ids.root, TopParentId: ids.root, Data: '{"VideoType":"VideoFile"}' }));
  runtime = await createRuntime({ database, vfs, identityMap, ignoreIdentityMap, programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'scan-ignore-runtime',
    libraryOptions: new Map([[ids.collection.replaceAll('-', ''), { EnableInternetProviders: false, SaveLocalMetadata: false }]]) });
  const structuralBaselines = [], refreshItem = runtime.folderScanner.metadataScanner.refreshItem.bind(runtime.folderScanner.metadataScanner);
  runtime.folderScanner.metadataScanner.refreshItem = async (...args) => {
    const result = await refreshItem(...args);
    structuralBaselines.push(await database.rows('BaseItems'));
    return result;
  };
  return { database, adapter, vfs, runtime, identityMap, ignoreIdentityMap, movieId, structuralBaselines };
}

for (const dialect of ['postgres']) for (const mode of ['success', 'failure', 'cancel']) {
  test(`${dialect}: runtime shares ignore discovery and clears scan directory caches after ${mode}`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, async t => {
    const { database, adapter, runtime, movieId, structuralBaselines } = await fixture(t, dialect), rule = runtime.ignoreRule;
    assert.equal(runtime.folderScanner.ignoreRule, rule);
    assert.equal(runtime.folderValidation.ignoreRule, rule);
    assert.equal(runtime.folderValidation.metadataScanner, runtime.metadataScanner);
    assert.equal(runtime.folderScanner.metadataScanner, runtime.metadataScanner);
    assert.equal(runtime.folderValidation.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.folderScanner.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.itemDeletion.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.library.folderValidation, runtime.folderValidation);
    const loaded = await runtime.metadata.loadContext(movieId);
    assert.equal(loaded.videoVersionDiscovery.ignoreRule, rule);
    const state = await runtime.store.run(async db => runtime.library.load(db, null, {
      includeUserData: false,
      baseRows: await db.rows('BaseItems'),
    }));
    assert.equal((await loaded.findOwnedExtras(state)).extras.length, 1, 'extra discovery primes this same runtime cache');
    assert.ok(rule.directoryCache.size > 0);
    await adapter.write('/.ignore', Buffer.from('*.mkv'));
    assert.equal(await rule.shouldIgnore(identityRoot + '\\Film.mkv'), false, 'native cached absence lasts until directory cache clear');
    const controller = new AbortController(), trace = [];
    const clear = rule.clearDirectoryCache.bind(rule), roots = runtime.library.getPhysicalScanRoots.bind(runtime.library);
    rule.clearDirectoryCache = () => { trace.push('clear'); clear(); };
    runtime.library.getPhysicalScanRoots = async options => {
      trace.push('roots'); assert.equal(rule.directoryCache.size, 0, 'the cache clears before root discovery'); return roots(options);
    };
    const shouldIgnore = rule.shouldIgnore.bind(rule); let intercepted = false;
    rule.shouldIgnore = async (identityPath, options) => {
      const ignored = await shouldIgnore(identityPath, options);
      if (mode !== 'success' && !intercepted) {
        intercepted = true; assert.ok(options.signal); assert.equal(options.signal.aborted, false);
        if (mode === 'failure') throw new StorageError('permission-denied', 'controlled ignore resolution failure');
        controller.abort();
      }
      return ignored;
    };
    if (mode === 'success') {
      const result = await runtime.libraryScanner.runCompleteScan(); assert.equal(result.completedRootCount, 1);
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
    } else {
      await assert.rejects(runtime.libraryScanner.runCompleteScan({ signal: controller.signal }), {
        code: mode === 'failure' ? 'permission-denied' : 'cancelled'
      });
      assert.deepEqual(await database.rows('BaseItems'), structuralBaselines.at(-1),
        'the native root metadata save precedes enumeration; ignore errors and cancellation do not mutate subsequent structure');
    }
    assert.deepEqual(trace, ['clear', 'roots', 'clear']);
    assert.equal(rule.directoryCache.size, 0);
    assert.equal(rule.rulesCache.size, 1, 'directory cache clears retain parsed rules');
  });
}

for (const dialect of ['postgres']) test(`${dialect}: runtime rejects an unknown ignore ancestor before scanning changes`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, runtime, identityMap, structuralBaselines } = await fixture(t, dialect, { knownAncestors: false });
  assert.equal(runtime.ignoreRule.identityMap, identityMap);
  await assert.rejects(runtime.libraryScanner.runCompleteScan(), { code: 'ignore-search-unmapped', status: 501 });
  assert.deepEqual(await database.rows('BaseItems'), structuralBaselines.at(-1));
  assert.equal(runtime.ignoreRule.directoryCache.size, 0);
});

for (const dialect of ['postgres']) test(`${dialect}: runtime validates new children with inherited library content type`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const { database, adapter, runtime, movieId } = await fixture(t, dialect);
  await database.delete('BaseItems', { Id: movieId });
  await adapter.delete('/Film-trailer.mkv');
  const parent = await runtime.itemCreation.getItemById(ids.root);
  const added = [];
  runtime.library.on('ItemAdded', event => added.push(event.Item));

  const result = await runtime.library.validateChildren(parent, { refreshChildMetadata: false });

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].Type, 'Movie');
  assert.equal(result.created[0].Id, movieId);
  assert.equal(result.created[0].ParentId, parent.Id);
  assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 1);
  assert.deepEqual(added, result.created);
  assert.equal((await runtime.library.validateChildren(parent, { refreshChildMetadata: false })).created.length, 0);
  assert.equal(added.length, 1);
});
