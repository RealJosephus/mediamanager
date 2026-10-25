import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RefreshLibraryTaskWorker, ScheduledTaskManager, refreshLibraryTaskId } from '../../src/tasks/index.js';
import { LibraryScanService } from '../../src/library/index.js';
import { StorageError } from '../../src/storage/errors.js';

const times = (...values) => {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
};

function scanner(runCompleteScan, completeLibraryScan = true) {
  return { capabilities: { completeLibraryScan }, runCompleteScan };
}

test('RefreshLibrary exposes the stable native identity, complete DTO and nullable list filters', async () => {
  const localized = {
    TaskRefreshLibrary: 'Localized scan',
    TaskRefreshLibraryDescription: 'Localized description',
    TasksLibraryCategory: 'Localized library',
  };
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    localization: { text: key => localized[key] },
  });

  const expected = {
    Name: 'Localized scan',
    State: 'Idle',
    Id: '7738148ffcd07979c7ceb148e06b3aed',
    Triggers: [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n }],
    Description: 'Localized description',
    Category: 'Localized library',
    IsHidden: false,
    Key: 'RefreshLibrary',
  };
  assert.deepEqual((await manager.list()), [expected]);
  assert.deepEqual((await manager.list({ isHidden: null, isEnabled: undefined })), [expected]);
  assert.deepEqual((await manager.list({ isHidden: false, isEnabled: true })), [expected]);
  assert.deepEqual((await manager.list({ isHidden: true })), [expected]);
  assert.deepEqual((await manager.list({ isEnabled: false })), [expected]);
  assert.deepEqual((await manager.get(refreshLibraryTaskId.toUpperCase())), expected);
  assert.equal((await manager.get('missing')), null);
  assert.equal((await manager.get(null)), null);
  assert.equal(manager.start, undefined);
  assert.equal(manager.queue, undefined);
  await assert.rejects(manager.list({ isHidden: 'false' }), /isHidden must be a boolean/u);

  const mutable = (await manager.get(refreshLibraryTaskId));
  mutable.Triggers[0].IntervalTicks = 1n;
  assert.equal((await manager.get(refreshLibraryTaskId)).Triggers[0].IntervalTicks, 432000000000n);
  await manager.close();
});

test('start fails closed without an explicit complete scan operation and never creates a receipt', async () => {
  let queued = 0;
  for (const unavailable of [
    { capabilities: { completeLibraryScan: false }, queue() { queued++; } },
    { capabilities: { completeLibraryScan: true }, queue() { queued++; } },
  ]) {
    const events = [];
    const manager = new ScheduledTaskManager({ scanner: unavailable });
    manager.on('started', event => events.push(event));
    assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.status === 501 && error.code === 'task-unavailable');
    assert.throws(() => manager.cancelIfRunningAndQueue(refreshLibraryTaskId), error => error.status === 501 && error.code === 'task-unavailable');
    assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Idle');
    assert.equal(Object.hasOwn((await manager.get(refreshLibraryTaskId)), 'LastExecutionResult'), false);
    assert.deepEqual(events, []);
    await manager.close();
  }
  assert.equal(queued, 0, 'the swallowing queue API must never be used as a complete scan operation');
});

test('queue starts an idle task and returns that execution completion', async () => {
  let calls = 0;
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => { calls++; }),
    clock: times('2026-10-04T00:10:00.000Z', '2026-10-04T00:10:01.000Z'),
  });
  const completion = manager.cancelIfRunningAndQueue(refreshLibraryTaskId.toUpperCase());
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Running');
  const result = await completion;
  assert.equal(result.Status, 'Completed');
  assert.equal(calls, 1);
  await manager.close();
});

test('queue cancels a running task and coalesces repeated requests into exactly one successor', async () => {
  const operations = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => {
      const operation = Promise.withResolvers();
      operations.push({ ...operation, signal });
      signal.addEventListener('abort', () => operation.reject(signal.reason), { once: true });
      return operation.promise;
    }),
    clock: times('2026-10-04T00:20:00.000Z', '2026-10-04T00:20:01.000Z',
      '2026-10-04T00:20:02.000Z', '2026-10-04T00:20:03.000Z'),
  });
  const events = [];
  manager.on('started', ({ Task }) => events.push(['started', Task.LastExecutionResult?.Status]));
  manager.on('completed', ({ Result }) => events.push(['completed', Result.Status]));

  const current = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  assert.equal(operations.length, 1);
  const successor = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
  const coalesced = manager.cancelIfRunningAndQueue(refreshLibraryTaskId.toUpperCase());
  const successorFinished = [false, false];
  const successors = Promise.all([successor, coalesced].map((operation, index) => operation.then(result => {
    successorFinished[index] = true; return result;
  })));
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Cancelling');
  assert.equal(operations[0].signal.aborted, true);
  assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.status === 409 && error.code === 'task-running');

  const cancelled = await current;
  assert.equal(cancelled.Status, 'Cancelled');
  await Promise.resolve();
  assert.equal(operations.length, 2, 'all pending queue calls produce one successor generation');
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Running');
  assert.equal((await manager.get(refreshLibraryTaskId)).LastExecutionResult.Status, 'Cancelled');
  assert.deepEqual(successorFinished, [false, false]);
  operations[1].resolve();
  const [completed, coalescedResult] = await successors;
  assert.deepEqual(coalescedResult, completed);
  assert.deepEqual(successorFinished, [true, true]);
  assert.equal(completed.Status, 'Completed');
  assert.deepEqual(events, [
    ['started', undefined],
    ['completed', 'Cancelled'],
    ['started', 'Cancelled'],
    ['completed', 'Completed'],
  ]);
  await manager.close();
});

