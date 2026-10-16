import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collageFontProbes, resolveCollageSystemFonts, loadCollageSystemFace, registerCollageSystemFace } from '../../src/images/system-fonts/index.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const inputFile = new URL('./fixtures/system-fonts-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('system collage faces match actual native selection, font tables and nominal coverage', async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'System-font comparison requires the isolated native reference.');
  assert.deepEqual(input.probes, collageFontProbes);
  const output = path.join(validationOutputRoot(), 'system-fonts-runtime'); await mkdir(output);
  const recording = await recordOracle({ project: 'tests/images/fixtures/system-fonts-runtime/Oracle.csproj',
    output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}'] });
  const native = JSON.parse(await readFile(path.join(output, 'native/native.json')));
  assert.equal(recording.passed, true); assert.equal(native.actualSkiaEncoder, true);
  assert.equal(native.inputSha256, hash(inputBytes));
  const first = resolveCollageSystemFonts(), concurrent = resolveCollageSystemFonts();
  assert.equal(concurrent, first, 'Concurrent callers must share one OS query.');
  const selected = await first;
  assert.equal(await resolveCollageSystemFonts(), selected, 'The selected OS snapshot is cached.');
  assert.deepEqual(selected.probes.map(row => row.codepoint), input.probes);
  const expectedFallbacks = [...native.probes.flatMap(row => row.face ? [row.face] : []), native.defaultFace];
  assert.deepEqual(native.fallbackFaces, expectedFallbacks, 'The probes must reproduce actual SkiaEncoder initialization.');
  const expected = [native.defaultFace, ...native.probes.map(row => row.face)];
  const descriptors = [selected.defaultFace, ...selected.probes.map(row => row.face)];
  assert.deepEqual(selected.files, [...new Set(descriptors.filter(Boolean).map(face => face.path))].sort());
  assert.deepEqual(selected.fallbackFaces, [...selected.probes.flatMap(row => row.face ? [row.face] : []), selected.defaultFace]);
  const scalars = [...new Set([...input.texts.join('')].map(value => value.codePointAt(0)).concat(input.probes))].sort((a, b) => a - b);
  const observed = [];
  for (const face of descriptors) {
    if (face === null) { observed.push(null); continue; }
    try {
      const loading = loadCollageSystemFace(face);
      assert.equal(loadCollageSystemFace(face), loading, 'Repeated probes must share the same file/face load.');
      const loaded = await loading, registered = await registerCollageSystemFace(face);
      assert.equal(await registerCollageSystemFace(face), registered, 'Repeated registration must reuse the same face.');
      observed.push({ descriptor: face, family: loaded.family, postscriptNames: loaded.postscriptNames,
        weight: loaded.weight, width: loaded.width, slant: loaded.slant, fileStyle: loaded.fileStyle,
        collectionIndex: loaded.collectionIndex, sourceSha256: loaded.sourceSha256, sourceBytes: loaded.sourceBytes,
        tableHashes: loaded.tableHashes, canvasFamily: registered.canvasFamily,
        glyphs: scalars.map(codepoint => ({ codepoint, glyph: loaded.glyphForCodepoint(codepoint) })),
        coverage: input.texts.map(text => ({ text, present: loaded.containsGlyphs(text) })) });
    } catch (error) { observed.push({ descriptor: face, error: { name: error.name, message: error.message, stack: error.stack, candidates: error.candidates } }); }
  }
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ selected, observed, native, inputSha256: hash(inputBytes) }, null, 2) + '\n');
  for (let index = 0; index < expected.length; index++) await t.test(index === 0 ? 'default face' : `probe U+${input.probes[index - 1].toString(16)}`, () => {
    const actual = observed[index], target = expected[index];
    if (target === null) { assert.equal(actual, null); return; }
    assert.ok(actual, 'The native system-selected face must exist.');
    assert.equal(actual.error, undefined, JSON.stringify(actual.error));
    assert.equal(actual.family, target.family);
    if (actual.descriptor.postscriptName !== undefined) assert.equal(actual.descriptor.postscriptName, target.postscriptName);
    if (actual.descriptor.nameTableSha256 === undefined) {
      assert.ok(actual.postscriptNames.includes(target.postscriptName), 'The exact selected face must occur in its actual system file.');
    } else {
      assert.equal(actual.descriptor.nameTableSha256, target.tableHashes.name, 'The CoreText alias must bind the actual native name table.');
      assert.equal(actual.tableHashes.name, actual.descriptor.nameTableSha256, 'The selected file member must contain that exact name table.');
    }
    for (const key of ['weight', 'width', 'slant', 'tableHashes', 'glyphs', 'coverage']) assert.deepEqual(actual[key], target[key], key);
    assert.match(actual.sourceSha256, /^[a-f0-9]{64}$/); assert.ok(actual.sourceBytes > 0);
    assert.match(actual.canvasFamily, /^MediaManager Collage [a-f0-9]{64}$/);
  });
});
