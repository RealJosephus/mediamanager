import { EMPTY_NATIVE_LINKS, isLinkedChildrenHandle } from './postgres-linked-children.js';
import { isDeepStrictEqual } from 'node:util';
import { md5Guid } from '../core/identity.js';
import { EMPTY_ID, MIN_DATE, guid, nonemptyId, libraryError } from './records.js';
import { sortName as deriveSortName } from './dto.js';
import { hasFileProtocol } from './delete-permission.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { cachedFolderChildrenSnapshot, observeFolderChildrenAssignment } from './folder-cache.js';

const EMPTY_STRINGS = Object.freeze([]);
const EMPTY_GUIDS = Object.freeze([]);
const EMPTY_LINKED_CHILDREN = Object.freeze([]);
const EMPTY_METADATA_FIELDS = Object.freeze([]);
const EMPTY_IMAGES = Object.freeze([]);
const EMPTY_MEDIA_URLS = Object.freeze([]);
const EMPTY_PLAYLIST_SHARES = Object.freeze([]);
const EMPTY_TRAILER_TYPES = Object.freeze([]);
const EMPTY_AIR_DAYS = Object.freeze([]);
const channelAccess = new WeakMap();
const recordingAccess = new WeakMap();
const sharedNativeArrays = new Set([
  EMPTY_STRINGS, EMPTY_GUIDS, EMPTY_LINKED_CHILDREN, EMPTY_METADATA_FIELDS, EMPTY_IMAGES,
  EMPTY_MEDIA_URLS, EMPTY_PLAYLIST_SHARES, EMPTY_TRAILER_TYPES, EMPTY_AIR_DAYS
]);

const definitions = [
  ['MediaBrowser.Controller.Entities.Folder', 'Folder', 'folder', true, 'Unknown', 'Other', true],
  ['MediaBrowser.Controller.Entities.AggregateFolder', 'AggregateFolder', 'folder', true, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.UserRootFolder', 'UserRootFolder', 'folder', true, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.CollectionFolder', 'CollectionFolder', 'folder', true, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.UserView', 'UserView', 'folder', true, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Channels.Channel', 'Channel', 'folder', true, 'Unknown', 'Other', false],
  ['Emby.Server.Implementations.Playlists.PlaylistsFolder', 'PlaylistsFolder', 'folder', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Playlists.Playlist', 'Playlist', 'folder', true, 'Unknown', 'Other', true],
  ['MediaBrowser.Controller.Entities.Movies.Movie', 'Movie', 'video', true, 'Video', 'Movie', true],
  ['MediaBrowser.Controller.Entities.Video', 'Video', 'video', true, 'Video', 'Other', true],
  ['MediaBrowser.Controller.Entities.TV.Episode', 'Episode', 'video', true, 'Video', 'Series', true],
  ['MediaBrowser.Controller.Entities.TV.Series', 'Series', 'folder', true, 'Unknown', 'Series', true],
  ['MediaBrowser.Controller.Entities.TV.Season', 'Season', 'folder', false, 'Unknown', 'Series', true],
  ['MediaBrowser.Controller.Entities.Movies.BoxSet', 'BoxSet', 'folder', true, 'Unknown', 'Movie', true],
  ['MediaBrowser.Controller.Entities.Audio.Audio', 'Audio', 'audio', true, 'Audio', 'Music', true],
  ['MediaBrowser.Controller.Entities.AudioBook', 'AudioBook', 'audio', false, 'Audio', 'Book', true],
  ['MediaBrowser.Controller.Entities.MusicVideo', 'MusicVideo', 'video', true, 'Video', 'Music', true],
  ['MediaBrowser.Controller.Entities.Trailer', 'Trailer', 'video', true, 'Video', 'Trailer', true],
  ['MediaBrowser.Controller.LiveTv.LiveTvProgram', 'LiveTvProgram', 'base', false, 'Unknown', 'LiveTvProgram', false],
  ['MediaBrowser.Controller.LiveTv.LiveTvChannel', 'LiveTvChannel', 'base', true, 'Video', 'LiveTvChannel', false],
  ['MediaBrowser.Controller.Entities.Audio.MusicAlbum', 'MusicAlbum', 'folder', false, 'Unknown', 'Music', true],
  ['MediaBrowser.Controller.Entities.Audio.MusicArtist', 'MusicArtist', 'folder', false, 'Unknown', 'Music', true],
  ['MediaBrowser.Controller.Entities.Person', 'Person', 'base', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.Genre', 'Genre', 'base', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.Audio.MusicGenre', 'MusicGenre', 'base', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.Studio', 'Studio', 'base', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.Year', 'Year', 'base', false, 'Unknown', 'Other', false],
  ['MediaBrowser.Controller.Entities.Photo', 'Photo', 'photo', true, 'Photo', 'Other', true],
  ['MediaBrowser.Controller.Entities.PhotoAlbum', 'PhotoAlbum', 'folder', false, 'Unknown', 'Other', true],
  ['MediaBrowser.Controller.Entities.Book', 'Book', 'book', false, 'Book', 'Book', true]
];

const fixedUnratedTypes = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet', 'AudioBook',
  'MusicVideo', 'Trailer', 'LiveTvProgram', 'LiveTvChannel', 'MusicAlbum', 'MusicArtist', 'Book']);
const artistTypes = new Set(['Audio', 'AudioBook', 'MusicVideo', 'MusicAlbum']);
const albumArtistTypes = new Set(['Audio', 'AudioBook', 'MusicAlbum']);
const seriesTypes = new Set(['Episode', 'Season', 'AudioBook', 'Book']);
const displayedBaseTypes = new Set(['Genre', 'MusicGenre', 'Studio']);
const playedStatusTypes = new Set(['Folder', 'Channel', 'PlaylistsFolder', 'Playlist', 'Movie', 'Video', 'Episode',
  'Series', 'Season', 'BoxSet', 'Audio', 'AudioBook', 'MusicVideo', 'Trailer', 'Book']);
const descriptors = new Map(definitions.map(([nativeType, type, family, requiresJson, mediaType, unratedType, resolverCreation]) => [nativeType,
  Object.freeze({ nativeType, type, family, requiresJson, mediaType, unratedType, resolverCreation,
    isFolder: family === 'folder', isHidden: type === 'PlaylistsFolder',
    isDisplayedAsFolder: family === 'folder' || displayedBaseTypes.has(type),
    sourceAwareUnrated: !fixedUnratedTypes.has(type), hasArtist: artistTypes.has(type),
    hasAlbumArtist: albumArtistTypes.has(type), hasSeries: seriesTypes.has(type), dynamicFolder: type === 'MusicArtist' })]));