test('scheduled trigger queueing never cancels the active generation and the first queued options win', async () => {
  const operations = [];
  const timerDelays = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => {
      const operation = Promise.withResolvers();
      operations.push({ ...operation, signal });
      signal.addEventListener('abort', () => operation.reject(signal.reason), { once: true });
      return operation.promise;
    }),
    timers: { set(callback, delay) { timerDelays.push(delay); return { callback, delay }; }, clear() {} }
  });
  const current = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  const queued = manager.queueScheduled(refreshLibraryTaskId, { maxRuntimeTicks: -10_000n });
  const coalesced = manager.queueScheduled(refreshLibraryTaskId, { maxRuntimeTicks: 0n });
  const queuedFinished = [false, false];
  const queuedResults = Promise.all([queued, coalesced].map((operation, index) => operation.then(result => {
    queuedFinished[index] = true; return result;
  })));
  assert.equal(operations[0].signal.aborted, false);
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Running');

  operations[0].resolve();
  assert.equal((await current).Status, 'Completed');
  for (let count = 0; count < 10 && operations.length < 2; count++) await Promise.resolve();
  assert.equal(operations.length, 2);
  assert.deepEqual(timerDelays, [], 'the first queued infinite option is retained instead of the later zero timeout');
  assert.deepEqual(queuedFinished, [false, false]);
  operations[1].resolve();
  const [result, coalescedResult] = await queuedResults;
  assert.deepEqual(coalescedResult, result); assert.equal(result.Status, 'Completed');
  assert.deepEqual(queuedFinished, [true, true]);
  await manager.close();
});

test('close rejects a queued successor without relabelling its already-cancelling predecessor', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const operations = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async ({ signal }) => {
      operations.push(signal);
      entered.resolve();
      await release.promise;
    }),
    clock: times('2026-10-04T00:30:00.000Z', '2026-10-04T00:30:01.000Z'),
  });
  const events = [];
  manager.on('started', () => events.push('started'));
  manager.on('completed', ({ Result }) => events.push(Result.Status));
  const current = manager.execute(refreshLibraryTaskId);
  await entered.promise;
  const successor = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
  const successorRejected = assert.rejects(successor, error => error.status === 503 && error.code === 'closed');
  const closing = manager.close();
  assert.equal(operations[0].aborted, true);
  await successorRejected;
  release.resolve();
  assert.equal((await current).Status, 'Completed');
  await closing;
  assert.equal(operations.length, 1);
  assert.deepEqual(events, ['started', 'Completed']);
  assert.throws(() => manager.cancelIfRunningAndQueue(refreshLibraryTaskId), error => error.status === 503 && error.code === 'closed');
});

test('close preserves and reports a non-cancellation failure that wins the race', async () => {
  const entered = Promise.withResolvers();
  const operation = Promise.withResolvers();
  const failure = new Error('complete scan failed during shutdown');
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => {
      entered.resolve();
      return operation.promise;
    }),
    onError: error => reported.push(error)
  });

  const completion = manager.execute(refreshLibraryTaskId);
  await entered.promise;
  const closing = manager.close();
  operation.reject(failure);

  const result = await completion;
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, failure.message);
  assert.deepEqual(reported, [failure]);
  await closing;
});

test('start is background, reports progress, preserves the old receipt while running and rejects duplicate starts', async () => {
  const operations = [];
  const taskScanner = scanner(({ signal, reportProgress }) => {
    const operation = Promise.withResolvers();
    operations.push({ ...operation, signal, reportProgress });
    return operation.promise;
  });
  const manager = new ScheduledTaskManager({
    scanner: taskScanner,
    clock: times('2026-10-04T00:00:00.123Z', '2026-10-04T00:00:02.456Z',
      '2026-10-04T00:01:00.000Z', '2026-10-04T00:01:01.000Z'),
  });
  const events = [];
  for (const name of ['started', 'progress', 'completed']) manager.on(name, event => events.push([name, event]));

  const first = manager.execute(refreshLibraryTaskId.toUpperCase());
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Running');
  assert.equal(Object.hasOwn((await manager.get(refreshLibraryTaskId)), 'LastExecutionResult'), false);
  assert.equal(Object.hasOwn((await manager.get(refreshLibraryTaskId)), 'CurrentProgressPercentage'), false);
  await Promise.resolve();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].reportProgress(25.5), true);
  assert.equal((await manager.get(refreshLibraryTaskId)).CurrentProgressPercentage, 25.5);
  assert.equal(operations[0].reportProgress(150), true);
  assert.equal((await manager.get(refreshLibraryTaskId)).CurrentProgressPercentage, 100);
  assert.equal(operations[0].reportProgress(Number.NaN), false);
  assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.status === 409 && error.code === 'task-running');
  operations[0].resolve();
  const firstResult = await first;
  assert.deepEqual(firstResult, {
    StartTimeUtc: '2026-10-04T00:00:00.123Z',
    EndTimeUtc: '2026-10-04T00:00:02.456Z',
    Status: 'Completed',
    Name: 'Scan Media Library',
    Key: 'RefreshLibrary',
    Id: refreshLibraryTaskId,
  });
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Idle');

  const second = manager.execute(refreshLibraryTaskId);
  assert.deepEqual((await manager.get(refreshLibraryTaskId)).LastExecutionResult, firstResult,
    'the prior receipt remains visible throughout the next execution');
  await Promise.resolve();
  operations[1].resolve();
  await second;

  assert.deepEqual(events.map(([name]) => name),
    ['started', 'progress', 'progress', 'completed', 'started', 'completed']);
  assert.equal(events[0][1].Task.State, 'Running');
  assert.equal(events[3][1].Task.State, 'Idle');
  assert.equal(events[3][1].Result.Status, 'Completed');
  await manager.close();
});

