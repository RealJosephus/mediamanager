import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { PluginHost } from '../../src/plugins/host.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';

test('runtime closes every resource after an actual HLS cache initialization failure and preserves all errors', {
  skip: !postgresTestConnectionString,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-runtime-close-')), cacheDirectory = path.join(directory, 'cache-is-a-file');
  const database = await createPostgresTestDatabase(null, 'runtime_close');
  const registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  await registry.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true } });
  await vfs.write('/fixture/probe.bin', Buffer.from('isolated probe bytes'));
  await writeFile(cacheDirectory, 'Preserve this existing file.');
  let runtime, expectedCloseError;
  t.after(async () => {
    try {
      if (runtime) await runtime.close().catch(error => { if (error !== expectedCloseError) throw error; });
      else await database.close();
    } finally {
      try { await dropPostgresTestDatabase(database); }
      finally {
        await registry.close(); assert.equal(path.dirname(directory), os.tmpdir());
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  runtime = await createRuntime({ database, configuration: { UICulture: 'en-US' }, serverId: 'runtime-close',
    programDataPath: path.join(directory, 'program-data'),
    vfs, identityMap: new IdentityAccessMap(), hlsOptions: { cacheDirectory } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const lease = await runtime.probe.bridge.lease('/fixture/probe.bin');
  assert.equal(await (await fetch(lease.url)).text(), 'isolated probe bytes');
  let initializeError;
  await assert.rejects(runtime.hls.initialize(), error => { initializeError = error; return ['EEXIST', 'ENOTDIR'].includes(error.code); });

  const scanCloseStarted = {
    tasks: Promise.withResolvers(),
    library: Promise.withResolvers(),
    folder: Promise.withResolvers()
  };
  for (const [name, owner, peer] of [
    ['tasks', runtime.tasks, 'folder'],
    ['library', runtime.libraryScanner, 'folder'],
    ['folder', runtime.folderScanner, 'tasks']
  ]) {
    const original = owner.close.bind(owner);
    owner.close = async () => {
      scanCloseStarted[name].resolve();
      await scanCloseStarted[peer].promise;
      return original();
    };
  }

  const closed = [];
  const resources = [
    ['splashscreen', runtime.splashscreen, 'close'],
    ['branding', runtime.branding, 'close'],
    ['libraryConfiguration', runtime.libraryConfiguration, 'close'],
    ['saver.stop', runtime.metadata.saver, 'stop'], ['metadata', runtime.metadata, 'close'],
    ['saver.dispose', runtime.metadata.saver, 'dispose'], ['libraryOptionsStore', runtime.libraryOptionsStore, 'close'],
    ['webSockets', runtime.webSockets, 'close'], ['hls', runtime.hls, 'close'],
    ['images', runtime.images, 'close'], ['imageProcessor', runtime.imageProcessor, 'close'], ['extraction', runtime.extraction, 'close'],
    ['remux', runtime.remux, 'close'], ['probe', runtime.probe, 'close'], ['sessions', runtime.sessions, 'close'], ['plugins', runtime.plugins, 'close'], ['store', runtime.store, 'close'],
  ];
  const processorError = new Error('Synthetic error after the image processor released its resources.');
  for (const [name, resource, method] of resources) {
    const original = resource[method].bind(resource);
    resource[method] = async (...args) => {
      closed.push(name); await original(...args);
      if (name === 'imageProcessor') throw processorError;
    };
  }
  const closing = runtime.close();
  assert.equal(runtime.close(), closing, 'Concurrent close callers share the same cleanup operation.');
  await Promise.race([
    Promise.all(Object.values(scanCloseStarted).map(started => started.promise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Scan owners were not closed concurrently.')), 1000))
  ]);
  await assert.rejects(closing, error => {
    expectedCloseError = error;
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [initializeError, processorError]); return true;
  });
  assert.deepEqual([...new Set(closed)], resources.map(([name]) => name));
  const completed = [...closed];
  assert.equal(runtime.server.listening, false);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(fetch(lease.url, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(runtime.probe.bridge.start(), { code: 'closed' });
  await assert.rejects(runtime.images.info('unused'), { name: 'AbortError' });
  await assert.rejects(runtime.imageProcessor.process({}), { name: 'AbortError' });
  await assert.rejects(database.rows('Users'), /not open|closed/i);
  assert.equal(await readFile(cacheDirectory, 'utf8'), 'Preserve this existing file.');
  await assert.rejects(runtime.close(), error => error === expectedCloseError);
  assert.deepEqual(closed, completed, 'A repeated close does not invoke database or resource disposal twice.');
});

test('runtime construction failure rolls back the database and never starts persisted startup triggers', {
  skip: !postgresTestConnectionString,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-runtime-rollback-'));
  const programDataPath = path.join(directory, 'data');
  const taskDirectory = path.join(directory, 'config', 'ScheduledTasks');
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, '7738148f-fcd0-7979-c7ce-b148e06b3aed.js'),
    '[{"Type":"StartupTrigger"}]');
  const database = await createPostgresTestDatabase(null, 'runtime_rollback');
  const registry = new StorageRegistry();
  registry.registerType('memory', () => new MemoryStorageAdapter());
  await registry.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const errors = [];
  let ownershipTransfers = 0;
  t.after(async () => {
    await registry.close();
    await dropPostgresTestDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(createRuntime({
    database,
    configuration: { UICulture: 'en-US' },
    serverId: 'runtime-construction-rollback',
    programDataPath,
    vfs,
    identityMap: new IdentityAccessMap(),
    extractionOptions: { timeoutMs: 0 },
    onDatabaseOwnershipTransferred() { ownershipTransfers += 1; },
    onError: error => errors.push(error)
  }), /timeoutMs must be a positive safe integer/u);
  assert.equal(ownershipTransfers, 1, 'construction rollback owns the database after the explicit transfer point');
  await assert.rejects(database.rows('Users'), /not open|closed/iu);
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.deepEqual(errors, [], 'the persisted StartupTrigger was never armed by the incomplete runtime');
});

test('construction rollback cancels an admitted metadata provider before draining its scheduler worker', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-runtime-provider-rollback-'));
  const database = await createPostgresTestDatabase(null, 'runtime_provider', { max: 1 });
  const entered = Promise.withResolvers(), releaseProvider = Promise.withResolvers(), rollbackDeadline = Promise.withResolvers();
  const startupFailure = new Error('Controlled failure after the final initialization admitted a provider.');
  let services, worker, workerSettled, workerActive = false, providerCleanup, providerSignal, timer;
  const originalConnect = PluginHost.prototype.connect;
  t.mock.method(PluginHost.prototype, 'connect', async function (value) {
    await originalConnect.call(this, value);
    services = value;
    // Injection occurs at the real final initialization boundary, after the
    // runtime has registered its rollback owners and constructed the monitor.
    services.tasks.initialize = async () => {
      const root = await services.libraryScanHost.getAggregateFolder();
      services.metadata.registry.register({ id: 'construction-rollback-provider', name: 'Construction rollback provider', providers: [{
        id: 'construction-rollback', name: 'Construction rollback', kind: 'custom', itemTypes: [root.Type],
        supports: item => item.Id === root.Id,
        async fetch(item, { signal }) {
          const aborted = Promise.withResolvers();
          const onAbort = () => aborted.resolve();
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          providerSignal = signal;
          entered.resolve();
          try {
            await Promise.race([aborted.promise, releaseProvider.promise]);
            signal.throwIfAborted();
          } finally {
            signal.removeEventListener('abort', onAbort);
            const rows = await services.store.run(db => db.rows('BaseItems', { where: { Id: item.Id } }), { readOnly: true });
            providerCleanup = { cancelled: signal.aborted, workerActive, databaseClosed: database.closed, rows: rows.length };
          }
        }
      }] });
      const sequence = { async count() { return 1; }, async *pages() { yield [root]; } };
      worker = services.libraryTaskScheduler.enqueue(sequence, async item => {
        workerActive = true;
        try { await services.metadata.refresh(item.Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' }); }
        finally { workerActive = false; }
      }, { onError() {} });
      workerSettled = Promise.allSettled([worker]);
      await Promise.race([entered.promise, worker.then(() => {
        throw new Error('The scheduler worker completed without entering the controlled metadata provider.');
      })]);
      timer = setTimeout(() => rollbackDeadline.reject(new Error('Construction rollback waited for an uncancelled scheduler provider.')), 20000);
      throw startupFailure;
    };
  });
  let constructionSettled;
  t.after(async () => {
    releaseProvider.resolve();
    if (constructionSettled) await constructionSettled;
    try { await dropPostgresTestDatabase(database); }
    finally {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('mediamanager-runtime-provider-rollback-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  try {
    const construction = createRuntime({ database, programDataPath: path.join(directory, 'data'),
      configuration: { UICulture: 'en-US', LibraryScanFanoutConcurrency: 1 }, serverId: 'runtime-provider-rollback' });
    constructionSettled = Promise.allSettled([construction]);
    await assert.rejects(Promise.race([construction, rollbackDeadline.promise]), error => error === startupFailure);
    assert.equal(providerSignal.aborted, true);
    assert.deepEqual(providerCleanup, { cancelled: true, workerActive: true, databaseClosed: false, rows: 1 });
    assert.equal((await workerSettled)[0].status, 'fulfilled', 'The real scheduler finished and released its worker after provider cancellation.');
    assert.equal(workerActive, false);
    assert.equal(database.closed, true);
    await assert.rejects(database.rows('BaseItems'), /not open|closed/iu);
  } finally {
    clearTimeout(timer);
    // Restore progress on the broken ordering too, so a failed assertion does
    // not strand rollback and the fixture's database cleanup.
    releaseProvider.resolve();
    if (constructionSettled) await constructionSettled;
  }
});

test('library root initialization failure closes the database once and preserves the original error', {
  skip: !postgresTestConnectionString,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-runtime-root-failure-'));
  const programDataPath = path.join(directory, 'program-data-is-a-file');
  await writeFile(programDataPath, 'not a directory');
  const database = await createPostgresTestDatabase(null, 'runtime_root');
  try {
    await assert.rejects(createRuntime({
      database,
      configuration: { UICulture: 'en-US' },
      serverId: 'runtime-root-failure',
      programDataPath
    }), error => {
      assert.equal(error instanceof AggregateError, false);
      // Windows can reach the explicit ancestor guard after ENOENT; POSIX
      // lstat rejects the child of that same ordinary file with ENOTDIR.
      const rejectedPath = typeof error.path === 'string' ? path.relative(programDataPath, error.path) : null;
      assert.ok(error instanceof TypeError && /physical directories/u.test(error.message)
        || error.code === 'ENOTDIR' && rejectedPath !== null && !path.isAbsolute(rejectedPath)
          && rejectedPath !== '..' && !rejectedPath.startsWith('..' + path.sep), error.stack);
      return true;
    });
    assert.equal(await readFile(programDataPath, 'utf8'), 'not a directory');
    await assert.rejects(database.rows('Users'), /not open|closed/iu);
  } finally {
    try { await database.close(); }
    catch { /* Construction rollback already owns the database. */ }
    await dropPostgresTestDatabase(database);
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime without application paths serves users without starting a library directory monitor', {
  skip: !postgresTestConnectionString,
}, async () => {
  const database = await createPostgresTestDatabase(null, 'runtime_no_root');
  let runtime;
  try {
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US' }, serverId: 'runtime-no-root' });
    assert.equal(runtime.libraryMonitor, undefined);
    assert.equal(runtime.libraryMonitorHost, undefined);
    assert.equal(runtime.storageReadiness.ready, true);
    assert.deepEqual(await database.rows('BaseItems'), [], 'Rootless construction must not synthesize a persistent media root.');
    const user = await runtime.users.createUser({ Name: 'Rootless User' });
    assert.equal((await runtime.users.getUser(user.Id)).Username, 'Rootless User');
    await runtime.close();
    await assert.rejects(database.rows('Users'), /not open|closed/iu);
  } finally {
    try { if (runtime) await runtime.close(); else await database.close(); }
    finally { await dropPostgresTestDatabase(database); }
  }
});

test('runtime validates application paths before taking ownership of the database', {
  skip: !postgresTestConnectionString,
}, async () => {
  const database = await createPostgresTestDatabase(null, 'runtime_paths');
  let ownershipTransfers = 0;
  try {
    await assert.rejects(createRuntime({
      database,
      configuration: { UICulture: 'en-US' },
      serverId: 'relative-path-rejected',
      programDataPath: 'relative-instance-data',
      onDatabaseOwnershipTransferred() { ownershipTransfers += 1; }
    }), /programDataPath must be an absolute path/u);
    assert.equal(ownershipTransfers, 0);
    assert.deepEqual(await database.rows('Users'), [], 'preflight rejection leaves the caller-owned database open');
  } finally {
    await database.close();
    await dropPostgresTestDatabase(database);
  }
});
