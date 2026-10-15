import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { assertSyncPlayDateImpactContract, normalizeSyncPlayDateImpact, recordSyncPlayDateImpact } from './syncplay-date-impact-scenario.js';
import { assertRuntimeDateCandidateReprojection } from './runtime-date-fixture.js';
import { seedPostgresRuntime } from './postgres-seed.js';
import { assertValidationOutputChild } from '../../tools/validation/paths.js';
import {
  assertSyncPlayDateManifestBinding, assertSyncPlayDateOutput, assertSyncPlayDatePersistenceWindow,
  loadSyncPlayDateRecording, resolveSyncPlayDatePreparationInput, syncplayDateImpactBinding,
  verifySyncPlayDateArtifactHashes, verifySyncPlayDatePreparation, verifySyncPlayDateSourceBindings,
} from './syncplay-date-impact-inputs.js';

const native = await loadSyncPlayDateRecording();
const trackedProjection = JSON.parse(await readFile(new URL('./fixtures/syncplay/date-impact-native.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviveInteger = (_key, value) => value && typeof value === 'object' && '$integer' in value ? BigInt(value.$integer) : value;
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $integer: item.toString() } : item);

async function scanDatabase(database, needles) {
  const matches = [];
  for (const table of nativeModel.tables) {
    let offset = 0;
    for (;;) {
      const rows = await database.rows(table.name, { limit: 500, offset });
      for (const row of rows) for (const needle of needles) if (stable(row).includes(needle)) matches.push({ table: table.name, needle });
      offset += rows.length;
      if (rows.length < 500) break;
    }
  }
  return matches;
}

test('SyncPlay minimum-year evidence binds both real native recordings and current reference inputs', async () => {
  await verifySyncPlayDateSourceBindings();
  assertRuntimeDateCandidateReprojection();
  assert.equal(sha(await readFile(new URL('../../src/syncplay/group.js', import.meta.url))), trackedProjection.candidateSource.groupSha256);
  assert.equal(sha(await readFile(new URL('../../src/http/json-date-time.js', import.meta.url))), trackedProjection.candidateSource.dateSourceSha256);
  assert.deepEqual(trackedProjection.persistence, { nativeStableWindow: ['afterAuthentication', 'afterCases'],
    nativeCompleteDigestStableInWindow: true, nativeAfterShutdownActivityLogDelta: 2,
    candidateStableWindow: ['afterAuthentication', 'afterCases'], candidateCompleteDigestStableInWindow: true, requestWhenPersisted: false });
  assert.equal(trackedProjection.phaseAcceptance, false);
  for (const index of [0, 1]) {
    const { raw, contract, stages, summary, provenance } = index === 0 ? native : await loadSyncPlayDateRecording(index);
    assertSyncPlayDateImpactContract(normalizeSyncPlayDateImpact(raw), contract);
    assertSyncPlayDateImpactContract(trackedProjection.contract, contract);
    assert.equal(sha(await readFile(syncplayDateImpactBinding.recordings[index].filename + '/native-run/native-contract.json')),
      trackedProjection.sourceEvidenceSha256, 'Fresh native captures preserve the original measured contract bytes.');
    assert.equal(provenance.recorder.sha256, trackedProjection.recorderSha256);
    assert.equal(provenance.scenario.sha256, trackedProjection.scenarioSha256);
    assert.equal(summary.passed, true); assert.equal(summary.behaviorPassed, true); assert.equal(summary.databaseStable, true);
    assert.deepEqual(summary.persistenceMatches, []); assert.equal(summary.foreignKeysPassed, true);
    assert.equal(summary.readiness.startupComplete, true); assert.ok(summary.readiness.consecutiveHttpSuccesses >= 3);
    assert.deepEqual(summary.processResult, { code: 0, signal: null }); assert.equal(summary.pidGone, true);
    assert.equal(summary.portReleased, true); assert.equal(summary.shutdownRecord.status, 204);
    assertSyncPlayDatePersistenceWindow(stages);
    assert.deepEqual(summary.guardDiagnostics.map(entry => entry.guardWarningCount), [1, 1, 1, 1, 0, 1]);
    assert.deepEqual(summary.guardDiagnostics.filter(entry => entry.name !== 'inside-two-second-guard').map(entry => entry.delaySeconds), [0, 0, 0, 0, 0]);
    const inside = summary.guardDiagnostics.find(entry => entry.name === 'inside-two-second-guard').delaySeconds;
    assert.ok(inside < -0.5 && inside > -2);
    assert.deepEqual(raw.cases.map(entry => entry.diagnostic.guardWarningCount), [1, 1, 1, 1, 0, 1]);
    for (const entry of raw.cases) assert.equal(entry.diagnostic.logExcerpt.split('is not time syncing properly. Ignoring elapsed time.').length - 1,
      entry.diagnostic.guardWarningCount);
    assert.ok(contract.cases.every(entry => entry.result.requestWhenEchoed === false));
  }
});

test('SyncPlay evidence comparison and input binding reject injected corruption', async () => {
  for (const mutate of [value => { value.cases[0].result.command = 'Seek'; }, value => { value.cases[1].result.state = 'Waiting'; },
    value => { value.cases[2].result.requestWhenEchoed = true; }]) {
    const changed = structuredClone(native.contract); mutate(changed);
    assert.throws(() => assertSyncPlayDateImpactContract(changed, native.contract), assert.AssertionError);
  }
  for (const mutate of [value => { value.artifacts[0].sha256 = '0'.repeat(64); }, value => { value.artifacts.pop(); },
    value => { value.artifacts[0].size++; }, value => { value.artifacts[0].path = '../outside.json'; }]) {
    const changed = structuredClone(native.provenance); mutate(changed);
    await assert.rejects(() => verifySyncPlayDateArtifactHashes(changed), assert.AssertionError);
  }
  for (const mutate of [value => { value.sourceStopped = false; }, value => { value.inputs.pop(); },
    value => { value.inputs[0].sha256 = '0'.repeat(64); }]) {
    const changed = structuredClone(native.provenance.referencePreparation); mutate(changed);
    await assert.rejects(() => verifySyncPlayDatePreparation(changed), assert.AssertionError);
  }
  for (const mutate of [value => { value.afterCases.tables.find(entry => entry.name === 'ActivityLogs').rows++; },
    value => { value.afterShutdown.tables.find(entry => entry.name === 'ActivityLogs').rows = value.afterCases.tables.find(entry => entry.name === 'ActivityLogs').rows; },
    value => { value.afterShutdown.tables.find(entry => entry.name === 'Users').sha256 = '0'.repeat(64); }]) {
    const changed = structuredClone(native.stages); mutate(changed);
    assert.throws(() => assertSyncPlayDatePersistenceWindow(changed), assert.AssertionError);
  }
  const manifest = JSON.parse(await readFile(syncplayDateImpactBinding.preparationInputFiles[6].filename, 'utf8'));
  assert.throws(() => assertSyncPlayDateManifestBinding({ ...manifest, head: '0'.repeat(40) }), assert.AssertionError);
  assert.throws(() => assertSyncPlayDateManifestBinding({ ...manifest, contentDigest: '0'.repeat(64) }), assert.AssertionError);
  assert.throws(() => resolveSyncPlayDatePreparationInput('.agent-temp/http-filter-reference-20261003/bootstrap.json'), assert.AssertionError);
  for (const mutate of [value => { value.completeBuildInputClosure = true; }, value => { value.releaseAcceptance = true; },
    value => { value.nativePidIdentitySealed = true; }, value => { value.actualFfmpegLaunchSealed = true; },
    value => { value.recordings.pop(); }, value => { value.recordings[0].entriesSha256 = '0'.repeat(64); },
    value => { value.recordings[0].logicalRoot = ['.agent-docs', 'evidence', 'syncplay-date-impact-native-v1'].join('/'); }]) {
    const changed = structuredClone(syncplayDateImpactBinding); mutate(changed);
    await assert.rejects(() => verifySyncPlayDateSourceBindings(changed), assert.AssertionError);
  }
  assert.throws(() => assertSyncPlayDateOutput(syncplayDateImpactBinding.recordings[0].filename + '/output',
    { MEDIAMANAGER_VALIDATION_OUTPUT_ROOT: 'D:/isolated-test-output' }));
});

test('SyncPlay minimum-year Ready guard matches native HTTP/WebSocket behavior (postgres)', async t => {
  const seed = JSON.parse(await readFile(new URL('./fixtures/syncplay/seed.json', import.meta.url), 'utf8'), reviveInteger);
  const database = await createPostgresTestDatabase(t, 'syncplay_date');
  await seedPostgresRuntime(database, seed);
  const errors = [], actualWhens = [], caseStages = [];
  const startedAt = new Date().toISOString();
  let runtime, raw, before, after, afterSocketShutdown, persistenceMatches;
  try {
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: 'syncplay-date-impact-postgres', onError: error => errors.push({ status: error.status, message: error.message }) });
    await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); });
    raw = await recordSyncPlayDateImpact(`http://127.0.0.1:${runtime.server.address().port}`, {
      async onAuthenticated() { before = await databaseDigest(database); },
      async onBeforeTargetReady(entry) { actualWhens.push(entry.actualWhen); },
      async onAfterTargetReady(entry) { caseStages.push({ name: entry.name, database: await databaseDigest(database) }); },
      async onCompleted() {
        after = await databaseDigest(database); persistenceMatches = await scanDatabase(database, actualWhens);
        // The sealed recorder terminates its client sockets in finally. Complete
        // the server close handshake first so this deliberate fixture cleanup
        // does not inject transport resets into the candidate error observation.
        await runtime.webSockets.close();
        afterSocketShutdown = await databaseDigest(database);
      },
    });
  } finally {
    if (runtime) { await runtime.syncPlay.drain(); await runtime.close(); }
    if (process.env.MEDIAMANAGER_SYNCPLAY_DATE_EVIDENCE) {
      const output = assertSyncPlayDateOutput(assertValidationOutputChild(path.resolve(process.env.MEDIAMANAGER_SYNCPLAY_DATE_EVIDENCE)));
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'postgres.json'), JSON.stringify({ startedAt, endedAt: new Date().toISOString(),
        raw, before, caseStages, after, afterSocketShutdown, actualWhens, persistenceMatches, errors,
        runtimeListeningAfterClose: runtime?.server.listening },
      (_key, value) => typeof value === 'bigint' ? { $integer: value.toString() } : value, 2) + '\n', { flag: 'wx' });
    }
  }
  assertSyncPlayDateImpactContract(normalizeSyncPlayDateImpact(raw), native.contract);
  assert.equal(caseStages.length, 6);
  for (const stage of caseStages) assert.deepEqual(stage.database, before, stage.name);
  assert.deepEqual(after, before); assert.deepEqual(persistenceMatches, []); assert.deepEqual(errors, []);
  assert.equal(runtime.server.listening, false);
});
