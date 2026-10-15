import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { queryPostgresAlbumSelectorIds } from '../../src/library/postgres-library-query.js';

const id = value => `7b000000-0000-0000-0000-${String(value).padStart(12, '0')}`;

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

function album(Id, cleanName, sortName, extra = {}) {
  return {
    ...blank('BaseItems'),
    Id,
    Type: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
    Name: cleanName,
    CleanName: cleanName,
    SortName: sortName,
    IsFolder: true,
    MediaType: 'Unknown',
    UnratedType: 'Music',
    Data: '{}',
    ...extra,
  };
}

function folder(Id) {
  return {
    ...blank('BaseItems'),
    Id,
    Type: 'MediaBrowser.Controller.Entities.Folder',
    Name: Id,
    CleanName: Id,
    SortName: Id,
    IsFolder: true,
    MediaType: 'Unknown',
    UnratedType: 'Other',
    Data: '{}',
  };
}

test('real PostgreSQL resolves Albums tokens in order without returning duplicate candidate sets', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `album_selector_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let database;
  t.after(async () => {
    try { await database?.close(); } catch { /* Raw cleanup remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try {
      const quote = value => `"${value.replaceAll('"', '""')}"`;
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quote(schema)}, ${quote(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end(); }
  });

  database = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });
  const fast = id(1);
  const slow = id(2);
  const globalFirst = id(3);
  const emptyName = id(4);
  const hiddenOwner = id(5);
  const ownedExtra = id(6);
  const primary = id(7);
  const sameTopAlternate = id(8);
  const crossTopAlternate = id(9);
  const topA = id(901);
  const topB = id(902);
  const owner = id(903);
  const emptyId = '00000000-0000-0000-0000-000000000000';

  await database.insert('BaseItems', folder(emptyId));
  await database.insert('BaseItems', folder(topA));
  await database.insert('BaseItems', folder(topB));
  await database.insert('BaseItems', folder(owner));
  await database.insert('BaseItems', album(globalFirst, 'global', '00-global'));
  await database.insert('BaseItems', album(emptyName, '', 'b-empty'));
  await database.insert('BaseItems', album(slow, 'duplicate', 'z-slow'));
  await database.insert('BaseItems', album(fast, 'duplicate', 'a-fast'));
  await database.insert('BaseItems', album(hiddenOwner, 'owned', '-hidden', { OwnerId: owner }));
  await database.insert('BaseItems', album(id(10), 'zero owned', '-zero-hidden', { OwnerId: emptyId }));
  await database.insert('BaseItems', album(ownedExtra, 'extra', 'a-extra', {
    OwnerId: owner,
    ExtraType: 1,
  }));
  await database.insert('BaseItems', album(primary, 'primary', 'a-primary', { TopParentId: topA }));
  await database.insert('BaseItems', album(sameTopAlternate, 'alternate', 'a-alternate', {
    TopParentId: topA,
    PrimaryVersionId: primary,
  }));
  await database.insert('BaseItems', album(crossTopAlternate, 'cross', 'a-cross', {
    TopParentId: topB,
    PrimaryVersionId: primary,
  }));

  // A large duplicate set must not become a large JavaScript candidate list:
  // the lateral subquery emits at most one row for each requested token.
  for (let index = 0; index < 256; index++) {
    await database.insert('BaseItems', album(id(1000 + index), 'duplicate', `zz-${String(index).padStart(4, '0')}`));
  }

  const selected = await queryPostgresAlbumSelectorIds(database,
    ['Duplicate', 'Duplicate', '', '\ufeff', 'Owned', 'Zero Owned', 'Extra', 'Alternate', 'Cross', 'Missing']);
  assert.deepEqual(selected, [fast, fast, globalFirst, emptyName, ownedExtra, crossTopAlternate]);
  assert.equal(selected.length, 6);
});
