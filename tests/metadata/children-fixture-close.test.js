import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import pg from 'pg';
import { setupChildrenFixture } from './children-fixture.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { LibraryService } from '../../src/library/library-service.js';
import { StorageRegistry } from '../../src/storage/index.js';
import { postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const failureValue = error => ({ message: error.message, code: error.code, status: error.status, statusCode: error.statusCode,
  ...(error.cause !== undefined && { cause: failureValue(error.cause) }),
  ...(error.errors !== undefined && { errors: Array.from(error.errors, failureValue) }) });

test('postgres: an early metadata fixture setup failure releases its actual schemas, connections, storage and directory', {
  skip: !postgresTestConnectionString, timeout: 30000,
}, async t => {
  const opened = [], roots = [], storageOwners = [], storageClosed = [];
  const source = Object.assign(new Error('Controlled failure after the real metadata storage instance opened.', {
    cause: Object.assign(new Error('Controlled setup source failure.'), { code: 'fixture-setup-cause' }),
  }), { code: 'fixture-setup' });
  const openDatabase = PostgresDatabase.open;
  t.mock.method(PostgresDatabase, 'open', async function (...args) {
    const database = await openDatabase.apply(this, args);
    const pid = (await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    opened.push({ database, schema: database.schemaName, pid }); return database;
  });
  const closeLibrary = LibraryService.prototype.close;
  t.mock.method(LibraryService.prototype, 'close', async function (...args) {
    roots.push(this.options.programDataPath); return closeLibrary.apply(this, args);
  });
  const createInstance = StorageRegistry.prototype.createInstance, closeStorage = StorageRegistry.prototype.close;
  t.mock.method(StorageRegistry.prototype, 'createInstance', async function (...args) {
    const instance = await createInstance.apply(this, args);
    if (args[0] === 'fixture') { storageOwners.push(this); throw source; }
    return instance;
  });
  t.mock.method(StorageRegistry.prototype, 'close', async function (...args) {
    const result = await closeStorage.apply(this, args); storageClosed.push({ completed: true }); return result;
  });
  await t.test('the controlled error remains complete while the real after hook drains setup owners', async child => {
    await assert.rejects(setupChildrenFixture(child), error => {
      child.diagnostic(JSON.stringify({ phase: 'metadata-fixture-setup', ...failureValue(error), stack: error.stack }));
      assert.deepEqual(failureValue(error), failureValue(source)); return true;
    });
  });
  assert.ok(opened.some(entry => entry.schema.startsWith('metadata_children_')), 'The real fixture database was opened.');
  for (const owner of storageOwners) assert.throws(() => owner.getInstance('fixture'), { code: 'closed' });
  for (const root of roots) await assert.rejects(stat(root), { code: 'ENOENT' });
  for (const { database } of opened) await assert.rejects(async () => database.client.query('SELECT 1'), /closed|not open|ending|terminat|released|cannot use/iu);
  const observer = new pg.Client({ connectionString: postgresTestConnectionString }); await observer.connect();
  try {
    const schemas = (await observer.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[]) ORDER BY nspname', [opened.map(entry => entry.schema)])).rows;
    const connections = (await observer.query('SELECT pid,state FROM pg_stat_activity WHERE pid=ANY($1::integer[]) ORDER BY pid', [opened.map(entry => entry.pid)])).rows;
    t.diagnostic(JSON.stringify({ phase: 'after-real-setup-cleanup', schemas, connections, directories: roots, storage: storageClosed }));
    assert.deepEqual(schemas, []); assert.deepEqual(connections, []);
  } finally { await observer.end(); }
});
