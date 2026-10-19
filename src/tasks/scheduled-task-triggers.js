import { parseJsonDateTime } from '../http/json-date-time.js';
import { epochTicks, maximumDateTicks } from '../syncplay/time.js';

const ticksPerMillisecond = 10_000n;
const ticksPerDay = 24n * 60n * 60n * 10_000_000n;
const maximumTicks = 9_223_372_036_854_775_807n;
const minimumTicks = -9_223_372_036_854_775_808n;
const maximumTimerDelayMs = 7 * 24 * 60 * 60 * 1000;
const ticksPerMinute = 60n * 10_000_000n;
const triggerTypes = Object.freeze(['DailyTrigger', 'WeeklyTrigger', 'IntervalTrigger', 'StartupTrigger']);
const dayNames = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

function taskError(message) {
  return Object.assign(new TypeError(message), { status: 400, statusCode: 400, code: 'invalid-trigger' });
}

function integer(value, name, { nullable = true } = {}) {
  if (value == null && nullable) return null;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  } catch { /* Fall through to a stable binding failure. */ }
  throw taskError(`${name} must be a 64-bit integer${nullable ? ' or null' : ''}.`);
}

function boundedTicks(value, name, { minimum = 0n, maximum = maximumTicks, nullable = true } = {}) {
  const ticks = integer(value, name, { nullable });
  if (ticks == null) return null;
  if (ticks < minimum || ticks > maximum) throw taskError(`${name} is outside the supported range.`);
  return ticks;
}

function enumeration(value, names, name) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < names.length) return names[value];
  if (typeof value === 'bigint' && value >= 0n && value < BigInt(names.length)) return names[Number(value)];
  if (typeof value === 'string') {
    const byName = names.find(entry => entry.toLowerCase() === value.toLowerCase());
    if (byName) return byName;
    if (/^\d+$/u.test(value) && Number(value) < names.length) return names[Number(value)];
  }
  throw taskError(`${name} is invalid.`);
}

function normalizeTrigger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw taskError('Every scheduled task trigger must be an object.');
  if (Object.hasOwn(value, 'Type') && value.Type == null) throw taskError('Type is invalid.');
  const Type = enumeration(Object.hasOwn(value, 'Type') ? value.Type : 0, triggerTypes, 'Type');
  const TimeOfDayTicks = boundedTicks(value.TimeOfDayTicks, 'TimeOfDayTicks', { maximum: ticksPerDay });
  const IntervalTicks = boundedTicks(value.IntervalTicks, 'IntervalTicks');
  const DayOfWeek = value.DayOfWeek == null ? null : enumeration(value.DayOfWeek, dayNames, 'DayOfWeek');
  const MaxRuntimeTicks = boundedTicks(value.MaxRuntimeTicks, 'MaxRuntimeTicks', { minimum: minimumTicks });
  const result = { Type };
  if (TimeOfDayTicks != null) result.TimeOfDayTicks = TimeOfDayTicks;
  if (IntervalTicks != null) result.IntervalTicks = IntervalTicks;
  if (DayOfWeek != null) result.DayOfWeek = DayOfWeek;
  if (MaxRuntimeTicks != null) result.MaxRuntimeTicks = MaxRuntimeTicks;
  if (Type === 'IntervalTrigger' && IntervalTicks == null) throw taskError('IntervalTicks must be a 64-bit integer.');
  if (['DailyTrigger', 'WeeklyTrigger'].includes(Type) && TimeOfDayTicks == null) {
    throw taskError('TimeOfDayTicks must be a 64-bit integer.');
  }
  if (Type === 'WeeklyTrigger' && DayOfWeek == null) throw taskError('DayOfWeek is invalid.');
  return Object.freeze(result);
}

export function normalizeTaskTriggers(value) {
  if (!Array.isArray(value)) throw taskError('Scheduled task triggers must be an array.');
  return Object.freeze(value.filter(entry => entry != null).map(normalizeTrigger));
}

export function cloneTaskTriggers(value) {
  return value.map(trigger => ({ ...trigger }));
}

function date(value, label) {
  const result = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (!Number.isFinite(result.valueOf())) throw new TypeError(`The scheduled task ${label} is invalid.`);
  return result;
}

function timerApi(value = {}) {
  return {
    set: value.set ?? ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      handle.unref?.();
      return handle;
    }),
    clear: value.clear ?? (handle => clearTimeout(handle))
  };
}

function ticksToMilliseconds(ticks) {
  const milliseconds = ticks / ticksPerMillisecond;
  return milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(milliseconds);
}

export class ScheduledTaskTriggerScheduler {
  #closed = false;
  #runtimes = [];

  constructor({ clock = () => new Date(), timers, getLastResult = () => null, onTrigger = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { clock, timers: timerApi(timers), getLastResult, onTrigger, onError });
  }

