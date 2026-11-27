import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod, utimes, stat, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { cloneDirectory } from '../../src/migration/emby/files.js';
import { sortMediaSources } from '../../src/library/media-versions.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { PlaybackService } from '../../src/playback/service.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const guide = '<tv><channel id="news"><display-name lang="en">News</display-name><display-name lang="de">Nachrichten</display-name></channel></tv>';

async function ownedRoot(t, closeResources) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-review-'));
  t.after(async () => {
    try { await closeResources?.(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return root;
}

async function start(t, { mapGuideCache = false, pluginOptions } = {}) {
  let database, runtime;
  const root = await ownedRoot(t, async () => {
    try { await runtime?.close(); }
    finally { await dropPostgresTestDatabase(database); }
  });
  const program = path.join(root, 'program');
  const cache = path.join(program, 'cache', 'xmltv');
  const backend = path.join(root, 'mapped-cache');
  let storageConfiguration;
  if (mapGuideCache) {
    storageConfiguration = path.join(root, 'storage.json');
    await mkdir(backend);
    await writeFile(storageConfiguration, JSON.stringify({
      instances: [{ id: 'guide', type: 'local', config: { root: backend, writable: true } }],
      mounts: [{ path: '/guide', instanceId: 'guide', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: cache, accessRoot: '/guide', purpose: 'metadata', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated guide cache.' }],
    }));
  }
  database = await createPostgresTestDatabase(null, 'review');
  runtime = await createTestRuntime({ database, programDataPath: program, storageConfiguration, pluginOptions,
    serverId: 'c3cd0250859642b9ac4b3d351ec9f01c',
    configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true, PreferredMetadataLanguage: 'en' } });
  const { AccessToken } = await runtime.apiKeys.create('Review fixture');
  const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
  const request = (route, init = {}) => fetch(origin + route, { ...init, headers: {
    Authorization: 'MediaBrowser Token="' + AccessToken + '"', Accept: 'application/json', ...init.headers } });
  return { runtime, request, program, backend, cache };
}

test('XMLTV uses the current language after the public configuration update', async t => {
  const { runtime, request, program } = await start(t);
  const filename = path.join(program, 'guide.xml');
  await writeFile(filename, guide);
  const provider = runtime.plugins.entries('listings').find(entry => entry.type === 'xmltv');
  const info = { Id: 'guide', Path: filename };
  const channel = async (input = info) => (await provider.getChannels(input))[0].Name;
  assert.equal(await channel(), 'News');
  const current = await request('/System/Configuration');
  assert.equal(current.status, 200);
  const value = await current.json();
  const save = await request('/System/Configuration', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...value, PreferredMetadataLanguage: 'de' }) });
  assert.equal(save.status, 204);
  assert.equal((await (await request('/System/Configuration')).json()).PreferredMetadataLanguage, 'de');
  assert.equal(await channel({ ...info, PreferredLanguage: 'de' }), 'Nachrichten');
  assert.equal(await channel(), 'Nachrichten');
});

test('the XMLTV download is published in the configured cache mount', async t => {
  const { runtime, backend, cache } = await start(t, { mapGuideCache: true });
  const source = createServer((_req, res) => res.end(guide));
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(() => new Promise(resolve => source.close(resolve)));
  await runtime.fileSystem.writeFile(path.join(cache, 'control.txt'), 'control');
  assert.equal(await readFile(path.join(backend, 'control.txt'), 'utf8'), 'control');
  const provider = runtime.plugins.entries('listings').find(entry => entry.type === 'xmltv');
  assert.equal((await provider.getChannels({ Id: 'news', Path: 'http://127.0.0.1:' + source.address().port + '/guide.xml' }))[0].Name, 'News');
  const read = filename => readFile(filename, 'utf8').then(text => text === guide, e => e.code);
  assert.deepEqual({ mounted: await read(path.join(backend, 'news.xml')), shadow: await read(path.join(cache, 'news.xml')) },
    { mounted: true, shadow: 'ENOENT' });
});

test('scheduled tasks include native detached-userdata, subtitle and lyric workers', async t => {
  const { request } = await start(t);
  const response = await request('/ScheduledTasks');
  assert.equal(response.status, 200);
  const keys = (await response.json()).map(entry => entry.Key).sort();
  t.diagnostic(JSON.stringify({ registered: keys }));
  assert.ok(keys.includes('RefreshLibrary'));
  assert.deepEqual(['CleanupUserDataTask', 'DownloadLyrics', 'DownloadSubtitles'].filter(key => !keys.includes(key)), []);
});

test('instance exchange preserves the access mode and timestamp of an ordinary side directory', async t => {
  const root = await ownedRoot(t), src = path.join(root, 'source'), dest = path.join(root, 'copy');
  const dir = path.join(src, 'plugins');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state'), 'fixture');
  await chmod(dir, 0o750);
  const stamp = new Date('2020-02-03T04:05:06.000Z');
  await utimes(dir, stamp, stamp);
  await cloneDirectory(src, dest);
  const inspect = async p => { const s = await stat(p); return { mode: (s.mode & 0o777).toString(8), modified: s.mtime.toISOString() }; };
  assert.equal(await readFile(path.join(dest, 'plugins', 'state'), 'utf8'), 'fixture');
  assert.deepEqual(await inspect(path.join(dest, 'plugins')), await inspect(dir));
});

test('PlaybackInfo orders sibling versions by negotiated direct play after the requested version', async t => {
  const ids = ['1', '2', '3'].map(n => n.padStart(32, '0'));
  const item = { Id: ids[0], Type: 'Movie', MediaType: 'Video', Path: '/media/primary.mp4' };
  const makeSource = (id, width, codec) => ({ Id: id, Type: 'Default', Protocol: 'File', VideoType: 'VideoFile',
    Container: 'mp4', Path: '/media/' + id + '.mp4', Bitrate: 1200000, SupportsDirectPlay: true, SupportsDirectStream: true,
    MediaAttachments: [], MediaStreams: [{ Type: 'Video', Codec: codec, Width: width, Index: 0, IsDefault: true }] });
  const candidates = [makeSource(ids[0], 1920, 'h264'), makeSource(ids[1], 3840, 'hevc'), makeSource(ids[2], 1280, 'h264')];
  const playback = new PlaybackService({ getEncodingOptions: () => ({}), library: {
    getItemRecord: async () => item, getMediaSources: async () => sortMediaSources(structuredClone(candidates), item.Id, true) } });
  t.after(async () => { playback.beginClose(); await playback.drainSubtitlePreparations(); });
  const result = await playback.info(item.Id, { posted: true, auth: {}, user: { Policy: { EnableMediaPlayback: true } },
    DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264' }] } });
  t.diagnostic(JSON.stringify(result.MediaSources.map(({ Id, SupportsDirectPlay }) => ({ Id, SupportsDirectPlay }))));
  assert.equal(result.MediaSources.find(s => s.Id === ids[1]).SupportsDirectPlay, false);
  assert.equal(result.MediaSources.find(s => s.Id === ids[2]).SupportsDirectPlay, true);
  assert.deepEqual(result.MediaSources.map(s => s.Id), [ids[0], ids[2], ids[1]]);
});

test('PlaybackInfo keeps the lower profile bitrate limit when it applies the remote network limit', async t => {
  const id = '4'.padStart(32, '0');
  const item = { Id: id, Type: 'Movie', MediaType: 'Video', Path: '/media/movie.mp4' };
  const source = { Id: id, Type: 'Default', Protocol: 'File', VideoType: 'VideoFile', Container: 'mp4', Path: item.Path,
    Bitrate: 3000000, SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true, MediaAttachments: [],
    MediaStreams: [{ Type: 'Video', Codec: 'h264', Index: 0, Width: 1920, IsDefault: true }] };
  const playback = new PlaybackService({ configuration: { RemoteClientBitrateLimit: 8000000 }, isLocalNetwork: () => false,
    getEncodingOptions: () => ({}), library: { getItemRecord: async () => item, getMediaSources: async () => [structuredClone(source)] } });
  t.after(async () => { playback.beginClose(); await playback.drainSubtitlePreparations(); });
  const request = { posted: true, user: { Policy: { EnableMediaPlayback: true } }, auth: {},
    DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264' }], MaxStreamingBitrate: 1000000 } };
  const evaluate = async extras => (await playback.info(id, { ...request, ...extras })).MediaSources[0].SupportsDirectPlay;
  const actual = { explicit: await evaluate({ MaxStreamingBitrate: 1000000 }), profileOnly: await evaluate({}) };
  assert.deepEqual(actual, { explicit: false, profileOnly: false });
});

test('a poster containing an embedded PNG supports PNG resizing', async t => {
  const processor = new ImageProcessor();
  t.after(() => processor.close());
  const embedded = await readFile(new URL('../images/fixtures/processor/grid.png', import.meta.url));
  const svg = inner => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32">' + inner + '</svg>');
  const poster = svg('<image width="32" height="32" xlink:href="data:image/png;base64,' + embedded.toString('base64') + '"/>');
  const process = bytes => processor.process({ image: { Path: 'poster.svg', Width: 32, Height: 32 }, MaxWidth: 16,
    SupportedOutputFormats: ['Png'], assets: { stat: async () => ({}), read: async () => bytes } });
  const control = await process(svg('<rect width="32" height="32" fill="red"/>'));
  assert.equal(control.mimeType, 'image/png');
  assert.equal(control.bytes.readUInt32BE(16), 16);
  const actual = await process(poster);
  assert.deepEqual({ original: actual.original, type: actual.mimeType, width: actual.bytes?.readUInt32BE(16) },
    { original: false, type: 'image/png', width: 16 });
});

test('updating an XMLTV URL makes the next public lineup read from the new feed with a mounted cache', async t => {
  const requests = [];
  const upstream = createServer((req, res) => {
    requests.push(req.url);
    const label = req.url === '/first.xml' ? 'Before' : 'After';
    res.end('<tv><channel id="news"><display-name>' + label + '</display-name></channel></tv>');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const run = async mapped => {
    const { request } = await start(t, { mapGuideCache: mapped });
    const save = async info => {
      const response = await request('/LiveTv/ListingProviders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(info) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const info = await save({ Type: 'xmltv', Path: origin + '/first.xml', EnableAllTuners: true });
    assert.match(info.Id, /^[a-f0-9]{32}$/i);
    const lineup = async () => {
      const response = await request('/LiveTv/ListingProviders/Lineups?id=' + info.Id + '&type=xmltv');
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text)[0].Name;
    };
    assert.equal(await lineup(), 'Before');
    const updated = await save({ ...info, Path: origin + '/second.xml' });
    assert.equal(updated.Id, info.Id);
    assert.equal(updated.Path, origin + '/second.xml');
    return lineup();
  };
  const control = await run(false);
  const mapped = await run(true);
  t.diagnostic(JSON.stringify({control,mapped,upstreamRequests:requests}));
  assert.equal(control, 'After');
  assert.equal(mapped, 'After');
});

test('account lists honor the negotiated sort culture of user-supplied names', async t => {
  const { runtime, request } = await start(t);
  const names = ['Zara', '\u00c5sa'];
  for (const Name of names) {
    const user = await runtime.users.createUser({ Name });
    await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsHidden: false });
  }
  const order = async (uri, culture) => {
    const response = await request(uri, { headers: { 'Accept-Language': culture } });
    assert.equal(response.status, 200);
    return (await response.json()).map(row => row.Name).filter(name => names.includes(name));
  };
  const control = await order('/Users', 'en-US');
  assert.deepEqual(control, ['\u00c5sa','Zara']);
  const result = { authenticated: await order('/Users', 'sv'), public: await order('/Users/Public', 'sv') };
  t.diagnostic(JSON.stringify({ control, ...result }));
  assert.deepEqual(result, { authenticated: names, public: names });
});

test('the default installation saves a validated Schedules Direct account and discovers its lineups', async t => {
  const calls = [];
  const hash = value => createHash('sha1').update(value).digest('hex');
  const fetch = async (url, init) => {
    const route = new URL(url).pathname.slice('/20141201'.length);
    calls.push(route);
    if (route === '/token') {
      assert.deepEqual(JSON.parse(init.body), { username: 'guide-user', password: hash(hash('fixture-password')) });
      return Response.json({ message: 'OK', token: 'controlled-account' });
    }
    assert.equal(init.headers.token, 'controlled-account');
    if (route === '/status') return Response.json({ systemStatus: [{ status: 'Online' }], lineups: [] });
    if (route === '/lineups') return Response.json({ lineups: [{ lineup: 'LOCAL' }] });
    if (route === '/lineups/LOCAL') return Response.json({ stations: [], map: [] });
    assert.equal(route, '/headends');
    return Response.json([{ lineups: [{ lineup: 'LOCAL', name: 'Local TV' }] }]);
  };
  const { runtime, request } = await start(t, { pluginOptions: { options: { 'schedules-direct': { fetch } } } });
  assert.ok(runtime.plugins.entries('listings').some(provider => provider.type === 'SchedulesDirect'));
  const response = await request('/LiveTv/ListingProviders?validateLogin=true&validateListings=false', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Type: 'SchedulesDirect' }),
  });
  assert.equal(response.status, 400, await response.text());
  assert.deepEqual(calls, []);
  const create = await request('/LiveTv/ListingProviders?pw=fixture-password&validateLogin=true&validateListings=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'SchedulesDirect', username: 'guide-user', listingsId: 'LOCAL' }),
  });
  const body = await create.text();
  assert.equal(create.status, 200, body);
  const info = JSON.parse(body);
  assert.equal(info.ListingsId, 'LOCAL');
  const configured = await (await request('/System/Configuration/LiveTv')).json();
  assert.equal(configured.ListingProviders.find(entry => entry.Id === info.Id).Username, 'guide-user');
  const lineups = await request('/LiveTv/ListingProviders/Lineups?id=' + info.Id + '&country=USA&location=12345');
  assert.equal(lineups.status, 200);
  assert.deepEqual(await lineups.json(), [{ Name: 'Local TV', Id: 'LOCAL' }]);
  assert.ok(calls.includes('/lineups') && calls.includes('/headends'));
});
