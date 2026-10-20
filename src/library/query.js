import { cleanValue, guid, dateText, libraryError, repositoryCleanName, repositoryValue, unsupported } from './records.js';
import { BindingError } from '../http/binding.js';
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';
import { lowerInvariant } from '../core/identity.js';
import { getRatingScore } from '../core/localization-data.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { imageTypes as imageTypeNames } from '../metadata/image-paths.js';
import { sortMemoryItems } from './memory-sort.js';
import { randomBytes } from 'node:crypto';

const arrays = {
  includeitemtypes: ',', excludeitemtypes: ',', ids: ',', excludeitemids: ',', mediatypes: ',', fields: ',', filters: ',',
  years: ',', locationtypes: ',', excludelocationtypes: ',',
  enableimagetypes: ',',
};
const bools = new Set(['recursive', 'collapseboxsetitems', 'enabletotalrecordcount', 'enableimages', 'enableuserdata', 'isfavorite', 'isplayed', 'ismissing', 'isunaired', 'islocked', 'isplaceholder', 'ismovie', 'isseries', 'issports', 'isnews', 'iskids', 'is3d', 'ishd', 'is4k', 'hassubtitles', 'hasoverview', 'hasofficialrating', 'hasparentalrating', 'hasimdbid', 'hastmdbid', 'hastvdbid', 'hasthemesong', 'hasthemevideo', 'hasspecialfeature', 'hastrailer']);
const integers = new Set(['startindex', 'limit', 'indexnumber', 'parentindexnumber', 'imagetypelimit', 'minwidth', 'minheight', 'maxwidth', 'maxheight']);
const doubles = new Set(['mincommunityrating', 'mincriticrating']);
const strings = new Set(['parentid', 'userid', 'adjacentto', 'searchterm', 'namestartswith', 'namestartswithorgreater', 'namelessthan', 'minpremieredate', 'maxpremieredate', 'mindatelastsaved', 'mindatelastsavedforuser', 'minofficialrating', 'maxofficialrating', 'person']);
// IsFolder is not a public ItemsController argument; ASP.NET leaves that
// unknown query parameter unbound. Filters=IsFolder is the supported selector.
const transport = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token', 'culture', 'ui-culture', 'isfolder',
  'x-emby-client', 'x-emby-device-name', 'x-emby-device-id', 'x-emby-client-version', 'x-emby-language', 'reqformat',
  'enableresumable', 'enablerewatching', 'nextupdatecutoff', 'minindexnumber']);
