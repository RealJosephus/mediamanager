import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { publishNativeItemLinks } from '../../src/library/native-item-entity.js';
import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { readTestLinkIds } from './collection-test-consumers.js';
import { libraryFailureFixture, outcome, functional, observation } from './library-failure-fixture.js';

export const requiredValidationServices = ['postgres'];
const snapshot = database => Promise.all(nativeModel.tables.map(async table => [table.name,
  await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])).then(Object.fromEntries);
const tempRelations = `SELECT c.oid::text AS oid,c.relname AS name FROM pg_catalog.pg_class c
  WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relkind IN ('r','p') ORDER BY c.oid`;
const backendIdentity = `SELECT pid,extract(epoch FROM backend_start)::text AS started
  FROM pg_stat_activity WHERE pid=pg_backend_pid()`;

function actualReasons(reason, expected) {
  const value = functional(reason);
  if (expected.some(entry => isDeepStrictEqual(value, functional(entry)))) return [value];
  return reason instanceof AggregateError ? reason.errors.flatMap(entry => actualReasons(entry, expected)) : [value];
}
function firstCause(reason, primary) {
  while (!isDeepStrictEqual(functional(reason), functional(primary))) {
    assert.ok(reason instanceof AggregateError, 'Multiple actual failures retain their first cause.');
    assert.ok(Object.hasOwn(reason, 'cause'));
    assert.deepEqual(functional(reason.cause), functional(reason.errors[0]));
    reason = reason.cause;
  }
}

