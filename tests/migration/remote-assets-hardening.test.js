import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureRemoteAssets,
  inspectRemoteAssets,
  restoreRemoteAssets,
  validateRemoteAssetManifest,
  verifyRemoteGeneration,
} from '../../src/migration/remote-assets.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function manifestFile({
  assetId = 'asset',
  virtualPath = '/source/asset.nfo',
  restorePath = 'asset.nfo',
  kind = 'nfo',
  version = 'fixture-version',
  payload = Buffer.from('fixture payload'),
} = {}) {
  return {
    path: `remote-assets/${restorePath}`,
    bytes: payload.length,
    sha256: sha256(payload),
    modifiedAt: null,
    remote: { assetId, virtualPath, version, kind },
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function memoryVfs(t, { instanceId = 'storage', mountPath = '/target', writable = true } = {}) {
  const registry = new StorageRegistry();
  registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance(instanceId, 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({
    path: mountPath,
    instanceId,
    capabilities: writable ? {
      create: true,
      replace: true,
      conditionalWrite: true,
      atomicReplace: true,
    } : {},
  });
  t.after(() => registry.close());
  return { adapter, vfs };
}

async function adapterContent(adapter, filename) {
  const handle = await adapter.openRead(filename);
  try {
    const chunks = [];
    for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function writePackagePayload(directory, file, payload) {
  const filename = path.join(directory, 'files', ...file.path.split('/'));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, payload);
  return filename;
}

test('remote manifest rejects traversal and missing declaration fields', () => {
  const valid = manifestFile();
  assert.throws(() => validateRemoteAssetManifest([{ ...valid, path: 'remote-assets/../outside.nfo' }]),
    /Invalid remote state asset declaration/u);

  const missingTopLevel = structuredClone(valid);
  delete missingTopLevel.modifiedAt;
  assert.throws(() => validateRemoteAssetManifest([missingTopLevel]), /Invalid remote state asset declaration/u);

  const missingRemote = structuredClone(valid);
  delete missingRemote.remote.kind;
  assert.throws(() => validateRemoteAssetManifest([missingRemote]), /Invalid remote state asset declaration/u);
});

test('restore refuses a parent junction or symlink that could read outside the package', async t => {
  const linkTypes = process.platform === 'win32' ? ['junction'] : ['dir'];
  for (const linkType of linkTypes) await t.test(linkType, async t => {
    const root = await temporaryDirectory(t, `mediamanager-remote-link-${linkType}-`);
    const directory = path.join(root, 'package');
    const filesRoot = path.join(directory, 'files');
    const outside = path.join(root, 'outside');
    const payload = Buffer.from('outside package payload');
    const file = manifestFile({ payload });
    await mkdir(filesRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'asset.nfo'), payload);
    await symlink(outside, path.join(filesRoot, 'remote-assets'), linkType);

    const { adapter, vfs } = await memoryVfs(t);
    await assert.rejects(restoreRemoteAssets({
      directory,
      manifest: { generation: 'link-test', remoteAssets: [file] },
      vfs,
      targets: { asset: '/target/restored.nfo' },
    }), /parent is not a regular package directory/u);
    await assert.rejects(adapter.stat('/restored.nfo'), { code: 'not-found' });
  });
});

test('capture refuses a parent junction without creating or overwriting files outside the package', async t => {
  const root = await temporaryDirectory(t, 'mediamanager-remote-capture-link-');
  const directory = path.join(root, 'package');
  const filesRoot = path.join(directory, 'files');
  const outside = path.join(root, 'outside');
  const sentinel = Buffer.from('must remain outside');
  await mkdir(filesRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'asset.nfo'), sentinel);
  await symlink(outside, path.join(filesRoot, 'remote-assets'), process.platform === 'win32' ? 'junction' : 'dir');

  const source = await memoryVfs(t, { instanceId: 'capture-link-source', mountPath: '/source', writable: false });
  await source.adapter.write('/asset.nfo', Buffer.from('captured payload'));
  const plan = await inspectRemoteAssets({
    vfs: source.vfs,
    assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
  });
  await assert.rejects(captureRemoteAssets({ plan, destination: directory }), /capture asset parent is not a regular package directory/u);
  assert.deepEqual(await readFile(path.join(outside, 'asset.nfo')), sentinel);
  assert.deepEqual(await readdir(outside), ['asset.nfo']);
});

test('capture refuses a target junction and removes its private temporary file', async t => {
  const root = await temporaryDirectory(t, 'mediamanager-remote-capture-target-link-');
  const directory = path.join(root, 'package');
  const assetDirectory = path.join(directory, 'files', 'remote-assets');
  const outside = path.join(root, 'outside');
  await mkdir(assetDirectory, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'sentinel.txt'), 'must remain outside');
  await symlink(outside, path.join(assetDirectory, 'asset.nfo'), process.platform === 'win32' ? 'junction' : 'dir');

  const source = await memoryVfs(t, { instanceId: 'capture-target-link-source', mountPath: '/source', writable: false });
  await source.adapter.write('/asset.nfo', Buffer.from('captured payload'));
  const plan = await inspectRemoteAssets({
    vfs: source.vfs,
    assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
  });
  await assert.rejects(captureRemoteAssets({ plan, destination: directory }), /target differs from the bound generation/u);
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.deepEqual(await readdir(assetDirectory), ['asset.nfo']);
});

test('capture stream failures remove private temporary bytes and never expose a partial asset', async t => {
  const root = await temporaryDirectory(t, 'mediamanager-remote-capture-partial-');
  const directory = path.join(root, 'package');
  await mkdir(path.join(directory, 'files'), { recursive: true });
  const payload = Buffer.from('complete bound payload');
  const source = await memoryVfs(t, { instanceId: 'capture-partial-source', mountPath: '/source', writable: false });
  await source.adapter.write('/asset.nfo', payload);
  const plan = await inspectRemoteAssets({
    vfs: source.vfs,
    assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
  });
  const openRead = source.adapter.openRead.bind(source.adapter);
  source.adapter.openRead = async (...args) => {
    const handle = await openRead(...args);
    return {
      ...handle,
      stream: (async function* failAfterFirstChunk() {
        yield payload.subarray(0, 5);
        throw new Error('injected capture stream failure');
      }()),
    };
  };

  await assert.rejects(captureRemoteAssets({ plan, destination: directory }), /injected capture stream failure/u);
  const assetDirectory = path.join(directory, 'files', 'remote-assets');
  await assert.rejects(access(path.join(assetDirectory, 'asset.nfo')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(assetDirectory), []);
});

test('capture drains real files and removes temporary bytes when a plugin close throws synchronously', async t => {
  for (const readFailed of [false, true]) await t.test(readFailed ? 'read and close fail' : 'EOF close fails', async t => {
    const root = await temporaryDirectory(t, 'mediamanager-remote-sync-close-');
    const directory = path.join(root, 'package'), filename = path.join(root, 'source.nfo');
    await mkdir(path.join(directory, 'files'), { recursive: true });
    const payload = Buffer.from('Real source bytes retained after a synchronous plugin cleanup failure.');
    await writeFile(filename, payload);
    const source = await memoryVfs(t, { instanceId: 'sync-close-source', mountPath: '/source', writable: false });
    await source.adapter.write('/asset.nfo', payload);
    const plan = await inspectRemoteAssets({ vfs: source.vfs,
      assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }] });
    const primary = Object.assign(new Error('The source failed after a real read.'), { code: 'read-failed', status: 503 });
    const cleanup = Object.assign(new Error('Plugin close failed after releasing its real descriptor.'), { code: 'close-failed' });
    const descriptors = new Set(), closed = [];
    const reading = t.mock.method(source.adapter, 'openRead', async () => {
      const descriptor = openSync(filename, 'r'); descriptors.add(descriptor);
      return { version: plan.assets[0].version, contentLength: BigInt(payload.length),
        stream: (async function* () {
          const bytes = Buffer.alloc(payload.length), count = readSync(descriptor, bytes, 0, bytes.length, 0);
          assert.equal(count, payload.length);
          yield bytes.subarray(0, readFailed ? 5 : count);
          if (readFailed) throw primary;
        }()),
        close() {
          closeSync(descriptor); descriptors.delete(descriptor); closed.push(descriptor);
          throw cleanup;
        } };
    });
    try {
      await assert.rejects(captureRemoteAssets({ plan, destination: directory }), error => {
        if (readFailed) { assert.deepEqual(error.errors, [primary, cleanup]); assert.equal(error.cause, primary); }
        else assert.equal(error, cleanup);
        return true;
      });
      assert.equal(closed.length, 1);
      assert.throws(() => fstatSync(closed[0]), { code: 'EBADF' });
      assert.deepEqual(await readdir(path.join(directory, 'files', 'remote-assets')), []);
      assert.deepEqual(await readFile(filename), payload);
    } finally {
      reading.mock.restore();
      for (const descriptor of descriptors) closeSync(descriptor);
    }
    const captured = await captureRemoteAssets({ plan, destination: directory });
    assert.equal(captured[0].sha256, sha256(payload));
    assert.deepEqual(await readFile(path.join(directory, 'files', 'remote-assets', 'asset.nfo')), payload);
  });
});

