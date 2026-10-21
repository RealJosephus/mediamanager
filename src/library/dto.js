import path from 'node:path';
import { md5Guid, getNewItemId, lowerInvariant } from '../core/identity.js';
import { readUserData, userDataDto, supportsPlayed, removeDiacritics } from '../sessions/user-data.js';
import { loadStreams, selectDefaultTracks } from './media-streams.js';
import { withNativeNulls, withNativeFloats } from '../core/json.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim, clrTrimStart } from '../metadata/whitespace.js';
import { nativePersonIdentity, nativeItemByNameFolderName } from './identity.js';
import { projectExternalUrls } from './external-urls.js';
import { readItemImageRows } from './image-order.js';
import { readNativeImageRows } from '../database/native-relation-order.js';
import { transliterateSortName } from './transliteration.js';
import { visibleItem, visiblePerson } from './permissions.js';
import { mediaVersions, mediaSourceCount, versionChildren, commonVersionPrefix, isFileSource, sourceFileName, mediaSourceName, sortMediaSources } from './media-versions.js';
import { dtoId, extraTypeCode, idKey, mapRecord, sameId, nonemptyId, NAME_TYPES, VIDEO_TYPES, dateText, dateTicks, MIN_DATE, cleanValue, repositoryCleanName, repositoryValue, unsupported } from './records.js';
import { collectionType } from './user-view-query.js';
import { collectionFoldersForItem } from './collection-membership.js';
import { canDeleteItem, hasFileProtocol } from './delete-permission.js';
import { substitutePath } from './path-substitution.js';
import { loadPostgresRowsByIds } from './postgres-library-query.js';
import { addInheritedImages } from './dto-inherited-images.js';

export const itemFields = ['CanDelete', 'CanDownload', 'Chapters', 'Trickplay', 'ChildCount', 'CumulativeRunTimeTicks',
  'CustomRating', 'DateCreated', 'DateLastMediaAdded', 'DisplayPreferencesId', 'Etag', 'ExternalUrls', 'Genres', 'ItemCounts',
  'MediaSourceCount', 'MediaSources', 'OriginalTitle', 'Overview', 'ParentId', 'Path', 'People', 'PlayAccess',
  'ProductionLocations', 'ProductionYear', 'ProviderIds', 'PrimaryImageAspectRatio', 'RecursiveItemCount', 'Settings',
  'SortName', 'SpecialEpisodeNumbers', 'Studios', 'Taglines', 'Tags', 'RemoteTrailers', 'MediaStreams',
  'DateLastRefreshed', 'DateLastSaved', 'EnableMediaSourceDisplay', 'Width', 'Height', 'LocalTrailerCount', 'IsHD',
  'SpecialFeatureCount', 'AirTime', 'SeriesStudio', 'ChannelInfo', 'ChannelImage'];
const fieldSet = new Set(itemFields.map(field => field.toLowerCase()));
const channelNumberFormat = new Intl.NumberFormat('en-US', { useGrouping: false, minimumIntegerDigits: 10,
  minimumFractionDigits: 5, maximumFractionDigits: 5, roundingMode: 'halfExpand' });
export const itemImageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const extraType = item => extraTypes[item.ExtraType] ?? item.ExtraType;
const personKinds = ['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist', 'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator'];

function personKind(raw) {
  const text = clrTrim(raw ?? '');
  if (/^[+-]?\d+$/.test(text)) {
    const number = Number(text);
    return number >= -2147483648 && number <= 2147483647 ? personKinds[number] ?? number : 'Unknown';
  }
  let value = 0;
  for (const part of text.split(',')) {
    const index = personKinds.indexOf(clrTrim(part));
    if (index < 0) return 'Unknown';
    value |= index;
  }
  return personKinds[value] ?? value;
}

export function dtoOptions(query = {}, allFields = false) {
  const requested = query.fields ?? (allFields ? itemFields : []);
  for (const field of requested) if (!fieldSet.has(field.toLowerCase())) unsupported(`Item field '${field}' is not implemented.`);
  return { fields: new Set(requested.map(field => field.toLowerCase())), enableImages: query.enableimages !== false, enableUserData: query.enableuserdata !== false, imageTypeLimit: query.imagetypelimit ?? 2147483647, imageTypes: query.enableimagetypes ?? itemImageTypes, addCurrentProgram: query.addcurrentprogram !== false };
}

const nativeDigit = /\p{Nd}/u;

function padSortDigitChunks(value) {
  if (!value.length) return value;
  const chunks = [];
  let start = 0;
  let isDigit = nativeDigit.test(value[0]);
  for (let index = 1; index < value.length; index++) {
    // BaseItem.ModifySortChunks calls char.IsDigit on each UTF-16 code unit.
    const nextIsDigit = nativeDigit.test(value[index]);
    if (nextIsDigit === isDigit) continue;
    const chunk = value.slice(start, index);
    chunks.push(isDigit && chunk.length < 10 ? chunk.padStart(10, '0') : chunk);
    start = index;
    isDigit = nextIsDigit;
  }
  const chunk = value.slice(start);
  chunks.push(isDigit && chunk.length < 10 ? chunk.padStart(10, '0') : chunk);
  return chunks.join('');
}

