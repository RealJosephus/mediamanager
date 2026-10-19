import { StorageError } from './errors.js';
import { audioFileTagInfo, descriptiveProbeInfo } from './probe-tags.js';

const same = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const text = value => typeof value === 'string' && value.trim().length > 0;
const int32 = value => {
  if (value == null || !/^[+-]?\d+$/u.test(String(value).trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
};
const tags = value => {
  const result = new Map();
  for (const [key, item] of Object.entries(value ?? {})) if (!result.has(key.toLowerCase())) result.set(key.toLowerCase(), item);
  return result;
};
const roundEven = value => {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
};
function ticks(seconds) {
  const value = Number(seconds) * 10000000;
  if (!Number.isFinite(value) || value < -9223372036854775808 || value >= 9223372036854775808) {
    throw new StorageError('invalid-response', 'Probe duration is outside the native TimeSpan range.');
  }
  return BigInt(Math.trunc(value));
}

export function probeFrameRate(value) {
  const parts = typeof value === 'string' ? value.split('/') : [];
  if (parts.length !== 2 || !parts.every(part => /^[+-]?\d+$/u.test(part.trim()))) return null;
  const denominator = Math.fround(Number(parts[1]));
  return denominator === 0 ? null : Math.fround(Math.fround(Number(parts[0])) / denominator);
}

export function estimatedAudioBitrate(codec, profile, channels) {
  if (!channels || channels < 1 || !codec) return null;
  const multichannel = channels > 2;
  switch (codec.toLowerCase()) {
    case 'aac': case 'mp3': case 'mp2': return multichannel ? 320000 : 192000;
    case 'ac3': case 'eac3': return multichannel ? 640000 : 192000;
    case 'dts': case 'dca': return profile?.toLowerCase().includes('hd ma') ? channels * 700000 : multichannel ? 1509000 : 768000;
    case 'opus': return multichannel ? 256000 : 128000;
    case 'vorbis': return multichannel ? 320000 : 160000;
    case 'wmav1': case 'wmav2': case 'wmapro': return multichannel ? 384000 : 192000;
    case 'flac': case 'alac': return channels * 480000;
    case 'truehd': case 'mlp': return channels * 700000;
    default: return null;
  }
}

function aspectRatio(stream) {
  const parts = (stream.display_aspect_ratio ?? '').split(':').map(int32);
  const [width, height] = parts.length === 2 && parts.every(value => value > 0) ? parts : [stream.width, stream.height];
  if (width > 0 && height > 0) {
    for (const [ratio, tolerance, name] of [[1.777777778, .03, '16:9'], [1.3333333333, .05, '4:3'], [1.41, .005, '1.41:1'], [1.5, .005, '1.5:1'], [1.6, .005, '1.6:1'], [1.66666666667, .005, '5:3'], [1.85, .02, '1.85:1'], [2.35, .025, '2.35:1'], [2.4, .025, '2.40:1']]) {
      if (Math.abs(width / height - ratio) <= tolerance) return name;
    }
  }
  return stream.display_aspect_ratio ?? null;
}

function streamBitrate(raw, format, isAudio, metadata) {
  let rate = int32(raw.bit_rate) ?? 0;
  if (rate === 0 && isAudio && raw.codec_type === 'audio') rate = int32(format?.bit_rate) ?? 0;
  if (rate > 0) return rate;
  if (!['audio', 'video'].includes(raw.codec_type)) return null;
  rate = int32(metadata.get('bps-eng') ?? metadata.get('bps'));
  if (rate > 0) return rate;
  const duration = metadata.get('duration-eng') ?? metadata.get('duration');
  const bytes = metadata.get('number_of_bytes-eng') ?? metadata.get('number_of_bytes');
  const match = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/u.exec(duration ?? '');
  if (match && /^[+-]?\d+$/u.test(bytes ?? '')) {
    const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]) + Number(`0.${(match[5] ?? '').slice(0, 7)}`);
    if (seconds >= 1) {
      rate = roundEven(Number(BigInt(bytes) * 8n) / seconds);
      if (rate > 2147483647) throw new StorageError('invalid-response', 'Probe bitrate exceeds Int32.');
      if (rate > 0) return rate;
    }
  }
  return null;
}

