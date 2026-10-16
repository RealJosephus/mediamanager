import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RootFolderFileData, nativeDirectoryFullName, nativeFileSystemPathsEqual } from '../../src/library/root-folder-file-data.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

for (const identity of [
  { root: 'Z:\\LibraryRefresh', style: 'windows', separator: '\\' },
  { root: '\\\\media-server\\share\\LibraryRefresh', style: 'windows', separator: '\\' },
  { root: '/LibraryRefresh', style: 'posix', separator: '/' },
]) test(`root shortcut reaches mapped ${identity.style} media identity ${identity.root} on any host`, async t => {
  const registry = new StorageRegistry();
  t.after(() => registry.close());
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {});
  for (const directory of ['/views', '/media', '/media/Album']) await adapter.mkdir(directory);
  const album = identity.root + identity.separator + 'Album';
  await adapter.write('/views/source.mblink', Buffer.from(album + identity.separator), { overwrite: true });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/mapped', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: '/instance/views', accessRoot: '/mapped/views', style: 'posix', returnAccess: 'root shortcut fixture' });
  identityMap.addPrefix({ identityRoot: identity.root, accessRoot: '/mapped/media', style: identity.style, returnAccess: 'mapped media fixture' });
  const source = new RootFolderFileData({ assets: new MetadataImageAssets({ vfs, identityMap }) });
  assert.equal((await source.directoryInfo(identity.root)).Exists, true);
  const args = await source.resolveArgs({ Type: 'Folder', Path: '/instance/views' });
  assert.deepEqual(args.locations, ['/instance/views', album]);
  assert.deepEqual(args.files, [{ Path: album, Name: 'Album', IsDirectory: true, Exists: true }]);
  assert.deepEqual((await source.normalizeRootPaths([
    { Path: album, IsDirectory: true }, { Path: identity.root, IsDirectory: true },
  ])).map(entry => entry.Path), [identity.root], 'descendants are removed using the identity namespace separators');
});

test('root identity normalization preserves explicit styles, host-relative resolution and invalid-path errors', () => {
  assert.equal(nativeDirectoryFullName('Z:/Library/../Movies'), 'Z:\\Movies');
  assert.equal(nativeDirectoryFullName('/library/../Movies'), '/Movies');
  assert.equal(nativeDirectoryFullName('relative/../Movies'), path.resolve('relative/../Movies'));
  assert.equal(nativeFileSystemPathsEqual('Z:\\Movies\\', 'z:\\movies'), true);
  assert.equal(nativeFileSystemPathsEqual('/Movies/', '/Movies'), true);
  assert.equal(nativeFileSystemPathsEqual('/Movies', '/movies'), false);
  assert.equal(nativeFileSystemPathsEqual('/Movies\\', '/Movies'), false, 'a POSIX trailing backslash is part of the name');
  assert.throws(() => nativeDirectoryFullName(null), { nativeException: 'ArgumentNullException' });
  for (const value of ['', 'bad\0path']) assert.throws(() => nativeDirectoryFullName(value), { nativeException: 'ArgumentException' });
});
