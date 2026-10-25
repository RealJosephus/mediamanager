import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginHost } from '../../src/plugins/host.js';
import { liveTvSignalPositions, validateNativeLiveTvSource } from '../../src/plugins/live-tv-contract.js';
import * as sdk from '../../packages/plugin-sdk/live-tv/contract.js';
import { pluginFixture } from './fixture.js';

const source = (changes = {}) => ({ mode: 'native', profile: 'native', mediaSource: {
  Id: 'native_fixture', Path: 'http://127.0.0.1:12345/auto/v1', Protocol: 'Http',
  SupportsTranscoding: true, UseMostCompatibleTranscodingProfile: true,
  RequiredHttpHeaders: { 'X-Controlled': 'retained' }, ...changes,
} });
const turn = () => new Promise(resolve => setImmediate(resolve));
const aborting = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

async function packageSource(fixture, code, directory = path.join(fixture.root, 'source-' + randomUUID())) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@test/live-tv', version: '0.1.0', type: 'module',
    dependencies: { '@mediamanager/plugin-sdk': '0.1.0' }, mediamanager: { id: 'live-tv', name: 'Controlled Live TV', entry: 'index.js' } }));
  await writeFile(path.join(directory, 'index.js'), code);
  return directory;
}

const providers = `
import { liveTvSignalPositions, validateLiveTvExtension } from '@mediamanager/plugin-sdk/live-tv/contract';
export async function activate(context) {
  context.own(() => context.options.closed?.());
  for (const [kind, methods] of Object.entries(liveTvSignalPositions)) {
    const value = { type: 'controlled-' + kind, name: 'Controlled ' + kind };
    for (const method of Object.keys(methods)) value[method] = (...args) => context.options.invoke(kind, method, args);
    value.unmanagedOpen = () => { throw new Error('An unmanaged callback escaped the declared interface.'); };
    validateLiveTvExtension(kind, value);
    await context.register(kind, Object.freeze(value));
  }
}`;

function sharedOwners(chosen, tunerHostId = 'controlled-host') {
  const records = [], signals = [];
  let retainer;
  const group = { get enabled() { return records.some(record => !record.closed); },
    retain(options) { signals.push(options.signal); return retainer ? retainer(options) : acquire(); } };
  const acquire = (changes = {}) => {
    const record = { closed: false, closes: 0, returns: 0, read: Promise.withResolvers() }; records.push(record);
    const iterator = { next: () => record.read.promise, return() { record.returns++; record.read.resolve({ done: true }); return { done: true }; } };
    const resource = { ...chosen, tunerHostId, sharing: group, stream: { [Symbol.asyncIterator]: () => iterator },
      async close() { if (record.closed) return; record.closed = true; record.closes++; record.read.resolve({ done: true }); await record.closeGate?.promise; }, ...changes };
    record.resource = resource; return resource;
  };
  return { group, records, signals, acquire, retainWith(callback) { retainer = callback; } };
}

