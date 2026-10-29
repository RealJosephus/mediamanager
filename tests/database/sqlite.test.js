import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel } from '../../src/database/model.js';
import { seedAllTables, fixtureIds } from './fixtures.js';
import { canonicalCell, encodeValue } from '../../src/database/values.js';
import { NativeTextCell } from '../../src/database/native-text.js';

test('all 31 native tables and 312 columns retain typed values and composite keys', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    assert.equal(nativeModel.tables.length, 31);
    assert.equal(nativeModel.tables.reduce((count, table) => count + table.columns.length, 0), 312);
    database.preflight();
    assert.equal(database.rows('LinkedChildren').length, 2);
    assert.equal(database.rows('UserData').length, 2);
    assert.equal(database.rows('BaseItems')[0].RunTimeTicks, 9223372036854775000n);
    assert.equal(database.rows('BaseItems')[0].DateCreated, '2026-09-26 13:45:22.1234567');
    assert.deepEqual(database.rows('BaseItemImageInfos')[0].Blurhash, Buffer.from([0, 255, 1, 128]));
    assert.equal(database.rows('ActivityLogs')[0].RowVersion, 4294967295n);
  } finally { database.close(); }
});

test('unknown schema, unsafe values, missing keys and optimistic conflicts fail closed', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    assert.throws(() => database.update('Users', {}, { Username: 'x' }), /complete primary key/);
    assert.throws(() => database.update('Users', { Id: fixtureIds.Users }, { Username: 'x' }, { rowVersion: 1n }), /Concurrency conflict/);
    database.update('Users', { Id: fixtureIds.Users }, { Username: 'updated' }, { rowVersion: 4294967295n });
    assert.equal(database.rows('Users')[0].RowVersion, 0n);
    assert.throws(() => database.update('BaseItems', { Id: fixtureIds.BaseItems }, { RunTimeTicks: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
    assert.throws(() => database.update('BaseItems', { Id: fixtureIds.BaseItems }, { DateCreated: new Date() }), /well-formed string/);
    assert.throws(() => database.update('BaseItems', { Id: fixtureIds.BaseItems }, {}), /at least one changed value/);
    database.database.exec('CREATE TABLE Surprise (Id INTEGER)');
    assert.throws(() => database.preflight(), /Unknown table Surprise/);
  } finally { database.close(); }
});

test('SQLite batch exchange retains all native fields, raw TEXT bytes, explicit identities and insertion order', () => {
  const source = new SqliteDatabase(':memory:', { create: true }), target = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(source);
    source.update('BaseItems', { Id: fixtureIds.BaseItems }, { Data: new NativeTextCell(Buffer.from([0, 255, 1, 97, 0])) });
    target.transaction(() => {
      target.database.exec('PRAGMA defer_foreign_keys = ON');
      for (const table of nativeModel.tables) {
        const rows = source.rows(table.name, { consumer: 'exchange' });
        assert.equal(target.insertBatch(table.name, rows), BigInt(rows.length));
      }
    });
    for (const table of nativeModel.tables) {
      const values = database => database.rows(table.name, { consumer: 'exchange' })
        .map(row => table.columns.map(column => canonicalCell(row[column.name])));
      assert.deepEqual(values(target), values(source), table.name);
    }
    const order = [{ Kind: 7, RowVersion: 0n, UserId: fixtureIds.Users, Value: 0 },
      { Value: 1, UserId: fixtureIds.Users, RowVersion: 0n, Kind: 8 }];
    const before = target.database.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('Permissions').seq;
    assert.equal(target.insertBatch('Permissions', order), 2n);
    const generated = target.database.prepare('SELECT Id, Kind, Value FROM Permissions WHERE Id > ? ORDER BY rowid').all(before);
    assert.deepEqual(generated.map(row => [row.Kind, row.Value]), [[7, 0], [8, 1]]);
    assert.equal(target.insertBatch('Permissions', []), 0n);
    assert.throws(() => target.insertBatch('Permissions', [order[0], { ...order[1], Unexpected: true }]), /consistent Permissions row shape/u);
    assert.throws(() => target.insertBatch('Permissions', [{ ...order[0], Value: undefined }]), /cannot be undefined/u);
    assert.equal(target.database.prepare('SELECT count(*) AS count FROM Permissions WHERE Kind=7').get().count, 1);
    assert.equal(target.database.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('Permissions').seq, before + 2);
  } finally { source.close(); target.close(); }
});

