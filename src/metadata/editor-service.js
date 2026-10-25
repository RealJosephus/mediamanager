import path from 'node:path';
import { loadLocalizationData } from '../core/localization-data.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { nativeContainsSubPath } from '../library/native-path.js';
import { idKey, libraryError, nonemptyId } from '../library/records.js';
import { parentChainForItem } from '../library/collection-membership.js';
import { rootCollectionType } from '../library/root-collection-type.js';
import { loadPostgresMetadataRows } from '../library/postgres-library-query.js';
import { clrTrim } from './whitespace.js';

const knownItemTypes = new Set([
  'AggregateFolder', 'Audio', 'AudioBook', 'Book', 'BoxSet', 'Channel', 'CollectionFolder', 'Episode', 'Folder',
  'Genre', 'LiveTvChannel', 'LiveTvProgram', 'Movie', 'MusicAlbum', 'MusicArtist', 'MusicGenre', 'MusicVideo',
  'Person', 'Photo', 'PhotoAlbum', 'Playlist', 'PlaylistsFolder', 'Season', 'Series', 'Studio', 'Trailer',
  'UserRootFolder', 'UserView', 'Video', 'Year'
]);
const itemByNameTypes = new Set(['Genre', 'MusicArtist', 'MusicGenre', 'Person', 'Studio', 'Year']);
const collectionFolderTypes = new Set(['CollectionFolder', 'PlaylistsFolder']);
const videoTypes = new Set(['Episode', 'Movie', 'MusicVideo', 'Trailer', 'Video']);
const collectionTypes = new Set([
  'unknown', 'movies', 'tvshows', 'music', 'musicvideos', 'trailers', 'homevideos', 'boxsets', 'books', 'photos',
  'livetv', 'playlists', 'folders', 'tvshowseries', 'tvgenres', 'tvgenre', 'tvlatest', 'tvnextup', 'tvresume',
  'tvfavoriteseries', 'tvfavoriteepisodes', 'movielatest', 'movieresume', 'moviemovies', 'moviecollection',
  'moviefavorites', 'moviegenres', 'moviegenre'
]);

const supports = (...types) => item => types.includes(item.Type);
const supportsAudio = item => item.Type === 'Audio' || item.Type === 'AudioBook';
const externalIds = [
  { Name: 'Comic Vine', Key: 'ComicVine', Type: null, supports: supports('Book') },
  { Name: 'Comic Vine', Key: 'ComicVine', Type: 'Person', supports: supports('Person') },
  { Name: 'Google Books', Key: 'GoogleBooks', Type: null, supports: supports('Book') },
  { Name: 'IMDb', Key: 'Imdb', Type: null, supports: item => ['Movie', 'MusicVideo', 'Series', 'Episode', 'Trailer'].includes(item.Type)
    || item.Type === 'LiveTvProgram' && item.IsMovie === true },
  { Name: 'IMDb', Key: 'Imdb', Type: 'Person', supports: supports('Person') },
  { Name: 'IMVDb', Key: 'IMVDb', Type: null, supports: supports('MusicVideo') },
  { Name: 'ISBN', Key: 'ISBN', Type: null, supports: supports('Book') },
  { Name: 'MusicBrainz', Key: 'MusicBrainzAlbum', Type: 'Album', supports: item => supportsAudio(item) || item.Type === 'MusicAlbum' },
  { Name: 'MusicBrainz', Key: 'MusicBrainzAlbumArtist', Type: 'AlbumArtist', supports: supportsAudio },
  { Name: 'MusicBrainz', Key: 'MusicBrainzArtist', Type: 'Artist', supports: supports('MusicArtist') },
  { Name: 'MusicBrainz', Key: 'MusicBrainzArtist', Type: 'OtherArtist', supports: item => supportsAudio(item) || item.Type === 'MusicAlbum' },
  { Name: 'MusicBrainz', Key: 'MusicBrainzRecording', Type: 'Recording', supports: supportsAudio },
  { Name: 'MusicBrainz', Key: 'MusicBrainzReleaseGroup', Type: 'ReleaseGroup', supports: item => supportsAudio(item) || item.Type === 'MusicAlbum' },
  { Name: 'MusicBrainz', Key: 'MusicBrainzTrack', Type: 'Track', supports: supportsAudio },
  { Name: 'TheAudioDb', Key: 'AudioDbAlbum', Type: null, supports: supports('MusicAlbum') },
  { Name: 'TheAudioDb', Key: 'AudioDbArtist', Type: 'Artist', supports: supports('MusicArtist') },
  { Name: 'TheAudioDb', Key: 'AudioDbAlbum', Type: 'Album', supports: supportsAudio },
  { Name: 'TheAudioDb', Key: 'AudioDbArtist', Type: 'OtherArtist', supports: item => supportsAudio(item) || item.Type === 'MusicAlbum' },
  { Name: 'Zap2It', Key: 'Zap2It', Type: null, supports: supports('Series') }
];

