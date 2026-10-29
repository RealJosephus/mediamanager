import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { fixtureRow } from '../database/fixtures.js';
import { loadPostgresMetadataRows, loadPostgresNavigationRows,
  loadPostgresPageGraph, loadPostgresItemGraph, loadPostgresRowsByIds } from '../../src/library/postgres-library-query.js';
import { withPostgresNativeQueryJitOff } from '../../src/database/postgres-native-query-jit.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';

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

test('real PostgreSQL identifier hydration retains complete stored rows and raw identity ordering',
  postgresOptions, async t => {
    const database = await createPostgresTestDatabase(t, 'identifier_rows');
    const table = tableDefinition('BaseItems');
    const dashed = 'A7B8C9D0-E1F2-4A5B-8C6D-00AABBCCDDEE';
    const spellings = [dashed, dashed.replaceAll('-', ''), dashed.toLowerCase(), key(dashed)];
    const expected = spellings.map((Id, index) => ({
      ...fixtureRow(table), Id,
      Name: `\ufeff中文\0\u0001e\u0301😀 ${index}`,
      DateModified: `2026-10-28 00:01:02.123456${index}`,
      Data: index === 1 ? null : `{\r\n  "unknown-provider" : ["中文", "e\u0301", "😀"],\r\n  "large" : 9223372036854775807, "id" : "${Id}"\r\n}\r\n`,
      IsFolder: index % 2 === 1,
      RunTimeTicks: 9007199254740993n + BigInt(index),
      Size: index === 2 ? null : 9223372036854775000n - BigInt(index),
    }));
    await database.insertBatch('BaseItems', expected.toReversed());

    const empty = { ...fixtureRow(table), Id: '' };
    const hyphen = { ...fixtureRow(table), Id: '-', Data: 'opaque provider text\0\u0001中文' };
    await database.insertBatch('BaseItems', [empty, hyphen]);
    const invalidText = Buffer.from([0xc3, 0x28]);
    const setData = (id, bytes) => database.client.query({
      text: `UPDATE ${q(database.schemaName)}."BaseItems" SET "Data"=$1 WHERE "Id"=$2`,
      values: [bytes, nativeTextBytes(id)],
    });
    await setData('', invalidText);

    const actual = await loadPostgresRowsByIds(database, [spellings[2], spellings[1], spellings[3],
      spellings[0], spellings[2], null, '', '00000000-0000-0000-0000-000000000000']);
    assert.deepEqual(actual, expected,
      'All distinct stored N/D and upper/lowercase rows survive one normalized selector, in raw Id order.');
    assert.deepEqual(actual, await database.rows('BaseItems', { whereIn: { Id: spellings } }),
      'The complete typed rows match the raw adapter without JSON, date or Guid rewriting.');
    for (const row of actual) assert.deepEqual(Object.keys(row).sort(), table.columns.map(column => column.name).sort());
    assert.deepEqual(await loadPostgresRowsByIds(database, ['-']), [hyphen],
      'An empty normalized lookup filters the stored empty Id before its malformed Data is decoded.');
    assert.deepEqual(await loadPostgresRowsByIds(database,
      [null, '', '00000000000000000000000000000000', '00000000-0000-0000-0000-000000000000']), []);

    await setData(spellings[0], invalidText);
    let adapterFailure;
    await assert.rejects(() => database.rows('BaseItems', { where: { Id: spellings[0] } }), reason => {
      adapterFailure = reason;
      return true;
    });
    await assert.rejects(() => loadPostgresRowsByIds(database, [spellings[0]]), reason => {
      assert.equal(reason.code, adapterFailure.code);
      assert.equal(reason.message, adapterFailure.message);
      return true;
    }, 'Selected malformed TEXT retains the adapter decoder failure.');
  });

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

