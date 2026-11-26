import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareItemSourceDeletion } from '../../src/library/item-source-deletion.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { StorageError } from '../../src/storage/errors.js';

test('a prepared source operation keeps its original storage target after reconfiguration', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-storage-'));
  const filename = path.join(directory, 'storage.json');
  const calls = [];
  const extension = { type: 'memory', async create(config) {
    const adapter = new MemoryStorageAdapter();
    await adapter.write('/film.mkv', Buffer.from('fixture'));
    adapter.delete = async name => { calls.push([config.label, name]); };
    return adapter;
  } };
  const plugins = { directory, entries: () => [], bind: async (_kind, add) => add(extension), subscribe: () => () => {} };
  const storage = await createConfiguredStorage(filename, { plugins });
  t.after(async () => { await storage.close(); await rm(filename, { force: true }); await rmdir(directory); });
  const config = label => ({ instances: [{ id: 'films', type: 'memory', config: { label } }],
    mounts: [{ path: '/movies', instanceId: 'films', root: '/', capabilities: { delete: true } }], prefixes: [] });
  await storage.configure(config('original'));
  const finish = prepareItemSourceDeletion({ item: { Path: '/movies/film.mkv' }, accessPath: '/movies/film.mkv',
    vfs: storage.vfs, metadataVfs: storage.metadataVfs, fileLeaf: true });
  await storage.configure(config('replacement'));
  const result = await Promise.allSettled([finish()]);
  t.diagnostic(JSON.stringify({ result: result[0].status, adapterCalls: calls }));
  assert.ok(!calls.some(([label]) => label === 'replacement'), 'A pending operation targeted the replacement backend');
});

test('a timeout while checking a required media file must reach the caller', async t => {
  const mount = { root: '/' };
  const calls = [];
  const vfs = {
    resolve: () => ({ mount, path: '/film.mkv', capabilities: { delete: true } }),
    async stat() { calls.push('stat'); throw new StorageError('timeout', 'fixture timeout'); },
    async delete() { calls.push('delete'); }
  };
  const finish = prepareItemSourceDeletion({ item: { Path: '/movies/film.mkv' }, accessPath: '/movies/film.mkv', vfs, fileLeaf: true });
  const [result] = await Promise.allSettled([finish()]);
  t.diagnostic(JSON.stringify({ result: result.status, calls }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.code, 'timeout');
});
