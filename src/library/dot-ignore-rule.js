import path from 'node:path';
import { availableParallelism } from 'node:os';
import { NativeLruCache } from '../core/native-lru.js';
import { decodeNativeText } from '../core/native-text.js';
import { clrTrim } from '../metadata/whitespace.js';
import { NativeIgnoreRules } from './ignore-rules.js';

const pathApi = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value) ? path.win32 : path.posix;

export class DotIgnoreRule {
  #defaultFileAccess;
  constructor({ vfs, identityMap, fileAccess, processorCount = availableParallelism(), normalizePath = process.platform === 'win32' }) {
    if (!fileAccess && (!vfs || !identityMap)) throw new TypeError('Ignore rules require an explicit file reader.');
    Object.assign(this, { vfs, identityMap, processorCount, normalizePath });
    this.#defaultFileAccess = !fileAccess;
    this.fileAccess = fileAccess ?? {
      info: (identityPath, signal) => this.#mappedFileInfo(identityPath, signal),
      openRead: (info, options) => this.vfs.openRead(info.accessPath, options),
    };
    const capacity = Math.max(100, processorCount * 100);
    this.directoryCache = new NativeLruCache(capacity);
    this.rulesCache = new NativeLruCache(Math.max(32, Math.trunc(capacity / 4)));
  }

  clearDirectoryCache() { this.directoryCache.clear(); }
  clone() {
    const rule = new DotIgnoreRule({ ...this,
      fileAccess: this.#defaultFileAccess ? undefined : this.fileAccess });
    rule.directoryCache = this.directoryCache.clone();
    rule.rulesCache = this.rulesCache.clone();
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
    const cached = this.directoryCache.get(directory);
    if (cached) return cached;
    const api = pathApi(directory), checked = [directory];
    let complete = true;
    const finish = (ignoreFile, known = complete) => {
      const entry = { ignoreFile, complete: known };
      // Unknown mappings do not establish a cached native absence.
      if (known) for (const current of checked) this.directoryCache.set(current, entry);
      return entry;
    };
    for (let current = directory;; current = api.dirname(current)) {
      if (current !== directory) {
        const parentCached = this.directoryCache.get(current);
        if (parentCached) return finish(parentCached.ignoreFile, complete && parentCached.complete);
      }
      const ignoreFile = api.join(current, '.ignore');
      const info = await this.fileAccess.info(ignoreFile, signal);
      complete &&= info.mapped;
      if (info.entry?.kind === 'file') return finish(ignoreFile);
      if (current !== directory) checked.push(current);
      if (api.dirname(current) === current) return finish(null);
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
