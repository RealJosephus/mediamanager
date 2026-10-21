import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresLinkedChildrenStore, EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES);
const id = value => value.toString(16).padStart(32, '0');

async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 30000); })]); }
  finally { clearTimeout(timer); }
}

async function runtime(operation) {
  const database = await createPostgresTestDatabase(null, 'handle_operation', { max: 1 });
  const store = new PostgresLinkedChildrenStore({ database }), handles = [], leases = [];
  let failure;
  const lease = handle => { const result = store.admitHandleOperation(handle); leases.push(result); return result; };
  const create = async paths => {
    const handle = await store.createFromPlan({ parentId: id(900), plan: {
      text: `SELECT source.* FROM (VALUES ${paths.map((_, index) => `(${index + 1}::bigint,NULL::bytea,0::integer,$${index + 1}::bytea,NULL::bytea)`).join(',')}
        ) source("Ordinal","ItemId","Type","Path","LibraryItemId") ORDER BY "Ordinal"`,
      values: paths.map(nativeTextBytes),
    } });
    handles.push(handle); return handle;
  };
  const countSets = () => store.withSession(async session => Number((await session.client.query(`SELECT count(*) AS count FROM ${store.sets}`)).rows[0].count));
  try {
    await store.initialize();
    return await operation({ database, store, lease, create, countSets,
      retain(handle) { const result = store.retain(handle); handles.push(result); return result; } });
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [], attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
    for (const operation of leases) await attempt(() => operation.release());
    for (const handle of handles) await attempt(() => store.release(handle));
    await attempt(() => store.flushReleases());
    await attempt(() => within(store.close(), 'SQL link owner close'));
    await attempt(async () => assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1', [store.schemaName])).rows[0].count), 0));
    await attempt(() => dropPostgresTestDatabase(database));
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
      failure?.message ?? 'Handle operation owners failed to close.', failure ? { cause: failure } : undefined);
  }
}

test('exact handle operation survives owner replacement and preserves the old branch mutation prefix', {
  skip: !enabled, timeout: 90000,
}, async () => runtime(async ({ store, lease, create, retain, countSets }) => {
  const original = await create(['old first', 'old second']), snapshot = retain(original);
  const entry = original.entry, references = entry.references, operation = lease(original);
  assert.equal(operation.handle, original);
  assert.equal(entry.references, references, 'An operation adds no immutable retain branch.');
  const raw = store.plan(operation.handle);

  // The old array was captured before the owner assigns another array. Its
  // setter requests old ownership release while the same operation is asleep.
  let current = original;
  current = await create(['new first', 'new second']);
  store.queueRelease(original); store.queueRelease(original); await store.release(original);
  assert.equal(original.released, false); assert.equal(entry.references, references);
  await store.flushReleases(); assert.equal(await countSets(), 2);
  assert.deepEqual((await store.page(operation.handle)).map(row => row.Path), ['old first', 'old second']);

  const expected = new Error('Controlled later resolution failure.');
  await assert.rejects((async () => {
    await store.recordResolution(operation.handle, 1n, id(71));
    throw expected;
  })(), error => error === expected);
  assert.equal(original.entry, entry, 'No competing branch advanced this set.');
  assert.equal(original.revision, 1n);
  assert.deepEqual((await store.page(operation.handle)).map(row => row.ItemId), [id(71), null]);
  assert.deepEqual((await store.page(current)).map(row => row.ItemId), [null, null]);
  assert.deepEqual((await store.page(snapshot)).map(row => row.ItemId), [null, null], 'A retained snapshot has different semantics from this operation.');
  await store.withSession(async session => {
    const rows = (await session.client.query({ text: raw.text, values: raw.values })).rows;
    assert.equal(rows.length, 2); assert.equal(rows[0].ItemId, null);
  });

  const releasing = operation.release(); assert.equal(operation.release(), releasing); await releasing;
  assert.equal(original.released, true); assert.equal(entry.references, references - 1);
  assert.throws(() => store.plan(original), /live handle/u);
  assert.throws(() => lease(original), /live handle/u);
  await store.release(original); store.queueRelease(original);
  assert.equal(entry.references, references - 1, 'Base owner double release does not consume a retained view.');
  await store.release(snapshot); await store.flushReleases(); assert.equal(await countSets(), 1);
  assert.deepEqual((await store.page(current)).map(row => row.Path), ['new first', 'new second']);
  await store.release(current); assert.equal(await countSets(), 0);
}));

