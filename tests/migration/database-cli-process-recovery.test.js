import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { verifyPostgresTransferContract } from '../../src/database/postgres-transfer-contract.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { databaseCliExitCodes } from '../../tools/database/cli-common.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function startProcess(script, argv, temporaryRoot, ipc) {
  const child = spawn(process.execPath, [script, ...argv], { windowsHide: true, timeout: 90000, killSignal: 'SIGKILL',
    env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', killRequested = false, delivered = false;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ pid: child.pid, code, signal, stdout, stderr })));
  const message = ipc ? new Promise((resolve, reject) => {
    child.once('message', value => { delivered = true; resolve(value); });
    child.once('error', reject);
    child.once('close', () => { if (!delivered) reject(new Error(`CLI worker exited before its boundary: ${stderr}`)); });
  }) : undefined;
  child.once('error', error => { stderr += error.message; });
  return { child, message, closed, async stop() {
    if (child.exitCode === null && child.signalCode === null) killRequested = child.kill('SIGKILL');
    return { ...await closed, killRequested };
  } };
}

test('postgres: interrupted import ownership, committed data and published CLI export recover safely', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE, timeout: 360000
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'cli-process-recovery-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES); await mkdir(output.root);
  const root = await realpath(output.root), temporaryRoot = path.join(root, 'temporary'); await mkdir(temporaryRoot);
  const schemaPrefix = 'cli_kill_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const emptySchema = schemaPrefix + '_empty', committedSchema = schemaPrefix + '_full';
  const ownedNames = [emptySchema, emptySchema + '__mm', committedSchema, committedSchema + '__mm'];
  const workers = [], handles = [], report = { processes: [], boundaries: [], cleanup: {} };
  let guard, source, returned, failure;
  try {
    const supplied = await currentNativeSqliteInputs(), filename = path.join(root, 'source.db');
    await copyFile(supplied.filename, filename);
    assert.equal(sha256(await readFile(filename)), supplied.receipt.input.sha256);
    source = new SqliteDatabase(filename, { requireMigrationHistory: true });
    source.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); source.database.exec('PRAGMA journal_mode=DELETE');
    const expected = await databaseDigest(source), history = source.schema.history.map(row => ({ ...row }));
    source.close(); source = undefined;
    const preparedSha256 = sha256(await readFile(filename));
    const binding = { serverId: supplied.initialization.serverId, originIdentityDigest: preparedSha256 };
    const bindingFile = path.join(root, 'binding.json'), contractFile = path.join(root, 'mounts.json');
    await writeFile(bindingFile, JSON.stringify(binding)); await writeFile(contractFile, JSON.stringify(supplied.receipt.mountContract));
    report.input = { suppliedSha256: supplied.receipt.input.sha256, preparedSha256, privateJournalMode: 'delete',
      bindings: supplied.inputs, build: supplied.initialization.build };
    guard = await createPostgresTestDatabase(null, 'cli_guard');
    await guard.insert('ActivityLogs', postgresTestRow('ActivityLogs', { Name: 'Unrelated schema sentinel',
      DateCreated: '2026-10-20 00:00:00.1234567', UserId: '00000000-0000-0000-0000-000000000000' }));
    const guardBefore = await databaseDigest(guard);
    const namespaces = async (names, database = guard) => (await database.client.query({ text: `SELECT nspname AS name,
      oid::text AS oid, nspowner::text AS owner FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname COLLATE "C"`,
    values: [names] })).rows;
    assert.deepEqual(await namespaces(ownedNames), []);
    const pair = schema => [schema, schema + '__mm'];
    const importArguments = schema => ['--source', filename, '--postgres-url-env', 'MEDIAMANAGER_TEST_POSTGRES', '--schema', schema,
      '--instance-binding', bindingFile, '--mount-contract', contractFile];
    const exported = path.join(root, 'returned.db');
    const exportArguments = target => ['--postgres-url-env', 'MEDIAMANAGER_TEST_POSTGRES', '--schema', committedSchema, '--output', target];
    const start = (script, args, ipc = false) => {
      const worker = startProcess(script, args, temporaryRoot, ipc); workers.push(worker); return worker;
    };
    const interrupted = (mode, args) => start(fileURLToPath(new URL('../helpers/database-cli-process.js', import.meta.url)), [mode, temporaryRoot, ...args], true);
    const cli = async (operation, args, expectedCode) => {
      const script = operation === 'import' ? fileURLToPath(new URL('../../tools/database/import-jellyfin.js', import.meta.url))
        : fileURLToPath(new URL('../../tools/database/export-jellyfin.js', import.meta.url));
      const result = await start(script, args).closed; report.processes.push({ operation, ...result });
      assert.equal(result.code, expectedCode, result.stderr); assert.equal(result.signal, null);
      const lines = (expectedCode ? result.stderr : result.stdout).split(/\r?\n/u).filter(line => line.startsWith('{'));
      assert.equal(lines.length, 1); return JSON.parse(lines[0]);
    };
    const kill = async (worker, operation) => {
      const result = await worker.stop(); report.processes.push({ operation, ...result });
      assert.equal(result.killRequested, true); assert.notEqual(result.code, 0);
    };
    const open = async schema => {
      const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        schema, deferRuntimeSchemaInitialization: true }); handles.push(database); return database;
    };

    const first = interrupted('created', importArguments(emptySchema)), created = await first.message;
    report.boundaries.push(created); assert.equal(created.event, 'target-created');
    assert.deepEqual(created.identity, await guard.databaseIdentity()); assert.deepEqual(created.namespaces, await namespaces(pair(emptySchema)));
    assert.equal(created.namespaces.length, 2); await kill(first, 'import-created-killed');
    const empty = await open(emptySchema);
    assert.ok((await databaseDigest(empty)).every(table => table.rows === 0));
    assert.equal(await empty.readTransferReceipt(), null); assert.equal(await empty.readInstanceBinding(), null);
    await assert.rejects(empty.dropSchemasCreatedByThisOpen(), /not owned/u);
    const emptyReentry = await cli('import', importArguments(emptySchema), databaseCliExitCodes.postgres);
    assert.equal(emptyReentry.error.code, 'POSTGRES_TARGET_CREATE_FAILED');
    assert.deepEqual(created.namespaces, await namespaces(pair(emptySchema)));
    assert.ok((await databaseDigest(empty)).every(table => table.rows === 0)); await empty.close();
    // The fixture established absence, observed this child's exact namespace
    // OIDs and confirmed empty state. Discard only that owned interrupted pair.
    await guard.transaction(async database => {
      assert.deepEqual(await namespaces(pair(emptySchema), database), created.namespaces);
      await database.client.query(`DROP SCHEMA ${pair(emptySchema).map(q).join(', ')} CASCADE`);
    });
    assert.deepEqual(await namespaces(pair(emptySchema)), []);
    const fresh = await cli('import', importArguments(emptySchema), databaseCliExitCodes.success);
    assert.equal(fresh.verified, true); assert.deepEqual(fresh.tables, expected);
    assert.deepEqual(await databaseDigest(guard), guardBefore);

    const second = interrupted('committed', importArguments(committedSchema)), committed = await second.message;
    report.boundaries.push(committed); assert.equal(committed.event, 'import-committed');
    assert.deepEqual(committed.identity, created.identity); assert.deepEqual(committed.namespaces, await namespaces(pair(committedSchema)));
    await kill(second, 'import-committed-killed');
    const current = await open(committedSchema);
    const contract = await verifyPostgresTransferContract(current, { requirePortableMountContract: true });
    assert.deepEqual(contract.instanceBinding, binding); assert.deepEqual(contract.nativeEnvelope.history, history);
    assert.deepEqual(await databaseDigest(current), expected);
    await assert.rejects(current.dropSchemasCreatedByThisOpen(), /not owned/u);
    const committedReentry = await cli('import', importArguments(committedSchema), databaseCliExitCodes.postgres);
    assert.equal(committedReentry.error.code, 'POSTGRES_TARGET_CREATE_FAILED');
    assert.deepEqual(await current.readTransferReceipt(), contract.receipt);
    assert.deepEqual(await databaseDigest(current), expected);
    const runtime = await current.initializeRuntimeSchema();
    assert.match(runtime.fingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await verifyPostgresTransferContract(current, { requirePortableMountContract: true }), contract);

    const third = interrupted('published', exportArguments(exported)), published = await third.message;
    report.boundaries.push(published); assert.equal(published.event, 'export-published');
    const publishedSha256 = sha256(await readFile(exported)); await kill(third, 'export-published-killed');
    const recovered = await cli('export', exportArguments(exported), databaseCliExitCodes.success);
    assert.equal(recovered.verified, true); assert.deepEqual(recovered.tables, expected);
    assert.equal(sha256(await readFile(exported)), publishedSha256);
    returned = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(await databaseDigest(returned), expected); assert.deepEqual(returned.schema.history.map(row => ({ ...row })), history);
    returned.close(); returned = undefined;
    await current.insert('ActivityLogs', postgresTestRow('ActivityLogs', { Name: 'Current state after CLI recovery',
      DateCreated: '2026-10-20 12:34:56.1234567', UserId: '00000000-0000-0000-0000-000000000000', ShortOverview: '中文 / retained' }));
    const changed = await databaseDigest(current);
    const drift = await cli('export', exportArguments(exported), databaseCliExitCodes.operation);
    assert.equal(drift.error.code, 'SQLITE_EXPORT_FAILED'); assert.equal(sha256(await readFile(exported)), publishedSha256);
    const latestFile = path.join(root, 'latest.db');
    const latest = await cli('export', exportArguments(latestFile), databaseCliExitCodes.success);
    assert.equal(latest.verified, true); assert.deepEqual(latest.tables, changed);
    returned = new SqliteDatabase(latestFile, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(await databaseDigest(returned), changed); assert.deepEqual(returned.schema.history.map(row => ({ ...row })), history);
    assert.deepEqual(await databaseDigest(current), changed); assert.deepEqual(await databaseDigest(guard), guardBefore);
    assert.equal(sha256(await readFile(filename)), preparedSha256);
    const snapshots = await readdir(temporaryRoot);
    assert.equal(snapshots.length, 2); assert.ok(snapshots.every(name => name.startsWith('mediamanager-sqlite-import-')));
    report.comparison = { passed: true, expected, changed, historyRows: history.length, runtime,
      existingOutputSha256: publishedSha256, deadImportSnapshots: snapshots.length, sourceUnchanged: true,
      unownedCleanupRejected: true, emptyTargetReentryRejected: true, committedTargetReentryRejected: true,
      committedDataPreserved: true, publishedOutputResumed: true, staleOutputPreserved: true, unrelatedSchemaPreserved: true,
      productionScaleVerified: false };
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    const errors = [];
    for (const worker of workers) try { await worker.stop(); } catch (error) { errors.push(error); }
    for (const database of handles) try { await database.close(); } catch (error) { errors.push(error); }
    for (const handle of [returned, source]) try { handle?.close(); } catch (error) { errors.push(error); }
    if (guard) try {
      const existing = (await guard.client.query({ text: 'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])', values: [ownedNames] })).rows;
      if (existing.length) await guard.client.query(`DROP SCHEMA ${existing.map(row => q(row.nspname)).join(', ')} CASCADE`);
      assert.equal((await guard.client.query({ text: 'SELECT count(*)::int AS count FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])', values: [ownedNames] })).rows[0].count, 0);
      report.cleanup.targetSchemasRemoved = true;
    } catch (error) { errors.push(error); }
    try { await dropPostgresTestDatabase(guard); report.cleanup.guardSchemaRemoved = true; } catch (error) { errors.push(error); }
    report.cleanup.processesClosed = workers.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null);
    report.cleanup.errors = errors.map(error => error.message);
    await writeFile(path.join(output.root, 'report.json'), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    await output.publishAndClose();
    if (!failure && errors.length) failure = new AggregateError(errors, 'CLI process recovery cleanup failed.');
  }
  if (failure) throw output.publicError(failure);
});
