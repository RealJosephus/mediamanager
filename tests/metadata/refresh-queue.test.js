import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import native from './fixtures/refresh-queue/native.json' with { type: 'json' };

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

test('a queue boundary failure settles pending callers and permits a later batch', async () => {
  const failure = new Error('Cannot initialize queue boundary'), errors = [];
  const host = new MetadataRefreshHost({ registry: {}, loadContext() {}, store: {}, logger: { error: error => errors.push(error) } });
  host.runQueuedBatch = async () => { throw failure; };
  const results = await Promise.allSettled([host.queue('first'), host.queue('second')]);
  await host.drain();
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.deepEqual(errors, [failure]);
  host.runQueuedBatch = operation => operation();
  host.queuedRefresh = async reference => reference;
  assert.equal(await host.queue('later'), 'later');
  await host.close();
});
