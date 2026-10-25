import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { queryPostgresUserViewMenuPage } from '../../src/library/postgres-user-view-menu-query.js';

const firstId = '71000000-0000-0000-0000-000000000001';
const secondId = '71000000-0000-0000-0000-000000000002';
const userId = '71000000-0000-0000-0000-000000000003';

function database(rows = []) {
  const calls = [];
  return {
    calls,
    dialect: 'postgres',
    schemaName: 'menu_shape',
    client: { query: async plan => {
      calls.push(plan);
      return { rows: rows.map(row => ({ ...row, Id: row.Id == null ? null : nativeTextBytes(row.Id) })) };
    } },
    rows: async (table, options) => {
      assert.equal(table, 'BaseItems');
      assert.deepEqual(options.whereIn.Id, rows.map(row => row.Id).filter(Boolean));
      return rows.filter(row => row.Id).map(row => ({ Id: row.Id, Type: 'MediaBrowser.Controller.Entities.UserView' }));
    },
  };
}

test('PostgreSQL movie/TV menu keeps the native in-memory filter boundary in SQL', async () => {
  const db = database([{ Id: secondId, TotalRecordCount: '2' }, { Id: firstId, TotalRecordCount: '2' }]);
  const page = await queryPostgresUserViewMenuPage(db, {
    parentindexnumber: 4,
    minindexnumber: 2,
    likes: false,
    favoriteorlikes: false,
    isresumable: false,
    hasparentalrating: true,
    hastmdbid: true,
    searchterm: 'ignored by UserViewBuilder',
    minwidth: 9000,
    sortby: ['Name'],
    sortorder: ['Descending'],
    startindex: 1,
    limit: 2,
  }, [firstId, secondId], { userId });

  assert.deepEqual(page.rows.map(row => row.Id), [secondId, firstId]);
  assert.equal(page.total, 2);
  const { text, values } = db.calls[0];
  assert.match(text, /replace\([^\n]+mm_native_guid_lower[^\n]+i\."Id"[^\n]+\) = ANY/u);
  assert.match(text, /i\."ParentIndexNumber" IS NULL OR i\."ParentIndexNumber" =/u);
  assert.match(text, /i\."IndexNumber" >=/u);
  assert.match(text, /filter_data\."Rating"/u);
  assert.match(text, /filter_data\."PlaybackPositionTicks"/u);
  assert.match(text, /COALESCE\(i\."CustomRating", ''\)/u);
  assert.match(text, /p\."ProviderValue"/u);
  assert.match(text, /ORDER BY .*"Name"\).*DESC/u);
  assert.match(text, /LIMIT \$\d+ OFFSET \$\d+/u);
  assert.doesNotMatch(text, /CleanName.*LIKE.*ignored/u);
  assert.doesNotMatch(text, /"Width"/u);
  assert.equal(text.includes(firstId), false);
  assert.ok(values.some(value => Array.isArray(value)
    && value.includes(firstId.replaceAll('-', '').toLowerCase())
    && value.includes(secondId.replaceAll('-', '').toLowerCase())));
});

test('PostgreSQL movie/TV menu treats Limit=0 as an unbounded in-memory page', async () => {
  const db = database([{ Id: firstId, TotalRecordCount: '1' }]);
  const page = await queryPostgresUserViewMenuPage(db, {
    isfolder: true,
    searchterm: 'still ignored',
    startindex: 1,
    limit: 0,
  }, [firstId]);

  assert.equal(page.total, 1);
  assert.doesNotMatch(db.calls[0].text, / LIMIT /u);
  assert.match(db.calls[0].text, / OFFSET /u);
  assert.doesNotMatch(db.calls[0].text, /memory_played_data/u);
});

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

test('real PostgreSQL executes the exact menu filter, ordering, adjacency and paging plan', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `menu_query_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let db;
  t.after(async () => {
    try { await db?.close(); } catch { /* Raw schema cleanup remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try {
      const quote = value => `"${value.replaceAll('"', '""')}"`;
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quote(schema)}, ${quote(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end(); }
  });
  db = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });

  const row = (Id, Name, IndexNumber, SortName) => ({
    ...blank('BaseItems'),
    Id,
    Type: 'MediaBrowser.Controller.Entities.UserView',
    Name,
    CleanName: Name.toLowerCase(),
    SortName,
    Data: '{}',
    MediaType: 'Unknown',
    IsFolder: true,
    IndexNumber,
    ParentIndexNumber: null,
    CustomRating: 'TV-7',
  });
  await db.insert('BaseItems', row(firstId, 'Alpha', 3, '1'));
  await db.insert('BaseItems', row(secondId, 'Beta', 4, '2'));
  await db.insert('BaseItemProviders', { ItemId: firstId, ProviderId: 'Tmdb', ProviderValue: '11' });
  await db.insert('BaseItemProviders', { ItemId: secondId, ProviderId: 'Tmdb', ProviderValue: '' });
  await db.insert('Users', { ...blank('Users'), Id: userId, Username: 'menu-user' });
  await db.insert('UserData', { ...blank('UserData'), ItemId: firstId, UserId: userId,
    CustomDataKey: firstId, Rating: 1, PlaybackPositionTicks: 0n });

  const page = await queryPostgresUserViewMenuPage(db, {
    minindexnumber: 2,
    parentindexnumber: 99,
    likes: false,
    favoriteorlikes: false,
    isresumable: false,
    hasparentalrating: true,
    hastmdbid: true,
    sortby: ['Name'],
    sortorder: ['Descending'],
    adjacentto: firstId,
    limit: 0,
  }, [firstId, secondId], { userId });

  assert.deepEqual(page.rows.map(value => value.Id), [firstId]);
  assert.equal(page.total, 1);
});
