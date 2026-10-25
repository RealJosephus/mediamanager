import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createTestRuntime } from '../helpers/runtime.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000 };
const identityRoot = 'Z:\\MonitorRuntime';
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };

const failureFields = error => error == null || typeof error !== 'object' ? error : ({
  ...Object.fromEntries(['message', 'code', 'status', 'errno', 'path', 'syscall'].map(key => [key, error[key]])),
  ...(Array.isArray(error.errors) ? { errors: error.errors.map(failureFields) } : {}),
  ...(error.cause !== undefined ? { cause: failureFields(error.cause) } : {})
});
const includesFailure = (error, expected) => Boolean(error && (error.code === expected.code && error.message === expected.message
  || Array.isArray(error.errors) && error.errors.some(value => includesFailure(value, expected))
  || error.cause && includesFailure(error.cause, expected)));

function diagnosticError(error, seen = new WeakSet()) {
  if (error == null || typeof error !== 'object') return error;
  if (seen.has(error)) return { circular: true };
  seen.add(error);
  const value = { ...error,
    ...Object.fromEntries(['name', 'message', 'stack', 'code', 'status', 'path', 'errno', 'syscall'].map(key => [key, error[key]])),
    ...(error.cause !== undefined ? { cause: diagnosticError(error.cause, seen) } : {}),
    ...(Array.isArray(error.errors) ? { errors: error.errors.map(value => diagnosticError(value, seen)) } : {}) };
  seen.delete(error); return value;
}

function monitorWork(f) {
  const work = [];
  const itemFields = item => item && typeof item === 'object' ? { Id: item.Id, Type: item.Type, Path: item.Path } : item;
  for (const [owner, method] of [[f.runtime.libraryMonitorHost, 'getFileInfo'], [f.runtime.libraryMonitorHost, 'watchPath'],
    [f.runtime.libraryMonitorHost, 'resolveAffectedItem'], [f.runtime.libraryMonitorHost, 'changedExternally'],
    [f.runtime.metadata, 'queuedRefresh'], [f.runtime.metadataScanner, 'refreshLiveItem'],
    [f.runtime.libraryScanHost, 'validateChildren'], [f.runtime.libraryScanHost, 'refreshMetadata'],
    [f.runtime.libraryScanLifecycle, 'runPostScanTasks']]) {
    const original = owner[method].bind(owner);
    owner[method] = (...args) => {
      const entry = { method, item: itemFields(args[0]), completed: false }; work.push(entry);
      const complete = value => {
        entry.completed = true;
        try {
          if (value?.item) entry.affected = itemFields(value.item);
          if (value?.created) entry.created = value.created.map(itemFields);
          if (value?.skipped !== undefined) entry.skipped = value.skipped;
        } catch (error) { entry.observationError = { name: error.name, message: error.message }; }
      };
      const failed = error => { entry.completed = true; entry.error = diagnosticError(error); };
      try {
        const result = original(...args);
        if (result && typeof result.then === 'function') void result.then(complete, failed);
        else complete(result);
        return result;
      } catch (error) { failed(error); throw error; }
    };
  }
  return work;
}

