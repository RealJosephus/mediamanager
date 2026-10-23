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
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { addOpaquePreparation, assertAssets, assertRemoved, assertUserDataRetention, completeSnapshot, createMedia, databaseFilename,
  idKey, imageFiles, input, inputBytes, installStoppedExport, itemSnapshot, photoBytes,
  portAvailable, removeSyntheticPreparation, responseProjection, sha, stoppedDatabase, unusedPort,
  userDataSnapshot } from './fixtures/item-deletion-exchange/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;

test('Item DELETE committed prefix survives complete SQLite export, actual Native continuation and fresh PostgreSQL reimport', {
  skip: !enabled, timeout: 720000,
}, async () => {
  const destination = path.join(validationOutputRoot(), 'item-deletion-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance');
  const nativePort = await unusedPort(), nativeOrigin = `http://127.0.0.1:${nativePort}`;
  const report = { schemaVersion: 1, inputSha256: sha(inputBytes), photoSha256: sha(photoBytes),
    requests: [], snapshots: {}, cleanup: [], errors: [], phaseAcceptance: false, releaseAcceptance: false,
    completeLibraryVerified: false, fullInstanceVerified: false,
    scope: 'Four actual scanned Photo items; real Native and Node HTTP deletion with a committed batch prefix, 31 business tables and both EF tables, unchanged unknown Data and declared assets, actual Native edit and deletion, fresh-PG reimport. No full-library, arbitrary Folder/owned/version, state-package or production-scale claim.' };
  let current, native, runtime, database, returnedDatabase, sqlite, failure, safeToRemove = true;
  let nodeOrigin, token, ids, media, opaque, images, initialSurvivors, initialUserData;
  const request = async (origin, route, { method = 'GET', body, raw, contentType } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: 'application/json',
        ...(body === undefined && raw === undefined ? {} : { 'Content-Type': contentType ?? 'application/json' }) },
      ...(raw === undefined ? body === undefined ? {} : { body: JSON.stringify(body) } : { body: raw }) });
    const bodyText = await response.text();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Preserve text and empty responses. */ }
    const result = { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
    report.requests.push({ origin, route, method, ...(body === undefined ? {} : { body }),
      ...(raw === undefined ? {} : { rawBytes: Buffer.byteLength(raw), rawSha256: sha(raw) }), response: result });
    return result;
  };
  const stopNative = async label => {
    if (!native) return;
    const process = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { method: 'POST' })).status,
      () => portAvailable(nativePort));
    report.cleanup.push({ name: label, ...process });
    safeToRemove &&= process.pidGone;
    if (process.pidGone) native = undefined;
    assert.ok(process.cleanShutdown && process.pidGone && process.portAvailable, label);
  };
  const stopNode = async label => {
    if (!runtime) return;
    const port = runtime.server.address()?.port;
    await runtime.close(); runtime = undefined;
    const released = port === undefined || await portAvailable(port);
    report.cleanup.push({ name: label, runtimeClosed: true, portAvailable: released });
    assert.ok(released);
  };
  const idleTasks = async origin => {
    const deadline = Date.now() + 90000;
    while (true) {
      const tasks = await request(origin, '/ScheduledTasks'); assert.equal(tasks.status, 200);
      if (tasks.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return tasks.bodyJson;
      assert.ok(Date.now() < deadline, 'Actual scheduled workers must finish before the transfer boundary.');
      await delay(100);
    }
  };
  const readItems = async (origin, absent, overview = input.initialOverview) => {
    const values = [];
    for (const [index, id] of ids.entries()) {
      const value = await request(origin, '/Items/' + id);
      assert.equal(value.status, absent.includes(index) ? 404 : 200);
      if (!absent.includes(index)) {
        assert.equal(idKey(value.bodyJson.Id), id);
        assert.equal(value.bodyJson.Path, media.files[index]);
        assert.equal(value.bodyJson.Type, 'Photo');
        assert.equal(value.bodyJson.Overview, index === 2 ? overview : input.initialOverview);
        assert.deepEqual(value.bodyJson.ProviderIds, input.providerIds);
        assert.equal(value.bodyJson.UserData.IsFavorite, true);
      }
      values.push(value);
    }
    return values;
  };
  const startNode = async target => {
    const settings = await readInstanceConfiguration(instanceRoot);
    assert.equal(idKey(settings.serverId), idKey(current.preparation.nativeServerId));
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json'), MEDIAMANAGER_PORT: '0' },
      onError: error => report.errors.push({ name: error.name, message: error.message, code: error.code }) });
    nodeOrigin = `http://127.0.0.1:${runtime.server.address().port}`;
    await idleTasks(nodeOrigin);
  };
  const captureSqlite = async (label, filename) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try {
      const full = await completeSnapshot(sqlite);
      report.snapshots[label] = { full, items: await itemSnapshot(sqlite, ids) };
      return full;
    } finally { sqlite.close(); sqlite = undefined; }
  };
  const assertOpaque = snapshot => {
    const row = snapshot.items.find(item => item.id === ids[3]);
    assert.equal(row.dataHex, opaque.dataHex, 'The untouched item must preserve the complete raw Data TEXT, including unknown members.');
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); secrets.add(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'Jellyfin.Api/Controllers/LibraryStructureController.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'MediaBrowser.Controller/Entities/Photo.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs',
      'Emby.Server.Implementations/Library/Resolvers/PhotoResolver.cs', 'Jellyfin.Api/Controllers/ImageController.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, nativePort);
    report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    media = await createMedia(root);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-preparation', origin: nativeOrigin });
    await native.ready();
    const registered = await idleTasks(nativeOrigin);
    for (const task of registered) assert.equal((await request(nativeOrigin, '/ScheduledTasks/' + task.Id + '/Triggers',
      { method: 'POST', body: [] })).status, 204);
    const quietTasks = await request(nativeOrigin, '/ScheduledTasks');
    assert.equal(quietTasks.status, 200);
    assert.ok(quietTasks.bodyJson.length && quietTasks.bodyJson.every(task => task.Triggers.length === 0));
    const administrator = await request(nativeOrigin, '/Users/' + current.userId);
    assert.equal(administrator.status, 200);
    assert.equal((await request(nativeOrigin, '/Users/' + current.userId + '/Policy', { method: 'POST',
      body: { ...administrator.bodyJson.Policy, EnableContentDeletion: true } })).status, 204);
    const libraryOptions = { Enabled: true, EnablePhotos: true, EnableRealtimeMonitor: false, EnableInternetProviders: false,
      SaveLocalMetadata: false, AutomaticRefreshIntervalDays: 0, MetadataSavers: [],
      PathInfos: [{ Path: media.root }],
      TypeOptions: ['Photo', 'PhotoAlbum', 'Folder', 'CollectionFolder'].map(Type => ({ Type,
        MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [] })) };
    assert.equal((await request(nativeOrigin, '/Library/VirtualFolders?name=' + encodeURIComponent(input.libraryName)
      + '&collectionType=photos&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: libraryOptions } })).status, 204);
    const beforeScan = (await idleTasks(nativeOrigin)).find(task => task.Key === 'RefreshLibrary');
    assert.ok(beforeScan);
    assert.equal((await request(nativeOrigin, '/ScheduledTasks/Running/' + beforeScan.Id, { method: 'POST' })).status, 204);
    const deadline = Date.now() + 120000;
    while (true) {
      const scan = await request(nativeOrigin, '/ScheduledTasks/' + beforeScan.Id); assert.equal(scan.status, 200);
      if (scan.bodyJson.State === 'Idle' && scan.bodyJson.LastExecutionResult
        && scan.bodyJson.LastExecutionResult.StartTimeUtc !== beforeScan.LastExecutionResult?.StartTimeUtc) {
        assert.equal(scan.bodyJson.LastExecutionResult.Status, 'Completed'); report.scan = scan.bodyJson; break;
      }
      assert.ok(Date.now() < deadline, 'The actual Native photo scan must complete a new execution.'); await delay(100);
    }
    const listed = await request(nativeOrigin, '/Items?Recursive=true&IncludeItemTypes=Photo&Fields=Path,Overview,Tags,ProviderIds,Settings,Genres');
    assert.equal(listed.status, 200); assert.equal(listed.bodyJson.Items.length, input.photos.length);
    const photos = media.files.map(filename => {
      const matches = listed.bodyJson.Items.filter(item => item.Path === filename);
      assert.equal(matches.length, 1); return matches[0];
    });
    ids = photos.map(photo => idKey(photo.Id)); media.ids = ids;
    assert.equal(new Set(ids).size, input.photos.length); report.identities = photos;
    for (const photo of photos) {
      const detail = await request(nativeOrigin, '/Items/' + photo.Id); assert.equal(detail.status, 200);
      assert.equal((await request(nativeOrigin, '/Items/' + photo.Id, { method: 'POST', body: { ...detail.bodyJson,
        Overview: input.initialOverview, Genres: input.genres, Tags: input.tags, ProviderIds: input.providerIds,
        LockData: true, LockedFields: input.lockedFields } })).status, 204);
      assert.equal((await request(nativeOrigin, '/Items/' + photo.Id + '/Images/Banner', { method: 'POST',
        contentType: 'image/png', raw: photoBytes.toString('base64') })).status, 204);
      assert.equal((await request(nativeOrigin, '/UserFavoriteItems/' + photo.Id, { method: 'POST' })).status, 200);
    }
    await idleTasks(nativeOrigin);
    report.nativeInitialReads = await readItems(nativeOrigin, []);
    await stopNative('native-preparation');
    opaque = await addOpaquePreparation(instanceRoot, ids[3]); report.opaquePreparation = opaque;
    const sourceFilename = path.join(root, 'initial-native.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), sourceFilename);
    const initialFull = await captureSqlite('nativeInitial', sourceFilename);
    sqlite = new SqliteDatabase(sourceFilename, { readOnly: true, requireMigrationHistory: true });
    try {
      images = await imageFiles(sqlite, ids, instanceRoot, root); report.initialImages = images;
      for (const id of ids) {
        const selected = await itemSnapshot(sqlite, [id]);
        for (const table of ['AncestorIds', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValuesMap', 'UserData']) {
          assert.ok(selected.relations[table].length, `${table} must have a real Native-created relation for each photo.`);
        }
        assert.ok(images.some(image => image.itemId === id && image.imageType === 3), 'Actual image upload must create an internal Banner asset.');
      }
      initialSurvivors = await itemSnapshot(sqlite, ids.slice(1));
      initialUserData = await userDataSnapshot(sqlite, ids);
      report.initialUserData = initialUserData;
      assertOpaque(report.snapshots.nativeInitial.items);
      report.assetsBefore = await assertAssets(media, images, opaque, []);
      const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
      report.mountContract = { mounts: [{ mountId: 'item-deletion-exchange', identityRoot: root, accessRoot: '/deletion-exchange',
        pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
      const storage = { instances: [{ id: 'deletion-exchange', type: 'local', config: { root, writable: true } }],
        mounts: [{ path: '/deletion-exchange', instanceId: 'deletion-exchange', capabilities: {
          create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
        prefixes: [{ identityRoot: root, accessRoot: '/deletion-exchange', style, caseSensitive,
          returnAccess: 'The same isolated media and instance remain available to Native after PostgreSQL export.' }] };
      await writeFile(path.join(root, 'storage.json'), JSON.stringify(storage, null, 2) + '\n', { flag: 'wx' });
      report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(sourceFilename)) };
      database = await createPostgresTestDatabase(null, 'item_delete_export');
      report.importReceipt = await transferDatabase(sqlite, database, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    } finally { sqlite.close(); sqlite = undefined; }
    report.snapshots.postgresImported = await completeSnapshot(database);
    assert.deepEqual(report.snapshots.postgresImported, initialFull, 'Initial import must preserve every table, migration and sequence.');
    await startNode(database);
    report.nodeInitialReads = await readItems(nodeOrigin, []);
    const nodeDeletion = await request(nodeOrigin, '/Items?ids=' + [ids[0], ids[0], ids[1]].join(','), { method: 'DELETE' });
    assert.equal(nodeDeletion.status, 404);
    const nodeRemoved = await itemSnapshot(database, [ids[0]]); assertRemoved(nodeRemoved, [ids[0]]);
    const nodeSurvivors = await itemSnapshot(database, ids.slice(1));
    assert.deepEqual(nodeSurvivors, initialSurvivors, 'The failed second occurrence must leave the complete later-item rows and relations unchanged.');
    assertOpaque(nodeSurvivors);
    report.nodeAfterDelete = { removed: nodeRemoved, survivors: nodeSurvivors,
      userData: await assertUserDataRetention(database, initialUserData, [ids[0]]),
      assets: await assertAssets(media, images, opaque, [0]), reads: await readItems(nodeOrigin, [0]) };
    await stopNode('node-after-deletion');
    await database.close();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
    report.snapshots.nodeClosed = await completeSnapshot(database);
    const exported = path.join(root, 'node-export.db');
    report.exportReceipt = await exportCurrentSqlite(database, exported);
    assert.equal(report.exportReceipt.verified, true);
    const exportedFull = await captureSqlite('nodeExport', exported);
    assert.deepEqual(exportedFull, report.snapshots.nodeClosed, 'The stopped Node export must preserve the complete PostgreSQL state.');
    assertOpaque(report.snapshots.nodeExport.items);
    await installStoppedExport({ root, instanceRoot, exported });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-continuation', origin: nativeOrigin });
    await native.ready(); await idleTasks(nativeOrigin);
    report.nativeImportedReads = await readItems(nativeOrigin, [0]);
    report.nativeImportedAssets = await assertAssets(media, images, opaque, [0]);
    const nativeDeletion = await request(nativeOrigin, '/Items?ids=' + [ids[1], ids[1], ids[2]].join(','), { method: 'DELETE' });
    assert.equal(nativeDeletion.status, 404);
    assert.deepEqual(responseProjection(nodeDeletion), responseProjection(nativeDeletion),
      'Both real controllers must return the same public duplicate-after-commit response.');
    await readItems(nativeOrigin, [0, 1]);
    const edit = await request(nativeOrigin, '/Items/' + ids[2]); assert.equal(edit.status, 200);
    assert.equal((await request(nativeOrigin, '/Items/' + ids[2], { method: 'POST',
      body: { ...edit.bodyJson, Overview: input.continuedOverview } })).status, 204);
    report.nativeContinuedReads = await readItems(nativeOrigin, [0, 1], input.continuedOverview);
    await stopNative('native-continuation');
    report.nativeContinuedAssets = await assertAssets(media, images, opaque, [0, 1]);
    const returnedFilename = path.join(root, 'native-returned.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returnedFilename);
    const returnedFull = await captureSqlite('nativeReturned', returnedFilename);
    sqlite = new SqliteDatabase(returnedFilename, { readOnly: true, requireMigrationHistory: true });
    let returnedItems;
    try {
      report.nativeRemoved = await itemSnapshot(sqlite, ids.slice(0, 2)); assertRemoved(report.nativeRemoved, ids.slice(0, 2));
      report.nativeRetainedUserData = await assertUserDataRetention(sqlite, initialUserData, ids.slice(0, 2));
      returnedItems = await itemSnapshot(sqlite, ids.slice(2)); assertOpaque(returnedItems);
      assert.equal(returnedItems.items[0].item.Overview, input.continuedOverview);
      returnedDatabase = await createPostgresTestDatabase(null, 'item_delete_return');
      report.reimportReceipt = await transferDatabase(sqlite, returnedDatabase,
        { instanceBinding: report.binding, portableMountContract: report.mountContract });
    } finally { sqlite.close(); sqlite = undefined; }
    report.snapshots.postgresReimported = await completeSnapshot(returnedDatabase);
    assert.deepEqual(report.snapshots.postgresReimported, returnedFull,
      'A fresh PostgreSQL schema must retain the complete Native continuation, including relation order.');
    assert.deepEqual(await itemSnapshot(returnedDatabase, ids.slice(2)), returnedItems);
    assertRemoved(await itemSnapshot(returnedDatabase, ids.slice(0, 2)), ids.slice(0, 2));
    report.freshPostgresRetainedUserData = await assertUserDataRetention(returnedDatabase, initialUserData, ids.slice(0, 2));
    await startNode(returnedDatabase);
    report.freshNodeReads = await readItems(nodeOrigin, [0, 1], input.continuedOverview);
    assertOpaque(await itemSnapshot(returnedDatabase, [ids[3]]));
    report.freshNodeAssets = await assertAssets(media, images, opaque, [0, 1]);
    await stopNode('node-after-native-continuation');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, message: error.message } });
    } };
    await attempt(() => stopNative('native-finally'));
    await attempt(() => stopNode('node-finally'));
    await attempt(() => { sqlite?.close(); sqlite = undefined; });
    if (!runtime) {
      await attempt(async () => { await dropPostgresTestDatabase(returnedDatabase); report.cleanup.push({ name: 'returned-postgres', dropped: Boolean(returnedDatabase) }); });
      await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'initial-postgres', dropped: Boolean(database) }); });
    } else {
      safeToRemove = false;
      report.cleanup.push({ name: 'postgres', dropped: false, reason: 'The owned runtime has not confirmed closure.' });
      await attempt(() => returnedDatabase?.close());
      await attempt(() => database?.close());
    }
    await attempt(() => current?.finish());
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), photoSha256: sha(photoBytes),
      nativeInput: current?.preparation, sourceBindings: report.sourceBindings,
      actualNativeHttp: Boolean(report.nativeInitialReads && report.nativeContinuedReads),
      productionPostgresRuntime: Boolean(report.nodeAfterDelete && report.freshNodeReads),
      fullInstanceVerified: false, completeLibraryVerified: false, phaseAcceptance: false }, secrets));
    if (native || runtime) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('The owned runtime did not release its private exchange root.');
    }
  }
  if (failure) throw output.publicError(failure);
});
