import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'Closing joins the retained directory consumer.');
}

test('retained directories preserve real nested mounts, restrictions and sequential spool writes until consumer release', async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'file-directory-ownership-'));
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  let files, owner, nested, closing;
  t.after(async () => {
    try { await nested?.close(); await owner?.close(); await closing; await files?.close(); await registry.close(); }
    finally { assert.equal(path.dirname(root), output); await fs.rm(root, { recursive: true }); }
  });
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  registry.registerType('sequential', async configuration => {
    const disk = await LocalAdapter.open(configuration), adapter = { capabilities: disk.capabilities };
    for (const key of ['stat', 'listPage', 'openRead', 'write', 'mkdir', 'delete', 'rename', 'watch', 'health', 'close']) adapter[key] = disk[key].bind(disk);
    return adapter;
  });
  for (const [name, type] of [['target', 'sequential'], ['spool', 'local'], ['child', 'local']]) {
    const directory = path.join(root, name); await fs.mkdir(directory);
    await registry.createInstance(name, type, { root: directory, writable: true });
  }
  vfs.mount({ path: '/target', instanceId: 'target', capabilities });
  vfs.mount({ path: '/spool', instanceId: 'spool', capabilities });
  vfs.mount({ path: '/target/readonly', instanceId: 'child', capabilities: {} });
  vfs.mount({ path: '/target/unavailable', instanceId: 'absent', capabilities }, { deferred: true });
  for (const name of ['target', 'spool']) identityMap.addPrefix({ identityRoot: 'Z:\\' + name, accessRoot: '/' + name,
    style: 'windows', returnAccess: 'Retain the original directory identity.' });
  await fs.mkdir(path.join(root, 'target', 'readonly')); await fs.mkdir(path.join(root, 'target', 'unavailable'));
  await fs.writeFile(path.join(root, 'target', 'readonly', 'source.xml'), 'Parent backend sentinel');
  await fs.writeFile(path.join(root, 'target', 'unavailable', 'source.xml'), 'Unavailable mount sentinel');
  await fs.writeFile(path.join(root, 'child', 'source.xml'), 'Actual nested mount');
  files = new StorageFileSystem({ vfs, identityMap }); files.spoolRoot = 'Z:\\spool';
  owner = files.retainDirectories(['Z:\\target', 'Z:\\spool']);
  // Replacing the parent's VFS cannot redirect an already owned directory.
  files.vfs = new VirtualFileSystem(registry);
  closing = files.close(); await pending(closing);
  assert.equal(await owner.fileSystem.readFile('Z:\\target\\readonly\\source.xml', 'utf8'), 'Actual nested mount');
  await assert.rejects(owner.fileSystem.writeFile('Z:\\target\\readonly\\source.xml', 'overwrite'), { code: 'ENOTSUP' });
  await assert.rejects(owner.fileSystem.readFile('Z:\\target\\unavailable\\source.xml'), { code: 'ENOTSUP' });
  const file = await owner.fileSystem.open('Z:\\target\\playlist.xml', 'wx');
  await file.writeFile('Complete sequential XML'); await file.close();
  assert.equal(await fs.readFile(path.join(root, 'target', 'playlist.xml'), 'utf8'), 'Complete sequential XML');
  assert.deepEqual(await fs.readdir(path.join(root, 'spool')), []);
  nested = owner.fileSystem.retainDirectory('Z:\\spool');
  const releasing = owner.close(); await pending(releasing); await pending(closing);
  await nested.fileSystem.writeFile('Z:\\spool\\late.tmp', 'Owned cleanup continuation');
  await nested.fileSystem.rm('Z:\\spool\\late.tmp');
  await nested.close(); await releasing; await closing;
  await assert.rejects(owner.fileSystem.readFile('Z:\\target\\playlist.xml'), { code: 'closed' });
  assert.equal(await fs.readFile(path.join(root, 'target', 'readonly', 'source.xml'), 'utf8'), 'Parent backend sentinel');
  assert.equal(await fs.readFile(path.join(root, 'target', 'unavailable', 'source.xml'), 'utf8'), 'Unavailable mount sentinel');
  assert.equal(await fs.readFile(path.join(root, 'child', 'source.xml'), 'utf8'), 'Actual nested mount');
  assert.deepEqual(await fs.readdir(path.join(root, 'spool')), []);
});
