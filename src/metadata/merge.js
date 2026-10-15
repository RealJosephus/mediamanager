import {cloneNativeItemValue} from '../library/native-item-value.js';
import { publishNativeItemLinks } from '../library/native-item-entity.js';
import { isValidProviderId } from './provider-ids.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { idKey, nonemptyId } from '../library/records.js';
import { nativeContainsSubPath } from '../library/native-path.js';

const empty = value => value == null || value === '';
const missing = value => value == null;
const unique = values => values.filter((value, index) => values.findIndex(entry => ordinalIgnoreCaseKey(entry) === ordinalIgnoreCaseKey(value)) === index);
const videoTypes = new Set(['Movie', 'Video', 'MusicVideo', 'Episode', 'Trailer']);
const idIsValid = isValidProviderId;
const cleanIds = person => {
  person.ProviderIds ??= {};
  for (const [key, value] of Object.entries(person.ProviderIds)) if (!idIsValid(key, value)) delete person.ProviderIds[key];
};

function mergePeople(source, target) {
  const nameKey = person => ordinalIgnoreCaseKey(removeDiacritics(person.Name));
  const names = [...new Set(target.map(nameKey))];
  for (const key of names) {
    const candidates = source.filter(person => nameKey(person) === key);
    if (!candidates.length) continue;
    target.filter(person => nameKey(person) === key).forEach((person, index) => {
      const candidate = candidates[index] ?? candidates[0];
      for (const [name, value] of Object.entries(candidate.ProviderIds ?? {})) {
        if (!Object.keys(person.ProviderIds).some(existing => ordinalIgnoreCaseKey(existing) === ordinalIgnoreCaseKey(name))) Object.defineProperty(person.ProviderIds,name,{value,enumerable:true,writable:true,configurable:true});
      }
      if (!person.ImageUrl?.trim()) person.ImageUrl = candidate.ImageUrl;
      if (!person.Role?.trim() && candidate.Role?.trim()) person.Role = candidate.Role;
      if (person.SortOrder == null && candidate.SortOrder != null) person.SortOrder = candidate.SortOrder;
    });
  }
}

function playlistLinkKey(link) {
  return nonemptyId(link?.ItemId) ? idKey(link.ItemId) : link?.Path ?? '';
}

function firstBy(values, keyFor) {
  const seen = new Set();
  return values.filter(value => { const key = keyFor(value); if (seen.has(key)) return false; seen.add(key); return true; });
}

async function mergePlaylistSettings(source, target, { replaceData, dataPath, linkedChildren }) {
  target.PlaylistMediaType = source.PlaylistMediaType;
  const targetPath = target.Path;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(targetPath ?? dataPath ?? '');
  const external = Boolean(targetPath) && (!dataPath || !nativeContainsSubPath(targetPath, dataPath, { windows }));
  if (external) {
    const replace = replaceData || await linkedChildren.count(target.LinkedChildren) === 0n;
    publishNativeItemLinks(target, await linkedChildren.merge(source.LinkedChildren, target.LinkedChildren, { parentId: target.Id, replace }));
    await linkedChildren.flushReleases();
  }
  if (replaceData || !target.Shares?.length) target.Shares = cloneNativeItemValue(source.Shares ?? []);
  else target.Shares = firstBy([...source.Shares ?? [], ...target.Shares], share => idKey(share.UserId));
}

