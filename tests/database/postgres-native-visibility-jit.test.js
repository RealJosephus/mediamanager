import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withPostgresNativeVisibilityJitOff } from '../../src/database/postgres-native-visibility-jit.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from './postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const text = value => typeof value === 'string' ? value : value?.text ?? '';
const setting = async session => (await session.client.query("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
const set = (session, value, local = false) => session.client.query("SELECT set_config('jit', $1, $2) AS jit", [value, local]);
const errorInfo = error => ({ name: error?.name, message: error?.message, code: error?.code, stack: error?.stack });
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 15000);
  })]); }
  finally { clearTimeout(timer); }
}
const enteredBeforeCompletion = (entered, pending, label) => within(Promise.race([
  entered,
  pending.then(() => { throw new Error('Operation completed before its held gate: ' + label); }),
]), label);

function pgCase(name, operation) {
  test(name, { skip: !postgresTestConnectionString, timeout: 90000 }, async () => {
    const output = path.join(validationOutputRoot(), 'native-visibility-jit-' + randomUUID());
    assertValidationOutputChild(output); await mkdir(output, { recursive: true });
    const report = { schemaVersion: 1, name, actualPostgresExecuted: true, actualNativeExecuted: false,
      observations: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
    let database, failure;
    try {
      database = await createPostgresTestDatabase(null, 'visibility_jit', { max: 1 });
      await operation(database, report);
    } catch (error) { failure = error; }
    finally {
      try { await dropPostgresTestDatabase(database); report.cleanup.databaseAndOwnedSchemasClosed = true; }
      catch (error) {
        report.cleanup.databaseAndOwnedSchemasClosed = errorInfo(error);
        failure = failure ? new AggregateError([failure, error], failure.message, { cause: failure }) : error;
      }
      report.componentPassed = !failure; report.error = failure ? errorInfo(failure) : null;
      let serialized = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2);
      if (postgresTestConnectionString) serialized = serialized.replaceAll(postgresTestConnectionString, '[fixture-secret]');
      await writeFile(path.join(output, 'report.json'), serialized + '\n');
    }
    if (failure) throw failure;
  });
}

pgCase('bounded native visibility JIT lease pins root calls and restores both original settings after success and failure', async (database, report) => {
  let saved;
  await database.withConnection(async session => {
    saved = session;
    const baseline = await setting(session);
    try {
      for (const original of ['on', 'off']) {
        await set(session, original);
        for (const count of [1, 128]) {
          const actual = await withPostgresNativeVisibilityJitOff(database, count, async owner => {
            assert.equal(owner, session);
            const during = await setting(owner);
            assert.equal(during.jit, 'off'); assert.equal(during.pid, baseline.pid);
            return during;
          });
          assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
          report.observations.push({ original, projectionCount: count, during: actual, after: await setting(session) });
        }
        const primary = new Error('Controlled visibility callback failure.');
        await assert.rejects(withPostgresNativeVisibilityJitOff(session, 2, async () => { throw primary; }), error => error === primary);
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
      }
      await withPostgresNativeVisibilityJitOff(session, 1, async owner => {
        await assert.rejects(withPostgresNativeVisibilityJitOff(owner, 1, async () => {}), /cannot nest/u);
      });
    } finally { await set(session, baseline.jit); }
  });
  let invoked = false;
  for (const count of [0, -1, 129, 1.5, NaN]) {
    await assert.rejects(withPostgresNativeVisibilityJitOff(database, count, async () => { invoked = true; }), TypeError);
  }
  await assert.rejects(withPostgresNativeVisibilityJitOff(saved, 1, async () => { invoked = true; }), /active owned/u);
  assert.equal(invoked, false);
});