test('withItem attempts real release and flush, preserves every rejection, and restores PG and Local consumers', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  let body;
  // Register before the fixture teardown so a timeout cannot remove its
  // database or Local files while an admitted owner is still draining.
  t.after(async () => { if (body) await outcome(body); });
  body = (async () => {
    const fixture = await libraryFailureFixture(t, 'item-creation-owner-failures');
    const { database, store, links, library, creator, fileSystem, files, source, ids, report } = fixture;
    report.scope = 'Real ItemCreationService.withItem, PostgreSQL Folder links and Local/VFS callback commits. '
      + 'Cleanup acknowledgement faults follow the actual synchronous owner release and completed SQL flush. '
      + 'A real callback link reassignment queues the old SQL branch; graph collection timing is not asserted. '
      + 'No Native execution, private owner count, reference identity or SQL statement spelling gate.';
    report.fixtureDisposal.boundary = 'Explicit owner closes, runtime-schema absence, same-backend recovery and all '
      + 'persistent-table/Local-byte observations below precede libraryFailureFixture final schema/directory disposal.';
    for (const [SortOrder, ChildId] of [ids.first, ids.next].entries()) {
      await database.insert('LinkedChildren', { ParentId: ids.root, SortOrder, ChildType: 0, ChildId });
    }
    const resources = async session => (await session.client.query(`SELECT source.id::text AS "setId",
      encode(source.parent_id,'hex') AS "parentBytes",child."Ordinal"::text AS ordinal,
      encode(child."ItemId",'hex') AS "itemBytes",child."Type" AS type
      FROM ${links.sets} source LEFT JOIN ${links.rows} child ON child.set_id=source.id
      ORDER BY source.id,child."Ordinal",child.revision`)).rows;
    const primary = { name: 'Business rejection name', stack: 'Business stack value', message: 'The item consumer rejected.',
      code: 0, status: 409, statusCode: 422, cause: undefined, errors: [false, 0, '', null, undefined] };
    const ownerReason = { message: 'The real item owner already released.', code: 'EITEMRELEASE', status: 503, statusCode: 507 };
    const flushReason = { message: 'The real SQL link queue already drained.', code: 'EITEMFLUSH', status: 507, statusCode: 503 };
    const scenarios = [
      { name: 'public-primary-release-flush', primaryFailed: true, primary, ownerFailed: true, ownerReason, flushFailed: true, flushReason },
      { name: 'falsy-primary-release-flush', primaryFailed: true, primary: false, ownerFailed: true, ownerReason: 0, flushFailed: true, flushReason: '' },
      { name: 'single-zero-release', primaryFailed: false, ownerFailed: true, ownerReason: 0, flushFailed: false },
    ];
    const retainActual = creator.retainItem, flushActual = links.flushReleases;
    let active, withItemFlush;
    creator.retainItem = function (item) {
      const owner = retainActual.call(this, item), current = active;
      if (!current) return owner;
      return Object.freeze({ release() {
        const result = owner.release();
        current.releaseCompleted = true; current.record.events.push('actual item owner release finished');
        // withItem calls its final flush immediately after this synchronous
        // public release, even when the controlled acknowledgement rejects.
        // Give that invocation the fault; unrelated cohort cleanup keeps its
        // own real flush and must never inherit this scenario's rejection.
        withItemFlush = current;
        if (current.scenario.ownerFailed) throw current.scenario.ownerReason;
        return result;
      } });
    };
    links.flushReleases = async function (...args) {
      // Claim at call entry, before the real flush or either SQL observation
      // can yield. Reading global active after an await let concurrent flushes
      // enter the same controlled failure and poison a later owner's drain.
      const current = withItemFlush; withItemFlush = undefined;
      const result = await flushActual.apply(this, args);
      if (current) {
        current.record.events.push('actual SQL link flush finished');
        current.record.atHeldFlush = await resources(current.session);
        current.record.tempAtHeldFlush = (await current.session.client.query(tempRelations)).rows;
        current.flushEntered = true; current.entered.resolve(); await current.gate.promise;
        if (current.scenario.flushFailed) throw current.scenario.flushReason;
      }
      return result;
    };
    try {
      for (const scenario of scenarios) await store.run(async session => {
        // Settle the previous callback's ordinary graph/release work. A cached
        // item remains a legitimate owner; this does not require a new branch.
        await links.flushOwnedReleases(); await links.flushReleases();
        const record = { name: scenario.name, events: [], before: await snapshot(session) }; report.cases.push(record);
        const current = { scenario, record, session, entered: Promise.withResolvers(), gate: Promise.withResolvers(),
          releaseCompleted: false, flushEntered: false };
        record.backendBefore = (await session.client.query(backendIdentity)).rows[0];
        record.tempBefore = (await session.client.query(tempRelations)).rows;
        record.resourcesBefore = await resources(session);
        active = current;
        let pending, settled = false;
        const abort = () => current.gate.resolve(); t.signal.addEventListener('abort', abort, { once: true });
        try {
          t.signal.throwIfAborted();
          const operation = creator.withItem(ids.root, async item => {
            assert.equal(item.Name, 'root');
            assert.deepEqual(await readTestLinkIds(item), [idKey(ids.first), idKey(ids.next)]);
            // Ordinary cache eviction leaves the admitted request owning the
            // real mutable branch until withItem performs its final release.
            creator.unregisterItem(item.Id);
            assert.deepEqual(await readTestLinkIds(item), [idKey(ids.first), idKey(ids.next)]);
            record.atConsumer = await resources(session);
            record.ownedBranch = record.atConsumer.filter(row =>
              idKey(Buffer.from(row.parentBytes, 'hex').toString('utf8')) === idKey(item.Id));
            assert.ok(record.ownedBranch.length > 0, 'The actual Folder owns a populated SQL link collection, including a normally reused cached branch.');
            // A normal live assignment queues the old branch. Its physical
            // release belongs to withItem's flush, independently of eventual
            // asynchronous native resource-graph collection.
            publishNativeItemLinks(item, EMPTY_NATIVE_LINKS);
            assert.deepEqual(await readTestLinkIds(item), []);
            await fixture.persist(item, scenario.name);
            record.committedPrefix = await snapshot(session);
            record.controlledConsumerCompleted = true;
            record.events.push(scenario.primaryFailed ? 'item consumer rejected after commit' : 'item consumer completed after commit');
            if (scenario.primaryFailed) throw scenario.primary;
            return 'committed item result';
          });
          pending = outcome(operation).then(value => { settled = true; return value; });
          await Promise.race([current.entered.promise, pending.then(value => {
            if (current.flushEntered) return;
            record.prematureOutcome = observation(value);
            if (value.failed) throw value.reason;
            throw new Error('The item consumer completed before its actual SQL flush gate.');
          })]);
          assert.equal(settled, false, 'The result cannot settle while the completed real flush acknowledgement is held.');
          assert.deepEqual(record.atHeldFlush.filter(row => record.ownedBranch?.some(branch => branch.setId === row.setId)), [],
            'The observed SQL branch and cascading link rows are actually gone before the injected flush rejection.');
          assert.deepEqual(record.tempAtHeldFlush, record.tempBefore, 'Actual loading and release leave no query TEMP relations.');
          record.pendingAfterActualFlush = true;
          record.backendAtHeldFlush = (await session.client.query(backendIdentity)).rows[0];
          assert.deepEqual(record.backendAtHeldFlush, record.backendBefore);
          current.gate.resolve();
          const result = await pending; assert.equal(result.failed, true);
          record.delivered = observation(result.reason);
          if (!record.controlledConsumerCompleted) throw result.reason;
          const expected = [...(scenario.primaryFailed ? [scenario.primary] : []),
            ...(scenario.ownerFailed ? [scenario.ownerReason] : []), ...(scenario.flushFailed ? [scenario.flushReason] : [])];
          assert.deepEqual(actualReasons(result.reason, expected), expected.map(functional), 'The business, actual release and actual flush reasons remain in order.');
          if (expected.length === 1) {
            assert.equal(typeof result.reason, 'number'); assert.equal(result.reason, 0, 'One rejection remains the original raw zero.');
          } else firstCause(result.reason, expected[0]);
          if (scenario.name === 'public-primary-release-flush') for (const field of ['code', 'status', 'statusCode']) {
            assert.equal(Object.hasOwn(result.reason, field), true); assert.equal(result.reason[field], primary[field]);
          }
          active = undefined;
          record.afterFailure = await snapshot(session);
          assert.deepEqual(record.afterFailure, record.committedPrefix, 'Cleanup cannot roll back the committed prefix or alter any native table.');
          assert.deepEqual(await fileSystem.readFile(path.join(files, 'source.png')), source);
          assert.deepEqual(await fileSystem.readFile(path.join(files, 'root.png')), source);
          record.recoveredItem = await creator.withItem(ids.root, async item => {
            assert.equal(item.Name, 'root'); assert.equal(item.Overview, scenario.name);
            const children = await readTestLinkIds(item);
            assert.deepEqual(children, [idKey(ids.first), idKey(ids.next)]);
            creator.unregisterItem(item.Id);
            return { Id: item.Id, Name: item.Name, Overview: item.Overview, children };
          });
          const page = await library.queryItems({ ParentId: ids.root, IncludeItemTypes: ['Movie'], Recursive: false,
            EnableImages: false, EnableUserData: false });
          assert.equal(page.TotalRecordCount, 2);
          assert.deepEqual(page.Items.map(item => idKey(item.Id)).sort(), [idKey(ids.first), idKey(ids.next)].sort());
          record.recoveredPage = page;
          record.afterRecovery = await snapshot(session); assert.deepEqual(record.afterRecovery, record.committedPrefix);
          record.tempAfterRecovery = (await session.client.query(tempRelations)).rows;
          assert.deepEqual(record.tempAfterRecovery, record.tempBefore);
          record.backendAfterRecovery = (await session.client.query(backendIdentity)).rows[0];
          assert.deepEqual(record.backendAfterRecovery, record.backendBefore);
          assert.deepEqual(await fileSystem.readFile(path.join(files, 'source.png')), source);
          assert.deepEqual(await fileSystem.readFile(path.join(files, 'root.png')), source);
          record.ownerRecoveryCompleted = true;
        } catch (error) { record.assertionFailure = observation(error); throw error; }
        finally {
          current.gate.resolve(); t.signal.removeEventListener('abort', abort);
          if (pending) await pending;
          active = undefined; withItemFlush = undefined;
        }
      });
      report.ownerShutdown = [];
      const closeFailures = [];
      for (const [owner, close] of [['item creation', () => creator.close()], ['library', () => library.close()],
        ['owned releases', () => links.flushOwnedReleases()], ['SQL links', () => links.close()]]) {
        try { await close(); report.ownerShutdown.push({ owner, closed: true }); }
        catch (error) { closeFailures.push(error); report.ownerShutdown.push({ owner, failure: observation(error) }); }
      }
      if (closeFailures.length) throw new AggregateError(closeFailures, 'The actual item owners failed to close.', { cause: closeFailures[0] });
      report.runtimeAfterOwnerClose = (await database.client.query('SELECT to_regnamespace($1)::text AS namespace', [links.schemaName])).rows;
      assert.deepEqual(report.runtimeAfterOwnerClose, [{ namespace: null }]);
      assert.deepEqual((await database.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
      assert.deepEqual(await fileSystem.readFile(path.join(files, 'source.png')), source);
      assert.deepEqual(await fileSystem.readFile(path.join(files, 'root.png')), source);
      report.passed = true;
    } finally {
      active = undefined; withItemFlush = undefined; creator.retainItem = retainActual; links.flushReleases = flushActual;
    }
  })();
  await body;
});
