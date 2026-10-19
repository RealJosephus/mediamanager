import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

test('file handles enforce mount creation, replacement and virtual directory restrictions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-file-handles-'));
  const registry = new StorageRegistry();
  t.after(async () => { await registry.close(); await fs.rm(root, { recursive:true, force:true }); });
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('disk', 'local', { root, writable:true });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  for (const [name, capabilities] of [['Read', {}], ['Create', {create:true}], ['Replace', {replace:true}],
    ['All', {create:true,replace:true}]]) {
    vfs.mount({ path:`/${name}`, instanceId:'disk', capabilities });
    identityMap.addPrefix({ identityRoot:`Z:\\${name}`, accessRoot:`/${name}`, style:'windows', returnAccess:'Retain test identity.' });
  }
  vfs.mount({ path:'/All/tree/leaf', instanceId:'disk', capabilities:{create:true,replace:true} });
  const files = new StorageFileSystem({vfs,identityMap});
  await fs.writeFile(path.join(root, 'existing'), 'original');
  for (const flags of ['w', 'a', 'w+', 'a+', 'as', 'as+']) {
    await assert.rejects(files.open('Z:\\Replace\\new', flags), {code:'ENOTSUP'});
    await assert.rejects(files.open('Z:\\Create\\existing', flags), {code:'ENOTSUP'});
  }
  await assert.rejects(fs.stat(path.join(root, 'new')), {code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(root, 'existing'), 'utf8'), 'original');
  for (const name of ['Z:\\All', 'Z:\\All\\tree', 'Z:\\All\\tree\\leaf']) {
    await assert.rejects(files.open(name, 'w'), {code:'EACCES'});
    await assert.rejects(files.open(name, 'wx'), {code:'EACCES'});
  }
  await assert.rejects(files.open('Z:\\Read\\existing', 'r+'), {code:'ENOTSUP'});
  const reader = await files.open('Z:\\Read\\existing');
  try { assert.equal(await reader.readFile('utf8'), 'original'); } finally { await reader.close(); }
  const created = await files.open('Z:\\Create\\new', 'wx');
  try { await created.writeFile('created'); } finally { await created.close(); }
  await assert.rejects(files.open('Z:\\Create\\new', 'wx'), {code:'EEXIST'});
  const updated = await files.open('Z:\\Replace\\existing', 'r+');
  try { await updated.writeFile('replaced'); } finally { await updated.close(); }
  assert.equal(await fs.readFile(path.join(root, 'existing'), 'utf8'), 'replaced');
  assert.equal(await fs.readFile(path.join(root, 'new'), 'utf8'), 'created');
});

test('remote metadata file handles respect the spool mount write capabilities', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-file-spool-'));
  const registry = new StorageRegistry();
  t.after(async () => { await registry.close(); await fs.rm(root, { recursive:true, force:true }); });
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  registry.registerType('memory', () => new MemoryStorageAdapter());
  await registry.createInstance('spool', 'local', {root,writable:true});
  await registry.createInstance('remote', 'memory', {});
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({path:'/spool',instanceId:'spool',capabilities:{replace:true}});
  vfs.mount({path:'/remote',instanceId:'remote',capabilities:{create:true,replace:true}});
  for (const name of ['spool','remote']) identityMap.addPrefix({identityRoot:`Z:\\${name}`,accessRoot:`/${name}`,
    style:'windows',returnAccess:'Retain test identity.'});
  const files = new StorageFileSystem({vfs,identityMap}); files.spoolRoot = 'Z:\\spool';
  await assert.rejects(files.open('Z:\\remote\\new', 'w'), {code:'ENOTSUP'});
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(vfs.stat('/remote/new'), {code:'not-found'});
});
