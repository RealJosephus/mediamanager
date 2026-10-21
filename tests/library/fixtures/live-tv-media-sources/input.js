import { md5Guid } from '../../../../src/core/identity.js';

export const sourceFields = ['Protocol', 'Id', 'Path', 'Type', 'Container', 'Name', 'RunTimeTicks', 'IsRemote',
  'ReadAtNativeFramerate', 'IgnoreDts', 'IgnoreIndex', 'GenPtsInput', 'SupportsTranscoding', 'SupportsDirectStream',
  'SupportsDirectPlay', 'IsInfiniteStream', 'UseMostCompatibleTranscodingProfile', 'RequiresOpening', 'OpenToken',
  'RequiresClosing', 'LiveStreamId', 'BufferMs', 'RequiresLooping', 'SupportsProbing', 'VideoType', 'Video3DFormat',
  'Bitrate', 'DefaultAudioStreamIndex', 'DefaultSubtitleStreamIndex', 'RequiredHttpHeaders', 'Formats', 'MediaAttachments'];
export const streamFields = ['Type', 'Index', 'Codec', 'Language', 'BitRate', 'Channels', 'AverageFrameRate',
  'RealFrameRate', 'Width', 'Height', 'SampleRate', 'Level', 'NalLengthSize', 'IsInterlaced', 'IsExternal',
  'IsDefault', 'IsForced', 'IsHearingImpaired', 'IsOriginal', 'SupportsExternalStream', 'Score'];
const itemId = 'a9840000-0000-0000-0000-000000000001';
const prefix = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider') + '_';
const source = (Id, changes = {}) => ({ Id, Path: 'http://input.invalid/original.ts', Protocol: 'Http', ...changes });
const stream = (Type, Index, changes = {}) => ({ Type, Index, ...changes });
const tracks = [stream('Video', 0, { Width: 1920, Height: 1080, BitRate: 5000000 }),
  stream('Audio', 1, { Language: 'eng', IsDefault: true, BitRate: 192000 }),
  stream('Audio', 2, { Language: 'zho', IsOriginal: true, BitRate: 128000 }),
  stream('Subtitle', 3, { Language: 'eng', IsDefault: true, Codec: 'srt', SupportsExternalStream: true }),
  stream('Subtitle', 4, { Language: 'zho', IsForced: true, Codec: 'srt', SupportsExternalStream: true }),
  stream('Subtitle', 5, { Language: 'zho', Codec: 'srt', IsExternal: true, SupportsExternalStream: true })];
