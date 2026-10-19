import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';

// UserViewBuilder materializes a deliberately smaller filter surface than an
// InternalItemsQuery.  Keep that boundary explicit: repository-only switches
// (including SearchTerm) are ignored by the native in-memory menu builder.
const FILTER_KEYS = Object.freeze([
  'ids', 'excludeitemids', 'includeitemtypes', 'excludeitemtypes', 'mediatypes',
  'years', 'parentindexnumber', 'islocked', 'isfolder', 'mincommunityrating',
  'mincriticrating', 'minpremieredate', 'maxpremieredate', 'hasoverview',
  'hasimdbid', 'hastmdbid', 'hastvdbid', 'genres', 'tags', 'isfavorite',
  'likes', 'favoriteorlikes', 'isresumable', 'namestartswith',
  'namestartswithorgreater', 'namelessthan', 'ismissing', 'hasparentalrating',
  'officialratings', 'imagetypes', 'genreids', 'studioids', 'minindexnumber',
  'isplayed', 'sortby', 'sortorder', 'adjacentto', 'startindex', 'limit',
]);

function menuQuery(query, hasUser) {
  const result = {};
  for (const key of FILTER_KEYS) {
    if (Object.hasOwn(query, key) && query[key] !== undefined) result[key] = query[key];
  }
  // Folder.GetItems does not evaluate IsPlayed without a user context.
  if (!hasUser) delete result.isplayed;
  return result;
}

/**
 * Filter, order, apply adjacency, count, and page a persisted movie/TV menu
 * without returning the rest of the library to Node.js.
 */
export function queryPostgresUserViewMenuPage(database, query, itemIds, {
  userId,
  memorySortConfiguration = {},
  memoryRatingContext = null,
  signal,
  childScope,
  visibility, onPlan,
} = {}) {
  const filtered = menuQuery(query, userId != null);
  const options = {
    scope: childScope ?? { ids: itemIds },
    userId,
    includeOwnedItems: childScope == null,
    includeAlternateVersions: childScope == null,
    visibility,
    resumableMode: 'memory',
    memorySortConfiguration,
    memoryRatingContext,
    memorySourceOrder: 'stored-sort-name',
    memoryFolderPlayback: true,
    memoryUserViewFilter: true,
    signal,
  };
  return onPlan ? onPlan(buildPostgresItemPageQuery(database, filtered, { ...options, includeOrdinal: true }))
    : queryPostgresItemPage(database, filtered, options);
}
