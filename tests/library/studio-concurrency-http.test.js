import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { nativeStudioIdentity } from '../../src/library/identity.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { writeCompleteIdentityHttpEvidence } from './full-identity-wire.js';
import { assertCandidateIdentityMatchesNative,
  verifyNativeIdentityEvidence,
  verifyIdentityMismatchNegativeControl } from './native-identity-evidence.js';

assert.equal(verifyIdentityMismatchNegativeControl(), true);

const evidenceRoot = validationFileUrl('../../.agent-docs/evidence/identity-inputs/studio-concurrency-native-v1/', import.meta.url);
await verifyNativeIdentityEvidence({ evidenceRoot, kind: 'studio', evidenceName: 'studio-concurrency-native-v1',
  expectedRunModes: { 'native-run': 'concurrency' } });
const evidence = new URL('native-run/', evidenceRoot);
const fixture = JSON.parse(await readFile(validationFileUrl('./fixtures/studio-filters/input.json', import.meta.url), 'utf8'));
const nativeHttp = JSON.parse(await readFile(validationFileUrl('native-http.json', evidence), 'utf8'));
const nativeStages = JSON.parse(await readFile(validationFileUrl('stages.json', evidence), 'utf8'));
const nativeSummary = JSON.parse(await readFile(validationFileUrl('summary.json', evidence), 'utf8'));
assert.equal(nativeSummary.passed, true, 'The frozen concurrency recorder must have completed and released its port.');
assert.equal(createHash('sha256').update(await readFile(validationFileUrl('../record-native.mjs', evidence))).digest('hex'),
  nativeSummary.recorderSha256, 'The recorder must match the frozen run input.');
assert.equal(nativeHttp.records.length, 9);
assert.equal(nativeStages.afterBatch.database.baseItemsCount - nativeStages.before.database.baseItemsCount, 1);
assert.equal(nativeStages.afterFollowup.database.baseItemsCount - nativeStages.before.database.baseItemsCount, 1);
assert.deepEqual(nativeStages.afterBatch.studioTree.map(entry => [entry.name, entry.type]),
  [['Concurrent Alpha', 'directory']]);

const studio = 'Concurrent Alpha';
const caseFor = (name, parallelRequests) => ({
  name, query: `Studios=${encodeURIComponent(studio)}`, scope: ['rockMapOnly'],
  omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'],
  ...(parallelRequests ? { parallelRequests } : {}),
});
const scenario = { ...fixture, cases: [caseFor('parallel', 8), caseFor('followup')] };
const nativeTree = stage => [{ path: 'Studio', type: 'directory' },
  ...nativeStages[stage].studioTree.map(entry => ({ path: `Studio/${entry.name}`, type: entry.type }))]
  .filter(entry => stage !== 'before' || entry.path !== 'Studio')
  .sort((left, right) => left.path.localeCompare(right.path, 'en'));
const comparableRow = row => Object.fromEntries(Object.entries(row)
  .filter(([key]) => !['Id', 'DateCreated', 'DateModified'].includes(key))
  .map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : typeof value === 'boolean' ? Number(value) : value]));
const dialects = process.env.MEDIAMANAGER_STUDIO_CONCURRENCY_DIALECT
  ? [process.env.MEDIAMANAGER_STUDIO_CONCURRENCY_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid Studio concurrency dialect.');

for (const dialect of dialects) {
  test(`${dialect}: simultaneous Studio GETs match frozen response and one-row side effect`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    let identity;
    const actual = await recordItemFilterCandidate({
      dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'studio-concurrency', fields: 'SortName', captureStartIndex: true,
      trackFilesystem: true, captureCaseStages: true, captureResponseBodies: true,
      prepareScenario({ programDataPath }) {
        identity = nativeStudioIdentity(studio, { programDataPath,
          metadataPath: path.join(programDataPath, 'metadata') });
      },
    });

    assertCandidateIdentityMatchesNative(identity.Id, nativeStages.watched[0].id,
      `${dialect}:Concurrent Alpha`);
    assert.equal(actual.httpCases, nativeHttp.records.length);
    await writeCompleteIdentityHttpEvidence(actual, nativeHttp, { scenarioName: 'studio-concurrency' });
    const endpoints = actual.cases.flatMap(item => item.endpoints);
    for (const [index, record] of nativeHttp.records.entries()) {
      const observed = endpoints[index].contract;
      const expected = record.response.bodyJson;
      assert.equal(observed.status, record.response.status, record.name);
      assert.equal(observed.contentType, record.response.contentType, record.name);
      assert.equal(observed.totalRecordCount, expected.TotalRecordCount, record.name);
      assert.equal(observed.startIndex, expected.StartIndex, record.name);
      assert.equal(observed.keys.length, expected.Items.length, record.name);
    }
    assert.deepEqual(actual.filesystemBeforeReads, nativeTree('before'));
    for (const [index, stageName] of ['afterBatch', 'afterFollowup'].entries()) {
      const stage = actual.caseStages[index];
      const expected = nativeStages[stageName];
      assert.equal(stage.database.BaseItems.length - actual.beforeReads.BaseItems.length,
        expected.database.baseItemsCount - nativeStages.before.database.baseItemsCount, stageName);
      assert.deepEqual(stage.filesystem, nativeTree(stageName), `${dialect}:${stageName}:tree`);
      const observed = stage.database.BaseItems.find(row => idKey(row.Id) === idKey(identity.Id));
      const nativeRow = expected.database.watchedRows[0].row;
      assert.ok(observed, `${dialect}:${stageName}:row`);
      assert.deepEqual(comparableRow(observed), comparableRow(nativeRow), `${dialect}:${stageName}:row`);
      assert.match(observed.DateCreated, /^\d{4}-\d\d-\d\d /u);
      assert.match(observed.DateModified, /^\d{4}-\d\d-\d\d /u);
    }
    assert.deepEqual(actual.filesystemAfterReads, nativeTree('afterFollowup'));
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
    for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(actual.afterReads[table], actual.beforeReads[table], `${dialect}:${table}`);
    }
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
