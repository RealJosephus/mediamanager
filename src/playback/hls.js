import { startMediaProcess } from '../media-execution/process.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { StorageError, checkAbort } from '../storage/errors.js';
import { BinaryResult, singleRange } from '../http/binary-result.js';
import { videoColorRange } from '../library/media-streams.js';
import { remuxPlan, RemuxService } from './remux.js';
import { leaseDiscInput, resolveDiscInput } from '../media-execution/disc-input.js';
import { getEncodingThreadCount } from './media-encoder.js';
import { hlsArguments } from '../media-execution/streaming.js';
import { stageSubtitleBurn } from '../media-execution/subtitle-burn.js';
import { outputVideoBitrate } from '../media-execution/video.js';
import { matchesTranscodeJob as matchesJob, transcodingInfo } from './transcode-jobs.js';
import { LiveStreamReadBridge } from './live-stream-bridge.js';

export { hlsArguments };

const failure = (code, message) => new StorageError(code, message);
const lower = value => String(value ?? '').toLowerCase();
const liveInitUri = /#EXT-X-MAP:URI="[^"\r\n]+"/u;
const round = value => { const floor = Math.floor(value); return value - floor === 0.5 ? floor + floor % 2 : Math.round(value); };
const ticksPerSecond = 10000000n;
const int64Minimum = -(2n ** 63n);
const int64Maximum = 2n ** 63n - 1n;
const doubleBits = Buffer.allocUnsafe(8);
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeQueryValue = (value, preserveComma) => preserveComma ? encode(value).replaceAll('%2C', ',') : encode(value);
const json = value => JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value);
const cacheOwners = new Set();
const processExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const cachePlan = plan => ({
  container: plan.container,
  segmentLength: plan.segmentLength,
  runtime: plan.runtime,
  keyframeSegments: plan.keyframeSegments,
  streams: plan.streams.map(stream => [stream.type, stream.index]),
  audio: plan.audioOutput,
  videoOutput: plan.videoOutput,
  subtitle: plan.burnSubtitle?.Index,
  video: plan.video ? [lower(plan.video.Codec), String(plan.video.NalLengthSize ?? '')] : null,
});

function int64(value, field) {
  if (typeof value === 'number' && !Number.isSafeInteger(value) || !['bigint', 'number', 'string'].includes(typeof value) || !/^-?\d+$/.test(String(value))) throw new TypeError(`${field} must be an Int64.`);
  const result = BigInt(value);
  if (result < int64Minimum || result > int64Maximum) throw new RangeError(`${field} exceeds the Int64 range.`);
  return result;
}

function compareRationalPower10(numerator, denominator, exponent) {
  return exponent >= 0 ? numerator - denominator * 10n ** BigInt(exponent)
    : numerator * 10n ** BigInt(-exponent) - denominator;
}

function dotnetDoubleDecimal(value) {
  if (value === 0) return { digits: '0', decimalPosition: 1 };
  doubleBits.writeDoubleBE(value);
  const bits = doubleBits.readBigUInt64BE();
  const exponentBits = Number(bits >> 52n & 0x7ffn);
  const fraction = bits & (1n << 52n) - 1n;
  const significand = exponentBits === 0 ? fraction : fraction | 1n << 52n;
  const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  let numerator = significand, denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);

  let decimalExponent = Math.floor(Math.log10(value));
  while (compareRationalPower10(numerator, denominator, decimalExponent) < 0n) decimalExponent--;
  while (compareRationalPower10(numerator, denominator, decimalExponent + 1) >= 0n) decimalExponent++;
  const scale = 14 - decimalExponent;
  if (scale >= 0) numerator *= 10n ** BigInt(scale);
  else denominator *= 10n ** BigInt(-scale);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const comparison = remainder * 2n - denominator;
  if (comparison > 0n || comparison === 0n && rounded % 2n !== 0n) rounded++;
  if (rounded === 10n ** 15n) { rounded /= 10n; decimalExponent++; }
  return { digits: rounded.toString().padStart(15, '0'), decimalPosition: decimalExponent + 1 };
}

