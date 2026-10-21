import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { md5Guid } from '../../src/core/identity.js';
import { NativeHttpInput, NativeHttpStream } from '../../plugins/m3u/http-stream.js';

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
  host = await PluginHost.open({ directory: path.join(root, 'host'), cachePath, preinstalled: official,
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
const open = (fixture, chosen, signal) => fixture.tuner.getChannelStream(chosen.channel.Id, chosen.source.mediaSource.Id, [], { source: chosen.source, signal });

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
    assert.equal(canceled, 1); assert.equal(closed, 1);
  } finally { await input.close(); }
});

test('real HTTP original bytes share one bounded input, preserve configured headers, and release each owner independently', { timeout: 30000 }, async t => {
  const requests = [], closed = Promise.withResolvers(); let live;
  const origin = await server(t, (request, response) => {
    requests.push({ path: request.url, method: request.method, userAgent: request.headers['user-agent'] });
    if (request.url === '/playlist') { response.end(playlist([origin + '/live.ts'])); return; }
    response.writeHead(200, { 'Content-Type': 'video/MP2T' }); response.flushHeaders(); live = response;
    response.once('close', () => closed.resolve());
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist', TunerCount: 1 })]); await value.connect();
  const chosen = await selected(value), first = await open(value, chosen), second = await first.sharing.retain({});
  assert.equal(first.sharing, second.sharing); assert.equal(first.sharing.enabled, true);
  assert.equal(chosen.source.mode, 'native'); assert.equal(chosen.source.mediaSource.SupportsTranscoding, true);
  assert.equal(chosen.source.mediaSource.RequiredHttpHeaders['User-Agent'], 'ControlledM3U/1.0');
  const beforeCache = await readFile(path.join(value.cachePath, 'official-m3u_channels'));
  const firstRead = first.stream.next(), secondRead = second.stream.next(); live.write(Buffer.from([0, 255, 71, 0]));
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
    response.writeHead(200); response.flushHeaders(); live = response;
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const chosen = await selected(value), request = new AbortController();
  const first = await open(value, chosen, request.signal), second = await first.sharing.retain({});
  const pending = first.stream.next(), rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.status === 503);
  request.abort(); await rejected; assert.equal(value.host.get('m3u').status, 'active');
  assert.equal(first.sharing.enabled, true);
  const third = await first.sharing.retain({}); assert.equal(third.sharing, second.sharing);
  const read = second.stream.next(); live.write(Buffer.from('unmodified')); assert.equal((await read).value.toString(), 'unmodified');
  assert.equal((await third.stream.next()).value.toString(), 'unmodified');
  await second.close(); assert.equal(first.sharing.enabled, true); await third.close(); assert.equal(first.sharing.enabled, false);
  assert.equal(value.counters().admissions, value.counters().released);
});

test('HEAD sharing discovery carries no configured user agent, while looping and manifests remain raw source data', { timeout: 30000 }, async t => {
  const requests = []; const live = [];
  const origin = await server(t, (request, response) => {
    requests.push({ method: request.method, path: request.url, userAgent: request.headers['user-agent'] });
    if (request.url === '/playlist') { response.end(playlist([origin + '/stream', origin + '/manifest.m3u8?opaque=1'])); return; }
    response.writeHead(200, { 'Content-Type': 'video/MP2T' });
    if (request.method === 'HEAD') response.end(); else { response.flushHeaders(); live.push(response); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin + '/playlist' })]); await value.connect();
  const chosen = await selected(value), first = await open(value, chosen), second = await open(value, chosen);
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 1);
  assert.notEqual(requests.find(request => request.method === 'HEAD').userAgent, 'ControlledM3U/1.0');
  assert.equal(requests.filter(request => request.path === '/stream' && request.method === 'GET').length, 1);
  await Promise.all([first.close(), second.close()]);
  const manifest = await selected(value, 1); assert.equal(manifest.source.mediaSource.SupportsDirectPlay, false);
  const manifestLease = await open(value, manifest), manifestRetained = await manifestLease.sharing.retain({});
  assert.equal(manifestRetained.sharing, manifestLease.sharing); assert.equal(live.length, 2);
  await Promise.all([manifestLease.close(), manifestRetained.close()]);
  value.configure([defaults({ Id: 'loop', Url: origin + '/playlist', EnableStreamLooping: true })]);
  const looping = await selected(value); assert.equal(looping.source.mediaSource.RequiresLooping, true);
  assert.equal(looping.source.mediaSource.SupportsDirectStream, false);
  const a = await open(value, looping), b = await open(value, looping), retained = await a.sharing.retain({});
  assert.notEqual(a.sharing, b.sharing); assert.equal(retained.sharing, a.sharing);
  assert.equal(live.length, 4, 'Fresh looping opens use distinct raw inputs; retaining one original descriptor never executes a loop.');
  await Promise.all([a.close(), b.close(), retained.close()]);
  value.configure([defaults({ Id: 'unshared-transport', Url: origin + '/playlist', AllowStreamSharing: false })]);
  const plain = await selected(value), x = await open(value, plain), y = await open(value, plain), z = await x.sharing.retain({});
  assert.notEqual(x.sharing, y.sharing); assert.equal(z.sharing, x.sharing);
  assert.equal(live.length, 6, 'AllowStreamSharing controls fresh transport selection, while native descriptors remain retainable.');
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 1);
  await Promise.all([x.close(), y.close(), z.close()]);
});

