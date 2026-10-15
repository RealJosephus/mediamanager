import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeModel, quoteIdentifier as q } from '../../src/database/model.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { fixtureIds, fixtureRow, seedAllTables } from './fixtures.js';

const definition = name => nativeModel.tables.find(table => table.name === name);

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: rows options project and filter with one cross-dialect contract`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const schema = `rows_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let postgres;
  let database = source;
  try {
    seedAllTables(source);
    if (dialect === 'postgres') {
      postgres = await PostgresDatabase.open({
        connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        schema,
        create: true
      });
      await transferDatabase(source, postgres);
      database = postgres;
    }

    const baseItem = fixtureRow(definition('BaseItems'));
    const [projected] = await database.rows('BaseItems', {
      columns: ['RunTimeTicks', 'Id', 'IsFolder']
    });
    assert.deepEqual(Object.keys(projected), ['RunTimeTicks', 'Id', 'IsFolder']);
    assert.deepEqual(projected, {
      RunTimeTicks: baseItem.RunTimeTicks,
      Id: fixtureIds.BaseItems,
      IsFolder: true
    });
    assert.equal(typeof projected.RunTimeTicks, 'bigint');
    assert.equal(typeof projected.IsFolder, 'boolean');

    const [image] = await database.rows('BaseItemImageInfos', { columns: ['Blurhash'] });
    assert.ok(Buffer.isBuffer(image.Blurhash));
    assert.deepEqual(image.Blurhash, fixtureRow(definition('BaseItemImageInfos')).Blurhash);

    const userData = fixtureRow(definition('UserData'));
    const page = await database.rows('UserData', {
      columns: ['LastPlayedDate'],
      where: { UserId: fixtureIds.Users },
      whereNotNull: ['PlaybackPositionTicks'],
      orderBy: [{ column: 'CustomDataKey', direction: 'ASC' }],
      limit: 1,
      offset: 1
    });
    assert.deepEqual(page, [{ LastPlayedDate: userData.LastPlayedDate }],
      'predicate, non-null and ordering columns need not be projected');

    assert.deepEqual(await database.rows('UserData', {
      columns: ['CustomDataKey'],
      where: { UserId: fixtureIds.Users },
      whereNotNull: ['LastPlayedDate']
    }), [{ CustomDataKey: userData.CustomDataKey }]);
    assert.deepEqual(await database.rows('UserData', {
      columns: ['CustomDataKey'],
      where: { UserId: fixtureIds.Users, LastPlayedDate: null },
      whereNotNull: ['LastPlayedDate']
    }), [], 'where and whereNotNull combine with AND semantics');
    assert.equal((await database.rows('UserData', {
      columns: ['CustomDataKey'],
      where: { UserId: fixtureIds.Users },
      whereNotNull: []
    })).length, 2, 'an empty whereNotNull list is a no-op');

    assert.deepEqual(await database.rows('UserData', {
      columns: ['LastPlayedDate'],
      whereIn: { LastPlayedDate: [null, userData.LastPlayedDate], UserId: [fixtureIds.Users] },
      orderBy: [{ column: 'LastPlayedDate' }]
    }), [{ LastPlayedDate: null }, { LastPlayedDate: userData.LastPlayedDate }],
    'set predicates include explicit null and combine across columns');
    assert.deepEqual(await database.rows('BaseItems', {
      columns: ['Id'], whereIn: { Id: [] }
    }), [], 'an empty identity set never turns into an unbounded query');
    assert.deepEqual(await database.rows('BaseItems', {
      columns: ['RunTimeTicks'], whereIn: { RunTimeTicks: [baseItem.RunTimeTicks - 1n, baseItem.RunTimeTicks] }
    }), [{ RunTimeTicks: baseItem.RunTimeTicks }], 'Int64 set binding retains exact precision');
    assert.deepEqual(await database.rows('BaseItems', {
      columns: ['IsFolder'], whereIn: { IsFolder: [true] }, where: { Id: fixtureIds.BaseItems }
    }), [{ IsFolder: true }], 'set and equality predicates use AND semantics');
    assert.deepEqual(await database.rows('BaseItems', {
      columns: ['Id'], whereAny: { Id: [fixtureIds.BaseItems], Path: ['Z:\\missing.mkv'] }
    }), [{ Id: fixtureIds.BaseItems }], 'whereAny set predicates use OR semantics and retain SQL ordering');
    assert.deepEqual(await database.rows('BaseItemImageInfos', {
      columns: ['Blurhash'], whereIn: { Blurhash: [Buffer.from([0]), image.Blurhash] }
    }), [image], 'binary sets bind bytes without text conversion');
    const orderedUserData = await database.rows('UserData');
    const cursor = Object.fromEntries(definition('UserData').primaryKey
      .map(key => [key, orderedUserData[0][key]]));
    assert.deepEqual(await database.rows('UserData', { after: cursor }), orderedUserData.slice(1),
      'keyset pagination resumes strictly after a complete composite primary key');
    const manyIds = Array.from({ length: 40000 }, (_, index) => `nonexistent-${index}`);
    manyIds.push(fixtureIds.BaseItems, "'); DROP TABLE BaseItems; --");
    assert.deepEqual(await database.rows('BaseItems', {
      columns: ['Id'], whereIn: { Id: manyIds }
    }), [{ Id: fixtureIds.BaseItems }], 'large identity sets use one parameter and bind text as data');

    const rejected = options => Promise.resolve().then(() => database.rows('BaseItems', options));
    for (const options of [
      { columns: 'Id' },
      { columns: [] },
      { columns: ['Id', 'Id'] }
    ]) await assert.rejects(rejected(options), /columns must contain unique column names/);
    await assert.rejects(rejected({ columns: ['UnknownColumn'] }), /Unknown native column: BaseItems\.UnknownColumn/);

    for (const options of [
      { whereNotNull: 'Path' },
      { whereNotNull: ['Path', 'Path'] }
    ]) await assert.rejects(rejected(options), /whereNotNull must contain unique column names/);
    await assert.rejects(rejected({ whereNotNull: ['UnknownColumn'] }), /Unknown native column: BaseItems\.UnknownColumn/);
    for (const whereIn of [null, [], 'Id']) {
      await assert.rejects(rejected({ whereIn }), /whereIn must be a column-to-array object/);
    }
    await assert.rejects(rejected({ whereIn: { Id: 'not-an-array' } }), /whereIn values must be arrays/);
    await assert.rejects(rejected({ whereIn: { Id: Array(1) } }), /cannot be undefined/);
    await assert.rejects(rejected({ whereIn: { UnknownColumn: [] } }), /Unknown native column: BaseItems\.UnknownColumn/);
    await assert.rejects(rejected({ whereIn: { RunTimeTicks: [9007199254740992] } }), /safe integer or BigInt/);
    for (const whereAny of [null, [], 'Id']) {
      await assert.rejects(rejected({ whereAny }), /whereAny must be a column-to-array object/);
    }
    await assert.rejects(rejected({ whereAny: { Id: 'not-an-array' } }), /whereIn values must be arrays/);
    await assert.rejects(rejected({ whereAny: { UnknownColumn: [] } }), /Unknown native column: BaseItems\.UnknownColumn/);
    await assert.rejects(rejected({ after: { Id: fixtureIds.BaseItems, Unexpected: true } }),
      /after must contain exactly the complete primary key/);
    await assert.rejects(rejected({ after: { Id: fixtureIds.BaseItems }, orderBy: [{ column: 'Id' }] }),
      /requires the default primary-key order/);
    await assert.rejects(rejected({ after: { Id: fixtureIds.BaseItems }, offset: 1 }),
      /requires the default primary-key order/);
  } finally {
    try {
      if (postgres) {
        try {
          await postgres.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`);
        } finally { await postgres.close(); }
      }
    } finally { source.close(); }
  }
});

test('PostgreSQL batch inserts stay set-based and split only at the protocol parameter ceiling', async () => {
  const table = definition('BaseItems');
  const statements = [];
  const client = {
    async query(text, values) {
      statements.push({ text, values });
      return { rowCount: values.length / table.columns.length, rows: [] };
    }
  };
  const database = new PostgresDatabase({}, 'batch_fixture', { client });
  const fixture = fixtureRow(table);
  const rows = Array.from({ length: 920 }, (_, index) => ({ ...fixture, Id: `batch-${index}` }));

  assert.equal(await database.insertBatch('BaseItems', []), 0n);
  assert.equal(await database.insertBatch('BaseItems', rows), 920n);
  assert.equal(statements.length, 2);
  assert.ok(statements.every(statement => statement.values.length <= 65_535));
  assert.ok(statements.every(statement => /^INSERT INTO "BaseItems"/u.test(statement.text)));
  assert.equal(statements.reduce((count, statement) => count + statement.values.length / table.columns.length, 0), 920);
});

test('PostgreSQL batch inserts accept one consistent partial shape and omit generated columns', async () => {
  const statements = [];
  const client = {
    async query(text, values) {
      statements.push({ text, values });
      return { rowCount: 2, rows: [] };
    },
  };
  const database = new PostgresDatabase({}, 'batch_partial_fixture', { client });
  const rows = [
    { Value: 1, UserId: fixtureIds.Users, RowVersion: 0n, Kind: 0 },
    { Kind: 1, RowVersion: 0n, UserId: fixtureIds.Users, Value: 0 },
  ];

  assert.equal(await database.insertBatch('Permissions', rows), 2n);
  assert.equal(statements.length, 1);
  assert.match(statements[0].text,
    /^INSERT INTO "Permissions" \("Kind", "RowVersion", "UserId", "Value"\) VALUES/u);
  assert.doesNotMatch(statements[0].text, /"Id"/u);
  assert.deepEqual(statements[0].values,
    ['0', '0', Buffer.from(fixtureIds.Users), true, '1', '0', Buffer.from(fixtureIds.Users), false]);

  await assert.rejects(database.insertBatch('Permissions', [{ ...rows[0] }, { ...rows[1], Value: undefined }]),
    /cannot be undefined/u);
  await assert.rejects(database.insertBatch('Permissions', [{ ...rows[0] }, { ...rows[1], Unexpected: true }]),
    /consistent Permissions row shape/u);
  await assert.rejects(database.insertBatch('Permissions', [{ Kind: 0, RowVersion: 0n, UserId: fixtureIds.Users }]),
    /Missing Permissions\.Value/u);
});

test('PostgreSQL upsert emits a valid returning no-op update for primary-key-only tables', async () => {
  const statements = [];
  const value = { ItemValueId: fixtureIds.ItemValues, ItemId: fixtureIds.BaseItems };
  const client = {
    async query(text, values) {
      statements.push({ text, values });
      return { rowCount: 1, rows: [Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Buffer.from(entry)]))] };
    },
  };
  const database = new PostgresDatabase({}, 'upsert_fixture', { client });

  assert.deepEqual(await database.upsert('ItemValuesMap', value), value);
  assert.equal(statements.length, 1);
  assert.match(statements[0].text,
    /ON CONFLICT \("ItemValueId", "ItemId"\) DO UPDATE SET "ItemValueId" = EXCLUDED\."ItemValueId" RETURNING \*/u);
  await assert.rejects(database.update('ItemValuesMap', value, {}), /at least one changed value/u);
  assert.equal(statements.length, 1, 'an empty update fails before issuing SQL');
});
