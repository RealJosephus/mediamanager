import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { EMPTY_NATIVE_LINKS, PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, cloneNativeItemEntity, publishNativeItemLinks, acquireNativeItemLinkOwner,
  acquireNativeItemLinkBranch, captureNativeItemState, restoreNativeItemState, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { cloneNativeItemValue } from '../../src/library/native-item-value.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

import test from 'node:test';
test('postgres: loaded empty link replacement clears only its parent and preserves caller rollback', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'empty_link_save', { max: 1 });
  const store = new PostgresLinkedChildrenStore({ database });
  const folderType = 'MediaBrowser.Controller.Entities.Folder';
  const item = newNativeItemEntity(folderType), owner = acquireNativeItemLinkOwner(item);
  t.after(async () => {
    const failures = [];
    for (const operation of [() => owner.release(), () => releaseNativeItemLinks(item),
      () => store.flushOwnedReleases(), () => store.close(), () => dropPostgresTestDatabase(database)]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Empty link replacement cleanup failed.');
  });
  await store.initialize();
  const parentId = 'ef630000-0000-0000-0000-000000000001';
  const otherParentId = 'ef630000-0000-0000-0000-000000000002';
  const childId = 'ef630000-0000-0000-0000-000000000003';
  for (const Id of [parentId, otherParentId, childId]) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: folderType, Data: '{}', Name: Id }));
  }
  Object.assign(item, { Id: parentId, Name: 'Empty link replacement' });
  const target = { ParentId: parentId, SortOrder: 0, ChildId: childId, ChildType: 0 };
  const other = { ...target, ParentId: otherParentId };
  await database.insert('LinkedChildren', target);
  await database.insert('LinkedChildren', other);
  const rows = async session => (await session.rows('LinkedChildren')).sort((a, b) => a.ParentId.localeCompare(b.ParentId));
  const before = await rows(database);
  assert.equal(item.LinkedChildrenLoaded, false);
  await database.transaction(session => store.persist(session, item));
  assert.deepEqual(await rows(database), before, 'An unloaded property must not clear persisted members.');
  item.LinkedChildren = null;
  await assert.rejects(database.transaction(session => store.persist(session, item)), { status: 500 });
  assert.deepEqual(await rows(database), before, 'A null sequence rejects before changing persisted members.');
  for (const kind of ['sentinel', 'owned-empty-revision']) {
    const empty = kind === 'sentinel' ? EMPTY_NATIVE_LINKS
      : await store.createFromPlan({ parentId, plan: store.plan(EMPTY_NATIVE_LINKS) });
    publishNativeItemLinks(item, empty);
    assert.equal(item.LinkedChildrenLoaded, true);
    const rollback = new Error('Rollback empty replacement ' + kind);
    await assert.rejects(database.transaction(async session => {
      await store.persist(session, item);
      assert.deepEqual(await rows(session), [other]);
      throw rollback;
    }), error => error === rollback);
    assert.deepEqual(await rows(database), before, kind + ': caller rollback restores the original members.');
    await database.transaction(session => store.persist(session, item));
    assert.deepEqual(await rows(database), [other], kind + ': committed empty replacement preserves the other parent.');
    await database.insert('LinkedChildren', target);
  }
});

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
  const releasedSqlRows = {};
  try {
    await store.withSession(async session => {
      for (const table of ['sets', 'rows', 'pins', 'item_states', 'item_cohorts', 'folder_child_ids']) {
        releasedSqlRows[table] = String((await session.client.query('SELECT count(*) AS count FROM "' + store.schemaName + '".' + table)).rows[0].count);
      }
    });
  } catch (reason) { releasedSqlRows.observationFailure = { reasonType: typeof reason, message: reason?.message, code: reason?.code }; }
  t.diagnostic(JSON.stringify({ diagnosticOnly: true, releasedSqlRows }));
  await store.close(); closed = true;
  assert.deepEqual((await database.client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [store.schemaName])).rows, []);
  assert.throws(() => store.retain(held), 'Retaining an empty value must still reject a closed runtime.');
});

