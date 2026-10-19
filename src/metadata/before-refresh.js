import { nativeContainingFolderPath, nativeFileName, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { parseMetadataName } from './naming.js';
import { parseSeasonPath } from './season-path.js';
import { clearMetadataSortCache } from './sort-cache.js';
import { rebasedMetadataPath } from './by-name-path.js';
import { beforeInternalFolderMetadataRefresh } from './internal-folder-refresh.js';
import { clearFolderChildIds } from '../library/folder-cache.js';

export function beforeMetadataRefresh(item, loaded = {}) {
  if (['AggregateFolder', 'UserRootFolder'].includes(item.Type)) clearFolderChildIds(item);
  clearMetadataSortCache(item);
  let changed = false;
  if ((item.Name == null || item.Name === '') && item.Path != null && item.Path !== '') {
    item.Name = nativeFileNameWithoutExtension(item.Path);
    changed = true;
  }
  if (['Movie', 'MusicVideo', 'Trailer', 'Series'].includes(item.Type) && item.ProductionYear == null) {
    let year = parseMetadataName(item.Name).Year;
    if (year == null && item.Type !== 'Series' && !item.IsInMixedFolder) {
      year = parseMetadataName(nativeFileName(nativeContainingFolderPath(item))).Year;
    }
    if (year != null) { item.ProductionYear = year; changed = true; }
  }
  if (item.Type === 'Season' && item.IndexNumber == null && item.Path != null && item.Path !== '') {
    item.IndexNumber = parseSeasonPath(item.Path, loaded.parent ? nativeContainingFolderPath(loaded.parent) : null).SeasonNumber;
    if (item.IndexNumber != null) changed = true;
  }
  const rebased = rebasedMetadataPath(item, loaded);
  if (rebased != null && item.Path !== rebased) { item.Path = rebased; changed = true; }
  return beforeInternalFolderMetadataRefresh(item, changed);
}

export function afterMetadataRefresh(item) {
  clearMetadataSortCache(item);
}
