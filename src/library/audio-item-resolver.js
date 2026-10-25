import { configuredTypeForPath } from './scan-context.js';
import namingOptions from '../metadata/episode-patterns.json' with { type: 'json' };

export const audioNativeType = 'MediaBrowser.Controller.Entities.Audio.Audio';
export const musicAlbumNativeType = 'MediaBrowser.Controller.Entities.Audio.MusicAlbum';
export const musicArtistNativeType = 'MediaBrowser.Controller.Entities.Audio.MusicArtist';

// Video-overlapping audio formats remain Audio in a music collection.
// Playlists, CUE and shortcuts retain their separate resolver handling.
const ordinaryAudioExtensions = new Set([
  '.669', '.3gp', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf', '.aif',
  '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.dmf', '.dsf', '.dsm',
  '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym', '.hps', '.imf',
  '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg', '.mp2', '.mp3',
  '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.nsv', '.oga', '.ogg', '.okt', '.opus', '.ra',
  '.rf64', '.rm', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.ult', '.uni', '.vox', '.wav', '.wma', '.wv',
  '.xm', '.xsp', '.ymf'
]);
const nativeAudioExtensions = new Set([
  '.669', '.3gp', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf',
  '.aif', '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.cue', '.dmf',
  '.dsf', '.dsm', '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym',
  '.hps', '.imf', '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg',
  '.mp2', '.mp3', '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.nsv', '.oga', '.ogg',
  '.okt', '.opus', '.pls', '.ra', '.rf64', '.rm', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.strm',
  '.ult', '.uni', '.vox', '.wav', '.wma', '.wv', '.xm', '.xsp', '.ymf'
]);
const playlistExtensions = new Set(['.m3u', '.m3u8', '.pls', '.wpl', '.zpl']);
const mixedVideoExtensions = new Set(namingOptions.VideoFileExtensions.map(extension => extension.toLowerCase()));
const artistSubfolders = new Set([
  'albums', 'broadcasts', 'bootlegs', 'compilations', 'dj-mixes', 'eps', 'live', 'mixtapes', 'others',
  'remixes', 'singles', 'soundtracks', 'spokenwords', 'streets'
]);
const withheld = Object.freeze({ withhold: true });

const nativeType = item => item?.NativeType ?? item?.nativeType ?? item?.Type;

function fileParts(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? { stem: name.slice(0, index), extension: name.slice(index).toLowerCase() }
    : { stem: name, extension: '' };
}

export function isNativeAudioFileName(name) {
  const { stem, extension } = fileParts(String(name));
  return Boolean(stem) && nativeAudioExtensions.has(extension);
}

function ordinaryAudio(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && ordinaryAudioExtensions.has(extension);
}

function cueFile(candidate) {
  return candidate?.entry?.kind === 'file' && fileParts(candidate.entry.name).extension === '.cue';
}

function audioShortcut(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && extension === '.strm';
}

function potentialAudio(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && (nativeAudioExtensions.has(extension) || playlistExtensions.has(extension));
}

function multiPartFolder(name) {
  const normalized = String(name).replace(/[-.()\s]+/gu, ' ').trimStart();
  const folded = normalized.toLowerCase();
  for (const prefix of ['cd', 'digital media', 'disc', 'disk', 'vol', 'volume', 'part', 'act']) {
    if (!folded.startsWith(prefix)) continue;
    const number = normalized.slice(prefix.length).trim().split(' ')[0];
    if (/^[+-]?\d+$/u.test(number)) {
      const value = Number(number);
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return true;
    }
  }
  return false;
}

function playlistDirectory(candidate, snapshot) {
  return candidate?.entry?.kind === 'directory'
    && (candidate.entry.name.toLowerCase().includes('[playlist]')
      || snapshot?.candidates?.some(child => child?.entry?.kind === 'file'
        && child.entry.name.toLowerCase() === 'playlist.xml'));
}

function exactCollectionOverride(collectionContext, identityPath) {
  const overrides = collectionContext?.contentTypeOverrides;
  return configuredTypeForPath(overrides === undefined ? [] : overrides, identityPath);
}

