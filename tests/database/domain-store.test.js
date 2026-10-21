import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { nativeModel } from '../../src/database/model.js';
import { fixtureRow } from './fixtures.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from './postgres-fixture.js';

const apiKey = name => ({
  Name: name,
  AccessToken: name,
  DateCreated: '2026-09-26 12:00:00',
  DateLastActivity: '2026-09-26 12:00:00'
});

async function bounded(promise, timeoutMs = 1000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      setTimeout(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`Operation exceeded ${timeoutMs}ms`);
      })
    ]);
  } finally { controller.abort(); }
}

async function postgresStoreFixture(t, prefix) {
  const database = await createPostgresTestDatabase(null, prefix, { max: 4 });
  const store = new DomainStore(database);
  t.after(async () => {
    await store.close();
    await dropPostgresTestDatabase(database);
  });
  return { database, store };
}

test('domain transactions serialize asynchronous writes and roll back without affecting the next request', {
  skip: !postgresTestConnectionString,
}, async (t) => {
  const { store } = await postgresStoreFixture(t, 'domain_serial');
  const calls = [];
  const failed = store.transaction(async (db) => {
    calls.push('first');
    await db.insert('ApiKeys', apiKey('rolled-back'));
    await setTimeout(10);
    assert.equal((await store.run((connection) => connection.rows('ApiKeys'))).length, 1);
    throw new Error('Injected failure');
  });
  const successful = store.transaction(async (db) => {
    calls.push('second');
    assert.equal((await db.rows('ApiKeys')).length, 0);
    await db.insert('ApiKeys', apiKey('committed'));
  });
  await assert.rejects(failed, /Injected failure/);
  await successful;
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual((await store.run((db) => db.rows('ApiKeys'))).map((key) => key.Name), ['committed']);
});

test('enqueued background writes leave a reentrant request and wait for its rollback', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { store } = await postgresStoreFixture(t, 'domain_enqueue');
  const calls = [];
  let background;
  const request = store.transaction(async db => {
    calls.push('request');
    await db.insert('ApiKeys', apiKey('request-rollback'));
    background = store.enqueue(async connection => {
      calls.push('background');
      assert.deepEqual(await connection.rows('ApiKeys'), [], 'the request has already rolled back');
      await store.run(nested => nested.insert('ApiKeys', apiKey('background-commit')));
    });
    await setTimeout(0);
    assert.deepEqual(calls, ['request'], 'background work must not inherit the active request scope');
    assert.equal((await store.run(connection => connection.rows('ApiKeys'))).length, 1, 'normal nested reads remain reentrant');
    throw new Error('Request rollback');
  });
  await assert.rejects(request, /Request rollback/);
  await bounded(background);
  assert.deepEqual(calls, ['request', 'background']);
  assert.deepEqual((await store.run(db => db.rows('ApiKeys'))).map(row => row.Name), ['background-commit']);
});

test('detached work cannot observe or join its originating PostgreSQL transaction', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { database, store } = await postgresStoreFixture(t, 'domain_detached');
  await assert.rejects(store.transaction(async db => {
    await db.insert('ApiKeys', apiKey('request-rollback'));
    await bounded(store.runDetached(async () => {
      // Direct repository calls and new domain operations must both leave the
      // caller's uncommitted connection, while normal nested calls still see it.
      assert.deepEqual(await database.rows('ApiKeys'), []);
      await store.run(async detached => {
        assert.deepEqual(await detached.rows('ApiKeys'), []);
        await detached.insert('ApiKeys', apiKey('detached-commit'));
      });
    }), 5000);
    assert.deepEqual((await store.run(nested => nested.rows('ApiKeys'))).map(row => row.Name),
      ['request-rollback'], 'The originating repeatable-read snapshot retains its own write.');
    throw new Error('Request rollback');
  }), /Request rollback/);
  assert.deepEqual((await store.run(db => db.rows('ApiKeys'))).map(row => row.Name), ['detached-commit']);
});

