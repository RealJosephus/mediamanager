import { StorageError, checkAbort, requireCapability } from '../errors.js';
import { baseName, isWithin, normalizePath, parentPath } from '../paths.js';
import { normalizeRange, resolveRange, unsignedInteger } from '../range.js';

const writableCapabilities = Object.freeze(['create', 'replace', 'mkdir', 'delete', 'rename', 'atomicReplace', 'conditionalWrite']);

function capabilities(value) {
  if (value === undefined) value = Object.fromEntries(writableCapabilities.map(name => [name, true]));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(name => !writableCapabilities.includes(name))) {
    throw new TypeError('Invalid memory storage capabilities.');
  }
  for (const enabled of Object.values(value)) if (typeof enabled !== 'boolean') throw new TypeError('Invalid memory storage capability value.');
  const result = Object.fromEntries(writableCapabilities.map(name => [name, value[name] === true]));
  if (result.atomicReplace && !result.replace) throw new TypeError('Memory storage atomicReplace requires replace capability.');
  return Object.freeze({ randomRead: true, reliableLength: true, reliableVersion: true,
    directorySnapshot: true, ...result, directLease: false, watch: false });
}

// An independent fixture adapter. It is never registered as a production media backend.
export class MemoryStorageAdapter {
  #entries = new Map([['/', { kind: 'directory', revision: 0 }]]);
  #revision = 0;
  #closed = false;
  #pageSize;
  #handles = new Set();