test('operation failures become Failed receipts without rejecting the background completion', async () => {
  const failure = new Error('Controlled complete scan failure');
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => { throw failure; }),
    clock: times('2026-10-04T01:00:00.000Z', '2026-10-04T01:00:03.000Z'),
    onError: error => reported.push(error),
  });
  const completed = [];
  manager.on('completed', event => completed.push(event));

  const result = await manager.execute(refreshLibraryTaskId);
  assert.equal(result.Status, 'Failed');
  assert.equal(result.StartTimeUtc, '2026-10-04T01:00:00.0000000Z');
  assert.equal(result.EndTimeUtc, '2026-10-04T01:00:03.0000000Z');
  assert.equal(result.ErrorMessage, failure.message);
  assert.match(result.LongErrorMessage, /Controlled complete scan failure/u);
  assert.deepEqual(reported, [failure]);
  assert.equal(completed.length, 1);
  assert.deepEqual((await manager.get(refreshLibraryTaskId)).LastExecutionResult, result);
  await manager.close();
});

test('hostile failure accessors cannot strand an active task', async () => {
  const hostile = {};
  Object.defineProperties(hostile, {
    name: { get() { throw new Error('name getter failed'); } },
    code: { get() { throw new Error('code getter failed'); } },
    message: { get() { throw new Error('message getter failed'); } },
    stack: { get() { throw new Error('stack getter failed'); } }
  });
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => { throw hostile; }),
    onError: error => reported.push(error)
  });

  const result = await manager.execute(refreshLibraryTaskId);
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, '[object Object]');
  assert.equal(result.LongErrorMessage, '[object Object]');
  assert.deepEqual(reported, [hostile]);
  await manager.close();
});

test('a null rejection becomes a complete Failed receipt and reported Error', async () => {
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => { throw null; }),
    onError: error => reported.push(error)
  });

  const result = await manager.execute(refreshLibraryTaskId);
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, 'Scheduled task execution rejected without an error.');
  assert.match(result.LongErrorMessage, /Scheduled task execution rejected without an error/u);
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof Error);
  await manager.close();
});

test('async event listener failures are owned and reported', async () => {
  const failure = new Error('async task observer failed');
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    onError: error => reported.push(error)
  });
  manager.on('completed', async () => { throw failure; });

  assert.equal((await manager.execute(refreshLibraryTaskId)).Status, 'Completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reported, [failure]);
  await manager.close();
});

test('failure reporting re-entry occurs after the completed snapshot is published', async () => {
  const operations = [];
  const failure = new Error('first execution failed');
  let manager;
  let restarted;
  const events = [];
  manager = new ScheduledTaskManager({
    scanner: scanner(() => {
      const operation = Promise.withResolvers();
      operations.push(operation);
      return operation.promise;
    }),
    onError() { restarted = manager.execute(refreshLibraryTaskId); }
  });
  manager.on('started', ({ Task }) => events.push(['started', Task.State, Task.LastExecutionResult?.Status ?? null]));
  manager.on('completed', ({ Task, Result }) => events.push(['completed', Task.State, Result.Status]));

  const first = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  operations[0].reject(failure);
  assert.equal((await first).Status, 'Failed');
  for (let count = 0; count < 10 && operations.length < 2; count++) await Promise.resolve();
  assert.deepEqual(events.slice(0, 3), [
    ['started', 'Running', null],
    ['completed', 'Idle', 'Failed'],
    ['started', 'Running', 'Failed']
  ]);
  operations[1].resolve();
  assert.equal((await restarted).Status, 'Completed');
  await manager.close();
});

test('user cancellation exposes Cancelling and completes once with Cancelled', async () => {
  let operation;
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => new Promise((resolve, reject) => {
      operation = { signal, resolve, reject };
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
    clock: times('2026-10-04T02:00:00.000Z', '2026-10-04T02:00:04.000Z'),
  });
  const completed = [];
  manager.on('completed', event => completed.push(event));
  const running = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  assert.equal(operation.signal.aborted, false);

  const cancelled = manager.cancel(refreshLibraryTaskId.toUpperCase());
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Cancelling');
  assert.equal(operation.signal.aborted, true);
  assert.throws(() => manager.cancel(refreshLibraryTaskId), error => error.status === 409 && error.code === 'task-not-running');
  const [result, cancelledResult] = await Promise.all([running, cancelled]);
  assert.deepEqual(cancelledResult, result);
  assert.equal(result.Status, 'Cancelled');
  assert.equal(Object.hasOwn(result, 'ErrorMessage'), false);
  assert.equal(Object.hasOwn(result, 'LongErrorMessage'), false);
  assert.equal(completed.length, 1);
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Idle');
  await manager.close();
});

test('shutdown does not relabel an execution that was already cancelling', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const manager = new ScheduledTaskManager({
    scanner: scanner(async ({ signal }) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
    })
  });
  const running = manager.execute(refreshLibraryTaskId);
  await entered.promise;
  manager.cancel(refreshLibraryTaskId);
  const closing = manager.close();
  release.resolve();
  assert.equal((await running).Status, 'Cancelled');
  await closing;
});

for (const outcome of ['failure', 'success']) test(`user cancellation still records a later non-cancellation ${outcome}`, async () => {
  const operation = Promise.withResolvers();
  const failure = new Error('storage failure won the cancellation race');
  const reported = [];
  let signal;
  const manager = new ScheduledTaskManager({
    scanner: scanner(options => { signal = options.signal; return operation.promise; }),
    onError: error => reported.push(error)
  });
  const running = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  manager.cancel(refreshLibraryTaskId);
  assert.equal(signal.aborted, true);
  if (outcome === 'failure') operation.reject(failure);
  else operation.resolve();

  const result = await running;
  assert.equal(result.Status, outcome === 'failure' ? 'Failed' : 'Completed');
  assert.deepEqual(reported, outcome === 'failure' ? [failure] : []);
  await manager.close();
});

test('completed observer requeue cannot steal a successor from the task it starts', async () => {
  const operations = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(() => {
      const operation = Promise.withResolvers();
      operations.push(operation);
      return operation.promise;
    })
  });
  let firstQueued;
  let successor;
  manager.on('completed', ({ Result }) => {
    if (Result.Status !== 'Completed' || firstQueued) return;
    firstQueued = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
    successor = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
  });

  const initial = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  operations[0].resolve();
  assert.equal((await initial).Status, 'Completed');
  for (let count = 0; count < 10 && operations.length < 2; count++) await Promise.resolve();
  assert.equal((await firstQueued).Status, 'Cancelled');
  assert.equal(operations.length, 2, 'the cancelled intermediate never invokes the scanner, while its successor does');
  operations[1].resolve();
  assert.equal((await successor).Status, 'Completed');
  await manager.close();
});