const sorts = new Map(Object.entries({ Default: 'SortName', AiredEpisodeOrder: 'SortName', AlbumArtist: 'repository:AlbumArtist', Artist: 'repository:Artist', Random: 'Random', Studio: 'repository:Studio', SeriesDatePlayed: 'repository:SeriesDatePlayed', SortName: 'SortName', Name: 'CleanName', Album: 'Album', DateCreated: 'DateCreated', OfficialRating: 'InheritedParentalRatingValue', PremiereDate: 'PremiereDate', StartDate: 'StartDate', Runtime: 'RunTimeTicks', CommunityRating: 'CommunityRating', ProductionYear: 'ProductionYear', CriticRating: 'CriticRating', IsFolder: 'IsFolder', SeriesSortName: 'SeriesName', VideoBitRate: 'TotalBitrate', AirTime: 'SortName', DateLastContentAdded: 'DateLastMediaAdded', ParentIndexNumber: 'ParentIndexNumber', IndexNumber: 'IndexNumber', DatePlayed: '@LastPlayedDate', PlayCount: '@PlayCount', IsPlayed: '@Played', IsUnplayed: '@Unplayed', IsFavoriteOrLiked: '@IsFavorite' }).map(([key, value]) => [key.toLowerCase(), value]));
const scalarNames = {
  recursive: 'recursive', enabletotalrecordcount: 'enableTotalRecordCount', enableimages: 'enableImages', enableuserdata: 'enableUserData',
  collapseboxsetitems: 'collapseBoxSetItems',
  isfavorite: 'isFavorite', isplayed: 'isPlayed', ismissing: 'isMissing', isunaired: 'isUnaired', islocked: 'isLocked', isplaceholder: 'isPlaceHolder',
  ismovie: 'isMovie', isseries: 'isSeries', issports: 'isSports', isnews: 'isNews', iskids: 'isKids',
  is3d: 'is3D', ishd: 'isHd', is4k: 'is4K', hassubtitles: 'hasSubtitles', hasoverview: 'hasOverview',
  hasofficialrating: 'hasOfficialRating', hasparentalrating: 'hasParentalRating', hasimdbid: 'hasImdbId',
  hasthemesong: 'hasThemeSong', hasthemevideo: 'hasThemeVideo', hasspecialfeature: 'hasSpecialFeature', hastrailer: 'hasTrailer',
  hastmdbid: 'hasTmdbId', hastvdbid: 'hasTvdbId', startindex: 'startIndex', limit: 'limit', indexnumber: 'indexNumber',
  parentindexnumber: 'parentIndexNumber', imagetypelimit: 'imageTypeLimit', minwidth: 'minWidth', minheight: 'minHeight',
  maxwidth: 'maxWidth', maxheight: 'maxHeight', mincommunityrating: 'minCommunityRating', mincriticrating: 'minCriticRating',
  parentid: 'parentId', userid: 'userId', adjacentto: 'adjacentTo', searchterm: 'searchTerm', namestartswith: 'nameStartsWith',
  namestartswithorgreater: 'nameStartsWithOrGreater', namelessthan: 'nameLessThan', minpremieredate: 'minPremiereDate',
  maxpremieredate: 'maxPremiereDate', mindatelastsaved: 'minDateLastSaved',
  mindatelastsavedforuser: 'minDateLastSavedForUser',
  minofficialrating: 'minOfficialRating', maxofficialrating: 'maxOfficialRating',
  person: 'person',
};
const videoTypes = new Map(['VideoFile', 'Iso', 'Dvd', 'BluRay'].map(value => [value.toLowerCase(), value]));
const seriesStatuses = new Map(['Continuing', 'Ended', 'Unreleased'].map(value => [value.toLowerCase(), value]));
const imageTypes = new Map(imageTypeNames.map((value, index) => [value.toLowerCase(), { name: value, number: index }]));
// The enum's declared values, rather than OrderMapper's columns, determine
// numeric ASP.NET binding. Undefined signed Int32 values remain valid enums.
const itemSortNames = ['Default', 'AiredEpisodeOrder', 'Album', 'AlbumArtist', 'Artist', 'DateCreated', 'OfficialRating',
  'DatePlayed', 'PremiereDate', 'StartDate', 'SortName', 'Name', 'Random', 'Runtime', 'CommunityRating', 'ProductionYear',
  'PlayCount', 'CriticRating', 'IsFolder', 'IsUnplayed', 'IsPlayed', 'SeriesSortName', 'VideoBitRate', 'AirTime', 'Studio',
  'IsFavoriteOrLiked', 'DateLastContentAdded', 'SeriesDatePlayed', 'ParentIndexNumber', 'IndexNumber'];
const sortOrderNames = ['Ascending', 'Descending'];

