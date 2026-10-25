import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { seedNativeFilterInput } from './native-filter-input.js';
import { loadCurrentFilterScenario, writeCurrentFilterCandidateEvidence } from './current-filter-http.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const resourceLease = await acquireTestResource('native-filter-http-ports');
const { fixture, inputs, nativeHttp, nativeStages, nativeServerId } = await loadCurrentFilterScenario('navigation-date');
const normalizeProblem = value => Array.isArray(value) ? value.map(normalizeProblem)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId')
      .map(([key, item]) => [key, normalizeProblem(item)]))
    : value;
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
    await writeCurrentFilterCandidateEvidence('navigation-date', actual, { scenarioName: 'navigation-date-filter' });
  });
}

// Release after all test hooks, streams, processes and resource postconditions.
after(async () => { await resourceLease?.release(); });
