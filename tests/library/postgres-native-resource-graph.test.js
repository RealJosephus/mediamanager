import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresNativeResourceGraph } from '../../src/library/postgres-native-resource-graph.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !postgresTestConnectionString, timeout: 60000 };

async function deadline(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The native resource graph did not drain.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

async function setup(t, { relationMax } = {}) {
  const database = await createPostgresTestDatabase(null, 'resource_graph', { max: 1 });
  const leases = [];
  let relationDatabase, linkedChildren, graph, expectedCloseError;
  t.after(async () => {
    const errors = [];
    for (const lease of leases) try { lease.release(); } catch (error) { errors.push(error); }
    try { await deadline(graph?.close()); }
    catch (error) { if (!expectedCloseError?.(error)) errors.push(error); }
    for (const action of [() => linkedChildren?.flushOwnedReleases(), () => linkedChildren?.close(),
      () => relationDatabase?.close(),
      () => dropPostgresTestDatabase(database)]) {
      try { await deadline(Promise.resolve().then(action)); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Native resource graph fixture cleanup failed.');
  });
  if (relationMax != null) relationDatabase = await PostgresDatabase.open({
    connectionString: postgresTestConnectionString, schema: database.schemaName, max: relationMax,
  });
  linkedChildren = new PostgresLinkedChildrenStore({ database, relationDatabase });
  await linkedChildren.initialize();
  graph = await createPostgresNativeResourceGraph({ linkedChildren });
  return { database, linkedChildren, relationDatabase: linkedChildren.relationDatabase, graph,
    own: lease => { leases.push(lease); return lease; },
    expectCloseError: predicate => { expectedCloseError = predicate; } };
}

for (const self of [false, true]) test(`postgres: SQL reachability drains a ${self ? 'self' : 'mutual'} cache cycle after its external owner leaves`, options, async t => {
  const { graph, linkedChildren, own } = await setup(t), events = [];
  const first = graph.entity({ Id: 'same-native-guid' }), second = self ? first : graph.entity({ Id: 'same-native-guid' });
  if (!self) assert.notEqual(first.id, second.id, 'A native Guid cannot merge two exact object branches.');
  const root = own(first.retain()), construction = self ? null : own(second.retain()), edges = [];
  const resources = [];
  for (const [index, entity] of (self ? [first] : [first, second]).entries()) {
    resources.push(await graph.bind(entity, { detach() { events.push('detach:' + index); }, async release() {
      // This must run outside the graph's mark connection, including max=1.
      await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
      edges[index]?.release(); events.push('release:' + index);
    } }));
  }
  edges.push(own(resources[0].link(second)));
  if (!self) edges.push(own(resources[1].link(first)));
  construction?.release();
  await graph.collect(); assert.deepEqual(events, [], 'An external owner preserves every internally reachable cache.');
  root.release(); await graph.collect();
  assert.deepEqual(events.filter(value => value.startsWith('release:')).sort(), self ? ['release:0'] : ['release:0', 'release:1']);
  await deadline(graph.close());
});

test('postgres: admitted views preserve an unbound cache and its children through replacement and graph shutdown', options, async t => {
  const { graph, own } = await setup(t), released = [];
  const parent = graph.entity({}), child = graph.entity({}), owner = own(parent.retain());
  const old = await graph.bind(parent, { detach() {}, release() { released.push('old'); } });
  own(old.link(child));
  const member = await graph.bind(child, { detach() {}, release() { released.push('child'); } });
  const view = own(old.retain()); old.unbind();
  await graph.bind(parent, { detach() {}, release() { released.push('replacement'); } });
  await graph.collect(); assert.deepEqual(released, []);
  owner.release(); await graph.collect();
  assert.deepEqual(released, ['replacement']);
  let closed = false;
  const closing = graph.close(); closing.then(() => { closed = true; }, () => {});
  await graph.flush(); assert.equal(closed, false);
  assert.throws(() => graph.entity({}), /not accepting new owners/u);
  const nested = own(view.retain());
  view.release(); await graph.flush(); assert.equal(closed, false);
  assert.deepEqual(released, ['replacement']);
  nested.release(); await deadline(closing);
  assert.deepEqual(released.slice().sort(), ['child', 'old', 'replacement']);
  assert.throws(() => member.retain(), /not accepting new owners|retired/u);
});

test('postgres: an admitted old view can build internally owned child resources during shutdown', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), released = [];
  const parent = graph.entity({}), owner = own(parent.retain());
  let edge;
  const old = await graph.bind(parent, { detach() {}, release() { edge?.release(); released.push('old'); } });
  const view = own(old.retain()); old.unbind(); owner.release();
  let closed = false;
  const closing = graph.close(); closing.then(() => { closed = true; }, () => {});
  await graph.flush(); assert.equal(closed, false);
  assert.throws(() => graph.entity({}), /not accepting new owners/u);
  assert.throws(() => parent.retain(), /not accepting new owners/u);
  assert.throws(() => old.retain(), /not accepting new owners/u);
  assert.throws(() => old.link(parent), /not accepting new owners/u);
  await assert.rejects(graph.bind(parent, { detach() {}, release() {} }), /not accepting new owners/u);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  let running;
  try {
    running = view.run(async () => {
      await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
      const child = graph.entity({}), temporary = own(child.retain());
      try {
        edge = own(old.link(child));
        await graph.bind(child, { detach() {}, release() { released.push('child'); } });
      } finally { temporary.release(); }
      await graph.collect(); assert.deepEqual(released, []);
      entered.resolve(); await resume.promise;
      return child.id;
    });
    running.catch(() => {});
    // The synchronous run admission keeps the old resource alive after its
    // original view leaves, including while the callback awaits max=1 SQL.
    view.release();
    await deadline(Promise.race([entered.promise, running])); await graph.flush(); assert.equal(closed, false);
    assert.throws(() => view.run(() => {}), /owner has been released/u);
    assert.throws(() => graph.entity({}), /not accepting new owners/u);
    resume.resolve(); assert.equal(typeof await deadline(running), 'string');
    await deadline(closing);
    assert.deepEqual(released.slice().sort(), ['child', 'old']);
    assert.throws(() => view.run(() => {}), /owner has been released/u);
  } finally {
    resume.resolve(); view.release();
    await deadline(Promise.allSettled([running]));
  }
});

test('postgres: admitted callback failures release their clone and expired async scopes cannot admit new work', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), parent = graph.entity({}), owner = own(parent.retain());
  let releases = 0;
  const resource = await graph.bind(parent, { detach() {}, release() { releases++; } });
  const view = own(resource.retain()); resource.unbind(); owner.release();
  const closing = graph.close(); closing.catch(() => {});
  await graph.flush();
  const failure = new Error('actual admitted callback failure');
  await assert.rejects(view.run(async () => {
    await linkedChildren.withSession(async db => db.client.query('SELECT 1'));
    throw failure;
  }), error => error === failure);
  assert.throws(() => view.run(null), /callback is required/u);
  const resume = Promise.withResolvers();
  let detached;
  try {
    assert.equal(await view.run(() => {
      detached = resume.promise.then(async () => {
        assert.throws(() => graph.entity({}), /not accepting new owners/u);
        assert.throws(() => parent.retain(), /not accepting new owners/u);
        assert.throws(() => resource.link(parent), /not accepting new owners/u);
        await assert.rejects(graph.bind(parent, { detach() {}, release() {} }), /not accepting new owners/u);
      });
      return 'complete';
    }), 'complete');
    resume.resolve(); await deadline(detached); await graph.flush();
    assert.equal(await linkedChildren.withSession(async db => Number((await db.client.query(
      `SELECT count(*) AS count FROM ${graph.tables.roots}`)).rows[0].count)), 1,
    'Only the original admitted view remains after successful and failed callbacks settle.');
    view.release(); await deadline(closing); assert.equal(releases, 1);
  } finally {
    resume.resolve(); view.release();
    await deadline(Promise.allSettled([detached]));
  }
});

