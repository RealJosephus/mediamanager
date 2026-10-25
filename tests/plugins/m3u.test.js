import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { md5Guid } from '../../src/core/identity.js';
import { NativeHttpInput, NativeHttpStream } from '../../packages/plugin-sdk/live-tv/raw-input.js';
import { LiveTvTunerService } from '../../src/library/live-tv-tuner-service.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const defaults = values => ({ Id: 'official-m3u', Type: 'm3u', Url: '', UserAgent: 'ControlledM3U/1.0',
  TunerCount: 0, AllowStreamSharing: true, EnableStreamLooping: false, AllowHWTranscoding: true,
  IgnoreDts: true, ReadAtNativeFramerate: false, AllowFmp4TranscodingContainer: false,
  FallbackMaxStreamingBitrate: 30000000, ...values });
const playlist = urls => '#EXTM3U\n' + urls.map((url, index) => '#EXTINF:-1 tvg-id="guide-' + index + '",Channel ' + index + '\n' + url + '\n').join('');

async function fixture(t, { options = {}, preinstalled = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm3u-plugin-'));
  let host, storage;
  t.after(async () => { try { await host?.close(); } finally { try { await storage?.close(); } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.match(path.basename(resolved), /^m3u-plugin-/u);
    await rm(resolved, { recursive: true, force: true });
  } } });
  let official = false;
  if (preinstalled) {
    official = path.join(root, 'official'); await mkdir(official);
    await cp(path.resolve('plugins/m3u'), path.join(official, 'm3u'), { recursive: true });
  }
  const diagnostics = [], cachePath = path.join(root, 'cache');
  let currentCachePath = cachePath;
  host = await PluginHost.open({ directory: path.join(root, 'host'), get cachePath() { return currentCachePath; }, preinstalled: official,
    options: { m3u: options }, onError: error => diagnostics.push(error.message) });
  await host.install(path.resolve('plugins/local'));
  if (!preinstalled) await host.install(path.resolve('plugins/m3u'));
  storage = await createConfiguredStorage(undefined, { plugins: host });
  await storage.configure({ instances: [{ id: 'controlled', type: 'local', config: { root, writable: true } }],
    mounts: [{ path: '/controlled', instanceId: 'controlled', root: '/', capabilities: { create: true, replace: true,
      mkdir: true, delete: true, rename: true, atomicReplace: true } }],
    prefixes: [{ identityRoot: root, accessRoot: '/controlled', style: process.platform === 'win32' ? 'windows' : 'posix',
      caseSensitive: process.platform !== 'win32', purpose: 'library', returnAccess: 'The isolated tuner reads mapped input and cache files.' }] });
  let configuration = { TunerHosts: [] }, accepting = true, admissions = 0, released = 0;
  const liveTv = { admitRead() {
    if (!accepting) throw Object.assign(new Error('Configuration is closing.'), { status: 503 });
    admissions++; let done = false;
    return { async getConfiguration() { return structuredClone(configuration); }, release() { if (!done) { done = true; released++; } } };
  } };
  return { root, host, storage, cachePath, diagnostics, get tuner() { return host.entries('tuner')[0]; },
    setCachePath(value) { currentCachePath = value; },
    configure(hosts) { configuration = { TunerHosts: hosts }; }, rejectAdmissions() { accepting = false; },
    counters: () => ({ admissions, released }), connect: () => host.connect({ liveTv, fileSystem: storage.fileSystem,
      users: { isLocalNetwork: address => address === '127.0.0.1' || address === '::1' } }) };
}

async function server(t, handler) {
  const value = createServer(handler);
  await new Promise((resolve, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); });
  return 'http://127.0.0.1:' + value.address().port;
}
async function selected(fixture, index = 0) {
  const channel = (await fixture.tuner.getChannels(false, {}))[index];
  return { channel, source: (await fixture.tuner.getChannelStreamMediaSources(channel.Id, {}))[0] };
}
const open = (fixture, chosen, signal, current = []) => fixture.tuner.getChannelStream(chosen.channel.Id, chosen.source.mediaSource.Id, current, { source: chosen.source, signal });

