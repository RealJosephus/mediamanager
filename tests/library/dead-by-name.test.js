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

const fixture = new URL('./fixtures/dead-by-name/', import.meta.url);
const bytes = await readFile(new URL('native.json', fixture));
const reference = parseLosslessJson(bytes.toString('utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
const columns = tableDefinition('BaseItems').columns;
const inputRow = row => Object.fromEntries(columns.map(column => [column.name,
  row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]]));

test('dead-by-name recording seals the actual repository and SQLite selectors', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.nativeSha256);
  assert.equal(reference.actualRepository, true); assert.equal(reference.actualSqlite, true);
  assert.equal(reference.mediaOpened, false); assert.equal(reference.portOpened, false);
  assert.equal(reference.observations.length, 17);
  for (const row of reference.rows) assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  for (const source of provenance.oracleSources) {
    const location = source.name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture);
    assert.equal(createHash('sha256').update(await readFile(location)).digest('hex'), source.sha256, source.name);
  }
});

test('postgres: dead Genre/Studio raw global names, defaults, count and pages match all 17 native queries', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database } = await setupChildrenFixture(t);
  const referenced = new Set(reference.rows.flatMap(row => [row.OwnerId, row.PrimaryVersionId].filter(Boolean).map(guid)));
  const rows = [...reference.rows.filter(row => referenced.has(guid(row.Id))), ...reference.rows.filter(row => !referenced.has(guid(row.Id)))];
  for (const row of rows) await database.insert('BaseItems', inputRow(row));
  for (const value of reference.values) {
    const { type, ...row } = value;
    await database.insert('ItemValues', { ...row, ItemValueId: nativeGuid(row.ItemValueId), Type: type });
  }
  for (const row of reference.maps) await database.insert('ItemValuesMap', { ItemId: nativeGuid(row.ItemId), ItemValueId: nativeGuid(row.ItemValueId) });
  for (const observation of reference.observations) {
    const query = { includeitemtypes: observation.kindNames, sortby: ['SortName'],
      ...(observation.deadGenre == null ? {} : { isdeadgenre: observation.deadGenre }),
      ...(observation.deadStudio == null ? {} : { isdeadstudio: observation.deadStudio }),
      ...(observation.locked == null ? {} : { islocked: observation.locked }),
      ...(observation.start == null ? {} : { startindex: observation.start }),
      ...(observation.limit == null ? {} : { limit: observation.limit }) };
    const result = await queryPostgresItemPage(database, query, { groupByPresentationKey: false });
    assert.equal(result.total, observation.TotalRecordCount, JSON.stringify(query));
    assert.equal(result.startIndex, observation.start ?? 0);
    assert.deepEqual(result.rows.map(row => guid(row.Id)), observation.ids.map(guid), JSON.stringify(query));
  }
});

test('postgres: a 20,000-row by-name cleanup selector returns one row and counts in SQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database } = await setupChildrenFixture(t);
  const type = 'MediaBrowser.Controller.Entities.Genre';
  const prefix = 'ba350000-0000-0000-0000-';
  await database.insert('ItemValues', { ItemValueId: prefix + '000000099999', Type: 2, Value: 'Keep', CleanValue: 'dead' });
  const constructor = inputRow(reference.rows.find(row => row.Type === type && row.Name === 'Alive'));
  await database.client.query({ text: `INSERT INTO "BaseItems"
    SELECT created.* FROM generate_series(1, 20000) value
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItems", $1::jsonb || jsonb_build_object(
      'Id', $2::text || lpad(value::text, 12, '0'), 'Path', NULL,
      'Name', CASE WHEN value <= 1000 THEN 'Keep' ELSE 'Dead' END,
      'CleanName', 'keep', 'SortName', lpad(value::text, 12, '0'))) created`,
    values: [JSON.stringify(constructor), prefix] });
  const execute = database.client.query.bind(database.client); let largest = 0;
  database.client.query = async (...args) => { const result = await execute(...args); largest = Math.max(largest, result.rows.length); return result; };
  const result = await queryPostgresItemPage(database, { includeitemtypes: ['Genre'], isdeadgenre: true, islocked: false,
    sortby: ['SortName'], limit: 1 }, { groupByPresentationKey: false });
  assert.equal(result.total, 19000); assert.equal(result.rows.length, 1);
  assert.equal(guid(result.rows[0].Id), prefix + '000000001001'); assert.equal(largest, 1);
});