export function sortName(item, { configuration = {} } = {}) {
  const type = String(item.Type ?? '').split('.').at(-1);
  const numbered = (value, width) => value == null ? ''
    : `${value < 0 ? '-' : ''}${String(Math.abs(value)).padStart(width, '0')}`;
  if (type === 'LiveTvChannel' && !item.ForcedSortName) {
    const text = (item.Number ?? '').replace(/\0+$/u, '').replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/gu, '');
    const special = clrTrim(item.Number ?? '');
    const number = /^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)
      ? Number(text.replaceAll(',', '')) : /^[+-]?(?:NaN|Infinity)$/iu.test(special)
        ? /nan/iu.test(special) ? NaN : special.startsWith('-') ? -Infinity : Infinity : undefined;
    const prefix = number === undefined ? item.Number ?? '' : !Number.isFinite(number) ? String(number)
      : channelNumberFormat.format(Object.is(number, -0) ? '-0' : number.toPrecision(15));
    return prefix + '-' + (item.Name ?? '');
  }
  if (type === 'Season' && !item.ForcedSortName) return item.IndexNumber == null ? item.Name : numbered(item.IndexNumber, 4);
  if (type === 'Episode' && !item.ForcedSortName) return (item.ParentIndexNumber == null ? '' : numbered(item.ParentIndexNumber, 3) + ' - ')
    + (item.IndexNumber == null ? '' : numbered(item.IndexNumber, 4) + ' - ') + (item.Name ?? '');
  if (['Audio', 'AudioBook'].includes(type) && !item.ForcedSortName) {
    // Audio.CreateSortName preserves the title and prepends disc/track numbers.
    // An explicit ForcedSortName still uses BaseItem's common normalization.
    return (item.ParentIndexNumber == null ? '' : numbered(item.ParentIndexNumber, 4) + ' - ')
      + (item.IndexNumber == null ? '' : numbered(item.IndexNumber, 4) + ' - ') + (item.Name ?? '');
  }
  if (String(item.Type ?? '').split('.').at(-1) === 'Person') {
    const name = item.ForcedSortName || item.Name;
    return name == null ? null : clrTrimStart(String(name));
  }
  const source = item.ForcedSortName || item.Name;
  if (source == null || source === '') return source ?? null;
  let value = lowerInvariant(clrTrim(source));
  for (const word of configuration.SortRemoveWords ?? ['the', 'a', 'an']) {
    if (value.startsWith(`${word} `)) value = value.slice(word.length + 1);
    value = value.replaceAll(` ${word} `, ' ');
    if (value.endsWith(` ${word}`)) value = value.slice(0, -(word.length + 1));
  }
  for (const character of configuration.SortRemoveCharacters ?? [',', '&', '-', '{', '}', "'"]) value = value.replaceAll(character, '');
  for (const character of configuration.SortReplaceCharacters ?? ['.', '+', '%']) value = value.replaceAll(character, ' ');
  value = removeDiacritics(padSortDigitChunks(value));
  return /[^\x00-\x7f]/.test(value) ? transliterateSortName(value) : value;
}

function byNameId(state, options, kind, name) {
  const existing = kind === 'MusicArtist' && state.items.find(item => item.Type === kind && item.Name === name);
  if (existing) return dtoId(existing.Id);
  if (kind === 'Person') return dtoId(nativePersonIdentity(name, options).Id);
  const programDataPath = options.programDataPath;
  if (!programDataPath) unsupported(`The native program data path is required to derive ${kind} IDs.`);
  const valid = nativeItemByNameFolderName(name);
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(programDataPath) ? path.win32 : path.posix;
  const metadataPath = options.metadataPath ?? pathApi.join(programDataPath, 'metadata');
  const folder = pathApi.join(metadataPath, kind === 'MusicArtist' ? 'artists' : kind, valid);
  const namespace = ['MusicGenre', 'MusicArtist'].includes(kind) ? 'Audio.' : '';
  return getNewItemId(folder, `MediaBrowser.Controller.Entities.${namespace}${kind}`, { programDataPath, enableCaseSensitiveItemIds: options.configuration?.EnableCaseSensitiveItemIds, forceCaseInsensitive: options.configuration?.EnableNormalizedItemByNameIds ?? true });
}

function relationMap(state, name) {
  state.dtoRelations ??= {};
  state.dtoRelations[name] ??= new Map();
  return state.dtoRelations[name];
}

async function relationRows(state, item, name, table) {
  const rowsByItem = relationMap(state, name), key = idKey(item.Id);
  if (rowsByItem.has(key)) return rowsByItem.get(key);
  const rows = await state.db.rows(table, { where: { ItemId: item.Id } });
  rowsByItem.set(key, rows);
  return rows;
}

async function itemImageRows(state, item) {
  const rowsByItem = relationMap(state, 'imageRowsByItem'), key = idKey(item.Id);
  if (rowsByItem.has(key)) return rowsByItem.get(key);
  const rows = await readItemImageRows(state.db, item.Id);
  rowsByItem.set(key, rows);
  return rows;
}

async function itemStreamRows(state, item) {
  return relationRows(state, item, 'streamRowsByItem', 'MediaStreamInfos');
}

async function projectedStreams(state, item, options) {
  return loadStreams(state.db, item, options, await itemStreamRows(state, item));
}

function uniqueItems(items) {
  return [...new Map(items.filter(item => item?.Id).map(item => [idKey(item.Id), item])).values()];
}

async function prefetchRelationRows(state, name, table, ids, orderBy) {
  const rowsByItem = relationMap(state, name);
  const missing = [...new Map(ids.filter(nonemptyId).map(id => [idKey(id), id]))]
    .filter(([key]) => !rowsByItem.has(key));
  if (!missing.length) return rowsByItem;
  for (const [key] of missing) rowsByItem.set(key, []);
  const rows = await state.db.rows(table, {
    whereIn: { ItemId: missing.map(([, id]) => id) },
    ...(orderBy ? { orderBy } : {}),
  });
  for (const row of rows) rowsByItem.get(idKey(row.ItemId))?.push(row);
  return rowsByItem;
}

async function prefetchImageRows(state, items) {
  const unique = uniqueItems(items), rowsByItem = relationMap(state, 'imageRowsByItem');
  const missing = unique.filter(item => !rowsByItem.has(idKey(item.Id)));
  if (!missing.length) return;
  for (const item of missing) rowsByItem.set(idKey(item.Id), []);
  for (const row of await readNativeImageRows(state.db, missing.map(item => item.Id))) {
    rowsByItem.get(idKey(row.ItemId)).push(row);
  }
}

