import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createTestApplication } from '../helpers/application.js';

const taskId = '7738148ffcd07979c7ceb148e06b3aed';
const task = Object.freeze({
  Name: 'Scan Media Library',
  State: 'Idle',
  Id: taskId,
  Triggers: [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000n }],
  Description: 'Scans your media library for new files and refreshes metadata.',
  Category: 'Library',
  IsHidden: false,
  Key: 'RefreshLibrary'
});

async function fixture({ tasks, administrator = true, onError = () => {} } = {}) {
  const application = await createTestApplication({
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    authentication: {
      async authenticate() { return { IsAuthenticated: true, IsAdministrator: administrator }; },
      authorize(auth, { policy }) {
        assert.equal(policy, 'RequiresElevation');
        if (!auth.IsAdministrator) throw Object.assign(new Error('Forbidden'), { status: 403 });
      }
    },
    tasks,
    onError
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${application.server.address().port}`,
    close: () => new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()))
  };
}

test('scheduled task routes expose complete task DTOs and bind native filters', async () => {
  const filters = [];
  const manager = {
    async list(options) { filters.push(options); return [task]; },
    has(id) { return id.toLowerCase() === taskId; },
    async get(id) { return id.toLowerCase() === taskId ? task : null; },
    execute() { throw new Error('Unexpected start'); },
    cancel() { throw new Error('Unexpected cancel'); }
  };
  const application = await fixture({ tasks: manager });
  try {
    const listed = await fetch(`${application.origin}/ScheduledTasks?isHidden=false&isEnabled=true`);
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [{ ...task, Triggers: [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000 }] }]);
    assert.deepEqual(filters, [{ isHidden: false, isEnabled: true }]);

    const found = await fetch(`${application.origin}/ScheduledTasks/${taskId.toUpperCase()}`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { ...task, Triggers: [{ Type: 'IntervalTrigger', IntervalTicks: 432000000000 }] });
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/missing`)).status, 404);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks?isHidden=invalid`)).status, 400);
  } finally {
    await application.close();
  }
});

test('scheduled task start acknowledges registered background work and cancellation is explicit', async t => {
  const calls = [];
  const completion = Promise.withResolvers();
  const completedFinally = { start: Promise.withResolvers(), cancel: Promise.withResolvers() };
  const failureValue = error => ({ message: error?.message, code: error?.code ?? null,
    status: error?.status ?? error?.statusCode ?? null });
  const cancellationFailure = Object.assign(new Error('Synthetic cancellation failure'), { code: 'controlled-task-cancel' });
  const failures = [];
  const runWorker = async (operation, work) => {
    try { await work(); }
    catch (error) { failures.push({ operation, value: failureValue(error), error }); throw error; }
    finally { completedFinally[operation].resolve(); }
  };
  let execution, cancellation;
  const manager = {
    async list() { return [task]; },
    has(id) { return id.toLowerCase() === taskId; },
    async get(id) { return id.toLowerCase() === taskId ? task : null; },
    execute(id) { calls.push(['start', id]); execution = runWorker('start', () => completion.promise); return execution; },
    cancel(id) { calls.push(['cancel', id]); cancellation = runWorker('cancel', async () => { throw cancellationFailure; }); return cancellation; }
  };
  const errors = [];
  let closing = false;
  const application = await fixture({ tasks: manager, onError: error => errors.push({ duringClose: closing, error }) });
  try {
    const response = await Promise.race([
      fetch(`${application.origin}/ScheduledTasks/Running/${taskId}`, { method: 'POST' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Task start waited for completion.')), 1000))
    ]);
    assert.equal(response.status, 204);
    assert.ok(response.headers.get('date'));
    assert.deepEqual(calls, [['start', taskId]]);

    const failure = Object.assign(new Error('Synthetic background failure'), { code: 'controlled-task-start' });
    completion.reject(failure);
    await assert.rejects(execution, error => { assert.deepEqual(failureValue(error), failureValue(failure)); return true; });
    await completedFinally.start.promise;

    assert.equal((await fetch(`${application.origin}/ScheduledTasks/Running/${taskId.toUpperCase()}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(calls, [['start', taskId], ['cancel', taskId.toUpperCase()]]);
    await assert.rejects(cancellation, error => { assert.deepEqual(failureValue(error), failureValue(cancellationFailure)); return true; });
    await completedFinally.cancel.promise;
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/Running/missing`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/Running/missing`, { method: 'DELETE' })).status, 404);
  } finally {
    completion.resolve();
    await Promise.allSettled([execution, cancellation].filter(Boolean));
    closing = true;
    try { await application.close(); }
    finally { t.diagnostic(inspect({ failures, errors }, { depth: null })); }
  }
  for (const { duringClose, error } of errors) {
    assert.equal(duringClose, false, 'Normal application close must not report a background task failure.');
    assert.ok(failures.some(failure => {
      const value = failureValue(error);
      return value.message === failure.value.message && value.code === failure.value.code && value.status === failure.value.status;
    }), 'Only a failure from an actual task worker may classify its diagnostic.');
  }
});

