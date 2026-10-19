import path from 'node:path';
import { sameId } from './records.js';
import { configuredTypeForPath } from './scan-context.js';
import { nativeContainingFolderPath, nativeDirectoryName, sameNativePath } from './native-path.js';
import { parseSeasonPath } from '../metadata/season-path.js';
import { resolveEpisodePath } from '../metadata/episode-naming.js';
import episodeNamingOptions from '../metadata/episode-patterns.json' with { type: 'json' };
import { formatComposite } from '../core/composite-format.js';
import { isNativeVideoFileName, isPotentialVideoExtraCandidate, resolveOrdinaryVideoFile, resolveVideoSourceFields, video3DFormatFromPath } from './video-file-resolver.js';

export const seriesNativeType = 'MediaBrowser.Controller.Entities.TV.Series';
export const seasonNativeType = 'MediaBrowser.Controller.Entities.TV.Season';
export const episodeNativeType = 'MediaBrowser.Controller.Entities.TV.Episode';

const withheld = Object.freeze({ withhold: true });
const nativeType = item => item?.NativeType ?? item?.nativeType ?? item?.Type;
const recognizedVideo = candidate => candidate?.entry?.kind === 'file'
  && (isNativeVideoFileName(candidate.entry.name) || episodeNamingOptions.StubFileExtensions
    .some(extension => candidate.entry.name.toLowerCase().endsWith(extension.toLowerCase())));

async function containsSeasonVideo(candidate, peekDirectory) {
  // SeasonResolver checks the raw subtree, before normal item ignore rules.
  const snapshot = await peekDirectory?.(candidate, { forExtras: true });
  if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return null;
  for (const child of snapshot.candidates) {
    if (child.entry.kind !== 'file') continue;
    const name = child.entry.name, dot = name.lastIndexOf('.');
    // This particular native directory search compares extensions exactly.
    if (dot >= 0 && episodeNamingOptions.VideoFileExtensions.includes(name.slice(dot))) return true;
  }
  for (const child of snapshot.candidates) if (child.entry.kind === 'directory') {
    const found = await containsSeasonVideo(child, peekDirectory);
    if (found !== false) return found;
  }
  return false;
}

function directDiscMember(child, directory) {
  const windows = /^[A-Za-z]:[\\/]|^[\\/]{2}/u.test(child.identityPath);
  return sameNativePath(nativeDirectoryName(child.identityPath, { windows }), directory.identityPath)
    && path.posix.dirname(child.accessPath) === path.posix.normalize(directory.accessPath);
}

function episodeDiscClaim(candidate, videoType) {
  const Video3DFormat = video3DFormatFromPath(candidate.identityPath);
  return claim(candidate, episodeNativeType, {
    Name: candidate.entry.name, IsFolder: false, MediaType: 'Video',
    data: { VideoType: videoType, ...(Video3DFormat == null ? {} : { Video3DFormat }) }
  });
}

async function resolveEpisodeFolder(candidate, peekDirectory) {
  if (isPotentialVideoExtraCandidate(candidate)
    || ['video_ts', 'bdmv'].includes(candidate.entry.name.toLowerCase())) return withheld;
  const snapshot = await peekDirectory?.(candidate);
  if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return withheld;
  for (const child of snapshot.candidates) {
    if (child.entry.kind === 'directory' && child.entry.name.toLowerCase() === 'video_ts') {
      if (!directDiscMember(child, candidate)) return withheld;
      // BaseVideoResolver.IsDvdDirectory checks direct files before item ignore filtering.
      const contents = await peekDirectory(child, { forExtras: true });
      if (contents?.listing?.deletionSafe !== true || !Array.isArray(contents.candidates)) return withheld;
      const vob = contents.candidates.find(value => value.entry.kind === 'file'
        && path.posix.extname(value.entry.name).toLowerCase() === '.vob');
      if (vob) {
        if (!directDiscMember(vob, child)) return withheld;
        return episodeDiscClaim(candidate, 'Dvd');
      }
    } else if (child.entry.kind === 'directory' && child.entry.name.toLowerCase() === 'bdmv') {
      return directDiscMember(child, candidate) ? episodeDiscClaim(candidate, 'BluRay') : withheld;
    } else if (child.entry.kind === 'file' && child.entry.name.toLowerCase() === 'video_ts.ifo') return withheld;
  }
  // BaseVideoResolver only resolves directory videos for disc structures.
  // Ordinary directories retain their Folder identity and physical children.
  if (snapshot.candidates.some(child => child.entry.kind === 'directory'
    ? ['video_ts', 'bdmv'].includes(child.entry.name.toLowerCase())
    : child.entry.kind === 'file' && child.entry.name.toLowerCase() === 'video_ts.ifo')) return withheld;
  return null;
}

function exactCollectionOverride(collectionContext, identityPath) {
  return configuredTypeForPath(collectionContext?.contentTypeOverrides ?? [], identityPath);
}

function parseSeries(candidate) {
  const leaf = candidate?.entry?.name;
  if (!leaf) return null;
  const year = /(?<name>.+?)\s*\((?<year>[0-9]{4})\)/u.exec(leaf);
  if (year) return { name: year.groups.name.trim(), year: Number(year.groups.year) };
  return { name: leaf.replace(/(?<=[^\s._]{2})[._]+|[._]+(?=[^\s._]{2})/gu, ' ').trim(), year: null };
}

function isMixedSeries(candidate, children) {
  if (children.some(child => child.entry.name === 'tvshow.nfo')) return true;
  return children.some(child => child.entry.kind === 'directory'
    ? parseSeasonPath(child.identityPath, candidate.identityPath, {
      supportSpecialAliases: false, supportNumericSeasonFolders: false
    }).SeasonNumber != null
    // SeriesResolver tests the containing directory's extension in this branch.
    : isNativeVideoFileName(candidate.identityPath)
      && resolveEpisodePath(child.identityPath, { named: true, optimistic: false })?.EpisodeNumber != null);
}

