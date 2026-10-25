import path from 'node:path';
import { lowerInvariant } from '../core/identity.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { idKey, nonemptyId, repositoryValue, NAME_TYPES } from './records.js';
import { nativePathWithin } from './native-path.js';
import { collectionFoldersForItem } from './collection-membership.js';
import { visibleItem } from './permissions.js';
import { binaryCompare } from './query.js';

const excludedParents = new Set(['BoxSet', 'Season', 'MusicAlbum', 'MusicArtist']);
const nullableCriteria = [
  'isfavorite', 'favoriteorlikes', 'likes', 'isplayed', 'isresumable', 'isfolder',
  'hasimdbid', 'hasofficialrating', 'hasoverview', 'hasparentalrating', 'hasspecialfeature', 'hassubtitles',
  'hasthemesong', 'hasthemevideo', 'hastmdbid', 'hastrailer', 'is3d', 'is4k', 'ishd',
  'islocked', 'isplaceholder', 'minindexnumber',
];
const collectionCriteria = [
  'genres', 'genreids', 'imagetypes', 'personids', 'ids', 'studioids', 'videotypes', 'years', 'tags', 'officialratings',
];
const disallowedSorts = new Set(['communityrating', 'criticrating', 'runtime']);
const allowCollapsing = query => !nullableCriteria.some(key => query[key] != null)
  && !collectionCriteria.some(key => query[key]?.length)
  && !clrTrim(query.person ?? '')
  && !query.sortby?.some(value => disallowedSorts.has(value.toLowerCase()));

export function boxSetCollapsePlan(query, { parent, user, configuration = {}, repository = true } = {}) {
  // ItemsController overrides the incoming nullable flag for ids and search.
  if (query.ids?.length || clrTrim(query.searchterm ?? '')) return { active: false, types: [] };
  const movies = configuration.EnableGroupingMoviesIntoCollections === true;
  const series = configuration.EnableGroupingShowsIntoCollections === true;
  const requestedTypes = query.includeitemtypes?.map(value => value.toLowerCase()) ?? [];
  const requests = type => !requestedTypes.length || requestedTypes.includes(type);
  const automatic = user ? movies && requests('movie') || series && requests('series')
    : requests('movie') || requests('series');
  const folderAllows = !excludedParents.has(parent?.Type) && allowCollapsing(query)
    && (query.collapseboxsetitems ?? automatic);
  const types = [...(movies ? ['Movie'] : []), ...(series ? ['Series'] : [])];
  if (!repository) return { active: Boolean(user && folderAllows && types.length), types };
  // QueryRecursive sets the flag and the type list only when Folder's helper
  // accepts the query. It never clears an explicitly true repository flag when
  // that helper declines; the untouched type list then means all item types.
  return { active: Boolean(folderAllows || query.collapseboxsetitems === true),
    types: folderAllows && !(movies && series) ? types : [] };
}

function parentsByChild(state, collections, manualOnly) {
  const result = new Map();
  for (const link of state.links) {
    if (manualOnly && Number(link.ChildType) !== 0) continue;
    const parent = collections.get(idKey(link.ParentId));
    if (!parent) continue;
    const key = idKey(link.ChildId);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(parent);
  }
  return result;
}

export function collapseRepositoryBoxSets(items, state, types = []) {
  const collections = new Map(state.items.filter(item => item.Type === 'BoxSet').map(item => [idKey(item.Id), item]));
  const parents = parentsByChild(state, collections, true);
  const result = new Map();
  for (const item of items) {
    const key = idKey(item.Id);
    if (types.length && !types.includes(item.Type)) {
      result.set(key, item);
      continue;
    }
    const containing = parents.get(key) ?? [];
    if (!containing.length && item.Type !== 'BoxSet') result.set(key, item);
    // A single projection can introduce a parent outside the original query
    // scope. Do not recursively collapse it or re-run child predicates on it.
    for (const collection of containing) result.set(idKey(collection.Id), collection);
  }
  return [...result.values()];
}

function collectionBoxSets(state, user, options) {
  if (!options.programDataPath) return new Map();
  const api = /^[A-Za-z]:[\\/]|^[\\/]{2}/u.test(options.programDataPath) ? path.win32 : path.posix;
  const collectionPath = api.join(options.programDataPath, 'data', 'collections');
  const folder = state.items.filter(item => item.IsFolder
    && state.byId.get(idKey(item.ParentId))?.Type === 'AggregateFolder'
    && nativePathWithin(collectionPath, item.Path))
    .sort((left, right) => binaryCompare(repositoryValue(left, 'SortName'), repositoryValue(right, 'SortName')))[0];
  if (!folder) return new Map();
  const children = [...state.children(folder), ...(state.linkedChildrenByParent?.get(idKey(folder.Id)) ?? [])];
  return new Map(children.filter(item => item.Type === 'BoxSet' && visibleItem(item, user, state, {
    ...options, query: false, checkStandaloneParents: false,
  })).map(item => [idKey(item.Id), item]));
}