test('capture publishes a complete bound asset without leaving its private temporary link', async t => {
  const root = await temporaryDirectory(t, 'mediamanager-remote-capture-publish-');
  const directory = path.join(root, 'package');
  await mkdir(path.join(directory, 'files'), { recursive: true });
  const payload = Buffer.from('atomically published payload');
  const source = await memoryVfs(t, { instanceId: 'capture-publish-source', mountPath: '/source', writable: false });
  await source.adapter.write('/asset.nfo', payload);
  const plan = await inspectRemoteAssets({
    vfs: source.vfs,
    assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
  });

  const captured = await captureRemoteAssets({ plan, destination: directory });
  assert.equal(captured[0].sha256, sha256(payload));
  const assetDirectory = path.join(directory, 'files', 'remote-assets');
  assert.deepEqual(await readFile(path.join(assetDirectory, 'asset.nfo')), payload);
  assert.deepEqual(await readdir(assetDirectory), ['asset.nfo']);
  assert.deepEqual(await captureRemoteAssets({ plan, destination: directory }), captured);
  assert.deepEqual(await readdir(assetDirectory), ['asset.nfo']);
});

test('content digests distinguish backends with the same path, version and size', async t => {
  const left = await memoryVfs(t, { instanceId: 'left', mountPath: '/source', writable: false });
  const right = await memoryVfs(t, { instanceId: 'right', mountPath: '/source', writable: false });
  const leftPayload = Buffer.from('left');
  const rightPayload = Buffer.from('rite');
  await left.adapter.write('/asset.nfo', leftPayload);
  await right.adapter.write('/asset.nfo', rightPayload);
  const assets = [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }];
  const leftPlan = await inspectRemoteAssets({ vfs: left.vfs, assets });
  const rightPlan = await inspectRemoteAssets({ vfs: right.vfs, assets });

  assert.equal(leftPlan.assets[0].virtualPath, rightPlan.assets[0].virtualPath);
  assert.equal(leftPlan.assets[0].version, rightPlan.assets[0].version);
  assert.equal(leftPlan.assets[0].size, rightPlan.assets[0].size);
  assert.notEqual(leftPlan.assets[0].sha256, rightPlan.assets[0].sha256);

  const captured = manifestFile({
    payload: leftPayload,
    version: leftPlan.assets[0].version,
  });
  await assert.rejects(verifyRemoteGeneration(right.vfs, [captured]), /Remote state changed during generation capture/u);
});

