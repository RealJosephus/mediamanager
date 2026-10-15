import { ItemUpdateType } from '../metadata/save-manager.js';
import { VIDEO_TYPES } from './records.js';

const typeName = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const videoTypes = ['VideoFile', 'Iso', 'Dvd', 'BluRay'];
const videoTypeValue = value => value == null ? 0 : videoTypes.includes(value) ? videoTypes.indexOf(value) : Number(value);
const emptyStrings = Object.freeze([]);
const strings = (item, field) => item[field] === undefined ? emptyStrings : item[field];
const sameSequence = (left, right) => {
  // The native array overload compares spans: a null array is an empty span.
  left ??= emptyStrings;
  right ??= emptyStrings;
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/** Applies BaseItem/Video.UpdateFromResolvedItem without importing metadata. */
export function updateFromResolvedItem(current, resolved) {
  let updateType = ItemUpdateType.None;
  if ((current.IsInMixedFolder ?? false) !== (resolved.IsInMixedFolder ?? false)) {
    current.IsInMixedFolder = resolved.IsInMixedFolder ?? false;
    updateType |= ItemUpdateType.MetadataImport;
  }
  if (VIDEO_TYPES.has(typeName(current)) && VIDEO_TYPES.has(typeName(resolved))) {
    for (const field of ['AdditionalParts', 'LocalAlternateVersions']) {
      const value = strings(resolved, field);
      if (!sameSequence(strings(current, field), value)) {
        current[field] = value;
        updateType |= ItemUpdateType.MetadataImport;
      }
    }
    if (videoTypeValue(current.VideoType) !== videoTypeValue(resolved.VideoType)) {
      current.VideoType = resolved.VideoType ?? 'VideoFile';
      updateType |= ItemUpdateType.MetadataImport;
    }
  }
  return updateType;
}
