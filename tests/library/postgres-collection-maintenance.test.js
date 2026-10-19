import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { nativeGuid } from '../../src/users/native.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import { guid } from '../../src/library/records.js';
import { buildPostgresCollectionRootQuery, buildPostgresCollectionMoviePageQuery,
  buildPostgresCollectionBoxSetQuery, createPostgresCollectionMaintenanceSource } from '../../src/library/postgres-collection-maintenance.js';

const fixture = new URL('./fixtures/collection-source/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = parseLosslessJson(nativeBytes.toString()), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const id = number => 'cb210000-0000-0000-0000-' + String(number).padStart(12, '0');
const decode = value => value == null ? null : decodeNativeTextBytes(value);
const decodeRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  Buffer.isBuffer(value) ? decode(value) : value]));
const byteaJsonRow = (table, row) => Object.fromEntries(tableDefinition(table).columns.map(column => [column.name,
  column.type === 'TEXT' && row[column.name] != null ? '\\x' + nativeTextBytes(row[column.name]).toString('hex') : row[column.name]]));
const inputRow = (table, row) => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, row[column.name] != null && column.clrType.includes('Guid')
    ? nativeGuid(row[column.name]) : row[column.name]]));

test('Collection source fixture binds actual LibraryManager, Folder.Children, repository and SQLite observations', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.deepEqual(native.pages.map(page => page.sample), input.Queries);
  for (const name of ['actualLibraryManager', 'actualFolderChildren', 'actualRepository', 'actualSqlite']) assert.equal(native[name], true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.equal(proof.sources.length, 15); assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  assert.ok(proof.assemblies.some(assembly => assembly.name === 'Jellyfin.Server.Implementations'));
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256, source.name);
  assert.equal(hash(await readFile(proof.rawRecording.filename)), proof.nativeSha256, 'raw execution output remains unchanged');
  assert.equal(hash(await readFile(new URL('../../tools/compat/record-collection-source.mjs', import.meta.url))), proof.recorder.sha256);
  assert.equal(hash(await readFile(proof.oracleAssembly.filename)), proof.oracleAssembly.sha256);
  for (const source of proof.sources) for (const root of ['D:/jellyfin', proof.buildSource]) {
    assert.equal(hash(await readFile(path.join(root, source.path))), source.sha256, source.path);
  }
  assert.equal(hash(await readFile(process.env.MEDIAMANAGER_JELLYFIN_DLL || proof.jellyfinDll.filename)), proof.jellyfinDll.sha256);
  const assemblyDirectory = path.dirname(process.env.MEDIAMANAGER_JELLYFIN_DLL || proof.jellyfinDll.filename);
  for (const assembly of proof.assemblies) {
    assert.equal(hash(await readFile(path.join(assemblyDirectory, assembly.name + '.dll'))), assembly.sha256, assembly.name);
    assert.equal(native.assemblies.find(observed => observed.name === assembly.name).sha256, assembly.sha256);
  }
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  for (const row of native.rows) assert.deepEqual(Object.keys(row).sort(), columns);
});

test('Collection source requires live root options and enforces native Movie page bounds', () => {
  assert.throws(() => createPostgresCollectionMaintenanceSource({ host: {} }), TypeError);
  const host = { getAggregateFolder: () => ({ Id: id(1) }) }, callback = parent => ({ AutomaticallyAddToCollection: parent.Id === id(2) });
  const source = createPostgresCollectionMaintenanceSource({ host, getLibraryOptions: callback });
  assert.equal(source.getLibraryOptions, callback); assert.deepEqual(source.getRootFolder(), { Id: id(1) });
  for (const query of [{}, { StartIndex: 0, Limit: 1001 }, { StartIndex: -1, Limit: 1000 }, { StartIndex: 0, Limit: 0 }]) {
    assert.throws(() => buildPostgresCollectionMoviePageQuery({}, { Id: id(2) }, query), TypeError);
  }
});

async function seedNative(database) {
  await database.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, rows] of [['BaseItems', native.rows], ['AncestorIds', native.ancestors], ['LinkedChildren', native.links]]) {
      await db.insertBatch(table, rows.map(row => inputRow(table, row)));
    }
  });
}

