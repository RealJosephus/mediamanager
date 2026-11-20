import { videoColorRange } from '../library/media-streams.js';
import { encoderVersionAtLeast } from '../playback/media-encoder.js';
import { StorageError } from '../storage/errors.js';
import { mediaSeekTime, nativeInputFormat } from './input.js';
import { captureMediaProcess } from './process.js';

const resolutions = { P144: '256x144', P240: '426x240', P360: '640x360', P480: '854x480',
  P720: '1280x720', P1080: '1920x1080', P1440: '2560x1440', P2160: '3840x2160' };
const formats = { jpeg: { codec: 'mjpeg', magic: [0xff, 0xd8] }, png: { codec: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  bmp: { codec: 'bmp', magic: [0x42, 0x4d] }, gif: { codec: 'gif', magic: [0x47, 0x49, 0x46] },
  webp: { codec: 'libwebp', magic: [0x52, 0x49, 0x46, 0x46] } };
const stereoCrop = String.raw`setdar=dar=a,crop=min(iw\,ih*dar):min(ih\,iw/dar):(iw-min(iw\,iw*sar))/2:(ih - min (ih\,ih/sar))/2,setsar=sar=1`;
const stereoScalers = { HalfSideBySide: 'crop=iw/2:ih:0:0,scale=(iw*2):ih,' + stereoCrop,
  FullSideBySide: 'crop=iw/2:ih:0:0,' + stereoCrop, HalfTopAndBottom: 'crop=iw:ih/2:0:0,scale=(iw*2):ih,' + stereoCrop,
  FullTopAndBottom: 'crop=iw:ih/2:0:0,' + stereoCrop };

export async function extractStillImage(mediaEncoder, url, { container, stream, imageIndex, stereo, offset,
  configuration = {}, audio = false, format = 'jpeg', signal } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/u.test(url)) throw new TypeError('Still image extraction requires a private VFS input.');
  if (!mediaEncoder.ready) throw new StorageError('unavailable', 'The still image encoder is unavailable.');
  const output = formats[format];
  if (!output) throw new TypeError('The requested extraction image format is unknown.');
  const range = stream ? videoColorRange(stream) : ['Unknown', 'Unknown'];
  const hdr = range[0] === 'HDR';
  const dovi = range[1] === 'DOVI';
  const capabilities = mediaEncoder.capabilities;
  const tonemap = hdr && capabilities.filters?.includes('tonemapx')
    ? `tonemapx=tonemap=bt2390:desat=0:peak=${dovi ? '400' : '100'}:t=bt709:m=bt709:p=bt709:format=yuv420p:range=full`
    : hdr && !dovi && capabilities.filters?.includes('zscale')
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=100,zscale=t=bt709:m=bt709:out_range=full,format=yuv420p'
      : null;
  const inputFormat = nativeInputFormat(container);
  const tradeoff = /^true$/iu.test(mediaEncoder.environment?.['JELLYFIN_FFmpeg__imgExtractPerfTradeoff'] ?? '');
  const run = async keyframe => {
    const args = ['-nostdin', '-hide_banner', '-protocol_whitelist', 'http,tcp'];
    if (inputFormat) args.push('-f', inputFormat);
    if (keyframe && (tradeoff || offset != null && container?.toLowerCase() === 'mpegts')) args.push('-skip_frame', 'nokey');
    if (offset != null) args.push('-ss', mediaSeekTime(offset));
    args.push('-i', url);
    if (imageIndex != null) args.push('-map', `0:${imageIndex}`);
    const filters = [stream?.IsInterlaced && 'bwdif=0:-1:0', stereoScalers[stereo] ?? 'scale=round(iw*sar/2)*2:round(ih/2)*2',
      keyframe && !tradeoff && container?.toLowerCase() !== 'wtv' && 'thumbnail=n=24', tonemap].filter(Boolean);
    args.push('-threads', String(mediaEncoder.probeThreads), '-v', 'error', '-vframes', '1', '-vf', filters.join(','));
    if (!audio && resolutions[configuration.ChapterImageResolution]) args.push('-s', resolutions[configuration.ChapterImageResolution]);
    args.push(encoderVersionAtLeast(mediaEncoder.version, 5, 1) ? '-fps_mode' : '-vsync', encoderVersionAtLeast(mediaEncoder.version, 5, 1) ? 'auto' : '-1',
      '-c:v', output.codec, '-f', 'image2pipe', 'pipe:1');
    const { stdout, exitCode } = await captureMediaProcess(mediaEncoder.encoderPath, args, {
      environment: mediaEncoder.environment, signal, timeoutMs: configuration.ImageExtractionTimeoutMs > 0
        ? configuration.ImageExtractionTimeoutMs : tonemap ? 20000 : 10000, maxOutputBytes: 128 * 1024 * 1024,
    });
    if (exitCode !== 0 || !output.magic.every((value, index) => stdout[index] === value)) {
      throw new StorageError('invalid-response', 'FFmpeg did not produce the requested image.');
    }
    return stdout;
  };
  if (!audio) {
    try { return await run(true); }
    catch (error) { if (signal?.aborted || error.code === 'cancelled') throw error; }
  }
  return run(false);
}
