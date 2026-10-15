import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'state-asset-boundaries-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('state-asset-boundaries-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('state assets create absent directories and write within declared state roots', async t => {
  const directory = await temporary(t), state = path.join(directory, 'state');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [state] });
  const filename = path.join(state, 'collections', 'Created [boxset]', 'poster.png');
  const bytes = Buffer.from('isolated state image');
  const written = await assets.write(filename, bytes);
  assert.equal(written.kind, 'file'); assert.equal(written.size, BigInt(bytes.length));
  assert.deepEqual(await fs.readFile(filename), bytes);
  const created = await assets.createDirectory(path.join(state, 'metadata', 'new'));
  assert.equal(created.isDirectory(), true);
});

test('state assets reject an existing external directory link before writing', async t => {
  const directory = await temporary(t), state = path.join(directory, 'state'), external = path.join(directory, 'external');
  await fs.mkdir(state); await fs.mkdir(external);
  const bytes = Buffer.from('existing external image');
  const outside = path.join(external, 'poster.png'); await fs.writeFile(outside, bytes);
  const link = path.join(state, 'linked');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath: state });
  await assert.rejects(assets.write(path.join(link, 'poster.png'), Buffer.from('replacement')), { code: 'permission-denied' });
  await assert.rejects(assets.write(path.join(link, 'new', 'poster.png'), Buffer.from('new image')), { code: 'permission-denied' });
  assert.deepEqual(await fs.readFile(outside), bytes);
  assert.deepEqual(await fs.readdir(external), ['poster.png']);
});

test('state assets reject a dangling parent directory link before creating its target', async t => {
  const directory = await temporary(t), state = path.join(directory, 'state'), external = path.join(directory, 'absent-external');
  await fs.mkdir(state);
  const link = path.join(state, 'dangling');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [state] });
  await assert.rejects(assets.write(path.join(link, 'nested', 'poster.png'), Buffer.from('new image')), { code: 'permission-denied' });
  await assert.rejects(assets.createDirectory(path.join(link, 'new-directory')), { code: 'permission-denied' });
  await assert.rejects(fs.lstat(external), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(state), ['dangling']);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  if (process.platform !== 'win32') {
    const fileLink = path.join(state, 'dangling-file.png'), outsideFile = path.join(directory, 'outside.png');
    await fs.symlink(outsideFile, fileLink, 'file');
    await assert.rejects(assets.write(fileLink, Buffer.from('new image')), { code: 'permission-denied' });
    await assert.rejects(fs.lstat(outsideFile), { code: 'ENOENT' });
    assert.equal((await fs.lstat(fileLink)).isSymbolicLink(), true);
  }
});

test('state asset paths beneath an ordinary file fail without modifying the file', async t => {
  const directory = await temporary(t), state = path.join(directory, 'state');
  await fs.mkdir(state);
  const blocker = path.join(state, 'file'); await fs.writeFile(blocker, 'blocker');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [state] });
  await assert.rejects(assets.write(path.join(blocker, 'poster.png'), Buffer.from('image')),
    error => ['ENOTDIR', 'EEXIST'].includes(error.code));
  assert.equal(await fs.readFile(blocker, 'utf8'), 'blocker');
  assert.deepEqual(await fs.readdir(state), ['file']);
});
