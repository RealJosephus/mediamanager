import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { readNativeImageRows, readNativeTrailerRows, insertNativeImageBatch } from '../../src/database/native-relation-order.js';
import { transferDatabase, databaseDigest } from '../../src/migration/database-transfer.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { readItemTrailerRows } from '../../src/library/trailer-order.js';

const itemId = '8b000000-0000-0000-0000-000000000001';
const imageIds = [
  '8b000000-0000-0000-0000-000000000013',
  '8b000000-0000-0000-0000-000000000011',
  '8b000000-0000-0000-0000-000000000012',
];
const fixtureRoot = new URL('./fixtures/native-relation-order/', import.meta.url);
const native = JSON.parse(await readFile(new URL('native.json', fixtureRoot), 'utf8'));

test('native relation order evidence seals fresh-context reads and mutation controls', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
  for (const file of provenance.fixtureFiles) {
    assert.equal(createHash('sha256').update(await readFile(new URL(`../../${file.path}`, import.meta.url))).digest('hex'), file.sha256);
  }
  assert.deepEqual(native.map(entry => entry.mode), ['batch', 'individual']);
  for (const entry of native) for (const stage of [entry.saved, entry.updated]) {
    assert.deepEqual(stage.included, stage.direct);
    assert.deepEqual(stage.trailers, stage.directTrailers);
  }
});

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, column.nullable ? null : type === 'bool' ? false
      : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
  }));
}

test('real PostgreSQL relation order is stable across a fresh root handle', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `stateless_order_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: itemId,
    Type: 'MediaBrowser.Controller.Entities.Movies.Trailer', Name: 'Order fixture' });
  for (const [index, Id] of imageIds.entries()) await database.insert('BaseItemImageInfos', {
    ...blank('BaseItemImageInfos'), Id, ItemId: itemId, ImageType: [3, 0, 3][index], Path: `Z:\\Order\\${index}.jpg`,
  });
  for (const Id of [5, 2, 4]) await database.insert('BaseItemTrailerTypes', { ItemId: itemId, Id });
  await database.withConnection(async session => {
    // Mutating a caller's projection cannot change the persisted next read.
    (await readItemImageRows(session, itemId)).reverse();
    (await readItemTrailerRows(session, itemId)).reverse();
  });

  const restarted = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
  });
  try {
    const result = await restarted.withConnection(async session => ({
      images: (await readItemImageRows(session, itemId)).map(row => row.Id),
      trailers: (await readItemTrailerRows(session, itemId)).map(row => row.Id),
    }));
    assert.deepEqual(result.images, [imageIds[1], imageIds[0], imageIds[2]]);
    assert.deepEqual(result.trailers, [5, 2, 4]);
    await database.update('BaseItemImageInfos', { Id: imageIds[0] }, { ImageType: 0 });
    assert.deepEqual((await readItemImageRows(restarted, itemId)).map(row => row.Id), imageIds,
      'changing a type keeps the original insertion order within its new type');
    await database.delete('BaseItemImageInfos', { Id: imageIds[1] });
    await database.delete('BaseItemTrailerTypes', { ItemId: itemId, Id: 4 });
    assert.deepEqual((await readItemImageRows(restarted, itemId)).map(row => row.Id), [imageIds[0], imageIds[2]]);
    assert.deepEqual((await readItemTrailerRows(restarted, itemId)).map(row => row.Id), [5, 2]);
    await assert.rejects(database.transaction(async db => {
      await db.insert('BaseItemTrailerTypes', { ItemId: itemId, Id: 1 });
      throw new Error('rollback ordered relation');
    }), /rollback ordered relation/);
    assert.deepEqual((await readItemTrailerRows(restarted, itemId)).map(row => row.Id), [5, 2]);
    await database.preflight();
    await database.client.query(`DELETE FROM "${schema}__mm".image_order WHERE image_id = $1`, [imageIds[0]]);
    await assert.rejects(database.preflight(), /native relation order is incomplete/);
  } finally { await restarted.close(); }
});

for (const expected of native) test(`PostgreSQL and SQLite preserve native ${expected.mode} relation order across transfer and updates`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const database = await createPostgresTestDatabase(t, 'native_order');
  const source = new SqliteDatabase(':memory:', { create: true });
  const exported = new SqliteDatabase(':memory:', { create: true });
  t.after(() => { source.close(); exported.close(); });
  source.insert('BaseItems', { ...blank('BaseItems'), Id: itemId,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Native order fixture' });
  const rows = [[9, 3], [7, 0], [5, 3], [3, 0]].map(([number, ImageType]) => ({
    ...blank('BaseItemImageInfos'), Id: `84000000-0000-0000-0000-${String(number).padStart(12, '0')}`,
    ItemId: itemId, ImageType, Path: `${number}.jpg`, DateModified: '0001-01-01 00:00:00',
  }));
  const savedRows = expected.mode === 'batch' ? rows.toSorted((a, b) => a.Id.localeCompare(b.Id)) : rows;
  for (const row of savedRows) source.insert('BaseItemImageInfos', row);
  for (const Id of expected.mode === 'batch' ? [2, 4, 5] : [5, 2, 4]) source.insert('BaseItemTrailerTypes', { Id, ItemId: itemId });
  await transferDatabase(source, database, { batchSize: 2,
    instanceBinding: { serverId: itemId.replaceAll('-', ''), originIdentityDigest: 'a'.repeat(64) } });
  const check = async (db, stage) => {
    assert.deepEqual((await readNativeImageRows(db, [itemId])).map(row => row.Path), stage.included);
    assert.deepEqual((await readNativeTrailerRows(db, [itemId])).map(row => row.Id), stage.trailers);
  };
  await check(database, expected.saved);
  await transferDatabase(database, exported, { batchSize: 1 });
  assert.deepEqual(await databaseDigest(database, { batchSize: 3 }), await databaseDigest(exported, { batchSize: 2 }));
  for (const db of [database, exported]) {
    await db.update('BaseItemImageInfos', { Id: rows[0].Id }, { ImageType: 0 });
    await db.insert('BaseItemTrailerTypes', { Id: 3, ItemId: itemId });
    await check(db, expected.updated);
  }
  const returned = await createPostgresTestDatabase(t, 'returned_order');
  await transferDatabase(exported, returned, { batchSize: 3 });
  await check(returned, expected.updated);
  const reopened = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: returned.schemaName });
  try { await check(reopened, expected.updated); }
  finally { await reopened.close(); }
  await database.deleteWhere('BaseItemImageInfos', { ItemId: itemId });
  await insertNativeImageBatch(database, rows);
  assert.deepEqual((await readItemImageRows(database, itemId)).map(row => row.Path), native[0].saved.included,
    'runtime SaveChanges batches sort new GUIDs before insertion');
});
