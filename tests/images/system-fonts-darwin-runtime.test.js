import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { resolveCollageSystemFonts, loadCollageSystemFace, drawCollageSystemGlyphs } from '../../src/images/system-fonts/index.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/system-fonts-darwin-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function mask(pixels) {
  const ink = new Uint8Array(input.width * input.height);
  let count = 0, left = input.width, top = input.height, right = -1, bottom = -1;
  for (let index = 0; index < ink.length; index++) if (pixels[index * 4 + 3] >= 128) {
    const x = index % input.width, y = Math.floor(index / input.width);
    ink[index] = 1; count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { ink, count, bounds: count ? { left, top, right, bottom } : null };
}
function unmatchedInk(source, target) {
  let unmatched = 0;
  for (let index = 0; index < source.length; index++) {
    if (!source[index] || target[index]) continue;
    const x = index % input.width, y = Math.floor(index / input.width);
    let neighbour = false;
    for (let dy = -1; dy <= 1 && !neighbour; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && x + dx < input.width && y + dy >= 0 && y + dy < input.height
        && target[(y + dy) * input.width + x + dx]) { neighbour = true; break; }
    }
    if (!neighbour) unmatched++;
  }
  return unmatched;
}
function comparison(actual, expected) {
  let channels = 0, maximum = 0;
  for (let index = 0; index < actual.length; index++) {
    const difference = Math.abs(actual[index] - expected[index]);
    if (difference) channels++;
    maximum = Math.max(maximum, difference);
  }
  const candidate = mask(actual), native = mask(expected);
  return { channels, maximum, candidateBounds: candidate.bounds, nativeBounds: native.bounds,
    candidateInk: candidate.count, nativeInk: native.count,
    extraInk: unmatchedInk(candidate.ink, native.ink), missingInk: unmatchedInk(native.ink, candidate.ink) };
}
function png(pixels) {
  // Canvas ImageData accepts straight alpha; the API and recorded raw output
  // both use premultiplied alpha. The white glyph layer needs no colour guess.
  const straight = new Uint8ClampedArray(pixels);
  for (let index = 0; index < straight.length; index += 4) {
    const alpha = straight[index + 3];
    for (let channel = 0; channel < 3; channel++) straight[index + channel] = alpha ? Math.round(straight[index + channel] * 255 / alpha) : 0;
  }
  const canvas = createCanvas(input.width, input.height);
  canvas.getContext('2d').putImageData(new ImageData(straight, input.width, input.height), 0, 0);
  return canvas.toBuffer('image/png');
}