function capabilityError(message) {
  return libraryError(501, message);
}

export function assertKnownItem(item) {
  if (!knownItemTypes.has(item.Type)) {
    throw capabilityError(`Metadata editor projection is not implemented for native item type '${item.NativeType ?? item.Type}'.`);
  }
}

function collectionType(item) {
  const value = item.Type === 'PlaylistsFolder' ? 'playlists' : item.CollectionType ?? null;
  if (value !== null && !collectionTypes.has(value)) {
    throw capabilityError(`Metadata editor content type '${value}' is not supported.`);
  }
  return value;
}

export function containingFolderPath(item) {
  if (item.IsFolder) return item.Path;
  if (videoTypes.has(item.Type) && !(item.IsStacked || item.AdditionalParts?.length) && item.IsPlaceHolder !== true && ['BluRay', 'Dvd'].includes(item.VideoType)) return item.Path;
  if (typeof item.Path !== 'string' || !item.Path) return null;
  const api = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(item.Path) ? path.win32 : path.posix;
  return api.dirname(item.Path);
}

export function editedContentTypes(types, folder, contentType) {
  const updated = types.filter(pair => pair.Name != null && clrTrim(pair.Name) && !ordinalIgnoreCaseEquals(pair.Name, folder));
  if (contentType != null && clrTrim(contentType)) updated.push({ Name: folder, Value: contentType });
  return updated;
}

function contentTypeOverrides(configuration) {
  if (configuration.ContentTypes == null) return [];
  if (!Array.isArray(configuration.ContentTypes)) {
    throw capabilityError('Metadata editor content-type configuration is unavailable.');
  }
  return configuration.ContentTypes.map(entry => {
    if (!entry || typeof entry !== 'object' || entry.Name != null && typeof entry.Name !== 'string' || entry.Value != null && typeof entry.Value !== 'string') {
      throw capabilityError('Metadata editor content-type configuration is invalid.');
    }
    return entry;
  });
}

function trimEndingDirectorySeparator(value) {
  const windows = process.platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  const separator = character => character === '/' || windows && character === '\\';
  return value.length > api.parse(value).root.length && separator(value.at(-1)) ? value.slice(0, -1) : value;
}

function fileSystemPathEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left.trim() || !right.trim()) return false;
  left = trimEndingDirectorySeparator(left);
  right = trimEndingDirectorySeparator(right);
  return process.platform === 'win32' ? ordinalIgnoreCaseEquals(left, right) : left === right;
}

function configuredType(item, configuration, { inherit = false } = {}) {
  if (collectionFolderTypes.has(item.Type)) return collectionType(item);
  const target = containingFolderPath(item);
  if (!target) return null;
  const match = contentTypeOverrides(configuration).find(entry => entry.Name
    && (fileSystemPathEquals(entry.Name, target) || inherit && nativeContainsSubPath(target, entry.Name)));
  return match && collectionTypes.has(match.Value) ? match.Value : null;
}

async function inheritedType(item, state, configuration, library) {
  const userRoot = state.items.find(candidate => candidate.Type === 'UserRootFolder');
  if (!userRoot) throw capabilityError('Metadata editor content types require the native user root.');
  const inherited = await rootCollectionType(library, item, state);
  if (inherited !== null) {
    if (!collectionTypes.has(inherited)) throw capabilityError(`Metadata editor content type '${inherited}' is not supported.`);
    return inherited;
  }
  let value = null;
  for (const parent of parentChainForItem(item, state)) value = configuredType(parent, configuration) ?? value;
  return value;
}

