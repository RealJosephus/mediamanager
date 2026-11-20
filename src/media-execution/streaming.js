import path from 'node:path';
import { StorageError } from '../storage/errors.js';
import { subtitleInputIndex } from '../playback/extraction.js';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';
import { audioArguments, audioStreamPlan } from './audio.js';
import { videoArguments, videoStreamPlan } from './video.js';
import { mediaSeekTime, nativeInputFormat } from './input.js';

const failure = (code, message) => new StorageError(code, message);

const containers = {
  mp4: { muxer: 'mp4', mime: 'video/mp4', video: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'alac'], subtitle: ['mov_text'] },
  mkv: { muxer: 'matroska', mime: 'video/x-matroska', video: ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg1video', 'mpeg2video', 'mpeg4', 'mjpeg'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'alac', 'opus', 'vorbis', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'], subtitle: ['subrip', 'srt', 'ass', 'ssa', 'pgssub', 'dvdsub'] },
  ts: { muxer: 'mpegts', mime: 'video/mp2t', video: ['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp2', 'mp3'], subtitle: ['dvbsub'] },
  webm: { muxer: 'webm', mime: 'video/webm', video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'], subtitle: ['webvtt'] },
  m4a: { muxer: 'mp4', mime: 'audio/mp4', audio: ['aac', 'alac', 'ac3', 'eac3', 'mp3'] },
  mp3: { muxer: 'mp3', mime: 'audio/mpeg', audio: ['mp3'] },
  aac: { muxer: 'adts', mime: 'audio/aac', audio: ['aac'] },
  flac: { muxer: 'flac', mime: 'audio/flac', audio: ['flac'] },
  ogg: { muxer: 'ogg', mime: 'audio/ogg', audio: ['vorbis', 'opus', 'flac'] },
  wav: { muxer: 'wav', mime: 'audio/wav', audio: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le', 'pcm_f64le'] },
};
const matches = (requested, actual) => !requested || requested.toLowerCase().split(',').includes(actual?.toLowerCase()) || requested.toLowerCase() === 'copy';

function bitmapOverlay(plan) {
  if (plan.bitmapIndex == null) return null;
  const { Width: width, Height: height, Codec } = plan.burnSubtitle;
  const { width: targetWidth, height: targetHeight, filters } = plan.videoOutput;
  const knownSize = width > 0 && height > 0;
  const canvas = knownSize && !/^dvb_?sub(?:title)?$/iu.test(Codec ?? '') ? ['-canvas_size', `${width}x${height}`] : [];
  let scale = '';
  if (targetWidth > 0 && targetHeight > 0) {
    const closeAspect = knownSize && Math.abs(targetWidth / targetHeight - width / height) < 0.01;
    scale = closeAspect ? `scale,scale=${targetWidth}:${targetHeight}:fast_bilinear`
      : String.raw`scale,scale=-1:${targetHeight}:fast_bilinear,crop,pad=max(${targetWidth}\,iw):max(${targetHeight}\,ih):(ow-iw)/2:(oh-ih)/2:black@0,crop=${targetWidth}:${targetHeight}`;
  }
  const video = `[0:${plan.inputVideo.Index}]`;
  const subtitle = `[0:${plan.bitmapIndex}]`;
  const base = filters.length ? `${video}${filters.join(',')}[main];` : '';
  const scaledSubtitle = scale ? `${subtitle}${scale}[sub];` : '';
  return { canvas, graph: scaledSubtitle + base + `${base ? '[main]' : video}${scale ? '[sub]' : subtitle}overlay=eof_action=pass:repeatlast=0[video]` };
}

export function remuxPlan(source, options = {}, { capabilities, configuration, version, subtitleBurn } = {}) {
  options = { ...options };
  if (!options.LiveInput && (source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing)
    || source.VideoType && !['VideoFile', 'Iso'].includes(source.VideoType)
    || /^(?:hls|applehttp|dash)$/i.test(source.Container)) throw failure('not-supported', 'Streaming requires an opened media input.');
  const container = options.Container?.toLowerCase();
  const output = containers[container];
  if (!output) throw failure('not-supported', 'The requested container has no audited packet-copy muxer.');
  const select = (type, index) => index == null ? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic && (type !== 'Audio' || stream.Index === source.DefaultAudioStreamIndex))
    ?? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic) : source.MediaStreams.find(stream => stream.Type === type && stream.Index === index);
  const video = options.MediaType === 'Audio' ? undefined : select('Video', options.VideoStreamIndex);
  const audio = options.AudioStreamIndex === -1 ? undefined : select('Audio', options.AudioStreamIndex);
  const selectedSubtitle = options.SubtitleStreamIndex >= 0 ? select('Subtitle', options.SubtitleStreamIndex) : undefined;
  const burnsByDelivery = options.SubtitleMethod == null || options.SubtitleMethod === 'Encode';
  options.BurnSubtitle = Boolean(selectedSubtitle && burnsByDelivery);
  const separateHlsSubtitle = options.HlsManifest === true && options.SubtitleMethod === 'Hls';
  if (!video && !audio || options.MediaType !== 'Audio' && !video || options.AudioStreamIndex >= 0 && !audio || options.VideoStreamIndex >= 0 && !video
    || options.SubtitleStreamIndex >= 0 && !selectedSubtitle && (burnsByDelivery || separateHlsSubtitle)) {
    throw failure('not-supported', 'The selected streams require an unavailable processing branch.');
  }
  let videoOutput;
  if (video) {
    if (!video.IsExternal && !video.Path && output.video) {
      videoOutput = videoStreamPlan(video, source, options, output.video, { configuration, capabilities, version });
    }
    if (!videoOutput) throw failure('not-supported', 'The selected video stream cannot be delivered in this container.');
  }
  const burnSubtitle = selectedSubtitle && videoOutput?.encoder !== 'copy'
    && (burnsByDelivery || options.AlwaysBurnInSubtitleWhenTranscoding) ? selectedSubtitle : undefined;
  const bitmapIndex = burnSubtitle && !burnSubtitle.IsTextSubtitleStream ? subtitleInputIndex(source, burnSubtitle) : undefined;
  if (burnSubtitle && (!videoOutput || !capabilities?.filters?.includes(bitmapIndex == null ? 'subtitles' : 'overlay')
    || bitmapIndex != null && video.Index < 0 || !subtitleBurn?.supports(source, burnSubtitle)
    || videoOutput.encoder.endsWith('_vaapi')
    || videoOutput.hardware.decoder.surface && !videoOutput.filters.some(filter => filter === 'hwdownload' || filter === 'hwmap=mode=read'))) {
    throw failure('not-supported', 'The selected subtitle requires an unavailable video filter.');
  }
  const subtitle = !burnSubtitle && options.SubtitleMethod === 'Embed' ? selectedSubtitle : undefined;
  if (options.SubtitleStreamIndex >= 0 && options.SubtitleMethod === 'Embed' && !selectedSubtitle) throw failure('not-found', 'The selected subtitle stream does not exist.');
  if (subtitle && (subtitle.IsExternal || subtitle.Path || !output.subtitle?.includes(subtitle.Codec?.toLowerCase())
    || !matches(options.SubtitleCodec, subtitle.Codec))) throw failure('not-supported', 'The selected subtitle cannot be copied into this container.');
  let audioOutput;
  if (audio) {
    const allowed = [...output.audio];
    if (container === 'mp4' && options.HlsManifest) allowed.push('flac', 'opus', 'dts', 'truehd');
    if (container === 'mp4' && options.MediaType === 'Audio' && !source.MediaStreams.some(stream => stream.Type === 'Video')) allowed.push('flac');
    if (!audio.IsExternal && !audio.Path) {
      audioOutput = audioStreamPlan(audio, options, allowed, capabilities, { videoCopy: videoOutput && videoOutput.encoder === 'copy',
        hls: options.HlsManifest === true, configuration });
    }
    if (!audioOutput) throw failure('not-supported', 'The selected audio stream cannot be delivered in this container.');
  }
  let start = BigInt(options.StartTimeTicks ?? 0);
  if (start < 0n || start > 9223372036854775807n) throw failure('invalid-request', 'The start time must be a nonnegative Int64.');
  // EncodingHelper leaves five seconds before EOF so the muxer receives packets.
  if (start > 0n && source.RunTimeTicks > 0) {
    const maximum = BigInt(source.RunTimeTicks) > 50000000n ? BigInt(source.RunTimeTicks) - 50000000n : 0n;
    if (start > maximum) start = maximum;
  }
  const inputFormat = video && configuration?.HardwareAccelerationType && configuration.HardwareAccelerationType !== 'none'
    && source.VideoType === 'VideoFile' ? nativeInputFormat(source.Container) : undefined;
  return { container, ...output, inputVideo: video, inputFormat, videoOutput, audioOutput, burnSubtitle, bitmapIndex,
    streams: [video, audio, subtitle].filter(Boolean).map(stream => ({ type: stream.Type, codec: stream.Codec, index: stream.Type === 'Subtitle' ? subtitleInputIndex(source, stream) : stream.Index })),
    start, seek: BigInt(options.StartTimeTicks ?? 0) > 0n, copyTimestamps: options.CopyTimestamps === true, m2ts: options.EnableMpegtsM2TsMode === true, mediaType: options.MediaType ?? 'Video' };
}

