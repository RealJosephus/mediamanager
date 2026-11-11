import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { StorageError, requireCapability } from './errors.js';
import { ownStorageAdapter } from './ownership.js';
import { VirtualFileSystem } from './vfs.js';
import { isWithin } from './paths.js';
import { operationFailure as collectedFailure } from '../core/operation-failure.js';

const nativeCodes = { 'not-found': 'ENOENT', 'not-directory': 'ENOTDIR', 'is-directory': 'EISDIR',
  'already-exists': 'EEXIST', 'permission-denied': 'EACCES', 'not-empty': 'ENOTEMPTY', 'not-supported': 'ENOTSUP' };
const nativeError = error => {
  try {
    const code = error?.code;
    if (!Object.hasOwn(nativeCodes, code)) return error;
    return Object.assign(new Error(error.message, { cause: error }), { code: nativeCodes[code], storageCode: code },
      Object.fromEntries(['status', 'statusCode', 'errors'].filter(key => Object.hasOwn(error, key)).map(key => [key, error[key]])));
  } catch { return error; }
};
const operationFailure = errors => collectedFailure(errors, 'Storage file cleanup failed.');
function streamFailure(error) {
  if (error instanceof Error) return error;
  let message = 'Storage file reading failed.';
  try { const value = error?.message; if (value != null) message = String(value); }
  catch { /* Diagnostics cannot replace the original reader rejection. */ }
  const result = new Error(message, { cause: error });
  for (const key of ['code', 'status', 'statusCode']) {
    try { const value = error?.[key]; if (value !== undefined) result[key] = value; }
    catch { /* Preserve the original value in cause without executing getters again. */ }
  }
  return result;
}

async function withCleanup(operation, cleanups) {
  let value;
  const errors = [];
  try { value = await operation(); } catch (error) { errors.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length) throw operationFailure(errors);
  return value;
}
const dateNs = value => {
  if (!value) return 0n;
  const milliseconds = Date.parse(value), fraction = /\.(\d+)/u.exec(value)?.[1] ?? '';
  return BigInt(milliseconds - ((milliseconds % 1000) + 1000) % 1000) * 1000000n
    + BigInt(fraction.padEnd(9, '0').slice(0, 9));
};
const identityPathApi = identity => /^[A-Za-z]:[\\/]|^\\\\/u.test(identity) ? path.win32 : path.posix;
// These callers request a full read. Prefer the actual body length; never
// turn an unknown length into zero or coerce an exact byte count to Number.
const readSize = handle => handle.contentLength ?? handle.size ?? handle.totalSize ?? undefined;
function missingWithoutCleanup(error) {
  try { return error?.code === 'not-found' && !(error instanceof AggregateError) && error.errors === undefined; }
  catch { return false; }
}

/** Identity paths belong to the database. Only this facade resolves them to a
 * storage instance; it never falls back to the host operating system. */
