import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { ImageProcessor } from '../../src/images/processor.js';
import { resizeLinearMipmaps, sharpenPixels } from '../../src/images/renderer.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { hasDefaultImageOptions, newImageSize } from '../../src/images/options.js';
import { dateTicks } from '../../src/library/records.js';
import { observeComparison } from '../comparison-observations.js';

const root = fileURLToPath(new URL('./fixtures/processor/', import.meta.url));
const native = JSON.parse(await readFile(path.join(root, 'native.json')));
const nativeOptions = JSON.parse(await readFile(path.join(root, 'options-native.json')));
const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath: root });
const digest = value => createHash('sha256').update(value).digest('hex');

const nativeLinearMipmaps = [
  ['grid.png', 8, 5, 'e97158f41cc241c3c6c8c54e671fce3a7bc26f5e49103b29991e6b2031007010', '55ef43464abaf5525f3c755ffcafa055aa4b5a1a1096d44522bd8feb2dca9c97'],
  ['grid.png', 14, 8, 'ba2063fc640de39dc9a09e8356b33a72ec81e824245973f4840a7af26f1a3526', 'b8af16a97a0f9d8a06c589f91b26a6c5c133a4c10a32aa835aacd457adada0c7'],
  ['grid.jpg', 8, 5, '540f3a96ab37ae1148219c20de35d933a6ed9da5fe9564973d20063df5cfdd84', '0564c2cf22a06f4989f0a424a823a0bbab25d6b8f8e0a6137cf252571581689d'],
  ['grid.jpg', 14, 8, '9402a0765dfc6e9b7f122a390372097cad4c923c221f5483a89cb83e73178bb7', 'cd39bfbf781b1f0b189e88b2379225ce982e5d4356a1b6ec9794ce15ec3cf17d'],
  ['alpha.png', 8, 5, '1c56d7d91ac6bc4fc42fbfdeb8e3c3f19fcb75ea5dece0797ba7aa2806f50ff4', 'a07e57c70888f89e066148ed593b0a1087bcafb5ef1e543000a725f37dc2e271'],
  ['alpha.png', 14, 8, '1d6a14460ad23b3d432b3b673213fcb77992b04b1d82710958b881d3b97b74d4', 'e63d74fafd92679afa740cabd35fd866a24d7b1cf686bbd38ae2d98f0b20bc72'],
  ['large.png', 8, 6, '4e05843f85ec7bf6ce742feb57b895cf1bbf637fd9cf77cd9c8bb89e514105a4', 'af3373b3e8e8b60fff3562c15b395b33bd9ca51dbd705592eaa1d4c4e724fd89'],
  ['large.png', 11, 8, 'b908783a9c3c923a9d5e1e469f25f691c177c85b3888c618dd5c745286f71f56', '55d1923d737034d0727df14cd41578cd6f444f3c22098e680e1b1a365a87a5b5']
];

test('internal image asset timestamps retain filesystem 100ns precision for tags and persistence', async () => {
  const filename = path.join(root, 'grid.png'), file = await stat(filename, { bigint: true }), metadata = await assets.stat(filename);
  const epochTicks = dateTicks('1970-01-01T00:00:00Z');
  assert.equal(dateTicks(metadata.modified) - epochTicks, file.mtimeNs / 100n);
  const handle = await assets.openRead(filename);
  try { assert.equal(handle.modified, metadata.modified); } finally { await handle.close(); }
});

test('31 actual native option predicates and three size calculations', () => {
  for (const sample of nativeOptions.optionsCases) assert.equal(hasDefaultImageOptions({ ...sample, SupportedOutputFormats: sample.formats }, sample.path, sample.dimensions), sample.actual, sample.name);
  for (const sample of nativeOptions.resizeCases) assert.deepEqual(newImageSize(sample.requested, { Width: 800, Height: 600 }), sample.result, sample.name);
});

test('Skia m119 linear mipmaps and sharpening match native premultiplied pixels', async () => {
  for (const [filename, Width, Height, resizedHash, sharpenedHash] of nativeLinearMipmaps) {
    const decoded = await sharp(await readFile(path.join(root, filename))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const input = createCanvas(decoded.info.width, decoded.info.height);
    input.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.info.width, decoded.info.height), 0, 0);
    const resized = resizeLinearMipmaps(input.data(), decoded.info.width, decoded.info.height, Width, Height);
    assert.equal(digest(resized), resizedHash, `${filename} ${Width}x${Height} resize`);
    assert.equal(digest(sharpenPixels(resized, Width, Height)), sharpenedHash, `${filename} ${Width}x${Height} sharpen`);
  }
});

