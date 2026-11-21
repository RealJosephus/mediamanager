import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';

async function fixture(t, { rename = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-image-swap-'));
  const registry = new StorageRegistry();
  t.after(async () => {
    try { await registry.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  registry.registerType('local', options => new LocalAdapter(options));
  const adapter = await registry.createInstance('images', 'local', { root, writable: true });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, mkdir: true, rename, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: root, accessRoot: '/images', style: process.platform === 'win32' ? 'windows' : 'posix',
    returnAccess: 'isolated image swap fixture' });
  const assets = new MetadataImageAssets({ vfs, identityMap });
  const left = path.join(root, 'left.png'), right = path.join(root, 'right.png');
  const leftContents = Buffer.from('first image'), rightContents = Buffer.from('second image');
  await writeFile(left, leftContents);
  await writeFile(right, rightContents);
  for (const [filename, seconds] of [[left, 1735689600.123456], [right, 1735689600.765432]]) await utimes(filename, seconds, seconds);
  return { root, adapter, assets, left, right, leftContents, rightContents };
}

test('same-mount image swaps exchange the bytes and full cache timestamps on Local storage', async t => {
  const { root, assets, left, right, leftContents, rightContents } = await fixture(t);
  const before = await Promise.all([assets.stat(left), assets.stat(right)]);
  assert.ok(before.every(file => /\.\d{3}(?!0000)\d{4}Z$/.test(file.modified)), 'The fixture must contain sub-millisecond file times.');
  const [first, second] = await assets.swap(left, right);
  assert.equal(first.Path, left);
  assert.equal(second.Path, right);
  assert.equal(first.modified, before[1].modified);
  assert.equal(second.modified, before[0].modified);
  assert.deepEqual(await assets.read(left), rightContents);
  assert.deepEqual(await assets.read(right), leftContents);
  assert.deepEqual((await readdir(root)).sort(), ['left.png', 'right.png']);
});

test('an image swap that fails at the second publication restores both files and lets the owner retry', async t => {
  const { root, adapter, assets, left, right, leftContents, rightContents } = await fixture(t);
  const before = await Promise.all([assets.stat(left), assets.stat(right)]);
  const rename = adapter.rename.bind(adapter), injected = Object.assign(new Error('Controlled image move failure.'), { code: 'unavailable' });
  let moves = 0;
  adapter.rename = (...args) => {
    if (++moves === 3) return Promise.reject(injected);
    return rename(...args);
  };
  await assert.rejects(assets.swap(left, right), error => error.code === injected.code && error.message === injected.message);
  const recovered = await Promise.all([assets.stat(left), assets.stat(right)]);
  assert.deepEqual(recovered.map(file => file.modified), before.map(file => file.modified));
  assert.deepEqual(await assets.read(left), leftContents);
  assert.deepEqual(await assets.read(right), rightContents);
  assert.deepEqual((await readdir(root)).sort(), ['left.png', 'right.png']);
  await assets.swap(left, right);
  assert.deepEqual(await assets.read(left), rightContents);
  assert.deepEqual(await assets.read(right), leftContents);
});

test('an overwrite-only image swap restores both files after an aborted publication and can be retried', async t => {
  const { adapter, assets, left, right, leftContents, rightContents } = await fixture(t, { rename: false });
  const before = ['2025-01-01T00:00:00.1234567Z', '2025-01-01T00:00:00.7654321Z'];
  await adapter.write('/left.png', leftContents, { modified: before[0] });
  await adapter.write('/right.png', rightContents, { modified: before[1] });
  const times = async () => (await Promise.all([assets.stat(left), assets.stat(right)])).map(file => file.modified);
  assert.deepEqual(await times(), before);
  const controller = new AbortController();
  const stopped = Object.assign(new Error('Controlled abort after the second file was written.'), { code: 'cancelled' });
  const write = adapter.write.bind(adapter);
  let writes = 0;
  adapter.write = async (...args) => {
    const result = await write(...args);
    if (++writes === 2) {
      controller.abort(stopped);
      throw stopped;
    }
    return result;
  };
  await assert.rejects(assets.swap(left, right, { signal: controller.signal }), error => error === stopped);
  assert.deepEqual(await assets.read(left), leftContents);
  assert.deepEqual(await assets.read(right), rightContents);
  assert.deepEqual(await times(), before);
  const swapped = await assets.swap(left, right);
  assert.deepEqual(swapped.map(file => file.modified), [before[1], before[0]]);
  assert.deepEqual(await times(), [before[1], before[0]]);
  assert.deepEqual(await assets.read(left), rightContents);
  assert.deepEqual(await assets.read(right), leftContents);
});

test('an overwrite-only image swap preserves the initial failure and still restores the other file', async t => {
  const { adapter, assets, left, right, leftContents, rightContents } = await fixture(t, { rename: false });
  const before = (await Promise.all([assets.stat(left), assets.stat(right)])).map(file => file.modified);
  const write = adapter.write.bind(adapter);
  const publication = Object.assign(new Error('Controlled failure on the second write.'), { code: 'unavailable' });
  const recovery = Object.assign(new Error('Controlled failure restoring the second file.'), { code: 'permission-denied' });
  let writes = 0;
  adapter.write = (...args) => {
    if (++writes === 2) return Promise.reject(publication);
    if (writes === 3) return Promise.reject(recovery);
    return write(...args);
  };
  await assert.rejects(assets.swap(left, right), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, publication);
    assert.equal(error.code, publication.code);
    assert.deepEqual(error.errors, [publication, recovery]);
    return true;
  });
  assert.deepEqual(await assets.read(left), leftContents);
  assert.deepEqual(await assets.read(right), rightContents);
  assert.deepEqual((await Promise.all([assets.stat(left), assets.stat(right)])).map(file => file.modified), before);
});
