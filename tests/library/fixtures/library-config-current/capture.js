import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { compileOracle } from '../../../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';
import { mutationObservation, mutationAccessExpectation } from './observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const root = new URL('./', import.meta.url);
const inputUrl = new URL('../library-configuration-mutations/input.json', root);
const profileUrl = new URL('./current-profile.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
let pending;
export const currentLibraryMutations = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8')), originalBytes = await readFile(inputUrl);
  const original = JSON.parse(originalBytes);
  assert.equal(original.length, 59);
  const controls = original.filter(sample => sample.lockOptions || sample.lockDelete).map(sample => ({
    ...sample, key: sample.key + '-accessible-control', lockOptions: false, lockDelete: false,
  }));
  assert.equal(controls.length, 2);
  const input = [...original, ...controls];
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'library-config-current-' + randomUUID()));
  await mkdir(output);
  const report = { schemaVersion: 1, kind: profile.kind, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    historicalRecordingReused: false, nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  const project = fileURLToPath(new URL('Oracle.csproj', root));
  try {
    assert.equal(profile.kind, 'same-workflow-current-native-library-mutations');
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
    async function verifyNative(record, filename, inputBytes, samples) {
      const bytes = await readFile(filename), native = JSON.parse(bytes);
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.inputSha256, hash(inputBytes));
      for (const flag of ['actualLibraryManager', 'actualLibraryOptionsStore', 'actualXmlSerializer', 'realFiles',
        'structuralRootsControlled', 'providerMonitorTaskManagerControlled', 'fileEnumerationControlled']) assert.equal(native[flag], true);
      assert.deepEqual(native.results.map(row => row.key), samples.map(sample => sample.key));
      for (const name of ['Emby.Server.Implementations', 'MediaBrowser.Controller', 'MediaBrowser.Model'])
        assert.ok(native.assemblies.some(assembly => assembly.name === name), name);
      for (const assembly of native.assemblies)
        assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
      for (const row of native.results) {
        assertValidationOutputChild(row.state);
        for (const file of row.files) {
          const filename = assertValidationOutputChild(path.join(row.views, file.path));
          assert.deepEqual(await readFile(filename), Buffer.from(file.bytes, 'base64'), row.key + ':' + file.path);
        }
      }
      return native;
    }
    const inputFile = path.join(output, 'consumer-input.json'), inputBytes = Buffer.from(json(input));
    await writeFile(inputFile, inputBytes, { flag: 'wx' });
    report.originalInput = { filename: fileURLToPath(inputUrl), bytes: originalBytes.length, sha256: hash(originalBytes) };
    report.consumerInput = await describeFile(inputFile);
    const oracle = await compileOracle({ project, output: path.join(output, 'build') });
    report.oracleBuild = oracle.buildRecord;
    const runs = [];
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await oracle.record({ output: directory, args: [inputFile, '{output}/states', '{output}/native.json'] });
      const filename = path.join(directory, 'native.json');
      const native = await verifyNative(record, filename, inputBytes, input);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      for (const sample of original.filter(value => value.lockOptions || value.lockDelete)) {
        const row = native.results.find(value => value.key === sample.key);
        const control = native.results.find(value => value.key === sample.key + '-accessible-control');
        assert.deepEqual(mutationObservation(row), mutationAccessExpectation(control, sample, row.admission, native.defaultLibraryOptions),
          sample.key + ': Native own admission and independent accessible control');
        const heldName = sample.lockOptions ? 'options.xml' : 'locked.bin';
        const before = row.beforeFiles.find(file => path.basename(file.path) === heldName);
        assert.ok(before);
        if (row.admission.read.succeeded) assert.equal(row.admission.read.bytes, before.bytes);
        if (!row.admission.operation.succeeded) {
          const after = row.files.find(file => file.path === before.path);
          assert.ok(after); assert.equal(after.bytes, before.bytes, sample.key + ': refusal retains the exact original bytes');
        }
      }
      runs.push({ native, record });
    }
    const comparable = run => run.native.results.filter(row => !original.some(sample => sample.key === row.key
      && (sample.lockOptions || sample.lockDelete))).map(mutationObservation);
    assert.deepEqual(comparable(runs[1]), comparable(runs[0]), 'Independent Native controls and all unheld mutations agree.');
    report.nativeExecutionRecorded = true;
    const finalBuild = await verifyNativeBuild(); assert.equal(finalBuild.identitySha256, build.identitySha256);
    return { output, input, original, native: runs[0].native, repeat: runs[1].native, record: runs[0].record,
      async consume(states) {
        const samples = input.filter(sample => states.has(sample.key)).map(sample => ({ ...sample, consumerState: states.get(sample.key) }));
        assert.equal(samples.length, states.size);
        for (const sample of samples) assertValidationOutputChild(sample.consumerState);
        const bytes = Buffer.from(json(samples)), filename = path.join(output, 'native-consumer-input.json');
        await writeFile(filename, bytes, { flag: 'wx' });
        const directory = path.join(output, 'native-cold-reader');
        const record = await oracle.record({ output: directory, args: [filename, '{output}/unused-state', '{output}/native.json'] });
        const outputFile = path.join(directory, 'native.json'), native = await verifyNative(record, outputFile, bytes, samples);
        await writeFile(path.join(output, 'native-cold-reader-receipt.json'), json({
          input: await describeFile(filename), record, observation: await describeFile(outputFile),
          actualNativeReaders: true, phaseAcceptance: false, releaseAcceptance: false,
        }), { flag: 'wx' });
        const after = await verifyNativeBuild(); assert.equal(after.identitySha256, build.identitySha256);
        return native;
      },
    };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
