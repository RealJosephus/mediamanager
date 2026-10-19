import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeLruCache } from '../../src/core/native-lru.js';
import { input, native } from '../library/dot-ignore-fixture.js';
import { assertProjectedEqual } from '../comparison-observations.js';
const resident = ({ hotCount, warmCount, coldCount, ...value }) => value;

for (const sample of input.caches) test('native TU-Q operations: ' + sample.id, t => {
  const cache = new NativeLruCache(sample.capacity);
  const expected = native.caches.find(group => group.id === sample.id).operations;
  for (let index = 0; index < sample.actions.length; index++) {
    const action = sample.actions[index];
    let found = null, value = null;
    if (action.operation === 'set') cache.set(action.key, action.value);
    else if (action.operation === 'get') { const result = cache.get(action.key); found = result !== undefined; value = result ?? 0; }
    else if (action.operation === 'remove') {
      const entry = [...cache.entries()].find(([key]) => key === action.key);
      found = cache.delete(action.key); value = entry?.[1] ?? 0;
    } else cache.clear();
    const actual = { operation: action.operation, key: action.key ?? '', found, value, count: cache.size,
      hotCount: cache.hotCount, warmCount: cache.warmCount, coldCount: cache.coldCount,
      entries: [...cache.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value })) };
    assertProjectedEqual(t, `${sample.id}: operation ${index}`, actual, expected[index], resident);
  }
});
