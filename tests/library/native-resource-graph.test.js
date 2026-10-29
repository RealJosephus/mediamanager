import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeResourceGraph } from '../../src/library/native-resource-graph.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !postgresTestConnectionString, timeout: 60000 };
const failureValues = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });
const settle = work => Promise.resolve(work).then(value => ({ fulfilled: true, value }), reason => ({ fulfilled: false, reason }));

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
  const leases = [], beforeClose = [], cleanup = [];
  let relationDatabase, linkedChildren, graph, expectedCloseError;
  t.after(async () => {
    const errors = [];
    for (const action of beforeClose) try { await deadline(Promise.resolve().then(action)); } catch (error) { errors.push(error); }
    for (const lease of leases) try { lease.release(); } catch (error) { errors.push(error); }
    try { await deadline(graph?.close()); }
    catch (error) { if (!expectedCloseError?.(error)) errors.push(error); }
    for (const action of [...cleanup, () => linkedChildren?.flushOwnedReleases(), () => linkedChildren?.close(),
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
  graph = await createNativeResourceGraph({ linkedChildren });
  return { database, linkedChildren, relationDatabase: linkedChildren.relationDatabase, graph,
    own: lease => { leases.push(lease); return lease; },
    beforeClose: action => { beforeClose.push(action); }, ownCleanup: action => { cleanup.push(action); },
    expectCloseError: predicate => { expectedCloseError = predicate; } };
}

async function rootFailurePayload(f, name, { expectedCleanupFailure } = {}) {
  const owner = await PostgresDatabase.open({ connectionString: postgresTestConnectionString,
    schema: f.database.schemaName, max: 1 });
  const table = `"${f.linkedChildren.schemaName}"."${name}"`, bytes = Buffer.from('Retained cache payload\0中文: ' + name);
  const observations = [];
  let created = false, closing;
  const close = () => closing ??= (async () => {
    const errors = [];
    observations.push({ phase: 'close-started' });
    try {
      if (created) { await owner.client.query(`DELETE FROM ${table}`); observations.push({ phase: 'payload-delete-settled' }); }
    } catch (error) { errors.push(error); observations.push({ phase: 'payload-delete-rejected', error: failureValues(error) }); }
    try { await owner.close(); observations.push({ phase: 'connection-owner-close-settled' }); }
    catch (error) { errors.push(error); observations.push({ phase: 'connection-owner-close-rejected', error: failureValues(error) }); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'The actual cache payload failed to close.', { cause: errors[0] });
  })();
  f.ownCleanup(async () => {
    try { await close(); }
    catch (reason) { if (!expectedCleanupFailure?.(reason)) throw reason; }
  });
  await owner.client.query(`CREATE TABLE ${table}(payload bytea NOT NULL)`); created = true;
  await owner.client.query(`INSERT INTO ${table} VALUES($1)`, [bytes]);
  const read = async (database, reader) => {
    try {
      const values = await database.withConnection(async db => (await db.client.query(`SELECT payload FROM ${table}`)).rows.map(row => Buffer.from(row.payload)));
      observations.push({ phase: 'read-settled', reader, bytesBase64: values.map(value => value.toString('base64')) });
      return values;
    } catch (error) { observations.push({ phase: 'read-rejected', reader, error: failureValues(error) }); throw error; }
  };
  return { bytes, table, database: owner, observations, read: () => read(owner, 'cache-owner'), observe: () => read(f.database, 'independent-observer'),
    async write(value) {
      await owner.client.query(`UPDATE ${table} SET payload=$1`, [value]);
      observations.push({ phase: 'write-settled', bytesBase64: Buffer.from(value).toString('base64') });
    }, close };
}

async function admitPayloadRead(f, view, payload) {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const pending = view.run(async () => { entered.resolve(); await resume.promise; return payload.read(); });
  const observed = settle(pending);
  f.beforeClose(async () => { resume.resolve(); await observed; });
  await deadline(Promise.race([entered.promise, observed.then(result => {
    if (!result.fulfilled) throw result.reason;
    throw new Error('The admitted cache read completed before its held phase.');
  })]));
  return { resume: () => resume.resolve(), pending };
}

for (const self of [false, true]) test(`native graph: reachability drains a ${self ? 'self' : 'mutual'} cache cycle after its external owner leaves`, options, async t => {
  const f = await setup(t), { graph, linkedChildren, own } = f, events = [];
  const first = graph.entity({ Id: 'same-native-guid' }), second = self ? first : graph.entity({ Id: 'same-native-guid' });
  const root = own(first.retain()), construction = self ? null : own(second.retain()), edges = [];
  const resources = [], payloads = [];
  for (const [index, entity] of (self ? [first] : [first, second]).entries()) {
    const payload = await rootFailurePayload(f, 'cycle_payload_' + index); payloads.push(payload);
    resources.push(await graph.bind(entity, { detach() { events.push('detach:' + index); }, async release() {
      // The accepted cleanup can borrow the actual max=1 relation owner.
      await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
      await payload.close();
      edges[index]?.release(); events.push('release:' + index);
    } }));
  }
  edges.push(own(resources[0].link(second)));
  if (!self) edges.push(own(resources[1].link(first)));
  construction?.release();
  await graph.collect(); assert.deepEqual(events, [], 'An external owner preserves every internally reachable cache.');
  for (const payload of payloads) assert.deepEqual(await root.run(() => payload.read()), [payload.bytes]);
  root.release(); await graph.collect();
  assert.deepEqual(events.filter(value => value.startsWith('release:')).sort(), self ? ['release:0'] : ['release:0', 'release:1']);
  for (const payload of payloads) {
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
  }
  await deadline(graph.close());
  t.diagnostic(JSON.stringify({ payloadObservations: payloads.map(payload => payload.observations) }));
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
  let running, createdChild;
  try {
    running = view.run(async () => {
      await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
      const child = createdChild = graph.entity({}), temporary = own(child.retain());
      try {
        edge = own(old.link(child));
        await graph.bind(child, { detach() {}, release() { released.push('child'); } });
      } finally { temporary.release(); }
      await graph.collect(); assert.deepEqual(released, []);
      entered.resolve(); await resume.promise;
      return child;
    });
    running.catch(() => {});
    // The synchronous run admission keeps the old resource alive after its
    // original view leaves, including while the callback awaits max=1 SQL.
    view.release();
    await deadline(Promise.race([entered.promise, running])); await graph.flush(); assert.equal(closed, false);
    assert.throws(() => view.run(() => {}), /owner has been released/u);
    assert.throws(() => graph.entity({}), /not accepting new owners/u);
    resume.resolve(); assert.equal(await deadline(running), createdChild);
    await deadline(closing);
    assert.deepEqual(released.slice().sort(), ['child', 'old']);
    assert.throws(() => view.run(() => {}), /owner has been released/u);
  } finally {
    resume.resolve(); view.release();
    await deadline(Promise.allSettled([running]));
  }
});

test('postgres: admitted callback failures release their clone and expired async scopes cannot admit new work', options, async t => {
  const f = await setup(t), { graph, linkedChildren, own } = f;
  const parent = graph.entity({}), owner = own(parent.retain()), payload = await rootFailurePayload(f, 'callback_root_cache');
  const resource = await graph.bind(parent, { detach() {}, release() { return payload.close(); } });
  const view = own(resource.retain()); resource.unbind(); owner.release();
  const closing = graph.close(); closing.catch(() => {});
  await graph.flush();
  const failure = new Error('actual admitted callback failure');
  await assert.rejects(view.run(async () => {
    assert.deepEqual(await payload.read(), [payload.bytes]);
    throw failure;
  }), error => {
    t.diagnostic(JSON.stringify({ failureDiagnostic: { ...failureValues(error), stack: error?.stack } }));
    assert.equal(error, failure);
    return true;
  });
  for (const reason of [false, 0, '', null, undefined]) {
    const failed = await settle(view.run(async () => {
      assert.deepEqual(await payload.read(), [payload.bytes]);
      throw reason;
    }));
    assert.equal(failed.fulfilled, false); assert.ok(Object.is(failed.reason, reason));
    await graph.collect(); assert.deepEqual(await payload.observe(), [payload.bytes]);
  }
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
    assert.deepEqual(await view.run(() => payload.read()), [payload.bytes]);
    view.release(); await deadline(closing);
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    t.diagnostic(JSON.stringify({ payloadObservations: payload.observations }));
  } finally {
    resume.resolve(); view.release();
    await deadline(Promise.allSettled([detached]));
  }
});

test('postgres: derived owners preserve actual SQL payloads until their last admitted callback and cache close settle', options, async t => {
  const f = await setup(t), { graph, own } = f;
  const entity = graph.entity({}), owner = own(entity.retain()), independentEntity = own(entity.retain());
  const payload = await rootFailurePayload(f, 'derived_root_cache');
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const releasing = Promise.withResolvers(), finishRelease = Promise.withResolvers();
  let running, closing, closed = false;
  f.beforeClose(async () => { resume.resolve(); finishRelease.resolve(); await Promise.allSettled([running]); });
  const resource = await graph.bind(entity, { detach() {}, async release() {
    releasing.resolve(); await finishRelease.promise; await payload.close();
  } });
  const childOwner = own(owner.retain()), grandchildOwner = own(childOwner.retain());
  owner.release(); childOwner.release(); independentEntity.release();
  await graph.collect(); assert.deepEqual(await payload.observe(), [payload.bytes]);
  assert.throws(() => owner.retain(), /owner has been released/u);
  const view = own(resource.retain()), independentView = own(resource.retain());
  const childView = own(view.retain()), grandchildView = own(childView.retain());
  grandchildOwner.release(); resource.unbind(); view.release(); childView.release();
  await graph.collect(); assert.deepEqual(await payload.observe(), [payload.bytes]);
  assert.throws(() => childView.run(() => {}), /owner has been released/u);
  try {
    running = grandchildView.run(async () => {
      entered.resolve(); await resume.promise; return payload.read();
    });
    running.catch(() => {});
    grandchildView.release(); independentView.release();
    await deadline(Promise.race([entered.promise, running.then(() => {
      throw new Error('The admitted payload read completed before its held phase.');
    })]));
    closing = graph.close(); closing.then(() => { closed = true; }, () => {});
    await graph.flush(); assert.equal(closed, false);
    assert.deepEqual(await payload.observe(), [payload.bytes]);
    assert.throws(() => resource.retain(), /not accepting new owners|retired/u);
    assert.throws(() => grandchildView.retain(), /owner has been released/u);
    resume.resolve(); assert.deepEqual(await deadline(running), [payload.bytes]);
    await deadline(Promise.race([releasing.promise, closing.then(() => {
      throw new Error('Graph close returned before the held actual cache close.');
    })]));
    assert.equal(closed, false); assert.deepEqual(await payload.observe(), [payload.bytes]);
    finishRelease.resolve(); await deadline(closing);
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    assert.equal(closed, true);
    t.diagnostic(JSON.stringify({ payloadObservations: payload.observations, closed }));
  } finally {
    resume.resolve(); finishRelease.resolve(); grandchildView.release(); independentView.release();
    await deadline(Promise.allSettled([running, closing]));
  }
});

test('native graph: releases during an awaited preparation are included before collection settles', options, async t => {
  const f = await setup(t), { graph, own } = f, events = [], entity = graph.entity({});
  const owners = Array.from({ length: 3 }, () => own(entity.retain()));
  const payload = await rootFailurePayload(f, 'collector_tail_cache');
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  let armed = false, collecting;
  f.beforeClose(async () => { resume.resolve(); await Promise.allSettled([collecting]); });
  const resource = await graph.bind(entity, { async prepare() {
    if (armed) { entered.resolve(); await resume.promise; }
  }, detach() { events.push('detach'); }, release() { events.push('release'); return payload.close(); } });
  await graph.collect(); assert.deepEqual(events, []);
  assert.deepEqual(await owners[0].run(() => payload.read()), [payload.bytes]);
  armed = true; resource.refresh();
  try {
    collecting = graph.collect(); collecting.catch(() => {});
    await deadline(Promise.race([entered.promise, collecting.then(() => { throw new Error('Collection missed its admitted preparation.'); })]));
    for (const owner of owners) owner.release();
    assert.deepEqual(await payload.observe(), [payload.bytes]);
    resume.resolve(); await deadline(collecting);
    assert.deepEqual(events, ['detach', 'release']);
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    assert.throws(() => resource.retain(), /retired/u);
    assert.throws(() => owners[0].run(() => {}), /owner has been released/u);
    await deadline(graph.close());
  } finally { resume.resolve(); await deadline(Promise.allSettled([collecting])); }
});

test('native graph: a late synchronous admission preserves a cache while its preparation awaits', options, async t => {
  const f = await setup(t), { graph, own } = f;
  const entity = graph.entity({}), root = own(entity.retain()), payload = await rootFailurePayload(f, 'late_admission_cache');
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  let released = false, collecting, admitted;
  f.beforeClose(async () => { resume.resolve(); await Promise.allSettled([collecting]); });
  await graph.bind(entity, { async prepare() { entered.resolve(); await resume.promise; },
    detach() { released = true; }, release() { return payload.close(); } });
  try {
    collecting = graph.collect(); collecting.catch(() => {});
    await deadline(Promise.race([entered.promise, collecting.then(() => { throw new Error('The cache preparation was not admitted.'); })]));
    root.release(); admitted = own(entity.retain());
    resume.resolve(); await deadline(collecting);
    assert.equal(released, false);
    assert.deepEqual(await admitted.run(() => payload.read()), [payload.bytes]);
    admitted.release(); await graph.collect(); assert.equal(released, true);
    assert.deepEqual(await payload.observe(), []);
  } finally { resume.resolve(); admitted?.release(); await deadline(Promise.allSettled([collecting])); }
});

test('native graph: 257 interleaved owner releases preserve an intervening retained owner and actual cleanup', options, async t => {
  const { graph, linkedChildren, own } = await setup(t), entity = graph.entity({}), events = [];
  const owners = Array.from({ length: 257 }, () => own(entity.retain()));
  await graph.bind(entity, {
    detach() { events.push('detach'); },
    async release() {
      await linkedChildren.withSession(async db => {
        assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1);
        events.push('release');
      });
    },
  });
  for (const owner of owners.slice(0, 128)) owner.release();
  const retained = own(owners[128].retain());
  for (const owner of owners.slice(128)) owner.release();
  await graph.collect();
  assert.deepEqual(events, [], 'The retained owner must keep its actual resource alive after the surrounding releases.');
  retained.release(); await graph.collect();
  assert.deepEqual(events, ['detach', 'release']);
  await graph.close();
});

test('native graph: an actual payload DELETE failure still closes its owner and preserves the raw reason', options, async t => {
  const f = await setup(t), { graph, own } = f, entity = graph.entity({}), owner = own(entity.retain());
  let postgresFailure;
  const expected = reason => postgresFailure !== undefined && Object.is(reason, postgresFailure);
  const payload = await rootFailurePayload(f, 'failed_delete_payload', { expectedCleanupFailure: expected });
  f.expectCloseError(expected);
  const query = payload.database.client.query;
  let armed = true;
  payload.database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (armed && text === `DELETE FROM ${payload.table}`) {
      armed = false;
      try { return await query(text + ' WHERE 1 / 0 = 0'); }
      catch (reason) { postgresFailure = reason; throw reason; }
    }
    return query(...args);
  };
  await graph.bind(entity, { detach() {}, release() { return payload.close(); } });
  try {
    assert.deepEqual(await owner.run(() => payload.read()), [payload.bytes]);
    owner.release(); await assert.rejects(graph.collect(), expected);
    assert.equal(postgresFailure.code, '22012');
    assert.deepEqual(await payload.observe(), [payload.bytes], 'A rejected real DELETE must not fabricate empty storage.');
    assert.equal((await settle(payload.read())).fulfilled, false, 'The actual payload connection owner still closes after its DELETE fails.');
    assert.ok(payload.observations.some(value => value.phase === 'connection-owner-close-settled'));
    await assert.rejects(deadline(graph.close()), expected);
    t.diagnostic(JSON.stringify({ payloadObservations: payload.observations }));
  } finally { payload.database.client.query = query; }
});

