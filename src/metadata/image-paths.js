import { imagePathApi } from './image-assets.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeContainingFolderPath } from '../library/native-path.js';
import { mimeToExtension } from '../http/mime-types.js';

export const imageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
export const multipleImages = type => ['Backdrop', 'Screenshot'].includes(type);
export function internalImagePath(item, metadataPath) {
  if (!metadataPath) throw Object.assign(new Error('Image storage requires the instance metadata path.'), { code: 'metadata-context-required' });
  const api = imagePathApi(metadataPath), id = item.Id.replaceAll('-', '').toLowerCase();
  return item.SourceType === 'Channel' ? api.join(metadataPath, 'channels', item.ChannelId.replaceAll('-', '').toLowerCase(), id) : api.join(metadataPath, 'library', id.slice(0, 2), id);
}
export const containingImageFolder = item => item.Type === 'Playlist' ? nativeContainingFolderPath(item)
  : item.IsFolder || ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'MusicArtist'].includes(item.Type)
    || ['Dvd', 'BluRay'].includes(item.VideoType) && !item.IsPlaceHolder ? item.Path : imagePathApi(item.Path).dirname(item.Path);
export function imageSavePaths(item, type, index, mimeType, { saveLocally, metadataPath, series, images = [], configuration = {}, extraImagePaths }) {
  const api = imagePathApi(item.Path || metadataPath), extension = mimeToExtension(mimeType);
  if (!extension) throw new TypeError(`Unable to determine image file extension from mime type ${mimeType}`);
  const folder = item.Path && containingImageFolder(item), legacy = configuration.ImageSavingConvention === 'Legacy' || (configuration.ImageSavingConvention ?? 0) === 0;
  const mixed = name => api.join(api.dirname(item.Path), api.basename(item.Path, api.extname(item.Path)) + '-' + (type === 'Primary' ? 'poster' : name) + extension);
  const season = name => api.join(series?.Path ?? api.dirname(item.Path), `season${item.IndexNumber === 0 ? '-specials' : item.IndexNumber < 0 ? '-' + String(-item.IndexNumber).padStart(2, '0') : String(item.IndexNumber).padStart(2, '0')}-${name}${extension}`);
  const episode = () => api.join(api.dirname(item.Path), api.basename(item.Path, api.extname(item.Path)) + '-thumb' + extension);
  const backdrop = (zero, prefix) => {
    if (index === 0) return zero;
    const filenames = images.filter(image => image.Type === 'Backdrop').map(image => {
      const imageApi = imagePathApi(image.Path);
      return ordinalIgnoreCaseKey(imageApi.basename(image.Path, imageApi.extname(image.Path)));
    });
    let value = 1; while (filenames.includes(ordinalIgnoreCaseKey(prefix + value))) value++; return prefix + value;
  };
  if (saveLocally && !legacy) {
    if (type === 'Backdrop') {
      if (index == null) throw new TypeError('Backdrop save requires an image index.');
      if (item.IsInMixedFolder) return [mixed('fanart' + (index === 0 ? '' : index))];
      if (index === 0) return [item.Type === 'Season' && item.IndexNumber != null ? season('fanart') : api.join(folder, 'fanart' + extension)];
      return [api.join(folder, 'extrafanart', backdrop('fanart', 'fanart') + extension), ...(extraImagePaths?.({item,type,index,extension,folder}) ?? [])];
    }
    if (type === 'Primary') {
      if (item.Type === 'Season' && item.IndexNumber != null) return [season('poster')];
      if (item.Type === 'Episode') return [episode()];
      if (item.IsInMixedFolder || item.Type === 'MusicVideo') return [mixed('')];
      return [api.join(folder, (['MusicAlbum', 'MusicArtist'].includes(item.Type) ? 'folder' : 'poster') + extension)];
    }
  }
  if (saveLocally && item.Type === 'Season' && item.IndexNumber != null && ['Primary', 'Backdrop', 'Thumb', 'Banner', 'Logo'].includes(type) && (type !== 'Backdrop' || index == null || index === 0)) {
    return [season({ Primary: 'poster', Backdrop: 'fanart', Thumb: 'landscape', Banner: 'banner', Logo: 'logo' }[type])];
  }
  const folderName = ['MusicAlbum', 'MusicArtist', 'PhotoAlbum', 'Person'].includes(item.Type) || saveLocally && legacy ? 'folder' : 'poster';
  const name = { Art: 'clearart', BoxRear: 'back', Thumb: 'landscape', Disc: item.Type === 'MusicAlbum' ? 'cdart' : 'disc', Primary: folderName, Backdrop: backdrop('backdrop', 'backdrop') }[type] ?? type.toLowerCase();
  if (saveLocally && type === 'Primary' && item.Type === 'Episode') return [episode()];
  if (saveLocally && item.IsInMixedFolder) return [mixed(name)];
  const directory = saveLocally ? folder : internalImagePath(item, metadataPath);
  // The instance metadata directory can use a different path style from the media identity.
  return [imagePathApi(directory).join(directory, name + extension)];
}