test('an awaited PostgreSQL child uses an independent connection before background work waiting for its parent', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { store } = await postgresStoreFixture(t, 'domain_child');
  const order = [];
  let background;
  await store.run(async parent => {
    await parent.insert('ApiKeys', apiKey('parent-committed'));
    background = store.enqueue(async db => {
      order.push('background');
      await db.insert('ApiKeys', apiKey('background'));
    });
    await bounded(store.runChild(async child => {
      order.push('child');
      assert.notEqual(child.client, parent.client);
      assert.equal(await store.run(db => db.client), child.client);
      assert.deepEqual((await child.rows('ApiKeys')).map(row => row.Name), ['parent-committed']);
      await store.transaction(db => db.insert('ApiKeys', apiKey('child-committed')));
      assert.deepEqual(order, ['child']);
    }), 5000);
    order.push('parent-finished');
  });
  await bounded(background, 5000);
  assert.deepEqual(order, ['child', 'parent-finished', 'background']);
  assert.deepEqual((await store.run(db => db.rows('ApiKeys'))).map(row => row.Name).sort(),
    ['background', 'child-committed', 'parent-committed']);
});

test('an aborted enqueue never runs and a failed background operation leaves the connection queue usable', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { store } = await postgresStoreFixture(t, 'domain_abort');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(store.enqueue(() => { calls++; }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(store.enqueue(() => { throw new Error('Background failure'); }), /Background failure/);
  await store.enqueue(db => db.insert('ApiKeys', apiKey('after-background-failure')));
  assert.equal(calls, 0);
  assert.deepEqual((await store.run(db => db.rows('ApiKeys'))).map(row => row.Name), ['after-background-failure']);
});

test('a waiting PostgreSQL domain transaction aborts promptly without running its callback', {
  skip: !postgresTestConnectionString,
}, async t => {
  const { store } = await postgresStoreFixture(t, 'domain_wait_abort');
  let startFirst;
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = store.transaction(async () => {
    startFirst();
    await firstGate;
  });
  await firstStarted;

  const controller = new AbortController();
  let callbackCalls = 0;
  const queued = store.transaction(async () => { callbackCalls += 1; }, { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort();
  await bounded(rejected);
  assert.equal(callbackCalls, 0);

  releaseFirst();
  await first;
  await store.run(() => undefined);
  assert.equal(callbackCalls, 0);
});

class MockPostgresClient {
  constructor(pool, id) {
    this.pool = pool;
    this.id = id;
    this.queries = [];
    this.released = false;
  }

  async query(query, values) {
    const text = typeof query === 'string' ? query : query.text;
    this.queries.push({ text, values });
    if (text === 'SELECT fail') throw new Error('mock query failure');
    if (text === 'ROLLBACK' && this.failRollback) throw new Error('mock rollback failure');
    if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (text.startsWith('SELECT pg_advisory_unlock')) {
      return { rows: [{ unlocked: !this.failUnlock }], rowCount: 1 };
    }
    return { rows: text === 'SELECT id' ? [{ id: this.id }] : [], rowCount: 0 };
  }

  release(error) {
    assert.equal(this.released, false, 'a pooled client is released once');
    this.released = true;
    this.releaseError = error;
    this.pool.active -= 1;
  }
}

class MockPostgresPool {
  constructor() {
    this.options = { host: 'mock-host', port: 5432 };
    this.clients = [];
    this.active = 0;
    this.ended = false;
  }

  async connect() {
    assert.equal(this.ended, false, 'a closed pool cannot issue a client');
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error('mock connect failure');
    }
    const client = new MockPostgresClient(this, this.clients.length + 1);
    this.clients.push(client);
    this.active += 1;
    return client;
  }

  async end() {
    assert.equal(this.active, 0, 'DomainStore drains checked-out clients before ending the pool');
    this.ended = true;
  }
}

test('domain child admission rejects external callers and parents holding transactions or writer locks', async () => {
  const pool = new MockPostgresPool();
  const store = new DomainStore(new PostgresDatabase(pool, 'child_admission_fixture'));
  let calls = 0;
  const rejected = () => assert.rejects(store.runChild(() => { calls++; }), /active operation outside a transaction or writer lock/);
  await rejected(); assert.equal(pool.clients.length, 0);
  await store.transaction(rejected);
  await store.serializeWrites(rejected);
  assert.equal(pool.clients.length, 2); assert.equal(pool.active, 0); assert.equal(calls, 0);
  await store.close(); await rejected();
  assert.equal(pool.ended, true);
});

test('domain shutdown drains an admitted child after its parent returns and freezes external admission', async () => {
  const pool = new MockPostgresPool();
  const store = new DomainStore(new PostgresDatabase(pool, 'child_close_fixture'));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let child, closing, drained = false;
  try {
    await store.run(async () => {
      child = store.runChild(async db => {
        entered.resolve(); await release.promise;
        assert.equal(await store.run(nested => nested.client), db.client);
        await db.client.query('SELECT id');
      });
      await bounded(entered.promise);
    });
    closing = store.close().then(() => { drained = true; });
    assert.equal(drained, false); assert.equal(pool.active, 1); assert.equal(pool.ended, false);
    await assert.rejects(store.run(() => assert.fail('External admission after close.')), /Database store is closing/);
    release.resolve(); await bounded(child); await bounded(closing);
    assert.equal(drained, true); assert.equal(pool.active, 0); assert.equal(pool.ended, true);
  } finally { release.resolve(); await Promise.allSettled([child, closing]); await store.close(); }
});

test('PostgreSQL domain operations overlap, pin one configured connection and reuse it when reentrant', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'pool_fixture');
  const store = new DomainStore(database);
  let arrivals = 0;
  let release;
  const bothArrived = new Promise(resolve => { release = resolve; });
  const operation = store.run(async session => {
    const client = session.client;
    arrivals += 1;
    if (arrivals === 2) release();
    await bounded(bothArrived);
    assert.equal(await store.run(nested => nested.client), client);
    await client.query('SELECT id');
    return client.id;
  });
  const second = store.run(async session => {
    const client = session.client;
    arrivals += 1;
    if (arrivals === 2) release();
    await bounded(bothArrived);
    assert.equal(await store.run(nested => nested.client), client);
    await client.query('SELECT id');
    return client.id;
  });

  assert.deepEqual(await bounded(Promise.all([operation, second])), [1, 2]);
  assert.equal(pool.active, 0);
  assert.equal(pool.clients.length, 2);
  for (const client of pool.clients) {
    assert.match(client.queries[0].text, /^SET search_path TO "pool_fixture", pg_catalog$/);
    assert.equal(client.released, true);
  }
  await store.close();
  assert.equal(pool.ended, true);
});

