import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { scanNativeRelationRows } from '../../src/database/native-relation-order.js';
import { canonicalCell } from '../../src/database/values.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { canonicalPortableMountContract } from '../../src/storage/portable-mount-contract.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { runNativeCompleteLibraryScan, verifyNativeCompleteLibrary } from '../../src/migration/complete-library-verifier.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { assertRemoved, databaseFilename, idKey, itemSnapshot, optionalFile,
  portAvailable, removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { projectItemBody, projectProblemTrace } from '../helpers/http-body-projection.js';
import { errorObservation as describeFailure } from '../helpers/error-observation.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
const inputBytes = await readFile(new URL('./fixtures/complete-library-instance/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const mediaBytes = await readFile(new URL('../fixtures/frozen-av/source.m2ts', import.meta.url));
assert.equal(mediaBytes.length, input.asset.bytes);
assert.equal(sha(mediaBytes), input.asset.sha256);

async function storageConfiguration(root) {
  const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
  const mountContract = { mounts: [{ mountId: 'complete-instance', identityRoot: root, accessRoot: '/complete-instance',
    pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
  const filename = path.join(root, 'storage.json');
  await writeFile(filename, JSON.stringify({
    instances: [{ id: 'complete-instance', type: 'local', config: { root, writable: true } },
      { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
    mounts: [{ path: '/complete-instance', instanceId: 'complete-instance', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
    { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/complete-instance', style, caseSensitive,
      returnAccess: 'The same CI-owned media identities remain available after whole-instance recovery.' }],
    ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
      returnAccess: 'Only declared CI-owned empty ancestors belong to this exchange.' }],
  }, null, 2) + '\n', { flag: 'wx' });
  return { filename, mountContract };
}

function libraryOptions(mediaRoot) {
  return { Enabled: true, PathInfos: [{ Path: mediaRoot }], EnableRealtimeMonitor: false,
    EnableInternetProviders: false, SaveLocalMetadata: false, MetadataSavers: [], AutomaticRefreshIntervalDays: 0,
    EnableLUFSScan: false, EnableEmbeddedEpisodeInfos: false, EnableChapterImageExtraction: false,
    ExtractChapterImagesDuringLibraryScan: false, EnableTrickplayImageExtraction: false,
    ExtractTrickplayImagesDuringLibraryScan: false,
    TypeOptions: ['Movie', 'Video', 'Trailer', 'Folder', 'CollectionFolder', 'Person'].map(Type => ({ Type,
      MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [],
      ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [] })) };
}

async function packageItemCells(originalDatabase, packagedDatabase, projectionOptions, signal) {
  const table = tableDefinition('BaseItems');
  const read = async database => {
    signal.throwIfAborted();
    const page = await scanNativeRelationRows(database, table.name, { limit: 128, consumer: 'exchange' });
    assert.ok(page.rows.length <= 128);
    const next = page.rows.length === 128
      ? await scanNativeRelationRows(database, table.name, { after: page.after, limit: 1, consumer: 'exchange' }) : null;
    return { rows: page.rows, truncated: Boolean(next?.rows.length) };
  };
  const raw = await read(originalDatabase), actual = await read(packagedDatabase);
  const rawRows = raw.rows, actualRows = actual.rows;
  const projector = createSqliteExportPathProjector(projectionOptions);
  const expectedRows = rawRows.map(row => projector.projectRow(table.name, row));
  const identity = row => table.primaryKey.map(name => canonicalCell(row[name]));
  const key = row => JSON.stringify(identity(row));
  const maps = [rawRows, expectedRows, actualRows].map(rows => new Map(rows.map(row => [key(row), row])));
  const keys = [...new Set(maps.flatMap(map => [...map.keys()]))];
  return { table: table.name, primaryKey: table.primaryKey, columns: table.columns.map(column => column.name),
    diagnosticRowLimit: 128, truncated: { raw: raw.truncated, expected: raw.truncated, actual: actual.truncated },
    observedRowCounts: { raw: rawRows.length, expected: expectedRows.length, actual: actualRows.length },
    insertionOrder: { raw: rawRows.map(identity), expected: expectedRows.map(identity), actual: actualRows.map(identity) },
    rows: keys.map(key => {
      const rows = maps.map(map => map.get(key));
      return { identity: JSON.parse(key), present: { raw: Boolean(rows[0]), expected: Boolean(rows[1]), actual: Boolean(rows[2]) },
        changedCells: table.columns.flatMap(column => {
          const cells = rows.map(row => row ? canonicalCell(row[column.name]) : null);
          if (JSON.stringify(cells[0]) === JSON.stringify(cells[1]) && JSON.stringify(cells[1]) === JSON.stringify(cells[2])) return [];
          return [{ column: column.name, raw: cells[0], expected: cells[1], actual: cells[2] }];
        }) };
    }) };
}

test('a whole CI-native instance completes real library verification and preserves Node mutations through package recovery and Native continuation', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(() => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'complete-library-instance-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), originalInstance = path.join(root, 'instance');
  const mediaRoot = path.join(root, 'media'), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const files = input.files.map(file => ({ ...file, filename: path.join(mediaRoot, file.name, file.name + '.m2ts'),
    expected: { bytes: mediaBytes.length, sha256: sha(mediaBytes) }, contentType: 'video/mp2t' }));
  const knownIds = {}, present = new Set(files.filter(file => file.phase === 'initial').map(file => file.key));
  const report = { schemaVersion: 1, scope: input.scope, inputSha256: sha(inputBytes), asset: input.asset,
    requests: [], scans: [], verifications: {}, snapshots: {}, shutdowns: [], assets: [], runtimeErrors: [], cleanup: {},
    completeLibraryVerified: false, fullInstanceVerified: false, productionScaleVerified: false,
    phaseAcceptance: false, releaseAcceptance: false };
  let current, native, runtime, database, fresh, sqlite, proxy, token, libraryId, failed = false, failure;
  let instanceRoot = originalInstance, phase = 'prepare';
  const setPhase = value => { phase = value; if (proxy) proxy.report.phase = value; };
  const request = async (route, { method = 'GET', body, binary = false, cleanup = false, anonymous = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const observed = { phase, route, method, anonymous, ...(body === undefined ? {} : { body }) }; report.requests.push(observed);
    const response = await fetch(origin + route, { method, redirect: 'error',
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { ...(anonymous ? {} : { Authorization: `MediaBrowser Token="${token}"` }), Accept: binary ? '*/*' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    observed.response = { status: response.status, headers: Object.fromEntries(response.headers),
      bytes: bytes.length, sha256: sha(bytes), ...(binary ? { base64: bytes.toString('base64') } : { bodyText: bytes.toString('utf8') }) };
    let value;
    if (!binary && bytes.length) try { value = JSON.parse(bytes.toString('utf8')); } catch { value = bytes.toString('utf8'); }
    return { status: response.status, value, bytes, contentType: response.headers.get('content-type') };
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.value.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.value;
      assert.ok(performance.now() < deadline, 'All actual task owners must settle before the exchange.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const scan = async label => {
    setPhase(label); await idle();
    const result = await runNativeCompleteLibraryScan({ baseUrl: origin, accessToken: token, signal: t.signal,
      scanTimeoutMs: 180000, pollIntervalMs: 100 });
    report.scans.push({ label, ...result }); await idle();
  };
  const stopNative = async label => {
    if (!native) return;
    const stopped = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.shutdowns.push({ label, ...stopped });
    if (stopped.pidGone) native = undefined;
    assert.equal(stopped.cleanShutdown, true); assert.equal(stopped.pidGone, true); assert.equal(stopped.portAvailable, true);
  };
  const startNative = async label => {
    setPhase(label); t.signal.throwIfAborted();
    await current.prepareClone(instanceRoot, port);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label, origin });
    await native.ready(); await idle();
  };
  const stopNode = async label => {
    if (!runtime) return;
    const active = runtime, listeners = active.networkHost.listeners;
    await active.close(); runtime = undefined;
    assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
    assert.equal(active.store.database.closed, true);
    report.shutdowns.push({ label, runtimeClosed: true, databaseClosed: true, portAvailable: true });
  };
  const startNode = async (target, label) => {
    setPhase(label);
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: target.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') }, onError: (error, context) => report.runtimeErrors.push({ phase,
        route: context?.request?.url, error: describeFailure(error) }) });
    assert.ok(runtime.networkHost.listeners.some(listener => listener.scheme === 'http' && listener.port === port)); await idle();
  };
  const stoppedSqlite = async (filename, operation) => {
    await stoppedDatabase(filename);
    sqlite = new SqliteDatabase(filename, { readOnly: true, requireMigrationHistory: true });
    try { return await operation(sqlite); } finally { sqlite.close(); sqlite = undefined; }
  };
  const materialize = async mediaPhase => {
    for (const file of files.filter(file => file.phase === mediaPhase)) {
      await mkdir(path.dirname(file.filename), { recursive: true });
      await writeFile(file.filename, mediaBytes, { flag: 'wx' }); present.add(file.key);
    }
  };
  const declaration = async target => {
    const items = [];
    for (const file of files.filter(file => present.has(file.key))) {
      const rows = await target.rows('BaseItems', { where: { Path: file.filename } });
      assert.equal(rows.length, 1, file.key + ' has exactly one real scanned row.');
      const row = rows[0];
      assert.equal(row.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
      if (knownIds[file.key]) assert.equal(idKey(row.Id), idKey(knownIds[file.key]));
      knownIds[file.key] = row.Id;
      items.push({ itemId: row.Id, identityPath: file.filename, identityRoot: mediaRoot,
        enumeration: { kind: 'native-filesystem', root: mediaRoot }, read: { kind: 'native-local-media-proxy' },
        expected: { bytes: String(mediaBytes.length), sha256: sha(mediaBytes),
          range: { start: '17', end: '1024', sha256: sha(mediaBytes.subarray(17, 1025)) } }, sidecars: [] });
    }
    return { scope: 'complete-library', libraries: [{ itemId: nativeGuid(libraryId), name: input.library.name,
      collectionType: input.library.collectionType, locations: [mediaRoot], itemIds: items.map(item => item.itemId) }], items };
  };
  const verify = async (target, label) => {
    setPhase(label); await idle();
    const declared = await declaration(target);
    const observation = report.verifications[label] = { declaration: declared };
    let proof;
    try {
      proof = await verifyNativeCompleteLibrary(declared, { database: target, baseUrl: origin, accessToken: token,
        signal: t.signal, requestTimeoutMs: 30000, scanTimeoutMs: 180000, pollIntervalMs: 100, pageSize: 2 });
    } catch (error) {
      observation.error = describeFailure(error);
      throw error;
    }
    observation.proof = proof;
    assert.deepEqual(proof.checks, { scanCompleted: true, libraryInventoryExact: true, declaredItemsPlayable: true });
    assert.equal(proof.scan.status, 'Completed'); assert.equal(proof.inventory.itemCount, present.size);
    assert.equal(proof.inventory.virtualLibraryCount, 1); assert.equal(proof.access.items.length, present.size);
    for (const item of proof.access.items) {
      assert.equal(item.verified, true); assert.equal(item.original.sha256, input.asset.sha256);
      assert.equal(item.range.verified, true);
    }
    assert.equal(proof.access.server.Id, current.preparation.nativeServerId);
    await idle();
    return declared;
  };
  const detail = async key => {
    const response = await request('/Items/' + idKey(knownIds[key]) + '?Fields=Path,MediaSources,MediaStreams,Overview,Genres,Tags,ProviderIds');
    assert.equal(response.status, 200); return response.value;
  };
  const edit = async (key, fields) => {
    const previous = await detail(key);
    assert.equal((await request('/Items/' + idKey(knownIds[key]), { method: 'POST', body: { ...previous, ...fields } })).status, 204);
  };
  const environmentCases = () => {
    const directory = path.join(root, 'environment-browser'), query = parameters => '/Environment/DirectoryContents?'
      + new URLSearchParams({ path: directory, ...parameters });
    return [
      { name: 'default flags', route: query({}), status: 200, entries: 0 },
      { name: 'only files', route: query({ includeFiles: 'true' }), status: 200, entries: 8 },
      { name: 'only directories', route: query({ includeDirectories: 'true' }), status: 200, entries: 2 },
      { name: 'all entries', route: query({ includeFiles: 'true', includeDirectories: 'true' }), status: 200, entries: 10 },
      { name: 'Swedish path ordering', route: query({ includeFiles: 'true', includeDirectories: 'true', culture: 'sv-SE' }), status: 200, entries: 10 },
      { name: 'missing required path', route: '/Environment/DirectoryContents', status: 400 },
      { name: 'empty required path', route: '/Environment/DirectoryContents?path=', status: 400 },
      { name: 'invalid file flag', route: query({ includeFiles: 'invalid' }), status: 400 },
      { name: 'empty file flag', route: query({ includeFiles: '' }), status: 400 },
      { name: 'invalid directory flag', route: query({ includeDirectories: 'invalid' }), status: 400 },
      { name: 'all scalar binding errors', route: '/Environment/DirectoryContents?path=&includeFiles=invalid&includeDirectories=invalid', status: 400 },
      { name: 'missing directory', route: query({ path: path.join(directory, 'missing'), includeFiles: 'true' }), status: 404 },
      { name: 'file is not a directory', route: query({ path: path.join(directory, '10-file'), includeFiles: 'true' }),
        status: process.platform === 'win32' ? 500 : 404 },
      { name: 'bare UNC server', route: query({ path: '\\\\complete-ci-host', includeFiles: 'true', includeDirectories: 'true' }), status: 200, entries: 0 },
      { name: 'anonymous before invalid binding', route: '/Environment/DirectoryContents?includeFiles=invalid', anonymous: true, status: 401 },
    ];
  };
  const environmentWire = response => {
    let body = projectProblemTrace(response.value, response.status);
    if (response.status === 400 && body?.title === 'One or more validation errors occurred.' && body.errors) {
      body = { ...body, errors: Object.fromEntries(Object.entries(body.errors).map(([name, errors]) => [name,
        errors.map(message => message.replace(/^The value ('[\s\S]*') is (?:not valid|invalid)\.$/u, 'The value $1 is not valid.'))])) };
    }
    return { status: response.status, contentType: response.contentType, body };
  };
  const observeEnvironment = async label => {
    setPhase(label);
    const observations = (report.environment ??= {})[label] = [];
    for (const sample of environmentCases()) {
      const response = await request(sample.route, { anonymous: sample.anonymous });
      observations.push({ name: sample.name, response: environmentWire(response) });
      assert.equal(response.status, sample.status, sample.name);
      if (sample.entries !== undefined) {
        assert.ok(Array.isArray(response.value), sample.name);
        assert.equal(response.value.length, sample.entries, sample.name);
      }
    }
    return observations;
  };
  try {
    current = await currentNativeReference(); token = current.accessToken; output.addSecret(token);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Api/Controllers/LibraryStructureController.cs', 'Jellyfin.Api/Controllers/ItemUpdateController.cs',
      'Jellyfin.Api/Controllers/UserLibraryController.cs', 'Jellyfin.Api/Controllers/EnvironmentController.cs',
      'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'Emby.Server.Implementations/IO/ManagedFileSystem.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Emby.Server.Implementations/ApplicationHost.cs', 'Emby.Server.Implementations/AppBase/BaseApplicationPaths.cs',
      'Emby.Server.Implementations/ServerApplicationPaths.cs',
      'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    await materialize('initial');
    const browser = path.join(root, 'environment-browser'); await mkdir(browser);
    for (const name of ['10-file', '2-file', '.hidden', 'a-case', 'B-case', 'É-acute', 'e\u0301-decomposed', '中']) {
      await writeFile(path.join(browser, name), name, { flag: 'wx' });
    }
    for (const name of ['Z-directory', 'ä-directory']) await mkdir(path.join(browser, name));
    const unknown = path.join(instanceRoot, 'config/plugins/complete-unknown.bin');
    await mkdir(path.dirname(unknown), { recursive: true });
    await writeFile(unknown, Buffer.from([0, 255, 128, 13, 10, 42]), { flag: 'wx' });
    const storage = await storageConfiguration(root); report.mountContract = storage.mountContract;
    proxy = await startOwnedMediaProxy(files); report.proxy = proxy.report;
    await startNative('native-initial');
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const administrator = await request('/Users/' + current.userId); assert.equal(administrator.status, 200);
    assert.equal((await request('/Users/' + current.userId + '/Policy', { method: 'POST',
      body: { ...administrator.value.Policy, EnableContentDeletion: true } })).status, 204);
    assert.equal((await request('/Library/VirtualFolders?name=' + encodeURIComponent(input.library.name)
      + '&collectionType=movies&refreshLibrary=false', { method: 'POST', body: { LibraryOptions: libraryOptions(mediaRoot) } })).status, 204);
    await scan('native-initial-scan');
    const virtualFolders = await request('/Library/VirtualFolders'); assert.equal(virtualFolders.status, 200);
    assert.equal(virtualFolders.value.length, 1); libraryId = virtualFolders.value[0].ItemId;
    await stopNative('native-after-initial-scan');
    const catalog = path.join(root, 'initial-catalog.db');
    await cp(databaseFilename(instanceRoot), catalog, { force: false, errorOnExist: true });
    await startNative('native-complete-verification');
    const nativeEnvironment = await observeEnvironment('native-directory-controls');
    await stoppedSqlite(catalog, target => verify(target, 'native-complete-initial'));
    await stopNative('native-initial-verified');
    const initialState = await discoverInstanceState({ instanceRoot });
    report.binding = { serverId: initialState.identity.serverId, originIdentityDigest: initialState.identity.digest };
    database = await createPostgresTestDatabase(null, 'complete_native');
    await stoppedSqlite(initialState.paths.sqlite, async source => {
      report.snapshots.nativeInitial = await orderedExchangeSnapshot(source);
      report.imported = await transferDatabase(source, database, { instanceBinding: report.binding, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(database), report.snapshots.nativeInitial);
    await startNode(database, 'node-mutations');
    assert.deepEqual(await observeEnvironment('node-directory-controls'), nativeEnvironment);
    await edit('retained', { Overview: 'Node complete-instance edit & 保留', ProviderIds: { CompleteOpaque: 'opaque-00000000000000000000000000000001' },
      Tags: ['Complete instance', '保留'] });
    assert.equal((await request('/UserFavoriteItems/' + idKey(knownIds.retained), { method: 'POST' })).status, 200);
    assert.equal((await request('/UserPlayedItems/' + idKey(knownIds.played), { method: 'POST' })).status, 200);
    await materialize('node'); await scan('node-added-frozen-media'); await declaration(database);
    assert.equal((await request('/Items/' + idKey(knownIds.nodeDeleted), { method: 'DELETE' })).status, 204);
    present.delete('nodeDeleted'); assert.equal(await optionalFile(files.find(file => file.key === 'nodeDeleted').filename), null);
    assertRemoved(await itemSnapshot(database, [knownIds.nodeDeleted]), knownIds.nodeDeleted);
    const nodeDeclaration = await verify(database, 'node-complete-changed');
    report.nodeRetained = await detail('retained'); report.nodePlayed = await detail('played');
    assert.equal(report.nodeRetained.Overview, 'Node complete-instance edit & 保留');
    assert.equal(report.nodeRetained.UserData.IsFavorite, true); assert.equal(report.nodePlayed.UserData.Played, true);
    await stopNode('node-before-package');
    await writeFile(unknown, Buffer.from('Node retained unknown state\0\u00ff', 'utf8'));
    const state = await discoverInstanceState({ instanceRoot });
    report.snapshots.nodeClosed = await orderedExchangeSnapshot(database);
    const captureSession = createIsolatedOfflineCopyCaptureSession({ instanceState: state, ownerId: 'complete-ci-instance', assertHeld: async () => {
      assert.equal(native, undefined); assert.equal(runtime, undefined); assert.equal(await portAvailable(port), true);
      assert.equal((await discoverInstanceState({ instanceRoot })).identity.digest, state.identity.digest);
    } });
    const packageRoot = path.join(root, 'state-package');
    const manifest = await createStatePackage({ database, instanceState: state, captureSession,
      baseline: 'current-ci-native-' + current.preparation.buildIdentitySha256, destination: packageRoot,
      mediaAccess: { scope: 'explicit-items', items: nodeDeclaration.items }, signal: t.signal });
    report.package = manifest;
    assert.deepEqual(await verifyStatePackage(packageRoot), manifest);
    // A whole-instance package virtualizes only its declared instance-owned
    // paths. Compare every exported cell and order stream in that representation
    // while independently retaining and rechecking the original PG generation.
    const projectionOptions = { sourceContract: manifest.source.database.portableMountContract,
      targetContract: manifest.database.portableMountContract,
      instanceStatePaths: { programData: state.paths.programData, metadata: state.paths.metadata } };
    const tableProjector = createSqliteExportPathProjector(projectionOptions);
    const insertionProjector = createSqliteExportPathProjector(projectionOptions);
    report.snapshots.nodePackaged = await orderedExchangeSnapshot(database, { signal: t.signal,
      rowTransform: tableProjector.projectRow, insertionRowTransform: insertionProjector.projectRow });
    report.packageProjection = { ...projectionOptions, pathProjection: tableProjector.statistics() };
    await stoppedSqlite(path.join(packageRoot, manifest.database.path), async source => {
      report.snapshots.packaged = await orderedExchangeSnapshot(source, { signal: t.signal });
      report.packageItemCells = await packageItemCells(database, source, projectionOptions, t.signal);
    });
    report.snapshots.nodeAfterPackage = await orderedExchangeSnapshot(database, { signal: t.signal });
    assert.deepEqual(report.snapshots.nodeAfterPackage, report.snapshots.nodeClosed,
      'State packaging and path projection leave every original PG cell and insertion sequence unchanged.');
    assert.deepEqual(projectionOptions.sourceContract, canonicalPortableMountContract(storage.mountContract));
    assert.deepEqual(projectionOptions.targetContract, canonicalPortableMountContract(storage.mountContract));
    assert.deepEqual(manifest.source.database.tables, report.snapshots.nodeClosed.tables);
    assert.deepEqual(report.snapshots.nodePackaged.tables, manifest.source.database.projectedTables);
    assert.deepEqual(report.packageProjection.pathProjection, manifest.source.database.pathProjection);
    assert.deepEqual(report.packageProjection.pathProjection, manifest.database.pathProjection);
    assert.deepEqual(report.snapshots.packaged, report.snapshots.nodePackaged);
    const restoredRoot = path.join(root, 'restored');
    const restored = await restoreStatePackage(packageRoot, restoredRoot, { signal: t.signal });
    report.restore = { generation: restored.manifest.generation, databaseProjection: restored.databaseProjection };
    assert.equal(restored.alreadyRestored, false);
    const restoredState = await discoverInstanceState({ instanceRoot: restoredRoot });
    assert.equal(restoredState.identity.serverId, state.identity.serverId);
    for (const file of manifest.instanceFiles) {
      const target = path.join(restoredRoot, ...file.path.split('/'));
      let expected = await readFile(path.join(packageRoot, 'files', ...file.path.split('/')));
      if (file.path === 'config/system.xml') {
        let xml = expected.toString('utf8');
        for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
          const binding = manifest.instanceState.pathBindings[name];
          if (!binding.configured) continue;
          const value = path.join(restoredRoot, binding.root, ...binding.relativePath.split('/').filter(Boolean))
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
          xml = xml.replace(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, 'gu'), `<${field}>${value}</${field}>`);
        }
        expected = Buffer.from(xml, 'utf8');
      }
      assert.deepEqual(await readFile(target), expected, file.path + ' complete restored asset');
      report.assets.push({ path: file.path, bytes: expected.length, sha256: sha(expected) });
    }
    assert.equal(report.assets.length, manifest.instanceFiles.length);
    assert.deepEqual(await readFile(path.join(restoredRoot, 'config/plugins/complete-unknown.bin')), await readFile(unknown));
    const restoreProjectionOptions = { ...projectionOptions,
      targetInstanceStatePaths: { programData: restoredState.paths.programData, metadata: restoredState.paths.metadata } };
    const restoredTableProjector = createSqliteExportPathProjector(restoreProjectionOptions);
    const restoredInsertionProjector = createSqliteExportPathProjector(restoreProjectionOptions);
    report.snapshots.nodeRestored = await orderedExchangeSnapshot(database, { signal: t.signal,
      rowTransform: restoredTableProjector.projectRow, insertionRowTransform: restoredInsertionProjector.projectRow });
    report.restoreProjection = { ...restoreProjectionOptions, pathProjection: restoredTableProjector.statistics() };
    await stoppedSqlite(restoredState.paths.sqlite, async source => {
      report.snapshots.restored = await orderedExchangeSnapshot(source, { signal: t.signal });
      report.restoredItemCells = await packageItemCells(database, source, restoreProjectionOptions, t.signal);
      assert.deepEqual(report.snapshots.restored, report.snapshots.nodeRestored);
      assert.deepEqual(report.snapshots.restored.tables, restored.databaseProjection.tables);
    });
    const again = await restoreStatePackage(packageRoot, restoredRoot, { signal: t.signal }); assert.equal(again.alreadyRestored, true);
    report.restore = { ...report.restore, reusedFiles: again.reusedFiles,
      allInstanceAssetsCompared: report.assets.length, serverIdPreserved: true };
    // Retain the complete old instance for independent comparison; the next
    // Native process receives only the restored package and the same media.
    await rename(originalInstance, path.join(root, 'retained-node-instance'));
    instanceRoot = restoredRoot;
    await startNative('native-restored-package');
    report.nativeRestoredRetained = await detail('retained');
    assert.deepEqual(projectItemBody(report.nativeRestoredRetained), projectItemBody(report.nodeRetained));
    assert.equal((await detail('played')).UserData.Played, true);
    await stoppedSqlite(path.join(packageRoot, manifest.database.path), target => verify(target, 'native-complete-restored'));
    await materialize('native'); await scan('native-continued-addition');
    await edit('retained', { Overview: 'Native continued whole instance & 保留' });
    assert.equal((await request('/Items/' + idKey(knownIds.nodeAdded), { method: 'DELETE' })).status, 204);
    present.delete('nodeAdded'); assert.equal(await optionalFile(files.find(file => file.key === 'nodeAdded').filename), null);
    await stopNative('native-continuation-complete');
    const continuedState = await discoverInstanceState({ instanceRoot });
    assert.equal(continuedState.identity.serverId, report.binding.serverId);
    fresh = await createPostgresTestDatabase(null, 'complete_return');
    await stoppedSqlite(continuedState.paths.sqlite, async source => {
      report.snapshots.nativeContinued = await orderedExchangeSnapshot(source);
      await declaration(source);
      assertRemoved(await itemSnapshot(source, [knownIds.nodeDeleted]), knownIds.nodeDeleted);
      assertRemoved(await itemSnapshot(source, [knownIds.nodeAdded]), knownIds.nodeAdded);
      report.reimported = await transferDatabase(source, fresh, { instanceBinding: { serverId: continuedState.identity.serverId,
        originIdentityDigest: continuedState.identity.digest }, portableMountContract: storage.mountContract });
    });
    assert.deepEqual(await orderedExchangeSnapshot(fresh), report.snapshots.nativeContinued);
    assert.deepEqual(report.reimported.migrationHistory, report.imported.migrationHistory);
    const schema = fresh.schemaName; await fresh.close();
    fresh = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    assert.deepEqual(await orderedExchangeSnapshot(fresh), report.snapshots.nativeContinued);
    await startNode(fresh, 'fresh-node-consumer');
    await verify(fresh, 'fresh-node-complete');
    report.freshRetained = await detail('retained');
    assert.equal(report.freshRetained.Overview, 'Native continued whole instance & 保留');
    assert.equal(report.freshRetained.UserData.IsFavorite, true); assert.equal((await detail('played')).UserData.Played, true);
    assert.equal(report.freshRetained.ProviderIds.CompleteOpaque, 'opaque-00000000000000000000000000000001');
    assert.equal((await detail('nativeAdded')).Path, files.find(file => file.key === 'nativeAdded').filename);
    await stopNode('fresh-node-complete');
    for (const key of ['nodeDeleted', 'nodeAdded']) assertRemoved(await itemSnapshot(fresh, [knownIds[key]]), knownIds[key]);
    for (const file of files.filter(file => present.has(file.key))) assert.deepEqual(await readFile(file.filename), mediaBytes);
    assert.deepEqual(await orderedExchangeSnapshot(database), report.snapshots.nodeClosed,
      'Native continuation and the fresh consumer leave the original PostgreSQL generation unchanged.');
    report.identities = knownIds;
    report.completeLibraryVerified = true;
    report.fullInstanceVerified = true;
    report.acceptanceScope = { kind: 'ci-owned-complete-instance', virtualLibraries: 1, initialMedia: 3,
      mediaAfterEachContinuation: 3, originalMediaBytesGenerated: false, productionCatalogVerified: false };
  } catch (error) { failed = true; failure = error; report.error = describeFailure(error); }
  finally {
    const cleanupErrors = [];
    for (const operation of [() => stopNode('finally-node'), () => stopNative('finally-native'),
      () => { sqlite?.close(); sqlite = undefined; }, () => proxy?.close(),
      () => dropPostgresTestDatabase(fresh), () => dropPostgresTestDatabase(database), () => current?.finish()]) {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    }
    report.cleanup = { runtimeClosed: runtime === undefined, nativeExited: native === undefined,
      proxyClosed: !proxy || proxy.report.closed === true, portAvailable: await portAvailable(port),
      postgresOwnersClosed: [database, fresh].filter(Boolean).every(owner => owner.closed),
      errors: [] };
    try { assert.deepEqual(report.cleanup, { runtimeClosed: true, nativeExited: true,
      proxyClosed: true, portAvailable: true, postgresOwnersClosed: true, errors: [] }); }
    catch (error) { cleanupErrors.push(error); }
    report.cleanup.errors = cleanupErrors.map(describeFailure);
    report.passed = !failed && cleanupErrors.length === 0;
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    if (!native && !runtime) await output.publishAndClose();
    if (cleanupErrors.length) {
      failure = new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, 'Complete instance exchange failed or could not drain.',
        failed ? { cause: failure } : undefined); failed = true;
    }
  }
  if (failed) throw output.publicError(failure);
}, { signal: t.signal }), { signal: t.signal }));