test('native graph: preparation visits only reachable direct resources and can use its max=1 PG owner', options, async t => {
  const f = await setup(t), { graph, linkedChildren, own } = f, prepared = [], released = [], iteratorConnections = [];
  const parent = graph.entity({}), child = graph.entity({}), discarded = graph.entity({}), owner = own(parent.retain());
  const payload = await rootFailurePayload(f, 'prepared_direct_child'), preparedBytes = Buffer.from('Prepared direct-child payload\0中文.');
  await graph.bind(discarded, { prepare() { throw new Error('An unreachable private graph must not be expanded.'); },
    detach() {}, release() { released.push('discarded'); } });
  await graph.bind(parent, { async prepare(resource) {
    await linkedChildren.withSession(async db => assert.equal((await db.client.query('SELECT 1 AS value')).rows[0].value, 1));
    prepared.push('parent');
    let childBinding;
    await resource.replaceLinks({ *[Symbol.iterator]() {
      iteratorConnections.push(linkedChildren.relationDatabase.operationContext.getStore()?.connectionActive ?? false);
      childBinding = graph.bind(child, { async prepare() { prepared.push('child'); await payload.write(preparedBytes); },
        detach() {}, release() { released.push('child'); return payload.close(); } });
      yield child;
    } });
    await childBinding;
  }, detach() {}, release() { released.push('parent'); } });
  await graph.collect();
  assert.deepEqual(released, ['discarded']);
  assert.deepEqual(await owner.run(() => payload.read()), [preparedBytes]);
  owner.release(); await graph.collect();
  assert.deepEqual(released.slice().sort(), ['child', 'discarded', 'parent']);
  assert.deepEqual(await payload.observe(), []);
  assert.equal((await settle(payload.read())).fulfilled, false);
  await deadline(graph.close());
  t.diagnostic(JSON.stringify({ diagnosticOnly: true, iteratorConnections, prepared, released, payloadObservations: payload.observations }));
});

