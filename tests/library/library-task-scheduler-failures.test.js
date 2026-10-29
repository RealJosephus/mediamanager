import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { idKey } from '../../src/library/records.js';
import { libraryFailureFixture, reasonCases, outcome, observation, sameReason, combined } from './library-failure-fixture.js';

export const requiredValidationServices = ['postgres'];
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const setting of [1, 2]) test(`postgres: scheduler mode ${setting} preserves actual source and iterator failures while releasing Local/SQL owners`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 360000,
}, async t => {
  const f = await libraryFailureFixture(t, 'scheduler-failures-' + setting), diagnostics = f.report.diagnostics;
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: setting },
    onError: reason => diagnostics.push(observation(reason)) }); f.schedulers.push(scheduler);
  for (const phase of ['count', 'page', 'return', 'page-and-return']) for (const [name, reason] of reasonCases()) {
    const label = phase + ':' + name; await f.reset();
    const control = phase === 'count' ? { countReason: reason } : phase === 'return' ? { returnReason: reason }
      : { nextReason: reason, ...(phase === 'page-and-return' ? { returnReason: 0 } : {}) };
    const current = await f.sequence(['first', 'next'], label, control), calls = [];
    let result;
    try {
      result = await outcome(scheduler.enqueue(current.owned, async item => { calls.push(idKey(item.Id)); await f.persist(item, label); }));
      assert.equal(result.failed, true);
      if (phase === 'page-and-return') combined(result.reason, reason, [0]); else sameReason(result.reason, reason);
      assert.equal(current.entry.countCompleted, true);
      if (phase === 'count') assert.equal(current.entry.nextCompleted, false);
      else { assert.equal(current.entry.nextCompleted, true); assert.equal(current.entry.returnCompleted, true); assert.equal(current.held.closed, true); }
      assert.deepEqual(calls, phase === 'return' ? [idKey(f.ids.first), idKey(f.ids.next)] : []);
      for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview,
        phase === 'return' ? label : '');
    } finally { await current.owned.close(); }
    const released = await f.released(), recovery = await f.sequence(['first', 'next'], label + ':recovery'), recovered = [];
    try {
      await scheduler.enqueue(recovery.owned, async item => { recovered.push(idKey(item.Id)); await f.persist(item, label + ':recovery'); });
      assert.deepEqual(recovered, [idKey(f.ids.first), idKey(f.ids.next)]);
    } finally { await recovery.owned.close(); }
    f.report.cases.push({ phase, name, sourceFailure: observation(reason), outcome: observation(result.reason), calls, released,
      recovered, recoveryReleased: await f.released() });
  }
  for (const [name, reason] of reasonCases()) for (const cleanup of [0, undefined]) {
    const label = 'predicate:' + name + ':' + typeof cleanup; await f.reset();
    const current = await f.sequence(['first', 'next'], label, { returnReason: cleanup }), predicateCalls = [], calls = [];
    let result;
    try {
      result = await outcome(scheduler.enqueue(current.owned, item => { calls.push(idKey(item.Id)); return f.persist(item, label); },
        { predicate: item => { predicateCalls.push(idKey(item.Id)); throw reason; } }));
      assert.equal(result.failed, true); combined(result.reason, reason, [cleanup]);
      assert.deepEqual(predicateCalls, [idKey(f.ids.first)]); assert.deepEqual(calls, []);
      assert.equal(current.entry.countCompleted, false); assert.equal(current.entry.nextCompleted, true);
      assert.equal(current.entry.returnCompleted, true); assert.equal(current.held.closed, true);
      for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, '');
    } finally { await current.owned.close(); }
    const released = await f.released(), recovery = await f.sequence(['first', 'next'], label + ':recovery'), trace = [];
    try {
      await scheduler.enqueue(recovery.owned, async item => { trace.push(['worker', idKey(item.Id)]); await f.persist(item, label + ':recovery'); },
        { predicate: item => { trace.push(['predicate', idKey(item.Id)]); return true; } });
      assert.deepEqual(trace.slice(0, 2), [['predicate', idKey(f.ids.first)], ['predicate', idKey(f.ids.next)]]);
      assert.deepEqual(trace.filter(([phase]) => phase === 'worker').map(([, id]) => id), [idKey(f.ids.first), idKey(f.ids.next)]);
    } finally { await recovery.owned.close(); }
    f.report.cases.push({ phase: 'predicate', name, primary: observation(reason), cleanup: observation(cleanup), reason: observation(result.reason),
      predicateCalls, calls, released, recoveryTrace: trace, recoveryReleased: await f.released() });
  }
  for (const cleanup of [0, undefined]) {
    const label = 'invalid-preparation-page:' + typeof cleanup; await f.reset();
    const current = await f.sequence(['first', 'next'], label, { invalidPage: true, returnReason: cleanup });
    let predicateCalled = false, workerCalled = false, result;
    try {
      result = await outcome(scheduler.enqueue(current.owned, () => { workerCalled = true; }, { predicate: () => { predicateCalled = true; return true; } }));
      assert.equal(result.failed, true);
      combined(result.reason, { message: 'Library work pages must contain at most 128 items.' }, [cleanup]);
      assert.equal(predicateCalled, false); assert.equal(workerCalled, false);
      assert.equal(current.entry.nextCompleted, true); assert.equal(current.entry.returnCompleted, true); assert.equal(current.held.closed, true);
      for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, '');
    } finally { await current.owned.close(); }
    f.report.cases.push({ phase: 'invalid-preparation-page', cleanup: observation(cleanup), reason: observation(result.reason), predicateCalled, workerCalled,
      released: await f.released() });
  }
  for (const [name, reason] of reasonCases()) {
    const label = 'worker:' + name; await f.reset();
    const current = await f.sequence(['first', 'next'], label), handler = [], calls = [];
    let sourceEntered = false;
    try {
      const result = await outcome(scheduler.enqueue(current.owned, async item => {
        calls.push(idKey(item.Id)); await f.persist(item, label);
        if (idKey(item.Id) === idKey(f.ids.first)) { sourceEntered = true; throw reason; }
      }, { onError: (error, child) => { handler.push({ reason: error, itemId: idKey(child.Id), name: child.Name }); throw undefined; } }));
      assert.equal(result.failed, false); assert.equal(sourceEntered, true);
      assert.deepEqual(calls, [idKey(f.ids.first), idKey(f.ids.next)]);
      assert.deepEqual(handler.map(({ itemId, name }) => ({ itemId, name })), [{ itemId: idKey(f.ids.first), name: 'first' }]);
      sameReason(handler[0].reason, reason);
      for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, label);
      f.report.cases.push({ phase: 'worker', name, sourceEntered, handler: handler.map(entry => ({ ...entry, reason: observation(entry.reason) })), calls });
    } finally { await current.owned.close(); }
    const recovery = await f.sequence(['first', 'next'], label + ':recovery');
    try { await scheduler.enqueue(recovery.owned, item => f.persist(item, label + ':recovery')); }
    finally { await recovery.owned.close(); }
    for (const key of ['first', 'next']) assert.equal((await f.database.rows('BaseItems', { where: { Id: f.ids[key] } }))[0].Overview, label + ':recovery');
    f.report.cases.at(-1).recoveryReleased = await f.released();
  }
  const gate = f.gate(), current = await f.sequence(['first', 'next'], 'gated-return', { returnReason: undefined, returnGate: gate });
  let workCompleted = false, closeCompleted = false;
  const work = outcome(scheduler.enqueue(current.owned, item => f.persist(item, 'gated-return'))).then(result => { workCompleted = true; return result; });
  const entered = await Promise.race([gate.entered.promise.then(() => ({ entered: true })), work.then(result => ({ entered: false, result }))]);
  assert.equal(entered.entered, true, 'The work must reach its actual iterator release gate before settling.');
  const closing = scheduler.close().then(() => { closeCompleted = true; });
  try {
    await tick(); assert.equal(current.held.closed, true); assert.equal(current.entry.returnCompleted, true);
    assert.equal(workCompleted, false); assert.equal(closeCompleted, false);
  } finally { gate.release.resolve(); }
  const result = await work; await closing;
  assert.equal(result.failed, true); sameReason(result.reason, undefined); assert.equal(closeCompleted, true);
  await current.owned.close(); await f.released();
  let lateCalled = false; await scheduler.enqueue(current.owned, () => { lateCalled = true; }); assert.equal(lateCalled, false);
  f.report.cases.push({ phase: 'gated-return', reason: observation(result.reason), actualFileClosed: current.held.closed, workCompleted, closeCompleted, lateCalled });
});
