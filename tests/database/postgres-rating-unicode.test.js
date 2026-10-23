import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tableDefinition } from '../../src/database/model.js';
import { encodeValue } from '../../src/database/values.js';
import { nativeTextBytes, nativeRatingCountryContext } from '../../src/database/native-text.js';
import { postgresParentalRatingScoreFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { input, recordCurrentParentalRatingOnce } from '../core/parental-rating-unicode-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL || !process.env.MEDIAMANAGER_TEST_POSTGRES,
  timeout: 300000 };
const instanceBinding = { serverId: '44112233445566778899aabbccddeeff',
  originIdentityDigest: '4411223344556677'.repeat(4) };
async function openDatabase(t) {
  const schema = 'rating_unicode_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    try { await database.client.query(`DROP SCHEMA "${schema}", "${schema}__mm" CASCADE`); }
    finally { await database.close(); }
  });
  return database;
}

test('postgres: fresh fingerprinted rating helper matches all 63 current Native inputs including NUL', enabled, async t => {
  const { inputBytes, input: currentInput, native } = await recordCurrentParentalRatingOnce();
  assert.deepEqual(currentInput, input);
  assert.equal(native.InputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  const database = await openDatabase(t);
  await database.preflight();
  let compared = 0;
  for (const [index, sample] of input.scores.entries()) {
    const result = (await database.client.query({ text: `SELECT "${database.schemaName}"."${postgresParentalRatingScoreFunctionName}"($1, $2::jsonb) AS score`,
      values: [nativeTextBytes(sample.Rating), nativeRatingCountryContext(sample.Country, 'US')] })).rows[0].score;
    const expected = native.Scores[index];
    assert.equal(Object.hasOwn(expected, 'Exception'), false, sample.Name);
    assert.equal(Object.hasOwn(expected, 'Error'), false, sample.Name);
    assert.equal(typeof expected.HasScore, 'boolean', sample.Name);
    assert.deepEqual(result, expected.HasScore ? [expected.Score, expected.SubScore] : null, sample.Name);
    compared++;
  }
  assert.equal(compared, 63);
});

test('postgres: NUL, SOH and escape spelling stay distinct in native bytea authority', enabled, async t => {
  const database = await openDatabase(t);
  for (const value of ['18\0', '18\u0001', '18\\u0000', '\uFEFF18\0']) {
    const bytes = encodeValue({ name: 'OfficialRating', type: 'TEXT', nullable: true }, value, 'postgres');
    const actual = (await database.client.query('SELECT $1::bytea AS value', [bytes])).rows[0].value;
    assert.deepEqual(actual, Buffer.from(value));
  }
});

test('parental-rating fields preserve Unicode, NUL, null and empty values through SQLite to PostgreSQL to SQLite', enabled, async t => {
  const { native } = await recordCurrentParentalRatingOnce();
  const database = await openDatabase(t);
  const source = new SqliteDatabase(':memory:', { create: true });
  const returned = new SqliteDatabase(':memory:', { create: true });
  t.after(() => { source.close(); returned.close(); });
  const baseItems = tableDefinition('BaseItems');
  const blank = Object.fromEntries(baseItems.columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, column.nullable ? null : type === 'bool' ? false
      : column.type === 'TEXT' ? '' : column.type === 'REAL' ? 0 : 0n];
  }));
  const records = input.scores.map((sample, index) => {
    const observed = native.Scores[index];
    return {
      Id: `44110000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      OfficialRating: sample.Rating,
      CustomRating: index % 2 === 0 ? null : sample.Rating,
      InheritedParentalRatingValue: observed.HasScore ? observed.Score : null,
      InheritedParentalRatingSubValue: observed.HasScore ? observed.SubScore : null,
    };
  });
  records.push({ Id: '44110000-0000-0000-0000-000000000064', OfficialRating: null, CustomRating: null,
    InheritedParentalRatingValue: null, InheritedParentalRatingSubValue: null });
  records.push({ Id: '44110000-0000-0000-0000-000000000065', OfficialRating: '', CustomRating: '',
    InheritedParentalRatingValue: 0, InheritedParentalRatingSubValue: 0 });
  records.push({ Id: '44110000-0000-0000-0000-000000000066', OfficialRating: '18\u0001', CustomRating: '18\\u0000',
    InheritedParentalRatingValue: null, InheritedParentalRatingSubValue: null });
  for (const record of records) source.insert('BaseItems', { ...blank, ...record,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', IsMovie: true });
  const projection = rows => rows.map(row => Object.fromEntries(['Id', 'OfficialRating', 'CustomRating',
    'InheritedParentalRatingValue', 'InheritedParentalRatingSubValue'].map(name => [name, row[name]])))
    .sort((left, right) => left.Id.localeCompare(right.Id));
  const expected = projection(records);

  await transferDatabase(source, database, { instanceBinding });
  assert.deepEqual(projection(await database.rows('BaseItems')), expected, 'SQLite to PostgreSQL field values');
  const rawValue = value => value === null ? { type: 'null', hex: null }
    : { type: 'text', hex: Buffer.from(value).toString('hex').toUpperCase() };
  const postgresRaw = (await database.client.query(`SELECT convert_from("Id",'UTF8') AS "Id",
    CASE WHEN "OfficialRating" IS NULL THEN NULL ELSE upper(encode("OfficialRating",'hex')) END AS "OfficialHex",
    CASE WHEN "CustomRating" IS NULL THEN NULL ELSE upper(encode("CustomRating",'hex')) END AS "CustomHex"
    FROM "${database.schemaName}"."BaseItems" ORDER BY "Id"`)).rows;
  const postgresRawById = new Map(postgresRaw.map(row => [row.Id, row]));
  for (const record of records) {
    const row = postgresRawById.get(record.Id), official = rawValue(record.OfficialRating), custom = rawValue(record.CustomRating);
    assert.ok(row, record.Id);
    assert.equal(row.OfficialHex, official.hex, `${record.Id} OfficialRating raw PostgreSQL bytea`);
    assert.equal(row.CustomHex, custom.hex, `${record.Id} CustomRating raw PostgreSQL bytea`);
  }
  await transferDatabase(database, returned);
  assert.deepEqual(projection(await returned.rows('BaseItems')), expected, 'PostgreSQL to SQLite field values');
  const rawRows = returned.database.prepare(`SELECT CAST("Id" AS BLOB) AS "Id",
    typeof("OfficialRating") AS "OfficialType",
    CASE WHEN "OfficialRating" IS NULL THEN NULL ELSE hex(CAST("OfficialRating" AS BLOB)) END AS "OfficialHex",
    typeof("CustomRating") AS "CustomType",
    CASE WHEN "CustomRating" IS NULL THEN NULL ELSE hex(CAST("CustomRating" AS BLOB)) END AS "CustomHex"
    FROM "BaseItems" ORDER BY "Id"`).all();
  const rawById = new Map(rawRows.map(row => [Buffer.from(row.Id).toString('utf8'), row]));
  for (const record of records) {
    const row = rawById.get(record.Id), official = rawValue(record.OfficialRating), custom = rawValue(record.CustomRating);
    assert.ok(row, record.Id);
    assert.deepEqual({ type: row.OfficialType, hex: row.OfficialHex }, official, `${record.Id} OfficialRating raw SQLite cell`);
    assert.deepEqual({ type: row.CustomType, hex: row.CustomHex }, custom, `${record.Id} CustomRating raw SQLite cell`);
  }
});
