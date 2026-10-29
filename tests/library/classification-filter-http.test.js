import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
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

// Register the file owner and teardown before any asynchronous Native capture.
// A failed before hook still waits for its actual process/DB cleanup and releases
// this process's lease; it cannot crash module evaluation with an orphan lease.
before(async context => {
  if (!enabled) return;
  await resource.run(async () => {
    ({ fixture, inputs, nativeHttp, nativeStages, nativeServerId } = await loadCurrentFilterScenario('classification'));
    assert.equal(nativeHttp.records.length, 48);
    assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
    assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
    assert.equal(nativeStages.before.database.foreignKeyCheck.length, 0);

    keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
    for (const value of fixture.itemValues) {
      const native = nativeStages.before.database.itemValues.find(row => idKey(row.ItemValueId) === idKey(value.id));
      assert.ok(native, value.key);
      assert.equal(native.Type, 4, value.key);
      assert.equal(native.Value, value.value, value.key);
      assert.equal(native.CleanValue, value.cleanValue, value.key);
    }
    for (const link of fixture.itemValueLinks) {
      const itemId = fixture.items.find(item => item.key === link.itemKey).id;
      const valueId = fixture.itemValues.find(value => value.key === link.valueKey).id;
      assert.ok(nativeStages.before.database.itemValuesMap.some(row =>
        idKey(row.ItemId) === idKey(itemId) && idKey(row.ItemValueId) === idKey(valueId)),
      `${link.itemKey}:${link.valueKey}`);
    }

    pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
      const items = nativeHttp.records[index * 2];
      const legacy = nativeHttp.records[index * 2 + 1];
      assert.equal(items.endpoint, 'items');
      assert.equal(legacy.endpoint, 'legacy');
      assert.equal(items.name, legacy.name);
      assert.equal(items.query, legacy.query);
      assert.deepEqual(items.scope, legacy.scope);
      return { items, legacy };
    });
    scenario = { ...fixture, cases: pairs.map(({ items }) => ({
      name: items.name,
      query: items.query,
      scope: items.scope,
      omitParentId: true,
      recursive: null,
      assertOrder: true,
      endpoints: ['items', 'legacy'],
    })) };
  }, { signal: context.signal });
});
const dialects = process.env.MEDIAMANAGER_CLASSIFICATION_FILTER_DIALECT
  ? [process.env.MEDIAMANAGER_CLASSIFICATION_FILTER_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid classification filter dialect.');

for (const dialect of dialects) {
  test(`${dialect}: 24 classification filter cases match 48 actual native HTTP responses`, {
    skip: !enabled,
  }, async context => resource.run(async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, 'classification', inputs),
      dialect,
      fixture: scenario,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'classification-filter',
      fields: 'SortName',
      captureStartIndex: true,
      captureOrder: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "classification-filter", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "classification-filter", nativeServerId });
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
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
    await writeCurrentFilterCandidateEvidence('classification', actual, { scenarioName: 'classification-filter' });
  }, { signal: context.signal }));
}

