import path from 'node:path';
import { StorageError } from '../storage/errors.js';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';
import { audioArguments, audioStreamPlan } from './audio.js';
import { videoArguments, videoStreamPlan } from './video.js';
import { mediaSeekTime, nativeInputFormat, streamInputIndex } from './input.js';

const failure = (code, message) => new StorageError(code, message);

const containers = {
  mp4: { muxer: 'mp4', mime: 'video/mp4', video: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'alac'], subtitle: ['mov_text'] },
  mkv: { muxer: 'matroska', mime: 'video/x-matroska', video: ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg1video', 'mpeg2video', 'mpeg4', 'mjpeg'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'alac', 'opus', 'vorbis', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'], subtitle: ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'pgssub', 'dvdsub'] },
  ts: { muxer: 'mpegts', mime: 'video/mp2t', video: ['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp2', 'mp3'], subtitle: ['dvbsub'] },
  webm: { muxer: 'webm', mime: 'video/webm', video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'], subtitle: ['webvtt'] },
  m4a: { muxer: 'mp4', mime: 'audio/mp4', audio: ['aac', 'alac', 'ac3', 'eac3', 'mp3'] },
  mp3: { muxer: 'mp3', mime: 'audio/mpeg', audio: ['mp3'] },
  aac: { muxer: 'adts', mime: 'audio/aac', audio: ['aac'] },
  flac: { muxer: 'flac', mime: 'audio/flac', audio: ['flac'] },
  ogg: { muxer: 'ogg', mime: 'audio/ogg', audio: ['vorbis', 'opus', 'flac'] },
  wav: { muxer: 'wav', mime: 'audio/wav', audio: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le', 'pcm_f64le'] },
};
const openclOutput = 'hwmap=derive_device=d3d11va:mode=write:reverse=1';
const vaapiUpload = /^(?:hwupload_vaapi|hwupload=derive_device=vaapi)$/u;
const videoReadback = /^(?:hwdownload|hwmap(?:=mode=read)?)$/u;
const privateUrl = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/u;
const privateSubtitleUrl = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}(?:\.[a-z]+|\/[^/?#\\]+)?$/u;
const subtitleCodec = codec => ({ hdmv_pgs_subtitle: 'pgssub', dvd_subtitle: 'dvdsub', vobsub: 'dvdsub',
  dvb_subtitle: 'dvbsub', vtt: 'webvtt' })[codec] ?? codec;

function hardwareSubtitles(video, bitmap, capabilities) {
  const surface = video.hardware.decoder.surface;
  const plans = {
    cuda: { encoder: 'nvenc', filter: 'overlay_cuda', format: 'yuva420p', upload: 'hwupload=derive_device=cuda', alpha: 'OverlayCudaAlphaFormat' },
    d3d11: { encoder: 'amf', filter: 'overlay_opencl', format: 'yuva420p', upload: 'hwupload=derive_device=opencl', alpha: 'OverlayOpenclAlphaFormat' },
    videotoolbox_vld: { encoder: 'videotoolbox', filter: 'overlay_videotoolbox', format: 'bgra', upload: 'hwupload' },
    vaapi: { encoder: 'vaapi', filter: 'overlay_vaapi', format: 'bgra', upload: 'hwupload=derive_device=vaapi', scaledOverlay: true },
  };
  const plan = plans[surface];
  if (!plan || !video.encoder.endsWith('_' + plan.encoder) || !capabilities?.filters?.includes(plan.filter)) return;
  if (surface === 'vaapi' && video.vaapiDriver !== 'iHD') return;
  if (!bitmap && (!capabilities.filters.includes('alphasrc') || !(video.hardwareSize?.width > 0 && video.hardwareSize?.height > 0))) return;
  const finish = surface === 'd3d11' ? video.filters.indexOf(openclOutput) : -1;
  if (surface === 'd3d11' && finish < 0) return;
  return { ...plan, finish, premultiplied: capabilities.filterOptions?.[plan.alpha] === true };
}

function insertTextSubtitle(filters, text) {
  if (vaapiUpload.test(filters.at(-1))) filters.splice(filters.length - 1, 0, text);
  else filters.push(text);
}

function bitmapInputArguments(subtitles, overlay, seek, probe = []) {
  if (!subtitles?.bitmap) return [];
  const { filename, format } = subtitles.bitmap;
  return ['-protocol_whitelist', 'file', ...probe, ...seek, ...overlay.canvas, '-f', format, '-i', filename];
}

function externalAudioArguments(plan, url, seek) {
  if (!plan.externalAudio) return [];
  if (!privateUrl.test(url)) throw new TypeError('External audio requires a private VFS input.');
  return ['-protocol_whitelist', 'http,tcp', ...seek, '-i', url];
}

function streamMap(stream, plan, subtitles) {
  if (stream.type === 'Audio' && plan.externalAudio) return `${subtitles?.bitmap || plan.externalSubtitle ? 2 : 1}:${plan.externalAudio.index}`;
  if (stream.type === 'Subtitle' && plan.externalSubtitle) return `1:${stream.index}`;
  return `0:${stream.index}`;
}

function probeInput(plan) {
  return ['-analyzeduration', plan.analyzeDurationMs > 0 ? String(plan.analyzeDurationMs * 1000) : '200M', '-probesize', '1G'];
}

function inputFlags(plan) {
  const flags = [plan.ignoreDts && '+igndts', plan.ignoreIndex && '+ignidx',
    (plan.genPts || plan.videoOutput?.encoder === 'copy') && '+genpts', plan.discardCorrupt && '+discardcorrupt'].filter(Boolean);
  return flags.length ? ['-fflags', flags.join('')] : [];
}

function inputPacing(plan, version) {
  if (!plan.readAtNativeFramerate) return [];
  return encoderVersionAtLeast(version, 7, 1) ? ['-re', '-readrate_catchup', '100'] : ['-re'];
}

function subtitleOverlay(plan, subtitles, ticks, shift) {
  const hardware = plan.subtitleHardware;
  const bitmap = plan.bitmapIndex != null;
  if (!bitmap && !hardware) return null;
  const { Width: width, Height: height, Codec } = plan.burnSubtitle;
  const mainFilters = plan.videoOutput.filters;
  const finish = hardware?.finish >= 0 ? hardware.finish : !hardware && vaapiUpload.test(mainFilters.at(-1)) ? mainFilters.length - 1 : -1;
  const filters = finish >= 0 ? mainFilters.slice(0, finish) : mainFilters;
  const { width: videoWidth, height: videoHeight } = hardware ? plan.videoOutput.hardwareSize : plan.videoOutput;
  const targetHeight = hardware?.scaledOverlay ? Math.min(videoHeight, 1080) : videoHeight;
  const targetWidth = targetHeight < videoHeight ? Math.floor(videoWidth * targetHeight / videoHeight / 2) * 2 : videoWidth;
  const knownSize = width > 0 && height > 0;
  const canvas = bitmap && knownSize && !/^dvb_?sub(?:title)?$/iu.test(Codec ?? '') ? ['-canvas_size', `${width}x${height}`] : [];
  let scale = '';
  if (bitmap && targetWidth > 0 && targetHeight > 0) {
    const closeAspect = knownSize && Math.abs(targetWidth / targetHeight - width / height) < 0.01;
    scale = closeAspect ? `scale,scale=${targetWidth}:${targetHeight}:fast_bilinear`
      : String.raw`scale,scale=-1:${targetHeight}:fast_bilinear,crop,pad=max(${targetWidth}\,iw):max(${targetHeight}\,ih):(ow-iw)/2:(oh-ih)/2:black@0,crop=${targetWidth}:${targetHeight}`;
  }
  const video = `[0:${plan.inputVideo.Index}]`;
  const external = bitmap && plan.burnSubtitle.IsExternal;
  if (external && !subtitles?.bitmap) throw new TypeError('An external bitmap overlay requires a staged subtitle.');
  let subtitle = bitmap ? `[${external ? 1 : 0}:${plan.bitmapIndex}]` : '';
  const subFilters = [scale].filter(Boolean);
  let overlay = 'overlay';
  let outputOptions = hardware?.scaledOverlay && videoWidth > 0 && videoHeight > 0 ? `:w=${videoWidth}:h=${videoHeight}` : '';
  if (hardware) {
    overlay = hardware.filter;
    if (!bitmap) {
      if (!subtitles) throw new TypeError('A hardware overlay requires the staged text subtitle.');
      const frameRate = /^(?:ass|ssa)$/iu.test(Codec ?? '') ? Math.min(plan.inputVideo.RealFrameRate ?? 25, 60) : 10;
      const start = ticks > 0n ? mediaSeekTime(ticks).replace(/[:.]/gu, value => '\\\\\\' + value) : '0';
      subFilters.push(`alphasrc=s=${targetWidth}x${targetHeight}:r=${frameRate}:start='${start}'`, 'format=' + hardware.format,
        subtitles.filter + ':alpha=1:sub2video=1');
      if (shift !== null) subFilters.push(`setpts=PTS-${shift}/TB`);
      if (hardware.premultiplied) outputOptions += ':alpha_format=premultiplied';
    } else subFilters.push('format=' + hardware.format);
    subFilters.push(hardware.upload);
  }
  const base = filters.length ? `${video}${filters.join(',')}[main];` : '';
  const prepared = subFilters.length ? `${subtitle}${subFilters.join(',')}[sub];` : '';
  if (prepared) subtitle = '[sub]';
  const output = finish >= 0 ? ',' + mainFilters.slice(finish).join(',') : '';
  return { canvas, graph: prepared + base + `${base ? '[main]' : video}${subtitle}${overlay}=eof_action=pass:repeatlast=0${outputOptions}${output}[video]` };
}

export function remuxPlan(source, options = {}, { capabilities, configuration, version, subtitleBurn, canOpenSidecar } = {}) {
  options = { ...options };
  const live = options.LiveInput === true && source.IsInfiniteStream === true;
  const discInput = source.VideoType === 'Dvd' || source.VideoType === 'BluRay';
  if (!options.LiveInput && (source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing)
    || source.VideoType && !discInput && !['VideoFile', 'Iso'].includes(source.VideoType)
    || discInput && source.Protocol !== 'File'
    || /^(?:hls|applehttp|dash)$/i.test(source.Container)) throw failure('not-supported', 'Streaming requires an opened media input.');
  const container = options.Container?.toLowerCase();
  const output = containers[container];
  if (!output) throw failure('not-supported', 'The requested container has no audited packet-copy muxer.');
  const select = (type, index) => index == null ? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic && (type !== 'Audio' || stream.Index === source.DefaultAudioStreamIndex))
    ?? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic) : source.MediaStreams.find(stream => stream.Type === type && stream.Index === index);
  const video = options.MediaType === 'Audio' ? undefined : select('Video', options.VideoStreamIndex);
  const audio = options.AudioStreamIndex === -1 && !live ? undefined
    : select('Audio', live && options.AudioStreamIndex === -1 ? undefined : options.AudioStreamIndex);
  const selectedSubtitle = options.SubtitleStreamIndex >= 0 ? select('Subtitle', options.SubtitleStreamIndex) : undefined;
  if (options.SubtitleMethod === 'Embed' && selectedSubtitle?.Codec?.toLowerCase() === 'dvbsub') options.SubtitleMethod = 'Encode';
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
  const bitmapIndex = burnSubtitle && !burnSubtitle.IsTextSubtitleStream ? streamInputIndex(source, burnSubtitle) : undefined;
  const hasFilter = name => capabilities?.filters?.includes(name);
  const subtitleHardware = burnSubtitle && videoOutput ? hardwareSubtitles(videoOutput, bitmapIndex != null, capabilities) : undefined;
  if (burnSubtitle && !subtitleHardware && videoOutput?.encoder.endsWith('_vaapi')
    && videoOutput.hardware.decoder.surface === 'vaapi' && !vaapiUpload.test(videoOutput.filters.at(-1))) {
    videoOutput.filters.push('hwdownload', 'format=nv12', 'hwupload_vaapi');
  }
  if (burnSubtitle && (!videoOutput || (bitmapIndex == null ? !hasFilter('subtitles') : !subtitleHardware && !hasFilter('overlay'))
    || (bitmapIndex != null || subtitleHardware) && video.Index < 0 || !subtitleBurn?.supports(source, burnSubtitle)
    || !subtitleHardware && videoOutput.hardware.decoder.surface && !videoOutput.filters.some(filter => videoReadback.test(filter)))) {
    throw failure('not-supported', 'The selected subtitle requires an unavailable video filter.');
  }
  const subtitle = !burnSubtitle && options.SubtitleMethod === 'Embed' ? selectedSubtitle : undefined;
  if (options.SubtitleStreamIndex >= 0 && options.SubtitleMethod === 'Embed' && !selectedSubtitle) throw failure('not-found', 'The selected subtitle stream does not exist.');
  let subtitleEncoder, externalSubtitle;
  if (subtitle) {
    const input = subtitle.Codec?.toLowerCase();
    const requested = options.SubtitleCodec?.split(',')[0]?.trim().toLowerCase();
    subtitleEncoder = !requested || requested === input || requested === 'copy' ? 'copy' : subtitleCodec(requested);
    const outputCodec = subtitleEncoder === 'copy' ? subtitleCodec(input) : subtitleEncoder;
    if (!output.subtitle?.includes(outputCodec) || subtitleEncoder !== 'copy' && !capabilities?.encoders?.includes(subtitleEncoder)
      || (subtitle.IsExternal ? !subtitle.Path || !canOpenSidecar : Boolean(subtitle.Path))) {
      throw failure('not-supported', 'The selected subtitle cannot be embedded into this container.');
    }
    if (subtitle.IsExternal) externalSubtitle = subtitle;
  }
  let audioOutput, externalAudio;
  if (audio) {
    const allowed = [...output.audio];
    if (container === 'mp4' && options.HlsManifest) allowed.push('flac', 'opus', 'dts', 'truehd');
    if (container === 'mp4' && options.MediaType === 'Audio' && !source.MediaStreams.some(stream => stream.Type === 'Video')) allowed.push('flac');
    if (audio.IsExternal && audio.Path && canOpenSidecar) externalAudio = { path: audio.Path, index: streamInputIndex(source, audio) };
    if (externalAudio || !audio.IsExternal && !audio.Path) {
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
  return { container, ...output, inputVideo: video, inputFormat, discInput, videoOutput, audioOutput, externalAudio, burnSubtitle,
    bitmapIndex, subtitleHardware, subtitleEncoder, externalSubtitle, live, analyzeDurationMs: source.AnalyzeDurationMs,
    readAtNativeFramerate: source.ReadAtNativeFramerate, ignoreDts: source.IgnoreDts, ignoreIndex: source.IgnoreIndex,
    genPts: source.GenPtsInput, discardCorrupt: source.DiscardCorruptFrames,
    streams: [video, audio, subtitle].filter(Boolean).map(stream => ({ type: stream.Type, codec: stream.Codec, index: stream.Type === 'Subtitle' ? streamInputIndex(source, stream) : stream.Index })),
    start, seek: BigInt(options.StartTimeTicks ?? 0) > 0n, copyTimestamps: options.CopyTimestamps === true, m2ts: options.EnableMpegtsM2TsMode === true, mediaType: options.MediaType ?? 'Video' };
}

export function remuxArguments(url, plan, threads, version, subtitles, audioUrl, subtitleUrl) {
  if (!privateUrl.test(url)) throw new TypeError('Remuxing requires a private VFS input.');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
  const seek = plan.seek ? ['-ss', mediaSeekTime(plan.start)] : [];
  if (plan.live) args.push(...probeInput(plan));
  args.push(...seek);
  if (plan.live) args.push(...inputPacing(plan, version), ...inputFlags(plan));
  else if (plan.videoOutput?.encoder === 'copy') args.push('-fflags', '+genpts');
  if (plan.discInput) args.push('-f', 'concat', '-safe', '0');
  else if (plan.inputFormat) args.push('-f', plan.inputFormat);
  const shift = subtitles?.filter && !plan.copyTimestamps ? Math.round(Number(plan.start) / 10000000) : null;
  const overlay = subtitleOverlay(plan, subtitles, plan.start, shift);
  args.push(...(plan.videoOutput?.hardware?.inputArgs ?? []), ...(overlay?.canvas ?? []), '-i', url,
    ...bitmapInputArguments(subtitles, overlay, seek));
  if (plan.externalSubtitle) {
    if (!privateSubtitleUrl.test(subtitleUrl)) throw new TypeError('Embedding a subtitle requires a private VFS input.');
    args.push('-protocol_whitelist', 'http,tcp', ...seek, '-i', subtitleUrl);
  }
  args.push(...externalAudioArguments(plan, audioUrl, seek));
  if (plan.videoOutput?.hardware?.decoder.args.length) args.push('-noautoscale');
  args.push('-threads', String(threads));
  if (overlay) args.push('-filter_complex', overlay.graph);
  // The tuner can supply codec information before it knows any stream index.
  const autoMap = plan.live && plan.streams.some(stream => stream.type !== 'Subtitle' && stream.index < 0);
  if (!autoMap) for (const stream of plan.streams) args.push('-map', overlay && stream.type === 'Video' ? '[video]' : streamMap(stream, plan, subtitles));
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy');
  if (plan.videoOutput && plan.videoOutput.encoder !== 'copy') {
    const filters = overlay ? [] : [...plan.videoOutput.filters];
    if (!overlay && subtitles?.filter) insertTextSubtitle(filters, subtitles.filter);
    if (!overlay && shift !== null) insertTextSubtitle(filters, `setpts=PTS-${shift}/TB`);
    args.push(...videoArguments({ ...plan.videoOutput, filters }, { version }));
  }
  if (plan.audioOutput && plan.audioOutput.encoder !== 'copy') {
    const filters = [...plan.audioOutput.filters];
    if (shift !== null) filters.push(`asetpts=PTS-${shift}/TB`);
    args.push(...audioArguments({ ...plan.audioOutput, filters }));
  }
  if (plan.subtitleEncoder) args.push('-codec:s:0', plan.subtitleEncoder, '-disposition:s:0', 'default');
  const audioCodec = plan.audioOutput?.codec;
  if (['opus', 'dts', 'truehd'].includes(audioCodec) || audioCodec === 'flac' && !encoderVersionAtLeast(version, 6)) args.push('-strict', '-2');
  if (!plan.streams.some(stream => stream.type === 'Video')) args.push('-vn');
  if (!plan.streams.some(stream => stream.type === 'Audio')) args.push('-an');
  if (autoMap || !plan.streams.some(stream => stream.type === 'Subtitle')) args.push('-sn');
  args.push('-dn');
  if (plan.container === 'ts') {
    const video = plan.streams.find(stream => stream.type === 'Video');
    if (!plan.live && plan.videoOutput?.encoder === 'copy' && ['h264', 'hevc'].includes(video?.codec)) args.push('-bsf:v', `${video.codec}_mp4toannexb`);
    if (plan.m2ts) args.push('-mpegts_m2ts_mode', '1');
  }
  if (plan.copyTimestamps) args.push('-copyts', '-avoid_negative_ts', 'disabled', '-start_at_zero');
  if (plan.muxer === 'mp4') args.push('-movflags', plan.mediaType === 'Audio' ? 'empty_moov+delay_moov' : 'frag_keyframe+empty_moov+delay_moov');
  args.push('-f', plan.muxer, 'pipe:1');
  return args;
}

export function hlsArguments(url, plan, directory, startNumber = 0, runtimeTicks = 0n, { threads, version, maxMuxingQueueSize }, subtitles, eventId, audioUrl) {
  if (!privateUrl.test(url)) throw new TypeError('HLS requires a private VFS input.');
  if (eventId != null && !/^[a-f0-9]{32}$/u.test(eventId)) throw new TypeError('Invalid HLS event playlist identity.');
  const prefix = eventId ?? 'segment';
  const probe = probeInput(plan);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '0.5', '-protocol_whitelist', 'http,tcp', ...probe];
  const seek = [];
  if (runtimeTicks > 0n) {
    const maximum = plan.runtime > 50000000n ? plan.runtime - 50000000n : 0n;
    const seekTicks = runtimeTicks + (plan.videoOutput?.encoder === 'copy' ? 5000000n : 0n);
    seek.push('-ss', mediaSeekTime(seekTicks > maximum ? maximum : seekTicks));
    args.push(...seek);
  }
  args.push(...inputPacing(plan, version), ...inputFlags(plan));
  if (plan.discInput) args.push('-f', 'concat', '-safe', '0');
  else if (plan.inputFormat) args.push('-f', plan.inputFormat);
  const overlay = subtitleOverlay(plan, subtitles, runtimeTicks > 0n ? runtimeTicks : plan.start, null);
  args.push(...(plan.videoOutput?.hardware?.inputArgs ?? []), ...(overlay?.canvas ?? []), '-i', url,
    ...bitmapInputArguments(subtitles, overlay, seek, probe), ...externalAudioArguments(plan, audioUrl, seek));
  if (plan.videoOutput?.hardware?.decoder.args.length) args.push('-noautoscale');
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-threads', String(threads));
  if (overlay) args.push('-filter_complex', overlay.graph);
  if (plan.streams.some(stream => stream.index < 0)) args.push('-sn');
  else {
    for (const stream of plan.streams) args.push('-map', overlay && stream.type === 'Video' ? '[video]' : streamMap(stream, plan, subtitles));
    args.push('-map', '-0:s');
  }
  if (plan.video) {
    const output = { ...plan.videoOutput, filters: overlay ? [] : [...(plan.videoOutput.filters ?? [])] };
    if (!overlay && subtitles?.filter) insertTextSubtitle(output.filters, subtitles.filter);
    args.push(...videoArguments(output, { hls: true, event: eventId != null, segmentLength: plan.segmentLength, version }));
    if (plan.videoOutput.codec === 'hevc') args.push('-tag:v:0', 'hvc1');
    if (plan.videoOutput.encoder === 'copy') {
      if (!plan.live && ['h264', 'hevc'].includes(plan.videoOutput.codec) && plan.video.NalLengthSize !== '0') {
        args.push('-bsf:v', plan.videoOutput.codec + '_mp4toannexb');
      }
      args.push('-start_at_zero');
    }
    if (subtitles?.filter) args.push('-start_at_zero');
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
