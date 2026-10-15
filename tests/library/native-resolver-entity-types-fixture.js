import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { createResolvedItemEntity } from '../../src/library/resolved-item-entity.js';
import { applyNativeItemValues } from '../../src/library/native-item-entity.js';
import { cleanValue, dateText, EMPTY_ID, guid, idKey, nonemptyId } from '../../src/library/records.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

export const nativeTypes = Object.freeze({
  Folder: 'MediaBrowser.Controller.Entities.Folder',
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Video: 'MediaBrowser.Controller.Entities.Video',
  Trailer: 'MediaBrowser.Controller.Entities.Trailer',
  MusicVideo: 'MediaBrowser.Controller.Entities.MusicVideo',
  Series: 'MediaBrowser.Controller.Entities.TV.Series',
  Season: 'MediaBrowser.Controller.Entities.TV.Season',
  Episode: 'MediaBrowser.Controller.Entities.TV.Episode',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
  AudioBook: 'MediaBrowser.Controller.Entities.AudioBook',
  MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
  MusicArtist: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
  Book: 'MediaBrowser.Controller.Entities.Book',
  Photo: 'MediaBrowser.Controller.Entities.Photo',
  PhotoAlbum: 'MediaBrowser.Controller.Entities.PhotoAlbum',
});

export const controlIds = Object.freeze({
  root: '94000000-0000-0000-0000-000000000001',
  series: '94000000-0000-0000-0000-000000000002',
  season: '94000000-0000-0000-0000-000000000003',
  artist: '94000000-0000-0000-0000-000000000004',
  album: '94000000-0000-0000-0000-000000000005',
  linked: '94000000-0000-0000-0000-000000000006',
});

