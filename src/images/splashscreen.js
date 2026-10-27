import path from 'node:path';
import sharp from 'sharp';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { imagePathApi } from '../metadata/image-assets.js';
import { resizeLinearMipmaps } from './renderer.js';

const width = 1920, height = 1080, wallWidth = width * 3, wallHeight = height * 2;
const rows = 6, spacing = 20, tileHeight = wallHeight / rows;
const matrix = [0.324108899, -0.244337708, 42.0407715, 0.0377609022, 0.563934922, -198.104706,
  -9.08959337e-5, 6.85242048e-5, 0.988209724].map(Math.fround);
const [a, b, c, d, e, f, g, h, i] = matrix;
const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
const inverse = [e * i - f * h, c * h - b * i, b * f - c * e,
  f * g - d * i, a * i - c * g, c * d - a * f,
  d * h - e * g, b * g - a * h, a * e - b * d].map(value => value / determinant);

function surface(pixels, width, height) {
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas;
}
function premultipliedSurface(pixels, width, height) {
  const straight = Buffer.from(pixels);
  for (let offset = 0; offset < straight.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
    straight[offset + channel] = straight[offset + 3] ? Math.min(255, Math.round(straight[offset + channel] * 255 / straight[offset + 3])) : 0;
  }
  return surface(straight, width, height);
}

/** Transform the bounded image wall into the native splashscreen viewport. */
export function transformSplashscreen(pixels, sourceWidth = wallWidth, sourceHeight = wallHeight) {
  if (pixels.length !== sourceWidth * sourceHeight * 4) throw new TypeError('A splashscreen wall requires premultiplied RGBA pixels.');
  const result = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const target = (y * width + x) * 4, px = x + 0.5, py = y + 0.5;
    const denominator = inverse[6] * px + inverse[7] * py + inverse[8];
    // Nearest sampling includes the left/top pixel at an integer boundary.
    const sourceX = Math.ceil((inverse[0] * px + inverse[1] * py + inverse[2]) / denominator) - 1;
    const sourceY = Math.ceil((inverse[3] * px + inverse[4] * py + inverse[5]) / denominator) - 1;
    if (sourceX >= 0 && sourceX < sourceWidth && sourceY >= 0 && sourceY < sourceHeight) {
      const source = (sourceY * sourceWidth + sourceX) * 4;
      for (let channel = 0; channel < 3; channel++) result[target + channel] = pixels[source + channel];
    }
    result[target + 3] = 255;
  }
  return result;
}

