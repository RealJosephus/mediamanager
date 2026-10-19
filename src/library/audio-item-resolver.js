import { sameId } from './records.js';
import { configuredTypeForPath } from './scan-context.js';
import { sameNativePath } from './native-path.js';

export const audioNativeType = 'MediaBrowser.Controller.Entities.Audio.Audio';
export const musicAlbumNativeType = 'MediaBrowser.Controller.Entities.Audio.MusicAlbum';
export const musicArtistNativeType = 'MediaBrowser.Controller.Entities.Audio.MusicArtist';

// These ordinary formats have no native playlist, cue, shortcut or video
// resolver precedence in a music collection. The wider native audio extension
// set remains recognized below so unsupported shapes are withheld rather than
// falling through as an apparently complete scan.
const ordinaryAudioExtensions = new Set([
  '.669', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf', '.aif',
  '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.dmf', '.dsf', '.dsm',
  '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym', '.hps', '.imf',
  '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg', '.mp2', '.mp3',
  '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.oga', '.ogg', '.okt', '.opus', '.ra',
  '.rf64', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.ult', '.uni', '.vox', '.wav', '.wma', '.wv',
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
const videoExtensions = new Set([
  '.001', '.3g2', '.3gp', '.amv', '.asf', '.asx', '.avi', '.bin', '.bivx', '.disc', '.divx', '.dv',
  '.dvr-ms', '.f4v', '.fli', '.flv', '.ifo', '.img', '.iso', '.m2t', '.m2ts', '.m2v', '.m4v',
  '.mkv', '.mk3d', '.mov', '.mp4', '.mpe', '.mpeg', '.mpg', '.mts', '.mxf', '.nrg', '.nsv', '.nuv',
  '.ogm', '.ogv', '.pva', '.qt', '.rec', '.rm', '.rmvb', '.strm', '.svq3', '.tp', '.ts', '.ty',
  '.viv', '.vob', '.vp3', '.webm', '.wmv', '.wtv', '.xvid'
]);
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

function potentialAudio(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && (nativeAudioExtensions.has(extension) || playlistExtensions.has(extension));
}

function conflictingMedia(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const extension = fileParts(candidate.entry.name).extension;
  return potentialAudio(candidate) && !ordinaryAudio(candidate) || videoExtensions.has(extension);
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
  // These are not native AlbumParser positives, but remain conservatively
  // withheld until non-native naming collisions have an explicit contract.
  return /^(?:dvd|pt)[ ._-]*(?:\d+|[a-d])(?:$|[ ._()[\]-])/iu.test(name)
    || /^(?:cd|disc|disk|part|vol|volume|act)[ ._-]*[a-d](?:$|[ ._()[\]-])/iu.test(name);
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
    initialColumns: { Artists: [], AlbumArtists: [] }
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
    ordinary: files.some(ordinaryAudio),
    potential: files.some(potentialAudio),
    artistNfo: files.some(candidate => candidate.entry.name.toLowerCase() === 'artist.nfo')
  };
}

async function conventionalAlbum(candidate, peekDirectory) {
  const snapshot = await peekDirectory?.(candidate);
  if (!strongSnapshot(snapshot) || playlistDirectory(candidate, snapshot)) return { snapshot, result: 'withhold' };
  const audio = directAudioState(snapshot);
  const directories = snapshot.candidates.filter(child => child?.entry?.kind === 'directory');
  const conflict = snapshot.candidates.some(conflictingMedia);
  if (directories.length) {
    if (audio.ordinary || audio.potential || audio.artistNfo || conflict
      || directories.some(child => multiPartFolder(child.entry.name))) {
      return { snapshot, result: 'withhold' };
    }
    return { snapshot, result: 'unknown' };
  }
  if (conflict) return { snapshot, result: 'withhold' };
  if (audio.ordinary && !audio.artistNfo) return { snapshot, result: 'album' };
  if (audio.potential || audio.artistNfo) return { snapshot, result: 'withhold' };
  return { snapshot, result: 'unknown' };
}

/**
 * Resolves only proof-carrying conventional music layouts:
 *   Album / track.<ordinary audio>
 *   Artist / Album / track.<ordinary audio>
 *
 * Native-but-unimplemented audio formats, playlists, artist.nfo, special
 * artist groupings, multi-disc layouts, shortcuts and uncertain hierarchy are
 * withheld so they make structural completeness fail visibly.
 */
export function createAudioItemResolver() {
  return Object.freeze({
    id: 'builtin-audio-items',
    priority: 30,
    productionMediaScope: 'conventional-music-artist-album-tracks',
    nativeTypes: {
      [audioNativeType]: { isFolder: false },
      [musicAlbumNativeType]: { isFolder: true },
      [musicArtistNativeType]: { isFolder: true }
    },
    async resolveDirectory({ parent, root, collectionContext, candidate, deletionSafe, peekDirectory }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactMusicOverride = override === 'music';
      const parentType = nativeType(parent);
      if (!resolvableMusicContext(collectionContext) && !exactMusicOverride) {
        return [musicArtistNativeType, musicAlbumNativeType].includes(parentType) ? withheld : null;
      }
      if (!deletionSafe || override != null && override !== 'music') return withheld;
      if (parentType === musicAlbumNativeType) return withheld;
      if (!sameId(parent?.Id, root?.Id) && parentType !== musicArtistNativeType) return withheld;

      const candidateAlbum = await conventionalAlbum(candidate, peekDirectory);
      if (candidateAlbum.result === 'withhold') return withheld;
      const snapshot = candidateAlbum.snapshot;
      if (snapshot.candidates.some(child => child?.entry?.kind === 'directory'
        && artistSubfolders.has(child.entry.name.toLowerCase()))) return withheld;

      // MusicArtistResolver has priority over MusicAlbumResolver and claims a
      // root child when one direct subdirectory is itself a music album.
      if (sameId(parent?.Id, root?.Id)) {
        const directories = snapshot.candidates.filter(value => value?.entry?.kind === 'directory');
        if (directories.length) {
          for (const child of directories) {
            const childOverride = exactCollectionOverride(collectionContext, child.identityPath);
            if (childOverride != null && childOverride !== 'music') return withheld;
            const nested = await conventionalAlbum(child, peekDirectory);
            if (nested.result !== 'album') return withheld;
          }
          return artistClaim(candidate);
        }
      }

      if (candidateAlbum.result === 'album') return albumClaim(candidate);
      // This narrow first slice deliberately does not persist a generic Folder
      // for an unresolved music hierarchy; a later strong scan may classify it
      // as Artist, Album, playlist or multi-disc album.
      return withheld;
    },
    resolveFile({ parent, root, collectionContext, candidate, deletionSafe }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactMusicOverride = override === 'music';
      if (!resolvableMusicContext(collectionContext) && !exactMusicOverride) {
        return [musicArtistNativeType, musicAlbumNativeType].includes(nativeType(parent))
          && potentialAudio(candidate) ? withheld : null;
      }
      if (override != null && override !== 'music') return potentialAudio(candidate) ? withheld : null;
      if (!deletionSafe) return potentialAudio(candidate) ? withheld : null;
      if (!sameId(parent?.Id, root?.Id)
        && ![musicArtistNativeType, musicAlbumNativeType].includes(nativeType(parent))) {
        return potentialAudio(candidate) ? withheld : null;
      }
      if (nativeType(parent) !== musicAlbumNativeType) return potentialAudio(candidate) ? withheld : null;
      if (ordinaryAudio(candidate)) return audioClaim(candidate);
      return potentialAudio(candidate) ? withheld : null;
    }
  });
}