pgCase('transaction-local native visibility JIT restores success and preserves the primary SQL error through 25P02 cleanup and owner rollback', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const controls = [];
    session.client.query = async (...args) => {
      const control = text(args[0]).match(/native-visibility-jit:(read|disable|restore)/u)?.[1];
      const observed = control ? { control, local: args[0]?.values?.[1] ?? null } : null;
      if (observed) controls.push(observed);
      try { const result = await originalQuery(...args); if (observed) observed.jit = result.rows[0]?.jit; return result; }
      catch (error) { if (observed) observed.errorCode = error.code; throw error; }
    };
    try {
      await set(session, 'on');
      await session.transaction(async transaction => {
        await withPostgresNativeVisibilityJitOff(transaction, 2, async owner => assert.equal((await setting(owner)).jit, 'off'));
        assert.equal((await setting(transaction)).jit, 'on');
        await set(transaction, 'off', true);
        await withPostgresNativeVisibilityJitOff(transaction, 1, async owner => assert.equal((await setting(owner)).jit, 'off'));
        assert.equal((await setting(transaction)).jit, 'off');
      });
      assert.equal((await setting(session)).jit, 'on', 'Committing local settings preserves the pre-transaction session value.');
      let primary;
      await assert.rejects(session.transaction(async transaction => {
        try {
          await withPostgresNativeVisibilityJitOff(transaction, 128, owner => owner.client.query('SELECT 1 / 0'));
        } catch (error) { primary = error; throw error; }
      }), error => error === primary && error.code === '22012');
      assert.equal(session.inTransaction, false);
      assert.equal(session.connectionReleaseError, null, 'Expected aborted-transaction cleanup does not quarantine a correctly rolled-back connection.');
      assert.deepEqual(await setting(session), { jit: 'on', pid: baseline.pid });
      assert.ok(controls.filter(value => ['disable', 'restore'].includes(value.control)).every(value => value.local === true));
      assert.deepEqual(controls.filter(value => value.control === 'restore').map(value => value.errorCode ?? null), [null, null, '25P02']);
      report.observations.push({ baseline, controls, primary: errorInfo(primary), afterRollback: await setting(session) });
    } finally { session.client.query = originalQuery; await set(session, baseline.jit); }
  });
});

pgCase('two native visibility setting leases on one physical client serialize their complete read-disable-query-restore intervals', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), order = [];
    let first, second, secondEntered = false;
    session.client.query = (...args) => {
      const control = text(args[0]).match(/native-visibility-jit:(read|disable|restore)/u)?.[1];
      if (control) order.push(control);
      return originalQuery(...args);
    };
    try {
      await set(session, 'on');
      first = withPostgresNativeVisibilityJitOff(session, 1, async owner => {
        order.push('first'); assert.equal((await setting(owner)).jit, 'off'); entered.resolve();
        await proceed.promise;
        assert.equal((await setting(owner)).jit, 'off'); return 'first-result';
      }); void first.catch(() => {});
      await enteredBeforeCompletion(entered.promise, first, 'first visibility query entered');
      second = withPostgresNativeVisibilityJitOff(session, 2, async owner => {
        secondEntered = true; order.push('second'); assert.equal((await setting(owner)).jit, 'off'); return 'second-result';
      }); void second.catch(() => {});
      await Promise.resolve();
      assert.equal(secondEntered, false); assert.equal(order.filter(value => value === 'read').length, 1);
      proceed.resolve();
      assert.deepEqual(await within(Promise.all([first, second]), 'both serialized leases'), ['first-result', 'second-result']);
      assert.deepEqual(order, ['read', 'disable', 'first', 'restore', 'read', 'disable', 'second', 'restore']);
      assert.deepEqual(await setting(session), { jit: 'on', pid: baseline.pid });
      report.observations.push({ backendPid: baseline.pid, order, after: await setting(session) });
    } finally {
      proceed.resolve(); await Promise.allSettled([first, second]);
      session.client.query = originalQuery; await set(session, baseline.jit);
    }
  });
});

pgCase('a caller abort after admitted real PostgreSQL work does not cancel JIT restoration', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), controls = [], controller = new AbortController();
    const reason = new DOMException('Controlled caller cancellation after admitted SQL.', 'AbortError');
    let pending;
    session.client.query = (...args) => {
      const control = text(args[0]).match(/native-visibility-jit:(read|disable|restore)/u)?.[1];
      if (control) {
        assert.equal(typeof args[0] === 'string' ? undefined : args[0].signal, undefined);
        controls.push(control);
      }
      return originalQuery(...args);
    };
    try {
      await set(session, 'on');
      pending = withPostgresNativeVisibilityJitOff(session, 1, async owner => {
        const actual = await owner.client.query({ text: "SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid", signal: controller.signal });
        assert.deepEqual(actual.rows[0], { jit: 'off', pid: baseline.pid });
        entered.resolve(); await proceed.promise; controller.signal.throwIfAborted();
      }); void pending.catch(() => {});
      await enteredBeforeCompletion(entered.promise, pending, 'admitted SQL before caller cancellation');
      controller.abort(reason); proceed.resolve();
      await assert.rejects(within(pending, 'caller cancellation and uncancelled restoration'), error => error === reason);
      assert.deepEqual(controls, ['read', 'disable', 'restore']);
      assert.deepEqual(await setting(session), { jit: 'on', pid: baseline.pid });
      report.observations.push({ cancellation: errorInfo(reason), controls, after: await setting(session), backendQueryCancellationClaimed: false });
    } finally {
      proceed.resolve(); await Promise.allSettled([pending]); session.client.query = originalQuery;
      await set(session, baseline.jit);
    }
  });
});