test('PostgreSQL background enqueue starts after its originating request releases the connection', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'background_fixture');
  const store = new DomainStore(database);
  const order = [];
  let background;

  await store.run(async session => {
    order.push(`request-${session.client.id}`);
    background = store.enqueue(async queued => {
      order.push(`background-${queued.client.id}`);
    });
    await setTimeout(0);
    assert.deepEqual(order, ['request-1']);
  });
  const following = store.run(async session => { order.push(`following-${session.client.id}`); });
  await Promise.all([background, following]);

  assert.deepEqual(order, ['request-1', 'background-2', 'following-3']);
  assert.equal(pool.active, 0);
  await store.close();
});

test('PostgreSQL close drains the accepted serial background queue and rejects later external work', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'background_close_fixture');
  const store = new DomainStore(database);
  const order = [];
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = store.enqueue(async session => {
    order.push(`first-start-${session.client.id}`);
    firstStarted();
    await gate;
    order.push(`first-end-${session.client.id}`);
  });
  const second = store.enqueue(async session => {
    order.push(`second-${session.client.id}`);
  });

  await bounded(started);
  const closing = store.close();
  await setTimeout(0);
  assert.equal(pool.ended, false);
  assert.deepEqual(order, ['first-start-1']);
  await assert.rejects(store.run(() => undefined), /Database store is closing/);
  await assert.rejects(store.enqueue(() => undefined), /Database store is closing/);

  releaseFirst();
  await bounded(Promise.all([first, second, closing]));
  assert.deepEqual(order, ['first-start-1', 'first-end-1', 'second-2']);
  assert.equal(pool.ended, true);
});

