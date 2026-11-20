import { stereoMix } from './stereo-mix.js';

// Audio parameter rules from the designated Jellyfin EncodingHelper.
const lossless = new Set(['alac', 'ape', 'flac', 'mlp', 'truehd', 'wavpack']);
const commonLossy = new Set(['', 'aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3']);
const channelLimits = new Map([
  ['libmp3lame', 2], ['libfdk_aac', 6], ['ac3', 6], ['eac3', 6], ['dca', 6],
  ['mlp', 6], ['truehd', 6],
]);

export function audioCodecList(value) {
  return String(value ?? '').toLowerCase().split(',').filter(name => /^[a-z0-9_]+$/u.test(name));
}

export function audioEncoder(codec, encoders) {
  if (codec === 'aac') return ['aac_at', 'libfdk_aac'].find(name => encoders?.includes(name)) ?? 'aac';
  return ({ mp3: 'libmp3lame', vorbis: 'libvorbis', opus: 'libopus', dts: 'dca' })[codec] ?? codec;
}

export function outputAudioBitrate(stream, codec, request, channels) {
  if (!stream) return 0;
  if (lossless.has(codec)) return stream.BitRate ?? 0;
  const requested = request.AudioBitRate ?? 2147483647;
  const input = stream.Channels ?? 0;
  const output = channels ?? 0;
  if (commonLossy.has(codec)) {
    if (input >= 6 && (output >= 6 || output === 0)) return Math.min(640000, requested);
    return Math.min(output > 0 && input > 0 ? output * 128000 : input > 0 ? input * 128000 : 384000, requested);
  }
  if (codec === 'dts' || codec === 'dca') {
    if (input >= 6 && (output >= 6 || output === 0)) return Math.min(768000, requested);
    return Math.min(output > 0 && input > 0 ? output * 136000 : input > 0 ? input * 136000 : 672000, requested);
  }
  return 128000 * (channels ?? stream.Channels ?? 2);
}

function requestedChannels(codec, request) {
  const value = request.StreamOptions?.[`${codec}-audiochannels`];
  return value != null && /^-?\d+$/u.test(value) ? Number(value) : request.MaxAudioChannels ?? request.AudioChannels;
}

