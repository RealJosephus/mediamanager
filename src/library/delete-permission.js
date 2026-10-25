import { VIDEO_TYPES, nonemptyId, sameId, libraryError } from './records.js';

const nondeletableTypes = new Set(['AggregateFolder', 'CollectionFolder', 'UserView', 'Channel', 'PlaylistsFolder',
  'Person', 'Genre', 'MusicGenre', 'Studio', 'Year']);

// BaseItem.PathProtocol uses MediaSourceManager.GetPathProtocol, not LocationType.
// Its protocol prefixes deliberately do not require a colon or a URL delimiter.
export function hasFileProtocol(item) {
  const value = item.Path;
  return typeof value === 'string' && value.length > 0 && !/^(?:rtsp|rtmp|http|rtp|ftp|udp)/i.test(value)
    && (!value.includes('://') || /^file:\/\//i.test(value));
}

export async function canDeleteItem(item, user, { collectionFolders = () => [], isActiveRecording = () => false, precomputedFolders = false,
  channelCanDelete = async () => false } = {}) {
  // Playlist overrides the complete CanDelete(User), including the file gate.
  if (item.Type === 'Playlist' && user && !precomputedFolders) return user.Policy.IsAdministrator === true || sameId(user.Id, item.OwnerUserId);
  if (nondeletableTypes.has(item.Type)) return false;
  if (item.Type === 'MusicArtist') {
    if (!nonemptyId(item.ParentId)) return false;
  } else {
    if (item.IsFolder && item.IsRoot) return false;
    if (VIDEO_TYPES.has(item.Type) && isActiveRecording(item)) return false;
    if (item.SourceType === 'Channel') {
      if (!nonemptyId(item.ChannelId)) throw libraryError(400, "Guid can't be empty (Parameter 'id')");
      if (!await channelCanDelete(item)) return false;
    } else if (!hasFileProtocol(item)) return false;
  }
  // DtoService's list consumer calls CanDelete(User,List<Folder>).
  // Playlist.IsAuthorizedToDelete in that branch is always true, while the
  // action's virtual CanDelete(User) above requires owner/admin. Never use
  // the DTO result to authorize a DELETE request.
  if (!user || item.Type === 'Playlist') return true;
  const policy = user.Policy;
  if (item.Type === 'BoxSet') return policy.IsAdministrator === true || policy.EnableCollectionManagement === true;
  if (policy.EnableContentDeletion === true) return true;
  const allowed = policy.EnableContentDeletionFromFolders ?? [];
  if (item.SourceType === 'Channel') return allowed.some(id => sameId(id, item.ChannelId));
  return (await collectionFolders()).some(folder => allowed.some(id => sameId(id, folder.Id)));
}
