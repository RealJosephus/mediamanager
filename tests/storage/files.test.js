import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

test('recursive directories and realpath retain mapped identity style and reject host escapes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-identity-paths-'));
  const disk = path.join(root, 'disk'), outside = path.join(root, 'outside');
  const registry = new StorageRegistry();
  t.after(async () => {
    try { await registry.close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await fs.mkdir(disk); await fs.mkdir(outside);
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('disk', 'local', { root: disk, writable: true });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  const identities = [
    { name: 'windows', root: 'Z:\\Library', api: path.win32, style: 'windows' },
    { name: 'unc', root: '\\\\server\\share\\Library', api: path.win32, style: 'windows' },
    { name: 'posix', root: '/portable/library', api: path.posix, style: 'posix' },
    { name: 'state', root: disk, api: path, style: process.platform === 'win32' ? 'windows' : 'posix' },
  ];
  for (const identity of identities) {
    vfs.mount({ path: '/' + identity.name, instanceId: 'disk', capabilities: { mkdir: true, create: true, replace: true } });
    identityMap.addPrefix({ identityRoot: identity.root, accessRoot: '/' + identity.name, style: identity.style,
      returnAccess: 'Retain the original portable or application-state identity.' });
  }
  const files = new StorageFileSystem({ vfs, identityMap });
  for (const identity of identities) {
    const directory = identity.api.join(identity.root, identity.name, 'nested');
    await files.mkdir(directory, { recursive: true });
    await files.mkdir(directory, { recursive: true });
    assert.equal(await files.realpath(directory), directory);
    assert.equal(await files.realpath(identity.root), identity.root);
    const filename = identity.api.join(directory, 'metadata.nfo');
    await files.writeFile(filename, identity.name);
    assert.equal(await files.realpath(filename), filename);
    assert.equal(await fs.readFile(path.join(disk, identity.name, 'nested', 'metadata.nfo'), 'utf8'), identity.name);
    await assert.rejects(files.realpath(directory + identity.api.sep + '..'), { code: 'invalid-path' });
  }
  // State-path confinement still goes through the actual local adapter. An
  // existing host directory without a mapping never becomes an access fallback.
  await assert.rejects(files.realpath(outside), { code: 'ENOENT' });
  await fs.symlink(outside, path.join(disk, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const identity of identities) {
    await assert.rejects(files.realpath(identity.api.join(identity.root, 'link')), { code: 'EACCES' });
    await assert.rejects(files.mkdir(identity.api.join(identity.root, 'link', 'escaped'), { recursive: true }), { code: 'EACCES' });
  }
  assert.deepEqual(await fs.readdir(outside), []);
});

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

test('mapped replacement preserves original bytes on a sharing failure and succeeds after the reader closes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-open-replacement-'));
  const registry = new StorageRegistry();
  t.after(async () => { try { await registry.close(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('disk', 'local', { root, writable: true });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({ path: '/state', instanceId: 'disk', capabilities: { create: true, replace: true, rename: true } });
  identityMap.addPrefix({ identityRoot: 'Z:\\State', accessRoot: '/state', style: 'windows', returnAccess: 'Isolated replacement identity.' });
  const files = new StorageFileSystem({ vfs, identityMap });
  await files.writeFile('Z:\\State\\playlist.xml', 'original XML');
  const admitted = await files.open('Z:\\State\\playlist.xml');
  let blocked = false;
  try {
    const temporary = await files.open('Z:\\State\\playlist.tmp', 'wx');
    try { await temporary.writeFile('complete replacement XML'); } finally { await temporary.close(); }
    try { await files.rename('Z:\\State\\playlist.tmp', 'Z:\\State\\playlist.xml'); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EACCES') throw error;
      blocked = true;
      assert.equal(await files.readFile('Z:\\State\\playlist.xml', 'utf8'), 'original XML');
      assert.equal(await files.readFile('Z:\\State\\playlist.tmp', 'utf8'), 'complete replacement XML');
    }
    assert.equal(await admitted.readFile('utf8'), 'original XML');
  } finally { await admitted.close(); }
  if (blocked) await files.rename('Z:\\State\\playlist.tmp', 'Z:\\State\\playlist.xml');
  assert.equal(await files.readFile('Z:\\State\\playlist.xml', 'utf8'), 'complete replacement XML');
  assert.deepEqual(await fs.readdir(root), ['playlist.xml']);
});