test('remote inspection preserves its read failure when closing the same handle also fails', async t => {
  const { adapter, vfs } = await memoryVfs(t, { mountPath: '/source', writable: false });
  const payload = Buffer.from('bound asset bytes');
  await adapter.write('/asset.nfo', payload);
  const readFailure = Object.assign(new Error('The remote asset stream failed.'), { code: 'unavailable' });
  const closeFailure = Object.assign(new Error('The remote asset handle could not close cleanly.'), { code: 'close-failed' });
  const openRead = adapter.openRead.bind(adapter);
  adapter.openRead = async (...args) => {
    const handle = await openRead(...args);
    return { ...handle, stream: (async function* () { yield payload.subarray(0, 4); throw readFailure; }()),
      async close() { await handle.close(); throw closeFailure; } };
  };
  const options = { vfs, assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }] };
  try {
    await assert.rejects(inspectRemoteAssets(options), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(value => ({ code: value.code, message: value.message })),
        [readFailure, closeFailure].map(value => ({ code: value.code, message: value.message })));
      assert.equal(error.cause.code, readFailure.code); assert.equal(error.cause.message, readFailure.message);
      return true;
    });
  } finally { adapter.openRead = openRead; }
  assert.equal((await inspectRemoteAssets(options)).assets[0].sha256, sha256(payload));
  assert.deepEqual(await adapterContent(adapter, '/asset.nfo'), payload);
});

