import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeModel } from '../../src/database/model.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertIsolatedOutput, repositoryRoot, validationFileUrl } from '../../tools/validation/paths.js';
import { nativeIdentityBinding, verifyNativeIdentitySourceBindings } from '../library/native-identity-inputs.js';

export const syncplayDateImpactBinding = JSON.parse(await readFile(
  new URL('./fixtures/syncplay/date-impact-inputs/binding.json', import.meta.url), 'utf8'));
const inputRoot = validationFileUrl('../../.agent-docs/evidence/syncplay-date-impact-inputs/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactPaths = ['record-native.mjs', 'scenario.js', 'native-run/native-http.json', 'native-run/native-contract.json',
  'native-run/database-stages.json', 'native-run/summary.json', 'native-run/reference-stdout.log', 'native-run/reference-stderr.log'];
const expectedCases = ['minimum-minus-14-playing', 'minimum-minus-14-paused', 'minimum-utc-playing', 'minimum-utc-paused',
  'inside-two-second-guard', 'outside-two-second-guard'];

async function verifyFile(descriptor) {
  const filename = path.resolve(descriptor.filename);
  const [metadata, resolved, bytes] = await Promise.all([lstat(filename), realpath(filename), readFile(filename)]);
  assert.equal(metadata.isSymbolicLink(), false); assert.equal(metadata.isFile(), true);
  assert.equal(resolved, filename); assert.equal(bytes.length, metadata.size);
  if (descriptor.size !== undefined) assert.equal(bytes.length, descriptor.size);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(sha(bytes), descriptor.sha256, filename);
  return bytes;
}

export function resolveSyncPlayDatePreparationInput(filename, binding = syncplayDateImpactBinding) {
  assert.ok(binding.reference.preparationInputs.some(([, expected]) => expected === filename),
    'SyncPlay native preparation requires the exact independently bound input allowlist.');
  return path.resolve(repositoryRoot, filename);
}

export function assertSyncPlayDateManifestBinding(manifest, sourceSummary = syncplayDateImpactBinding.recordings[0].sourceSummary) {
  assert.equal(manifest.head, sourceSummary.baselineHead);
  assert.equal(manifest.contentDigest, sourceSummary.baselineContentDigest);
}

export async function verifySyncPlayDatePreparation(candidate, index = 0, binding = syncplayDateImpactBinding) {
  assert.deepEqual({ initializedFromEmpty: candidate.initializedFromEmpty, createdThroughNativeApi: candidate.createdThroughNativeApi,
    sourceStopped: candidate.sourceStopped }, { initializedFromEmpty: true, createdThroughNativeApi: true, sourceStopped: true });
  assert.deepEqual(candidate.inputs.map(entry => [entry.kind, entry.path]), binding.reference.preparationInputs);
  assert.deepEqual(candidate, binding.recordings[index].referencePreparation);
  for (const entry of candidate.inputs) await verifyFile({ filename: resolveSyncPlayDatePreparationInput(entry.path, binding), sha256: entry.sha256 });
}

export async function verifySyncPlayDateArtifactHashes(candidate, index = 0, binding = syncplayDateImpactBinding) {
  const recording = binding.recordings[index];
  assert.deepEqual(candidate.artifacts.map(entry => entry.path), artifactPaths);
  assert.deepEqual(candidate.artifacts, recording.artifacts);
  for (const entry of candidate.artifacts) {
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
    await verifyFile({ ...entry, filename: path.join(recording.filename, entry.path) });
  }
}

export function assertSyncPlayDatePersistenceWindow(stages) {
  const names = nativeModel.tables.map(table => table.name).sort();
  for (const name of ['afterAuthentication', 'afterCases', 'afterShutdown']) {
    assert.deepEqual(stages[name].tables.map(table => table.name), names);
    assert.deepEqual(stages[name].foreignKeyCheck, []);
  }
  assert.deepEqual(stages.afterAuthentication.tables, stages.afterCases.tables);
  const activity = name => stages[name].tables.find(table => table.name === 'ActivityLogs');
  assert.equal(activity('afterShutdown').rows, activity('afterCases').rows + 2);
  assert.notDeepEqual(stages.afterCases.tables, stages.afterShutdown.tables);
  assert.deepEqual(stages.afterCases.tables.filter(table => table.name !== 'ActivityLogs'),
    stages.afterShutdown.tables.filter(table => table.name !== 'ActivityLogs'));
}

