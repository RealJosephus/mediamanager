import * as fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StorageError, checkAbort, requireCapability } from '@mediamanager/plugin-sdk/storage/errors';
import { normalizePath } from '@mediamanager/plugin-sdk/storage/paths';
import { resolveRange } from '@mediamanager/plugin-sdk/storage/range';
import { watchDirectory } from './watch.js';

const codes = { ENOENT: 'not-found', ENOTDIR: 'not-directory', EISDIR: 'is-directory',
  EPERM: 'permission-denied', EACCES: 'permission-denied', EEXIST: 'already-exists',
  ENOTEMPTY: 'not-empty', EBUSY: 'unavailable', ABORT_ERR: 'cancelled' };
const publicFailure = error => Object.fromEntries(['status', 'statusCode', 'errors']
  .filter(key => error != null && Object.hasOwn(error, key)).map(key => [key, error[key]]));
const failure = error => error instanceof StorageError ? error
  : Object.assign(new StorageError(Object.hasOwn(codes, error?.code) ? codes[error.code] : 'unavailable',
    error?.message ?? 'The local storage operation failed.', { nativeCode: error?.code }), publicFailure(error), { cause: error });
const combinedFailure = errors => {
  if (errors.length === 1) return errors[0];
  const primary = failure(errors[0]);
  return Object.assign(new StorageError(primary.code, primary.message, primary.details), publicFailure(primary),
    { cause: new AggregateError(errors, primary.message, { cause: errors[0] }), errors });
};
const version = info => `"${createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')).digest('hex')}"`;
const date = ns => {
  const fraction = (ns % 1000000000n + 1000000000n) % 1000000000n;
  return new Date(Number((ns - fraction) / 1000000n)).toISOString().replace('.000Z', `.${String(fraction / 100n).padStart(7, '0')}Z`);
};
const createdNanoseconds = info => process.platform === 'linux'
  ? (info.ctimeNs < info.mtimeNs ? info.ctimeNs : info.mtimeNs) : info.birthtimeNs;
const creationStat = info => {
  if (process.platform !== 'linux') return info;
  // Local metadata consumers use the filesystem creation value, which on
  // Linux is the earlier change/write time. Keep the other stat values intact.
  const field = info.mtimeNs === undefined
    ? (info.ctimeMs < info.mtimeMs ? 'ctime' : 'mtime')
    : (info.ctimeNs < info.mtimeNs ? 'ctime' : 'mtime');
  info.birthtime = info[field]; info.birthtimeMs = info[field + 'Ms'];
  if (info.mtimeNs !== undefined) info.birthtimeNs = info[field + 'Ns'];
  return info;
};
const entry = (name, info) => ({ name, kind: info.isDirectory() ? 'directory' : 'file',
  size: info.isDirectory() ? null : info.size, modified: date(info.mtimeNs), created: date(createdNanoseconds(info)),
  version: version(info) });

