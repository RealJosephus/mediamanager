import { isDeepStrictEqual } from 'node:util';
import { nativeGuid } from '../users/native.js';
import { StorageError } from '../storage/errors.js';
import { probeFileChanged, probeIsVideo } from '../storage/probe-lifecycle.js';
import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import { internalImagePath } from '../metadata/image-paths.js';
import { nativeContainingFolderPath, nativeFileName, nativeFileNameWithoutExtension } from './native-path.js';
import { VIDEO_TYPES, nonemptyId, sameId } from './records.js';
import { isNativeItemEntity } from './native-item-entity.js';
import { assertMetadataBaseline } from '../metadata/metadata-baseline.js';

export class ExternalDataManager {
  #options;
  constructor(options) {
    const { fileSystem, store, vfs, identityMap, segmentProviders = [], logger = {} } = options;
    if (!store) throw new TypeError('External data cleanup requires native persistence.');
    this.#options = options;
    Object.assign(this, { fileSystem, store, vfs, identityMap, segmentProviders, logger });
  }
  get dataPath() { return this.#options.dataPath; }
  get trickplayPath() { return this.#options.trickplayPath; }
  get metadataPath() { return this.#options.metadataPath; }

  #roots(loaded) {
    const dataPath = loaded?.dataPath ?? this.dataPath, metadataPath = loaded?.metadataPath ?? this.metadataPath;
    const trickplayPath = this.trickplayPath ?? (dataPath && imagePathApi(dataPath).join(dataPath, 'trickplay'));
    return { dataPath, metadataPath, trickplayPath };
  }

  paths(item, loaded) { return this.#paths(item, this.#roots(loaded)); }

  #paths(item, { dataPath, metadataPath, trickplayPath }) {
    const id = nativeGuid(item.Id).toLowerCase(), paths = [];
    if (dataPath) for (const directory of ['attachments', 'subtitles']) paths.push(imagePathApi(dataPath).join(dataPath, directory, id.slice(0, 2), id));
    if (trickplayPath) paths.push(imagePathApi(trickplayPath).join(trickplayPath, id.slice(0, 2), id));
    if (item.Path) {
      const api = imagePathApi(item.Path), name = nativeFileName(item.Path);
      paths.push(api.join(nativeContainingFolderPath(item) ?? '', name ? nativeFileNameWithoutExtension(name) + '.trickplay' : ''));
    }
    if (metadataPath) paths.push(imagePathApi(metadataPath).join(internalImagePath(item, metadataPath), 'chapters'));
    return paths;
  }

  async internalPaths(item, loaded) {
    return this.#internalPaths(item, loaded, this.#roots(loaded));
  }

  async #internalPaths(item, loaded, { dataPath, metadataPath, trickplayPath }) {
    const id = nativeGuid(item.Id).toLowerCase(), paths = [];
    if (metadataPath) paths.push(internalImagePath(item, metadataPath));
    if (VIDEO_TYPES.has(item.Type)) {
      if (trickplayPath) paths.push(imagePathApi(trickplayPath).join(trickplayPath, id.slice(0, 2), id));
      if (metadataPath) paths.push(imagePathApi(metadataPath).join(internalImagePath(item, metadataPath), 'chapters'));
      if (typeof loaded?.getMediaSources !== 'function') throw new TypeError('Internal video cleanup requires actual live media sources.');
      // LibraryManager enumerates GetMediaSources(false) before file deletion.
      // A promoted linked alternate keeps its own metadata and trickplay, but
      // its extracted subtitles and attachments belong to this cleanup too.
      for (const source of await loaded.getMediaSources(item)) {
        let sourceId;
        try { sourceId = nativeGuid(source.Id).toLowerCase(); }
        catch { continue; } // PathManager has no on-disk folder for a non-GUID source.
        if (dataPath) for (const directory of ['subtitles', 'attachments']) {
          paths.push(imagePathApi(dataPath).join(dataPath, directory, sourceId.slice(0, 2), sourceId));
        }
      }
    }
    return paths;
  }

  #assets(item, loaded, { dataPath, metadataPath, trickplayPath }) {
    const assets = new MetadataImageAssets({ fileSystem: this.fileSystem, vfs: this.vfs, identityMap: this.identityMap, ...loaded?.imageAssets,
      metadataPath, stateRoots: [...loaded?.imageAssets?.stateRoots ?? [], ...[dataPath, trickplayPath].filter(Boolean)] });
    return assets.forItem(item, loaded?.context?.accessPath);
  }

