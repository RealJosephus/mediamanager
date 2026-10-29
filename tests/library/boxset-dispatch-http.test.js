import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { projectProblemSummary } from '../helpers/http-problem-summary.js';

const fixtureUrl = new URL('./fixtures/boxset-dispatch/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeBytes = await readFile(new URL('./fixtures/boxset-dispatch/native.json', import.meta.url));
assert.equal(sha256(nativeBytes), '9a8c05755cf59a8487996ddf2a1d0afef4b46e016f7c7cb9532c308981e36a0c');
const native = JSON.parse(nativeBytes.toString('utf8'));
assert.equal(native.format, 1);
assert.equal(native.frozenJellyfin, true);
assert.equal(sha256(await readFile(fixtureUrl)), native.trackedInputSha256);
const { http, stages, summary } = native;
assert.equal(summary.passed, true);
assert.equal(summary.cases, 158);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(native.sourceBindings.find(file => file.path.endsWith('/record-native.mjs')).sha256, summary.recorderSha256);
// Preserve the byte-exact input used by the native recording. The tracked
// fixture has only its extra terminal blank line removed; JSON data is identical.
const recordedFixtureBytes = Buffer.from(native.recordedFixtureText, 'utf8');
assert.equal(sha256(recordedFixtureBytes), summary.fixtureSha256);
assert.deepEqual(fixture, JSON.parse(recordedFixtureBytes.toString('utf8')));
assert.deepEqual(stages.before, stages.afterReads);
assert.deepEqual(stages.before, stages.afterShutdown);
assert.deepEqual(stages.before.database.foreignKeyCheck, []);
assert.equal(stages.before.database.linkedChildren.length, fixture.links.length);
const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
// HTTP accounts are created in isolation. Only this known account identity is
// mapped in an Unauthorized response; item/library names remain significant.
const expectedProblem = response => response.status < 400 ? null
  : response.bodyJson && typeof response.bodyJson === 'object' ? projectProblemSummary(response.bodyJson, response.status)
    : { rawBody: response.bodyText.replaceAll('CoreFlowAdmin', 'FilterAdmin') };
const cases = fixture.cases.map(item => {
  item = { ...item };
  // ParentId is absent on these wire requests. The recorder's default
  // parentKey is inert, so remove that unused fixture selector for replay.
  if (item.omitParentId) delete item.parentKey;
  const records = http.records.filter(record => record.name === item.name);
  const expectedStatus = records[0].response.status;
  if (item.endpoints?.includes('detail')) return { ...item, detailExpectedStatus: expectedStatus };
  assert.ok(records.every(record => record.response.status === expectedStatus), item.name);
  return { ...item, expectedStatus, expectRuntimeError: false };
});
const dialects = process.env.MEDIAMANAGER_BOXSET_DISPATCH_DIALECT
  ? [process.env.MEDIAMANAGER_BOXSET_DISPATCH_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid boxset-dispatch dialect.');

for (const dialect of dialects) {
  test(`${dialect}: collection scope, restricted users and UserViews match 158 limited frozen HTTP summaries`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async t => {
    const actual = await recordItemFilterCandidate({
      dialect, fixture: { ...fixture, cases }, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'boxset-dispatch', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, trackFilesystem: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareInstance: async ({ database }) => {
        const output = path.join(validationOutputRoot(), 'boxset-dispatch-sql-' + randomUUID() + '.jsonl');
        assertValidationOutputChild(output); await mkdir(path.dirname(output), { recursive: true });
        const query = database.client.query;
        let sequence = 0;
        const record = value => appendFileSync(output, JSON.stringify({ ...value, time: new Date().toISOString() }) + '\n');
        database.client.query = async (...args) => {
          const id = ++sequence, text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
          record({ id, phase: 'start', sql: text.slice(0, 512), sqlSha256: sha256(Buffer.from(text)),
            stack: new Error('Actual SQL dispatch').stack });
          try { const value = await query(...args); record({ id, phase: 'settled' }); return value; }
          catch (error) { record({ id, phase: 'failed', error: { name: error.name, code: error.code, message: error.message } }); throw error; }
        };
        t.after(() => { database.client.query = query; });
      },
      prepareScenario: async ({ database, programDataPath }) => {
        const paths = {
          userRoot: path.join(programDataPath, 'root/default'), physicalA: path.join(programDataPath, 'library-content/A'),
          physicalB: path.join(programDataPath, 'library-content/B'), collections: path.join(programDataPath, 'data/collections'),
          libraryA: path.join(programDataPath, 'root/default/Library A'), libraryB: path.join(programDataPath, 'root/default/Library B'),
          collectionLibrary: path.join(programDataPath, 'root/default/Collection Library'),
        };
        const itemPath = item => paths[item.pathKind] ?? (item.pathKind === 'boxset' ? path.join(paths.collections, item.key)
          : item.pathKind === 'view' ? path.join(programDataPath, 'metadata/views', item.key)
            : item.pathKind === 'remote' ? 'https://example.invalid/movie.mkv'
              : item.type === 'Movie' ? path.join(paths[item.topParentId === fixture.items.find(row => row.key === 'physicalA').id
                ? 'physicalA' : 'physicalB'], item.key + '.mkv') : path.join(paths.physicalA, item.key));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const native = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
          const data = { ...(item.data ?? {}) };
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
            .map(id => itemPath(fixture.items.find(child => child.id === id)));
          assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() }, {
            Path: itemPath(item), Data: JSON.stringify(data), CommunityRating: native.CommunityRating,
          }), 1n, item.key);
        }
      },
    });
    const differences = [];
    assert.equal(actual.httpCases, http.records.length);
    for (const [index, item] of actual.cases.entries()) {
      const records = http.records.filter(record => record.name === item.name);
      for (const [endpointIndex, endpoint] of item.endpoints.entries()) {
        const native = records[endpointIndex];
        assert.equal(native.endpoint, endpoint.endpoint);
        const observed = endpoint.contract;
        const expected = native.response.bodyJson;
        try {
          assert.equal(observed.status, native.response.status);
          assert.equal(observed.contentType, native.response.contentType);
          if (endpoint.endpoint === 'detail') {
            assert.equal(observed.key, expected?.Id ? keyById.get(idKey(expected.Id)) : null);
            assert.equal(observed.name, expected?.Name ?? null);
            assert.deepEqual(observed.tags, expected?.Tags ?? null);
          } else {
            assert.equal(observed.totalRecordCount, expected?.TotalRecordCount ?? null);
            assert.equal(observed.startIndex, expected?.StartIndex ?? null);
            assert.deepEqual(observed.orderedKeys, (expected?.Items ?? []).map(row => keyById.get(idKey(row.Id))));
            assert.deepEqual(observed.sortNames, (expected?.Items ?? []).map(row => ({ key: keyById.get(idKey(row.Id)), value: row.SortName ?? null })));
            assert.deepEqual(observed.problem, expectedProblem(native.response));
          }
        } catch (error) { differences.push({ name: cases[index].name, endpoint: endpoint.endpoint, message: error.message }); }
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
    {
      const output = process.env.MEDIAMANAGER_BOXSET_DISPATCH_EVIDENCE
        ? path.resolve(process.env.MEDIAMANAGER_BOXSET_DISPATCH_EVIDENCE)
        : path.join(validationOutputRoot(), 'boxset-dispatch-http-' + dialect + '-' + randomUUID());
      if (!process.env.MEDIAMANAGER_BOXSET_DISPATCH_EVIDENCE) assertValidationOutputChild(output);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, `${dialect}.json`), JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), JSON.stringify({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: http.records.length,
        comparedFields: ['status', 'contentType', 'TotalRecordCount', 'StartIndex', 'ordered identities', 'SortName',
          'limited list ProblemDetails without root trace/Unauthorized body', 'detail identity/name/tags'],
        normalization: 'Limited list summaries omit only the validated root ProblemDetails.traceId; nested values remain literal. This does not prove trace presence or complete HTTP wire equality. The known CoreFlowAdmin/FilterAdmin account alias is projected and fixed identities map to keys.',
        native: summary, differences,
      }, null, 2) + '\n', { flag: 'wx' });
    }
    assert.deepEqual(differences, []);
  });
}
