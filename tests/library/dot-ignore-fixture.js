import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const root = new URL('./fixtures/dot-ignore-rule/', import.meta.url);
export const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));

export function encodeIgnoreFile(text, encoding) {
  if (encoding?.startsWith('utf32')) {
    const big = encoding === 'utf32be', codepoints = [...text];
    const bytes = Buffer.alloc(4 + codepoints.length * 4);
    const write = big ? bytes.writeUInt32BE.bind(bytes) : bytes.writeUInt32LE.bind(bytes);
    write(0xfeff, 0); codepoints.forEach((value, index) => write(value.codePointAt(0), 4 + index * 4));
    return bytes;
  }
  if (encoding?.startsWith('utf16')) {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    return encoding === 'utf16be' ? bytes.swap16() : bytes;
  }
  return Buffer.concat([encoding === 'utf8bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text)]);
}

export async function prepareFileSample(t, sample) {
  const storage = new StorageRegistry(); storage.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/all', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\', accessRoot: '/all', style: 'windows',
    returnAccess: 'Full isolated identity root includes the known empty ancestor directories.' });
  t.after(() => storage.close());
  const directories = new Set(['/']);
  const mkdir = async name => {
    for (const part of name.split('/').filter(Boolean).map((_, index, parts) => '/' + parts.slice(0, index + 1).join('/'))) {
      if (!directories.has(part)) { await adapter.mkdir(part); directories.add(part); }
    }
  };
  const execute = async (rule, action) => {
    const access = '/cases/' + sample.id + (action.path ? '/' + action.path : '');
    if (action.operation === 'write') {
      await mkdir(path.posix.dirname(access));
      await adapter.write(access, encodeIgnoreFile(action.text, action.encoding), { modified: action.modified ?? '2025-01-01T00:00:00Z' });
    } else if (action.operation === 'remove') await adapter.delete(access);
    else if (action.operation === 'clear') rule.clearDirectoryCache();
    else {
      await mkdir(action.isDirectory ? access : path.posix.dirname(access));
      if (!action.isDirectory) await adapter.write(access, Buffer.from('media'));
      const result = await rule.check('Z:' + access.replaceAll('/', '\\'), { isDirectory: action.isDirectory });
      return { result, record: { path: action.path, isDirectory: action.isDirectory ?? false, ignored: result.ignored } };
    }
  };
  return { storage, adapter, vfs, identityMap, execute };
}