test('CoreText draws actual system HVF glyphs at the native positions and size', async t => {
  assert.equal(process.platform, 'darwin', 'This explicit platform oracle requires macOS; it must not silently skip on another platform.');
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'System glyph comparison requires the isolated native reference.');
  const output = path.join(validationOutputRoot(), 'system-fonts-darwin-runtime'); await mkdir(output);
  const candidateRoot = path.join(output, 'candidate'); await mkdir(candidateRoot);
  const recording = await recordOracle({ project: 'tests/images/fixtures/system-fonts-darwin-runtime/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
  assert.equal(recording.passed, true); assert.equal(native.actualSkiaGlyphDrawing, true);
  assert.equal(native.inputSha256, hash(inputBytes));
  assert.deepEqual(native.results.map(row => row.sample), input.cases, 'Both implementations consume the complete declared inputs.');
  const selected = await resolveCollageSystemFonts(), observed = [];
  for (const row of native.results) {
    const observation = { name: row.sample.name }; observed.push(observation);
    try {
      const descriptor = selected.probes.find(probe => probe.codepoint === row.sample.probe)?.face;
      assert.ok(descriptor, 'The probe must select an actual system font.');
      observation.descriptor = descriptor;
      const loaded = await loadCollageSystemFace(descriptor);
      observation.sourceSha256 = loaded.sourceSha256; observation.collectionIndex = loaded.collectionIndex;
      const glyphs = row.sample.codepoints.map(loaded.glyphForCodepoint);
      observation.glyphs = glyphs;
      assert.deepEqual(glyphs, row.glyphs, 'The actual system file must map every scalar to the native glyph before drawing.');
      const drawing = await drawCollageSystemGlyphs(descriptor, {
        glyphs, positions: row.sample.positions, size: row.sample.size, width: input.width, height: input.height
      });
      const expected = await readFile(path.join(output, 'native', row.sample.name + '.rgba'));
      assert.equal(hash(expected), row.output.sha256); assert.equal(expected.length, row.output.bytes);
      observation.identity = drawing.identity; observation.advances = drawing.advances;
      observation.output = { width: drawing.width, height: drawing.height, size: drawing.size, format: drawing.format,
        bytes: drawing.pixels.length, sha256: hash(drawing.pixels) };
      observation.difference = comparison(drawing.pixels, expected);
      await writeFile(path.join(candidateRoot, row.sample.name + '.rgba'), drawing.pixels, { flag: 'wx' });
      await writeFile(path.join(candidateRoot, row.sample.name + '.png'), png(drawing.pixels), { flag: 'wx' });
    } catch (error) { observation.error = { name: error.name, message: error.message, stack: error.stack }; }
  }
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ inputSha256: hash(inputBytes), selected, observed, native }, null, 2) + '\n');
  for (let index = 0; index < native.results.length; index++) await t.test(native.results[index].sample.name, () => {
    const actual = observed[index], row = native.results[index];
    assert.equal(actual.error, undefined, JSON.stringify(actual.error));
    assert.ok(row.face.outlineBytes > 0, 'The oracle must exercise the actual OS HVF outline format.');
    assert.deepEqual(actual.identity, actual.descriptor, 'The sized drawing font must retain its selected identity and variation coordinates.');
    for (const name of ['family', 'postscriptName', 'weight', 'width', 'slant', 'nameTableSha256']) assert.deepEqual(actual.identity[name], row.face[name], name);
    assert.equal(row.face.namedFace.nameTableSha256, row.face.nameTableSha256);
    assert.deepEqual(actual.identity.variations, row.face.namedFace.variations, 'The actual selected variation must match the independent named-face OS readback.');
    assert.ok(actual.identity.variations.length > 0, 'This fixture must cover actual variable-font coordinates.');
    assert.deepEqual(actual.output, { width: input.width, height: input.height, size: row.sample.size,
      format: row.output.format, bytes: row.output.bytes, sha256: actual.output.sha256 });
    assert.equal(row.font.size, row.sample.size); assert.equal(row.font.subpixel, true);
    assert.equal(row.font.baselineSnap, false); assert.equal(row.font.edging, 'Antialias');
    assert.equal(actual.advances.length, row.advances.length);
    for (let glyph = 0; glyph < row.advances.length; glyph++) {
      assert.equal(Math.round(actual.advances[glyph].x * 1000), Math.round(row.advances[glyph] * 1000), `Glyph ${glyph} advance differs.`);
      assert.equal(Math.abs(actual.advances[glyph].y), 0);
    }
    // Explicit IDs, complete positions and the actual face/size are checked
    // independently above. Retain all channel differences as diagnostics;
    // compare the glyph shapes at their raster boundaries, not PNG bytes.
    const difference = actual.difference;
    assert.equal(difference.extraInk, 0, 'Candidate has ink beyond native glyph boundaries.');
    assert.equal(difference.missingInk, 0, 'Candidate is missing native glyph ink.');
    if (row.sample.codepoints.length) {
      assert.ok(difference.nativeInk > 0); assert.ok(difference.candidateInk > 0);
      for (const edge of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(difference.candidateBounds[edge] - difference.nativeBounds[edge]) <= 1, `Glyph ${edge} boundary differs.`);
    } else {
      assert.equal(difference.nativeInk, 0); assert.equal(difference.candidateInk, 0);
      assert.equal(actual.output.sha256, row.output.sha256, 'An empty glyph run must remain fully transparent.');
    }
  });
  await assert.rejects(drawCollageSystemGlyphs({ ...selected.probes[0].face, postscriptName: 'Not the selected face' }, {}), /actually selected/);
});
