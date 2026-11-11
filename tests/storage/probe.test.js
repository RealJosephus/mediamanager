import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setImmediate as immediate } from 'node:timers/promises';
import { StorageRegistry, VirtualFileSystem, ProbeReadBridge, buildHttpProbeArguments, probeRaw } from '../../src/storage/index.js';
import { buildRemoteProbeArguments, probeRemoteRaw } from '../../src/storage/ffprobe.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageError } from '../../src/storage/errors.js';

async function fixture(t, bytes = Buffer.from('0123456789')) {
  const registry = new StorageRegistry();
  registry.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('test', 'fixture', {});
  await adapter.write('/media', bytes);
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/network', instanceId: 'test', capabilities: {} });
  const bridge = new ProbeReadBridge(vfs);
  t.after(async () => { await bridge.close(); await registry.close(); });
  return { adapter, bridge };
}

test('private probe leases support HEAD, exact seeks, conditional versions and revocation', async (t) => {
  const { adapter, bridge } = await fixture(t);
  const lease = await bridge.lease('/network/media');
  assert.equal(new URL(lease.url).hostname, '127.0.0.1');
  assert.match(new URL(lease.url).pathname, /^\/[a-f0-9]{64}$/u);
  assert.equal(lease.consistency, 'version-precondition');
  const head = await fetch(lease.url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, expected] of [['bytes=2-4', '234'], ['bytes=-3', '789'], ['bytes=7-', '789']]) {
    const result = await fetch(lease.url, { headers: { Range: range } });
    assert.equal(result.status, 206); assert.equal(await result.text(), expected);
  }
  const outside = await fetch(lease.url, { headers: { Range: 'bytes=10-' } });
  assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), 'bytes */10');
  assert.equal((await fetch(lease.url, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${lease.url}?path=/another`)).status, 404);
  await adapter.write('/media', Buffer.from('changed'));
  assert.equal((await fetch(lease.url)).status, 412);
  await lease.release();
  assert.equal((await fetch(lease.url)).status, 404);
});

test('probe cancellation revokes leases and new leases remain independent', async (t) => {
  const { bridge } = await fixture(t);
  const controller = new AbortController();
  const first = await bridge.lease('/network/media', { signal: controller.signal });
  const second = await bridge.lease('/network/media');
  controller.abort();
  assert.equal((await fetch(first.url)).status, 404);
  assert.equal(await (await fetch(second.url)).text(), '0123456789');
  await second.release();
});

test('probe leases drain admitted Local stats before shutdown and reject late publication', { timeout: 30000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const reports = await fs.mkdtemp(path.join(output, 'probe-lease-ownership-'));
  for (const stage of ['primary', 'related']) for (const stop of ['bridge', 'caller']) await t.test(`${stage}/${stop}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-lease-source-'));
    const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), bridge = new ProbeReadBridge(vfs);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), controller = new AbortController();
    const reason = Object.freeze(new Error('The subtitle probe caller stopped.'));
    const main = '/disk/paired.idx', related = '/disk/paired.sub';
    const indexBytes = Buffer.from('real index bytes'), subtitleBytes = Buffer.from('real subtitle bytes');
    const held = stage === 'primary' ? main : related;
    const heldFile = path.join(root, path.posix.basename(held));
    let descriptor, admittedSignal, descriptorRead, acquisition, recovery, closing, report;
    t.after(async () => {
      resume.resolve();
      const settled = await acquisition;
      try { await settled?.value?.release(); }
      finally {
        try {
          const results = await Promise.allSettled([bridge.close(), recovery?.close()]);
          const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (failures.length) throw new AggregateError(failures, 'Probe fixtures did not close.');
        }
        finally {
          try { await registry.close(); }
          finally {
            assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true });
          }
        }
      }
      if (report) await fs.writeFile(path.join(reports, `${stage}-${stop}.json`), JSON.stringify(report) + '\n');
    });
    await fs.writeFile(path.join(root, 'paired.idx'), indexBytes); await fs.writeFile(path.join(root, 'paired.sub'), subtitleBytes);
    registry.registerType('local', configuration => LocalAdapter.open(configuration));
    await registry.createInstance('probe', 'local', { root });
    vfs.mount({ path: '/disk', instanceId: 'probe', capabilities: {} });
    const control = await bridge.lease(main);
    assert.deepEqual(Buffer.from(await (await fetch(control.url)).arrayBuffer()), indexBytes);
    const stat = vfs.stat.bind(vfs);
    vfs.stat = async (filename, options) => {
      const info = await stat(filename, options);
      if (filename !== held) return info;
      admittedSignal = options.signal;
      descriptor = await fs.open(heldFile, 'r');
      entered.resolve();
      try { await resume.promise; descriptorRead = await descriptor.read(Buffer.alloc(1), 0, 1, 0); }
      finally { await descriptor.close(); }
      return info;
    };
    acquisition = bridge.lease(main, { relatedPaths: [related], signal: stop === 'caller' ? controller.signal : undefined })
      .then(value => ({ value }), error => ({ error }));
    await entered.promise;
    assert.notEqual(descriptor.fd, -1);
    if (stop === 'bridge') {
      closing = bridge.close(); assert.equal(bridge.close(), closing);
      await assert.rejects(bridge.lease(main), { code: 'closed' });
    } else controller.abort(reason);
    assert.equal(admittedSignal?.aborted, true);
    if (stop === 'bridge') assert.equal(admittedSignal.reason.code, 'closed');
    else assert.equal(admittedSignal.reason, reason);
    let settled = false, closed = false;
    void acquisition.then(() => { settled = true; });
    const markClosed = () => { closed = true; };
    void closing?.then(markClosed, markClosed);
    await immediate(); assert.equal(settled, false); assert.equal(closed, false);
    assert.notEqual(descriptor.fd, -1);
    resume.resolve();
    const failure = (await acquisition).error;
    assert.equal(failure.code, stop === 'bridge' ? 'closed' : 'cancelled');
    if (stop === 'caller') assert.equal(failure.cause, reason);
    assert.equal(descriptorRead.bytesRead, 1); assert.equal(descriptor.fd, -1);
    vfs.stat = stat;
    if (stop === 'bridge') {
      await closing; await control.release();
      const listener = net.createServer();
      await new Promise((resolve, reject) => listener.once('error', reject).listen(Number(new URL(control.url).port), '127.0.0.1', resolve));
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      recovery = new ProbeReadBridge(vfs);
    } else {
      assert.deepEqual(Buffer.from(await (await fetch(control.url)).arrayBuffer()), indexBytes);
      await control.release();
    }
    const lease = await (recovery ?? bridge).lease(main, { relatedPaths: [related] });
    try {
      assert.deepEqual(Buffer.from(await (await fetch(lease.url)).arrayBuffer()), indexBytes);
      assert.deepEqual(Buffer.from(await (await fetch(new URL('paired.sub', lease.url))).arrayBuffer()), subtitleBytes);
    } finally { await lease.release(); }
    report = { stage, stop, code: failure.code, signalAborted: admittedSignal.aborted,
      descriptor: descriptor.fd, bytesRead: descriptorRead.bytesRead, listenerRebound: stop === 'bridge', recoveredFiles: 2 };
  });
});

