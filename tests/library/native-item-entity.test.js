import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/database/postgres.js';
import {PostgresLinkedChildrenStore,EMPTY_NATIVE_LINKS} from '../../src/library/postgres-linked-children.js';
import {releaseNativeItemLinks,publishNativeItemLinks} from '../../src/library/native-item-entity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import {
  applyNativeItemValues,
  bindNativeItemRecordingAccess,
  clearNativeItemSortCache,
  cloneNativeItemEntity,
  captureNativeItemState,
  configureNativeItemSort,
  copyNativeItemState,
  hydrateNativeItemEntity,
  isNativeItemEntity,
  isResolverNativeItemType,
  nativeItemDescriptor,
  newNativeItemEntity,
  restoreNativeItemState,
  setNativeItemJsonDateState,
  nativeItemJsonDateState,
} from '../../src/library/native-item-entity.js';
import { md5Guid } from '../../src/core/identity.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { EMPTY_ID, guid, mapRecord, MIN_DATE } from '../../src/library/records.js';
import { observeComparison } from '../comparison-observations.js';

const types = [
  ['MediaBrowser.Controller.Entities.Folder', 'Folder', 'folder', true, 'Unknown', 'Other', true, true, false, true],
  ['MediaBrowser.Controller.Entities.AggregateFolder', 'AggregateFolder', 'folder', true, 'Unknown', 'Other', false, true, false, true],
  ['MediaBrowser.Controller.Entities.UserRootFolder', 'UserRootFolder', 'folder', true, 'Unknown', 'Other', false, true, false, true],
  ['MediaBrowser.Controller.Entities.CollectionFolder', 'CollectionFolder', 'folder', true, 'Unknown', 'Other', false, true, false, true],
  ['MediaBrowser.Controller.Entities.UserView', 'UserView', 'folder', true, 'Unknown', 'Other', false, true, false, true],
  ['Emby.Server.Implementations.Playlists.PlaylistsFolder', 'PlaylistsFolder', 'folder', false, 'Unknown', 'Other', false, true, true, true],
  ['MediaBrowser.Controller.Playlists.Playlist', 'Playlist', 'folder', true, 'Unknown', 'Other', true, true, false, true],
  ['MediaBrowser.Controller.Entities.Movies.Movie', 'Movie', 'video', true, 'Video', 'Movie', true, false, false, false],
  ['MediaBrowser.Controller.Entities.Video', 'Video', 'video', true, 'Video', 'Other', true, false, false, false],
  ['MediaBrowser.Controller.Entities.TV.Episode', 'Episode', 'video', true, 'Video', 'Series', true, false, false, false],
  ['MediaBrowser.Controller.Entities.TV.Series', 'Series', 'folder', true, 'Unknown', 'Series', true, true, false, true],
  ['MediaBrowser.Controller.Entities.TV.Season', 'Season', 'folder', false, 'Unknown', 'Series', true, true, false, true],
  ['MediaBrowser.Controller.Entities.Movies.BoxSet', 'BoxSet', 'folder', true, 'Unknown', 'Movie', true, true, false, true],
  ['MediaBrowser.Controller.Entities.Audio.Audio', 'Audio', 'audio', true, 'Audio', 'Music', true, false, false, false],
  ['MediaBrowser.Controller.Entities.AudioBook', 'AudioBook', 'audio', false, 'Audio', 'Book', true, false, false, false],
  ['MediaBrowser.Controller.Entities.MusicVideo', 'MusicVideo', 'video', true, 'Video', 'Music', true, false, false, false],
  ['MediaBrowser.Controller.Entities.Trailer', 'Trailer', 'video', true, 'Video', 'Trailer', true, false, false, false],
  ['MediaBrowser.Controller.LiveTv.LiveTvProgram', 'LiveTvProgram', 'base', false, 'Unknown', 'LiveTvProgram', false, false, false, false],
  ['MediaBrowser.Controller.LiveTv.LiveTvChannel', 'LiveTvChannel', 'base', true, 'Video', 'LiveTvChannel', false, false, false, false],
  ['MediaBrowser.Controller.Entities.Audio.MusicAlbum', 'MusicAlbum', 'folder', false, 'Unknown', 'Music', true, true, false, true],
  ['MediaBrowser.Controller.Entities.Audio.MusicArtist', 'MusicArtist', 'folder', false, 'Unknown', 'Music', true, false, false, true],
  ['MediaBrowser.Controller.Entities.Person', 'Person', 'base', false, 'Unknown', 'Other', false, false, false, false],
  ['MediaBrowser.Controller.Entities.Genre', 'Genre', 'base', false, 'Unknown', 'Other', false, false, false, true],
  ['MediaBrowser.Controller.Entities.Audio.MusicGenre', 'MusicGenre', 'base', false, 'Unknown', 'Other', false, false, false, true],
  ['MediaBrowser.Controller.Entities.Studio', 'Studio', 'base', false, 'Unknown', 'Other', false, false, false, true],
  ['MediaBrowser.Controller.Entities.Year', 'Year', 'base', false, 'Unknown', 'Other', false, false, false, false],
  ['MediaBrowser.Controller.Entities.Photo', 'Photo', 'photo', true, 'Photo', 'Other', true, false, false, false],
  ['MediaBrowser.Controller.Entities.PhotoAlbum', 'PhotoAlbum', 'folder', false, 'Unknown', 'Other', true, true, false, true],
  ['MediaBrowser.Controller.Entities.Book', 'Book', 'book', false, 'Book', 'Book', true, false, false, false],
];
const byName = Object.fromEntries(types.map(([nativeType, type]) => [type, nativeType]));
const fixedUnrated = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet', 'AudioBook',
  'MusicVideo', 'Trailer', 'LiveTvProgram', 'LiveTvChannel', 'MusicAlbum', 'MusicArtist', 'Book']);

