import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import historical from './fixtures/runtime-date-differences.json' with { type: 'json' };
import historicalProvenance from './fixtures/user-data-binding/provenance.json' with { type: 'json' };
import taipei from './fixtures/user-data-binding/runtime-date-taipei.json' with { type: 'json' };
import provenance from './fixtures/user-data-binding/runtime-date-taipei-provenance.json' with { type: 'json' };
import syncplayProvenance from './fixtures/syncplay/syncplay-date-taipei-provenance.json' with { type: 'json' };
import syncplayDifferences from './fixtures/syncplay/runtime-date-taipei-differences.json' with { type: 'json' };
import syncplayImpact from './fixtures/syncplay/date-impact-native.json' with { type: 'json' };
import candidateReprojection from './fixtures/syncplay/runtime-date-candidate-reprojection.json' with { type: 'json' };
import { parseLosslessJson } from '../../src/core/json.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';

const syncplayTaipei = parseLosslessJson(readFileSync(new URL('./fixtures/syncplay/syncplay-date-taipei.json', import.meta.url), 'utf8'));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = relative => readFileSync(new URL(relative, import.meta.url));
const hash = relative => sha256(bytes(relative));
const runtimeDateSeals = Object.freeze({
  referenceFixture: '96919167f4d75563645b9224344210ee4492da5f40a9467132d4f611d1c9cb7b',
  referenceProvenance: '422231d4bb5f0f741ae37fa452ae42f26ef103ea6b149deebf3304f4e290ec67',
  differences: 'd13c857969c9b73089ffbedafd4d38c5d9f2dee6a056dfe5d231d82591bfdc75',
  impactProjection: '64b4931424779a11e0889100cbfebfb3110dd03a4e4a6c88dab69dfbfc1660f5',
  candidateReprojection: '9fd7a0754cf8a0624449b4610eed4b83390abbeb9c054895ab10f3ce36476918',
  currentDateSource: '2b519f0ba14477bb7067398c6d01347e09c4bdabe091e891c73cc1c858dd9d95',
  recordedDateSource: '697b751a949020c3e23812de114ca898dd901a087018e53325381f39aaad2ea5',
  currentGroupSource: '3d5058e92a76998d024d52f0ac165becb6a6afcb6007886183276ae56ed35214',
  recordedGroupSource: '7ef8d66f551df84df8b1f4b10310acc257fa88f2aae25a172d2534888e03f765',
  recorder: 'b04381cc4487a7881cc56af6ee502d342a3e32b13e1793656ee243338f70cb32',
  scenario: 'a3bce89f039a3aac5556a40efe51bda653798df0a80b1e8387c43582d3a6b74a',
  nativeContract: '81d53056f6a8be7d30ad99570c84c6edd6468488f83ee427152a7288a71e5cd9',
  nativeRaw: 'f821c4df12f88f252f540b51ef1b21361b0a296abeab81491de1201cacba98ab',
});
const syncplayPersistence = Object.freeze({
  nativeStableWindow: ['afterAuthentication', 'afterCases'],
  nativeCompleteDigestStableInWindow: true,
  nativeAfterShutdownActivityLogDelta: 2,
  candidateStableWindow: ['afterAuthentication', 'afterCases'],
  candidateCompleteDigestStableInWindow: true,
  requestWhenPersisted: false,
});

function projectCandidateDates(cases) {
  return cases.map(({ input }) => {
    try {
      const value = parseJsonDateTime(parseLosslessJson(input.source));
      return { source: input.source, result: { ticks: String(value.ticks), kind: value.kind } };
    } catch (error) {
      return { source: input.source, result: { rejected: true,
        error: { name: error.name, message: error.message, stack: error.stack } } };
    }
  });
}

