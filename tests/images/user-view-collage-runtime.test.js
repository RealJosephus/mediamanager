import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas, GlobalFonts, ImageData, loadImage } from '@napi-rs/canvas';
import { composeUserViewCollage, drawUserViewTitle } from '../../src/images/user-view-collage.js';
import { loadCollageSystemFace } from '../../src/images/system-fonts/index.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const width = 960, height = 540;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputFile = new URL('./fixtures/user-view-collage-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes.toString('utf8'));
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
async function observeTitle(context, text) {
  const draws = [], fillText = context.fillText, drawImage = context.drawImage;
  context.fillText = function (...args) {
    const metrics = this.measureText(args[0]), [, x, y] = args;
    draws.push({ kind: 'text', args, font: this.font, direction: this.direction, textAlign: this.textAlign,
      textBaseline: this.textBaseline, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha,
      bounds: { left: x - metrics.actualBoundingBoxLeft, right: x + metrics.actualBoundingBoxRight,
        top: y - metrics.actualBoundingBoxAscent, bottom: y + metrics.actualBoundingBoxDescent } });
    return fillText.apply(this, args);
  };
  context.drawImage = function (layer, ...args) {
    const pixels = layer.data(), ink = glyphMask(pixels, new Uint8Array(pixels.length));
    draws.push({ kind: 'glyph-layer', args, width: layer.width, height: layer.height,
      pixelHash: hash(pixels), ink: { count: ink.count, bounds: ink.bounds }, globalAlpha: this.globalAlpha });
    return drawImage.call(this, layer, ...args);
  };
  try { return { layout: await drawUserViewTitle(context, text), draws }; }
  finally { context.fillText = fillText; context.drawImage = drawImage; }
}
function coloredInk(pixels, background) {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const rgb = [...pixels.subarray(offset, offset + 3)];
    const coverage = rgb.map((value, channel) => (value - background[offset + channel]) / (255 - background[offset + channel]));
    // White text over this backdrop has equal coverage in all channels.
    // Count visibly coloured paint, without requiring a particular palette.
    if (Math.max(...rgb) - Math.min(...rgb) > 32 && Math.max(...coverage) - Math.min(...coverage) > 0.1) count++;
  }
  return count;
}
async function assertTitleDrawing({ row, layout, draws, context, pixelHash, ink }) {
  const text = row.sample.Text;
  assert.equal(hash(context.canvas.data()), pixelHash, 'Captured actual title calls must reproduce the composed image.');
  assert.ok(layout.runs.map(run => run.text).join('').startsWith(text), 'The complete input title must be passed to drawing in order.');
  assert.equal(draws.length, layout.runs.length);
  assert.ok(Number.isFinite(layout.size) && layout.size > 0 && layout.size <= 112);
  assert.ok(layout.measured > 0 && layout.measured <= width * 0.95 + 1, 'The measured title must fit the available width.');
  assert.ok(layout.padding >= 0 && layout.x > 0 && layout.x < width);
  assert.ok(layout.y > height / 4 && layout.y < height * 3 / 4, 'The title must remain in the central band.');
  assert.equal(layout.direction, row.layout.direction, 'The title must retain its semantic direction.');
  assert.ok(ink.count > 0);
  assert.ok(ink.bounds.left > 0 && ink.bounds.top > 0 && ink.bounds.right < width - 1 && ink.bounds.bottom < height - 1,
    'Visible title content must remain inside the image without clipping.');
  const clusters = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map(row => row.segment);
  for (const cluster of clusters) assert.ok(layout.runs.some(run => run.text.includes(cluster)), 'A grapheme must not be split between drawing calls.');
  for (let index = 0; index < layout.runs.length; index++) {
    const run = layout.runs[index], draw = draws[index];
    assert.ok(text.includes(run.text), 'Drawing must not substitute unrelated text.');
    assert.equal(draw.globalAlpha, 1);
    if (draw.kind === 'text') {
      assert.equal(run.backend, 'canvas-text');
      assert.deepEqual(draw.args, [run.text, run.x, run.y], 'The real text call must retain all characters without maxWidth scaling.');
      assert.equal(draw.font, run.font);
      assert.equal(draw.direction, layout.direction);
      assert.equal(draw.textAlign, layout.direction === 'rtl' ? 'right' : 'left');
      assert.equal(draw.textBaseline, 'alphabetic'); assert.equal(draw.fillStyle, '#ffffff');
    } else {
      assert.equal(draw.kind, 'glyph-layer'); assert.equal(run.backend, 'coretext-glyphs');
      assert.deepEqual(draw.args, [0, 0]); assert.equal(draw.width, width); assert.equal(draw.height, height);
      assert.match(draw.pixelHash, /^[a-f0-9]{64}$/);
      if (run.text.trim()) assert.ok(draw.ink.count > 0, 'Every nonblank run must produce actual paint.');
      assert.equal(run.shaped.glyphs.length, run.shaped.positions.length);
      const loaded = await loadCollageSystemFace(run.face);
      if (loaded.containsGlyphs(run.text)) assert.ok(run.shaped.glyphs.every(glyph => glyph > 0), 'Available characters must not become missing-glyph boxes.');
      if (/^[\p{Script=Arabic}\p{Script=Hebrew}\p{Mark}\s]+$/u.test(run.text)) {
        assert.ok(run.shaped.clusters.every((cluster, index, values) => index === 0 || cluster <= values[index - 1]),
          'An Arabic or Hebrew word must retain right-to-left character order.');
      }
      // A joined emoji may use one glyph or several overlaid glyphs. A skin
      // tone or gender symbol must not be advanced as a separate character.
      for (const cluster of clusters.filter(value => value.includes('\u200d') && run.text.includes(value))) {
        const start = Buffer.byteLength(run.text.slice(0, run.text.indexOf(cluster)));
        const end = start + Buffer.byteLength(cluster);
        const glyphs = run.shaped.glyphs.map((glyph, index) => ({ glyph, point: run.shaped.positions[index], cluster: run.shaped.clusters[index] }))
          .filter(glyph => glyph.cluster >= start && glyph.cluster < end);
        assert.ok(glyphs.length > 0 && glyphs.every(glyph => glyph.glyph > 0), 'A supported emoji cluster must not contain missing glyphs.');
        const parts = [...cluster].filter(value => /\p{Emoji_Modifier}|[\u2640\u2642]/u.test(value)).map(value => loaded.glyphForCodepoint(value.codePointAt(0)));
        for (const part of glyphs.filter(glyph => parts.includes(glyph.glyph))) {
          assert.ok(Math.abs(part.point.x - glyphs[0].point.x) < run.size / 2, 'An emoji modifier must remain part of the joined symbol.');
        }
      }
    }
  }
}

