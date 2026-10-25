import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { loadNativeByNameFilterScenario, projectNativeByNameCandidateInput, seedNativeByNameFilterInput,
  writeCompleteByNameFilterEvidence, assertNativeByNameFilterGetMutation } from './native-byname-filter-scenario.js';

for (const kind of ['genre', 'studio']) {
  const input = JSON.parse(await readFile(new URL(`./fixtures/${kind}-filters/input.json`, import.meta.url), 'utf8'));
  const expected = JSON.parse(await readFile(new URL(`./fixtures/${kind}-filters/native.json`, import.meta.url), 'utf8'));
  const scenario = await loadNativeByNameFilterScenario(kind);
  test(`postgres: ${kind} selectors match all 68 complete native Items responses`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: projectNativeByNameCandidateInput(input),
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: `${kind}-filter`, fields: 'ParentId',
      captureResponseBodies: true, captureOrder: true, captureParentItems: true, captureStartIndex: true, trackFilesystem: true,
      prepareScenario: context => seedNativeByNameFilterInput(context, scenario) });
    assert.equal(actual.cases.length, 34);
    assert.equal(actual.httpCases, 68);
    assert.deepEqual(actual.cases.map(entry => entry.name), expected.cases.map(entry => entry.name));
    for (const [index, entry] of actual.cases.entries()) {
      const native = expected.cases[index];
      assert.equal(entry.query, native.query);
      assert.deepEqual(entry.scope, native.scope);
      assert.deepEqual(entry.endpoints.map(response => response.endpoint), native.endpoints);
    }
    await writeCompleteByNameFilterEvidence(actual, scenario, { scenarioName: `${kind}-filter` });
    assertNativeByNameFilterGetMutation(actual, scenario);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
  });
}
