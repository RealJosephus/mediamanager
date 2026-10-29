import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { LibraryScanLifecycle, LibraryScanService } from '../../src/library/index.js';
import { updateInheritedValues } from '../../src/library/item-persistence.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { checkAbort, StorageError } from '../../src/storage/errors.js';
import { scanChildScope } from './scan-child-scope-fixture.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/library-scan-lifecycle/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
const errorDetails = error => error == null ? null : { name: error.name, message: error.message, stack: error.stack, ...error };
const functionalOutcome = ({ exception, calls, ...value }) => ({ ...value, failed: exception != null,
  ...(calls ? { calls: calls.filter(call => call.action !== 'logged-error') } : {}) });
const comparison = ({ actual, expected, t }) => {
  if (t) observeComparison(t, actual.name, actual, expected);
  assert.deepEqual(functionalOutcome(actual), functionalOutcome(expected));
};
const modes = { None: 0, ValidationOnly: 1, Default: 2, FullRefresh: 3 };

test('native scan lifecycle binds the real manager, ignore cache, directories and EF cleanup', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '29c34541350089dc0522c4309ecd617e78fd402774681f32491d089803939c03');
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(native.results.length, 22); assert.equal(input.length, native.results.length);
  assert.equal(new Set(input.map(sample => sample.name)).size, input.length);
  assert.deepEqual(input.map(sample => sample.name), native.results.map(sample => sample.name));
});

test('scan comparison detects lost restoration, progress and retained SQL maps', () => {
  for (const name of ['empty-post-scan', 'two-post-tasks', 'inherited-links-clear']) {
    const expected = native.results.find(sample => sample.name === name), actual = structuredClone(expected);
    if (name === 'inherited-links-clear') actual.maps.push({ itemId: 'missing', itemValueId: 'unexpected' });
    else if (name === 'two-post-tasks') actual.progress[4] = 50;
    else actual.calls = actual.calls.filter(call => call.action !== 'monitor-start');
    assert.throws(() => comparison({ actual, expected }), { code: 'ERR_ASSERTION' });
  }
});

function lifecycleFor(sample) {
  const calls = [], progress = [], diagnostics = [], injectedFailures = [], controller = new AbortController();
  const ioFailure = message => {
    const error = Object.assign(new Error(message), { code: 'io' });
    injectedFailures.push(errorDetails(error)); return error;
  };
  const aggregate = { Name: 'aggregate', Type: 'AggregateFolder', IsFolder: true };
  const userRoot = { Name: 'user-root', Type: 'UserRootFolder', IsFolder: true };
  const children = (sample.collections ?? []).map(value => ({ ...value, Id: value.id, Name: value.name, Type: 'CollectionFolder', IsFolder: true }));
  if (sample.ordinaryChild) children.push({ Name: 'ordinary', Type: 'Folder', IsFolder: true });
  let cacheEmpty = false, lifecycle;
  const trace = (action, item = null) => calls.push({ action, item, scanRunning: lifecycle.isScanRunning, cacheEmpty });
  const control = (action, item) => {
    trace(action, item);
    if (sample.cancelAt === action) controller.abort(new StorageError('cancelled', 'Controlled cancellation'));
    checkAbort(controller.signal);
    if (sample.failure === action) throw ioFailure('Controlled failure');
    cacheEmpty = false;
  };
  const host = {
    getAggregateFolder: async () => aggregate,
    getUserRootFolder: async () => userRoot,
    clearIgnoreRuleCache() { cacheEmpty = true; },
    invalidateChildren() {},
    async refreshMetadata(item) { control('refresh-' + item.Name, item.Name); },
    async validateChildren(item, options) {
      control(item === aggregate ? options.recursive ? 'recursive-aggregate' : 'validate-aggregate' : 'validate-user-root', item.Name);
      calls.push({ action: 'validation-options', item: item.Name, recursive: options.recursive,
        refreshChildMetadata: options.refreshChildMetadata ?? false,
        allowRemoveRoot: options.allowRemoveRoot, MetadataRefreshMode: modes[options.MetadataRefreshMode],
        ImageRefreshMode: modes[options.ImageRefreshMode], IsAutomated: options.IsAutomated, ForceSave: options.ForceSave });
      for (const value of options.recursive ? [0, 25, 100] : [50]) options.reportProgress(value);
      return { structurallyComplete: true, incompleteReasons: [] };
    },
    getChildren: async () => children,
    collectionDirectoryExists: async item => item.exists,
    async deleteCollections(ids) { calls.push({ action: 'delete-collections', ids }); control('delete-collections'); },
    async updateInheritedValues() { control('update-inherited'); }
  };
  host.withChildren = scanChildScope(host);
  const monitor = Object.fromEntries(['stop', 'start'].map(name => [name, async () => {
    trace('monitor-' + name);
    if (sample.failure === 'monitor-' + name) throw ioFailure('Controlled monitor failure');
  }]));
  const postScanTasks = (sample.postTasks ?? []).map(value => ({ name: value.name, async run({ reportProgress }) {
    control('post-' + value.name);
    if (value.replaceTasks) lifecycle.postScanTasks = [];
    for (const percent of value.progress ?? []) reportProgress(percent);
  } }));
  lifecycle = new LibraryScanLifecycle({ host, monitor, postScanTasks, logger: { error: (error, message) => diagnostics.push({ error: errorDetails(error), message }) } });
  if (sample.cancelled) controller.abort(new StorageError('cancelled', 'Controlled cancellation'));
  return { lifecycle, host, calls, progress, controller, diagnostics, injectedFailures, cacheEmpty: () => cacheEmpty };
}

