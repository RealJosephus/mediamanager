import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { createStatePackage, restoreRemoteStatePackage } from '../../src/migration/state-package.js';
import { restoreRemoteAssets } from '../../src/migration/remote-assets.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { verifyNativeMediaAccess } from '../../src/migration/media-access.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { inspectInstanceConfiguration } from '../../src/configuration.js';
import { nativeGuid } from '../../src/users/native.js';
import { dateTicks, mapRecord } from '../../src/library/records.js';
import { metadataSortName } from '../../src/metadata/sort-cache.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { assertRemoved, databaseFilename, idKey, itemSnapshot, portAvailable,
  removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { errorObservation } from '../helpers/error-observation.js';
import { ownedConditionalHttpFixture } from '../helpers/conditional-http-state.js';
import { observeDatabaseMetrics } from './fixtures/large-catalog-exchange/database-metrics.js';
import { compareInstanceAssets, startRestoreWorker } from './fixtures/production-instance-state-exchange/scenario.js';

export const requiredValidationServices = ['postgres', 'nativeInstance', 'dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const discoveryLease = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
const inputBytes = await readFile(new URL('./fixtures/production-instance-state-exchange/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const mediaBytes = await readFile(new URL('../fixtures/frozen-av/source.m2ts', import.meta.url));
assert.equal(input.items, 100000); assert.equal(mediaBytes.length, input.asset.bytes); assert.equal(sha(mediaBytes), input.asset.sha256);
const Id = ordinal => nativeGuid(input.idPrefix + String(ordinal).padStart(12, '0'));
const ticksBase = BigInt(input.ticksBase);
const dataDigest = () => {
  const hash = createHash('sha256');
  for (let index = 0; index < input.items; index++) hash.update(input.data);
  return hash.digest('hex');
};
const nativePage = rows => rows.map(row => ({ id: nativeGuid(row.Id), Name: row.Name, SortName: row.SortName,
  ProductionYear: row.ProductionYear, runTimeTicks: row.RunTimeTicks?.toString() ?? null }));
const nativeDtoPage = rows => rows.map(row => ({ id: nativeGuid(row.Id), Name: row.Name ?? null, SortName: row.SortName ?? null,
  ProductionYear: row.ProductionYear ?? null, runTimeTicks: row.RunTimeTicks?.toString() ?? null }));

test('one generated 100000-item instance preserves whole state through real restore-owner death, Native full-host consumption and fresh PG', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(() => discoveryLease.run(async () => {
  const destination = path.join(validationOutputRoot(), 'production-instance-state-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES); await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), restoredRoot = path.join(root, 'restored');
  const mediaRoot = path.join(root, 'catalog-media'), packageDirectory = path.join(root, 'state-package');
  await mkdir(mediaRoot);
  const filename = path.join(mediaRoot, String(input.retained).padStart(7, '0') + '.mkv');
  await writeFile(filename, mediaBytes, { flag: 'wx' });
  const physicalMedia = { key: 'retained', filename, expected: { bytes: mediaBytes.length, sha256: sha(mediaBytes) }, contentType: 'video/mp2t' };
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const report = { schemaVersion: 1, scope: input.scope, inputSha256: sha(inputBytes), stages: [], requests: [],
    native: {}, workers: [], snapshots: {}, assets: [], cleanup: {}, productionScaleVerified: false,
    fullInstanceVerified: false, completeLibraryVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  const metrics = observeDatabaseMetrics();
  report.databaseMetrics = { diagnosticOnly: true, inclusiveCallDurations: true, calls: metrics.records,
    processScope: 'Parent Node calls only. Restore, Native and PostgreSQL process CPU is not represented by parent process CPU deltas.' };
  let current, native, proxy, database, fresh, sqlite, remoteSource, sourceServer, sourceStorage, remoteTarget, targetServer, targetStorage;
  let failed = false, failure, phase = 'prepare';
  const workers = [];
  const databaseOwners = new Set(), closedDatabaseOwners = new Set();
  const sqliteOwners = new Set(), closedSqliteOwners = new Set();
  const nativeOwners = new Set(), closedNativeOwners = new Set(), closedWorkers = new Set();
  let proxyClosed = false, ownerCloseFailed = false;
  const ownDatabase = owner => { databaseOwners.add(owner); return owner; };
  const closeDatabase = async owner => { await owner.close(); closedDatabaseOwners.add(owner); };
  const closeSqlite = owner => {
    owner.close(); closedSqliteOwners.add(owner);
    if (sqlite === owner) sqlite = undefined;
  };
  const stage = async (name, operation) => {
    const entry = { name, startedAt: new Date().toISOString() }; report.stages.push(entry); phase = name; metrics.setPhase(name);
    if (proxy) proxy.report.phase = name;
    const started = performance.now(), cpu = process.cpuUsage();
    entry.resourcesBefore = process.resourceUsage();
    try { t.signal.throwIfAborted(); const value = await operation(); t.signal.throwIfAborted(); entry.completed = true; return value; }
    catch (error) { entry.error = errorObservation(error); throw error; }
    finally { entry.elapsedMilliseconds = performance.now() - started; entry.processCpuMicroseconds = process.cpuUsage(cpu);
      entry.resourcesAfter = process.resourceUsage(); entry.finishedAt = new Date().toISOString(); metrics.setPhase('between-stages'); }
  };
  const stopped = async (sourceFilename, operation) => {
    await stoppedDatabase(sourceFilename); sqlite = new SqliteDatabase(sourceFilename, { readOnly: true, requireMigrationHistory: true });
    sqliteOwners.add(sqlite);
    try { return await operation(sqlite); } finally { closeSqlite(sqlite); }
  };
  const request = async (route, { method = 'GET', body, cleanup = false, lossless = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const response = await fetch(origin + route, { method, redirect: 'error',
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: `MediaBrowser Token="${current.accessToken}"`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    report.requests.push({ phase, method, route, ...(body === undefined ? {} : { body }),
      response: { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length,
        sha256: sha(bytes), bodyText: bytes.toString('utf8') } });
    let value;
    if (bytes.length) { try { value = (lossless ? parseLosslessJson : JSON.parse)(bytes.toString('utf8')); } catch { value = bytes.toString('utf8'); } }
    return { status: response.status, value };
  };
  const idle = async () => {
    for (;;) {
      t.signal.throwIfAborted(); const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.value.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.value;
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const owner = native;
    let result;
    try {
      result = await owner.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
        () => portAvailable(port));
    } catch (error) { ownerCloseFailed = true; throw error; }
    (report.shutdowns ??= []).push({ label, ...result });
    if (result.pidGone) { closedNativeOwners.add(owner); native = undefined; }
    if (!result.cleanShutdown || !result.pidGone || !result.portAvailable) ownerCloseFailed = true;
    assert.equal(result.cleanShutdown, true); assert.equal(result.pidGone, true); assert.equal(result.portAvailable, true);
  };
  const startNative = async (target, label) => {
    await current.prepareClone(target, port);
    native = current.start({ referenceRoot: target, outputRoot: root, label, origin });
    nativeOwners.add(native);
    await native.ready(); await idle();
    const system = await request('/System/Info'); assert.equal(system.status, 200);
    assert.equal(system.value.Id, current.preparation.nativeServerId);
    (report.hosts ??= []).push({ label, pid: native.child.pid, args: native.arguments, serverId: system.value.Id });
  };
  const select = async (target, label, observation, { dtoConfiguration } = {}) => stage(label, () => target.withConnection(async session => {
    const initialTimeout = (await session.client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    const rows = session.rows.bind(session), hydration = [];
    session.rows = (name, options) => {
      if (name === 'BaseItems') { assert.ok(Array.isArray(options?.whereIn?.Id));
        assert.ok(options.whereIn.Id.length <= 128); hydration.push(options.whereIn.Id.length); }
      return rows(name, options);
    };
    try {
      await session.client.query("SET statement_timeout = '30s'");
      const result = await queryPostgresItemPage(session, { includeitemtypes: ['Movie'], mediatypes: ['Video'],
        years: [input.query.year], isfavorite: true, sortby: ['SortName'], sortorder: ['Ascending'],
        startindex: input.query.startIndex, limit: input.query.limit }, { userId: current.userId,
        scope: { ancestorId: input.parentId }, signal: t.signal });
      const storedRows = nativePage(result.rows);
      const comparedRows = dtoConfiguration === undefined ? storedRows : nativePage(result.rows.map(row => {
        const item = mapRecord(row);
        metadataSortName(item, { configuration: dtoConfiguration });
        return item;
      }));
      (report.queries ??= []).push({ label, total: result.total, rows: comparedRows, storedRows,
        projection: dtoConfiguration === undefined ? 'stored EF fields' : 'typed production public SortName getter', hydration,
        statement: result.plan.text, values: result.plan.values });
      assert.equal(result.total, observation.filteredCount); assert.ok(result.rows.length <= 128);
      assert.deepEqual(comparedRows, observation.page);
    } finally { session.rows = rows; await session.client.query("SELECT set_config('statement_timeout', $1, false)", [initialTimeout]); }
  }));
  try {
    current = await stage('bind-current-native-instance', () => currentNativeReference());
    output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/ItemsController.cs',
      'Jellyfin.Api/Controllers/LibraryController.cs', 'Jellyfin.Api/Controllers/MediaInfoController.cs',
      'Jellyfin.Api/Controllers/SystemController.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Emby.Server.Implementations/Dto/DtoService.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    await stage('initialize-owned-instance-http', async () => {
      await startNative(instanceRoot, 'native-initial-owner');
      for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
      await stopNative('initial-owner');
    });
    const catalogInput = { ...input, userId: current.userId, mediaRoot }, catalogInputFile = path.join(root, 'catalog-input.json');
    const catalogInputBytes = Buffer.from(JSON.stringify(catalogInput));
    report.catalogInput = { bytes: catalogInputBytes.length, sha256: sha(catalogInputBytes), base64: catalogInputBytes.toString('base64') };
    await writeFile(catalogInputFile, catalogInputBytes);
    const oracle = await stage('compile-native-catalog-owner', () => compileOracle({
      project: 'tests/migration/fixtures/large-catalog-exchange/Oracle.csproj', output: path.join(root, 'oracle-build') }));
    report.native.build = oracle.buildRecord;
    const record = async (mode, sourceFilename) => stage('native-' + mode, async () => {
      const directory = path.join(root, 'native-' + mode);
      const receipt = await oracle.record({ output: directory, args: [mode, sourceFilename, catalogInputFile, '{output}/native.json'] });
      const observation = report.native[mode] = { receipt };
      assert.equal(receipt.passed, true); assert.equal(receipt.process.status, 0);
      const bytes = await readFile(path.join(directory, 'native.json'));
      observation.raw = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
      const result = JSON.parse(bytes.toString('utf8')); observation.result = result;
      assert.equal(result.mode, mode); assert.equal(result.processId, receipt.process.pid);
      return result;
    });
    const seeded = await record('seed', databaseFilename(instanceRoot));
    assert.equal(seeded.observation.rows, input.items); assert.equal(seeded.observation.userStateRows, input.items);
    assert.equal(seeded.observation.dataSha256, dataDigest()); assert.equal(seeded.observation.retained.Data, input.data);
    const originalAsset = path.join(instanceRoot, 'config/plugins/production-unknown.bin');
    const removedAsset = path.join(instanceRoot, 'cache/production-deleted.bin');
    await mkdir(path.dirname(originalAsset), { recursive: true });
    await mkdir(path.dirname(removedAsset), { recursive: true });
    await writeFile(originalAsset, Buffer.from([0, 255, 128, 42]), { flag: 'wx' });
    await writeFile(removedAsset, 'Removed during this Node generation.', { flag: 'wx' });
    const initialState = await discoverInstanceState({ instanceRoot });
    report.binding = { serverId: initialState.identity.serverId, originIdentityDigest: initialState.identity.digest };
    const contract = { mounts: [{ mountId: 'production-instance-media', identityRoot: mediaRoot, accessRoot: '/production-instance-media',
      pathStyle: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] };
    database = ownDatabase(await createPostgresTestDatabase(null, 'production_state', { deferRuntimeSchemaInitialization: true }));
    await stopped(initialState.paths.sqlite, async source => {
      report.snapshots.nativeSeeded = await stage('snapshot-native-seeded', () => orderedExchangeSnapshot(source, { signal: t.signal }));
      report.sqlitePrimaryKeyPagePlans = await stage('observe-sqlite-primary-key-page-plans', () =>
        metrics.explainSqlitePrimaryKeyPages(source, { signal: t.signal }));
      report.imported = await stage('import-whole-catalog', () => transferDatabase(source, database,
        { instanceBinding: report.binding, portableMountContract: contract, signal: t.signal }));
    });
    await stage('initialize-pg-runtime', () => database.initializeRuntimeSchema());
    assert.deepEqual(await stage('snapshot-pg-imported', () => orderedExchangeSnapshot(database, { signal: t.signal })), report.snapshots.nativeSeeded);
    await select(database, 'pg-initial-native-selection', seeded.observation);
    await stage('node-current-generation-mutations', () => database.transaction(async transaction => {
      const [template] = await transaction.rows('BaseItems', { where: { Id: Id(1) } }); assert.ok(template);
      await transaction.update('BaseItems', { Id: Id(input.retained) }, { Name: 'Edited by Node at production cardinality',
        RunTimeTicks: ticksBase + BigInt(input.retained) + 10003n });
      await transaction.update('UserData', { ItemId: Id(input.retained), UserId: current.userId, CustomDataKey: Id(input.retained) },
        { PlaybackPositionTicks: ticksBase + BigInt(input.retained) + 3n, PlayCount: 2 });
      await transaction.delete('BaseItems', { Id: Id(input.deletedByNode) });
      const ordinal = input.addedByNode;
      await transaction.insert('BaseItems', { ...template, Id: Id(ordinal), Name: 'Large catalog ' + String(ordinal).padStart(7, '0'),
        SortName: 'large catalog ' + String(ordinal).padStart(7, '0'), CleanName: 'large catalog ' + String(ordinal).padStart(7, '0'),
        Path: path.join(mediaRoot, String(ordinal).padStart(7, '0') + '.mkv'), PresentationUniqueKey: Id(ordinal),
        ProductionYear: 1980 + ordinal % 50, RunTimeTicks: ticksBase + BigInt(ordinal) + 10000n });
      await transaction.insert('AncestorIds', { ItemId: Id(ordinal), ParentItemId: nativeGuid(input.parentId) });
      const [state] = await transaction.rows('UserData', { where: { ItemId: Id(1), UserId: current.userId } }); assert.ok(state);
      await transaction.insert('UserData', { ...state, ItemId: Id(ordinal), CustomDataKey: Id(ordinal), IsFavorite: true,
        PlaybackPositionTicks: ticksBase + BigInt(ordinal), Played: false });
    }));
    const changedAsset = Buffer.from('Current Node generation\0保留\u00ff', 'utf8');
    await writeFile(originalAsset, changedAsset); await unlink(removedAsset);
    assertRemoved(await itemSnapshot(database, [Id(input.deletedByNode)]), Id(input.deletedByNode));
    report.snapshots.nodeClosed = await stage('snapshot-node-current', () => orderedExchangeSnapshot(database, { signal: t.signal }));
    remoteSource = await ownedConditionalHttpFixture(t, 'production-instance-state-source');
    sourceServer = await remoteSource.openServer(); sourceStorage = await remoteSource.openVfs(sourceServer);
    const remoteBytes = Buffer.from(input.remote.payload), { payload: _payload, ...remoteAsset } = input.remote;
    await remoteSource.put(sourceServer, '/source/production-state.bin', remoteBytes);
    const state = await discoverInstanceState({ instanceRoot });
    const captureSession = createIsolatedOfflineCopyCaptureSession({ instanceState: state,
      ownerId: 'production-instance-state', assertHeld: async () => {
        assert.equal(native, undefined); assert.equal(sqlite, undefined); assert.equal(await portAvailable(port), true);
        assert.equal((await discoverInstanceState({ instanceRoot })).identity.digest, state.identity.digest);
      } });
    const mediaAccess = { scope: 'explicit-items', items: [{ itemId: Id(input.retained), identityPath: filename, identityRoot: mediaRoot,
      enumeration: { kind: 'native-filesystem', root: mediaRoot }, read: { kind: 'native-local-media-proxy' }, sidecars: [],
      expected: { bytes: String(mediaBytes.length), sha256: sha(mediaBytes), range: { start: '17', end: '1024', sha256: sha(mediaBytes.subarray(17, 1025)) } } }] };
    const baseline = 'current-production-instance-' + current.preparation.buildIdentitySha256;
    const manifest = report.package = await stage('capture-whole-instance-state', () => createStatePackage({ database, instanceState: state,
      captureSession, baseline, destination: packageDirectory, mediaAccess,
      remoteState: { vfs: sourceStorage.vfs, assets: [remoteAsset] }, signal: t.signal }));
    assert.deepEqual(manifest.source.database.tables, report.snapshots.nodeClosed.tables);
    assert.equal(manifest.source.database.instanceBinding.serverId, report.binding.serverId);
    assert.equal(manifest.remoteAssets.length, 1); assert.equal(manifest.remoteAssets[0].sha256, sha(remoteBytes));
    assert.deepEqual(await readFile(path.join(packageDirectory, 'files', manifest.remoteAssets[0].path)), remoteBytes);
    await sourceStorage.registry.close(); await sourceServer.close();
    sourceServer = await remoteSource.openServer(); sourceStorage = await remoteSource.openVfs(sourceServer);
    assert.equal((await sourceStorage.vfs.stat(remoteAsset.virtualPath)).version, manifest.remoteAssets[0].remote.version);
    const sourceResponse = await fetch(sourceServer.origin + '/source/production-state.bin', { signal: t.signal });
    assert.equal(sourceResponse.status, 200); assert.deepEqual(Buffer.from(await sourceResponse.arrayBuffer()), remoteBytes);
    await sourceStorage.registry.close(); await sourceServer.close();
    report.remoteSource = { root: remoteSource.root, report: remoteSource.report, versionSurvivedRestart: true };
    const options = { schema: database.schemaName, instanceRoot, packageDirectory, destination: restoredRoot, baseline };
    const interrupted = startRestoreWorker('restore-preparation-interrupted', options, t.signal); workers.push(interrupted);
    const boundary = await stage('restore-owner-durable-preparation', () => interrupted.message);
    assert.equal(boundary.event, 'restore-preparation-durable'); assert.equal(boundary.preparation.stage, 'database-opened');
    const preparationDirectory = path.join(boundary.preparation.staging, boundary.preparation.relativeDirectory);
    const binding = JSON.parse(await readFile(path.join(preparationDirectory, 'binding.json'), 'utf8'));
    assert.equal(binding.generation, manifest.generation); assert.equal(binding.destination, restoredRoot);
    assert.equal(binding.sourceSha256, manifest.database.sha256);
    const preparationFiles = await readdir(preparationDirectory);
    assert.ok(preparationFiles.includes('binding.json')); assert.ok(preparationFiles.includes('jellyfin.db'));
    assert.equal(sha(await readFile(path.join(preparationDirectory, 'jellyfin.db'))), manifest.database.sha256);
    const killed = await interrupted.stop({ intentional: true }); closedWorkers.add(interrupted);
    assert.equal(killed.deliberatelyTerminated, true); assert.notEqual(killed.code, 0);
    assert.equal(killed.emergencyTerminationRequested, false);
    report.workers.push({ mode: 'restore-preparation-interrupted', boundary, binding, ...killed });
    assert.deepEqual(await readdir(preparationDirectory), preparationFiles);
    await assert.rejects(access(restoredRoot), { code: 'ENOENT' });
    const resumed = startRestoreWorker('restore', options, t.signal); workers.push(resumed);
    const restored = await stage('restore-with-new-owner', async () => {
      const message = await resumed.message; assert.equal(message.event, 'complete');
      const closed = await resumed.closed; closedWorkers.add(resumed);
      assert.equal(closed.code, 0, resumed.diagnostics()); assert.equal(closed.signal, null);
      report.workers.push({ mode: 'restore', result: message, ...closed }); return message;
    });
    assert.notEqual(restored.pid, boundary.pid); assert.equal(restored.generation, manifest.generation);
    assert.equal(restored.preparationRecovery.recovered, true);
    assert.equal(restored.preparationRecovery.requestSha256, boundary.preparation.requestSha256);
    for (const name of ['binding.json', 'jellyfin.db']) assert.ok(restored.preparationRecovery.recoveredFiles.includes(name));
    await assert.rejects(access(preparationDirectory), { code: 'ENOENT' });
    report.assets = await stage('compare-all-instance-assets', () => compareInstanceAssets(manifest, packageDirectory, restoredRoot));
    assert.deepEqual(await readFile(path.join(restoredRoot, 'config/plugins/production-unknown.bin')), changedAsset);
    await assert.rejects(access(path.join(restoredRoot, 'cache/production-deleted.bin')), { code: 'ENOENT' });
    const returned = await discoverInstanceState({ instanceRoot: restoredRoot }); assert.equal(returned.identity.serverId, report.binding.serverId);
    const projection = { sourceContract: manifest.source.database.portableMountContract, targetContract: manifest.database.portableMountContract,
      instanceStatePaths: { programData: state.paths.programData, metadata: state.paths.metadata },
      targetInstanceStatePaths: { programData: returned.paths.programData, metadata: returned.paths.metadata } };
    const tableProjector = createSqliteExportPathProjector(projection), insertionProjector = createSqliteExportPathProjector(projection);
    const expected = report.snapshots.nodeForRestore = await stage('snapshot-pg-restored-representation', () => orderedExchangeSnapshot(database,
      { signal: t.signal, rowTransform: tableProjector.projectRow, insertionRowTransform: insertionProjector.projectRow }));
    await stopped(returned.paths.sqlite, async source => {
      report.snapshots.restored = await stage('snapshot-complete-restored-sqlite', () => orderedExchangeSnapshot(source, { signal: t.signal }));
      assert.deepEqual(report.snapshots.restored, expected); assert.deepEqual(report.snapshots.restored.tables, restored.databaseProjection.tables);
    });
    remoteTarget = await ownedConditionalHttpFixture(t, 'production-instance-state-target');
    targetServer = await remoteTarget.openServer(); targetStorage = await remoteTarget.openVfs(targetServer);
    const remoteOptions = { vfs: targetStorage.vfs, targets: { [remoteAsset.assetId]: '/remote/target/production-state.bin' }, signal: t.signal };
    report.remoteRestore = await stage('restore-independent-http-target', () => restoreRemoteStatePackage(packageDirectory, remoteOptions));
    assert.equal(report.remoteRestore.complete, true); assert.ok(report.remoteRestore.completed.every(file => !file.reused));
    const different = Buffer.from('External target bytes must not be overwritten.');
    let targetMetadata = await targetStorage.vfs.stat('/remote/target/production-state.bin');
    await remoteTarget.put(targetServer, '/target/production-state.bin', different, targetMetadata.version);
    // The full state-package entry point has independently verified this same
    // immutable package. Remote-only retries exercise its exact manifest and
    // actual backend without repeating unrelated full database verification.
    const remoteRetry = { ...remoteOptions, directory: packageDirectory, manifest };
    await assert.rejects(restoreRemoteAssets(remoteRetry), /overwrite different target content/u);
    let targetResponse = await fetch(targetServer.origin + '/target/production-state.bin', { signal: t.signal });
    assert.equal(targetResponse.status, 200); assert.deepEqual(Buffer.from(await targetResponse.arrayBuffer()), different);
    targetMetadata = await targetStorage.vfs.stat('/remote/target/production-state.bin');
    await remoteTarget.put(targetServer, '/target/production-state.bin', remoteBytes, targetMetadata.version);
    const reused = await restoreRemoteAssets(remoteRetry); assert.equal(reused.complete, true);
    assert.ok(reused.completed.every(file => file.reused));
    targetResponse = await fetch(targetServer.origin + '/target/production-state.bin', { signal: t.signal });
    assert.equal(targetResponse.status, 200); assert.deepEqual(Buffer.from(await targetResponse.arrayBuffer()), remoteBytes);
    await targetStorage.registry.close(); await targetServer.close();
    report.remoteTarget = { root: remoteTarget.root, report: remoteTarget.report, originalBytesRestored: true, externalBytesNotOverwritten: true };
    const continued = await record('continue', returned.paths.sqlite);
    assert.equal(continued.before.rows, input.items); assert.equal(continued.before.userStateRows, input.items);
    assert.equal(continued.before.nodeAddedItemPresent, true); assert.equal(continued.before.deletedItemPresent, false);
    assert.equal(continued.before.retained.runTimeTicks, String(ticksBase + BigInt(input.retained) + 10003n));
    assert.equal(continued.before.retained.playbackPositionTicks, String(ticksBase + BigInt(input.retained) + 3n));
    assert.equal(continued.after.rows, input.items); assert.equal(continued.after.userStateRows, input.items);
    assert.equal(continued.after.dataSha256, dataDigest()); assert.equal(continued.after.nodeAddedItemPresent, false);
    assert.equal(continued.after.nativeAddedItemPresent, true); assert.equal(continued.after.retained.Name, 'Native continued at production cardinality');
    proxy = await startOwnedMediaProxy([physicalMedia]); report.proxy = proxy.report;
    await stage('native-full-host-consumption', async () => {
      await startNative(restoredRoot, 'native-restored-full-host');
      const page = await request('/Items?' + new URLSearchParams({ ParentId: idKey(input.parentId), Recursive: 'true',
        IncludeItemTypes: 'Movie', SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: '0', Limit: '128',
        EnableImages: 'false', EnableTotalRecordCount: 'true', Fields: 'Path' }));
      assert.equal(page.status, 200); assert.equal(page.value.TotalRecordCount, input.items); assert.equal(page.value.StartIndex, 0);
      assert.equal(page.value.Items.length, 128);
      assert.deepEqual(page.value.Items.map(item => idKey(item.Id)), Array.from({ length: 128 }, (_, index) => idKey(Id(index + 1))));
      const detail = await request('/Items/' + idKey(Id(input.retained)) + '?Fields=Path,MediaStreams,MediaSources');
      assert.equal(detail.status, 200); assert.equal(detail.value.Name, 'Native continued at production cardinality');
      assert.equal(detail.value.UserData.PlayCount, continued.after.retained.PlayCount);
      assert.equal(detail.value.Path, filename); report.nativeFullHostRetained = detail.value;
      // The immutable original PG generation binds the explicit media identity;
      // all observed directory, playback and byte responses come from this host.
      report.media = await verifyNativeMediaAccess(mediaAccess, { database, baseUrl: origin,
        accessToken: current.accessToken, signal: t.signal, timeoutMs: 30000 });
      assert.equal(report.media.declaredItemsVerified, true); assert.equal(report.media.completeLibraryVerified, false);
      assert.equal(report.media.server.Id, report.binding.serverId);
      for (const item of report.media.items) { assert.equal(item.verified, true); assert.equal(item.original.sha256, input.asset.sha256); assert.equal(item.range.verified, true); }
      // PlaybackInfo may refresh missing stream metadata and persist a newly
      // derived SortName. Compare fresh PG with this same host after that write,
      // retaining the independent EF and HTTP observations from before probing.
      const postProbeDetail = await request('/Items/' + idKey(Id(input.retained)) + '?Fields=Path,SortName,MediaStreams,MediaSources', { lossless: true });
      assert.equal(postProbeDetail.status, 200); assert.equal(postProbeDetail.value.Path, filename);
      report.nativeFullHostRetainedAfterProbe = postProbeDetail.value;
      const postProbePage = await request('/Items?' + new URLSearchParams({ ParentId: idKey(input.parentId), Recursive: 'true',
        IncludeItemTypes: 'Movie', MediaTypes: 'Video', Years: String(input.query.year), IsFavorite: 'true',
        SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: String(input.query.startIndex), Limit: String(input.query.limit),
        EnableImages: 'false', EnableTotalRecordCount: 'true', Fields: 'Path,SortName' }), { lossless: true });
      assert.equal(postProbePage.status, 200); assert.equal(postProbePage.value.StartIndex, input.query.startIndex);
      assert.ok(postProbePage.value.Items.length <= 128);
      report.nativePostProbeSelection = { filteredCount: postProbePage.value.TotalRecordCount, page: nativeDtoPage(postProbePage.value.Items) };
      await stopNative('restored-full-host');
    });
    const finalState = await discoverInstanceState({ instanceRoot: restoredRoot }); assert.equal(finalState.identity.serverId, report.binding.serverId);
    fresh = ownDatabase(await createPostgresTestDatabase(null, 'production_return', { deferRuntimeSchemaInitialization: true }));
    await stopped(finalState.paths.sqlite, async source => {
      report.snapshots.nativeContinued = await stage('snapshot-native-final', () => orderedExchangeSnapshot(source, { signal: t.signal }));
      report.reimported = await stage('import-native-final-to-fresh-pg', () => transferDatabase(source, fresh, { instanceBinding: {
        serverId: finalState.identity.serverId, originIdentityDigest: finalState.identity.digest }, portableMountContract: contract, signal: t.signal }));
    });
    await stage('initialize-fresh-pg-runtime', () => fresh.initializeRuntimeSchema());
    assert.deepEqual(await stage('snapshot-fresh-pg', () => orderedExchangeSnapshot(fresh, { signal: t.signal })), report.snapshots.nativeContinued);
    assert.deepEqual(report.reimported.migrationHistory, report.imported.migrationHistory);
    const schema = fresh.schemaName; await closeDatabase(fresh);
    fresh = await stage('open-cold-fresh-pg', async () => ownDatabase(await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema })));
    assert.deepEqual(await stage('snapshot-cold-fresh-pg', () => orderedExchangeSnapshot(fresh, { signal: t.signal })), report.snapshots.nativeContinued);
    const { configuration: dtoConfiguration } = await inspectInstanceConfiguration(restoredRoot);
    report.dtoProjectionConfiguration = { source: 'restored instance config/system.xml',
      sha256: sha(await readFile(path.join(restoredRoot, 'config/system.xml'))),
      SortRemoveWords: dtoConfiguration.SortRemoveWords, SortRemoveCharacters: dtoConfiguration.SortRemoveCharacters,
      SortReplaceCharacters: dtoConfiguration.SortReplaceCharacters };
    await select(fresh, 'fresh-pg-native-catalog-selection', report.nativePostProbeSelection, { dtoConfiguration });
    const [retained] = await fresh.rows('BaseItems', { where: { Id: Id(input.retained) } });
    assert.equal(retained.Name, report.nativeFullHostRetainedAfterProbe.Name); assert.equal(retained.Path, report.nativeFullHostRetainedAfterProbe.Path);
    const [userState] = await fresh.rows('UserData', { where: { ItemId: Id(input.retained), UserId: current.userId,
      CustomDataKey: Id(input.retained) } });
    assert.equal(userState.PlayCount, 3); assert.equal(userState.PlaybackPositionTicks, ticksBase + BigInt(input.retained) + 10n);
    assert.equal(dateTicks(userState.LastPlayedDate), dateTicks(continued.after.retained.lastPlayedDate));
    for (const ordinal of [input.deletedByNode, input.addedByNode]) assertRemoved(await itemSnapshot(fresh, [Id(ordinal)]), Id(ordinal));
    assert.deepEqual(await stage('snapshot-original-pg-still-current', () => orderedExchangeSnapshot(database, { signal: t.signal })), report.snapshots.nodeClosed);
    assert.equal((await discoverInstanceState({ instanceRoot })).identity.digest, state.identity.digest);
    assert.deepEqual(await readFile(filename), mediaBytes);
    report.acceptanceScope = { generatedCatalogItems: input.items, completeLocalInstanceRoots: true,
      declaredPhysicalMedia: 1, originalMediaBytesGenerated: false, physicalCatalogScanVerified: false,
      allGeneratedMediaReachable: false, nativeFullHostStarted: true, declaredMediaAccessVerified: true,
      remoteObjects: 1, remoteBackend: 'CI-owned durable conditional HTTP with fixture SDK adapter',
      nativeEfContinuation: true, restoredGeneration: manifest.generation };
  } catch (error) { failed = true; failure = error; report.error = errorObservation(error); }
  finally {
    const cleanupErrors = [];
    for (const worker of workers) try {
      const closed = await worker.stop(); closedWorkers.add(worker);
      (report.workerCleanup ??= []).push(closed);
      if (closed.emergencyTerminationRequested || !closed.deliberatelyTerminated && (closed.code !== 0 || closed.signal !== null)) {
        throw new Error('A restore worker required emergency cleanup or failed to exit normally.', { cause: closed });
      }
    }
    catch (error) { ownerCloseFailed = true; cleanupErrors.push(error); }
    for (const operation of [() => stopNative('finally-native'),
      ...[...sqliteOwners].filter(owner => !closedSqliteOwners.has(owner)).map(owner => () => closeSqlite(owner)),
      async () => { if (proxy) { await proxy.close(); proxyClosed = true; } },
      () => sourceStorage?.registry.close(), () => sourceServer?.close(),
      () => targetStorage?.registry.close(), () => targetServer?.close(), () => dropPostgresTestDatabase(fresh),
      () => dropPostgresTestDatabase(database), ...[...databaseOwners].map(owner => () => closeDatabase(owner)),
      () => current?.finish()]) {
      try { await operation(); } catch (error) { ownerCloseFailed = true; cleanupErrors.push(error); }
    }
    metrics.restore();
    report.cleanup = { nativeExited: native === undefined && closedNativeOwners.size === nativeOwners.size,
      sqliteClosed: sqlite === undefined && closedSqliteOwners.size === sqliteOwners.size,
      workersClosed: closedWorkers.size === workers.length,
      portAvailable: await portAvailable(port), proxyClosed: !proxy || proxyClosed,
      postgresOwnersClosed: closedDatabaseOwners.size === databaseOwners.size,
      remoteOwnersClosed: [remoteSource, remoteTarget].filter(Boolean).every(owner => owner.report.servers.every(server =>
        server.result?.code === 0 && server.result?.signal === null && server.closed?.activeRequests === 0
        && server.closed?.openDescriptors === 0 && server.portRebound === true)),
      deliberatelyTerminatedWorkers: report.workers.filter(worker => worker.deliberatelyTerminated).map(worker => worker.mode),
      normalOwnerClosure: !ownerCloseFailed,
      errors: cleanupErrors.map(errorObservation) };
    if (!report.cleanup.nativeExited || !report.cleanup.sqliteClosed || !report.cleanup.workersClosed || !report.cleanup.portAvailable
      || !report.cleanup.proxyClosed || !report.cleanup.postgresOwnersClosed || !report.cleanup.remoteOwnersClosed) {
      ownerCloseFailed = true; cleanupErrors.push(new Error('Production instance owners did not drain.'));
    }
    if (t.signal.aborted && !failed) { failed = true; failure = t.signal.reason; report.error = errorObservation(failure); }
    const primaryFailed = failed, primaryFailure = failure;
    report.cleanup.errors = cleanupErrors.map(errorObservation); report.passed = !failed && cleanupErrors.length === 0;
    report.cleanup.normalOwnerClosure = !ownerCloseFailed;
    if (report.passed) { report.productionScaleVerified = true; report.fullInstanceVerified = true; }
    if (ownerCloseFailed) report.privateRootRetained = true;
    const reportSecrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES, current?.accessToken].filter(Boolean));
    let publicationFailed = false;
    try {
      await writeFile(path.join(root, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
      if (!ownerCloseFailed) await output.publishAndClose();
      else {
        await mkdir(destination);
        await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, passed: false, privateRootRetained: true }, reportSecrets));
      }
    } catch (error) { cleanupErrors.push(error); publicationFailed = true; }
    const combineFailures = () => new AggregateError(primaryFailed ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
      'Production instance state exchange failed or could not drain.', primaryFailed ? { cause: primaryFailure } : undefined);
    if (cleanupErrors.length) { failure = combineFailures(); failed = true; report.error = errorObservation(failure); }
    if (publicationFailed) {
      report.passed = false; report.productionScaleVerified = false; report.fullInstanceVerified = false;
      report.publicationFailed = true; report.cleanup.errors = cleanupErrors.map(errorObservation);
      // Correct an already-created public report if publication stopped partway.
      // Failure to write that failure report remains the last cleanup error.
      try { await writeFile(path.join(destination, 'report.json'), filterEvidenceJson(report, reportSecrets)); }
      catch (error) { cleanupErrors.push(error); failure = combineFailures(); report.error = errorObservation(failure); }
    }
  }
  if (failed) {
    if (failure === null || typeof failure !== 'object') throw failure;
    throw output.publicError(failure);
  }
}, { signal: t.signal }), { signal: t.signal }));
