import { AsyncLocalStorage } from 'node:async_hooks';
import { StorageError, checkAbort } from '../storage/errors.js';

const scanContext = new AsyncLocalStorage();

export const libraryScanCapabilities = Object.freeze({
  scope: 'physical-folder-root-coordination',
  structuralCompletenessProof: true,
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
  runsPostScanTasks: false
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

function rootReference(root, index) {
  return Object.freeze({
    index,
    itemId: typeof root?.Id === 'string' ? root.Id : null,
    path: typeof root?.Path === 'string' ? root.Path : null
  });
}

function structurallyComplete(result) {
  const reasons = field(result, 'incompleteReasons');
  return field(result, 'structurallyComplete') === true && Array.isArray(reasons) && reasons.length === 0;
}

function operationResult(rootCount, completed) {
  const incompleteRoots = Object.freeze(completed
    .filter(root => !structurallyComplete(root.result))
    .map(root => Object.freeze({
      index: root.index,
      itemId: root.itemId,
      path: root.path,
      incompleteReasons: Array.isArray(field(root.result, 'incompleteReasons'))
        ? field(root.result, 'incompleteReasons') : Object.freeze([])
    })));
  return Object.freeze({
    rootCount,
    completedRootCount: completed.length,
    roots: Object.freeze([...completed]),
    structurallyComplete: completed.length === rootCount && incompleteRoots.length === 0,
    incompleteRoots
  });
}

function incompleteRootError(reference, result, partialResult) {
  const reasons = field(result, 'incompleteReasons');
  const error = new StorageError('incomplete-library-scan',
    `Physical library root ${reference.path ?? reference.itemId ?? reference.index} was not structurally complete.`, {
      root: reference,
      incompleteReasons: Array.isArray(reasons) ? reasons : Object.freeze([])
    });
  error.partialResult = partialResult;
  return error;
}

function incompleteLibraryError(errors, partialResult) {
  const incompleteRoots = Object.freeze(errors.map(error => field(field(error, 'details'), 'root')));
  const error = new StorageError('incomplete-library-scan',
    `${errors.length} physical library root${errors.length === 1 ? '' : 's'} did not produce a structural completeness proof.`, {
      scanErrors: Object.freeze([...errors]),
      incompleteRoots
    });
  error.partialResult = partialResult;
  return error;
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

function cancellationWithFailures(error, errors) {
  if (!errors.length) return error;
  return new StorageError('cancelled', errorMessage(error, 'Library scanning was cancelled.'), {
    scanErrors: Object.freeze([...errors])
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

  constructor({ library, folderScanner, lifecycle, onError = () => {} }) {
    if (!library || !folderScanner) throw new TypeError('Library scanning requires library and physical folder scan services.');
    if (lifecycle != null && typeof lifecycle.run !== 'function') throw new TypeError('Library scan lifecycle must expose its run operation.');
    Object.assign(this, { library, folderScanner, lifecycle, onError });
    const folderCapabilities = folderScanner.capabilities ?? {};
    const productionMediaScopes = Array.isArray(folderCapabilities.productionMediaScopes)
      ? Object.freeze([...folderCapabilities.productionMediaScopes]) : Object.freeze([]);
    const lifecycleCapabilities = lifecycle?.capabilities ?? {};
    const stages = {
      structuralCompletenessProof: libraryScanCapabilities.structuralCompletenessProof === true
        && folderCapabilities.structuralCompletenessProof === true,
      directStructuralRoots: folderCapabilities.directStructuralRoots === true,
      scansMediaFiles: folderCapabilities.scansMediaFiles === true,
      typeReclassification: folderCapabilities.typeReclassification === true,
      secondaryOwnershipTransfer: folderCapabilities.secondaryOwnershipTransfer === true,
      groupedOwnership: folderCapabilities.groupedOwnership === true,
      relationshipRows: folderCapabilities.relationshipRows === true,
      resolvesProductionMediaFiles: folderCapabilities.resolvesProductionMediaFiles === true,
      reconcilesTopLevelConfiguration: lifecycleCapabilities.reconcilesTopLevelConfiguration === true,
      runsMetadataProbeRefresh: folderCapabilities.runsMetadataProbeRefresh === true,
      runsPostScanTasks: lifecycleCapabilities.runsPostScanTasks === true
    };
    this.capabilities = Object.freeze({
      ...libraryScanCapabilities,
      ...stages,
      productionMediaScopes,
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
        const result = await this.#startScan({ signal }, true);
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
    return this.#startScan(options, false);
  }

  #startScan(options, continueOnError) {
    const context = { owner: this, active: true, parent: activeParent() };
    const run = () => scanContext.run(context, () => this.#scanOperation(options, continueOnError));
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

  async #scanOperation({ signal, reportProgress } = {}, continueOnError) {
    if (reportProgress != null && typeof reportProgress !== 'function') {
      throw new TypeError('Library scan progress reporter must be a function.');
    }
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    checkAbort(combined);
    if (this.lifecycle) {
      let progress = 0;
      return this.lifecycle.run({ signal: combined,
        reportProgress: (value, detail) => {
          // Task observers use the existing monotonic 0-99 contract; the
          // lifecycle itself retains native 0-100 phase arithmetic.
          if (Number.isFinite(value)) progress = Math.max(progress, Math.min(99, Math.max(0, value)));
          this.#progress(reportProgress, progress, detail);
        },
        scan: options => this.#scanRoots(options, continueOnError) });
    }
    this.folderScanner.ignoreRule?.clearDirectoryCache();
    try {
      return await this.#scanRoots({ signal: combined, reportProgress }, continueOnError);
    } finally {
      this.folderScanner.ignoreRule?.clearDirectoryCache();
    }
  }

  async #scanRoots({ signal: combined, reportProgress }, continueOnError) {
    const roots = await this.library.getPhysicalScanRoots({ signal: combined });
    if (!Array.isArray(roots)) throw new StorageError('invalid-response', 'Physical library scan roots must be an array.');
    checkAbort(combined);
    const completed = [];
    const errors = [];
    this.#progress(reportProgress, 0, Object.freeze({ rootCount: roots.length, completedRootCount: 0, root: null }));
    checkAbort(combined);
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      const reference = rootReference(root, index);
      let result;
      try {
        checkAbort(combined);
        if (!this.folderScanner.supports(root)) {
          throw new StorageError('invalid-response', 'A library scan root is not a supported physical folder.');
        }
        result = await this.folderScanner.scan(root, { signal: combined });
        checkAbort(combined);
      } catch (error) {
        if (cancelled(error)) throw cancellationWithFailures(error, errors);
        if (!continueOnError) throw error;
        errors.push(error);
        continue;
      }
      const frozenResult = immutable(result);
      completed.push(Object.freeze({ ...reference, result: frozenResult }));
      const value = roots.length ? (this.lifecycle ? 100 : 99) * completed.length / roots.length : 0;
      this.#progress(reportProgress, value, Object.freeze({
        rootCount: roots.length,
        completedRootCount: completed.length,
        root: reference
      }));
      if (!structurallyComplete(frozenResult)) {
        const incomplete = incompleteRootError(reference, frozenResult, operationResult(roots.length, completed));
        if (!continueOnError) throw incomplete;
        errors.push(incomplete);
      }
      if (frozenResult.metadataComplete === false) {
        const failure = new StorageError('metadata-scan-failed', 'The physical library root did not complete metadata refresh.', {
          root: reference, metadata: frozenResult.metadata
        });
        failure.partialResult = operationResult(roots.length, completed);
        if (!continueOnError) throw failure;
        errors.push(failure);
      }
      try { checkAbort(combined); }
      catch (error) { throw cancellationWithFailures(error, errors); }
    }
    const result = operationResult(roots.length, completed);
    if (errors.length) {
      if (errors.every(error => field(error, 'code') === 'incomplete-library-scan')) {
        throw incompleteLibraryError(errors, result);
      }
      const error = new AggregateError(errors, `${errors.length} physical library root${errors.length === 1 ? '' : 's'} failed to scan.`);
      error.code = 'library-scan-failed';
      error.partialResult = result;
      throw error;
    }
    return result;
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
