import path from 'node:path';
import { nativeFileName } from '../library/native-path.js';
import { nonemptyId } from '../library/records.js';

const folders = Object.freeze({ Person: 'People', Genre: 'Genre', MusicGenre: 'MusicGenre', Studio: 'Studio', Year: 'Year', MusicArtist: 'artists' });

export function rebasedMetadataPath(item, { metadataPath } = {}) {
  const folder = folders[item.Type];
  if (!folder || item.Type === 'MusicArtist' && !(item.IsAccessedByName ?? !nonemptyId(item.ParentId))) return null;
  if (!metadataPath) throw Object.assign(new Error('By-name refresh requires the instance metadata path.'), { code: 'metadata-context-required' });
  if (item.Path == null) throw Object.assign(new TypeError('The by-name directory name cannot be null.'),
    { nativeException: item.Type === 'Person' ? 'NullReferenceException' : 'ArgumentNullException' });
  // Rebase the stored basename without applying creation-time name cleanup.
  const name = nativeFileName(item.Path);
  const prefix = item.Type === 'Person' ? name.split('').find(character => /^[\p{L}\p{Nd}]$/u.test(character)) : null;
  const api = /^[A-Za-z]:[\\/]|^\\\\/.test(metadataPath) ? path.win32 : path.posix;
  return api.join(metadataPath, folder, ...(prefix ? [prefix] : []), name);
}
