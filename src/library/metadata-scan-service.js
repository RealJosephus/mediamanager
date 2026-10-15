import { ItemUpdateType } from '../metadata/save-manager.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { dateTicks, idKey, libraryError, nonemptyId, sameId } from './records.js';
import { createMetadataChildren } from './metadata-children.js';
import { releaseCachedFolderChildren, setFolderChildren } from './folder-cache.js';

const dayTicks = 864000000000n;

export function metadataScanOptions(options = {}) {
  return { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true, ReplaceAllMetadata: false,
    ReplaceAllImages: false, ForceSave: false, RemoveOldMetadata: false, ...options,
    RefreshPaths: [...(options.RefreshPaths ?? [])] };
}

const refreshItem = (item, options) => !options.RefreshPaths?.length
  || options.RefreshPaths.some(path => ordinalIgnoreCaseEquals(path, item.Path ?? ''));
const copyRefreshOptions = options => ({ ...options, RefreshPaths: options.RefreshPaths?.length ? [...options.RefreshPaths] : undefined });
const metadataContainer = item => ['Series', 'MusicAlbum'].includes(String(item?.Type ?? '').split('.').at(-1));
const receipt = () => ({ attemptedCount: 0, updatedCount: 0, providerFailures: 0, errors: [], cancelled: false });

export class LibraryMetadataScanService {
  constructor({ library, metadata, configuration = {}, now = () => new Date().toISOString(), logger = { error() {} },
    scheduler, stateLoader }) {
    if (!library?.store || !metadata?.refresh || !metadata?.validateRefresh) {
      throw new TypeError('Library metadata traversal requires authoritative library state and a refresh host.');
    }
    if (!scheduler || typeof scheduler.enqueue !== 'function') throw new TypeError('Library metadata traversal requires the shared library scheduler.');
    Object.assign(this, { library, metadata, configuration, now, logger, scheduler, stateLoader });
  }

  validateRefresh(item, options) { this.metadata.validateRefresh(item, metadataScanOptions(options)); }

  refreshItem(reference, options = {}) { return this.metadata.refresh(reference, metadataScanOptions(options)); }

  refreshLiveItem(item, options = {}) { return this.metadata.refreshLiveItem(item, metadataScanOptions(options)); }

