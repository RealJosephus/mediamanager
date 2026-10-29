import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import native from './fixtures/refresh-queue/native.json' with { type: 'json' };

const failureFields = error => error == null || typeof error !== 'object' ? error
  : Array.isArray(error) ? error.map(failureFields)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error
    ? ['message', 'code', 'status', 'statusCode', 'cause', 'errors'].filter(key => key in error) : [])])]
    .filter(key => !(error instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, failureFields(error[key])]));

const inputs = {
  'equal-high': { priorities: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
  'mixed-priorities': { priorities: [2, 1, 0, 2, 0, 1, 0, 2, 1, 0, 1, 2, 0] },
  'provider-cancellation': { priorities: [0, 0, 0, 0], cancelItems: ['item-1'] },
  shutdown: { priorities: [0, 0, 0], shutdown: true },
};

for (const expected of native) test(`actual native ProviderManager queue: ${expected.name}`, async () => {
  const input = inputs[expected.name];
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const order = [], failures = [];
  let active = 0, maximumConcurrency = 0;
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {} });
  host.refresh = async reference => {
    active++; maximumConcurrency = Math.max(maximumConcurrency, active); order.push(reference);
    try {
      if (reference === 'item-0') { started.resolve(); await release.promise; }
      if (input.cancelItems?.includes(reference)) {
        failures.push(reference);
        throw new DOMException('Controlled provider cancellation.', 'AbortError');
      }
    } finally { active--; }
  };
  const tasks = [host.queue('item-0', {}, input.priorities[0])];
  await started.promise;
  for (let index = 1; index < input.priorities.length; index++) tasks.push(host.queue(`item-${index}`, {}, input.priorities[index]));
  const settled = Promise.allSettled(tasks);
  const beforeRelease = [...order];
  let closing;
  if (input.shutdown) closing = host.close();
  release.resolve();
  await settled;
  await (closing ?? host.drain());
  const { refreshEvents, ...queueContract } = expected;
  assert.equal(refreshEvents, 0, 'the actual native BaseItem metadata refresh does not publish Folder progress events');
  assert.deepEqual({ name: expected.name, beforeRelease, order, failures, maximumConcurrency }, queueContract);
  await host.close();
});

test('refresh queue preserves repeated ids and admits a new entry after standing down', async () => {
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {} });
  const order = [];
  host.refresh = async id => order.push(id);
  await Promise.all([host.queue('same'), host.queue('same')]);
  await host.drain();
  await delay(0);
  await host.queue('later');
  await host.drain();
  assert.deepEqual(order, ['same', 'same', 'later']);
  await host.close();
  await host.queue('disposed');
  assert.deepEqual(order, ['same', 'same', 'later']);
});

test('shutdown drains admitted configuration refreshes while preserving explicit cancellation and expiring their admission', async () => {
  const reachedContext = new Error('Admitted refresh reached its persistence context.');
  const host = new MetadataRefreshHost({ registry: {}, store: {},
    linkedChildren: { async flushReleases() {} }, loadContext() { throw reachedContext; } });
  const admission = host.admitShutdownDrain();
  const ordinaryRefresh = host.bindShutdownDrain(() => host.refresh('ordinary-worker'));
  const refresh = admission.run(() => host.bindShutdownDrain(options => host.refresh('configuration', options)));
  const queued = admission.run(() => host.queue('queued', {}, 0, { ready: new Promise(() => {}) }));
  const cancelledQueue = assert.rejects(queued, { name: 'AbortError' });
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  try {
    await cancelledQueue;
    assert.equal(closed, false, 'close retains the dependencies of the admitted configuration operation');
    await assert.rejects(host.refresh('ordinary'), { name: 'AbortError' });
    await assert.rejects(admission.run(ordinaryRefresh), { name: 'AbortError' });
    await assert.rejects(refresh(Object.freeze({})), { message: reachedContext.message });
    // A caller token is observed at the provider boundary, after loading and
    // owned-file maintenance. Supply a real non-owned entity to reach it.
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Person');
    item.Id = '6e7cc5e2-80a1-4b66-bfd5-d9356d7e2918';
    let disposed = false;
    host.loadContext = async () => ({ item, async dispose() { disposed = true; } });
    const reason = new DOMException('Explicit configuration cancellation.', 'AbortError');
    const controller = new AbortController(); controller.abort(reason);
    await assert.rejects(refresh({ signal: controller.signal }), { code: reason.code, message: reason.message });
    assert.equal(controller.signal.aborted, true);
    assert.equal(disposed, true);
  } finally { admission.release(); await closing; }
  await assert.rejects(refresh(), { name: 'AbortError' });
  assert.throws(() => host.admitShutdownDrain(), { name: 'AbortError' });
});

