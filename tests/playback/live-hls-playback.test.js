import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { refreshGuideTaskId } from '../../src/tasks/refresh-guide-task.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { until } from './fixtures/live-stream-session-runtime/scenario.js';

export const requiredValidationServices = ['postgres'];
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES) });

test('an opened M3U HLS channel negotiates and serves H.264/AAC HLS from the original HTTP manifest', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => discovery.run(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-live-hls-playback-'));
  const ffmpeg = validationExecutable('ffmpeg');
  const programDataPath = path.join(root, 'data'), cachePath = path.join(programDataPath, 'cache');
  const agent = 'Original HLS channel agent', requests = [], processes = [];
  const manifests = new Map([
    ['/channel/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nmedia/variant.m3u8\n'],
    ['/channel/media/variant.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\n../segments/intro.ts?channel=1\n#EXT-X-ENDLIST\n'],
  ]);
  const segmentPath = '/channel/segments/intro.ts?channel=1';
  let database, runtime, server;
  try {
    const media = await captureMediaProcess(ffmpeg, [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=10:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-threads', '1', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1',
    ], { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
    assert.equal(media.exitCode, 0, media.stderr.toString());
    assert.ok(media.stdout.length > 1880);
    server = http.createServer((request, response) => {
      requests.push({ path: request.url, agent: request.headers['user-agent'] });
      if (request.headers['user-agent'] !== agent) { response.writeHead(403).end(); return; }
      const manifest = manifests.get(request.url);
      if (manifest) response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(manifest);
      else if (request.url === segmentPath) response.writeHead(200, { 'Content-Type': 'video/mp2t' }).end(media.stdout);
      else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const target = `http://127.0.0.1:${server.address().port}/channel/master.m3u8`;
    await mkdir(cachePath, { recursive: true });
    await writeFile(path.join(cachePath, 'sd-countries.json'), '{"Controlled":[]}\n');
    const playlist = path.join(programDataPath, 'source.m3u');
    await writeFile(playlist, '#EXTM3U\n#EXTINF:-1 tvg-id="controlled-hls",HLS channel\n' + target + '\n');
    database = await createPostgresTestDatabase(null, 'live_hls');
    runtime = await createTestRuntime({ database, programDataPath, cachePath, configuration: { IsStartupWizardCompleted: true },
      serverId: 'live-hls-playback', mediaEncoderOptions: { startupFFmpegPath: ffmpeg },
      probeOptions: { timeoutMs: 15000 }, hlsOptions: { timeoutMs: 20000, onProcess: entry => processes.push(entry.args) } });
    const admin = await runtime.users.createUser({ Name: 'HLS administrator', Password: 'controlled' });
    const { Policy } = await runtime.users.getUser(admin.Id);
    await runtime.users.updatePolicy(admin.Id, { ...Policy, IsAdministrator: true, EnablePlaybackRemuxing: true,
      EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false });
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const headers = { Authorization: 'MediaBrowser Client="HLS Fixture", Device="HTTP", DeviceId="hls-fixture", Version="1"',
      'Content-Type': 'application/json' };
    const request = (route, body) => fetch(new URL(route, origin), { headers, signal: t.signal,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const success = async (route, body) => {
      const response = await request(route, body), text = await response.text();
      assert.equal(response.status, 200, text);
      return text;
    };
    const login = JSON.parse(await success('/Users/AuthenticateByName', { Username: admin.Name, Pw: 'controlled' }));
    headers.Authorization += `, Token="${login.AccessToken}"`;
    await success('/LiveTv/TunerHosts', { Type: 'm3u', Url: playlist, UserAgent: agent, AllowStreamSharing: true, TunerCount: 0 });
    const { channel } = await until(async () => ({
      task: await runtime.tasks.get(refreshGuideTaskId),
      channel: JSON.parse(await success('/LiveTv/Channels?enableImages=false')).Items[0],
    }), state => state.task.LastExecutionResult?.Status === 'Completed' && state.channel, 'M3U HLS channel', 60000);
    const { MediaSources: [candidate] } = JSON.parse(await success(`/Items/${channel.Id}/PlaybackInfo`));
    const { MediaSource: opened } = JSON.parse(await success('/LiveStreams/Open', { ItemId: channel.Id, OpenToken: candidate.OpenToken,
      DeviceProfile: { TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts',
        VideoCodec: 'h264', AudioCodec: 'aac', SegmentLength: 1 }] } }));
    assert.equal(opened.Container, 'hls');
    assert.equal(opened.Path, target);
    assert.equal(opened.SupportsDirectPlay, false);
    assert.equal(opened.SupportsDirectStream, false);
    assert.equal(opened.SupportsTranscoding, true);
    assert.deepEqual(opened.MediaStreams.map(stream => stream.Codec), ['h264', 'aac']);
    assert.equal(runtime.liveStreams.hasByteReader(opened.LiveStreamId), false);
    const masterUrl = new URL(opened.TranscodingUrl, origin);
    const uri = text => text.split(/\r?\n/u).find(line => line && !line.startsWith('#'));
    const variant = new URL(uri(await success(masterUrl)), masterUrl);
    assert.match(variant.pathname, /\/live\.m3u8$/u);
    const event = await success(variant);
    assert.match(event, /#EXT-X-PLAYLIST-TYPE:EVENT/u);
    const segment = await request(new URL(uri(event), variant));
    assert.equal(segment.status, 200);
    const bytes = Buffer.from(await segment.arrayBuffer());
    assert.ok(bytes.length > 1880 && bytes.length % 188 === 0 && bytes[0] === 0x47);
    const downloaded = path.join(root, 'delivered.ts');
    await writeFile(downloaded, bytes);
    const checked = await captureMediaProcess(validationExecutable('ffprobe'),
      ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', downloaded],
      { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 10000 });
    assert.equal(checked.exitCode, 0, checked.stderr.toString());
    assert.deepEqual(JSON.parse(checked.stdout).streams.map(stream => stream.codec_name), ['h264', 'aac']);
    for (const location of [...manifests.keys(), segmentPath]) {
      assert.ok(requests.filter(entry => entry.path === location).length >= 2, location + ' must be probed and encoded.');
    }
    assert.ok(requests.every(entry => entry.agent === agent));
    assert.equal(processes.length, 1);
    assert.ok(processes[0].includes('[private headers]'));
    assert.ok(processes[0].includes('[private source]'));
  } finally {
    await runtime?.close();
    if (database) await dropPostgresTestDatabase(database);
    if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(root, { recursive: true, force: true });
  }
}));
