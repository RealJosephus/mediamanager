import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { getNewItemId } from '../../src/core/identity.js';
import { idKey } from '../../src/library/records.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
async function setup(t) {
  const parent = validationOutputRoot(); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'library-configuration-runtime-')), programDataPath = path.join(root, 'program'),
    configurationDirectoryPath = path.join(root, 'config'), dataPath = path.join(root, 'data'), metadataPath = path.join(root, 'metadata');
  const registry = new StorageRegistry(); let database, runtime;
  t.after(async () => {
    const errors = [];
    for (const close of [() => runtime?.close(), () => registry.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('library-configuration-runtime-')); await fs.rm(root, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Library configuration fixture cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true }); await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><Other>preserved</Other><ContentTypes/></ServerConfiguration>');
  registry.registerType('memory', options => new MemoryStorageAdapter(options)); const adapter = await registry.createInstance('media', 'memory', {});
  await adapter.mkdir('/Movies'); await adapter.write('/Movies/Present.txt', Buffer.from('remote fixture'), { overwrite: true });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/remote', instanceId: 'media', capabilities: {} });
  const mediaPath = path.join(root, 'media', 'Movies'), identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: mediaPath, accessRoot: '/remote/Movies',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'runtime content-type ancestry fixture' });
  registry.registerType('state-local', options => LocalAdapter.open(options));
  await registry.createInstance('state', 'state-local', { root, writable: true });
  vfs.mount({ path: '/state', instanceId: 'state', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true
  } });
  identityMap.addPrefix({ identityRoot: root, accessRoot: '/state',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual isolated application state.' });
  database = await createPostgresTestDatabase(null, 'lib_config_runtime'); const errors = [];
  const configuration = { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, IsStartupWizardCompleted: true,
    ContentTypes: [{ Name: mediaPath, Value: 'homevideos' }, { Name: path.join(mediaPath, 'Child'), Value: 'tvshows' }, { Name: path.dirname(mediaPath), Value: 'movies' }] };
  runtime = await createTestRuntime({ database, registry, vfs, identityMap, programDataPath, configurationDirectoryPath, dataPath, metadataPath,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots: [mediaPath, root] }),
    configuration, serverId: 'library-configuration-runtime', onError: error => errors.push(error) });
  return { runtime, database, root, programDataPath, configurationDirectoryPath, dataPath, mediaPath, configuration, errors };
}

test('postgres: virtual library creation binds options before refresh and persists VFS locations, shared folders and content types', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), { runtime, database, mediaPath, configuration } = state;
  runtime.libraryConfiguration.sleep = async milliseconds => assert.equal(milliseconds, 1000);
  const options = { ...defaultLibraryOptions(), PreferredMetadataLanguage: 'zh-CN', PathInfos: [{ Path: mediaPath }] };
  const pathName = path.join(state.programDataPath, 'root', 'default', 'Movies'), id = getNewItemId(pathName, collectionType, { programDataPath: state.programDataPath, enableCaseSensitiveItemIds: true });
  const original = runtime.topLevelValidation.loadContext; let boundBeforeRefresh = false;
  runtime.topLevelValidation.loadContext = Object.assign(async (reference, contextOptions) => {
    if (idKey(reference) === id) { assert.deepEqual(runtime.library.options.libraryOptions.get(id), options);
      assert.equal(runtime.library.options.libraryOptions.get(id).PreferredMetadataLanguage, 'zh-CN'); boundBeforeRefresh = true; }
    return original(reference, contextOptions);
  }, original);
  await runtime.libraryConfiguration.addVirtualFolder('Movies', 'movies', options, false);
  assert.equal(boundBeforeRefresh, true);
  let folders = await runtime.libraryConfiguration.getVirtualFolders(true);
  assert.equal(folders.length, 1); assert.equal(folders[0].ItemId, id); assert.deepEqual(folders[0].LibraryOptions, options); assert.deepEqual(folders[0].Locations, [mediaPath]); assert.equal(folders[0].RefreshStatus, 'Idle');
  const savedOptions = await fs.readFile(path.join(pathName, 'options.xml'));
  await runtime.libraryOptionsStore.clear();
  assert.deepEqual(await runtime.libraryOptionsStore.get(pathName), options, 'The complete options reload from their actual XML before the later refresh operations.');
  assert.deepEqual(await fs.readFile(path.join(pathName, 'options.xml')), savedOptions);
  const rows = await database.rows('BaseItems', { where: { Type: collectionType } }); assert.equal(rows.length, 1); assert.equal(idKey(rows[0].Id), id);
  assert.deepEqual(configuration.ContentTypes, [{ Name: path.dirname(mediaPath), Value: 'movies' }]);
  assert.match(await fs.readFile(path.join(state.configurationDirectoryPath, 'system.xml'), 'utf8'), /<Other>preserved<\/Other>/);
  await runtime.libraryConfiguration.addVirtualFolder('Movies', 'movies', { ...defaultLibraryOptions(), PathInfos: [{ Path: mediaPath }] }, false);
  folders = await runtime.libraryConfiguration.getVirtualFolders(true); assert.deepEqual(folders.map(folder => folder.Name), ['Movies', 'Movies2']);
  const physical = await database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Folder', Path: mediaPath } }); assert.equal(physical.length, 1);
  runtime.refreshes.reportStarted({ Id: rows[0].Id }); runtime.refreshes.reportProgress({ Id: rows[0].Id }, 43);
  assert.equal((await runtime.libraryConfiguration.getVirtualFolders(true))[0].RefreshStatus, 'Active'); runtime.refreshes.reportCompleted({ Id: rows[0].Id });
  const started = Promise.withResolvers(), release = Promise.withResolvers(), refresh = runtime.metadata.refresh.bind(runtime.metadata);
  runtime.metadata.refresh = async (...args) => { started.resolve(); await release.promise; return refresh(...args); };
  const first = runtime.metadata.queue(rows[0].Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }); await started.promise;
  const second = runtime.metadata.queue(rows[0].Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  try { assert.equal((await runtime.libraryConfiguration.getVirtualFolders(true))[0].RefreshStatus, 'Queued'); }
  finally { release.resolve(); await Promise.all([first, second]); runtime.metadata.refresh = refresh; }
  assert.equal((await runtime.libraryConfiguration.getVirtualFolders(true))[0].RefreshStatus, 'Idle');
  const completion = once(runtime.tasks, 'completed', { signal: AbortSignal.timeout(60_000) });
  await runtime.libraryConfiguration.addVirtualFolder('Queued', null, defaultLibraryOptions(), true);
  const [{ Result }] = await completion;
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
  assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
  assert.deepEqual(state.errors, []);
});

