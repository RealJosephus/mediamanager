import assert from 'node:assert/strict';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { seedNativeFilterInput } from './native-filter-input.js';
import { loadCurrentFilterScenario, writeCurrentFilterCandidateEvidence } from './current-filter-http.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const { fixture, inputs, nativeHttp, nativeStages, nativeServerId } = await loadCurrentFilterScenario('official-ratings');
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
  test(`${dialect}: 17 OfficialRatings binder and descendant cases match 34 current Native HTTP responses`, {
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
    await writeCurrentFilterCandidateEvidence('official-ratings', actual, { scenarioName: 'official-rating-filter' });
  });
}