test('RTSP RTP and UDP acquire closeable tuner reservations without opening or pretending to read network bytes', { timeout: 30000 }, async t => {
  let fetches = 0; const value = await fixture(t, { options: { fetch: async () => { fetches++; throw new Error('No HTTP source is configured.'); } } });
  const filename = path.join(value.root, 'reservation.m3u');
  await writeFile(filename, playlist(['rtsp://203.0.113.5/live', 'rtp://239.1.2.3:1234', 'udp://@239.1.2.3:1234']));
  value.configure([defaults({ Url: filename, TunerCount: 1 })]); await value.connect();
  for (const index of [0, 1, 2]) {
    const chosen = await selected(value, index), lease = await open(value, chosen), child = await lease.sharing.retain({});
    assert.equal(lease.stream, undefined); assert.equal(lease.mode, 'native'); assert.equal(lease.mediaSource.Path, chosen.channel.Path);
    assert.equal(child.stream, undefined); assert.equal(lease.sharing, child.sharing);
    await assert.rejects(open(value, chosen), { status: 409 }); await lease.close(); await lease.close();
    assert.equal(child.sharing.enabled, true); await assert.rejects(open(value, chosen), { status: 409 });
    await child.close(); assert.equal(lease.sharing.enabled, false);
  }
  assert.equal(fetches, 0); await value.host.setEnabled('m3u', false); assert.deepEqual(value.host.entries('tuner'), []);
});

test('a late noncooperative HTTP response is closed before disable finishes and cannot escape the plugin', { timeout: 30000 }, async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(); let canceled = 0;
  const location = 'http://127.0.0.1:1/late.ts';
  const value = await fixture(t, { options: { fetch: async url => {
    if (url.endsWith('/playlist')) return new Response(playlist([location]));
    started.resolve(); return delayed.promise;
  } } });
  value.configure([defaults({ Url: 'http://127.0.0.1:1/playlist' })]); await value.connect();
  let lateResponse;
  const release = () => delayed.resolve(lateResponse ??= new Response(new ReadableStream({ cancel() { canceled++; } })));
  t.signal.addEventListener('abort', release, { once: true });
  try {
  const tuner = value.tuner, chosen = await selected(value), work = open(value, chosen), rejected = assert.rejects(work, error => error.status === 503 || error.name === 'AbortError');
  await started.promise; let disabled = false;
  const disabling = value.host.setEnabled('m3u', false).then(() => { disabled = true; }); await turn(); assert.equal(disabled, false);
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
  const input = new NativeHttpInput(async () => new Response(new ReadableStream({ start(controller) { bodyController = controller; } })), () => { closed++; });
  try {
    const signal = new AbortController().signal, first = await input.acquire(signal), read = first.stream.next();
    bodyController.close();
    const racing = input.acquire(signal), rejected = assert.rejects(racing, /unavailable/);
    assert.equal((await read).done, true); await rejected; await first.close();
    assert.equal(input.enabled, false); assert.equal(closed, 1);
  } finally { await input.close(); }
});
