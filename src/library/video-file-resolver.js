import path from 'node:path';
import { cleanMetadataName, parseMetadataName } from '../metadata/naming.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { audioNativeType } from './audio-item-resolver.js';
import { nativeDirectoryName, nativeFileName, sameNativePath } from './native-path.js';
import { sameId } from './records.js';
import { configuredTypeForPath } from './scan-context.js';
import { resolveEpisodePath } from '../metadata/episode-naming.js';
import episodeNamingOptions from '../metadata/episode-patterns.json' with { type: 'json' };
import { checkAbort } from '../storage/errors.js';
import { preserveResolutionReadFailure } from './directory-item-resolver.js';

export const videoNativeType = 'MediaBrowser.Controller.Entities.Video';
export const movieNativeType = 'MediaBrowser.Controller.Entities.Movies.Movie';
export const musicVideoNativeType = 'MediaBrowser.Controller.Entities.MusicVideo';
export const trailerNativeType = 'MediaBrowser.Controller.Entities.Trailer';
const episodeNativeType = 'MediaBrowser.Controller.Entities.TV.Episode';

const videoExtensions = new Set([
  '.001', '.3g2', '.3gp', '.amv', '.asf', '.asx', '.avi', '.bin', '.bivx', '.divx', '.dv', '.dvr-ms',
  '.f4v', '.fli', '.flv', '.ifo', '.img', '.iso', '.m2t', '.m2ts', '.m2v', '.m4v', '.mkv', '.mk3d', '.mov', '.mp4',
  '.mpe', '.mpeg', '.mpg', '.mts', '.mxf', '.nrg', '.nsv', '.nuv', '.ogm', '.ogv', '.pva', '.qt', '.rec',
  '.rm', '.rmvb', '.strm', '.svq3', '.tp', '.ts', '.ty', '.viv', '.vob', '.vp3', '.webm', '.wmv', '.wtv', '.xvid'
]);
const stubExtensions = new Set(episodeNamingOptions.StubFileExtensions.map(extension => extension.toLowerCase()));
const nativeVideoFileExtensions = new Set(videoExtensions);
const audioExtensions = new Set([
  '.669', '.3gp', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf',
  '.aif', '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.cue', '.dmf',
  '.dsf', '.dsm', '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym',
  '.hps', '.imf', '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg',
  '.mp2', '.mp3', '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.nsv', '.oga', '.ogg',
  '.okt', '.opus', '.pls', '.ra', '.rf64', '.rm', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.strm',
  '.ult', '.uni', '.vox', '.wav', '.wma', '.wv', '.xm', '.xsp', '.ymf'
]);
const extraRules = Object.freeze([
  ['DirectoryName', 'trailers', 2, 'Video'], ['DirectoryName', 'backdrops', 9, 'Video'],
  ['DirectoryName', 'theme-music', 8, 'Audio'], ['DirectoryName', 'behind the scenes', 3, 'Video'],
  ['DirectoryName', 'deleted scenes', 4, 'Video'], ['DirectoryName', 'interviews', 5, 'Video'],
  ['DirectoryName', 'scenes', 6, 'Video'], ['DirectoryName', 'samples', 7, 'Video'],
  ['DirectoryName', 'shorts', 11, 'Video'], ['DirectoryName', 'featurettes', 10, 'Video'],
  ['DirectoryName', 'extras', 0, 'Video'], ['DirectoryName', 'extra', 0, 'Video'],
  ['DirectoryName', 'other', 0, 'Video'], ['DirectoryName', 'clips', 1, 'Video'],
  ['Filename', 'trailer', 2, 'Video'], ['Filename', 'sample', 7, 'Video'],
  ['Filename', 'theme', 8, 'Audio'],
  ['Suffix', '-trailer', 2, 'Video'], ['Suffix', '.trailer', 2, 'Video'],
  ['Suffix', '_trailer', 2, 'Video'], ['Suffix', '- trailer', 2, 'Video'],
  ['Suffix', '-sample', 7, 'Video'], ['Suffix', '.sample', 7, 'Video'],
  ['Suffix', '_sample', 7, 'Video'], ['Suffix', '- sample', 7, 'Video'],
  ['Suffix', '-scene', 6, 'Video'], ['Suffix', '-clip', 1, 'Video'],
  ['Suffix', '-interview', 5, 'Video'], ['Suffix', '-behindthescenes', 3, 'Video'],
  ['Suffix', '-deleted', 4, 'Video'], ['Suffix', '-deletedscene', 4, 'Video'],
  ['Suffix', '-featurette', 10, 'Video'], ['Suffix', '-short', 11, 'Video'],
  ['Suffix', '-extra', 0, 'Video'], ['Suffix', '-other', 0, 'Video']
].map(([ruleType, token, extraType, mediaType]) => Object.freeze({ ruleType, token, extraType, mediaType })));
const extraTypeNames = Object.freeze([
  'Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample',
  'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'
]);
const extraTypeResourceKeys = Object.freeze([
  'NameExtraUnknown', 'NameExtraClip', 'NameExtraTrailer', 'NameExtraBehindTheScenes',
  'NameExtraDeletedScene', 'NameExtraInterview', 'NameExtraScene', 'NameExtraSample', 'NameExtraThemeSong',
  'NameExtraThemeVideo', 'NameExtraFeaturette', 'NameExtraShort'
]);
const englishExtraNames = Object.freeze([
  'Extra', 'Clip', 'Trailer', 'Behind The Scenes', 'Deleted Scene', 'Interview', 'Scene', 'Sample',
  'Theme Song', 'Theme Video', 'Featurette', 'Short'
]);
const extraSuffixes = [
  '-trailer', '.trailer', '_trailer', '- trailer', '-sample', '.sample', '_sample', '- sample', '-scene',
  '-clip', '-interview', '-behindthescenes', '-deleted', '-deletedscene', '-featurette', '-short', '-extra', '-other'
];
const extrasFolderNames = new Set([
  'trailers', 'backdrops', 'theme-music', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes',
  'samples', 'shorts', 'featurettes', 'extras', 'extra', 'other', 'clips'
]);
const stackPattern = /^(.*?)(?:(?<=[\]\)}])|[ _.-]+)[([]?(cd|dvd|part|pt|disc|disk)[ _.-]*([0-9]+|[a-d])[)\]]?$/iu;
const directoryStackPattern = /^(.*?)(?:(?<=[\]\)}])|[ _.-]+)[([]?(cd|dvd|part|pt|disc|disk)[ _.-]*([0-9]+|[a-d])[)\]]?(?:\.[^.]+)?$/iu;
const withheld = Object.freeze({ withhold: true });
const weakDiscObservation = Symbol('weak-disc-observation');
const currentCultureComparer = new Intl.Collator(undefined, { sensitivity: 'variant' });