/** Load every DTO relation for a PostgreSQL result page in bounded batches. */
export async function prefetchPostgresDtoRelations(items, state, user, selected, options) {
  if (!items.length) return;
  const projected = uniqueItems(items), fields = selected.fields;
  const mediaOwners = projected.filter(item => VIDEO_TYPES.has(item.Type) || ['Audio', 'AudioBook'].includes(item.Type));
  const sourceItems = uniqueItems(mediaOwners.flatMap(item => mediaVersions(item, state).map(entry => entry.item)));

  const streamItems = uniqueItems([
    ...projected.filter(item => ['Audio', 'AudioBook'].includes(item.Type)),
    ...(fields.has('mediasources') ? sourceItems : fields.has('mediastreams') ? mediaOwners : []),
  ]);
  if (streamItems.length) await prefetchRelationRows(state, 'streamRowsByItem', 'MediaStreamInfos',
    streamItems.map(item => item.Id), [{ column: 'ItemId' }, { column: 'StreamIndex' }]);
  if (fields.has('mediasources') && sourceItems.length) {
    const sourceIds = sourceItems.map(item => item.Id);
    await prefetchRelationRows(state, 'attachmentRowsByItem', 'AttachmentStreamInfos', sourceIds,
      [{ column: 'ItemId' }, { column: 'Index' }]);
    await prefetchRelationRows(state, 'segmentRowsByItem', 'MediaSegments', sourceIds,
      [{ column: 'ItemId' }, { column: 'Id' }]);
  }
  if (fields.has('trickplay')) await prefetchRelationRows(state, 'trickplayRowsByItem', 'TrickplayInfos',
    projected.filter(item => VIDEO_TYPES.has(item.Type)).map(item => item.Id),
    [{ column: 'ItemId' }, { column: 'Width' }]);
  if (fields.has('chapters')) await prefetchRelationRows(state, 'chapterRowsByItem', 'Chapters',
    projected.map(item => item.Id), [{ column: 'ItemId' }, { column: 'ChapterIndex' }]);
  if (fields.has('settings')) await prefetchRelationRows(state, 'metadataFieldRowsByItem', 'BaseItemMetadataFields',
    projected.map(item => item.Id), [{ column: 'ItemId' }, { column: 'Id' }]);

  const imageItems = [];
  if (selected.enableImages || fields.has('primaryimageaspectratio')) imageItems.push(...projected);
  if (fields.has('channelimage')) imageItems.push(...projected.filter(item => item.Type === 'LiveTvProgram')
    .map(item => state.byId.get(idKey(item.ChannelId))).filter(item => item?.Type === 'LiveTvChannel'));
  for (const item of projected.filter(item => ['Audio', 'AudioBook'].includes(item.Type))) {
    let parent = state.byId.get(idKey(item.ParentId));
    const visited = new Set([idKey(item.Id)]);
    while (parent && parent.Type !== 'MusicAlbum' && !visited.has(idKey(parent.Id))) {
      visited.add(idKey(parent.Id));
      parent = state.byId.get(idKey(parent.ParentId));
    }
    if (parent?.Type === 'MusicAlbum') imageItems.push(parent);
  }

  if (fields.has('people')) {
    const peopleLinksByItem = await prefetchRelationRows(state, 'peopleLinksByItem', 'PeopleBaseItemMap',
      projected.map(item => item.Id), [{ column: 'ItemId' }, { column: 'ListOrder' }, { column: 'PeopleId' }, { column: 'Role' }]);
    const peopleById = relationMap(state, 'peopleById');
    const peopleIds = [...new Map(projected.flatMap(item => peopleLinksByItem.get(idKey(item.Id)) ?? [])
      .map(link => [idKey(link.PeopleId), link.PeopleId])).values()];
    const missingPeopleIds = peopleIds.filter(id => !peopleById.has(idKey(id)));
    if (missingPeopleIds.length) for (const person of await state.db.rows('Peoples', {
      whereIn: { Id: missingPeopleIds }, orderBy: [{ column: 'Id' }],
    })) peopleById.set(idKey(person.Id), person);

    const identityIds = [...new Map(peopleIds.map(id => peopleById.get(idKey(id)))
      .filter(Boolean).map(person => {
        const identity = byNameId(state, options, 'Person', person.Name);
        return [idKey(identity), identity];
      })).values()];
    const missingIdentityIds = identityIds.filter(id => !state.byId.has(idKey(id)));
    for (const row of await loadPostgresRowsByIds(state.db, missingIdentityIds)) {
      const entity = mapRecord(row);
      if (!entity) continue;
      entity.Path = options.expandPath?.(entity.Path) ?? entity.Path;
      state.items.push(entity);
      state.byId.set(idKey(entity.Id), entity);
    }
    imageItems.push(...identityIds.map(id => state.byId.get(idKey(id))).filter(Boolean));
  }
  await prefetchImageRows(state, imageItems);
}

async function imageTagAndHash(dto, item, state) {
  const primary = (await itemImageRows(state, item)).find(row => row.ImageType === 0);
  if (!primary) return undefined;
  const tag = md5Guid(`${item.Path ?? ''}${dateTicks(primary.DateModified)}`);
  if (primary.Blurhash?.length) {
    dto.ImageBlurHashes ??= new Map();
    if (!dto.ImageBlurHashes.has('Primary')) dto.ImageBlurHashes.set('Primary', new Map());
    dto.ImageBlurHashes.get('Primary').set(tag, Buffer.from(primary.Blurhash).toString('utf8'));
  }
  return tag;
}

