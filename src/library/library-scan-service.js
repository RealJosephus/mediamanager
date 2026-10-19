import { AsyncLocalStorage } from 'node:async_hooks';
import { StorageError, checkAbort } from '../storage/errors.js';

const scanContext = new AsyncLocalStorage();

export const libraryScanCapabilities = Object.freeze({
  scope: 'aggregate-folder-validation',
  structuralCompletenessProof: false,
  directStructuralRoots: false,
  completeLibraryScan: false,
  scansMediaFiles: false,
  typeReclassification: false,
  secondaryOwnershipTransfer: false,
  groupedOwnership: false,
  relationshipRows: false,
  resolvesProductionMediaFiles: false,
  productionMediaScopes: Object.freeze([]),
  reconcilesTopLevelConfiguration: false,
  runsMetadataProbeRefresh: false,
  runsPostScanTasks: false,
  watchesLibraryDirectories: false
});

function closedError() {
  return Object.assign(new StorageError('closed', 'The library scanner is closed.'), { status: 503, statusCode: 503 });
}

function field(value, key) {
  try { return value?.[key]; }
  catch { return undefined; }
}

function errorMessage(error, fallback = 'Library scanning failed.') {
  const message = field(error, 'message');
  if (typeof message === 'string') return message;
  try { return String(error); }
  catch { return fallback; }
}

function cancelled(error) {
  // A signal can be aborted after an unrelated operation error has already
  // won the race. Only explicit cancellation errors are safe to suppress.
  return field(error, 'name') === 'AbortError' || field(error, 'code') === 'cancelled';
}

function immutable(value) {
  const clone = value === undefined ? null : structuredClone(value);
  const visited = new WeakSet();
  const freeze = entry => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry) || visited.has(entry)) return entry;
    visited.add(entry);
    if (Array.isArray(entry)) for (const value of entry) freeze(value);
    else for (const value of Object.values(entry)) freeze(value);
    return Object.freeze(entry);
  };
  return freeze(clone);
}

function cancellationReceipt(generation, message) {
  return Object.freeze({
    generation,
    status: 'cancelled',
    error: Object.freeze({ name: 'StorageError', code: 'cancelled', message })
  });
}

function failureReceipt(generation, error) {
  const name = field(error, 'name');
  const code = field(error, 'code');
  let partialResult;
  try {
    const diagnostic = field(error, 'partialResult');
    if (diagnostic != null) partialResult = immutable(diagnostic);
  } catch { /* Malformed diagnostics cannot orphan a failed generation. */ }
  return Object.freeze({
    generation,
    status: 'failed',
    ...(partialResult == null ? {} : { partialResult }),
    error: Object.freeze({
      name: typeof name === 'string' && name ? name : 'Error',
      code: typeof code === 'string' && code ? code : null,
      message: errorMessage(error)
    })
  });
}

function scanErrors(error) {
  const details = field(error, 'details');
  const errors = field(details, 'scanErrors');
  try {
    if (!Array.isArray(errors)) return [];
    const length = Math.min(errors.length, 100_000);
    const result = [];
    for (let index = 0; index < length; index++) {
      try { result.push(errors[index]); }
      catch { /* A diagnostic accessor cannot strand the generation receipt. */ }
    }
    return result;
  } catch {
    return [];
  }
}

function aggregateErrors(error) {
  try {
    if (!(error instanceof AggregateError)) return null;
  } catch { return null; }
  const errors = field(error, 'errors');
  try { return Array.isArray(errors) ? scanErrors({ details: { scanErrors: errors } }) : null; }
  catch { return null; }
}

function reentrant(owner) {
  for (let context = scanContext.getStore(); context; context = context.parent) {
    if (context.owner === owner && context.active === true) return true;
  }
  return false;
}

function activeParent() {
  let context = scanContext.getStore() ?? null;
  while (context && context.active !== true) context = context.parent;
  return context;
}

function reentrantError(operation) {
  return new StorageError('invalid-operation', `${operation} cannot wait on the library scan operation that invoked it.`);
}

export class LibraryScanService {
  #lifetime = new AbortController();
  #requestedGeneration = 0;
  #completedGeneration = 0;
  #current = null;
  #runner = null;
  #scanTail = Promise.resolve();
  #active = new Set();
  #generations = new Map();
  #closed = false;

  constructor({ lifecycle, onError = () => {} } = {}) {
    if (!lifecycle || typeof lifecycle.run !== 'function') {
      throw new TypeError('Library scanning requires the aggregate folder validation lifecycle.');
    }
    if (typeof onError !== 'function') throw new TypeError('Library scan error reporting must be a function.');
    Object.assign(this, { lifecycle, onError });
    const declared = lifecycle.capabilities ?? {};
    const stages = Object.fromEntries(Object.keys(libraryScanCapabilities)
      .filter(key => !['scope', 'completeLibraryScan', 'productionMediaScopes'].includes(key))
      .map(key => [key, declared[key] === true]));
    this.capabilities = Object.freeze({
      ...libraryScanCapabilities,
      ...stages,
      productionMediaScopes: Object.freeze(Array.isArray(declared.productionMediaScopes)
        ? [...declared.productionMediaScopes] : []),
      completeLibraryScan: Object.values(stages).every(value => value === true)
    });
  }

