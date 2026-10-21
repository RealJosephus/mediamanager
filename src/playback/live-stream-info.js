import { bindJsonModel } from '../http/json-model-binding.js';
import { projectLiveStream } from '../library/media-streams.js';
import { withNativeNulls } from '../core/json.js';

const primitive = (type, nullable = true) => ({ type, nullable, clrType: ({ string: 'System.String', integer: 'System.Int32',
  long: 'System.Int64', boolean: 'System.Boolean', double: 'System.Double', float: 'System.Single', datetime: 'System.DateTime' })[type] });
const enumeration = (names, nullable = false) => ({ type: 'enum', nullable, clrType: 'System.Enum', values: Object.fromEntries(names.map((name, index) => [name, index])) });
const object = reference => ({ type: 'object', nullable: true, clrType: reference, reference });
const array = item => ({ type: 'array', nullable: true, item });
const dictionary = { type: 'dictionary', nullable: true, item: primitive('string') };
const fields = (type, names, nullable = true) => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, primitive(type, nullable)]));
const sourceFields = {
  ...fields('string', 'Id Path EncoderPath Container Name ETag OpenToken LiveStreamId TranscodingUrl TranscodingContainer'),
  ...fields('long', 'Size RunTimeTicks'), ...fields('integer', 'BufferMs Bitrate FallbackMaxStreamingBitrate AnalyzeDurationMs DefaultAudioStreamIndex DefaultSubtitleStreamIndex'),
  ...fields('boolean', 'IsRemote ReadAtNativeFramerate IgnoreDts IgnoreIndex GenPtsInput SupportsTranscoding SupportsDirectStream SupportsDirectPlay IsInfiniteStream UseMostCompatibleTranscodingProfile RequiresOpening RequiresClosing RequiresLooping SupportsProbing HasSegments', false),
  Protocol: enumeration(['File', 'Http', 'Rtmp', 'Rtsp', 'Udp', 'Rtp', 'Ftp']),
  EncoderProtocol: enumeration(['File', 'Http', 'Rtmp', 'Rtsp', 'Udp', 'Rtp', 'Ftp'], true), Type: enumeration(['Default', 'Grouping', 'Placeholder']),
  VideoType: enumeration(['VideoFile', 'Iso', 'Dvd', 'BluRay'], true), IsoType: enumeration(['Dvd', 'BluRay'], true),
  Video3DFormat: enumeration(['HalfSideBySide', 'FullSideBySide', 'FullTopAndBottom', 'HalfTopAndBottom', 'MVC'], true),
  Timestamp: enumeration(['None', 'Zero', 'Valid'], true), TranscodingSubProtocol: enumeration(['http', 'hls']),
  Formats: array(primitive('string')), RequiredHttpHeaders: dictionary, MediaStreams: array(object('MediaStream')),
  MediaAttachments: array(object('MediaAttachment')),
};
const streamFields = {
  ...fields('string', 'Codec CodecTag Language ColorRange ColorSpace ColorTransfer ColorPrimaries Comment TimeBase CodecTimeBase Title LocalizedUndefined LocalizedDefault LocalizedForced LocalizedExternal LocalizedHearingImpaired LocalizedLanguage LocalizedOriginal NalLengthSize ChannelLayout Profile AspectRatio DeliveryUrl Path PixelFormat'),
  ...fields('integer', 'DvVersionMajor DvVersionMinor DvProfile DvLevel RpuPresentFlag ElPresentFlag BlPresentFlag DvBlSignalCompatibilityId Rotation BitRate BitDepth RefFrames PacketLength Channels SampleRate Height Width Score'),
  ...fields('boolean', 'Hdr10PlusPresentFlag IsAVC IsExternalUrl IsAnamorphic'),
  ...fields('boolean', 'IsInterlaced IsDefault IsForced IsHearingImpaired IsOriginal IsExternal SupportsExternalStream', false),
  ...fields('float', 'AverageFrameRate RealFrameRate'), ...fields('double', 'Level'), Index: primitive('integer', false),
  Type: enumeration(['Audio', 'Video', 'Subtitle', 'EmbeddedImage', 'Data', 'Lyric']),
  DeliveryMethod: enumeration(['Encode', 'Embed', 'External', 'Hls', 'Drop'], true),
};

