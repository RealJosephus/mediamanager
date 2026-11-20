import { md5Guid } from '@mediamanager/plugin-sdk/core/identity';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';

const blank = value => value == null || clrTrim(value) === '';
export function getApiUrl(info) {
  if (blank(info?.Url)) throw new Error('Invalid tuner info');
  return new URL(/^http/iu.test(info.Url) ? info.Url : 'http://' + info.Url).href.replace(/\/+$/u, '');
}
export const supportsTranscoding = model => (model?.ModelNumber ?? '').toLowerCase().includes('hdtc');
export const advertisedDeviceProfiles = ['heavy', 'internet540', 'internet480', 'internet360', 'internet240', 'mobile'];
const profileVideo = new Map([
  ['heavy', [1920, 1080, 15000000]], ['internet720', [1280, 720, 8000000]], ['internet540', [960, 540, 2500000]],
  ['internet480', [848, 480, 2000000]], ['internet360', [640, 360, 1500000]], ['internet240', [432, 240, 1000000]],
  ['mobile', [1280, 720, 2000000]],
]);
export function createMediaSource(info, channel, profile = 'native') {
  const number = channel.Id.split('_')[1], url = getApiUrl(info), isHd = channel.IsHD ?? true;
  const encoded = profileVideo.get((profile ?? '').toLowerCase());
  const [width, height, videoBitrate] = encoded ?? [isHd ? 1920 : null, isHd ? 1080 : null, isHd ? 15000000 : 2000000];
  let video = encoded ? 'h264' : channel.VideoCodec;
  if (ordinalIgnoreCaseEquals(video, 'mpeg2')) video = 'mpeg2video';
  const audioBitrate = isHd ? 448000 : 192000;
  const stream = Type => ({ Type, Index: -1, IsInterlaced: false, IsDefault: false, IsForced: false, IsHearingImpaired: false,
    IsOriginal: false, IsExternal: false, SupportsExternalStream: false });
  return { Protocol: 'Udp', Id: (blank(profile) ? 'native' : profile) + '_' + md5Guid(number) + '_' + md5Guid(url), Path: url,
    Type: 'Default', Formats: [], MediaAttachments: [], RequiredHttpHeaders: {},
    MediaStreams: [{ ...stream('Video'), IsInterlaced: !encoded, Codec: video, Width: width, Height: height,
      BitRate: videoBitrate, NalLengthSize: ordinalIgnoreCaseEquals(video, 'h264') ? '0' : null },
    { ...stream('Audio'), Codec: channel.AudioCodec, BitRate: audioBitrate }],
    RequiresOpening: true, RequiresClosing: true, RequiresLooping: false, SupportsProbing: true,
    BufferMs: 0, Container: 'ts', SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true,
    IsInfiniteStream: true, IgnoreDts: true, IgnoreIndex: false, GenPtsInput: false, ReadAtNativeFramerate: false,
    IsRemote: false, UseMostCompatibleTranscodingProfile: true, FallbackMaxStreamingBitrate: info.FallbackMaxStreamingBitrate,
    Bitrate: videoBitrate + audioBitrate, HasSegments: false };
}