test('postgres: raw links remain consumable across max1 readOnly, TEMP, rollback and drain', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async t=>{
const schema = 'source_relations_' + randomUUID().replaceAll('-', '').slice(0,20);
const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, max: 1, schema, create:true });
const pool=database.pool;
const store = new PostgresLinkedChildrenStore({ database });
const auditor = new PostgresDatabase(new pg.Pool({ ...pool.options, max: 1 }), schema);
const checks = [], handles = [], observations = [];
const id = n => n.toString(16).padStart(32, '0');
let writer, scope = randomUUID(), closePromise, primary, primaryFailed = false, nativePid, relationPid;
const releaseEntered = Promise.withResolvers(), resumeRelease = Promise.withResolvers();
let holdRelease = false, releasing, releaseObserved = false;
const record = (name, detail = {}) => checks.push({ name, passed: true, ...detail });
const originalQuery = database.client.query;
database.client.query = async function (...args) {
  const text = typeof args[0] === 'string' ? args[0] : args[0].text;
  if (holdRelease && text.startsWith(`DELETE FROM ${store.sets} source`)) {
    holdRelease = false; releaseEntered.resolve();
    await resumeRelease.promise;
  }
  const result = await originalQuery(...args);
  observations.push({ text, rows: result?.rows?.length ?? null });
  return result;
};
try {
  await database.transaction(async session=>{for(const value of [...Array.from({length:257},(_,i)=>i+1),900])await session.insert('BaseItems',postgresTestRow('BaseItems',{Id:id(value),Type:'MediaBrowser.Controller.Entities.Movies.Movie',Data:'{}',Name:'member '+value,DateCreated:'2026-10-14 00:00:00',DateModified:'2026-10-14 00:00:00'}));});
  await database.client.query({ text: `INSERT INTO "${schema}"."LinkedChildren" SELECT $1,number-1,convert_to(lpad(to_hex(number),32,'0'),'UTF8'),0 FROM generate_series(1,257) number`, values: [nativeTextBytes(id(900))] });
  await store.initialize();
  record('relation pool observation', { max: store.relationDatabase.pool.options.max, sameAsPrimaryPool: store.relationDatabase.pool === pool });

  await database.withConnection(async session => {
    await session.client.query('CREATE TEMP TABLE source_input AS SELECT row_number() OVER(ORDER BY "SortOrder") AS "Ordinal","ChildId" AS "ItemId","ChildType" AS "Type",NULL::bytea AS "Path",NULL::bytea AS "LibraryItemId" FROM "' + schema + '"."LinkedChildren"');
    const handle = await store.createFromSession({ session, parentId: id(900), plan: { text: 'SELECT * FROM source_input ORDER BY "Ordinal"', values: [] } });
    handles.push(handle);
    await session.client.query('DROP TABLE source_input');
    assert.equal(await store.count(handle), 257n);
    const lengths = [], members = [];
    for await (const page of store.pages(handle)) {
      lengths.push(page.length);
      members.push(...page.map(row => ({ Ordinal: String(row.Ordinal), ItemId: row.ItemId, Type: row.Type, Path: row.Path, LibraryItemId: row.LibraryItemId })));
    }
    assert.deepEqual(lengths, [128,128,1]);
    assert.deepEqual(members, Array.from({ length: 257 }, (_value, index) => ({ Ordinal: String(index + 1),
      ItemId: id(index + 1), Type: 0, Path: null, LibraryItemId: null })));
    record('owning-session TEMP publication survives TEMP drop', { pageLengths: lengths, members });
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

  await database.transaction(async session => {
    nativePid = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    relationPid = await store.withSession(async relation => (await relation.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    assert.equal(await store.count(live), 257n);
  }, { readOnly: true });
  record('actual max1 primary and relation reads completed', { nativePid, relationPid,
    observedRelationQuery: observations.some(row => row.text.includes(store.rows)) });

  const writerConnection = await store.relationDatabase.pool.connect();
  // A writer owns an explicit checked-out native session so its TEMP cannot
  // enter the independent relation-pool queue.
  writerConnection.release();
  await database.withConnection(async session => {
    writer = await store.createWriter({ session, parentId: id(901) });
    await writer.append({ ItemId: id(1), Type: 0, Path: '\uFEFFpath\u0000tail', LibraryItemId: null });
    let closed = false;
    closePromise = store.close().then(() => { closed = true; });
    closePromise.catch(() => {}); // The original promise is awaited below and during failure cleanup.
    assert.throws(() => store.withSession(() => {}), /not active/u);
    const imported = await writer.finish(); handles.push(imported); writer = null;
    assert.equal((await store.page(imported, { session }))[0].Path, '\uFEFFpath\u0000tail');
    assert.equal(closed, false);
    const importedPlan = store.plan(imported), importedRows = (await session.client.query(importedPlan)).rows;
    for (const handle of handles) if (handle !== imported) await store.release(handle, { session });
    holdRelease = true;
    releasing = store.release(imported, { session });
    try {
      await Promise.race([releaseEntered.promise, releasing.then(() => {
        throw new Error('The final link release completed before its held SQL cleanup.');
      })]);
    } catch (error) { releaseObserved = true; throw error; }
    const schemaPresent = (await auditor.client.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present', [store.schemaName])).rows[0].present;
    assert.equal(schemaPresent, true, 'Shutdown must retain the schema until the admitted final DELETE completes.');
    const heldRows = (await auditor.client.query(importedPlan)).rows;
    assert.deepEqual(heldRows, importedRows, 'The real published bytes must remain readable while their final cleanup is held.');
    assert.equal(closed, false, 'Shutdown must wait for the final release after its reference reaches zero.');
    record('independent SQL reader observes held final release before shutdown', { schemaPresent,
      members: heldRows.map(row => ({ ...row, ItemId: row.ItemId?.toString('hex'), Path: row.Path?.toString('hex'),
        LibraryItemId: row.LibraryItemId?.toString('hex') })) });
    resumeRelease.resolve();
    try { await releasing; } finally { releaseObserved = true; }
    await store.flushReleases({ session });
    await closePromise;
    assert.equal(closed, true);
    record('drain admits existing writer/read/release, rejects new operations');
  });
} catch (error) {
  primary = error; primaryFailed = true;
  checks.push({ name: 'failure', passed: false, error: { reasonType: typeof error, name: error?.name, message: error?.message, code: error?.code, stack: error?.stack } });

} finally {
  const errors = [];
  holdRelease = false; resumeRelease.resolve();
  if (releasing && !releaseObserved) try { await releasing; } catch (error) { errors.push(error); }
  if (writer) try { await writer.abort(); } catch (error) { errors.push(error); }
  for (const handle of handles) try { await store.release(handle); } catch (error) { errors.push(error); }
  if (scope) try { await store.releaseStateScope(scope); } catch (error) { errors.push(error); }
  for (const action of [() => store.flushReleases(), () => store.close()]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  let resourceAfter;
  try { resourceAfter = (await database.client.query(`SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1`, [store.schemaName])).rows[0]; }
  catch (error) { errors.push(error); }
  try { await database.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`); }
  catch (error) { errors.push(error); }
  try { await database.close(); } catch (error) { errors.push(error); }
  try { await auditor.close(); } catch (error) { errors.push(error); }
  try { t.diagnostic(JSON.stringify({ diagnosticOnly: true, checks, checkRecords: checks.length,
    maximumObservedSqlRows: Math.max(0, ...observations.map(row => row.rows ?? 0)) })); }
  catch { /* Preserve the actual consumer and cleanup failures. */ }
  if (primaryFailed && !errors.length) throw primary;
  if (!primaryFailed && errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(primaryFailed ? [primary, ...errors] : errors,
    primary?.message ?? 'Raw link fixture cleanup failed.', { cause: primaryFailed ? primary : errors[0] });
  assert.equal(Number(resourceAfter.count),0);
  assert.ok(observations.every(row => row.rows == null || row.rows <= 128), 'Actual SQL result pages must remain bounded.');
}
});

test('postgres: shutdown drains a late explicit retry after its internal link cleanup completes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000,
}, async t => {
  const database = await createPostgresTestDatabase(null, 'pending_link_release', { max: 1 });
  const store = new PostgresLinkedChildrenStore({ database });
  const auditor = new PostgresDatabase(new pg.Pool({ ...database.pool.options, max: 1 }), database.schemaName);
  const originalQuery = database.client.query, originalFlush = store.flushReleases;
  const internalEntered = Promise.withResolvers(), allowInternal = Promise.withResolvers();
  const explicitEntered = Promise.withResolvers(), allowExplicit = Promise.withResolvers();
  const internalFlushed = Promise.withResolvers();
  const releaseFailure = false, flushFailure = 0;
  let writer, handle, closing, explicitFlush, closed = false, closeObserved = false, explicitObserved = false;
  let mode = null, captureInternalFlush = false, failed = false, primary;
  const observed = { releaseFailure, flushFailure };
  database.client.query = async function (...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (text.startsWith(`DELETE FROM ${store.sets} source`)) {
      if (mode === 'release') { mode = null; throw releaseFailure; }
      if (mode === 'internal') {
        mode = 'explicit'; internalEntered.resolve(); await allowInternal.promise;
      } else if (mode === 'explicit') {
        mode = null; explicitEntered.resolve(); await allowExplicit.promise;
        await originalQuery(...args); throw flushFailure;
      }
    }
    return originalQuery(...args);
  };
  store.flushReleases = function (options) {
    const capture = captureInternalFlush && options?.session == null;
    if (capture) captureInternalFlush = false;
    const actual = originalFlush.call(this, options);
    if (capture) actual.then(() => internalFlushed.resolve({ passed: true }),
      reason => internalFlushed.resolve({ passed: false, reason }));
    return actual;
  };
  try {
    await store.flushReleases(); // An empty flush remains a no-op before initialization.
    await store.initialize();
    handle = await store.withSession(async session => {
      writer = await store.createWriter({ session, parentId: 'ef630000000000000000000000000001' });
      await writer.append({ ItemId: null, Type: 0, Path: '\uFEFFretry\u0000raw', LibraryItemId: null });
      const result = await writer.finish(); writer = null; return result;
    });
    const plan = store.plan(handle), before = (await auditor.client.query(plan)).rows;
    assert.deepEqual(await store.page(handle), [{ Ordinal: 1n, ItemId: null, Type: 0,
      Path: '\uFEFFretry\u0000raw', LibraryItemId: null }]);
    mode = 'release';
    await assert.rejects(store.release(handle), reason => { assert.equal(reason, releaseFailure); return true; });
    assert.deepEqual((await auditor.client.query(plan)).rows, before, 'The failed DELETE must leave the actual published bytes for retry.');
    await database.withConnection(async session => {
      mode = 'internal'; captureInternalFlush = true;
      closing = store.close(); closing.then(() => { closed = true; }, () => {});
      assert.equal(store.close(), closing, 'Repeated close must await the same real owner.');
      try {
        await Promise.race([internalEntered.promise, closing.then(() => {
          throw new Error('Shutdown completed before its pending SQL cleanup entered.');
        })]);
      } catch (reason) { closeObserved = true; throw reason; }
      // The close operation has already passed its initial admission drain.
      // Retry on the primary session while its own relation-pool DELETE waits.
      explicitFlush = store.flushReleases({ session });
      try {
        await Promise.race([explicitEntered.promise, explicitFlush.then(() => {
          throw new Error('The explicit cleanup completed before its held DELETE.');
        })]);
      } catch (reason) { explicitObserved = true; throw reason; }
      assert.deepEqual((await auditor.client.query(plan)).rows, before);
      allowInternal.resolve();
      const internal = await internalFlushed.promise;
      if (!internal.passed) throw internal.reason;
      observed.internalFlushCompleted = true;
      const present = (await auditor.client.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present', [store.schemaName])).rows[0].present;
      assert.equal(present, true, 'The completed internal flush cannot let shutdown drop an admitted explicit cleanup.');
      assert.deepEqual((await auditor.client.query(plan)).rows, [], 'The independent relation owner must have completed its real DELETE.');
      assert.equal(closed, false, 'The final drain must still wait for the late explicit DELETE.');
      observed.schemaRetainedDuringExplicitFlush = present;
      allowExplicit.resolve();
      try {
        await assert.rejects(explicitFlush, reason => {
          assert.ok(reason instanceof AggregateError); assert.deepEqual(reason.errors, [flushFailure]); return true;
        });
      } finally { explicitObserved = true; }
      try { await closing; } finally { closeObserved = true; }
      assert.equal(closed, true);
      assert.equal((await auditor.client.query('SELECT to_regnamespace($1) AS namespace', [store.schemaName])).rows[0].namespace, null);
      await store.flushReleases(); // Empty cleanup remains harmless after the real shutdown.
      assert.equal((await session.client.query('SELECT 1 AS usable')).rows[0].usable, 1);
      observed.normalCloseCompleted = true;
    });
  } catch (reason) { failed = true; primary = reason; }
  finally {
    const failures = [];
    mode = null; captureInternalFlush = false; allowInternal.resolve(); allowExplicit.resolve();
    if (explicitFlush && !explicitObserved) try { await explicitFlush; } catch (reason) { failures.push(reason); }
    if (writer) try { await writer.abort(); } catch (reason) { failures.push(reason); }
    if (handle) try { await store.release(handle); } catch (reason) { failures.push(reason); }
    try { await store.flushReleases(); } catch (reason) { failures.push(reason); }
    try { await (closing ?? store.close()); } catch (reason) { if (!closeObserved) failures.push(reason); }
    database.client.query = originalQuery; store.flushReleases = originalFlush;
    try { await auditor.close(); observed.auditorClosed = true; } catch (reason) { failures.push(reason); }
    try { await dropPostgresTestDatabase(database); observed.databaseClosed = true; } catch (reason) { failures.push(reason); }
    try { t.diagnostic(JSON.stringify({ diagnosticOnly: true, pendingReleaseDrain: observed })); }
    catch { /* Diagnostic output cannot replace the consumer or cleanup failures. */ }
    if (failed && !failures.length) throw primary;
    if (!failed && failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures,
      'Pending link cleanup fixture failed.', { cause: failed ? primary : failures[0] });
  }
});
