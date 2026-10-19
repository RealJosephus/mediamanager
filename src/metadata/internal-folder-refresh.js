import { clearFolderChildIds } from '../library/folder-cache.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { idKey } from '../library/records.js';
import { requireNativeList } from '../library/item-relations.js';

export const internalFolderTypes = Object.freeze(['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'PlaylistsFolder']);
// Carried only by top-level directory validation into its child refreshes.
export const validateCollectionLocations = Symbol('validateCollectionLocations');
const flags = new WeakMap();
const hasFlag = item => ['AggregateFolder', 'CollectionFolder'].includes(item.Type);
const sequenceEquals = (left, right, select = value => value) => {
  left = requireNativeList(left, 'first'); right = requireNativeList(right, 'second');
  return left.length === right.length && left.every((value, index) => select(value) === select(right[index]));
};

export function internalFolderRefreshFlag(item) { return hasFlag(item) ? flags.get(item) ?? false : null; }
export function markInternalFolderRefresh(item, value) {
  if (hasFlag(item)) flags.set(item, Boolean(value));
}

export function recordInternalFolderResolve(item, locations, setLocations = false) {
  if (!hasFlag(item)) throw new TypeError('Resolve args require AggregateFolder or CollectionFolder.');
  // The native string-array SequenceEqual overload treats null as an empty span.
  flags.set(item, internalFolderRefreshFlag(item) || !sequenceEquals(locations, item.PhysicalLocationsList ?? []));
  if (setLocations) item.PhysicalLocationsList = locations;
}

export async function requiresInternalFolderRefresh(item, { baseRequiresRefresh = false, resolveArgs, physicalFolders } = {}) {
  if (baseRequiresRefresh || internalFolderRefreshFlag(item)) return true;
  if (!hasFlag(item)) return false;
  const resolved = await resolveArgs(false);
  if (!sequenceEquals(item.PhysicalLocationsList ?? [], resolved.locations)) return true;
  return item.Type === 'CollectionFolder'
    && !sequenceEquals(item.PhysicalFolderIds, (await physicalFolders()).map(folder => folder.Id), idKey);
}

export function beforeInternalFolderMetadataRefresh(item, baseChanged = false) {
  if (['AggregateFolder', 'UserRootFolder'].includes(item.Type)) clearFolderChildIds(item);
  let changed = baseChanged || internalFolderRefreshFlag(item) === true;
  if (hasFlag(item)) flags.set(item, false);
  if (item.Type === 'UserRootFolder' && ordinalIgnoreCaseEquals(item.Name, 'default')) {
    item.Name = 'Media Folders'; changed = true;
  }
  return changed;
}
