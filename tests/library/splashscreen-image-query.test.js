import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tableDefinition } from '../../src/database/model.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { SplashscreenPostScanTask } from '../../src/library/splashscreen-post-scan-task.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const fixture = new URL('./fixtures/splashscreen-query/', import.meta.url);
const [bytes, inputBytes, proofBytes] = await Promise.all(['native.json', 'input.json', 'provenance.json']
  .map(filename => readFile(new URL(filename, fixture))));
const native = parseLosslessJson(bytes.toString('utf8')), input = JSON.parse(inputBytes), proof = JSON.parse(proofBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const convert = (table, row) => Object.fromEntries(tableDefinition(table).columns.map(column => [column.name,
  row[column.name] != null && column.clrType.includes('Guid') ? nativeGuid(row[column.name]) : row[column.name]]));
const tables = ['BaseItems', 'BaseItemImageInfos', 'LinkedChildren'];
async function seed(database, row) {
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [index, table] of tables.entries()) for (const entry of [row.rows, row.imageRows, row.links][index]) {
      await db.insert(table, convert(table, entry));
    }
  });
}

test('splashscreen query fixtures bind nine actual repository SQLite observations and complete rows', async () => {
  assert.equal(hash(bytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.equal(native.actualPostScanTask, true);
  assert.equal(native.actualRepository, true); assert.equal(native.actualSqlite, true); assert.equal(native.imageEncoderControlled, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false); assert.equal(native.results.length, 9);
  assert.deepEqual(native.results.map(row => row.sample.Name), input.map(row => row.Name));
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
  for (const row of native.results) for (const [index, table] of tables.entries()) {
    for (const entry of [row.rows, row.imageRows, row.links][index]) {
      assert.deepEqual(Object.keys(entry).sort(), tableDefinition(table).columns.map(column => column.name).sort(), row.sample.Name);
    }
  }
});

test('postgres: splashscreen selects at most 30 paths from 20,000 items without loading images or item closures into Node', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database, library } = await setupChildrenFixture(t);
  const row = native.results.find(row => row.sample.Name === 'type-rating-version-and-first-image');
  const base = convert('BaseItems', row.rows.find(item => item.Name === 'Item 1'));
  const image = convert('BaseItemImageInfos', row.imageRows[0]), prefix = 'BA470000-0000-0000-0000-';
  await database.client.query({ text: `INSERT INTO "BaseItems"
    SELECT created.* FROM generate_series(1, 20000) value
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItems", $1::jsonb || jsonb_build_object(
      'Id', $2::text || lpad(value::text, 12, '0'), 'Name', 'Splash ' || value::text,
      'SortName', lpad(value::text, 12, '0'), 'Path', NULL, 'InheritedParentalRatingValue', value % 20)) created`,
  values: [JSON.stringify(base), prefix] });
  await database.client.query({ text: `INSERT INTO "BaseItemImageInfos"
    SELECT created.* FROM generate_series(1, 20000) item CROSS JOIN generate_series(0, 3) slot
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItemImageInfos", $1::jsonb || jsonb_build_object(
      'Id', 'BA471000-0000-0000-0000-' || lpad((item * 10 + slot)::text, 12, '0'),
      'ItemId', $2::text || lpad(item::text, 12, '0'), 'Path', CASE WHEN slot = 0 THEN '' ELSE 'later-' || item::text END)) created`,
  values: [JSON.stringify(image), prefix] });
  library.load = () => assert.fail('Splashscreen selection must not materialize repository entities.');
  const execute = database.client.query.bind(database.client), queries = [];
  database.client.query = async (...args) => {
    const result = await execute(...args);
    if (String(args[0]?.text ?? args[0]).includes('splashscreen-image-selection')) queries.push({ rows: result.rows.length,
      fields: result.fields.map(field => field.name) });
    return result;
  };
  assert.deepEqual(await library.getSplashscreenImagePaths('Primary'), [], 'The limit precedes filtering an empty first image.');
  await database.client.query(`UPDATE "BaseItemImageInfos" SET "Path" = convert_to('first-' || convert_from("ItemId",'UTF8'),'UTF8') WHERE right(convert_from("Id",'UTF8'), 1) = '0'`);
  const paths = await library.getSplashscreenImagePaths('Primary');
  assert.equal(paths.length, 30); assert.equal(new Set(paths).size, 30); assert.ok(paths.every(value => value.startsWith('first-')));
  assert.deepEqual(queries, [{ rows: 0, fields: ['Path'] }, { rows: 30, fields: ['Path'] }]);
});

test('postgres: splashscreen selection, rating members and first image match nine native task/repository cases', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  for (const row of native.results) await t.test(row.sample.Name, async t => {
    const { database, library } = await setupChildrenFixture(t);
    await seed(database, row);
    const before = await Promise.all(tables.map(table => database.rows(table)));
    const execute = database.client.query.bind(database.client); let largest = 0;
    database.client.query = async (...args) => {
      const result = await execute(...args);
      if (String(args[0]?.text ?? args[0]).includes('splashscreen-image-selection')) largest = Math.max(largest, result.rows.length);
      return result;
    };
    for (const type of ['Primary', 'Thumb', 'Backdrop']) {
      const recorded = row.calls.find(call => call.imageType === type);
      if (!recorded) continue;
      const paths = await library.getSplashscreenImagePaths(type);
      if (recorded.eligible.length <= 30 || recorded.paths.length === 0) {
        assert.deepEqual(paths.toSorted(), recorded.paths.toSorted(), type);
      } else {
        const eligible = recorded.eligible.map(item => item.images[0]).filter(value => value != null && value !== '');
        assert.equal(paths.length, 30); assert.equal(new Set(paths).size, 30);
        for (const value of paths) assert.ok(eligible.includes(value), `${type}: ${value}`);
      }
    }
    const calls = [], logs = [], actualLibrary = { async getSplashscreenImagePaths(type) {
      calls.push({ action: 'query', imageType: type }); return library.getSplashscreenImagePaths(type);
    } };
    await new SplashscreenPostScanTask({ library: actualLibrary, logger: { debug: message => logs.push({ level: 'Debug', message }) },
      imageGenerator: { async createSplashscreen(posters, backdrops) { calls.push({ action: 'splashscreen', posters, backdrops }); } },
    }).run({ signal: AbortSignal.abort(), reportProgress: () => assert.fail('Native splashscreen reports no progress') });
    assert.deepEqual(calls.filter(call => call.action === 'query'), row.calls.filter(call => call.action === 'query')
      .map(call => ({ action: 'query', imageType: call.imageType })));
    assert.deepEqual(logs, row.logs); assert.ok(largest <= 30);
    assert.deepEqual(await Promise.all(tables.map(table => database.rows(table))), before);
  });
});
