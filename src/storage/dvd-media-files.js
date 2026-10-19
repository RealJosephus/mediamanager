import path from 'node:path';
import { StorageError, checkAbort } from './errors.js';
import { normalizePath } from './paths.js';
import { normalizeProbeFileDate } from './probe-lifecycle.js';

const comparer = new Intl.Collator(undefined, { sensitivity: 'variant' });
const bigVob = 900n * 1024n * 1024n;
const titlePart = file => {
  const stem = path.posix.basename(file.virtualPath, path.posix.extname(file.virtualPath));
  return stem.slice(stem.lastIndexOf('_') + 1);
};
const modified = value => value == null ? null : normalizeProbeFileDate(value);

// MediaEncoder.GetPrimaryPlaylistVobFiles selects by the last underscore
// component, including when several VTS titles share that component.
export async function getDvdMediaFiles(vfs, virtualPath, { signal, titleNumber } = {}) {
  checkAbort(signal);
  virtualPath = normalizePath(virtualPath);
  if (titleNumber != null && (!Number.isSafeInteger(titleNumber) || titleNumber < 0 || titleNumber > 0xffffffff)) {
    throw new TypeError('DVD title number must be an unsigned 32-bit integer.');
  }
  const pending = [virtualPath], files = [];
  while (pending.length) {
    checkAbort(signal);
    const directory = pending.pop();
    const listing = await vfs.list(directory, { signal });
    if (listing.complete !== true) throw new StorageError('incomplete-listing', 'DVD file enumeration is incomplete.');
    for (const entry of listing.entries) {
      const filename = path.posix.join(directory, entry.name);
      if (entry.kind === 'directory') pending.push(filename);
      else if (/\.vob$/iu.test(entry.name) && !/^video_ts\.vob$/iu.test(entry.name) && !/_0\.vob$/iu.test(entry.name)) {
        const stat = await vfs.stat(filename, { signal });
        if (stat.kind !== 'file') throw new StorageError('version-changed', 'A DVD media file changed during selection.');
        files.push({ virtualPath: filename, size: stat.size, modified: stat.modified,
          version: stat.version, reliable: vfs.capabilities(filename).reliableVersion === true && stat.version != null });
      }
    }
  }
  checkAbort(signal);
  files.sort((left, right) => comparer.compare(left.virtualPath, right.virtualPath));
  if (titleNumber != null) {
    const prefix = `vts_${String(titleNumber).padStart(2, '0')}_`;
    const selected = files.filter(file => path.posix.basename(file.virtualPath).toLowerCase().startsWith(prefix));
    if (selected.length) return selected;
  }
  // The reference cannot select its first fallback title from an empty set.
  if (!files.length) throw new StorageError('invalid-response', 'DVD directory contains no playable VOB files.');
  if (files.some(file => file.size == null)) throw new StorageError('not-supported', 'DVD title selection requires VOB file lengths.');
  const titles = new Set(files.filter(file => BigInt(file.size) >= bigVob).map(titlePart));
  if (!titles.size) titles.add(titlePart(files[0]));
  return files.filter(file => titles.has(titlePart(file)));
}

// Re-select so additions and size changes that alter the title selection are
// observed too. Unrelated NFO/extra writes do not change the selected source.
export async function verifyDvdMediaFiles(vfs, virtualPath, files, options = {}) {
  let current;
  try { current = await getDvdMediaFiles(vfs, virtualPath, options); }
  catch (error) {
    checkAbort(options.signal);
    if (!['not-found', 'not-directory', 'invalid-response'].includes(error.code)) throw error;
    throw new StorageError('version-changed', 'DVD media files disappeared during probing.');
  }
  if (current.length !== files.length || current.some((file, index) => {
    const before = files[index];
    return file.virtualPath !== before.virtualPath || file.size !== before.size
      || modified(file.modified) !== modified(before.modified)
      || before.reliable && (!file.reliable || file.version !== before.version);
  })) throw new StorageError('version-changed', 'DVD media files changed during probing.');
}
