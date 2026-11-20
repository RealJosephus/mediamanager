import { videoColorRange } from '../library/media-streams.js';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';
import { fixedHardwareSize, videoBitDepth, videoHardware } from './video-hardware.js';

const codecProfiles = {
  h264: ['constrainedbaseline', 'baseline', 'extended', 'main', 'high', 'progressivehigh', 'constrainedhigh', 'high10'],
  hevc: ['main', 'main10'],
  av1: ['main', 'high', 'professional'],
};
const lower = value => String(value ?? '').toLowerCase();
const normalizeCodec = value => lower(value) === 'h265' ? 'hevc' : lower(value);
const option = (request, codec, name) => request.StreamOptions?.[`${codec}-${name}`] ?? request.StreamOptions?.[name];
const list = value => lower(value).split(',').filter(Boolean);
const frameRate = video => video.ReferenceFrameRate ?? video.AverageFrameRate ?? video.RealFrameRate;
const formatProfile = value => lower(value).replace(/\s+/gu, '');
const codecFactor = codec => ({ hevc: 0.6, vp9: 0.6, av1: 0.5 })[normalizeCodec(codec)] ?? 1;

function scaleBitrate(bitrate, input, output) {
  let scale = Math.max(codecFactor(output) / codecFactor(input), 1);
  if (bitrate <= 500000) scale = Math.max(scale, 4);
  else if (bitrate <= 1000000) scale = Math.max(scale, 3);
  else if (bitrate <= 2000000) scale = Math.max(scale, 2.5);
  else if (bitrate <= 3000000) scale = Math.max(scale, 2);
  else if (bitrate >= 30000000) scale = 1;
  return Math.round(bitrate * scale);
}

export function outputVideoBitrate(video, request, codec) {
  if (!video || request.VideoBitRate == null) return 0;
  let bitrate = request.VideoBitRate;
  const upscale = request.Width > video.Width && request.Height > video.Height;
  if (!upscale && video.BitRate != null) {
    const input = video.BitRate;
    bitrate = Math.min(bitrate, input <= 2000000 ? Math.round(input * 2.5) : input <= 3000000 ? input * 2 : input);
  }
  return Math.min(scaleBitrate(bitrate, video.Codec, codec), request.VideoBitRate, 400000000);
}

function canCopy(video, source, request, codecs) {
  const codec = normalizeCodec(video.Codec);
  if (!codec || request.BurnSubtitle || codecs.length > 0 && !codecs.includes(codec)
    || request.EnableAutoStreamCopy === false || request.AllowVideoStreamCopy === false) return false;
  if (request.RequireAvc && codec === 'h264' && video.IsAVC === false || request.RequireNonAnamorphic && video.IsAnamorphic
    || video.IsInterlaced && (request.DeInterlace || lower(option(request, codec, 'deinterlace')) === 'true')) return false;
  const limits = [
    [request.MaxWidth, video.Width], [request.MaxHeight, video.Height], [request.VideoBitRate, video.BitRate],
    [request.MaxFramerate ?? request.Framerate, frameRate(video) == null ? null : frameRate(video) - 0.05],
  ];
  if (limits.some(([maximum, value]) => maximum != null && (value == null || value > maximum))) return false;
  if (request.Width != null && request.Width !== video.Width || request.Height != null && request.Height !== video.Height) return false;
  const knownLimits = [[request.Level ?? option(request, codec, 'level'), video.Level],
    [request.MaxVideoBitDepth ?? option(request, codec, 'videobitdepth'), video.BitDepth],
    [request.MaxRefFrames ?? option(request, codec, 'maxrefframes'), video.RefFrames]];
  if (knownLimits.some(([limit, value]) => limit != null && value != null && value > Number(limit))) return false;
  const profiles = list(request.Profile ?? option(request, codec, 'profile')).map(formatProfile);
  const current = formatProfile(video.Profile);
  if (profiles.length && current && !profiles.includes(current)) {
    const ranks = codecProfiles[codec] ?? [];
    const rank = ranks.indexOf(current);
    if (rank < 0 || rank > ranks.indexOf(profiles[0])) return false;
  }
  const rotations = list(option(request, codec, 'rotation'));
  if (rotations.length && video.Rotation && !rotations.includes(String(video.Rotation))) return false;
  const tag = option(request, codec, 'codectag');
  if (tag && !list(tag).includes(lower(video.CodecTag))) return false;
  const ranges = list(option(request, codec, 'rangetype'));
  if (ranges.length) {
    const range = lower(video.VideoRangeType ?? videoColorRange(video)[1]);
    const fallback = ({ hdr10plus: 'hdr10', doviwithhdr10: 'hdr10', doviwithhlg: 'hlg', doviwithsdr: 'sdr' })[range];
    if (range === 'unknown' || ranges.length === 1 && ranges[0] === 'sdr' && range !== 'sdr'
      || !ranges.includes(range) && !ranges.includes(fallback)) return false;
  }
  return !(lower(source.Container) === 'avi' && codec === 'h264');
}