test('installed and preinstalled Live TV extensions share SDK signatures, caller signals and untouched native DTOs', { timeout: 30000 }, async t => {
  const calls = [], chosen = source(), request = new AbortController();
  const invoke = (kind, method, args) => {
    calls.push({ kind, method, args });
    if (method === 'getChannelStreamMediaSources' || method === 'getChannelItemMediaInfo') return [chosen];
    if (method === 'getChannelItems') return { Items: [{ Id: 'item', MediaSources: [chosen] }], TotalRecordCount: 1 };
    if (method === 'getChannelImage') return { bytes: Buffer.from('finite image'), mimeType: 'image/png' };
    if (['getChannels', 'discoverDevices', 'getPrograms', 'getLineups', 'getSupportedChannelImages'].includes(method)) return [];
    if (method === 'isEnabledFor') return true;
    return { kind, method };
  };
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke } } });
  const directory = await packageSource(fixture, providers, path.join(fixture.root, 'preinstalled', 'live-tv'));
  await fixture.host.install(directory);
  let bundled;
  try {
    bundled = await PluginHost.open({ directory: path.join(fixture.root, 'bundled-host'), preinstalled: path.dirname(directory), options: { 'live-tv': { invoke } } });
    assert.equal(sdk.validateNativeLiveTvSource, validateNativeLiveTvSource, 'The SDK facade and core use one contract implementation.');
    const operations = [
      ['tuner', 'getChannels', [true]], ['tuner', 'getChannelStreamMediaSources', ['channel']],
      ['tuner', 'discoverDevices', [350]], ['tuner', 'validate', [{ AllowHWTranscoding: true, RecordingPath: '/retained/recordings' }]],
      ['listings', 'getPrograms', [{ Id: 'listings' }, 'channel', '2026-10-21T00:00:00.1234567Z', '2026-10-22T00:00:00.7654321Z']],
      ['listings', 'getChannels', [{ Id: 'listings' }]], ['listings', 'validate', [{ Id: 'listings' }, true, false]],
      ['listings', 'getLineups', [{ Id: 'listings' }, 'US', '90210']],
      ['channel', 'getChannelFeatures', []], ['channel', 'isEnabledFor', ['user']],
      ['channel', 'getChannelItems', [{ FolderId: 'folder', StartIndex: 2, Limit: 3 }]],
      ['channel', 'getChannelImage', ['Primary']], ['channel', 'getSupportedChannelImages', []],
      ['channel', 'getChannelItemMediaInfo', ['item']],
    ];
    for (const host of [fixture.host, bundled]) for (const [kind, method, args] of operations) {
      const extension = host.entries(kind)[0], options = { marker: kind + ':' + method, signal: request.signal };
      assert.equal(Object.getPrototypeOf(extension), null); assert.equal(extension.unmanagedOpen, undefined);
      assert.equal(Object.getOwnPropertyDescriptor(extension, 'unmanagedOpen'), undefined);
      assert.equal(Object.getOwnPropertyDescriptor(extension, method).value, extension[method], 'Introspection cannot recover the raw provider callback.');
      const result = await extension[method](...args, options), actual = calls.at(-1);
      assert.equal(extension.type, 'controlled-' + kind); assert.equal(actual.kind, kind); assert.equal(actual.method, method);
      assert.deepEqual(actual.args.slice(0, -1), args); assert.equal(actual.args.length - 1, liveTvSignalPositions[kind][method]);
      assert.equal(actual.args.at(-1).marker, options.marker); assert.ok(actual.args.at(-1).signal instanceof AbortSignal);
      assert.notEqual(actual.args.at(-1).signal, request.signal); assert.equal(actual.args.at(-1).signal.aborted, false);
      if (method === 'getChannelStreamMediaSources' || method === 'getChannelItemMediaInfo') {
        assert.deepEqual(result, [chosen]); assert.notEqual(result[0].mediaSource, chosen.mediaSource);
        assert.equal(result[0].mediaSource.SupportsTranscoding, true, 'Native constructor defaults are data, not an execution advertisement.');
      }
      if (method === 'getChannelItems') assert.deepEqual(result, { Items: [{ Id: 'item', MediaSources: [chosen] }], TotalRecordCount: 1 });
      if (method === 'getChannelImage') assert.equal(Buffer.from(result.bytes).toString(), 'finite image');
    }
    request.abort(); assert.ok(calls.every(call => call.args.at(-1).signal.aborted));
    const before = calls.length;
    assert.throws(() => fixture.host.entries('tuner')[0].getChannels(false, { signal: request.signal }), { name: 'AbortError' });
    assert.equal(calls.length, before, 'A canceled request must not enter the provider.');
  } finally { await bundled?.close(); }
});

test('Live TV registration rejects missing identities, methods and executable capabilities before admission', { timeout: 30000 }, async t => {
  const fixture = await pluginFixture(t);
  for (const expression of [
    `{ name:'Missing type', getChannels(){} }`,
    `{ type:'partial', name:'Missing methods', getChannels(){} }`,
    `{ type:'recording', name:'Forbidden', getChannels(){},getChannelStream(){},getChannelStreamMediaSources(){},discoverDevices(){},startRecording(){} }`,
    `{ type:'transcoder', name:'Forbidden', getChannels(){},getChannelStream(){},getChannelStreamMediaSources(){},discoverDevices(){},openTranscoder(){} }`,
    `{ type:'capability', name:'Forbidden', getChannels(){},getChannelStream(){},getChannelStreamMediaSources(){},discoverDevices(){},supportsRecording:true }`,
  ]) {
    const directory = await packageSource(fixture, `export async function activate(context){await context.register('tuner', ${expression});}`);
    await assert.rejects(fixture.host.install(directory)); assert.deepEqual(fixture.host.entries('tuner'), []);
    assert.equal(fixture.host.list().some(plugin => plugin.status === 'active'), false);
  }
});