export function assertRuntimeDateCandidateReprojection(candidate = candidateReprojection, observations) {
  assert.equal(candidate.schemaVersion, 1);
  assert.deepEqual(candidate.environment, { node: 'v24.16.0', platform: 'win32', timeZone: 'Asia/Taipei' });
  const expectedSources = {
    date: {
      path: 'src/http/json-date-time.js', recordedSha256: runtimeDateSeals.recordedDateSource, recordedBytes: 3311,
      currentSha256: runtimeDateSeals.currentDateSource, currentBytes: 3151,
      removedLeadingText: '// System.Text.Json Utf8JsonReader.GetDateTime ISO input and DateTime tick semantics.\n// Copyright Jellyfin contributors. SPDX-License-Identifier: GPL-2.0-only\n',
      removedLeadingTextSha256: '21a484031bda86181e0fe8ab42ff0fa4783362d42b8eecb1ade7ecaa9416086b',
      removedLeadingBytes: 160,
    },
    group: {
      path: 'src/syncplay/group.js', recordedSha256: runtimeDateSeals.recordedGroupSource, recordedBytes: 16231,
      currentSha256: runtimeDateSeals.currentGroupSource, currentBytes: 16077,
      removedLeadingText: '// Ported from Jellyfin Group and MediaBrowser.Controller.SyncPlay.GroupStates.\n// Copyright Jellyfin contributors. SPDX-License-Identifier: GPL-2.0-only\n',
      removedLeadingTextSha256: '2414da1fab3acb63eae1fc87e5d8006a97c72ba0428dae96330f3b3e27a44b26',
      removedLeadingBytes: 154,
    },
  };
  assert.deepEqual(candidate.sources, expectedSources, 'Historical candidate source identities and the exact comment-only deltas are sealed.');
  for (const source of Object.values(candidate.sources)) {
    const removed = Buffer.from(source.removedLeadingText);
    assert.equal(removed.length, source.removedLeadingBytes, `${source.path}: removed-prefix bytes`);
    assert.equal(sha256(removed), source.removedLeadingTextSha256, `${source.path}: removed-prefix SHA-256`);
    assert.equal(source.currentBytes + removed.length, source.recordedBytes, `${source.path}: historical source byte lengths`);
  }

  assert.deepEqual(candidate.input, {
    path: 'tests/sessions/fixtures/syncplay/syncplay-date-taipei.json',
    sha256: runtimeDateSeals.referenceFixture,
    dateCases: 53,
  });
  assert.equal(hash('./fixtures/syncplay/syncplay-date-taipei.json'), candidate.input.sha256);
  assert.deepEqual(candidate.projection, {
    serialization: 'SHA-256 of JSON.stringify over ordered {source,result} entries; a result is ticks/kind or candidate error name/message.',
    sha256: 'ba531fea48a111921c1991507970dd249cb11e35d27a1ca7ce4ba626dac71220',
    dateCases: 53,
    validCases: 28,
    rejectedCases: 25,
    exactNativeValidCases: 26,
    documentedDifferenceSources: ['"0001-01-01T00:00:00-14:00"', '"0001-01-01T00:00:00+00:00"'],
    recordedAndCurrentExecutableTextIdentical: true,
  });
  assert.equal(candidate.phaseAcceptance, false, 'A candidate-only re-projection cannot claim phase acceptance.');
  // The sealed projection describes its recording-time candidate. Today's
  // source is bound by the current validation receipt; compare its real values
  // and rejection boundary without requiring the old diagnostic representation.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!['Asia/Taipei', 'Asia/Shanghai'].includes(timezone)) return;
  const cases = syncplayBindingFixture(timezone).filter(entry => entry.input.kind === 'date');
  const differences = runtimeDateFixture(timezone).syncplay;
  const projection = observations ?? projectCandidateDates(cases);
  const functional = result => result.rejected === true ? { rejected: true } : { ticks: result.ticks, kind: result.kind };
  const expected = cases.map(({ input, result }) => ({ source: input.source,
    result: result.error ? { rejected: true } : differences[input.source]?.candidate ?? { ticks: result.ticks, kind: result.kind } }));
  assert.deepEqual(projection.map(({ source, result }) => ({ source, result: functional(result) })), expected,
    'Every ordered date input retains its accepted ticks/kind or actual rejection.');
  const valid = projection.filter(entry => entry.result.rejected !== true);
  const rejected = projection.filter(entry => entry.result.rejected === true);
  const nativeValid = cases.filter(entry => !entry.result.error);
  const exactNative = valid.filter(entry => {
    const reference = nativeValid.find(value => value.input.source === entry.source)?.result;
    return reference && reference.ticks === entry.result.ticks && reference.kind === entry.result.kind;
  });
  const documented = valid.filter(entry => !exactNative.includes(entry)).map(entry => entry.source);
  assert.equal(projection.length, candidate.projection.dateCases);
  assert.equal(valid.length, candidate.projection.validCases);
  assert.equal(rejected.length, candidate.projection.rejectedCases);
  const documentedSources = nativeValid.filter(entry => Object.hasOwn(differences, entry.input.source)).map(entry => entry.input.source);
  assert.equal(exactNative.length, valid.length - documentedSources.length);
  assert.deepEqual(documented, documentedSources);
  for (const source of documented) {
    const projected = projection.find(entry => entry.source === source).result;
    const native = cases.find(entry => entry.input.source === source).result;
    assert.deepEqual(differences[source].reference, { ticks: native.ticks, kind: native.kind });
    assert.deepEqual(differences[source].candidate, projected);
  }
  return projection;
}