async function until(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), 20000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, { saveLocalMetadata = false, watchedCollections = false, prepare } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'library-monitor-runtime-'));
  const remoteRequests = [];
  let database, runtime, expectedCloseError;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [async () => {
      try { await runtime?.close(); } catch (error) {
        if (!expectedCloseError) throw error;
        assert.deepEqual(failureFields(error), failureFields(expectedCloseError));
      }
    }, () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith('library-monitor-runtime-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Monitor runtime fixture cleanup failed.');
  });
  t.after(() => assert.deepEqual(remoteRequests, [], 'The local monitor fixture does not admit remote metadata or image transport.'));
  const programDataPath = path.join(root, 'state'), media = path.join(root, 'media');
  const alternateMedia = path.join(root, 'alternate-media'), knownAncestors = path.join(root, 'known-ancestors');
  const collection = path.join(programDataPath, 'root', 'default', 'Watched');
  for (const directory of [collection, media, alternateMedia, knownAncestors]) await mkdir(directory, { recursive: true });
  await mkdir(path.join(media, 'Existing'));
  await writeFile(path.join(collection, 'location.mblink'), identityRoot);
  const localTypeOptions = '<TypeOptions>' + ['Series', 'Person', 'BoxSet'].map(type =>
    `<TypeOptions><Type>${type}</Type><MetadataFetchers/><ImageFetchers/></TypeOptions>`).join('') + '</TypeOptions>';
  await writeFile(path.join(collection, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>true</EnableRealtimeMonitor>'
    + `<SaveLocalMetadata>${saveLocalMetadata}</SaveLocalMetadata>${localTypeOptions}</LibraryOptions>`);
  const collectionsPath = path.join(programDataPath, 'data', 'collections');
  if (watchedCollections) {
    const directory = path.join(programDataPath, 'root', 'default', 'ManagedCollections');
    await mkdir(directory, { recursive: true });
    await mkdir(collectionsPath, { recursive: true });
    await writeFile(path.join(directory, 'location.mblink'), collectionsPath);
    await writeFile(path.join(directory, 'boxsets.collection'), '');
    await writeFile(path.join(directory, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>true</EnableRealtimeMonitor>'
      + `<SaveLocalMetadata>true</SaveLocalMetadata>${localTypeOptions}</LibraryOptions>`);
    // This explicit nearest rule ends ancestor lookup inside the isolated
    // state library; none of the tested paths match it.
    await writeFile(path.join(collectionsPath, '.ignore'), '*.ignored');
  }
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
  runtime = await createTestRuntime({ database, programDataPath, storageConfiguration, serverId: 'monitor-runtime',
    configuration: { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, LibraryMonitorDelay: 0, LibraryScanFanoutConcurrency: 1 },
    pluginOptions: { options: { tmdb: { async fetch(url) {
      const request = new URL(url);
      remoteRequests.push(request.origin + request.pathname);
      throw new Error('Unexpected remote metadata or image request in the local monitor fixture.');
    } } } },
    onError: error => errors.push(error) });
  assert.equal(runtime.storageReadiness.ready, true);
  assert.ok(runtime.library.listeners('ItemAdded').includes(runtime.libraryMonitor.onItemAdded),
    'A successfully constructed runtime subscribes its monitor before returning.');
  await runtime.libraryScanLifecycle.validateTopLibraryFolders();
  await runtime.libraryMonitor.stop();
  const prepared = await prepare?.({ runtime, media, programDataPath });

  const watches = [], starts = new Set();
  const watch = runtime.libraryMonitorHost.watchPath.bind(runtime.libraryMonitorHost);
  runtime.libraryMonitorHost.watchPath = async (identity, options) => {
    const probeName = '.monitor-watch-ready';
    const probeIdentity = identity === identityRoot ? identity + '\\' + probeName : path.join(identity, probeName);
    const watchRoot = identity === identityRoot
      ? runtime.storage.configuration().instances.find(instance => instance.id === 'media').config.root : identity;
    const probeFile = path.join(watchRoot, probeName);
    assert.ok(path.resolve(probeFile).startsWith(path.resolve(root) + path.sep));
    const record = { identity, options, changes: [], closed: false, closeFailure: null, beforeClose: null };
    const owner = await watch(identity, { ...options, onChange: event => {
      record.changes.push(event);
      options.onChange(event);
    } });
    if (!owner) return owner;
    watches.push(record);
    // fs.watch can return before macOS has armed its FSEvent stream. Confirm
    // delivery through this subscription before testing a single business event.
    // The hidden probe is ignored by the library's ordinary resolution rules.
    let probing = true;
    const probe = (async () => {
      for (let attempt = 0; probing && !record.changes.some(event => event.path === probeIdentity); attempt++) {
        options.signal?.throwIfAborted();
        await writeFile(probeFile, String(attempt));
        await delay(25, undefined, { signal: options.signal });
      }
    })();
    try { await until(probe, () => `The storage watcher did not deliver its readiness event: ${identity}.`); }
    catch (error) { record.closed = true; await owner.close(); throw error; }
    finally { probing = false; await probe.catch(() => {}); await rm(probeFile, { force: true }); }
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
  const start = Promise.all([nextWatch(), ...(watchedCollections ? [nextWatch(collectionsPath)] : [])]);
  await runtime.libraryMonitor.start();
  await start;
  const rows = identity => runtime.store.run(db => db.rows('BaseItems', { where: { Path: identity } }), { readOnly: true });
  return { root, media, alternateMedia, database, runtime, errors, watches, nextWatch, rows, prepared, collectionsPath,
    expectCloseError(error) { expectedCloseError = error; } };
}

async function prepareSeries({ runtime, media }) {
  const [row] = await runtime.store.run(db => db.rows('BaseItems', { where: { Path: identityRoot } }), { readOnly: true });
  const parent = await runtime.itemCreation.getItemById(row.Id);
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.TV.Series');
  Object.assign(item, { Id: 'b5910000-0000-0000-0000-000000000001', Name: 'Self Written Series',
    Path: identityRoot + '\\Series', ParentId: parent.Id });
  await mkdir(path.join(media, 'Series'));
  await runtime.itemCreation.createItems([item], parent);
  return item.Id;
}

function observeSelfWrites(f) {
  const monitor = f.runtime.libraryMonitor, host = f.runtime.libraryMonitorHost;
  const observations = [], begins = [], completes = [], pending = new Set(), expiries = new Set();
  const active = new AsyncLocalStorage(), originalTimers = monitor.timers;
  const report = monitor.reportFileSystemChanged.bind(monitor), invalidate = host.invalidate.bind(host);
  const begin = monitor.reportFileSystemChangeBeginning.bind(monitor), complete = monitor.reportFileSystemChangeComplete.bind(monitor);
  monitor.reportFileSystemChangeBeginning = filename => { begins.push(filename); return begin(filename); };
  monitor.reportFileSystemChangeComplete = (filename, refresh) => { completes.push({ filename, refresh }); return complete(filename, refresh); };
  host.invalidate = (...args) => { if (active.getStore()) active.getStore().invalidated = true; return invalidate(...args); };
  monitor.timers = {
    setTimeout(callback, delay) {
      if (delay === 45_000) {
        const timer = { callback, unref() {} }; expiries.add(timer); return timer;
      }
      active.getStore()?.scheduled.push(delay);
      return originalTimers.setTimeout(callback, delay);
    },
    clearTimeout(timer) { if (!expiries.delete(timer)) originalTimers.clearTimeout(timer); }
  };
  monitor.reportFileSystemChanged = filename => {
    const observation = { filename, scheduled: [], invalidated: false, completed: false };
    observations.push(observation);
    return active.run(observation, async () => {
      try { await report(filename); }
      catch (error) { observation.error = error; throw error; }
      finally {
        observation.completed = true;
        for (const waiter of pending) if (waiter.filename === filename && observations.indexOf(observation) >= waiter.after) waiter.resolve(observation);
      }
    });
  };
  const reported = async (filename, after = 0) => {
    const existing = observations.slice(after).find(value => value.filename === filename && value.completed);
    if (existing) return existing;
    const completion = Promise.withResolvers(), waiter = { filename, after, resolve: completion.resolve };
    pending.add(waiter);
    try { return await until(completion.promise, `The actual watcher did not finish reporting ${filename}.`); }
    finally { pending.delete(waiter); }
  };
  return { begins, completes, observations, reported,
    async suppressed(filename, after = 0) {
      const observed = await reported(filename, after);
      assert.ok(f.watches.some(watch => watch.changes.some(event => event.path === filename)), 'The event came through an actual storage subscription.');
      assert.equal(observed.error, undefined);
      assert.equal(observed.invalidated, true, 'The shared ignore rule admitted the actual event before suppression.');
      assert.deepEqual(observed.scheduled, [], 'The completed event did not create or restart a refresh timer.');
      assert.ok(begins.includes(filename), 'The actual writer entered suppression for the identity path.');
      assert.ok(completes.some(value => value.filename === filename && value.refresh === false), 'The actual writer completed the same suppression owner.');
    },
    expire() {
      // Exercise native completion without waiting 45 seconds. Real filesystem
      // events and the monitor's refresh timers retain their actual scheduling.
      for (const timer of [...expiries]) { expiries.delete(timer); timer.callback(); }
    }
  };
}

async function addDirectory(f, name, media = f.media) {
  const identity = identityRoot + '\\' + name, created = Promise.withResolvers();
  const listener = event => { if (event.Item.Path === identity) created.resolve(event.Item.Id); };
  f.runtime.library.on('ItemAdded', listener);
  try {
    await mkdir(path.join(media, name));
    const id = await until(created.promise, () => `No library item was created for the actual filesystem event: ${name}. `
      + `Diagnostics: ${f.errors.map(error => error.message).join('; ')}. `
      + `Watch events: ${JSON.stringify(f.watches.map(({ identity, closed, changes }) => ({ identity, closed, changes })))}`
      + (f.monitorDiagnostic ? ` Monitor work: ${JSON.stringify(f.monitorDiagnostic())}` : ''));
    await f.runtime.metadata.drain();
    const rows = await f.rows(identity);
    assert.equal(rows.length, 1); assert.equal(rows[0].Id, id);
    assert.equal(rows[0].Type, 'MediaBrowser.Controller.Entities.Folder');
    assert.ok(rows[0].DateLastRefreshed, 'The shared queue ran metadata refresh after child creation.');
    return rows[0];
  } finally { f.runtime.library.off('ItemAdded', listener); }
}

test('postgres: actual NFO saver and repository writes suppress real watch events, then completion restores external refresh', pg, async t => {
  const f = await fixture(t, { saveLocalMetadata: true, prepare: prepareSeries }), observed = observeSelfWrites(f);
  const filename = identityRoot + '\\Series\\tvshow.nfo', physical = path.join(f.media, 'Series', 'tvshow.nfo');
  assert.equal(f.runtime.metadata.saver.monitor, f.runtime.libraryMonitor);
  assert.equal(f.runtime.metadataUpdates.monitor, f.runtime.libraryMonitor);
  const outcomes = await f.runtime.metadata.saver.save(f.prepared, ItemUpdateType.MetadataEdit, ['Nfo']);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].error, undefined);
  assert.match(await readFile(physical, 'utf8'), /Self Written Series/u);
  await observed.suppressed(filename);

  const after = observed.observations.length;
  await f.runtime.metadata.loadContext.withContext(f.prepared, { includeChildren: false }, async loaded => {
    loaded.item.Overview = 'Saved through the real repository lifecycle';
    const saves = await f.runtime.metadataUpdates.update(loaded, { Item: loaded.item }, ItemUpdateType.MetadataEdit);
    assert.ok(saves.every(value => !value.error));
  });
  assert.match(await readFile(physical, 'utf8'), /Saved through the real repository lifecycle/u);
  await observed.suppressed(filename, after);

  observed.expire();
  const admitted = Promise.withResolvers(), changed = f.runtime.libraryMonitorHost.changedExternally.bind(f.runtime.libraryMonitorHost);
  f.runtime.libraryMonitorHost.changedExternally = item => {
    const result = changed(item);
    if (item.Id === f.prepared) admitted.resolve();
    return result;
  };
  const externalAfter = observed.observations.length;
  await writeFile(physical, '<tvshow><title>Self Written Series</title><plot>External NFO change</plot></tvshow>');
  const external = await observed.reported(filename, externalAfter);
  assert.ok(external.scheduled.length > 0, 'The same identity schedules refresh after the completion delay expires.');
  await until(admitted.promise, 'The external NFO event did not enter the real shared queue.');
  await f.runtime.metadata.drain();
  const [row] = await f.rows(identityRoot + '\\Series');
  assert.equal(row.Overview, 'External NFO change');
  assert.ok(row.DateLastRefreshed);
  assert.deepEqual(f.errors, []);
});

