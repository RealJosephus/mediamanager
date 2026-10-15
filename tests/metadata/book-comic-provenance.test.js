import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const consumerProvenanceFile = new URL('./fixtures/book-comic/image-consumer/provenance.json', import.meta.url);
const rar4ProvenanceFile = new URL('../../src/storage/resources/archive-codec-rar4.provenance.json', import.meta.url);
const rar5ProvenanceFile = new URL('../../src/storage/resources/archive-codec-rar5-provenance.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function verify(descriptor, folder) {
  const location = descriptor.path ?? descriptor.filename;
  assert.ok(location && descriptor.sha256);
  const bytes = await readFile(path.isAbsolute(location) ? location : new URL(location, folder));
  assert.equal(bytes.length, descriptor.bytes, location); assert.equal(hash(bytes), descriptor.sha256, location);
}

test('Comic saved-image consumer evidence binds six actual file and SQLite outcomes to native source and runtime', async () => {
  const proof = JSON.parse(await readFile(consumerProvenanceFile));
  assert.equal(proof.caseCount, 6); assert.ok(proof.requiredInputs.length > 100);
  for (const descriptor of proof.requiredInputs) await verify(descriptor, new URL('./', consumerProvenanceFile));
  const native = JSON.parse(await readFile(new URL('native.json', consumerProvenanceFile)));
  for (const sample of native.results) {
    assert.equal(sample.refreshError, null); assert.equal(sample.updateError, null);
    assert.equal(sample.refresh.update, 5); assert.equal(sample.refresh.Failures, 0);
    assert.equal(sample.rows.length, 1); assert.equal(sample.images.length, 1); assert.equal(sample.files.length, 1);
    assert.equal(sample.files[0].sha256, sample.selected.sha256);
    assert.equal(sample.rows[0].Path, sample.files[0].path);
    if (!sample.name.startsWith('Rar.rar-')) {
      assert.equal(sample.rows[0].Width, 0); assert.equal(sample.rows[0].Height, 0); assert.equal(sample.rows[0].Blurhash, '');
    }
  }
});

test('RAR4 and RAR5 codec adaptations bind every declared required input and local resource', async () => {
  for (const location of [rar4ProvenanceFile, rar5ProvenanceFile]) {
    const proof = JSON.parse(await readFile(location)), folder = new URL('./', location);
    assert.ok(proof.requiredInputs.length > 0);
    for (const descriptor of [...proof.requiredInputs, ...proof.files ?? []]) await verify(descriptor, folder);
  }
});