test('constructing a channel leaves its lazy media display getter unobserved until explicitly selected', () => {
  const item = newNativeItemEntity('MediaBrowser.Controller.Channels.Channel');
  assert.equal(item.SourceType, 'Channel'); assert.equal(item.ChannelId, EMPTY_ID);
  assert.equal(Object.keys(item).includes('EnableMediaSourceDisplay'), false);
  assert.doesNotThrow(() => ({ ...item }));
  assert.throws(() => item.EnableMediaSourceDisplay, { status: 400, nativeException: 'ArgumentException' });
  const clone = cloneNativeItemEntity(item);
  assert.throws(() => clone.EnableMediaSourceDisplay, { status: 400, nativeException: 'ArgumentException' });
  item.ChannelId = guid('a9b10000000000000000000000000001');
  assert.equal(item.EnableMediaSourceDisplay, true);
});

test('native factory exposes the exact full-29 registry and rejects discriminator guesses', () => {
  assert.equal(types.length, 29);
  for (const [nativeType, type, family, requiresJson, mediaType, unratedType, resolverCreation,
    isFolder, isHidden, isDisplayedAsFolder] of types) {
    assert.deepEqual(nativeItemDescriptor(nativeType), {
      nativeType, type, family, requiresJson, mediaType, unratedType, resolverCreation,
      isFolder: family === 'folder', isHidden: type === 'PlaylistsFolder',
      isDisplayedAsFolder: family === 'folder' || ['Genre', 'MusicGenre', 'Studio'].includes(type),
      sourceAwareUnrated: !fixedUnrated.has(type),
      hasArtist: ['Audio', 'AudioBook', 'MusicVideo', 'MusicAlbum'].includes(type),
      hasAlbumArtist: ['Audio', 'AudioBook', 'MusicAlbum'].includes(type),
      hasSeries: ['Episode', 'Season', 'AudioBook', 'Book'].includes(type),
      dynamicFolder: type === 'MusicArtist',
    });
    assert.equal(isResolverNativeItemType(nativeType), resolverCreation);
    const item = newNativeItemEntity(nativeType);
    assert.equal(item.NativeType, nativeType);
    assert.equal(item.Type, type);
    assert.equal(item.MediaType, mediaType);
    assert.equal(item.UnratedType, unratedType);
    assert.equal(item.IsFolder, isFolder);
    assert.equal(item.IsHidden, isHidden);
    assert.equal(item.IsDisplayedAsFolder, isDisplayedAsFolder);
  }
  for (const value of ['Folder', 'MediaBrowser.Controller.Entities.Movie', 'Plugin.Example.Folder', '']) {
    assert.throws(() => nativeItemDescriptor(value), TypeError);
    assert.throws(() => newNativeItemEntity(value), TypeError);
  }
});

