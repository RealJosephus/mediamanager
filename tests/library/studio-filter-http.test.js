import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const input = JSON.parse(await readFile(new URL('./fixtures/studio-filters/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/studio-filters/native.json', import.meta.url), 'utf8'));
const expected = JSON.parse(await readFile(new URL('./fixtures/studio-filters/expected.json', import.meta.url), 'utf8'));
const byName = new Map(native.cases.map(entry => [entry.name, entry]));
const requestedDialect = process.env.MEDIAMANAGER_STUDIO_FILTER_DIALECT;
if (requestedDialect !== undefined && !['postgres'].includes(requestedDialect)) {
  throw new Error(`Unknown MEDIAMANAGER_STUDIO_FILTER_DIALECT: ${requestedDialect}.`);
}
const dialects = requestedDialect ? [requestedDialect] : ['postgres'];
const response = source => Object.fromEntries(
  ['status', 'contentType', 'startIndex', 'totalRecordCount', 'keys', 'orderedKeys', 'items', 'problem']
    .map(field => [field, source[field]]));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

for (const dialect of dialects) {
  test(`${dialect}: Studio Items filters and GET mutations match frozen Jellyfin`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect, fixture: input, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'studio-filter', fields: 'ParentId', captureOrder: true,
      captureParentItems: true, captureStartIndex: true, trackFilesystem: true,
    });
    assert.equal(actual.cases.length, input.cases.length);
    assert.equal(actual.httpCases, input.cases.reduce((sum, entry) => sum + (entry.endpoints ?? ['items', 'legacy']).length, 0));
    for (const entry of actual.cases) {
      const pinned = byName.get(entry.name);
      assert.ok(pinned, entry.name);
      assert.deepEqual(entry.endpoints.map(value => value.endpoint), pinned.endpoints, entry.name);
      for (const endpoint of entry.endpoints) {
        assert.deepEqual(response(endpoint.contract), response(pinned), `${dialect}:${entry.name}:${endpoint.endpoint}`);
      }
    }
    const before = actual.beforeReads, after = actual.afterReads;
    const originalIds = new Set(before.BaseItems.map(item => idKey(item.Id)));
    const added = after.BaseItems.filter(item => !originalIds.has(idKey(item.Id)));
    assert.equal(after.BaseItems.length, before.BaseItems.length + expected.mutations.baseItemsAdded.length);
    assert.deepEqual(added.map(item => ({
      name: item.Name,
      cleanName: item.CleanName,
      pathSuffix: item.Path.replaceAll('\\', '/').split('/').slice(1).join('/'),
    })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
    [...expected.mutations.baseItemsAdded].sort((a, b) => a.name.localeCompare(b.name, 'en')));
    assert.ok(added.every(item => item.Type === 'MediaBrowser.Controller.Entities.Studio'));
    for (const table of Object.keys(before).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(after[table], before[table], `${dialect}:${table}`);
    }
    assert.deepEqual(actual.filesystemBeforeReads, []);
    assert.deepEqual(actual.filesystemAfterReads.map(entry => entry.path).sort(),
      [...expected.mutations.directoriesAdded].sort());
    assert.ok(actual.filesystemAfterReads.every(entry => entry.type === 'directory'));
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, input.cases
      .filter(entry => (entry.expectedStatus ?? 200) >= 400)
      .flatMap(entry => (entry.endpoints ?? ['items', 'legacy']).map(endpoint => ({
        caseName: entry.name, endpoint, error: { name: 'Error', message: 'Error processing request.' },
      }))));
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
