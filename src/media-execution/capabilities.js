import { cpus, machine } from 'node:os';
import { StorageError } from '../storage/errors.js';
import { captureMediaProcess } from './process.js';

const listings = {
  encoders: /^\s*[VAS][A-Z.]{5}\s+([\w-]+)\s/mgu,
  decoders: /^\s*[VAS][A-Z.]{5}\s+([\w-]+)\s/mgu,
  filters: /^[ \t]+[T.][S.][C.]?[ \t]+([\w-]+)[ \t]+[AVN|]+->[AVN|]+/mgu,
  bsfs: /^([\w-]+)\r?$/mgu,
  hwaccels: /^([\w-]+)\r?$/mgu,
};

const filterOptions = {
  ScaleCudaFormat: ['scale_cuda', 'format'],
  TonemapCudaName: ['tonemap_cuda', 'GPU accelerated HDR to SDR tonemapping'],
  TonemapOpenclBt2390: ['tonemap_opencl', 'bt2390'],
  OverlayOpenclFrameSync: ['overlay_opencl', 'Action to take when encountering EOF from secondary input'],
  OverlayVaapiFrameSync: ['overlay_vaapi', 'Action to take when encountering EOF from secondary input'],
  OverlayVulkanFrameSync: ['overlay_vulkan', 'Action to take when encountering EOF from secondary input'],
  TransposeOpenclReversal: ['transpose_opencl', 'rotate by half-turn'],
  OverlayOpenclAlphaFormat: ['overlay_opencl', 'alpha_format'],
  OverlayCudaAlphaFormat: ['overlay_cuda', 'alpha_format'],
};
const bitstreamOptions = {
  HevcMetadataRemoveDovi: ['hevc_metadata', 'remove_dovi'],
  HevcMetadataRemoveHdr10Plus: ['hevc_metadata', 'remove_hdr10plus'],
  Av1MetadataRemoveDovi: ['av1_metadata', 'remove_dovi'],
  Av1MetadataRemoveHdr10Plus: ['av1_metadata', 'remove_hdr10plus'],
  DoviRpuStrip: ['dovi_rpu', 'strip'],
};
const vulkanInteropExtensions = ['VK_KHR_external_memory_fd', 'VK_EXT_external_memory_dma_buf',
  'VK_KHR_external_semaphore_fd', 'VK_EXT_external_memory_host'];
const checkAbort = signal => {
  if (signal.aborted) throw Object.assign(new StorageError('cancelled', 'Media probing was cancelled.'), { cause: signal.reason });
};

async function discoverOptions(check, entries, available, type, title) {
  const scopes = [...new Set(Object.values(entries).map(([name]) => name))].filter(name => available.includes(name));
  const help = new Map(await Promise.all(scopes.map(async name => [name, await check(['-h', type + '=' + name])])));
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, [name, option]]) => {
    const text = help.get(name) ?? '';
    return [key, text.includes(title + name) && text.includes(option)];
  })));
}

export async function discoverDeviceCapabilities(executable, capabilities, configuration, { signal, environment, onCleanupError, onError }) {
  const failures = [];
  const check = async (args, includeDiagnostics = false) => {
    try {
      const { stdout, stderr } = await captureMediaProcess(executable, args, {
        signal, environment, onCleanupError, timeoutMs: 15000, maxOutputBytes: 1024 * 1024,
      });
      return stdout.toString('utf8') + (includeDiagnostics ? '\n' + stderr.toString('utf8') : '');
    } catch (error) {
      if (!signal.aborted) {
        try { await onError(error); } catch (reportingError) { failures.push(reportingError); }
      }
      return '';
    }
  };
  const filters = discoverOptions(check, filterOptions, capabilities.filters, 'filter', 'Filter ');
  const bitstreams = discoverOptions(check, bitstreamOptions, capabilities.bsfs, 'bsf', 'Bit stream filter ');
  let vaapiDriver, vaapiVulkanInterop = false, vaapiVulkanModifier = false, videotoolboxAv1 = false;
  if (process.platform === 'linux' && configuration.HardwareAccelerationType === 'vaapi'
    && capabilities.hwaccels.includes('vaapi') && configuration.VaapiDevice) {
    const path = configuration.VaapiDevice;
    const [vaapi, vulkan] = await Promise.all([
      check(['-v', 'verbose', '-hide_banner', '-init_hw_device', 'vaapi=va:' + path], true),
      check(['-v', 'verbose', '-hide_banner', '-init_hw_device', 'drm=dr:' + path, '-init_hw_device', 'vulkan=vk@dr'], true),
    ]);
    if (vaapi.includes('Mesa Gallium driver')) vaapiDriver = 'amd';
    else if (vaapi.includes('Intel iHD driver')) vaapiDriver = 'iHD';
    else if (vaapi.includes('Intel i965 driver')) vaapiDriver = 'i965';
    vaapiVulkanInterop = vulkanInteropExtensions.every(name => vulkan.includes(name));
    vaapiVulkanModifier = vulkan.includes('VK_EXT_image_drm_format_modifier');
  }
  if (process.platform === 'darwin' && capabilities.hwaccels.includes('videotoolbox') && machine() === 'arm64') {
    const model = cpus()[0]?.model;
    videotoolboxAv1 = Boolean(model && !/M[12]/iu.test(model));
  }
  const [filterSupport, bsfSupport] = await Promise.all([filters, bitstreams]);
  checkAbort(signal);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Media device discovery failed.');
  return Object.freeze({ ...capabilities, filterOptions: filterSupport, bitstreamOptions: bsfSupport,
    vaapiDriver, vaapiVulkanInterop, vaapiVulkanModifier, videotoolboxAv1 });
}

export async function discoverMediaCapabilities(executable, { signal, environment, onCleanupError, onError }) {
  const result = await Promise.allSettled(Object.entries(listings).map(async ([kind, pattern]) => {
    try {
      const { stdout } = await captureMediaProcess(executable, ['-' + kind], {
        signal, environment, onCleanupError, timeoutMs: 15000, maxOutputBytes: 1024 * 1024,
      });
      return [kind, [...new Set(Array.from(stdout.toString('utf8').matchAll(pattern), match => match[1].toLowerCase()))]];
    } catch (error) {
      if (!signal.aborted) await onError(error);
      return [kind, []];
    }
  }));
  checkAbort(signal);
  const failures = result.filter(entry => entry.status === 'rejected').map(entry => entry.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Media capability discovery failed.');
  return Object.freeze(Object.fromEntries(result.map(({ value: [kind, names] }) => [kind, Object.freeze(names)])));
}
