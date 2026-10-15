import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { verifyPostgresTransferContract } from '../../src/database/postgres-transfer-contract.js';
import { exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { canonicalPortableMountContract } from '../../src/storage/portable-mount-contract.js';
import {
  cliError,
  closeResources,
  combineOperationAndCleanupError,
  databaseCliExitCodes,
  parseNamedOptions,
  readExplicitPostgresSchema,
  readExplicitPostgresUrl,
  readStableJsonFile,
  runDatabaseCli,
} from './cli-common.js';

export const exportJellyfinUsage = `
Usage:
  npm run db:export -- (--postgres-url <url> | --postgres-url-env <name>) --schema <schema> --output <new-jellyfin.db> [--target-mount-contract <contract.json>]

The output must be a new file. Export uses the portable mount contract persisted
in PostgreSQL. An optional target contract may explicitly retarget identity paths
between Windows and POSIX without changing mount IDs or VFS access roots.
`;

export async function exportJellyfinSqlite(argv, {
  environment = process.env,
  openPostgres = options => PostgresDatabase.open(options),
  verifyPostgres = database => verifyPostgresTransferContract(database, {
    requirePinnedEnvelope: true,
    requirePortableMountContract: true,
  }),
  exportSqlite = exportCurrentSqlite,
} = {}) {
  const options = parseNamedOptions(argv, {
    required: ['--schema', '--output'],
    optional: ['--postgres-url', '--postgres-url-env', '--target-mount-contract'],
  });
  const connectionString = readExplicitPostgresUrl(options, environment);
  const schema = readExplicitPostgresSchema(options);
  const output = path.resolve(options['--output']);
  const targetContract = options['--target-mount-contract']
    ? (await readStableJsonFile(options['--target-mount-contract'], 'Target portable mount contract',
      canonicalPortableMountContract)).value
    : undefined;

  let source;
  try { source = await openPostgres({ connectionString, schema, deferRuntimeSchemaInitialization: true }); }
  catch (cause) {
    throw cliError('POSTGRES_SOURCE_OPEN_FAILED',
      `The PostgreSQL export source could not be opened: ${cause.message}`,
      databaseCliExitCodes.postgres, cause);
  }

  let result, operationError;
  try {
    await verifyPostgres(source);
    result = await exportSqlite(source, output, targetContract
      ? { targetPortableMountContract: targetContract }
      : {});
  } catch (cause) {
    operationError = cliError('SQLITE_EXPORT_FAILED', `The PostgreSQL to SQLite export failed: ${cause.message}`,
      databaseCliExitCodes.operation, cause);
  }
  const cleanupErrors = await closeResources([source]);
  if (operationError) {
    throw combineOperationAndCleanupError(operationError, cleanupErrors, 'SQLITE_EXPORT_CLEANUP_FAILED');
  }
  if (cleanupErrors.length) {
    throw cliError('SQLITE_EXPORT_CLOSE_FAILED',
      `The SQLite export was published, but PostgreSQL cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`,
      databaseCliExitCodes.operation, new AggregateError(cleanupErrors));
  }

  return {
    ok: true,
    operation: 'postgres-to-sqlite',
    schema,
    output,
    nativeSchemaFingerprint: result.nativeSchemaFingerprint,
    migrationHistoryRows: result.migrationHistory.length,
    tables: result.tables,
    pathProjection: result.pathProjection,
    portableMountContract: result.portableMountContract,
    verified: result.verified === true,
  };
}

export async function runExportJellyfinCli(argv = process.argv.slice(2), options = {}) {
  return runDatabaseCli({
    argv,
    usage: exportJellyfinUsage,
    operation: args => exportJellyfinSqlite(args, options),
    stdout: options.stdout,
    stderr: options.stderr,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runExportJellyfinCli();
}
