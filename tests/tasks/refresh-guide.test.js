import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { md5Guid } from '../../src/core/identity.js';
import { dateTicks } from '../../src/library/records.js';
import { ScheduledTaskManager, ScheduledTaskWorker, RefreshGuideTaskWorker, refreshGuideTaskId } from '../../src/tasks/index.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const inputFile = new URL('./fixtures/refresh-guide/input.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)
    .map(([key, entry]) => [key, key === 'IntervalTicks' ? String(entry) : normalize(entry)]));
  return value;
};
const historyProjection = value => {
  assert.ok(value.StartTimeUtc.endsWith('Z') && value.EndTimeUtc.endsWith('Z'));
  assert.ok(dateTicks(value.EndTimeUtc) >= dateTicks(value.StartTimeUtc));
  if (value.Status === 'Failed') assert.ok(typeof value.LongErrorMessage === 'string' && value.LongErrorMessage);
  const { StartTimeUtc, EndTimeUtc, LongErrorMessage, ...rest } = value;
  return rest;
};
class DisabledWorker extends ScheduledTaskWorker {
  constructor(options) { super({ ...options, definition: { id: md5Guid('DisabledTask'), key: 'ControlledDisabled',
    name: 'Disabled controlled task', description: 'Controlled configurable filtering.', category: 'Controlled',
    configurable: true, defaultTriggers: [] }, run: async () => {} }); }
  isEnabled() { return false; }
}

test('Refresh Guide metadata, live configurable filtering and execution match the actual native task/controller/worker', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async () => {
  const root = path.join(validationOutputRoot(), 'refresh-guide-task-' + randomUUID()); await mkdir(root);
  const bytes = await readFile(inputFile), input = JSON.parse(bytes), filename = path.join(root, 'input.json'); await writeFile(filename, bytes);
  const receipt = await recordOracle({ project: 'tests/tasks/fixtures/refresh-guide/Oracle.csproj', output: path.join(root, 'native'),
    args: [filename, '{output}/native.json'] });
  const nativeBytes = await readFile(path.join(root, 'native/native.json')), native = JSON.parse(nativeBytes);
  assert.ok(receipt.passed && native.actualRefreshGuideScheduledTask && native.actualScheduledTaskWorker && native.actualScheduledTasksController);
  assert.equal(native.inputSha256, sha(bytes)); assert.equal(native.privateInputsRemoved, true);
  assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, sha(nativeBytes));
  for (const assembly of native.assemblies) assert.equal(sha(await readFile(assembly.filename)), assembly.sha256);
  assert.equal(md5Guid(native.task.type), refreshGuideTaskId);
  assert.equal(native.task.IsEnabled, true); assert.equal(native.task.IsLogged, true);
  assert.deepEqual(native.disabledTrigger, { enabledReads: 1, executionCalls: 0, timerReleased: true });
  const timers = new Set(), diagnostics = [], comparisons = [], executionComparisons = [];
  let state = input.states[0], configurationReads = 0, selectedMode = 'completed';
  const calls = [];
  const manager = new ScheduledTaskManager({ programDataPath: path.join(root, 'node'), scanner: {
    capabilities: { completeLibraryScan: true }, async runCompleteScan() {} },
    timers: { set(callback, delay) { const handle = { callback, delay }; timers.add(handle); return handle; }, clear(handle) { timers.delete(handle); } },
    onError: error => diagnostics.push(error.message) });
  await manager.register({ create: options => new RefreshGuideTaskWorker({ ...options, getGuideServiceCount: () => state.serviceCount,
    async getGuideConfiguration() {
      configurationReads++;
      if (state.configurationFailure) throw new Error('Controlled guide configuration failure.');
      return { TunerHosts: state.tunerHosts };
    }, async refreshGuide({ signal, reportProgress }) {
      calls.push({ mode: selectedMode, canBeCanceled: true, canceled: signal.aborted }); reportProgress(12.5); reportProgress(100);
      if (selectedMode === 'failed') throw new Error('Controlled guide refresh failure.');
      if (selectedMode === 'canceled') throw new DOMException('Controlled guide cancellation.', 'AbortError');
    } }) });
  await manager.register({ create: options => new DisabledWorker(options) });
  let failure;
  try {
    await manager.initialize();
    for (const sample of native.observations) {
      state = input.states.find(value => value.name === sample.name); configurationReads = 0;
      let value, error;
      try { value = await manager.list(sample.filter); } catch (caught) { error = caught; }
      comparisons.push({ name: sample.name, filter: sample.filter, value, nativeValue: sample.value,
        error: error?.message, nativeError: sample.error, configurationReads, nativeConfigurationReads: sample.configurationReads });
      assert.equal(configurationReads, sample.configurationReads, sample.name + ': visibility must retain the native short-circuit read prefix.');
      if (sample.error) assert.ok(error, sample.name + ': configuration/nullable-host failures must propagate.');
      else { assert.equal(error, undefined, error?.stack); assert.deepEqual(normalize(value), normalize(sample.value), sample.name); }
    }
    state = input.states[0];
    for (const sample of native.executions) {
      selectedMode = sample.mode; calls.length = 0;
      const result = await manager.execute(refreshGuideTaskId), info = await manager.get(refreshGuideTaskId.toUpperCase());
      assert.equal(info.State, 'Idle'); assert.deepEqual(calls, sample.calls);
      assert.deepEqual(historyProjection(result), historyProjection(sample.history), sample.mode);
      const historyName = refreshGuideTaskId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5.js');
      const history = JSON.parse(await readFile(path.join(root, 'node/data/ScheduledTasks', historyName)));
      assert.deepEqual(history, result); assert.deepEqual(info.LastExecutionResult, result);
      executionComparisons.push({ mode: sample.mode, actual: result, native: sample.history, nativeHistorySha256: sample.historySha256 });
    }
  } catch (error) { failure = error; }
  finally {
    await manager.close();
    assert.equal(timers.size, 0);
    await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ passed: !failure, phaseAcceptance: false, releaseAcceptance: false,
      comparisons, executionComparisons, diagnostics, ownedTimersRemaining: timers.size, error: failure?.stack },
    (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n');
  }
  if (failure) throw failure;
});

