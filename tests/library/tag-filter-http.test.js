import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { parseQuery } from '../../src/library/query.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { seedNativeFilterInput } from './native-filter-input.js';
import { loadCurrentFilterScenario, writeCurrentFilterCandidateEvidence } from './current-filter-http.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const resource = declareFileTestResource('native-filter-http-ports', { enabled });
let fixture, inputs, nativeHttp, nativeStages, nativeServerId, keyById, pairs, scenario;

// Register teardown before Native initialization; hold this file's owner until
// the protected initialization and every candidate callback have really settled.
before(async context => {
  if (!enabled) return;
  await resource.run(async () => {
    ({ fixture, inputs, nativeHttp, nativeStages, nativeServerId } = await loadCurrentFilterScenario('tags'));
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

    keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
    pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
      const items = nativeHttp.records[index * 2];
      const legacy = nativeHttp.records[index * 2 + 1];
      assert.equal(items.endpoint, 'items');
      assert.equal(legacy.endpoint, 'legacy');
      assert.equal(items.name, legacy.name);
      assert.equal(items.query, legacy.query);
      return { items, legacy };
    });
    scenario = { ...fixture, cases: pairs.map(({ items }) => ({
      name: items.name, query: items.query, scope: ['alpha', 'beta'],
      omitParentId: true, recursive: null, assertOrder: true,
      endpoints: ['items', 'legacy'],
    })) };
  }, { signal: context.signal });
});
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
  test(`${dialect}: 17 Tags binder and relationship cases match 34 current Native HTTP responses`, {
    skip: !enabled,
  }, async context => resource.run(async () => {
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
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
    await writeCurrentFilterCandidateEvidence('tags', actual, { scenarioName: 'tag-filter' });
  }, { signal: context.signal }));
}

