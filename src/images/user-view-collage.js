// Thumb collage layout follows Jellyfin.Drawing.Skia/StripCollageBuilder.cs (GPL-2.0-or-later).
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { nextSplashscreenImage } from './splashscreen.js';
import { blendBlackForeground, renderPixels, stripCanvasColorProfile } from './renderer.js';
import { clrTrim } from '../metadata/whitespace.js';

const width = 960, height = 540;
const rtl = /[\u0600-\u06ff\u0530-\u058f\u0590-\u05ff\u0700-\u074f\u0780-\u07bf]/u;

/** Compose a library thumbnail from existing static image assets. */
export async function composeUserViewCollage(paths, name, { assets }) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#000000'; context.fillRect(0, 0, width, height);
  // Native collage creation does not observe the provider cancellation token;
  // SaveImage observes it after creation, retaining its file-write prefix.
  let image;
  for await (const filename of paths) {
    image = (await nextSplashscreenImage([filename], 0, { assets })).image;
    if (image) break;
  }
  if (!image) return stripCanvasColorProfile(await canvas.encode('png'), 'Png');
  const backdropHeight = Math.abs(Math.trunc(width * image.height / image.width));
  const pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  const backdrop = renderPixels({ data: pixels, info: { width: image.width, height: image.height } },
    { Width: width, Height: backdropHeight }, {});
  context.drawImage(backdrop, 0, 0);
  context.putImageData(new ImageData(new Uint8ClampedArray(blendBlackForeground(canvas.data(), 0x78)), width, height), 0, 0);
  if (name != null && clrTrim(name)) {
    // The Windows Skia font manager resolves its generic sans-serif family to
    // Segoe UI. Other platforms use their own generic font manager fallback.
    const family = process.platform === 'win32' ? '"Segoe UI"' : 'sans-serif';
    let size = 112;
    context.font = `bold ${size}px ${family}`;
    let measured = context.measureText(name).width;
    if (measured > width * 0.95) {
      size = Math.fround(0.9 * width * size / measured);
      context.font = `bold ${size}px ${family}`; measured = context.measureText(name).width;
    }
    context.fillStyle = '#ffffff'; context.textBaseline = 'alphabetic';
    context.direction = rtl.test(name) ? 'rtl' : 'ltr';
    context.textAlign = 'center';
    context.fillText(name, width / 2, height / 2 + size / 4);
  }
  return stripCanvasColorProfile(await canvas.encode('png'), 'Png');
}
