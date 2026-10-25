import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRegistry, VirtualFileSystem, StorageError } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { detectUdfDiscType } from '../../src/storage/udf-disc-type.js';
import { makeUdfImage, sealUdfDescriptor } from './fixtures/udf-disc-type.js';

const failureValues = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });
const assertFailureValues = (t, actual, expected) => {
  t.diagnostic(JSON.stringify({ failureDiagnostic: { ...failureValues(actual), stack: actual?.stack } }));
  assert.deepEqual(failureValues(actual), failureValues(expected));
  return true;
};

async function fixture(t, bytes, { ignoreRange = false, chunked = false, transform } = {}) {
  const registry = new StorageRegistry();
  t.after(() => registry.close());
  registry.registerType('udf-fixture', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('udf', 'udf-fixture', {});
  await adapter.write('/disc.img', bytes, { modified: new Date('2026-10-19T00:00:00Z') });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/library', instanceId: 'udf', capabilities: {} });
  const active = new Set(), requests = [], open = adapter.openRead.bind(adapter);
  adapter.openRead = async (path, options) => {
    requests.push(options);
    const handle = await open(path, ignoreRange ? { ...options, range: undefined } : options);
    active.add(handle);
    const result = { ...handle, close: async () => { try { await handle.close(); } finally { active.delete(handle); } } };
    if (chunked) result.stream = (async function* () {
      for await (const bytes of handle.stream) {
        for (let offset = 0; offset < bytes.length; offset += 173) yield bytes.subarray(offset, offset + 173);
      }
    })();
    return transform ? await transform(result, requests.length) : result;
  };
  return { vfs, adapter, active, requests, path: '/library/disc.img' };
}

test('UDF root classification reads Type1 and metadata partitions with FE/EFE and the supported allocation formats', async t => {
  for (const options of [
    { discType: 'Dvd', allocation: 'short' },
    { discType: 'BluRay', allocation: 'long', extended: true },
    { discType: 'Dvd', allocation: 'embedded' },
    { discType: 'BluRay', metadata: true, allocation: 'short', extended: true },
    { discType: 'Dvd', metadata: true, allocation: 'long' },
    { discType: 'BluRay', metadata: true, allocation: 'embedded', extended: true }
  ]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, makeUdfImage(options));
      const version = (await f.vfs.stat(f.path)).version;
      assert.equal(await detectUdfDiscType(f.vfs, f.path, { version }), options.discType);
      assert.equal(f.active.size, 0, 'classification releases every storage read');
      assert.ok(f.requests.every(request => request.ifMatch === version), 'all reads use the selected object identity');
    });
  }
});

test('UDF physical sector detection covers the reference reader sector sizes', async t => {
  for (const sectorSize of [512, 1024, 4096]) {
    const f = await fixture(t, makeUdfImage({ sectorSize, discType: 'BluRay' }));
    assert.equal(await detectUdfDiscType(f.vfs, f.path), 'BluRay');
    assert.equal(f.active.size, 0);
  }
});

test('UDF root classification requires a live directory entry, decodes compressed Unicode and prefers DVD', async t => {
  const f = await fixture(t, makeUdfImage({ entries: [
    { name: 'VIDEO_TS', directory: false }, { name: 'VIDEO_TS', deleted: true },
    { name: 'VIDEO_TS', parent: true }, { name: 'VıDEO_TS', utf16: true }, { name: 'bdmv', utf16: true }
  ] }));
  assert.equal(await detectUdfDiscType(f.vfs, f.path), 'BluRay');
  await f.adapter.write('/disc.img', makeUdfImage({ entries: [{ name: 'BDMV' }, { name: 'video_ts', utf16: true }] }));
  assert.equal(await detectUdfDiscType(f.vfs, f.path), 'Dvd');
  await f.adapter.write('/disc.img', makeUdfImage({ discType: null }));
  assert.equal(await detectUdfDiscType(f.vfs, f.path), null);
  assert.equal(f.active.size, 0);
});

test('UDF long allocations read directory records crossing noncontiguous extents', async t => {
  const entries = [...Array.from({ length: 13 }, (_, i) => ({ name: `Other_${i}` })), { name: 'BDMV' }];
  const f = await fixture(t, makeUdfImage({ sectorSize: 512, allocation: 'long', extended: true, split: true, entries }));
  assert.equal(await detectUdfDiscType(f.vfs, f.path), 'BluRay');
  assert.equal(f.active.size, 0);
});

test('UDF classification consumes the correct offset when storage does not honor Range', async t => {
  const f = await fixture(t, makeUdfImage({ metadata: true, discType: 'BluRay' }), { ignoreRange: true, chunked: true });
  assert.equal(await detectUdfDiscType(f.vfs, f.path), 'BluRay');
  assert.equal(f.active.size, 0);
});

