import { collectionType } from '../library/user-view-query.js';
import { readNativeImageRows } from '../database/native-relation-order.js';
import { guid, idKey, mapRecord, nonemptyId, dateTicks, MIN_DATE, unsupported } from '../library/records.js';
import { nativePathWithin } from '../library/native-path.js';
import { internalImagePath, imageTypes } from './image-paths.js';
import { MetadataImageAssets, imagePathApi } from './image-assets.js';
import { ItemUpdateType } from './save-manager.js';

const remote = image => /^http/iu.test(image.Path);

/** The provider runs the actual view query, including its native null-user failure. */
export function createUserViewDynamicImagePlugin({ library, users }) {
  if (!library || !users) throw new TypeError('Dynamic UserView images require the library and users.');
  const metadataPath = library.options.metadataPath ?? (library.options.programDataPath && imagePathApi(library.options.programDataPath).join(library.options.programDataPath, 'metadata'));
  const assets = new MetadataImageAssets({ fileSystem:library.options.fileSystem, metadataPath });
  const supports = item => item.Type === 'UserView' && ['movies', 'tvshows', 'playlists'].includes(collectionType(item));
  const primaryImage = images => images.find(image => (image.Type ?? imageTypes[image.ImageType]) === 'Primary');
  const protectedImage = (item, image) => image && (remote(image) || !nativePathWithin(image.Path, internalImagePath(item, metadataPath)));
  const candidates = async view => {
    // Native GetItemsWithImages has no cancellation token. Its synchronous
    // query result/error precedes the cancellation-aware SaveImage stage.
    const user = nonemptyId(view.UserId) ? await users.getUser(view.UserId) : null;
    // DtoOptions(false) suppresses projection-only data; candidate records and
    // images are loaded from their authoritative tables after the actual query.
    const result = await library.queryItems({ ParentId: view.Id, Recursive: collectionType(view) !== 'playlists',
      CollapseBoxSetItems: false, ExcludeItemTypes: 'UserView,CollectionFolder,Person', EnableImages: false,
      EnableUserData: false, EnableTotalRecordCount: false }, { user, fromUserViewChildren: true });
    return library.store.run(async db => {
      const requestedIds = [...new Set(result.Items.map(item => item.Id).filter(nonemptyId).map(guid))];
      const records = (requestedIds.length
        ? await db.rows('BaseItems', { whereIn: { Id: requestedIds } }) : []).map(mapRecord).filter(Boolean);
      const referencedIds = [...new Set(records.flatMap(item => ['Episode', 'Season'].includes(item.Type)
        ? [item.SeriesId] : item.Type === 'Audio' ? [item.ParentId] : []).filter(nonemptyId))];
      if (referencedIds.length) records.push(...(await db.rows('BaseItems', { whereIn: { Id: referencedIds } }))
        .map(mapRecord).filter(Boolean));
      const byId = new Map(records.map(item => [idKey(item.Id), item]));
      const imageIds = [...byId.values()].map(item => item.Id);
      const images = imageIds.length
        ? await readNativeImageRows(db, imageIds) : [];
      const hasImage = (item, types) => images.some(image => idKey(image.ItemId) === idKey(item.Id) && types.includes(imageTypes[image.ImageType] ?? image.ImageType));
      const seen = new Set(), selected = [];
      for (const dto of result.Items) {
        let item = byId.get(idKey(dto.Id));
        if (!item) continue;
        if (['Episode', 'Season'].includes(item.Type)) item = byId.get(idKey(item.SeriesId)) ?? item;
        else if (item.Type === 'Audio') {
          const album = byId.get(idKey(item.ParentId));
          if (album?.Type === 'MusicAlbum' && hasImage(album, ['Primary'])) item = album;
        }
        if (seen.has(idKey(item.Id))) continue;
        seen.add(idKey(item.Id));
        if (!hasImage(item, ['Primary', 'Thumb'])) continue;
        const choices = images.filter(image => idKey(image.ItemId) === idKey(item.Id));
        const image = ['Backdrop', 'Primary', 'Thumb'].map(type => choices.find(value => (imageTypes[value.ImageType] ?? value.ImageType) === type && !remote(value))).find(Boolean);
        selected.push({ item, image: image ? { ...image, Path: library.options.expandPath?.(image.Path) ?? image.Path } : null });
      }
      return selected;
    }, { readOnly: true });
  };
  const provider = { id: 'user-view-dynamic-images', name: 'Dynamic Image Provider', kind: 'custom', itemTypes: ['UserView'],
    forced: true, order: 0, supports,
    async hasChanged(item, { images = [] } = {}) {
      if (!supports(item)) return false;
      const image = primaryImage(images);
      if (!image) return (await candidates(item)).length > 0;
      if (protectedImage(item, image)) return false;
      let modified = MIN_DATE;
      try { modified = (await assets.stat(image.Path)).modified; }
      catch (error) { if (error.code !== 'not-found') throw error; }
      // ManagedFileSystem returns default(DateTime) for an absent file.
      return dateTicks(image.DateModified) !== dateTicks(modified);
    },
    async fetch(item, { images = [] } = {}) {
      if (!supports(item) || protectedImage(item, primaryImage(images))) return ItemUpdateType.None;
      if (!(await candidates(item)).some(candidate => candidate.image)) return ItemUpdateType.None;
      // A supported source with real local images requires native collage
      // creation and SaveImage. Keep that unimplemented path explicit.
      unsupported('UserView image collage creation is not implemented.');
    }
  };
  return { id: 'builtin-user-view-dynamic-images', name: 'UserView Dynamic Images', providers: [provider] };
}
