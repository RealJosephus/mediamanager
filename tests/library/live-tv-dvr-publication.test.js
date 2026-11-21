import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { IdentityAccessMap, StorageError, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const footage = Buffer.alloc(3760, 0x47), foreign = Buffer.alloc(footage.length, 0x11);

for (const mode of ['retry', 'restart after a lost response', 'restart after a name collision']) {
  test(`DVR retains and publishes staged remote bytes on ${mode}`, { timeout: 20000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-dvr-remote-'));
    const registry = new StorageRegistry(), instances = [];
    const allowRetry = Promise.withResolvers();
    t.after(async () => {
      allowRetry.resolve();
      for (const dvr of instances) await dvr.close();
      await registry.close();
      await rm(root, { recursive: true, force: true });
    });
    registry.registerType('local', config => LocalAdapter.open(config));
    registry.registerType('remote', () => new MemoryStorageAdapter());
    await registry.createInstance('local', 'local', { root, writable: true });
    const remote = await registry.createInstance('remote', 'remote', {});
    const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    const remoteRoot = path.join(root, 'remote'), spoolRoot = path.join(root, 'spool');
    const publicationRoot = path.join(spoolRoot, 'dvr-publications');
    for (const [id, directory, capabilities] of [
      ['local', root, { create: true, replace: true, mkdir: true, delete: true, rename: true }],
      ['remote', remoteRoot, { create: true, mkdir: true }],
    ]) {
      vfs.mount({ path: '/' + id, instanceId: id, capabilities });
      identityMap.addPrefix({ identityRoot: directory, accessRoot: '/' + id,
        style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: false, returnAccess: 'Isolated DVR fixture' });
    }

    const uploads = [], assets = [], failures = [];
    let tuned = 0;
    const write = remote.write.bind(remote);
    t.mock.method(remote, 'write', async (name, bytes, options) => {
      assert.equal(options.overwrite, false);
      assert.equal(options.size, BigInt(footage.length));
      uploads.push(name);
      if (uploads.length === 1) {
        if (mode === 'restart after a lost response') await write(name, bytes, options);
        if (mode === 'restart after a name collision') await write(name, foreign, options);
        throw new StorageError('unavailable', 'The upload response failed.');
      }
      await allowRetry.promise;
      return write(name, bytes, options);
    });

    const now = Date.now();
    let timer = { Id: 'recording', Name: 'Remote DVR', ChannelId: 'owned', StartDate: new Date(now).toISOString(),
      EndDate: new Date(now + 1500).toISOString(), Status: 'New', PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
    function newDvr(retryMs) {
      const fileSystem = new StorageFileSystem({ vfs, identityMap });
      fileSystem.spoolRoot = spoolRoot;
      const attempted = Promise.withResolvers(), completed = Promise.withResolvers();
      const source = { Container: 'ts', Protocol: 'Http', RequiresOpening: true };
      const dvr = new LiveTvDvr({
        fileSystem, dataPath: root, publicationRetryMs: retryMs,
        configuration: { getConfiguration: async () => ({ RecordingPath: remoteRoot }), release() {} },
        library: { itemCreation: { getItemById: async () => ({ Type: 'LiveTvChannel' }) } },
        mediaSources: { getMediaSources: async () => { tuned++; return [source]; } },
        liveStreams: { openOwned: async () => ({ MediaSource: source, release() {},
          openRead: async ({ signal }) => ({ close() {}, stream: (async function* () {
            yield footage;
            if (!signal.aborted) await once(signal, 'abort');
          })() }) }) },
        timers: {
          readRecordingTimers: async () => timer ? [timer] : [],
          updateRecordingTimer: async (original, change) => {
            timer = change && { ...(timer ?? original), ...change };
            dvr.syncTimers(timer ? [timer] : []);
            return true;
          },
        },
        saveAssets: ({ filename }) => assets.push(filename), onError: error => failures.push(error),
        runBackground: operation => operation().finally(() => {
          attempted.resolve();
          if (timer?.Status === 'Completed') completed.resolve();
        }),
      });
      instances.push(dvr);
      return { dvr, fileSystem, attempted: attempted.promise, completed: completed.promise };
    }

    let run = newDvr(mode === 'retry' ? 100 : 60000);
    await run.dvr.start(); await run.attempted;
    assert.ok(Date.now() >= Date.parse(timer?.EndDate));
    assert.equal(timer.Status, 'InProgress');
    const [spool] = await readdir(publicationRoot);
    assert.deepEqual(await readFile(path.join(publicationRoot, spool, 'recording.ts')), footage);
    assert.deepEqual(assets, []);
    if (mode !== 'retry') {
      await run.dvr.close();
      run = newDvr(100);
      await run.dvr.start();
    }
    allowRetry.resolve();
    await run.completed;
    assert.deepEqual(failures.map(error => error.code), ['unavailable']);
    assert.equal(tuned, 1);
    assert.equal(timer.RetryCount, 0);
    assert.deepEqual(await run.fileSystem.readFile(timer.RecordingPath), footage);
    assert.deepEqual(assets, [timer.RecordingPath]);
    assert.deepEqual(await readdir(publicationRoot), []);
    if (mode === 'restart after a name collision') {
      assert.equal(uploads.length, 2);
      assert.notEqual(uploads[0], uploads[1]);
      const original = await vfs.openRead('/remote' + uploads[0]);
      try { assert.deepEqual(Buffer.from((await original.stream.next()).value), foreign); }
      finally { await original.close(); }
    } else if (mode === 'restart after a lost response') assert.equal(uploads.length, 1);
    else assert.equal(uploads.length, 2);
  });
}
