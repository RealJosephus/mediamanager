import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000 };
const identityRoot = 'Z:\\MonitorRuntime';
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };

async function until(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 20000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'library-monitor-runtime-'));
  let database, runtime, expectedCloseError;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [async () => {
      try { await runtime?.close(); } catch (error) { if (error !== expectedCloseError) throw error; }
    }, () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith('library-monitor-runtime-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Monitor runtime fixture cleanup failed.');
  });
  const programDataPath = path.join(root, 'state'), media = path.join(root, 'media');
  const alternateMedia = path.join(root, 'alternate-media'), knownAncestors = path.join(root, 'known-ancestors');
  const collection = path.join(programDataPath, 'root', 'default', 'Watched');
  for (const directory of [collection, media, alternateMedia, knownAncestors]) await mkdir(directory, { recursive: true });
  await mkdir(path.join(media, 'Existing'));
  await writeFile(path.join(collection, 'location.mblink'), identityRoot);
  await writeFile(path.join(collection, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>true</EnableRealtimeMonitor>'
    + '<SaveLocalMetadata>false</SaveLocalMetadata></LibraryOptions>');
  const storageConfiguration = path.join(root, 'storage.json');
  await writeFile(storageConfiguration, JSON.stringify({
    instances: [{ id: 'media', type: 'local', config: { root: media, writable: true } },
      { id: 'known-ancestors', type: 'local', config: { root: knownAncestors } }],
    mounts: [{ path: '/media', instanceId: 'media', capabilities }, { path: '/known-ancestors', instanceId: 'known-ancestors', capabilities: {} }],
    prefixes: [{ identityRoot, accessRoot: '/media', style: 'windows', caseSensitive: false,
      returnAccess: 'The isolated media identity stays stable when its local storage root changes.', purpose: 'library' }],
    ignorePrefixes: [{ identityRoot: 'Z:\\', accessRoot: '/known-ancestors', style: 'windows',
      returnAccess: 'Ancestors of this isolated identity namespace are known empty directories.' }]
  }));
  database = await createPostgresTestDatabase(null, 'monitor_runtime', { max: 1 });
  const errors = [];
  runtime = await createRuntime({ database, programDataPath, storageConfiguration, serverId: 'monitor-runtime',
    configuration: { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, LibraryMonitorDelay: 0, LibraryScanFanoutConcurrency: 1 },
    onError: error => errors.push(error) });
  assert.equal(runtime.storageReadiness.ready, true);
  assert.ok(runtime.library.listeners('ItemAdded').includes(runtime.libraryMonitor.onItemAdded),
    'A successfully constructed runtime subscribes its monitor before returning.');
  await runtime.libraryScanLifecycle.validateTopLibraryFolders();
  await runtime.libraryMonitor.stop();

  const watches = [], starts = new Set();
  const watch = runtime.libraryMonitorHost.watchPath.bind(runtime.libraryMonitorHost);
  runtime.libraryMonitorHost.watchPath = async (identity, options) => {
    const owner = await watch(identity, options);
    if (!owner) return owner;
    const record = { identity, options, closed: false, closeFailure: null, beforeClose: null };
    watches.push(record);
    for (const pending of starts) if (pending.identity === identity && watches.length > pending.after) pending.resolve(record);
    return { async close() {
      await record.beforeClose?.();
      record.closed = true;
      await owner.close();
      if (record.closeFailure) throw record.closeFailure;
    } };
  };
  const nextWatch = (identity = identityRoot) => {
    const completion = Promise.withResolvers(), pending = { identity, after: watches.length, resolve: completion.resolve };
    starts.add(pending);
    return until(completion.promise, 'The runtime did not establish the expected local storage watcher.')
      .finally(() => starts.delete(pending));
  };
  const start = nextWatch();
  await runtime.libraryMonitor.start();
  await start;
  const rows = identity => runtime.store.run(db => db.rows('BaseItems', { where: { Path: identity } }), { readOnly: true });
  return { root, media, alternateMedia, database, runtime, errors, watches, nextWatch, rows,
    expectCloseError(error) { expectedCloseError = error; } };
}