const format3DRules = Object.freeze([
  ['3d', 'hsbs'], ['3d', 'sbs'], ['3d', 'htab'], ['3d', 'tab'],
  [null, 'fsbs'], [null, 'hsbs'], [null, 'sbs'], [null, 'ftab'],
  [null, 'htab'], [null, 'tab'], [null, 'sbs3d'], [null, 'mvc']
]);
const video3DFormats = Object.freeze({ fsbs: 'FullSideBySide', ftab: 'FullTopAndBottom',
  hsbs: 'HalfSideBySide', sbs: 'HalfSideBySide', sbs3d: 'HalfSideBySide',
  htab: 'HalfTopAndBottom', tab: 'HalfTopAndBottom', mvc: 'MVC' });

/** Frozen Format3DParser token boundaries and ordered rule precedence. */
export function video3DFormatFromPath(identityPath) {
  const tokens = String(identityPath).split(/[()._\[\]\- ]/u);
  for (const [prefix, token] of format3DRules) {
    let foundPrefix = prefix == null;
    for (const value of tokens) {
      if (!foundPrefix) {
        foundPrefix = ordinalIgnoreCaseEquals(value, prefix);
        continue;
      }
      if (ordinalIgnoreCaseEquals(value, token)) return video3DFormats[token];
    }
  }
  return null;
}

function fileParts(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? { stem: name.slice(0, index), extension: name.slice(index).toLowerCase() }
    : { stem: name, extension: '' };
}

function videoSourceFields(name, identityPath = name) {
  const { stem, extension } = fileParts(name);
  if (extension === '.iso' || extension === '.img') return { VideoType: 'Iso',
    IsoType: /dvd/iu.test(identityPath) ? 'Dvd' : /bluray/iu.test(identityPath) ? 'BluRay' : null };
  if (stubExtensions.has(extension)) {
    const token = fileParts(stem).extension.slice(1);
    const type = episodeNamingOptions.StubTypes.find(rule => ordinalIgnoreCaseEquals(token, rule.Token))?.StubType;
    return { VideoType: type === 'dvd' ? 'Dvd' : type === 'bluray' ? 'BluRay' : 'VideoFile', IsPlaceHolder: true };
  }
  return { VideoType: 'VideoFile', ...(extension === '.strm' ? { IsShortcut: true } : {}) };
}

export async function resolveVideoSourceFields(candidate, { classifyIso, logger = {}, signal } = {}) {
  const fields = videoSourceFields(candidate.entry.name, candidate.identityPath);
  if (fields.VideoType !== 'Iso') return fields;
  checkAbort(signal);
  if (fields.IsoType != null) return fields;
  if (typeof classifyIso !== 'function') throw preserveResolutionReadFailure(new TypeError('ISO resolution requires a storage classifier.'));
  let type;
  try {
    type = await classifyIso(candidate, { signal });
    checkAbort(signal);
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError' || ['cancelled', 'version-changed'].includes(error.code)) throw preserveResolutionReadFailure(error);
    logger.error?.(error, `Error opening UDF/ISO image: ${candidate.identityPath}`);
    return fields;
  }
  if (type != null && !['Dvd', 'BluRay'].includes(type)) throw preserveResolutionReadFailure(new TypeError('The ISO classifier returned an invalid disc type.'));
  return { ...fields, IsoType: type ?? null };
}

export function isNativeVideoFileName(name) {
  const { stem, extension } = fileParts(String(name));
  return Boolean(stem) && nativeVideoFileExtensions.has(extension);
}

const pathApiFor = value => String(value).includes('\\') ? path.win32 : path.posix;
const ordinalIgnoreCase = (left, right) => ordinalIgnoreCaseEquals(String(left), String(right));
const startsWithOrdinalIgnoreCase = (value, prefix) => prefix.length <= value.length
  && ordinalIgnoreCase(value.slice(0, prefix.length), prefix);
const endsWithOrdinalIgnoreCase = (value, suffix) => suffix.length <= value.length
  && ordinalIgnoreCase(value.slice(value.length - suffix.length), suffix);

function trimVideoFlagDelimiters(value) {
  let result = String(value ?? '').trimEnd();
  while (result && '()-._[]'.includes(result.at(-1))) result = result.slice(0, -1);
  return result.trimEnd();
}

function matchedExtraRule(candidatePath, libraryRoot = '') {
  const api = pathApiFor(candidatePath);
  const { extension, stem } = fileParts(api.basename(candidatePath));
  const trimmedStem = stem.replace(/[0-9]+$/u, '');
  const directory = api.dirname(candidatePath);
  const directoryName = api.basename(directory);
  for (const rule of extraRules) {
    if (rule.mediaType === 'Audio' ? !audioExtensions.has(extension) : !videoExtensions.has(extension)) continue;
    const match = rule.ruleType === 'Filename' ? ordinalIgnoreCase(stem, rule.token)
      : rule.ruleType === 'Suffix' ? endsWithOrdinalIgnoreCase(trimmedStem, rule.token)
        : ordinalIgnoreCase(directoryName, rule.token) && !ordinalIgnoreCase(directory, libraryRoot);
    if (match) return rule;
  }
  return null;
}

export function isPotentialVideoExtraCandidate(candidate) {
  if (!candidate?.entry || typeof candidate.identityPath !== 'string') return false;
  return candidate.entry.kind === 'directory'
    ? extrasFolderNames.has(candidate.entry.name.toLowerCase())
    : candidate.entry.kind === 'file' && matchedExtraRule(candidate.identityPath) != null;
}