test('task and scanner owners can be signalled together when the task waits behind an older queue generation', async () => {
  const entered = Promise.withResolvers();
  const scannerService = new LibraryScanService({
    lifecycle: {
      run({ signal }) {
        entered.resolve();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          reject(new StorageError('cancelled', 'scanner closed'));
        }, { once: true }));
      }
    }
  });
  const first = scannerService.queue();
  await entered.promise;
  const manager = new ScheduledTaskManager({
    scanner: {
      capabilities: { completeLibraryScan: true },
      runCompleteScan: options => scannerService.runCompleteScan(options)
    }
  });
  const scheduled = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();

  await Promise.all([manager.close(), scannerService.close()]);
  const firstReceipt = await first;
  assert.equal(firstReceipt.status, 'cancelled');
  assert.equal((await scheduled).Status, 'Aborted');
});

test('three serialized scan-owner layers drain when every owner is signalled together', async () => {
  const lifetime = new AbortController();
  const olderEntered = Promise.withResolvers();
  const libraryFolderRegistered = Promise.withResolvers();
  let tail = Promise.resolve();
  const active = new Set();
  const folderOwner = {
    supports: () => true,
    scan(root, { signal } = {}) {
      if (root.Id === 'library-root') libraryFolderRegistered.resolve();
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const run = async () => {
        if (combined.aborted) throw new StorageError('cancelled', 'folder owner closed');
        if (root.Id === 'older-folder-scan') {
          olderEntered.resolve();
          await new Promise((resolve, reject) => combined.addEventListener('abort', () => {
            reject(new StorageError('cancelled', 'folder owner closed'));
          }, { once: true }));
        }
        return { added: 0 };
      };
      const operation = tail.then(run, run);
      tail = operation.catch(() => {});
      active.add(operation);
      operation.finally(() => active.delete(operation)).catch(() => {});
      return operation;
    },
    async close() {
      lifetime.abort();
      await Promise.allSettled([...active]);
    }
  };

  const older = folderOwner.scan({ Id: 'older-folder-scan' });
  const olderRejected = assert.rejects(older, error => error.code === 'cancelled');
  await olderEntered.promise;
  const scannerService = new LibraryScanService({
    lifecycle: { run: options => folderOwner.scan({ Id: 'library-root' }, options) }
  });
  const queued = scannerService.queue();
  await libraryFolderRegistered.promise;
  const manager = new ScheduledTaskManager({ scanner: {
    capabilities: { completeLibraryScan: true },
    runCompleteScan: options => scannerService.runCompleteScan(options)
  } });
  const scheduled = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();

  await Promise.race([
    Promise.all([manager.close(), scannerService.close(), folderOwner.close()]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Nested scan owners did not drain.')), 500))
  ]);
  await olderRejected;
  assert.equal((await queued).status, 'cancelled');
  assert.equal((await scheduled).Status, 'Aborted');
});

test('close is idempotent, waits for the active operation, records Aborted and rejects new work', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let signal;
  const manager = new ScheduledTaskManager({
    scanner: scanner(async options => {
      signal = options.signal;
      entered.resolve();
      await release.promise;
    }),
    clock: times('2026-10-04T03:00:00.000Z', '2026-10-04T03:00:05.000Z'),
  });
  const completions = [];
  manager.on('completed', event => completions.push(event));
  const running = manager.execute(refreshLibraryTaskId);
  await entered.promise;
  try {
    const admittedSnapshot = await manager.get(refreshLibraryTaskId);
    assert.equal(admittedSnapshot.State, 'Running');
    const closed = [false, false];
    const observedClose = Promise.all([manager.close(), manager.close()]
      .map((operation, index) => operation.then(() => { closed[index] = true; })));
    assert.equal(signal.aborted, true);
    await assert.rejects(manager.get(refreshLibraryTaskId), { status: 503, code: 'task-unavailable' });
    await Promise.resolve();
    assert.deepEqual(closed, [false, false], 'Every shutdown caller drains the already-started complete scan operation.');
    assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.status === 503 && error.code === 'closed');
    assert.throws(() => manager.cancel(refreshLibraryTaskId), error => error.status === 503 && error.code === 'closed');

    release.resolve();
    const result = await running;
    await observedClose;
    assert.deepEqual(closed, [true, true]);
    assert.equal(result.Status, 'Aborted');
    await assert.rejects(manager.get(refreshLibraryTaskId), { status: 503, code: 'task-unavailable' });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].Result.Status, 'Aborted');
    assert.equal(completions[0].Task.State, 'Idle', 'The admitted completion event retains the final state after reads close.');
    assert.deepEqual(completions[0].Task.LastExecutionResult, result, 'Completion retains the complete final history.');
    assert.equal(admittedSnapshot.State, 'Running', 'An earlier information snapshot remains immutable.');
  } finally { release.resolve(); await Promise.allSettled([running, manager.close()]); }
});

test('trigger cleanup reporting can re-enter close while all callers drain the store', async () => {
  let manager;
  let nestedClose;
  let nestedDrained = false;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let storeCloses = 0;
  const store = {
    async loadTriggers() { return null; },
    async loadHistory() { return null; },
    async saveTriggers() {},
    async saveHistory() {},
    async close() { storeCloses += 1; entered.resolve(); await release.promise; }
  };
  manager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store,
    timers: {
      set(callback, delay) { return { callback, delay }; },
      clear() { throw new Error('trigger clear failed'); }
    },
    onError() { nestedClose ??= manager.close().then(() => { nestedDrained = true; }); }
  });
  await manager.initialize();

  const drained = [false, false];
  const closing = Promise.all([manager.close(), manager.close()]
    .map((operation, index) => operation.then(() => { drained[index] = true; })));
  try {
    await entered.promise;
    assert.deepEqual(drained, [false, false]);
    assert.equal(nestedDrained, false);
    await assert.rejects(manager.get(refreshLibraryTaskId), { status: 503, code: 'task-unavailable' });
  } finally { release.resolve(); }
  await Promise.all([closing, nestedClose]);
  assert.deepEqual(drained, [true, true]);
  assert.equal(nestedDrained, true, 'The close requested from the actual cleanup-error callback also drained the store.');
  assert.equal(storeCloses, 1);
});

