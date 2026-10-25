import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, cloneNativeItemEntity, publishNativeItemLinks, acquireNativeItemLinkOwner,
  acquireNativeItemLinkBranch, captureNativeItemState, restoreNativeItemState, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { cloneNativeItemValue } from '../../src/library/native-item-value.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

import test from 'node:test';
test('postgres: cold empty links preserve loaded aliases, clone snapshots and later mutable branches with max1', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'empty_link_snapshot', { max: 1 });
  const store = new PostgresLinkedChildrenStore({ database }), owners = [], entities = [], retained = [];
  let closed = false;
  const releaseOwners = async () => {
    for (const owner of owners.splice(0).reverse()) owner.release();
    for (const entity of entities) releaseNativeItemLinks(entity);
    for (const handle of retained.splice(0)) await store.release(handle);
    await store.flushOwnedReleases(); await store.flushReleases(); await store.resourceGraph.flush();
  };
  t.after(async () => {
    const failures = [];
    try { if (!closed) { await releaseOwners(); await store.close(); } } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Cold empty link test cleanup failed.');
  });
  await store.initialize();
  const own = entity => { entities.push(entity); owners.push(acquireNativeItemLinkOwner(entity)); return entity; };
  const rows = async handle => {
    const result = []; for await (const page of store.pages(handle)) result.push(...page); return result;
  };
  const parentId = 'ef620000-0000-0000-0000-000000000001', childId = 'ef620000-0000-0000-0000-000000000002';
  const changedId = 'ef620000-0000-0000-0000-000000000003';
  const folderType = 'MediaBrowser.Controller.Entities.Folder';
  for (const [Id, Type] of [[parentId, folderType], [childId, 'MediaBrowser.Controller.Entities.Movies.Movie']]) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type, Data: '{}', Name: 'Stored row',
      DateCreated: '2026-10-25 00:00:00', DateModified: '2026-10-25 00:00:00' }));
  }
  const before = await database.rows('BaseItems');
  const originalMetadata = { Name: 'Empty snapshot', Overview: 'Original draft', Tags: ['before'],
    Data: { Future: { text: 'retained', nullable: null, values: ['one', 'two'] } } };
  const metadata = item => ({ Name: item.Name, Overview: item.Overview, Tags: [...item.Tags], Data: cloneNativeItemValue(item.Data) });
  const item = own(Object.assign(newNativeItemEntity(folderType), { Id: parentId, ...cloneNativeItemValue(originalMetadata) }));
  const originalOwner = owners[0];
  assert.equal(item.LinkedChildrenLoaded, false);
  let held, restored;
  await database.transaction(async session => {
    publishNativeItemLinks(item, await store.load(session, parentId));
    assert.equal(item.LinkedChildrenLoaded, true); assert.equal(await store.count(item.LinkedChildren, { session }), 0n);
    assert.deepEqual(await rows(item.LinkedChildren), []);
    held = store.retain(item.LinkedChildren); retained.push(held);
    const saved = deserialize(serialize(cloneNativeItemValue(await captureNativeItemState(item, {
      linkedChildren: store, session, scopeId: randomUUID(), slotId: 'empty'
    }))));
    restored = own(await restoreNativeItemState(saved, {}, { linkedChildren: store, session }));
    assert.equal(restored.LinkedChildrenLoaded, true); assert.deepEqual(await rows(restored.LinkedChildren), []);
    assert.deepEqual(metadata(restored), originalMetadata);
    assert.deepEqual((await session.client.query('SELECT name FROM pg_cursors')).rows, [], 'The successful empty source cursor must close.');
  }, { readOnly: true });
  const clone = own(cloneNativeItemEntity(item));
  assert.equal(clone.LinkedChildrenLoaded, true);
  const aliases = new Map([['live', item]]), alias = aliases.get('live');
  alias.Overview = 'Unsaved alias change'; alias.Tags.push('changed'); alias.Data.Future.text = 'unsaved nested value';
  assert.deepEqual(metadata(item), { ...originalMetadata, Overview: 'Unsaved alias change', Tags: ['before', 'changed'],
    Data: { Future: { ...originalMetadata.Data.Future, text: 'unsaved nested value' } } });
  for (const snapshot of [clone, restored]) {
    assert.deepEqual(metadata(snapshot), originalMetadata); assert.deepEqual(await rows(snapshot.LinkedChildren), []);
  }
  const branch = acquireNativeItemLinkBranch(item); owners.push(branch);
  const manual = [
    { Ordinal: 1n, ItemId: childId, Type: 0, Path: null, LibraryItemId: null },
    { Ordinal: 2n, ItemId: childId, Type: 0, Path: '', LibraryItemId: null },
    { Ordinal: 3n, ItemId: null, Type: 0, Path: '/unresolved/sidecar', LibraryItemId: childId },
  ];
  publishNativeItemLinks(alias, await store.withSession(async session => {
    const writer = await store.createWriter({ session, parentId });
    try { for (const value of manual) await writer.append(value); return await writer.finish(); }
    catch (error) { await writer.abort(); throw error; }
  }));
  originalOwner.release(); await store.resourceGraph.collect();
  assert.equal(item.LinkedChildrenLoaded, true); assert.deepEqual(await rows(item.LinkedChildren), manual);
  assert.deepEqual(await rows(held), [], 'An already-held empty value must stay empty after a live replacement.');
  const fork = own(cloneNativeItemEntity(item));
  await store.recordResolution(item.LinkedChildren, 1n, changedId);
  assert.deepEqual(await rows(item.LinkedChildren), manual.map((value, index) => index ? value : { ...value, ItemId: changedId }));
  assert.deepEqual(await rows(fork.LinkedChildren), manual, 'A nonempty clone must retain its captured immutable revision.');
  for (const snapshot of [clone, restored]) assert.deepEqual(await rows(snapshot.LinkedChildren), []);
  const nullItem = own(newNativeItemEntity(folderType)); nullItem.LinkedChildren = null;
  assert.equal(nullItem.LinkedChildrenLoaded, true);
  await assert.rejects(store.count(nullItem.LinkedChildren), { status: 500 });
  assert.throws(() => store.retain(nullItem.LinkedChildren));
  await assert.rejects(database.transaction(session => store.createFromSnapshot({ session, parentId, plan: {
    text: 'SELECT * FROM missing_empty_link_source_' + randomUUID().replaceAll('-', ''), values: []
  } }), { readOnly: true }), error => {
    t.diagnostic(JSON.stringify({ sourceSqlFailure: { ...error, message: error.message, stack: error.stack } }));
    assert.equal(error.code, '42P01'); return true;
  });
  const cancellation = new AbortController(), reason = Object.assign(new Error('Controlled empty snapshot cancellation.'), { code: 'empty-snapshot-stop' });
  cancellation.abort(reason); let admitted = false;
  await assert.rejects(database.transaction(session => { admitted = true; return store.load(session, parentId); },
    { readOnly: true, signal: cancellation.signal }), error => {
    assert.deepEqual({ message: error.message, code: error.code }, { message: reason.message, code: reason.code }); return true;
  });
  assert.equal(admitted, false);
  const after = await database.rows('BaseItems'), persistedLinks = await database.rows('LinkedChildren');
  assert.deepEqual(after, before);
  assert.deepEqual(persistedLinks, [], 'All live edits remain unsaved.');
  t.diagnostic(JSON.stringify({ emptyColdLinks: await rows(held), loaded: item.LinkedChildrenLoaded,
    liveMetadata: metadata(item), cloneMetadata: metadata(clone), restoredMetadata: metadata(restored),
    liveLinks: await rows(item.LinkedChildren), capturedNonemptyLinks: await rows(fork.LinkedChildren),
    before, after, persistedLinks }, (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value));
  await releaseOwners();
  await store.withSession(async session => {
    for (const table of ['sets', 'rows', 'pins', 'item_states', 'item_cohorts', 'folder_child_ids']) {
      assert.equal(BigInt((await session.client.query('SELECT count(*) AS count FROM "' + store.schemaName + '".' + table)).rows[0].count), 0n, table);
    }
    for (const table of Object.values(store.resourceGraph.tables)) {
      assert.equal(BigInt((await session.client.query('SELECT count(*) AS count FROM ' + table)).rows[0].count), 0n, table);
    }
  });
  await store.close(); closed = true;
  assert.deepEqual((await database.client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [store.schemaName])).rows, []);
  assert.throws(() => store.retain(held), 'Retaining an empty value must still reject a closed runtime.');
});

test('postgres: raw links own an independent max1 pool across readOnly, TEMP, rollback and drain', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async()=>{
const schema = 'source_relations_' + randomUUID().replaceAll('-', '').slice(0,20);
const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, max: 1, schema, create:true });
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
