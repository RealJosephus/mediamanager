import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { PlaybackService } from '../../src/playback/service.js';
import { httpError } from '../../src/http/binding.js';
import { createTestApplication } from '../helpers/application.js';
import { openHttpStorage } from '../storage/http-fixture.js';

const localId = '25210000000000000000000000000001', remoteId = '25210000000000000000000000000002';
const user = { Id: '25210000000000000000000000000003', Policy: { EnableMediaPlayback: true,
  EnablePlaybackRemuxing: true, EnableAudioPlaybackTranscoding: true } };
const payload = Buffer.from('test audio bytes');
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('universal audio binds authenticated GET and HEAD, streams the selected source and never encodes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-universal-audio-'));
  const storage = await openHttpStorage();
  t.after(async () => { try { await storage.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  storage.registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await storage.registry.createInstance('audio', 'local', { root });
  storage.vfs.mount({ path: '/audio', instanceId: 'audio', capabilities: {} });
  storage.identityMap.addPrefix({ identityRoot: root, accessRoot: '/audio',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated audio.' });
  const localFile = path.join(root, 'audio.mp3');
  await writeFile(localFile, payload);

  const upstreamRequests = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.headers.authorization ?? null);
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': payload.length });
    response.end(payload);
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => close(upstream));
  const remoteFile = `http://127.0.0.1:${upstream.address().port}/audio.mp3`;
  const locations = new Map([[localId, localFile], [remoteId, remoteFile]]);
  const library = {
    async getItemRecord(Id) {
      if (!locations.has(Id)) throw httpError(404, 'Item not found.');
      return { Id, Path: locations.get(Id), MediaType: 'Audio' };
    },
    async getMediaSources(Id) {
      const IsRemote = Id === remoteId;
      return [{ Id, Path: locations.get(Id), Protocol: IsRemote ? 'Http' : 'File', IsRemote, Container: 'mp3',
        SupportsDirectPlay: true, Type: 'Default', Bitrate: 96000,
        MediaStreams: [{ Type: 'Audio', Codec: 'mp3', Channels: 2, SampleRate: 44100, BitRate: 96000 }], MediaAttachments: [] }];
    },
  };
  const auth = { async authenticate(request) { return { IsAuthenticated: request.headers.authorization === 'Audio Test',
    User: user, UserId: user.Id, DeviceId: 'audio-test', Token: 'internal-audio-token' }; },
  authorize(identity) { if (!identity.IsAuthenticated) throw httpError(401, 'Unauthorized'); } };
  const logs = [];
  const playback = new PlaybackService({ library, vfs: storage.vfs, identityMap: storage.identityMap,
    getEncodingOptions: () => ({}), remux: { supports: () => false, stream: () => assert.fail('Encoding was attempted.') } });
  const app = await createTestApplication({ authentication: auth, users: { getUser: async () => user }, library, playback,
    configuration: { IsStartupWizardCompleted: true }, onError: error => logs.push(error.message) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { app.beginClose(); await app.drainRequests(); await close(app.server); });
  const get = (id, query, { method = 'GET', headers = {}, anonymous = false } = {}) => fetch(
    `http://127.0.0.1:${app.server.address().port}/Audio/${id}/universal?${query}`, {
      method, redirect: 'manual', headers: { ...(anonymous ? {} : { Authorization: 'Audio Test' }), ...headers }, signal: t.signal,
    });

  const direct = 'Container=mp3%7Cmp3&MaxStreamingBitrate=1000000&AudioCodec=mp3';
  let response = await get(localId, direct);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  response = await get(localId, direct, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(payload.length));
  assert.equal(await response.text(), '');
  response = await get(localId, direct, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 2-5/${payload.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(2, 6));

  response = await get(remoteId, direct + '&EnableRemoteMedia=true');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), remoteFile);
  assert.deepEqual(upstreamRequests, []);
  response = await get(remoteId, direct + '&EnableRemoteMedia=true&EnableRedirection=false');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  assert.deepEqual(upstreamRequests, [null]);

  assert.equal((await get(localId, 'MaxAudioChannels=broken', { anonymous: true })).status, 401);
  response = await get(localId, 'MaxAudioChannels=broken&TranscodingProtocol=bad');
  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys((await response.json()).errors).sort(), ['maxAudioChannels', 'transcodingProtocol']);
  response = await get(localId, 'Container=wav&AudioCodec=pcm_s16le&TranscodingContainer=wav');
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Error processing request.');
  assert.deepEqual(logs, ['No compatible audio stream is available.']);
});
