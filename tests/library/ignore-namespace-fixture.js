import path from 'node:path';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';

export async function knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots, adapterType = 'memory', namespace = 'known-ignore-ancestor' }) {
  const source = identityMap.exportState(), ignoreIdentityMap = new IdentityAccessMap();
  for (const prefix of source.prefixes) ignoreIdentityMap.addPrefix(prefix);
  const roots = new Map();
  for (const identityRoot of identityRoots) {
    const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(identityRoot), api = windows ? path.win32 : path.posix;
    roots.set(api.parse(identityRoot).root, windows ? 'windows' : 'posix');
  }
  for (const [identityRoot, style] of roots) {
    const api = style === 'windows' ? path.win32 : path.posix;
    if (source.prefixes.some(prefix => prefix.style === style && api.resolve(prefix.identityRoot) === api.resolve(identityRoot))) continue;
    const id = namespace + '-' + roots.size + '-' + [...roots.keys()].indexOf(identityRoot);
    await registry.createInstance(id, adapterType, {});
    vfs.mount({ path: '/' + id, instanceId: id, capabilities: {} });
    ignoreIdentityMap.addPrefix({ identityRoot, accessRoot: '/' + id, style,
      returnAccess: 'Known empty ancestors of this isolated fixture namespace.' });
  }
  return ignoreIdentityMap;
}

export async function knownAncestorIgnoreRule(options) {
  return new DotIgnoreRule({ vfs: options.vfs, identityMap: await knownAncestorIgnoreIdentityMap(options) });
}
