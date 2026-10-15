import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { encodeValue } from '../../src/database/values.js';
import { nativeTextBytes, nativeRatingCountryContext } from '../../src/database/native-text.js';
import { postgresParentalRatingScoreFunctionName } from '../../src/database/postgres-runtime-schema.js';

const fixture = new URL('../core/fixtures/parental-rating-unicode/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', fixture)));
const native = JSON.parse(await readFile(new URL('native.json', fixture)));
const enabled = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
async function openDatabase(t) {
  const schema = 'rating_unicode_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    try { await database.client.query(`DROP SCHEMA "${schema}", "${schema}__mm" CASCADE`); }
    finally { await database.close(); }
  });
  return database;
}

test('postgres: fresh fingerprinted rating helper matches all 63 actual native inputs including NUL', enabled, async t => {
  const database = await openDatabase(t);
  await database.preflight();
  let compared = 0;
  for (const [index, sample] of input.scores.entries()) {
    const result = (await database.client.query({ text: `SELECT "${database.schemaName}"."${postgresParentalRatingScoreFunctionName}"($1, $2::jsonb) AS score`,
      values: [nativeTextBytes(sample.Rating), nativeRatingCountryContext(sample.Country, 'US')] })).rows[0].score;
    const expected = native.Scores[index];
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
