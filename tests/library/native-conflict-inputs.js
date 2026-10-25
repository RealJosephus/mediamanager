import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertIsolatedOutput, repositoryRoot, validationFileUrl } from '../../tools/validation/paths.js';
import { nativeIdentityBinding, verifyNativeIdentitySourceBindings } from './native-identity-inputs.js';

export const nativeConflictBinding = JSON.parse(await readFile(
  new URL('./fixtures/native-conflict-inputs/binding.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const expectedCases = ['blocked-file', 'first-normalized-name', 'same-path-name', 'wrong-type-id'];
const artifactPaths = ['record-native.mjs', 'native-http.json', 'stages.json', 'provenance.json',
  'discovery/identities.json', 'discovery/shutdown.json', 'native-run/shutdown.json'];

async function verifyFile(descriptor) {
  const filename = path.resolve(descriptor.filename);
  const [metadata, resolved, bytes] = await Promise.all([lstat(filename), realpath(filename), readFile(filename)]);
  assert.equal(metadata.isSymbolicLink(), false, 'A native conflict input cannot be a link.');
  assert.equal(metadata.isFile(), true, 'A native conflict input must be a regular file.');
  assert.equal(filename, resolved, 'A native conflict input cannot resolve through a link.');
  assert.equal(bytes.length, metadata.size);
  if (descriptor.size !== undefined) assert.equal(bytes.length, descriptor.size);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(sha256(bytes), descriptor.sha256, 'Native conflict input digest: ' + filename);
  return bytes;
}

export function nativeConflictRecording(kind, binding = nativeConflictBinding) {
  assert.ok(['artist', 'studio'].includes(kind));
  const recordings = binding.recordings.filter(entry => entry.kind === kind);
  assert.equal(recordings.length, 1);
  return recordings[0];
}

export async function verifyNativeConflictSourceBindings(binding = nativeConflictBinding) {
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.completeBuildInputClosure, false);
  assert.equal(binding.releaseAcceptance, false);
  for (const name of ['reference', 'preparationInputFiles', 'runtimeDirectory', 'sdkDirectory']) {
    assert.deepEqual(binding[name], nativeIdentityBinding[name]);
  }
  const audit = JSON.parse(await verifyFile(binding.independentNativeAudit));
  assert.equal(audit.passed, true);
  assert.deepEqual(binding.recordings.map(entry => entry.kind), ['artist', 'studio']);
  for (const recording of binding.recordings) {
    const measured = audit.conflicts.find(entry => entry.kind === recording.kind);
    assert.ok(measured);
    assert.equal(measured.rawFourCompleteResponsesEqual, true);
    assert.equal(measured.all72ByNameCellsEqualExceptCreationClocks, true);
    assert.deepEqual(recording.repetitions, measured.repetitions.map(({ filename, entriesSha256 }) => ({ filename, entriesSha256 })));
    assert.equal(recording.repetitions.length, 2);
    assert.deepEqual(recording.currentPhysicalTables, measured.repetitions[0].allPhysicalTables);
    assert.equal(recording.currentPhysicalTables.length, 33);
    assert.equal(recording.logicalRoot, '.test-input/evidence/native-conflict-inputs/' + recording.kind + '-restoration-v1');
    assert.equal(recording.cases, 4);
    assert.deepEqual(recording.expectedCases, expectedCases);
    assert.deepEqual(recording.artifacts.map(entry => entry.path), artifactPaths);
    await verifyFile(recording.originalRecorder);
    const input = {};
    for (const descriptor of recording.artifacts) {
      input[descriptor.path] = await verifyFile({ ...descriptor,
        filename: path.join(recording.repetitions[0].filename, descriptor.path) });
    }
    assert.equal(sha256(input['record-native.mjs']), recording.originalRecorder.sha256);
    const provenance = JSON.parse(input['provenance.json']);
    assert.equal(provenance.nativeIdsMeasuredFromActualNativeRequestsAndSQLiteDelta, true);
    assert.equal(provenance.candidateIdentityAlgorithmAbsent, true);
    assert.deepEqual(provenance.preparation, recording.preparation);
    assert.deepEqual(provenance.preparation.inputs.map(entry => [entry.kind, entry.path]), binding.reference.preparationInputs);
    assert.deepEqual(provenance.executableBindings, recording.executableBindings);
    assert.deepEqual(provenance.libraryManagerSource, recording.libraryManagerSource);
    await verifyFile(recording.libraryManagerSource);
    for (const descriptor of recording.executableBindings) await verifyFile(descriptor);
    assert.deepEqual(JSON.parse(input['discovery/identities.json']).identities, recording.nativeMeasuredIdentities);
    const response = JSON.parse(input['native-http.json']);
    assert.deepEqual(response.records.map(entry => entry.name), expectedCases);
    for (const entry of response.records) assert.equal(entry.response.status, 200);
  }
  await verifyNativeIdentitySourceBindings();
  return true;
}

export async function verifyNativeConflictRecording(kind, binding = nativeConflictBinding) {
  await verifyNativeConflictSourceBindings(binding);
  const recording = nativeConflictRecording(kind, binding);
  for (const repetition of recording.repetitions) {
    const directory = path.resolve(repetition.filename);
    const metadata = await lstat(directory);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(await realpath(directory), directory);
    assert.equal((await describeFile(directory)).entriesSha256, repetition.entriesSha256);
  }
  const root = validationFileUrl(path.resolve(repositoryRoot, recording.logicalRoot) + path.sep);
  assert.equal(fileURLToPath(root), path.resolve(recording.repetitions[0].filename) + path.sep);
  const reference = JSON.parse(await readFile(new URL('native-http.json', root), 'utf8'));
  const stages = JSON.parse(await readFile(new URL('stages.json', root), 'utf8'));
  for (const name of ['before', ...expectedCases]) {
    assert.deepEqual(Object.keys(stages[name].fullDatabase.tables), recording.currentPhysicalTables);
    const rows = stages[name].fullDatabase.tables.BaseItems;
    for (const watched of stages[name].database.watchedRows) {
      assert.deepEqual(rows.find(row => idKey(row.Id) === idKey(watched.id)) ?? null, watched.row);
      assert.equal(idKey(watched.id), idKey(recording.nativeMeasuredIdentities[watched.name].Id));
    }
  }
  return { recording, reference, stages };
}

export function assertNativeConflictOutput(filename, environment = process.env) {
  const directories = [nativeConflictBinding.runtimeDirectory.filename, nativeConflictBinding.sdkDirectory.filename,
    path.dirname(nativeConflictBinding.reference.sourceDatabase.filename),
    path.dirname(nativeConflictBinding.independentNativeAudit.filename),
    ...nativeConflictBinding.recordings.flatMap(recording => recording.repetitions.map(entry => entry.filename))];
  for (const directory of new Set(directories)) {
    assertIsolatedOutput(filename, { ...environment, MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT: directory });
  }
  return filename;
}