test('a scanner that rejects with the shutdown signal reason records Aborted rather than Failed', async () => {
  const entered = Promise.withResolvers();
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => {
      entered.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    })
  });
  const running = manager.execute(refreshLibraryTaskId);
  await entered.promise;
  const closing = manager.close();
  assert.equal((await running).Status, 'Aborted');
  await closing;
});

test('unknown task ids fail mutations with 404 while get returns null', async () => {
  const manager = new ScheduledTaskManager({ scanner: scanner(async () => {}) });
  assert.equal((await manager.get('not-a-task')), null);
  assert.throws(() => manager.execute('not-a-task'), error => error.status === 404 && error.code === 'task-not-found');
  assert.throws(() => manager.queueScheduled('not-a-task'), error => error.status === 404 && error.code === 'task-not-found');
  assert.throws(() => manager.cancelIfRunningAndQueue('not-a-task'), error => error.status === 404 && error.code === 'task-not-found');
  assert.throws(() => manager.cancel('not-a-task'), error => error.status === 404 && error.code === 'task-not-found');
  await manager.close();
});

test('started observers may synchronously cancel without losing the registered completion', async () => {
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
  });
  let cancellation;
  manager.on('started', () => { cancellation = manager.cancel(refreshLibraryTaskId); });
  const running = manager.execute(refreshLibraryTaskId);
  const [result, cancellationResult] = await Promise.all([running, cancellation]);
  assert.deepEqual(cancellationResult, result); assert.equal(result.Status, 'Cancelled');
  await manager.close();
});

test('durable history publication retains execution ownership and event ordering until the write settles', async () => {
  const firstHistory = Promise.withResolvers();
  const historyEntered = Promise.withResolvers();
  let historyWrites = 0;
  const store = {
    async loadTriggers() { return null; },
    async loadHistory() { return null; },
    async saveTriggers() {},
    saveHistory() {
      historyWrites++;
      if (historyWrites === 1) {
        historyEntered.resolve();
        return firstHistory.promise;
      }
      return Promise.resolve();
    },
    async close() {}
  };
  const operations = [];
  const manager = new ScheduledTaskManager({ store, scanner: scanner(() => {
    const operation = Promise.withResolvers();
    operations.push(operation);
    return operation.promise;
  }) });
  const events = [];
  manager.on('started', ({ Task }) => events.push(['started', Task.State]));
  manager.on('completed', ({ Task }) => events.push(['completed', Task.State]));
  await manager.initialize();

  const first = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  operations[0].resolve();
  await historyEntered.promise;
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Running');
  assert.equal(Object.hasOwn((await manager.get(refreshLibraryTaskId)), 'LastExecutionResult'), false);
  assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.code === 'task-running');
  const successor = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Cancelling');

  firstHistory.resolve();
  assert.equal((await first).Status, 'Completed');
  for (let count = 0; count < 10 && operations.length < 2; count++) await Promise.resolve();
  assert.deepEqual(events.slice(0, 3), [['started', 'Running'], ['completed', 'Idle'], ['started', 'Running']]);
  operations[1].resolve();
  assert.equal((await successor).Status, 'Completed');
  assert.equal(historyWrites, 2);
  await manager.close();
});

test('history persistence failure becomes the published Failed receipt without stranding the worker', async () => {
  const persistenceFailure = new Error('history disk unavailable');
  const reported = [];
  const store = {
    async loadTriggers() { return null; },
    async loadHistory() { return null; },
    async saveTriggers() {},
    async saveHistory() { throw persistenceFailure; },
    async close() {}
  };
  const manager = new ScheduledTaskManager({ store, scanner: scanner(async () => {}), onError: error => reported.push(error) });
  await manager.initialize();
  const completed = [];
  manager.on('completed', event => completed.push(event));
  const result = await manager.execute(refreshLibraryTaskId);
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, persistenceFailure.message);
  assert.equal((await manager.get(refreshLibraryTaskId)).State, 'Idle');
  assert.deepEqual((await manager.get(refreshLibraryTaskId)).LastExecutionResult, result);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].Task.State, 'Idle');
  assert.deepEqual(reported, [persistenceFailure]);
  await manager.close();
});

test('trigger activation is durable and rolls persistence back when timer installation fails', async () => {
  const saves = [];
  let timerSets = 0;
  const cleared = [];
  const store = {
    async loadTriggers() { return null; },
    async loadHistory() { return null; },
    async saveTriggers(value) { saves.push(structuredClone(value)); },
    async saveHistory() {},
    async close() {}
  };
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store,
    timers: {
      set(callback, delay) {
        timerSets++;
        if (timerSets === 2) throw new Error('new trigger timer failed');
        return { callback, delay, sequence: timerSets };
      },
      clear(handle) { cleared.push(handle.sequence); }
    }
  });
  await manager.initialize();
  await assert.rejects(manager.updateTriggers(refreshLibraryTaskId, [
    { Type: 'DailyTrigger', TimeOfDayTicks: 0n }
  ]), /new trigger timer failed/u);
  assert.deepEqual(saves, [
    [{ Type: 'DailyTrigger', TimeOfDayTicks: 0n }],
    [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n }]
  ]);
  assert.deepEqual((await manager.get(refreshLibraryTaskId)).Triggers,
    [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n }]);
  assert.deepEqual(cleared, [], 'the previous timer remains live after the replacement fails');
  await manager.close();
  assert.deepEqual(cleared, [1]);
});

