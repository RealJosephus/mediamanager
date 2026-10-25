import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  ScheduledTaskTriggerScheduler,
  cloneTaskTriggers,
  normalizeTaskTriggers
} from '../../src/tasks/scheduled-task-triggers.js';

const ticksPerHour = 60n * 60n * 10_000_000n;
const ticksPerDay = 24n * ticksPerHour;

function timerHarness({ failAt } = {}) {
  const scheduled = [];
  const cleared = [];
  let calls = 0;
  return {
    scheduled,
    cleared,
    api: {
      set(callback, delay) {
        calls++;
        if (calls === failAt) throw new Error(`timer ${calls} failed`);
        const handle = { callback, delay, sequence: calls };
        scheduled.push(handle);
        return handle;
      },
      clear(handle) { cleared.push(handle); }
    }
  };
}

test('trigger DTO binding preserves native fields and rejects incomplete active trigger shapes', () => {
  const triggers = normalizeTaskTriggers([
    null,
    { Type: 'StartupTrigger', TimeOfDayTicks: 1n, IntervalTicks: 2n, DayOfWeek: 'Monday', MaxRuntimeTicks: -1n },
    { Type: 2, IntervalTicks: '432000000000', MaxRuntimeTicks: '-19999' },
    { TimeOfDayTicks: 0 },
    { Type: 'IntervalTrigger', IntervalTicks: 0 },
    { Type: 'DailyTrigger', TimeOfDayTicks: ticksPerDay }
  ]);
  assert.deepEqual(cloneTaskTriggers(triggers), [
    { Type: 'StartupTrigger', TimeOfDayTicks: 1n, IntervalTicks: 2n, DayOfWeek: 'Monday', MaxRuntimeTicks: -1n },
    { Type: 'IntervalTrigger', IntervalTicks: 432000000000n, MaxRuntimeTicks: -19999n },
    { Type: 'DailyTrigger', TimeOfDayTicks: 0n },
    { Type: 'IntervalTrigger', IntervalTicks: 0n },
    { Type: 'DailyTrigger', TimeOfDayTicks: ticksPerDay }
  ]);
  assert.throws(() => normalizeTaskTriggers({}), error => error.status === 400 && error.code === 'invalid-trigger');
  assert.throws(() => normalizeTaskTriggers([{ Type: null }]), error => error.status === 400);
  assert.throws(() => normalizeTaskTriggers([{ Type: 'DailyTrigger' }]), /TimeOfDayTicks/u);
  assert.throws(() => normalizeTaskTriggers([{ Type: 'WeeklyTrigger', TimeOfDayTicks: 0 }]), /DayOfWeek/u);
  assert.throws(() => normalizeTaskTriggers([{ Type: 'IntervalTrigger', IntervalTicks: -1 }]), /supported range/u);
  assert.throws(() => normalizeTaskTriggers([{ Type: 'DailyTrigger', TimeOfDayTicks: ticksPerDay + 1n }]), /supported range/u);
  assert.throws(() => normalizeTaskTriggers([{ Type: 99 }]), /Type is invalid/u);
});

test('daily and weekly triggers compare 100ns wall time before applying native timer millisecond truncation', () => {
  const dailyTimers = timerHarness();
  const daily = new ScheduledTaskTriggerScheduler({
    clock: () => new Date(2026, 9, 4, 0, 0, 0, 0),
    timers: dailyTimers.api
  });
  daily.replace([{ Type: 'DailyTrigger', TimeOfDayTicks: 1n }]);
  assert.equal(dailyTimers.scheduled[0].delay, 0);
  daily.close();

  const missedTimers = timerHarness();
  const missed = new ScheduledTaskTriggerScheduler({
    clock: () => new Date(2026, 9, 4, 0, 0, 0, 1),
    timers: missedTimers.api
  });
  missed.replace([{ Type: 'DailyTrigger', TimeOfDayTicks: 1n }]);
  assert.equal(missedTimers.scheduled[0].delay, 24 * 60 * 60 * 1000 - 1);
  missed.close();

  const endOfDayTimers = timerHarness();
  const endOfDay = new ScheduledTaskTriggerScheduler({
    clock: () => new Date(2026, 9, 4, 1, 0, 0, 0),
    timers: endOfDayTimers.api
  });
  endOfDay.replace([{ Type: 'DailyTrigger', TimeOfDayTicks: ticksPerDay }]);
  assert.equal(endOfDayTimers.scheduled[0].delay, 23 * 60 * 60 * 1000,
    'the native 24-hour TimeSpan boundary resolves to midnight on the following day');
  endOfDay.close();

  const weeklyTimers = timerHarness();
  const weekly = new ScheduledTaskTriggerScheduler({
    // 2026-10-04 is Sunday. An exact weekly wall-clock match advances a week.
    clock: () => new Date(2026, 9, 4, 1, 0, 0, 0),
    timers: weeklyTimers.api
  });
  weekly.replace([{ Type: 'WeeklyTrigger', DayOfWeek: 'Sunday', TimeOfDayTicks: ticksPerHour }]);
  assert.equal(weeklyTimers.scheduled[0].delay, 7 * 24 * 60 * 60 * 1000);
  weekly.close();
});

