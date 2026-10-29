import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryScanService, LibraryService, libraryScanCapabilities } from '../../src/library/index.js';
import { StorageError } from '../../src/storage/errors.js';

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-09-27 00:00:00'
      : column.nullable ? null : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));
}

function item(Id, Type, values = {}) {
  return { ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type,
    CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(), MediaType: 'Unknown', Data: '{}', ...values };
}

const ids = {
  aggregate: '51000000-0000-0000-0000-000000000001',
  first: '51000000-0000-0000-0000-000000000002',
  nested: '51000000-0000-0000-0000-000000000003',
  detached: '51000000-0000-0000-0000-000000000004',
  collection: '51000000-0000-0000-0000-000000000005',
  nestedCollection: '51000000-0000-0000-0000-000000000006',
  duplicate: '51000000-0000-0000-0000-000000000007',
  dangling: '51000000-0000-0000-0000-000000000099'
};

for (const dialect of ['postgres']) test(`${dialect}: physical scan root discovery combines aggregate and collection mappings without scanning nested duplicates`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const schema = `library_scan_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'library-scan-root-test' });
  t.after(async () => {
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await store.close();
  });

  await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', item(ids.first, 'Folder', { IsFolder: true, ParentId: ids.aggregate,
    TopParentId: ids.first, Path: 'Z:\\Media', Data: JSON.stringify({ SourceType: 'Library' }) }));
  await database.insert('BaseItems', item(ids.nested, 'Folder', { IsFolder: true, ParentId: ids.first,
    TopParentId: ids.first, Path: 'Z:\\Media\\Nested', Data: JSON.stringify({ SourceType: 'Library' }) }));
  await database.insert('BaseItems', item(ids.detached, 'Folder', { IsFolder: true, TopParentId: ids.detached,
    Path: '/srv/detached', Data: JSON.stringify({ SourceType: 'Library' }) }));
  await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', { IsFolder: true,
    Data: JSON.stringify({ PhysicalFolderIds: [ids.first, ids.dangling], PhysicalLocationsList: ['/srv/detached/'] }) }));
  await database.insert('BaseItems', item(ids.nestedCollection, 'CollectionFolder', { IsFolder: true,
    Data: JSON.stringify({ PhysicalFolderIds: [ids.nested] }) }));

  assert.deepEqual((await library.getPhysicalScanRoots()).map(root => root.Id), [ids.detached, ids.first]);
  assert.deepEqual((await library.getPhysicalScanRoots({ collectionId: ids.nestedCollection })).map(root => root.Id), [ids.nested]);
  await assert.rejects(library.getPhysicalScanRoots({ collectionId: ids.dangling }), error => error.status === 404);

  await database.insert('BaseItems', item(ids.duplicate, 'Folder', { IsFolder: true,
    TopParentId: ids.duplicate, Path: '/srv/detached/', Data: JSON.stringify({ SourceType: 'Library' }) }));
  await assert.rejects(library.getPhysicalScanRoots(), error => error.status === 500 && /same native path/u.test(error.message));
});


const tick = () => new Promise(resolve => setImmediate(resolve));
const cancelled = message => new StorageError('cancelled', message);
const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(cancelled('Scan was cancelled.'));
  else signal.addEventListener('abort', () => reject(cancelled('Scan was cancelled.')), { once: true });
});
function scannerFor(run, options = {}) {
  return new LibraryScanService({ lifecycle: { run, capabilities: options.capabilities }, onError: options.onError });
}

test('library scan requires one lifecycle owner', async () => {
  assert.throws(() => new LibraryScanService(), { message: 'Library scanning requires the aggregate folder validation lifecycle.' });
  assert.throws(() => new LibraryScanService({ lifecycle: {} }), { message: 'Library scanning requires the aggregate folder validation lifecycle.' });
  assert.throws(() => new LibraryScanService({ lifecycle: { run() {} }, onError: null }), { message: 'Library scan error reporting must be a function.' });
  const scanner = scannerFor(async () => ({ completed: true }));
  assert.deepEqual(await scanner.runCompleteScan(), { completed: true }); await scanner.close();
});

test('queue replacement cancels the old lifecycle and restarts after it drains', async t => {
  const entered = Promise.withResolvers(), drained = Promise.withResolvers(), release = Promise.withResolvers();
  const calls = [], errors = [];
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  let count = 0;
  const scanner = scannerFor(async ({ signal }) => {
    const index = ++count; calls.push('start-' + index);
    if (index === 1) {
      entered.resolve();
      try { await waitForAbort(signal); }
      finally { drained.resolve(); await release.promise; calls.push('drain-1'); }
    }
    return { invocation: index };
  }, { onError: error => errors.push(error) });
  const first = scanner.queue(); await entered.promise;
  const second = scanner.queue(); await drained.promise;
  await tick(); assert.deepEqual(calls, ['start-1']);
  release.resolve();
  assert.equal((await first).status, 'cancelled');
  assert.deepEqual(await second, { generation: 2, status: 'completed', result: { invocation: 2 } });
  assert.deepEqual(calls, ['start-1', 'drain-1', 'start-2']);
  await scanner.close();
});

test('pending generations receive individual cancellation receipts', async () => {
  let count = 0;
  const scanner = scannerFor(async () => { count++; return { count }; });
  const first = scanner.queue(), second = scanner.queue(), third = scanner.queue();
  assert.deepEqual((await Promise.all([first, second, third])).map(receipt => receipt.status), ['cancelled', 'cancelled', 'completed']);
  assert.equal(count, 1); await scanner.close();
});

for (const queuedFirst of [false, true]) test('explicit and queued lifecycle operations serialize in call order: ' + queuedFirst, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  let count = 0, active = 0, maximum = 0;
  const scanner = scannerFor(async () => {
    const index = ++count; calls.push(index); maximum = Math.max(maximum, ++active);
    try { if (index === 1) { entered.resolve(); await release.promise; } return { index }; }
    finally { active--; }
  });
  const first = queuedFirst ? scanner.queue() : scanner.runCompleteScan();
  await entered.promise;
  const second = queuedFirst ? scanner.runCompleteScan() : scanner.queue();
  await tick(); assert.deepEqual(calls, [1]); release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.deepEqual(calls, [1, 2]);
  assert.equal((queuedFirst ? results[0] : results[1]).status, 'completed'); await scanner.close();
});

test('task progress is monotonic while the lifecycle receives one bound operation signal', async t => {
  const values = [], errors = [], controller = new AbortController();
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  let lifecycleEntered = false;
  const scanner = scannerFor(async options => {
    lifecycleEntered = true;
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
    for (const value of [-5, 5.5, 2, NaN, Infinity, 96, 100, 20]) options.reportProgress(value, { phase: value });
    return { completed: true };
  }, { onError: error => errors.push(error) });
  assert.deepEqual(await scanner.runCompleteScan({ signal: controller.signal, reportProgress: value => values.push(value) }), { completed: true });
  assert.deepEqual(values, [0, 5.5, 5.5, 5.5, 5.5, 96, 99, 99]);
  lifecycleEntered = false;
  await assert.rejects(scanner.runCompleteScan({ reportProgress: {} }), { message: 'Library scan progress reporter must be a function.' });
  assert.equal(lifecycleEntered, false);
  assert.deepEqual(await scanner.runCompleteScan(), { completed: true }); assert.equal(lifecycleEntered, true);
  await scanner.close();
});

for (const asynchronous of [false, true]) test('progress observer errors cannot replace lifecycle work: ' + asynchronous, async t => {
  const errors = [], failure = new Error('Observer failed'); let finished = false, observerEntered = false;
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  const scanner = scannerFor(async ({ reportProgress }) => { reportProgress(50); finished = true; }, { onError: error => errors.push(error) });
  const rejectProgress = () => { observerEntered = true; throw failure; };
  await scanner.runCompleteScan({ reportProgress: asynchronous ? async () => rejectProgress() : rejectProgress });
  await tick(); assert.equal(finished, true); assert.equal(observerEntered, true);
  await scanner.close();
});

test('final admission requires every stage including an active directory monitor', async () => {
  const stages = Object.fromEntries(Object.keys(libraryScanCapabilities).filter(key => typeof libraryScanCapabilities[key] === 'boolean' && key !== 'completeLibraryScan').map(key => [key, true]));
  const scopes = ['books', 'photos'];
  for (const missing of [null, ...Object.keys(stages)]) {
    const capabilities = { ...stages, productionMediaScopes: scopes, ...(missing ? { [missing]: false } : {}) };
    const scanner = scannerFor(async () => {}, { capabilities });
    assert.equal(scanner.capabilities.completeLibraryScan, missing === null, String(missing));
    assert.equal(scanner.capabilities.scope, 'aggregate-folder-validation');
    assert.ok(Object.isFrozen(scanner.capabilities)); assert.ok(Object.isFrozen(scanner.capabilities.productionMediaScopes));
    capabilities.productionMediaScopes = []; assert.deepEqual(scanner.capabilities.productionMediaScopes, scopes);
    await scanner.close();
  }
  const inert = scannerFor(async () => {}); assert.equal(inert.capabilities.completeLibraryScan, false); await inert.close();
});

test('successful receipts capture immutable lifecycle diagnostics', async () => {
  const result = { children: [{ Id: 'a', metadata: { refreshed: true } }] };
  const scanner = scannerFor(async () => result);
  const receipt = await scanner.queue(); result.children[0].metadata.refreshed = false; result.children.push({ Id: 'b' });
  assert.deepEqual(receipt.result, { children: [{ Id: 'a', metadata: { refreshed: true } }] });
  assert.ok(Object.isFrozen(receipt.result.children[0].metadata)); await scanner.close();
});

test('explicit lifecycle failure preserves its values while queued failure records partial diagnostics', async t => {
  const failure = Object.assign(new Error('Late lifecycle failure'), { code: 'late-failure', partialResult: { committed: ['ancestor'] } });
  const errors = [], scanner = scannerFor(async () => { throw failure; }, { onError: error => errors.push(error) });
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  await assert.rejects(scanner.runCompleteScan(), { code: failure.code, message: failure.message,
    partialResult: { committed: ['ancestor'] } });
  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.code, 'late-failure'); assert.equal(receipt.error.message, failure.message);
  assert.deepEqual(receipt.partialResult, { committed: ['ancestor'] }); failure.partialResult.committed.push('later');
  assert.deepEqual(receipt.partialResult, { committed: ['ancestor'] });
  await scanner.close();
});

test('queued aggregate failures preserve the failed receipt and remain retryable', async t => {
  const causes = [new Error('first'), new Error('second')], errors = []; let fail = true;
  const scanner = scannerFor(async () => { if (fail) throw new AggregateError(causes, 'Global failure'); return 'recovered'; }, { onError: error => errors.push(error) });
  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.message, 'Global failure');
  t.diagnostic(inspect({ receipt, diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null }));
  fail = false; assert.equal((await scanner.queue()).result, 'recovered'); await scanner.close();
});

test('an ordinary failure that wins the close race remains a failure', async t => {
  const entered = Promise.withResolvers(), operation = Promise.withResolvers(), failure = new Error('I/O failed before abort'), errors = [];
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  const scanner = scannerFor(async () => { entered.resolve(); return operation.promise; }, { onError: error => errors.push(error) });
  const receipt = scanner.queue(); await entered.promise; operation.reject(failure); const closing = scanner.close();
  const result = await receipt;
  assert.equal(result.status, 'failed'); assert.equal(result.error.message, failure.message); await closing;
});

for (const hostile of ['accessors', 'revoked-partial', 'diagnostic-iterator', 'revoked-diagnostics']) test('hostile error diagnostics cannot orphan queued work: ' + hostile, async t => {
  const errors = [], diagnostic = new Error('Preserved diagnostic'); let failure;
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  if (hostile === 'accessors') {
    failure = {}; for (const key of ['name', 'code', 'message']) Object.defineProperty(failure, key, { get() { throw new Error('Accessor failed'); } });
  } else if (hostile === 'revoked-partial') {
    const proxy = Proxy.revocable({}, {}); proxy.revoke(); failure = Object.assign(new Error('Failed'), { partialResult: proxy.proxy });
  } else {
    let scanErrors;
    if (hostile === 'revoked-diagnostics') { const proxy = Proxy.revocable([], {}); proxy.revoke(); scanErrors = proxy.proxy; }
    else scanErrors = new Proxy([diagnostic], { get(target, key, receiver) { if (key === Symbol.iterator) throw new Error('Iterator failed'); return Reflect.get(target, key, receiver); } });
    failure = Object.assign(cancelled('Cancelled with diagnostics'), { details: { scanErrors } });
  }
  const scanner = scannerFor(async () => { throw failure; }, { onError: error => errors.push(error) });
  const receipt = await scanner.queue(); assert.equal(receipt.status, hostile.includes('diagnostic') ? 'cancelled' : 'failed');
  if (hostile === 'revoked-partial') assert.equal(receipt.partialResult, undefined);
  await scanner.close();
});

test('error reporter rejection cannot strand a queued generation', async () => {
  const scanner = scannerFor(async () => { throw new Error('Failure'); }, { onError: async () => { throw new Error('Reporter failed'); } });
  assert.equal((await scanner.queue()).status, 'failed'); await scanner.close();
});

test('pre-cancelled callers never invoke the lifecycle', async () => {
  let count = 0; const controller = new AbortController(); controller.abort();
  const scanner = scannerFor(async () => { count++; });
  await assert.rejects(scanner.runCompleteScan({ signal: controller.signal }), error => error.code === 'cancelled');
  assert.equal(count, 0); await scanner.close();
});

test('close aborts the active lifecycle, cancels pending work and waits for cleanup', async () => {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers(); let count = 0;
  const scanner = scannerFor(async ({ signal }) => {
    count++; entered.resolve();
    try { await waitForAbort(signal); } finally { aborted.resolve(); await release.promise; }
  });
  const first = scanner.queue(); await entered.promise;
  const second = scanner.queue(); const closing = scanner.close(); await aborted.promise;
  let settled = false; closing.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  assert.equal((await second).status, 'cancelled'); release.resolve(); await closing;
  assert.equal((await first).status, 'cancelled'); assert.equal(count, 1); await scanner.close();
  assert.throws(() => scanner.queue(), error => error.code === 'closed');
  await assert.rejects(scanner.runCompleteScan(), error => error.code === 'closed');
});

test('caller cancellation reaches the bound lifecycle signal', async () => {
  const entered = Promise.withResolvers(), controller = new AbortController();
  const scanner = scannerFor(async ({ signal }) => { entered.resolve(); await waitForAbort(signal); });
  const operation = scanner.runCompleteScan({ signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(operation, error => error.code === 'cancelled'); await scanner.close();
});

test('active collaborators fail fast on nested queue, complete scan and idle waiting', async () => {
  let scanner;
  scanner = scannerFor(async () => {
    assert.throws(() => scanner.queue(), error => error.code === 'invalid-operation');
    await assert.rejects(scanner.runCompleteScan(), error => error.code === 'invalid-operation');
    await assert.rejects(scanner.whenIdle(), error => error.code === 'invalid-operation');
  });
  assert.equal((await scanner.queue()).status, 'completed'); await scanner.close();
});

test('a collaborator can await close without waiting on its own operation', async () => {
  let scanner; scanner = scannerFor(async () => { await scanner.close(); });
  assert.equal((await scanner.queue()).status, 'cancelled'); await scanner.close();
});

test('nested scanner instances retain active ancestors for reentrant close', async () => {
  let outer;
  const inner = scannerFor(async () => { await outer.close(); });
  outer = scannerFor(async () => { await inner.runCompleteScan(); });
  await assert.rejects(outer.runCompleteScan(), error => error.code === 'cancelled'); await Promise.all([outer.close(), inner.close()]);
});

test('inactive asynchronous descendants may enqueue a later scan', async () => {
  const release = Promise.withResolvers(), descendant = Promise.withResolvers(); let count = 0, scanner;
  scanner = scannerFor(async () => {
    if (++count === 1) setImmediate(async () => { await release.promise; try { descendant.resolve(await scanner.queue()); } catch (error) { descendant.reject(error); } });
  });
  await scanner.runCompleteScan(); release.resolve(); assert.equal((await descendant.promise).status, 'completed');
  assert.equal(count, 2); await scanner.close();
});

test('close from an inactive scan descendant drains a later active operation', async () => {
  const invoke = Promise.withResolvers(), finished = Promise.withResolvers(), entered = Promise.withResolvers(); let count = 0, scanner;
  scanner = scannerFor(async ({ signal }) => {
    if (++count === 1) setImmediate(async () => { await invoke.promise; await scanner.close(); finished.resolve(); });
    else { entered.resolve(); await waitForAbort(signal); }
  });
  await scanner.runCompleteScan(); let settled = false;
  const second = scanner.runCompleteScan().finally(() => { settled = true; }); const rejected = assert.rejects(second, error => error.code === 'cancelled');
  await entered.promise; invoke.resolve(); await finished.promise; assert.equal(settled, true); await rejected;
});