test('caller abort and plugin disable cancel each Live TV kind at its own signal position and drain cleanup', { timeout: 30000 }, async t => {
  const started = [], finishing = [], gates = [];
  t.signal.addEventListener('abort', () => gates.forEach(gate => gate.resolve()), { once: true });
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: async (kind, method, args) => {
    const gate = Promise.withResolvers(); gates.push(gate); started.push({ kind, method, signal: args[liveTvSignalPositions[kind][method]].signal });
    try { await aborting(args[liveTvSignalPositions[kind][method]].signal); }
    finally { await gate.promise; finishing.push(kind); }
  } } } });
  await fixture.host.install(await packageSource(fixture, providers));
  const request = new AbortController(), tuner = fixture.host.entries('tuner')[0];
  try {
  const canceled = tuner.getChannels(true, { signal: request.signal }), canceledRejection = assert.rejects(canceled, { name: 'AbortError' });
  request.abort(); await turn(); assert.deepEqual(finishing, []); gates[0].resolve(); await canceledRejection;
  assert.equal(fixture.host.get('live-tv').status, 'active');
  const work = [tuner.getChannels(false, {}), fixture.host.entries('listings')[0].getPrograms({}, 'channel', 'start', 'end', {}),
    fixture.host.entries('channel')[0].getChannelItems({}, {})];
  const rejected = work.map(value => assert.rejects(value, { name: 'AbortError' }));
  let disabled = false; const disabling = fixture.host.setEnabled('live-tv', false).then(() => { disabled = true; });
  await assert.rejects(aborting(started[1].signal), { name: 'AbortError' });
  await turn(); assert.equal(disabled, false); assert.equal(started.length, 4);
  assert.deepEqual(fixture.host.entries('tuner'), []); assert.deepEqual(fixture.host.entries('listings'), []); assert.deepEqual(fixture.host.entries('channel'), []);
  gates.slice(1).forEach(gate => gate.resolve()); await Promise.all(rejected); await disabling;
  assert.deepEqual(finishing.sort(), ['channel', 'listings', 'tuner', 'tuner']);
  assert.throws(() => tuner.getChannels(false, {}), { status: 503 });
  } finally { request.abort(); gates.forEach(gate => gate.resolve()); }
});

test('encoded profiles are rejected for source advertisement and before opening the provider', { timeout: 30000 }, async t => {
  let advertised, openings = 0;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: (_kind, method) => {
    if (method === 'getChannelStreamMediaSources' || method === 'getChannelItemMediaInfo') return [advertised];
    if (method === 'getChannelItems') return { Items: [{ Id: 'channel-item', MediaSources: [advertised] }] };
    if (method === 'getChannelStream') { openings++; return { ...advertised, tunerHostId: null, close() {} }; }
  } } } });
  await fixture.host.install(await packageSource(fixture, providers));
  const tuner = fixture.host.entries('tuner')[0], channel = fixture.host.entries('channel')[0];
  for (const invalid of [
    { ...source(), mode: 'transcoded' }, { ...source(), profile: 'heavy' }, { ...source(), profile: 'mobile' },
    { ...source(), profile: 'internet720' }, source({ Id: 'heavy_0123_4567' }), source({ Id: 'mobile_0123_4567' }),
    source({ Id: 'internet540_0123_4567' }), source({ Path: 'http://127.0.0.1/auto/v1?transcode=internet360' }),
    source({ EncoderPath: '/controlled/encoder' }), source({ TranscodingUrl: '/encoded-output' }),
  ]) {
    advertised = invalid;
    await assert.rejects(tuner.getChannelStreamMediaSources('channel', {}), { code: 'not-supported' });
    await assert.rejects(channel.getChannelItemMediaInfo('item', {}), { code: 'not-supported' });
    await assert.rejects(channel.getChannelItems({}, {}), { code: 'not-supported' });
    assert.throws(() => tuner.getChannelStream('channel', invalid.mediaSource.Id, [], { source: invalid }), { code: 'not-supported' });
  }
  assert.equal(openings, 0, 'Rejected profiles must not reach a tuner or an external encoder.');
  advertised = source();
  const lease = await tuner.getChannelStream('channel', 'different', [], { source: advertised });
  assert.equal(lease.mediaSource.Id, advertised.mediaSource.Id); assert.equal(openings, 1); await lease.close();
});

