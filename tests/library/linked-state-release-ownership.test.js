import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '51200000-0000-0000-0000-000000000001';
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];

test('releasing actual SQL state pins preserves failures and retires connections with uncertain temporary cleanup', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-state-release-ownership-'));
  const database = await createPostgresTestDatabase(null, 'state_release_owner');
  const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  t.after(async () => { await links.close(); await dropPostgresTestDatabase(database); });
  const counts = async () => {
    const value = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) value[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    return value;
  };
  const createPinned = async scopeId => {
    let relation;
    try {
      return await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId });
        await writer.append({ Path: 'Z:\\Media\\repeated.mkv', Type: 0 });
        await writer.append({ Path: 'Z:\\Media\\repeated.mkv', Type: 0 });
        relation = await writer.finish();
        return links.pinState(relation, { session, scopeId, slotId: 'linked-children' });
      });
    } finally { if (relation) await links.release(relation); }
  };
  const cases = [false, true].flatMap(primary => [
    { name: `${primary ? 'unpin-and-' : ''}dependent-drop`, primary, dependent: true },
    ...falsy.map(([name, reason]) => ({ name: `${primary ? 'unpin-and-' : ''}drop-${name}`, primary, reason })),
  ]);
  for (const sample of cases) await t.test(sample.name, async t => {
    const scopeId = randomUUID(), token = await createPinned(scopeId);
    const before = { sets: 1, rows: 2, pins: 1 }, empty = { sets: 0, rows: 0, pins: 0 };
    assert.deepEqual(await counts(), before);
    let primary, cleanup, backendPid, restored, injected = false, drops = 0;
    const temporaries = [];
    t.after(async () => {
      if (restored) await links.release(restored);
      await links.releaseStateScope(scopeId); await links.flushReleases();
    });
    const failed = await outcome(links.withSession(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const temporary = /^CREATE TEMP TABLE ("mm_(?:unpin|active)_[^"]+")/u.exec(sql)?.[1];
        if (temporary) {
          temporaries.push(temporary.slice(1, -1));
          const result = await query(statement, ...args);
          if (sample.dependent && temporary.startsWith('"mm_unpin_')) await query(`CREATE TEMP VIEW state_cleanup_dependency AS SELECT * FROM ${temporary}`);
          return result;
        }
        if (sample.primary && !injected && sql.startsWith(`DELETE FROM ${links.pins} WHERE scope_id=$1`)) {
          injected = true;
          try { return await query(sql.replace('WHERE scope_id=$1', 'WHERE absent_scope_id=$1'), ...args); }
          catch (error) { primary = error; throw error; }
        }
        if (sql.startsWith('DROP TABLE IF EXISTS "mm_unpin_')) {
          drops++;
          try { const result = await query(statement, ...args); if (!sample.dependent) throw sample.reason; return result; }
          catch (error) { cleanup = error; throw error; }
        }
        return query(statement, ...args);
      };
      try { await links.releaseStateScope(scopeId, { session }); }
      finally { session.client.query = query; }
    }));
    assert.ok(Object.hasOwn(failed, 'error')); assert.equal(drops, 1); assert.equal(temporaries.length, 2);
    if (sample.primary) {
      assert.equal(injected, true); assert.equal(primary.code, '42703');
      assert.deepEqual(failed.error.errors, [primary, cleanup]); assert.equal(failed.error.cause, primary); assert.equal(failed.error.code, '42703');
    } else assert.equal(failed.error, cleanup);
    if (sample.dependent) assert.equal(cleanup.code, '2BP01'); else assert.equal(cleanup, sample.reason);
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    for (const name of temporaries) assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [name])).rows[0].count), 0);
    const afterFailure = await counts(); assert.deepEqual(afterFailure, sample.primary ? before : empty);
    if (sample.primary) {
      restored = await links.restoreState(token);
      assert.deepEqual((await links.page(restored)).map(row => row.Path), ['Z:\\Media\\repeated.mkv', 'Z:\\Media\\repeated.mkv']);
      await links.release(restored); restored = undefined;
    }
    await links.releaseStateScope(scopeId); assert.deepEqual(await counts(), empty);
    const recoveryScope = randomUUID(), recoveredToken = await createPinned(recoveryScope);
    try {
      restored = await links.restoreState(recoveredToken);
      assert.deepEqual((await links.page(restored)).map(row => row.Path), ['Z:\\Media\\repeated.mkv', 'Z:\\Media\\repeated.mkv']);
    } finally {
      if (restored) await links.release(restored); restored = undefined;
      await links.releaseStateScope(recoveryScope);
    }
    assert.deepEqual(await counts(), empty);
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name, failure: errorObservation(failed.error),
      drops, backendPid, backendEnded: true, temporaries, temporaryTablesRemoved: true, afterFailure, afterRecovery: await counts() }, null, 2) + '\n');
  });
});