test('PostgreSQL close waits for background work accepted late by an active operation', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'late_background_close_fixture');
  const store = new DomainStore(database);
  const order = [];
  let operationStarted;
  const started = new Promise(resolve => { operationStarted = resolve; });
  let allowEnqueue;
  const enqueueGate = new Promise(resolve => { allowEnqueue = resolve; });
  let background;
  const active = store.run(async session => {
    order.push(`active-${session.client.id}`);
    operationStarted();
    await enqueueGate;
    background = store.enqueue(async queued => {
      order.push(`background-${queued.client.id}`);
    });
    order.push('background-accepted');
  });

  await bounded(started);
  const closing = store.close();
  allowEnqueue();
  await bounded(active);
  await bounded(closing);
  await bounded(background);

  assert.deepEqual(order, ['active-1', 'background-accepted', 'background-2']);
  assert.equal(pool.ended, true);
});

test('PostgreSQL transactions stay on one client, roll back, reject nesting and return the connection', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'transaction_fixture');
  const store = new DomainStore(database);

  await assert.rejects(store.transaction(async session => {
    const client = session.client;
    assert.equal(await store.run(nested => nested.client), client);
    await assert.rejects(store.transaction(() => undefined), /Nested domain transactions/);
    await client.query('SELECT fail');
  }), /mock query failure/);

  assert.equal(pool.active, 0);
  assert.deepEqual(pool.clients[0].queries.map(query => query.text), [
    'SET search_path TO "transaction_fixture", pg_catalog',
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    'SELECT fail',
    'ROLLBACK',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
  ]);
  assert.equal(await store.run(session => session.client.id), 2, 'a failure does not strand the pool lease');
  await store.close();
});

test('PostgreSQL serialized writes keep multiple native save phases under one writer lock', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'serialized_write_fixture');
  const store = new DomainStore(database);

  await store.serializeWrites(async session => {
    await session.client.query('DELETE phase');
    await store.transaction(async transaction => {
      assert.equal(transaction.client, session.client);
      await transaction.client.query('INSERT phase');
    });
  });

  assert.deepEqual(pool.clients[0].queries.map(query => query.text), [
    'SET search_path TO "serialized_write_fixture", pg_catalog',
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    'DELETE phase',
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    'INSERT phase',
    'COMMIT',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
  ]);
  assert.equal(pool.clients[0].released, true);
  await store.close();
});

test('PostgreSQL discards a pooled connection when its session writer lock cannot be released', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'unlock_failure_fixture');
  const store = new DomainStore(database);

  await assert.rejects(store.transaction(session => {
    session.client.physicalClient.failUnlock = true;
  }), /write lock was not held/);
  assert.match(pool.clients[0].releaseError?.message ?? '', /write lock was not held/);
  assert.equal(await store.run(session => session.client.id), 2,
    'the connection with unknown advisory-lock state must never return to the pool');
  await store.close();
});

test('PostgreSQL root database hooks re-enter the active transaction session', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'root_hook_fixture');
  const store = new DomainStore(database);
  const failure = new Error('injected root update failure');
  const update = database.update.bind(database);
  database.update = async (...args) => {
    const result = await update(...args);
    throw failure;
  };

  await assert.rejects(store.transaction(session => session.update('ApiKeys', { Id: 1 }, {
    Name: 'rolled-back'
  })), failure);

  assert.equal(pool.clients.length, 1, 'the root hook must not check out a second connection');
  assert.deepEqual(pool.clients[0].queries.map(query => query.text), [
    'SET search_path TO "root_hook_fixture", pg_catalog',
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    'UPDATE "ApiKeys" SET "Name" = $1 WHERE "Id" = $2',
    'ROLLBACK',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
  ]);
  assert.equal(pool.active, 0);
  await store.close();
});