test('interval and startup triggers reproduce native first-run, baseline, cap and startup-only delays', () => {
  const firstTimers = timerHarness();
  const first = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: firstTimers.api
  });
  first.replace([{ Type: 'IntervalTrigger', IntervalTicks: 1n }]);
  assert.equal(firstTimers.scheduled[0].delay, 60 * 60 * 1000);
  first.close();

  const zeroIntervalTimers = timerHarness();
  const zeroInterval = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: zeroIntervalTimers.api,
    getLastResult: () => ({ EndTimeUtc: '2026-10-03T00:00:00Z' })
  });
  zeroInterval.replace([{ Type: 'IntervalTrigger', IntervalTicks: 0n }]);
  assert.equal(zeroIntervalTimers.scheduled[0].delay, 60_000,
    'a native zero interval still observes the one-minute post-run baseline');
  zeroInterval.close();

  const baselineTimers = timerHarness();
  const baseline = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: baselineTimers.api,
    getLastResult: () => ({ EndTimeUtc: '2026-10-03T00:00:00Z' })
  });
  baseline.replace([{ Type: 'IntervalTrigger', IntervalTicks: 1n }]);
  assert.equal(baselineTimers.scheduled[0].delay, 60_000,
    'the native timer truncates a partial millisecond after the one-minute baseline');
  baseline.close();

  const preciseTimers = timerHarness();
  const precise = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: preciseTimers.api,
    getLastResult: () => ({ EndTimeUtc: '2026-10-04T00:01:00.0009999Z' })
  });
  precise.replace([{ Type: 'IntervalTrigger', IntervalTicks: 2n }]);
  assert.equal(preciseTimers.scheduled[0].delay, 60_001,
    'history fractions retain all seven native DateTime tick digits until timer truncation');
  precise.close();

  const cappedTimers = timerHarness();
  const capped = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: cappedTimers.api,
    getLastResult: () => ({ EndTimeUtc: '2026-10-04T00:00:00Z' })
  });
  capped.replace([{ Type: 'IntervalTrigger', IntervalTicks: 365n * ticksPerDay }]);
  assert.equal(cappedTimers.scheduled[0].delay, 7 * 24 * 60 * 60 * 1000);
  capped.close();

  const overflowTimers = timerHarness();
  const overflow = new ScheduledTaskTriggerScheduler({
    clock: () => new Date('2026-10-04T00:00:00.000Z'),
    timers: overflowTimers.api,
    getLastResult: () => ({ EndTimeUtc: '2026-10-04T00:00:00Z' })
  });
  assert.throws(() => overflow.replace([{
    Type: 'IntervalTrigger', IntervalTicks: 9_223_372_036_854_775_807n
  }]), /native DateTime range/u, 'DateTime.Add overflows before the native seven-day timer cap');
  assert.equal(overflowTimers.scheduled.length, 0);
  overflow.close();

  const startupTimers = timerHarness();
  const startup = new ScheduledTaskTriggerScheduler({ timers: startupTimers.api });
  startup.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true });
  assert.equal(startupTimers.scheduled[0].delay, 3000);
  startup.replace([{ Type: 'StartupTrigger' }]);
  assert.equal(startupTimers.scheduled.length, 1, 'reload does not re-arm a startup-only trigger');
  startup.close();
});

