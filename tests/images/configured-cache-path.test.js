import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ImageProcessor } from '../../src/images/processor.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';

test('future image conversions use the active cache root and an admitted conversion retains its target', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configured-image-cache-'));
  const firstCache = path.join(root, 'first'), secondCache = path.join(root, 'second');
  let cachePath = firstCache;
  const processor = new ImageProcessor({ fileSystem: testFileSystem, get cachePath() { return cachePath; } });
  t.after(async () => { await processor.close(); await rm(root, { recursive: true, force: true }); });
  const source = fileURLToPath(new URL('./fixtures/processor/', import.meta.url));
  const assets = new MetadataImageAssets({ fileSystem: testFileSystem, metadataPath: source });
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const image = { Path: path.join(source, 'grid.png'), DateModified: '2024-01-01T00:00:00Z', Width: 20, Height: 12 };
  const options = { image, Width: 8, Quality: 80, SupportedOutputFormats: ['Png'] };
  const running = processor.process({ ...options, assets: {
    async stat(...args) { const value = await assets.stat(...args); entered.resolve(); await resume.promise; return value; },
    read: (...args) => assets.read(...args),
  } });
  running.catch(() => {});
  let first;
  try { await Promise.race([entered.promise, running]); cachePath = secondCache; resume.resolve(); first = await running; }
  finally { resume.resolve(); await Promise.allSettled([running]); }
  assert.equal(first.original, false);
  assert.equal(path.relative(firstCache, first.path).split(path.sep)[0], 'resized-images');
  assert.deepEqual(await readFile(first.path), first.bytes);
  const second = await processor.process({ ...options, assets });
  assert.equal(second.original, false);
  assert.equal(path.relative(secondCache, second.path).split(path.sep)[0], 'resized-images');
  assert.deepEqual(await readFile(second.path), first.bytes);
  const cached = await processor.process({ ...options, assets: {
    stat: (...args) => assets.stat(...args), read() { throw new Error('A completed cache entry must supply the image.'); },
  } });
  assert.equal(cached.original, false); assert.equal(cached.path, second.path); assert.deepEqual(cached.bytes, second.bytes);
});
