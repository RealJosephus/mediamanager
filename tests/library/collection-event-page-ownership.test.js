import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as immediate } from 'node:timers/promises';
import { newNativeItemEntity, publishNativeItemLinks, observeNativeItemLinkOwnership } from '../../src/library/native-item-entity.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { prepareCollectionFixture } from '../helpers/collection-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 240000 };
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
const publicError = () => Object.assign(new Error('The event page operation was rejected.'), { code: 'page-rejected', status: 409, statusCode: 503 });
const reasons = [
  ...[['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]].map(([name, value]) => ({ name, create: () => value })),
  { name: 'public', create: publicError },
  ...['message', 'code', 'status', 'statusCode'].map(property => ({ name: `getter-${property}`, property, create() {
    const error = publicError(); Object.defineProperty(error, property, { get() { throw new Error('Diagnostic getter must not replace the failure.'); } }); return error;
  } })),
  { name: 'postgres', postgres: true },
];
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, !Object.hasOwn(descriptor, 'value') ? { accessor: true } : key === 'errors' ? descriptor.value.map(observation)
      : key === 'cause' ? observation(descriptor.value) : descriptor.value];
  }));
}
async function deadline(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Collection event owners did not drain.')), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, name) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, name + '-')), work = path.join(root, 'instance');
  const report = { backgroundErrors: [], cleanupErrors: [], cleanup: [], setup: [], scheduledScans: [], drains: [], observations: [] };
  const heldEvents = new Set(), heldPages = new Set(), restores = [];
  const faults = new AsyncLocalStorage();
  let database, runtime;
  t.after(async () => {
    const attempt = async (name, operation) => {
      const step = { name, status: 'running' }; report.cleanup.push(step);
      try { await operation(); step.status = 'completed'; }
      catch (error) { step.status = 'failed'; step.error = observation(error); report.cleanupErrors.push(step.error); }
    };
    await attempt('fault-scope-disable', () => faults.disable());
    for (const [index, restore] of restores.toReversed().entries()) await attempt(`restore-${index}`, restore);
    await attempt('monitor-close', () => runtime?.collections.monitor.close());
    await attempt('tasks-close', () => runtime?.tasks.close());
    for (const [index, page] of [...heldPages].entries()) await attempt(`page-${index}`, () => page.release());
    for (const [index, event] of [...heldEvents].entries()) await attempt(`event-${index}`, () => event.release());
    await attempt('collection-drain', () => runtime?.collections.drainForItem());
    await attempt('metadata-drain', () => runtime?.metadata.drain());
    await attempt('saver-drain', () => runtime?.metadata.saver.drain());
    await attempt('runtime-close', () => runtime?.close());
    await attempt('database-drop', () => dropPostgresTestDatabase(database));
    await attempt('instance-remove', async () => {
      assert.equal(path.dirname(path.resolve(work)), path.resolve(root)); await fs.rm(work, { recursive: true, force: true });
    });
    try { await fs.writeFile(path.join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { report.cleanupErrors.push(observation(error)); }
    assert.deepEqual(report.cleanupErrors, []);
    assert.deepEqual(report.backgroundErrors, []);
  });
  database = await createPostgresTestDatabase(null, 'event_pages');
  report.schemas = [database.schemaName, database.controlSchema];
  runtime = await createTestRuntime({ database, programDataPath: path.join(work, 'program'), serverId: name,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, onError: error => report.backgroundErrors.push(observation(error)) });
  assert.equal(runtime.plugins.get('local').enabled, true);
  const ancestors = path.join(work, 'empty-ignore-ancestors'); await fs.mkdir(ancestors, { recursive: true });
  const configuration = runtime.storage.configuration(), style = process.platform === 'win32' ? 'windows' : 'posix';
  configuration.instances.push({ id: 'event-ignore-ancestors', type: 'local', config: { root: ancestors, writable: false } });
  configuration.mounts.push({ path: '/event-ignore-ancestors', instanceId: 'event-ignore-ancestors', capabilities: {} });
  configuration.ignorePrefixes = [{ identityRoot: path.parse(work).root, accessRoot: '/event-ignore-ancestors',
    style, caseSensitive: style === 'posix', returnAccess: 'Known empty ignore ancestors for real Collection event resources.' }];
  await runtime.storage.configure(configuration);
  const drain = await prepareCollectionFixture(runtime, report);
  const members = [0, 1].map(index => {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
    Object.assign(item, { Id: `ce290000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, Name: `Event member ${index + 1}`,
      Path: path.join(runtime.library.options.dataPath, 'members', `Event member ${index + 1}`), DateCreated: '2026-01-02T03:04:05.0000000Z' });
    return item;
  });
  for (const member of members) await runtime.fileSystem.mkdir(member.Path, { recursive: true });
  await runtime.itemCreation.createItems(members);
  const links = runtime.collections.linkedChildren, expected = [members[0], members[0], members[1]].map(item => idKey(item.Id));
  const flush = links.flushReleases.bind(links);
  restores.push(() => { links.flushReleases = flush; });
  links.flushReleases = async options => {
    const sample = faults.getStore();
    const selected = sample?.active && sample.pageOwnerReleased && options?.session && !sample.flushing;
    if (selected) sample.flushing = true;
    await flush(options);
    if (selected) { sample.flushed = true; throw 0; }
  };
  const makeEvent = async label => {
    const collection = await runtime.collections.create({ Name: label, ItemIdList: [] });
    await drain('created-' + label);
    const sourceSets = [];
    for (const member of members) await runtime.itemCreation.withItem(member.Id, async current => {
      const relation = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId: member.Id });
        await writer.append({ Path: 'event-owned-source-' + member.Id, Type: 0 }); return writer.finish();
      });
      sourceSets.push(relation.entry.id); publishNativeItemLinks(current, relation);
    });
    let event;
    const listener = payload => {
      if (idKey(payload.Collection.Id) !== idKey(collection.Id)) return;
      event = payload.Items.retain(); heldEvents.add(event);
    };
    runtime.collections.on('ItemsAddedToCollection', listener);
    try { await runtime.collections.add(collection.Id, [members[0].Id, members[0].Id, members[1].Id]); }
    finally { runtime.collections.off('ItemsAddedToCollection', listener); }
    await drain('members-added-' + label);
    assert.ok(event); assert.equal(event.count, 3n);
    const scopeId = event.view.entry.id;
    const pins = (await database.client.query(`SELECT DISTINCT set_id FROM ${links.pins} WHERE scope_id=$1`, [scopeId])).rows.map(row => row.set_id);
    assert.deepEqual(new Set(pins), new Set(sourceSets), 'The actual event captures both Folder link resources.');
    // The retained event now has to preserve these nonpersisted raw links by
    // its SQL pins after the source cache owners leave.
    for (const member of members) runtime.itemCreation.unregisterItem(member.Id);
    await links.flushReleases();
    assert.equal(Number((await database.client.query(`SELECT count(*) AS count FROM ${links.sets} WHERE id=ANY($1::uuid[])`, [sourceSets])).rows[0].count), 2);
    return { event, scopeId, sourceSets, collection };
  };
  const resourcesGone = async ({ event, scopeId, sourceSets }) => {
    await event.release(); heldEvents.delete(event); await links.flushReleases();
    await deadline(runtime.collections.eventScope.drain());
    const counts = {};
    for (const table of ['item_states', 'item_cohorts', 'pins']) counts[table] = Number((await database.client.query(
      `SELECT count(*) AS count FROM ${q(links.schemaName)}.${table} WHERE scope_id=$1`, [scopeId])).rows[0].count);
    for (const [name, table, key] of [['sets', links.sets, 'id'], ['rows', links.rows, 'set_id']]) counts[name] = Number((await database.client.query(
      `SELECT count(*) AS count FROM ${table} WHERE ${key}=ANY($1::uuid[])`, [sourceSets])).rows[0].count);
    assert.deepEqual(counts, { item_states: 0, item_cohorts: 0, pins: 0, sets: 0, rows: 0 }); return counts;
  };
  const readAll = async event => {
    const actual = [];
    for await (const page of event.pages({ limit: 2 })) actual.push(...page.entries.map(row => idKey(row.Item.Id)));
    assert.deepEqual(actual, expected); return actual;
  };
  const arm = (event, sample, depth = 0) => {
    const retain = event.retain.bind(event);
    event.retain = () => {
      const retained = retain();
      if (faults.getStore() !== sample || !sample.active) return retained;
      const level = depth + 1, finalIteratorOwner = sample.iterator && level === 1;
      arm(retained, sample, level);
      const release = retained.release.bind(retained);
      retained.release = async (...args) => {
        await release(...args);
        if (!sample.active) return;
        if (finalIteratorOwner) { sample.iteratorOwnerReleased = true; throw ''; }
        sample.pageOwnerReleased = true; sample.pageOwnerReleases++; throw false;
      };
      if (!finalIteratorOwner) {
        const page = retained.view.page.bind(retained.view);
        retained.view.page = async options => {
          const captured = await page(options); heldPages.add(captured); sample.actualPageReads++;
          const releaseCaptured = async () => { await captured.release(); heldPages.delete(captured); };
          assert.deepEqual(captured.entries.map(row => idKey(row.item.Id)), expected.slice(0, options.limit ?? 128));
          if (sample.mode === 'read') { await releaseCaptured(); throw sample.primary; }
          return Object.freeze({ entries: captured.entries, async release() {
            await releaseCaptured(); sample.capturedReleased = true;
            if (sample.active) throw sample.iterator ? sample.pageFailure : sample.primary;
          } });
        };
      }
      return retained;
    };
  };
  const preparePrimary = async reason => {
    if (!reason.postgres) return reason.create();
    try { await database.client.query('SELECT missing_event_page_column FROM "BaseItems"'); }
    catch (error) { return Object.assign(error, { status: 409, statusCode: 503 }); }
    assert.fail('The real PostgreSQL column lookup must fail.');
  };
  return { runtime, database, links, faults, report, heldEvents, heldPages, restores, expected, makeEvent, resourcesGone, readAll, arm, preparePrimary };
}

function publicFields(error, primary, reason) {
  if (!(primary instanceof Error)) return;
  for (const key of ['code', 'status', 'statusCode']) assert.equal(error[key], reason.property === key ? undefined : primary[key]);
}

test('Collection event pages retain actual read failures and every release failure without losing native or SQL owners', pg, async t => {
  const f = await fixture(t, 'collection-event-pages');
  for (const mode of ['read', 'release']) for (const reason of reasons) await t.test(mode + '-' + reason.name, async () => {
    const resource = await f.makeEvent(mode + ' ' + reason.name), primary = await f.preparePrimary(reason);
    const sample = { mode, primary, active: true, pageOwnerReleases: 0, actualPageReads: 0 };
    f.arm(resource.event, sample);
    let result, page;
    try {
      result = await outcome(f.faults.run(sample, async () => {
        page = await resource.event.page({ limit: 2 }); f.heldPages.add(page);
        assert.deepEqual(page.entries.map(row => idKey(row.Item.Id)), f.expected.slice(0, 2));
        await page.release();
      }));
    } finally { sample.active = false; }
    if (page) { await page.release(); f.heldPages.delete(page); }
    assert.ok(Object.hasOwn(result, 'error')); assert.deepEqual(flatten(result.error), [primary, false, 0]);
    publicFields(result.error, primary, reason);
    assert.equal(sample.actualPageReads, 1); assert.equal(sample.pageOwnerReleases, 1); assert.equal(sample.flushed, true);
    assert.equal(sample.capturedReleased, mode === 'release' ? true : undefined);
    const recovered = await f.readAll(resource.event), counts = await f.resourcesGone(resource);
    f.report.observations.push({ mode, reason: reason.name, failure: observation(result.error), actualPageReads: sample.actualPageReads,
      pageOwnerReleases: sample.pageOwnerReleases, releasedCounts: counts, recovered });
  });
});

test('Collection event iteration preserves consumer throws through page and iterator cleanup, including falsy and diagnostic reasons', pg, async t => {
  const f = await fixture(t, 'collection-event-iteration');
  for (const reason of reasons) await t.test(reason.name, async () => {
    const resource = await f.makeEvent('iterator ' + reason.name), primary = await f.preparePrimary(reason);
    const pageFailure = new Error('The captured native page reported release failure.');
    const sample = { iterator: true, primary, pageFailure, active: true, pageOwnerReleases: 0, actualPageReads: 0 };
    f.arm(resource.event, sample);
    const iterator = resource.event.pages({ limit: 2 }); let result;
    try {
      const first = await f.faults.run(sample, () => iterator.next());
      assert.equal(first.done, false); assert.deepEqual(first.value.entries.map(row => idKey(row.Item.Id)), f.expected.slice(0, 2));
      result = await outcome(f.faults.run(sample, () => iterator.throw(primary)));
    } finally { sample.active = false; await iterator.return(); }
    assert.ok(Object.hasOwn(result, 'error')); assert.deepEqual(flatten(result.error), [primary, pageFailure, false, 0, '']);
    publicFields(result.error, primary, reason);
    assert.equal(sample.actualPageReads, 1); assert.equal(sample.pageOwnerReleases, 1);
    assert.equal(sample.capturedReleased, true); assert.equal(sample.flushed, true); assert.equal(sample.iteratorOwnerReleased, true);
    const recovered = await f.readAll(resource.event), counts = await f.resourcesGone(resource);
    f.report.observations.push({ reason: reason.name, failure: observation(result.error), releasedCounts: counts, recovered });
  });
  for (const action of ['return', 'next']) await t.test('cleanup-only-' + action, async () => {
    const resource = await f.makeEvent('iterator cleanup ' + action), pageFailure = publicError();
    const sample = { iterator: true, pageFailure, active: true, pageOwnerReleases: 0, actualPageReads: 0 };
    f.arm(resource.event, sample); const iterator = resource.event.pages({ limit: 2 }); let result;
    try {
      await f.faults.run(sample, () => iterator.next());
      result = await outcome(f.faults.run(sample, () => iterator[action]('stopped')));
    } finally { sample.active = false; await iterator.return(); }
    assert.ok(Object.hasOwn(result, 'error')); assert.deepEqual(flatten(result.error), [pageFailure, false, 0, '']);
    publicFields(result.error, pageFailure, {}); assert.equal(sample.iteratorOwnerReleased, true);
    const recovered = await f.readAll(resource.event), counts = await f.resourcesGone(resource);
    f.report.observations.push({ action, failure: observation(result.error), releasedCounts: counts, recovered });
  });
  await t.test('normal-return-and-new-request', async () => {
    const resource = await f.makeEvent('normal iterator return'), iterator = resource.event.pages({ limit: 1 });
    const first = await iterator.next(); assert.equal(first.done, false); assert.equal(idKey(first.value.entries[0].Item.Id), f.expected[0]);
    assert.deepEqual(await iterator.return('stopped'), { value: 'stopped', done: true });
    await first.value.release();
    let drained = false; const draining = f.runtime.collections.eventScope.drain().then(() => { drained = true; });
    await immediate(); assert.equal(drained, false, 'Only the retained root event should still own the scope.');
    await f.readAll(resource.event); const counts = await f.resourcesGone(resource); await deadline(draining);
    const recovered = await f.makeEvent('new event after every failure');
    const paths = await f.readAll(recovered.event), recoveryCounts = await f.resourcesGone(recovered);
    f.report.observations.push({ normalReturn: 'stopped', drained, releasedCounts: counts, newRequest: paths, recoveryCounts });
  });
});

async function saturateNativePool(database, restores) {
  const pool = database.pool, held = new Set(), backends = [];
  const original = { max: pool.options.max, connectionTimeoutMillis: pool.options.connectionTimeoutMillis };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; Object.assign(pool.options, original);
    const errors = [];
    for (const client of held) {
      held.delete(client);
      try { client.release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'The native test connections did not all return.');
  };
  // A failed assertion must return every physical connection before fixture
  // owner cleanup or runtime shutdown can try to acquire the native pool.
  restores.push(restore);
  try {
    pool.options.max = Math.max(1, pool.totalCount);
    for (let index = 0; index < pool.options.max; index++) {
      const client = await pool.connect(); held.add(client);
      backends.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    }
    assert.equal(new Set(backends).size, pool.options.max);
    assert.equal(pool.totalCount, held.size); assert.equal(pool.idleCount, 0); assert.equal(pool.waitingCount, 0);
    // This is pg-pool's real checkout queue timeout, not a replacement for
    // DomainStore.run or the PostgreSQL connection operation.
    pool.options.connectionTimeoutMillis = 100;
    return { restore, backends, pool };
  } catch (error) { restore(); throw error; }
}

test('Collection event page admission failures drain actual SQL and item owners through the independent relation pool', pg, async t => {
  const f = await fixture(t, 'collection-event-page-admission');
  for (const mode of ['admission', 'admission-and-cleanup', 'admitted-cleanup']) await t.test(mode, async () => {
    const resource = await f.makeEvent(mode), injectedCleanup = mode !== 'admission', admitted = mode === 'admitted-cleanup';
    // Setup closed scan/watch producers and makeEvent drained the Collection
    // refresh and saver before we occupy the native slots.
    await f.runtime.store.run(() => undefined);
    const sample = { active: false, ownerCalls: 0, capturedCalls: 0, finalFlushes: 0, ownerCounts: [] };
    const ownedSets = [...resource.sourceSets, resource.event.collection.LinkedChildren.entry.id];
    const observer = observeNativeItemLinkOwnership(resource.event.collection, event => sample.ownerCounts.push({ phase: event.phase, count: event.count }));
    const capturedFailure = publicError(), retain = resource.event.retain.bind(resource.event), flush = f.links.flushReleases.bind(f.links);
    let retained, page, saturated, result, counts, relationBackend;
    const restoreHooks = () => { sample.active = false; resource.event.retain = retain; f.links.flushReleases = flush; observer.release(); };
    f.restores.push(restoreHooks);
    resource.event.retain = () => {
      retained = retain(); f.heldEvents.add(retained);
      const release = retained.release.bind(retained), capture = retained.view.page.bind(retained.view);
      retained.release = async options => {
        if (sample.active) { sample.ownerCalls++; sample.ownerSession = Boolean(options?.session); }
        await release(options); f.heldEvents.delete(retained);
        if (sample.active) { sample.ownerReleased = true; if (injectedCleanup) throw false; }
      };
      retained.view.page = async options => {
        const captured = await capture(options); f.heldPages.add(captured);
        return Object.freeze({ entries: captured.entries, async release() {
          await captured.release(); f.heldPages.delete(captured);
          if (sample.active) { sample.capturedCalls++; if (injectedCleanup) throw capturedFailure; }
        } });
      };
      return retained;
    };
    f.links.flushReleases = async options => {
      await flush(options);
      if (f.faults.getStore() !== sample || !sample.active || !sample.ownerReleased) return;
      sample.finalFlushes++; sample.flushSession = Boolean(options?.session);
      if (injectedCleanup) throw 0;
    };
    try {
      page = await resource.event.page({ limit: 2 }); f.heldPages.add(page);
      assert.deepEqual(page.entries.map(row => idKey(row.Item.Id)), f.expected.slice(0, 2));
      f.runtime.itemCreation.unregisterItem(resource.event.collection.Id);
      await resource.event.release(); f.heldEvents.delete(resource.event); await f.links.flushReleases();
      assert.equal(sample.ownerCounts.at(-1).count, 1, 'Only the page owns the exact collection after its root event and cache leave.');
      if (!admitted) saturated = await saturateNativePool(f.database, f.restores);
      sample.active = true;
      result = await outcome(f.faults.run(sample, () => page.release()));
      sample.active = false;
      assert.ok(Object.hasOwn(result, 'error'));
      const errors = flatten(result.error);
      if (admitted) assert.deepEqual(errors, [capturedFailure, false, 0]);
      else {
        const admission = errors[injectedCleanup ? 1 : 0];
        assert.equal(admission.message, 'timeout exceeded when trying to connect');
        assert.deepEqual(errors, injectedCleanup ? [capturedFailure, admission, false, 0] : [admission]);
        if (!injectedCleanup) assert.equal(result.error, admission, 'A lone native admission error keeps its identity.');
      }
      if (injectedCleanup) publicFields(result.error, capturedFailure, {});
      assert.equal(sample.capturedCalls, 1); assert.equal(sample.ownerCalls, 1); assert.equal(sample.finalFlushes, 1);
      assert.equal(sample.ownerSession, admitted); assert.equal(sample.flushSession, admitted);
      assert.equal(sample.ownerCounts.at(-1).count, 0, 'The page releases the last exact native item lease.');
      // Inspect through the independent real connection while every native
      // backend is still held. Native admission cannot have made this progress.
      counts = await f.links.relationDatabase.withConnection(async session => {
        relationBackend = Number((await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const values = {};
        for (const table of ['item_states', 'item_cohorts', 'pins']) values[table] = Number((await session.client.query(
          `SELECT count(*) AS count FROM ${q(f.links.schemaName)}.${table} WHERE scope_id=$1`, [resource.scopeId])).rows[0].count);
        for (const [name, table, key] of [['sets', f.links.sets, 'id'], ['rows', f.links.rows, 'set_id']]) values[name] = Number((await session.client.query(
          `SELECT count(*) AS count FROM ${table} WHERE ${key}=ANY($1::uuid[])`, [ownedSets])).rows[0].count);
        return values;
      });
      assert.deepEqual(counts, { item_states: 0, item_cohorts: 0, pins: 0, sets: 0, rows: 0 });
      await deadline(f.runtime.collections.eventScope.drain());
      if (saturated) {
        assert.equal(saturated.backends.includes(relationBackend), false);
        assert.equal(saturated.pool.totalCount, saturated.backends.length);
        assert.equal(saturated.pool.idleCount, 0); assert.equal(saturated.pool.waitingCount, 0);
      }
      await page.release(); assert.equal(sample.ownerCalls, 1);
    } finally {
      // Always restore admission before joining any remaining operation or
      // owner, including failures in page creation and the assertions above.
      saturated?.restore(); restoreHooks();
      await page?.release(); if (page) f.heldPages.delete(page);
      await retained?.release(); if (retained) f.heldEvents.delete(retained);
      await resource.event.release(); f.heldEvents.delete(resource.event);
    }
    assert.equal(f.database.pool.waitingCount, 0); await f.resourcesGone(resource);
    const recovered = await f.makeEvent(mode + ' recovered'), recoveredItems = await f.readAll(recovered.event), recoveryCounts = await f.resourcesGone(recovered);
    f.report.observations.push({ mode, failure: observation(result.error), nativeBackends: saturated?.backends ?? [], relationBackend, ownedSets,
      ownerCalls: sample.ownerCalls, capturedCalls: sample.capturedCalls, finalFlushes: sample.finalFlushes,
      ownerSession: sample.ownerSession, flushSession: sample.flushSession, ownerCounts: sample.ownerCounts,
      releasedCounts: counts, recoveredItems, recoveryCounts });
  });
});