/**
 * Portable projection of the frozen ExtraRuleResolver and
 * ExtraResolver.TryGetExtraTypeForOwner naming contract. The native fixture
 * pins this helper independently from scan ownership and persistence.
 */
export function resolveVideoExtraCandidate(ownerPath, candidatePath, { libraryRoot = '', ownerIsDirectory = false } = {}) {
  const ownerApi = pathApiFor(ownerPath), candidateApi = pathApiFor(candidatePath);
  const ownerExtension = ownerApi.extname(ownerPath);
  const candidateExtension = candidateApi.extname(candidatePath);
  const ownerStem = ownerApi.basename(ownerPath, ownerExtension);
  const candidateStem = candidateApi.basename(candidatePath, candidateExtension);
  const owner = parseMetadataName(ownerStem);
  const resolved = parseMetadataName(candidateStem);
  const rule = matchedExtraRule(candidatePath, libraryRoot);
  if (!rule) return Object.freeze({
    valid: false, extraType: null, extraTypeValue: null, ruleType: null, ruleToken: null,
    resolvedName: videoExtensions.has(candidateExtension.toLowerCase()) ? resolved.Name : null,
    resolvedYear: videoExtensions.has(candidateExtension.toLowerCase()) ? resolved.Year : null,
    nativeType: null
  });
  const candidateName = trimVideoFlagDelimiters(resolved.Name);
  const rawOwnerName = trimVideoFlagDelimiters(ownerStem);
  const parsedOwnerName = trimVideoFlagDelimiters(owner.Name);
  let valid = Boolean(rawOwnerName) && startsWithOrdinalIgnoreCase(candidateName, rawOwnerName)
    || Boolean(parsedOwnerName) && startsWithOrdinalIgnoreCase(candidateName, parsedOwnerName)
      && resolved.Year === owner.Year;
  if (!valid) {
    const candidateParent = rule.ruleType === 'DirectoryName'
      ? candidateApi.dirname(candidateApi.dirname(candidatePath)) : candidateApi.dirname(candidatePath);
    const ownerDirectory = ownerIsDirectory ? ownerPath : ownerApi.dirname(ownerPath);
    valid = Boolean(candidateParent) && Boolean(ownerDirectory) && ordinalIgnoreCase(candidateParent, ownerDirectory);
  }
  const nativeType = rule.extraType === 2 ? trailerNativeType
    : rule.extraType === 8 ? audioNativeType : videoNativeType;
  return Object.freeze({
    valid,
    extraType: extraTypeNames[rule.extraType],
    extraTypeValue: rule.extraType,
    ruleType: rule.ruleType,
    ruleToken: rule.token,
    resolvedName: resolved.Name,
    resolvedYear: resolved.Year,
    nativeType
  });
}

function extraVideo(stem, extension) {
  const lower = stem.toLowerCase();
  const trimmed = lower.replace(/[0-9]+$/u, '');
  return /\bsample\b/iu.test(stem) || !stubExtensions.has(extension)
    && (['trailer', 'sample'].includes(lower) || extraSuffixes.some(suffix => trimmed.endsWith(suffix)));
}

function recognizedVideo(candidate) {
  if (candidate?.entry?.kind !== 'file') return false;
  const { stem, extension } = fileParts(candidate.entry.name);
  return Boolean(stem) && (videoExtensions.has(extension) || stubExtensions.has(extension));
}

function stackMetadata(candidate) {
  if (!recognizedVideo(candidate)) return null;
  const { stem, extension } = fileParts(candidate.entry.name);
  if (extraVideo(stem, extension)) return null;
  const match = stackPattern.exec(stem);
  if (!match) return null;
  return {
    name: match[1],
    partType: match[2],
    partNumber: match[3],
    numerical: /^\d+$/u.test(match[3])
  };
}

function resolveFileStacks(candidates) {
  const groups = new Map();
  const ordered = candidates.filter(recognizedVideo).toSorted((left, right) =>
    left.identityPath < right.identityPath ? -1 : left.identityPath > right.identityPath ? 1 : 0);
  for (const candidate of ordered) {
    const metadata = stackMetadata(candidate);
    if (!metadata) continue;
    let group = groups.get(metadata.name);
    if (!group) {
      group = { name: metadata.name, numerical: metadata.numerical,
        partType: metadata.partType, partNumbers: new Set(), files: [] };
      groups.set(metadata.name, group);
    }
    const numberKey = metadata.partNumber.toLowerCase();
    if (group.files.length && (!ordinalIgnoreCase(group.partType, metadata.partType)
      || group.partNumbers.has(numberKey) || group.numerical !== metadata.numerical)) continue;
    group.partNumbers.add(numberKey);
    group.files.push(candidate);
  }
  return [...groups.values()].filter(group => group.files.length > 1);
}

function resolveDirectoryStacks(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const match = directoryStackPattern.exec(candidate.entry.name);
    if (!match) continue;
    const metadata = {
      name: match[1],
      partType: match[2],
      partNumber: match[3],
      numerical: /^\d+$/u.test(match[3])
    };
    let group = groups.get(metadata.name);
    if (!group) {
      group = { name: metadata.name, numerical: metadata.numerical,
        partType: metadata.partType, partNumbers: new Set(), directories: [] };
      groups.set(metadata.name, group);
    }
    const numberKey = metadata.partNumber.toLowerCase();
    if (group.directories.length && (!ordinalIgnoreCase(group.partType, metadata.partType)
      || group.partNumbers.has(numberKey) || group.numerical !== metadata.numerical)) continue;
    group.partNumbers.add(numberKey);
    group.directories.push(candidate);
  }
  return [...groups.values()].filter(group => group.directories.length > 1);
}

