import { dateTicks, MIN_DATE } from '../library/records.js';
import { normalizeProbeFileDate, probeFileChanged, probeIsVideo } from '../storage/probe-lifecycle.js';
import { ItemUpdateType } from './save-manager.js';

async function fileInfo(loaded, vfs) {
  if (loaded.fileSystemMetadata) return loaded.fileSystemMetadata();
  if (!loaded.context.accessPath) return null;
  try { return await vfs.stat(loaded.context.accessPath); }
  catch (error) { if (error.code === 'not-found') return null; throw error; }
}

export async function beforeSaveFileMetadata(item, loaded, { vfs, invalidateExternalData } = {}) {
  if (!item.Path) return ItemUpdateType.None;
  const info = await fileInfo(loaded, vfs);
  if (!info || info.exists === false || !probeFileChanged(item, info.modified)) return ItemUpdateType.None;
  const previousDateModified = item.DateModified;
  // The native entity is mutated before cleanup. Cleanup failure keeps these
  // values in memory and prevents the first repository save from running.
  item.DateModified = normalizeProbeFileDate(info.modified);
  if ((loaded.metadataConfiguration?.UseFileCreationTimeForDateAdded ?? true) && info.created != null
    && dateTicks(normalizeProbeFileDate(info.created)) > dateTicks(MIN_DATE)) {
    item.DateCreated = normalizeProbeFileDate(info.created);
  }
  if (probeIsVideo(item)) await invalidateExternalData(item, { previousDateModified });
  return ItemUpdateType.MetadataImport;
}

export async function updateFileMetadataForSave(item, loaded, { vfs, logger } = {}) {
  if (!item.IsFileProtocol) return;
  let info;
  // Native TryGetFileSystemMetadata logs failures and still saves the item.
  // Neither this lookup nor BeforeSave receives the request cancellation token.
  try { info = await fileInfo(loaded, vfs); }
  catch (error) { logger?.error(error, 'Error getting metadata file information'); return; }
  if (!info) return;
  if (info.modified != null) item.DateModified = normalizeProbeFileDate(info.modified);
  if (info.kind !== 'directory') item.Size = info.size ?? 0n;
}
