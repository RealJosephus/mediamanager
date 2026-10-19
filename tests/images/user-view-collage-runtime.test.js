import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas, GlobalFonts, ImageData, loadImage } from '@napi-rs/canvas';
import { composeUserViewCollage, drawUserViewTitle } from '../../src/images/user-view-collage.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const width = 960, height = 540;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputFile = new URL('./fixtures/user-view-collage-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes.toString('utf8'));
// These same-face titles have independently observed raster-edge differences.
// Other platforms, text and fallback runs retain the glyph-boundary comparison.
const singleFaceTitles = {
  linux: { 'text-18': ['עברית', 'DejaVu Sans'] },
  darwin: { 'text-12': ['AVATAR', 'Helvetica'] },
  win32: { 'text-12': ['AVATAR', 'Segoe UI'], 'text-13': ['A very long library name for movies and documentaries', 'Segoe UI'],
    'text-17': ['العربية', 'Segoe UI'], 'text-18': ['עברית', 'Segoe UI'], 'text-19': ['Հայերեն', 'Segoe UI'] }
};
async function decoded(bytes) {
  const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return { width: image.width, height: image.height, pixels: canvas.data() };
}
function pixelDifference(actual, expected) {
  let channels = 0, maximum = 0, alphaChannels = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(actual[i] - expected[i]);
    if (difference) { channels++; if (i % 4 === 3) alphaChannels++; }
    maximum = Math.max(maximum, difference);
  }
  return { channels, maximum, alphaChannels };
}
function glyphMask(pixels, background) {
  const mask = new Uint8Array(width * height);
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let i = 0; i < mask.length; i++) {
    const offset = i * 4;
    // Compare each title to its own unlabelled backdrop. White lettering has
    // half coverage when halfway between its backdrop and white. Coloured
    // glyphs also contribute when they replace half the available contrast.
    let contrast = 0;
    for (let channel = 0; channel < 3; channel++) {
      const base = background[offset + channel], value = pixels[offset + channel];
      contrast = Math.max(contrast, Math.abs(value - base) / (value >= base ? 255 - base : Math.max(1, base)));
    }
    if (contrast < 0.5) continue;
    const x = i % width, y = Math.floor(i / width); mask[i] = 1; count++;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { mask, bounds: count ? { left, top, right, bottom } : null, count };
}
function unmatchedInk(source, target) {
  let unmatched = 0;
  for (let i = 0; i < source.length; i++) {
    if (!source[i] || target[i]) continue;
    const x = i % width, y = Math.floor(i / width);
    let neighbour = false;
    for (let dy = -1; dy <= 1 && !neighbour; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && target[(y + dy) * width + x + dx]) { neighbour = true; break; }
    }
    if (!neighbour) unmatched++;
  }
  return unmatched;
}
function fontMeasurements(text, font, direction) {
  const context = createCanvas(1, 1).getContext('2d');
  context.font = font; context.direction = direction;
  const shaped = context.measureText(text);
  context.fontKerning = 'none';
  const withoutKerning = context.measureText(text);
  const scalars = [...text].map(text => ({ text, codepoint: text.codePointAt(0), advance: context.measureText(text).width }));
  return { font: context.font, shapedWidth: shaped.width, withoutKerningWidth: withoutKerning.width,
    scalarAdvanceSum: scalars.reduce((sum, scalar) => sum + scalar.advance, 0),
    roundedScalarAdvanceSum: scalars.reduce((sum, scalar) => sum + Math.round(scalar.advance), 0),
    xHeight: context.measureText('x').actualBoundingBoxAscent, scalars };
}
function titleContext(background) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.putImageData(new ImageData(new Uint8ClampedArray(background), width, height), 0, 0);
  return context;
}
function observeTitle(context, text) {
  const draws = [], fillText = context.fillText;
  context.fillText = function (...args) {
    draws.push({ args, font: this.font, direction: this.direction, textAlign: this.textAlign,
      textBaseline: this.textBaseline, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
    return fillText.apply(this, args);
  };
  try { return { layout: drawUserViewTitle(context, text), draws }; }
  finally { context.fillText = fillText; }
}
function assertSingleFaceTitle({ specification, row, native, layout, draws, context, background, pixelHash }) {
  const [text, family] = specification, nativeLayout = row.layout;
  assert.equal(row.sample.Text, text, 'The observed raster case must retain its reviewed title.');
  assert.equal(native.defaultFont.FamilyName, family);
  assert.equal(native.defaultFont.FontWeight, 700);
  assert.equal(native.defaultFont.FontWidth, 5); assert.equal(native.defaultFont.FontSlant, 0);
  assert.ok(GlobalFonts.families.find(face => face.family === family)?.styles.some(style => style.weight === 700 && style.width === 'normal' && style.style === 'normal'),
    'The native default bold face must be registered in Canvas.');
  assert.match(native.defaultFont.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(native.fallbackFonts.at(-1), native.defaultFont, 'The measured last face must be the actual native default.');
  const nativeFont = nativeLayout.fontMeasurements.at(-1).at(-1);
  assert.equal(nativeFont.FamilyName, family); assert.equal(nativeFont.FontWeight, 700);
  assert.equal(nativeFont.size, nativeLayout.size); assert.equal(nativeFont.containsAll, true);
  assert.equal(nativeFont.scalars.map(scalar => scalar.text).join(''), text);
  assert.ok(nativeFont.scalars.every(scalar => scalar.glyph > 0), 'Every character must use a present default-face glyph.');
  assert.equal(draws.length, 1, 'The complete default-face title must be drawn once.');
  const draw = draws[0];
  assert.deepEqual(draw.args, [text, layout.x, layout.y], 'Drawing must retain all text and use the measured anchor without maxWidth scaling.');
  assert.equal(draw.font, layout.font); assert.match(draw.font, /^bold [\d.]+px /);
  assert.equal(draw.direction, nativeLayout.direction);
  assert.equal(draw.textAlign, nativeLayout.direction === 'rtl' ? 'right' : 'left');
  assert.equal(draw.textBaseline, 'alphabetic'); assert.equal(draw.fillStyle, '#ffffff'); assert.equal(draw.globalAlpha, 1);
  // Compare layout in raster units, not floating-point representation. The
  // observed Canvas scalar metrics round to hundredths; this does not permit
  // a different overflow decision, font size, whole-pixel advance or anchor.
  for (const key of ['firstSize', 'size']) assert.equal(Math.round(layout[key] * 1000), Math.round(nativeLayout[key] * 1000), `Title ${key} differs.`);
  for (const key of ['initialWidth', 'beforeFallbackResize', 'measured']) assert.equal(Math.round(layout[key]), Math.round(nativeLayout[key]), `Title ${key} differs.`);
  const raw = fontMeasurements(text, draw.font, draw.direction);
  const advance = process.platform === 'linux' ? raw.roundedScalarAdvanceSum : raw.scalarAdvanceSum;
  assert.equal(Math.round(advance), Math.round(nativeFont.rawWidth), 'The actually drawn font must retain the native raw advance.');
  const nativeX = nativeLayout.direction === 'rtl' ? width - nativeLayout.padding : nativeLayout.padding;
  assert.equal(Math.round(draw.args[1]), Math.round(nativeX));
  assert.ok(Math.abs(draw.args[2] - nativeLayout.y) <= 0.5, 'The observed baseline may differ by at most half a raster row.');
  assert.equal(hash(context.canvas.data()), pixelHash, 'The captured complete title drawing must reproduce the composed image.');
  // An explicit face replay also proves which face Canvas actually used for a
  // generic family. Font strings or returned metrics alone do not prove this.
  const explicit = titleContext(background);
  for (const key of ['direction', 'textAlign', 'textBaseline', 'fillStyle', 'globalAlpha']) explicit[key] = draw[key];
  explicit.font = `700 ${layout.size}px ${JSON.stringify(family)}`;
  explicit.fillText(...draw.args);
  assert.equal(hash(explicit.canvas.data()), pixelHash, 'The actual title must use the native default family and bold face.');
}

test('UserView thumbnails match the same-platform native selection, crop and title layout', async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'Live collage comparison requires the isolated native reference build.');
  await access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const output = path.join(validationOutputRoot(), 'user-view-collage-runtime'); await mkdir(output);
  const nativeRoot = path.join(output, 'native'), candidateRoot = path.join(output, 'candidate'); await mkdir(candidateRoot);
  const recording = await recordOracle({ project: 'tests/images/fixtures/user-view-collage-runtime/Oracle.csproj',
    output: nativeRoot, args: [fileURLToPath(inputFile), '{output}'] });
  const nativeBytes = await readFile(path.join(nativeRoot, 'native.json')), native = JSON.parse(nativeBytes);
  assert.equal(native.actualSkiaEncoder, true); assert.equal(native.actualStripCollageBuilder, true);
  assert.equal(native.actualDrawTextMeasurements, true); assert.equal(native.results.length, 29);
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.deepEqual(native.results.map(row => row.sample), input, 'The native and candidate sides consume the declared scenario input.');
  assert.equal(recording.passed, true); assert.equal(recording.process.status, 0);
  for (const input of native.inputs) {
    const bytes = await readFile(path.join(nativeRoot, input.path));
    assert.equal(bytes.length, input.bytes); assert.equal(hash(bytes), input.sha256);
  }
  const assets = new MetadataImageAssets({ fileSystem: testFileSystem, stateRoots: [nativeRoot] });
  const nativeBackground = (await decoded(await readFile(path.join(nativeRoot, 'same.png')))).pixels;
  const candidateBackground = (await decoded(await composeUserViewCollage([path.join(nativeRoot, 'assets/same.png')], '', { assets }))).pixels;
  const exact = new Set(['same', 'large', 'wide', 'alpha', 'skip', 'empty', 'invalid', 'blank', 'null', 'first-valid']);
  const observations = [];
  for (const row of native.results) await t.test(row.sample.Name, async () => {
    const filenames = row.sample.Paths.map(name => path.join(nativeRoot, 'assets', name));
    const observation = { name: row.sample.Name, nativeLayout: row.layout }; observations.push(observation);
    let candidate, failure;
    try { candidate = await composeUserViewCollage(filenames, row.sample.Text, { assets }); } catch (error) { failure = error; }
    if (failure) observation.error = { name: failure.name, message: failure.message };
    if (row.error) {
      assert.ok(failure, 'The native decoding failure must prevent a generated image.');
      assert.equal(failure.message, row.error.Message); return;
    }
    assert.ifError(failure);
    await writeFile(path.join(candidateRoot, row.sample.Name + '.png'), candidate, { flag: 'wx' });
    const actual = await decoded(candidate), expected = await decoded(await readFile(path.join(nativeRoot, row.sample.Name + '.png')));
    observation.sha256 = hash(candidate); observation.pixelHash = hash(actual.pixels);
    observation.difference = pixelDifference(actual.pixels, expected.pixels);
    assert.deepEqual({ width: actual.width, height: actual.height }, { width: 960, height: 540 });
    assert.equal(hash(expected.pixels), row.output.pixelHash, 'Native image decoding must retain its recorded pixels.');
    if (exact.has(row.sample.Name)) assert.equal(observation.pixelHash, row.output.pixelHash);
    // No byte-tolerance assertion is inferred from the noisy upsample scenes.
    // These separate flat markers exercise scaling and top-left cropping away
    // from interpolation boundaries, where colour is an unambiguous contract.
    if (row.sample.Name.endsWith('-markers')) {
      for (const y of [50, 230, 500]) for (const x of [100, 480, 850]) {
        const offset = (y * width + x) * 4;
        assert.deepEqual(actual.pixels.subarray(offset, offset + 4), expected.pixels.subarray(offset, offset + 4), `Crop marker at ${x},${y}`);
      }
    }
    if (row.layout) {
      const specification = singleFaceTitles[process.platform]?.[row.sample.Name];
      const context = specification ? titleContext(candidateBackground) : createCanvas(width, height).getContext('2d');
      const { layout, draws } = observeTitle(context, row.sample.Text);
      observation.candidateLayout = layout;
      observation.candidateDraws = draws;
      // Diagnostic probes use the actual installed font collection. The native
      // measurements never feed the production renderer or replace its output.
      observation.fontMeasurements = {
        candidate: [112, layout.firstSize, layout.size].filter((size, index, sizes) => sizes.indexOf(size) === index)
          .map(size => fontMeasurements(row.sample.Text, layout.font.replace(/[\d.]+px/, `${size}px`), layout.direction)),
        nativeFaces: native.fallbackFonts.map(face => ({ family: face.FamilyName,
          registeredStyles: GlobalFonts.families.find(({ family }) => family === face.FamilyName)?.styles ?? [],
          ...fontMeasurements(row.sample.Text, `${face.FontWeight} ${row.layout.size}px ${JSON.stringify(face.FamilyName)}`, layout.direction) }))
      };
      const actualInk = glyphMask(actual.pixels, candidateBackground), expectedInk = glyphMask(expected.pixels, nativeBackground);
      observation.ink = { actual: { bounds: actualInk.bounds, count: actualInk.count }, expected: { bounds: expectedInk.bounds, count: expectedInk.count },
        extra: unmatchedInk(actualInk.mask, expectedInk.mask), missing: unmatchedInk(expectedInk.mask, actualInk.mask) };
      assert.equal(layout.direction, row.layout.direction);
      assert.ok(actualInk.count > 0 && expectedInk.count > 0, 'Both renderers must produce visible title glyphs.');
      assert.equal(layout.size < 112, row.layout.size < 112, 'The title must take the native overflow branch.');
      assert.ok(Math.abs(layout.y - row.layout.y) <= 1, 'The baseline must agree within one raster row.');
      if (specification) {
        assertSingleFaceTitle({ specification, row, native, layout, draws, context,
          background: candidateBackground, pixelHash: observation.pixelHash });
        observation.titleContract = 'complete-default-face-drawing';
        // RGB and glyph-mask differences remain recorded above. For these
        // proven same-face drawings they describe rasterization, not missing
        // text, fallback, sizing or placement.
        return;
      }
      // This is a title geometry comparison, not a general image tolerance.
      // Allow a single boundary pixel for coverage/rasterization, but require
      // every glyph's occupied region and placement in both directions.
      for (const edge of ['left', 'top', 'right', 'bottom']) {
        assert.ok(Math.abs(actualInk.bounds[edge] - expectedInk.bounds[edge]) <= 1, `Title ${edge} bound differs.`);
      }
      assert.equal(observation.ink.extra, 0, 'Candidate title has ink beyond the native glyph boundary.');
      assert.equal(observation.ink.missing, 0, 'Candidate title omits native glyphs or moves their boundaries.');
    }
  });
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ recording, nativeSha256: hash(nativeBytes),
    candidateSystemFamilies: GlobalFonts.families, nativeFontFiles: native.fontFiles, observations }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(hash(await readFile(path.join(nativeRoot, 'native.json'))), hash(nativeBytes));
  for (const input of native.inputs) assert.equal(hash(await readFile(path.join(nativeRoot, input.path))), input.sha256);
});