test('UDF classification rejects corrupt, truncated and cyclic metadata without leaking reads', async t => {
  const badTag = makeUdfImage(); badTag[256 * 2048 + 4] ^= 1;
  const outsidePartition = makeUdfImage();
  const partition = outsidePartition.subarray(257 * 2048, 258 * 2048);
  partition.writeUInt32LE(0xffffffff, 188); sealUdfDescriptor(partition, 5, 257);
  const badRoot = makeUdfImage(); badRoot[302 * 2048] = 0;
  const cyclic = makeUdfImage({ metadata: true });
  const metadataEntry = cyclic.subarray(301 * 2048, 302 * 2048);
  metadataEntry.writeUInt16LE(1, 34); metadataEntry.writeUInt32LE(16, 212);
  metadataEntry.writeUInt32LE(32 * 2048, 216); metadataEntry.writeUInt32LE(0, 220); metadataEntry.writeUInt16LE(1, 224);
  sealUdfDescriptor(metadataEntry, 266, 1, 216);
  for (const bytes of [Buffer.alloc(1024), badTag, outsidePartition, badRoot, cyclic, makeUdfImage().subarray(0, 303 * 2048)]) {
    const f = await fixture(t, bytes);
    await assert.rejects(detectUdfDiscType(f.vfs, f.path), { code: 'invalid-response' });
    assert.equal(f.active.size, 0);
  }
});

test('UDF classification propagates cancellation and closes the active storage handle', async t => {
  const controller = new AbortController(), reason = Object.assign(new Error('UDF fixture cancelled'), { code: 'controlled-udf-cancellation' });
  const f = await fixture(t, makeUdfImage(), { transform: handle => {
    const stream = handle.stream;
    return { ...handle, stream: (async function* () { controller.abort(reason); yield* stream; })() };
  } });
  await assert.rejects(detectUdfDiscType(f.vfs, f.path, { signal: controller.signal }), error => assertFailureValues(t, error, reason));
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.active.size, 0);
  const count = f.requests.length;
  await assert.rejects(detectUdfDiscType(f.vfs, f.path, { signal: controller.signal }), error => assertFailureValues(t, error, reason));
  assert.equal(f.requests.length, count, 'an already cancelled operation opens no new read');
});

test('UDF classification rejects stale and mid-read object versions', async t => {
  const bytes = makeUdfImage();
  let f;
  f = await fixture(t, bytes, { transform: async (handle, count) => {
    if (count === 1) await f.adapter.write('/disc.img', bytes);
    return handle;
  } });
  await assert.rejects(detectUdfDiscType(f.vfs, f.path, { version: 'old-version' }), { code: 'version-changed' });
  assert.equal(f.requests.length, 0);
  await assert.rejects(detectUdfDiscType(f.vfs, f.path), { code: 'version-changed' });
  assert.equal(f.active.size, 0);
});

test('UDF assets without versions use size and modification time without requiring capabilities', async t => {
  const f = await fixture(t, makeUdfImage());
  let finishTime;
  const assets = {
    async stat(path, options) {
      const { version, ...info } = await f.vfs.stat(path, options);
      return { ...info, modified: new Date(finishTime ?? info.modified) };
    },
    async openRead(path, options) {
      const { version, ...handle } = await f.vfs.openRead(path, options);
      return { ...handle, modified: '2026-10-19T00:00:00.000Z' };
    }
  };
  assert.equal(await detectUdfDiscType(assets, f.path), 'Dvd');
  const open = assets.openRead.bind(assets);
  assets.openRead = async (...args) => { const handle = await open(...args); finishTime = '2026-10-20T00:00:00Z'; return handle; };
  await assert.rejects(detectUdfDiscType(assets, f.path), { code: 'version-changed' });
  assert.equal(f.active.size, 0);
});

test('UDF classification preserves upstream version failure values', async t => {
  const f = await fixture(t, makeUdfImage()), error = new StorageError('version-changed', 'The backend replaced the image.');
  const vfs = { stat: f.vfs.stat.bind(f.vfs), openRead: async () => { throw error; } };
  await assert.rejects(detectUdfDiscType(vfs, f.path), actual => assertFailureValues(t, actual, error));
  assert.equal(f.active.size, 0);
});

test('UDF format failure cannot hide a concurrent change in an asset without versions', async t => {
  const bytes = makeUdfImage(), changed = Buffer.from(bytes);
  changed[302 * 2048] = 0;
  const f = await fixture(t, bytes);
  let replaced = false;
  const assets = {
    async stat(path, options) {
      const { version, ...info } = await f.vfs.stat(path, options);
      return info;
    },
    async openRead(path, options) {
      const { version, ...handle } = await f.vfs.openRead(path, options);
      if (!replaced) {
        replaced = true;
        await f.adapter.write('/disc.img', changed, { modified: new Date('2026-10-20T00:00:00Z') });
      }
      return handle;
    }
  };
  await assert.rejects(detectUdfDiscType(assets, f.path), { code: 'version-changed' });
  assert.equal(f.active.size, 0);
});