for (const sample of input.filter(sample => sample.mode !== 'inheritance')) test(`native library scan lifecycle: ${sample.name}`, async t => {
  const fixture = lifecycleFor(sample);
  let exception = null;
  try {
    const options = { signal: fixture.controller.signal, reportProgress: value => fixture.progress.push(value) };
    if (sample.mode === 'top') await fixture.lifecycle.validateTopLibraryFolders({ ...options, removeRoot: sample.removeRoot });
    else await fixture.lifecycle.run(options);
  } catch (error) { exception = errorDetails(error); }
  const expected = native.results.find(value => value.name === sample.name);
  const expectedCancelled = Boolean(sample.cancelled || sample.cancelAt && expected.calls.some(call => call.action === sample.cancelAt));
  assert.equal(fixture.controller.signal.aborted, expectedCancelled);
  if (exception) {
    if (expectedCancelled) assert.equal(exception.code, 'cancelled');
    else assert.ok(fixture.injectedFailures.some(error => error.code === exception.code && error.message === exception.message),
      'Only an actually reached controlled I/O failure may reject this scenario.');
  }
  observeComparison(t, sample.name + ' raw failures', { exception, diagnostics: fixture.diagnostics },
    { exception: expected.exception, diagnostics: expected.calls.filter(call => call.action === 'logged-error') });
  const actual = { name: sample.name, exception, calls: fixture.calls, progress: fixture.progress,
    scanRunning: fixture.lifecycle.isScanRunning, cacheEmpty: fixture.cacheEmpty() };
  comparison({ actual, expected, t });
});

test('post-scan caller cancellation with an arbitrary reason stops later tasks and inherited cleanup', async t => {
  const fixture = lifecycleFor({});
  t.after(() => t.diagnostic(inspect({ diagnostics: fixture.diagnostics }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  const reason = Object.assign(new Error('Controlled caller cancellation'), { code: 'controlled-caller-cancellation' });
  let laterTaskRan = false;
  fixture.lifecycle.postScanTasks = [{ name: 'Cancelling', async run() {
    fixture.controller.abort(reason); fixture.controller.signal.throwIfAborted();
  } }, { name: 'Later', async run() { laterTaskRan = true; } }];
  await assert.rejects(fixture.lifecycle.runPostScanTasks({ signal: fixture.controller.signal }), error => {
    assert.equal(fixture.controller.signal.aborted, true); assert.equal(error.code, reason.code);
    assert.equal(error.message, reason.message); return true;
  });
  assert.equal(laterTaskRan, false); assert.deepEqual(fixture.calls, []);
});

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2025-01-02 03:04:05' : column.nullable ? null
      : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
  }));
}

async function databaseFor(t, dialect) {
  const schema = 'scan_lifecycle_' + randomUUID().replaceAll('-', '').slice(0, 18);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => {
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await store.close();
  });
  return { database, store, schema };
}

for (const dialect of ['postgres']) for (const sample of input.filter(sample => sample.mode === 'inheritance')) {
  test(`${dialect}: native inherited-link cleanup ${sample.name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, store, schema } = await databaseFor(t, dialect);
    const ids = ['97020000-0000-0000-0000-000000000001', '97020000-0000-0000-0000-000000000002'];
    for (const [index, Id] of ids.entries()) await database.insert('BaseItems', { ...blank('BaseItems'), Id,
      Type: index ? 'MediaBrowser.Controller.Entities.Movies.Movie' : 'MediaBrowser.Controller.Entities.Folder', Name: index ? 'Two' : 'One' });
    for (const value of sample.values) {
      await database.insert('ItemValues', { ItemValueId: value.id, Type: value.type, Value: value.value, CleanValue: value.value.toLowerCase() });
      for (const index of value.items) await database.insert('ItemValuesMap', { ItemId: ids[index], ItemValueId: value.id });
    }
    const originalItems = await database.rows('BaseItems');
    if (sample.sqlFailure) {
      await database.client.query(`CREATE FUNCTION "${schema}".fail_inherited_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled inherited delete failure'; END $$`);
      await database.client.query(`CREATE TRIGGER fail_inherited_delete AFTER DELETE ON "${schema}"."ItemValuesMap" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_inherited_delete()`);
    }
    let exception = null;
    try { for (let iteration = 0; iteration < (sample.repeat ?? 1); iteration++) await updateInheritedValues(store); }
    catch (error) {
      assert.equal(sample.sqlFailure, true);
      assert.equal(error.code, 'P0001');
      exception = errorDetails(error);
    }
    const values = (await database.rows('ItemValues')).map(value => ({ id: value.ItemValueId.toLowerCase(), type: value.Type, value: value.Value, cleanValue: value.CleanValue })).sort((a, b) => a.id.localeCompare(b.id));
    const maps = (await database.rows('ItemValuesMap')).map(row => ({ itemId: row.ItemId.toLowerCase(), itemValueId: row.ItemValueId.toLowerCase() })).sort((a, b) => a.itemId.localeCompare(b.itemId) || a.itemValueId.localeCompare(b.itemValueId));
    comparison({ actual: { name: sample.name, exception, values, maps }, expected: native.results.find(value => value.name === sample.name), t });
    assert.deepEqual(await database.rows('BaseItems'), originalItems);
  });
}