test('installed and official M3U activate before connect, then read admitted shared configuration through mapped storage', { timeout: 30000 }, async t => {
  for (const preinstalled of [false, true]) {
    const value = await fixture(t, { preinstalled });
    assert.equal(value.host.get('m3u').status, 'active'); assert.equal(value.tuner.type, 'm3u'); assert.equal(value.tuner.name, 'M3U Tuner');
    assert.throws(() => value.tuner.getChannels(false, {}), { status: 503 }); assert.deepEqual(value.counters(), { admissions: 0, released: 0 });
    const filename = path.join(value.root, 'playlist.m3u'), first = 'rtsp://203.0.113.9/first', second = 'udp://@239.1.2.3:1234';
    await writeFile(filename, playlist([first])); value.configure([defaults({ Url: filename })]); await value.connect();
    const initial = await value.tuner.getChannels(false, {});
    assert.equal(initial[0].Id, 'm3u_' + md5Guid(filename) + md5Guid(first));
    assert.equal(initial[0].TunerChannelId, 'guide-0'); assert.equal(initial[0].Path, first);
    assert.deepEqual(await value.tuner.discoverDevices(100, {}), []);
    await value.tuner.validate(defaults({ Url: filename }), {});
    // The live in-memory configuration is authoritative even when its source file was not replaced.
    const next = path.join(value.root, 'next.m3u'); await writeFile(next, playlist([second])); value.configure([defaults({ Id: 'replacement', Url: next })]);
    assert.equal((await value.tuner.getChannels(false, {}))[0].Path, second);
    await assert.rejects(value.host.configure('m3u', { Url: filename }), /shared Live TV configuration/);
    assert.equal(value.host.get('m3u').status, 'active');
    value.configure([defaults({ Id: '../outside-owned-cache', Url: next })]);
    await assert.rejects(value.tuner.getChannels(false, {}), /single file-name component/);
    value.rejectAdmissions(); assert.throws(() => value.tuner.getChannels(false, {}), { status: 503 });
    assert.equal(value.counters().admissions, value.counters().released);
  }
});

test('M3U follows cache path updates between requests and keeps an admitted cache write on its original path', { timeout: 30000 }, async t => {
  for (const preinstalled of [false, true]) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const bytes = playlist(['rtsp://203.0.113.9/current']);
    let requests = 0, explicitCachePath;
    const value = await fixture(t, { preinstalled, options: {
      get cachePath() { return explicitCachePath; },
      async fetch() { if (++requests === 1) { entered.resolve(); await release.promise; } return new Response(bytes); },
    } });
    value.configure([defaults({ Url: 'http://controlled.invalid/playlist' })]); await value.connect();
    const pending = value.tuner.getChannels(false, {});
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('The source completed before its held response.'); })]);
      const nextCachePath = path.join(value.root, 'next-cache'); value.setCachePath(nextCachePath);
      release.resolve();
      const first = await pending;
      const filename = 'official-m3u_channels', original = await readFile(path.join(value.cachePath, filename));
      assert.equal(first[0].Path, 'rtsp://203.0.113.9/current');
      await assert.rejects(readFile(path.join(nextCachePath, filename)), { code: 'ENOENT' });
      assert.deepEqual(await value.tuner.getChannels(false, {}), first);
      assert.deepEqual(await readFile(path.join(nextCachePath, filename)), original);
      explicitCachePath = path.join(value.root, 'explicit-cache');
      const unusedCachePath = path.join(value.root, 'later-server-cache'); value.setCachePath(unusedCachePath);
      assert.deepEqual(await value.tuner.getChannels(false, {}), first);
      assert.deepEqual(await readFile(path.join(explicitCachePath, filename)), original);
      await assert.rejects(readFile(path.join(unusedCachePath, filename)), { code: 'ENOENT' });
      assert.deepEqual(await readFile(path.join(value.cachePath, filename)), original);
      assert.deepEqual(await readdir(path.join(value.root, 'host', 'cache', 'm3u')), []);
      assert.equal(value.counters().admissions, value.counters().released);
    } finally { release.resolve(); await Promise.allSettled([pending]); }
  }
});

