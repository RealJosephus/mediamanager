import { imagePathApi } from './image-assets.js';
import { readPhotoTags } from './photo-tags.js';
import { clrTrim } from './whitespace.js';
import { ItemUpdateType } from './save-manager.js';
import { dateTicks, MIN_DATE } from '../library/records.js';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.cr2', '.webp', '.avif']);
const orientations = [null, 'TopLeft', 'TopRight', 'BottomRight', 'BottomLeft', 'LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'];

export function createPhotoMetadataPlugin({ imageProcessor, logger = { error() {} } } = {}) {
  if (typeof imageProcessor?.getImageSize !== 'function') throw new TypeError('Photo metadata requires static image dimensions.');
  const provider = { id: 'embedded-photo-information', name: 'Embedded Information', kind: 'custom', itemTypes: ['Photo'], forced: true,
    async hasChanged(item, { fileSystemMetadata } = {}) {
      if (!item.IsFileProtocol) return false;
      if (typeof fileSystemMetadata !== 'function') throw new TypeError('Photo change monitoring requires the scoped file lookup.');
      const file = await fileSystemMetadata();
      if (!file?.exists || file.kind !== 'file') return false;
      const difference = dateTicks(item.DateModified) - dateTicks(file.modified);
      return (difference < 0n ? -difference : difference) > 10000000n;
    },
    async fetch(item, { images, imageAssets } = {}) {
      if (!Array.isArray(images) || !imageAssets?.read || !imageAssets?.stat) throw new TypeError('Photo metadata requires canonical images and scoped storage assets.');
      // Native FetchAsync ignores its request token. Its original-image
      // registration precedes tag parsing, including parsing failures.
      let modified = MIN_DATE;
      if (!/^http/iu.test(item.Path)) {
        try { modified = (await imageAssets.stat(item.Path)).modified ?? MIN_DATE; }
        catch (error) { if (error.code !== 'not-found') throw error; }
      }
      const primary = images.find(image => image.Type === 'Primary' || image.ImageType === 0);
      if (primary) {
        Object.assign(primary, { Path: item.Path, DateModified: modified, Width: 0, Height: 0 });
        if (/^http/iu.test(item.Path)) {
          primary.Blurhash = null;
          if (Object.hasOwn(primary, 'BlurHash')) primary.BlurHash = null;
        }
      }
      else images.push({ Type: 'Primary', Path: item.Path, DateModified: modified, Width: 0, Height: 0, Blurhash: null });
      const extension = imagePathApi(item.Path).extname(item.Path).toLowerCase();
      if (extensions.has(extension)) {
        try {
          const tags = readPhotoTags(await imageAssets.read(item.Path), extension);
          if (tags.Aperture != null) item.Aperture = tags.Aperture;
          if (tags.ShutterSpeed != null) item.ShutterSpeed = tags.ShutterSpeed;
          item.CameraMake = tags.Make; item.CameraModel = tags.Model;
          item.Width = tags.Width; item.Height = tags.Height;
          item.CommunityRating = tags.Rating == null ? null : Math.fround(tags.Rating);
          item.Overview = tags.Comment;
          if (tags.Title != null && clrTrim(tags.Title) !== '' && !item.LockedFields?.includes('Name')) item.Name = tags.Title;
          if (tags.DateTime) Object.assign(item, tags.DateTime);
          item.Genres = tags.Genres; item.Tags = tags.Keywords; item.Software = tags.Software;
          item.Orientation = orientations[tags.Orientation];
          for (const name of ['ExposureTime', 'FocalLength', 'Latitude', 'Longitude', 'Altitude']) item[name] = tags[name];
          if (tags.ISOSpeedRatings > 2147483647) throw Object.assign(new RangeError('Photo ISO exceeds Int32.'), { code: 'photo-iso-overflow' });
          item.IsoSpeedRating = tags.ISOSpeedRatings;
        } catch (error) { logger.error(error, `Image Provider - Error reading image tag for ${item.Path}`); }
      }
      if (item.Width <= 0 || item.Height <= 0) {
        try {
          const size = await imageProcessor.getImageSize(await imageAssets.read(item.Path), item.Path);
          if (size.Width > 0 && size.Height > 0) { item.Width = size.Width; item.Height = size.Height; }
        } catch (error) {
          if (error.code !== 'unsupported-image-format') throw error;
        }
      }
      return ItemUpdateType.MetadataImport | ItemUpdateType.ImageUpdate;
    } };
  return { id: 'builtin-photo-metadata', name: 'Photo Embedded Information', providers: [provider] };
}
