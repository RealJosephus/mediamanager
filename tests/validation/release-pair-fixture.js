import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import capturedShape from './fixtures/release-pair/runner-shape.json' with { type: 'json' };
import { currentInputDigest } from '../../tools/validation/input-receipt.js';

// Synthetic runner receipts for orchestration failure tests only. These are
// never native observations or evidence of actual full/product acceptance.
export const fixtureHead = 'a'.repeat(40);
export const fixtureHash = value => createHash('sha256').update(value).digest('hex');
export const capturedRunnerShape = JSON.parse(gunzipSync(Buffer.from(capturedShape.payload, 'base64')).toString('utf8'));
export const capturedRunnerProvenance = capturedShape;
export const actualRunnerResult = JSON.parse(capturedRunnerShape.raw.result);
export const saveFixture = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n');
export const fixtureScope = (platform = 'linux') => {
  const selected = ['tests/controlled/one.test.js', 'tests/controlled/two.test.js'];
  return { schemaVersion: 1, profile: 'full', releasePair: true, planOnly: false, platform, selected, discovered: [...selected],
    requested: [], excluded: [], infrastructureErrors: [], sharding: { index: 1, total: 1 }, selectionSha256: fixtureHash(JSON.stringify(selected)) };
};

export async function writeRunnerFixture(output, scope, { preflightOnly, candidateText = 'candidate', inputText = 'input', change } = {}) {
  await mkdir(output);
  const entries = [{ path: 'src/controlled.js', available: true, bytes: candidateText.length, sha256: fixtureHash(candidateText) }];
  const candidate = { head: fixtureHead, status: [], entries, entriesSha256: fixtureHash(JSON.stringify(entries)) };
  const input = { schemaVersion: 3, scope: 'Controlled current release fixture only.',
    entries: [{ ...capturedRunnerShape.inputShape.entry, filename: '/controlled/native-input', available: true, required: true,
      bytes: inputText.length, sha256: fixtureHash(inputText) }],
    services: [], tools: [], preflightReady: true, currentReleaseInputReady: true };
  input.entriesSha256 = currentInputDigest(input);
  Object.assign(input, { historicalArchiveComplete: false, historicalArchive: { ledgerSha256: '0'.repeat(64),
    auditStatus: 'valid', profiles: [{ id: 'controlled-history', archiveStatus: 'incomplete' }] } });
  const counts = { tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const registrations = { schemaVersion: 1, files: scope.selected.map(filename => ({ path: filename, registrations: 1 })), missing: [] };
  const result = { ...structuredClone(actualRunnerResult), schemaVersion: 1, profile: 'full', platform: scope.platform,
    outcome: preflightOnly ? 'incomplete' : 'passed', executed: !preflightOnly,
    selected: [...scope.selected], notSelected: [], allDiscoveredSelected: true, missingTests: [], scopeComplete: true,
    candidatePreparationStable: true, inventoryDifferences: [], preflight: { ready: true },
    historicalArchiveComplete: input.historicalArchiveComplete, historicalArchive: structuredClone(input.historicalArchive),
    candidateEntriesSha256: candidate.entriesSha256, currentInputEntriesSha256: input.entriesSha256,
    ...(!preflightOnly ? { exitCode: 0, counts, testRegistrations: registrations, registrationComplete: true,
      candidateUnchanged: true, currentInputUnchanged: true,
      inventoryDifferencesAfter: [], preflightAfter: { ready: true }, currentInputEntriesSha256After: input.entriesSha256,
      historicalArchiveCompleteAfter: input.historicalArchiveComplete,
      historicalArchiveAfter: structuredClone(input.historicalArchive) } : {}) };
  for (const name of ['inputEntriesSha256', 'inputEntriesSha256After', 'inputUnchanged']) delete result[name];
  if (preflightOnly) for (const name of ['command', 'exitCode', 'counts', 'testRegistrations', 'registrationComplete',
    'candidateUnchanged', 'currentInputUnchanged', 'inventoryDifferencesAfter', 'preflightAfter',
    'currentInputEntriesSha256After']) delete result[name];
  const files = { 'result.json': result, 'candidate.json': candidate, 'inputs-before.json': input,
    ...(!preflightOnly ? { 'candidate-after.json': structuredClone(candidate), 'inputs-after.json': structuredClone(input),
      'test-registrations.json': registrations,
      'test.tap': 'TAP version 13\n# Subtest: one\nok 1 - one\n# Subtest: two\nok 2 - two\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', 'stderr.txt': '' } : {}) };
  change?.(files);
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(output, name), name.endsWith('.json') ? JSON.stringify(value, null, 2) + '\n' : value, { flag: 'wx' });
  }
  return { exitCode: preflightOnly ? 2 : 0, timedOut: false, cancelled: false, elapsedMilliseconds: 1 };
}

export async function writePlatformFixture(artifacts, os, platform, runReleasePair) {
  const artifact = path.join(artifacts, `validation-${os}-shard-1-1`);
  const output = path.join(artifact, 'ci-controlled');
  await mkdir(output, { recursive: true });
  const scope = fixtureScope(platform);
  await saveFixture(path.join(output, 'scope.json'), scope);
  await runReleasePair({ scope, output, expectedHead: fixtureHead,
    execute: (directory, options) => writeRunnerFixture(directory, scope, { ...options, candidateText: `candidate-${platform}`, inputText: `input-${platform}` }) });
  const environment = JSON.parse(capturedRunnerShape.raw.environment), audit = JSON.parse(capturedRunnerShape.raw.audit);
  Object.assign(environment.runner, { platform, commit: fixtureHead, runId: '44', attempt: '1' });
  await saveFixture(path.join(artifact, 'environment.json'), environment);
  await saveFixture(path.join(artifact, 'postgres-audit.json'), audit);
  return { artifact, output };
}
