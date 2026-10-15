import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryScanService, LibraryService } from '../../src/library/index.js';
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

function structurallyComplete(result = {}) {
  return { ...result, structurallyComplete: true, incompleteReasons: Object.freeze([]) };
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

test('library scan generations cancel stale roots and restart from the newest root snapshot', async () => {
  const roots = {
    current: [{ Id: 'first' }, { Id: 'stale-pending' }]
  };
  const calls = [];
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let first = true;
  const folderScanner = {
    supports: () => true,
    scan(root, { signal }) {
      calls.push(root.Id);
      if (first) {
        first = false;
        firstStarted();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new StorageError('cancelled', 'superseded')), { once: true }));
      }
      return Promise.resolve(structurallyComplete());
    }
  };
  const library = { getPhysicalScanRoots: async () => roots.current };
  const errors = [];
  const scanner = new LibraryScanService({ library, folderScanner, onError: error => errors.push(error) });

  const superseded = scanner.queue();
  await started;
  roots.current = [{ Id: 'latest' }];
  const latest = scanner.queue();
  await scanner.whenIdle();

  assert.deepEqual(calls, ['first', 'latest']);
  assert.deepEqual(errors, []);
  assert.deepEqual(await superseded, {
    generation: 1,
    status: 'cancelled',
    error: { name: 'StorageError', code: 'cancelled', message: 'superseded' }
  });
  assert.deepEqual(await latest, {
    generation: 2,
    status: 'completed',
    result: {
      rootCount: 1,
      completedRootCount: 1,
      roots: [{ index: 0, itemId: 'latest', path: null, result: structurallyComplete() }],
      structurallyComplete: true,
      incompleteRoots: []
    }
  });
  assert.equal(scanner.capabilities.completeLibraryScan, false);
  await scanner.close();
});

test('multiple pending queue generations are superseded individually before the newest snapshot runs', async () => {
  let discoveries = 0;
  const scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discoveries++;
        return [{ Id: 'newest' }];
      }
    },
    folderScanner: { supports: () => true, scan: async () => structurallyComplete({ added: 0 }) }
  });

  const first = scanner.queue();
  const second = scanner.queue();
  const third = scanner.queue();
  await scanner.whenIdle();

  assert.equal((await first).generation, 1);
  assert.equal((await first).status, 'cancelled');
  assert.equal((await second).generation, 2);
  assert.equal((await second).status, 'cancelled');
  assert.equal((await third).generation, 3);
  assert.equal((await third).status, 'completed');
  assert.equal(discoveries, 1);
  await scanner.close();
});

test('queued and explicit operations serialize complete multi-root snapshots', async () => {
  let discovery = 0;
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discovery++;
        return discovery === 1 ? [{ Id: 'direct-first' }, { Id: 'direct-second' }] : [{ Id: 'queued' }];
      }
    },
    folderScanner: {
      supports: () => true,
      async scan(root) {
        calls.push(root.Id);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (root.Id === 'direct-first') {
            entered.resolve();
            await release.promise;
          }
          await new Promise(resolve => setImmediate(resolve));
          return structurallyComplete({ added: 0 });
        } finally { active--; }
      }
    }
  });

  const direct = scanner.runCompleteScan();
  await entered.promise;
  const queued = scanner.queue();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['direct-first']);
  release.resolve();

  assert.equal((await direct).completedRootCount, 2);
  assert.equal((await queued).status, 'completed');
  await scanner.whenIdle();
  assert.deepEqual(calls, ['direct-first', 'direct-second', 'queued']);
  assert.equal(maxActive, 1);
  await scanner.close();
});