export function collapseMemoryBoxSets(items, state, user, options, types) {
  const parents = parentsByChild(state, collectionBoxSets(state, user, options), false);
  const localAlternates = new Map();
  for (const link of state.links) {
    if (Number(link.ChildType) !== 2) continue;
    const key = idKey(link.ParentId);
    if (!localAlternates.has(key)) localAlternates.set(key, []);
    localAlternates.get(key).push(idKey(link.ChildId));
  }
  const allTypes = types.length === 2;
  const eligible = allTypes ? items : items.filter(item => types.includes(item.Type));
  const result = new Map();
  for (const item of eligible) {
    const key = idKey(item.Id);
    if (item.Type === 'Movie' || item.Type === 'Series') {
      const containing = parents.get(key) ?? [];
      if (containing.length) {
        for (const collection of containing) result.set(idKey(collection.Id), collection);
        continue;
      }
      if (item.Type === 'Movie' && localAlternates.get(key)?.some(id => result.has(id))) continue;
    }
    result.set(key, item);
  }
  return [...result.values(), ...(allTypes ? [] : items.filter(item => !types.includes(item.Type)))];
}

export function filterCollapsedNames(items, query, { memory = false, sortNameFor = item => item.SortName } = {}) {
  const fold = memory ? ordinalIgnoreCaseKey
    : value => String(value).replace(/[A-Z]/gu, character => character.toLowerCase());
  const token = memory ? ordinalIgnoreCaseKey : lowerInvariant;
  const prefix = clrTrim(query.namestartswith ?? '') ? token(query.namestartswith) : null;
  const lower = clrTrim(query.namestartswithorgreater ?? '') ? token(query.namestartswithorgreater) : null;
  const upper = clrTrim(query.namelessthan ?? '') ? token(query.namelessthan) : null;
  if (prefix == null && lower == null && upper == null) return items;
  const compare = memory ? (left, right) => left < right ? -1 : left > right ? 1 : 0 : binaryCompare;
  return items.filter(item => {
    const stored = memory ? sortNameFor(item) : repositoryValue(item, 'SortName');
    if (stored == null) return false;
    const name = fold(stored);
    return (prefix == null || name.startsWith(prefix))
      && (lower == null || compare(name, lower) >= 0)
      && (upper == null || compare(name, upper) < 0);
  });
}

export function boxSetLinkedChildren(parent, state, user, libraries, options) {
  const linked = state.linkedChildrenByParent?.get(idKey(parent.Id)) ?? [];
  if (!user) return linked;
  return linked.filter(child => {
    if (NAME_TYPES.has(child.Type)) return true;
    const owner = nonemptyId(child.OwnerId) ? state.byId.get(idKey(child.OwnerId)) ?? child : child;
    if (typeof owner.Path !== 'string' || !owner.Path || /^[a-z][a-z\d+.-]*:\/\//iu.test(owner.Path)) {
      return visibleItem(owner, user, state, { ...options, query: false });
    }
    return collectionFoldersForItem(owner, state, libraries).length > 0;
  });
}

export function boxSetRepositoryDescendants(parent, state) {
  const closure = roots => {
    const direct = new Set(state.parents.filter(row => roots.has(idKey(row.ParentItemId))).map(row => idKey(row.ItemId)));
    return new Set([...direct, ...state.parents.filter(row => direct.has(idKey(row.ParentItemId))).map(row => idKey(row.ItemId))]);
  };
  const rootKey = idKey(parent.Id);
  const visited = new Set([rootKey]);
  const closureRoots = new Set(visited);
  let frontier = new Set(visited);
  while (frontier.size) {
    const descendants = closure(frontier);
    const linked = new Set(state.links.filter(row => frontier.has(idKey(row.ParentId))).map(row => idKey(row.ChildId)));
    const linkedFolders = new Set([...linked].filter(key => state.byId.get(key)?.IsFolder));
    const linkOwners = state.links.filter(row => (descendants.has(idKey(row.ParentId)) || linked.has(idKey(row.ParentId)))
      && state.byId.get(idKey(row.ParentId))?.IsFolder).map(row => idKey(row.ParentId));
    frontier = new Set();
    for (const key of [...linkOwners, ...linkedFolders]) {
      if (visited.has(key)) continue;
      visited.add(key);
      frontier.add(key);
      if (linkedFolders.has(key)) closureRoots.add(key);
    }
  }
  const ids = closure(closureRoots);
  for (const row of state.links) if (visited.has(idKey(row.ParentId))) ids.add(idKey(row.ChildId));
  ids.delete(rootKey);
  return state.items.filter(item => ids.has(idKey(item.Id)));
}
