import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseQuery } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, assertCompleteNativeFilterHttpRepeat, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { pathToFileURL } from 'node:url';

// Select this actual new profile before any historical external input is read.
const provenanceUrl = validationFileUrl('./fixtures/tag-filters/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
assert.equal(provenance.kind, 'new-designated-source-tags-http');
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
const fixtureUrl = validationFileUrl('./fixtures/tag-filters/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const runs = [];
for (const recording of provenance.recordings) runs.push(await verifyNativeItemFilterEvidence({
  evidence: pathToFileURL(recording.evidenceRoot + '/native-run-v2/'), fixtureUrl, scenario: 'tags',
  runDirectory: 'native-run-v2', expectedRecords: 34, inputs,
}));
assert.ok(runs.every(run => run.summary.cases === 17));
const nativeServerId = await inputs.readServerId();
assertCompleteNativeFilterHttpRepeat(runs[0].nativeHttp, runs[1].nativeHttp,
  { leftServerId: nativeServerId, rightServerId: nativeServerId });
assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
const nativeHttp = runs[0].nativeHttp, nativeSummary = runs[0].summary;
const evidence = pathToFileURL(provenance.recordings[0].evidenceRoot + '/native-run-v2/');
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
  assert.equal(native.Tags, item.tagsText, item.key);
  assert.equal(native.PresentationUniqueKey, item.presentationUniqueKey, item.key);
}
for (const value of fixture.itemValues) {
  const native = nativeStages.before.database.itemValues.find(row => idKey(row.ItemValueId) === idKey(value.id));
  assert.deepEqual([native?.Type, native?.Value, native?.CleanValue], [4, value.value, value.cleanValue], value.key);
}
const nativeLinks = nativeStages.before.database.itemValuesMap
  .filter(row => fixture.itemValues.some(value => idKey(value.id) === idKey(row.ItemValueId)))
  .map(row => `${idKey(row.ItemId)}:${idKey(row.ItemValueId)}`).sort();
const fixtureLinks = fixture.itemValueLinks.map(link => {
  const item = fixture.items.find(value => value.key === link.itemKey);
  const value = fixture.itemValues.find(entry => entry.key === link.valueKey);
  return `${idKey(item.id)}:${idKey(value.id)}`;
}).sort();
assert.deepEqual(nativeLinks, fixtureLinks);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
const pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
  const items = nativeHttp.records[index * 2];
  const legacy = nativeHttp.records[index * 2 + 1];
  assert.equal(items.endpoint, 'items');
  assert.equal(legacy.endpoint, 'legacy');
  assert.equal(items.name, legacy.name);
  assert.equal(items.query, legacy.query);
  return { items, legacy };
});
const scenario = { ...fixture, cases: pairs.map(({ items }) => ({
  name: items.name, query: items.query, scope: ['alpha', 'beta'],
  omitParentId: true, recursive: null, assertOrder: true,
  endpoints: ['items', 'legacy'],
})) };
const dialects = process.env.MEDIAMANAGER_TAG_FILTER_DIALECT
  ? [process.env.MEDIAMANAGER_TAG_FILTER_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid tag-filter dialect.');

test('pipe collection binders retain active empty repeated occurrences', () => {
  for (const key of ['Tags', 'OfficialRatings']) {
    const lower = key.toLowerCase();
    assert.deepEqual(parseQuery(new URLSearchParams(`${key}=`)), {});
    assert.deepEqual(parseQuery(new URLSearchParams(`${key}=&${key}=`)), { [lower]: ['', ''] });
    assert.deepEqual(parseQuery(new URLSearchParams(`${key}=Alpha&${key}=`)), { [lower]: ['Alpha', ''] });
  }
});

for (const dialect of dialects) {
  test(`${dialect}: 17 Tags binder and relationship cases match 34 frozen HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, 'tags', inputs),
      dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'tag-filter', fields: 'Tags', captureStartIndex: true,
      captureOrder: true, captureTags: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "tag-filter", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "tag-filter", nativeServerId });
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
        assert.deepEqual(observed.tags, expected.Items.map((item, index) => ({
          key: orderedKeys[index], values: item.Tags ?? null,
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
