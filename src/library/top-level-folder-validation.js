import { getNewItemId } from '../core/identity.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { validateCollectionLocations } from '../metadata/internal-folder-refresh.js';
import { nativeGuid } from '../users/native.js';
import { EMPTY_ID, idKey, nonemptyId, sameId } from './records.js';
import { newNativeItemEntity } from './native-item-entity.js';
import { setResolverInitialValues } from './resolver-initial-values.js';
import { nativeFileName, nativeFileNameWithoutExtension, nativePathKey, sameNativePath } from './native-path.js';
import { isFileProtocol } from './owned-items.js';
import { parseNativeCollectionType } from './scan-context.js';
import { loadPostgresNavigationRows } from './postgres-library-query.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const physicalFolderNativeType = 'MediaBrowser.Controller.Entities.Folder';
export const collectionFolderNativeType = 'MediaBrowser.Controller.Entities.CollectionFolder';

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const inaccessible = error => ['not-found', 'unmapped-path', 'invalid-path', 'not-directory', 'ENOTDIR',
  'permission-denied', 'authentication-required'].includes(error?.code);
const immutable = values => Object.freeze(values.map(value => Object.freeze(value)));

export function collectionTypeFromMarkers(files) {
  return files
    .filter(file => !file.IsDirectory && /\.collection$/iu.test(nativeFileName(file.Path)))
    .map(file => parseNativeCollectionType(nativeFileNameWithoutExtension(file.Path), false))
    .find(value => value != null) ?? null;
}

/**
 * Reconciles the two special root levels that ordinary media resolvers must
 * never claim: configured CollectionFolder directories below UserRootFolder,
 * and their shared physical Folder targets below AggregateFolder.
 */
export class TopLevelFolderValidationService {
  #ownership = new AsyncLocalStorage();
  constructor({ library, itemCreation, loadContext, metadataScanner, optionsStore,
    metadataConfiguration = { UseFileCreationTimeForDateAdded: true }, configuration = {}, clock = () => new Date() } = {}) {
    if (!library?.store || !itemCreation || typeof loadContext !== 'function') {
      throw new TypeError('Top-level folder validation requires library persistence, item creation and metadata context.');
    }
    Object.assign(this, { library, store: library.store, itemCreation, loadContext, metadataScanner,
      metadataConfiguration, configuration, optionsStore, clock });
    this.capabilities = Object.freeze({ reconcilesTopLevelConfiguration: true });
  }

  supports(item) { return ['AggregateFolder', 'UserRootFolder'].includes(itemType(item)); }