function enumCollection(entries, key, names) {
  const numbers = new Map(names.map((name, index) => [name.toLowerCase(), BigInt(index)]));
  const occurrences = entries.filter(([name]) => name.toLowerCase() === key)
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : [raw]);
  const candidates = occurrences.length === 1
    ? String(occurrences[0] ?? '').split(',').filter(value => value !== '') : occurrences;
  const result = [];
  for (const value of candidates) {
    let combined = 0n, valid = true;
    // Repeated query occurrences retain commas. EnumConverter combines their
    // comma-bearing values with bitwise OR, including non-flags enums.
    for (const part of String(value ?? '').split(',')) {
      const token = clrTrim(part), named = numbers.get(token.toLowerCase());
      let number = named;
      if (number === undefined) {
        if (!/^[+-]?\d+$/u.test(token)) { valid = false; break; }
        number = BigInt(token);
        if (number < -2147483648n || number > 2147483647n) { valid = false; break; }
      }
      combined |= BigInt.asUintN(32, number);
    }
    // The native binder logs FormatException and drops only that occurrence.
    if (valid) {
      const number = BigInt.asIntN(32, combined);
      result.push(names[Number(number)] ?? String(number));
    }
  }
  return result;
}

function videoTypeValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  let numeric = 0n;
  for (const part of text.split(',')) {
    const token = part.trim();
    const named = videoTypes.get(token.toLowerCase());
    let current;
    if (named) current = BigInt([...videoTypes.values()].indexOf(named));
    else {
      const hexadecimal = /^\+?(?:0x|#)([0-9a-f]+)$/iu.exec(token);
      if (hexadecimal) {
        current = BigInt(`0x${hexadecimal[1]}`);
        if (current > 0xffffffffn) return undefined;
      } else {
        if (!/^[+-]?\d+$/u.test(token)) return undefined;
        current = BigInt(token);
        if (current < -2147483648n || current > 2147483647n) return undefined;
        current = BigInt.asUintN(32, current);
      }
    }
    numeric |= current;
  }
  const signed = BigInt.asIntN(32, numeric);
  return [...videoTypes.values()][Number(signed)] ?? String(signed);
}

function seriesStatusValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const named = seriesStatuses.get(text.toLowerCase());
  if (named) return named;
  if (!/^[+-]?\d+$/u.test(text)) return undefined;
  const numeric = BigInt(text);
  if (numeric < -2147483648n || numeric > 2147483647n) return undefined;
  return [...seriesStatuses.values()][Number(numeric)] ?? String(numeric);
}

function imageTypeValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  let numeric = 0n;
  for (const part of text.split(',')) {
    const token = part.trim();
    const named = imageTypes.get(token.toLowerCase());
    let current;
    if (named) current = BigInt(named.number);
    else {
      if (!/^[+-]?\d+$/u.test(token)) return undefined;
      current = BigInt(token);
      if (current < -2147483648n || current > 2147483647n) return undefined;
      current = BigInt.asUintN(32, current);
    }
    // EnumConverter delegates comma-bearing repeated values to Enum.Parse,
    // which bitwise-combines the values even though ImageType is not a flags enum.
    numeric |= current;
  }
  const signed = BigInt.asIntN(32, numeric);
  return imageTypeNames[Number(signed)] ?? String(signed);
}

function delimitedStrings(entries, key, separator) {
  const occurrences = entries
    .filter(([name]) => name.toLowerCase() === key)
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : [raw]);
  if (!occurrences.length) return [];
  // Jellyfin's collection model binders only split a single query
  // occurrence. Repeated occurrences are converted independently, so a delimiter
  // inside one repeated value remains part of that value.
  const values = occurrences.length === 1
    ? String(occurrences[0] ?? '').split(separator).filter(value => value !== '')
    : occurrences;
  return values.map(value => clrTrim(String(value ?? '')));
}

const commaDelimitedStrings = (entries, key) => delimitedStrings(entries, key, ',');
const pipeDelimitedStrings = (entries, key) => delimitedStrings(entries, key, '|');

