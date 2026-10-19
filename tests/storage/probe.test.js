import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { StorageRegistry, VirtualFileSystem, ProbeReadBridge, buildHttpProbeArguments, probeRaw } from '../../src/storage/index.js';
import { buildRemoteProbeArguments, probeRemoteRaw } from '../../src/storage/ffprobe.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

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
  const result = await probeRaw(bridge, '/network/media', { extractChapters: true });
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
