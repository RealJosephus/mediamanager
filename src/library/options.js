import path from 'node:path';
import { readXml } from '../core/xml.js';
import { libraryError } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { LibraryOptionsStore } from './library-options-store.js';

const booleanFields = ['Enabled', 'EnablePhotos', 'EnableRealtimeMonitor', 'EnableLUFSScan', 'EnableChapterImageExtraction', 'ExtractChapterImagesDuringLibraryScan', 'EnableTrickplayImageExtraction', 'ExtractTrickplayImagesDuringLibraryScan', 'SaveLocalMetadata', 'EnableInternetProviders', 'EnableAutomaticSeriesGrouping', 'EnableEmbeddedTitles', 'EnableEmbeddedExtrasTitles', 'EnableEmbeddedEpisodeInfos', 'SkipSubtitlesIfEmbeddedSubtitlesPresent', 'SkipSubtitlesIfAudioTrackMatches', 'RequirePerfectSubtitleMatch', 'SaveSubtitlesWithMedia', 'SaveLyricsWithMedia', 'SaveTrickplayWithMedia', 'PreferNonstandardArtistsTag', 'UseCustomTagDelimiters', 'AutomaticallyAddToCollection'];
const arrayFields = ['MetadataSavers', 'DisabledLocalMetadataReaders', 'LocalMetadataReaderOrder', 'DisabledSubtitleFetchers', 'SubtitleFetcherOrder', 'DisabledMediaSegmentProviders', 'MediaSegmentProviderOrder', 'SubtitleDownloadLanguages', 'DisabledLyricFetchers', 'LyricFetcherOrder', 'CustomTagDelimiters', 'DelimiterWhitelist'];
const typeArrays = ['MetadataFetchers', 'MetadataFetcherOrder', 'ImageFetchers', 'ImageFetcherOrder', 'SimilarItemProviders', 'SimilarItemProviderOrder'];
const imageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
const embeddedSubtitles = ['AllowAll', 'AllowText', 'AllowImage', 'AllowNone'];
const schemaInstance = 'http://www.w3.org/2001/XMLSchema-instance';
const fields = node => Object.fromEntries(node.children.filter(child => !child.name.includes(':') && !child.namespaces.xmlns)
  .map(child => [child.name, child]).reverse());
const entries = (node, name) => node.children.filter(child => child.name === name && !child.namespaces.xmlns);
const nil = node => Object.entries(node.attributes).some(([name, value]) => name.endsWith(':nil')
  && node.namespaces['xmlns:' + name.split(':')[0]] === schemaInstance && ['true', '1'].includes(value.trim()));
const scalar = value => {
  if (value == null) return value;
  if (!value.children.length) return value.text;
  throw new Error('A library options scalar contains invalid nested XML.');
};
const textArray = value => entries(value, 'string').map(node => nil(node) ? null : scalar(node));
const integer = value => {
  const text = scalar(value)?.trim();
  if (!/^[+-]?\d+$/.test(text ?? '')) throw new Error('Invalid library options integer.');
  const result = Number(text);
  if (result < -2147483648 || result > 2147483647) throw new Error('Library options integer is outside Int32.');
  return result;
};

export function defaultLibraryOptions() {
  const defaults = Object.fromEntries(booleanFields.map(name => [name, false]));
  Object.assign(defaults, { Enabled: true, EnablePhotos: true, EnableAutomaticSeriesGrouping: true, SkipSubtitlesIfAudioTrackMatches: true, RequirePerfectSubtitleMatch: true, SaveSubtitlesWithMedia: true, AutomaticRefreshIntervalDays: 0, PreferredMetadataLanguage: null, MetadataCountryCode: null, SeasonZeroDisplayName: 'Specials', AllowEmbeddedSubtitles: 'AllowAll', TypeOptions: [], PathInfos: [] });
  for (const name of arrayFields) defaults[name] = ['MetadataSavers', 'LocalMetadataReaderOrder', 'SubtitleDownloadLanguages'].includes(name) ? null : [];
  defaults.CustomTagDelimiters = ['/', '|', ';', '\\'];
  return defaults;
}

export function createVirtualPathExpander({ programDataPath, dataPath = path.join(programDataPath, 'data'),
  metadataPath = path.join(programDataPath, 'metadata') }) {
  return value => typeof value === 'string' ? value.replace(/%AppDataPath%/gi, () => dataPath).replace(/%MetadataPath%/gi, () => metadataPath) : value;
}

// ApplicationHost.ReverseVirtualPath replaces all matching substrings in this
// order. It is independent of filesystem containment, which asset access checks.
export function createVirtualPathReverser({ programDataPath, dataPath = path.join(programDataPath, 'data'),
  metadataPath = path.join(programDataPath, 'metadata') }) {
  const replace = (value, source, target) => {
    const key = ordinalIgnoreCaseKey(value), sourceKey = ordinalIgnoreCaseKey(source);
    let result = '', position = 0, next;
    while ((next = key.indexOf(sourceKey, position)) !== -1) {
      result += value.slice(position, next) + target;
      position = next + source.length;
    }
    return result + value.slice(position);
  };
  if (!dataPath || !metadataPath) throw new TypeError('Native state paths must be nonempty.');
  return value => typeof value === 'string' ? replace(replace(value, dataPath, '%AppDataPath%'), metadataPath, '%MetadataPath%') : value;
}

