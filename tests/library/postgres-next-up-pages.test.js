import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { queryPostgresNextUpPage, withPostgresNextUpPages } from '../../src/library/postgres-next-up-query.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { errorObservation } from '../helpers/error-observation.js';
import { observeExecutionPhase } from '../../tools/validation/execution-diagnostics.js';

export const requiredValidationServices = ['postgres'];
const userId = '9f7a0000-0000-0000-0000-000000000001';
const topParentId = '9f7a0000-0000-0000-0000-000000000002';
const id = number => `9f7a0000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const ids = rows => rows.map(row => idKey(row.Id));
const temporary = async db => (await db.client.query("SELECT oid::text,relname,relkind FROM pg_class WHERE relnamespace=pg_my_temp_schema() ORDER BY oid")).rows;
const backend = async db => (await db.client.query('SELECT pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
const jitSetting = async db => (await db.client.query("SELECT current_setting('jit') AS jit")).rows[0];
const userData = db => db.rows('UserData', { orderBy: tableDefinition('UserData').primaryKey.map(column => ({ column, direction: 'ASC' })) });
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00' : column.nullable ? null
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
}));

function item(Id, kind, ordinal, series, values = {}) {
  return { ...blank('BaseItems'), Id, Type: 'MediaBrowser.Controller.Entities.TV.' + kind,
    Name: `${series.key} ${ordinal ?? 'series'}`, CleanName: `${series.key} ${ordinal ?? 'series'}`,
    SortName: String(ordinal ?? 0).padStart(4, '0') + '-' + Id, Data: '{"VideoType":"VideoFile"}',
    IsFolder: kind === 'Series', IsSeries: kind === 'Series', MediaType: kind === 'Episode' ? 'Video' : 'Unknown',
    ParentId: kind === 'Episode' ? series.series : null, TopParentId: topParentId,
    SeriesId: kind === 'Episode' ? series.series : null,
    SeriesPresentationUniqueKey: kind === 'Episode' ? series.key : null,
    PresentationUniqueKey: kind === 'Series' ? series.key : Id,
    ParentIndexNumber: kind === 'Episode' ? 1 : null, IndexNumber: ordinal, ...values };
}

async function seed(database, count, signal) {
  const series = Array.from({ length: count }, (_, index) => ({ index, key: 'next-up-pages-' + String(index).padStart(4, '0'),
    series: id(100 + index * 10), last: id(101 + index * 10), lastVersion: id(102 + index * 10),
    next: id(103 + index * 10), nextVersion: id(104 + index * 10), future: id(105 + index * 10) }));
  await database.transaction(async db => {
    await db.insert('Users', { ...blank('Users'), Id: idKey(userId), Username: 'next-up-pages-user' });
    for (const value of series) {
      signal?.throwIfAborted();
      const directory = 'Z:\\NextUpPages\\' + value.key + '\\';
      await db.insert('BaseItems', item(value.series, 'Series', null, value));
      await db.insert('BaseItems', item(value.last, 'Episode', 1, value, { Path: directory + 'Last - base.mkv' }));
      await db.insert('BaseItems', item(value.lastVersion, 'Episode', 1, value,
        { PrimaryVersionId: idKey(value.last), Path: directory + 'Last - 2160p.mkv' }));
      await db.insert('BaseItems', item(value.next, 'Episode', 2, value, { Path: directory + 'Next - base.mkv' }));
      await db.insert('BaseItems', item(value.nextVersion, 'Episode', 2, value,
        { PrimaryVersionId: idKey(value.next), Path: directory + 'Next - 2160p.mkv', Name: value.key + ' preferred successor' }));
      await db.insert('BaseItems', item(value.future, 'Episode', 3, value, { Path: directory + 'Future.mkv' }));
      for (const [parent, child] of [[value.last, value.lastVersion], [value.next, value.nextVersion]]) {
        await db.insert('LinkedChildren', { ParentId: parent, SortOrder: 0, ChildId: child, ChildType: 2 });
      }
      await db.insert('UserData', { ...blank('UserData'), ItemId: value.lastVersion, UserId: idKey(userId), CustomDataKey: value.lastVersion,
        Played: true, PlayCount: 1, LastPlayedDate: new Date(Date.UTC(2026, 9, 1) + value.index * 1000).toISOString().replace('T', ' ').replace('Z', '') });
    }
    signal?.throwIfAborted();
  }, { signal });
  return series;
}

test('frozen Next Up public selection streams bounded final preferred versions and releases its actual TEMP owner after every callback outcome', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'postgres-next-up-pages-' + randomUUID()); await mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, nativeExecutedByThisTest: false, phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Real PostgreSQL checkout, Next Up public paging/count/order, final linked-version preference and independent committed UserData changes. TEMP disappearance and same physical backend recovery precede fixture teardown.',
    hydration: [], failures: [], ownerRestorations: [], fixtureCleanup: {} };
  let database, writer, body;
  const phase = (name, operation) => observeExecutionPhase('postgres.next-up-pages.' + name, () => {
    t.signal.throwIfAborted(); return operation();
  }, { fixture: 'tests/library/postgres-next-up-pages.test.js' });
  const observeQueries = (database, role) => {
    const query = database.client.query.bind(database.client);
    const explained = new Set();
    database.client.query = (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const kind = typeof text === 'string' && /^\/\* (next-up-(?:selection|freeze|page|preferred-versions|release)|native-query-jit:(?:read|disable|restore)) \*\//u.exec(text)?.[1];
      if (!kind) return query(...args);
      // Only static phase labels are recorded. SQL text, arguments and
      // connection strings never enter these independent observations.
      const cleanup = kind === 'next-up-release' || kind.startsWith('native-query-jit:');
      return observeExecutionPhase('postgres.next-up-pages.' + role + '.' + kind, async () => {
        if (!cleanup) t.signal.throwIfAborted();
        if ((kind === 'next-up-selection' || kind === 'next-up-preferred-versions') && !explained.has(kind)) {
          explained.add(kind);
          // This is planning only for the identical controlled statement.
          // It does not execute the statement again or record SQL/connection
          // text. Its plan constants belong to this synthetic fixture.
          const plan = await query({ text: 'EXPLAIN (FORMAT JSON, SETTINGS) ' + text,
            values: typeof args[0] === 'object' ? args[0].values : args[1] });
          const planName = kind === 'next-up-selection' ? 'selection' : 'preferred-versions';
          await writeFile(path.join(output, role + '-' + planName + '-plan.json'), json({ role,
            analyzed: false, controlledSyntheticInput: true, plan: plan.rows }));
          t.signal.throwIfAborted();
        }
        const result = await query(...args);
        if (!cleanup) t.signal.throwIfAborted();
        return result;
      }, { fixture: 'tests/library/postgres-next-up-pages.test.js' });
    };
  };
  const subtest = async (name, operation) => {
    t.signal.throwIfAborted();
    let pending;
    try {
      await t.test(name, context => pending = Promise.resolve().then(() => {
        t.signal.throwIfAborted(); return operation(context);
      }));
    } finally {
      // node:test may cancel its wrapper before the callback has unwound.
      // Retain this SQL owner until that actual callback has released it.
      await pending;
    }
    t.signal.throwIfAborted();
  };
  t.after(async () => {
    // In particular, a business timeout cannot close the writer or borrow the
    // max=1 source pool while its admitted callback still owns that backend.
    if (body) await observeExecutionPhase('postgres.next-up-pages.cleanup-await-body', () => outcome(body),
      { fixture: 'tests/library/postgres-next-up-pages.test.js' });
    const failures = [];
    for (const [name, stage, close] of [['writer', 'close-writer', () => writer?.close()],
      ['native/control schemas', 'drop-source-schemas', () => dropPostgresTestDatabase(database)]]) {
      try {
        await observeExecutionPhase('postgres.next-up-pages.' + stage, close,
          { fixture: 'tests/library/postgres-next-up-pages.test.js' });
        report.fixtureCleanup[name] = true;
      } catch (error) { failures.push(error); }
    }
    if (failures.length) report.fixtureCleanupFailures = failures.map(error => errorObservation(error));
    await writeFile(path.join(output, 'report.json'), json(report));
    if (failures.length) throw new AggregateError(failures, 'Next Up page fixture cleanup failed.', { cause: failures[0] });
  });
  body = (async () => {
    try {
      database = await phase('open-source', () => createPostgresTestDatabase(null, 'next_up_pages', { max: 1 }));
      observeQueries(database, 'source');
      writer = await phase('open-writer', () => PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName, max: 1 }));
      observeQueries(writer, 'writer');
      const series = await phase('seed', () => seed(database, 263, t.signal));
      const input = Object.freeze({ seriesKeys: Object.freeze(series.map(value => value.key)), userId,
        enableResumable: true, enableUserData: true, startIndex: 3, limit: 257 });
      const originalInput = structuredClone(input);
      const originalOrder = [...series].reverse().slice(input.startIndex, input.startIndex + input.limit);
      let originalBackend, committedUserData, freshControl;
      await database.withConnection(async session => {
        originalBackend = await backend(session);
        const originalJit = await jitSetting(session);
        const before = await temporary(session);
        const baseline = await phase('original-public-control', () => queryPostgresNextUpPage(session, input));
        t.signal.throwIfAborted();
        assert.deepEqual(await jitSetting(session), originalJit);
        report.connectionSettingBefore = originalJit;
        assert.equal(baseline.total, series.length); assert.equal(baseline.startIndex, input.startIndex);
        assert.deepEqual(ids(baseline.rows), originalOrder.map(value => idKey(value.nextVersion)));
        assert.deepEqual(baseline.entries.map(entry => idKey(entry.nextId)), originalOrder.map(value => idKey(value.next)));
        assert.deepEqual(baseline.entries.map(entry => idKey(entry.playedVersionId)), originalOrder.map(value => idKey(value.lastVersion)));
        report.originalPublicControl = baseline;
        const rows = session.rows.bind(session); let observing = false;
        session.rows = async (name, options) => {
          const result = await rows(name, options);
          t.signal.throwIfAborted();
          if (observing && name === 'BaseItems') {
            assert.ok(result.length <= 128, 'Actual final-version hydration must remain bounded, independently of the public Limit=257.');
            if (options?.whereIn?.Id) assert.ok(options.whereIn.Id.length <= 128);
            report.hydration.push({ returned: result.length, requested: options?.whereIn?.Id?.length ?? null, ids: ids(result) });
          }
          return result;
        };
        try {
          observing = true;
          const collectedRows = [], collectedEntries = [], pageLengths = [];
          const result = await phase('frozen-consumer', () => withPostgresNextUpPages(session, input, async context => {
            assert.equal(context.total, series.length); assert.equal(context.startIndex, input.startIndex);
            const during = await temporary(session);
            const owned = during.filter(row => !before.some(old => old.oid === row.oid));
            assert.ok(owned.some(row => row.relkind === 'r'), 'The awaited consumer retains an actual TEMP relation.');
            report.selectionOwner = { backend: await backend(session), before, during };
            let changed = false;
            for await (const page of context.pages) {
              t.signal.throwIfAborted();
              assert.ok(page.entries.length > 0 && page.entries.length <= 128); assert.ok(page.rows.length <= 128);
              pageLengths.push(page.entries.length); collectedRows.push(...page.rows); collectedEntries.push(...page.entries);
              if (!changed) {
                changed = true;
                const writerBackend = await phase('writer-backend', () => writer.withConnection(backend)); assert.notEqual(writerBackend.pid, originalBackend.pid);
                await phase('committed-user-data', () => writer.transaction(async db => {
                  for (const value of series) {
                    t.signal.throwIfAborted();
                    await db.insert('UserData', { ...blank('UserData'), ItemId: value.next, UserId: idKey(userId),
                      CustomDataKey: value.next, Played: true, PlayCount: 1, LastPlayedDate: '2026-10-27 00:00:00' });
                  }
                  t.signal.throwIfAborted();
                  await db.insert('UserData', { ...blank('UserData'), ItemId: series[0].future, UserId: idKey(userId),
                    CustomDataKey: series[0].future, Played: true, PlayCount: 1, LastPlayedDate: '2026-10-27 00:00:00' });
                  t.signal.throwIfAborted();
                }, { signal: t.signal }));
                t.signal.throwIfAborted();
                committedUserData = await userData(writer);
                await writeFile(path.join(output, 'committed-user-data.json'), json(committedUserData), { flag: 'wx' });
                // This is an independent fresh public control on changed input,
                // never a second public query used to obtain a streaming page.
                freshControl = await phase('fresh-public-control', () => queryPostgresNextUpPage(writer, input));
                t.signal.throwIfAborted();
                assert.equal(freshControl.total, series.length - 1);
                assert.deepEqual(ids(freshControl.rows), series.slice(4, 261).map(value => idKey(value.future)));
                assert.notDeepEqual(ids(freshControl.rows), ids(baseline.rows));
                report.changedInput = { writerBackend, committedUserDataSha256: digest(committedUserData), freshPublicControl: freshControl };
              }
              assert.equal(context.total, series.length, 'Committed UserData changes cannot replace the retained original count.');
            }
            report.frozen = { rows: collectedRows, entries: collectedEntries, pageLengths, total: context.total, startIndex: context.startIndex };
            return { consumed: collectedRows.length };
          }));
          assert.deepEqual(result, { consumed: input.limit });
          assert.deepEqual(collectedEntries, baseline.entries, 'Every original entry and its ordinal remain frozen across UserData changes.');
          assert.deepEqual(collectedRows, baseline.rows, 'All pages still resolve the preferred successor matching the originally played 2160p version.');
          assert.deepEqual(input, originalInput, 'Public startIndex and Limit cannot be rewritten to obtain later source pages.');
        } finally { observing = false; session.rows = rows; }
        assert.deepEqual(await temporary(session), before); assert.deepEqual(await backend(session), originalBackend);
        assert.deepEqual(await jitSetting(session), originalJit);
        report.ownerRestorations.push({ stage: 'successful callback', backend: await backend(session), temporary: await temporary(session) });

        // Owner failures need a real retained selection, while the independent
        // 263-series case above exercises every large public page boundary.
        const failureSeries = series.slice(1, 4);
        const failureInput = { ...input, seriesKeys: failureSeries.map(value => value.key), startIndex: 0, limit: 3 };
        await subtest('returning the consumer waits for an admitted page whose real PostgreSQL read has returned', async () => {
          const beforePending = await temporary(session), readReturned = Promise.withResolvers(), releaseRead = Promise.withResolvers();
          const consumerReturned = Promise.withResolvers(), readRows = session.rows.bind(session);
          const record = { before: beforePending }; report.pendingPage = record;
          let held = true, pending, owner, settled = false;
          session.rows = async (name, options) => {
            const actual = await readRows(name, options);
            t.signal.throwIfAborted();
            if (held && name === 'BaseItems') {
              held = false;
              record.actualRead = { rows: actual, backend: await backend(session) };
              readReturned.resolve(); await releaseRead.promise;
            }
            return actual;
          };
          try {
            owner = outcome(withPostgresNextUpPages(session, failureInput, async ({ total, pages }) => {
              assert.equal(total, failureSeries.length);
              pending = pages.next(); void pending.catch(() => {});
              await Promise.race([readReturned.promise, pending.then(value => {
                throw new Error('The page completed before its actual PostgreSQL read could be held.', { cause: value });
              })]);
              t.signal.throwIfAborted();
              consumerReturned.resolve();
              return 'consumer completed before page delivery';
            })).then(result => { settled = true; return result; });
            await Promise.race([consumerReturned.promise, owner.then(result => {
              throw new Error('The source owner completed before its consumer reached the returned-read barrier.', { cause: result.reason });
            })]);
            t.signal.throwIfAborted();
            // The callback has returned; give its finally block a scheduling turn
            // while the real read result remains held above, without an SQL wait.
            await new Promise(setImmediate);
            t.signal.throwIfAborted();
            assert.equal(settled, false, 'The source owner must await its already admitted page before completing or dropping TEMP.');
            record.during = await temporary(session); record.backendDuring = await backend(session);
            const owned = record.during.filter(row => !beforePending.some(previous => previous.oid === row.oid));
            assert.ok(owned.some(row => row.relkind === 'r'), 'The actual retained TEMP relation must survive the early callback return.');
            assert.deepEqual(record.actualRead.backend, originalBackend); assert.deepEqual(record.backendDuring, originalBackend);
            assert.deepEqual(ids(record.actualRead.rows).sort(), failureSeries.map(value => idKey(value.future)).sort());
            record.ownerPendingAfterCallback = true;
            releaseRead.resolve();
            const delivered = await pending;
            assert.equal(delivered.done, false);
            assert.ok(delivered.value.rows.length <= 128); assert.ok(delivered.value.entries.length <= 128);
            assert.deepEqual(ids(delivered.value.rows), failureSeries.map(value => idKey(value.future)));
            record.delivered = delivered.value;
            assert.deepEqual(await owner, { failed: false, value: 'consumer completed before page delivery' });
            record.after = await temporary(session); record.backendAfter = await backend(session);
            assert.deepEqual(record.after, beforePending); assert.deepEqual(record.backendAfter, originalBackend);
            assert.deepEqual((await session.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
            assert.deepEqual(await userData(session), committedUserData);
          } finally {
            releaseRead.resolve(); session.rows = readRows;
            if (pending) await pending.catch(() => {});
            if (owner) await owner;
          }
        });
        await subtest('caller cancellation after actual preferred-version SQL preserves its reason, settings and committed state', async () => {
          const controller = new AbortController(), reason = new DOMException('Controlled cancellation after admitted Next Up SQL.', 'AbortError');
          const beforeCancellation = await temporary(session), query = session.client.query;
          session.client.query = async (...args) => {
            const actual = await query(...args);
            const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            if (text?.startsWith('/* next-up-preferred-versions */')) {
              controller.abort(reason); controller.signal.throwIfAborted();
            }
            return actual;
          };
          try {
            const result = await outcome(withPostgresNextUpPages(session, failureInput, async ({ pages }) => {
              await pages.next();
              // If cancellation incorrectly delivers a page, this real write
              // would change the independently inspected committed state.
              await writer.insert('UserData', { ...blank('UserData'), ItemId: failureSeries[0].nextVersion,
                UserId: idKey(userId), CustomDataKey: failureSeries[0].nextVersion, Played: false, PlayCount: 0 });
            }));
            assert.equal(result.failed, true); assert.deepEqual(result.reason, reason);
          } finally { session.client.query = query; }
          assert.deepEqual(await temporary(session), beforeCancellation);
          assert.deepEqual(await jitSetting(session), originalJit);
          assert.deepEqual(await backend(session), originalBackend);
          assert.deepEqual(await userData(session), committedUserData);
          assert.deepEqual((await writer.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
          report.callerCancellation = { reason: errorObservation(reason), backendQueryCancellationClaimed: false,
            temporary: await temporary(session), settings: await jitSetting(session), committedUserDataSha256: digest(await userData(session)) };
        });
        for (const [index, reason] of [false, 0, '', null, undefined].entries()) await subtest('callback rejection ' + index, async () => {
          const beforeFailure = await temporary(session); let iterator, during;
          const result = await outcome(withPostgresNextUpPages(session, failureInput, async ({ total, startIndex, pages }) => {
            assert.equal(total, failureSeries.length); assert.equal(startIndex, 0);
            during = await temporary(session); assert.ok(during.some(row => !beforeFailure.some(old => old.oid === row.oid)));
            iterator = pages[Symbol.asyncIterator]();
            if (index > 0) {
              const selected = await iterator.next(); assert.equal(selected.done, false);
              assert.ok(selected.value.rows.length <= 128); assert.ok(selected.value.entries.length <= 128);
            }
            throw reason;
          }));
          assert.equal(result.failed, true); assert.ok(Object.is(result.reason, reason));
          const after = await temporary(session); assert.deepEqual(after, beforeFailure);
          assert.deepEqual(await backend(session), originalBackend);
          assert.deepEqual(await jitSetting(session), originalJit);
          assert.deepEqual((await session.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
          assert.deepEqual(await userData(session), committedUserData, 'Callback failure must retain the independent committed UserData prefix.');
          await writeFile(path.join(output, 'after-failure-' + index + '-user-data.json'), json(await userData(session)), { flag: 'wx' });
          const late = await outcome(iterator.next());
          assert.ok(late.failed || late.value.done === true, 'A completed consumer cannot deliver further selected rows.');
          assert.deepEqual(await temporary(session), beforeFailure, 'A completed consumer cannot recreate or use its released TEMP selection.');
          report.failures.push({ reasonType: typeof reason, reason: reason === undefined ? { undefined: true } : reason,
            rawReasonPreserved: true, before: beforeFailure, during, after, backend: await backend(session), committedUserDataSha256: digest(await userData(session)) });
        });
        await subtest('public count suppression and empty public pages retain their original semantics', async () => {
          await withPostgresNextUpPages(session, { ...failureInput, enableTotalRecordCount: false }, async ({ total, startIndex, pages }) => {
            assert.equal(total, 0); assert.equal(startIndex, 0); const actual = [];
            for await (const page of pages) { assert.ok(page.rows.length <= 128); actual.push(...page.rows); }
            assert.deepEqual(ids(actual), failureSeries.map(value => idKey(value.future)));
          });
          await withPostgresNextUpPages(session, { ...failureInput, startIndex: 1000 }, async ({ total, startIndex, pages }) => {
            assert.equal(total, failureSeries.length); assert.equal(startIndex, 1000);
            for await (const _page of pages) assert.fail('An out-of-range public page is empty even while the total remains nonzero.');
          });
          assert.deepEqual(await temporary(session), before);
        });
        await subtest('a transaction or unowned root database cannot take the nontransaction page owner', async () => {
          await assert.rejects(withPostgresNextUpPages(database, input, () => {}), TypeError);
          await assert.rejects(session.transaction(tx => withPostgresNextUpPages(tx, input, () => {})), TypeError);
          assert.deepEqual(await temporary(session), before); assert.deepEqual(await backend(session), originalBackend);
          assert.deepEqual((await session.client.query('SELECT 1 AS restored')).rows, [{ restored: 1 }]);
        });
      });
      t.signal.throwIfAborted();
      await database.withConnection(async session => {
        assert.deepEqual(await backend(session), originalBackend);
        assert.deepEqual(await temporary(session), []);
        assert.deepEqual(await userData(session), committedUserData);
        report.ownerRestorations.push({ stage: 'subsequent actual checkout', backend: await backend(session), temporary: await temporary(session) });
      });
    } catch (error) { report.failure = errorObservation(error); throw error; }
    finally { await writeFile(path.join(output, 'report.json'), json(report)); }
  })();
  await body;
});
