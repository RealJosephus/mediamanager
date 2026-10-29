import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withPostgresNativeQueryJitOff } from '../../src/database/postgres-native-query-jit.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { createPostgresNativeItemQueryProjection } from '../../src/library/postgres-native-item-query-projection.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { loadPostgresPageGraph, queryPostgresFolderStats } from '../../src/library/postgres-library-query.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from './postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const text = value => typeof value === 'string' ? value : value?.text ?? '';
const setting = async session => (await session.client.query("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
const set = (session, value, local = false) => session.client.query("SELECT set_config('jit', $1, $2) AS jit", [value, local]);

pgCase('Node cache resource callbacks preserve the real max=1 relation pool JIT setting', async (database, report) => {
  for (const original of ['on', 'off']) {
    const links = new PostgresLinkedChildrenStore({ database });
    await links.initialize();
    const graph = links.resourceGraph;
    const baseline = await links.withSession(setting), callbacks = [];
    let owner;
    try {
      await links.withSession(session => set(session, original));
      const before = await links.withSession(setting);
      assert.deepEqual(before, { jit: original, pid: baseline.pid });
      report.observations.push({ original, phase: 'before graph callbacks', state: before });
      const entity = graph.entity({}); owner = entity.retain();
      const observe = async phase => {
        const state = await links.withSession(setting);
        assert.deepEqual(state, { jit: original, pid: baseline.pid }); callbacks.push(phase);
        report.observations.push({ original, phase, state });
      };
      await graph.bind(entity, { prepare: () => observe('prepare'), detach() { callbacks.push('detach'); },
        release: () => observe('release') });
      await graph.collect(); assert.deepEqual(callbacks, ['prepare']);
      owner.release(); await graph.collect();
      assert.deepEqual(callbacks, ['prepare', 'detach', 'release']);
      const after = await links.withSession(setting);
      assert.deepEqual(after, { jit: original, pid: baseline.pid });
      report.observations.push({ original, phase: 'after graph callbacks', state: after });
    } finally {
      owner?.release();
      try { await graph.close(); }
      finally {
        try { await links.withSession(session => set(session, baseline.jit)); }
        finally { await links.close(); }
      }
    }
  }
});

pgCase('BoxSet root lookup and repository visibility queries borrow and restore the native JIT setting', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    let fail = false;
    session.client.query = async (...args) => {
      if (text(args[0]).startsWith('WITH RECURSIVE')) {
        const during = (await originalQuery("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
        report.observations.push({ fail, during });
        assert.deepEqual(during, { jit: 'off', pid: baseline.pid });
        if (fail) return originalQuery('SELECT 1 / 0');
      }
      return originalQuery(...args);
    };
    try {
      for (const original of ['on', 'off']) for (const lookup of [true, false]) {
        await set(session, original); fail = false;
        const visibility = { boxSetStandalone: true, boxSetRootFolders: [],
          boxSetPathExpansion: { appDataPath: '', metadataPath: '' }, maxRating: 6,
          ...(lookup ? { boxSetRootLookup: 'children' } : { boxSetUserRootIds: [] }) };
        const page = await queryPostgresItemPage(session, { includeitemtypes: ['BoxSet'], limit: 1 }, { visibility });
        assert.deepEqual(page.rows, []); assert.equal(page.total, 0);
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
        fail = true;
        await assert.rejects(queryPostgresItemPage(session, { includeitemtypes: ['BoxSet'], limit: 1 }, { visibility }), { code: '22012' });
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
      }
    } finally { session.client.query = originalQuery; await set(session, baseline.jit); }
  });
});

pgCase('page relationship graphs and folder counters restore their owned backend after successful and failed SQL', async (database, report) => {
  const id = '55ef0000-0000-0000-0000-000000000001', user = '55ef0000-0000-0000-0000-000000000002';
  const row = postgresTestRow('BaseItems', { Id: id, Type: 'MediaBrowser.Controller.Entities.Folder',
    Name: 'Graph counter root', IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', row);
  await database.withConnection(async session => {
    const baseline = await setting(session), query = session.client.query;
    let fail = false, current;
    session.client.query = async (...args) => {
      if (current?.matches(text(args[0]))) {
        const during = (await query("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
        report.observations.push({ operation: current.name, fail, during });
        assert.deepEqual(during, { jit: 'off', pid: baseline.pid });
        if (fail) return query('SELECT 1 / 0');
      }
      return query(...args);
    };
    const operations = [
      { name: 'relationship graph', matches: sql => sql.startsWith('/* page-relationship-graph */'),
        run: async () => assert.deepEqual((await loadPostgresPageGraph(session, [row])).map(value => value.Id), [id]) },
      { name: 'folder counters', matches: sql => sql.startsWith('WITH RECURSIVE requested AS'),
        run: async () => assert.deepEqual((await queryPostgresFolderStats(session, [id], user)).get(id.replaceAll('-', '')),
          { RecursiveItemCount: 0, UnplayedItemCount: 0, Played: true, PlayedPercentage: null }) },
    ];
    try {
      for (const original of ['on', 'off']) for (const operation of operations) {
        current = operation; await set(session, original); fail = false;
        await operation.run(); assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
        fail = true;
        await assert.rejects(operation.run(), { code: '22012' });
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
      }
    } finally { session.client.query = query; await set(session, baseline.jit); }
  });
});

const errorInfo = error => {
  if (error === undefined) return { undefined: true };
  if (error === null || !['object', 'function'].includes(typeof error)) return error;
  return Object.fromEntries(['name', 'message', 'code', 'status', 'statusCode', 'stack'].map(name => {
    try { return [name, error[name]]; }
    catch { return [name, { unreadableGetter: true }]; }
  }));
};
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const failureFields = error => Object.fromEntries(['message', 'code', 'status', 'detail', 'schema', 'table', 'column', 'constraint']
  .map(key => [key, error?.[key]]));
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
    const output = path.join(validationOutputRoot(), 'native-query-jit-' + randomUUID());
    assertValidationOutputChild(output); await mkdir(output, { recursive: true });
    const report = { schemaVersion: 1, name, actualPostgresExecuted: true, actualNativeExecuted: false,
      observations: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
    let database, failure, failed = false;
    try {
      database = await createPostgresTestDatabase(null, 'visibility_jit', { max: 1 });
      await operation(database, report);
    } catch (error) { failure = error; failed = true; }
    finally {
      try { await dropPostgresTestDatabase(database); report.cleanup.databaseAndOwnedSchemasClosed = true; }
      catch (error) {
        report.cleanup.databaseAndOwnedSchemasClosed = errorInfo(error);
        failure = failed ? new AggregateError([failure, error], 'JIT fixture execution and cleanup failed.', { cause: failure }) : error;
        failed = true;
      }
      report.componentPassed = !failed; report.error = failed ? errorInfo(failure) : null;
      let serialized = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2);
      if (postgresTestConnectionString) serialized = serialized.replaceAll(postgresTestConnectionString, '[fixture-secret]');
      await writeFile(path.join(output, 'report.json'), serialized + '\n');
    }
    if (failed) throw failure;
  });
}

pgCase('native query JIT lease pins root calls and restores both original settings after success and failure', async (database, report) => {
  let saved;
  await database.withConnection(async session => {
    saved = session;
    const baseline = await setting(session);
    try {
      for (const original of ['on', 'off']) {
        await set(session, original);
        const actual = await withPostgresNativeQueryJitOff(database, async owner => {
          const during = await setting(owner);
          assert.equal(during.jit, 'off'); assert.equal(during.pid, baseline.pid);
          return during;
        });
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
        report.observations.push({ original, during: actual, after: await setting(session) });
        const primary = new Error('Controlled visibility callback failure.');
        await assert.rejects(withPostgresNativeQueryJitOff(session, async () => { throw primary; }), error => {
          assert.deepEqual(failureFields(error), failureFields(primary)); return true;
        });
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
      }
      await withPostgresNativeQueryJitOff(session, async owner => {
        await assert.rejects(withPostgresNativeQueryJitOff(owner, async () => {}), /cannot nest/u);
      });
    } finally { await set(session, baseline.jit); }
  });
  let invoked = false;
  for (const invalid of [null, 1, {}]) {
    await assert.rejects(withPostgresNativeQueryJitOff(database, invalid), TypeError);
  }
  await assert.rejects(withPostgresNativeQueryJitOff(saved, async () => { invoked = true; }), /active owned/u);
  assert.equal(invoked, false);
});

pgCase('live relational item pages borrow JIT settings without a scalar visibility batch and restore after real SQL failure', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const projection = await createPostgresNativeItemQueryProjection(session);
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
    item.Id = randomUUID(); item.Name = 'Unsaved live query item';
    const slot = randomUUID(); await projection.append(item, slot, 1n);
    let fail = false;
    session.client.query = async (...args) => {
      if (text(args[0]).startsWith('WITH RECURSIVE') && text(args[0]).includes(projection.table)) {
        const during = (await originalQuery("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
        assert.deepEqual(during, { jit: 'off', pid: baseline.pid });
        report.observations.push({ fail, during });
        if (fail) return originalQuery('SELECT 1 / 0');
      }
      return originalQuery(...args);
    };
    const options = { nativeItemsPlan: projection.plan(), resumableMode: 'memory', memorySourceOrder: 'occurrence' };
    try {
      for (const original of ['on', 'off']) {
        await set(session, original); fail = false;
        const page = await queryPostgresItemPage(session, { sortby: ['Name'] }, options);
        assert.equal(page.total, 1); assert.deepEqual(page.slots, [{ id: item.Id, slot }]);
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
        fail = true;
        await assert.rejects(queryPostgresItemPage(session, { sortby: ['Name'] }, options), { code: '22012' });
        assert.deepEqual(await setting(session), { jit: original, pid: baseline.pid });
      }
    } finally {
      session.client.query = originalQuery; await set(session, baseline.jit); await projection.close();
    }
  });
});

pgCase('explicit active JIT owners survive a detached callback and restore the same backend', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session);
    try {
      for (const original of ['on', 'off']) {
        await set(session, original);
        for (const fail of [false, true]) {
          const primary = new Error('Detached metadata query failure.');
          let during;
          const pending = database.runDetached(() => withPostgresNativeQueryJitOff(session, async owner => {
            during = await setting(database);
            assert.deepEqual(during, { jit: 'off', pid: baseline.pid });
            assert.deepEqual(await setting(owner), during);
            if (fail) throw primary;
          }));
          if (fail) await assert.rejects(pending, error => {
            assert.deepEqual(failureFields(error), failureFields(primary)); return true;
          });
          else await pending;
          const after = await setting(session);
          assert.deepEqual(after, { jit: original, pid: baseline.pid });
          report.observations.push({ original, fail, during, after });
        }
      }
    } finally { await set(session, baseline.jit); }
  });
});

