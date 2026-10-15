import { sameId } from '../library/records.js';
import { ItemUpdateType } from './save-manager.js';

export async function beforeSaveBoxSetMetadata(item, loaded) {
  if (item.Type !== 'BoxSet') return ItemUpdateType.None;
  const ids = await loaded.boxSetLibraryFolderIds(item), previous = item.LibraryFolderIds;
  if (previous != null && previous.length === ids.length && previous.every((id, index) => sameId(id, ids[index]))) return ItemUpdateType.None;
  item.LibraryFolderIds = ids;
  return ItemUpdateType.MetadataImport;
}