async function projectPeople(item, state, user, options) {
  const rows = await relationRows(state, item, 'peopleLinksByItem', 'PeopleBaseItemMap');
  const people = relationMap(state, 'peopleById');
  const missingPeopleIds = [...new Map(rows.filter(row => !people.has(idKey(row.PeopleId)))
    .map(row => [idKey(row.PeopleId), row.PeopleId])).values()];
  if (missingPeopleIds.length) for (const person of await state.db.rows('Peoples', {
    whereIn: { Id: missingPeopleIds }, orderBy: [{ column: 'Id' }],
  })) people.set(idKey(person.Id), person);
  const ranks = [['Actor', 0], ['GuestStar', 1], ['Director', 2], ['Writer', 3], ['Producer', 4], ['Composer', 4]];
  const rank = person => ranks.find(([type]) => person.Type === type || person.Role != null && ordinalIgnoreCaseKey(person.Role) === ordinalIgnoreCaseKey(type))?.[1] ?? 10;
  const credits = [...rows].sort((a, b) => a.ListOrder - b.ListOrder).map(row => {
    const person = people.get(idKey(row.PeopleId));
    if (!person) throw new Error('Missing person relation.');
    return { Name: person.Name, Role: row.Role, Type: personKind(person.PersonType), SortOrder: row.SortOrder };
  }).sort((a, b) => (a.SortOrder ?? 2147483647) - (b.SortOrder ?? 2147483647) || rank(a) - rank(b));
  const requiredIds = [...new Map(credits.map(credit => {
    const personId = byNameId(state, options, 'Person', credit.Name);
    return [idKey(personId), personId];
  }).filter(([key]) => !state.byId.has(key))).values()];
  for (const row of await loadPostgresRowsByIds(state.db, requiredIds)) {
    const entity = mapRecord(row);
    if (!entity) continue;
    entity.Path = options.expandPath?.(entity.Path) ?? entity.Path;
    state.items.push(entity);
    state.byId.set(idKey(entity.Id), entity);
  }
  const checked = new Set(), entities = new Map();
  for (const credit of credits) {
    const key = ordinalIgnoreCaseKey(credit.Name);
    if (checked.has(key)) continue;
    checked.add(key);
    // The pinned GetPerson implementation only returns an existing path-derived ID.
    const entity = state.byId.get(byNameId(state, options, 'Person', credit.Name));
    if (entity?.Type !== 'Person' || !visiblePerson(entity, user, state, options)) continue;
    const entityKey = ordinalIgnoreCaseKey(entity.Name);
    if (!entities.has(entityKey)) entities.set(entityKey, entity);
  }
  const result = [], imageDto = {};
  for (const credit of credits) {
    const entity = entities.get(ordinalIgnoreCaseKey(credit.Name));
    if (!entity) continue;
    const person = { Name: credit.Name, Id: dtoId(entity.Id), Role: credit.Role, Type: credit.Type,
      PrimaryImageTag: await imageTagAndHash(imageDto, entity, state) };
    if (imageDto.ImageBlurHashes) person.ImageBlurHashes = new Map([...imageDto.ImageBlurHashes].map(([type, hashes]) =>
      [type, new Map([...hashes].filter(([tag]) => tag === person.PrimaryImageTag))]));
    result.push(person);
  }
  return result;
}

async function mediaSource(item, queriedItem, type, prefix, state, user, options, enablePathSubstitution) {
  if (item.SourceType === 'Channel') unsupported('Channel media source projection is not implemented.');
  const protocol = isFileSource(item) ? 'File' : /^https?:/i.test(item.Path ?? '') ? 'Http' : null;
  if (!protocol) unsupported('This media source protocol is not implemented.');
  let shortcutProtocol;
  if (VIDEO_TYPES.has(item.Type) && item.IsShortcut && item.ShortcutPath) {
    if (/^https?:/i.test(item.ShortcutPath)) shortcutProtocol = 'Http';
    else if (/^rtsp:/i.test(item.ShortcutPath)) shortcutProtocol = 'Rtsp';
    else if (/^rtp:/i.test(item.ShortcutPath)) shortcutProtocol = 'Rtp';
    else if (!isFileSource({ Path: item.ShortcutPath })) unsupported('This shortcut media source protocol is not implemented.');
  }
  const remoteShortcut = shortcutProtocol != null;
  const sourceProtocol = shortcutProtocol ?? protocol;
  const sourcePath = remoteShortcut ? item.ShortcutPath : enablePathSubstitution && protocol === 'File'
    ? substitutePath(item.Path, options.configuration?.PathSubstitutions) : item.Path;
  const attachments = (await relationRows(state, item, 'attachmentRowsByItem', 'AttachmentStreamInfos'))
    .map(({ ItemId, ...entry }) => entry);
  const container = item.Container || (protocol === 'File' && item.Path ? path.win32.extname(item.Path).slice(1) : undefined);
  const name = mediaSourceName(item, queriedItem, state, prefix);
  const source = {
    Protocol: sourceProtocol, Id: dtoId(item.Id), Path: sourcePath, Type: item.Path ? type : 'Placeholder', Container: container,
    Size: item.Size, Name: name, IsRemote: remoteShortcut, ETag: protocol === 'File' ? md5Guid(String(dateTicks(item.DateModified))) : undefined,
    RunTimeTicks: item.RunTimeTicks, ReadAtNativeFramerate: false, IgnoreDts: false, IgnoreIndex: false, GenPtsInput: false,
    // Static sources declare native user permission, not negotiated encoder
    // capability. PlaybackInfo with a device profile applies the copy-only gates.
    SupportsTranscoding: user && item.MediaType === 'Audio' ? user.Policy.EnableAudioPlaybackTranscoding === true
      : user && item.MediaType === 'Video' ? user.Policy.EnableVideoPlaybackTranscoding === true : true,
    SupportsDirectStream: user && VIDEO_TYPES.has(item.Type) ? user.Policy.EnablePlaybackRemuxing === true : (!VIDEO_TYPES.has(item.Type) || !['Dvd', 'BluRay', 'Iso'].includes(item.VideoType)) && (sourceProtocol === 'File' || sourceProtocol === 'Http' && !/\.m3u/i.test(sourcePath ?? '')),
    SupportsDirectPlay: true, IsInfiniteStream: false, UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false, RequiresClosing: false, RequiresLooping: false, SupportsProbing: true,
    MediaStreams: await projectedStreams(state, item, options), MediaAttachments: attachments, Formats: [], Bitrate: item.TotalBitrate,
    RequiredHttpHeaders: new Map(), TranscodingSubProtocol: 'http', HasSegments: VIDEO_TYPES.has(item.Type) && protocol === 'File'
      && (await relationRows(state, item, 'segmentRowsByItem', 'MediaSegments')).length > 0,
  };
  if (VIDEO_TYPES.has(item.Type)) Object.assign(source, { VideoType: item.VideoType ?? 'VideoFile', IsoType: item.IsoType, Video3DFormat: item.Video3DFormat, Timestamp: item.Timestamp });
  if (source.Bitrate == null) { const bitrate = source.MediaStreams.filter(stream => !stream.IsExternal).reduce((sum, stream) => (sum + (stream.BitRate ?? 0)) | 0, 0); if (bitrate > 0) source.Bitrate = bitrate; }
  if (user) {
    const originalLanguage = queriedItem.OriginalLanguage || (queriedItem.Type === 'Episode' ? state.ancestors(queriedItem).find(parent => parent.OriginalLanguage)?.OriginalLanguage : undefined);
    selectDefaultTracks(source, queriedItem, user, state.userData?.get(idKey(queriedItem.Id)) ?? await readUserData(state.db, user.Id, queriedItem), originalLanguage);
  }
  return source;
}

