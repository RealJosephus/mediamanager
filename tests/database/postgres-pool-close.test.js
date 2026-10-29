import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
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

test('production linked-child owner close waits for its own physical backend and TEMP objects', {
  skip: !postgresTestConnectionString, timeout: 30000,
}, async t => {
  const auditor = new pg.Client({ connectionString: postgresTestConnectionString });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), aborted = Promise.withResolvers();
  const temporary = 'links_pool_close_' + randomUUID().replaceAll('-', '');
  let database, links, client, disconnect, ended, closing, outcome, identity;
  let completed = false, closeFailureWasPrimary = false, failed = false, failure;
  const onAbort = () => { release.resolve(); aborted.resolve(); };
  t.signal.addEventListener('abort', onAbort, { once: true });
  const beginClose = () => {
    if (!closing) {
      closing = Promise.resolve().then(() => links.close());
      outcome = closing.then(value => { completed = true; return { failed: false, value }; },
        reason => { completed = true; return { failed: true, reason }; });
    }
    return outcome;
  };
  try {
    database = await createPostgresTestDatabase(null, 'links_pool_end', { max: 1 });
    t.signal.throwIfAborted();
    await auditor.connect();
    t.signal.throwIfAborted();
    links = new PostgresLinkedChildrenStore({ database });
    await links.initialize();
    t.signal.throwIfAborted();
    links.relationDatabase.pool.once('acquire', value => { client = value; });
    await links.withSession(async relation => {
      await relation.client.query(`CREATE TEMP TABLE "${temporary}"(value integer)`);
      identity = (await relation.client.query(`SELECT pid,backend_start::text AS started,
        pg_my_temp_schema() AS temporary_schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
    });
    assert.notEqual(identity.pid, (await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    assert.notEqual(identity.pid, (await auditor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    ended = Promise.withResolvers();
    client.once('end', ended.resolve);
    disconnect = client.end;
    client.end = async (...args) => { entered.resolve(); await release.promise; return disconnect.apply(client, args); };

    const arrival = await Promise.race([
      entered.promise.then(() => ({ kind: 'disconnect' })),
      beginClose().then(value => ({ kind: 'closed', ...value })),
      aborted.promise.then(() => ({ kind: 'aborted' })),
    ]);
    if (arrival.kind === 'closed') {
      if (arrival.failed) { closeFailureWasPrimary = true; throw arrival.reason; }
      throw new Error('The relation owner completed before reaching its physical disconnect.');
    }
    if (arrival.kind === 'aborted') throw t.signal.reason;
    const alive = () => auditor.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',
      [identity.pid, identity.started]);
    const present = () => auditor.query(`SELECT relname FROM pg_class
      WHERE relname=$1 AND relnamespace=$2::oid AND relpersistence='t'`, [temporary, identity.temporary_schema]);
    assert.deepEqual((await alive()).rows.map(row => row.pid), [identity.pid]);
    assert.deepEqual((await present()).rows.map(row => row.relname), [temporary]);
    assert.equal((await database.client.query('SELECT 1 AS usable')).rows[0].usable, 1);
    assert.equal((await auditor.query('SELECT 1 AS usable')).rows[0].usable, 1);
    assert.equal(completed, false, 'links.close must still own its gated physical backend.');

    release.resolve();
    const result = await outcome;
    if (result.failed) { closeFailureWasPrimary = true; throw result.reason; }
    assert.equal(completed, true);
    assert.deepEqual((await alive()).rows, []);
    assert.deepEqual((await present()).rows, []);
    assert.deepEqual((await auditor.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [links.schemaName])).rows, []);
    assert.equal((await database.client.query('SELECT 1 AS usable')).rows[0].usable, 1);
    assert.equal((await auditor.query('SELECT 1 AS usable')).rows[0].usable, 1);
  } catch (reason) { failed = true; failure = reason; }
  finally {
    release.resolve();
    const cleanupErrors = [];
    const attempt = async operation => { try { await operation(); } catch (reason) { cleanupErrors.push(reason); } };
    if (links) await attempt(async () => {
      const result = await beginClose();
      if (result.failed && !closeFailureWasPrimary) throw result.reason;
    });
    if (ended) await attempt(() => ended.promise);
    if (client && disconnect) client.end = disconnect;
    if (links && database) await attempt(() => database.client.query(`DROP SCHEMA IF EXISTS "${links.schemaName}" CASCADE`));
    await attempt(() => auditor.end());
    if (database) await attempt(() => dropPostgresTestDatabase(database));
    t.signal.removeEventListener('abort', onAbort);
    if (cleanupErrors.length) {
      if (!failed && cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'Relation physical-close observation and cleanup failed.', { cause: failed ? failure : cleanupErrors[0] });
    }
    if (failed) throw failure;
  }
});
