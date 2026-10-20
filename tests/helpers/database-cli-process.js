import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { exportCurrentSqlite } from '../../src/migration/database-transfer.js';
import { createLockedSqliteSnapshot } from '../../tools/database/cli-common.js';
import { runImportJellyfinCli } from '../../tools/database/import-jellyfin.js';
import { runExportJellyfinCli } from '../../tools/database/export-jellyfin.js';

const [mode, temporaryRoot, ...argv] = process.argv.slice(2);
let snapshot, target;
async function pause(event, database) {
  const identity = await database.databaseIdentity();
  const namespaces = (await database.client.query({ text: `SELECT nspname AS name, oid::text AS oid,
    nspowner::text AS owner FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname COLLATE "C"`,
  values: [[database.schemaName, database.controlSchema]] })).rows;
  await new Promise((resolve, reject) => process.send({ event, pid: process.pid, identity, namespaces,
    snapshot: snapshot?.filename }, error => error ? reject(error) : resolve()));
  await new Promise((_, reject) => process.once('disconnect', () => reject(new Error('CLI recovery test parent disconnected.'))));
}

try {
  if (mode === 'created' || mode === 'committed') {
    process.exitCode = await runImportJellyfinCli(argv, {
      async createSourceSnapshot(filename) {
        snapshot = await createLockedSqliteSnapshot(filename, { temporaryRoot });
        return snapshot;
      },
      async openPostgres(options) {
        target = await PostgresDatabase.open(options);
        if (mode === 'created') await pause('target-created', target);
        return target;
      },
      async initializeTarget(database) {
        if (mode === 'committed') await pause('import-committed', database);
        await database.initializeRuntimeSchema();
      }
    });
  } else {
    assert.equal(mode, 'published');
    process.exitCode = await runExportJellyfinCli(argv, {
      async exportSqlite(database, filename, options) {
        const result = await exportCurrentSqlite(database, filename, options);
        await pause('export-published', database);
        return result;
      }
    });
  }
} finally {
  await target?.close();
  if (process.connected) process.disconnect();
}