test('postgres: actual image writes suppress real file and parent notifications through the runtime monitor', pg, async t => {
  const f = await fixture(t, { saveLocalMetadata: true, prepare: prepareSeries }), observed = observeSelfWrites(f);
  const work = monitorWork(f);
  f.monitorDiagnostic = () => ({ notifications: observed.observations, begins: observed.begins,
    completes: observed.completes, work, queue: [...f.runtime.metadata.getRefreshQueue()] });
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#3579aaff' } }).png().toBuffer();
  let filename;
  assert.equal(f.runtime.metadata.images.monitor, f.runtime.libraryMonitor);
  await f.runtime.metadata.loadContext.withContext(f.prepared, { includeChildren: false }, async loaded => {
    assert.equal(loaded.saveLocalMetadataEnabled, true);
    const saved = await f.runtime.metadata.images.saveImage(loaded, loaded.context.images,
      { Type: 'Primary', mimeType: 'image/png', bytes: png });
    assert.equal(saved.length, 1); filename = saved[0].Path;
    assert.equal(path.win32.dirname(filename), identityRoot + '\\Series');
  });
  assert.deepEqual(await readFile(path.join(f.media, 'Series', path.win32.basename(filename))), png);
  await observed.suppressed(filename);
  assert.ok(observed.begins.includes(identityRoot + '\\Series'));
  assert.ok(observed.completes.some(value => value.filename === identityRoot + '\\Series' && value.refresh === false));
  observed.expire();
  try {
    await addDirectory(f, 'AfterImageSave');
    assert.deepEqual(f.errors, []);
  } finally { t.diagnostic(JSON.stringify({ name: 'actual-image-monitor-work', ...f.monitorDiagnostic() },
    (_key, value) => typeof value === 'bigint' ? { int64: value.toString() } : value)); }
});

