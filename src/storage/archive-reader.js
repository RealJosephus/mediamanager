import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const unavailable = message => Object.assign(new Error(message), { code: 'not-supported', status: 503 });
const closedError = () => Object.assign(new Error('The archive reader is closed.'), { code: 'closed' });
const startArchiveWorker = workerData => new Worker(new URL('./archive-worker.js', import.meta.url), { workerData, trackUnmanagedFds: true });

/** Operation-owned archive access. Only the selected entry is decoded into memory. */
export class BookArchiveService {
  #lifetime = new AbortController();
  #opening = new Set();
  #leases = new Set();
  #close;
  constructor({ vfs, identityMap, spoolPath, createWorker = startArchiveWorker } = {}) {
    Object.assign(this, { vfs, identityMap, spoolPath, createWorker });
    this.openArchive = this.openArchive.bind(this);
  }
  openArchive(item, options = {}) {
    if (this.#lifetime.signal.aborted) return Promise.reject(closedError());
    const operation = this.#open(item, options);
    this.#opening.add(operation);
    operation.finally(() => this.#opening.delete(operation)).catch(() => {});
    return operation;
  }
  async #open(item, { signal, zipOnly = false } = {}) {
    if (!this.vfs || !this.identityMap || !this.spoolPath) throw unavailable('Book archive access requires media storage and an instance spool directory.');
    signal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    signal.throwIfAborted();
    const access = this.identityMap.resolve({ itemId: item.Id, identityPath: item.Path,
      style: /^[A-Za-z]:[\\/]|^\\\\/u.test(item.Path) ? 'windows' : 'posix' });
    await fs.mkdir(this.spoolPath, { recursive: true });
    const filename = path.join(this.spoolPath, 'archive-' + randomUUID() + '.tmp');
    const removeSpools = async () => {
      const results = await Promise.allSettled([filename, filename + '.entry'].map(async spool => {
        try { await fs.unlink(spool); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    };
    let destination, source, worker, size = 0, lease;
    try {
      destination = await fs.open(filename, 'wx');
      source = await this.vfs.openRead(access, { signal });
      try {
        for await (const chunk of source.stream) {
          signal.throwIfAborted();
          size += chunk.length;
          if (!Number.isSafeInteger(size)) throw unavailable('The archive exceeds the supported file range.');
          await destination.writeFile(chunk);
        }
      } finally { await source.close(); source = undefined; }
      await destination.close(); destination = undefined;
      signal.throwIfAborted();
      worker = this.createWorker({ filename, size, zipOnly });
      const pending = new Map(); let ordinal = 0, closing;
      const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
      const ready = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
      worker.on('message', ({ id, result, error }) => {
        const request = pending.get(id); if (!request) return;
        pending.delete(id);
        if (error) request.reject(Object.assign(new Error(error.message), { name: error.name, code: error.code }));
        else request.resolve(result);
      });
      const terminate = error => { fail(error); lease.close(error).catch(() => {}); };
      worker.on('error', terminate);
      worker.on('exit', status => terminate(status ? new Error('Archive worker exited with status ' + status + '.') : closedError()));
      const onAbort = () => { lease.close(signal.reason).catch(() => {}); };
      const lifetime = this.#lifetime.signal;
      const onLifetimeAbort = () => { lease.close(lifetime.reason).catch(() => {}); };
      lease = {
        async close(reason = closedError()) {
          if (closing) return closing;
          fail(reason);
          signal.removeEventListener('abort', onAbort);
          lifetime.removeEventListener('abort', onLifetimeAbort);
          closing = (async () => {
            try { await worker.terminate(); }
            finally { try { await removeSpools(); } finally { owner.#leases.delete(lease); } }
          })();
          return closing;
        },
        async read(entry, { signal: readSignal } = {}) {
          if (closing) throw closedError();
          lifetime.throwIfAborted(); readSignal?.throwIfAborted();
          const index = lease.entries.indexOf(entry);
          if (index < 0) throw new TypeError('The archive entry belongs to a different reader.');
          const abort = () => lease.close(readSignal.reason).catch(() => {});
          readSignal?.addEventListener('abort', abort, { once: true });
          const id = ++ordinal;
          try {
            const bytes = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, ordinal: index }); });
            return Buffer.from(bytes);
          } finally { readSignal?.removeEventListener('abort', abort); }
        },
        findEntry(key) { return lease.entries.find(entry => entry.key === key) ?? null; }
      };
      const owner = this;
      this.#leases.add(lease);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const result = await ready;
      lease.entries = result.entries;
      lease.comment = Buffer.from(result.comment);
      signal.throwIfAborted();
      signal.removeEventListener('abort', onAbort);
      lifetime.addEventListener('abort', onLifetimeAbort, { once: true });
      if (lifetime.aborted) onLifetimeAbort();
      return lease;
    } catch (error) {
      if (lease) await lease.close(error);
      else {
        try { await worker?.terminate(); }
        finally {
          try { await source?.close(); }
          finally {
            try { await destination?.close(); }
            finally { await removeSpools(); }
          }
        }
      }
      throw error;
    }
  }
  close() {
    if (this.#close) return this.#close;
    this.#lifetime.abort(closedError());
    this.#close = (async () => {
      await Promise.allSettled(this.#opening);
      const results = await Promise.allSettled([...this.#leases].map(lease => lease.close()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return this.#close;
  }
}
