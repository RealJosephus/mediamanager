import { randomUUID } from 'node:crypto';
import { bindJsonModel } from '../http/json-model-binding.js';
import { parseJsonDateTime } from '../http/json-date-time.js';
import { nativeMediaSourceInfoDefinitions, liveMediaStream } from '../playback/live-stream-info.js';
import { writeNativeDate } from './native-item-data.js';
import { dateText } from './records.js';
import { formatUtcTicks } from '../syncplay/time.js';
import { stringifyNativeJson, withNativeFloats } from '../core/json.js';

const scalar = (type, nullable = true) => ({ type, nullable, clrType: ({ string: 'System.String', integer: 'System.Int32', long: 'System.Int64',
  boolean: 'System.Boolean', float: 'System.Single', datetime: 'System.DateTime' })[type] });
const enumeration = (names, offset = 0) => ({ type: 'enum', nullable: false, clrType: 'System.Enum', values: Object.fromEntries(names.map((name, index) => [name, index + offset])) });
const object = reference => ({ type: 'object', nullable: true, reference, clrType: 'MediaBrowser.Controller.Channels.' + reference });
const array = item => ({ type: 'array', nullable: true, item });
const strings = array(scalar('string')), dictionary = { type: 'dictionary', nullable: true, item: scalar('string') };
const guid = { type: 'guid', nullable: false, preserveEmptyGuid: true, clrType: 'System.Guid' };
const people = ['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist', 'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator'];
const dateFields = ['DateModified', 'PremiereDate', 'DateCreated', 'StartDate', 'EndDate'];
const minimum = { ticks: 0n, kind: 'Unspecified' };
const definitions = {
  ...nativeMediaSourceInfoDefinitions,
  ChannelItemResult: { fields: { Items: array(object('ChannelItemInfo')), TotalRecordCount: scalar('integer') }, defaults: { Items: [] } },
  ChannelItemInfo: { fields: {
    ...Object.fromEntries(['Name', 'SeriesName', 'Id', 'OfficialRating', 'Overview', 'ImageUrl', 'OriginalTitle', 'HomePageUrl', 'Etag'].map(name => [name, scalar('string')])),
    DateModified: scalar('datetime', false), ...Object.fromEntries(dateFields.slice(1).map(name => [name, scalar('datetime')])),
    ...Object.fromEntries(['Genres', 'Studios', 'Tags', 'Artists', 'AlbumArtists'].map(name => [name, strings])),
    People: array(object('PersonInfo')), ProviderIds: dictionary, CommunityRating: scalar('float'), RunTimeTicks: scalar('long'),
    ...Object.fromEntries(['ProductionYear', 'IndexNumber', 'ParentIndexNumber'].map(name => [name, scalar('integer')])),
    Type: enumeration(['Media', 'Folder']), MediaType: enumeration(['Audio', 'Video', 'Photo']),
    FolderType: enumeration(['Container', 'MusicAlbum', 'PhotoAlbum', 'MusicArtist', 'Series', 'Season']),
    ContentType: enumeration(['Clip', 'Podcast', 'Trailer', 'Movie', 'Episode', 'Song', 'MovieExtra', 'TvExtra']),
    ExtraType: enumeration(['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short']),
    TrailerTypes: array(enumeration(['ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'], 1)),
    MediaSources: array({ ...object('MediaSourceInfo'), clrType: 'MediaBrowser.Model.Dto.MediaSourceInfo' }), IsLiveStream: scalar('boolean', false),
  }, defaults: { MediaSources: [], TrailerTypes: [], Genres: [], Studios: [], People: [], Tags: [], ProviderIds: {}, Artists: [], AlbumArtists: [],
    DateModified: minimum, Type: 'Media', MediaType: 'Audio', FolderType: 'Container', ContentType: 'Clip', ExtraType: 'Unknown', IsLiveStream: false } },
  PersonInfo: { fields: { Id: guid, ItemId: guid, Name: scalar('string'), Role: scalar('string'), Type: enumeration(people), SortOrder: scalar('integer'), ImageUrl: scalar('string'), ProviderIds: dictionary },
    defaults: { Id: null, ItemId: '0'.repeat(32), Type: 'Unknown', ProviderIds: {} } },
};

/** The same JsonDefaults model is read from disk and from a provider result.
 * Defaults are constructors; explicit null collections remain null. */
export function readChannelItemResult(bytes) {
  const result = bindJsonModel(null, { schema: { definitions }, root: object('ChannelItemResult'), source: bytes.toString('utf8'), caseInsensitiveProperties: false });
  if (result?.Items) for (const info of result.Items) {
    if (!info) continue;
    withNativeFloats(info, ['CommunityRating']);
    if (info.ProviderIds instanceof Map) info.ProviderIds = Object.fromEntries(info.ProviderIds);
    if (info.People) for (const person of info.People) if (person) {
      person.Id ??= randomUUID().replaceAll('-', '');
      if (person.ProviderIds instanceof Map) person.ProviderIds = Object.fromEntries(person.ProviderIds);
    }
    if (info.MediaSources) for (const source of info.MediaSources) if (source?.MediaStreams) source.MediaStreams = source.MediaStreams.map(stream => stream && liveMediaStream(stream));
  }
  return result;
}

/** SDK media-source envelopes are assertions; the native cache contains only
 * their shared MediaSourceInfo values and keeps explicit nulls. */
export function channelItemProviderResult(result) {
  if (result == null) return result;
  const Items = result.Items?.map(info => info == null ? info : { ...info,
    ...(info.MediaSources === undefined ? {} : { MediaSources: info.MediaSources === null ? null : info.MediaSources.map(source => source == null ? source : source.mediaSource) }) });
  const bytes = Buffer.from(JSON.stringify({ ...result, ...(Items === undefined ? {} : { Items }) }, (_key, value) =>
    typeof value === 'bigint' ? JSON.rawJSON(String(value)) : value instanceof Map ? Object.fromEntries(value) : value));
  return readChannelItemResult(bytes);
}

export function channelDateText(value) {
  if (value == null) return null;
  const state = typeof value === 'string' ? parseJsonDateTime(value) : value;
  return dateText(formatUtcTicks(state.ticks));
}
function writeDate(value) {
  if (value == null) return value;
  const state = typeof value === 'string' ? parseJsonDateTime(value) : value;
  const canonical = channelDateText(state), instant = new Date(Number(state.ticks / 10000n - 62135596800000n));
  return writeNativeDate(canonical, { value: canonical, kind: state.kind, offsetMinutes: -instant.getTimezoneOffset() });
}

/** CacheResponse serializes the typed result before materializing any item. */
export function writeChannelItemResult(result) {
  if (result == null) return Buffer.from('null');
  const Items = result.Items?.map(info => {
    if (!info) return info;
    const item = { ...info };
    for (const name of dateFields) if (Object.hasOwn(item, name)) item[name] = writeDate(item[name]);
    return withNativeFloats(item, ['CommunityRating']);
  });
  return Buffer.from(stringifyNativeJson({ ...result, ...(Items === undefined ? {} : { Items }) }));
}
