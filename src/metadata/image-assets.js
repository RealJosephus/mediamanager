// Identity-preserving asset access. Both instance metadata and media sidecars use storage plugins.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageFileSystem } from '../storage/files.js';
import { fileURLToPath } from 'node:url';
import { operationFailure } from '../core/operation-failure.js';

export const imagePathApi = value => /^[A-Za-z]:[\\/]|^\\\\|^\/\//.test(value ?? '') ? path.win32 : path.posix;
export function imageIdentityPath(value) {
  if (!/^file:/i.test(value)) return value;
  const url = new URL(value);
  if (/^\/[A-Za-z]:\//.test(url.pathname)) return decodeURIComponent(url.pathname.slice(1)).replaceAll('/', '\\');
  return fileURLToPath(url);
}
const contained = (root, value) => { const relative = path.relative(root, value); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const errorCode = error => { if (error?.code === 'ENOENT') error.code = 'not-found'; else if (['EACCES', 'EPERM'].includes(error?.code)) error.code = 'permission-denied'; return error; };
const modifiedDate = value => {
  const fraction = (value.mtimeNs % 1000000000n + 1000000000n) % 1000000000n;
  const seconds = (value.mtimeNs - fraction) / 1000000000n;
  return new Date(Number(seconds * 1000n)).toISOString().replace('.000Z', `.${String(fraction / 100n).padStart(7, '0')}Z`);
};

async function moveCompleted(vfs, source, target) {
  try { await vfs.stat(source); return false; }
  catch (error) { if (error?.code !== 'not-found') throw error; }
  try { return (await vfs.stat(target)).kind === 'file'; }
  catch (error) { if (error?.code !== 'not-found') throw error; return false; }
}

async function swapStoragePaths(vfs, left, right, signal, readResult) {
  // Sibling renames also work on backends that cannot move files between
  // directories. The last rename consumes the staged file.
  const staged = path.posix.join(path.posix.dirname(left), '.image-swap-' + randomUUID());
  signal?.throwIfAborted();
  const move = (source, target) => vfs.rename(source, target, { overwrite: false });
  const undo = [], errors = [];
  const completed = async (source, target) => {
    try { return await moveCompleted(vfs, source, target); }
    catch (error) { errors.push(error); return false; }
  };
  try {
    for (const [source, target] of [[left, staged], [right, left], [staged, right]]) {
      try { await move(source, target); }
      catch (error) {
        errors.push(error);
        // A lost response can follow a completed rename. Include that move
        // in recovery when the backend confirms where the file ended up.
        if (await completed(source, target)) undo.push([target, source]);
        throw error;
      }
      undo.push([target, source]);
    }
    return await readResult();
  } catch (error) { if (!errors.length) errors.push(error); }
  while (undo.length) {
    const [source, target] = undo.pop();
    try { await move(source, target); }
    catch (error) {
      errors.push(error);
      if (!await completed(source, target)) break;
    }
  }
  // If undo failed, the sibling can still hold the only copy of an image.
  throw operationFailure(errors, 'Image swap or recovery failed.');
}

export class MetadataImageAssets {
  #options;
  constructor(options) {
    const { fileSystem, vfs, identityMap } = options;
    this.#options = options;
    Object.assign(this, { fileSystem: fileSystem ?? (vfs && identityMap ? new StorageFileSystem({vfs,identityMap}) : undefined), vfs, identityMap });
  }
  get metadataPath() { const value = this.#options.metadataPath; return value && path.resolve(value); }
  get stateRoots() { return (this.#options.stateRoots ?? []).map(value => path.resolve(value)); }
  #roots() { return [this.metadataPath, ...this.stateRoots]; }
  withMetadataPath(metadataPath) {
    // A save can select a new instance root while retaining the already loaded
    // item's media mapping and outstanding access to its previous state files.
    const scoped = new MetadataImageAssets({ fileSystem: this.fileSystem, vfs: this.vfs,
      identityMap: this.identityMap, metadataPath,
      stateRoots: [this.metadataPath, ...this.stateRoots].filter(Boolean) });
    scoped.scope = this.scope;
    scoped.source = this.source;
    return scoped;
  }
  forItem(item, accessPath) {
    const scoped = new MetadataImageAssets(this), api = imagePathApi(item.Path);
    scoped.#options = this.#options;
    if (!item.Path || !accessPath) return scoped;
    if (item.Type === 'Photo') scoped.source = { identity: item.Path, accessPath };
    const directory = item.IsFolder || ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'MusicArtist'].includes(item.Type) || ['Dvd', 'BluRay'].includes(item.VideoType) && !item.IsPlaceHolder;
    scoped.scope = { identity: directory ? item.Path : api.dirname(item.Path), access: directory ? accessPath : path.posix.dirname(accessPath), api };
    return scoped;
  }
  async resolve(identity, options) {
    return this.#resolve(identity, options, this.#roots());
  }
  async #resolve(identity, options, roots) {
    try { return await this.#location(identity, options, roots); } catch (error) { throw errorCode(error); }
  }
  async #location(identity, { literalIdentity = false } = {}, roots) {
    // NFO file URIs are Windows DirectoryService lookup literals. They must
    // neither decode into a different identity nor enter the VFS identity map.
    if (literalIdentity) throw Object.assign(new Error('A literal image identity has no VFS mapping.'), { code: 'unmapped-path', path: identity });
    identity = imageIdentityPath(identity);
    if (this.source?.identity === identity) return { identity, accessPath: this.source.accessPath };
    const stateOwned = roots.some(root => root && contained(root, path.resolve(identity)));
    try { if (!stateOwned && this.identityMap) return { accessPath: this.identityMap.resolve({ identityPath: identity, style: imagePathApi(identity) === path.win32 ? 'windows' : 'posix' }), identity }; }
    catch (error) { if (error?.code !== 'not-found') throw error; }
    if (!stateOwned && this.scope) {
      const relative = this.scope.api.relative(this.scope.identity, identity);
      if (relative === '' || relative !== '..' && !relative.startsWith(`..${this.scope.api.sep}`) && !this.scope.api.isAbsolute(relative)) {
        return { identity, accessPath: path.posix.join(this.scope.access, relative.replaceAll('\\', '/')) };
      }
    }
    const target = path.resolve(identity);
    const stateRoot = roots.find(root => root && contained(root, target));
    if (!stateRoot) throw Object.assign(new Error('Image asset has no VFS mapping or instance metadata location.'), { code: 'unmapped-path', path: identity });
    // Existing links must not turn the state-root permission into arbitrary host-file access.
    let ancestor = target;
    while (true) {
      try { const actual = await this.fileSystem.realpath(ancestor); if (!contained(stateRoot, actual)) throw Object.assign(new Error('Metadata image path escapes its state root.'), { code: 'permission-denied' }); break; }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // A dangling link exists even though realpath cannot resolve it. Do
        // not let a later mkdir or write follow it beyond the state root.
        try {
          await this.fileSystem.lstat(ancestor);
          throw Object.assign(new Error('Metadata image path traverses an unresolved link or reparse point.'), { code: 'permission-denied' });
        } catch (linkError) { if (linkError?.code !== 'ENOENT') throw linkError; }
        const parent = path.dirname(ancestor);
        if (parent === ancestor || !contained(stateRoot, parent)) break;
        ancestor = parent;
      }
    }
    return { localPath: target, identity };
  }
  async stat(identity, options = {}) {
    return this.#stat(identity, options, this.#roots());
  }
  async #stat(identity, options, roots) {
    try { const location = await this.#resolve(identity, options, roots); options.signal?.throwIfAborted();
      if (location.accessPath) return { ...await this.vfs.stat(location.accessPath, options), Path: location.identity };
      const value = await this.fileSystem.stat(location.localPath, { bigint: true }); return { Path: location.identity, name: path.basename(location.localPath), kind: value.isDirectory() ? 'directory' : 'file', size: value.size, modified: modifiedDate(value) };
    } catch (error) { throw errorCode(error); }
  }
  async createDirectory(identity) {
    const roots = this.#roots(), location = await this.#resolve(identity, undefined, roots);
    if (!location.localPath) throw Object.assign(new Error('A by-name metadata directory requires instance state.'), { code: 'unmapped-path' });
    await this.fileSystem.mkdir(location.localPath, { recursive: true });
    // Resolve again after creation so an intervening link cannot grant a
    // directory outside the configured metadata root.
    await this.#resolve(identity, undefined, roots);
    return this.fileSystem.stat(location.localPath, { bigint: true });
  }
  async read(identity, options = {}) {
    const handle = await this.openRead(identity, options), failures = [];
    let bytes;
    try { const chunks = []; for await (const chunk of handle.stream) { options.signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); } bytes = Buffer.concat(chunks); }
    catch (error) { failures.push(error); }
    try { await handle.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw Object.assign(new AggregateError(failures, failures[0]?.message ?? 'Image asset read failed.', { cause: failures[0] }),
      Object.fromEntries(['code', 'status', 'statusCode'].filter(key => failures[0]?.[key] !== undefined).map(key => [key, failures[0][key]])));
    return bytes;
  }
  async openRead(identity, options = {}) {
    try {
      const location = await this.resolve(identity); options.signal?.throwIfAborted();
      if (location.accessPath) return this.vfs.openRead(location.accessPath, options);
      try { return await this.fileSystem.openRead(location.localPath, options); }
      catch (error) {
        if (error?.code === 'is-directory') throw Object.assign(new Error('Image asset is not a file.'), { code: 'not-found' });
        throw error;
      }
    } catch (error) { throw errorCode(error); }
  }
  async write(identity, bytes, options = {}) {
    try { const roots = this.#roots(), location = await this.#resolve(identity, undefined, roots); options.signal?.throwIfAborted();
      if (location.localPath) {
        await this.fileSystem.mkdir(path.dirname(location.localPath), { recursive: true });
        await this.#resolve(identity, undefined, roots);
        await this.fileSystem.writeFile(location.localPath, bytes, { signal: options.signal, modified: options.modified });
      }
      else {
        const parent = path.posix.dirname(location.accessPath);
        const createParent = async directory => {
          try {
            const info = await this.vfs.stat(directory, options);
            if (info.kind !== 'directory') throw Object.assign(new Error('Image parent is not a directory.'), { code: 'not-directory' });
          } catch (error) {
            if (error?.code !== 'not-found' || path.posix.dirname(directory) === directory) throw error;
            await createParent(path.posix.dirname(directory));
            try { await this.vfs.mkdir(directory, options); }
            catch (failure) {
              if (failure?.code !== 'already-exists') throw failure;
              if ((await this.vfs.stat(directory, options)).kind !== 'directory') throw failure;
            }
          }
        };
        await createParent(parent);
        await this.vfs.write(location.accessPath, bytes, { ...options, overwrite: true, size: BigInt(bytes.length) });
      }
      return this.#stat(identity, options, roots);
    } catch (error) { throw errorCode(error); }
  }
  async swap(first, second, options = {}) {
    if (first === second) throw new Error('The image paths must be different.');
    const entries = [];
    for (const identity of [first, second]) {
      const location = await this.resolve(identity);
      const vfs = location.accessPath ? this.vfs : this.fileSystem.vfs;
      const accessPath = location.accessPath ?? (vfs && this.fileSystem.accessPath(location.localPath));
      const resolved = vfs?.resolveFileHandle(accessPath, 'w');
      const entry = await this.stat(identity, options);
      if (entry.kind !== 'file') throw Object.assign(new Error('Only files can be swapped as image assets.'), { code: 'not-found' });
      entries.push({ identity, vfs, accessPath, resolved, modified: entry.modified ?? undefined });
    }
    const [a, b] = entries;
    if (a.vfs && a.vfs === b.vfs && a.resolved.mount === b.resolved.mount) {
      if (a.resolved.path === b.resolved.path) throw new Error('The image paths must be different.');
      if (a.resolved.capabilities.rename) {
        try {
          return await swapStoragePaths(a.vfs, a.accessPath, b.accessPath, options.signal,
            () => Promise.all(entries.map(entry => this.stat(entry.identity, options))));
        } catch (error) {
          if (error instanceof AggregateError || error?.code !== 'not-supported'
            || path.posix.dirname(a.resolved.path) === path.posix.dirname(b.resolved.path)) throw error;
          // A backend may only allow sibling renames. Recovery restored both
          // paths before trying the overwrite path for different directories.
        }
      }
    }
    const originalBytes = await Promise.all(entries.map(entry => this.read(entry.identity, options)));
    const attempted = [], swapped = [];
    try {
      for (const [index, entry] of entries.entries()) {
        options.signal?.throwIfAborted();
        attempted.push(index);
        const other = 1 - index;
        swapped.push(await this.write(entry.identity, originalBytes[other], { ...options, modified: entries[other].modified }));
      }
      return swapped;
    } catch (error) {
      const errors = [error];
      // A write can publish its bytes before it rejects. Restore each attempted file even after cancellation.
      for (const index of attempted.reverse()) {
        const { identity, modified } = entries[index];
        try { await this.write(identity, originalBytes[index], { modified }); }
        catch (failure) { errors.push(failure); }
      }
      throw operationFailure(errors, 'Image swap or recovery failed.');
    }
  }
  async delete(identity, options = {}) {
    try { const location = await this.resolve(identity); options.signal?.throwIfAborted();
      if (location.localPath) await this.fileSystem.unlink(location.localPath); else await this.vfs.delete(location.accessPath, options);
    } catch (error) { throw errorCode(error); }
  }
  async deleteEmptyDirectory(identity, options = {}) {
    try {
      const location = await this.resolve(identity); options.signal?.throwIfAborted();
      if (location.localPath) {
        if (!(await this.fileSystem.stat(location.localPath)).isDirectory()) return false;
        if ((await this.fileSystem.readdir(location.localPath)).length) return false;
        await this.fileSystem.rmdir(location.localPath); return true;
      }
      const directory = await this.vfs.stat(location.accessPath, options);
      if (directory.kind !== 'directory') return false;
      if ((await this.vfs.list(location.accessPath, options)).entries.length) return false;
      await this.vfs.delete(location.accessPath, options); return true;
    } catch (error) { throw errorCode(error); }
  }
  async deleteDirectory(identity, options = {}) {
    try {
      const roots = this.#roots(), location = await this.#resolve(identity, undefined, roots); options.signal?.throwIfAborted();
      if (!location.localPath) return await this.vfs.delete(location.accessPath, { ...options, recursive: true });
      const target = path.resolve(location.localPath);
      if (roots.some(root => root && path.relative(root, target) === '')) throw Object.assign(new Error('An instance state root cannot be removed as an extracted directory.'), { code: 'permission-denied' });
      if (!(await this.fileSystem.stat(target)).isDirectory()) throw Object.assign(new Error('Extracted data path is not a directory.'), { code: 'ENOTDIR', path: target });
      await this.fileSystem.rm(target, { ...options, recursive:true });
    } catch (error) { throw errorCode(error); }
  }
  async list(identity, options = {}) {
    try { const roots = this.#roots(), location = await this.#resolve(identity, undefined, roots); options.signal?.throwIfAborted();
      const entries = location.localPath ? await Promise.all((await this.fileSystem.readdir(location.localPath)).map(name => this.#stat(path.join(identity, name), options, roots)))
        : (await this.vfs.list(location.accessPath, options)).entries;
      return entries.map(entry => ({ ...entry, Path: imagePathApi(identity).join(identity, entry.name) }));
    } catch (error) { throw errorCode(error); }
  }
}