pgCase('a real SQL restoration failure quarantines the backend, drains queued leases and aggregates without losing a primary callback error', async (database, report) => {
  for (const failBusiness of [false, true]) {
    let previousPid, originalDefault;
    await database.withConnection(async session => {
      const baseline = await setting(session), originalQuery = session.client.query;
      previousPid = baseline.pid; originalDefault = baseline.jit;
      const primary = new Error('Controlled primary query callback failure.');
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
      let first, queued, queuedInvoked = false, aggregate;
      await set(session, 'on');
      session.client.query = (...args) => text(args[0]).includes('native-visibility-jit:restore')
        // Actual PostgreSQL rejects this unknown setting. This is a controlled
        // restore-path SQL fault, not a fabricated driver result or exception.
        ? originalQuery('SELECT current_setting($1) AS jit', ['mediamanager_controlled_missing_jit_setting'])
        : originalQuery(...args);
      try {
        first = withPostgresNativeVisibilityJitOff(session, 1, async owner => {
          assert.equal((await setting(owner)).jit, 'off'); entered.resolve(); await proceed.promise;
          if (failBusiness) throw primary;
          return 'business-succeeded';
        }); void first.catch(() => {});
        await enteredBeforeCompletion(entered.promise, first, 'visibility callback before controlled restore SQL fault');
        queued = withPostgresNativeVisibilityJitOff(session, 1, async () => { queuedInvoked = true; }); void queued.catch(() => {});
        proceed.resolve();
        await assert.rejects(within(first, 'failed restoration quarantines physical client'), error => {
          aggregate = error; assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, failBusiness ? 2 : 1);
          assert.equal(error.errors.at(-1).code, '42704');
          assert.equal(error.cause, failBusiness ? primary : error.errors[0]);
          if (failBusiness) assert.equal(error.errors[0], primary);
          return true;
        });
        await assert.rejects(within(queued, 'queued lease rejects discarded backend'), /connection was discarded/u);
        assert.equal(queuedInvoked, false);
        assert.equal(session.connectionReleaseError.code, '42704');
        session.client.query = originalQuery;
        await assert.rejects(session.client.query('SELECT 1'), /connection was discarded/u);
        report.observations.push({ failBusiness, previousPid, primary: failBusiness ? errorInfo(primary) : null,
          aggregate: { name: aggregate.name, causeIsPrimary: failBusiness && aggregate.cause === primary,
            errors: aggregate.errors.map(errorInfo) }, queuedInvoked });
      } finally {
        proceed.resolve(); await Promise.allSettled([first, queued]); session.client.query = originalQuery;
      }
    });
    const replacement = await database.withConnection(setting);
    assert.notEqual(replacement.pid, previousPid, 'The poisoned physical backend must not return to the pool.');
    assert.equal(replacement.jit, originalDefault);
    report.observations.at(-1).replacement = replacement;
  }
});

pgCase('pool close waits for an admitted native visibility query to restore JIT and rejects new root work', async (database, report) => {
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), events = [];
  let pending, closing, saved;
  try {
    pending = database.withConnection(async session => {
      saved = session;
      const baseline = await setting(session), originalQuery = session.client.query;
      await set(session, 'on');
      session.client.query = async (...args) => {
        const result = await originalQuery(...args);
        if (text(args[0]).includes('native-visibility-jit:restore')) {
          assert.equal(result.rows[0].jit, 'on'); events.push('restored');
        }
        return result;
      };
      try {
        const result = await withPostgresNativeVisibilityJitOff(session, 128, async owner => {
          assert.equal((await setting(owner)).jit, 'off'); entered.resolve();
          await proceed.promise; events.push('business-finished'); return 'complete';
        });
        assert.equal((await setting(session)).jit, 'on');
        return result;
      } finally { session.client.query = originalQuery; await set(session, baseline.jit); }
    }); void pending.catch(() => {});
    await enteredBeforeCompletion(entered.promise, pending, 'held visibility query before root close');
    let closed = false;
    closing = database.close().then(() => { closed = true; events.push('closed'); }); void closing.catch(() => {});
    await assert.rejects(withPostgresNativeVisibilityJitOff(database, 1, async () => {}), /closed|not queryable/u);
    assert.equal(closed, false);
    proceed.resolve();
    assert.equal(await within(pending, 'admitted query restores before connection release'), 'complete');
    await within(closing, 'pool close after restoration');
    assert.deepEqual(events, ['business-finished', 'restored', 'closed']);
    assert.equal(saved.connectionActive, false); assert.equal(database.pool.totalCount, 0);
    await assert.rejects(withPostgresNativeVisibilityJitOff(saved, 1, async () => {}), /active owned/u);
    report.observations.push({ events, connectionReturned: !saved.connectionActive, poolConnections: database.pool.totalCount });
  } finally { proceed.resolve(); await Promise.allSettled([pending, closing]); }
});