export const nativeItemTypes = Object.freeze([...descriptors.keys()]);

const nativeItems = new WeakSet();
const folderStates = new WeakMap();
const linkOwnershipObservers = new WeakMap();
const aggregateStates = new WeakMap();
const sortStates = new WeakMap();
const nameObservers = new WeakMap();
const stateObservers = new WeakMap();
const observableValues = new WeakMap();
const observableTargets = new WeakMap();
const dateStates = new WeakMap();
const readonlyFields = new WeakMap();
const privateStateFields = new Set(['LinkedChildren', 'LinkedChildrenLoaded', 'VirtualChildren']);
const sortStateFields = new Set(['Name', 'ForcedSortName', 'SortName']);
const deferredNativeGetters = new Set(['EnableMediaSourceDisplay']);
const repositoryColumnsField = 'NativeRepositoryColumns';
function notifyState(item, key, value, deleted = false) {
  for (const listener of stateObservers.get(item) ?? []) listener(item, key, value, deleted);
}
function writeOwnField(target, key, value) {
  if (Object.hasOwn(target, key)) target[key] = value;
  else Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
function observedValue(item, field, value) {
  // A consumer can assign an observed child into another position of the same
  // collection. Reuse the wrapper for that underlying child and field.
  value = observableTargets.get(value) ?? value;
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || isLinkedChildrenHandle(value)
    || isNativeItemEntity(value) || value instanceof Date || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) return value;
  let fields = observableValues.get(value);
  if (!fields) observableValues.set(value, fields = new WeakMap());
  let byField = fields.get(item); if (!byField) fields.set(item, byField = new Map());
  if (byField.has(field)) return byField.get(field);
  const proxy = new Proxy(value, {
    get(target, key) { return observedValue(item, field, target[key]); },
    set(target, key, next) { writeOwnField(target,key,next); notifyState(item,field,item[field]); return true; },
    deleteProperty(target,key) { const result = Reflect.deleteProperty(target,key); if(result)notifyState(item,field,item[field]);return result; },
    defineProperty(target,key,descriptor) { const result=Reflect.defineProperty(target,key,descriptor);if(result)notifyState(item,field,item[field]);return result; }
  });
  observableTargets.set(proxy, value);
  byField.set(field,proxy); return proxy;
}

/** Native discriminators are exact full CLR names, never leaf-name guesses. */
export function nativeItemDescriptor(nativeType) {
  const descriptor = descriptors.get(nativeType);
  if (!descriptor) throw new TypeError(`Unimplemented native entity constructor: ${nativeType}`);
  return descriptor;
}

export function isResolverNativeItemType(nativeType) {
  return descriptors.get(nativeType)?.resolverCreation === true;
}

export function isNativeItemEntity(value) {
  return value !== null && typeof value === 'object' && nativeItems.has(value);
}

function defineReadonly(item, name, value) {
  Object.defineProperty(item, name, { value, enumerable: true, configurable: false, writable: false });
  let fields = readonlyFields.get(item);
  if (!fields) readonlyFields.set(item, fields = new Set());
  fields.add(name);
}

function defineGetter(item, name, get, enumerable = true) {
  Object.defineProperty(item, name, { get, enumerable, configurable: false });
  let fields = readonlyFields.get(item);
  if (!fields) readonlyFields.set(item, fields = new Set());
  fields.add(name);
}

function addFolderState(item) {
  folderStates.set(item, { linkedChildren: EMPTY_NATIVE_LINKS, linkedChildrenLoaded: false, owners: new Set(), branches: new Set() });
  Object.defineProperties(item, {
    LinkedChildren: { enumerable: true, configurable: false,
      get: () => folderStates.get(item).linkedChildren,
      set: value => {
        if (value !== EMPTY_NATIVE_LINKS && value !== null && !isLinkedChildrenHandle(value)) throw new TypeError('Folder LinkedChildren requires a SQL handle, explicit empty or null.');
        const state = folderStates.get(item), previous = state.linkedChildren;
        state.revisionObserver?.release();
        if (previous !== value && isLinkedChildrenHandle(previous)) previous.store.queueRelease(previous);
        state.linkedChildren = value; state.linkedChildrenLoaded = true;
        state.linksEvicted = false;
        if (isLinkedChildrenHandle(value) && value.store.resourceGraph) {
          associateNativeItemResourceGraph(item, value.store.resourceGraph);
          if (state.owners.size) attachNativeItemResourceGraph(item, value.store.resourceGraph);
        }
        observeFolderRevision(item,state);
      } },
    LinkedChildrenLoaded: { enumerable: true, configurable: false,
      get: () => folderStates.get(item).linkedChildrenLoaded }
  });
}

function observeFolderRevision(item,state){
  state.revisionObserver?.release();state.revisionObserver=null;
  if(isLinkedChildrenHandle(state.linkedChildren)){const reference=new WeakRef(item);
    state.revisionObserver=state.linkedChildren.observe(handle=>{const current=reference.deref();if(current&&folderStates.get(current)?.linkedChildren===handle)notifyState(current,'LinkedChildren',handle);});}
}

function addSortState(item) {
  const state = { name: null, forcedSortName: null, sortName: null, options: {} };
  sortStates.set(item, state);
  Object.defineProperties(item, {
    Name: { enumerable: true, configurable: false,
      get: () => state.name,
      set: value => {
        state.name = value; state.sortName = null;
        for (const listener of nameObservers.get(item) ?? []) listener(value);
      } },
    ForcedSortName: { enumerable: true, configurable: false,
      get: () => state.forcedSortName,
      set: value => { state.forcedSortName = value; state.sortName = null; } },
    SortName: { enumerable: true, configurable: false,
      get: () => state.sortName ??= deriveSortName(item, state.options),
      set: value => { state.sortName = value; } }
  });
}

function addDateState(item) {
  const state = { value: item.DateLastSaved, json: null };
  dateStates.set(item, state);
  Object.defineProperty(item, 'DateLastSaved', {
    enumerable: true,
    configurable: false,
    get: () => state.value,
    set: value => { state.value = value; state.json = null; }
  });
}

