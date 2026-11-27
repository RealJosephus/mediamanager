import path from 'node:path';
import { availableParallelism } from 'node:os';
import { NativeLruCache } from '../core/native-lru.js';
import { decodeNativeText } from '../core/native-text.js';
import { clrTrim } from '../metadata/whitespace.js';
import { NativeIgnoreRules } from './ignore-rules.js';
import { nativePathKey, nativePathWithin } from './native-path.js';

const pathApi = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value) ? path.win32 : path.posix;

export class DotIgnoreRule {
  #defaultFileAccess;
  #libraryRoots;
  #recordingRoots = new Set();
  constructor({ vfs, identityMap, fileAccess, getLibraryRoots = () => [], processorCount = availableParallelism(), normalizePath = process.platform === 'win32' }) {
    if (!fileAccess && (!vfs || !identityMap)) throw new TypeError('Ignore rules require an explicit file reader.');
    Object.assign(this, { vfs, identityMap, getLibraryRoots, processorCount, normalizePath });
    this.#defaultFileAccess = !fileAccess;
    this.fileAccess = fileAccess ?? {
      info: (identityPath, signal) => this.#mappedFileInfo(identityPath, signal),
      openRead: (info, options) => this.vfs.openRead(info.accessPath, options),
    };
    const capacity = Math.max(100, processorCount * 100);
    this.directoryCache = new NativeLruCache(capacity);
    this.rulesCache = new NativeLruCache(Math.max(32, Math.trunc(capacity / 4)));
  }

  clearDirectoryCache() {
    this.#libraryRoots = undefined;
    this.directoryCache = new NativeLruCache(this.directoryCache.capacity);
  }
  async #configuredRoots() {
    const pending = this.#libraryRoots ??= Promise.resolve(this.getLibraryRoots())
      .then(roots => new Set(roots.filter(Boolean).map(nativePathKey)));
    try { return await pending; }
    catch (error) {
      if (this.#libraryRoots === pending) this.#libraryRoots = undefined;
      throw error;
    }
  }
  setRecordingRoots(roots) {
    const next = new Set(roots.map(nativePathKey));
    if (next.size === this.#recordingRoots.size && [...next].every(root => this.#recordingRoots.has(root))) return;
    this.#recordingRoots = next;
    this.clearDirectoryCache();
  }
  clone() {
    const rule = new DotIgnoreRule({ ...this,
      fileAccess: this.#defaultFileAccess ? undefined : this.fileAccess });
    rule.directoryCache = this.directoryCache.clone();
    rule.#libraryRoots = this.#libraryRoots;
    rule.rulesCache = this.rulesCache.clone();
    rule.#recordingRoots = this.#recordingRoots;
    return rule;
  }

  async #mappedFileInfo(identityPath, signal) {
    const api = pathApi(identityPath);
    let accessPath;
    try {
      accessPath = this.identityMap.resolve({ identityPath, style: api === path.win32 ? 'windows' : 'posix' });
      this.vfs.resolve(accessPath);
    } catch (error) {
      if (error.code !== 'not-found') throw error;
      return { mapped: false, entry: null, accessPath: null };
    }
    try { return { mapped: true, entry: await this.vfs.stat(accessPath, { signal }), accessPath }; }
    catch (error) {
      if (error.code !== 'not-found') throw error;
      return { mapped: true, entry: null, accessPath };
    }
  }

  async #findIgnoreFile(directory, signal) {
    const cache = this.directoryCache;
    const cached = cache.get(directory);
    if (cached) return cached;
    const api = pathApi(directory), checked = [directory];
    const roots = await this.#configuredRoots();
    let stopDirectory;
    for (let current = directory; roots.size; current = api.dirname(current)) {
      if (roots.has(nativePathKey(current))) stopDirectory = current;
      if (api.dirname(current) === current) break;
    }
    let complete = true, recordingRoot;
    const finish = (ignoreFile, known = complete, cacheRoot) => {
      const entry = { ignoreFile, complete: known };
      // Unknown mappings do not establish a cached native absence.
      if (known) for (const current of checked) {
        if (!cacheRoot || nativePathWithin(current, cacheRoot)) cache.set(current, entry);
      }
      return entry;
    };
    for (let current = directory;; current = api.dirname(current)) {
      if (current !== directory) {
        const parentCached = cache.get(current);
        if (parentCached) return finish(parentCached.ignoreFile, complete && parentCached.complete);
      }
      const ignoreFile = api.join(current, '.ignore');
      const info = await this.fileAccess.info(ignoreFile, signal);
      // A registered recording library can be bounded by application storage.
      // Keep reading mapped ancestors when an administrator supplied them.
      if (recordingRoot && !info.mapped) return finish(null, complete, recordingRoot);
      complete &&= info.mapped;
      if (info.mapped && this.#recordingRoots.has(nativePathKey(current))) recordingRoot ??= current;
      if (info.entry?.kind === 'file') return finish(ignoreFile);
      if (current !== directory) checked.push(current);
      if (current === stopDirectory || api.dirname(current) === current) return finish(null);
    }
  }

  async #getParsedRules(ignoreFile, signal) {
    const info = await this.fileAccess.info(ignoreFile, signal);
    if (!info.mapped || info.entry?.kind !== 'file') {
      this.rulesCache.delete(ignoreFile);
      return { rules: null, complete: info.mapped };
    }
    const { entry } = info;
    const cached = this.rulesCache.get(ignoreFile);
    if (cached && entry.modified != null && entry.size != null
      && cached.modified === entry.modified && cached.size === entry.size) return { rules: cached.rules, complete: true };
    if (cached) this.rulesCache.delete(ignoreFile);
    let rules;
    if (entry.size === 0n) rules = new NativeIgnoreRules([]);
    else {
      const handle = await this.fileAccess.openRead(info, { signal }), parts = [];
      try { for await (const bytes of handle.stream) parts.push(Buffer.from(bytes)); }
      finally { await handle.close(); }
      const text = decodeNativeText(Buffer.concat(parts));
      rules = new NativeIgnoreRules(clrTrim(text) ? text.split('\n').map(clrTrim).filter(Boolean) : []);
    }
    this.rulesCache.set(ignoreFile, { modified: entry.modified, size: entry.size, rules });
    return { rules, complete: true };
  }

  async check(identityPath, { isDirectory = false, signal } = {}) {
    const api = pathApi(identityPath);
    const directory = isDirectory ? identityPath : api.dirname(identityPath);
    const found = await this.#findIgnoreFile(directory, signal);
    if (!found.ignoreFile) return { ignored: false, complete: found.complete };
    const parsed = await this.#getParsedRules(found.ignoreFile, signal);
    if (!parsed.rules) {
      // Invalidate this lookup only, retaining the native intermediate entries.
      this.directoryCache.delete(directory);
      return { ignored: false, complete: found.complete && parsed.complete };
    }
    return { ignored: parsed.rules.isIgnored(identityPath, { isDirectory, normalizePath: this.normalizePath }),
      complete: found.complete && parsed.complete };
  }

  async shouldIgnore(identityPath, options) {
    const result = await this.check(identityPath, options);
    if (!result.complete) throw Object.assign(new Error('The ignore search includes an unmapped ancestor path.'), {
      status: 501, code: 'ignore-search-unmapped'
    });
    return result.ignored;
  }
}
