import { dateTicks, idKey, nonemptyId, repositoryTopParentId } from './records.js';
import { visibleItem } from './permissions.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { sortNative } from '../core/native-sort.js';
import { userRootFolders } from './collection-membership.js';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const nullableCompare = (a, b) => a == null ? (b == null ? 0 : -1) : b == null ? 1 : compare(a, b);
const positionCompare = (a, b) => nullableCompare(a.ParentIndexNumber, b.ParentIndexNumber) || nullableCompare(a.IndexNumber, b.IndexNumber);
const positionedAfter = (item, previous) => previous?.ParentIndexNumber == null || previous.IndexNumber == null
  || item.ParentIndexNumber != null && (item.ParentIndexNumber > previous.ParentIndexNumber
    || item.ParentIndexNumber === previous.ParentIndexNumber && item.IndexNumber != null && item.IndexNumber > previous.IndexNumber);

function specialOrder(item) {
  return BigInt.asIntN(64, BigInt(item.AirsAfterSeasonNumber ?? item.AirsBeforeSeasonNumber ?? 0) * 1000000000n
    + (item.AirsAfterSeasonNumber == null ? 0n : 1000000n)
    + BigInt(Math.imul(item.AirsBeforeEpisodeNumber ?? 0, 1000)) + BigInt(item.IndexNumber ?? 0));
}

function regularToSpecial(regular, special) {
  const seasons = compare(regular.ParentIndexNumber ?? -1, special.AirsAfterSeasonNumber ?? special.AirsBeforeSeasonNumber ?? -1);
  if (seasons) return seasons;
  if (special.AirsAfterSeasonNumber != null) return -1;
  if (special.AirsBeforeEpisodeNumber == null) return 1;
  if (regular.IndexNumber == null) return 0;
  return regular.IndexNumber === special.AirsBeforeEpisodeNumber ? 1 : compare(regular.IndexNumber, special.AirsBeforeEpisodeNumber);
}

export function airedEpisodeOrder(a, b) {
  const specialA = a.ParentIndexNumber === 0;
  const specialB = b.ParentIndexNumber === 0;
  if (specialA && specialB) return compare(specialOrder(a), specialOrder(b));
  if (specialA) return -regularToSpecial(b, a);
  if (specialB) return regularToSpecial(a, b);
  const result = compare((Math.imul(a.ParentIndexNumber ?? -1, 1000) + (a.IndexNumber ?? -1)) | 0,
    (Math.imul(b.ParentIndexNumber ?? -1, 1000) + (b.IndexNumber ?? -1)) | 0);
  return result || (a.PremiereDate != null && b.PremiereDate != null ? compare(dateTicks(a.PremiereDate), dateTicks(b.PremiereDate)) : 0);
}

export const sortAiredEpisodes = episodes => sortNative(episodes, airedEpisodeOrder);

export function nextUpTopParentIds(parents, state, physicalIdsFor, user, permissions) {
  // The frozen repository only consumes TopParentIds. LibraryManager's ordinary
  // Folder/Series ancestor fallback therefore activates no series here.
  if (!parents.every(parent => ['CollectionFolder', 'UserView'].includes(parent.Type))) return new Set();
  const seen = new Set();
  const visit = parent => {
    if (!parent || seen.has(idKey(parent.Id))) return [];
    seen.add(idKey(parent.Id));
    if (parent.Type === 'CollectionFolder') return physicalIdsFor(parent, state) ?? [];
    if (parent.Type === 'UserView') {
      if (ordinalIgnoreCaseEquals(parent.ViewType, 'livetv')) return [parent.Id];
      const reference = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId : parent.ParentId;
      if (nonemptyId(reference)) return visit(state.byId.get(idKey(reference)));
      if (parent.ViewType != null && !['movies', 'tvshows']
        .some(type => ordinalIgnoreCaseEquals(parent.ViewType, type))) return [];
      const grouped = new Set((user.Configuration?.GroupedFolders ?? []).map(idKey));
      return userRootFolders(state).filter(item => item.Type === 'CollectionFolder' && grouped.has(idKey(item.Id))
        && (item.CollectionType == null || ordinalIgnoreCaseEquals(item.CollectionType, parent.ViewType))
        && visibleItem(item, user, state, { ...permissions, query: false })).flatMap(visit);
    }
    const top = state.byId.get(idKey(repositoryTopParentId(parent)));
    return top ? [top.Id] : [];
  };
  return new Set(parents.flatMap(visit).map(idKey));
}