test('postgres: releases queued while collection awaits an earlier tail are included in that collection', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), events = [], entity = graph.entity({});
  const owners = Array.from({ length: 3 }, () => own(entity.retain()));
  await graph.bind(entity, { detach() { events.push('detach'); }, release() { events.push('release'); } });
  await graph.collect(); assert.deepEqual(events, []);
  const queueOwnedRelease = linkedChildren.queueOwnedRelease;
  let released = false;
  linkedChildren.queueOwnedRelease = operation => queueOwnedRelease.call(linkedChildren, () => {
    // Enter the actual collector before changing ownership. Its first await
    // has captured the settled old tail; all three DELETEs enter the mutation
    // queue before that await resumes. The max=1 pool exposes intermediate
    // roots if marking starts without first observing the replacement tail.
    const work = operation();
    if (!released) { released = true; for (const owner of owners) owner.release(); }
    return work;
  });
  try {
    await deadline(graph.collect());
    assert.equal(released, true);
    assert.deepEqual(events, ['detach', 'release'], 'The collection that observed the releases must retire the cache.');
    const state = await linkedChildren.withSession(async db => (await db.client.query(`SELECT
      (SELECT count(*)::integer FROM ${graph.tables.roots}) AS roots,
      (SELECT count(*)::integer FROM ${graph.tables.resources}) AS resources,
      (SELECT count(*)::integer FROM ${graph.tables.entities}) AS entities`)).rows[0]);
    assert.deepEqual(state, { roots: 0, resources: 0, entities: 0 });
  } finally { linkedChildren.queueOwnedRelease = queueOwnedRelease; }
  await deadline(graph.close());
});