const videoTypes = new Set(['Movie', 'Video', 'Trailer', 'MusicVideo', 'Episode']);
const folderTypes = new Set(['Folder', 'Series', 'Season', 'MusicAlbum', 'PhotoAlbum']);
const artistTypes = new Set(['MusicVideo', 'Audio', 'AudioBook', 'MusicAlbum']);
const albumArtistTypes = new Set(['Audio', 'AudioBook', 'MusicAlbum']);
const sourceSerializedTypes = new Set(['Season', 'AudioBook', 'MusicAlbum', 'MusicArtist', 'Book', 'PhotoAlbum']);
const audioTypes = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];
const imageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
const trailerTypes = { 1: 'ComingSoonToTheaters', 2: 'ComingSoonToDvd', 3: 'ComingSoonToStreaming', 4: 'Archive', 5: 'LocalTrailer' };
const linkedChildTypes = { 0: 'Manual', 1: 'Shortcut', 2: 'LocalAlternateVersion', 3: 'LinkedAlternateVersion' };
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const integer = value => typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
const cloneList = value => value == null ? value : [...value];
const enumName = (value, names) => typeof value === 'number' ? names[value] ?? String(value) : value?.toString();
const fixedDate = (hour, minute, second, index) => `2026-10-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(index).padStart(7, '0')}Z`;
const subjectId = index => `93000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const parentId = kind => kind === 'none' ? EMPTY_ID : controlIds[kind === 'root' ? 'root' : kind];
const mediaType = type => ['Audio', 'AudioBook'].includes(type) ? 'Audio' : type === 'Book' ? 'Book'
  : type === 'Photo' ? 'Photo' : videoTypes.has(type) ? 'Video' : 'Unknown';
const unratedType = type => ({ Movie: 'Movie', Trailer: 'Trailer', MusicVideo: 'Music', Series: 'Series', Season: 'Series',
  Episode: 'Series', Audio: 'Music', AudioBook: 'Book', MusicAlbum: 'Music', MusicArtist: 'Music', Book: 'Book' })[type] ?? 'Other';
const isFolder = (type, kind) => type === 'MusicArtist' ? kind !== 'none' : folderTypes.has(type);
const itemPath = (root, type) => path.join(root,
  videoTypes.has(type) || ['Audio', 'AudioBook', 'Book', 'Photo'].includes(type) ? `${type}.media` : type);

export const itemRequiresJson = type => !sourceSerializedTypes.has(type);

export function buildResolvedEntity(sample, index, root) {
  const type = sample.type;
  const Id = subjectId(index);
  const ParentId = parentId(sample.parentKind);
  const Path = itemPath(root, type);
  const parent = sample.parentKind === 'none' ? null : {
    Id: ParentId,
    Type: sample.parentKind === 'series' ? 'Series' : sample.parentKind === 'season' ? 'Season'
      : sample.parentKind === 'artist' ? 'MusicArtist' : sample.parentKind === 'album' ? 'MusicAlbum' : 'Folder',
    Name: sample.parentKind === 'series' ? 'Parent series' : sample.parentKind === 'season' ? 'Season 02'
      : sample.parentKind === 'artist' ? 'Parent artist' : sample.parentKind === 'album' ? 'Parent album' : 'Physical root',
  };
  const parents = sample.parentKind === 'season' ? [{ Id: controlIds.series, Type: 'Series', Name: 'Parent series' }] : [];
  const item = createResolvedItemEntity({
    Id,
    nativeType: nativeTypes[type],
    identityPath: Path,
    entry: {
      kind: isFolder(type, sample.parentKind) ? 'directory' : 'file',
      name: path.basename(Path),
      created: fixedDate(1, 2, 3, index),
      modified: fixedDate(2, 3, 4, index),
      size: 4096 + index,
    },
    draft: {
      Name: `Resolved ${type}`,
      IsFolder: isFolder(type, sample.parentKind),
      MediaType: mediaType(type),
      SourceType: 'Library',
      columns: {},
      initialColumns: {},
      data: {},
    },
  }, {
    parent,
    parents,
    metadataConfiguration: { UseFileCreationTimeForDateAdded: true },
    clock: () => new Date('2026-10-07T00:00:00.000Z'),
  });

  applyNativeItemValues(item, {
    Id,
    ParentId,
    Name: `Resolved ${type}`,
    Path,
    DateCreated: fixedDate(1, 2, 3, index),
    DateModified: fixedDate(2, 3, 4, index),
    DateLastSaved: fixedDate(3, 4, 5, index),
    DateLastRefreshed: fixedDate(4, 5, 6, index),
    PresentationUniqueKey: `resolver-key-${type.toLowerCase()}`,
    ProductionYear: 2026,
    Size: 4096 + index,
    RunTimeTicks: 10000000 * index,
    Width: 1920,
    Height: 1080,
    IsShortcut: false,
    IsLocked: true,
    LockedFields: ['Name'],
    Genres: ['Resolver Genre'],
    Studios: ['Resolver Studio'],
    Tags: ['Resolver Tag'],
    ProductionLocations: ['Resolver Location'],
    ProviderIds: { ResolverOracle: type },
    RemoteTrailers: [{ Url: `https://resolver.invalid/${type.toLowerCase()}`, Name: 'Resolver trailer' }],
    ImageInfos: [{
      Path: path.join(root, `${type}-primary.jpg`),
      Type: 'Primary',
      DateModified: fixedDate(5, 6, 7, index),
      Width: 640,
      Height: 360,
      BlurHash: `resolver-blur-${type.toLowerCase()}`,
    }],
  });
  if (videoTypes.has(type)) applyNativeItemValues(item, {
    AdditionalParts: [path.join(root, `${type}-part2.media`)],
    LocalAlternateVersions: [path.join(root, `${type}-alternate.media`)],
    LinkedAlternateVersions: [{ ItemId: controlIds.linked, Type: 'LinkedAlternateVersion' }],
    SubtitleFiles: [path.join(root, `${type}.eng.srt`)],
    AudioFiles: [path.join(root, `${type}.commentary.mka`)],
    HasSubtitles: false,
    IsPlaceHolder: false,
    VideoType: 'VideoFile',
  });
  if (type === 'Trailer') item.TrailerTypes = ['LocalTrailer', 'Archive'];
  if (type === 'Series') item.AirDays = ['Monday', 'Wednesday'];
  if (type === 'Season') applyNativeItemValues(item, {
    SeriesId: controlIds.series,
    SeriesName: 'Parent series',
    IndexNumber: 2,
  });
  if (type === 'Episode') applyNativeItemValues(item, {
    SeriesId: controlIds.series,
    SeriesName: 'Parent series',
    SeasonId: controlIds.season,
    SeasonName: 'Season 02',
    IndexNumber: 3,
    ParentIndexNumber: 2,
  });
  if (artistTypes.has(type)) item.Artists = ['Resolver Artist'];
  if (albumArtistTypes.has(type)) item.AlbumArtists = ['Resolver Album Artist'];
  if (['Audio', 'AudioBook'].includes(type)) applyNativeItemValues(item, {
    Album: 'Parent album',
    IsInMixedFolder: true,
    LyricFiles: [path.join(root, `${type}.lrc`)],
  });
  return item;
}

