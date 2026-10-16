import {cloneNativeItemValue} from '../library/native-item-value.js';
import { ItemUpdateType, isSaverEnabled, validateMetadataSaves } from './save-manager.js';
import { saveMetadataItem } from './save-item.js';
import { mergeMetadata } from './merge.js';
import { newNativeItemEntity, acquireNativeItemLinkOwner } from '../library/native-item-entity.js';
import { MetadataUpdateHost } from './update-host.js';
import { isValidProviderId, trySetProviderId } from './provider-ids.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { MetadataImages } from './images.js';
import { scanLocalImages } from './local-images.js';
import { ExternalDataManager } from '../library/external-data.js';
import { createPresentationUniqueKey } from '../library/presentation-key.js';
import { beforeSaveTvMetadata } from './tv-before-save.js';
import { beforeSaveBoxSetMetadata } from './boxset-before-save.js';
import { requiresMetadataChildren, updateMetadataFromChildren } from './children-metadata.js';
import { onMetadataChanged } from './metadata-changed.js';
import { beforeMetadataRefresh, afterMetadataRefresh } from './before-refresh.js';
import { beforeEpisodeMetadataRefresh } from './episode-before-refresh.js';
import { beforeSaveFileMetadata, updateFileMetadataForSave } from './file-before-save.js';
import { dateTicks } from '../library/records.js';
import { parseLosslessJson } from '../core/json.js';
import { beforeSeriesMetadataRefresh, afterSeriesMetadataRefresh } from './series-lifecycle.js';
import { SeriesMetadataLifecycleHost } from './series-lifecycle-host.js';
import { afterAlbumMetadataRefresh } from './album-after-refresh.js';
import { itemRequiresJson } from '../library/item-data.js';
import { isDeepStrictEqual } from 'node:util';
import { nonemptyId, sameId } from '../library/records.js';
import { ownedTitleFields, prepareOwnedItemRefresh } from './owned-item-refresh.js';
import { OwnedItemMetadataLifecycleHost } from './owned-item-lifecycle.js';
import { persistImageMetadata } from './persistence.js';
import { supportsOwnedItems } from '../library/owned-items.js';
import { refreshCollectionFolderLocations } from '../library/top-level-folder-validation.js';
import { validateCollectionLocations } from './internal-folder-refresh.js';
import { isNativeItemEntity } from '../library/native-item-entity.js';

