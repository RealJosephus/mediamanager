import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { verifyStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

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

test('postgres: current native state package survives killed capture and restore processes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE, timeout: 360000
}, async () => {
  const destination = path.join(validationOutputRoot(), 'state-process-recovery-' + randomUUID());
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const workingRoot = await realpath(output.root);
  const report = { workers: [], cleanup: {} }, workers = [];
  let database, source, restored, failure;
  try {
    const supplied = await currentNativeSqliteInputs();
    const sourceState = await discoverInstanceState({ instanceRoot: supplied.initialization.root });
    const instanceRoot = path.join(workingRoot, 'instance');
    const cloned = await cloneStoppedInstance({ instanceState: sourceState, destination: instanceRoot });
    assert.equal(createHash('sha256').update(await readFile(cloned.paths.sqlite)).digest('hex'), supplied.receipt.input.sha256);
    const asset = Buffer.from([0, 255, 0, 42, 127, 128, 10, 13]);
    await mkdir(path.join(instanceRoot, 'config/plugins'), { recursive: true });
    await writeFile(path.join(instanceRoot, 'config/plugins/recovery-fixture.bin'), asset, { flag: 'wx' });
    source = new SqliteDatabase(cloned.paths.sqlite, { requireMigrationHistory: true });
    // This private stopped copy needs no WAL readers. Closing its source handle
    // must not change the instance generation between the two worker processes.
    source.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.database.exec('PRAGMA journal_mode=DELETE');
    const instanceState = await discoverInstanceState({ instanceRoot });
    database = await createPostgresTestDatabase(null, 'state_process');
    report.imported = await transferDatabase(source, database, { instanceBinding: {
      serverId: instanceState.identity.serverId, originIdentityDigest: instanceState.identity.digest
    }, portableMountContract: supplied.receipt.mountContract });
    source.close(); source = undefined;
    const marker = await database.insert('ActivityLogs', { DateCreated: '2026-10-20 12:34:56.1234567', ItemId: null,
      LogSeverity: 2, Name: 'Current PostgreSQL state after import', Overview: 'Retained after actual process interruption.',
      RowVersion: 0n, ShortOverview: null, Type: 'System', UserId: '00000000-0000-0000-0000-000000000000' });
    await database.update('ActivityLogs', { Id: marker.Id }, { Name: 'Edited current PostgreSQL state', ShortOverview: '中文 / retained' }, { rowVersion: 0n });
    report.postgresTables = await databaseDigest(database);
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

    const restore = run('restore-interrupted');
    const progress = await restore.message;
    assert.equal(progress.event, 'restore-durable'); assert.equal(progress.progress.completed, 1);
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
    const returnedState = await discoverInstanceState({ instanceRoot: options.destination });
    assert.equal(returnedState.identity.serverId, instanceState.identity.serverId);
    restored = new SqliteDatabase(returnedState.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(await databaseDigest(restored), manifest.database.tables);
    assert.deepEqual(restored.schema.history, report.imported.migrationHistory);
    const returnedMarker = restored.rows('ActivityLogs', { where: { Id: marker.Id } });
    assert.equal(returnedMarker.length, 1); assert.equal(returnedMarker[0].Name, 'Edited current PostgreSQL state');
    assert.equal(returnedMarker[0].ShortOverview, '中文 / retained'); assert.equal(returnedMarker[0].RowVersion, 1n);
    assert.deepEqual(await databaseDigest(database), report.postgresTables);
    const repeated = await restoreStatePackage(options.packageDirectory, options.destination);
    assert.equal(repeated.alreadyRestored, true); assert.equal(repeated.manifest.generation, interrupted.generation);
    report.comparison = { passed: true, generation: interrupted.generation, restoredTables: manifest.database.tables,
      unknownAssetSha256: createHash('sha256').update(asset).digest('hex'), restoreReusedFiles: result.reusedFiles,
      captureGenerationPreserved: true, ownerLeaseReleasedAfterKill: true, postgresSourceUnchanged: true,
      productionScaleVerified: false };
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    const cleanupErrors = [];
    for (const worker of workers) {
      try { await worker.stop(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const handle of [restored, source]) try { handle?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresSchemasRemoved = true; }
    catch (error) { cleanupErrors.push(error); }
    report.cleanup.workersClosed = workers.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null);
    report.cleanup.errors = cleanupErrors.map(error => error.message);
    await writeFile(path.join(output.root, 'report.json'), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    await output.publishAndClose();
    if (!failure && cleanupErrors.length) failure = new AggregateError(cleanupErrors, 'Process recovery cleanup failed.');
  }
  if (failure) throw output.publicError(failure);
});