function folderData(extra = {}) {
  return { ...extra, IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0,
    DateLastSaved: '0001-01-01T00:00:00.0000000Z', RemoteTrailers: [] };
}

function videoData() {
  return { AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
    HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', IsHD: false, IsShortcut: false, Width: 0, Height: 0,
    DateLastSaved: '0001-01-01T00:00:00.0000000Z', RemoteTrailers: [] };
}

function blankRow() {
  return Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
}

async function seedControlRows(fixture, root) {
  const definitions = [
    { id: controlIds.root, type: nativeTypes.Folder, name: 'Physical root', path: path.join(root, 'library'), parentId: null,
      isFolder: true, unrated: 'Other', data: folderData() },
    { id: controlIds.series, type: nativeTypes.Series, name: 'Parent series', path: path.join(root, 'library', 'Parent series'),
      parentId: controlIds.root, isFolder: true, unrated: 'Series', data: folderData({ AirDays: [] }) },
    { id: controlIds.season, type: nativeTypes.Season, name: 'Season 02', path: path.join(root, 'library', 'Parent series', 'Season 02'),
      parentId: controlIds.series, isFolder: true, unrated: 'Series', data: null, SeriesId: controlIds.series,
      SeriesName: 'Parent series', IndexNumber: 2 },
    { id: controlIds.artist, type: nativeTypes.MusicArtist, name: 'Parent artist', path: path.join(root, 'library', 'Parent artist'),
      parentId: controlIds.root, isFolder: true, unrated: 'Music', data: null },
    { id: controlIds.album, type: nativeTypes.MusicAlbum, name: 'Parent album', path: path.join(root, 'library', 'Parent artist', 'Parent album'),
      parentId: controlIds.artist, isFolder: true, unrated: 'Music', data: null },
    { id: controlIds.linked, type: nativeTypes.Video, name: 'Linked alternate control', path: path.join(root, 'library', 'linked-alternate.media'),
      parentId: controlIds.root, isFolder: false, unrated: 'Other', mediaType: 'Video', data: videoData() },
  ];
  for (const definition of definitions) await fixture.database.insert('BaseItems', {
    ...blankRow(),
    Id: definition.id,
    Type: definition.type,
    Name: definition.name,
    CleanName: cleanValue(definition.name),
    SortName: definition.name.toLowerCase(),
    Path: definition.path,
    ParentId: definition.parentId,
    ChannelId: EMPTY_ID,
    IsFolder: definition.isFolder,
    MediaType: definition.mediaType ?? 'Unknown',
    UnratedType: definition.unrated,
    Data: definition.data == null ? null : JSON.stringify(definition.data),
    SeriesId: definition.SeriesId ?? null,
    SeriesName: definition.SeriesName ?? null,
    IndexNumber: definition.IndexNumber ?? null,
  });
}

export async function setupResolverEntityFixture(t, dialect, sample) {
  const fixture = await setupChildrenFixture(t, dialect);
  fixture.configuration.EnableCaseSensitiveItemIds = true;
  const root = path.join(fixture.stateRoot, 'native-resolver-entity-types', sample.name);
  fixture.identityMap.addPrefix({ identityRoot: root, accessRoot: `/fixture/native-resolver-entity-types/${sample.name}`,
    style: 'windows', returnAccess: 'native resolver entity type differential controls' });
  await seedControlRows(fixture, root);
  return { fixture, root };
}

function normalizePath(value, root) {
  return value == null ? value : String(value).replaceAll(root, '$STATE');
}

function rewrite(value, root) {
  if (Array.isArray(value)) return value.map(entry => rewrite(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, root)]));
  return typeof value === 'string' ? normalizePath(value, root) : integer(value);
}

function normalizeDataText(value, root) {
  if (value == null) return null;
  const escapedRoot = JSON.stringify(root).slice(1, -1);
  return value.replaceAll(escapedRoot, '$STATE').replaceAll(root, '$STATE');
}

function projectedImage(image, root) {
  return {
    path: normalizePath(image.Path, root),
    type: enumName(image.Type, imageTypes),
    dateModified: dateText(image.DateModified),
    Width: image.Width,
    Height: image.Height,
    BlurHash: image.BlurHash,
  };
}

