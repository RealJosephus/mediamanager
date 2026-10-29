import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresSuggestionsQuery } from '../../src/library/postgres-suggestions-query.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const physicalA = '83600000-0000-0000-0000-000000009001', physicalB = '83600000-0000-0000-0000-000000009002';
const itemId = index => '83600000-0000-0000-0000-' + String(index).padStart(12, '0');
const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));

async function seed(database) {
  await database.transaction(async db => {
    for (let index = 1; index <= 274; index++) await db.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: itemId(index), Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Suggestion ' + index,
      CleanName: 'suggestion ' + index, SortName: 'suggestion ' + index, Data: '{"VideoType":"VideoFile"}',
      TopParentId: index <= 200 || index > 270 ? physicalA : physicalB,
      PresentationUniqueKey: index === 2 ? 'suggestion-1' : 'suggestion-' + index,
      MediaType: 'Video', UnratedType: 'Movie', IsVirtualItem: index === 271,
      OwnerId: index === 272 || index === 274 ? itemId(1) : null,
      ExtraType: index === 274 ? 2 : null, PrimaryVersionId: index === 273 ? itemId(1) : null,
    }));
    await db.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId(300), Type: 'PLACEHOLDER',
      IsVirtualItem: false, Data: null }));
  });
}

async function temporaryRelations(db) {
  return (await db.client.query(`SELECT relname FROM pg_catalog.pg_class
    WHERE relnamespace=pg_my_temp_schema() ORDER BY relname`)).rows;
}

async function consume(db, input, options) {
  const before = await temporaryRelations(db), selected = await createPostgresSuggestionsQuery(db, input, options);
  const ids = [];
  try {
    for (let offset = 0;; offset += 128) {
      const page = await selected.page(offset);
      assert.ok(page.length <= 128);
      if (!page.length) break;
      ids.push(...page);
    }
    return { ids, total: selected.total, startIndex: selected.startIndex };
  } finally {
    await selected.close();
    assert.deepEqual(await temporaryRelations(db), before);
  }
}

test('real PostgreSQL Suggestions preserve the eligible set, scoped grouping and public windows across bounded pages', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'suggestions');
  await seed(database);
  await database.withConnection(async db => {
    const all = await consume(db, { itemTypes: ['Movie'] });
    const expected = [...Array.from({ length: 270 }, (_, index) => itemId(index + 1)), itemId(274)];
    assert.deepEqual([...all.ids].sort(), expected.sort());
    assert.equal(new Set(all.ids.map(idKey)).size, all.ids.length);
    assert.equal(all.total, 271); assert.equal(all.startIndex, 0);
    const global = await consume(db, {});
    assert.equal(global.ids.length, 272); assert.equal(global.total, 271);
    assert.ok(global.ids.includes(itemId(300)));
    const unpagedCount = await consume(db, { enableTotalRecordCount: true });
    assert.equal(unpagedCount.ids.length, 272); assert.equal(unpagedCount.total, 271);
    const emptyPageCount = await consume(db, { limit: 0, enableTotalRecordCount: true });
    assert.deepEqual(emptyPageCount.ids, []); assert.equal(emptyPageCount.total, 272);
    const access = { userId: itemId(9999), visibility: { topParentIds: [physicalA], blockedTags: [], allowedTags: [], blockUnratedTypes: [] } };
    const scoped = await consume(db, { itemTypes: ['Movie'] }, access);
    const expectedScoped = [...Array.from({ length: 200 }, (_, index) => itemId(index + 1)).filter(id => id !== itemId(2)), itemId(274)];
    assert.deepEqual([...scoped.ids].sort(), expectedScoped.sort()); assert.equal(scoped.total, 200);
    for (const input of [
      { startIndex: -2147483648, limit: 2 }, { startIndex: 1, limit: 129 },
      { startIndex: 999, limit: 2 }, { startIndex: 0, limit: 0 },
      { startIndex: 0, limit: -1 }, { startIndex: 2147483647, limit: 1 },
    ]) for (const enableTotalRecordCount of [false, true]) {
      const page = await consume(db, { itemTypes: ['Movie'], ...input, enableTotalRecordCount }, access);
      const skip = Math.max(0, input.startIndex), take = input.limit < 0 ? 200 : input.limit;
      const size = Math.min(Math.max(0, 200 - skip), take);
      assert.equal(page.startIndex, input.startIndex); assert.equal(page.ids.length, size);
      assert.equal(page.total, enableTotalRecordCount ? 200 : size);
      assert.equal(new Set(page.ids.map(idKey)).size, size);
      assert.ok(page.ids.every(id => expectedScoped.includes(id)));
    }
    assert.deepEqual((await db.client.query('SELECT 1 AS recovered')).rows, [{ recovered: 1 }]);
  });
});

test('an acknowledged real Suggestions table is released after every falsy driver rejection and the connection recovers', {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'suggestion_fail');
  await seed(database);
  for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]) {
    await t.test(name, async () => {
      const execute = database.client.query.bind(database.client);
      let injected = false;
      database.client.query = async (...args) => {
        const result = await execute(...args);
        if (!injected && args[0]?.text?.includes('/* suggestions-freeze */')) { injected = true; throw reason; }
        return result;
      };
      try {
        await database.withConnection(async db => {
          const before = await temporaryRelations(db);
          const failed = await outcome(createPostgresSuggestionsQuery(db, { itemTypes: ['Movie'] }));
          assert.equal(failed.failed, true); assert.ok(Object.is(failed.reason, reason));
          assert.equal(injected, true);
          assert.deepEqual(await temporaryRelations(db), before);
          assert.deepEqual((await db.client.query('SELECT 1 AS recovered')).rows, [{ recovered: 1 }]);
          const recovered = await consume(db, { itemTypes: ['Movie'], limit: 1, enableTotalRecordCount: true });
          assert.equal(recovered.ids.length, 1); assert.equal(recovered.total, 271);
        });
      } finally { database.client.query = execute; }
    });
  }
});