pgCase('transaction-local native query JIT restores success and preserves the primary SQL error through 25P02 cleanup and owner rollback', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const controls = [];
    session.client.query = async (...args) => {
      const control = text(args[0]).match(/native-query-jit:(read|disable|restore)/u)?.[1];
      const observed = control ? { control, local: args[0]?.values?.[1] ?? null } : null;
      if (observed) controls.push(observed);
      try { const result = await originalQuery(...args); if (observed) observed.jit = result.rows[0]?.jit; return result; }
      catch (error) { if (observed) observed.errorCode = error.code; throw error; }
    };
    try {
      await set(session, 'on');
      await session.transaction(async transaction => {
        await withPostgresNativeQueryJitOff(transaction, async owner => assert.equal((await setting(owner)).jit, 'off'));
        assert.equal((await setting(transaction)).jit, 'on');
        await set(transaction, 'off', true);
        await withPostgresNativeQueryJitOff(transaction, async owner => assert.equal((await setting(owner)).jit, 'off'));
        assert.equal((await setting(transaction)).jit, 'off');
      });
      assert.equal((await setting(session)).jit, 'on', 'Committing local settings preserves the pre-transaction session value.');
      let primary;
      await assert.rejects(session.transaction(async transaction => {
        try {
          await withPostgresNativeQueryJitOff(transaction, owner => owner.client.query('SELECT 1 / 0'));
        } catch (error) { primary = error; throw error; }
      }), error => {
        assert.equal(error.code, '22012'); assert.deepEqual(failureFields(error), failureFields(primary)); return true;
      });
      assert.deepEqual(await setting(session), { jit: 'on', pid: baseline.pid });
      assert.ok(controls.filter(value => ['disable', 'restore'].includes(value.control)).every(value => value.local === true));
      assert.deepEqual(controls.filter(value => value.control === 'restore').map(value => value.errorCode ?? null), [null, null, '25P02']);
      report.observations.push({ baseline, controls, primary: errorInfo(primary), afterRollback: await setting(session) });
    } finally { session.client.query = originalQuery; await set(session, baseline.jit); }
  });
});