test('all constructors retain pinned base defaults and independent mutable state', t => {
  for (const [nativeType, type] of types) {
    const left = newNativeItemEntity(nativeType), right = newNativeItemEntity(nativeType);
    assert.equal(isNativeItemEntity(left), true);
    assert.deepEqual({ Id: left.Id, ParentId: left.ParentId, OwnerId: left.OwnerId, ChannelId: left.ChannelId,
      DisplayParentId: left.DisplayParentId }, { Id: EMPTY_ID, ParentId: EMPTY_ID, OwnerId: EMPTY_ID,
      ChannelId: EMPTY_ID, DisplayParentId: EMPTY_ID }, type);
    assert.deepEqual([left.DateCreated, left.DateModified, left.DateLastSaved, left.DateLastRefreshed],
      [MIN_DATE, MIN_DATE, MIN_DATE, MIN_DATE], type);
    assert.deepEqual([left.PremiereDate, left.EndDate, left.Name, left.Path, left.Container, left.ShortcutPath,
      left.ProductionYear, left.Size, left.RunTimeTicks], [null, null, type === 'PlaylistsFolder' ? 'Playlists' : null,
      null, null, null, null, null, null], type);
    assert.deepEqual([left.Width, left.Height, left.IsHD, left.IsShortcut, left.IsInMixedFolder, left.IsLocked,
      left.IsVirtualItem], [0, 0, false, false, false, false, type === 'LiveTvProgram'], type);
    assert.notEqual(left.ProviderIds, right.ProviderIds, `${type} ProviderIds is constructed`);
    assert.notEqual(left.UserData, right.UserData, `${type} UserData is constructed`);
    for (const key of Object.keys(left).filter(key => Array.isArray(left[key]))) {
      if (key === 'UserData' || key === 'VirtualChildren') continue;
      assert.deepEqual(left[key], [], `${type}.${key}`);
      assert.deepEqual(right[key], [], `${type}.${key}`);
      observeComparison(t, `${type}.${key} default array`, { shared: left[key] === right[key], frozen: Object.isFrozen(left[key]) },
        { shared: true, frozen: true });
    }
    observeComparison(t, `${type} empty string singleton`, left.Genres === left.Tags, true);
    left.Tags = ['isolated'];
    assert.deepEqual(right.Tags, []);
    assert.deepEqual(left.Genres, []);
  }
});

test('type-specific constructor defaults match the pinned native constructors', () => {
  const folder = newNativeItemEntity(byName.Folder);
  assert.deepEqual(folder.PhysicalLocations, []);
  folder.Path = '/media/library';
  assert.deepEqual(folder.PhysicalLocations, ['/media/library']);
  folder.Path = 'https://media.example/library';
  assert.deepEqual(folder.PhysicalLocations, []);
  assert.deepEqual([folder.IsRoot, folder.DateLastMediaAdded, folder.LinkedChildrenLoaded, Number(folder.LinkedChildren===EMPTY_NATIVE_LINKS?0:NaN)],
    [false, null, false, 0]);
  assert.equal(newNativeItemEntity(byName.UserRootFolder).IsRoot, true);
  const aggregate = newNativeItemEntity(byName.AggregateFolder);
  assert.deepEqual([aggregate.PhysicalLocationsList, aggregate.PhysicalLocations, aggregate.VirtualChildren], [[], [], []]);
  assert.notEqual(aggregate.VirtualChildren, newNativeItemEntity(byName.AggregateFolder).VirtualChildren);
  const collection = newNativeItemEntity(byName.CollectionFolder);
  assert.deepEqual([collection.PhysicalLocationsList, collection.PhysicalFolderIds, collection.CollectionType], [[], [], null]);
  const view = newNativeItemEntity(byName.UserView);
  assert.deepEqual([view.ViewType, view.CollectionType, view.UserId], [null, null, null]);
  assert.equal(newNativeItemEntity(byName.PlaylistsFolder).CollectionType, 'playlists');
  const playlist = newNativeItemEntity(byName.Playlist);
  assert.deepEqual([playlist.OwnerUserId, playlist.OpenAccess, playlist.Shares, playlist.PlaylistMediaType, playlist.MediaType],
    [EMPTY_ID, false, [], 'Unknown', 'Unknown']);
  const video = newNativeItemEntity(byName.Video);
  assert.deepEqual([video.AdditionalParts, video.LocalAlternateVersions, video.LinkedAlternateVersions,
    video.SubtitleFiles, video.AudioFiles, video.Timestamp, video.DefaultVideoStreamIndex, video.IsoType,
    video.Video3DFormat, video.AspectRatio, video.VideoType, video.HasSubtitles, video.IsPlaceHolder],
  [[], [], [], [], [], null, null, null, null, null, 'VideoFile', false, false]);
  assert.equal(newNativeItemEntity(byName.Movie).TmdbCollectionName, null);
  const episode = newNativeItemEntity(byName.Episode);
  assert.deepEqual([episode.SeriesId, episode.SeriesName, episode.SeriesPresentationUniqueKey, episode.SeasonId,
    episode.SeasonName, episode.AirsBeforeSeasonNumber, episode.AirsAfterSeasonNumber,
    episode.AirsBeforeEpisodeNumber, episode.IndexNumberEnd, episode.AiredSeasonNumber],
  [EMPTY_ID, null, null, EMPTY_ID, null, null, null, null, null, null]);
  const series = newNativeItemEntity(byName.Series);
  assert.deepEqual([series.AirDays, series.AirTime, series.DisplayOrder, series.Status], [[], null, null, null]);
  const boxSet = newNativeItemEntity(byName.BoxSet);
  assert.deepEqual([boxSet.DisplayOrder, boxSet.LibraryFolderIds], ['PremiereDate', null]);
  for (const name of ['Audio', 'AudioBook']) {
    const audio = newNativeItemEntity(byName[name]);
    assert.deepEqual([audio.Artists, audio.AlbumArtists, audio.Album, audio.HasLyrics, audio.LyricFiles],
      [[], [], null, null, []]);
  }
  assert.deepEqual(newNativeItemEntity(byName.MusicVideo).Artists, []);
  assert.deepEqual(newNativeItemEntity(byName.Trailer).TrailerTypes, []);
  const liveTvProgram = newNativeItemEntity(byName.LiveTvProgram);
  assert.equal(newNativeItemEntity(byName.LiveTvChannel).EnableRememberingTrackSelections, false);
  assert.equal(liveTvProgram.EnableRememberingTrackSelections, true);
  assert.deepEqual({ Type: liveTvProgram.Type, SourceType: liveTvProgram.SourceType,
    IsVirtualItem: liveTvProgram.IsVirtualItem, IsFolder: liveTvProgram.IsFolder,
    MediaType: liveTvProgram.MediaType, UnratedType: liveTvProgram.UnratedType,
    SupportsPlayedStatus: liveTvProgram.SupportsPlayedStatus,
    SupportsPositionTicksResume: liveTvProgram.SupportsPositionTicksResume }, {
    Type: 'LiveTvProgram', SourceType: 'LiveTV', IsVirtualItem: true, IsFolder: false,
    MediaType: 'Unknown', UnratedType: 'LiveTvProgram', SupportsPlayedStatus: false,
    SupportsPositionTicksResume: false,
  });
  assert.deepEqual([newNativeItemEntity(byName.MusicAlbum).Artists, newNativeItemEntity(byName.MusicAlbum).AlbumArtists], [[], []]);
  assert.deepEqual(Object.fromEntries(['CameraMake', 'CameraModel', 'Software', 'ExposureTime', 'FocalLength',
    'Orientation', 'Aperture', 'ShutterSpeed', 'Latitude', 'Longitude', 'Altitude', 'IsoSpeedRating']
    .map(key => [key, newNativeItemEntity(byName.Photo)[key]])), {
    CameraMake: null, CameraModel: null, Software: null, ExposureTime: null, FocalLength: null,
    Orientation: null, Aperture: null, ShutterSpeed: null, Latitude: null, Longitude: null,
    Altitude: null, IsoSpeedRating: null,
  });
});

