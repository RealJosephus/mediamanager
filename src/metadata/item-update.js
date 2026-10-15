import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrTrim } from './whitespace.js';
import { trySetProviderId } from './provider-ids.js';
import { formatUtcTicks } from '../syncplay/time.js';
import { itemHasArtist, itemHasAlbumArtist } from '../library/item-relations.js';

const videoTypes = new Set(['Movie', 'Video', 'MusicVideo', 'Trailer', 'Episode']);
export const peopleItemTypes = new Set(['Book', 'Audio', 'AudioBook', 'MusicAlbum', 'BoxSet', 'Season', 'Series', ...videoTypes]);
const distinct = values => {
  const seen = new Set();
  return values.filter(value => { const key = value == null ? null : ordinalIgnoreCaseKey(value); if (seen.has(key)) return false; seen.add(key); return true; });
};
const nonblank = value => value == null || !clrTrim(value) ? null : value;
const normalizedDate = value => value == null ? null : formatUtcTicks(value.ticks);
const artistNames = values => distinct(values.map(artist => {
  if (artist?.Name == null) throw Object.assign(new TypeError('Object reference not set to an instance of an object.'),
    { nativeException: 'NullReferenceException', status: 500 });
  return clrTrim(artist.Name);
}));

function seriesStatus(value) {
  if (value == null || value === '') return null;
  const source = clrTrim(value);
  const names = ['Continuing', 'Ended', 'Unreleased'];
  let result;
  if (/^[+-]?\d+$/u.test(source)) result = Number(source);
  else {
    const parts = source.split(',').map(part => names.findIndex(name => ordinalIgnoreCaseEquals(name, clrTrim(part))));
    if (parts.every(part => part >= 0)) result = parts.reduce((left, right) => left | right, 0);
  }
  if (!Number.isInteger(result) || result < -2147483648 || result > 2147483647) {
    throw Object.assign(new Error(`Requested value '${value}' was not found.`), { nativeException: 'ArgumentException', status: 500 });
  }
  return names[result] ?? result;
}

export function metadataEditFlags(item, request) {
  return {
    lockChanged: item.IsLocked !== (request.LockData ?? false),
    displayOrderChanged: item.Type === 'Series' && !ordinalIgnoreCaseEquals(item.DisplayOrder ?? '', request.DisplayOrder ?? '')
  };
}

export async function applyItemMetadataUpdate(item, request, { children = () => [], save = async () => {}, findLanguage = value => value } = {}) {
  for (const key of ['Name', 'ForcedSortName', 'CriticRating', 'CommunityRating', 'IndexNumber', 'ParentIndexNumber', 'Overview']) {
    item[key] = request[key] ?? null;
  }
  item.OriginalTitle = nonblank(request.OriginalTitle);
  item.OriginalLanguage = findLanguage(nonblank(request.OriginalLanguage));
  if (request.Genres != null) item.Genres = distinct(request.Genres);
  if (item.Type === 'Episode') for (const key of ['AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber', 'AirsBeforeSeasonNumber']) item[key] = request[key] ?? null;
  if (request.Height != null && item.Type === 'LiveTvChannel') item.Height = request.Height;
  if (request.Taglines != null) item.Tagline = request.Taglines[0] ?? null;
  if (request.Studios != null) item.Studios = distinct(request.Studios.map(studio => studio.Name));
  if (request.DateCreated != null) item.DateCreated = normalizedDate(request.DateCreated);
  if (request.SeriesName != null && ['Episode', 'Season'].includes(item.Type)) item.SeriesName = request.SeriesName;
  item.EndDate = normalizedDate(request.EndDate);
  item.PremiereDate = normalizedDate(request.PremiereDate);
  item.ProductionYear = request.ProductionYear ?? null;
  item.OfficialRating = nonblank(request.OfficialRating);
  item.CustomRating = request.CustomRating ?? null;
  const previousTags = item.Tags ?? [];
  let removed = [], added = [];
  if (request.Tags != null) {
    item.Tags = distinct(request.Tags.map(clrTrim));
    // Except uses case-sensitive default equality, after case-insensitive Distinct.
    removed = previousTags.filter(tag => !item.Tags.includes(tag));
    added = item.Tags.filter(tag => !previousTags.includes(tag));
  }
  const propagate = async (child, renameSeries = false) => {
    if (renameSeries) child.SeriesName = item.Name;
    if (!(child.LockedFields ?? []).includes('OfficialRating')) child.OfficialRating = item.OfficialRating;
    child.CustomRating = item.CustomRating;
    if (!(child.LockedFields ?? []).includes('Tags')) child.Tags = distinct([...(child.Tags ?? []), ...added].filter(tag => !removed.includes(tag)));
    await save(child);
  };
  if (item.Type === 'Series') {
    for await (const season of children(item)) if(season.Type === 'Season') {
      await propagate(season, true);
      for await (const episode of children(season)) if(episode.Type === 'Episode') await propagate(episode, true);
    }
  } else if (item.Type === 'Season') {
    for await (const episode of children(item)) if(episode.Type === 'Episode') await propagate(episode);
  } else if (item.Type === 'MusicAlbum') {
    for await (const track of children(item)) await propagate(track);
  }
  if (request.ProductionLocations != null) item.ProductionLocations = distinct(request.ProductionLocations);
  for (const key of ['PreferredMetadataCountryCode', 'PreferredMetadataLanguage']) item[key] = request[key] ?? null;
  if (['Series', 'BoxSet'].includes(item.Type)) item.DisplayOrder = request.DisplayOrder ?? null;
  if (videoTypes.has(item.Type)) item.AspectRatio = request.AspectRatio ?? null;
  item.IsLocked = request.LockData ?? false;
  if (request.LockedFields != null) item.LockedFields = [...request.LockedFields];
  if (item.Type === 'Series') item.RunTimeTicks = request.RunTimeTicks ?? null;
  if (request.ProviderIds != null) {
    item.ProviderIds = {};
    for (const [name, value] of request.ProviderIds instanceof Map ? request.ProviderIds : Object.entries(request.ProviderIds)) trySetProviderId(item, name, value);
  }
  if (videoTypes.has(item.Type)) item.Video3DFormat = request.Video3DFormat ?? null;
  if (request.AlbumArtists != null && itemHasAlbumArtist(item)) item.AlbumArtists = artistNames(request.AlbumArtists);
  if (request.ArtistItems != null && itemHasArtist(item)) item.Artists = artistNames(request.ArtistItems);
  if (['Audio', 'AudioBook', 'MusicVideo'].includes(item.Type)) item.Album = request.Album ?? null;
  if (item.Type === 'Series') {
    item.Status = seriesStatus(request.Status);
    if (request.AirDays != null) { item.AirDays = [...request.AirDays]; item.AirTime = request.AirTime ?? null; }
  }
  return item;
}