test('Refresh Guide close aborts and drains an admitted refresh, with no post-close trigger or configuration reads', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), timers = new Set(), events = [];
  let signal, closed = false, configurationReads = 0;
  const worker = new RefreshGuideTaskWorker({ getGuideServiceCount: () => 1,
    async getGuideConfiguration() { configurationReads++; return { TunerHosts: [] }; },
    async refreshGuide(operation) { signal = operation.signal; entered.resolve(); await release.promise; operation.signal.throwIfAborted(); },
    timers: { set(callback, delay) { const handle = { callback, delay }; timers.add(handle); return handle; }, clear(handle) { timers.delete(handle); } },
  });
  worker.on('started', event => events.push([event.Task.State, event.Task.IsHidden]));
  worker.on('completed', event => events.push([event.Task.State, event.Result.Status]));
  await worker.initialize();
  const execution = worker.execute();
  let closing;
  try {
    await entered.promise; closing = worker.close().then(() => { closed = true; });
    assert.equal(signal.aborted, true); assert.equal(timers.size, 0); assert.equal(closed, false);
    assert.throws(() => worker.execute(), { status: 503 });
    release.resolve(); assert.equal((await execution).Status, 'Aborted'); await closing;
    const reads = configurationReads; await Promise.resolve(); assert.equal(configurationReads, reads);
    assert.deepEqual(events, [['Running', true], ['Idle', 'Aborted']]);
  } finally { release.resolve(); await Promise.allSettled([execution, closing, worker.close()]); }
});

test('disabled configurable triggers stop without a restart while a manual execution remains available', async () => {
  const timers = new Set(); let calls = 0, enabledReads = 0;
  class DisabledIntervalWorker extends ScheduledTaskWorker {
    isEnabled() { enabledReads++; return false; }
  }
  const worker = new DisabledIntervalWorker({ definition: { id: md5Guid('disabled-interval-control'), key: 'DisabledInterval',
    name: 'Disabled interval control', description: 'Controlled trigger admission.', category: 'Controlled', configurable: true,
    defaultTriggers: [{ Type: 'IntervalTrigger', IntervalTicks: 864000000000n }] },
    run: async () => { calls++; },
    timers: { set(callback, delay) { const handle = { callback, delay }; timers.add(handle); return handle; }, clear(handle) { timers.delete(handle); } },
  });
  try {
    await worker.initialize(); const [timer] = timers; assert.equal(timer.delay, 3600000);
    timers.delete(timer); timer.callback(); await Promise.resolve();
    assert.equal(enabledReads, 1); assert.equal(calls, 0); assert.equal(timers.size, 0);
    assert.equal((await worker.execute()).Status, 'Completed'); assert.equal(calls, 1);
    assert.equal(enabledReads, 1, 'A manual start does not test the scheduling enablement flag.');
  } finally { await worker.close(); assert.equal(timers.size, 0); }
});

test('an admitted asynchronous list retains every worker while close drains the configuration read', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let closed = false;
  const manager = new ScheduledTaskManager({ scanner: { capabilities: { completeLibraryScan: true }, async runCompleteScan() {} } });
  await manager.register({ create: options => new RefreshGuideTaskWorker({ ...options, getGuideServiceCount: () => 1,
    async getGuideConfiguration() { entered.resolve(); await release.promise; return { TunerHosts: [] }; }, async refreshGuide() {} }) });
  const reading = manager.list(); reading.catch(() => {}); let closing;
  try {
    await entered.promise; closing = manager.close().then(() => { closed = true; });
    assert.equal(closed, false);
    await assert.rejects(manager.get(refreshGuideTaskId), { status: 503 });
    release.resolve();
    assert.deepEqual((await reading).map(task => task.Key), ['RefreshGuide', 'RefreshLibrary']);
    await closing; assert.equal(closed, true);
  } finally { release.resolve(); await Promise.allSettled([reading, closing, manager.close()]); }
});
