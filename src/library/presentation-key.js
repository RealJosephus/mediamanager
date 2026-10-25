import { guidN, itemType, isVideo, removeDiacritics } from '../sessions/user-data.js';
import { lowerInvariant } from '../core/identity.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const namedTypes = new Set(['Person', 'Genre', 'MusicGenre', 'Studio']);
const providerValue = (item, name) => {
  const entries = item.ProviderIds instanceof Map ? [...item.ProviderIds] : Object.entries(item.ProviderIds ?? {});
  return entries.find(([key]) => ordinalIgnoreCaseKey(key) === ordinalIgnoreCaseKey(name))?.[1];
};

export function createPresentationUniqueKey(item, { libraryOptions = {}, metadataLanguage = item.MetadataLanguage, collectionFolders = [], series } = {}) {
  const type = itemType(item);
  if (namedTypes.has(type)) return `${type}-${removeDiacritics(item.Name)}`;
  if (type === 'MusicArtist') return `Artist-${removeDiacritics(item.Name)}`;
  if (isVideo(item) && item.PrimaryVersionId != null) return guidN(item.PrimaryVersionId);
  if (type === 'Season' && item.IndexNumber != null && series) {
    const index = item.IndexNumber < 0 ? '-' + String(-item.IndexNumber).padStart(3, '0') : String(item.IndexNumber).padStart(3, '0');
    return `${series.PresentationUniqueKey ?? ''}-${index}`;
  }
  if (type === 'Series' && libraryOptions.EnableAutomaticSeriesGrouping) {
    let key;
    for (const name of ['Custom', 'Tvdb', 'Imdb']) {
      const value = providerValue(item, name);
      if (value != null && value !== '') { key = value; break; }
    }
    if (!key && (item.SourceType === 'Channel' || item.SourceType === 1) && item.ExternalId) key = item.ExternalId;
    if (!key && item.Name) key = 'series-' + lowerInvariant(item.Name);
    if (key) {
      if (metadataLanguage) key += '-' + metadataLanguage;
      const folders = collectionFolders.map(folder => guidN(folder.Id)).sort();
      return folders.length ? key + '-' + folders.join('-') : key;
    }
  }
  return guidN(item.Id);
}
