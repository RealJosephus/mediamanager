import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { validateCollectionLocations } from '../metadata/internal-folder-refresh.js';
import { clrTrim } from '../metadata/whitespace.js';
import { nativeGuid } from '../users/native.js';
import { idKey, nonemptyId, sameId } from './records.js';
import { newNativeItemEntity, publishNativeItemLinks } from './native-item-entity.js';
import { setResolverInitialValues } from './resolver-initial-values.js';
import { nativeFileName, nativeFileNameWithoutExtension, nativePathKey, sameNativePath } from './native-path.js';
import { parseNativeCollectionType } from './scan-context.js';
import { loadPostgresNavigationRows } from './postgres-library-query.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { clearFolderChildIds, releaseCachedFolderChildren, setFolderChildren } from './folder-cache.js';

export const physicalFolderNativeType = 'MediaBrowser.Controller.Entities.Folder';
export const collectionFolderNativeType = 'MediaBrowser.Controller.Entities.CollectionFolder';

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const immutable = values => Object.freeze(values.map(value => Object.freeze(value)));
const hostPath = process.platform === 'win32' ? path.win32 : path.posix;
const hostPathSeparator = value => process.platform === 'win32' ? value === '\\' || value === '/' : value === '/';

// ManagedFileSystem.AreEqual follows the current host, not the spelling of a
// persisted path. Path.TrimEndingDirectorySeparator removes one non-root
// separator; blank paths are never equal, including two null values.
function managedFileSystemPathsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !clrTrim(left) || !clrTrim(right)) return false;
  const trim = value => hostPathSeparator(value.at(-1)) && value.length > hostPath.parse(value).root.length
    ? value.slice(0, -1) : value;
  const normalizedLeft = trim(left), normalizedRight = trim(right);
  return process.platform === 'win32'
    ? ordinalIgnoreCaseEquals(normalizedLeft, normalizedRight)
    : normalizedLeft === normalizedRight;
}

function linkedChildEquals(left, right) {
  if (left.Type !== right.Type) return false;
  if (left.ItemId != null && right.ItemId != null) return sameId(left.ItemId, right.ItemId);
  return managedFileSystemPathsEqual(left.Path, right.Path);
}

async function* linkedRows(linkedChildren, handle, session) {
  // plan(null) preserves Folder.LinkedChildren's native null-sequence failure
  // before pages attempts to retain the relation.
  if (handle === null) linkedChildren.plan(handle);
  for await (const page of linkedChildren.pages(handle, { session })) yield* page;
}

async function linkedChildrenSequenceEqual(linkedChildren, left, right, session) {
  const iterators = [linkedRows(linkedChildren, left, session)[Symbol.asyncIterator](),
    linkedRows(linkedChildren, right, session)[Symbol.asyncIterator]()];
  let equal = false, failure;
  try {
    for (;;) {
      const leftRow = await iterators[0].next(), rightRow = await iterators[1].next();
      if (leftRow.done || rightRow.done) { equal = leftRow.done === rightRow.done; break; }
      if (!linkedChildEquals(leftRow.value, rightRow.value)) break;
    }
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  for (const iterator of iterators) try { await iterator.return?.(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
    failure?.message ?? 'Linked-child comparison cleanup failed.', failure ? { cause: failure } : undefined);
  if (failure) throw failure;
  return equal;
}

async function appendFolderLinkedChildren(linkedChildren, writer, folder, session) {
  let temporary, failure;
  try {
    const source = folder.LinkedChildrenLoaded ? folder.LinkedChildren
      : temporary = await linkedChildren.load(session, folder.Id);
    if (source === null) linkedChildren.plan(source);
    for await (const page of linkedChildren.pages(source, { session })) {
      for (const row of page) await writer.append(row);
    }
  } catch (error) { failure = error; }
  if (temporary) {
    try { await linkedChildren.release(temporary, { session }); }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], failure.message, { cause: failure });
      throw error;
    }
  }
  if (failure) throw failure;
}