function resolvableMusicContext(collectionContext) {
  return collectionContext?.collectionType === 'music';
}

function claim(candidate, type, draft, traversal = 'none') {
  return {
    nativeType: type,
    primary: candidate,
    consumedPaths: [candidate],
    traversal,
    draft: { ...draft, SourceType: 'Library' }
  };
}

function audioClaim(candidate) {
  const { stem } = fileParts(candidate.entry.name);
  return claim(candidate, audioNativeType, {
    Name: stem,
    IsFolder: false,
    MediaType: 'Audio',
    columns: { IsInMixedFolder: true, UnratedType: 'Music' },
    initialColumns: { Artists: [], AlbumArtists: [] },
    ...(audioShortcut(candidate) ? { data: { IsShortcut: true } } : {})
  });
}

function albumClaim(candidate) {
  return claim(candidate, musicAlbumNativeType, {
    Name: candidate.entry.name,
    IsFolder: true,
    MediaType: 'Unknown',
    columns: { UnratedType: 'Music' },
    initialColumns: { Artists: [], AlbumArtists: [] }
  }, 'children');
}

function artistClaim(candidate) {
  const name = candidate.entry.name;
  return claim(candidate, musicArtistNativeType, {
    Name: name,
    IsFolder: true,
    MediaType: 'Unknown',
    columns: { UnratedType: 'Music' }
  }, 'children');
}

function strongSnapshot(snapshot) {
  return Array.isArray(snapshot?.candidates) && snapshot.listing?.deletionSafe === true;
}

function directAudioState(snapshot) {
  const files = snapshot.candidates.filter(candidate => candidate?.entry?.kind === 'file');
  return {
    // ContainsMusic includes CUE and PLS, although their leaf handling is
    // respectively ignore and the higher-priority Playlist resolver.
    music: files.some(candidate => isNativeAudioFileName(candidate.entry.name)),
    potential: files.some(potentialAudio),
    artistNfo: snapshot.candidates.some(candidate => candidate.entry.name === 'artist.nfo')
  };
}

async function conventionalAlbum(candidate, peekDirectory, collectionContext) {
  const snapshot = await peekDirectory?.(candidate);
  if (!strongSnapshot(snapshot) || playlistDirectory(candidate, snapshot)) return { snapshot, result: 'withhold' };
  const audio = directAudioState(snapshot);
  const directories = snapshot.candidates.filter(child => child?.entry?.kind === 'directory');
  if (audio.music) return { snapshot, result: 'album' };
  if (audio.potential) return { snapshot, result: 'withhold' };

  // MusicAlbumResolver.ContainsMusic looks only for direct files in each
  // child: one music-bearing disc is enough, empty directories do not count,
  // and a music-bearing non-disc prevents this directory being an album.
  let disc = false, otherAlbum = false;
  for (const child of directories) {
    const override = exactCollectionOverride(collectionContext, child.identityPath);
    if (override != null && override !== 'music') return { snapshot, result: 'withhold' };
    const contents = await peekDirectory?.(child);
    if (!strongSnapshot(contents) || playlistDirectory(child, contents)) return { snapshot, result: 'withhold' };
    const childAudio = directAudioState(contents);
    if (childAudio.music) {
      if (multiPartFolder(child.entry.name)) disc = true;
      else otherAlbum = true;
    }
  }
  return { snapshot, result: disc && !otherAlbum ? 'album' : 'unknown' };
}

/**
 * Resolves ordinary audio files in music collections and conventional layouts:
 *   Album / track.<ordinary audio>
 *   Artist / Album / track.<ordinary audio>
 *   Artist / Albums / Album / track.<ordinary audio>
 *   Album / CD1 / track.<ordinary audio>
 *
 * A direct artist.nfo entry explicitly identifies an Artist without albums.
 * Playlist directories and weak snapshots are withheld so unsupported
 * structural decisions fail visibly.
 */
