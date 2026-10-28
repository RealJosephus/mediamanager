import { guid } from '../library/records.js';
import { member } from '../http/binding.js';
import { stringifyNativeJson, withNativeFloats } from '../core/json.js';
import { videoColorRange } from '../library/media-streams.js';
import { isExternalSubtitleFallback, subtitleInputFormat } from './subtitle-source.js';
import { supportsSubtitleTextConversion } from './subtitles.js';

const get = (object, name, fallback) => member(object ?? {}, name) ?? fallback;
const equal = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const conditionProperties = ['AudioChannels', 'AudioBitrate', 'AudioProfile', 'Width', 'Height', 'Has64BitOffsets', 'PacketLength', 'VideoBitDepth', 'VideoBitrate', 'VideoFramerate', 'VideoLevel', 'VideoProfile', 'VideoTimestamp', 'IsAnamorphic', 'RefFrames', undefined, 'NumAudioStreams', 'NumVideoStreams', 'IsSecondaryAudio', 'VideoCodecTag', 'IsAvc', 'IsInterlaced', 'AudioSampleRate', 'AudioBitDepth', 'VideoRangeType', 'NumStreams', 'VideoRotation'];
const conditionTypes = ['Equals', 'NotEquals', 'LessThanEqual', 'GreaterThanEqual', 'EqualsAny'];
const rangeTypes = ['Unknown', 'SDR', 'HDR10', 'HLG', 'DOVI', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithSDR', 'DOVIWithEL', 'DOVIWithHDR10Plus', 'DOVIWithELHDR10Plus', 'DOVIInvalid', 'HDR10Plus'];
const timestampTypes = ['None', 'Zero', 'Valid'];
const profileTypes = ['Audio', 'Video', 'Photo', 'Subtitle', 'Lyric'];
const codecTypes = ['Video', 'VideoAudio', 'Audio'];
const subtitleMethods = ['Encode', 'Embed', 'External', 'Hls', 'Drop'];
function enumValue(value, names) {
  const text = String(value).trim();
  if (/^[+-]?\d+$/.test(text)) {
    const number = Number(text);
    return number >= -2147483648 && number <= 2147483647 ? number : null;
  }
  let result = 0;
  for (const part of text.split(',')) {
    const index = names.findIndex(name => name && equal(name, part.trim()));
    if (index < 0) return null;
    result |= index;
  }
  return result;
}
const enumName = (value, names) => { const number = enumValue(value, names); return names[number] ?? value; };
const conditionProperty = condition => enumName(get(condition, 'Property', 'AudioChannels'), conditionProperties);
export function containsContainer(profile, value, negativeLists = true) {
  const negative = negativeLists && profile?.startsWith('-');
  if (negative) profile = profile.slice(1);
  if (!value && negativeLists) return Boolean(negative);
  if (!profile) return true;
  const matched = String(value ?? '').split(',').filter(Boolean).some(part => profile.split(',').some(entry => equal(entry, part)));
  return negative ? !matched : matched;
}

const reasonNames = ['ContainerNotSupported', 'VideoCodecNotSupported', 'AudioCodecNotSupported', 'SubtitleCodecNotSupported', 'AudioIsExternal', 'SecondaryAudioNotSupported',
  'VideoProfileNotSupported', 'VideoLevelNotSupported', 'VideoResolutionNotSupported', 'VideoBitDepthNotSupported', 'VideoFramerateNotSupported', 'RefFramesNotSupported',
  'AnamorphicVideoNotSupported', 'InterlacedVideoNotSupported', 'AudioChannelsNotSupported', 'AudioProfileNotSupported', 'AudioSampleRateNotSupported', 'AudioBitDepthNotSupported',
  'ContainerBitrateExceedsLimit', 'VideoBitrateNotSupported', 'AudioBitrateNotSupported', 'UnknownVideoStreamInfo', 'UnknownAudioStreamInfo', 'DirectPlayError',
  'VideoRangeTypeNotSupported', 'VideoCodecTagNotSupported', 'StreamCountExceedsLimit', 'VideoRotationNotSupported'];
const reasons = Object.fromEntries(reasonNames.map((name, index) => [name, 1 << index]));
const conditionReasons = { AudioBitrate: 'AudioBitrateNotSupported', AudioChannels: 'AudioChannelsNotSupported', AudioProfile: 'AudioProfileNotSupported',
  AudioSampleRate: 'AudioSampleRateNotSupported', Height: 'VideoResolutionNotSupported', Width: 'VideoResolutionNotSupported', IsAnamorphic: 'AnamorphicVideoNotSupported',
  IsInterlaced: 'InterlacedVideoNotSupported', IsSecondaryAudio: 'SecondaryAudioNotSupported', NumStreams: 'StreamCountExceedsLimit', RefFrames: 'RefFramesNotSupported',
  VideoBitDepth: 'VideoBitDepthNotSupported', AudioBitDepth: 'AudioBitDepthNotSupported', VideoBitrate: 'VideoBitrateNotSupported', VideoCodecTag: 'VideoCodecTagNotSupported',
  VideoFramerate: 'VideoFramerateNotSupported', VideoLevel: 'VideoLevelNotSupported', VideoProfile: 'VideoProfileNotSupported', VideoRangeType: 'VideoRangeTypeNotSupported', VideoRotation: 'VideoRotationNotSupported' };

export function conditionSatisfied(condition, value) {
  const property = conditionProperty(condition);
  if (value == null || value === '' || property === 'VideoRangeType' && value === 'Unknown') return !get(condition, 'IsRequired', true);
  const operation = enumName(get(condition, 'Condition', 'Equals'), conditionTypes);
  const expected = get(condition, 'Value', '');
  if (property === 'VideoRangeType' && value === 'HDR10Plus' && conditionSatisfied(condition, 'HDR10')) return true;
  if (property === 'VideoRangeType' || property === 'VideoTimestamp') {
    const names = property === 'VideoRangeType' ? rangeTypes : timestampTypes;
    const current = enumValue(value, names);
    if (property === 'VideoRangeType' && operation === 'EqualsAny') return String(expected).split('|').some(part => { const target = enumValue(part, names); return target !== null && target === current; });
    const target = enumValue(expected, names);
    if (target === null) {
      if (property === 'VideoTimestamp') throw new Error(`Requested value '${expected}' was not found.`);
      return false;
    }
    if (operation === 'Equals') return current === target;
    if (operation === 'NotEquals') return current !== target;
    throw new Error(`Unexpected ProfileConditionType: ${operation}`);
  }
  const numeric = text => {
    text = String(text).trim();
    if (['VideoLevel', 'VideoFramerate'].includes(property)) {
      if (!/^[+-]?(?:(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|Infinity|NaN)$/i.test(text)) return null;
      if (/^[+-]?nan$/i.test(text)) return NaN;
      if (/^[+-]?infinity$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
      return Number(text.replaceAll(',', ''));
    }
    if (!/^[+-]?\d+$/.test(text)) return null;
    const result = Number(text);
    return result >= -2147483648 && result <= 2147483647 ? result : null;
  };
  if (operation === 'EqualsAny') {
    if (typeof value === 'boolean') {
      if (!/^(true|false)$/i.test(String(expected).trim())) return false;
      throw new Error(`Unexpected ProfileConditionType: ${operation}`);
    }
    return String(expected).split('|').some(part => typeof value === 'number' ? numeric(part) === value : equal(part, value));
  }
  let target = expected;
  if (typeof value === 'number') { target = numeric(expected); if (target === null) return false; }
  if (typeof value === 'boolean') { if (!/^(true|false)$/i.test(String(expected).trim())) return false; target = equal(String(expected).trim(), 'true'); }
  if (operation === 'Equals') return typeof value === 'string' ? equal(value, target) : value === target;
  if (operation === 'NotEquals') return typeof value === 'string' ? !equal(value, target) : value !== target;
  if (typeof value !== 'number') throw new Error(`Unexpected ProfileConditionType: ${operation}`);
  if (operation === 'LessThanEqual') return value <= target;
  if (operation === 'GreaterThanEqual') return value >= target;
  throw new Error(`Unexpected ProfileConditionType: ${operation}`);
}

function properties(source, stream, type) {
  if (type !== 'Video') return { AudioChannels: stream?.Channels, AudioBitrate: stream?.BitRate, AudioSampleRate: stream?.SampleRate,
    AudioBitDepth: stream?.BitDepth, ...(type === 'VideoAudio' ? { AudioProfile: stream?.Profile, IsSecondaryAudio: stream && !stream.IsExternal ? source.MediaStreams.find(s => s.Type === 'Audio' && !s.IsExternal)?.Index !== stream.Index : false } : {}) };
  return { Width: stream?.Width, Height: stream?.Height, VideoBitDepth: stream?.BitDepth, VideoBitrate: stream?.BitRate, VideoProfile: stream?.Profile,
    VideoRangeType: stream ? stream.VideoRangeType ?? videoColorRange(stream)[1] : undefined, VideoLevel: stream?.Level, VideoFramerate: (stream?.AverageFrameRate != null && stream.AverageFrameRate < 1000 ? stream.AverageFrameRate : stream?.RealFrameRate) ?? 0,
    PacketLength: stream?.PacketLength, VideoTimestamp: stream ? source.Timestamp : 'None', IsAnamorphic: stream?.IsAnamorphic, IsInterlaced: stream?.IsInterlaced,
    IsAvc: stream?.IsAVC, RefFrames: stream?.RefFrames, NumStreams: source.MediaStreams.length, NumVideoStreams: source.MediaStreams.filter(s => s.Type === 'Video').length,
    NumAudioStreams: source.MediaStreams.filter(s => s.Type === 'Audio').length, VideoCodecTag: stream?.CodecTag, VideoRotation: stream?.Rotation };
}
function failures(conditions, values, type) {
  return (conditions ?? []).filter(condition => {
    const property = conditionProperty(condition);
    if (!(property in values)) {
      if (type === 'Video') return false;
      throw new Error(`Unexpected condition on audio file: ${property}`);
    }
    return !conditionSatisfied(condition, values[property]);
  });
}
function compatibility(source, stream, profile, type) {
  const values = properties(source, stream, type);
  const entries = get(profile, 'CodecProfiles', []).filter(entry => equal(enumName(get(entry, 'Type', 'Video'), codecTypes), type)
    && containsContainer(get(entry, 'Container'), source.Container) && containsContainer(get(entry, 'Codec'), stream?.Codec, false)
    && !failures(get(entry, 'ApplyConditions', []), values, type).length);
  return entries.flatMap(entry => failures(get(entry, 'Conditions', []), values, type)).reduce((mask, condition) => mask | (reasons[conditionReasons[conditionProperty(condition)]] ?? 0), 0);
}

function containerCompatibility(source, stream, profile) {
  const values = properties(source, stream, 'Video');
  return get(profile, 'ContainerProfiles', []).filter(entry => equal(enumName(get(entry, 'Type', 'Audio'), profileTypes), 'Video') && containsContainer(get(entry, 'Container'), source.Container))
    .flatMap(entry => failures(get(entry, 'Conditions', []), values, 'Video')).reduce((mask, condition) => mask | (reasons[conditionReasons[conditionProperty(condition)]] ?? 0), 0);
}

function audioCandidates(source, selected, requestedIndex) {
  let candidates = selected ? [selected] : [];
  const flags = source.DefaultAudioIndexSource ?? 0;
  if (!(flags & 4) && (requestedIndex == null || requestedIndex < 0)) {
    const streams = source.MediaStreams.filter(stream => stream.Type === 'Audio');
    if (flags === 0 && selected) candidates = selected.IsDefault ? streams.filter(stream => stream.IsDefault) : streams;
    if (flags & 2) {
      candidates = streams.filter(stream => stream.Language === selected?.Language);
      if (flags & 1) {
        const defaults = candidates.filter(stream => stream.IsDefault);
        candidates = defaults.length ? defaults : streams.filter(stream => stream.IsDefault);
      }
    } else if (flags & 1) candidates = streams.filter(stream => stream.IsDefault);
  }
  return candidates;
}

const isTextFormat = format => /microdvd/i.test(format ?? '') || !/(?:pgs|dvdsub|vobsub|dvbsub)/i.test(format ?? '') && !/^(?:sup|sub)$/i.test(format ?? '');
const textStream = stream => stream.IsTextSubtitleStream ?? (Boolean(stream.Codec || stream.IsExternal) && isTextFormat(stream.Codec));
const canConvert = (stream, format) => textStream(stream) && !/^(?:ass|ssa)$/i.test(stream.Codec) && !/^(?:ass|ssa)$/i.test(format);
const vobSubFormat = format => /(?:dvdsub|vobsub)/i.test(format ?? '');
const vobSubMksDeliveryProfile = profile => vobSubFormat(get(profile, 'Format'))
  && String(get(profile, 'Container', '')).trim() !== '' && containsContainer(get(profile, 'Container'), 'mks');
const vobSubMksProfile = (profile, stream) => vobSubMksDeliveryProfile(profile) && vobSubFormat(stream.Codec)
  && (!stream.IsExternal || /\.mks$/i.test(stream.Path ?? ''));
export function subtitleProfile(source, stream, profile, container = source.Container, options = {}) {
  const profiles = get(profile, 'SubtitleProfiles', []).filter(entry => !get(entry, 'Language') || containsContainer(get(entry, 'Language'), stream.Language || 'und'));
  const exact = entry => equal(get(entry, 'Format'), stream.Codec);
  if (!stream.IsExternal) {
    const embedded = profiles.filter(entry => equal(enumName(get(entry, 'Method', 'Encode'), subtitleMethods), 'Embed') && containsContainer(get(entry, 'Container'), container));
    const embed = embedded.find(entry => textStream(stream) === isTextFormat(get(entry, 'Format')) && exact(entry)) ?? embedded.find(entry => canConvert(stream, get(entry, 'Format')));
    if (embed) return { Method: 'Embed', Format: get(embed, 'Format') };
  }
  // External bytes or a configured subtitle extractor must actually be available.
  const externalFile = stream.IsExternal && !/\.mks$/i.test(stream.Path ?? '');
  const textFallback = externalFile && isExternalSubtitleFallback(stream);
  const externalProfile = allowConversion => {
    for (const entry of profiles) {
      const method = enumName(get(entry, 'Method', 'Encode'), subtitleMethods);
      if (!equal(method, 'External') && !(options.PlayMethod === 'Transcode' && equal(method, 'Hls'))) continue;
      if (equal(method, 'Hls') && !textStream(stream)) continue;
      if (!stream.IsExternal && options.PlayMethod === 'Transcode' && options.EnableSubtitleExtraction === false
        && !/(?:pgs|dvdsub|vobsub)/iu.test(stream.Codec ?? '') && !/^sup$/iu.test(stream.Codec ?? '')) continue;
      if (equal(method, 'External') && vobSubMksProfile(entry, stream)) return { Method: method, Format: get(entry, 'Format') };
      if (vobSubMksDeliveryProfile(entry) || textStream(stream) !== isTextFormat(get(entry, 'Format'))
        || !(textFallback ? options.CanExtractSubtitle?.(stream) : externalFile || options.CanExtractSubtitle?.(stream, get(entry, 'Format')))) continue;
      if (exact(entry)) return { Method: method, Format: get(entry, 'Format') };
      if (allowConversion && canConvert(stream, get(entry, 'Format')) && !source.IsInfiniteStream && stream.SupportsExternalStream !== false) {
        const inputFormat = textFallback ? 'srt' : subtitleInputFormat(stream);
        if (supportsSubtitleTextConversion(inputFormat, get(entry, 'Format'))) {
          return { Method: method, Format: get(entry, 'Format') };
        }
      }
    }
  };
  const external = externalProfile(false) ?? externalProfile(true);
  if (external) return external;
  return { Method: 'Encode', Format: stream.Codec };
}

export function negotiateSource(source, item, profile, options = {}) {
  const video = item.MediaType !== 'Audio';
  const audioStreams = source.MediaStreams.filter(stream => stream.Type === 'Audio');
  let audio = (video ? audioStreams.find(stream => stream.Index === (options.AudioStreamIndex ?? source.DefaultAudioStreamIndex)) : undefined) ?? audioStreams.find(stream => stream.IsDefault) ?? audioStreams[0];
  const videoStream = source.MediaStreams.find(stream => stream.Type === 'Video' && !stream.IsAttachedPic);
  let subtitleIndex = options.SubtitleStreamIndex ?? source.DefaultSubtitleStreamIndex;
  const subtitles = source.MediaStreams.filter(stream => stream.Type === 'Subtitle');
  if (options.SubtitleStreamIndex == null) {
    const scored = subtitles.filter(stream => stream.Score != null);
    const best = Math.max(-1, ...scored.map(stream => stream.Score));
    const top = scored.filter(stream => stream.Score === best);
    if (top.length > 1) subtitleIndex = top.find(stream => get(profile, 'SubtitleProfiles', []).some(entry => equal(enumName(get(entry, 'Method', 'Encode'), subtitleMethods), 'External')
      && (vobSubMksProfile(entry, stream) || !vobSubMksDeliveryProfile(entry) && equal(get(entry, 'Format'), stream.Codec))))?.Index ?? subtitleIndex;
  }
  const subtitle = subtitles.find(stream => stream.Index === subtitleIndex);
  const maxBitrate = options.MaxStreamingBitrate ?? get(profile, 'MaxStreamingBitrate', 8000000);
  const exceeded = !source.IsRemote && (source.Bitrate ?? 40000000) > (maxBitrate > 0 ? maxBitrate : 2147483647);
  const eligible = !exceeded
    && (!video || !['Dvd', 'BluRay'].includes(source.VideoType) && !containsContainer('hls,applehttp,dash', source.Container));
  let mask = exceeded ? reasons.ContainerBitrateExceedsLimit : 0;
  let chosen;
  if (eligible) {
    const candidates = audioCandidates(source, audio, options.AudioStreamIndex);
    const profiles = get(profile, 'DirectPlayProfiles', []).filter(entry => equal(enumName(get(entry, 'Type', 'Audio'), profileTypes), video ? 'Video' : 'Audio'));
    const analyzed = profiles.map((entry, index) => {
      let failed = 0;
      if (!containsContainer(get(entry, 'Container'), source.Container)) failed |= reasons.ContainerNotSupported;
      if (video && !containsContainer(get(entry, 'VideoCodec'), videoStream?.Codec)) failed |= reasons.VideoCodecNotSupported;
      const selected = (video ? candidates : audio ? [audio] : []).find(stream => containsContainer(get(entry, 'AudioCodec'), stream.Codec));
      if ((video ? candidates.length : Boolean(audio)) && !selected) failed |= reasons.AudioCodecNotSupported;
      if (video) {
        failed |= containerCompatibility(source, videoStream, profile);
        if (videoStream && !(failed & reasons.VideoCodecNotSupported)) failed |= compatibility(source, videoStream, profile, 'Video');
        if (subtitle && !['Embed', 'External', 'Drop'].includes(subtitleProfile(source, subtitle, profile, source.Container, options).Method)) failed |= reasons.SubtitleCodecNotSupported;
      }
      if (selected && !(failed & reasons.AudioCodecNotSupported)) {
        failed |= compatibility(source, selected, profile, video ? 'VideoAudio' : 'Audio');
        if (video && selected.IsExternal) failed |= reasons.AudioIsExternal;
      }
      return { entry, audio: selected, failed, index };
    });
    chosen = options.EnableDirectPlay !== false && source.SupportsDirectPlay ? analyzed.find(entry => entry.failed === 0) : undefined;
    if (!chosen) {
      const containerSupported = analyzed.some(entry => !(entry.failed & reasons.ContainerNotSupported));
      const rankings = [reasons.VideoCodecNotSupported, 0x9903fc0, reasons.AudioCodecNotSupported, 0x13c030, reasons.ContainerNotSupported | reasons.ContainerBitrateExceedsLimit];
      const rank = entry => { const i = rankings.findIndex(flag => entry.failed & flag); return i < 0 ? rankings.length : i; };
      const failed = analyzed.filter(entry => !containerSupported || !(entry.failed & reasons.ContainerNotSupported)).sort((a, b) => rank(b) - rank(a) || a.index - b.index)[0];
      mask |= failed?.failed || reasons.DirectPlayError;
      if (!video && !chosen && !analyzed.some(entry => !(entry.failed & reasons.ContainerNotSupported))) mask |= reasons.VideoCodecNotSupported;
    }
  }
  const remux = !chosen && !exceeded ? selectRemux(source, item, profile, options, audio, videoStream, subtitle, mask) : undefined;
  source.SupportsDirectPlay = Boolean(chosen);
  source.SupportsDirectStream = Boolean(chosen);
  source.SupportsTranscoding = Boolean(remux);
  if (remux) {
    source.TranscodingContainer = remux.container;
    source.TranscodingSubProtocol = remux.protocol;
    source.TranscodingUrl = remux.url;
    if (remux.audio) audio = remux.audio;
  }
  if (chosen) delete source.TranscodeReasons;
  else Object.defineProperty(source, 'TranscodeReasons', { value: reasonNames.filter(name => mask & reasons[name]), enumerable: false, configurable: true, writable: true });
  if (chosen?.audio) audio = chosen.audio;
  source.DefaultAudioStreamIndex = video ? audio?.Index : undefined;
  source.DefaultSubtitleStreamIndex = video ? subtitleIndex : undefined;
  for (const stream of subtitles) {
    const delivery = subtitleProfile(source, stream, profile, remux?.container ?? source.Container, { ...options, PlayMethod: remux ? 'Transcode' : 'DirectPlay' });
    stream.DeliveryMethod = delivery.Method;
    if (delivery.Method === 'External') {
      // VobSub/DVDSub is negotiated by codec name but delivered as a Matroska
      // subtitle container; a codec-named URL cannot be served by the route.
      stream.DeliveryUrl = `/Videos/${guid(item.Id).toLowerCase()}/${source.Id}/Subtitles/${stream.Index}/0/Stream.${delivery.Format}${options.AccessToken ? `?ApiKey=${encodeURIComponent(options.AccessToken)}` : ''}`;
      stream.IsExternalUrl = false;
    }
  }
  for (const attachment of source.MediaAttachments) attachment.DeliveryUrl = `/Videos/${guid(item.Id).toLowerCase()}/${source.Id}/Attachments/${attachment.Index}`;
  return source;
}

function selectRemux(source, item, profile, options, audio, video, subtitle, mask) {
  if (!options.CanRemux && !options.CanHls || options.EnableRemuxing === false || options.EnableTranscoding === false || options.AllowVideoStreamCopy === false || options.AllowAudioStreamCopy === false) return;
  const isVideo = item.MediaType !== 'Audio';
  const candidates = isVideo ? audioCandidates(source, audio, options.AudioStreamIndex) : audio ? [audio] : [];
  let entries = get(profile, 'TranscodingProfiles', []).filter(entry => equal(enumName(get(entry, 'Type', 'Audio'), profileTypes), item.MediaType)
    && ['http', 'hls', 0, 1].includes(get(entry, 'Protocol', 'http')) && ['Streaming', 0].includes(get(entry, 'Context', 'Streaming')));
  // Native audio direct-stream selection falls back to MPEG-TS when no transcode container is set.
  const audioDirectProfile = !isVideo && get(profile, 'DirectPlayProfiles', []).find(entry => equal(enumName(get(entry, 'Type', 'Audio'), profileTypes), 'Audio')
    && !containsContainer(get(entry, 'Container'), source.Container)
    && (equal(get(entry, 'AudioCodec'), audio?.Codec) || equal(get(entry, 'Container'), audio?.Codec)));
  const flacAudioMp4 = equal(audio?.Codec, 'flac') && !source.MediaStreams.some(stream => stream.Type === 'Video')
    && audioDirectProfile && equal(get(audioDirectProfile, 'Container'), 'mp4') && equal(get(audioDirectProfile, 'AudioCodec'), 'flac');
  if (source.SupportsDirectStream && flacAudioMp4) entries = [{ Container: get(audioDirectProfile, 'Container'), Protocol: source.TranscodingSubProtocol ?? 'http', AudioDirectStream: true }];
  else if (!isVideo && source.SupportsDirectStream && get(profile, 'DirectPlayProfiles', []).some(entry => equal(enumName(get(entry, 'Type', 'Audio'), profileTypes), 'Audio')
    && containsContainer(get(entry, 'AudioCodec'), audio?.Codec, false))) entries = [{ Container: 'ts', AudioDirectStream: true }];
  for (const entry of entries) {
    const protocol = ['hls', 1].includes(get(entry, 'Protocol', 'http')) ? 'hls' : 'http';
    const container = get(entry, 'Container');
    const target = { ...source, Container: container };
    if (isVideo && (!containsContainer(get(entry, 'VideoCodec'), video?.Codec, false) || compatibility(target, video, profile, 'Video'))) continue;
    const selected = candidates.find(stream => containsContainer(get(entry, 'AudioCodec'), stream.Codec, false) && !compatibility(target, stream, profile, isVideo ? 'VideoAudio' : 'Audio'));
    if (audio && !selected) continue;
    const maxChannels = get(entry, 'MaxAudioChannels') == null ? options.MaxAudioChannels : Number(get(entry, 'MaxAudioChannels'));
    const delivery = subtitle ? subtitleProfile(source, subtitle, profile, container, { ...options, PlayMethod: 'Transcode' }) : { Method: 'Encode' };
    const projected = { AudioSampleRate: !isVideo && protocol === 'hls' ? undefined : selected?.SampleRate, MaxFramerate: video?.ReferenceFrameRate ?? video?.AverageFrameRate ?? video?.RealFrameRate,
      StreamOptions: new Map(), MaxAudioChannels: maxChannels };
    const qualify = (stream, name, value) => { if (value != null && value !== '') projected.StreamOptions.set(`${stream.Codec}-${name}`, value); };
    if (video) {
      qualify(video, 'level', video.Level); qualify(video, 'videobitdepth', video.BitDepth); qualify(video, 'profile', video.Profile?.toLowerCase());
      qualify(video, 'audiochannels', selected?.Channels);
      if (selected) { qualify(selected, 'profile', selected.Profile?.toLowerCase()); if (selected.Level) qualify(selected, 'level', selected.Level); }
    }
    const applyCodec = (stream, type) => {
      const values = properties(source, stream, type);
      for (const codec of get(profile, 'CodecProfiles', []).filter(codec => equal(enumName(get(codec, 'Type', 'Video'), codecTypes), type)
        && containsContainer(get(codec, 'Container'), container) && containsContainer(get(codec, 'Codec'), stream?.Codec, false)
        && !failures(get(codec, 'ApplyConditions', []), values, type).length).reverse()) {
        applyRemuxConditions(projected, get(codec, 'Conditions', []), stream?.Codec);
      }
    };
    applyCodec(video, 'Video');
    const bitrate = options.MaxStreamingBitrate ?? get(profile, 'MaxStreamingBitrate', 8000000);
    const audioBitrate = selected?.BitRate ?? (selected ? 192000 : undefined);
    projected.AudioBitrate = !isVideo && protocol === 'hls' || audioBitrate == null ? undefined : Math.min(projected.AudioBitrate ?? audioBitrate, audioBitrate);
    applyCodec(selected, isVideo ? 'VideoAudio' : 'Audio');
    if (!isVideo && protocol === 'hls') projected.AudioBitrate = Math.min(options.MaxStreamingBitrate ?? get(profile, 'MaxStreamingBitrate', 8000000), get(profile, 'MusicStreamingTranscodingBitrate', 128000), projected.AudioBitrate ?? 2147483647);
    if (video && bitrate != null) projected.VideoBitrate = Math.max(64000, Math.min(projected.VideoBitrate ?? bitrate, bitrate - (projected.AudioBitrate ?? 0)));
    const videoFailures = ['VideoCodecNotSupported', 'VideoProfileNotSupported', 'VideoLevelNotSupported', 'VideoResolutionNotSupported', 'VideoBitDepthNotSupported', 'VideoFramerateNotSupported',
      'RefFramesNotSupported', 'AnamorphicVideoNotSupported', 'InterlacedVideoNotSupported', 'VideoBitrateNotSupported', 'VideoRangeTypeNotSupported', 'VideoRotationNotSupported', 'ContainerBitrateExceedsLimit'];
    if (videoFailures.some(name => mask & reasons[name])) applyRemuxConditions(projected, get(entry, 'Conditions', []));
    const requested = { ...options, ...projected, StreamOptions: Object.fromEntries(projected.StreamOptions), Container: container, MediaType: item.MediaType, AudioStreamIndex: selected?.Index,
      VideoCodec: video?.Codec, AudioCodec: selected?.Codec, SubtitleStreamIndex: subtitle?.Index, SubtitleMethod: delivery.Method, SubtitleCodec: delivery.Format,
      MaxAudioChannels: maxChannels, CopyTimestamps: get(entry, 'CopyTimestamps', false), EnableMpegtsM2TsMode: get(entry, 'EnableMpegtsM2TsMode', false),
      SegmentContainer: container, SegmentLength: get(entry, 'SegmentLength') || undefined, EnableSubtitlesInManifest: get(entry, 'EnableSubtitlesInManifest', false) };
    requested.VideoBitRate = projected.VideoBitrate; requested.AudioBitRate = projected.AudioBitrate;
    if (!(protocol === 'hls' ? options.CanHls?.(source, requested) : options.CanRemux?.(source, requested))) continue;
    const query = [];
    const append = (name, value) => { if (value != null && value !== '') query.push(`${name}=${value}`); };
    const audioDirect = get(entry, 'AudioDirectStream', false);
    append('DeviceProfileId', get(profile, 'Id')?.replaceAll('-', '').toLowerCase());
    append('DeviceId', options.DeviceId);
    append('MediaSourceId', source.Id);
    if (!audioDirect) {
      if (video) append('VideoCodec', get(entry, 'VideoCodec') || video.Codec);
      append('AudioCodec', selected?.Codec);
      if (isVideo || protocol !== 'hls') append('AudioStreamIndex', selected?.Index);
      if (subtitle && delivery.Method !== 'External') append('SubtitleStreamIndex', subtitle.Index);
      append('VideoBitrate', projected.VideoBitrate);
      append('AudioBitrate', projected.AudioBitrate);
      append('AudioSampleRate', projected.AudioSampleRate);
      if (projected.MaxFramerate != null) append('MaxFramerate', JSON.parse(stringifyNativeJson(withNativeFloats({ rate: projected.MaxFramerate }, ['rate']))).rate);
      append('MaxWidth', projected.MaxWidth); append('MaxHeight', projected.MaxHeight);
    }
    if (protocol === 'hls') {
      append('SegmentContainer', container);
      if (get(entry, 'SegmentLength') > 0) append('SegmentLength', get(entry, 'SegmentLength'));
      if (get(entry, 'MinSegments') > 0) append('MinSegments', get(entry, 'MinSegments'));
    } else if (BigInt(options.StartTimeTicks ?? 0) !== 0n) append('StartTimeTicks', options.StartTimeTicks);
    append('PlaySessionId', options.PlaySessionId);
    append('ApiKey', options.AccessToken);
    if (projected.RequireNonAnamorphic) append('RequireNonAnamorphic', 'True');
    if (maxChannels != null && get(entry, 'MaxAudioChannels') != null) append('TranscodingMaxAudioChannels', maxChannels);
    if (get(entry, 'EnableSubtitlesInManifest', false)) append('EnableSubtitlesInManifest', 'True');
    if (requested.EnableMpegtsM2TsMode) append('EnableMpegtsM2TsMode', 'True');
    if (get(entry, 'EstimateContentLength', false)) append('EstimateContentLength', 'True');
    const seek = enumName(get(entry, 'TranscodeSeekInfo', 'Auto'), ['Auto', 'Bytes']);
    if (seek !== 'Auto') append('TranscodeSeekInfo', seek);
    if (requested.CopyTimestamps) append('CopyTimestamps', 'True');
    append('RequireAvc', String(projected.RequireAvc ?? false));
    append('EnableAudioVbrEncoding', String(!audioDirect && get(entry, 'EnableAudioVbrEncoding', true)));
    append('Tag', source.ETag);
    if (isVideo && source.DefaultSubtitleStreamIndex != null && delivery.Method !== 'External') append('SubtitleMethod', delivery.Method);
    if (subtitle && delivery.Method === 'Embed') append('SubtitleCodec', delivery.Format);
    if (!audioDirect) for (const [name, value] of projected.StreamOptions) append(name, String(value).replaceAll(' ', ''));
    append('TranscodeReasons', audioDirect ? 'ContainerNotSupported' : reasonNames.filter(name => mask & reasons[name]).join(','));
    const id = guid(item.Id).toLowerCase();
    return { container, protocol, audio: selected, url: `/${isVideo ? 'videos' : 'audio'}/${id}/${protocol === 'hls' ? 'master.m3u8' : 'stream.' + container}?${query.join('&')}` };
  }
}

function applyRemuxConditions(target, conditions, qualifier) {
  const numericFields = { AudioBitrate: 'AudioBitrate', AudioSampleRate: 'AudioSampleRate', Width: 'MaxWidth', Height: 'MaxHeight', VideoBitrate: 'VideoBitrate', VideoFramerate: 'MaxFramerate' };
  const numericOptions = { AudioChannels: 'audiochannels', RefFrames: 'maxrefframes', VideoBitDepth: 'videobitdepth', VideoLevel: 'level' };
  const stringOptions = { VideoProfile: 'profile', VideoRangeType: 'rangetype', VideoCodecTag: 'codectag', VideoRotation: 'rotation' };
  for (const condition of conditions) {
    const value = String(get(condition, 'Value', '')), property = conditionProperty(condition), operation = enumName(get(condition, 'Condition', 'Equals'), conditionTypes);
    if (!value || operation === 'GreaterThanEqual') continue;
    const name = numericFields[property], option = numericOptions[property], key = qualifier ? `${qualifier}-${option ?? stringOptions[property]}` : option;
    if (name || option && (qualifier || property !== 'VideoLevel')) {
      const number = Number(value);
      if (!Number.isFinite(number) || property !== 'VideoFramerate' && (!Number.isInteger(number) || number < -2147483648 || number > 2147483647)) continue;
      const current = name ? target[name] : target.StreamOptions.get(key) ?? (property === 'AudioChannels' ? target.MaxAudioChannels : undefined);
      const result = operation === 'Equals' ? number : operation === 'LessThanEqual' ? Math.min(number, current ?? number) : undefined;
      if (result != null) { if (name) target[name] = result; else target.StreamOptions.set(key, result); }
    } else if (stringOptions[property] && qualifier) {
      const values = value.split('|').filter(Boolean).map(value => property === 'VideoProfile' ? value : value.trim());
      const current = target.StreamOptions.get(key);
      if (operation === 'Equals') target.StreamOptions.set(key, values.join(','));
      else if (operation === 'EqualsAny') target.StreamOptions.set(key, values.some(value => property === 'VideoProfile' ? value === current : equal(value, current)) ? current : values.join(','));
      else if (property === 'VideoRangeType' && operation === 'NotEquals') target.StreamOptions.set(key, rangeTypes.filter(value => !values.includes(value)).join(','));
    } else if (['IsAvc', 'IsAnamorphic', 'IsInterlaced'].includes(property) && /^(?:true|false)$/i.test(value)) {
      const boolean = equal(value, 'true');
      if (property === 'IsInterlaced') {
        if (!boolean && operation === 'Equals' || boolean && operation === 'NotEquals') target.StreamOptions.set(qualifier ? `${qualifier}-deinterlace` : 'deinterlace', 'true');
      } else if (boolean && operation === 'Equals' || !boolean && operation === 'NotEquals') target[property === 'IsAvc' ? 'RequireAvc' : 'RequireNonAnamorphic'] = true;
    }
  }
}