function normalizeStream(raw, format, frames, isAudio) {
  if (!['audio', 'video', 'subtitle', 'data'].includes(raw.codec_type)) return null;
  const metadata = tags(raw.tags);
  const stream = { Type: { audio: 'Audio', video: 'Video', subtitle: 'Subtitle', data: 'Data' }[raw.codec_type],
    Index: raw.index ?? 0, Codec: raw.codec_name ?? null, Profile: raw.profile ?? null,
    Width: raw.width ?? null, Height: raw.height ?? null, Level: raw.level ?? null, PixelFormat: raw.pix_fmt ?? null,
    NalLengthSize: raw.nal_length_size ?? null, TimeBase: raw.time_base ?? null, CodecTimeBase: raw.codec_time_base ?? null,
    CodecTag: text(raw.codec_tag_string) && !raw.codec_tag_string.includes('[0]') ? raw.codec_tag_string : null,
    Language: metadata.get('language') ?? null, Comment: metadata.get('comment') ?? null, Title: metadata.get('title') ?? null,
    IsDefault: raw.disposition?.default === 1, IsForced: raw.disposition?.forced === 1,
    IsHearingImpaired: raw.disposition?.hearing_impaired === 1, IsOriginal: raw.disposition?.original === 1,
    IsExternal: false, IsInterlaced: false, BitRate: streamBitrate(raw, format, isAudio, metadata) };
  if (raw.codec_type === 'audio' || raw.codec_type === 'video') {
    stream.BitDepth = raw.bits_per_sample > 0 ? raw.bits_per_sample : raw.bits_per_raw_sample > 0 ? Number(raw.bits_per_raw_sample) : null;
  }
  if (raw.codec_type === 'audio') {
    stream.Channels = raw.channels ?? null;
    stream.SampleRate = int32(raw.sample_rate);
    stream.ChannelLayout = raw.channel_layout ? raw.channel_layout.split('(')[0] : null;
  }
  if (raw.codec_type === 'subtitle') {
    stream.Codec = ({ dvb_subtitle: 'DVBSUB', dvb_teletext: 'DVBTXT', dvd_subtitle: 'DVDSUB', hdmv_pgs_subtitle: 'PGSSUB' })[raw.codec_name?.toLowerCase()] ?? stream.Codec;
    if (!text(stream.Codec)) return null;
  }
  if (['audio', 'subtitle'].includes(raw.codec_type) && !stream.Title) {
    stream.Title = metadata.get('name') || null;
    const handler = metadata.get('handler_name');
    if (!stream.Title && handler && !same(handler, raw.codec_type === 'audio' ? 'SoundHandler' : 'SubtitleHandler')) stream.Title = handler;
  }
  if (raw.codec_type === 'video') {
    stream.IsAVC = raw.is_avc == null ? null : raw.is_avc === true || raw.is_avc === 'true';
    stream.AverageFrameRate = probeFrameRate(raw.avg_frame_rate);
    stream.RealFrameRate = probeFrameRate(raw.r_frame_rate);
    stream.IsInterlaced = text(raw.field_order) && !same(raw.field_order, 'progressive');
    if (isAudio || ['bmp', 'gif', 'png', 'webp'].some(codec => same(raw.codec_name, codec)) || same(raw.codec_name, 'mjpeg') && !text(stream.CodecTag)) stream.Type = 'EmbeddedImage';
    stream.AspectRatio = aspectRatio(raw);
    stream.BitDepth ??= ({ yuv420p: 8, yuv444p: 8, yuv420p10le: 10, yuv444p10le: 10, yuv420p12le: 12, yuv444p12le: 12 })[raw.pix_fmt?.toLowerCase()] ?? null;
    const sar = raw.sample_aspect_ratio?.split(':').map(Number), dar = raw.display_aspect_ratio;
    const nearSquare = sar?.length === 2 && sar[1] > 0 && Math.abs(sar[0] / sar[1] - 1) <= .01;
    stream.IsAnamorphic = !raw.sample_aspect_ratio && !dar || nearSquare ? false : raw.sample_aspect_ratio !== '0:1' ? true : dar === '0:1' ? false : dar !== aspectRatio({ ...raw, display_aspect_ratio: null });
    stream.RefFrames = raw.refs > 0 ? raw.refs : null;
    for (const [source, target] of Object.entries({ color_range: 'ColorRange', color_space: 'ColorSpace', color_transfer: 'ColorTransfer', color_primaries: 'ColorPrimaries' })) stream[target] = raw[source] || null;
    for (const side of raw.side_data_list ?? []) {
      if (same(side.side_data_type, 'DOVI configuration record')) {
        for (const [source, target] of Object.entries({ dv_version_major: 'DvVersionMajor', dv_version_minor: 'DvVersionMinor', dv_profile: 'DvProfile', dv_level: 'DvLevel', rpu_present_flag: 'RpuPresentFlag', el_present_flag: 'ElPresentFlag', bl_present_flag: 'BlPresentFlag', dv_bl_signal_compatibility_id: 'DvBlSignalCompatibilityId' })) stream[target] = side[source] ?? null;
      } else if (same(side.side_data_type, 'Display Matrix')) stream.Rotation = side.rotation ?? null;
      else if (same(side.side_data_type, 'Frame Cropping')) stream.IsAnamorphic = false;
    }
    const frame = frames.find(frame => frame.stream_index === stream.Index);
    stream.Hdr10PlusPresentFlag = frame?.side_data_list?.some(side => same(side.side_data_type, 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)')) ? true : null;
  }
  if (same(stream.Title, 'cc') || stream.Type === 'EmbeddedImage') stream.Title = null;
  return stream;
}

/** Native probe projection; refresh providers apply the resulting descriptive fields. */
export function normalizeProbe(raw, { path = null, protocol = 'Http', videoType = 'VideoFile', isAudio = false } = {}) {
  if (!raw || (raw.streams == null && raw.format == null)) throw new StorageError('invalid-response', 'Probe contains no media information.');
  const streams = (raw.streams ?? []).map(stream => normalizeStream(stream, raw.format, raw.frames ?? [], isAudio)).filter(Boolean);
  const attachments = (raw.streams ?? []).filter(stream => stream.codec_type === 'attachment' || stream.disposition?.attached_pic === 1).map(stream => {
    const metadata = tags(stream.tags);
    return { Index: stream.index ?? 0, Codec: stream.codec_name ?? null, CodecTag: text(stream.codec_tag_string) ? stream.codec_tag_string : null, FileName: metadata.get('filename') ?? null, MimeType: metadata.get('mimetype') ?? null, Comment: metadata.get('comment') ?? null, DeliveryUrl: null };
  });
  const format = raw.format;
  const container = text(format?.format_name) ? format.format_name.split(',').map(value => {
    if (same(value, 'mpegvideo')) return 'mpeg';
    if (same(value, 'mpegts')) return 'ts';
    if (same(value, 'matroska')) return 'mkv';
    if (same(value, 'webm') && streams.some(stream => !['Video', 'Audio'].includes(stream.Type) || !(stream.Type === 'Video' ? ['av1', 'vp8', 'vp9'] : ['opus', 'vorbis']).some(codec => same(stream.Codec, codec)))) return '';
    return value;
  }).filter(Boolean).join(',') : null;
  let bitrate = int32(format?.bit_rate);
  if (!isAudio) {
    for (const stream of streams) if (stream.Type === 'Audio' && stream.BitRate == null) stream.BitRate = estimatedAudioBitrate(stream.Codec, stream.Profile, stream.Channels);
    const videos = streams.filter(stream => stream.Type === 'Video');
    if (bitrate != null && videos.length === 1 && videos[0].BitRate == null && streams.filter(stream => stream.Type === 'Audio').every(stream => stream.BitRate != null)) {
      const estimated = bitrate - streams.filter(stream => stream.Type !== 'Video').reduce((total, stream) => total + (stream.BitRate ?? 0), 0);
      if (estimated > 0) videos[0].BitRate = estimated;
    }
    if (bitrate == null) {
      const sum = streams.reduce((total, stream) => total + (stream.BitRate ?? 0), 0);
      if (sum > 0) bitrate = sum;
    }
  }
  const audio = (raw.streams ?? []).find(stream => stream.codec_type === 'audio');
  const duration = isAudio ? audio ? audio.duration || format?.duration : null : format?.duration;
  let size = null;
  if (format?.size) {
    try { size = BigInt(format.size); }
    catch { throw new StorageError('invalid-response', 'Invalid probe size.'); }
    if (size < -9223372036854775808n || size > 9223372036854775807n) throw new StorageError('invalid-response', 'Probe size exceeds Int64.');
  }
  return { ...descriptiveProbeInfo(raw, { isAudio }), AudioTags: isAudio ? audioFileTagInfo(raw) : null,
    Path: path, Protocol: protocol, VideoType: videoType, Container: container, Size: size, Bitrate: bitrate,
    RunTimeTicks: duration ? ticks(duration) : null, MediaStreams: streams, MediaAttachments: attachments,
    Chapters: (raw.chapters ?? []).map(chapter => ({ Name: chapter.tags?.title ?? null, StartPositionTicks: Number.isFinite(Number(chapter.start_time)) ? BigInt(roundEven(Number(ticks(chapter.start_time)) / 10000)) * 10000n : 0n })) };
}
