import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/directory-native-validation/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('native directory validation fixture is sealed and complete', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenDirectoryNativeValidation, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 47);
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) {
    assert.deepEqual(Object.keys(result).sort(), ['ancestors', 'calls', 'columns', 'createdLookup', 'exception', 'files', 'links',
      'name', 'oldLookupName', 'parentChildrenCleared', 'parentUserDataCleared', 'providers', 'resolved', 'rows'].sort());
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: actual Folder validation ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name)));
