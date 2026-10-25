import path from 'node:path';
import { getNewItemId, md5Guid } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';
import { clrTrim, clrTrimEnd } from '../metadata/whitespace.js';

export function nativeItemByNameFolderName(name) {
  let folder = clrTrim(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')).replace(/\.+$/, '');
  if (Buffer.byteLength(folder, 'utf8') > 128) {
    const suffix = '-' + md5Guid(folder); const budget = 128 - suffix.length;
    let length = Math.min(folder.length, budget);
    while (length && Buffer.byteLength(folder.slice(0, length), 'utf8') > budget) length--;
    if (length && /[\uD800-\uDBFF]/.test(folder[length - 1])) length--;
    folder = clrTrimEnd(folder.slice(0, length)).replace(/\.+$/, '') + suffix;
  }
  return folder;
}

export function nativePersonIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Person metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const folder = nativeItemByNameFolderName(name);
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const prefix = folder.split('').find(character => /^[\p{L}\p{Nd}]$/u.test(character));
  const personPath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), 'People', ...(prefix ? [prefix] : []), folder);
  return { Id: nativeGuid(getNewItemId(personPath, 'MediaBrowser.Controller.Entities.Person', { programDataPath: root,
    enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds, forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true })), Path: personPath };
}

export function nativeStudioIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Studio metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('Studio', nativeItemByNameFolderName(name));
  const studioPath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative);
  return {
    Id: nativeGuid(getNewItemId(studioPath, 'MediaBrowser.Controller.Entities.Studio', {
      programDataPath: root,
      enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
      forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true,
    })),
    Path: studioPath,
    StoredPath: `%MetadataPath%${pathApi.sep}${relative}`,
  };
}

export function nativeArtistIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Artist metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('artists', nativeItemByNameFolderName(name));
  const artistPath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative);
  return {
    Id: nativeGuid(getNewItemId(artistPath, 'MediaBrowser.Controller.Entities.Audio.MusicArtist', {
      programDataPath: root,
      enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
      forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true,
    })),
    Path: artistPath,
    StoredPath: `%MetadataPath%${pathApi.sep}${relative}`,
  };
}

export function nativeGenreIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Genre metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('Genre', nativeItemByNameFolderName(name));
  const genrePath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative);
  return {
    Id: nativeGuid(getNewItemId(genrePath, 'MediaBrowser.Controller.Entities.Genre', {
      programDataPath: root,
      enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
      forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true,
    })),
    Path: genrePath,
    StoredPath: `%MetadataPath%${pathApi.sep}${relative}`,
  };
}

export function nativeMusicGenreIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Music genre metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('MusicGenre', nativeItemByNameFolderName(name));
  const genrePath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative);
  return {
    Id: nativeGuid(getNewItemId(genrePath, 'MediaBrowser.Controller.Entities.Audio.MusicGenre', {
      programDataPath: root,
      enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
      forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true,
    })),
    Path: genrePath,
    StoredPath: `%MetadataPath%${pathApi.sep}${relative}`,
  };
}

function userViewIdentity(key, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('UserView metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const id = nativeGuid(getNewItemId(key, 'MediaBrowser.Controller.Entities.UserView', {
    programDataPath: root,
    enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
  }));
  const relative = pathApi.join('views', id.replaceAll('-', '').toLowerCase());
  return {
    Id: id,
    Path: pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative),
    StoredPath: `%MetadataPath%${pathApi.sep}${relative}`,
  };
}

const viewParentKey = parentId => {
  const value = nativeGuid(parentId).replaceAll('-', '').toLowerCase();
  return value === '00000000000000000000000000000000' ? '' : value;
};

export function nativeUserViewIdentity(userId, parentId, viewType, options) {
  return userViewIdentity(`38_namedview_${nativeGuid(userId).replaceAll('-', '').toLowerCase()}${viewParentKey(parentId)}${viewType ?? ''}`, options);
}

export function nativeUserSubviewIdentity(parentId, viewType, options) {
  const uniqueId = nativeGuid(parentId).toLowerCase() + 'subview' + (viewType ?? '');
  return userViewIdentity(`37_namedview_${viewParentKey(parentId)}${viewType ?? ''}${uniqueId}`, options);
}

export function nativeShadowViewIdentity(parent, viewType, options) {
  const identity = userViewIdentity(`38_namedview_${parent.Name}${nativeGuid(parent.Id).toLowerCase()}${viewType ?? ''}`, options);
  return { ...identity, Path: parent.Path, StoredPath: parent.Path };
}

export function nativeRootUserViewIdentity(viewType, options) {
  const root = options.programDataPath;
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('views', nativeItemByNameFolderName(viewType));
  const viewPath = pathApi.join(options.metadataPath ?? pathApi.join(root, 'metadata'), relative);
  const identity = userViewIdentity(`${viewPath}_namedview_${viewType}`, options);
  return { ...identity, Path: viewPath, StoredPath: `%MetadataPath%${pathApi.sep}${relative}` };
}
