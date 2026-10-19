import { nativeTextBytes, nativeTextProjection } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { postgresOrdinalIgnoreCaseKeyFunctionName, postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { clrWhitespaceCharacters } from '../../src/metadata/whitespace.js';
import {
  buildPostgresSeriesEpisodePageQuery,
  queryPostgresSeriesEpisodePage,
} from '../../src/library/postgres-series-episodes-query.js';

const ids = Object.freeze({
  season: '12000000-0000-0000-0000-000000000001',
  start: '12000000-0000-0000-0000-000000000002',
  adjacent: '12000000-0000-0000-0000-000000000003',
  first: '12000000-0000-0000-0000-000000000004',
  second: '12000000-0000-0000-0000-000000000005',
});

const databaseShape = { dialect: 'postgres', schemaName: 'episode_shape' };

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, Type, values = {}) => ({
  ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.TV.${Type}`,
  Name: Type, CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(), Data: '{}', ...values,
});

test('PostgreSQL series Episodes keeps grouping, special placement and page transforms relational', () => {
  const plan = buildPostgresSeriesEpisodePageQuery(databaseShape, {
    mode: 'series',
    seriesKey: 'fixture-series',
    includeMissing: true,
    includeSpecials: true,
    groupByPresentationKey: true,
    isMissing: false,
    startItemId: ids.start,
    adjacentTo: ids.adjacent,
    random: true,
    startIndex: 2,
    limit: 4,
    visibility: {
      blockedTags: ['Blocked'], allowedTags: ['Allowed'], maxRating: 10,
      maxSubRating: 1, blockUnratedTypes: ['Episode'], libraryTopParentIds: [],
    },
  });

  assert.match(plan.text, /eligible AS/u);
  assert.match(plan.text, /joint_ranked AS/u);
  assert.match(plan.text, /PARTITION BY joint_item\."PresentationUniqueKey"/u);
  assert.match(plan.text, /chosen_seasons AS/u);
  assert.match(plan.text, /membership AS/u);
  assert.match(plan.text, /episode_sort\("SeasonId", "Step", "Ids", "InputCount"\) AS/u);
  assert.match(plan.text, /last_occurrence AS/u);
  assert.match(plan.text, /post_missing AS/u);
  assert.match(plan.text, /start_anchor AS/u);
  assert.match(plan.text, /adjacent_anchor AS/u);
  assert.match(plan.text, /after_random AS/u);
  assert.match(plan.text, /LIMIT \$\d+ OFFSET \$\d+/u);
  assert.match(plan.text, new RegExp(`"episode_shape"\\."${postgresOrdinalIgnoreCaseKeyFunctionName}"\\(`, 'u'));
  assert.match(plan.text, /i\."UnratedType" = ANY\([^)]*\)\) IS NOT TRUE/u);
  assert.doesNotMatch(plan.text, /lower\(CASE WHEN COALESCE\([^)]*\."ForcedSortName"/u);
  assert.doesNotMatch(plan.text, /lower\(membership\."(?:Referenced)?SeasonKey"\)/u);
  assert.doesNotMatch(plan.text, /walk\."Depth"\s*<\s*64/u);
  assert.match(plan.text, new RegExp(`"episode_shape"\\."${postgresSafeNativeItemDataFunctionName}"\\(episode\\."Type", episode\\."Data"\\)`, 'u'));
  assert.match(plan.text, new RegExp(`"episode_shape"\\."${postgresSafeInt32FunctionName}"\\(`, 'u'));
  assert.doesNotMatch(plan.text, /"SourceType"\[\[:space:\]\]/u,
    'SourceType is a derived entity getter and must not be read from arbitrary Data text');
  assert.match(plan.text, /episode\."ChannelId"/u);
  assert.doesNotMatch(plan.text, /SELECT \* FROM "episode_shape"\."BaseItems"\s*$/u);
  assert.ok(plan.values.includes(clrWhitespaceCharacters));

  const nelKey = buildPostgresSeriesEpisodePageQuery(databaseShape, {
    mode: 'series', seriesKey: '\u0085', includeMissing: true,
  });
  assert.doesNotMatch(nelKey.text, /"SeriesPresentationUniqueKey" IS NOT DISTINCT FROM/u,
    'CLR NEL is an empty series key');
  const bomKey = buildPostgresSeriesEpisodePageQuery(databaseShape, {
    mode: 'series', seriesKey: '\ufeff', includeMissing: true,
  });
  assert.match(bomKey.text, /"SeriesPresentationUniqueKey" IS NOT DISTINCT FROM/u,
    'FEFF is not CLR whitespace and remains a scoped series key');
});

test('PostgreSQL season Episodes supports a direct season and hydrates only returned page ids', async () => {
  const calls = [];
  const database = {
    ...databaseShape,
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [
        { Id: nativeTextBytes(ids.second), TotalRecordCount: '7' },
        { Id: nativeTextBytes(ids.first), TotalRecordCount: '7' },
      ] };
    } },
    rows: async (name, options) => {
      assert.equal(name, 'BaseItems');
      assert.deepEqual(options, { whereIn: { Id: [ids.second, ids.first] } });
      return [{ Id: ids.first }, { Id: ids.second }];
    },
  };

  const page = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: ids.season, seriesKey: 'fixture-series', limit: 2,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM "episode_shape"\."BaseItems" target/u);
  assert.equal(page.total, 7);
  assert.deepEqual(page.rows, [{ Id: ids.second }, { Id: ids.first }]);
});

test('PostgreSQL series Episodes rejects invalid modes and paging before querying', () => {
  assert.throws(() => buildPostgresSeriesEpisodePageQuery(databaseShape, { mode: 'unknown' }),
    /Unknown series episode query mode/u);
  assert.throws(() => buildPostgresSeriesEpisodePageQuery(databaseShape, { mode: 'season' }),
    /seasonId is required/u);
  assert.throws(() => buildPostgresSeriesEpisodePageQuery(databaseShape, { mode: 'number' }),
    /seasonNumber is required/u);
  assert.throws(() => buildPostgresSeriesEpisodePageQuery(databaseShape, { startIndex: 1.5 }),
    /startIndex must be an integer/u);
});

test('real PostgreSQL missing episode filtering derives SourceType from ChannelId, not Data', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `episode_source_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  const seriesId = '12100000-0000-0000-0000-000000000001';
  const seasonId = '12100000-0000-0000-0000-000000000002';
  const ignoredDataSourceId = '12100000-0000-0000-0000-000000000003';
  const channelIdSourceId = '12100000-0000-0000-0000-000000000004';
  await database.insert('BaseItems', item(seriesId, 'Series', {
    PresentationUniqueKey: 'source-series', IsFolder: true,
  }));
  await database.insert('BaseItems', item(seasonId, 'Season', {
    ParentId: seriesId, SeriesId: seriesId, IndexNumber: 1, IsFolder: true,
    PresentationUniqueKey: 'source-season', SeriesPresentationUniqueKey: 'source-series',
  }));
  await database.insert('BaseItems', item(ignoredDataSourceId, 'Episode', {
    ParentId: seasonId, SeasonId: seasonId, SeriesId: seriesId,
    ParentIndexNumber: 1, IndexNumber: 1, Path: null,
    PresentationUniqueKey: 'source-ignored-data', SeriesPresentationUniqueKey: 'source-series',
    Data: '{"SourceType":"Channel"}',
  }));
  await database.insert('BaseItems', item(channelIdSourceId, 'Episode', {
    ParentId: seasonId, SeasonId: seasonId, SeriesId: seriesId,
    ParentIndexNumber: 1, IndexNumber: 2, Path: null,
    ChannelId: '12100000-0000-0000-0000-000000000099',
    PresentationUniqueKey: 'source-channel-id', SeriesPresentationUniqueKey: 'source-series',
    Data: '{}',
  }));
  for (const episodeId of [ignoredDataSourceId, channelIdSourceId]) {
    await database.insert('AncestorIds', { ItemId: episodeId, ParentItemId: seasonId });
  }

  const missing = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId, seriesKey: 'source-series', includeMissing: true,
    includeSpecials: false, isMissing: true,
  });
  assert.deepEqual(missing.rows.map(row => row.Id), [ignoredDataSourceId],
    'an ignored Data property cannot turn a library episode into Channel content');
  const present = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId, seriesKey: 'source-series', includeMissing: true,
    includeSpecials: false, isMissing: false,
  });
  assert.deepEqual(present.rows.map(row => row.Id), [channelIdSourceId],
    'a nonempty ChannelId makes a pathless episode non-virtual');
});

