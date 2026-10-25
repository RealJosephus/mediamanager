import path from 'node:path';
import { md5Guid } from '@mediamanager/plugin-sdk/core/identity';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';

// Source fields follow the designated M3UTunerHost.CreateMediaSourceInfo
// (Jellyfin, GPL-2.0-only); execution capabilities are not inferred from flags.

export const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const stream = (Type, IsInterlaced = false) => ({ Type, Index: -1, IsInterlaced, IsDefault: false,
  IsForced: false, IsHearingImpaired: false, IsOriginal: false, IsExternal: false, SupportsExternalStream: false });

export async function createMediaSource(info, channel, { isLocalNetwork }) {
  const location = channel.Path;
  let uri; try { uri = new URL(location); } catch { /* Native accepts a path without an absolute URI here. */ }
  const protocol = ({ 'http:': 'Http', 'https:': 'Http', 'rtsp:': 'Rtsp', 'rtp:': 'Rtp', 'udp:': 'Udp', 'rtmp:': 'Rtmp', 'ftp:': 'Ftp' })[uri?.protocol] ?? 'File';
  const manifest = ['.m3u', '.m3u8', '.mpd'].includes(path.extname(uri?.pathname ?? location).toLowerCase());
  const headers = protocol === 'Http' ? { 'User-Agent': info.UserAgent == null || clrTrim(info.UserAgent) === '' ? browserUserAgent : info.UserAgent } : {};
  return { Protocol: protocol, Id: md5Guid(location), Path: location, Type: 'Default',
    Formats: [], MediaStreams: [stream('Video', true), stream('Audio')], MediaAttachments: [],
    ReadAtNativeFramerate: info.ReadAtNativeFramerate, IgnoreDts: info.IgnoreDts, IgnoreIndex: false, GenPtsInput: false,
    SupportsTranscoding: true, SupportsDirectStream: !info.EnableStreamLooping,
    SupportsDirectPlay: !info.EnableStreamLooping && info.TunerCount === 0 && !manifest,
    IsInfiniteStream: true, UseMostCompatibleTranscodingProfile: !info.AllowFmp4TranscodingContainer,
    RequiresOpening: true, RequiresClosing: true, RequiresLooping: info.EnableStreamLooping, SupportsProbing: true,
    IsRemote: uri ? !await isLocalNetwork(uri.hostname) : true,
    FallbackMaxStreamingBitrate: info.FallbackMaxStreamingBitrate, RequiredHttpHeaders: headers, HasSegments: false };
}
