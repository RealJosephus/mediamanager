import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyItemMetadataUpdate } from '../../src/metadata/item-update.js';
import { bindItemUpdate } from '../../src/http/item-update-binding.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/audiobook-item-update/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const hash = value => createHash('sha256').update(value).digest('hex');
test('native book edit binds actual controller and the two interface inheritance cases', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 10); assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
});
test('book edit comparison rejects suppressed inherited artists and false Book artist support', () => {
  const expected = native.results.find(value => value.name === 'AudioBook-artists').value;
  assert.throws(() => assert.deepEqual({ Artists: [], AlbumArtists: [], Album: null },
    { Artists: expected.Artists, AlbumArtists: expected.AlbumArtists, Album: expected.Album }), assert.AssertionError);
  const book = native.results.find(value => value.name === 'Book-artists').value;
  assert.throws(() => assert.deepEqual({ ...book, Artists: expected.Artists }, book), assert.AssertionError);
});
for (const sample of input) test(`native ${sample.name} metadata edit`, async t => {
  const expected = native.results.find(value => value.name === sample.name);
  const item = { Type: sample.type, Name: 'Stored title', Genres: ['Old genre'], Tags: ['Old', 'keep'], Studios: ['Old studio'],
    ProductionLocations: ['Old country'], ProviderIds: { Custom: 'old' }, LockedFields: ['Name'], IsLocked: true,
    ...(sample.type === 'AudioBook' ? { Artists: [], AlbumArtists: [], Album: null } : {}) };
  let error = null;
  try { await applyItemMetadataUpdate(item, bindItemUpdate(parseLosslessJson(sample.json), sample.json)); }
  catch (failure) { error = { name: failure.name, message: failure.message, status: failure.status, stack: failure.stack }; }
  observeComparison(t, sample.name + ' metadata edit failure', error, expected.error ?? null);
  assert.equal(error != null, expected.error != null);
  if (error) return;
  const projection = value => Object.fromEntries(['Artists', 'AlbumArtists', 'Album'].filter(field => value[field] != null).map(field => [field, value[field]]));
  assert.deepEqual(projection(item), projection(expected.value));
});
