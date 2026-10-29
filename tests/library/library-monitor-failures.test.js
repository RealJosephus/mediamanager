import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryMonitorHost } from '../../src/library/library-monitor-host.js';
import { LibraryScanHost } from '../../src/library/library-scan-host.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { loadLibrary, idKey } from '../../src/library/records.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const pg = { skip: !postgresTestConnectionString, timeout: 120000 };
const id = number => 'fa710000-0000-0000-0000-' + String(number).padStart(12, '0');
const nativeTypes = { Folder: 'MediaBrowser.Controller.Entities.Folder', CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder' };
const reasons = [false, 0, '', null, undefined];
const capture = async operation => (await Promise.allSettled([Promise.resolve().then(operation)]))[0];
const value = (reason, seen = new Map()) => {
  if (reason === null || typeof reason !== 'object') return reason;
  if (seen.has(reason)) return seen.get(reason);
  const result = Array.isArray(reason) ? [] : {}; seen.set(reason, result);
  for (const key of Reflect.ownKeys(reason)) {
    if (Array.isArray(reason) && key === 'length' || reason instanceof Error && ['name', 'stack'].includes(key)) continue;
    Object.defineProperty(result, key, { value: value(reason[key], seen), enumerable: true, configurable: true, writable: true });
  }
  return result;
};
const raw = (reason, ancestors = new Set()) => {
  if (reason === undefined) return { reasonType: 'undefined' };
  if (typeof reason === 'bigint' || typeof reason === 'symbol') return { reasonType: typeof reason, value: String(reason) };
  if (reason === null || typeof reason !== 'object') return reason;
  if (ancestors.has(reason)) return { circularReference: true };
  const nested = new Set(ancestors).add(reason);
  if (Array.isArray(reason)) return reason.map(entry => raw(entry, nested));
  return { ...(reason instanceof Error ? { name: reason.name, stack: reason.stack } : {}),
    ...Object.fromEntries(Reflect.ownKeys(reason).map(key => [String(key), raw(reason[key], nested)])) };
};
const combined = errors => Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Fixture operation and owner release failed.', { cause: errors[0] }),
  Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
const rejected = (result, reason) => {
  assert.equal(result.status, 'rejected');
  assert.deepEqual(value(result.reason), value(reason));
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monitor-failures-'));
  let database, store, links, registry, query;
  const report = { schemaVersion: 1, ownerFixture: 'tests/library/library-monitor-failures.test.js', outcomes: [], fileDescriptors: [], resources: [], cleanup: [],
    serialization: 'Raw diagnostic objects describe undefined explicitly; functional typed and own-property comparisons run before JSON. No CLR representation is required.',
    phaseAcceptance: false, releaseAcceptance: false };
  const f = { root, faults: {}, handles: [], watchers: [], report };
  const closeHandle = async (handle, phase) => {
    const descriptor = handle.fd;
    let failed = false;
    try { await handle.close(); }
    catch (error) { failed = true; throw error; }
    finally {
      if (descriptor >= 0) {
        let released = false, error;
        try { fstatSync(descriptor); } catch (reason) { error = raw(reason); released = reason?.code === 'EBADF'; }
        report.fileDescriptors.push({ phase, descriptor, released, error });
        if (!failed) assert.equal(released, true, 'The actual descriptor must close before another operation can reuse it.');
      }
    }
  };
  t.after(async () => {
    f.faults.hold?.resume.resolve(); f.faults = {};
    if (database && query) database.client.query = query;
    const errors = [];
    for (const close of [...f.watchers.map(watcher => () => watcher.close()), ...f.handles.map(handle => () => closeHandle(handle, 'fixture cleanup')),
      () => links?.close(), () => store?.close(), () => registry?.close(), () => dropPostgresTestDatabase(database), async () => {
        assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('monitor-failures-'));
        await rm(root, { recursive: true, force: true });
      }]) try { await close(); report.cleanup.push({ completed: true }); }
      catch (error) { errors.push(error); report.cleanup.push({ failed: true, error: raw(error) }); }
    try {
      const output = path.join(validationOutputRoot(), 'library-monitor-failures-' + randomUUID() + '.json');
      assertValidationOutputChild(output); await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    } catch (error) { t.diagnostic(JSON.stringify({ reportWriteError: raw(error) })); }
    if (errors.length) throw new AggregateError(errors, 'Monitor failure fixture cleanup failed.');
  });
  const media = path.join(root, 'media'), manifest = path.join(root, 'watch-paths.json');
  const names = Array.from({ length: 130 }, (_, index) => String(index).padStart(3, '0'));
  await mkdir(media);
  for (const name of names) await mkdir(path.join(media, name));
  await writeFile(manifest, JSON.stringify(names));
  registry = new StorageRegistry();
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  const adapter = await registry.createInstance('media', 'local', { root: media, writable: true });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityRoot = 'Z:\\MonitorFailures', identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'Controlled actual local watch directories.' });
  const paths = names.map(name => identityRoot + '\\' + name);
  database = await createPostgresTestDatabase(null, 'monitor_failure', { max: 1 });
  store = new DomainStore(database); links = new PostgresLinkedChildrenStore({ database });
  await links.initialize();
  const parent = Object.assign(newNativeItemEntity(nativeTypes.Folder), { Id: id(2), Name: 'Parent', Path: identityRoot });
  const collection = Object.assign(newNativeItemEntity(nativeTypes.CollectionFolder), {
    Id: id(1), Name: 'Watched', Path: identityRoot, ParentId: parent.Id, PhysicalLocationsList: paths,
  });
  await database.insertBatch('BaseItems', [{ item: parent, ParentId: null }, { item: collection, ParentId: parent.Id }]
    .map(({ item, ParentId }) => postgresTestRow('BaseItems', {
    Id: item.Id, Type: item.NativeType, Name: item.Name, SortName: item.Name, Path: item.Path,
    ParentId, IsFolder: true,
    Data: JSON.stringify(item.Type === 'CollectionFolder' ? { PhysicalLocationsList: paths } : {}),
  })));
  const before = await database.rows('BaseItems');
  Object.assign(f, { manifest, database, store, links, registry, adapter, vfs, identityMap, paths, parent, collection });
  query = database.client.query;
  database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    const values = typeof args[0] === 'string' ? args[1] : args[0].values;
    const phase = text.startsWith('DROP COLLATION ') ? 'collation'
      : /^DROP TABLE IF EXISTS "mm_monitor_paths_/u.test(text) ? 'table'
        : /^DROP TABLE IF EXISTS "mm_scan_missing_/u.test(text) ? 'scanTable' : null;
    if (phase && f.faults.hold?.phase === phase) {
      f.faults.hold.entered.resolve(); await f.faults.hold.resume.promise;
    }
    if (phase && Object.hasOwn(f.faults, phase)) throw f.faults[phase];
    const result = await query(...args);
    if (text.includes('/* monitor-watch-path-page */') && BigInt(values[0]) > 0n && Object.hasOwn(f.faults, 'page')) throw f.faults.page;
    return result;
  };
  const run = store.run.bind(store);
  store.run = (operation, options) => (async () => {
    const owner = await open(manifest, 'r'); f.handles.push(owner); f.ownerHandle = owner;
    let result, failed = false, failure;
    try { result = await run(async session => {
      f.backendPid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return operation(session);
    }, options); }
    catch (error) { failed = true; failure = error; }
    try {
      try {
        if (f.faults.hold?.phase === 'owner') {
          f.faults.hold.entered.resolve(); await f.faults.hold.resume.promise;
        }
      } finally { await closeHandle(owner, 'store owner'); }
      if (Object.hasOwn(f.faults, 'owner')) throw f.faults.owner;
    } catch (cleanup) {
      if (failed) throw combined([failure, cleanup]);
      throw cleanup;
    }
    if (failed) throw failure;
    return result;
  })();
  const library = Object.assign(new EventEmitter(), {
    options: { configuration: { UICulture: 'en-US' }, libraryOptions: new Map([[idKey(collection.Id), { EnableRealtimeMonitor: true }]]) },
    async getCollectionFolders() { return [collection]; },
    load: (session, _user, options) => loadLibrary(session, { linkedChildren: links }, options),
  });
  const itemCreation = { linkedChildren: links };
  library.itemCreation = itemCreation;
  const scanHost = {
    async getAggregateFolder() { return parent; },
    async withChildSnapshot(_parent, operation) {
      return operation({ async *pages() {
        const source = await open(manifest, 'r'); f.handles.push(source); f.sourceHandle = source;
        let failed = false, failure;
        try {
          const requested = JSON.parse(await source.readFile({ encoding: 'utf8' }));
          const actual = (await vfs.list('/media')).entries.filter(entry => entry.kind === 'directory').map(entry => entry.name).sort();
          assert.deepEqual(actual, requested);
          const [stored] = await database.rows('BaseItems', { where: { Id: collection.Id } });
          const item = Object.assign(newNativeItemEntity(nativeTypes.CollectionFolder), {
            Id: stored.Id, Name: stored.Name, Path: stored.Path, PhysicalLocationsList: requested.map(name => identityRoot + '\\' + name),
          });
          yield [item];
          await vfs.stat('/media/' + requested[0]);
          if (Object.hasOwn(f.faults, 'source')) throw f.faults.source;
        } catch (error) { failed = true; failure = error; throw error; }
        finally {
          try { await closeHandle(source, 'source iterator'); }
          catch (cleanup) { if (failed) throw combined([failure, cleanup]); throw cleanup; }
        }
      } });
    },
  };
  f.host = new LibraryMonitorHost({ store, library, itemCreation, scanHost, metadata: {}, metadataScanner: {},
    fileSystem: { vfs, identityMap }, vfs, identityMap });
  f.scan = new LibraryScanHost({ store, library, itemCreation, metadataScanner: {}, topLevelValidation: { supports: () => false } });
  f.collect = async () => {
    const result = [];
    try { for await (const identity of f.host.getWatchPaths()) result.push(identity); }
    catch (error) { report.outcomes.push({ phase: 'watch cursor', status: 'rejected', emittedPrefix: result, reason: raw(error) }); throw error; }
    report.outcomes.push({ phase: 'watch cursor', status: 'fulfilled', paths: result });
    return result;
  };
  f.capture = async (phase, operation) => {
    const result = await capture(operation);
    report.outcomes.push({ phase, status: result.status, ...(result.status === 'rejected' ? { reason: raw(result.reason) } : { value: raw(result.value) }) });
    return result;
  };
  f.resourcesClosed = async () => {
    for (const handle of f.handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
    const tables = await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND (relname LIKE 'mm_monitor_%' OR relname LIKE 'mm_scan_missing_%' OR relname LIKE 'mm_metadata_%')`);
    const collations = await database.client.query(`SELECT collname FROM pg_collation WHERE collnamespace=pg_my_temp_schema()
      AND collname LIKE 'mm_search_%'`);
    assert.deepEqual(tables.rows, []); assert.deepEqual(collations.rows, []);
    assert.deepEqual(await database.rows('BaseItems'), before);
    report.resources.push({ temporaryTables: tables.rows, temporaryCollations: collations.rows, persistentRowsUnchanged: true });
  };
  f.closeHandle = closeHandle;
  return f;
}

test('postgres: watch source and later real SQL page retain every primitive failure, its emitted prefix and recovery', pg, async t => {
  const f = await fixture(t);
  for (const phase of ['source', 'page']) for (const reason of reasons) await t.test(phase + ': ' + String(reason), async () => {
    const prefix = []; f.faults = { [phase]: reason };
    const result = await f.capture(phase + ': ' + String(reason), async () => { for await (const identity of f.host.getWatchPaths()) prefix.push(identity); });
    f.report.outcomes.at(-1).emittedPrefix = [...prefix];
    rejected(result, reason);
    assert.deepEqual(prefix, phase === 'page' ? f.paths.slice(0, 128) : []);
    f.faults = {}; await f.resourcesClosed();
    assert.deepEqual(await f.collect(), f.paths); await f.resourcesClosed();
  });
  const watcher = await f.host.watchPath(f.paths[0], { onChange() {}, onError() {} }); f.watchers.push(watcher);
  await watcher.close();
  assert.equal((await f.vfs.stat('/media/000')).kind, 'directory');
  await f.registry.close(); await assert.rejects(f.vfs.stat('/media/000'), { code: 'closed' });
});

test('postgres: cursor failures preserve business fields before real cleanup failures and retire the failed backend', pg, async t => {
  const f = await fixture(t);
  const business = { message: 'The page source refused the read.', code: 'ESOURCE', status: 409, statusCode: 422,
    name: 'Plain source payload', stack: 'A business field named stack.', details: { prefix: ['read', null] },
    cause: false, errors: [null, 'source detail'] };
  const actualError = Object.assign(new Error('The actual Node page source failed.', { cause: { source: 'watch paths', missing: undefined } }),
    { code: 'ENODESOURCE', status: 409, statusCode: 422, details: { phase: 'actual source' },
      errors: [false, Object.assign(new Error('A nested cause.', { cause: undefined }), { code: 'ENESTED' })] });
  for (const reason of [...reasons, business, actualError]) {
    const cleanup = { message: 'The owned table could not be dropped.', code: 'EDROP', status: 503, statusCode: 507, cause: 0 };
    f.faults = { page: reason, table: cleanup };
    const result = await f.capture('page and table cleanup', () => f.collect());
    assert.equal(result.status, 'rejected');
    assert.equal(Object.hasOwn(result.reason, 'cause'), true);
    assert.deepEqual(value(result.reason.cause), value(reason));
    assert.deepEqual(result.reason.errors.map(reason => value(reason)), [value(reason), value(cleanup)]);
    if (reason !== null && typeof reason === 'object') for (const key of ['code', 'status', 'statusCode']) assert.equal(result.reason[key], reason[key]);
    const failedBackend = f.backendPid;
    f.faults = {}; await f.resourcesClosed();
    assert.deepEqual((await f.database.client.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [failedBackend])).rows, []);
    assert.deepEqual(await f.collect(), f.paths); await f.resourcesClosed();
  }
});

test('postgres: early return and throw await actual collation/table and outer owner cleanup', pg, async t => {
  const f = await fixture(t);
  for (const phase of ['collation', 'table', 'owner']) for (const reason of [false, undefined]) {
    const iterator = f.host.getWatchPaths();
    assert.deepEqual(await iterator.next(), { value: f.paths[0], done: false });
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    f.faults = { [phase]: reason, hold: { phase, entered, resume } };
    let settled = false;
    const closing = f.capture('early return: ' + phase, () => iterator.return()); void closing.then(() => { settled = true; });
    let closeResult;
    try {
      await entered.promise; assert.equal(settled, false);
      await f.ownerHandle.stat();
    } finally { resume.resolve(); closeResult = await closing; }
    rejected(closeResult, reason);
    f.faults = {}; await f.resourcesClosed();
    assert.deepEqual(await f.collect(), f.paths);
  }
  const business = { message: 'The watch consumer stopped.', code: 'ECONSUMER', status: 409, statusCode: 412 };
  for (const cleanupFailure of [false, true]) for (const consumer of [...reasons, business]) {
    const iterator = f.host.getWatchPaths(); await iterator.next();
    f.faults = cleanupFailure ? { table: null } : {};
    const result = await f.capture(cleanupFailure ? 'consumer throw and table cleanup' : 'consumer throw', () => iterator.throw(consumer));
    if (cleanupFailure) {
      assert.equal(result.status, 'rejected');
      assert.equal(Object.hasOwn(result.reason, 'cause'), true);
      assert.deepEqual(value(result.reason.cause), value(consumer));
      assert.deepEqual(result.reason.errors.map(reason => value(reason)), [value(consumer), null]);
      if (consumer !== null && typeof consumer === 'object') for (const key of ['code', 'status', 'statusCode']) assert.equal(result.reason[key], consumer[key]);
    } else rejected(result, consumer);
    f.faults = {}; await f.resourcesClosed(); assert.deepEqual(await f.collect(), f.paths);
  }
});

test('postgres: the real child cohort releases after every falsy snapshot callback failure and retains the ordered cleanup cause', pg, async t => {
  const f = await fixture(t), flush = f.links.flushReleases.bind(f.links);
  let armed = false, releaseOwner;
  const cleanup = { message: 'The child owner rejected after its actual release.', code: 'ECHILDRELEASE', status: 503, statusCode: 507, cause: '' };
  f.links.flushReleases = async (...args) => {
    const result = await flush(...args);
    if (armed) { armed = false; await f.closeHandle(releaseOwner, 'real child owner'); throw cleanup; }
    return result;
  };
  const expected = [{ Id: idKey(f.collection.Id), Path: f.collection.Path }];
  const rows = async children => {
    const values = []; for await (const page of children.pages()) for (const item of page) values.push({ Id: idKey(item.Id), Path: item.Path });
    return values;
  };
  for (const reason of [...reasons, { message: 'Snapshot consumer refused the child.', code: 'ECHILD', status: 409, statusCode: 422 }]) {
    const result = await f.capture('real child snapshot callback and release', () => f.scan.withChildSnapshot(f.parent, async children => {
      assert.deepEqual(await rows(children), expected);
      releaseOwner = await open(f.manifest, 'r'); f.handles.push(releaseOwner); armed = true;
      throw reason;
    }));
    assert.equal(result.status, 'rejected');
    assert.equal(Object.hasOwn(result.reason, 'cause'), true);
    assert.deepEqual(value(result.reason.cause), value(reason));
    assert.deepEqual(value(result.reason.errors[0]), value(reason));
    assert.deepEqual(result.reason.errors[1].errors.map(reason => value(reason)), [value(cleanup)]);
    if (reason?.code) for (const key of ['code', 'status', 'statusCode']) assert.equal(result.reason[key], reason[key]);
    await assert.rejects(releaseOwner.stat(), { code: 'EBADF' });
    assert.deepEqual(await f.scan.withChildSnapshot(f.parent, rows), expected);
    await f.resourcesClosed();
  }
  f.links.flushReleases = flush;
  const schema = f.links.schemaName; await f.links.close();
  const observer = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: f.database.schemaName });
  try {
    const namespace = (await observer.client.query('SELECT to_regnamespace($1) AS namespace', [schema])).rows[0].namespace;
    f.report.resources.push({ relationSchema: schema, namespaceAfterClose: namespace });
    assert.equal(namespace, null);
  }
  finally { await observer.close(); }
});

test('postgres: child deletion staging preserves falsy callback failures before an actual SQL cleanup fault and can read again', pg, async t => {
  const f = await fixture(t);
  const cleanup = { message: 'The pending deletion table could not be dropped.', code: 'ESCANTABLE', status: 503, statusCode: 507 };
  const rows = async children => {
    const result = []; for await (const page of children.pages()) for (const item of page) result.push({ Id: idKey(item.Id), Path: item.Path });
    return result;
  };
  const expected = [{ Id: idKey(f.collection.Id), Path: f.collection.Path }];
  for (const reason of reasons) {
    f.faults = { scanTable: cleanup };
    const result = await f.capture('child deletion staging callback and cleanup', () => f.scan.withChildren(f.parent, async children => {
      assert.deepEqual(await rows(children), expected);
      await children.markForDeletion(f.collection.Id);
      throw reason;
    }));
    assert.equal(result.status, 'rejected');
    assert.equal(Object.hasOwn(result.reason, 'cause'), true);
    assert.deepEqual(value(result.reason.cause), value(reason));
    assert.deepEqual(result.reason.errors.map(reason => value(reason)), [value(reason), value(cleanup)]);
    f.faults = {};
    assert.deepEqual(await f.scan.withChildren(f.parent, rows), expected);
    await f.resourcesClosed();
  }
});
