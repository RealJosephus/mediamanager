import path from 'node:path';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const playlistFileStates = new WeakMap();

function nativePathParts(value) {
  if (typeof value !== 'string' || !value) return null;
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value);
  const api = windows ? path.win32 : path.posix;
  let normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  const trailingSeparator = windows ? /[\\/]$/u : /\/$/u;
  while (normalized.length > root.length && trailingSeparator.test(normalized)) normalized = normalized.slice(0, -1);
  return { windows, separator: windows ? '\\' : '/', value: windows ? ordinalIgnoreCaseKey(normalized) : normalized };
}

export function nativePathKey(value) {
  const parts = nativePathParts(value);
  return parts === null ? null : `${parts.windows ? 'windows' : 'posix'}\0${parts.value}`;
}

export function sameNativePath(left, right) {
  const leftKey = nativePathKey(left);
  const rightKey = nativePathKey(right);
  return leftKey !== null && rightKey !== null && leftKey === rightKey;
}

export function compareNativePaths(left, right) {
  const leftKey = nativePathKey(left);
  const rightKey = nativePathKey(right);
  if (leftKey === null || rightKey === null) throw new TypeError('Native path comparison requires two nonempty paths.');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function nativePathWithin(value, root) {
  const valueKey = nativePathParts(value);
  const rootKey = nativePathParts(root);
  if (valueKey === null || rootKey === null || valueKey.windows !== rootKey.windows) return false;
  if (valueKey.value === rootKey.value) return true;
  const prefix = rootKey.value.endsWith(rootKey.separator) ? rootKey.value : rootKey.value + rootKey.separator;
  return valueKey.value.startsWith(prefix);
}

function windowsRootLength(value) {
  const separator = character => character === '\\' || character === '/';
  const device = value.length >= 4 && ((value[0] === '\\' && (value[1] === '\\' || value[1] === '?') && value[2] === '?' && value[3] === '\\')
    || separator(value[0]) && separator(value[1]) && (value[2] === '.' || value[2] === '?') && separator(value[3]));
  const deviceUnc = device && value.length >= 8 && separator(value[7]) && value.slice(4, 7) === 'UNC';
  let index = 0;
  if ((!device || deviceUnc) && separator(value[0])) {
    index = 1;
    if (deviceUnc || value.length > 1 && separator(value[1])) {
      index = deviceUnc ? 8 : 2;
      let segments = 2;
      while (index < value.length && (!separator(value[index]) || --segments > 0)) index++;
    }
  } else if (device) {
    index = 4;
    while (index < value.length && !separator(value[index])) index++;
    if (index < value.length && index > 4 && separator(value[index])) index++;
  } else if (value.length >= 2 && value[1] === ':' && /^[A-Za-z]$/u.test(value[0])) {
    index = 2;
    if (value.length > 2 && separator(value[2])) index++;
  }
  return index;
}

const pathIsWindows = value => process.platform === 'win32' || /^[A-Za-z]:|\\/u.test(value ?? '');

// Path.GetFileName retains an empty name after a trailing separator.
export function nativeFileName(value, { windows = pathIsWindows(value) } = {}) {
  if (value == null) return value;
  const root = windows ? windowsRootLength(value) : value[0] === '/' ? 1 : 0;
  let index = value.length;
  while (index > root && value[index - 1] !== '/' && !(windows && value[index - 1] === '\\')) index--;
  return value.slice(index);
}

export function nativeFileNameWithoutExtension(value, options) {
  const name = nativeFileName(value, options);
  if (name == null) return name;
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

export function nativeDirectoryName(value, { windows = pathIsWindows(value) } = {}) {
  if (value == null || value === '') return null;
  const separator = character => character === '/' || windows && character === '\\';
  const root = windows ? windowsRootLength(value) : value[0] === '/' ? 1 : 0;
  let end = value.length;
  if (end <= root) return null;
  while (end > root && !separator(value[--end])) { /* Find the last separator. */ }
  while (end > root && separator(value[end - 1])) end--;
  const directory = value.slice(0, end);
  return windows ? directory.replaceAll('/', '\\').replace(/(?<!^)\\{2,}/gu, '\\') : directory;
}

/** Retain Playlist.IsPlaylistFile's Directory.Exists observation without
 * flattening it into persisted item JSON. */
export function setNativePlaylistFileState(item, isFile) {
  if (item === null || typeof item !== 'object' || item.Type !== 'Playlist') {
    throw new TypeError('Playlist file state requires a Playlist item.');
  }
  if (typeof isFile !== 'boolean') throw new TypeError('Playlist file state must be Boolean.');
  playlistFileStates.set(item, isFile);
  return item;
}

export function nativePlaylistIsFile(item) {
  if (item?.Type !== 'Playlist' || typeof item.Path !== 'string') return false;
  const name = nativeFileName(item.Path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 && dot < name.length - 1 && playlistFileStates.get(item) !== false;
}

// BaseItem, Video and Playlist override ContainingFolderPath independently of protocol.
export function nativeContainingFolderPath(item) {
  if (['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'MusicArtist'].includes(item.Type)) return item.Path;
  if (nativePlaylistIsFile(item)) return nativeDirectoryName(item.Path);
  if (['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer'].includes(item.Type)) {
    if ((item.AdditionalParts ?? []).length) return nativeDirectoryName(item.Path);
    if (!item.IsPlaceHolder && ['Dvd', 'BluRay'].includes(item.VideoType)) return item.Path;
  }
  return item.IsFolder ? item.Path : nativeDirectoryName(item.Path);
}

// ManagedFileSystem.ContainsSubPath compares the raw path prefix.
// Its case and separator rules depend on the host, not the input's spelling.
export function nativeSubpathParent(root, { windows = process.platform === 'win32' } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('Subpath parent must be a nonempty string.');
  const separator = character => character === '/' || windows && character === '\\';
  const rootLength = windows ? windowsRootLength(root) : root[0] === '/' ? 1 : 0;
  return separator(root.at(-1)) && root.length !== rootLength ? root.slice(0, -1) : root;
}

export function nativeContainsSubPath(value, root, { windows = process.platform === 'win32' } = {}) {
  const parent = nativeSubpathParent(root, { windows });
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Subpath must be a nonempty string.');
  const separator = character => character === '/' || windows && character === '\\';
  return value.length > parent.length
    && (windows ? ordinalIgnoreCaseKey(value.slice(0, parent.length)) === ordinalIgnoreCaseKey(parent) : value.startsWith(parent))
    && (separator(parent.at(-1)) || separator(value[parent.length]));
}