test('real PostgreSQL keeps specials out of physical-season mode without hydrating candidates', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `episode_query_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  const seriesId = '12000000-0000-0000-0000-000000000010';
  const seasonZeroId = '12000000-0000-0000-0000-000000000011';
  const seasonOneId = '12000000-0000-0000-0000-000000000012';
  const seasonTwoId = '12000000-0000-0000-0000-000000000015';
  const regularId = '12000000-0000-0000-0000-000000000013';
  const regularAlternateId = '12000000-0000-0000-0000-000000000026';
  const specialId = '12000000-0000-0000-0000-000000000014';
  const referencedKeyId = '12000000-0000-0000-0000-000000000016';
  const lowerSigmaId = '12000000-0000-0000-0000-000000000017';
  const upperSigmaId = '12000000-0000-0000-0000-000000000018';
  const deepSeasonId = '12000000-0000-0000-0000-000000000019';
  const deepEpisodeId = '12000000-0000-0000-0000-000000000020';
  const nullUnratedId = '12000000-0000-0000-0000-000000000021';
  const blockedUnratedId = '12000000-0000-0000-0000-000000000022';
  const bomSeriesId = '12000000-0000-0000-0000-000000000023';
  const bomSeasonId = '12000000-0000-0000-0000-000000000024';
  const bomEpisodeId = '12000000-0000-0000-0000-000000000025';
  const deepFolderIds = Array.from({ length: 70 }, (_, index) =>
    `12000000-0000-0000-0000-${String(100 + index).padStart(12, '0')}`);
  await database.insert('BaseItems', item(seriesId, 'Series', {
    PresentationUniqueKey: 'bounded-series', IsFolder: true,
  }));
  await database.insert('BaseItems', item(bomSeriesId, 'Series', {
    PresentationUniqueKey: '\ufeff', IsFolder: true, SortName: 'bom-series',
  }));
  await database.insert('BaseItems', item(bomSeasonId, 'Season', {
    ParentId: bomSeriesId, SeriesId: bomSeriesId, IndexNumber: 1, IsFolder: true,
    PresentationUniqueKey: 'bom-season', SeriesPresentationUniqueKey: '\ufeff', SortName: 'bom-season',
  }));
  await database.insert('BaseItems', item(bomEpisodeId, 'Episode', {
    ParentId: bomSeasonId, SeasonId: bomSeasonId, SeriesId: bomSeriesId,
    ParentIndexNumber: 1, IndexNumber: 1, PresentationUniqueKey: 'bom-episode',
    SeriesPresentationUniqueKey: '\ufeff', Path: 'Z:\\Shows\\BOM.mkv', SortName: 'bom-episode',
  }));
  await database.insert('BaseItems', item(seasonZeroId, 'Season', {
    ParentId: seriesId, SeriesId: seriesId, IndexNumber: 0, IsFolder: true,
    PresentationUniqueKey: 'bounded-series-000', SeriesPresentationUniqueKey: 'bounded-series', SortName: '0000',
  }));
  await database.insert('BaseItems', item(seasonOneId, 'Season', {
    ParentId: seriesId, SeriesId: seriesId, IndexNumber: 1, IsFolder: true,
    PresentationUniqueKey: 'bounded-Σ', SeriesPresentationUniqueKey: 'bounded-series', SortName: '0001',
  }));
  await database.insert('BaseItems', item(seasonTwoId, 'Season', {
    ParentId: seriesId, SeriesId: seriesId, IndexNumber: 2, IsFolder: true,
    PresentationUniqueKey: 'bounded-ς', SeriesPresentationUniqueKey: 'bounded-series', SortName: '0002',
  }));
  await database.insert('BaseItems', item(deepSeasonId, 'Season', {
    ParentId: seriesId, SeriesId: seriesId, IndexNumber: 3, IsFolder: true,
    PresentationUniqueKey: 'bounded-series-003', SeriesPresentationUniqueKey: 'bounded-series', SortName: '0003',
  }));
  for (const [index, folderId] of deepFolderIds.entries()) {
    await database.insert('BaseItems', item(folderId, 'Folder', {
      ParentId: index === 0 ? seriesId : deepFolderIds[index - 1], IsFolder: true,
      PresentationUniqueKey: `bounded-deep-folder-${index}`, SortName: `deep-${String(index).padStart(2, '0')}`,
    }));
  }
  await database.insert('BaseItems', item(regularId, 'Episode', {
    ParentId: seasonOneId, SeasonId: seasonOneId, SeriesId: seriesId,
    ParentIndexNumber: 1, IndexNumber: 1, PresentationUniqueKey: 'bounded-s1e1',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\S01E01.mkv', SortName: '001 - 0001',
  }));
  await database.insert('BaseItems', item(regularAlternateId, 'Episode', {
    ParentId: seasonOneId, SeasonId: seasonOneId, SeriesId: seriesId,
    ParentIndexNumber: 1, IndexNumber: 1, PresentationUniqueKey: 'bounded-s1e1-alternate',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\S01E01-alt.mkv',
    SortName: '001 - 0001 alternate', PrimaryVersionId: regularId.replaceAll('-', ''),
  }));
  await database.insert('BaseItems', item(specialId, 'Episode', {
    ParentId: seasonZeroId, SeasonId: seasonZeroId, SeriesId: seriesId,
    ParentIndexNumber: 0, IndexNumber: 1, PresentationUniqueKey: 'bounded-special',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\Special.mkv', SortName: '000 - 0001',
    Data: JSON.stringify({ AirsAfterSeasonNumber: 1 }),
  }));
  await database.insert('BaseItems', item(referencedKeyId, 'Episode', {
    ParentId: seasonTwoId, SeasonId: seasonTwoId, SeriesId: seriesId,
    ParentIndexNumber: 2, IndexNumber: 1, PresentationUniqueKey: 'bounded-s2e1',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\S02E01.mkv', SortName: '002 - 0001',
  }));
  await database.insert('BaseItems', item(lowerSigmaId, 'Episode', {
    ParentId: seasonZeroId, SeasonId: seasonZeroId, SeriesId: seriesId,
    ParentIndexNumber: 0, IndexNumber: 2, PresentationUniqueKey: 'bounded-lower-sigma',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\LowerSigma.mkv',
    Name: 'Lower sigma', ForcedSortName: 'σigma', SortName: 'a-repository-first',
  }));
  await database.insert('BaseItems', item(upperSigmaId, 'Episode', {
    ParentId: seasonZeroId, SeasonId: seasonZeroId, SeriesId: seriesId,
    ParentIndexNumber: 0, IndexNumber: 3, PresentationUniqueKey: 'bounded-upper-sigma',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\UpperSigma.mkv',
    Name: 'Upper sigma', ForcedSortName: 'Σigma', SortName: 'z-repository-last',
  }));
  await database.insert('BaseItems', item(deepEpisodeId, 'Episode', {
    ParentId: deepFolderIds.at(-1), SeasonId: null, SeriesId: null,
    ParentIndexNumber: 3, IndexNumber: 1, PresentationUniqueKey: 'bounded-deep-s3e1',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\Deep\\S03E01.mkv',
    SortName: '003 - 0001',
  }));
  await database.insert('BaseItems', item(nullUnratedId, 'Episode', {
    ParentId: deepSeasonId, SeasonId: deepSeasonId, SeriesId: seriesId,
    ParentIndexNumber: 3, IndexNumber: 2, PresentationUniqueKey: 'bounded-null-unrated-s3e2',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\Deep\\S03E02.mkv',
    InheritedParentalRatingValue: null, UnratedType: null, SortName: '003 - 0002',
  }));
  await database.insert('BaseItems', item(blockedUnratedId, 'Episode', {
    ParentId: deepSeasonId, SeasonId: deepSeasonId, SeriesId: seriesId,
    ParentIndexNumber: 3, IndexNumber: 3, PresentationUniqueKey: 'bounded-blocked-unrated-s3e3',
    SeriesPresentationUniqueKey: 'bounded-series', Path: 'Z:\\Shows\\Deep\\S03E03.mkv',
    InheritedParentalRatingValue: null, UnratedType: 'Episode', SortName: '003 - 0003',
  }));
  await database.insert('AncestorIds', { ItemId: regularId, ParentItemId: seasonOneId });
  await database.insert('AncestorIds', { ItemId: regularAlternateId, ParentItemId: seasonOneId });
  await database.insert('AncestorIds', { ItemId: specialId, ParentItemId: seasonZeroId });
  await database.insert('AncestorIds', { ItemId: referencedKeyId, ParentItemId: seasonTwoId });
  await database.insert('AncestorIds', { ItemId: lowerSigmaId, ParentItemId: seasonZeroId });
  await database.insert('AncestorIds', { ItemId: upperSigmaId, ParentItemId: seasonZeroId });
  await database.insert('AncestorIds', { ItemId: bomEpisodeId, ParentItemId: bomSeasonId });

  const comparisonKeys = (await database.client.query(`SELECT
    lower('σigma') AS locale_lower_sigma, lower('Σigma') AS locale_upper_sigma,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"('σigma') AS ordinal_lower_sigma,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"('Σigma') AS ordinal_upper_sigma,
    lower('bounded-Σ') AS locale_sigma, lower('bounded-ς') AS locale_final_sigma,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"('bounded-Σ') AS ordinal_sigma,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"('bounded-ς') AS ordinal_final_sigma`)).rows[0];
  // Server locale providers may already fold upper sigma. The product query
  // must use the native ordinal keys independently of that server policy.
  assert.deepEqual(comparisonKeys.ordinal_lower_sigma, comparisonKeys.ordinal_upper_sigma,
    'native OrdinalIgnoreCase equates lower and upper sigma');
  assert.notEqual(comparisonKeys.locale_sigma, comparisonKeys.locale_final_sigma,
    'the fixture must expose the database lower() false negative');
  assert.deepEqual(comparisonKeys.ordinal_sigma, comparisonKeys.ordinal_final_sigma,
    'native OrdinalIgnoreCase equates final sigma with sigma');

  const physical = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: seasonOneId, seriesKey: 'bounded-series',
    includeMissing: true, includeSpecials: false,
  });
  assert.deepEqual(physical.rows.map(row => row.Id), [regularId]);

  const withSpecials = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: seasonOneId, seriesKey: 'bounded-series',
    includeMissing: true, includeSpecials: true,
  });
  assert.deepEqual(withSpecials.rows.map(row => row.Id), [regularId, specialId, referencedKeyId]);

  const seasonZero = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: seasonZeroId, seriesKey: 'bounded-series',
    includeMissing: true, includeSpecials: true,
  });
  assert.deepEqual(seasonZero.rows.map(row => row.Id), [specialId, lowerSigmaId, upperSigmaId]);

  const deepSeason = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: deepSeasonId, seriesKey: 'bounded-series',
    includeMissing: true, includeSpecials: true,
  });
  assert.deepEqual(deepSeason.rows.map(row => row.Id), [deepEpisodeId, nullUnratedId, blockedUnratedId],
    'an episode with no explicit season or series resolves its series through more than 64 physical parents');

  const visibleUnrated = await queryPostgresSeriesEpisodePage(database, {
    mode: 'season', seasonId: deepSeasonId, seriesKey: 'bounded-series',
    includeMissing: true, includeSpecials: true,
    visibility: { blockUnratedTypes: ['Episode'] },
  });
  assert.deepEqual(visibleUnrated.rows.map(row => row.Id), [deepEpisodeId, nullUnratedId],
    'a NULL unrated type remains visible while a matching unrated Episode is blocked');

  const bomScoped = await queryPostgresSeriesEpisodePage(database, {
    mode: 'series', seriesKey: '\ufeff', includeMissing: true, includeSpecials: true,
  });
  assert.deepEqual(bomScoped.rows.map(row => row.Id), [bomEpisodeId],
    'FEFF remains a nonempty CLR series key');
  for (const [number, seriesKey] of [[501, 'series\0'], [502, 'series\u00010'], [503, 'series\\u0000']]) {
    const controlledSeries = `12000000-0000-0000-0002-${String(number).padStart(12, '0')}`;
    const controlledSeason = `12000000-0000-0000-0004-${String(number).padStart(12, '0')}`;
    const controlledEpisode = `12000000-0000-0000-0003-${String(number).padStart(12, '0')}`;
    await database.insert('BaseItems', item(controlledSeries, 'Series', {
      PresentationUniqueKey: seriesKey, IsFolder: true,
    }));
    await database.insert('BaseItems', item(controlledSeason, 'Season', {
      ParentId: controlledSeries, SeriesId: controlledSeries, IsFolder: true, IndexNumber: 1,
      PresentationUniqueKey: `season-${number}`, SeriesPresentationUniqueKey: seriesKey,
    }));
    await database.insert('BaseItems', item(controlledEpisode, 'Episode', {
      ParentId: controlledSeason, SeasonId: controlledSeason, SeriesId: controlledSeries,
      ParentIndexNumber: 1, IndexNumber: 1, PresentationUniqueKey: `episode-${number}`,
      SeriesPresentationUniqueKey: seriesKey, Path: `Z:\\Shows\\${number}.mkv`, SortName: String(number),
    }));
    await database.insert('AncestorIds', { ItemId: controlledEpisode, ParentItemId: controlledSeason });
    const controlledPage = await queryPostgresSeriesEpisodePage(database, {
      mode: 'series', seriesKey, includeMissing: true, includeSpecials: true,
    });
    assert.deepEqual(controlledPage.rows.map(row => row.Id), [controlledEpisode],
      'a bound raw series key preserves NUL and does not match SOH0 or a literal JSON escape');
  }
  const nelUnscoped = await queryPostgresSeriesEpisodePage(database, {
    mode: 'series', seriesKey: '\u0085', includeMissing: true, includeSpecials: true,
  });
  assert.ok(nelUnscoped.rows.some(row => row.Id === regularId)
    && nelUnscoped.rows.some(row => row.Id === bomEpisodeId),
  'NEL is an empty CLR series key and does not impose a series filter');

  for (const data of ['bad{', 'false', '{"AirsAfterSeasonNumber":[]}',
    `{"AirsBeforeEpisodeNumber":${'9'.repeat(10000)}}`]) {
    await database.update('BaseItems', { Id: specialId }, { Data: data });
    const safe = await queryPostgresSeriesEpisodePage(database, {
      mode: 'series', seriesKey: 'bounded-series', includeMissing: true, includeSpecials: true,
    });
    assert.ok(safe.rows.some(row => row.Id === specialId),
      `arbitrary BaseItems.Data must not abort series Episodes: ${data.slice(0, 40)}`);
  }
});