test('deferred exact ownership follows a real COW fork without consuming the competing retained branch', {
  skip: !enabled, timeout: 90000,
}, async () => runtime(async ({ store, lease, create, retain, countSets }) => {
  const handle = await create(['first', 'second']), competing = retain(handle), originalEntry = handle.entry;
  const operation = lease(handle); store.queueRelease(handle);
  await store.recordResolution(competing, 1n, id(74));
  await store.recordResolution(operation.handle, 2n, id(75));
  assert.equal(operation.handle, handle); assert.notEqual(handle.entry, originalEntry);
  assert.equal(handle.entry.references, 1); assert.equal(originalEntry.references, 1);
  assert.deepEqual((await store.page(handle)).map(row => row.ItemId), [null, id(75)]);
  assert.deepEqual((await store.page(competing)).map(row => row.ItemId), [id(74), null]);
  await operation.release(); assert.equal(handle.released, true); assert.equal(handle.entry.references, 0);
  assert.equal(competing.released, false); assert.equal(originalEntry.references, 1); assert.equal(await countSets(), 1);
  await store.release(competing); assert.equal(await countSets(), 0);
}));

test('nested exact operation tokens drain before runtime close and cannot consume each other', {
  skip: !enabled, timeout: 90000,
}, async () => runtime(async ({ database, store, lease, create }) => {
  const handle = await create(['first', 'second']), outer = lease(handle), inner = lease(handle), entry = handle.entry;
  assert.equal(outer.handle, inner.handle); assert.equal(entry.references, 1);
  store.queueRelease(handle); await store.release(handle); store.queueRelease(handle);
  let closed = false;
  const closing = store.close().then(() => { closed = true; }); void closing.catch(() => {});
  assert.throws(() => lease(handle), /not active/u);
  assert.throws(() => lease(EMPTY_NATIVE_LINKS), /not active/u);
  assert.throws(() => lease(null), /not active/u);
  await inner.release(); await inner.release();
  assert.equal(handle.released, false); assert.equal(entry.references, 1);
  await store.recordResolution(outer.handle, 2n, id(72));
  assert.deepEqual((await store.page(outer.handle)).map(row => row.ItemId), [null, id(72)]);
  assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1', [store.schemaName])).rows[0].count), 1);
  assert.equal(closed, false, 'Schema and pool remain owned until the last exact operation finishes.');
  await outer.release(); await within(closing, 'nested handle drain');
  assert.equal(handle.released, true); assert.equal(entry.references, 0); assert.equal(closed, true);
}));

test('sentinel operations preserve null/empty semantics and deferred release avoids an aborted primary transaction', {
  skip: !enabled, timeout: 90000,
}, async () => runtime(async ({ database, store, lease, create, countSets }) => {
  const empty = lease(EMPTY_NATIVE_LINKS), absent = lease(null);
  assert.equal(empty.handle, EMPTY_NATIVE_LINKS); assert.equal(absent.handle, null);
  assert.equal(await store.count(empty.handle), 0n);
  assert.throws(() => store.plan(absent.handle), { nativeException: 'NullReferenceException', status: 500 });
  assert.throws(() => lease(undefined), /live handle/u);
  store.queueRelease(null); store.queueRelease(EMPTY_NATIVE_LINKS);
  await store.release(null); await store.release(EMPTY_NATIVE_LINKS);
  await empty.release(); await empty.release(); await absent.release(); assert.equal(await countSets(), 0);

  const handle = await create(['rollback first']), operation = lease(handle);
  await assert.rejects(database.transaction(async session => {
    let original;
    try { await session.client.query('SELECT 1/0'); } catch (error) { original = error; }
    assert.equal(original?.code, '22012');
    await assert.rejects(session.client.query('SELECT 1'), { code: '25P02' });
    await store.release(handle, { session }); await store.release(handle, { session });
    assert.equal(handle.released, false); assert.equal(handle.entry.references, 1);
    await store.recordResolution(operation.handle, 1n, id(73), { session });
    assert.equal((await store.page(operation.handle, { session }))[0].ItemId, id(73));
    await operation.release();
    assert.equal(handle.released, true); assert.equal(handle.entry.references, 0);
    throw original;
  }), { code: '22012' });
  assert.equal(await countSets(), 0, 'The last token collected on the independent relation session.');

  const plain = await create(['ordinary owner']);
  await assert.rejects(database.transaction(async session => {
    let original;
    try { await session.client.query('SELECT 1/0'); } catch (error) { original = error; }
    await store.release(plain, { session });
    throw original;
  }), { code: '22012' });
  assert.equal(plain.released, true); assert.equal(await countSets(), 0);
}));
