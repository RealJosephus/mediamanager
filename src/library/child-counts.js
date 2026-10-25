import { idKey, nonemptyId, sameId } from './records.js';
import { collectionType } from './user-view-query.js';
import { visibleItem } from './permissions.js';

const originalFolderTypes = new Set(['books', 'musicvideos', 'homevideos', 'photos', 'music', 'boxsets']);

/** Return repository sources, or null when native Folder.GetChildCount must run. */
export function childCountSourceIds(item, state, user, { rootChildren, ...options } = {}) {
  if (!item?.IsFolder) return null;
  if (item.Type === 'CollectionFolder') return item.PhysicalFolderIds ?? [];
  if (item.Type !== 'UserView') return [item.Id];
  const type = collectionType(item);
  if (!originalFolderTypes.has(type) && !['movies', 'tvshows'].includes(type)) return null;
  const parentId = nonemptyId(item.DisplayParentId) ? item.DisplayParentId : item.ParentId;
  const parent = nonemptyId(parentId) && !sameId(parentId, item.Id) ? state.byId.get(idKey(parentId)) : null;
  if (parent?.IsFolder && parent.Type !== 'UserView') return childCountSourceIds(parent, state, user, options);
  if (!['movies', 'tvshows'].includes(type)) return null;
  const root = state.items.find(entry => entry.Type === 'UserRootFolder');
  const children = typeof rootChildren === 'function' ? rootChildren(state, user)
    : rootChildren ?? (root ? state.children(root).filter(entry => visibleItem(entry, user, state, {
      ...options, query: false, checkStandaloneParents: false,
    })) : []);
  const grouped = user?.Configuration?.GroupedFolders ?? [];
  const result = new Map();
  for (const folder of children) {
    if (folder.Type !== 'CollectionFolder' || !grouped.some(id => sameId(id, folder.Id))) continue;
    const folderType = collectionType(folder);
    if (folderType && folderType !== type) continue;
    for (const id of folder.PhysicalFolderIds ?? []) if (!result.has(idKey(id))) result.set(idKey(id), id);
  }
  return [...result.values()];
}