// .NET custom numeric formatting first converts Double to a 15-significant-
// digit decimal buffer with midpoint-to-even rounding, then rounds the fixed
// decimals away from zero. JavaScript's toFixed skips that first stage.
export function formatHlsDurationTicks(value) {
  const ticks = int64(value, 'HLS segment duration');
  const seconds = Number(ticks) / Number(ticksPerSecond);
  const negative = seconds < 0;
  const { digits, decimalPosition } = dotnetDoubleDecimal(Math.abs(seconds));
  const retainedDigits = decimalPosition + 6;
  let scaled = 0n;
  if (retainedDigits > 0) {
    const retained = digits.slice(0, retainedDigits).padEnd(retainedDigits, '0');
    scaled = BigInt(retained || '0');
    if (retainedDigits < digits.length && digits[retainedDigits] >= '5') scaled++;
  } else if (retainedDigits === 0 && digits[0] >= '5') scaled = 1n;
  const whole = scaled / 1000000n;
  const fraction = String(scaled % 1000000n).padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// The native playlist converts each TimeSpan duration to Double seconds and
// back to Int64 ticks for its URL parameters. Preserve that binary64 round
// trip, including midpoint-to-even conversion, instead of emitting the exact
// source delta when Double has already lost low bits.
export function hlsDurationUrlTicks(value) {
  const ticks = int64(value, 'HLS segment duration');
  const scaled = Number(ticks) / Number(ticksPerSecond) * Number(ticksPerSecond);
  if (!Number.isFinite(scaled)) throw new RangeError('HLS segment duration exceeds the Int64 range.');
  const negative = scaled < 0;
  const absolute = Math.abs(scaled);
  const floor = Math.floor(absolute);
  const fraction = absolute - floor;
  const rounded = fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  const result = (negative ? -1n : 1n) * BigInt(rounded);
  if (result < int64Minimum || result > int64Maximum) throw new RangeError('HLS segment duration exceeds the Int64 range.');
  return result;
}

const invariantFloat = value => {
  if (typeof value !== 'string' || !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|NaN|Infinity)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isFinite(Math.fround(parsed)) ? Math.fround(parsed) : undefined;
};

function ffmpegTimeSpanTicks(value) {
  const match = /^(-)?(?:(\d+)\.)?([0-1]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) return undefined;
  const fraction = BigInt((match[6] ?? '').padEnd(7, '0'));
  const ticks = (BigInt(match[2] ?? 0) * 86400n + BigInt(match[3]) * 3600n + BigInt(match[4]) * 60n + BigInt(match[5])) * ticksPerSecond + fraction;
  if (ticks > int64Maximum) return undefined;
  return match[1] ? -ticks : ticks;
}

function millisecondsToTicks(value) {
  const ticks = value * 10000;
  if (!Number.isFinite(ticks) || ticks < Number(int64Minimum) || ticks > Number(int64Maximum)) return undefined;
  const negative = ticks < 0, absolute = Math.abs(ticks), floor = Math.floor(absolute), fraction = absolute - floor;
  const rounded = fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  const result = (negative ? -1n : 1n) * BigInt(rounded);
  return result < int64Minimum || result > int64Maximum ? undefined : result;
}

// Mirrors the current Jellyfin JobLogger parser, including its single-space
// fps look-ahead and immediate size/bitrate token rules. FFmpeg's native
// status display is the compatibility surface: its displayed precision is
// intentionally retained instead of substituting the higher precision from
// the separate -progress protocol.
export function parseHlsProgressLine(line, runtimeTicks, startTimeTicks = 0n) {
  const runtime = runtimeTicks == null ? undefined : int64(runtimeTicks, 'HLS runtime');
  const start = int64(startTimeTicks, 'HLS start time');
  let framerate, completionPercentage, transcodingPositionTicks, bytesTranscoded, bitrate;
  const parts = line.split(' '), totalMs = runtime == null ? 0 : Number(runtime) / 10000, startMs = Number(start) / 10000;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], normalized = part.toLowerCase();
    if (normalized === 'fps=' && index + 1 < parts.length) framerate = invariantFloat(parts[index + 1]);
    else if (normalized.startsWith('fps=')) framerate = invariantFloat(part.slice(part.indexOf('=') + 1));
    else if (runtime != null && normalized.startsWith('time=')) {
      const elapsedTicks = ffmpegTimeSpanTicks(part.slice(part.indexOf('=') + 1));
      if (elapsedTicks != null) {
        const currentMs = startMs + Number(elapsedTicks) / 10000;
        completionPercentage = 100 * currentMs / totalMs;
        transcodingPositionTicks = millisecondsToTicks(currentMs);
        if (transcodingPositionTicks == null) completionPercentage = undefined;
      }
    } else if (normalized.startsWith('size=')) {
      let value = part.slice(part.indexOf('=') + 1);
      if (/kb/i.test(value)) {
        value = value.replace(/kb/gi, '');
        if (/^[+-]?\d+$/.test(value)) bytesTranscoded = BigInt.asIntN(64, BigInt(value) * 1024n);
      }
    } else if (normalized.startsWith('bitrate=')) {
      let value = part.slice(part.indexOf('=') + 1);
      if (/kbits\/s/i.test(value)) {
        value = value.replace(/kbits\/s/gi, '');
        const parsed = invariantFloat(value);
        if (parsed != null) bitrate = Math.ceil(Math.fround(Math.fround(parsed) * 1024));
      }
    }
  }
  if (framerate == null && completionPercentage == null) return undefined;
  return { TranscodingPositionTicks: transcodingPositionTicks, Framerate: framerate, CompletionPercentage: completionPercentage, BytesTranscoded: bytesTranscoded, Bitrate: bitrate };
}

export function createHlsProgressParser(runtimeTicks, startTimeTicks, report) {
  if (typeof report !== 'function') throw new TypeError('HLS progress requires a report callback.');
  let pending = '';
  const parse = line => { const progress = parseHlsProgressLine(line, runtimeTicks, startTimeTicks); if (progress) report(progress); };
  return {
    write(text) {
      pending += text;
      const lines = pending.split(/[\r\n]/); pending = lines.pop();
      for (const line of lines) parse(line);
    },
    end(text = '') { this.write(text); if (pending) parse(pending); pending = ''; }
  };
}

export function storedKeyframeData(row) {
  if (!row) return undefined;
  const text = row.KeyframeTicks;
  let ticks = [];
  if (text != null) {
    if (typeof text !== 'string') throw new TypeError('KeyframeData.KeyframeTicks must contain the native JSON primitive collection.');
    const body = text.trim();
    if (!/^\[(?:\s*|\s*-?(?:0|[1-9]\d*)\s*(?:,\s*-?(?:0|[1-9]\d*)\s*)*)\]$/.test(body)) throw new TypeError('KeyframeData.KeyframeTicks contains invalid native JSON.');
    const values = body.slice(1, -1).trim();
    if (values) ticks = values.split(',').map((value, index) => int64(value.trim(), `KeyframeData.KeyframeTicks[${index}]`));
  }
  return { TotalDuration: int64(row.TotalDuration, 'KeyframeData.TotalDuration'), KeyframeTicks: ticks };
}

export function computeKeyframeSegments(keyframeData, desiredSegmentLengthMs) {
  if (!Number.isSafeInteger(desiredSegmentLengthMs) || desiredSegmentLengthMs <= 0) throw new TypeError('A positive integral segment length is required.');
  const keyframes = keyframeData?.KeyframeTicks;
  if (!Array.isArray(keyframes)) throw new TypeError('KeyframeData.KeyframeTicks must be an array.');
  const frames = keyframes.map((value, index) => int64(value, `KeyframeData.KeyframeTicks[${index}]`));
  let totalDuration = int64(keyframeData.TotalDuration, 'KeyframeData.TotalDuration');
  if (frames.length && totalDuration < frames.at(-1)) totalDuration = frames.at(-1);
  const desiredSegmentLengthTicks = BigInt(desiredSegmentLengthMs) * 10000n;
  let lastKeyframe = 0n, desiredCutTime = desiredSegmentLengthTicks;
  const segments = [];
  for (const keyframe of frames) {
    if (keyframe < desiredCutTime) continue;
    segments.push(keyframe - lastKeyframe);
    lastKeyframe = keyframe;
    desiredCutTime += desiredSegmentLengthTicks;
  }
  const remaining = totalDuration - lastKeyframe;
  if (remaining > 0n) segments.push(remaining);
  return segments;
}

function keyframeTimeline(keyframeData, segmentLength) {
  if (!keyframeData) return {};
  const keyframeSegments = computeKeyframeSegments(keyframeData, segmentLength * 1000);
  // Native extractors do not persist an empty keyframe result. Treat a
  // malformed or manually inserted empty row as unavailable metadata so the
  // playlist retains a valid second-based target duration.
  if (!keyframeSegments.length) return {};
  const keyframeStarts = [];
  let start = 0n;
  for (const duration of keyframeSegments) { keyframeStarts.push(start); start += hlsDurationUrlTicks(duration); }
  return { keyframeSegments, keyframeStarts };
}

