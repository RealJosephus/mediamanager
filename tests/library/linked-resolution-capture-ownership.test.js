import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createPostgresLinkedResolutionWorkspace } from '../../src/library/postgres-linked-resolution-workspace.js';
import { resolvePostgresLinkedChildren, findPostgresLinkedChildByPath } from '../../src/library/postgres-linked-child-resolution.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity, publishNativeItemLinks, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const id = number => `54800000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const identity = number => `Z:\\ResolutionCapture\\item-${number}`;
const folderType = 'MediaBrowser.Controller.Entities.Folder';
const publicCleanup = () => Object.assign(new Error('The actual state disposal completed before its failed reply.'), { code: 'dispose-reply', status: 503 });
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, !Object.hasOwn(descriptor, 'value') ? { accessor: true }
      : key === 'errors' ? descriptor.value.map(observation)
        : key === 'cause' ? observation(descriptor.value) : descriptor.value];
  }));
}
const leaves = error => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
function reasons(error, expected) {
  const actual = leaves(error); assert.equal(actual.length, expected.length);
  for (const [index, value] of expected.entries()) assert.equal(actual[index], value);
}
async function rawRelation(links, rows) {
  return links.withSession(async session => {
    const writer = await links.createWriter({ session, parentId: id(90) });
    try { for (const row of rows) await writer.append({ Type: 0, ...row }); }
    catch (error) { await writer.abort(); throw error; }
    return writer.finish();
  });
}
async function relationCounts(database, links) {
  const values = {};
  for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins],
    ['states', `"${links.schemaName}".item_states`], ['cohorts', `"${links.schemaName}".item_cohorts`]]) {
    values[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  }
  return values;
}
async function tempNames(session) {
  return (await session.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
    AND relname LIKE 'mm_link_resolution_%' ORDER BY relname`)).rows.map(row => row.relname);
}

test('linked resolution preserves real capture failures while disposing positive batches and draining fallback owners', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-resolution-capture-ownership-'));
  let database, links, store, library, creator;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    if (database) database.queryHook = null;
    await attempt(() => creator?.close()); await attempt(() => library?.close());
    await attempt(() => links?.resourceGraph.collect()); await attempt(() => links?.flushOwnedReleases()); await attempt(() => links?.flushReleases());
    await attempt(() => links?.close()); await attempt(() => store?.close());
    if (database) await attempt(() => dropPostgresTestDatabase(database));
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ failures: failures.map(observation) }, null, 2) + '\n');
    assert.deepEqual(failures, []);
  });
  database = await createPostgresTestDatabase(null, 'capture_owner', { max: 3 });
  links = new PostgresLinkedChildrenStore({ database }); await links.initialize(); store = new DomainStore(database);
  library = new LibraryService({ fileSystem: testFileSystem, store, linkedChildren: links, serverId: 'resolution-capture', configuration: { CacheSize: 8 } });
  creator = new ItemCreationService({ store, library, linkedChildren: links,
    loadContext: async () => assert.fail('Resolving stored linked children must not enter a metadata save context.') });
  library.itemCreation = creator;
  for (const number of [1, 2, 3, 4]) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(number), Type: number < 3 ? folderType : 'MediaBrowser.Controller.Entities.Movies.Movie', IsFolder: number < 3,
    Path: identity(number), Name: 'Captured ' + number, SortName: String(number), DateCreated: '2026-11-11 12:00:00', Data: '{}',
  }));
  await database.insert('LinkedChildren', { ParentId: id(1), ChildId: id(3), ChildType: 0, SortOrder: 0 });
  await database.insert('LinkedChildren', { ParentId: id(2), ChildId: id(4), ChildType: 0, SortOrder: 0 });
  const committed = await database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId' }] });
  const positive = [
    ...['dispose', 'flush'].flatMap(phase => falsy.map(([name, reason]) => ({ name: `positive-${phase}-${name}`, kind: 'positive', primary: 'sql', [phase]: { reason } }))),
    ...falsy.map(([name, reason]) => ({ name: `positive-primary-${name}`, kind: 'positive', primary: { reason }, dispose: { reason: publicCleanup() } })),
    { name: 'positive-single-null', kind: 'positive', primary: { reason: null } },
    { name: 'positive-every-finalizer', kind: 'positive', primary: 'sql', flush: { reason: false }, dispose: { reason: 0 } },
    { name: 'positive-single-dispose-undefined', kind: 'positive', primary: 'none', dispose: { reason: undefined } },
  ];
  const fallback = [
    ...[false, true].flatMap(blocked => falsy.map(([name, reason]) => ({ name: `fallback-owner-${name}${blocked ? '-fk' : ''}`, kind: 'fallback', owner: { reason }, blocked }))),
    ...falsy.map(([name, reason]) => ({ name: `fallback-flush-${name}`, kind: 'fallback', flush: { reason } })),
    { name: 'fallback-single-sql', kind: 'fallback' },
  ];
  for (const sample of [...positive, ...fallback]) await t.test(sample.name, async t => {
    const record = { sample: sample.name, events: [], cleanupErrors: [], frames: [], fallbackCalls: 0, flushDeletes: 0, ownerReleased: 0 };
    const load = library.load.bind(library), retain = creator.retainItem.bind(creator), flush = links.flushReleases.bind(links), resolve = links.recordResolution.bind(links);
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.UserRootFolder'); item.Id = id(90); item.Path = 'Z:\\ResolutionCapture';
    const blocker = `"${links.schemaName}".capture_old_dependency`;
    let selected = true, source, replacement, transferred = false, child, oldSet, primary, primarySeen = false, flushInjected = false, disposeInjected = false, result;
    let workspace, cohort, sessionOwner, positiveInjected = false;
    const reset = () => { selected = false; database.queryHook = null; library.load = load; creator.retainItem = retain; links.flushReleases = flush; links.recordResolution = resolve; };
    const cleanupScope = async () => {
      const errors = [];
      for (const operation of [() => cohort?.release(), () => workspace?.dispose(), () => links.resourceGraph.collect(), () => links.flushOwnedReleases(), () => links.flushReleases()]) {
        try { await operation(); } catch (error) { errors.push(error); }
      }
      cohort = undefined; workspace = undefined;
      if (errors.length) throw new AggregateError(errors, 'The resolution caller failed to release its scope.', { cause: errors[0] });
    };
    const finishScope = async (session, stage, removeBlocker = false) => {
      const errors = [];
      const operations = [
        ...(removeBlocker ? [() => session.client.query(`DROP TABLE IF EXISTS ${blocker}`)] : []),
        cleanupScope,
        async () => { record[stage] = await tempNames(session); assert.deepEqual(record[stage], []); },
      ];
      for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
      sessionOwner = undefined;
      if (errors.length) throw new AggregateError(errors, 'Resolution fixture scope cleanup failed.', { cause: errors[0] });
    };
    t.after(async () => {
      reset();
      const attempt = async operation => { try { await operation(); } catch (error) { record.cleanupErrors.push(observation(error)); } };
      await attempt(() => database.client.query(`DROP TABLE IF EXISTS ${blocker}`));
      if (sessionOwner) await attempt(cleanupScope);
      for (const frame of record.frames) if (!frame.disposed) await attempt(() => frame.dispose());
      await attempt(() => creator.close()); await attempt(() => releaseNativeItemLinks(item));
      if (replacement && !transferred) await attempt(() => links.release(replacement));
      if (source) await attempt(() => links.release(source));
      await attempt(() => links.resourceGraph.collect()); await attempt(() => links.flushOwnedReleases()); await attempt(() => links.flushReleases());
      record.finalCounts = await relationCounts(database, links);
      await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ ...record,
        frames: record.frames.map(frame => ({ controlled: frame.controlled, disposed: frame.disposed })),
        failure: observation(result?.error), primary: observation(primary) }, null, 2) + '\n');
      assert.deepEqual(record.cleanupErrors, []);
      assert.deepEqual(record.finalCounts, { sets: 0, rows: 0, pins: 0, states: 0, cohorts: 0 });
    });
    const raw = sample.kind === 'positive'
      ? [{ Path: identity(2) }, { ItemId: id(1) }, { ItemId: id(2) }, { ItemId: id(1) }]
      : [{ Path: identity(1) }, { Path: identity(2) }, { Path: identity(1) }];
    source = await rawRelation(links, raw); publishNativeItemLinks(item, source);
    if (sample.kind === 'fallback') {
      child = await creator.getItemById(id(2)); oldSet = child.LinkedChildren.entry.id;
      replacement = await rawRelation(links, [{ ItemId: id(3) }, { ItemId: id(3) }]);
      record.oldSet = oldSet; record.replacementSet = replacement.entry.id;
      if (sample.blocked) {
        await database.client.query(`CREATE TABLE ${blocker}(set_id uuid PRIMARY KEY REFERENCES ${links.sets}(id))`);
        await database.client.query(`INSERT INTO ${blocker} VALUES ($1)`, [oldSet]);
      }
    }
    library.load = async (...args) => {
      const state = await load(...args), dispose = state.dispose.bind(state);
      const frame = { dispose, disposed: false, controlled: sample.kind === 'positive' && args[2]?.includeFolderLinks === true };
      record.frames.push(frame);
      state.dispose = async options => {
        await dispose(options); frame.disposed = true;
        if (selected && frame.controlled && sample.dispose && !disposeInjected) {
          disposeInjected = true; record.events.push('actual state.dispose completed; injected reply rejection'); throw sample.dispose.reason;
        }
      };
      return state;
    };
    creator.retainItem = target => {
      const owner = retain(target);
      return { release() {
        owner.release();
        if (selected && sample.kind === 'fallback' && target === child && primarySeen) {
          record.ownerReleased++; record.events.push('actual fallback owner released');
          if (sample.owner) throw sample.owner.reason;
        }
      } };
    };
    links.flushReleases = async (...args) => {
      await flush(...args);
      if (selected && primarySeen && sample.flush && !flushInjected) {
        flushInjected = true; record.events.push('actual flush completed; injected reply rejection'); throw sample.flush.reason;
      }
    };
    database.queryHook = async function (statement, ...args) {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const values = typeof statement === 'string' ? args[0] : statement.values;
      if (selected && sample.kind === 'positive' && !positiveInjected && sample.primary !== 'none'
        && sql.startsWith('UPDATE "mm_link_resolution_batch_')) {
        positiveInjected = true;
        try {
          if (sample.primary === 'sql') return await this.query(sql.replace('SET "SlotKey"=', 'SET "MissingSlotKey"='), ...args);
          const value = await this.query(statement, ...args); record.committedBatchRows = value.rowCount;
          throw sample.primary.reason;
        } catch (error) {
          primary = error; primarySeen = true;
          record.events.push(sample.primary === 'sql' ? 'actual positive batch UPDATE rejected with SQL failure'
            : 'actual positive batch UPDATE completed; injected reply rejection');
          if (sample.primary === 'sql') { record.primarySqlCode = error.code; Object.assign(primary, { status: 409, statusCode: 503 }); }
          throw primary;
        }
      }
      if (selected && oldSet && primarySeen && sql.startsWith(`DELETE FROM ${links.sets} source WHERE id=$1`) && values?.[0] === oldSet) {
        record.flushDeletes++;
        record.pinsAtDelete = Number((await this.query(`SELECT count(*) AS count FROM ${links.pins} WHERE set_id=$1`, [oldSet])).rows[0].count);
        try { const value = await this.query(statement, ...args); record.deletedRows = value.rowCount; return value; }
        catch (error) { record.cleanupSqlCode = error.code; record.sqlCleanup = error; throw error; }
      }
      return this.query(statement, ...args);
    };
    links.recordResolution = async (handle, ordinal, nextId, options) => {
      const value = await resolve(handle, ordinal, nextId, options);
      if (selected && sample.kind === 'fallback' && handle === source && ordinal === 2n && !primarySeen) {
        // The caller's live cache commit has completed. This child has not
        // entered cohort.capture yet, so no captured pin can protect oldSet.
        publishNativeItemLinks(child, replacement); transferred = true;
        record.events.push('live source resolution committed; old child branch replaced before cohort.capture');
        record.oldPinsBeforeFailure = Number((await options.session.client.query(`SELECT count(*) AS count FROM ${links.pins} WHERE set_id=$1`, [oldSet])).rows[0].count);
        record.oldRowsBeforeFailure = Number((await options.session.client.query(`SELECT count(*) AS count FROM ${links.rows} WHERE set_id=$1`, [oldSet])).rows[0].count);
        record.primarySqlBoundary = 'SELECT after actual live recordResolution committed and before cohort.capture';
        try { await options.session.client.query(`SELECT missing_capture_reply FROM ${links.rows} WHERE set_id=$1`, [oldSet]); }
        catch (error) { primary = Object.assign(error, { status: 409, statusCode: 503 }); primarySeen = true; record.primarySqlCode = error.code; throw primary; }
        assert.fail('The real invalid capture acknowledgement query must reject.');
      }
      return value;
    };
    await store.run(async session => {
      sessionOwner = session;
      try {
        workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: links.plan(source) });
        cohort = await createNativeItemCohort({ linkedChildren: links });
        const findByPath = target => { record.fallbackCalls++; return findPostgresLinkedChildByPath({ library, store, itemCreation: creator }, target); };
        result = await outcome(resolvePostgresLinkedChildren({ session, item, links: source, linkedChildren: links,
          library, itemCreation: creator, findByPath, resolution: workspace, cohort }));
        assert.equal(Object.hasOwn(result, 'error'), true);
        const expected = [];
        if (sample.primary !== 'none') expected.push(primary);
        if (sample.owner) expected.push(sample.owner.reason);
        if (sample.flush) expected.push(sample.flush.reason);
        if (sample.blocked) expected.push(record.sqlCleanup);
        if (sample.dispose) expected.push(sample.dispose.reason);
        reasons(result.error, expected);
        if (expected.length === 1) assert.equal(result.error, expected[0]);
        if (sample.kind === 'fallback' || sample.primary === 'sql') {
          assert.equal(record.primarySqlCode, '42703'); assert.equal(result.error.code, '42703');
          assert.equal(result.error.status, 409); assert.equal(result.error.statusCode, 503);
        }
        if (sample.dispose) assert.equal(disposeInjected, true);
        if (sample.flush) assert.equal(flushInjected, true);
        record.livePrefix = (await links.page(source)).map(row => row.ItemId === null ? null : idKey(row.ItemId));
        if (sample.kind === 'positive') {
          assert.equal(record.fallbackCalls, 0);
          assert.ok(record.frames.some(frame => frame.controlled && frame.disposed));
          assert.deepEqual(record.livePrefix, [null, idKey(id(1)), idKey(id(2)), idKey(id(1))]);
        } else {
          assert.equal(record.fallbackCalls, 2); assert.equal(record.ownerReleased, 1);
          assert.equal(record.oldPinsBeforeFailure, 0); assert.equal(record.oldRowsBeforeFailure, 1);
          assert.equal(record.pinsAtDelete, 0); assert.equal(record.flushDeletes, 1);
          if (sample.blocked) assert.equal(record.cleanupSqlCode, '23503');
          else assert.equal(record.deletedRows, 1, 'The resolver really deletes the unpinned old child set before rejecting.');
          assert.deepEqual(record.livePrefix, [idKey(id(1)), idKey(id(2)), null]);
          assert.equal(await cohort.count(), 1n, 'The failed child has never been captured or pinned.');
          assert.equal(creator.getCachedItemById(id(2)), child);
          assert.deepEqual((await links.page(child.LinkedChildren)).map(row => idKey(row.ItemId)), [idKey(id(3)), idKey(id(3))]);
        }
        assert.deepEqual(await database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId' }] }), committed);
      } finally {
        reset(); await finishScope(session, 'temporaryAfterFailure', true);
      }
    });
    await store.run(async session => {
      sessionOwner = session;
      try {
        workspace = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: links.plan(source) });
        cohort = await createNativeItemCohort({ linkedChildren: links });
        await resolvePostgresLinkedChildren({ session, item, links: source, linkedChildren: links, library, itemCreation: creator,
          findByPath: target => findPostgresLinkedChildByPath({ library, store, itemCreation: creator }, target), resolution: workspace, cohort });
        const ids = [];
        for (let after = 0n; ;) {
          const page = await cohort.page({ after });
          try { if (!page.entries.length) break; ids.push(...page.entries.map(entry => idKey(entry.item.Id))); after = page.entries.at(-1).Ordinal; }
          finally { await page.release(); }
        }
        record.recoveredIds = ids;
        assert.deepEqual(ids, (sample.kind === 'positive' ? [2, 1, 2, 1] : [1, 2, 1]).map(number => idKey(id(number))));
        if (child) assert.deepEqual((await links.page(child.LinkedChildren)).map(row => idKey(row.ItemId)), [idKey(id(3)), idKey(id(3))]);
      } finally { await finishScope(session, 'temporaryAfterRecovery'); }
    });
    assert.deepEqual(await database.rows('LinkedChildren', { orderBy: [{ column: 'ParentId' }] }), committed);
  });
});
