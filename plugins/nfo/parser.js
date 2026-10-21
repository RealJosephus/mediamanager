import { domainToUnicode } from 'node:url';
import { cloneNativeItemValue } from '@mediamanager/plugin-sdk/library/native-item-value';
import { child, textOf, XmlError } from '@mediamanager/plugin-sdk/core/xml';
import { readXmlSteps } from '@mediamanager/plugin-sdk/core/xml-stream';
import { nfoConfiguration } from './configuration.js';
import { addPerson } from '@mediamanager/plugin-sdk/metadata/people';
import { trySetProviderId } from '@mediamanager/plugin-sdk/metadata/provider-ids';
import { parseSeriesStatus, parseAirDays } from '@mediamanager/plugin-sdk/metadata/television';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { parseInvariantDate } from '@mediamanager/plugin-sdk/core/invariant-date-parse';
import { parseInvariantDateExact } from '@mediamanager/plugin-sdk/core/invariant-date-format';
import { tryParseClrInt32Enum } from '@mediamanager/plugin-sdk/metadata/clr-enum';

// Ordered user-data imports capture runtime values, not the private SQL
// member branch. Copy proxy-backed dictionaries without acquiring link leases.
const privateItemFields = new Set(['LinkedChildren', 'LinkedChildrenLoaded', 'VirtualChildren']);
const userDataItemSnapshot = item => cloneNativeItemValue(Object.fromEntries(Object.entries(item)
  .filter(([field]) => !privateItemFields.has(field))));

const strings = {
  originaltitle: 'OriginalTitle', name: 'Name', title: 'Name', localtitle: 'Name', sortname: 'SortName', sorttitle: 'ForcedSortName',
  biography: 'Overview', plot: 'Overview', review: 'Overview', language: 'PreferredMetadataLanguage', countrycode: 'PreferredMetadataCountryCode',
  tagline: 'Tagline', mpaa: 'OfficialRating', customrating: 'CustomRating',
};
const fields = ['Cast', 'Genres', 'ProductionLocations', 'Studios', 'Tags', 'Name', 'Overview', 'Runtime', 'OfficialRating'];
const personKinds = ['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist',
  'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller',
  'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator'];
const defaultIds = ['Imdb', 'Tmdb', 'Tvdb', 'TvRage', 'Zap2It', 'MusicBrainzArtist', 'MusicBrainzAlbum', 'MusicBrainzAlbumArtist', 'MusicBrainzReleaseGroup', 'AudioDbArtist', 'AudioDbAlbum'];
const isVideo = (type) => ['Movie', 'Video', 'MusicVideo', 'Episode'].includes(type);
const videoParser = (type) => ['Movie', 'Video', 'MusicVideo'].includes(type);
const integer = (value) => value != null && /^\s*[+-]?\d+\s*$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : null;
const decimal = (value) => /^\d*(?:\.\d*)?$/.test(value) && /\d/.test(value) ? Math.fround(Number(value)) : null;
const add = (item, key, value) => { const list = item[key] ??= []; if (!list.some((entry) => entry.toLowerCase() === value.toLowerCase())) list.push(value); };
const setId = (item, key, value) => trySetProviderId(item, key, value);
const commonScalarNames = new Set([
  ...Object.keys(strings), 'dateadded', 'watched', 'playcount', 'lastplayed', 'lockedfields', 'country', 'runtime', 'aspectratio',
  'lockdata', 'studio', 'director', 'credits', 'writer', 'trailer', 'displayorder', 'year', 'rating', 'communityrating',
  'criticrating', 'aired', 'formed', 'premiered', 'releasedate', 'enddate', 'genre', 'style', 'tag', 'uniqueid', 'thumb',
]);

function parseDate(value, format) {
  return parseInvariantDateExact(value, format);
}

function providerLinks(text, type, item) {
  setId(item, 'Imdb', /tt[0-9]{7,8}/.exec(text)?.[0]);
  if (type === 'Movie') setId(item, 'Tmdb', /themoviedb\.org\/movie\/([0-9]+)/.exec(text)?.[1]);
  if (type === 'Series') {
    setId(item, 'Tmdb', /themoviedb\.org\/tv\/([0-9]+)/.exec(text)?.[1]);
    setId(item, 'Tvdb', /thetvdb\.com\/\?tab=series&id=([0-9]+)/.exec(text)?.[1]);
  }
}

function appendPerson(result, person) {
  if (!person.Name || !clrTrim(person.Name)) return;
  addPerson(result.People, person);
}

