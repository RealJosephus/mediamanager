import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { canonicalNativeSqliteSchema } from '../../src/database/sqlite-schema.js';
import { canonicalInstanceBinding, PostgresDatabase } from '../../src/database/postgres.js';
import { assertPinnedJellyfinEnvelope, postgresCommitOutcomeUnknownCode,
  transferDatabase } from '../../src/migration/database-transfer.js';
import { canonicalPortableMountContract } from '../../src/storage/portable-mount-contract.js';
import {
  assertRegularInputFile,
  cliError,
  closeResources,
  combineOperationAndCleanupError,
  createLockedSqliteSnapshot,
  databaseCliExitCodes,
  parseNamedOptions,
  readExplicitPostgresSchema,
  readExplicitPostgresUrl,
  readStableJsonFile,
  runDatabaseCli,
} from './cli-common.js';

export const importJellyfinUsage = `
Usage:
  npm run db:import -- --source <jellyfin.db> (--postgres-url <url> | --postgres-url-env <name>) --schema <new-schema> --instance-binding <binding.json> --mount-contract <contract.json>

The PostgreSQL schema and its control schema must not already exist. The source
must be a pinned Jellyfin SQLite database on writable storage. The command holds
an SQLite write barrier only while creating a private point-in-time snapshot and
imports that snapshot. Binding and mount contract files are mandatory and are
never inferred from a storage URL.
`;

async function dropCreatedPostgresTarget(database) {
  if (typeof database?.dropSchemasCreatedByThisOpen !== 'function') {
    throw new Error('PostgreSQL target does not expose proof that this invocation created its schemas');
  }
  await database.dropSchemasCreatedByThisOpen();
}

function sourceEnvelope(source) {
  const canonical = canonicalNativeSqliteSchema();
  return {
    ...canonical,
    history: source.schema.history,
    sqliteSequence: source.schema.sqliteSequence,
  };
}

export async function importJellyfinSqlite(argv, {
  environment = process.env,
  createSource = (filename, options) => new SqliteDatabase(filename, options),
  createSourceSnapshot = filename => createLockedSqliteSnapshot(filename),
  openPostgres = options => PostgresDatabase.open(options),
  assertEnvelope = assertPinnedJellyfinEnvelope,
  transfer = transferDatabase,
  initializeTarget = database => database.initializeRuntimeSchema(),
  dropTarget = dropCreatedPostgresTarget,
} = {}) {
  const options = parseNamedOptions(argv, {
    required: ['--source', '--schema', '--instance-binding', '--mount-contract'],
    optional: ['--postgres-url', '--postgres-url-env'],
  });
  const connectionString = readExplicitPostgresUrl(options, environment);
  const schema = readExplicitPostgresSchema(options);
  const [sourceFilename, bindingInput, contractInput] = await Promise.all([
    assertRegularInputFile(options['--source'], 'SQLite source'),
    readStableJsonFile(options['--instance-binding'], 'Instance binding', canonicalInstanceBinding),
    readStableJsonFile(options['--mount-contract'], 'Portable mount contract', canonicalPortableMountContract),
  ]);

  let snapshot;
  try {
    snapshot = await createSourceSnapshot(sourceFilename);
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.filename !== 'string'
      || !snapshot.filename || typeof snapshot.assertUnchanged !== 'function'
      || typeof snapshot.close !== 'function') {
      throw new TypeError('SQLite source snapshot provider returned an invalid resource');
    }
  }
  catch (cause) {
    throw cliError('SOURCE_SQLITE_SNAPSHOT_FAILED',
      `The SQLite source could not be captured behind a write barrier: ${cause.message}`,
      databaseCliExitCodes.operation, cause);
  }

  let source;
  try {
    await snapshot.assertUnchanged();
    source = await createSource(snapshot.filename, { readOnly: true, requireMigrationHistory: true });
    assertEnvelope(sourceEnvelope(source));
    await snapshot.assertUnchanged();
  } catch (cause) {
    const error = cliError('SOURCE_SQLITE_INCOMPATIBLE',
      `The SQLite source failed pinned Jellyfin compatibility validation: ${cause.message}`,
      databaseCliExitCodes.compatibility, cause);
    throw combineOperationAndCleanupError(error, await closeResources([source, snapshot]), 'SOURCE_SQLITE_CLOSE_FAILED');
  }

  let target;
  try {
    // Runtime expression/covering indexes are intentionally built after the
    // bulk load so PostgreSQL can construct each one set-wise exactly once.
    target = await openPostgres({
      connectionString,
      schema,
      create: true,
      deferRuntimeSchemaInitialization: true,
    });
  } catch (cause) {
    const error = cliError('POSTGRES_TARGET_CREATE_FAILED',
      `The new PostgreSQL target could not be created: ${cause.message}`,
      databaseCliExitCodes.postgres, cause);
    throw combineOperationAndCleanupError(error, await closeResources([source, snapshot]), 'SOURCE_SQLITE_CLOSE_FAILED');
  }

  let result, operationError;
  try {
    await snapshot.assertUnchanged();
    const transferOptions = {
      instanceBinding: bindingInput.value,
      portableMountContract: contractInput.value,
    };
    try { result = await transfer(source, target, transferOptions); }
    catch (cause) {
      if (cause?.code !== postgresCommitOutcomeUnknownCode) throw cause;
      // The first COMMIT may already be durable. Re-running with the identical
      // immutable snapshot lets the persisted receipt prove success or fail
      // closed if the target contains anything else.
      await snapshot.assertUnchanged();
      result = await transfer(source, target, transferOptions);
    }
    await snapshot.assertUnchanged();
    await initializeTarget(target);
  } catch (cause) {
    operationError = cliError('SQLITE_IMPORT_FAILED', `The SQLite to PostgreSQL import failed: ${cause.message}`,
      databaseCliExitCodes.operation, cause);
  }

  const cleanupErrors = [];
  if (operationError) {
    try { await dropTarget(target); }
    catch (error) { cleanupErrors.push(error); }
  }
  cleanupErrors.push(...await closeResources([target, source, snapshot]));
  if (operationError) {
    throw combineOperationAndCleanupError(operationError, cleanupErrors, 'SQLITE_IMPORT_CLEANUP_FAILED');
  }
  if (cleanupErrors.length) {
    throw cliError('SQLITE_IMPORT_CLOSE_FAILED',
      `The import committed, but resource cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`,
      databaseCliExitCodes.operation, new AggregateError(cleanupErrors));
  }

  return {
    ok: true,
    operation: 'sqlite-to-postgres',
    source: sourceFilename,
    schema,
    nativeSchemaFingerprint: result.nativeSchemaFingerprint,
    migrationHistoryRows: result.migrationHistory.length,
    tables: result.tables,
    mountIds: contractInput.value.mounts.map(mount => mount.mountId),
    verified: result.verified === true,
  };
}

export async function runImportJellyfinCli(argv = process.argv.slice(2), options = {}) {
  return runDatabaseCli({
    argv,
    usage: importJellyfinUsage,
    operation: args => importJellyfinSqlite(args, options),
    stdout: options.stdout,
    stderr: options.stderr,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runImportJellyfinCli();
}
