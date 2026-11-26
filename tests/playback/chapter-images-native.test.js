import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { chapterImagesTaskId } from '../../src/tasks/chapter-images-task.js';
import { trickplayImagesTaskId, trickplayMoveImagesTaskId } from '../../src/tasks/trickplay-images-task.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { installStoppedExport, removeSyntheticPreparation, stoppedDatabase } from '../helpers/library-exchange-state.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { writeLocalFixtureStorage } from '../helpers/local-state-storage.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function execute(request, id) {
  const before = await request('/ScheduledTasks/' + id);
  await request('/ScheduledTasks/Running/' + id, { method: 'POST' }, 204);
  const deadline = Date.now() + 90000;
  while (true) {
    const state = await request('/ScheduledTasks/' + id);
    if (state.State === 'Idle' && state.LastExecutionResult?.StartTimeUtc && state.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
      assert.equal(state.LastExecutionResult.Status, 'Completed', JSON.stringify(state.LastExecutionResult)); return state;
    }
    assert.ok(Date.now() < deadline, 'The scheduled task must finish.');
    await delay(100);
  }
}

test('chapter images and trickplay regenerate, move, and round-trip through Native', { skip: !enabled, timeout: 240000 }, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'chapter-images-' + randomUUID()));
  const root = output.root, referenceRoot = path.join(root, 'reference'), mediaRoot = path.join(referenceRoot, 'data', 'fixture');
  const filename = path.join(mediaRoot, 'Chapter Test.m2ts'), nativeOrigin = 'http://127.0.0.1:' + port;
  const evidence = { native: {}, node: {} };
  let native, proxy, database, returned, runtime, authorization, failure;
  const requestAt = origin => async (route, init, expected = 200) => {
    const response = await fetch(origin + route, { ...init, headers: { Authorization: authorization, 'Content-Type': 'application/json' }, signal: t.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, route + ' ' + bytes.toString());
    const type = response.headers.get('content-type');
    return type?.includes('application/json') ? JSON.parse(bytes) : { type, bytes };
  };
  async function closeNative() {
    if (!native) return;
    const instance = native; native = undefined;
    const outcome = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization, Connection: 'close' }, signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
    }));
    (evidence.shutdowns ??= []).push(outcome); assert.ok(outcome.cleanShutdown && outcome.pidGone);
  }
  try {
    await mkdir(root);
    const current = await currentNativeReference();
    output.addSecret(root);
    output.addSecret(current.accessToken); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="Chapter image fixture", Device="Isolated", DeviceId="fixture-oracle", Version="1", Token="${current.accessToken}"`;
    evidence.reference = current.preparation;
    evidence.bindings = await current.sourceBindings(['Emby.Server.Implementations/Chapters/ChapterManager.cs',
      'Emby.Server.Implementations/ScheduledTasks/Tasks/ChapterImagesTask.cs', 'MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs',
      'Jellyfin.Api/Helpers/DynamicHlsHelper.cs', 'Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true }); await current.prepareClone(referenceRoot, port);
    removeSyntheticPreparation(referenceRoot, { allowAbsent: true });
    await mkdir(mediaRoot);
    await writeFile(path.join(mediaRoot, '.ignore'), 'fixture-unrelated-folder/\n');
    const { bytes, source } = await readFrozenAv('dual-avc.m2ts', { signal: t.signal });
    evidence.source = source; await writeFile(filename, bytes);
    proxy = await startOwnedMediaProxy([{ filename, contentType: 'video/mp2t', expected: source }]);
    const systemXml = path.join(referenceRoot, 'config', 'system.xml');
    const settings = (await readFile(systemXml, 'utf8')).replace(/<ChapterImageResolution>[^<]*<\/ChapterImageResolution>/u, '<ChapterImageResolution>P240</ChapterImageResolution>')
      .replace(/<TrickplayOptions>[\s\S]+?<\/TrickplayOptions>/u, options => options.replace(/<Interval>\d+<\/Interval>/u, '<Interval>1000</Interval>')
        .replace(/<TileWidth>\d+<\/TileWidth>/u, '<TileWidth>3</TileWidth>').replace(/<TileHeight>\d+<\/TileHeight>/u, '<TileHeight>2</TileHeight>')
        .replace(/<ScanBehavior>[^<]+<\/ScanBehavior>/u, '<ScanBehavior>Blocking</ScanBehavior>'));
    assert.ok(settings.includes('<ChapterImageResolution>P240</ChapterImageResolution>')); await writeFile(systemXml, settings);
    const startNative = async label => { native = current.start({ referenceRoot, outputRoot: root, label, origin: nativeOrigin }); await native.ready(); };
    await startNative('native-prepare');
    const request = requestAt(nativeOrigin), tasks = await request('/ScheduledTasks');
    for (const task of tasks) await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: '[]' }, 204);
    await request('/Library/VirtualFolders?name=Chapter%20images&collectionType=movies&refreshLibrary=false', { method: 'POST', body: JSON.stringify({
      LibraryOptions: { Enabled: true, EnableChapterImageExtraction: true, ExtractChapterImagesDuringLibraryScan: false,
        EnableTrickplayImageExtraction: true, ExtractTrickplayImagesDuringLibraryScan: false,
        EnableRealtimeMonitor: false, EnableInternetProviders: false, PathInfos: [{ Path: mediaRoot }],
        TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }] },
    }) }, 204);
    await execute(request, tasks.find(task => task.Key === 'RefreshLibrary').Id);
    const item = (await request('/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Path')).Items.find(value => value.Path === filename);
    assert.ok(item, 'Native indexed the designated video bytes.');
    const imageRoute = `/Items/${item.Id}/Images/Chapter/0`;
    const trickplayRoute = `/Videos/${item.Id}/Trickplay/320/`;
    const readTrickplay = async request => {
      const playlist = await request(trickplayRoute + 'tiles.m3u8');
      const tile = await request(trickplayRoute + '0.jpg');
      return { playlist: playlist.bytes.toString('utf8'), playlistType: playlist.type, type: tile.type, bytes: tile.bytes.length, sha256: sha256(tile.bytes) };
    };
    const readAdvertisedTrickplay = async (request, expected) => {
      const info = await request(`/Items/${item.Id}/PlaybackInfo`, { method: 'POST', body: JSON.stringify({
        EnableDirectPlay: false, EnableDirectStream: false, DeviceProfile: { MaxStreamingBitrate: 8000000,
          TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'ac3' }] },
      }) });
      const [source] = info.MediaSources;
      assert.match(source.TranscodingUrl, /\/master\.m3u8\?/u);
      const masterRoute = source.TranscodingUrl;
      const disabled = await request(masterRoute + '&EnableTrickplay=false');
      assert.doesNotMatch(disabled.bytes.toString(), /^#EXT-X-IMAGE-STREAM-INF:/mu);
      const ordinary = await request(masterRoute);
      const imageLine = /^#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=(\d+),RESOLUTION=(\d+)x(\d+),CODECS="jpeg",URI="([^"]+)"/mu;
      const line = imageLine.exec(ordinary.bytes.toString());
      assert.ok(line, 'The master playlist must advertise the generated preview stream.');
      const enabled = await request(masterRoute + '&EnableTrickplay=true');
      assert.equal(imageLine.exec(enabled.bytes.toString())?.[0], line[0]);
      const base = new URL(masterRoute, 'http://fixture.invalid');
      const playlistUrl = new URL(line[4], base);
      assert.equal(playlistUrl.origin, base.origin);
      assert.equal(nativeGuid(playlistUrl.searchParams.get('MediaSourceId')), nativeGuid(item.Id));
      const playlist = await request(playlistUrl.pathname + playlistUrl.search);
      assert.equal(playlist.type, expected.playlistType);
      assert.equal(playlist.bytes.toString('utf8'), expected.playlist);
      const tileUrl = new URL(expected.playlist.split(/\r?\n/u).find(entry => entry && !entry.startsWith('#')), playlistUrl);
      assert.equal(tileUrl.origin, base.origin);
      const tile = await request(tileUrl.pathname + tileUrl.search);
      assert.deepEqual({ type: tile.type, bytes: tile.bytes.length, sha256: sha256(tile.bytes) },
        { type: expected.type, bytes: expected.bytes, sha256: expected.sha256 });
      return { bandwidth: Number(line[1]), width: Number(line[2]), height: Number(line[3]) };
    };
    await closeNative();
    const configuration = await readInstanceConfiguration(referenceRoot), sqlitePath = path.join(configuration.dataPath, 'jellyfin.db');
    const checkpoint = async () => {
      const store = new SqliteDatabase(sqlitePath, { requireMigrationHistory: true });
      try {
        const result = store.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        assert.equal(result.busy, 0);
        (evidence.checkpoints ??= []).push(result);
      } finally { store.close(); }
      await stoppedDatabase(sqlitePath);
    };
    const windows = process.platform === 'win32';
    const portableMountContract = { mounts: [{ mountId: 'media-fixture', identityRoot: referenceRoot, accessRoot: '/media-fixture',
      pathStyle: windows ? 'windows' : 'posix', caseSensitive: !windows, returnPolicy: 'required' }] };
    const itemId = nativeGuid(item.Id);
    const instanceTiles = path.join(configuration.dataPath, 'trickplay', itemId.slice(0, 2).toLowerCase(), itemId.toLowerCase());
    const mediaTiles = path.join(mediaRoot, 'Chapter Test.trickplay');
    const setTrickplayOptions = async (request, save, duringScan = false) => {
      const folder = (await request('/Library/VirtualFolders')).find(value => value.Name === 'Chapter images');
      assert.ok(folder);
      await request('/Library/VirtualFolders/LibraryOptions', { method: 'POST', body: JSON.stringify({
        Id: folder.ItemId, LibraryOptions: { ...folder.LibraryOptions, SaveTrickplayWithMedia: save, ExtractTrickplayImagesDuringLibraryScan: duringScan },
      }) }, 204);
      const updated = (await request('/Library/VirtualFolders')).find(value => value.Name === 'Chapter images').LibraryOptions;
      assert.equal(updated.SaveTrickplayWithMedia, save);
      assert.equal(updated.ExtractTrickplayImagesDuringLibraryScan, duringScan);
    };
    const tile = directory => path.join(directory, '320 - 3x2', '0.jpg');
    const moveTiles = async (request, expected, save) => {
      await execute(request, trickplayMoveImagesTaskId);
      assert.equal(sha256(await readFile(tile(save ? mediaTiles : instanceTiles))), expected.sha256);
      await assert.rejects(() => readFile(tile(save ? instanceTiles : mediaTiles)), error => error.code === 'ENOENT');
      assert.deepEqual(await readTrickplay(request), expected);
    };
    const refreshTiles = async (request, expected) => {
      await setTrickplayOptions(request, true, true);
      const filename = tile(mediaTiles), original = await readFile(filename);
      await writeFile(filename, Buffer.concat([original, Buffer.from('refresh fixture')]));
      await request(`/Items/${item.Id}/Refresh?metadataRefreshMode=FullRefresh&regenerateTrickplay=true`, { method: 'POST' }, 204);
      const deadline = Date.now() + 45000;
      while (true) {
        const bytes = await readFile(filename).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
        if (sha256(bytes) === expected.sha256) break;
        assert.ok(Date.now() < deadline, 'Manual refresh must replace the existing media-side tile.');
        await delay(150);
      }
      assert.deepEqual(await readTrickplay(request), expected);
    };
    const sqlite = new SqliteDatabase(sqlitePath, { requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'chapter_images');
    try {
      sqlite.transaction(() => {
        sqlite.deleteWhere('Chapters', { ItemId: itemId });
        sqlite.insert('Chapters', { ItemId: itemId, ChapterIndex: 0, StartPositionTicks: 5000000n, Name: 'At half a second', ImagePath: null, ImageDateModified: null });
      });
      evidence.transfer = await transferDatabase(sqlite, database, { portableMountContract,
        instanceBinding: { serverId: configuration.serverId, originIdentityDigest: sha256(await readFile(sqlitePath)) } });
    } finally { sqlite.close(); }
    await startNative('native-chapters');
    evidence.native.task = await execute(request, chapterImagesTaskId);
    const nativeImage = await request(imageRoute);
    evidence.native.image = { type: nativeImage.type, bytes: nativeImage.bytes.length, sha256: sha256(nativeImage.bytes) };
    const chapterStore = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    try { [evidence.native.chapter] = chapterStore.rows('Chapters', { where: { ItemId: itemId } }); }
    finally { chapterStore.close(); }
    evidence.native.trickplayTask = await execute(request, trickplayImagesTaskId);
    evidence.native.trickplay = await readTrickplay(request);
    assert.match(evidence.native.trickplay.playlist, /LAYOUT=3x2/u);
    evidence.native.imageStream = await readAdvertisedTrickplay(request, evidence.native.trickplay);
    await setTrickplayOptions(request, true);
    await moveTiles(request, evidence.native.trickplay, true);
    await refreshTiles(request, evidence.native.trickplay);
    await setTrickplayOptions(request, false);
    await moveTiles(request, evidence.native.trickplay, false);
    await closeNative();
    const currentStore = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    try {
      [evidence.native.trickplayRow] = currentStore.rows('TrickplayInfos', { where: { ItemId: itemId } });
    }
    finally { currentStore.close(); }
    assert.deepEqual(evidence.native.imageStream, { bandwidth: evidence.native.trickplayRow.Bandwidth,
      width: evidence.native.trickplayRow.Width, height: evidence.native.trickplayRow.Height });
    const generated = evidence.native.chapter.ImagePath;
    assert.equal(path.dirname(generated).startsWith(configuration.metadataPath + path.sep), true);
    assert.match(path.basename(generated), /^\d+_5000000\.jpg$/u);
    await rename(generated, path.join(root, 'native-chapter.jpg')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rename(instanceTiles, path.join(root, 'native-tiles'));
    const storageConfiguration = await writeLocalFixtureStorage(path.join(referenceRoot, 'fixture-storage.json'), referenceRoot);
    runtime = await createTestRuntime({ ...configuration, database, storageConfiguration, portableMountContract,
      onError: error => (evidence.diagnostics ??= []).push(output.publicError(error).message) });
    const nodeRequest = requestAt('http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port);
    evidence.node.task = await execute(nodeRequest, chapterImagesTaskId);
    const nodeImage = await nodeRequest(imageRoute);
    evidence.node.image = { type: nodeImage.type, bytes: nodeImage.bytes.length, sha256: sha256(nodeImage.bytes) };
    [evidence.node.chapter] = await database.rows('Chapters', { where: { ItemId: itemId } });
    assert.deepEqual(evidence.node.image, evidence.native.image);
    assert.equal(evidence.node.chapter.ImagePath, generated);
    assert.ok(evidence.node.chapter.ImageDateModified);
    evidence.node.trickplayTask = await execute(nodeRequest, trickplayImagesTaskId);
    evidence.node.trickplay = await readTrickplay(nodeRequest);
    [evidence.node.trickplayRow] = await database.rows('TrickplayInfos', { where: { ItemId: itemId } });
    assert.deepEqual(evidence.node.trickplayRow, evidence.native.trickplayRow);
    assert.deepEqual(evidence.node.trickplay, evidence.native.trickplay);
    evidence.node.imageStream = await readAdvertisedTrickplay(nodeRequest, evidence.node.trickplay);
    assert.deepEqual(evidence.node.imageStream, evidence.native.imageStream);
    await setTrickplayOptions(nodeRequest, true);
    await moveTiles(nodeRequest, evidence.node.trickplay, true);
    await refreshTiles(nodeRequest, evidence.node.trickplay);
    await setTrickplayOptions(nodeRequest, false);
    await moveTiles(nodeRequest, evidence.node.trickplay, false);
    await runtime.close(); runtime = undefined;
    const reopened = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    const exported = path.join(root, 'generated-preview.db');
    try { evidence.export = { verified: (await exportCurrentSqlite(reopened, exported)).verified }; }
    finally { await reopened.close(); }
    assert.equal(evidence.export.verified, true);
    await checkpoint();
    await installStoppedExport({ root, instanceRoot: referenceRoot, exported });
    await startNative('native-return');
    evidence.native.readAfterExchange = await readTrickplay(request);
    assert.deepEqual(evidence.native.readAfterExchange, evidence.node.trickplay);
    await setTrickplayOptions(request, true);
    await moveTiles(request, evidence.native.readAfterExchange, true);
    await closeNative();
    await checkpoint();
    returned = await createPostgresTestDatabase(null, 'trickplay_return');
    const returnedSqlite = new SqliteDatabase(sqlitePath, { requireMigrationHistory: true, readOnly: true });
    try { evidence.reimport = await transferDatabase(returnedSqlite, returned, { portableMountContract }); }
    finally { returnedSqlite.close(); }
    runtime = await createTestRuntime({ ...await readInstanceConfiguration(referenceRoot), database: returned, storageConfiguration, portableMountContract });
    const coldRequest = requestAt('http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port);
    evidence.node.readAfterExchange = await readTrickplay(coldRequest);
    assert.deepEqual(evidence.node.readAfterExchange, evidence.native.readAfterExchange);
    evidence.node.imageStreamAfterExchange = await readAdvertisedTrickplay(coldRequest, evidence.node.readAfterExchange);
    assert.deepEqual(evidence.node.imageStreamAfterExchange, evidence.native.imageStream);
    assert.deepEqual(await returned.rows('TrickplayInfos', { where: { ItemId: itemId } }), [evidence.node.trickplayRow]);
    const orphanedPreview = async (api, origin, label) => {
      assert.equal((await readTrickplay(api)).sha256, evidence.node.trickplay.sha256);
      const folder = (await api('/Library/VirtualFolders')).find(row => row.Name === 'Chapter images');
      assert.equal(folder.LibraryOptions.SaveTrickplayWithMedia, true);
      const saveOptions = options => api('/Library/VirtualFolders/LibraryOptions', { method: 'POST',
        body: JSON.stringify({ Id: folder.ItemId, LibraryOptions: options }) }, 204);
      await saveOptions({ ...folder.LibraryOptions, EnableTrickplayImageExtraction: false,
        ExtractTrickplayImagesDuringLibraryScan: false });
      await execute(api, trickplayImagesTaskId);
      assert.equal((await readTrickplay(api)).sha256, evidence.node.trickplay.sha256);
      const parked = path.join(root, label + '-parked-previews');
      await rename(mediaTiles, parked);
      try {
        await mkdir(path.dirname(tile(instanceTiles)), { recursive: true });
        await rename(tile(parked), tile(instanceTiles));
        try {
          await execute(api, trickplayImagesTaskId);
          assert.equal((await api(trickplayRoute + 'tiles.m3u8')).bytes.toString(), evidence.node.trickplay.playlist);
          assert.equal(sha256(await readFile(tile(instanceTiles))), evidence.node.trickplay.sha256);
        } finally { await rename(tile(instanceTiles), tile(parked)); }
        await execute(api, trickplayImagesTaskId);
        const statuses = {};
        for (const name of ['tiles.m3u8', '0.jpg']) {
          const response = await fetch(origin + trickplayRoute + name, { headers: { Authorization: authorization }, signal: t.signal });
          await response.arrayBuffer();
          statuses[name] = response.status;
        }
        return statuses;
      } finally {
        await rename(parked, mediaTiles);
        await saveOptions(folder.LibraryOptions);
      }
    };
    const nodeOrigin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
    const actual = await orphanedPreview(coldRequest, nodeOrigin, 'node');
    assert.deepEqual(await returned.rows('TrickplayInfos', { where: { ItemId: itemId } }), []);
    await runtime.close(); runtime = undefined;
    await startNative('native-orphaned-preview');
    const reference = await orphanedPreview(request, nativeOrigin, 'native');
    await closeNative();
    t.diagnostic(JSON.stringify({ nativeAfterRemoval: reference, nodeAfterRemoval: actual }));
    assert.deepEqual(reference, { 'tiles.m3u8': 404, '0.jpg': 404 });
    assert.deepEqual(actual, reference, 'After the task the playlist should retire with its user-managed tiles.');
    await current.finish();
  } catch (error) { failure = output.publicError(error); evidence.error = failure.message; }
  finally {
    const errors = failure ? [failure] : [];
    for (const cleanup of [closeNative, () => runtime?.close(), () => proxy?.close(),
      () => dropPostgresTestDatabase(returned), () => dropPostgresTestDatabase(database)]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); }
    finally { await output.publishAndClose(); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Chapter image validation failed.');
  }
}, { signal: t.signal })));
