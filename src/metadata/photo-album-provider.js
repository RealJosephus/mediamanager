import { randomUUID } from 'node:crypto';
import { queryPhotoAlbumCover } from '../library/photo-album-cover.js';
import { dateTicks, MIN_DATE } from '../library/records.js';
import { nativeContainsSubPath, sameNativePath } from '../library/native-path.js';
import { MetadataImageAssets, imagePathApi } from './image-assets.js';
import { internalImagePath, imageTypes } from './image-paths.js';
import { ItemUpdateType } from './save-manager.js';
import { getMimeType } from '../http/mime-types.js';

const remote = value => /^http/iu.test(value);
const primary = images => images.find(image => (image.Type ?? imageTypes[image.ImageType]) === 'Primary');
export function createPhotoAlbumImagePlugin({ store, fileSystem, vfs, identityMap, metadataIdentityMap = identityMap,
  metadataPath, tempPath, images: metadataImages, configuration = {}, expandPath = value => value, logger = { error() {} } }) {
  if (!store || !metadataImages) {
    throw new TypeError('Photo album images require authoritative storage and image saving.');
  }
  const metadataAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap: metadataIdentityMap, metadataPath });
  const mediaAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap, metadataPath });
  const temporaryAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap: metadataIdentityMap, metadataPath,
    stateRoots: [tempPath].filter(Boolean) });
  const protectedImage = (item, image) => image && (remote(image.Path)
    || !metadataPath || !nativeContainsSubPath(image.Path, internalImagePath(item, metadataPath)));
  const select = item => store.run(database => queryPhotoAlbumCover(database, item.Id), { readOnly: true });
  const provider = { id: 'photo-album-images', name: 'Dynamic Image Provider', kind: 'custom',
    itemTypes: ['PhotoAlbum'], forced: true, order: 0,
    async hasChanged(item, { images = [], imageAssets = metadataAssets } = {}) {
      if (item.Type !== 'PhotoAlbum') return false;
      const image = primary(images);
      if (!image) return Boolean(await select(item));
      if (protectedImage(item, image)) return false;
      let modified = MIN_DATE;
      try { modified = (await imageAssets.stat(image.Path)).modified ?? MIN_DATE; }
      catch (error) { if (error.code !== 'not-found') throw error; }
      return dateTicks(image.DateModified) !== dateTicks(modified);
    },
    async fetch(item, { images = [], imageAssets = metadataAssets, signal } = {}) {
      if (item.Type !== 'PhotoAlbum' || protectedImage(item, primary(images))) return ItemUpdateType.None;
      // The synchronous native selection/copy precedes cancellation-aware SaveImage.
      const selected = await select(item);
      if (!selected) return ItemUpdateType.None;
      const source = expandPath(selected.ImagePath);
      if (remote(source) || !source) return ItemUpdateType.None;
      const extension = imagePathApi(source).extname(source);
      if (!extension || extension === '.') return ItemUpdateType.None;
      if (!metadataPath || !tempPath) throw Object.assign(new Error('Photo album image storage requires mapped metadata and temporary paths.'),
        { code: 'metadata-context-required', status: 503 });
      let assets = imageAssets;
      if (selected.Type === 'Photo' && sameNativePath(source, expandPath(selected.Path))) {
        let accessPath;
        if (identityMap) try {
          accessPath = identityMap.resolve({ itemId: selected.Id, identityPath: expandPath(selected.Path),
            style: imagePathApi(source).sep === '\\' ? 'windows' : 'posix' });
        } catch (error) { if (error.code !== 'not-found') throw error; }
        assets = accessPath ? mediaAssets.forItem({ ...selected, Path: source }, accessPath) : mediaAssets;
      }
      const bytes = await assets.read(source);
      const temporary = imagePathApi(tempPath).join(tempPath, randomUUID().replaceAll('-', '') + extension);
      await temporaryAssets.write(temporary, bytes);
      const sourceMimeType = getMimeType(temporary);
      const mimeType = sourceMimeType.toLowerCase() === 'application/octet-stream' ? 'image/png' : sourceMimeType;
      const savingAssets = {
        async write(identity, value, options) {
          // ImageSaver creates/truncates the file before its cancellation-aware
          // stream copy. Keep that observable prefix on cancellation or failure.
          await imageAssets.write(identity, Buffer.alloc(0));
          options.signal?.throwIfAborted();
          return imageAssets.write(identity, value, options);
        },
        delete: (identity, options) => imageAssets.delete(identity, options)
      };
      try {
        await metadataImages.saveRemote({ item, imageAssets: savingAssets, metadataPath, globalOptions: configuration,
          saveLocalMetadataEnabled: false }, images, { Type: 'Primary', Url: temporary }, {
          signal, index: 0, download: async () => ({ bytes: await temporaryAssets.read(temporary), mimeType })
        });
      } finally {
        // The actual ProviderManager file overload removes its copied source,
        // including ordinary SaveImage failure and cancellation.
        try { await temporaryAssets.delete(temporary); }
        catch (error) { logger.error(error, 'Could not remove the copied photo album image.'); }
      }
      return ItemUpdateType.None | ItemUpdateType.ImageUpdate;
    }
  };
  return { id: 'builtin-photo-album-images', name: 'Photo Album Images', providers: [provider] };
}