test('derived native traits follow their authoritative dependencies', () => {
  for (const [nativeType, type, , , mediaType, unratedType] of types) {
    const item = newNativeItemEntity(nativeType);
    item.Height = 719; assert.equal(item.IsHD, false, type);
    item.Height = 720; assert.equal(item.IsHD, true, type);
    item.ChannelId = '95500000-0000-0000-0001-000000000001';
    assert.equal(item.SourceType, ['LiveTvProgram', 'LiveTvChannel'].includes(type) ? 'LiveTV' : 'Channel', type);
    assert.equal(item.UnratedType, fixedUnrated.has(type) ? unratedType : 'ChannelContent', type);
    assert.equal(item.MediaType, mediaType, type);
  }
  const artist = newNativeItemEntity(byName.MusicArtist);
  assert.deepEqual([artist.IsAccessedByName, artist.IsFolder], [true, false]);
  artist.ParentId = '95500000-0000-0000-0002-000000000001';
  assert.deepEqual([artist.IsAccessedByName, artist.IsFolder], [false, true]);
  const playlist = newNativeItemEntity(byName.Playlist);
  playlist.PlaylistMediaType = 'Audio'; assert.equal(playlist.MediaType, 'Audio');
  const view = newNativeItemEntity(byName.UserView);
  view.ViewType = 'movies'; view.ParentId = '95500000-0000-0000-0002-000000000002';
  assert.equal(view.CollectionType, 'movies'); assert.equal(view.DisplayParentId, EMPTY_ID);
  assert.equal(view.BaseDisplayParentId, view.ParentId);
  view.DisplayParentId = '95500000-0000-0000-0002-000000000003';
  assert.notEqual(view.DisplayParentId, view.ParentId);
  const person = newNativeItemEntity(byName.Person);
  person.ParentId = '95500000-0000-0000-0002-000000000004';
  assert.equal(person.DisplayParentId, person.ParentId); assert.equal(person.BaseDisplayParentId, person.ParentId);
  const season = newNativeItemEntity(byName.Season);
  season.ParentId = '95500000-0000-0000-0002-000000000005';
  season.SeriesId = '95500000-0000-0000-0002-000000000006';
  assert.equal(season.DisplayParentId, season.SeriesId); assert.equal(season.BaseDisplayParentId, season.SeriesId);
  const episode = newNativeItemEntity(byName.Episode);
  episode.ParentId = '95500000-0000-0000-0002-000000000007';
  episode.SeasonId = '95500000-0000-0000-0002-000000000008';
  assert.equal(episode.DisplayParentId, episode.SeasonId); assert.equal(episode.BaseDisplayParentId, episode.SeasonId);
  assert.equal(episode.AiredSeasonNumber, null);
  episode.ParentIndexNumber = 1; assert.equal(episode.AiredSeasonNumber, 1);
  episode.AirsBeforeSeasonNumber = 2; assert.equal(episode.AiredSeasonNumber, 2);
  episode.AirsAfterSeasonNumber = 3; assert.equal(episode.AiredSeasonNumber, 3);
  assert.throws(() => { episode.AiredSeasonNumber = 4; }, TypeError);
  const folder = newNativeItemEntity(byName.Folder);
  folder.Id = '95500000-0000-0000-0003-000000000001'; assert.equal(folder.DisplayPreferencesId, folder.Id);
  const collection = newNativeItemEntity(byName.CollectionFolder);
  collection.Id = '95500000-0000-0000-0003-000000000002'; assert.equal(collection.DisplayPreferencesId, collection.Id);
  assert.equal(person.DisplayPreferencesId, guid(md5Guid(byName.Person)));
  const book = newNativeItemEntity(byName.Book);
  assert.deepEqual([book.SupportsPlayedStatus, book.SupportsPositionTicksResume], [true, true]);
  const video = newNativeItemEntity(byName.Video);
  assert.equal(video.SupportsPositionTicksResume, true);
  video.ExtraType = 'Sample'; assert.equal(video.SupportsPositionTicksResume, false);

  // These capability controls are source-driven additions: the sealed r4
  // projection does not claim to measure them.
  const played = new Set(['Folder', 'PlaylistsFolder', 'Playlist', 'Movie', 'Video', 'Episode', 'Series',
    'Season', 'BoxSet', 'Audio', 'AudioBook', 'MusicVideo', 'Trailer', 'Book']);
  for (const [nativeType, type] of types) {
    const candidate = newNativeItemEntity(nativeType);
    assert.equal(candidate.SupportsPlayedStatus, played.has(type), `${type}.SupportsPlayedStatus`);
    assert.equal(candidate.SupportsPositionTicksResume,
      ['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer', 'AudioBook', 'Book'].includes(type),
      `${type}.SupportsPositionTicksResume`);
  }
});

