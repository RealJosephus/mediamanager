import { lowerInvariant } from '../core/identity.js';
import { readNativeImageRows, readNativeTrailerRows } from '../database/native-relation-order.js';
import unicodeLetterNumberRangeBounds from '../core/resources/unicode-letter-number-ranges.json' with { type: 'json' };
import { removeDiacritics } from '../sessions/user-data.js';
import { clrTrim } from '../metadata/whitespace.js';
import { isLegacyBoxSet } from './boxset-state.js';
import { cachedFolderChildren } from './collection-membership.js';
import { deserializeNativeItemData } from './native-item-data.js';
import { isNativeItemEntity, nativeItemDescriptor, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { imageTypes } from '../metadata/image-paths.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes,decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';

export const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
export const VIDEO_TYPES = new Set(['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer']);
export const NAME_TYPES = new Set(['Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio']);
export const MIN_DATE = '0001-01-01T00:00:00.0000000Z';

export function libraryError(status, message) { return Object.assign(new Error(message), { status, statusCode: status }); }
export function unsupported(message) { throw libraryError(501, message); }
export function guid(value) {
  const text = String(value ?? '').replace(/^\{(.*)\}$/, '$1').replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(text)) throw libraryError(400, `Invalid GUID: ${value}`);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`.toLowerCase();
}
export const idKey = value => value == null ? '' : String(value).replaceAll('-', '').toLowerCase();
export const dtoId = value => idKey(value ?? EMPTY_ID);
export const sameId = (a, b) => idKey(a) === idKey(b);
export const nonemptyId = value => value && !sameId(value, EMPTY_ID);

// Repository scopes are stored search values, not live CLR entity properties.
// Raw database records and branded entities have separate representations.
export const repositoryTopParentId = item => isNativeItemEntity(item) ? item.NativeTopParentId : item?.TopParentId;
export const repositoryCleanName = item => isNativeItemEntity(item) ? item.NativeCleanName : item?.CleanName;
// SQL reads nullable stored columns, not mapper defaults or virtual getters.
// This immutable frame remains distinct from the entity through branded clones.
export const repositoryValue = (item, key) => isNativeItemEntity(item) && Object.hasOwn(item, 'NativeRepositoryColumns')
  ? item.NativeRepositoryColumns[key] : item?.[key];
export const repositoryIdPresent = (item, key) => repositoryValue(item, key) != null;
const extraTypeNames = Object.freeze(['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview',
  'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short']);
export const extraTypeCode = value => value == null || typeof value === 'number' ? value : extraTypeNames.indexOf(value);

function isLetterOrNumber(character) {
  // The native regular expression classifies UTF-16 characters. A surrogate
  // pair therefore becomes a separator even when its scalar is a letter.
  const codePoint = character.charCodeAt(0);
  let low = 0, high = unicodeLetterNumberRangeBounds.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = unicodeLetterNumberRangeBounds[middle * 2];
    const end = unicodeLetterNumberRangeBounds[middle * 2 + 1];
    if (codePoint < start) high = middle - 1;
    else if (codePoint >= end) low = middle + 1;
    else return true;
  }
  return false;
}

export function cleanValue(value) {
  if (value == null || !clrTrim(value)) return value;
  let result = '', pendingSeparator = false;
  for (const character of lowerInvariant(removeDiacritics(value))) {
    if (isLetterOrNumber(character)) {
      if (pendingSeparator && result) result += ' ';
      result += character;
      pendingSeparator = false;
    } else pendingSeparator = true;
  }
  return result;
}

export function dateText(value) {
  if (value == null) return undefined;
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(?:Z|\+00:00)?$/.exec(value);
  if (!match) throw libraryError(500, 'Invalid stored native date.');
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(7, '0')}Z`;
}

export function dateTicks(value) {
  const text = dateText(value ?? MIN_DATE);
  const fraction = BigInt(text.slice(20, 27));
  return BigInt(Date.parse(`${text.slice(0, 19)}Z`)) * 10000n + 621355968000000000n + fraction;
}

