import { dateTicks } from '../library/records.js';

export const ownedTitleFields = Object.freeze([
  'Genres', 'Studios', 'ProductionLocations', 'CommunityRating', 'CriticRating',
  'Overview', 'OfficialRating', 'CustomRating', 'ProductionYear', 'PremiereDate'
]);

const sameSequence = (left, right) => {
  left ??= [];
  right ??= [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/** Native BaseItem.InheritDatesFromOwner never clears a child's dates. */
export function inheritOwnedItemDates(owner, ownedItem) {
  let changed = false;
  if (owner.ProductionYear != null && ownedItem.ProductionYear !== owner.ProductionYear) {
    ownedItem.ProductionYear = owner.ProductionYear;
    changed = true;
  }
  if (owner.PremiereDate != null && (ownedItem.PremiereDate == null
    || dateTicks(owner.PremiereDate) !== dateTicks(ownedItem.PremiereDate))) {
    ownedItem.PremiereDate = owner.PremiereDate;
    changed = true;
  }
  return changed;
}

/** Mutates the child before its independent native metadata refresh. */
export function prepareOwnedItemRefresh(owner, ownedItem, options = {}, { copyTitleMetadata = true } = {}) {
  const childOptions = { ...options, SearchResult: null, ForceSave: options.ForceSave === true,
    RefreshPaths: options.RefreshPaths?.length ? [...options.RefreshPaths] : null };
  if (!copyTitleMetadata) return childOptions;
  for (const field of ['Genres', 'Studios', 'ProductionLocations']) {
    if (!sameSequence(owner[field], ownedItem[field])) {
      ownedItem[field] = owner[field];
      childOptions.ForceSave = true;
    }
  }
  for (const field of ['CommunityRating', 'CriticRating', 'Overview', 'OfficialRating', 'CustomRating']) {
    if ((owner[field] ?? null) !== (ownedItem[field] ?? null)) {
      ownedItem[field] = owner[field] ?? null;
      childOptions.ForceSave = true;
    }
  }
  if (inheritOwnedItemDates(owner, ownedItem)) childOptions.ForceSave = true;
  return childOptions;
}
