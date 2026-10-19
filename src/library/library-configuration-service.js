import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeNativeText } from '../core/native-text.js';
import { clrTrim } from '../metadata/whitespace.js';
import { idKey, libraryError } from './records.js';
import { nativeContainsSubPath, nativeFileNameWithoutExtension } from './native-path.js';
import { nativeFileSystemPathsEqual } from './root-folder-file-data.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { randomUUID } from 'node:crypto';
import { parseCollectionTypeOption } from './collection-type-options.js';

const contained = (root, candidate) => {
  const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(candidate));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const absent = error => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'not-found', 'not-directory',
  'unmapped-path', 'invalid-path', 'permission-denied', 'authentication-required'].includes(error?.code);
const unsafeLink = error => error?.details?.reason === 'link' || error?.cause?.details?.reason === 'link';
const linkFailure = error => Object.assign(libraryError(501, 'Library configuration must not traverse symbolic links or junctions.'), { cause: error });
const validLibrarySegment = name => typeof name === 'string' && clrTrim(name) !== ''
  && !/[\0\\/:]/u.test(name) && name !== '.' && name !== '..' && !/[. ]$/u.test(name);

/** Native library configuration files are instance state; media existence is
 * observed exclusively through the configured state/VFS asset source. */
export class LibraryConfigurationService {
  #tail = Promise.resolve();
  #closed = false;
  #background = new Set();
  #collectionOperations = new Map();
  #closing;
  constructor({ programDataPath, optionsStore, configuration = {}, configurationStore, mediaAssets,
    lifecycle, monitor, host, refreshes, refreshQueue = () => new Set(), queueLibraryScan,
    invalidateDirectory = () => {}, sleep = delay, fileSystem, runBackground = operation => Promise.resolve().then(operation),
    admitMetadataDrain = () => ({ run: operation => operation(), release() {} }), onError = () => {} } = {}) {
    if (!path.isAbsolute(programDataPath ?? '') || !optionsStore || !mediaAssets || !lifecycle || !monitor || !host
      || typeof queueLibraryScan !== 'function') throw new TypeError('Library configuration requires instance state, VFS access and top-level lifecycle owners.');
    Object.assign(this, { programDataPath: path.resolve(programDataPath), optionsStore, configuration, configurationStore,
      mediaAssets, lifecycle, monitor, host, refreshes, refreshQueue, queueLibraryScan, invalidateDirectory, sleep, fileSystem, runBackground, admitMetadataDrain, onError });
    this.root = path.join(this.programDataPath, 'root', 'default');
    this.locationComparer = new Intl.Collator(undefined, { sensitivity: 'variant' });
  }
  #enqueue(operation) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Library configuration is closing.'));
    let admission;
    try { admission = this.admitMetadataDrain(); }
    catch (error) { return Promise.reject(error); }
    return admission.run(() => this.#append(operation)).finally(() => admission.release());
  }
  #append(operation) {
    const result = this.#tail.then(operation); this.#tail = result.catch(() => {}); return result;
  }
  admitCollectionOperation() {
    if (this.#closed) throw libraryError(503, 'Library configuration is closing.');
    const metadataAdmission = this.admitMetadataDrain();
    const completion = Promise.withResolvers();
    const entry = { pending: 0, released: false, completion: completion.promise };
    const finish = () => {
      if (!entry.released || entry.pending) return;
      this.#collectionOperations.delete(admission); metadataAdmission.release(); completion.resolve();
    };
    const admission = Object.freeze({
      addVirtualFolder: (name, collectionType, options, refreshLibrary = false) => {
        if (entry.released) return Promise.reject(libraryError(503, 'Collection configuration admission is released.'));
        entry.pending++;
        return metadataAdmission.run(() => this.#append(() => this.#addVirtualFolder(name, collectionType, options, refreshLibrary)))
          .finally(() => { entry.pending--; finish(); });
      },
      release: () => {
        entry.released = true; finish();
      }
    });
    this.#collectionOperations.set(admission, entry);
    return admission;
  }
  async #statePath(filename) {
    try { return await this.#resolveStatePath(filename); }
    catch (error) { if (unsafeLink(error)) throw linkFailure(error); throw error; }
  }
  async #resolveStatePath(filename) {
    if (!path.isAbsolute(filename) || !contained(this.root, filename)) throw libraryError(501, 'Library configuration must remain in the isolated libraries root.');
    const stateRoot = await this.fileSystem.realpath(this.programDataPath);
    const libraryRoot = await this.fileSystem.realpath(this.root).catch(error => {
      if (error.code === 'ENOENT') return path.join(stateRoot, 'root', 'default'); throw error;
    });
    if (!contained(stateRoot, libraryRoot)) throw libraryError(501, 'The libraries root escapes the isolated instance.');
    let ancestor = filename;
    while (true) {
      try {
        const actual = await this.fileSystem.realpath(ancestor);
        if (!contained(stateRoot, actual) || contained(this.root, ancestor) && !contained(libraryRoot, actual)) throw libraryError(501, 'Library configuration traverses an external link or junction.');
        return filename;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code) || ancestor === this.programDataPath) throw error;
        try {
          // realpath reports ENOENT for a dangling link even though the link
          // itself exists.  Do not treat that as a missing path component:
          // the next write would otherwise follow it outside instance state.
          await this.fileSystem.lstat(ancestor);
          throw libraryError(501, 'Library configuration traverses an unresolved link or reparse point.');
        } catch (linkError) {
          if (!['ENOENT', 'ENOTDIR'].includes(linkError.code)) throw linkError;
        }
        ancestor = path.dirname(ancestor);
      }
    }
  }
  initialize() { return this.#enqueue(async () => {
    await this.fileSystem.mkdir(await this.#statePath(this.root), { recursive: true });
    await this.#statePath(this.root);
  }); }
  async #directoryExists(filename) {
    try { return (await this.fileSystem.stat(filename)).isDirectory(); }
    catch (error) { if (absent(error)) return false; throw error; }
  }
  async #mediaDirectoryExists(identity) {
    if (typeof identity !== 'string' || !identity || identity.includes('\0')) return false;
    try { return (await this.mediaAssets.stat(identity)).kind === 'directory'; }
    catch (error) { if (absent(error)) return false; throw error; }
  }
  async #fileExists(filename) {
    try { return (await this.fileSystem.stat(await this.#statePath(filename))).isFile(); }
    catch (error) { if (absent(error)) return false; throw error; }
  }
  async #virtualDirectory(name) {
    if (typeof name !== 'string' || clrTrim(name) === '' || /[\0\\/:]/u.test(name)
      || name === '.' || name === '..' || /[. ]$/u.test(name)) {
      throw libraryError(404, 'The media collection does not exist.');
    }
    return this.#statePath(path.join(this.root, name));
  }
  async #resolveShortcut(filename) {
    const raw = decodeNativeText(await this.fileSystem.readFile(await this.#statePath(filename)));
    const identity = /[\\/]$/u.test(raw) && raw.length > imagePathApi(raw).parse(raw).root.length ? raw.slice(0, -1) : raw;
    return this.optionsStore.expandPath(identity);
  }
  async *#shortcutFiles(directory, recursive = false) {
    const pending = [{ directory, ancestors: new Set() }];
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index]; let current, actual, files;
      try {
        current = await this.#statePath(entry.directory);
        actual = await this.fileSystem.realpath(current);
        files = await this.fileSystem.readdir(current, { withFileTypes: true });
      } catch (error) {
        if (unsafeLink(error)) throw linkFailure(error);
        if (['EACCES', 'EPERM', 'permission-denied'].includes(error?.code)) continue;
        throw error;
      }
      if (entry.ancestors.has(actual)) throw libraryError(501, 'Library shortcut traversal contains a directory cycle.');
      const ancestors = new Set(entry.ancestors); ancestors.add(actual);
      for (const file of files) {
        const filename = path.join(current, file.name);
        let isDirectory = file.isDirectory();
        if (file.isSymbolicLink()) {
          try { isDirectory = await this.#directoryExists(await this.#statePath(filename)); }
          catch (error) { if (['EACCES', 'EPERM', 'permission-denied'].includes(error?.code)) continue; throw error; }
        }
        if (isDirectory) { if (recursive) pending.push({ directory: filename, ancestors }); }
        else if (/\.mblink$/iu.test(file.name)) yield filename;
      }
    }
  }
  async #syncLibraryOptionsToLocations(directory, options) {
    const root = await this.host.getUserRootFolder();
    return this.host.withCachedChildren(root, async children => {
    const locations = [];
    for await (const filename of this.#shortcutFiles(directory)) {
      try { locations.push(await this.#resolveShortcut(filename)); }
      catch (error) { try { this.onError(error); } catch { /* Reporting cannot change location synchronization. */ } }
    }
    locations.sort(this.locationComparer.compare);
    const item = await children.firstByPath(directory);
    if (item) await this.optionsStore.bind(item.Id, directory);
    if (locations.length > 0 && locations.length !== options.PathInfos.length) {
      const infos = [...options.PathInfos];
      for (const location of locations) if (!infos.some(info => info.Path === location)) infos.push({ Path: location });
      options.PathInfos = infos;
    }
    });
  }
  async #removeContentTypeOverrides(identity) {
    const values = this.configuration.ContentTypes === undefined ? [] : this.configuration.ContentTypes;
    const remove = values.filter(entry => entry.Name == null || clrTrim(entry.Name) === ''
      || nativeFileSystemPathsEqual(identity, entry.Name) || nativeContainsSubPath(entry.Name, identity));
    if (!remove.length) return;
    if (!this.configurationStore) throw libraryError(501, 'Native server configuration persistence is unavailable.');
    const matches = entry => entry.Name == null || clrTrim(entry.Name) === ''
      || nativeFileSystemPathsEqual(identity, entry.Name) || nativeContainsSubPath(entry.Name, identity);
    await this.configurationStore.updateContentTypes(entries => entries.filter(entry => !matches(entry)));
  }
  async #shortcut(directory, info) {
    let basename = nativeFileNameWithoutExtension(info.Path), filename = path.join(directory, basename + '.mblink');
    while (await this.#fileExists(filename)) { basename += '1'; filename = path.join(directory, basename + '.mblink'); }
    const target = this.optionsStore.reversePath(info.Path);
    // Exclusive creation also prevents a link introduced after #statePath
    // validation from being followed by the final write.
    await this.fileSystem.writeFile(await this.#statePath(filename), target, { flag: 'wx' });
    await this.invalidateDirectory(filename);
    await this.#removeContentTypeOverrides(info.Path);
  }
  #startScanInBackground() {
    if (this.lifecycle.isScanRunning) return;
    this.#runInBackground(() => this.queueLibraryScan());
  }
  #runInBackground(operation) {
    const task = Promise.resolve().then(() => this.runBackground(operation)).catch(error => {
      try { this.onError(error); } catch { /* Background reporting cannot undo the configured library. */ }
    }).finally(() => this.#background.delete(task));
    this.#background.add(task);
  }
  #finishPathChange(refreshLibrary) {
    this.#runInBackground(async () => {
      if (refreshLibrary) await this.queueLibraryScan();
      else { await this.sleep(1000); await this.monitor.start(); }
    });
  }
  addVirtualFolder(name, collectionType, options, refreshLibrary = false) {
    return this.#enqueue(() => this.#addVirtualFolder(name, collectionType, options, refreshLibrary));
  }
  async #addVirtualFolder(name, collectionType, options, refreshLibrary) {
    if (typeof name !== 'string' || clrTrim(name) === '') throw libraryError(400, 'The library name is required.');
    name = clrTrim(name).replace(/["<>|\x00-\x1f:*?\\/]/gu, ' ');
    const original = name; let number = 1, directory = path.join(this.root, name);
    while (await this.#directoryExists(directory)) { name = original + ++number; directory = path.join(this.root, name); }
    // Library directory names are part of the transferable instance state.
    // Reject names whose file namespace cannot be reopened by a supported
    // target platform, before publishing options or changing any files.
    if (clrTrim(name) === '' || /[. ]$/u.test(name)) throw libraryError(400, 'The library name must be portable across supported platforms.');
    const pathInfos = options.PathInfos;
    if (pathInfos != null) for (const info of pathInfos) {
      if (!await this.#mediaDirectoryExists(info.Path)) throw libraryError(400, 'The specified media path does not exist.');
    }
    await this.#statePath(directory);
    await this.monitor.stop();
    try {
      await this.fileSystem.mkdir(await this.#statePath(directory), { recursive: true });
      if (collectionType != null) await this.fileSystem.writeFile(await this.#statePath(path.join(directory,
        String(collectionType).toLowerCase() + '.collection')), '', { flag: 'wx' });
      await this.optionsStore.save(directory, options);
      if (pathInfos != null) for (const info of pathInfos) {
        if (typeof info.Path !== 'string' || clrTrim(info.Path) === '') throw libraryError(400, 'A media path is required.');
        if (!await this.#mediaDirectoryExists(info.Path)) throw libraryError(404, 'The media path does not exist.');
        await this.#shortcut(directory, info);
      }
      await this.invalidateDirectory(directory);
    } finally {
      await this.lifecycle.validateTopLibraryFolders();
      if (refreshLibrary) this.#startScanInBackground();
      else { await this.sleep(1000); await this.monitor.start(); }
    }
  }
  addMediaPath(name, info) {
    return this.#enqueue(() => this.#addMediaPath(name, info));
  }
  async #addMediaPath(name, info) {
    if (info == null || typeof info.Path !== 'string' || clrTrim(info.Path) === '') throw libraryError(400, 'A media path is required.');
    if (!await this.#mediaDirectoryExists(info.Path)) throw libraryError(404, 'The media path does not exist.');
    const directory = await this.#virtualDirectory(name);
    await this.#shortcut(directory, info);
    const options = await this.optionsStore.get(directory);
    options.PathInfos = [...options.PathInfos, info];
    await this.#syncLibraryOptionsToLocations(directory, options);
    await this.optionsStore.save(directory, options);
  }
  addMediaPathFromRequest(request, refreshLibrary = false) {
    return this.#enqueue(async () => {
      await this.monitor.stop();
      try {
        const info = request.PathInfo ?? (request.Path != null ? { Path: request.Path } : null);
        if (info == null) throw libraryError(400, "PathInfo and Path can't both be null.");
        await this.#addMediaPath(request.Name, info);
      } finally { this.#finishPathChange(refreshLibrary); }
    });
  }
  updateMediaPath(name, info) {
    return this.#enqueue(async () => {
      if (info == null) throw libraryError(400, 'A media path is required.');
      const directory = await this.#virtualDirectory(name), options = await this.optionsStore.get(directory);
      // The native manager only uses the supplied value for its null gate.
      await this.#syncLibraryOptionsToLocations(directory, options);
      await this.optionsStore.save(directory, options);
    });
  }
  removeMediaPath(name, mediaPath) {
    return this.#enqueue(() => this.#removeMediaPath(name, mediaPath));
  }
  async #removeMediaPath(name, mediaPath) {
    if (typeof mediaPath !== 'string' || mediaPath === '') throw libraryError(400, 'A media path is required.');
    const directory = await this.#virtualDirectory(name);
    if (!await this.#directoryExists(directory)) throw libraryError(404, 'The media collection does not exist.');
    for await (const filename of this.#shortcutFiles(directory, true)) {
      if (ordinalIgnoreCaseKey(await this.#resolveShortcut(filename)) !== ordinalIgnoreCaseKey(mediaPath)) continue;
      await this.fileSystem.unlink(await this.#statePath(filename));
      await this.invalidateDirectory(filename);
      break;
    }
    const options = await this.optionsStore.get(directory);
    options.PathInfos = options.PathInfos.filter(info => info.Path !== mediaPath);
    await this.optionsStore.save(directory, options);
  }
  removeMediaPathAndRefresh(name, mediaPath, refreshLibrary = false) {
    return this.#enqueue(async () => {
      if (typeof name !== 'string' || clrTrim(name) === '' || typeof mediaPath !== 'string' || clrTrim(mediaPath) === '') {
        throw libraryError(400, 'The library name and media path are required.');
      }
      await this.monitor.stop();
      try { await this.#removeMediaPath(name, mediaPath); }
      finally { this.#finishPathChange(refreshLibrary); }
    });
  }
  renameVirtualFolder(name, newName, refreshLibrary = false) {
    return this.#enqueue(async () => {
      if (typeof name !== 'string' || clrTrim(name) === '' || typeof newName !== 'string' || clrTrim(newName) === '') {
        throw libraryError(400, 'The current and new library names are required.');
      }
      if (!validLibrarySegment(newName)) return { status: 400, body: 'The new name is not a valid library name.' };
      const newPath = await this.#statePath(path.join(this.root, newName));
      if (!validLibrarySegment(name)) return { status: 404, body: 'The media collection does not exist.' };
      let currentPath = await this.#statePath(path.join(this.root, name));
      if (!await this.#directoryExists(currentPath)) return { status: 404, body: 'The media collection does not exist.' };
      const samePath = ordinalIgnoreCaseKey(currentPath) === ordinalIgnoreCaseKey(newPath);
      if (!samePath && await this.#directoryExists(newPath)) return { status: 409, body: `The media library already exists at ${newPath}.` };
      await this.monitor.stop();
      try {
        if (samePath) {
          const temporary = await this.#statePath(path.join(this.root, randomUUID().replaceAll('-', '')));
          await this.fileSystem.rename(await this.#statePath(currentPath), temporary);
          currentPath = temporary;
        }
        await this.fileSystem.rename(await this.#statePath(currentPath), await this.#statePath(newPath));
      } finally {
        await this.optionsStore.clear();
        if (refreshLibrary) this.#runInBackground(async () => {
          await this.lifecycle.validateTopLibraryFolders({ removeRoot: true });
          const root = await this.host.getUserRootFolder();
          const folder = await this.host.withCachedChildren(root, children => children.firstByPath(newPath));
          await this.host.clearIgnoreRuleCache();
          if (String(folder?.NativeType ?? folder?.Type ?? '').split('.').at(-1) === 'CollectionFolder') {
            await this.host.refreshPhysicalFolders(folder);
          } else await this.queueLibraryScan();
          await this.host.clearIgnoreRuleCache();
        });
        else this.#finishPathChange(false);
      }
      return { status: 204 };
    });
  }
  updateLibraryOptions(id, requested) {
    return this.#enqueue(() => this.host.withCollectionFolder(id, async item => {
      if (!item) return false;
      const directory = await this.#statePath(item.Path), current = await this.optionsStore.bind(item.Id, directory);
      // Keep the initial options during shortcut creation. Duplicate new paths
      // each create their own shortcut; partial failures retain earlier files.
      for (const info of requested.PathInfos) {
        if (current.PathInfos.some(existing => existing.Path === info?.Path)) continue;
        await this.#shortcut(directory, info);
      }
      await this.optionsStore.save(directory, requested);
      return true;
    }));
  }
  removeVirtualFolder(name, refreshLibrary = false) {
    return this.#enqueue(async () => {
      if (typeof name !== 'string' || clrTrim(name) === '') throw libraryError(400, 'The library name is required.');
      const directory = await this.#virtualDirectory(name);
      if (!await this.#directoryExists(directory)) throw libraryError(404, 'The media folder does not exist.');
      await this.monitor.stop();
      try {
        await this.fileSystem.rm(await this.#statePath(directory), { recursive: true });
        await this.invalidateDirectory(directory);
      } finally {
        await this.optionsStore.clear();
        if (refreshLibrary) {
          await this.lifecycle.validateTopLibraryFolders({ removeRoot: true });
          this.#startScanInBackground();
        } else { await this.sleep(1000); await this.monitor.start(); }
      }
    });
  }
  getVirtualFolders(includeRefreshState = false) {
    return this.#enqueue(async () => {
      const root = await this.host.getUserRootFolder();
      return this.host.withCachedChildren(root, async children => {
      const refreshQueue = includeRefreshState ? this.refreshQueue() : null;
      const directories = await this.fileSystem.readdir(await this.#statePath(this.root), { withFileTypes: true });
      const result = [];
      for (const entry of directories) {
        const directory = path.join(this.root, entry.name);
        if (!await this.#directoryExists(directory)) continue;
        await this.#statePath(directory);
        const files = await this.fileSystem.readdir(directory, { withFileTypes: true });
        const locations = []; let collectionType = null;
        for (const file of files) if (!file.isDirectory()) {
          const filename = path.join(directory, file.name);
          if (/\.mblink$/iu.test(file.name)) {
            try {
              locations.push(await this.#resolveShortcut(filename));
            } catch (error) { try { this.onError(error); } catch { /* Reporting cannot change the folder listing. */ } }
          }
          if (collectionType == null && /\.collection$/iu.test(file.name)) collectionType = parseCollectionTypeOption(nativeFileNameWithoutExtension(file.name));
        }
        locations.sort(this.locationComparer.compare);
        const item = await children.firstByPath(directory);
        let options = null, itemId = null, primaryImageItemId = null, progress = null, status = null;
        if (item) {
          itemId = idKey(item.Id); options = await this.optionsStore.bind(item.Id, directory);
          if ((item.ImageInfos ?? []).some(image => image.Type === 'Primary' || image.Type === 0)) primaryImageItemId = itemId;
          if (refreshQueue) {
            progress = this.refreshes?.getRefreshProgress(item.Id) ?? null;
            status = progress != null ? 'Active' : refreshQueue.has(itemId) ? 'Queued' : 'Idle';
          }
        }
        result.push({ Name: entry.name, Locations: locations, CollectionType: collectionType, LibraryOptions: options,
          ItemId: itemId, PrimaryImageItemId: primaryImageItemId, RefreshProgress: progress, RefreshStatus: status });
      }
      return result;
      });
    });
  }
  close() {
    this.#closed = true;
    return this.#closing ??= this.#drain();
  }
  async #drain() {
    // Admitted collections may enqueue their first configuration write after
    // closure starts, so capture the tail only after their admissions release.
    while (this.#collectionOperations.size) await Promise.all([...this.#collectionOperations.values()].map(entry => entry.completion));
    await this.#tail;
    while (this.#background.size) await Promise.all(this.#background);
  }
}