function mediaSourceDefaults() {
  return { Protocol: 'File', Type: 'Default', IsRemote: false, ReadAtNativeFramerate: false, IgnoreDts: false, IgnoreIndex: false,
    GenPtsInput: false, SupportsTranscoding: true, SupportsDirectStream: true, SupportsDirectPlay: true, IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false, RequiresOpening: false, RequiresClosing: false, RequiresLooping: false, SupportsProbing: true,
    MediaStreams: [], MediaAttachments: [], Formats: [], RequiredHttpHeaders: {}, TranscodingSubProtocol: 'http', HasSegments: false };
}

export function liveMediaInfoDefaults() {
  return { ...mediaSourceDefaults(), Chapters: [], Artists: [], AlbumArtists: [], Studios: [], Genres: [], People: [], ProviderIds: {} };
}

export const nativeMediaSourceInfoDefinitions = {
  MediaSourceInfo: { fields: sourceFields, defaults: mediaSourceDefaults() },
  MediaInfo: { fields: { ...sourceFields,
    ...fields('string', 'Album ShowName ForcedSortName OfficialRating OfficialRatingDescription Overview'),
    ...fields('integer', 'IndexNumber ParentIndexNumber ProductionYear'), PremiereDate: primitive('datetime'),
    ...Object.fromEntries(['Artists', 'AlbumArtists', 'Studios', 'Genres'].map(name => [name, array(primitive('string'))])),
    Chapters: array(object('ChapterInfo')), People: array(object('BaseItemPerson')), ProviderIds: dictionary,
  }, defaults: liveMediaInfoDefaults() },
  MediaStream: { fields: streamFields, defaults: { Type: 'Audio', Index: 0, IsInterlaced: false, IsDefault: false, IsForced: false,
    IsHearingImpaired: false, IsOriginal: false, IsExternal: false, SupportsExternalStream: false } },
  MediaAttachment: { fields: { ...fields('string', 'Codec CodecTag Comment FileName MimeType DeliveryUrl'), Index: primitive('integer', false) }, defaults: { Index: 0 } },
  ChapterInfo: { fields: { ...fields('string', 'Name ImagePath'), StartPositionTicks: primitive('long', false), ImageDateModified: primitive('datetime', false),
    ImageTag: primitive('string') }, defaults: { StartPositionTicks: 0n, ImageDateModified: '0001-01-01T00:00:00.0000000' } },
  BaseItemPerson: { fields: { ...fields('string', 'Name Role PrimaryImageTag'), Id: { type: 'guid', nullable: false, clrType: 'System.Guid', preserveEmptyGuid: true },
    Type: enumeration(['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist', 'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator']),
    ImageBlurHashes: { type: 'dictionary', nullable: true, key: enumeration(['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile']), item: dictionary } },
    defaults: { Id: '00000000000000000000000000000000', Type: 'Unknown' } },
};
const schema = { definitions: nativeMediaSourceInfoDefinitions };

/** JsonDefaults.Options is case-sensitive, ignores unknown/read-only members,
 * permits quoted numbers, and constructs collection/scalar defaults. */
function readNativeModel(bytes, root) {
  const source = bytes.toString('utf8');
  try { return bindJsonModel(null, { schema, root, source, caseInsensitiveProperties: false }); }
  catch (error) { if (error instanceof SyntaxError) error.nativeException = 'JsonException'; throw error; }
}

export function readLiveMediaInfoCache(bytes) {
  const value = readNativeModel(bytes, object('MediaInfo'));
  if (value?.MediaStreams) value.MediaStreams = value.MediaStreams.map(stream => stream && liveMediaStream(stream));
  if (value?.People) value.People = value.People.map(person => person?.Id === '00000000000000000000000000000000' ? withNativeNulls({ ...person, Id: null }, ['Id']) : person);
  return value;
}

/** ChannelManager's saved MediaSourceInfo[] retains null roots and members. */
export function readNativeMediaSourceInfoList(bytes) {
  const value = readNativeModel(bytes, array(object('MediaSourceInfo')));
  if (value) for (const source of value) {
    if (source?.MediaStreams) source.MediaStreams = source.MediaStreams.map(stream => stream && liveMediaStream(stream));
  }
  return value;
}

/** Preserve native stream values while calculating its public getter fields.
 * Dynamic/live sources do not receive DtoService's language localization pass. */
export function liveMediaStream(values) {
  const Type = values.Type ?? 'Audio', Index = values.Index ?? 0;
  const constructor = schema.definitions.MediaStream.defaults;
  const source = { ...constructor, ...Object.fromEntries(Object.keys(streamFields).filter(name => Object.hasOwn(values, name)).map(name => [name, values[name]])), Type, Index };
  return projectLiveStream(source);
}
