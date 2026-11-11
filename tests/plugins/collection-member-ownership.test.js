import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { prepareCollectionFixture } from '../helpers/collection-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000 };
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
async function deadline(operation, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, name) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, name + '-')), work = path.join(root, 'instance');
  const report = { backgroundErrors: [], cleanupErrors: [], cleanup: [], setup: [], scheduledScans: [], drains: [], observations: [] };
  const restores = [], heldEvents = new Set(), heldRelations = new Set();
  let database, runtime;
  // Every cleanup belongs to this hook: an assertion in one hook would prevent
  // node:test from reaching a later database fixture hook.
  t.after(async () => {
    const attempt = async (name, operation) => {
      const step = { name, status: 'running' }; report.cleanup.push(step);
      try { await operation(); step.status = 'completed'; }
      catch (error) { step.status = 'failed'; step.error = errorObservation(error); report.cleanupErrors.push(step.error); }
    };
    for (const [index, restore] of restores.toReversed().entries()) await attempt(`restore-${index}`, restore);
    await attempt('monitor-close', () => runtime?.collections.monitor.close());
    await attempt('tasks-close', () => runtime?.tasks.close());
    for (const [index, event] of [...heldEvents].entries()) await attempt(`event-${index}`, () => event.release());
    for (const [index, relation] of [...heldRelations].entries()) await attempt(`relation-${index}`, () => runtime?.collections.linkedChildren.release(relation));
    await attempt('collection-drain', () => runtime?.collections.drainForItem());
    await attempt('metadata-drain', () => runtime?.metadata.drain());
    await attempt('saver-drain', () => runtime?.metadata.saver.drain());
    await attempt('runtime-close', () => runtime?.close());
    await attempt('database-drop', () => dropPostgresTestDatabase(database));
    await attempt('instance-remove', async () => {
      assert.equal(path.dirname(path.resolve(work)), path.resolve(root)); await fs.rm(work, { recursive: true, force: true });
    });
    try { await fs.writeFile(path.join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { report.cleanupErrors.push(errorObservation(error)); }
    assert.deepEqual(report.cleanupErrors, []);
    assert.deepEqual(report.backgroundErrors, [], 'Request fault injection must not reach background metadata operations.');
  });
  database = await createPostgresTestDatabase(null, 'collection_members');
  report.schemas = [database.schemaName, database.controlSchema];
  runtime = await createTestRuntime({ database, programDataPath: path.join(work, 'program'), serverId: name,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    onError: error => report.backgroundErrors.push(errorObservation(error)) });
  assert.equal(runtime.plugins.get('local').enabled, true);
  const ancestors = path.join(work, 'empty-ignore-ancestors'); await fs.mkdir(ancestors, { recursive: true });
  const configuration = runtime.storage.configuration(), style = process.platform === 'win32' ? 'windows' : 'posix';
  configuration.instances.push({ id: 'member-ignore-ancestors', type: 'local', config: { root: ancestors, writable: false } });
  configuration.mounts.push({ path: '/member-ignore-ancestors', instanceId: 'member-ignore-ancestors', capabilities: {} });
  configuration.ignorePrefixes = [{ identityRoot: path.parse(work).root, accessRoot: '/member-ignore-ancestors',
    style, caseSensitive: style === 'posix', returnAccess: 'Known empty ignore ancestors for this isolated member fixture.' }];
  await runtime.storage.configure(configuration);
  const drain = await prepareCollectionFixture(runtime, report);
  const members = [0, 1, 2].map(index => {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
    Object.assign(item, { Id: `ce240000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, Name: `Member ${index + 1}`,
      Path: path.join(runtime.library.options.dataPath, 'members', `Member ${index + 1}`), DateCreated: '2026-01-02T03:04:05.0000000Z' });
    return item;
  });
  for (const member of members) await runtime.fileSystem.mkdir(member.Path, { recursive: true });
  await runtime.itemCreation.createItems(members);
  const links = runtime.collections.linkedChildren;
  const collection = async (name, initial = []) => {
    const item = await runtime.collections.create({ Name: name, ItemIdList: initial.map(member => member.Id) });
    await drain('created-' + name);
    return runtime.itemCreation.withItem(item.Id, async current => { await runtime.collections.updateRepository(current); return current; });
  };
  const persisted = async item => (await database.rows('LinkedChildren', { where: { ParentId: item.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId));
  const xml = item => runtime.fileSystem.readFile(path.join(item.Path, 'collection.xml'), 'utf8');
  const scopeEmpty = async scopeId => {
    const counts = {};
    for (const table of ['item_cohorts', 'item_states', 'pins']) {
      counts[table] = Number((await database.client.query(`SELECT count(*) AS count FROM ${q(links.schemaName)}.${table} WHERE scope_id=$1`, [scopeId])).rows[0].count);
    }
    assert.deepEqual(counts, { item_cohorts: 0, item_states: 0, pins: 0 }); return counts;
  };
  return { database, runtime, links, report, restores, heldEvents, heldRelations, members, collection, persisted, xml, scopeEmpty, drain };
}

test('Collection add and remove preserve committed Local XML and SQL when member owners and release flushes reject', pg, async t => {
  const f = await fixture(t, 'collection-member-owners');
  const { runtime, links, database, members, restores, report } = f;
  const retain = runtime.itemCreation.retainItem.bind(runtime.itemCreation), flush = links.flushReleases.bind(links);
  const update = runtime.collections.updateRepository, queue = runtime.collections.queueCollection.bind(runtime.collections);
  let selected;
  restores.push(() => { selected = undefined; runtime.itemCreation.retainItem = retain; links.flushReleases = flush;
    runtime.collections.updateRepository = update; runtime.collections.queueCollection = queue; });
  runtime.itemCreation.retainItem = item => {
    const owner = retain(item), current = selected;
    if (!current || idKey(item.Id) !== idKey(current.collection.Id) || ++current.retains !== 2) return owner;
    return { release() {
      owner.release(); current.ownerReleased = true; links.queueRelease(current.pending);
      current.awaitingFlush = true; throw false;
    } };
  };
  links.flushReleases = async options => {
    const current = selected, selectedFlush = current?.awaitingFlush === true;
    if (selectedFlush) { current.awaitingFlush = false; current.flushSession = options?.session?.connectionSession === true; }
    await flush(options);
    if (selectedFlush) { current.flushed = true; throw 0; }
  };
  runtime.collections.updateRepository = async item => {
    await update(item);
    if (selected && idKey(item.Id) === idKey(selected.collection.Id)) {
      selected.saved++;
      if (selected.kind === 'postgres') {
        try { await database.client.query('SELECT missing_member_owner_column FROM "BaseItems"'); }
        catch (error) { selected.primary = error; throw error; }
      }
      throw selected.primary;
    }
  };
  runtime.collections.queueCollection = (...args) => { if (selected) selected.queued++; return queue(...args); };
  for (const name of ['ItemsAddedToCollection', 'ItemsRemovedFromCollection']) {
    runtime.collections.on(name, () => { if (selected) selected.events++; });
  }
  for (const action of ['add', 'remove']) for (const [kind, primary] of [...reasons, ['postgres']]) {
    await t.test(action + '-' + kind, async () => {
      const collection = await f.collection(action + ' owner ' + kind, action === 'remove' ? [members[0]] : []);
      const pending = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId: collection.Id });
        await writer.append({ Path: 'owned-member-release', Type: 0 }); return writer.finish();
      });
      f.heldRelations.add(pending);
      const sample = { collection, pending, kind, primary, retains: 0, saved: 0, queued: 0, events: 0 };
      selected = sample;
      let result;
      try { result = await outcome(runtime.collections[action](collection.Id, [members[0].Id])); }
      finally { selected = undefined; }
      assert.ok(Object.hasOwn(result, 'error'));
      assert.deepEqual(flatten(result.error), [sample.primary, false, 0]);
      if (kind === 'postgres') { assert.equal(result.error.code, '42703'); assert.equal(result.error.cause, sample.primary); }
      assert.equal(sample.ownerReleased, true); assert.equal(sample.flushed, true); assert.equal(sample.flushSession, true);
      assert.equal(sample.saved, 1); assert.equal(sample.queued, 0); assert.equal(sample.events, 0);
      assert.equal(Number((await database.client.query(`SELECT count(*) AS count FROM ${links.sets} WHERE id=$1`, [pending.entry.id])).rows[0].count), 0);
      assert.deepEqual(await f.persisted(collection), action === 'add' ? [idKey(members[0].Id)] : []);
      assert.equal((await f.xml(collection)).includes(xmlText(members[0].Path)), action === 'add');
      await runtime.collections.add(collection.Id, [members[1].Id]); await f.drain(action + '-owner-recovery-' + kind);
      assert.ok((await f.persisted(collection)).includes(idKey(members[1].Id)));
      report.observations.push({ action, kind, failure: errorObservation(result.error), ownerReleased: sample.ownerReleased,
        releaseFlushedInOwnedSession: sample.flushSession, saved: sample.saved, queued: sample.queued, events: sample.events });
    });
  }
});

test('Collection request failures keep every falsy reason while real rejected TEMP drops retire sessions and release typed cohorts', pg, async t => {
  const f = await fixture(t, 'collection-member-temps');
  const { runtime, database, links, members, restores, report } = f;
  const query = database.client.query, releaseScope = links.releaseStateScope.bind(links);
  const mutationContext = new AsyncLocalStorage();
  restores.push(() => { mutationContext.disable(); database.client.query = query; links.releaseStateScope = releaseScope; });
  database.client.query = async (statement, ...args) => {
    const scope = mutationContext.getStore(), current = scope?.active ? scope : undefined;
    const sql = typeof statement === 'string' ? statement : statement.text;
    const values = typeof statement === 'string' ? args[0] : statement.values;
    if (current && sql.startsWith('CREATE TEMP TABLE "mm_collection_requests_')) {
      current.temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
      const result = await query(statement, ...args);
      current.backendPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await query(`CREATE TEMP VIEW rejected_member_drop AS SELECT * FROM ${current.temporary}`);
      return result;
    }
    if (current && sql.startsWith(`INSERT INTO ${q(links.schemaName)}.item_states`)) current.scopes.add(values[0]);
    try { return await query(statement, ...args); }
    catch (error) {
      if (current && sql === `DROP TABLE IF EXISTS ${current.temporary}`) current.rejectedDrop = error;
      throw error;
    }
  };
  links.releaseStateScope = async (...args) => {
    await releaseScope(...args);
    const current = mutationContext.getStore();
    if (current?.active && current.scopes.has(args[0])) { current.releasedScopes.push(args[0]); throw ''; }
  };
  for (const action of ['add', 'remove']) for (const [kind, primary] of reasons) {
    await t.test(action + '-' + kind, async () => {
      const collection = await f.collection(action + ' request ' + kind, action === 'remove' ? [members[0]] : []);
      const before = await f.persisted(collection), beforeXml = await f.xml(collection);
      const sample = { active: true, scopes: new Set(), releasedScopes: [] };
      function* request() { yield members[0].Id; throw primary; }
      let result;
      // The real manager queue inherits this request admission. A global time
      // window would also capture independently queued metadata cohorts.
      try { result = await outcome(mutationContext.run(sample, () => runtime.collections[action](collection.Id, request()))); }
      finally { sample.active = false; }
      assert.ok(Object.hasOwn(result, 'error')); const failures = flatten(result.error);
      assert.equal(failures[0], primary); assert.equal(sample.rejectedDrop.code, '2BP01');
      assert.ok(failures.includes(sample.rejectedDrop)); assert.equal(failures.at(-1), '');
      assert.ok(sample.scopes.size > 0); assert.deepEqual(new Set(sample.releasedScopes), sample.scopes);
      for (const scope of sample.scopes) await f.scopeEmpty(scope);
      assert.equal(Number((await query('SELECT count(*) AS count FROM pg_stat_activity WHERE pid=$1', [sample.backendPid])).rows[0].count), 0);
      assert.equal(Number((await query('SELECT count(*) AS count FROM pg_class WHERE relname=$1', [sample.temporary.slice(1, -1)])).rows[0].count), 0);
      assert.deepEqual(await f.persisted(collection), before); assert.equal(await f.xml(collection), beforeXml);
      await runtime.collections.add(collection.Id, [members[1].Id]); await f.drain(action + '-request-recovery-' + kind);
      assert.ok((await f.persisted(collection)).includes(idKey(members[1].Id)));
      report.observations.push({ action, kind, failure: errorObservation(result.error), temporary: sample.temporary,
        backendPid: sample.backendPid, backendRetired: true, releasedScopes: sample.releasedScopes, committedMembers: before });
    });
  }
});

test('Collection event failure releases its borrowed owners in order while retained typed requests keep independent SQL lifetime', pg, async t => {
  const f = await fixture(t, 'collection-member-events');
  const { runtime, members, restores, report, heldEvents } = f;
  const acquire = runtime.collections.eventScope.acquire.bind(runtime.collections.eventScope), retain = runtime.itemCreation.retainItem.bind(runtime.itemCreation);
  const queue = runtime.collections.queueCollection.bind(runtime.collections);
  let selected, acquiring;
  restores.push(() => { selected = acquiring = undefined; runtime.collections.eventScope.acquire = acquire;
    runtime.itemCreation.retainItem = retain; runtime.collections.queueCollection = queue; });
  runtime.collections.eventScope.acquire = () => {
    const release = acquire(), current = selected, number = current ? ++current.eventOwners : 0;
    if (current) acquiring = { current, number };
    return () => { release(); if (current && number === 1) { current.scopeReleased = true; throw ''; } };
  };
  runtime.itemCreation.retainItem = item => {
    const owner = retain(item), current = acquiring; acquiring = undefined;
    if (!current || current.number !== 1) return owner;
    return { release() { owner.release(); current.current.itemReleased = true; throw 0; } };
  };
  runtime.collections.queueCollection = (...args) => { if (selected) selected.queued++; return queue(...args); };
  for (const name of ['ItemsAddedToCollection', 'ItemsRemovedFromCollection']) runtime.collections.on(name, ({ Items }) => {
    if (!selected) return;
    selected.events++;
    selected.retained = Items.retain(); heldEvents.add(selected.retained);
    selected.scopeId = Items.view.entry.id;
    const release = Items.view.release.bind(Items.view), current = selected;
    Items.view.release = async (...args) => { await release(...args); current.viewReleased = true; throw false; };
    throw selected.primary;
  });
  for (const action of ['add', 'remove']) await t.test(action, async () => {
    const collection = await f.collection(action + ' event', action === 'remove' ? members.slice(0, 2) : []);
    const primary = Object.assign(new Error('The event listener rejected its already delivered request.'), { code: 'event-rejected', status: 409, statusCode: 409 });
    const sample = { primary, eventOwners: 0, events: 0, queued: 0 }; selected = sample;
    let result;
    try { result = await outcome(runtime.collections[action](collection.Id, [members[0].Id, members[0].Id, members[1].Id])); }
    finally { selected = acquiring = undefined; }
    assert.ok(Object.hasOwn(result, 'error')); assert.deepEqual(flatten(result.error), [primary, false, 0, '']);
    assert.equal(result.error.cause, primary); assert.equal(result.error.code, primary.code);
    assert.equal(result.error.status, 409); assert.equal(result.error.statusCode, 409);
    assert.equal(sample.events, 1); assert.equal(sample.queued, 1);
    assert.equal(sample.viewReleased, true); assert.equal(sample.itemReleased, true); assert.equal(sample.scopeReleased, true);
    await f.drain(action + '-event-commit');
    assert.deepEqual(await f.persisted(collection), action === 'add' ? members.slice(0, 2).map(item => idKey(item.Id)) : []);
    const savedXml = await f.xml(collection);
    for (const member of members.slice(0, 2)) assert.equal(savedXml.includes(xmlText(member.Path)), action === 'add');
    let drained = false; const draining = runtime.collections.eventScope.drain().then(() => { drained = true; });
    await immediate(); assert.equal(drained, false, 'The event scope still belongs to the listener.');
    assert.equal(sample.retained.count, 3n);
    const page = await sample.retained.page();
    try { assert.deepEqual(page.entries.map(row => idKey(row.Item.Id)), [members[0], members[0], members[1]].map(item => idKey(item.Id))); }
    finally { await page.release(); }
    await sample.retained.release(); heldEvents.delete(sample.retained);
    await deadline(draining, 'The released event scope did not drain.'); await f.scopeEmpty(sample.scopeId);
    await runtime.collections.add(collection.Id, [members[2].Id]); await f.drain(action + '-event-recovery');
    assert.ok((await f.persisted(collection)).includes(idKey(members[2].Id)));
    report.observations.push({ action, failure: errorObservation(result.error), saved: true, queued: sample.queued,
      delivered: sample.events, scopeId: sample.scopeId, retainedRequestCount: 3, scopeDrained: drained });
  });
});

test('Collection event construction and listener retain failures leave no scope or unreturned SQL view lease', pg, async t => {
  const f = await fixture(t, 'collection-event-acquisition');
  const { runtime, database, links, members, restores, report, heldEvents } = f;
  const acquire = runtime.collections.eventScope.acquire.bind(runtime.collections.eventScope), retain = runtime.itemCreation.retainItem.bind(runtime.itemCreation);
  const query = database.client.query;
  let selected, acquiring;
  restores.push(() => { selected = acquiring = undefined; runtime.collections.eventScope.acquire = acquire;
    runtime.itemCreation.retainItem = retain; database.client.query = query; });
  runtime.collections.eventScope.acquire = () => {
    const release = acquire(), current = selected, number = current ? ++current.eventOwners : 0;
    if (current) acquiring = { current, number };
    return () => { release(); if (current && number === current.rejectOwner) { current.scopeReleased = true; throw 0; } };
  };
  runtime.itemCreation.retainItem = item => {
    const current = acquiring; acquiring = undefined;
    if (current && current.number === current.current.rejectOwner) throw false;
    return retain(item);
  };
  database.client.query = async (statement, ...args) => {
    const sql = typeof statement === 'string' ? statement : statement.text, values = typeof statement === 'string' ? args[0] : statement.values;
    if (selected && sql.startsWith(`INSERT INTO ${q(links.schemaName)}.item_states`)) selected.scopes.add(values[0]);
    return query(statement, ...args);
  };
  runtime.collections.on('ItemsAddedToCollection', ({ Items }) => {
    if (!selected) return;
    selected.events++;
    const before = Items.view.entry.references;
    try { Items.retain(); assert.fail('The selected synchronous item owner must reject the retain.'); }
    catch (error) { selected.retainFailure = error; }
    assert.equal(Items.view.entry.references, before, 'A rejected retain cannot create an unreachable SQL view owner.');
    selected.retained = Items.retain(); heldEvents.add(selected.retained);
    selected.scopeId = Items.view.entry.id;
  });
  for (const rejectOwner of [1, 2]) await t.test(rejectOwner === 1 ? 'initial-event' : 'listener-retain', async () => {
    const collection = await f.collection('event acquisition ' + rejectOwner);
    const sample = { rejectOwner, eventOwners: 0, events: 0, scopes: new Set() }; selected = sample;
    let result;
    try { result = await outcome(runtime.collections.add(collection.Id, [members[0].Id, members[0].Id])); }
    finally { selected = acquiring = undefined; }
    assert.equal(sample.scopeReleased, true);
    if (rejectOwner === 1) {
      assert.ok(Object.hasOwn(result, 'error')); assert.deepEqual(flatten(result.error), [false, 0]); assert.equal(sample.events, 0);
    } else {
      assert.equal(Object.hasOwn(result, 'error'), false); assert.deepEqual(flatten(sample.retainFailure), [false, 0]); assert.equal(sample.events, 1);
      const page = await sample.retained.page();
      try { assert.deepEqual(page.entries.map(row => idKey(row.Item.Id)), [idKey(members[0].Id), idKey(members[0].Id)]); }
      finally { await page.release(); }
      await sample.retained.release(); heldEvents.delete(sample.retained);
    }
    await deadline(runtime.collections.eventScope.drain(), 'A failed event constructor left its shutdown scope acquired.');
    await f.drain('event-acquisition-' + rejectOwner); assert.ok(sample.scopes.size > 0);
    for (const scope of sample.scopes) await f.scopeEmpty(scope);
    assert.deepEqual(await f.persisted(collection), [idKey(members[0].Id)]); assert.ok((await f.xml(collection)).includes(xmlText(members[0].Path)));
    await runtime.collections.add(collection.Id, [members[1].Id]); await f.drain('event-acquisition-recovery-' + rejectOwner);
    assert.deepEqual(await f.persisted(collection), members.slice(0, 2).map(item => idKey(item.Id)));
    report.observations.push({ rejectOwner, failure: errorObservation(rejectOwner === 1 ? result.error : sample.retainFailure),
      delivered: sample.events, retainedRequestCount: rejectOwner === 1 ? 0 : 2, scopes: [...sample.scopes], scopeDrained: true });
  });
});
