import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clrTrim } from '../metadata/whitespace.js';

const nonempty = value => value != null && clrTrim(value) !== '';
const absentCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'EIO']);
const cacheTag = 'Signature: 8a477f597d28d172789f06886806bc55\n'
  + '# This file is a cache directory tag created by Jellyfin.\n'
  + '# For information about cache directory tags, see:\n'
  + '#\thttps://bford.info/cachedir/\n';

async function exists(fileSystem, filename, directory) {
  try {
    const info = await fileSystem.stat(filename);
    return { exists: directory ? info.isDirectory() : info.isFile() };
  } catch (error) {
    if (!absentCodes.has(error.code)) throw error;
    return { exists: false, error };
  }
}

export class ServerConfigurationPaths {
  constructor({ applicationPaths, metadataFileSystem, fileSystem = fs }) {
    Object.assign(this, { applicationPaths, metadataFileSystem, fileSystem });
  }

  #metadata(operation) {
    if (typeof this.metadataFileSystem?.[operation] !== 'function') {
      throw Object.assign(new Error(`Metadata storage does not support ${operation}.`), { code: 'ENOTSUP', status: 501 });
    }
    return this.metadataFileSystem;
  }

  async #validate(currentPath, nextPath, fileSystem) {
    if (!nonempty(nextPath) || (currentPath ?? '') === nextPath) return;
    const directory = await exists(fileSystem, nextPath, true);
    if (!directory.exists) throw Object.assign(new Error(`${nextPath} does not exist.`, directory.error ? { cause: directory.error } : undefined), { code: 'ENOENT', status: 404 });
    const probe = path.join(nextPath, randomUUID());
    await fileSystem.writeFile(probe, '');
    await fileSystem.unlink(probe);
  }

  async validateMetadata(current, next) {
    if (!nonempty(next.MetadataPath) || (current.MetadataPath ?? '') === next.MetadataPath) return;
    const fileSystem = this.#metadata('stat'); this.#metadata('writeFile'); this.#metadata('unlink');
    await this.#validate(current.MetadataPath, next.MetadataPath, fileSystem);
  }

  validateCache(current, next) { return this.#validate(current.CachePath, next.CachePath, this.fileSystem); }

  async updateMetadata(configuration) {
    this.applicationPaths.metadataPath = nonempty(configuration.MetadataPath) ? configuration.MetadataPath : this.applicationPaths.defaultMetadataPath;
    await this.#metadata('mkdir').mkdir(this.applicationPaths.metadataPath, { recursive: true });
  }

  async updateCache(configuration) {
    const paths = this.applicationPaths;
    paths.cachePath = nonempty(configuration.CachePath) ? configuration.CachePath
      : nonempty(paths.cachePath) ? paths.cachePath : path.join(paths.programDataPath, 'cache');
    await this.fileSystem.mkdir(paths.cachePath, { recursive: true });
    let otherMarker;
    try {
      for await (const entry of await this.fileSystem.opendir(paths.cachePath)) {
        const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
        if (!name.startsWith('.jellyfin-') || entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) {
          try { if ((await this.fileSystem.stat(path.join(paths.cachePath, entry.name))).isDirectory()) continue; }
          catch (error) { if (!absentCodes.has(error.code)) throw error; }
        }
        if (entry.name.toLowerCase() !== '.jellyfin-cache') { otherMarker = path.join(paths.cachePath, entry.name); break; }
      }
    } catch { otherMarker = undefined; /* Marker enumeration failures are ignored by the native path contract. */ }
    if (otherMarker !== undefined) throw new Error(`Expected to find only .jellyfin-cache but found marker for ${otherMarker}.`);
    const marker = path.join(paths.cachePath, '.jellyfin-cache');
    if (!(await exists(this.fileSystem, marker, false)).exists) {
      const file = await this.fileSystem.open(marker, 'w+');
      await file.close();
    }
    const filename = path.join(paths.cachePath, 'CACHEDIR.TAG');
    if (!(await exists(this.fileSystem, filename, false)).exists) await this.fileSystem.writeFile(filename, cacheTag);
  }
}
