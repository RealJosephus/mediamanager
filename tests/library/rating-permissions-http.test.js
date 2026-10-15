import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, assertCompleteNativeFilterHttpRepeat, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { pathToFileURL } from 'node:url';

// Select this actual new profile before any historical external input is read.
const provenanceUrl = validationFileUrl('./fixtures/rating-permissions/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
assert.equal(provenance.kind, 'new-designated-source-rating-permissions-http');
assert.equal(provenance.historicalMissingEvidenceAccepted, false);
assert.equal(provenance.recordings.length, 2);
assert.equal(new Set(provenance.recordings.map(recording => recording.evidenceRoot)).size, 2);
assert.ok(provenance.profile.recordedRecorder);
assert.ok(provenance.profile.sourceBuildReceipt);
assert.equal(provenance.profile.executionInputs.length, 2);
const { createNativeQueryInputs, readNativeQueryBoundFile } = await import('./native-query-inputs.js');
const inputs = createNativeQueryInputs(provenance.profile);
for (const descriptor of provenance.requiredInputs) {
  assert.equal(descriptor.required, true);
  await readNativeQueryBoundFile(descriptor);
}
const independentAudit = JSON.parse(await readNativeQueryBoundFile(provenance.independentAudit));
assert.equal(independentAudit.passed, true);
assert.equal(independentAudit.preservedDatabaseTables.length, 33);
assert.equal(independentAudit.nativeRuns.length, 10);
assert.equal(independentAudit.nativeRuns.reduce((sum, run) => sum + run.records, 0), 384);
const { verifyNativeItemFilterEvidence } = await import('./native-item-filter-evidence.js');
const { seedNativeFilterInput } = await import('./native-filter-input.js');
const fixtureUrl = validationFileUrl('./fixtures/rating-permissions/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const runs = [];
for (const recording of provenance.recordings) runs.push(await verifyNativeItemFilterEvidence({
  evidence: pathToFileURL(recording.evidenceRoot + '/native-run/'), fixtureUrl, scenario: 'rating-permissions',
  runDirectory: 'native-run', expectedRecords: 36, inputs,
}));
assert.ok(runs.every(run => run.summary.cases === 12));
const nativeServerId = await inputs.readServerId();
assertCompleteNativeFilterHttpRepeat(runs[0].nativeHttp, runs[1].nativeHttp,
  { leftServerId: nativeServerId, rightServerId: nativeServerId });
assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
const nativeHttp = runs[0].nativeHttp, nativeSummary = runs[0].summary;
const evidence = pathToFileURL(provenance.recordings[0].evidenceRoot + '/native-run/');
const nativeStages = JSON.parse(await readFile(new URL('stages.json', evidence), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(nativeSummary.passed, true);
assert.equal(sha256(await readFile(validationFileUrl('../record-native.mjs', evidence))), nativeSummary.recorderSha256);
assert.equal(nativeHttp.records.length, 36);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.deepEqual(nativeStages.before.database.foreignKeyCheck, []);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
for (const item of fixture.items) {
  const native = nativeStages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
  assert.ok(native, item.key);
  assert.equal(native.CustomRating, item.customRating ?? null, item.key);
  assert.equal(native.InheritedParentalRatingValue, item.inheritedParentalRatingValue ?? null, item.key);
  assert.equal(native.InheritedParentalRatingSubValue, item.inheritedParentalRatingSubValue ?? null, item.key);
  if (item.presentationUniqueKey) assert.equal(native.PresentationUniqueKey, item.presentationUniqueKey, item.key);
}
const triples = Array.from({ length: nativeHttp.records.length / 3 }, (_, index) => {
  const triple = nativeHttp.records.slice(index * 3, index * 3 + 3);
  assert.deepEqual(triple.map(record => record.endpoint), ['items', 'legacy', 'detail']);
  assert.ok(triple.every(record => record.name === triple[0].name));
  assert.ok(triple.every(record => record.maxRating === triple[0].maxRating
    && JSON.stringify(record.blockUnrated) === JSON.stringify(triple[0].blockUnrated)));
  return triple;
});
const scenario = { ...fixture, cases: triples.map(([items, , detail]) => ({
  name: items.name, query: 'IncludeItemTypes=Movie', scope: ['alpha', 'beta', 'gamma'],
  omitParentId: true, recursive: null, assertOrder: true,
  policy: { AllowedTags: [], BlockedTags: [], MaxParentalRating: items.maxRating,
    MaxParentalSubRating: items.maxRating == null ? null : 0, BlockUnratedItems: items.blockUnrated },
  detailKey: keyById.get(idKey(detail.detailId)), detailExpectedStatus: detail.response.status,
  endpoints: ['items', 'legacy', 'detail'],
})) };
const dialects = process.env.MEDIAMANAGER_RATING_PERMISSIONS_DIALECT
  ? [process.env.MEDIAMANAGER_RATING_PERMISSIONS_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid rating-permissions dialect.');

for (const dialect of dialects) {
  test(`${dialect}: inherited ratings and policy updates match 36 frozen list and direct HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, 'rating-permissions', inputs),
      dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'rating-permissions', fields: 'SortName', captureStartIndex: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "rating-permissions", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "rating-permissions", nativeServerId });
    assert.equal(actual.httpCases, 36);
    assert.equal(actual.cases.length, 12);
    for (const [caseIndex, triple] of triples.entries()) {
      for (const [endpointIndex, native] of triple.entries()) {
        const observed = actual.cases[caseIndex].endpoints[endpointIndex].contract;
        const expected = native.response.bodyJson;
        assert.equal(observed.status, native.response.status, native.name);
        assert.equal(observed.contentType, native.response.contentType, native.name);
        if (native.endpoint === 'detail') {
          assert.equal(observed.key, expected?.Id ? keyById.get(idKey(expected.Id)) : null, native.name);
          assert.equal(observed.name, expected?.Name ?? null, native.name);
        } else {
          assert.equal(observed.totalRecordCount, expected.TotalRecordCount, native.name);
          assert.equal(observed.startIndex, expected.StartIndex, native.name);
          assert.deepEqual(observed.orderedKeys,
            expected.Items.map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`), native.name);
        }
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