// The single-path GenericVideoResolver contract is separate from the scan's
// multi-item grouping/consumption contract. Neither may infer the other's role.
export function resolveOrdinaryVideoFile(candidate, { nativeType = videoNativeType, parseName = false } = {}) {
  if (!recognizedVideo(candidate)) return null;
  const { stem } = fileParts(candidate.entry.name);
  const extra = matchedExtraRule(candidate.identityPath);
  const name = extra?.ruleType === 'Suffix' && endsWithOrdinalIgnoreCase(stem, extra.token)
    ? stem.slice(0, -extra.token.length) : stem;
  const parsed = parseName ? parseMetadataName(name) : { Name: name, Year: null };
  const Video3DFormat = video3DFormatFromPath(candidate.identityPath);
  return { NativeType: nativeType, Type: nativeType.split('.').at(-1), Path: candidate.identityPath,
    Name: parsed.Name, ProductionYear: parsed.Year, ...videoSourceFields(candidate.entry.name, candidate.identityPath),
    ...(Video3DFormat == null ? {} : { Video3DFormat }),
    ExtraType: extra ? extraTypeNames[extra.extraType] : null };
}

export function additionalVideoStackParts(identityPath, candidates) {
  return resolveFileStacks(candidates).find(stack => ordinalIgnoreCase(stack.files[0].identityPath, identityPath))
    ?.files.slice(1).map(candidate => candidate.identityPath) ?? [];
}

function discStructure(parent, root) {
  if (typeof parent?.Path !== 'string' || typeof root?.Path !== 'string') return false;
  const relative = parent.Path.slice(root.Path.length).replaceAll('\\', '/');
  return relative.split('/').some(segment => ['video_ts', 'bdmv'].includes(segment.toLowerCase()));
}

function pathLeaf(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? '';
}

function numericOrdinalCompare(left, right) {
  const leftParts = String(left).match(/\d+|\D+/gu) ?? [];
  const rightParts = String(right).match(/\d+|\D+/gu) ?? [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] == null) return -1;
    if (rightParts[index] == null) return 1;
    const leftPart = leftParts[index], rightPart = rightParts[index];
    if (/^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart)) {
      const leftNumber = BigInt(leftPart), rightNumber = BigInt(rightPart);
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
      if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length;
    } else {
      const foldedLeft = leftPart.toLowerCase(), foldedRight = rightPart.toLowerCase();
      if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
      if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

const resolutionMatch = candidate => /[0-9]{3,}[ip]/iu.exec(fileParts(candidate.entry.name).stem)?.[0] ?? null;

function eligibleMovieVersion(prefix, candidate) {
  const { stem } = fileParts(candidate.entry.name);
  if (!startsWithOrdinalIgnoreCase(stem, prefix)) return false;
  const remainder = clrTrim(cleanMetadataName(clrTrim(stem.slice(prefix.length))));
  return !remainder || ['-', '_', '.'].includes(remainder[0]) || /^\[[^\]]*\]/u.test(remainder);
}

function organizeAlternateVersions(groups, primaryOverride, nameOverride) {
  const resolution = groups.filter(group => resolutionMatch(group.primary) != null).sort((left, right) => {
    const byResolution = numericOrdinalCompare(resolutionMatch(right.primary), resolutionMatch(left.primary));
    return byResolution || numericOrdinalCompare(fileParts(left.primary.entry.name).stem,
      fileParts(right.primary.entry.name).stem);
  });
  const other = groups.filter(group => resolutionMatch(group.primary) == null)
    .sort((left, right) => numericOrdinalCompare(fileParts(left.primary.entry.name).stem,
      fileParts(right.primary.entry.name).stem));
  const ordered = [...resolution, ...other];
  const primary = primaryOverride ?? ordered.find(group => group.parts.length) ?? ordered[0];
  return { ...primary, ...(nameOverride == null ? {} : { name: nameOverride }),
    alternates: ordered.filter(group => group !== primary) };
}

function organizeMovieGroups(parent, groups) {
  const prefix = pathLeaf(parent?.Path);
  if (!prefix || prefix.length <= 1 || !groups.length) return groups;
  if (groups.some(group => group.year !== groups[0].year || !eligibleMovieVersion(prefix, group.primary))) return groups;
  const exact = groups.find(group => fileParts(group.primary.entry.name).stem === prefix);
  return [organizeAlternateVersions(groups, exact, prefix)];
}

function organizeEpisodeGroups(groups) {
  const result = [], episodes = new Map();
  for (const group of groups) {
    // Guessed episode numbers must not merge physically separate episodes.
    const episode = resolveEpisodePath(group.primary.identityPath, { optimistic: false });
    const key = episode?.IsByDate
      ? episode.Year != null && episode.Month != null && episode.Day != null
        ? `D${episode.Year}${String(episode.Month).padStart(2, '0')}${String(episode.Day).padStart(2, '0')}` : null
      : episode?.SeasonNumber != null && episode.EpisodeNumber != null
        ? `S${episode.SeasonNumber}E${episode.EpisodeNumber}` : null;
    if (key == null) { result.push(group); continue; }
    const versions = episodes.get(key) ?? [];
    versions.push(group);
    episodes.set(key, versions);
  }
  for (const versions of episodes.values()) result.push(versions.length === 1
    ? versions[0] : organizeAlternateVersions(versions));
  return result;
}

function resolveVideoGroups(parent, candidates, parseName, supportMultiVersion, episodeVersions = false) {
  const videos = candidates.filter(candidate => {
    if (!recognizedVideo(candidate)) return false;
    const { stem, extension } = fileParts(candidate.entry.name);
    return !extraVideo(stem, extension) && matchedExtraRule(candidate.identityPath, parent?.Path) == null;
  });
  const stacks = resolveFileStacks(videos);
  const stacked = new Set(stacks.flatMap(stack => stack.files));
  const groups = stacks.map(stack => {
    const primary = stack.files[0], stem = fileParts(primary.entry.name).stem;
    const parsed = parseName ? parseMetadataName(stem) : { Name: stem, Year: null };
    return {
      name: parseName ? stack.name : parsed.Name,
      year: parsed.Year ?? null,
      primary,
      parts: stack.files.slice(1),
      alternates: []
    };
  });
  for (const primary of videos) {
    if (stacked.has(primary)) continue;
    const { stem } = fileParts(primary.entry.name);
    const parsed = parseName ? parseMetadataName(stem) : { Name: stem, Year: null };
    groups.push({ name: parsed.Name, year: parsed.Year ?? null, primary, parts: [], alternates: [] });
  }
  return !supportMultiVersion ? groups : episodeVersions ? organizeEpisodeGroups(groups) : organizeMovieGroups(parent, groups);
}