test('postgres: managed Collection creation and its XML saver share suppression with an actual state-directory watcher', pg, async t => {
  const f = await fixture(t, { watchedCollections: true }), observed = observeSelfWrites(f);
  assert.equal(f.runtime.collections.monitor, f.runtime.libraryMonitor);
  const created = await f.runtime.collections.create({ Name: 'Watched Collection' });
  assert.equal(path.dirname(created.Path), f.collectionsPath);
  await f.runtime.metadata.drain();
  await observed.suppressed(created.Path);
  const xml = path.join(created.Path, 'collection.xml');
  // Creating an empty collection queues a default refresh without a metadata
  // download. Perform an actual metadata edit after the directory callback has
  // registered its descendant watcher, so XML creation is observed directly.
  const after = observed.observations.length;
  const outcomes = await f.runtime.metadata.saver.save(created.Id, ItemUpdateType.MetadataEdit, ['Emby Xml']);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].error, undefined);
  assert.match(await readFile(xml, 'utf8'), /Watched Collection/u);
  await observed.suppressed(xml, after);
  assert.equal((await f.runtime.store.run(db => db.rows('BaseItems', { where: { Id: created.Id } }), { readOnly: true })).length, 1);
  observed.expire();
  await addDirectory(f, 'AfterCollectionSave');
  assert.deepEqual(f.errors, []);
});

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

