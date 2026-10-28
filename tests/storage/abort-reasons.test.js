import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const original = Buffer.from('Original source and target bytes.\n');
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const keys = value instanceof Error ? [...new Set(['message', ...Object.getOwnPropertyNames(value)])].filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functional(value[key])]));
};

test('already cancelled mapped storage retains the actual Node reason and cannot touch source or destination files', { timeout: 30000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'storage-abort-reasons-'));
  await fs.writeFile(path.join(root, 'source.bin'), original); await fs.writeFile(path.join(root, 'target.bin'), original);
  const registry = new StorageRegistry(); registry.registerType('local', configuration => LocalAdapter.open(configuration));
  const adapter = await registry.createInstance('local', 'local', { root, writable: true });
  t.after(async () => {
    try { await registry.close(); }
    finally {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('storage-abort-reasons-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/files', instanceId: 'local', capabilities: { create: true, replace: true, atomicReplace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Cancelled', accessRoot: '/files', style: 'windows',
    returnAccess: 'Cancelled operations retain the original mapped identity and files.' });
  const files = new StorageFileSystem({ vfs, identityMap });
  const reasons = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
    ['error', Object.assign(new Error('The caller cancelled its operation.', { cause: null }), { code: 'caller-cancel', status: 503, errors: [false, undefined] })],
    ['business', { message: 'The caller cancelled its operation.', code: 'business-cancel', name: 'business-name', stack: 'business-stack', errors: [null, false] }]];
  for (const [label, requested] of reasons) {
    // Undefined selects Node's default abort reason; the actual signal is authoritative.
    const signal = AbortSignal.abort(requested), options = { signal };
    for (const [operation, invoke] of [
      ['local-read', () => adapter.openRead('/source.bin', options)],
      ['local-write', () => adapter.write('/target.bin', Buffer.from('Must not write.'), options)],
      ['local-atomic', () => adapter.write('/target.bin', Buffer.from('Must not publish.'), { ...options, atomic: true })],
      ['vfs-stat', () => vfs.stat('/files/source.bin', options)],
      ['vfs-list', () => vfs.list('/files', options)],
      ['vfs-read', () => vfs.openRead('/files/source.bin', options)],
      ['vfs-write', () => vfs.write('/files/target.bin', Buffer.from('Must not write.'), options)],
      ['file-read', () => files.readFile('Z:\\Cancelled\\source.bin', options)],
      ['file-stream', async () => { for await (const _chunk of files.createReadStream('Z:\\Cancelled\\source.bin', options)) assert.fail('A cancelled read cannot return bytes.'); }],
    ]) await t.test(label + '/' + operation, async () => {
      const result = await Promise.resolve().then(invoke).then(value => ({ failed: false, value }), error => ({ failed: true, error }));
      assert.equal(result.failed, true); assert.equal(result.error.code, 'cancelled');
      assert.equal(Object.hasOwn(result.error, 'cause'), true);
      assert.deepEqual(functional(result.error.cause), functional(signal.reason));
      assert.deepEqual(await fs.readFile(path.join(root, 'source.bin')), original);
      assert.deepEqual(await fs.readFile(path.join(root, 'target.bin')), original);
      assert.deepEqual((await fs.readdir(root)).sort(), ['source.bin', 'target.bin']);
      t.diagnostic(JSON.stringify({ label, operation, actualReason: errorObservation(signal.reason), failure: errorObservation(result.error) }));
    });
  }
  await files.writeFile('Z:\\Cancelled\\target.bin', 'Recovered complete bytes.');
  assert.equal(await files.readFile('Z:\\Cancelled\\target.bin', 'utf8'), 'Recovered complete bytes.');
  assert.deepEqual(await files.readFile('Z:\\Cancelled\\source.bin'), original);
});
