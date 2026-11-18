import { hostFolderCapacity } from '../../packages/plugin-sdk/storage/host-capacity.js';
import { idKey } from '../library/records.js';
import { identityPathStyle } from '../storage/uri.js';

const noCapacity = { FreeSpace: -1, UsedSpace: -1 };
const byteCount = number => typeof number === 'bigint' ? number >= 0n : Number.isSafeInteger(number) && number >= 0;

async function folderStorage(filename, load, signal) {
  const Path = filename ?? '';
  if (!Path || !load) return { Path, ...noCapacity };
  let capacity;
  try { capacity = await load(Path, { signal }); }
  catch { signal?.throwIfAborted(); }
  if (!capacity || !byteCount(capacity.freeBytes) || !byteCount(capacity.usedBytes)) return { Path, ...noCapacity };
  const { freeBytes: FreeSpace, usedBytes: UsedSpace, storageType: StorageType, deviceId: DeviceId } = capacity;
  return { Path, FreeSpace, UsedSpace, StorageType, DeviceId };
}

export async function getSystemStorage({
  applicationPaths = {}, imageProcessor, encodingPaths, libraryConfiguration, fileSystem, mediaStorage,
}, signal) {
  const { programDataPath, cachePath, metadataPath, logDirectoryPath } = applicationPaths;
  const transcodePath = cachePath ? await encodingPaths?.getTranscodePath() : undefined;
  const folders = await libraryConfiguration?.getVirtualFolders() ?? [];
  const mappedMetadata = fileSystem?.getSpace?.bind(fileSystem);
  const mappedMedia = mediaStorage && ((identityPath, options) => mediaStorage.vfs.getSpace(
    mediaStorage.identityMap.resolve({ identityPath, style: identityPathStyle(identityPath) }), options));
  const [ProgramDataFolder, CacheFolder, LogFolder, ImageCacheFolder, InternalMetadataFolder, TranscodingTempFolder, Libraries] =
    await Promise.all([
      folderStorage(programDataPath, hostFolderCapacity, signal),
      folderStorage(cachePath, hostFolderCapacity, signal),
      folderStorage(logDirectoryPath, hostFolderCapacity, signal),
      folderStorage(imageProcessor?.cachePath, mappedMetadata, signal),
      folderStorage(metadataPath, mappedMetadata, signal),
      folderStorage(transcodePath, hostFolderCapacity, signal),
      Promise.all(folders.filter(folder => folder.ItemId).map(async folder => ({
        Id: idKey(folder.ItemId), Name: folder.Name,
        Folders: await Promise.all(folder.Locations.map(location => folderStorage(location, mappedMedia, signal))),
      }))),
    ]);
  return { ProgramDataFolder, WebFolder: { Path: '', ...noCapacity }, ImageCacheFolder, CacheFolder,
    LogFolder, InternalMetadataFolder, TranscodingTempFolder, Libraries };
}