for (const cancel of [false, true]) test(`postgres: actual full scan ${cancel ? 'cancellation' : 'completion'} restores filesystem monitoring after the stopped generation`, pg, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), releaseProvider = Promise.withResolvers();
  const controller = new AbortController(), previous = f.watches.filter(record => !record.closed);
  const existingIdentity = identityRoot + '\\Existing';
  let providerReleased = false, providerEntered = false;
  const work = monitorWork(f), settled = { scan: { status: 'pending' }, watcher: { status: 'pending' } };
  f.runtime.metadata.registry.register({ id: 'monitor-scan-provider', name: 'Monitor scan provider', providers: [{
    id: 'monitor-scan', name: 'Monitor scan', kind: 'custom', itemTypes: ['Folder'],
    supports: item => item.Path === existingIdentity,
    async fetch(_item, { signal }) {
      const aborted = Promise.withResolvers(), onAbort = () => aborted.resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      providerEntered = true; entered.resolve(signal);
      try {
        await Promise.race([releaseProvider.promise, aborted.promise]);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
        providerReleased = true;
      }
    }
  }] });
  const progress = [], restarted = f.nextWatch();
  const scan = f.runtime.libraryScanner.runCompleteScan({ signal: controller.signal,
    reportProgress: value => progress.push(value) });
  // Keep both operation outcomes observed while the actual provider holds its
  // SQL-owned refresh context; querying that context from here would contend
  // with the deliberately single-connection fixture.
  const outcomes = Promise.allSettled([scan, restarted]);
  void scan.then(value => { settled.scan = { status: 'fulfilled', value }; },
    error => { settled.scan = { status: 'rejected', error: diagnosticError(error) }; });
  void restarted.then(value => { settled.watcher = { status: 'fulfilled', identity: value.identity, closed: value.closed }; },
    error => { settled.watcher = { status: 'rejected', error: diagnosticError(error) }; });
  try {
    const signal = await until(entered.promise, 'The full scan did not reach the actual child metadata provider.');
    assert.equal(signal.aborted, false);
    assert.equal(f.runtime.libraryScanLifecycle.isScanRunning, true);
    assert.ok(previous.length > 0 && previous.every(record => record.closed),
      'The full scan releases the actual storage subscriptions before entering a child provider.');
    assert.equal(f.runtime.library.listeners('ItemAdded').includes(f.runtime.libraryMonitor.onItemAdded), false);
    await mkdir(path.join(f.media, 'CreatedDuringFullScan'));
    if (cancel) controller.abort();
    else releaseProvider.resolve();
    const [scanned, watched] = await until(outcomes, 'The full scan did not settle and restore its storage subscription.');
    assert.equal(watched.status, 'fulfilled');
    assert.equal(providerReleased, true);
    assert.equal(f.runtime.libraryScanLifecycle.isScanRunning, false);
    if (cancel) {
      assert.equal(scanned.status, 'rejected');
      assert.ok(scanned.reason?.name === 'AbortError' || scanned.reason?.code === 'cancelled',
        `The actual scan must propagate cancellation: ${scanned.reason?.message}`);
    } else {
      if (scanned.status === 'rejected') throw scanned.reason;
      const [existing] = await f.rows(existingIdentity);
      assert.ok(existing?.DateLastRefreshed, 'The completed scan persists its child metadata refresh.');
      assert.equal(progress.at(-1), 99, 'The scheduled scan observer retains its completion-progress contract.');
    }
    // Cancellation released the first fetch through its aborted signal. The
    // provider remains registered for later real watcher refreshes, which must
    // not inherit the test-owned barrier from the cancelled scan.
    releaseProvider.resolve();
    assert.equal(f.runtime.library.listeners('ItemAdded').filter(listener => listener === f.runtime.libraryMonitor.onItemAdded).length, 1);
    await addDirectory(f, 'CreatedAfterFullScan');
    const [during] = await f.rows(identityRoot + '\\CreatedDuringFullScan');
    assert.ok(during?.DateLastRefreshed,
      'A real post-scan filesystem event reconciles the directory created while monitoring was stopped.');
    assert.equal(f.watches.filter(record => !record.closed && record.identity === identityRoot).length, 1);
  } finally {
    const beforeCleanup = { ...settled, providerEntered, providerReleased, signalAborted: controller.signal.aborted,
      scanRunning: f.runtime.libraryScanLifecycle.isScanRunning, progress: [...progress],
      queue: [...f.runtime.metadata.getRefreshQueue()], work: work.map(entry => ({ ...entry })), errors: f.errors.map(error => diagnosticError(error)),
      watches: f.watches.map(({ identity, closed, changes }) => ({ identity, closed, changes: [...changes] })) };
    // Release a failed assertion without leaving the real provider, scanner or
    // fixture database waiting on a test-owned barrier.
    releaseProvider.resolve();
    controller.abort();
    await Promise.allSettled([scan]);
    t.diagnostic(JSON.stringify({ name: 'actual-full-scan-monitor-work', cancel, beforeCleanup,
      afterCleanup: { ...settled, providerEntered, providerReleased, work, errors: f.errors.map(error => diagnosticError(error)) } },
      (_key, value) => typeof value === 'bigint' ? { int64: value.toString() } : value));
  }
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
  const failure = Object.assign(new Error('Controlled stopped-watcher cleanup failure.'), { code: 'stopped-watcher-close-failure' });
  f.watches.find(record => !record.closed && record.identity === identityRoot).closeFailure = failure;
  const definition = f.runtime.storage.configuration();
  definition.instances.find(instance => instance.id === 'media').config.root = f.alternateMedia;
  const restarted = f.nextWatch();
  await f.runtime.storage.configure(definition);
  await restarted;
  assert.ok(f.errors.some(error => includesFailure(error, failure)), 'The before-change failure is preserved as a diagnostic.');
  assert.equal(f.runtime.storage.configuration().instances.find(instance => instance.id === 'media').config.root, f.alternateMedia);
  await addDirectory(f, 'AfterFailedOldWatchCleanup', f.alternateMedia);
});