function collectionGuidValue(value) {
  const text = String(value ?? '');
  const dashed = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const d = new RegExp(`^${dashed}$`, 'iu').exec(text)
    ?? new RegExp(`^\\{${dashed}\\}$`, 'iu').exec(text)
    ?? new RegExp(`^\\(${dashed}\\)$`, 'iu').exec(text);
  if (d) return d[1].toLowerCase();
  const n = /^([0-9a-f]{32})$/iu.exec(text);
  if (n) return guid(n[1]);
  const space = `[${clrWhitespace}]*`;
  const hexValue = `0x${space}\\+?${space}([0-9a-f]+)`;
  const bytes = Array.from({ length: 8 }, () => hexValue).join(`${space},${space}`);
  const x = new RegExp(`^\\{${space}${hexValue}${space},${space}${hexValue}${space},${space}${hexValue}${space},${space}\\{${space}${bytes}${space}\\}${space}\\}$`, 'iu').exec(text);
  if (x) {
    const values = x.slice(1).map(part => BigInt(`0x${part}`));
    if (values.slice(0, 3).some(part => part > 0xffffffffn)
      || values.slice(3).some(part => part > 0xffn)) return undefined;
    values[1] &= 0xffffn;
    values[2] &= 0xffffn;
    const hex = (part, width) => part.toString(16).padStart(width, '0');
    const parts = [hex(values[0], 8), hex(values[1], 4), hex(values[2], 4),
      `${hex(values[3], 2)}${hex(values[4], 2)}`,
      values.slice(5).map(part => hex(part, 2)).join('')];
    return parts.join('-').toLowerCase();
  }
  return undefined;
}

