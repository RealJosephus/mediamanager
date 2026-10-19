import path from 'node:path';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { encodeIgnoreFile } from './dot-ignore-fixture.js';

export async function ensureFixtureDirectory(fixture, accessPath) {
  const pending = [];
  for (let current = accessPath;; current = path.posix.dirname(current)) {
    try {
      if ((await fixture.vfs.stat(current)).kind !== 'directory') throw new Error('Fixture parent is not a directory.');
      break;
    } catch (error) {
      if (error.code !== 'not-found' || current === '/') throw error;
      pending.push(current);
    }
  }
  for (const current of pending.reverse()) await fixture.vfs.mkdir(current);
}

// Only ignore searches see the known ancestor namespace. Instance state files
// continue using their real local paths through the original identity map.
export async function prepareIgnoreFileFixture(fixture, ignoreFiles = []) {
  const identityMap = new IdentityAccessMap(), exported = fixture.identityMap.exportState();
  for (const prefix of exported.prefixes) identityMap.addPrefix(prefix);
  for (const binding of exported.bindings) identityMap.bind(binding.itemId, binding.accessPath);
  await fixture.storage.createInstance('state-ignore-ancestors', 'memory', {});
  fixture.vfs.mount({ path: '/state-ignore-ancestors', instanceId: 'state-ignore-ancestors',
    capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  identityMap.addPrefix({ identityRoot: path.parse(fixture.stateRoot).root, accessRoot: '/state-ignore-ancestors', style: 'windows',
    returnAccess: 'Known empty ancestors of the controlled native state namespace.' });
  fixture.ignoreRule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap });
  fixture.ignoreFilePaths = [];
  for (const file of ignoreFiles) {
    const identityPath = path.join(fixture.stateRoot, file.path), accessPath = identityMap.resolve({ identityPath, style: 'windows' });
    await ensureFixtureDirectory(fixture, path.posix.dirname(accessPath));
    await fixture.vfs.write(accessPath, encodeIgnoreFile(file.text, file.encoding ?? 'utf8'), {
      modified: '2025-01-03T04:05:06.0000000Z'
    });
    if (!file.path.startsWith('media/')) fixture.ignoreFilePaths.push({ identityPath, accessPath });
  }
}

export async function projectAncestorIgnoreFiles(fixture, hashFile) {
  for (const file of fixture.ignoreFilePaths ?? []) {
    const handle = await fixture.vfs.openRead(file.accessPath), chunks = [];
    try { for await (const bytes of handle.stream) chunks.push(Buffer.from(bytes)); }
    finally { await handle.close(); }
    hashFile(file.identityPath, Buffer.concat(chunks));
  }
}
