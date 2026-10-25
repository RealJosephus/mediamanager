import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from './postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('PostgreSQL close retains its actual backend and temporary objects until physical disconnect completes', {
  skip: !postgresTestConnectionString, timeout: 30000,
}, async () => {
  const database = await createPostgresTestDatabase(null, 'pool_end', { max: 1 });
  const auditor = new pg.Client({ connectionString: postgresTestConnectionString });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const temporary = 'pool_close_' + randomUUID().replaceAll('-', '');
  let client, closing, completed = false, identity;
  try {
    await auditor.connect();
    database.pool.once('acquire', value => { client = value; });
    await database.withConnection(async session => {
      identity = (await session.client.query('SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
      await session.client.query(`CREATE TEMP TABLE "${temporary}"(value integer)`);
    });
    const disconnect = client.end.bind(client);
    client.end = async (...args) => { entered.resolve(); await release.promise; return disconnect(...args); };
    closing = database.close(); closing.then(() => { completed = true; }, () => {});
    await entered.promise;
    const alive = () => auditor.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz', [identity.pid, identity.started]);
    const present = () => auditor.query('SELECT relname FROM pg_class WHERE relname=$1 AND relpersistence=\'t\'', [temporary]);
    assert.deepEqual((await alive()).rows.map(row => row.pid), [identity.pid]);
    assert.deepEqual((await present()).rows.map(row => row.relname), [temporary]);
    assert.equal(completed, false);
    release.resolve(); await closing;
    assert.equal(completed, true);
    assert.deepEqual((await alive()).rows, []);
    assert.deepEqual((await present()).rows, []);
    assert.equal((await auditor.query('SELECT 1 AS usable')).rows[0].usable, 1);
  } finally {
    release.resolve();
    try { await (closing ?? database.close()); }
    finally { try { await auditor.end(); } finally { await dropPostgresTestDatabase(database); } }
  }
});