// A root is an administrator-owned directory, not a sandbox against concurrent
// privileged OS mutations. Existing symlinks, junctions and alternate streams
// are rejected before every operation, including every recursive delete entry.
export class LocalAdapter {
  #closed = false;
  #lifetime = new AbortController();
  #handles = new Set();
  #pending = new Set();
  #writes = Promise.resolve();
  #closing;
  static async open(configuration, options = {}) {
    const adapter = new LocalAdapter(configuration);
    await adapter.#target('/', { missing: true });
    if (configuration.createRoot) await fs.mkdir(adapter.root, { recursive: true });
    await adapter.#target('/'); checkAbort(options.signal); return adapter;
  }
  constructor(configuration) {
    if (!configuration || Object.keys(configuration).some(key => !['root', 'writable', 'createRoot'].includes(key))
      || typeof configuration.root !== 'string' || !path.isAbsolute(configuration.root)
      || configuration.writable !== undefined && typeof configuration.writable !== 'boolean'
      || configuration.createRoot !== undefined && typeof configuration.createRoot !== 'boolean') {
      throw new TypeError('Local storage requires an absolute root and optional writable/createRoot booleans.');
    }
    this.root = path.resolve(configuration.root);
    const writable = configuration.writable === true;
    this.capabilities = Object.freeze({ randomRead: true, reliableLength: true, reliableVersion: false,
      directorySnapshot: true, create: writable, replace: writable, mkdir: writable, delete: writable,
      rename: writable, atomicReplace: writable, conditionalWrite: false, directLease: false, watch: true });
  }
  async #target(value, { missing = false, leafLink = false } = {}) {
    value = normalizePath(value);
    const parts = value.split('/').filter(Boolean);
    if (parts.some(part => /[:\\\0]/u.test(part) || process.platform === 'win32'
      && (/[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)))) {
      throw new StorageError('invalid-path', 'The local file path contains a reserved component.');
    }
    const target = path.join(this.root, ...parts);
    let current = path.parse(this.root).root;
    const all = path.relative(current, target).split(path.sep).filter(Boolean);
    for (let index = 0; index < all.length; index++) {
      current = path.join(current, all[index]);
      try {
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() && !(leafLink && index === all.length - 1)) {
          throw new StorageError('permission-denied', 'Local storage does not follow symbolic links or junctions.', { reason: 'link' });
        }
        if (index < all.length - 1 && !info.isDirectory()) throw new StorageError('not-directory', 'A local path ancestor is not a directory.');
      } catch (error) { if (missing && error.code === 'ENOENT') break; throw error; }
    }
    return target;
  }
  #operation(options, work, mutation = false) {
    if (this.#closed) return Promise.reject(new StorageError('closed', 'Local storage is closed.'));
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const invoke = async () => { checkAbort(signal); try { return await work(signal); } catch (error) { throw failure(error); } };
    const operation = mutation ? this.#writes.then(invoke) : invoke();
    if (mutation) this.#writes = operation.catch(() => {});
    this.#pending.add(operation); void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }
  async #file(value, flags, options = {}) {
    const write = /[wa+]/u.test(flags);
    if (write) requireCapability(this, flags.includes('x') ? 'create' : 'replace');
    const target = await this.#target(value, { missing: write });
    const raw = await fs.open(target, flags), owner = this; let closed = false;
    const close = async () => { if (closed) return; closed = true; owner.#handles.delete(handle); await raw.close(); };
    const handle = new Proxy(raw, { get(object, key) {
      if (key === 'close') return close;
      if (key === 'writeSync') return bytes => { if (closed || owner.#closed) throw new StorageError('closed', 'The storage file is closed.'); return writeSync(raw.fd, bytes); };
      const property = Reflect.get(object, key, object);
      return typeof property === 'function' ? (...args) => {
        if (closed || owner.#closed) throw new StorageError('closed', 'The storage file is closed.');
        checkAbort(options.signal); return property.apply(object, args);
      } : property;
    } });
    this.#handles.add(handle); return handle;
  }
  openFile(value, flags, options = {}) { return this.#operation(options, signal => this.#file(value, flags, { signal })); }
  fileStat(value, options = {}) { return this.#operation(options, async () => creationStat(await fs.lstat(await this.#target(value), options))); }
  stat(value, options = {}) { return this.#operation(options, async () => entry(path.posix.basename(value), await fs.lstat(await this.#target(value), { bigint: true }))); }
  listPage(value, options = {}) {
    return this.#operation(options, async signal => {
      if (options.cursor != null) throw new StorageError('invalid-response', 'Local directory cursor is invalid.');
      const target = await this.#target(value), before = await fs.lstat(target, { bigint: true });
      if (!before.isDirectory()) throw new StorageError('not-directory', 'Local object is not a directory.');
      const entries = [];
      for (const name of await fs.readdir(target)) {
        checkAbort(signal);
        const item = await fs.lstat(path.join(target, name), { bigint: true });
        if (item.isSymbolicLink()) throw new StorageError('permission-denied', 'Local directory contains a link.', { reason: 'link' });
        if (!item.isFile() && !item.isDirectory()) throw new StorageError('not-supported', 'Local directory contains a special file.');
        entries.push(entry(name, item));
      }
      const after = await fs.lstat(target, { bigint: true });
      if (version(before) !== version(after)) throw new StorageError('version-changed', 'The local directory changed during enumeration.');
      return { entries, complete: true, nextCursor: null, snapshot: version(after), consistency: 'snapshot', deletionSafe: true };
    });
  }
  openRead(value, options = {}) {
    return this.#operation(options, async signal => {
      const file = await this.#file(value, 'r', { signal });
      try {
        const info = await file.stat({ bigint: true });
        if (!info.isFile()) throw new StorageError('is-directory', 'Local object is not a file.');
        if (options.ifMatch !== undefined && options.ifMatch !== version(info)) throw new StorageError('version-changed', 'The local file changed.');
        const requested = options.ifRange && options.ifRange !== version(info) ? null : options.range;
        const range = resolveRange(requested, info.size), close = () => file.close();
        async function* stream() {
          let position = range?.start ?? 0n, remaining = range ? range.end - range.start + 1n : 0n;
          try {
            while (remaining) {
              checkAbort(signal);
              const bytes = Buffer.allocUnsafe(Number(remaining > 65536n ? 65536n : remaining));
              const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
              if (!bytesRead) throw new StorageError('version-changed', 'The local file ended during reading.');
              position += BigInt(bytesRead); remaining -= BigInt(bytesRead); yield bytes.subarray(0, bytesRead);
            }
          } finally { await close(); }
        }
        return { stream: stream(), close, size: range ? range.end - range.start + 1n : 0n,
          totalSize: info.size, version: version(info), modified: date(info.mtimeNs), range: requested ? range : null,
          rangeHonored: Boolean(requested), status: requested ? 206 : 200, contentType: null };
      } catch (error) { await file.close(); throw error; }
    });
  }
  write(value, data, options = {}) {
    return this.#operation(options, async signal => {
      requireCapability(this, options.overwrite === false ? 'create' : 'replace');
      if (options.ifMatch !== undefined) requireCapability(this, 'conditionalWrite');
      if (value === '/') throw new StorageError('permission-denied', 'A storage root cannot be replaced.');
      const target = await this.#target(value, { missing: true });
      const temporary = options.atomic ? path.join(path.dirname(target), `.storage-${randomUUID()}.tmp`) : target;
      const handle = await fs.open(temporary, options.atomic || options.overwrite === false ? 'wx' : 'w');
      let count = 0n, result;
      const errors = [];
      try {
        const source = data instanceof Uint8Array ? [data] : data;
        const aborted = Promise.withResolvers();
        const cancellation = () => Object.assign(new StorageError('cancelled', 'Storage operation was cancelled.'),
          publicFailure(signal.reason), { cause: signal.reason });
        const active = () => { if (signal.aborted) throw cancellation(); };
        const cancel = () => aborted.reject(cancellation());
        // The notification can reject while a synchronous next() throws before
        // Promise.race subscribes. It owns no source cleanup or business result.
        void aborted.promise.catch(() => {});
        signal.addEventListener('abort', cancel, { once: true });
        let iterator;
        try {
          iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
          for (;;) {
            active();
            const next = await Promise.race([iterator.next(), aborted.promise]);
            if (next.done) break;
            const bytes = await next.value;
            active();
            if (!(bytes instanceof Uint8Array)) throw new TypeError('Upload chunks must be bytes.');
            for (let offset = 0; offset < bytes.length;) { const written = await handle.write(bytes, offset, bytes.length - offset); if (!written.bytesWritten) throw new Error('Write made no progress.'); offset += written.bytesWritten; }
            count += BigInt(bytes.length);
            if (options.size !== undefined && count > BigInt(options.size)) throw new StorageError('invalid-response', 'Upload exceeds its declared length.');
          }
          if (options.size !== undefined && count !== BigInt(options.size)) throw new StorageError('invalid-response', 'Upload does not match its declared length.');
        } catch (error) { errors.push(error); }
        finally {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) try { await source?.destroy?.(signal.reason); } catch (error) { errors.push(error); }
          try { await iterator?.return?.(); } catch (error) { errors.push(error); }
        }
        if (!errors.length) {
          await handle.sync(); await handle.close(); active();
          if (options.atomic) {
            await this.#target(value, { missing: true });
            if (options.overwrite === false) { await fs.link(temporary, target); await fs.unlink(temporary); }
            else await fs.rename(temporary, target);
          }
          if (options.modified !== undefined) await fs.utimes(target, new Date(), new Date(options.modified));
          result = { size: count, version: version(await fs.stat(target, { bigint: true })), atomic: options.atomic === true };
        }
      } catch (error) { errors.push(error); }
      finally {
        try { await handle.close(); } catch (error) { errors.push(error); }
        if (options.atomic) try { await fs.rm(temporary, { force: true }); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw combinedFailure(errors);
      return result;
    }, true);
  }
  mkdir(value, options = {}) { return this.#operation(options, async () => {
    requireCapability(this, 'mkdir'); await fs.mkdir(await this.#target(value, { missing: true }), { recursive: options.recursive === true });
  }, true); }
  delete(value, options = {}) { return this.#operation(options, async signal => {
    requireCapability(this, 'delete');
    if (options.ifMatch !== undefined) requireCapability(this, 'conditionalWrite');
    if (normalizePath(value) === '/') throw new StorageError('permission-denied', 'A storage root cannot be deleted.');
    const remove = async (name, recursive) => {
      checkAbort(signal);
      const target = await this.#target(name, { leafLink: true }), info = await fs.lstat(target);
      if (info.isSymbolicLink()) return fs.unlink(target);
      if (info.isDirectory()) {
        if (recursive) for (const child of await fs.readdir(target)) await remove(path.posix.join(name, child), true);
        return fs.rmdir(target);
      }
      if (process.platform === 'win32' && (info.mode & 0o222) === 0) throw new StorageError('permission-denied', 'The local file is read-only.');
      await fs.unlink(target);
    };
    await remove(value, options.recursive === true);
  }, true); }
  rename(value, destination, options = {}) { return this.#operation(options, async () => {
    requireCapability(this, 'rename');
    if (options.ifMatch !== undefined) requireCapability(this, 'conditionalWrite');
    if (normalizePath(value) === '/' || normalizePath(destination) === '/') throw new StorageError('permission-denied', 'Storage roots cannot be renamed.');
    const target = await this.#target(destination, { missing: true }), source = await this.#target(value);
    if (options.overwrite !== true) { try { await fs.lstat(target); throw new StorageError('already-exists', 'The destination exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await fs.rename(source, target);
  }, true); }
  health(options = {}) { return this.#operation(options, async () => { await this.#target('/'); return { available: true }; }); }
  watch(value, options = {}) {
    return this.#operation(options, async signal => {
      const watcher = await watchDirectory(normalizePath(value), {
        ...options, signal, resolve: filename => this.#target(filename, { missing: true }), failure
      });
      const abort = () => { void handle.close().catch(() => {}); };
      const handle = { close: async () => {
        signal.removeEventListener('abort', abort);
        try { await watcher.close(); } finally { this.#handles.delete(handle); }
      } };
      this.#handles.add(handle);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { await handle.close(); checkAbort(signal); }
      return handle;
    });
  }
  close() {
    if (this.#closing) return this.#closing;
    const closing = Promise.withResolvers();
    this.#closing = closing.promise;
    this.#closed = true; this.#lifetime.abort();
    (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled([...this.#handles].map(handle => handle.close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Local storage handles failed to close.');
    })().then(closing.resolve, closing.reject);
    return this.#closing;
  }
}
