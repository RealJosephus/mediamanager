import { getRatingScore } from '../core/localization-data.js';
import { idKey, nonemptyId } from './records.js';
import { collectionFoldersForItem, userRootFolders } from './collection-membership.js';

const nonempty = value => value !== null && value !== undefined && value !== '';

function displayParentId(item) {
  if (item.Type === 'Episode') return item.SeasonId;
  if (item.Type === 'Season') return item.SeriesId;
  return item.ParentId;
}

function comparisonRating(item, state, field) {
  const visited = new Set();
  let current = item;
  while (current) {
    const key = idKey(current.Id);
    if (visited.has(key)) return null;
    visited.add(key);
    if (nonempty(current[field])) return current[field];
    const parentId = displayParentId(current);
    current = nonemptyId(parentId) ? state.byId.get(idKey(parentId)) : null;
  }
  return null;
}

function* parentChain(item, state) {
  const visited = new Set([idKey(item.Id)]);
  let parentId = item.ParentId;
  while (nonemptyId(parentId) && !visited.has(idKey(parentId))) {
    visited.add(idKey(parentId));
    const parent = state.byId.get(idKey(parentId));
    if (!parent) break;
    yield parent;
    parentId = parent.ParentId;
  }
}

function libraryOption(libraryOptions, id) {
  return libraryOptions instanceof Map ? libraryOptions.get(idKey(id)) ?? libraryOptions.get(id)
    : libraryOptions?.[id] ?? libraryOptions?.[idKey(id)];
}

/**
 * Serialize the small, stable navigation plane needed to reproduce
 * preferredMetadataCountry inside a bounded PostgreSQL item query.
 */
export function postgresParentalRatingContext(state, options = {}) {
  const configured = options.configuration?.MetadataCountryCode;
  const collectionOptions = state.items
    .filter(item => item.Type === 'CollectionFolder')
    .map(item => Object.freeze({
      id: item.Id,
      country: libraryOption(options.libraryOptions, item.Id)?.MetadataCountryCode,
    }));
  return Object.freeze({
    // Passing undefined to getRatingScore selects its public US default; null
    // and empty are observable configuration values and must remain distinct.
    defaultCountry: configured === undefined ? 'US' : configured,
    collectionOptions: Object.freeze(collectionOptions),
    folders: Object.freeze(userRootFolders(state).map(folder => Object.freeze({
      id: folder.Id,
      type: folder.Type,
      path: folder.Path,
      preferredCountry: folder.PreferredMetadataCountryCode,
      tags: folder.Tags ?? [],
      physicalLocations: ['CollectionFolder', 'AggregateFolder'].includes(folder.Type)
        ? folder.PhysicalLocationsList === undefined ? [] : folder.PhysicalLocationsList
        : [],
      libraryCountry: libraryOption(options.libraryOptions, folder.Id)?.MetadataCountryCode,
    }))),
  });
}

export function preferredMetadataCountry(item, state, options = {}) {
  if (nonempty(item.PreferredMetadataCountryCode)) return item.PreferredMetadataCountryCode;
  for (const parent of parentChain(item, state)) {
    if (nonempty(parent.PreferredMetadataCountryCode)) return parent.PreferredMetadataCountryCode;
  }
  const folders = collectionFoldersForItem(item, state);
  for (const folder of folders) {
    if (nonempty(folder.PreferredMetadataCountryCode)) return folder.PreferredMetadataCountryCode;
  }
  // LibraryManager.GetLibraryOptions handles a CollectionFolder itself first;
  // otherwise only the first actual matching CollectionFolder supplies options.
  const collection = item.Type === 'CollectionFolder' ? item : folders.find(folder => folder.Type === 'CollectionFolder');
  const country = collection && libraryOption(options.libraryOptions, collection.Id)?.MetadataCountryCode;
  if (nonempty(country)) return country;
  // The global configuration is the final assignment, even when explicitly
  // null or empty. Its default belongs to the application configuration.
  return options.configuration?.MetadataCountryCode;
}

export function itemParentalRating(item, state, options = {}) {
  const rating = comparisonRating(item, state, 'CustomRating') ?? comparisonRating(item, state, 'OfficialRating');
  if (!nonempty(rating)) return null;
  return getRatingScore(rating, preferredMetadataCountry(item, state, options), options.configuration?.MetadataCountryCode);
}

export function ratingWithinLimit(rating, maximum, maximumSubScore) {
  if (rating == null || maximum == null) return true;
  return rating.score < maximum || rating.score === maximum
    && (maximumSubScore == null || (rating.subScore ?? 0) <= maximumSubScore);
}
