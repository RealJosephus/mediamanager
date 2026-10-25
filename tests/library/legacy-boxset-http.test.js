import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const fixtureUrl = new URL('./fixtures/legacy-boxset/input.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeBytes = await readFile(new URL('./fixtures/legacy-boxset/native.json', import.meta.url));
assert.equal(sha256(nativeBytes), '1859fef2b8c1fef4411dfe0898eb9d7ae0969574b981543f4c21ef68f24a6c61');
const native = JSON.parse(nativeBytes.toString('utf8'));
assert.equal(native.format, 1);
assert.equal(native.frozenJellyfin, true);
assert.equal(sha256(await readFile(fixtureUrl)), native.trackedInputSha256);
const { http, stages, summary } = native;
const normalize = value => Array.isArray(value) ? value.map(normalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, normalize(entry)])) : value;
assert.equal(summary.passed, true);
assert.equal(summary.cases, 185);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(native.sourceBindings.find(file => file.path.endsWith('/record-native.mjs')).sha256, summary.recorderSha256);
// Verify both the tracked fixture and the byte-exact native input snapshot.
const recordedFixtureBytes = Buffer.from(native.recordedFixtureText, 'utf8');
assert.equal(sha256(recordedFixtureBytes), summary.fixtureSha256);
assert.equal(sha256(await readFile(fixtureUrl)), summary.fixtureSha256);
assert.deepEqual(fixture, JSON.parse(recordedFixtureBytes.toString('utf8')));
assert.deepEqual(stages.before, stages.afterReads);
assert.deepEqual(stages.before, stages.afterShutdown);
assert.deepEqual(stages.before.database.foreignKeyCheck, []);
assert.equal(stages.before.database.linkedChildren.length, fixture.links.length);
const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
// HTTP accounts are created in isolation. Only this known account identity is
// mapped in an Unauthorized response; item/library names remain significant.
const expectedProblem = response => response.status < 400 ? null
  : response.bodyJson && typeof response.bodyJson === 'object' ? normalize(response.bodyJson)
    : { rawBody: response.bodyText.replaceAll('CoreFlowAdmin', 'FilterAdmin') };
const cases = fixture.cases.map(item => {
  item = { ...item };
  const records = http.records.filter(record => record.name === item.name);
  const expectedStatus = records[0].response.status;
  if (item.endpoints?.includes('detail')) return item;
  assert.ok(records.every(record => record.response.status === expectedStatus), item.name);
  return { ...item, expectedStatus, expectRuntimeError: false };
});
const dialects = process.env.MEDIAMANAGER_LEGACY_BOXSET_DIALECT
  ? [process.env.MEDIAMANAGER_LEGACY_BOXSET_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid legacy-boxset dialect.');

for (const dialect of dialects) {
  test(`${dialect}: legacy/modern BoxSet children, sorting and policies match 185 frozen HTTP responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect, fixture: { ...fixture, cases }, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'legacy-boxset', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, trackFilesystem: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath }) => {
        const paths = {
          userRoot: path.join(programDataPath, 'root/default'), physicalA: path.join(programDataPath, 'library-content/A'),
          physicalB: path.join(programDataPath, 'library-content/B'), collections: path.join(programDataPath, 'data/collections'),
          libraryA: path.join(programDataPath, 'root/default/Library A'), libraryB: path.join(programDataPath, 'root/default/Library B'),
          collectionLibrary: path.join(programDataPath, 'root/default/Collection Library'),
        };
        const dataRoot = path.join(programDataPath, 'data');
        const itemPath = item => {
          if (paths[item.pathKind]) return paths[item.pathKind];
          if (item.pathKind === 'noPath') return null;
          if (item.pathKind === 'dataExact') return dataRoot;
          if (item.pathKind === 'dataTrailing') return dataRoot + path.sep;
          if (item.pathKind === 'dataEscape') return dataRoot + path.sep + '..' + path.sep + item.key;
          // The Windows recording addresses the same owned data directory
          // with a case variant. Preserve that location on case-sensitive hosts.
          if (item.pathKind === 'dataUpper') return (process.platform === 'win32' ? dataRoot.toUpperCase() : dataRoot) + path.sep + item.key;
          if (item.pathKind === 'dataSibling') return dataRoot + '-sibling' + path.sep + item.key;
          if (item.pathKind === 'boxset') return path.join(paths.collections, item.key);
          if (item.pathKind === 'child') {
            const parent = fixture.items.find(row => row.id === item.parentId);
            return path.join(itemPath(parent) ?? paths.physicalA, item.key + (item.type === 'Movie' ? '.mkv' : ''));
          }
          return path.join(paths.physicalA, item.key);
        };
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const native = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
          const data = { ...(item.data ?? {}) };
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
            .map(id => itemPath(fixture.items.find(child => child.id === id)));
          assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() }, {
            Path: itemPath(item), Data: JSON.stringify(data), CommunityRating: native.CommunityRating,
            PremiereDate: item.premiereDate ?? null, ProductionYear: item.productionYear ?? null,
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
    if (process.env.MEDIAMANAGER_LEGACY_BOXSET_EVIDENCE) {
      const output = path.resolve(process.env.MEDIAMANAGER_LEGACY_BOXSET_EVIDENCE);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, `${dialect}.json`), JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), JSON.stringify({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: http.records.length,
        comparedFields: ['status', 'contentType', 'TotalRecordCount', 'StartIndex', 'ordered identities', 'SortName',
          'list ProblemDetails/Unauthorized body', 'detail identity/name/tags'],
        normalization: 'Only list ProblemDetails.traceId and the known CoreFlowAdmin/FilterAdmin account alias are normalized. Fixed fixture identities map to keys.',
        native: summary, differences,
      }, null, 2) + '\n', { flag: 'wx' });
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
    assert.deepEqual(differences, []);
  });
}