const user = (configuration = {}, bits = 7) => ({ configuration: { RememberAudioSelections: true,
  RememberSubtitleSelections: true, PlayDefaultAudioTrack: false, SubtitleMode: 'Smart',
  AudioLanguagePreference: 'zho', SubtitleLanguagePreference: 'zho', ...configuration }, policy: {
  EnableAllFolders: true, EnableLiveTvAccess: true, EnableAudioPlaybackTranscoding: Boolean(bits & 1),
  EnableVideoPlaybackTranscoding: Boolean(bits & 2), EnablePlaybackRemuxing: Boolean(bits & 4),
} });
export function makeInput() {
  const sample = (name, sources = [source('ordinary')], changes = {}) => ({ name, item: {
    Id: itemId, Name: 'Controlled live channel', ExternalId: 'external_channel', ServiceName: 'Emby', ChannelType: 'TV',
    Path: null, ...changes.item }, sources, ...Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'item')) });
  return { localApiUrl: 'http://127.0.0.1:19001/controlled-local', userId: 'a9840000-0000-0000-0000-000000000002',
    sourceFields, streamFields, thirdPartySource: source('third-party', { SupportsTranscoding: false,
      MediaStreams: [stream('Video', 0, { NalLengthSize: '  ', IsInterlaced: false })] }), cases: [
      sample('TV unknown streams receive two dummy streams and an opening token', [source('tv', { RequiresOpening: true })]),
      sample('radio unknown streams receive one dummy audio stream', [source('radio')], { item: { ChannelType: 'Radio' } }),
      sample('bad technical values and duplicate indexes normalize before bitrate inference', [source('dirty', { SupportsTranscoding: false, MediaStreams: [
        stream('Video', 7, { BitRate: -1, Channels: 0, AverageFrameRate: 0, RealFrameRate: -1, Width: -20, Height: 0,
          SampleRate: 0, Level: -1, IsInterlaced: false, NalLengthSize: '' }),
        stream('Audio', 7, { BitRate: 160000, Channels: 2, AverageFrameRate: 25, RealFrameRate: 30, Width: 1, Height: 2, SampleRate: 48000, Level: 2 }),
        stream('Subtitle', 9, { BitRate: 999999, IsExternal: true })] })]),
      sample('explicit zero total bitrate is retained', [source('zero', { Bitrate: 0, SupportsTranscoding: false,
        SupportsDirectStream: false, SupportsDirectPlay: false, MediaStreams: [stream('Audio', 0, { BitRate: 500 })] })]),
      sample('bitrate accumulation preserves native unchecked int32 overflow', [source('overflow', { MediaStreams: [
        stream('Video', 0, { BitRate: 2147483647 }), stream('Audio', 1, { BitRate: 1 })] })]),
      sample('buffer zero survives and missing HTTP input uses the local API address', [source('local', { Path: '', BufferMs: 0, RequiresOpening: true })]),
      sample('existing unused opening token is prefixed independently of RequiresOpening', [source('token', {
        OpenToken: 'retained-token', LiveStreamId: 'retained-live', RequiresClosing: true,
        RequiredHttpHeaders: { 'X-Controlled-Source': 'retained' }, Formats: ['mpegts'] })]),
      sample('existing provider prefixes are case insensitive and are not duplicated', [source('prefix', {
        OpenToken: prefix.toUpperCase() + 'TOKEN', LiveStreamId: prefix.toUpperCase() + 'LIVE' })]),
      sample('RequiresOpening overwrites the supplied token and null source id leaves an empty suffix', [source(null, { RequiresOpening: true, OpenToken: 'discarded' })]),
      sample('empty default-service source list falls back to actual static placeholder', []),
      sample('unimplemented provider falls back to actual static placeholder', [], { failure: 'NotImplementedException' }),
      ...['NotSupportedException', 'IOException', 'OperationCanceledException'].map(failure =>
        sample(failure + ' becomes an empty dynamic list at MediaSourceManager', [], { failure })),
      sample('null stream collection fails dynamically without publishing partial sources', [source('bad', { MediaStreams: null })]),
      sample('unknown service name fails dynamically without fallback', [], { item: { ServiceName: 'missing' } }),
      sample('nonempty channel path suppresses the dynamic provider and final placeholder', [source('unused')], { item: { Path: 'http://input.invalid/retained.ts' } }),
      sample('pre-cancelled caller reaches a provider that deliberately ignores cancellation', [source('cancelled')], { preCancelled: true }),
      sample('playback sorts preferred identity then file type then 3D then width stably', [
        source('wide', { VideoType: 'VideoFile', MediaStreams: [stream('Video', 0, { Width: 3840 })] }),
        source('bluray', { VideoType: 'BluRay', MediaStreams: [stream('Video', 0, { Width: 8000 })] }),
        source('stereo', { VideoType: 'VideoFile', Video3DFormat: 'FullSideBySide', MediaStreams: [stream('Video', 0, { Width: 7000 })] }),
        source(itemId.replaceAll('-', '').toUpperCase(), { MediaStreams: [] }),
        source('equal-a', { VideoType: 'VideoFile', MediaStreams: [stream('Video', 0, { Width: 1280 })] }),
        source('equal-b', { VideoType: 'VideoFile', MediaStreams: [stream('Video', 0, { Width: 1280 })] })]),
      ...['Default', 'Always', 'OnlyForced', 'None', 'Smart'].map(SubtitleMode => sample('native user tracks ' + SubtitleMode + ' ignore persisted channel selections',
        [source('tracks', { MediaStreams: tracks })], { item: { OriginalLanguage: 'zho' }, user: user({ SubtitleMode }),
          userData: { Key: 'TvChannel-Controlled live channel', AudioStreamIndex: 1, SubtitleStreamIndex: 3 } })),
      sample('OriginalLanguage chooses actual source-list position for original audio', [source('original', { MediaStreams: tracks })],
        { item: { OriginalLanguage: 'zho' }, user: user({ AudioLanguagePreference: 'OriginalLanguage' }) }),
      ...Array.from({ length: 8 }, (_, bits) => sample('video playback permissions ' + bits, [
        source('playlist', { Path: 'http://input.invalid/source.M3U8', MediaStreams: tracks }),
        source('udp', { Path: 'udp://239.0.0.1:1234', Protocol: 'Udp', MediaStreams: tracks }),
        source('file', { Path: 'Z:\\Retained\input.ts', Protocol: 'File', MediaStreams: tracks })], { user: user({}, bits) })),
      ...[0, 1].map(bits => sample('radio playback permission ' + bits + ' keeps protocol eligibility', [
        source('playlist', { Path: 'http://input.invalid/source.m3u', MediaStreams: tracks }),
        source('http', { MediaStreams: tracks })], { item: { ChannelType: 'Radio' }, user: user({}, bits) })),
    ] };
}
