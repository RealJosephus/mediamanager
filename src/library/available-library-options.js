import path from 'node:path';
import { defaultImageOptions } from '../metadata/images.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeItemTypes, newNativeItemEntity } from './native-item-entity.js';

// Jellyfin.Data.Enums.CollectionType is distinct from CollectionTypeOptions.
const collectionTypes = ['unknown', 'movies', 'tvshows', 'music', 'musicvideos', 'trailers', 'homevideos', 'boxsets',
  'books', 'photos', 'livetv', 'playlists', 'folders'];
const privateCollectionTypes = ['tvshowseries', 'tvgenres', 'tvgenre', 'tvlatest', 'tvnextup', 'tvresume', 'tvfavoriteseries',
  'tvfavoriteepisodes', 'movielatest', 'movieresume', 'moviemovies', 'moviecollection', 'moviefavorites', 'moviegenres', 'moviegenre'];
const collectionCodes = new Map([...collectionTypes.map((name, index) => [name, index]),
  ...privateCollectionTypes.map((name, index) => [name, index + 101])]);
const mixedTypes = ['Series', 'Season', 'Episode', 'Movie'];
const representativeKinds = {
  boxsets: ['BoxSet'], playlists: ['Playlist'], movies: ['Movie'], tvshows: mixedTypes.slice(0, 3), books: ['Book', 'AudioBook'],
  music: ['MusicArtist', 'MusicAlbum', 'Audio', 'MusicVideo'], homevideos: ['Video', 'Photo'], photos: ['Video', 'Photo'],
  musicvideos: ['MusicVideo'],
};
const entityTypes = new Map(nativeItemTypes.map(nativeType => [nativeType.split('.').at(-1), nativeType]));
const localSimilarityTypes = new Set(['Movie', 'Series', 'Audio', 'MusicArtist', 'MusicAlbum']);
const videoTypes = new Set(['Movie', 'Episode', 'MusicVideo', 'Video']);
const audioTypes = new Set(['Audio', 'AudioBook']);
const defaultMetadataProviders = new Set(['thetvdb', 'theaudiodb', 'musicbrainz']);
const defaultImageProviders = new Set(['thetvdb', 'screen grabber', 'theaudiodb', 'image extractor']);

function itemTypes(input) {
  const text = clrTrim(input ?? '').toLowerCase();
  let index;
  if (/^[+-]?\d+$/u.test(text)) index = Number(text);
  else {
    const values = text.split(',').map(name => collectionCodes.get(clrTrim(name)));
    if (values.every(value => value !== undefined)) index = values.reduce((bits, value) => bits | value, 0);
  }
  return representativeKinds[collectionTypes[index]] ?? mixedTypes;
}

const hasName = (names, name) => (names ?? []).some(value => value != null && ordinalIgnoreCaseEquals(value, name));
const optionList = (providers, isEnabled = () => true) => {
  const seen = new Set(), result = [];
  for (const provider of providers) {
    const key = ordinalIgnoreCaseKey(provider.name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ Name: provider.name, DefaultEnabled: isEnabled(provider) });
  }
  return result;
};

function fetcherEnabled(provider, type, globalOptions, newLibrary, images) {
  const name = provider.name;
  if (!newLibrary) {
    const configuration = globalOptions.find(value => ordinalIgnoreCaseEquals(value.ItemType ?? '', type));
    return !hasName(images ? configuration?.DisabledImageFetchers : configuration?.DisabledMetadataFetchers, name);
  }
  const known = name.toLowerCase();
  if (known !== 'themoviedb') return (images ? defaultImageProviders : defaultMetadataProviders).has(known);
  return !['Season', 'Episode', 'MusicVideo'].includes(type) && (!images || type !== 'Series');
}

export async function availableLibraryOptions(services, { collectionType, newLibrary = false, signal } = {}) {
  const types = itemTypes(collectionType), configuration = services.configuration ?? {};
  const globalOptions = configuration.MetadataOptions ?? [], registry = services.metadata?.registry;
  const saverDefaults = globalOptions.filter(entry => types.some(type => ordinalIgnoreCaseEquals(entry.ItemType ?? '', type)));
  const allSavers = [], allReaders = [], subtitles = [], lyrics = [], segments = [], typeOptions = [];
  const extensions = kind => services.plugins?.entries(kind) ?? [];
  const subtitleProviders = extensions('subtitle'), lyricProviders = extensions('lyric');
  const segmentProviders = services.mediaSegments?.providers() ?? [];
  const compare = new Intl.Collator(services.localization?.context?.culture || 'en-US').compare;
  for (const type of types) {
    signal?.throwIfAborted();
    const noSummary = type === 'Photo' || type === 'Playlist';
    const item = newNativeItemEntity(entityTypes.get(type));
    item.Path = path.join(services.applicationPaths?.metadataPath ?? path.sep, 'dummy');
    item.ParentId = '00000000-0000-0000-0000-000000000001';
    const discover = kind => noSummary ? [] : registry?.discover({ item, kind, globalOptions: configuration, includeDisabled: true }) ?? [];
    const imageProviders = discover('image'), supported = new Set();
    for (const source of ['remote', 'dynamic']) for (const provider of imageProviders.filter(provider => provider.imageSource === source)) {
      const available = await (provider.imageTypesFor?.(item, { signal }) ?? provider.imageTypes ?? []);
      for (const value of available) supported.add(value);
    }
    allSavers.push(...discover('saver').sort((a, b) => compare(a.name, b.name)));
    allReaders.push(...discover('local'));
    if (type === 'Movie' || type === 'Episode') subtitles.push(...subtitleProviders.filter(provider => provider.supportedMediaTypes?.includes(type)));
    if (audioTypes.has(type)) lyrics.push(...lyricProviders);
    if (videoTypes.has(type) || audioTypes.has(type)) segments.push(...segmentProviders);
    const local = localSimilarityTypes.has(type) ? [{ name: 'Local Genre/Tag', kind: 'local', itemTypes: [type] }] : [];
    const similar = noSummary ? [] : (services.similarItems?.discoverProviders(type, local) ?? local);
    typeOptions.push({ Type: type, MetadataFetchers: optionList(discover('remote'), provider => fetcherEnabled(provider, type, globalOptions, newLibrary, false)),
      ImageFetchers: optionList(imageProviders, provider => fetcherEnabled(provider, type, globalOptions, newLibrary, true)),
      SimilarItemProviders: optionList(similar, provider => provider.kind === 'local'), SupportedImageTypes: [...supported],
      DefaultImageOptions: Object.entries(defaultImageOptions[type] ?? {}).map(([Type, [Limit, MinWidth]]) => ({ Type, Limit, MinWidth })) });
  }
  return { MetadataSavers: optionList(allSavers, provider => !newLibrary && (!saverDefaults.length
    || saverDefaults.some(entry => !hasName(entry.DisabledMetadataSavers, provider.name)))), MetadataReaders: optionList(allReaders),
  SubtitleFetchers: optionList(subtitles), LyricFetchers: optionList(lyrics), MediaSegmentProviders: optionList(segments), TypeOptions: typeOptions };
}
