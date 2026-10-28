import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const unavailable = message => Object.assign(new Error(message), { code: 'not-supported', status: 503 });
const closedError = () => Object.assign(new Error('The archive reader is closed.'), { code: 'closed' });
const startArchiveWorker = workerData => new Worker(new URL('./archive-worker.js', import.meta.url), { workerData, trackUnmanagedFds: true });
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Archive cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
async function withCleanup(operation, cleanups) {
  let value;
  const errors = [];
  try { value = await operation(); } catch (error) { errors.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length) throw operationFailure(errors);
  return value;
}

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
    const opening = { cleanupErrors: [] };
    const operation = this.#open(item, options, opening); opening.operation = operation;
    this.#opening.add(opening);
    operation.finally(() => this.#opening.delete(opening)).catch(() => {});
    return operation;
  }
  async #open(item, { signal, zipOnly = false }, opening) {
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
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw operationFailure(errors);
    };
    let destination, source, worker, size = 0, lease;
    const cleanup = async operation => {
      try { return await operation(); }
      catch (error) { opening.cleanupErrors.push(error); throw error; }
    };
    const closeSource = async () => { const current = source; source = undefined; await cleanup(() => current?.close()); };
    const closeDestination = async () => { const current = destination; destination = undefined; await cleanup(() => current?.close()); };
    try {
      destination = await fs.open(filename, 'wx');
      source = await this.vfs.openRead(access, { signal });
      for await (const chunk of source.stream) {
        signal.throwIfAborted();
        size += chunk.length;
        if (!Number.isSafeInteger(size)) throw unavailable('The archive exceeds the supported file range.');
        await destination.writeFile(chunk);
      }
      await closeSource();
      await closeDestination();
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
          closing = Promise.resolve().then(() => withCleanup(() => worker.terminate(), [removeSpools]))
            .finally(() => owner.#leases.delete(lease));
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
      return withCleanup(() => { throw error; }, lease ? [() => lease.close(error)]
        : [() => cleanup(() => worker?.terminate()), closeSource, closeDestination, () => cleanup(removeSpools)]);
    }
  }
  close() {
    if (this.#close) return this.#close;
    const readers = [...this.#leases], openings = [...this.#opening];
    this.#lifetime.abort(closedError());
    this.#close = (async () => {
      await Promise.allSettled(openings.map(opening => opening.operation));
      const results = await Promise.allSettled(readers.map(lease => lease.close()));
      const errors = [...openings.flatMap(opening => opening.cleanupErrors),
        ...results.filter(result => result.status === 'rejected').map(result => result.reason)];
      if (errors.length) throw operationFailure(errors);
    })();
    return this.#close;
  }
}