for (const mode of ['direct', 'async', 'then', 'catch', 'unawaited', 'multiple']) test(`native graph: ${mode} preparation preserves iterator failure, admitted payloads and the independent busy PG owner`, options, async t => {
  const f = await setup(t), { graph, linkedChildren, own } = f;
  const parent = graph.entity({}), previous = graph.entity({}), prefix = graph.entity({});
  const owner = own(parent.retain()), prefixOwner = own(prefix.retain());
  const oldPayload = await rootFailurePayload(f, 'iterator_old_payload'), prefixPayload = await rootFailurePayload(f, 'iterator_prefix_payload');
  const released = [], consumed = [], thrown = [], replacements = [], reason = false, laterReason = 0;
  let armed = false, collecting, holding, holdActive = false, caughtOriginal = false, returnedWithoutAwait = false;
  let oldReader, prefixReader;
  const busy = Promise.withResolvers(), free = Promise.withResolvers();
  f.beforeClose(async () => { free.resolve(); await Promise.allSettled([holding, collecting]); });
  await graph.bind(previous, { detach() {}, release() { released.push('previous'); return oldPayload.close(); } });
  await graph.bind(prefix, { detach() {}, release() { released.push('prefix'); return prefixPayload.close(); } });
  const replace = (resource, label = 'first') => {
    if (!armed) return resource.replaceLinks([previous]);
    const work = resource.replaceLinks({ *[Symbol.iterator]() {
      assert.equal(holdActive, true, 'The actual max=1 relation owner remains in its admitted SQL callback.');
      if (mode === 'unawaited') assert.equal(returnedWithoutAwait, true, 'The work executes after its callback has returned.');
      consumed.push(label + ':prefix'); yield prefix;
      consumed.push(label + ':failure'); thrown.push(reason); throw reason;
    } });
    replacements.push(work); return work;
  };
  const prepare = mode === 'async' ? async resource => { await replace(resource); }
    : mode === 'then' ? resource => replace(resource).then(value => value)
      : mode === 'catch' ? async resource => {
        try { await replace(resource); }
        catch (error) { assert.ok(Object.is(error, reason)); caughtOriginal = true; }
      } : mode === 'unawaited' ? resource => {
        const work = replace(resource);
        if (!armed) return work;
        returnedWithoutAwait = true;
      } : mode === 'multiple' ? async resource => {
        if (!armed) { await replace(resource); return; }
        const results = await Promise.allSettled([replace(resource), replace(resource, 'second')]);
        assert.ok(results.every(value => value.status === 'rejected' && Object.is(value.reason, reason)));
        thrown.push(laterReason); throw laterReason;
      } : replace;
  const source = await graph.bind(parent, { prepare, detach() {}, release() { released.push('parent'); } });
  const oldView = own(source.retain()); source.unbind(); owner.release(); await graph.collect();
  assert.deepEqual(await oldView.run(() => oldPayload.read()), [oldPayload.bytes]);
  const expected = error => mode === 'multiple'
    ? Array.isArray(error?.errors) && error.errors.length === thrown.length
      && error.errors.every((value, index) => Object.is(value, thrown[index])) && Object.is(error.cause, thrown[0])
    : Object.is(error, reason);
  f.expectCloseError(expected);
  try {
    holding = linkedChildren.withSession(async session => {
      assert.equal((await session.client.query('SELECT 1 AS value')).rows[0].value, 1);
      holdActive = true; busy.resolve();
      try { await free.promise; }
      finally { holdActive = false; }
    });
    holding.catch(() => {});
    await deadline(Promise.race([busy.promise, holding.then(() => { throw new Error('The SQL owner returned before its held phase.'); })]));
    armed = true; source.refresh(); collecting = graph.collect();
    const result = await deadline(settle(collecting));
    assert.equal(result.fulfilled, false); assert.ok(expected(result.reason));
    assert.equal(caughtOriginal, mode === 'catch', 'Catching the callback failure cannot turn the failed mutation into successful collection.');
    assert.equal(holdActive, true, 'Iterator work settles without waiting for the unavailable relation connection.');
    for (const replacement of replacements) {
      const failed = await settle(replacement); assert.equal(failed.fulfilled, false); assert.ok(Object.is(failed.reason, reason));
    }
    assert.deepEqual(consumed, mode === 'multiple'
      ? ['first:prefix', 'first:failure', 'second:prefix', 'second:failure'] : ['first:prefix', 'first:failure']);
    if (mode === 'multiple') assert.deepEqual(thrown, [reason, reason, laterReason]);
    assert.deepEqual(released, []); prefixOwner.release();
    assert.deepEqual(await oldView.run(() => oldPayload.read()), [oldPayload.bytes]);
    assert.deepEqual(await oldView.run(() => prefixPayload.read()), [prefixPayload.bytes]);
    oldReader = await admitPayloadRead(f, oldView, oldPayload);
    prefixReader = await admitPayloadRead(f, oldView, prefixPayload);
    const flushed = await settle(graph.flush()); assert.equal(flushed.fulfilled, false); assert.ok(expected(flushed.reason));
    const closed = await settle(deadline(graph.close())); assert.equal(closed.fulfilled, false); assert.ok(expected(closed.reason));
    assert.deepEqual(released, [], 'Fatal close does not invoke callbacks or fabricate successful payload retirement.');
    oldReader.resume(); prefixReader.resume();
    assert.deepEqual(await deadline(oldReader.pending), [oldPayload.bytes]);
    assert.deepEqual(await deadline(prefixReader.pending), [prefixPayload.bytes]);
    free.resolve(); await deadline(holding);
    await oldPayload.close(); await prefixPayload.close();
    assert.deepEqual(await oldPayload.observe(), []); assert.deepEqual(await prefixPayload.observe(), []);
    assert.equal((await settle(oldPayload.read())).fulfilled, false);
    assert.equal((await settle(prefixPayload.read())).fulfilled, false);
    t.diagnostic(JSON.stringify({ mode, consumed, oldPayloadObservations: oldPayload.observations,
      prefixPayloadObservations: prefixPayload.observations, explicitFixtureCleanupAfterObservedFailure: true }));
  } finally {
    free.resolve(); oldReader?.resume(); prefixReader?.resume(); oldView.release(); prefixOwner.release();
    await deadline(Promise.allSettled([holding, collecting, oldReader?.pending, prefixReader?.pending]));
  }
});