test('a paused raw-byte consumer bounds upstream advancement and closing it releases backpressure', { timeout: 30000 }, async () => {
  let pulled = 0, canceled = 0, closed = 0;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from([++pulled])); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const input = new NativeHttpStream({ body }, () => { closed++; });
  try {
    const first = input.lease(() => {}), paused = input.lease(() => {});
    assert.equal((await first.stream.next()).value[0], 1);
    const pending = first.stream.next(); await turn(); assert.equal(pulled, 1, 'A slow owner must prevent unbounded input buffering.');
    assert.equal((await paused.stream.next()).value[0], 1); assert.equal((await pending).value[0], 2);
    const resumed = first.stream.next(); await turn(); assert.equal(pulled, 2);
    await paused.close(); assert.equal((await resumed).value[0], 3);
    const blocked = first.stream.next(); await first.close(); assert.equal((await blocked).done, true);
    assert.equal(canceled, 0); assert.equal(closed, 0, 'Byte readers do not own the upstream lifetime.');
    await input.close();
    assert.equal(canceled, 1); assert.equal(closed, 1);
  } finally { await input.close(); }
});

test('real HTTP original bytes share one bounded input, preserve configured headers, and release each owner independently', { timeout: 30000 }, async t => {
  const requests = [], closed = Promise.withResolvers(); let live;
  const origin = await server(t, (request, response) => {
    requests.push({ path: request.url, method: request.method, userAgent: request.headers['user-agent'] });
    if (request.url === '/playlist') { response.end(playlist([origin + '/live.ts'])); return; }
    response.writeHead(200, { 'Content-Type': 'video/MP2T' }); response.write(Buffer.from([0, 255, 71, 0])); live = response;
    response.once('close', () => closed.resolve());
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist', TunerCount: 1 })]); await value.connect();
  const chosen = await selected(value), first = await open(value, chosen), second = await first.sharing.retain({});
  assert.equal(first.sharing.enabled, true); assert.equal(second.sharing.enabled, true);
  assert.equal(chosen.source.mode, 'native'); assert.equal(chosen.source.mediaSource.SupportsTranscoding, true);
  assert.equal(chosen.source.mediaSource.RequiredHttpHeaders['User-Agent'], 'ControlledM3U/1.0');
  const beforeCache = await readFile(path.join(value.cachePath, 'official-m3u_channels'));
  const firstRead = first.stream.next(), secondRead = second.stream.next();
  const [left, right] = await Promise.all([firstRead, secondRead]);
  assert.deepEqual(left.value, Buffer.from([0, 255, 71, 0])); assert.deepEqual(right.value, left.value);
  left.value[0] = 99; assert.equal(right.value[0], 0, 'Consumers own independent chunk memory.');
  await first.close(); await assert.rejects(first.stream.next(), { status: 503 });
  const pending = second.stream.next(); live.write(Buffer.from('still original')); assert.equal((await pending).value.toString(), 'still original');
  assert.equal(requests.filter(request => request.path === '/live.ts').length, 1);
  assert.ok(requests.every(request => request.userAgent === 'ControlledM3U/1.0'));
  const blocked = second.stream.next(), rejected = assert.rejects(blocked, error => error.status === 503 || error.name === 'AbortError');
  await value.host.setEnabled('m3u', false); await rejected; await closed.promise;
  assert.equal(first.sharing.enabled, false); assert.throws(() => first.sharing.retain({}), { status: 503 });
  assert.deepEqual(await readdir(value.cachePath), ['official-m3u_channels']);
  assert.deepEqual(await readFile(path.join(value.cachePath, 'official-m3u_channels')), beforeCache);
  assert.equal(value.counters().admissions, value.counters().released);
});

test('caller cancellation drains its pending raw reads while another shared consumer continues', { timeout: 30000 }, async t => {
  let live; const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') { response.end(playlist([origin + '/live.ts'])); return; }
    response.writeHead(200); response.write('initial'); live = response;
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const chosen = await selected(value), request = new AbortController();
  const first = await open(value, chosen, request.signal), second = await first.sharing.retain({});
  assert.equal((await first.stream.next()).value.toString(), 'initial'); assert.equal((await second.stream.next()).value.toString(), 'initial');
  const pending = first.stream.next(), rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.status === 503);
  request.abort(); await rejected; assert.equal(value.host.get('m3u').status, 'active');
  assert.equal(first.sharing.enabled, true);
  const read = second.stream.next(); await turn();
  const third = await first.sharing.retain({});
  const thirdRead = third.stream.next(); live.write(Buffer.from('unmodified')); assert.equal((await read).value.toString(), 'unmodified');
  assert.equal((await thirdRead).value.toString(), 'unmodified');
  await second.close(); assert.equal(first.sharing.enabled, true); await third.close(); assert.equal(first.sharing.enabled, false);
  assert.equal(value.counters().admissions, value.counters().released);
});

test('fresh native HTTP opens stay distinct while manifests looping and unshared HTTP only reserve source descriptors', { timeout: 30000 }, async t => {
  const requests = []; const live = [];
  const origin = await server(t, (request, response) => {
    requests.push({ method: request.method, path: request.url, userAgent: request.headers['user-agent'] });
    if (request.url === '/playlist') { response.end(playlist([origin + '/stream', origin + '/manifest.m3u8?opaque=1'])); return; }
    response.writeHead(200, { 'Content-Type': 'video/MP2T' });
    if (request.method === 'HEAD') response.end(); else { response.write('initial'); live.push(response); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const chosen = await selected(value), first = await open(value, chosen), second = await open(value, chosen), child = await first.sharing.retain({});
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 2);
  assert.notEqual(requests.find(request => request.method === 'HEAD').userAgent, 'ControlledM3U/1.0');
  assert.equal(requests.filter(request => request.path === '/stream' && request.method === 'GET').length, 2);
  await first.close(); assert.equal(child.sharing.enabled, true);
  await child.close(); assert.equal(first.sharing.enabled, false); assert.equal(second.sharing.enabled, true);
  await second.close(); assert.equal(second.sharing.enabled, false);
  const manifest = await selected(value, 1); assert.equal(manifest.source.mediaSource.SupportsDirectPlay, false);
  const manifestLease = await open(value, manifest), manifestRetained = await manifestLease.sharing.retain({});
  assert.equal(live.length, 2);
  assert.equal(manifestLease.stream, undefined); assert.equal(manifestRetained.stream, undefined);
  assert.equal(requests.filter(request => request.path?.startsWith('/manifest')).length, 0);
  await manifestLease.close(); assert.equal(manifestRetained.sharing.enabled, true);
  await manifestRetained.close(); assert.equal(manifestLease.sharing.enabled, false);
  value.configure([defaults({ Id: 'loop', Url: origin + '/playlist', EnableStreamLooping: true })]);
  const looping = await selected(value); assert.equal(looping.source.mediaSource.RequiresLooping, true);
  assert.equal(looping.source.mediaSource.SupportsDirectStream, false);
  const a = await open(value, looping), b = await open(value, looping), retained = await a.sharing.retain({});
  assert.equal(a.stream, undefined); assert.equal(b.stream, undefined); assert.equal(retained.stream, undefined);
  assert.equal(live.length, 2, 'Fresh looping opens own reservations without executing a loop or opening network bytes.');
  await a.close(); assert.equal(retained.sharing.enabled, true);
  await retained.close(); assert.equal(a.sharing.enabled, false); assert.equal(b.sharing.enabled, true);
  await b.close(); assert.equal(b.sharing.enabled, false);
  value.configure([defaults({ Id: 'unshared-transport', Url: origin + '/playlist', AllowStreamSharing: false })]);
  const plain = await selected(value), x = await open(value, plain), y = await open(value, plain), z = await x.sharing.retain({});
  assert.equal(x.stream, undefined); assert.equal(y.stream, undefined); assert.equal(z.stream, undefined);
  assert.equal(live.length, 2, 'AllowStreamSharing controls native HTTP transport selection, while descriptors remain retainable.');
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 2);
  await x.close(); assert.equal(z.sharing.enabled, true);
  await z.close(); assert.equal(x.sharing.enabled, false); assert.equal(y.sharing.enabled, true);
  await y.close(); assert.equal(y.sharing.enabled, false);
});

test('RTSP RTP and UDP acquire closeable tuner reservations without opening or pretending to read network bytes', { timeout: 30000 }, async t => {
  let fetches = 0; const value = await fixture(t, { options: { fetch: async () => { fetches++; throw new Error('No HTTP source is configured.'); } } });
  const filename = path.join(value.root, 'reservation.m3u');
  await writeFile(filename, playlist(['rtsp://203.0.113.5/live', 'rtp://239.1.2.3:1234', 'udp://@239.1.2.3:1234']));
  value.configure([defaults({ Url: filename, TunerCount: 1 })]); await value.connect();
  for (const index of [0, 1, 2]) {
    const chosen = await selected(value, index), lease = await value.tuner.getChannelStream(chosen.channel.Id,
      [null, '', 'unrelated-original'][index], [], { source: chosen.source }), child = await lease.sharing.retain({});
    assert.equal(lease.stream, undefined); assert.equal(lease.mode, 'native'); assert.equal(lease.mediaSource.Path, chosen.channel.Path);
    assert.equal(child.stream, undefined);
    const visible = [{ TunerHostId: lease.tunerHostId }];
    await assert.rejects(open(value, chosen, undefined, visible), { status: 409 }); await lease.close(); await lease.close();
    assert.equal(child.sharing.enabled, true); await assert.rejects(open(value, chosen, undefined, visible), { status: 409 });
    await child.close(); assert.equal(lease.sharing.enabled, false);
  }
  assert.equal(fetches, 0); await value.host.setEnabled('m3u', false); assert.deepEqual(value.host.entries('tuner'), []);
});

test('a late noncooperative HTTP response is closed before disable finishes and cannot escape the plugin', { timeout: 30000 }, async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(), upstreamAborted = Promise.withResolvers(); let canceled = 0;
  const location = 'http://127.0.0.1:1/late.ts';
  const value = await fixture(t, { options: { fetch: async (url, { signal }) => {
    if (url.endsWith('/playlist')) return new Response(playlist([location]));
    signal.addEventListener('abort', () => upstreamAborted.resolve(), { once: true });
    started.resolve(); return delayed.promise;
  } } });
  value.configure([defaults({ Url: 'http://127.0.0.1:1/playlist' })]); await value.connect();
  let lateResponse;
  const release = () => delayed.resolve(lateResponse ??= new Response(new ReadableStream({ cancel() { canceled++; } })));
  t.signal.addEventListener('abort', release, { once: true });
  try {
  const tuner = value.tuner, chosen = await selected(value), work = open(value, chosen), rejected = assert.rejects(work, error => error.status === 503 || error.name === 'AbortError');
  await started.promise; let disabled = false;
  const disabling = value.host.setEnabled('m3u', false).then(() => { disabled = true; }); await upstreamAborted.promise; await turn(); assert.equal(disabled, false);
  release();
  await rejected; await disabling; assert.equal(canceled, 1); assert.equal(value.counters().admissions, value.counters().released);
  assert.deepEqual(value.host.entries('tuner'), []); assert.throws(() => tuner.getChannels(false, {}), { status: 503 });
  } finally { release(); }
});

test('an original HTTP EOF revokes retention and drains every remaining consumer', { timeout: 30000 }, async t => {
  let gets = 0;
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') response.end(playlist([origin + '/finite.ts']));
    else { gets++; response.end(Buffer.from('finite original bytes')); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const chosen = await selected(value), first = await open(value, chosen), second = await first.sharing.retain({});
  const read = async lease => { const chunks = []; for await (const bytes of lease.stream) chunks.push(bytes); return Buffer.concat(chunks).toString(); };
  assert.deepEqual(await Promise.all([read(first), read(second)]), ['finite original bytes', 'finite original bytes']);
  assert.equal(gets, 1); assert.equal(first.sharing.enabled, false);
  await assert.rejects(first.sharing.retain({}), { status: 503 }); await Promise.all([first.close(), second.close()]);
});

test('an admitted consumer racing original EOF rejects and drains instead of leaving its acquisition pending', { timeout: 30000 }, async () => {
  let bodyController, closed = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const input = new NativeHttpInput(async () => new Response(new ReadableStream({ start(controller) { bodyController = controller; } })), () => { closed++; });
  try {
    const signal = new AbortController().signal, first = await input.acquire(signal), read = first.stream.next();
    // Suspend only acquisition delivery. The existing reader must observe an
    // actual upstream EOF before the newly admitted owner can be delivered.
    input.opening = input.opening.then(async hub => { entered.resolve(); await release.promise; return hub; });
    const racing = input.acquire(signal), rejected = assert.rejects(racing, /unavailable/);
    await entered.promise; bodyController.close(); assert.equal((await read).done, true);
    release.resolve(); await rejected; await first.close(); await input.close();
    assert.equal(input.enabled, false); assert.equal(closed, 1);
  } finally { release.resolve(); await input.close(); }
});

test('M3U SharedHttpStream waits for first bytes after headers and preserves a non-success response body', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(); let live, delivered = false;
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') { response.end(playlist([origin + '/first.ts'])); return; }
    response.writeHead(503, { 'Content-Type': 'video/mp2t' }); response.flushHeaders(); live = response; entered.resolve();
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect(); const chosen = await selected(value);
  const opening = open(value, chosen).then(lease => { delivered = true; return lease; }); await entered.promise; await turn(); assert.equal(delivered, false);
  live.write(Buffer.from([0, 255, 71])); const lease = await opening, retained = await lease.sharing.retain({});
  assert.deepEqual((await lease.stream.next()).value, Buffer.from([0, 255, 71])); assert.deepEqual((await retained.stream.next()).value, Buffer.from([0, 255, 71]));
  await Promise.all([lease.close(), retained.close()]); assert.equal(lease.sharing.enabled, false);
});

test('M3U zero-byte SharedHttpStream fails and disabling drains a pending first-byte read', { timeout: 30000 }, async t => {
  let mode = 'empty'; const entered = Promise.withResolvers(), closed = Promise.withResolvers();
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') { response.end(playlist([origin + '/first.ts'])); return; }
    if (mode === 'empty') { response.end(); return; }
    response.flushHeaders(); response.once('close', () => closed.resolve()); entered.resolve();
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect(); const chosen = await selected(value);
  await assert.rejects(open(value, chosen), { status: 409 }); mode = 'held';
  const pending = open(value, chosen), rejected = assert.rejects(pending, cause => cause.status === 503 || cause.name === 'AbortError');
  await entered.promise; await value.host.setEnabled('m3u', false); await rejected; await closed.promise;
  assert.equal(value.counters().admissions, value.counters().released);
});

test('a shared HTTP input retains its owner until pending first-read cancellation actually closes', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), cancelEntered = Promise.withResolvers(), release = Promise.withResolvers(); let closed = 0;
  const body = new ReadableStream({ pull() { entered.resolve(); }, async cancel() { cancelEntered.resolve(); await release.promise; } }, { highWaterMark: 0 });
  const input = new NativeHttpInput(async () => new Response(body), () => { closed++; }, { primeFirstBytes: true });
  const finish = () => release.resolve(); t.signal.addEventListener('abort', finish, { once: true });
  try {
    const pending = input.acquire(new AbortController().signal), rejected = assert.rejects(pending, cause => cause.name === 'AbortError');
    await entered.promise; let drained = false; const closing = input.close().then(() => { drained = true; });
    await cancelEntered.promise; await turn(); assert.equal(drained, false); assert.equal(closed, 0);
    finish(); await rejected; await closing; assert.equal(closed, 1); assert.equal(input.enabled, false);
  } finally { finish(); await input.close(); }
});

