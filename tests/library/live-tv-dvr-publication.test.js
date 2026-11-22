import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { LiveTvDvr } from '../../src/library/live-tv-dvr.js';
import { saveRecordingAssets } from '../../src/library/live-tv-recording-assets.js';
import { PlaybackService } from '../../src/playback/service.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { IdentityAccessMap, StorageError, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { openStorageFixture } from '../storage/configured-fixture.js';

const footage = Buffer.alloc(3760, 0x47), foreign = Buffer.alloc(footage.length, 0x11);

async function recordingFixture(t, { stream, endIn = 60000, local = false, beforeClose } = {}) {
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
  const recordingRoot = local ? path.join(root, 'local') : remoteRoot;
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
  const assets = [], failures = [], scans = [], now = Date.now();
  let tuned = 0;
  let timer = { Id: 'recording', Name: 'Remote DVR', ChannelId: 'owned', StartDate: new Date(now).toISOString(),
    EndDate: new Date(now + endIn).toISOString(), Status: 'New', PrePaddingSeconds: 0, PostPaddingSeconds: 0, RetryCount: 0 };
  function newDvr(publicationRetryMs) {
    const attempted = Promise.withResolvers(), completed = Promise.withResolvers();
    const source = { Container: 'ts', Protocol: 'Http', RequiresOpening: true };
    const dvr = new LiveTvDvr({
      fileSystem, dataPath: root, publicationRetryMs,
      configuration: { getConfiguration: async () => ({ RecordingPath: recordingRoot }), release() {} },
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
      queueLibraryScan: () => scans.push(timer.RecordingPath),
      runBackground: operation => operation().finally(() => {
        attempted.resolve();
        if (timer?.Status === 'Completed') completed.resolve();
      }),
    });
    instances.push(dvr);
    return { dvr, attempted: attempted.promise, completed: completed.promise };
  }
  return { root, remote, remoteRoot, recordingRoot, publicationRoot, vfs, fileSystem, newDvr, assets, failures, scans, get timer() { return timer; },
    get tuned() { return tuned; } };
}

test('DVR keeps the original local reservation through shutdowns before and after writing bytes', { timeout: 20000 }, async t => {
  const waiting = [Promise.withResolvers(), Promise.withResolvers()];
  const fixture = await recordingFixture(t, { local: true, stream: async function* (signal, tuned) {
    if (tuned === 2) yield footage;
    if (tuned === 3) { yield foreign; return; }
    waiting[tuned - 1].resolve();
    if (!signal.aborted) await once(signal, 'abort');
  } });
  const { recordingRoot, publicationRoot, newDvr } = fixture;
  Object.assign(fixture.timer, { IsMovie: true, ProductionYear: 2020 });
  const directory = path.join(recordingRoot, 'Remote DVR (2020)');
  const collision = path.join(directory, 'Remote DVR (2020).ts');
  await mkdir(directory, { recursive: true });
  await writeFile(collision, foreign);

  let target;
  for (const [index, gated] of waiting.entries()) {
    const { dvr } = newDvr(100);
    await dvr.start(); await gated.promise; await dvr.close();
    assert.equal(fixture.timer.Status, 'InProgress');
    const [spool] = await readdir(publicationRoot);
    const state = JSON.parse(await readFile(path.join(publicationRoot, spool, 'publication.json'), 'utf8'));
    assert.equal(state.phase, 'capturing');
    target ??= state.path;
    assert.equal(state.path, target);
    assert.notEqual(target, collision);
    assert.deepEqual(await readFile(target), index === 0 ? Buffer.alloc(0) : footage);
  }

  const { dvr, completed } = newDvr(100);
  await dvr.start(); await completed;
  assert.equal(fixture.timer.RecordingPath, target);
  assert.equal(fixture.tuned, 3);
  const captured = await readFile(target);
  assert.equal(captured.length, footage.length + foreign.length);
  assert.deepEqual(captured, Buffer.concat([footage, foreign]));
  assert.deepEqual(await readFile(collision), foreign);
  assert.deepEqual(await readdir(publicationRoot), []);
  assert.deepEqual(fixture.failures, []);
});