/** Retain the DateTime Kind information that a JavaScript string cannot carry. */
export function setNativeItemJsonDateState(item, field, state) {
  if (!isNativeItemEntity(item) || field !== 'DateLastSaved' || !state || state.value !== item[field]) {
    throw new TypeError('Native JSON date state requires the matching branded DateLastSaved value.');
  }
  dateStates.get(item).json = Object.freeze({ ...state });
}

export function nativeItemJsonDateState(item, field) {
  if (!isNativeItemEntity(item) || field !== 'DateLastSaved') return null;
  return dateStates.get(item).json;
}

/** Attach the current server sort configuration without changing the live cache. */
export function configureNativeItemSort(item, options = {}) {
  const state = sortStates.get(item);
  if (!state) throw new TypeError('Native sort configuration requires a branded entity.');
  state.options = options;
  return item;
}

/** Match BaseItem's explicit cache invalidation without changing Name. */
export function clearNativeItemSortCache(item) {
  const state = sortStates.get(item);
  if (!state) throw new TypeError('Native sort cache clearing requires a branded entity.');
  state.sortName = null;
}

/** The caller supplies the already-loaded Channel referent. Inventory remains
 * live and synchronous; no getter starts an asynchronous repository read. */
export function bindNativeItemChannelAccess(item, resolve) {
  if (!isNativeItemEntity(item) || typeof resolve !== 'function') throw new TypeError('Channel access requires a typed item and a synchronous resolver.');
  channelAccess.set(item, resolve);
  return item;
}

/** Video.SourceType reads the current recording association synchronously.
 * Keep the resolver, rather than a snapshot of its result, across live clones. */
export function bindNativeItemRecordingAccess(item, resolve) {
  if (!isNativeItemEntity(item) || typeof resolve !== 'function') throw new TypeError('Recording access requires a typed item and a synchronous resolver.');
  recordingAccess.set(item, resolve);
  return item;
}

