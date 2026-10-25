import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { cloneNativeItemValue } from '../../src/library/native-item-value.js';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import {
  hydrateNativeItemEntity,
  nativeItemDescriptor,
  newNativeItemEntity,
  publishNativeItemLinks,
  releaseNativeItemLinks,
} from '../../src/library/native-item-entity.js';
import {
  nativeItemJsonContract,
  serializeNativeItemData,
} from '../../src/library/native-item-data.js';
import { dateText, EMPTY_ID, guid, idKey, loadLibrary, mapRecord, MIN_DATE } from '../../src/library/records.js';
import { mapNativeItemRow, saveNativeItems } from '../../src/metadata/persistence.js';
import { imageTypes } from '../../src/metadata/image-paths.js';
import { metadataFields } from '../../src/library/metadata-context.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { readItemTrailerRows } from '../../src/library/trailer-order.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const videoTypes = new Set(['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer']);
const folderObjects = new Set(['Folder', 'AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'UserView',
  'PlaylistsFolder', 'Playlist', 'Series', 'Season', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'PhotoAlbum']);
const audioObjects = new Set(['Audio', 'AudioBook']);
const hasSeriesTypes = new Set(['Episode', 'Season', 'AudioBook', 'Book']);
const artistTypes = new Set(['Audio', 'AudioBook', 'MusicVideo', 'MusicAlbum']);
const albumArtistTypes = new Set(['Audio', 'AudioBook', 'MusicAlbum']);
const collectionTypes = new Set(['CollectionFolder', 'UserView', 'PlaylistsFolder']);
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample',
  'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const programAudioTypes = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];
const linkedChildTypes = ['Manual', 'Shortcut', 'LocalAlternateVersion', 'LinkedAlternateVersion'];
const trailerTypes = [null, 'ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'];
const itemValueTypes = ['Artist', 'AlbumArtist', 'Genre', 'Studios', 'Tags', 'Unknown', 'InheritedTags'];
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)
  && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