function videoResolutionPolicy(collectionContext, multiple = false, parent) {
  const type = collectionContext?.collectionType;
  if (type === null && multiple) return {
    nativeType: parent == null ? videoNativeType : movieNativeType,
    parseName: parent != null, supportMultiVersion: false
  };
  if (type === null) return { nativeType: movieNativeType, parseName: true, supportMultiVersion: true, collapseDirectory: true };
  // Photos libraries admit video files, but their directories remain
  // PhotoAlbum/Folder rather than movie or disc directory candidates.
  if (type === 'photos' && multiple) return { nativeType: videoNativeType, parseName: false, supportMultiVersion: false };
  if (type === 'tvshows' && multiple) return { nativeType: episodeNativeType, parseName: true, supportMultiVersion: true, episodeVersions: true };
  if (type === 'movies') return { nativeType: movieNativeType, parseName: true, supportMultiVersion: true, collapseDirectory: true };
  if (type === 'musicvideos') return { nativeType: musicVideoNativeType, parseName: false, supportMultiVersion: true, collapseDirectory: true };
  if (type === 'homevideos') return { nativeType: videoNativeType, parseName: false, supportMultiVersion: false, collapseDirectory: false };
  return null;
}

function mixedVideoParentExcluded(parent, collectionContext) {
  return parent?.IsRoot === true || [parent, ...(collectionContext?.parents ?? [])]
    .some(value => ['MediaBrowser.Controller.Entities.TV.Series', 'Series'].includes(value?.NativeType ?? value?.Type));
}

const hasTvMarker = candidates => candidates.some(candidate => ['tvshow.nfo', 'season.nfo'].includes(candidate.entry.name.toLowerCase()));

function draft(candidate, parseName, isInMixedFolder, nameOverride) {
  const { stem } = fileParts(candidate.entry.name);
  const parsed = parseName ? parseMetadataName(stem) : { Name: stem, Year: null };
  const Video3DFormat = video3DFormatFromPath(candidate.identityPath);
  if (!parsed.Name && !nameOverride) return null;
  return {
    Name: nameOverride ?? parsed.Name,
    IsFolder: false,
    MediaType: 'Video',
    SourceType: 'Library',
    columns: { IsInMixedFolder: isInMixedFolder },
    ...(parsed.Year == null ? {} : { initialColumns: { ProductionYear: parsed.Year } }),
    data: { ...videoSourceFields(candidate.entry.name, candidate.identityPath), LocalAlternateVersions: [],
      ...(Video3DFormat == null ? {} : { Video3DFormat }) }
  };
}

function discDraft(candidate, videoType) {
  const Video3DFormat = video3DFormatFromPath(candidate.identityPath);
  return {
    IsFolder: false,
    MediaType: 'Video',
    SourceType: 'Library',
    columns: { IsInMixedFolder: false },
    data: {
      VideoType: videoType,
      LocalAlternateVersions: [],
      ...(Video3DFormat == null ? {} : { Video3DFormat })
    }
  };
}

const discClaim = (directory, nativeType, videoType) => ({
  nativeType,
  primary: directory,
  consumedPaths: [directory],
  traversal: 'none',
  draft: discDraft(directory, videoType)
});

function directDiscMember(candidate, directory) {
  if (!candidate?.entry || !['file', 'directory'].includes(candidate.entry.kind)
    || typeof candidate.entry.name !== 'string' || !candidate.entry.name
    || typeof candidate.identityPath !== 'string' || typeof candidate.accessPath !== 'string') return false;
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(candidate.identityPath);
  return sameNativePath(nativeDirectoryName(candidate.identityPath, { windows }), directory.identityPath)
    && path.posix.dirname(candidate.accessPath) === path.posix.normalize(directory.accessPath);
}

async function resolveDirectDiscDirectory(directory, snapshot, nativeType, peekDirectory) {
  for (const child of snapshot.candidates) {
    if (child?.entry?.kind === 'directory') {
      if (ordinalIgnoreCase(child.entry.name, 'bdmv')) {
        if (!directDiscMember(child, directory)) return withheld;
        return discClaim(directory, nativeType, 'BluRay');
      }
      if (!ordinalIgnoreCase(child.entry.name, 'video_ts')) continue;
      if (!directDiscMember(child, directory)) return withheld;
      // Native IsDvdDirectory uses DirectoryService.GetFilePaths directly;
      // Core/DotIgnore filtering must not hide the VOB marker from this probe.
      const nested = await peekDirectory(child, { forExtras: true });
      // IsDvdDirectory relies on a complete direct file observation. A weak
      // listing cannot distinguish a malformed ordinary folder from a DVD.
      if (!Array.isArray(nested?.candidates) || nested.listing?.deletionSafe !== true) return withheld;
      const vob = nested.candidates.find(candidate => candidate?.entry?.kind === 'file'
        && fileParts(candidate.entry.name).extension === '.vob');
      if (vob && !directDiscMember(vob, child)) return withheld;
      if (vob) {
        return discClaim(directory, nativeType, 'Dvd');
      }
      continue;
    }
    if (child?.entry?.kind === 'file' && ordinalIgnoreCase(child.entry.name, 'video_ts.ifo')) {
      if (!directDiscMember(child, directory)) return withheld;
      return discClaim(directory, nativeType, 'Dvd');
    }
  }
  return null;
}

async function nestedDiscVideoType(directory, snapshot, peekDirectory) {
  if (!Array.isArray(snapshot?.candidates) || snapshot.listing?.deletionSafe !== true) {
    return weakDiscObservation;
  }
  const children = snapshot.candidates;
  for (const child of children.filter(value => value?.entry?.kind === 'directory'
    && ordinalIgnoreCase(value.entry.name, 'video_ts'))) {
    if (!directDiscMember(child, directory)) return weakDiscObservation;
    const nested = await peekDirectory(child, { forExtras: true });
    if (!Array.isArray(nested?.candidates) || nested.listing?.deletionSafe !== true) {
      return weakDiscObservation;
    }
    const vob = nested.candidates.find(value => value?.entry?.kind === 'file'
      && fileParts(value.entry.name).extension === '.vob');
    if (vob && !directDiscMember(vob, child)) return weakDiscObservation;
    if (vob) return 'Dvd';
  }
  const bluray = children.find(value => value?.entry?.kind === 'directory'
    && ordinalIgnoreCase(value.entry.name, 'bdmv'));
  if (bluray) return directDiscMember(bluray, directory) ? 'BluRay' : weakDiscObservation;
  const dvd = children.find(value => value?.entry?.kind === 'file'
    && ordinalIgnoreCase(value.entry.name, 'video_ts.ifo'));
  if (dvd) return directDiscMember(dvd, directory) ? 'Dvd' : weakDiscObservation;
  return null;
}