test('original stream keys pass unchanged independently of the selected native source identity', { timeout: 30000 }, async t => {
  let delayed;
  const chosen = source(), originals = [], fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: (_kind, method, args) => {
    assert.equal(method, 'getChannelStream'); originals.push(args[1]); return delayed?.promise ?? { ...chosen, tunerHostId: 'controlled-host', close() {} };
  } } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  for (const original of [null, '', ' \t', 'different-original', 'heavy_opaque-key']) {
    const lease = await tuner.getChannelStream('channel', original, [], { source: chosen });
    assert.equal(originals.at(-1), original); assert.equal(lease.mediaSource.Id, chosen.mediaSource.Id); await lease.close();
  }
  assert.throws(() => tuner.getChannelStream('channel', 42, [], { source: chosen }), TypeError); assert.equal(originals.length, 5);
  delayed = Promise.withResolvers(); const selection = source(); let closes = 0, returns = 0;
  const pending = tuner.getChannelStream('channel', null, [], { source: selection });
  const rejected = assert.rejects(pending, /different source identity/);
  selection.mediaSource.Id = 'replacement-native';
  delayed.resolve({ ...selection, tunerHostId: 'controlled-host', stream: { [Symbol.asyncIterator]() { return { next: async () => ({ done: true }),
    return() { returns++; return { done: true }; } }; } }, close() { closes++; } });
  await rejected; assert.equal(closes, 1); assert.equal(returns, 1, 'Mutating a pending selection cannot replace its admitted source identity.');
});

test('opened leases preserve nullable host identities and reject missing or invalid host types after owning cleanup', { timeout: 30000 }, async t => {
  const chosen = source(); let identity = null, closes = 0, current, invoke;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => invoke ? invoke() : current = { ...chosen, tunerHostId: identity, close() { closes++; } } } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  for (identity of [null, '', 'Mixed-Host']) {
    const lease = await tuner.getChannelStream('channel', null, [], { source: chosen });
    assert.equal(lease.tunerHostId, identity); assert.equal(Object.isFrozen(lease), true);
    current.tunerHostId = 'mutated-after-admission'; assert.equal(lease.tunerHostId, identity); await lease.close();
  }
  assert.equal(closes, 3);
  for (identity of [undefined, 42, {}, false]) {
    await assert.rejects(tuner.getChannelStream('channel', null, [], { source: chosen }), /nullable tuner host identity/);
  }
  assert.equal(closes, 7);
  for (const identity of [null, '']) {
    const owners = sharedOwners(chosen, identity);
    invoke = () => owners.acquire();
    const parent = await tuner.getChannelStream('channel', null, [], { source: chosen }), child = await parent.sharing.retain({});
    assert.equal(parent.tunerHostId, identity); assert.equal(child.tunerHostId, identity);
    invoke = () => owners.acquire({ tunerHostId: 'changed-host' });
    await assert.rejects(tuner.getChannelStream('channel', null, [], { source: chosen }), /cannot change source or tuner host identity/);
    assert.equal(owners.records.at(-1).closes, 1); assert.equal(owners.records[0].closed, false); assert.equal(owners.records[1].closed, false);
    await parent.close(); await child.close();
  }
});

