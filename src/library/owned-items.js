import { nonemptyId } from './records.js';
import { mediaSourceCount } from './media-versions.js';

export const isFileProtocol = item => item.IsFileProtocol ?? (Boolean(item.Path) && !/^(?:http|rtsp|rtmp|rtp|ftp|udp)/i.test(item.Path)
  && (!item.Path.includes('://') || /^file:\/\//i.test(item.Path)));

/** Native virtual SupportsOwnedItems, including Folder/Audio/Episode overrides. */
export function supportsOwnedItems(item, state) {
  if (['Audio', 'AudioBook'].includes(item.Type)) return false;
  if (item.Type === 'Episode') return Boolean(item.AdditionalParts?.length || item.LocalAlternateVersions?.length
    || (state ? mediaSourceCount(item, state) : item.MediaSourceCount ?? 1) > 1);
  if (item.Type === 'UserRootFolder') return true;
  return Boolean(nonemptyId(item.ParentId) && isFileProtocol(item));
}

export function searchesContainingFolderForExtras(item, state) {
  return isFileProtocol(item) && supportsOwnedItems(item, state) && !item.IsInMixedFolder
    && !['Folder', 'CollectionFolder', 'UserRootFolder', 'AggregateFolder'].includes(item.Type);
}
