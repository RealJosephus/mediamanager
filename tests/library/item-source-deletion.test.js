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
  await assert.rejects(finish(), { code: 'version-changed' });
  assert.deepEqual(calls, []);
});

test('a timeout while checking a required media file must reach the caller', async () => {
  const mount = { root: '/' };
  const calls = [];
  const vfs = {
    resolve: () => ({ mount, path: '/film.mkv', capabilities: { delete: true } }),
    async stat() { calls.push('stat'); throw new StorageError('timeout', 'fixture timeout'); },
    async delete() { calls.push('delete'); }
  };
  const finish = prepareItemSourceDeletion({ item: { Path: '/movies/film.mkv' }, accessPath: '/movies/film.mkv', vfs, fileLeaf: true });
  await assert.rejects(finish(), { code: 'timeout' });
  assert.deepEqual(calls, ['stat']);
});

for (const sidecar of [false, true]) {
  test(`a mount switch during stat cannot redirect a ${sidecar ? 'sidecar' : 'recursive directory'} deletion`, async () => {
    const mount = { root: '/' }, deleted = [];
    let adapter = {};
    const vfs = {
      resolve: path => ({ adapter, mount, path, capabilities: { delete: true } }),
      list: async () => ({ entries: [{ kind: 'file', name: 'film.srt' }] }),
      async stat(path) {
        if (path === (sidecar ? '/movies/film.srt' : '/movies/film')) adapter = {};
        return { kind: path.endsWith('.mkv') || path.endsWith('.srt') ? 'file' : 'directory' };
      },
      delete: async path => { deleted.push(path); },
    };
    const accessPath = '/movies/film' + (sidecar ? '.mkv' : '');
    const finish = prepareItemSourceDeletion({ item: { Path: accessPath }, vfs, accessPath, mixed: sidecar, fileLeaf: sidecar });
    await assert.rejects(finish(), { code: 'version-changed' });
    assert.deepEqual(deleted, sidecar ? [accessPath] : []);
  });
}

test('a missing source and an unavailable optional subtitle still allow the other sidecars to be deleted', async () => {
  const mount = { root: '/' }, deleted = [];
  const vfs = {
    resolve: path => ({ mount, path, capabilities: { delete: true } }),
    list: async () => ({ entries: ['film.srt', 'film.nfo'].map(name => ({ kind: 'file', name })) }),
    async stat(path) {
      if (path.endsWith('.mkv')) throw new StorageError('not-found', 'Missing media');
      if (path.endsWith('.srt')) throw new StorageError('timeout', 'Unavailable subtitle');
      return { kind: path === '/movies' ? 'directory' : 'file' };
    },
    delete: async path => { deleted.push(path); },
  };
  const accessPath = '/movies/film.mkv';
  await prepareItemSourceDeletion({ item: { Path: accessPath }, accessPath, vfs, mixed: true, fileLeaf: true })();
  assert.deepEqual(deleted, ['/movies/film.nfo']);
});
