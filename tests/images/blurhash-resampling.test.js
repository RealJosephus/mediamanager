import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { resizeNearestPixels } from '../../src/images/renderer.js';
import { encodeBlurhash } from '../../src/images/blurhash.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { captureCurrentNative, recordCandidate, input, assetBytes, hash } from './fixtures/blurhash-current/capture.js';

let native;
before(async () => { ({ native } = await captureCurrentNative()); });
async function pixels(sample, kind) {
  const descriptor = sample[kind], bytes = await readFile(descriptor.path);
  assert.equal(bytes.length, descriptor.bytes);
  assert.equal(hash(bytes), descriptor.sha256);
  return bytes;
}

test('resampling evidence binds current designated libraries, unchanged inputs and normalized RGBA bytes', async () => {
  assert.equal(native.actualExecution, true);
  assert.equal(native.results.length, 10);
  for (const sample of input.images) {
    const bytes = await assetBytes(sample);
    assert.equal(bytes.length, sample.bytes, sample.name);
    assert.equal(hash(bytes), sample.sha256, sample.name);
  }
});

for (const image of input.images) {
  test('native nearest scaled RGBA: ' + image.name, async () => {
    const sample = native.results.find(row => row.name === image.name);
    const decoded = await pixels(sample, 'decoded'), expected = await pixels(sample, 'scaled');
    assert.equal(decoded.length, sample.decoded.Width * sample.decoded.Height * 4);
    const actual = resizeNearestPixels(decoded, sample.decoded.Width, sample.decoded.Height,
      sample.scaled.Width, sample.scaled.Height);
    const blurhash = encodeBlurhash(actual, sample.scaled.Width, sample.scaled.Height, sample.components.xc, sample.components.yc);
    await recordCandidate(image.name + '.nearest', { Width: sample.scaled.Width, Height: sample.scaled.Height,
      sha256: hash(actual), blurhash }, actual);
    assert.deepEqual(actual, expected);
    assert.equal(blurhash, sample.core);
    assert.equal(sample.core, sample.direct);
  });
}

for (const image of input.images) {
  test('native complete image BlurHash: ' + image.name, async () => {
    const sample = native.results.find(row => row.name === image.name), bytes = await assetBytes(image);
    assert.equal(hash(bytes), image.sha256);
    const processor = new ImageProcessor();
    let size, blurhash;
    try {
      size = await processor.getImageSize(bytes, image.name);
      blurhash = await processor.getImageBlurHash(bytes, image.name, size);
    } finally { await processor.close(); }
    await recordCandidate(image.name + '.complete', { size, blurhash });
    if (image.name.endsWith('.jpg')) {
      for (const kernel of ['nearest', 'linear', 'lanczos3']) for (const fastShrinkOnLoad of [false, true]) {
        const name = image.name + '.' + kernel + '.' + (fastShrinkOnLoad ? 'fast' : 'full');
        const decoded = await sharp(bytes, { failOn: 'warning' }).resize(sample.decoded.Width, sample.decoded.Height,
          { kernel, fastShrinkOnLoad }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const scaled = resizeNearestPixels(decoded.data, decoded.info.width, decoded.info.height, sample.scaled.Width, sample.scaled.Height);
        await recordCandidate(name, { decoded: { Width: decoded.info.width, Height: decoded.info.height, sha256: hash(decoded.data) },
          scaled: { Width: sample.scaled.Width, Height: sample.scaled.Height, sha256: hash(scaled) },
          blurhash: encodeBlurhash(scaled, sample.scaled.Width, sample.scaled.Height, sample.components.xc, sample.components.yc) }, scaled);
      }
    }
    assert.deepEqual(size, sample.original);
    assert.equal(blurhash, sample.direct);
  });
}