test('PostgreSQL root client query hooks observe pooled sessions without changing their connection', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'query_hook_fixture');
  const store = new DomainStore(database);
  const query = database.client.query.bind(database.client);
  const observed = [];
  database.client.query = async (...args) => {
    observed.push(typeof args[0] === 'string' ? args[0] : args[0].text);
    return query(...args);
  };

  const id = await store.transaction(async session => {
    assert.equal((await session.client.query('SELECT id')).rows[0].id, session.client.id);
    return session.client.id;
  });

  assert.equal(id, 1);
  assert.equal(pool.clients.length, 1, 'the hook must re-enter the already pinned operation session');
  assert.deepEqual(observed, [
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    'SELECT id',
    'COMMIT',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
  ]);
  database.client.query = query;
  assert.equal((await store.run(session => session.client.query('SELECT id'))).rows[0].id, 2,
    'restoring a bound public query dispatcher must remain recursion-safe');
  await store.close();
});

test('the PostgreSQL root client facade rejects transaction control without checking out a connection', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'root_transaction_control_fixture');
  for (const statement of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'END', 'ROLLBACK',
    'SELECT 1; COMMIT', 'SELECT \'COMMIT\'; /* ordinary text */ ROLLBACK',
    String.raw`SELECT '\'; COMMIT; --'`,
    'SELECT 1 AS x$tag$; COMMIT; --$tag$']) {
    await assert.rejects(database.client.query(statement), /transaction control requires database\.transaction\(\)/u);
  }
  assert.equal(pool.clients.length, 0);
  await database.client.query(`SELECT CASE WHEN true THEN 'END' ELSE 'COMMIT' END AS value,
    'ROLLBACK' AS literal /* BEGIN */, $$SAVEPOINT hidden$$ AS body, id`);
  assert.equal(pool.clients.length, 1);
  assert.equal(pool.clients[0].released, true);
  await database.close();
});

test('PostgreSQL database transactions pin one connection and store close drains the active operation', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'transaction_close_fixture');
  const store = new DomainStore(database);
  let operationStarted;
  const started = new Promise(resolve => { operationStarted = resolve; });
  let finishOperation;
  const gate = new Promise(resolve => { finishOperation = resolve; });
  let pinnedClient;
  const operation = store.transaction(async session => {
    pinnedClient = session.client;
    assert.equal((await session.client.query('SELECT id')).rows[0].id, pinnedClient.id);
    operationStarted();
    await gate;
    assert.equal((await database.client.query('SELECT id')).rows[0].id, pinnedClient.id,
      'root queries inside the callback re-enter the pinned transaction session');
  });
  await started;
  const closing = store.close();
  await setTimeout(0);
  assert.equal(pool.ended, false);
  finishOperation();
  await operation;
  await closing;
  assert.equal(pool.clients.length, 1);
  assert.equal(pool.clients[0], pinnedClient.physicalClient);
  assert.equal(pool.clients[0].released, true);
  assert.equal(pool.ended, true);
});

test('a failed PostgreSQL transaction checkout does not poison a later transaction', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'checkout_failure_fixture');
  pool.failNextConnect = true;
  let callbackCalls = 0;
  await assert.rejects(database.transaction(() => { callbackCalls += 1; }), /mock connect failure/);
  assert.equal(callbackCalls, 0);
  const id = await database.transaction(async session => {
    callbackCalls += 1;
    return (await session.client.query('SELECT id')).rows[0].id;
  });
  assert.equal(id, 1);
  assert.equal(callbackCalls, 1);
  assert.equal(pool.active, 0);
  await database.close();
  assert.equal(pool.ended, true);
});