test('postgres: a synchronous admission invalidates a SQL mark before any resource is detached', options, async t => {
  const { graph, database, own } = await setup(t);
  const entity = graph.entity({}), root = own(entity.retain()); let released = false;
  await graph.bind(entity, { detach() { released = true; }, release() {} });
  const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = database.client.query;
  let paused = false;
  database.client.query = async (...args) => {
    const result = await original(...args), text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (!paused && text.includes('WITH RECURSIVE reachable') && result.rows.length) {
      paused = true; entered.resolve(); await resume.promise;
    }
    return result;
  };
  try {
    root.release(); const collecting = graph.collect();
    await deadline(entered.promise);
    const admitted = own(entity.retain());
    resume.resolve(); await collecting;
    assert.equal(released, false, 'The earlier mark cannot detach a newly owned cache.');
    admitted.release(); await graph.collect(); assert.equal(released, true);
  } finally { resume.resolve(); database.client.query = original; }
});

test('postgres: SQL prepares only reachable direct resources outside the max=1 connection', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), prepared = [], released = [];
  const parent = graph.entity({}), child = graph.entity({}), discarded = graph.entity({}), owner = own(parent.retain());
  await graph.bind(discarded, { prepare() { throw new Error('An unreachable private graph must not be expanded.'); },
    detach() {}, release() { released.push('discarded'); } });
  await graph.bind(parent, { async prepare(resource) {
    await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
    prepared.push('parent');
    let childBinding;
    await resource.replaceLinks({ *[Symbol.iterator]() {
      assert.notEqual(linkedChildren.relationDatabase.operationContext.getStore()?.connectionActive, true,
        'A direct-child iterator must not borrow the graph relation connection.');
      childBinding = graph.bind(child, { prepare() { prepared.push('child'); }, detach() {}, release() { released.push('child'); } });
      yield child;
    } });
    await childBinding;
  }, detach() {}, release() { released.push('parent'); } });
  await graph.collect();
  assert.deepEqual(prepared, ['parent', 'child']); assert.deepEqual(released, ['discarded']);
  owner.release(); await graph.collect();
  assert.deepEqual(released.slice().sort(), ['child', 'discarded', 'parent']);
});

