import { testFileSystem } from './plugin-files.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageRegistry, VirtualFileSystem, ProbeReadBridge, probeRaw } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { captureRemoteAssets, restoreRemoteAssets } from '../../src/migration/remote-assets.js';
import { startActualAList } from './helpers/actual-alist.js';

const executable = process.env.MEDIAMANAGER_ALIST_EXECUTABLE;
const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
const evidenceDirectory = process.env.MEDIAMANAGER_ALIST_EVIDENCE;
async function read(handle) {
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await handle.close(); }
}
function wave() {
  const result = Buffer.alloc(1644);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(1600, 40);
  return result;
}

test('actual current-source AList supports VFS byte access, network NFO and ffprobe', { skip: !executable || !connectionString ? 'Actual AList executable and isolated PostgreSQL are required.' : false }, async (t) => {
  const service = await startActualAList({ connectionString, evidenceDirectory });
  const requests = [], checks = [];
  const registry = new StorageRegistry();
  registry.registerType('alist', config => new AListAdapter(config, { resolveCredential: async () => service.token,
    fetch: async (url, options) => {
      const requestUrl = new URL(url); const headers = new Headers(options.headers);
      const response = await fetch(url, options);
      requests.push({ method: options.method, path: requestUrl.pathname, apiCredential: headers.has('authorization'), password: headers.has('password'), cookie: headers.has('cookie'), range: headers.get('range'), status: response.status, acceptRanges: response.headers.get('accept-ranges'), contentRange: response.headers.get('content-range'), contentLength: response.headers.get('content-length') });
      return response;
    } }));
  await registry.createInstance('actual', 'alist', { baseUrl: service.baseUrl, credentialRef: 'synthetic', pageSize: 2, capabilities: { create: true, replace: true, mkdir: true, rename: true, delete: true } });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/network', instanceId: 'actual', root: '/Synthetic',
    capabilities: { create: true, replace: true, mkdir: true, rename: true, delete: true } });
  const bridge = new ProbeReadBridge(vfs);
  t.after(async () => {
    await bridge.close(); await registry.close(); await service.stop();
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(path.join(evidenceDirectory, 'actual-validation.json'), `${JSON.stringify({ service: 'current-source AList', database: 'postgres', driver: 'Local with synthetic-only root behind actual HTTP API', checks, requests, evidenceCredentials: 'redacted' }, null, 2)}\n`);
    }
  });
  const bytes = wave(); const mediaPath = '/network/中文 %2F # sample.wav';
  await t.test('synchronous upload preserves names, byte length and modification time', async () => {
    await vfs.write(mediaPath, bytes, { overwrite: false, modified: '2026-09-25T01:02:03.456Z' });
    const info = await vfs.stat(mediaPath);
    assert.equal(info.size, BigInt(bytes.length)); assert.equal(info.kind, 'file');
    assert.equal(Date.parse(info.modified), Date.parse('2026-09-25T01:02:03.456Z'));
    assert.equal(info.version, null);
    assert.deepEqual(await read(await vfs.openRead(mediaPath)), bytes);
    checks.push({ operation: 'write/stat/read', path: mediaPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  });
  await t.test('actual raw endpoint honors bounded, suffix and open byte ranges', async () => {
    for (const [range, start, end] of [[{ start: 1n, end: 9n }, 1, 10], [{ suffix: 12n }, bytes.length - 12, bytes.length], [{ start: 1638n }, 1638, bytes.length]]) {
      const handle = await vfs.openRead(mediaPath, { range });
      assert.equal(handle.rangeHonored, true); assert.equal(handle.acceptRanges, 'bytes');
      assert.equal(handle.totalSize, BigInt(bytes.length)); assert.deepEqual(await read(handle), bytes.subarray(start, end));
    }
    await assert.rejects(vfs.openRead(mediaPath, { range: { start: BigInt(bytes.length) } }), error => error.code === 'range-not-satisfiable' && error.details.totalSize === BigInt(bytes.length));
    const ignored = await vfs.openRead(mediaPath, { range: { start: 2n, end: 5n }, ifRange: '"different-version"' });
    assert.equal(ignored.rangeHonored, false); assert.deepEqual(await read(ignored), bytes);
    checks.push({ operation: 'Range', cases: 5, passed: true });
  });
  await t.test('multi-page enumeration, mkdir, rename and remove use actual driver operations', async () => {
    await vfs.mkdir('/network/folder');
    await vfs.write('/network/second.nfo', Buffer.from('<movie><title>synthetic</title></movie>'));
    await vfs.write('/network/third.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nSynthetic\n'));
    await assert.rejects(vfs.rename('/network/second.nfo', '/network/third.srt'), { code: 'already-exists' });
    const listing = await vfs.list('/network');
    assert.equal(listing.complete, true); assert.equal(listing.deletionSafe, false); assert.equal(listing.entries.length, 4);
    await vfs.rename('/network/second.nfo', '/network/renamed.nfo');
    assert.equal((await vfs.stat('/network/renamed.nfo')).kind, 'file');
    await vfs.delete('/network/renamed.nfo');
    await assert.rejects(vfs.stat('/network/renamed.nfo'), { code: 'not-found' });
    checks.push({ operation: 'list/mkdir/rename/delete', passed: true, consistency: listing.consistency });
  });
  await t.test('actual overwrite rejection retains the original object', async () => {
    await assert.rejects(vfs.write(mediaPath, Buffer.from('replace'), { overwrite: false }), { code: 'already-exists' });
    assert.deepEqual(await read(await vfs.openRead(mediaPath)), bytes);
    checks.push({ operation: 'overwrite:false', preserved: true });
  });
  await t.test('NFO plugin saves and reads sidecar metadata through actual service', async () => {
    const stateSpoolRoot = path.join(service.root, 'metadata-spool');
    await mkdir(stateSpoolRoot, { recursive: true });
    const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs, spoolRoot: stateSpoolRoot });
    const item = { Type: 'Video', Path: 'Z:\\identity\\中文 %2F # sample.wav', Name: '网络旁文件 %2F', DateCreated: '2026-01-01T00:00:00Z' };
    const saved = await plugin.save(item, { accessPath: mediaPath });
    assert.equal(saved.changed, true);
    assert.equal((await plugin.getMetadata(item, { accessPath: mediaPath })).Item.Name, item.Name);
    assert.equal((await plugin.save(item, { accessPath: mediaPath })).changed, false);
    assert.equal(item.Path, 'Z:\\identity\\中文 %2F # sample.wav');
    checks.push({ operation: 'network NFO', path: saved.path, identicalSaveSkipped: true });
  });
  await t.test('installed ffprobe reads actual AList bytes through the VFS lease', async () => {
    const result = await probeRaw(bridge, mediaPath, { executable: validationExecutable('ffprobe'), extractChapters: true });
    assert.equal(result.exitCode, 0); assert.equal(result.raw.streams[0].codec_name, 'pcm_s16le');
    assert.equal(result.raw.format.duration, '0.100000'); assert.equal(result.sourceConsistency, 'unversioned');
    checks.push({ operation: 'ffprobe', codec: result.raw.streams[0].codec_name, duration: result.raw.format.duration, sourceConsistency: result.sourceConsistency });
  });
  await t.test('remote migration refuses unsupported snapshot and conditional restore guarantees', async () => {
    await assert.rejects(captureRemoteAssets({ vfs, assets: [{ assetId: 'third-subtitle', kind: 'subtitle', restorePath: 'third.srt', virtualPath: '/network/third.srt' }], destination: path.join(service.root, 'migration') }), /reliable conditional object versions/u);
    await assert.rejects(restoreRemoteAssets({ vfs, directory: service.root, manifest: { generation: 'fixture', remoteAssets: [{
      path: 'remote-assets/third.srt', bytes: 0, sha256: '0'.repeat(64), modifiedAt: null, remote: {
        assetId: 'third-subtitle', virtualPath: '/network/third.srt', version: 'fixture', kind: 'subtitle' } }] }, targets: { 'third-subtitle': '/network/restored.srt' } }), /create, atomic conditional replace and reliable versions/u);
    checks.push({ operation: 'migration consistency guards', capture: 'rejected unversioned source', restore: 'rejected non-atomic target' });
  });
  await t.test('actual download requests exclude API credentials', () => {
    const raw = requests.filter(request => !request.path.startsWith('/api/'));
    assert.ok(raw.length > 0);
    assert.ok(raw.every(request => !request.apiCredential && !request.password && !request.cookie));
    checks.push({ operation: 'credential isolation', rawRequests: raw.length, passed: true });
  });
});