test('concurrent trigger updates serialize persistence, activation and rollback as one transaction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-task-trigger-race-'));
  const programDataPath = path.join(root, 'data');
  let timerSets = 0;
  try {
    const first = new ScheduledTaskManager({
      scanner: scanner(async () => {}),
      programDataPath,
      timers: {
        set() {
          timerSets++;
          if (timerSets === 2) throw new Error('first concurrent activation failed');
          return { sequence: timerSets };
        },
        clear() {}
      }
    });
    await first.initialize();
    const failed = first.updateTriggers(refreshLibraryTaskId, [
      { Type: 'DailyTrigger', TimeOfDayTicks: 0n }
    ]);
    const succeeded = first.updateTriggers(refreshLibraryTaskId, [
      { Type: 'WeeklyTrigger', DayOfWeek: 'Monday', TimeOfDayTicks: 3_600_000_000n }
    ]);
    const [failedResult, succeededResult] = await Promise.allSettled([failed, succeeded]);
    assert.equal(failedResult.status, 'rejected');
    assert.match(failedResult.reason.message, /first concurrent activation failed/u);
    assert.equal(succeededResult.status, 'fulfilled');
    assert.deepEqual((await first.get(refreshLibraryTaskId)).Triggers, [
      { Type: 'WeeklyTrigger', TimeOfDayTicks: 3_600_000_000n, DayOfWeek: 'Monday' }
    ]);
    await first.close();

    const second = new ScheduledTaskManager({
      scanner: scanner(async () => {}),
      programDataPath,
      timers: { set() { return {}; }, clear() {} }
    });
    await second.initialize();
    assert.deepEqual((await second.get(refreshLibraryTaskId)).Triggers, [
      { Type: 'WeeklyTrigger', TimeOfDayTicks: 3_600_000_000n, DayOfWeek: 'Monday' }
    ]);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('close stops trigger timers immediately and drains an admitted trigger write through rollback', async () => {
  const saveEntered = Promise.withResolvers();
  const releaseSave = Promise.withResolvers();
  const saves = [];
  let storeClosed = false;
  const cleared = [];
  const store = {
    async loadTriggers() { return null; },
    async loadHistory() { return null; },
    saveTriggers(value) {
      saves.push(structuredClone(value));
      if (saves.length === 1) {
        saveEntered.resolve();
        return releaseSave.promise;
      }
      return Promise.resolve();
    },
    async saveHistory() {},
    async close() { storeClosed = true; }
  };
  const manager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store,
    timers: {
      set() { return { sequence: 1 }; },
      clear(handle) { cleared.push(handle.sequence); }
    }
  });
  await manager.initialize();
  const updating = manager.updateTriggers(refreshLibraryTaskId, [
    { Type: 'DailyTrigger', TimeOfDayTicks: 0n }
  ]);
  await saveEntered.promise;
  const closing = manager.close();
  assert.deepEqual(cleared, [1]);
  assert.equal(storeClosed, false);
  await assert.rejects(manager.updateTriggers(refreshLibraryTaskId, []), { code: 'closed' });
  releaseSave.resolve();
  await assert.rejects(updating, { code: 'closed' });
  await closing;
  assert.deepEqual(saves, [
    [{ Type: 'DailyTrigger', TimeOfDayTicks: 0n }],
    [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n }]
  ]);
  assert.equal(storeClosed, true);
});

test('native trigger and LastExecutionResult files survive a manager restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-task-restart-'));
  const programDataPath = path.join(root, 'data');
  const timers = { set() { return {}; }, clear() {} };
  try {
    const first = new ScheduledTaskManager({
      scanner: scanner(async () => {}), programDataPath, timers,
      clock: times(
        '2026-10-04T07:00:00.000Z',
        '2026-10-04T08:00:00.000Z',
        '2026-10-04T08:00:00.000Z',
        '2026-10-04T08:00:01.000Z'
      )
    });
    await first.initialize();
    await first.updateTriggers(refreshLibraryTaskId, [{
      Type: 'WeeklyTrigger', DayOfWeek: 'Monday', TimeOfDayTicks: 3_600_000_000n, MaxRuntimeTicks: -10_000n
    }]);
    assert.equal((await first.execute(refreshLibraryTaskId)).Status, 'Completed');
    await first.close();

    const second = new ScheduledTaskManager({ scanner: scanner(async () => {}), programDataPath, timers });
    await second.initialize();
    const restored = (await second.get(refreshLibraryTaskId));
    assert.deepEqual(restored.Triggers, [{
      Type: 'WeeklyTrigger', TimeOfDayTicks: 3_600_000_000n, DayOfWeek: 'Monday', MaxRuntimeTicks: -10_000n
    }]);
    assert.equal(restored.LastExecutionResult.Status, 'Completed');
    assert.equal(restored.LastExecutionResult.StartTimeUtc, '2026-10-04T08:00:00.0000000Z');
    assert.equal(restored.LastExecutionResult.EndTimeUtc, '2026-10-04T08:00:01.0000000Z');
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maximum runtime matches CancellationTokenSource millisecond truncation boundaries', async () => {
  const cases = [
    [-20000n, 'Failed', null, 0],
    [-19999n, 'Completed', null, 1],
    [-10000n, 'Completed', null, 1],
    [-9999n, 'Cancelled', [0], 1],
    [-1n, 'Cancelled', [0], 1],
    [0n, 'Cancelled', [0], 1],
    [1n, 'Cancelled', [0], 1],
    [9999n, 'Cancelled', [0], 1],
    [10000n, 'Cancelled', [1], 1],
    [42_949_672_940_000n, 'Cancelled', [2_147_483_647, 2_147_483_647], 1],
    [42_949_672_949_999n, 'Cancelled', [2_147_483_647, 2_147_483_647], 1],
    [42_949_672_950_000n, 'Failed', null, 0]
  ];
  for (const [ticks, status, expectedDelays, expectedCalls] of cases) {
    const delays = [];
    let monotonic = 0;
    let calls = 0;
    const worker = new RefreshLibraryTaskWorker({
      scanner: scanner(({ signal }) => {
        calls++;
        if (expectedDelays == null) return Promise.resolve();
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }),
      timers: {
        set(callback, delay) {
          delays.push(delay);
          queueMicrotask(() => { monotonic += delay; callback(); });
          return { delay };
        },
        clear() {},
        now: () => monotonic
      }
    });
    const result = await worker.execute({ maxRuntimeTicks: ticks });
    assert.equal(result.Status, status, `ticks=${ticks}`);
    assert.deepEqual(delays, expectedDelays ?? [], `ticks=${ticks}`);
    assert.equal(calls, expectedCalls, `ticks=${ticks}`);
    await worker.close();
  }
});

