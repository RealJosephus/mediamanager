import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-traversal/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance, versionNative] = await Promise.all([
  ...['input.json', 'native.json', 'provenance.json'].map(file => new URL(file, root)),
  new URL('./fixtures/folder-version-reconciliation/native.json', import.meta.url)
].map(async file => parseLosslessJson(await readFile(file, 'utf8'))));

const rootCaseNames = [
  'aggregate-empty-root-cancelled',
  'aggregate-missing-root',
  'aggregate-missing-root-cancelled',
  'ordinary-empty-folder-cancelled',
  'collections-empty-root-cancelled',
  'boxset-empty-root-cancelled',
  'boxset-empty-root-cleanup',
  'collections-empty-root-cleanup',
  'allow-remove-empty-root-still-protected',
  'boxset-allow-remove-empty-root-protected'
];
const rootSamples = input.slice(66, 76);

test('folder traversal oracle preserves the prior 66 cases and seals native root-access ordering', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenFolderTraversal, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(input.length, 82);
  assert.equal(provenance.original66ResultsUnchanged, true);
  assert.deepEqual(native.results.slice(0, 66), versionNative.results);
  assert.deepEqual(rootSamples.map(sample => sample.name), rootCaseNames);
  assert.deepEqual(native.results.slice(66, 76).map(result => result.name), rootCaseNames);

  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results.slice(66, 76)) {
    assert.ok(result.beforeItem);
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
});

for (const dialect of ['postgres']) for (const sample of rootSamples) test(`${dialect}: native Folder root accessibility ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name),
  { reconciliation: true }));
