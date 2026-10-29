import { availableParallelism } from 'node:os';
import { idKey, nonemptyId, VIDEO_TYPES, MIN_DATE } from './records.js';
import { parentChainForItem } from './collection-membership.js';
import { rootCollectionType } from './root-collection-type.js';
import { invalidateVideoParent } from './video-version-discovery.js';
import { saveNativeItems } from '../metadata/persistence.js';
import { itemTopParentId } from './item-save-tuple.js';
import { hydrateNativeItemEntity, isNativeItemEntity, nativeItemDescriptor, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { metadataFields } from './metadata-context.js';
import { imageTypes } from '../metadata/image-paths.js';
import { readItemImageRows } from './image-order.js';
import { readItemTrailerRows } from './trailer-order.js';
import { loadPostgresNavigationRows,
  loadPostgresPageGraph, loadPostgresRowsByIds } from './postgres-library-query.js';
import { BoundedItemCache } from './bounded-item-cache.js';

const trailerTypes = [null, 'ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'];

function itemScopeFailure(errors) {
  if (errors.length === 1) return errors[0];
  const primary = errors[0];
  let message = 'Item consumer and relation cleanup failed.';
  try { if (primary != null) { const value = primary.message; if (typeof value === 'string') message = value; } }
  catch { /* Diagnostic properties cannot replace an actual failure. */ }
  const failure = new AggregateError(errors, message, { cause: primary });
  for (const name of ['code', 'status', 'statusCode']) {
    try { if (primary != null && Object.hasOwn(primary, name)) failure[name] = primary[name]; }
    catch { /* The original reason remains available even when its getter throws. */ }
  }
  return failure;
}

/** Actual CreateItems boundary: resolve missing alternates before cancellation,
 * save the complete batch, then publish its live entities and original events. */
export class ItemCreationService {
  #registered;
  #repositoryFrames = new WeakMap();
  #cacheLinks = new WeakMap();
  constructor({ store, library, loadContext, linkedChildren, registerItem = () => {} }) {
    if (!store || !library || typeof loadContext !== 'function') throw new TypeError('Item creation requires a native store, library and context loader.');
    if (!linkedChildren) throw new TypeError('Item creation requires the runtime SQL link repository.');
    Object.assign(this, { store, library, loadContext, linkedChildren, onRegister: registerItem });
    this.#registered = new BoundedItemCache(library.options?.configuration?.CacheSize ?? availableParallelism() * 100,
      { onRemove: item => { this.#cacheLinks.get(item)?.release(); this.#cacheLinks.delete(item); } });
  }

  #cacheItem(item) {
    if (!isNativeItemEntity(item)) throw new TypeError('Item registration requires a branded native entity.');
    if (item.IsFolder || VIDEO_TYPES.has(item.Type) || item.Type === 'MusicArtist' || item.Type === 'LiveTvChannel') {
      if (!this.#cacheLinks.has(item)) this.#cacheLinks.set(item, acquireNativeItemLinkOwner(item));
      this.#registered.set(idKey(item.Id), item);
    }
  }

  registerItem(item) { this.#cacheItem(item); this.onRegister(item); }

  retainItem(item) { return acquireNativeItemLinkOwner(item); }

  async withItem(id, operation, options) {
    const item = await this.getItemById(id, options);
    if (!item) return operation(null);
    const owner = this.retainItem(item);
    let value, primary, failed = false;
    try { value = await operation(item); }
    catch (error) { primary = error; failed = true; }
    const failures = failed ? [primary] : [];
    try { owner.release(); } catch (error) { failures.push(error); }
    try { await this.linkedChildren.flushReleases(); } catch (error) { failures.push(error); }
    if (failures.length) throw itemScopeFailure(failures);
    return value;
  }

  /** A captured entity may outlive its row or leave the bounded registry.
   * Only this exact object's observed frame can authorize deletion; clones
   * cannot inherit it, and it never becomes a save baseline. */
  retainedRepositorySnapshot(item) {
    const frame = this.#repositoryFrames.get(item);
    return frame && idKey(frame.Id) === idKey(item.Id) && frame.Type === item.NativeType ? frame : undefined;
  }

  recordRepositorySnapshot(item, snapshot) {
    if (!isNativeItemEntity(item) || !snapshot || idKey(snapshot.Id) !== idKey(item.Id) || snapshot.Type !== item.NativeType) {
      throw new TypeError('A live repository frame requires the same persisted native entity identity.');
    }
    this.#repositoryFrames.set(item, Object.freeze({ ...snapshot }));
  }

  getCachedItemById(id) {return this.#registered.get(idKey(id))??null;}

  unregisterItem(id) { this.#registered.delete(idKey(id)); }

  async getItemById(id, { expandPath = this.library.options.expandPath ?? (value => value) } = {}) {
    const key = idKey(id);
    const cached = this.#registered.get(key);
    if (cached) return cached;
    const item = await this.store.run(async db => {
      const rows = await loadPostgresRowsByIds(db, [id]);
      if (!rows.length) return null;
      const state = await this.library.load(db, null,
        { includeUserData: false, includeFolderLinks: false, includeLinkGraph: false, expandPath, baseRows: rows });
      const stored = state.byId.get(key);
      if (!stored) { await state.dispose({ session: db }); return null; }
      let folderLinks;
      try { const relations = {
        ...(VIDEO_TYPES.has(stored.Type) ? { videoLinks: (await db.rows('LinkedChildren', { where: { ParentId: stored.Id, ChildType: 3 },
          orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(link => ({ ItemId: link.ChildId, Type: Number(link.ChildType) })) } : {}),
        lockedFields: (await db.rows('BaseItemMetadataFields', { where: { ItemId: stored.Id } })).map(row => metadataFields[row.Id] ?? row.Id),
        trailerTypes: (await readItemTrailerRows(db, stored.Id)).map(row => trailerTypes[row.Id] ?? row.Id),
        images: (await readItemImageRows(db, stored.Id)).map(row => ({ Path: expandPath(row.Path), Type: imageTypes[row.ImageType] ?? row.ImageType,
          DateModified: row.DateModified ?? MIN_DATE, Width: row.Width, Height: row.Height,
          BlurHash: row.Blurhash == null ? null : Buffer.from(row.Blurhash).toString('utf8') })),
        userData: await db.rows('UserData', { where: { ItemId: stored.Id } })
      };
      if (nativeItemDescriptor(stored.NativeType).family === 'folder') relations.linkedChildren = folderLinks = await this.linkedChildren.load(db, stored.Id);
      return hydrateNativeItemEntity(stored, relations);
      } catch (error) {
        if (folderLinks) this.linkedChildren.queueRelease(folderLinks);
        await this.linkedChildren.flushReleases({ session: db }); throw error;
      } finally { await state.dispose({ session: db }); }
    });
    if (!item) return null;
    this.recordRepositorySnapshot(item, item.NativeRepositoryColumns);
    this.#cacheItem(item);
    return item;
  }

  async close() {
    this.#registered.clear();
    this.#repositoryFrames = new WeakMap();
    await this.linkedChildren.flushReleases();
  }

  async saveItems(items, { signal, creationIntent = 'library-save' } = {}) {
    signal?.throwIfAborted();
    const contexts = [];
    // Native persistence keeps the last entity of each ID, in first ID order.
    const unique = new Map();
    for (const item of items) unique.set(idKey(item.Id), item);
    let saved, primary, failed = false;
    try { for (const item of unique.values()) {
      const loaded = await this.loadContext(item.Id, { draft: item });
      contexts.push(loaded);
      Object.defineProperty(item, 'NativeTopParentId', { value: itemTopParentId(item, loaded.parents),
        enumerable: false, writable: true, configurable: true });
    }
    saved = await saveNativeItems(this.store, contexts, { signal, creationIntent });
    for (const loaded of contexts) this.recordRepositorySnapshot(loaded.item, loaded.snapshot);
    } catch (error) { primary = error; failed = true; }
    const failures = failed ? [primary] : [];
    for (const loaded of contexts) try { await loaded.dispose(); } catch (error) { failures.push(error); }
    try { await this.linkedChildren.flushReleases(); } catch (error) { failures.push(error); }
    if (failures.length) throw itemScopeFailure(failures);
    return saved;
  }

  async createItems(items, parent = null, { signal, creationIntent = 'library-resolve' } = {}) {
    if (!Array.isArray(items)) throw new TypeError('CreateItems requires a native entity array.');
    return this.store.serializeWrites(async db => {
      const itemOwners = [], contexts = [];
      let state, result, primary, failed = false;
      try {
      for (const item of items) itemOwners.push(this.retainItem(item));
      const allItems = [...items];
      const requestedIds = [parent?.Id, ...items.flatMap(item => [item.ParentId, item.TopParentId])].filter(Boolean);
      // Standalone non-video items need neither alternate-version navigation
      // nor a parent lookup for ItemAdded. Their save contexts still perform
      // the complete per-item persistence before registration and that event.
      if (parent != null || requestedIds.some(nonemptyId) || items.some(item => VIDEO_TYPES.has(item.Type))) {
        const navigationRows = await loadPostgresNavigationRows(db, parent?.Id);
        const requestedRows = await loadPostgresRowsByIds(db, requestedIds);
        const graphRows = await loadPostgresPageGraph(db, requestedRows, navigationRows);
        state = await this.library.load(db, null, { includeUserData: false, includeLinkGraph: false, baseRows: graphRows });
      }
      const parentFolder = parent?.IsFolder ? parent : null;
      const parentCollectionType = parent ? await rootCollectionType(this.library, parent, state) : null;
      for (const item of items) {
        if (!VIDEO_TYPES.has(item.Type)) continue;
        if (item.LocalAlternateVersions === null) throw Object.assign(new TypeError('A native video version array cannot be null.'), { status: 500 });
        if (!item.LocalAlternateVersions?.length) continue;
        const loaded = await this.loadContext(item.Id, { draft: item });
        contexts.push(loaded);
        for (const [key, cached] of this.#registered) loaded.versionItemCache.set(key, cached);
        loaded.parent = parentFolder;
        if (parentFolder) loaded.versionItemCache.set(idKey(parentFolder.Id), parentFolder);
        loaded.parents = parentFolder ? [parentFolder, ...parentChainForItem(parentFolder, state)] : [];
        loaded.getVideoVersionCollectionType = () => parentCollectionType;
        const alternates = await loaded.videoVersionDiscovery.prepareCreation(loaded, { knownItems: allItems,
          reportRemoved: (removed, owner) => { this.#registered.delete(idKey(removed.Id)); this.library.reportItemRemoved(removed, owner); } });
        for (const alternate of alternates) itemOwners.push(this.retainItem(alternate));
        allItems.push(...alternates);
      }
      await this.saveItems(allItems, { signal, creationIntent });
      for (const item of allItems) this.registerItem(item);
      invalidateVideoParent(parent);
      for (const item of items) if (item.SourceType == null || item.SourceType === 'Library' || item.SourceType === 0) {
        this.library.reportItemAdded(item, parent ?? state?.byId.get(idKey(item.ParentId)) ?? null);
      }
      result = allItems;
      } catch (error) { primary = error; failed = true; }
      const failures = failed ? [primary] : [];
      for (const loaded of contexts) try { await loaded.dispose(); } catch (error) { failures.push(error); }
      try { await state?.dispose({ session: db }); } catch (error) { failures.push(error); }
      for (const owner of itemOwners) try { owner.release(); } catch (error) { failures.push(error); }
      try { await this.linkedChildren.flushReleases({ session: db }); } catch (error) { failures.push(error); }
      if (failures.length) throw itemScopeFailure(failures);
      return result;
    });
  }
}
