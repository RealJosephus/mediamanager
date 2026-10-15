import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertCompleteFilterHttpResponses, assertCompleteNativeFilterHttpRepeat, writeCompleteFilterHttpEvidence } from './full-filter-wire.js';
import { pathToFileURL } from 'node:url';

// Read this explicit manifest before importing historical query helpers.
// A new-profile failure is fatal; no historical path is consulted.
const provenanceUrl = validationFileUrl('./fixtures/image-type-filters/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
assert.equal(provenance.kind, 'new-designated-source-image-type-http');
assert.equal(provenance.recordings.length, 2);
assert.ok(provenance.profile.independentNativeAudits.length > 0);
assert.ok(provenance.profile.recordedRecorder);
assert.equal(provenance.profile.executionInputs.length, 2);
assert.ok(provenance.profile.sourceBuildReceipt);
assert.ok(provenance.profile.runtimeDirectory);
assert.ok(provenance.profile.dotnetDirectory);
assert.ok(Array.isArray(provenance.profile.expectedChangedReferences));
const { createNativeQueryInputs, readNativeQueryBoundFile } = await import('./native-query-inputs.js');
const inputs = createNativeQueryInputs(provenance.profile);
for (const descriptor of provenance.requiredInputs) {
  assert.equal(descriptor.required, true);
  await readNativeQueryBoundFile(descriptor);
}
const { verifyNativeItemFilterEvidence } = await import('./native-item-filter-evidence.js');
const { seedNativeFilterInput } = await import('./native-filter-input.js');
const fixtureUrl = validationFileUrl('./fixtures/image-type-filters/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const runs = [];
for (const recording of provenance.recordings) {
  const evidence = pathToFileURL(recording.evidenceRoot + '/native-run/');
  const run = await verifyNativeItemFilterEvidence({ evidence, fixtureUrl, scenario: 'image-type',
    runDirectory: 'native-run', expectedRecords: 40, inputs });
  runs.push(run);
}
const nativeHttp = runs[0].nativeHttp;
const nativeServerId = await inputs.readServerId();
assertCompleteNativeFilterHttpRepeat(runs[0].nativeHttp, runs[1].nativeHttp,
  { leftServerId: nativeServerId, rightServerId: nativeServerId });
assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
const evidence = pathToFileURL(provenance.recordings[0].evidenceRoot + '/native-run/');
const nativeStages = JSON.parse(await readFile(new URL('stages.json', evidence), 'utf8'));
const nativeSummary = runs[0].summary;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(nativeSummary.passed, true);
assert.equal(sha256(await readFile(new URL('../record-native.mjs', evidence))), nativeSummary.recorderSha256);
assert.equal(sha256(await readFile(fixtureUrl)), nativeSummary.fixtureSha256);
assert.equal(nativeHttp.records.length, 40);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.equal(nativeStages.before.database.foreignKeyCheck.length, 0);

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
for (const image of fixture.images) {
  const itemId = fixture.items.find(item => item.key === image.itemKey).id;
  const native = nativeStages.before.database.imageInfos.find(row => idKey(row.Id) === idKey(image.id));
  assert.ok(native, image.id);
  assert.equal(idKey(native.ItemId), idKey(itemId), image.id);
  assert.equal(native.ImageType, image.imageType, image.id);
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
const dialects = process.env.MEDIAMANAGER_IMAGE_TYPE_FILTER_DIALECT
  ? [process.env.MEDIAMANAGER_IMAGE_TYPE_FILTER_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid image-type filter dialect.');

for (const dialect of dialects) {
  test(`${dialect}: 20 image-type filter cases match 40 frozen HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      captureResponseBodies: true,
      prepareScenario: context => seedNativeFilterInput(context, "image-type", inputs),
      dialect,
      fixture: scenario,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'image-type-filter',
      fields: 'SortName',
      captureStartIndex: true,
      captureOrder: true,
    });
    assertCompleteFilterHttpResponses(actual, nativeHttp, { scenarioName: "image-type-filter", nativeServerId });
    await writeCompleteFilterHttpEvidence(actual, nativeHttp, { scenarioName: "image-type-filter", nativeServerId });
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
