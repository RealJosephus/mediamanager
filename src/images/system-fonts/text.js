// Shaping follows SkiaSharp.HarfBuzz 3.119.4 SKShaper (MIT): the actual
// selected font's OpenType tables, a 512-unit scale and guessed properties.
// Font selection and grapheme fallback belong to the collage caller.
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { loadCollageSystemFace, registerCollageSystemFace, measureCollageSystemGlyphs, drawCollageSystemGlyphs } from './index.js';

const shaping = new WeakMap(), canvasFaces = new WeakMap();
let harfbuzz;
async function shaper(face) {
  if (!shaping.has(face)) shaping.set(face, (async () => {
    // AAT is required for system emoji sequences and Arabic fonts on macOS.
    const hb = await (harfbuzz ??= import('./harfbuzz/index.mjs'));
    const loaded = await loadCollageSystemFace(face), blob = new hb.Blob(loaded.bytes), source = new hb.Face(blob, 0);
    // hbjs 1.6.3's hb_font_create installs OpenType functions by default.
    const font = new hb.Font(source), metrics = new hb.Font(source), buffer = new hb.Buffer();
    font.setScale(512, 512); metrics.setScale(source.upem, source.upem);
    // Native SKShaper does not propagate the OS drawing font's variations.
    // Keep one reusable buffer per selected face; calls below are synchronous.
    return { hb, blob, source, font, metrics, buffer, loaded };
  })());
  return shaping.get(face);
}
async function canvasFace(face) {
  if (!canvasFaces.has(face)) canvasFaces.set(face, (async () => {
    const registered = await registerCollageSystemFace(face);
    return { registered, context: createCanvas(1, 1).getContext('2d') };
  })());
  return canvasFaces.get(face);
}
const cssFont = (face, size, family) => `${face.slant === 1 ? 'italic ' : face.slant === 2 ? 'oblique ' : ''}${face.weight} ${size}px ${JSON.stringify(family)}`;

/** Raw scalar advances, including glyph zero; never apply Canvas fallback. */
export async function measureCollageText(face, text, size) {
  const loaded = await loadCollageSystemFace(face), scalars = [...text], glyphs = scalars.map(value => loaded.glyphForCodepoint(value.codePointAt(0)));
  if (process.platform === 'darwin') {
    const measured = await measureCollageSystemGlyphs(face, glyphs, size);
    return { width: measured.advances.reduce((sum, value) => sum + value.x, 0), xHeight: measured.xHeight, glyphs,
      advances: measured.advances.map(value => value.x), font: cssFont(face, size, face.family) };
  }
  const hinted = process.platform === 'linux';
  const metrics = glyphs.includes(0) || !hinted ? await shaper(face) : null;
  const { registered, context } = await canvasFace(face), font = cssFont(face, size, registered.canvasFamily);
  context.font = font;
  const xHeight = context.measureText('x').actualBoundingBoxAscent;
  const ppem = hinted ? Math.max(1, Math.round(size)) : size;
  if (hinted) context.font = cssFont(face, ppem, registered.canvasFamily);
  const advances = glyphs.map((glyph, index) => {
    // DirectWrite's default metrics are design advances. FreeType uses an
    // integer ppem and hinted advances; an absent scalar must stay glyph zero.
    const raw = !hinted || glyph === 0 ? metrics.metrics.glyphHAdvance(glyph) * ppem / metrics.source.upem
      : context.measureText(scalars[index]).width;
    return hinted ? Math.round(raw) * (size < 1 ? size : 1) : raw;
  });
  return { width: advances.reduce((sum, value) => sum + value, 0), xHeight, glyphs, advances, font };
}

/** Return actual glyph IDs and positioned origins; do not add a bidi pass. */
export async function shapeCollageText(face, text, size, x = 0, y = 0, direction = 'ltr') {
  const { hb, font, buffer } = await shaper(face);
  const clusters = new Map(); let utf16 = 0, utf8 = 0;
  for (const scalar of text) { clusters.set(utf16, utf8); utf16 += scalar.length; utf8 += Buffer.byteLength(scalar); }
  clusters.set(utf16, utf8);
  try {
    buffer.addText(text); buffer.guessSegmentProperties(); hb.shape(font, buffer);
    const infos = buffer.getGlyphInfos(), offsets = buffer.getGlyphPositions(), scalar = Math.fround;
    const scale = scalar(scalar(size) / 512), startX = scalar(x);
    let cursorX = startX, cursorY = scalar(y);
    const positions = offsets.map(value => {
      const point = { x: scalar(cursorX + scalar(value.xOffset * scale)), y: scalar(cursorY - scalar(value.yOffset * scale)) };
      cursorX = scalar(cursorX + scalar(value.xAdvance * scale)); cursorY = scalar(cursorY + scalar(value.yAdvance * scale));
      return point;
    });
    const width = scalar(cursorX - startX);
    return { glyphs: infos.map(value => value.codepoint), clusters: infos.map(value => clusters.get(value.cluster)),
      positions: positions.map(point => ({ x: direction === 'rtl' ? scalar(point.x - width) : point.x, y: point.y })), width };
  } finally { buffer.reset(); }
}

/** Draw one already selected run. Mac uses its public system glyph backend. */
export async function drawCollageText(context, face, text, size, x, y, direction, shaped) {
  if (process.platform === 'darwin') {
    const drawing = await drawCollageSystemGlyphs(face, { glyphs: shaped.glyphs, positions: shaped.positions,
      size, width: context.canvas.width, height: context.canvas.height });
    const pixels = new Uint8ClampedArray(drawing.pixels);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3];
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = alpha ? Math.round(pixels[offset + channel] * 255 / alpha) : 0;
    }
    const layer = createCanvas(drawing.width, drawing.height);
    layer.getContext('2d').putImageData(new ImageData(pixels, drawing.width, drawing.height), 0, 0);
    context.drawImage(layer, 0, 0);
    return { backend: 'coretext-glyphs', identity: drawing.identity };
  }
  const { registered } = await canvasFace(face);
  context.font = cssFont(face, size, registered.canvasFamily);
  context.direction = direction; context.textAlign = direction === 'rtl' ? 'right' : 'left';
  context.textBaseline = 'alphabetic'; context.fillStyle = '#ffffff';
  context.fillText(text, x, y);
  return { backend: 'canvas-text', font: context.font };
}