const clone = value => value == null ? value : cloneNativeItemValue(value);
const enumName = (value, values) => typeof value === 'number' ? values[value] ?? String(value) : value?.toString();
const shortName = item => item.Type ?? item.NativeType?.split('.').at(-1);
const saveGuid = (index, value) => `96000000-0000-0000-${String(index).padStart(4, '0')}-${String(value).padStart(12, '0')}`;
const caseGuid = (prefix, index, value) => `${prefix}00000-0000-0000-${String(index).padStart(4, '0')}-${String(value).padStart(12, '0')}`;
const utc = (year, month, day, hour, minute, second, ticks) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(ticks).padStart(7, '0')}Z`;
const nullableDate = value => value == null ? null : dateText(value);

const logArgument = value => value == null ? '' : typeof value === 'bigint' ? String(value) : String(value);

function captureLogger() {
  const events = [];
  const emit = (level, template, ...args) => {
    let index = 0;
    const message = String(template).replace(/\{[^{}]+\}/gu,
      () => index < args.length ? logArgument(args[index++]) : '');
    events.push({ level, eventId: 0, eventName: null, message, exceptionType: null, exceptionMessage: null });
  };
  return {
    events,
    info: (template, ...args) => emit('Information', template, ...args),
    warn: (template, ...args) => emit('Warning', template, ...args),
    error: (template, ...args) => emit('Error', template, ...args),
  };
}

export const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizePath(value, root) {
  return value == null ? value : String(value).replaceAll(root, '$STATE');
}

function rewrite(value, root) {
  if (Array.isArray(value)) return value.map(entry => rewrite(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, rewrite(entry, root)]));
  return typeof value === 'string' ? normalizePath(value, root) : integer(value);
}

function normalizeDataText(value, root) {
  if (value == null) return null;
  const escapedRoot = JSON.stringify(root).slice(1, -1);
  return value.replaceAll(escapedRoot, '$STATE').replaceAll(root, '$STATE');
}

export function projectJsonText(text, root) {
  if (text == null) return { isNull: true, text: null, parsed: null, parseErrorType: null, parseErrorMessage: null };
  const normalized = normalizeDataText(String(text), root);
  try {
    return { isNull: false, text: normalized, parsed: rewrite(parseLosslessJson(String(text)), root),
      parseErrorType: null, parseErrorMessage: null };
  } catch (error) {
    return { isNull: false, text: normalized, parsed: null,
      parseErrorType: error.name, parseErrorMessage: error.message };
  }
}

function projectedImage(image, root) {
  return {
    path: normalizePath(image.Path, root),
    type: enumName(image.Type, imageTypes),
    dateModified: dateText(image.DateModified),
    Width: image.Width,
    Height: image.Height,
    BlurHash: image.BlurHash ?? null,
  };
}

async function linkRows(handle) {
  if (handle == null) return null;
  if (handle === EMPTY_NATIVE_LINKS) return [];
  const rows = [];
  for await (const page of handle.store.pages(handle)) rows.push(...page);
  return rows;
}

async function assignFixtureLink(item, link, linkedChildren) {
  const handle = await linkedChildren.withSession(async session => {
    const writer = await linkedChildren.createWriter({ session, parentId: item.Id });
    try { await writer.append(link); return await writer.finish(); }
    catch (error) { await writer.abort(); throw error; }
  });
  publishNativeItemLinks(item, handle);
}

export async function projectItem(item, root) {
  const type = shortName(item);
  const folder = folderObjects.has(type);
  const video = videoTypes.has(type);
  const audio = audioObjects.has(type);
  const series = type === 'Series';
  const episode = type === 'Episode';
  const hasSeries = hasSeriesTypes.has(type);
  const links = folder ? await linkRows(item.LinkedChildren) : null;
  const images = item.ImageInfos == null ? null : item.ImageInfos.map(value => projectedImage(value, root));
  const remoteTrailers = item.RemoteTrailers == null ? null : item.RemoteTrailers.map(value => value == null ? null
    : { Url: value.Url ?? null, Name: value.Name ?? null });
  return {
    type: item.NativeType,
    id: guid(item.Id ?? EMPTY_ID),
    parentId: guid(item.ParentId ?? EMPTY_ID),
    ownerId: guid(item.OwnerId ?? EMPTY_ID),
    channelId: guid(item.ChannelId ?? EMPTY_ID),
    displayParentId: guid(item.BaseDisplayParentId ?? item.ParentId ?? EMPTY_ID),
    Name: item.Name ?? null,
    path: normalizePath(item.Path ?? null, root),
    IsFolder: Boolean(item.IsFolder),
    IsHidden: Boolean(item.IsHidden),
    IsDisplayedAsFolder: Boolean(item.IsDisplayedAsFolder),
    mediaType: String(item.MediaType),
    sourceType: String(item.SourceType),
    IsHD: Boolean(item.IsHD),
    unratedType: String(item.UnratedType),
    collectionType: collectionTypes.has(type) ? item.CollectionType ?? null : null,
    Container: item.Container ?? null,
    IsShortcut: Boolean(item.IsShortcut),
    shortcutPath: normalizePath(item.ShortcutPath ?? null, root),
    IsInMixedFolder: Boolean(item.IsInMixedFolder),
    IsLocked: Boolean(item.IsLocked),
    IsVirtualItem: Boolean(item.IsVirtualItem),
    ProductionYear: item.ProductionYear ?? null,
    Size: integer(item.Size ?? null),
    RunTimeTicks: integer(item.RunTimeTicks ?? null),
    Width: item.Width ?? 0,
    Height: item.Height ?? 0,
    CommunityRating: item.CommunityRating ?? null,
    CriticRating: item.CriticRating ?? null,
    Overview: item.Overview ?? null,
    OfficialRating: item.OfficialRating ?? null,
    CustomRating: item.CustomRating ?? null,
    OriginalTitle: item.OriginalTitle ?? null,
    OriginalLanguage: item.OriginalLanguage ?? null,
    Tagline: item.Tagline ?? null,
    dates: {
      created: dateText(item.DateCreated ?? MIN_DATE),
      modified: dateText(item.DateModified ?? MIN_DATE),
      saved: dateText(item.DateLastSaved ?? MIN_DATE),
      refreshed: nullableDate(item.DateLastRefreshed),
      premiere: nullableDate(item.PremiereDate),
      end: nullableDate(item.EndDate),
    },
    lists: {
      Genres: clone(item.Genres),
      Studios: clone(item.Studios),
      Tags: clone(item.Tags),
      ProductionLocations: clone(item.ProductionLocations),
      artists: artistTypes.has(type) ? clone(item.Artists) : null,
      albumArtists: albumArtistTypes.has(type) ? clone(item.AlbumArtists) : null,
      remoteTrailers,
    },
    providerIds: item.ProviderIds == null ? null : Object.fromEntries(Object.entries(item.ProviderIds)
      .sort(([left], [right]) => ordinal(left.toLowerCase(), right.toLowerCase()))),
    lockedFields: item.LockedFields == null ? null : item.LockedFields.map(value => enumName(value, metadataFields)),
    images,
    userData: item.UserData == null ? null : item.UserData.map(value => ({
      itemId: guid(value.ItemId), userId: guid(value.UserId), CustomDataKey: value.CustomDataKey,
      Rating: value.Rating ?? null, PlaybackPositionTicks: integer(value.PlaybackPositionTicks), PlayCount: value.PlayCount,
      IsFavorite: value.IsFavorite, lastPlayedDate: nullableDate(value.LastPlayedDate), Played: value.Played,
      AudioStreamIndex: value.AudioStreamIndex ?? null, SubtitleStreamIndex: value.SubtitleStreamIndex ?? null,
      Likes: value.Likes ?? null, retentionDate: nullableDate(value.RetentionDate),
    })),
    folder: !folder ? null : {
      IsRoot: Boolean(item.IsRoot),
      dateLastMediaAdded: nullableDate(item.DateLastMediaAdded),
      LinkedChildrenLoaded: Boolean(item.LinkedChildrenLoaded),
      linkedChildren: links == null ? null : links.map(value => ({
        itemId: value.ItemId == null ? null : guid(value.ItemId),
        path: normalizePath(value.Path ?? null, root), type: enumName(value.Type, linkedChildTypes),
        libraryItemId: value.LibraryItemId ?? null,
      })),
    },
    aggregateFolder: type !== 'AggregateFolder' ? null : {
      physicalLocationsList: item.PhysicalLocationsList == null ? null : item.PhysicalLocationsList.map(value => normalizePath(value, root)),
      virtualChildCount: item.VirtualChildren?.length ?? 0,
    },
    collectionFolder: type !== 'CollectionFolder' ? null : {
      physicalLocationsList: item.PhysicalLocationsList == null ? null : item.PhysicalLocationsList.map(value => normalizePath(value, root)),
      physicalFolderIds: item.PhysicalFolderIds == null ? null : item.PhysicalFolderIds.map(guid),
      collectionType: item.CollectionType ?? null,
    },
    userView: type !== 'UserView' ? null : {
      viewType: item.ViewType ?? null, displayParentId: guid(item.DisplayParentId ?? EMPTY_ID),
      userId: item.UserId == null ? null : guid(item.UserId),
    },
    playlist: type !== 'Playlist' ? null : {
      ownerUserId: guid(item.OwnerUserId ?? EMPTY_ID), OpenAccess: Boolean(item.OpenAccess),
      playlistMediaType: item.PlaylistMediaType,
      shares: item.Shares == null ? null : item.Shares.map(value => ({ userId: guid(value.UserId), CanEdit: value.CanEdit })),
    },
    boxSet: type !== 'BoxSet' ? null : {
      DisplayOrder: item.DisplayOrder ?? null,
      libraryFolderIds: item.LibraryFolderIds == null ? null : item.LibraryFolderIds.map(guid),
    },
    video: !video ? null : {
      primaryVersionId: item.PrimaryVersionId == null ? null : guid(item.PrimaryVersionId),
      additionalParts: item.AdditionalParts == null ? null : item.AdditionalParts.map(value => normalizePath(value, root)),
      localAlternateVersions: item.LocalAlternateVersions == null ? null : item.LocalAlternateVersions.map(value => normalizePath(value, root)),
      linkedAlternateVersions: item.LinkedAlternateVersions == null ? null : item.LinkedAlternateVersions.map(value => ({
        itemId: value.ItemId == null ? null : guid(value.ItemId), path: normalizePath(value.Path ?? null, root),
        type: enumName(value.Type, linkedChildTypes), libraryItemId: value.LibraryItemId ?? null,
      })),
      subtitleFiles: item.SubtitleFiles == null ? null : item.SubtitleFiles.map(value => normalizePath(value, root)),
      audioFiles: item.AudioFiles == null ? null : item.AudioFiles.map(value => normalizePath(value, root)),
      videoType: item.VideoType, timestamp: item.Timestamp ?? null,
      DefaultVideoStreamIndex: item.DefaultVideoStreamIndex ?? null, isoType: item.IsoType ?? null,
      video3DFormat: item.Video3DFormat ?? null, AspectRatio: item.AspectRatio ?? null,
      IsPlaceHolder: Boolean(item.IsPlaceHolder), HasSubtitles: Boolean(item.HasSubtitles),
    },
    movie: type !== 'Movie' ? null : { TmdbCollectionName: item.TmdbCollectionName ?? null },
    trailerTypes: type !== 'Trailer' ? null : item.TrailerTypes == null ? null
      : item.TrailerTypes.map(value => enumName(value, trailerTypes)),
    series: !series ? null : {
      airDays: item.AirDays == null ? null : item.AirDays.map(String), AirTime: item.AirTime ?? null,
      DisplayOrder: item.DisplayOrder ?? null, status: item.Status ?? null,
    },
    seriesLink: !hasSeries ? null : {
      seriesId: guid(item.SeriesId ?? EMPTY_ID), SeriesName: item.SeriesName ?? null,
      SeriesPresentationUniqueKey: item.SeriesPresentationUniqueKey ?? null,
      seasonId: episode ? guid(item.SeasonId ?? EMPTY_ID) : null,
      seasonName: episode ? item.SeasonName ?? null : null,
      episode: !episode ? null : {
        AirsBeforeSeasonNumber: item.AirsBeforeSeasonNumber ?? null,
        AirsAfterSeasonNumber: item.AirsAfterSeasonNumber ?? null,
        AirsBeforeEpisodeNumber: item.AirsBeforeEpisodeNumber ?? null,
        IndexNumberEnd: item.IndexNumberEnd ?? null,
        AiredSeasonNumber: item.AiredSeasonNumber ?? null,
      },
    },
    audio: !audio ? null : {
      Album: item.Album ?? null, HasLyrics: item.HasLyrics ?? null,
      lyricFiles: item.LyricFiles == null ? null : item.LyricFiles.map(value => normalizePath(value, root)),
    },
    photo: type !== 'Photo' ? null : {
      CameraMake: item.CameraMake ?? null, CameraModel: item.CameraModel ?? null, Software: item.Software ?? null,
      ExposureTime: item.ExposureTime ?? null, FocalLength: item.FocalLength ?? null, orientation: item.Orientation ?? null,
      Aperture: item.Aperture ?? null, ShutterSpeed: item.ShutterSpeed ?? null, Latitude: item.Latitude ?? null,
      Longitude: item.Longitude ?? null, Altitude: item.Altitude ?? null, IsoSpeedRating: item.IsoSpeedRating ?? null,
    },
    musicArtist: type !== 'MusicArtist' ? null : {
      IsAccessedByName: Boolean(item.IsAccessedByName), IsFolder: Boolean(item.IsFolder),
    },
  };
}

export function serializeTyped(item, root, { requireSuccess = false } = {}) {
  try {
    const text = serializeNativeItemData(item, { allTypes: true });
    return { success: true, text: normalizeDataText(text, root), parsed: rewrite(parseLosslessJson(text), root),
      errorType: null, errorMessage: null };
  } catch (error) {
    if (requireSuccess) throw error;
    return { success: false, text: null, parsed: null, errorType: error.constructor?.name ?? 'Error', errorMessage: error.message };
  }
}

const computedSnapshot = item => ({
  Height: item.Height ?? 0, IsHD: Boolean(item.IsHD), channelId: guid(item.ChannelId ?? EMPTY_ID),
  sourceType: String(item.SourceType), mediaType: String(item.MediaType), unratedType: String(item.UnratedType),
  IsFolder: Boolean(item.IsFolder), IsHidden: Boolean(item.IsHidden), IsDisplayedAsFolder: Boolean(item.IsDisplayedAsFolder),
});

export function projectComputedTraits(fullName, index) {
  const fresh = newNativeItemEntity(fullName), heightItem = newNativeItemEntity(fullName), channelItem = newNativeItemEntity(fullName);
  const constructor = computedSnapshot(fresh);
  heightItem.Height = 719; const height719 = computedSnapshot(heightItem);
  heightItem.Height = 720; const height720 = computedSnapshot(heightItem);
  channelItem.ChannelId = EMPTY_ID; const emptyChannel = computedSnapshot(channelItem);
  channelItem.ChannelId = caseGuid('955', index, 1); const nonemptyChannel = computedSnapshot(channelItem);
  return { constructor, height719, height720, emptyChannel, nonemptyChannel };
}

export async function projectMutableIsolation(first, second) {
  const names = ['Genres', 'Studios', 'Tags', 'ProductionLocations', 'ProviderIds', 'LockedFields', 'ImageInfos', 'RemoteTrailers',
    'UserData', 'LinkedChildren', 'PhysicalLocationsList', 'PhysicalFolderIds', 'Shares', 'LibraryFolderIds', 'AdditionalParts',
    'LocalAlternateVersions', 'LinkedAlternateVersions', 'SubtitleFiles', 'AudioFiles', 'TrailerTypes', 'AirDays', 'Artists',
    'AlbumArtists', 'LyricFiles'];
  const facts = {};
  for (const name of names) {
    if (!(name in first)) continue;
    try {
      const left = first[name], right = second[name];
      if (name === 'LinkedChildren') {
        const leftCount = left == null ? null : left === EMPTY_NATIVE_LINKS ? 0 : Number(await left.store.count(left));
        const rightCount = right == null ? null : right === EMPTY_NATIVE_LINKS ? 0 : Number(await right.store.count(right));
        facts[name] = { leftNull: left == null, rightNull: right == null, sameReference: left != null && left === right,
          leftCount, rightCount, errorType: null, errorMessage: null };
        continue;
      }
      facts[name] = { leftNull: left == null, rightNull: right == null, sameReference: left != null && left === right,
        leftCount: left == null ? null : Array.isArray(left) ? left.length : left instanceof Map || left instanceof Set ? left.size
          : typeof left === 'object' ? Object.keys(left).length : null,
        rightCount: right == null ? null : Array.isArray(right) ? right.length : right instanceof Map || right instanceof Set ? right.size
          : typeof right === 'object' ? Object.keys(right).length : null,
        errorType: null, errorMessage: null };
    } catch (error) {
      facts[name] = { leftNull: false, rightNull: false, sameReference: false, leftCount: null, rightCount: null,
        errorType: error.constructor?.name ?? 'Error', errorMessage: error.message };
    }
  }
  return Object.fromEntries(Object.entries(facts).sort(([left], [right]) => ordinal(left, right)));
}

export async function projectConstructor(definition, index, root) {
  const item = newNativeItemEntity(definition.fullName), twin = newNativeItemEntity(definition.fullName);
  return {
    item: await projectItem(item, root),
    typedJson: serializeTyped(item, root),
    mutableIsolation: await projectMutableIsolation(item, twin),
    computedTraits: projectComputedTraits(definition.fullName, index),
  };
}

function controlItems(index, root, { save = false } = {}) {
  const prefix = save ? value => saveGuid(index, value) : value => caseGuid('951', index, value);
  const rootA = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  Object.assign(rootA, { Id: prefix(save ? 10 : 1), Name: save ? 'Save root A' : 'DB root',
    Path: path.win32.join(root, save ? 'library-a' : 'library') });
  if (!save) {
    const seriesA = newNativeItemEntity('MediaBrowser.Controller.Entities.TV.Series');
    Object.assign(seriesA, { Id: prefix(2), ParentId: rootA.Id, Name: 'DB series', Path: path.win32.join(rootA.Path, 'series') });
    const seasonA = newNativeItemEntity('MediaBrowser.Controller.Entities.TV.Season');
    Object.assign(seasonA, { Id: prefix(3), ParentId: seriesA.Id, SeriesId: seriesA.Id, SeriesName: seriesA.Name,
      Name: 'DB season', Path: path.win32.join(seriesA.Path, 'season') });
    const linkedA = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
    Object.assign(linkedA, { Id: prefix(4), ParentId: rootA.Id, Name: 'DB linked child', Path: path.win32.join(rootA.Path, 'linked') });
    return { rootParent: rootA, seriesParent: seriesA, seasonParent: seasonA, linkedChild: linkedA,
      items: [rootA, seriesA, seasonA, linkedA] };
  }
  const make = (fullName, value, parent, name, leaf) => {
    const item = newNativeItemEntity(fullName);
    Object.assign(item, { Id: prefix(value), ParentId: parent?.Id ?? EMPTY_ID, Name: name,
      Path: parent ? path.win32.join(parent.Path, leaf) : path.win32.join(root, leaf) });
    return item;
  };
  const rootB = make('MediaBrowser.Controller.Entities.Folder', 11, null, 'Save root B', 'library-b');
  const seriesA = make('MediaBrowser.Controller.Entities.TV.Series', 12, rootA, 'Save series A', 'series-a');
  const seriesB = make('MediaBrowser.Controller.Entities.TV.Series', 13, rootB, 'Save series B', 'series-b');
  const seasonA = make('MediaBrowser.Controller.Entities.TV.Season', 14, seriesA, 'Save season A', 'season-a');
  Object.assign(seasonA, { SeriesId: seriesA.Id, SeriesName: seriesA.Name, SeriesPresentationUniqueKey: 'save-series-a' });
  const seasonB = make('MediaBrowser.Controller.Entities.TV.Season', 15, seriesB, 'Save season B', 'season-b');
  Object.assign(seasonB, { SeriesId: seriesB.Id, SeriesName: seriesB.Name, SeriesPresentationUniqueKey: 'save-series-b' });
  const artistA = make('MediaBrowser.Controller.Entities.Audio.MusicArtist', 16, rootA, 'Save artist A', 'artist-a');
  const artistB = make('MediaBrowser.Controller.Entities.Audio.MusicArtist', 17, rootB, 'Save artist B', 'artist-b');
  const albumA = make('MediaBrowser.Controller.Entities.Audio.MusicAlbum', 18, artistA, 'Save album A', 'album-a');
  const albumB = make('MediaBrowser.Controller.Entities.Audio.MusicAlbum', 19, artistB, 'Save album B', 'album-b');
  const folderChildA = make('MediaBrowser.Controller.Entities.Folder', 20, rootA, 'Save folder child A', 'child-a');
  const folderChildB = make('MediaBrowser.Controller.Entities.Folder', 21, rootB, 'Save folder child B', 'child-b');
  const localA = make('MediaBrowser.Controller.Entities.Video', 22, rootA, 'Save local A', '..\\..\\local-a.media');
  localA.Path = path.win32.join(root, 'local-a.media');
  const localB = make('MediaBrowser.Controller.Entities.Video', 23, rootB, 'Save local B', '..\\..\\local-b.media');
  localB.Path = path.win32.join(root, 'local-b.media');
  const linkedA = make('MediaBrowser.Controller.Entities.Video', 24, rootA, 'Save linked A', '..\\..\\linked-a.media');
  linkedA.Path = path.win32.join(root, 'linked-a.media');
  const linkedB = make('MediaBrowser.Controller.Entities.Video', 25, rootB, 'Save linked B', '..\\..\\linked-b.media');
  linkedB.Path = path.win32.join(root, 'linked-b.media');
  const items = [rootA, rootB, seriesA, seriesB, seasonA, seasonB, artistA, artistB, albumA, albumB,
    folderChildA, folderChildB, localA, localB, linkedA, linkedB];
  return { rootA, rootB, seriesA, seriesB, seasonA, seasonB, artistA, artistB, albumA, albumB,
    folderChildA, folderChildB, localA, localB, linkedA, linkedB, items,
    lookup: new Map(items.map(item => [idKey(item.Id), item])) };
}

export async function applyJsonPoison(item, index, root, controls, linkedChildren) {
  const type = shortName(item);
  Object.assign(item, {
    Id: caseGuid('952', index, 1), ParentId: controls.rootParent.Id, Name: 'JSON poison name',
    Path: path.win32.join(root, 'json-poison', type), DateCreated: utc(2025, 1, 2, 3, 4, 5, index),
    DateModified: utc(2025, 2, 3, 4, 5, 6, index), DateLastSaved: utc(2025, 3, 4, 5, 6, 7, index),
    DateLastRefreshed: utc(2025, 4, 5, 6, 7, 8, index), Genres: ['JSON poison genre'],
    Studios: ['JSON poison studio'], Tags: ['JSON poison tag'], ProductionLocations: ['JSON poison location'],
    LockedFields: ['Overview'], RemoteTrailers: [{ Url: 'https://poison.invalid/json', Name: 'JSON poison trailer' }],
    ImageInfos: [{ Path: path.win32.join(root, 'json-poison.jpg'), Type: 'Backdrop',
      DateModified: utc(2025, 5, 6, 7, 8, 9, index), Width: 13, Height: 17, BlurHash: 'json-poison-blur' }],
    ProductionYear: 1999, Size: 999, Container: 'json-poison-container', IsShortcut: true,
    ShortcutPath: path.win32.join(root, 'json-poison-shortcut'), RunTimeTicks: 9999, Width: 111, Height: 222,
    IsLocked: false, PresentationUniqueKey: 'json-poison-key',
  });
  item.ProviderIds.JsonPoison = 'must-be-overlaid';
  if (folderObjects.has(type)) {
    item.IsRoot = false; item.DateLastMediaAdded = utc(2025, 6, 7, 8, 9, 10, index);
    await assignFixtureLink(item, { ItemId: controls.linkedChild.Id, Type: 'Shortcut', Path: null, LibraryItemId: null }, linkedChildren);
  }
  if (type === 'AggregateFolder') item.PhysicalLocationsList = [path.win32.join(root, 'json-aggregate')];
  if (type === 'CollectionFolder') Object.assign(item, { CollectionType: 'movies',
    PhysicalLocationsList: [path.win32.join(root, 'json-collection')], PhysicalFolderIds: [controls.rootParent.Id] });
  if (type === 'UserView') Object.assign(item, { ViewType: 'tvshows', DisplayParentId: controls.linkedChild.Id,
    UserId: '95200000-0000-0000-0000-000000000010' });
  if (type === 'Playlist') Object.assign(item, { OwnerUserId: '95200000-0000-0000-0000-000000000011', OpenAccess: true,
    Shares: [{ UserId: '95200000-0000-0000-0000-000000000012', CanEdit: true }], PlaylistMediaType: 'Audio' });
  if (videoTypes.has(type)) Object.assign(item, {
    AdditionalParts: [path.win32.join(root, 'json-part.media')], LocalAlternateVersions: [path.win32.join(root, 'json-alternate.media')],
    LinkedAlternateVersions: [{ ItemId: controls.linkedChild.Id, Type: 'LinkedAlternateVersion', Path: null, LibraryItemId: null }],
    SubtitleFiles: [path.win32.join(root, 'json.srt')], AudioFiles: [path.win32.join(root, 'json.mka')],
    VideoType: 'Iso', Timestamp: 'Zero', DefaultVideoStreamIndex: 4, IsoType: 'Dvd', Video3DFormat: 'HalfSideBySide',
    AspectRatio: '4:3', IsPlaceHolder: true, HasSubtitles: true, PrimaryVersionId: controls.linkedChild.Id,
  });
  if (type === 'Trailer') item.TrailerTypes = ['Archive'];
  if (type === 'Movie') item.TmdbCollectionName = 'JSON poison collection';
  if (type === 'Series') Object.assign(item, { AirDays: ['Sunday'], AirTime: '01:23', DisplayOrder: 'JsonPoisonOrder', Status: 'Unreleased' });
  if (type === 'BoxSet') Object.assign(item, { DisplayOrder: 'JsonPoisonOrder', LibraryFolderIds: [controls.rootParent.Id] });
  if (type === 'Episode') Object.assign(item, { AirsBeforeSeasonNumber: 90, AirsAfterSeasonNumber: 91,
    AirsBeforeEpisodeNumber: 92, IndexNumberEnd: 93, SeriesId: controls.seriesParent.Id, SeriesName: 'JSON poison series',
    SeriesPresentationUniqueKey: 'json-poison-series-key', SeasonId: controls.seasonParent.Id, SeasonName: 'JSON poison season' });
  if (audioObjects.has(type)) Object.assign(item, { Artists: ['JSON poison artist'], AlbumArtists: ['JSON poison album artist'],
    LyricFiles: [path.win32.join(root, 'json.lrc')], HasLyrics: true });
  if (type === 'MusicVideo') item.Artists = ['JSON poison artist'];
  if (type === 'MusicAlbum') Object.assign(item, { Artists: ['JSON poison artist'], AlbumArtists: ['JSON poison album artist'] });
  if (type === 'Photo') Object.assign(item, { CameraMake: 'JSON camera make', CameraModel: 'JSON camera model',
    Software: 'JSON software', ExposureTime: 1.25, FocalLength: 55.5, Orientation: 'RightTop', Aperture: 2.8,
    ShutterSpeed: 0.125, Latitude: 23.5, Longitude: 121.5, Altitude: 12.5, IsoSpeedRating: 640 });
  return item;
}

export async function applyDatabaseOverlay(item, index, root, id, controls, linkedChildren) {
  const type = shortName(item);
  const mediaLeaf = videoTypes.has(type) || audioObjects.has(type) || ['Photo', 'Book'].includes(type) ? `${type}.media` : type;
  Object.assign(item, {
    Id: id, ParentId: controls.rootParent.Id, Name: `DB overlay ${type}`, Path: path.win32.join(root, 'db-overlay', mediaLeaf),
    DateCreated: utc(2026, 1, 2, 3, 4, 5, index), DateModified: utc(2026, 2, 3, 4, 5, 6, index),
    DateLastSaved: utc(2026, 3, 4, 5, 6, 7, index), DateLastRefreshed: utc(2026, 4, 5, 6, 7, 8, index),
    EndDate: utc(2027, 1, 2, 3, 4, 5, index), PremiereDate: utc(2024, 1, 2, 3, 4, 5, index),
    CommunityRating: 7.25, CriticRating: 82.5, CustomRating: 'DB-CUSTOM', OfficialRating: 'DB-PG',
    Overview: 'DB overlay overview', OriginalTitle: 'DB overlay original title', OriginalLanguage: 'zho',
    Tagline: 'DB overlay tagline', IndexNumber: 8, ParentIndexNumber: 4, ProductionYear: 2026,
    RunTimeTicks: 1234567890123, Size: 987654321, Container: 'db-overlay-container', IsShortcut: true,
    ShortcutPath: path.win32.join(root, 'db-overlay-shortcut'), Width: 3840, Height: 2160,
    ChannelId: caseGuid('954', index, 1), IsLocked: true, IsInMixedFolder: true, IsVirtualItem: true,
    PreferredMetadataLanguage: 'zh-TW', PreferredMetadataCountryCode: 'TW', PresentationUniqueKey: 'db-overlay-key',
    Genres: ['DB genre one', 'DB genre two'], Studios: ['DB studio'], Tags: ['DB tag'], ProductionLocations: ['DB location'],
    LockedFields: ['Name', 'Genres'], RemoteTrailers: [{ Url: 'https://db.invalid/trailer', Name: 'DB trailer' }],
    ImageInfos: [{ Path: path.win32.join(root, 'db-overlay-primary.jpg'), Type: 'Primary',
      DateModified: utc(2026, 5, 6, 7, 8, 9, index), Width: 640, Height: 360, BlurHash: 'db-overlay-blur' }],
  });
  item.ProviderIds.DbOverlay = 'authoritative';
  if (folderObjects.has(type)) {
    item.IsRoot = true; item.DateLastMediaAdded = utc(2026, 6, 7, 8, 9, 10, index);
    await assignFixtureLink(item, { ItemId: controls.linkedChild.Id, Type: 'Shortcut', Path: null, LibraryItemId: null }, linkedChildren);
  }
  if (type === 'AggregateFolder') item.PhysicalLocationsList = [path.win32.join(root, 'db-aggregate')];
  if (type === 'CollectionFolder') Object.assign(item, { CollectionType: 'music',
    PhysicalLocationsList: [path.win32.join(root, 'db-collection')],
    PhysicalFolderIds: [controls.rootParent.Id] });
  if (type === 'UserView') Object.assign(item, { ViewType: 'movies', DisplayParentId: controls.linkedChild.Id,
    UserId: '95300000-0000-0000-0000-000000000010' });
  if (type === 'Playlist') Object.assign(item, { OwnerUserId: '95300000-0000-0000-0000-000000000011', OpenAccess: false,
    Shares: [{ UserId: '95300000-0000-0000-0000-000000000012', CanEdit: false }], PlaylistMediaType: 'Video' });
  if (videoTypes.has(type)) Object.assign(item, {
    AdditionalParts: [path.win32.join(root, 'db-part.media')], LocalAlternateVersions: [path.win32.join(root, 'db-alternate.media')],
    LinkedAlternateVersions: [{ ItemId: controls.linkedChild.Id, Type: 'LinkedAlternateVersion', Path: null, LibraryItemId: null }],
    SubtitleFiles: [path.win32.join(root, 'db.srt')], AudioFiles: [path.win32.join(root, 'db.mka')],
    VideoType: 'VideoFile', Timestamp: 'Valid', DefaultVideoStreamIndex: 7, IsoType: 'BluRay', Video3DFormat: 'MVC',
    AspectRatio: '16:9', IsPlaceHolder: false, HasSubtitles: true, PrimaryVersionId: controls.linkedChild.Id,
  });
  if (type === 'Trailer') item.TrailerTypes = ['LocalTrailer', 'Archive'];
  if (type === 'Movie') item.TmdbCollectionName = 'DB overlay collection';
  if (type === 'Series') Object.assign(item, { AirDays: ['Monday', 'Wednesday'], AirTime: '20:15',
    DisplayOrder: 'DbOverlayOrder', Status: 'Ended' });
  if (type === 'BoxSet') Object.assign(item, { DisplayOrder: 'DbOverlayOrder',
    LibraryFolderIds: [controls.rootParent.Id, controls.linkedChild.Id] });
  if (type === 'Season') Object.assign(item, { SeriesId: controls.seriesParent.Id, SeriesName: controls.seriesParent.Name,
    SeriesPresentationUniqueKey: 'db-series-key' });
  if (type === 'Episode') Object.assign(item, { AirsBeforeSeasonNumber: 10, AirsAfterSeasonNumber: 11,
    AirsBeforeEpisodeNumber: 12, IndexNumberEnd: 13, SeriesId: controls.seriesParent.Id,
    SeriesName: controls.seriesParent.Name, SeriesPresentationUniqueKey: 'db-series-key',
    SeasonId: controls.seasonParent.Id, SeasonName: controls.seasonParent.Name });
  if (['AudioBook', 'Book'].includes(type)) Object.assign(item, { SeriesId: controls.seriesParent.Id,
    SeriesName: controls.seriesParent.Name, SeriesPresentationUniqueKey: 'db-series-key' });
  if (audioObjects.has(type)) Object.assign(item, { Artists: ['DB artist'], AlbumArtists: ['DB album artist'],
    Album: 'DB album', LyricFiles: [path.win32.join(root, 'db.lrc')], HasLyrics: false });
  if (type === 'MusicVideo') item.Artists = ['DB music video artist'];
  if (type === 'MusicAlbum') Object.assign(item, { Artists: ['DB album artist member'], AlbumArtists: ['DB primary album artist'] });
  if (type === 'Photo') Object.assign(item, { CameraMake: 'DB camera make', CameraModel: 'DB camera model',
    Software: 'DB software', ExposureTime: 2.5, FocalLength: 35, Orientation: 'LeftBottom', Aperture: 4,
    ShutterSpeed: 0.25, Latitude: 25, Longitude: 121, Altitude: 30, IsoSpeedRating: 800 });
  return item;
}

const emptyRow = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));

async function seedItems(database, items) {
  for (const item of items) await database.insert('BaseItems', mapNativeItemRow(item));
}

export async function setupTypedFixture(t, dialect, caseName) {
  const ownedItems = new Set();
  let fixture;
  t.after(async () => {
    for (const item of ownedItems) releaseNativeItemLinks(item);
    await fixture?.linkedChildren.flushReleases();
  });
  fixture = await setupChildrenFixture(t, dialect);
  fixture.ownTypedItem = item => { if (item) ownedItems.add(item); return item; };
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  // These inputs exercise Windows identity spelling through the memory VFS;
  // they are not physical files beneath the host's temporary state directory.
  const root = path.win32.join('Z:\\NativeItemFull27Typed', caseName);
  fixture.identityMap.addPrefix({ identityRoot: root, accessRoot: `/fixture/native-item-full27-typed/${caseName}`,
    style: 'windows', returnAccess: 'full27 typed native differential controls' });
  return { fixture, root };
}

function projectColumn(column, value, root) {
  if (value == null) return null;
  if (column.name === 'Data') return projectJsonText(value, root);
  if (column.name === 'Audio') return programAudioTypes[Number(value)] ?? value;
  if (column.name === 'ExtraType') return extraTypes[Number(value)] ?? value;
  if (column.clrType.includes('Guid')) return guid(value);
  if (column.clrType.includes('DateTime')) return dateText(value);
  if (typeof value === 'string') return normalizePath(value, root);
  return integer(value);
}

export function projectColumns(row, root) {
  return Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name, projectColumn(column, row[column.name], root)]));
}

function blurHashText(value) {
  if (value == null || typeof value === 'string') return value;
  return Buffer.from(value).toString('utf8');
}

export async function projectRelations(database, itemId, root, { save = false } = {}) {
  const providers = (await database.rows('BaseItemProviders', { where: { ItemId: itemId } })).map(value => ({
    itemId: guid(value.ItemId), ProviderId: value.ProviderId, ProviderValue: value.ProviderValue,
  })).sort((left, right) => ordinal(left.ProviderId, right.ProviderId) || ordinal(left.ProviderValue, right.ProviderValue));
  const lockedFields = (await database.rows('BaseItemMetadataFields', { where: { ItemId: itemId } })).map(value => ({
    itemId: guid(value.ItemId), Id: Number(value.Id),
  })).sort((left, right) => left.Id - right.Id);
  const storedTrailerTypes = (await database.rows('BaseItemTrailerTypes', { where: { ItemId: itemId } })).map(value => ({
    itemId: guid(value.ItemId), Id: Number(value.Id),
  })).sort((left, right) => left.Id - right.Id);
  const images = (await readItemImageRows(database, itemId)).map(value => ({
    itemId: guid(value.ItemId), id: guid(value.Id), path: normalizePath(value.Path, root),
    dateModified: nullableDate(value.DateModified), imageType: imageTypes[Number(value.ImageType)] ?? String(value.ImageType),
    Width: Number(value.Width), Height: Number(value.Height), blurHash: blurHashText(value.Blurhash),
  })).sort((left, right) => ordinal(left.imageType, right.imageType) || ordinal(left.path, right.path) || ordinal(left.id, right.id));
  const links = (await database.rows('LinkedChildren')).filter(value => idKey(value.ParentId) === idKey(itemId)
    || idKey(value.ChildId) === idKey(itemId)).map(value => ({
    parentId: guid(value.ParentId), childId: guid(value.ChildId), childType: enumName(Number(value.ChildType), linkedChildTypes),
    SortOrder: Number(value.SortOrder),
  })).sort((left, right) => ordinal(left.parentId, right.parentId) || left.SortOrder - right.SortOrder || ordinal(left.childId, right.childId));
  const userData = (await database.rows('UserData', { where: { ItemId: itemId } })).map(value => ({
    itemId: guid(value.ItemId), userId: guid(value.UserId), CustomDataKey: value.CustomDataKey,
    Rating: value.Rating ?? null, PlaybackPositionTicks: integer(value.PlaybackPositionTicks), PlayCount: Number(value.PlayCount),
    IsFavorite: Boolean(value.IsFavorite), lastPlayedDate: nullableDate(value.LastPlayedDate), Played: Boolean(value.Played),
    AudioStreamIndex: value.AudioStreamIndex ?? null, SubtitleStreamIndex: value.SubtitleStreamIndex ?? null,
    Likes: value.Likes == null ? null : Boolean(value.Likes), retentionDate: nullableDate(value.RetentionDate),
  })).sort((left, right) => ordinal(left.userId, right.userId) || ordinal(left.CustomDataKey, right.CustomDataKey));
  const ancestors = (await database.rows('AncestorIds', { where: { ItemId: itemId } })).map(value => ({
    itemId: guid(value.ItemId), parentItemId: guid(value.ParentItemId),
  })).sort((left, right) => ordinal(left.parentItemId, right.parentItemId));
  const valueEntities = (await database.rows('ItemValues')).sort((left, right) => Number(left.Type) - Number(right.Type)
    || ordinal(left.Value, right.Value) || ordinal(left.CleanValue, right.CleanValue) || ordinal(idKey(left.ItemValueId), idKey(right.ItemValueId)));
  const semanticKeys = new Map(valueEntities.map(value => [idKey(value.ItemValueId), `$VALUE/${Number(value.Type)}/${value.Value}`]));
  const values = valueEntities.map(value => save ? {
    id: guid(value.ItemValueId), semanticKey: semanticKeys.get(idKey(value.ItemValueId)),
    type: itemValueTypes[Number(value.Type)] ?? String(value.Type), typeValue: Number(value.Type),
    Value: value.Value, CleanValue: value.CleanValue,
  } : {
    id: guid(value.ItemValueId), type: itemValueTypes[Number(value.Type)] ?? String(value.Type),
    Value: value.Value, CleanValue: value.CleanValue,
  });
  const maps = (await database.rows('ItemValuesMap', { where: { ItemId: itemId } })).map(value => save ? {
    itemId: guid(value.ItemId), itemValueId: guid(value.ItemValueId), semanticKey: semanticKeys.get(idKey(value.ItemValueId)) ?? null,
  } : { itemId: guid(value.ItemId), itemValueId: guid(value.ItemValueId) })
    .sort((left, right) => save ? ordinal(left.semanticKey, right.semanticKey) || ordinal(left.itemValueId, right.itemValueId)
      : ordinal(left.itemValueId, right.itemValueId));
  return { providers, lockedFields, trailerTypes: storedTrailerTypes, images, links, userData, ancestors, values, maps };
}

async function insertCoreRelations(database, item, index, controls) {
  for (const [ProviderId, ProviderValue] of Object.entries(item.ProviderIds ?? {})) {
    await database.insert('BaseItemProviders', { ItemId: item.Id, ProviderId, ProviderValue });
  }
  for (const field of item.LockedFields ?? []) await database.insert('BaseItemMetadataFields', {
    ItemId: item.Id, Id: typeof field === 'number' ? field : metadataFields.indexOf(field),
  });
  // The native setup performs one EF SaveChanges, which sorts new relation
  // commands by key. Individual INSERTs in input order model a different setup.
  if (shortName(item) === 'Trailer') for (const Id of (item.TrailerTypes ?? [])
    .map(type => typeof type === 'number' ? type : trailerTypes.indexOf(type)).sort((a, b) => a - b)) {
    await database.insert('BaseItemTrailerTypes', { ItemId: item.Id, Id });
  }
  const imageRows = (item.ImageInfos ?? []).map(image => ({
    Id: randomUUID(), ItemId: item.Id, ImageType: typeof image.Type === 'number' ? image.Type : imageTypes.indexOf(image.Type),
    Path: image.Path, DateModified: image.DateModified, Width: image.Width, Height: image.Height,
    Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash, 'utf8'),
  }));
  await database.insertBatch('BaseItemImageInfos', imageRows.sort((a, b) => ordinal(a.Id, b.Id)));
  const type = shortName(item);
  if (folderObjects.has(type) || videoTypes.has(type)) await database.insert('LinkedChildren', {
    ParentId: item.Id, ChildId: controls.linkedChild.Id, ChildType: videoTypes.has(type) ? 3 : 0, SortOrder: 7,
  });
  await database.insert('AncestorIds', { ItemId: item.Id, ParentItemId: controls.rootParent.Id });
  const valueId = caseGuid('951', index, 6);
  await database.insert('ItemValues', { ItemValueId: valueId, Type: 2, Value: 'DB relation genre', CleanValue: 'db relation genre' });
  await database.insert('ItemValuesMap', { ItemId: item.Id, ItemValueId: valueId });
  const userId = caseGuid('951', index, 5);
  await database.insert('Users', { ...emptyRow('Users'), Id: userId, Username: `typed-oracle-${index}`,
    NormalizedUsername: `TYPED-ORACLE-${index}`, AuthenticationProviderId: 'oracle-auth', PasswordResetProviderId: 'oracle-reset' });
  await database.insert('UserData', { ...emptyRow('UserData'), ItemId: item.Id, UserId: userId,
    CustomDataKey: 'typed-oracle-key', Rating: 8.5, PlaybackPositionTicks: 123456789, PlayCount: 3,
    IsFavorite: true, LastPlayedDate: utc(2026, 10, 7, 7, 8, 9, index), Played: true,
    AudioStreamIndex: 2, SubtitleStreamIndex: 4, Likes: false });
}

async function hydrationRelations(database, itemId, linkedChildren, nativeType) {
  return database.withConnection(async session => {
    let links;
    try {
      const providers = await session.rows('BaseItemProviders', { where: { ItemId: itemId } });
      const lockedFields = (await session.rows('BaseItemMetadataFields', { where: { ItemId: itemId } }))
        .map(value => metadataFields[Number(value.Id)] ?? Number(value.Id));
      const storedTrailerTypes = (await readItemTrailerRows(session, itemId))
        .map(value => trailerTypes[Number(value.Id)] ?? Number(value.Id));
      const images = (await readItemImageRows(session, itemId)).map(value => ({
        Path: value.Path, Type: imageTypes[Number(value.ImageType)] ?? Number(value.ImageType),
        DateModified: value.DateModified ?? MIN_DATE, Width: value.Width, Height: value.Height,
        BlurHash: blurHashText(value.Blurhash),
      }));
      const type = nativeType.split('.').at(-1), folder = folderObjects.has(type), video = videoTypes.has(type);
      links = folder ? await linkedChildren.load(session, itemId) : undefined;
      const videoLinks = video ? (await session.rows('LinkedChildren', { where: { ParentId: itemId },
        orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(value => ({ ItemId: value.ChildId, Type: Number(value.ChildType) })) : undefined;
      const userData = await session.rows('UserData', { where: { ItemId: itemId } });
      return { providers, lockedFields, trailerTypes: storedTrailerTypes, images, ...(folder ? { linkedChildren: links } : {}),
        ...(video ? { videoLinks } : {}), userData };
    } catch (error) {
      if (links) {
        try { await linkedChildren.release(links, { session }); }
        catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
      }
      throw error;
    }
  });
}

const diagnosticError = error => ({ name: error?.name, message: error?.message, code: error?.code,
  path: error?.path, status: error?.status, stack: error?.stack });

function hydrationPolicy(definition, kind, options) {
  if (options.storedTypeOverride) return { unknownType: true };
  if (options.explicitSkip || options.configuredSkip || !definition.requiresJson) return {};
  if (kind === 'malformed') return { code: 'syntax', path: '$' };
  return {
    'boundary-root-array': { code: 'root-type', path: '$' },
    'boundary-known-wrong-type': { code: 'property-type', path: '$.AdditionalParts' },
    'boundary-unknown-enum-string': { code: 'enum', path: '$.VideoType' },
  }[kind] ?? {};
}

function assertHydrationDiagnostics(logs, row, policy) {
  for (const log of logs) {
    if (log.level === 'Error') {
      assert.ok(policy.code, 'A successful or skipped JSON input must not report a parser error.');
      assert.equal(log.data, row.Data, 'The reported parser failure must belong to this exact stored input.');
      assert.equal(log.error?.code, policy.code, 'An unknown parser failure must not be hidden as a diagnostic.');
      assert.equal(log.error?.path, policy.path);
    } else {
      assert.equal(log.level, 'Warning');
      assert.equal(policy.unknownType, true, 'Known entity types must not report an unknown-type warning.');
      assert.ok(log.message.includes(row.Type) && log.message.toLowerCase().includes(guid(row.Id).toLowerCase()),
        'The warning must identify the actual unknown type and stored item.');
    }
  }
}

function hydrateRow(row, relations, { skip = false } = {}) {
  const logs = [];
  const stored = mapRecord(row, {
    skipDeserialization: skip,
    onJsonError: ({ data, error }) => logs.push({ level: 'Error', eventId: 0, eventName: null,
      message: `Error deserializing item with JSON: ${data}`, exceptionType: error.name, exceptionMessage: error.message,
      data, error: diagnosticError(error) }),
    onUnknownType: ({ fullName, itemId }) => logs.push({ level: 'Warning', eventId: 0, eventName: null,
      message: `Skipping item ${guid(itemId)} with unknown type '${fullName}'. This may indicate a removed plugin or database corruption.`,
      exceptionType: null, exceptionMessage: null }),
  });
  if (!stored) return { item: null, logs };
  for (const provider of relations.providers) stored.ProviderIds[provider.ProviderId] = provider.ProviderValue;
  return { item: hydrateNativeItemEntity(stored, relations), logs };
}

export async function runCoreCase(t, dialect, definition, index, kind, forcedData, options = {}) {
  const caseName = `${kind}-${definition.name}`;
  const { fixture, root } = await setupTypedFixture(t, dialect, caseName);
  const controls = controlItems(index, root);
  await seedItems(fixture.database, controls.items);
  const subjectId = caseGuid('950', index, kind === 'core' ? 1 : 2);
  const constructor = await projectConstructor(definition, index, root);
  let data, poisonItem, poisonTypedJson;
  if (options.forceNullData) {
    data = null; poisonItem = { intentionallyAbsent: true }; poisonTypedJson = { intentionallyAbsent: true };
  } else if (forcedData != null) {
    data = forcedData; poisonItem = { intentionallyAbsent: true }; poisonTypedJson = { intentionallyAbsent: true };
  } else if (definition.requiresJson) {
    const poison = fixture.ownTypedItem(newNativeItemEntity(definition.fullName));
    await applyJsonPoison(poison, index, root, controls, fixture.linkedChildren);
    poisonItem = await projectItem(poison, root); poisonTypedJson = serializeTyped(poison, root, { requireSuccess: true });
    data = serializeNativeItemData(poison);
  } else {
    data = '{"RemoteTrailers":[{"Url":"https://poison.invalid/source-only","Name":"source-only poison"}],"UnknownPoison":"must be ignored"}';
    poisonItem = { sourceOnlyPoison: true }; poisonTypedJson = projectJsonText(data, root);
  }
  const overlay = fixture.ownTypedItem(newNativeItemEntity(definition.fullName));
  await applyDatabaseOverlay(overlay, index, root, subjectId, controls, fixture.linkedChildren);
  const row = mapNativeItemRow(overlay);
  row.Data = data;
  if (options.storedTypeOverride) row.Type = options.storedTypeOverride;
  await fixture.database.insert('BaseItems', row);
  await insertCoreRelations(fixture.database, overlay, index, controls);
  const storedRow = (await fixture.database.rows('BaseItems', { where: { Id: subjectId } }))[0];
  const relations = await hydrationRelations(fixture.database, subjectId, fixture.linkedChildren, storedRow.Type);
  const hydrated = hydrateRow(storedRow, relations, { skip: options.explicitSkip || options.configuredSkip });
  fixture.ownTypedItem(hydrated.item);
  const policy = hydrationPolicy(definition, kind, options);
  t.diagnostic(JSON.stringify({ name: caseName, stage: 'direct-hydration', logs: hydrated.logs }));
  assertHydrationDiagnostics(hydrated.logs, storedRow, policy);
  // Exercise the production records logger, including its real parser error.
  // Explicit Skip is a mapper-only entry point and deliberately bypasses it.
  if (!options.explicitSkip) {
    const events = [];
    await fixture.database.withConnection(async session => {
      let state;
      try {
    state = await loadLibrary(session, { linkedChildren: fixture.linkedChildren, configuration: { SkipDeserializationForBasicTypes: options.configuredSkip === true }, logger: {
      error(error, message, input) {
        events.push({ level: 'Error', eventId: 0, eventName: null, message: `${message}: ${input}`,
          exceptionType: error.name, exceptionMessage: error.message, data: input, error: diagnosticError(error) });
      },
      warn(message) { events.push({ level: 'Warning', eventId: 0, eventName: null, message,
        exceptionType: null, exceptionMessage: null }); }
    } }, { baseRows: [storedRow] });
      } finally { await state?.dispose({ session }); }
    });
    t.diagnostic(JSON.stringify({ name: caseName, stage: 'production-hydration', logs: events }));
    assertHydrationDiagnostics(events, storedRow, policy);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: subjectId } }))[0], storedRow,
      'failed deserialization falls back without writing the database');
    hydrated.logs = events;
  }
  return {
    name: caseName, kind, shortName: definition.name, fullName: storedRow.Type, requiresJson: definition.requiresJson,
    constructor,
    poison: { item: poisonItem, typedJson: poisonTypedJson },
    databaseOverlay: {
      live: await projectItem(overlay, root), columnCount: tableDefinition('BaseItems').columns.length,
      columns: projectColumns(storedRow, root), data: projectJsonText(storedRow.Data, root),
      relations: await projectRelations(fixture.database, subjectId, root),
    },
    hydrated: {
      item: hydrated.item == null ? { isNull: true } : await projectItem(hydrated.item, root),
      typedJson: hydrated.item == null ? { intentionallyAbsent: true } : serializeTyped(hydrated.item, root),
    },
    logs: hydrated.logs,
  };
}

export async function applySaveValues(item, index, phase, root, controls, linkedChildren) {
  const update = phase === 2, marker = update ? 'update' : 'create', type = shortName(item);
  const parentRoot = update ? controls.rootB : controls.rootA;
  const seriesParent = update ? controls.seriesB : controls.seriesA;
  const seasonParent = update ? controls.seasonB : controls.seasonA;
  const artistParent = update ? controls.artistB : controls.artistA;
  const albumParent = update ? controls.albumB : controls.albumA;
  const folderChild = update ? controls.folderChildB : controls.folderChildA;
  const localAlternate = update ? controls.localB : controls.localA;
  const linkedAlternate = update ? controls.linkedB : controls.linkedA;
  item.ParentId = type === 'Episode' ? seasonParent.Id : type === 'Season' ? seriesParent.Id
    : audioObjects.has(type) ? albumParent.Id : type === 'MusicAlbum' ? artistParent.Id : parentRoot.Id;
  Object.assign(item, {
    OwnerId: parentRoot.Id, ChannelId: saveGuid(index, update ? 102 : 101), Name: `Save ${marker} ${type}`,
    Path: path.win32.join(root, `${marker}-${type}${videoTypes.has(type) || audioObjects.has(type) || ['Photo', 'Book'].includes(type) ? '.media' : ''}`),
    DateCreated: utc(update ? 2026 : 2025, phase, 2, 3, 4, 5, index),
    DateModified: utc(update ? 2026 : 2025, phase + 2, 3, 4, 5, 6, index),
    DateLastSaved: utc(update ? 2026 : 2025, phase + 4, 4, 5, 6, 7, index),
    DateLastRefreshed: utc(update ? 2026 : 2025, phase + 6, 5, 6, 7, 8, index),
    PremiereDate: utc(update ? 2024 : 2023, phase, 6, 7, 8, 9, index),
    EndDate: utc(update ? 2028 : 2027, phase, 7, 8, 9, 10, index),
    CommunityRating: update ? 9.25 : 7.75, CriticRating: update ? 91.5 : 81.5,
    CustomRating: update ? 'UPDATE-RATING' : 'CREATE-RATING', OfficialRating: update ? 'DB-R' : 'DB-PG',
    Overview: `Save ${marker} overview`, OriginalTitle: `Save ${marker} original`, OriginalLanguage: update ? 'eng' : 'zho',
    Tagline: `Save ${marker} tagline`, HomePageUrl: `https://save.invalid/${marker}`,
    ExternalId: `external-${marker}-${index}`, ExternalSeriesId: `external-series-${marker}-${index}`,
    IndexNumber: update ? 22 : 11, ParentIndexNumber: update ? 44 : 33,
    InheritedParentalRatingValue: update ? 18 : 13, InheritedParentalRatingSubValue: update ? 2 : 1,
    ProductionYear: update ? 2032 : 2024, RunTimeTicks: update ? 9876543210123 : 1234567890123,
    Size: update ? 987654321 : 123456789, TotalBitrate: update ? 7654321 : 3456789,
    Width: update ? 7680 : 3840, Height: update ? 4320 : 2160, IsLocked: !update,
    IsInMixedFolder: true, IsVirtualItem: update, IsShortcut: true,
    ShortcutPath: path.win32.join(root, `${marker}-shortcut`), Container: update ? 'mkv-update' : 'mkv-create',
    PreferredMetadataLanguage: update ? 'en-US' : 'zh-TW', PreferredMetadataCountryCode: update ? 'US' : 'TW',
    PresentationUniqueKey: `save-${marker}-presentation-${index}`, Album: `Save ${marker} album`,
    LUFS: update ? -8.25 : -12.5, NormalizationGain: update ? 1.75 : 2.5,
    Audio: update ? 'DolbyDigital' : 'Atmos', ExtraType: update ? 'Interview' : 'Featurette',
    ForcedSortName: `${marker}-forced-sort`, SortName: `${marker}-sort`,
    Genres: [`${marker} genre one`, `${marker} genre two`], Studios: [`${marker} studio`],
    Tags: [`${marker} tag one`, `${marker} tag two`], ProductionLocations: [`${marker} location`],
    LockedFields: update ? ['Overview', 'Tags'] : ['Name', 'Genres'],
    RemoteTrailers: [{ Url: `https://save.invalid/${marker}/trailer?type=${type}`,
      Name: update ? '更新 trailer > & "two"' : '首存 trailer <>& "one"' }],
    ImageInfos: [{ Path: path.win32.join(root, `${marker}-primary.jpg`), Type: update ? 'Logo' : 'Primary',
      DateModified: utc(2026, update ? 9 : 8, 8, 9, 10, 11, index), Width: update ? 801 : 601,
      Height: update ? 451 : 351, BlurHash: `${marker}-primary-blur` },
    { Path: path.win32.join(root, `${marker}-secondary.jpg`), Type: update ? 'Thumb' : 'Backdrop',
      DateModified: utc(2026, update ? 10 : 7, 9, 10, 11, 12, index), Width: update ? 802 : 602,
      Height: update ? 452 : 352, BlurHash: `${marker}-secondary-blur` }],
  });
  for (const key of Object.keys(item.ProviderIds)) delete item.ProviderIds[key];
  item.ProviderIds[`Provider${phase}`] = `provider-value-${marker}`;
  item.ProviderIds.SharedProvider = `shared-${marker}`;
  if (folderObjects.has(type)) {
    item.IsRoot = !update; item.DateLastMediaAdded = utc(2026, update ? 12 : 11, 10, 11, 12, 13, index);
    await assignFixtureLink(item, { ItemId: folderChild.Id, Type: update ? 'Shortcut' : 'Manual', Path: null, LibraryItemId: null }, linkedChildren);
  }
  if (type === 'AggregateFolder') item.PhysicalLocationsList = [path.win32.join(root, `${marker}-aggregate`)];
  if (type === 'CollectionFolder') Object.assign(item, { CollectionType: update ? 'music' : 'movies',
    PhysicalLocationsList: [path.win32.join(root, `${marker}-collection`)], PhysicalFolderIds: [parentRoot.Id, folderChild.Id] });
  if (type === 'UserView') Object.assign(item, { ViewType: update ? 'tvshows' : 'movies', DisplayParentId: folderChild.Id,
    UserId: saveGuid(index, update ? 112 : 111) });
  if (type === 'Playlist') Object.assign(item, { OwnerUserId: saveGuid(index, update ? 114 : 113), OpenAccess: !update,
    Shares: [{ UserId: saveGuid(index, update ? 116 : 115), CanEdit: !update }], PlaylistMediaType: update ? 'Video' : 'Audio' });
  if (videoTypes.has(type)) Object.assign(item, {
    AdditionalParts: [path.win32.join(root, type === 'Movie' && !update ? '電影-part-<>&-"one".media' : `${marker}-part.media`)],
    LocalAlternateVersions: [localAlternate.Path],
    LinkedAlternateVersions: [{ ItemId: linkedAlternate.Id, Type: 'LinkedAlternateVersion', Path: null, LibraryItemId: null }],
    SubtitleFiles: [path.win32.join(root, `${marker}.srt`)], AudioFiles: [path.win32.join(root, `${marker}.mka`)],
    VideoType: update ? 'VideoFile' : 'Iso', Timestamp: update ? 'Valid' : 'Zero', DefaultVideoStreamIndex: update ? 8 : 6,
    IsoType: update ? 'BluRay' : 'Dvd', Video3DFormat: update ? 'MVC' : 'HalfSideBySide', AspectRatio: update ? '16:9' : '4:3',
    IsPlaceHolder: !update, HasSubtitles: true, PrimaryVersionId: linkedAlternate.Id,
  });
  if (type === 'Movie') item.TmdbCollectionName = update ? 'Updated Collection' : 'Created Collection';
  if (type === 'Trailer') item.TrailerTypes = update ? ['ComingSoonToDvd'] : ['Archive', 'LocalTrailer'];
  if (type === 'Series') Object.assign(item, { AirDays: update ? ['Tuesday', 'Thursday'] : ['Monday', 'Wednesday'],
    AirTime: update ? '22:30' : '20:15', DisplayOrder: update ? 'update-order' : 'create-order',
    Status: update ? 'Ended' : 'Continuing' });
  if (type === 'BoxSet') Object.assign(item, { DisplayOrder: update ? 'update-order' : 'create-order',
    LibraryFolderIds: [parentRoot.Id, folderChild.Id] });
  if (hasSeriesTypes.has(type)) Object.assign(item, { SeriesId: seriesParent.Id, SeriesName: seriesParent.Name,
    SeriesPresentationUniqueKey: `save-series-${marker}` });
  if (type === 'Episode') Object.assign(item, { SeasonId: seasonParent.Id, SeasonName: seasonParent.Name,
    AirsBeforeSeasonNumber: update ? 20 : 10, AirsAfterSeasonNumber: update ? 21 : 11,
    AirsBeforeEpisodeNumber: update ? 22 : 12, IndexNumberEnd: update ? 23 : 13 });
  if (artistTypes.has(type)) item.Artists = [`${marker} artist one`, `${marker} artist two`];
  if (albumArtistTypes.has(type)) item.AlbumArtists = [`${marker} album artist`];
  if (audioObjects.has(type)) Object.assign(item, { HasLyrics: !update, LyricFiles: [path.win32.join(root, `${marker}.lrc`)] });
  if (type === 'Photo') Object.assign(item, { CameraMake: update ? '更新相機 > & "two"' : '首存相機 <>& "one"',
    CameraModel: update ? 'Model Two' : 'Model One', Software: update ? 'Software Two' : 'Software One',
    ExposureTime: update ? 2.5 : 1.25, FocalLength: update ? 85.5 : 55.5,
    Orientation: update ? 'LeftBottom' : 'RightTop', Aperture: update ? 4 : 2.8,
    ShutterSpeed: update ? 0.25 : 0.125, Latitude: update ? 25.25 : 23.5,
    Longitude: update ? 121.75 : 120.5, Altitude: update ? 30.5 : 12.5, IsoSpeedRating: update ? 800 : 640 });
  return item;
}

