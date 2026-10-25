import { after, before } from 'node:test';
import { acquireTestResource } from './test-resource-lease.js';

/** Admit a test file before its business timers, retaining ownership through real cleanup. */
export function declareFileTestResource(key, { enabled = true, root, onWait } = {}) {
  let lease, closing = false;
  const running = new Set();
  before(async context => {
    if (enabled) lease = await acquireTestResource(key, { root, signal: context.signal, onWait });
  });
  after(async () => {
    closing = true;
    const errors = [];
    // node:test can finish a timed-out test while its callback's finally is
    // still running. Keep the filesystem owner until those callbacks settle.
    while (running.size) {
      for (const result of await Promise.allSettled([...running])) if (result.status === 'rejected') errors.push(result.reason);
    }
    try { await lease?.release(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Protected test callbacks or resource release failed.', { cause: errors[0] });
  });
  return {
    run(operation, { signal } = {}) {
      if (typeof operation !== 'function') throw new TypeError('A protected test operation is required.');
      signal?.throwIfAborted();
      if (!lease || closing) throw new Error('The test file does not own its declared resource.');
      if (running.size) throw new Error('The previous protected test callback has not finished its cleanup.');
      const pending = Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); });
      running.add(pending);
      pending.then(() => running.delete(pending), () => running.delete(pending));
      return pending;
    },
  };
}
