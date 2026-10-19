import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { tableDefinition } from '../../src/database/model.js';
import { loadPostgresMetadataRows, loadPostgresNavigationRows,
  loadPostgresPageGraph, loadPostgresItemGraph } from '../../src/library/postgres-library-query.js';

const postgresOptions = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const key = value => value.toLowerCase().replaceAll('-', '');

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-09 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
  }));
}

function item(Id, type, fields = {}) {
  return {
    ...blank('BaseItems'),
    Id,
    Type: `MediaBrowser.Controller.Entities.${type}`,
    Name: type,
    CleanName: type.toLowerCase(),
    SortName: type.toLowerCase(),
    IsFolder: type !== 'Movie',
    MediaType: type === 'Movie' ? 'Video' : 'Unknown',
    UnratedType: 'Other',
    Data: '{}',
    ...fields,
  };
}

test('single-item loaders exclude unrelated user views and collection members', postgresOptions, async t => {
  const database = await createPostgresTestDatabase(t, 'unrelated_graph');
  const target = item(randomUUID(), 'Movie');
  const unrelatedCollection = item(randomUUID(), 'CollectionFolder');
  const foreignViews = Array.from({ length: 100 }, () => item(randomUUID(), 'UserView'));
  const foreignMovies = Array.from({ length: 100 }, () => item(randomUUID(), 'Movie'));
  const owned = item(randomUUID(), 'Movies.Movie', { OwnerId: target.Id, ExtraType: 2 });
  const nestedOwned = item(randomUUID(), 'Movies.Movie', { OwnerId: owned.Id, ExtraType: 2 });
  await database.insertBatch('BaseItems', [target, unrelatedCollection, owned, nestedOwned,
    ...foreignViews, ...foreignMovies]);
  await database.insertBatch('LinkedChildren', foreignMovies.map((row, SortOrder) => ({
    ParentId: unrelatedCollection.Id, ChildId: row.Id, SortOrder, ChildType: SortOrder % 4,
  })));
  const unrelatedIds = new Set([...foreignViews, ...foreignMovies].map(row => key(row.Id)));
  const check = async mode => {
    const currentTarget = (await database.rows('BaseItems', { where: { Id: target.Id } }))[0];
    const rows = mode === 'page'
      ? await loadPostgresPageGraph(database, [currentTarget], await loadPostgresNavigationRows(database))
      : mode === 'item' ? await loadPostgresItemGraph(database, [target.Id])
        : await loadPostgresMetadataRows(database, target.Id);
    assert.ok(rows.some(row => key(row.Id) === key(target.Id)));
    if (mode === 'metadata') {
      for (const extra of [owned, nestedOwned]) assert.ok(rows.some(row => key(row.Id) === key(extra.Id)));
    }
    assert.deepEqual(rows.filter(row => unrelatedIds.has(key(row.Id))).map(row => row.Id), [],
      'a one-item request must not hydrate unrelated views or follow unrelated collection links');
  };
  for (const mode of ['page', 'item', 'metadata']) await t.test(mode, () => check(mode));
  await database.update('BaseItems', { Id: target.Id }, { ParentId: unrelatedCollection.Id });
  await database.update('BaseItems', { Id: foreignMovies[0].Id }, { OwnerId: unrelatedCollection.Id });
  for (const mode of ['page', 'item', 'metadata']) await t.test(`ancestor context: ${mode}`, () => check(mode));
});

test('real PostgreSQL navigation resolves native-equivalent physical paths without broad folder reads',
  postgresOptions, async t => {
    const database = await createPostgresTestDatabase(t, 'navigation_paths', { max: 2 });
    const ids = Object.fromEntries(['userRoot', 'windowsCollection', 'posixCollection', 'windowsOne',
      'windowsTwo', 'unc', 'posix', 'posixCaseConflict', 'matchingMovie', 'foreign']
      .map(name => [name, randomUUID().toUpperCase()]));

    await database.insert('BaseItems', item(ids.userRoot, 'UserRootFolder'));
    await database.insert('BaseItems', item(ids.windowsCollection, 'CollectionFolder', {
      ParentId: ids.userRoot,
      Data: JSON.stringify({
        PhysicalFolderIds: [],
        PhysicalLocationsList: [
          'q:\\MÉDIA\\ÄCase\\Library\\Movie',
          '\\\\Server\\Share\\Äudio\\Series',
        ],
      }),
    }));
    await database.insert('BaseItems', item(ids.posixCollection, 'CollectionFolder', {
      ParentId: ids.userRoot,
      Data: JSON.stringify({
        PhysicalFolderIds: [],
        PhysicalLocationsList: ['/srv/Ärea/媒体/Library/Show'],
      }),
    }));

    await database.insert('BaseItems', item(ids.windowsOne, 'Folder', {
      Path: 'Q:/méDIA//äcASE/draft/.././library///Movie\\\\',
      TopParentId: ids.windowsOne,
    }));
    await database.insert('BaseItems', item(ids.windowsTwo, 'Folder', {
      Path: 'q:\\média\\ÄCASE\\library\\movie',
      TopParentId: ids.windowsTwo,
    }));
    await database.insert('BaseItems', item(ids.unc, 'Folder', {
      Path: '//server/share///äUDIO/./draft/../Series\\',
      TopParentId: ids.unc,
    }));
    await database.insert('BaseItems', item(ids.posix, 'Folder', {
      Path: '/srv//Ärea/媒体/Library/draft/.././Show///',
      TopParentId: ids.posix,
    }));
    await database.insert('BaseItems', item(ids.posixCaseConflict, 'Folder', {
      Path: '/srv//ärea/媒体/Library/draft/.././Show///',
      TopParentId: ids.posixCaseConflict,
    }));
    await database.insert('BaseItems', item(ids.matchingMovie, 'Movie', {
      Path: 'Q:\\MÉDIA\\ÄCase\\Library\\Movie',
      TopParentId: ids.matchingMovie,
    }));
    await database.insert('BaseItems', item(ids.foreign, 'Folder', {
      Path: '/srv/Ärea/媒体/Library/Other',
      TopParentId: ids.foreign,
    }));

    const navigation = await loadPostgresNavigationRows(database);
    const actual = new Set(navigation.map(row => key(row.Id)));
    for (const name of ['userRoot', 'windowsCollection', 'posixCollection', 'windowsOne',
      'windowsTwo', 'unc', 'posix']) {
      assert.equal(actual.has(key(ids[name])), true, `${name} is present`);
    }
    for (const name of ['posixCaseConflict', 'matchingMovie', 'foreign']) {
      assert.equal(actual.has(key(ids[name])), false, `${name} is excluded`);
    }
    assert.equal(actual.size, 7, 'only navigation entities and native-equivalent Folder rows are hydrated');
  });

