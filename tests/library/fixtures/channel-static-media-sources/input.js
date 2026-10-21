export const itemId = 'ad610000-0000-0000-0000-000000000001';
export const channelId = 'ad610000-0000-0000-0000-000000000002';
export const alternateId = 'ad610000-0000-0000-0000-000000000003';
export const userId = 'ad610000-0000-0000-0000-000000000004';
export const visibleId = 'ad610000-0000-0000-0000-000000000005';
export const blockedId = 'ad610000-0000-0000-0000-000000000006';
export const missingId = 'ad610000-0000-0000-0000-000000000007';
const n = value => value.replaceAll('-', '');
export const sourceFields = ['Protocol', 'Id', 'Path', 'EncoderPath', 'EncoderProtocol', 'Type', 'Container', 'Size', 'Name', 'IsRemote', 'ETag',
  'RunTimeTicks', 'ReadAtNativeFramerate', 'IgnoreDts', 'IgnoreIndex', 'GenPtsInput', 'SupportsTranscoding', 'SupportsDirectStream', 'SupportsDirectPlay',
  'IsInfiniteStream', 'UseMostCompatibleTranscodingProfile', 'RequiresOpening', 'OpenToken', 'RequiresClosing', 'LiveStreamId', 'BufferMs', 'RequiresLooping',
  'SupportsProbing', 'VideoType', 'IsoType', 'Video3DFormat', 'Formats', 'Bitrate', 'FallbackMaxStreamingBitrate', 'Timestamp', 'RequiredHttpHeaders',
  'TranscodingUrl', 'TranscodingSubProtocol', 'TranscodingContainer', 'AnalyzeDurationMs', 'DefaultAudioStreamIndex', 'DefaultSubtitleStreamIndex', 'HasSegments'];
export const streamFields = ['Type', 'Index', 'Codec', 'Language', 'BitRate', 'Channels', 'SampleRate', 'Width', 'Height', 'IsDefault', 'IsForced', 'IsExternal',
  'IsOriginal', 'IsInterlaced', 'SupportsExternalStream', 'Score', 'DisplayTitle', 'Title'];
const tracks = [{ Type: 'Audio', Index: 2, Language: 'eng', IsDefault: true, Codec: 'aac', Channels: 2 },
  { Type: 'Audio', Index: 6, Language: 'zho', Codec: 'ac3', Channels: 6 },
  { Type: 'Subtitle', Index: 8, Language: 'eng', Codec: 'srt', IsDefault: true },
  { Type: 'Subtitle', Index: 9, Language: 'zho', Codec: 'srt', IsForced: true }];
const source = (Id, extra = {}) => ({ Id, Protocol: 'Http', Path: 'http://saved.invalid/original.mkv', MediaStreams: [], ...extra });
const user = { configuration: { AudioLanguagePreference: 'eng', SubtitleLanguagePreference: 'eng', PlayDefaultAudioTrack: true,
  RememberAudioSelections: true, RememberSubtitleSelections: true, SubtitleMode: 'Default' },
policy: { EnableAllFolders: true, EnableAllChannels: true, EnableMediaPlayback: true, EnableVideoPlaybackTranscoding: true,
  EnableAudioPlaybackTranscoding: true, EnablePlaybackRemuxing: true, BlockedTags: ['blocked'] } };

