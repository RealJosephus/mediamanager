import { createHash } from 'node:crypto';
import { nativeGuid, nativeDateFromUnixNanoseconds } from '../../users/native.js';
import { imageTypes } from '../../metadata/image-paths.js';
import { nonemptyId } from '../../library/records.js';
import { metadataFields } from '../../library/metadata-context.js';
import { tokenizeJson } from '../../core/json-tokens.js';

const entities = 'MediaBrowser.Controller.Entities.';
const kinds = [
  null,
  'AggregateFolder',
  'UserRootFolder',
  'Folder',
  'CollectionFolder',
  'Movies.Movie',
  'TV.Series',
  'TV.Season',
  'TV.Episode',
  'Movies.BoxSet',
  'Trailer',
  'Audio.Audio',
  'Audio.MusicAlbum',
  'Audio.MusicArtist',
  'Audio.MusicGenre',
  'MusicVideo',
  'MediaBrowser.Controller.Playlists.Playlist',
  null,
  'Video',
  null,
  'Book',
  'Genre',
  null,
  'Person',
  null,
  'Photo',
  'PhotoAlbum',
  'MediaBrowser.Controller.LiveTv.LiveTvProgram',
  'MediaBrowser.Controller.LiveTv.LiveTvChannel',
  'Studio',
  null,
  'MediaBrowser.Controller.Channels.Channel',
  'UserView',
];
export const itemTypes = kinds.map(
  (kind) => kind && (kind.startsWith('MediaBrowser.') ? kind : entities + kind),
);
const folders = new Set([1, 2, 3, 4, 6, 7, 9, 12, 16, 26, 31, 32]);
export const musicArtistType = itemTypes[13];
export const nonFolderNameTypes = [itemTypes[14], itemTypes[21], itemTypes[23], itemTypes[29]];
const mediaTypes = new Map([[5, 'Video'], [8, 'Video'], [10, 'Video'], [11, 'Audio'],
  [15, 'Video'], [18, 'Video'], [20, 'Book'], [25, 'Photo']]);

export function jellyfinItemDiscriminators(type, parentId) {
  const kind = itemTypes.indexOf(type);
  return { IsFolder: Number(type === musicArtistType ? Boolean(nonemptyId(parentId)) : folders.has(kind)),
    MediaType: mediaTypes.get(kind) ?? null };
}
export const scalarFields = [
  'Name',
  'OriginalTitle',
  'SortName',
  'Overview',
  'OfficialRating',
  'CustomRating',
  'CommunityRating',
  'CriticRating',
  'IndexNumber',
  'ParentIndexNumber',
  'ProductionYear',
  'RunTimeTicks',
  'Path',
  'Tagline',
  'SeriesName',
  'ExternalId',
  'PresentationUniqueKey',
  'SeriesPresentationUniqueKey',
  'PreferredMetadataLanguage',
  'PreferredMetadataCountryCode',
  'ProductionLocations',
  'Width',
  'Height',
  'Size',
  'TotalBitrate',
  'IsLocked',
  'IsMovie',
  'IsSeries',
  'IsRepeat',
  'IsInMixedFolder',
];
export const dateFields = [
  'DateCreated',
  'DateModified',
  'DateLastRefreshed',
  'DateLastSaved',
  'PremiereDate',
  'StartDate',
  'EndDate',
];
export const stateFields = [
  'Played',
  'PlayCount',
  'IsFavorite',
  'PlaybackPositionTicks',
  'Rating',
  'AudioStreamIndex',
  'SubtitleStreamIndex',
];
export const wideFields = new Set(['RunTimeTicks', 'Size', 'PlaybackPositionTicks', 'StartPositionTicks']);
export const booleanFields = new Set([
  'IsLocked',
  'IsMovie',
  'IsSeries',
  'IsRepeat',
  'IsInMixedFolder',
  'IsFavorite',
  'Played',
]);
export const epochTicks = 621355968000000000n;
export const images = imageTypes;
export const locks = metadataFields;

