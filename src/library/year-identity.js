import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';

export function nativeYearIdentity(name, { programDataPath: root, metadataPath, configuration = {} }) {
  if (!root) throw Object.assign(new Error('Year metadata requires the native program data path.'), { code: 'metadata-context-required' });
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  const relative = pathApi.join('Year', name);
  const yearPath = pathApi.join(metadataPath ?? pathApi.join(root, 'metadata'), relative);
  return { Id: nativeGuid(getNewItemId(yearPath, 'MediaBrowser.Controller.Entities.Year', {
    programDataPath: root, enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
    forceCaseInsensitive: configuration.EnableNormalizedItemByNameIds ?? true,
  })), Path: yearPath, StoredPath: `%MetadataPath%${pathApi.sep}${relative}` };
}