const resolutionBudgets = [[416, 365000], [640, 730000], [768, 1100000], [960, 3000000],
  [1280, 6000000], [1920, 13500000], [2560, 28000000], [3840, 50000000]];

function videoResolution(video, request, rate, codec, bitrate) {
  let { Width, Height, MaxWidth, MaxHeight } = request;
  if (video.BitRate != null && request.VideoBitRate >= video.BitRate && Width == null && Height == null && MaxWidth == null && MaxHeight == null) {
    return { Width, Height, MaxWidth: video.Width, MaxHeight: video.Height };
  }
  if (!(video.BitRate != null && bitrate >= video.BitRate && (MaxWidth != null || MaxHeight != null))) {
    const fps = rate || 30;
    const reference = scaleBitrate(bitrate, codec, 'h264') * (fps <= 30 ? 30 / fps : 1 / Math.sqrt(fps / 30));
    const ceiling = resolutionBudgets.find(([, value]) => Math.round(reference) <= value)?.[0];
    if (ceiling != null && (MaxWidth == null || MaxWidth > ceiling)) {
      MaxWidth = ceiling;
      MaxHeight = undefined;
    }
  }
  return { Width, Height, MaxWidth, MaxHeight };
}

function dimensions(video, { Width, Height, MaxWidth, MaxHeight }) {
  const swap = Math.abs(video.Rotation) === 90;
  const inputWidth = swap ? video.Height : video.Width, inputHeight = swap ? video.Width : video.Height;
  if (!(inputWidth > 0 && inputHeight > 0)) return { width: MaxWidth ?? Width, height: MaxHeight ?? Height };
  let width = Width ?? (Height ? Math.round(Height * inputWidth / inputHeight) : inputWidth);
  let height = Height ?? (Width ? Math.round(Width * inputHeight / inputWidth) : inputHeight);
  if (MaxHeight > 0 && height > MaxHeight) { width = Math.round(width * MaxHeight / height); height = MaxHeight; }
  if (MaxWidth > 0 && width > MaxWidth) { height = Math.round(height * MaxWidth / width); width = MaxWidth; }
  return { width, height };
}

function softwareScale({ Width, Height, MaxWidth, MaxHeight }, alignment) {
  if (Width && Height) return alignment === 64 ? `scale=trunc(${Width}/64)*64:trunc(${Height}/2)*2` : `scale=${Width}:${Height}`;
  if (MaxWidth && MaxHeight) return String.raw`scale=trunc(min(max(iw\,ih*a)\,min(${MaxWidth}\,${MaxHeight}*a))/${alignment})*${alignment}:trunc(min(max(iw/a\,ih)\,min(${MaxWidth}/a\,${MaxHeight}))/2)*2`;
  if (Width) return `scale=${Width}:trunc(ow/a/2)*2`;
  if (Height) return `scale=trunc(oh*a/${alignment})*${alignment}:${Height}`;
  if (MaxWidth) return String.raw`scale=trunc(min(max(iw\,ih*a)\,${MaxWidth})/${alignment})*${alignment}:trunc(ow/a/2)*2`;
  if (MaxHeight) return String.raw`scale=trunc(oh*a/${alignment})*${alignment}:min(max(iw/a\,ih)\,${MaxHeight})`;
}