export async function mediaSources(item, state, user, options, enablePathSubstitution = false) {
  if (item.Type === 'LiveTvChannel') {
    const protocol = ['Rtsp', 'Rtmp', 'Http', 'Rtp', 'Ftp', 'Udp'].find(value =>
      (item.Path ?? '').slice(0, value.length).toLowerCase() === value.toLowerCase())
      ?? (!item.Path || hasFileProtocol(item) ? 'File' : 'Http');
    const source = {
      Protocol: protocol, Id: dtoId(item.Id), Path: item.Path, Type: 'Placeholder', Name: item.Name,
      RunTimeTicks: item.RunTimeTicks, IsRemote: false, ReadAtNativeFramerate: false, IgnoreDts: false, IgnoreIndex: false,
      GenPtsInput: false, SupportsTranscoding: !user || (item.MediaType === 'Audio'
        ? user.Policy.EnableAudioPlaybackTranscoding : user.Policy.EnableVideoPlaybackTranscoding) === true,
      SupportsDirectStream: !user || item.MediaType !== 'Video' || user.Policy.EnablePlaybackRemuxing === true,
      SupportsDirectPlay: true, IsInfiniteStream: item.RunTimeTicks == null, UseMostCompatibleTranscodingProfile: false,
      RequiresOpening: false, RequiresClosing: false, RequiresLooping: false, SupportsProbing: true,
      MediaStreams: [], MediaAttachments: [], Formats: [], RequiredHttpHeaders: new Map(), TranscodingSubProtocol: 'http', HasSegments: false,
    };
    if (user) selectDefaultTracks(source, item, user, state.userData?.get(idKey(item.Id))
      ?? await readUserData(state.db, user.Id, item), item.OriginalLanguage);
    return [source];
  }
  const versions = mediaVersions(item, state);
  const names = versions.map(entry => entry.item).filter(entry => isFileSource(entry) && entry.Path).map(sourceFileName);
  const prefix = names.length > 1 ? commonVersionPrefix(names) : null;
  let sources = [];
  for (const version of versions) {
    if (user && !sameId(version.item.Id, item.Id) && !visibleItem(version.item, user, state, { ...options, query: false })) continue;
    sources.push(await mediaSource(version.item, item, version.type, prefix, state, user, options, enablePathSubstitution));
  }
  sortMediaSources(sources, item.Id);
  if (user && VIDEO_TYPES.has(item.Type) && !nonemptyId(item.PrimaryVersionId) && sources.length > 1) {
    let resume;
    for (const source of sources) {
      const version = state.byId.get(idKey(source.Id));
      const data = state.userData?.get(idKey(source.Id)) ?? await readUserData(state.db, user.Id, version);
      if (data.PlaybackPositionTicks > 0n && (!resume || dateTicks(data.LastPlayedDate) > dateTicks(resume.data.LastPlayedDate))) resume = { source, data };
    }
    if (resume && sources[0] !== resume.source) sources = [resume.source, ...sources.filter(source => source !== resume.source)];
  }
  return sources;
}

const supportsUserDataFromChildren = item => {
  if (!item.IsFolder) return false;
  if (item.SupportsUserDataFromChildren !== undefined) return item.SupportsUserDataFromChildren === true;
  if (['BasePluginFolder', 'CollectionFolder', 'UserView', 'UserRootFolder', 'Channel'].includes(item.Type)) return false;
  if (item.SourceType != null && item.SourceType !== 0 && item.SourceType !== 'Library') return false;
  if (NAME_TYPES.has(item.Type)) {
    if (item.Type !== 'MusicArtist') return false;
    if (item.IsAccessedByName ?? !nonemptyId(item.ParentId)) return false;
  }
  return true;
};

const userDataLeaves = (item, state) => state.countableLeaves?.(item, {
  mergePresentationKey: !state.linkedChildrenByParent?.has(idKey(item.Id))
})
  ?? state.descendants(item).filter(entry => !entry.IsFolder && !entry.IsVirtualItem && state.visible(entry));

export async function projectUserData(item, state, user, ownData = null) {
  let dto = userDataDto(item, ownData ?? state.userData?.get(idKey(item.Id)) ?? await readUserData(state.db, user.Id, item));
  if (VIDEO_TYPES.has(item.Type) && !nonemptyId(item.PrimaryVersionId)) {
    const versions = mediaVersions(item, state).map(entry => entry.item);
    if (versions.length > 1) {
      let winner;
      for (const version of versions) {
        const data = state.userData?.get(idKey(version.Id)) ?? await readUserData(state.db, user.Id, version);
        if ((data.PlaybackPositionTicks > 0n || data.Played)
          && (!winner || dateTicks(data.LastPlayedDate ?? MIN_DATE) > dateTicks(winner.data.LastPlayedDate ?? MIN_DATE))) winner = { version, data };
      }
      if (winner) {
        const winnerDto = userDataDto(winner.version, winner.data);
        dto.Played ||= winner.data.Played;
        if (dateTicks(winner.data.LastPlayedDate ?? MIN_DATE) > dateTicks(dto.LastPlayedDate ?? MIN_DATE)) dto.LastPlayedDate = winnerDto.LastPlayedDate;
        if (!sameId(winner.version.Id, item.Id) && winner.data.Played && winner.data.PlaybackPositionTicks <= 0n) {
          dto.PlaybackPositionTicks = 0n;
          dto.PlayedPercentage = null;
        }
      }
    }
  }
  if (supportsUserDataFromChildren(item) && supportsPlayed(item)) {
    const sqlStats = state.folderStats?.get(idKey(item.Id));
    if (sqlStats) {
      dto.UnplayedItemCount = sqlStats.UnplayedItemCount;
      dto.Played = sqlStats.Played;
      dto.PlayedPercentage = sqlStats.PlayedPercentage;
      return dto;
    }
    const children = userDataLeaves(item, state);
    const played = children.filter(entry => state.isPlayed(entry)).length;
    dto.UnplayedItemCount = children.length - played;
    dto.Played = played === children.length;
    if (children.length) dto.PlayedPercentage = played / children.length * 100;
  }
  return dto;
}

