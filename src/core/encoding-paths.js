import * as fs from 'node:fs/promises';
import path from 'node:path';

const absentCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'EIO', 'ENODEV', 'ENXIO']);

async function* markerFiles(root, fileSystem) {
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    for await (const entry of await fileSystem.opendir(directory)) {
      const filename = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = (await fileSystem.stat(filename)).isDirectory(); }
        catch (error) { if (!absentCodes.has(error.code)) throw error; }
      }
      if (isDirectory) { directories.push(filename); continue; }
      const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
      if (name.startsWith('.jellyfin-')) yield filename;
    }
  }
}

/** Transcoding output is infrastructure state, separate from mapped media. */
export class EncodingPaths {
  constructor({ applicationPaths, getEncodingOptions, fileSystem = fs }) {
    if (!applicationPaths || typeof getEncodingOptions !== 'function') {
      throw new TypeError('Encoding paths require application paths and current encoding configuration.');
    }
    Object.assign(this, { applicationPaths, getEncodingOptions, fileSystem });
  }

  async getTranscodePath() {
    const options = this.getEncodingOptions();
    const directory = options.TranscodingTempPath == null || options.TranscodingTempPath === ''
      ? path.join(this.applicationPaths.cachePath, 'transcodes') : options.TranscodingTempPath;
    await this.fileSystem.mkdir(directory, { recursive: true });
    let otherMarker;
    try {
      for await (const filename of markerFiles(directory, this.fileSystem)) {
        if (path.basename(filename).toLowerCase() !== '.jellyfin-transcode') { otherMarker = filename; break; }
      }
    } catch { /* Native marker enumeration failures leave marker creation to report its own I/O failure. */ }
    if (otherMarker !== undefined) throw new Error(`Expected to find only .jellyfin-transcode but found marker for ${otherMarker}.`);
    const marker = path.join(directory, '.jellyfin-transcode');
    let exists = false;
    try { exists = (await this.fileSystem.stat(marker)).isFile(); }
    catch (error) { if (!absentCodes.has(error.code)) throw error; }
    if (!exists) {
      const file = await this.fileSystem.open(marker, 'w+');
      await file.close();
    }
    return directory;
  }
}
