import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collageFontProbes, resolveCollageSystemFonts, loadCollageSystemFace, registerCollageSystemFace } from '../../src/images/system-fonts/index.js';
import { systemFontDirectories } from '../../src/images/system-fonts/sfnt.js';
import { shapeCollageText, measureCollageText } from '../../src/images/system-fonts/text.js';
import { assertDarwinSystemGlyphs } from './system-fonts-darwin-fixture.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/system-fonts-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Diagnostic metadata only: never write or serialize actual system-font bytes.
function sfntSummary(bytes, collectionIndex = 0) {
  const tables = systemFontDirectories(bytes)[collectionIndex];
  const collection = bytes.toString('ascii', 0, 4) === 'ttcf';
  const start = collection ? bytes.readUInt32BE(12 + collectionIndex * 4) : 0;
  return { bytes: bytes.length, sha256: hash(bytes), signature: bytes.subarray(0, 4).toString('hex'), collectionIndex,
    faceSignature: bytes.subarray(start, start + 4).toString('hex'),
    tables: [...tables].map(([tag, data], index) => {
      const record = start + 12 + index * 16;
      return { tag, offset: bytes.readUInt32BE(record + 8), bytes: data.length,
        checksum: bytes.readUInt32BE(record + 4).toString(16).padStart(8, '0'), sha256: hash(data) };
    }).sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0) };
}

test('system collage fonts load actual inputs and support title shaping', async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'System-font comparison requires the isolated native reference.');
  assert.deepEqual(input.probes, collageFontProbes);
  const output = path.join(validationOutputRoot(), 'system-fonts-runtime'); await mkdir(output);
  const recording = await recordOracle({ project: 'tests/images/fixtures/system-fonts-runtime/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
  assert.equal(recording.passed, true); assert.equal(native.actualSkiaEncoder, true);
  assert.equal(native.inputSha256, hash(inputBytes));
  const [selected] = await Promise.all([resolveCollageSystemFonts(), resolveCollageSystemFonts()]);
  assert.deepEqual(selected.probes.map(row => row.codepoint), input.probes);
  const expectedFallbacks = [...native.probes.flatMap(row => row.face ? [row.face] : []), native.defaultFace];
  assert.deepEqual(native.fallbackFaces, expectedFallbacks, 'The probes must reproduce actual SkiaEncoder initialization.');
  const expected = [native.defaultFace, ...native.probes.map(row => row.face)];
  const descriptors = [selected.defaultFace, ...selected.probes.map(row => row.face)];
  assert.deepEqual(selected.files, [...new Set(descriptors.filter(Boolean).map(face => face.path))].sort());
  assert.deepEqual(selected.fallbackFaces, [...selected.probes.flatMap(row => row.face ? [row.face] : []), selected.defaultFace]);
  const scalars = [...new Set([...input.texts.join('')].map(value => value.codePointAt(0)).concat(input.probes))].sort((a, b) => a - b);
  const observed = [], sourceFiles = new Map();
  for (const face of descriptors) {
    if (face === null) { observed.push(null); continue; }
    const observation = { descriptor: face }; observed.push(observation);
    try {
      const loaded = await loadCollageSystemFace(face);
      Object.assign(observation, { family: loaded.family, postscriptNames: loaded.postscriptNames,
        weight: loaded.weight, width: loaded.width, slant: loaded.slant, fileStyle: loaded.fileStyle,
        collectionIndex: loaded.collectionIndex, sourceSha256: loaded.sourceSha256, sourceBytes: loaded.sourceBytes,
        tableHashes: loaded.tableHashes,
        glyphs: scalars.map(codepoint => ({ codepoint, glyph: loaded.glyphForCodepoint(codepoint) })),
        coverage: input.texts.map(text => ({ text, present: loaded.containsGlyphs(text) })) });
      if (!sourceFiles.has(face.path)) sourceFiles.set(face.path, readFile(face.path));
      observation.sourceSfnt = sfntSummary(await sourceFiles.get(face.path), loaded.collectionIndex);
      observation.registeredSfnt = sfntSummary(loaded.bytes);
      if (process.platform !== 'darwin') {
        const registered = await registerCollageSystemFace(face);
        observation.canvasFamily = registered.canvasFamily;
      }
      observation.shaping = [];
      for (const text of input.texts) for (const size of [112, 56.5]) {
        const metrics = await measureCollageText(face, text, size);
        observation.shaping.push({ text, size, rawWidth: metrics.width, xHeight: metrics.xHeight,
          ...await shapeCollageText(face, text, size) });
      }
    } catch (error) { observation.error = { name: error.name, message: error.message, stack: error.stack, candidates: error.candidates }; }
  }
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ selected, observed, native, inputSha256: hash(inputBytes) }, null, 2) + '\n');
  for (let index = 0; index < expected.length; index++) await t.test(index === 0 ? 'default face' : `probe U+${input.probes[index - 1].toString(16)}`, () => {
    const actual = observed[index], target = expected[index];
    if (actual === null) {
      assert.notEqual(index, 0, 'A default title font must be available.');
      assert.equal(target, null, 'An available language fallback must not be lost.');
      return;
    }
    assert.equal(actual.error, undefined, JSON.stringify(actual.error));
    // Identity binds the bytes that were actually loaded. Native aliases,
    // glyph numbers and font-table equality are diagnostic, not text output.
    if (actual.descriptor.nameTableSha256 !== undefined) {
      assert.equal(actual.tableHashes.name, actual.descriptor.nameTableSha256, 'The selected file member must match its own OS identity.');
    }
    if (index > 0 && target?.glyphs.some(row => row.codepoint === input.probes[index - 1] && row.glyph > 0)) {
      assert.ok(actual.glyphs.some(row => row.codepoint === input.probes[index - 1] && row.glyph > 0), 'The language probe must remain supported.');
    }
    assert.match(actual.sourceSha256, /^[a-f0-9]{64}$/); assert.ok(actual.sourceBytes > 0);
    if (process.platform !== 'darwin') assert.ok(actual.canvasFamily, 'The actual selected font must be available for Canvas drawing.');
    assert.deepEqual(actual.shaping.map(({ text, size }) => ({ text, size })), input.texts.flatMap(text => [112, 56.5].map(size => ({ text, size }))));
    for (const sample of actual.shaping) {
      assert.ok(Number.isFinite(sample.rawWidth) && sample.rawWidth >= 0);
      assert.ok(Number.isFinite(sample.width) && sample.width >= 0);
      assert.ok(Number.isFinite(sample.xHeight));
      assert.ok(sample.glyphs.length > 0);
      assert.equal(sample.positions.length, sample.glyphs.length);
      assert.equal(sample.clusters.length, sample.glyphs.length);
      for (const point of sample.positions) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      for (const cluster of sample.clusters) assert.ok(Number.isInteger(cluster) && cluster >= 0 && cluster < Buffer.byteLength(sample.text));
      if (actual.coverage.find(row => row.text === sample.text).present) {
        assert.ok(sample.glyphs.every(glyph => glyph > 0), 'Supported text must not become missing-glyph boxes during shaping.');
      }
    }
  });
  if (process.platform === 'darwin') await t.test('system backend draws actual HVF glyphs', assertDarwinSystemGlyphs);
});