test('idle and reading live leases close once, return iterators, reject future reads and drain pending bytes on disable', { timeout: 30000 }, async t => {
  const started = Promise.withResolvers(), read = Promise.withResolvers(), closeGate = Promise.withResolvers();
  const release = () => { read.resolve({ done: true }); closeGate.resolve(); };
  t.signal.addEventListener('abort', release, { once: true });
  let closes = 0, returned = 0, moduleClosed = 0, capturedSignal;
  const chosen = source();
  const fixture = await pluginFixture(t, { options: { 'live-tv': { closed: () => { moduleClosed++; }, invoke: (_kind, method, args) => {
    assert.equal(method, 'getChannelStream'); assert.equal(args[0], 'channel'); assert.equal(args[1], chosen.mediaSource.Id); assert.deepEqual(args[2], []);
    assert.equal(args[3].source, chosen); assert.ok(args[3].signal instanceof AbortSignal);
    capturedSignal = args[3].signal;
    return { ...chosen, tunerHostId: 'controlled-host', stream: { [Symbol.asyncIterator]() { return { next() { started.resolve(); return read.promise; }, return() { returned++; return { done: true }; } }; } },
      async close() { closes++; read.resolve({ done: false, value: Buffer.from('late byte') }); await closeGate.promise; } };
  } } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  try {
  const idle = await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  const reading = await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  const next = reading.stream.next(), rejected = assert.rejects(next, error => error.status === 503 || error.name === 'AbortError'); await started.promise;
  let disabled = false; const disabling = fixture.host.setEnabled('live-tv', false).then(() => { disabled = true; });
  await assert.rejects(aborting(capturedSignal), { name: 'AbortError' });
  await turn(); assert.equal(disabled, false); assert.equal(closes, 2); assert.equal(returned, 2);
  closeGate.resolve(); await rejected; await disabling;
  await Promise.all([idle.close(), idle.close(), reading.close()]); assert.equal(closes, 2); assert.equal(moduleClosed, 1);
  await assert.rejects(idle.stream.next(), { status: 503 }); await assert.rejects(reading.stream.next(), { status: 503 });
  assert.equal(idle.mediaSource.SupportsTranscoding, true); assert.notEqual(idle.mediaSource, chosen.mediaSource);
  } finally { release(); }
});

test('a live lease acquired after disable is closed and never delivered outside the host', { timeout: 30000 }, async t => {
  const acquired = Promise.withResolvers(), closing = Promise.withResolvers(), closed = Promise.withResolvers(); let closeCount = 0;
  const chosen = source();
  const release = () => { acquired.resolve({ ...chosen, tunerHostId: 'controlled-host', close() {} }); closed.resolve(); };
  t.signal.addEventListener('abort', release, { once: true });
  let capturedSignal;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: (_kind, _method, args) => { capturedSignal = args[3].signal; return acquired.promise; } } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  try {
  const work = tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  const rejected = assert.rejects(work, { status: 503 }); let disabled = false;
  const disabling = fixture.host.setEnabled('live-tv', false).then(() => { disabled = true; });
  await assert.rejects(aborting(capturedSignal), { name: 'AbortError' }); await turn(); assert.equal(disabled, false);
  acquired.resolve({ ...chosen, tunerHostId: 'controlled-host', async close() { closeCount++; closing.resolve(); await closed.promise; } });
  await closing.promise; assert.equal(disabled, false); closed.resolve(); await rejected; await disabling; assert.equal(closeCount, 1);
  } finally { release(); }
});

test('live byte completion, consumer break and invalid chunks release their upstream ownership', { timeout: 30000 }, async t => {
  const chosen = source(); let phase = 'complete', closes = 0, returns = 0;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => ({ ...chosen, tunerHostId: 'controlled-host',
    stream: { [Symbol.asyncIterator]() { let offset = 0; return {
      next() { return Promise.resolve(++offset === 1 ? { done: false, value: phase === 'invalid' ? 'not bytes' : Buffer.from('original bytes') } : { done: true }); },
      return() { returns++; return { done: true }; },
    }; } }, close() { closes++; },
  }) } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  for (phase of ['complete', 'break', 'invalid']) {
    const before = closes, owner = await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
    if (phase === 'invalid') await assert.rejects(owner.stream.next(), /must yield bytes/);
    else {
      const chunks = []; for await (const bytes of owner.stream) { chunks.push(bytes); if (phase === 'break') break; }
      assert.equal(Buffer.concat(chunks).toString(), 'original bytes');
    }
    await owner.close(); assert.equal(closes, before + 1);
  }
  assert.equal(closes, 3); assert.equal(returns, 3);
});

test('caller cancellation closes a late or already returned lease without disabling its plugin', { timeout: 30000 }, async t => {
  const late = Promise.withResolvers(), chosen = source(); let calls = 0, closed = 0;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => ++calls === 1 ? late.promise : { ...chosen, tunerHostId: 'controlled-host', close() { closed++; } } } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0], request = new AbortController();
  const work = tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen, signal: request.signal });
  const rejected = assert.rejects(work, { name: 'AbortError' }); request.abort(); late.resolve({ ...chosen, tunerHostId: 'controlled-host', close() { closed++; } }); await rejected;
  assert.equal(closed, 1); assert.equal(fixture.host.get('live-tv').status, 'active');
  const activeRequest = new AbortController(), owner = await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen, signal: activeRequest.signal });
  activeRequest.abort(); await owner.close(); assert.equal(closed, 2); assert.equal(fixture.host.get('live-tv').status, 'active');
});

