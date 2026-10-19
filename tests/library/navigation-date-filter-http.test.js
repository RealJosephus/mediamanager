import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, assertCompleteNativeFilterHttpRepeat, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { pathToFileURL } from 'node:url';

// This new profile is selected before any historical external input is read.
const provenanceUrl = validationFileUrl('./fixtures/navigation-date-filters/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
assert.equal(provenance.kind, 'new-designated-source-navigation-date-http');
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
const { verifyNativeItemFilterEvidence } = await import('./native-item-filter-evidence.js');
const { seedNativeFilterInput } = await import('./native-filter-input.js');
const fixtureUrl = validationFileUrl('./fixtures/navigation-date-filters/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const runs = [];
for (const recording of provenance.recordings) runs.push(await verifyNativeItemFilterEvidence({
  evidence: pathToFileURL(recording.evidenceRoot + '/native-run/'), fixtureUrl, scenario: 'navigation-date',
  runDirectory: 'native-run', expectedRecords: 40, inputs,
}));
const nativeServerId = await inputs.readServerId();
assertCompleteNativeFilterHttpRepeat(runs[0].nativeHttp, runs[1].nativeHttp,
  { leftServerId: nativeServerId, rightServerId: nativeServerId });
assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
const nativeHttp = runs[0].nativeHttp, nativeSummary = runs[0].summary;
const evidence = pathToFileURL(provenance.recordings[0].evidenceRoot + '/native-run/');
const nativeStages = JSON.parse(await readFile(new URL('stages.json', evidence), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeProblem = value => Array.isArray(value) ? value.map(normalizeProblem)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId')
      .map(([key, item]) => [key, normalizeProblem(item)]))
    : value;
assert.equal(nativeSummary.passed, true);
assert.equal(sha256(await readFile(validationFileUrl('../record-native.mjs', evidence))), nativeSummary.recorderSha256);
assert.equal(sha256(await readFile(fixtureUrl)), nativeSummary.fixtureSha256);
assert.equal(nativeHttp.records.length, 40);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.equal(nativeStages.before.database.foreignKeyCheck.length, 0);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
const pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
  const items = nativeHttp.records[index * 2];
  const legacy = nativeHttp.records[index * 2 + 1];
  assert.equal(items.endpoint, 'items');
  assert.equal(legacy.endpoint, 'legacy');
  assert.equal(items.name, legacy.name);
  assert.equal(items.query, legacy.query);
  assert.equal(items.expectedStatus, legacy.expectedStatus);
  assert.deepEqual(items.scope, legacy.scope);
  return { items, legacy };
});
const scenario = { ...fixture, cases: pairs.map(({ items }) => ({
  name: items.name,
  query: items.query,
  scope: items.scope,
  omitParentId: true,
  recursive: null,
  assertOrder: true,
  expectedStatus: items.expectedStatus,
  expectRuntimeError: items.expectedStatus >= 400 ? false : undefined,
  endpoints: ['items', 'legacy'],
})) };
const dialects = process.env.MEDIAMANAGER_NAVIGATION_DATE_FILTER_DIALECT
  ? [process.env.MEDIAMANAGER_NAVIGATION_DATE_FILTER_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid navigation/date filter dialect.');

for (const dialect of dialects) {
  test(`${dialect}: 20 navigation/date filter cases match 40 actual native HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, 'navigation-date', inputs),
      dialect,
      fixture: scenario,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'navigation-date-filter',
      fields: 'SortName',
      captureStartIndex: true,
      captureOrder: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "navigation-date-filter", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "navigation-date-filter", nativeServerId });
    assert.equal(actual.httpCases, nativeHttp.records.length);
    assert.equal(actual.cases.length, pairs.length);
    for (const [caseIndex, pair] of pairs.entries()) {
      for (const [endpointIndex, native] of [pair.items, pair.legacy].entries()) {
        const observed = actual.cases[caseIndex].endpoints[endpointIndex].contract;
        const expected = native.response.bodyJson;
        const orderedKeys = (expected?.Items ?? []).map(item => keyById.get(idKey(item.Id)) ?? `unknown:${item.Id}`);
        assert.equal(observed.status, native.response.status, native.name);
        assert.equal(observed.contentType, native.response.contentType, native.name);
        assert.equal(observed.totalRecordCount, expected?.TotalRecordCount ?? null, native.name);
        assert.equal(observed.startIndex, expected?.StartIndex ?? null, native.name);
        assert.deepEqual(observed.orderedKeys, orderedKeys, native.name);
        assert.deepEqual(observed.problem,
          native.response.status >= 400 ? normalizeProblem(expected ?? { rawBody: native.response.bodyText }) : null,
          native.name);
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, scenario.cases
      .filter(testCase => testCase.expectedStatus >= 400 && testCase.expectRuntimeError !== false)
      .flatMap(testCase => ['items', 'legacy'].map(endpoint => ({
        caseName: testCase.name,
        endpoint,
        error: { name: 'Error', message: 'Error processing request.' },
      }))));
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