test('an earlier queue call reserves the scan tail before a following direct call', async () => {
  let discovery = 0;
  const calls = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discovery++;
        return [{ Id: discovery === 1 ? 'queued-first' : 'direct-second' }];
      }
    },
    folderScanner: {
      supports: () => true,
      async scan(root) {
        calls.push(root.Id);
        if (root.Id === 'queued-first') {
          entered.resolve();
          await release.promise;
        }
        return structurallyComplete();
      }
    }
  });

  const queued = scanner.queue();
  const direct = scanner.runCompleteScan();
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['queued-first']);
  release.resolve();

  assert.equal((await queued).status, 'completed');
  assert.equal((await direct).roots[0].itemId, 'direct-second');
  assert.deepEqual(calls, ['queued-first', 'direct-second']);
  await scanner.close();
});

test('close waits for a running explicit operation and its queued tail before settling', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let discoveries = 0;
  const scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discoveries++;
        return [{ Id: 'blocking' }];
      }
    },
    folderScanner: {
      supports: () => true,
      async scan() {
        entered.resolve();
        await release.promise;
      }
    }
  });

  const direct = scanner.runCompleteScan();
  await entered.promise;
  const queued = scanner.queue();
  let closed = false;
  const closing = scanner.close().finally(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();

  await assert.rejects(direct, error => error.code === 'cancelled');
  assert.equal((await queued).status, 'cancelled');
  await closing;
  assert.equal(closed, true);
  assert.equal(discoveries, 1, 'the cancelled queued operation never takes a second root snapshot');
});

test('explicit complete scan returns a deeply frozen result and only reports monotonic nonterminal progress', async () => {
  const roots = [{ Id: 'first', Path: 'Z:\\First' }, { Id: 'second', Path: 'Z:\\Second' }];
  const sourceResults = new Map(roots.map((root, index) => [root.Id,
    structurallyComplete({ added: index + 1, nested: { stable: true } })]));
  const progress = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => roots },
    folderScanner: {
      supports: () => true,
      scan: async root => sourceResults.get(root.Id)
    }
  });

  const result = await scanner.runCompleteScan({
    reportProgress(value, detail) { progress.push({ value, detail }); }
  });

  assert.deepEqual(result, {
    rootCount: 2,
    completedRootCount: 2,
    roots: [
      { index: 0, itemId: 'first', path: 'Z:\\First', result: structurallyComplete({ added: 1, nested: { stable: true } }) },
      { index: 1, itemId: 'second', path: 'Z:\\Second', result: structurallyComplete({ added: 2, nested: { stable: true } }) }
    ],
    structurallyComplete: true,
    incompleteRoots: []
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.roots));
  assert.ok(result.roots.every(root => Object.isFrozen(root) && Object.isFrozen(root.result)
    && Object.isFrozen(root.result.nested)));
  assert.deepEqual(progress.map(entry => entry.value), [0, 49.5, 99]);
  assert.ok(progress.every(entry => Number.isFinite(entry.value) && entry.value >= 0 && entry.value < 100));
  assert.ok(progress.every((entry, index) => index === 0 || entry.value >= progress[index - 1].value));
  assert.ok(progress.every(entry => Object.isFrozen(entry.detail)));
  assert.equal(scanner.capabilities.completeLibraryScan, false);
  assert.equal(scanner.capabilities.scansMediaFiles, false);
  await scanner.close();
});

