import { StorageError, checkAbort, requireCapability } from './errors.js';
import { baseName, isWithin, joinPath, normalizePath, validateName } from './paths.js';

const mountCapabilityNames = Object.freeze(['create', 'replace', 'mkdir', 'delete', 'rename', 'conditionalWrite', 'atomicReplace']);

function mountCapabilities(value, adapter) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(name => !mountCapabilityNames.includes(name))) {
    throw new TypeError('Storage mounts require a capabilities object containing only supported write capabilities.');
  }
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') throw new TypeError(`Storage mount capability ${name} must be boolean.`);
    if (enabled && adapter.capabilities[name] !== true) {
      throw new TypeError(`Storage mount capability ${name} cannot exceed its storage instance.`);
    }
  }
  const restricted = Object.fromEntries(mountCapabilityNames.map(name => [name, value[name] === true]));
  if (restricted.atomicReplace && !restricted.replace) {
    throw new TypeError('Storage mount atomicReplace requires replace.');
  }
  return Object.freeze({ ...adapter.capabilities, ...restricted });
}

function syntheticEntry(path) {
  return { name: baseName(path), kind: 'directory', size: null, version: null, synthetic: true };
}

export class VirtualFileSystem {
  #registry;
  #mounts = new Map();
  #mountRevision = 0;