async function postProcessor(root) {
  const script = path.join(root, 'post-processor.cjs');
  const started = path.join(root, 'post-started'), finished = path.join(root, 'post-finished');
  const release = () => writeFile(path.join(root, 'post-release'), 'continue');
  await writeFile(script, `const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout } = require('node:timers/promises');
async function run() {
  await fs.appendFile(path.join(__dirname, 'post-started'), process.argv[2] + '\\n');
  while (!await fs.stat(path.join(__dirname, 'post-release'), { throwIfNoEntry: false }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })) await setTimeout(20);
  await fs.writeFile(path.join(__dirname, 'post-finished'), await fs.readFile(process.argv[2]), { flag: 'wx' });
}
run().catch(error => { console.error(error); process.exitCode = 1; });
`);
  return { started, finished, release, configure(dvr, recordingRoot) {
    dvr.configuration.getConfiguration = async () => ({ RecordingPath: recordingRoot,
      RecordingPostProcessor: process.execPath, RecordingPostProcessorArguments: `"${script}" "{path}"` });
  } };
}

async function waitForPostProcessor(filename, signal) {
  for (;;) {
    try { if ((await readFile(filename)).length) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20, undefined, { signal });
  }
}

test('DVR shutdown drains the actual post-processing program after committing a recording', { timeout: 20000 }, async t => {
  const fixture = await recordingFixture(t, { local: true, stream: async function* () { yield footage; } });
  const processor = await postProcessor(fixture.root);
  const first = fixture.newDvr(60000);
  processor.configure(first.dvr, fixture.recordingRoot);
  try {
    await first.dvr.start(); await waitForPostProcessor(processor.started, t.signal);
    assert.equal(fixture.timer.Status, 'Completed');
    const closing = first.dvr.close();
    assert.equal(await Promise.race([closing.then(() => true), delay(100, false)]), false);
    await processor.release(); await closing;
    assert.deepEqual(await readFile(processor.finished), footage);
    const [spool] = await readdir(fixture.publicationRoot);
    const state = JSON.parse(await readFile(path.join(fixture.publicationRoot, spool, 'publication.json'), 'utf8'));
    assert.equal(state.phase, 'processed');
    assert.deepEqual(fixture.scans, []);

    const next = fixture.newDvr(60000);
    processor.configure(next.dvr, fixture.recordingRoot);
    await next.dvr.start(); await next.completed; await next.dvr.close();
    assert.deepEqual(fixture.scans, [fixture.timer.RecordingPath]);
    assert.deepEqual(await readdir(fixture.publicationRoot), []);
    assert.equal(await readFile(processor.started, 'utf8'), fixture.timer.RecordingPath + '\n');
    assert.equal(fixture.tuned, 1);
    assert.deepEqual(fixture.failures, []);
  } finally { await processor.release(); }
});

test('DVR restart completes post-processing when the committed timer update loses its response', { timeout: 20000 }, async t => {
  const fixture = await recordingFixture(t, { local: true, stream: async function* () { yield footage; } });
  const processor = await postProcessor(fixture.root);
  const first = fixture.newDvr(60000);
  processor.configure(first.dvr, fixture.recordingRoot);
  const update = first.dvr.timers.updateRecordingTimer;
  first.dvr.timers.updateRecordingTimer = async (timer, change, options) => {
    const value = await update(timer, change, options);
    if (change?.Status === 'Completed') throw new Error('The committed timer response was lost.');
    return value;
  };
  await processor.release(); await first.dvr.start(); await first.completed; await first.dvr.close();
  const [spool] = await readdir(fixture.publicationRoot);
  const record = JSON.parse(await readFile(path.join(fixture.publicationRoot, spool, 'publication.json'), 'utf8'));
  assert.equal(record.phase, 'post-processing');
  assert.equal(record.path, fixture.timer.RecordingPath);
  await assert.rejects(readFile(processor.started), { code: 'ENOENT' });

  const next = fixture.newDvr(60000);
  processor.configure(next.dvr, fixture.recordingRoot);
  await next.dvr.start(); await next.completed;
  assert.deepEqual(await readFile(processor.finished), footage);
  assert.deepEqual(await readFile(fixture.timer.RecordingPath), footage);
  assert.deepEqual(await readdir(fixture.publicationRoot), []);
  assert.equal(fixture.tuned, 1);
});

