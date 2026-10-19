import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { tableDefinition } from '../../src/database/model.js';
import { guid } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const fixture = new URL('./fixtures/dead-parent/', import.meta.url);
const [bytes, inputBytes, proofBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const native = parseLosslessJson(bytes.toString('utf8'));
const input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const columns = tableDefinition('BaseItems').columns;
const inputRow = row => Object.fromEntries(columns.map(column => [column.name,
  row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]]));

test('dead-parent fixtures bind independent inputs and actual repository SQLite observations', async () => {
  assert.equal(hash(bytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  assert.equal(native.actualRepository, true); assert.equal(native.actualSqlite, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(native.observations.length, 20); assert.deepEqual(native.observations.map(row => row.sample), input);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  for (const row of native.rows) assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256, source.name);
});

test('postgres: dead-parent raw IDs, default exclusions, count and pages match 20 native queries', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database } = await setupChildrenFixture(t);
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const row of native.rows) await db.insert('BaseItems', inputRow(row));
  });
  for (const observation of native.observations) {
    const query = { includeitemtypes: observation.sample.Kinds, sortby: ['SortName'],
      ...(observation.sample.Flag == null ? {} : { hasdeadparentid: observation.sample.Flag }),
      startindex: observation.sample.Start,
      ...(observation.sample.Limit == null ? {} : { limit: observation.sample.Limit }) };
    const result = await queryPostgresItemPage(database, query, { groupByPresentationKey: false });
    assert.equal(result.total, observation.TotalRecordCount, JSON.stringify(query));
    assert.equal(result.startIndex, observation.sample.Start);
    assert.deepEqual(result.rows.map(row => guid(row.Id)), observation.ids.map(guid), JSON.stringify(query));
  }
});

test('postgres: dead-parent selection counts 19,000 items in SQL and loads one result', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database } = await setupChildrenFixture(t);
  const placeholder = native.rows.find(row => row.Id === '00000000-0000-0000-0000-000000000001');
  const parent = native.rows.find(row => row.Name === 'Living parent');
  await database.insert('BaseItems', inputRow(placeholder)); await database.insert('BaseItems', inputRow(parent));
  const template = inputRow(native.rows.find(row => row.Name === 'Item 12'));
  const prefix = 'ba410000-0000-0000-0000-';
  await database.client.query({ text: `INSERT INTO "BaseItems"
    SELECT created.* FROM generate_series(1, 20000) value
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItems", $1::jsonb || jsonb_build_object(
      'Id', $2::text || lpad(value::text, 12, '0'), 'Path', NULL,
      'Name', 'Item ' || value::text, 'SortName', lpad(value::text, 12, '0'),
      'ParentId', CASE WHEN value <= 1000 THEN $3::text ELSE $4::text END)) created`,
    values: [JSON.stringify(template), prefix, nativeGuid(parent.Id), nativeGuid(placeholder.Id)] });
  const execute = database.client.query.bind(database.client); let largest = 0;
  database.client.query = async (...args) => {
    const result = await execute(...args); largest = Math.max(largest, result.rows.length); return result;
  };
  const result = await queryPostgresItemPage(database, { hasdeadparentid: true, sortby: ['SortName'], limit: 1 },
    { groupByPresentationKey: false });
  assert.equal(result.total, 19000); assert.equal(result.rows.length, 1);
  assert.equal(guid(result.rows[0].Id), prefix + '000000001001'); assert.equal(largest, 1);
});
