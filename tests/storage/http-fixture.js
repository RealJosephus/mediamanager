import { HttpAdapter } from '../../plugins/http/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';

export async function openHttpStorage() {
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  registry.registerType('http', configuration => new HttpAdapter(configuration));
  await registry.createInstance('http', 'http', {});
  vfs.mount({ path: '/http', instanceId: 'http', capabilities: {} });
  for (const [protocol, accessRoot] of [['http:', '/http'], ['https:', '/https']]) {
    if (accessRoot !== '/http') vfs.mount({ path: accessRoot, instanceId: 'http', capabilities: {} });
    identityMap.addPrefix({ identityRoot: protocol, accessRoot, style: 'uri', returnAccess: 'Isolated HTTP resource retains its source URI.' });
  }
  return { registry, vfs, identityMap, access: identityPath => identityMap.resolve({ identityPath }), close: () => registry.close() };
}