test('probe HTTP closes actual Local reads and returns complete errors when diagnostics are unavailable', { timeout: 30000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const reports = await fs.mkdtemp(path.join(output, 'probe-http-failure-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-http-source-'));
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), bridge = new ProbeReadBridge(vfs);
  const bytes = Buffer.from('real bytes from the probe source'), filename = '/disk/sample';
  const observations = [];
  t.after(async () => {
    try { await bridge.close(); }
    finally {
      try { await registry.close(); }
      finally { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true }); }
    }
    await fs.writeFile(path.join(reports, 'observations.json'), JSON.stringify(observations) + '\n');
  });
  await fs.writeFile(path.join(root, 'sample'), bytes);
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('probe', 'local', { root });
  vfs.mount({ path: '/disk', instanceId: 'probe', capabilities: {} });
  const lease = await bridge.lease(filename), openRead = vfs.openRead.bind(vfs);
  const unreadable = () => { throw new Error('The failure diagnostic is unavailable.'); };
  const cases = [
    { name: 'undefined', reason: undefined }, { name: 'null', reason: null }, { name: 'false', reason: false },
    { name: 'code-getter', reason: Object.freeze({ get code() { return unreadable(); } }) },
    { name: 'unknown-code', reason: { code: 'toString' } },
    { name: 'known-status', reason: new StorageError('not-found', 'The probe source is missing.'), status: 404 },
    { name: 'range-length', reason: new StorageError('range-not-satisfiable', 'The range cannot be supplied.', { totalSize: BigInt(bytes.length) }),
      status: 416, range: `bytes */${bytes.length}` },
    { name: 'range-details-getter', reason: { code: 'range-not-satisfiable', get details() { return unreadable(); } }, status: 416 },
    { name: 'range-length-getter', reason: { code: 'range-not-satisfiable', details: { get totalSize() { return unreadable(); } } }, status: 416 },
    { name: 'range-length-coercion', reason: { code: 'range-not-satisfiable', details: { totalSize: { toString: unreadable } } }, status: 416 },
  ];
  try {
    for (const sample of cases) await t.test(sample.name, async () => {
      let closed = false;
      vfs.openRead = async (...args) => {
        const handle = await openRead(...args), chunks = [];
        try { for await (const chunk of handle.stream) chunks.push(chunk); }
        finally { await handle.close(); closed = true; }
        assert.deepEqual(Buffer.concat(chunks), bytes);
        throw sample.reason;
      };
      try {
        const response = await fetch(lease.url, { signal: t.signal });
        assert.equal(response.status, sample.status ?? 502);
        assert.equal(response.headers.get('content-range'), sample.range ?? null);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
        assert.equal(closed, true);
        observations.push({ name: sample.name, status: response.status, range: response.headers.get('content-range'), localReadClosed: closed });
      } finally { vfs.openRead = openRead; }
      const recovered = await fetch(lease.url, { signal: t.signal });
      assert.equal(recovered.status, 200);
      assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), bytes);
    });
  } finally { await lease.release(); }
});

