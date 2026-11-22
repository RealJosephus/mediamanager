import { EventEmitter } from 'node:events';
import { RefreshLibraryTaskWorker, refreshLibraryTaskId } from './refresh-library-task.js';
import { operationFailure } from '../core/operation-failure.js';

const taskEvents = ['started', 'progress', 'completed'];
const workerMethods = ['on', 'off', 'admitInfo', 'initialize', 'close', 'execute', 'queueScheduled',
  'cancelIfRunningAndQueue', 'cancel', 'updateTriggers', 'beginClose', 'drainShutdown'];

function taskError(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}
function nullableBoolean(value, name) {
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean, null or undefined.`);
  }
  return value;
}

export class ScheduledTaskManager extends EventEmitter {
  #closePromise;
  #workers = [];
  #reads = new Set();
  #shutdownRequested = false;

  constructor(options = {}) {
    super({ captureRejections: true });
    this.on('error', error => {
      try { void Promise.resolve(options.onError?.(error)).catch(() => {}); }
      catch { /* Event reporting cannot change task state. */ }
    });
    this.#workers.push(new RefreshLibraryTaskWorker(options));
    this.options = options;
    for (const worker of this.#workers) for (const name of taskEvents) {
      worker.on(name, event => this.emit(name, event));
    }
  }

  async register(extension) {
    if (this.#closePromise || this.#shutdownRequested) throw taskError(503, 'task-unavailable', 'Scheduled tasks are closing.');
    const worker = extension.create(this.options);
    const listeners = [];
    let disposing, forwarding = false;
    const dispose = () => disposing ??= (async () => {
      this.#workers = this.#workers.filter(value => value !== worker);
      const failures = [];
      if (typeof worker?.close === 'function') {
        try { await worker.close(); } catch (error) { failures.push(error); }
      }
      forwarding = false;
      for (const [name, listener] of listeners) {
        try { worker.off(name, listener); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw operationFailure(failures, 'Scheduled task could not be disposed.');
    })();
    if (this.#workers.includes(worker)) throw new TypeError('Duplicate or invalid plugin task.');
    try {
      if (typeof worker?.id !== 'string' || !worker.id || this.#find(worker.id)
        || !workerMethods.every(name => typeof worker[name] === 'function')
        || worker.configurable && (typeof worker.isHidden !== 'function' || typeof worker.isEnabled !== 'function')) {
        throw new TypeError('Duplicate or invalid plugin task.');
      }
      for (const name of taskEvents) {
        const listener = event => { if (forwarding) this.emit(name, event); };
        listeners.push([name, listener]);
        worker.on(name, listener);
      }
      this.#workers.push(worker);
      forwarding = true;
      if (this.initialized) await worker.initialize();
    } catch (error) {
      forwarding = false;
      try { await dispose(); }
      catch (cleanup) { throw operationFailure([error, cleanup], 'Scheduled task registration and disposal failed.'); }
      throw error;
    }
    return dispose;
  }

  #read(operation) {
    if (this.#closePromise) return Promise.reject(taskError(503, 'task-unavailable', 'Scheduled tasks are closing.'));
    const pending = operation(); this.#reads.add(pending);
    const release = () => this.#reads.delete(pending); pending.then(release, release);
    return pending;
  }

  list({ isHidden, isEnabled } = {}) { return this.#read(async () => {
    nullableBoolean(isHidden, 'isHidden');
    nullableBoolean(isEnabled, 'isEnabled');
    const owners = [];
    try {
      for (const worker of this.#workers) owners.push({ worker, owner: worker.admitInfo() });
      const ordered = owners.map(entry => ({ ...entry, name: entry.worker.name })).sort((left, right) => left.name.localeCompare(right.name));
      const result = [];
      for (const { worker, owner } of ordered) {
        // Native filters only IConfigurableScheduledTask and evaluates hidden
        // before enabled. The final DTO reads hidden again after those gates.
        if (worker.configurable) {
          if (isHidden != null && isHidden !== await worker.isHidden()) continue;
          if (isEnabled != null && isEnabled !== await worker.isEnabled()) continue;
        }
        result.push(await owner.info());
      }
      return result;
    } finally { for (const { owner } of owners) owner.release(); }
  }); }

  #find(id) {
    if (typeof id !== 'string') return undefined;
    const key = id.toLowerCase();
    return this.#workers.find(worker => worker.id.toLowerCase() === key);
  }

  has(id) { return this.#find(id) !== undefined; }

  get(id) { return this.#read(async () => {
    const worker = this.#find(id);
    if (!worker) return null;
    const owner = worker.admitInfo();
    try { return await owner.info(); } finally { owner.release(); }
  }); }

  #required(id) {
    const worker = this.#find(id);
    if (!worker) {
      throw taskError(404, 'task-not-found', 'Scheduled task not found.');
    }
    return worker;
  }

  execute(id, options) { return this.#required(id).execute(options); }
  queueScheduled(id, options) { return this.#required(id).queueScheduled(options); }
  cancelIfRunningAndQueue(id, options) { return this.#required(id).cancelIfRunningAndQueue(options); }
  cancel(id) { return this.#required(id).cancel(); }
  updateTriggers(id, triggers) { return this.#required(id).updateTriggers(triggers); }
  initialize() { this.initialized = true; return Promise.all(this.#workers.map(worker => worker.initialize())).then(() => undefined); }

  cancelForShutdown() {
    if (this.#shutdownRequested || this.#closePromise) return;
    this.#shutdownRequested = true;
    for (const worker of this.#workers) {
      if (worker.id === refreshLibraryTaskId) worker.cancelForShutdown();
      // Live task snapshots still read these workers until WebSocket delivery
      // drains. Stop their execution now and close information/storage later.
      else worker.beginClose();
    }
  }

  async drainShutdown() {
    this.cancelForShutdown();
    // Execution has already been cancelled in every worker. Finish their
    // real history/events while live information readers are still admitted.
    const results = await Promise.allSettled(this.#workers.map(worker => worker.drainShutdown()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Scheduled task shutdown did not drain every execution.');
  }

  close() {
    if (!this.#closePromise) {
      const completion = Promise.withResolvers();
      this.#closePromise = completion.promise;
      void this.#close().then(completion.resolve, completion.reject);
    }
    return this.#closePromise;
  }

  async #close() {
    const results = await Promise.allSettled(this.#workers.map(worker => worker.close()));
    while (this.#reads.size) await Promise.allSettled([...this.#reads]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Scheduled tasks could not all close.');
  }
}
