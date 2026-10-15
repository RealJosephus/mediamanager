import {cloneNativeItemValue} from './native-item-value.js';
import { persistImageMetadata } from '../metadata/persistence.js';
import { saveMetadataItem } from '../metadata/save-item.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { publishNativeImageInfos } from '../metadata/images.js';
import { StorageError } from '../storage/errors.js';
import { sameNativePath } from './native-path.js';
import { repositoryTopParentId, sameId } from './records.js';
import { updateFromResolvedItem } from './resolved-item-update.js';
import { updateLiveItemRepository } from './live-item-repository.js';

export function resolvedItemStructuralSnapshot(item) {
  return {
    Id: item.Id,
    ParentId: item.ParentId,
    TopParentId: repositoryTopParentId(item),
    Path: item.Path,
    Type: item.NativeType ?? item.Type,
    IsFolder: item.IsFolder,
    IsVirtualItem: item.IsVirtualItem,
    OwnerId: item.OwnerId,
    PrimaryVersionId: item.PrimaryVersionId,
    SourceType: item.SourceType,
    CanDelete: item.CanDelete,
    SeriesId: item.SeriesId,
    SeasonId: item.SeasonId,
    IndexNumber: item.IndexNumber,
    ParentIndexNumber: item.ParentIndexNumber
  };
}

/**
 * Runs the primary item's repository lifecycle when Folder.ValidateChildren
 * encounters an existing item.
 */
export class ResolvedItemLifecycleHost {
  constructor({ store, loadContext, updates, images }) {
    if (!store || typeof loadContext !== 'function' || !updates || typeof updates.update !== 'function'
      || !images || typeof images.updateImages !== 'function') {
      throw new TypeError('Resolved-item lifecycle requires persistence, authoritative context, metadata updates and images.');
    }
    Object.assign(this, { store, loadContext, updates, images });
  }

  updateRepository(item, { itemCreation, signal, updateReason = ItemUpdateType.MetadataEdit } = {}) {
    if (!itemCreation || typeof itemCreation.getItemById !== 'function') {
      throw new TypeError('A live repository update requires the item manager cache.');
    }
    return updateLiveItemRepository(item, { loadContext: this.loadContext, itemCreation, updates: this.updates,
      updateReason, signal });
  }

  async apply(reference, { resolved, expected, parent, signal, markIrreversible = () => {} } = {}) {
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)
      || !expected || typeof expected !== 'object' || Array.isArray(expected)) {
      throw new TypeError('Resolved-item lifecycle requires an item draft and structural snapshot.');
    }
    let loaded;
    const reload = async value => {
      const context = await this.loadContext(value);
      context.reloadMetadataContext = reload;
      return context;
    };
    try { loaded = await reload(reference); }
    catch (cause) {
      if (cause?.status !== 404 && cause?.statusCode !== 404) throw cause;
      throw new StorageError('version-changed', 'The resolved item disappeared before its lifecycle began.', { cause });
    }
    try {const item = loaded.item;
    const librarySource = value => value == null || value === 0 || value === 'Library';
    const samePath = item.Path == null || expected.Path == null
      ? item.Path === expected.Path : sameNativePath(item.Path, expected.Path);
    if (!sameId(item.Id, expected.Id)
      || !sameId(item.ParentId, expected.ParentId)
      || !sameId(repositoryTopParentId(item), expected.TopParentId)
      || !sameId(item.OwnerId, expected.OwnerId)
      || !sameId(item.PrimaryVersionId, expected.PrimaryVersionId)
      || (item.NativeType ?? item.Type) !== expected.Type
      || item.IsFolder !== expected.IsFolder
      || item.IsVirtualItem !== expected.IsVirtualItem
      || librarySource(item.SourceType) !== librarySource(expected.SourceType)
      || (item.CanDelete !== false) !== (expected.CanDelete !== false)
      || !samePath
      || !sameId(item.SeriesId, expected.SeriesId)
      || !sameId(item.SeasonId, expected.SeasonId)
      || item.IndexNumber !== expected.IndexNumber
      || item.ParentIndexNumber !== expected.ParentIndexNumber) {
      throw new StorageError('version-changed', 'The resolved item structure changed before its lifecycle began.');
    }
    const updateType = updateFromResolvedItem(loaded.item, resolved);
    const Images = cloneNativeItemValue(loaded.context?.images ?? []);
    const lifecycleLoaded = { ...loaded, context: { ...loaded.context, images: Images } };
    if (parent) {
      if (!sameId(parent.Id, item.ParentId) || !sameId(parent.Id, loaded.parent?.Id)) {
        throw new StorageError('version-changed', 'The resolved item no longer belongs to its validation parent.');
      }
      // Repository reloads remain authoritative; native invalidation targets
      // the live Folder instance that owns this validation operation.
      lifecycleLoaded.parent = parent;
    }
    let irreversible = false;
    const mark = () => {
      if (irreversible) return;
      irreversible = true;
      markIrreversible();
    };
    lifecycleLoaded.onImageRemoteChange = async () => {
      mark();
      await saveMetadataItem(this.updates, lifecycleLoaded, { Item: lifecycleLoaded.item, Images },
        ItemUpdateType.ImageUpdate);
    };

    if (updateType > ItemUpdateType.None) {
      mark();
      const saves = await saveMetadataItem(this.updates, lifecycleLoaded, { Item: lifecycleLoaded.item, Images },
        ItemUpdateType.MetadataImport, { signal });
      return Object.freeze({ branch: 'save', changed: true, imagesChanged: null, saves });
    }

    // Native ValidateChildren does not pass the scan token to this branch.
    const imagesChanged = await this.images.updateImages(lifecycleLoaded, Images, {
      persistImages: value => persistImageMetadata(this.store, lifecycleLoaded, value),
      markIrreversible: mark
    });
    publishNativeImageInfos(item, Images);
    this.updates.library?.itemCreation?.registerItem(item);
    return Object.freeze({ branch: 'images', changed: false, imagesChanged: imagesChanged === true,
      saves: Object.freeze([]) });
    }finally{await loaded.dispose();}
  }
}
