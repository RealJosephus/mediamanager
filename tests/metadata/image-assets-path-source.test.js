import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';

test('scoped image assets follow the active metadata root while retaining state and media boundaries', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-path-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second'), definitions = path.join(root, 'definitions');
  let metadataPath = first;
  const assets = new MetadataImageAssets({ fileSystem: testFileSystem, get metadataPath() { return metadataPath; }, stateRoots: [definitions] });
  const scoped = assets.forItem({ Type: 'Movie', Path: path.join(root, 'media', 'movie.mkv') }, '/media/movie.mkv');
  const oldImage = path.join(first, 'poster.png'), newImage = path.join(second, 'poster.png');
  await scoped.write(oldImage, Buffer.from('first image'));
  metadataPath = second;
  await scoped.write(newImage, Buffer.from('second image'));
  assert.deepEqual(await scoped.read(newImage), Buffer.from('second image'));
  await assert.rejects(scoped.read(oldImage), { code: 'unmapped-path' });
  assert.deepEqual(await readFile(oldImage), Buffer.from('first image'));
  await scoped.write(path.join(definitions, 'poster.png'), Buffer.from('definition image'));
  await assert.rejects(scoped.write(path.join(root, 'outside.png'), Buffer.from('outside')), { code: 'unmapped-path' });
  await assert.rejects(scoped.deleteDirectory(second), { code: 'permission-denied' });
  assert.equal((await stat(second)).isDirectory(), true);
  const alias = path.join(second, 'alias');
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scoped.write(path.join(alias, 'escape.png'), Buffer.from('escape')), { code: 'permission-denied' });
});

test('an image write keeps one authorized root through directory creation and its final observation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-path-operation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  await mkdir(first); await mkdir(second);
  let metadataPath = first;
  const fileSystem = {
    realpath: (...args) => testFileSystem.realpath(...args), lstat: (...args) => testFileSystem.lstat(...args),
    stat: (...args) => testFileSystem.stat(...args), writeFile: (...args) => testFileSystem.writeFile(...args),
    async mkdir(...args) { await testFileSystem.mkdir(...args); metadataPath = second; },
  };
  const assets = new MetadataImageAssets({ fileSystem, get metadataPath() { return metadataPath; } });
  const firstImage = path.join(first, 'nested', 'poster.png'), bytes = Buffer.from('complete first write');
  assert.equal((await assets.write(firstImage, bytes)).kind, 'file');
  assert.deepEqual(await readFile(firstImage), bytes);
  await assert.rejects(assets.resolve(firstImage), { code: 'unmapped-path' });
  const secondImage = path.join(second, 'poster.png');
  await assets.write(secondImage, Buffer.from('future write'));
  assert.deepEqual(await readFile(secondImage), Buffer.from('future write'));
});