pgCase('two native query setting leases on one physical client serialize their complete read-disable-query-restore intervals', async (database, report) => {
  await database.withConnection(async session => {
    const baseline = await setting(session), originalQuery = session.client.query;
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), order = [];
    let first, second, secondEntered = false;
    session.client.query = (...args) => {
      const control = text(args[0]).match(/native-query-jit:(read|disable|restore)/u)?.[1];
      if (control) order.push(control);
      return originalQuery(...args);
    };
    try {
      await set(session, 'on');
      first = withPostgresNativeQueryJitOff(session, async owner => {
        order.push('first'); assert.equal((await setting(owner)).jit, 'off'); entered.resolve();
        await proceed.promise;
        assert.equal((await setting(owner)).jit, 'off'); return 'first-result';
      }); void first.catch(() => {});
      await enteredBeforeCompletion(entered.promise, first, 'first visibility query entered');
      second = withPostgresNativeQueryJitOff(session, async owner => {
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
      const control = text(args[0]).match(/native-query-jit:(read|disable|restore)/u)?.[1];
      if (control) {
        assert.equal(typeof args[0] === 'string' ? undefined : args[0].signal, undefined);
        controls.push(control);
      }
      return originalQuery(...args);
    };
    try {
      await set(session, 'on');
      pending = withPostgresNativeQueryJitOff(session, async owner => {
        const actual = await owner.client.query({ text: "SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid", signal: controller.signal });
        assert.deepEqual(actual.rows[0], { jit: 'off', pid: baseline.pid });
        entered.resolve(); await proceed.promise; controller.signal.throwIfAborted();
      }); void pending.catch(() => {});
      await enteredBeforeCompletion(entered.promise, pending, 'admitted SQL before caller cancellation');
      controller.abort(reason); proceed.resolve();
      await assert.rejects(within(pending, 'caller cancellation and uncancelled restoration'), error => {
        assert.equal(controller.signal.aborted, true); assert.deepEqual(failureFields(error), failureFields(reason)); return true;
      });
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
      let first, queued, queuedInvoked = false, observedFailure, restorationFailure;
      await set(session, 'on');
      session.client.query = async (...args) => {
        if (!text(args[0]).includes('native-query-jit:restore')) return originalQuery(...args);
        // Actual PostgreSQL rejects this unknown setting. This is a controlled
        // restore-path SQL fault, not a fabricated driver result or exception.
        try { return await originalQuery('SELECT current_setting($1) AS jit', ['mediamanager_controlled_missing_jit_setting']); }
        catch (error) { restorationFailure = error; throw error; }
      };
      try {
        first = withPostgresNativeQueryJitOff(session, async owner => {
          assert.equal((await setting(owner)).jit, 'off'); entered.resolve(); await proceed.promise;
          if (failBusiness) throw primary;
          return 'business-succeeded';
        }); void first.catch(() => {});
        await enteredBeforeCompletion(entered.promise, first, 'visibility callback before controlled restore SQL fault');
        queued = withPostgresNativeQueryJitOff(session, async () => { queuedInvoked = true; }); void queued.catch(() => {});
        proceed.resolve();
        await assert.rejects(within(first, 'failed restoration quarantines physical client'), error => {
          observedFailure = error;
          if (failBusiness) {
            assert.deepEqual(error.errors, [primary, restorationFailure]); assert.deepEqual(error.cause, primary);
          } else assert.deepEqual(error, restorationFailure);
          assert.equal(restorationFailure.code, '42704');
          return true;
        });
        await assert.rejects(within(queued, 'queued lease rejects discarded backend'), /connection was discarded/u);
        assert.equal(queuedInvoked, false);
        session.client.query = originalQuery;
        await assert.rejects(session.client.query('SELECT 1'), /connection was discarded/u);
        report.observations.push({ failBusiness, previousPid, primary: failBusiness ? errorInfo(primary) : null,
          failure: failBusiness ? { name: observedFailure.name, causeIsPrimary: observedFailure.cause === primary,
            errors: observedFailure.errors.map(errorInfo) } : errorInfo(observedFailure), queuedInvoked });
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

pgCase('every falsy rejection after an actual JIT restore SET preserves single and ordered dual failures, drains the queue and retains its committed prefix', async (database, report) => {
  const markers = `${q(database.schemaName)}."jit_recovery_markers"`;
  await database.client.query(`CREATE TABLE ${markers}(name text PRIMARY KEY, payload text NOT NULL)`);
  const committed = [];
  const falsy = [false, 0, '', null, undefined];
  const scenarios = falsy.flatMap(restoration => ['success', 'error', 'falsy'].map(business => ({ restoration, business })));
  scenarios.push({ restoration: false, business: 'hostile-getters' });
  for (const [index, scenario] of scenarios.entries()) {
    const name = String(index).padStart(4, '0') + '-' + scenario.business;
    const primary = scenario.business === 'falsy' ? scenario.restoration : Object.assign(new Error('Controlled native query business rejection.'),
      { code: 'jit-business-failed', status: 409, statusCode: 503 });
    if (scenario.business === 'hostile-getters') Object.defineProperties(primary, {
      message: { get() { throw new Error('Controlled primary message getter failure.'); }, configurable: true },
      code: { get() { throw new Error('Controlled primary code getter failure.'); }, configurable: true },
    });
    let previousPid, originalDefault;
    const observation = { name, business: scenario.business, restorationReason: errorInfo(scenario.restoration) };
    report.observations.push(observation);
    await database.withConnection(async session => {
      const baseline = await setting(session), query = session.client.query;
      previousPid = baseline.pid; originalDefault = baseline.jit;
      const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
      let first, queued;
      await set(session, 'on');
      session.client.query = async (...args) => {
        const actual = await query(...args);
        if (text(args[0]).includes('native-query-jit:restore')) {
          // The real SET has completed. Read the actual backend once more
          // before injecting its caller-visible rejection, without replacing
          // a PostgreSQL response or claiming server-side cancellation.
          const restored = (await query("SELECT current_setting('jit') AS jit, pg_backend_pid() AS pid")).rows[0];
          assert.equal(actual.rows[0].jit, 'on'); assert.deepEqual(restored, { jit: 'on', pid: baseline.pid });
          observation.actualRestoredSetting = restored;
          throw scenario.restoration;
        }
        return actual;
      };
      try {
        first = outcome(withPostgresNativeQueryJitOff(session, async owner => {
          assert.deepEqual(await setting(owner), { jit: 'off', pid: baseline.pid });
          await owner.client.query(`INSERT INTO ${markers}(name,payload) VALUES($1,$2)`, [name, 'committed before restoration']);
          committed.push({ name, payload: 'committed before restoration' });
          entered.resolve(); await proceed.promise;
          if (scenario.business !== 'success') throw primary;
          return 'business completed';
        }));
        await Promise.race([entered.promise, first.then(result => {
          throw new Error('The lease settled before its real committed SQL prefix.', { cause: result.reason });
        })]);
        queued = outcome(withPostgresNativeQueryJitOff(session, owner =>
          owner.client.query(`INSERT INTO ${markers}(name,payload) VALUES($1,$2)`, ['queued-' + name, 'must not be committed'])));
        proceed.resolve();
        const result = await first;
        assert.equal(result.failed, true);
        if (scenario.business === 'success') assert.equal(result.reason, scenario.restoration);
        else {
          assert.ok(result.reason instanceof AggregateError);
          assert.equal(result.reason.errors.length, 2);
          assert.equal(result.reason.errors[1], scenario.restoration);
          assert.ok(Object.hasOwn(result.reason, 'cause'));
          if (scenario.business === 'hostile-getters') {
            for (const error of [result.reason.cause, result.reason.errors[0]]) {
              assert.equal(error.status, 409); assert.equal(error.statusCode, 503);
              assert.throws(() => error.message, /Controlled primary message getter failure/u);
              assert.throws(() => error.code, /Controlled primary code getter failure/u);
            }
          } else {
            assert.deepEqual(result.reason.errors[0], primary); assert.deepEqual(result.reason.cause, primary);
          }
          if (scenario.business === 'error') {
            assert.equal(result.reason.message, primary.message); assert.equal(result.reason.code, primary.code);
            assert.equal(result.reason.status, 409); assert.equal(result.reason.statusCode, 503);
          } else if (scenario.business === 'hostile-getters') {
            assert.equal(result.reason.status, 409); assert.equal(result.reason.statusCode, 503);
          }
        }
        const rejectedQueue = await queued;
        assert.equal(rejectedQueue.failed, true); assert.match(rejectedQueue.reason.message, /connection was discarded/u);
        session.client.query = query;
        await assert.rejects(session.client.query('SELECT 1 AS unavailable'), /connection was discarded/u);
        observation.returnedFailure = scenario.business === 'success' ? errorInfo(result.reason)
          : { message: result.reason.message, code: result.reason.code, status: result.reason.status,
            statusCode: result.reason.statusCode, cause: errorInfo(result.reason.cause), errors: result.reason.errors.map(errorInfo) };
        observation.queuedFailure = errorInfo(rejectedQueue.reason);
      } finally {
        proceed.resolve(); await Promise.allSettled([first, queued]); session.client.query = query;
      }
    });
    const recovered = await database.withConnection(async session => ({ setting: await setting(session),
      committed: (await session.client.query(`SELECT name,payload FROM ${markers} ORDER BY name`)).rows,
      query: (await session.client.query('SELECT 1 AS restored')).rows }));
    assert.notEqual(recovered.setting.pid, previousPid, 'A discarded restoration owner cannot return to the pool.');
    assert.equal(recovered.setting.jit, originalDefault);
    assert.deepEqual(recovered.committed, committed);
    assert.deepEqual(recovered.query, [{ restored: 1 }]);
    observation.recovered = recovered;
  }
});

pgCase('pool close waits for an admitted native query to restore JIT and rejects new root work', async (database, report) => {
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), events = [];
  let pending, closing, saved;
  try {
    pending = database.withConnection(async session => {
      saved = session;
      const baseline = await setting(session), originalQuery = session.client.query;
      await set(session, 'on');
      session.client.query = async (...args) => {
        const result = await originalQuery(...args);
        if (text(args[0]).includes('native-query-jit:restore')) {
          assert.equal(result.rows[0].jit, 'on'); events.push('restored');
        }
        return result;
      };
      try {
        const result = await withPostgresNativeQueryJitOff(session, async owner => {
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
    await assert.rejects(withPostgresNativeQueryJitOff(database, async () => {}), /closed|not queryable/u);
    assert.equal(closed, false);
    proceed.resolve();
    assert.equal(await within(pending, 'admitted query restores before connection release'), 'complete');
    await within(closing, 'pool close after restoration');
    assert.deepEqual(events, ['business-finished', 'restored', 'closed']);
    await assert.rejects(withPostgresNativeQueryJitOff(saved, async () => {}), /active owned/u);
    report.observations.push({ events, connectionReturned: !saved.connectionActive, poolConnections: database.pool.totalCount });
  } finally { proceed.resolve(); await Promise.allSettled([pending, closing]); }
});