const modes = { None: 0, ValidationOnly: 1, Default: 2, FullRefresh: 3 };
const supported = ['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'PlaylistsFolder', 'Folder', 'Movie', 'Video', 'MusicVideo', 'Trailer', 'Series', 'Season', 'Episode', 'BoxSet', 'Playlist', 'Person', 'MusicAlbum', 'MusicArtist', 'UserView', 'Genre', 'MusicGenre', 'Studio', 'Year', 'Book', 'Photo', 'PhotoAlbum'];
const validId = isValidProviderId;
const languageMatches = (actual, preferred) => !actual || !preferred || actual.split('-')[0].toLowerCase() === preferred.split('-')[0].toLowerCase();
const ownerMetadataRefresh = Symbol('owner metadata refresh');
const ownedRefreshAncestors = Symbol('owned refresh ancestors');
const liveSeriesParent = Symbol('live series parent');
const liveMetadataItem = Symbol('live metadata item');
const snapshotFields = snapshot => ({ ...(itemRequiresJson(snapshot)
  ? typeof snapshot?.Data === 'string' ? parseLosslessJson(snapshot.Data) : snapshot?.Data : {}), ...snapshot });

function applySearchResult(lookup, itemType, result) {
  lookup.ProviderIds = {};
  if (itemType === 'Episode' || itemType === 'Season') {
    lookup.SeriesProviderIds = {};
    for (const [name, value] of Object.entries(result.ProviderIds ?? {})) {
      if (!validId(name, value)) continue;
      const key = Object.keys(lookup.SeriesProviderIds).find(key => ordinalIgnoreCaseEquals(key, name)) ?? name;
      Object.defineProperty(lookup.SeriesProviderIds, key, { value, enumerable: true, writable: true, configurable: true });
    }
  } else {
    for (const [name, value] of Object.entries(result.ProviderIds ?? {})) trySetProviderId(lookup, name, value);
    lookup.Name = result.Name ?? null;
    lookup.Year = result.ProductionYear ?? null;
  }
}

function applyLiveSeriesParent(loaded, series) {
  if (!series) return loaded;
  if (loaded.item.Type !== 'Season' || series.Type !== 'Series' || !sameId(loaded.item.ParentId, series.Id)) {
    throw Object.assign(new Error('A nested season refresh requires its live Series parent.'), { code: 'metadata-conflict', status: 409 });
  }
  loaded.parents = loaded.parents.map(parent => sameId(parent.Id, series.Id) ? series : parent);
  if (!loaded.parents.some(parent => sameId(parent.Id, series.Id))) loaded.parents.unshift(series);
  loaded.parent = series;
  loaded.series = series;
  const resolveSeries = loaded.resolveSeries;
  loaded.resolveSeries = value => value.Type === 'Series' && sameId(value.Id, series.Id)
    || ['Season', 'Episode'].includes(value.Type) && (sameId(value.ParentId, series.Id) || sameId(value.SeriesId, series.Id))
    ? series : resolveSeries?.(value);
  const lookupFor = loaded.lookupFor;
  loaded.lookupFor = value => {
    const lookup = lookupFor(value);
    lookup.SeriesProviderIds = cloneNativeItemValue(series.ProviderIds ?? {});
    lookup.SeriesDisplayOrder = series.DisplayOrder;
    return lookup;
  };
  loaded.item.SeriesProviderIds = series.ProviderIds ?? {};
  loaded.item.SeriesDisplayOrder = series.DisplayOrder;
  loaded.refreshPreferredMetadata?.(loaded.item, { parents: loaded.parents });
  loaded.lookup = loaded.lookupFor(loaded.item);
  const refreshTvContext = loaded.refreshTvContext;
  loaded.refreshTvContext = value => {
    const refreshed = refreshTvContext(value);
    refreshed.series = series;
    refreshed.lookup.SeriesProviderIds = cloneNativeItemValue(series.ProviderIds ?? {});
    refreshed.lookup.SeriesDisplayOrder = series.DisplayOrder;
    value.SeriesProviderIds = series.ProviderIds ?? {};
    value.SeriesDisplayOrder = series.DisplayOrder;
    return refreshed;
  };
  return loaded;
}

export class MetadataRefreshHost {
  #active = new Map();
  #queue = [];
  #processing;
  #lifetime = new AbortController();
  constructor({ registry, loadContext, linkedChildren, store, vfs, userData, images, probe, updates, externalData, seriesLifecycle,
    supportedItemTypes = supported, logger = { error() {} }, now = () => new Date().toISOString() }) {
    if (!registry || !loadContext || !store) throw new TypeError('Metadata refresh requires registry, authoritative context and persistence.');
    this.linkedChildren = linkedChildren;
    Object.assign(this, { registry, loadContext, store, vfs, userData, probe, logger, now, supportedItemTypes,
      images: images ?? new MetadataImages({ logger }) });
    this.updates = updates ?? new MetadataUpdateHost({ registry, store, library: loadContext.library, images: this.images, logger, now });
    this.externalData = externalData ?? probe?.externalData ?? new ExternalDataManager({ store, vfs, logger });
    this.seriesLifecycle = seriesLifecycle ?? new SeriesMetadataLifecycleHost({ store, loadContext, updates: this.updates,
      externalData: this.externalData, itemCreation: loadContext.library?.itemCreation, refresh: (reference, options) => this.refresh(reference, options), logger, now });
    this.ownedLifecycle = new OwnedItemMetadataLifecycleHost({ store, loadContext: reference => this.loadContext(reference), updates: this.updates, registry,
      refreshOwnedItem: (owner, reference, options, inheritance) => this.refreshOwnedItem(owner, reference, options, inheritance) });
  }
  supports(item) { return this.supportedItemTypes.includes(typeof item === 'string' ? item.split('.').at(-1) : item.Type.split('.').at(-1)) || Boolean(this.probe?.supportsMetadata(typeof item === 'string' ? { Type: item } : item)); }
  validateRefresh(item, options = {}) {
    if (!this.supports(item)) throw Object.assign(new Error(`Metadata refresh persistence is not implemented for ${item.Type ?? item}.`), { status: 501 });
    if (modes[options.MetadataRefreshMode ?? 'FullRefresh'] == null) throw Object.assign(new TypeError('Unknown metadata refresh mode.'), { status: 400 });
    if (modes[options.ImageRefreshMode ?? 'None'] == null) throw Object.assign(new TypeError('Unknown image refresh mode.'), { status: 400 });
    if (options.RegenerateTrickplay) throw Object.assign(new Error('Generated media is not implemented.'), { status: 501 });
  }
  queue(reference, options = {}, priority = 0) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 2) throw new TypeError('A native refresh priority is required.');
    if (this.#lifetime.signal.aborted) return Promise.resolve();
    const task = new Promise((resolve, reject) => {
      const entry = { reference, options, priority, resolve, reject };
      // System.Collections.Generic.PriorityQueue uses a quaternary min heap.
      // Equal priorities retain the replacement node rather than sorting by age.
      let index = this.#queue.length;
      this.#queue.push(entry);
      while (index > 0) {
        const parent = (index - 1) >>> 2;
        if (entry.priority >= this.#queue[parent].priority) break;
        this.#queue[index] = this.#queue[parent];
        index = parent;
      }
      this.#queue[index] = entry;
    });
    this.#startQueue();
    return task;
  }
  getRefreshQueue() {
    return new Set(this.#queue.map(entry => String(typeof entry.reference === 'string' ? entry.reference : entry.reference.Id)
      .replaceAll('-', '').toLowerCase()));
  }
  #dequeue() {
    const entry = this.#queue[0], replacement = this.#queue.pop();
    if (this.#queue.length) {
      let index = 0;
      while ((index * 4 + 1) < this.#queue.length) {
        let child = index * 4 + 1;
        const end = Math.min(child + 4, this.#queue.length);
        for (let next = child + 1; next < end; next++) {
          if (this.#queue[next].priority < this.#queue[child].priority) child = next;
        }
        if (replacement.priority <= this.#queue[child].priority) break;
        this.#queue[index] = this.#queue[child];
        index = child;
      }
      this.#queue[index] = replacement;
    }
    return entry;
  }
  #startQueue() {
    if (this.#processing || !this.#queue.length) return;
    const processEntries = async () => {
      while (this.#queue.length) {
        const entry = this.#dequeue();
        try {
          this.#lifetime.signal.throwIfAborted();
          entry.resolve(await (this.queuedRefresh
            ? this.queuedRefresh(entry.reference, { ...entry.options, signal: entry.options.signal
              ? AbortSignal.any([entry.options.signal, this.#lifetime.signal]) : this.#lifetime.signal })
            : this.refresh(entry.reference, entry.options)));
        } catch (error) { entry.reject(error); }
      }
    };
    this.#processing = Promise.resolve().then(() => {
      // A batch owns ignore-cache boundaries; each admitted item still has
      // independent failure and cancellation, and can admit more queued work.
      return this.runQueuedBatch && !this.#lifetime.signal.aborted
        ? this.runQueuedBatch(processEntries, { signal: this.#lifetime.signal }) : processEntries();
    }).catch(error => {
      // A host boundary failure must neither strand callers nor spin through
      // repeated empty batches. Already completed entries remain completed.
      while (this.#queue.length) this.#dequeue().reject(error);
      try { void Promise.resolve(this.logger.error(error, 'Error processing metadata refresh queue')).catch(() => {}); }
      catch { /* Logging must not prevent the queue from standing down. */ }
    }).finally(() => {
      this.#processing = undefined;
      this.#startQueue();
    });
  }
  refreshLiveItem(item, options = {}) {
    if (!isNativeItemEntity(item)) throw new TypeError('Live metadata refresh requires a branded native entity.');
    return this.refresh(item, { ...options, [liveMetadataItem]: item });
  }
  async refresh(reference, options = {}) {
    this.#lifetime.signal.throwIfAborted();
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal };
    const key = String(typeof reference === 'string' ? reference : reference.Id).replaceAll('-', '').toLowerCase();
    const ancestors = options[ownedRefreshAncestors] ?? [];
    if (ancestors.includes(key)) {
      throw Object.assign(new Error('An owned metadata refresh cannot revisit an active ancestor.'), { code: 'metadata-conflict', status: 409 });
    }
    options[ownedRefreshAncestors] = [...ancestors, key];
    const previous = this.#active.get(key);
    const task = Promise.resolve(previous).catch(() => {}).then(() => this.#refresh(reference, options));
    this.#active.set(key, task);
    try { return await task; } finally { if (this.#active.get(key) === task) this.#active.delete(key); }
  }
  async refreshOwnedItem(ownerReference, reference, options = {}, { copyTitleMetadata = true, extraContext } = {}) {
    const ownerId = typeof ownerReference === 'string' ? ownerReference : ownerReference.Id;
    const ownedId = typeof reference === 'string' ? reference : reference.Id;
    if (!nonemptyId(ownerId) || !nonemptyId(ownedId) || sameId(ownerId, ownedId)) {
      throw Object.assign(new Error('An owned metadata refresh requires distinct owner and child identities.'), { status: 409 });
    }
    // Validate before joining the per-item queue: an invalid back-reference
    // must not wait on the owner's active refresh and deadlock it.
    const preflight=await this.#loadOwnedContext(ownerId,ownedId,extraContext);
    try { /* Relationship preflight completes before queue admission. */ }
    finally {await preflight.owned.dispose();await preflight.owner.dispose();}
    return this.refresh(reference, { ...options, [ownerMetadataRefresh]: { ownerId, copyTitleMetadata,
      extraContext, ownerItem: typeof ownerReference === 'object' ? ownerReference : undefined } });
  }
  refreshSeasonWithLiveSeries(season, series, options = {}) {
    return this.refresh(season, { ...options, [liveSeriesParent]: series });
  }
  async #loadOwnedContext(ownerId, ownedId, extraContext) {
    let owner,owned;
    try {
    owner=await this.loadContext(ownerId);
    owned=await this.loadContext(ownedId,extraContext?{draft:extraContext.item}:undefined);
    if (extraContext) {
      if (owned.item.ExtraType == null || !['Video', 'Trailer', 'Audio'].includes(owned.item.Type)
        || !sameId(owned.item.Id, owned.getNewItemId(owned.item.Path, owned.item.NativeType))
        || !isDeepStrictEqual(owned.snapshot, extraContext.snapshot)
        || !isDeepStrictEqual(owned.relationships, extraContext.relationships)
        || !isDeepStrictEqual(owned.versionLinks, extraContext.versionLinks)) {
        throw Object.assign(new Error('The resolved extra changed before its provider refresh.'), { code: 'metadata-conflict', status: 409 });
      }
      if (!owned.snapshot) owned.creationIntent = 'owned-extra';
      owned.ownedExtraOwner = extraContext.ownedExtraOwner;
      if (!isDeepStrictEqual(owner.snapshot, owned.ownedExtraOwner.snapshot) || !isDeepStrictEqual(owner.versionLinks, owned.ownedExtraOwner.versionLinks)) {
        throw Object.assign(new Error('The extra owner changed before its provider refresh.'), { code: 'metadata-conflict', status: 409 });
      }
    }
    let validOwner = sameId(owned.item.OwnerId, owner.item.Id);
    if (!validOwner && owned.item.ExtraType != null && nonemptyId(owned.item.OwnerId)) {
      const version = await this.loadContext(owned.item.OwnerId);
      try {validOwner = (await owner.getLocalAlternateVersionIds()).some(id => sameId(id, version.item.Id));}
      finally {await version.dispose();}
    }
    if (!validOwner) throw Object.assign(new Error('The owned metadata relationship changed before refresh.'), { code: 'metadata-conflict', status: 409 });
    return { owner, owned };
    }catch(error){await owned?.dispose();await owner?.dispose();throw error;}
  }
  async #refresh(reference, options) {
    const ownership = { reportProbeCommit: null, contexts: new Set(), temporaryItems: new Map() };
    try {
      if(!options[liveMetadataItem]&&!options[ownerMetadataRefresh]){const id=typeof reference==='string'?reference:reference.Id;
        const cached=this.updates.library?.itemCreation?.getCachedItemById(id);if(cached){ownership.temporaryItems.set(cached,acquireNativeItemLinkOwner(cached));options={...options,[liveMetadataItem]:cached};}}
      return await this.#runRefresh(reference,options,ownership);
    } catch(error) {
      const seen=new Set();let primary=error;
      while(primary && typeof primary==='object' && !seen.has(primary)) {
        seen.add(primary);
        if(primary.code==='metadata-conflict') {
          const creator=this.updates.library?.itemCreation;
          const id=typeof reference==='string'?reference:reference.Id;
          const cached=creator?.getCachedItemById(id);
          // The rejected live entity may have changed during providers/savers.
          // A newer entity registered by another writer has its own authority.
          if(cached && (cached===options[liveMetadataItem]
            || [...ownership.contexts].some(loaded=>loaded.item===cached)))creator.unregisterItem(id);
          break;
        }
        primary=primary.cause;
      }
      throw error;
    }
    finally {
      const report = ownership.reportProbeCommit;
      ownership.reportProbeCommit = null;
      if (report) try { report(); }
      catch (error) { try { this.logger.error(error, 'Error reporting committed probe update'); } catch { /* A reporting failure cannot replace the refresh outcome. */ } }
      for (const owner of ownership.temporaryItems.values()) owner.release();
      for (const loaded of ownership.contexts) await loaded.dispose();
      await this.linkedChildren.flushReleases();
    }
  }
  async #runRefresh(reference, options, ownership) {
    const { signal } = options;
    const mode = modes[options.MetadataRefreshMode ?? 'FullRefresh'];
    const imageMode = modes[options.ImageRefreshMode ?? 'None'];
    if (mode == null) throw new TypeError('Unknown metadata refresh mode.');
    let loaded;
    if (options[ownerMetadataRefresh]) {
      const inheritance = options[ownerMetadataRefresh];
      const contexts = await this.#loadOwnedContext(inheritance.ownerId, typeof reference === 'string' ? reference : reference.Id, inheritance.extraContext);
      ownership.contexts.add(contexts.owner); ownership.contexts.add(contexts.owned);
      loaded = contexts.owned;
      options = prepareOwnedItemRefresh(inheritance.ownerItem ?? contexts.owner.item, loaded.item, options, inheritance);
    } else loaded = applyLiveSeriesParent(await this.loadContext(reference,
      options[liveMetadataItem] ? { draft: options[liveMetadataItem] } : undefined), options[liveSeriesParent]);
    ownership.contexts.add(loaded);
    this.validateRefresh(loaded.item, options);
    // D3: configured external writers must be available before image/probe or
    // first-refresh persistence can commit state that requires a sidecar save.
    const possibleWrite = mode > 0 || imageMode > 0 || options.ForceSave || options.ReplaceAllMetadata
      ? ItemUpdateType.MetadataDownload : ItemUpdateType.MetadataImport;
    await validateMetadataSaves(loaded, possibleWrite, this.registry);
    if (loaded.supportsOwnedItems?.() ?? supportsOwnedItems(loaded.item)) {
      await this.ownedLifecycle.validateBeforeRefresh(loaded, options);
      // A new part commits independently before its first provider save. D3
      // must validate its external writers before any owned-wrapper effects.
      for (const part of await loaded.previewOwnedPartContexts?.() ?? []) {
        ownership.contexts.add(part);
        await validateMetadataSaves(part, ItemUpdateType.MetadataDownload, this.registry);
      }
      let requiresOwnedSave = false;
      try {
        requiresOwnedSave = await this.ownedLifecycle.beforeRefresh(loaded, options);
        const Images = loaded.context.images;
        loaded.onImageRemoteChange = () => saveMetadataItem(this.updates, loaded, { Item: loaded.item, Images },
          ItemUpdateType.ImageUpdate);
        // This BaseItem wrapper has no request token. Image conversion can
        // independently save the owner and advance its conflict baseline.
        await this.images.updateImages(loaded, Images, {
          persistImages: value => persistImageMetadata(this.store, loaded, value)
        });
      } catch (error) {
        // BaseItem.RefreshMetadata logs the whole owned-items failure and still
        // runs the owner's independent single-item provider lifecycle.
        this.logger.error(error, 'Error refreshing owned items');
      } finally {
        delete loaded.onImageRemoteChange;
      }
      if (requiresOwnedSave) options = { ...options, ForceSave: true };
    }
    // BaseItem.RefreshMetadata performs its owned-file maintenance before the
    // single-item provider sees cancellation. Completed cleanup is retained.
    signal?.throwIfAborted();
    if (loaded.item.Type === 'Series') {
      await beforeSeriesMetadataRefresh(loaded.item, options, this.seriesLifecycle);
      loaded = applyLiveSeriesParent(await this.loadContext(reference), options[liveSeriesParent]);
      ownership.contexts.add(loaded);
    }
    const initialItem = loaded.item;
    const firstRefresh = dateTicks(initialItem.DateLastRefreshed) === 0n;
    const interval = loaded.libraryOptions.AutomaticRefreshIntervalDays ?? 0;
    const lastRefresh = initialItem.DateLastRefreshed ? new Date(initialItem.DateLastRefreshed.replace(' ', 'T').replace(/Z?$/, 'Z')).getTime() : -Infinity;
    let requiresRefresh = interval > 0 && new Date(this.now()).getTime() - lastRefresh >= interval * 86400000;
    if (!requiresRefresh && mode !== 0) requiresRefresh = await loaded.requiresRefresh?.() ?? false;
    // Only directory validation updates CollectionFolder's locations and
    // physical links. Ordinary MetadataService refresh observes their old
    // values through RequiresRefresh without replacing them.
    const collectionFolderUpdate = options[validateCollectionLocations]
      ? await refreshCollectionFolderLocations(loaded) : ItemUpdateType.None;
    // Native MetadataResult starts with null People: null leaves stored credits.
    const metadata = { Item: null, People: null, Images: loaded.context.images };
    let imageChanged = false, imagesFailed = false;
    try {
      if (options.RemoveOldMetadata && options.ReplaceAllImages) imageChanged = await this.images.removeForRefresh(loaded, metadata.Images, signal);
      if (loaded.saveLocalMetadataEnabled && options.ReplaceAllImages) imageChanged = await this.images.validate(metadata.Images, loaded.imageAssets, signal) || imageChanged;
      else imageChanged = await this.images.merge(metadata.Images, await scanLocalImages(loaded, { signal }), loaded, signal, options) || imageChanged;
    }
    catch (error) { if (signal?.aborted) throw error; imagesFailed = true; this.logger.error(error, 'Error validating images'); }
    let beforeSaveUpdate = collectionFolderUpdate;
    const fullBeforeSave = firstRefresh || options.ReplaceAllMetadata || mode === 3 || requiresRefresh || options.ForceSave;
    const imageUpdate = imageChanged ? ItemUpdateType.ImageUpdate | ItemUpdateType.None : ItemUpdateType.None;
    if (loaded.metadataChildren && requiresMetadataChildren(initialItem, fullBeforeSave, imageUpdate)) {
      const children=await loaded.metadataChildren(initialItem);
      try{beforeSaveUpdate=await updateMetadataFromChildren(initialItem,children,fullBeforeSave,imageUpdate,{defaultCountry:loaded.globalOptions.MetadataCountryCode});}
      finally{await children.close();}
    }
    const presentationUniqueKey = createPresentationUniqueKey(initialItem, loaded);
    if (initialItem.PresentationUniqueKey !== presentationUniqueKey) {
      initialItem.PresentationUniqueKey = presentationUniqueKey;
      beforeSaveUpdate |= ItemUpdateType.MetadataImport;
    }
    let externalDataInvalidated = false;
    beforeSaveUpdate |= await beforeSaveFileMetadata(initialItem, loaded, {
      vfs: this.vfs,
      invalidateExternalData: async (current, { previousDateModified }) => {
        externalDataInvalidated = await this.externalData.invalidateChangedVideo(
          { ...current, DateModified: previousDateModified }, current.DateModified, { expectedSnapshot: loaded.snapshot, loaded });
      }
    });
    // BeforeSaveInternal precedes provider lookup and the first repository
    // save. Provider-supplied fields are retained until the next refresh.
    beforeSaveUpdate |= beforeSaveTvMetadata(initialItem, loaded);
    beforeSaveUpdate |= await beforeSaveBoxSetMetadata(initialItem, loaded);
    beforeSaveUpdate |= onMetadataChanged(initialItem, loaded.parentalRating?.(initialItem));
    if (['Episode', 'Season'].includes(initialItem.Type) && loaded.refreshTvContext) Object.assign(loaded, loaded.refreshTvContext(initialItem));
    if (loaded.lookupFor) loaded.lookup = loaded.lookupFor(initialItem);
    // Native image validation and BeforeSave precede the first repository save
    // and provider selection. Provider cancellation leaves this committed save.
    let item = metadata.Item = initialItem;
    if (firstRefresh) {
      await saveMetadataItem(this.updates, loaded, metadata, ItemUpdateType.MetadataImport, { signal });
      initialItem.DateLastSaved = item.DateLastSaved;
    }
    let selected = this.registry.discover({ ...loaded, kind: 'local' });
    let remote = this.registry.discover({ ...loaded, kind: 'remote' });
    let custom = this.registry.discover({ ...loaded, kind: 'custom' });
    let imageProviders = this.registry.discover({ ...loaded, kind: 'image', imageRefreshMode: options.ImageRefreshMode ?? 'None' });
    const allProviders = options.ReplaceAllMetadata || mode === 3 || mode >= 2 && (firstRefresh || requiresRefresh);
    const probeAvailable = mode !== 0 && this.probe?.supportsMetadata(initialItem);
    let probeChanged = false, remoteChanged = false, probeUpdate = ItemUpdateType.None, probeFailures = 0, probeError;
    if (!allProviders && mode !== 0) {
      const changed = [];
      if (probeAvailable) try { probeChanged = await this.probe.hasChanged(loaded, { signal }); }
      catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Error checking probe changes'); }
      for (const provider of [...selected, ...remote, ...custom]) if (provider.hasChanged) {
        try { if (await provider.hasChanged(initialItem, { ...loaded.context, signal })) changed.push(provider); }
        catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Error checking metadata provider changes'); }
      }
      remoteChanged = changed.some(provider => provider.kind === 'remote');
      const localChanged = changed.some(provider => provider.kind === 'local');
      if (!changed.length && !probeChanged) selected = remote = custom = [];
      else {
        if (!remoteChanged && !localChanged && !probeChanged) selected = [];
        if (!remoteChanged || mode === 1) remote = [];
        custom = custom.filter(provider => remoteChanged || changed.includes(provider));
      }
    }
    if (mode !== 0 && (selected.length || remote.length || custom.length || probeAvailable && (allProviders || probeChanged || remoteChanged) || firstRefresh || requiresRefresh)) {
      const previousPath = item.Path;
      if (beforeMetadataRefresh(item, loaded)) beforeSaveUpdate |= ItemUpdateType.MetadataImport;
      if (item.Path !== previousPath && loaded.refreshMetadataPathContext) {
        const { accessPath, imageAssets } = await loaded.refreshMetadataPathContext();
        loaded.context = { ...loaded.context, accessPath }; loaded.imageAssets = imageAssets;
      }
      if (item.Type === 'Episode' && await beforeEpisodeMetadataRefresh(item, loaded, {
        replaceAllMetadata: options.ReplaceAllMetadata ?? false, probe: this.probe, logger: this.logger
      })) beforeSaveUpdate |= ItemUpdateType.MetadataImport;
      if (loaded.lookupFor) loaded.lookup = loaded.lookupFor(item);
    }
    if (options.SearchResult?.SearchProviderName) imageProviders.sort((a, b) => Number(b.name.toLowerCase() === options.SearchResult.SearchProviderName.toLowerCase()) - Number(a.name.toLowerCase() === options.SearchResult.SearchProviderName.toLowerCase()));
    if (imageMode <= 1) imageProviders = [];
    else if (imageMode !== 3 && !firstRefresh) {
      const changed = [];
      for (const provider of imageProviders) if (provider.hasChanged) {
        try { if (await provider.hasChanged(initialItem, { ...loaded.context, signal })) changed.push(provider); }
        catch (error) { if (signal?.aborted) throw error; this.logger.error(error, 'Error checking image provider changes'); }
      }
      imageProviders = changed;
    }
    // ProbeProvider is forced and pre-refresh: a lock does not prevent a selected probe from running.
    if (probeAvailable && (allProviders || probeChanged || remoteChanged)) {
      try {
        const result = await this.probe.refreshMetadata(loaded, options, {
          externalDataInvalidated,
          onCommitted: report => { ownership.reportProbeCommit = report; }
        }); probeUpdate = result.UpdateType ?? ItemUpdateType.None;
        if (result.changed) {
          const previousLoaded = loaded;
          loaded = applyLiveSeriesParent(await this.loadContext(reference), options[liveSeriesParent]);
          ownership.contexts.add(loaded);
          loaded.context = { ...loaded.context, images: metadata.Images };
          item = metadata.Item = loaded.item;
          const previousSnapshot = snapshotFields(previousLoaded.snapshot), currentSnapshot = snapshotFields(loaded.snapshot);
          // Keep hook mutations when the probe did not write those columns.
          // Probe metadata that actually replaced a value takes precedence.
          for (const field of ['Name', 'ProductionYear', 'IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber', 'PremiereDate', 'SeriesName', 'DateCreated', 'PresentationUniqueKey']) {
            const unchanged = ['DateCreated', 'PremiereDate'].includes(field)
              ? field === 'PremiereDate' && (currentSnapshot[field] == null || previousSnapshot[field] == null)
                ? (currentSnapshot[field] ?? null) === (previousSnapshot[field] ?? null)
                : dateTicks(currentSnapshot[field]) === dateTicks(previousSnapshot[field])
              : currentSnapshot[field] === previousSnapshot[field];
            if (unchanged && Object.hasOwn(initialItem, field)) item[field] = initialItem[field];
          }
          // Probe persistence reloads the entity. Retain the already calculated
          // BeforeSave rating until the native post-provider gate runs again.
          for (const field of ['InheritedParentalRatingValue', 'InheritedParentalRatingSubValue']) {
            if (Object.hasOwn(initialItem, field)) item[field] = initialItem[field];
          }
          if (options[ownerMetadataRefresh]) for (const field of ownedTitleFields) {
            if (isDeepStrictEqual(currentSnapshot[field], previousSnapshot[field]) && Object.hasOwn(initialItem, field)) {
              item[field] = initialItem[field];
            }
          }
          if (loaded.lookupFor) loaded.lookup = loaded.lookupFor(item);
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        probeFailures++; probeError = error.message; this.logger.error(error, 'Error in pre-refresh probe provider');
      }
    }
    const runProviders = mode !== 0 && !item.IsLocked;
    const runImageProviders = imageMode > 1 && !imagesFailed && imageProviders.length > 0;
    if (!runProviders && !runImageProviders && !options.ForceSave && !options.ReplaceAllMetadata && !firstRefresh && !requiresRefresh && !imageChanged && probeUpdate === ItemUpdateType.None && beforeSaveUpdate === ItemUpdateType.None && !(mode > 1 || imageMode > 1)) {
      await this.#afterRefresh(item, options);
      return { changed: false, UpdateType: ItemUpdateType.None, Failures: probeFailures, ErrorMessage: probeError };
    }
    let isSaving = false;
    if (runProviders) for (const saver of this.registry.discover({ ...loaded, kind: 'saver' })) if (await isSaverEnabled(saver, item, ItemUpdateType.MetadataDownload, loaded)) isSaving = true;
    const temporaryItem = newNativeItemEntity(item.NativeType);
    Object.assign(temporaryItem, { Path: item.Path, Id: item.Id, ParentIndexNumber: item.ParentIndexNumber,
      PreferredMetadataLanguage: item.PreferredMetadataLanguage, PreferredMetadataCountryCode: item.PreferredMetadataCountryCode });
    ownership.temporaryItems.set(temporaryItem, acquireNativeItemLinkOwner(temporaryItem));
    const temp = { Item: temporaryItem, People: null };
    let updateType = beforeSaveUpdate | probeUpdate | (imageChanged ? ItemUpdateType.ImageUpdate : 0), failures = probeFailures, errorMessage = probeError;
    // RefreshWithProviders owns its merge reason. BeforeSave and earlier image
    // validation cannot trigger a merge through a fresh empty provider result.
    let providerUpdateType = probeUpdate;
    if (runProviders && !options.SearchResult && !(isSaving && options.ReplaceAllMetadata)) for (const provider of selected) {
      try {
        signal?.throwIfAborted();
        const result = await provider.getMetadata(item, { ...loaded.context, imageAssets: loaded.imageAssets, signal });
        if (result.Item && !ownership.temporaryItems.has(result.Item)) ownership.temporaryItems.set(result.Item, acquireNativeItemLinkOwner(result.Item));
        if (!result.HasMetadata) continue;
        if (provider.applySideEffects) await provider.applySideEffects(result, { store: this.store, userData: this.userData });
        if (await this.images.importLocalResult(loaded, result, metadata.Images, options)) { updateType |= ItemUpdateType.ImageUpdate; providerUpdateType |= ItemUpdateType.ImageUpdate; }
        await mergeMetadata(result, temp, { mergeMetadataSettings: true, dataPath: loaded.dataPath, linkedChildren: this.linkedChildren }); updateType |= ItemUpdateType.MetadataImport; providerUpdateType |= ItemUpdateType.MetadataImport;
        break;
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        errorMessage = error.message; this.logger.error(error, 'Error in local metadata provider');
      }
    }
    const localLocked = temp.Item.IsLocked;
    const lookup = cloneNativeItemValue(loaded.lookup);
    if (options.SearchResult) applySearchResult(lookup, item.Type, options.SearchResult);
    lookup.IsAutomated = options.IsAutomated ?? false;
    const mergeLookupIds = () => {
      for (const [key, value] of Object.entries(temp.Item.ProviderIds ?? {})) if (validId(key, value) && !validId(key, lookup.ProviderIds?.[key])) (lookup.ProviderIds ??= {})[key] = value;
    };
    let hasRemote = false, overviewFallback = false, taglineFallback = false;
    if (runProviders && !localLocked && (options.ReplaceAllMetadata || mode > 1)) {
      mergeLookupIds();
      if (options.SearchResult?.SearchProviderName) remote.sort((a, b) => Number(b.name.toLowerCase() === options.SearchResult.SearchProviderName.toLowerCase()) - Number(a.name.toLowerCase() === options.SearchResult.SearchProviderName.toLowerCase()));
      for (const provider of remote) {
        try {
          signal?.throwIfAborted();
          const result = await provider.getMetadata(lookup, { signal });
          if (result.Item && !ownership.temporaryItems.has(result.Item)) ownership.temporaryItems.set(result.Item, acquireNativeItemLinkOwner(result.Item));
          if (!result.HasMetadata) continue;
          if (languageMatches(result.ResultLanguage, lookup.MetadataLanguage)) {
            if (overviewFallback && result.Item.Overview) { temp.Item.Overview = null; overviewFallback = false; }
            if (taglineFallback && result.Item.Tagline) { temp.Item.Tagline = null; taglineFallback = false; }
          } else {
            overviewFallback ||= !temp.Item.Overview && Boolean(result.Item.Overview);
            taglineFallback ||= !temp.Item.Tagline && Boolean(result.Item.Tagline);
          }
          await mergeMetadata(result, temp, { linkedChildren: this.linkedChildren }); mergeLookupIds(); hasRemote = true; updateType |= ItemUpdateType.MetadataDownload; providerUpdateType |= ItemUpdateType.MetadataDownload;
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          failures++; errorMessage = error.message; this.logger.error(error, 'Error in remote metadata provider');
        }
      }
    }
    if (runProviders && (selected.length > 0 || remote.length > 0) && providerUpdateType > ItemUpdateType.None) {
      if (!options.RemoveOldMetadata || failures > 0 && !hasRemote) await mergeMetadata(metadata, temp, { linkedChildren: this.linkedChildren });
      const replaceData = localLocked || mode > 1 && options.ReplaceAllMetadata || mode === 2 && !options.ReplaceAllMetadata;
      await mergeMetadata(temp, metadata, { lockedFields: item.LockedFields, replaceData, mergeMetadataSettings: true, dataPath: loaded.dataPath, linkedChildren: this.linkedChildren });
    }
    loaded.refreshPreferredMetadata?.(item);
    if (runProviders) for (const provider of custom) {
      try {
        signal?.throwIfAborted();
        const result = await provider.fetch(item, { store: this.store, ...loaded.context, signal });
        updateType |= typeof result === 'number' ? result : result?.UpdateType ?? ItemUpdateType.None;
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        failures++; errorMessage = error.message; this.logger.error(error, `Error in ${provider.name} custom metadata provider`);
      }
    }
    if (runImageProviders) {
      const result = await this.images.refreshProviders({ ...loaded, item }, metadata.Images, imageProviders, options);
      if (result.changed) updateType |= ItemUpdateType.ImageUpdate;
      failures += result.failures;
      errorMessage = result.errorMessage ?? errorMessage;
    }
    const refreshStamp = (mode > 1 || imageMode > 1) && !failures && !imagesFailed;
    if (refreshStamp) {
      item.DateLastRefreshed = this.now();
      updateType |= onMetadataChanged(item, loaded.parentalRating?.(item));
    }
    const shouldSave = updateType > ItemUpdateType.None || options.ForceSave || options.ReplaceAllMetadata || firstRefresh || requiresRefresh || refreshStamp && (mode === 3 || imageMode === 3);
    if (!shouldSave) {
      await this.#afterRefresh(item, options);
      return { changed: false, UpdateType: updateType, Failures: failures, ErrorMessage: errorMessage };
    }
    if (options.ForceSave || options.ReplaceAllMetadata) updateType |= ItemUpdateType.MetadataDownload;
    await updateFileMetadataForSave(item, loaded, { vfs: this.vfs, logger: this.logger });
    signal?.throwIfAborted();
    const saves = await saveMetadataItem(this.updates, loaded, metadata, updateType, { signal, reattachUserData: firstRefresh });
    ownership.reportProbeCommit = null;
    await this.#afterRefresh(item, options);
    return { changed: true, UpdateType: updateType, Failures: failures, ErrorMessage: errorMessage, Saves: saves, Item: item };
  }
  async #afterRefresh(item, options) {
    afterMetadataRefresh(item);
    if (item.Type === 'Series') await afterSeriesMetadataRefresh(item, options, this.seriesLifecycle);
    if (item.Type === 'MusicAlbum') await afterAlbumMetadataRefresh(item, (value, people) => this.updatePeople(value, people));
  }
  async updatePeople(item, people) {
    // Album's synchronous native UpdatePeople uses CancellationToken.None.
    // Credits commit before each subsequent person's independent metadata save.
    await this.loadContext.withContext(item.Id,{includeChildren:false},loaded=>this.updates.updatePeople(loaded,people));
  }
  async drain() {
    while (this.#processing || this.#active.size) await Promise.allSettled([this.#processing, ...this.#active.values()]);
  }
  async close() { this.#lifetime.abort(); await this.drain(); }
}
