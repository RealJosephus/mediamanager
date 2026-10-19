import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import {postgresTestRow} from '../database/postgres-fixture.js';

import test from 'node:test';
test('postgres: raw links own an independent max1 pool across readOnly, TEMP, rollback and drain', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async()=>{
const schema = 'source_relations_' + randomUUID().replaceAll('-', '').slice(0,20);
const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, maxPoolSize: 1, schema, create:true });
const pool=database.pool;
const store = new PostgresLinkedChildrenStore({ database });
const checks = [], handles = [], observations = [];
const id = n => n.toString(16).padStart(32, '0');
let writer, scope = randomUUID(), closePromise;
const record = (name, detail = {}) => checks.push({ name, passed: true, ...detail });
const originalQuery = database.client.query;
database.client.query = async function (...args) {
  const result = await originalQuery(...args);
  observations.push({ text: typeof args[0] === 'string' ? args[0] : args[0].text, rows: result?.rows?.length ?? null });
  return result;
};
try {
  await database.transaction(async session=>{for(const value of [...Array.from({length:257},(_,i)=>i+1),900])await session.insert('BaseItems',postgresTestRow('BaseItems',{Id:id(value),Type:'MediaBrowser.Controller.Entities.Movies.Movie',Data:'{}',Name:'member '+value,DateCreated:'2026-10-14 00:00:00',DateModified:'2026-10-14 00:00:00'}));});
  await database.client.query({ text: `INSERT INTO "${schema}"."LinkedChildren" SELECT $1,number-1,convert_to(lpad(to_hex(number),32,'0'),'UTF8'),0 FROM generate_series(1,257) number`, values: [nativeTextBytes(id(900))] });
  await store.initialize();
  assert.equal(store.relationDatabase.pool.options.max, 1);
  assert.notEqual(store.relationDatabase.pool, pool);
  record('separate physical pool with max=1');

  await database.withConnection(async session => {
    await session.client.query('CREATE TEMP TABLE source_input AS SELECT row_number() OVER(ORDER BY "SortOrder") AS "Ordinal","ChildId" AS "ItemId","ChildType" AS "Type",NULL::bytea AS "Path",NULL::bytea AS "LibraryItemId" FROM "' + schema + '"."LinkedChildren"');
    const handle = await store.createFromSession({ session, parentId: id(900), plan: { text: 'SELECT * FROM source_input ORDER BY "Ordinal"', values: [] } });
    handles.push(handle);
    await session.client.query('DROP TABLE source_input');
    assert.equal(await store.count(handle), 257n);
    const lengths = [];
    for await (const page of store.pages(handle)) lengths.push(page.length);
    assert.deepEqual(lengths, [128,128,1]);
    record('owning-session TEMP publication survives TEMP drop', { pageLengths: lengths });
  });
  const live = handles[0], clone = store.retain(live); handles.push(clone);
  await database.transaction(async session => {
    assert.equal((await session.client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const loaded = await store.load(session, id(900)); handles.push(loaded);
    assert.equal(await store.count(loaded, { session }), 257n);
    await store.recordResolution(loaded, 1n, id(777), { session });
    assert.equal((await store.page(loaded, { session, limit: 1 }))[0].ItemId, id(777));
    record('READ ONLY REPEATABLE READ primary max=1 cold cursor and mutation');
  }, { readOnly: true });

  await store.recordResolution(live, 1n, id(800));
  assert.equal((await store.page(clone, { limit: 1 }))[0].ItemId, id(1));
  await store.recordResolution(clone, 2n, id(801));
  assert.equal((await store.page(live, { limit: 2 }))[1].ItemId, id(2));
  assert.equal((await store.page(clone, { limit: 2 }))[1].ItemId, id(801));
  record('clone immutable revision and divergent branch');

  await assert.rejects(database.transaction(async session => {
    await store.recordResolution(live, 3n, id(802), { session });
    assert.equal((await store.page(live, { session, limit: 3 }))[2].ItemId, id(802));
    throw new Error('intentional save failure');
  }), /intentional save failure/u);
  assert.equal((await store.page(live, { limit: 3 }))[2].ItemId, id(802));
  record('repository rollback preserves live cache prefix');

  const token = await store.pinState(clone, { scopeId: scope, slotId: 'item' });
  await store.release(clone);
  const restored = await store.restoreState(token); handles.push(restored);
  assert.equal((await store.page(restored, { limit: 2 }))[1].ItemId, id(801));
  await store.releaseStateScope(scope); scope = null;
  record('SQL state pin restore and scope release');

  let nativePid, relationPid;
  await database.transaction(async session => {
    nativePid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    relationPid = await store.withSession(async relation => (await relation.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    assert.notEqual(nativePid, relationPid);
    assert.equal(await store.count(live), 257n);
  }, { readOnly: true });
  assert(observations.some(row => row.text.includes(store.rows)));
  record('actual query observer forwards to relation physical connection', { nativePid, relationPid });

  const writerConnection = await store.relationDatabase.pool.connect();
  // A writer owns an explicit checked-out native session so its TEMP cannot
  // enter the independent relation-pool queue.
  writerConnection.release();
  await database.withConnection(async session => {
    writer = await store.createWriter({ session, parentId: id(901) });
    await writer.append({ ItemId: id(1), Type: 0, Path: '\uFEFFpath\u0000tail', LibraryItemId: null });
    let closed = false;
    closePromise = store.close().then(() => { closed = true; });
    assert.throws(() => store.withSession(() => {}), /not active/u);
    const imported = await writer.finish(); handles.push(imported); writer = null;
    assert.equal((await store.page(imported, { session }))[0].Path, '\uFEFFpath\u0000tail');
    assert.equal(closed, false);
    for (const handle of handles) await store.release(handle, { session });
    await store.flushReleases({ session });
    await closePromise;
    assert.equal(closed, true);
    record('drain admits existing writer/read/release, rejects new operations');
  });
} catch (error) {
  checks.push({ name: 'failure', passed: false, error: { name: error.name, message: error.message, stack: error.stack } });

} finally {
  const errors = [];
  if (writer) try { await writer.abort(); } catch (error) { errors.push(error.message); }
  for (const handle of handles) try { await store.release(handle); } catch (error) { errors.push(error.message); }
  if (scope) try { await store.releaseStateScope(scope); } catch (error) { errors.push(error.message); }
  try { await store.flushReleases(); await store.close(); } catch (error) { errors.push(error.message); }
  const resourceAfter = (await database.client.query(`SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1`, [store.schemaName])).rows[0];
  await database.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
  await database.close();
  assert.equal(Number(resourceAfter.count),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(checks.filter(check=>!check.passed),[]);
  assert.equal(checks.length,8);
  assert.equal(Math.max(0,...observations.map(row=>row.rows??0)),128);
}
});
