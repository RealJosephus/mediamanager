import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { queryPostgresBuiltInSearch } from '../../src/library/postgres-search-provider.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['postgres'];
const search = { searchterm: 'catalogue', limit: 3 };
const providerSql = /^WITH provider_candidates AS MATERIALIZED \(/u;

async function holdCatalogueLock(database) {
  const connection = new pg.Client({ connectionString: postgresTestConnectionString });
  await connection.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(`LOCK TABLE "${database.schemaName}"."BaseItems" IN ACCESS EXCLUSIVE MODE`);
  } catch (error) { await connection.end(); throw error; }
  return connection;
}

async function activity(observer, pid) {
  await observer.query('SELECT pg_stat_clear_snapshot()');
  return (await observer.query('SELECT state, wait_event_type, query FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
}

async function waitForLock(observer, pid, signal) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const row = await activity(observer, pid);
    if (row?.wait_event_type === 'Lock') {
      assert.match(row.query, providerSql);
      return;
    }
    await delay(10, undefined, { signal });
  }
  assert.fail('The backend did not report a waiting provider query.');
}

test('the PostgreSQL provider cancels an executing lock wait and preserves the next query on its session', { timeout: 30_000 }, async t => {
  const database = await createPostgresTestDatabase(t, 'search_cancel', { max: 1 });
  await database.withConnection(async db => {
    const pid = (await db.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const lock = await holdCatalogueLock(database);
    const stop = new AbortController();
    const result = queryPostgresBuiltInSearch(db, search, { signal: stop.signal }).catch(error => error);
    try {
      await waitForLock(lock, pid, t.signal);
      const next = db.client.query('SELECT pg_backend_pid() AS pid');
      stop.abort();
      assert.equal(await Promise.race([result, delay(3000, 'provider still running', { ref: false })]), stop.signal.reason);
      assert.deepEqual((await next).rows, [{ pid }]);
      assert.notEqual((await activity(lock, pid)).wait_event_type, 'Lock');
      t.diagnostic(JSON.stringify({ blockedBackend: pid, cancelledBeforeUnlock: true, sameBackendReused: true }));
    } finally { await lock.end(); await result; }
  });
});

for (const route of ['/Items', '/Users/{userId}/Items']) {
  test(`disconnecting ${route} cancels its actual PostgreSQL search with the table still locked`, { timeout: 30_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mm-search-request-'));
    const database = await createPostgresTestDatabase(null, 'search_request', { max: 1 });
    let runtime, lock, request;
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), finished = Promise.withResolvers();
    const original = database.client.query;
    try {
      const errors = [];
      runtime = await createTestRuntime({ database, programDataPath: root,
        configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
        serverId: '22330000000000000000000000000001', onError: error => errors.push(error) });
      const apiKey = (await runtime.apiKeys.create('Search cancellation fixture')).AccessToken;
      const user = route.startsWith('/Users') ? await runtime.users.createUser({ Name: 'Search cancellation' }) : null;
      const endpoint = user ? route.replace('{userId}', user.Id) : route;
      const queryItems = runtime.library.queryItems.bind(runtime.library);
      runtime.library.queryItems = async (...args) => {
        try { const result = await queryItems(...args); finished.resolve(result); return result; }
        catch (error) { finished.resolve(error); throw error; }
      };
      database.client.query = async (statement, ...args) => {
        if (providerSql.test(statement?.text ?? '')) {
          const pid = (await original('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          entered.resolve({ signal: statement.signal, pid });
          await proceed.promise;
        }
        return original(statement, ...args);
      };
      const port = runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
      const url = 'http://127.0.0.1:' + port + endpoint + '?searchTerm=catalogue&Recursive=true&Limit=3';
      const headers = { 'X-Emby-Token': apiKey };
      request = get(url, { agent: false, headers });
      request.on('error', () => {});
      const admitted = await Promise.race([entered.promise, delay(5000, null, { ref: false })]);
      assert.ok(admitted?.signal, 'The HTTP action must pass its signal to the provider SQL.');
      assert.equal(admitted.signal.aborted, false);
      lock = await holdCatalogueLock(database);
      proceed.resolve();
      await waitForLock(lock, admitted.pid, t.signal);
      request.destroy();
      const result = await Promise.race([finished.promise, delay(3000, 'library still running', { ref: false })]);
      assert.equal(admitted.signal.aborted, true);
      assert.equal(result, admitted.signal.reason);
      assert.notEqual((await activity(lock, admitted.pid)).wait_event_type, 'Lock');
      assert.deepEqual(errors, []);
      await lock.end(); lock = undefined;
      database.client.query = original;
      const healthy = await fetch(url, { headers, signal: t.signal });
      assert.equal(healthy.status, 200);
      assert.ok(Array.isArray((await healthy.json()).Items));
      t.diagnostic(JSON.stringify({ endpoint: route, blockedBackend: admitted.pid, cancelledBeforeUnlock: true, retry: healthy.status }));
    } finally {
      request?.destroy(); proceed.resolve();
      database.client.query = original;
      try { await lock?.end(); }
      finally {
        try { await runtime?.close(); }
        finally { try { await dropPostgresTestDatabase(database); } finally { await rm(root, { recursive: true, force: true }); } }
      }
    }
  });
}