test('an incomplete root rejects an explicit multi-root scan with a deeply frozen partial result', async () => {
  const reasons = [{ code: 'weak-directory-snapshot', itemId: 'weak', path: '/weak' }];
  const calls = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [
      { Id: 'complete', Path: '/complete' },
      { Id: 'weak', Path: '/weak' },
      { Id: 'never-reached', Path: '/never-reached' }
    ] },
    folderScanner: {
      supports: () => true,
      async scan(root) {
        calls.push(root.Id);
        return root.Id === 'weak'
          ? { structurallyComplete: false, incompleteReasons: reasons, retained: { count: 1 } }
          : structurallyComplete({ retained: { count: 0 } });
      }
    }
  });

  let failure;
  await assert.rejects(scanner.runCompleteScan(), error => {
    failure = error;
    return error.code === 'incomplete-library-scan';
  });
  assert.deepEqual(calls, ['complete', 'weak']);
  assert.equal(failure.name, 'StorageError');
  assert.equal(failure.partialResult.rootCount, 3);
  assert.equal(failure.partialResult.completedRootCount, 2);
  assert.equal(failure.partialResult.structurallyComplete, false);
  assert.deepEqual(failure.partialResult.incompleteRoots, [{
    index: 1, itemId: 'weak', path: '/weak', incompleteReasons: reasons
  }]);
  assert.ok(Object.isFrozen(failure.partialResult));
  assert.ok(Object.isFrozen(failure.partialResult.roots));
  assert.ok(Object.isFrozen(failure.partialResult.roots[1].result));
  assert.ok(Object.isFrozen(failure.partialResult.roots[1].result.retained));
  assert.ok(Object.isFrozen(failure.partialResult.incompleteRoots));
  assert.ok(Object.isFrozen(failure.partialResult.incompleteRoots[0]));
  assert.ok(Object.isFrozen(failure.partialResult.incompleteRoots[0].incompleteReasons));
  assert.ok(Object.isFrozen(failure.partialResult.incompleteRoots[0].incompleteReasons[0]));
  await scanner.close();
});

test('queued incomplete roots finish the snapshot as failed and do not strand the next generation', async () => {
  let weak = true;
  const calls = [];
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'first' }, { Id: 'second' }] },
    folderScanner: {
      supports: () => true,
      async scan(root) {
        calls.push(root.Id);
        if (weak) return {
          structurallyComplete: false,
          incompleteReasons: [{
            code: 'empty-top-folder-protected', itemId: root.Id, path: `/${root.Id}`
          }]
        };
        return structurallyComplete();
      }
    },
    onError: error => reported.push(error)
  });

  const incomplete = await scanner.queue();
  assert.equal(incomplete.status, 'failed');
  assert.equal(incomplete.error.name, 'StorageError');
  assert.equal(incomplete.error.code, 'incomplete-library-scan');
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, 'incomplete-library-scan');
  assert.equal(reported[0].partialResult.completedRootCount, 2);
  assert.equal(reported[0].partialResult.structurallyComplete, false);
  assert.equal(reported[0].partialResult.incompleteRoots.length, 2);

  weak = false;
  const recovered = await scanner.queue();
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.structurallyComplete, true);
  assert.deepEqual(calls, ['first', 'second', 'first', 'second']);
  await scanner.close();
});

test('completeLibraryScan stays gated by every explicit production stage', async () => {
  const productionMediaScopes = ['movies', 'homevideos'];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [] },
    folderScanner: {
      supports: () => true,
      scan: async () => structurallyComplete(),
      capabilities: {
        structuralCompletenessProof: true,
        directStructuralRoots: true,
        scansMediaFiles: true,
        typeReclassification: true,
        secondaryOwnershipTransfer: true,
        groupedOwnership: true,
        relationshipRows: true,
        resolvesProductionMediaFiles: true,
        productionMediaScopes
      }
    }
  });

  assert.equal(scanner.capabilities.structuralCompletenessProof, true);
  assert.equal(scanner.capabilities.resolvesProductionMediaFiles, true);
  assert.equal(scanner.capabilities.reconcilesTopLevelConfiguration, false);
  assert.equal(scanner.capabilities.directStructuralRoots, true);
  assert.equal(scanner.capabilities.runsMetadataProbeRefresh, false);
  assert.equal(scanner.capabilities.runsPostScanTasks, false);
  assert.equal(scanner.capabilities.completeLibraryScan, false);
  assert.deepEqual(scanner.capabilities.productionMediaScopes, productionMediaScopes);
  assert.ok(Object.isFrozen(scanner.capabilities.productionMediaScopes));
  productionMediaScopes.push('mutated-after-construction');
  assert.deepEqual(scanner.capabilities.productionMediaScopes, ['movies', 'homevideos']);
  await scanner.close();
});

