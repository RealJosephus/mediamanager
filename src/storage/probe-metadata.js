import { clrTrim } from '../metadata/whitespace.js';
import { trySetProviderId } from '../metadata/provider-ids.js';
import { ordinalIgnoreCaseEquals } from './ordinal-comparer.js';
import { cloneNativeItemEntity } from '../library/native-item-entity.js';

const empty = value => value == null || typeof value === 'string' && clrTrim(value).length === 0;
const distinct = values => values.filter((value, index) => !values.slice(0, index).some(other => ordinalIgnoreCaseEquals(value, other)));

function splitCustomTag(value, options) {
  let remainder = value;
  const result = [];
  for (const whitelist of options.DelimiterWhitelist ?? []) {
    if (typeof whitelist !== 'string' || !clrTrim(whitelist)) continue;
    const pattern = new RegExp(whitelist.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
    if (pattern.test(remainder)) {
      result.push(whitelist);
      remainder = remainder.replace(pattern, '');
    }
  }
  let parts = [remainder];
  for (const delimiter of options.CustomTagDelimiters ?? []) {
    if (typeof delimiter === 'string' && [...delimiter].length === 1) parts = parts.flatMap(part => part.split(delimiter));
  }
  return [...result, ...parts.map(clrTrim).filter(Boolean)];
}

function tagValues(value, options, custom = true) {
  if (typeof value !== 'string' || value.length === 0) return [];
  let values = value.split('\u001f');
  if (custom && options.UseCustomTagDelimiters) values = values.flatMap(entry => splitCustomTag(entry, options));
  return distinct(values.map(clrTrim).filter(Boolean));
}

function replayGain(value) {
  if (typeof value !== 'string') return null;
  if (/db$/iu.test(value)) value = value.slice(0, -2).trim();
  else value = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return null;
  const result = Math.fround(Number(value));
  return Number.isFinite(result) ? result : null;
}

function fallbackAudioTags(info) {
  const provider = key => info.ProviderIds?.[key] ?? null;
  return {
    Title: info.Name, Album: info.Album, AlbumArtist: (info.AlbumArtists ?? []).join('\u001f'), Artist: (info.Artists ?? []).join('\u001f'),
    Composer: (info.People ?? []).filter(person => person.Type === 'Composer').map(person => person.Name).join('\u001f') || null,
    Genre: (info.Genres ?? []).join('\u001f'), Date: info.PremiereDate, Description: info.Overview, Comment: null,
    Publisher: (info.Studios ?? [])[0] ?? null, NonstandardAlbumArtists: null, NonstandardArtists: null,
    ReplayGainTrack: null, ReplayGainAlbum: null, MusicBrainzArtist: provider('MusicBrainzArtist'),
    MusicBrainzAlbumArtist: provider('MusicBrainzAlbumArtist'), MusicBrainzAlbum: provider('MusicBrainzAlbum'),
    MusicBrainzReleaseGroup: provider('MusicBrainzReleaseGroup'), MusicBrainzTrack: provider('MusicBrainzTrack'),
    MusicBrainzRecording: provider('MusicBrainzRecording'), Ufid: null,
  };
}

function addPerson(people, source) {
  if (empty(source.Name)) return;
  const person = { Name: clrTrim(source.Name), Type: source.Type, Role: source.Role ?? null };
  if (!people.some(entry => ordinalIgnoreCaseEquals(entry.Name, person.Name) && entry.Type === person.Type
    && ordinalIgnoreCaseEquals(entry.Role ?? '', person.Role ?? ''))) people.push(person);
}

function applyAudioMetadata(loaded, item, info, replace, locked) {
  const tags = info.AudioTags ?? fallbackAudioTags(info);
  const options = loaded.libraryOptions ?? {};
  const title = clrTrim((tags.Title == null ? info.Name : tags.Title) ?? '').split('\0')[0];
  if (!locked('Name') && title) item.Name = title;
  const album = clrTrim((tags.Album == null ? info.Album : tags.Album) ?? '').split('\0')[0] || null;
  for (const [key, value] of [['Album', album], ['IndexNumber', info.IndexNumber], ['ParentIndexNumber', info.ParentIndexNumber]]) {
    if (replace || item[key] == null) item[key] = value;
  }

  const tagYear = tags.Date && /^\d{4}/u.test(tags.Date) ? Number(tags.Date.slice(0, 4)) : null;
  const year = tagYear || info.ProductionYear;
  if (tags.Date) item.PremiereDate = tags.Date;
  if (year != null) {
    item.ProductionYear = year;
    if (item.PremiereDate == null && year > 0 && year <= 9999) item.PremiereDate = `${String(year).padStart(4, '0')}-01-01T00:00:00Z`;
  }

  let people;
  if (!locked('Cast') && ['Audio', 'AudioBook'].includes(item.Type)) {
    const albumSource = options.PreferNonstandardArtistsTag && tags.NonstandardAlbumArtists != null ? tags.NonstandardAlbumArtists : tags.AlbumArtist;
    const artistSource = options.PreferNonstandardArtistsTag && tags.NonstandardArtists != null ? tags.NonstandardArtists : tags.Artist;
    let albumArtists = tagValues(albumSource, options);
    const performers = tagValues(artistSource, options);
    const composers = tagValues(tags.Composer, options, false);
    people = [];
    if (item.Type === 'AudioBook') {
      const authors = albumArtists.length ? albumArtists : performers;
      for (const Name of authors) addPerson(people, { Name, Type: 'Author' });
      for (const Name of composers) addPerson(people, { Name, Type: 'Narrator' });
      for (const Name of performers) if (!authors.some(author => ordinalIgnoreCaseEquals(author, Name))) addPerson(people, { Name, Type: 'Actor' });
    } else {
      for (const Name of albumArtists) addPerson(people, { Name, Type: 'AlbumArtist' });
      for (const Name of performers) addPerson(people, { Name, Type: 'Artist' });
      for (const Name of composers) addPerson(people, { Name, Type: 'Composer' });
    }
    if (replace && performers.length || !replace && !item.Artists?.length) item.Artists = performers;
    if (!albumArtists.length) albumArtists = performers;
    if (replace && albumArtists.length || !replace && !item.AlbumArtists?.length) item.AlbumArtists = albumArtists;
  }

  if (!locked('Genres')) {
    const genres = tagValues(tags.Genre, options);
    if (replace || !item.Genres?.length || item.Genres.every(empty)) item.Genres = genres;
  }
  if (item.Type === 'AudioBook') {
    if (!locked('Overview')) {
      const overview = !empty(tags.Description) ? clrTrim(tags.Description) : !empty(tags.Comment) ? clrTrim(tags.Comment) : null;
      if (overview && (replace || empty(item.Overview))) item.Overview = overview;
    }
    if (!empty(tags.Publisher) && (replace || !item.Studios?.length)) item.Studios = [clrTrim(tags.Publisher)];
  }

  const gain = replayGain(tags.ReplayGainTrack);
  if (gain != null) item.NormalizationGain = gain;

  const hasProvider = name => Object.keys(item.ProviderIds ?? {}).some(key => ordinalIgnoreCaseEquals(key, name));
  const firstId = value => {
    const first = typeof value === 'string' ? value.split('\u001f')[0] : null;
    return options.UseCustomTagDelimiters ? tagValues(first, options)[0] ?? null : first;
  };
  for (const name of ['MusicBrainzArtist', 'MusicBrainzAlbumArtist', 'MusicBrainzAlbum', 'MusicBrainzReleaseGroup', 'MusicBrainzTrack']) {
    if (replace || !hasProvider(name)) trySetProviderId(item, name, firstId(tags[name]));
  }
  if (replace || !hasProvider('MusicBrainzRecording')) {
    let recording = tags.MusicBrainzRecording;
    if (empty(recording) && typeof tags.Ufid === 'string') {
      const parts = tags.Ufid.split('\0');
      if (parts.length === 2 && /musicbrainz\.org/iu.test(parts[0])) recording = parts[1];
    }
    trySetProviderId(item, 'MusicBrainzRecording', recording);
  }
  return people;
}

function timeSpan(value) {
  value = clrTrim(value);
  const negative = value.startsWith('-'); if (negative) value = value.slice(1);
  const valid = (days, hours = '0', minutes = '0', seconds = '0', fraction = '') => {
    if (![days, hours, minutes, seconds].every(value => /^\d+$/u.test(value)) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59 || Number(fraction || 0) > 9999999) return false;
    const ticks = ((BigInt(days) * 24n + BigInt(hours)) * 3600n + BigInt(minutes) * 60n + BigInt(seconds)) * 10000000n + BigInt((fraction + '0000000').slice(0, 7));
    return ticks <= (negative ? 9223372036854775808n : 9223372036854775807n);
  };
  if (/^\d+$/u.test(value)) return valid(value);
  const match = /^(?:(\d+)\.)?(\d+):(\d+)(?::(\d+))?(?:\.(\d+))?$/u.exec(value);
  if (match && valid(match[1] ?? '0', match[2], match[3], match[4] ?? '0', match[5])) return true;
  const parts = /^(\d+):(\d+):(\d+)(?::(\d+))?(?:\.(\d+))?$/u.exec(value);
  return Boolean(parts && valid(parts[1], parts[2], parts[3], parts[4] ?? '0', parts[5]));
}

export function applyProbeMetadata(loaded, info, { replaceAllMetadata = false } = {}) {
  const item = cloneNativeItemEntity(loaded.item), replace = replaceAllMetadata;
  const locked = name => item.IsLocked || (item.LockedFields ?? []).includes(name);
  let people;
  if (item.MediaType === 'Audio') {
    if (!item.IsLocked) people = applyAudioMetadata(loaded, item, info, replace, locked);
  } else {
    for (const key of ['OfficialRating', 'Overview']) if (!locked(key) && (empty(item[key]) || replace)) item[key] = info[key];
    for (const key of ['Genres', 'Studios']) if (!locked(key) && (!item[key]?.length || replace)) item[key] = distinct((info[key] ?? []).map(clrTrim).filter(Boolean));
    if (!item.IsLocked && item.Type === 'MusicVideo') {
      if (!item.Album || replace) item.Album = info.Album;
      if (!item.Artists?.length || replace) item.Artists = info.Artists;
    }
    if (item.ExtraType == null) for (const key of ['ProductionYear', 'PremiereDate']) if (info[key] != null && (item[key] == null || replace)) item[key] = info[key];
    for (const key of ['IndexNumber', 'ParentIndexNumber']) if (info[key] != null && (item[key] == null || replace)) item[key] = info[key];
    if (!locked('Name')) {
      if (!empty(info.Name) && loaded.libraryOptions.EnableEmbeddedTitles && (item.ExtraType == null || loaded.libraryOptions.EnableEmbeddedExtrasTitles)) item.Name = info.Name;
      if (!empty(info.ForcedSortName)) item.ForcedSortName = info.ForcedSortName;
    }
    if (item.ExtraType == null && item.PremiereDate != null && item.ProductionYear == null) item.ProductionYear = Number(item.PremiereDate.slice(0, 4));
    if (!locked('Cast') && info.People.length && (replace || !loaded.context.people.length)) {
      people = [];
      for (const source of info.People) {
        if (empty(source.Name)) continue;
        const person = { ...source, Name: clrTrim(source.Name), Role: source.Role == null ? null : clrTrim(source.Role) };
        if (!people.some(entry => ordinalIgnoreCaseEquals(entry.Name, person.Name) && entry.Type === person.Type && ordinalIgnoreCaseEquals(entry.Role ?? '', person.Role ?? ''))) people.push(person);
      }
    }
    item.Video3DFormat ??= info.Video3DFormat;
  }
  return { Item: item, People: people };
}

export function normalizeProbeChapters(chapters, { runtime = null, dummyChapterDuration = 0, hasVideo = false, localization, mode = 'Default' } = {}) {
  if (!['Default', 'FullRefresh'].includes(mode)) return null;
  if (dummyChapterDuration > 0 && chapters.length <= 1 && hasVideo) {
    runtime = BigInt(runtime ?? 0);
    if (runtime < 0n || runtime > 432000000000n) throw new RangeError('The video runtime is outside the native dummy chapter range.');
    const step = BigInt(dummyChapterDuration) * 10000000n;
    chapters = runtime <= 0n ? [] : Array.from({ length: Math.max(1, Number(runtime / step)) }, (_, index) => ({ Name: null, StartPositionTicks: BigInt(index) * step }));
  }
  return chapters.map((chapter, index) => ({ ...chapter, Name: empty(chapter.Name) || timeSpan(chapter.Name) ? localization?.format('ChapterNameValue', [index + 1]) ?? `Chapter ${index + 1}` : chapter.Name }));
}
