import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validationFileUrl } from '../../tools/validation/paths.js';
import { verifyNativeReferencePreparation } from './native-identity-reference-preparation.js';
import { nativeIdentityExecutables, verifyNativeIdentityRecordingBinding,
  verifyNativeIdentitySourceBindings } from './native-identity-inputs.js';
import { evidenceRootState, resolveEvidenceFile, jsonEvidenceFile, identityRecorderName, nativeIdentityArtifactPaths, assertNativeIdentityArtifactManifest, assertNativeIdentityLaunchBinding } from './native-identity-evidence-contract.js';
export { identityRecorderName, nativeIdentityArtifactPaths, assertNativeIdentityArtifactManifest,
  assertNativeIdentityLaunchBinding } from './native-identity-evidence-contract.js';

const fixtureUserId = '5c6b5f77-bea9-4a9a-98aa-fae5909892b7';
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function assertInvocation(actual, expected, label) {
  assert.equal(actual?.kind, expected.kind, `${label}: invocation kind`);
  assert.equal(actual?.mode, expected.mode, `${label}: invocation mode`);
  assert.equal(actual?.runName, expected.runName, `${label}: invocation run name`);
  assert.equal(actual?.evidenceName, expected.evidenceName, `${label}: invocation evidence root`);
  assert.equal(actual?.outputRoot, expected.evidenceName, `${label}: invocation output root`);
  assert.equal(actual?.recorderName, expected.recorderName, `${label}: invocation recorder`);
  assert.ok(Number.isInteger(actual?.loopbackPort) && actual.loopbackPort > 0,
    `${label}: invocation loopback port`);
}