async function addDirectory(f, name, media = f.media) {
  const identity = identityRoot + '\\' + name, created = Promise.withResolvers();
  const listener = event => { if (event.Item.Path === identity) created.resolve(event.Item.Id); };
  f.runtime.library.on('ItemAdded', listener);
  try {
    await mkdir(path.join(media, name));
    const id = await until(created.promise, `No library item was created for the actual filesystem event: ${name}. Diagnostics: ${f.errors.map(error => error.message).join('; ')}`);
    await f.runtime.metadata.drain();
    const rows = await f.rows(identity);
    assert.equal(rows.length, 1); assert.equal(rows[0].Id, id);
    assert.equal(rows[0].Type, 'MediaBrowser.Controller.Entities.Folder');
    assert.ok(rows[0].DateLastRefreshed, 'The shared queue ran metadata refresh after child creation.');
    return rows[0];
  } finally { f.runtime.library.off('ItemAdded', listener); }
}

test('postgres: runtime storage events reach metadata and folder validation, and monitor stop/start owns its watches', pg, async t => {
  const f = await fixture(t);
  await addDirectory(f, 'AddedByWatcher');
  const active = f.watches.filter(record => !record.closed);
  assert.ok(active.some(record => record.identity === identityRoot));
  await f.runtime.libraryMonitor.stop();
  assert.ok(active.every(record => record.closed));
  assert.equal(f.runtime.library.listeners('ItemAdded').includes(f.runtime.libraryMonitor.onItemAdded), false);
  await mkdir(path.join(f.media, 'CreatedWhileStopped'));
  assert.deepEqual(await f.rows(identityRoot + '\\CreatedWhileStopped'), []);
  const restarted = f.nextWatch();
  await f.runtime.libraryMonitor.start();
  await restarted;
  await addDirectory(f, 'AddedAfterRestart');
  assert.equal((await f.rows(identityRoot + '\\CreatedWhileStopped')).length, 1,
    'The next real event reconciles the directory contents accumulated while monitoring was stopped.');
});

test('postgres: reconfiguring storage closes old watches and refreshes the same identity from the replacement root', pg, async t => {
  const f = await fixture(t), previous = f.watches.filter(record => !record.closed);
  const closing = Promise.withResolvers(), releaseClose = Promise.withResolvers();
  const oldWatch = previous.find(record => record.identity === identityRoot);
  assert.ok(oldWatch);
  oldWatch.beforeClose = async () => { closing.resolve(); await releaseClose.promise; };
  const definition = f.runtime.storage.configuration();
  definition.instances.find(instance => instance.id === 'media').config.root = f.alternateMedia;
  const restarted = f.nextWatch();
  const changing = f.runtime.storage.configure(definition);
  // Observe failures immediately while the deliberate close barrier is held.
  const changed = Promise.allSettled([changing]);
  try {
    await until(closing.promise, 'Storage did not stop its previous monitor generation before swapping roots.');
    assert.equal(f.runtime.storage.configuration().instances.find(instance => instance.id === 'media').config.root, f.media);
    assert.equal((await f.runtime.storage.vfs.stat('/media/Existing')).kind, 'directory',
      'The previous mapping remains live until its watcher finishes closing.');
  } finally { releaseClose.resolve(); }
  const [outcome] = await changed;
  if (outcome.status === 'rejected') throw outcome.reason;
  await restarted;
  assert.equal(f.runtime.storageReadiness.ready, true);
  assert.ok(previous.every(record => record.closed));
  await mkdir(path.join(f.media, 'OldStorageOnly'));
  await addDirectory(f, 'NewStorageOnly', f.alternateMedia);
  assert.deepEqual(await f.rows(identityRoot + '\\OldStorageOnly'), [],
    'A preserved identity cannot read its previous storage root after reconfiguration.');
});

test('postgres: a before-change cleanup failure is diagnosed while storage still transfers ownership and restarts monitoring', pg, async t => {
  const f = await fixture(t);
  const failure = new Error('Controlled stopped-watcher cleanup failure.');
  f.watches.find(record => !record.closed && record.identity === identityRoot).closeFailure = failure;
  const definition = f.runtime.storage.configuration();
  definition.instances.find(instance => instance.id === 'media').config.root = f.alternateMedia;
  const restarted = f.nextWatch();
  await f.runtime.storage.configure(definition);
  await restarted;
  const includes = error => error === failure || error instanceof AggregateError && error.errors.some(includes);
  assert.ok(f.errors.some(includes), 'The before-change failure is preserved as a diagnostic.');
  assert.equal(f.runtime.storage.configuration().instances.find(instance => instance.id === 'media').config.root, f.alternateMedia);
  await addDirectory(f, 'AfterFailedOldWatchCleanup', f.alternateMedia);
});

