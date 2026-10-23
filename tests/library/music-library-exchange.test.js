import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startProductionInstance } from '../../src/main.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { addTrack, albumNfoSnapshot, assertRemoved, assetSnapshot, completeSnapshot, createMedia, databaseFilename,
  idKey, input, inputBytes, installStoppedExport, itemSnapshot, portAvailable,
  removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from './fixtures/music-library-exchange/scenario.js';
import { startMusicMediaProxy } from './fixtures/music-library-exchange/media-proxy.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;

test('Actual music scan, PostgreSQL edits and deletion survive cold restart, Native continuation and fresh PostgreSQL import', {
  skip: !enabled, timeout: 900000,
}, async () => {
  const destination = path.join(validationOutputRoot(), 'music-library-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const nativePort = await unusedPort(), nativeOrigin = `http://127.0.0.1:${nativePort}`;
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), requests: [], scans: [], aggregateRefreshes: [], snapshots: {}, cleanup: [], errors: [],
    phaseAcceptance: false, releaseAcceptance: false, completeLibraryVerified: false, fullInstanceVerified: false,
    scope: 'Actual Artist, Album and tagged PCM WAV scans; Node audio creation, HTTP metadata/NFO saves, favorite and deletion; production cold restart; complete SQLite export; actual Native scan and edit continuation; fresh PostgreSQL import. No other music formats, playback, arbitrary library shapes, state-package or production-scale claim.' };
  let current, native, runtime, database, returnedDatabase, sqlite, proxy, media, token, nodeOrigin, failure, safeToRemove = true;
  const identities = { artist: null, album: null, tracks: [] };
  const allIds = () => [identities.artist, identities.album, ...identities.tracks].filter(Boolean);
  const request = async (origin, route, { method = 'GET', body } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(); let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Retain non-JSON responses. */ }
    const result = { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
    report.requests.push({ origin, route, method, ...(body === undefined ? {} : { body }), response: result });
    return result;
  };
  const idleTasks = async origin => {
    const deadline = Date.now() + 120000;
    while (true) {
      const tasks = await request(origin, '/ScheduledTasks'); assert.equal(tasks.status, 200);
      if (tasks.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return tasks.bodyJson;
      assert.ok(Date.now() < deadline, 'Actual scheduled workers must finish before a music exchange boundary.');
      await delay(100);
    }
  };
  const scan = async (origin, label) => {
    const before = (await idleTasks(origin)).find(task => task.Key === 'RefreshLibrary'); assert.ok(before);
    assert.equal((await request(origin, '/ScheduledTasks/Running/' + before.Id, { method: 'POST' })).status, 204);
    const deadline = Date.now() + 180000;
    while (true) {
      const result = await request(origin, '/ScheduledTasks/' + before.Id); assert.equal(result.status, 200);
      if (result.bodyJson.State === 'Idle' && result.bodyJson.LastExecutionResult
        && result.bodyJson.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
        assert.equal(result.bodyJson.LastExecutionResult.Status, 'Completed');
        report.scans.push({ label, result: result.bodyJson }); await idleTasks(origin); return;
      }
      assert.ok(Date.now() < deadline, 'The real music scan must complete a new execution.'); await delay(100);
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const process = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { method: 'POST' })).status,
      () => portAvailable(nativePort));
    report.cleanup.push({ name: label, ...process }); safeToRemove &&= process.pidGone;
    if (process.pidGone) native = undefined;
    assert.ok(process.cleanShutdown && process.pidGone && process.portAvailable, label);
  };
  const stopNode = async label => {
    if (!runtime) return;
    const port = runtime.server.address()?.port;
    await runtime.close(); runtime = undefined;
    const released = port === undefined || await portAvailable(port);
    report.cleanup.push({ name: label, runtimeClosed: true, portAvailable: released }); assert.ok(released);
  };
  const startNode = async target => {
    const settings = await readInstanceConfiguration(instanceRoot);
    assert.equal(idKey(settings.serverId), idKey(current.preparation.nativeServerId));
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json'), MEDIAMANAGER_PORT: '0' },
      onError: error => report.errors.push({ name: error.name, message: error.message, code: error.code }) });
    nodeOrigin = `http://127.0.0.1:${runtime.server.address().port}`; await idleTasks(nodeOrigin);
  };
  const captureSqlite = async (label, filename) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try {
      const full = await completeSnapshot(sqlite);
      report.snapshots[label] = { full, music: await itemSnapshot(sqlite, allIds()) };
      return full;
    } finally { sqlite.close(); sqlite = undefined; }
  };
  const refreshArtistAggregate = async (origin, present, label) => {
    const scanned = await request(origin, '/Items?Recursive=true&IncludeItemTypes=MusicArtist,MusicAlbum,Audio'
      + '&Fields=Path,Overview,Tags,ProviderIds,Genres,MediaStreams,MediaSources,ParentId');
    assert.equal(scanned.status, 200);
    const matches = scanned.bodyJson.Items.filter(item => item.Path === media.artistRoot);
    assert.equal(matches.length, 1, 'The real scan must resolve the physical Artist before its aggregate refresh.');
    const before = matches[0];
    if (identities.artist) assert.equal(idKey(before.Id), identities.artist);
    const totalTicks = present.reduce((total, index) => total + input.tracks[index].seconds * 10000000, 0);
    assert.ok(Number.isSafeInteger(totalTicks) && totalTicks > 0, 'The aggregate refresh needs a nonzero exact media duration.');
    const observation = { label, present, before, targetRunTimeTicks: totalTicks, aggregateObserved: false };
    report.aggregateRefreshes.push(observation);
    // A physical Artist can be refreshed before its tracks are probed. The
    // Native post-scan validator skips an already-refreshed Artist, so a scan
    // alone does not promise an updated cumulative runtime or inherited genres.
    // Use the actual user refresh on both runtimes, after all tracks exist.
    assert.equal((await request(origin, '/Items/' + before.Id
      + '/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=None', { method: 'POST' })).status, 204);
    const deadline = Date.now() + 120000;
    while (true) {
      const after = await request(origin, '/Items/' + before.Id); assert.equal(after.status, 200);
      if (after.bodyJson.RunTimeTicks === totalTicks && after.bodyJson.Genres?.length === 1 && after.bodyJson.Genres[0] === input.genre) {
        Object.assign(observation, { after: after.bodyJson, aggregateObserved: true }); return;
      }
      assert.ok(Date.now() < deadline, 'The actual Artist refresh must publish the complete current track runtime and genres.');
      await delay(100);
    }
  };
  const readLibrary = async (origin, present, { albumOverview, trackOverview, favorite = false } = {}) => {
    const listed = await request(origin, '/Items?Recursive=true&IncludeItemTypes=MusicArtist,MusicAlbum,Audio'
      + '&Fields=Path,Overview,Tags,ProviderIds,Genres,MediaStreams,MediaSources,ParentId');
    assert.equal(listed.status, 200);
    const physical = listed.bodyJson.Items.filter(item => item.Path === media.artistRoot || item.Path === media.albumRoot
      || media.files.includes(item.Path));
    assert.equal(physical.length, 2 + present.length, 'The actual music library must contain exactly the declared physical items.');
    const byPath = filename => {
      const matches = physical.filter(item => item.Path === filename); assert.equal(matches.length, 1); return matches[0];
    };
    const artist = byPath(media.artistRoot), album = byPath(media.albumRoot);
    assert.equal(artist.Type, 'MusicArtist'); assert.equal(artist.Name, input.artist);
    assert.equal(album.Type, 'MusicAlbum'); assert.equal(album.Name, input.album);
    for (const [key, item] of [['artist', artist], ['album', album]]) {
      if (identities[key]) assert.equal(idKey(item.Id), identities[key]); else identities[key] = idKey(item.Id);
    }
    assert.equal(idKey(album.ParentId), identities.artist);
    const totalTicks = present.reduce((total, index) => total + input.tracks[index].seconds * 10000000, 0);
    assert.equal(artist.RunTimeTicks, totalTicks, 'The actual Artist refresh must aggregate the scanned audio children.');
    assert.deepEqual(artist.Genres, [input.genre]);
    const albumRead = await request(origin, '/Items/' + identities.album); assert.equal(albumRead.status, 200);
    assert.equal(albumRead.bodyJson.RunTimeTicks, totalTicks); assert.deepEqual(albumRead.bodyJson.Genres, [input.genre]);
    if (albumOverview !== undefined) assert.equal(albumRead.bodyJson.Overview, albumOverview);
    const tracks = [];
    for (const [index, specification] of input.tracks.entries()) {
      if (!present.includes(index)) {
        assert.ok(!physical.some(item => item.Path === media.files[index]));
        if (identities.tracks[index]) assert.equal((await request(origin, '/Items/' + identities.tracks[index])).status, 404);
        continue;
      }
      const track = byPath(media.files[index]); assert.equal(track.Type, 'Audio'); assert.equal(track.Name, specification.title);
      if (identities.tracks[index]) assert.equal(idKey(track.Id), identities.tracks[index]); else identities.tracks[index] = idKey(track.Id);
      assert.equal(idKey(track.ParentId), identities.album); assert.equal(idKey(track.AlbumId), identities.album);
      assert.equal(track.Album, input.album); assert.equal(track.IndexNumber, specification.number);
      assert.equal(track.ProductionYear, input.year); assert.deepEqual(track.Genres, [input.genre]);
      assert.deepEqual(track.Artists, [input.artist]); assert.deepEqual(track.AlbumArtists.map(value => value.Name), [input.artist]);
      assert.ok(track.ArtistItems.some(value => value.Name === input.artist && idKey(value.Id) === identities.artist));
      assert.equal(track.RunTimeTicks, specification.seconds * 10000000);
      const streams = track.MediaStreams.filter(stream => stream.Type === 'Audio'); assert.equal(streams.length, 1);
      assert.equal(streams[0].Codec, 'pcm_s16le'); assert.equal(streams[0].SampleRate, input.sampleRate); assert.equal(streams[0].Channels, 1);
      const detail = await request(origin, '/Items/' + track.Id); assert.equal(detail.status, 200);
      if (index === 0 && trackOverview !== undefined) {
        assert.equal(detail.bodyJson.Overview, trackOverview); assert.deepEqual(detail.bodyJson.ProviderIds, input.providerIds);
        assert.deepEqual(detail.bodyJson.Tags, input.tags); assert.equal(detail.bodyJson.UserData.IsFavorite, favorite);
      }
      tracks.push({ index, listed: track, detail: detail.bodyJson });
    }
    return { artist, album: albumRead.bodyJson, tracks };
  };
  const saveMetadata = async (origin, id, fields) => {
    const existing = await request(origin, '/Items/' + id); assert.equal(existing.status, 200);
    assert.equal((await request(origin, '/Items/' + id, { method: 'POST', body: { ...existing.bodyJson, ...fields } })).status, 204);
  };
  const assertProbeRows = async (target, present) => {
    const observations = [];
    for (const index of present) {
      const id = nativeGuid(identities.tracks[index]);
      const [row] = await target.rows('BaseItems', { where: { Id: id } }); assert.ok(row);
      assert.equal(row.Path, media.files[index]); assert.equal(idKey(row.ParentId), identities.album);
      assert.equal(BigInt(row.RunTimeTicks), BigInt(input.tracks[index].seconds) * 10000000n);
      const streams = await target.rows('MediaStreamInfos', { where: { ItemId: id } });
      assert.equal(streams.length, 1); assert.equal(streams[0].Codec, 'pcm_s16le');
      assert.equal(streams[0].SampleRate, input.sampleRate); assert.equal(streams[0].Channels, 1);
      const ancestry = await target.rows('AncestorIds', { where: { ItemId: id } });
      assert.ok(ancestry.some(link => idKey(link.ParentItemId) === identities.album));
      observations.push({ index, row, streams, ancestry });
    }
    return observations;
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); secrets.add(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'Jellyfin.Api/Controllers/LibraryStructureController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
      'Emby.Server.Implementations/Library/Resolvers/Audio/AudioResolver.cs',
      'Emby.Server.Implementations/Library/Resolvers/Audio/MusicArtistResolver.cs',
      'Emby.Server.Implementations/Library/Resolvers/Audio/MusicAlbumResolver.cs',
      'MediaBrowser.Providers/MediaInfo/AudioFileProber.cs', 'MediaBrowser.Providers/Music/AlbumMetadataService.cs',
      'Emby.Server.Implementations/Library/Validators/ArtistsValidator.cs', 'Jellyfin.Api/Controllers/ItemRefreshController.cs',
      'MediaBrowser.Providers/Manager/ProviderManager.cs', 'MediaBrowser.Providers/Manager/MetadataService.cs',
      'MediaBrowser.Providers/Music/ArtistMetadataService.cs', 'MediaBrowser.Controller/Entities/Audio/MusicArtist.cs',
      'MediaBrowser.XbmcMetadata/Providers/AlbumNfoProvider.cs', 'MediaBrowser.XbmcMetadata/Savers/AlbumNfoSaver.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, nativePort); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    media = await createMedia(root);
    await writeFile(path.join(root, 'media-inputs.json'), JSON.stringify({ specificationBase64: inputBytes.toString('base64'),
      inputSha256: sha(inputBytes), tracks: media.sources.map((bytes, index) => ({ index, filename: input.tracks[index].filename,
        bytes: bytes.length, sha256: sha(bytes), rawBase64: bytes.toString('base64') })) }, null, 2) + '\n', { flag: 'wx' });
    proxy = await startMusicMediaProxy(media); report.mediaProxy = proxy.report;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-preparation', origin: nativeOrigin });
    await native.ready();
    for (const task of await idleTasks(nativeOrigin)) assert.equal((await request(nativeOrigin, '/ScheduledTasks/' + task.Id + '/Triggers',
      { method: 'POST', body: [] })).status, 204);
    const quiet = await idleTasks(nativeOrigin); assert.ok(quiet.length && quiet.every(task => task.Triggers.length === 0));
    const administrator = await request(nativeOrigin, '/Users/' + current.userId); assert.equal(administrator.status, 200);
    assert.equal((await request(nativeOrigin, '/Users/' + current.userId + '/Policy', { method: 'POST',
      body: { ...administrator.bodyJson.Policy, EnableContentDeletion: true } })).status, 204);
    const libraryOptions = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false, EnableLUFSScan: false,
      SaveLocalMetadata: true, AutomaticRefreshIntervalDays: 0, MetadataSavers: ['Nfo'], PathInfos: [{ Path: media.root }],
      TypeOptions: ['MusicArtist', 'MusicAlbum', 'Audio', 'Folder', 'CollectionFolder'].map(Type => ({ Type,
        MetadataFetchers: ['MusicArtist', 'MusicAlbum'].includes(Type) ? ['Nfo'] : [],
        MetadataFetcherOrder: ['MusicArtist', 'MusicAlbum'].includes(Type) ? ['Nfo'] : [], ImageFetchers: [], ImageFetcherOrder: [] })) };
    assert.equal((await request(nativeOrigin, '/Library/VirtualFolders?name=' + encodeURIComponent(input.libraryName)
      + '&collectionType=music&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: libraryOptions } })).status, 204);
    await scan(nativeOrigin, 'native-initial-two-tracks');
    await refreshArtistAggregate(nativeOrigin, [0, 1], 'native-initial-two-tracks');
    report.nativeInitialReads = await readLibrary(nativeOrigin, [0, 1]);
    for (const index of [0, 1]) assert.ok(proxy.report.requests.some(entry => entry.filename === media.files[index]
      && [200, 206].includes(entry.status) && entry.bodyBytes > 0), 'Native must probe each real initial WAV through its designated media path.');
    report.nativeInitialAssets = await assetSnapshot(media, [0, 1]); await stopNative('native-preparation');
    const sourceFilename = path.join(root, 'initial-native.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), sourceFilename);
    const initialFull = await captureSqlite('nativeInitial', sourceFilename);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    report.mountContract = { mounts: [{ mountId: 'music-exchange', identityRoot: root, accessRoot: '/music-exchange',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    const ancestors = path.join(root, 'empty-ignore-ancestors'); await mkdir(ancestors);
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'music-exchange', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/music-exchange', instanceId: 'music-exchange', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
        { path: '/empty-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/music-exchange', style, caseSensitive,
        returnAccess: 'The same private music and instance files remain available to the actual Native continuation.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ignore-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty ancestors of this isolated music scenario.' }],
    }, null, 2) + '\n', { flag: 'wx' });
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(sourceFilename)) };
    sqlite = new SqliteDatabase(sourceFilename, { readOnly: true, requireMigrationHistory: true });
    try {
      report.initialProbeRows = await assertProbeRows(sqlite, [0, 1]);
      database = await createPostgresTestDatabase(null, 'music_exchange');
      report.importReceipt = await transferDatabase(sqlite, database,
        { instanceBinding: report.binding, portableMountContract: report.mountContract });
    } finally { sqlite.close(); sqlite = undefined; }
    report.snapshots.postgresImported = await completeSnapshot(database);
    assert.deepEqual(report.snapshots.postgresImported, initialFull);
    await startNode(database); report.nodeInitialReads = await readLibrary(nodeOrigin, [0, 1]);
    await addTrack(media, 2); await scan(nodeOrigin, 'node-add-third-track');
    await refreshArtistAggregate(nodeOrigin, [0, 1, 2], 'node-add-third-track');
    report.nodeAddedReads = await readLibrary(nodeOrigin, [0, 1, 2]);
    report.nodeAddedProbeRows = await assertProbeRows(database, [0, 1, 2]);
    await saveMetadata(nodeOrigin, identities.album, { Overview: input.nodeAlbumOverview });
    await saveMetadata(nodeOrigin, identities.tracks[0], { Overview: input.nodeTrackOverview, ProviderIds: input.providerIds, Tags: input.tags });
    assert.equal((await request(nodeOrigin, '/UserFavoriteItems/' + identities.tracks[0], { method: 'POST' })).status, 200);
    assert.equal((await request(nodeOrigin, '/Items/' + identities.tracks[1], { method: 'DELETE' })).status, 204);
    await scan(nodeOrigin, 'node-after-track-deletion');
    await refreshArtistAggregate(nodeOrigin, [0, 2], 'node-after-track-deletion');
    const nodeExpected = { albumOverview: input.nodeAlbumOverview, trackOverview: input.nodeTrackOverview, favorite: true };
    report.nodeChangedReads = await readLibrary(nodeOrigin, [0, 2], nodeExpected);
    report.nodeAlbumNfo = await albumNfoSnapshot(media, input.nodeAlbumOverview);
    report.nodeChangedAssets = await assetSnapshot(media, [0, 2]);
    assertRemoved(await itemSnapshot(database, [identities.tracks[1]]), identities.tracks[1]);
    await stopNode('node-before-cold-restart');
    const beforeCold = await itemSnapshot(database, allIds());
    await database.close();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
    await startNode(database);
    report.nodeColdReads = await readLibrary(nodeOrigin, [0, 2], nodeExpected);
    assert.deepEqual(await itemSnapshot(database, allIds()), beforeCold,
      'A new production runtime must consume the saved complete music rows and relations without an in-process cache.');
    report.nodeColdAssets = await assetSnapshot(media, [0, 2]);
    await stopNode('node-after-cold-restart');
    report.snapshots.nodeClosed = await completeSnapshot(database);
    const exported = path.join(root, 'node-export.db'); report.exportReceipt = await exportCurrentSqlite(database, exported);
    assert.equal(report.exportReceipt.verified, true);
    assert.deepEqual(await captureSqlite('nodeExport', exported), report.snapshots.nodeClosed);
    await installStoppedExport({ root, instanceRoot, exported });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-continuation', origin: nativeOrigin });
    await native.ready(); await idleTasks(nativeOrigin);
    report.nativeImportedReads = await readLibrary(nativeOrigin, [0, 2], nodeExpected);
    report.nativeImportedAssets = await assetSnapshot(media, [0, 2]);
    report.nativeImportedAlbumNfo = await albumNfoSnapshot(media, input.nodeAlbumOverview);
    await addTrack(media, 3); await scan(nativeOrigin, 'native-add-fourth-track');
    await refreshArtistAggregate(nativeOrigin, [0, 2, 3], 'native-add-fourth-track');
    report.nativeAddedReads = await readLibrary(nativeOrigin, [0, 2, 3], nodeExpected);
    assert.ok(proxy.report.requests.some(entry => entry.filename === media.files[3]
      && [200, 206].includes(entry.status) && entry.bodyBytes > 0), 'Native continuation must probe its newly added real WAV.');
    await saveMetadata(nativeOrigin, identities.album, { Overview: input.nativeAlbumOverview });
    await saveMetadata(nativeOrigin, identities.tracks[0], { Overview: input.nativeTrackOverview });
    const nativeExpected = { albumOverview: input.nativeAlbumOverview, trackOverview: input.nativeTrackOverview, favorite: true };
    report.nativeContinuedReads = await readLibrary(nativeOrigin, [0, 2, 3], nativeExpected);
    report.nativeContinuedAlbumNfo = await albumNfoSnapshot(media, input.nativeAlbumOverview);
    await stopNative('native-continuation'); report.nativeContinuedAssets = await assetSnapshot(media, [0, 2, 3]);
    const returnedFilename = path.join(root, 'native-returned.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returnedFilename);
    const returnedFull = await captureSqlite('nativeReturned', returnedFilename);
    sqlite = new SqliteDatabase(returnedFilename, { readOnly: true, requireMigrationHistory: true });
    try {
      report.nativeReturnedProbeRows = await assertProbeRows(sqlite, [0, 2, 3]);
      assertRemoved(await itemSnapshot(sqlite, [identities.tracks[1]]), identities.tracks[1]);
      returnedDatabase = await createPostgresTestDatabase(null, 'music_return');
      report.reimportReceipt = await transferDatabase(sqlite, returnedDatabase,
        { instanceBinding: report.binding, portableMountContract: report.mountContract });
    } finally { sqlite.close(); sqlite = undefined; }
    report.snapshots.postgresReimported = await completeSnapshot(returnedDatabase);
    assert.deepEqual(report.snapshots.postgresReimported, returnedFull,
      'Fresh PostgreSQL must preserve every business table, migration, sequence and relation order from Native continuation.');
    assert.deepEqual(await itemSnapshot(returnedDatabase, allIds()), report.snapshots.nativeReturned.music);
    await startNode(returnedDatabase); report.freshNodeReads = await readLibrary(nodeOrigin, [0, 2, 3], nativeExpected);
    report.freshNodeAssets = await assetSnapshot(media, [0, 2, 3]);
    report.freshNodeAlbumNfo = await albumNfoSnapshot(media, input.nativeAlbumOverview);
    assertRemoved(await itemSnapshot(returnedDatabase, [identities.tracks[1]]), identities.tracks[1]);
    await stopNode('node-after-native-continuation');
    assert.deepEqual(report.errors, []); assert.deepEqual(proxy.report.errors, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, message: error.message } });
    } };
    await attempt(() => stopNative('native-finally')); await attempt(() => stopNode('node-finally'));
    await attempt(() => { sqlite?.close(); sqlite = undefined; });
    await attempt(async () => {
      if (!proxy) return;
      await proxy.close();
      const released = await portAvailable(proxy.report.port);
      report.cleanup.push({ name: 'media-proxy', closed: proxy.report.closed, portAvailable: released });
      assert.ok(proxy.report.closed && released, 'The private music media proxy must release its listener.');
    });
    if (!runtime) {
      await attempt(async () => { await dropPostgresTestDatabase(returnedDatabase); report.cleanup.push({ name: 'returned-postgres', dropped: Boolean(returnedDatabase) }); });
      await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'initial-postgres', dropped: Boolean(database) }); });
    } else {
      safeToRemove = false; report.cleanup.push({ name: 'postgres', dropped: false, reason: 'The production runtime has not confirmed closure.' });
      await attempt(() => returnedDatabase?.close()); await attempt(() => database?.close());
    }
    await attempt(() => current?.finish());
    report.identities = identities; report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes),
      nativeInput: current?.preparation, sourceBindings: report.sourceBindings,
      actualNativeMusicScan: Boolean(report.nativeInitialReads && report.nativeAddedReads),
      productionPostgresMusicScan: Boolean(report.nodeAddedProbeRows),
      productionColdRestart: Boolean(report.nodeColdReads), actualNativeContinuation: Boolean(report.nativeContinuedReads),
      freshPostgresRuntime: Boolean(report.freshNodeReads), completeLibraryVerified: false, fullInstanceVerified: false,
      phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || proxy && !proxy.report.closed) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('The music exchange runtime did not release its private root.');
    }
  }
  if (failure) throw output.publicError(failure);
});
