import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from './postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const apiKey = name => ({ Name: name, AccessToken: name, DateCreated: '2026-11-11 12:00:00', DateLastActivity: '2026-11-11 12:00:00' });
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const publicFields = { code: 'OPERATION_FAILURE', status: 409, statusCode: 503 };
const publicError = () => Object.assign(new Error('Primary operation failure'), publicFields);
const reasonCases = [
  { name: 'public', create: publicError },
  ...['message', 'code', 'status', 'statusCode'].map(property => ({ name: `getter-${property}`, property, create() {
    const value = publicError();
    Object.defineProperty(value, property, { get() { throw new Error(`Diagnostic ${property} access failed`); } });
    return value;
  } })),
  ...falsy.map(([name, reason]) => ({ name, create: () => reason })),
  { name: 'postgres', postgres: true },
];

// Deliberately hostile diagnostics must not make the evidence writer call the
// same getters that the operation boundary is required to tolerate.
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    result[key] = !Object.hasOwn(descriptor, 'value') ? { accessor: true }
      : key === 'errors' ? descriptor.value.map(observation)
        : key === 'cause' ? observation(descriptor.value) : descriptor.value;
  }
  return result;
}

test('real PostgreSQL transaction and writer boundaries retain primary metadata, falsy reasons and committed prefixes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'postgres-operation-failure-'));
  const database = await createPostgresTestDatabase(null, 'operation_error', { max: 2 });
  const store = new DomainStore(database);
  t.after(async () => { await store.close(); await dropPostgresTestDatabase(database); });
  const publicReason = reasonCases[0];
  const cases = [
    ...['rollback', 'unlock'].flatMap(phase => reasonCases.map(reason => ({ name: `${phase}-${reason.name}`, phase, reason }))),
    ...['rollback', 'unlock'].flatMap(phase => falsy.map(([name, reason]) => ({ name: `${phase}-cleanup-${name}`, phase,
      reason: publicReason, cleanupReason: { reason } }))),
    ...reasonCases.filter(reason => reason.name === 'public' || reason.name === 'getter-message' || falsy.some(([name]) => name === reason.name))
      .map(reason => ({ name: `commit-reply-${reason.name}`, phase: 'commit-reply', reason })),
    { name: 'committed-unlock-postgres', phase: 'unlock', success: true },
    ...falsy.map(([name, reason]) => ({ name: `committed-unlock-${name}`, phase: 'unlock', success: true, cleanupReason: { reason } })),
    ...reasonCases.filter(reason => ['public', 'getter-message', 'null'].includes(reason.name))
      .map(reason => ({ name: `autocommit-unlock-${reason.name}`, phase: 'unlock', autocommit: true, reason })),
  ];
  for (const [index, sample] of cases.entries()) await t.test(sample.name, async () => {
    const prefix = `operation-prefix-${index}`, pending = `operation-pending-${index}`, recovery = `operation-recovery-${index}`;
    const temporary = `operation_owner_${index}`;
    await database.insert('ApiKeys', apiKey(prefix));
    let primary = sample.reason?.create?.(), cleanupFailure, observed, backendPid;
    let bodyCalls = 0, rollbackAttempts = 0, rollbacks = 0, commits = 0, unlocks = 0;
    const run = sample.phase === 'rollback' ? database.withConnection.bind(database) : store.run.bind(store);
    const operation = run(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const unlocking = sql.startsWith('SELECT pg_advisory_unlock(');
        if (sql === 'ROLLBACK') {
          rollbackAttempts++;
          if (sample.phase === 'rollback') {
            try {
              if (sample.cleanupReason) {
                await query(statement, ...args); rollbacks++;
                throw sample.cleanupReason.reason;
              }
              // This is an actual rejected PostgreSQL rollback command. The
              // owning disconnect must roll back the still-open transaction.
              return await query('ROLLBACK TO SAVEPOINT missing_operation_boundary');
            } catch (error) { cleanupFailure = error; throw error; }
          }
        }
        let value;
        try { value = await query(statement, ...args); }
        catch (error) { if (unlocking) cleanupFailure = error; throw error; }
        if (sql === 'ROLLBACK') rollbacks++;
        if (sql === 'COMMIT') {
          commits++;
          if (sample.phase === 'commit-reply') throw primary;
        }
        if (unlocking) {
          unlocks++;
          try {
            if (sample.cleanupReason) throw sample.cleanupReason.reason;
            return await query('SELECT 1 / 0 AS failed_unlock_response');
          } catch (error) { cleanupFailure = error; throw error; }
        }
        return value;
      };
      const body = async db => {
        bodyCalls++;
        await db.client.query(`CREATE TEMP TABLE "${temporary}" (value integer)`);
        await db.insert('ApiKeys', apiKey(pending));
        if (sample.reason?.postgres) {
          try { await db.client.query('SELECT absent_operation_column'); }
          catch (error) { primary = Object.assign(error, { status: 409, statusCode: 503 }); }
        }
        if (sample.phase !== 'commit-reply' && !sample.success) throw primary;
        return 'committed';
      };
      try {
        return await (sample.phase === 'rollback' ? session.transaction(body)
          : sample.autocommit ? store.serializeWrites(() => body(session)) : store.transaction(body));
      } finally { session.client.query = query; }
    });
    await assert.rejects(operation, error => { observed = error; return true; });
    assert.equal(bodyCalls, 1, 'The business callback is never replayed after a failed completion boundary.');
    if (sample.success) assert.equal(observed, cleanupFailure);
    else {
      assert.deepEqual(observed.errors, [primary, cleanupFailure]); assert.equal(observed.cause, primary);
      const properties = sample.reason?.postgres ? { ...publicFields, code: '42703' } : publicFields;
      if (sample.reason?.postgres || !falsy.some(([name]) => name === sample.reason?.name)) {
        for (const [key, value] of Object.entries(properties)) {
          if (sample.reason?.property === key) assert.equal(Object.hasOwn(observed, key), false);
          else assert.equal(observed[key], value);
        }
      }
      if (sample.reason?.property === 'message') assert.equal(observed.message,
        sample.phase === 'rollback' ? 'PostgreSQL transaction and rollback failed.' : 'PostgreSQL write and lock release failed.');
    }
    if (sample.phase === 'rollback') {
      assert.equal(rollbackAttempts, 1); assert.equal(rollbacks, sample.cleanupReason ? 1 : 0);
      if (sample.cleanupReason) assert.equal(cleanupFailure, sample.cleanupReason.reason);
      else assert.equal(cleanupFailure.code, '3B001');
    } else if (sample.phase === 'commit-reply') {
      assert.equal(commits, 1); assert.equal(rollbackAttempts, 0); assert.equal(unlocks, 0);
      assert.match(cleanupFailure.message, /connection was discarded/u);
    } else {
      assert.equal(unlocks, 1);
      assert.equal(rollbackAttempts, sample.success || sample.autocommit ? 0 : 1);
      if (sample.cleanupReason) assert.equal(cleanupFailure, sample.cleanupReason.reason);
      else assert.equal(cleanupFailure.code, '22012');
    }
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_locks WHERE pid=$1', [backendPid])).rows[0].count), 0);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [temporary])).rows[0].count), 0);
    assert.equal((await database.rows('ApiKeys', { where: { Name: prefix } })).length, 1);
    const committed = sample.success || sample.autocommit || sample.phase === 'commit-reply';
    assert.equal((await database.rows('ApiKeys', { where: { Name: pending } })).length, committed ? 1 : 0,
      'Connection disposal preserves the actual PostgreSQL commit or rollback prefix.');
    let recoveryPid;
    await store.transaction(async db => {
      recoveryPid = (await db.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.insert('ApiKeys', apiKey(recovery));
    });
    assert.notEqual(recoveryPid, backendPid);
    assert.equal((await database.rows('ApiKeys', { where: { Name: recovery } })).length, 1);
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name, failure: observation(observed),
      bodyCalls, rollbackAttempts, rollbacks, commits, unlocks, committed, backendPid, recoveryPid,
      backendEnded: true, temporaryRemoved: true, prefixPreserved: true }, null, 2) + '\n');
  });
});

