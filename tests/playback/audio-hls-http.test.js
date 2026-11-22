import { createPlaybackState } from './runtime-state.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { sourceUriPath } from '../../src/storage/uri.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { HttpAdapter } from '../../plugins/http/adapter.js';
import { HlsService } from '../../src/playback/hls.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/audio-hls-reference.json' with { type: 'json' };
import { playbackTransportSummary, projectHlsRequestIdentities } from '../helpers/playback-transport-projection.js';
import { startHttpSource } from '../storage/helpers/http-source.js';



import library from '../library/fixtures/reference-media.json' with { type: 'json' };

const id = '88888888888888888888888888888888';
const headersOf = response => ({ status: response.status, headers: Object.fromEntries(['content-type', 'content-length', 'accept-ranges', 'expires', 'cache-control', 'etag', 'last-modified'].map(key => [key, response.headers.get(key)])) });
const projection = probe => ({ streams: probe.streams?.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => value[key] != null).map(key => [key, value[key]]))),
  packets: probe.packets?.map(value => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags'].filter(key => value[key] != null).map(key => [key, value[key]]))) });

test('sequential audio fMP4 requests preserve copied packets and seek when the source supports it', { timeout: 60000 }, async t => {
  const temporaryRoot = await realpath(tmpdir()), root = await mkdtemp(path.join(temporaryRoot, 'mediamanager-audio-clips-'));
  const input = path.join(root, 'source.mka'), cache = path.join(root, 'cache');
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry);
  const configuration = defaultConfiguration('encoding'), processes = [], errors = [];
  const mediaEncoder = await createTestMediaEncoder(t, { configuration });
  const hls = new HlsService({ vfs, mediaEncoder, getCacheDirectory: () => cache, getEncodingOptions: () => configuration,
    onProcess: ({ args }) => processes.push(args), onError: error => errors.push(error) });
  const inputBytes = Buffer.from(reference.media, 'base64');
  let pending, origin;
  const server = createServer((request, response) => {
    const [segment, backend] = request.url.slice(1).split('/'), index = Number(segment);
    const inputPath = backend ? '/http' + sourceUriPath(`${origin.origin}/${backend}`) : '/source.mka';
    pending = hls.segment(reference.source, inputPath, { MediaType: 'Audio', AudioCodec: 'copy', SegmentContainer: 'mp4',
      SegmentLength: 3, PlaySessionId: backend ?? 'audio-clips', DeviceId: 'audio-clips',
      CurrentRuntimeTicks: BigInt(Math.max(index, 0)) * 30000000n },
    index, request, response).catch(error => {
      errors.push(error);
      if (response.headersSent) response.destroy(error);
      else response.writeHead(error.status ?? 500).end();
    });
  });
  t.after(async () => {
    await hls.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await registry.close();
    await origin?.close();
    assert.equal(path.dirname(root), temporaryRoot); await rm(root, { recursive: true });
  });
  await mkdir(cache); await writeFile(input, inputBytes);
  registry.registerType('local', options => LocalAdapter.open(options));
  await registry.createInstance('audio', 'local', { root });
  vfs.mount({ path: '/', instanceId: 'audio', capabilities: {} });
  origin = await startHttpSource({ bytes: inputBytes });
  registry.registerType('http', options => new HttpAdapter(options));
  await registry.createInstance('audio-http', 'http', {});
  vfs.mount({ path: '/http', instanceId: 'audio-http', capabilities: {} });
  assert.equal(vfs.capabilities('/source.mka').reliableVersion, false);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');

  const request = async (index, backend) => {
    const resource = backend ? `${index}/${backend}` : index;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${resource}`);
    const bytes = Buffer.from(await response.arrayBuffer()); await pending;
    assert.equal(response.status, 200, errors.map(error => error.message).join('\n'));
    return bytes;
  };
  const probe = filename => {
    const result = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-select_streams', 'a:0', '-show_packets',
      '-show_entries', 'packet=pts_time,duration_time,data_hash', '-show_data_hash', 'sha256', '-of', 'json', filename],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).packets;
  };
  const source = probe(input), init = await request(-1);
  const readSegment = async (index, suffix = '') => {
    const filename = path.join(root, `check-${index}${suffix}.mp4`);
    await writeFile(filename, Buffer.concat([init, await request(index)]));
    return probe(filename);
  };
  const data = packets => packets.map(packet => packet.data_hash);
  let before;
  for (const index of [0, 1, 2, 8]) {
    const packets = await readSegment(index), start = index * 3, args = processes.at(-1);
    assert.deepEqual(data(packets), data(source.filter(packet => Number(packet.pts_time) >= start && Number(packet.pts_time) < start + 3)));
    assert.ok(Math.abs(Number(packets[0].pts_time) - Number(source.find(packet => Number(packet.pts_time) >= start).pts_time)) < 0.001);
    if (index > 0) {
      assert.equal(args[args.indexOf('-start_number') + 1], String(index));
      assert.notEqual(args.indexOf('-ss'), -1);
      assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
    }
    if (index === 1) before = data(packets);
  }

  const changed = spawnSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=1700:sample_rate=44100', '-t', '8', '-ac', '2', '-c:a', 'aac', '-output_ts_offset', '7', '-y', input],
  { windowsHide: true, encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  const rebased = await readSegment(1, '-replacement');
  assert.notDeepEqual(data(rebased), before);
  assert.ok(Number(probe(input)[0].pts_time) >= 6, 'The replacement has a nonzero media origin.');
  assert.ok(Number(rebased[0].pts_time) >= 3 && Number(rebased[0].pts_time) < 3.03);
  assert.equal(processes.length, 6);

  const expected = source.filter(packet => Number(packet.pts_time) >= 24 && Number(packet.pts_time) < 27);
  for (const [backend, seekable] of [['bytes', true], ['ignore-range', false]]) {
    const fragment = await request(8, backend), args = processes.at(-1);
    const initialization = await request(-1, backend);
    const filename = path.join(root, `${backend}.mp4`);
    await writeFile(filename, Buffer.concat([initialization, fragment]));
    const packets = probe(filename);
    assert.deepEqual(data(packets), data(expected));
    assert.ok(Math.abs(Number(packets[0].pts_time) - Number(expected[0].pts_time)) < 0.001);
    assert.equal(args[args.indexOf('-start_number') + 1], seekable ? '8' : '0');
    assert.equal(args.includes('-ss'), seekable);
    assert.ok(origin.events.some(entry => entry.target === '/' + backend && entry.headers.range === 'bytes=1-'));
  }
  assert.deepEqual(errors, []);
});

async function seed(database) {
  for (const [table, rows] of Object.entries(reference.tables)) {
    const columns = tableDefinition(table).columns, pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(value => !value || inserted.has(value))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value != null && typeof value === 'string' && columns.find(column => column.name === name)?.type === 'INTEGER' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
}

test('native audio HLS manifests, copy packets, seek and task lifecycle on PostgreSQL', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
  const schema = `hls_http_${randomBytes(8).toString('hex')}`;
  const fixture = await extractionFixture({ '/source.mka': Buffer.from(reference.media, 'base64') });
  fixture.identityMap = new IdentityAccessMap(); fixture.identityMap.bind(id, '/source.mka');
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-hls-test-')), processes = [], errors = [];
  const state = await createPlaybackState({ TranscodingTempPath: directory });
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId, programDataPath: state.root,
      vfs: fixture.vfs, identityMap: fixture.identityMap, hlsOptions: { onProcess: entry => processes.push(entry.args) }, onError: error => errors.push({ message: error.message, code: error.code, details: error.details }) });
    const user = await runtime.users.createUser({ Name: 'HlsReader', Password: 'isolated-hls-password' });
    const policy = { ...library.user.Policy, EnableAudioPlaybackTranscoding: true, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true };
    await runtime.users.updatePolicy(user.Id, policy);

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="HLS Fixture", Device="Isolated", DeviceId="hls-fixture", Version="1"' }, body: JSON.stringify({ Username: 'HlsReader', Pw: 'isolated-hls-password' }) });
    assert.equal(login.status, 200); const token = (await login.json()).AccessToken;
    const headers = { Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' };
    const info = async entry => { const response = await fetch(origin + `/Items/${id}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: entry.profile, MediaSourceId: id, ...entry.options }) }); return { status: response.status, body: await response.json() }; };
    let lastSegment, lastBytes;
    for (const expected of reference.records) {
      const entry = reference.profiles.find(value => value.name === expected.name), actualInfo = await info(entry);
      assert.deepEqual({ ...actualInfo, body: playbackTransportSummary(actualInfo.body, token) }, expected.info, expected.name + ' PlaybackInfo');
      const masterUrl = new URL(actualInfo.body.MediaSources[0].TranscodingUrl, origin), playSessionId = actualInfo.body.PlaySessionId;
      // The recorded manifests and packet hashes were captured with this
      // explicit copy request.
      masterUrl.searchParams.set('AudioCodec', 'copy');
      const master = await fetch(masterUrl, { headers }), masterText = await master.text();
      assert.deepEqual({ ...headersOf(master), text: projectHlsRequestIdentities(masterText, { token, playSessionId }) }, expected.master, expected.name + ' master');
      assert.deepEqual(headersOf(await fetch(masterUrl, { headers, method: 'HEAD' })), expected.head);
      const variant = masterText.split(/\r?\n/).find(line => line && !line.startsWith('#')), mainUrl = new URL(variant, masterUrl);
      const main = await fetch(mainUrl, { headers }), mainText = await main.text();
      assert.deepEqual({ ...headersOf(main), text: projectHlsRequestIdentities(mainText, { token, playSessionId }) }, expected.main, expected.name + ' main');
      assert.equal(runtime.hls.hasJob(playSessionId), false, 'Manifests must not start a process.');
      let init = Buffer.alloc(0);
      for (const segment of expected.segments) {
        const url = new URL(segment.url.replaceAll('<token>', token).replaceAll('<session>', playSessionId), mainUrl);
        const response = await fetch(url, { headers }), bytes = Buffer.from(await response.arrayBuffer()), actualHeaders = headersOf(response);
        assert.equal(response.status, segment.status, `${expected.name} ${url.pathname}: ${JSON.stringify(errors)}`);
        assert.ok(Number.isFinite(Date.parse(actualHeaders.headers['last-modified']))); actualHeaders.headers['last-modified'] = '<date>';
        assert.deepEqual(actualHeaders, { status: segment.status, headers: segment.headers }, expected.name + ' ' + url.pathname);
        assert.equal(bytes.length, segment.size);
        if (url.pathname.endsWith('/-1.mp4')) { init = bytes; continue; }
        const file = path.join(directory, expected.name + '-' + path.basename(url.pathname)); await writeFile(file, Buffer.concat([init, bytes]));
        const probe = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file], { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        assert.equal(probe.status, 0, probe.stderr); const result = JSON.parse(probe.stdout);
        assert.equal(result.packets.length, segment.packetCount, expected.name + ' packet count');
        assert.equal(createHash('sha256').update(JSON.stringify(projection(result))).digest('hex'), segment.packetHash, expected.name + ' packet hash');
        lastSegment = url; lastBytes = bytes;
      }
      assert.equal(runtime.hls.hasJob(playSessionId), true);
      assert.equal((await fetch(origin + `/Sessions/Playing/Ping?playSessionId=${playSessionId}`, { method: 'POST', headers })).status, expected.ping);
      const range = await fetch(lastSegment, { headers: { ...headers, Range: 'bytes=10-99' } });
      assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), lastBytes.subarray(10, 100));
      assert.equal((await fetch(origin + `/Videos/ActiveEncodings?deviceId=hls-fixture&playSessionId=${playSessionId}`, { method: 'DELETE', headers })).status, expected.stop);
      assert.equal(runtime.hls.hasJob(playSessionId), false);
    }
    for (const args of processes) { assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy'); assert.ok(args.includes('-vn')); assert.ok(!args.includes('-vf') && !args.includes('-af')); }
    const low = structuredClone(reference.profiles[0]); low.profile.MusicStreamingTranscodingBitrate = 128000;
    for (const [entry, codec] of [[reference.profiles.find(value => value.name === 'no-audio-copy'), 'aac'],
      [reference.profiles.find(value => value.name === 'wrong-codec'), 'ac3'], [low, 'aac']]) {
      const infoResult = (await info(entry)).body;
      const [source] = infoResult.MediaSources;
      assert.equal(source.SupportsTranscoding, true);
      const masterUrl = new URL(source.TranscodingUrl, origin);
      const variantResponse = await fetch(masterUrl, { headers });
      assert.equal(variantResponse.status, 200);
      const variantUrl = new URL((await variantResponse.text()).split(/\r?\n/u).find(line => line && !line.startsWith('#')), masterUrl);
      assert.equal(variantUrl.searchParams.get('AudioCodec'), codec);
      const playlist = await fetch(variantUrl, { headers });
      assert.equal(playlist.status, 200);
      const segmentUrl = new URL((await playlist.text()).split(/\r?\n/u).find(line => line && !line.startsWith('#')), variantUrl);
      const segment = await fetch(segmentUrl, { headers });
      assert.equal(segment.status, 200);
      const file = path.join(directory, entry.name + '-encoded.ts');
      await writeFile(file, Buffer.from(await segment.arrayBuffer()));
      const probe = spawnSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(JSON.parse(probe.stdout).streams[0].codec_name, codec);
      assert.notEqual(processes.at(-1)[processes.at(-1).indexOf('-codec:a:0') + 1], 'copy');
      assert.equal(runtime.hls.getTranscodingInfo('hls-fixture').IsAudioDirect, false);
      assert.equal((await fetch(origin + '/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId: 'hls-fixture',
        playSessionId: infoResult.PlaySessionId }), { method: 'DELETE', headers })).status, 204);
    }
    assert.equal((await fetch(origin + '/Audio/' + id + '/master.m3u8', { headers })).status, 400);
  } finally {
    await runtime?.close(); await fixture.close(); await state.close();
    const cleanup = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}", "${schema}__mm" CASCADE`); } finally { await cleanup.close(); }
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});