test('invalid opened sources are closed before rejection and a close failure still drains other owners', { timeout: 30000 }, async t => {
  const chosen = source(); let invalid = true, closed = 0, moduleClosed = 0, first = true;
  const fixture = await pluginFixture(t, { options: { 'live-tv': { closed: () => { moduleClosed++; }, invoke: () => ({
    ...chosen, tunerHostId: 'controlled-host', ...(invalid ? { profile: 'heavy' } : {}), close() { closed++; if (!invalid && first) { first = false; throw new Error('Controlled close failure.'); } },
  }) } } });
  await fixture.host.install(await packageSource(fixture, providers)); const tuner = fixture.host.entries('tuner')[0];
  await assert.rejects(tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen }), { code: 'not-supported' }); assert.equal(closed, 1);
  invalid = false;
  await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  await assert.rejects(fixture.host.setEnabled('live-tv', false), /Plugin shutdown failed/);
  assert.equal(closed, 3); assert.equal(moduleClosed, 1); assert.equal(fixture.host.get('live-tv').status, 'active', 'The failed change restores the previous admitted release.');
  assert.throws(() => tuner.getChannels(false, {}), { status: 503 });
});

test('shared input capabilities retain distinct owned consumers independently of the first caller', { timeout: 30000 }, async t => {
  const chosen = source(), owners = sharedOwners(chosen), firstRequest = new AbortController();
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => owners.acquire() } } });
  await fixture.host.install(await packageSource(fixture, providers));
  const tuner = fixture.host.entries('tuner')[0], first = await tuner.getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen, signal: firstRequest.signal });
  const child = await first.sharing.retain({}); assert.notEqual(first.stream, child.stream); assert.equal(first.sharing, child.sharing);
  assert.equal(first.tunerHostId, 'controlled-host'); assert.equal(child.tunerHostId, first.tunerHostId); assert.equal(Object.isFrozen(child), true);
  assert.notEqual(first.sharing, owners.group); assert.deepEqual(Object.keys(first.sharing).sort(), ['enabled', 'retain']);
  const canceled = new AbortController(); canceled.abort();
  assert.throws(() => first.sharing.retain({ signal: canceled.signal }), { name: 'AbortError' }); assert.equal(owners.signals.length, 1);
  firstRequest.abort(); await first.close(); assert.equal(owners.records[0].closes, 1); assert.equal(owners.records[1].closed, false);
  assert.equal(owners.signals[0].aborted, false, 'The retained consumer does not inherit the first caller signal.');
  const thirdRequest = new AbortController(), third = await first.sharing.retain({ signal: thirdRequest.signal });
  assert.equal(third.sharing, child.sharing); assert.equal(first.sharing.enabled, true);
  const left = child.stream.next(), right = third.stream.next();
  owners.records[1].read.resolve({ done: false, value: Buffer.from('child bytes') });
  owners.records[2].read.resolve({ done: false, value: Buffer.from('third bytes') });
  assert.equal((await left).value.toString(), 'child bytes'); assert.equal((await right).value.toString(), 'third bytes');
  thirdRequest.abort(); await third.close(); assert.equal(child.sharing.enabled, true); assert.equal(owners.records[1].closed, false);
  await child.close(); assert.equal(first.sharing.enabled, false);
  await assert.rejects(first.sharing.retain({}), { status: 503 });
  assert.deepEqual(owners.records.map(record => [record.closes, record.returns]), [[1, 1], [1, 1], [1, 1]]);
  await fixture.host.setEnabled('live-tv', false); assert.throws(() => first.sharing.retain({}), { status: 503 });
});

