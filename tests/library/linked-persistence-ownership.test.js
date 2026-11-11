import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, publishNativeItemLinks, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];
const parentId = '51300000-0000-0000-0000-000000000001';
const firstId = '51300000-0000-0000-0000-000000000002';
const nextId = '51300000-0000-0000-0000-000000000003';
const beforeId = '51300000-0000-0000-0000-000000000004';
const playlistType = 'MediaBrowser.Controller.Playlists.Playlist';
const falsy = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const outcomes = promise => promise.then(value => ({ value }), error => ({ error }));

async function recordedCleanup(filename, steps, state = {}) {
  const failures = [], report = { steps: [], state };
  const write = async () => {
    try { await fs.writeFile(filename, JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { failures.push(error); }
  };
  for (const [name, operation] of steps) {
    const step = { name, status: 'running' }; report.steps.push(step); await write();
    try { await operation(); step.status = 'completed'; }
    catch (error) { failures.push(error); step.status = 'failed'; step.error = errorObservation(error); }
    await write();
  }
  if (failures.length) throw new AggregateError(failures, 'Captured-link regression cleanup failed.', { cause: failures[0] });
}

test('real SQL paging and persistence retain their original failures when the final captured revision cannot be collected', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'linked-persistence-ownership-'));
  const database = await createPostgresTestDatabase(null, 'link_persist', { max: 3 });
  const links = new PostgresLinkedChildrenStore({ database });
  t.after(() => recordedCleanup(path.join(root, 'runtime-cleanup.json'), [
    ['relation-runtime', () => links.close()], ['native-database', () => dropPostgresTestDatabase(database)],
  ]));
  await links.initialize();
  const nativeLinks = `${q(database.schemaName)}."LinkedChildren"`;
  const blocker = `${q(links.schemaName)}.last_owner_dependency`;
  for (const Id of [parentId, firstId, nextId, beforeId]) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: Id === parentId ? playlistType : 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: Id, Path: '/owned/' + Id, IsFolder: Id === parentId, Data: '{}',
  }));
  const counts = async () => {
    const value = {};
    for (const [name, table] of [['sets', links.sets], ['rows', links.rows], ['pins', links.pins]]) {
      value[name] = Number((await database.client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    }
    return value;
  };
  const nativeRows = () => database.rows('LinkedChildren', { where: { ParentId: parentId }, orderBy: [{ column: 'SortOrder' }] });
  const setStored = (childId, count) => database.transaction(async db => {
    await db.client.query(`DELETE FROM ${nativeLinks} WHERE "ParentId"=$1`, [nativeTextBytes(parentId)]);
    await db.client.query(`INSERT INTO ${nativeLinks}("ParentId","ChildId","ChildType","SortOrder")
      SELECT $1::bytea,$2::bytea,0,ordinal FROM generate_series(0,$3::integer-1) ordinal`,
    [nativeTextBytes(parentId), nativeTextBytes(childId), count]);
  });
  const modes = [
    { name: 'sql-and-sql', primary: 'sql', cleanup: 'sql' },
    ...falsy.map(([name, reason]) => ({ name: name + '-and-sql', primary: { reason }, cleanup: 'sql' })),
    { name: 'completed-and-sql', primary: 'none', cleanup: 'sql' },
    ...falsy.map(([name, reason]) => ({ name: 'sql-and-' + name, primary: 'sql', cleanup: { reason } })),
  ];
  const samples = ['pages', 'persist'].flatMap(kind => modes.map(mode => ({ ...mode, kind, name: kind + '-' + mode.name })))
    .concat([{ name: 'persist-captured-commit', kind: 'persist', primary: 'none', cleanup: 'none' }]);
  for (const sample of samples) await t.test(sample.name, async t => {
    const item = newNativeItemEntity(playlistType); item.Id = parentId;
    const handles = new Set(), copied = Promise.withResolvers(), resume = Promise.withResolvers();
    const originalHook = database.queryHook;
    let source, replacement, iterator, run, primary, cleanupFailure, observed, temporary;
    let selected = true, primaryInjected = false, cleanupCalls = 0, copyPaused = false, nativeDeleted = false, nativeInserted = 0;
    const observedPages = [];
    t.after(async () => {
      selected = false; database.queryHook = originalHook; resume.resolve();
      const state = { sample: sample.name, copied: copyPaused, primaryInjected, cleanupCalls };
      await recordedCleanup(path.join(root, sample.name + '.cleanup.json'), [
        // Release the FK blocker before joining persistence. No failed DDL or
        // iterator close may skip the remaining relation owners.
        ['drop-blocker', () => database.client.query(`DROP TABLE IF EXISTS ${blocker}`)],
        ['drop-native-check', () => database.client.query(`ALTER TABLE ${nativeLinks} DROP CONSTRAINT IF EXISTS rejected_link_replacement`)],
        ['join-operation', async () => {
          const settled = await run;
          state.operation = settled === undefined ? { notStarted: true } : Object.hasOwn(settled, 'error')
            ? { error: errorObservation(settled.error) } : { completed: true };
        }],
        ['iterator-return', () => iterator?.return()], ['item-links', () => releaseNativeItemLinks(item)],
        ...[...handles].map((handle, index) => ['handle-' + index, () => links.release(handle)]),
        ['flush-releases', () => links.flushReleases()],
      ], state);
    });
    await setStored(firstId, 130);
    source = await database.withConnection(session => links.load(session, parentId)); handles.add(source);
    const sourceId = source.entry.id;
    if (sample.kind === 'persist') {
      publishNativeItemLinks(item, source);
      // The immutable cold snapshot outlives a later committed repository
      // prefix. A failed replacement must roll back to this exact prefix.
      await setStored(beforeId, 1);
    }
    const before = await nativeRows();
    if (sample.cleanup === 'sql') {
      await database.client.query(`CREATE TABLE ${blocker}(set_id uuid PRIMARY KEY REFERENCES ${links.sets}(id))`);
      await database.client.query(`INSERT INTO ${blocker}(set_id) VALUES ($1)`, [sourceId]);
    }
    if (sample.kind === 'persist' && sample.primary === 'sql') {
      await database.client.query(`ALTER TABLE ${nativeLinks} ADD CONSTRAINT rejected_link_replacement CHECK ("ChildType"<0) NOT VALID`);
    }
    // The relation database exposes a getter-only queryHook forwarding the
    // native root hook into its checked-out connection. Install at that root.
    database.queryHook = async function (statement, ...args) {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const values = typeof statement === 'string' ? args[0] : statement.values;
      const reading = sql.startsWith('SELECT * FROM (') && values?.[0] === sourceId && values[1] === 0n;
      const secondPage = reading && values[2] === 128n;
      if (selected && sample.kind === 'pages' && secondPage && sample.primary === 'sql' && !primaryInjected) {
        primaryInjected = true;
        try { return await this.query({ ...statement, text: sql.replace('WHERE "Ordinal">', 'WHERE "MissingOrdinal">') }, ...args); }
        catch (error) { primary = error; throw error; }
      }
      const collecting = sql.startsWith(`DELETE FROM ${links.sets} source WHERE id=$1`) && values?.[0] === sourceId;
      if (selected && collecting) {
        cleanupCalls++;
        try {
          const value = await this.query(statement, ...args);
          if (typeof sample.cleanup === 'object') throw sample.cleanup.reason;
          return value;
        } catch (error) { cleanupFailure = error; throw error; }
      }
      const value = await this.query(statement, ...args);
      if (reading && value.rows.length) observedPages.push(value.rows.map(row => decodeNativeTextBytes(row.ItemId)));
      if (selected && sample.kind === 'pages' && secondPage && typeof sample.primary === 'object' && !primaryInjected) {
        primaryInjected = true; primary = sample.primary.reason; throw primary;
      }
      return value;
    };
    if (sample.kind === 'pages') {
      iterator = links.pages(source)[Symbol.asyncIterator]();
      const first = await iterator.next(); assert.equal(first.done, false);
      assert.deepEqual(first.value.map(row => row.ItemId), Array(128).fill(firstId));
      await links.recordResolution(source, 130n, nextId);
      assert.deepEqual((await links.page(source, { after: 129n, limit: 1 })).map(row => row.ItemId), [nextId]);
      await links.release(source);
      run = outcomes((async () => {
        const second = await iterator.next();
        assert.deepEqual(second.value.map(row => row.ItemId), [firstId, firstId], 'The iterator keeps the cold revision after the caller mutates and releases its handle.');
        return iterator.next();
      })());
      observed = await run;
    } else {
      run = outcomes(database.transaction(async session => {
        const query = session.client.query.bind(session.client);
        session.client.query = async (statement, ...args) => {
          const sql = typeof statement === 'string' ? statement : statement.text;
          if (sql.startsWith('CREATE TEMP TABLE "mm_link_save_')) temporary = /^CREATE TEMP TABLE ("[^"]+")/u.exec(sql)[1];
          let value;
          try { value = await query(statement, ...args); }
          catch (error) { if (sql.startsWith(`INSERT INTO ${nativeLinks}`)) primary = error; throw error; }
          if (selected && sql.startsWith(`INSERT INTO ${temporary}`) && !copyPaused) {
            copyPaused = true; copied.resolve(); await resume.promise;
          }
          if (selected && typeof sample.primary === 'object' && !primaryInjected && sql.startsWith(`UPDATE ${temporary}`)) {
            primaryInjected = true; primary = sample.primary.reason; throw primary;
          }
          if (sql.startsWith(`DELETE FROM ${nativeLinks}`)) nativeDeleted = true;
          if (sql.startsWith(`INSERT INTO ${nativeLinks}`)) nativeInserted = value.rowCount;
          return value;
        };
        try { await links.persist(session, item); }
        finally { session.client.query = query; }
      }));
      await Promise.race([copied.promise, run.then(() => { throw new Error('Persistence ended before its real first-page INSERT.'); })]);
      await links.recordResolution(source, 130n, nextId);
      assert.deepEqual((await links.page(source, { after: 129n, limit: 1 })).map(row => row.ItemId), [nextId]);
      replacement = await links.withSession(async session => {
        const writer = await links.createWriter({ session, parentId });
        await writer.append({ ItemId: nextId, Type: 0 }); await writer.append({ ItemId: nextId, Type: 0 });
        return writer.finish();
      }); handles.add(replacement);
      publishNativeItemLinks(item, replacement);
      await links.flushReleases();
      resume.resolve(); observed = await run;
      assert.equal(item.LinkedChildren, replacement);
      assert.deepEqual((await links.page(replacement)).map(row => row.ItemId), [nextId, nextId]);
      assert.deepEqual(observedPages.flat(), Array(130).fill(firstId), 'All persisted pages retain the original revision, including the row mutated after page one.');
      assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM pg_class WHERE relname=$1',
        [temporary.slice(1, -1)])).rows[0].count), 0);
      if (sample.primary === 'none') { assert.equal(nativeDeleted, true); assert.equal(nativeInserted, 130); }
      if (sample.primary === 'sql') assert.equal(nativeDeleted, true);
    }
    selected = false; database.queryHook = originalHook;
    if (sample.cleanup === 'none') {
      assert.equal(Object.hasOwn(observed, 'error'), false);
      assert.deepEqual((await nativeRows()).map(row => row.ChildId), Array(130).fill(firstId));
    } else {
      assert.equal(Object.hasOwn(observed, 'error'), true);
      assert.equal(cleanupCalls, 1, 'With its caller owner withdrawn, the captured revision really reaches SQL collection.');
      if (sample.cleanup === 'sql') assert.equal(cleanupFailure.code, '23503');
      else assert.equal(cleanupFailure, sample.cleanup.reason);
      if (sample.primary === 'none') assert.equal(observed.error, cleanupFailure);
      else {
        if (sample.primary === 'sql') assert.equal(primary.code, sample.kind === 'pages' ? '42703' : '23514');
        else assert.equal(primary, sample.primary.reason);
        assert.deepEqual(observed.error.errors, [primary, cleanupFailure]); assert.equal(observed.error.cause, primary);
        if (sample.primary === 'sql') assert.equal(observed.error.code, primary.code);
      }
      assert.deepEqual(await nativeRows(), before, 'A failed persistence or reader must preserve the actual committed native prefix.');
    }
    const afterFailure = await counts();
    const retained = sample.cleanup === 'sql';
    assert.deepEqual(afterFailure, { sets: (retained ? 1 : 0) + (sample.kind === 'persist' ? 1 : 0),
      rows: (retained ? 131 : 0) + (sample.kind === 'persist' ? 2 : 0), pins: 0 });
    await database.client.query(`ALTER TABLE ${nativeLinks} DROP CONSTRAINT IF EXISTS rejected_link_replacement`);
    await database.client.query(`DROP TABLE IF EXISTS ${blocker}`); await links.flushReleases();
    if (sample.kind === 'persist') await database.transaction(session => links.persist(session, item));
    const recovered = await database.withConnection(session => links.load(session, parentId)); handles.add(recovered);
    const recoveredIds = [];
    for await (const page of links.pages(recovered)) recoveredIds.push(...page.map(row => row.ItemId));
    assert.deepEqual(recoveredIds, sample.kind === 'persist' ? [nextId, nextId] : Array(130).fill(firstId));
    await links.release(recovered); releaseNativeItemLinks(item); await links.flushReleases();
    assert.deepEqual(await counts(), { sets: 0, rows: 0, pins: 0 });
    await fs.writeFile(path.join(root, sample.name + '.json'), JSON.stringify({ sample: sample.name,
      failure: errorObservation(observed.error), cleanupCalls, observedPages, nativeDeleted, nativeInserted,
      afterFailure, committedPrefixPreserved: sample.cleanup !== 'none',
      capturedRevisionCommitted: sample.cleanup === 'none', recoveredIds }, null, 2) + '\n');
  });
});
