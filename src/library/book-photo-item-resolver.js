import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeDirectoryName, nativeFileName, nativeFileNameWithoutExtension } from './native-path.js';
import { isNativeVideoFileName } from './video-file-resolver.js';

export const bookNativeType = 'MediaBrowser.Controller.Entities.Book';
export const photoNativeType = 'MediaBrowser.Controller.Entities.Photo';
export const photoAlbumNativeType = 'MediaBrowser.Controller.Entities.PhotoAlbum';

const bookExtensions = new Set(['.azw', '.azw3', '.cb7', '.cbr', '.cbt', '.cbz', '.epub', '.mobi', '.pdf']);
const photoExtensions = new Set([
  '.tiff', '.tif', '.jpeg', '.jpg', '.png', '.cr2', '.crw', '.nef', '.orf', '.pef', '.arw', '.webp',
  '.gif', '.bmp', '.erf', '.raf', '.rw2', '.nrw', '.dng', '.ico', '.astc', '.ktx', '.pkm', '.wbmp', '.avif'
]);
const ignoredPhotoPrefixes = Object.freeze([
  'folder', 'thumb', 'landscape', 'fanart', 'backdrop', 'poster', 'cover', 'logo', 'default'
]);
const withheld = Object.freeze({ withhold: true });

const bookPatterns = Object.freeze([
  /^(?<seriesName>.+?)(?:\s\((?<seriesYear>[0-9]{4})\))?\s#(?<index>[0-9]+)(?:\.0)?(?:\s\(of\s(?<count>[0-9]+)\))?(?:\s\((?<year>[0-9]{4})\))?$/u,
  /^(?<name>.+?)\s\((?<seriesName>.+?),\s#(?<index>[0-9]+)\)(?:\.0)?(?:\s\((?<year>[0-9]{4})\))?$/u,
  /^(?<index>[0-9]+)(?:\.0)?\s-\s(?<name>.+?)(?:\s\((?<year>[0-9]{4})\))?$/u,
  /(?<name>.*)\((?<year>[0-9]{4})\)/u,
  /(?<name>.*)/u
]);
const comicPattern = /^(?<name>.+?)(?:\sv(?<volume>[0-9]+))?(?:\sc(?<chapter>[0-9]+))?$/u;

function int32(value) {
  if (value == null) return null;
  const result = Number(value);
  return Number.isInteger(result) && result >= -2147483648 && result <= 2147483647 ? result : null;
}

/** Frozen BookFileNameParser projection used by the production Book resolver. */
export function parseBookFileName(value) {
  if (value == null) return Object.freeze({ name: null, seriesName: null, index: null, parentIndex: null, year: null });
  for (const pattern of bookPatterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const groups = match.groups ?? {};
    const name = groups.name == null ? null : clrTrim(groups.name);
    const comic = name == null ? null : comicPattern.exec(name);
    const parentIndex = int32(comic?.groups?.volume);
    const chapter = int32(comic?.groups?.chapter);
    return Object.freeze({
      name,
      seriesName: groups.seriesName == null ? null : clrTrim(groups.seriesName),
      index: int32(groups.index) ?? chapter,
      parentIndex,
      year: int32(groups.year)
    });
  }
  throw new Error('The terminal book filename pattern must always match.');
}

function extension(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? String(name).slice(index).toLowerCase() : '';
}

function isBook(candidate) {
  return ['file', 'directory'].includes(candidate?.entry?.kind) && bookExtensions.has(extension(candidate.entry.name));
}

function bookDraft(parsed, fallbackName, seriesName, mixed) {
  const columns = { IsInMixedFolder: mixed, SeriesName: parsed.seriesName ?? seriesName };
  if (parsed.index != null) columns.IndexNumber = parsed.index;
  if (parsed.parentIndex != null) columns.ParentIndexNumber = parsed.parentIndex;
  if (parsed.year != null) columns.ProductionYear = parsed.year;
  return {
    Name: parsed.name || fallbackName,
    IsFolder: false,
    MediaType: 'Book',
    SourceType: 'Library',
    columns
  };
}

function bookContext(collectionContext) {
  return collectionContext?.collectionType === 'books';
}

export function createBookItemResolver() {
  return Object.freeze({
    id: 'builtin-book-items',
    priority: 10,
    productionMediaScope: 'book-files-and-single-file-directories',
    nativeTypes: { [bookNativeType]: { isFolder: false } },
    resolveFile({ collectionContext, candidate }) {
      if (!bookContext(collectionContext) || candidate?.entry?.kind !== 'file' || !isBook(candidate)) return null;
      const stem = nativeFileNameWithoutExtension(candidate.entry.name);
      const directory = nativeFileName(nativeDirectoryName(candidate.identityPath)) ?? '';
      return {
        nativeType: bookNativeType,
        primary: candidate,
        consumedPaths: [candidate],
        draft: bookDraft(parseBookFileName(stem), stem, directory, true)
      };
    },
    async resolveDirectory({ collectionContext, candidate, peekDirectory }) {
      if (!bookContext(collectionContext)) return null;
      const snapshot = await peekDirectory?.(candidate);
      if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return withheld;
      const books = snapshot.candidates.filter(isBook);
      if (books.length !== 1) return null;
      const parsed = parseBookFileName(candidate.entry.name);
      return {
        nativeType: bookNativeType,
        primary: candidate,
        itemSource: books[0],
        consumedPaths: [candidate, books[0]],
        draft: bookDraft(parsed, candidate.entry.name, '', false)
      };
    }
  });
}

function photoContext(collectionContext) {
  return collectionContext?.collectionType === 'photos'
    || collectionContext?.collectionType === 'homevideos'
      && collectionContext.libraryOptions?.EnablePhotos !== false;
}

export function isNativePhotoFileName(name) {
  const stem = nativeFileNameWithoutExtension(name);
  if (!stem || !photoExtensions.has(extension(name))) return false;
  const key = ordinalIgnoreCaseKey(stem);
  return !ignoredPhotoPrefixes.some(prefix => key.startsWith(ordinalIgnoreCaseKey(prefix)));
}

function isPhoto(candidate) {
  return candidate?.entry?.kind === 'file' && isNativePhotoFileName(candidate.entry.name);
}

function photoOwnedByMedia(imageName, candidates) {
  const imageKey = ordinalIgnoreCaseKey(imageName);
  return candidates.some(candidate => candidate?.entry?.kind === 'file'
    && isNativeVideoFileName(candidate.entry.name)
    && imageKey.startsWith(ordinalIgnoreCaseKey(nativeFileNameWithoutExtension(candidate.entry.name))));
}

function photoClaim(candidate) {
  return {
    nativeType: photoNativeType,
    primary: candidate,
    consumedPaths: [candidate],
    draft: {
      Name: nativeFileNameWithoutExtension(candidate.entry.name),
      IsFolder: false,
      MediaType: 'Photo',
      SourceType: 'Library'
    }
  };
}

export function createPhotoItemResolver() {
  return Object.freeze({
    id: 'builtin-photo-items',
    priority: 10,
    productionMediaScope: 'photos-and-homevideos-photo-albums',
    nativeTypes: { [photoNativeType]: { isFolder: false } },
    resolveFile({ collectionContext, candidates, candidate, deletionSafe }) {
      if (!photoContext(collectionContext) || !isPhoto(candidate)) return null;
      if (!deletionSafe) return withheld;
      return photoOwnedByMedia(nativeFileNameWithoutExtension(candidate.entry.name), candidates)
        ? null : photoClaim(candidate);
    }
  });
}

export function createPhotoAlbumResolver() {
  return Object.freeze({
    id: 'builtin-photo-albums',
    priority: 20,
    nativeTypes: { [photoAlbumNativeType]: { isFolder: true } },
    async resolveDirectory({ collectionContext, candidate, peekDirectory }) {
      if (!photoContext(collectionContext)) return null;
      const snapshot = await peekDirectory?.(candidate);
      if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return withheld;
      const hasPhoto = snapshot.candidates.some(file => isPhoto(file)
        && !photoOwnedByMedia(file.entry.name, snapshot.candidates));
      if (!hasPhoto) return null;
      return {
        nativeType: photoAlbumNativeType,
        primary: candidate,
        consumedPaths: [candidate],
        traversal: 'children',
        draft: { Name: candidate.entry.name, IsFolder: true, MediaType: 'Unknown', SourceType: 'Library' }
      };
    }
  });
}
