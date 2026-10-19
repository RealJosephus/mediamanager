import { createPlaybackState } from './runtime-state.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap } from '../../src/storage/index.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/audio-hls-reference.json' with { type: 'json' };



import library from '../library/fixtures/reference-media.json' with { type: 'json' };

const id = '88888888888888888888888888888888';
const headersOf = response => ({ status: response.status, headers: Object.fromEntries(['content-type', 'content-length', 'accept-ranges', 'expires', 'cache-control', 'etag', 'last-modified'].map(key => [key, response.headers.get(key)])) });
const projection = probe => ({ streams: probe.streams?.map(value => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => value[key] != null).map(key => [key, value[key]]))),
  packets: probe.packets?.map(value => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags'].filter(key => value[key] != null).map(key => [key, value[key]]))) });
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
  const state = await createPlaybackState();
  let database, runtime;
  try {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await seed(database);
    runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: library.serverId, programDataPath: state.root,
      vfs: fixture.vfs, identityMap: fixture.identityMap, hlsOptions: { onProcess: entry => processes.push(entry.args), cacheDirectory: directory }, onError: error => errors.push({ message: error.message, code: error.code, details: error.details }) });
    const user = await runtime.users.createUser({ Name: 'HlsReader', Password: 'isolated-hls-password' });
    const policy = { ...library.user.Policy, EnableAudioPlaybackTranscoding: true, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true };
    await runtime.users.updatePolicy(user.Id, policy);
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="HLS Fixture", Device="Isolated", DeviceId="hls-fixture", Version="1"' }, body: JSON.stringify({ Username: 'HlsReader', Pw: 'isolated-hls-password' }) });
    assert.equal(login.status, 200); const token = (await login.json()).AccessToken;
    const headers = { Authorization: `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' };
    const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'PlaySessionId').map(([key, value]) => [key, normalize(value)]))
      : typeof value === 'string' ? value.replaceAll(token, '<token>').replace(/PlaySessionId=[^&\r\n]+/g, 'PlaySessionId=<session>') : value;
    const info = async entry => { const response = await fetch(origin + `/Items/${id}/PlaybackInfo`, { method: 'POST', headers, body: JSON.stringify({ DeviceProfile: entry.profile, MediaSourceId: id, ...entry.options }) }); return { status: response.status, body: await response.json() }; };
    let lastSegment, lastBytes;
    for (const expected of reference.records) {
      const entry = reference.profiles.find(value => value.name === expected.name), actualInfo = await info(entry);
      assert.deepEqual(normalize(actualInfo), expected.info, expected.name + ' PlaybackInfo');
      // Native audio URLs enter encoding unless AudioCodec=copy is explicit.
      // PlaybackInfo is compared unchanged; executable manifests use the separately
      // recorded native copy branch and the candidate rewrites its variant to copy.
      const masterUrl = origin + actualInfo.body.MediaSources[0].TranscodingUrl, playSessionId = actualInfo.body.PlaySessionId;
      const master = await fetch(masterUrl, { headers }), masterText = await master.text();
      assert.deepEqual({ ...headersOf(master), text: normalize(masterText) }, expected.master, expected.name + ' master');
      assert.deepEqual(headersOf(await fetch(masterUrl, { headers, method: 'HEAD' })), expected.head);
      const variant = masterText.split(/\r?\n/).find(line => line && !line.startsWith('#')), mainUrl = new URL(variant, masterUrl);
      const main = await fetch(mainUrl, { headers }), mainText = await main.text();
      assert.deepEqual({ ...headersOf(main), text: normalize(mainText) }, expected.main, expected.name + ' main');
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
    for (const name of ['no-audio-copy', 'wrong-codec']) assert.equal((await info(reference.profiles.find(value => value.name === name))).body.MediaSources[0].SupportsTranscoding, false);
    const low = structuredClone(reference.profiles[0]); low.profile.MusicStreamingTranscodingBitrate = 128000;
    assert.equal((await info(low)).body.MediaSources[0].SupportsTranscoding, false, 'A bitrate limit below the source must not advertise copy.');
    assert.equal((await fetch(origin + '/Audio/' + id + '/master.m3u8', { headers })).status, 400);
    for (const args of processes) { assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy'); assert.ok(args.includes('-vn')); assert.ok(!args.includes('-vf') && !args.includes('-af')); }
  } finally {
    await runtime?.close(); await fixture.close(); await state.close();
    const cleanup = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}", "${schema}__mm" CASCADE`); } finally { await cleanup.close(); }
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});
