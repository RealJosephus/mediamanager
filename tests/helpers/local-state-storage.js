import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';

export async function writeLocalFixtureStorage(filename, root, { syntheticSeed } = {}) {
  if (!path.isAbsolute(root)) throw new TypeError('Fixture storage requires an absolute directory.');
  const windows = process.platform === 'win32';
  const definition = {
    instances: [{ id: 'media-fixture', type: 'local', config: { root, writable: true } }],
    mounts: [{ path: '/media-fixture', instanceId: 'media-fixture', root: '/', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/media-fixture', style: windows ? 'windows' : 'posix',
      caseSensitive: !windows, returnAccess: 'The isolated fixture retains its physical identity.' }],
  };
  if (syntheticSeed) {
    const id = 'synthetic-media-seed';
    definition.instances.push({ id, type: 'local', config: { root: syntheticSeed, writable: false } });
    definition.mounts.push({ path: '/' + id, instanceId: id, root: '/', capabilities: {} });
    definition.prefixes.push({ identityRoot: 'Z:\\', accessRoot: '/' + id, style: 'windows', caseSensitive: false,
      returnAccess: 'The same-run seed has synthetic identities and no backing media.' });
  }
  await writeFile(filename, JSON.stringify(definition), { flag: 'wx' });
  return filename;
}

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