  async deleteItemFiles(item, { loaded, onError } = {}) {
    const roots = this.#roots(loaded), assets = this.#assets(item, loaded, roots);
    for (const directory of this.#paths(item, roots)) {
      // Directory.Exists ignores missing paths, files and inaccessible locations.
      let info;
      try { info = await assets.stat(directory); } catch { continue; }
      if (info.kind !== 'directory') continue;
      try { await assets.deleteDirectory(directory); }
      catch (error) {
        if (onError) onError(error, directory);
        else this.logger.warn?.(error, `Unable to prune external item data at ${directory}`);
      }
    }
  }

  async deleteInternalItemFiles(item, { loaded } = {}) {
    const roots = this.#roots(loaded), assets = this.#assets(item, loaded, roots);
    // LibraryManager removes the internal metadata directory for every item;
    // only Video adds extracted-data paths before attempting the source. The
    // later external cleanup repeats them and adds media-local trickplay.
    for (const directory of await this.#internalPaths(item, loaded, roots)) {
      let info;
      try { info = await assets.stat(directory); } catch { continue; }
      if (info.kind !== 'directory') continue;
      try { await assets.deleteDirectory(directory); }
      catch (error) { this.logger.error?.(error, `Error deleting ${directory}`); }
    }
  }

  async deleteItemData(item, { loaded, signal } = {}) {
    return this.store.serializeWrites(async () => {
      await this.deleteItemFiles(item, { loaded });
      const itemId = nativeGuid(item.Id);
      // Each native manager executes its own deletion. A later failure retains
      // earlier files and database deletions rather than rolling them back.
      await this.store.transaction(database => database.deleteWhere('KeyframeData', { ItemId: itemId }), { signal });
      for (const provider of this.segmentProviders) {
        try { await provider.cleanupExtractedData(itemId, { signal }); }
        catch (error) { this.logger.error?.(error, `Provider ${provider.name} failed to clean up extracted data for item ${itemId}`); }
      }
      await this.store.transaction(database => database.deleteWhere('MediaSegments', { ItemId: itemId }), { signal });
      await this.store.transaction(database => database.deleteWhere('TrickplayInfos', { ItemId: itemId }), { signal });
      await this.store.transaction(database => database.deleteWhere('Chapters', { ItemId: itemId }), { signal });
    }, { signal });
  }

  async invalidateChangedVideo(item, modified, { expectedSnapshot, loaded } = {}) {
    if (!probeIsVideo(item) || !probeFileChanged(item, modified)) return false;
    return this.store.serializeWrites(async database => {
      const current = (await database.rows('BaseItems', { where: { Id: nativeGuid(item.Id) } }))[0];
      const changed = expectedSnapshot ? !isDeepStrictEqual(current, expectedSnapshot)
        : !current || current.Path !== item.Path || current.Data !== item.Data || current.DateModified !== item.DateModified;
      const creatingOwnedExtra = !current && expectedSnapshot === undefined && loaded?.snapshot === undefined
        && loaded?.creationIntent === 'owned-extra' && loaded.ownedExtraOwner?.snapshot
        && isNativeItemEntity(loaded.item) && sameId(loaded.item.Id, item.Id)
        && ['Video', 'Trailer'].includes(item.Type) && item.ExtraType != null
        && nonemptyId(item.OwnerId) && !nonemptyId(item.ParentId)
        && sameId(item.Id, loaded.getNewItemId(item.Path, item.NativeType));
      if (changed && !creatingOwnedExtra) throw new StorageError('version-changed', 'The media item changed before external data invalidation.');
      // BeforeSave may invalidate extracted data before the first INSERT.
      // Validate the absent-row/owner/relationship frame under the write lock
      // before any file or independently committed database cleanup.
      if (creatingOwnedExtra) await assertMetadataBaseline(database, loaded);
      // MetadataService invokes this cleanup with CancellationToken.None.
      await this.deleteItemData(item, { loaded });
      return true;
    });
  }
}
