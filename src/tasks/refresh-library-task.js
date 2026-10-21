import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ScheduledTaskFileStore } from './scheduled-task-store.js';
import { ScheduledTaskTriggerScheduler, cloneTaskTriggers, normalizeTaskTriggers } from './scheduled-task-triggers.js';
import { parseJsonDateTime } from '../http/json-date-time.js';
import { wireDate } from '../users/native.js';

export const refreshLibraryTaskId = '7738148ffcd07979c7ceb148e06b3aed';
export const refreshLibraryTaskKey = 'RefreshLibrary';

const defaultText = Object.freeze({
  TaskRefreshLibrary: 'Scan Media Library',
  TaskRefreshLibraryDescription: 'Scans your media library for new files and refreshes metadata.',
  TasksLibraryCategory: 'Library',
});

const intervalTicks = 12n * 60n * 60n * 10_000_000n;
export const defaultRefreshLibraryTaskTriggers = Object.freeze([
  Object.freeze({ Type: 'IntervalTrigger', IntervalTicks: intervalTicks })
]);
const taskContext = new AsyncLocalStorage();

function taskError(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}
function wireUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new TypeError('The scheduled task clock returned an invalid date.');
  return wireDate(date.toISOString());
}

function cloneResult(result) {
  return result && { ...result };
}

function errorField(error, key) {
  try { return error?.[key]; }
  catch { return undefined; }
}

function errorText(error, key, fallback) {
  const value = errorField(error, key);
  if (typeof value === 'string') return value;
  try { return String(error); }
  catch { return fallback; }
}

function cancellationError(error) {
  return errorField(error, 'name') === 'AbortError' || errorField(error, 'code') === 'cancelled';
}

function failureError(error) {
  return error ?? new Error('Scheduled task execution rejected without an error.');
}

function reentrant(owner) {
  for (let context = taskContext.getStore(); context; context = context.parent) {
    if (context.owner === owner && context.active === true) return true;
  }
  return false;
}

function activeParent() {
  let context = taskContext.getStore() ?? null;
  while (context && context.active !== true) context = context.parent;
  return context;
}

function reentrantError(operation) {
  return taskError(409, 'invalid-operation', `${operation} cannot wait on the scheduled task execution that invoked it.`);
}

function timerApi(value = {}) {
  return {
    set: value.set ?? ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      handle.unref?.();
      return handle;
    }),
    clear: value.clear ?? (handle => clearTimeout(handle)),
    now: value.now ?? (() => performance.now())
  };
}

function persistedResult(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The scheduled task history is invalid.');
  }
  const requiredStrings = ['StartTimeUtc', 'EndTimeUtc', 'Status', 'Name', 'Key', 'Id'];
  if (requiredStrings.some(key => typeof value[key] !== 'string' || !value[key])) {
    throw new TypeError('The scheduled task history is incomplete.');
  }
  let validDates = true;
  try {
    parseJsonDateTime(value.StartTimeUtc);
    parseJsonDateTime(value.EndTimeUtc);
  } catch { validDates = false; }
  if (!['Completed', 'Failed', 'Cancelled', 'Aborted'].includes(value.Status)
    || value.Id.toLowerCase() !== id || !validDates) {
    throw new TypeError('The scheduled task history does not describe this task.');
  }
  const result = Object.fromEntries(requiredStrings.map(key => [key, value[key]]));
  for (const key of ['ErrorMessage', 'LongErrorMessage']) {
    if (value[key] != null && typeof value[key] !== 'string') throw new TypeError(`The scheduled task history ${key} is invalid.`);
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  return result;
}

/**
 * Shared native scheduled-task worker. Production initialization loads the
 * task's own trigger/history files and starts its timers; pathless test
 * workers remain explicitly ephemeral.
 */
export class ScheduledTaskWorker extends EventEmitter {
  #active = null;
  #closed = false;
  #closePromise;
  #initializePromise;
  #initialized = false;
  #lastExecutionResult = null;
  #starting = false;
  #state = 'Idle';
  #progress = null;
  #queued = null;
  #store = null;
  #triggers;
  #triggerScheduler;
  #triggerUpdateTail = Promise.resolve();
  #publicationTail = Promise.resolve();
  #infoReads = new Set();
  #infoOwners = new Set();