test('lazy byte consumers leave idle owners out of backpressure while active readers remain bounded', { timeout: 30000 }, async () => {
  let pulled = 0, canceled = 0, closed = 0;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from([++pulled])); }, cancel() { canceled++; } }, { highWaterMark: 0 });
  const input = new NativeHttpInput(async () => new Response(body), () => { closed++; }, { primeFirstBytes: true });
  try {
    const signal = new AbortController().signal, idle = await input.acquire(signal), first = await input.acquire(signal), paused = await input.acquire(signal);
    assert.equal(pulled, 1, 'Opening and retaining only reserve resource ownership without consuming further bytes.');
    assert.equal((await first.stream.next()).value[0], 1); assert.equal((await paused.stream.next()).value[0], 1);
    assert.equal((await first.stream.next()).value[0], 2);
    const pending = first.stream.next(); await turn(); assert.equal(pulled, 2, 'A reader which has started and paused still applies backpressure.');
    await paused.close(); assert.equal((await pending).value[0], 3);
    await first.close(); assert.equal(input.enabled, true); assert.equal(canceled, 0); assert.equal(closed, 0);
    assert.equal((await idle.stream.next()).value[0], 4, 'An idle owner can start reading after the preceding reader closes.');
    await idle.close(); assert.equal(canceled, 1); assert.equal(closed, 1);
  } finally { await input.close(); }
});

