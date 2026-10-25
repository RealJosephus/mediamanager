import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-version-reconciliation/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance, physicalNative] = await Promise.all([
  ...['input.json', 'native.json', 'provenance.json'].map(file => new URL(file, root)),
  new URL('./fixtures/folder-child-reconciliation/native.json', import.meta.url)
].map(async file => parseLosslessJson(await readFile(file, 'utf8'))));

test('video child reconciliation full columns, preserved physical cases and native boundaries are sealed', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(provenance.candidateVerified, true);
  assert.equal(native.actualFrozenFolderVersionReconciliation, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(input.length, 66);
  assert.deepEqual(native.results.slice(0, 40), physicalNative.results);
  assert.equal(provenance.original40ResultsUnchanged, true);
  assert.equal(provenance.original52ResultsUnchanged, true);
  assert.ok(input.some(sample => sample.failSavedUpdatePath));
  assert.ok(input.some(sample => sample.cancelFromSaver));
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) {
    assert.ok(result.beforeItem);
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native video child reconciliation ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name),
  { reconciliation: true }));

const inTransaction = database => database.inTransaction;

for (const dialect of ['postgres']) for (const [name, expectedPrefixLength, phase] of [
  ['movie-replace-primary', 4, 'replacement reroutes after promotion and before remaining alternate transfer'],
  ['movie-demote-primary', null, 'demotion reroutes after promotion, transfer and old-primary save']
]) test(`${dialect}: Folder validation ${phase}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const sample = input.find(value => value.name === name);
  const expected = native.results.find(value => value.name === name);
  let observed = 0;
  await assertDirectoryValidation(t, dialect, sample, expected, {
    reconciliation: true,
    onReroute: async ({ fromId, toId, argumentsLength, fixture, calls }) => {
      observed += 1;
      assert.equal(argumentsLength, 2, 'Folder validation must not pass its scan token into linked savers.');
      assert.equal(inTransaction(fixture.database), false, 'Linked callbacks must remain outside a database transaction.');
      assert.deepEqual(calls, expected.calls.slice(0, expectedPrefixLength ?? expected.calls.length));
      const [source] = await fixture.database.rows('BaseItems', { where: { Id: fromId } });
      const [target] = await fixture.database.rows('BaseItems', { where: { Id: toId } });
      assert.ok(source && target);
      assert.equal(target.PrimaryVersionId, null);
      if (name.includes('demote')) assert.equal(idKey(source.PrimaryVersionId), idKey(toId));
      else {
        const nextCall = expected.calls[expectedPrefixLength];
        assert.equal(nextCall.action, 'saver');
        assert.notEqual(idKey(nextCall.id), idKey(fromId));
        assert.notEqual(idKey(nextCall.id), idKey(toId));
      }
      return [];
    }
  });
  assert.equal(observed, 1);
});
