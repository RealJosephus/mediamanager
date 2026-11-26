import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { ImageProcessor } from '../../src/images/processor.js';

async function setup(t, writeCache) {
  const cachePath = await mkdtemp(path.join(tmpdir(), 'mm-resize-'));
  let originalReads = 0;
  const fileSystem = {
    mkdir: (...args) => testFileSystem.mkdir(...args),
    readFile: (...args) => testFileSystem.readFile(...args),
    stat: (...args) => testFileSystem.stat(...args),
    writeFile: writeCache,
  };
  const processor = new ImageProcessor({ cachePath, fileSystem, parallelLimit: 2 });
  t.after(async () => { await processor.close(); await rm(cachePath, { recursive: true, force: true }); });
  const source = fileURLToPath(new URL('./fixtures/processor/grid.png', import.meta.url));
  const options = {
    image: { Path: source, DateModified: '2024-01-01T00:00:00Z', Width: 20, Height: 12 },
    assets: { stat, read: name => { originalReads++; return readFile(name); } }, Width: 8, SupportedOutputFormats: ['Png']
  };
  return { resize: () => processor.process(options), reads: () => originalReads };
}

test('an interrupted cache writer cannot expose its prefix or remove a concurrent publication', async t => {
  const paused = Promise.withResolvers(), resume = Promise.withResolvers();
  let writes = 0;
  const { resize, reads } = await setup(t, async (name, bytes, options) => {
    if (++writes > 1) {
      // Each local adapter serializes mutations. A second adapter models an
      // independent publisher with access to the same cache directory.
      const publisher = await LocalAdapter.open({ root: path.dirname(name), writable: true });
      try { return await publisher.write('/' + path.basename(name), bytes, options); }
      finally { await publisher.close(); }
    }
    async function* interruptedWrite() {
      yield bytes.subarray(0, 8);
      paused.resolve(name);
      await resume.promise;
      throw Object.assign(new Error('Test cache device ran out of space'), { code: 'ENOSPC' });
    }
    return testFileSystem.writeFile(name, interruptedWrite(), { ...options, size: BigInt(bytes.length) });
  });
  const first = resize();
  let winner;
  try {
    const cache = await Promise.race([paused.promise, first.then(() => { throw new Error('Writer never paused'); })]);
    await assert.rejects(stat(cache), { code: 'ENOENT' });
    winner = await resize();
    assert.equal(winner.original, false);
  } finally { resume.resolve(); }
  assert.equal((await first).original, true);
  const next = await resize();
  assert.deepEqual(next.bytes, winner.bytes);
  assert.equal((await sharp(next.bytes).raw().toBuffer({ resolveWithObject: true })).info.width, 8);
  assert.equal(reads(), 2);
  assert.deepEqual(await readdir(path.dirname(next.path)), [path.basename(next.path)]);
});

test('a failed final rename cleans staging and a legacy truncated cache entry is replaced on retry', async t => {
  let destination;
  const { resize, reads } = await setup(t, (name, bytes, options) => {
    if (destination) return testFileSystem.writeFile(name, bytes, options);
    destination = name;
    async function* blockRename() {
      yield bytes;
      await mkdir(name);
    }
    return testFileSystem.writeFile(name, blockRename(), { ...options, size: BigInt(bytes.length) });
  });
  assert.equal((await resize()).original, true);
  assert.deepEqual(await readdir(path.dirname(destination)), [path.basename(destination)]);
  await rmdir(destination);
  await writeFile(destination, Buffer.from('89504e470d0a1a0a', 'hex'));
  const recovered = await resize();
  assert.equal(recovered.path, destination);
  assert.equal((await sharp(recovered.bytes).raw().toBuffer({ resolveWithObject: true })).info.width, 8);
  assert.deepEqual((await resize()).bytes, recovered.bytes);
  assert.equal(reads(), 2);
});

test('storage without atomic publication serves a resized image from memory', async t => {
  const { resize } = await setup(t, async () => { throw Object.assign(new Error('No atomic replace'), { code: 'ENOTSUP' }); });
  const result = await resize();
  assert.equal(result.original, false);
  assert.equal(result.path, undefined);
  assert.equal((await sharp(result.bytes).metadata()).width, 8);
});
