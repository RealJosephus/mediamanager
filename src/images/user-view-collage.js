// Thumb collage layout follows Jellyfin.Drawing.Skia/StripCollageBuilder.cs (GPL-2.0-or-later).
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { nextSplashscreenImage } from './splashscreen.js';
import { blendBlackForeground, renderPixels, stripCanvasColorProfile } from './renderer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { collageTextRuns } from './collage-fonts.js';
import { resolveCollageSystemFonts, loadCollageSystemFace } from './system-fonts/index.js';
import { measureCollageText, shapeCollageText, drawCollageText } from './system-fonts/text.js';

const width = 960, height = 540;
const rtl = /[\u0600-\u06ff\u0530-\u058f\u0590-\u05ff\u0700-\u074f\u0780-\u07bf]/u;
let fonts;
function titleFonts() {
  return fonts ??= (async () => {
    const selected = await resolveCollageSystemFonts(), loaded = new Map();
    const load = async descriptor => {
      if (!descriptor) return null;
      if (!loaded.has(descriptor)) loaded.set(descriptor, loadCollageSystemFace(descriptor).then(face => ({ ...face, descriptor })));
      return loaded.get(descriptor);
    };
    const defaultFace = await load(selected.defaultFace);
    if (!defaultFace) throw new Error('The system has no default collage font.');
    return { defaultFace, fallbackFaces: await Promise.all(selected.fallbackFaces.map(load)) };
  })();
}

export async function drawUserViewTitle(context, name) {
  if (name == null || !clrTrim(name)) return null;
  const { defaultFace, fallbackFaces } = await titleFonts();
  const runs = collageTextRuns(name, defaultFace, fallbackFaces);
  const direction = rtl.test(name) ? 'rtl' : 'ltr';
  let size = 112;
  const initialWidth = (await measureCollageText(defaultFace.descriptor, name, size)).width;
  if (initialWidth > width * 0.95) {
    size = 0.9 * width * size / initialWidth;
  }
  const firstSize = size;
  const measure = async () => {
    let total = 0;
    for (const run of runs) total += (await measureCollageText(run.face.descriptor, run.text, size)).width;
    return total;
  };
  let measured = await measure();
  const beforeFallbackResize = measured;
  if (measured > width * 0.95) {
    size = 0.9 * width * size / measured;
    measured = await measure();
  }
  // X height belongs to the selected face; it is not always half an em.
  const defaultMetrics = await measureCollageText(defaultFace.descriptor, 'x', size), xHeight = defaultMetrics.xHeight;
  const padding = (width - measured) / 2;
  const x = direction === 'rtl' ? width - padding : padding, y = height / 2 + xHeight / 2;
  let advance = 0;
  const drawing = [];
  for (const run of runs) {
    const face = run.face.descriptor, origin = direction === 'rtl' ? x - advance : x + advance;
    const metrics = await measureCollageText(face, run.text, size);
    const shaped = await shapeCollageText(face, run.text, size, origin, y, direction);
    const output = await drawCollageText(context, face, run.text, size, origin, y, direction, shaped);
    drawing.push({ text: run.text, face, x: origin, y, size, measured: metrics.width, nominalGlyphs: metrics.glyphs,
      nominalAdvances: metrics.advances, shaped, ...output });
    advance += metrics.width;
  }
  return { font: defaultMetrics.font, direction, initialWidth, firstSize, beforeFallbackResize, size, measured, xHeight, padding, x, y, runs: drawing };
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
  await drawUserViewTitle(context, name);
  return stripCanvasColorProfile(await canvas.encode('png'), 'Png');
}