function int32Value(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : undefined;
  const text = String(value).trim();
  const hexadecimal = /^(?:0x|#)([0-9a-f]+)$/iu.exec(text);
  if (hexadecimal) {
    let number = BigInt(`0x${hexadecimal[1]}`);
    if (number > 0xffffffffn) return undefined;
    if (number > 0x7fffffffn) number -= 0x100000000n;
    return Number(number);
  }
  if (!/^[+-]?\d+$/u.test(text)) return undefined;
  const number = BigInt(text);
  return number >= -2147483648n && number <= 2147483647n ? Number(number) : undefined;
}

export function parseQuery(input = {}, { allowNegativePaging = false } = {}) {
  const query = {};
  const entries = [...(input instanceof URLSearchParams ? input.entries() : Object.entries(input))];
  for (const [key, names] of [['sortby', itemSortNames], ['sortorder', sortOrderNames]]) {
    const values = enumCollection(entries, key, names);
    if (values.length) query[key] = values;
  }
  const videoTypeOccurrences = entries
    .filter(([name]) => name.toLowerCase() === 'videotypes')
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : [raw]);
  if (videoTypeOccurrences.length) {
    // CommaDelimitedCollectionModelBinder only splits a single query occurrence. With
    // repeated occurrences each value is converted independently and commas are retained.
    const candidates = videoTypeOccurrences.length === 1
      ? String(videoTypeOccurrences[0] ?? '').split(',').filter(value => value !== '')
      : videoTypeOccurrences;
    const parsed = candidates.map(videoTypeValue).filter(value => value !== undefined);
    // The native binder logs and drops conversion failures instead of adding model-state errors.
    if (parsed.length) query.videotypes = parsed;
  }
  const seriesStatusOccurrences = entries
    .filter(([name]) => name.toLowerCase() === 'seriesstatus')
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : [raw]);
  if (seriesStatusOccurrences.length) {
    const candidates = seriesStatusOccurrences.length === 1
      ? String(seriesStatusOccurrences[0] ?? '').split(',').filter(value => value !== '')
      : seriesStatusOccurrences;
    const parsed = candidates.map(seriesStatusValue).filter(value => value !== undefined);
    if (parsed.length) query.seriesstatuses = parsed;
  }
  const imageTypeOccurrences = entries
    .filter(([name]) => name.toLowerCase() === 'imagetypes')
    .flatMap(([, raw]) => Array.isArray(raw) ? raw : [raw]);
  if (imageTypeOccurrences.length) {
    const candidates = imageTypeOccurrences.length === 1
      ? String(imageTypeOccurrences[0] ?? '').split(',').filter(value => value !== '')
      : imageTypeOccurrences;
    const parsed = candidates.map(imageTypeValue).filter(value => value !== undefined);
    if (parsed.length) query.imagetypes = parsed;
  }
  for (const key of ['audiolanguages', 'subtitlelanguages']) {
    const parsed = commaDelimitedStrings(entries, key);
    if (parsed.length) query[key] = parsed;
  }
  const artists = pipeDelimitedStrings(entries, 'artists');
  if (artists.length) query.artists = artists;
  const albums = pipeDelimitedStrings(entries, 'albums');
  if (albums.length) query.albums = albums;
  const genres = pipeDelimitedStrings(entries, 'genres');
  if (genres.length) query.genres = genres;
  const studios = pipeDelimitedStrings(entries, 'studios');
  if (studios.length) query.studios = studios;
  for (const key of ['tags', 'officialratings']) {
    const parsed = pipeDelimitedStrings(entries, key);
    if (parsed.length) query[key] = parsed;
  }
  const personIds = commaDelimitedStrings(entries, 'personids')
    .map(collectionGuidValue).filter(value => value !== undefined);
  if (personIds.length) query.personids = personIds;
  const personTypes = commaDelimitedStrings(entries, 'persontypes');
  if (personTypes.length) query.persontypes = personTypes;
  for (const key of ['albumids', 'artistids', 'albumartistids', 'contributingartistids', 'excludeartistids', 'genreids', 'studioids']) {
    const parsed = commaDelimitedStrings(entries, key)
      .map(collectionGuidValue).filter(value => value !== undefined);
    if (parsed.length) query[key] = parsed;
  }
  const scalarValues = new Map();
  for (const [name, raw] of entries) {
    const key = name.toLowerCase();
    if (!bools.has(key) && !integers.has(key) && !doubles.has(key) && !strings.has(key)) continue;
    if (!scalarValues.has(key)) scalarValues.set(key, []);
    scalarValues.get(key).push(...(Array.isArray(raw) ? raw : [raw]));
  }
  const bindingErrors = {};
  const invalid = key => {
    const attempted = (scalarValues.get(key) ?? []).map(value => String(value ?? '')).join(',');
    bindingErrors[scalarNames[key] ?? key] = [`The value '${attempted}' is not valid.`];
  };
  const seenScalars = new Set();
  for (const [name, raw] of entries) {
    const key = name.toLowerCase();
    if (transport.has(key)) continue;
    if (['sortby', 'sortorder', 'videotypes', 'seriesstatus', 'imagetypes', 'audiolanguages', 'subtitlelanguages', 'albums', 'albumids', 'artists', 'artistids', 'albumartistids',
      'contributingartistids', 'excludeartistids', 'genreids', 'studioids', 'personids', 'persontypes',
      'genres', 'studios', 'tags', 'officialratings'].includes(key)) continue;
    if (key in arrays) {
      if (raw == null || raw === '') continue;
      query[key] = [...query[key] ?? [], ...(Array.isArray(raw) ? raw : String(raw).split(arrays[key]))].filter(value => value !== '');
    } else if (bools.has(key)) {
      if (seenScalars.has(key)) continue;
      seenScalars.add(key);
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value == null || typeof value === 'string' && value.trim() === '') continue;
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
      if (![true, false, 'true', 'false'].includes(normalized)) { invalid(key); continue; }
      query[key] = String(normalized).toLowerCase() === 'true';
    } else if (integers.has(key)) {
      if (seenScalars.has(key)) continue;
      seenScalars.add(key);
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value == null || typeof value === 'string' && value.trim() === '') continue;
      const number = int32Value(value);
      if (number === undefined) { invalid(key); continue; }
      query[key] = number;
    } else if (doubles.has(key)) {
      if (seenScalars.has(key)) continue;
      seenScalars.add(key);
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value == null || typeof value === 'string' && value.trim() === '') continue;
      const number = Number(typeof value === 'string' ? value.trim() : value);
      if (!Number.isFinite(number)) { invalid(key); continue; }
      query[key] = number;
    } else if (strings.has(key)) {
      if (seenScalars.has(key)) continue;
      seenScalars.add(key);
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value == null || String(value).trim() === '') continue;
      query[key] = String(value);
    }
    else if (raw != null && raw !== '') unsupported(`Item query parameter '${name}' is not implemented.`);
  }
  for (const key of ['parentid', 'userid', 'adjacentto']) if (query[key]) {
    try { query[key] = guid(query[key].trim()); }
    catch { delete query[key]; invalid(key); }
  }
  for (const key of ['ids', 'excludeitemids']) if (query[key]) query[key] = query[key].map(guid);
  for (const key of ['minpremieredate', 'maxpremieredate', 'mindatelastsaved', 'mindatelastsavedforuser']) if (query[key]) {
    const parsed = new Date(query[key]);
    if (!Number.isFinite(parsed.getTime())) { delete query[key]; invalid(key); }
    else query[key] = dateText(parsed.toISOString());
  }
  if (Object.keys(bindingErrors).length) {
    const error = new BindingError('', 'One or more validation errors occurred.');
    error.errors = bindingErrors;
    throw error;
  }
  // ItemsController removes the redundant half of this combination before
  // constructing InternalItemsQuery.
  if (query.subtitlelanguages?.length && query.hassubtitles !== undefined) {
    if (query.hassubtitles) delete query.hassubtitles;
    else delete query.subtitlelanguages;
  }
  for (const key of allowNegativePaging ? ['imagetypelimit'] : ['startindex', 'limit', 'imagetypelimit']) if (query[key] < 0) throw libraryError(400, `${key} must not be negative.`);
  // GetOrderBy returns early for an empty key collection. Otherwise its first
  // loop indexes each requested direction, and an excess direction throws.
  if (query.sortby?.length && query.sortorder?.length > query.sortby.length) {
    throw Object.assign(libraryError(400,
      "Index was out of range. Must be non-negative and less than the size of the collection. (Parameter 'index')"),
    { nativeException: 'ArgumentOutOfRangeException', parameterName: 'index' });
  }
  for (const filter of query.filters ?? []) {
    switch (filter.toLowerCase()) {
      case 'isfavorite': query.isfavorite = true; break;
      case 'isplayed': query.isplayed = true; break;
      case 'isunplayed': query.isplayed = false; break;
      case 'isresumable': query.isresumable = true; break;
      case 'isfolder': query.isfolder = true; break;
      case 'isnotfolder': query.isfolder = false; break;
      case 'likes': query.likes = true; break;
      case 'dislikes': query.likes = false; break;
      case 'isfavoriteorlikes': query.favoriteorlikes = true; break;
      default: unsupported(`Item filter '${filter}' is not implemented.`);
    }
  }
  const filterNames = (query.filters ?? []).map(filter => filter.toLowerCase());
  for (const pair of [['isplayed', 'isunplayed'], ['isfolder', 'isnotfolder'], ['likes', 'dislikes']]) if (pair.every(name => filterNames.includes(name))) throw libraryError(400, 'Conflicting filters.');
  return query;
}