test('refresh queue admits full item dispatch with its existing priority and shutdown lifetime', async () => {
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {} });
  const started = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  host.refresh = async () => assert.fail('Queued full-item work must use its installed dispatcher.');
  host.queuedRefresh = async (reference, options) => {
    calls.push(reference);
    assert.equal(options.IsAutomated, true);
    if (reference === 'active') { started.resolve(options.signal); await release.promise; options.signal.throwIfAborted(); }
  };
  const active = host.queue('active', { IsAutomated: true }, 0), activeResult = Promise.allSettled([active]);
  const signal = await started.promise;
  const pending = host.queue('pending', { IsAutomated: true }, 0), pendingResult = Promise.allSettled([pending]);
  const closing = host.close(); assert.equal(signal.aborted, true); release.resolve();
  await closing;
  assert.equal((await activeResult)[0].status, 'rejected'); assert.equal((await pendingResult)[0].status, 'rejected');
  assert.deepEqual(calls, ['active']);
});

test('the queue boundary owns one live batch across provider failures and new admission', async () => {
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {} });
  const started = Promise.withResolvers(), release = Promise.withResolvers(), events = [];
  host.runQueuedBatch = async (operation, { signal }) => {
    events.push('begin');
    try { await operation(); } finally { if (!signal.aborted) events.push('end'); }
  };
  host.queuedRefresh = async reference => {
    events.push(reference);
    if (reference === 'first') { started.resolve(); await release.promise; throw new Error('Provider failed'); }
  };
  const first = host.queue('first'), firstResult = Promise.allSettled([first]);
  await started.promise;
  const second = host.queue('second');
  release.resolve();
  await second; await firstResult; await host.drain();
  assert.deepEqual(events, ['begin', 'first', 'second', 'end']);
  await host.queue('later'); await host.drain();
  assert.deepEqual(events.slice(-3), ['begin', 'later', 'end']);
  await host.close();
});

test('queued metadata waits for its mutation owner and shutdown cancels that wait', { timeout: 5000 }, async () => {
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {} });
  const ready = Promise.withResolvers(), calls = [];
  host.queuedRefresh = async reference => calls.push(reference);
  const queued = host.queue('collection', {}, 0, { ready: ready.promise });
  assert.ok(host.getRefreshQueue().has('collection'), 'admission remains synchronous');
  await delay(0);
  assert.deepEqual(calls, [], 'the worker cannot capture the item before its mutation completes');
  ready.resolve();
  await queued;
  assert.deepEqual(calls, ['collection']);
  const waiting = host.queue('cancelled', {}, 0, { ready: new Promise(() => {}) });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await delay(0);
  await host.close();
  await rejected;
  assert.deepEqual(calls, ['collection']);
});

test('a queue boundary failure settles pending callers and permits a later batch', async t => {
  const failure = new Error('Cannot initialize queue boundary'), errors = [];
  t.after(() => t.diagnostic(inspect({ background: errors }, { depth: null })));
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {}, logger: { error: error => errors.push(error) } });
  host.runQueuedBatch = async () => { throw failure; };
  const results = await Promise.allSettled([host.queue('first'), host.queue('second')]);
  await host.drain();
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.deepEqual(failureFields(result.reason), failureFields(failure));
  }
  for (const error of errors) assert.deepEqual(failureFields(error), failureFields(failure));
  host.runQueuedBatch = operation => operation();
  host.queuedRefresh = async reference => reference;
  assert.equal(await host.queue('later'), 'later');
  await host.close();
});
