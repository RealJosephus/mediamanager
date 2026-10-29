import { after, before } from 'node:test';
import { acquireTestResources, settleTestResourceRelease } from './test-resource-group.js';

let fileGroup;

function groupForFile() {
  if (fileGroup) return fileGroup;
  const admission = Promise.withResolvers();
  // A root before hook may fail without any protected callback being entered.
  // Its original rejection still reaches every admitted waiter and node:test.
  void admission.promise.catch(() => {});
  const group = { declarations: [], running: new Set(), leases: [], started: false, admitted: false, closing: false, admission };
  before(async context => {
    // An already-started node:test root runs a new before hook immediately.
    // Collect this synchronous declaration segment before sealing its group.
    try {
      await Promise.resolve();
      group.started = true;
      group.leases = await acquireTestResources(group.declarations, { signal: context.signal });
      group.admitted = true;
      admission.resolve();
    } catch (error) { admission.reject(error); throw error; }
  });
  after(async () => {
    group.closing = true;
    const errors = [];
    // node:test can finish a timed-out test while its callback's finally is
    // still running. Retain the entire declaration set until those callbacks settle.
    while (group.running.size) {
      for (const result of await Promise.allSettled([...group.running])) if (result.status === 'rejected') errors.push(result.reason);
    }
    errors.push(...await settleTestResourceRelease(group.leases));
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Protected test callbacks or resource release failed.', { cause: errors[0] });
  });
  fileGroup = group;
  return group;
}

/** Admit a test file before its business timers, retaining ownership through real cleanup. */
export function declareFileTestResource(key, { enabled = true, root, onWait } = {}) {
  const group = groupForFile(), declaration = { key, enabled, root, onWait };
  if (group.started || group.closing) throw new Error('The test file has already started admitting its declared resources.');
  group.declarations.push(declaration);
  const running = new Set();
  return {
    run(operation, { signal } = {}) {
      if (typeof operation !== 'function') throw new TypeError('A protected test operation is required.');
      signal?.throwIfAborted();
      if (!enabled || group.closing) throw new Error('The test file does not own its declared resource.');
      if (running.size) throw new Error('The previous protected test callback has not finished its cleanup.');
      const pending = Promise.resolve().then(async () => {
        // When the root is already running, node:test starts a newly registered
        // before hook immediately. Its protected initialization must await the
        // same actual file admission rather than racing the first async hook.
        await group.admission.promise;
        signal?.throwIfAborted();
        if (!group.admitted || group.closing) throw new Error('The test file does not own its declared resource.');
        return operation();
      });
      running.add(pending);
      group.running.add(pending);
      const finished = () => { running.delete(pending); group.running.delete(pending); };
      pending.then(finished, finished);
      return pending;
    },
  };
}
