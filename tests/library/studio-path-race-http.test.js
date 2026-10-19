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

const evidenceRoot = validationFileUrl('../../.agent-docs/evidence/identity-inputs/studio-path-race-native-v1/', import.meta.url);
await verifyNativeIdentityEvidence({ evidenceRoot, kind: 'studio', evidenceName: 'studio-path-race-native-v1',
  expectedRunModes: { 'native-run-b': 'race', 'native-run-c': 'race', 'native-run-d': 'race-reverse',
    'native-run-f': 'race-eight', 'native-run-g': 'race-eight-reverse' } });
const fixture = JSON.parse(await readFile(validationFileUrl('./fixtures/studio-filters/input.json', import.meta.url), 'utf8'));
const runs = await Promise.all(['b', 'c', 'd', 'f', 'g'].map(async suffix => {
  const evidence = new URL(`native-run-${suffix}/`, evidenceRoot);
  const [summary, http, stages] = await Promise.all(['summary.json', 'native-http.json', 'stages.json']
    .map(name => readFile(validationFileUrl(name, evidence), 'utf8').then(JSON.parse)));
  const recorder = ({ d: 'record-reverse-native.mjs', f: 'record-eight-native.mjs',
    g: 'record-eight-reverse-native.mjs' })[suffix] ?? 'record-native.mjs';
  assert.equal(summary.passed, true, suffix);
  assert.equal(createHash('sha256').update(await readFile(validationFileUrl(`../${recorder}`, evidence))).digest('hex'),
    summary.recorderSha256, suffix);
  assert.equal(http.records.length, ['f', 'g'].includes(suffix) ? 10 : 4, suffix);
  assert.deepEqual(stages.before.database.foreignKeyCheck, [], suffix);
  for (const stage of ['afterBatch', 'afterFollowup', 'afterShutdown']) {
    assert.deepEqual(stages[stage].database.foreignKeyCheck, [], `${suffix}:${stage}`);
    assert.equal(stages[stage].database.baseItemsCount - stages.before.database.baseItemsCount, 1, `${suffix}:${stage}`);
    assert.deepEqual(stages[stage].studioTree.map(entry => [entry.name, entry.type]),
      [['Mirror A', 'directory']], `${suffix}:${stage}`);
  }
  assert.equal(stages.watched[0].id, stages.watched[1].id, suffix);
  assert.ok(stages.watched.some(entry => entry.name === stages.afterBatch.database.watchedRows[0].row.Name), suffix);
  assert.deepEqual(stages.afterBatch.database, stages.afterFollowup.database, suffix);
  return { suffix, http, stages };
}));

const nativeTree = (stages, stage) => [{ path: 'Studio', type: 'directory' },
  ...stages[stage].studioTree.map(entry => ({ path: `Studio/${entry.name}`, type: entry.type }))]
  .filter(entry => stage !== 'before' || entry.path !== 'Studio')
  .sort((left, right) => left.path.localeCompare(right.path, 'en'));
const comparableRow = row => Object.fromEntries(Object.entries(row)
  .filter(([key]) => !['Id', 'DateCreated', 'DateModified'].includes(key))
  .map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : typeof value === 'boolean' ? Number(value) : value]));
const allowedRows = runs.map(run => comparableRow(run.stages.afterBatch.database.watchedRows[0].row));
assert.equal(new Set(allowedRows.map(row => row.Name)).size, 2, 'Both colliding names must be observed as native winners.');
const dialects = process.env.MEDIAMANAGER_STUDIO_PATH_RACE_DIALECT
  ? [process.env.MEDIAMANAGER_STUDIO_PATH_RACE_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid Studio path-race dialect.');

for (const { suffix, http, stages } of runs) {
  const parallelNames = http.records.slice(0, -2).map(record => record.studio);
  const names = http.records.slice(-2).map(record => record.studio);
  const scenario = { ...fixture, cases: [
    { name: 'parallel', query: `Studios=${encodeURIComponent(names[0])}`,
      parallelQueries: parallelNames.map(name => `Studios=${encodeURIComponent(name)}`),
      scope: ['rockMapOnly'], omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'] },
    ...names.map((name, index) => ({ name: `followup-${index + 1}`,
      query: `Studios=${encodeURIComponent(name)}`, scope: ['rockMapOnly'], omitParentId: true,
      recursive: null, omitSortBy: true, endpoints: ['items'] })),
  ] };
  for (const dialect of dialects) {
    test(`${dialect}: colliding Studio names match frozen concurrent run ${suffix}`, {
      skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
    }, async () => {
      let identity;
      const actual = await recordItemFilterCandidate({
        dialect, fixture: scenario, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        scenarioName: `studio-path-race-${suffix}`, fields: 'SortName', captureStartIndex: true,
        trackFilesystem: true, captureCaseStages: true, captureResponseBodies: true,
        prepareScenario({ programDataPath }) {
          const options = { programDataPath, metadataPath: path.join(programDataPath, 'metadata') };
          identity = nativeStudioIdentity(names[0], options);
          assert.equal(identity.Id, nativeStudioIdentity(names[1], options).Id);
        },
      });
      assertCandidateIdentityMatchesNative(identity.Id, stages.watched[0].id,
        `${dialect}:studio-path-race-${suffix}`);
      assert.equal(actual.httpCases, http.records.length);
      await writeCompleteIdentityHttpEvidence(actual, http, { scenarioName: `studio-path-race-${suffix}` });
      const endpoints = actual.cases.flatMap(item => item.endpoints);
      for (const [index, record] of http.records.entries()) {
        const observed = endpoints[index].contract;
        const expected = record.response.bodyJson;
        assert.equal(observed.status, record.response.status, `${suffix}:${record.name}`);
        assert.equal(observed.contentType, record.response.contentType, `${suffix}:${record.name}`);
        assert.equal(observed.totalRecordCount, expected.TotalRecordCount, `${suffix}:${record.name}`);
        assert.equal(observed.startIndex, expected.StartIndex, `${suffix}:${record.name}`);
        assert.equal(observed.keys.length, expected.Items.length, `${suffix}:${record.name}`);
      }
      assert.deepEqual(actual.filesystemBeforeReads, nativeTree(stages, 'before'));
      for (const [index, stageName] of ['afterBatch', 'afterFollowup', 'afterFollowup'].entries()) {
        const stage = actual.caseStages[index];
        assert.equal(stage.database.BaseItems.length - actual.beforeReads.BaseItems.length, 1);
        assert.deepEqual(stage.filesystem, nativeTree(stages, stageName), `${dialect}:${suffix}:${stageName}:tree`);
        const observed = stage.database.BaseItems.find(row => idKey(row.Id) === idKey(identity.Id));
        assert.ok(observed, `${dialect}:${suffix}:${stageName}:row`);
        assert.ok(allowedRows.some(row => {
          try { assert.deepEqual(comparableRow(observed), row); return true; }
          catch { return false; }
        }), `${dialect}:${suffix}:${stageName}:row was not either frozen native row`);
        if (index > 0) assert.deepEqual(stage.database.BaseItems, actual.caseStages[0].database.BaseItems,
          `${dialect}:${suffix}:${stageName}:followups must not rewrite the winner`);
      }
      assert.deepEqual(actual.filesystemAfterReads, nativeTree(stages, 'afterFollowup'));
      assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
      for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
        assert.deepEqual(actual.afterReads[table], actual.beforeReads[table], `${dialect}:${suffix}:${table}`);
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
}