export function hlsPlan(source, options = {}, tools) {
  const container = lower(options.SegmentContainer ?? options.Container ?? 'ts');
  if (!['ts', 'mp4'].includes(container)) throw failure('not-supported', 'HLS requires MPEG-TS or fragmented MP4 segments.');
  const audioStreams = source.MediaStreams.filter(stream => stream.Type === 'Audio').sort((a, b) => a.Index - b.Index);
  const audioOnly = options.MediaType === 'Audio';
  const live = options.LiveInput === true && source.IsInfiniteStream === true;
  const audioIndex = (audioOnly ? undefined : audioStreams.find(stream => stream.Index === options.AudioStreamIndex)?.Index) ?? audioStreams.find(stream => stream.Channels > 0)?.Index ?? audioStreams[0]?.Index;
  const plan = remuxPlan(source, { ...options, AudioStreamIndex: live && audioIndex === -1 ? undefined : audioIndex, Container: container, StartTimeTicks: 0n, HlsManifest: true }, tools);
  const video = plan.inputVideo;
  const audio = source.MediaStreams.find(stream => stream.Type === 'Audio' && stream.Index === plan.streams.find(stream => stream.type === 'Audio')?.index);
  const textSubtitles = source.MediaStreams.filter(stream => stream.Type === 'Subtitle' && stream.IsTextSubtitleStream);
  const selectedSubtitle = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === options.SubtitleStreamIndex);
  // The current master endpoint does not bind EnableSubtitlesInManifest from
  // its query DTO. A separate subtitle rendition is therefore active only
  // when the selected delivery method itself is Hls.
  const subtitleGroup = textSubtitles.length > 0 && options.SubtitleMethod === 'Hls'
    && !(selectedSubtitle && options.SubtitleMethod === 'Encode');
  const externalHlsFormat = stream => ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'smi'].includes(lower(path.win32.extname(stream.Path ?? '').slice(1) || stream.Codec));
  const deliverable = stream => options.CanDeliverHlsSubtitle?.(stream) ?? (stream.IsExternal && externalHlsFormat(stream));
  if (!audioOnly && (!video || !['h264', 'hevc', 'av1', 'vp9'].includes(plan.videoOutput?.codec)) || plan.streams.some(stream => stream.type === 'Subtitle')
    || plan.videoOutput?.encoder === 'copy' && (video?.DvProfile != null || container === 'ts' && (video?.Rotation ?? 0) !== 0)
    || options.SubtitleMethod === 'Hls' && (!selectedSubtitle?.IsTextSubtitleStream || !deliverable(selectedSubtitle))
    || subtitleGroup && options.SubtitleMethod !== 'Drop' && textSubtitles.some(stream => !deliverable(stream))) throw failure('not-supported', 'This HLS stream requires an unavailable manifest or processing branch.');
  const rate = plan.videoOutput?.frameRate;
  const copy = plan.videoOutput?.encoder === 'copy';
  const mobileApple = /appletv|cfnetwork|ipad|iphone|ipod/iu.test(options.UserAgent ?? '');
  const segmentLength = options.SegmentLength ?? (!copy || live && !mobileApple ? 3 : 6);
  const runtime = BigInt(source.RunTimeTicks ?? 0);
  if (!Number.isSafeInteger(segmentLength) || segmentLength <= 0 || segmentLength > 86400 || !live && runtime <= 0n) throw failure('invalid-request', 'HLS requires a valid duration and a positive segment length.');
  if ((runtime + BigInt(segmentLength) * 10000000n - 1n) / (BigInt(segmentLength) * 10000000n) > 100000n) throw failure('invalid-request', 'The HLS playlist exceeds the supported segment count.');
  let playlistMilliseconds = segmentLength * 1000;
  if (!copy && rate && Math.abs(rate - Math.floor(rate + 0.001)) > 0.001) {
    playlistMilliseconds = Math.ceil(playlistMilliseconds * Math.ceil(rate) / rate);
  }
  const timeline = copy ? keyframeTimeline(options.KeyframeData, segmentLength) : {};
  if (timeline.keyframeSegments?.length > 100000) throw failure('invalid-request', 'The HLS playlist exceeds the supported segment count.');
  return { ...plan, video, audio, segmentLength, playlistSegmentTicks: BigInt(playlistMilliseconds) * 10000n,
    runtime, live, analyzeDurationMs: source.AnalyzeDurationMs, readAtNativeFramerate: source.ReadAtNativeFramerate,
    ignoreDts: source.IgnoreDts, ignoreIndex: source.IgnoreIndex, genPts: source.GenPtsInput,
    discardCorrupt: source.DiscardCorruptFrames, ...timeline };
}

function audioBitrate(audio, options) {
  if (!audio) return 0;
  const channels = audio.Channels ?? 2;
  return ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', ''].includes(lower(options.AudioCodec)) ? Math.min(options.AudioBitRate ?? 2147483647, channels >= 6 ? 640000 : channels * 128000) : ['alac', 'flac', 'truehd'].includes(lower(options.AudioCodec)) ? audio.BitRate ?? 0 : channels * 128000;
}