async function resolveMultiDiscDirectory(directory, snapshot, nativeType, peekDirectory) {
  const qualified = [];
  const videoTypes = [];
  const directories = snapshot.candidates.filter(child => child?.entry?.kind === 'directory'
    && !extrasFolderNames.has(child.entry.name.toLowerCase()));
  for (const child of directories) {
    const nested = await peekDirectory(child, { forExtras: true });
    const videoType = await nestedDiscVideoType(child, nested, peekDirectory);
    if (videoType === weakDiscObservation) return withheld;
    if (videoType == null) continue;
    qualified.push(child);
    videoTypes.push(videoType);
  }
  if (new Set(videoTypes).size > 1 || qualified.length === 0) return null;
  qualified.sort((left, right) => currentCultureComparer.compare(left.identityPath, right.identityPath));
  const stacks = resolveDirectoryStacks(qualified);
  if (stacks.length !== 1) return null;
  const itemSource = qualified[0], directoryParts = qualified.slice(1);
  return {
    nativeType,
    primary: directory,
    itemSource,
    consumedPaths: [directory, ...qualified],
    traversal: 'none',
    draft: {
      Name: stacks[0].name,
      IsFolder: false,
      MediaType: 'Video',
      SourceType: 'Library',
      columns: { IsInMixedFolder: false },
      data: {
        VideoType: videoTypes[0],
        LocalAlternateVersions: [],
        AdditionalParts: directoryParts.map(value => value.identityPath)
      }
    },
    directoryParts
  };
}

function extraOwner(extra, versions) {
  const api = pathApiFor(extra.identityPath);
  const extraDirectory = api.dirname(extra.identityPath);
  const extraStem = api.basename(extra.identityPath, api.extname(extra.identityPath));
  let selected = versions[0], matchedLength = 0;
  for (const version of versions) {
    const versionApi = pathApiFor(version.identityPath);
    if (!ordinalIgnoreCase(versionApi.dirname(version.identityPath), extraDirectory)) continue;
    const stem = versionApi.basename(version.identityPath, versionApi.extname(version.identityPath));
    if (!stem || !startsWithOrdinalIgnoreCase(extraStem, stem)) continue;
    const remainder = extraStem.slice(stem.length);
    if (!remainder || ![' ', '-', '_', '.'].includes(remainder[0]) || stem.length <= matchedLength) continue;
    selected = version;
    matchedLength = stem.length;
  }
  return selected;
}

function localizedExtraName(extra, ownerName, counters, localization) {
  const namedAfterOwner = extra.ruleType === 'Filename'
    || extra.ruleType === 'Suffix' && ordinalIgnoreCase(extra.resolvedName, ownerName);
  if (!namedAfterOwner) return extra.resolvedName;
  const seen = counters.get(extra.extraTypeValue) ?? 0;
  counters.set(extra.extraTypeValue, seen + 1);
  const culture = localization?.serverCulture;
  const key = extraTypeResourceKeys[extra.extraTypeValue];
  const typeName = localization?.text?.(key, { culture }) ?? englishExtraNames[extra.extraTypeValue];
  return seen === 0 ? typeName
    : localization?.format?.('NameExtraNumbered', [typeName, seen + 1], { culture }) ?? `${typeName} ${seen + 1}`;
}

function extraDraft(candidate, classification, name, isInMixedFolder) {
  const result = {
    Name: name,
    IsFolder: false,
    MediaType: classification.nativeType === audioNativeType ? 'Audio' : 'Video',
    SourceType: 'Library',
    columns: { IsInMixedFolder: isInMixedFolder }
  };
  if (classification.resolvedYear != null) result.initialColumns = { ProductionYear: classification.resolvedYear };
  if (classification.nativeType !== audioNativeType) {
    result.data = { ...videoSourceFields(candidate.entry.name, candidate.identityPath), LocalAlternateVersions: [] };
  }
  if (fileParts(candidate.entry.name).extension === '.strm') {
    result.data = { ...result.data, IsShortcut: true };
  }
  return result;
}

function resolvedExtraMetadata(candidate, classification) {
  if (classification.nativeType !== audioNativeType) return classification;
  return {
    ...classification,
    resolvedName: fileParts(candidate.entry.name).stem,
    resolvedYear: null
  };
}

