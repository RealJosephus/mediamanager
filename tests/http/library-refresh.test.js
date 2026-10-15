import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { refreshLibraryTaskId } from '../../src/tasks/index.js';
import { tmdbUpcomingEpisodesTaskId } from '../../plugins/tmdb/task.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const physicalPath = 'Z:\\LibraryRefresh';

test('incomplete Library Refresh is capability-gated while the aggregate coordinator restarts configured roots', {
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
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(programDataPath)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(programDataPath).startsWith('library-refresh-http-'));
    await fs.rm(programDataPath, { recursive: true, force: true });
  });
  const runtime = await createRuntime({ database, vfs, identityMap,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [physicalPath] }),
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
    assert.equal((await refresh(adminLogin.AccessToken)).status, 501);
    assert.equal(listingCalls, 0, 'the incomplete public endpoint must not start scanning');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 501);
    errors.length = 0;

    assert.equal((await fetch(`${origin}/ScheduledTasks`, { headers: taskHeaders(readerLogin.AccessToken) })).status, 403);
    const tasks = await (await fetch(`${origin}/ScheduledTasks`, { headers: taskHeaders(adminLogin.AccessToken) })).json();
    const refreshTask = tasks.find(task => task.Id === refreshLibraryTaskId);
    assert.ok(refreshTask);
    assert.ok(tasks.some(task => task.Id === tmdbUpcomingEpisodesTaskId));
    assert.equal(refreshTask.Key, 'RefreshLibrary');
    assert.equal(refreshTask.State, 'Idle');
    assert.equal(Object.hasOwn(refreshTask, 'LastExecutionResult'), false);
    assert.equal((await fetch(`${origin}/ScheduledTasks/Running/${refreshLibraryTaskId}`, {
      method: 'POST', headers: taskHeaders(adminLogin.AccessToken)
    })).status, 501);
    assert.equal(listingCalls, 0, 'the incomplete scheduled task must not start scanning');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'task-unavailable');
    errors.length = 0;

    const collectionPath = path.join(programDataPath, 'root', 'default', 'Movies');
    await fs.mkdir(collectionPath, { recursive: true });
    await fs.writeFile(path.join(collectionPath, 'movies.collection'), '');
    await fs.writeFile(path.join(collectionPath, 'root.mblink'), physicalPath);

    runtime.libraryScanner.queue();
    await Promise.race([listingEntered, delay(2000).then(() => { throw new Error('The configured aggregate scan did not start.'); })]);

    await adapter.mkdir('/Latest');
    runtime.libraryScanner.queue();
    releaseListing();
    await runtime.libraryScanner.whenIdle();

    const paths = (await database.rows('BaseItems')).filter(row => row.Type === 'MediaBrowser.Controller.Entities.Folder')
      .map(row => row.Path).toSorted();
    assert.deepEqual(paths, [physicalPath, `${physicalPath}\\Initial`, `${physicalPath}\\Latest`]);
    assert.ok(listingCalls >= 2, 'the replacement generation enumerated the physical root again');
    assert.deepEqual(errors, []);
  } finally {
    releaseListing();
    await runtime.close();
    await storage.close();
  }
});
