import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase, exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { runNativeCompleteLibraryScan } from '../../src/migration/complete-library-verifier.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { assertRemoved, completeSnapshot, databaseFilename, idKey, installStoppedExport,
  itemSnapshot, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const mediaLease = declareFileTestResource('native-media-5244', { enabled: Boolean(enabled) });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const inputBytes = await readFile(new URL('./fixtures/mixed-library-exchange/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const sourceAssets = {
  book: await readFile(new URL('../metadata/fixtures/book-opf-current/assets/main/epub/rich-both-separators.epub', import.meta.url)),
  photo: await readFile(new URL('../metadata/fixtures/photo-provider/assets/plain.jpg', import.meta.url)),
};
for (const [kind, bytes] of Object.entries(sourceAssets)) {
  assert.equal(bytes.length, input[kind].bytes); assert.equal(sha(bytes), input[kind].sha256);
}

const projectItem = item => Object.fromEntries([
  ...['Id', 'ParentId'].map(key => [key, item[key] ? idKey(item[key]) : null]),
  ...['Name', 'Type', 'Path', 'Overview', 'MediaType', 'Width', 'Height', 'SeriesName', 'PrimaryImageAspectRatio',
    'Genres', 'Tags', 'ProviderIds'].map(key => [key, item[key] ?? null]),
  ['IsFavorite', item.UserData?.IsFavorite ?? null],
]);
const decodedImage = async bytes => {
  const { data, info } = await sharp(bytes, { failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels,
    bytes: data.length, sha256: sha(data), base64: data.toString('base64') };
};

test('mixed Books and Photos share real scans, cold reads, deletion, complete exchange and Native continuation', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(() => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'mixed-library-exchange-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), mediaRoot = path.join(root, 'media');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { requests: [], scans: [], snapshots: {}, libraryConfigurations: [], cleanup: [], errors: [], inputSha256: sha(inputBytes),
    scope: 'Two bounded physical Book and Photo libraries in one full production scan and exchange chain.',
    completeLibraryVerified: false, fullInstanceVerified: false, productionScaleVerified: false,
    phaseAcceptance: false, releaseAcceptance: false };
  let current, native, runtime, database, returnedDatabase, sqlite, proxy, token, failure, safeToRemove = true;
  const identities = {};
  const files = input.files.map(file => ({ ...file, filename: path.join(mediaRoot, file.path), expected: input[file.asset],
    contentType: file.type === 'Book' ? 'application/epub+zip' : 'image/jpeg' }));
  const request = async (route, { method = 'GET', body, binary = false, range, cleanup = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const response = await fetch(origin + route, { method,
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: `MediaBrowser Token="${token}"`, Accept: binary ? '*/*' : 'application/json',
        ...(range ? { Range: range } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const result = { status: response.status, headers: Object.fromEntries(response.headers),
      bytes: bytes.length, sha256: sha(bytes), ...(binary ? { base64: bytes.toString('base64') } : { bodyText: bytes.toString('utf8') }) };
    if (!binary && bytes.length) { try { result.bodyJson = JSON.parse(result.bodyText); } catch { /* Preserve the real response. */ } }
    report.requests.push({ route, method, ...(range ? { range } : {}), ...(body === undefined ? {} : { body }), response: result });
    return result;
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.bodyJson.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.bodyJson;
      assert.ok(performance.now() < deadline, 'The actual task owners must drain before an exchange boundary.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const scan = async label => {
    await idle();
    const result = await runNativeCompleteLibraryScan({ baseUrl: origin, accessToken: token, signal: t.signal,
      scanTimeoutMs: 180000, pollIntervalMs: 100 });
    const observed = await request('/ScheduledTasks/' + result.taskId); assert.equal(observed.status, 200);
    report.scans.push({ label, result, observed: observed.bodyJson }); await idle();
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status, () => portAvailable(port));
    report.cleanup.push({ label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const stopNode = async label => {
    if (!runtime) return;
    const listeners = runtime.networkHost.listeners;
    await runtime.close(); runtime = undefined;
    assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
    report.cleanup.push({ label, runtimeClosed: true, portAvailable: true });
  };
  const startNode = async target => {
    t.signal.throwIfAborted();
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') },
      onError: error => report.errors.push({ name: error.name, code: error.code, message: error.message }) });
    assert.ok(runtime.networkHost.listeners.some(listener => listener.scheme === 'http' && listener.port === port)); await idle();
  };
  const withSqlite = async (filename, operation) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(sqlite); } finally { sqlite.close(); sqlite = undefined; }
  };
  const materialize = async additions => {
    for (const file of files.filter(file => Boolean(file.nativeAddition) === additions)) {
      await mkdir(path.dirname(file.filename), { recursive: true });
      await writeFile(file.filename, sourceAssets[file.asset], { flag: 'wx' });
    }
  };
  const assertSources = async present => {
    const observed = [];
    for (const file of files) {
      if (!present.includes(file.key)) {
        await assert.rejects(access(file.filename), { code: 'ENOENT' }); observed.push({ key: file.key, absent: true });
      } else {
        const bytes = await readFile(file.filename); assert.deepEqual(bytes, sourceAssets[file.asset]);
        observed.push({ key: file.key, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
    return observed;
  };
  const observeLibraries = async phase => {
    const response = await request('/Library/VirtualFolders');
    assert.equal(response.status, 200); assert.ok(Array.isArray(response.bodyJson));
    report.libraryConfigurations.push({ phase, libraries: response.bodyJson });
    for (const expected of input.libraries) {
      const matches = response.bodyJson.filter(library => library.Name === expected.name);
      assert.equal(matches.length, 1, expected.name);
      const actual = matches[0], location = path.join(mediaRoot, expected.directory);
      assert.equal(actual.CollectionType, expected.type, expected.name);
      assert.deepEqual(actual.Locations, [location]);
      assert.deepEqual(actual.LibraryOptions.PathInfos.map(info => info.Path), [location]);
      assert.equal(actual.LibraryOptions.EnablePhotos, true);
      assert.equal(actual.LibraryOptions.EnableRealtimeMonitor, false);
      assert.equal(actual.LibraryOptions.EnableInternetProviders, false);
      assert.equal(actual.LibraryOptions.SaveLocalMetadata, false);
      assert.deepEqual(actual.LibraryOptions.MetadataSavers, []);
    }
  };
  const observe = async (present, phase) => {
    await observeLibraries(phase);
    const list = await request('/Items?Recursive=true&IncludeItemTypes=Book,Photo&Fields=Path,PrimaryImageAspectRatio');
    assert.equal(list.status, 200); assert.equal(list.bodyJson.Items.length, present.length);
    const result = {};
    for (const file of files) {
      const matches = list.bodyJson.Items.filter(item => item.Path === file.filename);
      if (!present.includes(file.key)) {
        assert.deepEqual(matches, []);
        if (identities[file.key]) assert.equal((await request('/Items/' + identities[file.key])).status, 404);
        continue;
      }
      assert.equal(matches.length, 1, file.key);
      const id = idKey(matches[0].Id);
      if (identities[file.key]) assert.equal(id, identities[file.key]); else identities[file.key] = id;
      const detail = await request('/Items/' + id); assert.equal(detail.status, 200);
      const item = detail.bodyJson;
      assert.equal(item.Type, file.type); assert.equal(item.Path, file.filename);
      assert.equal(item.MediaType, file.type);
      if (file.type === 'Book') {
        assert.equal(item.Name, input.book.name); assert.equal(item.Overview, input.book.overview);
        assert.equal(item.SeriesName, ' Series '); assert.equal(item.ProviderIds.ISBN, '978-123');
      } else {
        assert.equal(item.Width, input.photo.width); assert.equal(item.Height, input.photo.height);
        const parent = await request('/Items/' + item.ParentId); assert.equal(parent.status, 200);
        assert.equal(parent.bodyJson.Type, 'PhotoAlbum'); assert.equal(parent.bodyJson.Path, path.dirname(file.filename));
      }
      const raw = await request('/Items/' + id + '/File', { binary: true });
      assert.equal(raw.status, 200); assert.equal(raw.bytes, file.expected.bytes); assert.equal(raw.sha256, file.expected.sha256);
      assert.equal(raw.headers['content-type']?.split(';')[0], file.contentType);
      const partial = await request('/Items/' + id + '/File', { binary: true, range: 'bytes=1-15' });
      assert.equal(partial.status, 206); assert.equal(partial.sha256, sha(sourceAssets[file.asset].subarray(1, 16)));
      assert.equal(partial.headers['content-range'], `bytes 1-15/${file.expected.bytes}`);
      const image = await request('/Items/' + id + '/Images/Primary?format=Png', { binary: true });
      assert.equal(image.status, 200); assert.equal(image.headers['content-type']?.split(';')[0], 'image/png');
      let preview;
      if (file.type === 'Book') {
        assert.equal(image.bytes, input.book.coverBytes); assert.equal(image.sha256, input.book.coverSha256);
        preview = { bytes: image.bytes, sha256: image.sha256 };
      } else {
        const pixels = await decodedImage(Buffer.from(image.base64, 'base64'));
        assert.equal(pixels.width, input.photo.width); assert.equal(pixels.height, input.photo.height);
        assert.deepEqual(pixels, await decodedImage(sourceAssets.photo));
        preview = { contentType: 'image/png', pixels };
      }
      result[file.key] = { item: projectItem(item), original: { bytes: raw.bytes, sha256: raw.sha256 },
        image: preview };
    }
    return result;
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token); secrets.add(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/ItemUpdateController.cs', 'Jellyfin.Api/Controllers/LibraryStructureController.cs',
      'Jellyfin.Api/Controllers/ImageController.cs', 'src/Jellyfin.Drawing/ImageProcessor.cs',
      'MediaBrowser.Model/Entities/CollectionTypeOptions.cs',
      'Emby.Server.Implementations/Library/LibraryManager.cs', 'Emby.Server.Implementations/Library/Resolvers/Books/BookResolver.cs',
      'Emby.Server.Implementations/Library/Resolvers/PhotoResolver.cs', 'Emby.Server.Implementations/Library/Resolvers/PhotoAlbumResolver.cs',
      'MediaBrowser.Providers/Books/OpenPackagingFormat/EpubProvider.cs', 'MediaBrowser.Providers/Books/OpenPackagingFormat/EpubImageProvider.cs',
      'MediaBrowser.Providers/Books/BookMetadataService.cs', 'Emby.Photos/PhotoProvider.cs']);
    report.assetInputs = Object.entries(sourceAssets).map(([kind, bytes]) => ({ kind, bytes: bytes.length,
      sha256: sha(bytes), base64: bytes.toString('base64') }));
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    for (const library of input.libraries) await mkdir(path.join(mediaRoot, library.directory), { recursive: true });
    proxy = await startOwnedMediaProxy(files); report.proxy = proxy.report;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-empty-mixed', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const administrator = await request('/Users/' + current.userId); assert.equal(administrator.status, 200);
    assert.equal((await request('/Users/' + current.userId + '/Policy', { method: 'POST',
      body: { ...administrator.bodyJson.Policy, EnableContentDeletion: true } })).status, 204);
    for (const library of input.libraries) {
      const options = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false,
        SaveLocalMetadata: false, MetadataSavers: [], AutomaticRefreshIntervalDays: 0, EnablePhotos: true,
        EnableChapterImageExtraction: false, ExtractChapterImagesDuringLibraryScan: false,
        EnableTrickplayImageExtraction: false, ExtractTrickplayImagesDuringLibraryScan: false,
        PathInfos: [{ Path: path.join(mediaRoot, library.directory) }] };
      assert.equal((await request('/Library/VirtualFolders?name=' + encodeURIComponent(library.name)
        + '&collectionType=' + library.type + '&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: options } })).status, 204);
    }
    await scan('native-empty-mixed'); await observeLibraries('native-empty-mixed'); await stopNative('native-empty-mixed');
    const baseline = path.join(root, 'native-empty.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), baseline);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const ancestors = path.join(root, 'empty-ignore-ancestors'); await mkdir(ancestors);
    report.mountContract = { mounts: [{ mountId: 'mixed-exchange', identityRoot: root, accessRoot: '/mixed-exchange',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'mixed-exchange', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/mixed-exchange', instanceId: 'mixed-exchange', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
      { path: '/empty-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/mixed-exchange', style, caseSensitive,
        returnAccess: 'Owned Book, Photo and instance files retained for the actual Native continuation.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ignore-ancestors', style, caseSensitive,
        returnAccess: 'Only the declared empty ancestors belong to this isolated exchange.' }],
    }, null, 2) + '\n', { flag: 'wx' });
    report.binding = { serverId: current.preparation.nativeServerId, originIdentityDigest: sha(await readFile(baseline)) };
    database = await createPostgresTestDatabase(null, 'mixed_exchange');
    await withSqlite(baseline, async source => {
      report.snapshots.nativeEmpty = await completeSnapshot(source);
      report.imported = await transferDatabase(source, database, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    });
    assert.deepEqual(await completeSnapshot(database), report.snapshots.nativeEmpty);
    await materialize(false); await startNode(database); await scan('node-book-and-photo-first-scan');
    report.nodeScannedRows = await database.rows('BaseItems', { whereIn: { Path: [...new Set(files.flatMap(file =>
      [file.filename, path.dirname(file.filename)]))] } });
    const initial = ['retainedBook', 'removedBook', 'retainedPhoto'];
    report.nodeScanned = await observe(initial, 'node-first-scan'); report.initialFiles = await assertSources(initial);
    assert.equal((await request('/UserFavoriteItems/' + identities.retainedBook, { method: 'POST' })).status, 200);
    assert.equal((await request('/Items/' + identities.removedBook, { method: 'DELETE' })).status, 204);
    const retained = ['retainedBook', 'retainedPhoto'];
    await scan('node-after-book-delete');
    report.nodeChanged = await observe(retained, 'node-after-book-delete'); report.nodeFiles = await assertSources(retained);
    assertRemoved(await itemSnapshot(database, [identities.removedBook]), identities.removedBook);
    await stopNode('node-before-cold');
    const beforeCold = await itemSnapshot(database, Object.values(identities));
    const schema = database.schemaName; await database.close();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    await startNode(database); report.nodeCold = await observe(retained, 'node-cold');
    assert.deepEqual(report.nodeCold, report.nodeChanged);
    assert.deepEqual(await itemSnapshot(database, Object.values(identities)), beforeCold);
    await stopNode('node-after-cold');
    report.snapshots.nodeClosed = await completeSnapshot(database);
    const exported = path.join(root, 'node-export.db'); report.exported = await exportCurrentSqlite(database, exported);
    assert.equal(report.exported.verified, true);
    await withSqlite(exported, async source => assert.deepEqual(await completeSnapshot(source), report.snapshots.nodeClosed));
    await installStoppedExport({ root, instanceRoot, exported });
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-mixed-continuation', origin });
    await native.ready(); await idle(); report.nativeImported = await observe(retained, 'native-imported');
    assert.deepEqual(report.nativeImported, report.nodeCold);
    await materialize(true); await scan('native-add-book-and-photo');
    const continued = [...retained, 'nativeBook', 'nativePhoto'];
    report.nativeContinued = await observe(continued, 'native-continued'); report.nativeFiles = await assertSources(continued);
    const favorite = await request('/Items/' + identities.retainedBook); assert.equal(favorite.bodyJson.UserData.IsFavorite, true);
    await stopNative('native-mixed-continuation');
    const returned = path.join(root, 'native-returned.db');
    await stoppedDatabase(databaseFilename(instanceRoot)); await copyFile(databaseFilename(instanceRoot), returned);
    returnedDatabase = await createPostgresTestDatabase(null, 'mixed_returned');
    await withSqlite(returned, async source => {
      report.snapshots.nativeReturned = await completeSnapshot(source);
      report.reimported = await transferDatabase(source, returnedDatabase, { instanceBinding: report.binding, portableMountContract: report.mountContract });
    });
    assert.deepEqual(await completeSnapshot(returnedDatabase), report.snapshots.nativeReturned);
    assertRemoved(await itemSnapshot(returnedDatabase, [identities.removedBook]), identities.removedBook);
    await startNode(returnedDatabase); report.freshNode = await observe(continued, 'node-reimported');
    assert.deepEqual(report.freshNode, report.nativeContinued);
    assert.equal((await request('/Items/' + identities.retainedBook)).bodyJson.UserData.IsFavorite, true);
    await stopNode('node-after-native-continuation');
    assert.deepEqual(await assertSources(continued), report.nativeFiles);
    for (const key of continued) assert.ok(proxy.report.requests.some(entry => entry.filename === files.find(file => file.key === key).filename
      && entry.method === 'GET' && entry.bodyBytes > 0 && entry.completed),
    'Native must read each real declared source through its owned proxy.');
  } catch (error) { failure = error; report.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, code: error.code, message: error.message } });
    } };
    await attempt(() => stopNative('native-finally')); await attempt(() => stopNode('node-finally'));
    await attempt(() => { sqlite?.close(); sqlite = undefined; });
    if (!runtime) {
      for (const target of [returnedDatabase, database]) await attempt(async () => {
        await dropPostgresTestDatabase(target); report.cleanup.push({ schema: target?.schemaName, removed: Boolean(target) });
      });
    } else { safeToRemove = false; await attempt(() => returnedDatabase?.close()); await attempt(() => database?.close()); }
    await attempt(async () => {
      if (proxy) { await proxy.close(); assert.equal(proxy.report.closed, true); assert.equal(await portAvailable(5244), true); proxy = undefined; }
    });
    await attempt(() => current?.finish());
    report.identities = identities; report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), nativeInput: current?.preparation,
      sourceBindings: report.sourceBindings, actualNativeContinuation: Boolean(report.nativeContinued),
      productionColdRead: Boolean(report.nodeCold), freshPostgresRuntime: Boolean(report.freshNode),
      completeLibraryVerified: false, fullInstanceVerified: false, productionScaleVerified: false,
      phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || proxy) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('An owned mixed-library runtime did not release its private root.');
    }
  }
  if (failure) throw output.publicError(failure);
}, { signal: t.signal }), { signal: t.signal }));