export function makeInput() {
  const cases = [], add = (name, raw, extra = {}) => cases.push({ name, storage: 'file', raw, ...extra });
  const argumentNull = { type: 'ArgumentNullException', status: 400, Message: "Value cannot be null. (Parameter 'source')" };
  const normalizeNull = Object.fromEntries(['direct', 'baseSources', 'staticSources', 'playbackSources', 'dto'].map(stage => [stage,
    { type: 'NullReferenceException', status: 500, stackIncludes: 'NormalizeMediaSources' }]));
  add('missing cache falls back to retained static video', '', { storage: 'missing', expectFallback: true });
  add('directory cache read error falls back', '', { storage: 'directory', expectFallback: true });
  for (const [name, raw] of [['empty cache', '[]'], ['null cache', 'null'], ['truncated cache', '[{"Id":"first"},'],
    ['object root cache', '{}'], ['invalid row conversion', '[{"Size":"invalid"}]'],
    ['invalid earlier duplicate is not hidden by later valid', '[{"Size":"bad","Size":1}]']]) add(name + ' falls back', raw, { expectFallback: true });
  add('case-sensitive source fields construct defaults', '[{"id":"ignored","Path":"http://saved.invalid/default","Ignored":42}]');
  add('quoted scalar numbers retain exact Int64', '[{"Id":"opaque","Protocol":"Http","Size":"9007199254740993","RunTimeTicks":"9007199254740995","BufferMs":"1500","MediaStreams":[{"Type":"Audio","Index":"6","Channels":"2","SampleRate":"48000"}]}]');
  add('duplicate valid fields use last value', '[{"Id":"first","Id":"last","Path":"http://saved.invalid/first","Path":"http://saved.invalid/last","MediaStreams":[]}]');
  add('one empty id receives item id', JSON.stringify([source('')]));
  add('remaining empty ids use path or original index', JSON.stringify([source(null), source('', { Path: null }), source(null, { Path: '' }), source('', { Path: 'Repeat' }), source(null, { Path: 'Repeat' })]));
  add('existing insensitive default keeps all source order', JSON.stringify([source('first'), source(n(itemId).toUpperCase()), source('', { Path: '/Caps.MKV' })]));
  add('normalization preserves runtime or inherits nullable item runtime', JSON.stringify([source('one', { RunTimeTicks: 19 }), source('two', { RunTimeTicks: null })]));
  add('null first member fails outside reader catch', '[null]', { expectedNativeFailures: normalizeNull });
  add('null later member fails after default match', JSON.stringify([source(n(itemId)), null]), { expectedNativeFailures: normalizeNull });
  add('DTO chooses container by original extension and first cache stream', JSON.stringify([
    source('opaque-first', { Container: 'mkv,WEBM', Path: 'http://saved.invalid/a.WeBm', MediaStreams: tracks }),
    source(n(itemId), { Container: 'mp4,mkv', Path: 'http://saved.invalid/a.unmatched', MediaStreams: [{ Type: 'Audio', Index: 14, Codec: 'flac' }] })]));
  add('DTO MediaStreams without MediaSources reads saved cache', JSON.stringify([source('first', { MediaStreams: tracks })]), { fields: ['MediaStreams', 'MediaSourceCount'] });
  add('DTO CLR extension-only and trailing-dot container selection', JSON.stringify([
    source('extension-only', { Container: 'mkv,WEBM', Path: '.WeBm' }),
    source('trailing-dot', { Container: 'mkv,WEBM', Path: '/a.' }),
    source('query-is-part-of-extension', { Container: 'mkv,WEBM', Path: 'http://saved.invalid/a.webm?x=1' })]));
  add('user remembered tracks and video policy overwrite saved flags', JSON.stringify([source(n(itemId), { MediaStreams: tracks, SupportsTranscoding: false, SupportsDirectStream: false })]),
    { user, userData: { AudioStreamIndex: 6, SubtitleStreamIndex: 9 }, fields: ['MediaSources', 'MediaStreams', 'MediaSourceCount', 'EnableMediaSourceDisplay'] });
  add('disabled user video policy overrides saved true flags', JSON.stringify([source('opaque', { MediaStreams: tracks })]),
    { user: { ...user, policy: { ...user.policy, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: false } } });
  add('user source filtering preserves opaque ids duplicates and permitted outside graph', JSON.stringify([
    source(n(missingId)), source(n(visibleId)), source(n(blockedId)), source('opaque'), source(n(visibleId)), source(n(itemId).toUpperCase())]), { user });
  add('all filtered sources still let DTO MediaStreams consume userless first cache source', JSON.stringify([source(n(missingId), { MediaStreams: tracks })]), { user });
  add('explicit empty Guid source id reaches actual lookup error', JSON.stringify([source('0'.repeat(32))]), { user,
    expectedNativeFailures: Object.fromEntries(['staticSources', 'playbackSources', 'dto'].map(stage => [stage,
      { type: 'ArgumentException', status: 400, Message: "Guid can't be empty (Parameter 'id')" }])) });
  add('nonversion source userdata cannot reorder a one-version item', JSON.stringify([source(n(itemId)), source(n(visibleId))]),
    { user, externalResume: true });
  add('linked version resume reorders cached sources', JSON.stringify([source(n(itemId)), source(n(alternateId))]), { user, linked: true, alternateResume: true });
  add('direct alternate keeps configured source order despite primary resume', JSON.stringify([source(n(alternateId)), source(n(itemId))]),
    { user, linked: true, queryAlternate: true, primaryResume: true });
  add('Guid D source is visible but is not an N-key resume association', JSON.stringify([source(n(itemId)), source(alternateId)]),
    { user, linked: true, alternateResume: true });
  add('playback opaque first source falls back to queried preferred id', JSON.stringify([
    source('opaque-first', { VideoType: 'VideoFile' }), source(n(itemId), { VideoType: 'VideoFile' }), source('placeholder', { Type: 'Placeholder' })]));
  add('playback Guid D preferred selects N string only', JSON.stringify([source(itemId, { VideoType: 'VideoFile' }), source(n(itemId), { VideoType: 'VideoFile' })]));
  add('null stream collection has distinct user and DTO consumers', '[{"Id":"opaque","MediaStreams":null}]', { user,
    expectedNativeFailures: Object.fromEntries(['staticSources', 'playbackSources', 'dto'].map(stage => [stage, { ...argumentNull, stackIncludes: 'GetSortedStreams' }])) });
  add('null stream collection without user reaches playback key and DTO ToArray', '[{"Id":"opaque","MediaStreams":null}]', {
    expectedNativeFailures: { playbackSources: { type: 'NullReferenceException', status: 500, stackIncludes: 'get_VideoStream' }, dto: { ...argumentNull, stackIncludes: 'ToArray' } } });
  const originalUser = { ...user, configuration: { ...user.configuration, AudioLanguagePreference: 'OriginalLanguage', PlayDefaultAudioTrack: false } };
  add('null stream OriginalLanguage direct FindIndex preserves later 500 branch', '[{"Id":"opaque","MediaStreams":null}]', { user: originalUser,
    expectedNativeFailures: Object.fromEntries(['staticSources', 'playbackSources', 'dto'].map(stage => [stage,
      { type: 'NullReferenceException', status: 500, stackIncludes: 'FindIndex' }])) });
  add('null stream remembered audio Any precedes OriginalLanguage FindIndex', '[{"Id":"opaque","MediaStreams":null}]', {
    user: originalUser, userData: { AudioStreamIndex: 6, SubtitleStreamIndex: 9 },
    expectedNativeFailures: Object.fromEntries(['staticSources', 'playbackSources', 'dto'].map(stage => [stage, { ...argumentNull, stackIncludes: 'SetDefaultAudioStreamIndex' }])) });
  const bulkIds = Array.from({ length: 131 }, (_, index) => 'ad620000-0000-0000-0000-' + String(index + 1).padStart(12, '0'));
  add('more than one SQL batch retains ordered duplicate sources', JSON.stringify([...bulkIds.map(id => source(n(id))), source(n(bulkIds[0]))]), { user, bulkIds });
  return { itemId, channelId, alternateId, userId, visibleId, blockedId, missingId, sourceFields, streamFields, cases,
    normalizeCases: [[source(n(itemId)), null], [source(''), null], [source(''), source(null, { Path: '' })]] };
}
