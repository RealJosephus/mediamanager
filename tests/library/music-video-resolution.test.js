import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { assertDirectoryValidation } from './directory-validation-fixture.js';

const root = new URL('./fixtures/music-video-resolution/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('native MusicVideo resolver and validation input, raw recording and complete columns are sealed', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenMusicVideoResolution, true);
  assert.equal(provenance.candidateVerified, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(input.length, 92);
  assert.ok(input.some(sample => sample.resolveOnly));
  assert.ok(input.some(sample => !sample.resolveOnly));
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native MusicVideo ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => assertDirectoryValidation(t, dialect, sample, native.results.find(result => result.name === sample.name), {
  compare(actual, expected) {
    // Directory enumeration order varies by filesystem. Verify the complete
    // multi-resolver input multiset; chosen versions, saves, links, all columns
    // and every subsequent callback retain their exact recorded order.
    const projection = value => ({ ...value, calls: value.calls.map(call => call.action === 'multi'
      ? { ...call, files: [...call.files].sort() } : call) });
    assert.deepEqual(projection(actual), projection(expected));
  }
}));