export function createAudioItemResolver() {
  return Object.freeze({
    id: 'builtin-audio-items',
    priority: 30,
    productionMediaScope: 'music-ordinary-tracks-and-conventional-albums',
    nativeTypes: {
      [audioNativeType]: { isFolder: false },
      [musicAlbumNativeType]: { isFolder: true },
      [musicArtistNativeType]: { isFolder: true }
    },
    async resolveDirectory({ parent, collectionContext, candidate, deletionSafe, peekDirectory }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactMusicOverride = override === 'music';
      const parentTypes = [parent, ...(collectionContext?.parents ?? [])].map(nativeType);
      const hasArtist = parentTypes.includes(musicArtistNativeType);
      const hasAlbum = parentTypes.includes(musicAlbumNativeType);
      if (!resolvableMusicContext(collectionContext) && !exactMusicOverride) {
        return hasArtist || hasAlbum ? withheld : null;
      }
      if (!deletionSafe || override != null && override !== 'music') return withheld;
      const snapshot = await peekDirectory?.(candidate);
      if (!strongSnapshot(snapshot) || playlistDirectory(candidate, snapshot)) return withheld;
      if (hasAlbum) {
        // HasParent includes every physical ancestor, so directories below a
        // disc Folder cannot become a second Album or Artist either.
        return null;
      }
      if (!hasArtist && directAudioState(snapshot).artistNfo) return artistClaim(candidate);
      // Native Artist checks its explicit marker before excluding true roots;
      // Album inference always excludes them. A physical library Folder is not
      // the AggregateFolder/UserRootFolder identified by this flag.
      if (parent?.IsRoot === true) return null;
      if (!hasArtist) {
        // MusicArtistResolver precedes album inference. Named release groups
        // identify the outer Artist even while those groups are empty.
        const groups = snapshot.candidates.filter(child => child?.entry?.kind === 'directory'
          && artistSubfolders.has(child.entry.name.toLowerCase()));
        if (groups.length) {
          for (const group of groups) {
            const groupOverride = exactCollectionOverride(collectionContext, group.identityPath);
            if (groupOverride != null && groupOverride !== 'music') return withheld;
          }
          return artistClaim(candidate);
        }
      }

      const candidateAlbum = await conventionalAlbum(candidate, peekDirectory, collectionContext);
      if (candidateAlbum.result === 'withhold') return withheld;

      // MusicArtistResolver has priority over MusicAlbumResolver when one
      // direct subdirectory is itself a music album, at any physical depth.
      if (!hasArtist) {
        const directories = snapshot.candidates.filter(value => value?.entry?.kind === 'directory'
          && !multiPartFolder(value.entry.name));
        if (directories.length) {
          let hasAlbum = false;
          for (const child of directories) {
            const childOverride = exactCollectionOverride(collectionContext, child.identityPath);
            if (childOverride != null && childOverride !== 'music') return withheld;
            const nested = await conventionalAlbum(child, peekDirectory, collectionContext);
            if (nested.result === 'album') hasAlbum = true;
            else if (nested.result === 'withhold') return withheld;
          }
          if (hasAlbum) return artistClaim(candidate);
        }
      }

      if (candidateAlbum.result === 'album') return albumClaim(candidate);
      // The final native FolderResolver preserves directories that are neither
      // Artists nor Albums. Their children retain the same ancestor context.
      return null;
    },
    resolveFile({ parent, collectionContext, candidate, deletionSafe }) {
      if (cueFile(candidate)) return null;
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactMusicOverride = override === 'music';
      const mixed = collectionContext?.collectionType === null && override == null;
      if (!resolvableMusicContext(collectionContext) && !exactMusicOverride && !mixed) {
        return [musicArtistNativeType, musicAlbumNativeType].includes(nativeType(parent))
          && potentialAudio(candidate) ? withheld : null;
      }
      // Only an untyped collection gives conflicting audio/video extensions
      // to VideoResolver; a music collection continues to create Audio.
      if (mixed && mixedVideoExtensions.has(fileParts(candidate.entry.name).extension)) return null;
      if (override != null && override !== 'music') return potentialAudio(candidate) ? withheld : null;
      if (!deletionSafe) return potentialAudio(candidate) ? withheld : null;
      if (ordinaryAudio(candidate) || audioShortcut(candidate)) return audioClaim(candidate);
      return potentialAudio(candidate) ? withheld : null;
    }
  });
}
