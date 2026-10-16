import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { composeUserViewCollage, drawUserViewTitle } from '../../src/images/user-view-collage.js';
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
      const context = createCanvas(width, height).getContext('2d'), layout = drawUserViewTitle(context, row.sample.Text);
      observation.candidateLayout = layout;
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
