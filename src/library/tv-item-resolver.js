import { sameId } from './records.js';
import { configuredTypeForPath } from './scan-context.js';
import { sameNativePath } from './native-path.js';

export const seriesNativeType = 'MediaBrowser.Controller.Entities.TV.Series';
export const seasonNativeType = 'MediaBrowser.Controller.Entities.TV.Season';
export const episodeNativeType = 'MediaBrowser.Controller.Entities.TV.Episode';

const recognizedVideoExtensions = new Set([
  '.001', '.3g2', '.3gp', '.amv', '.asf', '.asx', '.avi', '.bin', '.bivx', '.divx', '.dv', '.dvr-ms',
  '.disc', '.f4v', '.fli', '.flv', '.ifo', '.img', '.iso', '.m2t', '.m2ts', '.m2v', '.m4v', '.mkv', '.mk3d',
  '.mov', '.mp4', '.mpe', '.mpeg', '.mpg', '.mts', '.mxf', '.nrg', '.nsv', '.nuv', '.ogm', '.ogv',
  '.pva', '.qt', '.rec', '.rm', '.rmvb', '.strm', '.svq3', '.tp', '.ts', '.ty', '.viv', '.vob',
  '.vp3', '.webm', '.wmv', '.wtv', '.xvid'
]);
const ordinaryEpisodeExtensions = new Set([
  '.3g2', '.3gp', '.avi', '.divx', '.f4v', '.flv', '.m2t', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4',
  '.mpe', '.mpeg', '.mpg', '.mts', '.ogv', '.ts', '.webm', '.wmv', '.wtv'
]);
const withheld = Object.freeze({ withhold: true });
const versionToken = /(?:^|[ ._\-[\]()])(?:2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|web[ ._-]?dl|webrip|hdtv|x26[45]|hevc)(?:$|[ ._\-[\]()])/iu;

const nativeType = item => item?.NativeType ?? item?.nativeType ?? item?.Type;

function fileParts(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? { stem: name.slice(0, index), extension: name.slice(index).toLowerCase() }
    : { stem: name, extension: '' };
}

function recognizedVideo(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && recognizedVideoExtensions.has(extension);
}

function exactCollectionOverride(collectionContext, identityPath) {
  const overrides = collectionContext?.contentTypeOverrides;
  return configuredTypeForPath(overrides === undefined ? [] : overrides, identityPath);
}

function resolvableTvContext(collectionContext) {
  return collectionContext?.collectionType === 'tvshows';
}

function parseSeries(candidate) {
  const leaf = candidate?.entry?.name?.trim();
  if (!leaf) return null;
  const year = /^(?<name>.+?)\s*\((?<year>(?:18|19|20|21)\d{2})\)$/u.exec(leaf);
  if (!year) return { name: leaf, year: null };
  const name = year.groups.name.trim();
  return name ? { name, year: Number(year.groups.year) } : null;
}

function parseSeason(candidate) {
  if (candidate?.entry?.kind !== 'directory') return null;
  const match = /^Season (?<index>\d{1,3})$/iu.exec(candidate.entry.name);
  if (!match) return null;
  const index = Number(match.groups.index);
  return Number.isSafeInteger(index) && index > 0 && index <= 199 ? index : null;
}

function episodeMarkers(candidate) {
  if (!recognizedVideo(candidate)) return null;
  const { stem } = fileParts(candidate.entry.name);
  return [...stem.matchAll(/s(?<season>\d{1,3})e(?<episode>\d{1,4})/giu)].map(match => ({
    season: Number(match.groups.season),
    episode: Number(match.groups.episode)
  })).filter(value => Number.isSafeInteger(value.season) && value.season > 0 && value.season <= 199
    && Number.isSafeInteger(value.episode) && value.episode > 0);
}

function episodeMarker(candidate) {
  const markers = episodeMarkers(candidate);
  return markers?.length === 1 ? markers[0] : null;
}