test('actual PostgreSQL lock handling preserves hostile diagnostics and retries only the real unavailable-lock code', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'postgres-lock-operation-failure-'));
  const locked = Promise.withResolvers(), release = Promise.withResolvers();
  let database, holding, transaction, lockFailure, retryAttempts = 0;
  t.after(async () => {
    release.resolve(); await Promise.allSettled([holding, transaction]); await dropPostgresTestDatabase(database);
  });
  database = await createPostgresTestDatabase(null, 'operation_lock', { max: 3 });
  const reason = reasonCases.find(reason => reason.name === 'getter-code').create();
  let attempts = 0, callbacks = 0, failed = false;
  await assert.rejects(database.withConnection(async session => {
    const query = session.client.query.bind(session.client);
    session.client.query = async (statement, ...args) => {
      const value = await query(statement, ...args);
      if (typeof statement === 'string' && statement.startsWith('LOCK TABLE ')) { attempts++; throw reason; }
      return value;
    };
    try { return await session.transaction(() => { callbacks++; }, { writeLockTables: ['ApiKeys'], lockTimeoutMs: 1000 }); }
    finally { session.client.query = query; }
  }), error => { failed = error === reason; return failed; });
  assert.equal(failed, true); assert.equal(attempts, 1); assert.equal(callbacks, 0);

  holding = database.withConnection(session => session.transaction(async db => {
    await db.client.query('LOCK TABLE "ApiKeys" IN EXCLUSIVE MODE'); locked.resolve(); await release.promise;
  }));
  await Promise.race([locked.promise, holding.then(() => { throw new Error('The lock holder ended before acquiring its table lock.'); })]);
  transaction = database.withConnection(async session => {
    const query = session.client.query.bind(session.client);
    session.client.query = async (statement, ...args) => {
      const locking = typeof statement === 'string' && statement.startsWith('LOCK TABLE ');
      if (locking) retryAttempts++;
      try { return await query(statement, ...args); }
      catch (error) { if (locking) { lockFailure = error; release.resolve(); await holding; } throw error; }
    };
    try { return await session.transaction(async db => {
      callbacks++; await db.insert('ApiKeys', apiKey('committed-after-real-lock-retry'));
    }, { writeLockTables: ['ApiKeys'], lockTimeoutMs: 5000, lockRetryMs: 1 }); }
    finally { session.client.query = query; }
  });
  await transaction; await holding;
  assert.equal(lockFailure.code, '55P03'); assert.equal(retryAttempts, 2); assert.equal(callbacks, 1);
  assert.equal((await database.rows('ApiKeys', { where: { Name: 'committed-after-real-lock-retry' } })).length, 1);
  await fs.writeFile(path.join(root, 'lock-boundaries.json'), JSON.stringify({ hostileReason: observation(reason),
    attempts, callbacks, lockFailure: observation(lockFailure), retryAttempts, committed: true }, null, 2) + '\n');
});