test('persisted LiveTvProgram retains its internal kind while DTO projection uses the native client kind', async () => {
  const item = mapRecord({
    Id: '95500000-0000-0000-0004-000000000001',
    Type: byName.LiveTvProgram,
    Data: '{}',
    Name: 'Fixture Live TV Program',
    Path: null,
    IsVirtualItem: true,
    MediaType: 'Unknown',
  });
  assert.deepEqual({ Type: item.Type, SourceType: item.SourceType, IsVirtualItem: item.IsVirtualItem,
    IsFolder: item.IsFolder, MediaType: item.MediaType, UnratedType: item.UnratedType,
    SupportsPlayedStatus: item.SupportsPlayedStatus,
    SupportsPositionTicksResume: item.SupportsPositionTicksResume, LocationType: item.LocationType }, {
    Type: 'LiveTvProgram', SourceType: 'LiveTV', IsVirtualItem: true, IsFolder: false,
    MediaType: 'Unknown', UnratedType: 'LiveTvProgram', SupportsPlayedStatus: false,
    SupportsPositionTicksResume: false, LocationType: 'Virtual',
  });
  const db = { rows: async table => {
    assert.equal(table, 'BaseItemImageInfos');
    return [];
  } };
  const dto = await projectItem(item, { db, items: [item], byId: new Map([[item.Id, item]]) }, null,
    dtoOptions({ enableimages: false, enableuserdata: false }), { serverId: 'live-tv-program-test' });
  assert.equal(dto.Type, 'Program');
  assert.equal(dto.MediaType, 'Unknown');
  assert.equal(Object.hasOwn(dto, 'SourceType'), false);
  assert.equal(Object.hasOwn(dto, 'LocationType'), false);
  assert.equal(Object.hasOwn(dto, 'IsFolder'), false);
  assert.equal(item.Type, 'LiveTvProgram', 'DTO projection must not change the internal provider kind');
});

