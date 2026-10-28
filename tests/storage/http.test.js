import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpAdapter } from '../../plugins/http/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, ProbeReadBridge } from '../../src/storage/index.js';
import { sourceUriPath } from '../../src/storage/uri.js';
import { vfsStreamResult } from '../../src/http/binary-result.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { assertPortableMountStorageConfiguration } from '../../src/storage/portable-mount-contract.js';
import { openConfiguredPluginHost } from '../plugins/configuration-host.js';
import { openStorageFixture } from './configured-fixture.js';
import { startHttpSource, readStorageHandle } from './helpers/http-source.js';

async function fixture(t) {
  const source = await startHttpSource(), registry = new StorageRegistry();
  registry.registerType('http', config => new HttpAdapter(config));
  const adapter = await registry.createInstance('source', 'http', {}), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({ path: '/http', instanceId: 'source', capabilities: {} });
  identityMap.addPrefix({ identityRoot: 'http:', style: 'uri', accessRoot: '/http', returnAccess: 'Keep the original public source URI.' });
  t.after(async () => { await registry.close(); await source.close(); });
  return { source, registry, adapter, vfs, identityMap, access: target => identityMap.resolve({ identityPath: source.origin + target }) };
}

test('HTTP storage preserves URL identity and signed query, proves GET-only metadata and remains read-only', { timeout: 15000 }, async t => {
  const f = await fixture(t), identity = f.source.origin + '/bytes?sig=Ab%2f%2F+%252F&part=1&part=2#original-fragment';
  const access = f.identityMap.resolve({ identityPath: identity, style: 'uri' });
  assert.equal(f.identityMap.identityFor(access).identityPath, identity);
  assert.deepEqual(await readStorageHandle(await f.vfs.openRead(access)), f.source.bytes);
  const receipt = await f.source.observe(entry => entry.target === '/bytes?sig=Ab%2f%2F+%252F&part=1&part=2');
  assert.equal(receipt.method, 'GET'); await receipt.socketClosed;
  const info = await f.vfs.stat(f.access('/chunked'));
  assert.equal(info.kind, 'file'); assert.equal(info.size, null); assert.equal(info.modified, null); assert.equal(info.version, null);
  await assert.rejects(f.vfs.stat(f.access('/missing')), error => error.code === 'not-found' && error.details.status === 404);
  assert.ok(f.source.events.every(entry => entry.method === 'GET'));
  for (const capability of ['create', 'replace', 'mkdir', 'delete', 'rename', 'atomicReplace', 'conditionalWrite', 'watch', 'reliableVersion']) assert.equal(f.vfs.capabilities(access)[capability], false);
  await assert.rejects(f.vfs.write(access, Buffer.from('changed')), { code: 'not-supported' });
  await assert.rejects(f.vfs.list(access), { code: 'not-supported' });
});

test('URI prefixes choose the most specific backend without changing original identity or portable File roots', async () => {
  const mapping = new IdentityAccessMap(), identity = 'HTTPS://Example.test/library/kids/a%2Fb.srt?sig=a+b&sig=%252F#tail';
  mapping.addPrefix({ identityRoot: 'https:', accessRoot: '/public', style: 'uri', returnAccess: 'Original URL remains available.' });
  mapping.addPrefix({ identityRoot: 'https://example.test/library', accessRoot: '/library-http', style: 'uri', returnAccess: 'Source prefix remains configured.' });
  mapping.addPrefix({ identityRoot: 'https://EXAMPLE.test/library/kids', accessRoot: '/kids-http', style: 'uri', returnAccess: 'Independent source prefix remains configured.' });
  const access = mapping.resolve({ identityPath: identity });
  assert.ok(access.startsWith('/kids-http/')); assert.equal(mapping.identityFor(access).identityPath, identity);
  assert.ok(mapping.resolve({ identityPath: 'https://example.test/library-old/a.srt' }).startsWith('/public/'));
  assert.ok(mapping.resolve({ identityPath: 'https://example.test/Library/a.srt' }).startsWith('/public/'));
  const state = mapping.exportState(), restored = new IdentityAccessMap();
  for (const prefix of state.prefixes) restored.addPrefix(prefix);
  assert.equal(restored.identityFor(restored.resolve({ identityPath: identity })).identityPath, identity);
  const contract = { mounts: [{ mountId: 'media', identityRoot: '/native/media', accessRoot: '/media', pathStyle: 'posix', caseSensitive: true, returnPolicy: 'required' }] };
  const configuration = { prefixes: [{ identityRoot: '/native/media', accessRoot: '/media', style: 'posix' }, ...state.prefixes],
    mounts: [{ path: '/media' }, { path: '/public' }, { path: '/library-http' }, { path: '/kids-http' }] };
  assert.deepEqual(assertPortableMountStorageConfiguration(contract, configuration), contract);
  assert.throws(() => mapping.addPrefix({ identityRoot: 'https://example.test/library?secret=x', style: 'uri', accessRoot: '/invalid', returnAccess: 'Unusable query scope.' }), { code: 'invalid-path' });
  assert.throws(() => mapping.identityFor('/kids-http/' + encodeURIComponent('https://other.test/outside.srt')), { code: 'not-found' });
});