function addDerivedGetters(item, descriptor) {
  defineGetter(item, 'IsHD', () => Number(item.Height ?? 0) >= 720);
  defineGetter(item, 'SourceType', () => ['LiveTvProgram', 'LiveTvChannel'].includes(descriptor.type)
    || descriptor.family === 'video' && recordingAccess.get(item)?.(item)
    ? 'LiveTV' : descriptor.type === 'Channel' || nonemptyId(item.ChannelId) ? 'Channel' : 'Library');
  defineGetter(item, 'LocationType', () => descriptor.type === 'LiveTvChannel' ? 'Remote'
    : !item.Path ? item.SourceType === 'Channel' ? 'Remote' : 'Virtual'
      : item.Path.includes('://') && !/^file:\/\//iu.test(item.Path) ? 'Remote' : 'FileSystem');
  defineGetter(item, 'MediaType', () => descriptor.type === 'Playlist' ? item.PlaylistMediaType
    : descriptor.type === 'LiveTvChannel' ? item.ChannelType === 'Radio' ? 'Audio' : 'Video' : descriptor.mediaType);
  defineGetter(item, 'UnratedType', () => descriptor.sourceAwareUnrated && item.SourceType === 'Channel'
    ? 'ChannelContent' : descriptor.unratedType);
  defineGetter(item, 'IsFolder', () => descriptor.dynamicFolder ? Boolean(nonemptyId(item.ParentId)) : descriptor.isFolder);
  defineGetter(item, 'IsHidden', () => descriptor.isHidden);
  defineGetter(item, 'IsDisplayedAsFolder', () => descriptor.isDisplayedAsFolder);
  defineGetter(item, 'SupportsPlayedStatus', () => playedStatusTypes.has(descriptor.type));
  defineGetter(item, 'EnableRememberingTrackSelections', () => descriptor.type !== 'LiveTvChannel');
  defineGetter(item, 'EnableMediaSourceDisplay', function nativeMediaSourceDisplay() {
    if (item.SourceType === 'Channel' && !nonemptyId(item.ChannelId)) {
      throw libraryError(400, "Guid can't be empty (Parameter 'id')");
    }
    return item.SourceType === 'Channel' ? channelAccess.get(item)?.(item) ?? true : true;
  }, false); // An unselected lazy virtual getter must not execute in object spreads.
  defineGetter(item, 'SupportsPositionTicksResume', () => descriptor.family === 'video'
    ? !['Sample', 'ThemeVideo', 'Trailer'].includes(item.ExtraType) : ['AudioBook', 'Book'].includes(descriptor.type));
  if (descriptor.dynamicFolder) defineGetter(item, 'IsAccessedByName', () => !nonemptyId(item.ParentId));
  if (descriptor.type === 'UserView') defineGetter(item, 'CollectionType', () => item.ViewType);
  if (descriptor.type === 'PlaylistsFolder') defineGetter(item, 'CollectionType', () => 'playlists');
  if (['AggregateFolder', 'CollectionFolder'].includes(descriptor.type)) {
    defineGetter(item, 'PhysicalLocations', () => item.PhysicalLocationsList);
  } else defineGetter(item, 'PhysicalLocations', () => hasFileProtocol(item) ? [item.Path] : EMPTY_STRINGS);
  const displayPreferencesId = guid(md5Guid(descriptor.nativeType));
  defineGetter(item, 'DisplayPreferencesId', ['Folder', 'CollectionFolder'].includes(descriptor.type)
    ? () => item.Id : () => displayPreferencesId);
}

function addTypeDefaults(item, descriptor) {
  if (descriptor.family === 'folder') {
    item.IsRoot = descriptor.type === 'UserRootFolder';
    item.DateLastMediaAdded = null;
    addFolderState(item);
  }
  if (descriptor.family === 'video') Object.assign(item, {
    AdditionalParts: EMPTY_STRINGS, LocalAlternateVersions: EMPTY_STRINGS,
    LinkedAlternateVersions: EMPTY_LINKED_CHILDREN, SubtitleFiles: EMPTY_STRINGS, AudioFiles: EMPTY_STRINGS,
    Timestamp: null, DefaultVideoStreamIndex: null, IsoType: null, Video3DFormat: null, AspectRatio: null,
    HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile'
  });
  if (descriptor.hasArtist) item.Artists = EMPTY_STRINGS;
  if (descriptor.hasAlbumArtist) item.AlbumArtists = EMPTY_STRINGS;
  if (descriptor.family === 'audio') Object.assign(item, { Album: null, HasLyrics: null, LyricFiles: EMPTY_STRINGS });
  if (descriptor.hasSeries) Object.assign(item,
    { SeriesId: EMPTY_ID, SeriesName: null, SeriesPresentationUniqueKey: null });
  switch (descriptor.type) {
    case 'AggregateFolder':
      item.PhysicalLocationsList = EMPTY_STRINGS;
      aggregateStates.set(item, { virtualChildren: [] });
      defineGetter(item, 'VirtualChildren', () => aggregateStates.get(item).virtualChildren);
      break;
    case 'CollectionFolder':
      Object.assign(item, { PhysicalLocationsList: EMPTY_STRINGS, PhysicalFolderIds: EMPTY_GUIDS, CollectionType: null });
      break;
    case 'UserView': Object.assign(item, { ViewType: null, UserId: null }); break;
    case 'PlaylistsFolder': item.Name = 'Playlists'; break;
    case 'Playlist': Object.assign(item,
      { OwnerUserId: EMPTY_ID, OpenAccess: false, Shares: EMPTY_PLAYLIST_SHARES, PlaylistMediaType: 'Unknown' }); break;
    case 'Movie': item.TmdbCollectionName = null; break;
    case 'Episode': Object.assign(item, { SeasonId: EMPTY_ID, SeasonName: null, AirsBeforeSeasonNumber: null,
      AirsAfterSeasonNumber: null, AirsBeforeEpisodeNumber: null, IndexNumberEnd: null });
      defineGetter(item, 'AiredSeasonNumber', () => item.AirsAfterSeasonNumber ?? item.AirsBeforeSeasonNumber ?? item.ParentIndexNumber);
      break;
    case 'Series': Object.assign(item, { AirDays: EMPTY_AIR_DAYS, AirTime: null, DisplayOrder: null, Status: null }); break;
    case 'BoxSet': Object.assign(item, { DisplayOrder: 'PremiereDate', LibraryFolderIds: null }); break;
    case 'Trailer': item.TrailerTypes = EMPTY_TRAILER_TYPES; break;
    case 'LiveTvProgram':
      Object.assign(item, { IsVirtualItem: true, StartDate: MIN_DATE, SeriesName: null, ShowId: null });
      for (const [name, tag] of [['IsLive', 'Live'], ['IsNews', 'News'], ['IsKids', 'Kids'],
        ['IsSports', 'Sports'], ['IsPremiere', 'Premiere']]) {
        defineGetter(item, name, () => item.Tags.some(value => value != null && ordinalIgnoreCaseKey(value) === ordinalIgnoreCaseKey(tag)));
      }
      Object.assign(item, { IsMovie: false, IsSeries: false, IsRepeat: false, EpisodeTitle: null });
      break;
    case 'LiveTvChannel':
      Object.assign(item, { Number: null, ChannelType: 'TV', ServiceName: null, IsMovie: false,
        IsSeries: false, IsRepeat: false, IsNews: false, IsSports: false, EpisodeTitle: null });
      defineGetter(item, 'IsKids', () => item.Tags.some(value => value != null && ordinalIgnoreCaseKey(value) === ordinalIgnoreCaseKey('Kids')));
      break;
    case 'Photo': Object.assign(item, { CameraMake: null, CameraModel: null, Software: null, ExposureTime: null,
      FocalLength: null, Orientation: null, Aperture: null, ShutterSpeed: null, Latitude: null, Longitude: null,
      Altitude: null, IsoSpeedRating: null }); break;
    default: break;
  }
}

/** Construct the current pinned CLR-equivalent live shape for one exact known type. */
export function newNativeItemEntity(nativeType) {
  const descriptor = nativeItemDescriptor(nativeType);
  const values = {
    Id: EMPTY_ID, Path: null, ParentId: EMPTY_ID, OwnerId: EMPTY_ID, ChannelId: EMPTY_ID,
    PrimaryVersionId: null, PresentationUniqueKey: null,
    Container: null, ShortcutPath: null, IsShortcut: false, IsInMixedFolder: false, IsLocked: false,
    IsVirtualItem: false, ProductionYear: null, IndexNumber: null, ParentIndexNumber: null,
    Size: null, RunTimeTicks: null, ExtraType: null,
    Width: 0, Height: 0, CommunityRating: null, CriticRating: null, Overview: null, OfficialRating: null,
    CustomRating: null, OriginalTitle: null, OriginalLanguage: null, Tagline: null,
    DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
    PremiereDate: null, EndDate: null,
    Genres: EMPTY_STRINGS, Studios: EMPTY_STRINGS, Tags: EMPTY_STRINGS, ProductionLocations: EMPTY_STRINGS,
    ProviderIds: {}, LockedFields: EMPTY_METADATA_FIELDS, ImageInfos: EMPTY_IMAGES,
    RemoteTrailers: EMPTY_MEDIA_URLS, UserData: [], Data: {}
  };
  const item = new Proxy(values, {
    get(target,key) { const value=target[key];return stateObservers.has(item)&&typeof key==='string'?observedValue(item,key,value):value; },
    set(target,key,value) { writeOwnField(target,key,value);if(typeof key==='string')notifyState(item,key,value);return true; },
    deleteProperty(target,key) { const result=Reflect.deleteProperty(target,key);if(result&&typeof key==='string')notifyState(item,key,undefined,true);return result; },
    defineProperty(target,key,descriptor) { const result=Reflect.defineProperty(target,key,descriptor);if(result&&typeof key==='string'&&stateObservers.has(item))notifyState(item,key,item[key]);return result; }
  });
  defineReadonly(item, 'NativeType', nativeType);
  defineReadonly(item, 'Type', descriptor.type);
  nativeItems.add(item);
  addDateState(item);
  addSortState(item);
  defineGetter(item, 'BaseDisplayParentId', () => descriptor.type === 'Season' ? item.SeriesId
    : descriptor.type === 'Episode' ? item.SeasonId : item.ParentId);
  if (descriptor.type === 'UserView') item.DisplayParentId = EMPTY_ID;
  else defineGetter(item, 'DisplayParentId', () => item.BaseDisplayParentId);
  addDerivedGetters(item, descriptor);
  addTypeDefaults(item, descriptor);
  return item;
}

function cloneValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (value === EMPTY_NATIVE_LINKS) return value;
  if (isLinkedChildrenHandle(value)) return value.retain();
  if (sharedNativeArrays.has(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (isNativeItemEntity(value)) return cloneEntity(value, seen);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const result = new Map(); seen.set(value, result);
    for (const [key, entry] of value) result.set(cloneValue(key, seen), cloneValue(entry, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set(); seen.set(value, result);
    for (const entry of value) result.add(cloneValue(entry, seen));
    return result;
  }
  if (ArrayBuffer.isView(value)) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof DataView) return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    return value.slice();
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  const enumerableValues = { ...value };
  const enumerableKeys = new Set(Reflect.ownKeys(enumerableValues));
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const cloned = cloneValue(enumerableKeys.has(key) ? enumerableValues[key] : value[key], seen);
    Object.defineProperty(result, key, { value: cloned, enumerable: enumerableKeys.has(key), writable: true, configurable: true });
  }
  return result;
}

function exactValue(actual, expected) {
  return Object.is(actual, expected) || isDeepStrictEqual(actual, expected);
}

function readonlyValue(item, key) {
  return readonlyFields.get(item)?.has(key) === true;
}

function defineRepositoryColumns(item, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('NativeRepositoryColumns must be an immutable repository row object.');
  }
  const frame = Object.isFrozen(value) ? value : Object.freeze({ ...value });
  Object.defineProperty(item, repositoryColumnsField, {
    value: frame, enumerable: false, writable: false, configurable: true
  });
}