function itemSource(item) {
  if (item.Type === 'Channel' || nonemptyId(item.ChannelId)) return 'Channel';
  if (item.Type === 'LiveTvChannel' || item.Type === 'LiveTvProgram') return 'LiveTV';
  return 'Library';
}

async function contentTypeFields(item, state, configuration, localization, library) {
  if (item.IsVirtualItem || collectionFolderTypes.has(item.Type) || ['UserView', 'AggregateFolder', 'LiveTvChannel'].includes(item.Type)
    || itemByNameTypes.has(item.Type) || itemSource(item) !== 'Library') return { ContentTypeOptions: [] };
  const inherited = await inheritedType(item, state, configuration, library);
  const configured = configuredType(item, configuration);
  if (inherited !== null && configured === null) return { ContentTypeOptions: [] };
  let options = [
    ['Inherit', ''], ['Movies', 'movies'], ['Music', 'music'], ['Shows', 'tvshows'],
    ['HomeVideos', 'homevideos'], ['MusicVideos', 'musicvideos'], ['Photos', 'photos']
  ].map(([Name, Value]) => ({ Name: localization.text(Name), Value }));
  if (inherited === null || inherited === 'tvshows' || inherited === 'movies') {
    options = options.filter(option => option.Value === '' || option.Value === 'tvshows' || option.Value === 'movies');
  }
  return { ContentType: configured, ContentTypeOptions: options };
}

export class MetadataEditorService {
  #closed = false;
  #pending = new Set();
  constructor(options = {}) {
    const { library, configuration = {}, configurationStore, localization, localizationData = loadLocalizationData() } = options;
    if (!library?.store || typeof library.load !== 'function') throw new TypeError('MetadataEditorService requires a LibraryService.');
    if (!localization?.text) throw new TypeError('MetadataEditorService requires localization.');
    if (!localizationData?.countries || !localizationData?.cultures || !localizationData?.parentalRatings) {
      throw new TypeError('MetadataEditorService requires localization data.');
    }
    Object.assign(this, { library, configurationStore, localization, localizationData });
    Object.defineProperty(this, 'configuration', { get() { const { configuration: current = configuration } = options; return current; } });
  }

  updateContentType(itemId, contentType, { user = null } = {}) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Metadata editing is closing.'));
    const operation = this.library.store.run(async database => {
      const state = await this.library.load(database, user, {
        includeUserData: false,
        baseRows: await loadPostgresMetadataRows(database, itemId),
      });
      try {
      const item = state.byId.get(idKey(itemId));
      if (!item || user && !await this.library.isItemVisible(item, user, state)) throw libraryError(404, 'Item not found.');
      assertKnownItem(item);
      if (!this.configurationStore) throw capabilityError('Server configuration persistence is unavailable.');
      const folder = containingFolderPath(item);
      await this.configurationStore.updateContentTypes(types => editedContentTypes(types, folder, contentType));
      } finally { await state.dispose({ session: database }); }
    });
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }

  async close() { this.#closed = true; await Promise.allSettled([...this.#pending]); }

  async get(itemId, { user = null } = {}) {
    return this.library.store.run(async database => {
      const state = await this.library.load(database, user, {
        includeUserData: false,
        baseRows: await loadPostgresMetadataRows(database, itemId),
      });
      try {
      const item = state.byId.get(idKey(itemId));
      if (!item || user && !await this.library.isItemVisible(item, user, state)) {
        throw libraryError(404, 'Item not found.');
      }
      assertKnownItem(item);
      const fields = await contentTypeFields(item, state, this.configuration, this.localization, this.library);
      return {
        ParentalRatingOptions: this.localizationData.parentalRatings(this.configuration.MetadataCountryCode || 'US'),
        Countries: structuredClone(this.localizationData.countries),
        Cultures: structuredClone(this.localizationData.cultures(this.localization.context.culture)),
        ExternalIdInfos: externalIds.filter(provider => provider.supports(item))
          .map(({ Name, Key, Type }) => ({ Name, Key, Type })).concat(
            (this.library.options.externalUrlRegistry?.discover({item,kind:'externalId'}) ?? []).map(provider => provider.getExternalIdInfo())),
        ContentType: fields.ContentType,
        ContentTypeOptions: fields.ContentTypeOptions
      };
      } finally { await state.dispose({ session: database }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
  }
}