  constructor({ pageSize = 100, capabilities: configuredCapabilities } = {}) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new TypeError('Invalid page size.');
    this.#pageSize = pageSize;
    this.capabilities = capabilities(configuredCapabilities);
  }

  #check(signal) {
    checkAbort(signal);
    if (this.#closed) throw new StorageError('closed', 'The storage adapter is closed.');
  }

  #get(path) {
    const entry = this.#entries.get(path);
    if (!entry) throw new StorageError('not-found', 'The storage object does not exist.');
    return entry;
  }

  #info(path, entry) {
    return { name: baseName(path), kind: entry.kind, size: entry.kind === 'file' ? BigInt(entry.data.length) : null,
      modified: entry.modified ?? null, created: null, version: `"memory-${entry.revision}"` };
  }

  async health(options = {}) { this.#check(options.signal); return { state: 'available' }; }

  async stat(path, options = {}) {
    this.#check(options.signal);
    path = normalizePath(path);
    return this.#info(path, this.#get(path));
  }

  async listPage(path, { signal, cursor } = {}) {
    this.#check(signal);
    path = normalizePath(path);
    if (this.#get(path).kind !== 'directory') throw new StorageError('not-directory', 'The storage object is not a directory.');
    if (cursor && (cursor.revision !== this.#revision || cursor.path !== path)) {
      throw new StorageError('version-changed', 'The directory changed during enumeration.');
    }
    const offset = cursor?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid directory cursor.');
    const all = [...this.#entries].filter(([key]) => key !== path && parentPath(key) === path);
    const entries = all.slice(offset, offset + this.#pageSize).map(([key, entry]) => this.#info(key, entry));
    const complete = offset + entries.length >= all.length;
    return { entries, complete, nextCursor: complete ? null : { offset: offset + entries.length, revision: this.#revision, path },
      consistency: 'snapshot', snapshot: String(this.#revision), deletionSafe: true };
  }

  async openRead(path, options = {}) {
    this.#check(options.signal);
    path = normalizePath(path);
    const entry = this.#get(path);
    if (entry.kind !== 'file') throw new StorageError('is-directory', 'The storage object is a directory.');
    const version = this.#info(path, entry).version;
    if (options.ifMatch && options.ifMatch !== version) throw new StorageError('version-changed', 'The object version changed.');
    const requestedRange = normalizeRange(options.range);
    const rangeHonored = Boolean(requestedRange) && (!options.ifRange || options.ifRange === version);
    const actualRange = resolveRange(rangeHonored ? requestedRange : null, entry.data.length);
    const bytes = actualRange ? entry.data.subarray(Number(actualRange.start), Number(actualRange.end + 1n)) : new Uint8Array();
    let closed = false;
    const close = async () => { closed = true; this.#handles.delete(close); };
    this.#handles.add(close);
    const adapter = this;
    async function* stream() {
      try {
        adapter.#check(options.signal);
        if (closed) throw new StorageError('closed', 'The read handle is closed.');
        if (bytes.length) yield Uint8Array.from(bytes);
        adapter.#check(options.signal);
      } finally { await close(); }
    }
    return { stream: stream(), totalSize: BigInt(entry.data.length), contentLength: BigInt(bytes.length),
      range: rangeHonored ? actualRange : null, rangeHonored, version, close };
  }

  async write(path, data, options = {}) {
    this.#check(options.signal);
    path = normalizePath(path);
    if (this.#get(parentPath(path)).kind !== 'directory') throw new StorageError('not-directory', 'The parent is not a directory.');
    const before = this.#entries.get(path);
    if (options.overwrite === false) requireCapability(this, 'create');
    else if (options.ifMatch !== undefined) requireCapability(this, 'replace');
    else { requireCapability(this, 'create'); requireCapability(this, 'replace'); }
    if (options.ifMatch !== undefined) requireCapability(this, 'conditionalWrite');
    if (options.atomic === true) requireCapability(this, 'atomicReplace');
    if (before?.kind === 'directory') throw new StorageError('is-directory', 'The destination is a directory.');
    if (options.overwrite === false && before) throw new StorageError('already-exists', 'The destination already exists.');
    if (options.ifMatch && (!before || this.#info(path, before).version !== options.ifMatch)) {
      throw new StorageError('version-changed', 'The object version changed.');
    }
    const parts = [];
    let size = 0;
    for await (const part of data instanceof Uint8Array ? [data] : data) {
      this.#check(options.signal);
      if (!(part instanceof Uint8Array)) throw new TypeError('Write chunks must be bytes.');
      parts.push(Buffer.from(part));
      size += part.length;
    }
    this.#check(options.signal);
    if (this.#entries.get(path) !== before) throw new StorageError('version-changed', 'The object changed while writing.');
    if (options.size !== undefined && unsignedInteger(options.size) !== BigInt(size)) throw new StorageError('invalid-response', 'The write length does not match the declared length.');
    this.#entries.set(path, { kind: 'file', data: Buffer.concat(parts), revision: ++this.#revision, modified: options.modified ?? null });
    return { size: BigInt(size), atomic: true };
  }

  async mkdir(path, options = {}) {
    this.#check(options.signal);
    requireCapability(this, 'mkdir');
    path = normalizePath(path);
    if (this.#entries.has(path)) throw new StorageError('already-exists', 'The destination already exists.');
    if (this.#get(parentPath(path)).kind !== 'directory') throw new StorageError('not-directory', 'The parent is not a directory.');
    this.#entries.set(path, { kind: 'directory', revision: ++this.#revision });
  }

  async delete(path, options = {}) {
    this.#check(options.signal);
    requireCapability(this, 'delete');
    path = normalizePath(path);
    if (path === '/') throw new StorageError('permission-denied', 'The storage root cannot be removed.');
    const entry = this.#get(path);
    if (options.ifMatch !== undefined) {
      requireCapability(this, 'conditionalWrite');
      if (this.#info(path, entry).version !== options.ifMatch) throw new StorageError('version-changed', 'The object version changed.');
    }
    for (const key of this.#entries.keys()) if (isWithin(key, path)) this.#entries.delete(key);
    this.#revision++;
  }

  async rename(path, destination, options = {}) {
    this.#check(options.signal);
    requireCapability(this, 'rename');
    path = normalizePath(path);
    destination = normalizePath(destination);
    if (path === '/' || (destination !== path && isWithin(destination, path))) throw new StorageError('invalid-path', 'A directory cannot be moved into itself.');
    const entry = this.#get(path);
    if (options.ifMatch !== undefined) {
      requireCapability(this, 'conditionalWrite');
      if (this.#info(path, entry).version !== options.ifMatch) throw new StorageError('version-changed', 'The object version changed.');
    }
    if (this.#get(parentPath(destination)).kind !== 'directory') throw new StorageError('not-directory', 'The parent is not a directory.');
    if (path === destination) return;
    if (this.#entries.has(destination)) throw new StorageError('already-exists', 'The destination already exists.');
    for (const [key, value] of [...this.#entries]) if (isWithin(key, path)) {
      this.#entries.delete(key);
      this.#entries.set(`${destination}${key.slice(path.length)}`, value);
    }
    this.#revision++;
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#handles].map((close) => close()));
  }
}