test('real PostgreSQL relationship loaders reach a fixed point beyond legacy depth caps',
  postgresOptions, async t => {
    const database = await createPostgresTestDatabase(t, 'relation_depth', { max: 2 });

    const navigationIds = Array.from({ length: 12 }, () => randomUUID().toUpperCase());
    for (let index = navigationIds.length - 1; index >= 0; index -= 1) {
      const id = navigationIds[index];
      await database.insert('BaseItems', item(id, index === 0 ? 'UserRootFolder' : 'Folder', {
        ParentId: navigationIds[index + 1] ?? null,
        IsFolder: true,
        MediaType: 'Unknown',
      }));
    }
    const navigation = await loadPostgresNavigationRows(database);
    const navigationKeys = new Set(navigation.map(row => key(row.Id)));
    assert.deepEqual([...navigationKeys].filter(id => navigationIds.some(candidate => key(candidate) === id)).sort(),
      navigationIds.map(key).sort(),
      'navigation follows every persisted parent until no unseen reference remains');

    const pageIds = Array.from({ length: 12 }, () => randomUUID().toUpperCase());
    for (let index = pageIds.length - 1; index >= 0; index -= 1) {
      const id = pageIds[index];
      await database.insert('BaseItems', item(id, 'Folder', {
        ParentId: pageIds[index + 1] ?? null,
      }));
    }
    const [pageLeaf] = await database.rows('BaseItems', { where: { Id: pageIds[0] } });
    const originalQuery = database.client.query.bind(database.client);
    let pageGraphQueries = 0;
    let sawRelationshipGraph = false;
    database.client.query = async (...args) => {
      pageGraphQueries += 1;
      const request = args[0];
      const text = typeof request === 'string' ? request : request?.text ?? '';
      if (text.includes('/* page-relationship-graph */')) sawRelationshipGraph = true;
      return originalQuery(...args);
    };
    let pageGraph;
    try { pageGraph = await loadPostgresPageGraph(database, [pageLeaf]); }
    finally { database.client.query = originalQuery; }
    const pageKeys = new Set(pageGraph.map(row => key(row.Id)));
    assert.ok(pageIds.every(id => pageKeys.has(key(id))),
      'page graph follows every referenced parent until convergence');
    assert.equal(sawRelationshipGraph, true);
    assert.ok(pageGraphQueries <= 4,
      `page graph depth must not drive round trips; observed ${pageGraphQueries}`);

    const ownedIds = Array.from({ length: 6 }, () => randomUUID().toUpperCase());
    for (const [index, id] of ownedIds.entries()) {
      await database.insert('BaseItems', item(id, 'Movies.Movie', {
        OwnerId: index === 0 ? null : ownedIds[index - 1],
        ExtraType: index === 0 ? null : 2,
      }));
    }
    const metadata = await loadPostgresMetadataRows(database, ownedIds[0], { targetType: 'Movie' });
    const metadataKeys = new Set(metadata.map(row => key(row.Id)));
    assert.ok(ownedIds.every(id => metadataKeys.has(key(id))),
      'metadata graph follows every owned-extra generation until convergence');
  });

test('real PostgreSQL page graphs follow N-format PrimaryVersionId from a D-format primary',
  postgresOptions, async t => {
    const database = await createPostgresTestDatabase(t, 'relation_ids', { max: 2 });
    const ids = Object.fromEntries(['primary', 'alternate']
      .map(name => [name, randomUUID().toUpperCase()]));
    await database.insert('BaseItems', item(ids.primary, 'Movies.Movie'));
    await database.insert('BaseItems', item(ids.alternate, 'Movies.Movie', {
      PrimaryVersionId: key(ids.primary),
    }));
    const [primary] = await database.rows('BaseItems', { where: { Id: ids.primary } });
    const graph = await loadPostgresPageGraph(database, [primary]);
    assert.deepEqual(new Set(graph.map(row => key(row.Id))), new Set(Object.values(ids).map(key)),
      'the alternate is hydrated through the idKey-equivalent version reference');
  });
