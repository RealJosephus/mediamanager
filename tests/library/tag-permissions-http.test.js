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

const evidence = validationFileUrl('../../.agent-docs/evidence/item-filter-inputs/tag-permissions-native-v1/native-run-v3/', import.meta.url);
const fixtureUrl = validationFileUrl('./fixtures/tag-permissions/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
await verifyNativeItemFilterEvidence({ evidence, fixtureUrl, scenario: 'tag-permissions',
  runDirectory: 'native-run-v3', expectedRecords: 48 });
const nativeHttp = JSON.parse(await readFile(validationFileUrl('native-http.json', evidence), 'utf8'));
const nativeServerId = await readNativeQueryServerId();
const nativeStages = JSON.parse(await readFile(validationFileUrl('stages.json', evidence), 'utf8'));
const nativeSummary = JSON.parse(await readFile(validationFileUrl('summary.json', evidence), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(nativeSummary.passed, true);
assert.equal(sha256(await readFile(validationFileUrl('../record-native.mjs', evidence))), nativeSummary.recorderSha256);
assert.equal(nativeHttp.records.length, 48);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.deepEqual(nativeStages.before.database.foreignKeyCheck, []);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
for (const item of fixture.items) {
  const native = nativeStages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
  assert.ok(native, item.key);
  assert.equal(native.Tags, item.tagsText ?? '', item.key);
  if (item.presentationUniqueKey) assert.equal(native.PresentationUniqueKey, item.presentationUniqueKey, item.key);
}
for (const link of fixture.itemValueLinks) {
  const item = fixture.items.find(entry => entry.key === link.itemKey);
  const value = fixture.itemValues.find(entry => entry.key === link.valueKey);
  assert.ok(nativeStages.before.database.itemValuesMap.some(row =>
    idKey(row.ItemId) === idKey(item.id) && idKey(row.ItemValueId) === idKey(value.id)),
  `${link.itemKey} -> ${link.valueKey}`);
}
assert.equal(nativeStages.before.database.itemValuesMap.some(row =>
  idKey(row.ItemId) === idKey(fixture.items.find(item => item.key === 'nested').id)), false,
'Nested folder must have display-only tags, not a repository tag relation.');
const triples = Array.from({ length: nativeHttp.records.length / 3 }, (_, index) => {
  const triple = nativeHttp.records.slice(index * 3, index * 3 + 3);
  assert.deepEqual(triple.map(record => record.endpoint), ['items', 'legacy', 'detail']);
  assert.ok(triple.every(record => record.name === triple[0].name));
  assert.ok(triple.every(record => JSON.stringify(record.allowedTags) === JSON.stringify(triple[0].allowedTags)
    && JSON.stringify(record.blockedTags) === JSON.stringify(triple[0].blockedTags)));
  return triple;
});
const scenario = { ...fixture, cases: triples.map(([items, , detail]) => ({
  name: items.name, query: 'IncludeItemTypes=Movie', scope: ['alpha', 'beta', 'gamma'],
  omitParentId: true, recursive: null, assertOrder: true,
  policy: { AllowedTags: items.allowedTags, BlockedTags: items.blockedTags },
  detailKey: keyById.get(idKey(detail.detailId)), detailExpectedStatus: detail.response.status,
  endpoints: ['items', 'legacy', 'detail'],
})) };
const dialects = process.env.MEDIAMANAGER_TAG_PERMISSIONS_DIALECT
  ? [process.env.MEDIAMANAGER_TAG_PERMISSIONS_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid tag-permissions dialect.');

for (const dialect of dialects) {
  test(`${dialect}: inherited tags and policy updates match 48 frozen list and direct HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, "tag-permissions"),
      dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'tag-permissions', fields: 'SortName,Tags', captureStartIndex: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "tag-permissions", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "tag-permissions", nativeServerId });
    assert.equal(actual.httpCases, 48);
    assert.equal(actual.cases.length, 16);
    for (const [caseIndex, triple] of triples.entries()) {
      for (const [endpointIndex, native] of triple.entries()) {
        const observed = actual.cases[caseIndex].endpoints[endpointIndex].contract;
        const expected = native.response.bodyJson;
        assert.equal(observed.status, native.response.status, native.name);
        assert.equal(observed.contentType, native.response.contentType, native.name);
        if (native.endpoint === 'detail') {
          assert.equal(observed.key, expected?.Id ? keyById.get(idKey(expected.Id)) : null, native.name);
          assert.equal(observed.name, expected?.Name ?? null, native.name);
          assert.deepEqual(observed.tags, expected?.Tags ?? null, native.name);
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
