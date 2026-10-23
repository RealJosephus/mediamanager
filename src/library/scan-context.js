import { defaultLibraryOptions } from './options.js';
import { idKey } from './records.js';
import { nativeContainsSubPath, nativeContainingFolderPath } from './native-path.js';
import { nativeFileSystemPathsEqual } from './root-folder-file-data.js';
import { parentChainForItem } from './collection-membership.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { requireNativeList } from './item-relations.js';
import { clrTrim } from '../metadata/whitespace.js';

const names = ['unknown', 'movies', 'tvshows', 'music', 'musicvideos', 'trailers', 'homevideos', 'boxsets', 'books',
  'photos', 'livetv', 'playlists', 'folders', 'tvshowseries', 'tvgenres', 'tvgenre', 'tvlatest', 'tvnextup',
  'tvresume', 'tvfavoriteseries', 'tvfavoriteepisodes', 'movielatest', 'movieresume', 'moviemovies',
  'moviecollection', 'moviefavorites', 'moviegenres', 'moviegenre'];
const namedValues = new Map(names.map((name, index) => [name, index < 13 ? index : index + 88]));
const numericNames = new Map([...namedValues].map(([name, number]) => [number, name]));
const caseNames = new Map(names.map(name => [ordinalIgnoreCaseKey(name), name]));
const typeOf = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const isCollection = item => ['CollectionFolder', 'PlaylistsFolder'].includes(typeOf(item));
const ownType = item => typeOf(item) === 'PlaylistsFolder' ? 'playlists'
  : typeof item.CollectionType === 'number' ? numericNames.get(item.CollectionType) ?? String(item.CollectionType)
    : parseNativeCollectionType(item.CollectionType, true);

export function parseNativeCollectionType(value, ignoreCase = false) {
  if (typeof value !== 'string') return null;
  const text = clrTrim(value);
  if (/^[+-]?\d+$/u.test(text)) {
    const number = Number(text);
    return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? numericNames.get(number) ?? String(number) : null;
  }
  const entries = text.split(',').map(entry => {
    const name = clrTrim(entry);
    return ignoreCase ? caseNames.get(ordinalIgnoreCaseKey(name)) ?? name : name;
  });
  if (!entries.every(entry => namedValues.has(entry))) return null;
  const number = entries.reduce((result, entry) => result | namedValues.get(entry), 0);
  return numericNames.get(number) ?? String(number);
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutable(entry)])));
  }
  return value;
}

function stableValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, stableValue(value[key])]));
  }
  return value;
}

const stableText = value => JSON.stringify(stableValue(value));

// Resolver provenance needs the path/type chain, not a live entity's SQL
// relation owners or private runtime services.
const contextItem = item => Object.fromEntries(['Id', 'Type', 'NativeType', 'Name', 'Path',
  'ParentId', 'OwnerId', 'IsFolder', 'IsRoot', 'CollectionType', 'PhysicalFolderIds',
  'PhysicalLocationsList'].filter(key => item[key] !== undefined).map(key => [key, item[key]]));

function optionsFor(source, collectionId) {
  const key = idKey(collectionId);
  const found = source instanceof Map ? source.get(key) ?? source.get(collectionId) : source?.[key] ?? source?.[collectionId];
  return found && typeof found === 'object' && !Array.isArray(found) ? found : defaultLibraryOptions();
}

export function overridesFor(configuration) {
  const entries = configuration.ContentTypes === undefined ? [] : configuration.ContentTypes;
  if (entries === null) return null;
  return immutable(entries.map(entry => entry == null ? null : {
    path: entry.Name ?? null,
    value: entry.Value ?? null,
    collectionType: parseNativeCollectionType(entry.Value)
  }));
}

export function configuredTypeForPath(overrides, identityPath, inherit = false) {
  for (const entry of requireNativeList(overrides, 'source')) {
    if (entry == null) {
      throw Object.assign(new TypeError('Object reference not set to an instance of an object.'), {
        nativeException: 'NullReferenceException', status: 500
      });
    }
    if (nativeFileSystemPathsEqual(entry.path, identityPath)
      || inherit && entry.path != null && entry.path !== '' && nativeContainsSubPath(identityPath, entry.path)) return entry.collectionType;
  }
  return null;
}

export function configuredItemType(item, overrides, inherit = false) {
  return isCollection(item) ? ownType(item) : configuredTypeForPath(overrides, nativeContainingFolderPath(item), inherit);
}

const pathEquals = (left, right) => left == null || right == null ? left == null && right == null
  : ordinalIgnoreCaseKey(left) === ordinalIgnoreCaseKey(right);