test('postgres: runtime close drains admitted library writes before closing their option and metadata dependencies', { skip: !postgresTestConnectionString }, async t => {
  const { runtime, programDataPath, database, errors } = await setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  runtime.libraryConfiguration.sleep = async () => {};
  runtime.libraryConfiguration.fileSystem = { ...fs, writeFile: async (...args) => {
    if (args[0].endsWith('.collection')) { entered.resolve(); await release.promise; } return fs.writeFile(...args);
  } };
  const pending = runtime.libraryConfiguration.addVirtualFolder('Admitted', 'boxsets', defaultLibraryOptions(), false); await entered.promise;
  const closing = runtime.close();
  try {
    await assert.rejects(runtime.libraryConfiguration.addVirtualFolder('Late', null, defaultLibraryOptions()), { status: 503 });
    await runtime.libraryOptionsStore.get(path.join(programDataPath, 'root', 'default', 'Admitted'));
  } finally { release.resolve(); await pending; await closing; }
  assert.equal(database.closed, true);
  assert.deepEqual(errors, [], 'admitted root validation must finish before its metadata dependencies close');
  assert.equal(await fs.readFile(path.join(programDataPath, 'root', 'default', 'Admitted', 'boxsets.collection'), 'utf8'), '');
});

test('postgres: user-root state uses the declared Windows or POSIX identity path while preserving portable deterministic IDs', { skip: !postgresTestConnectionString }, async t => {
  const database = await createPostgresTestDatabase(t, 'lib_config_paths'), store = new DomainStore(database);
  const roots = ['Z:\\NativeState', '/var/lib/native-state']; const ids = [];
  for (const root of roots) {
    const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'portable-root', programDataPath: root });
    await store.run(db => library.load(db, null, { includeUserData: false, baseRows: [] }), { readOnly: true });
    assert.equal(library.options.userRoot.Path, root.startsWith('/') ? root + '/root/default' : root + '\\root\\default');
    assert.equal(library.options.userRoot.Name, 'default'); ids.push(library.options.userRoot.Id);
    await library.close();
  }
  assert.equal(ids[0], ids[1]); assert.deepEqual(await database.rows('BaseItems'), []);
});

test('postgres: constructor rollback closes library configuration after initialization and keeps state files intact', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t); await state.runtime.close();
  const database = await createPostgresTestDatabase(t, 'lib_config_rollback'), close = LibraryConfigurationService.prototype.close; let captured;
  LibraryConfigurationService.prototype.close = function () { captured = this; return close.call(this); };
  try { await assert.rejects(createTestRuntime({ database, programDataPath: state.programDataPath, configurationDirectoryPath: state.configurationDirectoryPath,
    configuration: { UICulture: 'en-US' }, serverId: 'rollback', autoDiscoveryOptions: false }), /autoDiscoveryOptions/); }
  finally { LibraryConfigurationService.prototype.close = close; }
  assert.ok(captured); await assert.rejects(captured.getVirtualFolders(), { status: 503 }); assert.equal(database.closed, true);
  assert.match(await fs.readFile(path.join(state.configurationDirectoryPath, 'system.xml'), 'utf8'), /preserved/);
});
