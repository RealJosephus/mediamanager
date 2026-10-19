import { EMPTY_ID, extraTypeCode, idKey, nonemptyId, sameId, VIDEO_TYPES } from '../library/records.js';
import { nativeContainingFolderPath, sameNativePath } from '../library/native-path.js';
import { inheritOwnedItemDates, prepareOwnedItemRefresh } from './owned-item-refresh.js';
import { saveMetadataItem } from './save-item.js';
import { ItemUpdateType, validateMetadataSaves } from './save-manager.js';
import { supportsOwnedItems, searchesContainingFolderForExtras } from '../library/owned-items.js';
import { isDeepStrictEqual } from 'node:util';

const conflict = message => Object.assign(new Error(message), { code: 'metadata-conflict', status: 409 });
const nativeTypeName = item => item.NativeType;
const assertOwnedVideo = (item, owner, identityPath, nativeType) => {
  if (!item || !VIDEO_TYPES.has(item.Type) || nativeTypeName(item) !== nativeType
    || !sameNativePath(item.Path, identityPath) || !sameId(item.OwnerId, owner.Id)) {
    throw conflict('An owned video must be structurally reconciled before its metadata refresh.');
  }
};
const maintainsExtras = loaded => {
  const owner = loaded.item;
  const searches = value => loaded.searchesContainingFolderForExtras?.(value) ?? searchesContainingFolderForExtras(value);
  return !nonemptyId(owner.PrimaryVersionId) && searches(owner)
    && !(loaded.parent?.IsFolder && searches(loaded.parent) && sameNativePath(loaded.parent.Path, nativeContainingFolderPath(owner)));
};
const extraChanges = (current, found, options, names = new Map(current.map(item => [idKey(item.Id), item.Name]))) => {
  const ids = new Set(found.extras.map(extra => idKey(extra.item.Id)));
  const renamed = new Set(found.extras.filter(extra => names.has(idKey(extra.item.Id)) && names.get(idKey(extra.item.Id)) !== extra.item.Name).map(extra => idKey(extra.item.Id)));
  const refresh = current.length !== found.extras.length || current.some(extra => !ids.has(idKey(extra.Id)))
    || renamed.size > 0 || (options.MetadataRefreshMode ?? 'FullRefresh') === 'FullRefresh' || options.ReplaceAllMetadata;
  return { ids, renamed, refresh };
};
const currentOwnedExtras = (state, owner) => {
  const ownerIds = new Set([idKey(owner.Id), ...state.links.filter(link => VIDEO_TYPES.has(owner.Type) && sameId(link.ParentId, owner.Id) && Number(link.ChildType) === 2).map(link => idKey(link.ChildId))]);
  return state.items.filter(item => item.ExtraType != null && ownerIds.has(idKey(item.OwnerId)));
};
async function completeOwnedRefreshes(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Maintains the owned family before its owner's single-item refresh. */
export class OwnedItemMetadataLifecycleHost {
  constructor({ store, loadContext, updates, registry, refreshOwnedItem }) {
    Object.assign(this, { store, loadContext, updates, registry, refreshOwnedItem });
  }

  async #update(ownerContext, item, changes, reason, options, expected) {
    let loaded = await this.loadContext(item.Id);
    const contexts=new Set([loaded]);try {
    if (expected) assertOwnedVideo(loaded.item, expected.owner, expected.identityPath, expected.nativeType);
    if (expected?.missingPrimaryVersion && nonemptyId(loaded.item.PrimaryVersionId)) {
      throw conflict('A local alternate acquired a primary before its missing-primary repair.');
    }
    const baseline = loaded;
    Object.assign(item, changes);
    loaded = await loaded.loadDraftContext(item);contexts.add(loaded);
    if (!isDeepStrictEqual(loaded.snapshot, baseline.snapshot)
      || !isDeepStrictEqual(loaded.relationships, baseline.relationships)
      || !isDeepStrictEqual(loaded.versionLinks, baseline.versionLinks)) {
      throw conflict('A local alternate changed before its independent save.');
    }
    // Native GetItemById returns the same live entity and physical parent to
    // independent saves and the following provider dispatch.
    if (sameId(loaded.parent?.Id, ownerContext.parent?.Id)) loaded.parent = ownerContext.parent;
    await validateMetadataSaves(loaded, reason, this.registry);
    await saveMetadataItem(this.updates, loaded, { Item: loaded.item, People: null }, reason, { signal: options.signal });
    }finally{for(const context of contexts)await context.dispose();}
  }

  async validateBeforeRefresh(loaded, options) {
    if (!maintainsExtras(loaded) || !['VideoFile', 'Iso', 'Dvd', 'BluRay'].includes(loaded.item.VideoType ?? 'VideoFile')) return;
    const state = await loaded.loadLibraryState();let found;try {
    const current=currentOwnedExtras(state,loaded.item);
    // A read-only discovery failure belongs to the native owned wrapper's
    // logged error boundary. Writer validation below remains a hard D3 gate.
    try { found = await loaded.findOwnedExtras(state, { preview: true }); } catch { return; }
    const { refresh } = extraChanges(current, found, options);
    for (const extra of found.extras) {
      const item = extra.item;
      if (refresh) {
        item.OwnerId = extra.ownerId; item.ParentId = EMPTY_ID; item.NativeTopParentId = null;
        // Preview inheritance before deciding a sidecar destination/filename.
        prepareOwnedItemRefresh(loaded.item, item, options);
      } else if (!inheritOwnedItemDates(loaded.item, item)) continue;
      const draft=await loaded.loadDraftContext(item);try{await validateMetadataSaves(draft, refresh ? ItemUpdateType.MetadataDownload : ItemUpdateType.MetadataEdit, this.registry);}finally{await draft.dispose();}
    }
    }finally{for(const extra of found?.extras??[])await extra.context.dispose();await state.dispose();}
  }

  async beforeRefresh(loaded, options) {
    const owner = loaded.item;
    if (!owner.IsFileProtocol || !(loaded.supportsOwnedItems?.() ?? supportsOwnedItems(owner))) return false;
    const supportsVideo = VIDEO_TYPES.has(owner.Type);
    const maintainExtras = maintainsExtras(loaded);
    if (!maintainExtras && !supportsVideo) return false;
    if (typeof loaded.loadLibraryState !== 'function' || typeof loaded.getNewItemId !== 'function') {
      throw Object.assign(new Error('Owned metadata requires authoritative library state and deterministic identity.'), { status: 501 });
    }
    if (typeof loaded.ownedFileExists !== 'function') {
      throw Object.assign(new Error('Owned metadata requires authoritative file existence checks.'), { status: 501 });
    }
    const state = await loaded.loadLibraryState(),extraContexts=new Set();try {
    let requiresSave = false;
    if (maintainExtras) {
      const currentExtras = currentOwnedExtras(state, owner);
      // Snapshot names before FindExtras mutates live cached entities.
      const names = new Map(currentExtras.map(item => [idKey(item.Id), item.Name]));
      const found = await loaded.findOwnedExtras(state);
      for(const extra of found.extras)extraContexts.add(extra.context);
      const extras = found.extras;
      const { ids, renamed, refresh: refreshExtras } = extraChanges(currentExtras, found, options, names);
      if (refreshExtras) {
        // Native RefreshExtras performs removals before enumerating its lazy
        // child refresh tasks. A cancelled provider retains those deletions.
        for (const extra of currentExtras.filter(item => !ids.has(idKey(item.Id)))) {
          if (!found.deletionSafe) throw conflict('Missing extras require an authoritative directory snapshot.');
          await loaded.videoVersionDiscovery.removeMissingOwnedItem(loaded, extra, { extra: true,
            reportRemoved: (item, parent) => this.updates.reportItemRemoved(item, parent) });
        }
        await completeOwnedRefreshes(extras.map(extra => {
          const force = !sameId(extra.item.OwnerId, extra.ownerId) || nonemptyId(extra.item.ParentId) || renamed.has(idKey(extra.item.Id));
          extra.item.OwnerId = extra.ownerId; extra.item.ParentId = EMPTY_ID; extra.item.NativeTopParentId = null;
          extra.context.ownedExtraOwner = { Id: owner.Id, snapshot: loaded.snapshot, versionLinks: loaded.versionLinks };
          return this.refreshOwnedItem(owner, extra.item, force ? { ...options, ForceSave: true } : options,
            { copyTitleMetadata: true, extraContext: extra.context });
        }));
        requiresSave = true;
      } else for (const extra of currentExtras) {
        const current = await this.loadContext(extra.Id);try {
        const currentExtraType = current.snapshot ? current.snapshot.ExtraType : current.item.ExtraType;
        if (!sameId(current.item.OwnerId, extra.OwnerId) || extraTypeCode(currentExtraType) !== extraTypeCode(extra.ExtraType)
          || !sameNativePath(current.item.Path, extra.Path) || nativeTypeName(current.item) !== nativeTypeName(extra)) {
          throw conflict('The extra relationship changed before its date-only update.');
        }
        if (inheritOwnedItemDates(owner, current.item)) {
          await validateMetadataSaves(current, ItemUpdateType.MetadataEdit, this.registry);
          await saveMetadataItem(this.updates, current, { Item: current.item, People: null }, ItemUpdateType.MetadataEdit,
            { signal: options.signal });
        }
        }finally{await current.dispose();}
      }
    }
    if (!supportsVideo) return requiresSave;
    const nativeType = nativeTypeName(owner);
    const paths = owner.LocalAlternateVersions ?? [];
    const validPaths = [];
    for (const identityPath of paths) if (await loaded.ownedFileExists(identityPath, nativeType)) validPaths.push(identityPath);
    if (validPaths.length !== paths.length) {
      owner.LocalAlternateVersions = validPaths;
      requiresSave = true;
    }
    const getVideo = async (identityPath, nativeType, alternate) => {
      let item = await loaded.videoVersionDiscovery.lookup(loaded, loaded.getNewItemId(identityPath, nativeType)), created = false;
      if (!item) {
        const resolved = await loaded.videoVersionDiscovery.createOwnedVideo(loaded, identityPath, nativeType, {
          alternate, reportAdded: (item, parent) => this.updates.reportItemAdded(item, parent),
          reportRemoved: (item, parent) => this.updates.reportItemRemoved(item, parent),
          validate: async draft => {const context=await loaded.loadDraftContext(draft);try{return await validateMetadataSaves(context,ItemUpdateType.MetadataDownload,this.registry);}finally{await context.dispose();}}
        });
        if (!resolved) return null;
        ({ item, created } = resolved); state.byId.set(idKey(item.Id), item);
      }
      assertOwnedVideo(item, owner, identityPath, nativeType);
      return { item, created };
    };
    await completeOwnedRefreshes((owner.AdditionalParts ?? []).map(async identityPath => {
      if (!await loaded.ownedFileExists(identityPath, 'MediaBrowser.Controller.Entities.Video')) {
        const part = state.byId.get(idKey(loaded.getNewItemId(identityPath, 'MediaBrowser.Controller.Entities.Video')));
        if (part && VIDEO_TYPES.has(part.Type) && sameId(part.OwnerId, owner.Id)) {
          await loaded.videoVersionDiscovery.removeMissingOwnedItem(loaded, part,
            { reportRemoved: (item, parent) => this.updates.reportItemRemoved(item, parent) });
          state.byId.delete(idKey(part.Id));
        }
        return;
      }
      const part = await getVideo(identityPath, 'MediaBrowser.Controller.Entities.Video', false);
      if (!part) return;
      return this.refreshOwnedItem(owner, part.item.Id, part.created ? { ...options, ForceSave: true } : options, { copyTitleMetadata: true });
    }));
    const existingCount = state.links.filter(link => sameId(link.ParentId, owner.Id) && Number(link.ChildType) === 2).length;
    await completeOwnedRefreshes((owner.LocalAlternateVersions ?? []).map(async identityPath => {
      const resolved = await getVideo(identityPath, nativeType, true);
      if (!resolved) return;
      const alternate = resolved.item;
      const expected = { owner, identityPath, nativeType };
      if (alternate.IsInMixedFolder !== owner.IsInMixedFolder) {
        await this.#update(loaded, alternate, { IsInMixedFolder: owner.IsInMixedFolder }, ItemUpdateType.MetadataImport, options, expected);
      }
      await this.refreshOwnedItem(owner, alternate.Id, options, { copyTitleMetadata: false });
      await this.store.serializeWrites(async () => {
        const committedLinks = await this.store.transaction(async database => {
          options.signal?.throwIfAborted();
          const [currentOwner] = await database.rows('BaseItems', { where: { Id: owner.Id } });
          const [currentAlternate] = await database.rows('BaseItems', { where: { Id: alternate.Id } });
          if (!currentOwner || currentOwner.Type !== nativeType || !sameNativePath(currentOwner.Path, owner.Path)
            || !sameId(currentOwner.ParentId ?? EMPTY_ID, owner.ParentId) || !sameId(currentOwner.OwnerId ?? EMPTY_ID, owner.OwnerId)
            || !currentAlternate || currentAlternate.Type !== nativeType || !sameNativePath(currentAlternate.Path, identityPath)
            || !sameId(currentAlternate.OwnerId, owner.Id)
            || nonemptyId(currentAlternate.PrimaryVersionId) && !sameId(currentAlternate.PrimaryVersionId, owner.Id)) {
            throw conflict('The local version relationship changed before its link update.');
          }
          const links = await database.rows('LinkedChildren', { where: { ParentId: owner.Id },
            orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
          if (loaded.versionLinks != null && !isDeepStrictEqual(links, loaded.versionLinks)) {
            throw conflict('The owner version relations changed before its local link repair.');
          }
          const existing = links.find(link => sameId(link.ChildId, alternate.Id));
          if (!existing) await database.insert('LinkedChildren', { ParentId: owner.Id, ChildId: alternate.Id, ChildType: 2,
            SortOrder: links.reduce((last, link) => Math.max(last, Number(link.SortOrder)), -1) + 1 });
          else if (Number(existing.ChildType) !== 2) await database.update('LinkedChildren',
            { ParentId: existing.ParentId, SortOrder: existing.SortOrder }, { ChildType: 2 });
          return database.rows('LinkedChildren', { where: { ParentId: owner.Id },
            orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
        }, { signal: options.signal });
        // Keep the cross-process writer boundary while publishing the
        // successful transaction's baseline, including parallel repairs.
        if (loaded.versionLinks != null) loaded.versionLinks = committedLinks;
      }, { signal: options.signal });
      const current = await this.loadContext(alternate.Id);try {
      assertOwnedVideo(current.item, owner, identityPath, nativeType);
      if (!nonemptyId(current.item.PrimaryVersionId)) {
        // Native SetPrimaryVersionId also recalculates the presentation key.
        await this.#update(loaded, alternate, { PrimaryVersionId: owner.Id, PresentationUniqueKey: idKey(owner.Id) },
          ItemUpdateType.MetadataEdit, options, { ...expected, missingPrimaryVersion: true });
      } else if (!sameId(current.item.PrimaryVersionId, owner.Id)) {
        throw conflict('A local alternate changed its primary during refresh.');
      }
      }finally{await current.dispose();}
    }));
    return requiresSave || existingCount !== (owner.LocalAlternateVersions ?? []).length;
    }finally{for(const context of extraContexts)await context.dispose();await state.dispose();}
  }
}
