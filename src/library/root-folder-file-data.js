import path from 'node:path';
import { nativeContainsSubPath, nativeFileName } from './native-path.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { recordInternalFolderResolve } from '../metadata/internal-folder-refresh.js';
import { clearFolderChildIds } from './folder-cache.js';
import { decodeNativeText } from '../core/native-text.js';

// Persisted media identities retain their own path style when the instance is
// moved to another host. Relative paths keep the host DirectoryInfo contract.
const pathApi = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value ?? '') ? path.win32
  : value?.startsWith('/') ? path.posix : process.platform === 'win32' ? path.win32 : path.posix;
const trimEndingSeparator = value => {
  const api = pathApi(value);
  const trailingSeparator = api === path.win32 ? /[\\/]$/u : /\/$/u;
  return trailingSeparator.test(value) && value.length > api.parse(value).root.length ? value.slice(0, -1) : value;
};
export function nativeDirectoryFullName(value) {
  if (value == null) throw Object.assign(new TypeError("Value cannot be null. (Parameter 'path')"),
    { nativeException: 'ArgumentNullException', parameterName: 'path', status: 500 });
  if (value === '' || value.includes('\0')) throw Object.assign(new TypeError("Invalid path. (Parameter 'path')"),
    { nativeException: 'ArgumentException', parameterName: 'path', status: 500 });
  return pathApi(value).resolve(value);
}
export function nativeFileSystemPathsEqual(left, right) {
  if (left == null || right == null || clrTrim(left) === '' || clrTrim(right) === '') return false;
  left = trimEndingSeparator(left); right = trimEndingSeparator(right);
  return pathApi(left) === path.win32 && pathApi(right) === path.win32
    ? ordinalIgnoreCaseKey(left) === ordinalIgnoreCaseKey(right) : left === right;
}

export class RootFolderFileData {
  constructor({ assets, expandPath = value => value, logger = { error() {}, warn() {} } }) {
    if (!assets) throw new TypeError('Root folder resolve args require an instance/VFS asset source.');
    Object.assign(this, { assets, expandPath, logger });
  }
  async directoryInfo(identity) {
    const fullName = nativeDirectoryFullName(identity);
    let exists = false;
    try { exists = (await this.assets.stat(fullName)).kind === 'directory'; }
    catch (error) { if (!['not-found', 'unmapped-path', 'invalid-path'].includes(error.code)) throw error; }
    return { Path: fullName, Name: nativeFileName(trimEndingSeparator(fullName), { windows: pathApi(fullName) === path.win32 }), IsDirectory: true, Exists: exists };
  }
  async filteredEntries(identity, args, flattenDepth) {
    let entries;
    try { entries = await this.assets.list(identity); }
    catch (error) {
      // DirectoryService caches a missing directory as an empty child array.
      if (error.code === 'not-found') entries = [];
      else if (['not-directory', 'ENOTDIR'].includes(error.code)) throw Object.assign(error, { nativeException: 'IOException', status: 500 });
      else throw error;
    }
    const values = new Map();
    for (const entry of entries) {
      const fullName = nativeDirectoryFullName(entry.Path);
      if (pathApi(fullName).extname(fullName).toLowerCase() === '.mblink') {
        try {
          const raw = decodeNativeText(await this.assets.read(fullName));
          const target = this.expandPath(trimEndingSeparator(raw));
          if (target == null || target === '') { this.logger.warn('Encountered invalid shortcut', fullName); continue; }
          const data = await this.directoryInfo(target);
          args.additionalLocations.push(target);
          values.set(ordinalIgnoreCaseKey(target), data);
        } catch (error) { this.logger.error(error, 'Error resolving shortcut'); }
      } else if (flattenDepth > 0 && entry.kind === 'directory') {
        for (const child of await this.filteredEntries(fullName, args, flattenDepth - 1)) values.set(ordinalIgnoreCaseKey(child.Path), child);
      } else values.set(ordinalIgnoreCaseKey(fullName), { Path: fullName, Name: nativeFileName(trimEndingSeparator(fullName), { windows: pathApi(fullName) === path.win32 }),
        IsDirectory: entry.kind === 'directory', Exists: true });
    }
    return [...values.values()];
  }
  async normalizeRootPaths(entries) {
    const paths = [...new Set(entries.filter(entry => entry.IsDirectory).map(entry => trimEndingSeparator(entry.Path)))];
    const selected = paths.filter(value => value.endsWith(':\\') || !paths.some(parent => pathApi(value) === pathApi(parent)
      && nativeContainsSubPath(value, parent, { windows: pathApi(value) === path.win32 })));
    return [...await Promise.all(selected.map(value => this.directoryInfo(value))), ...entries.filter(entry => !entry.IsDirectory)];
  }
  async resolveArgs(item, setLocations = false) {
    if (item.Type === 'AggregateFolder') clearFolderChildIds(item);
    const fileInfo = await this.directoryInfo(item.Path), args = { additionalLocations: [] };
    let files = await this.filteredEntries(fileInfo.Path, args, item.Type === 'AggregateFolder' ? 2 : 0);
    if (item.Type === 'AggregateFolder') files = await this.normalizeRootPaths(files);
    const locations = [fileInfo.Path, ...args.additionalLocations];
    // AggregateFolder and CollectionFolder own the persisted location arrays.
    // The top-level resolver also uses this authoritative directory snapshot
    // for UserRootFolder and prospective physical Folder entities, whose base
    // Folder.CreateResolveArgs has no internal-location state to update.
    if (['AggregateFolder', 'CollectionFolder'].includes(item.Type)) {
      recordInternalFolderResolve(item, locations, setLocations);
    }
    return { locations, files };
  }
}
