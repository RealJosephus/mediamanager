import { idKey, libraryError } from './records.js';
import { itemTopParentId } from './item-save-tuple.js';

/** Load authoritative persistence around a specific live entity. Repository
 * recursion reads the manager cache while each save retains its own baseline. */
export async function loadLiveItemContext(item, { loadContext, itemCreation }, { allowRetainedItem = false, includeChildren = true } = {}) {
  const loaded = await loadContext(item.Id, { draft: item, includeChildren });
  try {
  // Native SQLite may contain absolute state paths or AppData/Metadata tokens.
  // Compare their configured identity, retaining the exact raw SQL baseline.
  const expandPath = loaded.libraryRuntimeOptions?.expandPath;
  const sourceSnapshot = loaded.snapshot ?? (allowRetainedItem ? itemCreation.retainedRepositorySnapshot(item) : undefined);
  if (!sourceSnapshot || sourceSnapshot.Type !== item.NativeType
    || (expandPath ? expandPath(sourceSnapshot.Path) !== item.Path : sourceSnapshot.Path !== loaded.reversePath(item.Path))) {
    throw Object.assign(new Error('The item changed before its repository lifecycle.'), { code: 'metadata-conflict', status: 409 });
  }
  // Preserve snapshot=undefined for an absent row. Deletion must still
  // detect a row reinserted before its first file or provider side effect.
  loaded.sourceSnapshot = sourceSnapshot;
  if (loaded.snapshot) itemCreation.recordRepositorySnapshot(item, loaded.snapshot);
  if (loaded.parent) await itemCreation.withItem(loaded.parent.Id, parent => {
    if (!parent) return;
    const owner = itemCreation.retainItem(parent), dispose = loaded.dispose.bind(loaded);
    let released = false;
    loaded.dispose = async () => {
      if (released) return; released = true;
      try { owner.release(); await dispose(); }
      finally { await itemCreation.linkedChildren.flushReleases(); }
    };
    loaded.parent = parent;
  });
  loaded.versionItemCache.set(idKey(item.Id), item);
  loaded.reloadMetadataContext = async reference => {
    return itemCreation.withItem(typeof reference === 'string' ? reference : reference.Id, child => {
      if (!child) throw libraryError(404, 'Metadata item not found.');
      return loadLiveItemContext(child, { loadContext, itemCreation });
    });
  };
  return loaded;
  } catch (error) {
    try { await loaded.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}

export async function updateLiveItemRepository(item, { loadContext, itemCreation, updates, updateReason, signal, includeChildren = true }) {
  const loaded = await loadLiveItemContext(item, { loadContext, itemCreation }, { includeChildren });
  try {
    item.NativeTopParentId = itemTopParentId(item, loaded.parents);
    await updates.update(loaded, { Item: item, Images: null }, updateReason, { signal });
    itemCreation.recordRepositorySnapshot(item, loaded.snapshot);
    itemCreation.registerItem(item);
  } finally { await loaded.dispose(); }
}

export function setPrimaryVersion(item, id) {
  item.PrimaryVersionId = id;
  item.PresentationUniqueKey = idKey(id ?? item.Id);
}