export function projectNativeItem(item, root) {
  const type = item.Type ?? item.NativeType?.split('.').at(-1);
  const hasVideo = videoTypes.has(type);
  const hasFolder = folderTypes.has(type) || type === 'MusicArtist';
  const hasSeries = type === 'Season' || type === 'Episode' || type === 'AudioBook' || type === 'Book';
  return {
    type: item.NativeType,
    id: guid(item.Id),
    parentId: guid(item.ParentId ?? EMPTY_ID),
    name: item.Name ?? null,
    path: normalizePath(item.Path, root),
    isFolder: item.IsFolder,
    isRoot: hasFolder ? item.IsRoot : null,
    dateLastMediaAdded: hasFolder
      ? item.DateLastMediaAdded == null ? null : dateText(item.DateLastMediaAdded)
      : null,
    linkedChildrenLoaded: hasFolder ? item.LinkedChildrenLoaded : null,
    mediaType: item.MediaType,
    sourceType: item.SourceType,
    unratedType: item.UnratedType,
    mixed: item.IsInMixedFolder,
    locked: item.IsLocked,
    productionYear: item.ProductionYear ?? null,
    size: integer(item.Size ?? null),
    runTimeTicks: integer(item.RunTimeTicks ?? null),
    width: item.Width,
    height: item.Height,
    dates: {
      created: dateText(item.DateCreated),
      modified: dateText(item.DateModified),
      saved: dateText(item.DateLastSaved),
      refreshed: dateText(item.DateLastRefreshed),
    },
    lists: {
      Genres: cloneList(item.Genres),
      Studios: cloneList(item.Studios),
      Tags: cloneList(item.Tags),
      ProductionLocations: cloneList(item.ProductionLocations),
      artists: artistTypes.has(type) ? cloneList(item.Artists) : null,
      albumArtists: albumArtistTypes.has(type) ? cloneList(item.AlbumArtists) : null,
      remoteTrailers: item.RemoteTrailers?.map(value => ({ Url: value.Url, Name: value.Name })) ?? null,
    },
    images: item.ImageInfos?.map(value => projectedImage(value, root)) ?? null,
    providerIds: Object.fromEntries(Object.entries(item.ProviderIds ?? {}).sort(([left], [right]) => ordinal(left.toLowerCase(), right.toLowerCase()))),
    lockedFields: item.LockedFields?.map(value => typeof value === 'number' ? value : String(value)) ?? null,
    video: !hasVideo ? null : {
      primaryVersionId: nonemptyId(item.PrimaryVersionId) ? guid(item.PrimaryVersionId) : null,
      additionalParts: item.AdditionalParts?.map(value => normalizePath(value, root)) ?? null,
      localAlternates: item.LocalAlternateVersions?.map(value => normalizePath(value, root)) ?? null,
      linkedAlternates: item.LinkedAlternateVersions?.map(value => ({
        itemId: nonemptyId(value.ItemId) ? guid(value.ItemId) : null,
        type: enumName(value.Type, linkedChildTypes),
      })) ?? null,
      subtitleFiles: item.SubtitleFiles?.map(value => normalizePath(value, root)) ?? null,
      audioFiles: item.AudioFiles?.map(value => normalizePath(value, root)) ?? null,
      videoType: item.VideoType,
      IsPlaceHolder: item.IsPlaceHolder,
      HasSubtitles: item.HasSubtitles,
    },
    trailerTypes: type === 'Trailer' ? item.TrailerTypes?.map(value => enumName(value, trailerTypes)) ?? null : null,
    airDays: type === 'Series' ? item.AirDays?.map(value => enumName(value, dayNames)) ?? null : null,
    lyricFiles: ['Audio', 'AudioBook'].includes(type)
      ? item.LyricFiles?.map(value => normalizePath(value, root)) ?? null
      : null,
    series: !hasSeries ? null : {
      seriesId: guid(item.SeriesId ?? EMPTY_ID),
      SeriesName: item.SeriesName ?? null,
      SeriesPresentationUniqueKey: item.SeriesPresentationUniqueKey ?? null,
      seasonId: type === 'Episode' ? guid(item.SeasonId ?? EMPTY_ID) : null,
      seasonName: type === 'Episode' ? item.SeasonName ?? null : null,
    },
    musicArtist: type === 'MusicArtist' ? {
      IsAccessedByName: item.IsAccessedByName ?? !nonemptyId(item.ParentId),
      IsFolder: item.IsFolder,
    } : null,
  };
}

