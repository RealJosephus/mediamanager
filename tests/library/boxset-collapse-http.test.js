import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const fixtureUrl = new URL('./fixtures/boxset-collapse/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeBytes = await readFile(new URL('./fixtures/boxset-collapse/native.json', import.meta.url));
assert.equal(sha256(nativeBytes), 'f36dc43e347af63aa1e704846e7265bcceda2908dab811eb3ca1f11a99ce7a59');
const native = JSON.parse(nativeBytes.toString('utf8'));
assert.equal(native.format, 1);
assert.equal(native.frozenJellyfin, true);
assert.equal(sha256(await readFile(fixtureUrl)), native.trackedInputSha256);
assert.equal(sha256(Buffer.from(native.recordedFixtureText, 'utf8')), native.summary.fixtureSha256);
assert.deepEqual(fixture, JSON.parse(native.recordedFixtureText));
const { http: nativeHttp, stages: nativeStages, summary: nativeSummary } = native;
const normalizeProblem = value => Array.isArray(value) ? value.map(normalizeProblem)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId')
      .map(([key, item]) => [key, normalizeProblem(item)])) : value;
assert.equal(nativeSummary.passed, true);
assert.equal(nativeSummary.cases, 320);
assert.deepEqual(nativeSummary.processResult, { code: 0, signal: null });
assert.equal(nativeSummary.portAvailable, true);
assert.equal(native.sourceBindings.find(file => file.path.endsWith('/record-native.mjs')).sha256, nativeSummary.recorderSha256);
assert.equal(sha256(await readFile(fixtureUrl)), nativeSummary.fixtureSha256);
assert.equal(nativeHttp.records.length, 320);
assert.deepEqual(nativeStages.before.database, nativeStages.afterReads.database);
assert.deepEqual(nativeStages.afterReads.database, nativeStages.afterShutdown.database);
assert.deepEqual(nativeStages.before.database.foreignKeyCheck, []);
for (const link of fixture.links) {
  assert.ok(nativeStages.before.database.linkedChildren.some(row =>
    idKey(row.ParentId) === idKey(link.parentId) && idKey(row.ChildId) === idKey(link.childId)
    && row.ChildType === link.childType && row.SortOrder === link.sortOrder));
}

const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
const dialects = process.env.MEDIAMANAGER_BOXSET_COLLAPSE_DIALECT
  ? [process.env.MEDIAMANAGER_BOXSET_COLLAPSE_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid boxset-collapse dialect.');

for (const dialect of dialects) {
  test(`${dialect}: boxset collapsing matches 320 frozen HTTP responses across four configurations`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const differences = [];
    for (const configuration of fixture.configurations) {
      const records = nativeHttp.records.filter(record => record.configuration === configuration.name);
      const actual = await recordItemFilterCandidate({
        dialect,
        fixture,
        connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        configuration: {
          EnableGroupingMoviesIntoCollections: configuration.EnableGroupingMoviesIntoCollections,
          EnableGroupingShowsIntoCollections: configuration.EnableGroupingShowsIntoCollections,
        },
        scenarioName: `boxset-collapse-${configuration.name}`,
        fields: 'SortName',
        captureOrder: true,
        captureStartIndex: true,
        captureSortNames: true,
        trackFilesystem: true,
        prepareScenario: async ({ database, programDataPath }) => {
          const collectionPath = path.join(programDataPath, 'data', 'collections');
          for (const item of fixture.items) {
            if (item.key === 'collections' || item.type === 'BoxSet') {
              assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() }, {
                Path: item.key === 'collections' ? collectionPath : path.join(collectionPath, item.key),
              }), 1n, item.key);
            }
            // The reference clones native Movie/Folder templates. Retain the
            // recorded rating column because it participates in the sort matrix.
            const nativeRow = nativeStages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
            if (nativeRow) assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() },
              { CommunityRating: nativeRow.CommunityRating }), 1n, item.key);
          }
        },
      });
      if (process.env.MEDIAMANAGER_BOXSET_COLLAPSE_EVIDENCE) {
        const output = path.resolve(process.env.MEDIAMANAGER_BOXSET_COLLAPSE_EVIDENCE);
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, `${dialect}-${configuration.name}.json`),
          JSON.stringify(actual, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
      }
      assert.equal(actual.httpCases, records.length);
      assert.equal(actual.cases.length, fixture.cases.length);
      for (const [caseIndex, testCase] of fixture.cases.entries()) {
        for (const [endpointIndex, endpoint] of ['items', 'legacy'].entries()) {
          const native = records[caseIndex * 2 + endpointIndex];
          assert.equal(native.name, testCase.name);
          assert.equal(native.endpoint, endpoint);
          const observed = actual.cases[caseIndex].endpoints[endpointIndex].contract;
          const expected = native.response.bodyJson;
          try {
            assert.equal(observed.status, native.response.status);
            assert.equal(observed.contentType, native.response.contentType);
            assert.equal(observed.totalRecordCount, expected?.TotalRecordCount ?? null);
            assert.equal(observed.startIndex, expected?.StartIndex ?? null);
            assert.deepEqual(observed.orderedKeys, (expected?.Items ?? []).map(item => keyById.get(idKey(item.Id))));
            assert.deepEqual(observed.sortNames, (expected?.Items ?? []).map(item => ({
              key: keyById.get(idKey(item.Id)), value: item.SortName ?? null,
            })));
            assert.deepEqual(observed.problem, native.response.status >= 400 ? normalizeProblem(expected) : null);
          } catch (error) {
            differences.push({ configuration: configuration.name, name: testCase.name, endpoint, message: error.message });
          }
        }
      }
      assert.deepEqual(actual.afterReads, actual.beforeReads);
      assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
      assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
      assert.deepEqual(actual.runtimeErrors, []);
      assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
      assert.deepEqual(actual.cleanup, {
        runtimeClosed: true, databaseClosed: true, portReleased: true,
        postgresSchemasRemoved: dialect === 'postgres' ? true : null,
        programDataDirectoryRemoved: true,
      });
    }
    if (process.env.MEDIAMANAGER_BOXSET_COLLAPSE_EVIDENCE) {
      const output = path.resolve(process.env.MEDIAMANAGER_BOXSET_COLLAPSE_EVIDENCE);
      await writeFile(path.join(output, `${dialect}-comparison.json`), JSON.stringify({
        passed: differences.length === 0,
        phaseAcceptance: false,
        dialect,
        configurations: fixture.configurations.map(configuration => configuration.name),
        casesPerConfiguration: fixture.cases.length,
        comparedResponses: 320,
        comparedFields: ['status', 'contentType', 'TotalRecordCount', 'StartIndex', 'ordered item identities', 'SortName', 'ProblemDetails'],
        normalization: 'Only dynamic ProblemDetails.traceId is removed. Ordered identities map to fixed fixture keys.',
        native: nativeSummary,
        differences,
      }, null, 2) + '\n', { flag: 'wx' });
    }
    assert.deepEqual(differences, []);
  });
}
