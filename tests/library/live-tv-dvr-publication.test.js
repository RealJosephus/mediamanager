import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { IdentityAccessMap, StorageError, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const footage = Buffer.alloc(3760, 0x47), foreign = Buffer.alloc(footage.length, 0x11);

async function recordingFixture(t, { stream, endIn = 60000, beforeClose } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-dvr-remote-'));
  const registry = new StorageRegistry(), instances = [];
  t.after(async () => {
    beforeClose?.();
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
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  fileSystem.spoolRoot = spoolRoot;
  const assets = [], failures = [], now = Date.now();
  let tuned = 0;
  let timer = { Id: 'recording', Name: 'Remote DVR', ChannelId: 'owned', StartDate: new Date(now).toISOString(),
    EndDate: new Date(now + endIn).toISOString(), Status: 'New', PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
  function newDvr(publicationRetryMs) {
    const attempted = Promise.withResolvers(), completed = Promise.withResolvers();
    const source = { Container: 'ts', Protocol: 'Http', RequiresOpening: true };
    const dvr = new LiveTvDvr({
      fileSystem, dataPath: root, publicationRetryMs,
      configuration: { getConfiguration: async () => ({ RecordingPath: remoteRoot }), release() {} },
      library: { itemCreation: { getItemById: async () => ({ Type: 'LiveTvChannel' }) } },
      mediaSources: { getMediaSources: async () => { tuned++; return [source]; } },
      liveStreams: { openOwned: async () => ({ MediaSource: source, release() {},
        openRead: async ({ signal }) => ({ close() {}, stream: stream(signal, tuned) }) }) },
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
    return { dvr, attempted: attempted.promise, completed: completed.promise };
  }
  return { remote, remoteRoot, publicationRoot, vfs, fileSystem, newDvr, assets, failures, get timer() { return timer; },
    get tuned() { return tuned; } };
}

for (const mode of ['retry', 'restart after a lost response', 'restart after a name collision', 'restart after capture ended early']) {
  test(`DVR retains and publishes staged remote bytes on ${mode}`, { timeout: 20000 }, async t => {
    const allowRetry = Promise.withResolvers(), early = mode === 'restart after capture ended early';
    const fixture = await recordingFixture(t, { endIn: early ? 60000 : 1500, beforeClose: allowRetry.resolve,
      stream: async function* (signal) {
        yield footage;
        if (!early && !signal.aborted) await once(signal, 'abort');
      },
    });
    const { remote, publicationRoot, fileSystem, vfs, newDvr, assets, failures } = fixture;
    const uploads = [];
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

    let run = newDvr(mode === 'retry' ? 100 : 60000);
    await run.dvr.start(); await run.attempted;
    assert.equal(Date.now() < Date.parse(fixture.timer.EndDate), early);
    assert.equal(fixture.timer.Status, 'InProgress');
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
    const { timer, tuned } = fixture;
    assert.equal(tuned, 1);
    assert.equal(timer.RetryCount, 0);
    assert.deepEqual(await fileSystem.readFile(timer.RecordingPath), footage);
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

for (const mode of ['graceful shutdown', 'process exit', 'process exit with legacy metadata']) {
  test(`DVR appends to a still-airing remote recording after ${mode}`, { timeout: 20000 }, async t => {
    const started = Promise.withResolvers(), graceful = mode === 'graceful shutdown';
    const fixture = await recordingFixture(t, { stream: async function* (signal, tuned) {
      if (graceful && tuned === 1) {
        yield footage;
        started.resolve();
        if (!signal.aborted) await once(signal, 'abort');
      } else yield foreign;
    } });
    const { fileSystem, newDvr, publicationRoot, remoteRoot, failures } = fixture;
    let target;
    if (graceful) {
      const run = newDvr(100);
      await run.dvr.start();
      await started.promise;
      await run.dvr.close();
      assert.equal(fixture.timer.Status, 'InProgress');
      const [spool] = await readdir(publicationRoot);
      const state = JSON.parse(await readFile(path.join(publicationRoot, spool, 'publication.json'), 'utf8'));
      assert.equal(state.phase, 'capturing');
      target = state.path;
      await assert.rejects(fileSystem.stat(target), { code: 'ENOENT' });
    } else {
      const spool = path.join(publicationRoot, 'recording-' + randomUUID());
      target = path.join(remoteRoot, 'Remote DVR.ts');
      await fileSystem.mkdir(remoteRoot, { recursive: true });
      await mkdir(spool, { recursive: true });
      const state = { timer: { ...fixture.timer }, path: target, retryCapture: false };
      fixture.timer.Status = 'InProgress';
      if (mode === 'process exit') state.phase = 'capturing';
      await writeFile(path.join(spool, 'publication.json'), JSON.stringify(state));
      await writeFile(path.join(spool, 'recording.ts'), footage);
    }
    const run = newDvr(100);
    await run.dvr.start();
    await run.completed;
    assert.ok(Date.now() < Date.parse(fixture.timer.EndDate));
    assert.equal(fixture.tuned, graceful ? 2 : 1);
    assert.equal(fixture.timer.RetryCount, 0);
    assert.equal(fixture.timer.RecordingPath, target);
    assert.deepEqual(await fileSystem.readFile(target), Buffer.concat([footage, foreign]));
    assert.deepEqual(await readdir(publicationRoot), []);
    assert.deepEqual(failures, []);
  });
}

for (const stage of ['timers', 'spool enumeration']) {
  test(`DVR retries startup after a temporary failure reading ${stage} and schedules later timers`, { timeout: 20000 }, async t => {
    const fixture = await recordingFixture(t, { stream: async function* () { yield footage; } });
    const run = fixture.newDvr(100);
    const unavailable = Object.assign(new Error('The recording state is temporarily unavailable.'), { code: 'EIO' });
    let reads = 0, enumerations = 0;
    t.mock.method(run.dvr.timers, 'readRecordingTimers', async () => {
      if (++reads === 1 && stage === 'timers') throw unavailable;
      return [];
    });
    const readdir = fixture.fileSystem.readdir.bind(fixture.fileSystem);
    t.mock.method(fixture.fileSystem, 'readdir', async (filename, options) => {
      if (filename === fixture.publicationRoot && ++enumerations === 1 && stage === 'spool enumeration') throw unavailable;
      return readdir(filename, options);
    });
    const first = run.dvr.start();
    assert.equal(run.dvr.start(), first);
    await assert.rejects(first, error => error === unavailable);
    assert.equal(fixture.tuned, 0);
    await run.dvr.start();
    assert.equal(reads, 2);
    assert.equal(enumerations, stage === 'spool enumeration' ? 2 : 1);
    // Add a timer after startup. Subsequent publication reads should see it.
    run.dvr.timers.readRecordingTimers.mock.restore();
    run.dvr.syncTimers([fixture.timer]);
    await run.completed;
    assert.equal(fixture.tuned, 1);
    assert.deepEqual(await fixture.fileSystem.readFile(fixture.timer.RecordingPath), footage);
  });
}
