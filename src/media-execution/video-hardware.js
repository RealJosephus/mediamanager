import { existsSync } from 'node:fs';
import { machine, release } from 'node:os';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';

// Encoder, decoder and input-device selection follows the designated
// Jellyfin EncodingHelper. Driver initialization belongs to FFmpeg.
const hardwareTypes = new Set(['amf', 'nvenc', 'qsv', 'vaapi', 'videotoolbox', 'v4l2m2m', 'rkmpp']);
const fileTypes = new Set(['VideoFile', 'Iso', 'Dvd', 'BluRay']);
const softwareEncoders = new Map([['h264', 'libx264'], ['hevc', 'libx265'], ['av1', 'libsvtav1']]);
const lower = value => String(value ?? '').toLowerCase();
const canonicalCodec = value => ({ avc: 'h264', h265: 'hevc' })[lower(value)] ?? lower(value);
const supports = (capabilities, kind, name) => capabilities[kind]?.includes(name) === true;
const allFilters = (capabilities, ...names) => names.every(name => supports(capabilities, 'filters', name));
const allOptions = (capabilities, ...names) => names.every(name => capabilities.filterOptions?.[name]);
const deviceArg = value => ['-init_hw_device', value];

function openclAvailable(caps) {
  return supports(caps, 'hwaccels', 'opencl') && allFilters(caps, 'scale_opencl')
    && allOptions(caps, 'TonemapOpenclBt2390', 'OverlayOpenclFrameSync');
}

function cudaAvailable(caps) {
  return supports(caps, 'hwaccels', 'cuda') && allFilters(caps, 'yadif_cuda', 'overlay_cuda', 'hwupload_cuda')
    && allOptions(caps, 'ScaleCudaFormat', 'TonemapCudaName');
}

function vaapiSurfaces(caps) {
  return supports(caps, 'hwaccels', 'drm') && allOptions(caps, 'OverlayVaapiFrameSync') && openclAvailable(caps)
    && allFilters(caps, 'alphasrc', 'scale_vaapi', 'deinterlace_vaapi', 'tonemap_vaapi', 'procamp_vaapi', 'transpose_vaapi', 'hwupload_vaapi');
}

function videotoolboxSurfaces(caps, version) {
  return encoderVersionAtLeast(version, 7, 0, 1)
    && allFilters(caps, 'yadif_videotoolbox', 'overlay_videotoolbox', 'tonemap_videotoolbox', 'scale_vt');
}

export function videoEncoder(codec, videoType, options = {}, caps = {}) {
  codec = canonicalCodec(codec) || 'copy';
  if (videoType === 'VideoFile' && options.EnableHardwareEncoding && hardwareTypes.has(options.HardwareAccelerationType)) {
    const type = options.HardwareAccelerationType;
    const mjpegAvailable = codec === 'mjpeg' && ['qsv', 'vaapi', 'videotoolbox', 'rkmpp'].includes(type)
      && (type !== 'vaapi' || caps.vaapiDriver === 'iHD');
    const candidate = codec + '_' + type;
    if ((mjpegAvailable || softwareEncoders.has(codec)) && supports(caps, 'encoders', candidate)) return candidate;
  }
  return softwareEncoders.get(codec) ?? codec;
}

export function fixedHardwareSize(video, request) {
  const width = request.Width ?? video.Width;
  const height = request.Height ?? video.Height;
  if (!(width > 0) || !(height > 0)) return {};
  const maxWidth = Math.min(request.MaxWidth ?? width, 4096);
  const maxHeight = Math.min(request.MaxHeight ?? height, 4096);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: 2 * Math.trunc(Math.round(width * scale) / 2), height: 2 * Math.trunc(Math.round(height * scale) / 2) };
}

function supportsScaling(video, request, maxRatio) {
  const size = fixedHardwareSize(video, request);
  return [[size.width, video.Width], [size.height, video.Height]].every(([out, input]) => {
    const ratio = out / input;
    return ratio >= 1 / maxRatio && ratio <= maxRatio;
  });
}

function videoBitDepth(video) {
  const pixel = lower(video.PixelFormat);
  return video.BitDepth ?? (/^yuv(?:420|422|444)p(10|12)le$/u.exec(pixel) ? Number(pixel.slice(-4, -2)) : 8);
}