function metadataField(value) {
  return tryParseClrInt32Enum(value, fields, { ignoreCase: true });
}

function parseNode(node, result, context, readImage = readThumb) {
  const item = result.Item; const type = item.Type; const raw = node.text; const value = clrTrim(raw);
  if (context.seriesSeason) {
    if (node.name === 'namedseason' && integer(node.attributes.number) === item.IndexNumber && value) item.Name = raw;
    return;
  }
  if (Object.hasOwn(strings, node.name)) { item[strings[node.name]] = value; return; }
  if ((videoParser(type) || type === 'Series') && node.name === 'id') {
    setId(item, 'Tmdb', node.attributes.TMDB); setId(item, 'Tvdb', node.attributes.TVDB);
    setId(item, 'Imdb', node.attributes.IMDB || (raw.startsWith('tt') ? raw : null)); return;
  }
  if (type === 'Season' && node.name === 'seasonname') { item.Name = value; return; }
  if (type === 'Season' && node.name === 'seasonnumber') { if (integer(raw) != null) item.IndexNumber = integer(raw); return; }
  if (type === 'Episode') {
    const numbers = { season: 'ParentIndexNumber', episode: 'IndexNumber', episodenumberend: 'IndexNumberEnd', airsbefore_episode: 'AirsBeforeEpisodeNumber', displayepisode: 'AirsBeforeEpisodeNumber', airsafter_season: 'AirsAfterSeasonNumber', displayafterseason: 'AirsAfterSeasonNumber', airsbefore_season: 'AirsBeforeSeasonNumber', displayseason: 'AirsBeforeSeasonNumber' };
    if (Object.hasOwn(numbers, node.name)) { if (integer(raw) != null) item[numbers[node.name]] = integer(raw); return; }
    if (node.name === 'showtitle') { item.SeriesName = value; return; }
  }
  switch (node.name) {
    case 'set':
      if (type === 'Movie') { setId(item, 'TmdbCollection', node.attributes.tmdbcolid); item.TmdbCollectionName = value ? raw : textOf(node, 'name'); }
      break;
    case 'artist': if (type === 'MusicVideo' && value) (item.Artists ??= []).push(value); break;
    case 'album': if (type === 'MusicVideo' && value) item.Album = value; break;
    case 'airs_time': if (type === 'Series') item.AirTime = value; break;
    case 'airs_dayofweek': if (type === 'Series') item.AirDays = parseAirDays(raw); break;
    case 'status': if (type === 'Series') { const status = parseSeriesStatus(raw); if (status != null) item.Status = status; } break;
    case 'lockdata': item.IsLocked = raw.toLowerCase() === 'true'; break;
    case 'lockedfields': if (value) item.LockedFields = raw.split('|').map(metadataField).filter(field => field != null); break;
    case 'country': if (value) item.ProductionLocations = raw.split('/').map(clrTrim).filter(Boolean); break;
    case 'runtime': { const number = integer(raw.split(' ')[0]); if (number != null) item.RunTimeTicks = BigInt(number) * 600000000n; break; }
    case 'aspectratio': if (value && isVideo(type)) item.AspectRatio = value; break;
    case 'displayorder': if (value && type === 'Series') item.DisplayOrder = value; break;
    case 'studio': if (value) add(item, 'Studios', value); break;
    case 'genre': for (const entry of raw.split('/').map(clrTrim).filter(Boolean)) add(item, 'Genres', entry); break;
    case 'style': case 'tag': if (value) add(item, 'Tags', value); break;
    case 'year': if (integer(raw) > 1850) item.ProductionYear = integer(raw); break;
    case 'criticrating': if (value && Number.isFinite(Number(value.replaceAll(',', '')))) item.CriticRating = Math.fround(Number(value.replaceAll(',', ''))); break;
    case 'rating': case 'communityrating': { const number = decimal(raw.replaceAll(',', '.')); if (number != null && (node.name === 'rating' || number >= 0 && number <= 10)) item.CommunityRating = number; break; }
    case 'ratings':
      for (const rating of node.children.filter((entry) => entry.name === 'rating')) {
        const number = decimal(textOf(rating, 'value') ?? ''); const name = rating.attributes.name?.toLowerCase();
        if (number == null) continue;
        if (name?.includes('tomato') && !name.includes('audience')) { if (!name.includes('avg')) item.CriticRating = number; }
        else item.CommunityRating = number;
      }
      break;
    case 'aired': case 'formed': case 'premiered': case 'releasedate': case 'enddate': {
      const date = parseDate(raw, context.configuration.ReleaseDateFormat);
      if (date) { item[node.name === 'enddate' ? 'EndDate' : 'PremiereDate'] = date; if (node.name !== 'enddate') item.ProductionYear ??= Number(date.slice(0, 4)); }
      break;
    }
    case 'dateadded': { const date = parseInvariantDate(raw, { offsetMinutes: () => 0 }); if (date != null) item.DateCreated = date; break; }
    case 'uniqueid': if (node.attributes.type) setId(item, context.ids[node.attributes.type.toLowerCase()] ?? node.attributes.type, raw); break;
    case 'director': case 'writer': case 'credits': {
      const separator = node.name === 'credits' ? '/' : /[|;]/.test(raw) ? /[|;]/ : ',';
      for (const name of raw.split(separator).map(clrTrim).filter(Boolean)) appendPerson(result, { Name: name, Type: node.name === 'director' ? 'Director' : 'Writer' });
      break;
    }
    case 'actor': {
      const person = { Name: '', Type: 'Actor', Role: '', SortOrder: null, ImageUrl: null };
      for (const entry of node.children) {
        const key = { name: 'Name', Name: 'Name', role: 'Role', Role: 'Role', thumb: 'ImageUrl' }[entry.name];
        if (key) person[key] = clrTrim(entry.text);
        else if (['order', 'sortorder', 'SortOrder'].includes(entry.name)) person.SortOrder = integer(entry.text);
        else if (['type', 'Type'].includes(entry.name)) person.Type = tryParseClrInt32Enum(entry.text, personKinds, { ignoreCase: true }) ?? 'Unknown';
      }
      appendPerson(result, person); break;
    }
    case 'trailer': {
      const match = /^plugin:\/\/plugin\.video\.youtube\/(?:\?action=play_video&videoid=|play\/\?video_id=)(.*)$/i.exec(value);
      if (match) {
        const Url = 'https://www.youtube.com/watch?v=' + match[1];
        const trailers = item.RemoteTrailers ??= [];
        if (!trailers.some(trailer => trailer.Url.toLowerCase() === Url.toLowerCase())) trailers.push({ Url });
      }
      break;
    }
    case 'thumb': return readImage(node, result, context);
    case 'fanart': { const thumb = child(node, 'thumb'); if (thumb) return readImage(thumb, result, context, true); break; }
    case 'fileinfo':
      if (isVideo(type)) for (const stream of child(node, 'streamdetails')?.children ?? []) {
        if (stream.name === 'video') for (const entry of stream.children) {
          if (entry.name === 'aspect') item.AspectRatio = clrTrim(entry.text);
          if (entry.name === 'width' || entry.name === 'height' || entry.name === 'durationinseconds') {
            const number = integer(entry.text); if (number == null) throw new XmlError(`Invalid integer: ${entry.name}`);
            if (entry.name === 'durationinseconds') item.RunTimeTicks = BigInt(number) * 10000000n;
            else item[entry.name === 'width' ? 'Width' : 'Height'] = number;
          }
          if (entry.name === 'format3d') { const format = { HSBS: 'HalfSideBySide', HTAB: 'HalfTopAndBottom', FTAB: 'FullTopAndBottom', FSBS: 'FullSideBySide', MVC: 'MVC' }[entry.text.toUpperCase()]; if (format) item.Video3DFormat = format; }
        }
        if (stream.name === 'subtitle' && child(stream, 'language')) item.HasSubtitles = true;
      }
      break;
    case 'watched': {
      const normalized = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      if (!['true', 'false', '1', '0'].includes(normalized)) throw new XmlError('Invalid XML Boolean: watched');
      const entry = { field: 'Played', value: ['true', '1'].includes(normalized), item: userDataItemSnapshot(item) };
      result.UserDataImports.push(entry); return entry;
    }
    case 'playcount': if (integer(raw) != null) {
      const entry = { field: 'PlayCount', value: integer(raw), item: userDataItemSnapshot(item) };
      result.UserDataImports.push(entry); return entry;
    } break;
    case 'lastplayed': { const date = parseInvariantDate(raw, { offsetMinutes: () => 0 }); if (date != null) {
      const entry = { field: 'LastPlayedDate', value: date, item: userDataItemSnapshot(item) };
      result.UserDataImports.push(entry); return entry;
    } break; }
    default: if (context.ids[node.name.toLowerCase()]) setId(item, context.ids[node.name.toLowerCase()], raw);
  }
}

