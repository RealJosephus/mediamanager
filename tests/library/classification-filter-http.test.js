import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { verifyNativeItemFilterEvidence } from './native-item-filter-evidence.js';
import { seedNativeFilterInput } from './native-filter-input.js';
import { assertCompleteFilterHttpResponses, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { readNativeQueryServerId } from './native-query-inputs.js';

const evidence = validationFileUrl('../../.agent-docs/evidence/item-filter-inputs/classification-filters-native-v1/native-run/', import.meta.url);
const fixtureUrl = validationFileUrl('./fixtures/classification-filters/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
await verifyNativeItemFilterEvidence({ evidence, fixtureUrl, scenario: 'classification',
  runDirectory: 'native-run', expectedRecords: 48 });
const nativeHttp = JSON.parse(await readFile(validationFileUrl('native-http.json', evidence), 'utf8'));
const nativeServerId = await readNativeQueryServerId();
const nativeStages = JSON.parse(await readFile(validationFileUrl('stages.json', evidence), 'utf8'));
const nativeSummary = JSON.parse(await readFile(validationFileUrl('summary.json', evidence), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(nativeSummary.passed, true);
assert.equal(sha256(await readFile(validationFileUrl('../record-native.mjs', evidence))), nativeSummary.recorderSha256);
assert.equal(sha256(await readFile(fixtureUrl)), nativeSummary.fixtureSha256);
assert.equal(nativeHttp.records.length, 48);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.equal(nativeStages.before.database.foreignKeyCheck.length, 0);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
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

const pairs = Array.from({ length: nativeHttp.records.length / 2 }, (_, index) => {
  const items = nativeHttp.records[index * 2];
  const legacy = nativeHttp.records[index * 2 + 1];
  assert.equal(items.endpoint, 'items');
  assert.equal(legacy.endpoint, 'legacy');
  assert.equal(items.name, legacy.name);
  assert.equal(items.query, legacy.query);
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
  endpoints: ['items', 'legacy'],
})) };
const dialects = process.env.MEDIAMANAGER_CLASSIFICATION_FILTER_DIALECT
  ? [process.env.MEDIAMANAGER_CLASSIFICATION_FILTER_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid classification filter dialect.');

for (const dialect of dialects) {
  test(`${dialect}: 24 classification filter cases match 48 frozen HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, "classification"),
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
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
