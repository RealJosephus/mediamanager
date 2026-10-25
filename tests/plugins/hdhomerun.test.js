import test, { after } from 'node:test';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseModel, parseLineup } from '../../plugins/hdhomerun/json.js';
import { discoveryPacket } from '../../plugins/hdhomerun/discovery.js';
import { supportsTranscoding } from '../../plugins/hdhomerun/source.js';
import { LiveTvTunerService } from '../../src/library/live-tv-tuner-service.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const resourceLease = enabled ? await acquireTestResource('hdhomerun-discovery-65001') : null;
const turn = () => new Promise(resolve => setImmediate(resolve));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wire = value => JSON.parse(JSON.stringify(value, (_key, value) => value === null ? undefined : value));
const errorDiagnostic = cause => ({ name: cause.name, message: cause.message, code: cause.code, status: cause.status, httpStatus: cause.httpStatus, stack: cause.stack });
const failureValues = observation => ({ ...observation, error: observation.error != null });
const defaults = values => ({ Id: 'official-hdhr', Url: '', Type: 'hdhomerun', DeviceId: 'before', FriendlyName: null,
  ImportFavoritesOnly: false, AllowHWTranscoding: true, AllowFmp4TranscodingContainer: false, AllowStreamSharing: true,
  FallbackMaxStreamingBitrate: 30000000, EnableStreamLooping: false, Source: null, TunerCount: 0, UserAgent: null,
  IgnoreDts: true, ReadAtNativeFramerate: false, ...values });

async function fixture(t, { options = {}, root: supplied, preinstalled = false } = {}) {
  const root = supplied ?? await fs.mkdtemp(path.join(os.tmpdir(), 'hdhr-plugin-')); await fs.mkdir(root, { recursive: true });
  let host, storage; const diagnostics = [], cachePath = path.join(root, 'cache');
  t.after(async () => {
    try { await host?.close(); } finally { try { await storage?.close(); } finally {
      const resolved = path.resolve(root);
      assert.ok(supplied ? path.basename(resolved) === 'private-inputs' : path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('hdhr-plugin-'));
      await fs.rm(resolved, { recursive: true, force: true });
    } }
  });
  let official = false;
  if (preinstalled) { official = path.join(root, 'official'); await fs.mkdir(official); await fs.cp(path.resolve('plugins/hdhomerun'), path.join(official, 'hdhomerun'), { recursive: true }); }
  let currentCachePath = cachePath;
  host = await PluginHost.open({ directory: path.join(root, 'host'), get cachePath() { return currentCachePath; }, preinstalled: official, options: { hdhomerun: options }, onError: cause => diagnostics.push(cause.message) });
  await host.install(path.resolve('plugins/local')); if (!preinstalled) await host.install(path.resolve('plugins/hdhomerun'));
  storage = await createConfiguredStorage(undefined, { plugins: host });
  await storage.configure({ instances: [{ id: 'controlled', type: 'local', config: { root, writable: true } }],
    mounts: [{ path: '/controlled', instanceId: 'controlled', root: '/', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
    prefixes: [{ identityRoot: root, accessRoot: '/controlled', style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
      purpose: 'library', returnAccess: 'The isolated HDHomeRun device stores its native channel cache through the configured mount.' }] });
  let configuration = { TunerHosts: [] }, accepting = true, admitted = 0, released = 0;
  return { root, cachePath, host, storage, diagnostics, get tuner() { return host.entries('tuner')[0]; }, configure(hosts) { configuration = { TunerHosts: hosts }; },
    setCachePath(value) { currentCachePath = value; },
    rejectAdmissions() { accepting = false; }, counters: () => ({ admitted, released }), connect: () => host.connect({ fileSystem: storage.fileSystem,
      liveTv: { admitRead() { if (!accepting) throw Object.assign(new Error('Configuration is closing.'), { status: 503 }); admitted++; let done = false;
        return { async getConfiguration() { return structuredClone(configuration); }, release() { if (!done) { done = true; released++; } } }; } } }) };
}
async function server(t, handler) {
  const sockets = new Map(), value = createServer(handler);
  value.on('connection', socket => { const closed = Promise.withResolvers(); sockets.set(socket, closed.promise); socket.once('close', () => { sockets.delete(socket); closed.resolve(); }); });
  await new Promise((resolve, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); await Promise.all([...sockets.values()]); assert.equal(sockets.size, 0); });
  return 'http://127.0.0.1:' + value.address().port;
}
const selected = async value => { const channel = (await value.tuner.getChannels(false, {}))[0]; return { channel, source: (await value.tuner.getChannelStreamMediaSources(channel.Id, {}))[0] }; };
const open = (value, chosen, signal, current = []) => value.tuner.getChannelStream(chosen.channel.Id, chosen.source.mediaSource.Id, current, { source: chosen.source, signal });
const channel = (origin, values = {}) => ({ GuideNumber: '7.1', GuideName: 'News <&> 台', HD: 1, Favorite: -1, DRM: 0, VideoCodec: 'h264', AudioCodec: 'ac3', URL: origin + '/live.ts', ...values });
const device = (origin, values = {}) => ({ FriendlyName: 'Controlled device', ModelNumber: 'HDHR5', DeviceID: 'C0FFEE', TunerCount: '2', BaseURL: origin, LineupURL: origin + '/lineup.json', ...values });

test('installed and official HDHomeRun use shared admitted configuration and a mapped native cache', { timeout: 30000 }, async t => {
  const requests = [];
  const origin = await server(t, (request, response) => { requests.push(request.url); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/discover.json' ? device(origin) : [channel(origin)])); });
  for (const preinstalled of [false, true]) {
    const value = await fixture(t, { preinstalled }); assert.equal(value.host.get('hdhomerun').status, 'active'); assert.equal(value.tuner.name, 'HD Homerun');
    assert.throws(() => value.tuner.getChannels(false, {}), { status: 503 });
    value.configure([defaults({ Url: origin })]); await value.connect();
    const first = await value.tuner.getChannels(false, {}); assert.equal(first[0].Id, 'hdhr_7.1'); assert.equal(first[0].Name, 'News <&> 台');
    assert.equal(first[0].IsHD, true); assert.equal(first[0].IsFavorite, true); assert.equal(first[0].Path, origin + '/live.ts');
    const cache = JSON.parse(await fs.readFile(path.join(value.cachePath, 'official-hdhr_channels'), 'utf8'));
    assert.equal(cache[0].ChannelType, 0); assert.equal(cache[0].TunerChannelId, null); assert.equal(Object.hasOwn(cache[0], 'IsLegacyTuner'), false);
    const before = requests.length; await value.tuner.getChannels(true, {}); assert.equal(requests.length, before);
    const info = defaults({ Url: origin }); await value.tuner.validate(info, {}); assert.equal(info.DeviceId, 'C0FFEE');
    await assert.rejects(value.host.configure('hdhomerun', { Url: origin }), /shared Live TV configuration/);
    value.configure([defaults({ Id: '../outside', Url: origin })]); await assert.rejects(value.tuner.getChannels(false, {}), /one file-name component/);
    value.rejectAdmissions(); assert.throws(() => value.tuner.getChannels(true, {}), { status: 503 });
    assert.equal(value.counters().admitted, value.counters().released);
  }
});

test('HDHomeRun follows cache path updates between requests and keeps an admitted cache write on its original path', { timeout: 30000 }, async t => {
  for (const preinstalled of [false, true]) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), origin = 'http://controlled.invalid';
    let lineups = 0, explicitCachePath;
    const value = await fixture(t, { preinstalled, options: {
      get cachePath() { return explicitCachePath; },
      async fetch(url) {
        if (url.endsWith('/discover.json')) return new Response(JSON.stringify(device(origin)));
        if (++lineups === 1) { entered.resolve(); await release.promise; }
        return new Response(JSON.stringify([channel(origin)]));
      },
    } });
    value.configure([defaults({ Url: origin })]); await value.connect();
    const pending = value.tuner.getChannels(false, {});
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('The lineup completed before its held response.'); })]);
      const nextCachePath = path.join(value.root, 'next-cache'); value.setCachePath(nextCachePath);
      release.resolve();
      const first = await pending;
      const filename = 'official-hdhr_channels', original = await fs.readFile(path.join(value.cachePath, filename));
      assert.equal(first[0].Path, origin + '/live.ts');
      await assert.rejects(fs.readFile(path.join(nextCachePath, filename)), { code: 'ENOENT' });
      assert.deepEqual(await value.tuner.getChannels(false, {}), first);
      assert.deepEqual(await fs.readFile(path.join(nextCachePath, filename)), original);
      explicitCachePath = path.join(value.root, 'explicit-cache');
      const unusedCachePath = path.join(value.root, 'later-server-cache'); value.setCachePath(unusedCachePath);
      assert.deepEqual(await value.tuner.getChannels(false, {}), first);
      assert.deepEqual(await fs.readFile(path.join(explicitCachePath, filename)), original);
      await assert.rejects(fs.readFile(path.join(unusedCachePath, filename)), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(path.join(value.cachePath, filename)), original);
      assert.deepEqual(await fs.readdir(path.join(value.root, 'host', 'cache', 'hdhomerun')), []);
      assert.equal(value.counters().admitted, value.counters().released);
    } finally { release.resolve(); await Promise.allSettled([pending]); }
  }
});

