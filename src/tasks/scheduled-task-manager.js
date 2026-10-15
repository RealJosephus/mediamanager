import { EventEmitter } from 'node:events';
import { RefreshLibraryTaskWorker } from './refresh-library-task.js';

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

  constructor(options = {}) {
    super({ captureRejections: true });
    this.on('error', error => {
      try { void Promise.resolve(options.onError?.(error)).catch(() => {}); }
      catch { /* Event reporting cannot change task state. */ }
    });
    this.#workers.push(new RefreshLibraryTaskWorker(options));
    this.options = options;
    for (const worker of this.#workers) for (const name of ['started', 'progress', 'completed']) {
      worker.on(name, event => this.emit(name, event));
    }
  }

  async register(extension) {
    if (this.#closePromise) throw taskError(503, 'task-unavailable', 'Scheduled tasks are closing.');
    const worker = extension.create(this.options);
    if (!worker?.id || this.#workers.some(existing => existing.id === worker.id)) { await worker?.close?.(); throw new TypeError('Duplicate or invalid plugin task.'); }
    this.#workers.push(worker);
    for (const name of ['started','progress','completed']) worker.on(name, event => this.emit(name,event));
    try { if (this.initialized) await worker.initialize(); }
    catch (error) { this.#workers.splice(this.#workers.indexOf(worker),1); await worker.close(); throw error; }
    return async () => { this.#workers = this.#workers.filter(value => value !== worker); await worker.close(); };
  }

  list({ isHidden, isEnabled } = {}) {
    // RefreshMediaLibraryTask is not an IConfigurableScheduledTask. Native
    // filtering validates these nullable query values but does not apply them
    // to this worker.
    nullableBoolean(isHidden, 'isHidden');
    nullableBoolean(isEnabled, 'isEnabled');
    return this.#workers.map(worker => worker.info()).sort((left, right) => left.Name.localeCompare(right.Name));
  }

  get(id) {
    if (typeof id !== 'string') return null;
    return this.#workers.find(worker => worker.id === id.toLowerCase())?.info() ?? null;
  }

  #required(id) {
    const worker = typeof id === 'string'
      ? this.#workers.find(candidate => candidate.id === id.toLowerCase())
      : null;
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
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Scheduled tasks could not all close.');
  }
}
