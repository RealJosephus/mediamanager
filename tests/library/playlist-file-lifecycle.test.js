import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testFileSystem } from '../storage/plugin-files.js';
import { PlaylistFileWriter, preparePlaylistFile } from '../../src/library/playlist-file.js';

const failureValue = error => error == null ? error : {
  message: error.message, code: error.code, status: error.status,
  cause: error.cause === undefined ? undefined : failureValue(error.cause),
  errors: error.errors === undefined ? undefined : Array.from(error.errors, failureValue),
};
const failure = (message, code, status) => Object.assign(new Error(message), { code, status });
const emptySelection = { count: async () => 0n, page: async () => ({ entries: [], release: async () => {} }) };

async function spoolFixture(t, { closeFailure, removeFailure, beforeRemove } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'playlist-file-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let handle;
  const fileSystem = {
    async open(filename, flags) {
      handle = await testFileSystem.open(filename, flags);
      return {
        write: (...args) => handle.write(...args),
        async close() {
          await handle.close();
          if (closeFailure) throw closeFailure;
        },
      };
    },
    createReadStream: (...args) => testFileSystem.createReadStream(...args),
    async rm(...args) {
      await beforeRemove?.();
      if (removeFailure) throw removeFailure;
      await testFileSystem.rm(...args);
    },
  };
  return { root, fileSystem, assertClosed: () => assert.rejects(async () => handle.stat(), { code: 'closed' }) };
}

test('playlist preparation removes its actual spool after a selection and handle-close failure', async t => {
  const selected = failure('The playlist selection failed.', 'selection-failed', 500);
  const closed = failure('The spool close failed after closing the file.', 'EIO', 500);
  const f = await spoolFixture(t, { closeFailure: closed });
  await assert.rejects(preparePlaylistFile(path.join(f.root, 'mix.m3u'), {
    ...emptySelection, count: async () => { throw selected; },
  }, { fileSystem: f.fileSystem, spoolRoot: f.root }), error => {
    assert.deepEqual(failureValue(error), failureValue(new AggregateError([selected, closed], selected.message, { cause: selected })));
    return true;
  });
  await f.assertClosed();
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('playlist preparation preserves selection, close and removal failure values in order', async t => {
  const selected = failure('The playlist selection was cancelled.', 'selection-cancelled', 499);
  const closed = failure('The spool handle failed to close.', 'EIO', 500);
  const removed = failure('The spool could not be removed.', 'EACCES', 403);
  const f = await spoolFixture(t, { closeFailure: closed, removeFailure: removed });
  await assert.rejects(preparePlaylistFile(path.join(f.root, 'mix.m3u'), {
    ...emptySelection, count: async () => { throw selected; },
  }, { fileSystem: f.fileSystem, spoolRoot: f.root }), error => {
    assert.deepEqual(failureValue(error), failureValue(new AggregateError([selected, closed, removed], selected.message, { cause: selected })));
    return true;
  });
  await f.assertClosed();
  const [spool] = await fs.readdir(f.root);
  assert.match(spool, /^playlist-.+\.tmp$/u);
  assert.equal((await fs.stat(path.join(f.root, spool))).isFile(), true);
});

test('playlist page release cannot replace a serialization failure or prevent spool cleanup', async t => {
  const released = failure('The selected page failed to release.', 'XX001', 500);
  const f = await spoolFixture(t);
  const item = { Type: 'Movie', Path: path.join(f.root, 'movie.mkv'), Name: 'Invalid\u0001title' };
  await assert.rejects(preparePlaylistFile(path.join(f.root, 'mix.wpl'), {
    count: async () => 1n,
    page: async () => ({ entries: [{ Ordinal: 1n, item }], release: async () => { throw released; } }),
  }, { fileSystem: f.fileSystem, spoolRoot: f.root }), error => {
    assert.equal(error.cause?.message, 'A playlist XML attribute contains an invalid character.');
    assert.deepEqual(Array.from(error.errors, entry => entry.message), [error.cause.message, released.message]);
    assert.deepEqual(failureValue(error.errors[1]), failureValue(released));
    return true;
  });
  await f.assertClosed();
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('external playlist delivery retains its network failure when spool removal also fails', async t => {
  const delivered = failure('The external playlist upload failed.', 'ECONNRESET', 502);
  const removed = failure('The spool could not be removed.', 'EACCES', 403);
  const f = await spoolFixture(t, { removeFailure: removed });
  const writer = new PlaylistFileWriter({ fileSystem: f.fileSystem, spoolRoot: f.root,
    vfs: { async write(_filename, stream) { for await (const _part of stream) { /* Consume the real spool. */ } throw delivered; } } });
  await assert.rejects(writer.write({ identityPath: path.join(f.root, 'mix.m3u'), accessPath: '/external/mix.m3u' }, emptySelection), error => {
    assert.deepEqual(failureValue(error), failureValue(new AggregateError([delivered, removed], delivered.message, { cause: delivered })));
    return true;
  });
  await f.assertClosed();
  assert.equal((await fs.readdir(f.root)).length, 1);
});

test('every playlist close waits for the actual spool removal', async t => {
  const started = Promise.withResolvers(), proceed = Promise.withResolvers();
  const f = await spoolFixture(t, { beforeRemove: async () => { started.resolve(); await proceed.promise; } });
  const prepared = await preparePlaylistFile(path.join(f.root, 'mix.m3u'), emptySelection,
    { fileSystem: f.fileSystem, spoolRoot: f.root });
  let settled = false;
  const first = prepared.close();
  await started.promise;
  const second = prepared.close().finally(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal((await fs.readdir(f.root)).length, 1);
    assert.throws(() => prepared.stream(), /released/u);
  } finally {
    proceed.resolve();
    await Promise.all([first, second]);
  }
  await f.assertClosed();
  assert.deepEqual(await fs.readdir(f.root), []);
  await prepared.close();
});