export function masterPlaylist(source, options = {}, query = '', tools) {
  const plan = hlsPlan(source, options, tools), { video, videoOutput, audio, audioOutput } = plan;
  const parameters = [...new URLSearchParams(query)];
  if (audioOutput) {
    const audioKey = parameters.find(entry => lower(entry[0]) === 'audiocodec');
    const codec = audioOutput.encoder === 'copy' ? 'copy' : audioOutput.codec;
    if (audioKey) audioKey[1] = codec; else parameters.push(['AudioCodec', codec]);
  }
  if (options.SegmentContainer && !parameters.some(([key]) => lower(key) === 'segmentcontainer')) parameters.push(['SegmentContainer', options.SegmentContainer]);
  const variant = (plan.live ? 'live.m3u8?' : 'main.m3u8?') + parameters.map(([key, value]) => `${encode(key)}=${encodeQueryValue(value, Boolean(video))}`).join('&');
  const videoCopied = videoOutput?.encoder === 'copy';
  const profile = lower(videoOutput?.profile ?? (videoCopied ? undefined : 'high'));
  const level = videoOutput?.level ?? (videoCopied ? undefined : { h264: 41, hevc: 120, av1: 8 }[videoOutput?.codec]);
  const suffix = level?.toString(16).toUpperCase().padStart(2, '0');
  const videoCodec = !level ? '' : ({
    h264: `avc1.${({ high: '6400', main: '4D40', baseline: '42E0' })[profile] ?? '4240'}${suffix}`,
    hevc: `hvc1.${['main10', 'main 10'].includes(profile) ? '2' : '1'}.4.L${level}.B0`,
    av1: `av01.0.${String(level).padStart(2, '0')}M.08`,
  })[videoOutput.codec];
  const audioCodec = audioOutput && ({
    aac: audioOutput.encoder === 'copy' && lower(audio.Profile) === 'he-aac' ? 'mp4a.40.5' : 'mp4a.40.2',
    mp3: 'mp4a.40.34', ac3: 'ac-3', eac3: 'ec-3', alac: 'alac', flac: 'fLaC', opus: 'opus', dts: 'dtsc', truehd: 'mlpa',
  })[audioOutput.codec];
  const bitrate = outputVideoBitrate(video, options, videoOutput?.codec) + (audioOutput?.encoder === 'copy'
    ? audioBitrate(audio, video ? options : { ...options, AudioCodec: 'copy' }) : audioOutput?.bitrate ?? 0);
  const [range, rangeType] = video ? videoCopied ? videoColorRange(video) : ['SDR', 'SDR'] : ['Unknown', 'Unknown'];
  const subtitles = source.MediaStreams.filter(stream => stream.Type === 'Subtitle' && stream.IsTextSubtitleStream);
  const selected = source.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === options.SubtitleStreamIndex);
  const subtitleGroup = subtitles.length > 0 && options.SubtitleMethod === 'Hls'
    && !(selected && options.SubtitleMethod === 'Encode') ? 'subs' : null;
  let line = `#EXT-X-STREAM-INF:BANDWIDTH=${bitrate},AVERAGE-BANDWIDTH=${bitrate}`;
  if (range !== 'Unknown') line += `,VIDEO-RANGE=${range === 'SDR' ? 'SDR' : rangeType.includes('HLG') || video.ColorTransfer === 'arib-std-b67' ? 'HLG' : 'PQ'}`;
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(',');
  if (codecs) line += `,CODECS="${codecs}"`;
  if (videoOutput?.width && videoOutput?.height) line += `,RESOLUTION=${videoOutput.width}x${videoOutput.height}`;
  const frameRate = video && (options.Framerate ?? (options.MaxFramerate != null ? Math.min(options.MaxFramerate, video.RealFrameRate ?? options.MaxFramerate) : video.RealFrameRate));
  if (frameRate) line += `,FRAME-RATE=${round(frameRate * 1000) / 1000}`;
  if (subtitleGroup) line += `,SUBTITLES="${subtitleGroup}"`;
  const lines = ['#EXTM3U'];
  if (subtitleGroup && options.SubtitleMethod !== 'Drop') {
    const token = options.AccessToken ?? parameters.find(([key]) => lower(key) === 'apikey')?.[1] ?? '';
    const mediaSourceId = options.MediaSourceId ?? source.Id;
    const selectedIndex = options.SubtitleMethod === 'Hls' ? selected?.Index : undefined;
    for (const stream of subtitles) lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${stream.DisplayTitle ?? ''}",DEFAULT=${stream.Index === selectedIndex ? 'YES' : 'NO'},FORCED=${stream.IsForced ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${mediaSourceId}/Subtitles/${stream.Index}/subtitles.m3u8?SegmentLength=30&ApiKey=${token}",LANGUAGE="${stream.Language ?? 'Unknown'}"`);
  }
  lines.push(line, variant, '');
  return lines.join('\r\n');
}

export function subtitlePlaylist(source, segmentLength, accessToken = '') {
  const runtime = BigInt(source.RunTimeTicks ?? -1);
  if (runtime <= 0n) throw failure('invalid-request', 'HLS subtitles are not supported for this media.');
  if (!Number.isSafeInteger(segmentLength) || segmentLength <= 0 || segmentLength > 86400) throw failure('invalid-request', 'The subtitle segment length must be positive.');
  const segmentTicks = BigInt(segmentLength) * 10000000n;
  if ((runtime + segmentTicks - 1n) / segmentTicks > 100000n) throw failure('invalid-request', 'The HLS subtitle playlist exceeds the supported segment count.');
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${segmentLength}`, '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let position = 0n; position < runtime; position += segmentTicks) {
    const length = runtime - position < segmentTicks ? runtime - position : segmentTicks;
    const seconds = Number(length) / 10000000;
    const end = runtime < position + segmentTicks ? runtime : position + segmentTicks;
    lines.push(`#EXTINF:${seconds},`, `stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=${position}&EndPositionTicks=${end}&ApiKey=${accessToken}`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\r\n');
}

export function mainPlaylist(source, options = {}, query = '', tools) {
  const plan = hlsPlan(source, options, tools), length = plan.playlistSegmentTicks;
  const suffix = query ? '?' + query.replace(/^\?/, '') + '&' : '?';
  const segment = (index, start, duration) => `hls1/main/${index}.${plan.container}${suffix}runtimeTicks=${start}&actualSegmentLengthTicks=${duration}`;
  const durations = plan.keyframeSegments ?? Array.from({ length: Number((plan.runtime + length - 1n) / length) }, (_, index) => {
    const start = BigInt(index) * length;
    return plan.runtime - start < length ? plan.runtime - start : length;
  });
  const maximum = durations.reduce((left, right) => left > right ? left : right);
  const lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-VERSION:${plan.container === 'mp4' ? 7 : 3}`, `#EXT-X-TARGETDURATION:${Math.ceil(Number(maximum) / Number(ticksPerSecond))}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  if (plan.container === 'mp4') lines.push(`#EXT-X-MAP:URI="${segment(-1, 0, 0)}"`);
  let start = 0n;
  for (let index = 0; index < durations.length; index++) {
    const duration = durations[index];
    const urlDuration = hlsDurationUrlTicks(duration);
    lines.push(`#EXTINF:${formatHlsDurationTicks(duration)}, nodesc`, segment(index, start, urlDuration));
    start += urlDuration;
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\r\n');
}

const exists = async file => stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
const assertJobDirectory = (root, directory) => {
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('mediamanager-hls-')) throw new Error('Invalid HLS cache directory.');
};
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'HLS cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(name => errors[0]?.[name] !== undefined).map(name => [name, errors[0][name]])));

export class HlsService {
  #jobs = new Map();
  #events = new Map();
  #liveBridge;
  #activity = new Map();
  #closed = false;
  #closing;
  #lifetime = new AbortController();
  #pending = new Set();
  #launchTail = Promise.resolve();
  #cacheReady;
  #initializations = new Set();
  #owner = randomUUID();
  #cleanup = new Set();
  constructor({ vfs, bridge, remux, mediaEncoder, getCacheDirectory, getEncodingOptions, maxConcurrentJobs = 4, idleTimeoutMs = 60000, timeoutMs = 21600000, onError = () => {}, onProcess = () => {}, onProgress = () => {}, onEventStop }) {
    if (!vfs) throw new TypeError('HLS requires VFS.');
    if (!mediaEncoder) throw new TypeError('HLS requires its startup media encoder.');
    if (typeof getCacheDirectory !== 'function' || typeof getEncodingOptions !== 'function') throw new TypeError('HLS requires current encoding and transcode directory callbacks.');
    for (const value of [maxConcurrentJobs, idleTimeoutMs, timeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Positive HLS limits are required.');
    Object.assign(this, { vfs, mediaEncoder, remux: remux ?? new RemuxService({ vfs, bridge, mediaEncoder }), ownsRemux: !remux, getCacheDirectory, getEncodingOptions, maxConcurrentJobs, idleTimeoutMs, timeoutMs, onError, onProcess, onProgress, onEventStop });
    cacheOwners.add(this.#owner);
  }
  #track(operation) {
    if (this.#closed) return Promise.reject(failure('closed', 'HLS is closed.'));
    const pending = Promise.resolve().then(() => { checkAbort(this.#lifetime.signal); return operation(); });
    this.#pending.add(pending);
    const finish = () => this.#pending.delete(pending); pending.then(finish, finish);
    return pending;
  }
  async initialize() { return (await this.#initialize()).available; }
  #initialize() {
    return this.#track(async () => {
      const initialization = {}; this.#initializations.add(initialization);
      try {
        const directory = path.resolve(await this.getCacheDirectory()); this.#lifetime.signal.throwIfAborted();
        let ready = this.#cacheReady;
        if (ready?.directory !== directory) {
          ready = { directory, promise: this.#prepareCache(directory) }; this.#cacheReady = ready;
          ready.promise.catch(() => { if (this.#cacheReady === ready) this.#cacheReady = undefined; });
        }
        await ready.promise; this.#lifetime.signal.throwIfAborted();
        const available = this.mediaEncoder.ready; this.#lifetime.signal.throwIfAborted();
        return { directory, available };
      } catch (error) {
        if (!this.#lifetime.signal.aborted || error !== this.#lifetime.signal.reason) initialization.error = error;
        throw error;
      } finally { if (!Object.hasOwn(initialization, 'error')) this.#initializations.delete(initialization); }
    });
  }
  async #prepareCache(root) {
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^mediamanager-hls-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name);
      try {
        const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
        if (owner.kind !== 'mediamanager-hls' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.id !== 'string') continue;
        if (owner.pid === process.pid ? cacheOwners.has(owner.id) : processExists(owner.pid)) continue;
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) this.onError(error); }
    }
  }
  mediaTools(configuration = this.getEncodingOptions()) {
    return { configuration, capabilities: this.mediaEncoder.capabilities, version: this.mediaEncoder.version, subtitleBurn: this.remux.subtitleBurn };
  }
  plan(source, options, configuration = this.getEncodingOptions()) {
    return hlsPlan(source, options, this.mediaTools(configuration));
  }
  supports(source, options) { if (!this.remux.available || this.#closed) return false; try { this.plan(source, options); return true; } catch { return false; } }
  get jobs() { return this.remux.jobs; }
  hasJob(playSessionId) { return this.jobs.hasJob(playSessionId); }
  getTranscodingInfo(deviceId) { return this.jobs.getTranscodingInfo(deviceId); }
  #describe(job) {
    const { video, audio, audioOutput } = job.plan;
    const bitrate = outputVideoBitrate(video, job.options, job.plan.videoOutput?.codec)
      + (audioOutput?.encoder === 'copy' ? audioBitrate(audio, job.options) : audioOutput?.bitrate ?? 0);
    return transcodingInfo(job.plan, job.options, job.progress, this.getEncodingOptions().HardwareAccelerationType, bitrate);
  }

  #reportProgress(job, progress, phase) {
    job.progress = progress;
    try { this.onProgress({ phase, sequence: job.sequence, DeviceId: job.options.DeviceId, PlaySessionId: job.options.PlaySessionId, ...(progress ?? {}) }); }
    catch (error) { this.onError(error); }
  }
  ping(playSessionId, isPaused) { this.jobs.ping(playSessionId, isPaused); }
  #touch(job) {
    clearTimeout(job.idle);
    if (job.exited && !job.eventId || job.eventId && job.readers || !job.active || job.controller.signal.aborted) return;
    job.idle = setTimeout(() => { this.#remove(job).catch(error => this.onError(error)); }, this.idleTimeoutMs); job.idle.unref();
  }
  #activityKey(options) {
    if (options.PlaySessionId?.trim()) return `session:${lower(options.PlaySessionId)}`;
    if (options.DeviceId?.trim()) return `device:${lower(options.DeviceId)}`;
  }
  #retainActivity(job) {
    const key = this.#activityKey(job.options); if (!key) return;
    if (this.#activity.has(key)) this.#forgetActivity(key);
    const activity = { active: true, plan: job.plan, options: job.options, sequence: job.sequence };
    this.#activity.set(key, activity);
    this.jobs.register(activity, { describe: () => this.#describe(activity), stop: () => this.#forgetActivity(key) });
  }
  #forgetActivity(key) {
    this.jobs.unregister(this.#activity.get(key));
    this.#activity.delete(key);
  }
  #dropActivity(deviceId, playSessionId) {
    for (const [key, activity] of this.#activity) if (matchesJob(activity, deviceId, playSessionId)) this.#forgetActivity(key);
  }
  async #remove(job) {
    if (job.removing) return job.removing;
    job.controller.abort(); clearTimeout(job.idle); clearInterval(job.cleaner); this.#jobs.delete(job.key); this.jobs.unregister(job);
    if (job.eventId) this.#events.delete(job.eventId);
    const cleanup = {};
    job.removing = (async () => {
      await job.tail; await Promise.all([...job.pendingReaders]);
      const errors = []; let directory;
      try { await job.done; } catch (error) { errors.push(error); }
      if (job.eventId && job.options.LiveStreamId && job.done) {
        try { await this.onEventStop?.(job.options.LiveStreamId, job.options.PlaySessionId); }
        catch (error) { errors.push(error); }
      }
      try { directory = await job.directory; } catch (error) { errors.push(error); }
      if (directory !== undefined) try {
        assertJobDirectory(job.cacheDirectory, directory);
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (error) { errors.push(error); }
      if (errors.length) throw operationFailure(errors);
    })();
    cleanup.promise = job.removing; this.#cleanup.add(cleanup);
    job.removing.then(() => this.#cleanup.delete(cleanup), error => { cleanup.error = error; this.onError(error); });
    return job.removing;
  }
  async stop(deviceId, playSessionId) { await this.jobs.stop(deviceId, playSessionId); }
  #createJob({ key, plan, options, source, virtualPath, version, cacheDirectory, openRead, eventId, disc }) {
    if (this.#closed) throw failure('closed', 'HLS is closed.');
    if ([...this.#jobs.values()].filter(value => !value.exited && !matchesJob(value, options.DeviceId, options.PlaySessionId)).length >= this.maxConcurrentJobs) throw failure('busy', 'The HLS concurrency limit has been reached.');
    const job = { key, plan, options, source, virtualPath, version, cacheDirectory, openRead, eventId, disc,
      controller: new AbortController(), readers: 0, pendingReaders: new Set(), tail: Promise.resolve() };
    job.directory = mkdtemp(path.join(cacheDirectory, 'mediamanager-hls-')).then(async directory => {
      try { await writeFile(path.join(directory, 'owner.json'), json({ kind: 'mediamanager-hls', pid: process.pid, id: this.#owner })); return directory; }
      catch (error) {
        assertJobDirectory(cacheDirectory, directory);
        try { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
        catch (cleanup) { throw operationFailure([error, cleanup]); }
        throw error;
      }
    });
    job.directory.catch(() => {});
    this.#jobs.set(key, job);
    if (eventId) this.#events.set(eventId, job);
    this.jobs.register(job, {
      describe: () => this.#describe(job), stop: () => this.#remove(job),
      ping: isPaused => { if (isPaused != null) job.isPaused = isPaused; this.#touch(job); },
    });
    return job;
  }

  async #withEventReader(job, request, response, operation) {
    const reader = new AbortController();
    const cancel = () => { if (!response.writableFinished) reader.abort(); };
    request.once('aborted', cancel); response.once('close', cancel);
    if (request.aborted || response.destroyed) cancel();
    const signal = AbortSignal.any([reader.signal, job.controller.signal, this.#lifetime.signal]);
    const finished = Promise.withResolvers();
    job.readers++; clearTimeout(job.idle); job.pendingReaders.add(finished.promise);
    try { return await operation(signal); }
    finally {
      request.removeListener('aborted', cancel); response.removeListener('close', cancel);
      job.readers--; job.pendingReaders.delete(finished.promise); finished.resolve();
      if (!job.readers && (!job.active || job.error && !job.served)) await this.#remove(job);
      else this.#touch(job);
    }
  }

  eventPlaylist(source, virtualPath, options, request, response, { openRead } = {}) {
    return this.#track(async () => {
      const configuration = this.getEncodingOptions();
      const plan = { ...this.plan(source, options, configuration), execution: {
        threads: getEncodingThreadCount(configuration, options.CpuCoreLimit), version: this.mediaEncoder.version,
        maxMuxingQueueSize: Math.max(128, configuration.MaxMuxingQueueSize ?? 128),
      } };
      const { directory: cacheDirectory, available } = await this.#initialize();
      if (!available) throw failure('unavailable', 'The HLS process is unavailable.');
      let version;
      const disc = !openRead && plan.discInput ? await resolveDiscInput(this.vfs, source.VideoType, virtualPath, this.#lifetime.signal) : undefined;
      if (!openRead) {
        if (disc) version = plan.burnSubtitle?.Path ? undefined : disc.version;
        else {
          const info = await this.vfs.stat(virtualPath, { signal: this.#lifetime.signal });
          if (this.vfs.capabilities(virtualPath).reliableVersion && !plan.burnSubtitle?.Path) version = info.version;
        }
      }
      const key = createHash('sha256').update(json(['event', cacheDirectory, source.LiveStreamId ? [source.LiveStreamId, source.Path] : virtualPath,
        version, request.headers['user-agent'], options.DeviceId, options.PlaySessionId, cachePlan(plan)])).digest('hex');
      const current = this.#jobs.get(key);
      const job = current ?? this.#createJob({ key, plan, options, source, virtualPath, version, cacheDirectory, openRead, disc,
        eventId: randomUUID().replaceAll('-', '') });
      await this.#withEventReader(job, request, response, async signal => {
        const directory = await job.directory, playlist = path.join(directory, 'main.m3u8');
        if (!job.eventStart) {
          job.eventStart = this.#start(job, plan, options, 0, 0n, undefined, signal);
          job.eventStart.catch(() => {});
        }
        await job.eventStart;
        const minSegments = current ? 0 : options.MinSegments ?? (plan.segmentLength >= 10 ? 2 : 3);
        let text;
        while (true) {
          checkAbort(signal);
          if (job.error) throw job.error;
          try { text = await readFile(playlist, 'utf8'); }
          catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; }
          if (text && (job.exited || (text.match(/^#EXTINF:/gmu)?.length ?? 0) >= minSegments)) break;
          if (job.exited) throw failure('not-found', 'The event playlist was not produced.');
          await delay(50, undefined, { signal });
        }
        if (plan.container === 'mp4') text = text.replace(liveInitUri, `#EXT-X-MAP:URI="hls/${job.eventId}/${job.eventId}-1.mp4"`);
        response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        response.end(text); job.served = true;
      });
    });
  }

  eventArtifact(playlistId, filename, isPlaylist = false) {
    const job = this.#events.get(lower(playlistId));
    if (!job || (!isPlaylist && !new RegExp(`^${job.eventId}(?:[0-9]+${job.plan.container === 'mp4' ? '|-1' : ''})\\.${job.plan.container}$`, 'u').test(filename))) return null;
    return new BinaryResult((request, response) => this.#track(async () => {
      await this.#withEventReader(job, request, response, async signal => {
        checkAbort(signal);
        const file = path.join(await job.directory, isPlaylist ? 'main.m3u8' : filename);
        if (!await exists(file)) throw Object.assign(failure('not-found', 'Hls segment not found.'), { status: 404 });
        if (isPlaylist) {
          let text = (await readFile(file, 'utf8')).replaceAll(`hls/${job.eventId}/`, '');
          if (job.plan.container === 'mp4') text = text.replace(liveInitUri, `#EXT-X-MAP:URI="${job.eventId}-1.mp4"`);
          response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          response.end(text);
        } else await this.#send(file, job.plan.mime, request, response, signal);
      });
    }));
  }
  segment(source, virtualPath, options, index, request, response, { signal } = {}) {
    const current = this.getEncodingOptions();
    const execution = { threads: getEncodingThreadCount(current, options.CpuCoreLimit), version: this.mediaEncoder.version,
      maxMuxingQueueSize: current.MaxMuxingQueueSize > 128 ? current.MaxMuxingQueueSize : 128 };
    return this.#track(() => this.#segment(source, virtualPath, options, current, execution, index, request, response,
      AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])])));
  }
  async #segment(source, virtualPath, options, configuration, execution, index, request, response, signal) {
    const plan = { ...this.plan(source, options, configuration), execution };
    const runtimeTicks = BigInt(options.CurrentRuntimeTicks ?? 0);
    if (BigInt(options.StartTimeTicks ?? 0) > 0n) throw failure('invalid-request', 'StartTimeTicks is not allowed for HLS segments.');
    if (!Number.isSafeInteger(index) || index < -1 || index === -1 && plan.container !== 'mp4' || runtimeTicks < 0n) throw failure('invalid-request', 'The HLS segment is invalid.');
    const { directory: cacheDirectory, available } = await this.#initialize();
    if (!available) throw failure('unavailable', 'The HLS process is unavailable.');
    const disc = plan.discInput ? await resolveDiscInput(this.vfs, source.VideoType, virtualPath, signal) : undefined;
    const before = disc ? undefined : await this.vfs.stat(virtualPath, { signal }); checkAbort(signal);
    const inputVersion = disc ? disc.version : this.vfs.capabilities(virtualPath).reliableVersion === true ? before.version : null;
    const version = plan.burnSubtitle?.Path ? null : inputVersion;
    // The native cache identity uses the source, user agent, device and play session.
    // Pin the VFS version and byte-producing plan so a changed object, selected stream,
    // segment length, muxer or segment-number timeline cannot reuse earlier output.
    // Canonical playlist segments share an offset of zero across their distinct ticks.
    const canonicalStart = index >= 0 && plan.keyframeStarts?.[index] != null ? plan.keyframeStarts[index] : BigInt(Math.max(index, 0)) * plan.playlistSegmentTicks;
    const timelineOffset = runtimeTicks - canonicalStart;
    const key = createHash('sha256').update(json([cacheDirectory, virtualPath, version, request.headers['user-agent'], options.DeviceId, options.PlaySessionId, cachePlan(plan), timelineOffset])).digest('hex');
    const job = this.#jobs.get(key) ?? this.#createJob({ key, plan, options, source, virtualPath, version, cacheDirectory, disc });
    job.readers++; if (!job.options.PlaySessionId?.trim()) clearTimeout(job.idle);
    let finishReader;
    const finished = new Promise(resolve => { finishReader = resolve; }); job.pendingReaders.add(finished);
    const previous = job.tail; let unlock; job.tail = new Promise(resolve => { unlock = resolve; });
    const combined = AbortSignal.any([job.controller.signal, ...(signal ? [signal] : [])]);
    // A weak source is copied again for each non-overlapping response group.
    // Audio fMP4 fragments must still share the initialization segment's zero
    // origin. Starting a later fragment as a new file resets its decode clock,
    // and the normal end-of-file seek clamp can also repeat earlier packets.
    // Rebuild the canonical audio timeline and select the requested fragment;
    // retain the ordinary seek branch for explicit noncanonical timelines.
    const segmentTicks = BigInt(plan.segmentLength) * ticksPerSecond;
    const audioFromOrigin = job.version == null && !plan.video && plan.container === 'mp4' && timelineOffset === 0n
      && BigInt(Math.max(index, 0)) < (plan.runtime + segmentTicks - 1n) / segmentTicks;
    const copyStartNumber = audioFromOrigin ? 0 : Math.max(index, 0);
    const copyRuntimeTicks = audioFromOrigin ? 0n : runtimeTicks;
    try {
      await previous; checkAbort(combined);
      const directory = await job.directory, file = path.join(directory, `segment${index}.${plan.container}`);
      let started = false;
      if (!await exists(file)) {
        const numbers = (await readdir(directory)).map(name => new RegExp(`^segment(\\d+)\\.${plan.container}$`).exec(name)?.[1]).filter(value => value != null).map(Number);
        const current = job.exited ? undefined : numbers.length ? Math.max(...numbers) : job.plan.container === plan.container ? job.startNumber : undefined;
        const requestedIndex = Math.max(index, 0);
        if (current == null || requestedIndex < current || requestedIndex - current > 24 / plan.segmentLength || job.exited) {
          await this.#start(job, plan, options, copyStartNumber, copyRuntimeTicks, current, combined);
          started = true;
        }
      }
      const next = path.join(directory, `segment${index + 1}.${plan.container}`);
      while (true) {
        checkAbort(combined);
        if (job.error && job.active) throw job.error;
        if (await exists(file) && (job.exited || await exists(next))) break;
        if (job.exited) {
          if (await exists(file)) break;
          // A process can finish between selection and waiting. Reevaluate the
          // missing segment once using this request's selected copy origin.
          if (!started) { await this.#start(job, plan, options, copyStartNumber, copyRuntimeTicks, undefined, combined); started = true; continue; }
          throw new StorageError('not-found', 'The HLS segment was not produced.', { startNumber: job.startNumber, segment: index, files: await readdir(directory) });
        }
        await delay(25, undefined, { signal: combined });
      }
      // Selection and process changes are serialized, but response backpressure
      // must not block a reader that prefetches another segment before draining
      // this one. Keep the reader lease until its HTTP pipeline has settled.
      unlock();
      await this.#send(file, plan.mime, request, response, combined); job.served = true;
      const downloaded = runtimeTicks + BigInt(options.ActualSegmentLengthTicks ?? 0);
      if (downloaded > (job.downloadPositionTicks ?? 0n)) job.downloadPositionTicks = downloaded;
    } finally {
      unlock(); job.readers--; job.pendingReaders.delete(finished); finishReader();
      // Without a reliable object version, cached output is valid only for the
      // overlapping request group that observed the same running job.
      if (!job.readers && (job.version == null || !job.done)) {
        if (job.version == null && job.served && !job.controller.signal.aborted && !this.#closed) this.#retainActivity(job);
        await this.#remove(job);
      }
      else if (!job.readers) this.#touch(job);
    }
  }
  async #start(job, plan, options, startNumber, runtimeTicks, current, signal) {
    const previous = this.#launchTail; let unlock; this.#launchTail = new Promise(resolve => { unlock = resolve; });
    try {
      await previous; checkAbort(signal);
      this.#dropActivity(job.options.DeviceId, job.options.PlaySessionId);
      for (const other of this.#jobs.values()) if (other !== job && matchesJob(other, job.options.DeviceId, job.options.PlaySessionId)) {
        other.active = false; clearTimeout(other.idle); other.processController?.abort(); await other.done;
      }
      if ([...this.#jobs.values()].filter(value => value !== job && value.active && !value.exited).length >= this.maxConcurrentJobs) throw failure('busy', 'The HLS concurrency limit has been reached.');
      job.processController?.abort(); await job.done;
      if (current != null) await unlink(path.join(await job.directory, `segment${current}.${plan.container}`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      checkAbort(signal);
      job.error = undefined; job.exited = false; job.active = true; job.plan = plan; job.options = options; job.startNumber = startNumber;
      this.jobs.activate(job);
      this.#reportProgress(job, undefined, 'start');
      job.done = this.#run(job, startNumber, runtimeTicks);
      // The job owner observes completion even when a resource failure occurs
      // between a reader's polling iterations. Removal still awaits this task.
      job.done.catch(() => {});
    } finally { unlock(); }
  }
  async #run(job, startNumber, runtimeTicks) {
    const controller = new AbortController(); job.processController = controller;
    const signal = AbortSignal.any([job.controller.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(failure('timeout', 'HLS processing timed out.')), this.timeoutMs); timer.unref();
    let lease, child, subtitles;
    try {
      if (job.plan.live && job.source.BufferMs > 0) await delay(job.source.BufferMs, undefined, { signal });
      if (job.openRead) {
        this.#liveBridge ??= new LiveStreamReadBridge();
        lease = await this.#liveBridge.lease(job.openRead, { signal });
      } else if (job.disc) lease = await leaseDiscInput(this.remux.bridge, job.disc, this.mediaEncoder, { signal, expiresInMs: this.timeoutMs });
      else lease = await this.remux.bridge.lease(job.virtualPath, { version: job.version, signal, expiresInMs: this.timeoutMs });
      subtitles = await stageSubtitleBurn(this.remux.subtitleBurn, job.source, job.plan.burnSubtitle, job.virtualPath, signal);
      const args = hlsArguments(lease.url, job.plan, await job.directory, startNumber, runtimeTicks, job.plan.execution, subtitles, job.eventId);
      checkAbort(signal);
      const overrides = job.plan.videoOutput?.hardware?.environment;
      const environment = overrides ? { ...(this.mediaEncoder.environment ?? process.env), ...overrides } : this.mediaEncoder.environment;
      child = startMediaProcess(this.mediaEncoder.encoderPath, args, { environment, cwd: subtitles?.cwd, output: 'ignore' });
      if (job.plan.video && job.plan.runtime >= 3000000000n) {
        job.cleaner = setInterval(() => {
          if (job.cleaning || job.exited) return;
          job.cleaning = this.#cleanSegments(job, signal).catch(error => { if (!signal.aborted) this.onError(error); }).finally(() => { job.cleaning = undefined; });
        }, 20000); job.cleaner.unref();
      }
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
      let diagnostics = ''; const decoder = new StringDecoder('utf8');
      const progressParser = createHlsProgressParser(job.plan.runtime, runtimeTicks, progress => this.#reportProgress(job, progress, 'progress'));
      const consume = text => {
        diagnostics = (diagnostics + text).slice(-8192); progressParser.write(text);
      };
      child.stderr.on('data', bytes => consume(decoder.write(bytes)));
      try {
        this.onProcess({ pid: child.pid, args: args.map(value => value === lease.url ? '[private source]' : value) });
        const code = await done; const finalText = decoder.end(); diagnostics = (diagnostics + finalText).slice(-8192); progressParser.end(finalText); checkAbort(signal);
        if (code !== 0) throw new StorageError('invalid-response', 'The HLS streams could not be processed.', { exitCode: code,
          diagnostic: lease.redact?.(diagnostics) ?? diagnostics.replaceAll(lease.url, '[private source]') });
        if (job.disc) await job.disc.verify(signal);
        else if (job.version != null && (await this.vfs.stat(job.virtualPath, { signal })).version !== job.version) throw failure('version-changed', 'The HLS source changed.');
      } finally { signal.removeEventListener('abort', abort); child.kill(); await done.catch(() => {}); }
    } catch (error) { job.error = signal.aborted ? signal.reason ?? failure('cancelled', 'HLS was cancelled.') : error; }
    finally {
      clearTimeout(timer); clearTimeout(job.idle); clearInterval(job.cleaner);
      const errors = [];
      try { await job.cleaning; } catch (error) { errors.push(error); }
      try { await subtitles?.release(); } catch (error) { errors.push(error); }
      try { await lease?.release(); } catch (error) { errors.push(error); }
      job.exited = true;
      if (job.eventId) this.#touch(job);
      try { this.#reportProgress(job, undefined, 'exit'); } catch (error) { errors.push(error); }
      if (errors.length) {
        job.error = operationFailure(job.error ? [job.error, ...errors] : errors);
        throw job.error;
      }
    }
  }
  async #cleanSegments(job, signal) {
    const options = this.getEncodingOptions();
    if (!options.EnableSegmentDeletion) return;
    const keep = Math.max(options.SegmentKeepSeconds ?? 720, 20), downloaded = round(Number(job.downloadPositionTicks ?? 0n) / 10000000);
    const maximum = Math.floor((downloaded - keep) / job.plan.segmentLength);
    if (maximum <= 0) return;
    await delay(1500, undefined, { signal });
    const directory = await job.directory;
    for (const name of await readdir(directory)) {
      const match = /^segment(\d+)\.(?:ts|mp4)$/.exec(name);
      if (match && Number(match[1]) <= maximum) await unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') this.onError(error); });
    }
  }
  async #send(file, mime, request, response, signal) {
    const info = await stat(file), modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
    response.setHeader('Last-Modified', modified.toUTCString());
    const since = Date.parse(request.headers['if-modified-since']), unmodified = Date.parse(request.headers['if-unmodified-since']);
    if (unmodified <= Date.now() && modified.getTime() > unmodified) { response.statusCode = 412; response.setHeader('Content-Length', '0'); response.end(); return; }
    if (since <= Date.now() && modified.getTime() <= since) { response.statusCode = 304; response.end(); return; }
    response.setHeader('Content-Type', mime); response.setHeader('Accept-Ranges', 'bytes');
    let range;
    try { if (!request.headers['if-range'] || Date.parse(request.headers['if-range']) >= modified.getTime()) range = singleRange(request.headers.range); }
    catch (error) {
      if (/^bytes\s*=\s*-0\s*$/i.test(request.headers.range ?? '')) { response.statusCode = 416; response.setHeader('Content-Range', `bytes */${info.size}`); response.setHeader('Content-Length', '0'); response.end(); return; }
      if (error.code !== 'not-supported' && error.code !== 'range-not-satisfiable') throw error;
    }
    let start = 0n, end = BigInt(info.size) - 1n;
    if (range) { start = range.suffix != null ? (range.suffix > BigInt(info.size) ? 0n : BigInt(info.size) - range.suffix) : range.start; end = range.end == null || range.end > end ? end : range.end;
      if (start > end) { response.statusCode = 416; response.setHeader('Content-Range', `bytes */${info.size}`); response.setHeader('Content-Length', '0'); response.end(); return; }
      response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    response.setHeader('Content-Length', String(end - start + 1n));
    if (request.method === 'HEAD') { response.end(); return; }
    try { await pipeline(createReadStream(file, { start: Number(start), end: Number(end) }), response, { signal }); }
    catch (error) { if (!response.writableFinished || error.code !== 'ABORT_ERR') throw error; }
  }
  close() {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    this.#closed = true; this.#lifetime.abort(failure('cancelled', 'Storage operation was cancelled.'));
    for (const key of this.#activity.keys()) this.#forgetActivity(key);
    void (async () => {
      const errors = [], removing = [...this.#jobs.values()].map(job => this.#remove(job));
      await Promise.allSettled(removing);
      // Initializers can still be awaiting the path callback, and accepted
      // readers can be between initialization and taking their job lease.
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      const cleanup = [...this.#cleanup]; await Promise.allSettled(cleanup.map(operation => operation.promise));
      errors.push(...cleanup.filter(operation => Object.hasOwn(operation, 'error')).map(operation => operation.error));
      errors.push(...[...this.#initializations].map(initialization => initialization.error));
      cacheOwners.delete(this.#owner);
      try { await this.#liveBridge?.close(); } catch (error) { errors.push(error); }
      if (this.ownsRemux) try { await this.remux.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw operationFailure(errors);
    })().then(completion.resolve, completion.reject);
    return this.#closing;
  }
}