export async function mergeMetadata(sourceResult, targetResult, { lockedFields = [], replaceData = false, mergeMetadataSettings = false, dataPath, linkedChildren } = {}) {
  const source = sourceResult.Item, target = targetResult.Item;
  if (!source || !target) throw new TypeError('Metadata merging requires source and target items.');
  const put = (key, absent = empty, lock) => {
    if ((!lock || !lockedFields.includes(lock)) && (replaceData || absent(target[key]))) target[key] = cloneNativeItemValue(source[key] ?? null);
  };
  if (!lockedFields.includes('Name') && (replaceData || empty(target.Name)) && source.Name?.trim()) target.Name = source.Name;
  for (const key of ['OriginalTitle', 'HomePageUrl', 'OriginalLanguage', 'CustomRating', 'Tagline']) put(key);
  for (const key of ['CommunityRating', 'EndDate', 'IndexNumber', 'ParentIndexNumber', 'PremiereDate', 'ProductionYear', 'CriticRating']) put(key, missing);
  put('OfficialRating', empty, 'OfficialRating'); put('Overview', empty, 'Overview');
  if (!lockedFields.includes('Genres') && (replaceData || !target.Genres?.length)) target.Genres = [...source.Genres ?? []];
  if (!lockedFields.includes('Cast')) {
    sourceResult.People?.forEach(cleanIds); targetResult.People?.forEach(cleanIds);
    if (replaceData || !targetResult.People?.length) targetResult.People = cloneNativeItemValue(sourceResult.People ?? null);
    else if (sourceResult.People?.length) mergePeople(sourceResult.People, targetResult.People);
  }
  if (!videoTypes.has(target.Type) && !['Audio', 'AudioBook', 'Book'].includes(target.Type)) put('RunTimeTicks', missing, 'Runtime');
  for (const key of ['Studios', 'Tags', 'ProductionLocations']) {
    if (lockedFields.includes(key)) continue;
    target[key] = replaceData || !target[key]?.length ? [...source[key] ?? []] : unique([...target[key], ...source[key] ?? []]);
  }
  target.ProviderIds ??= {};
  for (const [name, value] of Object.entries(source.ProviderIds ?? {})) {
    if (!idIsValid(name, value)) continue;
    const key = Object.keys(target.ProviderIds).find(key => ordinalIgnoreCaseKey(key) === ordinalIgnoreCaseKey(name)) ?? name;
    if (replaceData || !Object.hasOwn(target.ProviderIds,key) || !idIsValid(key, target.ProviderIds[key])) Object.defineProperty(target.ProviderIds,key,{value,enumerable:true,writable:true,configurable:true});
  }
  cleanIds(target);
  const trailers = [...target.RemoteTrailers ?? [], ...source.RemoteTrailers ?? []];
  target.RemoteTrailers = replaceData || !target.RemoteTrailers?.length ? cloneNativeItemValue(source.RemoteTrailers ?? [])
    : trailers.filter((trailer, index) => trailers.findIndex(entry => entry.Url === trailer.Url) === index);
  if (['MusicAlbum', 'Audio', 'AudioBook', 'MusicVideo'].includes(target.Type)) target.AlbumArtists = replaceData || !target.AlbumArtists?.length
    ? [...source.AlbumArtists ?? []] : unique([...target.AlbumArtists, ...source.AlbumArtists ?? []]);
  if (videoTypes.has(target.Type) && source.Video3DFormat != null && (replaceData || target.Video3DFormat == null)) target.Video3DFormat = source.Video3DFormat;
  if (['Series', 'BoxSet'].includes(target.Type) && (replaceData || empty(target.DisplayOrder)) && source.DisplayOrder?.trim()) target.DisplayOrder = source.DisplayOrder;
  if ((replaceData || empty(target.ForcedSortName)) && !empty(source.ForcedSortName)) target.ForcedSortName = source.ForcedSortName;
  if (mergeMetadataSettings) {
    target.IsLocked = Boolean(target.IsLocked || source.IsLocked);
    target.LockedFields = [...new Set([...target.LockedFields ?? [], ...source.LockedFields ?? []])];
    if (source.DateCreated && !source.DateCreated.startsWith('0001-01-01')) target.DateCreated = source.DateCreated;
    if (replaceData || source.DateModified && !source.DateModified.startsWith('0001-01-01')) target.DateModified = source.DateModified ?? '0001-01-01T00:00:00';
    for (const key of ['PreferredMetadataCountryCode', 'PreferredMetadataLanguage']) put(key);
    if (target.Type === 'Playlist') await mergePlaylistSettings(source, target, { replaceData, dataPath, linkedChildren });
    if (target.Type === 'BoxSet' && target.Path && (!dataPath || !nativeContainsSubPath(target.Path, dataPath,
      { windows: /^[A-Za-z]:[\\/]|^\\\\/u.test(target.Path) }))) {
      // BoxSet always concatenates source first and deduplicates, even for a
      // replacing refresh. Internal collections keep repository ownership.
      publishNativeItemLinks(target, await linkedChildren.merge(source.LinkedChildren, target.LinkedChildren, { parentId: target.Id }));
      await linkedChildren.flushReleases();
    }
  }
  if (target.Type === 'Movie') put('TmdbCollectionName');
  if (target.Type === 'Series') { put('AirTime'); put('Status', missing); if (replaceData || !target.AirDays?.length) target.AirDays = cloneNativeItemValue(source.AirDays === undefined ? [] : source.AirDays); }
  if (target.Type === 'Episode') {
    for (const key of ['AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber', 'IndexNumberEnd']) put(key, missing);
    if (mergeMetadataSettings && source.ParentIndexNumber != null) target.ParentIndexNumber = source.ParentIndexNumber;
  }
  return targetResult;
}
