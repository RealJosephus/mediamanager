import { queryPostgresItemPage } from '../database/postgres-item-query.js';
import { idKey, nonemptyId, repositoryTopParentId } from './records.js';
import { collectionType, groupedMediaFolders } from './user-view-query.js';

/**
 * Translate TvShowsController's recursive ParentId into a repository scope
 * without materialising the media catalogue.
 */
export function postgresUpcomingScope({ parentId, parent, state, user, rootFolders = [], physicalIdsFor }) {
  if (!nonemptyId(parentId)) return {};
  if (!parent) return { parentId };
  if (!['CollectionFolder', 'UserView'].includes(parent.Type)) return { ancestorId: parent.Id };
  if (typeof physicalIdsFor !== 'function') throw new TypeError('A physical folder resolver is required.');

  const seen = new Set();
  const topParents = item => {
    if (!item || seen.has(idKey(item.Id))) return [];
    seen.add(idKey(item.Id));
    if (item.Type === 'UserView') {
      if (collectionType(item) === 'livetv') return [item.Id];
      if (nonemptyId(item.DisplayParentId)) return topParents(state.byId.get(idKey(item.DisplayParentId)));
      if (nonemptyId(item.ParentId)) return topParents(state.byId.get(idKey(item.ParentId)));
      const type = collectionType(item);
      if (user && ['', 'movies', 'tvshows'].includes(type)) {
        return groupedMediaFolders(rootFolders, user)
          .filter(folder => collectionType(folder) === '' || collectionType(folder) === type)
          .flatMap(physicalIdsFor);
      }
      return [];
    }
    if (item.Type === 'CollectionFolder') return physicalIdsFor(item);
    if (nonemptyId(repositoryTopParentId(item))) return [repositoryTopParentId(item)];
    let current = item;
    const visited = new Set();
    while (current && !visited.has(idKey(current.Id))) {
      visited.add(idKey(current.Id));
      const storedParent = state.byId.get(idKey(current.ParentId));
      if (!storedParent || ['AggregateFolder', 'UserRootFolder'].includes(storedParent.Type)) {
        return nonemptyId(current.ParentId) ? [current.Id] : [];
      }
      current = storedParent;
    }
    return [];
  };

  const ids = [...new Map(topParents(parent).filter(nonemptyId).map(id => [idKey(id), id])).values()];
  if (ids.length) return { topParentIds: ids };
  const ancestorId = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId
    : nonemptyId(parent.ParentId) ? parent.ParentId : parent.Id;
  return { ancestorId };
}

export function queryPostgresUpcomingEpisodePage(database, {
  scope = {}, userId, visibility, minimumPremiereDate, startIndex = 0, limit,
  groupByPresentationKey = false,
} = {}) {
  const query = {
    includeitemtypes: ['Episode'],
    minpremieredate: minimumPremiereDate,
    sortby: ['PremiereDate', 'SortName'],
    sortorder: ['Ascending', 'Ascending'],
    startindex: Math.max(startIndex, 0),
    ...(limit === undefined || limit < 0 ? {} : { limit }),
  };
  return queryPostgresItemPage(database, query, {
    scope,
    userId,
    visibility,
    groupByPresentationKey,
  });
}

/** Select and page the seasons for one series entirely in PostgreSQL. */
export async function queryPostgresSeriesSeasonPage(database, {
  seriesKey, isSpecialSeason, isMissing, adjacentTo, userId, visibility,
  groupByPresentationKey = false,
} = {}) {
  return queryPostgresItemPage(database, {
    includeitemtypes: ['Season'],
    ...(isMissing === undefined ? {} : { ismissing: isMissing }),
    ...(nonemptyId(adjacentTo) ? { adjacentto: adjacentTo } : {}),
    sortby: ['SortName'],
    sortorder: ['Ascending'],
  }, {
    scope: {
      seriesPresentationKey: seriesKey ?? null,
      ...(isSpecialSeason === undefined ? {} : { specialSeason: isSpecialSeason }),
    },
    userId,
    visibility,
    groupByPresentationKey,
  });
}