export class StorageFileSystem {
  #closed = false;
  #closing;
  #opening = new Set();
  #handles = new Set();
  constructor({ vfs, identityMap }) { Object.assign(this, { vfs, identityMap }); }
  accessPath(identity) {
    return this.identityMap.resolve({ identityPath: identity,
      style: identityPathApi(identity) === path.win32 ? 'windows' : 'posix' });
  }
  resolve(identity) { return this.vfs.resolve(this.accessPath(identity)); }
  retainDirectory(identity, options) { return this.retainDirectories([identity], options); }
  retainDirectories(identities, { requiredCapabilities = ['create', 'delete'], preserveMountRoots = false } = {}) {
    if (this.#closed) throw new StorageError('closed', 'Storage files are closed.');
    const definitions = new Map();
    for (const identity of identities) {
      const access = this.accessPath(identity), resolved = this.vfs.resolve(access);
      for (const capability of requiredCapabilities) requireCapability(resolved, capability);
      // A host mkdir continuation must preserve the original mount boundary:
      // clipping a missing target or ancestor would invent a protected root.
      // This affects retention only; configured mounts keep their root guard.
      const definition = preserveMountRoots ? resolved.mount
        : { path: access, root: resolved.path, capabilities: resolved.mount.capabilities };
      definitions.set(definition.path, definition);
    }
    // Preserve more specific mounts, including their restrictions and missing
    // instances. A retained parent must never redirect a child to its backend.
    const roots = [...definitions.keys()];
    for (const mount of this.vfs.mountDefinitions()) if (roots.some(root => isWithin(mount.path, root))) definitions.set(mount.path, mount);
    let closing;
    const adapters = new Map(), leases = new Map();
    const vfs = new VirtualFileSystem({ hasInstance: () => false, getInstance(id) {
      if (closing) throw new StorageError('closed', 'The owned storage directories are closed.');
      const entry = adapters.get(id);
      if (entry.failed) throw entry.error;
      return entry.adapter;
    } });
    for (const [index, definition] of [...definitions.values()].entries()) {
      vfs.mount({ ...definition, instanceId: String(index) }, { deferred: true });
    }
    for (const [index, definition] of [...definitions.values()].entries()) {
      let entry;
      try {
        const adapter = this.vfs.resolve(definition.path).adapter;
        if (!leases.has(adapter)) leases.set(adapter, ownStorageAdapter(adapter));
        entry = { adapter: leases.get(adapter).adapter };
      } catch (error) { entry = { failed: true, error }; }
      adapters.set(String(index), entry);
    }
    const fileSystem = new StorageFileSystem({ vfs, identityMap: this.identityMap });
    fileSystem.spoolRoot = this.spoolRoot;
    const released = Promise.withResolvers(), resource = { close: () => released.promise };
    void released.promise.catch(() => {});
    this.#handles.add(resource);
    // A spool consumer retains this generation until its own finally has
    // drained readers and removed its names. Shutdown joins that completion.
    return { fileSystem, close: () => {
      if (!closing) {
        closing = withCleanup(() => fileSystem.close(), [...leases.values()].reverse().map(lease => () => lease.close()));
        void closing.then(released.resolve, released.reject).finally(() => this.#handles.delete(resource));
      }
      return closing;
    } };
  }
  async #run(work) { try { return await work(); } catch (error) { throw nativeError(error); } }
  async stat(identity, options = {}) { return this.#run(async () => {
    const resolved = this.resolve(identity);
    if (resolved.adapter.fileStat) return resolved.adapter.fileStat(resolved.path, options);
    const value = await this.vfs.stat(this.accessPath(identity), options), big = options.bigint === true;
    const mtimeNs = dateNs(value.modified), birthtimeNs = dateNs(value.created ?? value.modified);
    return { size: big ? value.size ?? 0n : Number(value.size ?? 0n), mtimeNs, birthtimeNs, ctimeNs: mtimeNs,
      mtimeMs: big ? mtimeNs / 1000000n : Number(mtimeNs) / 1000000,
      birthtimeMs: big ? birthtimeNs / 1000000n : Number(birthtimeNs) / 1000000,
      mtime: new Date(Number(mtimeNs / 1000000n)), birthtime: new Date(Number(birthtimeNs / 1000000n)),
      isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => false };
  }); }
  lstat(identity, options) { return this.stat(identity, options); }
  async realpath(identity) {
    // Validate access and let the storage adapter reject links before returning
    // a normalized identity. The backing storage path is never an identity.
    await this.stat(identity);
    return identityPathApi(identity).resolve(identity);
  }
  async readdir(identity, options = {}) { return this.#run(async () => {
    const { entries } = await this.vfs.list(this.accessPath(identity), options);
    return options.withFileTypes ? entries.map(value => ({ name: value.name,
      isDirectory: () => value.kind === 'directory', isFile: () => value.kind === 'file', isSymbolicLink: () => false })) : entries.map(value => value.name);
  }); }
  async readFile(identity, options = {}) { return this.#run(async () => {
    const encoding = typeof options === 'string' ? options : options.encoding;
    const handle = await this.vfs.openRead(this.accessPath(identity), typeof options === 'string' ? {} : options);
    return withCleanup(async () => {
      const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); return encoding ? bytes.toString(encoding) : bytes;
    }, [() => handle.close()]);
  }); }
  openRead(identity, options = {}) { return this.vfs.openRead(this.accessPath(identity), options); }
  createReadStream(identity, options = {}) {
    const owner = this;
    return Readable.from((async function* () {
      let handle;
      const errors = [];
      try { handle = await owner.openRead(identity, options); yield* handle.stream; } catch (error) { errors.push(error); }
      finally {
        try { await handle?.close(); } catch (error) { errors.push(error); }
        // Node streams require a truthy error to reject their async iterator.
        if (errors.length) throw streamFailure(operationFailure(errors));
      }
    })());
  }
  async writeFile(identity, data, options = {}) { return this.#run(async () => {
    if (typeof options === 'string') options = { encoding: options };
    const bytes = typeof data === 'string' ? Buffer.from(data, options.encoding ?? 'utf8') : data;
    await this.vfs.write(this.accessPath(identity), bytes, { signal: options.signal,
      overwrite: !options.flag?.includes('x'), size: bytes instanceof Uint8Array ? BigInt(bytes.length) : options.size });
  }); }
  async mkdir(identity, options = {}) { return this.#run(async () => {
    const access = this.accessPath(identity);
    if (options.recursive) {
      try { const info = await this.vfs.stat(access, options); if (info.kind === 'directory') return;
        throw new StorageError('already-exists', 'The requested directory is a file.');
      } catch (error) { if (!missingWithoutCleanup(error)) throw error; }
      await this.mkdir(identityPathApi(identity).dirname(identity), options);
    }
    await this.vfs.mkdir(access, options);
  }); }
  async mkdtemp(prefix) { const name = prefix + randomUUID(); await this.mkdir(name); return name; }
  unlink(identity) { return this.#run(async () => {
    const access = this.accessPath(identity);
    if ((await this.vfs.stat(access)).kind === 'directory') throw new StorageError('is-directory', 'A directory cannot be unlinked as a file.');
    return this.vfs.delete(access);
  }); }
  rmdir(identity) { return this.#run(async () => {
    const access = this.accessPath(identity);
    if ((await this.vfs.stat(access)).kind !== 'directory') throw new StorageError('not-directory', 'The object is not a directory.');
    return this.vfs.delete(access, { recursive: false });
  }); }
  async rm(identity, options = {}) { return this.#run(async () => {
    try { await this.vfs.delete(this.accessPath(identity), options); }
    catch (error) { if (!(options.force && missingWithoutCleanup(error))) throw error; }
  }); }
  rename(identity, destination) { return this.#run(() => this.vfs.rename(this.accessPath(identity), this.accessPath(destination), { overwrite: true })); }
  async copyFile(identity, destination) { return this.#run(async () => {
    const sourcePath = this.accessPath(identity), targetPath = this.accessPath(destination);
    const handle = await this.vfs.openRead(sourcePath);
    await withCleanup(async () => {
      const source = this.vfs.resolve(sourcePath), target = this.vfs.resolveFileHandle(targetPath, 'w');
      // Opening the destination for writing would truncate an unread source.
      // Preserve same-file copies, including mount aliases and local hard links.
      if (source.adapter === target.adapter && source.path === target.path) return;
      if (source.adapter.fileStat && target.adapter.fileStat) {
        const from = await source.adapter.fileStat(source.path, { bigint: true });
        let to;
        try { to = await target.adapter.fileStat(target.path, { bigint: true }); }
        catch (error) { if (!['ENOENT', 'not-found'].includes(error?.code)) throw error; }
        if (from.ino && from.dev != null && from.ino === to?.ino && from.dev === to?.dev) return;
      }
      await this.vfs.write(targetPath, handle.stream, { overwrite: true, size: readSize(handle) });
    }, [() => handle.close()]);
  }); }
  open(identity, flags = 'r') {
    if (this.#closed) return Promise.reject(new StorageError('closed', 'Storage files are closed.'));
    const opening = this.#run(async () => {
      const resolved = this.vfs.resolveFileHandle(this.accessPath(identity), flags);
      if (resolved.adapter.openFile) return resolved.adapter.openFile(resolved.path, flags);
      // Sequential metadata files can use the ordinary storage write contract.
      // Random access and synchronous spool handles are explicitly optional.
      if (!['w', 'wx'].includes(flags) || !this.spoolRoot) throw new StorageError('not-supported', 'This storage does not expose random file handles.');
      const temporary = path.join(this.spoolRoot, `file-${randomUUID()}.tmp`);
      const temporaryPath = this.accessPath(temporary), vfs = this.vfs;
      const spool = vfs.resolveFileHandle(temporaryPath, 'wx');
      if (!spool.adapter.openFile) throw new StorageError('not-supported', 'The configured spool storage must expose file handles.');
      requireCapability(spool, 'delete');
      const targetOwner = ownStorageAdapter(resolved.adapter);
      let spoolOwner, file;
      try {
        spoolOwner = ownStorageAdapter(spool.adapter);
        file = await spoolOwner.adapter.openFile(spool.path, 'wx');
      } catch (error) {
        return withCleanup(() => { throw error; }, [() => spoolOwner?.close(), () => targetOwner.close()]);
      }
      const owner = this; let closing;
      const write = (method, args) => {
        if (closing || owner.#closed) throw new StorageError('closed', 'The storage file is closed.');
        return file[method](...args);
      };
      const result = { write: (...args) => write('write', args), writeFile: (...args) => write('writeFile', args),
        writeSync: (...args) => write('writeSync', args), close() {
          if (closing) return closing;
          let handle;
          closing = withCleanup(async () => {
            await file.close(); handle = await spoolOwner.adapter.openRead(spool.path);
            await targetOwner.adapter.write(resolved.path, handle.stream, { overwrite: flags !== 'wx', size: readSize(handle) });
          }, [() => handle?.close(), () => owner.#run(async () => {
            try { await spoolOwner.adapter.delete(spool.path); }
            catch (error) { if (error?.code !== 'not-found') throw error; }
          }), () => spoolOwner.close(), () => targetOwner.close()]);
          void closing.then(() => owner.#handles.delete(result), () => owner.#handles.delete(result));
          return closing;
        } };
      this.#handles.add(result);
      return result;
    });
    this.#opening.add(opening);
    void opening.then(() => this.#opening.delete(opening), () => this.#opening.delete(opening));
    return opening;
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = (async () => {
      await Promise.allSettled([...this.#opening]);
      const results = await Promise.allSettled([...this.#handles].map(handle => handle.close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw operationFailure(failures);
    })();
  }
}
