import { randomInt } from 'node:crypto';
import { idKey, dateText, dateTicks, MIN_DATE } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { getRatingScore } from '../core/localization-data.js';
import { sortNative } from '../core/native-sort.js';
import { resolveSeries } from './series-reference.js';

const compare = (left, right) => left == null ? right == null ? 0 : -1
  : right == null ? 1 : left < right ? -1 : left > right ? 1 : 0;
const compareText = (left, right) => compare(left == null ? left : ordinalIgnoreCaseKey(String(left)),
  right == null ? right : ordinalIgnoreCaseKey(String(right)));
const studioComparer = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });
const registered = new Set(['airedepisodeorder', 'albumartist', 'album', 'artist', 'communityrating', 'criticrating',
  'datecreated', 'datelastcontentadded', 'dateplayed', 'indexnumber', 'isfavoriteorliked', 'isfolder', 'isunplayed',
  'name', 'officialrating', 'parentindexnumber', 'playcount', 'premieredate', 'productionyear', 'random', 'runtime',
  'seriessortname', 'sortname', 'startdate', 'studio']);
const textKeys = new Set(['album', 'albumartist', 'artist', 'name', 'sortname', 'seriessortname']);
const audioTypes = new Set(['Audio', 'AudioBook']);
const albumArtistTypes = new Set(['Audio', 'AudioBook', 'MusicAlbum']);

function seriesSortName(item, context, sortNameFor) {
  if (item.Type === 'AudioBook') return item.SeriesName;
  if (!['Episode', 'Season'].includes(item.Type)) return null;
  const series = context?.seriesFor ? context.seriesFor(item) : resolveSeries(item, context?.byId ?? new Map());
  return series ? sortNameFor(series) : item.SeriesName;
}

function airedEpisodeOrder(left, right) {
  const leftEpisode = left.Type === 'Episode', rightEpisode = right.Type === 'Episode';
  if (!leftEpisode) return rightEpisode ? 1 : 0;
  if (!rightEpisode) return -1;
  const leftSpecial = (left.ParentIndexNumber ?? -1) === 0, rightSpecial = (right.ParentIndexNumber ?? -1) === 0;
  const specialValue = item => BigInt(item.AirsAfterSeasonNumber ?? item.AirsBeforeSeasonNumber ?? 0) * 1000000000n
    + (item.AirsAfterSeasonNumber == null ? 0n : 1000000n)
    + BigInt(Math.imul(item.AirsBeforeEpisodeNumber ?? 0, 1000)) + BigInt(item.IndexNumber ?? 0);
  if (leftSpecial && rightSpecial) return compare(specialValue(left), specialValue(right));
  if (!leftSpecial && !rightSpecial) {
    const result = compare((Math.imul(left.ParentIndexNumber ?? -1, 1000) + (left.IndexNumber ?? -1)) | 0,
      (Math.imul(right.ParentIndexNumber ?? -1, 1000) + (right.IndexNumber ?? -1)) | 0);
    return result || (left.PremiereDate != null && right.PremiereDate != null
      ? compare(dateTicks(left.PremiereDate), dateTicks(right.PremiereDate)) : 0);
  }
  const episodeToSpecial = (episode, special) => {
    const result = compare(episode.ParentIndexNumber ?? -1, special.AirsAfterSeasonNumber ?? special.AirsBeforeSeasonNumber ?? -1);
    if (result) return result;
    if (special.AirsAfterSeasonNumber != null) return -1;
    if (special.AirsBeforeEpisodeNumber == null) return 1;
    if (episode.IndexNumber == null) return 0;
    return episode.IndexNumber === special.AirsBeforeEpisodeNumber ? 1 : compare(episode.IndexNumber, special.AirsBeforeEpisodeNumber);
  };
  return leftSpecial ? -episodeToSpecial(right, left) : episodeToSpecial(left, right);
}