test('HDHomeRun raw HTTP waits for first bytes, ignores upstream status, shares independent consumers, and creates no stream file', { timeout: 30000 }, async t => {
  let live, opened = Promise.withResolvers(), requests = 0;
  const origin = await server(t, (request, response) => {
    if (request.url === '/discover.json') { response.end(JSON.stringify(device(origin))); return; }
    if (request.url === '/lineup.json') { response.end(JSON.stringify([channel(origin)])); return; }
    requests++; response.writeHead(503, { 'Content-Type': 'video/mp2t' }); response.flushHeaders(); live = response; opened.resolve();
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin, TunerCount: 1, AllowStreamSharing: false, EnableStreamLooping: true })]); await value.connect();
  const chosen = await selected(value); let delivered = false;
  const opening = open(value, chosen).then(result => { delivered = true; return result; }); await opened.promise; await turn(); assert.equal(delivered, false);
  live.write(Buffer.from([0, 255, 71, 0])); const first = await opening, second = await first.sharing.retain({});
  assert.equal(first.mediaSource.Protocol, 'Http'); assert.equal(first.mediaSource.Path, origin + '/live.ts');
  assert.deepEqual((await first.stream.next()).value, Buffer.from([0, 255, 71, 0])); assert.deepEqual((await second.stream.next()).value, Buffer.from([0, 255, 71, 0]));
  await assert.rejects(open(value, chosen, undefined, [{ tunerHostId: 'OFFICIAL-HDHR' }]), { status: 409 });
  await first.close(); const next = second.stream.next(); live.write('unaltered'); assert.equal((await next).value.toString(), 'unaltered');
  assert.equal(requests, 1); await second.close(); assert.equal(first.sharing.enabled, false); await assert.rejects(first.sharing.retain({}), { status: 503 });
  assert.deepEqual(await fs.readdir(value.cachePath), ['official-hdhr_channels']);
});

