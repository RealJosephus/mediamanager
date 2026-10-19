import { randomUUID } from 'node:crypto';
import { dateTicks } from '../library/records.js';
import { nativeContainsSubPath } from '../library/native-path.js';
import { withCollectionFolderImageCandidates } from '../library/collection-folder-image-query.js';
import { composeUserViewCollage } from '../images/user-view-collage.js';
import { internalImagePath, imageTypes } from './image-paths.js';
import { MetadataImageAssets, imagePathApi } from './image-assets.js';
import { ItemUpdateType } from './save-manager.js';

const week = 7n * 24n * 60n * 60n * 10000000n;
const primary = images => images.find(image => (image.Type ?? imageTypes[image.ImageType]) === 'Primary');

export function createCollectionFolderImagePlugin({ library, images: metadataImages, compose = composeUserViewCollage }) {
  if (!library || !metadataImages) throw new TypeError('Collection images require the library and image saving.');
  const metadataPath = library.options.metadataPath ?? (library.options.programDataPath
    && imagePathApi(library.options.programDataPath).join(library.options.programDataPath, 'metadata'));
  const fileSystem = library.options.fileSystem;
  const assets = new MetadataImageAssets({ fileSystem, vfs: fileSystem?.vfs, identityMap: fileSystem?.identityMap, metadataPath });
  const tempPath = library.options.programDataPath
    && imagePathApi(library.options.programDataPath).join(library.options.programDataPath, 'cache', 'temp');
  const temporaryAssets = new MetadataImageAssets({ fileSystem, metadataPath, stateRoots: [tempPath].filter(Boolean) });
  const protectedImage = (item, image) => image && (/^http/iu.test(image.Path)
    || !metadataPath || !nativeContainsSubPath(image.Path, internalImagePath(item, metadataPath)));
  const provider = { id: 'collection-folder-images', name: 'Dynamic Image Provider', kind: 'custom',
    itemTypes: ['CollectionFolder'], forced: true, order: 0,
    async hasChanged(item, { images = [] } = {}) {
      if (item.Type !== 'CollectionFolder') return false;
      const image = primary(images);
      if (!image) return withCollectionFolderImageCandidates(library, item, selected => selected.hasItems());
      if (protectedImage(item, image)) return false;
      return dateTicks(library.clock().toISOString()) - dateTicks(image.DateModified) > week;
    },
    async fetch(item, { images = [], imageAssets = assets, signal } = {}) {
      if (item.Type !== 'CollectionFolder' || protectedImage(item, primary(images))) return ItemUpdateType.None;
      // The native synchronous query and collage precede cancellation-aware SaveImage.
      const output = await withCollectionFolderImageCandidates(library, item, async selected => {
        if (!metadataPath || !tempPath) throw Object.assign(new Error('Collection image storage requires mapped metadata and temporary paths.'),
          { code: 'metadata-context-required', status: 503 });
        await temporaryAssets.createDirectory(tempPath);
        const paths = selected.paths(), first = await paths.next();
        if (first.done) return null;
        async function* sources() { try { yield first.value; yield* paths; } finally { await paths.return(); } }
        return compose(sources(), item.Name, { assets: imageAssets });
      });
      if (!output) return ItemUpdateType.None;
      const temporary = imagePathApi(tempPath).join(tempPath, randomUUID().replaceAll('-', '') + '.png');
      await temporaryAssets.write(temporary, output);
      try {
        await metadataImages.saveImage({ item, metadataPath, imageAssets,
          globalOptions: library.options.configuration, saveLocalMetadataEnabled: false }, images,
        { Type: 'Primary', bytes: await temporaryAssets.read(temporary), mimeType: 'image/png' }, { signal, index: 0 });
      } finally {
        try { await temporaryAssets.delete(temporary); } catch (error) { library.onError(error); }
      }
      return ItemUpdateType.ImageUpdate;
    }
  };
  return { id: 'builtin-collection-folder-images', name: 'Collection Folder Images', providers: [provider] };
}