test('metadata failures retain the independent structural receipt and fail explicit library scanning', async () => {
  const root = { Id: 'metadata-root', Path: '/metadata-root' };
  const metadata = { root: { Failures: 0 }, children: { errors: [{ itemId: 'leaf', code: 'not-supported' }], providerFailures: 0 } };
  const scanner = new LibraryScanService({ library: { getPhysicalScanRoots: async () => [root] },
    folderScanner: { supports: () => true, scan: async () => structurallyComplete({ metadataComplete: false, metadata }) } });
  await assert.rejects(scanner.runCompleteScan(), error => {
    assert.equal(error.code, 'metadata-scan-failed');
    assert.equal(error.partialResult.structurallyComplete, true);
    assert.deepEqual(error.partialResult.roots[0].result.metadata, metadata);
    assert.equal(error.partialResult.roots[0].result.metadataComplete, false);
    return true;
  });
  await scanner.close();
});

test('a queued library scan continues later roots and fails when a structurally complete root has metadata errors', async () => {
  const calls = [], errors = [];
  const scanner = new LibraryScanService({ library: { getPhysicalScanRoots: async () => [{ Id: 'first' }, { Id: 'second' }] },
    folderScanner: { supports: () => true, scan: async root => {
      calls.push(root.Id); return structurallyComplete({ metadataComplete: root.Id === 'second', metadata: { children: { errors: [] } } });
    } }, onError: error => errors.push(error) });
  const result = await scanner.queue();
  assert.deepEqual(calls, ['first', 'second']); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'library-scan-failed');
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'metadata-scan-failed');
  assert.equal(result.partialResult.completedRootCount, 2); assert.equal(result.partialResult.structurallyComplete, true);
  assert.equal(errors[0].partialResult.completedRootCount, 1);
  await scanner.close();
});

test('explicit complete scan rejects unsupported roots and root failures without turning onError into success', async () => {
  const reported = [];
  const calls = [];
  const unsupported = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'first' }, { Id: 'unsupported' }, { Id: 'later' }] },
    folderScanner: {
      supports: root => root.Id !== 'unsupported',
      async scan(root) { calls.push(root.Id); return structurallyComplete({ added: 0 }); }
    },
    onError: error => reported.push(error)
  });
  await assert.rejects(unsupported.runCompleteScan(), error => error.code === 'invalid-response');
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(reported, []);
  await unsupported.close();

  const failure = new Error('root scan failed');
  const failing = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'failed' }, { Id: 'later' }] },
    folderScanner: { supports: () => true, scan: async () => { throw failure; } },
    onError: error => reported.push(error)
  });
  await assert.rejects(failing.runCompleteScan(), error => error === failure);
  assert.deepEqual(reported, []);
  await failing.close();
});

test('explicit complete scan isolates and reports progress observer failures', async () => {
  const failure = new Error('progress callback failed');
  const reported = [];
  const scans = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'only-root' }] },
    folderScanner: {
      supports: () => true,
      async scan(root) { scans.push(root.Id); return structurallyComplete({ added: 1 }); }
    },
    onError: error => reported.push(error)
  });

  const result = await scanner.runCompleteScan({
    reportProgress() { throw failure; }
  });
  assert.equal(result.completedRootCount, 1);
  assert.deepEqual(scans, ['only-root']);
  assert.deepEqual(reported, [failure, failure]);
  await scanner.close();
});

test('an asynchronous progress observer may await scanner close without deadlocking the scan', async () => {
  let closing;
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [] },
    folderScanner: { supports: () => true, scan: async () => {} }
  });

  const operation = scanner.runCompleteScan({
    reportProgress() { return closing ??= scanner.close(); }
  });
  const outcome = await Promise.race([
    operation.then(() => ({ status: 'resolved' }), error => ({ status: 'rejected', error })),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 250))
  ]);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error.code, 'cancelled');
  await closing;
});

