import { readXml } from '../core/xml.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals as same, ordinalIgnoreCaseKey } from './ordinal-comparer.js';
import { trySetProviderId } from '../metadata/provider-ids.js';

const text = value => typeof value === 'string' && clrTrim(value).length > 0;
const distinct = values => [...new Map(values.map(value => [ordinalIgnoreCaseKey(value), value])).keys()].map(key => values.find(value => ordinalIgnoreCaseKey(value) === key));
const split = (value, comma = false) => String(value).split(comma && !/[/;|\\]/u.test(value) ? /,/u : /[/;|\\]/u).map(clrTrim).filter(Boolean);
const number = value => /^[+-]?\d+$/u.test(clrTrim(value ?? '')) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : null;
const whitelist = ['AC/DC', 'A/T/O/S', 'As/Hi Soundworks', 'Au/Ra', 'Bremer/McCoy', 'b/bqスタヂオ', 'DOV/S', "DJ'TEKINA//SOMETHING", 'IX/ON', 'J-CORE SLi//CER', 'M(a/u)SH', 'Kaoru/Brilliance', 'signum/ii', 'Richiter(LORB/DUGEM DI BARAT)', '이달의 소녀 1/3', 'R!N / Gemie', 'LOONA 1/3', 'LOONA / yyxy', 'LOONA / ODD EYE CIRCLE', 'K/DA', '22/7', '諭吉佳作/men', '//dARTH nULL', 'Phantom/Ghost', 'She/Her/Hers', "5/8erl in Ehr'n", 'Smith/Kotzen', 'We;Na', 'LSR/CITY', 'Kairon; IRSE!'];
const replace = (value, token, replacement) => value.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), () => replacement);
function artists(value, featuring) {
  if (!text(value)) return [];
  if (featuring) value = value.replace(/ featuring | feat\. /giu, ' | ');
  const found = [];
  for (const artist of whitelist) { const next = replace(value, artist, '|'); if (next !== value) found.push(artist); value = next; }
  return distinct([...found, ...value.split(featuring ? /[/;|\\]/u : /[/;]/u).map(clrTrim).filter(Boolean)]);
}
export function probeTags(raw, isAudio) {
  const result = new Map();
  for (const source of [raw.streams?.find(stream => stream.codec_type === (isAudio ? 'audio' : 'video'))?.tags, raw.format?.tags]) {
    const local = new Map();
    for (const [key, value] of Object.entries(source ?? {})) if (!local.has(ordinalIgnoreCaseKey(key))) local.set(ordinalIgnoreCaseKey(key), value);
    for (const entry of local) result.set(...entry);
  }
  return { get: key => result.get(ordinalIgnoreCaseKey(key)), has: key => result.has(ordinalIgnoreCaseKey(key)) };
}

const sanitizedTag = value => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const result = value.split('\0', 1)[0];
  return result.length ? result : null;
};