test('postgres: runtime close cancels an admitted provider and releases database ownership after a watcher close failure', pg, async t => {
  const f = await fixture(t), entered = Promise.withResolvers();
  const closeFailure = Object.assign(new Error('Controlled watcher cleanup failure after releasing its actual handle.'), { code: 'watcher-close-failure' });
  const closeEntered = Promise.withResolvers(), releaseClose = Promise.withResolvers();
  const watch = f.watches.find(record => !record.closed && record.identity === identityRoot);
  watch.closeFailure = closeFailure;
  watch.beforeClose = async () => { closeEntered.resolve(); await releaseClose.promise; };
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
  const finished = [false, false];
  const closing = Promise.allSettled([f.runtime.close(), f.runtime.close()]
    .map((operation, index) => operation.finally(() => { finished[index] = true; })));
  try {
    await until(closeEntered.promise, 'Runtime cleanup did not reach the actual held watcher close.');
    assert.deepEqual(finished, [false, false]);
    assert.equal(f.database.closed, false);
  } finally { releaseClose.resolve(); }
  const outcomes = await until(closing, 'Runtime cleanup did not complete.');
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.ok(includesFailure(outcome.reason, closeFailure));
    f.expectCloseError(outcome.reason);
  }
  assert.deepEqual(failureFields(outcomes[0].reason), failureFields(outcomes[1].reason));
  assert.deepEqual(finished, [true, true]);
  assert.equal(signal.aborted, true);
  assert.equal((await settled)[0].status, 'rejected');
  assert.ok(f.watches.every(record => record.closed));
  assert.equal(f.runtime.library.listeners('ItemAdded').includes(f.runtime.libraryMonitor.onItemAdded), false);
  assert.equal(f.database.closed, true);
  await assert.rejects(f.database.rows('BaseItems'), /not open|closed/iu);
});