test('postgres: runtime close cancels an admitted provider and releases database ownership after a watcher close failure', pg, async t => {
  const f = await fixture(t), entered = Promise.withResolvers();
  const closeFailure = new Error('Controlled watcher cleanup failure after releasing its actual handle.');
  f.watches.find(record => !record.closed && record.identity === identityRoot).closeFailure = closeFailure;
  f.runtime.metadata.registry.register({ id: 'monitor-shutdown-provider', name: 'Monitor shutdown provider', providers: [{
    id: 'monitor-shutdown', name: 'Monitor shutdown', kind: 'custom', itemTypes: ['Folder'],
    supports: item => item.Path === identityRoot,
    async fetch(_item, { signal }) {
      entered.resolve(signal);
      signal.throwIfAborted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }] });
  const [root] = await f.rows(identityRoot);
  assert.ok(root);
  const queued = f.runtime.metadata.queue(root.Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', IsAutomated: true });
  const settled = Promise.allSettled([queued]);
  const signal = await until(entered.promise, 'The admitted metadata provider did not start.');
  const closing = f.runtime.close();
  assert.equal(f.runtime.close(), closing);
  await assert.rejects(until(closing, 'Runtime cleanup did not complete.'), error => {
    f.expectCloseError(error);
    const includes = value => value === closeFailure || value instanceof AggregateError && value.errors.some(includes);
    assert.ok(includes(error)); return true;
  });
  assert.equal(signal.aborted, true);
  assert.equal((await settled)[0].status, 'rejected');
  assert.ok(f.watches.every(record => record.closed));
  assert.equal(f.runtime.library.listeners('ItemAdded').includes(f.runtime.libraryMonitor.onItemAdded), false);
  assert.equal(f.database.closed, true);
  await assert.rejects(f.database.rows('BaseItems'), /not open|closed/iu);
});

test('postgres: runtime close cancels a watched child provider before waiting for its scheduler worker', pg, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), releaseProvider = Promise.withResolvers();
  const identity = identityRoot + '\\ShutdownChild', activeWorkerPaths = new Set();
  const enqueue = f.runtime.libraryTaskScheduler.enqueue.bind(f.runtime.libraryTaskScheduler);
  f.runtime.libraryTaskScheduler.enqueue = (sequence, worker, options) => enqueue(sequence, async (item, progress) => {
    activeWorkerPaths.add(item.Path);
    try { return await worker(item, progress); }
    finally { activeWorkerPaths.delete(item.Path); }
  }, options);
  let saverStopped = false, providerCleanup;
  const stopSaver = f.runtime.metadata.saver.stop.bind(f.runtime.metadata.saver);
  f.runtime.metadata.saver.stop = async () => { saverStopped = true; return stopSaver(); };
  f.runtime.metadata.registry.register({ id: 'monitor-child-shutdown-provider', name: 'Monitor child shutdown provider', providers: [{
    id: 'monitor-child-shutdown', name: 'Monitor child shutdown', kind: 'custom', itemTypes: ['Folder'],
    supports: item => item.Path === identity,
    async fetch(item, { signal }) {
      const aborted = Promise.withResolvers();
      const onAbort = () => aborted.resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      entered.resolve({ signal, scheduled: activeWorkerPaths.has(item.Path) });
      try {
        await Promise.race([aborted.promise, releaseProvider.promise]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
        // Admitted providers may still release SQL-owned state after cancellation.
        // Exercise real database admission while checking that the saver is live.
        const rows = await f.rows(identity);
        providerCleanup = { aborted: signal.aborted, saverStopped, databaseClosed: f.database.closed, rows: rows.length };
      }
    }
  }] });
  try {
    await mkdir(path.join(f.media, 'ShutdownChild'));
    const { signal, scheduled } = await until(entered.promise, 'The actual watch did not reach the scheduled child provider.');
    assert.equal(scheduled, true, 'The provider must run inside an active child worker, not the root refresh.');
    const closing = f.runtime.close();
    assert.equal(f.runtime.close(), closing);
    assert.equal(signal.aborted, true, 'Shutdown must cancel metadata before waiting for the child worker.');
    await until(closing, 'Runtime cleanup waited for a child worker whose provider was not cancelled.');
    assert.deepEqual(providerCleanup, { aborted: true, saverStopped: false, databaseClosed: false, rows: 1 });
    assert.equal(saverStopped, true);
    assert.ok(f.watches.every(record => record.closed));
    assert.equal(f.database.closed, true);
  } finally {
    // A regression must fail the assertion without stranding fixture teardown.
    releaseProvider.resolve();
  }
});
