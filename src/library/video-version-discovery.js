import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EMPTY_ID, MIN_DATE, VIDEO_TYPES, idKey, mapRecord, nonemptyId, repositoryTopParentId } from './records.js';
import { nativeGuid } from '../users/native.js';
import { resolveOrdinaryVideoFile, additionalVideoStackParts, movieNativeType, musicVideoNativeType, videoNativeType } from './video-file-resolver.js';
import { ExternalDataManager } from './external-data.js';
import { collectItemDeletionIds, deleteItemsInDatabase } from './item-persistence.js';
import { setFolderChildren } from './folder-cache.js';
import { insertVideoVersions } from '../metadata/persistence.js';
import { DotIgnoreRule } from './dot-ignore-rule.js';
import { shouldIgnoreResolutionCandidate } from './resolution-ignore.js';
import { setResolverInitialValues } from './resolver-initial-values.js';
import { applyNativeItemValues, cloneNativeItemEntity, newNativeItemEntity } from './native-item-entity.js';

export function invalidateVideoParent(parent) {
  if (!parent?.IsFolder) return;
  setFolderChildren(parent, null);
  parent.UserData = null;
}

const apiFor = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
const conflict = () => Object.assign(new Error('A video version changed before independent type cleanup.'),
  { code: 'metadata-conflict', status: 409 });

/** Missing versions resolve outside SaveItems, including after cancellation.
 * SaveItems batch creations share its transaction; owned wrapper creations
 * and wrong-type file/database cleanup commit independently.
 * Only ordinary files are supported, matching the existing production resolver.
 */
export class VideoVersionDiscovery {
  #ownedCreations = new WeakMap();
  constructor({ store, library, vfs, identityMap, ignoreRule = new DotIgnoreRule({ vfs, identityMap }), resolveFile = resolveOrdinaryVideoFile, externalData, logger = {} }) {
    Object.assign(this, { store, library, vfs, identityMap, ignoreRule, resolveFile, logger });
    this.externalData = externalData ?? new ExternalDataManager({ store, vfs, identityMap, logger });
  }

  async lookup(loaded, id) {
    const key = idKey(id);
    if (loaded.versionItemCache.has(key)) return loaded.versionItemCache.get(key);
    const creator = this.library.itemCreation;
    if (!creator) throw new TypeError('Video lookup requires the authoritative native item cache.');
    return creator.withItem(id, item => {
      // A concurrent creation or refresh may publish this operation's live
      // entity while the repository lookup is awaiting I/O.
      if (loaded.versionItemCache.has(key)) return loaded.versionItemCache.get(key);
      if (!item) return null;
      // GetItemById hydrates runtime relations such as LockedFields. The
      // metadata operation owns this exact cached entity across later awaits.
      loaded.adoptVersionItem(item);
      loaded.versionItemCache.set(key, item);
      return item;
    });
  }

  async removeMissingOwnedItem(loaded, item, { reportRemoved, extra = false } = {}) {
    const ownedIds = new Set([idKey(loaded.item.Id), ...(loaded.versionLinks ?? []).filter(link => Number(link.ChildType) === 2).map(link => idKey(link.ChildId))]);
    const validOwner = value => value != null && (extra ? value.ExtraType != null && ownedIds.has(idKey(value.OwnerId))
      : VIDEO_TYPES.has(value.Type) && sameOwnedVideo(value, loaded.item));
    if (!validOwner(item)
      || nonemptyId(item.PrimaryVersionId)) {
      throw conflict();
    }
    const { snapshot, scope } = await this.store.run(async db => {
      const links = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
      if (!isDeepStrictEqual((await db.rows('BaseItems', { where: { Id: loaded.item.Id } }))[0], loaded.snapshot)
        || loaded.versionLinks != null && !isDeepStrictEqual(links, loaded.versionLinks)) throw conflict();
      return { snapshot: (await db.rows('BaseItems', { where: { Id: item.Id } }))[0], scope: await collectItemDeletionIds(db, [item.Id]) };
    });
    if (!snapshot) return;
    if (!validOwner(mapRecord(snapshot)) || [...ownedIds].some(key => scope.has(key))
      || snapshot.Type !== item.NativeType || snapshot.Path !== loaded.reversePath(item.Path)
      || nonemptyId(snapshot.PrimaryVersionId)) throw conflict();
    // The native owned-file branch calls DeleteItem without a request token.
    // Internal/extracted file cleanup precedes its independent DB transaction.
    await this.externalData.deleteInternalItemFiles(item, { loaded });
    await this.externalData.deleteItemFiles(item, { loaded });
    const report = await this.store.serializeWrites(async () => {
      let committedLinks;
      const removed = await this.store.transaction(async db => {
        const current = (await db.rows('BaseItems', { where: { Id: item.Id } }))[0];
        if (current && !isDeepStrictEqual(current, snapshot)
          || !isDeepStrictEqual((await db.rows('BaseItems', { where: { Id: loaded.item.Id } }))[0], loaded.snapshot)) throw conflict();
        const links = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
        if (loaded.versionLinks != null && !isDeepStrictEqual(links, loaded.versionLinks)) throw conflict();
        if (!current) { committedLinks = links; return new Set(); }
        const removed = await deleteItemsInDatabase(db, [item.Id]);
        if (!isDeepStrictEqual(removed, new Set(scope.keys()))) throw conflict();
        committedLinks = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
        return removed;
      });
      loaded.versionLinks = committedLinks;
      for (const key of removed) {
        loaded.versionItemCache.delete(key);
        this.library.itemCreation?.unregisterItem(key);
      }
      const parent = loaded.versionItemCache.get(idKey(item.OwnerId)) ?? loaded.item;
      invalidateVideoParent(parent);
      if (removed.has(idKey(item.Id))) {
        const detached = cloneNativeItemEntity(item); detached.ParentId = EMPTY_ID;
        return { item: detached, parent };
      }
    });
    if (report) reportRemoved?.(report.item, report.parent);
  }