export function applySaveClear(item) {
  const type = shortName(item);
  Object.assign(item, {
    ParentId: EMPTY_ID, OwnerId: EMPTY_ID, ChannelId: EMPTY_ID, Name: `Save cleared ${type}`, Path: null,
    DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE,
    PremiereDate: null, EndDate: null, CommunityRating: null, CriticRating: null, CustomRating: null,
    OfficialRating: null, Overview: null, OriginalTitle: null, OriginalLanguage: null, Tagline: null,
    HomePageUrl: null, ExternalId: null, ExternalSeriesId: null, IndexNumber: null, ParentIndexNumber: null,
    InheritedParentalRatingValue: null, InheritedParentalRatingSubValue: null, ProductionYear: null,
    RunTimeTicks: null, Size: null, TotalBitrate: null, Width: 0, Height: 0, IsLocked: false,
    IsInMixedFolder: false, IsVirtualItem: false, IsShortcut: false, ShortcutPath: null, Container: null,
    PreferredMetadataLanguage: null, PreferredMetadataCountryCode: null, PresentationUniqueKey: null,
    Album: null, LUFS: null, NormalizationGain: null, Audio: null, ExtraType: null,
    ForcedSortName: null, SortName: '', Genres: [], Studios: [], Tags: [], ProductionLocations: [],
    LockedFields: [], RemoteTrailers: [], ImageInfos: [],
  });
  for (const key of Object.keys(item.ProviderIds)) delete item.ProviderIds[key];
  if (folderObjects.has(type)) { item.IsRoot = false; item.DateLastMediaAdded = null; item.LinkedChildren = EMPTY_NATIVE_LINKS; }
  if (type === 'AggregateFolder') item.PhysicalLocationsList = [];
  if (type === 'CollectionFolder') Object.assign(item, { CollectionType: null, PhysicalLocationsList: [], PhysicalFolderIds: [] });
  if (type === 'UserView') Object.assign(item, { ViewType: null, DisplayParentId: EMPTY_ID, UserId: null });
  if (type === 'Playlist') Object.assign(item, { OwnerUserId: EMPTY_ID, OpenAccess: false, Shares: [], PlaylistMediaType: 'Unknown' });
  if (videoTypes.has(type)) Object.assign(item, { AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [],
    SubtitleFiles: [], AudioFiles: [], VideoType: 'VideoFile', Timestamp: null, DefaultVideoStreamIndex: null,
    IsoType: null, Video3DFormat: null, AspectRatio: null, IsPlaceHolder: false, HasSubtitles: false, PrimaryVersionId: null });
  if (type === 'Movie') item.TmdbCollectionName = null;
  if (type === 'Trailer') item.TrailerTypes = [];
  if (type === 'Series') Object.assign(item, { AirDays: [], AirTime: null, DisplayOrder: null, Status: null });
  if (type === 'BoxSet') Object.assign(item, { DisplayOrder: null, LibraryFolderIds: [] });
  if (hasSeriesTypes.has(type)) Object.assign(item, { SeriesId: EMPTY_ID, SeriesName: null, SeriesPresentationUniqueKey: null });
  if (type === 'Episode') Object.assign(item, { SeasonId: EMPTY_ID, SeasonName: null,
    AirsBeforeSeasonNumber: null, AirsAfterSeasonNumber: null, AirsBeforeEpisodeNumber: null, IndexNumberEnd: null });
  if (artistTypes.has(type)) item.Artists = [];
  if (albumArtistTypes.has(type)) item.AlbumArtists = [];
  if (audioObjects.has(type)) Object.assign(item, { HasLyrics: null, LyricFiles: [] });
  if (type === 'Photo') Object.assign(item, { CameraMake: null, CameraModel: null, Software: null, ExposureTime: null,
    FocalLength: null, Orientation: null, Aperture: null, ShutterSpeed: null, Latitude: null, Longitude: null,
    Altitude: null, IsoSpeedRating: null });
  return item;
}