test('postgres: runtime close cancels a watched child provider before waiting for its scheduler worker', pg, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), releaseProvider = Promise.withResolvers();
  const cleanupEntered = Promise.withResolvers(), releaseCleanup = Promise.withResolvers();
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
        cleanupEntered.resolve(); await releaseCleanup.promise;
        const rows = await f.rows(identity);
        providerCleanup = { aborted: signal.aborted, saverStopped, databaseClosed: f.database.closed, rows: rows.length };
      }
    }
  }] });
  try {
    await mkdir(path.join(f.media, 'ShutdownChild'));
    const { signal, scheduled } = await until(entered.promise, 'The actual watch did not reach the scheduled child provider.');
    assert.equal(scheduled, true, 'The provider must run inside an active child worker, not the root refresh.');
    const finished = [false, false];
    const closing = Promise.all([f.runtime.close(), f.runtime.close()]
      .map((operation, index) => operation.then(() => { finished[index] = true; })));
    assert.equal(signal.aborted, true, 'Shutdown must cancel metadata before waiting for the child worker.');
    await until(cleanupEntered.promise, 'The cancelled child provider did not enter its SQL cleanup.');
    assert.deepEqual(finished, [false, false]);
    assert.equal(saverStopped, false); assert.equal(f.database.closed, false);
    releaseCleanup.resolve();
    await until(closing, 'Runtime cleanup waited for a child worker whose provider was not cancelled.');
    assert.deepEqual(finished, [true, true]);
    assert.deepEqual(providerCleanup, { aborted: true, saverStopped: false, databaseClosed: false, rows: 1 });
    assert.equal(saverStopped, true);
    assert.ok(f.watches.every(record => record.closed));
    assert.equal(f.database.closed, true);
  } finally {
    // A regression must fail the assertion without stranding fixture teardown.
    releaseProvider.resolve(); releaseCleanup.resolve();
  }
});
