import { idKey, nonemptyId, repositoryTopParentId, repositoryIdPresent, repositoryValue } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { cachedFolderChildrenSnapshot } from './folder-cache.js';
import { nativeItemDescriptor } from './native-item-entity.js';


export function userRootFolders(state) {
  const root = userRootItem(state);
  if (!root) return [];
  // UserRootFolder.Children loads the ParentId-scoped cached children, not the
  // UserViews menu or GetChildren(user,true)'s virtual-folder expansion.
  return cachedFolderChildren(root, state).filter(item => nativeItemDescriptor(item.NativeType).family === 'folder');
}

export function userRootItem(state) {
  if (state.liveUserRoot) return state.liveUserRoot;
  return state.items.find(item => item.Type === 'UserRootFolder'
    && (!state.userRootId || idKey(item.Id) === idKey(state.userRootId)));
}

export function cachedFolderChildren(parent, state) {
  const assigned = cachedFolderChildrenSnapshot(parent);
  if (assigned !== undefined) return assigned;
  // Folder.GetCachedChildren uses the repository's default owned/alternate
  // filtering. This finite state projection does not populate a live Folder's
  // Children or ID cache; production catalogues own those collections in SQL.
  return state.items.filter(item => idKey(repositoryValue(item, 'ParentId')) === idKey(parent.Id)
    && (!repositoryIdPresent(item, 'OwnerId') || item.ExtraType != null)
    && (!repositoryIdPresent(item, 'PrimaryVersionId') || !state.items.some(primary => idKey(primary.Id) === idKey(repositoryValue(item, 'PrimaryVersionId'))
      && idKey(repositoryTopParentId(primary)) === idKey(repositoryTopParentId(item))))).sort((left, right) => {
    const a = repositoryValue(left, 'SortName'), b = repositoryValue(right, 'SortName');
    if (a == null) return b == null ? 0 : -1;
    if (b == null) return 1;
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
}

// BaseItem.GetParents follows entity ParentId lookups. Repository AncestorIds,
// TopParentId and CollectionFolder.PhysicalFolderIds are separate contracts.
export function parentChainForItem(item, state) {
  const parents = [], seen = new Set([idKey(item.Id)]);
  let parentId = item.ParentId;
  while (nonemptyId(parentId) && !seen.has(idKey(parentId))) {
    seen.add(idKey(parentId));
    const parent = state.byId.get(idKey(parentId));
    if (!parent) break;
    parents.push(parent);
    parentId = parent.ParentId;
  }
  return parents;
}

export function collectionFoldersForItem(item, state, folders = userRootFolders(state)) {
  let root = item;
  const seen = new Set();
  while (root && !seen.has(idKey(root.Id))) {
    seen.add(idKey(root.Id));
    const parent = state.byId.get(idKey(root.ParentId));
    if (parent?.Type === 'AggregateFolder') break;
    if (parent) { root = parent; continue; }
    const owner = state.byId.get(idKey(root.OwnerId));
    if (!owner) break;
    root = owner;
  }
  if (!root) return [];
  const nullablePathEquals = (left, right) => left == null || right == null ? left == null && right == null
    : ordinalIgnoreCaseKey(left) === ordinalIgnoreCaseKey(right);
  const spanKey = ordinalIgnoreCaseKey(root.Path ?? '');
  // This source method compares strings, not normalized filesystem paths.
  // String.Equals distinguishes null from empty; ReadOnlySpan<char> does not.
  return folders.filter(folder => {
    if (nullablePathEquals(folder.Path, root.Path)) return true;
    // The computed, JsonIgnore PhysicalLocations property is never a stored
    // alias. Only these two Folder subclasses return their persisted list;
    // ordinary Folder locations merely repeat its nonempty Path comparison.
    const locations = ['CollectionFolder', 'AggregateFolder'].includes(folder.Type)
      ? folder.PhysicalLocationsList === undefined ? [] : folder.PhysicalLocationsList : [];
    if (locations === null) throw new TypeError("Value cannot be null. (Parameter 'source')");
    if (!Array.isArray(locations)) throw new TypeError('PhysicalLocationsList must be an array.');
    return locations.some(location => ordinalIgnoreCaseKey(location ?? '') === spanKey);
  });
}

export function boxSetLibraryFolderIds(item, state) {
  if (Array.isArray(item.LibraryFolderIds)) return item.LibraryFolderIds;
  return computeBoxSetLibraryFolderIds(item, state);
}

export function computeBoxSetLibraryFolderIds(item, state) {
  const expanded = new Set([idKey(item.Id)]);
  const folders = userRootFolders(state);
  const ids = new Map();
  const flatten = parent => {
    for (const link of state.links.filter(row => idKey(row.ParentId) === idKey(parent.Id)).sort((a, b) => a.SortOrder - b.SortOrder)) {
      const child = state.byId.get(idKey(link.ChildId));
      if (!child) continue;
      if (child.Type === 'BoxSet') {
        if (expanded.has(idKey(child.Id))) continue;
        expanded.add(idKey(child.Id));
        flatten(child);
      } else for (const folder of collectionFoldersForItem(child, state, folders)) ids.set(idKey(folder.Id), folder.Id);
    }
  };
  flatten(item);
  return [...ids.values()];
}
