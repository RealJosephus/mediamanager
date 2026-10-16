// Thumb collage layout follows Jellyfin.Drawing.Skia/StripCollageBuilder.cs (GPL-2.0-or-later).
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { nextSplashscreenImage } from './splashscreen.js';
import { blendBlackForeground, renderPixels, stripCanvasColorProfile } from './renderer.js';
import { clrTrim } from '../metadata/whitespace.js';

const width = 960, height = 540;
const rtl = /[\u0600-\u06ff\u0530-\u058f\u0590-\u05ff\u0700-\u074f\u0780-\u07bf]/u;

function unshapedWidth(context, text) {
  // SKFont.MeasureText maps Unicode scalars to glyph advances without shaping.
  // Measuring the whole string in Canvas instead includes kerning, ligatures
  // and Arabic joining, changing both the overflow branch and its anchor.
  // FreeType's default hinted metrics use integral advances on Linux.
  let measured = 0;
  for (const scalar of text) {
    const advance = context.measureText(scalar).width;
    measured += process.platform === 'linux' ? Math.round(advance) : advance;
  }
  return measured;
}

export function drawUserViewTitle(context, name) {
  if (name == null || !clrTrim(name)) return null;
  // NAPI's registered-font collection does not share the operating system's
  // generic-family aliases used by Skia's native font manager.
  const family = process.platform === 'win32' ? '"Segoe UI"' : process.platform === 'darwin' ? '"Helvetica"' : 'sans-serif';
  const direction = rtl.test(name) ? 'rtl' : 'ltr';
  context.direction = direction; context.textBaseline = 'alphabetic';
  let size = 112;
  context.font = `bold ${size}px ${family}`;
  const initialWidth = unshapedWidth(context, name);
  if (initialWidth > width * 0.95) {
    size = 0.9 * width * size / initialWidth;
    context.font = `bold ${size}px ${family}`;
  }
  const firstSize = size;
  let measured = unshapedWidth(context, name);
  const beforeFallbackResize = measured;
  if (measured > width * 0.95) {
    size = 0.9 * width * size / measured;
    context.font = `bold ${size}px ${family}`;
    measured = unshapedWidth(context, name);
  }
  // X height belongs to the selected face; it is not always half an em.
  const xHeight = context.measureText('x').actualBoundingBoxAscent;
  const padding = (width - measured) / 2;
  const x = direction === 'rtl' ? width - padding : padding, y = height / 2 + xHeight / 2;
  context.fillStyle = '#ffffff';
  // Native DrawShapedText aligns the shaped run at the unshaped-width anchor.
  context.textAlign = direction === 'rtl' ? 'right' : 'left'; context.fillText(name, x, y);
  return { font: context.font, direction, initialWidth, firstSize, beforeFallbackResize, size, measured, xHeight, padding, x, y };
}

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
  drawUserViewTitle(context, name);
  return stripCanvasColorProfile(await canvas.encode('png'), 'Png');
}