test('real PostgreSQL discards a connection when rollback fails without leaking its writes', {
  skip: !postgresTestConnectionString,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'rollback_failed', { max: 1 });
  await assert.rejects(database.transaction(async session => {
    await session.insert('ApiKeys', apiKey('must-not-leak'));
    const query = session.client.query.bind(session.client);
    session.client.query = (statement, ...args) => {
      if (statement === 'ROLLBACK') throw new Error('injected rollback failure');
      return query(statement, ...args);
    };
    throw new Error('injected operation failure');
  }), error => error instanceof AggregateError
    && error.errors.some(cause => cause.message === 'injected rollback failure'));
  await database.transaction(session => session.insert('ApiKeys', apiKey('subsequent-write')));
  assert.deepEqual((await database.rows('ApiKeys')).map(row => row.Name), ['subsequent-write'],
    'a later transaction must never commit writes left on a failed transaction connection');
});

test('the PostgreSQL client facade preserves the closed-client error', async () => {
  const pool = new MockPostgresPool();
  const database = new PostgresDatabase(pool, 'closed_fixture');
  await database.close();
  await assert.rejects(database.client.query('SELECT 1'), {
    message: 'Client was closed and is not queryable'
  });
  await assert.rejects(database.withConnection(() => undefined), {
    message: 'Client was closed and is not queryable'
  });
});

test('real PostgreSQL pooled operations overlap, roll back and return connections', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const schema = `pool_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
    max: 2,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 2_000
  });
  const store = new DomainStore(database);
  t.after(async () => {
    if (database.closed) return;
    try { await database.client.query(`DROP SCHEMA "${schema}", "${schema}__mm" CASCADE`); }
    finally { await store.close(); }
  });

  let arrivals = 0;
  let release;
  const bothArrived = new Promise(resolve => { release = resolve; });
  const overlap = () => store.run(async session => {
    const pid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    arrivals += 1;
    if (arrivals === 2) release();
    await bounded(bothArrived, 2_000);
    return pid;
  });
  const pids = await bounded(Promise.all([overlap(), overlap()]), 4_000);
  assert.notEqual(pids[0], pids[1]);

  await assert.rejects(store.transaction(async session => {
    await session.insert('ApiKeys', apiKey('real-rollback'));
    throw new Error('real rollback');
  }), /real rollback/);
  assert.deepEqual(await store.run(session => session.rows('ApiKeys', {
    where: { AccessToken: 'real-rollback' }
  })), []);
  assert.equal((await store.run(session => session.client.query('SELECT 1 AS value'))).rows[0].value, 1);
  assert.equal(database.pool.waitingCount, 0);
});

test('real PostgreSQL table-lock retries honor their total timeout', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const schema = `table_lock_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
    max: 2,
  });
  const blocker = await database.pool.connect();
  t.after(async () => {
    try { await blocker.query('ROLLBACK'); }
    finally {
      blocker.release();
      if (!database.closed) {
        try { await database.client.query(`DROP SCHEMA "${schema}", "${schema}__mm" CASCADE`); }
        finally { await database.close(); }
      }
    }
  });

  await blocker.query('BEGIN');
  await blocker.query(`LOCK TABLE "${schema}"."BaseItems" IN ACCESS EXCLUSIVE MODE`);
  const startedAt = Date.now();
  await assert.rejects(database.transaction(() => {
    assert.fail('transaction callback must not run without its requested table lock');
  }, {
    writeLockTables: ['BaseItems'],
    lockRetryMs: 10,
    lockTimeoutMs: 100,
  }), error => error?.code === '55P03' && /table lock timeout/u.test(error.message));
  assert.ok(Date.now() - startedAt < 1_000, 'the total table-lock wait must remain bounded');
  assert.equal(database.inTransaction, false);
  assert.equal(database.pool.waitingCount, 0);
});