test('postgres: refresh during direct preparation prevents publishing its stale child edges as complete', options, async t => {
  const { graph, own } = await setup(t), parent = graph.entity({}), old = graph.entity({}), current = graph.entity({});
  const owner = own(parent.retain()), entered = Promise.withResolvers(), resume = Promise.withResolvers(), released = [];
  await graph.bind(old, { detach() {}, release() { released.push('old'); } });
  await graph.bind(current, { detach() {}, release() { released.push('current'); } });
  let selected = old, passes = 0;
  const source = await graph.bind(parent, { async prepare(resource) {
    await resource.replaceLinks([selected]);
    if (++passes === 1) { entered.resolve(); await resume.promise; }
  }, detach() {}, release() { released.push('parent'); } });
  const collecting = graph.collect(); collecting.catch(() => {});
  try {
    await deadline(Promise.race([entered.promise, collecting]));
    selected = current; source.refresh(); resume.resolve(); await deadline(collecting);
    assert.equal(passes, 2); assert.deepEqual(released, ['old']);
    owner.release(); await graph.collect();
    assert.deepEqual(released.slice().sort(), ['current', 'old', 'parent']);
  } finally { resume.resolve(); await deadline(Promise.allSettled([collecting])); }
});

test('postgres: replacing a slot edge retires only its unowned target and stale releases cannot delete the new edge', options, async t => {
  const { graph, own } = await setup(t), parent = graph.entity({}), first = graph.entity({}), second = graph.entity({});
  const owner = own(parent.retain()), released = [], slot = '46b40000-0000-0000-0000-000000000001';
  const source = await graph.bind(parent, { detach() {}, release() { released.push('source'); } });
  const old = await graph.bind(first, { detach() {}, release() { released.push('first'); } });
  await graph.bind(second, { detach() {}, release() { released.push('second'); } });
  const oldView = own(old.retain()), oldEdge = own(source.link(first, { slot }));
  own(source.link(second, { slot })); oldEdge.release();
  await graph.collect(); assert.deepEqual(released, []);
  oldView.release(); await graph.collect(); assert.deepEqual(released, ['first']);
  owner.release(); await graph.collect(); assert.deepEqual(released.slice().sort(), ['first', 'second', 'source']);
});

test('postgres: unbound empty nodes are reclaimed and an exact object can safely re-enter with its opaque identity', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), value = {}, entity = graph.entity(value);
  let releases = 0;
  const empty = graph.entity({}), emptyOwner = own(empty.retain());
  emptyOwner.release(); await graph.collect();
  const count = () => linkedChildren.withSession(async db => Number((await db.client.query(`SELECT count(*) AS count FROM ${graph.tables.entities}`)).rows[0].count));
  assert.equal(await count(), 0);
  for (let pass = 0; pass < 2; pass++) {
    const current = graph.entity(value); assert.equal(current.id, entity.id);
    const owner = own(current.retain());
    await graph.bind(current, { detach() {}, release() { releases++; } });
    await graph.collect(); assert.equal(await count(), 1);
    owner.release(); await graph.collect(); assert.equal(await count(), 0);
  }
  assert.equal(releases, 2);
});

