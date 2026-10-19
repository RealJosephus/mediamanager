import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { refreshLibraryTaskId } from '../../src/tasks/index.js';
import { tmdbUpcomingEpisodesTaskId } from '../../plugins/tmdb/task.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const physicalPath = 'Z:\\LibraryRefresh';

test('Library Refresh queues and replaces the real task while scheduled refresh shares the configured roots', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'library_refresh');
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('library', 'memory', {});
  await adapter.mkdir('/Initial');
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: physicalPath, accessRoot: '/library', style: 'windows', returnAccess: 'library refresh HTTP test' });

  let enterListing, releaseListing;
  const listingEntered = new Promise(resolve => { enterListing = resolve; });
  const listingReleased = new Promise(resolve => { releaseListing = resolve; });
  const listPage = adapter.listPage.bind(adapter);
  let firstListing = true;
  let listingCalls = 0;
  adapter.listPage = async (...args) => {
    listingCalls++;
    if (firstListing) {
      firstListing = false;
      enterListing();
      await listingReleased;
    }
    return listPage(...args);
  };

  const errors = [];
  const programDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'library-refresh-http-'));
  storage.registerType('state-local', options => LocalAdapter.open(options));
  await storage.createInstance('state', 'state-local', { root: programDataPath, writable: true });
  vfs.mount({ path: '/state', instanceId: 'state', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true
  } });
  identityMap.addPrefix({ identityRoot: programDataPath, accessRoot: '/state',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Actual isolated application state.' });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(programDataPath)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(programDataPath).startsWith('library-refresh-http-'));
    await fs.rm(programDataPath, { recursive: true, force: true });
  });
  const runtime = await createRuntime({ database, vfs, identityMap,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [physicalPath, programDataPath] }),
    programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'library-refresh-http-test', onError: error => errors.push(error) });
  try {
    assert.deepEqual(errors, [], 'isolated runtime startup must not report errors');
    const admin = await runtime.users.createUser({ Name: 'Library scan admin', Password: 'password' });
    await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
    await runtime.users.createUser({ Name: 'Library scan reader', Password: 'password' });
    const login = (Username, DeviceId) => runtime.authentication.login({ Username, Pw: 'password' }, {
      Client: 'LibraryRefreshTest', Device: 'Device', DeviceId, Version: '1.0'
    }, { remoteEndPoint: '127.0.0.1' });
    const adminLogin = await login('Library scan admin', 'library-refresh-admin');
    const readerLogin = await login('Library scan reader', 'library-refresh-reader');

    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const refresh = token => fetch(`${origin}/Library/Refresh`, {
      method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` }
    });
    const taskHeaders = token => ({ Authorization: `MediaBrowser Token="${token}"` });

    assert.equal((await refresh(readerLogin.AccessToken)).status, 403);
    assert.equal(listingCalls, 0, 'an unauthorized request must not start scanning');

    assert.equal((await fetch(`${origin}/ScheduledTasks`, { headers: taskHeaders(readerLogin.AccessToken) })).status, 403);
    const tasks = await (await fetch(`${origin}/ScheduledTasks`, { headers: taskHeaders(adminLogin.AccessToken) })).json();
    const refreshTask = tasks.find(task => task.Id === refreshLibraryTaskId);
    assert.ok(refreshTask);
    assert.ok(tasks.some(task => task.Id === tmdbUpcomingEpisodesTaskId));
    assert.equal(refreshTask.Key, 'RefreshLibrary');
    assert.equal(refreshTask.State, 'Idle');
    assert.equal(Object.hasOwn(refreshTask, 'LastExecutionResult'), false);
    const collectionPath = path.join(programDataPath, 'root', 'default', 'Movies');
    await fs.mkdir(collectionPath, { recursive: true });
    await fs.writeFile(path.join(collectionPath, 'movies.collection'), '');
    await fs.writeFile(path.join(collectionPath, 'root.mblink'), physicalPath);

    const completions = [], replaced = Promise.withResolvers();
    runtime.tasks.on('completed', ({ Result }) => {
      if (Result.Id !== refreshLibraryTaskId) return;
      completions.push(Result);
      if (completions.length === 2) replaced.resolve();
    });
    assert.equal((await refresh(adminLogin.AccessToken)).status, 204);
    await Promise.race([listingEntered, delay(2000).then(() => { throw new Error('The configured aggregate scan did not start.'); })]);
    assert.equal(runtime.tasks.get(refreshLibraryTaskId).State, 'Running');

    await adapter.mkdir('/Latest');
    assert.equal((await refresh(adminLogin.AccessToken)).status, 204);
    releaseListing();
    await Promise.race([replaced.promise, delay(30_000, undefined, { ref: false }).then(() => { throw new Error('The replacement task did not finish.'); })]);
    await runtime.metadata.drain();
    assert.deepEqual(completions.map(result => result.Status), ['Cancelled', 'Completed']);

    const paths = (await database.rows('BaseItems')).filter(row => row.Type === 'MediaBrowser.Controller.Entities.Folder')
      .map(row => row.Path).toSorted();
    assert.deepEqual(paths, [physicalPath, `${physicalPath}\\Initial`, `${physicalPath}\\Latest`]);
    assert.ok(listingCalls >= 2, 'the replacement generation enumerated the physical root again');
    const scheduled = once(runtime.tasks, 'completed', { signal: AbortSignal.timeout(30_000) });
    assert.equal((await fetch(`${origin}/ScheduledTasks/Running/${refreshLibraryTaskId}`, {
      method: 'POST', headers: taskHeaders(adminLogin.AccessToken)
    })).status, 204);
    const [{ Result }] = await scheduled;
    assert.equal(Result.Status, 'Completed', Result.ErrorMessage);
    assert.equal(runtime.tasks.get(refreshLibraryTaskId).LastExecutionResult.Status, 'Completed');
    assert.deepEqual(errors, []);
  } finally {
    releaseListing();
    await runtime.close();
    await storage.close();
  }
});