test('HTTP normal reads validate actual ranges, ignored ranges, redirects and decompression', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const partial = await f.vfs.openRead(f.access('/bytes'), { range: { suffix: 3 } });
  assert.equal(partial.rangeHonored, true); assert.deepEqual(partial.range, { start: 7n, end: 9n });
  assert.equal((await readStorageHandle(partial)).toString(), '789');
  const ignored = await f.vfs.openRead(f.access('/ignore-range'), { range: { start: 2, end: 4 } });
  assert.equal(ignored.rangeHonored, false); assert.deepEqual(await readStorageHandle(ignored), f.source.bytes);
  const mismatch = await f.vfs.openRead(f.access('/bytes'), { range: { start: 2 }, ifRange: '"different"' });
  assert.equal(mismatch.rangeHonored, false); assert.deepEqual(await readStorageHandle(mismatch), f.source.bytes);
  await assert.rejects(f.vfs.openRead(f.access('/bytes'), { range: { start: 20 } }), error => error.code === 'range-not-satisfiable' && error.details.totalSize === 10n);
  assert.deepEqual(await readStorageHandle(await f.vfs.openRead(f.access('/redirect'))), f.source.bytes);
  assert.ok(f.source.events.some(entry => entry.target === '/bytes?redirected=%2f+%252F'));
  const compressed = await f.vfs.openRead(f.access('/gzip'));
  assert.equal(compressed.contentLength, null); assert.deepEqual(await readStorageHandle(compressed), f.source.bytes);
  const userAgent = 'Owned 中文 agent/1';
  assert.deepEqual(await readStorageHandle(await f.vfs.openResponse(f.access('/bytes?user-agent=1'), { requestHeaders: { 'User-Agent': userAgent } })), f.source.bytes);
  const received = await f.source.observe(entry => entry.target === '/bytes?user-agent=1');
  assert.equal(Buffer.from(received.headers['user-agent'], 'latin1').toString('utf8'), userAgent);
});

async function startResponseServer(t, f) {
  const errors = [], server = http.createServer(async (request, response) => {
    try { await vfsStreamResult(f.vfs, f.access(request.url), { contentType: 'text/plain' }).send(request, response); }
    catch (error) { errors.push(error); if (!response.headersSent) { response.statusCode = error.status ?? 500; response.end('consumer error'); } else response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, errors };
}

test('raw HTTP responses retain source status, headers, error body and unparsed Range/If-Range', { timeout: 15000 }, async t => {
  const f = await fixture(t), consumer = await startResponseServer(t, f);
  for (const [target, status, body] of [['/denied', 403, 'source denied body'], ['/missing', 404, 'source missing body']]) {
    const raw = await fetch(consumer.origin + target, { signal: t.signal });
    assert.equal(raw.status, status); assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8'); assert.equal(await raw.text(), body);
    await assert.rejects(f.vfs.openRead(f.access(target)), error => error.details.status === status);
  }
  const range = 'bytes=0-0, 3-3', ifRange = 'Wed, 21 Oct 2015 07:28:00 GMT';
  const multi = await fetch(consumer.origin + '/multi?signature=%2f+%252F', { headers: { Range: range, 'If-Range': ifRange }, signal: t.signal });
  assert.equal(multi.status, 418); assert.equal(await multi.text(), range + '|' + ifRange);
  const receipt = await f.source.observe(entry => entry.target === '/multi?signature=%2f+%252F');
  assert.equal(receipt.headers.range, range); assert.equal(receipt.headers['if-range'], ifRange); await receipt.socketClosed;
  const partial = await fetch(consumer.origin + '/bytes', { headers: { Range: 'bytes=2-4' }, signal: t.signal });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(partial.headers.get('content-length'), '3'); assert.equal(await partial.text(), '234');
  const outside = await fetch(consumer.origin + '/bytes', { headers: { Range: 'bytes=20-' }, signal: t.signal });
  assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), 'bytes */10'); assert.equal(await outside.text(), 'outside');
  assert.deepEqual(consumer.errors, []);
});