export function videoDecoder(video, videoType, outputCodec, request, options, caps = {}, host = {}) {
  const empty = { args: [], surface: undefined, accelerator: undefined };
  const type = options.HardwareAccelerationType;
  if (!video?.Codec || !fileTypes.has(videoType) || outputCodec === 'copy' || !hardwareTypes.has(type)) return empty;
  const platform = host.platform ?? process.platform;
  const linux = platform === 'linux', windows = platform === 'win32', mac = platform === 'darwin';
  const appleSilicon = (host.architecture ?? machine()) === 'arm64';
  // Darwin 23.6 is the kernel shipped with macOS 14.6.
  const osRelease = host.osRelease ?? release();
  const hi10p = type === 'rkmpp' || type === 'videotoolbox' && appleSilicon && encoderVersionAtLeast(osRelease, 23, 6);
  const codec = canonicalCodec(video.Codec), pixel = lower(video.PixelFormat), profile = lower(video.Profile);
  const bitDepth = videoBitDepth(video);
  if (codec === 'h264' && (bitDepth === 10 && !hi10p
    || /4:2:2|4:4:4/u.test(profile) && !(type === 'videotoolbox' && appleSilicon))) return empty;
  if (!options.HardwareDecodingCodecs?.some(name => lower(name) === codec)) return empty;

  const yuv8 = ['yuv420p', 'yuvj420p'].includes(pixel);
  const yuv10 = pixel === 'yuv420p10le';
  const yuv12 = pixel === 'yuv420p12le';
  const expanded = /^(?:yuv422p|yuv444p)(?:(?:10|12)le)?$/u.test(pixel);
  const common8 = ['h264', 'vc1', 'mpeg2video', 'vp8'].includes(codec);
  const common10 = codec === 'vp9' || codec === 'av1';
  const version = host.version ?? caps.version ?? null;
  const legacyExplicitAv1 = codec === 'av1' && version != null && !encoderVersionAtLeast(version, 6);
  const formatChange = video.Rotation && encoderVersionAtLeast(version, 6);
  const vaapi = linux && codec !== 'mpeg4' && supports(caps, 'hwaccels', 'vaapi');
  const d3d11 = windows && supports(caps, 'hwaccels', 'd3d11va');
  const opencl = openclAvailable(caps);
  const alpha = allFilters(caps, 'alphasrc');
  const cuda = (linux || windows) && cudaAvailable(caps);
  let accelerator, surface, explicitDecoder, afbc;
  const rest = [];
  const rext = codec === 'hevc' && (profile === 'rext' || yuv12 || expanded);
  const tenBitBlocked = codec === 'hevc' && bitDepth === 10 && options.EnableDecodingColorDepth10Hevc === false
    || codec === 'vp9' && bitDepth === 10 && options.EnableDecodingColorDepth10Vp9 === false;
  const hwaccelAllowed = type === 'videotoolbox' || (rext
    ? (bitDepth > 10 || options.EnableDecodingColorDepth10HevcRext) && (bitDepth !== 12 || options.EnableDecodingColorDepth12HevcRext)
      && (type !== 'vaapi' || caps.vaapiDriver === 'iHD')
    : !tenBitBlocked);
  if (type === 'qsv' && (linux || windows)
    && (common8 && yuv8 || common10 && (yuv8 || yuv10) || codec === 'hevc' && (yuv8 || yuv10 || yuv12 || expanded))) {
    const qsv = supports(caps, 'hwaccels', 'qsv');
    const native = options.PreferSystemNativeHwDecoder !== false;
    const keepSurfaces = qsv && opencl && alpha && (vaapi || d3d11);
    if (hwaccelAllowed) {
      accelerator = native ? (vaapi ? 'vaapi' : d3d11 ? 'd3d11va' : undefined) : qsv ? 'qsv' : undefined;
      if (keepSurfaces && accelerator) surface = accelerator === 'd3d11va' ? 'd3d11' : accelerator;
    }
    if (!native && !tenBitBlocked) explicitDecoder = (codec === 'mpeg2video' ? 'mpeg2' : codec) + '_qsv';
  }
  if (type === 'nvenc' && (linux || windows)
    && ((common8 || codec === 'mpeg4') && yuv8 || common10 && (yuv8 || yuv10)
      || codec === 'hevc' && (yuv8 || yuv10 || yuv12 || /^yuv444p/u.test(pixel)))) {
    const enhanced = options.EnableEnhancedNvdecDecoder !== false;
    if (cuda && hwaccelAllowed) {
      accelerator = 'cuda';
      if (alpha) surface = 'cuda';
      if (enhanced) {
        if (encoderVersionAtLeast(version, 6)) rest.push('-hwaccel_flags', '+unsafe_output');
        rest.push('-threads', '1');
        if (legacyExplicitAv1) rest.push('-c:v', 'av1');
      }
    }
    if (!enhanced && !tenBitBlocked) explicitDecoder = (codec === 'mpeg2video' ? 'mpeg2' : codec) + '_cuvid';
  }
  if (type === 'amf' && d3d11 && hwaccelAllowed
    && (yuv8 && common8 && codec !== 'vp8' || (yuv8 || yuv10) && (codec === 'hevc' || common10))) {
    accelerator = 'd3d11va';
    if (opencl && alpha) surface = 'd3d11';
  }
  if (type === 'vaapi' && vaapi && hwaccelAllowed
    && (common8 && yuv8 || common10 && (yuv8 || yuv10) || codec === 'hevc' && (yuv8 || yuv10 || yuv12 || expanded))) {
    accelerator = 'vaapi';
    if (vaapiSurfaces(caps)) surface = 'vaapi';
  }
  if (type === 'videotoolbox' && mac && supports(caps, 'hwaccels', 'videotoolbox')
    && (codec === 'vp8' && yuv8 || ['h264', 'vp9'].includes(codec) && (yuv8 || yuv10)
      || codec === 'hevc' && (yuv8 || yuv10 || yuv12 || expanded)
      || codec === 'av1' && caps.videotoolboxAv1 && (yuv8 || yuv10 || yuv12))) {
    accelerator = 'videotoolbox';
    if (videotoolboxSurfaces(caps, version)) surface = 'videotoolbox_vld';
  }
  if (type === 'rkmpp' && linux && hwaccelAllowed && supports(caps, 'hwaccels', 'rkmpp')
    && allFilters(caps, 'scale_rkrga', 'vpp_rkrga', 'overlay_rkrga') && supportsScaling(video, request, 16)) {
    const keepSurfaces = opencl && alpha;
    const modernCodec = ['h264', 'hevc', 'vp9', 'av1'].includes(codec);
    if (modernCodec && (yuv8 || yuv10 && keepSurfaces) || yuv8 && ['mpeg1video', 'mpeg2video', 'mpeg4', 'vp8'].includes(codec)) {
      accelerator = 'rkmpp';
      if (keepSurfaces) surface = 'drm_prime';
      afbc = keepSurfaces && modernCodec && codec !== 'av1' && supportsScaling(video, request, 8);
    }
  }

  const args = [];
  if (accelerator) {
    args.push('-hwaccel', accelerator);
    if (surface) args.push('-hwaccel_output_format', surface);
    if (surface || accelerator === 'videotoolbox') {
      args.push('-noautorotate');
      if (formatChange) args.push('-display_rotation', '0');
    }
    if (['vaapi', 'd3d11va'].includes(accelerator)) {
      if (codec === 'h264' && profile === 'baseline') args.push('-hwaccel_flags', '+allow_profile_mismatch');
      if (accelerator === 'd3d11va') args.push('-threads', '2');
      if (legacyExplicitAv1) args.push('-c:v', 'av1');
    }
    args.push(...rest);
    if (afbc) args.push('-afbc', 'rga');
  }
  if (explicitDecoder && supports(caps, 'decoders', explicitDecoder)) args.push('-c:v', explicitDecoder);
  return { args, surface, accelerator };
}

