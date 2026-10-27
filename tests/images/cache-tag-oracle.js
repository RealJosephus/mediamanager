import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const fixture = new URL('./fixtures/cache-tag-current/', import.meta.url);
let recording;

async function record() {
  const output = path.join(validationOutputRoot(), `image-cache-tag-current-${randomUUID()}`);
  assertValidationOutputChild(output);
  await mkdir(output, { recursive: true });
  const report = { scope: 'current Native ImageProcessor cache tag overloads and fixed input bindings',
    fullInstanceVerified: false, completeLibraryVerified: false, productionScaleVerified: false,
    phaseAcceptance: false, releaseAcceptance: false, sourceBindings: [], historicalTags: [] };
  try {
    const inputs = [new URL('vectors.json', fixture), new URL('provenance.json', fixture),
      new URL('./fixtures/http/input.json', import.meta.url), new URL('./fixtures/http/native.json', import.meta.url),
      new URL('../sessions/fixtures/session-user-image-tag.json', import.meta.url)];
    const bytes = await Promise.all(inputs.map(filename => readFile(filename)));
    report.inputBindings = await Promise.all(inputs.map(filename => describeFile(fileURLToPath(filename))));
    const [vectors, provenance, images, historicHttp, profiles] = bytes.map(value => parseLosslessJson(value.toString('utf8')));
    const samples = [
      ...vectors.map(row => ({ name: `vector:${row.name}`, baseItemPath: row.path,
        imagePath: row.imagePath ?? row.path, modified: row.modified })),
      ...['initial', 'updated'].map(stage => ({ name: `profile:${stage}`, baseItemPath: profiles[stage].Path,
        imagePath: profiles[stage].Path, modified: profiles[stage].LastModified })),
      ...images.imageRows.map(row => {
        const item = images.items.find(item => item.Id === row.ItemId);
        assert.ok(item, row.Id);
        return { name: `image:${row.Id}`, baseItemPath: item.Path, imagePath: row.Path, modified: row.DateModified };
      }),
    ];
    const input = { samples }, inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
    const inputFile = path.join(output, 'input.json');
    await writeFile(inputFile, inputBytes, { flag: 'wx' });
    report.inputSha256 = sha256(inputBytes);
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const source of provenance.sources) {
      const declared = manifest.files.find(entry => entry.path === source.path);
      assert.equal(declared?.sha256, source.sha256, source.path);
      const actual = await describeFile(path.join(build.root, 'source', source.path));
      assert.equal(actual.sha256, source.sha256, source.path);
      report.sourceBindings.push({ relativePath: source.path, ...actual });
    }
    report.oracle = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)),
      output: path.join(output, 'oracle'), args: [inputFile, '{output}/native.json'] });
    const nativeFile = path.join(output, 'oracle/native.json'), nativeBytes = await readFile(nativeFile);
    const native = JSON.parse(nativeBytes);
    report.native = await describeFile(nativeFile);
    assert.equal(report.oracle.passed, true);
    assert.equal(report.oracle.outputs.find(entry => entry.filename === nativeFile)?.sha256, sha256(nativeBytes));
    assert.equal(native.actualImageProcessor, true);
    assert.equal(native.inputSha256, sha256(inputBytes));
    assert.equal(native.samples.length, samples.length);
    assert.equal(native.missingUserImageTag, null);
    for (const assembly of native.assemblies) {
      assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.name);
      assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
    }
    const observations = new Map();
    for (const [index, sample] of samples.entries()) {
      const row = native.samples[index];
      assert.equal(row.name, sample.name); assert.equal(row.baseItemPath, sample.baseItemPath);
      assert.equal(row.imagePath, sample.imagePath);
      assert.match(row.stringTag, /^[a-f0-9]{32}$/u, row.name);
      assert.match(row.userTag, /^[a-f0-9]{32}$/u, row.name);
      for (const key of ['itemTag', 'dtoTag', 'chapterTag', 'dtoChapterTag']) assert.equal(row[key], row.stringTag, row.name + ': ' + key);
      assert.equal(row.emptyChapterTag, null); assert.equal(row.emptyDtoChapterTag, null);
      assert.equal(observations.has(row.name), false); observations.set(row.name, row);
    }
    for (const stage of ['initial', 'updated']) report.historicalTags.push({ role: `profile:${stage}`,
      original: profiles[stage], current: observations.get(`profile:${stage}`) });
    for (const response of historicHttp.filter(row => ['infos-authenticated', 'authenticated-allowed-infos'].includes(row.name))) {
      for (const image of response.body) {
        const rows = images.imageRows.filter(row => row.ItemId === images.id && row.Path === image.Path);
        assert.equal(rows.length, 1, response.name + ': ' + image.Path);
        report.historicalTags.push({ role: response.name, original: image, row: rows[0],
          current: observations.get(`image:${rows[0].Id}`) });
      }
    }
    for (const [index, filename] of inputs.entries()) assert.equal(sha256(await readFile(filename)), sha256(bytes[index]), 'Original input remains unchanged.');
    report.nativeComponentPassed = true;
    return { output, report, native, input, observations };
  } catch (error) {
    report.nativeComponentPassed = false; report.failure = errorObservation(error); throw error;
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

// Each test process records once; every tag remains bound to the original path and 100ns input.
export function currentImageCacheTagOracle() { return recording ??= record(); }

export function currentImageInfoResponse(expected, input, oracle) {
  if (!['infos-authenticated', 'authenticated-allowed-infos'].includes(expected.name)) return expected;
  assert.equal(expected.request.pathname, `/Items/${input.id}/Images`);
  assert.equal(expected.status, 200); assert.ok(Array.isArray(expected.body));
  return { ...expected, body: expected.body.map(image => {
    const rows = input.imageRows.filter(row => row.ItemId === input.id && row.Path === image.Path);
    assert.equal(rows.length, 1, expected.name + ': ' + image.Path);
    const actual = oracle.observations.get(`image:${rows[0].Id}`);
    assert.equal(actual.imagePath, image.Path); assert.equal(actual.baseItemPath, input.items.find(row => row.Id === input.id).Path);
    return { ...image, ImageTag: actual.itemTag };
  }) };
}
