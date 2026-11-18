import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const itemId = 'compat-item';
const playlistId = '66cde21f6ff0b1bfe878596649ca51a6';
const aacId = 'c08dd09d76c37b0ce3303ed32c9f294e';
const mp3Id = 'ba28b04fde04974b99f01c1b2a7b9b68';
const fixtureBytes = Buffer.from(Array.from({ length: 97 }, (_value, index) => index));
const playlistBytes = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhls/${playlistId}/${playlistId}0.ts\n`);
const responseHeaders = ['content-type', 'accept-ranges', 'content-range', 'last-modified'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const audioRoute = (id, extension) => `/Audio/${itemId}/hls/${id}/stream.${extension}`;
const videoRoute = (file, group = playlistId) => `/Videos/${itemId}/hls/${group}/${file}`;
const available = port => new Promise(resolve => {
  const probe = createServer();
  probe.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

async function request(origin, sample, token) {
  const response = await fetch(origin + sample.route, { method: sample.method ?? 'GET', signal: AbortSignal.timeout(15000),
    headers: { Connection: 'close', Accept: '*/*', ...sample.headers,
      ...(token ? { Authorization: `MediaBrowser Client="Legacy HLS fixture", Device="Isolated", DeviceId="legacy-hls-fixture", Version="1", Token="${token}"` } : {}) },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries([...responseHeaders,
    ...([200, 206, 416].includes(response.status) ? ['content-length'] : [])].map(header => [header, response.headers.get(header)])),
  body: response.status >= 400 ? bytes.toString() : { size: bytes.length, sha256: sha(bytes) } };
}

test('legacy HLS cache URLs deliver the existing playlist and media bytes with Native policies and ranges', {
  skip: !enabled, timeout: 300000,
}, nativeCase(async (t, port) => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'legacy-hls-cache-' + randomUUID()));
  await mkdir(output.root);
  const root = path.join(output.root, 'reference');
  const nativeOrigin = `http://127.0.0.1:${port}`;
  const report = { cases: [], cleanup: [], differences: [], encoderProcesses: [] };
  let current, native, database, runtime, stopped = false, failure;
  const stopNative = async () => {
    if (!native || stopped) return;
    stopped = true;
    report.nativeCleanup = await native.stop(async () => (await request(nativeOrigin,
      { route: '/System/Shutdown', method: 'POST' }, current.accessToken)).status, () => available(port));
    assert.ok(report.nativeCleanup.cleanShutdown && report.nativeCleanup.pidGone && report.nativeCleanup.portAvailable);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    report.reference = current.preparation;
    report.sources = await current.sourceBindings(['Jellyfin.Api/Controllers/HlsSegmentController.cs',
      'Jellyfin.Api/Controllers/DynamicHlsController.cs', 'Jellyfin.Api/Helpers/HlsHelpers.cs',
      'Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs', 'Jellyfin.Api/BaseJellyfinApiController.cs',
      'MediaBrowser.Common/Configuration/EncodingConfigurationExtensions.cs', 'MediaBrowser.MediaEncoding/Transcoding/TranscodeManager.cs']);
    await cp(current.sourceRoot, root, { recursive: true });
    await current.prepareClone(root, port);
    const settings = await readInstanceConfiguration(root);
    const cachePath = path.join(root, 'cache');
    const transcodeRoot = path.join(root, 'configured-transcode-cache');
    await writeConfigurationFile(path.join(settings.configurationDirectoryPath, 'encoding.xml'), 'encoding',
      { ...defaultConfiguration('encoding'), TranscodingTempPath: transcodeRoot });
    native = current.start({ referenceRoot: root, outputRoot: output.root, label: 'native', origin: nativeOrigin });
    await native.ready();
    // Resolving the Native transcode manager for the first time clears the cache.
    const emptyCache = await request(nativeOrigin, { route: audioRoute('uncached', 'mp3') });
    assert.equal(emptyCache.status, 404);
    const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
    const clonedDefaults = path.join(cachePath, 'transcodes');
    await mkdir(clonedDefaults, { recursive: true });
    await writeFile(path.join(clonedDefaults, 'default-only.mp3'), fixtureBytes);
    await mkdir(path.join(transcodeRoot, 'nested'), { recursive: true });
    await writeFile(path.join(transcodeRoot, 'nested', 'nested-only.mp3'), fixtureBytes);
    for (const [name, bytes] of [[playlistId + '.m3u8', playlistBytes], [playlistId + '0.ts', fixtureBytes],
      [playlistId + '-1.mp4', fixtureBytes], ['unrelated.ts', fixtureBytes], [aacId + '.aac', fixtureBytes], [mp3Id + '.MP3', fixtureBytes]]) {
      const filename = path.join(transcodeRoot, name);
      await writeFile(filename, bytes);
      await utimes(filename, timestamp, timestamp);
    }
    const mp3 = audioRoute(mp3Id, 'MP3'), aac = audioRoute(aacId, 'aac');
    const playlist = videoRoute('stream.m3u8'), ts = videoRoute(playlistId + '0.ts'), mp4 = videoRoute(playlistId + '-1.mp4');
    const key = (name, route, status, options = {}) => ({ name, route, status, ...options });
    const samples = [key('public MP3 alias', mp3, 200), key('public AAC alias', aac, 200),
      key('authorized video playlist', playlist, 200, { authorize: true, playlist: true }),
      key('anonymous video playlist', playlist, 401), key('public MPEG transport segment', ts, 200),
      key('public fMP4 initialization', mp4, 200), key('partial transport segment', ts, 206, { headers: { Range: 'bytes=5-12' }, window: [5, 13] }),
      key('partial audio suffix', aac, 206, { headers: { Range: 'bytes=-7' }, window: [-7] }),
      key('unsatisfied transport range', ts, 416, { headers: { Range: 'bytes=9000-' } }),
      key('stale range validator', mp4, 200, { headers: { Range: 'bytes=1-4', 'If-Range': new Date(0).toUTCString() } }),
      key('unmodified audio', aac, 304, { headers: { 'If-Modified-Since': timestamp.toUTCString() } }),
      key('unrelated video group', videoRoute('unrelated.ts', 'missing'), 404),
      key('missing video file for an existing group', videoRoute(playlistId + '1.ts'), 404),
      key('file in the inactive default cache', audioRoute('default-only', 'mp3'), 404),
      key('named audio files are flat', audioRoute('nested-only', 'mp3'), 404),
    ];
    const observe = (origin, sample) => request(origin, sample, sample.authorize ? current.accessToken : undefined);
    for (const sample of samples) report.cases.push({ sample, native: await observe(nativeOrigin, sample) });
    await stopNative();
    const databasePath = path.join(settings.dataPath, 'jellyfin.db');
    const sqlite = new SqliteDatabase(databasePath, { readOnly: true, requireMigrationHistory: true });
    try {
      database = await createPostgresTestDatabase(null, 'legacy_hls_cache');
      await transferDatabase(sqlite, database, { instanceBinding: { serverId: settings.serverId,
        originIdentityDigest: sha(await readFile(databasePath)) } });
    } finally { sqlite.close(); }
    runtime = await createTestRuntime({ ...settings, cachePath, database,
      hlsOptions: { onProcess: process => report.encoderProcesses.push(process.pid) } });
    const nodeOrigin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    for (const entry of report.cases) {
      const { status, name, playlist: isPlaylist, window } = entry.sample;
      entry.node = await observe(nodeOrigin, entry.sample);
      try {
        assert.equal(entry.native.status, status);
        assert.deepEqual(entry.node, entry.native);
        if (status === 200 || status === 206) {
          const selected = isPlaylist ? playlistBytes : fixtureBytes;
          assert.equal(entry.node.body.sha256, sha(window ? selected.subarray(...window) : selected));
        }
      } catch (error) { report.differences.push({ name, message: error.message }); }
    }
    assert.deepEqual(report.differences, []);
    assert.deepEqual(report.encoderProcesses, []);
    t.diagnostic('Compared legacy cache reads with the designated Native server. The cache selection and HTTP requests launched no Node encoder processes.');
  } catch (error) { failure = output.publicError(error); throw failure; }
  finally {
    const errors = [];
    for (const [name, close] of [['Native process', stopNative], ['Node runtime', () => runtime?.close()],
      ['PostgreSQL schema', () => dropPostgresTestDatabase(database)], ['reference input', () => current?.finish()]]) {
      try { await close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { errors.push(output.publicError(error)); report.cleanup.push({ name, closed: false }); }
    }
    try {
      await writeFile(path.join(output.root, 'observations.json'), filterEvidenceJson(report));
      await output.publishAndClose();
    } catch (error) { errors.push(output.publicError(error)); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Legacy HLS cache fixture cleanup failed.', { cause: failure });
  }
}));
