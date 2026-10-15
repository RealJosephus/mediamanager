import { createCanvas, ImageData } from '@napi-rs/canvas';
import { roundEven } from './options.js';

function surface(data, width, height) {
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
}
function premultipliedSurface(pixels, width, height) {
  for (let offset = 0; offset < pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = pixels[offset + 3] ? Math.min(255, Math.round(pixels[offset + channel] * 255 / pixels[offset + 3])) : 0;
  return surface(pixels, width, height);
}
function downsampleMipmap(source) {
  const width = Math.max(1, source.width >> 1), height = Math.max(1, source.height >> 1);
  const horizontal = source.width === 1 ? [1] : source.width & 1 ? [1, 2, 1] : [1, 1];
  const vertical = source.height === 1 ? [1] : source.height & 1 ? [1, 2, 1] : [1, 1];
  const shift = Math.log2(horizontal.reduce((sum, value) => sum + value, 0) * vertical.reduce((sum, value) => sum + value, 0));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) {
    let sum = 0;
    for (let row = 0; row < vertical.length; row++) for (let column = 0; column < horizontal.length; column++) {
      sum += source.pixels[((y * 2 + row) * source.width + x * 2 + column) * 4 + channel] * vertical[row] * horizontal[column];
    }
    pixels[(y * width + x) * 4 + channel] = sum >> shift;
  }
  return { pixels, width, height };
}
function sampleBilinear(level, x, y, channel) {
  const f = Math.fround, sourceX = f(x - 0.5), sourceY = f(y - 0.5);
  const left = Math.floor(sourceX), top = Math.floor(sourceY), fractionX = f(sourceX - left), fractionY = f(sourceY - top);
  const sample = (sampleX, sampleY) => level.pixels[(Math.max(0, Math.min(level.height - 1, sampleY)) * level.width + Math.max(0, Math.min(level.width - 1, sampleX))) * 4 + channel];
  const upper = f(f(f(sample(left, top) / 255) * f(1 - fractionX)) + f(f(sample(left + 1, top) / 255) * fractionX));
  const lower = f(f(f(sample(left, top + 1) / 255) * f(1 - fractionX)) + f(f(sample(left + 1, top + 1) / 255) * fractionX));
  return f(f(upper * f(1 - fractionY)) + f(lower * fractionY));
}
export function resizeLinearMipmaps(pixels, width, height, targetWidth, targetHeight) {
  // This follows Skia m119's CPU Linear/Linear sampling: integer mip generation,
  // bilinear sampling inside each selected level, then a fractional level blend.
  const f = Math.fround, scale = Math.min(f(targetWidth / width), f(targetHeight / height));
  const level = f(Math.max(f(-f(Math.log2(scale)) - f(0.5)), 0)), upperIndex = Math.floor(level), lowerWeight = f(level - upperIndex);
  const levels = [{ pixels, width, height }];
  while (levels.length <= upperIndex + (lowerWeight > 0 ? 1 : 0)) levels.push(downsampleMipmap(levels.at(-1)));
  const upper = levels[Math.min(upperIndex, levels.length - 1)], lower = levels[Math.min(upperIndex + 1, levels.length - 1)];
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const baseScaleX = f(width / targetWidth), baseScaleY = f(height / targetHeight);
  const upperScaleX = f(upper.width / width), upperScaleY = f(upper.height / height);
  const lowerScaleX = f(lower.width / width), lowerScaleY = f(lower.height / height);
  for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    const baseX = f(f(x + 0.5) * baseScaleX), baseY = f(f(y + 0.5) * baseScaleY);
    const upperX = f(baseX * upperScaleX), upperY = f(baseY * upperScaleY);
    const lowerX = f(baseX * lowerScaleX), lowerY = f(baseY * lowerScaleY);
    for (let channel = 0; channel < 4; channel++) {
      const first = sampleBilinear(upper, upperX, upperY, channel);
      const second = lowerWeight > 0 ? sampleBilinear(lower, lowerX, lowerY, channel) : first;
      const value = f(first + f(f(second - first) * lowerWeight));
      output[(y * targetWidth + x) * 4 + channel] = Math.min(255, Math.trunc(f(f(value * 255) + 0.5)));
    }
  }
  return output;
}
export function sharpenPixels(source, width, height) {
  const target = Buffer.alloc(source.length), f = Math.fround;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) {
    const offset = (y * width + x) * 4 + channel;
    const sum = source[(Math.max(0, y - 1) * width + x) * 4 + channel] + source[(Math.min(height - 1, y + 1) * width + x) * 4 + channel]
      + source[(y * width + Math.max(0, x - 1)) * 4 + channel] + source[(y * width + Math.min(width - 1, x + 1)) * 4 + channel];
    const value = f(f(f(1.4) * source[offset]) + f(f(-0.1) * sum));
    target[offset] = Math.max(0, Math.min(255, Math.trunc(f(value + 0.5))));
  }
  return target;
}
function sharpen(canvas) {
  const { width, height } = canvas;
  // Canvas exposes premultiplied pixels, while ImageData accepts unpremultiplied pixels.
  return premultipliedSurface(sharpenPixels(canvas.data(), width, height), width, height);
}
function skiaColor(value) {
  // SKColor.Parse treats eight hex digits as AARRGGBB, unlike CSS RRGGBBAA.
  if (/^#[0-9a-f]{8}$/i.test(value)) return `#${value.slice(3)}${value.slice(1, 3)}`;
  return value;
}
export function blendBlackForeground(pixels, alpha) {
  // SKCanvas.DrawColor on the native BGRA premultiplied target uses SkAlpha255To256.
  const scale = 256 - alpha - (alpha >> 7);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = (pixels[offset + channel] * scale + 128) >> 8;
    pixels[offset + 3] = Math.min(255, alpha + ((pixels[offset + 3] * scale + 128) >> 8));
  }
  return pixels;
}
function foreground(canvas, alpha) {
  return premultipliedSurface(blendBlackForeground(canvas.data(), alpha), canvas.width, canvas.height);
}
export function blendBitmap(destination, source) {
  // Native DrawBitmap's premultiplied SrcOver blitter truncates the destination product.
  for (let offset = 0; offset < source.length; offset += 4) {
    const scale = 256 - source[offset + 3];
    for (let channel = 0; channel < 4; channel++) destination[offset + channel] = Math.min(255, source[offset + channel] + ((destination[offset + channel] * scale) >> 8));
  }
  return destination;
}
export function renderPixels(decoded, target, options) {
  let source = surface(decoded.data, decoded.info.width, decoded.info.height);
  if (source.width !== target.Width || source.height !== target.Height) {
    const downscale = source.width > target.Width || source.height > target.Height;
    if (downscale) {
      source = sharpen(premultipliedSurface(resizeLinearMipmaps(source.data(), source.width, source.height, target.Width, target.Height), target.Width, target.Height));
    } else {
      const resized = createCanvas(target.Width, target.Height), context = resized.getContext('2d');
      context.imageSmoothingQuality = 'high'; context.drawImage(source, 0, 0, resized.width, resized.height); source = resized;
    }
  }
  const hasBackground = Boolean(options.BackgroundColor?.trim()), hasForeground = Boolean(options.ForegroundLayer?.trim());
  const hasIndicator = options.UnplayedCount != null || (options.PercentPlayed ?? 0) !== 0;
  if (!hasBackground && !hasForeground && !(options.Blur > 0) && !hasIndicator) return source;
  let result = createCanvas(source.width, source.height), context = result.getContext('2d');
  if (hasBackground) { context.fillStyle = skiaColor(options.BackgroundColor); context.fillRect(0, 0, result.width, result.height); }
  if (hasBackground && !(options.Blur > 0)) {
    result = premultipliedSurface(blendBitmap(result.data(), source.data()), source.width, source.height); context = result.getContext('2d');
  } else {
    if (options.Blur > 0) context.filter = `blur(${options.Blur}px)`;
    context.drawImage(source, 0, 0); context.filter = 'none';
  }
  if (hasForeground) {
    const parsed = Number(options.ForegroundLayer), opacity = Number.isFinite(parsed) || /^\s*[+-]?nan\s*$/i.test(options.ForegroundLayer) ? parsed : 0.4;
    const alpha = Math.trunc((1 - opacity) * 255) & 255;
    result = foreground(result, alpha); context = result.getContext('2d');
  }
  if (options.UnplayedCount != null) {
    let x = result.width - 38, y = 47; const text = String(options.UnplayedCount);
    context.fillStyle = 'rgba(0,164,220,0.8)'; context.beginPath(); context.arc(x, 38, 20, 0, 2 * Math.PI); context.fill();
    if (text.length === 1) x -= 7;
    if (text.length === 2) x -= 13; else if (text.length >= 3) { x -= 15; y -= 2; }
    context.fillStyle = '#ffffff'; context.font = `${text.length >= 3 ? 18 : 24}px sans-serif`; context.fillText(text, x, y);
  }
  if (options.PercentPlayed > 0) {
    const endX = result.width - 1, endY = result.height - 1;
    context.fillStyle = 'rgba(0,0,0,0.6)'; context.fillRect(0, endY - 8, endX, endY);
    context.fillStyle = '#00a4dc'; context.fillRect(0, endY - 8, roundEven(endX * options.PercentPlayed / 100), endY);
  }
  return result;
}
export function stripCanvasColorProfile(bytes, format) {
  // Canvas adds an sRGB profile; the native bitmap encoder receives a null color space on this path.
  if (format === 'Png' || format === 'Svg') {
    const chunks = [bytes.subarray(0, 8)];
    for (let offset = 8; offset < bytes.length;) { const length = bytes.readUInt32BE(offset) + 12; if (bytes.toString('ascii', offset + 4, offset + 8) !== 'sRGB') chunks.push(bytes.subarray(offset, offset + length)); offset += length; }
    return Buffer.concat(chunks);
  }
  if (format === 'Jpg') {
    const chunks = [bytes.subarray(0, 2)];
    for (let offset = 2; offset < bytes.length;) { const marker = bytes[offset + 1]; if (marker === 0xda || marker === 0xd9) { chunks.push(bytes.subarray(offset)); break; } const length = bytes.readUInt16BE(offset + 2) + 2; if (marker !== 0xe2 || bytes.toString('ascii', offset + 4, offset + 15) !== 'ICC_PROFILE') chunks.push(bytes.subarray(offset, offset + length)); offset += length; }
    return Buffer.concat(chunks);
  }
  if (format === 'Webp') {
    const chunks = [];
    for (let offset = 12; offset < bytes.length;) { const length = bytes.readUInt32LE(offset + 4), total = 8 + length + (length & 1), chunk = Buffer.from(bytes.subarray(offset, offset + total)); if (chunk.toString('ascii', 0, 4) === 'VP8X') chunk[8] &= ~0x20; if (chunk.toString('ascii', 0, 4) !== 'ICCP') chunks.push(chunk); offset += total; }
    // The simple WebP form supports one VP8 image, or VP8L with optional alpha.
    // Preserve the extended header whenever reconstruction or other metadata still needs it.
    if (chunks.length === 2 && chunks[0].toString('ascii', 0, 4) === 'VP8X') {
      const type = chunks[1].toString('ascii', 0, 4), flags = chunks[0][8];
      if (type === 'VP8L' && !(flags & ~0x10) || type === 'VP8 ' && flags === 0) chunks.shift();
    }
    const data = Buffer.concat(chunks), header = Buffer.from('RIFF0000WEBP'); header.writeUInt32LE(data.length + 4, 4); return Buffer.concat([header, data]);
  }
  return bytes;
}
