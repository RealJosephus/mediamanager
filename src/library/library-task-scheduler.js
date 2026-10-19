import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';

const workContext = new AsyncLocalStorage();
const roundProgress = value => {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower % 2 === 0 ? lower : lower + 1 : Math.round(value);
};
const activeContext = (predicate = () => true) => {
  for (let current = workContext.getStore(); current; current = current.parent) {
    if (current.active && predicate(current)) return true;
  }
  return false;
};

/** Shares library fanout across owned, bounded child sequences. Membership and
 * captured entity state remain with the sequence's SQL cohort. */
export class LibraryTaskScheduler {
  #pending = [];
  #records = new Set();
  #active = 0;
  #pumping = false;
  #wakePending = false;
  #closed = false;
  #closing;

  constructor({ configuration = {}, processors = availableParallelism, runWorker = operation => operation(), captureWorker = operation => operation,
    onError = () => {} } = {}) {
    if (typeof processors !== 'function' || typeof runWorker !== 'function' || typeof captureWorker !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Library scheduling requires processor, worker-scope and error callbacks.');
    }
    Object.assign(this, { configuration, processors, runWorker, captureWorker, onError });
  }

  #sequential() {
    const setting = this.configuration.LibraryScanFanoutConcurrency ?? 0;
    return setting === 1 || setting <= 0 && this.processors() <= 3 || activeContext(context => context.pooled);
  }

  #limit() {
    const setting = this.configuration.LibraryScanFanoutConcurrency ?? 0;
    return Math.max(1, Math.min(128, setting > 0 ? setting : this.processors() - 3));
  }

  #observe(callback, ...args) {
    try { void Promise.resolve(callback(...args)).catch(() => {}); }
    catch { /* An observer cannot replace work completion or resource release. */ }
  }

  enqueue(sequence, worker, { signal, reportProgress = () => {}, onError = this.onError,
    predicate } = {}) {
    if (this.#closed) return Promise.resolve();
    if (!sequence || typeof sequence.pages !== 'function' || typeof sequence.count !== 'function'
      || typeof worker !== 'function' || typeof reportProgress !== 'function' || typeof onError !== 'function'
      || predicate != null && typeof predicate !== 'function') {
      throw new TypeError('Library work requires an owned counted sequence, worker and observers.');
    }
    if (signal?.aborted) { this.#observe(reportProgress, 100); return Promise.resolve(); }
    const deferred = Promise.withResolvers();
    const record = { sequence, worker: this.captureWorker(worker), signal, reportProgress, onError, predicate,
      ...deferred, total: null, dispatched: 0, completed: 0, sum: 0, active: 0,
      iterator: null, page: [], index: 0, noMore: false, finishing: false, failure: null, sequentialRunning: false };
    this.#records.add(record);
    if (this.#sequential()) {
      void this.#sequentialWork(record);
    } else {
      // Reserve admission before counting or hydrating a page can yield.
      this.#pending.push(record);
      this.#wake();
    }
    return record.promise;
  }

  async #prepare(record) {
    if (record.total != null) return;
    if (record.predicate) {
      let count = 0;
      for await (const page of record.sequence.pages()) {
        this.#checkPage(page);
        for (const item of page) if (record.predicate(item)) count++;
      }
      record.total = count;
    } else record.total = Number(await record.sequence.count());
    if (!Number.isFinite(record.total) || record.total < 0) throw new TypeError('A library workset count must be nonnegative.');
    if (record.total === 0) { this.#observe(record.reportProgress, 100); record.noMore = true; }
  }

  #checkPage(page) {
    if (!Array.isArray(page) || page.length > 128) throw new TypeError('Library work pages must contain at most 128 items.');
  }

  async #next(record) {
    while (!record.noMore) {
      if (record.index < record.page.length) {
        const item = record.page[record.index++];
        if (!record.predicate || record.predicate(item)) return { item };
        continue;
      }
      // Advancing the generator releases its page. Retain it until every
      // callback using that page has finished, then hydrate the next page.
      if (record.active) return null;
      record.iterator ??= record.sequence.pages()[Symbol.asyncIterator]();
      const next = await record.iterator.next();
      if (next.done) {
        record.noMore = true;
        if (record.dispatched !== record.total) throw new Error('Library workset membership changed during traversal.');
        return null;
      }
      this.#checkPage(next.value);
      record.page = next.value;
      record.index = 0;
    }
    return null;
  }

  #progress(record, slot, value) {
    if (!slot.active || record.finishing) return;
    const rounded = roundProgress(value);
    if (rounded === slot.progress) return;
    record.sum += rounded - slot.progress;
    slot.progress = rounded;
    this.#observe(record.reportProgress, record.sum / record.total);
  }

  async #process(record, item, pooled) {
    const slot = { active: true, progress: 0 };
    const context = { owner: this, active: true, pooled, parent: workContext.getStore() };
    try {
      if (!this.#closed && !record.signal?.aborted) {
        const run = () => workContext.run(context, () => record.worker(item, value => this.#progress(record, slot, value)));
        if (pooled) await this.runWorker(run); else await run();
      }
    } catch (error) { this.#observe(record.onError, error, item); }
    finally {
      context.active = false;
      this.#progress(record, slot, 100);
      slot.active = false;
      record.completed++;
    }
  }

  async #sequentialWork(record) {
    record.sequentialRunning = true;
    try {
      await this.#prepare(record);
      while (!this.#closed && !record.noMore) {
        const next = await this.#next(record);
        if (!next) break;
        record.dispatched++;
        await this.#process(record, next.item, false);
        if (record.dispatched === record.total) record.noMore = true;
      }
    } catch (error) { record.failure = error; }
    finally { record.noMore = true; record.sequentialRunning = false; await this.#finish(record); }
  }

  #wake() {
    if (this.#pumping) { this.#wakePending = true; return; }
    this.#pumping = true;
    void this.#pump().finally(() => {
      this.#pumping = false;
      if (this.#wakePending) { this.#wakePending = false; this.#wake(); }
    }).catch(error => this.#observe(this.onError, error));
  }

  async #pump() {
    while (!this.#closed && this.#pending.length && this.#active < this.#limit()) {
      const record = this.#pending[0];
      try {
        await this.#prepare(record);
        if (this.#closed) break;
        const next = await this.#next(record);
        if (!next) {
          if (!record.noMore) return;
          this.#pending.shift();
          await this.#finish(record);
          continue;
        }
        if (this.#closed) break;
        record.dispatched++;
        record.active++;
        this.#active++;
        // The next workset can start while this one's final callbacks remain
        // active. Completion of an entire workset is not a dispatch barrier.
        if (record.dispatched === record.total) { record.noMore = true; this.#pending.shift(); }
        void this.#process(record, next.item, true).finally(async () => {
          record.active--;
          this.#active--;
          if (record.noMore || this.#closed) await this.#finish(record);
          this.#wake();
        }).catch(error => this.#observe(this.onError, error));
      } catch (error) {
        record.failure = error;
        record.noMore = true;
        if (this.#pending[0] === record) this.#pending.shift();
        await this.#finish(record);
      }
    }
    if (this.#closed) for (const record of this.#records) {
      record.noMore = true;
      if (!record.active) await this.#finish(record);
    }
  }

  async #finish(record) {
    if (record.active || record.sequentialRunning || record.finishing) return;
    record.finishing = true;
    try { await record.iterator?.return?.(); }
    catch (cleanup) {
      record.failure = record.failure ? new AggregateError([record.failure, cleanup], record.failure.message, { cause: record.failure }) : cleanup;
    }
    finally {
      record.page = [];
      this.#records.delete(record);
      if (record.failure) record.reject(record.failure); else record.resolve();
    }
  }

  close() {
    const fromWorker = activeContext(context => context.owner === this);
    if (!this.#closing) {
      this.#closed = true;
      this.#pending = [];
      this.#wake();
      this.#closing = (async () => {
        while (this.#records.size) await Promise.allSettled([...this.#records].map(record => record.promise));
      })();
    }
    return fromWorker ? Promise.resolve() : this.#closing;
  }
}
