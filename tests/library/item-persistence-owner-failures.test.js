import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { newNativeItemEntity, publishNativeItemLinks } from '../../src/library/native-item-entity.js';
import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { readTestLinkIds } from './collection-test-consumers.js';
import { libraryFailureFixture, outcome, functional, observation } from './library-failure-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000 };
const snapshot = database => Promise.all(nativeModel.tables.map(async table => [table.name,
  await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])).then(Object.fromEntries);
const tempRelations = `SELECT c.oid::text AS oid,c.relname AS name FROM pg_catalog.pg_class c
  WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relkind IN ('r','p') ORDER BY c.oid`;
const backendIdentity = `SELECT pid,extract(epoch FROM backend_start)::text AS started
  FROM pg_stat_activity WHERE pid=pg_backend_pid()`;
const resourceRows = async (fixture, session) => (await session.client.query(`SELECT source.id::text AS "setId",
  encode(source.parent_id,'hex') AS "parentBytes",child."Ordinal"::text AS ordinal,
  encode(child."ItemId",'hex') AS "itemBytes",child."Type" AS type
  FROM ${fixture.links.sets} source LEFT JOIN ${fixture.links.rows} child ON child.set_id=source.id
  ORDER BY source.id,child."Ordinal",child.revision`)).rows;