  async #resolveFile(loaded, identityPath, expectedType, { preview = false } = {}) {
    const api = apiFor(identityPath);
    const accessPath = this.identityMap.resolve({ itemId: loaded.getNewItemId(identityPath, expectedType), identityPath,
      style: api === path.win32 ? 'windows' : 'posix' });
    let entry;
    try { entry = await this.vfs.stat(accessPath); }
    catch (error) {
      if (error.code !== 'not-found') throw error;
      if (preview) return null;
      // ManagedFileSystem.GetFileSystemInfo guesses DirectoryInfo after an
      // absent extension-bearing file. Resolution still dispatches, and its
      // Folder fallback cannot be used as a video alternate.
      const name = api.basename(identityPath), dot = name.lastIndexOf('.');
      entry = { kind: dot >= 0 && dot < name.length - 1 ? 'directory' : 'file', exists: false,
        size: 0n, created: MIN_DATE, modified: MIN_DATE };
    }
    // Native resolution receives FileSystemInfo.FullName; the requested path
    // still supplies the expected ID and the owner's declared path arrays.
    const fullName = api.resolve(identityPath);
    const candidate = { identityPath: fullName, accessPath, entry: { ...entry, name: api.basename(fullName) } };
    if (shouldIgnoreResolutionCandidate(candidate, { parent: loaded.parent,
      applicationRootPath: loaded.libraryRuntimeOptions?.programDataPath
        && apiFor(loaded.libraryRuntimeOptions.programDataPath).join(loaded.libraryRuntimeOptions.programDataPath, 'root') })) return null;
    const ignoreRule = preview ? this.ignoreRule.clone() : this.ignoreRule;
    if (await ignoreRule.shouldIgnore(candidate.identityPath, { isDirectory: entry.kind === 'directory' })) return null;
    const collectionType = loaded.getVideoVersionCollectionType();
    const raw = await this.resolveFile(candidate,
      { nativeType: collectionType === 'movies' ? movieNativeType : collectionType === 'musicvideos' ? musicVideoNativeType : videoNativeType,
        parseName: collectionType === 'movies', loaded, preview });
    if (entry.exists === false || !raw || !VIDEO_TYPES.has(raw.Type)) return null;
    const resolved = applyNativeItemValues(newNativeItemEntity(raw.NativeType), raw);
    if (loaded.parent?.IsFolder) {
      resolved.ParentId = loaded.parent.Id;
      const parentTopParentId = repositoryTopParentId(loaded.parent);
      let topParentId = nonemptyId(parentTopParentId) ? parentTopParentId : null;
      const rootIndex = (loaded.parents ?? []).findIndex(parent => parent.Type === 'AggregateFolder');
      if (!topParentId && rootIndex > 0) topParentId = loaded.parents[rootIndex - 1].Id;
      Object.defineProperty(resolved, 'NativeTopParentId', { value: topParentId,
        enumerable: false, writable: true, configurable: true });
    }
    setResolverInitialValues(resolved, { identityPath, entry, parent: loaded.parent?.IsFolder ? loaded.parent : null,
      parents: loaded.parents, metadataConfiguration: loaded.metadataConfiguration });
    if (raw.NativeType !== expectedType) {
      // Activator.CreateInstance, not a spread: native coercion intentionally
      // loses resolver ownership, timestamps, size, locks and all other data.
      const coerced = newNativeItemEntity(expectedType);
      for (const key of ['Path', 'Name', 'VideoType', 'ProductionYear', 'ExtraType']) coerced[key] = resolved[key];
      coerced.Id = nativeGuid(loaded.getNewItemId(identityPath, expectedType));
      return coerced;
    }
    resolved.Id = nativeGuid(loaded.getNewItemId(identityPath, expectedType));
    return resolved;
  }

  async resolveAlternateVersion(loaded, identityPath, expectedType, { preview = false, reportRemoved, baseline = loaded } = {}) {
    if (!preview && expectedType !== videoNativeType) {
      const wrongId = nativeGuid(loaded.getNewItemId(identityPath, videoNativeType));
      const wrong = await this.lookup(loaded, wrongId);
      if (wrong && VIDEO_TYPES.has(wrong.Type)) {
        const snapshot = await this.store.run(async db => (await db.rows('BaseItems', { where: { Id: wrong.Id } }))[0]);
        // Native fast deletion deliberately leaves the media source untouched.
        await this.externalData.deleteInternalItemFiles(wrong, { loaded });
        await this.externalData.deleteItemFiles(wrong, { loaded });
        const report = await this.store.serializeWrites(async () => {
          let committedLinks;
          const removed = await this.store.transaction(async db => {
            if (!isDeepStrictEqual((await db.rows('BaseItems', { where: { Id: wrong.Id } }))[0], snapshot)) throw conflict();
            const links = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
            if (baseline.versionLinks != null && !isDeepStrictEqual(links, baseline.versionLinks)) throw conflict();
            const removed = await deleteItemsInDatabase(db, [wrong.Id]);
            committedLinks = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
            return removed;
          });
          // Internal link cleanup advances only its own committed baseline, not
          // unrelated concurrent edits. Later SaveItems failures keep it.
          baseline.versionLinks = loaded.versionLinks = committedLinks;
          for (const key of removed) {
        loaded.versionItemCache.delete(key);
        this.library.itemCreation?.unregisterItem(key);
      }
          const staleParent = loaded.versionItemCache.get(idKey(wrong.ParentId));
          invalidateVideoParent(staleParent);
          return { item: wrong, parent: loaded.versionItemCache.get(idKey(wrong.OwnerId)) ?? staleParent };
        });
        reportRemoved?.(report.item, report.parent);
      }
    }
    return this.#resolveFile(loaded, identityPath, expectedType, { preview });
  }

  async createOwnedVideo(loaded, identityPath, expectedType, { alternate = false, validate, reportAdded, reportRemoved } = {}) {
    const key = idKey(loaded.getNewItemId(identityPath, expectedType));
    let creations = this.#ownedCreations.get(loaded);
    if (!creations) { creations = new Map(); this.#ownedCreations.set(loaded, creations); }
    if (creations.has(key)) {
      const resolved = await creations.get(key);
      return resolved && { ...resolved, created: false };
    }
    const task = this.#createOwnedVideo(loaded, identityPath, expectedType, { alternate, validate, reportAdded, reportRemoved });
    creations.set(key, task);
    try { return await task; } finally { creations.delete(key); }
  }

  async #createOwnedVideo(loaded, identityPath, expectedType, { alternate, validate, reportAdded, reportRemoved }) {
    const id = nativeGuid(loaded.getNewItemId(identityPath, expectedType));
    if (idKey(id) === idKey(loaded.item.Id)) throw conflict();
    const existing = await this.lookup(loaded, id);
    if (existing) return { item: existing, created: false };
    const own = item => {
      if (!item) return null;
      item.OwnerId = loaded.item.Id; item.IsInMixedFolder = loaded.item.IsInMixedFolder;
      if (alternate) { item.PrimaryVersionId = loaded.item.Id; item.PresentationUniqueKey = idKey(loaded.item.Id); }
      return item;
    };
    // Alternate coercion can independently delete a wrong-type item. Validate
    // its prospective network writers before those irreversible file effects.
    if (alternate && validate) {
      const draft = own(await this.#resolveFile(loaded, identityPath, expectedType, { preview: true }));
      if (draft) await validate(draft);
    }
    const item = own(alternate ? await this.resolveAlternateVersion(loaded, identityPath, expectedType, { reportRemoved })
      : await this.#resolveFile(loaded, identityPath, expectedType));
    if (!item) return null;
    if (!alternate) await validate?.(item);
    await this.store.serializeWrites(async () => {
      await this.store.transaction(async db => {
        const owner = (await db.rows('BaseItems', { where: { Id: loaded.item.Id } }))[0];
        const links = await db.rows('LinkedChildren', { where: { ParentId: loaded.item.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
        if (!isDeepStrictEqual(owner, loaded.snapshot) || loaded.versionLinks != null && !isDeepStrictEqual(links, loaded.versionLinks)
          || (await db.rows('BaseItems', { where: { Id: id } })).length) throw conflict();
        // Native CreateItem uses CancellationToken.None. Its new row remains
        // committed when the following child provider observes cancellation.
        await insertVideoVersions(db, loaded, [item]);
      });
      loaded.versionItemCache.set(idKey(item.Id), item);
      invalidateVideoParent(loaded.parent);
    });
    reportAdded?.(item, loaded.parent);
    return { item, created: true };
  }

  async previewOwnedParts(loaded) {
    if (!VIDEO_TYPES.has(loaded.item.Type)) return [];
    const result = [], seen = new Set();
    for (const identityPath of loaded.item.AdditionalParts ?? []) {
      const id = loaded.getNewItemId(identityPath, videoNativeType), key = idKey(id);
      if (seen.has(key) || await this.lookup(loaded, id)) continue;
      seen.add(key);
      const item = await this.#resolveFile(loaded, identityPath, videoNativeType, { preview: true });
      if (!item) continue;
      item.OwnerId = loaded.item.Id; item.IsInMixedFolder = loaded.item.IsInMixedFolder;
      result.push(item);
    }
    return result;
  }

  async #missing(loaded, options) {
    if (!VIDEO_TYPES.has(loaded.item.Type)) return [];
    const paths = loaded.item.LocalAlternateVersions;
    if (paths === null) throw Object.assign(new TypeError('A native video version array cannot be null.'), { nativeException: 'NullReferenceException' });
    const nativeType = loaded.item.NativeType;
    const seen = new Set([idKey(loaded.item.Id), ...(options.knownItems ?? []).map(item => idKey(item.Id))]), result = [];
    for (const identityPath of paths ?? []) {
      if (identityPath == null || identityPath === '') continue;
      const id = nativeGuid(loaded.getNewItemId(identityPath, nativeType)), key = idKey(id);
      if (seen.has(key) || await this.lookup(loaded, id)) continue;
      const item = await this.resolveAlternateVersion(loaded, identityPath, nativeType, options);
      if (!item) continue;
      seen.add(key);
      item.OwnerId = loaded.item.Id; item.PrimaryVersionId = loaded.item.Id;
      item.PresentationUniqueKey = idKey(loaded.item.Id); item.IsInMixedFolder = loaded.item.IsInMixedFolder;
      if (!item.AdditionalParts?.length) {
        try {
          const api = apiFor(identityPath), accessPath = this.identityMap.resolve({ identityPath: api.dirname(identityPath),
            style: api === path.win32 ? 'windows' : 'posix' });
          const siblings = (await this.vfs.list(accessPath)).entries.map(entry => ({ entry, identityPath: api.join(api.dirname(identityPath), entry.name) }));
          item.AdditionalParts = additionalVideoStackParts(identityPath, siblings);
        } catch (error) { this.logger.warn?.(error, `Failed to enumerate siblings to detect stack for ${identityPath}`); }
      }
      result.push(item);
    }
    return result;
  }

  preview(loaded) { return this.#missing(loaded, { preview: true }); }

  prepareCreation(loaded, options = {}) { return this.#missing(loaded, options); }

  async prepare(loaded, options = {}) {
    if (VIDEO_TYPES.has(loaded.item.Type)) {
      const kept = new Set((loaded.item.LocalAlternateVersions ?? []).filter(Boolean)
        .map(value => idKey(loaded.getNewItemId(value, loaded.item.NativeType))));
      for (const id of await loaded.getLocalAlternateVersionIds()) if (!kept.has(idKey(id))) loaded.versionItemCache.delete(idKey(id));
    }
    return this.#missing(loaded, options);
  }
}

const sameOwnedVideo = (item, owner) => nonemptyId(item.OwnerId) && idKey(item.OwnerId) === idKey(owner.Id);
