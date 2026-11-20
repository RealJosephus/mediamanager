import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { machine, release } from 'node:os';
import path from 'node:path';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { discoverMediaCapabilities } from '../../src/media-execution/capabilities.js';
import { videoHardware } from '../../src/media-execution/video-hardware.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const defaultVideo = { Type: 'Video', Index: 0, Codec: 'h264', PixelFormat: 'yuv420p', BitDepth: 8, Width: 1920, Height: 1080, Profile: 'Main' };
const filters = ['alphasrc', 'scale_cuda', 'yadif_cuda', 'tonemap_cuda', 'overlay_cuda', 'hwupload_cuda',
  'scale_opencl', 'overlay_opencl', 'tonemap_opencl', 'scale_vaapi', 'deinterlace_vaapi', 'tonemap_vaapi', 'procamp_vaapi',
  'transpose_vaapi', 'hwupload_vaapi', 'scale_rkrga', 'vpp_rkrga', 'overlay_rkrga',
  'yadif_videotoolbox', 'overlay_videotoolbox', 'tonemap_videotoolbox', 'scale_vt'];
const capabilities = {
  Encoders: ['libx264', 'libx265', 'libsvtav1', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_amf',
    'h264_videotoolbox', 'h264_rkmpp', 'h264_v4l2m2m', 'hevc_vaapi', 'mjpeg_vaapi'],
  Decoders: ['h264_cuvid', 'h264_qsv', 'hevc_qsv'], Filters: filters,
  Hwaccels: ['cuda', 'vaapi', 'drm', 'qsv', 'opencl', 'd3d11va', 'videotoolbox', 'rkmpp'],
  FilterOptions: { ScaleCudaFormat: true, TonemapCudaName: true, TonemapOpenclBt2390: true, OverlayOpenclFrameSync: true, OverlayVaapiFrameSync: true },
  VaapiDriver: 'iHD', VaapiVulkanInterop: false, VideotoolboxAv1: true, Version: '8.1.3',
};
const scope = (name, type, { options, video, caps, output = 'h264', videoType = 'VideoFile', request = { MaxWidth: 960 } } = {}) => ({
  Name: name, Video: { ...defaultVideo, ...video }, VideoType: videoType, OutputCodec: output, Request: request,
  Options: {
    HardwareAccelerationType: type, HardwareDecodingCodecs: ['h264', 'hevc', 'vc1', 'vp9', 'av1'], ...options,
  },
  Capabilities: { ...capabilities, ...caps },
});

test('the real FFmpeg listing yields the scale, format, and libass filters', async t => {
  const tools = await discoverMediaCapabilities(validationExecutable('ffmpeg'), { signal: t.signal, onError: error => { throw error; } });
  for (const filter of ['scale', 'format', 'subtitles']) assert.ok(tools.filters.includes(filter), filter);
});

test('the designated EncodingHelper selects hardware encode, decode and input devices independently', { skip: !enabled, timeout: 180000 }, async () => {
  const cases = ['none', 'nvenc', 'qsv', 'amf', 'vaapi', 'videotoolbox', 'rkmpp', 'v4l2m2m'].flatMap(type => [
    scope(type + '-copy', type, { output: 'copy' }),
    scope(type + '-resize', type),
    scope(type + '-software-encoder', type, { options: { EnableHardwareEncoding: false } }),
    scope(type + '-software-decoder', type, { options: { HardwareDecodingCodecs: [] } }),
    scope(type + '-dvd', type, { videoType: 'Dvd' }),
  ]);
  cases.push(scope('nvenc-h264-high10', 'nvenc', { video: { Profile: 'High 10', BitDepth: 10, PixelFormat: 'yuv420p10le' } }),
    scope('nvenc-legacy-cuvid', 'nvenc', { options: { EnableEnhancedNvdecDecoder: false } }),
    scope('nvenc-filter-unavailable', 'nvenc', { caps: { FilterOptions: {} } }),
    scope('qsv-explicit-decoder', 'qsv', { options: { PreferSystemNativeHwDecoder: false, QsvDevice: '1' } }),
    scope('vaapi-restricted-filter-chain', 'vaapi', { caps: { FilterOptions: {}, VaapiDriver: 'i965' } }),
    scope('vaapi-amd', 'vaapi', { caps: { VaapiDriver: 'amd' } }),
    scope('vt-av1-supported', 'videotoolbox', { video: { Codec: 'av1', BitDepth: 10, PixelFormat: 'yuv420p10le' } }),
    scope('vt-av1-unavailable', 'videotoolbox', { video: { Codec: 'av1', BitDepth: 10, PixelFormat: 'yuv420p10le' }, caps: { VideotoolboxAv1: false } }),
    scope('rkmpp-scale-limit', 'rkmpp', { request: { MaxWidth: 64 } }),
    scope('rkmpp-ten-bit', 'rkmpp', { video: { BitDepth: 10, PixelFormat: 'yuv420p10le' } }),
    scope('encoder-absent', 'qsv', { output: 'av1' }));
  const root = path.join(validationOutputRoot(), 'video-hardware-' + randomUUID());
  await mkdir(root, { recursive: true });
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify(cases, null, 2));
  await recordOracle({ project: 'tests/playback/fixtures/video-hardware/Oracle.csproj', output: path.join(root, 'native'),
    args: [input, '{output}/selection.json'] });
  const rows = JSON.parse(await readFile(path.join(root, 'native/selection.json'), 'utf8'));
  const observed = cases.map(row => {
    const caps = Object.fromEntries(Object.entries(row.Capabilities).map(([key, value]) => [key[0].toLowerCase() + key.slice(1), value]));
    const options = { ...defaultConfiguration('encoding'), ...row.Options };
    const selection = videoHardware(row.Video, row.VideoType, row.OutputCodec, row.Request, options, caps,
      { platform: process.platform, architecture: machine(), osRelease: release() });
    return { Name: row.Name, Encoder: selection.encoder, Decoder: selection.decoder.args, Input: selection.inputArgs };
  });
  await writeFile(path.join(root, 'node-selection.json'), JSON.stringify(observed, null, 2));
  const split = value => value.trim().split(/\s+/u).filter(Boolean);
  assert.deepEqual(observed, rows.map(row => ({ ...row, Decoder: split(row.Decoder), Input: split(row.Input) })));
});