test('HTTP probe arguments follow baseline precedence without media generation flags', () => {
  const url = `http://127.0.0.1:1234/${'a'.repeat(64)}`;
  assert.deepEqual(buildHttpProbeArguments(url, { analyzeDurationMs: 1234, configuredAnalyzeDuration: '2M', configuredProbeSize: '1G',
    userAgent: 'Test "Agent"', extractChapters: true, threads: 2 }),
  ['-analyzeduration', '1234000', '-probesize', '1G', '-user_agent', 'Test "Agent"', '-i', url,
    '-threads', '2', '-v', 'warning', '-print_format', 'json', '-show_streams', '-show_chapters', '-show_format']);
  const fallback = buildHttpProbeArguments(url, { configuredAnalyzeDuration: '200M' });
  assert.equal(fallback[1], '200M');
  assert.equal(fallback.includes('-show_frames'), false);
  assert.equal(fallback.includes('-only_first_vframe'), false);
  assert.throws(() => buildHttpProbeArguments('file:///production/movie.mkv'), TypeError);
  assert.throws(() => buildHttpProbeArguments('http://remote.invalid/movie'), TypeError);
  assert.throws(() => buildHttpProbeArguments(url, { configuredProbeSize: '1M -show_frames' }), TypeError);
});

test('remote probe arguments preserve the four shortcut protocols and RTSP transport options', () => {
  for (const url of ['HTTP://media.invalid/audio%20track.flac?token=fixture',
    'https://media.invalid/audio.flac', 'rtsp://media.invalid:8554/audio', 'rtp://239.0.0.1:5004']) {
    const protocol = new URL(url).protocol;
    assert.deepEqual(buildRemoteProbeArguments(url, {
      analyzeDurationMs: 1234, configuredAnalyzeDuration: '2M', configuredProbeSize: '1G',
      userAgent: 'Test "Agent"', extractChapters: true, threads: 2
    }), ['-analyzeduration', '1234000', '-probesize', '1G', '-user_agent', 'Test "Agent"',
      ...(protocol === 'rtsp:' ? ['-rtsp_transport', 'tcp+udp', '-rtsp_flags', 'prefer_tcp'] : []),
      '-i', url, '-threads', '2', '-v', 'warning', '-print_format', 'json',
      '-show_streams', '-show_chapters', '-show_format']);
    const fallback = buildRemoteProbeArguments(url, { configuredAnalyzeDuration: '200M' });
    assert.equal(fallback[1], '200M');
    assert.equal(fallback.includes('-show_frames'), false);
    assert.equal(fallback.includes('-only_first_vframe'), false);
    assert.throws(() => buildHttpProbeArguments(url), TypeError,
      'remote input does not become a private bridge lease');
  }
});

test('remote probing rejects local files and other protocols before launching a process', async () => {
  for (const url of ['file:///production/audio.flac', 'C:\\Media\\audio.flac', '/media/audio.flac',
    'ftp://media.invalid/audio.flac', 'udp://239.0.0.1:5004',
    'concat:http://media.invalid/audio.flac|file:///production/audio.flac', 'https://']) {
    assert.throws(() => buildRemoteProbeArguments(url), TypeError, url);
    await assert.rejects(probeRemoteRaw(url, { executable: 'mediamanager-nonexistent-ffprobe-test' }), TypeError, url);
  }
  assert.throws(() => buildRemoteProbeArguments('https://media.invalid/audio.flac', {
    configuredProbeSize: '1M -show_frames'
  }), TypeError);
  assert.throws(() => buildRemoteProbeArguments('https://media.invalid/audio.flac', {
    userAgent: 'Agent\r\nUnexpected: header'
  }), TypeError);
  await assert.rejects(probeRemoteRaw('https://media.invalid/audio.flac', {
    signal: AbortSignal.abort(), executable: 'mediamanager-nonexistent-ffprobe-test'
  }), { code: 'cancelled' });
});

