import { userDataKeys } from '../sessions/user-data.js';
import { itemSaveRelations } from './item-relations.js';
import { parseNativeCollectionType } from './scan-context.js';

export function itemTopParentId(item, parents = []) {
  const hierarchy = [item, ...parents];
  for (let index = 0; index < hierarchy.length; index++) {
    const current = hierarchy[index], type = String(current.NativeType ?? current.Type).split('.').at(-1);
    const nextType = String(hierarchy[index + 1]?.NativeType ?? hierarchy[index + 1]?.Type).split('.').at(-1);
    if (['PlaylistsFolder', 'Channel'].includes(type)
      || ['UserView', 'CollectionFolder'].includes(type) && parseNativeCollectionType(current.CollectionType, true) === 'livetv'
      || nextType === 'AggregateFolder') return current.Id;
  }
  return null;
}

export async function prepareItemSaveTuple(db, item, { parents = [], collectionFolders = [] } = {}) {
  const keys = await userDataKeys(db, item);
  const relations = itemSaveRelations(item, { parents, collectionFolders });
  return { keys, relations };
}