test('public HEAD opens a real source GET then closes the unread handle', { timeout: 15000 }, async t => {
  const f = await fixture(t), consumer = await startResponseServer(t, f);
  const response = await fetch(consumer.origin + '/slow?head-proof=1', { method: 'HEAD', signal: t.signal });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '10'); assert.equal((await response.arrayBuffer()).byteLength, 0);
  const receipt = await f.source.observe(entry => entry.target === '/slow?head-proof=1');
  assert.equal(receipt.method, 'GET'); assert.equal((await receipt.closed).complete, false); await receipt.socketClosed;
});

test('cancel, explicit close and adapter shutdown drain real pending HTTP connections', { timeout: 15000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const handle = await f.vfs.openRead(f.access('/slow?cancel=1'), { signal: controller.signal });
  const iterator = handle.stream[Symbol.asyncIterator](); assert.equal((await iterator.next()).value.toString(), '012');
  const pending = iterator.next(); const cancelled = assert.rejects(pending, error => error.code === 'cancelled');
  controller.abort(new Error('Controlled HTTP read cancellation')); await handle.close(); await cancelled;
  const receipt = await f.source.observe(entry => entry.target === '/slow?cancel=1'); await receipt.socketClosed;
  const unopened = await f.vfs.openRead(f.access('/slow?unread=1')); await unopened.close(); await unopened.close();
  await (await f.source.observe(entry => entry.target === '/slow?unread=1')).socketClosed;
  const opening = f.vfs.openRead(f.access('/headers-hold?shutdown=1'));
  const refused = assert.rejects(opening, error => error.code === 'cancelled');
  const waiting = await f.source.observe(entry => entry.target === '/headers-hold?shutdown=1');
  await f.adapter.close(); await refused; await waiting.socketClosed;
  await assert.rejects(f.adapter.openRead(sourceUriPath(f.source.origin + '/bytes')), { code: 'closed' });
});

test('a truncated HTTP body fails the actual reader and closes its source socket', { timeout: 15000 }, async t => {
  const f = await fixture(t), handle = await f.vfs.openRead(f.access('/truncated?body=1'));
  const iterator = handle.stream[Symbol.asyncIterator](); assert.equal((await iterator.next()).value.toString(), '012');
  const pending = assert.rejects(iterator.next(), error => ['unavailable', 'invalid-response'].includes(error.code));
  const receipt = await f.source.observe(entry => entry.target === '/truncated?body=1'); receipt.destroy();
  await pending; await handle.close(); await receipt.socketClosed;
});

test('probe leases read GET-only HTTP storage and release active bridge and upstream readers', { timeout: 15000 }, async t => {
  const f = await fixture(t), bridge = new ProbeReadBridge(f.vfs);
  t.after(() => bridge.close());
  const lease = await bridge.lease(f.access('/bytes'), { signal: t.signal, expiresInMs: null, extensionHint: '.srt' });
  const partial = await fetch(lease.url, { headers: { Range: 'bytes=2-4' }, signal: t.signal });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '234'); await lease.release();
  assert.equal((await fetch(lease.url, { signal: t.signal })).status, 404);
  const slow = await bridge.lease(f.access('/slow?bridge=1'), { signal: t.signal, expiresInMs: null });
  const response = await fetch(slow.url, { signal: t.signal }), reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), '012');
  const pending = reader.read().catch(error => error); await slow.release();
  const terminal = await pending; assert.ok(terminal instanceof Error || terminal.done);
  for (const receipt of f.source.events.filter(entry => entry.target === '/slow?bridge=1')) await receipt.socketClosed;
  assert.ok(f.source.events.every(entry => entry.method === 'GET'));
  await bridge.close(); await bridge.close();
});