test('upsert supports native tables whose entire shape is the composite primary key', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    const [value] = database.rows('ItemValuesMap');
    database.delete('ItemValuesMap', value);
    assert.deepEqual(database.upsert('ItemValuesMap', value), value);
    assert.deepEqual(database.upsert('ItemValuesMap', value), value);
    assert.deepEqual(database.rows('ItemValuesMap'), [value]);
  } finally { database.close(); }
});

test('native TEXT preflight still rejects a BLOB storage class instead of coercing it', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    database.database.prepare('UPDATE "UserData" SET "CustomDataKey" = ? WHERE "CustomDataKey" = ?')
      .run(Buffer.from([0xff, 0, 1]), '');
    assert.throws(() => database.preflight(), /UserData\.CustomDataKey: unexpected native TEXT storage class/u);
  } finally { database.close(); }
});

test('upsert replaces omitted nullable columns when an existing native item changes type', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    const before = database.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } })[0];
    assert.notEqual(before.RunTimeTicks, null);
    const studio = {
      Id: fixtureIds.BaseItems,
      Type: 'MediaBrowser.Controller.Entities.Studio',
      Name: 'Replacement Studio',
      IsFolder: false, IsInMixedFolder: false, IsLocked: false,
      IsMovie: false, IsRepeat: false, IsSeries: false, IsVirtualItem: false,
    };
    const replaced = database.upsert('BaseItems', studio);
    assert.equal(replaced.Name, 'Replacement Studio');
    assert.equal(replaced.RunTimeTicks, null);
    assert.equal(replaced.Data, null);
    assert.equal(database.rows('BaseItems').length, 1);
    assert.equal(database.upsert('BaseItems', { ...studio, Name: 'Second Name' }).Name, 'Second Name');
    assert.equal(database.rows('BaseItems').length, 1);
    assert.throws(() => database.upsert('BaseItems', { Name: 'Missing Id' }), /complete primary key/);
    assert.throws(() => database.upsert('BaseItems', { ...studio, Id: undefined }), /cannot be undefined/);
    assert.throws(() => database.upsert('BaseItems', { ...studio, Unknown: 1 }), /Unknown native column/);
  } finally { database.close(); }
});

test('SQLite snapshots include committed WAL and preserve source and sequence state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-sqlite-'));
  const source = new SqliteDatabase(path.join(directory, 'source.db'), { create: true });
  let snapshot;
  try {
    source.database.exec('PRAGMA journal_mode=WAL');
    seedAllTables(source);
    await source.snapshot(path.join(directory, 'snapshot.db'));
    snapshot = new SqliteDatabase(path.join(directory, 'snapshot.db'), { readOnly: true });
    assert.equal(snapshot.rows('Users').length, 1);
    assert.equal(snapshot.schema.sqliteSequence.find((entry) => entry.name === 'ActivityLogs').seq, 200n);
    assert.equal(source.rows('Users').length, 1);
    await assert.rejects(source.snapshot(path.join(directory, 'snapshot.db')), /already exists/);
  } finally { snapshot?.close(); source.close(); await rm(directory, { recursive: true }); }
});

test('PostgreSQL field conversion rejects values it cannot round trip', () => {
  const textColumn = nativeModel.tables.find((table) => table.name === 'BaseItems').columns.find((column) => column.name === 'Name');
  assert.deepEqual(encodeValue(textColumn, 'x\0y', 'postgres'), Buffer.from('x\0y'));
  assert.notDeepEqual(encodeValue(textColumn, 'x\u0001y', 'postgres'), Buffer.from('x\0y'));
  assert.throws(() => encodeValue(textColumn, '\ud800', 'postgres'), /well-formed string/);
});

test('transaction failure restores every row and rejects asynchronous callbacks', () => {
  const database = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(database);
    assert.throws(() => database.transaction(() => { database.update('Users', { Id: fixtureIds.Users }, { Username: 'changed' }); throw new Error('injected'); }), /injected/);
    assert.notEqual(database.rows('Users')[0].Username, 'changed');
    assert.throws(() => database.transaction(async () => {}), /must be synchronous/);
  } finally { database.close(); }
});
