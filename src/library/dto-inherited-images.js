import { md5Guid } from '../core/identity.js';
import { parentChainForItem } from './collection-membership.js';
import { collectionType } from './user-view-query.js';
import { dateTicks, dtoId, idKey, VIDEO_TYPES } from './records.js';

const imageTypes = { 0: 'Primary', 2: 'Backdrop', 4: 'Logo', 5: 'Thumb' };

export function imageTagAndBlurHash(dto, item, image) {
  const tag = md5Guid(`${item.Path ?? ''}${dateTicks(image.DateModified)}`);
  if (image.Blurhash?.length) {
    const type = imageTypes[image.ImageType];
    dto.ImageBlurHashes ??= new Map();
    if (!dto.ImageBlurHashes.has(type)) dto.ImageBlurHashes.set(type, new Map());
    dto.ImageBlurHashes.get(type).set(tag, Buffer.from(image.Blurhash).toString('utf8'));
  }
  return tag;
}

export function supportsInheritedImages(item) {
  return VIDEO_TYPES.has(item.Type)
    || ['Audio', 'AudioBook', 'Folder', 'AggregateFolder', 'MusicAlbum', 'Season'].includes(item.Type);
}

export async function imageDisplayParent(current, original, state) {
  if (current.Type === 'MusicAlbum') {
    const name = current.AlbumArtists?.[0];
    const batched = name && state.dtoImageArtistsBatch?.get(name)?.[0];
    if (batched) return batched;
    const physical = parentChainForItem(current, state).find(parent => parent.Type === 'MusicArtist');
    if (physical) return physical;
    if (name) {
      const artist = state.getImageArtist ? await state.getImageArtist(name)
        : state.items.find(item => item.Type === 'MusicArtist' && item.Name === name);
      if (artist) return artist;
    }
  }
  const displayId = current.Type === 'Episode' ? current.SeasonId
    : current.Type === 'Season' ? current.SeriesId : current.ParentId;
  let parent = state.byId.get(idKey(displayId)) ?? state.byId.get(idKey(current.OwnerId))
    ?? state.byId.get(idKey(current.ParentId));
  if (!parent && !['UserRootFolder', 'UserView', 'AggregateFolder', 'CollectionFolder', 'Channel'].includes(original.Type)) {
    parent = (await state.library.getCollectionFolders(original, state))[0];
  }
  return parent;
}

export async function addInheritedImages(dto, item, state, selected, options, readImages) {
  const limit = type => selected.enableImages && selected.imageTypeLimit > 0
    && selected.imageTypes.some(value => value.toLowerCase() === type.toLowerCase()) ? selected.imageTypeLimit : 0;
  if (item.Type === 'UserView' && collectionType(item) === 'playlists' && limit('Primary') > 0) {
    const display = state.byId.get(idKey(item.DisplayParentId));
    const primary = display && (await readImages(display)).find(image => image.ImageType === 0);
    if (primary) {
      dto.ImageTags?.delete('Primary');
      dto.ParentPrimaryImageItemId = dtoId(display.Id);
      dto.ParentPrimaryImageTag = imageTagAndBlurHash(dto, display, primary);
    }
  }
  if (!supportsInheritedImages(item)) return;
  const logo = limit('Logo'), thumb = limit('Thumb'), backdrop = limit('Backdrop');
  if (!logo && !thumb && !backdrop) return;
  let parent, first = true;
  const seen = new Set([idKey(item.Id)]);
  // Native deliberately disables Art inheritance. Its traversal admission uses
  // the item's own Logo/Thumb tags and Series, not the inherited fields.
  while ((!dto.ImageTags?.has('Logo') && logo > 0) || (!dto.ImageTags?.has('Thumb') && thumb > 0) || parent?.Type === 'Series') {
    parent ??= first ? await imageDisplayParent(item, item, state) ?? options.owner : parent;
    if (!parent || seen.has(idKey(parent.Id))) break;
    seen.add(idKey(parent.Id));
    const images = await readImages(parent);
    if (logo > 0 && !dto.ImageTags?.has('Logo') && dto.ParentLogoItemId == null) {
      const image = images.find(image => image.ImageType === 4);
      if (image) {
        dto.ParentLogoItemId = dtoId(parent.Id);
        dto.ParentLogoImageTag = imageTagAndBlurHash(dto, parent, image);
      }
    }
    if (thumb > 0 && !dto.ImageTags?.has('Thumb') && (dto.ParentThumbItemId == null || parent.Type === 'Series')
      && !['CollectionFolder', 'UserView'].includes(parent.Type)) {
      const image = images.find(image => image.ImageType === 5);
      if (image) {
        dto.ParentThumbItemId = dtoId(parent.Id);
        dto.ParentThumbImageTag = imageTagAndBlurHash(dto, parent, image);
      }
    }
    if (backdrop > 0 && !dto.BackdropImageTags?.length && !dto.ParentBackdropImageTags?.length) {
      const selectedImages = images.filter(image => image.ImageType === 2).slice(0, backdrop);
      if (selectedImages.length) {
        dto.ParentBackdropItemId = dtoId(parent.Id);
        dto.ParentBackdropImageTags = selectedImages.map(image => imageTagAndBlurHash(dto, parent, image));
        const hashes = selectedImages.filter(image => image.Blurhash?.length);
        if (hashes.length) dto.ImageBlurHashes.set('Backdrop', new Map(hashes.map(image => [
          imageTagAndBlurHash(dto, parent, image), Buffer.from(image.Blurhash).toString('utf8')])));
      }
    }
    first = false;
    if (!supportsInheritedImages(parent)) break;
    parent = await imageDisplayParent(parent, item, state);
  }
}