export async function verifyNativeIdentityEvidence({ evidenceRoot, kind, evidenceName, expectedRunModes }) {
  await verifyNativeIdentitySourceBindings();
  await verifyNativeIdentityRecordingBinding({ evidenceRoot, kind, evidenceName, expectedRunModes });
  const rootState = await evidenceRootState(evidenceRoot);
  const oracle = await jsonEvidenceFile(rootState, 'oracle-validation.json');
  const label = `${evidenceName}:oracle`;
  assert.equal(oracle.schemaVersion, 2, `${label}: schema`);
  assert.equal(oracle.candidateVerified, false, `${label}: native-only evidence`);
  assert.equal(oracle.kind, kind, `${label}: kind`);
  assert.equal(oracle.evidenceName, evidenceName, `${label}: evidence name`);
  assert.deepEqual(oracle.expectedRunModes, expectedRunModes, `${label}: declared run binding`);
  assert.deepEqual(Object.keys(oracle.runs), Object.keys(expectedRunModes), `${label}: complete ordered run set`);
  assert.equal(oracle.complete, true, `${label}: complete`);
  assert.equal(oracle.runBindingsValid, true, `${label}: run bindings`);
  assert.equal(oracle.passed, true, `${label}: passed`);

  const currentRecorder = validationFileUrl('../../tools/compat/record-identity-side-effects.js', import.meta.url);
  const currentDll = nativeIdentityExecutables.jellyfinDll;
  const [currentRecorderSha256, currentDllSha256] = await Promise.all([
    readFile(currentRecorder).then(sha256), readFile(currentDll).then(sha256),
  ]);

  for (const [runName, mode] of Object.entries(expectedRunModes)) {
    const runLabel = `${evidenceName}:${runName}`;
    const binding = oracle.runs[runName];
    const recorderName = identityRecorderName(evidenceName, mode);
    const expectedArtifactPaths = nativeIdentityArtifactPaths(evidenceName, runName, mode);
    assert.equal(binding?.passed, true, `${runLabel}: aggregate passed`);
    assert.equal(binding?.kind, kind, `${runLabel}: aggregate kind`);
    assert.equal(binding?.mode, mode, `${runLabel}: aggregate mode`);
    assert.equal(binding?.runName, runName, `${runLabel}: aggregate run name`);
    assert.equal(binding?.evidenceName, evidenceName, `${runLabel}: aggregate evidence name`);
    assert.equal(binding?.recorder, recorderName, `${runLabel}: code-owned recorder path`);
    assertInvocation(binding.invocation, { kind, mode, runName, evidenceName, recorderName }, `${runLabel}:aggregate`);
    await assertNativeIdentityArtifactManifest({ evidenceRoot: rootState.root,
      artifacts: binding.artifactManifest, expectedPaths: expectedArtifactPaths });
    assert.deepEqual({
      nativeHttpSha256: binding.artifactManifest[2].sha256,
      stagesSha256: binding.artifactManifest[3].sha256,
      summarySha256: binding.artifactManifest[4].sha256,
      referencePreparationSha256: binding.artifactManifest[1].sha256,
    }, binding.artifacts, `${runLabel}: legacy digest binding`);
    assert.equal(binding.artifactManifest[0].sha256, binding.recorderSha256,
      `${runLabel}: recorder manifest binding`);

    const [summary, preparation] = await Promise.all([
      jsonEvidenceFile(rootState, `${runName}/summary.json`),
      jsonEvidenceFile(rootState, `${runName}/reference-preparation.json`),
    ]);
    const sourceDatabase = (await resolveEvidenceFile(rootState, `${runName}/reference/initial.db`)).filename;
    const referencePreparation = await verifyNativeReferencePreparation({
      preparation,
      profile: 'http-filter',
      sourceDatabase,
      fixtureUserId,
    });
    assert.equal(summary.passed, true, `${runLabel}: summary passed`);
    assert.equal(summary.kind, kind, `${runLabel}: summary kind`);
    assert.equal(summary.mode, mode, `${runLabel}: summary mode`);
    assert.equal(summary.runName, runName, `${runLabel}: summary run name`);
    assert.equal(summary.evidenceName, evidenceName, `${runLabel}: summary evidence name`);
    assert.equal(summary.recorderSha256, binding.recorderSha256, `${runLabel}: recorder digest binding`);
    assert.equal(summary.sourceDatabaseSha256, binding.sourceDatabaseSha256,
      `${runLabel}: source database digest binding`);
    assert.equal(summary.dllSha256, binding.dllSha256, `${runLabel}: DLL digest binding`);
    assert.equal(summary.dotnetSha256, binding.dotnetSha256, `${runLabel}: dotnet digest binding`);
    assert.equal(summary.ffmpegSha256, binding.ffmpegSha256, `${runLabel}: ffmpeg digest binding`);
    assert.deepEqual(summary.checks, binding.checks, `${runLabel}: checks binding`);
    assert.deepEqual(summary.launch, binding.launch, `${runLabel}: launch binding`);
    assertInvocation(summary.invocation, { kind, mode, runName, evidenceName, recorderName }, `${runLabel}:summary`);
    assert.equal(currentRecorderSha256, binding.recorderSha256, `${runLabel}: current recorder digest`);
    assert.equal(currentDllSha256, binding.dllSha256, `${runLabel}: current Jellyfin DLL digest`);
    assert.equal(preparation.sourceDatabaseSha256, binding.sourceDatabaseSha256,
      `${runLabel}: preparation source database binding`);
    assert.equal(referencePreparation.sourceDatabase.sha256, binding.sourceDatabaseSha256,
      `${runLabel}: bundled run source database digest`);
    assertNativeIdentityLaunchBinding({ launch: summary.launch, referencePreparation, hashes: binding,
      label: runLabel });
    assert.equal(summary.processResult?.code, 0, `${runLabel}: clean exit code`);
    assert.equal(summary.processResult?.signal, null, `${runLabel}: clean exit signal`);
    assert.equal(summary.pidGone, true, `${runLabel}: pid gone`);
    assert.equal(summary.portAvailable, true, `${runLabel}: port released`);
    assert.equal(summary.cleanShutdown, true, `${runLabel}: clean shutdown`);
    assert.equal(summary.checks?.sourceUnchanged, true, `${runLabel}: source before/after gate`);
    assert.equal(summary.checks?.runtimeInputsUnchanged, true, `${runLabel}: runtime inputs unchanged`);
    assert.equal(summary.checks?.launchBound, true, `${runLabel}: launch bound`);
    assert.ok(Object.values(summary.checks).every(Boolean), `${runLabel}: all summary checks`);
  }

  if (oracle.winnerCoverage?.required) {
    assert.deepEqual([...oracle.winnerCoverage.winners].sort(), ['Mirror/A', 'Mirror:A'],
      `${label}: both collision winners`);
  }
  assert.equal(oracle.winnerCoverage?.passed, true, `${label}: winner coverage`);
  return oracle;
}

export function assertCandidateIdentityMatchesNative(candidateId, nativeId, label) {
  assert.equal(idKey(candidateId), idKey(nativeId), `${label}: candidate identity differs from native evidence`);
}

export function verifyIdentityMismatchNegativeControl() {
  assert.doesNotThrow(() => assertCandidateIdentityMatchesNative(
    '11111111-1111-1111-1111-111111111111', '11111111111111111111111111111111', 'matching-control'));
  assert.throws(() => assertCandidateIdentityMatchesNative(
    '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'tampered-control'),
  /candidate identity differs from native evidence/u);
  return true;
}