test('native sort state preserves explicit empty values, invalidation, configuration and raw clone state', () => {
  const folder = configureNativeItemSort(newNativeItemEntity(byName.Folder), {
    configuration: { SortRemoveWords: ['the'], SortRemoveCharacters: [], SortReplaceCharacters: [] },
  });
  folder.Name = 'The 2 Folder';
  assert.equal(folder.SortName, '0000000002 folder');
  folder.SortName = '';
  assert.equal(folder.SortName, '', 'an explicit empty mapper value remains a warmed cache value');
  const emptyClone = cloneNativeItemEntity(folder);
  assert.equal(emptyClone.SortName, '', 'clone copies the private raw cache instead of recomputing it');
  folder.ForcedSortName = 'The 3 Forced';
  assert.equal(folder.SortName, '0000000003 forced');
  folder.SortName = 'stored';
  folder.Name = 'The 4 Renamed';
  assert.equal(folder.SortName, '0000000003 forced', 'Name setter invalidates but retains the forced-name source');
  folder.ForcedSortName = null;
  assert.equal(folder.SortName, '0000000004 renamed', 'ForcedSortName setter invalidates the cache');
  folder.SortName = 'stored-again';
  folder.ForcedSortName = 'The 3 Forced';
  folder.SortName = 'stored-again';
  clearNativeItemSortCache(folder);
  assert.equal(folder.SortName, '0000000003 forced', 'explicit cache clearing keeps the forced name');

  const target = newNativeItemEntity(byName.Folder);
  target.SortName = 'stale';
  copyNativeItemState(target, emptyClone);
  assert.equal(target.SortName, '', 'copy replaces the private cache without reading the source getter');
});

test('plain producer application deep-copies writable state and rejects derived contradictions', () => {
  const source = { Height: 733, ChannelId: EMPTY_ID, IsHD: true, SourceType: 'Library', MediaType: 'Video',
    UnratedType: 'Other', IsFolder: false, Tags: ['one'], Data: { nested: ['value'] } };
  const item = applyNativeItemValues(newNativeItemEntity(byName.Video), source);
  assert.deepEqual([item.Height, item.IsHD, item.SourceType, item.MediaType, item.UnratedType, item.IsFolder],
    [733, true, 'Library', 'Video', 'Other', false]);
  assert.deepEqual(item.Tags, ['one']); assert.notEqual(item.Tags, source.Tags);
  assert.deepEqual(item.Data, source.Data); assert.notEqual(item.Data.nested, source.Data.nested);
  assert.equal(Object.isFrozen(item.Tags), false);
  assert.throws(() => applyNativeItemValues(newNativeItemEntity(byName.Video), { Height: 733, IsHD: false }),
    /inconsistent IsHD/u);
  assert.throws(() => applyNativeItemValues(newNativeItemEntity(byName.Audio), { MediaType: 'Video' }),
    /inconsistent MediaType/u);
  assert.throws(() => applyNativeItemValues(newNativeItemEntity(byName.Audio), item), /copyNativeItemState/u);
  assert.throws(() => { item.Type = 'Movie'; }, TypeError);
  assert.throws(() => { item.SourceType = 'Channel'; }, TypeError);

  const folder = newNativeItemEntity(byName.Folder);
  publishNativeItemLinks(folder,EMPTY_NATIVE_LINKS);
  assert.equal(folder.LinkedChildrenLoaded, true, 'assigning even an empty complete set marks relationships loaded');
  assert.equal(folder.LinkedChildren,EMPTY_NATIVE_LINKS);
});

