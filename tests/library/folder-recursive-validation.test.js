import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-traversal/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

const recursiveCaseNames = [
  'recursive-parent-cycle',
  'recursive-new-descendants',
  'recursive-existing-descendants',
  'recursive-child-saver-cancellation',
  'recursive-child-enumeration-failure',
  'recursive-deletion-failure'
];
const recursiveSamples = input.slice(76, 82);

test('recursive Folder validation oracle seals lifecycle, scheduler and independent subtree commits', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenFolderTraversal, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(recursiveSamples.map(sample => sample.name), recursiveCaseNames);
  assert.deepEqual(native.results.slice(76, 82).map(result => result.name), recursiveCaseNames);
  assert.ok(recursiveSamples.every(sample => sample.recursive === true && sample.refreshChildMetadata !== true));

  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results.slice(76, 82)) {
    assert.equal(result.calls[0]?.action, 'refresh-start');
    assert.equal(result.calls.at(-1)?.action, 'refresh-complete');
    assert.ok(result.beforeItem);
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
});

for (const dialect of ['postgres']) for (const sample of recursiveSamples) test(`${dialect}: native recursive Folder validation ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name),
  { reconciliation: true }));