test('remote plugin primitive failures preserve their reason and release real capture resources', async t => {
  for (const [label, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]) {
    await t.test(label, async t => {
      const directory = await temporaryDirectory(t, 'mediamanager-remote-plugin-reason-');
      await mkdir(path.join(directory, 'files'));
      const payload = Buffer.from(`remote plugin failure ${label}`);
      const { adapter, vfs } = await memoryVfs(t, { mountPath: '/source', writable: false });
      await adapter.write('/asset.nfo', payload);
      const plan = await inspectRemoteAssets({ vfs, assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo',
        restorePath: 'asset.nfo', kind: 'nfo' }] });
      const failingRead = t.mock.method(adapter, 'openRead', async () => { throw reason; });
      try {
        await assert.rejects(captureRemoteAssets({ plan, destination: directory }), error => {
          assert.equal(Object.hasOwn(error, 'cause'), true);
          assert.equal(error.cause, reason);
          assert.match(error.message, /Remote asset capture failed/u);
          return true;
        });
      } finally { failingRead.mock.restore(); }
      const assetsRoot = path.join(directory, 'files', 'remote-assets');
      assert.deepEqual(await readdir(assetsRoot), []);
      const captured = await captureRemoteAssets({ plan, destination: directory });
      assert.equal(captured[0].sha256, sha256(payload));
      assert.deepEqual(await readFile(path.join(assetsRoot, 'asset.nfo')), payload);

      const target = await memoryVfs(t, { instanceId: 'restored' });
      const options = { directory, manifest: { generation: `reason-${label}`, remoteAssets: captured },
        vfs: target.vfs, targets: { asset: '/target/asset.nfo' } };
      const failingStat = t.mock.method(target.adapter, 'stat', async () => { throw reason; });
      try {
        const outcome = await restoreRemoteAssets(options).then(
          () => ({ rejected: false }), value => ({ rejected: true, value }));
        assert.equal(outcome.rejected, true);
        assert.equal(outcome.value, reason);
      } finally { failingStat.mock.restore(); }
      await assert.rejects(target.adapter.stat('/asset.nfo'), { code: 'not-found' });
      const restored = await restoreRemoteAssets(options);
      assert.equal(restored.complete, true);
      assert.deepEqual(await adapterContent(target.adapter, '/asset.nfo'), payload);
    });
  }
});

