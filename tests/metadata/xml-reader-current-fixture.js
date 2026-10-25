import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function functionalXmlReader({ error, result }) {
  return { failed: Boolean(error), result: result && Object.hasOwn(result, 'HasMetadata')
    ? { HasMetadata: result.HasMetadata, item: result.item } : result };
}

export function functionalEpisode({ exception, hasMetadata, item, people, remoteImages, localImages, calls, userData }) {
  return { failed: Boolean(exception), hasMetadata, item, people, remoteImages, localImages,
    ...(calls ? { saves: calls.filter(call => call.action === 'save').map(({ itemId, reason, value }) => ({ itemId, reason, value })),
      userData: { current: userData.current, persisted: userData.persisted, committed: userData.committed } } : {}) };
}

export async function currentXmlReaderFixture(profileUrl) {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  assert.equal(profile.schemaVersion, 1);
  const readInput = async role => JSON.parse(await readFile(new URL(profile.inputs.find(entry => entry.role === role).filename, profileUrl), 'utf8'));
  const baseInput = await readInput('scenarios'), layoutInput = await readInput('layouts');
  const layoutRelations = await readInput('layoutRelations');
  const localXml = profile.fixture === 'local-xml-provider';
  const input = localXml ? { ...baseInput, parserCases: [...baseInput.parserCases, ...layoutInput.parserCases] }
    : [...baseInput, ...layoutInput];
  if (localXml) {
    assert.equal(baseInput.parserCases.length, profile.baseCases);
    assert.equal(layoutInput.parserCases.length, profile.layoutCases);
    for (const [group, count] of Object.entries(profile.groups)) assert.equal(input[group].length, count, group);
  } else {
    assert.equal(baseInput.length, profile.baseCases);
    assert.equal(layoutInput.length, profile.layoutCases);
  }
  const parserCases = localXml ? input.parserCases : input;
  assert.equal(new Set(parserCases.map(sample => sample.name)).size, parserCases.length);
  let pending;
  const capture = () => pending ??= captureNative();

  async function captureNative() {
    const output = path.join(validationOutputRoot(), profile.fixture + '-current-' + randomUUID());
    assertValidationOutputChild(output);
    await mkdir(output);
    const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [],
      nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
    try {
      for (const expected of profile.inputs) {
        const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
        assert.equal(actual.available, true, expected.filename);
        assert.equal(actual.bytes, expected.bytes, expected.filename);
        assert.equal(actual.sha256, expected.sha256, expected.filename);
        report.inputs.push({ role: expected.role, ...actual });
      }
      const build = await verifyNativeBuild();
      report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
        receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
      const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
      for (const relative of profile.sourcePaths) {
        const pinned = sources.files.find(entry => entry.path === relative);
        assert.ok(pinned, 'The designated source offer must include ' + relative);
        const source = await describeFile(path.join(build.root, 'source', relative));
        assert.equal(source.sha256, pinned.sha256, relative);
        report.sourceBindings.push({ relativePath: relative, source });
      }
      const inputFile = path.join(output, 'scenarios.json'), inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
      await writeFile(inputFile, inputBytes, { flag: 'wx' });
      report.scenarios = await describeFile(inputFile);
      const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
      const directory = path.join(output, 'native');
      const record = await recordOracle({ project, output: directory,
        args: [inputFile, '{output}/native.json', ...(localXml ? ['{output}/state'] : [])] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.capture = { record, observation: await describeFile(filename) };
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha256(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha256(inputBytes));
      for (const assembly of native.assemblies) {
        const bound = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(bound.available, true, assembly.name); assert.equal(bound.sha256, assembly.sha256, assembly.name);
      }
      const parserResults = localXml ? native.parserResults : native.results;
      assert.deepEqual(parserResults.map(result => localXml ? [result.name, result.type] : result.name),
        localXml ? input.parserCases.flatMap(sample => ['BoxSet', 'Playlist'].map(type => [sample.name, type])) : input.map(sample => sample.name));
      for (const [index, result] of parserResults.entries()) {
        const sample = parserCases[localXml ? Math.floor(index / 2) : index];
        const expected = localXml ? sample.xml == null ? null : sample.bytes ? Buffer.from(sample.bytes, 'base64') : Buffer.from(sample.xml)
          : Buffer.from(sample.text);
        assert.equal(result.file.exists, expected !== null, sample.name);
        if (expected !== null) assert.deepEqual(await readNativeInput(result.file), expected, sample.name + ' actual Native input');
      }
      if (localXml) {
        for (const group of ['provider', 'merge', 'pipeline']) {
          assert.deepEqual(native[group + 'Results'].map(result => result.name), input[group + 'Cases'].map(sample => sample.name), group);
        }
        for (const [index, result] of native.providerResults.entries()) {
          const sample = input.providerCases[index];
          assert.equal(result.file.exists, sample.xml != null, sample.name);
          if (sample.xml != null) assert.deepEqual(await readNativeInput(result.file),
            sample.bytes ? Buffer.from(sample.bytes, 'base64') : Buffer.from(sample.xml), sample.name + ' provider file');
        }
      }
      report.nativeExecutionRecorded = true;
      return { native, output, report };
    } catch (error) {
      report.error = { name: error.name, message: error.message, stack: error.stack };
      throw error;
    } finally {
      await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
  }

  async function readNativeInput(file) {
    assertValidationOutputChild(file.filename);
    const bytes = await readFile(file.filename);
    assert.equal(bytes.length, file.bytes, file.filename);
    assert.equal(sha256(bytes), file.sha256, file.filename);
    return bytes;
  }

  async function recordCandidate(label, observations) {
    assert.match(label, /^[a-zA-Z0-9_.-]+$/u);
    const { output } = await capture();
    await writeFile(path.join(output, 'candidate-' + label + '.json'), JSON.stringify(observations,
      (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
  }

  async function compareLayouts() {
    const { native } = await capture();
    const rows = localXml ? native.parserResults : native.results;
    const project = localXml ? functionalXmlReader : functionalEpisode;
    const observations = layoutRelations.map(relation => {
      const variant = rows.find(row => row.name === relation.name && (row.type ?? null) === relation.type);
      const baseline = rows.find(row => row.name === relation.originalName && (row.type ?? null) === relation.type);
      assert.ok(variant && baseline, relation.name);
      return { ...relation, observedEquivalent: isDeepStrictEqual(project(variant), project(baseline)),
        variant: project(variant), baseline: project(baseline) };
    });
    await recordCandidate('native-layout-relations', observations);
    for (const observation of observations) assert.equal(observation.observedEquivalent, observation.equivalent,
      observation.name + '/' + (observation.type ?? 'Episode') + ' functional layout relation');
  }
  return { profile, input, baseInput, layoutInput, capture, readNativeInput, recordCandidate, compareLayouts };
}