  async #state(signal) {
    const state = await this.store.run(async db => this.library.load(db, null,
      { includeUserData: false, baseRows: await loadPostgresNavigationRows(db) }),
    { signal, readOnly: true, lockTimeoutMs: 250 });
    this.#ownership.getStore().push(() => state.dispose());
    return state;
  }

  async #directChildren(parent, signal) {
    const state = await this.#state(signal);
    return state.items.filter(item => sameId(item.ParentId, parent.Id)
      && !nonemptyId(item.OwnerId) && !nonemptyId(item.PrimaryVersionId));
  }

  #newItem(nativeType, file, parent, parents) {
    const item = newNativeItemEntity(nativeType);
    const owner=this.itemCreation.retainItem(item);
    this.#ownership.getStore().push(()=>owner.release());
    item.Id = nativeGuid(getNewItemId(file.Path, nativeType, {
      programDataPath: this.library.options.programDataPath,
      enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
    }));
    return setResolverInitialValues(item, {
      identityPath: file.Path,
      entry: { kind: 'directory', name: file.Name ?? nativeFileName(file.Path) },
      parent,
      parents,
      metadataConfiguration: this.metadataConfiguration,
      clock: this.clock
    });
  }

  async #directoryHasContent(item, signal, allowRemoveRoot) {
    if (!allowRemoveRoot && ordinalIgnoreCaseEquals(nativeFileNameWithoutExtension(item.Path), 'collections')) return true;
    try {
      const loaded = await this.loadContext(item.Id, { draft: item });
      const info = await loaded.fileSystemMetadata(signal);
      if (!info?.exists || info.kind !== 'directory') return false;
      return (await loaded.rootFolderResolveArgs(false)).files.length > 0;
    } catch (error) {
      if (inaccessible(error)) return false;
      throw error;
    }
  }

  async #refreshChildren(children, options) {
    if (!options.refreshChildMetadata || !children.length || !this.metadataScanner) return null;
    const { recursive, refreshChildMetadata, allowRemoveRoot, reportProgress, ...metadataOptions } = options;
    const cohort=await createNativeItemCohort({linkedChildren:this.loadContext.linkedChildren});
    try {
      let ordinal=0n;
      for(const item of children){const owner=this.itemCreation.retainItem(item);
        try{await cohort.capture(item,{ordinal:++ordinal});}finally{owner.release();}
      }
      const sequence=metadataChildSequence(cohort,this.loadContext.linkedChildren,this.store);
      try {return await this.metadataScanner.refreshAccessibleChildren(sequence, {
        ...metadataOptions,[validateCollectionLocations]:true
      }, {recursive:false,reportProgress});} finally {await sequence.close();}
    } finally {await cohort.release();await this.loadContext.linkedChildren.flushReleases();}
  }

  async #validateAggregate(parent, options) {
    options.signal?.throwIfAborted();
    const loaded = await this.loadContext(parent.Id, { draft: parent });
    const resolution = await loaded.rootFolderResolveArgs(false);
    const candidates = new Map();
    for (const file of resolution.files) if (file.IsDirectory && file.Exists !== false) {
      candidates.set(nativePathKey(file.Path), file);
    }
    const current = (await this.#directChildren(parent, options.signal)).filter(item => itemType(item) === 'Folder');
    const currentById = new Map(current.map(item => [idKey(item.Id), item]));
    const currentByPath = new Map(current.map(item => [nativePathKey(item.Path), item]));
    const created = [], accessible = [], retained = [], removed = [];
    const matched = new Set();
    for (const file of candidates.values()) {
      options.signal?.throwIfAborted();
      const draft = this.#newItem(physicalFolderNativeType, file, parent, loaded.parents);
      const existing = currentById.get(idKey(draft.Id)) ?? currentByPath.get(nativePathKey(file.Path));
      if (existing) {
        if (itemType(existing) !== 'Folder' || !sameNativePath(existing.Path, file.Path)) {
          throw Object.assign(new Error('A configured physical library path has conflicting persisted ownership.'), {
            code: 'metadata-conflict', status: 409
          });
        }
        matched.add(idKey(existing.Id));
        retained.push(existing);
        if (await this.#directoryHasContent(existing, options.signal, options.allowRemoveRoot)) accessible.push(existing);
        continue;
      }
      if (!await this.#directoryHasContent(draft, options.signal, options.allowRemoveRoot)) continue;
      created.push(draft);
      accessible.push(draft);
    }
    for (const item of current) {
      options.signal?.throwIfAborted();
      if (matched.has(idKey(item.Id)) || item.CanDelete === false || item.IsRoot
        || !isFileProtocol(item) || !item.Path) continue;
      item.ParentId = EMPTY_ID;
      await this.library.deleteItem(item, { DeleteFileLocation: false }, parent, false);
      removed.push(idKey(item.Id));
    }
    if (created.length) await this.itemCreation.createItems(created, parent, { signal: options.signal });
    const refresh = await this.#refreshChildren(accessible, options);
    return Object.freeze({
      created: immutable(created.map(item => ({ Id: item.Id, Path: item.Path, Type: item.Type }))),
      retained: immutable(retained.map(item => ({ Id: item.Id, Path: item.Path, Type: item.Type }))),
      removed: immutable([...new Set(removed)].map(Id => ({ Id }))),
      refresh
    });
  }

  async #prepareCollection(file, parent, parents, signal) {
    const item = this.#newItem(collectionFolderNativeType, file, parent, parents);
    await this.optionsStore?.bind(item.Id, file.Path);
    const loaded = await this.loadContext(item.Id, { draft: item });
    const resolved = await loaded.rootFolderResolveArgs(true);
    item.CollectionType = collectionTypeFromMarkers(resolved.files);
    item.PhysicalFolderIds = (await loaded.physicalFolders(false)).map(folder => folder.Id);
    signal?.throwIfAborted();
    return item;
  }

  async #validateUserRoot(parent, options) {
    options.signal?.throwIfAborted();
    const loaded = await this.loadContext(parent.Id, { draft: parent });
    const resolution = await loaded.rootFolderResolveArgs(false);
    const candidates = new Map();
    for (const file of resolution.files) if (file.IsDirectory && file.Exists !== false) {
      candidates.set(nativePathKey(file.Path), file);
    }
    const current = (await this.#directChildren(parent, options.signal))
      .filter(item => itemType(item) === 'CollectionFolder');
    const currentById = new Map(current.map(item => [idKey(item.Id), item]));
    const currentByPath = new Map(current.map(item => [nativePathKey(item.Path), item]));
    const created = [], retained = [], accessible = [];
    for (const file of candidates.values()) {
      options.signal?.throwIfAborted();
      const id = nativeGuid(getNewItemId(file.Path, collectionFolderNativeType, {
        programDataPath: this.library.options.programDataPath,
        enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
      }));
      const existing = currentById.get(idKey(id)) ?? currentByPath.get(nativePathKey(file.Path));
      if (existing) {
        if (itemType(existing) !== 'CollectionFolder' || !sameNativePath(existing.Path, file.Path)) {
          throw Object.assign(new Error('A configured collection directory has conflicting persisted ownership.'), {
            code: 'metadata-conflict', status: 409
          });
        }
        await this.optionsStore?.bind(existing.Id, file.Path);
        retained.push(existing);
        accessible.push(existing);
        continue;
      }
      const item = await this.#prepareCollection(file, parent, loaded.parents, options.signal);
      created.push(item);
      accessible.push(item);
    }
    if (created.length) {
      await this.itemCreation.saveItems(created, { signal: options.signal, creationIntent: 'library-save' });
      for (const item of created) {
        this.itemCreation.registerItem(item);
        this.library.reportItemAdded(item, parent);
      }
    }
    const refresh = await this.#refreshChildren(accessible, options);
    return Object.freeze({
      created: immutable(created.map(item => ({ Id: item.Id, Path: item.Path, Type: item.Type,
        CollectionType: item.CollectionType, PhysicalFolderIds: [...item.PhysicalFolderIds] }))),
      retained: immutable(retained.map(item => ({ Id: item.Id, Path: item.Path, Type: item.Type }))),
      refresh
    });
  }

  async validateChildren(parent, options = {}) {
    const cleanups=[];
    return this.#ownership.run(cleanups, () => this.loadContext.withScope(async () => {
      let failure;
      const owner=parent?this.itemCreation.retainItem(parent):null;
      try {return await this.#validateChildren(parent,options);}
      catch(error){failure=error;throw error;}
      finally{
        const errors=[];
        for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){errors.push(error);}
        owner?.release();
        try{await this.loadContext.linkedChildren.flushReleases();}catch(error){errors.push(error);}
        if(errors.length)throw new AggregateError(failure?[failure,...errors]:errors,'Top-level validation ownership cleanup failed.',failure?{cause:failure}:undefined);
      }
    }));
  }

  async #validateChildren(parent, options) {
    if (!this.supports(parent) || parent.IsFolder !== true || typeof parent.Id !== 'string'
      || typeof parent.Path !== 'string' || !parent.Path) {
      throw new TypeError('Top-level validation requires an AggregateFolder or UserRootFolder.');
    }
    if (options.recursive === true) throw new TypeError('Top-level folder validation is nonrecursive.');
    const normalized = {
      ...options,
      recursive: false,
      refreshChildMetadata: options.refreshChildMetadata !== false,
      reportProgress: options.reportProgress ?? (() => {})
    };
    const result = itemType(parent) === 'AggregateFolder'
      ? await this.#validateAggregate(parent, normalized)
      : await this.#validateUserRoot(parent, normalized);
    normalized.reportProgress(100);
    return result;
  }
}

/** Update CollectionFolder-owned location state before its repository save. */
export async function refreshCollectionFolderLocations(loaded) {
  if (loaded.item.Type !== 'CollectionFolder') return ItemUpdateType.None;
  const beforeLocations = [...(loaded.item.PhysicalLocationsList ?? [])];
  const beforeIds = [...(loaded.item.PhysicalFolderIds ?? [])].map(idKey);
  await loaded.rootFolderResolveArgs(true);
  const physicalIds = (await loaded.physicalFolders(false)).map(folder => folder.Id);
  loaded.item.PhysicalFolderIds = physicalIds;
  const changed = beforeLocations.length !== loaded.item.PhysicalLocationsList.length
    || beforeLocations.some((value, index) => value !== loaded.item.PhysicalLocationsList[index])
    || beforeIds.length !== physicalIds.length
    || beforeIds.some((value, index) => value !== idKey(physicalIds[index]));
  return changed ? ItemUpdateType.MetadataImport : ItemUpdateType.None;
}
