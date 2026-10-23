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
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { assertFiles, assertPersisted, changeNodeNfoForNative, completeSnapshot, configureStorage, databaseFilename,
  idKey, input, inputBytes, installStoppedExport, materialize, portAvailable, prepareMedia,
  removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from './fixtures/tv-library-exchange/scenario.js';
import { startMediaProxy } from './fixtures/tv-library-exchange/media-proxy.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;

function publicItem(item) {
  const value = Object.fromEntries(['Name', 'Type', 'Path', 'Overview', 'IndexNumber', 'ParentIndexNumber',
    'SeriesName', 'SeasonName', 'Container', 'MediaType', 'RunTimeTicks'].map(key => [key, item[key] ?? null]));
  for (const key of ['Id', 'ParentId', 'SeriesId', 'SeasonId']) value[key] = item[key] ? idKey(item[key]) : null;
  for (const key of ['Genres', 'Tags', 'ProviderIds']) value[key] = item[key] ?? null;
  value.MediaStreams = (item.MediaStreams ?? []).map(stream => Object.fromEntries(
    ['Index', 'Type', 'Codec', 'Width', 'Height', 'Channels', 'SampleRate'].map(key => [key, stream[key] ?? null])));
  return value;
}

test('real TV scan, NFO edits and cold PostgreSQL reads survive complete SQLite exchange and actual Native continuation', {
  skip: !enabled, timeout: 900000,
}, async () => {
  const destination = path.join(validationOutputRoot(), 'tv-library-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const nativePort = await unusedPort(), nativeOrigin = `http://127.0.0.1:${nativePort}`;
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), requests: [], snapshots: {}, cleanup: [], errors: [],
    phaseAcceptance: false, releaseAcceptance: false, completeLibraryVerified: false, fullInstanceVerified: false,
    scope: 'One ordinary physical Series, Specials and Season 1, three initial MKV Episodes and a fourth added by actual Native. Real Node scan, local NFO read/write, real probing, cold PG reads, public Shows order, complete 31-business/2-EF-table exchange and fresh-PG reimport. No remote provider, virtual season, mixed-version, all-type or production-scale claim.' };
  let current, native, runtime, database, returnedDatabase, sqlite, proxy, failure, safeToRemove = true;
  let token, nodeOrigin, media, ids = {};
  const request = async (origin, route, { method = 'GET', body } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Retain the actual non-JSON response. */ }
    const result = { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
    report.requests.push({ origin, route, method, ...(body === undefined ? {} : { body }), response: result });
    return result;
  };
  const idleTasks = async origin => {
    const deadline = Date.now() + 120000;
    while (true) {
      const response = await request(origin, '/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.bodyJson;
      assert.ok(Date.now() < deadline, 'Registered task executions must finish before the exchange boundary.');
      await delay(100);
    }
  };
  const scan = async origin => {
    const before = (await idleTasks(origin)).find(task => task.Key === 'RefreshLibrary'); assert.ok(before);
    assert.equal((await request(origin, '/ScheduledTasks/Running/' + before.Id, { method: 'POST' })).status, 204);
    const deadline = Date.now() + 180000;
    while (true) {
      const response = await request(origin, '/ScheduledTasks/' + before.Id); assert.equal(response.status, 200);
      const task = response.bodyJson;
      if (task.State === 'Idle' && task.LastExecutionResult
        && task.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
        assert.equal(task.LastExecutionResult.Status, 'Completed'); return task;
      }
      assert.ok(Date.now() < deadline, 'The actual registered RefreshLibrary task must complete a new execution.');
      await delay(100);
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { method: 'POST' })).status,
      () => portAvailable(nativePort));
    report.cleanup.push({ name: label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const stopNode = async label => {
    if (!runtime) return;
    const port = runtime.server.address()?.port;
    await runtime.close(); runtime = undefined;
    const released = port === undefined || await portAvailable(port);
    report.cleanup.push({ name: label, runtimeClosed: true, portAvailable: released }); assert.ok(released);
  };
  const startNode = async target => {
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json'), MEDIAMANAGER_PORT: '0' },
      onError: error => report.errors.push({ name: error.name, code: error.code, message: error.message }) });
    nodeOrigin = `http://127.0.0.1:${runtime.server.address().port}`; await idleTasks(nodeOrigin);
  };
  const observe = async (origin, { continued = false, overviews = {} } = {}) => {
    const entries = continued ? [...media.definitions, media.continued] : media.definitions;
    const list = await request(origin, '/Items?Recursive=true&IncludeItemTypes=Series,Season,Episode&Fields=Path');
    assert.equal(list.status, 200); assert.equal(list.bodyJson.Items.length, entries.length);
    const values = {};
    for (const entry of entries) {
      const matches = list.bodyJson.Items.filter(item => item.Path === entry.path);
      assert.equal(matches.length, 1, entry.key + ' must be resolved from its actual filesystem path exactly once.');
      const id = idKey(matches[0].Id);
      if (ids[entry.key]) assert.equal(id, ids[entry.key], 'A cold/runtime transfer must retain the item identity.');
      else ids[entry.key] = id;
    }
    assert.equal(new Set(Object.values(ids)).size, entries.length);
    for (const entry of entries) {
      const detail = await request(origin, '/Items/' + ids[entry.key]); assert.equal(detail.status, 200);
      const item = detail.bodyJson;
      assert.equal(item.Type, entry.type); assert.equal(item.Name, entry.name); assert.equal(item.Path, entry.path);
      assert.equal(item.Overview, overviews[entry.key] ?? entry.overview);
      assert.deepEqual(item.Genres, [input.genre]); assert.deepEqual(item.Tags, [input.tag]);
      if (entry.type === 'Series') assert.equal(item.ProviderIds.Tvdb, input.series.tvdb);
      else {
        assert.equal(idKey(item.ParentId), ids[entry.parent]); assert.equal(idKey(item.SeriesId), ids.series);
        assert.equal(item.IndexNumber, entry.number); assert.equal(item.SeriesName, input.series.name);
      }
      if (entry.type === 'Episode') {
        assert.equal(idKey(item.SeasonId), ids[entry.parent]); assert.equal(item.ParentIndexNumber, entry.seasonNumber);
        assert.ok(item.RunTimeTicks > 0); assert.ok(item.Container);
        assert.ok(item.MediaStreams.some(stream => stream.Type === 'Video' && stream.Width === 32 && stream.Height === 32));
        assert.ok(item.MediaStreams.some(stream => stream.Type === 'Audio' && stream.Channels === 1));
      }
      values[entry.key] = publicItem(item);
    }
    const seasonIds = input.seasons.map(value => ids[value.key]);
    const ordered = continued ? [ids.episode1, ids.episode2, ids.episode3] : [ids.episode1, ids.episode2];
    const shows = {};
    for (const [key, route, expected, count] of [
      ['seasons', '/Shows/' + ids.series + '/Seasons', seasonIds, seasonIds.length],
      ['specials', '/Shows/' + ids.series + '/Episodes?seasonId=' + ids.specials, [ids.special1], 1],
      ['seasonById', '/Shows/' + ids.series + '/Episodes?seasonId=' + ids.season1, ordered, ordered.length],
      ['seasonByNumber', '/Shows/' + ids.series + '/Episodes?season=1', ordered, ordered.length],
      ['page', '/Shows/' + ids.series + '/Episodes?season=1&startIndex=1&limit=1', [ids.episode2], ordered.length],
    ]) {
      const result = await request(origin, route); assert.equal(result.status, 200);
      const observed = { ids: result.bodyJson.Items.map(item => idKey(item.Id)), total: result.bodyJson.TotalRecordCount };
      assert.deepEqual(observed, { ids: expected, total: count }); shows[key] = observed;
    }
    return { items: values, shows };
  };
  const editOverview = async (origin, key, overview) => {
    const before = await request(origin, '/Items/' + ids[key]); assert.equal(before.status, 200);
    assert.equal((await request(origin, '/Items/' + ids[key], { method: 'POST',
      body: { ...before.bodyJson, Overview: overview } })).status, 204);
  };
  const withSqlite = async (filename, operation) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(sqlite); } finally { sqlite.close(); sqlite = undefined; }
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; secrets.add(token); output.addSecret(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryStructureController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'Jellyfin.Api/Controllers/TvShowsController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Emby.Server.Implementations/Library/Resolvers/TV/SeriesResolver.cs',
      'Emby.Server.Implementations/Library/Resolvers/TV/SeasonResolver.cs',
      'Emby.Server.Implementations/Library/Resolvers/TV/EpisodeResolver.cs',
      'MediaBrowser.Controller/Entities/TV/Series.cs', 'MediaBrowser.Controller/Entities/TV/Season.cs',
      'MediaBrowser.Controller/Entities/TV/Episode.cs', 'MediaBrowser.Controller/IO/LocalMediaProxy.cs',
      'MediaBrowser.XbmcMetadata/Providers/BaseNfoProvider.cs', 'MediaBrowser.XbmcMetadata/Providers/EpisodeNfoProvider.cs',
      'MediaBrowser.XbmcMetadata/Savers/EpisodeNfoSaver.cs',
      'MediaBrowser.XbmcMetadata/Savers/SeasonNfoSaver.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, nativePort);
    report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    media = await prepareMedia(root); report.media = media;
    proxy = await startMediaProxy({ root, media }); report.mediaProxy = proxy.report;
    report.mountContract = await configureStorage(root);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-empty-library', origin: nativeOrigin });
    await native.ready();
    for (const task of await idleTasks(nativeOrigin)) assert.equal((await request(nativeOrigin,
      '/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const quiet = await request(nativeOrigin, '/ScheduledTasks'); assert.equal(quiet.status, 200);
    assert.ok(quiet.bodyJson.length && quiet.bodyJson.every(task => task.Triggers.length === 0));
    const options = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false,
      SaveLocalMetadata: true, MetadataSavers: ['Nfo'], AutomaticRefreshIntervalDays: 0, EnableEmbeddedEpisodeInfos: false,
      EnableChapterImageExtraction: false, ExtractChapterImagesDuringLibraryScan: false,
      EnableTrickplayImageExtraction: false, ExtractTrickplayImagesDuringLibraryScan: false,
      SeasonZeroDisplayName: 'Specials', PathInfos: [{ Path: media.root }],
      TypeOptions: ['Series', 'Season', 'Episode', 'Genre', 'MusicGenre', 'Studio', 'Person', 'Folder', 'CollectionFolder']
        .map(Type => ({ Type, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [],
          ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [] })) };
    assert.equal((await request(nativeOrigin, '/Library/VirtualFolders?name=' + encodeURIComponent(input.libraryName)
      + '&collectionType=tvshows&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: options } })).status, 204);
    report.nativeEmptyScan = await scan(nativeOrigin);
    const empty = await request(nativeOrigin, '/Items?Recursive=true&IncludeItemTypes=Series,Season,Episode');
    assert.equal(empty.status, 200); assert.deepEqual(empty.bodyJson.Items, []);
    await stopNative('native-empty-library');
    const baseline = path.join(root, 'empty-native.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), baseline);
    report.instanceBinding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(baseline)) };
    database = await createPostgresTestDatabase(null, 'tv_exchange');
    await withSqlite(baseline, async source => {
      report.snapshots.nativeEmpty = await completeSnapshot(source);
      report.importReceipt = await transferDatabase(source, database,
        { instanceBinding: report.instanceBinding, portableMountContract: report.mountContract });
    });
    report.snapshots.postgresEmpty = await completeSnapshot(database);
    assert.deepEqual(report.snapshots.postgresEmpty, report.snapshots.nativeEmpty);
    await materialize(media); report.filesInput = await assertFiles(media);
    await startNode(database);
    report.nodeScan = await scan(nodeOrigin);
    report.nodeScanned = await observe(nodeOrigin);
    report.nodeRowsScanned = await assertPersisted(database, media, ids);
    await editOverview(nodeOrigin, 'episode1', input.nodeOverview);
    const nodeOverviews = { episode1: input.nodeOverview };
    report.nodeEdited = await observe(nodeOrigin, { overviews: nodeOverviews });
    await stopNode('node-before-cold-start');
    report.nodeFiles = await assertFiles(media, { overviews: nodeOverviews });
    const schema = database.schemaName; await database.close();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    await startNode(database);
    report.nodeCold = await observe(nodeOrigin, { overviews: nodeOverviews });
    assert.deepEqual(report.nodeCold, report.nodeEdited, 'A full PG connection and runtime reopen must retain the public TV result.');
    await stopNode('node-cold-start');
    report.nodeRows = await assertPersisted(database, media, ids);
    report.snapshots.nodeClosed = await completeSnapshot(database);
    const exported = path.join(root, 'node-export.db');
    report.exportReceipt = await exportCurrentSqlite(database, exported); assert.equal(report.exportReceipt.verified, true);
    await withSqlite(exported, async source => {
      report.snapshots.nodeExport = await completeSnapshot(source);
      assert.deepEqual(report.snapshots.nodeExport, report.snapshots.nodeClosed);
      assert.deepEqual(await assertPersisted(source, media, ids), report.nodeRows);
    });
    await installStoppedExport(root, instanceRoot, exported);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-continuation', origin: nativeOrigin });
    await native.ready(); await idleTasks(nativeOrigin);
    report.nativeImported = await observe(nativeOrigin, { overviews: nodeOverviews });
    assert.deepEqual(report.nativeImported, report.nodeCold, 'The actual Native consumer must read the Node-created TV graph and public probe metadata.');
    report.nativeImportedFiles = await assertFiles(media, { overviews: nodeOverviews });
    report.declaredNfoEdit = await changeNodeNfoForNative(media);
    await materialize(media, true);
    report.nativeScan = await scan(nativeOrigin);
    const nativeReadOverviews = { episode1: input.nativeReadOverview };
    report.nativeScanned = await observe(nativeOrigin, { continued: true, overviews: nativeReadOverviews });
    await editOverview(nativeOrigin, 'season1', input.nativeSeasonOverview);
    const returnedOverviews = { ...nativeReadOverviews, season1: input.nativeSeasonOverview };
    report.nativeContinued = await observe(nativeOrigin, { continued: true, overviews: returnedOverviews });
    assert.ok(proxy.report.requests.some(value => value.filename === media.continued.path
      && value.method === 'GET' && [200, 206].includes(value.status)), 'Native must actually read the newly added media source.');
    await stopNative('native-continuation');
    report.nativeFiles = await assertFiles(media, { continued: true, overviews: returnedOverviews });
    const returned = path.join(root, 'native-returned.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returned);
    returnedDatabase = await createPostgresTestDatabase(null, 'tv_returned');
    await withSqlite(returned, async source => {
      report.snapshots.nativeReturned = await completeSnapshot(source);
      report.nativeRows = await assertPersisted(source, media, ids, true);
      report.reimportReceipt = await transferDatabase(source, returnedDatabase,
        { instanceBinding: report.instanceBinding, portableMountContract: report.mountContract });
    });
    report.snapshots.freshPostgres = await completeSnapshot(returnedDatabase);
    assert.deepEqual(report.snapshots.freshPostgres, report.snapshots.nativeReturned,
      'Every business table, relationship order, EF history and identity sequence must survive the fresh-PG import.');
    assert.deepEqual(await assertPersisted(returnedDatabase, media, ids, true), report.nativeRows);
    await startNode(returnedDatabase);
    report.freshNode = await observe(nodeOrigin, { continued: true, overviews: returnedOverviews });
    assert.deepEqual(report.freshNode, report.nativeContinued, 'A fresh Node runtime must read Native-created Episode and Season edits.');
    await stopNode('node-after-native-continuation');
    report.freshNodeFiles = await assertFiles(media, { continued: true, overviews: returnedOverviews });
    assert.deepEqual(report.freshNodeFiles, report.nativeFiles, 'Reading the returned TV graph must retain all media and NFO bytes.');
    assert.deepEqual(report.errors, []); assert.deepEqual(proxy.report.errors, []);
    report.identities = ids;
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, code: error.code, message: error.message } });
    } };
    await attempt(() => stopNative('native-finally'));
    await attempt(() => stopNode('node-finally'));
    await attempt(() => { sqlite?.close(); sqlite = undefined; });
    if (!runtime) {
      await attempt(async () => { await dropPostgresTestDatabase(returnedDatabase); report.cleanup.push({ name: 'returned-postgres', dropped: Boolean(returnedDatabase) }); });
      await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'initial-postgres', dropped: Boolean(database) }); });
    } else {
      safeToRemove = false;
      await attempt(() => returnedDatabase?.close()); await attempt(() => database?.close());
      report.cleanup.push({ name: 'postgres', dropped: false, reason: 'The owned runtime did not confirm closure.' });
    }
    await attempt(async () => {
      if (!proxy) return;
      await proxy.close();
      const released = await portAvailable(5244);
      report.cleanup.push({ name: 'native-media-proxy', closed: proxy.report.closed, portAvailable: released });
      assert.ok(proxy.report.closed && released); proxy = undefined;
    });
    await attempt(() => current?.finish());
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes),
      nativeInput: current?.preparation, sourceBindings: report.sourceBindings,
      actualNativeHttp: Boolean(report.nativeImported && report.nativeContinued),
      productionPostgresRuntime: Boolean(report.nodeScan && report.nodeCold && report.freshNode),
      completeLibraryVerified: false, fullInstanceVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || proxy) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('An owned TV runtime did not release its private exchange root.');
    }
  }
  if (failure) throw output.publicError(failure);
});
