import assert from 'node:assert/strict';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { StorageFileSystem } from '../../src/storage/files.js';

/** Run against an owned HTTP backend through the actual adapter and VFS. */
export async function remoteFileContract(vfs, { root = '/network', checks = [] } = {}) {
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\Remote', accessRoot: root, style: 'windows',
    returnAccess: 'Retain the mapped remote file identity.' });
  const files = new StorageFileSystem({ vfs, identityMap });
  const base = root + '/file-contract', identity = 'Z:\\Remote\\file-contract';
  await vfs.mkdir(base);
  await vfs.mkdir(base + '/nonempty');
  await vfs.mkdir(base + '/empty');
  const child = Buffer.from('Retain the complete remote child.\0中文');
  await vfs.write(base + '/nonempty/child.bin', child, { overwrite: true });
  const read = async access => {
    const reader = await vfs.openRead(access);
    try { const chunks = []; for await (const chunk of reader.stream) chunks.push(chunk); return Buffer.concat(chunks); }
    finally { await reader.close(); }
  };
  for (const directory of ['nonempty', 'empty']) {
    await assert.rejects(vfs.delete(base + '/' + directory), { code: 'not-supported' });
    await assert.rejects(vfs.delete(base + '/' + directory, { recursive: false }), { code: 'not-supported' });
    await assert.rejects(files.rmdir(identity + '\\' + directory), { code: 'ENOTSUP' });
    await assert.rejects(files.unlink(identity + '\\' + directory), { code: 'EISDIR' });
    assert.equal((await vfs.stat(base + '/' + directory)).kind, 'directory');
    assert.deepEqual(await read(base + '/nonempty/child.bin'), child);
  }
  checks.push({ operation: 'nonrecursive-remote-directory-delete', emptyRetained: true, childrenRetained: true });

  for (const [name, bytes] of [['binary', Buffer.concat([Buffer.alloc(131079, 0x85), child])], ['empty', Buffer.alloc(0)]]) {
    const source = base + '/' + name + '-source.bin', destination = base + '/' + name + '-copy.bin';
    await vfs.write(source, bytes, { overwrite: true });
    await vfs.write(destination, Buffer.from('Previous destination contents.'), { overwrite: true });
    await files.copyFile(identity + '\\' + name + '-source.bin', identity + '\\' + name + '-source.bin');
    assert.deepEqual(await read(source), bytes);
    await files.copyFile(identity + '\\' + name + '-source.bin', identity + '\\' + name + '-copy.bin');
    await assert.rejects(files.rmdir(identity + '\\' + name + '-copy.bin'), { code: 'ENOTDIR' });
    assert.deepEqual(await read(source), bytes);
    assert.deepEqual(await read(destination), bytes);
    assert.equal((await vfs.stat(destination)).size, BigInt(bytes.length));
    await files.unlink(identity + '\\' + name + '-copy.bin');
    await assert.rejects(vfs.stat(destination), { code: 'not-found' });
    checks.push({ operation: 'remote-copy-and-file-delete', name, bytes: bytes.length, sourceRetained: true, selfCopyRetained: true });
  }

  await vfs.delete(base + '/nonempty', { recursive: true });
  await assert.rejects(vfs.stat(base + '/nonempty/child.bin'), { code: 'not-found' });
  await vfs.delete(base + '/empty', { recursive: true });
  await vfs.delete(base, { recursive: true });
  await assert.rejects(vfs.stat(base), { code: 'not-found' });
  checks.push({ operation: 'explicit-recursive-remote-delete', removed: true });
}
