import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureCurrentComic, profile, hash } from './fixtures/book-comic-current/capture.js';

test('Comic saved-image consumers retain six current native file and SQLite outcomes', async () => {
  const { consumer } = await captureCurrentComic();
  assert.equal(consumer.results.length, 6);
  for (const sample of consumer.results) {
    assert.equal(sample.refreshError, null); assert.equal(sample.updateError, null);
    assert.equal(sample.refresh.update, 5); assert.equal(sample.refresh.Failures, 0);
    assert.equal(sample.rows.length, 1); assert.equal(sample.images.length, 1); assert.equal(sample.files.length, 1);
    assert.equal(sample.files[0].sha256, sample.selected.sha256);
    assert.equal(sample.rows[0].Path, sample.files[0].path);
    assert.equal(hash(await readFile(sample.actualSource)), sample.sourceSha256);
    assert.equal(hash(await readFile(sample.files[0].path)), sample.selected.sha256);
    if (!sample.name.startsWith('Rar.rar-')) {
      assert.equal(sample.rows[0].Width, 0); assert.equal(sample.rows[0].Height, 0); assert.equal(sample.rows[0].Blurhash, '');
    }
  }
});

test('Comic selected streams bind the shipped codec payload, reviewed sources and original license bundle', async () => {
  const folder = new URL('./fixtures/book-comic/current-profile.json', import.meta.url);
  const required = profile.inputs.filter(entry => ['codecArtifact', 'codecSource', 'codecLicense'].includes(entry.role));
  assert.deepEqual(required.filter(entry => entry.role === 'codecArtifact').map(entry => entry.filename.split('/').at(-1)).sort(),
    ['archive-codec.mjs', 'archive-codec.wasm']);
  for (const entry of required) {
    const bytes = await readFile(new URL(entry.filename, folder));
    assert.equal(bytes.length, entry.bytes, entry.filename);
    assert.equal(hash(bytes), entry.sha256, entry.filename);
  }
});
