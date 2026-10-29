import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const input = JSON.parse(await readFile(new URL('./fixtures/genre-filters/input.json', import.meta.url), 'utf8'));
const nativeUrl = new URL('./fixtures/genre-filters/native.json', import.meta.url);
const native = JSON.parse(await readFile(nativeUrl, 'utf8'));
const expectedByName = new Map(native.cases.map(entry => [entry.name, entry]));
const expectedHttpCases = native.cases.reduce((total, entry) => total + entry.endpoints.length, 0);
const requestedDialect = process.env.MEDIAMANAGER_GENRE_FILTER_DIALECT;
if (requestedDialect !== undefined && !['postgres'].includes(requestedDialect)) {
  throw new Error(`Unknown MEDIAMANAGER_GENRE_FILTER_DIALECT: ${requestedDialect}.`);
}
const dialects = requestedDialect ? [requestedDialect] : ['postgres'];

function responseProjection(contract) {
  return {
    status: contract.status,
    contentType: contract.contentType,
    startIndex: contract.startIndex,
    totalRecordCount: contract.totalRecordCount,
    keys: contract.keys,
    orderedKeys: contract.orderedKeys,
    items: contract.items,
    problem: contract.problem,
  };
}

for (const dialect of dialects) {
  test(`${dialect}: genre-filter Items requests match frozen Jellyfin`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect,
      fixture: input,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'genre-filter',
      fields: 'ParentId',
      captureOrder: true,
      captureParentItems: true,
      captureStartIndex: true,
    });
    assert.equal(expectedByName.size, native.cases.length);
    assert.equal(actual.cases.length, native.cases.length);
    assert.equal(actual.httpCases, expectedHttpCases);
    assert.deepEqual(actual.cases.map(entry => entry.name), native.cases.map(entry => entry.name));
    for (const actualCase of actual.cases) {
      const expected = expectedByName.get(actualCase.name);
      const source = input.cases.find(entry => entry.name === actualCase.name);
      assert.ok(expected, actualCase.name);
      assert.ok(source, actualCase.name);
      assert.equal(actualCase.query, source.query, actualCase.name);
      assert.deepEqual(actualCase.scope, source.scope, actualCase.name);
      assert.equal(actualCase.parentKey ?? null, expected.parentKey, actualCase.name);
      assert.equal(actualCase.auth, source.auth ?? 'user', actualCase.name);
      const controlDefaults = {
        omitScope: false,
        omitParentId: false,
        omitIds: false,
        recursive: true,
        omitSortBy: false,
        assertOrder: false,
        expectedStatus: 200,
      };
      for (const [field, fallback] of Object.entries(controlDefaults)) {
        assert.equal(Object.hasOwn(actualCase, field) ? actualCase[field] : fallback,
          expected[field], `${actualCase.name}:${field}`);
      }
      assert.deepEqual(actualCase.endpoints.map(entry => entry.endpoint), expected.endpoints, actualCase.name);
      for (const endpoint of actualCase.endpoints) {
        assert.deepEqual(responseProjection(endpoint.contract), responseProjection(expected),
          `${dialect}:${actualCase.name}:${endpoint.endpoint}`);
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads, `${dialect}: item tables changed during HTTP reads`);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
