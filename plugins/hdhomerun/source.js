import { md5Guid } from '@mediamanager/plugin-sdk/core/identity';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';

const failure = (name, message) => Object.assign(new Error(message), { nativeException: name });
const blank = value => value == null || clrTrim(value) === '';
export function getApiUrl(info) {
  if (blank(info?.Url)) throw failure('ArgumentException', 'Invalid tuner info');
  try { return new URL(/^http/iu.test(info.Url) ? info.Url : 'http://' + info.Url).href.replace(/\/+$/u, ''); }
  catch (error) { throw Object.assign(error, { nativeException: 'UriFormatException' }); }
}
export const supportsTranscoding = model => (model?.ModelNumber ?? '').toLowerCase().includes('hdtc');
export function createMediaSource(info, channel, profile = 'native') {
  const number = channel.Id.split('_')[1], url = getApiUrl(info), isHd = channel.IsHD ?? true;
  let video = channel.VideoCodec;
  if (ordinalIgnoreCaseEquals(video, 'mpeg2')) video = 'mpeg2video';
  const videoBitrate = isHd ? 15000000 : 2000000, audioBitrate = isHd ? 448000 : 192000;
  const stream = Type => ({ Type, Index: -1, IsInterlaced: false, IsDefault: false, IsForced: false, IsHearingImpaired: false,
    IsOriginal: false, IsExternal: false, SupportsExternalStream: false });
  return { Protocol: 'Udp', Id: (blank(profile) ? 'native' : profile) + '_' + md5Guid(number) + '_' + md5Guid(url), Path: url,
    Type: 'Default', Formats: [], MediaAttachments: [], RequiredHttpHeaders: {},
    MediaStreams: [{ ...stream('Video'), IsInterlaced: true, Codec: video, Width: isHd ? 1920 : null, Height: isHd ? 1080 : null,
      BitRate: videoBitrate, NalLengthSize: ordinalIgnoreCaseEquals(video, 'h264') ? '0' : null },
    { ...stream('Audio'), Codec: channel.AudioCodec, BitRate: audioBitrate }],
    RequiresOpening: true, RequiresClosing: true, RequiresLooping: false, SupportsProbing: true,
    BufferMs: 0, Container: 'ts', SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true,
    IsInfiniteStream: true, IgnoreDts: true, IgnoreIndex: false, GenPtsInput: false, ReadAtNativeFramerate: false,
    IsRemote: false, UseMostCompatibleTranscodingProfile: true, FallbackMaxStreamingBitrate: info.FallbackMaxStreamingBitrate,
    Bitrate: videoBitrate + audioBitrate, HasSegments: false };
}