export async function projectSaveItem(item, root) {
  return { item: await projectItem(item, root), mappedBase: {
    SortName: item.SortName ?? null, ForcedSortName: item.ForcedSortName ?? null,
    PreferredMetadataLanguage: item.PreferredMetadataLanguage ?? null,
    PreferredMetadataCountryCode: item.PreferredMetadataCountryCode ?? null,
    Album: item.Album ?? null, LUFS: item.LUFS ?? null, NormalizationGain: item.NormalizationGain ?? null,
    TotalBitrate: item.TotalBitrate ?? null, audio: item.Audio ?? null, extraType: item.ExtraType ?? null,
    HomePageUrl: item.HomePageUrl ?? null, ExternalId: item.ExternalId ?? null,
    ExternalSeriesId: item.ExternalSeriesId ?? null,
    InheritedParentalRatingValue: item.InheritedParentalRatingValue ?? null,
    InheritedParentalRatingSubValue: item.InheritedParentalRatingSubValue ?? null,
    IndexNumber: item.IndexNumber ?? null, ParentIndexNumber: item.ParentIndexNumber ?? null,
    PresentationUniqueKey: item.PresentationUniqueKey ?? null,
  } };
}

async function projectControls(database, controls, root) {
  const ids = new Set(controls.items.map(item => idKey(item.Id)));
  const rows = (await database.rows('BaseItems')).filter(row => ids.has(idKey(row.Id))).map(row => ({
    id: guid(row.Id), Type: row.Type, Name: row.Name, parentId: row.ParentId == null ? null : guid(row.ParentId),
    ownerId: row.OwnerId == null ? null : guid(row.OwnerId),
    primaryVersionId: row.PrimaryVersionId == null ? null : guid(row.PrimaryVersionId),
    PresentationUniqueKey: row.PresentationUniqueKey, path: normalizePath(row.Path, root),
  })).sort((left, right) => ordinal(left.id, right.id));
  const present = new Set(rows.map(row => idKey(row.id)));
  return { rows, missingIds: controls.items.map(item => guid(item.Id)).filter(id => !present.has(idKey(id))).sort(ordinal) };
}