test('HDHomeRun zero-byte EOF fails opening and close drains a held first-byte read and late response', { timeout: 30000 }, async t => {
  let mode = 'empty'; const held = Promise.withResolvers();
  const origin = await server(t, (request, response) => {
    if (request.url === '/discover.json') { response.end(JSON.stringify(device(origin))); return; }
    if (request.url === '/lineup.json') { response.end(JSON.stringify([channel(origin)])); return; }
    if (mode === 'empty') response.end(); else { response.flushHeaders(); held.resolve(); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin })]); await value.connect(); const chosen = await selected(value);
  await assert.rejects(open(value, chosen), { status: 409 }); mode = 'held'; const pending = open(value, chosen);
  const rejected = assert.rejects(pending, cause => cause.status === 503 || cause.name === 'AbortError' || cause.status === 409);
  await held.promise; const tuner = value.tuner; await value.host.setEnabled('hdhomerun', false); await rejected;
  assert.throws(() => tuner.getChannels(false, {}), { status: 503 }); assert.equal(value.counters().admitted, value.counters().released);
  const late = Promise.withResolvers(), entered = Promise.withResolvers(); let canceled = 0;
  const other = await fixture(t, { options: { fetch: async (url, options) => {
    if (url.endsWith('/discover.json')) return new Response(JSON.stringify(device(origin)));
    if (url.endsWith('/lineup.json')) return new Response(JSON.stringify([channel(origin)]));
    entered.resolve(); return late.promise;
  } } }); other.configure([defaults({ Url: origin })]); await other.connect(); const selection = await selected(other);
  const opening = open(other, selection), failed = assert.rejects(opening, cause => [409, 503].includes(cause.status) || cause.name === 'AbortError'); await entered.promise;
  let disabled = false; const disabling = other.host.setEnabled('hdhomerun', false).then(() => { disabled = true; }); await turn(); assert.equal(disabled, false);
  late.resolve(new Response(new ReadableStream({ cancel() { canceled++; } }))); await failed; await disabling; assert.equal(canceled, 1);
});

test('encoded and legacy HDHomeRun inputs retain descriptive schema but reject execution before opening network bytes', { timeout: 30000 }, async t => {
  let legacy = false, hits = 0;
  const origin = await server(t, (request, response) => {
    if (request.url === '/discover.json') response.end(JSON.stringify(device(origin, { ModelNumber: 'HDTC-2US' })));
    else if (request.url === '/lineup.json') response.end(JSON.stringify([channel(origin, { URL: legacy ? 'hdhomerun://192.0.2.2/tuner0/v7.1' : origin + '/stream' })]));
    else { hits++; response.end('must not execute'); }
  });
  const value = await fixture(t); value.configure([defaults({ Url: origin })]); await value.connect(); let chosen = await selected(value);
  assert.equal((await value.tuner.getChannelStreamMediaSources(chosen.channel.Id, {})).length, 1); assert.equal(chosen.source.mediaSource.SupportsTranscoding, true);
  await assert.rejects(value.tuner.getChannelStream(chosen.channel.Id, 'heavy_native', [], { source: chosen.source }), { code: 'not-supported', status: 400 });
  legacy = true; chosen = await selected(value); assert.equal(chosen.source.mediaSource.Protocol, 'Udp'); await assert.rejects(open(value, chosen), { code: 'not-supported', status: 400 });
  assert.equal(hits, 0);
});

