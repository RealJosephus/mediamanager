import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import native from './fixtures/refresh-queue-native.json' with { type: 'json' };

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
