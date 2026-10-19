import { EMPTY_ID, nonemptyId, sameId } from '../library/records.js';
import { ItemUpdateType } from './save-manager.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

export function beforeSaveTvMetadata(item, { parents = [], resolveSeries, resolveSeason, libraryOptions = {} }) {
  if (!['Episode', 'Season'].includes(item.Type)) return ItemUpdateType.None;
  let updateType = ItemUpdateType.None;
  const set = (key, value, reason = ItemUpdateType.MetadataImport) => {
    const same = key.endsWith('Id') ? sameId(item[key] ?? EMPTY_ID, value) : (item[key] ?? null) === (value ?? null);
    if (!same) { item[key] = value; updateType |= reason; }
  };
  if (item.Type === 'Season') {
    const specialName = Object.hasOwn(libraryOptions, 'SeasonZeroDisplayName') ? libraryOptions.SeasonZeroDisplayName : 'Specials';
    if (item.IndexNumber === 0 && !item.IsLocked && !(item.LockedFields ?? []).includes('Name')
      && !ordinalIgnoreCaseEquals(item.Name, specialName)) {
      set('Name', specialName, ItemUpdateType.MetadataEdit);
    }
    const series = resolveSeries?.(item);
    set('SeriesName', series ? series.Name : item.SeriesName);
    set('SeriesPresentationUniqueKey', series?.PresentationUniqueKey ?? null);
    set('SeriesId', parents.find(parent => parent.Type === 'Series')?.Id ?? EMPTY_ID);
  } else {
    if (item.IndexNumberEnd != null && (item.IndexNumber == null || item.IndexNumberEnd < item.IndexNumber)) {
      set('IndexNumberEnd', null);
    }
    const series = resolveSeries?.(item), season = resolveSeason?.(item);
    set('SeriesName', series ? series.Name : item.SeriesName);
    set('SeasonName', season ? season.Name : item.ParentIndexNumber == null ? 'Season Unknown' : `Season ${item.ParentIndexNumber}`);
    set('SeriesId', parents.find(parent => parent.Type === 'Series')?.Id ?? EMPTY_ID);
    let physicalSeason = parents.find(parent => parent.Type === 'Season');
    if (!physicalSeason && item.ParentIndexNumber != null) {
      const currentSeries = resolveSeries?.(item);
      physicalSeason = currentSeries && resolveSeason?.({ ...item, SeasonId: EMPTY_ID });
    }
    set('SeasonId', physicalSeason?.Id ?? EMPTY_ID);
    // The native getter runs again after SeriesId has been corrected.
    set('SeriesPresentationUniqueKey', resolveSeries?.(item)?.PresentationUniqueKey ?? null);
  }
  // Native Guid properties hydrate null database columns as Guid.Empty.
  if (!nonemptyId(item.SeriesId)) item.SeriesId = EMPTY_ID;
  if (item.Type === 'Episode' && !nonemptyId(item.SeasonId)) item.SeasonId = EMPTY_ID;
  return updateType;
}