export async function projectItem(item, state, user, selected, options) {
  const has = field => selected.fields.has(field.toLowerCase());
  const dto = { Name: item.Name, ServerId: options.serverId, Id: dtoId(item.Id), Container: item.Container, EndDate: dateText(item.EndDate), IndexNumber: item.IndexNumber, ParentIndexNumber: item.ParentIndexNumber,
    MediaType: item.MediaType, CriticRating: item.CriticRating, OfficialRating: item.OfficialRating, OriginalLanguage: item.OriginalLanguage,
    PremiereDate: dateText(item.PremiereDate), ProductionYear: item.ProductionYear, RunTimeTicks: item.RunTimeTicks,
    Type: item.Type === 'PlaylistsFolder' ? 'ManualPlaylistsFolder'
      : item.Type === 'LiveTvProgram' ? 'Program' : item.Type === 'LiveTvChannel' ? 'TvChannel' : item.Type,
    ImageBlurHashes: new Map(), ChannelId: nonemptyId(item.ChannelId) ? dtoId(item.ChannelId) : null };
  if (item.Type !== 'LiveTvProgram') dto.LocationType = item.LocationType;
  if (item.Type === 'LiveTvProgram') {
    dto.StartDate = dateText(item.StartDate);
    Object.assign(dto, state.dtoProgramRecordingInfo?.get(idKey(item.Id)));
    dto.EpisodeTitle = item.EpisodeTitle;
    for (const field of ['IsRepeat', 'IsMovie', 'IsSeries', 'IsSports', 'IsLive', 'IsNews', 'IsKids', 'IsPremiere']) {
      if (item[field]) dto[field] = true;
    }
    if (has('ChannelInfo') || has('ChannelImage')) {
      const channel = state.byId.get(idKey(item.ChannelId));
      if (channel?.Type === 'LiveTvChannel') {
        dto.ChannelName = channel.Name;
        dto.ChannelNumber = channel.Number;
        dto.MediaType = channel.MediaType;
        if (has('ChannelImage')) {
          const primary = (await itemImageRows(state, channel)).find(row => row.ImageType === 0);
          if (primary) dto.ChannelPrimaryImageTag = md5Guid(`${channel.Path ?? ''}${dateTicks(primary.DateModified)}`);
        }
      }
    }
  }
  if (item.Type === 'LiveTvChannel') {
    dto.Number = item.Number; dto.ChannelNumber = item.Number; dto.ChannelType = item.ChannelType;
    if (selected.addCurrentProgram !== false) dto.CurrentProgram = state.dtoCurrentPrograms?.get(idKey(item.Id));
  }
  if (item.IsFolder || VIDEO_TYPES.has(item.Type) || ['Audio', 'AudioBook', 'Photo', 'LiveTvChannel'].includes(item.Type)) dto.IsFolder = item.IsFolder;
  if (item.SourceType === 'Channel') dto.SourceType = item.SourceType;
  if (item.Audio != null) dto.Audio = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'][item.Audio] ?? item.Audio;
  if (item.CommunityRating > 0) dto.CommunityRating = item.CommunityRating;
  if (['Audio', 'AudioBook'].includes(item.Type)) {
    dto.HasLyrics = (await itemStreamRows(state, item)).some(row => row.StreamType === 5);
  }
  if (['Audio', 'AudioBook', 'MusicAlbum', 'MusicVideo'].includes(item.Type)) {
    dto.Artists = item.Artists;
    const albumArtists = item.Type === 'MusicVideo' ? [] : item.AlbumArtists;
    const requestedArtists = [...new Set([...item.Artists, ...albumArtists].filter(value => value != null && clrTrim(value)))];
    const artistsByName = state.getDtoArtists ? await state.getDtoArtists(requestedArtists) : null;
    const names = values => [...new Set(values.filter(value => value != null && clrTrim(value)))].flatMap(Name => {
      const artist = artistsByName ? artistsByName.get(Name)?.[0]
        : state.items.find(candidate => candidate.Type === 'MusicArtist' && repositoryCleanName(candidate) === cleanValue(Name));
      return artist ? [{ Name, Id: dtoId(artist.Id) }] : [];
    });
    dto.ArtistItems = names(item.Artists);
    if (item.Type !== 'MusicVideo') {
      dto.AlbumArtist = item.AlbumArtists[0];
      dto.AlbumArtists = names(item.AlbumArtists);
    }
  }
  if (item.IsPlaceHolder) dto.IsPlaceHolder = true;
  if (item.LUFS != null) dto.NormalizationGain = Math.fround(-18 - Math.fround(item.LUFS));
  else if (item.NormalizationGain != null) dto.NormalizationGain = item.NormalizationGain;
  for (const field of ['Overview', 'OriginalTitle', 'CustomRating', 'ForcedSortName']) if (has(field)) dto[field] = item[field];
  if (has('Path')) dto.Path = hasFileProtocol(item) ? substitutePath(item.Path, options.configuration?.PathSubstitutions) : item.Path;
  if (has('SortName')) dto.SortName = sortName(item, options);
  if (has('DateCreated')) dto.DateCreated = dateText(item.DateCreated ?? MIN_DATE);
  if (has('Tags')) dto.Tags = item.Tags;
  if (has('Taglines')) dto.Taglines = item.Tagline ? [item.Tagline] : [];
  if (has('ProviderIds')) dto.ProviderIds = new Map(Object.entries(item.ProviderIds));
  if (has('ParentId')) {
    // DtoService reads the virtual BaseItem.DisplayParentId getter. Episode
    // and Season override it; UserView's serialized field hides it instead.
    const parentId = item.Type === 'Episode' ? item.SeasonId
      : item.Type === 'Season' ? item.SeriesId : item.ParentId;
    dto.ParentId = nonemptyId(parentId) ? dtoId(parentId) : null;
  }
  if (has('RemoteTrailers')) dto.RemoteTrailers = item.RemoteTrailers ?? [];
  if (has('Genres')) {
    dto.Genres = item.Genres;
    dto.GenreItems = item.Genres.filter(Name => Name !== '').map(Name => ({
      Name,
      Id: byNameId(state, options, ['Audio', 'AudioBook', 'MusicVideo', 'MusicAlbum', 'MusicArtist'].includes(item.Type) ? 'MusicGenre' : 'Genre', Name),
    }));
  }
  if (has('Studios')) dto.Studios = item.Studios.filter(Name => Name !== '')
    .map(Name => ({ Name, Id: byNameId(state, options, 'Studio', Name) }));
  if (has('Settings')) Object.assign(dto, { LockedFields: (await relationRows(state, item, 'metadataFieldRowsByItem', 'BaseItemMetadataFields')).map(entry => entry.Id), LockData: item.IsLocked, ForcedSortName: item.ForcedSortName, PreferredMetadataLanguage: item.PreferredMetadataLanguage, PreferredMetadataCountryCode: item.PreferredMetadataCountryCode });
  if (has('DisplayPreferencesId')) dto.DisplayPreferencesId = ['Folder', 'CollectionFolder'].includes(item.Type) ? dtoId(item.Id) : md5Guid(item.NativeType);
  if (has('Etag')) dto.Etag = md5Guid(String(dateTicks(item.DateLastSaved)));
  if (has('ExternalUrls')) dto.ExternalUrls = projectExternalUrls(item, state, options);
  if (has('CanDelete')) dto.CanDelete = canDeleteItem(item, user, {
    collectionFolders: () => collectionFoldersForItem(item, state), isActiveRecording: options.isActiveRecording, precomputedFolders: true,
  });
  if (has('CanDownload')) dto.CanDownload = (VIDEO_TYPES.has(item.Type) || ['Audio', 'AudioBook', 'Book', 'Photo'].includes(item.Type)) && item.LocationType === 'FileSystem' && !['Dvd', 'BluRay'].includes(item.VideoType) && (!user || user.Policy.EnableContentDownloading === true);
  if (has('EnableMediaSourceDisplay')) dto.EnableMediaSourceDisplay = item.EnableMediaSourceDisplay ?? true;
  if (has('MediaSources') && (VIDEO_TYPES.has(item.Type) || ['Audio', 'AudioBook', 'LiveTvChannel'].includes(item.Type))) dto.MediaSources = await mediaSources(item, state, user, options, true);
  if (has('MediaStreams') && item.Type === 'LiveTvChannel') dto.MediaStreams = [];
  else if (has('MediaStreams') && (VIDEO_TYPES.has(item.Type) || ['Audio', 'AudioBook'].includes(item.Type))) dto.MediaStreams = dto.MediaSources?.find(source => sameId(source.Id, item.Id))?.MediaStreams ?? await projectedStreams(state, item, options);
  if (VIDEO_TYPES.has(item.Type)) {
    Object.assign(dto, { VideoType: item.VideoType ?? 'VideoFile', Video3DFormat: item.Video3DFormat, IsoType: item.IsoType, ExtraType: extraType(item), AspectRatio: item.AspectRatio });
    if (item.AdditionalParts?.length) dto.PartCount = item.AdditionalParts.length + 1;
    if (has('MediaSourceCount')) {
      const count = !user || !nonemptyId(item.PrimaryVersionId) && !item.LinkedAlternateVersions?.length && !versionChildren(item, state, 2).length
        ? mediaSourceCount(item, state) : mediaVersions(item, state).filter(entry => sameId(entry.item.Id, item.Id) || visibleItem(entry.item, user, state, { ...options, query: false })).length;
      if (count !== 1) dto.MediaSourceCount = count;
    }
    if (has('Trickplay')) {
      const rows = await relationRows(state, item, 'trickplayRowsByItem', 'TrickplayInfos');
      dto.Trickplay = new Map(rows.length ? [[dtoId(item.Id), new Map(rows.map(({ ItemId, ...row }) => [String(row.Width), row]))]] : []);
    }
  }
  if (has('Chapters')) dto.Chapters = (await relationRows(state, item, 'chapterRowsByItem', 'Chapters')).map(row => ({ StartPositionTicks: row.StartPositionTicks, Name: row.Name, ImagePath: row.ImagePath, ImageDateModified: dateText(row.ImageDateModified ?? MIN_DATE) }));
  if (has('LocalTrailerCount')) dto.LocalTrailerCount = state.items.filter(extra => sameId(extra.OwnerId, item.Id) && extraTypeCode(extra.ExtraType) === 2).length;
  if (has('SpecialFeatureCount')) dto.SpecialFeatureCount = state.items.filter(extra => sameId(extra.OwnerId, item.Id) && [1, 3, 4, 5, 6, 10, 11].includes(extraTypeCode(extra.ExtraType))).length;
  if (has('ProductionLocations') && (item.ProductionLocations.length > 0 || item.Type === 'Movie')) dto.ProductionLocations = item.ProductionLocations;
  if (has('Width') && item.Width > 0) dto.Width = item.Width;
  if (has('Height') && item.Height > 0) dto.Height = item.Height;
  if (has('IsHD') && item.IsHD) dto.IsHD = true;
  if (item.Type === 'Book') dto.SeriesName = item.SeriesName;
  if (item.Type === 'Photo') {
    for (const key of ['CameraMake', 'CameraModel', 'Software', 'ExposureTime', 'FocalLength', 'Aperture', 'ShutterSpeed', 'Latitude', 'Longitude', 'Altitude', 'IsoSpeedRating']) dto[key] = item[key];
    dto.ImageOrientation = item.Orientation;
    let parent = state.byId.get(idKey(item.ParentId));
    const visited = new Set([idKey(item.Id)]);
    while (parent && parent.Type !== 'PhotoAlbum' && !visited.has(idKey(parent.Id))) {
      visited.add(idKey(parent.Id)); parent = state.byId.get(idKey(parent.ParentId));
    }
    if (parent?.Type === 'PhotoAlbum') { dto.Album = parent.Name; dto.AlbumId = dtoId(parent.Id); }
  }
  if (['Series', 'Season', 'Episode'].includes(item.Type)) {
    for (const key of ['SeriesName', 'SeasonName', 'IndexNumberEnd', 'AirTime', 'Status']) if (item[key] != null) dto[key] = item[key];
    for (const key of item.Type === 'Episode' ? ['SeriesId', 'SeasonId'] : item.Type === 'Season' ? ['SeriesId'] : []) {
      dto[key] = nonemptyId(item[key]) ? dtoId(item[key]) : null;
    }
    if (item.Type === 'Series') dto.AirDays = item.AirDays ?? [];
    if (has('SpecialEpisodeNumbers')) for (const key of ['AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber']) dto[key] = item[key];
  }
  const rawCollectionType = item.Type === 'PlaylistsFolder' ? 'playlists' : item.CollectionType ?? (item.Type === 'UserView' ? item.ViewType : null);
  if (rawCollectionType != null) dto.CollectionType = typeof rawCollectionType === 'number' && collectionType(item) === String(rawCollectionType)
    ? rawCollectionType : collectionType({ CollectionType: rawCollectionType });
  if (item.DisplayOrder != null) dto.DisplayOrder = item.DisplayOrder;
  if (has('People')) {
    dto.People = await projectPeople(item, state, user, options);
  }
  const images = selected.enableImages || has('PrimaryImageAspectRatio') ? await itemImageRows(state, item) : [];
  const imageEnabled = type => selected.enableImages && selected.imageTypeLimit > 0 && selected.imageTypes.some(name => name.toLowerCase() === type.toLowerCase());
  const imageTag = row => md5Guid(`${item.Path ?? ''}${dateTicks(row.DateModified)}`);
  if (selected.enableImages) dto.ImageTags = new Map();
  if (imageEnabled('Backdrop')) dto.BackdropImageTags = [];
  for (const row of images) {
    const type = itemImageTypes[row.ImageType];
    if (!type || !imageEnabled(type) || type === 'Chapter') continue;
    const tag = imageTag(row);
    if (type === 'Backdrop') {
      if (dto.BackdropImageTags.length >= selected.imageTypeLimit) continue;
      dto.BackdropImageTags.push(tag);
    } else dto.ImageTags.set(type, tag);
    if (row.Blurhash?.length) {
      if (!dto.ImageBlurHashes.has(type)) dto.ImageBlurHashes.set(type, new Map());
      dto.ImageBlurHashes.get(type).set(tag, Buffer.from(row.Blurhash).toString('utf8'));
    }
  }
  if (has('PrimaryImageAspectRatio')) {
    const primary = images.find(row => row.ImageType === 0);
    if (item.Type === 'Photo' && primary) {
      let size;
      if (!/^http/iu.test(primary.Path)) try {
        size = options.getImageDimensions ? await options.getImageDimensions(item, primary) : primary;
      } catch (error) { options.logger?.error?.(error, 'Could not read the primary image dimensions.'); }
      if (size?.Width > 0 && size.Height > 0) dto.PrimaryImageAspectRatio = size.Width / size.Height;
      else {
        const rotated = ['LeftBottom', 'LeftTop', 'RightBottom', 'RightTop'].includes(item.Orientation);
        dto.PrimaryImageAspectRatio = item.Width !== 0 && item.Height !== 0
          ? rotated ? item.Height / item.Width : item.Width / item.Height : 0;
      }
    } else if (primary?.Width > 0 && primary.Height > 0) dto.PrimaryImageAspectRatio = primary.Width / primary.Height;
  }
  await addInheritedImages(dto, item, state, selected, options, parent => itemImageRows(state, parent));
  if (['Audio', 'AudioBook'].includes(item.Type)) {
    dto.Album = item.Album;
    dto.ExtraType = extraType(item);
    let parent = state.byId.get(idKey(item.ParentId));
    const visited = new Set([idKey(item.Id)]);
    while (parent && parent.Type !== 'MusicAlbum' && !visited.has(idKey(parent.Id))) {
      visited.add(idKey(parent.Id)); parent = state.byId.get(idKey(parent.ParentId));
    }
    if (parent?.Type === 'MusicAlbum') {
      dto.AlbumId = dtoId(parent.Id);
      dto.AlbumPrimaryImageTag = await imageTagAndHash(dto, parent, state);
      if (parent.LUFS != null) dto.AlbumNormalizationGain = Math.fround(-18 - Math.fround(parent.LUFS));
      else if (parent.NormalizationGain != null) dto.AlbumNormalizationGain = parent.NormalizationGain;
    }
  }
  if (user) {
    if (has('PlayAccess')) dto.PlayAccess = user.Policy.EnableMediaPlayback === true ? 'Full' : 'None';
    if (selected.enableUserData) {
      dto.UserData = await projectUserData(item, state, user);
      if (supportsUserDataFromChildren(item)) {
        const sqlStats = state.folderStats?.get(idKey(item.Id));
        if (has('RecursiveItemCount')) dto.RecursiveItemCount = sqlStats?.RecursiveItemCount ?? userDataLeaves(item, state).length;
      }
    }
    if (item.IsFolder) {
      if ((item.SourceType == null || item.SourceType === 'Library' || item.SourceType === 0)
        && ['MusicAlbum', 'Season', 'Playlist'].includes(item.Type)) {
        if (dto.RecursiveItemCount > 0) dto.ChildCount = dto.RecursiveItemCount;
        const linkedCount = state.dtoLinkedChildCounts?.get(idKey(item.Id)) ?? item.LinkedChildren?.length ?? 0;
        if (linkedCount > 0) dto.ChildCount ??= linkedCount;
      }
      if (has('ChildCount') && dto.ChildCount === undefined) dto.ChildCount = state.getChildCount
        ? await state.getChildCount(item) : state.children(item).filter(state.visible).length;
      if (has('CumulativeRunTimeTicks')) dto.CumulativeRunTimeTicks = item.RunTimeTicks;
      if (has('DateLastMediaAdded')) {
        const freshFolder = item === state.transientUserRoot || item.Type === 'UserView' && state.newUserView?.(item);
        dto.DateLastMediaAdded = dateText(freshFolder && repositoryValue(item, 'DateLastMediaAdded') == null
          ? undefined : item.DateLastMediaAdded ?? MIN_DATE);
      }
    }
  }
  if (has('ItemCounts')) {
    const counts = state.dtoItemCounts?.get(idKey(item.Id)) ?? await state.getItemCounts?.(item);
    if (counts) Object.assign(dto, counts);
  }
  withNativeFloats(dto, ['CriticRating', 'CommunityRating', 'NormalizationGain', 'AlbumNormalizationGain']);
  return withNativeNulls(dto, ['ChannelId', ...(has('ParentId') ? ['ParentId'] : []),
    ...(item.Type === 'Episode' ? ['SeasonId', 'SeriesId'] : item.Type === 'Season' ? ['SeriesId'] : [])]);
}