test('maximum-runtime timer setup failure is captured as a Failed receipt', async () => {
  const timerFailure = new Error('timer allocation failed');
  let scans = 0;
  const reported = [];
  const worker = new RefreshLibraryTaskWorker({
    scanner: scanner(async () => { scans++; }),
    timers: { set() { throw timerFailure; }, clear() {} },
    onError: error => reported.push(error)
  });
  const result = await worker.execute({ maxRuntimeTicks: 0n });
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, timerFailure.message);
  assert.equal(scans, 0);
  assert.equal(worker.state, 'Idle');
  assert.deepEqual(reported, [timerFailure]);
  await worker.close();
});

test('maximum-runtime clock and timer re-entry cannot leave post-close handles', async () => {
  let clockWorker;
  let clockScans = 0;
  let clockSets = 0;
  clockWorker = new RefreshLibraryTaskWorker({
    scanner: scanner(async () => { clockScans += 1; }),
    timers: {
      now() { void clockWorker.close(); return 0; },
      set() { clockSets += 1; return {}; },
      clear() {}
    }
  });
  assert.equal((await clockWorker.execute({ maxRuntimeTicks: 10_000n })).Status, 'Aborted');
  assert.equal(clockScans, 0);
  assert.equal(clockSets, 0, 'closing from the monotonic clock prevents timer allocation');
  await clockWorker.close();

  let setWorker;
  let setScans = 0;
  const handles = [];
  const cleared = [];
  setWorker = new RefreshLibraryTaskWorker({
    scanner: scanner(async () => { setScans += 1; }),
    timers: {
      now: () => 0,
      set(callback, delay) {
        const handle = { callback, delay };
        handles.push(handle);
        void setWorker.close();
        return handle;
      },
      clear(handle) { cleared.push(handle); }
    }
  });
  assert.equal((await setWorker.execute({ maxRuntimeTicks: 10_000n })).Status, 'Aborted');
  assert.equal(setScans, 0);
  assert.deepEqual(cleared, handles, 'a timer returned after reentrant close is discarded immediately');
  await setWorker.close();
});

test('maximum-runtime chunk rearm failure aborts and publishes one Failed terminal result', async () => {
  const timerFailure = new Error('second timer allocation failed');
  const timers = [];
  let monotonic = 0;
  const reported = [];
  const worker = new RefreshLibraryTaskWorker({
    scanner: scanner(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
    timers: {
      set(callback, delay) {
        if (timers.length === 1) throw timerFailure;
        const handle = { callback, delay };
        timers.push(handle);
        return handle;
      },
      clear() {},
      now: () => monotonic
    },
    onError: error => reported.push(error)
  });
  const running = worker.execute({ maxRuntimeTicks: 21_474_836_480_000n });
  await Promise.resolve();
  assert.equal(timers[0].delay, 2_147_483_647);
  monotonic += timers[0].delay;
  timers[0].callback();
  const result = await running;
  assert.equal(result.Status, 'Failed');
  assert.equal(result.ErrorMessage, timerFailure.message);
  assert.equal(worker.state, 'Idle');
  assert.deepEqual(reported, [timerFailure]);
  await worker.close();
});

test('a late maximum-runtime chunk callback uses the absolute deadline instead of adding another full chunk', async () => {
  const timers = [];
  let monotonic = 0;
  const worker = new RefreshLibraryTaskWorker({
    scanner: scanner(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
    timers: {
      set(callback, delay) { const handle = { callback, delay }; timers.push(handle); return handle; },
      clear() {},
      now: () => monotonic
    }
  });
  const running = worker.execute({ maxRuntimeTicks: 42_949_672_940_000n });
  await Promise.resolve();
  assert.equal(timers[0].delay, 2_147_483_647);
  monotonic = 4_294_967_294 + 100;
  timers[0].callback();
  const result = await running;
  assert.equal(result.Status, 'Cancelled');
  assert.equal(timers.length, 1, 'an already-expired deadline does not schedule the second chunk');
  await worker.close();
});

test('maximum-runtime timer clear failure is reported but cannot block terminal publication or close', async () => {
  const clearFailure = new Error('timer clear failed');
  const reported = [];
  const worker = new RefreshLibraryTaskWorker({
    scanner: scanner(async () => {}),
    timers: { set() { return {}; }, clear() { throw clearFailure; } },
    onError: error => reported.push(error)
  });
  const result = await worker.execute({ maxRuntimeTicks: 10_000n });
  assert.equal(result.Status, 'Completed');
  assert.equal(worker.state, 'Idle');
  assert.deepEqual(reported, [clearFailure]);
  await assert.doesNotReject(worker.close());
});

test('scanner-owned task APIs fail fast and reentrant close signals without self-deadlock', async () => {
  let manager;
  manager = new ScheduledTaskManager({ scanner: scanner(async () => {
    assert.throws(() => manager.execute(refreshLibraryTaskId), error => error.code === 'invalid-operation');
    assert.throws(() => manager.cancelIfRunningAndQueue(refreshLibraryTaskId), error => error.code === 'invalid-operation');
    assert.throws(() => manager.cancel(refreshLibraryTaskId), error => error.code === 'invalid-operation');
    await manager.close();
  }) });
  const running = manager.execute(refreshLibraryTaskId);
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('reentrant close deadlocked')), 250))
  ]);
  assert.equal(result.Status, 'Aborted');
  await manager.close();
});

