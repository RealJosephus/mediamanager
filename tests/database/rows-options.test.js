import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase, queryPostgresLibraryStatement } from '../../src/database/postgres.js';
import { nativeModel, quoteIdentifier as q } from '../../src/database/model.js';
import { NativeTextCell, nativeTextBytes } from '../../src/database/native-text.js';
import { exchangePages, decodeExchangeRow } from '../../src/database/native-text-exchange.js';
import { canonicalCell } from '../../src/database/values.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { fixtureIds, fixtureRow, seedAllTables } from './fixtures.js';

const definition = name => nativeModel.tables.find(table => table.name === name);

test('PostgreSQL library statements retain fresh parameters, pool namespaces, hooks and qualified reads after TEMP shadowing', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const schema = `library_sql_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const peerSchema = schema + '_peer';
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true, max: 1,
  });
  const peer = new PostgresDatabase(database.pool, peerSchema);
  t.after(async () => {
    database.queryHook = null; peer.queryHook = null;
    try {
      await database.client.query(`DROP SCHEMA IF EXISTS ${q(peerSchema)} CASCADE`);
      await database.dropSchemasCreatedByThisOpen();
    } finally { await database.close(); }
  });
  await database.client.query(`CREATE SCHEMA ${q(peerSchema)};
    CREATE TABLE ${q(peerSchema)}."BaseItems" (LIKE ${q(schema)}."BaseItems" INCLUDING ALL)`);
  const row = { ...fixtureRow(definition('BaseItems')), Name: 'first Ω', RunTimeTicks: 9007199254740993n };
  await database.insert('BaseItems', row);
  await peer.insert('BaseItems', { ...row, Name: 'peer', RunTimeTicks: 17n });
  const query = (owner, id) => ({
    text: `SELECT "Name","RunTimeTicks" FROM ${q(owner.schemaName)}."BaseItems" WHERE "Id"=$1 ORDER BY "Id"`,
    values: [nativeTextBytes(id)],
  });
  const read = async (owner, id) => (await queryPostgresLibraryStatement(owner, query(owner, id))).rows
    .map(value => ({ Name: value.Name.toString('utf8'), RunTimeTicks: value.RunTimeTicks }));
  let firstBackend;
  await database.withConnection(async session => {
    firstBackend = (await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.deepEqual(await read(session, row.Id), [{ Name: 'first Ω', RunTimeTicks: 9007199254740993n }]);
    assert.deepEqual(await read(session, fixtureIds.Users), []);
    await session.client.query(`CREATE TEMP TABLE "BaseItems" (LIKE ${q(schema)}."BaseItems" INCLUDING ALL)`);
    try {
      await session.insert('BaseItems', { ...row, Name: 'temporary shadow', RunTimeTicks: 3n });
      assert.equal((await session.rows('BaseItems'))[0].Name, 'temporary shadow');
      assert.deepEqual(await read(session, row.Id), [{ Name: 'first Ω', RunTimeTicks: 9007199254740993n }]);
    } finally { await session.client.query('DROP TABLE pg_temp."BaseItems"'); }
  });
  await peer.withConnection(async session => {
    assert.equal((await session.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, firstBackend);
    assert.deepEqual(await read(session, row.Id), [{ Name: 'peer', RunTimeTicks: 17n }]);
    await session.upsert('BaseItems', { ...row, Name: 'peer changed', RunTimeTicks: 18n });
    assert.deepEqual(await read(session, row.Id), [{ Name: 'peer changed', RunTimeTicks: 18n }]);
  });
  const rollback = new Error('Injected library statement transaction rollback');
  await assert.rejects(database.transaction(async session => {
    await session.upsert('BaseItems', { ...row, Name: 'rolled back' });
    assert.equal((await read(session, row.Id))[0].Name, 'rolled back');
    throw rollback;
  }), reason => reason === rollback);
  assert.equal((await read(database, row.Id))[0].Name, 'first Ω');
  const acknowledgement = new Error('Injected library read acknowledgement failure');
  const original = query(database, row.Id);
  database.queryHook = async (...args) => {
    const result = await database.client.query(...args);
    if (args[0] === original) throw acknowledgement;
    return result;
  };
  try { await assert.rejects(queryPostgresLibraryStatement(database, original), reason => reason === acknowledgement); }
  finally { database.queryHook = null; }
  await database.upsert('BaseItems', { ...row, Name: 'after acknowledgement', RunTimeTicks: 9007199254740995n });
  assert.deepEqual(await read(database, row.Id), [{ Name: 'after acknowledgement', RunTimeTicks: 9007199254740995n }]);
  const options = { text: 'SELECT $1::integer AS value', values: [23] };
  database.queryHook = async (...args) => {
    if (args[0] === options) options.rowMode = 'array';
    return database.client.query(...args);
  };
  try { assert.deepEqual((await queryPostgresLibraryStatement(database, options)).rows, [[23]]); }
  finally { database.queryHook = null; }
  const divide = value => queryPostgresLibraryStatement(database, {
    text: 'SELECT 12/$1::integer AS value', values: [value],
  });
  await assert.rejects(divide(0), { code: '22012' });
  assert.deepEqual((await divide(3)).rows, [{ value: 4 }]);
  assert.equal((await read(peer, row.Id))[0].Name, 'peer changed');
});

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
    const [complete] = await database.rows('BaseItems');
    assert.deepEqual(complete, baseItem, 'The complete typed projection retains every source field.');
    assert.deepEqual(Object.keys(complete), definition('BaseItems').columns.map(column => column.name));
    const [raw] = await database.rows('BaseItems', {
      columns: ['Data', 'IsFolder', 'RunTimeTicks', 'OwnerId'], consumer: 'exchange',
    });
    assert.ok(raw.Data instanceof NativeTextCell);
    assert.deepEqual(raw.Data.bytes(), Buffer.from(baseItem.Data));
    assert.deepEqual({ ...raw, Data: raw.Data.string() }, {
      Data: baseItem.Data, IsFolder: true, RunTimeTicks: baseItem.RunTimeTicks, OwnerId: null,
    });
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
    assert.deepEqual(await database.rows('UserData', {
      columns: ['LastPlayedDate'], orderBy: [{ column: 'LastPlayedDate', direction: 'DESC' }],
    }), [{ LastPlayedDate: userData.LastPlayedDate }, { LastPlayedDate: null }],
    'an explicit descending nullable sort keeps nulls last');
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
    const chapter = fixtureRow(definition('Chapters'));
    const additionalChapters = [7, 3, 11, 2, 5, 0].map(ChapterIndex => ({ ...chapter, ChapterIndex,
      Name: 'Chapter ' + ChapterIndex, StartPositionTicks: 9007199254740993n + BigInt(ChapterIndex) }));
    await database.insertBatch('Chapters', additionalChapters);
    const expectedChapters = [chapter, ...additionalChapters].toSorted((left, right) => left.ChapterIndex - right.ChapterIndex);
    const pagedChapters = [];
    let chapterCursor;
    for (;;) {
      const page = await database.rows('Chapters', { limit: 2, ...(chapterCursor === undefined ? {} : { after: chapterCursor }) });
      assert.ok(page.length <= 2);
      pagedChapters.push(...page);
      if (page.length < 2) break;
      chapterCursor = Object.fromEntries(definition('Chapters').primaryKey.map(key => [key, page.at(-1)[key]]));
    }
    assert.deepEqual(pagedChapters, expectedChapters,
      'complete composite-key pages retain every typed field, including rows sharing the leading key and exact Int64 positions');
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

for (const dialect of ['sqlite', 'postgres']) test(`${dialect}: raw composite primary-key pages match the same SQLite BINARY source`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const schema = `raw_rows_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let postgres;
  try {
    seedAllTables(source);
    const table = definition('UserData'), template = fixtureRow(table);
    source.deleteWhere(table.name, { ItemId: template.ItemId });
    const keys = [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 1]), Buffer.from([1]),
      Buffer.from([97, 0, 97]), Buffer.from([97, 0, 122]), Buffer.from([0x80]), Buffer.from([0xff]),
      Buffer.from([0xc3, 0x28]), ...['ASCII', 'ascii', 'café', 'cafe\u0301', '中文', '😀', '\ue000'].map(value => Buffer.from(value)),
      ...Array.from({ length: 260 }, (_, index) => Buffer.from('page-' + String(index).padStart(3, '0')))];
    source.insertBatch(table.name, keys.toReversed().map((bytes, index) => ({ ...template,
      CustomDataKey: new NativeTextCell(bytes), PlaybackPositionTicks: 9007199254740993n + BigInt(index),
      LastPlayedDate: index % 2 ? null : template.LastPlayedDate, Likes: index % 3 ? null : false })));
    source.preflight();
    // The reference names source columns explicitly and uses the native BINARY
    // comparator. The projected raw-byte aliases cannot choose its ordering.
    const selected = table.columns.map(column => column.type === 'TEXT'
      ? `CAST(original.${q(column.name)} AS BLOB) AS ${q(column.name)}` : `original.${q(column.name)}`).join(', ');
    const reference = order => {
      const query = source.database.prepare(`SELECT ${selected} FROM ${q(table.name)} original ORDER BY ${order}`);
      query.setReadBigInts(true);
      return query.all().map(row => decodeExchangeRow(table, row, 'sqlite'));
    };
    const expected = reference(table.primaryKey.map(key => `original.${q(key)} COLLATE BINARY ASC`).join(', '));
    assert.deepEqual(expected.map(row => nativeTextBytes(row.CustomDataKey)), keys.toSorted(Buffer.compare));
    const cells = rows => rows.map(row => table.columns.map(column => canonicalCell(row[column.name])));
    if (dialect === 'postgres') {
      postgres = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        schema, create: true, deferRuntimeSchemaInitialization: true });
      await transferDatabase(source, postgres);
    }
    const database = postgres ?? source, actual = [];
    let after;
    for (;;) {
      const page = await database.rows(table.name, { consumer: 'exchange', limit: 128, ...(after === undefined ? {} : { after }) });
      assert.ok(page.length <= 128); actual.push(...page);
      if (page.length < 128) break;
      after = Object.fromEntries(table.primaryKey.map(key => [key, page.at(-1)[key]]));
    }
    assert.deepEqual(cells(actual), cells(expected));
    const exchanged = [];
    for await (const page of exchangePages(database, table, { pageSize: 128 })) {
      assert.ok(page.length <= 128); exchanged.push(...page);
    }
    assert.deepEqual(cells(exchanged), cells(expected), 'the independent raw exchange plan retains every byte and complete key');
    const explicit = await database.rows(table.name, { consumer: 'exchange', orderBy: [
      { column: 'LastPlayedDate', direction: 'DESC' }, { column: 'CustomDataKey', direction: 'ASC' },
    ] });
    assert.deepEqual(cells(explicit), cells(reference('original."LastPlayedDate" COLLATE BINARY DESC, original."CustomDataKey" COLLATE BINARY ASC')));
  } finally {
    try {
      if (postgres) {
        try { await postgres.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
        finally { await postgres.close(); }
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