function reasons(reason, expected) {
  const value = functional(reason);
  if (expected.some(entry => isDeepStrictEqual(value, functional(entry)))) return [value];
  return reason != null && Array.isArray(reason.errors) ? reason.errors.flatMap(entry => reasons(entry, expected)) : [value];
}
function firstCause(reason) {
  while (reason != null && Array.isArray(reason.errors)) {
    assert.ok(Object.hasOwn(reason, 'cause'));
    assert.deepEqual(functional(reason.cause), functional(reason.errors[0]));
    reason = reason.cause;
  }
  return reason;
}
function verifyReasons(actual, expected) {
  assert.deepEqual(reasons(actual, expected), expected.map(functional));
  assert.deepEqual(functional(firstCause(actual)), functional(expected[0]));
}
async function verifyLocal(fixture) {
  for (const name of ['source.png', 'root.png']) {
    assert.deepEqual(await fixture.fileSystem.readFile(path.join(fixture.files, name)), fixture.source);
  }
}
async function sources(fixture, session, record) {
  const { creator, ids, links } = fixture;
  const folders = [await creator.getItemById(ids.root), await creator.getItemById(ids.series)];
  const holders = folders.map(item => creator.retainItem(item));
  for (const item of folders) creator.unregisterItem(item.Id);
  assert.deepEqual(await readTestLinkIds(folders[0]), [idKey(ids.first), idKey(ids.next)]);
  assert.deepEqual(await readTestLinkIds(folders[1]), [idKey(ids.season)]);
  await links.flushOwnedReleases(); await links.flushReleases();
  record.sourceResources = (await resourceRows(fixture, session)).filter(row =>
    folders.some(item => idKey(item.Id) === idKey(Buffer.from(row.parentBytes, 'hex').toString('utf8'))));
  assert.ok(record.sourceResources.length > 0, 'The real source folders have populated SQL link branches.');
  await fixture.persist(folders[0], 'Committed prefix before ' + record.name);
  record.committedPrefix = await snapshot(session);
  record.backendBefore = (await session.client.query(backendIdentity)).rows[0];
  record.tempBefore = (await session.client.query(tempRelations)).rows;
  return { folders, holders };
}
function flushGate(fixture, current, actual) {
  return async function (...args) {
    const result = await actual.apply(this, args);
    if (current.outerFlushArmed && !current.flushEntered) {
      current.record.events.push('actual final SQL flush finished');
      current.record.atHeldFlush = await resourceRows(fixture, current.session);
      current.record.tempAtHeldFlush = (await current.session.client.query(tempRelations)).rows;
      current.flushEntered = true; current.entered.resolve(); await current.gate.promise;
      throw current.flushReason;
    }
    return result;
  };
}
function pendingOutcome(operation, current) {
  return outcome(operation).then(result => { current.settled = true; return result; });
}
async function completeHeld(current, pending) {
  const { record, session } = current;
  await Promise.race([current.entered.promise, pending.then(result => {
    if (current.flushEntered) return;
    record.prematureOutcome = observation(result);
    if (result.failed) throw result.reason;
    throw new Error('Persistence finished before its actual final flush acknowledgement.');
  })]);
  assert.equal(current.settled, false, 'The caller waits while the actual completed flush acknowledgement is held.');
  assert.deepEqual(record.atHeldFlush.filter(row => record.sourceResources.some(source => source.setId === row.setId)), [],
    'The normally replaced source branches and cascading SQL rows were actually released.');
  assert.deepEqual(record.tempAtHeldFlush, record.tempBefore);
  record.backendAtHeldFlush = (await session.client.query(backendIdentity)).rows[0];
  assert.deepEqual(record.backendAtHeldFlush, record.backendBefore);
  record.pendingAfterActualFlush = true;
  current.gate.resolve();
  const result = await pending;
  record.delivered = observation(result.failed ? result.reason : result.value);
  assert.equal(result.failed, true);
  return result.reason;
}
async function normalOwnerClose(fixture) {
  const { creator, library, links, database, report } = fixture;
  report.beforeOwnerClose = await snapshot(database); report.ownerShutdown = [];
  const failures = [];
  for (const [owner, close] of [['item creation', () => creator.close()], ['library', () => library.close()],
    ['owned releases', () => links.flushOwnedReleases()], ['SQL links', () => links.close()]]) {
    try { await close(); report.ownerShutdown.push({ owner, closed: true }); }
    catch (error) { failures.push(error); report.ownerShutdown.push({ owner, failure: observation(error) }); }
  }
  if (failures.length) throw new AggregateError(failures, 'The actual persistence owners failed to close.', { cause: failures[0] });
  report.runtimeAfterOwnerClose = (await database.client.query('SELECT to_regnamespace($1)::text AS namespace', [links.schemaName])).rows;
  assert.deepEqual(report.runtimeAfterOwnerClose, [{ namespace: null }]);
  assert.deepEqual((await database.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
  report.afterOwnerClose = await snapshot(database); assert.deepEqual(report.afterOwnerClose, report.beforeOwnerClose);
  await verifyLocal(fixture);
}
async function ownedCase(t, name, execute) {
  let body;
  t.after(async () => { if (body) await outcome(body); });
  body = (async () => {
    const fixture = await libraryFailureFixture(t, 'item-persistence-owner-failures-' + name);
    const { database, ids, report } = fixture;
    report.scope = 'Real PostgreSQL ItemCreationService persistence/context/entity owners and Local/VFS prefix. '
      + 'Acknowledgement faults follow completed actual disposals, releases and flush. No Native execution, private counts, '
      + 'Error reference identity, SQL spelling or aggregate-wrapper-shape requirement.';
    report.fixtureDisposal.boundary = 'Normal owner close and runtime-schema absence below precede final fixture schema/directory disposal. '
      + 'Fallback fixture releases are recorded separately and cannot satisfy a held production-finalizer boundary.';
    report.nativeExecutedByThisTest = false; report.phaseAcceptance = false; report.releaseAcceptance = false;
    for (const [ParentId, ChildId, SortOrder] of [[ids.root, ids.first, 0], [ids.root, ids.next, 1], [ids.series, ids.season, 0]]) {
      await database.insert('LinkedChildren', { ParentId, ChildId, SortOrder, ChildType: 0 });
    }
    try { await execute(fixture); await normalOwnerClose(fixture); report.passed = true; }
    catch (error) { report.failure = observation(error); throw error; }
  })();
  await body;
}

test('saveItems retains actual cancellation false and drains both real contexts and its held flush', options, async t => {
  await ownedCase(t, 'save-cancel', async fixture => {
    const { store, creator, links, database, ids, report } = fixture;
    const record = { name: 'cancel-after-both-real-context-loads', events: [], fixtureFallback: [] }; report.cases.push(record);
    await store.run(async session => {
      const { folders, holders } = await sources(fixture, session, record);
      const controller = new AbortController(), entered = Promise.withResolvers(), gate = Promise.withResolvers();
      const current = { record, session, entered, gate, settled: false, outerFlushArmed: false, flushEntered: false,
        flushReason: { message: 'The actual save context flush already finished.', code: 'ESAVEFLUSH', status: 507, statusCode: 503 } };
      const loadActual = creator.loadContext, flushActual = links.flushReleases, contexts = [];
      let pending;
      const abort = () => gate.resolve(); t.signal.addEventListener('abort', abort, { once: true });
      creator.loadContext = async function (...args) {
        const loaded = await loadActual.apply(this, args), dispose = loaded.dispose.bind(loaded);
        const entry = { itemId: loaded.item.Id, dispose, disposed: false }; contexts.push(entry);
        record.events.push('actual context loaded ' + loaded.item.Name);
        loaded.dispose = async (...settings) => {
          const result = await dispose(...settings); entry.disposed = true;
          record.events.push('actual context disposed ' + loaded.item.Name);
          if (idKey(loaded.item.Id) === idKey(ids.root)) throw 0;
          current.outerFlushArmed = true;
          return result;
        };
        if (idKey(loaded.item.Id) === idKey(ids.series)) {
          for (const item of folders) publishNativeItemLinks(item, EMPTY_NATIVE_LINKS);
          for (const owner of holders) owner.release();
          controller.abort(false);
          record.cancellation = observation(controller.signal.reason);
          record.boundary = 'Both real contexts loaded before AbortController.abort(false); saveNativeItems rejects before its batch transaction. No rollback claim.';
        }
        return loaded;
      };
      links.flushReleases = flushGate(fixture, current, flushActual);
      try {
        t.signal.throwIfAborted();
        pending = pendingOutcome(creator.saveItems(folders, { signal: controller.signal }), current);
        const delivered = await completeHeld(current, pending);
        assert.equal(controller.signal.aborted, true); assert.equal(controller.signal.reason, false);
        verifyReasons(delivered, [false, 0, current.flushReason]);
        record.actualContextDisposals = contexts.map(entry => ({ itemId: entry.itemId, completed: entry.disposed }));
        assert.ok(contexts.every(entry => entry.disposed));
        record.afterFailure = await snapshot(session); assert.deepEqual(record.afterFailure, record.committedPrefix);
        await verifyLocal(fixture);
        creator.loadContext = loadActual; links.flushReleases = flushActual;
        record.recoveredItems = await creator.withItem(ids.root, root => creator.withItem(ids.series, async series => {
          root.Overview = 'Recovered real root save'; series.Overview = 'Recovered real series save';
          const saved = await creator.saveItems([root, series]);
          assert.deepEqual(saved.map(item => idKey(item.Id)), [idKey(ids.root), idKey(ids.series)]);
          assert.deepEqual(await readTestLinkIds(root), [idKey(ids.first), idKey(ids.next)]);
          assert.deepEqual(await readTestLinkIds(series), [idKey(ids.season)]);
          return saved.map(item => ({ Id: item.Id, Name: item.Name, Overview: item.Overview }));
        }));
        for (const item of record.recoveredItems) assert.equal((await database.rows('BaseItems', { where: { Id: item.Id } }))[0].Overview, item.Overview);
        record.afterRecovery = await snapshot(session);
        assert.deepEqual(record.afterRecovery.LinkedChildren, record.committedPrefix.LinkedChildren);
        record.tempAfterRecovery = (await session.client.query(tempRelations)).rows; assert.deepEqual(record.tempAfterRecovery, record.tempBefore);
        record.backendAfterRecovery = (await session.client.query(backendIdentity)).rows[0]; assert.deepEqual(record.backendAfterRecovery, record.backendBefore);
        await verifyLocal(fixture); record.ownerRecoveryCompleted = true;
      } finally {
        gate.resolve(); t.signal.removeEventListener('abort', abort);
        if (pending) await pending;
        creator.loadContext = loadActual; links.flushReleases = flushActual;
        for (const owner of holders) owner.release();
        for (const entry of contexts) if (!entry.disposed) {
          record.fixtureFallback.push({ itemId: entry.itemId }); await entry.dispose();
        }
      }
    });
  });
});

test('createItems keeps its real null-alternate 500 while actual state, entity and flush releases also reject', options, async t => {
  await ownedCase(t, 'create-validation', async fixture => {
    const { store, creator, links, library, database, ids, report } = fixture;
    const record = { name: 'real-null-alternates-and-all-finalizers', events: [], fixtureFallback: [] }; report.cases.push(record);
    await store.run(async session => {
      const { folders, holders } = await sources(fixture, session, record);
      const draft = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
      Object.assign(draft, { Id: 'cf980000-0000-0000-0000-000000000040', Name: 'Persistence movie',
        Path: path.join(fixture.files, 'persistence-movie.mkv'), ParentId: ids.root, LocalAlternateVersions: null });
      const current = { record, session, entered: Promise.withResolvers(), gate: Promise.withResolvers(),
        settled: false, outerFlushArmed: false, flushEntered: false,
        flushReason: { message: 'The actual CreateItems flush already finished.', code: 'ECREATEFLUSH', status: 503, statusCode: 507 } };
      const loadActual = library.load, retainActual = creator.retainItem, flushActual = links.flushReleases;
      let pending, disposeState, stateDisposed = false;
      const added = event => { if (idKey(event.Item.Id) === idKey(draft.Id)) record.added.push({ Id: event.Item.Id, Name: event.Item.Name }); };
      record.added = []; library.on('ItemAdded', added);
      const abort = () => current.gate.resolve(); t.signal.addEventListener('abort', abort, { once: true });
      library.load = async function (...args) {
        const state = await loadActual.apply(this, args);
        assert.ok(state.byId.has(idKey(ids.root)), 'The real creation state contains the persisted parent.');
        disposeState = state.dispose.bind(state);
        state.dispose = async (...settings) => {
          const result = await disposeState(...settings); stateDisposed = true;
          record.events.push('actual creation state disposed');
          throw false;
        };
        for (const item of folders) publishNativeItemLinks(item, EMPTY_NATIVE_LINKS);
        for (const owner of holders) owner.release();
        return state;
      };
      creator.retainItem = function (item) {
        const owner = retainActual.call(this, item);
        if (![ids.root, ids.series].some(id => idKey(id) === idKey(item.Id))) return owner;
        return Object.freeze({ release() {
          const result = owner.release(); record.events.push('actual item owner released ' + item.Name);
          if (idKey(item.Id) === idKey(ids.root)) throw 0;
          current.outerFlushArmed = true;
          throw '';
        } });
      };
      links.flushReleases = flushGate(fixture, current, flushActual);
      try {
        t.signal.throwIfAborted();
        pending = pendingOutcome(creator.createItems([...folders, draft]), current);
        const delivered = await completeHeld(current, pending), primary = firstCause(delivered);
        assert.equal(primary.status, 500);
        assert.equal(primary.message, 'A native video version array cannot be null.');
        verifyReasons(delivered, [primary, false, 0, '', current.flushReason]);
        assert.equal(delivered.status, 500);
        for (const field of ['code', 'statusCode']) assert.equal(Object.hasOwn(delivered, field), Object.hasOwn(primary, field));
        record.primary = observation(primary); record.stateActuallyDisposed = stateDisposed; assert.equal(stateDisposed, true);
        record.afterFailure = await snapshot(session); assert.deepEqual(record.afterFailure, record.committedPrefix);
        assert.equal(record.afterFailure.BaseItems.some(row => idKey(row.Id) === idKey(draft.Id)), false);
        assert.deepEqual(record.added, []); await verifyLocal(fixture);
        library.load = loadActual; creator.retainItem = retainActual; links.flushReleases = flushActual;
        draft.LocalAlternateVersions = [];
        record.recoveredItems = await creator.withItem(ids.root, async parent => {
          const created = await creator.createItems([draft], parent, { creationIntent: 'library-save' });
          return created.map(item => ({ Id: item.Id, Name: item.Name, ParentId: item.ParentId, Type: item.Type }));
        });
        assert.deepEqual(record.recoveredItems.map(item => idKey(item.Id)), [idKey(draft.Id)]);
        const stored = (await database.rows('BaseItems')).find(row => idKey(row.Id) === idKey(draft.Id));
        assert.ok(stored); assert.equal(stored.Name, draft.Name); assert.equal(idKey(stored.ParentId), idKey(ids.root));
        assert.deepEqual(record.added, [{ Id: draft.Id, Name: draft.Name }]);
        assert.equal((await creator.getItemById(draft.Id)).Name, draft.Name);
        record.afterRecovery = await snapshot(session);
        assert.equal(record.afterRecovery.BaseItems.find(row => idKey(row.Id) === idKey(ids.root)).Overview,
          record.committedPrefix.BaseItems.find(row => idKey(row.Id) === idKey(ids.root)).Overview);
        record.tempAfterRecovery = (await session.client.query(tempRelations)).rows; assert.deepEqual(record.tempAfterRecovery, record.tempBefore);
        record.backendAfterRecovery = (await session.client.query(backendIdentity)).rows[0]; assert.deepEqual(record.backendAfterRecovery, record.backendBefore);
        await verifyLocal(fixture); record.ownerRecoveryCompleted = true;
      } finally {
        current.gate.resolve(); t.signal.removeEventListener('abort', abort);
        if (pending) await pending;
        library.load = loadActual; creator.retainItem = retainActual; links.flushReleases = flushActual;
        library.off('ItemAdded', added);
        for (const owner of holders) owner.release();
        if (disposeState && !stateDisposed) { record.fixtureFallback.push({ owner: 'creation state' }); await disposeState(); }
      }
    });
  });
});