function localFile(info) {
  if (info == null || info.Exists === false) return false;
  if (info.kind != null) return info.kind === 'file';
  if (info.IsDirectory != null) return info.IsDirectory === false;
  if (typeof info.isFile === 'function') return info.isFile();
  return true;
}

const authoritySchemes = new Set(['ftp:', 'gopher:', 'http:', 'https:', 'ws:', 'wss:']);

function uncPath(value) {
  const match = /^[\\/]{2,}([^\\/]+)(?:[\\/].*)?$/u.exec(value);
  return match != null && match[1] !== '.' && match[1] !== '?';
}

function fileUriLocation(remainder) {
  const uriPath = remainder.split(/[?#]/u, 1)[0];
  const root = /^[\\/]+/u.exec(uriPath)?.[0] ?? '';
  const afterRoot = uriPath.slice(root.length);
  if (root.length >= 2) return !/^[A-Za-z][:|](?![\\/])/u.test(afterRoot);
  return /^[A-Za-z][:|][\\/]/u.test(afterRoot);
}

function imageLocation(value) {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return { local: true, remote: null };
  if (/^[\\/]{2,}/u.test(value)) return uncPath(value) ? { local: true, remote: null } : null;
  // System.Uri treats a drive-relative Windows path as invalid rather than as
  // an opaque one-letter URI scheme.
  if (/^[A-Za-z]:/u.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value);
  if (!scheme) return null;
  const protocol = `${scheme[1].toLowerCase()}:`;
  const remainder = value.slice(scheme[0].length);
  if (protocol === 'file:') return fileUriLocation(remainder) ? { local: true, remote: null } : null;
  const hasAuthority = remainder.startsWith('//');
  if (authoritySchemes.has(protocol) && (!hasAuthority || remainder[2] === '/' || remainder[2] === '\\')) return null;
  if (hasAuthority) {
    const afterSlashes = remainder.slice(2);
    const end = afterSlashes.search(/[/?#]/u);
    const authority = afterSlashes.slice(0, end < 0 ? undefined : end);
    if (authority.includes('\\') || authoritySchemes.has(protocol) && authority === '') return null;
  } else if (remainder.startsWith('\\')) return null;
  let uri;
  try { uri = new URL(value); } catch { return null; }
  return { local: uri.protocol === 'file:', remote: uri, source: value };
}

function iriUcsChar(codePoint) {
  if (codePoint >= 0xa0 && codePoint <= 0xd7ff) return true;
  if (codePoint >= 0xf900 && codePoint <= 0xfdcf) return true;
  if (codePoint >= 0xfdf0 && codePoint <= 0xffef) return true;
  if (codePoint >= 0x10000 && codePoint <= 0xdfffd) return codePoint % 0x10000 <= 0xfffd;
  return codePoint >= 0xe1000 && codePoint <= 0xefffd;
}

function iriPrivate(codePoint) {
  return codePoint >= 0xe000 && codePoint <= 0xf8ff
    || codePoint >= 0xf0000 && codePoint <= 0xffffd
    || codePoint >= 0x100000 && codePoint <= 0x10fffd;
}

function asciiUnreserved(codePoint) {
  return codePoint >= 0x30 && codePoint <= 0x39 || codePoint >= 0x41 && codePoint <= 0x5a
    || codePoint >= 0x61 && codePoint <= 0x7a || [0x2d, 0x2e, 0x5f, 0x7e].includes(codePoint);
}

function displayAscii(codePoint) {
  return asciiUnreserved(codePoint) || codePoint === 0x20 || codePoint === 0x22
    || codePoint === 0x3c || codePoint === 0x3e || codePoint === 0x5e || codePoint === 0x60
    || codePoint >= 0x7b && codePoint <= 0x7d;
}

function utf8Escape(value, offset, first) {
  const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3
    : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
  const encoded = value.slice(offset, offset + width * 3);
  if (!width || encoded.length !== width * 3 || !/^(?:%[0-9A-F]{2})+$/iu.test(encoded)) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return { decoded, encoded, codePoint: decoded.codePointAt(0) };
  } catch { return null; }
}

function userinfoDisplayMode(value) {
  for (let offset = 0; offset < value.length; offset++) {
    if (value[offset] !== '%' || !/^[0-9A-F]{2}$/iu.test(value.slice(offset + 1, offset + 3))) continue;
    const first = Number.parseInt(value.slice(offset + 1, offset + 3), 16);
    if (asciiUnreserved(first)) return true;
    const escaped = utf8Escape(value, offset, first);
    if (escaped && iriUcsChar(escaped.codePoint)) return true;
  }
  return false;
}

function displayEscapes(value, component) {
  const displayUserInfo = component === 'userinfo' && userinfoDisplayMode(value);
  let result = '';
  for (let offset = 0; offset < value.length;) {
    if (value[offset] !== '%' || !/^[0-9A-F]{2}$/i.test(value.slice(offset + 1, offset + 3))) {
      result += value[offset] === '%' && component !== 'userinfo' ? '%25' : value[offset];
      offset++;
      continue;
    }
    const first = Number.parseInt(value.slice(offset + 1, offset + 3), 16);
    if (asciiUnreserved(first) || displayAscii(first) && (component !== 'userinfo' || displayUserInfo)) {
      result += String.fromCharCode(first); offset += 3; continue;
    }
    const escaped = utf8Escape(value, offset, first);
    if (escaped && (iriUcsChar(escaped.codePoint) || component === 'query' && iriPrivate(escaped.codePoint))) {
      result += escaped.decoded; offset += escaped.encoded.length; continue;
    }
    result += value.slice(offset, offset + 3); offset += 3;
  }
  return result;
}

function authorityDelimiters(source) {
  const input = source.trim();
  const schemeAt = input.indexOf(':');
  if (schemeAt < 0 || input.slice(schemeAt + 1, schemeAt + 3) !== '//') return { hasUserInfo: false, hasPassword: false };
  const authorityStart = schemeAt + 3;
  const authorityEnd = input.slice(authorityStart).search(/[/?#]/);
  const authority = input.slice(authorityStart, authorityEnd < 0 ? undefined : authorityStart + authorityEnd);
  const userInfoEnd = authority.lastIndexOf('@');
  if (userInfoEnd < 0) return { hasUserInfo: false, hasPassword: false };
  return { hasUserInfo: true, hasPassword: authority.slice(0, userInfoEnd).includes(':') };
}

function remoteUri(uri, source) {
  // System.Uri.ToString() uses a Unicode display host and selectively
  // unescapes spaces and UTF-8 characters while retaining escaped ASCII
  // delimiters such as brackets, percent, slash and hash.
  const href = uri.href;
  const hashAt = href.indexOf('#');
  const queryAt = href.indexOf('?');
  const hasQuery = queryAt >= 0 && (hashAt < 0 || queryAt < hashAt);
  const hasFragment = hashAt >= 0;
  const hierarchical = href.startsWith(`${uri.protocol}//`);
  const authority = authorityDelimiters(source);
  let result = uri.protocol;
  if (hierarchical) {
    result += '//';
    if (authority.hasUserInfo || uri.username || uri.password) {
      result += displayEscapes(uri.username, 'userinfo');
      if (authority.hasPassword || uri.password) result += `:${displayEscapes(uri.password, 'userinfo')}`;
      result += '@';
    }
    result += uri.hostname.startsWith('[') ? uri.hostname : domainToUnicode(uri.hostname) || uri.hostname;
    if (uri.port) result += `:${uri.port}`;
  }
  result += displayEscapes(uri.pathname, hierarchical ? 'path' : 'opaque');
  if (hasQuery) result += `?${displayEscapes(uri.search.slice(1), 'query')}`;
  if (hasFragment) result += `#${displayEscapes(uri.hash.slice(1), 'fragment')}`;
  return result;
}

function canAddLocal(result, Type) {
  return !(result.Images.some(image => image.Type === Type)
    || result.LocalImageCandidates.some(image => image.Type === Type));
}

function readThumb(node, result, context, fanart = false) {
  const aspect = node.attributes.aspect?.trim() ? node.attributes.aspect : fanart ? 'fanart' : 'poster';
  if (!node.text || aspect.includes('.')) return;
  const Type = { banner: 'Banner', clearlogo: 'Logo', discart: 'Disc', landscape: 'Thumb', clearart: 'Art', fanart: 'Backdrop' }[aspect] ?? 'Primary';
  const location = imageLocation(node.text); if (!location) return;
  if (!location.local) {
    if (!result.RemoteImages.some(image => image.Type === Type)) result.RemoteImages.push({ Url: remoteUri(location.remote, location.source), Type });
    return;
  }
  if (!context.localImageStat) { result.LocalImageCandidates.push({ Url: node.text, Type }); return; }
  if (!canAddLocal(result, Type)) return;
  const info = context.localImageStat(node.text);
  if (info && typeof info.then === 'function') throw new TypeError('parseNfo localImageStat must be synchronous.');
  if (localFile(info)) result.LocalImageCandidates.push({ Url: node.text, Type });
}

async function readThumbAsync(node, result, context, fanart = false) {
  const aspect = node.attributes.aspect?.trim() ? node.attributes.aspect : fanart ? 'fanart' : 'poster';
  if (!node.text || aspect.includes('.')) return;
  const Type = { banner: 'Banner', clearlogo: 'Logo', discart: 'Disc', landscape: 'Thumb', clearart: 'Art', fanart: 'Backdrop' }[aspect] ?? 'Primary';
  const location = imageLocation(node.text); if (!location) return;
  if (!location.local) {
    if (!result.RemoteImages.some(image => image.Type === Type)) result.RemoteImages.push({ Url: remoteUri(location.remote, location.source), Type });
    return;
  }
  if (!context.localImageStat) { result.LocalImageCandidates.push({ Url: node.text, Type }); return; }
  if (!canAddLocal(result, Type)) return;
  const info = await context.localImageStat(node.text);
  if (localFile(info)) result.LocalImageCandidates.push({ Url: node.text, Type });
}

function createResult(type, item, indexNumber, images = [], remoteImages = [], localImageCandidates = []) {
  return { HasMetadata: true, Item: item ?? { Type: type, Id: '00000000-0000-0000-0000-000000000000', ProviderIds: {},
    ...(indexNumber == null ? {} : { IndexNumber: indexNumber }) },
    People: [], Images: images, RemoteImages: remoteImages, LocalImageCandidates: localImageCandidates, UserDataImports: [] };
}

function createContext(configuration, externalIds, seriesSeason, localImageStat) {
  const ids = Object.fromEntries(externalIds.map((key) => [(key + 'Id').toLowerCase(), key]));
  Object.assign(ids, { collectionnumber: 'TmdbCollection', tmdbcolid: 'TmdbCollection', tmdbcol: 'TmdbCollection', imdb_id: 'Imdb' });
  return { configuration: nfoConfiguration(configuration), ids, seriesSeason, localImageStat };
}

function isScalarNode(name, context, type) {
  if (context.seriesSeason) return name === 'namedseason';
  if (commonScalarNames.has(name) || Object.hasOwn(context.ids, name.toLowerCase())) return true;
  if (videoParser(type) && ['id', 'artist', 'album'].includes(name)) return true;
  if (type === 'Series' && ['id', 'airs_time', 'airs_dayofweek', 'status'].includes(name)) return true;
  if (type === 'Season' && ['seasonname', 'seasonnumber'].includes(name)) return true;
  return type === 'Episode' && ['season', 'episode', 'episodenumberend', 'airsbefore_episode', 'displayepisode',
    'airsafter_season', 'displayafterseason', 'airsbefore_season', 'displayseason', 'showtitle'].includes(name);
}

function parseStreamingStep(step, result, context, readImage = readThumb) {
  const item = result.Item;
  if (step.type === 'fanart-thumb') {
    return readImage(step.node, result, context, true);
  }
  if (step.type === 'set-name') {
    if (item.Type === 'Movie') item.TmdbCollectionName = step.value;
    return;
  }
  if (step.type === 'rating') {
    const number = decimal(step.value);
    if (number == null) return;
    const name = step.name?.toLowerCase();
    if (name?.includes('tomato') && !name.includes('audience')) {
      if (!name.includes('avg')) item.CriticRating = number;
    } else item.CommunityRating = number;
    return;
  }
  if (step.type === 'subtitle-language') {
    if (isVideo(item.Type)) item.HasSubtitles = true;
    return;
  }
  if (step.type !== 'video-field' || !isVideo(item.Type)) return;
  if (step.name === 'aspect') item.AspectRatio = clrTrim(step.value);
  else if (step.name === 'width' || step.name === 'height' || step.name === 'durationinseconds') {
    const number = integer(step.value);
    if (number == null) throw new XmlError(`Invalid integer: ${step.name}`);
    if (step.name === 'durationinseconds') item.RunTimeTicks = BigInt(number) * 10000000n;
    else item[step.name === 'width' ? 'Width' : 'Height'] = number;
  } else if (step.name === 'format3d') {
    const format = { HSBS: 'HalfSideBySide', HTAB: 'HalfTopAndBottom', FTAB: 'FullTopAndBottom', FSBS: 'FullSideBySide', MVC: 'MVC' }[step.value.toUpperCase()];
    if (format) item.Video3DFormat = format;
  }
}

function precommitNodeStart(step, result, context) {
  if (context.seriesSeason) return;
  const item = result.Item; const type = item.Type;
  if ((videoParser(type) || type === 'Series') && step.name === 'id') {
    setId(item, 'Tmdb', step.attributes.TMDB);
    setId(item, 'Tvdb', step.attributes.TVDB);
  } else if (type === 'Movie' && step.name === 'set') setId(item, 'TmdbCollection', step.attributes.tmdbcolid);
}

function xmlStepOptions(context, type, observeTraversal = false) {
  const baseParser = !context.seriesSeason;
  return {
    scalarNames: name => isScalarNode(name, context, type),
    streamActor: baseParser,
    streamRatings: baseParser,
    streamFileInfo: baseParser,
    streamVideoFields: baseParser && isVideo(type),
    streamFanart: baseParser,
    streamMovieSet: baseParser && type === 'Movie',
    streamTraversal: type === 'Episode' || observeTraversal,
  };
}

function readBlock(text, target, context, signal) {
  const steps = readXmlSteps(text, xmlStepOptions(context, target.Item.Type, signal != null));
  while (true) {
    const next = steps.next(); if (next.done) break;
    signal?.throwIfAborted();
    const step = next.value;
    if (step.type === 'start') precommitNodeStart(step, target, context);
    else if (step.type === 'node') parseNode(step.node, target, context);
    else parseStreamingStep(step, target, context);
  }
}

async function readBlockAsync(text, target, context, signal, onUserDataImport) {
  const steps = readXmlSteps(text, xmlStepOptions(context, target.Item.Type, signal != null));
  while (true) {
    const next = steps.next(); if (next.done) break;
    signal?.throwIfAborted();
    const step = next.value;
    if (step.type === 'start') precommitNodeStart(step, target, context);
    else if (step.type === 'node') {
      const entry = ['thumb', 'fanart'].includes(step.node.name)
        ? await parseNode(step.node, target, context, readThumbAsync)
        : parseNode(step.node, target, context);
      // The deferred import list keeps the point-in-time item snapshot, while
      // the native streaming parser saves against and rehydrates its live item.
      if (entry && onUserDataImport) await onUserDataImport({ ...entry, item: target.Item });
    } else if (step.type === 'fanart-thumb') await parseStreamingStep(step, target, context, readThumbAsync);
    else parseStreamingStep(step, target, context);
  }
}

function readEpisodeBlock(text, target, context, signal) {
  const steps = readXmlSteps(text, xmlStepOptions(context, 'Episode'));
  let first = true;
  while (true) {
    if (!first) signal?.throwIfAborted();
    const next = steps.next();
    if (next.done) break;
    signal?.throwIfAborted();
    const step = next.value;
    if (step.type === 'start') precommitNodeStart(step, target, context);
    else if (step.type === 'node') parseNode(step.node, target, context);
    else parseStreamingStep(step, target, context);
    first = false;
  }
}

async function readEpisodeBlockAsync(text, target, context, signal, onUserDataImport) {
  const steps = readXmlSteps(text, xmlStepOptions(context, 'Episode'));
  let first = true;
  while (true) {
    if (!first) signal?.throwIfAborted();
    const next = steps.next();
    if (next.done) break;
    signal?.throwIfAborted();
    const step = next.value;
    if (step.type === 'start') precommitNodeStart(step, target, context);
    else if (step.type === 'node') {
      const entry = ['thumb', 'fanart'].includes(step.node.name)
        ? await parseNode(step.node, target, context, readThumbAsync)
        : parseNode(step.node, target, context);
      if (entry && onUserDataImport) await onUserDataImport({ ...entry, item: target.Item });
    } else if (step.type === 'fanart-thumb') await parseStreamingStep(step, target, context, readThumbAsync);
    else parseStreamingStep(step, target, context);
    first = false;
  }
}

function episodeBlocks(xml) {
  const blocks = []; const closing = /<\/episodedetails>/gi;
  let start = 0, match;
  while ((match = closing.exec(xml))) { blocks.push(xml.slice(start, closing.lastIndex)); start = closing.lastIndex; }
  return blocks.length ? blocks : [xml];
}

function mergeEpisodes(result, episodes) {
  for (const key of ['Name', 'OriginalTitle', 'Overview']) result.Item[key] ??= '';
  for (const episode of episodes.slice(1)) {
    for (const key of ['Name', 'OriginalTitle', 'Overview']) if (episode.Item[key]) result.Item[key] += ' / ' + episode.Item[key];
    if (episode.Item.IndexNumber != null) result.Item.IndexNumberEnd = Math.max(episode.Item.IndexNumber, result.Item.IndexNumberEnd ?? episode.Item.IndexNumber);
  }
}

function parseEpisode(xml, result, context, signal) {
  const blocks = episodeBlocks(xml);
  try {
    if (blocks.length === 1) readEpisodeBlock(blocks[0], result, context, signal);
    else {
      const episodes = blocks.map(block => {
        const parsed = createResult('Episode'); readEpisodeBlock(block, parsed, context, signal); return { block, parsed };
      }).sort((left, right) => (left.parsed.Item.IndexNumber ?? 2147483647) - (right.parsed.Item.IndexNumber ?? 2147483647));
      readEpisodeBlock(episodes[0].block, result, context, signal);
      mergeEpisodes(result, episodes.map(entry => entry.parsed));
    }
  } catch (error) { if (!(error instanceof XmlError)) throw error; result.ParseWarning = error.message; }
  return result;
}

async function parseEpisodeAsync(xml, result, context, signal, onUserDataImport) {
  const blocks = episodeBlocks(xml);
  try {
    if (blocks.length === 1) await readEpisodeBlockAsync(blocks[0], result, context, signal, onUserDataImport);
    else {
      const episodes = [];
      for (const block of blocks) {
        const parsed = createResult('Episode');
        await readEpisodeBlockAsync(block, parsed, context, signal, onUserDataImport);
        episodes.push({ block, parsed });
      }
      episodes.sort((left, right) => (left.parsed.Item.IndexNumber ?? 2147483647) - (right.parsed.Item.IndexNumber ?? 2147483647));
      await readEpisodeBlockAsync(episodes[0].block, result, context, signal, onUserDataImport);
      mergeEpisodes(result, episodes.map(entry => entry.parsed));
    }
  } catch (error) { if (!(error instanceof XmlError)) throw error; result.ParseWarning = error.message; }
  return result;
}

function partialDocument(xml, type, result, seriesSeason) {
  if (!(videoParser(type) || type === 'Series' || seriesSeason)) return { xml, swallow: false, parse: true };
  const closing = xml.lastIndexOf('</'); const end = closing < 0 ? -1 : xml.indexOf('>', closing);
  providerLinks(end < 0 ? xml : xml.slice(end + 1), type, result.Item);
  return end < 0 ? { xml, swallow: true, parse: false } : { xml: xml.slice(0, end + 1), swallow: true, parse: true };
}

export function parseNfo(xml, { type = 'Movie', item, indexNumber, seriesSeason = false, configuration, externalIds = defaultIds,
  signal, images, remoteImages, localImageCandidates, localImageStat } = {}) {
  const result = createResult(type, item, indexNumber, images, remoteImages, localImageCandidates);
  const context = createContext(configuration, externalIds, seriesSeason, localImageStat);
  if (type === 'Episode') return parseEpisode(xml, result, context, signal);
  const document = partialDocument(xml, type, result, seriesSeason);
  if (!document.parse) return result;
  try { readBlock(document.xml, result, context, signal); }
  catch (error) {
    if (!document.swallow || !(error instanceof XmlError)) throw error;
    result.ParseWarning = error.message;
  }
  return result;
}

export async function parseNfoAsync(xml, { type = 'Movie', item, indexNumber, seriesSeason = false, configuration,
  externalIds = defaultIds, signal, onUserDataImport, images, remoteImages, localImageCandidates, localImageStat } = {}) {
  const result = createResult(type, item, indexNumber, images, remoteImages, localImageCandidates);
  const context = createContext(configuration, externalIds, seriesSeason, localImageStat);
  if (type === 'Episode') {
    await parseEpisodeAsync(xml, result, context, signal, onUserDataImport);
    if (onUserDataImport) result.UserDataImportsApplied = true;
    return result;
  }
  const document = partialDocument(xml, type, result, seriesSeason);
  if (!document.parse) return result;
  try { await readBlockAsync(document.xml, result, context, signal, onUserDataImport); }
  catch (error) {
    if (!document.swallow || !(error instanceof XmlError)) throw error;
    result.ParseWarning = error.message;
  }
  if (onUserDataImport) result.UserDataImportsApplied = true;
  return result;
}