export async function collectOwnedExtras(owner, versions, candidates, peekDirectory, localization, {
  resolveExtra, ownerIsDirectory = owner.entry.kind === 'directory'
} = {}) {
  if (!ownerIsDirectory) {
    const filename = nativeFileName(owner.identityPath, { windows: pathApiFor(owner.identityPath) === path.win32 });
    const dot = filename.lastIndexOf('.'), extension = dot < 0 ? '' : filename.slice(dot).toLowerCase();
    if (!nativeVideoFileExtensions.has(extension) && !stubExtensions.has(extension)) return { extras: [], scopes: [], consumed: [] };
  }
  const namingOptions = { ownerIsDirectory };
  const discovered = [];
  const scopes = [];
  const consumed = [];
  for (const candidate of candidates) {
    if (candidate.entry.kind === 'file') {
      if (versions.includes(candidate)) continue;
      const classification = resolveVideoExtraCandidate(owner.identityPath, candidate.identityPath, namingOptions);
      if (classification.valid) {
        const value = { candidate, classification: resolvedExtraMetadata(candidate, classification), isInMixedFolder: false, nested: false };
        if (!resolveExtra || await resolveExtra(value)) discovered.push(value);
      }
      continue;
    }
    if (!extrasFolderNames.has(candidate.entry.name.toLowerCase()) || typeof peekDirectory !== 'function') continue;
    const snapshot = await peekDirectory(candidate, { forExtras: true });
    if (!Array.isArray(snapshot?.candidates)) continue;
    scopes.push(candidate);
    const files = snapshot.candidates.filter(child => child?.entry?.kind === 'file');
    const isInMixedFolder = files.length > 1;
    for (const child of files) {
      const classification = resolveVideoExtraCandidate(owner.identityPath, child.identityPath, namingOptions);
      if (classification.valid) {
        const value = { candidate: child, classification: resolvedExtraMetadata(child, classification), isInMixedFolder, nested: true };
        if (!resolveExtra || await resolveExtra(value)) discovered.push(value);
      }
    }
  }
  discovered.sort((left, right) => left.candidate.identityPath < right.candidate.identityPath ? -1
    : left.candidate.identityPath > right.candidate.identityPath ? 1 : 0);
  const counters = new Map();
  const ownerName = parseMetadataName(fileParts(owner.entry.name).stem).Name;
  const extras = discovered.map(value => ({
    primary: value.candidate,
    nativeType: value.classification.nativeType,
    extraType: value.classification.extraTypeValue,
    owner: value.nested ? owner : extraOwner(value.candidate, versions),
    draft: extraDraft(value.candidate, value.classification,
      localizedExtraName(value.classification, ownerName, counters, localization), value.isInMixedFolder)
  }));
  for (const value of discovered.filter(value => !value.nested)) consumed.push(value.candidate);
  consumed.push(...scopes);
  return { extras, scopes, consumed };
}

function claim(group, nativeType, parseName, isInMixedFolder, {
  ownedExtras,
  ownedExtraScopes = [],
  additionalConsumed = []
} = {}) {
  const primaryDraft = draft(group.primary, parseName, isInMixedFolder,
    parseName ? group.name : fileParts(group.primary.entry.name).stem);
  if (!primaryDraft) return null;
  if (group.parts.length) primaryDraft.data.AdditionalParts = group.parts.map(value => value.identityPath);
  primaryDraft.data.LocalAlternateVersions = group.alternates.map(value => value.primary.identityPath);
  const localAlternates = group.alternates.map(alternate => {
    const alternateDraft = draft(alternate.primary, parseName, isInMixedFolder, alternate.name);
    if (alternate.parts.length) alternateDraft.data.AdditionalParts = alternate.parts.map(value => value.identityPath);
    return { primary: alternate.primary, draft: alternateDraft };
  });
  const ownedParts = [group, ...group.alternates].flatMap(version => version.parts.map(part => {
    const partDraft = draft(part, parseName, isInMixedFolder);
    // Native owned-part conversion from a concrete video subtype to Video
    // copies only five fields; shortcut and placeholder flags are not among them.
    if (nativeType !== videoNativeType) {
      delete partDraft.data.IsShortcut;
      delete partDraft.data.IsPlaceHolder;
      delete partDraft.data.IsoType;
    }
    return { primary: part, nativeType: videoNativeType, owner: version.primary, draft: partDraft };
  }));
  const groupedCandidates = [group.primary, ...group.parts,
    ...group.alternates.flatMap(alternate => [alternate.primary, ...alternate.parts])];
  return {
    nativeType,
    primary: group.primary,
    consumedPaths: [...groupedCandidates, ...additionalConsumed],
    traversal: 'none',
    draft: primaryDraft,
    localAlternates,
    ownedParts,
    ...(ownedExtras === undefined ? {} : { ownedExtras, ownedExtraScopes })
  };
}

function collapsedVideoDirectoryClaim(directory, group, policy, { ownedExtras, ownedExtraScopes } = {}) {
  const resolved = claim(group, policy.nativeType, policy.parseName, false, { ownedExtras, ownedExtraScopes });
  return {
    ...resolved,
    // The sibling directory is the scan/replacement anchor. The item itself
    // keeps Jellyfin's nested primary-file identity and file timestamps.
    primary: directory,
    itemSource: group.primary,
    consumedPaths: [directory, ...resolved.consumedPaths],
    draft: { ...resolved.draft, ...(policy.nativeType === movieNativeType ? { Name: directory.entry.name } : {}) }
  };
}

async function classifyClaimSources(value, options) {
  if (!value) return value;
  for (const source of [value, ...value.localAlternates ?? [], ...value.ownedParts ?? [], ...value.ownedExtras ?? []]) {
    if (source.draft?.data?.VideoType !== 'Iso') continue;
    const fields = await resolveVideoSourceFields(source.itemSource ?? source.primary, options);
    // Subtype-to-Video owned-part coercion keeps only the native five fields.
    if (value.nativeType === videoNativeType || !value.ownedParts?.includes(source)) source.draft.data.IsoType = fields.IsoType;
  }
  return value;
}

/**
 * Resolves ordinary video files plus the unambiguous, strongly enumerated
 * video-directory collapse, direct DVD/Blu-ray directories, native file stacks, ordinary
 * same-folder local movie/music-video/episode versions and their direct or convention-folder
 * extras, STRM shortcuts, disc placeholders, ISO images, and strongly observed DVD/Blu-ray directory stacks.
 */