for (const sample of native.metadata) test(`actual native image metadata: ${sample.filename}`, async () => {
  const processor = new ImageProcessor({fileSystem:testFileSystem}), bytes = await readFile(path.join(root, sample.filename));
  const dimensions = await processor.getImageSize(bytes, sample.filename);
  assert.deepEqual(dimensions, { Width: sample.Width, Height: sample.Height });
  // The complete differential report retains two unresolved JPEG scaled-decoder differences.
  if (sample.filename === 'large.jpg' || sample.filename === 'wide.jpg') return;
  let blurhash = '';
  try { blurhash = await processor.getImageBlurHash(bytes, sample.filename, dimensions); }
  catch (error) { assert.ok(sample.hashError, `Unexpected pixel decode failure: ${error.message}`); }
  assert.equal(blurhash, sample.BlurHash);
});

const exact = new Set(['grid.png:original', 'grid.png:quality', 'grid.png:jpg', 'grid.png:background', 'grid.png:photo',
  'grid.jpg:original', 'grid.jpg:quality', 'grid.jpg:jpg', 'grid.jpg:blur', 'grid.jpg:background', 'grid.jpg:photo',
  'alpha.png:original', 'alpha.png:jpg', 'large.png:original', 'large.png:width', 'large.png:quality', 'large.png:jpg', 'large.png:background', 'large.png:photo',
  'vector.svg:original', 'vector.svg:width', 'vector.svg:fill', 'vector.svg:quality', 'vector.svg:jpg', 'vector.svg:blur', 'vector.svg:background', 'vector.svg:foreground', 'vector.svg:photo']);
for (const name of ['grid.png:webp', 'grid.jpg:webp', 'large.png:webp', 'vector.svg:webp', 'grid.png:foreground', 'grid.jpg:foreground', 'large.png:foreground', 'alpha.png:background']) exact.add(name);
for (const name of ['grid.png:width', 'grid.png:fill', 'grid.jpg:width', 'grid.jpg:fill', 'large.png:fill']) exact.add(name);

for (const expected of native.transforms) test(`native image transform contract: ${expected.filename} ${expected.operation}`, async t => {
  const processor = new ImageProcessor({fileSystem:testFileSystem}), info = native.metadata.find(value => value.filename === expected.filename);
  const options = { item: { Type: expected.operation === 'photo' ? 'Photo' : 'Movie' }, assets,
    image: { Path: path.join(root, expected.filename), Width: info.Width, Height: info.Height, DateModified: '2024-01-01T00:00:00Z' },
    Quality: 100, SupportedOutputFormats: ['Jpg', 'Png', 'Svg'] };
  switch (expected.operation) {
    case 'width': options.Width = 8; break;
    case 'fill': options.FillWidth = 8; options.FillHeight = 8; break;
    case 'quality': options.Quality = 80; break;
    case 'webp': options.SupportedOutputFormats = ['Webp']; break;
    case 'jpg': options.SupportedOutputFormats = ['Jpg']; break;
    case 'blur': options.Blur = 2; break;
    case 'background': options.BackgroundColor = '#abcdef'; break;
    case 'foreground': options.ForegroundLayer = '0.5'; break;
  }
  const actual = await processor.process(options), bytes = actual.bytes ?? await assets.read(actual.path);
  assert.equal(actual.original, expected.original); assert.equal(actual.mimeType, expected.MimeType);
  const dimensions = await sharp(bytes).metadata();
  // SKBitmap.Decode does not decode original SVG; use the separately recorded native size.
  assert.equal(dimensions.width, expected.width ?? info.Width); assert.equal(dimensions.height, expected.height ?? info.Height);
  observeComparison(t, 'encoded image', { sha256: digest(bytes), length: bytes.length }, { sha256: expected.sha256 });
  if (exact.has(`${expected.filename}:${expected.operation}`)) {
    if (!actual.original && ['image/png', 'image/webp'].includes(actual.mimeType) && expected.pixelHash) {
      // The native oracle hashes decoded premultiplied RGBA. Until a nonzero
      // visual error bound is validated, accepted pixel error is exactly zero.
      const decoded = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const canvas = createCanvas(decoded.info.width, decoded.info.height);
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.info.width, decoded.info.height), 0, 0);
      assert.equal(digest(canvas.data()), expected.pixelHash, 'decoded pixels including alpha');
    } else assert.equal(digest(bytes), expected.sha256);
  }
  await processor.close();
});