test('official HTTP defaults remain read-only while independent metadata storage is writable', { timeout: 30000 }, async t => {
  const source = await startHttpSource(), directory = await mkdtemp(path.join(os.tmpdir(), 'http-storage-config-'));
  t.after(async () => { await source.close(); await rm(directory, { recursive: true }); });
  const metadata = path.join(directory, 'metadata'); await mkdir(metadata);
  const filename = path.join(directory, 'storage.json');
  await writeFile(filename, JSON.stringify({ instances: [{ id: 'metadata', type: 'local', config: { root: metadata, writable: true } }],
    mounts: [{ path: '/metadata', instanceId: 'metadata', capabilities: { create: true, replace: true, mkdir: true, delete: true } }],
    prefixes: [{ identityRoot: metadata, accessRoot: '/metadata', style: process.platform === 'win32' ? 'windows' : 'posix', purpose: 'metadata', returnAccess: 'Isolated metadata remains independently writable.' }] }));
  const storage = await openStorageFixture(t, filename), access = storage.identityMap.resolve({ identityPath: source.origin + '/bytes?configured=1' });
  assert.equal(storage.vfs.capabilities(access).create, false); assert.equal(storage.vfs.capabilities(access).replace, false);
  assert.deepEqual(await readStorageHandle(await storage.vfs.openRead(access)), source.bytes);
  const cache = path.join(metadata, '0.srt'); await storage.fileSystem.writeFile(cache, Buffer.from('metadata subtitle'));
  assert.equal((await storage.fileSystem.readFile(cache)).toString(), 'metadata subtitle');
  await assert.rejects(storage.vfs.write(access, Buffer.from('wrong backend')), { code: 'not-supported' });
  await storage.bindPath({ identityRoot: source.origin + '/bytes', style: 'uri', instanceId: 'http:http', capabilities: {}, returnAccess: 'Retain the explicitly selected URI source.' });
  assert.deepEqual(await readStorageHandle(await storage.vfs.openRead(storage.identityMap.resolve({ identityPath: source.origin + '/bytes?selected=1' }))), source.bytes);
  await storage.close();
});

test('disabling and re-enabling the official HTTP plugin closes owned responses without deleting URI bindings', { timeout: 30000 }, async t => {
  const source = await startHttpSource(), directory = await mkdtemp(path.join(os.tmpdir(), 'http-plugin-lifetime-'));
  let storage, plugins;
  t.after(async () => { await storage?.close(); await plugins?.close(); await source.close(); await rm(directory, { recursive: true }); });
  plugins = await openConfiguredPluginHost({ directory: path.join(directory, 'plugins') });
  storage = await createConfiguredStorage(path.join(directory, 'storage.json'), { plugins });
  const identity = source.origin + '/slow?plugin=1', access = storage.identityMap.resolve({ identityPath: identity });
  const handle = await storage.vfs.openResponse(access, { signal: t.signal });
  const reader = handle.stream[Symbol.asyncIterator](); assert.equal((await reader.next()).value.toString(), '012');
  const pending = assert.rejects(reader.next(), error => error.code === 'cancelled');
  const receipt = await source.observe(entry => entry.target === '/slow?plugin=1');
  await plugins.setEnabled('http', false); await pending; await handle.close(); await receipt.socketClosed;
  assert.equal(storage.identityMap.identityFor(access).identityPath, identity);
  await assert.rejects(storage.vfs.openRead(access), { code: 'not-supported' });
  await plugins.setEnabled('http', true);
  assert.deepEqual(await readStorageHandle(await storage.vfs.openRead(storage.identityMap.resolve({ identityPath: source.origin + '/bytes?reactivated=1' }))), source.bytes);
  await storage.close(); await plugins.close();
});
