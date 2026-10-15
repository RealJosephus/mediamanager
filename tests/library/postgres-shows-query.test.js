import { nativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import {
  postgresUpcomingScope,
  queryPostgresSeriesSeasonPage,
  queryPostgresUpcomingEpisodePage,
} from '../../src/library/postgres-shows-query.js';

const ids = Object.freeze({
  view: '11000000-0000-0000-0000-000000000001',
  collection: '11000000-0000-0000-0000-000000000002',
  physical: '11000000-0000-0000-0000-000000000003',
  series: '11000000-0000-0000-0000-000000000004',
  missing: '11000000-0000-0000-0000-000000000005',
  season: '11000000-0000-0000-0000-000000000006',
});

test('PostgreSQL Upcoming translates repository parent scopes without catalogue rows', () => {
  const collection = { Id: ids.collection, Type: 'CollectionFolder', CollectionType: 'tvshows' };
  const view = { Id: ids.view, Type: 'UserView', ViewType: 'tvshows', DisplayParentId: ids.collection };
  const series = { Id: ids.series, Type: 'Series', TopParentId: ids.physical };
  const state = { byId: new Map([[ids.collection.replaceAll('-', ''), collection]]) };
  const physicalIdsFor = folder => folder === collection ? [ids.physical] : [];

  assert.deepEqual(postgresUpcomingScope({ parentId: undefined, state }), {});
  assert.deepEqual(postgresUpcomingScope({ parentId: ids.missing, parent: null, state }),
    { parentId: ids.missing });
  assert.deepEqual(postgresUpcomingScope({ parentId: ids.series, parent: series, state }),
    { ancestorId: ids.series });
  assert.deepEqual(postgresUpcomingScope({
    parentId: ids.view, parent: view, state, physicalIdsFor,
  }), { topParentIds: [ids.physical] });
});

test('PostgreSQL Upcoming query groups, orders and pages before a bounded row hydration', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres', schemaName: 'shows_shape',
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [{ Id: nativeTextBytes(ids.season), TotalRecordCount: '7' }] };
    } },
    rows: async (name, options) => {
      assert.equal(name, 'BaseItems');
      assert.deepEqual(options, { whereIn: { Id: [ids.season] } });
      return [{ Id: ids.season }];
    },
  };
  const page = await queryPostgresUpcomingEpisodePage(database, {
    scope: { ancestorId: ids.series }, userId: ids.view,
    minimumPremiereDate: '2026-10-07 00:00:00', startIndex: -1, limit: 2,
    groupByPresentationKey: true,
  });

  assert.equal(page.total, 7);
  assert.deepEqual(page.rows, [{ Id: ids.season }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM "shows_shape"\."AncestorIds"/u);
  assert.match(calls[0].text, /PARTITION BY "PresentationUniqueKey"/u);
  assert.match(calls[0].text, /ORDER BY [\s\S]*i\."PremiereDate"[\s\S]*LIMIT/u);
  assert.match(calls[0].text, /LIMIT \$\d+/u);
  assert.doesNotMatch(calls[0].text, /OFFSET/u);
});

test('PostgreSQL Seasons applies series, special, missing, grouping and adjacency in SQL', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres', schemaName: 'shows_shape',
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [{ Id: nativeTextBytes(ids.season), TotalRecordCount: '1' }] };
    } },
    rows: async (name, options) => {
      assert.equal(name, 'BaseItems');
      assert.deepEqual(options, { whereIn: { Id: [ids.season] } });
      return [{ Id: ids.season }];
    },
  };
  const page = await queryPostgresSeriesSeasonPage(database, {
    seriesKey: 'series-key', isSpecialSeason: true, isMissing: false,
    adjacentTo: ids.season, userId: ids.view, groupByPresentationKey: true,
  });

  assert.equal(page.total, 1);
  assert.deepEqual(page.rows, [{ Id: ids.season }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /i\."SeriesPresentationUniqueKey" IS NOT DISTINCT FROM \$\d+/u);
  assert.match(calls[0].text, /i\."IndexNumber" = 0/u);
  assert.doesNotMatch(calls[0].text, /lower\(i\."Id"\) = ANY/u);
  assert.match(calls[0].text, /i\."IsVirtualItem" IS FALSE/u);
  assert.match(calls[0].text, /PARTITION BY "PresentationUniqueKey"/u);
  assert.match(calls[0].text, /anchor AS/u);
  assert.match(calls[0].text, /ORDER BY i\."SortName" ASC/u);
});

test('real PostgreSQL Seasons adjacency never returns or hydrates the complete series', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `shows_season_bounds_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

  const blank = Object.fromEntries(tableDefinition('BaseItems').columns
    .filter(column => !column.generated).map(column => {
      const type = column.clrType.replace('?', '');
      return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
        : column.nullable ? null : type === 'bool' ? false
          : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
    }));
  const seasonId = index => `7c000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
  for (let index = 1; index <= 192; index++) {
    await database.insert('BaseItems', {
      ...blank,
      Id: seasonId(index),
      Type: 'MediaBrowser.Controller.Entities.TV.Season',
      Name: `Season ${index}`,
      CleanName: `season ${index}`,
      SortName: `season-${String(index).padStart(4, '0')}`,
      SeriesPresentationUniqueKey: 'bounded-seasons',
      PresentationUniqueKey: `bounded-season-${index}`,
      IndexNumber: index,
      IsFolder: true,
      MediaType: 'Unknown',
      UnratedType: 'Other',
      Data: '{}',
    });
  }

  const querySizes = [];
  const originalQuery = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const result = await originalQuery(...args);
    const [plan] = args;
    if (typeof plan?.text === 'string' && plan.text.includes('anchor AS')) querySizes.push(result.rows.length);
    return result;
  };
  const hydrationSizes = [];
  const originalRows = database.rows.bind(database);
  database.rows = async (name, options) => {
    if (name === 'BaseItems') hydrationSizes.push(options?.whereIn?.Id?.length ?? Number.POSITIVE_INFINITY);
    return originalRows(name, options);
  };

  const page = await queryPostgresSeriesSeasonPage(database, {
    seriesKey: 'bounded-seasons', adjacentTo: seasonId(96),
  });
  assert.deepEqual(page.rows.map(row => row.Id), [seasonId(95), seasonId(96), seasonId(97)]);
  assert.equal(page.total, 3);
  assert.deepEqual(querySizes, [3]);
  assert.deepEqual(hydrationSizes, [3]);
});
