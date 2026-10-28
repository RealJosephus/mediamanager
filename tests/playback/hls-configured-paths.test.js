import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import path from 'node:path';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { HlsService } from '../../src/playback/hls.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/hls-reference.json' with { type: 'json' };

const segmentOptions = { SegmentContainer: 'ts', SegmentLength: 6, DeviceId: 'configured-device',
  PlaySessionId: 'configured-session', CurrentRuntimeTicks: 0n, ActualSegmentLengthTicks: 60000000n };
const errorValue = error => ({ message: error?.message, code: error?.code, status: error?.status, statusCode: error?.statusCode,
  path: error?.path, syscall: error?.syscall,
  cause: error?.cause === undefined ? undefined : errorValue(error.cause),
  errors: error?.errors === undefined ? undefined : error.errors.map(errorValue) });
const diagnosticJson = (_key, value) => value instanceof Error
  ? { name: value.name, ...Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]])) } : value;
async function output(prefix) {
  const directory = path.join(validationOutputRoot(), prefix + '-' + randomUUID()); await mkdir(directory, { recursive: true }); return directory;
}
async function eventually(operation) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await delay(10); }
  assert.fail('The accepted HLS operation did not reach its observable file or reader boundary.');
}
async function ownedFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mediamanager-hls-')) continue;
    for (const name of await readdir(path.join(root, entry.name))) files.push(path.join(root, entry.name, name));
  }
  return files;
}
async function firstSegment(root) { return (await ownedFiles(root)).find(filename => path.basename(filename) === 'segment0.ts'); }
async function closeServer(server) {
  if (!server) return; server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('HLS fixes the accepted job root across awaits, switches new jobs and keeps an old HTTP reader and URL usable', { timeout: 30000 }, async t => {
  const directory = await output('hls-configured-roots'), rootA = path.join(directory, 'A'), rootB = path.join(directory, 'B');
  for (const root of [rootA, rootB]) { await mkdir(root); await writeFile(path.join(root, 'keep.txt'), Buffer.from('unrelated ' + path.basename(root))); }
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') });
  const selected = Promise.withResolvers(), continuePath = Promise.withResolvers(), diagnostics = [];
  let currentRoot = rootA, firstPath = true, heldResponse, heldFinished = false, server;
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions: () => defaultConfiguration('encoding'), getCacheDirectory: async () => {
    const root = currentRoot;
    if (firstPath) { firstPath = false; selected.resolve(); await continuePath.promise; }
    await mkdir(root, { recursive: true }); return root;
  }, onError: error => diagnostics.push(error) });
  const requests = [];
  t.after(async () => {
    continuePath.resolve(); heldResponse?.destroy();
    try { await hls.close(); } finally { try { await closeServer(server); } finally { await fixture.close(); } }
  });
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const held = url.searchParams.has('hold') && !heldResponse;
    if (held) { heldResponse = response; response.cork(); }
    const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try { await hls.segment(reference.source, '/source.mkv', segmentOptions, 0, request, response, { signal: controller.signal }); }
    catch (error) { diagnostics.push(error); if (!response.headersSent) { response.statusCode = 503; response.end(); } else response.destroy(); }
    finally {
      request.removeListener('aborted', abort); response.removeListener('close', abort);
      requests.push({ url: request.url, completed: response.writableFinished }); if (held) heldFinished = true;
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { 'User-Agent': 'configured-root-reader' };
  const oldUrl = origin + '/segment0.ts?hold=1';
  const oldRead = fetch(oldUrl, { headers }).then(async response => ({ status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }));
  oldRead.catch(() => {});
  await selected.promise; currentRoot = rootB; continuePath.resolve();
  await eventually(() => heldResponse?.writableNeedDrain);
  const fileA = await eventually(() => firstSegment(rootA)), bytesA = await readFile(fileA);
  assert.equal(bytesA.length, reference.records.find(value => value.name === 'ts').segments[0].size);
  const next = await fetch(origin + '/segment0.ts', { headers }), bytesB = Buffer.from(await next.arrayBuffer());
  assert.equal(next.status, 200); assert.deepEqual(bytesB, bytesA);
  const fileB = await eventually(() => firstSegment(rootB)); assert.deepEqual(await readFile(fileB), bytesB);
  assert.equal(path.dirname(path.dirname(fileA)), rootA); assert.equal(path.dirname(path.dirname(fileB)), rootB);
  assert.equal(heldFinished, false); assert.deepEqual(await readFile(fileA), bytesA);
  heldResponse.uncork(); const old = await oldRead; assert.equal(old.status, 200); assert.deepEqual(old.bytes, bytesA);
  const reusedUrl = await fetch(oldUrl, { headers }); assert.equal(reusedUrl.status, 200);
  assert.deepEqual(Buffer.from(await reusedUrl.arrayBuffer()), bytesA);
  await hls.stop('configured-device', 'configured-session');
  assert.deepEqual(await ownedFiles(rootA), []); assert.deepEqual(await ownedFiles(rootB), []);
  await Promise.all([hls.close(), hls.close()]);
  assert.deepEqual(await readdir(rootA), ['keep.txt']); assert.deepEqual(await readdir(rootB), ['keep.txt']);
  for (const root of [rootA, rootB]) assert.equal((await readFile(path.join(root, 'keep.txt'))).toString(), 'unrelated ' + path.basename(root));
  assert.ok(requests.every(request => request.completed));
  t.diagnostic(inspect({ diagnostics }, { depth: null }));
});

