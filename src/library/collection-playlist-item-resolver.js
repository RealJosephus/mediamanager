import path from 'node:path';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeFileName, nativeFileNameWithoutExtension } from './native-path.js';

export const boxSetNativeType = 'MediaBrowser.Controller.Entities.Movies.BoxSet';
const playlistNativeType = 'MediaBrowser.Controller.Playlists.Playlist';
const playlistsFolderNativeType = 'Emby.Server.Implementations.Playlists.PlaylistsFolder';
const playlistExtensions = new Set(['.M3U', '.M3U8', '.PLS', '.WPL', '.ZPL']);
const withheld = Object.freeze({ withhold: true });

function withoutMarker(name, marker) {
  let result = '', offset = 0;
  for (let index = 0; index <= name.length - marker.length; index++) {
    if (!ordinalIgnoreCaseEquals(name.slice(index, index + marker.length), marker)) continue;
    result += name.slice(offset, index);
    offset = index + marker.length;
    index = offset - 1;
  }
  return offset === 0 ? null : clrTrim(result + name.slice(offset));
}

function claim(candidate, nativeType, name, parent, { playlist = false, file = false } = {}) {
  return {
    nativeType,
    primary: candidate,
    consumedPaths: [candidate],
    traversal: playlist ? 'none' : 'children',
    draft: {
      // An empty resolver name is filled by ResolverHelper, including the
      // deliberately empty stem of a file named only ".m3u".
      ...(name ? { Name: name } : {}),
      IsFolder: true,
      MediaType: file ? 'Audio' : 'Unknown',
      SourceType: 'Library',
      columns: { IsInMixedFolder: file },
      data: { IsRoot: parent == null,
        ...(playlist ? { OpenAccess: true, PlaylistMediaType: file ? 'Audio' : 'Unknown' } : {}) }
    }
  };
}

function strongSnapshot(snapshot) {
  return snapshot?.listing?.deletionSafe === true && Array.isArray(snapshot.candidates);
}

function pathApi(value) {
  return process.platform === 'win32' || /^[A-Za-z]:|\\/u.test(value) ? path.win32 : path.posix;
}

/** Pinned BoxSetResolver: no collection gate, exact collection.xml path,
 * including a directory entry with that name. Provider attributes are applied
 * by the shared resolver initialization before saving the native entity. */
export function createBoxSetItemResolver() {
  return Object.freeze({
    id: 'builtin-boxset-items',
    priority: 1,
    nativeTypes: { [boxSetNativeType]: { isFolder: true } },
    async resolveDirectory({ parent, candidate, peekDirectory }) {
      if (candidate?.entry?.kind !== 'directory') return null;
      const name = nativeFileName(candidate.identityPath);
      if (!name) return null;
      const stripped = withoutMarker(name, '[boxset]');
      if (stripped !== null) return claim(candidate, boxSetNativeType, stripped, parent);
      const snapshot = await peekDirectory?.(candidate);
      if (!strongSnapshot(snapshot)) return withheld;
      const xmlPath = pathApi(candidate.identityPath).join(candidate.identityPath, 'collection.xml');
      return snapshot.candidates.some(child => child.identityPath === xmlPath)
        ? claim(candidate, boxSetNativeType, clrTrim(name), parent) : null;
    }
  });
}

/** Pinned PlaylistResolver runs before BoxSet at the same native priority.
 * Playlist directories and external playlist files are logical folders, never
 * recursive filesystem scan roots. External file parsing has its own provider. */
export function createPlaylistItemResolver() {
  return Object.freeze({
    id: 'builtin-playlist-items',
    priority: 1,
    productionMediaScope: 'playlist-files-and-logical-directories',
    nativeTypes: { [playlistNativeType]: { isFolder: true } },
    resolveFile({ parent, collectionContext, candidate }) {
      if (candidate?.entry?.kind !== 'file'
        || ![null, undefined, 'music'].includes(collectionContext?.collectionType)) return null;
      const name = nativeFileName(candidate.identityPath), dot = name.lastIndexOf('.');
      if (dot < 0 || !playlistExtensions.has(ordinalIgnoreCaseKey(name.slice(dot)))) return null;
      return claim(candidate, playlistNativeType, nativeFileNameWithoutExtension(name), parent, { playlist: true, file: true });
    },
    async resolveDirectory({ parent, candidate, peekDirectory }) {
      if (candidate?.entry?.kind !== 'directory') return null;
      // Path.TrimEndingDirectorySeparator removes one trailing separator; it
      // must not acquire Node's basename normalization of arbitrary endings.
      const value = /[\\/]$/u.test(candidate.identityPath)
        ? candidate.identityPath.slice(0, -1) : candidate.identityPath;
      const name = nativeFileName(value);
      if (!name) return null;
      const stripped = withoutMarker(name, '[playlist]');
      if (stripped !== null) return claim(candidate, playlistNativeType, stripped, parent, { playlist: true });
      if ((parent?.NativeType ?? parent?.Type) === playlistsFolderNativeType || parent?.Type === 'PlaylistsFolder') {
        return claim(candidate, playlistNativeType, name, parent, { playlist: true });
      }
      let snapshot;
      try {
        // Directory.EnumerateFiles does not consult the item ignore chain.
        snapshot = await peekDirectory?.(candidate, { forExtras: true });
      } catch (error) {
        if (['not-found', 'not-directory'].includes(error?.code)) return null;
        throw error;
      }
      if (!strongSnapshot(snapshot)) return withheld;
      return snapshot.candidates.some(child => child.entry.kind === 'file'
        && ordinalIgnoreCaseKey(child.identityPath).endsWith('PLAYLIST.XML'))
        ? claim(candidate, playlistNativeType, name, parent, { playlist: true }) : null;
    }
  });
}