test('a byte request completing after its reader closes keeps only that chunk for a still-owned input', { timeout: 30000 }, async () => {
  let controller, canceled = 0;
  const input = new NativeHttpInput(async () => new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { canceled++; } }, { highWaterMark: 0 })), () => {});
  try {
    const signal = new AbortController().signal, idle = await input.acquire(signal), active = await input.acquire(signal);
    const pending = active.stream.next(); await turn(); await active.close(); assert.equal((await pending).done, true); assert.equal(canceled, 0);
    controller.enqueue(Buffer.from('one in-flight chunk')); await turn();
    assert.equal((await idle.stream.next()).value.toString(), 'one in-flight chunk'); await idle.close(); assert.equal(canceled, 1);
  } finally { await input.close(); }
});

test('one upstream byte error rejects active readers and a later idle read and drains all owners', { timeout: 30000 }, async () => {
  let controller, closed = 0;
  const failure = Object.assign(new Error('Controlled original byte failure'), { code: 'controlled-upstream-byte-error' });
  const input = new NativeHttpInput(async () => new Response(new ReadableStream({ start(value) { controller = value; } }, { highWaterMark: 0 })), () => { closed++; });
  try {
    const signal = new AbortController().signal, idle = await input.acquire(signal), first = await input.acquire(signal), second = await input.acquire(signal);
    const expected = { code: failure.code, message: failure.message };
    const left = assert.rejects(first.stream.next(), expected), right = assert.rejects(second.stream.next(), expected);
    controller.error(failure); await Promise.all([left, right]); assert.equal(input.enabled, false); assert.equal(closed, 0);
    await assert.rejects(idle.stream.next(), expected); assert.equal(closed, 1);
  } finally { await input.close(); }
});