export function topFolderContentType(item, parents, folders) {
  let top = item;
  for (const parent of parents) {
    if (typeOf(parent) === 'AggregateFolder') break;
    top = parent;
  }
  for (const collection of folders) {
    if (!isCollection(collection)) continue;
    if (pathEquals(collection.Path, top.Path) || (typeOf(collection) === 'CollectionFolder'
      ? requireNativeList(collection.PhysicalLocationsList === undefined ? [] : collection.PhysicalLocationsList, 'source') : [collection.Path])
      .some(location => location === top.Path)) {
      const type = ownType(collection);
      if (type != null) return type;
    }
  }
  return null;
}

export function inheritedItemType(item, parents, allFolders, overrides) {
  let top = item;
  for (const parent of parents) {
    if (typeOf(parent) === 'AggregateFolder') break;
    top = parent;
  }
  for (const collection of allFolders) {
    if (!isCollection(collection)) continue;
    const matches = pathEquals(collection.Path, top.Path) || (typeOf(collection) === 'CollectionFolder'
      ? requireNativeList(collection.PhysicalLocationsList === undefined ? [] : collection.PhysicalLocationsList, 'source') : [collection.Path]).some(location => location === top.Path);
    if (matches) {
      const type = ownType(collection);
      if (type != null) return type;
    }
  }
  let last = null;
  for (const parent of parents) {
    const type = configuredItemType(parent, overrides);
    if (type != null) last = type;
  }
  return last;
}

/** Freeze one attempt without changing native user-root child or override order. */
export function buildScanCollectionContext({ root, collectionFolders = [], libraryOptions = {}, configuration = {}, state } = {}) {
  if (!root || typeof root.Path !== 'string' || !root.Path) throw new TypeError('A physical scan root is required for resolver context.');
  const parents = state ? parentChainForItem(root, state) : [];
  const allFolders = collectionFolders;
  const entries = collectionFolders.map(collection => immutable({
    id: collection.Id,
    nativeType: typeOf(collection),
    collectionType: isCollection(collection) ? ownType(collection) : null,
    libraryOptions: optionsFor(libraryOptions, collection.Id),
    physicalFolderIds: collection.PhysicalFolderIds === undefined ? [] : collection.PhysicalFolderIds,
    physicalLocations: collection.PhysicalLocationsList === undefined ? [] : collection.PhysicalLocationsList
  }));
  const selected = typeOf(root) === 'CollectionFolder' ? root : collectionFolders.find(collection => typeOf(collection) === 'CollectionFolder');
  const overrides = overridesFor(configuration);
  const selectedOptions = selected ? optionsFor(libraryOptions, selected.Id) : defaultLibraryOptions();
  const base = immutable({
    rootId: root.Id,
    rootPath: root.Path,
    rootItem: contextItem(root),
    parents: parents.map(contextItem),
    topFolders: allFolders.map(contextItem),
    collections: entries,
    collectionFolderIds: entries.map(entry => entry.id),
    primaryCollectionFolderId: selected?.Id ?? null,
    libraryOptions: selectedOptions,
    contentTypeOverrides: overrides,
    signature: stableText({
      root: { id: idKey(root.Id), path: root.Path, type: typeOf(root), collectionType: root.CollectionType },
      parents: parents.map(parent => ({ id: idKey(parent.Id), path: parent.Path, type: typeOf(parent), collectionType: parent.CollectionType })),
      collections: entries,
      topFolders: allFolders.map(folder => ({ id: idKey(folder.Id), path: folder.Path, type: typeOf(folder),
        collectionType: folder.CollectionType, physicalLocations: folder.PhysicalLocationsList })),
      libraryOptions: selectedOptions,
      contentTypeOverrides: overrides
    })
  });
  return scanCollectionContextForItem(base, base.rootItem, base.parents);
}

export function scanCollectionContextForItem(context, item, parents) {
  if (!context || typeof context !== 'object') return null;
  const configured = configuredItemType(item, context.contentTypeOverrides);
  const inheritedOverride = configured ?? configuredItemType(item, context.contentTypeOverrides, true);
  const collectionType = inheritedOverride ?? inheritedItemType(item, parents, context.topFolders, context.contentTypeOverrides);
  return Object.freeze({
    ...context,
    parentPath: item.Path,
    parents: immutable(parents.map(contextItem)),
    configuredCollectionType: configured,
    collectionType,
    collectionTypeSource: inheritedOverride != null ? isCollection(item) ? 'collection-folder' : 'content-type-override'
      : collectionType != null ? 'inherited-content-type' : 'none'
  });
}
