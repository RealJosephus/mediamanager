import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import syncplayDifferences from './fixtures/syncplay/runtime-date-taipei-differences.json' with { type: 'json' };
import syncplayImpact from './fixtures/syncplay/date-impact-native.json' with { type: 'json' };
import candidateReprojection from './fixtures/syncplay/runtime-date-candidate-reprojection.json' with { type: 'json' };
import {
  assertRuntimeDateCandidateReprojection,
  assertSyncPlayRuntimeDateEvidence,
  runtimeDateFixture,
} from './runtime-date-fixture.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

for (const timezone of ['Asia/Taipei', 'Asia/Shanghai']) test(`UserData and SyncPlay select their verified ${timezone} date fixtures in an independent process`, () => {
  const environment = { ...process.env, TZ: timezone };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/sessions/user-data-binding.test.js', 'tests/sessions/syncplay-binding.test.js'], {
    cwd: repositoryRoot, env: environment, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# tests 115$/mu);
  assert.match(result.stdout, /^# pass 115$/mu);
  assert.match(result.stdout, /^# fail 0$/mu);
  assert.match(result.stdout, /^# skipped 0$/mu);
});

test('unknown local timezone cannot silently reuse the Shanghai or Taipei date evidence', () => {
  assert.throws(() => runtimeDateFixture('UTC'), /no verified local environment for UTC/u);
  assert.throws(() => runtimeDateFixture('Asia/Tokyo'), /no verified local environment for Asia\/Tokyo/u);
});

test('SyncPlay runtime-date metadata rejects unbounded persistence and local phase-acceptance claims', () => {
  const corruptions = [
    [impact => { impact.persistence.nativeStableWindow.push('afterShutdown'); }, () => {}],
    [impact => { impact.persistence.nativeAfterShutdownActivityLogDelta = 0; }, () => {}],
    [impact => { impact.phaseAcceptance = true; }, () => {}],
    [() => {}, differences => { differences.phaseAcceptance = true; }],
  ];
  for (const [mutateImpact, mutateDifferences] of corruptions) {
    const impact = structuredClone(syncplayImpact);
    const differences = structuredClone(syncplayDifferences);
    mutateImpact(impact);
    mutateDifferences(differences);
    assert.throws(() => assertSyncPlayRuntimeDateEvidence(impact, differences), assert.AssertionError);
  }
});

test('runtime-date candidate re-projection rejects source-delta and outcome corruption', () => {
  const corruptions = [
    candidate => { candidate.sources.date.currentSha256 = '0'.repeat(64); },
    candidate => { candidate.sources.date.recordedSha256 = '0'.repeat(64); },
    candidate => { candidate.sources.group.removedLeadingText += '// executable-looking drift\n'; },
    candidate => { candidate.input.sha256 = '0'.repeat(64); },
    candidate => { candidate.projection.sha256 = '0'.repeat(64); },
    candidate => { candidate.projection.documentedDifferenceSources.reverse(); },
    candidate => { candidate.phaseAcceptance = true; },
  ];
  assertRuntimeDateCandidateReprojection();
  for (const mutate of corruptions) {
    const corrupted = structuredClone(candidateReprojection);
    mutate(corrupted);
    assert.throws(() => assertRuntimeDateCandidateReprojection(corrupted), assert.AssertionError);
  }
});