test('UserView thumbnails preserve source selection, crop and complete readable titles', async t => {
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
    assert.deepEqual(candidate.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'The thumbnail must remain a PNG.');
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
      const context = titleContext(candidateBackground);
      const { layout, draws } = await observeTitle(context, row.sample.Text);
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
      assert.ok(expectedInk.count > 0, 'The native reference must contain title content.');
      await assertTitleDrawing({ row, layout, draws, context, pixelHash: observation.pixelHash, ink: actualInk });
      if (/\p{Extended_Pictographic}/u.test(row.sample.Text)) {
        observation.color = { actual: coloredInk(actual.pixels, candidateBackground), expected: coloredInk(expected.pixels, nativeBackground) };
        if (observation.color.expected > 0) assert.ok(observation.color.actual > 0, 'Available colour emoji must retain visible colour.');
      }
      observation.titleContract = 'complete-visible-title';
    }
  });
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ recording, nativeSha256: hash(nativeBytes),
    candidateSystemFamilies: GlobalFonts.families, nativeFontFiles: native.fontFiles, observations }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(hash(await readFile(path.join(nativeRoot, 'native.json'))), hash(nativeBytes));
  for (const input of native.inputs) assert.equal(hash(await readFile(path.join(nativeRoot, input.path))), input.sha256);
});