function parseEpisode(candidate) {
  const marker = episodeMarker(candidate);
  if (!marker) return null;
  const { stem, extension } = fileParts(candidate.entry.name);
  if (!ordinaryEpisodeExtensions.has(extension) || versionToken.test(stem)) return null;
  const match = /^(?:(?<prefix>.+?)[ ._-]+)?s(?<season>\d{1,3})e(?<episode>\d{1,4})$/iu.exec(stem);
  if (!match) return null;
  const season = Number(match.groups.season);
  const episode = Number(match.groups.episode);
  return Number.isSafeInteger(season) && season > 0 && season <= 199
    && Number.isSafeInteger(episode) && episode > 0
    ? { name: stem, season, episode } : null;
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

/**
 * Resolves only a proof-carrying conventional TV layout:
 *   Series [(YYYY)] / Season N / [prefix.]SxxEyy.<ordinary video>
 *
 * Flat, special, multi-episode, alternate/version, extra, disc and stream
 * layouts are intentionally withheld until their native ownership rules are
 * implemented as complete units.
 */
export function createTvItemResolver() {
  return Object.freeze({
    id: 'builtin-tv-items',
    priority: 20,
    productionMediaScope: 'conventional-tv-series-season-single-episodes',
    nativeTypes: {
      [seriesNativeType]: { isFolder: true },
      [seasonNativeType]: { isFolder: true },
      [episodeNativeType]: { isFolder: false }
    },
    async resolveDirectory({ parent, root, collectionContext, candidate, candidates, deletionSafe, peekDirectory }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactTvOverride = override === 'tvshows';
      const parentType = nativeType(parent);
      if (!resolvableTvContext(collectionContext) && !exactTvOverride) {
        return [seriesNativeType, seasonNativeType].includes(parentType) ? withheld : null;
      }
      if (!deletionSafe) return withheld;
      if (override != null && override !== 'tvshows') return withheld;

      if (sameId(parent?.Id, root?.Id)) {
        const parsed = parseSeries(candidate);
        if (!parsed) return withheld;
        const snapshot = await peekDirectory?.(candidate);
        if (snapshot?.listing?.deletionSafe !== true
          || !snapshot.candidates.some(child => parseSeason(child) != null)) return withheld;
        return claim(candidate, seriesNativeType, {
          Name: parsed.name,
          IsFolder: true,
          MediaType: 'Unknown',
          ...(parsed.year == null ? {} : { initialColumns: { ProductionYear: parsed.year } })
        }, 'children');
      }

      if (parentType === seriesNativeType) {
        const index = parseSeason(candidate);
        if (index == null) return withheld;
        const duplicate = candidates.filter(value => parseSeason(value) === index).length !== 1;
        if (duplicate) return withheld;
        const snapshot = await peekDirectory?.(candidate);
        if (snapshot?.listing?.deletionSafe !== true) return withheld;
        return claim(candidate, seasonNativeType, {
          Name: candidate.entry.name,
          IsFolder: true,
          MediaType: 'Unknown',
          initialColumns: { IndexNumber: index }
        }, 'children');
      }

      if (parentType === seasonNativeType) return withheld;
      return null;
    },
    resolveFile({ parent, root, collectionContext, candidate, candidates, deletionSafe }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const exactTvOverride = override === 'tvshows';
      const parentType = nativeType(parent);
      if (!resolvableTvContext(collectionContext) && !exactTvOverride) {
        return [seriesNativeType, seasonNativeType].includes(parentType) && recognizedVideo(candidate)
          ? withheld : null;
      }
      if (!deletionSafe) return recognizedVideo(candidate) ? withheld : null;
      if (override != null && override !== 'tvshows') return withheld;
      if (!recognizedVideo(candidate)) return null;
      if (sameId(parent?.Id, root?.Id) || parentType === seriesNativeType) return withheld;
      if (parentType !== seasonNativeType) return null;

      const parsed = parseEpisode(candidate);
      if (!parsed || parsed.season !== parent.IndexNumber) return withheld;
      const duplicates = candidates.filter(value => {
        const markers = episodeMarkers(value) ?? [];
        return markers.some(other => other.season === parsed.season && other.episode === parsed.episode);
      });
      if (duplicates.length !== 1) return withheld;
      return claim(candidate, episodeNativeType, {
        Name: parsed.name,
        IsFolder: false,
        MediaType: 'Video',
        initialColumns: { IndexNumber: parsed.episode, ParentIndexNumber: parsed.season },
        data: { VideoType: 'VideoFile' }
      });
    }
  });
}