for (const tunerHostId of ['official-hdhr', null]) test(`official HDHomeRun capacity uses its actual ${tunerHostId === null ? 'null' : 'string'} host identity through the default consumer`, { timeout: 30000 }, async t => {
  let gets = 0, upstream;
  const origin = await server(t, (request, response) => {
    if (request.url === '/discover.json') response.end(JSON.stringify(device(origin)));
    else if (request.url === '/lineup.json') response.end(JSON.stringify([channel(origin)]));
    else { gets++; upstream = response; response.write('initial'); }
  });
  const value = await fixture(t); value.configure([defaults({ Id: tunerHostId, Url: origin, TunerCount: 1 })]); await value.connect(); const chosen = await selected(value);
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

const sourceFields = ['Protocol', 'Id', 'Path', 'Type', 'Formats', 'MediaAttachments', 'RequiredHttpHeaders', 'RequiresOpening', 'RequiresClosing',
  'RequiresLooping', 'SupportsProbing', 'BufferMs', 'Container', 'SupportsDirectPlay', 'SupportsDirectStream', 'SupportsTranscoding', 'IsInfiniteStream',
  'IgnoreDts', 'IgnoreIndex', 'GenPtsInput', 'ReadAtNativeFramerate', 'IsRemote', 'UseMostCompatibleTranscodingProfile', 'FallbackMaxStreamingBitrate', 'Bitrate', 'HasSegments'];
const streamFields = ['Type', 'Index', 'IsInterlaced', 'IsDefault', 'IsForced', 'IsHearingImpaired', 'IsOriginal', 'IsExternal', 'SupportsExternalStream', 'Codec', 'Width', 'Height', 'BitRate', 'NalLengthSize'];
const projectSource = source => wire({ ...Object.fromEntries(sourceFields.map(key => [key, source[key]])), MediaStreams: source.MediaStreams.map(stream => Object.fromEntries(streamFields.map(key => [key, stream[key]]))) });

function definitions(origin) {
  const info = defaults({ Url: origin }), model = JSON.stringify(device(origin)), lineup = JSON.stringify([channel(origin), channel(origin, { GuideNumber: '7.1', GuideName: 'Duplicate' }), channel(origin, { GuideNumber: '8', DRM: 1 })]);
  const action = (kind, other = {}) => ({ kind, model, lineup, ...other });
  return { defaultInfo: info, origin, discoveryDurationMs: 3000,
    models: [
      { name: 'model-defaults', body: '{}' }, { name: 'model-null', body: 'null' }, { name: 'model-quoted', body: '{"DeviceID":42,"TunerCount":"+3","FriendlyName":false}' },
      { name: 'model-case', body: '{"DeviceID":"old","DeviceID":"new","deviceId":"wrong","tunercount":7}' },
      { name: 'model-invalid-prefix', body: '{"TunerCount":"bad","TunerCount":2}' }, { name: 'model-404', body: '{}', status: 404 }, { name: 'model-503', body: '{}', status: 503 },
    ],
    lineups: [
      { name: 'lineup-defaults', body: '[{}]' }, { name: 'lineup-null', body: 'null' }, { name: 'lineup-numeric-bools', body: '[{"GuideNumber":4,"GuideName":false,"Favorite":-2,"DRM":0,"HD":1}]' },
      { name: 'lineup-invalid-boolean-prefix', body: '[{"HD":"true","HD":true}]' }, { name: 'lineup-null-member', body: '[null]' },
      { name: 'lineup-case', body: '[{"GuideNumber":"x","GuideName":"first","GuideName":"last","guideName":"wrong","hd":1}]' },
    ],
    cases: [
      { name: 'cache-retention-and-short-write', infos: [info], actions: [action('channels', { enabled: false }), action('channels', { enabled: true, modelStatus: 503, lineupStatus: 503 }),
        action('channels', { enabled: false, lineup: '[]' }), action('channels', { enabled: true }), action('channels', { enabled: true, restart: true, modelStatus: 503 })] },
      { name: 'favorite-filter-and-number-bools', infos: [defaults({ Url: origin, ImportFavoritesOnly: true })], actions: [action('channels', { enabled: false })] },
      { name: 'lineup-status-is-not-ensured', infos: [info], actions: [action('channels', { enabled: false, lineupStatus: 503 })] },
      { name: 'cache-strict-reader', infos: [info], cacheBase64: Buffer.from('[{"Id":5}]').toString('base64'), actions: [action('channels', { enabled: true, modelStatus: 503 })] },
      { name: 'cache-root-null', infos: [info], cacheBase64: Buffer.from('null').toString('base64'), actions: [action('channels', { enabled: true, modelStatus: 503 })] },
      { name: 'validate-keeps-channel-memory', infos: [info], actions: [action('channels', { enabled: false }), action('validate', { model: JSON.stringify(device(origin, { DeviceID: 'replacement' })) }), action('channels', { enabled: true }), action('sources', { channelId: 'HDHR_7.1' })] },
      { name: 'validate-404-no-device-mutation', infos: [info], actions: [action('validate', { modelStatus: 404 })] },
      { name: 'validate-null-failure', infos: [info], actions: [action('validate', { model: 'null' })] },
      { name: 'all-host-dedup', infos: [info, defaults({ Id: 'second', Type: 'HDHOMERUN', Url: origin }), defaults({ Id: 'ignored', Type: 'm3u', Url: origin })], actions: [action('channels', { enabled: false }), action('sources', { channelId: 'hdhr_7.1' })] },
      { name: 'modern-source-and-construction', infos: [info], actions: [action('sources', { channelId: 'hdhr_7.1' }), action('construct', { streamId: 'native_controlled' })] },
      { name: 'hdtc-retained-native-source', infos: [info], actions: [action('sources', { channelId: 'hdhr_7.1', model: JSON.stringify(device(origin, { ModelNumber: 'HDTC-2US' })) })] },
      { name: 'sd-mpeg2-truncated-channel-key', infos: [info], actions: [action('sources', { channelId: 'hdhr_3_4', lineup: JSON.stringify([channel(origin, { GuideNumber: '3_4', HD: 0, VideoCodec: 'MPEG2', AudioCodec: 'aac' })]) })] },
      { name: 'default-lineup-channel-source', infos: [info], actions: [action('sources', { channelId: 'hdhr_', lineup: '[{}]' })] },
      { name: 'legacy-source-and-construction', infos: [info], actions: [action('sources', { channelId: 'hdhr_7.1', lineup: JSON.stringify([channel(origin, { URL: 'hdhomerun://192.0.2.2/tuner0/v7.1' })]) }), action('construct', { streamId: 'native_controlled' })] },
      { name: 'wrong-channel-prefix', infos: [info], actions: [action('sources', { channelId: 'other_7.1' })] },
    ] };
}

async function udpFixture(t, port = 0) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }), receipts = [], pending = new Set(), errors = [], transitions = [];
  let phase = 'default', closing, closed = false, closedAt;
  socket.once('close', () => { closed = true; closedAt = new Date().toISOString(); }); socket.on('error', cause => errors.push({ name: cause.name, code: cause.code, message: cause.message }));
  socket.on('message', (bytes, remote) => {
    const receipt = { phase, receivedAt: new Date().toISOString(), bytesBase64: bytes.toString('base64'), address: remote.address, port: remote.port, replies: [] }; receipts.push(receipt);
    const valid = Buffer.alloc(14); valid[1] = 3;
    for (const [index, reply] of [Buffer.from([0, 3]), Buffer.alloc(14), valid, valid].entries()) {
      const observation = { index, queuedAt: new Date().toISOString(), acceptedByNativePrefix: index >= 2, bytesBase64: reply.toString('base64'), address: remote.address, port: remote.port };
      receipt.replies.push(observation);
      const work = new Promise(resolve => {
        const done = cause => { observation.callbackAt = new Date().toISOString(); observation.callback = cause ? { code: cause.code, name: cause.name, message: cause.message } : { code: 0 }; resolve(); };
        try { socket.send(reply, remote.port, remote.address, done); } catch (cause) { done(cause); }
      });
      pending.add(work); work.then(() => pending.delete(work));
    }
  });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '0.0.0.0', resolve); });
  const settle = async () => { while (pending.size) await Promise.all([...pending]); };
  const close = () => closing ??= (async () => { await settle(); await new Promise(resolve => socket.close(resolve)); assert.equal(closed, true); })();
  t.after(close);
  return { receipts, errors, transitions, port: socket.address().port, settle, close,
    setPhase(value) { transitions.push({ phase: value, at: new Date().toISOString(), pendingReplySends: pending.size }); phase = value; },
    get closed() { return closed; }, get closedAt() { return closedAt; } };
}