  replace(triggers, { isApplicationStartup = false } = {}) {
    if (this.#closed) throw new Error('Scheduled task triggers are closed.');
    const normalized = normalizeTaskTriggers(triggers);
    const runtimes = normalized.map(info => ({ info, active: true, timer: null, restart: null, lastStart: null }));
    try {
      for (const runtime of runtimes) this.#schedule(runtime, isApplicationStartup);
      if (this.#closed) throw new Error('Scheduled task triggers are closed.');
      this.#disposeRuntimes(this.#runtimes);
      if (this.#closed) throw new Error('Scheduled task triggers are closed.');
    } catch (error) {
      this.#disposeRuntimes(runtimes);
      throw error;
    }
    this.#runtimes = runtimes;
    return normalized;
  }

  #now() { return date(this.clock(), 'trigger clock'); }

  #delay(runtime, isApplicationStartup) {
    const now = this.#now();
    const { info } = runtime;
    if (info.Type === 'StartupTrigger') return isApplicationStartup ? 3000 : null;
    if (info.Type === 'IntervalTrigger') {
      const last = this.getLastResult();
      if (!last) return 60 * 60 * 1000;
      const nowTicks = epochTicks + BigInt(now.valueOf()) * ticksPerMillisecond;
      const endTicks = parseJsonDateTime(last.EndTimeUtc).ticks;
      const lastStartTicks = runtime.lastStart == null
        ? -1n
        : epochTicks + BigInt(runtime.lastStart.valueOf()) * ticksPerMillisecond;
      const minimumTriggerTicks = nowTicks + ticksPerMinute;
      if (minimumTriggerTicks > maximumDateTicks) throw new RangeError('Interval trigger date is outside the native DateTime range.');
      const baseline = [endTicks, lastStartTicks, minimumTriggerTicks]
        .reduce((left, right) => left > right ? left : right);
      const triggerTicks = baseline + info.IntervalTicks;
      if (triggerTicks > maximumDateTicks) throw new RangeError('Interval trigger date is outside the native DateTime range.');
      const dueTicks = triggerTicks - nowTicks;
      const delay = ticksToMilliseconds(dueTicks);
      return Math.min(Math.max(delay, 0), maximumTimerDelayMs);
    }
    const nowTimeTicks = BigInt(now.getHours() * 3_600_000 + now.getMinutes() * 60_000
      + now.getSeconds() * 1000 + now.getMilliseconds()) * ticksPerMillisecond;
    if (info.Type === 'DailyTrigger') {
      const dueTicks = (nowTimeTicks > info.TimeOfDayTicks ? ticksPerDay : 0n)
        + info.TimeOfDayTicks - nowTimeTicks;
      return ticksToMilliseconds(dueTicks);
    }
    const desiredDay = dayNames.indexOf(info.DayOfWeek);
    let days = (desiredDay - now.getDay() + 7) % 7;
    if (days === 0 && nowTimeTicks >= info.TimeOfDayTicks) days = 7;
    return ticksToMilliseconds(BigInt(days) * ticksPerDay + info.TimeOfDayTicks - nowTimeTicks);
  }

  #schedule(runtime, isApplicationStartup) {
    if (this.#closed || !runtime.active) return;
    const delay = this.#delay(runtime, isApplicationStartup);
    if (this.#closed || !runtime.active || delay == null) return;
    const handle = this.timers.set(() => this.#fire(runtime), delay);
    if (this.#closed || !runtime.active) {
      try { this.timers.clear(handle); }
      catch (error) { this.#report(error); }
      return;
    }
    runtime.timer = handle;
  }

  #fire(runtime) {
    if (this.#closed || !runtime.active) return;
    runtime.timer = null;
    if (runtime.info.Type === 'IntervalTrigger') {
      try { runtime.lastStart = this.#now(); }
      catch (error) { this.#report(error); }
    }
    if (this.#closed || !runtime.active) return;
    try { void Promise.resolve(this.onTrigger({ ...runtime.info })).catch(error => this.#report(error)); }
    catch (error) { this.#report(error); }
    if (this.#closed || !runtime.active) return;
    try {
      const handle = this.timers.set(() => {
        runtime.restart = null;
        if (this.#closed || !runtime.active) return;
        try { this.#schedule(runtime, false); }
        catch (error) { this.#report(error); }
      }, 1000);
      if (this.#closed || !runtime.active) {
        try { this.timers.clear(handle); }
        catch (error) { this.#report(error); }
        return;
      }
      runtime.restart = handle;
    } catch (error) { this.#report(error); }
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Trigger error reporting cannot replace scheduler state. */ }
  }

  #disposeRuntimes(runtimes) {
    for (const runtime of runtimes) {
      runtime.active = false;
      if (runtime.timer != null) {
        try { this.timers.clear(runtime.timer); }
        catch (error) { this.#report(error); }
        runtime.timer = null;
      }
      if (runtime.restart != null) {
        try { this.timers.clear(runtime.restart); }
        catch (error) { this.#report(error); }
        runtime.restart = null;
      }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeRuntimes(this.#runtimes);
    this.#runtimes = [];
  }
}

export const taskTriggerTypes = triggerTypes;
export const taskDayNames = dayNames;