  constructor(registry) { this.#registry = registry; }

  mount(definition, { deferred = false } = {}) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)
      || Object.keys(definition).some(name => !['path', 'instanceId', 'root', 'capabilities'].includes(name))) {
      throw new TypeError('Storage mount configuration is invalid.');
    }
    let { path, instanceId, root = '/', capabilities } = definition;
    path = normalizePath(path);
    root = normalizePath(root);
    const adapter = deferred && !this.#registry.hasInstance(instanceId) ? null : this.#registry.getInstance(instanceId);
    if (this.#mounts.has(path)) throw new StorageError('already-exists', 'The virtual mount path already exists.');
    if (adapter) mountCapabilities(capabilities, adapter);
    else mountCapabilities(capabilities, { capabilities: Object.fromEntries(mountCapabilityNames.map(name => [name, true])) });
    this.#mounts.set(path, Object.freeze({ path, instanceId, root, capabilities: Object.freeze({ ...capabilities }) }));
    this.#mountRevision++;
  }

  resolve(path) {
    path = normalizePath(path);
    const mount = [...this.#mounts.values()].filter((item) => isWithin(path, item.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!mount) throw new StorageError('not-found', 'No storage mount resolves the virtual path.');
    const adapter = this.#registry.getInstance(mount.instanceId);
    return { adapter, capabilities: mountCapabilities(mount.capabilities, adapter), mount,
      path: joinPath(mount.root, path.slice(mount.path === '/' ? 1 : mount.path.length)) };
  }

  #overlays(path) {
    const entries = new Map();
    for (const mount of this.#mounts.values()) {
      if (mount.path !== path && isWithin(mount.path, path)) {
        const name = mount.path.slice(path === '/' ? 1 : path.length + 1).split('/')[0];
        entries.set(name, syntheticEntry(joinPath(path, name)));
      }
    }
    return entries;
  }

  async stat(path, options = {}) {
    checkAbort(options.signal);
    path = normalizePath(path);
    if (this.#overlays(path).size && !this.#mounts.has(path)) return syntheticEntry(path);
    const resolved = this.resolve(path);
    return { ...await resolved.adapter.stat(resolved.path, options), name: baseName(path) };
  }

  // No partial result escapes this method. Consumers must finish enumeration before deleting old records.
  async list(path, options = {}) {
    checkAbort(options.signal);
    path = normalizePath(path);
    const mountRevision = this.#mountRevision;
    const overlays = this.#overlays(path);
    let resolved;
    try { resolved = this.resolve(path); }
    catch (error) { if (!overlays.size || error.code !== 'not-found') throw error; }
    if (resolved && overlays.size && !this.#mounts.has(path)) {
      try {
        if ((await resolved.adapter.stat(resolved.path, options)).kind !== 'directory') resolved = null;
      } catch (error) { if (error.code === 'not-found') resolved = null; else throw error; }
    }
    const entries = new Map();
    let snapshot;
    let consistency = 'snapshot';
    let deletionSafe = Boolean(resolved && resolved.capabilities.directorySnapshot === true && overlays.size === 0);
    if (resolved) {
      const cursors = new Set();
      let cursor = null;
      let complete = false;
      for (let pageCount = 0; pageCount < (options.maxPages ?? 100000); pageCount++) {
        checkAbort(options.signal);
        const page = await resolved.adapter.listPage(resolved.path, { ...options, cursor });
        if (!page || !Array.isArray(page.entries) || typeof page.complete !== 'boolean' || typeof page.deletionSafe !== 'boolean') {
          throw new StorageError('invalid-response', 'The storage directory page is invalid.');
        }
        if (pageCount === 0) snapshot = page.snapshot ?? null;
        else if ((page.snapshot ?? null) !== snapshot) throw new StorageError('version-changed', 'The directory changed during enumeration.');
        if (page.consistency !== 'snapshot' || snapshot === null) consistency = 'weak';
        if (page.deletionSafe !== true) deletionSafe = false;
        for (const entry of page.entries) {
          validateName(entry.name);
          if (entries.has(entry.name)) throw new StorageError('incomplete-listing', 'The directory enumeration repeated an entry.');
          if (!['file', 'directory'].includes(entry.kind)) throw new StorageError('invalid-response', 'The directory entry has an invalid kind.');
          entries.set(entry.name, entry);
        }
        if (page.complete) {
          if (page.nextCursor != null) throw new StorageError('incomplete-listing', 'A completed directory page has a continuation.');
          complete = true;
          break;
        }
        if (page.nextCursor == null || page.entries.length === 0) throw new StorageError('incomplete-listing', 'The directory enumeration ended prematurely.');
        const cursorKey = JSON.stringify(page.nextCursor);
        if (cursors.has(cursorKey)) throw new StorageError('incomplete-listing', 'The directory enumeration repeated a cursor.');
        cursors.add(cursorKey);
        cursor = page.nextCursor;
      }
      if (!complete) throw new StorageError('incomplete-listing', 'The directory page limit was exceeded.');
    }
    for (const [name, entry] of overlays) entries.set(name, entry);
    checkAbort(options.signal);
    if (mountRevision !== this.#mountRevision) throw new StorageError('version-changed', 'The mount namespace changed during enumeration.');
    deletionSafe = deletionSafe && consistency === 'snapshot' && typeof snapshot === 'string' && snapshot.length > 0;
    return { entries: [...entries.values()], complete: true, consistency, snapshot: snapshot ?? null,
      deletionSafe };
  }

  async openRead(path, options = {}) {
    checkAbort(options.signal);
    path = normalizePath(path);
    if (this.#overlays(path).size) throw new StorageError('is-directory', 'The virtual path is a directory.');
    const resolved = this.resolve(path);
    return resolved.adapter.openRead(resolved.path, options);
  }

  async watch(path, { signal, onChange, onError } = {}) {
    checkAbort(signal);
    path = normalizePath(path);
    if (typeof onChange !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Storage watching requires change and error callbacks.');
    }
    const revision = this.#mountRevision, plans = [];
    try {
      const resolved = this.resolve(path);
      let include = true;
      if (this.#overlays(path).size && !this.#mounts.has(path)) {
        try { include = (await resolved.adapter.stat(resolved.path, { signal })).kind === 'directory'; }
        catch (error) { if (error.code === 'not-found') include = false; else throw error; }
      }
      if (include) plans.push({ virtualPath: path, ...resolved });
    }
    catch (error) { if (!this.#overlays(path).size || error.code !== 'not-found') throw error; }
    for (const mount of this.#mounts.values()) if (mount.path !== path && isWithin(mount.path, path)) {
      plans.push({ virtualPath: mount.path, ...this.resolve(mount.path) });
    }
    for (const plan of plans) requireCapability(plan, 'watch');
    const handles = [];
    let closed = false, closing;
    const close = () => {
      if (closing) return closing;
      closed = true;
      signal?.removeEventListener('abort', abort);
      return closing = (async () => {
        const results = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.close())));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Storage watches failed to close.');
      })();
    };
    const report = error => {
      if (closed) return;
      try { void Promise.resolve(onError(error)).catch(() => {}); }
      catch { /* Error reporting cannot escape a watch callback. */ }
    };
    const abort = () => { void close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (const plan of plans) {
        checkAbort(signal);
        const handle = await plan.adapter.watch(plan.path, { signal, onError: report, onChange: event => {
          if (closed) return;
          try {
            if (revision !== this.#mountRevision) throw new StorageError('version-changed', 'The mount namespace changed during watching.');
            if (!event || !['change', 'rename'].includes(event.type)) throw new StorageError('invalid-response', 'The storage watch event is invalid.');
            const source = normalizePath(event.path);
            if (!isWithin(source, plan.path)) throw new StorageError('invalid-response', 'The storage watch event escaped its directory.');
            const target = joinPath(plan.virtualPath, source.slice(plan.path === '/' ? 1 : plan.path.length));
            // Parent backends cannot report changes hidden behind a child mount.
            if (this.resolve(target).mount !== plan.mount) return;
            void Promise.resolve(onChange(Object.freeze({ path: target, type: event.type }))).catch(report);
          } catch (error) { report(error); }
        } });
        if (!handle || typeof handle.close !== 'function') throw new StorageError('invalid-response', 'The storage watch handle is invalid.');
        if (closed || signal?.aborted) { await handle.close(); checkAbort(signal); throw new StorageError('closed', 'The storage watch is closed.'); }
        handles.push(handle);
      }
      if (revision !== this.#mountRevision) throw new StorageError('version-changed', 'The mount namespace changed during watching.');
      return Object.freeze({ close });
    } catch (error) { await close().catch(() => {}); throw error; }
  }

  #writable(path, capability) {
    path = normalizePath(path);
    if (this.#mounts.has(path) || this.#overlays(path).size) {
      throw new StorageError('permission-denied', 'Mount directories cannot be changed by file operations.');
    }
    const resolved = this.resolve(path);
    requireCapability(resolved, capability);
    return resolved;
  }

  resolveFileHandle(path, flags = 'r') {
    if (!['r', 'r+', 'rs', 'rs+', 'w', 'wx', 'w+', 'wx+', 'a', 'ax', 'a+', 'ax+', 'as', 'as+'].includes(flags)) {
      throw new TypeError('Unsupported storage file open flags.');
    }
    const capabilities = flags.startsWith('r') ? (flags.includes('+') ? ['replace'] : [])
      : flags.includes('x') ? ['create'] : ['create', 'replace'];
    if (!capabilities.length) {
      path = normalizePath(path);
      if (this.#overlays(path).size) throw new StorageError('is-directory', 'The virtual path is a directory.');
      return this.resolve(path);
    }
    const resolved = this.#writable(path, capabilities[0]);
    for (const capability of capabilities.slice(1)) requireCapability(resolved, capability);
    return resolved;
  }

  async write(path, data, options = {}) {
    checkAbort(options.signal);
    const capabilities = options.overwrite === false ? ['create']
      : options.ifMatch !== undefined ? ['replace'] : ['create', 'replace'];
    if (options.ifMatch !== undefined) capabilities.push('conditionalWrite');
    if (options.atomic === true) capabilities.push('atomicReplace');
    const resolved = this.#writable(path, capabilities[0]);
    for (const capability of capabilities.slice(1)) requireCapability(resolved, capability);
    return resolved.adapter.write(resolved.path, data, options);
  }

  async mkdir(path, options = {}) {
    checkAbort(options.signal);
    const resolved = this.#writable(path, 'mkdir');
    return resolved.adapter.mkdir(resolved.path, options);
  }

  async delete(path, options = {}) {
    checkAbort(options.signal);
    const resolved = this.#writable(path, 'delete');
    if (options.ifMatch !== undefined) requireCapability(resolved, 'conditionalWrite');
    return resolved.adapter.delete(resolved.path, options);
  }

  async rename(path, destination, options = {}) {
    checkAbort(options.signal);
    const source = this.#writable(path, 'rename');
    const target = this.#writable(destination, 'rename');
    if (source.mount !== target.mount) throw new StorageError('not-supported', 'Renaming across storage mounts is not supported.');
    if (options.overwrite === true) requireCapability(target, 'replace');
    if (options.ifMatch !== undefined) requireCapability(source, 'conditionalWrite');
    return source.adapter.rename(source.path, target.path, options);
  }

  capabilities(path) { return this.resolve(path).capabilities; }
}
