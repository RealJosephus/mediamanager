import { getRatingScore } from '../core/localization-data.js';
import { idKey, nonemptyId } from './records.js';
import { collectionFoldersForItem } from './collection-membership.js';

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
 * Bind the admitted root catalogue and explicit configuration needed to
 * reproduce preferredMetadataCountry inside a PostgreSQL item query.
 */
export function postgresParentalRatingContext(options = {}, foldersPlan) {
  if (typeof foldersPlan?.text !== 'string' || !foldersPlan.text.trim() || !Array.isArray(foldersPlan.values)) {
    throw new TypeError('Parental-rating context requires an admitted root-folder query plan.');
  }
  const configured = options.configuration?.MetadataCountryCode;
  const configuredIds = new Map();
  const keys = options.libraryOptions instanceof Map ? options.libraryOptions.keys() : Object.keys(options.libraryOptions ?? {});
  for (const id of keys) if (!configuredIds.has(idKey(id))) configuredIds.set(idKey(id), id);
  const collectionOptions = Array.from(configuredIds.values(), id => Object.freeze({
    id,
    country: libraryOption(options.libraryOptions, id)?.MetadataCountryCode,
  }));
  return Object.freeze({
    // Passing undefined to getRatingScore selects its public US default; null
    // and empty are observable configuration values and must remain distinct.
    defaultCountry: configured === undefined ? 'US' : configured,
    collectionOptions: Object.freeze(collectionOptions),
    foldersPlan,
  });
}

export function comparisonItemRating(item, state) {
  return comparisonRating(item, state, 'CustomRating') ?? comparisonRating(item, state, 'OfficialRating');
}

export function preferredMetadataCountryBeforeFolders(item, state) {
  if (nonempty(item.PreferredMetadataCountryCode)) return { found: true, country: item.PreferredMetadataCountryCode };
  for (const parent of parentChain(item, state)) {
    if (nonempty(parent.PreferredMetadataCountryCode)) return { found: true, country: parent.PreferredMetadataCountryCode };
  }
  return { found: false, country: null };
}

export function preferredMetadataCountry(item, state, options = {}, matchedFolders) {
  const earlier = preferredMetadataCountryBeforeFolders(item, state);
  if (earlier.found) return earlier.country;
  const folders = matchedFolders === undefined ? collectionFoldersForItem(item, state) : matchedFolders;
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

export function itemParentalRating(item, state, options = {}, matchedFolders) {
  const rating = comparisonItemRating(item, state);
  if (!nonempty(rating)) return null;
  return getRatingScore(rating, preferredMetadataCountry(item, state, options, matchedFolders), options.configuration?.MetadataCountryCode);
}

export function ratingWithinLimit(rating, maximum, maximumSubScore) {
  if (rating == null || maximum == null) return true;
  return rating.score < maximum || rating.score === maximum
    && (maximumSubScore == null || (rating.subScore ?? 0) <= maximumSubScore);
}
