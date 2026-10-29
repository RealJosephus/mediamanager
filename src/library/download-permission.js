import { VIDEO_TYPES } from './records.js';
import { hasFileProtocol } from './delete-permission.js';

export function canDownloadItem(item, user = null) {
  const supported = item.Type === 'Photo' || hasFileProtocol(item) && (
    ['Audio', 'AudioBook', 'Book'].includes(item.Type)
    || VIDEO_TYPES.has(item.Type) && !['Dvd', 'BluRay'].includes(item.VideoType));
  return supported && (!user || user.Policy.EnableContentDownloading === true);
}