function hardwareScale(filter, format, video, request) {
  const { width, height } = fixedHardwareSize(video, request);
  const args = [];
  if (width && height && (width !== video.Width || height !== video.Height)) args.push('w=' + width, 'h=' + height);
  if (format) args.push('format=' + format);
  return args.length ? filter + '=' + args.join(':') : undefined;
}

function videoFilters(video, request, options, caps, selected, requestedRate, needsDeinterlace) {
  const { encoder, decoder } = selected;
  const hardware = selected.inputArgs.includes('-hwaccel_output_format') ? decoder.surface : undefined;
  const filters = [];
  const method = options.DeinterlaceMethod === 'yadif' ? 'yadif' : 'bwdif';
  const doubleRate = Boolean(options.DeinterlaceDoubleRate && frameRate(video) <= 30);
  const deinterlace = doubleRate ? '1:-1:0' : '0:-1:0';
  if (requestedRate && !needsDeinterlace) filters.push('fps=' + requestedRate);

  if (hardware === 'cuda') {
    filters.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
    if (needsDeinterlace) filters.push((method === 'bwdif' && caps.filters?.includes('bwdif_cuda') ? 'bwdif_cuda=' : 'yadif_cuda=') + deinterlace);
    filters.push(hardwareScale('scale_cuda', 'yuv420p', video, request));
    if (!encoder.endsWith('_nvenc')) filters.push('hwdownload', 'format=yuv420p');
  } else if (hardware === 'videotoolbox_vld' && caps.filters?.includes('alphasrc')) {
    if (needsDeinterlace) filters.push('yadif_videotoolbox=' + deinterlace);
    filters.push(hardwareScale('scale_vt', video.PixelFormat === 'yuv420p' ? undefined : 'nv12', video, request));
    if (!encoder.endsWith('_videotoolbox')) filters.push('hwdownload', 'format=nv12');
  } else if (options.HardwareAccelerationType === 'vaapi' && (hardware === 'vaapi' || encoder.endsWith('_vaapi'))
    && caps.filters?.includes('scale_vaapi')) {
    if (!hardware) {
      if (needsDeinterlace) filters.push(method + '=' + deinterlace);
      filters.push('format=nv12', 'hwupload');
    } else if (needsDeinterlace) filters.push('deinterlace_vaapi=rate=' + (doubleRate ? 'field' : 'frame'));
    filters.push(hardwareScale('scale_vaapi', 'nv12', video, request));
    if (!encoder.endsWith('_vaapi')) filters.push('hwdownload', 'format=nv12');
  } else {
    if (hardware) filters.push('hwdownload', 'format=nv12');
    const [range, rangeType] = videoColorRange(video);
    const tonemap = range === 'HDR' && videoBitDepth(video) >= 10 && caps.filters?.includes('tonemapx');
    const transfer = lower(video.ColorTransfer) === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
    filters.push(tonemap ? 'setparams=color_primaries=bt2020:color_trc=' + transfer + ':colorspace=bt2020nc'
      : 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
    if (needsDeinterlace) filters.push(method + '=' + deinterlace);
    const alignment = encoder === 'h264_v4l2m2m' ? 64 : 2;
    const format = encoder.endsWith('_vaapi') || decoder.args.length ? 'nv12' : 'yuv420p';
    filters.push(softwareScale(request, alignment));
    if (tonemap) {
      const args = ['tonemap=' + (options.TonemappingAlgorithm ?? 'bt2390'), 'desat=' + (options.TonemappingDesat ?? 0),
        'peak=' + (options.TonemappingPeak ?? 100), 't=bt709', 'm=bt709', 'p=bt709',
        'format=' + (rangeType === 'DOVI' ? 'yuv420p' : format)];
      if (options.TonemappingParam) args.push('param=' + options.TonemappingParam);
      if (options.TonemappingRange === 'tv' || options.TonemappingRange === 'pc') args.push('range=' + options.TonemappingRange);
      filters.push('tonemapx=' + args.join(':'));
    } else filters.push('format=' + format);
    if (encoder.endsWith('_vaapi')) filters.push('hwupload');
  }
  if (requestedRate && needsDeinterlace) filters.push('fps=' + requestedRate);
  return filters.filter(Boolean);
}

export function videoStreamPlan(video, source, request, allowed, { configuration = {}, capabilities = {}, version } = {}) {
  const inputCodec = normalizeCodec(video.Codec);
  const codecs = list(request.VideoCodec).map(normalizeCodec);
  const bitrate = outputVideoBitrate(video, request, codecs[0]);
  if (allowed.includes(inputCodec) && (codecs[0] === 'copy' || canCopy(video, source, request, codecs))) {
    return { codec: inputCodec, encoder: 'copy', width: video.Width, height: video.Height, frameRate: frameRate(video), bitrate,
      profile: video.Profile, level: video.Level };
  }
  const codec = codecs.find(name => allowed.includes(name) && ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg4', 'mpeg2video'].includes(name));
  if (!codec || request.PermitVideoEncoding === false || video.IsExternal || video.Path) return;
  if ([request.Width, request.Height, request.MaxWidth, request.MaxHeight].some(value => value != null
    && (!Number.isInteger(value) || value < 2))) return;
  const rate = frameRate(video);
  const requestedRate = request.Framerate ?? (rate > request.MaxFramerate ? request.MaxFramerate : undefined);
  const resized = videoResolution(video, request, requestedRate ?? rate, codec, bitrate);
  const selected = videoHardware(video, source.VideoType ?? 'VideoFile', codec, resized, configuration, capabilities, { version });
  const encoder = ({ vp8: 'libvpx', vp9: 'libvpx-vp9' })[selected.encoder] ?? selected.encoder;
  if (capabilities.encoders && !capabilities.encoders.includes(encoder)) return;
  const rawProfile = formatProfile(list(request.Profile ?? option(request, codec, 'profile'))[0]);
  let profile = codecProfiles[codec]?.includes(rawProfile) ? rawProfile : undefined;
  if (profile === 'extended' || profile === 'main10') profile = 'main';
  if (profile?.includes('baseline')) profile = /_(?:vaapi|amf)$/u.test(encoder) ? 'constrained_baseline' : 'baseline';
  if (codec === 'h264' && profile?.includes('high')) profile = 'high';
  if (codec === 'av1' && profile && profile !== 'main') profile = 'main';
  const level = Number(request.Level ?? option(request, codec, 'level'));
  const deinterlace = Boolean(video.IsInterlaced && (request.DeInterlace || lower(option(request, codec, 'deinterlace')) === 'true'));
  const filters = videoFilters(video, resized, configuration, capabilities, selected, requestedRate, deinterlace);
  const crf = codec === 'hevc' ? configuration.H265Crf : configuration.H264Crf;
  return { codec, encoder, ...dimensions(video, resized), frameRate: requestedRate ?? rate, requestedRate, bitrate, profile,
    level: Number.isFinite(level) && level >= 0 ? level : undefined, filters, hardware: selected,
    preset: configuration.EncoderPreset, crf, crfDefault: codec === 'hevc' ? 28 : 23, realFrameRate: video.RealFrameRate,
    vaapiDriver: capabilities.vaapiDriver };
}

export function videoArguments(plan, { hls = false, segmentLength, version } = {}) {
  const args = ['-codec:v:0', plan.encoder];
  if (plan.encoder === 'copy') return args;
  const configured = ['veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'];
  const preset = plan.preset === 'auto' ? 'veryfast' : configured.includes(plan.preset) ? plan.preset : hls ? 'veryfast' : 'superfast';
  if (plan.encoder === 'libx264' || plan.encoder === 'libx265') {
    args.push('-preset', preset, '-crf', String(plan.crf >= 0 && plan.crf <= 51 ? plan.crf : plan.crfDefault));
  } else if (plan.encoder === 'libsvtav1') args.push('-preset', String(configured.indexOf(preset) + 5));
  if (plan.bitrate > 0) {
    const bitrate = plan.encoder === 'h264_qsv' ? Math.max(1000, plan.bitrate) : plan.bitrate;
    const rate = String(bitrate), buffer = String(bitrate * 2);
    if (/^libx26[45]$/u.test(plan.encoder)) args.push('-maxrate', rate, '-bufsize', buffer);
    else if (plan.encoder === 'libsvtav1') args.push('-b:v', rate, '-bufsize', buffer);
    else if (plan.encoder.endsWith('_videotoolbox')) args.push('-b:v', rate, '-qmin', '-1', '-qmax', '-1');
    else if (plan.encoder.endsWith('_qsv')) {
      if (plan.codec === 'h264' || plan.codec === 'hevc') args.push('-mbbrc', '1');
      const factor = plan.codec === 'h264' && plan.level != null && plan.level < 51 ? 1 : 2;
      args.push('-b:v', rate, '-maxrate', String(bitrate + 1), '-rc_init_occupancy', String(bitrate * factor), '-bufsize', String(bitrate * 2 * factor));
    } else {
      if (plan.encoder.endsWith('_vaapi')) args.push('-rc_mode', plan.vaapiDriver === 'i965' ? 'CBR' : 'VBR');
      if (plan.encoder.endsWith('_amf') && plan.codec !== 'av1') args.push('-rc', 'cbr', '-qmin', '0', '-qmax', '32');
      args.push('-b:v', rate, '-maxrate', rate, '-bufsize', buffer);
    }
  }
  if (plan.requestedRate) args.push('-r', String(plan.requestedRate));
  if (plan.profile && !['av1_nvenc', 'h264_v4l2m2m'].includes(plan.encoder)) args.push('-profile:v:0', plan.profile);
  if (plan.level && !/(?:libx265|nvenc|vaapi)/u.test(plan.encoder) && plan.codec !== 'av1') {
    args.push('-level', String(plan.encoder === 'hevc_qsv' ? plan.level / 3 : plan.level));
  }
  if (plan.encoder === 'libx264') args.push('-x264opts:0', 'subme=0:me_range=16:rc_lookahead=10:me=hex:open_gop=0');
  if (plan.encoder === 'libx265') args.push('-x265-params:0', 'no-scenecut=1:no-open-gop=1:no-info=1');
  if (plan.encoder === 'libsvtav1' && encoderVersionAtLeast(version, 5, 1)) args.push('-svtav1-params:0', 'rc=1:tune=0:film-grain=0:enable-overlays=1:enable-tf=0');
  if (hls) {
    const onlyGop = /_(?:qsv|nvenc|amf|rkmpp)$/u.test(plan.encoder) || plan.encoder === 'libsvtav1';
    const onlyExpression = /^libx26[45]$/u.test(plan.encoder) || plan.encoder.endsWith('_vaapi');
    if (!onlyGop) args.push('-force_key_frames:0', `expr:gte(t,n_forced*${segmentLength})`);
    if (plan.encoder === 'libx264') args.push('-sc_threshold:v:0', '0');
    if (!onlyExpression && plan.realFrameRate > 0) {
      const gop = String(Math.ceil(segmentLength * plan.realFrameRate));
      args.push('-g:v:0', gop, '-keyint_min:v:0', gop);
    }
  }
  if (plan.filters.length) args.push('-vf', plan.filters.join(','));
  return args;
}
