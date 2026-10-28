import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ActivityLogManager } from '../../src/activity/manager.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createCoreLocalization } from '../../src/core/i18n.js';
import { UserService } from '../../src/users/user-service.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { SessionService } from '../../src/sessions/service.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !postgresTestConnectionString, timeout: 60000 };
const serverId = '123456781234123412341234567890ab';
const zeroUser = '00000000-0000-0000-0000-000000000000';
const userId = 'abcdefff-1111-2222-3333-444444444444';
const controlledState = 'P7501';
const errorRecord = error => error === null || typeof error !== 'object' ? error : {
  name: error.name, message: error.message, code: error.code, detail: error.detail,
  schema: error.schema, table: error.table, cause: error.cause === undefined ? undefined : errorRecord(error.cause),
};

/** Real Node PG owners only. No Native, HTTP host or event source is replaced. */
async function fixture(t, prefix, { onError } = {}) {
  const report = { scope: 'node-activity-postgres-owner', startedAt: new Date().toISOString(),
    fixedClocks: [], sql: [], observations: [], cleanup: [] };
  const database = await createPostgresTestDatabase(null, prefix, { max: 4 });
  const store = new DomainStore(database), managers = [], observers = [], sessions = [], reads = [];
  report.schema = database.schemaName;
  let instant = '2026-10-20T12:34:56.789Z'; report.fixedClocks.push(instant);
  const clock = () => new Date(instant);
  t.after(async () => {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    for (const owner of sessions) await attempt(() => owner.close());
    for (const manager of managers) await attempt(() => manager.close());
    for (const result of await Promise.allSettled(reads)) if (result.status === 'rejected') errors.push(result.reason);
    for (const observer of observers) await attempt(async () => { await observer.close(); report.cleanup.push({ observerClosed: true }); });
    await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.push({ schemasRemoved: true }); });
    await attempt(async () => { await store.close(); report.cleanup.push({ storeClosed: true }); });
    report.completedAt = new Date().toISOString(); report.cleanupErrors = errors.map(errorRecord);
    t.diagnostic(JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    if (errors.length) throw new AggregateError(errors, 'Activity PG fixture cleanup failed.', { cause: errors[0] });
  });
  const localization = await createCoreLocalization({ serverCulture: 'en-US' });
  const manager = new ActivityLogManager({ store, localization, clock, onError }); managers.push(manager);
  const observer = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName, max: 1 });
  observers.push(observer);
  const sql = async (client, text, values = []) => {
    report.sql.push({ text, values });
    return await client.query(text, values);
  };
  return { database, store, manager, observer, report, sql, clock,
    ownSessions(owner) { sessions.push(owner); return owner; },
    observe(promise) { reads.push(promise); void promise.catch(() => {}); return promise; },
    setClock(value) { instant = value; report.fixedClocks.push(value); },
  };
}