  async #withState(reference, operation) {
    if (this.stateLoader) {
      const loaded = await this.stateLoader(reference);
      try { return await operation(loaded); } finally { await loaded.close(); }
    }
    const referenceId = typeof reference === 'string' ? reference : reference.Id;
    return this.metadata.loadContext.withContext(referenceId, { includeChildren: false }, loaded => operation({
      item: loaded.item,
      children: createMetadataChildren({ store: this.library.store, library: this.library,
        linkedChildren: this.metadata.loadContext.linkedChildren,
        configuration: loaded.globalOptions, libraryOptions: loaded.libraryOptions })
    }));
  }

  async refreshChildren(reference, options = {}, { recursive = true, reportProgress = () => {} } = {}) {
    options = metadataScanOptions(options);
    const result = receipt();
    await this.#withState(reference, async loaded => {
      if (!loaded.item.IsFolder) throw libraryError(400, 'Metadata child traversal requires a folder.');
      const children = await loaded.children.physical(loaded.item);
      try { await this.#runChildren(children, options, recursive, result,
        new Set([idKey(loaded.item.Id)]), reportProgress, child => !sameId(child.Id, loaded.item.Id)); }
      finally { await children.close(); }
    });
    result.cancelled = options.signal?.aborted === true;
    return Object.freeze({ ...result, errors: Object.freeze(result.errors) });
  }

  async refreshAccessibleChildren(children, options = {}, { recursive = true, reportProgress = () => {} } = {}) {
    if (!children || typeof children.pages !== 'function' || typeof children.close !== 'function') {
      throw new TypeError('Metadata child traversal requires an owned accessible child sequence.');
    }
    options = metadataScanOptions(options);
    const result = receipt();
    try { await this.#runChildren(children, options, recursive, result, new Set(), reportProgress); }
    finally { await children.close(); }
    result.cancelled = options.signal?.aborted === true;
    return Object.freeze({ ...result, errors: Object.freeze(result.errors) });
  }

  async refreshContainer(reference, options = {}, { reportProgress = () => {} } = {}) {
    options = metadataScanOptions(options);
    const result = receipt();
    await this.#withState(reference, async loaded => {
      if (!metadataContainer(loaded.item)) throw libraryError(400, 'Metadata container traversal requires a supported container.');
      await this.#child(loaded.item, options, true, result, new Set([idKey(loaded.item.Id)]), reportProgress);
    });
    result.cancelled = options.signal?.aborted === true;
    return Object.freeze({ ...result, errors: Object.freeze(result.errors) });
  }

  async #refresh(item, options, receipt) {
    options.signal?.throwIfAborted();
    receipt.attemptedCount++;
    const result = await this.metadata.refresh(item.Id, options);
    receipt.updatedCount += Number(result?.changed === true);
    receipt.providerFailures += result?.Failures ?? 0;
    return result?.UpdateType ?? ItemUpdateType.None;
  }

  #report(error) {
    try { void Promise.resolve(this.logger.error(error, 'Error while performing a library operation')).catch(() => {}); }
    catch { /* Logging cannot interrupt the native per-child continuation. */ }
  }

  #progress(reportProgress, value) {
    try { reportProgress(value); }
    catch { /* A progress observer cannot replace the refresh result. */ }
  }

  async #children(parent, options, recursive, receipt, ancestors, reportProgress = () => {}) {
    await this.#withState(parent, async ({ children: factory, item }) => {
      const children = await factory.physical(item);
      try { await this.#runChildren(children, options, recursive, receipt, ancestors, reportProgress,
        child => !sameId(child.Id, parent.Id) && !ancestors.has(idKey(child.Id))); }
      finally { await children.close(); }
    });
  }

  async #runChildren(children, options, recursive, receipt, ancestors, reportProgress, predicate = () => true) {
    await this.scheduler.enqueue(children, (child, progress) => {
      const branch = new Set(ancestors);
      if (nonemptyId(child.ParentId)) branch.add(idKey(child.ParentId));
      return this.#child(child, options, recursive && child.IsFolder, receipt, branch, progress);
    }, { signal: options.signal, reportProgress: value => this.#progress(reportProgress, value), predicate,
      onError: (error, child) => {
        receipt.errors.push(Object.freeze({ itemId: child.Id, type: child.Type, name: child.Name,
          code: error.code ?? error.name, message: error.message }));
        this.#report(error);
      } });
  }

  async #child(child, options, recursive, receipt, ancestors, reportProgress = () => {}) {
    if (child.Type === 'Series') {
      await this.#refresh(child, options, receipt);
      setFolderChildren(child, null);
      try {
        await this.#withState(child, async ({ children: factory, item }) => {
          const children = await factory.recursive(item), total = Number(await children.count());
          let completed = 0;
          try {
            for await (const page of children.pages()) for (const entry of page) if (entry.Type === 'Season') {
              options.signal?.throwIfAborted();
              if (refreshItem(entry, options)) await this.#refresh(entry, options, receipt);
              this.#progress(reportProgress, ++completed / total * 100);
            }
            for await (const page of children.pages()) for (const entry of page) if (entry.Type !== 'Season') {
              options.signal?.throwIfAborted();
              const missing = entry.Type === 'Episode' && entry.LocationType === 'Virtual';
              const skip = options.MetadataRefreshMode !== 'FullRefresh' && !options.ReplaceAllMetadata && missing && entry.PremiereDate != null
                && dateTicks(this.now()) - dateTicks(entry.PremiereDate) > 30n * dayTicks;
              if (!skip && refreshItem(entry, options)) await this.#refresh(entry, options, receipt);
              this.#progress(reportProgress, ++completed / total * 100);
            }
            await this.#refresh(item, copyRefreshOptions(options), receipt);
          } finally { await children.close(); }
        });
      } finally { releaseCachedFolderChildren(child); }
    } else if (child.Type === 'MusicAlbum') {
      try {
        await this.#withState(child, async ({ children: factory, item }) => {
          const children = await factory.recursive(item), total = Number(await children.count());
          let updateType = ItemUpdateType.None, completed = 0;
          try {
            for await (const page of children.pages()) for (const entry of page) {
              options.signal?.throwIfAborted();
              updateType |= await this.#refresh(entry, options, receipt);
              this.#progress(reportProgress, ++completed / total * 95);
            }
            const parentOptions = updateType > ItemUpdateType.None ? { ...copyRefreshOptions(options), MetadataRefreshMode: 'FullRefresh' } : options;
            await this.#refresh(item, parentOptions, receipt);
            if (!options.IsAutomated) await this.#withState(item, async ({ item: current }) => {
              const seen = new Set();
              for (const name of [...(current.AlbumArtists ?? []), ...(current.Artists ?? [])]) {
                const key = ordinalIgnoreCaseKey(removeDiacritics(name ?? ''));
                if (seen.has(key)) continue;
                seen.add(key);
                if (name == null || name === '') continue;
                const artist = await this.library.getArtist(name);
                if (!artist) continue;
                const owner = this.library.itemCreation.retainItem(artist);
                try { if (!nonemptyId(artist.ParentId)) await this.#refresh(artist, options, receipt); }
                finally { owner.release(); await this.metadata.loadContext.linkedChildren.flushReleases(); }
              }
            });
          } finally { await children.close(); }
        });
      } finally { releaseCachedFolderChildren(child); }
    } else {
      if (refreshItem(child, options)) await this.#refresh(child, options, receipt);
      if (recursive) {
        const branch = new Set(ancestors).add(idKey(child.Id));
        setFolderChildren(child, null);
        try {
          await this.#children(child, options, true, receipt, branch, reportProgress);
        } finally { releaseCachedFolderChildren(child); }
      }
    }
  }
}