export function deserializeLibraryOptions(xml) {
  const invalidCharacter = point => point < 32 && ![9, 10, 13].includes(point) || point > 0x10ffff
    || point >= 0xd800 && point <= 0xdfff || [0xfffe, 0xffff].includes(point);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(xml)
    || [...xml.matchAll(/&#(x[\da-f]+|\d+);/giu)].some(match => invalidCharacter(match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1), 16) : Number(match[1])))) {
    throw new Error('Invalid library options XML character.');
  }
  const root = readXml(xml.replace(/\r\n?/gu, '\n'));
  if (root.name !== 'LibraryOptions' || root.namespaces.xmlns) throw new Error('Missing LibraryOptions root.');
  const value = fields(root);
  const result = defaultLibraryOptions();
  for (const name of booleanFields) if (Object.hasOwn(value, name)) {
    const text = scalar(value[name])?.trim();
    if (!['true', 'false', '1', '0'].includes(text)) throw new Error(`Invalid library option Boolean ${name}.`);
    result[name] = ['true', '1'].includes(text);
  }
  for (const name of ['PreferredMetadataLanguage', 'MetadataCountryCode', 'SeasonZeroDisplayName']) if (Object.hasOwn(value, name)) result[name] = scalar(value[name]);
  if (Object.hasOwn(value, 'AutomaticRefreshIntervalDays')) result.AutomaticRefreshIntervalDays = integer(value.AutomaticRefreshIntervalDays);
  for (const name of arrayFields) for (const node of entries(root, name)) if (!nil(node)) result[name] = textArray(node);
  if (Object.hasOwn(value, 'AllowEmbeddedSubtitles')) {
    result.AllowEmbeddedSubtitles = scalar(value.AllowEmbeddedSubtitles)?.trim();
    if (!embeddedSubtitles.includes(result.AllowEmbeddedSubtitles)) throw new Error('Invalid embedded subtitle option.');
  }
  for (const array of entries(root, 'PathInfos')) if (!nil(array)) result.PathInfos = entries(array, 'MediaPathInfo').map(node => {
    if (nil(node)) return null;
    const entry = fields(node); return { Path: entry.Path == null ? '' : scalar(entry.Path) };
  });
  for (const array of entries(root, 'TypeOptions')) if (!nil(array)) result.TypeOptions = entries(array, 'TypeOptions').map(node => {
    if (nil(node)) return null;
    const entry = fields(node);
    const type = { Type: entry.Type == null ? null : scalar(entry.Type), ImageOptions: [] };
    for (const name of typeArrays) {
      type[name] = []; for (const array of entries(node, name)) if (!nil(array)) type[name] = textArray(array);
    }
    for (const array of entries(node, 'ImageOptions')) if (!nil(array)) type.ImageOptions = entries(array, 'ImageOption').map(node => {
      if (nil(node)) return null;
      const image = fields(node);
      const name = image.Type == null ? 'Primary' : scalar(image.Type)?.trim();
      if (!imageTypes.includes(name)) throw new Error('Invalid library image type.');
      return { Type: name, Limit: image.Limit == null ? 1 : integer(image.Limit), MinWidth: image.MinWidth == null ? 0 : integer(image.MinWidth) };
    });
    return type;
  });
  return result;
}

export function parseLibraryOptions(xml, { expandPath = value => value } = {}) {
  const result = deserializeLibraryOptions(xml);
  // The native loader accesses each path entry after successful XML reading.
  // A nil entry is valid XML data but fails this subsequent load operation.
  for (const info of result.PathInfos) if (info.Path != null && info.Path !== '') info.Path = expandPath(info.Path);
  return result;
}

export async function loadLibraryOptions(database, { fileSystem, programDataPath, dataPath, metadataPath, onError = () => {}, optionsStore } = {}) {
  const collections = await database.rows('BaseItems', {
    where: { Type: 'MediaBrowser.Controller.Entities.CollectionFolder' },
  });
  if (!collections.length) return optionsStore?.optionsById ?? new Map();
  if (!programDataPath) throw libraryError(501, 'Loading native library options requires the isolated program data path.');
  // The persistent runtime owns this store. Standalone readers own and drain
  // their temporary store while keeping the returned live option objects.
  const owned = !optionsStore;
  optionsStore ??= new LibraryOptionsStore({ fileSystem, programDataPath, dataPath, metadataPath, onError });
  try {
    for (const collection of collections) {
      const collectionPath = optionsStore.expandPath(collection.Path);
      await optionsStore.bind(collection.Id, collectionPath);
    }
    return optionsStore.optionsById;
  } finally { if (owned) await optionsStore.close(); }
}