export function sortMemoryItems(items, requested, userData, isPlayed, sortNameFor, context) {
  let input = [...items], entries = [];
  for (const entry of requested) {
    // FirstOrDefault ignores absent registrations: Default, IsPlayed,
    // VideoBitRate, AirTime and SeriesDatePlayed. Both played comparers register
    // IsUnplayed; its first registration sorts played items first.
    if (!registered.has(entry.name)) continue;
    if (entry.name === 'random') {
      // Earlier OrderBy objects are lazy. Native shuffles current input and
      // discards those unenumerated orderings before processing later keys.
      for (let index = 0; index + 1 < input.length; index++) {
        const selected = randomInt(index, input.length);
        [input[index], input[selected]] = [input[selected], input[index]];
      }
      entries = [];
    } else entries.push(entry);
  }
  const key = (item, entry) => {
    switch (entry.name) {
      case 'album': return audioTypes.has(item.Type) ? item.Album : '';
      case 'albumartist': return albumArtistTypes.has(item.Type) ? item.AlbumArtists?.[0] ?? null : null;
      case 'artist': return audioTypes.has(item.Type) ? item.Artists?.[0] ?? null : '';
      case 'runtime': return item.RunTimeTicks ?? 0n;
      case 'communityrating': return Math.fround(item.CommunityRating ?? 0);
      case 'criticrating': return Math.fround(item.CriticRating ?? 0);
      case 'productionyear': return item.ProductionYear ?? (item.PremiereDate ? Number(dateText(item.PremiereDate).slice(0, 4)) : 0);
      case 'isfolder': return item.IsFolder ? 0 : 1;
      case 'datecreated': return dateTicks(item.DateCreated ?? MIN_DATE);
      case 'dateplayed': return dateTicks(userData.get(idKey(item.Id))?.LastPlayedDate ?? MIN_DATE);
      case 'datelastcontentadded': return dateTicks(item.IsFolder ? item.DateLastMediaAdded ?? MIN_DATE : MIN_DATE);
      case 'startdate': return dateTicks(item.Type === 'LiveTvProgram' ? item.StartDate ?? MIN_DATE : MIN_DATE);
      case 'premieredate': {
        if (item.PremiereDate != null) return dateTicks(item.PremiereDate);
        const year = item.ProductionYear;
        return dateTicks(Number.isInteger(year) && year >= 1 && year <= 9999
          ? String(year).padStart(4, '0') + '-01-01 00:00:00' : MIN_DATE);
      }
      case 'sortname': return sortNameFor(item);
      case 'name': return item.Name;
      case 'seriessortname': return seriesSortName(item, context, sortNameFor);
      case 'indexnumber': return item.IndexNumber;
      case 'parentindexnumber': return item.ParentIndexNumber;
      case 'isunplayed': return isPlayed(item) ? 0 : 1;
      case 'playcount': return userData.get(idKey(item.Id))?.PlayCount ?? 0;
      case 'isfavoriteorliked': {
        const data = userData.get(idKey(item.Id));
        return data?.IsFavorite || data?.Likes ? 0 : 1;
      }
      case 'officialrating': {
        if (item.OfficialRating == null || item.OfficialRating === '') return { score: 0, subScore: 0 };
        const country = context?.preferredMetadataCountryFor
          ? context.preferredMetadataCountryFor(item) : item.PreferredMetadataCountryCode;
        return getRatingScore(item.OfficialRating, country, context?.defaultMetadataCountry) ?? { score: 0, subScore: 0 };
      }
      case 'studio': return item.Studios?.[0] ?? null;
    }
  };
  return sortNative(input, (left, right) => {
    for (const entry of entries) {
      let comparison;
      if (entry.name === 'airedepisodeorder') comparison = airedEpisodeOrder(left, right);
      else if (entry.name === 'officialrating') {
        const leftScore = key(left, entry), rightScore = key(right, entry);
        comparison = compare(leftScore.score, rightScore.score) || compare(leftScore.subScore ?? 0, rightScore.subScore ?? 0);
      } else if (entry.name === 'studio') {
        const leftStudio = key(left, entry), rightStudio = key(right, entry);
        comparison = leftStudio == null || rightStudio == null ? compare(leftStudio, rightStudio) : studioComparer.compare(leftStudio, rightStudio);
      } else comparison = textKeys.has(entry.name) ? compareText(key(left, entry), key(right, entry)) : compare(key(left, entry), key(right, entry));
      if (comparison) return comparison * entry.sign;
    }
    return 0;
  });
}
