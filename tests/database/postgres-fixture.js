import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';

export const postgresTestConnectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;

export function postgresTestRow(table, values) {
  const defaults = Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column =>
    [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
      : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));
  return { ...defaults, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
}

function schemaName(prefix) {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_]/gu, '_').replace(/^[^A-Za-z_]/u, '_').slice(0, 15);
  return `${safePrefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export async function dropPostgresTestDatabase(database) {
  if (!database) return;
  let cleanup = database;
  if (database.closed) {
    cleanup = await PostgresDatabase.open({
      connectionString: postgresTestConnectionString,
      schema: database.schemaName,
    });
  }
  try {
    await cleanup.client.query(`DROP SCHEMA IF EXISTS ${q(cleanup.schemaName)}, ${q(cleanup.controlSchema)} CASCADE`);
  } finally {
    await cleanup.close();
  }
}

export async function createPostgresTestDatabase(t, prefix, options = {}) {
  if (!postgresTestConnectionString) throw new Error('MEDIAMANAGER_TEST_POSTGRES is required.');
  const database = await PostgresDatabase.open({
    connectionString: postgresTestConnectionString,
    schema: schemaName(prefix),
    create: true,
    ...options,
  });
  t?.after(() => dropPostgresTestDatabase(database));
  return database;
}