test('global coordinator delegates recursive aggregate traversal to the native lifecycle', async () => {
  const fixture = lifecycleFor({ postTasks: [{ name: 'a', progress: [100, 0, 50] }, { name: 'b', progress: [100] }] });
  const reported = [], scanner = new LibraryScanService({ lifecycle: fixture.lifecycle });
  const result = await scanner.runCompleteScan({ reportProgress: value => reported.push(value) });
  await scanner.close(); assert.equal(result, null);
  assert.equal(scanner.capabilities.completeLibraryScan, false);
  assert.deepEqual(fixture.calls.filter(call => /recursive-aggregate|post-|update-inherited|monitor-/.test(call.action)).map(call => call.action),
    ['monitor-stop', 'recursive-aggregate', 'post-a', 'post-b', 'update-inherited', 'monitor-start']);
  assert.ok(reported.every((value, index) => value >= 0 && value <= 99 && (!index || value >= reported[index - 1])));
  assert.ok(reported.includes(96)); assert.equal(reported.at(-1), 99);
});

test('an uncaught aggregate validation failure restores monitoring and prevents post-scan cleanup', async () => {
  const fixture = lifecycleFor({ postTasks: [{ name: 'a' }] });
  const validate = fixture.host.validateChildren;
  fixture.host.validateChildren = async (item, options) => {
    if (options.recursive) throw Object.assign(new Error('Failed aggregate scan'), { code: 'aggregate-scan-failed' });
    return validate(item, options);
  };
  const scanner = new LibraryScanService({ lifecycle: fixture.lifecycle });
  await assert.rejects(scanner.runCompleteScan(), { code: 'aggregate-scan-failed' }); await scanner.close();
  assert.equal(fixture.calls.at(-1).action, 'monitor-start'); assert.equal(fixture.lifecycle.isScanRunning, false);
  assert.ok(!fixture.calls.some(call => call.action.startsWith('post-') || call.action === 'update-inherited'));
});

test('a queued replacement drains the cancelled lifecycle before starting its successor', async () => {
  const fixture = lifecycleFor({ postTasks: [{ name: 'a' }] }), started = Promise.withResolvers();
  const validate = fixture.host.validateChildren; let recursiveCalls = 0;
  fixture.host.validateChildren = async (item, options) => {
    if (options.recursive && ++recursiveCalls === 1) {
      started.resolve();
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new StorageError('cancelled', 'Superseded scan')), { once: true }));
    }
    return validate(item, options);
  };
  const scanner = new LibraryScanService({ lifecycle: fixture.lifecycle });
  const first = scanner.queue(); await started.promise; const second = scanner.queue();
  assert.equal((await first).status, 'cancelled'); assert.equal((await second).status, 'completed'); await scanner.close();
  assert.deepEqual(fixture.calls.filter(call => /post-|update-inherited|monitor-/.test(call.action)).map(call => call.action),
    ['monitor-stop', 'monitor-start', 'monitor-stop', 'post-a', 'update-inherited', 'monitor-start']);
  assert.equal(fixture.lifecycle.isScanRunning, false);
});

test('progress observer rejection cannot prevent post-scan work or monitor restoration', async t => {
  const fixture = lifecycleFor({ postTasks: [{ name: 'a', progress: [50, 100] }] }), errors = [];
  t.after(() => t.diagnostic(inspect({ diagnostics: errors }, { depth: null, maxArrayLength: null, maxStringLength: null })));
  let observerEntered = false;
  const scanner = new LibraryScanService({ lifecycle: fixture.lifecycle, onError: error => errors.push(error.message) });
  const result = await scanner.runCompleteScan({ reportProgress: async () => { observerEntered = true; throw new Error('Observer rejected progress'); } });
  await scanner.close(); assert.equal(result, null);
  assert.equal(observerEntered, true);
  assert.equal(fixture.calls.at(-1).action, 'monitor-start'); assert.ok(fixture.calls.some(call => call.action === 'update-inherited'));
});