export function videoHardware(video, videoType, outputCodec, request, options, caps = {}, host = {}) {
  const encoder = videoEncoder(outputCodec, videoType, options, caps);
  const decoder = videoDecoder(video, videoType, outputCodec, request, options, caps, host);
  const empty = { encoder, decoder, inputArgs: [], environment: undefined };
  if (encoder === 'copy') return empty;
  const platform = host.platform ?? process.platform;
  const linux = platform === 'linux', windows = platform === 'win32';
  const type = options.HardwareAccelerationType;
  const available = accelerator => supports(caps, 'hwaccels', accelerator);
  const encoding = encoder.endsWith('_' + type);
  const retained = decoder.args.length > 0;
  const args = [];
  const device = host.deviceExists ?? existsSync;
  let environment;
  if (type === 'nvenc') {
    if (!(linux || windows) || !cudaAvailable(caps) || !retained && !encoding) return empty;
    args.push(...deviceArg('cuda=cu:0'), '-filter_hw_device', 'cu');
  }
  if (type === 'videotoolbox') {
    if (platform !== 'darwin' || !available('videotoolbox') || !retained && !encoding) return empty;
    args.push(...deviceArg('videotoolbox=vt'));
  }
  if (type === 'amf') {
    if (!windows || !available('d3d11va') || !retained && !encoding) return empty;
    args.push(...deviceArg('d3d11va=dx11:,vendor=0x1002'));
    if (openclAvailable(caps)) args.push(...deviceArg('opencl=ocl@dx11'), '-filter_hw_device', 'ocl');
  }
  if (type === 'qsv') {
    if (!(linux || windows) || !available('qsv') || !retained && !encoding) return empty;
    if (linux) {
      const input = options.QsvDevice && device(options.QsvDevice) ? options.QsvDevice
        : encoderVersionAtLeast(host.version ?? caps.version ?? null, 7, 0, 1) ? ',vendor_id=0x8086' : ',kernel_driver=i915';
      args.push(...deviceArg('vaapi=va:' + input + ',driver=iHD'), ...deviceArg('qsv=qs@va'));
    } else {
      const value = /^[-+]?\d+$/u.test(options.QsvDevice?.trim()) ? Number(options.QsvDevice) : undefined;
      const adapter = value == null || value < -2147483648 || value > 2147483647 ? ',vendor=0x8086' : String(Math.max(0, value));
      args.push(...deviceArg('d3d11va=dx11:' + adapter), ...deviceArg('qsv=qs@dx11'));
    }
    args.push('-filter_hw_device', 'qs');
  }
  if (type === 'vaapi') {
    if (!linux || !available('vaapi') || !retained && !encoding) return empty;
    const input = options.VaapiDevice && device(options.VaapiDevice) ? options.VaapiDevice : '';
    if (['iHD', 'i965'].includes(caps.vaapiDriver)) {
      args.push(...deviceArg('vaapi=va:' + input + ',driver=' + caps.vaapiDriver));
      if (caps.vaapiDriver === 'i965') environment = { LIBVA_DRIVER_NAME: 'i965', LIBVA_DRIVER_NAME_JELLYFIN: 'i965' };
    } else if (caps.vaapiDriver === 'amd') {
      environment = { AMD_DEBUG: 'noefc' };
      const vulkan = available('vulkan') && allFilters(caps, 'libplacebo', 'scale_vulkan', 'transpose_vulkan', 'flip_vulkan')
        && allOptions(caps, 'OverlayVulkanFrameSync') && caps.vaapiVulkanInterop
        && encoderVersionAtLeast(host.osRelease ?? release(), 5, 15);
      if (vulkan) {
        args.push(...deviceArg('drm=dr:' + (options.VaapiDevice ?? '/dev/dri/renderD128')),
          ...deviceArg('vaapi=va@dr'), ...deviceArg('vulkan=vk@dr'), '-filter_hw_device', 'vk');
      } else args.push(...deviceArg('vaapi=va' + (input ? ':' + input : '')), '-filter_hw_device', 'va');
    }
  }
  if (type === 'rkmpp') {
    if (!linux || !available('rkmpp') || !retained && !encoding) return empty;
    args.push(...deviceArg('rkmpp=rk'));
  }
  return { encoder, decoder, inputArgs: [...args, ...decoder.args], environment };
}