for (const mode of ['supersede', 'close']) test(`queued scan reports an earlier root failure exactly once when a later root is cancelled by ${mode}`, async () => {
  const failure = new Error(`failure before ${mode}`);
  const entered = Promise.withResolvers();
  let roots = [{ Id: 'failed' }, { Id: 'blocking' }];
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => roots },
    folderScanner: {
      supports: () => true,
      scan(root, { signal }) {
        if (root.Id === 'failed') return Promise.reject(failure);
        if (root.Id === 'latest') return Promise.resolve(structurallyComplete());
        entered.resolve();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          reject(new StorageError('cancelled', mode));
        }, { once: true }));
      }
    },
    onError: error => reported.push(error)
  });

  const first = scanner.queue();
  await entered.promise;
  let second;
  if (mode === 'supersede') {
    roots = [{ Id: 'latest' }];
    second = scanner.queue();
  } else {
    await scanner.close();
  }
  assert.equal((await first).status, 'cancelled');
  if (second) assert.equal((await second).status, 'completed');
  assert.deepEqual(reported, [failure]);
  await scanner.close();
});

test('a root failure that wins before close remains failed and is reported once', async () => {
  const entered = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const failure = new Error('root failure won the shutdown race');
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'racing-root', Path: '/racing-root' }] },
    folderScanner: {
      supports: () => true,
      scan() {
        entered.resolve();
        return operation.promise;
      }
    },
    onError: error => reported.push(error)
  });

  const receipt = scanner.queue();
  await entered.promise;
  operation.reject(failure);
  const closing = scanner.close();

  assert.deepEqual(await receipt, {
    generation: 1,
    status: 'failed',
    partialResult: { rootCount: 1, completedRootCount: 0, roots: [], structurallyComplete: false, incompleteRoots: [] },
    error: {
      name: 'AggregateError',
      code: 'library-scan-failed',
      message: '1 physical library root failed to scan.'
    }
  });
  await closing;
  assert.deepEqual(reported, [failure]);
});

test('close preserves both an earlier root error and a later error that wins the abort race', async () => {
  const firstFailure = new Error('first root failed');
  const secondFailure = new Error('second root failed before abort');
  const entered = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'first' }, { Id: 'second' }] },
    folderScanner: {
      supports: () => true,
      scan(root) {
        if (root.Id === 'first') return Promise.reject(firstFailure);
        entered.resolve();
        return operation.promise;
      }
    },
    onError: error => reported.push(error)
  });

  const receipt = scanner.queue();
  await entered.promise;
  operation.reject(secondFailure);
  const closing = scanner.close();

  assert.equal((await receipt).status, 'failed');
  await closing;
  assert.deepEqual(reported, [firstFailure, secondFailure]);
});

test('hostile error accessors cannot strand a queued generation receipt', async () => {
  const hostile = {};
  Object.defineProperties(hostile, {
    name: { get() { throw new Error('name getter failed'); } },
    code: { get() { throw new Error('code getter failed'); } },
    message: { get() { throw new Error('message getter failed'); } }
  });
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => { throw hostile; } },
    folderScanner: { supports: () => true, scan: async () => {} },
    onError: error => reported.push(error)
  });

  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.error, { name: 'Error', code: null, message: '[object Object]' });
  assert.deepEqual(reported, [hostile]);
  await scanner.close();
});

test('a hostile cancellation diagnostic iterator cannot strand a queued receipt', async () => {
  const diagnostic = new Error('preserved diagnostic');
  const diagnostics = new Proxy([diagnostic], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error('iterator getter failed');
      return Reflect.get(target, property, receiver);
    }
  });
  const cancellation = Object.assign(new Error('cancelled with hostile diagnostics'), {
    code: 'cancelled',
    details: { scanErrors: diagnostics }
  });
  const reported = [];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'only-root' }] },
    folderScanner: { supports: () => true, scan: async () => { throw cancellation; } },
    onError: error => reported.push(error)
  });

  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'cancelled');
  assert.deepEqual(reported, [diagnostic]);
  await scanner.close();
});