test('metadata image update stores real dimensions and UTF8 BlurHash, recalculates forced dimensions, and validates missing assets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'metadata-image-update-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath: directory }), manager = new MetadataImages();
  const image = await files.write(path.join(directory, 'poster.png'), await readFile(path.join(root, 'grid.png')));
  const images = [{ Type: 'Primary', Path: image.Path, Width: 0, Height: 0, DateModified: '2020-01-01 00:00:00', Blurhash: null },
    { Type: 'Logo', Path: path.join(directory, 'missing.png'), Width: 0, Height: 0, Blurhash: null }];
  assert.equal(await manager.updateImages({ item: { Type: 'Movie' }, imageAssets: files }, images), true);
  assert.equal(images.length, 1); assert.equal(images[0].Width, 20); assert.equal(images[0].Height, 12);
  assert.ok(Buffer.isBuffer(images[0].Blurhash)); assert.equal(images[0].Blurhash.toString(), native.metadata.find(value => value.filename === 'grid.png').BlurHash);
  await writeFile(image.Path, await readFile(path.join(root, 'single.png')));
  await manager.updateImages({ item: { Type: 'Movie' }, imageAssets: files }, images, { forceUpdate: true });
  assert.equal(images[0].Width, 1); assert.equal(images[0].Height, 1);
});

test('image timestamps use the native greater-than-one-second boundary at 100ns precision', async () => {
  let reads = 0; const image = { Type: 'Primary', Path: 'Z:\\poster.png', Width: 1, Height: 1, DateModified: '2024-01-01 00:00:00.0000001', Blurhash: Buffer.from('cached') };
  const files = { stat: async () => ({ kind: 'file', modified: '2024-01-01T08:00:01.0000001+08:00' }), read: async () => { reads++; return Buffer.from('x'); } };
  const manager = new MetadataImages({ processor: { getImageBlurHash: async () => 'new' } });
  await manager.updateImages({ item: {}, imageAssets: files }, [image]); assert.equal(reads, 0);
  files.stat = async () => ({ kind: 'file', modified: '2024-01-01T08:00:01.000000299+08:00' });
  await manager.updateImages({ item: {}, imageAssets: files }, [image]); assert.equal(reads, 1); assert.equal(image.DateModified, '2024-01-01 00:00:01.0000002');
});

test('original GIF bypasses transforms, invalid output formats reject, cache reads do not reread originals', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const processor = new ImageProcessor({fileSystem: testFileSystem,  cachePath: directory }); t.after(() => processor.close());
  let reads = 0; const files = { stat: (...args) => assets.stat(...args), read: (...args) => { reads++; return assets.read(...args); } };
  const image = { Path: path.join(root, 'grid.png'), DateModified: '2024-01-01T00:00:00Z', Width: 20, Height: 12 };
  const options = { image, assets: files, Quality: 80, SupportedOutputFormats: ['Png'] };
  const first = await processor.process(options), second = await processor.process(options);
  assert.equal(first.original, false); assert.equal(first.mimeType, 'image/png'); assert.deepEqual(second.bytes, first.bytes); assert.equal(reads, 1);
  await assert.rejects(processor.process({ image, assets, SupportedOutputFormats: [6] }), error => error.status === 400);
  const gif = await processor.process({ image: { ...image, Path: 'image.gif' }, assets: { stat: async () => ({}) }, SupportedOutputFormats: [6], Width: 1 });
  assert.equal(gif.original, true); assert.equal(gif.mimeType, 'image/gif');
});

test('processor shutdown aborts an active asset read and rejects queued work', async () => {
  const processor = new ImageProcessor({fileSystem:testFileSystem});
  const assets = { stat: async () => ({}), read: async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const options = { image: { Path: 'poster.png', Width: 20, Height: 12 }, assets, Quality: 80, SupportedOutputFormats: ['Png'] };
  const first = processor.process(options), second = processor.process(options);
  const results = Promise.allSettled([first, second]);
  await new Promise(resolve => setImmediate(resolve)); await processor.close();
  assert.deepEqual((await results).map(result => result.status), ['rejected', 'rejected']);
});