// AudioFileProber reads these values through ATL rather than ProbeResultNormalizer.
// ffprobe exposes a useful common subset, which stays separate so the native
// ProbeResultNormalizer projection above remains unchanged.
export function audioFileTagInfo(raw) {
  const tags = probeTags(raw, true);
  const standard = (...keys) => sanitizedTag(keys.map(key => tags.get(key)).find(value => typeof value === 'string' && value.length > 0));
  const additional = key => {
    const direct = tags.get(key);
    if (direct !== undefined) return sanitizedTag(direct);
    const fallback = `track.${key.trim().replaceAll(' ', '_').toLowerCase()}`;
    return tags.has(fallback) ? sanitizedTag(tags.get(fallback)) : null;
  };
  const firstAdditional = (...keys) => {
    for (const key of keys) {
      if (tags.has(key) || tags.has(`track.${key.trim().replaceAll(' ', '_').toLowerCase()}`)) return additional(key);
    }
    return null;
  };
  return {
    Title: standard('title', 'title-eng'),
    Album: standard('album'),
    AlbumArtist: standard('albumartist', 'album artist', 'album_artist'),
    Artist: standard('artist'),
    Composer: standard('composer'),
    Genre: standard('genre'),
    Date: date(tags.get('date')),
    Description: standard('description'),
    Comment: standard('comment'),
    Publisher: standard('publisher'),
    NonstandardAlbumArtists: additional('ALBUMARTISTS'),
    NonstandardArtists: additional('ARTISTS'),
    ReplayGainTrack: additional('REPLAYGAIN_TRACK_GAIN'),
    ReplayGainAlbum: additional('REPLAYGAIN_ALBUM_GAIN'),
    MusicBrainzArtist: firstAdditional('MUSICBRAINZ_ARTISTID', 'MusicBrainz Artist Id'),
    MusicBrainzAlbumArtist: firstAdditional('MUSICBRAINZ_ALBUMARTISTID', 'MusicBrainz Album Artist Id'),
    MusicBrainzAlbum: firstAdditional('MUSICBRAINZ_ALBUMID', 'MusicBrainz Album Id'),
    MusicBrainzReleaseGroup: firstAdditional('MUSICBRAINZ_RELEASEGROUPID', 'MusicBrainz Release Group Id'),
    MusicBrainzTrack: firstAdditional('MUSICBRAINZ_RELEASETRACKID', 'MusicBrainz Release Track Id'),
    MusicBrainzRecording: firstAdditional('MUSICBRAINZ_TRACKID', 'MusicBrainz Track Id'),
    Ufid: tags.get('UFID') ?? tags.get('track.ufid') ?? null,
  };
}
function date(value) {
  if (!text(value)) return null;
  value = clrTrim(value);
  if (/^\d{4}$/u.test(value)) value += '-01-01';
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z)?$/u.test(value)) {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    return value.includes('T') ? value.replace(/(?:\.(\d+))?Z$/u, (_, fraction) => `.${(fraction ?? '').padEnd(7, '0')}Z`) : `${value}T00:00:00.0000000Z`;
  }
  const parsed = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value} UTC`);
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/u.exec(value)?.[1];
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(/\.(\d{3})Z$/u, (_, milliseconds) => `.${(fraction ?? milliseconds).padEnd(7, '0').slice(0, 7)}Z`);
}
function itunes(xml, info) {
  try {
    const index = xml.indexOf('<plist'); if (index >= 0) xml = xml.slice(index);
    const root = readXml(xml); if (root.name !== 'plist') return;
    for (const dict of root.children.filter(node => node.name === 'dict')) {
      let key = null, pairs = [];
      const flush = () => {
        const names = distinct(pairs.filter(text).map(clrTrim));
        if (same(key, 'studio')) info.Studios = names;
        const type = ['screenwriters', 'producers', 'directors'].findIndex(value => same(key, value));
        info.People = type < 0 ? [] : names.map(Name => ({ Name, Type: ['Writer', 'Producer', 'Director'][type], Role: null }));
      };
      for (const node of dict.children) {
        if (node.name === 'key') { if (text(key)) flush(); key = node.text; pairs = []; }
        else if (node.name === 'string' && text(node.text)) pairs.push(node.text);
        else if (node.name === 'array') for (const entry of node.children.filter(node => node.name === 'dict')) {
          const name = entry.children.filter(node => node.name === 'key').at(-1)?.text;
          const value = entry.children.filter(node => node.name === 'string').at(-1)?.text;
          if (name && value) pairs.push(value);
        }
      }
      // The native reader processes a group at the next key, leaving the final group unapplied.
    }
  } catch { /* Malformed iTunMOVI does not fail a probe. */ }
}
export function descriptiveProbeInfo(raw, { isAudio = false } = {}) {
  const tags = probeTags(raw, isAudio), first = (...keys) => keys.map(key => tags.get(key)).find(text) ?? null;
  const info = { Name: first('title', 'title-eng'), ForcedSortName: first('sort_name', 'title-sort', 'titlesort'), Overview: first('synopsis', 'description', 'desc', 'comment'),
    ParentIndexNumber: number(tags.get('season_number')), IndexNumber: number(tags.get('episode_sort')) ?? number(tags.get('episode_id')),
    ShowName: tags.has('show_name') ? tags.get('show_name') : 'show', ProductionYear: number(tags.get('date')),
    PremiereDate: ['originaldate', 'retaildate', 'retail date', 'retail_date', 'date_released', 'date', 'creation_time'].map(key => date(tags.get(key))).find(Boolean) ?? null,
    Album: tags.get('album') ?? null, Artists: artists(first('artists') ?? first('artist'), !text(tags.get('artists'))), AlbumArtists: [],
    Genres: text(tags.get('genre')) ? distinct(split(tags.get('genre'), true)) : [], Studios: [], People: [], ProviderIds: {}, OfficialRating: null, OfficialRatingDescription: null, Video3DFormat: null, Timestamp: null };
  if (info.ProductionYear == null && info.PremiereDate) info.ProductionYear = Number(info.PremiereDate.slice(0, 4));
  const studios = key => { const value = tags.get(key); if (value) info.Studios = distinct(split(value, true).filter(value => ![...info.Artists, ...info.AlbumArtists].some(artist => same(value, artist)))); };
  if (isAudio) {
    for (const [key, type] of Object.entries({ composer: 'Composer', conductor: 'Conductor', lyricist: 'Lyricist', performer: 'Actor', writer: 'Writer', arranger: 'Arranger', engineer: 'Engineer', mixer: 'Mixer', remixer: 'Remixer' })) {
      if (!text(tags.get(key))) continue;
      for (const Name of split(tags.get(key))) {
        if (key !== 'performer') info.People.push({ Name, Type: type, Role: null });
        else { const match = /(?<name>.*) \((?<instrument>.*)\)/u.exec(Name); if (match) info.People.push({ Name: match.groups.name, Type: type, Role: match.groups.instrument.replace(/\b\p{L}/gu, letter => letter.toUpperCase()) }); }
      }
    }
    info.AlbumArtists = artists(first('albumartist', 'album artist', 'album_artist'), true);
    if (!info.AlbumArtists.length) info.AlbumArtists = [...info.Artists];
    info.IndexNumber = number(tags.get('track')?.split('/')[0]); info.ParentIndexNumber = number(tags.get('disc')?.split('/')[0]);
    for (const key of ['organization', 'ensemble', 'publisher', 'label']) studios(key);
    for (const [key, title, compact] of [['MusicBrainzAlbumArtist', 'Album Artist', 'ALBUMARTIST'], ['MusicBrainzArtist', 'Artist', 'ARTIST'], ['MusicBrainzAlbum', 'Album', 'ALBUM'], ['MusicBrainzReleaseGroup', 'Release Group', 'RELEASEGROUP'], ['MusicBrainzTrack', 'Release Track', 'RELEASETRACK']]) {
      const parse = value => text(value) ? value.split('/').map(clrTrim).filter(Boolean)[0] : null;
      trySetProviderId(info, key, parse(tags.get(`MusicBrainz ${title} Id`)) ?? parse(tags.get(`MUSICBRAINZ_${compact}ID`)));
    }
  } else {
    studios('copyright');
    const rating = first('iTunEXTC')?.split('|').filter(Boolean); if (rating?.length > 1) { info.OfficialRating = rating[1]; if (rating.length > 3) info.OfficialRatingDescription = rating[3]; }
    if (first('iTunMOVI')) itunes(first('iTunMOVI'), info);
    const wtv = probeTags({ format: raw.format }, false);
    if (text(wtv.get('WM/Genre'))) { const genres = wtv.get('WM/Genre').split(/[/;,]/u).map(clrTrim).filter(Boolean); if (genres.length) info.Genres = genres; }
    if (text(wtv.get('WM/ParentalRating'))) info.OfficialRating = wtv.get('WM/ParentalRating');
    if (wtv.get('WM/MediaCredits')) info.People = wtv.get('WM/MediaCredits').split(/[/;]/u).map(clrTrim).filter(Boolean).map(Name => ({ Name, Type: 'Actor', Role: null }));
    if (number(wtv.get('WM/OriginalReleaseTime')) != null) info.ProductionYear = number(wtv.get('WM/OriginalReleaseTime'));
    // The baseline reads OriginalReleaseTime in the broadcast-date branch.
    if (wtv.has('WM/MediaOriginalBroadcastDateTime') && date(wtv.get('WM/OriginalReleaseTime')) && !/^\d{4}$/u.test(wtv.get('WM/OriginalReleaseTime'))) info.PremiereDate = date(wtv.get('WM/OriginalReleaseTime'));
    let description = wtv.get('WM/SubTitleDescription');
    if (!text(wtv.get('WM/SubTitle')) && text(description) && description.slice(0, 100).includes(':')) {
      const subtitle = description.split(':')[0]; const parts = subtitle.split(' '), index = number(parts[0].replaceAll('.', '').split('/')[0]);
      if (subtitle.includes('/') && index != null) { info.IndexNumber = index; description = clrTrim(parts.slice(1).join(' ')); }
      else description = clrTrim(subtitle.includes('.') ? subtitle.split('.').slice(1).join('.') : subtitle);
    }
    if (text(description)) info.Overview = description;
    if (same(tags.get('stereo_mode') ?? '', 'left_right')) info.Video3DFormat = 'FullSideBySide';
  }
  return info;
}