test('postgres: refresh during direct preparation prevents publishing its stale child edges as complete', options, async t => {
  const f = await setup(t), { graph, own } = f, parent = graph.entity({}), old = graph.entity({}), current = graph.entity({});
  const owner = own(parent.retain()), entered = Promise.withResolvers(), resume = Promise.withResolvers(), released = [];
  const oldPayload = await rootFailurePayload(f, 'refresh_old_payload'), currentPayload = await rootFailurePayload(f, 'refresh_current_payload');
  await graph.bind(old, { detach() {}, release() { released.push('old'); return oldPayload.close(); } });
  await graph.bind(current, { detach() {}, release() { released.push('current'); return currentPayload.close(); } });
  let selected = old, passes = 0;
  const source = await graph.bind(parent, { async prepare(resource) {
    await resource.replaceLinks([selected]);
    if (++passes === 1) { entered.resolve(); await resume.promise; }
  }, detach() {}, release() { released.push('parent'); } });
  const collecting = graph.collect(); collecting.catch(() => {});
  try {
    await deadline(Promise.race([entered.promise, collecting]));
    selected = current; source.refresh(); resume.resolve(); await deadline(collecting);
    assert.deepEqual(released, ['old']);
    assert.deepEqual(await oldPayload.observe(), []);
    assert.equal((await settle(oldPayload.read())).fulfilled, false);
    assert.deepEqual(await owner.run(() => currentPayload.read()), [currentPayload.bytes]);
    owner.release(); await graph.collect();
    assert.deepEqual(released.slice().sort(), ['current', 'old', 'parent']);
    assert.deepEqual(await currentPayload.observe(), []);
    assert.equal((await settle(currentPayload.read())).fulfilled, false);
    await deadline(graph.close());
    t.diagnostic(JSON.stringify({ diagnosticOnly: true, preparationPasses: passes,
      oldPayloadObservations: oldPayload.observations, currentPayloadObservations: currentPayload.observations }));
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

test('postgres: repeated cache admissions preserve real SQL payloads until their last owner releases', options, async t => {
  const f = await setup(t), { graph, own } = f, value = {};
  let releases = 0;
  const empty = graph.entity({}), emptyOwner = own(empty.retain());
  emptyOwner.release(); await graph.collect();
  for (let pass = 0; pass < 2; pass++) {
    const current = graph.entity(value);
    const owner = own(current.retain());
    const payload = await rootFailurePayload(f, 'reentered_payload_' + pass);
    const resource = await graph.bind(current, { detach() {}, release() { releases++; return payload.close(); } });
    await graph.collect();
    assert.deepEqual(await owner.run(() => payload.read()), [payload.bytes]);
    const view = own(resource.retain()); owner.release(); await graph.collect();
    assert.deepEqual(await view.run(() => payload.read()), [payload.bytes]);
    view.release(); await graph.collect();
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    t.diagnostic(JSON.stringify({ payloadObservations: payload.observations }));
  }
  assert.equal(releases, 2);
  await deadline(graph.close());
});

test('native graph: an entity constructed during another preparation retains its actual payload and admitted reader', options, async t => {
  const f = await setup(t, { relationMax: 2 }), { graph, relationDatabase, own } = f;
  const earlier = graph.entity({}), earlierOwner = own(earlier.retain());
  const entered = Promise.withResolvers(), resume = Promise.withResolvers(), payload = await rootFailurePayload(f, 'late_construction_cache');
  let collecting, owner, resource, reader;
  f.beforeClose(async () => { resume.resolve(); reader?.resume(); await Promise.allSettled([collecting, reader?.pending]); });
  await graph.bind(earlier, { async prepare() { entered.resolve(); await resume.promise; }, detach() {}, release() {} });
  try {
    collecting = graph.collect(); collecting.catch(() => {});
    await deadline(Promise.race([entered.promise, collecting.then(() => { throw new Error('The earlier resource preparation was not admitted.'); })]));
    const entity = graph.entity({}); owner = own(entity.retain());
    resource = await graph.bind(entity, { detach() {}, release() { return payload.close(); } });
    assert.equal(await relationDatabase.withConnection(async db => (await db.client.query('SELECT 1 AS value')).rows[0].value), 1);
    resume.resolve(); await deadline(collecting); await graph.collect();
    assert.deepEqual(await owner.run(() => payload.read()), [payload.bytes]);
    reader = await admitPayloadRead(f, owner, payload);
    owner.release(); await graph.collect(); assert.deepEqual(await payload.observe(), [payload.bytes]);
    reader.resume(); assert.deepEqual(await deadline(reader.pending), [payload.bytes]);
    await graph.collect();
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    assert.throws(() => owner.retain(), /owner has been released/u);
    assert.throws(() => resource.retain(), /retired/u);
    earlierOwner.release(); await deadline(graph.close());
  } finally { resume.resolve(); reader?.resume(); owner?.release(); earlierOwner.release(); await deadline(Promise.allSettled([collecting, reader?.pending])); }
});

test('native graph: every one of 257 accepted cache resources receives cleanup', options, async t => {
  const { graph, own } = await setup(t), entity = graph.entity({}), owner = own(entity.retain());
  let released = 0;
  for (let index = 0; index < 257; index++) await graph.bind(entity, { detach() {}, release() { released++; } });
  owner.release(); await graph.collect();
  assert.equal(released, 257);
  await deadline(graph.close());
});

test('native graph: detach and release failures preserve their observed order while all accepted cleanup runs', options, async t => {
  const f = await setup(t), { graph, own } = f, entity = graph.entity({}), owner = own(entity.retain());
  const detachFailure = new Error('actual detach failure'), releaseFailure = new Error('actual release failure');
  const thrown = [], completed = [];
  const expected = reason => Array.isArray(reason?.errors) && reason.errors.length === thrown.length
    && reason.errors.every((value, index) => Object.is(value, thrown[index])) && Object.is(reason.cause, thrown[0]);
  f.expectCloseError(expected);
  await graph.bind(entity, { detach() { thrown.push(detachFailure); throw detachFailure; },
    release() { completed.push('after detach failure'); } });
  await graph.bind(entity, { detach() { completed.push('before release failure'); },
    release() { thrown.push(releaseFailure); throw releaseFailure; } });
  const ordinary = await graph.bind(entity, { detach() { completed.push('ordinary detach'); },
    release() { completed.push('ordinary release'); } });
  owner.release(); await assert.rejects(graph.collect(), expected);
  assert.deepEqual(completed.slice().sort(), ['after detach failure', 'before release failure', 'ordinary detach', 'ordinary release']);
  await assert.rejects(deadline(graph.close()), expected);
  assert.throws(() => ordinary.retain(), /not accepting new owners|retired/u);
});

test('native graph: distinct cleanup callbacks retain repeated falsy failures in actual throw order', options, async t => {
  const f = await setup(t), { graph, own } = f, entity = graph.entity({}), owner = own(entity.retain());
  const reasons = [false, false, 0, 0, '', '', null, null, undefined, undefined], thrown = [];
  const expected = reason => Array.isArray(reason?.errors) && reason.errors.length === thrown.length
    && reason.errors.every((value, index) => Object.is(value, thrown[index])) && Object.is(reason.cause, thrown[0]);
  f.expectCloseError(expected);
  let ordinaryClosed = false;
  for (const reason of reasons) await graph.bind(entity, { detach() {}, release() { thrown.push(reason); throw reason; } });
  await graph.bind(entity, { detach() {}, release() { ordinaryClosed = true; } });
  owner.release(); await assert.rejects(graph.collect(), expected);
  assert.equal(thrown.length, reasons.length); assert.equal(ordinaryClosed, true);
  await assert.rejects(deadline(graph.close()), expected);
});

for (const commitPhase of ['before-dispatch', 'after-commit']) test(`native graph: a late owner preserves the actual payload while an admitted PG COMMIT awaits ${commitPhase}`, options, async t => {
  const f = await setup(t, { relationMax: 2 }), { graph, own } = f;
  const entity = graph.entity({}), owner = own(entity.retain()), payload = await rootFailurePayload(f, 'held_commit_payload');
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const releasing = Promise.withResolvers(), releaseCache = Promise.withResolvers();
  let current, late, running, closing, closed = false, detached = false;
  f.beforeClose(async () => { resume.resolve(); releaseCache.resolve(); await Promise.allSettled([running, closing]); });
  const resource = await graph.bind(entity, { detach() { detached = true; }, async release() {
    releasing.resolve(); await releaseCache.promise; await payload.close();
  } });
  current = own(resource.retain()); resource.unbind(); owner.release(); await graph.collect();
  const query = payload.database.client.query;
  let armed = true;
  payload.database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (armed && text === 'COMMIT') {
      armed = false;
      const result = commitPhase === 'after-commit' ? await query(...args) : undefined;
      entered.resolve(); await resume.promise;
      return commitPhase === 'after-commit' ? result : query(...args);
    }
    return query(...args);
  };
  try {
    for (let index = 0; index < 129; index++) {
      const next = own(resource.retain()); current.release(); current = next;
    }
    running = current.run(() => payload.database.transaction(db => db.client.query(
      `UPDATE ${payload.table} SET payload=$1`, [payload.bytes])));
    const pending = settle(running);
    await deadline(Promise.race([entered.promise, pending.then(result => {
      if (!result.fulfilled) throw result.reason;
      throw new Error('The actual payload transaction completed before its held COMMIT.');
    })]));
    late = own(current.retain()); current.release();
    closing = graph.close(); closing.then(() => { closed = true; }, () => {});
    await graph.flush(); assert.equal(closed, false); assert.equal(detached, false);
    assert.deepEqual(await payload.observe(), [payload.bytes]);
    resume.resolve(); await deadline(running);
    assert.deepEqual(await late.run(() => payload.read()), [payload.bytes]);
    await graph.flush(); assert.equal(closed, false); assert.equal(detached, false);
    late.release();
    await deadline(Promise.race([releasing.promise, closing.then(() => { throw new Error('Graph close returned before actual payload cleanup.'); })]));
    assert.equal(closed, false); assert.deepEqual(await payload.observe(), [payload.bytes]);
    releaseCache.resolve(); await deadline(closing);
    assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    assert.equal(detached, true); assert.equal(closed, true);
    assert.throws(() => graph.entity({}), /not accepting new owners/u);
    t.diagnostic(JSON.stringify({ commitPhase, payloadObservations: payload.observations, closed }));
  } finally {
    resume.resolve(); releaseCache.resolve(); current?.release(); late?.release();
    try { await deadline(Promise.allSettled([running, closing])); }
    finally { payload.database.client.query = query; }
  }
});

test('native graph: a real PG preparation failure preserves an already admitted payload read and its raw reason', options, async t => {
  const f = await setup(t, { relationMax: 2 }), { graph, own } = f;
  const healthy = graph.entity({}), existing = own(healthy.retain()), failing = graph.entity({}), events = [];
  const payload = await rootFailurePayload(f, 'failed_prepare_cache');
  const resource = await graph.bind(healthy, { detach() { events.push('detach'); }, release() { events.push('release'); return payload.close(); } });
  const view = own(resource.retain()); await graph.collect();
  const reader = await admitPayloadRead(f, view, payload);
  let postgresFailure;
  const rejectedOwner = own(failing.retain());
  const expected = reason => postgresFailure !== undefined && Object.is(reason, postgresFailure);
  f.expectCloseError(expected);
  await graph.bind(failing, { async prepare() {
    try { await payload.database.client.query(`SELECT 1 / (length(payload)-length(payload)) FROM ${payload.table}`); }
    catch (reason) { postgresFailure = reason; throw reason; }
  }, detach() {}, release() {} });
  try {
    view.release(); existing.release();
    await assert.rejects(graph.collect(), expected); assert.equal(postgresFailure.code, '22012');
    reader.resume(); assert.deepEqual(await deadline(reader.pending), [payload.bytes]);
    rejectedOwner.release(); await assert.rejects(graph.flush(), expected);
    assert.deepEqual(await payload.read(), [payload.bytes]); assert.deepEqual(events, []);
    await assert.rejects(deadline(graph.close()), expected);
    assert.deepEqual(await payload.read(), [payload.bytes]);
    await payload.close(); assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    t.diagnostic(JSON.stringify({ failure: failureValues(postgresFailure), events, payloadObservations: payload.observations,
      payloadClose: 'Explicit fixture cleanup after the original graph failure; actual DELETE and pool.close completed.' }));
  } finally { reader.resume(); rejectedOwner?.release(); view.release(); await deadline(Promise.allSettled([reader.pending])); }
});

for (const reason of [false, 0, '', null, undefined]) test(`native graph: preparation rejection after actual payload consumption preserves ${typeof reason}:${String(reason)}`, options, async t => {
  const f = await setup(t), { graph, own } = f;
  const healthy = graph.entity({}), existing = own(healthy.retain()), rejected = graph.entity({}), events = [];
  const payload = await rootFailurePayload(f, 'falsy_prepare_cache');
  const resource = await graph.bind(healthy, { detach() { events.push('detach'); }, release() { events.push('release'); return payload.close(); } });
  const view = own(resource.retain()); await graph.collect();
  const reader = await admitPayloadRead(f, view, payload);
  const rejectedOwner = own(rejected.retain());
  let consumed = false;
  f.expectCloseError(error => Object.is(error, reason));
  await graph.bind(rejected, { async prepare() {
    assert.deepEqual(await payload.read(), [payload.bytes]); consumed = true; throw reason;
  }, detach() {}, release() {} });
  try {
    view.release(); existing.release();
    const collection = await settle(graph.collect());
    assert.equal(consumed, true); assert.equal(collection.fulfilled, false); assert.ok(Object.is(collection.reason, reason));
    reader.resume(); assert.deepEqual(await deadline(reader.pending), [payload.bytes]); rejectedOwner.release();
    const flushed = await settle(graph.flush()); assert.equal(flushed.fulfilled, false); assert.ok(Object.is(flushed.reason, reason));
    assert.deepEqual(await payload.read(), [payload.bytes]); assert.deepEqual(events, []);
    const closed = await settle(deadline(graph.close())); assert.equal(closed.fulfilled, false); assert.ok(Object.is(closed.reason, reason));
    assert.deepEqual(await payload.read(), [payload.bytes]);
    await payload.close(); assert.deepEqual(await payload.observe(), []);
    assert.equal((await settle(payload.read())).fulfilled, false);
    t.diagnostic(JSON.stringify({ reasonType: typeof reason, ...(reason === undefined ? {} : { reason }), events,
      payloadObservations: payload.observations, payloadClose: 'Explicit fixture cleanup follows the observed raw preparation failure.' }));
  } finally { reader.resume(); rejectedOwner?.release(); view.release(); await deadline(Promise.allSettled([reader.pending])); }
});

test('native graph: an admitted uncertain payload COMMIT discards its actual connection and preserves commit then release failures', options, async t => {
  const f = await setup(t, { relationMax: 2 }), { graph, own } = f;
  const entity = graph.entity({}), owner = own(entity.retain()), events = [], payload = await rootFailurePayload(f, 'uncertain_commit_cache');
  const resource = await graph.bind(entity, { detach() { events.push('detach'); }, release() { events.push('release'); return payload.close(); } });
  const view = own(resource.retain()), spare = own(resource.retain());
  resource.unbind(); owner.release(); await graph.collect();
  const reader = await admitPayloadRead(f, view, payload);
  const commitFailure = false, releaseFailure = 0, ended = Promise.withResolvers();
  const expected = reason => Object.is(reason?.cause, commitFailure)
    && Array.isArray(reason?.errors) && reason.errors.length === 2
    && Object.is(reason.errors[0], commitFailure) && Object.is(reason.errors[1], releaseFailure);
  const query = payload.database.client.query;
  const suffix = Buffer.from('\0committed once 中文'), committedBytes = Buffer.concat([payload.bytes, suffix]);
  let armed = true, physical, releasePhysical, retained;
  payload.database.pool.once('acquire', client => { physical = client; });
  payload.database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (armed && text === 'COMMIT') {
      armed = false; physical.once('end', () => ended.resolve()); releasePhysical = physical.release;
      physical.release = function (...values) { releasePhysical.apply(this, values); throw releaseFailure; };
      await query(...args); throw commitFailure;
    }
    return query(...args);
  };
  try {
    retained = own(resource.retain()); spare.release(); view.release();
    await assert.rejects(retained.run(() => payload.database.transaction(db => db.client.query(
      `UPDATE ${payload.table} SET payload=payload || $1::bytea`, [suffix]))), expected);
    await deadline(ended.promise);
    payload.database.client.query = query; physical.release = releasePhysical;
    assert.deepEqual(await payload.observe(), [committedBytes], 'The actual payload mutation is not replayed after its lost acknowledgement.');
    reader.resume(); assert.deepEqual(await deadline(reader.pending), [committedBytes]);
    assert.deepEqual(await retained.run(() => payload.read()), [committedBytes]);
    retained.release(); await graph.flush(); await deadline(graph.close());
    assert.deepEqual(await payload.observe(), []); assert.equal((await settle(payload.read())).fulfilled, false);
    assert.deepEqual(events, ['detach', 'release']);
    t.diagnostic(JSON.stringify({ physicalConnectionEnded: true, errors: [commitFailure, releaseFailure],
      committedBytesBase64: committedBytes.toString('base64'), payloadObservations: payload.observations }));
  } finally {
    reader.resume(); retained?.release(); spare.release(); view.release();
    try { await deadline(Promise.allSettled([reader.pending])); }
    finally { payload.database.client.query = query; if (physical && releasePhysical) physical.release = releasePhysical; }
  }
});
