import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resizeNearestPixels } from '../../src/images/renderer.js';
import { encodeBlurhash } from '../../src/images/blurhash.js';
import { ImageProcessor } from '../../src/images/processor.js';

const proofUrl = new URL('./fixtures/blurhash-resampling/provenance.json', import.meta.url);
const root = new URL('.', proofUrl);
const proof = JSON.parse(await readFile(proofUrl));
const native = JSON.parse(await readFile(new URL('native.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samples = new Map(native.results.map(sample => [sample.name, sample]));
async function pixels(name, kind) {
  const descriptor = proof.pixels.find(file => file.name === name && file.kind === kind);
  const bytes = gunzipSync(await readFile(new URL(descriptor.path, root)));
  assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256);
  return bytes;
}

test('resampling evidence binds actual source, runtime, native inputs and exact RGBA bytes', async () => {
  assert.equal(native.actualExecution, true);
  assert.equal(native.results.length, 10);
  assert.equal(proof.runtimeSha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  for (const file of proof.files) {
    const bytes = await readFile(new URL(file.path, root));
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
  }
  for (const file of proof.requiredInputs) {
    assert.equal(file.required, true);
    const bytes = await readFile(file.path);
    assert.equal(bytes.length, file.bytes, file.path); assert.equal(hash(bytes), file.sha256, file.path);
  }
});

for (const sample of native.results) {
  test('native nearest scaled RGBA: ' + sample.name, async () => {
    const decoded = await pixels(sample.name, 'decoded'), expected = await pixels(sample.name, 'scaled');
    assert.equal(decoded.length, sample.decoded.Width * sample.decoded.Height * 4);
    assert.equal(sample.decoded.RowBytes, sample.decoded.Width * 4);
    const actual = resizeNearestPixels(decoded, sample.decoded.Width, sample.decoded.Height,
      sample.scaled.Width, sample.scaled.Height);
    assert.deepEqual(actual, expected);
    assert.equal(encodeBlurhash(actual, sample.scaled.Width, sample.scaled.Height, sample.components.xc, sample.components.yc), sample.core);
    assert.equal(sample.core, sample.direct);
  });
}

for (const input of proof.inputs.filter(file => proof.fullImageFormats.includes(file.name.split('.').at(-1)))) {
  test('native complete image BlurHash: ' + input.name, async () => {
    const sample = samples.get(input.name), bytes = await readFile(new URL(input.path, root));
    assert.equal(hash(bytes), input.sha256);
    const processor = new ImageProcessor();
    try {
      const size = await processor.getImageSize(bytes, input.name);
      assert.deepEqual(size, sample.original);
      assert.equal(await processor.getImageBlurHash(bytes, input.name, size), sample.direct);
    } finally { await processor.close(); }
  });
}
