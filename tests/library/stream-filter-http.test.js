import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const input = JSON.parse(await readFile(new URL('./fixtures/stream-filters/input.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('./fixtures/stream-filters/native.json', import.meta.url), 'utf8'));
const expectedByName = new Map(native.cases.map(entry => [entry.name, entry]));
const expectedHttpCases = native.cases.reduce((total, entry) => total + entry.endpoints.length, 0);

function expectedContract(entry, endpoint) {
  const contract = entry.contracts.find(value => value.endpoint === endpoint);
  assert.ok(contract, `${entry.name}:${endpoint}`);
  const { endpoint: _endpoint, ...expected } = contract;
  return expected;
}

for (const dialect of ['postgres']) {
  test(`${dialect}: ${native.cases.length} stream-filter cases / ${expectedHttpCases} Items requests match frozen Jellyfin`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect,
      fixture: input,
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'stream-filter',
      fields: 'MediaStreams',
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
        assert.deepEqual(endpoint.contract, expectedContract(expected, endpoint.endpoint), `${dialect}:${actualCase.name}:${endpoint.endpoint}`);
      }
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads, `${dialect}: media tables changed during HTTP reads`);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true,
      databaseClosed: true,
      portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
