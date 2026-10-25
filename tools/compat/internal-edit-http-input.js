import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const editHttpInputBytes = await readFile(new URL('../../tests/metadata/fixtures/internal-edit/input.json', import.meta.url));
const original = JSON.parse(editHttpInputBytes);
export const editHttpTypes = ['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'UserView', 'PlaylistsFolder', 'Playlist'];
export const editHttpNativeTypes = Object.freeze(Object.fromEntries([...editHttpTypes, 'Folder', 'Movie'].map(type => [type,
  type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist'
    : type === 'PlaylistsFolder' ? 'Emby.Server.Implementations.Playlists.PlaylistsFolder'
      : 'MediaBrowser.Controller.Entities.' + (type === 'Movie' ? 'Movies.Movie' : type)])));
const fixedId = number => `88000000-0000-0000-0000-${String(number).padStart(12, '0')}`;

/** Controlled inputs only. Root IDs are supplied by the actual native instance. */
export function internalEditHttpInput(referenceRoot, observed) {
  const programDataPath = path.join(referenceRoot, 'data'), mediaPath = path.join(path.dirname(referenceRoot), 'media');
  const collectionPath = path.join(programDataPath, 'root/default/Integration Library');
  const playlistRoot = path.join(programDataPath, 'data/playlists');
  const ids = { ...observed, CollectionFolder: fixedId(1), UserView: fixedId(2), Playlist: fixedId(3),
    nestedPlaylist: fixedId(4), viewChild: fixedId(5), folder: '11111111-1111-1111-1111-111111111111',
    movie: '22222222-2222-2222-2222-222222222222' };
  const items = [
    { key: 'UserRootFolder', type: 'UserRootFolder', name: observed.userRootName,
      path: path.join(programDataPath, 'root/default'), parent: null, data: { IsRoot: true } },
    { key: 'folder', type: 'Folder', name: 'Synthetic Media', path: mediaPath, parent: ids.AggregateFolder },
    { key: 'movie', type: 'Movie', name: 'Synthetic Movie', path: path.join(mediaPath, 'feature.mkv'), parent: ids.folder },
    { key: 'CollectionFolder', type: 'CollectionFolder', name: 'Integration Library', path: collectionPath, parent: ids.UserRootFolder,
      data: { PhysicalFolderIds: [ids.folder], PhysicalLocationsList: [mediaPath], CollectionType: 'movies' } },
    { key: 'UserView', type: 'UserView', name: 'Integration View', path: path.join(programDataPath, 'root/default/views/integration'),
      parent: ids.UserRootFolder, data: { ViewType: 'movies', DisplayParentId: ids.CollectionFolder } },
    { key: 'Playlist', type: 'Playlist', name: 'Integration Playlist', path: path.join(playlistRoot, 'integration'), parent: ids.PlaylistsFolder,
      data: { OwnerUserId: observed.userId, OpenAccess: true, PlaylistMediaType: 'Video' } },
    { key: 'nestedPlaylist', type: 'Playlist', name: 'Nested Playlist', path: path.join(playlistRoot, 'nested'), parent: ids.folder,
      data: { OwnerUserId: observed.userId, OpenAccess: true, PlaylistMediaType: 'Video' } },
    { key: 'viewChild', type: 'Movie', name: 'View Child', path: path.join(mediaPath, 'view-child.mkv'), parent: ids.UserView }
  ].map(item => ({ ...item, id: ids[item.key], topParent: item.type === 'Movie' || item.key === 'nestedPlaylist' ? ids.folder : item.parent }));
  return { ids, items, mediaPath, programDataPath, collectionPath,
    filesystemRoots: { media: mediaPath, playlists: playlistRoot, roots: path.join(programDataPath, 'root'), metadata: path.join(programDataPath, 'metadata') },
    cases: editHttpTypes.flatMap(type => original.requests.map((body, index) => ({ name: `${type}-${index + 1}`, type, itemId: ids[type], body }))) };
}
