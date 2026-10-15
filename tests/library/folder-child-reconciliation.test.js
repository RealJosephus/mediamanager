import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/folder-child-reconciliation/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('physical child reconciliation input, full columns, cache and native faults are sealed', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(provenance.candidateVerified, true);
  assert.equal(native.actualFrozenFolderChildReconciliation, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(input.length, 40);
  assert.ok(input.some(sample => sample.warmNested));
  assert.ok(input.some(sample => sample.cancelFromCleanup));
  assert.ok(input.some(sample => sample.afterCollectionType));
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) {
    assert.ok(result.beforeItem);
    for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
  }
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native physical child reconciliation ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name),
  { reconciliation: true }));