test('clone and copy preserve brand, getters, nonenumerable raw state and private loaded state', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async t => {
  const {links,own}=await relationsFixture(t);
  const source = own(newNativeItemEntity(byName.Folder));
  source.Id = '95500000-0000-0000-0004-000000000001';
  source.Tags = ['source']; source.ProviderIds = { Tmdb: '1' }; source.Data = { IsRoot: false };
  source.LinkedChildren = await links.withSession(async session=>{const writer=await links.createWriter({session,parentId:source.Id});await writer.append({ItemId:'95500000-0000-0000-0004-000000000002',Type:0});return writer.finish();});
  Object.defineProperty(source, 'NativeData', { value: '{"IsRoot":false}', enumerable: false,
    writable: true, configurable: true });
  Object.defineProperty(source, 'NativeMediaType', { value: null, enumerable: false,
    writable: true, configurable: true });
  Object.defineProperty(source, 'NativeTopParentId', { value: null, enumerable: false,
    writable: true, configurable: true });

  const cloned = own(cloneNativeItemEntity(source));
  assert.equal(isNativeItemEntity(cloned), true);
  assert.notEqual(cloned, source);
  assert.deepEqual(cloned.Tags, source.Tags); assert.notEqual(cloned.Tags, source.Tags);
  assert.deepEqual(cloned.ProviderIds, source.ProviderIds); assert.notEqual(cloned.ProviderIds, source.ProviderIds);
  assert.deepEqual(await linkRows(links,cloned),await linkRows(links,source));
  await links.recordResolution(cloned.LinkedChildren,1n,EMPTY_ID);assert.equal((await linkRows(links,source))[0].ItemId,'95500000-0000-0000-0004-000000000002');
  assert.equal(cloned.LinkedChildrenLoaded, true);
  for (const key of ['NativeData', 'NativeMediaType', 'NativeTopParentId']) {
    assert.equal(cloned[key], source[key]); assert.equal(Object.keys(cloned).includes(key), false);
  }

  const target = own(newNativeItemEntity(byName.Folder)), identity = target;
  Object.defineProperty(target, 'NativeData', { value: 'old', enumerable: false, writable: true, configurable: true });
  target.StaleRuntimeField = 'remove me';
  assert.equal(copyNativeItemState(target, source), identity);
  assert.deepEqual([target.Id, target.Tags, target.LinkedChildrenLoaded, target.NativeData],
    [source.Id, ['source'], true, '{"IsRoot":false}']);
  assert.equal(Object.hasOwn(target, 'StaleRuntimeField'), false);
  assert.throws(() => copyNativeItemState(target, newNativeItemEntity(byName.Video)), /matching exact native types/u);

  const fresh = newNativeItemEntity(byName.Folder), freshClone = cloneNativeItemEntity(fresh);
  assert.equal(freshClone.LinkedChildrenLoaded, false);
  assert.equal(freshClone.LinkedChildren,EMPTY_NATIVE_LINKS);


  const aggregate = newNativeItemEntity(byName.AggregateFolder);
  aggregate.VirtualChildren.push(newNativeItemEntity(byName.Video));
  const aggregateClone = cloneNativeItemEntity(aggregate);
  assert.notEqual(aggregateClone.VirtualChildren, aggregate.VirtualChildren);
  assert.equal(isNativeItemEntity(aggregateClone.VirtualChildren[0]), true);
  assert.notEqual(aggregateClone.VirtualChildren[0], aggregate.VirtualChildren[0]);
});

test('ephemeral Artist state preserves mutable values, cold getters and date kind across binary storage', async () => {
  const source = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.MusicArtist');
  source.Name = 'The Artist'; source.DateLastSaved = '2026-10-02T00:00:00.0000000Z';
  source.RunTimeTicks = 9007199254740993n; source.ProviderIds.Custom = 'kept';
  setNativeItemJsonDateState(source, 'DateLastSaved', { value: source.DateLastSaved, kind: 'Unspecified', text: '2026-10-02T00:00:00' });
  Object.defineProperty(source, 'NativeCleanName', { value: 'stored old name', enumerable: false });
  const captured = deserialize(serialize(await captureNativeItemState(source)));
  source.Name = 'Changed'; source.ProviderIds.Custom = 'changed';
  const restored = await restoreNativeItemState(captured);
  assert.equal(isNativeItemEntity(restored), true);
  assert.deepEqual([restored.Name, restored.RunTimeTicks, restored.LinkedChildrenLoaded, restored.ProviderIds.Custom],
    ['The Artist', 9007199254740993n, false, 'kept']);
  assert.equal(restored.NativeCleanName, 'stored old name');
  assert.equal(Object.keys(restored).includes('NativeCleanName'), false);
  assert.deepEqual(nativeItemJsonDateState(restored, 'DateLastSaved'), captured.date.json);
  restored.DateLastSaved = MIN_DATE;
  assert.equal(nativeItemJsonDateState(restored, 'DateLastSaved'), null);
  assert.equal(restored.DateLastSaved, MIN_DATE);
  restored.ParentId = '95500000-0000-0000-0005-000000000002';
  assert.deepEqual([restored.IsAccessedByName, restored.IsFolder], [false, true]);
  restored.Name = 'New name'; assert.equal(restored.SortName, 'new name');
});

