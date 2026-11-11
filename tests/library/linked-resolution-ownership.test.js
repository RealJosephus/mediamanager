import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresLinkedResolutionWorkspace } from '../../src/library/postgres-linked-resolution-workspace.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const fields = { code: 'resolution-rejected', status: 409, statusCode: 503 };
const primaryError = () => Object.assign(new Error('The actual resolution construction was rejected.'), fields);
const reasons = [
  { name: 'postgres', postgres: true },
  { name: 'public', create: primaryError },
  ...['message', 'code', 'status', 'statusCode'].map(property => ({ name: `getter-${property}`, property, create() {
    const error = primaryError();
    Object.defineProperty(error, property, { get() { throw new Error('A diagnostic accessor cannot replace the operation failure.'); } });
    return error;
  } })),
  ...[['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]
    .map(([name, reason]) => ({ name, create: () => reason })),
];
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, !Object.hasOwn(descriptor, 'value') ? { accessor: true }
      : key === 'errors' ? descriptor.value.map(observation)
        : key === 'cause' ? observation(descriptor.value) : descriptor.value];
  }));
}

test('linked resolution construction preserves real SQL and arbitrary failures while a rejected TEMP drop retires its connection', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-resolution-ownership-'));
  let database, links, source;
  t.after(async () => {
    try { if (source) await links.release(source); }
    finally { try { await links?.close(); } finally { await dropPostgresTestDatabase(database); } }
  });
  database = await createPostgresTestDatabase(null, 'resolution_owner');
  links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  const paths = ['Z:\\Media\\repeated.mkv', 'Z:\\Media\\second.mkv', 'Z:\\Media\\repeated.mkv'];
  source = await links.withSession(async session => {
    const writer = await links.createWriter({ session, parentId: '52800000-0000-0000-0000-000000000001' });
    try { for (const Path of paths) await writer.append({ Path, Type: 0 }); }
    catch (error) { await writer.abort(); throw error; }
    return writer.finish();
  });
  const counts = async () => {
    const result = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
      result[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    return result;
  };
  const sourceCounts = { sets: 1, rows: 3, pins: 0 };
  assert.deepEqual(await counts(), sourceCounts);
  for (const phase of ['create', 'insert']) for (const reason of reasons) await t.test(`${phase}/${reason.name}`, async () => {
    let primary = reason.create?.(), cleanup, raw, dependency, backendPid, committedRows, drops = 0, injected = false;
    const failed = await outcome(database.withConnection(async session => {
      const query = session.client.query.bind(session.client);
      backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      session.client.query = async (statement, ...args) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const created = /^CREATE TEMP TABLE ("mm_link_resolution_raw_[^"]+")/u.exec(sql)?.[1];
        if (sql.startsWith('DROP TABLE IF EXISTS "mm_link_resolution_batch_')) {
          drops++;
          try { return await query(statement, ...args); }
          catch (error) { cleanup = error; throw error; }
        }
        const result = await query(statement, ...args);
        if (created) {
          raw = created; dependency = 'blocked_' + raw.slice(1, -1).slice(-32);
          await query(`CREATE TEMP VIEW "${dependency}" AS SELECT * FROM ${raw}`);
        }
        if (!injected && (phase === 'create' && created || phase === 'insert' && raw && sql.startsWith(`INSERT INTO ${raw}`))) {
          injected = true;
          committedRows = Number((await query(`SELECT count(*) AS count FROM ${raw}`)).rows[0].count);
          if (reason.postgres) {
            try { await query(`SELECT missing_resolution_creation_column FROM ${raw}`); }
            catch (error) { primary = Object.assign(error, { status: 409, statusCode: 503 }); }
          }
          throw primary;
        }
        return result;
      };
      try { return await createPostgresLinkedResolutionWorkspace(session, { linksPlan: links.plan(source, { session }) }); }
      finally { session.client.query = query; }
    }));
    assert.ok(Object.hasOwn(failed, 'error')); assert.equal(injected, true); assert.equal(drops, 1);
    assert.equal(committedRows, phase === 'create' ? 0 : paths.length);
    assert.equal(cleanup.code, '2BP01'); assert.ok(failed.error instanceof AggregateError);
    assert.equal(failed.error.cause, primary); assert.deepEqual(failed.error.errors, [primary, cleanup]);
    if (reason.postgres) assert.equal(primary.code, '42703');
    if (primary instanceof Error) for (const key of ['code', 'status', 'statusCode']) {
      assert.equal(failed.error[key], reason.property === key ? undefined : primary[key]);
    }
    if (reason.property === 'message') assert.equal(failed.error.message, 'Linked resolution workspace creation failed.');
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [backendPid])).rows[0].count), 0);
    const temporaryNames = [raw.slice(1, -1), dependency];
    assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=ANY($1::text[])', [temporaryNames])).rows[0].count), 0);
    assert.deepEqual((await links.page(source)).map(row => row.Path), paths);
    assert.deepEqual(await counts(), sourceCounts);
    let recoveryPid;
    await database.withConnection(async session => {
      recoveryPid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: links.plan(source, { session }) });
      const relation = workspace.sqlRelation();
      try {
        assert.equal(await workspace.count(), paths.length);
        assert.deepEqual((await workspace.readLinksPage({ after: 0n, limit: 128 })).map(row => row.Path), paths);
      } finally { await workspace.dispose(); }
      assert.equal((await session.client.query('SELECT to_regclass($1) AS relation', [relation])).rows[0].relation, null);
    });
    assert.notEqual(recoveryPid, backendPid); assert.deepEqual(await counts(), sourceCounts);
    await fs.writeFile(path.join(root, `${phase}-${reason.name}.json`), JSON.stringify({ phase, reason: reason.name,
      failure: observation(failed.error), committedRows, drops, backendPid, recoveryPid, backendEnded: true,
      temporaryNames, temporariesRemoved: true, sourceCounts, recoveredPaths: paths }, null, 2) + '\n');
  });
  await links.release(source); source = undefined; await links.flushReleases();
  const after = await counts(); assert.deepEqual(after, { sets: 0, rows: 0, pins: 0 });
  await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ after }, null, 2) + '\n');
});