async function refreshCollectionFolderLinkedChildren(loaded, physicalFolders) {
  const linkedChildren = loaded.linkedChildren, item = loaded.item;
  return linkedChildren.withSession(async session => {
    let writer, replacement, currentTemporary, changed, failure, published = false;
    try {
      writer = await linkedChildren.createWriter({ session, parentId: item.Id });
      for (const folder of physicalFolders) await appendFolderLinkedChildren(linkedChildren, writer, folder, session);
      replacement = await writer.finish();
      const current = item.LinkedChildrenLoaded ? item.LinkedChildren
        : currentTemporary = await linkedChildren.load(session, item.Id);
      changed = !await linkedChildrenSequenceEqual(linkedChildren, replacement, current, session);
      if (currentTemporary) {
        await linkedChildren.release(currentTemporary, { session }); currentTemporary = null;
      }
      // Native CollectionFolder assigns the freshly flattened sequence even
      // when its comparer says that no repository save is required.
      try { publishNativeItemLinks(item, replacement); published = true; }
      catch (error) { published = item.LinkedChildren === replacement; throw error; }
    } catch (error) { failure = error; }

    const cleanupErrors = [];
    try { await writer?.abort(); } catch (error) { cleanupErrors.push(error); }
    if (currentTemporary) try { await linkedChildren.release(currentTemporary, { session }); }
    catch (error) { cleanupErrors.push(error); }
    if (replacement && !published) try { await linkedChildren.release(replacement, { session }); }
    catch (error) { cleanupErrors.push(error); }
    try { await linkedChildren.flushReleases({ session }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      failure?.message ?? 'CollectionFolder linked-child cleanup failed.', failure ? { cause: failure } : undefined);
    if (failure) throw failure;
    return changed;
  });
}

export function collectionTypeFromMarkers(files) {
  return files
    .filter(file => !file.IsDirectory && /\.collection$/iu.test(nativeFileName(file.Path)))
    .map(file => parseNativeCollectionType(nativeFileNameWithoutExtension(file.Path), false))
    .find(value => value != null) ?? null;
}

/**
 * Reconciles configured CollectionFolder directories below UserRootFolder.
 * AggregateFolder uses the same independently committed child validation
 * and recursive traversal as ordinary folders.
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

  async #refreshChildren(children, options) {
    if (!options.refreshChildMetadata || !children.length || !this.metadataScanner) return null;
    const { recursive, refreshChildMetadata, allowRemoveRoot, reportProgress, ...metadataOptions } = options;
    const cohort=await createNativeItemCohort({linkedChildren:this.loadContext.linkedChildren,
      resolveLiveItem:id=>children.find(item=>idKey(item.Id)===idKey(id))});
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

  async #prepareCollection(file, parent, parents, signal) {
    const item = this.#newItem(collectionFolderNativeType, file, parent, parents);
    await this.optionsStore?.bind(item.Id, file.Path);
    const loaded = await this.loadContext(item.Id, { draft: item });
    const resolved = await loaded.rootFolderResolveArgs(true);
    item.CollectionType = collectionTypeFromMarkers(resolved.files);
    signal?.throwIfAborted();
    return item;
  }

  async #validateUserRoot(parent, options) {
    releaseCachedFolderChildren(parent);
    clearFolderChildIds(parent);
    options.signal?.throwIfAborted();
    const loaded = await this.loadContext(parent.Id, { draft: parent });
    const resolution = await loaded.rootFolderResolveArgs(false);
    const candidates = new Map();
    for (const file of resolution.files) if (file.IsDirectory && file.Exists !== false) {
      candidates.set(nativePathKey(file.Path), file);
    }
    const currentChildren = await this.#directChildren(parent, options.signal);
    setFolderChildren(parent, currentChildren);
    const current = currentChildren.filter(item => itemType(item) === 'CollectionFolder');
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
      // Folder validation invalidates Children after creating siblings. A
      // metadata lookup during resolution may already have warmed an empty
      // UserRoot list; child refresh must see the newly committed libraries.
      releaseCachedFolderChildren(parent);
      clearFolderChildIds(parent);
    }
    // Metadata lookups and the later root pass must share the actual matched
    // children, including refreshed location state. Keep stale directories in
    // this snapshot until the existing deletion pass examines them.
    setFolderChildren(parent, [...currentChildren, ...created]);
    const refresh = await this.#refreshChildren(accessible, options);
    clearFolderChildIds(parent);
    for (const item of [...currentChildren, ...created]) this.itemCreation.registerItem(item);
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
    if (itemType(parent) === 'AggregateFolder') return this.library.validateChildren(parent, options);
    if (options.recursive === true) throw new TypeError('User root folder validation is nonrecursive.');
    const normalized = {
      ...options,
      recursive: false,
      refreshChildMetadata: options.refreshChildMetadata !== false,
      reportProgress: options.reportProgress ?? (() => {})
    };
    const result = await this.#validateUserRoot(parent, normalized);
    normalized.reportProgress(100);
    return result;
  }
}

/** Update CollectionFolder-owned location and linked-child state before its repository save. */
export async function refreshCollectionFolderLocations(loaded) {
  if (loaded.item.Type !== 'CollectionFolder') {
    return Object.freeze({ updateType: ItemUpdateType.None, requiresSave: false });
  }
  const beforeLocations = [...(loaded.item.PhysicalLocationsList ?? [])];
  const beforeIds = [...(loaded.item.PhysicalFolderIds ?? [])].map(idKey);
  await loaded.rootFolderResolveArgs(true);
  // Physical-folder discovery may itself use the max=1 relation repository.
  // Finish it before holding the flattening session to avoid nested admission.
  const physicalFolders = await loaded.physicalFolders(false);
  const linkedChildrenChanged = await refreshCollectionFolderLinkedChildren(loaded, physicalFolders);
  const physicalIds = physicalFolders.map(folder => folder.Id);
  const locationsChanged = beforeLocations.length !== loaded.item.PhysicalLocationsList.length
    || beforeLocations.some((value, index) => value !== loaded.item.PhysicalLocationsList[index]);
  const physicalIdsChanged = beforeIds.length !== physicalIds.length
    || beforeIds.some((value, index) => value !== idKey(physicalIds[index]));
  if (physicalIdsChanged) loaded.item.PhysicalFolderIds = physicalIds;
  return Object.freeze({
    updateType: locationsChanged ? ItemUpdateType.MetadataImport : ItemUpdateType.None,
    // CollectionFolder.RefreshLinkedChildren reports either relation or
    // physical-ID sequence changes through the owned-item ForceSave signal.
    requiresSave: linkedChildrenChanged || physicalIdsChanged
  });
}