export function hasFilters(query) {
  return Object.entries(query).some(([key, value]) =>
    !['userid', 'parentid', 'startindex', 'limit', 'recursive', 'collapseboxsetitems', 'sortby', 'sortorder', 'fields', 'enabletotalrecordcount', 'enableimages', 'enableuserdata', 'enableimagetypes', 'imagetypelimit', 'maxparentalrating'].includes(key)
    && !(key === 'albumids' && Array.isArray(value) && value.length === 0));
}

export function resolveOfficialRatingRanges(query, configuration = {}) {
  for (const [parameter, target] of [['minofficialrating', 'minparentalrating'], ['maxofficialrating', 'maxparentalrating']]) {
    if (!Object.hasOwn(query, parameter)) continue;
    const value = query[parameter];
    delete query[parameter];
    const score = getRatingScore(value, undefined, configuration.MetadataCountryCode);
    if (score !== null) query[target] = score;
  }
  return query;
}

const asciiLower = value => String(value ?? '').replace(/[A-Z]/g, character => character.toLowerCase());

export function binaryCompare(a, b) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  if (typeof a === 'string' && typeof b === 'string') return Buffer.compare(Buffer.from(a), Buffer.from(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortItems(items, query, userData, isPlayed, {
  memory = false,
  sortNameFor = item => item.SortName,
  memoryContext,
  repositorySortValue,
} = {}) {
  // Directions belong to original request positions. Removing Default before
  // pairing it with its direction would reverse a later Name ordering.
  const entries = (query.sortby ?? []).map((name, index) => {
    const direction = (query.sortorder?.[index] ?? query.sortorder?.[0] ?? 'Ascending').toLowerCase();
    // LibraryManager tests Descending; repository ApplyOrder tests Ascending.
    // Undefined numeric directions therefore differ between these two paths.
    return { name: name.toLowerCase(), column: sorts.get(name.toLowerCase()) ?? 'SortName',
      sign: memory ? (direction === 'descending' ? -1 : 1) : (direction === 'ascending' ? 1 : -1) };
  })
    .filter(entry => entry.name !== 'default');
  if (memory) return sortMemoryItems(items, entries, userData, isPlayed, sortNameFor, memoryContext);
  // Repository OrderMapper evaluates EF.Functions.Random once per row; this
  // is a separate path from LibraryManager's in-memory Shuffle branch.
  const randomKeys = entries.some(entry => entry.name === 'random')
    ? new Map(items.map(item => [item, randomBytes(8).readBigUInt64BE()])) : null;
  const key = (item, column) => {
    if (column === 'Random') return randomKeys.get(item);
    if (column.startsWith('repository:')) {
      if (!repositorySortValue) unsupported(`Repository sort '${column.slice(11)}' requires its query context.`);
      return repositorySortValue(item, column.slice(11), query);
    }
    if (column === '@Played') return isPlayed(item);
    if (column === '@Unplayed') return !isPlayed(item);
    if (column.startsWith('@')) return userData.get(idKey(item.Id))?.[column.slice(1)] ?? (column === '@IsFavorite' ? false : null);
    if (column === 'PremiereDate') return item.PremiereDate ?? (item.ProductionYear != null ? `${String(item.ProductionYear).padStart(4, '0')}-01-01 00:00:00` : null);
    if (column === 'CleanName') return repositoryCleanName(item);
    return repositoryValue(item, column);
  };
  const search = query.searchterm != null && query.searchterm !== '' ? query.searchterm : null;
  const relevance = item => {
    const clean = cleanValue(search), original = asciiLower(search), name = repositoryCleanName(item) ?? '', title = asciiLower(item.OriginalTitle);
    return name === clean || title === original ? 0 : name.startsWith(`${clean} `) || title.startsWith(`${original} `) ? 1 : name.startsWith(clean) || title.startsWith(original) ? 2 : 3;
  };
  return [...items].sort((a, b) => {
    if (search) { const score = relevance(a) - relevance(b); if (score) return score; }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const value = binaryCompare(key(a, entry.column), key(b, entry.column)) * entry.sign;
      if (value) return value;
      if (i === 0 && entry.name === 'sortname') { const name = binaryCompare(a.Name, b.Name) * entry.sign; if (name) return name; }
    }
    if (!search && (!entries.length || !entries.some(entry => ['sortname', 'name'].includes(entry.name)))) return binaryCompare(repositoryValue(a, 'SortName'), repositoryValue(b, 'SortName'));
    return 0;
  });
}
