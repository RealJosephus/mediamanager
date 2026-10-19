import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ImageProcessor } from '../../src/images/processor.js';
import { blendBlackForeground, blendBitmap, stripCanvasColorProfile } from '../../src/images/renderer.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';

const root = fileURLToPath(new URL('./fixtures/blending/', import.meta.url));
const native = JSON.parse(await readFile(path.join(root, 'native.json'))), source = await readFile(path.join(root, 'premultiplied-input.bgra'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

for (const sample of native.blends) test(`native BGRA DrawColor alpha ${sample.alpha}: complete premultiplied channel ramps`, () => {
  assert.equal(digest(blendBlackForeground(Buffer.from(source), sample.alpha)), sample.sha256);
});
for (const sample of native.backgrounds) test(`native BGRA DrawBitmap SrcOver ${sample.color}: complete premultiplied channel ramps`, () => {
  const background = Buffer.alloc(source.length);
  for (let i = 0; i < background.length; i += 4) background.set(sample.destinationPixel, i);
  assert.equal(digest(blendBitmap(background, source)), sample.sha256);
});
for (const sample of native.foreground.filter(value => value.byteExactCoverage)) test(`native foreground bytes: ${sample.filename}, layer ${sample.ForegroundLayer}, background ${sample.BackgroundColor ?? 'none'}`, async () => {
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath: root }), processor = new ImageProcessor({fileSystem:testFileSystem});
  const filename = path.join(root, sample.filename);
  const output = await processor.process({ item: { Type: 'Movie' }, assets, image: { Path: filename, Width: 20, Height: 12 }, Quality: 100,
    SupportedOutputFormats: ['Jpg', 'Png'], ForegroundLayer: sample.ForegroundLayer, BackgroundColor: sample.BackgroundColor });
  assert.equal(output.original, false); assert.equal(output.mimeType, sample.MimeType); assert.equal(digest(output.bytes), sample.sha256);
  await processor.close();
});

test('WebP conversion preserves the extended header required by separate alpha and metadata chunks', async () => {
  const lossyAlpha = await sharp(await readFile(path.join(root, 'alpha.png'))).webp({ quality: 80 }).toBuffer();
  assert.equal(lossyAlpha.toString('ascii', 12, 16), 'VP8X'); assert.ok(lossyAlpha.includes(Buffer.from('ALPH')));
  assert.deepEqual(stripCanvasColorProfile(lossyAlpha, 'Webp'), lossyAlpha);
  const simple = await sharp(await readFile(path.join(root, 'grid.png'))).webp({ lossless: true }).toBuffer();
  const chunk = (name, data) => { const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(data.length, 4); return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]); };
  const header = Buffer.from('RIFF0000WEBP'), extended = Buffer.alloc(10); extended[0] = 0x08; extended.writeUIntLE(19, 4, 3); extended.writeUIntLE(11, 7, 3);
  const exif = chunk('EXIF', Buffer.from('49492a0008000000000000000000', 'hex'));
  const data = Buffer.concat([chunk('VP8X', extended), simple.subarray(12), exif]); header.writeUInt32LE(data.length + 4, 4);
  const withMetadata = Buffer.concat([header, data]); assert.deepEqual(stripCanvasColorProfile(withMetadata, 'Webp'), withMetadata);
});
