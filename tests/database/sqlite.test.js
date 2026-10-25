import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel } from '../../src/database/model.js';
import { seedAllTables, fixtureIds } from './fixtures.js';
import { encodeValue } from '../../src/database/values.js';

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