  constructor({ definition, run, ensureAvailable = () => {}, localization, clock = () => new Date(), onError = () => {}, store,
    programDataPath, configurationDirectoryPath, dataPath, timers } = {}) {
    super({ captureRejections: true });
    if (!definition || typeof definition.id !== 'string' || typeof definition.key !== 'string'
      || !Array.isArray(definition.defaultTriggers) || typeof run !== 'function'
      || typeof ensureAvailable !== 'function') {
      throw new TypeError('Scheduled task workers require identity, triggers, availability and execution.');
    }
    Object.assign(this, { definition, run, ensureAvailable, localization, clock, onError, timers: timerApi(timers) });
    this.#triggers = normalizeTaskTriggers(definition.defaultTriggers);
    if (store != null && (typeof store.loadTriggers !== 'function' || typeof store.saveTriggers !== 'function'
      || typeof store.loadHistory !== 'function' || typeof store.saveHistory !== 'function'
      || typeof store.close !== 'function')) {
      throw new TypeError('Scheduled task persistence requires a task file store.');
    }
    this.#store = store ?? (programDataPath ? new ScheduledTaskFileStore({
      taskId: definition.id,
      programDataPath,
      configurationDirectoryPath,
      dataPath
    }) : null);
    this.#triggerScheduler = new ScheduledTaskTriggerScheduler({
      clock,
      timers: this.timers,
      getLastResult: () => this.#lastExecutionResult,
      canTrigger: () => !this.configurable || this.isEnabled(),
      onTrigger: trigger => this.#enqueue({ maxRuntimeTicks: trigger.MaxRuntimeTicks }, false),
      onError: error => this.#report(error)
    });
    this.on('error', error => this.#report(error));
  }

  get id() { return this.definition.id; }
  get key() { return this.definition.key; }
  get name() { return this.#text(this.definition.nameKey, this.definition.name); }
  get configurable() { return this.definition.configurable === true; }
  isEnabled() { return true; }
  isHidden() { return false; }
  get state() { return this.#state; }
  get completion() {
    if (reentrant(this)) return Promise.reject(reentrantError('Scheduled task completion waiting'));
    return this.#active?.promise ?? Promise.resolve(cloneResult(this.#lastExecutionResult));
  }

  initialize() {
    if (this.#closed) return Promise.reject(taskError(503, 'closed', 'Scheduled task execution is closed.'));
    return this.#initializePromise ??= this.#initialize();
  }

  async #initialize() {
    let triggers = this.#triggers;
    if (this.#store) {
      const configured = await this.#store.loadTriggers();
      if (configured != null) triggers = normalizeTaskTriggers(configured);
      let history;
      try {
        history = await this.#store.loadHistory();
      } catch (error) {
        if (error?.code !== 'invalid-scheduled-task-json') throw error;
        this.#report(error);
      }
      if (history != null) {
        try { this.#lastExecutionResult = persistedResult(history, this.id); }
        catch (error) { this.#report(error); }
      }
    }
    if (this.#closed) return;
    this.#triggers = triggers;
    this.#triggerScheduler.replace(triggers, { isApplicationStartup: true });
    this.#initialized = true;
  }

  updateTriggers(value) {
    if (this.#closed) return Promise.reject(taskError(503, 'closed', 'Scheduled task execution is closed.'));
    if (reentrant(this)) return Promise.reject(reentrantError('Scheduled task trigger updating'));
    const operation = this.#triggerUpdateTail.then(() => this.#updateTriggers(value));
    this.#triggerUpdateTail = operation.catch(() => {});
    return operation;
  }

  async #updateTriggers(value) {
    await this.initialize();
    if (this.#closed) throw taskError(503, 'closed', 'Scheduled task execution is closed.');
    const triggers = normalizeTaskTriggers(value);
    const previous = this.#triggers;
    await this.#store?.saveTriggers(cloneTaskTriggers(triggers));
    if (this.#closed) {
      const closedError = taskError(503, 'closed', 'Scheduled task execution is closed.');
      try { await this.#store?.saveTriggers(cloneTaskTriggers(previous)); }
      catch (rollbackError) {
        throw new AggregateError([closedError, rollbackError], 'Scheduled task closed while trigger persistence rollback failed.');
      }
      throw closedError;
    }
    try {
      if (this.#initialized) this.#triggerScheduler.replace(triggers);
    } catch (error) {
      try { await this.#store?.saveTriggers(cloneTaskTriggers(previous)); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Scheduled task trigger activation and persistence rollback failed.');
      }
      throw error;
    }
    this.#triggers = triggers;
    return cloneTaskTriggers(triggers);
  }

  #text(key, fallback) {
    if (key == null) return fallback;
    try {
      const value = this.localization?.text?.(key);
      return typeof value === 'string' ? value : fallback;
    } catch (error) {
      this.#report(error);
      return fallback;
    }
  }

  #info() {
    return {
      Name: this.name,
      State: this.#state,
      ...(this.#progress == null ? {} : { CurrentProgressPercentage: this.#progress }),
      Id: this.id,
      ...(this.#lastExecutionResult == null ? {} : { LastExecutionResult: cloneResult(this.#lastExecutionResult) }),
      Triggers: cloneTaskTriggers(this.#triggers),
      Description: this.#text(this.definition.descriptionKey, this.definition.description),
      Category: this.#text(this.definition.categoryKey, this.definition.category),
      IsHidden: false,
      Key: this.key,
    };
  }

  async #readInfo() {
    const result = this.#info();
    const read = Promise.resolve(this.configurable ? this.isHidden() : false).then(hidden => { result.IsHidden = hidden; return result; });
    this.#infoReads.add(read);
    const release = () => this.#infoReads.delete(read); read.then(release, release);
    return await read;
  }

  admitInfo() {
    if (this.#closed) throw taskError(503, 'closed', 'Scheduled task information is closed.');
    const owner = Promise.withResolvers(); this.#infoOwners.add(owner.promise);
    let released = false;
    return { info: () => released ? Promise.reject(taskError(503, 'closed', 'Scheduled task information ownership is released.')) : this.#readInfo(),
      release: () => { if (released) return; released = true; this.#infoOwners.delete(owner.promise); owner.resolve(); } };
  }

  async info() {
    const owner = this.admitInfo();
    try { return await owner.info(); } finally { owner.release(); }
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Error reporting cannot change task state. */ }
  }

  #notify(name, event) {
    try { this.emit(name, event); }
    catch (error) { this.#report(error); }
  }

  #notifyTask(name, values = {}) {
    const snapshot = this.#info();
    if (!this.configurable) { this.#notify(name, { Task: snapshot, ...values }); return; }
    const visibility = Promise.resolve().then(() => this.isHidden());
    visibility.catch(() => {});
    const published = this.#publicationTail.then(async () => {
      snapshot.IsHidden = await visibility;
      this.#notify(name, { Task: snapshot, ...values });
    }).catch(error => this.#report(error));
    this.#publicationTail = published;
    return published;
  }

  #ensureAvailable() {
    this.ensureAvailable();
  }

  execute(options = {}) {
    if (this.#closed) throw taskError(503, 'closed', 'Scheduled task execution is closed.');
    if (reentrant(this)) throw reentrantError('A nested scheduled task start');
    if (this.#starting || this.#active || this.#queued) {
      throw taskError(409, 'task-running', `The ${this.key} task is already running.`);
    }
    // Clock, localization and even primitive coercion are injectable and may
    // synchronously re-enter the manager. Reserve this generation before any
    // of those callbacks so two executions can never pass the idle check.
    this.#starting = true;

    let runtimeMilliseconds = null;
    let runtimeError = null;
    let controller;
    let context;
    let active;
    try {
      this.#ensureAvailable();
      const maxRuntimeTicks = options.maxRuntimeTicks ?? null;
      if (maxRuntimeTicks != null) {
        let runtimeTicks;
        try { runtimeTicks = BigInt(maxRuntimeTicks); }
        catch { throw taskError(400, 'invalid-trigger', 'MaxRuntimeTicks must be a 64-bit integer.'); }
        if (runtimeTicks < -9_223_372_036_854_775_808n || runtimeTicks > 9_223_372_036_854_775_807n) {
          throw taskError(400, 'invalid-trigger', 'MaxRuntimeTicks is outside the 64-bit range.');
        }
        // CancellationTokenSource.CancelAfter(TimeSpan) observes TimeSpan's
        // millisecond value truncated toward zero, then accepts -1 or >= 0.
        runtimeMilliseconds = runtimeTicks / 10_000n;
        if (runtimeMilliseconds < -1n || runtimeMilliseconds > 4_294_967_294n) {
          runtimeError = new RangeError('MaxRuntimeTicks resolves outside the native cancellation timer range.');
        }
      }

      controller = new AbortController();
      context = { owner: this, active: true, parent: activeParent() };
      active = {
        controller,
        context,
        stopReason: null,
        startTimeUtc: wireUtc(this.clock()),
        name: this.#text(this.definition.nameKey, this.definition.name),
        promise: null,
        runtimeFailure: null,
        timeout: null,
      };
      if (this.#closed) throw taskError(503, 'closed', 'Scheduled task execution is closed.');
      this.#active = active;
      this.#state = 'Running';
      this.#progress = null;
    } catch (error) {
      if (context) {
        context.active = false;
        context.owner = null;
      }
      this.#starting = false;
      throw error;
    }
    this.#starting = false;

    const reportProgress = value => {
      if (this.#active !== active || !Number.isFinite(value)) return false;
      this.#progress = Math.min(value, 100);
      this.#notifyTask('progress', { Progress: this.#progress });
      return true;
    };
    let startedPublication;
    const operation = taskContext.run(context, () => Promise.resolve().then(async () => {
        if (startedPublication) await startedPublication;
        if (runtimeError) throw runtimeError;
        if (runtimeMilliseconds != null && runtimeMilliseconds >= 0n) this.#armMaximumRuntime(active, runtimeMilliseconds);
        controller.signal.throwIfAborted();
        return this.run({ signal: controller.signal, reportProgress });
      }));
    active.promise = operation.finally(() => {
      context.active = false;
      context.owner = null;
    })
      .then(
        () => active.runtimeFailure
          ? this.#finish(active, 'Failed', active.runtimeFailure)
          : this.#finish(active, active.stopReason === 'close' ? 'Aborted' : 'Completed'),
        error => {
          const stoppedByOwnedSignal = controller.signal.aborted && error === controller.signal.reason;
          const status = active.runtimeFailure
            ? 'Failed'
            : cancellationError(error) || stoppedByOwnedSignal
              ? active.stopReason === 'close' ? 'Aborted' : 'Cancelled'
              : 'Failed';
          return this.#finish(active, status, status === 'Failed' ? active.runtimeFailure ?? failureError(error) : undefined);
        });
    // Publish only after the completion promise is registered so observers may
    // safely re-enter cancel() or close() from the started notification.
    startedPublication = this.#notifyTask('started');
    return active.promise;
  }

  #armMaximumRuntime(active, milliseconds) {
    const duration = Number(milliseconds);
    const owned = () => this.#active === active && !active.controller.signal.aborted;
    const discard = handle => {
      try { this.timers.clear(handle); }
      catch (error) { this.#report(error); }
    };
    const started = Number(this.timers.now());
    if (!Number.isFinite(started)) throw new TypeError('The maximum-runtime monotonic clock is invalid.');
    if (!owned()) return;
    const deadline = started + duration;
    let first = true;
    const fail = error => {
      if (!owned()) { this.#report(error); return; }
      active.runtimeFailure ??= failureError(error);
      this.#state = 'Cancelling';
      active.controller.abort(active.runtimeFailure);
    };
    const schedule = () => {
      if (!owned()) return;
      const observed = Number(this.timers.now());
      if (!Number.isFinite(observed)) throw new TypeError('The maximum-runtime monotonic clock is invalid.');
      if (!owned()) return;
      const remaining = first ? duration : Math.max(deadline - observed, 0);
      first = false;
      const delay = Math.min(Math.ceil(remaining), 2_147_483_647);
      const handle = this.timers.set(() => {
        active.timeout = null;
        try {
          const now = Number(this.timers.now());
          if (!Number.isFinite(now)) throw new TypeError('The maximum-runtime monotonic clock is invalid.');
          if (!owned()) return;
          if (now < deadline) { schedule(); return; }
          active.stopReason = 'timeout';
          this.#state = 'Cancelling';
          active.controller.abort(taskError(499, 'cancelled', `The ${this.key} task exceeded its maximum runtime.`));
        } catch (error) { fail(error); }
      }, delay);
      if (!owned()) { discard(handle); return; }
      active.timeout = handle;
    };
    schedule();
  }

  async #finish(active, status, error) {
    if (this.#active !== active) throw new Error('Scheduled task execution identity was lost.');
    if (active.timeout != null) {
      try { this.timers.clear(active.timeout); }
      catch (clearError) { this.#report(clearError); }
      finally { active.timeout = null; }
    }
    let endTimeUtc;
    try { endTimeUtc = wireUtc(this.clock()); }
    catch (clockError) {
      status = 'Failed';
      error ??= clockError;
      endTimeUtc = active.startTimeUtc;
    }
    const result = {
      StartTimeUtc: active.startTimeUtc,
      EndTimeUtc: endTimeUtc,
      Status: status,
      Name: active.name,
      Key: this.key,
      Id: this.id,
      ...(error == null ? {} : {
        ErrorMessage: errorText(error, 'message', 'Scheduled task execution failed.'),
        LongErrorMessage: errorText(error, 'stack', 'Scheduled task execution failed.'),
      }),
    };
    try { await this.#store?.saveHistory(result); }
    catch (persistenceError) {
      this.#report(persistenceError);
      if (result.Status !== 'Failed') {
        result.Status = 'Failed';
        result.ErrorMessage = errorText(persistenceError, 'message', 'Scheduled task history persistence failed.');
        result.LongErrorMessage = errorText(persistenceError, 'stack', 'Scheduled task history persistence failed.');
      }
    }
    // Keep the worker owned by this generation until its durable publication
    // attempt finishes. Otherwise a new execution can overtake history and the
    // old completed event can expose the successor as Running.
    this.#lastExecutionResult = result;
    this.#active = null;
    this.#state = 'Idle';
    this.#progress = null;
    await this.#notifyTask('completed', { Result: cloneResult(result) });
    this.#startQueued();
    if (error != null) this.#report(error);
    return cloneResult(result);
  }

  #startQueued() {
    if (!this.#queued || this.#active) return;
    const queued = this.#queued;
    this.#queued = null;
    if (this.#closed) {
      queued.reject(taskError(503, 'closed', 'Scheduled task execution is closed.'));
      return;
    }
    let completion;
    try { completion = this.execute(queued.options); }
    catch (error) {
      queued.reject(error);
      return;
    }
    completion.then(queued.resolve, queued.reject);
  }

  #enqueue(options, cancelRunning) {
    if (this.#closed) throw taskError(503, 'closed', 'Scheduled task execution is closed.');
    if (reentrant(this)) throw reentrantError('Scheduled task queueing');
    if (!this.#active && !this.#queued) return this.execute(options);
    this.#ensureAvailable();
    if (!this.#queued) this.#queued = { ...Promise.withResolvers(), options };
    if (cancelRunning && this.#active && this.#state === 'Running') {
      this.#state = 'Cancelling';
      this.#active.stopReason = 'cancel';
      this.#active.controller.abort(taskError(499, 'cancelled', `The ${this.key} task was superseded.`));
    }
    return this.#queued.promise;
  }

  queueScheduled(options = {}) { return this.#enqueue(options, false); }

  cancelIfRunningAndQueue(options = {}) { return this.#enqueue(options, true); }

  cancel() {
    if (this.#closed) throw taskError(503, 'closed', 'Scheduled task execution is closed.');
    if (reentrant(this)) throw reentrantError('Scheduled task cancellation');
    if (!this.#active || this.#state !== 'Running') {
      throw taskError(409, 'task-not-running', `The ${this.key} task is not running.`);
    }
    this.#state = 'Cancelling';
    this.#active.stopReason = 'cancel';
    this.#active.controller.abort(taskError(499, 'cancelled', `The ${this.key} task was cancelled.`));
    return this.#active.promise;
  }

  close() {
    const invokedFromActiveTask = reentrant(this);
    if (!this.#closePromise) {
      const completion = Promise.withResolvers();
      this.#closePromise = completion.promise;
      void this.#close().then(completion.resolve, completion.reject);
    }
    return invokedFromActiveTask ? Promise.resolve() : this.#closePromise;
  }

  async #close() {
    this.#closed = true;
    this.#triggerScheduler.close();
    const queued = this.#queued;
    this.#queued = null;
    queued?.reject(taskError(503, 'closed', 'Scheduled task execution is closed.'));
    const active = this.#active;
    if (active && this.#state === 'Running') {
      this.#state = 'Cancelling';
      active.stopReason = 'close';
      active.controller.abort(taskError(503, 'closed', `The ${this.key} task was aborted during shutdown.`));
    }
    if (this.#initializePromise) {
      try { await this.#initializePromise; }
      catch (error) { this.#report(error); }
    }
    await this.#triggerUpdateTail;
    if (active) await active.promise;
    await this.#publicationTail;
    while (this.#infoOwners.size) await Promise.allSettled([...this.#infoOwners]);
    while (this.#infoReads.size) await Promise.allSettled([...this.#infoReads]);
    await this.#store?.close();
  }
}

export class RefreshLibraryTaskWorker extends ScheduledTaskWorker {
  constructor({ scanner, ...options } = {}) {
    super({
      ...options,
      definition: {
        id: refreshLibraryTaskId,
        key: refreshLibraryTaskKey,
        nameKey: 'TaskRefreshLibrary',
        name: defaultText.TaskRefreshLibrary,
        descriptionKey: 'TaskRefreshLibraryDescription',
        description: defaultText.TaskRefreshLibraryDescription,
        categoryKey: 'TasksLibraryCategory',
        category: defaultText.TasksLibraryCategory,
        defaultTriggers: defaultRefreshLibraryTaskTriggers,
      },
      ensureAvailable() {
        if (scanner?.capabilities?.completeLibraryScan !== true || typeof scanner.runCompleteScan !== 'function') {
          throw taskError(501, 'task-unavailable', 'Complete library scanning is not implemented.');
        }
      },
      run: operation => scanner.runCompleteScan(operation),
    });
    this.scanner = scanner;
  }
}
