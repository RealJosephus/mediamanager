import { cachedFolderChildren } from './collection-membership.js';
import { idKey, nonemptyId } from './records.js';
import { requireNativeList } from './item-relations.js';
import { nativeFileSystemPathsEqual } from './root-folder-file-data.js';

export async function physicalCollectionFolders(item, state, { enableCache = false, findByPath } = {}) {
  if (enableCache) {
    return requireNativeList(item.PhysicalFolderIds === undefined ? [] : item.PhysicalFolderIds, 'source').map(id => {
      if (!nonemptyId(id)) throw Object.assign(new TypeError("Guid can't be empty (Parameter 'id')"),
        { nativeException: 'ArgumentException', parameterName: 'id', status: 500 });
      return state.byId.get(idKey(id));
    }).filter(folder => folder?.IsFolder);
  }
  const aggregate = state.items.find(entry => entry.Type === 'AggregateFolder');
  const children = aggregate ? cachedFolderChildren(aggregate, state).filter(entry => entry.IsFolder) : [];
  const result = new Map();
  for (const location of requireNativeList(item.PhysicalLocationsList === undefined ? [] : item.PhysicalLocationsList, 'source')) {
    if (nativeFileSystemPathsEqual(location, item.Path)) continue;
    let selected = children.filter(folder => nativeFileSystemPathsEqual(folder.Path, location));
    if (!selected.length) {
      const folder = await findByPath(location, true);
      if (folder?.IsFolder) selected = [folder];
    }
    for (const folder of selected) if (!result.has(idKey(folder.Id))) result.set(idKey(folder.Id), folder);
  }
  return [...result.values()];
}