export function createVideoFileResolver({ localization, classifyIso, logger } = {}) {
  return Object.freeze({
    id: 'builtin-video-files',
    priority: 40,
    productionMediaScope: 'ordinary-movies-homevideos-and-musicvideos',
    nativeTypes: {
      [videoNativeType]: { isFolder: false },
      [movieNativeType]: { isFolder: false },
      [musicVideoNativeType]: { isFolder: false },
      [episodeNativeType]: { isFolder: false },
      [trailerNativeType]: { isFolder: false },
      [audioNativeType]: { isFolder: false }
    },
    async resolveMultiple({ parent, root, collectionContext, available, peekDirectory, getExtraCandidates, resolveExtra, deletionSafe = true, signal }) {
      const untyped = collectionContext?.collectionType === null;
      if (untyped && (mixedVideoParentExcluded(parent, collectionContext) || !deletionSafe
        || hasTvMarker(available))) return null;
      const policy = videoResolutionPolicy(collectionContext, true, parent);
      if (!policy || discStructure(parent, root)) return null;
      if (policy.episodeVersions && (!parent || parent.IsRoot === true || !deletionSafe)) return null;
      const safe = available.filter(candidate => {
        if (!recognizedVideo(candidate)) return false;
        if (!policy.episodeVersions) return true;
        const override = configuredTypeForPath(collectionContext.contentTypeOverrides ?? [], candidate.identityPath);
        return override == null || override === 'tvshows';
      });
      const groups = resolveVideoGroups(parent, safe, policy.parseName, policy.supportMultiVersion, policy.episodeVersions);
      if (!groups.length) return null;
      const nativeExtraCount = safe.filter(candidate => {
        const { stem, extension } = fileParts(candidate.entry.name);
        return extraVideo(stem, extension) || matchedExtraRule(candidate.identityPath, parent?.Path) != null;
      }).length;
      const mixed = groups.length + nativeExtraCount > 1 || sameId(parent?.Id, root?.Id);
      let items = [];
      for (const group of groups) {
        const supportsExtras = !policy.episodeVersions || !mixed && Boolean(group.parts.length || group.alternates.length);
        const unambiguousOwner = supportsExtras && groups.length === 1 && !sameId(parent?.Id, root?.Id);
        const extraCandidates = unambiguousOwner && getExtraCandidates ? await getExtraCandidates() : available;
        const extras = !unambiguousOwner ? null : await collectOwnedExtras(group.primary,
          [group.primary, ...group.alternates.map(value => value.primary)], extraCandidates, peekDirectory, localization, {
            resolveExtra, ownerIsDirectory: ['Dvd', 'BluRay'].includes(videoSourceFields(group.primary.entry.name).VideoType)
          });
        items.push(await classifyClaimSources(claim(group, policy.nativeType, policy.parseName, mixed, extras == null ? {} : {
          ownedExtras: extras.extras,
          ownedExtraScopes: extras.scopes,
          additionalConsumed: extras.consumed.filter(candidate => available.includes(candidate))
        }), { classifyIso, logger, signal }));
      }
      items = items.filter(Boolean);
      if (!items.length) return null;
      const consumed = new Set(items.flatMap(item => item.consumedPaths));
      return { items, extraFiles: available.filter(candidate => !consumed.has(candidate)) };
    },
    async resolveFile({ candidate, parent, root, collectionContext, candidates, deletionSafe = true, signal }) {
      if (collectionContext?.collectionType === null) {
        if (mixedVideoParentExcluded(parent, collectionContext) || discStructure(parent, root)) return null;
        if (isPotentialVideoExtraCandidate(candidate)) return deletionSafe ? null : withheld;
        const video = resolveOrdinaryVideoFile(candidate);
        if (!video || video.ExtraType != null) return null;
        if (!deletionSafe) return withheld;
        return classifyClaimSources(claim({ primary: candidate, parts: [], alternates: [], name: video.Name },
          videoNativeType, false, true), { classifyIso, logger, signal });
      }
      const policy = videoResolutionPolicy(collectionContext);
      if (!policy) return null;
      // Native single-file resolution declines extras. Without an owning
      // family they remain unclaimed files, not an unsupported sibling batch.
      if (isPotentialVideoExtraCandidate(candidate)) return deletionSafe ? null : withheld;
      if (!policy.supportMultiVersion) return null;
      const groups = resolveVideoGroups(parent, candidates, policy.parseName, true);
      return groups.some(group => group.alternates.some(alternate => alternate.primary === candidate
        || alternate.parts.includes(candidate)) || group.parts.includes(candidate))
        ? withheld : null;
    },
    async resolveDirectory({ candidate, parent, root, collectionContext, peekDirectory, getExtraCandidates, resolveExtra, signal }) {
      const untyped = collectionContext?.collectionType === null;
      if (untyped && (!parent || mixedVideoParentExcluded(parent, collectionContext))) return null;
      const policy = videoResolutionPolicy(collectionContext);
      if (!policy) return null;
      if (extrasFolderNames.has(candidate.entry.name.toLowerCase()) && !sameId(parent?.Id, root?.Id)) return withheld;
      if (typeof peekDirectory !== 'function') return withheld;
      const snapshot = await peekDirectory(candidate);
      // A weak or malformed peek cannot prove that this is an ordinary folder.
      // Withhold it so Folder fallback cannot persist a type decision that a
      // later strong snapshot would need to reclassify.
      if (!Array.isArray(snapshot?.candidates) || snapshot.listing?.deletionSafe !== true) return withheld;
      const disc = await resolveDirectDiscDirectory(candidate, snapshot, policy.nativeType, peekDirectory);
      if (disc) return disc;
      const directDirectories = snapshot.candidates.filter(child => child?.entry?.kind === 'directory'
        && !extrasFolderNames.has(child.entry.name.toLowerCase()));
      const groups = untyped && hasTvMarker(snapshot.candidates) ? []
        : resolveVideoGroups({ Path: candidate.identityPath }, snapshot.candidates, policy.parseName, true);
      if (!policy.collapseDirectory) {
        if (groups.length) return null;
        return await resolveMultiDiscDirectory(candidate, snapshot, policy.nativeType, peekDirectory);
      }
      if (directDirectories.length === 0 && groups.length === 1) {
        const [group] = groups;
        const extraCandidates = getExtraCandidates ? await getExtraCandidates(candidate) : snapshot.candidates;
        const extras = await collectOwnedExtras(group.primary, [group.primary, ...group.alternates.map(value => value.primary)],
          extraCandidates, peekDirectory, localization, {
            resolveExtra, ownerIsDirectory: ['Dvd', 'BluRay'].includes(videoSourceFields(group.primary.entry.name).VideoType)
          });
        return classifyClaimSources(collapsedVideoDirectoryClaim(candidate, group, policy, {
          ownedExtras: extras.extras,
          ownedExtraScopes: extras.scopes
        }), { classifyIso, logger, signal });
      }
      if (groups.length) return null;
      const multiDisc = await resolveMultiDiscDirectory(candidate, snapshot, policy.nativeType, peekDirectory);
      if (multiDisc) return multiDisc;
      return null;
    }
  });
}