export function remuxArguments(url, plan, threads, version, subtitles) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(url)) throw new TypeError('Remuxing requires a private VFS input.');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
  if (plan.seek) args.push('-ss', mediaSeekTime(plan.start));
  if (plan.videoOutput?.encoder === 'copy') args.push('-fflags', '+genpts');
  if (plan.inputFormat) args.push('-f', plan.inputFormat);
  const overlay = bitmapOverlay(plan);
  args.push(...(plan.videoOutput?.hardware?.inputArgs ?? []), ...(overlay?.canvas ?? []), '-i', url);
  if (plan.videoOutput?.hardware?.decoder.args.length) args.push('-noautoscale');
  args.push('-threads', String(threads));
  if (overlay) args.push('-filter_complex', overlay.graph);
  for (const stream of plan.streams) args.push('-map', overlay && stream.type === 'Video' ? '[video]' : `0:${stream.index}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy');
  const shift = subtitles && !plan.copyTimestamps ? Math.round(Number(plan.start) / 10000000) : null;
  if (plan.videoOutput && plan.videoOutput.encoder !== 'copy') {
    const filters = overlay ? [] : [...plan.videoOutput.filters];
    if (subtitles) filters.push(subtitles.filter);
    if (shift !== null) filters.push(`setpts=PTS-${shift}/TB`);
    args.push(...videoArguments({ ...plan.videoOutput, filters }, { version }));
  }
  if (plan.audioOutput && plan.audioOutput.encoder !== 'copy') {
    const filters = [...plan.audioOutput.filters];
    if (shift !== null) filters.push(`asetpts=PTS-${shift}/TB`);
    args.push(...audioArguments({ ...plan.audioOutput, filters }));
  }
  const audioCodec = plan.audioOutput?.codec;
  if (['opus', 'dts', 'truehd'].includes(audioCodec) || audioCodec === 'flac' && !encoderVersionAtLeast(version, 6)) args.push('-strict', '-2');
  if (!plan.streams.some(stream => stream.type === 'Video')) args.push('-vn');
  if (!plan.streams.some(stream => stream.type === 'Audio')) args.push('-an');
  if (!plan.streams.some(stream => stream.type === 'Subtitle')) args.push('-sn');
  args.push('-dn');
  if (plan.container === 'ts') {
    const video = plan.streams.find(stream => stream.type === 'Video');
    if (plan.videoOutput?.encoder === 'copy' && ['h264', 'hevc'].includes(video?.codec)) args.push('-bsf:v', `${video.codec}_mp4toannexb`);
    if (plan.m2ts) args.push('-mpegts_m2ts_mode', '1');
  }
  if (plan.copyTimestamps) args.push('-copyts', '-avoid_negative_ts', 'disabled', '-start_at_zero');
  if (plan.muxer === 'mp4') args.push('-movflags', plan.mediaType === 'Audio' ? 'empty_moov+delay_moov' : 'frag_keyframe+empty_moov+delay_moov');
  args.push('-f', plan.muxer, 'pipe:1');
  return args;
}

export function hlsArguments(url, plan, directory, startNumber = 0, runtimeTicks = 0n, { threads, version, maxMuxingQueueSize }, subtitles, eventId) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(url)) throw new TypeError('HLS requires a private VFS input.');
  if (eventId != null && !/^[a-f0-9]{32}$/u.test(eventId)) throw new TypeError('Invalid HLS event playlist identity.');
  const prefix = eventId ?? 'segment';
  const analyzeDuration = plan.analyzeDurationMs > 0 ? String(plan.analyzeDurationMs * 1000) : '200M';
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '0.5', '-protocol_whitelist', 'http,tcp', '-analyzeduration', analyzeDuration, '-probesize', '1G'];
  if (runtimeTicks > 0n) {
    const maximum = plan.runtime > 50000000n ? plan.runtime - 50000000n : 0n;
    const seekTicks = runtimeTicks + (plan.videoOutput?.encoder === 'copy' ? 5000000n : 0n);
    args.push('-ss', mediaSeekTime(seekTicks > maximum ? maximum : seekTicks));
  }
  if (plan.readAtNativeFramerate) {
    args.push('-re');
    if (encoderVersionAtLeast(version, 7, 1)) args.push('-readrate_catchup', '100');
  }
  const inputFlags = [plan.ignoreDts && '+igndts', plan.ignoreIndex && '+ignidx',
    (plan.genPts || plan.videoOutput?.encoder === 'copy') && '+genpts', plan.discardCorrupt && '+discardcorrupt'].filter(Boolean);
  if (inputFlags.length) args.push('-fflags', inputFlags.join(''));
  if (plan.inputFormat) args.push('-f', plan.inputFormat);
  const overlay = bitmapOverlay(plan);
  args.push(...(plan.videoOutput?.hardware?.inputArgs ?? []), ...(overlay?.canvas ?? []), '-i', url);
  if (plan.videoOutput?.hardware?.decoder.args.length) args.push('-noautoscale');
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-threads', String(threads));
  if (overlay) args.push('-filter_complex', overlay.graph);
  if (plan.streams.some(stream => stream.index < 0)) args.push('-sn');
  else {
    for (const stream of plan.streams) args.push('-map', overlay && stream.type === 'Video' ? '[video]' : `0:${stream.index}`);
    args.push('-map', '-0:s');
  }
  if (plan.video) {
    const output = overlay ? { ...plan.videoOutput, filters: [] }
      : subtitles ? { ...plan.videoOutput, filters: [...plan.videoOutput.filters, subtitles.filter] } : plan.videoOutput;
    args.push(...videoArguments(output, { hls: true, event: eventId != null, segmentLength: plan.segmentLength, version }));
    if (plan.videoOutput.codec === 'hevc') args.push('-tag:v:0', 'hvc1');
    if (plan.videoOutput.encoder === 'copy') {
      if (!plan.live && ['h264', 'hevc'].includes(plan.videoOutput.codec) && plan.video.NalLengthSize !== '0') {
        args.push('-bsf:v', plan.videoOutput.codec + '_mp4toannexb');
      }
      args.push('-start_at_zero');
    }
    if (subtitles) args.push('-start_at_zero');
    if (eventId && plan.container === 'ts') args.push('-flags', '-global_header');
  } else args.push('-vn');
  args.push(...audioArguments(plan.audioOutput));
  if (['opus', 'dts', 'truehd'].includes(plan.audioOutput?.codec) || plan.audioOutput?.codec === 'flac' && !encoderVersionAtLeast(version, 6)) args.push('-strict', '-2');
  args.push('-copyts', '-avoid_negative_ts', 'disabled', '-max_muxing_queue_size', String(maxMuxingQueueSize), '-f', 'hls', '-max_delay', '5000000', '-hls_time', String(plan.segmentLength), '-hls_segment_type', plan.container === 'mp4' ? 'fmp4' : 'mpegts');
  if (plan.container === 'mp4') args.push('-hls_fmp4_init_filename', process.platform === 'win32' ? path.join(directory, `${prefix}-1.mp4`) : `${prefix}-1.mp4`);
  args.push('-start_number', String(startNumber));
  if (eventId) args.push('-hls_base_url', `hls/${eventId}/`);
  args.push('-hls_segment_filename', path.join(directory, `${prefix}%d.${plan.container}`), '-hls_playlist_type', eventId ? 'event' : 'vod', '-hls_list_size', '0');
  if (plan.container === 'mp4' && plan.video) args.push(encoderVersionAtLeast(version, 5) ? '-hls_segment_options' : '-hls_ts_options', 'movflags=+frag_discont+skip_sidx');
  args.push('-y', path.join(directory, 'main.m3u8'));
  return args;
}