export async function verifySyncPlayDateSourceBindings(binding = syncplayDateImpactBinding) {
  assert.equal(binding.schemaVersion, 1);
  for (const name of ['nativePidIdentitySealed', 'actualFfmpegLaunchSealed', 'completeBuildInputClosure', 'releaseAcceptance']) assert.equal(binding[name], false);
  for (const name of ['reference', 'preparationInputFiles', 'runtimeDirectory', 'sdkDirectory']) assert.deepEqual(binding[name], nativeIdentityBinding[name]);
  assert.equal(binding.recordings.length, 2);
  const audit = JSON.parse(await verifyFile(binding.independentNativeAudit));
  assert.equal(audit.passed, true);
  const projection = JSON.parse(await verifyFile(binding.historicalProjection));
  assert.equal(projection.phaseAcceptance, false);
  assert.deepEqual(projection.contract.cases.map(entry => entry.name), expectedCases);
  await verifyFile(binding.originalRecorder); await verifyFile(binding.originalScenario);
  const sourceNames = ['waitingGroupStateSha256', 'groupSha256', 'syncPlayControllerSha256'];
  assert.equal(binding.nativeSources.length, sourceNames.length);
  for (const [index, recording] of binding.recordings.entries()) {
    const measured = audit.syncplay[index];
    assert.equal(recording.filename, measured.filename); assert.equal(recording.entriesSha256, measured.entriesSha256);
    assert.equal(measured.cases, 6); assert.equal(measured.completeContractEqualsRetainedProjection, true);
    assert.equal(measured.artifactsAndCurrentPreparationFilesVerified, true); assert.equal(measured.portIndependentlyAbsent, true);
    assert.equal(measured.nativePidIdentitySealed, false); assert.equal(measured.actualFfmpegLaunchSealed, false);
    assert.equal(recording.logicalRoot, '.agent-docs/evidence/syncplay-date-impact-inputs/restoration-v' + (index + 1) + '/syncplay-date-impact-native-v1');
    assert.deepEqual(recording.databaseDigestTables, nativeModel.tables.map(table => table.name).sort());
    for (const [sourceIndex, descriptor] of binding.nativeSources.entries()) {
      assert.equal(descriptor.sha256, recording.sourceSummary[sourceNames[sourceIndex]]);
      assert.equal(descriptor.sha256, projection.nativeSource[sourceNames[sourceIndex]]);
      await verifyFile(descriptor);
    }
    assert.equal(recording.sourceSummary.sourceDatabaseSha256, binding.reference.sourceDatabase.sha256);
    assert.equal(recording.sourceSummary.jellyfinDllSha256, binding.preparationInputFiles[9].sha256);
    assert.equal(recording.sourceSummary.dotnetSha256, binding.preparationInputFiles[8].sha256);
    assert.equal(recording.sourceSummary.baselineManifestSha256, binding.preparationInputFiles[6].sha256);
    assertSyncPlayDateManifestBinding(JSON.parse(await verifyFile(binding.preparationInputFiles[6])), recording.sourceSummary);
    await verifySyncPlayDatePreparation(recording.referencePreparation, index, binding);
  }
  await verifyNativeIdentitySourceBindings();
  return true;
}

export async function loadSyncPlayDateRecording(index = 0, binding = syncplayDateImpactBinding) {
  assert.ok(index === 0 || index === 1);
  const recording = binding.recordings[index];
  const metadata = await lstat(recording.filename);
  assert.equal(metadata.isSymbolicLink(), false); assert.equal(metadata.isDirectory(), true);
  assert.equal(await realpath(recording.filename), path.resolve(recording.filename));
  assert.equal((await describeFile(recording.filename)).entriesSha256, recording.entriesSha256);
  const directory = new URL('restoration-v' + (index + 1) + '/syncplay-date-impact-native-v1/', inputRoot);
  assert.equal(fileURLToPath(directory), path.resolve(recording.filename) + path.sep);
  const read = relative => readFile(new URL(relative, directory), 'utf8').then(JSON.parse);
  const provenance = JSON.parse(await verifyFile(recording.provenance));
  assert.deepEqual(provenance.sourceSummary, recording.sourceSummary);
  assert.deepEqual(provenance.referencePreparation, recording.referencePreparation);
  assert.equal(provenance.recorder.sha256, binding.originalRecorder.sha256);
  assert.equal(provenance.scenario.sha256, binding.originalScenario.sha256);
  await verifySyncPlayDateArtifactHashes(provenance, index, binding);
  const [contract, raw, stages, summary] = await Promise.all(['native-contract.json', 'native-http.json', 'database-stages.json', 'summary.json']
    .map(name => read('native-run/' + name)));
  const historical = JSON.parse(await verifyFile(binding.historicalProjection));
  assert.deepEqual(contract, historical.contract);
  assert.deepEqual(raw.cases.map(entry => entry.name), expectedCases);
  assertSyncPlayDatePersistenceWindow(stages);
  return { recording, provenance, contract, raw, stages, summary };
}

export function assertSyncPlayDateOutput(filename, environment = process.env) {
  for (const directory of [path.dirname(syncplayDateImpactBinding.reference.sourceDatabase.filename),
    path.dirname(syncplayDateImpactBinding.independentNativeAudit.filename), syncplayDateImpactBinding.runtimeDirectory.filename,
    syncplayDateImpactBinding.sdkDirectory.filename, ...syncplayDateImpactBinding.recordings.map(entry => entry.filename)]) {
    assertIsolatedOutput(filename, { ...environment, MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT: directory });
  }
  return filename;
}