test('daily trigger delay uses CLR wall-clock subtraction through a daylight-saving fallback', () => {
  const script = `
    import { ScheduledTaskTriggerScheduler } from './src/tasks/scheduled-task-triggers.js';
    const delays = [];
    const scheduler = new ScheduledTaskTriggerScheduler({
      clock: () => new Date('2026-11-01T06:15:00Z'),
      timers: { set(callback, delay) { delays.push(delay); return { callback }; }, clear() {} }
    });
    scheduler.replace([{ Type: 'DailyTrigger', TimeOfDayTicks: 54000000000n }]);
    process.stdout.write(String(delays[0]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '900000');
});

test('clock and timer re-entry cannot arm or fire a trigger after scheduler close', () => {
  const delayedTimers = timerHarness();
  let delayedClockCalls = 0;
  let delayed;
  delayed = new ScheduledTaskTriggerScheduler({
    clock() {
      if (++delayedClockCalls === 2) delayed.close();
      return new Date(2026, 9, 4, 0, 0, 0, 0);
    },
    timers: delayedTimers.api
  });
  delayed.replace([{ Type: 'DailyTrigger', TimeOfDayTicks: 0n }]);
  delayedTimers.scheduled[0].callback();
  delayedTimers.scheduled[1].callback();
  assert.equal(delayedTimers.scheduled.length, 2,
    'closing from the restart clock prevents a post-close timer allocation');

  const setHandles = [];
  const setCleared = [];
  let setting;
  setting = new ScheduledTaskTriggerScheduler({
    clock: () => new Date(2026, 9, 4, 0, 0, 0, 0),
    timers: {
      set(callback, delay) {
        const handle = { callback, delay, sequence: setHandles.length + 1 };
        setHandles.push(handle);
        setting.close();
        return handle;
      },
      clear(handle) { setCleared.push(handle.sequence); }
    }
  });
  assert.throws(() => setting.replace([
    { Type: 'DailyTrigger', TimeOfDayTicks: 0n }
  ]), /triggers are closed/u);
  assert.deepEqual(setCleared, [1], 'a handle returned after reentrant close is disposed immediately');

  const restartHandles = [];
  const restartCleared = [];
  let restarting;
  restarting = new ScheduledTaskTriggerScheduler({
    timers: {
      set(callback, delay) {
        const handle = { callback, delay, sequence: restartHandles.length + 1 };
        restartHandles.push(handle);
        if (handle.sequence === 2) restarting.close();
        return handle;
      },
      clear(handle) { restartCleared.push(handle.sequence); }
    }
  });
  restarting.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true });
  restartHandles[0].callback();
  assert.deepEqual(restartCleared, [2],
    'a restart handle returned after reentrant close is disposed instead of escaping ownership');

  const intervalTimers = timerHarness();
  let intervalClockCalls = 0;
  let fired = 0;
  let interval;
  interval = new ScheduledTaskTriggerScheduler({
    clock() {
      if (++intervalClockCalls === 2) interval.close();
      return new Date('2026-10-04T00:00:00.000Z');
    },
    timers: intervalTimers.api,
    onTrigger() { fired++; }
  });
  interval.replace([{ Type: 'IntervalTrigger', IntervalTicks: 1n }]);
  intervalTimers.scheduled[0].callback();
  assert.equal(fired, 0, 'closing from the interval fire clock suppresses the trigger callback');
  assert.equal(intervalTimers.scheduled.length, 1);
});

test('trigger replacement during a callback cannot resurrect a disposed runtime', () => {
  const timers = timerHarness();
  const errors = [];
  let scheduler;
  scheduler = new ScheduledTaskTriggerScheduler({
    timers: timers.api,
    onTrigger() { scheduler.replace([]); },
    onError: error => errors.push(error)
  });
  scheduler.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true });
  timers.scheduled[0].callback();
  assert.equal(timers.scheduled.length, 1, 'disposed trigger does not install the one-second restart timer');
  assert.deepEqual(errors, []);
  scheduler.close();
});

test('timer construction failures propagate on replacement and are reported after a trigger fires', () => {
  const initialFailure = timerHarness({ failAt: 1 });
  const scheduler = new ScheduledTaskTriggerScheduler({ timers: initialFailure.api });
  assert.throws(() => scheduler.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true }), /timer 1 failed/u);
  scheduler.close();

  const restartFailure = timerHarness({ failAt: 2 });
  const errors = [];
  const fired = new ScheduledTaskTriggerScheduler({ timers: restartFailure.api, onError: error => errors.push(error) });
  fired.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true });
  restartFailure.scheduled[0].callback();
  assert.deepEqual(errors.map(error => error.message), ['timer 2 failed']);
  fired.close();
});

test('multi-trigger replacement rolls back newly armed timers without disabling the previous generation', () => {
  const timers = timerHarness({ failAt: 3 });
  const scheduler = new ScheduledTaskTriggerScheduler({ timers: timers.api });
  scheduler.replace([{ Type: 'StartupTrigger' }], { isApplicationStartup: true });
  assert.throws(() => scheduler.replace([
    { Type: 'StartupTrigger' }, { Type: 'StartupTrigger' }
  ], { isApplicationStartup: true }), /timer 3 failed/u);
  assert.deepEqual(timers.cleared.map(handle => handle.sequence), [2],
    'the partially armed replacement is disabled while the old generation remains active');
  scheduler.close();
  assert.deepEqual(timers.cleared.map(handle => handle.sequence), [2, 1]);
});

test('timer clear failures are reported while every runtime is still invalidated', () => {
  const errors = [];
  const handles = [];
  const scheduler = new ScheduledTaskTriggerScheduler({
    timers: {
      set(callback, delay) { const handle = { callback, delay }; handles.push(handle); return handle; },
      clear() { throw new Error('clear failed'); }
    },
    onError: error => errors.push(error)
  });
  scheduler.replace([
    { Type: 'StartupTrigger' }, { Type: 'StartupTrigger' }
  ], { isApplicationStartup: true });
  assert.doesNotThrow(() => scheduler.close());
  assert.deepEqual(errors.map(error => error.message), ['clear failed', 'clear failed']);
  for (const handle of handles) handle.callback();
  assert.equal(handles.length, 2, 'stale callbacks cannot create restart timers after close');
});
