import path from 'node:path';
import { openSkipperPublication, stageSkipperData } from './intro-skipper-data.js';
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
  npm run db:export -- (--postgres-url <url> | --postgres-url-env <name>) --schema <schema> --output <new-jellyfin.db> [--target-mount-contract <contract.json>] [--intro-skipper-output <directory>]

An existing output is accepted only after verification against the current
PostgreSQL snapshot. Export never replaces an existing file. Export uses the
portable mount contract persisted in PostgreSQL. An optional target contract may
explicitly retarget identity paths between Windows and POSIX without changing
mount IDs or VFS access roots. Use --intro-skipper-output to restore the plugin's
captured databases to the chosen directory alongside the Jellyfin database.
`;

export async function exportJellyfinSqlite(argv, {
  environment = process.env,
  openPostgres = options => PostgresDatabase.open(options),
  verifyPostgres = database => verifyPostgresTransferContract(database, {
    requirePinnedEnvelope: true,
    requirePortableMountContract: true,
  }),
  exportSqlite = exportCurrentSqlite,
  afterMainPublish,
} = {}) {
  const options = parseNamedOptions(argv, {
    required: ['--schema', '--output'],
    optional: ['--postgres-url', '--postgres-url-env', '--target-mount-contract', '--intro-skipper-output'],
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

  let result, operationError, skipper, publication;
  try {
    await verifyPostgres(source);
    const exportOptions = targetContract ? { targetPortableMountContract: targetContract } : {};
    const companion = options['--intro-skipper-output'] && path.resolve(options['--intro-skipper-output']);
    if (companion) {
      publication = await openSkipperPublication(companion, output);
      exportOptions.readSourceSnapshot = async session => { skipper = await stageSkipperData(session, publication.stage); };
      result = await exportSqlite(source, output, exportOptions);
      if (afterMainPublish) await afterMainPublish();
      await publication.publish(skipper.files);
    } else result = await exportSqlite(source, output, exportOptions);
  } catch (cause) {
    operationError = cliError('SQLITE_EXPORT_FAILED', `The PostgreSQL to SQLite export failed: ${cause.message}`,
      databaseCliExitCodes.operation, cause);
  }
  const cleanupErrors = await closeResources([publication, source]);
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
    ...(skipper?.files.length ? {
      introSkipperDatabases: skipper.files.map(file => file.name),
      ...(skipper.baseline ? { introSkipperCapture: skipper.baseline } : {}),
    } : {}),
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