/** Rebind only the immutable repository frame while preserving every live
 * entity/private relation identity. */
export function copyNativeItemRepositoryFrame(target, source) {
  if (!isNativeItemEntity(target) || !isNativeItemEntity(source)) {
    throw new TypeError('Native repository frames can only be copied between branded entities.');
  }
  const frame = source.NativeRepositoryColumns;
  if (!frame || guid(frame.Id) !== guid(target.Id) || frame.Type !== target.NativeType) {
    throw new TypeError('A native repository frame requires the same persisted entity identity.');
  }
  defineRepositoryColumns(target, frame);
  return target;
}

function applyValues(target, sources, { validateReadonly, copyNonEnumerable = false } = {}) {
  const expected = [];
  for (const source of sources) {
    if (source == null) continue;
    if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Native item values must be plain object sources.');
    const enumerableKeys = new Set(Object.keys(source));
    for (const key of copyNonEnumerable ? Reflect.ownKeys(source) : enumerableKeys) {
      if (typeof key !== 'string') continue;
      const value = source[key];
      if (key === repositoryColumnsField) {
        defineRepositoryColumns(target, value);
        continue;
      }
      if (privateStateFields.has(key) || readonlyValue(target, key)) {
        if (validateReadonly) expected.push([key, value]);
        continue;
      }
      const cloned = cloneValue(value, new Map());
      if (!Object.hasOwn(target, key)) {
        Object.defineProperty(target, key, { value: cloned, enumerable: enumerableKeys.has(key), writable: true, configurable: true });
      } else {
        target[key] = cloned;
      }
    }
  }
  if (validateReadonly) for (const [key, value] of expected) {
    if (!exactValue(target[key], value)) throw new TypeError(`Native producer supplied an inconsistent ${key}.`);
  }
  return target;
}

/** Apply resolver/provider-owned plain values without flattening native getters. */
export function applyNativeItemValues(target, ...plainSources) {
  if (!isNativeItemEntity(target)) throw new TypeError('Native item values require a branded target entity.');
  for (const source of plainSources) if (isNativeItemEntity(source)) {
    throw new TypeError('Use copyNativeItemState to copy a branded native entity.');
  }
  return applyValues(target, plainSources, { validateReadonly: true });
}

function copyInternal(target, source, seen) {
  if (!isNativeItemEntity(target) || !isNativeItemEntity(source)) {
    throw new TypeError('Native item state can only be copied between branded entities.');
  }
  if (target.NativeType !== source.NativeType) throw new TypeError('Native item state requires matching exact native types.');
  seen.set(source, target);
  if (channelAccess.has(source)) channelAccess.set(target, channelAccess.get(source));
  if (recordingAccess.has(source)) recordingAccess.set(target, recordingAccess.get(source));
  const sourceKeys = new Set(Reflect.ownKeys(source));
  for (const key of Reflect.ownKeys(target)) {
    if (sourceKeys.has(key) || typeof key === 'string' && key !== repositoryColumnsField
      && (privateStateFields.has(key) || readonlyValue(target, key))) continue;
    delete target[key];
  }
  const enumerableKeys = new Set(Object.keys(source));
  const recordingDerived = recordingAccess.has(source) && nativeItemDescriptor(source.NativeType).family === 'video';
  const expected = [];
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string' || privateStateFields.has(key) || sortStateFields.has(key) || deferredNativeGetters.has(key)) continue;
    // Recording association belongs to the candidate object, not its copied
    // fields. Both constructor getters must evaluate the copied resolver with
    // their own entity; they are not source/target equality invariants.
    if (recordingDerived && (key === 'SourceType' || key === 'UnratedType')) continue;
    const value = source[key];
    if (key === repositoryColumnsField) {
      defineRepositoryColumns(target, value);
      continue;
    }
    if (readonlyValue(target, key)) { expected.push([key, value]); continue; }
    const cloned = cloneValue(value, seen);
    if (!Object.hasOwn(target, key)) {
      Object.defineProperty(target, key, { value: cloned, enumerable: enumerableKeys.has(key), writable: true, configurable: true });
    } else {
      target[key] = cloned;
    }
  }
  const sourceFolder = folderStates.get(source), targetFolder = folderStates.get(target);
  if (sourceFolder && targetFolder) {
    targetFolder.revisionObserver?.release();
    const previous = targetFolder.linkedChildren;
    targetFolder.linkedChildren = cloneValue(sourceFolder.linkedChildren, seen);
    if (isLinkedChildrenHandle(previous)) previous.store.queueRelease(previous);
    targetFolder.linkedChildrenLoaded = sourceFolder.linkedChildrenLoaded;
    observeFolderRevision(target,targetFolder);
  }
  const sourceAggregate = aggregateStates.get(source), targetAggregate = aggregateStates.get(target);
  if (sourceAggregate && targetAggregate) targetAggregate.virtualChildren = cloneValue(sourceAggregate.virtualChildren, seen);
  const sourceSort = sortStates.get(source), targetSort = sortStates.get(target);
  if (sourceSort && targetSort) {
    targetSort.name = cloneValue(sourceSort.name, seen);
    targetSort.forcedSortName = cloneValue(sourceSort.forcedSortName, seen);
    targetSort.sortName = cloneValue(sourceSort.sortName, seen);
    targetSort.options = sourceSort.options;
  }
  const sourceDate = dateStates.get(source), targetDate = dateStates.get(target);
  if (sourceDate && targetDate) targetDate.json = sourceDate.json;
  for (const [key, value] of expected) if (!exactValue(target[key], value)) {
    throw new TypeError(`Copied native state produced an inconsistent ${key}.`);
  }
  return target;
}