test('HLS close waits for an accepted current-path callback and prevents a late job after that callback creates its root', { timeout: 30000 }, async t => {
  const directory = await output('hls-path-admission'), root = path.join(directory, 'selected-root');
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') }), entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  let server, acceptedError;
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions: () => defaultConfiguration('encoding'), getCacheDirectory: async () => {
    entered.resolve(); await proceed.promise; await mkdir(root); return root;
  } });
  t.after(async () => {
    proceed.resolve(); try { await hls.close(); }
    finally { try { await closeServer(server); } finally { await fixture.close(); } }
  });
  server = http.createServer(async (request, response) => {
    try { await hls.segment(reference.source, '/source.mkv', segmentOptions, 0, request, response); }
    catch (error) { acceptedError = error; response.statusCode = 503; response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const accepted = fetch(`http://127.0.0.1:${server.address().port}/segment0.ts`).then(async response => {
    await response.arrayBuffer(); return response.status;
  }); accepted.catch(() => {});
  await entered.promise;
  const first = hls.close(), second = hls.close(); let completed = false;
  Promise.all([first, second]).then(() => { completed = true; }, () => { completed = true; });
  await immediate(); assert.equal(completed, false, 'Both close calls still await the accepted directory operation.');
  await assert.rejects(hls.initialize(), { code: 'closed' });
  proceed.resolve(); assert.equal(await accepted, 503); await Promise.all([first, second]); assert.equal(acceptedError?.code, 'cancelled');
  assert.equal((await stat(root)).isDirectory(), true); assert.deepEqual(await readdir(root), []);
});

test('an actual current-path mkdir failure is preserved by HLS initialize and final close', async t => {
  const directory = await output('hls-path-error'), root = path.join(directory, 'file-root'); await writeFile(root, 'original file bytes');
  const fixture = await extractionFixture({}); let initializationFailure, closingFailure;
  const hls = new HlsService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions: () => defaultConfiguration('encoding'), getCacheDirectory: async () => {
    await mkdir(root, { recursive: true }); return root;
  } });
  t.after(async () => {
    try { await assert.rejects(hls.close(), error => { closingFailure = error; assert.deepEqual(errorValue(error), errorValue(initializationFailure)); return true; }); }
    finally {
      try { await writeFile(path.join(directory, 'failures.json'), JSON.stringify({ initializationFailure, closingFailure }, diagnosticJson, 2) + '\n'); }
      finally { await fixture.close(); }
    }
  });
  await assert.rejects(hls.initialize(), error => { initializationFailure = error; assert.ok(error.code); assert.equal(error.path, root); return true; });
  await assert.rejects(hls.close(), error => { closingFailure = error; assert.deepEqual(errorValue(error), errorValue(initializationFailure)); return true; });
  assert.equal((await readFile(root)).toString(), 'original file bytes');
});

test('a real HLS lease release followed by a reported failure still removes its own output and preserves the complete failure', { timeout: 30000 }, async t => {
  const directory = await output('hls-release-error'), root = path.join(directory, 'A'); await mkdir(root); await writeFile(path.join(root, 'keep.txt'), 'original');
  const fixture = await extractionFixture({ '/source.mkv': Buffer.from(reference.media, 'base64') }), bridge = new ProbeReadBridge(fixture.vfs);
  const originalLease = bridge.lease.bind(bridge), released = Promise.withResolvers();
  const cause = Object.assign(new Error('Controlled release failure cause.'), { code: 'fixture-hls-release-cause' });
  const failure = Object.assign(new Error('Controlled failure after the real HLS source lease released.', { cause }), { code: 'fixture-hls-release' });
  let leaseUrl, server, closingFailure;
  bridge.lease = async (...args) => {
    const lease = await originalLease(...args); leaseUrl = lease.url;
    return { ...lease, async release() { await lease.release(); released.resolve(); throw failure; } };
  };
  const diagnostics = [], hls = new HlsService({ vfs: fixture.vfs, bridge, mediaEncoder: await createTestMediaEncoder(t), getCacheDirectory: async () => root,
    getEncodingOptions: () => defaultConfiguration('encoding'), onError: error => diagnostics.push(error) });
  const checkFailure = error => { closingFailure = error; assert.deepEqual(errorValue(error), errorValue(failure)); return true; };
  t.after(async () => {
    try { await assert.rejects(hls.close(), checkFailure); }
    finally {
      try { await writeFile(path.join(directory, 'failures.json'), JSON.stringify({ configuredFailure: failure, closingFailure, diagnostics }, diagnosticJson, 2) + '\n'); }
      finally { try { await closeServer(server); } finally { try { await bridge.close(); } finally { await fixture.close(); } } }
    }
  });
  server = http.createServer(async (request, response) => {
    try { await hls.segment(reference.source, '/source.mkv', segmentOptions, 0, request, response); }
    catch (error) { diagnostics.push(error); if (!response.headersSent) { response.statusCode = 503; response.end(); } else response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/segment0.ts`), bytes = Buffer.from(await response.arrayBuffer());
  if (response.status === 200) assert.equal(bytes.length, reference.records.find(value => value.name === 'ts').segments[0].size);
  else assert.equal(response.status, 503);
  await released.promise;
  const originalOutput = await eventually(() => firstSegment(root));
  assert.equal((await readFile(originalOutput)).length, reference.records.find(value => value.name === 'ts').segments[0].size);
  const revoked = await fetch(leaseUrl); assert.equal(revoked.status, 404); await revoked.arrayBuffer();
  await assert.rejects(hls.close(), checkFailure);
  assert.deepEqual(await readdir(root), ['keep.txt']); assert.equal((await readFile(path.join(root, 'keep.txt'))).toString(), 'original');
});
