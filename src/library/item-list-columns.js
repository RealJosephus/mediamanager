import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { itemHasArtist, itemHasAlbumArtist, requireNativeList } from './item-relations.js';

export const itemListFields = Object.freeze(['Genres', 'Studios', 'Tags', 'ProductionLocations', 'Artists', 'AlbumArtists']);

export function itemListColumn(item, field) {
  if (field === 'Artists' && !itemHasArtist(item) || field === 'AlbumArtists' && !itemHasAlbumArtist(item)) return null;
  const values = field === 'Genres' ? requireNativeList(item[field]) : item[field];
  if (values == null) return null;
  if (!Array.isArray(values)) throw new TypeError(`Native ${field} must be an array.`);
  const seen = new Set(), result = [];
  for (const value of values) {
    if (field === 'ProductionLocations' && (value == null || clrTrim(value) === '')) continue;
    const key = value == null ? null : ordinalIgnoreCaseKey(value);
    if (seen.has(key)) continue;
    seen.add(key); result.push(value);
  }
  return result.join('|');
}