test('restore requests atomic writes and rejects false or missing atomic receipts', async t => {
  for (const receipt of ['false', 'missing']) await t.test(receipt, async t => {
    const directory = await temporaryDirectory(t, `mediamanager-remote-atomic-${receipt}-`);
    const payload = Buffer.from(`atomic receipt ${receipt}`);
    const file = manifestFile({ payload });
    await writePackagePayload(directory, file, payload);
    const { adapter, vfs } = await memoryVfs(t, { instanceId: `target-${receipt}` });
    const write = adapter.write.bind(adapter);
    let options;
    adapter.write = async (...args) => {
      options = args[2];
      const result = await write(...args);
      return receipt === 'false' ? { ...result, atomic: false } : undefined;
    };

    await assert.rejects(restoreRemoteAssets({
      directory,
      manifest: { generation: `atomic-${receipt}`, remoteAssets: [file] },
      vfs,
      targets: { asset: '/target/restored.nfo' },
    }), /did not confirm an atomic complete write/u);
    assert.equal(options.atomic, true);
    assert.equal(options.overwrite, false);
    assert.equal(options.size, BigInt(payload.length));
  });
});

test('payload changes after preflight cannot be published and leave resumable partial progress', async t => {
  const directory = await temporaryDirectory(t, 'mediamanager-remote-buffered-');
  const firstPayload = Buffer.from('first payload');
  const secondPayload = Buffer.from('second original');
  const changedPayload = Buffer.from('second changed!');
  const first = manifestFile({ assetId: 'first', restorePath: 'first.nfo', payload: firstPayload });
  const second = manifestFile({ assetId: 'second', virtualPath: '/source/second.nfo',
    restorePath: 'second.nfo', payload: secondPayload });
  await writePackagePayload(directory, first, firstPayload);
  const secondFilename = await writePackagePayload(directory, second, secondPayload);
  const { adapter, vfs } = await memoryVfs(t);
  const write = adapter.write.bind(adapter);
  let changed = false;
  adapter.write = async (filename, data, options) => {
    if (!changed) {
      changed = true;
      await writeFile(secondFilename, changedPayload);
    }
    return write(filename, data, options);
  };

  await assert.rejects(restoreRemoteAssets({
    directory,
    manifest: { generation: 'buffered-payload', remoteAssets: [first, second] },
    vfs,
    targets: { first: '/target/first.nfo', second: '/target/second.nfo' },
  }), error => {
    assert.match(error.message, /checksum mismatch/u);
    assert.deepEqual(error.remoteRestoreProgress.completed.map(entry => entry.assetId), ['first']);
    return true;
  });
  await assert.rejects(adapter.stat('/second.nfo'), { code: 'not-found' });
  assert.deepEqual(await readFile(secondFilename), changedPayload);
});

test('restore cannot complete when later work changes an already verified remote target', async t => {
  for (const reused of [false, true]) await t.test(reused ? 'reused target' : 'new target', async t => {
    const directory = await temporaryDirectory(t, 'mediamanager-remote-generation-');
    const firstPayload = Buffer.from('first bound payload');
    const secondPayload = Buffer.from('second bound payload');
    const changedPayload = Buffer.from('external edit after verification');
    const first = manifestFile({ assetId: 'first', restorePath: 'first.nfo', payload: firstPayload });
    const second = manifestFile({ assetId: 'second', virtualPath: '/source/second.nfo',
      restorePath: 'second.nfo', payload: secondPayload });
    await writePackagePayload(directory, first, firstPayload);
    await writePackagePayload(directory, second, secondPayload);
    const { adapter, vfs } = await memoryVfs(t);
    if (reused) await adapter.write('/first.nfo', firstPayload);
    const write = adapter.write.bind(adapter);
    adapter.write = async (filename, data, options) => {
      const result = await write(filename, data, options);
      if (filename === '/second.nfo') await write('/first.nfo', changedPayload);
      return result;
    };
    const options = {
      directory,
      manifest: { generation: 'changed-during-restore', remoteAssets: [first, second] },
      vfs,
      targets: { first: '/target/first.nfo', second: '/target/second.nfo' },
    };

    await assert.rejects(restoreRemoteAssets(options), error => {
      assert.match(error.message, /target changed before completion/u);
      assert.equal(error.remoteRestoreProgress.complete, false);
      assert.deepEqual(error.remoteRestoreProgress.completed.map(entry => entry.assetId), ['first', 'second']);
      assert.equal(error.remoteRestoreProgress.completed[0].reused, reused);
      return true;
    });
    assert.deepEqual(await adapterContent(adapter, '/first.nfo'), changedPayload);
    assert.deepEqual(await adapterContent(adapter, '/second.nfo'), secondPayload);
    adapter.write = write;
    await assert.rejects(restoreRemoteAssets(options), /overwrite different target content/u);
    assert.deepEqual(await adapterContent(adapter, '/first.nfo'), changedPayload);
    await write('/first.nfo', firstPayload);
    const restored = await restoreRemoteAssets(options);
    assert.equal(restored.complete, true);
    assert.equal(restored.completed.every(entry => entry.reused), true);
  });
});