test('a revoked cancellation diagnostic proxy cannot strand a queued receipt', async () => {
  const diagnostics = Proxy.revocable([], {});
  diagnostics.revoke();
  const cancellation = Object.assign(new Error('cancelled with revoked diagnostics'), {
    code: 'cancelled',
    details: { scanErrors: diagnostics.proxy }
  });
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'only-root' }] },
    folderScanner: { supports: () => true, scan: async () => { throw cancellation; } }
  });

  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'cancelled');
  await scanner.close();
});

test('asynchronous descendants of a completed scan are not treated as active re-entry', async () => {
  let scanner;
  let discovery = 0;
  const releaseDescendant = Promise.withResolvers();
  const descendant = Promise.withResolvers();
  scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discovery++;
        if (discovery === 1) {
          setImmediate(async () => {
            await releaseDescendant.promise;
            try { descendant.resolve(await scanner.queue()); }
            catch (error) { descendant.reject(error); }
          });
        }
        return [];
      }
    },
    folderScanner: { supports: () => true, scan: async () => {} }
  });

  await scanner.runCompleteScan();
  releaseDescendant.resolve();
  assert.equal((await descendant.promise).status, 'completed');
  assert.equal(discovery, 2);
  await scanner.close();
});

test('a completed scan descendant uses normal close draining for a later operation', async () => {
  let scanner;
  let discovery = 0;
  const invokeClose = Promise.withResolvers();
  const closeStarted = Promise.withResolvers();
  const closeFinished = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        discovery++;
        if (discovery === 1) {
          setImmediate(async () => {
            await invokeClose.promise;
            closeStarted.resolve();
            await scanner.close();
            closeFinished.resolve();
          });
          return [];
        }
        return [{ Id: 'blocking' }];
      }
    },
    folderScanner: {
      supports: () => true,
      scan(root, { signal }) {
        secondEntered.resolve(root);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          reject(new StorageError('cancelled', 'closed by stale descendant'));
        }, { once: true }));
      }
    }
  });

  await scanner.runCompleteScan();
  let secondSettled = false;
  const second = scanner.runCompleteScan().finally(() => { secondSettled = true; });
  const secondRejected = assert.rejects(second, error => error.code === 'cancelled');
  await secondEntered.promise;
  invokeClose.resolve();
  await closeStarted.promise;
  await closeFinished.promise;
  assert.equal(secondSettled, true, 'close from an inactive context drains the later active scan');
  await secondRejected;
});

test('explicit complete scan rejects caller cancellation and close during synchronous root discovery', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => [{ Id: 'blocking' }] },
    folderScanner: {
      supports: () => true,
      scan(root, { signal }) {
        entered(root);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          reject(new StorageError('cancelled', 'caller cancelled'));
        }, { once: true }));
      }
    }
  });
  const operation = scanner.runCompleteScan({ signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(operation, error => error.code === 'cancelled');
  await scanner.close();

  let closingScanner;
  let closePromise;
  let releaseRoots;
  let closeSettled = false;
  const rootsReleased = new Promise(resolve => { releaseRoots = resolve; });
  const discoveryStarted = Promise.withResolvers();
  closingScanner = new LibraryScanService({
    library: {
      getPhysicalScanRoots() {
        closePromise = closingScanner.close().finally(() => { closeSettled = true; });
        discoveryStarted.resolve();
        return rootsReleased.then(() => []);
      }
    },
    folderScanner: { supports: () => true, scan: async () => {} }
  });
  const closingOperation = closingScanner.runCompleteScan();
  await discoveryStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeSettled, true, 'reentrant close signals cancellation without waiting on its own operation');
  releaseRoots();
  await assert.rejects(closingOperation, error => error.code === 'cancelled');
  await closePromise;
});