export function audioStreamPlan(stream, request, allowed, { encoders } = {}, { videoCopy, hls = false, configuration = {} } = {}) {
  const inputCodec = stream.Codec?.toLowerCase();
  const codecs = audioCodecList(request.AudioCodec);
  const explicitCopy = codecs[0] === 'copy';
  const compatibleCodec = !codecs.length || codecs.includes(inputCodec);
  const channels = requestedChannels(inputCodec, request);
  const bitDepth = request.MaxAudioBitDepth ?? request.StreamOptions?.[`${inputCodec}-audiobitdepth`];
  const canCopy = request.AllowAudioStreamCopy !== false && request.EnableAutoStreamCopy !== false && compatibleCodec
    && (channels == null || stream.Channels > 0 && stream.Channels <= channels)
    && (request.AudioSampleRate == null || stream.SampleRate > 0 && stream.SampleRate <= request.AudioSampleRate)
    && (request.AudioBitRate == null || stream.BitRate == null || stream.BitRate <= request.AudioBitRate)
    && (bitDepth == null || stream.BitDepth == null || stream.BitDepth <= Number(bitDepth));
  const pureAudioEncoding = request.MediaType === 'Audio' && codecs.length > 0;
  const trimByEncoding = hls && videoCopy === false && configuration.HlsAudioSeekStrategy === 'TranscodeAudio';
  const copy = explicitCopy || request.PermitAudioEncoding === false || canCopy && !pureAudioEncoding && !trimByEncoding;
  if (copy && allowed.includes(inputCodec)) {
    const targetChannels = stream.Channels > 0 ? Math.min(stream.Channels, channels ?? stream.Channels) : channels;
    return { codec: inputCodec, encoder: 'copy', channels: targetChannels, sampleRate: stream.SampleRate,
      bitrate: outputAudioBitrate(stream, explicitCopy ? 'copy' : codecs[0] ?? '', request, targetChannels) };
  }
  if (explicitCopy || request.PermitAudioEncoding === false) return;
  const targets = codecs.length ? codecs : [inputCodec];
  const codec = targets.find(name => allowed.includes(name) && (encoders == null || encoders.includes(audioEncoder(name, encoders))));
  if (!codec) return;
  const encoder = audioEncoder(codec, encoders);
  const inputChannels = stream.Channels > 0 ? stream.Channels : Infinity;
  let outputChannels = Math.min(inputChannels, requestedChannels(codec, request) ?? Infinity,
    channelLimits.get(encoder) ?? 8, request.TranscodingMaxAudioChannels ?? Infinity);
  if (hls) outputChannels = ({ 3: 2, 4: 2, 5: 6, 7: 8 })[outputChannels] ?? outputChannels;
  let sampleRate = request.AudioSampleRate;
  if (!hls && request.MediaType === 'Audio' && codec === 'opus' && sampleRate != null) {
    sampleRate = [8000, 12000, 16000, 24000, 48000].find(rate => sampleRate <= rate) ?? 48000;
  }
  if (hls && request.MediaType !== 'Audio' && stream.CodecTag === 'ac-4') sampleRate ??= 48000;
  const bitrate = outputAudioBitrate(stream, codec, request, outputChannels);
  if (!Number.isSafeInteger(outputChannels) || outputChannels < 1
    || sampleRate != null && (!Number.isSafeInteger(sampleRate) || sampleRate < 1)
    || !Number.isSafeInteger(bitrate) || bitrate < 0) return;
  const mix = request.MediaType !== 'Audio' && stereoMix(configuration.DownMixStereoAlgorithm, stream);
  const downmix = outputChannels === 2 && inputChannels !== Infinity && inputChannels > 2 && request.MediaType !== 'Audio';
  const filters = [];
  if (downmix) {
    if (mix) filters.push(mix);
    if (configuration.DownMixAudioBoost != null && configuration.DownMixAudioBoost !== 1) {
      filters.push('volume=' + configuration.DownMixAudioBoost);
    }
  }
  return { codec, encoder, channels: outputChannels, sampleRate, bitrate,
    vbr: configuration.EnableAudioVbr === true && request.EnableAudioVbrEncoding !== false,
    omitChannelArgument: Boolean(mix && (!hls || outputChannels === 2)), filters,
    copyRefusedByCodec: !compatibleCodec };
}

function variableBitrate(encoder, bitrate, channels) {
  const perChannel = Math.trunc(bitrate / channels);
  if (encoder === 'libfdk_aac') {
    const level = [32000, 48000, 64000, 96000].findIndex(limit => perChannel < limit);
    return ['-vbr:a', String(level < 0 ? 5 : level + 1)];
  }
  if (encoder === 'aac_at') return ['-aac_at_mode:a', '2', '-b:a', String(bitrate)];
  if (encoder === 'libmp3lame') {
    if (perChannel > 48000 && perChannel < 122500) {
      const quality = perChannel < 64000 ? 6 : perChannel < 88000 ? 4 : perChannel < 112000 ? 2 : 0;
      return ['-qscale:a', String(quality)];
    }
    return ['-abr:a', '1', '-b:a', String(bitrate)];
  }
  if (encoder === 'libvorbis') {
    const level = [40000, 56000, 80000, 112000].findIndex(limit => perChannel < limit);
    return ['-qscale:a', String(level < 0 ? 8 : level * 2)];
  }
}

export function audioArguments(audio) {
  if (!audio) return ['-an'];
  const args = ['-codec:a:0', audio.encoder];
  if (audio.encoder === 'copy') return args;
  if (!audio.omitChannelArgument) args.push('-ac', String(audio.channels));
  if (!lossless.has(audio.codec)) {
    const vbr = audio.vbr && variableBitrate(audio.encoder, audio.bitrate, audio.channels);
    args.push(...(vbr || ['-ab', String(audio.bitrate)]));
  }
  if (audio.sampleRate != null) args.push('-ar', String(audio.sampleRate));
  if (audio.filters.length) args.push('-af', audio.filters.join(','));
  return args;
}
