import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { idKey } from '../../src/library/records.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const enabled = { skip: !postgresTestConnectionString };
const collectionType = 'MediaBrowser.Controller.Entities.CollectionFolder';
async function setup(t) {
  const output = validationOutputRoot(); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'library-structure-http-'));
  const programDataPath = path.join(root, 'program'), dataPath = path.join(programDataPath, 'data'), metadataPath = path.join(programDataPath, 'metadata'), configurationDirectoryPath = path.join(root, 'config');
  const registry = new StorageRegistry(); let database, runtime, origin, headers;
  t.after(async () => {
    const failures = [];
    for (const close of [() => runtime?.close(), () => registry.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('library-structure-http-')); await fs.rm(root, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Library structure HTTP cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true });
  await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><Other>preserved</Other><ContentTypes/></ServerConfiguration>');
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {});
  for (const name of ['Movies','Additional']) { await adapter.mkdir('/' + name); await adapter.write('/' + name + '/Present.txt', Buffer.from(name), { overwrite: true }); }
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/remote', instanceId: 'media', capabilities: {} });
  const identityRoot = 'Z:\\LibraryStructureMedia', identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot, accessRoot: '/remote', style: 'windows', returnAccess: 'isolated library structure test' });
  const mediaPath = identityRoot + '\\Movies', additionalPath = identityRoot + '\\Additional';
  const configuration = { UICulture: 'zh-CN', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true, BaseUrl: '/media',
    ContentTypes: [{ Name: additionalPath, Value: 'homevideos' }, { Name: identityRoot, Value: 'movies' }] }, errors = [];
  database = await createPostgresTestDatabase(null, 'library_structure');
  const open = async () => {
    runtime = await createRuntime({ database, configuration, programDataPath, dataPath, metadataPath, configurationDirectoryPath, vfs, identityMap, autoDiscoveryOptions: { enabled: false },
      serverId: 'library-structure-http', onError: error => errors.push(error) });
    runtime.libraryConfiguration.sleep = async () => {};
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${runtime.server.address().port}/media`;
  };
  await open();
  headers = { Authorization: `MediaBrowser Token="${(await runtime.apiKeys.create('Library structure HTTP')).AccessToken}"` };
  const request = async (suffix, { method = 'POST', body, authHeaders = headers, language = 'zh-CN' } = {}) => {
    const response = await fetch(origin + suffix, { method, headers: { ...authHeaders, 'Accept-Language': language, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let value = text; try { value = JSON.parse(text); } catch { }
    return { status: response.status, body: value, language: response.headers.get('content-language') };
  };
  const list = async () => (await request('/Library/VirtualFolders', { method: 'GET' })).body;
  const create = async name => request('/Library/VirtualFolders?name=' + encodeURIComponent(name) + '&collectionType=movies', {
    body: { LibraryOptions: { PreferredMetadataLanguage: 'zh-CN', PathInfos: [{ Path: mediaPath }] } } });
  return { root, programDataPath, dataPath, metadataPath, configurationDirectoryPath, mediaPath, additionalPath, configuration, adapter, errors, request, list, create,
    get database() { return database; }, get runtime() { return runtime; }, async reopen() {
      const schema = database.schemaName; await runtime.close();
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await open();
    } };
}

test('postgres: library structure HTTP preserves options, shortcuts, deferred rename identity, media and restart', enabled, async t => {
  const state = await setup(t);
  assert.equal((await state.create('Movies')).status, 204);
  const original = (await state.list())[0]; assert.ok(original.ItemId); assert.equal(original.CollectionType, 'movies');
  assert.equal((await state.request('/Library/VirtualFolders/Paths', { body: { Name: 'Movies', Path: 'ignored', PathInfo: { Path: state.additionalPath } } })).status, 204);
  const options = (await state.list())[0].LibraryOptions;
  assert.deepEqual(options.PathInfos, [{ Path: state.mediaPath }, { Path: state.additionalPath }]);
  assert.deepEqual(state.configuration.ContentTypes, [{ Name: 'Z:\\LibraryStructureMedia', Value: 'movies' }]);
  assert.equal((await state.request('/Library/VirtualFolders/Paths/Update', { body: { Name: 'Movies', PathInfo: { Path: 'Z:\\Unmapped\\Ignored' } } })).status, 204);
  assert.deepEqual((await state.list())[0].LibraryOptions.PathInfos, options.PathInfos);
  const requested = { ...options, Enabled: false, PathInfos: [{ Path: state.mediaPath }, { Path: state.additionalPath }, { Path: state.additionalPath }] };
  assert.equal((await state.request('/Library/VirtualFolders/LibraryOptions', { body: { Id: original.ItemId, LibraryOptions: requested } })).status, 204);
  const directory = path.join(state.programDataPath, 'root', 'default', 'Movies');
  // Existing paths are compared against the initial options, so duplicate
  // already-present paths do not create additional shortcuts.
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.mblink')).length, 2);
  assert.equal((await state.list())[0].LibraryOptions.Enabled, false);
  assert.equal((await state.request('/Library/VirtualFolders/Name?name=Movies&newName=Renamed')).status, 204);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  const renamed = (await state.list())[0]; assert.equal(renamed.Name, 'Renamed'); assert.equal(Object.hasOwn(renamed, 'ItemId'), false);
  const beforeScan = await state.database.rows('BaseItems', { where: { Type: collectionType } });
  assert.deepEqual(beforeScan.map(row => idKey(row.Id)), [original.ItemId]);
  await state.runtime.libraryScanLifecycle.validateTopLibraryFolders({ removeRoot: true });
  const current = (await state.list())[0]; assert.ok(current.ItemId); assert.notEqual(current.ItemId, original.ItemId);
  assert.deepEqual(current.LibraryOptions.PathInfos, requested.PathInfos); assert.equal(current.LibraryOptions.Enabled, false);
  await state.reopen();
  assert.deepEqual((await state.list())[0], current);
  assert.equal((await state.request('/Library/VirtualFolders?name=Renamed', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await state.list(), []);
  assert.equal((await state.adapter.stat('/Movies/Present.txt')).kind, 'file'); assert.equal((await state.adapter.stat('/Additional/Present.txt')).kind, 'file');
  assert.match(await fs.readFile(path.join(state.configurationDirectoryPath, 'system.xml'), 'utf8'), /preserved/);
  assert.deepEqual(state.errors, []);
});

test('postgres: library structure authorization, product identity and API messages are independent of request language', enabled, async t => {
  const state = await setup(t);
  const viewer = await state.runtime.users.createUser({ Name: 'Viewer', Password: 'Isolated fixture password' });
  const user = await state.runtime.users.getUser(viewer.Id); await state.runtime.users.updatePolicy(viewer.Id, { ...user.Policy, IsAdministrator: false });
  const login = await state.runtime.authentication.login({ Username: 'Viewer', Pw: 'Isolated fixture password' },
    { Client: 'MediaManager fixture', Device: 'Isolated', DeviceId: 'library-structure-viewer', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
  const viewerHeaders = { Authorization: `MediaBrowser Token="${login.AccessToken}"` };
  assert.equal((await state.request('/Library/VirtualFolders?refreshLibrary=invalid', { authHeaders: {} })).status, 401);
  assert.equal((await state.request('/Library/VirtualFolders?refreshLibrary=invalid', { authHeaders: viewerHeaders })).status, 403);
  state.configuration.IsStartupWizardCompleted = false;
  assert.equal((await state.request('/Library/VirtualFolders', { method: 'GET', authHeaders: {} })).status, 200);
  state.configuration.IsStartupWizardCompleted = true;
  for (const language of ['en-US','zh-CN']) {
    const info = await state.request('/System/Info/Public', { method: 'GET', language });
    assert.equal(info.status, 200); assert.equal(info.body.ProductName, 'MediaManager'); assert.equal(info.body.ServerName, 'MediaManager'); assert.equal(info.language, 'en-US');
    assert.equal((await state.request('/System/Ping', { method: 'GET', language })).body, 'MediaManager');
    assert.equal((await state.request('/Localization/Options', { method: 'GET', language })).body.length, 1);
    assert.equal(state.runtime.localization.text('TaskRefreshLibrary'), 'Scan Media Library');
  }
  assert.equal(state.runtime.authentication.serverName, 'MediaManager'); assert.equal(state.runtime.autoDiscovery.serverName, 'MediaManager');
});

test('postgres: library path failure retains options and monitor work, while close drains admitted background work', enabled, async t => {
  const state = await setup(t); assert.equal((await state.create('Movies')).status, 204);
  const started = Promise.withResolvers(), release = Promise.withResolvers(); let monitorStarted = false;
  state.runtime.libraryConfiguration.sleep = async () => { started.resolve(); await release.promise; };
  state.runtime.libraryMonitor.start = async () => { monitorStarted = true; };
  const failure = () => { throw new Error('Controlled library options event failure.'); };
  state.runtime.libraryOptionsStore.on('updated', failure);
  try {
  const response = await state.request('/Library/VirtualFolders/Paths', { body: { Name: 'Movies', Path: state.additionalPath } });
  assert.equal(response.status, 500); await started.promise;
  const listing = (await state.list())[0]; assert.deepEqual(listing.LibraryOptions.PathInfos, [{ Path: state.mediaPath }, { Path: state.additionalPath }]);
  assert.equal(await fs.readFile(path.join(state.programDataPath, 'root', 'default', 'Movies', 'Additional.mblink'), 'utf8'), state.additionalPath);
  state.runtime.libraryOptionsStore.off('updated', failure);
  let closed = false; const closing = state.runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(monitorStarted, false);
  await assert.rejects(state.runtime.libraryConfiguration.addMediaPath('Movies', { Path: state.additionalPath }), { status: 503 });
  release.resolve(); await closing; assert.equal(monitorStarted, true); assert.equal(closed, true);
  assert.equal(state.errors.filter(error => error.message === 'Controlled library options event failure.').length, 1);
  } finally { state.runtime.libraryOptionsStore.off('updated', failure); release.resolve(); }
});

test('postgres: library options failures preserve shortcut prefixes without publishing new options', enabled, async t => {
  const state = await setup(t); assert.equal((await state.create('Movies')).status, 204);
  const folder = (await state.list())[0], options = { ...defaultLibraryOptions(), PathInfos: [{ Path: state.mediaPath }, { Path: state.additionalPath }, null] };
  const response = await state.request('/Library/VirtualFolders/LibraryOptions', { body: { Id: folder.ItemId, LibraryOptions: options } });
  assert.equal(response.status, 500);
  assert.equal(await fs.readFile(path.join(state.programDataPath, 'root', 'default', 'Movies', 'Additional.mblink'), 'utf8'), state.additionalPath);
  assert.deepEqual((await state.list())[0].LibraryOptions.PathInfos, [{ Path: state.mediaPath }]);
  assert.equal((await state.request('/Library/VirtualFolders/LibraryOptions', { body: { Id: 'ca200000000000000000000000000099', LibraryOptions: {} } })).status, 404);
  assert.equal((await state.request('/Library/VirtualFolders/LibraryOptions', { body: { Id: '00000000000000000000000000000000', LibraryOptions: {} } })).status, 400);
});
