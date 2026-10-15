import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertIsolatedOutput } from '../../tools/validation/paths.js';

export const nativeIdentityBinding = JSON.parse(await readFile(
  new URL('./fixtures/native-identity-inputs/binding.json', import.meta.url), 'utf8'));
export const nativeIdentityReference = nativeIdentityBinding.reference;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function resolveNativeIdentityInput(filename) {
  assert.ok(nativeIdentityReference.preparationInputs.some(([, expected]) => expected === filename),
    'Native identity preparation must use the exact independently audited input allowlist.');
  return path.resolve(repositoryRoot, filename);
}

export const nativeIdentityExecutables = {
  dotnet: resolveNativeIdentityInput(nativeIdentityReference.preparationInputs[8][1]),
  jellyfinDll: resolveNativeIdentityInput(nativeIdentityReference.preparationInputs[9][1]),
  ffmpeg: resolveNativeIdentityInput(nativeIdentityReference.preparationInputs[10][1]),
};

async function verifyFile(descriptor) {
  const filename = path.resolve(descriptor.filename);
  const [metadata, resolved] = await Promise.all([lstat(filename), realpath(filename)]);
  assert.equal(metadata.isSymbolicLink(), false, 'A native identity input cannot be a link.');
  assert.equal(metadata.isFile(), true, 'A native identity input must be a regular file.');
  assert.equal(resolved, filename, 'A native identity input cannot resolve through a link.');
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  const bytes = await readFile(filename);
  assert.equal(bytes.length, metadata.size);
  assert.equal(sha256(bytes), descriptor.sha256, 'Native identity input digest: ' + filename);
  return bytes;
}

export async function verifyNativeIdentitySourceBindings(binding = nativeIdentityBinding) {
  await verifyFile(binding.reference.sourceDatabase);
  assert.equal(binding.preparationInputFiles.length, 11);
  for (const [index, descriptor] of binding.preparationInputFiles.entries()) {
    assert.equal(path.resolve(descriptor.filename),
      path.resolve(repositoryRoot, binding.reference.preparationInputs[index][1]));
    await verifyFile(descriptor);
  }
  assert.equal(binding.independentNativeAudits.length, 2);
  for (const descriptor of binding.independentNativeAudits) {
    const audit = JSON.parse(await verifyFile(descriptor));
    assert.equal(audit.passed, true);
    assert.equal(audit.repetitions, 2);
    assert.equal(audit.nativeModesPerRepetition, 14);
    assert.equal(audit.completeHttpResponsesPerRepetition, 90);
    assert.equal(audit.stoppedNativeNewIdentityAll72CellsVerified, true);
    assert.equal(audit.originalBaseItemsAllCellsRetained, true);
    assert.equal(audit.runtimeEntriesSha256, binding.runtimeDirectory.entriesSha256);
    assert.deepEqual(audit.directories, binding.recordings.flatMap(recording => recording.repetitions)
      .sort((left, right) => audit.directories.findIndex(entry => entry.filename === left.filename)
        - audit.directories.findIndex(entry => entry.filename === right.filename)));
  }
  for (const descriptor of [binding.runtimeDirectory, binding.sdkDirectory]) {
    const current = await describeFile(descriptor.filename);
    assert.equal(current.kind, 'directory');
    assert.equal(current.available, true);
    assert.equal(current.entriesSha256, descriptor.entriesSha256,
      'Native identity executable directory digest: ' + descriptor.filename);
  }
}

export async function verifyNativeIdentityRecordingBinding({ evidenceRoot, kind, evidenceName, expectedRunModes },
  binding = nativeIdentityBinding) {
  const recording = binding.recordings.find(entry => entry.evidenceName === evidenceName);
  assert.ok(recording, 'The native identity recording must be explicitly bound.');
  assert.equal(recording.kind, kind);
  assert.deepEqual(recording.expectedRunModes, expectedRunModes);
  const filename = path.resolve(evidenceRoot instanceof URL ? fileURLToPath(evidenceRoot) : evidenceRoot);
  const descriptor = recording.repetitions.find(entry => path.resolve(entry.filename) === filename);
  assert.ok(descriptor, 'The native identity recording root must be independently audited.');
  const current = await describeFile(filename);
  assert.equal(current.kind, 'directory');
  assert.equal(current.available, true);
  assert.equal(current.entriesSha256, descriptor.entriesSha256, 'Native identity recording directory digest.');
}

export function assertNativeIdentityOutput(filename, environment = process.env) {
  const directories = [nativeIdentityBinding.runtimeDirectory.filename, nativeIdentityBinding.sdkDirectory.filename,
    path.dirname(nativeIdentityReference.sourceDatabase.filename),
    ...nativeIdentityBinding.recordings.flatMap(recording => recording.repetitions.map(entry => entry.filename)),
    ...nativeIdentityBinding.independentNativeAudits.map(entry => path.dirname(entry.filename))];
  for (const directory of new Set(directories)) {
    assertIsolatedOutput(filename, { ...environment, MEDIAMANAGER_IDENTITY_INPUT_ROOT: directory });
  }
  return filename;
}