test('postgres: Collection source matches native roots, 23 manager Movie pages and initial BoxSet order', pg, async t => {
  const database = await createPostgresTestDatabase(t, 'collection_src');
  await seedNative(database);
  await database.withConnection(async db => {
    const rootQuery = buildPostgresCollectionRootQuery(db, { Id: id(1) });
    const roots = (await db.client.query(rootQuery)).rows.map(decodeRow);
    assert.deepEqual(roots.map(({ Ordinal, ...row }) => ({ ...row, Id: guid(row.Id), ParentId: guid(row.ParentId) })), native.rootItems);
    assert.equal(roots.some(row => guid(row.Id) === id(10)), false, 'the native repository skips unknown types');
    for (const page of native.pages) {
      const parent = native.rows.find(row => guid(row.Id) === id(page.sample.Parent));
      const query = buildPostgresCollectionMoviePageQuery(db, parent, { StartIndex: page.sample.Start, Limit: page.sample.Limit });
      if (page.failure) {
        assert.equal(page.sample.Parent, 22, 'the captured failure is explicit null PhysicalFolderIds');
        await assert.rejects(db.client.query(query), error => error.code === '22023', page.sample.Name);
        continue;
      }
      const rows = (await db.client.query(query)).rows.map(decodeRow);
      assert.deepEqual(rows.map(({ Ordinal, ...row }) => ({ ...row, Id: guid(row.Id),
        PrimaryVersionId: row.PrimaryVersionId == null ? null : guid(row.PrimaryVersionId) })), page.rows, page.sample.Name);
      assert.deepEqual(rows.map(row => Number(row.Ordinal)), rows.map((_, index) => index + 1), 'ordinals are page local');
    }
    const boxes = (await db.client.query(buildPostgresCollectionBoxSetQuery(db))).rows.map(decodeRow);
    assert.deepEqual(boxes.map(({ Ordinal, ...row }) => ({ ...row, Id: guid(row.Id) })), native.boxes);
  });
});

test('postgres: Collection source retains page gates and projects only bounded rows at library scale', pg, async t => {
  const database = await createPostgresTestDatabase(t, 'collection_size');
  const root = inputRow('BaseItems', native.rows.find(row => guid(row.Id) === id(1)));
  const parent = inputRow('BaseItems', native.rows.find(row => guid(row.Id) === id(5)));
  await database.insertBatch('BaseItems', [root, parent]);
  const movie = inputRow('BaseItems', native.rows.find(row => guid(row.Id) === id(10000)));
  await database.withConnection(async db => {
    const items = `${q(db.schemaName)}.${q('BaseItems')}`, ancestors = `${q(db.schemaName)}.${q('AncestorIds')}`;
    await db.client.query({ text: `INSERT INTO ${items} SELECT selected.* FROM generate_series(1, 20000) number
      CROSS JOIN LATERAL jsonb_populate_record(NULL::${items}, $1::jsonb || jsonb_build_object(
        'Id', '\\x' || encode(convert_to($2 || lpad(number::text, 12, '0'), 'UTF8'), 'hex'),
        'Name', '\\x' || encode(convert_to('Scale ' || number, 'UTF8'), 'hex'),
        'SortName', '\\x' || encode(convert_to(lpad(number::text, 12, '0'), 'UTF8'), 'hex'),
        'Data', '\\x' || encode(convert_to(CASE WHEN number <= 1000 THEN '{"TmdbCollectionName":""}' ELSE '{"TmdbCollectionName":"Scale"}' END, 'UTF8'), 'hex'))) selected`,
      values: [JSON.stringify(byteaJsonRow('BaseItems', movie)), 'cb220000-0000-0000-0000-'] });
    await db.client.query({ text: `INSERT INTO ${ancestors} SELECT "Id", $1 FROM ${items}
      WHERE substring("Id" FROM 1 FOR 8) = $2`, values: [nativeTextBytes(parent.Id), nativeTextBytes('cb220000')] });
    const run = db.client.query.bind(db.client); let maximumRows = 0;
    db.client.query = async (...args) => { const result = await run(...args); maximumRows = Math.max(maximumRows, result.rows.length); return result; };
    try {
      for (const StartIndex of [0, 1000, 20000]) {
        const query = buildPostgresCollectionMoviePageQuery(db, parent, { StartIndex, Limit: 1000 });
        await db.client.query({ text: `CREATE TEMP TABLE collection_scale_page AS ${query.text}`, values: query.values });
        const [counts] = (await db.client.query(`SELECT count(*) AS "Rows", count(*) FILTER
          (WHERE "CollectionName" IS NOT NULL AND octet_length("CollectionName") > 0 AND "PrimaryVersionId" IS NULL) AS "Members"
          FROM collection_scale_page`)).rows;
        assert.equal(Number(counts.Rows), StartIndex === 20000 ? 0 : 1000);
        assert.equal(Number(counts.Members), StartIndex === 1000 ? 1000 : 0);
        await db.client.query('DROP TABLE collection_scale_page');
      }
      assert.equal(maximumRows, 1, 'the native page and its gates stay in SQL; Node receives one count row');
    } finally { db.client.query = run; }
  });
});
