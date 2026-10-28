import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { readNativeImageRows } from '../../src/database/native-relation-order.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { verifyStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { createSqliteExportPathProjector } from '../../src/migration/sqlite-export-paths.js';
import { orderedExchangeSnapshot } from '../helpers/ordered-exchange-snapshot.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite', 'dotnet', 'jellyfinDll'];
const ids = Object.freeze({
  retained: '86000000-0000-0000-0000-000000000001',
  deleted: '86000000-0000-0000-0000-000000000002',
  nodeAdded: '86000000-0000-0000-0000-000000000003',
  nativeAdded: '86000000-0000-0000-0000-000000000004',
  image9: '86000000-0000-0000-0000-000000000009',
  image7: '86000000-0000-0000-0000-000000000007',
  image5: '86000000-0000-0000-0000-000000000005',
});
const unknownData = '{ "UnknownProvider" : [9223372036854775807,"中文"], "dup":1, "dup":2, "null":null }';
const playbackTicks = 9223372036854775000n;

function startWorker(mode, options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../helpers/state-package-process.js', import.meta.url)),
    mode, options.instanceRoot, options.packageDirectory, options.destination, options.baseline], {
    env: { ...process.env, MM_STATE_PROCESS_SCHEMA: options.schema }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let diagnostics = '', delivered = false, killRequested = false;
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ pid: child.pid, code, signal })));
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${mode} did not reach its boundary: ${diagnostics}`)), 90000);
    child.once('message', value => { delivered = true; clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); if (!delivered) reject(new Error(`${mode} exited before its boundary: ${diagnostics}`)); });
  });
  return { child, closed, message, diagnostics: () => diagnostics,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) killRequested = child.kill('SIGKILL');
      return { ...await closed, killRequested };
    } };
}

test('postgres: recovered current native state package preserves mutations through native continuation and fresh import', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE
    || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 360000
}, async () => {
  const destination = path.join(validationOutputRoot(), 'state-process-recovery-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const workingRoot = await realpath(output.root);
  const report = { workers: [], cleanup: {} }, workers = [];
  let database, reimported, source, restored, failure;
  try {
    const supplied = await currentNativeSqliteInputs();
    const sourceState = await discoverInstanceState({ instanceRoot: supplied.initialization.root });
    const instanceRoot = path.join(workingRoot, 'instance');
    const cloned = await cloneStoppedInstance({ instanceState: sourceState, destination: instanceRoot });
    assert.equal(createHash('sha256').update(await readFile(cloned.paths.sqlite)).digest('hex'), supplied.receipt.input.sha256);
    const asset = Buffer.from([0, 255, 0, 42, 127, 128, 10, 13]);
    await mkdir(path.join(instanceRoot, 'config/plugins'), { recursive: true });
    await writeFile(path.join(instanceRoot, 'config/plugins/recovery-fixture.bin'), asset, { flag: 'wx' });
    const replacedAsset = path.join(instanceRoot, 'config/plugins/replaced.bin');
    const deletedAsset = path.join(instanceRoot, 'config/plugins/deleted.bin');
    await writeFile(replacedAsset, 'source asset');
    await writeFile(deletedAsset, 'source asset removed while using Node');
    source = new SqliteDatabase(cloned.paths.sqlite, { requireMigrationHistory: true });
    // This private stopped copy needs no WAL readers. Closing its source handle
    // must not change the instance generation between the two worker processes.
    source.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.database.exec('PRAGMA journal_mode=DELETE');
    const userId = source.rows('Users', { limit: 1 })[0]?.Id;
    assert.ok(userId, 'The initialized current native input has an actual user.');
    for (const [Id, Name] of [[ids.retained, 'Source item'], [ids.deleted, 'Source item deleted by Node']]) {
      source.insert('BaseItems', postgresTestRow('BaseItems', { Id, Name,
        Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Data: unknownData }));
    }
    const imageDirectory = path.join(instanceRoot, 'data/metadata/recovery');
    await mkdir(imageDirectory, { recursive: true });
    const images = [ids.image9, ids.image7, ids.image5].map((Id, index) => postgresTestRow('BaseItemImageInfos', {
      Id, ItemId: ids.retained, ImageType: 0, Path: path.join(imageDirectory, `image-${[9, 7, 5][index]}.bin`),
      DateModified: '2026-10-20 12:34:56.1234567', Width: 11 + index, Height: 19 + index,
      Blurhash: Buffer.from([0, 255, index]),
    }));
    for (const image of images) { source.insert('BaseItemImageInfos', image); await writeFile(image.Path, image.Blurhash); }
    source.insert('UserData', postgresTestRow('UserData', { ItemId: ids.retained, UserId: userId,
      CustomDataKey: 'state-package-recovery', PlaybackPositionTicks: playbackTicks, PlayCount: 2,
      LastPlayedDate: '2026-10-20 12:34:56.1234567', Likes: null, AudioStreamIndex: 2, SubtitleStreamIndex: 7 }));
    const instanceState = await discoverInstanceState({ instanceRoot });
    database = await createPostgresTestDatabase(null, 'state_process');
    report.imported = await transferDatabase(source, database, { instanceBinding: {
      serverId: instanceState.identity.serverId, originIdentityDigest: instanceState.identity.digest
    }, portableMountContract: supplied.receipt.mountContract });
    source.close(); source = undefined;
    await database.update('BaseItems', { Id: ids.retained }, { Name: 'Edited by Node before interruption' });
    await database.delete('BaseItems', { Id: ids.deleted });
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: ids.nodeAdded, Name: 'Added by Node before interruption',
      Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video', Data: unknownData }));
    await database.update('UserData', { ItemId: ids.retained, UserId: userId, CustomDataKey: 'state-package-recovery' }, {
      IsFavorite: true, PlaybackPositionTicks: playbackTicks + 3n,
    });
    await database.delete('BaseItemImageInfos', { Id: ids.image7 });
    await database.insert('BaseItemImageInfos', images[1]);
    const nodeImages = [ids.image9, ids.image5, ids.image7];
    assert.deepEqual((await readNativeImageRows(database, [ids.retained])).map(row => row.Id), nodeImages);
    await writeFile(replacedAsset, asset);
    await unlink(deletedAsset);
    const marker = await database.insert('ActivityLogs', { DateCreated: '2026-10-20 12:34:56.1234567', ItemId: null,
      LogSeverity: 2, Name: 'Current PostgreSQL state after import', Overview: 'Retained after actual process interruption.',
      RowVersion: 0n, ShortOverview: null, Type: 'System', UserId: '00000000-0000-0000-0000-000000000000' });
    await database.update('ActivityLogs', { Id: marker.Id }, { Name: 'Edited current PostgreSQL state', ShortOverview: '中文 / retained' }, { rowVersion: 0n });
    const deletedMarker = await database.insert('ActivityLogs', postgresTestRow('ActivityLogs', {
      DateCreated: '2026-10-20 12:34:56.1234567', Name: 'Deleted sequence high-water', Type: 'System', UserId: userId,
    }));
    await database.delete('ActivityLogs', { Id: deletedMarker.Id });
    report.postgresTables = await databaseDigest(database);
    report.postgresSnapshot = await orderedExchangeSnapshot(database);
    report.input = { sourceSha256: supplied.receipt.input.sha256, schema: supplied.receipt.schema.canonicalFingerprint,
      build: supplied.initialization.build, sourceIdentity: sourceState.identity.digest, bindings: supplied.inputs };
    const options = { schema: database.schemaName, instanceRoot, packageDirectory: path.join(workingRoot, 'package'),
      destination: path.join(workingRoot, 'restored'), baseline: 'current-native-' + supplied.receipt.input.sha256 };
    const run = mode => { const worker = startWorker(mode, options); workers.push(worker); return worker; };
    const capture = run('capture-interrupted');
    assert.equal((await capture.message).event, 'capture-durable');
    const captureStaging = path.join(workingRoot, '.package.mediamanager-package-staging');
    const interrupted = JSON.parse(await readFile(path.join(captureStaging, 'progress.json')));
    assert.equal(interrupted.stage, 'database-captured'); assert.equal(interrupted.lastError, null);
    await assert.rejects(access(options.packageDirectory), { code: 'ENOENT' });
    report.workers.push({ mode: 'capture-interrupted', ...await capture.stop() });
    assert.equal(report.workers.at(-1).killRequested, true); assert.notEqual(report.workers.at(-1).code, 0);
    const resumedCapture = run('capture');
    const captured = await resumedCapture.message;
    assert.equal(captured.event, 'complete'); assert.equal(captured.generation, interrupted.generation);
    report.workers.push({ mode: 'capture', ...await resumedCapture.closed });
    assert.equal(report.workers.at(-1).code, 0, resumedCapture.diagnostics());
    const manifest = await verifyStatePackage(options.packageDirectory);
    assert.equal(manifest.generation, interrupted.generation);
    await assert.rejects(access(captureStaging), { code: 'ENOENT' });

    const preparationWorker = run('restore-preparation-interrupted');
    const preparationBoundary = await preparationWorker.message;
    assert.equal(preparationBoundary.event, 'restore-preparation-durable');
    assert.equal(preparationBoundary.preparation.stage, 'database-opened');
    const preparation = preparationBoundary.preparation;
    const preparedDirectory = path.join(preparation.staging, preparation.relativeDirectory);
    assert.equal(path.dirname(preparedDirectory), preparation.staging);
    assert.equal(path.dirname(preparation.staging), workingRoot);
    const preparationBinding = JSON.parse(await readFile(path.join(preparedDirectory, 'binding.json'), 'utf8'));
    assert.equal(preparationBinding.generation, manifest.generation);
    assert.equal(preparationBinding.destination, options.destination);
    assert.equal(preparationBinding.manifestSha256, createHash('sha256').update(await readFile(path.join(options.packageDirectory, 'manifest.json'))).digest('hex'));
    assert.equal(preparationBinding.sourceSha256, manifest.database.sha256);
    assert.equal(createHash('sha256').update(await readFile(path.join(preparedDirectory, 'jellyfin.db'))).digest('hex'), manifest.database.sha256);
    const preparationFiles = await readdir(preparedDirectory);
    assert.ok(preparationFiles.includes('binding.json')); assert.ok(preparationFiles.includes('jellyfin.db'));
    await assert.rejects(restoreStatePackage(options.packageDirectory, options.destination), /already active/u);
    report.workers.push({ mode: 'restore-preparation-interrupted', boundary: preparation,
      deliberatelyTerminated: true, ...await preparationWorker.stop() });
    assert.equal(report.workers.at(-1).killRequested, true); assert.notEqual(report.workers.at(-1).code, 0);
    // The interrupted process did not run finally. Its actual open-database
    // preparation remains inside the bound staging for the next owner.
    assert.deepEqual(await readdir(preparedDirectory), preparationFiles);

    const restore = run('restore-interrupted');
    const progress = await restore.message;
    assert.equal(progress.event, 'restore-durable'); assert.equal(progress.progress.completed, 1);
    assert.equal(progress.progress.path, manifest.database.restorePath);
    assert.equal(progress.preparation.recovered, true);
    assert.equal(progress.preparation.requestSha256, preparation.requestSha256);
    assert.ok(progress.preparation.recoveredFiles.includes('binding.json'));
    assert.ok(progress.preparation.recoveredFiles.includes('jellyfin.db'));
    await assert.rejects(access(preparedDirectory), { code: 'ENOENT' });
    report.preparationRecovery = { interruptedBinding: preparationBinding, filesPresentAfterKill: preparationFiles,
      recovered: progress.preparation, removedBeforeFirstFileCallback: true };
    await assert.rejects(access(options.destination), { code: 'ENOENT' });
    await assert.rejects(restoreStatePackage(options.packageDirectory, options.destination), /already active/u);
    report.workers.push({ mode: 'restore-interrupted', boundary: progress.progress, ...await restore.stop() });
    assert.equal(report.workers.at(-1).killRequested, true); assert.notEqual(report.workers.at(-1).code, 0);
    const resumedRestore = run('restore');
    const result = await resumedRestore.message;
    assert.equal(result.event, 'complete'); assert.equal(result.resumed, true); assert.equal(result.alreadyRestored, false);
    assert.ok(result.reusedFiles >= 1); assert.equal(result.generation, interrupted.generation);
    report.workers.push({ mode: 'restore', result, ...await resumedRestore.closed });
    assert.equal(report.workers.at(-1).code, 0, resumedRestore.diagnostics());
    assert.deepEqual(await readFile(path.join(options.destination, 'config/plugins/recovery-fixture.bin')), asset);
    assert.deepEqual(await readFile(path.join(options.destination, 'config/plugins/replaced.bin')), asset);
    await assert.rejects(access(path.join(options.destination, 'config/plugins/deleted.bin')), { code: 'ENOENT' });
    const returnedState = await discoverInstanceState({ instanceRoot: options.destination });
    assert.equal(returnedState.identity.serverId, instanceState.identity.serverId);
    restored = new SqliteDatabase(returnedState.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(await databaseDigest(restored), result.databaseProjection.tables);
    const packaged = new SqliteDatabase(path.join(options.packageDirectory, manifest.database.path), { readOnly: true });
    try {
      const projectionOptions = { sourceContract: manifest.database.portableMountContract, targetContract: manifest.database.portableMountContract,
        instanceStatePaths: result.databaseProjection.sourceInstanceStatePaths,
        targetInstanceStatePaths: result.databaseProjection.targetInstanceStatePaths };
      const tables = createSqliteExportPathProjector(projectionOptions), order = createSqliteExportPathProjector(projectionOptions);
      const expected = await orderedExchangeSnapshot(packaged, { rowTransform: tables.projectRow, insertionRowTransform: order.projectRow });
      const actual = await orderedExchangeSnapshot(restored);
      assert.equal(actual.tables.length, 31); assert.equal(Object.keys(actual.insertionOrder).length, 6);
      assert.deepEqual(actual, expected);
      report.restoreSnapshots = { expected, actual, projectionOptions };
    } finally { packaged.close(); }
    assert.deepEqual(restored.schema.history, report.imported.migrationHistory);
    const returnedMarker = restored.rows('ActivityLogs', { where: { Id: marker.Id } });
    assert.equal(returnedMarker.length, 1); assert.equal(returnedMarker[0].Name, 'Edited current PostgreSQL state');
    assert.equal(returnedMarker[0].ShortOverview, '中文 / retained'); assert.equal(returnedMarker[0].RowVersion, 1n);
    assert.equal(restored.rows('BaseItems', { where: { Id: ids.retained } })[0].Name, 'Edited by Node before interruption');
    assert.equal(restored.rows('BaseItems', { where: { Id: ids.retained } })[0].Data, unknownData);
    assert.deepEqual(restored.rows('BaseItems', { where: { Id: ids.deleted } }), []);
    assert.equal(restored.rows('BaseItems', { where: { Id: ids.nodeAdded } }).length, 1);
    assert.deepEqual((await readNativeImageRows(restored, [ids.retained])).map(row => row.Id), nodeImages);
    assert.equal(restored.rows('UserData', { where: { ItemId: ids.retained, UserId: userId } })[0].PlaybackPositionTicks, playbackTicks + 3n);
    assert.deepEqual(await databaseDigest(database), report.postgresTables);
    assert.deepEqual(await orderedExchangeSnapshot(database), report.postgresSnapshot);
    const repeated = await restoreStatePackage(options.packageDirectory, options.destination);
    assert.equal(repeated.alreadyRestored, true); assert.equal(repeated.manifest.generation, interrupted.generation);
    restored.close(); restored = undefined;
    const continuationInput = path.join(workingRoot, 'continuation-input.json');
    const continuationOutput = path.join(output.root, 'native-continuation');
    await writeFile(continuationInput, JSON.stringify({ ids, userId, markerId: marker.Id, deletedMarkerId: deletedMarker.Id }));
    const continuation = await recordOracle({ project: 'tests/migration/fixtures/state-package-continuation/Oracle.csproj',
      output: continuationOutput, args: [returnedState.paths.sqlite, continuationInput, '{output}/result.json'] });
    assert.equal(continuation.passed, true);
    const native = JSON.parse(await readFile(path.join(continuationOutput, 'result.json')));
    assert.deepEqual(native.before.images, nodeImages);
    assert.equal(native.before.name, 'Edited by Node before interruption');
    assert.equal(native.before.data, unknownData);
    assert.equal(native.before.playbackPositionTicks, String(playbackTicks + 3n));
    assert.equal(parseJsonDateTime(native.before.lastPlayedDate).ticks,
      parseJsonDateTime('2026-10-20T12:34:56.1234567Z').ticks);
    assert.equal(native.before.likes, null);
    assert.equal(native.before.deletedItemPresent, false);
    assert.equal(native.before.nodeAddedItemPresent, true);
    assert.equal(native.before.deletedActivityPresent, false);
    assert.equal(native.before.favorite, true);
    assert.deepEqual(native.after.images, [ids.image9, ids.image7]);
    assert.equal(native.after.nodeAddedItemPresent, false);
    assert.equal(native.after.nativeAddedItemPresent, true);
    assert.equal(native.after.activityName, 'Native continued after recovered package');
    assert.equal(native.after.activityRowVersion, 2);
    assert.ok(native.addedActivityId > deletedMarker.Id, 'Native continuation retains the deleted PostgreSQL sequence high-water.');
    assert.equal(native.after.playbackPositionTicks, String(playbackTicks + 10n));
    const continuedState = await discoverInstanceState({ instanceRoot: options.destination });
    assert.equal(continuedState.identity.serverId, instanceState.identity.serverId);
    restored = new SqliteDatabase(continuedState.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
    const continuedTables = await databaseDigest(restored);
    assert.notDeepEqual(continuedTables, manifest.database.tables);
    reimported = await createPostgresTestDatabase(null, 'state_continued');
    report.reimported = await transferDatabase(restored, reimported, { instanceBinding: {
      serverId: continuedState.identity.serverId, originIdentityDigest: continuedState.identity.digest,
    }, portableMountContract: supplied.receipt.mountContract });
    assert.deepEqual(await databaseDigest(reimported), continuedTables);
    assert.deepEqual(report.reimported.migrationHistory, report.imported.migrationHistory);
    assert.deepEqual((await readNativeImageRows(reimported, [ids.retained])).map(row => row.Id), [ids.image9, ids.image7]);
    assert.equal((await reimported.rows('BaseItems', { where: { Id: ids.retained } }))[0].Data, unknownData);
    assert.equal((await reimported.rows('BaseItems', { where: { Id: ids.retained } }))[0].Name, 'Native continued after recovered package');
    assert.deepEqual(await reimported.rows('BaseItems', { whereIn: { Id: [ids.deleted, ids.nodeAdded] } }), []);
    assert.equal((await reimported.rows('BaseItems', { where: { Id: ids.nativeAdded } })).length, 1);
    const returnedUserData = (await reimported.rows('UserData', { where: { ItemId: ids.retained, UserId: userId } }))[0];
    assert.equal(returnedUserData.PlaybackPositionTicks, playbackTicks + 10n);
    assert.equal(returnedUserData.PlayCount, 3);
    const freshActivity = await reimported.insert('ActivityLogs', postgresTestRow('ActivityLogs', {
      DateCreated: '2026-10-20 12:34:56.1234567', Name: 'Fresh PostgreSQL continued after Native', Type: 'System', UserId: userId,
    }));
    assert.ok(freshActivity.Id > native.addedActivityId);
    assert.deepEqual(await databaseDigest(database), report.postgresTables);
    report.continuation = { native, nativeTables: continuedTables, freshPostgresActivityId: freshActivity.Id,
      serverIdPreserved: continuedState.identity.serverId === instanceState.identity.serverId };
    assert.deepEqual(await orderedExchangeSnapshot(database), report.postgresSnapshot);
    report.comparison = { passed: true, generation: interrupted.generation, restoredTables: result.databaseProjection.tables,
      unknownAssetSha256: createHash('sha256').update(asset).digest('hex'), restoreReusedFiles: result.reusedFiles,
      captureGenerationPreserved: true, ownerLeaseReleasedAfterKill: true, postgresSourceUnchanged: true,
      nodeInsertUpdateDeletePreserved: true, assetReplacementAndDeletionPreserved: true,
      nativeEfContinuation: true, freshPostgresReimport: true, unknownDataAndRelationOrderPreserved: true,
      productionScaleVerified: false };
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    const cleanupErrors = [];
    for (const worker of workers) {
      try { await worker.stop(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const handle of [restored, source]) try { handle?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const current of [reimported, database]) {
      try { await dropPostgresTestDatabase(current); }
      catch (error) { cleanupErrors.push(error); }
    }
    report.cleanup.postgresSchemasRemoved = cleanupErrors.length === 0;
    for (const [original, published] of [
      ['record.json', 'native-record.log'], ['result.json', 'native-result.log'],
      ['build.stdout.txt', 'native-build-stdout.log'], ['build.stderr.txt', 'native-build-stderr.log'],
      ['stdout.txt', 'native-stdout.log'], ['stderr.txt', 'native-stderr.log'],
    ]) {
      try { await copyFile(path.join(output.root, 'native-continuation', original), path.join(output.root, published)); }
      catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); }
    }
    report.cleanup.workersClosed = workers.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null);
    report.cleanup.forcedRecoveryBoundaries = report.workers.filter(worker => worker.killRequested).map(worker => worker.mode);
    report.cleanup.naturallyCompletedWorkers = report.workers.filter(worker => !worker.killRequested).map(worker => ({ mode: worker.mode, code: worker.code }));
    report.cleanup.errors = cleanupErrors.map(error => error.message);
    await writeFile(path.join(output.root, 'report.json'), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    await output.publishAndClose();
    if (!failure && cleanupErrors.length) failure = new AggregateError(cleanupErrors, 'Process recovery cleanup failed.');
  }
  if (failure) throw output.publicError(failure);
});
