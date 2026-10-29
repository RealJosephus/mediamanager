import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
async function setup(t) {
  const output = validationOutputRoot(); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'library-mutations-runtime-'));
  const programDataPath = path.join(root, 'program'), configurationDirectoryPath = path.join(root, 'config'),
    dataPath = path.join(programDataPath, 'data'), metadataPath = path.join(programDataPath, 'metadata');
  const registry = new StorageRegistry(); let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const close of [() => runtime?.close(), () => registry.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('library-mutations-runtime-'));
      await fs.rm(root, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Library mutation fixture cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true });
  await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><Other>retained</Other><ContentTypes/></ServerConfiguration>');
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {});
  for (const name of ['Movies', 'Additional']) {
    await adapter.mkdir('/' + name); await adapter.write('/' + name + '/Present.txt', Buffer.from(name), { overwrite: true });
  }
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/remote', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap(), identityRoot = 'Z:\\LibraryMutationMedia';
  identityMap.addPrefix({ identityRoot, accessRoot: '/remote', style: 'windows', returnAccess: 'isolated mutation fixture' });
  registry.registerType('state-local', options => LocalAdapter.open(options));
  await registry.createInstance('state', 'state-local', { root, writable: true });
  vfs.mount({ path: '/state', instanceId: 'state', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true
  } });
  identityMap.addPrefix({ identityRoot: root, accessRoot: '/state',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual isolated application state.' });
  database = await createPostgresTestDatabase(null, 'lib_mutations_runtime');
  const configuration = { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, IsStartupWizardCompleted: true,
    ContentTypes: [{ Name: identityRoot + '\\Additional', Value: 'homevideos' }, { Name: identityRoot, Value: 'movies' }] }, errors = [];
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  runtime = await createTestRuntime({ database, registry, vfs, identityMap, programDataPath, configurationDirectoryPath,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots: [identityRoot, root] }),
    dataPath, metadataPath, configuration, serverId: 'library-mutations-runtime', onError: error => errors.push(error) });
  runtime.libraryConfiguration.sleep = async milliseconds => assert.equal(milliseconds, 1000);
  const mediaPath = identityRoot + '\\Movies', additionalPath = identityRoot + '\\Additional';
  await runtime.libraryConfiguration.addVirtualFolder('Movies', 'movies', { ...defaultLibraryOptions(),
    PreferredMetadataLanguage: 'zh-CN', PathInfos: [{ Path: mediaPath }] });
  const folder = (await runtime.libraryConfiguration.getVirtualFolders())[0];
  return { root, runtime, database, programDataPath, configurationDirectoryPath, dataPath, metadataPath, adapter,
    configuration, errors, mediaPath, additionalPath, folder, directory: path.join(programDataPath, 'root', 'default', 'Movies') };
}

test('postgres: library path mutations share live options, defer structural reconciliation and survive restart', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), { runtime, database, folder, additionalPath, mediaPath, configuration } = state;
  const options = folder.LibraryOptions;
  const before = await database.rows('BaseItems', { where: { Type: collectionType } });
  await runtime.libraryConfiguration.addMediaPath('Movies', { Path: additionalPath });
  let listing = (await runtime.libraryConfiguration.getVirtualFolders())[0];
  assert.deepEqual(listing.LibraryOptions, options);
  assert.deepEqual(runtime.library.options.libraryOptions.get(folder.ItemId), options);
  assert.deepEqual(options.PathInfos, [{ Path: mediaPath }, { Path: additionalPath }]);
  assert.deepEqual(new Set(listing.Locations), new Set([mediaPath, additionalPath]));
  assert.deepEqual(await database.rows('BaseItems', { where: { Type: collectionType } }), before);
  assert.deepEqual(configuration.ContentTypes, [{ Name: 'Z:\\LibraryMutationMedia', Value: 'movies' }]);
  assert.match(await fs.readFile(path.join(state.configurationDirectoryPath, 'system.xml'), 'utf8'), /<Other>retained<\/Other>/);
  await runtime.libraryConfiguration.updateMediaPath('Movies', { Path: 'Z:\\Unmapped\\Ignored' });
  assert.deepEqual(options.PathInfos, [{ Path: mediaPath }, { Path: additionalPath }]);
  await runtime.libraryScanLifecycle.validateTopLibraryFolders();
  const physical = await database.rows('BaseItems', { where: { Path: additionalPath } });
  assert.equal(physical.length, 1);
  const persisted = await database.rows('BaseItems', { where: { Type: collectionType } });
  assert.equal(idKey(persisted[0].Id), folder.ItemId);
  assert.ok(persisted[0].Data.includes('Additional'));
  await runtime.libraryConfiguration.removeMediaPath('Movies', additionalPath);
  assert.deepEqual(options.PathInfos, [{ Path: mediaPath }]);
  assert.deepEqual((await runtime.libraryConfiguration.getVirtualFolders())[0].Locations, [mediaPath]);
  await runtime.libraryOptionsStore.clear();
  listing = (await runtime.libraryConfiguration.getVirtualFolders())[0];
  assert.deepEqual(listing.LibraryOptions.PathInfos, [{ Path: mediaPath }]);
  assert.equal(listing.LibraryOptions.PreferredMetadataLanguage, 'zh-CN');
  await runtime.close();
  const reopenedDatabase = await PostgresDatabase.open({
    connectionString: postgresTestConnectionString, schema: database.schemaName });
  let reopened;
  try {
    reopened = await createTestRuntime({ database: reopenedDatabase, registry: new StorageRegistry(),
      programDataPath: state.programDataPath, configurationDirectoryPath: state.configurationDirectoryPath,
      dataPath: state.dataPath, metadataPath: state.metadataPath, configuration, serverId: 'library-mutations-runtime-reopen' });
    const current = (await reopened.libraryConfiguration.getVirtualFolders())[0];
    assert.equal(current.ItemId, folder.ItemId); assert.deepEqual(current.Locations, [mediaPath]);
    assert.deepEqual(current.LibraryOptions.PathInfos, [{ Path: mediaPath }]);
  } finally { if (reopened) await reopened.close(); else await reopenedDatabase.close(); }
});

