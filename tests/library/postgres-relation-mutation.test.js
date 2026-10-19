const decodeBindings = value => Buffer.isBuffer(value) ? value.toString('utf8') : Array.isArray(value) ? value.map(decodeBindings) : value;
import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { persistItemProviderIds, persistItemRelations } from '../../src/library/item-relations.js';
import { persistVideoVersionRelations } from '../../src/library/video-version-relations.js';

const itemId = '91000000-0000-0000-0000-000000000001';
const parentId = '91000000-0000-0000-0000-000000000002';
const localId = '91000000-0000-0000-0000-000000000003';
const remoteId = '91000000-0000-0000-0000-000000000004';
const orphanId = '91000000-0000-0000-0000-000000000005';

test('PostgreSQL provider, ancestor and value replacement stays in set-shaped SQL', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'relation_fixture',
    client: { async query(text, values) {
      calls.push({ text, values });
      if (/FROM desired\s+ORDER BY/u.test(text)) return { rows: [{ ParentItemId: nativeTextBytes(parentId) }] };
      return { rows: [], rowCount: 0 };
    } },
    async rows() { throw new Error('PostgreSQL relation persistence must not materialize relation tables.'); },
    async insert() { throw new Error('PostgreSQL relation persistence must not insert one row at a time.'); },
    async delete() { throw new Error('PostgreSQL relation persistence must not delete one row at a time.'); },
  };
  const item = {
    Id: itemId,
    Type: 'Movie',
    ProviderIds: { Imdb: 'tt-1', Tmdb: '2' },
    Genres: ['Drama', 'Drama'],
    Studios: [],
    Tags: ['Owned'],
  };

  await persistItemProviderIds(database, item);
  const result = await persistItemRelations(database, item, {
    parents: [{ Id: parentId, Tags: ['Inherited', 'inherited'] }],
  });

  assert.deepEqual(result.ancestorIds, [parentId]);
  assert.equal(calls.length, 3);
  assert.match(calls[0].text, /unnest\(\$2::bytea\[\], \$3::bytea\[\]\)[\s\S]*ON CONFLICT[\s\S]*NOT EXISTS/u);
  assert.deepEqual(decodeBindings(calls[0].values), [itemId, ['Imdb', 'Tmdb'], ['tt-1', '2']]);
  assert.match(calls[1].text, /JOIN .*"BaseItems"[\s\S]*ON CONFLICT[\s\S]*DELETE FROM .*"AncestorIds"/u);
  assert.deepEqual(decodeBindings(calls[1].values), [itemId, [parentId]]);
  assert.match(calls[2].text, /INSERT INTO .*"ItemValues"[\s\S]*ON CONFLICT \("Type", "Value"\)[\s\S]*INSERT INTO .*"ItemValuesMap"[\s\S]*DELETE FROM .*"ItemValuesMap"/u);
  assert.deepEqual(decodeBindings(calls[2].values[1]), [2, 4, 6, 6]);
  assert.deepEqual(decodeBindings(calls[2].values[2]), ['Drama', 'Owned', 'Owned', 'Inherited']);
});

test('PostgreSQL video-version replacement batches link insert, demotion and orphan deletion', async () => {
  const calls = [];
  const local = { Id: localId, Path: '/local.mkv', PrimaryVersionId: null };
  const remote = { Id: remoteId, Path: '/remote.mkv', PrimaryVersionId: null };
  const database = {
    dialect: 'postgres',
    async rows(name, options) {
      calls.push(['rows', name, options]);
      if (name === 'BaseItems' && options.whereIn?.Path) return [local];
      if (name === 'BaseItems' && options.whereIn?.Id && !options.where?.OwnerId) return [local, remote];
      if (name === 'LinkedChildren') return [
        { ParentId: itemId, SortOrder: 0, ChildId: orphanId, ChildType: 2 },
        { ParentId: itemId, SortOrder: 9, ChildId: remoteId, ChildType: 0 },
      ];
      if (name === 'BaseItems' && options.where?.OwnerId) return [{ Id: orphanId }];
      throw new Error(`unexpected rows(${name})`);
    },
    async deleteWhere(name, where, options) { calls.push(['deleteWhere', name, where, options]); },
    async insertBatch(name, rows) { calls.push(['insertBatch', name, rows]); },
    async updateWhere(name, where, values, options) { calls.push(['updateWhere', name, where, values, options]); },
    async insert() { throw new Error('PostgreSQL video relations must not insert one row at a time.'); },
    async update() { throw new Error('PostgreSQL video relations must not update one row at a time.'); },
    async delete() { throw new Error('PostgreSQL video relations must not delete one row at a time.'); },
  };
  const links = await persistVideoVersionRelations(database, {
    Id: itemId,
    Name: 'Root',
    Type: 'Movie',
    PrimaryVersionId: null,
    LocalAlternateVersions: ['/local.mkv'],
    LinkedAlternateVersions: [{ ItemId: localId }, { ItemId: remoteId }],
  });

  assert.deepEqual(links.map(row => [row.ChildId, row.ChildType, row.SortOrder]), [
    [localId, 2, 0],
    [remoteId, 3, 1],
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'deleteWhere'), [
    ['deleteWhere', 'LinkedChildren', { ParentId: itemId }, { whereIn: { ChildType: [2, 3] } }],
    ['deleteWhere', 'BaseItems', { OwnerId: itemId }, { whereIn: { Id: [orphanId] } }],
  ]);
  assert.deepEqual(calls.find(call => call[0] === 'insertBatch').slice(1), ['LinkedChildren', links]);
  assert.deepEqual(calls.find(call => call[0] === 'updateWhere').slice(1), [
    'BaseItems', {}, { PrimaryVersionId: itemId, PresentationUniqueKey: itemId.replaceAll('-', '') },
    { whereIn: { Id: [localId, remoteId] } },
  ]);
});
