import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';

/** A private test directory accessed through the ordinary local plugin. */
export async function localStateStorage(root) {
  if (!path.isAbsolute(root)) throw new TypeError('Local state storage requires an absolute test root.');
  const registry = new StorageRegistry();
  try {
    registry.registerType('local', configuration => LocalAdapter.open(configuration));
    await registry.createInstance('state', 'local', { root, writable: true });
    const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    vfs.mount({ path: '/state', instanceId: 'state', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true,
    } });
    identityMap.addPrefix({ identityRoot: root, accessRoot: '/state', style: process.platform === 'win32' ? 'windows' : 'posix',
      caseSensitive: process.platform !== 'win32',
      returnAccess: 'The isolated test state retains its physical identity.' });
    return { fileSystem: new StorageFileSystem({ vfs, identityMap }), close: () => registry.close() };
  } catch (error) { await registry.close(); throw error; }
}