async function decodeImage(filename, { assets, signal }) {
  let info;
  try { info = await assets.stat(filename, { signal }); }
  catch (error) { if (error?.code === 'not-found') return null; throw error; }
  if (info.kind !== 'file') throw Object.assign(new Error('File not found'), { code: 'not-found', path: filename });
  const bytes = await assets.read(filename, { signal });
  // The native bitmap decoder does not rasterize XML/SVG in this path.
  if (/^\s*</u.test(bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/u, ''))) return null;
  let metadata;
  try { metadata = await sharp(bytes).metadata(); } catch { /* The bitmap decoder also supports formats outside libvips. */ }
  if (metadata?.format === 'svg') return null;
  const extension = imagePathApi(filename).extname(filename).toLowerCase();
  if (['.png', '.gif', '.webp'].includes(extension)
    && (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii')) || (metadata?.pages ?? 1) > 1 || metadata?.loop != null)) {
    throw new Error('Cannot decode images with multiple frames');
  }
  signal?.throwIfAborted();
  let image;
  try { image = await loadImage(bytes); } catch { return null; }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

export async function nextSplashscreenImage(paths, index, options) {
  for (let tested = 0; tested < paths.length; tested++) {
    if (index >= paths.length) index = 0;
    const image = await decodeImage(paths[index++], options);
    if (image) return { image, index };
  }
  return { image: null, index };
}

export async function composeSplashscreenWall(posters, backdrops, { assets, signal, logger = {}, random = Math.random }) {
  const wall = createCanvas(wallWidth, wallHeight), context = wall.getContext('2d');
  context.fillStyle = '#000000'; context.fillRect(0, 0, wallWidth, wallHeight);
  let posterIndex = 0, backdropIndex = 0;
  try {
    for (let row = 0; row < rows; row++) {
      let counter = Math.floor(random() * 5), x = row * 75;
      while (x < wallWidth) {
        signal?.throwIfAborted();
        const poster = counter === 0 || counter === 2 || counter === 3;
        const next = await nextSplashscreenImage(poster ? posters : backdrops, poster ? posterIndex : backdropIndex, { assets, signal });
        if (poster) posterIndex = next.index; else backdropIndex = next.index;
        if (!next.image) throw new Error('Not enough valid pictures provided to create a splashscreen!');
        const imageWidth = Math.abs(Math.trunc(tileHeight * next.image.width / next.image.height));
        if (!imageWidth) throw new TypeError('Cannot draw an image with no width.');
        let resized;
        if (next.image.width > imageWidth || next.image.height > tileHeight) {
          resized = premultipliedSurface(resizeLinearMipmaps(next.image.data(), next.image.width, next.image.height, imageWidth, tileHeight), imageWidth, tileHeight);
        } else {
          resized = createCanvas(imageWidth, tileHeight); const scaled = resized.getContext('2d');
          scaled.imageSmoothingQuality = 'high'; scaled.drawImage(next.image, 0, 0, imageWidth, tileHeight);
        }
        context.drawImage(resized, x, row * (tileHeight + spacing));
        x += imageWidth + spacing; counter = counter >= 4 ? 0 : counter + 1;
      }
    }
  } catch (error) {
    logger.error?.(error, 'Detected intermediary error creating splashscreen image');
    throw error;
  }
  return wall.data();
}

export class SplashscreenImageGenerator {
  #lifetime = new AbortController();
  #pending = new Set();
  #tail = Promise.resolve();
  #closing;
  constructor({ dataPath, assets, logger = {}, random = Math.random }) {
    if (!dataPath || !path.isAbsolute(dataPath) || typeof assets?.read !== 'function' || typeof assets?.stat !== 'function') {
      throw new TypeError('Splashscreen generation requires an absolute instance data path and image assets.');
    }
    Object.assign(this, { dataPath, assets, logger, random });
  }

  async createSplashscreen(posters, backdrops) {
    this.#lifetime.signal.throwIfAborted();
    if (!Array.isArray(posters) || !Array.isArray(backdrops)) throw new TypeError('Splashscreen inputs must be image path lists.');
    if (!posters.length || !backdrops.length) return;
    const task = this.#tail.catch(() => {}).then(() => {
      this.#lifetime.signal.throwIfAborted();
      return this.#generate(posters, backdrops);
    });
    this.#tail = task; this.#pending.add(task);
    try { await task; } finally { this.#pending.delete(task); }
  }

  async #generate(posters, backdrops) {
    const wall = await composeSplashscreenWall(posters, backdrops, { ...this, signal: this.#lifetime.signal });
    const transformed = transformSplashscreen(wall);
    const output = await sharp(transformed, { raw: { width, height, channels: 4 } }).png({ adaptiveFiltering: true }).toBuffer();
    try { await this.assets.fileSystem.writeFile(path.join(this.dataPath, 'splashscreen.png'), output, { signal: this.#lifetime.signal }); }
    catch (error) {
      // SKFileWStream reports failed output writes as false; the builder ignores it.
      if (this.#lifetime.signal.aborted || !/^E[A-Z0-9]+$/u.test(error?.code ?? '')) throw error;
    }
  }

  close() {
    return this.#closing ??= (async () => {
      this.#lifetime.abort(); await Promise.allSettled(this.#pending);
    })();
  }
}
