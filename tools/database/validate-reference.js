import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import {
  databaseDigest,
  pinnedNativeSqliteSchemaFingerprint,
} from '../../src/migration/database-transfer.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { importJellyfinSqlite } from './import-jellyfin.js';
import { exportJellyfinSqlite } from './export-jellyfin.js';

const [sourceFilename, destination, bindingFilename, contractFilename,
  connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES] = process.argv.slice(2);
if (!sourceFilename || !destination || !bindingFilename || !contractFilename || !connectionString
  || process.argv.length > 7) {
  throw new Error('Usage: node tools/database/validate-reference.js SOURCE_SQLITE NEW_EVIDENCE_DIRECTORY INSTANCE_BINDING_JSON PORTABLE_MOUNT_CONTRACT_JSON [POSTGRES_CONNECTION]');
}

await mkdir(destination, { recursive: false });
const schema = `reference_${process.pid}_${Date.now().toString(36)}`;
const returnedFilename = path.join(destination, 'returned.db');
let postgres, nativeSource, output, imported = false, operationError;
try {
  const forward = await importJellyfinSqlite([
    '--source', sourceFilename,
    '--postgres-url', connectionString,
    '--schema', schema,
    '--instance-binding', bindingFilename,
    '--mount-contract', contractFilename,
  ]);
  imported = true;
  postgres = await PostgresDatabase.open({ connectionString, schema });
  const marker = await postgres.insert('ActivityLogs', {
    DateCreated: '2026-09-26 12:34:56.1234567',
    ItemId: null,
    LogSeverity: 2,
    Name: 'Node PostgreSQL current-state migration proof',
    Overview: 'Inserted after Jellyfin import; preserved on return to SQLite.',
    RowVersion: 0n,
    ShortOverview: null,
    Type: 'System',
    UserId: '00000000-0000-0000-0000-000000000000',
  });
  await postgres.update('ActivityLogs', { Id: marker.Id }, {
    ShortOverview: 'Current Node state with a Unicode sample: café',
    Name: 'Node PostgreSQL edited current-state migration proof',
  }, { rowVersion: 0n });
  const reverse = await exportJellyfinSqlite([
    '--postgres-url', connectionString,
    '--schema', schema,
    '--output', returnedFilename,
  ]);
  output = new SqliteDatabase(returnedFilename, { readOnly: true, requireMigrationHistory: true });
  nativeSource = new SqliteDatabase(sourceFilename, { readOnly: true, requireMigrationHistory: true });
  if (output.schema.fingerprint !== pinnedNativeSqliteSchemaFingerprint) {
    throw new Error('Native DDL fingerprint changed during the reference round trip');
  }
  if (JSON.stringify(output.schema.history) !== JSON.stringify(nativeSource.schema.history)) {
    throw new Error('Native migration history changed during the reference round trip');
  }
  const currentDigest = await databaseDigest(output);
  if (JSON.stringify(currentDigest) !== JSON.stringify(await databaseDigest(postgres))) {
    throw new Error('PostgreSQL current state differs from the returned SQLite database');
  }
  const integrity = output.database.prepare('PRAGMA integrity_check').get();
  if (integrity.integrity_check !== 'ok' || output.database.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Returned SQLite integrity validation failed');
  }
  const markerRow = output.rows('ActivityLogs', { where: { Id: marker.Id } })[0];
  const report = {
    schemaFingerprint: output.schema.fingerprint,
    migrationHistoryRows: output.schema.history.length,
    currentDigest,
    marker: markerRow,
    forward,
    reverse,
    claims: {
      relationalRoundTrip: true,
      strictPinnedEnvelope: true,
      currentActivityLogMutation: true,
      sqliteIntegrity: true,
      mediaAccess: false,
      clientWorkflows: false,
      fullInstanceState: false,
    },
  };
  await writeFile(path.join(destination, 'report.json'),
    `${JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
  console.log(JSON.stringify({
    destination: path.resolve(destination),
    tables: currentDigest.length,
    migrationHistoryRows: output.schema.history.length,
    currentStateMarkerId: marker.Id,
  }));
} catch (error) { operationError = error; }
finally {
  const cleanupErrors = [];
  try { output?.close(); } catch (error) { cleanupErrors.push(error); }
  try { nativeSource?.close(); } catch (error) { cleanupErrors.push(error); }
  try { await postgres?.close(); } catch (error) { cleanupErrors.push(error); }
  if (imported) {
    const cleanup = new pg.Client({ connectionString });
    try {
      await cleanup.connect();
      await cleanup.query('BEGIN');
      try {
        await cleanup.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`);
        await cleanup.query('COMMIT');
      } catch (error) {
        try { await cleanup.query('ROLLBACK'); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError],
            'Reference schema cleanup and rollback both failed', { cause: error });
        }
        throw error;
      }
    } catch (error) { cleanupErrors.push(error); }
    finally {
      try { await cleanup.end(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  const failures = [...(operationError ? [operationError] : []), ...cleanupErrors];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Reference roundtrip and cleanup did not complete cleanly', {
      cause: operationError,
    });
  }
}