async function insertFailure(context) {
  const { database, sql } = context, schema = q(database.schemaName);
  const functionName = schema + '.activity_insert_failure';
  await sql(database.client, `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = '${controlledState}', MESSAGE = 'Controlled activity insert rejection',
      DETAIL = convert_from(NEW."Type", 'UTF8'); END $$`);
  try {
    await sql(database.client, `CREATE TRIGGER activity_insert_failure BEFORE INSERT ON ${schema}."ActivityLogs"
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  } catch (error) {
    await sql(database.client, `DROP FUNCTION ${functionName}()`); throw error;
  }
  return async () => {
    try { await sql(database.client, `DROP TRIGGER activity_insert_failure ON ${schema}."ActivityLogs"`); }
    finally { await sql(database.client, `DROP FUNCTION ${functionName}()`); }
  };
}

test('PG activity creation retains initial fields, generated identities and committed EntryCreated data', options, async t => {
  const context = await fixture(t, 'activity_create'), { manager, observer, report } = context;
  const events = [], committed = [];
  manager.on('EntryCreated', entry => {
    events.push({ ...entry });
    committed.push(context.observe(observer.rows('ActivityLogs', { where: { Id: entry.Id } })));
  });
  const first = await manager.create({ Name: 'Controlled creation', Type: 'Controlled.Created', UserId: userId });
  assert.ok(Number.isSafeInteger(first.Id) && first.Id > 0);
  assert.deepEqual(first, { Id: first.Id, Name: 'Controlled creation', Type: 'Controlled.Created', UserId: nativeGuid(userId),
    ItemId: null, Overview: null, ShortOverview: null, DateCreated: '2026-10-20 12:34:56.789', LogSeverity: 2, RowVersion: 0n });
  context.setClock('2026-10-20T12:34:57.000Z');
  const second = await manager.create({ Name: 'Explicit empty fields', Type: 'Controlled.Empty',
    ItemId: '', Overview: '', ShortOverview: '', LogSeverity: 0 });
  assert.ok(Number.isSafeInteger(second.Id) && second.Id > first.Id);
  assert.deepEqual(second, { Id: second.Id, Name: 'Explicit empty fields', Type: 'Controlled.Empty', UserId: zeroUser,
    ItemId: '', Overview: '', ShortOverview: '', DateCreated: '2026-10-20 12:34:57', LogSeverity: 0, RowVersion: 0n });
  assert.deepEqual(events, [first, second]);
  assert.deepEqual(await Promise.all(committed), [[first], [second]], 'Independent PG readers see the notified committed rows.');
  await manager.close();
  assert.deepEqual(await context.store.run(database => database.rows('ActivityLogs')), [first, second]);
  report.observations.push({ events, afterManagerClose: await observer.rows('ActivityLogs') });
});

test('a real PG activity insert failure propagates SQLSTATE and a later creation still commits', options, async t => {
  const context = await fixture(t, 'activity_failure'), { database, manager, observer, report } = context;
  const events = []; manager.on('EntryCreated', row => events.push({ ...row }));
  const removeFailure = await insertFailure(context);
  try {
    await assert.rejects(manager.create({ Name: 'Rejected write', Type: 'Controlled.Rejected' }), error => {
      report.observations.push({ insertFailure: errorRecord(error) });
      return error.code === controlledState && error.detail === 'Controlled.Rejected';
    });
    assert.deepEqual(await observer.rows('ActivityLogs', { where: { Type: 'Controlled.Rejected' } }), []);
    assert.equal(events.some(row => row.Type === 'Controlled.Rejected'), false, 'An uncommitted activity is not published.');
  } finally { await removeFailure(); }
  const restored = await manager.create({ Name: 'After restored SQL', Type: 'Controlled.Restored' });
  assert.ok(Number.isSafeInteger(restored.Id) && restored.Id > 0);
  assert.deepEqual(await observer.rows('ActivityLogs', { where: { Id: restored.Id } }), [restored]);
  assert.deepEqual(events, [restored]);
  assert.equal((await context.sql(database.client, 'SELECT 1 AS usable')).rows[0].usable, 1);
  report.observations.push({ restored });
});

test('user and authentication policies survive PG activity failure and failing error reporters', options, async t => {
  const diagnostics = []; let reporter = 'throw';
  const context = await fixture(t, 'activity_policy', { onError: error => {
    diagnostics.push(errorRecord(error));
    if (reporter === 'throw') throw new Error('Controlled synchronous diagnostic failure');
    return Promise.reject(new Error('Controlled asynchronous diagnostic failure'));
  } });
  const { manager, store, observer, clock, report } = context;
  const users = new UserService({ store, serverId, activities: manager, now: clock });
  const sessions = context.ownSessions(new SessionService({ store, users, serverId, clock, automaticProgress: false }));
  const authentication = new AuthenticationService({ store, users, sessions, activities: manager, serverId, now: clock });
  const removeFailure = await insertFailure(context);
  let created;
  try {
    created = await users.createUser({ Name: 'ActivityPolicyReader', Password: 'controlled activity password' });
    assert.equal(created.Name, 'ActivityPolicyReader');
    assert.equal(created.Policy.IsAdministrator, false);
    const persistedUser = await users.getUser(created.Id);
    assert.equal(persistedUser.Username, created.Name); assert.ok(persistedUser.Password);
    for (const type of ['UserCreated', 'UserPasswordChanged']) assert.ok(diagnostics.some(error => error.code === controlledState && error.detail === type),
      type + ' retains its actual PG failure while the user mutation succeeds.');
    reporter = 'reject';
    const client = { Client: 'Activity PG consumer', Device: 'Controlled device', DeviceId: 'activity-pg-device', Version: '1' };
    const network = { remoteEndPoint: '127.0.0.1' };
    await assert.rejects(authentication.login({ Username: created.Name, Pw: 'incorrect password' }, client, network), error => {
      report.observations.push({ failedAuthentication: errorRecord(error) }); return error.status === 401;
    });
    assert.equal((await users.getUser(created.Id)).InvalidLoginAttemptCount, 1);
    assert.ok(diagnostics.some(error => error.code === controlledState && error.detail === 'AuthenticationFailed'));
    const loggedIn = await authentication.login({ Username: created.Name, Pw: 'controlled activity password' }, client, network);
    assert.equal(loggedIn.User.Id, created.Id); assert.equal(loggedIn.SessionInfo.UserId, created.Id);
    const devices = await observer.rows('Devices', { where: { UserId: nativeGuid(created.Id) } });
    assert.ok(devices.some(device => device.AccessToken === loggedIn.AccessToken));
    assert.equal((await users.getUser(created.Id)).InvalidLoginAttemptCount, 0);
    assert.ok(diagnostics.some(error => error.code === controlledState && error.detail === 'AuthenticationSucceeded'));
    assert.deepEqual(await observer.rows('ActivityLogs'), [], 'Failed activity inserts do not fabricate successful log rows.');
    report.observations.push({ userId: created.Id, authenticatedUserId: loggedIn.User.Id,
      sessionUserId: loggedIn.SessionInfo.UserId, diagnosticFailures: diagnostics });
  } finally { await removeFailure(); }
  await manager.userEvent('UserCreated', await users.getUser(created.Id));
  const restored = await observer.rows('ActivityLogs', { where: { Type: 'UserCreated' } });
  assert.equal(restored.length, 1); assert.equal(restored[0].UserId, nativeGuid(created.Id));
  report.observations.push({ restoredActivity: restored });
});

test('an EntryCreated observer failure retains the PG commit and later consumers can read it', options, async t => {
  const context = await fixture(t, 'activity_observer'), { manager, observer, report } = context;
  const observerFailure = Object.assign(new Error('Controlled post-commit observer failure'), { code: 'activity-observer-failed' });
  const received = [];
  const failObserver = entry => { received.push({ ...entry }); throw observerFailure; };
  manager.on('EntryCreated', failObserver);
  await assert.rejects(manager.create({ Name: 'Committed before observer', Type: 'Controlled.Observer' }), error => {
    report.observations.push({ observerFailure: errorRecord(error) }); return error.code === 'activity-observer-failed';
  });
  const rows = await observer.rows('ActivityLogs', { where: { Type: 'Controlled.Observer' } });
  assert.equal(rows.length, 1); assert.deepEqual(received, rows);
  manager.off('EntryCreated', failObserver);
  const next = await manager.create({ Name: 'Observer recovered', Type: 'Controlled.AfterObserver' });
  assert.ok(next.Id > rows[0].Id);
  await manager.close();
  assert.deepEqual(await observer.rows('ActivityLogs'), [...rows, next]);
  report.observations.push({ committedDespiteObserverFailure: rows, next });
});

test('activity close rejects new writes and waits for a real PG lock and the committed event', options, async t => {
  const context = await fixture(t, 'activity_close'), { database, store, manager, observer, report, sql } = context;
  const blocker = await database.pool.connect(); let creating, closing, closingAgain;
  const events = [], committed = [];
  manager.on('EntryCreated', entry => {
    events.push({ ...entry }); committed.push(context.observe(observer.rows('ActivityLogs', { where: { Id: entry.Id } })));
  });
  try {
    await sql(blocker, 'BEGIN');
    await sql(blocker, `LOCK TABLE ${q(database.schemaName)}."ActivityLogs" IN SHARE MODE`);
    const blockerPid = (await sql(blocker, 'SELECT pg_backend_pid() AS pid')).rows[0].pid;
    creating = manager.create({ Name: 'Write held by the controlled table lock', Type: 'Controlled.Waiting' });
    void creating.catch(error => { report.observations.push({ admittedCreationFailure: errorRecord(error) }); });
    const waitSql = `SELECT waiting.pid, waiting.mode, pg_blocking_pids(waiting.pid) AS blockers, activity.query
      FROM pg_catalog.pg_locks waiting JOIN pg_catalog.pg_stat_activity activity ON activity.pid = waiting.pid
      WHERE waiting.locktype = 'relation' AND waiting.relation = $1::regclass AND NOT waiting.granted
        AND $2::integer = ANY(pg_blocking_pids(waiting.pid))`;
    const waitValues = [`${q(database.schemaName)}."ActivityLogs"`, blockerPid];
    report.sql.push({ text: waitSql, values: waitValues });
    let waiting;
    const deadline = performance.now() + 15000;
    while (!waiting) {
      t.signal.throwIfAborted();
      waiting = (await observer.client.query(waitSql, waitValues)).rows[0];
      if (waiting) break;
      assert.ok(performance.now() < deadline, 'The admitted activity must reach the independently held PG lock.');
      await delay(20, undefined, { signal: t.signal });
    }
    report.observations.push({ blockingTransaction: { blockerPid, waiting, observedAt: new Date().toISOString() } });
    let closed = false, closedAgain = false;
    closing = manager.close(); void closing.then(() => { closed = true; }, error => {
      report.observations.push({ managerCloseFailure: errorRecord(error) });
    });
    closingAgain = manager.close();
    void closingAgain.then(() => { closedAgain = true; }, error => {
      report.observations.push({ repeatedManagerCloseFailure: errorRecord(error) });
    });
    await assert.rejects(manager.create({ Name: 'Rejected after close began', Type: 'Controlled.Late' }), { code: 'closed', status: 503 });
    assert.deepEqual(await observer.rows('ActivityLogs', { where: { Type: 'Controlled.Waiting' } }), []);
    assert.equal(events.some(row => row.Type === 'Controlled.Waiting'), false);
    assert.equal(closed, false, 'Close stays pending while the actual insert waits on the external transaction.');
    assert.equal(closedAgain, false, 'Every close caller must wait for the admitted write and event.');
    await sql(blocker, 'ROLLBACK');
    const stored = await creating; await Promise.all([closing, closingAgain]);
    assert.deepEqual(events, [stored]); assert.deepEqual(await Promise.all(committed), [[stored]]);
    assert.equal(stored.RowVersion, 0n);
    assert.deepEqual(await store.run(connection => connection.rows('ActivityLogs')), [stored]);
    assert.equal((await sql(observer.client, 'SELECT 1 AS usable')).rows[0].usable, 1);
    assert.deepEqual(await observer.rows('ActivityLogs', { where: { Type: 'Controlled.Late' } }), []);
    report.observations.push({ afterManagerClose: stored, sharedDatabaseUsable: true });
  } finally {
    let rollbackError;
    try { await sql(blocker, 'ROLLBACK'); } catch (error) { rollbackError = error; }
    blocker.release(rollbackError);
    await Promise.allSettled([creating, closing, closingAgain].filter(Boolean));
    if (rollbackError) throw rollbackError;
  }
});