export function fromBlob(bytes, fallback) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    if (bytes != null) throw new Error('Invalid Emby GUID representation');
    return nativeGuid(createHash('sha256').update(fallback).digest('hex').slice(0, 32));
  }
  const value = Buffer.from(bytes);
  value.subarray(0, 4).reverse();
  value.subarray(4, 6).reverse();
  value.subarray(6, 8).reverse();
  return nativeGuid(value.toString('hex'));
}
export function toBlob(id) {
  const value = Buffer.from(nativeGuid(id).replaceAll('-', ''), 'hex');
  value.subarray(0, 4).reverse();
  value.subarray(4, 6).reverse();
  value.subarray(6, 8).reverse();
  return value;
}
export function portableValue(name, value) {
  if (booleanFields.has(name)) return value ? 1 : 0;
  if (value == null) return null;
  if (wideFields.has(name)) return String(value);
  return typeof value === 'bigint' ? Number(value) : value;
}
export function sqliteValue(name, value) {
  return value != null && wideFields.has(name) ? BigInt(value) : value;
}
export function timeToSeconds(value) {
  if (!value) return null;
  const millis = Date.parse(value.replace(' ', 'T').replace(/Z?$/, 'Z'));
  if (!Number.isFinite(millis)) throw new Error('Unsupported native timestamp: ' + value);
  return String(Math.floor(millis / 1000));
}
export const fromSeconds = (value) =>
  value == null ? null : nativeDateFromUnixNanoseconds(BigInt(value) * 1000000000n);
export const fromImageTicks = (value) =>
  value == null ? null : nativeDateFromUnixNanoseconds((BigInt(value) - epochTicks) * 100n);
export function toImageTicks(value) {
  if (!value) return null;
  const fraction = (value.match(/\.(\d+)/u)?.[1] ?? '').padEnd(7, '0').slice(0, 7);
  return String(epochTicks + BigInt(timeToSeconds(value)) * 10000000n + BigInt(fraction));
}
export function statement(db, sql) {
  const query = db.prepare(sql);
  query.setReadBigInts(true);
  return query;
}
export function imageEntries(raw) {
  return (raw || '')
    .split('|')
    .filter(Boolean)
    .map((value) => {
      const match = /^(.*)\*(-?\d+)\*([^*]+)\*(\d+)\*(\d+)(?:\*(.*))?$/u.exec(value);
      if (!match || !images.includes(match[3])) return { raw: value };
      return {
        Path: match[1],
        DateModified: match[2],
        ImageType: match[3],
        Width: Number(match[4]),
        Height: Number(match[5]),
      };
    });
}
export function providers(raw) {
  return (raw || '')
    .split('|')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i < 1 ? [pair, null] : [pair.slice(0, i), pair.slice(i + 1)];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const keyFor = (type, ...ids) => [type, ...ids].join('/');
export function jsonProperty(node, name) {
  const matches = node.properties?.filter(([key]) => key === name) ?? [];
  if (matches.length > 1) throw new Error('Ambiguous JSON property ' + name);
  return matches[0]?.[1];
}
// Edit only the selected JSON value spans. Other numeric tokens may exceed
// JavaScript's integer precision and other fields may occur more than once.
export function editObjectFields(original, fields) {
  original ||= '{}';
  const parsed = JSON.parse(original);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected JSON object');
  const node = tokenizeJson(original),
    edits = [],
    added = [];
  for (const [name, value] of Object.entries(fields)) {
    const token = jsonProperty(node, name);
    const json = typeof value === 'function' ? value(original, token) : JSON.stringify(value);
    if (token) edits.push([token.start, token.end, json]);
    else added.push(JSON.stringify(name) + ':' + json);
  }
  if (added.length)
    edits.push([node.end - 1, node.end - 1, (node.properties.length ? ',' : '') + added.join(',')]);
  let result = original;
  for (const [start, end, json] of edits.sort((a, b) => b[0] - a[0]))
    result = result.slice(0, start) + json + result.slice(end);
  return result;
}
