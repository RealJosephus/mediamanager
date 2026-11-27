import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { md5Guid } from '../core/identity.js';
import { dateTicks } from '../library/records.js';
import { encodeBlurhash, blurhashComponents } from './blurhash.js';
import { hasDefaultImageOptions, imageMime, imageExtension, newImageSize, roundEven } from './options.js';
import { renderPixels, resizeNearestPixels, stripCanvasColorProfile } from './renderer.js';
import { decodeJpegScaled } from './jpeg-codec/index.js';

const supported = new Set(['jpeg', 'jpg', 'png', 'dng', 'webp', 'gif', 'bmp', 'ico', 'astc', 'ktx', 'pkm', 'wbmp', 'cr2', 'nef', 'arw', 'svg']);
const extension = value => path.extname(value).slice(1).toLowerCase();
const originalResult = image => ({ path: image.Path, mimeType: imageMime(image.Path), dateModified: image.DateModified, original: true });
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
// Older cache writers could leave a prefix of the encoder output at its final name.
function completeCacheEntry(bytes, format) {
  if (format === 'Jpg') return bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;
  if (format === 'Webp') return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8;
  return bytes.subarray(0, 8).equals(pngSignature) && bytes.subarray(-12).equals(pngEnd);
}
function checkSvg(bytes, filename) {
  if (extension(filename) !== 'svg') return;
  const text = bytes.toString('utf8');
  // Admit self-contained PNG image data. Other references still go through
  // the external resource check, including data with a mismatched signature.
  const references = text.replace(/(\bhref\s*=\s*)(['"])data:image\/png;base64,([a-z0-9+/=\s]+)\2/giu,
    (attribute, prefix, quote, payload) => {
      const png = Buffer.from(payload, 'base64');
      return png.subarray(0, 8).equals(pngSignature) && png.subarray(-12).equals(pngEnd)
        ? prefix + quote + '#' + quote : attribute;
    });
  if (/<!DOCTYPE|<!ENTITY|(?:href\s*=\s*['"]\s*[^#'"\s])|url\s*\(\s*[^#\s)]|@import/i.test(references)) throw new Error('SVG external or nested resources are not supported.');
}
async function run(pipeline, signal) {
  signal?.throwIfAborted();
  const abort = () => pipeline.destroy(signal.reason instanceof Error ? signal.reason : new DOMException('Image processing aborted.', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  try { const result = await pipeline.toBuffer({ resolveWithObject: true }); signal?.throwIfAborted(); return result; }
  finally { signal?.removeEventListener('abort', abort); }
}
export class ImageProcessor {
  #options;
  #pending = new Set();
  #lifetime = new AbortController();
  constructor(options = {}) {
    const { fileSystem, logger = { error() {} }, parallelLimit = 1 } = options;
    this.#options = options;
    Object.assign(this, { fileSystem, logger, parallelLimit });
  }
  get cachePath() { return this.#options.cachePath; }
  async getImageSize(bytes, filename, { signal } = {}) {
    signal?.throwIfAborted(); if (!bytes.length) return { Width: 0, Height: 0 };
    checkSvg(bytes, filename);
    try { const meta = await sharp(bytes, { failOn: 'none' }).metadata(); signal?.throwIfAborted(); return { Width: meta.width ?? 0, Height: meta.height ?? 0 }; }
    catch (error) { if (signal?.aborted) throw error; return { Width: 0, Height: 0 }; }
  }
  async getImageBlurHash(bytes, filename, size, { signal } = {}) {
    if (!(size.Width > 0 && size.Height > 0) || !supported.has(extension(filename)) || extension(filename) === 'svg') return '';
    this.#lifetime.signal.throwIfAborted();
    signal = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    while (this.#pending.size >= Math.max(1, this.parallelLimit)) {
      await Promise.race([...this.#pending].map(task => task.catch(() => {}))); signal.throwIfAborted();
    }
    const task = this.#getImageBlurHash(bytes, filename, size, signal); this.#pending.add(task);
    try { return await task; } finally { this.#pending.delete(task); }
  }
  async #getImageBlurHash(bytes, filename, size, signal) {
    const original = await this.getImageSize(bytes, filename, { signal });
    if (!(original.Width > 0 && original.Height > 0)) throw Object.assign(new Error('The image header could not be decoded.'), { code: 'invalid-image' });
    const scale = Math.fround(Math.min(Math.fround(128 / original.Width), Math.fround(128 / original.Height)));
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    let input = jpeg ? null : sharp(bytes, { failOn: 'warning' });
    // Skia's WebP codec scales during decoding before BlurHashSharp applies its second scale.
    if (scale < 1 && webp) input = input.resize(Math.max(1, Math.trunc(Math.fround(original.Width * scale))), Math.max(1, Math.trunc(Math.fround(original.Height * scale))), { kernel: 'nearest', fastShrinkOnLoad: true });
    const { data, info } = jpeg ? await decodeJpegScaled(bytes, scale, { signal })
      : await run(input.toColourspace('srgb').ensureAlpha().raw(), signal);
    let pixels = data, width = info.width, height = info.height;
    if (original.Width > 128 || original.Height > 128) {
      const targetWidth = roundEven(Math.fround(width * scale)), targetHeight = roundEven(Math.fround(height * scale));
      pixels = resizeNearestPixels(pixels, width, height, targetWidth, targetHeight); width = targetWidth; height = targetHeight;
    }
    return encodeBlurhash(pixels, width, height, ...blurhashComponents(size.Width, size.Height));
  }
  async process(options) {
    this.#lifetime.signal.throwIfAborted();
    const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
    while (this.#pending.size >= Math.max(1, this.parallelLimit)) { await Promise.race([...this.#pending].map(task => task.catch(() => {}))); signal.throwIfAborted(); }
    const convert = () => this.#process({ ...options, signal }, this.cachePath, this.#options.storageCacheKey);
    const task = this.#options.withStorageGeneration ? this.#options.withStorageGeneration(convert) : convert();
    this.#pending.add(task);
    try { return await task; } finally { this.#pending.delete(task); }
  }
  async #process({ item = {}, image, assets, signal, ...options }, cachePath, storageKey) {
    const original = originalResult(image), size = image.Width > 0 && image.Height > 0 ? { Width: image.Width, Height: image.Height } : undefined;
    signal.throwIfAborted();
    let source;
    try { source = await assets.stat(image.Path, { signal }); } catch (error) { if (error?.code === 'not-found') return original; throw error; }
    if (original.mimeType === 'image/gif') return original;
    const autoOrient = item.Type === 'Photo' && item.Orientation !== 'TopLeft' && item.Orientation !== 1;
    if (hasDefaultImageOptions(options, image.Path, size) && (!autoOrient || options.RequiresAutoOrientation === false)) return original;
    const formats = options.SupportedOutputFormats ?? ['Jpg', 'Png'];
    const transparency = ['png', 'webp', 'gif', 'svg'].includes(extension(image.Path));
    const format = formats.includes('Webp') ? 'Webp' : transparency && formats.includes('Png') ? 'Png' : formats.find(value => ['Webp', 'Jpg', 'Png', 'Svg'].includes(value)) ?? 'Jpg';
    if (!supported.has(extension(image.Path))) return original;
    try {
      let bytes, version = source?.version;
      if (cachePath && (!version || ['unavailable', 'weak'].includes(source.versionReliability))) {
        bytes = await assets.read(image.Path, { signal });
        version = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      }
      let cache = cachePath && this.#cacheFile(cachePath, image, options, format, storageKey, version);
      if (cache) try {
        const bytes = await this.fileSystem.readFile(cache);
        if (completeCacheEntry(bytes, format)) {
          const info = await this.fileSystem.stat(cache);
          return { bytes, path: cache, mimeType: imageMime(cache), dateModified: info.mtime.toISOString(), original: false };
        }
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      bytes ??= await assets.read(image.Path, { signal });
      checkSvg(bytes, image.Path);
      if (format === 'Svg' && extension(image.Path) !== 'svg') throw new Error('SVG output requires SVG input.');
      let pipeline = sharp(bytes, { failOn: 'warning' }); if (autoOrient) pipeline = pipeline.autoOrient();
      const decoded = await run(pipeline.ensureAlpha().raw(), signal);
      if (hasDefaultImageOptions(options, image.Path, { Width: decoded.info.width, Height: decoded.info.height }) && !autoOrient) return original;
      const target = newImageSize(options, { Width: decoded.info.width, Height: decoded.info.height });
      const canvas = renderPixels(decoded, target, options);
      const quality = Math.max(0, Math.min(100, options.Quality ?? 100));
      const output = stripCanvasColorProfile(await canvas.encode(format === 'Jpg' ? 'jpeg' : format === 'Webp' ? 'webp' : 'png', quality), format); signal.throwIfAborted();
      let dateModified = new Date().toISOString();
      if (cache) {
        await this.fileSystem.mkdir(path.dirname(cache), { recursive: true });
        try {
          await this.fileSystem.writeFile(cache, output, { signal, atomic: true });
          dateModified = (await this.fileSystem.stat(cache)).mtime.toISOString();
        } catch (error) {
          if (error?.code !== 'ENOTSUP') throw error;
          // A mount without atomic publication can still serve the resized bytes.
          cache = undefined;
        }
      }
      return { bytes: output, path: cache, mimeType: format === 'Svg' ? 'image/svg+xml' : imageMime('image' + imageExtension(format)), dateModified, original: false };
    } catch (error) { if (signal.aborted) throw error; this.logger.error(error, 'Error encoding image'); return original; }
  }
  #cacheFile(cachePath, image, options, format, storageKey, version) {
    let value = `${image.Path},quality=${options.Quality ?? 100},datemodified=${dateTicks(image.DateModified)},f=${format}`;
    for (const key of ['Width', 'Height', 'MaxWidth', 'MaxHeight', 'FillWidth', 'FillHeight']) if (options[key] != null) value += `,${key.toLowerCase()}=${options[key]}`;
    if (options.PercentPlayed > 0) value += `,pp=${options.PercentPlayed}`;
    if (options.UnplayedCount != null) value += `,uc=${options.UnplayedCount}`;
    if (options.Blur != null) value += `,blur=${options.Blur}`;
    if (options.BackgroundColor) value += `,b=${options.BackgroundColor}`;
    if (options.ForegroundLayer) value += `,fl=${options.ForegroundLayer}`;
    const id = md5Guid(JSON.stringify([value, storageKey, version, 5])), guid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    return path.join(cachePath, 'resized-images', guid[0], guid + imageExtension(format));
  }
  async close() { this.#lifetime.abort(); await Promise.allSettled(this.#pending); }
}