test('scanner-owned completion waiting rejects instead of creating a self-wait cycle', async () => {
  let worker;
  worker = new RefreshLibraryTaskWorker({ scanner: scanner(async () => worker.completion) });
  const result = await Promise.race([
    worker.execute(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('completion self-wait deadlocked')), 250))
  ]);
  assert.equal(result.Status, 'Failed');
  assert.match(result.ErrorMessage, /cannot wait on the scheduled task execution/u);
  assert.equal(worker.state, 'Idle');
  await worker.close();
});

test('localization error reporting cannot re-enter the idle check and start a second generation', async () => {
  let manager;
  let textCalls = 0;
  let scans = 0;
  const reported = [];
  const nestedErrors = [];
  manager = new ScheduledTaskManager({
    scanner: scanner(async () => { scans++; }),
    localization: {
      text() {
        if (textCalls++ === 0) throw new Error('first localization lookup failed');
      }
    },
    onError(error) {
      reported.push(error);
      try { manager.execute(refreshLibraryTaskId); }
      catch (nestedError) { nestedErrors.push(nestedError); }
    }
  });
  assert.equal((await manager.execute(refreshLibraryTaskId)).Status, 'Completed');
  assert.equal(scans, 1);
  assert.equal(reported.length, 1);
  assert.equal(nestedErrors.length, 1);
  assert.equal(nestedErrors[0].code, 'task-running');
  await manager.close();
});

test('an execution option getter cannot steal the reserved generation by re-entering start', async () => {
  let manager;
  let nestedError;
  let scans = 0;
  const options = {};
  Object.defineProperty(options, 'maxRuntimeTicks', {
    get() {
      try { manager.execute(refreshLibraryTaskId); }
      catch (error) { nestedError = error; }
      return null;
    }
  });
  manager = new ScheduledTaskManager({ scanner: scanner(async () => { scans++; }) });
  assert.equal((await manager.execute(refreshLibraryTaskId, options)).Status, 'Completed');
  assert.equal(scans, 1);
  assert.equal(nestedError?.code, 'task-running');
  await manager.close();
});

test('localization failures fall back without orphaning an execution or its queued successor', async () => {
  const operations = [];
  const reported = [];
  const manager = new ScheduledTaskManager({
    scanner: scanner(({ signal }) => {
      const operation = Promise.withResolvers();
      operations.push({ ...operation, signal });
      signal.addEventListener('abort', () => operation.reject(signal.reason), { once: true });
      return operation.promise;
    }),
    localization: { text() { throw new Error('localization unavailable'); } },
    onError: error => reported.push(error)
  });
  const first = manager.execute(refreshLibraryTaskId);
  await Promise.resolve();
  const queued = manager.cancelIfRunningAndQueue(refreshLibraryTaskId);
  assert.equal((await first).Status, 'Cancelled');
  for (let count = 0; count < 10 && operations.length < 2; count++) await Promise.resolve();
  assert.equal((await manager.get(refreshLibraryTaskId)).Name, 'Scan Media Library');
  operations[1].resolve();
  assert.equal((await Promise.race([
    queued,
    new Promise((_, reject) => setTimeout(() => reject(new Error('localized successor was orphaned')), 250))
  ])).Status, 'Completed');
  assert.ok(reported.length > 0);
  assert.ok(reported.every(error => error.message === 'localization unavailable'));
  await manager.close();
});

test('invalid persisted history is reported and ignored while invalid trigger configuration fails startup', async () => {
  const historyFailureReports = [];
  const historyManager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store: {
      async loadTriggers() { return null; },
      async loadHistory() { return { Status: 'Completed' }; },
      async saveTriggers() {}, async saveHistory() {}, async close() {}
    },
    onError: error => historyFailureReports.push(error)
  });
  await historyManager.initialize();
  assert.equal(Object.hasOwn((await historyManager.get(refreshLibraryTaskId)), 'LastExecutionResult'), false);
  assert.match(historyFailureReports[0].message, /history is incomplete/u);
  await historyManager.close();

  const invalidDateReports = [];
  const invalidDateManager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store: {
      async loadTriggers() { return null; },
      async loadHistory() {
        return {
          StartTimeUtc: '2026-02-30T00:00:00Z', EndTimeUtc: '10000-01-01T00:00:00Z', Status: 'Completed',
          Name: 'Scan Media Library', Key: 'RefreshLibrary', Id: refreshLibraryTaskId
        };
      },
      async saveTriggers() {}, async saveHistory() {}, async close() {}
    },
    onError: error => invalidDateReports.push(error)
  });
  await invalidDateManager.initialize();
  assert.equal(Object.hasOwn((await invalidDateManager.get(refreshLibraryTaskId)), 'LastExecutionResult'), false);
  assert.match(invalidDateReports[0].message, /does not describe this task/u);
  await invalidDateManager.close();

  const triggerManager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store: {
      async loadTriggers() { return [{ Type: 'WeeklyTrigger', TimeOfDayTicks: 0n }]; },
      async loadHistory() { return null; },
      async saveTriggers() {}, async saveHistory() {}, async close() {}
    }
  });
  await assert.rejects(triggerManager.initialize(), /DayOfWeek/u);
  await triggerManager.close();

  const ioFailure = Object.assign(new Error('history permission denied'), { code: 'EACCES' });
  const ioManager = new ScheduledTaskManager({
    scanner: scanner(async () => {}),
    store: {
      async loadTriggers() { return null; },
      async loadHistory() { throw ioFailure; },
      async saveTriggers() {}, async saveHistory() {}, async close() {}
    }
  });
  await assert.rejects(ioManager.initialize(), error => error === ioFailure);
  await ioManager.close();
});
