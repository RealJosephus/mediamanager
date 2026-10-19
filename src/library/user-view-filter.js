import { idKey, sameId, dateText, nonemptyId, libraryError } from './records.js';
import { lowerInvariant } from '../core/identity.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { visibleItem } from './permissions.js';
import { imageTypes } from '../metadata/image-paths.js';

export function userViewPlayedCounts(items, state, user, options) {
  const result = new Map();
  const leaves = state.items.filter(item => !item.IsFolder && !item.IsVirtualItem
    && visibleItem(item, user, state, { ...options, query: true, scopeLibraryFolders: false }));
  const leavesById = new Map(leaves.map(item => [idKey(item.Id), item]));
  const played = item => state.rowsFor(item).some(row => row.Played)
    || state.links.some(link => sameId(link.ParentId, item.Id) && [2, 3].includes(Number(link.ChildType))
      && state.rowsFor(state.byId.get(idKey(link.ChildId)) ?? { Id: link.ChildId }).some(row => row.Played));
  for (const folder of items.filter(item => item.IsFolder)) {
    const members = folder.PresentationUniqueKey ? state.items.filter(item => item.IsFolder
      && item.PresentationUniqueKey === folder.PresentationUniqueKey) : [folder];
    let total = 0; let playedCount = 0;
    for (const member of members) {
      const ids = new Set(state.parents.filter(row => sameId(row.ParentItemId, member.Id)).map(row => idKey(row.ItemId)));
      for (const link of state.links.filter(row => sameId(row.ParentId, member.Id))) {
        ids.add(idKey(link.ChildId));
        if (state.byId.get(idKey(link.ChildId))?.IsFolder) for (const row of state.parents
          .filter(row => sameId(row.ParentItemId, link.ChildId))) ids.add(idKey(row.ItemId));
      }
      const matching = [...ids].map(id => leavesById.get(id)).filter(Boolean);
      total += matching.length; playedCount += matching.filter(played).length;
    }
    result.set(idKey(folder.Id), { Played: playedCount, Total: total });
  }
  return result;
}

export function filterUserViewItems(items, query, state, user, { sortNameFor, ...options }) {
  const requestedImageTypes = query.imagetypes?.length
    ? new Set(query.imagetypes.map(value => imageTypes.indexOf(value) >= 0 ? imageTypes.indexOf(value) : Number(value))) : null;
  const contains = (values, value) => values.some(entry => entry.toLowerCase() === value.toLowerCase());
  const namedContains = (values, value) => values.some(entry => ordinalIgnoreCaseKey(entry) === ordinalIgnoreCaseKey(value));
  const selectorMatches = (ids, values) => ids.some(id => {
    if (!nonemptyId(id)) throw libraryError(400, 'Error processing request.');
    const selector = state.byId.get(idKey(id));
    return selector?.Name != null && namedContains(values, selector.Name);
  });
  const filtered = items.filter(item => {
    const name = lowerInvariant(sortNameFor(item) ?? '');
    if (query.namestartswith && !name.startsWith(lowerInvariant(query.namestartswith))) return false;
    if (query.namestartswithorgreater && name < lowerInvariant(query.namestartswithorgreater)) return false;
    if (query.namelessthan && name >= lowerInvariant(query.namelessthan)) return false;
    if (query.mediatypes?.length && !query.mediatypes.includes(item.MediaType)) return false;
    if (query.includeitemtypes?.length && !contains(query.includeitemtypes, item.Type)) return false;
    if (query.excludeitemtypes?.length && contains(query.excludeitemtypes, item.Type)) return false;
    if (query.ismissing !== undefined && Boolean(item.IsVirtualItem) !== query.ismissing) return false;
    if (query.isfolder !== undefined && Boolean(item.IsFolder) !== query.isfolder) return false;
    if ([query.likes, query.favoriteorlikes, query.isfavorite, query.isresumable].some(value => value !== undefined)) {
      if (!user) throw libraryError(500, 'Error processing request.');
      const data = state.userData.get(idKey(item.Id)) ?? { IsFavorite: false, Likes: null, PlaybackPositionTicks: 0n };
      if (query.likes !== undefined && (data.Likes == null || data.Likes !== query.likes)) return false;
      if (query.favoriteorlikes !== undefined && (data.IsFavorite || (data.Likes ?? false)) !== query.favoriteorlikes) return false;
      if (query.isfavorite !== undefined && data.IsFavorite !== query.isfavorite) return false;
      if (query.isresumable !== undefined && (data.PlaybackPositionTicks > 0n) !== query.isresumable) return false;
    }
    if (query.islocked !== undefined && Boolean(item.IsLocked) !== query.islocked) return false;
    if (query.hasoverview !== undefined && Boolean(item.Overview) !== query.hasoverview) return false;
    for (const [parameter, provider] of [['hasimdbid', 'imdb'], ['hastmdbid', 'tmdb'], ['hastvdbid', 'tvdb']]) {
      if (query[parameter] !== undefined && Object.entries(item.ProviderIds).some(([key, value]) => key.toLowerCase() === provider && value !== '') !== query[parameter]) return false;
    }
    if (query.hasparentalrating !== undefined && Boolean(item.CustomRating || item.OfficialRating) !== query.hasparentalrating) return false;
    if (query.genres?.length && !query.genres.some(value => namedContains(item.Genres, value))) return false;
    if (requestedImageTypes && !(state.imageInfos ?? []).some(row => sameId(row.ItemId, item.Id)
      && requestedImageTypes.has(Number(row.ImageType)))) return false;
    if (query.studioids?.length && !selectorMatches(query.studioids, item.Studios)) return false;
    if (query.genreids?.length && !selectorMatches(query.genreids, item.Genres)) return false;
    if (query.years?.length && !query.years.some(year => Number(year) === item.ProductionYear)) return false;
    if (query.officialratings?.length && !query.officialratings.includes(item.OfficialRating ?? '')) return false;
    if (query.ids?.length && !query.ids.some(id => sameId(id, item.Id))) return false;
    if (query.tags?.length && !query.tags.some(value => namedContains(item.Tags, value))) return false;
    for (const [parameter, field] of [['mincommunityrating', 'CommunityRating'], ['mincriticrating', 'CriticRating'], ['minindexnumber', 'IndexNumber']]) {
      if (query[parameter] !== undefined && (item[field] == null || item[field] < query[parameter])) return false;
    }
    if (query.minpremieredate && (item.PremiereDate == null || dateText(item.PremiereDate) < query.minpremieredate)) return false;
    if (query.maxpremieredate && (item.PremiereDate == null || dateText(item.PremiereDate) > query.maxpremieredate)) return false;
    if (query.parentindexnumber !== undefined && item.ParentIndexNumber != null && item.ParentIndexNumber !== query.parentindexnumber) return false;
    if (query.excludeitemids?.some(id => sameId(id, item.Id))) return false;
    // SearchTerm and repository-only predicates are absent from this builder.
    return true;
  });
  if (query.isplayed === undefined || !user) return filtered;
  const counts = userViewPlayedCounts(filtered, state, user, options);
  return filtered.filter(item => item.IsFolder ? ((counts.get(idKey(item.Id))?.Played ?? 0) >= (counts.get(idKey(item.Id))?.Total ?? 0)) === query.isplayed
    : (state.userData.get(idKey(item.Id))?.Played || state.leafIsPlayed(item)) === query.isplayed);
}