test('an unread official M3U owner neither blocks real HTTP readers nor closes their upstream', { timeout: 30000 }, async t => {
  const disconnected = Promise.withResolvers(); let live, gets = 0;
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') { response.end(playlist([origin + '/lazy.ts'])); return; }
    gets++; response.write('first'); live = response; response.once('close', () => disconnected.resolve());
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect(); const chosen = await selected(value);
  const owner = await open(value, chosen), reader = await owner.sharing.retain({});
  assert.equal(owner.tunerHostId, 'official-m3u'); assert.equal(reader.tunerHostId, owner.tunerHostId);
  assert.equal((await reader.stream.next()).value.toString(), 'first'); const second = reader.stream.next(); live.write('second'); assert.equal((await second).value.toString(), 'second');
  await reader.close(); assert.equal(owner.sharing.enabled, true);
  const later = await owner.sharing.retain({}), third = later.stream.next(); live.write('third'); assert.equal((await third).value.toString(), 'third');
  await owner.close(); assert.equal(later.sharing.enabled, true); await later.close(); await disconnected.promise; assert.equal(gets, 1);
});

test('a finite real HTTP reader reaches EOF while an unread owner remains and then releases that reservation', { timeout: 30000 }, async t => {
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') response.end(playlist([origin + '/finite.ts'])); else response.end('finite original bytes');
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect(); const owner = await open(value, await selected(value));
  const reader = await owner.sharing.retain({}), chunks = []; for await (const bytes of reader.stream) chunks.push(bytes);
  assert.equal(Buffer.concat(chunks).toString(), 'finite original bytes'); assert.equal(owner.sharing.enabled, false);
  assert.equal((await owner.stream.next()).done, true); await owner.close(); await reader.close();
  assert.equal(value.counters().admissions, value.counters().released);
});

