import { ItemUpdateType } from './save-manager.js';

export function onMetadataChanged(item, rating) {
  let updateType = ItemUpdateType.None;
  if (rating != null) {
    for (const [field, value] of [['InheritedParentalRatingValue', rating.score], ['InheritedParentalRatingSubValue', rating.subScore]]) {
      if ((item[field] ?? null) !== (value ?? null)) {
        item[field] = value ?? null;
        updateType |= ItemUpdateType.MetadataImport;
      }
    }
  } else if (item.InheritedParentalRatingValue != null) {
    item.InheritedParentalRatingValue = null;
    item.InheritedParentalRatingSubValue = null;
    updateType |= ItemUpdateType.MetadataImport;
  }
  return updateType;
}