test('invalid and canceled retained resources close their own iterator without harming existing consumers', { timeout: 30000 }, async t => {
  const chosen = source(), owners = sharedOwners(chosen);
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => owners.acquire() } } });
  await fixture.host.install(await packageSource(fixture, providers));
  const parent = await fixture.host.entries('tuner')[0].getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  for (const changes of [ { mediaSource: { ...chosen.mediaSource, Id: 'different' } }, { profile: 'heavy' },
    { tunerHostId: 'different-host' }, { tunerHostId: 'CONTROLLED-HOST' }, { tunerHostId: null }, { tunerHostId: undefined },
    { sharing: { enabled: true, retain() {} } }, { sharing: { enabled: 'invalid', retain() {} } } ]) {
    owners.retainWith(() => owners.acquire(changes)); await assert.rejects(parent.sharing.retain({}));
    const record = owners.records.at(-1); assert.equal(record.closes, 1); assert.equal(record.returns, 1);
    assert.equal(owners.records[0].closed, false); assert.equal(parent.sharing.enabled, true);
  }
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(), request = new AbortController(); let returned;
  const release = () => delayed.resolve(returned ??= owners.acquire()); t.signal.addEventListener('abort', release, { once: true });
  owners.retainWith(() => { started.resolve(); return delayed.promise; });
  try {
    const pending = parent.sharing.retain({ signal: request.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise; request.abort(); release(); await rejected;
    assert.equal(owners.records.at(-1).closes, 1); assert.equal(owners.records.at(-1).returns, 1);
    assert.equal(owners.records[0].closed, false); assert.equal(parent.sharing.enabled, true);
  } finally { release(); }
  await parent.close(); assert.equal(parent.sharing.enabled, false);
});

test('disable revokes a shared capability and drains a late retained consumer before completing', { timeout: 30000 }, async t => {
  const chosen = source(), owners = sharedOwners(chosen), delayed = Promise.withResolvers(), started = Promise.withResolvers();
  const closeEntered = Promise.withResolvers(), closeGate = Promise.withResolvers(); let returned;
  const release = () => { delayed.resolve(returned ??= owners.acquire()); closeGate.resolve(); };
  t.signal.addEventListener('abort', release, { once: true });
  const fixture = await pluginFixture(t, { options: { 'live-tv': { invoke: () => owners.acquire() } } });
  await fixture.host.install(await packageSource(fixture, providers));
  const parent = await fixture.host.entries('tuner')[0].getChannelStream('channel', chosen.mediaSource.Id, [], { source: chosen });
  owners.retainWith(() => { started.resolve(); return delayed.promise; });
  try {
    const pending = parent.sharing.retain({}), rejected = assert.rejects(pending, error => error.status === 503 || error.name === 'AbortError'); await started.promise;
    let disabled = false; const disabling = fixture.host.setEnabled('live-tv', false).then(() => { disabled = true; });
    await assert.rejects(aborting(owners.signals[0]), { name: 'AbortError' });
    await turn(); assert.equal(parent.sharing.enabled, false); assert.equal(disabled, false);
    returned = owners.acquire(); const record = owners.records.at(-1); record.closeGate = closeGate;
    const originalClose = returned.close; returned.close = async () => { closeEntered.resolve(); await originalClose(); };
    delayed.resolve(returned); await closeEntered.promise; await turn(); assert.equal(disabled, false); assert.equal(record.returns, 1);
    closeGate.resolve(); await rejected; await disabling; assert.equal(record.closes, 1); assert.equal(parent.sharing.enabled, false);
    assert.throws(() => parent.sharing.retain({}), { status: 503 });
  } finally { release(); }
});