test('DVR reserves another name if a local capture was replaced while stopped', { timeout: 20000 }, async t => {
  const waiting = Promise.withResolvers();
  const fixture = await recordingFixture(t, { local: true, stream: async function* (signal, tuned) {
    yield footage;
    if (tuned === 1) {
      waiting.resolve();
      if (!signal.aborted) await once(signal, 'abort');
    }
  } });
  const first = fixture.newDvr(100);
  await first.dvr.start(); await waiting.promise; await first.dvr.close();
  const [spool] = await readdir(fixture.publicationRoot);
  const state = JSON.parse(await readFile(path.join(fixture.publicationRoot, spool, 'publication.json'), 'utf8'));
  await rename(state.path, state.path + '.moved');
  await writeFile(state.path, foreign);

  const next = fixture.newDvr(100);
  await next.dvr.start(); await next.completed;
  assert.notEqual(fixture.timer.RecordingPath, state.path);
  assert.deepEqual(await readFile(fixture.timer.RecordingPath), footage);
  assert.deepEqual(await readFile(state.path), foreign);
  assert.deepEqual(await readFile(state.path + '.moved'), footage);
  assert.deepEqual(fixture.failures, []);
});

test('DVR writes a playable TS and a sidecar through independent configured bindings', { timeout: 20000 }, async t => {
  const fixture = await recordingFixture(t, { local: true, stream: async function* () { yield footage; } });
  const { root, recordingRoot } = fixture;
  const media = path.join(root, 'media-backend'), metadata = path.join(root, 'metadata-backend');
  await mkdir(media); await mkdir(metadata);
  const style = process.platform === 'win32' ? 'windows' : 'posix';
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
  const filename = path.join(root, 'storage.json');
  await writeFile(filename, JSON.stringify({
    instances: [['app', root], ['media', media], ['metadata', metadata]].map(([id, directory]) =>
      ({ id, type: 'local', config: { root: directory, writable: true } })),
    mounts: ['app', 'media', 'metadata'].map(id => ({ path: '/' + id, instanceId: id, capabilities })),
    prefixes: [
      { identityRoot: root, accessRoot: '/app', style },
      { identityRoot: recordingRoot, accessRoot: '/media', style },
      { identityRoot: recordingRoot, accessRoot: '/metadata', style, purpose: 'metadata' },
    ].map(prefix => ({ ...prefix, caseSensitive: style !== 'windows', returnAccess: 'Isolated DVR fixture' })),
  }));
  const storage = await openStorageFixture(t, filename);
  storage.fileSystem.spoolRoot = path.join(root, 'spool');

  const { dvr, completed } = fixture.newDvr(100);
  Object.assign(dvr, { fileSystem: storage.fileSystem, mediaFileSystem: storage.mediaFileSystem, retainStorage: storage.retainGeneration,
    saveAssets: options => saveRecordingAssets({ ...options, library: dvr.library }) });
  dvr.configuration.getConfiguration = async () => ({ RecordingPath: recordingRoot, SaveRecordingNFO: true });
  await dvr.start(); await completed;
  const identity = fixture.timer.RecordingPath;
  const relative = path.relative(recordingRoot, identity), sidecar = relative.replace(/\.ts$/u, '.nfo');
  assert.deepEqual(await readFile(path.join(media, relative)), footage);
  assert.match(await readFile(path.join(metadata, sidecar), 'utf8'), /<title>Remote DVR<\/title>/u);
  await assert.rejects(readFile(path.join(metadata, relative)), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(media, sidecar)), { code: 'ENOENT' });

  const id = randomUUID();
  const playback = new PlaybackService({ vfs: storage.vfs, identityMap: storage.identityMap,
    library: { getItemRecord: async () => ({ Id: id, Path: identity }), getMediaSources: async () => [{ Id: id.replaceAll('-', ''), Protocol: 'File' }] },
    getEncodingOptions: () => ({}) });
  const result = await playback.file(id, { playback: true });
  const server = http.createServer((request, response) => {
    result.send(request, response).catch(error => response.writeHead(error.status ?? 500).end());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/recording.ts`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), footage);
  assert.deepEqual(fixture.failures, []);
});

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
