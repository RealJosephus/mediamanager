import { decodeNativeText } from '../core/native-text.js';
import { lowerInvariant } from '../core/identity.js';
import { nativeContainingFolderPath, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { defaultLibraryOptions } from '../library/options.js';
import { idKey, libraryError } from '../library/records.js';
import { parseLyrics } from './parser.js';
import { lyricFailure } from './failure.js';

export const lyricRefreshOptions = () => ({ MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true,
  ReplaceAllMetadata: false, ReplaceAllImages: false, ForceSave: false, RemoveOldMetadata: false });

export async function lyricLibraryOptions(library, item) {
  const collection = (await library.getCollectionFolders(item)).find(folder => folder.Type === 'CollectionFolder'), configured = library.options.libraryOptions;
  return (configured instanceof Map ? configured.get(idKey(collection?.Id)) ?? configured.get(collection?.Id)
    : configured?.[idKey(collection?.Id)] ?? configured?.[collection?.Id]) ?? defaultLibraryOptions();
}

function containedPath(root, filename) {
  if (root == null) throw libraryError(400, "Value cannot be null. (Parameter 'path1')");
  if (root.includes('\0') || filename.includes('\0')) throw libraryError(400, 'Null character in path.');
  const api = imagePathApi(root), fullRoot = api.resolve(root), target = api.resolve(root, filename),
    prefix = fullRoot.endsWith(api.sep) ? fullRoot : fullRoot + api.sep;
  return target === fullRoot || target.startsWith(prefix) ? target : null;
}

/** Parse a seekable byte value once, but save its original bytes verbatim. */
export async function saveLyricBytes(service, item, format, bytes) {
  if (typeof format !== 'string' || !format.length) throw libraryError(400, "The value cannot be an empty string. (Parameter 'format')");
  const options = await lyricLibraryOptions(service.library, item);
  const parsed = parseLyrics('lyric.' + format, decodeNativeText(bytes));
  if (parsed === null) return null;
  await writeLyricBytes(service, item, format, bytes, options);
  return parsed;
}

export async function writeLyricBytes(service, item, format, bytes, options) {
  const metadataRoot = service.library.options.metadataPath,
    internal = internalImagePath(item, metadataRoot),
    filename = (nativeFileNameWithoutExtension(item.Path) ?? '') + '.' + lowerInvariant(format.replace(/\r\n|[\r\n\f\u0085\u2028\u2029]/gu, ''));
  const paths = [];
  if (options.SaveLyricsWithMedia) { const target = containedPath(nativeContainingFolderPath(item), filename); if (target !== null) paths.push(target); }
  const internalTarget = containedPath(internal, filename);
  if (internalTarget !== null) paths.push(internalTarget);
  const errors = [];
  const fileSystem = service.fileSystem;
  for (const target of paths) {
    service.monitor?.reportFileSystemChangeBeginning(target);
    let failed = false, primary;
    try {
      // A declared read-only mount cannot gain directories before its file
      // write is rejected. Runtime I/O failures retain the Native fallback.
      service.vfs.resolveFileHandle(fileSystem.accessPath(target), 'w');
      await fileSystem.mkdir(imagePathApi(target).dirname(target), { recursive: true });
      await fileSystem.writeFile(target, bytes);
      await service.directoryService?.invalidate(target);
      return;
    } catch (error) { failed = true; primary = error; errors.push(error); }
    finally {
      try { service.monitor?.reportFileSystemChangeComplete(target, false); }
      catch (error) { if (failed) throw lyricFailure([primary, error], 'Lyric save and monitor completion failed.'); throw error; }
    }
  }
  if (errors.length) throw lyricFailure(errors, 'Lyric files could not be saved.');
  try { void Promise.resolve(service.logger?.error?.('An uploaded lyric could not be saved because the resulting paths were invalid.')).catch(() => {}); } catch { }
}

export function queueLyricRefresh(service, item) {
  if (!service.metadata) throw libraryError(501, 'Metadata refresh requires configured storage.');
  const pending = service.metadata.queue(item.Id, lyricRefreshOptions(), 0);
  void Promise.resolve(pending).catch(error => {
    try { void Promise.resolve(service.logger?.error?.(error, 'Error refreshing lyrics.')).catch(() => {}); } catch { }
  });
}

/** File.Delete ignores absent files, rejects directories, and stops the stream
 * sequence at the first actual error; completed deletions are not rolled back. */
export async function deleteLyricFiles(service, item) {
  await service.streamPaths(item.Id, async pages => {
    for await (const paths of pages) for (const identity of paths) {
      service.monitor?.reportFileSystemChangeBeginning(identity);
      let failed = false, primary;
      try {
        const access = service.identityMap.resolve({ identityPath: identity });
        let entry;
        try { entry = await service.vfs.stat(access); }
        catch (error) { if (!['not-found', 'not-directory'].includes(error?.code)) throw error; }
        if (entry?.kind === 'directory') throw libraryError(500, 'A lyric stream path is a directory.');
        if (entry) await service.vfs.delete(access);
      } catch (error) { failed = true; primary = error; throw error; }
      finally {
        try { service.monitor?.reportFileSystemChangeComplete(identity, false); }
        catch (error) { if (failed) throw lyricFailure([primary, error], 'Lyric deletion and monitor completion failed.'); throw error; }
      }
      await service.directoryService?.invalidate(identity);
    }
  });
  if (!service.metadata) throw libraryError(501, 'Metadata refresh requires configured storage.');
  await service.metadata.refreshLiveItem(item, lyricRefreshOptions());
}
