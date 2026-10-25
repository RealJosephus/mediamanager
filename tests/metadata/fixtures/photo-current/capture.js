import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const root = new URL('./', import.meta.url);
export const photoRoot = new URL('../photo-provider/', root);
export const profile = JSON.parse(await readFile(new URL('./current-profile.json', import.meta.url), 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
process.env.TZ = profile.timezone;

const definitions = {
  provider: { input: new URL('../photo-provider/input.json', root), assets: new URL('../photo-provider/assets/', root) },
  comment: { input: new URL('../photo-provider/user-comment/input.json', root), assets: new URL('../photo-provider/user-comment/', root) },
  edges: { input: new URL('./edges-input.json', import.meta.url) },
  dto: { input: new URL('../../../library/fixtures/photo-dto/input.json', root) },
  'custom-lifecycle': { input: new URL('../custom-image-lifecycle/input.json', root) },
  'dynamic-host': { input: new URL('../dynamic-image-host/input.json', root) },
};
const poster = new URL('../../../images/fixtures/http/poster.png', root);
const pending = new Map();
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';

function businessProjection(kind, native) {
  const results = native.results.map(sample => {
    if (kind === 'provider' || kind === 'comment') {
      const { exception, errors, errorCount, isoOverflow, item, ...retained } = sample;
      const { communityRatingBits, dateCreatedKind, premiereDateKind, ...fields } = item;
      return { ...retained, item: fields };
    }
    if (kind === 'custom-lifecycle') {
      const { exception, ...retained } = sample;
      return retained;
    }
    return sample;
  });
  return { results, ...(native.changes ? { changes: native.changes } : {}) };
}

function argumentsFor(kind, input, definition) {
  if (kind === 'provider' || kind === 'comment') return [input, fileURLToPath(definition.assets), '{output}/native.json'];
  if (kind === 'edges') return ['{output}/native.json', input];
  if (kind === 'dto') return ['{output}/native.json', input];
  if (kind === 'custom-lifecycle') return [input, '{output}/native.json', '{output}/cases', fileURLToPath(poster)];
  if (kind === 'dynamic-host') return [input, '{output}/cases', '{output}/native.json'];
  throw new Error('Unknown current Photo consumer.');
}

export function currentPhotoNative(kind) {
  assert.ok(Object.hasOwn(definitions, kind), 'A declared current Photo consumer is required.');
  if (!pending.has(kind)) pending.set(kind, capture(kind));
  return pending.get(kind);
}

async function capture(kind) {
  const definition = definitions[kind], inputBytes = await readFile(definition.input), input = JSON.parse(inputBytes);
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'photo-current-' + kind + '-' + randomUUID()));
  await mkdir(output);
  const report = { schemaVersion: 1, kind, identity: profile.kind, inputSha256: hash(inputBytes),
    scope: profile.scope, inputs: [], sourceBindings: [], captures: [], historicalRecordingReused: false,
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    assert.equal(profile.kind, 'same-workflow-current-native-photo');
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, root)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relativePath); assert.ok(expected, relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, expected.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    const attribution = JSON.parse(await readFile(new URL('taglib-source/origins.json', root), 'utf8'));
    assert.equal(attribution.commit, 'b5ae84f2e84087bf160bb0471420200dd2b5d809');
    for (const source of attribution.sources) {
      const bytes = await readFile(new URL('taglib-source/' + source.relativePath, root));
      assert.equal(bytes.length, source.bytes); assert.equal(hash(bytes), source.sha256, source.relativePath);
    }
    assert.deepEqual(await readFile(new URL('taglib-source/COPYING', root)),
      await readFile(new URL('../../../../src/metadata/resources/photo-tags-license.txt', root)));
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL(kind + '/Oracle.csproj', root)), output: directory,
        args: argumentsFor(kind, fileURLToPath(definition.input), definition), environment: { ...process.env, TZ: profile.timezone } });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.inputSha256, hash(inputBytes));
      const expectedNames = kind === 'dto' ? [...input.dtoCases, ...input.aspectCases].map(sample => sample.name)
        : kind === 'edges' ? input : (input.cases ?? input).map(sample => sample.name);
      assert.deepEqual(native.results.map(sample => sample.name ?? sample.source), expectedNames);
      if (kind === 'provider') assert.equal(native.changes.length, 14);
      if (kind === 'provider' || kind === 'comment') assert.equal(native.localUtcOffset, '08:00:00');
      for (const assembly of native.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.available, true, assembly.name); assert.equal(assembly.sha256, actual.sha256, assembly.name);
      }
      if (kind === 'custom-lifecycle') {
        assert.equal(native.imageSha256, hash(await readFile(poster)));
        const library = await describeFile(path.join(build.runtime, 'runtimes', native.sqlite.runtimeIdentifier, 'native', path.basename(native.sqlite.filename)));
        assert.equal(library.available, true); assert.equal(library.sha256, native.sqlite.sha256);
        assert.equal(native.sqlite.resolverObserved, true);
      }
      if (kind === 'dynamic-host') assert.ok(native.results.every(sample => sample.streams.every(Boolean)),
        'Every Native-owned dynamic response stream is disposed.');
      if (first) assert.deepEqual(businessProjection(kind, native), businessProjection(kind, first), 'Independent Native captures');
      else first = native;
    }
    const after = await verifyNativeBuild();
    assert.equal(after.identitySha256, build.identitySha256); assert.equal(after.runtimeEntriesSha256, build.runtimeEntriesSha256);
    report.nativeExecutionRecorded = true; report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, input, output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordPhotoCandidate(kind, name, observation) {
  const { output } = await currentPhotoNative(kind);
  assert.equal(typeof name, 'string');
  const basename = (name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').slice(0, 80) || 'sample')
    + '-' + hash(Buffer.from(name)).slice(0, 12);
  await writeFile(path.join(output, 'candidate', basename + '.json'), json({ name, observation }), { flag: 'wx' });
}
