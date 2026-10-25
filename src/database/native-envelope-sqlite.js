import { DatabaseSync, constants } from 'node:sqlite';
import { normalizeNativeEnvelope } from './native-envelope.js';
import { inspectSqliteSchema, preflightSqlite } from './sqlite-schema.js';

function schemaAuthorizer(action, name, column, databaseName) {
  const schemaActions = new Set([constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_INDEX, constants.SQLITE_REINDEX]);
  if (schemaActions.has(action)) return databaseName === 'main' ? constants.SQLITE_OK : constants.SQLITE_DENY;
  if ([constants.SQLITE_INSERT, constants.SQLITE_UPDATE].includes(action)) {
    return databaseName === 'main' && name === 'sqlite_master' ? constants.SQLITE_OK : constants.SQLITE_DENY;
  }
  if (action === constants.SQLITE_FUNCTION) return column?.toLowerCase() === 'lower' ? constants.SQLITE_OK : constants.SQLITE_DENY;
  if (action === constants.SQLITE_READ) return databaseName === 'main' ? constants.SQLITE_OK : constants.SQLITE_DENY;
  return constants.SQLITE_DENY;
}

/** Execute only ordinary main-schema table/index declarations. The caller owns the transaction. */
export function installNativeEnvelopeSchema(database, ddl) {
  database.setAuthorizer(schemaAuthorizer);
  try {
    for (const sql of ddl.filter(value => /^CREATE TABLE /iu.test(value))) database.exec(sql);
    for (const sql of ddl.filter(value => !/^CREATE TABLE /iu.test(value))) database.exec(sql);
  } finally {
    database.setAuthorizer(null);
  }
}

/** Deep-validate a native SQLite schema/history envelope without touching an output file. */
export function validateNativeEnvelope(value) {
  const envelope = normalizeNativeEnvelope(value);
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  try {
    database.exec('BEGIN');
    try {
      installNativeEnvelopeSchema(database, envelope.ddl);
      const hasHistory = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__EFMigrationsHistory'").get();
      if (!hasHistory && envelope.history.length) throw new Error('Native database envelope lacks its migration history table');
      if (hasHistory) {
        const insert = database.prepare('INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES (?, ?)');
        for (const row of envelope.history) insert.run(row.MigrationId, row.ProductVersion);
      }
      const hasSequence = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      if (!hasSequence && envelope.sqliteSequence.length) throw new Error('Native database envelope lacks sqlite_sequence');
      if (hasSequence) {
        const insert = database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
        for (const entry of envelope.sqliteSequence) insert.run(entry.name, entry.seq);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const schema = preflightSqlite(database);
    const inspected = inspectSqliteSchema(database);
    if (JSON.stringify(inspected.ddl) !== JSON.stringify(envelope.ddl)
      || schema.fingerprint !== envelope.fingerprint
      || JSON.stringify(schema.history) !== JSON.stringify(envelope.history)
      || JSON.stringify(schema.sqliteSequence, (_, item) => typeof item === 'bigint' ? item.toString() : item)
        !== JSON.stringify(envelope.sqliteSequence, (_, item) => typeof item === 'bigint' ? item.toString() : item)) {
      throw new Error('Native database envelope does not reconstruct its declared SQLite state');
    }
    return envelope;
  } finally {
    database.close();
  }
}