test('postgres: entity pruning and owner construction share one queue with an external two-connection pool', options, async t => {
  const { graph, relationDatabase, own } = await setup(t, { relationMax: 2 });
  const entity = graph.entity({}), entered = Promise.withResolvers(), pruned = Promise.withResolvers();
  const inserted = Promise.withResolvers(), resumePrune = Promise.withResolvers(), resumeInsert = Promise.withResolvers();
  const original = relationDatabase.client.query;
  let paused = false, collecting, probe;
  relationDatabase.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (!paused && text.startsWith(`DELETE FROM ${graph.tables.entities} entity`)) {
      paused = true; entered.resolve(); await resumePrune.promise;
      const result = await original(...args); pruned.resolve(); return result;
    }
    const result = await original(...args);
    if (text.startsWith(`INSERT INTO ${graph.tables.entities}`) && args[1]?.[0] === entity.id) {
      inserted.resolve(); await resumeInsert.promise;
    }
    return result;
  };
  try {
    collecting = graph.collect(); collecting.catch(() => {});
    await deadline(entered.promise);
    const owner = own(entity.retain());
    // Drain promise admission work before the probe requests the only free
    // connection. An unqueued prune lets the constructor take it first.
    await new Promise(resolve => setImmediate(resolve));
    probe = relationDatabase.withConnection(async db => {
      assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1);
      return 'probe';
    });
    const first = await deadline(Promise.race([probe, inserted.promise.then(() => 'entity insert')]));
    resumePrune.resolve(); await deadline(pruned.promise); resumeInsert.resolve();
    await deadline(collecting); await deadline(probe);
    assert.equal(first, 'probe', 'An owner constructor cannot run between a queued prune admission and its SQL completion.');
    assert.equal(await relationDatabase.withConnection(async db => Number((await db.client.query(
      `SELECT count(*) AS count FROM ${graph.tables.roots} WHERE entity_id=$1`, [entity.id])).rows[0].count)), 1);
    owner.release(); await graph.collect();
    assert.equal(await relationDatabase.withConnection(async db => Number((await db.client.query(
      `SELECT count(*) AS count FROM ${graph.tables.entities}`)).rows[0].count)), 0);
  } finally {
    resumePrune.resolve(); resumeInsert.resolve();
    try { await deadline(Promise.allSettled([collecting, probe])); }
    finally { relationDatabase.client.query = original; }
  }
});

test('postgres: all 257 accepted cache resources are collected using SQL pages of at most 128', options, async t => {
  const { graph, database, own } = await setup(t), entity = graph.entity({}), owner = own(entity.retain());
  let released = 0, maximum = 0;
  for (let index = 0; index < 257; index++) await graph.bind(entity, { detach() {}, release() { released++; } });
  const original = database.client.query;
  database.client.query = async (...args) => {
    const result = await original(...args), text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (text.includes('WITH RECURSIVE reachable')) maximum = Math.max(maximum, result.rows.length);
    return result;
  };
  try {
    owner.release(); await graph.collect();
    assert.equal(released, 257); assert.ok(maximum > 0 && maximum <= 128);
  } finally { database.client.query = original; }
});

test('postgres: detach and release failures remain visible while every accepted cleanup still runs', options, async t => {
  const f = await setup(t), { graph, own } = f, entity = graph.entity({}), owner = own(entity.retain());
  const detachFailure = new Error('actual detach failure'), releaseFailure = new Error('actual release failure'), completed = [];
  const expected = error => error instanceof AggregateError && error.errors.includes(detachFailure) && error.errors.includes(releaseFailure);
  f.expectCloseError(expected);
  await graph.bind(entity, { detach() { throw detachFailure; }, release() { completed.push('after detach failure'); } });
  await graph.bind(entity, { detach() { completed.push('before release failure'); }, release() { throw releaseFailure; } });
  await graph.bind(entity, { detach() { completed.push('ordinary detach'); }, release() { completed.push('ordinary release'); } });
  owner.release();
  await assert.rejects(graph.collect(), expected);
  assert.deepEqual(completed.slice().sort(), ['after detach failure', 'before release failure', 'ordinary detach', 'ordinary release']);
  await assert.rejects(deadline(graph.close()), expected);
  assert.equal(await f.linkedChildren.withSession(async db => (await db.client.query('SELECT to_regclass($1) AS name', [graph.tables.resources])).rows[0].name), null);
});
