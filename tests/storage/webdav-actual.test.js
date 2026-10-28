import { fixturePathStyle } from '../library/fixture-state-path.js';
import { testFileSystem } from './plugin-files.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, ProbeReadBridge, probeRaw } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { captureRemoteAssets, restoreRemoteAssets } from '../../src/migration/remote-assets.js';
import { vfsStreamResult } from '../../src/http/binary-result.js';
import { startActualWebDav } from './helpers/actual-webdav.js';

const executable = process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE;
const evidenceDirectory = process.env.MEDIAMANAGER_WEBDAV_EVIDENCE
  ?? path.join(validationOutputRoot(), `actual-webdav-${randomUUID()}`);

async function read(handle) {
  try {
    const chunks = [];
    for await (const chunk of handle.stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

function wave() {
  const result = Buffer.alloc(1644);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(1600, 40);
  return result;
}

test('actual external rclone WebDAV supports independent VFS access, writes, NFO and ffprobe', {
  skip: !executable ? 'An actual rclone WebDAV executable is required.' : false,
}, async (t) => {
  const service = await startActualWebDav({ evidenceDirectory });
  const requests = [];
  const checks = [];
  let currentAuthorization = service.authorization;
  const registry = new StorageRegistry();
  registry.registerType('webdav', config => new WebDavAdapter(config, {
    resolveCredential: async () => currentAuthorization,
    fetch: async (url, options) => {
      const headers = new Headers(options.headers);
      const response = await fetch(url, options);
      requests.push({ method: options.method, path: new URL(url).pathname, authenticated: headers.has('authorization'),
        depth: headers.get('depth'), range: headers.get('range'), ifRange: headers.get('if-range'),
        ifMatch: headers.get('if-match'), ifNoneMatch: headers.get('if-none-match'),
        destination: headers.get('destination'), overwrite: headers.get('overwrite'), status: response.status,
        contentRange: response.headers.get('content-range'), contentLength: response.headers.get('content-length'),
        etag: response.headers.get('etag') });
      return response;
    },
  }));
  await registry.createInstance('actual', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'synthetic', pageSize: 2,
    capabilities: { create: true, replace: true, mkdir: true, rename: true, delete: true } });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/network', instanceId: 'actual', root: '/', capabilities: {
    create: true, replace: true, mkdir: true, rename: true, delete: true,
  } });
  vfs.mount({ path: '/readonly', instanceId: 'actual', root: '/', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: service.media, accessRoot: '/network', style: fixturePathStyle, caseSensitive: false,
    returnAccess: 'The isolated rclone source root remains directly enumerable by the stopped native instance during return-access validation.' });
  const bridge = new ProbeReadBridge(vfs);
  t.after(async () => {
    await bridge.close();
    await registry.close();
    await service.stop();
    if (evidenceDirectory) {
      await writeFile(path.join(evidenceDirectory, 'actual-validation.json'), `${JSON.stringify({
        service: service.version, protocol: 'WebDAV', backend: 'isolated rclone local root', checks, requests,
        identityMap: identityMap.exportState(), evidenceCredentials: 'redacted',
      }, null, 2)}\n`);
    }
  });

  const bytes = wave();
  const name = '中文 %2F # sample.wav';
  const mediaPath = `/network/${name}`;
  const identityPath = path.join(service.media, name);

  await t.test('identity mapping, create, stat and full read preserve decoded logical names', async () => {
    assert.equal(identityMap.resolve({ identityPath, style: fixturePathStyle }), mediaPath);
    assert.equal(identityMap.identityFor(mediaPath).identityPath, identityPath);
    await vfs.write(mediaPath, bytes, { overwrite: false, size: BigInt(bytes.length) });
    const info = await vfs.stat(mediaPath);
    assert.equal(info.kind, 'file');
    assert.equal(info.size, BigInt(bytes.length));
    assert.deepEqual(await read(await vfs.openRead(mediaPath)), bytes);
    checks.push({ operation: 'identity/create/stat/read', path: mediaPath,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  });

  await t.test('exclusive creation refuses an existing target and preserves its original complete entity', async () => {
    const replacement = Buffer.from('A create-only request must preserve the existing media entity.');
    const before = await read(await vfs.openRead(mediaPath));
    const requestStart = requests.length;
    try {
      const outcome = await vfs.write(mediaPath, replacement, { overwrite: false }).then(
        result => ({ rejected: false, result: { size: String(result.size), atomic: result.atomic, version: result.version } }),
        error => ({ rejected: true, error: { message: error?.message, code: error?.code, details: error?.details } }));
      const after = await read(await vfs.openRead(mediaPath));
      checks.push({ operation: 'exclusive-create-existing-target', path: mediaPath, outcome,
        attempted: { base64: replacement.toString('base64'), sha256: createHash('sha256').update(replacement).digest('hex') },
        before: { base64: before.toString('base64'), sha256: createHash('sha256').update(before).digest('hex') },
        after: { base64: after.toString('base64'), sha256: createHash('sha256').update(after).digest('hex') },
        requests: requests.slice(requestStart) });
      assert.equal(outcome.rejected, true);
      assert.equal(outcome.error.code, 'already-exists');
      assert.deepEqual(after, before);
    } finally {
      await vfs.write(mediaPath, before, { overwrite: true });
    }
  });

  await t.test('competing exclusive creates retain one complete entity and release their own remote staging', async () => {
    const target = '/network/exclusive-race.bin';
    const candidates = [Buffer.alloc(65537, 0x61), Buffer.alloc(131079, 0x62)];
    const requestStart = requests.length;
    const outcomes = await Promise.allSettled(candidates.map(bytes => vfs.write(target, bytes, { overwrite: false })));
    const retained = await read(await vfs.openRead(target));
    const listing = await vfs.list('/network');
    const staging = listing.entries.filter(entry => entry.name.startsWith('.mediamanager-create-'));
    checks.push({ operation: 'competing-exclusive-creates', path: target,
      candidates: candidates.map(bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
      outcomes: outcomes.map(outcome => outcome.status === 'fulfilled'
        ? { status: outcome.status, size: String(outcome.value.size), atomic: outcome.value.atomic, version: outcome.value.version }
        : { status: outcome.status, error: { code: outcome.reason?.code, message: outcome.reason?.message, details: outcome.reason?.details } }),
      retained: { bytes: retained.length, base64: retained.toString('base64'), sha256: createHash('sha256').update(retained).digest('hex') },
      staging, requests: requests.slice(requestStart) });
    const winners = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? index : null).filter(index => index !== null);
    assert.equal(winners.length, 1);
    assert.deepEqual(retained, candidates[winners[0]]);
    assert.deepEqual(staging, []);
    assert.equal(listing.complete, true);
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      assert.ok(['already-exists', 'unavailable'].includes(outcome.reason.code));
      if (outcome.reason.code === 'unavailable') assert.equal(outcome.reason.details.status, 423);
    }
    await assert.rejects(vfs.write(target, Buffer.from('must retain the committed entity'), { overwrite: false }), { code: 'already-exists' });
    assert.deepEqual(await read(await vfs.openRead(target)), retained);
    await vfs.delete(target);
    assert.equal((await vfs.list('/network')).entries.some(entry => entry.name === 'exclusive-race.bin'), false);
  });

  await t.test('bounded, suffix, open and non-monotonic reads retain one strong entity identity', async () => {
    const version = (await vfs.stat(mediaPath)).version;
    assert.match(version, /^"[^"\r\n]+"$/u);
    const cases = [[{ start: 100n, end: 119n }, 100, 120], [{ start: 0n, end: 9n }, 0, 10],
      [{ suffix: 12n }, bytes.length - 12, bytes.length], [{ start: 1638n }, 1638, bytes.length]];
    for (const [range, start, end] of cases) {
      const handle = await vfs.openRead(mediaPath, { range, ifMatch: version });
      assert.equal(handle.rangeHonored, true);
      assert.equal(handle.version, version);
      assert.deepEqual(await read(handle), bytes.subarray(start, end));
    }
    await assert.rejects(vfs.openRead(mediaPath, { range: { start: BigInt(bytes.length) } }), error =>
      error.code === 'range-not-satisfiable' && error.details.totalSize === BigInt(bytes.length));
    const ignored = await vfs.openRead(mediaPath, { range: { start: 2n, end: 5n }, ifRange: '"different"' });
    assert.equal(ignored.rangeHonored, false);
    assert.deepEqual(await read(ignored), bytes);
    const matched = await vfs.openRead(mediaPath, { range: { start: 2n, end: 5n }, ifRange: version });
    assert.equal(matched.rangeHonored, true);
    assert.deepEqual(await read(matched), bytes.subarray(2, 6));
    const replacement = Buffer.from(bytes); replacement[100] ^= 0xff;
    await vfs.write(mediaPath, replacement, { overwrite: true, size: BigInt(replacement.length) });
    await assert.rejects(vfs.openRead(mediaPath, { ifMatch: version }), { code: 'version-changed' });
    await vfs.write(mediaPath, bytes, { overwrite: true, size: BigInt(bytes.length) });
    checks.push({ operation: 'Range/If-Range/If-Match/multi-seek', cases: cases.length + 4, passed: true });
  });

  await t.test('static HEAD traverses VFS and closes the actual upstream GET without consuming media bytes', async () => {
    const before = requests.length;
    const result = vfsStreamResult(vfs, mediaPath, { contentType: 'audio/wav' });
    const server = createServer((request, response) => {
      result.send(request, response).catch(error => {
        if (!response.headersSent) response.statusCode = error.status ?? 500;
        response.end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {
        method: 'HEAD', headers: { Range: 'bytes=10-19' },
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-length'), '10');
      assert.equal(response.headers.get('content-range'), `bytes 10-19/${bytes.length}`);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      const upstream = requests.slice(before);
      assert.equal(upstream.at(-1).method, 'GET');
      assert.equal(upstream.at(-1).range, 'bytes=10-19');
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    checks.push({ operation: 'static HEAD/upstream GET cleanup', passed: true });
  });

  await t.test('pagination detects an out-of-band directory mutation and never becomes deletion-safe', async () => {
    await vfs.mkdir('/network/folder');
    await vfs.write('/network/second.nfo', Buffer.from('<movie><title>synthetic</title></movie>'), { overwrite: false });
    await vfs.write('/network/third.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nSynthetic\n'), { overwrite: false });
    const listing = await vfs.list('/network');
    assert.equal(listing.complete, true);
    assert.equal(listing.consistency, 'weak');
    assert.equal(listing.deletionSafe, false);
    assert.deepEqual(new Set(listing.entries.map(entry => entry.name)), new Set([name, 'folder', 'second.nfo', 'third.srt']));
    const first = await registry.getInstance('actual').listPage('/');
    assert.equal(first.complete, false);
    await writeFile(path.join(service.media, 'outside-change.txt'), 'changed outside WebDAV');
    await assert.rejects(registry.getInstance('actual').listPage('/', { cursor: first.nextCursor }), { code: 'version-changed' });
    await rm(path.join(service.media, 'outside-change.txt'));
    checks.push({ operation: 'paginated PROPFIND/directory mutation', passed: true, deletionSafe: false });
  });

  await t.test('cross-directory MOVE, conflict refusal and delete use independent WebDAV methods', async () => {
    await vfs.mkdir('/network/destination');
    await vfs.rename('/network/second.nfo', '/network/destination/renamed.nfo');
    assert.equal((await vfs.stat('/network/destination/renamed.nfo')).kind, 'file');
    await vfs.write('/network/conflict.nfo', Buffer.from('original'), { overwrite: false });
    await assert.rejects(vfs.rename('/network/destination/renamed.nfo', '/network/conflict.nfo'), { code: 'already-exists' });
    assert.equal((await read(await vfs.openRead('/network/conflict.nfo'))).toString(), 'original');
    await vfs.delete('/network/destination/renamed.nfo');
    await assert.rejects(vfs.stat('/network/destination/renamed.nfo'), { code: 'not-found' });
    checks.push({ operation: 'MKCOL/MOVE/DELETE', crossDirectory: true, conflictPreserved: true });
  });

  await t.test('NFO plugin saves and re-reads a sidecar through actual WebDAV', async () => {
    const stateSpoolRoot = path.join(service.root, 'metadata-spool');
    await mkdir(stateSpoolRoot, { recursive: true });
    const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs, spoolRoot: stateSpoolRoot });
    const item = { Type: 'Video', Path: identityPath, Name: '网络旁文件 %2F', DateCreated: '2026-01-01T00:00:00Z' };
    const saved = await plugin.save(item, { accessPath: mediaPath });
    assert.equal(saved.changed, true);
    assert.equal((await plugin.getMetadata(item, { accessPath: mediaPath })).Item.Name, item.Name);
    assert.equal((await plugin.save(item, { accessPath: mediaPath })).changed, false);
    assert.equal(item.Path, identityPath);
    checks.push({ operation: 'network NFO', path: saved.path, identicalSaveSkipped: true });
  });

  await t.test('installed ffprobe reads actual WebDAV bytes through the private VFS lease', async () => {
    const result = await probeRaw(bridge, mediaPath, { executable: validationExecutable('ffprobe'), extractChapters: true });
    assert.equal(result.exitCode, 0);
    assert.equal(result.raw.streams[0].codec_name, 'pcm_s16le');
    assert.equal(result.raw.format.duration, '0.100000');
    assert.equal(result.sourceConsistency, 'version-precondition');
    checks.push({ operation: 'ffprobe', codec: result.raw.streams[0].codec_name,
      duration: result.raw.format.duration, sourceConsistency: result.sourceConsistency });
  });

  await t.test('authentication failure, create/replace gates and migration guarantees fail closed', async () => {
    currentAuthorization = 'Basic aW52YWxpZDpjcmVkZW50aWFs';
    await assert.rejects(vfs.stat(mediaPath), { code: 'authentication-required' });
    currentAuthorization = service.authorization;
    assert.equal((await vfs.stat(mediaPath)).kind, 'file');
    const wrong = new WebDavAdapter({ baseUrl: service.baseUrl, credentialRef: 'wrong' }, {
      resolveCredential: async () => 'Basic aW52YWxpZDpjcmVkZW50aWFs',
    });
    t.after(() => wrong.close());
    await assert.rejects(wrong.stat('/'), { code: 'authentication-required' });
    const createOnly = new WebDavAdapter({ baseUrl: service.baseUrl, credentialRef: 'synthetic',
      capabilities: { create: true } }, { resolveCredential: async () => service.authorization });
    t.after(() => createOnly.close());
    await createOnly.write('/create-only.txt', Buffer.from('created'), { overwrite: false });
    await assert.rejects(createOnly.write('/create-only.txt', Buffer.from('replace'), { overwrite: true }), { code: 'not-supported' });
    assert.equal((await read(await createOnly.openRead('/create-only.txt'))).toString(), 'created');
    await vfs.delete('/network/create-only.txt');
    const requestCount = requests.length;
    await assert.rejects(vfs.write('/readonly/rejected.nfo', Buffer.from('must not upload'), { overwrite: false }), { code: 'not-supported' });
    await assert.rejects(vfs.delete('/readonly/third.srt'), { code: 'not-supported' });
    assert.equal(requests.length, requestCount);
    await assert.rejects(captureRemoteAssets({ vfs, assets: [{ assetId: 'third-subtitle', kind: 'subtitle',
      restorePath: 'third.srt', virtualPath: '/network/third.srt' }], destination: path.join(service.root, 'migration') }),
    /reliable conditional object versions/u);
    await assert.rejects(restoreRemoteAssets({ vfs, directory: service.root, manifest: { generation: 'fixture', remoteAssets: [{
      path: 'remote-assets/third.srt', bytes: 0, sha256: '0'.repeat(64), modifiedAt: null,
      remote: { assetId: 'third-subtitle', virtualPath: '/network/third.srt', version: 'fixture', kind: 'subtitle' },
    }] }, targets: { 'third-subtitle': '/network/restored.srt' } }), /create, atomic conditional replace and reliable versions/u);
    checks.push({ operation: 'authentication rotation/read-only capability/migration guards', passed: true,
      rejectedBeforeProtocolRequest: true });
  });

  await t.test('credentials stay scoped to the WebDAV origin and every protocol request is authenticated', () => {
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.authenticated));
    assert.ok(requests.some(request => request.method === 'PROPFIND'));
    assert.ok(requests.some(request => request.method === 'GET'));
    assert.ok(requests.some(request => request.method === 'PUT'));
    assert.ok(requests.some(request => request.method === 'MOVE'));
    checks.push({ operation: 'credential scope/protocol independence', requests: requests.length, passed: true });
  });
});