test('scheduled task routes require elevation and report missing task configuration honestly', async () => {
  const reader = await fixture({
    administrator: false,
    tasks: { list() { throw new Error('Unauthorized list ran'); } }
  });
  try {
    assert.equal((await fetch(`${reader.origin}/ScheduledTasks`)).status, 403);
    assert.equal((await fetch(`${reader.origin}/ScheduledTasks/${taskId}`)).status, 403);
    assert.equal((await fetch(`${reader.origin}/ScheduledTasks/Running/${taskId}`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${reader.origin}/ScheduledTasks/${taskId}/Triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]'
    })).status, 403);
  } finally {
    await reader.close();
  }

  const missing = await fixture();
  try {
    assert.equal((await fetch(`${missing.origin}/ScheduledTasks`)).status, 501);
    assert.equal((await fetch(`${missing.origin}/ScheduledTasks/${taskId}`)).status, 501);
  } finally {
    await missing.close();
  }
});

test('scheduled trigger updates accept native arrays, bind casing and reject malformed transport input', async () => {
  const updates = [];
  const manager = {
    async list() { return [task]; },
    has(id) { return id.toLowerCase() === taskId; },
    async get(id) { return id.toLowerCase() === taskId ? task : null; },
    async updateTriggers(id, triggers) {
      if (!Array.isArray(triggers)) throw Object.assign(new TypeError('Triggers must be an array.'), { status: 400 });
      updates.push([id, triggers]);
    }
  };
  const application = await fixture({ tasks: manager });
  try {
    const updated = await fetch(`${application.origin}/ScheduledTasks/${taskId.toUpperCase()}/Triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ type: 'StartupTrigger', INTERVALTICKS: 42, maxRuntimeTicks: -1, Ignored: 'native binder ignores this' }])
    });
    assert.equal(updated.status, 204);
    assert.deepEqual(updates, [[taskId.toUpperCase(), [{
      Type: 'StartupTrigger', IntervalTicks: 42n, MaxRuntimeTicks: -1n
    }]]]);

    const nativeNumericStrings = await fetch(`${application.origin}/ScheduledTasks/${taskId}/Triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[{"Type":"+2","IntervalTicks":"+1","MaxRuntimeTicks":"+3"},{"Type":" 1 ","TimeOfDayTicks":"+2","DayOfWeek":" Tuesday "}]'
    });
    assert.equal(nativeNumericStrings.status, 204);
    assert.deepEqual(updates.at(-1), [taskId, [
      { Type: 'IntervalTrigger', IntervalTicks: 1n, MaxRuntimeTicks: 3n },
      { Type: 'WeeklyTrigger', TimeOfDayTicks: 2n, DayOfWeek: 'Tuesday' }
    ]]);

    for (const body of [
      '[{"Type":"IntervalTrigger","IntervalTicks":1.0}]',
      '[{"Type":"IntervalTrigger","IntervalTicks":1e0}]',
      '[{"Type":2.0,"IntervalTicks":1}]',
      '[{"Type":"WeeklyTrigger","TimeOfDayTicks":1,"DayOfWeek":1.0}]'
    ]) {
      assert.equal((await fetch(`${application.origin}/ScheduledTasks/${taskId}/Triggers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      })).status, 400, `${body} must retain System.Text.Json integer-token strictness`);
    }

    assert.equal((await fetch(`${application.origin}/ScheduledTasks/missing/Triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]'
    })).status, 404);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/${taskId}/Triggers`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '[]'
    })).status, 415);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/${taskId}/Triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ''
    })).status, 400);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/${taskId}/Triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })).status, 400);
  } finally {
    await application.close();
  }
});

test('scheduled task mutation edge statuses match the native fire-and-forget controller', async () => {
  const manager = {
    async list() { return [task]; },
    has(id) { return id.toLowerCase() === taskId; },
    async get(id) { return id.toLowerCase() === taskId ? task : null; },
    execute() { throw Object.assign(new Error('Already running'), { status: 409, code: 'task-running' }); },
    cancel() { throw Object.assign(new Error('Not running'), { status: 409, code: 'task-not-running' }); }
  };
  const application = await fixture({ tasks: manager });
  try {
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/Running/${taskId}`, { method: 'POST' })).status, 204);
    assert.equal((await fetch(`${application.origin}/ScheduledTasks/Running/${taskId}`, { method: 'DELETE' })).status, 500);
  } finally {
    await application.close();
  }
});