/** Copy live entity state while retaining the target object's cache identity. */
export function copyNativeItemState(target, source) {
  const result = copyInternal(target, source, new Map());
  for (const field of ['Name','ForcedSortName','SortName','LinkedChildren']) if (Object.hasOwn(target,field)) notifyState(target,field,target[field]);
  return result;
}

function cloneEntity(source, seen) {
  if (!isNativeItemEntity(source)) throw new TypeError('Only a branded native entity can be cloned.');
  if (seen.has(source)) return seen.get(source);
  const target = newNativeItemEntity(source.NativeType);
  return copyInternal(target, source, seen);
}

/** Clone a live entity without flattening getters or its private folder state. */
export function cloneNativeItemEntity(source) {
  return cloneEntity(source, new Map());
}

/** Capture live state for a bounded operation whose remaining objects reside
 * in PostgreSQL. Restore constructor getters and private loading/cache state. */
export async function captureNativeItemState(item, { linkedChildren, session, scopeId, slotId } = {}) {
  if (!isNativeItemEntity(item)) throw new TypeError('Native state capture requires a branded entity.');
  const values = {};
  for (const key of Object.keys(item)) if (!sortStateFields.has(key) && key !== 'LinkedChildren') Object.defineProperty(values, key, {
    value: item[key], enumerable: true, writable: true, configurable: true
  });
  const sorting = sortStates.get(item);
  const enumerableKeys = new Set(Object.keys(item));
  const hiddenValues = Object.fromEntries(Object.getOwnPropertyNames(item)
    .filter(key => key !== repositoryColumnsField && !enumerableKeys.has(key) && !deferredNativeGetters.has(key))
    .map(key => [key, item[key]]));
  return { values, hiddenValues, repositoryColumns: item.NativeRepositoryColumns,
    folder: folderStates.has(item) ? { loaded: item.LinkedChildrenLoaded,
      kind: item.LinkedChildren === null ? 'null' : item.LinkedChildren === EMPTY_NATIVE_LINKS ? 'empty' : 'relation',
      token: isLinkedChildrenHandle(item.LinkedChildren) ? await linkedChildren.pinState(item.LinkedChildren, { session, scopeId, slotId }) : null } : null,
    date: dateStates.get(item),
    sorting: { name: sorting.name, forcedSortName: sorting.forcedSortName, sortName: sorting.sortName } };
}

export async function restoreNativeItemState(state, options = {}, { linkedChildren, session } = {}) {
  const item = newNativeItemEntity(state.values.NativeType);
  applyValues(item, [state.values], { validateReadonly: false });
  for (const [key, value] of Object.entries(state.hiddenValues)) {
    Object.defineProperty(item, key, { value, enumerable: false, writable: true, configurable: true });
  }
  if (state.repositoryColumns) defineRepositoryColumns(item, state.repositoryColumns);
  if (state.folder) folderStates.set(item, {
    linkedChildren: state.folder.kind === 'null' ? null : state.folder.kind === 'empty' ? EMPTY_NATIVE_LINKS
      : await linkedChildren.restoreState(state.folder.token, { session }), linkedChildrenLoaded: state.folder.loaded, owners: new Set(), branches: new Set() });
  if(state.folder)observeFolderRevision(item,folderStates.get(item));
  if (state.date) Object.assign(dateStates.get(item), state.date);
  Object.assign(sortStates.get(item), state.sorting, { options });
  return item;
}

export function hydrateNativeItemEntity(stored, relations = {}) {
  if (!stored || typeof stored !== 'object') throw new TypeError('Native hydration requires stored item state.');
  const item = isNativeItemEntity(stored) ? cloneNativeItemEntity(stored) : newNativeItemEntity(stored.NativeType);
  const descriptor = nativeItemDescriptor(item.NativeType);
  if (!isNativeItemEntity(stored)) applyValues(item, [stored], { validateReadonly: false, copyNonEnumerable: true });
  for (const field of ['ParentId', 'OwnerId', 'ChannelId', ...(descriptor.hasSeries ? ['SeriesId'] : []),
    ...(descriptor.type === 'Episode' ? ['SeasonId'] : [])]) item[field] ??= EMPTY_ID;
  for (const field of ['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved']) item[field] ??= MIN_DATE;
  if (descriptor.family === 'folder') item.DateLastMediaAdded ??= MIN_DATE;
  if (Object.hasOwn(relations, 'lockedFields')) item.LockedFields = cloneValue(relations.lockedFields, new Map());
  if (Object.hasOwn(relations, 'images')) item.ImageInfos = cloneValue(relations.images, new Map());
  if (Object.hasOwn(relations, 'userData')) item.UserData = cloneValue(relations.userData, new Map());
  if (descriptor.type === 'Trailer' && Object.hasOwn(relations, 'trailerTypes')) {
    item.TrailerTypes = cloneValue(relations.trailerTypes, new Map());
  }
  if (descriptor.family === 'folder' && Object.hasOwn(relations, 'linkedChildren')) item.LinkedChildren = relations.linkedChildren;
  if (descriptor.family === 'video' && Object.hasOwn(relations, 'videoLinks')) {
    item.LinkedAlternateVersions = cloneValue(relations.videoLinks, new Map()).filter(link => Number(link.Type) === 3);
  }
  return item;
}

/** TV resolver relationships are derived from authoritative parent entities. */
export function initializeNativeResolvedRelationships(item, { parent, parents = [] } = {}) {
  if (item.Type === 'Season') {
    if (parent?.Type !== 'Series') throw new TypeError('A resolved Season requires its Series parent.');
    item.SeriesId = parent.Id;
    item.SeriesName = parent.Name;
  } else if (item.Type === 'Episode') {
    const series = [parent, ...parents].find(value => value?.Type === 'Series');
    if (series) {
      item.SeriesId = series.Id;
      item.SeriesName = series.Name;
    }
    const season = [parent, ...parents].find(value => value?.Type === 'Season');
    if (season) {
      item.SeasonId = season.Id;
      item.SeasonName = season.Name;
    }
  }
  return item;
}