function claim(candidate, type, draft, traversal = 'none') {
  return { nativeType: type, primary: candidate, consumedPaths: [candidate], traversal,
    draft: { ...draft, SourceType: 'Library' } };
}

/** TV files and single disc directories retain their physical parent. Episode numbering and
 * virtual-season association belong to the existing metadata lifecycle, which
 * also observes Series display order, sidecars and multi-episode ranges. */
export function createTvItemResolver({ localization, classifyIso, logger } = {}) {
  return Object.freeze({
    id: 'builtin-tv-items',
    priority: 20,
    productionMediaScope: 'tv-ordinary-video-files',
    nativeTypes: {
      [seriesNativeType]: { isFolder: true },
      [seasonNativeType]: { isFolder: true },
      [episodeNativeType]: { isFolder: false }
    },
    async resolveDirectory({ parent, root, collectionContext, candidate, deletionSafe, peekDirectory }) {
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const parentType = nativeType(parent);
      const hasTvParent = [parent, ...(collectionContext?.parents ?? [])]
        .some(value => [seriesNativeType, seasonNativeType].includes(nativeType(value)));
      const mixed = collectionContext?.collectionType === null && override == null;
      if (collectionContext?.collectionType !== 'tvshows' && override !== 'tvshows' && !mixed) {
        return hasTvParent ? withheld : null;
      }
      if (!deletionSafe || override != null && override !== 'tvshows') return withheld;

      if (mixed && !hasTvParent) {
        if (parent?.IsRoot === true) return null;
        const snapshot = await peekDirectory?.(candidate, { forExtras: true });
        if (snapshot?.listing?.deletionSafe !== true || !Array.isArray(snapshot.candidates)) return withheld;
        if (!isMixedSeries(candidate, snapshot.candidates)) return null;
        const parsed = parseSeries(candidate);
        if (!parsed?.name) return withheld;
        return claim(candidate, seriesNativeType, {
          Name: parsed.name, IsFolder: true, MediaType: 'Unknown'
        }, 'children');
      }

      if (!hasTvParent && sameId(parent?.Id, root?.Id)) {
        const parsed = parseSeries(candidate);
        if (!parsed?.name) return withheld;
        const snapshot = await peekDirectory?.(candidate);
        if (snapshot?.listing?.deletionSafe !== true) return withheld;
        return claim(candidate, seriesNativeType, {
          Name: parsed.name, IsFolder: true, MediaType: 'Unknown',
          ...(parsed.year == null ? {} : { initialColumns: { ProductionYear: parsed.year } })
        }, 'children');
      }

      if (parentType === seriesNativeType) {
        const parsed = parseSeasonPath(candidate.identityPath, nativeContainingFolderPath(parent));
        if (parsed.SeasonNumber == null || !parsed.IsSeasonFolder) {
          const episode = resolveEpisodePath('\\\\test\\' + candidate.entry.name, { directory: true });
          if (episode?.EpisodeNumber != null && episode.SeasonNumber != null) {
            return resolveEpisodeFolder(candidate, peekDirectory);
          }
          const containsVideo = await containsSeasonVideo(candidate, peekDirectory);
          if (containsVideo === false) return resolveEpisodeFolder(candidate, peekDirectory);
          if (containsVideo !== true) return withheld;
        } else {
          const snapshot = await peekDirectory?.(candidate);
          if (snapshot?.listing?.deletionSafe !== true) return withheld;
        }
        const index = parsed.SeasonNumber;
        const options = collectionContext?.libraryOptions ?? {};
        const name = index == null ? candidate.entry.name
          : index === 0 ? Object.hasOwn(options, 'SeasonZeroDisplayName') ? options.SeasonZeroDisplayName : 'Specials'
          : formatComposite(localization?.text('NameSeasonNumber') ?? 'Season {0}', [index]);
        return claim(candidate, seasonNativeType, {
          Name: name || candidate.entry.name,
          IsFolder: true, MediaType: 'Unknown', initialColumns: { IndexNumber: index }
        }, 'children');
      }

      if (hasTvParent) return resolveEpisodeFolder(candidate, peekDirectory);
      return null;
    },
    async resolveFile({ parent, collectionContext, candidate, deletionSafe, signal }) {
      if (parent == null) return null;
      const override = exactCollectionOverride(collectionContext, candidate.identityPath);
      const hasTvParent = [parent, ...(collectionContext?.parents ?? [])]
        .some(value => [seriesNativeType, seasonNativeType].includes(nativeType(value)));
      const mixedTvParent = collectionContext?.collectionType === null && override == null && hasTvParent;
      if (collectionContext?.collectionType !== 'tvshows' && override !== 'tvshows' && !mixedTvParent) {
        return hasTvParent && recognizedVideo(candidate) ? withheld : null;
      }
      if (!recognizedVideo(candidate)) return null;
      if (!deletionSafe || override != null && override !== 'tvshows') return withheld;
      const video = resolveOrdinaryVideoFile(candidate, { nativeType: episodeNativeType });
      if (!video) return withheld;
      if (video.ExtraType != null) return null;
      return claim(candidate, episodeNativeType, {
        Name: video.Name, IsFolder: false, MediaType: 'Video',
        data: { ...await resolveVideoSourceFields(candidate, { classifyIso, logger, signal }),
          ...(video.Video3DFormat == null ? {} : { Video3DFormat: video.Video3DFormat }) }
      });
    }
  });
}