  queue() {
    if (this.#closed) throw closedError();
    if (reentrant(this)) throw reentrantError('Library scan queueing');
    const generation = ++this.#requestedGeneration;
    const deferred = Promise.withResolvers();
    const record = { generation, state: 'pending', ...deferred };
    this.#generations.set(generation, record);
    for (const [number, pending] of this.#generations) {
      if (number >= generation || pending.state !== 'pending') continue;
      pending.state = 'cancelled';
      pending.resolve(cancellationReceipt(number, `Library scan generation ${number} was superseded by generation ${generation}.`));
      this.#generations.delete(number);
    }
    this.#current?.controller.abort();
    this.#startRunner();
    return record.promise;
  }

  #startRunner() {
    if (this.#runner || this.#closed || this.#completedGeneration >= this.#requestedGeneration) return;
    // #runQueue synchronously reserves the serial scan tail before yielding,
    // so a following explicit scan cannot overtake this queue request.
    const task = this.#runQueue();
    this.#runner = task;
    task.finally(() => {
      if (this.#runner !== task) return;
      this.#runner = null;
      this.#startRunner();
    }).catch(() => {});
  }

  async #runQueue() {
    while (!this.#closed && this.#completedGeneration < this.#requestedGeneration) {
      const generation = this.#requestedGeneration;
      const controller = new AbortController();
      const record = this.#generations.get(generation);
      if (!record) {
        this.#completedGeneration = Math.max(this.#completedGeneration, generation);
        continue;
      }
      record.state = 'running';
      const current = { generation, controller, record };
      this.#current = current;
      const signal = AbortSignal.any([controller.signal, this.#lifetime.signal]);
      try {
        const result = await this.#startScan({ signal });
        record.state = 'completed';
        record.resolve(Object.freeze({ generation, status: 'completed', result }));
      } catch (error) {
        try {
          if (cancelled(error)) {
            const causes = scanErrors(error);
            record.state = 'cancelled';
            record.resolve(cancellationReceipt(generation,
              errorMessage(error, `Library scan generation ${generation} was cancelled.`)));
            for (const cause of causes) this.#report(cause);
          } else {
            const causes = aggregateErrors(error);
            record.state = 'failed';
            record.resolve(failureReceipt(generation, error));
            if (causes) for (const cause of causes) this.#report(cause);
            else this.#report(error);
          }
        } catch (diagnosticError) {
          // A malformed thrown value must never orphan the public generation.
          record.state = 'failed';
          record.resolve(failureReceipt(generation, error));
          this.#report(error);
          this.#report(diagnosticError);
        }
      }
      finally {
        if (this.#current === current) this.#current = null;
        this.#generations.delete(generation);
        this.#completedGeneration = Math.max(this.#completedGeneration, generation);
      }
    }
  }

  runCompleteScan(options = {}) {
    if (this.#closed) return Promise.reject(closedError());
    if (reentrant(this)) return Promise.reject(reentrantError('A nested complete scan'));
    return this.#startScan(options);
  }

  #startScan(options) {
    const context = { owner: this, active: true, parent: activeParent() };
    const run = () => scanContext.run(context, () => this.#scanOperation(options));
    const task = this.#scanTail.then(run, run);
    this.#scanTail = task.catch(() => {});
    this.#active.add(task);
    task.finally(() => {
      context.active = false;
      context.owner = null;
      this.#active.delete(task);
    }).catch(() => {});
    return task;
  }

  #progress(reportProgress, value, detail) {
    if (!reportProgress) return;
    try { void Promise.resolve(reportProgress(value, detail)).catch(error => this.#report(error)); }
    catch (error) { this.#report(error); }
  }

  async #scanOperation({ signal, reportProgress } = {}) {
    if (reportProgress != null && typeof reportProgress !== 'function') {
      throw new TypeError('Library scan progress reporter must be a function.');
    }
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    checkAbort(combined);
    let progress = 0;
    const result = await this.lifecycle.run({ signal: combined,
      reportProgress: (value, detail) => {
        // Scheduled task observers retain their monotonic 0-99 contract;
        // the lifecycle owns native 0-100 phase arithmetic and traversal.
        if (Number.isFinite(value)) progress = Math.max(progress, Math.min(99, Math.max(0, value)));
        this.#progress(reportProgress, progress, detail);
      } });
    checkAbort(combined);
    return immutable(result);
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Error reporting cannot replace scan scheduling. */ }
  }

  async whenIdle() {
    if (reentrant(this)) throw reentrantError('Library scan idle waiting');
    while (this.#runner || this.#active.size) {
      await Promise.allSettled([...(this.#runner ? [this.#runner] : []), ...this.#active]);
    }
  }

  async close() {
    const invokedFromActiveScan = reentrant(this);
    if (!this.#closed) {
      this.#closed = true;
      this.#lifetime.abort();
      this.#current?.controller.abort();
      for (const [generation, record] of this.#generations) {
        if (record.state !== 'pending') continue;
        record.state = 'cancelled';
        record.resolve(cancellationReceipt(generation, `Library scan generation ${generation} was cancelled during shutdown.`));
        this.#generations.delete(generation);
      }
    }
    // The active collaborator cannot await its own completion. Cancellation is
    // already visible; an external owner remains responsible for draining.
    if (invokedFromActiveScan) return;
    await this.whenIdle();
  }
}
