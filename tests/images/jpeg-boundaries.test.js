import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ImageProcessor } from '../../src/images/processor.js';
import { decodeJpegScaled } from '../../src/images/jpeg-codec/index.js';
import { encodeBlurhash } from '../../src/images/blurhash.js';
import { captureCurrentNative, recordCandidate, input, assetBytes, hash } from './fixtures/jpeg-boundaries-current/capture.js';
import { pixelDifference } from './pixel-diagnostics.js';

let native;
before(async () => { ({ native } = await captureCurrentNative()); });
const failure = error => ({ name: error.name, message: error.message, code: error.code });

test('JPEG boundary evidence retains independently generated inputs, color sources and identical-byte extension controls', async () => {
  assert.equal(native.actualSkiaJpegCodec, true); assert.equal(native.actualBlurHashSharp, true); assert.equal(native.actualImageProcessor, true);
  assert.equal(native.results.length, 31);
  assert.deepEqual(native.results.map(row => row.name), input.images.map(row => row.name));
  assert.equal(native.results.reduce((total, row) => total + row.hashes.length, 0), 45);
  assert.equal(native.results.reduce((total, row) => total + row.decoded.length, 0), 76);
  for (const [index, image] of input.images.entries()) {
    const sample = native.results[index];
    assert.equal(hash(await assetBytes(image)), sample.inputSha256, image.name);
    assert.equal(sample.sourceUnchanged, true); assert.equal(sample.sourceUnlocked, true);
  }
  for (const [alias, source] of [['alias-jpeg-png', 'generated-rgb'], ['alias-jpeg-webp', 'generated-rgb'],
    ['alias-png-jpg', 'alias-png-webp']]) {
    const actual = native.results.find(row => row.name === alias), original = native.results.find(row => row.name === source);
    assert.equal(actual.inputSha256, original.inputSha256, alias);
    assert.deepEqual(actual.original, original.original, alias); assert.equal(actual.direct, original.direct, alias);
  }
});

for (const image of input.images) {
  test('retain complete JPEG boundary pixel diagnostics: ' + image.name, async t => {
    const sample = native.results.find(row => row.name === image.name), bytes = await assetBytes(image);
    for (const expected of sample.decoded) await t.test(expected.name, async () => {
      let decoded, error, core;
      try {
        decoded = image.content === 'png'
          ? await sharp(bytes, { failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          : await decodeJpegScaled(bytes, Math.fround(expected.scale));
        core = encodeBlurhash(decoded.data, decoded.info.width, decoded.info.height, sample.components.xc, sample.components.yc);
      } catch (caught) { error = failure(caught); }
      const observation = { requestedScale: Math.fround(expected.scale), error,
        decoded: decoded && { Width: decoded.info.width, Height: decoded.info.height, bytes: decoded.data.length, sha256: hash(decoded.data) }, core,
        native: expected };
      if (expected.pixelPath != null) {
        const pixels = await readFile(expected.pixelPath);
        assert.equal(hash(pixels), expected.sha256); assert.equal(pixels.length, expected.bytes);
        if (decoded) observation.pixelDifference = pixelDifference(decoded.data, pixels);
      }
      await recordCandidate(image.name + '.' + expected.name, observation, decoded?.data);
      assert.equal(hash(bytes), sample.inputSha256, 'The caller retains all original image bytes');
    });
  });

  test('native public JPEG boundary BlurHash, dimensions and source lifetime: ' + image.name, async t => {
    const sample = native.results.find(row => row.name === image.name), bytes = await assetBytes(image), processor = new ImageProcessor();
    try {
      const size = await processor.getImageSize(bytes, image.filename);
      await recordCandidate(image.name + '.size', { size, inputSha256: hash(bytes) });
      assert.deepEqual(size, sample.original);
      for (const expected of sample.hashes) await t.test(expected.name, async () => {
        let blurhash, error;
        try { blurhash = await processor.getImageBlurHash(bytes, image.filename, expected.dimensions); }
        catch (caught) { error = failure(caught); }
        await recordCandidate(image.name + '.complete.' + expected.name,
          { dimensions: expected.dimensions, blurhash, error, inputSha256: hash(bytes) });
        assert.equal(error != null, expected.error != null, JSON.stringify({ native: expected.error, candidate: error }));
        if (expected.error == null) assert.equal(blurhash, expected.value);
        assert.equal(hash(bytes), sample.inputSha256);
      });
    } finally { await processor.close(); }
  });
}