async function projectColumns(database, row, root) {
  const columns = tableDefinition('BaseItems').columns;
  return Object.fromEntries(columns.map(column => {
    const value = row[column.name];
    if (value == null) return [column.name, null];
    if (column.name === 'Data') return [column.name, rewrite(parseLosslessJson(value), root)];
    if (column.name === 'Audio') return [column.name, audioTypes[Number(value)] ?? value];
    if (column.clrType.includes('Guid')) return [column.name, guid(value)];
    if (column.clrType.includes('DateTime')) return [column.name, dateText(value)];
    if (typeof value === 'string') return [column.name, normalizePath(value, root)];
    return [column.name, integer(value)];
  }));
}

export async function projectStored(database, id, root) {
  const [row] = await database.rows('BaseItems', { where: { Id: id } });
  const dataText = normalizeDataText(row.Data, root);
  return {
    columnCount: tableDefinition('BaseItems').columns.length,
    columns: await projectColumns(database, row, root),
    dataIsNull: row.Data == null,
    dataText,
    data: dataText == null ? null : rewrite(parseLosslessJson(row.Data), root),
  };
}

function blurHashText(value) {
  if (value == null || typeof value === 'string') return value;
  return Buffer.from(value).toString('utf8');
}

export async function projectRelations(database, id, root) {
  const ancestors = (await database.rows('AncestorIds', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId), parentItemId: guid(row.ParentItemId),
  })).sort((left, right) => ordinal(left.parentItemId, right.parentItemId));
  const providers = (await database.rows('BaseItemProviders', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId), ProviderId: row.ProviderId, ProviderValue: row.ProviderValue,
  })).sort((left, right) => ordinal(left.ProviderId, right.ProviderId));
  const rawValues = await database.rows('ItemValues');
  const values = rawValues.map(row => ({ key: `$VALUE/${Number(row.Type)}/${row.Value}`, type: Number(row.Type), value: row.Value,
    cleanValue: row.CleanValue })).sort((left, right) => left.type - right.type || ordinal(left.value, right.value));
  const valueKeys = new Map(rawValues.map(row => [idKey(row.ItemValueId), `$VALUE/${Number(row.Type)}/${row.Value}`]));
  const maps = (await database.rows('ItemValuesMap', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId), valueKey: valueKeys.get(idKey(row.ItemValueId)),
  })).sort((left, right) => ordinal(left.valueKey, right.valueKey));
  const lockedFields = (await database.rows('BaseItemMetadataFields', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId), Id: Number(row.Id),
  })).sort((left, right) => left.Id - right.Id);
  const storedTrailerTypes = (await database.rows('BaseItemTrailerTypes', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId), Id: Number(row.Id),
  })).sort((left, right) => left.Id - right.Id);
  const images = (await database.rows('BaseItemImageInfos', { where: { ItemId: id } })).map(row => ({
    itemId: guid(row.ItemId),
    path: normalizePath(row.Path, root),
    dateModified: row.DateModified == null ? null : dateText(row.DateModified),
    imageType: imageTypes[Number(row.ImageType)] ?? String(row.ImageType),
    Width: Number(row.Width),
    Height: Number(row.Height),
    blurHash: blurHashText(row.Blurhash),
  })).sort((left, right) => ordinal(left.imageType, right.imageType) || ordinal(left.path, right.path));
  const links = (await database.rows('LinkedChildren')).filter(row => idKey(row.ParentId) === idKey(id) || idKey(row.ChildId) === idKey(id))
    .map(row => ({ parentId: guid(row.ParentId), childId: guid(row.ChildId), childType: Number(row.ChildType), SortOrder: Number(row.SortOrder) }))
    .sort((left, right) => ordinal(left.parentId, right.parentId) || left.SortOrder - right.SortOrder);
  return { ancestors, providers, values, maps, lockedFields, trailerTypes: storedTrailerTypes, images, links };
}

export async function projectParentRows(database) {
  const ids = new Set(Object.values(controlIds).map(idKey));
  return (await database.rows('BaseItems')).filter(row => ids.has(idKey(row.Id))).map(row => ({
    id: guid(row.Id),
    Type: row.Type,
    parentId: row.ParentId == null ? null : guid(row.ParentId),
    IsFolder: row.IsFolder,
    dataIsNull: row.Data == null,
  })).sort((left, right) => ordinal(left.id, right.id));
}
