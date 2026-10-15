import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import {
  postgresInvariantCharUpperFunctionName,
  postgresNativeJsonEnumFunctionName,
  postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName,
} from '../../src/database/postgres-runtime-schema.js';
import { ecmaWhitespaceCharacters } from '../../src/metadata/whitespace.js';
import { queryPostgresNextUpPage } from '../../src/library/postgres-next-up-query.js';

const userId = '79000000-0000-0000-0000-000000000001';
const seriesId = '79000000-0000-0000-0000-000000000002';
const firstId = '79000000-0000-0000-0000-000000000003';
const nextId = '79000000-0000-0000-0000-000000000004';
const alternateId = '79000000-0000-0000-0000-000000000005';
const emptyId = '00000000-0000-0000-0000-000000000000';

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

function item(Id, type, index, {
  primaryVersionId = null,
  series = seriesId,
  seriesKey = 'series-key',
  topParentId = seriesId,
  ...values
} = {}) {
  return {
    ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.TV.${type}`,
    Name: Id, CleanName: Id, SortName: `${index ?? 0}-${Id}`, Data: '{"VideoType":"VideoFile"}',
    IsFolder: type === 'Series', IsSeries: type === 'Series', MediaType: type === 'Episode' ? 'Video' : 'Unknown',
    ParentId: type === 'Episode' ? series : null, TopParentId: topParentId,
    SeriesId: type === 'Episode' ? series : null,
    SeriesPresentationUniqueKey: type === 'Episode' ? seriesKey : null,
    PresentationUniqueKey: type === 'Series' ? seriesKey : Id,
    ParentIndexNumber: type === 'Episode' ? 1 : null, IndexNumber: index,
    PrimaryVersionId: primaryVersionId,
    ...values,
  };
}

test('real PostgreSQL Next Up pages before hydration and rejects progress on a linked version', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `next_up_page_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let db;
  t.after(async () => {
    try { await db?.close(); } catch { /* Raw cleanup remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try {
      const quote = value => `"${value.replaceAll('"', '""')}"`;
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quote(schema)}, ${quote(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end(); }
  });
  db = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });
  const storedUserId = userId.replaceAll('-', '');
  let nextUpSql = '';
  const query = db.client.query.bind(db.client);
  db.client.query = async (...args) => {
    const result = await query(...args);
    const [options] = args;
    if (typeof options?.text === 'string' && options.text.includes('WITH series_order AS')) {
      nextUpSql = options.text;
    }
    return result;
  };
  await db.insert('Users', { ...blank('Users'), Id: storedUserId, Username: 'next-up-user' });
  await db.insert('BaseItems', item(seriesId, 'Series', null));
  await db.insert('BaseItems', item(firstId, 'Episode', 1, { primaryVersionId: emptyId }));
  await db.insert('BaseItems', item(nextId, 'Episode', 2));
  await db.insert('BaseItems', item(alternateId, 'Episode', 2,
    { primaryVersionId: nextId.replaceAll('-', '') }));
  await db.insert('LinkedChildren', { ParentId: nextId, SortOrder: 0, ChildId: alternateId, ChildType: 2 });
  await db.insert('UserData', { ...blank('UserData'), ItemId: firstId, UserId: storedUserId,
    CustomDataKey: firstId, Played: true, PlayCount: 1, LastPlayedDate: '2026-10-01 00:00:00' });
  await db.insert('UserData', { ...blank('UserData'), ItemId: alternateId, UserId: storedUserId,
    CustomDataKey: alternateId, PlaybackPositionTicks: 100n });

  const hydratedPages = [];
  const rows = db.rows.bind(db);
  db.rows = (name, options) => {
    if (name === 'BaseItems' && /postgres-next-up-query/u.test(new Error().stack ?? '')) {
      hydratedPages.push([...(options?.whereIn?.Id ?? [])]);
    }
    return rows(name, options);
  };

  const blocked = await queryPostgresNextUpPage(db, {
    seriesKeys: ['series-key'], userId, enableResumable: false, enableUserData: false, limit: 1,
  });
  assert.deepEqual(blocked.rows, []);
  assert.equal(blocked.total, 0);

  await db.insert('BaseItemProviders', {
    ItemId: seriesId, ProviderId: 'cUsToM', ProviderValue: 'series-custom',
  });
  await db.insert('UserData', { ...blank('UserData'), ItemId: alternateId, UserId: storedUserId,
    CustomDataKey: 'series-custom001002', PlaybackPositionTicks: 0n });
  const mixedCaseProvider = await queryPostgresNextUpPage(db, {
    seriesKeys: ['series-key'], userId, enableResumable: true, enableUserData: false, limit: 1,
  });
  assert.deepEqual(mixedCaseProvider.rows.map(row => row.Id), [nextId],
    'mixed-case Custom provider identity selects the native preferred user-data key');
  for (const provider of ['CUSTOM', 'TVDB', 'IMDB']) {
    assert.ok(nextUpSql.includes(`"${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"(provider."ProviderId") = decode('${nativeTextOrdinalIgnoreCaseKey(provider).toString('hex')}', 'hex')`));
  }
  assert.doesNotMatch(nextUpSql, /provider\."ProviderId"\s*=\s*'(?:Custom|Tvdb|Imdb)'/u);

  await db.update('UserData', { ItemId: alternateId, UserId: storedUserId, CustomDataKey: alternateId },
    { PlaybackPositionTicks: 0n });
  const page = await queryPostgresNextUpPage(db, {
    seriesKeys: ['series-key'], userId, enableResumable: true, enableUserData: false, limit: 1,
  });
  assert.deepEqual(page.rows.map(row => row.Id), [nextId]);
  assert.equal(page.total, 1);
  assert.ok(hydratedPages.length > 0);
  assert.ok(hydratedPages.every(ids => ids.length <= 1),
    'Limit=1 must not hydrate last episodes, alternates or the complete candidate set');
  assert.ok(hydratedPages.flat().every(id => id !== firstId && id !== alternateId));

  for (const data of ['bad{', '[]', '{"AirsAfterSeasonNumber":{}}',
    '{"AirsAfterSeasonNumber":2,"Width":"bad"}',
    `{"AirsAfterSeasonNumber":${'9'.repeat(10000)}}`]) {
    for (const Id of [firstId, nextId, alternateId]) await db.update('BaseItems', { Id }, { Data: data });
    const safePage = await queryPostgresNextUpPage(db, {
      seriesKeys: ['series-key'], userId, enableResumable: true, enableUserData: false, limit: 1,
    });
    assert.deepEqual(safePage.rows.map(row => row.Id), [nextId],
      `arbitrary BaseItems.Data must not abort Next Up: ${data.slice(0, 40)}`);
  }
  assert.ok(nextUpSql.includes(`"${schema}"."${postgresSafeNativeItemDataFunctionName}"(item."Type", item."Data")`));
  assert.ok(nextUpSql.includes(`"${schema}"."${postgresSafeInt32FunctionName}"(`));
  await db.update('BaseItems', { Id: firstId }, { Data: '{"VideoType":"VideoFile"}' });
  await db.update('BaseItems', { Id: nextId }, { Data: '{"VideoType":"VideoFile"}' });
  await db.update('BaseItems', { Id: alternateId }, { Data: '{"VideoType":"VideoFile"}' });

  await db.insert('UserData', { ...blank('UserData'), ItemId: nextId, UserId: storedUserId,
    CustomDataKey: nextId, Played: true, PlayCount: 1, LastPlayedDate: '2026-09-01 00:00:00' });
  const rewatchPage = await queryPostgresNextUpPage(db, {
    seriesKeys: ['series-key'], userId, enableRewatching: true,
    enableResumable: true, enableUserData: false, limit: 1,
  });
  assert.equal(rewatchPage.total, 1,
    'an all-zero PrimaryVersionId remains in its own rewatch family');
  assert.deepEqual(rewatchPage.rows.map(row => row.Id), [nextId],
    'rewatch folds an N-format PrimaryVersionId into its D-format episode family');
});

test('real PostgreSQL Next Up keeps discovered series keys inside a Limit=1 SQL page', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `next_up_keys_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const discoveryUserId = '7a000000-0000-0000-0000-000000000001';
  const topParentId = '7a000000-0000-0000-0000-000000000002';
  const discoveredSeriesCount = 24;
  let db;
  t.after(async () => {
    try { await db?.close(); } catch { /* Raw cleanup remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try {
      const quote = value => `"${value.replaceAll('"', '""')}"`;
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quote(schema)}, ${quote(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end(); }
  });
  db = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });
  const storedDiscoveryUserId = discoveryUserId.replaceAll('-', '');
  const storedTopParentId = topParentId.replaceAll('-', '');
  await db.insert('Users', { ...blank('Users'), Id: storedDiscoveryUserId, Username: 'next-up-key-user' });

  const identifier = value => `7a000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
  let expectedNextId;
  for (let index = 0; index < discoveredSeriesCount; index += 1) {
    const discoveredSeriesId = identifier(index * 3 + 10);
    const playedId = identifier(index * 3 + 11);
    const discoveredNextId = identifier(index * 3 + 12);
    const seriesKey = `discovered-series-${String(index).padStart(2, '0')}`;
    await db.insert('BaseItems', item(discoveredSeriesId, 'Series', null,
      { series: discoveredSeriesId, seriesKey, topParentId: storedTopParentId }));
    await db.insert('BaseItems', item(playedId, 'Episode', 1,
      { series: discoveredSeriesId, seriesKey, topParentId: storedTopParentId }));
    await db.insert('BaseItems', item(discoveredNextId, 'Episode', 2,
      { series: discoveredSeriesId, seriesKey, topParentId: storedTopParentId }));
    await db.insert('UserData', { ...blank('UserData'), ItemId: playedId, UserId: storedDiscoveryUserId,
      CustomDataKey: playedId, Played: true, PlayCount: 1,
      LastPlayedDate: `2026-09-${String(index + 1).padStart(2, '0')} 00:00:00` });
    expectedNextId = discoveredNextId;
  }

  const sqlPages = [];
  const query = db.client.query.bind(db.client);
  db.client.query = async (...args) => {
    const result = await query(...args);
    const [options] = args;
    if (typeof options?.text === 'string' && options.text.includes('WITH series_order AS')) {
      sqlPages.push({ rows: result.rows, values: options.values });
    }
    return result;
  };
  const hydratedPages = [];
  const rows = db.rows.bind(db);
  db.rows = (name, options) => {
    if (name === 'BaseItems' && /postgres-next-up-query/u.test(new Error().stack ?? '')) {
      hydratedPages.push([...(options?.whereIn?.Id ?? [])]);
    }
    return rows(name, options);
  };

  const page = await queryPostgresNextUpPage(db, {
    seriesDiscovery: { topParentIds: [topParentId], nextUpDateCutoff: '0001-01-01T00:00:00.0000000Z' },
    userId: discoveryUserId,
    limit: 1,
  });
  assert.deepEqual(page.rows.map(row => row.Id), [expectedNextId]);
  assert.equal(page.total, discoveredSeriesCount);
  assert.equal(sqlPages.length, 1);
  assert.equal(sqlPages[0].rows.length, 1, 'SQL must return only the selected page, not every discovered key');
  assert.ok(sqlPages[0].rows.every(row => !Object.hasOwn(row, 'Key')));
  assert.ok(sqlPages[0].values.filter(Array.isArray).every(value => value.length <= 1),
    'discovered keys must not cross the SQL/Node boundary as an accumulated array');
  assert.ok(hydratedPages.length > 0);
  assert.ok(hydratedPages.every(ids => ids.length <= 1));
});

test('real PostgreSQL Next Up preserves native non-ASCII version prefix, label and path matching', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `next_up_unicode_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const versionUserId = '7b000000-0000-0000-0000-000000000001';
  const identifier = (family, value) => `${family}000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
  let db;
  t.after(async () => {
    try { await db?.close(); } catch { /* Raw cleanup remains authoritative. */ }
    const cleanup = new pg.Pool({ connectionString });
    try {
      const quote = value => `"${value.replaceAll('"', '""')}"`;
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quote(schema)}, ${quote(`${schema}__mm`)} CASCADE`);
    } finally { await cleanup.end(); }
  });
  db = await PostgresDatabase.open({ connectionString, schema, create: true, max: 2 });
  await db.insert('Users', { ...blank('Users'), Id: versionUserId, Username: 'next-up-version-user' });

  const expected = [];
  const seriesKeys = [];
  const addScenario = async ({
    family, key, lastPaths, nextPaths, widths = [], expectRoot = false, lastData = [], nextData = [],
  }) => {
    const scenarioSeriesId = identifier(family, 2);
    const lastId = identifier(family, 3);
    const scenarioNextId = identifier(family, 4);
    const lastVersionId = identifier(family, 5);
    const nextVersionIds = nextPaths.slice(1).map((path, index) => identifier(family, index + 6));
    seriesKeys.push(key);
    await db.insert('BaseItems', item(scenarioSeriesId, 'Series', null, {
      series: scenarioSeriesId, seriesKey: key, topParentId: scenarioSeriesId,
    }));
    await db.insert('BaseItems', item(lastId, 'Episode', 1, {
      series: scenarioSeriesId, seriesKey: key, topParentId: scenarioSeriesId,
      Path: lastPaths[0], Name: `${key} last`, Data: lastData[0] ?? '{"VideoType":"VideoFile"}',
    }));
    await db.insert('BaseItems', item(lastVersionId, 'Episode', 1, {
      primaryVersionId: lastId, series: scenarioSeriesId, seriesKey: key, topParentId: scenarioSeriesId,
      Path: lastPaths[1], Name: `${key} played version`, Data: lastData[1] ?? '{"VideoType":"VideoFile"}',
    }));
    await db.insert('LinkedChildren', {
      ParentId: lastId, SortOrder: 0, ChildId: lastVersionId, ChildType: 2,
    });
    await db.insert('BaseItems', item(scenarioNextId, 'Episode', 2, {
      series: scenarioSeriesId, seriesKey: key, topParentId: scenarioSeriesId,
      Path: nextPaths[0], Name: `${key} next`, Data: nextData[0] ?? '{"VideoType":"VideoFile"}',
    }));
    for (const [index, nextVersionId] of nextVersionIds.entries()) {
      await db.insert('BaseItems', item(nextVersionId, 'Episode', 2, {
        primaryVersionId: scenarioNextId, series: scenarioSeriesId, seriesKey: key,
        topParentId: scenarioSeriesId, Path: nextPaths[index + 1], Name: `${key} version ${index}`,
        Data: nextData[index + 1] ?? '{"VideoType":"VideoFile"}',
      }));
      await db.insert('LinkedChildren', {
        ParentId: scenarioNextId, SortOrder: index, ChildId: nextVersionId, ChildType: 2,
      });
      if (widths[index] !== undefined) await db.insert('MediaStreamInfos', {
        ...blank('MediaStreamInfos'), ItemId: nextVersionId, StreamIndex: 0, StreamType: 1,
        Width: widths[index],
      });
    }
    await db.insert('UserData', {
      ...blank('UserData'), ItemId: lastVersionId, UserId: versionUserId,
      CustomDataKey: lastVersionId, Played: true, PlayCount: 1,
      LastPlayedDate: '2026-10-01 00:00:00',
    });
    expected.push(expectRoot ? scenarioNextId : nextVersionIds.at(-1));
  };

  await addScenario({
    family: '7c', key: 'unicode-prefix',
    lastPaths: ['Z:\\Prefix\\SFilm - base.mkv', 'Z:\\Prefix\\ſFilm - 2160p.mkv'],
    nextPaths: ['Z:\\Prefix\\Next - base.mkv', 'Z:\\Prefix\\Next - 2160p.mkv'],
  });
  await addScenario({
    family: '7d', key: 'unicode-label',
    lastPaths: ['Z:\\Label\\Last - base.mkv', 'Z:\\Label\\Last - ς.mkv'],
    nextPaths: ['Z:\\Label\\Next - base.mkv', 'Z:\\Label\\Next - σ.mkv'],
  });
  await addScenario({
    family: '7e', key: 'unicode-path',
    lastPaths: ['Z:\\Path\\Last - base.mkv', 'Z:\\Path\\Last - Σ.mkv'],
    nextPaths: ['Z:\\Path\\Next - base.mkv', 'Z:\\Path\\Next - σ.mkv',
      'z:\\path\\next - Σ.MKV'],
    widths: [720, 2160],
  });
  await addScenario({
    family: '7f', key: 'non-ascii-scheme-like-local-path',
    lastPaths: ['ſttp://folder/Last - base.mkv', 'ſttp://folder/Last - 2160p.mkv'],
    nextPaths: ['ſttp://folder/Next - base.mkv', 'ſttp://folder/Next - 2160p.mkv'],
  });
  await addScenario({
    family: '80', key: 'uppercase-http-remote-path',
    lastPaths: ['HTTP://host/Last - base.mkv', 'HTTP://host/Last - 2160p.mkv'],
    nextPaths: ['HTTP://host/Next - base.mkv', 'HTTP://host/Next - 2160p.mkv'],
    expectRoot: true,
  });
  await addScenario({
    family: '81', key: 'tab-only-version-suffix',
    lastPaths: ['Z:\\Whitespace\\Last.mkv', 'Z:\\Whitespace\\Last\t.mkv'],
    nextPaths: ['Z:\\Whitespace\\Next.mkv', 'Z:\\Whitespace\\Next\t.mkv'],
    expectRoot: true,
  });
  await addScenario({
    family: '82', key: 'bom-only-version-suffix',
    lastPaths: ['Z:\\Whitespace\\Last.mkv', 'Z:\\Whitespace\\Last\ufeff.mkv'],
    nextPaths: ['Z:\\Whitespace\\Next.mkv', 'Z:\\Whitespace\\Next\ufeff.mkv'],
    expectRoot: true,
  });
  await addScenario({
    family: '83', key: 'nel-version-suffix',
    lastPaths: ['Z:\\Whitespace\\Last.mkv', 'Z:\\Whitespace\\Last\u0085.mkv'],
    nextPaths: ['Z:\\Whitespace\\Next.mkv', 'Z:\\Whitespace\\Next\u0085.mkv'],
  });
  await addScenario({
    family: '84', key: 'enum-case-and-number',
    lastPaths: ['Z:\\Enum\\Movie.mkv', 'Z:\\Enum\\Movie.mkv'],
    nextPaths: ['Z:\\Enum\\Movie.mkv', 'Z:\\Enum\\Movie.mkv'],
    lastData: ['{"VideoType":"VideoFile"}', '{"VideoType":"bluray"}'],
    nextData: ['{"VideoType":"VideoFile"}', '{"VideoType":3}'],
  });
  await addScenario({
    family: '85', key: 'iso-enum-case-and-number',
    lastPaths: ['Z:\\IsoEnum\\Movie.mkv', 'Z:\\IsoEnum\\Movie.mkv'],
    nextPaths: ['Z:\\IsoEnum\\Movie.mkv', 'Z:\\IsoEnum\\Movie.mkv'],
    lastData: ['{"VideoType":"VideoFile"}', '{"VideoType":"iso","IsoType":1}'],
    nextData: ['{"VideoType":"VideoFile"}', '{"VideoType":1,"IsoType":"bluray"}'],
  });
  await addScenario({
    family: '86', key: 'nullable-empty-video-3d',
    lastPaths: ['Z:\\ThreeD\\Movie.mkv', 'Z:\\ThreeD\\Movie.mkv'],
    nextPaths: ['Z:\\ThreeD\\Movie.mkv', 'Z:\\ThreeD\\Movie.mkv'],
    lastData: ['{"VideoType":"VideoFile"}', '{"VideoType":"VideoFile","Video3DFormat":""}'],
    nextData: ['{"VideoType":"VideoFile"}', '{"VideoType":"VideoFile","Video3DFormat":"MVC"}'],
    expectRoot: true,
  });

  let preferredSql = '';
  let preferredValues = [];
  const query = db.client.query.bind(db.client);
  db.client.query = async (...args) => {
    const result = await query(...args);
    const [options] = args;
    if (typeof options?.text === 'string' && options.text.includes('WITH requests AS')) {
      preferredSql = options.text;
      preferredValues = options.values;
    }
    return result;
  };
  const page = await queryPostgresNextUpPage(db, {
    seriesKeys, userId: versionUserId, enableResumable: true,
  });
  assert.deepEqual(page.rows.map(row => row.Id), expected);
  assert.match(preferredSql, new RegExp(postgresInvariantCharUpperFunctionName, 'u'));
  assert.match(preferredSql, new RegExp(postgresOrdinalIgnoreCaseKeyFunctionName, 'u'));
  assert.match(preferredSql, new RegExp(postgresNativeJsonEnumFunctionName, 'u'));
  assert.match(preferredSql, /prefix_cut AS MATERIALIZED/u,
    'the version-prefix aggregate must be evaluated once, not once per source row');
  assert.ok(preferredSql.includes("btrim(regexp_replace(array_to_string(source.__stem_tokens[prefix.__prefix_length + 1:], ''), '^[ _.-]+', ''), $5) <> ''"));
  assert.ok(preferredValues.includes(ecmaWhitespaceCharacters));
  assert.ok(ecmaWhitespaceCharacters.includes('\ufeff'));
  assert.equal(ecmaWhitespaceCharacters.includes('\u0085'), false);
  assert.ok(preferredSql.includes('mm_native_ascii_lower'));
  assert.ok(preferredSql.includes("!~ '^(rtsp|rtmp|http|rtp|ftp|udp)'"));
  assert.ok(preferredSql.includes("!~ '^[a-z][a-z0-9+.-]*://'"));
  assert.doesNotMatch(preferredSql, /source\.__source_path !~\*/u);
  assert.doesNotMatch(preferredSql, /translate\(concat_ws/iu);
  assert.doesNotMatch(preferredSql, /lower\(candidate\."__source_path"\)/u);
});