test('the VFS probe entry point rejects non-lease sources and still releases the lease', async () => {
  for (const url of ['file:///production/audio.flac', 'https://media.invalid/audio.flac',
    'http://127.0.0.1:1234/not-a-lease']) {
    let released = false;
    const bridge = { async lease() {
      return { url, consistency: 'version-precondition', async release() { released = true; } };
    } };
    await assert.rejects(probeRaw(bridge, '/network/media', {
      executable: 'mediamanager-nonexistent-ffprobe-test'
    }), TypeError);
    assert.equal(released, true);
  }
});

function waveFixture() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

const available = spawnSync(validationExecutable('ffprobe'), ['-version'], { windowsHide: true, encoding: 'utf8' });
test('installed ffprobe probes an isolated in-memory WAV over the VFS bridge', { skip: available.error ? 'ffprobe is unavailable' : false }, async (t) => {
  const { bridge } = await fixture(t, waveFixture());
  const result = await probeRaw(bridge, '/network/media', { executable: validationExecutable('ffprobe'), extractChapters: true });
  assert.equal(result.raw.streams[0].codec_name, 'pcm_s16le');
  assert.equal(result.raw.streams[0].sample_rate, '8000');
  assert.equal(result.raw.streams[0].channels, 1);
  assert.equal(result.raw.format.format_name, 'wav');
  assert.equal(result.raw.format.duration, '0.100000');
  assert.equal(result.sourceConsistency, 'version-precondition');
  assert.equal(result.exitCode, 0);
  assert.equal((await fetch(result.raw.format.filename)).status, 404);
});

test('missing ffprobe executables fail and release their leases', async (t) => {
  const { bridge } = await fixture(t);
  await assert.rejects(probeRaw(bridge, '/network/media', { executable: 'mediamanager-nonexistent-ffprobe-test' }), { code: 'unavailable' });
});

test('actual Local reads retain exact lengths through the probe bridge and ffprobe', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-probe-length-'));
  const registry = new StorageRegistry();
  const vfs = new VirtualFileSystem(registry), bridge = new ProbeReadBridge(vfs);
  t.after(async () => {
    try { await bridge.close(); } finally {
      try { await registry.close(); } finally {
        assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true });
      }
    }
  });
  const bytes = waveFixture();
  await fs.writeFile(path.join(root, 'media.wav'), bytes); await fs.writeFile(path.join(root, 'empty'), Buffer.alloc(0));
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('disk', 'local', { root });
  vfs.mount({ path: '/disk', instanceId: 'disk', capabilities: {} });
  const lease = await bridge.lease('/disk/media.wav');
  for (const [range, start, end] of [[undefined, 0, bytes.length - 1], ['bytes=2-4', 2, 4],
    ['bytes=-3', bytes.length - 3, bytes.length - 1]]) {
    const response = await fetch(lease.url, { headers: range ? { Range: range } : {} });
    assert.equal(response.status, range ? 206 : 200);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('content-range'), range ? `bytes ${start}-${end}/${bytes.length}` : null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const head = await fetch(lease.url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  await lease.release();
  const empty = await bridge.lease('/disk/empty');
  const emptyResponse = await fetch(empty.url);
  assert.equal(emptyResponse.status, 200); assert.equal(emptyResponse.headers.get('content-length'), '0');
  assert.equal((await emptyResponse.arrayBuffer()).byteLength, 0); await empty.release();
  const responseHandle = await vfs.openResponse('/disk/media.wav', { rangeHeader: 'bytes=0-3' });
  try { assert.equal(responseHandle.headers['content-length'], '4'); }
  finally { await responseHandle.close(); }
  const result = await probeRaw(bridge, '/disk/media.wav', { executable: validationExecutable('ffprobe') });
  assert.equal(result.exitCode, 0); assert.equal(result.raw.streams[0].codec_name, 'pcm_s16le');
  assert.equal(result.raw.format.duration, '0.100000');
  assert.equal((await fetch(result.raw.format.filename)).status, 404);
});

test('probe responses omit unknown lengths instead of serializing null or undefined', async t => {
  const { adapter, bridge } = await fixture(t);
  const openRead = adapter.openRead.bind(adapter), stat = adapter.stat.bind(adapter);
  for (const unknown of [undefined, null]) {
    adapter.openRead = async (...args) => ({ ...await openRead(...args), contentLength: unknown });
    adapter.stat = async (...args) => ({ ...await stat(...args), size: unknown });
    const lease = await bridge.lease('/network/media');
    const head = await fetch(lease.url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), null);
    const response = await fetch(lease.url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), '0123456789'); await lease.release();
  }
});