for (const phase of ['unread', 'first-chunk', 'pending-read']) test(`real HTTP raw owner cancellation at ${phase} leaves another owner able to read`, { timeout: 30000 }, async t => {
  let response; const disconnected = Promise.withResolvers();
  const origin = await server(t, (_request, value) => { response = value; value.write('initial'); value.once('close', () => disconnected.resolve()); });
  const input = new NativeHttpInput(signal => fetch(origin, { signal }), () => {}, { primeFirstBytes: true });
  try {
    const request = new AbortController(), first = await input.acquire(request.signal), other = await input.acquire(new AbortController().signal);
    if (phase !== 'unread') assert.equal((await first.stream.next()).value.toString(), 'initial');
    // This is the SDK byte boundary itself: next enters reader.read before it
    // returns its promise, unlike a host call which may still be queued.
    const pending = phase === 'pending-read' ? first.stream.next() : null;
    request.abort(); await first.close(); if (pending) assert.equal((await pending).done, true);
    assert.equal(input.enabled, true);
    if (phase !== 'pending-read') assert.equal((await other.stream.next()).value.toString(), 'initial');
    const reading = other.stream.next(); response.write('unmodified'); assert.equal((await reading).value.toString(), 'unmodified');
    await other.close(); await disconnected.promise; assert.equal(input.enabled, false);
  } finally { await input.close(); }
});

