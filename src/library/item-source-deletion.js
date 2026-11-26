import path from 'node:path';
import { nativeFileNameWithoutExtension } from './native-path.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { requireCapability, StorageError } from '../storage/errors.js';

// BaseItem.GetLocalMetadataFilesToDelete uses this exact extension set and a
// filename-prefix match, without an image/subtitle naming rule or a sort.
const localMetadataExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.tbn', '.gif', '.svg', '.nfo', '.xml',
  '.srt', '.vtt', '.sub', '.sup', '.idx', '.txt', '.edl', '.bif', '.smi',
  '.ttml', '.lrc', '.elrc'
].map(ordinalIgnoreCaseKey));

function optionalFileError(error) {
  return ['io', 'not-found', 'permission-denied', 'unavailable', 'timeout', 'ENOENT', 'EIO', 'EACCES', 'EPERM'].includes(error.code);
}

const missingFile = error => error.code === 'not-found' || error.code === 'ENOENT';

/** Preflight the authoritative mount before cleanup. Mixed-folder enumeration
 * stays at GetDeletePaths' native boundary, after internal metadata cleanup
 * and before the required file. Direct file entries share the parent mount;
 * VFS mount overlays are directories and cannot authorize sidecar deletion. */
export function prepareItemSourceDeletion({ item, accessPath, vfs, metadataVfs, fileLeaf, mixed = false, actualSourceKind = false }) {
  if (!accessPath || !vfs) throw new StorageError('unmapped-path', 'Source deletion requires mapped media storage.');
  const source = vfs.resolve(accessPath);
  requireCapability(source, 'delete');
  if (source.path === source.mount.root) {
    throw new StorageError('permission-denied', 'A media mount root cannot be deleted as an item source.');
  }
  let removeMetadata;
  if (metadataVfs && metadataVfs !== vfs) {
    const metadata = metadataVfs.resolve(accessPath);
    if (metadata.adapter !== source.adapter || metadata.path !== source.path) {
      removeMetadata = prepareItemSourceDeletion({ item, accessPath, vfs: metadataVfs, fileLeaf, mixed, actualSourceKind });
    }
  }
  const directory = path.posix.dirname(accessPath);
  const parent = mixed && vfs.resolve(directory);
  if (mixed) {
    requireCapability(parent, 'delete');
    if (parent.mount !== source.mount) {
      throw new StorageError('permission-denied', 'Mixed-folder files require the authoritative parent mount.');
    }
  }

  // A configured VFS can switch generations at any await. Its operations
  // resolve synchronously on entry, so check the original binding at dispatch.
  function confirmBinding(target, backendPath) {
    const resolved = vfs.resolve(target);
    if (resolved.mount !== source.mount || resolved.adapter !== source.adapter || resolved.path !== backendPath) {
      throw new StorageError('version-changed', 'The storage binding changed before source deletion.');
    }
  }

  return async () => {
    // BaseItem.GetDeletePaths selects its own Path's actual file-system kind.
    // A Book may resolve to an extension-named directory while IsFolder=false.
    const targets = [{ path: accessPath, backendPath: source.path, required: true, kind: actualSourceKind ? 'actual' : fileLeaf ? 'file' : 'directory' }];
    if (mixed) {
      let info;
      confirmBinding(directory, parent.path);
      try { info = await vfs.stat(directory); } catch (error) { if (!optionalFileError(error)) throw error; }
      if (info?.kind === 'directory') {
        confirmBinding(directory, parent.path);
        const listing = await vfs.list(directory);
        const filename = nativeFileNameWithoutExtension(item.Path);
        for (const entry of listing.entries) {
          if (entry.kind !== 'file') continue;
          const dot = entry.name.lastIndexOf('.');
          if (dot < 0 || !localMetadataExtensions.has(ordinalIgnoreCaseKey(entry.name.slice(dot)))) continue;
          const stem = nativeFileNameWithoutExtension(entry.name);
          if (!ordinalIgnoreCaseEquals(stem.slice(0, filename.length), filename)) continue;
          const target = path.posix.join(directory, entry.name), backendPath = path.posix.join(parent.path, entry.name);
          confirmBinding(target, backendPath);
          targets.push({ path: target, backendPath, required: false, kind: 'file' });
        }
      }
    }
    for (const target of targets) {
      let info;
      confirmBinding(target.path, target.backendPath);
      try { info = await vfs.stat(target.path); } catch (error) {
        if (missingFile(error) || !target.required && optionalFileError(error)) continue;
        throw error;
      }
      const kind = target.kind === 'actual' ? info.kind : target.kind;
      if (info.kind !== kind) {
        if (target.required && kind === 'file' && info.kind === 'directory') {
          throw new StorageError('is-directory', 'The required file deletion target is a directory.');
        }
        continue;
      }
      confirmBinding(target.path, target.backendPath);
      try { await vfs.delete(target.path, { recursive: kind === 'directory' }); }
      catch (error) {
        if (missingFile(error) || !target.required && optionalFileError(error)) continue;
        throw error;
      }
    }
    await removeMetadata?.();
  };
}