test('navigation includes every user-root child and only ordinary aggregate Folder children', postgresOptions, async t => {
  const database = await createPostgresTestDatabase(t, 'navigation_roots');
  const ids = Object.fromEntries(['userRoot', 'aggregate', 'collection', 'userMovie', 'userView',
    'physical', 'aggregateMovie', 'aggregateAlbum', 'unrelated'].map(name => [name, randomUUID().toUpperCase()]));
  ids.userRoot = key(ids.userRoot);
  await database.insertBatch('BaseItems', [
    item(ids.userRoot, 'UserRootFolder'), item(ids.aggregate, 'AggregateFolder'),
    item(ids.collection, 'CollectionFolder', { ParentId: ids.userRoot }),
    item(ids.userMovie, 'Movies.Movie', { ParentId: ids.userRoot, IsFolder: false, MediaType: 'Video' }),
    item(ids.userView, 'UserView', { ParentId: ids.userRoot }),
    item(ids.physical, 'Folder', { ParentId: ids.aggregate }),
    item(ids.aggregateMovie, 'Movies.Movie', { ParentId: ids.aggregate, IsFolder: false, MediaType: 'Video' }),
    item(ids.aggregateAlbum, 'PhotoAlbum', { ParentId: ids.aggregate }),
    item(ids.unrelated, 'Folder'),
  ]);
  const before = await database.rows('BaseItems');
  const expected = ['userRoot', 'aggregate', 'collection', 'userMovie', 'userView', 'physical'].map(name => key(ids[name])).sort();
  for (const deferBaseItemHydration of [false, true]) {
    const selected = await loadPostgresNavigationRows(database, undefined, { deferBaseItemHydration });
    assert.deepEqual(selected.map(row => key(row.Id)).sort(), expected,
      'overlapping type and child membership yields one row for roots persisted in N and D GUID formats');
    const explicit = await loadPostgresNavigationRows(database, key(ids.aggregateMovie), { deferBaseItemHydration });
    assert.deepEqual(explicit.map(row => key(row.Id)).sort(), [...expected, key(ids.aggregateMovie)].sort(),
      'an explicit target remains part of its navigation frame');
  }
  assert.deepEqual(await database.rows('BaseItems'), before, 'navigation reads preserve every persisted field');
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
    const [shallowLeaf] = await database.rows('BaseItems', { where: { Id: pageIds.at(-3) } });
    const originalQuery = database.client.query.bind(database.client);
    const queryCounts = { shallow: 0, deep: 0 };
    let phase = 'shallow';
    database.client.query = async (...args) => {
      queryCounts[phase] += 1;
      return originalQuery(...args);
    };
    let pageGraph, shallowGraph;
    try {
      shallowGraph = await loadPostgresPageGraph(database, [shallowLeaf]);
      phase = 'deep';
      pageGraph = await loadPostgresPageGraph(database, [pageLeaf]);
    }
    finally { database.client.query = originalQuery; }
    assert.deepEqual(new Set(shallowGraph.map(row => key(row.Id))), new Set(pageIds.slice(-3).map(key)));
    const pageKeys = new Set(pageGraph.map(row => key(row.Id)));
    assert.ok(pageIds.every(id => pageKeys.has(key(id))),
      'page graph follows every referenced parent until convergence');
    assert.ok(queryCounts.deep <= queryCounts.shallow * 2,
      `four times the graph depth must not cause proportional round trips: ${JSON.stringify(queryCounts)}`);

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

test('real PostgreSQL page references preserve their reachable frame as unrelated items grow',
  postgresOptions, async t => {
    const database = await createPostgresTestDatabase(t, 'page_references');
    const ids = Object.fromEntries(['parent', 'ancestor', 'top', 'season', 'series', 'owner',
      'primary', 'channel', 'channelRoot', 'explicitAncestor', 'alternate', 'automatic', 'manual', 'owned']
      .map(name => [name, randomUUID().toUpperCase()]));
    const context = [
      item(ids.parent, 'Folder', { ParentId: ids.ancestor }),
      item(ids.ancestor, 'Folder', { ParentId: ids.parent }),
      item(ids.top, 'Folder'), item(ids.season, 'TV.Season'), item(ids.series, 'TV.Series'),
      item(ids.owner, 'Movies.Movie'), item(ids.primary, 'Movies.Movie'),
      item(ids.channel, 'Channel', { ChannelId: ids.channelRoot }),
      item(ids.channelRoot, 'Channel'), item(ids.explicitAncestor, 'Folder'),
    ];
    const selected = Array.from({ length: 128 }, (_, index) => item(randomUUID().toUpperCase(), 'Movies.Movie',
      index === 127 ? {} : { ParentId: ids.parent, TopParentId: ids.top, SeasonId: ids.season,
        SeriesId: ids.series, OwnerId: ids.owner, PrimaryVersionId: ids.primary, ChannelId: ids.channel }));
    const related = [
      item(ids.alternate, 'Movies.Movie', { PrimaryVersionId: key(ids.primary) }),
      item(ids.automatic, 'Movies.Movie', { PrimaryVersionId: selected[0].Id }),
      item(ids.manual, 'Movies.Movie'), item(ids.owned, 'Movies.Movie', { OwnerId: selected[0].Id }),
    ];
    const insertPages = async (table, rows) => {
      for (let offset = 0; offset < rows.length; offset += 128) await database.insertBatch(table, rows.slice(offset, offset + 128));
    };
    await insertPages('BaseItems', context);
    await insertPages('BaseItems', selected);
    await insertPages('BaseItems', related);
    await database.insert('AncestorIds', { ...blank('AncestorIds'), ItemId: selected[0].Id, ParentItemId: ids.explicitAncestor });
    await database.insertBatch('LinkedChildren', [
      { ParentId: selected[0].Id, ChildId: ids.automatic, ChildType: 2, SortOrder: 0 },
      { ParentId: selected[0].Id, ChildId: ids.manual, ChildType: 0, SortOrder: 1 },
    ]);
    const unrelated = Array.from({ length: 2048 }, () => item(randomUUID(), 'Movies.Movie', {
      ParentId: ids.parent, OwnerId: ids.parent,
    }));
    const report = { scope: 'Actual PostgreSQL page references, context cycles, version/link/owned expansion and unrelated-data growth.',
      planDiagnosticsOnly: true, observations: [] };
    const expectedBase = [...selected.map(row => row.Id), ...Object.entries(ids)
      .filter(([name]) => !['channelRoot', 'manual', 'owned'].includes(name)).map(([, value]) => value)].map(key).sort();
    const observe = async (unrelatedItems, expand) => {
      await database.withConnection(async session => {
        const page = await loadPostgresRowsByIds(session, selected.map(row => row.Id));
        const query = session.client.query;
        let graphQuery;
        session.client.query = async (...args) => {
          const request = args[0];
          if (request?.text?.startsWith('/* page-relationship-graph */')) graphQuery = request;
          return query(...args);
        };
        let rows;
        const started = performance.now();
        try { rows = await loadPostgresPageGraph(session, page, [], { includeManualLinks: expand, includeOwnedItems: expand }); }
        finally { session.client.query = query; }
        const elapsedMs = performance.now() - started;
        const actual = rows.map(row => key(row.Id)).sort();
        const expected = expand ? [...expectedBase, key(ids.manual), key(ids.owned)].sort() : expectedBase;
        assert.deepEqual(actual, expected,
          'Only selected/version/link/owned members expand; parent and channel context cannot introduce unrelated members.');
        let plan;
        if (graphQuery) {
          plan = await withPostgresNativeQueryJitOff(session, async current => {
            const result = await current.client.query({ text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + graphQuery.text,
              values: graphQuery.values });
            return result.rows[0]['QUERY PLAN'][0];
          });
        }
        let baseItemRowsVisited = 0;
        const visit = node => {
          if (node['Relation Name'] === 'BaseItems') baseItemRowsVisited += ((node['Actual Rows'] ?? 0)
            + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0);
          for (const child of node.Plans ?? []) visit(child);
        };
        if (plan) visit(plan.Plan);
        report.observations.push({ unrelatedItems, includeManualLinks: expand, includeOwnedItems: expand,
          actual, elapsedMs, query: graphQuery, baseItemRowsVisited, plan });
      });
    };
    try {
      await insertPages('BaseItems', unrelated.slice(0, 64));
      await database.insert('LinkedChildren', { ParentId: ids.parent, ChildId: unrelated[0].Id, ChildType: 2, SortOrder: 0 });
      await observe(64, false); await observe(64, true);
      await insertPages('BaseItems', unrelated.slice(64));
      await observe(2048, false); await observe(2048, true);
    } finally {
      const output = path.join(validationOutputRoot(), 'postgres-page-reference-work'); assertValidationOutputChild(output);
      await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
  });
