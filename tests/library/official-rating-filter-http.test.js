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
const provenanceUrl = validationFileUrl('./fixtures/official-rating-filters/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
assert.equal(provenance.kind, 'new-designated-source-official-ratings-http');
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
const fixtureUrl = validationFileUrl('./fixtures/official-rating-filters/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const runs = [];
for (const recording of provenance.recordings) runs.push(await verifyNativeItemFilterEvidence({
  evidence: pathToFileURL(recording.evidenceRoot + '/native-run/'), fixtureUrl, scenario: 'official-ratings',
  runDirectory: 'native-run', expectedRecords: 34, inputs,
}));
assert.ok(runs.every(run => run.summary.cases === 17));
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
assert.equal(nativeHttp.records.length, 34);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.equal(nativeStages.before.database.foreignKeyCheck.length, 0);
for (const item of fixture.items.filter(item => item.type === 'Movie')) {
  const native = nativeStages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
  assert.ok(native, item.key);
  assert.equal(native.OfficialRating, item.officialRating, item.key);
  assert.equal(native.PresentationUniqueKey, item.presentationUniqueKey, item.key);
}
assert.deepEqual(nativeStages.before.database.ancestorIds
  .filter(row => idKey(row.ItemId) === idKey(fixture.items.find(item => item.key === 'empty').id))
  .map(row => idKey(row.ParentItemId)).sort(),
fixture.items.filter(item => ['aggregateRoot', 'physicalRoot'].includes(item.key)).map(item => idKey(item.id)).sort());

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
const pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
  const items = nativeHttp.records[index * 2];
  const legacy = nativeHttp.records[index * 2 + 1];
  assert.equal(items.endpoint, 'items');
  assert.equal(legacy.endpoint, 'legacy');
  assert.equal(items.name, legacy.name);
  assert.equal(items.query, legacy.query);
  assert.deepEqual(items.scopeIds, legacy.scopeIds);
  return { items, legacy };
});
const scenario = { ...fixture, cases: pairs.map(({ items }) => ({
  name: items.name, query: items.query,
  scope: items.scopeIds.map(id => {
    const key = keyById.get(idKey(id));
    assert.ok(key, `Unknown native scope id: ${id}`);
    return key;
  }),
  omitParentId: true, recursive: null, assertOrder: true,
  endpoints: ['items', 'legacy'],
})) };
const dialects = process.env.MEDIAMANAGER_OFFICIAL_RATING_DIALECT
  ? [process.env.MEDIAMANAGER_OFFICIAL_RATING_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid OfficialRatings dialect.');

for (const dialect of dialects) {
  test(`${dialect}: 17 OfficialRatings binder and descendant cases match 34 frozen HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, 'official-ratings', inputs),
      dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'official-rating-filter', fields: 'SortName', captureStartIndex: true,
      captureOrder: true, captureOfficialRatings: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "official-rating-filter", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "official-rating-filter", nativeServerId });
    assert.equal(actual.httpCases, nativeHttp.records.length);
    assert.equal(actual.cases.length, pairs.length);
    for (const [caseIndex, pair] of pairs.entries()) {
      for (const [endpointIndex, native] of [pair.items, pair.legacy].entries()) {
        const observed = actual.cases[caseIndex].endpoints[endpointIndex].contract;
        const expected = native.response.bodyJson;
        const orderedKeys = expected.Items.map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`);
        assert.equal(observed.status, native.response.status, native.name);
        assert.equal(observed.contentType, native.response.contentType, native.name);
        assert.equal(observed.totalRecordCount, expected.TotalRecordCount, native.name);
        assert.equal(observed.startIndex, expected.StartIndex, native.name);
        assert.deepEqual(observed.orderedKeys, orderedKeys, native.name);
        assert.deepEqual(observed.officialRatings, expected.Items.map((item, index) => ({
          key: orderedKeys[index], value: item.OfficialRating ?? null,
        })), native.name);
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