test('an official M3U owner canceled before its first next leaves a retained real HTTP reader usable', { timeout: 30000 }, async t => {
  let live;
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') response.end(playlist([origin + '/lazy.ts'])); else { live = response; response.write('initial'); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const request = new AbortController(), first = await open(value, await selected(value), request.signal), other = await first.sharing.retain({});
  request.abort(); await first.close(); assert.equal(other.sharing.enabled, true);
  assert.equal((await other.stream.next()).value.toString(), 'initial');
  const reading = other.stream.next(); live.write('unmodified'); assert.equal((await reading).value.toString(), 'unmodified'); await other.close();
});

for (const tunerHostId of ['official-m3u', null]) test(`official M3U capacity uses its actual ${tunerHostId === null ? 'null' : 'string'} host identity through the default consumer`, { timeout: 30000 }, async t => {
  let gets = 0, upstream;
  const origin = await server(t, (request, response) => {
    if (request.url === '/playlist') response.end(playlist([origin + '/capacity.ts'])); else { gets++; upstream = response; response.write('initial'); }
  });
  const value = await fixture(t); value.configure([defaults({ Id: tunerHostId, Url: origin + '/playlist', TunerCount: 1 })]); await value.connect(); const chosen = await selected(value);
  const service = new LiveTvTunerService({ plugins: value.host, sources: { async addProviderMetadata() {}, async getPrograms() { return []; } } }); t.after(() => service.close());
  const options = { source: chosen.source, currentLiveStreams: [] }, first = await service.getChannelStream(chosen.channel.Id, null, options), child = await first.sharing.retain({});
  options.currentLiveStreams = [first, child];
  assert.equal(first.tunerHostId, tunerHostId); assert.equal(child.tunerHostId, tunerHostId);
  assert.equal(service.getLiveStreams()[0].TunerHostId, tunerHostId); assert.equal(service.getLiveStreams()[0].ConsumerCount, 2);
  assert.equal((await child.stream.next()).value.toString(), 'initial');
  const bytes = child.stream.next(); upstream.write('retained bytes'); assert.equal((await bytes).value.toString(), 'retained bytes');
  await assert.rejects(service.getChannelStream(chosen.channel.Id, '', options), { status: 409 }); assert.equal(gets, 1);
  await first.close(); options.currentLiveStreams = [child]; await assert.rejects(service.getChannelStream(chosen.channel.Id, null, options), { status: 409 });
  await child.close(); options.currentLiveStreams = []; assert.deepEqual(service.getLiveStreams(), []);
  const replacement = await service.getChannelStream(chosen.channel.Id, null, options); assert.equal(gets, 2); assert.equal(replacement.tunerHostId, tunerHostId); await replacement.close();
});