test('Video source type reads the current recording association for this exact entity and clone', () => {
  const source = newNativeItemEntity(byName.Video), channel = '95500000-0000-0000-0005-000000000009';
  source.ChannelId = channel; source.Path = 'Z:\\Recording\\source.mkv';
  const active = new WeakSet(); let observed;
  bindNativeItemRecordingAccess(source, candidate => { observed = candidate; return active.has(candidate); });
  assert.equal(source.SourceType, 'Channel'); assert.equal(observed, source);
  active.add(source); assert.equal(source.SourceType, 'LiveTV');
  const clone = cloneNativeItemEntity(source);
  assert.equal(clone.SourceType, 'Channel'); assert.equal(observed, clone);
  assert.equal(clone.UnratedType, 'ChannelContent'); assert.equal(source.UnratedType, 'Other');
  assert.throws(() => { clone.SourceType = 'Library'; }, TypeError);
  assert.throws(() => { clone.UnratedType = 'Movie'; }, TypeError);
  const target = newNativeItemEntity(byName.Video);
  copyNativeItemState(target, source);
  assert.equal(target.SourceType, 'Channel'); assert.equal(observed, target);
  assert.equal(target.UnratedType, 'ChannelContent');
  active.add(target); copyNativeItemState(target, clone);
  assert.equal(target.SourceType, 'LiveTV'); assert.equal(observed, target);
  assert.equal(target.UnratedType, 'Other'); assert.equal(clone.UnratedType, 'ChannelContent');
  active.add(clone); assert.equal(clone.SourceType, 'LiveTV');
  active.delete(source); assert.equal(source.SourceType, 'Channel');
  source.ChannelId = EMPTY_ID; assert.equal(source.SourceType, 'Library');
  active.add(source); assert.equal(source.SourceType, 'LiveTV');
  assert.equal(source.EnableMediaSourceDisplay, true, 'An active Video never performs the empty ChannelId getter lookup.');
  const audio = newNativeItemEntity(byName.Audio); audio.ChannelId = channel;
  bindNativeItemRecordingAccess(audio, () => { throw new Error('BaseItem does not query Video recording association.'); });
  assert.equal(audio.SourceType, 'Channel');
});

test('hydration accepts branded map results, ignores raw search columns and applies complete relations', () => {
  const stored = newNativeItemEntity(byName.Folder);
  stored.Id = '95500000-0000-0000-0005-000000000001';
  stored.DateLastMediaAdded = null;
  Object.defineProperty(stored, 'NativeData', { value: '{"IsRoot":false}', enumerable: false,
    writable: true, configurable: true });
  const hydrated = hydrateNativeItemEntity(stored, { linkedChildren: EMPTY_NATIVE_LINKS, lockedFields: [], images: [], userData: [] });
  assert.notEqual(hydrated, stored);
  assert.equal(hydrated.LinkedChildrenLoaded, true);
  assert.equal(hydrated.DateLastMediaAdded, MIN_DATE);
  assert.equal(hydrated.NativeData, stored.NativeData);

  const raw = {};
  Object.defineProperties(raw, {
    NativeType: { value: byName.Video, enumerable: true }, Type: { value: 'Folder', enumerable: true },
    IsFolder: { value: true, enumerable: true }, MediaType: { value: 'Audio', enumerable: true },
    SourceType: { value: 'Channel', enumerable: true }, UnratedType: { value: 'Movie', enumerable: true },
    NativeMediaType: { value: 'Audio', enumerable: false, writable: true, configurable: true },
  });
  raw.ChannelId = EMPTY_ID; raw.Height = 720; raw.DateLastRefreshed = null;
  const live = hydrateNativeItemEntity(raw, { videoLinks: [
    { ItemId: '95500000-0000-0000-0005-000000000002', Type: 2 },
    { ItemId: '95500000-0000-0000-0005-000000000003', Type: 3 },
  ] });
  assert.deepEqual([live.Type, live.IsFolder, live.MediaType, live.SourceType, live.UnratedType, live.IsHD],
    ['Video', false, 'Video', 'Library', 'Other', true]);
  assert.deepEqual(live.LinkedAlternateVersions, [{ ItemId: '95500000-0000-0000-0005-000000000003', Type: 3 }]);
  assert.equal(live.DateLastRefreshed, MIN_DATE);
  assert.equal(live.NativeMediaType, 'Audio');
});

async function relationsFixture(t){const schema='native_entity_'+randomUUID().replaceAll('-','').slice(0,20),database=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true,max:1}),links=new PostgresLinkedChildrenStore({database}),items=new Set();await links.initialize();t.after(async()=>{for(const item of items)releaseNativeItemLinks(item);await links.flushReleases();await links.close();await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`);await database.close();});return {links,own:item=>{items.add(item);return item;}};}
async function linkRows(links,item){const rows=[];for await(const page of links.pages(item.LinkedChildren))rows.push(...page);return rows;}