test('postgres: virtual library removal keeps media and defers database cleanup unless refresh was requested', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), { runtime, database, folder, mediaPath, adapter } = state;
  await runtime.libraryConfiguration.removeVirtualFolder('Movies', false);
  assert.deepEqual(await runtime.libraryConfiguration.getVirtualFolders(), []);
  await assert.rejects(fs.stat(state.directory), { code: 'ENOENT' });
  const retained = await database.rows('BaseItems', { where: { Type: collectionType } });
  assert.equal(retained.length, 1); assert.equal(idKey(retained[0].Id), folder.ItemId);
  const published = runtime.library.options.libraryOptions.get(folder.ItemId);
  assert.deepEqual(published, defaultLibraryOptions());
  assert.equal((await adapter.stat('/Movies/Present.txt')).kind, 'file');
  await runtime.libraryConfiguration.addVirtualFolder('Movies', 'movies', { ...defaultLibraryOptions(), PathInfos: [{ Path: mediaPath }] });
  const completion = once(runtime.tasks, 'completed', { signal: AbortSignal.timeout(60_000) });
  await runtime.libraryConfiguration.removeVirtualFolder('Movies', true);
  const [{ Result }] = await completion;
  assert.deepEqual(await runtime.libraryConfiguration.getVirtualFolders(), []);
  assert.deepEqual(await database.rows('BaseItems', { where: { Type: collectionType } }), []);
  assert.equal((await adapter.stat('/Movies/Present.txt')).kind, 'file');
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
  assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
});

test('postgres: late option failure preserves admitted shortcut and content-type cleanup without structural writes', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), { runtime, database, folder, mediaPath, additionalPath } = state;
  const before = await database.rows('BaseItems', { where: { Type: collectionType } });
  const failure = () => { throw new Error('Controlled options observer failure.'); };
  runtime.libraryOptionsStore.on('updated', failure);
  try { await assert.rejects(runtime.libraryConfiguration.addMediaPath('Movies', { Path: additionalPath }), /Controlled options observer failure/); }
  finally { runtime.libraryOptionsStore.off('updated', failure); }
  const listing = (await runtime.libraryConfiguration.getVirtualFolders())[0];
  assert.deepEqual(listing.LibraryOptions.PathInfos, [{ Path: mediaPath }, { Path: additionalPath }]);
  assert.deepEqual(listing.LibraryOptions, folder.LibraryOptions);
  assert.deepEqual(new Set(listing.Locations), new Set([mediaPath, additionalPath]));
  assert.deepEqual(await database.rows('BaseItems', { where: { Type: collectionType } }), before);
  await runtime.libraryOptionsStore.clear();
  assert.deepEqual((await runtime.libraryConfiguration.getVirtualFolders())[0].LibraryOptions.PathInfos, [{ Path: mediaPath }, { Path: additionalPath }]);
});

test('postgres: runtime close drains admitted path mutations and rejects subsequent calls', { skip: !postgresTestConnectionString }, async t => {
  const { runtime, additionalPath, directory, database } = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  runtime.libraryConfiguration.fileSystem = { ...fs, writeFile: async (...args) => {
    if (args[0].endsWith('Additional.mblink')) { entered.resolve(); await release.promise; }
    return fs.writeFile(...args);
  } };
  const pending = runtime.libraryConfiguration.addMediaPath('Movies', { Path: additionalPath }); await entered.promise;
  const closing = runtime.close();
  try {
    await assert.rejects(runtime.libraryConfiguration.updateMediaPath('Movies', { Path: additionalPath }), { status: 503 });
    await assert.rejects(runtime.libraryConfiguration.removeVirtualFolder('Movies'), { status: 503 });
  } finally { release.resolve(); await pending; await closing; }
  assert.equal(database.closed, true);
  assert.equal(await fs.readFile(path.join(directory, 'Additional.mblink'), 'utf8'), additionalPath);
  assert.match(await fs.readFile(path.join(directory, 'options.xml'), 'utf8'), /Additional/);
});