function discoveryRequests(receipts, phase, localPort) {
  const selected = receipts.filter(value => value.phase === phase); assert.ok(selected.length > 0, phase + ' must send a real discovery packet.');
  for (const receipt of selected) {
    assert.equal(receipt.port, localPort, phase + ' packets must belong to the actual observed discovery socket.');
    assert.deepEqual(Buffer.from(receipt.bytesBase64, 'base64'), discoveryPacket);
    assert.equal(receipt.replies.length, 4);
    for (const [index, reply] of receipt.replies.entries()) {
      assert.equal(reply.port, localPort); assert.equal(reply.address, receipt.address); assert.equal(reply.index, index); assert.equal(reply.callback?.code, 0);
      const expected = index === 0 ? Buffer.from([0, 3]) : Buffer.alloc(14); if (index >= 2) expected[1] = 3;
      assert.deepEqual(Buffer.from(reply.bytesBase64, 'base64'), expected);
    }
  }
  return selected;
}

function observedDiscoverySocket(records, options) {
  const socket = dgram.createSocket(options), record = { bound: null, messages: [], errors: [], closed: false }; records.push(record);
  socket.once('listening', () => { record.bound = socket.address(); record.listeningAt = new Date().toISOString(); });
  socket.once('close', () => { record.closed = true; record.closedAt = new Date().toISOString(); });
  socket.on('message', (bytes, remote) => record.messages.push({ receivedAt: new Date().toISOString(), bytesBase64: bytes.toString('base64'), address: remote.address, port: remote.port }));
  socket.on('error', cause => record.errors.push({ code: cause.code, name: cause.name, message: cause.message })); return socket;
}

test('HDHomeRun discovery owns an actual UDP socket, validates only native reply prefix, keeps duplicates and cancels pending receive', { timeout: 15000 }, async t => {
  const udp = await udpFixture(t), urls = [];
  const value = await fixture(t, { options: { discoveryAddress: '127.0.0.1', discoveryPort: udp.port, fetch: async (url, options) => {
    urls.push(url); options.signal.throwIfAborted(); return new Response(JSON.stringify(device('http://127.0.0.1')));
  } } }); await value.connect();
  const devices = await value.tuner.discoverDevices(150, {});
  assert.deepEqual(udp.receipts.map(value => Buffer.from(value.bytesBase64, 'base64')), [discoveryPacket]);
  assert.equal(devices.length, 2); assert.deepEqual(devices[0], devices[1]); assert.deepEqual(urls, ['http://127.0.0.1/discover.json', 'http://127.0.0.1/discover.json']);
  const tuner = value.tuner;
  const waiting = tuner.discoverDevices(-1, {}), rejected = assert.rejects(waiting, { status: 503 }); udp.receipts.length = 0;
  // The first discovery already proved the socket path; close must cancel the
  // infinite receive instead of waiting for a request timeout or another packet.
  await turn(); await value.host.setEnabled('hdhomerun', false); await rejected;
  assert.throws(() => tuner.discoverDevices(1, {}), { status: 503 });
});

test('HDHomeRun caller cancellation drains a real discovery HTTP body and UDP socket with an arbitrary Error reason', { timeout: 15000 }, async t => {
  const udp = await udpFixture(t), entered = Promise.withResolvers(), bodyClosed = Promise.withResolvers(), sockets = [];
  const caller = new AbortController(), reason = Object.assign(new Error('Caller stopped discovery.'), { code: 'caller-stop' });
  let requests = 0, signal;
  const origin = await server(t, (_request, response) => {
    requests++; response.once('close', () => bodyClosed.resolve());
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"DeviceID":'); entered.resolve();
  });
  const value = await fixture(t, { options: { discoveryAddress: '127.0.0.1', discoveryPort: udp.port,
    createSocket: options => observedDiscoverySocket(sockets, options), fetch: (url, options) => {
      signal = options.signal; return fetch(origin + '/discover.json', options);
    } } }); await value.connect();
  const pending = value.tuner.discoverDevices(-1, { signal: caller.signal });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.message, reason.message); assert.equal(error.code, reason.code); return true;
  });
  t.after(async () => { caller.abort(reason); await Promise.allSettled([pending, rejected]); });
  await entered.promise; caller.abort(reason); await rejected; await bodyClosed.promise;
  assert.equal(signal.aborted, true); assert.equal(signal.reason.message, reason.message); assert.equal(signal.reason.code, reason.code);
  assert.equal(requests, 1); assert.equal(sockets.length, 1); assert.equal(sockets[0].closed, true);
  assert.equal(value.counters().admitted, value.counters().released);
  t.diagnostic(JSON.stringify({ callerCancelled: signal.aborted, reason: errorDiagnostic(signal.reason), httpBodyClosed: true,
    udpClosed: sockets[0].closed, diagnostics: value.diagnostics }));
});