export function assertSyncPlayRuntimeDateEvidence(impact = syncplayImpact, differences = syncplayDifferences) {
  assert.equal(impact.schemaVersion, 2);
  assert.equal(differences.schemaVersion, 3);
  assert.equal(impact.phaseAcceptance, false, 'A local SyncPlay fixture cannot claim phase acceptance.');
  assert.equal(differences.phaseAcceptance, false, 'A local runtime-difference fixture cannot claim phase acceptance.');
  assert.deepEqual(impact.persistence, syncplayPersistence,
    'The projected SyncPlay persistence claim must be limited to its operation window and preserve shutdown writes.');
  assert.deepEqual(differences.functionalImpactEvidence.persistence, syncplayPersistence,
    'The runtime-date impact must use the same bounded persistence claim as the projected native evidence.');
}

assert.equal(hash('./fixtures/user-data-binding/runtime-date-taipei.json'), provenance.fixtureSha256);
assert.equal(hash('./user-data-binding-cases.js'), provenance.bindingCasesSha256);
assert.equal(hash('../../tools/compat/user-data-date-oracle/Program.cs'), provenance.oracleSourceSha256);
assert.equal(hash('../../tools/compat/user-data-date-oracle/UserDataDateOracle.csproj'), provenance.oracleProjectSha256);
assert.equal(hash('../../tools/compat/record-user-data-date-environment.mjs'), provenance.recorderSha256);
assert.equal(hash('./fixtures/runtime-date-differences.json'), historicalProvenance.artifacts
  .find(artifact => artifact.path.endsWith('/runtime-date-differences.json')).sha256);