/** Consume one relation lease on assignment; no opaque wrapping of member arrays. */
export function publishNativeItemLinks(item, handle) {
  if (!folderStates.has(item)) throw new TypeError('Native link assignment requires a Folder.');
  item.LinkedChildren = handle; return item;
}
function clearNativeItemLinkBranch(state) {
  state.revisionObserver?.release(); state.revisionObserver = null;
  let failure;
  try { if (isLinkedChildrenHandle(state.linkedChildren)) state.linkedChildren.store.queueRelease(state.linkedChildren); }
  catch (error) { failure = error; }
  state.linkedChildren = EMPTY_NATIVE_LINKS; state.linkedChildrenLoaded = false;
  state.linksEvicted = true;
  if (failure) throw failure;
}
export function releaseNativeItemLinks(item) {
  const state = folderStates.get(item);
  if (!state) return;
  const failures = [];
  for (const key of state.resources?.keys() ?? []) {
    try { removeNativeItemResource(item, key); } catch (error) { failures.push(error); }
  }
  if (state.branches.size === 0 && !state.base) {
    try { clearNativeItemLinkBranch(state); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Native item resource release failed.');
}
export function retainNativeItemLinks(item) {
  const state = folderStates.get(item);
  return state && isLinkedChildrenHandle(state.linkedChildren) ? state.linkedChildren.retain() : EMPTY_NATIVE_LINKS;
}

/** Restore a SQL-backed branch after its last materialized owner left. Live
 * assignments remain authoritative; eviction is separate from a native reset. */
export async function restoreEvictedNativeItemLinks(item, captured, { linkedChildren, session }) {
  const state = folderStates.get(item);
  if (!state?.linksEvicted || !captured.folder) return;
  const folder = captured.folder;
  const restored = folder.kind === 'null' ? null : folder.kind === 'empty' ? EMPTY_NATIVE_LINKS
    : await linkedChildren.restoreState(folder.token, { session });
  if (!state.linksEvicted) {
    if (isLinkedChildrenHandle(restored)) await linkedChildren.release(restored, { session });
    return;
  }
  state.linkedChildren = restored;
  state.linkedChildrenLoaded = folder.loaded; state.linksEvicted = false;
  observeFolderRevision(item, state);
}

function associateNativeItemResourceGraph(item, graph) {
  const state = folderStates.get(item);
  if (!state || state.graph === graph) return state;
  if (state.base || state.graphRoot) throw new TypeError('An exact Folder cannot belong to two active SQL resource graphs.');
  const entity = graph.entity(item);
  state.graph = graph; state.entity = entity;
  return state;
}

/** Register the exact object's basic state before registering host caches.
 * SQL drives pending direct-child preparation, including warm descendants
 * which have never built a SQL Children or IDs resource. */
export function attachNativeItemResourceGraph(item, graph) {
  const state = associateNativeItemResourceGraph(item, graph);
  if (!state) return null;
  graph.entity(item); // Validate a fresh admission before starting async work.
  if (state.base) return state.entity;
  if (state.owners.size && !state.graphRoot) state.graphRoot = state.entity.retain();
  const base = { resource: null, dirty: false, linked: false, reference: new WeakRef(item),
    exact: cachedFolderChildrenSnapshot(item) !== undefined || aggregateStates.get(item)?.virtualChildren.length ? item : null };
  state.base = base;
  const refresh = () => {
    const current = base.reference.deref();
    base.exact = current && (cachedFolderChildrenSnapshot(current) !== undefined || aggregateStates.get(current)?.virtualChildren.length)
      ? current : null;
    if (base.resource) base.resource.refresh(); else base.dirty = true;
  };
  const assignment = observeFolderChildrenAssignment(item, refresh);
  const virtual = observeNativeItemState(item, (_item, field) => { if (field === 'VirtualChildren') refresh(); });
  base.ready = graph.bind(state.entity, {
    prepare: resource => {
      const current = base.exact ?? base.reference.deref();
      const children = current && cachedFolderChildrenSnapshot(current), extra = current && aggregateStates.get(current)?.virtualChildren;
      base.exact = current && (children !== undefined || extra?.length) ? current : null;
      const linked = children !== undefined || Boolean(extra?.length);
      if (!linked && !base.linked) return;
      base.linked = linked;
      return resource.replaceLinks((function* () {
        // Only this object's direct members are read here. New child bindings
        // are prepared later by the SQL reachable-pending query.
        for (const list of [children, extra]) for (const child of list ?? []) {
          if (folderStates.has(child)) yield attachNativeItemResourceGraph(child, graph);
        }
      })());
    },
    detach() {
      assignment.release(); virtual.release();
      if (state.base === base) state.base = null;
    },
    release() {
      if (!state.base && state.owners.size === 0 && state.branches.size === 0) clearNativeItemLinkBranch(state);
    },
  });
  base.ready.then(resource => {
    base.resource = resource;
    if (base.dirty) resource.refresh();
  }, () => {
    // SQL failure is retained by the graph's mutation tail and surfaces from
    // flush/close. Remove only this failed registration's observers.
    assignment.release(); virtual.release();
    if (state.base === base) state.base = null;
  });
  return state.entity;
}

/** Run derived resource work through an existing ordinary owner's capability.
 * A call without such an owner still needs normal graph admission. */
export function withNativeItemResourceAdmission(item, operation) {
  const state = folderStates.get(item);
  return state?.graphRoot ? state.graphRoot.run(operation) : operation();
}

function detachResourceBinding(state, key, binding) {
  if (state.resources?.get(key) === binding) state.resources.delete(key);
  if (binding.detached) return;
  binding.detached = true; binding.resource.detached?.();
}

/** The SQL binding owns one physical lease. Ordinary owners and retained query
 * views supply separate graph roots; an internal cache lease is never a root. */
export function setNativeItemResource(item, key, resource) {
  const state = folderStates.get(item);
  if (!state || typeof key !== 'symbol' || typeof resource?.retain !== 'function'
    || resource.detached !== undefined && typeof resource.detached !== 'function') {
    throw new TypeError('A Folder, resource key and retaining resource are required.');
  }
  if (state.graph) attachNativeItemResourceGraph(item, state.graph);
  const lease = state.graph || state.owners.size ? resource.retain() : null;
  if ((state.graph || state.owners.size) && typeof lease?.release !== 'function') throw new TypeError('An item resource must retain a releasable lease.');
  try { removeNativeItemResource(item, key); }
  catch (error) { lease?.release(); throw error; }
  const binding = { item, resource, lease, detached: false, unbound: false, graphResource: null };
  (state.resources ??= new Map()).set(key, binding);
  if (state.graph) {
    binding.ready = state.graph.bind(state.entity, {
      detach: () => detachResourceBinding(state, key, binding), release: () => lease.release(),
    }).then(value => {
      binding.graphResource = value;
      if (binding.unbound) value.unbind();
      return value;
    }).catch(async error => {
      const errors = [error];
      try { detachResourceBinding(state, key, binding); } catch (cleanup) { errors.push(cleanup); }
      try { await lease.release(); } catch (cleanup) { errors.push(cleanup); }
      throw errors.length === 1 ? error : new AggregateError(errors, error.message, { cause: error });
    });
    binding.ready.catch(() => {}); // Graph tail and the building caller retain the actual failure.
  } else binding.ready = Promise.resolve();
  return Object.freeze({ ready: binding.ready, unbind: () => unbindResourceBinding(state, key, binding), retain: () => {
    if (!binding.graphResource) throw new Error('The SQL native resource binding is not ready.');
    return binding.graphResource.retain();
  }, link: (child, options) => {
    if (!binding.graphResource) throw new Error('The SQL native resource binding is not ready.');
    const entity = attachNativeItemResourceGraph(child, state.graph);
    return entity ? binding.graphResource.link(entity, options) : null;
  } });
}

export function removeNativeItemResource(item, key) {
  const state = folderStates.get(item), binding = state?.resources?.get(key);
  if (!binding) return;
  unbindResourceBinding(state, key, binding);
}

function unbindResourceBinding(state, key, binding) {
  if (binding.unbound) return;
  try { detachResourceBinding(state, key, binding); }
  finally {
    binding.unbound = true;
    if (state.graph) {
      binding.graphResource?.unbind();
    } else binding.lease?.release();
  }
}

/** Keep the exact mutable link branch without retaining the Folder's other
 * resources. A Children edge can therefore borrow links in either direction
 * without turning its SQL cache resources into an entity-owner cycle. */
export function acquireNativeItemLinkBranch(item) {
  const state = folderStates.get(item);
  if (!state) return Object.freeze({ release() {} });
  const branch = Symbol('native-item-link-branch');
  state.branches.add(branch);
  let released = false;
  return Object.freeze({ release() {
    if (released) return;
    released = true; state.branches.delete(branch);
    if (state.owners.size === 0 && state.branches.size === 0 && !state.base) clearNativeItemLinkBranch(state);
  } });
}

/** Own the live entity branch, not a second frozen revision. Cache eviction
 * cannot invalidate a request's in-flight item; each clone owns its own branch. */
export function acquireNativeItemLinkOwner(item) {
  const state = folderStates.get(item);
  if (!state) return Object.freeze({ release() {} });
  if (state.graph) {
    state.graph.entity(item);
    if (!state.graphRoot) state.graphRoot = state.entity.retain();
    attachNativeItemResourceGraph(item, state.graph);
  } else if (state.owners.size === 0) {
    const acquired = [];
    try {
      for (const binding of state.resources?.values() ?? []) {
        const lease = binding.resource.retain();
        if (typeof lease?.release !== 'function') throw new TypeError('An item resource must retain a releasable lease.');
        binding.lease = lease; acquired.push(binding);
      }
    } catch (error) {
      const failures = [error];
      for (const binding of acquired) {
        try { binding.lease.release(); } catch (cleanup) { failures.push(cleanup); }
        binding.lease = null;
      }
      throw failures.length === 1 ? error : new AggregateError(failures, error.message, { cause: error });
    }
  }
  const owner = Symbol('native-item-link-owner');
  state.owners.add(owner);
  reportLinkOwnership(item, { phase: 'acquired', owner, count: state.owners.size });
  let released = false;
  return Object.freeze({ release() {
    if (released) return;
    released = true;
    state.owners.delete(owner);
    reportLinkOwnership(item, { phase: 'released', owner, count: state.owners.size });
    if (state.owners.size === 0) {
      if (state.graphRoot) { state.graphRoot.release(); state.graphRoot = null; }
      else releaseNativeItemLinks(item);
    }
  } });
}

function reportLinkOwnership(item, event) {
  for (const listener of linkOwnershipObservers.get(item) ?? []) {
    try { listener(event); } catch { /* Diagnostics cannot alter entity ownership. */ }
  }
}

/** Diagnostic observations of actual leases; never an admission or query gate. */
export function observeNativeItemLinkOwnership(item, listener) {
  const state = folderStates.get(item);
  if (!state || typeof listener !== 'function') throw new TypeError('A native Folder and ownership observer are required.');
  let listeners = linkOwnershipObservers.get(item);
  if (!listeners) linkOwnershipObservers.set(item, listeners = new Set());
  listeners.add(listener);
  for (const owner of state.owners) {
    try { listener({ phase: 'existing', owner, count: state.owners.size }); }
    catch { /* Diagnostics cannot alter entity ownership. */ }
  }
  return Object.freeze({ release() {
    listeners.delete(listener);
    if (!listeners.size) linkOwnershipObservers.delete(item);
  } });
}

/** Observe this exact captured instance. A clone's Name has no subscription. */
export function observeNativeItemName(item, listener) {
  if (!isNativeItemEntity(item) || typeof listener !== 'function') throw new TypeError('A native item and Name listener are required.');
  let listeners = nameObservers.get(item);
  if (!listeners) nameObservers.set(item, listeners = new Set());
  listeners.add(listener);
  return Object.freeze({ release() { listeners.delete(listener); if (!listeners.size) nameObservers.delete(item); } });
}

/** Field changes belong to this exact live instance; repository rehydration
 * and clones do not inherit its consumers. Nested mutable DTO arrays and
 * dictionaries report their enclosing field, without retaining any cohort. */
export function observeNativeItemState(item, listener) {
  if (!isNativeItemEntity(item) || typeof listener !== 'function') throw new TypeError('A native entity and field listener are required.');
  let listeners=stateObservers.get(item);if(!listeners)stateObservers.set(item,listeners=new Set());
  listeners.add(listener);let released=false;const reference=new WeakRef(item);
  return Object.freeze({release(){if(released)return;released=true;listeners.delete(listener);const current=reference.deref();if(current&&!listeners.size)stateObservers.delete(current);}});
}
