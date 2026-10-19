import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import {
  databaseDigest,
  pinnedNativeSqliteMigrationHistory,
  pinnedNativeSqliteSchemaFingerprint,
  postgresCommitOutcomeUnknownCode,
} from '../../src/migration/database-transfer.js';
import { importJellyfinSqlite, runImportJellyfinCli } from '../../tools/database/import-jellyfin.js';
import { exportJellyfinSqlite, runExportJellyfinCli } from '../../tools/database/export-jellyfin.js';
import { createLockedSqliteSnapshot, databaseCliExitCodes, DatabaseCliError } from '../../tools/database/cli-common.js';

const instanceBinding = {
  serverId: '0123456789abcdef0123456789abcdef',
  originIdentityDigest: '0123456789abcdef'.repeat(4),
};
const sourceContract = {
  mounts: [{
    mountId: 'movies-main',
    identityRoot: 'Z:\\Media',
    accessRoot: '/vfs/movies',
    pathStyle: 'windows',
    caseSensitive: false,
    returnPolicy: 'required',
  }],
};
const targetContract = {
  mounts: [{
    mountId: 'movies-main',
    identityRoot: '/srv/jellyfin/media',
    accessRoot: '/vfs/movies',
    pathStyle: 'posix',
    caseSensitive: true,
    returnPolicy: 'required',
  }],
};
const migrationResult = {
  nativeSchemaFingerprint: 'a'.repeat(64),
  migrationHistory: [{ MigrationId: 'one', ProductVersion: '1' }],
  tables: [{ name: 'BaseItems', rows: 1, sha256: 'b'.repeat(64) }],
  sqliteSequence: [],
  verified: true,
};

async function createInputs() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-database-cli-'));
  const source = path.join(directory, 'jellyfin.db');
  const bindingFile = path.join(directory, 'binding.json');
  const contract = path.join(directory, 'mounts.json');
  const target = path.join(directory, 'target-mounts.json');
  await Promise.all([
    writeFile(source, ''),
    writeFile(bindingFile, JSON.stringify(instanceBinding)),
    writeFile(contract, JSON.stringify(sourceContract)),
    writeFile(target, JSON.stringify(targetContract)),
  ]);
  return { directory, source, bindingFile, contract, target, output: path.join(directory, 'returned.db') };
}

function importArguments(input, connection = ['--postgres-url-env', 'TEST_DATABASE_URL']) {
  return [
    '--source', input.source,
    ...connection,
    '--schema', 'jellyfin_cli_test',
    '--instance-binding', input.bindingFile,
    '--mount-contract', input.contract,
  ];
}

function exportArguments(input, extra = [], connection = ['--postgres-url-env', 'TEST_DATABASE_URL']) {
  return [
    ...connection,
    '--schema', 'jellyfin_cli_test',
    '--output', input.output,
    ...extra,
  ];
}

function fakeSource(events = []) {
  return {
    schema: { ddl: [], fingerprint: 'source', history: [], sqliteSequence: [] },
    close() { events.push('source:close'); },
  };
}

function passthroughSnapshot(filename) {
  return {
    filename,
    async assertUnchanged() {},
    async close() {},
  };
}

function stringWriter() {
  let value = '';
  return { stream: { write(chunk) { value += chunk; } }, read: () => value };
}

