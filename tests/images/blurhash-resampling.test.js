import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { resizeNearestPixels } from '../../src/images/renderer.js';
import { encodeBlurhash } from '../../src/images/blurhash.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { decodeJpegScaled } from '../../src/images/jpeg-codec/index.js';
import { captureCurrentNative, recordCandidate, input, assetBytes, hash } from './fixtures/blurhash-current/capture.js';
import { readSourceMembers } from '../storage/fixtures/archive-codec-current/source-reader.js';
import { pixelDifference } from './pixel-diagnostics.js';

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

test('the portable JPEG runtime retains its new build identity and complete corresponding runtime sources', async () => {
  const root = new URL('../../src/images/jpeg-codec/', import.meta.url);
  const offer = JSON.parse(await readFile(new URL('runtime-source-offer.json', root)));
  const check = async entry => {
    const bytes = await readFile(new URL(entry.filename, root));
    assert.equal(bytes.length, entry.bytes, entry.filename); assert.equal(hash(bytes), entry.sha256, entry.filename);
    return bytes;
  };
  const receipt = JSON.parse(await check(offer.buildReceipt));
  const buildOfferBytes = await check(offer.buildSourceOffer), buildOffer = JSON.parse(buildOfferBytes);
  assert.equal(receipt.status, 'built'); assert.equal(receipt.sourceUnchangedDuringBuild, true);
  assert.equal(receipt.runId, offer.build.runId); assert.equal(receipt.commit, offer.build.commit);
  assert.equal(hash(buildOfferBytes), receipt.sourceOffer.sha256);
  for (const entry of [...offer.runtime, ...offer.licenses]) await check(entry);
  for (const entry of offer.runtime) {
    const built = receipt.runtime.find(row => row.path === entry.filename);
    assert.equal(entry.bytes, built.bytes); assert.equal(entry.sha256, built.sha256);
  }
  for (const entry of buildOffer.archives) await check(entry);
  await check(offer.runtimeSourceArchive);
  const source = await readSourceMembers(fileURLToPath(new URL(offer.runtimeSourceArchive.filename, root)), offer.members);
  for (const entry of offer.members) assert.equal(hash(source.get(entry.member)), entry.sha256, entry.member);
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
      sha256: hash(actual), nativeSha256: hash(expected), pixelDifference: pixelDifference(actual, expected), blurhash }, actual);
    assert.equal(blurhash, sample.core);
    assert.equal(sample.core, sample.direct);
  });
}

for (const image of input.images.filter(sample => sample.name.endsWith('.jpg'))) {
  test('native scaled JPEG decode RGBA: ' + image.name, async () => {
    const sample = native.results.find(row => row.name === image.name), bytes = await assetBytes(image);
    const decoded = await decodeJpegScaled(bytes, sample.scale);
    await recordCandidate(image.name + '.jpeg-decode', { Width: decoded.info.width, Height: decoded.info.height,
      sha256: hash(decoded.data), native: sample.decoded,
      pixelDifference: pixelDifference(decoded.data, await pixels(sample, 'decoded')) }, decoded.data);
    assert.equal(hash(bytes), image.sha256, 'The caller retains its original JPEG bytes');
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

test('JPEG decoding rejects bad input and cancellation, then closes active and queued processor work', async () => {
  const image = input.images.find(sample => sample.name.endsWith('.jpg')), bytes = await assetBytes(image);
  await assert.rejects(decodeJpegScaled(Buffer.from('Not a JPEG image.'), 1), { code: 'invalid-image' });
  await assert.rejects(decodeJpegScaled(bytes, 1, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController(), interrupted = decodeJpegScaled(bytes, 1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(interrupted, { name: 'AbortError' });
  const sample = native.results.find(row => row.name === image.name), decoded = await decodeJpegScaled(bytes, sample.scale);
  const recoveryProcessor = new ImageProcessor();
  let recovered;
  try { recovered = await recoveryProcessor.getImageBlurHash(bytes, image.name, sample.original); }
  finally { await recoveryProcessor.close(); }
  await recordCandidate(image.name + '.after-cancel', { blurhash: recovered, decoded: { width: decoded.info.width,
    height: decoded.info.height, sha256: hash(decoded.data) }, pixelDifference: pixelDifference(decoded.data, await pixels(sample, 'decoded')) }, decoded.data);
  assert.equal(recovered, sample.direct, 'A cancelled operation does not affect a fresh complete image hash');
  const processor = new ImageProcessor({ parallelLimit: 1 });
  const first = processor.getImageBlurHash(bytes, image.name, sample.original);
  const second = processor.getImageBlurHash(bytes, image.name, sample.original);
  const results = Promise.allSettled([first, second]);
  await processor.close();
  assert.deepEqual((await results).map(row => row.status), ['rejected', 'rejected']);
  await assert.rejects(processor.getImageBlurHash(bytes, image.name, sample.original), { name: 'AbortError' });
  assert.equal(hash(bytes), image.sha256);
});
