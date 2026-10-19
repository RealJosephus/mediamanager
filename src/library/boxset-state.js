import path from 'node:path';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

export function isLegacyBoxSet(item, hasLinkedChildren, programDataPath) {
  if (item.Type !== 'BoxSet' || !item.Path || hasLinkedChildren) return false;
  if (!programDataPath) return true;
  const windows = /^[A-Za-z]:[\\/]|^[\\/]{2}/u.test(programDataPath);
  const api = windows ? path.win32 : path.posix;
  const parent = api.join(programDataPath, 'data');
  const fold = value => windows ? ordinalIgnoreCaseKey(value) : value;
  // ContainsSubPath is a strict, anchored string-prefix check. Equal paths are
  // not children; do not resolve ".." or normalize the item's path here.
  const underData = item.Path.length > parent.length
    && fold(item.Path.slice(0, parent.length)) === fold(parent)
    && (windows ? /[\\/]/u : /\//u).test(item.Path[parent.length]);
  return !underData;
}

const sortNames = [
  'Default', 'AiredEpisodeOrder', 'Album', 'AlbumArtist', 'Artist', 'DateCreated',
  'OfficialRating', 'DatePlayed', 'PremiereDate', 'StartDate', 'SortName', 'Name',
  'Random', 'Runtime', 'CommunityRating', 'ProductionYear', 'PlayCount',
  'CriticRating', 'IsFolder', 'IsUnplayed', 'IsPlayed', 'SeriesSortName',
  'VideoBitRate', 'AirTime', 'Studio', 'IsFavoriteOrLiked',
  'DateLastContentAdded', 'SeriesDatePlayed', 'ParentIndexNumber', 'IndexNumber',
];

export function boxSetDisplayOrder(item) {
  const text = clrTrim(item.DisplayOrder ?? 'PremiereDate');
  let number;
  if (/^[+-]?\d+$/u.test(text)) {
    number = BigInt(text);
    if (number < -2147483648n || number > 2147483647n) return 'PremiereDate';
  } else {
    number = 0n;
    for (const part of text.split(',')) {
      const index = sortNames.indexOf(clrTrim(part));
      if (index < 0) return 'PremiereDate';
      number |= BigInt(index);
    }
  }
  // Undefined numeric enum values have no registered comparer. Native Sort
  // leaves the cached sequence unchanged, as does the explicit Default value.
  return sortNames[Number(number)] ?? 'Default';
}