test('HDHomeRun designated model/lineup/cache/validation/source construction and UDP discovery match actual components over real HTTP', {
  skip: !enabled, timeout: 240000,
}, async t => {
  let input; const requests = [];
  const origin = await server(t, (request, response) => {
    const name = request.headers['x-fixture-sample'], step = Number(request.headers['x-fixture-step']), model = request.url.endsWith('/discover.json');
    requests.push({ name, step, url: request.url, method: request.method });
    const parser = [...input.models, ...input.lineups].find(value => value.name === name), sample = input.cases.find(value => value.name === name);
    const action = sample?.actions[step];
    const body = name === 'discovery' ? JSON.stringify(device(origin)) : parser && (name.startsWith('model-') || !model) ? parser.body
      : model ? action?.model ?? JSON.stringify(device(origin)) : action?.lineup;
    response.writeHead(parser && name.startsWith('model-') ? parser.status ?? 200 : model ? action?.modelStatus ?? 200 : action?.lineupStatus ?? 200, { 'Content-Type': 'application/json' }); response.end(body);
  });
  input = definitions(origin); const udp = await udpFixture(t, 65001);
  const root = path.join(validationOutputRoot(), 'hdhomerun-' + randomUUID()); await fs.mkdir(root);
  const report = { comparisons: [], cleanup: {}, httpRequests: requests, udp: { receipts: udp.receipts, phaseTransitions: udp.transitions } }; let failure;
  try {
    const producer = await fixture(t, { options: { fetch: (url, options) => fetch(url, { ...options,
      headers: { ...options.headers, 'X-Fixture-Sample': 'cache-retention-and-short-write', 'X-Fixture-Step': '0' } }) } });
    producer.configure([defaults({ Url: origin })]); await producer.connect(); await producer.tuner.getChannels(false, {});
    const produced = await fs.readFile(path.join(producer.cachePath, 'official-hdhr_channels'));
    input.cases.push({ name: 'native-reads-node-produced-cache', infos: [defaults({ Url: origin })], cacheBase64: produced.toString('base64'),
      actions: [{ kind: 'channels', enabled: true, modelStatus: 503, model: '{}', lineup: '[]' },
        { kind: 'sources', channelId: 'hdhr_7.1', modelStatus: 503, model: '{}', lineup: '[]' }] });
    report.nodeCacheSha256 = sha(produced); await producer.host.close(); await producer.storage.close();
    const reference = await currentNativeReference(); report.sourceBindings = await reference.sourceBindings([
      'src/Jellyfin.LiveTv/TunerHosts/BaseTunerHost.cs', 'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/HdHomerunHost.cs',
      'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/DiscoverResponse.cs', 'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/Channels.cs',
      'src/Jellyfin.LiveTv/TunerHosts/SharedHttpStream.cs', 'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/HdHomerunUdpStream.cs',
      'src/Jellyfin.Networking/Udp/SocketFactory.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonBoolNumberConverter.cs',
      'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'MediaBrowser.Controller/LiveTv/ChannelInfo.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs']);
    const inputBytes = Buffer.from(JSON.stringify(input)), filename = path.join(root, 'input.json'); await fs.writeFile(filename, inputBytes);
    udp.setPhase('native');
    const worker = new Worker(new URL('./fixtures/hdhomerun/oracle-worker.js', import.meta.url), { workerData: { project: 'tests/plugins/fixtures/hdhomerun/Oracle.csproj', output: path.join(root, 'native'), args: [filename, '{output}/native.json'] }, trackUnmanagedFds: true });
    t.after(async () => { if (worker.threadId !== -1) await worker.terminate(); });
    await new Promise((resolve, reject) => { let result, messages = 0, failed;
      worker.on('message', value => { result = value; messages++; }); worker.once('error', cause => { failed = cause; });
      worker.once('exit', code => { if (failed || code !== 0 || messages !== 1 || result?.record?.passed !== true) reject(failed ?? new Error(result?.error?.message ?? 'HDHomeRun oracle did not finish.')); else resolve(); });
    });
    assert.equal(worker.threadId, -1); report.cleanup.workerExited = true; report.cleanup.nativeProcessExitedAt = new Date().toISOString(); await udp.settle(); udp.setPhase('between');
    const nativeBytes = await fs.readFile(path.join(root, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(native.actualHdHomerunHost && native.actualBaseTunerHost && native.actualUdpSocketFactory && native.actualHttpClient && native.privateInputsRemoved);
    assert.equal(native.streamOpenInvoked, false); assert.equal(native.recordingOrTranscodingStarted, false); assert.equal(native.inputSha256, sha(inputBytes));
    for (const assembly of native.assemblies) assert.equal(sha(await fs.readFile(assembly.path)), assembly.sha256);
    report.nativeSha256 = sha(nativeBytes); report.inputSha256 = sha(inputBytes);
    report.nativeDiscovery = native.discovery; report.nativeDiagnostics = native.diagnostics; report.nodeInterfaces = os.networkInterfaces();
    report.udp.native = native.discovery;
    assert.equal(native.discovery.allSocketsDisposed, true);
    assert.equal(native.discovery.sockets.length, 1); assert.equal(native.discovery.sockets[0].EnableBroadcast, true);
    assert.match(native.discovery.sockets[0].endpoint, /^0\.0\.0\.0:\d+$/u);
    const nativePort = Number(native.discovery.sockets[0].endpoint.split(':').at(-1)); assert.ok(Number.isInteger(nativePort) && nativePort > 0 && nativePort <= 65535);
    const nativePackets = discoveryRequests(udp.receipts, 'native', nativePort);
    report.udp.nativeSocketPort = nativePort; report.udp.nativePacketCount = nativePackets.length;
    const nativeDeviceOrigins = nativePackets.flatMap(receipt => ['http://' + receipt.address, 'http://' + receipt.address]);
    assert.equal(native.discovery.devices.length, nativePackets.length * 2); assert.equal(native.discovery.requests.length, nativePackets.length * 2);
    assert.deepEqual(native.discovery.devices.map(value => value.Url), nativeDeviceOrigins);
    for (let index = 0; index < native.discovery.devices.length; index += 2) assert.deepEqual(native.discovery.devices[index], native.discovery.devices[index + 1]);
    for (const [index, value] of native.discovery.devices.entries()) {
      assert.equal(native.discovery.requests[index].uri, value.Url + '/discover.json');
    }
    for (const sample of input.models) {
      let value = null, error = null;
      try { if ((sample.status ?? 200) >= 400) { if (sample.status === 404) value = parseModel('{"ModelNumber":"HDHR"}'); else throw Object.assign(new Error('Controlled model HTTP failure.'), { code: 'http-error', httpStatus: sample.status }); } else value = parseModel(sample.body); }
      catch (caught) { error = errorDiagnostic(caught); }
      const actual = wire({ name: sample.name, value: value && { ...value, SupportsTranscoding: supportsTranscoding(value) }, error }), expected = native.models.find(value => value.name === sample.name);
      const actualValues = failureValues(actual), expectedValues = failureValues(expected);
      report.comparisons.push({ actual: actualValues, expected: expectedValues, raw: { actual, native: expected } });
      assert.deepEqual(actualValues, expectedValues, sample.name);
    }
    for (const sample of input.lineups) {
      let value = null, error = null;
      try { value = parseLineup(sample.body).filter(entry => !entry.DRM); }
      catch (caught) { error = errorDiagnostic(caught); }
      const actual = wire({ name: sample.name, value, error }), expected = native.lineups.find(value => value.name === sample.name);
      const actualValues = failureValues(actual), expectedValues = failureValues(expected);
      report.comparisons.push({ actual: actualValues, expected: expectedValues, raw: { actual, native: expected } });
      assert.deepEqual(actualValues, expectedValues, sample.name);
    }
    let activeName, step, opened = []; const nodeDiscoverySockets = []; report.nodeHttpRequests = opened; report.udp.nodeSockets = nodeDiscoverySockets;
    const controlled = await fixture(t, { root: path.join(root, 'private-inputs'), options: { discoveryPort: udp.port,
      createSocket: options => observedDiscoverySocket(nodeDiscoverySockets, options),
      fetch: async (url, options) => {
        opened.push({ uri: url, clientName: 'Default' });
        const destination = activeName === 'discovery' ? origin + '/discover.json' : url;
        return fetch(destination, { ...options, headers: { ...options.headers, 'X-Fixture-Sample': activeName, 'X-Fixture-Step': String(step) } });
      } } }); await controlled.connect();
    for (const sample of input.cases) {
      // Fresh plugin activation, rather than a synthetic cache reset, owns both
      // model and channel dictionaries for each native component scenario.
      await controlled.host.setEnabled('hdhomerun', false); await controlled.host.setEnabled('hdhomerun', true); await controlled.connect();
      const infos = structuredClone(sample.infos); controlled.configure(infos); const observations = []; activeName = sample.name;
      const cacheFile = path.join(controlled.cachePath, 'official-hdhr_channels');
      for (const existing of await fs.readdir(controlled.cachePath).catch(cause => cause.code === 'ENOENT' ? [] : Promise.reject(cause))) await fs.unlink(path.join(controlled.cachePath, existing));
      if (sample.cacheBase64 !== undefined) { await fs.mkdir(controlled.cachePath, { recursive: true }); await fs.writeFile(cacheFile, Buffer.from(sample.cacheBase64, 'base64')); }
      for (const [index, action] of sample.actions.entries()) {
        step = index; if (action.restart) { await controlled.host.setEnabled('hdhomerun', false); await controlled.host.setEnabled('hdhomerun', true); await controlled.connect(); }
        const before = opened.length; let value = null, error = null;
        try {
          if (action.kind === 'channels') value = await controlled.tuner.getChannels(action.enabled, {});
          else if (action.kind === 'validate') { const info = infos[0]; await controlled.tuner.validate(info, {}); value = info; controlled.configure(infos); }
          else if (action.kind === 'sources') value = (await controlled.tuner.getChannelStreamMediaSources(action.channelId, {})).map(source => source.mediaSource);
          else continue; // Construction is inspected below against the actual native object; never execute its Open.
        } catch (caught) { error = errorDiagnostic(caught); }
        const cacheBase64 = await fs.readFile(cacheFile).then(bytes => bytes.toString('base64'), cause => cause.code === 'ENOENT' ? null : Promise.reject(cause));
        observations.push({ index, actual: wire({ value, error, requests: opened.slice(before), cacheBase64 }) });
      }
      const expected = native.results.find(value => value.name === sample.name);
      for (const observation of observations) {
        let actual = observation.actual, target = expected.observations[observation.index];
        if (sample.actions[observation.index].kind === 'sources') {
          report.excludedEncodedProfiles ??= [];
          const profiles = (target.value ?? []).filter(value => !value.Id.startsWith('native_')).map(value => value.Id.split('_')[0]);
          if (profiles.length) report.excludedEncodedProfiles.push({ name: sample.name, profiles, reason: 'Recording/transcoding execution is excluded; retained native descriptor is compared.' });
          target = { ...target, value: (target.value ?? []).filter(value => value.Id.startsWith('native_')).map(projectSource) };
          actual = { ...actual, value: (actual.value ?? []).map(projectSource) };
        }
        const actualValues = failureValues(actual), expectedValues = failureValues(target);
        report.comparisons.push({ name: sample.name, index: observation.index, actual: actualValues, expected: expectedValues,
          raw: { actual: observation.actual, native: expected.observations[observation.index] } });
        assert.deepEqual(actualValues, expectedValues, sample.name + ':' + observation.index);
      }
    }
    const constructions = native.results.filter(value => value.name.endsWith('-construction')).map(value => ({ name: value.name, observation: value.observations.at(-1) }));
    assert.equal(constructions.length, 2);
    for (const { name, observation } of constructions) {
      assert.equal(observation.error != null, false); assert.equal(observation.value.OriginalStreamId, 'native_controlled');
      assert.equal(observation.value.EnableStreamSharing, true); assert.equal(observation.value.ConsumerCount, 1);
      assert.deepEqual(observation.value.MediaSource, observation.value.OriginalMediaSource);
      assert.equal(observation.value.MediaSource.Protocol, name.startsWith('legacy') ? 'Udp' : 'Http');
    }
    report.nativeConstruction = constructions;
    activeName = 'discovery'; step = 0; const before = opened.length; udp.setPhase('node');
    const found = wire(await controlled.tuner.discoverDevices(input.discoveryDurationMs, {})); await udp.settle(); udp.setPhase('after');
    report.udp.node = found; report.udp.nodeSockets = nodeDiscoverySockets; report.udp.nodeHttpRequests = opened.slice(before);
    assert.equal(nodeDiscoverySockets.length, 1); const nodeSocket = nodeDiscoverySockets[0];
    assert.equal(nodeSocket.bound?.address, '0.0.0.0'); assert.ok(nodeSocket.bound.port > 0);
    assert.notEqual(nodeSocket.bound.port, nativePort, 'Independent phases must not reuse the native socket port.');
    assert.equal(nodeSocket.closed, true); assert.deepEqual(nodeSocket.errors, []);
    const nodePackets = discoveryRequests(udp.receipts, 'node', nodeSocket.bound.port); report.udp.nodePacketCount = nodePackets.length;
    assert.equal(nodePackets.length, nativePackets.length, 'The same real broadcast topology must deliver the same request multiplicity to each phase.');
    assert.deepEqual(nodeSocket.messages.map(value => value.bytesBase64).sort(), nodePackets.flatMap(receipt => receipt.replies.map(reply => reply.bytesBase64)).sort());
    assert.ok(nodeSocket.messages.every(value => value.port === udp.port));
    assert.deepEqual(found.map(value => value.Url), nodePackets.flatMap(receipt => ['http://' + receipt.address, 'http://' + receipt.address]));
    assert.equal(found.length, nodePackets.length * 2); assert.equal(opened.length - before, nodePackets.length * 2);
    assert.deepEqual(opened.slice(before).map(value => value.uri), found.map(value => value.Url + '/discover.json'));
    assert.deepEqual(found, native.discovery.devices);
    await controlled.host.close(); await controlled.storage.close(); report.cleanup.pluginAndStorageClosed = true;
    assert.equal(controlled.counters().admitted, controlled.counters().released);
    assert.ok(requests.every(value => value.method === 'GET')); assert.ok(report.excludedEncodedProfiles.some(value => value.profiles.length === 6));
  } catch (cause) { failure = cause; }
  finally {
    try {
      await udp.close(); report.cleanup.udpFixtureClosed = udp.closed; report.cleanup.udpFixtureClosedAt = udp.closedAt; report.udp.fixtureErrors = udp.errors;
      assert.deepEqual(udp.errors, []); assert.ok(udp.receipts.every(value => ['native', 'node'].includes(value.phase)), 'A late discovery packet crossed its owned execution phase.');
    } catch (cause) { failure ??= cause; report.cleanup.udpFailure = { name: cause.name, message: cause.message }; }
    await fs.writeFile(path.join(root, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, phaseAcceptance: false, releaseAcceptance: false,
      nativeRawCopyExecuted: false, publicPlaybackValidated: false, error: failure?.stack }, null, 2) + '\n');
  }
  if (failure) throw failure;
});

// Release after all test hooks, streams, processes and resource postconditions.
after(async () => { await resourceLease?.release(); });
