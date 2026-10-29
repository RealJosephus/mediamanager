import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const input = JSON.parse(await readFile(new URL('./fixtures/person-filters/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/person-filters/native.json', import.meta.url), 'utf8'));
// The native recorder seeds raw SQL CleanName with Name.toLowerCase().
const candidateInput = { ...input,
  items: input.items.map(item => ({ ...item, cleanName: item.name.toLowerCase() })) };
const expectedByName = new Map(native.cases.map(entry => [entry.name, entry]));
const expectedHttpCases = native.cases.reduce((total, entry) => total + entry.endpoints.length, 0);

function expectedContract(entry) {
  return {
    status: entry.status,
    contentType: entry.contentType,
    totalRecordCount: entry.totalRecordCount,
    keys: entry.keys,
    ...(entry.orderedKeys ? { orderedKeys: entry.orderedKeys, sortNames: entry.sortNames } : {}),
    ...(entry.errorText !== undefined ? { errorText: entry.errorText } : {}),
    problem: entry.problem,
  };
}

for (const dialect of ['postgres']) {
  test(`${dialect}: ${native.cases.length} person-filter cases / ${expectedHttpCases} Items requests match frozen Jellyfin`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect,
      fixture: candidateInput,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'person-filter',
      captureSortNames: true,
      captureErrorText: true,
    });
    assert.equal(actual.cases.length, native.cases.length);
    assert.equal(actual.httpCases, expectedHttpCases);
    for (const actualCase of actual.cases) {
      const expected = expectedByName.get(actualCase.name);
      assert.ok(expected, actualCase.name);
      assert.equal(actualCase.query, expected.query, actualCase.name);
      assert.deepEqual(actualCase.scope, expected.scope, actualCase.name);
      assert.equal(actualCase.parentKey, expected.parentKey, actualCase.name);
      assert.equal(actualCase.auth, expected.auth, actualCase.name);
      assert.deepEqual(actualCase.endpoints.map(entry => entry.endpoint), expected.endpoints, actualCase.name);
      for (const endpoint of actualCase.endpoints) {
        assert.deepEqual(endpoint.contract, expectedContract(expected), `${dialect}:${actualCase.name}:${endpoint.endpoint}`);
        if (expected.orderedKeys) {
          assert.deepEqual(endpoint.contract.orderedKeys, expected.orderedKeys,
            `${dialect}:${actualCase.name}:${endpoint.endpoint}:order`);
          assert.deepEqual(endpoint.contract.sortNames, expected.sortNames,
            `${dialect}:${actualCase.name}:${endpoint.endpoint}:SortName`);
        }
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads, `${dialect}: media and people tables changed during HTTP reads`);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
