import { withCleanup } from '../core/operation-failure.js';
import { lowerInvariant } from '../core/identity.js';
import { libraryError } from '../library/records.js';
import { nativeContainingFolderPath, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { itemLibraryOptions } from '../library/options.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { StorageFileSystem } from '../storage/files.js';
import { readRemoteSubtitle } from './remote-subtitles.js';

export const subtitleFormats = new Set(['ass', 'mks', 'sami', 'smi', 'srt', 'ssa', 'sub', 'sup', 'vtt']);

export function subtitleDestinations({ library, storage, playback, fileSystem, libraryMonitor, libraryMonitorHost }) {
  const vfs = playback?.vfs ?? storage?.vfs, identityMap = playback?.identityMap ?? storage?.identityMap;
  const mediaFiles = vfs && identityMap ? new StorageFileSystem({ vfs, identityMap }) : storage?.mediaFileSystem ?? fileSystem;
  const metadataFiles = storage?.fileSystem ?? fileSystem ?? mediaFiles;
  return { library, mediaFiles, metadataFiles, libraryMonitor, libraryMonitorHost };
}

export async function saveSubtitle({ library, mediaFiles, metadataFiles, libraryMonitor, libraryMonitorHost }, item, subtitle, format, bytes, signal) {
  const options = await itemLibraryOptions(library, item);
  const fileSystem = options.SaveSubtitlesWithMedia ? mediaFiles : metadataFiles;
  if (!fileSystem) throw libraryError(503, 'Subtitle storage is unavailable.');
  const folder = options.SaveSubtitlesWithMedia
    ? nativeContainingFolderPath(item) : internalImagePath(item, library.options.metadataPath);
  if (!folder) throw libraryError(400, 'The subtitle destination is invalid.');
  const api = imagePathApi(folder);
  const language = lowerInvariant(subtitle.Language);
  if (language.includes('/') || language.includes('\0') || api.sep === '\\' && language.includes('\\')) {
    throw libraryError(400, 'Language contains invalid characters.');
  }
  const base = nativeFileNameWithoutExtension(item.Path, { windows: imagePathApi(item.Path).sep === '\\' }) + '.' + language
    + (subtitle.IsForced ? '.forced' : '') + (subtitle.IsHearingImpaired ? '.sdh' : '');
  let target = api.join(folder, base + '.' + format);
  // Use exclusive creation on the actual mount. The numbered filenames also
  // cover two uploads which select the same initial name concurrently.
  for (let index = 0; ; index++) {
    signal?.throwIfAborted();
    fileSystem.vfs.resolveFileHandle(fileSystem.accessPath(target), 'wx');
    libraryMonitor?.reportFileSystemChangeBeginning(target);
    const written = await withCleanup(async () => {
      await fileSystem.mkdir(folder, { recursive: true });
      try {
        await fileSystem.writeFile(target, bytes, { flag: 'wx', signal });
      } catch (error) {
        if (!(error instanceof AggregateError) && ['EEXIST', 'already-exists'].includes(error?.code)) return false;
        throw error;
      }
      await libraryMonitorHost?.invalidate(target);
      return true;
    }, [() => libraryMonitor?.reportFileSystemChangeComplete(target, false)], 'Subtitle save and monitor completion failed.');
    if (written) return;
    target = api.join(folder, base + '.' + index + '.' + format);
  }
}

export async function downloadSubtitle(destinations, providers, item, id, signal) {
  const subtitle = await readRemoteSubtitle(providers, id, signal);
  const format = lowerInvariant(subtitle.format);
  if (!subtitleFormats.has(format)) throw new Error('Invalid subtitle format: ' + format);
  await saveSubtitle(destinations, item, {
    Language: subtitle.language, IsForced: subtitle.forced, IsHearingImpaired: subtitle.hearingImpaired,
  }, format, subtitle.bytes, signal);
}
