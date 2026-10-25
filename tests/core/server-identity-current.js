import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const fixture = new URL('./fixtures/server-identity/', import.meta.url);
const inputFile = new URL('current/input.json', fixture);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

let pending;
export const currentServerIdentity = () => pending ??= capture();

export async function consumeServerIdentityFiles(samples, output) {
  const { native } = await currentServerIdentity();
  assertValidationOutputChild(output); await mkdir(output);
  const inputs = [];
  for (const sample of samples) {
    const bytes = await readFile(sample.filename), root = path.join(output, sample.name);
    assertValidationOutputChild(root);
    await mkdir(path.join(root, 'data/data'), { recursive: true });
    const filename = path.join(root, 'data/data/device.txt'); await writeFile(filename, bytes, { flag: 'wx' });
    inputs.push({ ...sample, root, bytes: bytes.toString('base64'), source: await describeFile(sample.filename), copy: await describeFile(filename) });
  }
  const input = path.join(output, 'consumer-input.json');
  const inputBytes = Buffer.from(JSON.stringify(inputs, null, 2) + '\n'); await writeFile(input, inputBytes, { flag: 'wx' });
  const directory = path.join(output, 'native-reader');
  const recording = await recordOracle({ project: fileURLToPath(new URL('current-consumer/Oracle.csproj', fixture)),
    output: directory, args: [input, '{output}/native.json'] });
  const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), consumed = JSON.parse(bytes);
  const proof = { inputs, input: await describeFile(input), recording, output: await describeFile(filename), consumed,
    actualNativeRead: true, phaseAcceptance: false, releaseAcceptance: false };
  await writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  assert.equal(recording.passed, true); assert.equal(recording.build.status, 0); assert.equal(recording.process.status, 0);
  assert.equal(recording.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
  assert.equal(consumed.inputSha256, sha(inputBytes));
  assert.equal(consumed.actualDeviceId, true); assert.equal(consumed.actualFiles, true);
  assert.deepEqual(consumed.results.map(row => row.name), samples.map(row => row.name));
  for (const assembly of consumed.assemblies) {
    assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256);
  }
  const deviceAssembly = consumed.assemblies.find(entry => path.basename(entry.filename) === 'Emby.Server.Implementations.dll');
  assert.ok(deviceAssembly);
  assert.equal(deviceAssembly.sha256, native.assemblies.find(entry => path.basename(entry.filename) === 'Emby.Server.Implementations.dll').sha256);
  for (const row of consumed.results) {
    const expected = inputs.find(input => input.name === row.name);
    assert.equal(row.value, expected.serverId, row.name); assert.equal(row.cachedValue, row.value, row.name);
    assert.equal(row.reopenedValue, row.value, row.name); assert.equal(row.validGuid, true, row.name);
    assert.equal(row.beforeBytes, expected.bytes, row.name); assert.equal(row.afterBytes, row.beforeBytes, row.name);
  }
  return proof;
}

async function capture() {
  const profile = JSON.parse(await readFile(new URL('current-profile.json', fixture), 'utf8'));
  const output = path.join(validationOutputRoot(), 'server-identity-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, fixture)));
      assert.equal(actual.available, true, expected.filename);
      assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename);
      report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const project = fileURLToPath(new URL('current/Oracle.csproj', fixture));
    const observations = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project, output: directory, args: [fileURLToPath(inputFile), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      assert.equal(native.actualDeviceId, true); assert.equal(native.actualFiles, true);
      assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
      for (const assembly of native.assemblies) {
        const actual = await describeFile(assembly.filename);
        assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.filename);
      }
      const deviceAssembly = native.assemblies.find(entry => path.basename(entry.filename) === 'Emby.Server.Implementations.dll');
      assert.ok(deviceAssembly);
      assert.equal(deviceAssembly.sha256, (await describeFile(path.join(build.runtime, 'Emby.Server.Implementations.dll'))).sha256);
      observations.push(native);
    }
    report.nativeExecutionRecorded = true;
    return { native: observations[0], repeat: observations[1], record: report.captures[0].record, output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
}