async function projectSaveSnapshot(fixture, subjectId, controls, root) {
  const database = fixture.database;
  const row = (await database.rows('BaseItems', { where: { Id: subjectId } }))[0];
  const relations = await hydrationRelations(database, subjectId, fixture.linkedChildren, row.Type);
  const hydrated = fixture.ownTypedItem(hydrateRow(row, relations).item);
  return {
    columnCount: tableDefinition('BaseItems').columns.length,
    columns: projectColumns(row, root),
    data: projectJsonText(row.Data, root),
    relations: await projectRelations(database, subjectId, root, { save: true }),
    hydrated: await projectSaveItem(hydrated, root),
    hydratedTypedJson: serializeTyped(hydrated, root, { requireSuccess: true }),
    hydrationLogs: [],
    controls: await projectControls(database, controls, root),
  };
}

export async function runSaveLifecycle(t, dialect, definition, index) {
  const caseName = `saveitems-${definition.name}`;
  const { fixture, root } = await setupTypedFixture(t, dialect, caseName);
  const controls = controlItems(index, root, { save: true });
  await seedItems(fixture.database, controls.items);
  const subject = fixture.ownTypedItem(newNativeItemEntity(definition.fullName));
  subject.Id = saveGuid(index, 1);
  const logger = captureLogger();

  const saveContext = async () => {
    const parent = controls.items.find(item => idKey(item.Id) === idKey(subject.ParentId));
    const parents = [];
    let current = parent;
    while (current) {
      parents.push(current);
      current = controls.items.find(item => idKey(item.Id) === idKey(current.ParentId));
    }
    const [snapshot] = await fixture.database.rows('BaseItems', { where: { Id: subject.Id } });
    return { item: subject, snapshot, linkedChildren: fixture.linkedChildren, relationships: {}, parents, collectionFolders: [],
      reversePath: value => value, capturePathScope: () => ({ reversePath: value => value }), sortName: value => value.SortName, logger };
  };

  const saveStage = async (stage, apply) => {
    const logOffset = logger.events.length;
    await apply();
    const live = await projectSaveItem(subject, root);
    const liveTypedJson = serializeTyped(subject, root, { requireSuccess: true });
    const mappedRow = mapNativeItemRow(subject);
    const mapper = { columnCount: tableDefinition('BaseItems').columns.length,
      columns: projectColumns(mappedRow, root), data: projectJsonText(mappedRow.Data, root) };
    await saveNativeItems(fixture.store, [await saveContext()]);
    const logs = clone(logger.events.slice(logOffset));
    t.diagnostic(JSON.stringify({ name: caseName, stage, logs }));
    assert.ok(logs.every(log => !['Error', 'Warning'].includes(log.level)),
      'Successful typed saves must not hide background parser or persistence failures.');
    return { stage, live, liveTypedJson, mapper,
      stored: await projectSaveSnapshot(fixture, subject.Id, controls, root),
      logs };
  };
  const markOwned = async control => {
    await fixture.database.update('BaseItems', { Id: control.Id }, { OwnerId: subject.Id });
    control.OwnerId = subject.Id;
  };

  const created = await saveStage('created', () => applySaveValues(subject, index, 1, root, controls, fixture.linkedChildren));
  await markOwned(controls.localA);
  const updated = await saveStage('updated', () => applySaveValues(subject, index, 2, root, controls, fixture.linkedChildren));
  await markOwned(controls.localB);
  const cleared = await saveStage('cleared', () => applySaveClear(subject));
  return { name: caseName, kind: 'saveitems', shortName: definition.name, fullName: definition.fullName,
    requiresJson: definition.requiresJson, stages: { created, updated, cleared } };
}