assert.equal(taipei.environment.nodeTimezone, 'Asia/Taipei');
assert.equal(taipei.environment.native.timezoneId, 'Taipei Standard Time');
assert.equal(historical.environment.timeZone, 'Asia/Shanghai');
assert.equal(provenance.phaseAcceptance, false);
assert.equal(hash('./fixtures/syncplay/syncplay-date-taipei.json'), runtimeDateSeals.referenceFixture);
assert.equal(hash('./fixtures/syncplay/syncplay-date-taipei-provenance.json'), runtimeDateSeals.referenceProvenance);
assert.equal(syncplayProvenance.fixtureSha256, runtimeDateSeals.referenceFixture);
assert.equal(hash('./fixtures/syncplay/binding-reference.json'), syncplayProvenance.syncplayInputSha256);
assert.equal(hash('../../tools/compat/user-data-date-oracle/Program.cs'), syncplayProvenance.oracleSourceSha256);
assert.equal(hash('../../tools/compat/record-user-data-date-environment.mjs'), syncplayProvenance.recorderSha256);
assert.equal(syncplayDifferences.referenceFixtureSha256, syncplayProvenance.fixtureSha256);
assert.equal(hash('./fixtures/syncplay/runtime-date-taipei-differences.json'), runtimeDateSeals.differences);
assert.equal(hash('./fixtures/syncplay/date-impact-native.json'), runtimeDateSeals.impactProjection);
assert.equal(hash('./fixtures/syncplay/runtime-date-candidate-reprojection.json'), runtimeDateSeals.candidateReprojection);
assert.equal(syncplayDifferences.candidateDateSourceSha256, runtimeDateSeals.currentDateSource);
assert.equal(syncplayDifferences.recordedCandidateDateSourceSha256, runtimeDateSeals.recordedDateSource);
assert.equal(syncplayDifferences.functionalImpactEvidence.projectionSha256, runtimeDateSeals.impactProjection);
assert.equal(syncplayDifferences.functionalImpactEvidence.candidateReprojectionSha256, runtimeDateSeals.candidateReprojection);
assert.equal(syncplayImpact.sourceEvidenceSha256, runtimeDateSeals.nativeContract);
assert.equal(syncplayImpact.sourceRawEvidenceSha256, runtimeDateSeals.nativeRaw);
assert.equal(syncplayDifferences.functionalImpactEvidence.nativeContractSha256, runtimeDateSeals.nativeContract);
assert.equal(syncplayDifferences.functionalImpactEvidence.nativeRawSha256, runtimeDateSeals.nativeRaw);
// These seals belong to the historical recording, not today's live recorder.
assert.equal(hash('./fixtures/syncplay/recording-source/record-native.mjs.txt'), runtimeDateSeals.recorder);
assert.equal(hash('./fixtures/syncplay/recording-source/scenario.js.txt'), runtimeDateSeals.scenario);
assert.equal(syncplayImpact.recorderSha256, runtimeDateSeals.recorder);
assert.equal(syncplayImpact.scenarioSha256, runtimeDateSeals.scenario);
// These identities remain facts about the historical recording, not a lock on
// today's candidate source. Its identity is captured by the current receipt.
assert.equal(syncplayImpact.candidateSource.groupSha256, runtimeDateSeals.currentGroupSource);
assert.equal(syncplayImpact.candidateSource.dateSourceSha256, runtimeDateSeals.currentDateSource);
assert.equal(syncplayImpact.candidateSource.recordedGroupSha256, runtimeDateSeals.recordedGroupSource);
assert.equal(syncplayImpact.candidateSource.recordedDateSourceSha256, runtimeDateSeals.recordedDateSource);
assert.equal(syncplayImpact.candidateSource.reprojectionSha256, runtimeDateSeals.candidateReprojection);
assertRuntimeDateCandidateReprojection();
assertSyncPlayRuntimeDateEvidence();
assert.deepEqual(syncplayImpact.guardDiagnostics.map(entry => entry.guardWarningCount), [1, 1, 1, 1, 0, 1]);
assert.deepEqual(syncplayImpact.contract.cases.map(entry => [entry.result.positionTicks, entry.result.state, entry.result.command,
  entry.result.requestWhenEchoed]), [
  ['6000000000', 'Playing', 'Unpause', false],
  ['6000000000', 'Playing', 'Unpause', false],
  ['6000000000', 'Playing', 'Unpause', false],
  ['6000000000', 'Playing', 'Unpause', false],
  ['6000000000', 'Waiting', 'Seek', false],
  ['6000000000', 'Playing', 'Unpause', false],
]);
assert.equal(syncplayTaipei.cases.filter(entry => entry.input.kind === 'date').length, 53);
assert.equal(syncplayTaipei.cases.filter(entry => entry.input.kind === 'dto').length, 61);

export function runtimeDateFixture(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!['Asia/Taipei', 'Asia/Shanghai'].includes(timezone)) {
    throw new Error(`UserData date fixtures have no verified local environment for ${timezone}; covered environments are Asia/Taipei and Asia/Shanghai.`);
  }
  if (timezone === 'Asia/Shanghai') return structuredClone(historical);
  const userDataDto = {};
  for (const entry of taipei.cases) {
    const original = historical.userDataDto[entry.name];
    assert.equal(entry.source, original.source);
    assert.deepEqual(entry.expected, original.reference.LastPlayedDate, `${entry.name}: actual Taipei native binding agrees with the frozen DTO date`);
    const value = { ...structuredClone(original.reference), LastPlayedDate: structuredClone(entry.expected) };
    userDataDto[entry.name] = { source: entry.source, reference: value, candidate: structuredClone(value) };
  }
  return { policy: 'Actual Windows Taipei evidence: UserData dates match. Frozen Jellyfin Ready HTTP/WebSocket evidence and candidate SQLite/PostgreSQL replay show both minimum-year differences are discarded by the two-second guard before position, delay, state and command scheduling.',
    environment: taipei.environment, userDataDto, syncplay: structuredClone(syncplayDifferences.differences),
    syncplayImpact: structuredClone(syncplayImpact.contract) };
}

export function syncplayBindingFixture(timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  runtimeDateFixture(timezone); // Unknown environments must fail before any date comparison.
  return timezone === 'Asia/Taipei' ? structuredClone(syncplayTaipei.cases)
    : parseLosslessJson(readFileSync(new URL('./fixtures/syncplay/binding-reference.json', import.meta.url), 'utf8'));
}