test('unknown-size streams stop at the first over-limit chunk without consuming later chunks', async () => {
  let requestedChunks = 0;
  let closed = 0;
  const vfs = {
    capabilities: () => ({ reliableVersion: true }),
    stat: async () => ({ kind: 'file', size: null, version: 'stable-version', modified: null }),
    openRead: async (_filename, options) => {
      assert.equal(options.ifMatch, 'stable-version');
      async function* chunks() {
        requestedChunks++;
        yield Buffer.alloc(3, 1);
        requestedChunks++;
        yield Buffer.alloc(3, 2);
        requestedChunks++;
        yield Buffer.alloc(3, 3);
      }
      return {
        stream: chunks(),
        contentLength: null,
        version: 'stable-version',
        close: async () => { closed++; },
      };
    },
  };

  await assert.rejects(inspectRemoteAssets({
    vfs,
    assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
    maxAssetBytes: 5,
  }), /exceeds the capture limit/u);
  assert.equal(requestedChunks, 2);
  assert.equal(closed, 1);
});

test('capture and restore reject ancestor-descendant path collisions before partial output', async t => {
  const sourceFixture = await memoryVfs(t, { instanceId: 'source-collision', mountPath: '/source' });
  await sourceFixture.adapter.write('/first.nfo', Buffer.from('first'));
  await assert.rejects(inspectRemoteAssets({
    vfs: sourceFixture.vfs,
    assets: [
      { assetId: 'first', virtualPath: '/source/first.nfo', restorePath: 'nested', kind: 'nfo' },
      { assetId: 'second', virtualPath: '/source/second.nfo', restorePath: 'nested/second.nfo', kind: 'nfo' },
    ],
  }), /Colliding remote asset restore path/u);

  const directory = await temporaryDirectory(t, 'mediamanager-remote-collision-');
  const firstPayload = Buffer.from('first'), secondPayload = Buffer.from('second');
  const first = manifestFile({ assetId: 'first', restorePath: 'first.nfo', payload: firstPayload });
  const second = manifestFile({ assetId: 'second', virtualPath: '/source/second.nfo', restorePath: 'second.nfo', payload: secondPayload });
  await writePackagePayload(directory, first, firstPayload);
  await writePackagePayload(directory, second, secondPayload);
  const targetFixture = await memoryVfs(t, { instanceId: 'target-collision' });
  await assert.rejects(restoreRemoteAssets({
    directory,
    manifest: { generation: 'target-collision', remoteAssets: [first, second] },
    vfs: targetFixture.vfs,
    targets: { first: '/target/conflict', second: '/target/conflict/second.nfo' },
  }), /ancestor\/descendant collision/u);
  await assert.rejects(targetFixture.adapter.stat('/conflict'), { code: 'not-found' });
});