test('library scan collaborators fail fast instead of deadlocking on nested scheduling or idle waits', async () => {
  let scanner;
  const nestedFailures = [];
  const library = {
    async getPhysicalScanRoots() {
      assert.throws(() => scanner.queue(), error => error.code === 'invalid-operation');
      nestedFailures.push(scanner.runCompleteScan().then(() => null, error => error));
      nestedFailures.push(scanner.whenIdle().then(() => null, error => error));
      return [];
    }
  };
  scanner = new LibraryScanService({
    library,
    folderScanner: { supports: () => true, scan: async () => {} }
  });

  assert.equal((await scanner.queue()).status, 'completed');
  for (const failure of nestedFailures) {
    assert.equal((await failure).code, 'invalid-operation');
  }
  await scanner.close();
});

test('a library scan collaborator may await close without waiting on itself', async () => {
  let scanner;
  const started = Promise.withResolvers();
  scanner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        started.resolve();
        await scanner.close();
        return [];
      }
    },
    folderScanner: { supports: () => true, scan: async () => {} }
  });

  const receipt = scanner.queue();
  await started.promise;
  const outcome = await Promise.race([
    receipt,
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 250))
  ]);
  assert.equal(outcome.status, 'cancelled');
});

test('nested scanner instances retain the active ancestor for reentrant close detection', async () => {
  let outer;
  let inner;
  inner = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        await outer.close();
        return [];
      }
    },
    folderScanner: { supports: () => true, scan: async () => {} }
  });
  outer = new LibraryScanService({
    library: {
      async getPhysicalScanRoots() {
        await inner.runCompleteScan();
        return [];
      }
    },
    folderScanner: { supports: () => true, scan: async () => {} }
  });

  const operation = outer.runCompleteScan();
  const outcome = await Promise.race([
    operation.then(() => ({ status: 'completed' }), error => ({ status: error.code })),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 250))
  ]);
  assert.equal(outcome.status, 'cancelled');
  await Promise.all([outer.close(), inner.close()]);
});

test('library scanning isolates root failures and close cancels in-flight work', async () => {
  const errors = [];
  let blocking = false;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const folderScanner = {
    supports: root => root.Id !== 'unsupported',
    async scan(root, { signal }) {
      if (root.Id === 'failed') throw new Error('synthetic root failure');
      if (root.Id !== 'blocking') return structurallyComplete();
      blocking = true;
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new StorageError('cancelled', 'closed')), { once: true }));
    }
  };
  let roots = [{ Id: 'failed' }, { Id: 'successful' }, { Id: 'unsupported' }];
  const scanner = new LibraryScanService({
    library: { getPhysicalScanRoots: async () => roots },
    folderScanner,
    onError: error => errors.push(error)
  });

  const failed = scanner.queue();
  await scanner.whenIdle();
  assert.deepEqual(await failed, {
    generation: 1,
    status: 'failed',
    partialResult: { rootCount: 3, completedRootCount: 1,
      roots: [{ index: 1, itemId: 'successful', path: null, result: structurallyComplete() }], structurallyComplete: false, incompleteRoots: [] },
    error: {
      name: 'AggregateError',
      code: 'library-scan-failed',
      message: '2 physical library roots failed to scan.'
    }
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /synthetic root failure/u);
  assert.equal(errors[1].code, 'invalid-response');

  roots = [{ Id: 'blocking' }];
  const cancelled = scanner.queue();
  await started;
  await scanner.close();
  assert.equal((await cancelled).status, 'cancelled');
  assert.equal(blocking, true);
  assert.throws(() => scanner.queue(), error => error.code === 'closed');
});

test('a revoked partial-result diagnostic cannot orphan a queued failure receipt', async () => {
  const diagnostic = Proxy.revocable({}, {}); diagnostic.revoke();
  const failure = new Error('Injected root discovery failure'); failure.partialResult = diagnostic.proxy;
  const errors = [];
  const scanner = new LibraryScanService({ library: { getPhysicalScanRoots: async () => { throw failure; } },
    folderScanner: { supports: () => true }, onError: error => errors.push(error) });
  const receipt = await scanner.queue();
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.message, failure.message); assert.equal(receipt.partialResult, undefined);
  assert.deepEqual(errors, [failure]); await scanner.close();
});
