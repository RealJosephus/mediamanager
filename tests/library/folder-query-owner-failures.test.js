import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual, inspect } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = value => `9f7b0000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
function functional(value) {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  return { kind: value instanceof AggregateError ? 'AggregateError' : value instanceof Error ? 'Error' : 'Object',
    properties: Object.fromEntries(Object.getOwnPropertyNames(value)
      .filter(name => !(value instanceof Error && ['name', 'stack'].includes(name)))
      .map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return [name, Object.hasOwn(descriptor, 'value') ? functional(descriptor.value) : { accessor: true }];
      })) };
}
function actualReasons(reason, expected) {
  const value = functional(reason);
  if (expected.some(entry => isDeepStrictEqual(value, functional(entry)))) return [value];
  return reason instanceof AggregateError ? reason.errors.flatMap(entry => actualReasons(entry, expected)) : [value];
}
function firstCause(reason, primary) {
  while (!isDeepStrictEqual(functional(reason), functional(primary))) {
    assert.ok(reason instanceof AggregateError, 'Multiple actual failures expose their first cause.');
    assert.ok(Object.hasOwn(reason, 'cause'));
    assert.deepEqual(functional(reason.cause), functional(reason.errors[0]));
    reason = reason.cause;
  }
}
const snapshot = database => Promise.all(nativeModel.tables.map(async table => [table.name,
  await database.rows(table.name, { orderBy: table.primaryKey.map(column => ({ column, direction: 'ASC' })) })])).then(Object.fromEntries);
const tempRelations = `SELECT c.oid::text AS oid,c.relname AS name FROM pg_catalog.pg_class c
  WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relkind IN ('r','p') ORDER BY c.oid`;

test('Folder query preserves business and both actual cleanup failures, waits for real flush, and restores its PG owner', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  let body;
  t.after(async () => { if (body) await outcome(body); });
  body = (async () => {
    const fixture = await setupChildrenFixture(t), { database, library, linkedChildren } = fixture;
    fixture.configurationSource.configuration = { ...fixture.configuration, EnableGroupingMoviesIntoCollections: true,
      EnableGroupingShowsIntoCollections: false };
    const directory = path.join(fixture.stateRoot, 'query-folder'), originalFile = path.join(directory, 'preserve.txt');
    await mkdir(directory); await writeFile(originalFile, 'Original Folder owner bytes.\n');
    await fixture.seed({ target: 'folder', items: [
      { key: 'root', Id: id(1), type: 'UserRootFolder', IsRoot: true, Path: fixture.stateRoot },
      { key: 'folder', Id: id(2), type: 'Folder', parent: 'root', Path: directory },
    ] });
    const user = { Id: id(99), Username: 'Owner failures', Configuration: {}, AccessSchedules: [],
      Policy: { EnableAllFolders: true, AllowedTags: [], BlockedTags: [], BlockUnratedItems: [] } };
    const query = { ParentId: id(2), IncludeItemTypes: ['Movie'], Recursive: false, CollapseBoxSetItems: true,
      EnableImages: false, EnableUserData: false };
    const primary = { name: 'Business failure name', stack: 'Business stack value', message: 'The relational consumer rejected.',
      code: 'EBUSINESS', status: 409, statusCode: 422, cause: undefined, errors: [false, 0, '', null, undefined] };
    const cleanup = { message: 'The actual collapse table was already dropped.', code: 'ECOLLAPSEDRAIN', status: 503,
      statusCode: 507, cause: { name: 'Business close cause', stack: 'Retained cause stack' } };
    const flush = { message: 'The actual link release queue already drained.', code: 'ELINKDRAIN', status: 507, statusCode: 503 };
    const scenarios = [
      { name: 'public-primary-and-both-releases', primaryFailed: true, primary, dropFault: true, drop: cleanup, flushFault: true, flush },
      { name: 'falsy-primary-and-falsy-releases', primaryFailed: true, primary: false, dropFault: true, drop: 0, flushFault: true, flush: '' },
      { name: 'one-actual-drop-rejection-is-raw', primaryFailed: false, dropFault: true, drop: 0, flushFault: false },
    ];
    const output = path.join(validationOutputRoot(), 'folder-query-owner-failures-' + randomUUID()); await mkdir(output);
    const report = { schemaVersion: 1, cases: [], nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
      scope: 'Real ordinary Folder links and collection-collapse TEMP owners, actual PostgreSQL DROP and actual relation flush before injected acknowledgement failures. No search collation owner or Native simulation.',
      fixtureFinalCleanup: 'setupChildrenFixture removes its schema/directory only after the following owner, recovery, full native-table and original-byte observations.' };
    const before = await snapshot(database), bytes = await readFile(originalFile), originalFlush = linkedChildren.flushReleases;
    let active;
    linkedChildren.flushReleases = async function (options) {
      const result = await originalFlush.call(this, options), current = active;
      if (current?.dropObserved && !current.flushObserved && options?.session) {
        current.flushObserved = true;
        current.record.events.push('actual link flush finished');
        current.record.atFlush = (await current.query(tempRelations)).rows;
        current.gateEntered = true; current.entered.resolve(); await current.gate.promise;
        if (current.scenario.flushFault) throw current.scenario.flush;
      }
      return result;
    };
    try {
      for (const scenario of scenarios) await database.withConnection(async session => {
        const record = { name: scenario.name, events: [] }; report.cases.push(record);
        const originalQuery = session.client.query, queryActual = (...args) => originalQuery.apply(session.client, args);
        const baseline = (await queryActual(tempRelations)).rows;
        const backend = (await queryActual('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const current = { scenario, record, query: queryActual, entered: Promise.withResolvers(), gate: Promise.withResolvers(),
          dropObserved: false, flushObserved: false, gateEntered: false, armed: false };
        active = current;
        let settled = false, pending;
        const abort = () => current.gate.resolve(); t.signal.addEventListener('abort', abort, { once: true });
        try {
          const operation = library.withItemQueryPlan(query, { user }, async (db, plan) => {
            const selected = await db.client.query(plan); record.rawSelectedRows = selected.rows;
            record.atConsumer = (await queryActual(tempRelations)).rows;
            record.acquired = record.atConsumer.filter(row => !baseline.some(value => value.oid === row.oid));
            assert.ok(record.acquired.length > 0, 'The actual query has acquired TEMP relations before its consumer.');
            session.client.query = async (...args) => {
              const result = await queryActual(...args);
              // PostgreSQL command completion, not statement spelling or a
              // private call count, admits the one post-DROP fault.
              if (current.armed && !current.dropObserved && result.command === 'DROP') {
                const after = (await queryActual(tempRelations)).rows;
                record.removedBeforeFault = record.acquired.filter(row => !after.some(value => value.oid === row.oid));
                assert.ok(record.removedBeforeFault.length > 0, 'The real DROP completed before its acknowledgement failure.');
                current.dropObserved = true; record.events.push('actual table DROP finished');
                if (scenario.dropFault) throw scenario.drop;
              }
              return result;
            };
            current.armed = true;
            if (scenario.primaryFailed) throw scenario.primary;
            return selected.rows;
          });
          pending = outcome(operation).then(value => { settled = true; return value; });
          await Promise.race([current.entered.promise, pending.then(value => {
            if (current.gateEntered) return;
            record.prematureOutcome = { failed: value.failed,
              value: functional(value.failed ? value.reason : value.value) };
            if (value.failed) throw value.reason;
            throw new Error('The Folder query completed before its actual link flush gate.');
          })]);
          assert.equal(settled, false, 'The consumer result waits for the held actual cleanup.');
          assert.deepEqual(record.atFlush.filter(row => record.acquired.some(value => value.oid === row.oid)), [],
            'All acquired query TEMP relations have actually gone before the flush acknowledgement is delivered.');
          record.backendAtHeldFlush = (await queryActual('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          current.gate.resolve();
          const result = await pending; assert.equal(result.failed, true);
          const expected = [...(scenario.primaryFailed ? [scenario.primary] : []),
            ...(scenario.dropFault ? [scenario.drop] : []), ...(scenario.flushFault ? [scenario.flush] : [])];
          assert.deepEqual(actualReasons(result.reason, expected), expected.map(functional), 'Business then actual cleanup order is preserved.');
          if (expected.length === 1) assert.deepEqual(functional(result.reason), functional(expected[0]), 'One actual failure stays raw.');
          else firstCause(result.reason, expected[0]);
          if (scenario.name === 'public-primary-and-both-releases') {
            for (const field of ['code', 'status', 'statusCode']) assert.equal(result.reason[field], primary[field]);
          }
          record.failure = functional(result.reason);
          record.rawFailure = inspect(result.reason, { depth: null, customInspect: false, getters: false });
          session.client.query = originalQuery; active = undefined;
          record.after = (await session.client.query(tempRelations)).rows;
          assert.deepEqual(record.after, baseline);
          record.recovery = (await session.client.query('SELECT pg_backend_pid() AS pid, 1 AS recovered')).rows[0];
          assert.deepEqual(record.recovery, { pid: backend, recovered: 1 }, 'The same actual backend remains usable.');
          const recovered = await library.queryItems(query, { user, fromUserViewChildren: true });
          assert.deepEqual(recovered.Items, []); assert.equal(recovered.TotalRecordCount, 0);
          assert.deepEqual((await session.client.query(tempRelations)).rows, baseline);
          assert.deepEqual(await snapshot(session), before, 'All 31 original persistent tables are unchanged.');
          assert.deepEqual(await readFile(originalFile), bytes);
          record.originalFile = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
          record.ownerRecoveryCompleted = true;
        } finally {
          current.gate.resolve(); t.signal.removeEventListener('abort', abort);
          try { if (pending) await pending; } finally { session.client.query = originalQuery; active = undefined; }
        }
      });
      report.passed = true;
    } finally {
      linkedChildren.flushReleases = originalFlush;
      await writeFile(path.join(output, 'report.json'), json(report), { flag: 'wx' });
    }
  })();
  await body;
});
