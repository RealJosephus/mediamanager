import { idKey } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import {
  replacePostgresItemAncestors,
  replacePostgresItemProviderIds,
  replacePostgresItemValues,
} from './postgres-item-relation-mutation.js';

const inheritedTagsType = 6;
const itemType = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
const noAncestors = new Set(['Person', 'Genre', 'MusicGenre', 'Studio', 'Year']);
const artists = new Set(['Audio', 'AudioBook', 'MusicAlbum', 'MusicVideo']);
const albumArtists = new Set(['Audio', 'AudioBook', 'MusicAlbum']);
export const itemSupportsAncestors = item => !noAncestors.has(itemType(item));
export const itemHasArtist = item => artists.has(itemType(item));
export const itemHasAlbumArtist = item => albumArtists.has(itemType(item));

export function requireNativeList(value, parameterName = 'source') {
  if (value === null) throw Object.assign(new TypeError(`Value cannot be null. (Parameter '${parameterName}')`),
    { nativeException: 'ArgumentNullException', parameterName, status: 500 });
  return value ?? [];
}

export function itemSaveRelations(item, { parents = [], collectionFolders = [] } = {}) {
  // DisplayParentId is a query scope, not an ancestor. The collection folders
  // must come from LibraryManager.GetCollectionFolders' parent/owner/path walk.
  const sources = [...parents, ...collectionFolders];
  const ids = new Map();
  for (const source of sources) if (source?.Id != null && !ids.has(idKey(source.Id))) ids.set(idKey(source.Id), source.Id);
  if (itemType(item) === 'Episode' && item.SeasonId && idKey(item.SeasonId) !== '00000000000000000000000000000000'
    && !ids.has(idKey(item.SeasonId))) ids.set(idKey(item.SeasonId), item.SeasonId);
  const tags = new Map();
  for (const source of [item, ...sources]) for (const tag of requireNativeList(source.Tags, 'collection')) {
    if (tag == null) continue;
    if (typeof tag !== 'string') throw new TypeError('Native inherited tags must be strings.');
    const key = ordinalIgnoreCaseKey(tag);
    if (!tags.has(key)) tags.set(key, tag);
  }
  return { ancestorIds: itemSupportsAncestors(item) ? [...ids.values()] : null,
    inheritedTags: [...tags.values()].filter(tag => clrTrim(tag) !== '') };
}

export async function persistItemProviderIds(db, item) {
  await replacePostgresItemProviderIds(db, item.Id, Object.entries(item.ProviderIds ?? {}));
}

// Call within the item's creation/update transaction. Native SaveItems applies
// these relations immediately on CreateItem and recomputes them on every save.
export async function persistItemRelations(db, item, { parents = [], collectionFolders = [], preparedRelations } = {}) {
  const relations = preparedRelations ?? itemSaveRelations(item, { parents, collectionFolders });
  const requestedIds = new Map((relations.ancestorIds ?? []).map(id => [idKey(id), id]));
  const ancestorIds = relations.ancestorIds == null ? null
    : await replacePostgresItemAncestors(db, item.Id, [...requestedIds.values()]);
  const desiredValues = [
    ...(itemHasArtist(item) ? requireNativeList(item.Artists).map(value => [0, value]) : []),
    ...(itemHasAlbumArtist(item) ? requireNativeList(item.AlbumArtists).map(value => [1, value]) : []),
    ...requireNativeList(item.Genres).map(value => [2, value]),
    ...requireNativeList(item.Studios).map(value => [3, value]),
    ...requireNativeList(item.Tags).map(value => [4, value]),
    ...relations.inheritedTags.map(value => [inheritedTagsType, value]),
  ].filter(([, value]) => value != null && clrTrim(value) !== '');
  await replacePostgresItemValues(db, item.Id, desiredValues);
  return { ancestorIds, inheritedTags: relations.inheritedTags };
}