export function mapRecord(row, { skipDeserialization = false, onJsonError, onUnknownType } = {}) {
  const item = deserializeNativeItemData(row.Type, row.Data, { skip: skipDeserialization, onJsonError,
    onUnknownType: event => onUnknownType?.({ ...event, itemId: row.Id }) });
  if (!item) return null;
  Object.defineProperty(item, 'NativeRepositoryColumns', {
    value: Object.freeze({ ...row }), enumerable: false, configurable: true,
  });
  const descriptor = nativeItemDescriptor(row.Type);
  // BaseItemMapper maps declared scalar properties, never arbitrary database
  // columns onto a live entity. Search flags remain separate from getters.
  for (const key of ['Id', 'Path', 'EndDate', 'CommunityRating', 'CustomRating', 'IndexNumber', 'IsLocked', 'Name',
    'OfficialRating', 'Overview', 'ParentIndexNumber', 'PremiereDate', 'ProductionYear', 'SortName', 'ForcedSortName',
    'RunTimeTicks', 'PreferredMetadataLanguage', 'PreferredMetadataCountryCode', 'IsInMixedFolder',
    'InheritedParentalRatingValue', 'InheritedParentalRatingSubValue', 'CriticRating', 'PresentationUniqueKey',
    'OriginalTitle', 'OriginalLanguage', 'Album', 'LUFS', 'NormalizationGain', 'IsVirtualItem', 'ExternalSeriesId',
    'Tagline', 'TotalBitrate', 'ExternalId', 'Size']) if (Object.hasOwn(row, key)) item[key] = row[key];
  for (const key of ['ParentId', 'ChannelId', 'OwnerId']) item[key] = row[key] ?? EMPTY_ID;
  for (const key of ['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved']) item[key] = row[key] == null ? MIN_DATE : dateText(row[key]);
  for (const key of ['Width', 'Height']) item[key] = row[key] ?? 0;
  const audio = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];
  if (row.ExtraType != null) item.ExtraType = typeof row.ExtraType === 'number' ? extraTypeNames[row.ExtraType] ?? row.ExtraType : row.ExtraType;
  if (row.Audio != null) item.Audio = typeof row.Audio === 'number' ? audio[row.Audio] ?? row.Audio : row.Audio;
  if (descriptor.family === 'video') item.PrimaryVersionId = row.PrimaryVersionId ?? null;
  if (['LiveTvProgram', 'LiveTvChannel'].includes(descriptor.type)) {
    // BaseItemMapper overwrites IHasProgramAttributes from stored columns,
    // including when serialized Data contains different flag values.
    for (const key of ['IsMovie', 'IsSeries', 'EpisodeTitle', 'IsRepeat']) item[key] = row[key];
    if (descriptor.type === 'LiveTvProgram') {
      item.StartDate = row.StartDate == null ? MIN_DATE : dateText(row.StartDate);
      item.ShowId = row.ShowId ?? null;
    } else item.ServiceName = row.ExternalServiceId ?? null;
  }
  if (descriptor.hasSeries) {
    item.SeriesId = row.SeriesId ?? EMPTY_ID;
    item.SeriesName = row.SeriesName ?? null;
    item.SeriesPresentationUniqueKey = row.SeriesPresentationUniqueKey ?? null;
  }
  if (descriptor.type === 'Episode') { item.SeasonId = row.SeasonId ?? EMPTY_ID; item.SeasonName = row.SeasonName ?? null; }
  if (descriptor.family === 'folder') item.DateLastMediaAdded = row.DateLastMediaAdded == null ? MIN_DATE : dateText(row.DateLastMediaAdded);
  // Several native repository filters intentionally operate on the serialized
  // JSON text with ordinal substring searches. Keep that exact text without
  // making it part of DTO/object enumeration.
  Object.defineProperty(item, 'NativeData', {
    value: typeof row.Data === 'string' ? row.Data : row.Data == null ? null : JSON.stringify(row.Data),
    enumerable: false, writable: true, configurable: true,
  });
  // SQL search filters the nullable stored MediaType; DTOs use the entity's
  // type-specific getter below. Keep both values available to their callers.
  Object.defineProperty(item, 'NativeMediaType', { value: row.MediaType, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(item, 'NativeTopParentId', { value: row.TopParentId, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(item, 'NativeCleanName', { value: row.CleanName, enumerable: false, writable: true, configurable: true });
  // BaseItemMapper treats a null/empty/whitespace-only Genres column as an
  // empty array, but otherwise uses Split('|') without RemoveEmptyEntries.
  // Empty segments are therefore observable for nonblank persisted values.
  item.Genres = typeof row.Genres === 'string' && clrTrim(row.Genres) ? row.Genres.split('|') : [];
  item.Tags = typeof row.Tags === 'string' && clrTrim(row.Tags) ? row.Tags.split('|') : [];
  item.ProductionLocations = typeof row.ProductionLocations === 'string' ? row.ProductionLocations.split('|').filter(part => part !== '') : [];
  if (descriptor.hasArtist) item.Artists = typeof row.Artists === 'string' ? row.Artists.split('|').filter(part => part !== '') : [];
  if (descriptor.hasAlbumArtist) item.AlbumArtists = typeof row.AlbumArtists === 'string' ? row.AlbumArtists.split('|').filter(part => part !== '') : [];
  // BaseItemMapper.Split('|') retains Studio empty segments for in-memory
  // StudioIds filtering; AttachStudios drops them only when building DTOs.
  item.Studios = typeof row.Studios === 'string' ? row.Studios.split('|') : [];
  return item;
}

export async function loadLibrary(db, { expandPath = value => value, userRoot, programDataPath, configuration = {}, logger = {}, linkedChildren } = {}, {
  baseRows,
  includeManualLinks = false,
  includeFolderLinks = false,
  includeLinkGraph = true,
} = {}) {
  const mappingOptions = {
    onJsonError: ({ data, error }) => logger.error?.(error, 'Error deserializing item with JSON', data),
    onUnknownType: ({ fullName, itemId }) => logger.warn?.(`Skipping item ${itemId} with unknown type '${fullName}'. This may indicate a removed plugin or database corruption.`) };
  // BaseItemRepository limits this configuration flag to the two basic root
  // types; it is not the mapper's explicit skip option for arbitrary entities.
  const mapItem = row => mapRecord(row, { ...mappingOptions,
    skipDeserialization: configuration.SkipDeserializationForBasicTypes === true
      && ['MediaBrowser.Controller.Channels.Channel', 'MediaBrowser.Controller.Entities.UserRootFolder'].includes(row.Type) });
  if (!Array.isArray(baseRows)) throw new TypeError('PostgreSQL library loading requires SQL-scoped baseRows.');
  const persistedRows = baseRows;
  const items = persistedRows.filter(row => row.Type !== 'PLACEHOLDER').map(mapItem).filter(Boolean);
  let transientUserRoot;
  // The configured root is an identity singleton. A stray persisted
  // UserRootFolder with another deterministic ID must not suppress it.
  if (userRoot && !items.some(item => sameId(item.Id, userRoot.Id))) {
    transientUserRoot = mapItem(userRoot);
    if (transientUserRoot) items.push(transientUserRoot);
  }
  for (const item of items) item.Path = expandPath(item.Path);
  const byId = new Map(items.map(item => [idKey(item.Id), item]));
  const scopedIds = items.filter(item => !sameId(item.Id, transientUserRoot?.Id)).map(item => item.Id);
  const scopedRows = (name, key = 'ItemId') => scopedIds.length ? db.rows(name, { whereIn: { [key]: scopedIds } }) : [];
  const providers = await scopedRows('BaseItemProviders');
  for (const row of providers) {
    const item = byId.get(idKey(row.ItemId));
    if (item) Object.defineProperty(item.ProviderIds, row.ProviderId, {
      value: row.ProviderValue, enumerable: true, writable: true, configurable: true
    });
  }
  const parents = await scopedRows('AncestorIds');
  // Folder membership always stays in its SQL relation. The in-memory graph
  // carries only the separate video-version relation consumed by video APIs.
  let links = !includeLinkGraph || !scopedIds.length ? []
    : await db.rows('LinkedChildren', { whereIn: { ParentId: scopedIds, ChildType: [2, 3] } });
  if (includeLinkGraph && scopedIds.length) {
    const incoming = await db.rows('LinkedChildren', { whereIn: { ChildId: scopedIds, ChildType: [2,3] } });
    links = [...new Map([...links, ...incoming].map(row => [`${idKey(row.ParentId)}\0${row.SortOrder}`, row])).values()];
  }
  // A DomainStore operation owns one checked-out PostgreSQL session.  Keep the
  // dependent relation reads ordered on that session so transaction snapshots
  // and cancellation boundaries remain deterministic.
  const lockedFields = await scopedRows('BaseItemMetadataFields');
  const trailerTypes = await readNativeTrailerRows(db, scopedIds);
  const userData = await scopedRows('UserData');
  const images = await readNativeImageRows(db, scopedIds);
  const rowsByItem = rows => {
    const grouped = new Map(items.map(item => [idKey(item.Id), []]));
    for (const row of rows) {
      const key = idKey(row.ItemId);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    return grouped;
  };
  const metadataFieldRowsByItem = rowsByItem(lockedFields);
  const imageRowsByItem = rowsByItem(images);
  const trailerRowsByItem = rowsByItem(trailerTypes);
  const userDataRowsByItem = rowsByItem(userData);
  const metadataNames = ['Cast', 'Genres', 'ProductionLocations', 'Studios', 'Tags', 'Name', 'Overview', 'Runtime', 'OfficialRating'];
  const trailerNames = [null, 'ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'];
  const linkOwners = items.map(acquireNativeItemLinkOwner);
  try {
  for (const item of items) {
    const itemKey = idKey(item.Id);
    item.LockedFields = metadataFieldRowsByItem.get(itemKey).map(row => metadataNames[row.Id] ?? row.Id);
    item.UserData = userDataRowsByItem.get(itemKey);
    item.ImageInfos = imageRowsByItem.get(itemKey).map(row => ({ Path: expandPath(row.Path),
      Type: imageTypes[row.ImageType] ?? row.ImageType, DateModified: row.DateModified == null ? MIN_DATE : dateText(row.DateModified),
      Width: row.Width, Height: row.Height, BlurHash: row.Blurhash == null ? null : Buffer.from(row.Blurhash).toString('utf8') }));
    if (item.Type === 'Trailer') item.TrailerTypes = trailerRowsByItem.get(itemKey).map(row => trailerNames[row.Id] ?? row.Id);
    const itemLinks = links.filter(row => sameId(row.ParentId, item.Id)).sort((left, right) => left.SortOrder - right.SortOrder)
      .map(row => ({ ItemId: row.ChildId, Type: Number(row.ChildType) }));
    const descriptor = nativeItemDescriptor(item.NativeType);
    if (descriptor.family === 'folder' && includeFolderLinks) {
      if (!linkedChildren) throw new TypeError('Cold Folder hydration requires the runtime SQL link repository.');
      item.LinkedChildren = await linkedChildren.load(db, item.Id);
    }
    if (descriptor.family === 'video') item.LinkedAlternateVersions = itemLinks.filter(row => row.Type === 3);
  }
  let disposed = false;
  const hasStoredLinks = new Map();
  if(scopedIds.length){const sql=nativeTextSql(db.schemaName),table=`${q(db.schemaName)}.${q('LinkedChildren')}`;
    const rows=(await db.client.query(`SELECT source.id,EXISTS(SELECT 1 FROM ${table} link WHERE ${sql.guidKey('link."ParentId"')}=${sql.guidKey('source.id')}) AS present
      FROM unnest($1::bytea[]) source(id)`,[scopedIds.map(nativeTextBytes)])).rows;
    for(const row of rows)hasStoredLinks.set(idKey(decodeNativeTextBytes(row.id,'runtime')),row.present);
  }
  const state = { items, byId, parents, links, hasStoredLinks, db, transientUserRoot, userRootId: userRoot?.Id, repositoryUserDataRows: userData,
    adoptItem(item) {
      if (disposed) throw new Error('The library state has been disposed.');
      linkOwners.push(acquireNativeItemLinkOwner(item));
      return item;
    },
    async dispose({ session } = {}) {
      if (disposed) return; disposed = true;
      for (const owner of linkOwners) owner.release();
      await linkedChildren?.flushReleases({ session });
    },
    dtoRelations: { imageRowsByItem, metadataFieldRowsByItem } };
  state.ancestors = item => {
    const found = new Map();
    const add = id => { const parent = byId.get(idKey(id)); if (parent && !sameId(parent.Id, item.Id)) found.set(idKey(id), parent); };
    for (const row of parents) if (sameId(row.ItemId, item.Id)) add(row.ParentItemId);
    let current = item;
    const visited = new Set([idKey(item.Id)]);
    while (nonemptyId(current.ParentId) && !visited.has(idKey(current.ParentId))) {
      visited.add(idKey(current.ParentId));
      add(current.ParentId); current = byId.get(idKey(current.ParentId)); if (!current) break;
    }
    if (nonemptyId(item.NativeTopParentId)) add(item.NativeTopParentId);
    for (const library of items.filter(entry => entry.Type === 'CollectionFolder')) {
      if ((library.PhysicalFolderIds ?? []).some(id => sameId(id, item.Id) || sameId(id, repositoryTopParentId(item)) || found.has(idKey(id)))) add(library.Id);
    }
    return [...found.values()];
  };
  state.children = parent => {
    if (parent.Type === 'UserRootFolder') return cachedFolderChildren(parent, state);
    // CollectionFolder.GetActualChildren concatenates each physical Folder's
    // cached children in PhysicalFolderIds order, without a global re-sort.
    if (parent.Type === 'CollectionFolder') return (parent.PhysicalFolderIds ?? [])
      .map(id => byId.get(idKey(id))).filter(item => item?.IsFolder)
      .flatMap(folder => state.children(folder));
    if (parent.Type === 'Playlist') throw new TypeError('Playlist children require the bounded SQL member selection.');
    if (parent.Type === 'BoxSet'
      && !isLegacyBoxSet(parent, hasStoredLinks.get(idKey(parent.Id))===true, programDataPath)) return [];
    const children = items.filter(item => sameId(repositoryValue(item, 'ParentId'), parent.Id));
    // Folder.GetCachedChildren loads its children through a repository query
    // with no explicit OrderBy, so the stored SortName orders the cached array.
    return children.sort((left, right) => {
      const a = repositoryValue(left, 'SortName'), b = repositoryValue(right, 'SortName');
      if (a == null) return b == null ? 0 : -1;
      if (b == null) return 1;
      return Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
  };
  state.descendants = parent => {
    const result = new Map();
    const visit = (node, seen = new Set()) => {
      if (seen.has(idKey(node.Id))) return;
      seen.add(idKey(node.Id));
      for (const child of state.children(node)) { result.set(idKey(child.Id), child); if (child.IsFolder) visit(child, seen); }
    };
    visit(parent);
    for (const item of items) if (parents.some(row => sameId(row.ItemId, item.Id) && sameId(row.ParentItemId, parent.Id))) result.set(idKey(item.Id), item);
    return [...result.values()];
  };
  return state;
  } catch(error) { for(const owner of linkOwners)owner.release(); await linkedChildren?.flushReleases({session:db}); throw error; }
}
