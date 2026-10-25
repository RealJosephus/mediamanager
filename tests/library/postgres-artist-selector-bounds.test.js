import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { queryPostgresArtistSelectorId,
  queryPostgresArtistSelectorIds,
  queryPostgresIdentitySelectorIds } from '../../src/library/postgres-library-query.js';

const id = value => `7d000000-0000-0000-0000-${String(value).padStart(12, '0')}`;

const blank = Object.fromEntries(tableDefinition('BaseItems').columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

function row(Id, type, name, sortName, extra = {}) {
  return {
    ...blank,
    Id,
    Type: `MediaBrowser.Controller.Entities.${type === 'MusicArtist' ? 'Audio.MusicArtist' : 'Folder'}`,
    Name: name,
    CleanName: name.toLowerCase(),
    SortName: sortName,
    IsFolder: type !== 'MusicArtist',
    MediaType: 'Unknown',
    UnratedType: type === 'MusicArtist' ? 'Music' : 'Other',
    Data: '{}',
    ...extra,
  };
}

test('real PostgreSQL Artists selector preserves physical, owner and alternate eligibility with one-row output', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `artist_selector_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  const parent = id(900);
  const owner = id(901);
  const topA = id(902);
  const topB = id(903);
  for (const support of [parent, owner, topA, topB]) {
    await database.insert('BaseItems', row(support, 'Folder', support, support));
  }

  const firstPhysical = id(1);
  const alphaPhysical = id(2);
  const visibleOwnedName = id(3);
  const primary = id(4);
  const visibleAlternateName = id(5);
  const crossTopAlternate = id(6);
  const exactFast = id(7);
  const unicodeInvariant = id(8);
  await database.insert('BaseItems', row(firstPhysical, 'MusicArtist', 'First physical', '00-first', {
    ParentId: parent,
  }));
  await database.insert('BaseItems', row(id(20), 'MusicArtist', 'Alpha', '-virtual', {}));
  await database.insert('BaseItems', row(alphaPhysical, 'MusicArtist', 'Alpha', 'z-physical', {
    ParentId: parent,
  }));
  await database.insert('BaseItems', row(id(21), 'MusicArtist', 'Owned name', 'a-hidden', {
    ParentId: parent,
    OwnerId: owner,
  }));
  await database.insert('BaseItems', row(visibleOwnedName, 'MusicArtist', 'Owned name', 'b-visible', {
    ParentId: parent,
  }));
  await database.insert('BaseItems', row(primary, 'MusicArtist', 'Primary', 'a-primary', {
    ParentId: parent,
    TopParentId: topA,
  }));
  await database.insert('BaseItems', row(id(22), 'MusicArtist', 'Alternate name', 'a-hidden', {
    ParentId: parent,
    TopParentId: topA,
    PrimaryVersionId: primary,
  }));
  await database.insert('BaseItems', row(visibleAlternateName, 'MusicArtist', 'Alternate name', 'b-visible', {
    ParentId: parent,
    TopParentId: topA,
  }));
  await database.insert('BaseItems', row(crossTopAlternate, 'MusicArtist', 'Cross top', 'a-cross', {
    ParentId: parent,
    TopParentId: topB,
    PrimaryVersionId: primary,
  }));
  await database.insert('BaseItems', row(exactFast, 'MusicArtist', 'Exact', 'a-fast', {
    ParentId: parent,
  }));
  await database.insert('BaseItems', row(unicodeInvariant, 'MusicArtist', '\u1e9eMITH', 'unicode', {
    ParentId: parent,
  }));
  for (let index = 0; index < 128; index++) {
    await database.insert('BaseItems', row(id(1000 + index), 'MusicArtist', 'Exact',
      `zz-${String(index).padStart(4, '0')}`, { ParentId: parent }));
  }

  assert.equal(await queryPostgresArtistSelectorId(database, ''), firstPhysical);
  assert.equal(await queryPostgresArtistSelectorId(database, 'ALPHA'), alphaPhysical);
  assert.equal(await queryPostgresArtistSelectorId(database, 'Owned name'), visibleOwnedName);
  assert.equal(await queryPostgresArtistSelectorId(database, 'Alternate name'), visibleAlternateName);
  assert.equal(await queryPostgresArtistSelectorId(database, 'Cross top'), crossTopAlternate);
  assert.equal(await queryPostgresArtistSelectorId(database, 'Exact'), exactFast);
  assert.equal(await queryPostgresArtistSelectorId(database, '\u00dfmith'), unicodeInvariant);
  assert.equal(await queryPostgresArtistSelectorId(database, 'Missing'), undefined);
  assert.deepEqual(await queryPostgresArtistSelectorIds(database,
    ['ALPHA', 'Missing', '\u00dfmith', '']), [alphaPhysical, null, unicodeInvariant, firstPhysical]);
  assert.deepEqual(await queryPostgresIdentitySelectorIds(database,
    [firstPhysical, id(999999), alphaPhysical, firstPhysical]),
  [firstPhysical, null, alphaPhysical, firstPhysical]);
});