test('real PostgreSQL domain writes serialize across stores without losing a read-modify-write update', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const schema = `domain_write_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const firstDatabase = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
    max: 4,
  });
  const secondDatabase = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    max: 4,
  });
  const first = new DomainStore(firstDatabase);
  const second = new DomainStore(secondDatabase);
  t.after(async () => {
    try {
      if (!firstDatabase.closed) await firstDatabase.client.query(`DROP SCHEMA "${schema}", "${schema}__mm" CASCADE`);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });

  const table = name => nativeModel.tables.find(entry => entry.name === name);
  const item = fixtureRow(table('BaseItems'));
  const user = fixtureRow(table('Users'));
  await firstDatabase.insert('BaseItems', item);
  await firstDatabase.insert('Users', user);
  const keys = { ItemId: item.Id, UserId: user.Id, CustomDataKey: item.Id };
  const seed = { ...fixtureRow(table('UserData')), ...keys, PlayCount: 0 };

  const increment = store => store.transaction(async database => {
    const current = (await database.rows('UserData', { where: keys, limit: 1 }))[0];
    if (current) await database.update('UserData', keys, { PlayCount: current.PlayCount + 1 });
    else await database.insert('UserData', { ...seed, PlayCount: 1 });
  });
  await Promise.all(Array.from({ length: 24 }, (_, index) => increment(index % 2 ? first : second)));
  assert.equal((await firstDatabase.rows('UserData', { where: keys, limit: 1 }))[0].PlayCount, 24);

  let releaseFirst, releaseSecond;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let firstEntered, secondEntered;
  const firstStarted = new Promise(resolve => { firstEntered = resolve; });
  const secondStarted = new Promise(resolve => { secondEntered = resolve; });
  let firstPid;
  let secondCallbackEntered = false;
  const heldWriter = first.serializeWrites(async session => {
    firstPid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await first.transaction(database => database.insert('ApiKeys', apiKey('serialized-visible')));
    firstEntered();
    await firstGate;
  });
  await bounded(firstStarted, 2_000);
  const waitingWriter = second.serializeWrites(async session => {
    secondCallbackEntered = true;
    secondEntered();
    const visible = await session.rows('ApiKeys', { where: { AccessToken: 'serialized-visible' } });
    await secondGate;
    return visible.length;
  });
  try {
    const concurrentRead = await bounded(second.run(async session => ({
      pid: (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      visible: (await session.rows('ApiKeys', { where: { AccessToken: 'serialized-visible' } })).length,
    }), { readOnly: true }), 2_000);
    assert.equal(concurrentRead.visible, 1, 'a read-only run observes committed data while the writer boundary remains held');
    assert.notEqual(concurrentRead.pid, firstPid, 'the read-only run remains concurrent on another pooled session');
    assert.equal(secondCallbackEntered, false, 'a second store cannot enter its writer callback before the first releases');
    releaseFirst();
    await bounded(firstStarted.then(() => secondStarted), 2_000);
    releaseSecond();
    assert.equal(await bounded(waitingWriter, 2_000), 1,
      'the waiting writer starts with a snapshot newer than the preceding committed write');
    await bounded(heldWriter, 2_000);
  } finally {
    releaseFirst();
    releaseSecond();
    await Promise.allSettled([heldWriter, waitingWriter]);
  }
});

test('a discarded operation session cannot begin another transaction', { skip: !postgresTestConnectionString }, async t => {
  const database = await createPostgresTestDatabase(t, 'retained_failed', { max: 1 });
  await database.withConnection(async session => {
    const query = session.client.query.bind(session.client);
    await assert.rejects(session.transaction(async transaction => {
      await transaction.insert('ApiKeys', apiKey('must-not-leak'));
      session.client.query = (statement, ...args) => {
        if (statement === 'ROLLBACK') throw new Error('injected rollback failure');
        return query(statement, ...args);
      };
      throw new Error('injected operation failure');
    }), AggregateError);
    session.client.query = query;
    await assert.rejects(session.transaction(transaction => transaction.insert('ApiKeys', apiKey('must-not-run'))), /discarded/u);
  });
  assert.deepEqual(await database.rows('ApiKeys'), []);
});