function replaceStrings(value, replacements) {
  if (Array.isArray(value)) return value.map(entry => replaceStrings(entry, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, replaceStrings(entry, replacements)]));
  if (typeof value !== 'string') return value;
  return replacements.get(value.toLowerCase()) ?? value;
}

function registerReplacement(replacements, id, token, label) {
  if (!uuidV4.test(id)) throw new Error(`${label} is not a nonempty RFC4122 UUIDv4: ${id}`);
  const key = id.toLowerCase(), existing = replacements.get(key);
  if (existing != null && existing !== token) throw new Error(`${label} reuses ${id} for ${existing} and ${token}.`);
  replacements.set(key, token);
}

/** Validate both native and candidate random relationship identities before
 * recursively alpha-renaming every reference. No key or row is discarded. */
export function normalizeRelationshipIds(result) {
  const copy = structuredClone(result), replacements = new Map(), imageIds = new Set();
  const results = Array.isArray(copy) ? copy : [copy];
  const visitImages = (relations, namespace) => {
    for (const [index, image] of (relations?.images ?? []).entries()) {
      const key = String(image.id).toLowerCase();
      if (imageIds.has(key)) throw new Error(`Image primary key was reused in ${namespace}: ${image.id}`);
      imageIds.add(key);
      registerReplacement(replacements, image.id, `$IMAGE/${namespace}/${index}`, `${namespace} image ${index}`);
    }
  };
  for (const entry of results) if (entry.kind === 'saveitems') {
    const valueIds = new Map(), semanticIds = new Map(), history = new Set();
    for (const [stage, snapshot] of Object.entries(entry.stages)) {
      const relations = snapshot.stored.relations;
      visitImages(relations, `${entry.name}/${stage}`);
      const stageIds = new Set();
      for (const value of relations.values) {
        const expectedKey = `$VALUE/${value.typeValue}/${value.Value}`;
        if (value.semanticKey !== expectedKey) throw new Error(`${entry.name}/${stage} has invalid value semanticKey.`);
        const id = String(value.id).toLowerCase();
        if (!uuidV4.test(id)) throw new Error(`${entry.name}/${stage} ItemValueId is not UUIDv4: ${value.id}`);
        if (stageIds.has(id)) throw new Error(`${entry.name}/${stage} duplicates ItemValueId ${value.id}.`);
        stageIds.add(id); history.add(id);
        if (valueIds.has(id) && valueIds.get(id) !== value.semanticKey) throw new Error(`${entry.name} reuses an ItemValueId for another semantic value.`);
        if (semanticIds.has(value.semanticKey) && semanticIds.get(value.semanticKey) !== id) throw new Error(`${entry.name} changes ItemValueId for ${value.semanticKey}.`);
        valueIds.set(id, value.semanticKey); semanticIds.set(value.semanticKey, id);
        registerReplacement(replacements, value.id, `${entry.name}/${value.semanticKey}`, `${entry.name} ItemValue ${value.semanticKey}`);
      }
      for (const map of relations.maps) {
        const id = String(map.itemValueId).toLowerCase();
        if (!stageIds.has(id) || valueIds.get(id) !== map.semanticKey) throw new Error(`${entry.name}/${stage} map references an unknown ItemValueId.`);
      }
      for (const id of history) if (!stageIds.has(id)) throw new Error(`${entry.name}/${stage} lost historical ItemValue ${id}.`);
    }
  } else visitImages(entry.databaseOverlay?.relations, entry.name);
  return replaceStrings(copy, replacements);
}

export function projectSerializableContract(fullName) {
  const typeNames = {
    bool: 'System.Boolean', int: 'System.Int32', long: 'System.Nullable`1[[System.Int64, System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e]]',
    double: 'System.Nullable`1[[System.Double, System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e]]',
    string: 'System.String', guid: 'System.Guid', date: 'System.DateTime',
  };
  return nativeItemJsonContract(fullName).map(spec => ({ jsonName: spec.name, kind: spec.kind,
    propertyType: typeNames[spec.kind] ?? spec.kind, jsonHasGet: true, jsonHasSet: !spec.readOnly,
    getterOnly: spec.readOnly, nullable: spec.nullable }));
}
