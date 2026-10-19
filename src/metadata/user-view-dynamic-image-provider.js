import { collectionType } from '../library/user-view-query.js';
import { randomUUID } from 'node:crypto';
import { nonemptyId, dateTicks, MIN_DATE } from '../library/records.js';
import { nativeContainsSubPath } from '../library/native-path.js';
import { withUserViewImageCandidates } from '../library/user-view-image-query.js';
import { internalImagePath, imageTypes } from './image-paths.js';
import { MetadataImageAssets, imagePathApi } from './image-assets.js';
import { ItemUpdateType } from './save-manager.js';
import { composeUserViewCollage } from '../images/user-view-collage.js';

const remote = image => /^http/iu.test(image.Path);

/** The provider runs the actual view query, including its native null-user failure. */
export function createUserViewDynamicImagePlugin({ library, users, images: metadataImages, compose = composeUserViewCollage }) {
  if (!library || !users) throw new TypeError('Dynamic UserView images require the library and users.');
  const metadataPath = library.options.metadataPath ?? (library.options.programDataPath && imagePathApi(library.options.programDataPath).join(library.options.programDataPath, 'metadata'));
  const fileSystem = library.options.fileSystem;
  const assets = new MetadataImageAssets({ fileSystem, vfs: fileSystem?.vfs, identityMap: fileSystem?.identityMap, metadataPath });
  const tempPath = library.options.programDataPath && imagePathApi(library.options.programDataPath).join(library.options.programDataPath, 'cache', 'temp');
  const temporaryAssets = new MetadataImageAssets({ fileSystem: library.options.fileSystem, metadataPath, stateRoots: [tempPath].filter(Boolean) });
  const supports = item => item.Type === 'UserView' && ['movies', 'tvshows', 'playlists'].includes(collectionType(item));
  const primaryImage = images => images.find(image => (image.Type ?? imageTypes[image.ImageType]) === 'Primary');
  const protectedImage = (item, image) => image && (remote(image) || !nativeContainsSubPath(image.Path, internalImagePath(item, metadataPath)));
  const candidates = async (view, operation) => {
    // Native GetItemsWithImages has no cancellation token. Its synchronous
    // query result/error precedes the cancellation-aware SaveImage stage.
    const user = nonemptyId(view.UserId) ? await users.getUser(view.UserId) : null;
    return withUserViewImageCandidates(library, view, user, operation);
  };
  const provider = { id: 'user-view-dynamic-images', name: 'Dynamic Image Provider', kind: 'custom', itemTypes: ['UserView'],
    forced: true, order: 0, supports,
    async hasChanged(item, { images = [], imageAssets = assets } = {}) {
      if (!supports(item)) return false;
      const image = primaryImage(images);
      if (!image) return candidates(item, selected => selected.hasItems());
      if (protectedImage(item, image)) return false;
      let modified = MIN_DATE;
      try { modified = (await imageAssets.stat(image.Path)).modified; }
      catch (error) { if (error.code !== 'not-found') throw error; }
      // ManagedFileSystem returns default(DateTime) for an absent file.
      return dateTicks(image.DateModified) !== dateTicks(modified);
    },
    async fetch(item, { images = [], imageAssets = assets, signal } = {}) {
      if (!supports(item) || protectedImage(item, primaryImage(images))) return ItemUpdateType.None;
      const output = await candidates(item, async selected => {
        if (!metadataPath || !tempPath) throw Object.assign(new Error('UserView image storage requires mapped metadata and temporary paths.'),
          { code: 'metadata-context-required', status: 503 });
        await temporaryAssets.createDirectory(tempPath);
        const paths = selected.paths(), first = await paths.next();
        if (first.done) return null;
        async function* sources() { try { yield first.value; yield* paths; } finally { await paths.return(); } }
        return compose(sources(), item.Name, { assets });
      });
      if (!output) return ItemUpdateType.None;
      const temporary = imagePathApi(tempPath).join(tempPath, randomUUID().replaceAll('-', '') + '.png');
      await temporaryAssets.write(temporary, output);
      try {
        await (metadataImages ?? library.userViews.images).saveImage({ item, metadataPath, imageAssets,
          globalOptions: library.options.configuration, saveLocalMetadataEnabled: false }, images,
        { Type: 'Primary', bytes: await temporaryAssets.read(temporary), mimeType: 'image/png' }, { signal, index: 0 });
      } finally {
        try { await temporaryAssets.delete(temporary); }
        catch (error) { library.onError(error); }
      }
      return ItemUpdateType.ImageUpdate;
    }
  };
  return { id: 'builtin-user-view-dynamic-images', name: 'UserView Dynamic Images', providers: [provider] };
}