test('SQLite import snapshots hold a write barrier and remain stable after the source changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-import-snapshot-test-'));
  const sourceFilename = path.join(directory, 'source.db');
  const source = new DatabaseSync(sourceFilename);
  source.exec('CREATE TABLE values_table (value INTEGER NOT NULL); INSERT INTO values_table VALUES (1)');
  const sourceBytes = await readFile(sourceFilename);
  let snapshot;
  try {
    snapshot = await createLockedSqliteSnapshot(sourceFilename, {
      busyTimeoutMs: 0,
      async backupDatabase(reader, destination) {
        const competingWriter = new DatabaseSync(sourceFilename);
        try {
          competingWriter.exec('PRAGMA busy_timeout = 0');
          assert.throws(() => competingWriter.exec('BEGIN IMMEDIATE'), /locked/iu);
        } finally { competingWriter.close(); }
        await backup(reader, destination);
      },
    });
    assert.deepEqual(await readFile(sourceFilename), sourceBytes);
    source.exec('UPDATE values_table SET value = 2');
    await snapshot.assertUnchanged();
    const captured = new DatabaseSync(snapshot.filename, { readOnly: true });
    try { assert.equal(captured.prepare('SELECT value FROM values_table').get().value, 1); }
    finally { captured.close(); }
    const privateFilename = snapshot.filename;
    await snapshot.close();
    await assert.rejects(access(privateFilename), error => error.code === 'ENOENT');
  } finally {
    try { await snapshot?.close(); } catch {}
    source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite import snapshot creation fails closed when another writer owns the reservation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-import-snapshot-lock-test-'));
  const sourceFilename = path.join(directory, 'source.db');
  const writer = new DatabaseSync(sourceFilename);
  writer.exec('CREATE TABLE values_table (value INTEGER NOT NULL); BEGIN IMMEDIATE');
  try {
    await assert.rejects(createLockedSqliteSnapshot(sourceFilename, { busyTimeoutMs: 0 }),
      /write barrier could not be acquired/iu);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('import CLI requires explicit inputs and passes canonical binding and mount contract to one atomic transfer', async () => {
  const input = await createInputs();
  const events = [];
  let openedOptions, transferredOptions;
  const target = { close() { events.push('target:close'); } };
  try {
    const result = await importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://user:secret@database.invalid/media' },
      createSourceSnapshot: passthroughSnapshot,
      createSource(filename, options) {
        assert.equal(filename, path.resolve(input.source));
        assert.deepEqual(options, { readOnly: true, requireMigrationHistory: true });
        events.push('source:open');
        return fakeSource(events);
      },
      assertEnvelope(envelope) {
        assert.equal(envelope.fingerprint, pinnedNativeSqliteSchemaFingerprint);
        events.push('source:validated');
      },
      async openPostgres(options) { openedOptions = options; events.push('target:open'); return target; },
      async initializeTarget(actualTarget) {
        assert.equal(actualTarget, target);
        events.push('target:indexes');
      },
      async transfer(source, actualTarget, options) {
        assert.ok(source); assert.equal(actualTarget, target); transferredOptions = options;
        events.push('transfer');
        return migrationResult;
      },
    });
    assert.deepEqual(openedOptions, {
      connectionString: 'postgresql://user:secret@database.invalid/media',
      schema: 'jellyfin_cli_test',
      create: true,
      deferRuntimeSchemaInitialization: true,
    });
    assert.deepEqual(transferredOptions, {
      instanceBinding,
      portableMountContract: sourceContract,
    });
    assert.deepEqual(events, [
      'source:open', 'source:validated', 'target:open', 'transfer', 'target:indexes',
      'target:close', 'source:close',
    ]);
    assert.deepEqual(result.mountIds, ['movies-main']);
    assert.equal(result.verified, true);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI resolves a lost PostgreSQL COMMIT acknowledgement through the persisted receipt', async () => {
  const input = await createInputs();
  const events = [];
  let transfers = 0;
  const target = {
    async dropSchemasCreatedByThisOpen() { events.push('unexpected target drop'); },
    close() { events.push('target:close'); },
  };
  try {
    const result = await importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSourceSnapshot: passthroughSnapshot,
      createSource() { return fakeSource(events); },
      assertEnvelope() {},
      async openPostgres() { events.push('target:created'); return target; },
      async transfer(source, actualTarget, options) {
        assert.ok(source); assert.equal(actualTarget, target);
        assert.deepEqual(options, { instanceBinding, portableMountContract: sourceContract });
        transfers += 1;
        events.push(`transfer:${transfers}`);
        if (transfers === 1) {
          const error = new Error('injected lost COMMIT acknowledgement');
          error.code = postgresCommitOutcomeUnknownCode;
          throw error;
        }
        return migrationResult;
      },
      async initializeTarget() { events.push('target:indexes'); },
    });
    assert.equal(result.verified, true);
    assert.deepEqual(events, [
      'target:created', 'transfer:1', 'transfer:2', 'target:indexes',
      'target:close', 'source:close',
    ]);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI rejects storage configuration fields before opening either database', async () => {
  const input = await createInputs();
  try {
    const value = structuredClone(sourceContract);
    value.mounts[0].baseUrl = 'https://storage.invalid';
    await writeFile(input.contract, JSON.stringify(value));
    let opened = false;
    await assert.rejects(importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSource() { opened = true; },
      openPostgres() { opened = true; },
    }), error => error instanceof DatabaseCliError
      && error.code === 'INPUT_JSON_INVALID'
      && error.exitCode === databaseCliExitCodes.input);
    assert.equal(opened, false);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI drops only the schema created by this invocation when transfer fails', async () => {
  const input = await createInputs();
  const events = [];
  const target = {
    async dropSchemasCreatedByThisOpen() { events.push('target:dropped'); },
    close() { events.push('target:close'); },
  };
  try {
    await assert.rejects(importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSourceSnapshot: passthroughSnapshot,
      createSource() { return fakeSource(events); },
      assertEnvelope() {},
      async openPostgres() { events.push('target:created'); return target; },
      async transfer() { events.push('transfer'); throw new Error('injected transfer failure'); },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SQLITE_IMPORT_FAILED'
      && error.exitCode === databaseCliExitCodes.operation);
    assert.deepEqual(events, ['target:created', 'transfer', 'target:dropped', 'target:close', 'source:close']);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI drops its new target when the private source snapshot changes after transfer', async () => {
  const input = await createInputs();
  const events = [];
  let checks = 0;
  const target = { close() { events.push('target:close'); } };
  try {
    await assert.rejects(importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSourceSnapshot(filename) {
        return {
          filename,
          async assertUnchanged() {
            checks += 1;
            if (checks === 4) throw new Error('injected private snapshot mutation');
          },
          async close() { events.push('snapshot:close'); },
        };
      },
      createSource() { return fakeSource(events); },
      assertEnvelope() {},
      async openPostgres() { events.push('target:created'); return target; },
      async transfer() { events.push('transfer:committed'); return migrationResult; },
      async initializeTarget() { events.push('unexpected target indexes'); },
      async dropTarget(actual) { assert.equal(actual, target); events.push('target:dropped'); },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SQLITE_IMPORT_FAILED'
      && /private snapshot mutation/u.test(error.message));
    assert.deepEqual(events, [
      'target:created', 'transfer:committed', 'target:dropped',
      'target:close', 'source:close', 'snapshot:close',
    ]);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI drops a committed bulk load when deferred runtime index creation fails', async () => {
  const input = await createInputs();
  const events = [];
  const target = {
    async dropSchemasCreatedByThisOpen() { events.push('target:dropped'); },
    close() { events.push('target:close'); },
  };
  try {
    await assert.rejects(importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSourceSnapshot: passthroughSnapshot,
      createSource() { return fakeSource(events); },
      assertEnvelope() {},
      async openPostgres(options) {
        assert.equal(options.deferRuntimeSchemaInitialization, true);
        events.push('target:created');
        return target;
      },
      async transfer() { events.push('transfer:committed'); return migrationResult; },
      async initializeTarget(actual) {
        assert.equal(actual, target);
        events.push('target:indexes');
        throw new Error('injected runtime index failure');
      },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SQLITE_IMPORT_FAILED'
      && /runtime index failure/u.test(error.message));
    assert.deepEqual(events, [
      'target:created', 'transfer:committed', 'target:indexes', 'target:dropped',
      'target:close', 'source:close',
    ]);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('import CLI reports pinned source incompatibility without creating PostgreSQL state', async () => {
  const input = await createInputs();
  const events = [];
  try {
    await assert.rejects(importJellyfinSqlite(importArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      createSourceSnapshot: passthroughSnapshot,
      createSource() { return fakeSource(events); },
      assertEnvelope() { throw new Error('wrong native history'); },
      openPostgres() { events.push('unexpected target open'); },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SOURCE_SQLITE_INCOMPATIBLE'
      && error.exitCode === databaseCliExitCodes.compatibility);
    assert.deepEqual(events, ['source:close']);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('export CLI passes an explicit target contract to the atomic export API', async () => {
  const input = await createInputs();
  const events = [];
  let exportOptions;
  const source = { close() { events.push('source:close'); } };
  try {
    const result = await exportJellyfinSqlite(exportArguments(input, ['--target-mount-contract', input.target]), {
      environment: { TEST_DATABASE_URL: 'postgresql://user:secret@database.invalid/media' },
      async openPostgres(options) {
        assert.deepEqual(options, {
          connectionString: 'postgresql://user:secret@database.invalid/media', schema: 'jellyfin_cli_test',
          deferRuntimeSchemaInitialization: true,
        });
        events.push('source:open'); return source;
      },
      async verifyPostgres(actualSource) {
        assert.equal(actualSource, source);
        events.push('source:verified');
      },
      async exportSqlite(actualSource, filename, options) {
        assert.equal(actualSource, source); assert.equal(filename, path.resolve(input.output));
        exportOptions = options; events.push('export');
        return { ...migrationResult, pathProjection: { auditedPaths: 9, rewrittenPaths: 8 },
          portableMountContract: targetContract };
      },
    });
    assert.deepEqual(exportOptions, { targetPortableMountContract: targetContract });
    assert.deepEqual(events, ['source:open', 'source:verified', 'export', 'source:close']);
    assert.equal(result.output, path.resolve(input.output));
    assert.equal(result.pathProjection.rewrittenPaths, 8);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('export CLI uses only the persisted source contract when no target contract is supplied', async () => {
  const input = await createInputs();
  let exportOptions;
  try {
    await exportJellyfinSqlite(exportArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      async openPostgres() { return { close() {} }; },
      async verifyPostgres() {},
      async exportSqlite(source, output, options) {
        exportOptions = options;
        return { ...migrationResult, pathProjection: { auditedPaths: 0, rewrittenPaths: 0 },
          portableMountContract: sourceContract };
      },
    });
    assert.deepEqual(exportOptions, {});
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('export CLI rejects an incomplete PostgreSQL transfer contract before starting the SQLite export', async () => {
  const input = await createInputs();
  const events = [];
  try {
    await assert.rejects(exportJellyfinSqlite(exportArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      async openPostgres(options) {
        assert.equal(options.deferRuntimeSchemaInitialization, true);
        events.push('source:open');
        return { close() { events.push('source:close'); } };
      },
      async verifyPostgres() {
        events.push('source:verify');
        throw new Error('The PostgreSQL schema has no completed database transfer receipt.');
      },
      async exportSqlite() { events.push('unexpected export'); },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SQLITE_EXPORT_FAILED'
      && /no completed database transfer receipt/u.test(error.message));
    assert.deepEqual(events, ['source:open', 'source:verify', 'source:close']);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('export CLI preserves the core exporter failure and never rewrites an existing output itself', async () => {
  const input = await createInputs();
  const original = Buffer.from('existing output');
  await writeFile(input.output, original);
  try {
    await assert.rejects(exportJellyfinSqlite(exportArguments(input), {
      environment: { TEST_DATABASE_URL: 'postgresql://database.invalid/media' },
      async openPostgres() { return { close() {} }; },
      async verifyPostgres() {},
      async exportSqlite() {
        assert.deepEqual(await readFile(input.output), original);
        throw new Error('Migration target already exists');
      },
    }), error => error instanceof DatabaseCliError
      && error.code === 'SQLITE_EXPORT_FAILED'
      && error.exitCode === databaseCliExitCodes.operation);
    assert.deepEqual(await readFile(input.output), original);
  } finally { await rm(input.directory, { recursive: true, force: true }); }
});

test('CLI wrappers expose stable exit codes, JSON errors, redaction and English help', async () => {
  const stdout = stringWriter(), stderr = stringWriter();
  const code = await runImportJellyfinCli([
    '--postgres-url', 'postgresql://user:top-secret@database.invalid/media',
  ], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, databaseCliExitCodes.usage);
  assert.equal(stdout.read(), '');
  const failure = JSON.parse(stderr.read());
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'USAGE_MISSING_OPTION');
  assert.equal(stderr.read().includes('top-secret'), false);

  const helpOut = stringWriter(), helpError = stringWriter();
  assert.equal(await runExportJellyfinCli(['--help'], { stdout: helpOut.stream, stderr: helpError.stream }), 0);
  assert.match(helpOut.read(), /^Usage:/u);
  assert.equal(helpError.read(), '');
});

test('executable import CLI rejects unknown options with documented process exit code', () => {
  const result = spawnSync(process.execPath, ['tools/database/import-jellyfin.js', '--unknown', 'value'], {
    cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, databaseCliExitCodes.usage);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'USAGE_UNKNOWN_OPTION');
});

test('PostgreSQL create-open removes only its newly created schemas when later initialization fails', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 60_000,
}, async () => {
  const schema = `cli_open_cleanup_${process.pid}_${Date.now().toString(36)}`;
  const originalInitialize = PostgresDatabase.prototype.initializeRuntimeSchema;
  const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
  PostgresDatabase.prototype.initializeRuntimeSchema = async function injectedInitializationFailure() {
    throw new Error('injected post-create initialization failure');
  };
  try {
    await assert.rejects(PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema,
      create: true,
    }), /injected post-create initialization failure/u);
  } finally {
    PostgresDatabase.prototype.initializeRuntimeSchema = originalInitialize;
  }
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT to_regnamespace($1)::text AS application, to_regnamespace($2)::text AS control',
      [schema, `${schema}__mm`],
    );
    assert.deepEqual(rows[0], { application: null, control: null });
  } finally { await client.end().catch(() => {}); }
});

test('PostgreSQL schema cleanup rejects a database open that did not create the target', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 60_000,
}, async () => {
  const schema = `cli_owner_cleanup_${process.pid}_${Date.now().toString(36)}`;
  let owner, observer;
  try {
    owner = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
    });
    await assert.rejects(PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
    }), /already exists/u);
    assert.equal(await owner.preflight(), true);
    observer = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema,
    });
    await assert.rejects(observer.dropSchemasCreatedByThisOpen(), /not owned by this database open/u);
    await owner.dropSchemasCreatedByThisOpen();
    await assert.rejects(owner.dropSchemasCreatedByThisOpen(), /not owned by this database open/u);
  } finally {
    await observer?.close().catch(() => {});
    await owner?.close().catch(() => {});
    const cleanup = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end().catch(() => {}); }
  }
});

test('real CLI roundtrip preserves the current native SQLite source in PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE
    || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON,
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-database-cli-real-'));
  const schema = `cli_${process.pid}_${Date.now().toString(36)}`;
  const binding = path.join(directory, 'binding.json');
  const contract = path.join(directory, 'contract.json');
  const output = path.join(directory, 'jellyfin.db');
  await writeFile(binding, JSON.stringify(instanceBinding));
  await writeFile(contract, process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON);
  let client, native, returned;
  try {
    const imported = await importJellyfinSqlite([
      '--source', process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE,
      '--postgres-url-env', 'MEDIAMANAGER_TEST_POSTGRES',
      '--schema', schema,
      '--instance-binding', binding,
      '--mount-contract', contract,
    ]);
    assert.equal(imported.verified, true);
    assert.equal(imported.nativeSchemaFingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.equal(imported.migrationHistoryRows, pinnedNativeSqliteMigrationHistory.length);
    const exported = await exportJellyfinSqlite([
      '--postgres-url-env', 'MEDIAMANAGER_TEST_POSTGRES', '--schema', schema, '--output', output,
    ]);
    assert.equal(exported.verified, true);
    assert.equal(exported.nativeSchemaFingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.equal(exported.migrationHistoryRows, pinnedNativeSqliteMigrationHistory.length);
    native = new SqliteDatabase(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE, {
      readOnly: true, requireMigrationHistory: true,
    });
    returned = new SqliteDatabase(output, { readOnly: true, requireMigrationHistory: true });
    assert.deepEqual(returned.schema.history, native.schema.history);
    assert.deepEqual(await databaseDigest(returned), await databaseDigest(native));
    assert.equal(returned.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(returned.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    returned?.close();
    native?.close();
    client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try {
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`);
    } finally { await client.end().catch(() => {}); }
    await rm(directory, { recursive: true, force: true });
  }
});
