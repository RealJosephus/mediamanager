import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lowerInvariant } from '../../src/core/identity.js';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import {
  buildPostgresItemPageQuery,
  queryPostgresItemPage,
  supportsPostgresItemQuery,
} from '../../src/database/postgres-item-query.js';
import {
  postgresCleanValueFunctionName,
  postgresInvariantLowerFunctionName,
  postgresNativePathKeyFunctionName,
  postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresParentalRatingScoreFunctionName,
  postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName,
} from '../../src/database/postgres-runtime-schema.js';
import { nativePathWithin } from '../../src/library/native-path.js';
import { queryPostgresFolderStats } from '../../src/library/postgres-library-query.js';
import { queryPostgresNextUpPage } from '../../src/library/postgres-next-up-query.js';
import { idKey } from '../../src/library/records.js';
import { clrWhitespaceCharacters } from '../../src/metadata/whitespace.js';
import { createPostgresTestDatabase } from './postgres-fixture.js';

const database = {
  dialect: 'postgres',
  schemaName: 'media',
};

test('PostgreSQL aggregate counts reject unsafe Int64 conversion', async () => {
  const unsafe = '9007199254740993';
  const folderDatabase = {
    dialect: 'postgres', schemaName: 'media',
    client: { query: async () => ({ rows: [{
      Id: '10000000-0000-0000-0000-000000000001',
      RecursiveItemCount: unsafe,
      PlayedItemCount: '0',
    }] }) },
  };
  await assert.rejects(queryPostgresFolderStats(folderDatabase,
    ['10000000-0000-0000-0000-000000000001'], '10000000-0000-0000-0000-000000000002'),
  /invalid folder recursive-item count/u);

  let rows = [{ NextId: null, TotalRecordCount: unsafe }];
  const nextUpDatabase = {
    dialect: 'postgres', schemaName: 'media',
    client: { query: async () => ({ rows }) },
    rows: async () => [],
  };
  const request = {
    seriesKeys: ['series-key'],
    userId: '10000000-0000-0000-0000-000000000002',
  };
  await assert.rejects(queryPostgresNextUpPage(nextUpDatabase, request), /invalid Next Up count/u);
  rows = [{
    NextId: nativeTextBytes('10000000-0000-0000-0000-000000000003'),
    LastId: null,
    PlayedVersionId: null,
    Ordinal: unsafe,
    TotalRecordCount: '1',
  }];
  await assert.rejects(queryPostgresNextUpPage(nextUpDatabase, request), /invalid Next Up ordinal/u);
});

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, Type, values = {}) => ({
  ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`,
  Name: Type, CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(),
  PresentationUniqueKey: Id, Data: '{}', ...values,
});

test('PostgreSQL item query keeps relational filters, ordering, counting and paging in SQL', () => {
  const plan = buildPostgresItemPageQuery(database, {
    includeitemtypes: ['Movie', 'Episode'],
    mediatypes: ['Video'],
    genres: ['Science Fiction'],
    tags: ['Featured'],
    searchterm: "Director's cut",
    mincommunityrating: 7.5,
    sortby: ['ProductionYear', 'SortName'],
    sortorder: ['Descending', 'Ascending'],
    startindex: 40,
    limit: 20,
  }, {
    scope: { ancestorId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  });

  assert.match(plan.text, /FROM "media"\."BaseItems" i/u);
  assert.match(plan.text, /EXISTS \(SELECT 1 FROM "media"\."AncestorIds"/u);
  assert.match(plan.text, /JOIN "media"\."ItemValues"/u);
  assert.match(plan.text, /total AS \(SELECT count\(\*\)::bigint AS "TotalRecordCount" FROM ordered\)/u);
  assert.match(plan.text, /LEFT JOIN page ON TRUE/u, 'an empty page still returns its SQL count');
  assert.match(plan.text, /ORDER BY[\s\S]*"ProductionYear" DESC NULLS LAST[\s\S]*"SortName" ASC NULLS FIRST[\s\S]*i\."Id" ASC/u);
  assert.match(plan.text, /page AS \([^)]*LIMIT \$\d+ OFFSET \$\d+\)/u);
  assert.equal(plan.text.includes("Director's cut"), false, 'request data is never interpolated into SQL');
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextBytes("%director's cut%"))));
  assert.equal(plan.startIndex, 40);
  assert.equal(plan.limit, 20);
});

test('PostgreSQL item query uses EXISTS relations for provider and per-user state filters', () => {
  const plan = buildPostgresItemPageQuery(database, {
    hasimdbid: true,
    hastmdbid: false,
    isfavorite: true,
    likes: false,
    isresumable: true,
    sortby: ['DatePlayed'],
    sortorder: ['Descending'],
    limit: 5,
  }, {
    userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    scope: { topParentIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc'] },
  });

  assert.match(plan.text, /"BaseItemProviders"/u);
  assert.match(plan.text, /NOT EXISTS \(SELECT 1 FROM "media"\."BaseItemProviders"/u);
  assert.match(plan.text, new RegExp(`"media"\\."${postgresOrdinalIgnoreCaseKeyFunctionName}"\\(p\\."ProviderId"\\)`, 'u'));
  assert.doesNotMatch(plan.text, /lower\(p\."ProviderId"\)/u);
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextOrdinalIgnoreCaseKey('imdb'))));
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextOrdinalIgnoreCaseKey('tmdb'))));
  assert.match(plan.text, /"UserData"/u);
  assert.match(plan.text, /"PlaybackPositionTicks" > 0/u);
  assert.match(plan.text, /array_agg\(u\."LastPlayedDate" ORDER BY u\."LastPlayedDate" DESC NULLS LAST\)/u);
  assert.ok(plan.values.filter(value => value === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').length >= 2);
});

test('PostgreSQL item query accepts relationalized client filters and rejects unknown semantics', () => {
  assert.equal(supportsPostgresItemQuery({ personids: ['a'] }), true);
  assert.equal(supportsPostgresItemQuery({ isfavorite: true }), false);
  assert.equal(supportsPostgresItemQuery({ isfavorite: true }, { userId: 'user' }), true);
  assert.equal(supportsPostgresItemQuery({ futurefilter: true }), false);
  assert.throws(() => buildPostgresItemPageQuery(database, { futurefilter: true }), /unsupported repository semantics/u);
  assert.throws(() => buildPostgresItemPageQuery(database, { limit: Number.MAX_SAFE_INTEGER + 1 }), /pagination/u);
  assert.throws(() => buildPostgresItemPageQuery(database, { limit: -1 }, { resumableMode: 'memory' }), /pagination/u);
});

test('PostgreSQL item query applies played-folder virtual episode exclusions before paging', () => {
  const hiddenMissing = buildPostgresItemPageQuery(database, {
    includeitemtypes: ['Episode'],
    startindex: 10,
    limit: 5,
  }, {
    playedFolderScope: {
      played: true,
      displayMissingEpisodes: false,
      now: '2026-10-09 12:00:00',
    },
  });
  assert.match(hiddenMissing.text, /NOT \(i\."IsVirtualItem" IS TRUE AND TRUE\)/u);
  assert.match(hiddenMissing.text,
    /total AS \(SELECT count\(\*\)::bigint AS "TotalRecordCount" FROM ordered\)/u);

  const futureEpisodes = buildPostgresItemPageQuery(database, {}, {
    playedFolderScope: {
      played: true,
      displayMissingEpisodes: true,
      now: '2026-10-09 12:00:00',
    },
  });
  assert.match(futureEpisodes.text,
    /NOT \(i\."IsVirtualItem" IS TRUE AND \(substring\(.*?i\."Type"\) from '\[\^\.\]\+\$'\) = 'Episode'[\s\S]*i\."PremiereDate" > \$\d+\)\)/u);
  assert.ok(futureEpisodes.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextBytes('2026-10-09 12:00:00'))));

  const unplayed = buildPostgresItemPageQuery(database, {}, {
    playedFolderScope: {
      played: false,
      displayMissingEpisodes: false,
    },
  });
  assert.doesNotMatch(unplayed.text, /played-folder|IsVirtualItem" IS TRUE AND TRUE/u);
});

test('PostgreSQL item query groups, permission-filters and counts before paging', () => {
  const plan = buildPostgresItemPageQuery(database, {
    includeitemtypes: ['Movie'],
    isplayed: false,
    limit: 0,
  }, {
    userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    groupByPresentationKey: true,
    visibility: {
      topParentIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
      blockedTags: ['Blocked'],
      allowedTags: ['Family'],
      maxRating: 13,
      maxSubRating: 0,
      blockUnratedTypes: ['Movie'],
    },
  });
  assert.match(plan.text, /PARTITION BY "PresentationUniqueKey"/u);
  assert.match(plan.text, /permission_ancestor/u);
  assert.match(plan.text, /"InheritedParentalRatingValue"/u);
  assert.match(plan.text, /"UnratedType" = ANY\([^)]*\)\) IS NOT TRUE/u,
    'nullable UnratedType must not be rejected by SQL three-valued logic');
  assert.match(plan.text, /LIMIT \$\d+/u);
});

test('PostgreSQL related-name unrated visibility is NULL-safe', () => {
  const plan = buildPostgresItemPageQuery(database, { includeitemtypes: ['Person'] }, {
    nameAccessTypes: ['Person'],
    requireRelatedNameAccess: true,
    visibility: {
      topParentIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
      blockUnratedTypes: ['Movie'],
    },
  });
  assert.match(plan.text,
    /access_media\."UnratedType" = ANY\([^)]*\)\) IS NOT TRUE/u);
});

test('PostgreSQL item query composes stable BoxSet display and request ordering in SQL', () => {
  const plan = buildPostgresItemPageQuery(database, {
    isplayed: true,
    sortby: ['Name'],
    sortorder: ['Descending'],
    startindex: 1,
    limit: 3,
  }, {
    userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    resumableMode: 'memory',
    scope: { parentOrLinkedId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    memoryPresort: 'PlayCount',
    memorySourceOrder: 'stored-sort-name',
    memoryFolderPlayback: true,
  });

  assert.match(plan.text, /memory_leaf/u, 'folder played state is evaluated relationally before paging');
  const requestOrder = plan.text.indexOf('"media"."mm_ordinal_ignore_case_key"(i."Name") DESC');
  const displayOrder = plan.text.indexOf('max(memory_sort_data."PlayCount")');
  const sourceOrder = plan.text.indexOf('i."SortName" ASC NULLS FIRST');
  assert.ok(requestOrder >= 0 && displayOrder > requestOrder && sourceOrder > displayOrder);

  const ignored = buildPostgresItemPageQuery(database, { sortby: ['IsPlayed'] }, {
    userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    resumableMode: 'memory',
    memoryPresort: 'IsPlayed',
    memorySourceOrder: 'stored-sort-name',
  });
  assert.match(ignored.text, /ORDER BY i\."SortName" ASC NULLS FIRST, i\."Id" ASC/u);
});

test('PostgreSQL memory BoxSet roots use normalized native path containment with segment boundaries', () => {
  const plan = buildPostgresItemPageQuery(database, { ids: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }, {
    resumableMode: 'memory',
    collapseMode: 'memory',
    collapseTypes: ['Movie'],
    collapseCollectionPath: 'Z:\\MÉDIA\\data\\draft\\..\\collections',
  });

  const nativePathCall = `"media"."${postgresNativePathKeyFunctionName}"`;
  assert.ok(plan.text.split(nativePathCall).length > 3,
    'both the collections target and candidate physical root use the frozen native key');
  assert.match(plan.text, /octet_length\([\s\S]*decode\('005c',\s*'hex'\)/u,
    'ancestor matching appends the platform separator before testing the prefix');
  assert.doesNotMatch(plan.text,
    /replace\(lower\(COALESCE\(collapse_root\."Path", ''\)\), chr\(92\), '\/'\)/u,
    'locale lowercasing and slash replacement cannot stand in for native normalization');
});

test('PostgreSQL memory name, text-sort, rating, and visibility keys use frozen invariant semantics', () => {
  const plan = buildPostgresItemPageQuery(database, {
    namestartswith: '\u00C9',
    namestartswithorgreater: '\u0130',
    namelessthan: '\u1E9E',
    sortby: ['Album', 'AlbumArtist', 'Artist', 'SortName', 'Name', 'SeriesSortName', 'OfficialRating'],
  }, {
    resumableMode: 'memory',
    memorySortConfiguration: { MetadataCountryCode: 'KZ' },
    visibility: {
      blockedTags: ['Rock'],
      maxRating: 12,
      maxSubRating: 0,
      boxSetChildRatingMode: 'memory',
      ratingContext: { defaultCountry: 'KZ', folders: [] },
    },
  });

  const invariantCall = `"media"."${postgresInvariantLowerFunctionName}"`;
  const cleanCall = `"media"."${postgresCleanValueFunctionName}"`;
  const ordinalCall = `"media"."${postgresOrdinalIgnoreCaseKeyFunctionName}"`;
  const safeInt32Call = `"media"."${postgresSafeInt32FunctionName}"`;
  const ratingCall = `"media"."${postgresParentalRatingScoreFunctionName}"`;
  assert.ok(plan.text.includes(cleanCall), 'direct memory tags use the frozen CleanValue key');
  assert.ok(plan.text.includes(invariantCall), 'all memory name boundaries share the invariant lower key');
  assert.ok(plan.text.split(ordinalCall).length > 10, 'text sorts, ratings, and visibility share the ordinal key');
  assert.ok(plan.text.includes(ratingCall), 'rating sorts and child visibility share the full resolver');
  assert.doesNotMatch(plan.text, /regexp_replace\([^\n]+\)::(?:integer|bigint|numeric)/u);
  assert.doesNotMatch(plan.text, /lower\(i\."Name"\) COLLATE "C"/u);
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextOrdinalIgnoreCaseKey('\u00C9'))));
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextOrdinalIgnoreCaseKey('\u0130'))));
  assert.ok(plan.values.some(value => Buffer.isBuffer(value) && value.equals(nativeTextOrdinalIgnoreCaseKey('\u1E9E'))));
  assert.ok(plan.values.includes('KZ'));

  const aired = buildPostgresItemPageQuery(database, { sortby: ['AiredEpisodeOrder'] }, {
    resumableMode: 'memory',
  });
  assert.ok(aired.text.includes(`"media"."${postgresSafeNativeItemDataFunctionName}"(incoming."Type", incoming."Data")`));
  assert.ok(aired.text.includes(`"media"."${postgresSafeNativeItemDataFunctionName}"(existing."Type", existing."Data")`));
  assert.ok(aired.text.includes(safeInt32Call));
  assert.doesNotMatch(aired.text, /substring\(COALESCE\([^\n]+"Data"[^\n]+\)::integer/u);
});

test('PostgreSQL memory genre and studio selectors use frozen ordinal-ignore-case keys', () => {
  const genreId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const studioId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const plan = buildPostgresItemPageQuery(database, {
    genres: ['\u00e9pop\u00e9e'],
    genreids: [genreId],
    studionames: ['\u00fcber'],
    studioids: [studioId],
  }, { resumableMode: 'memory' });

  const ordinalCall = `"media"."${postgresOrdinalIgnoreCaseKeyFunctionName}"`;
  assert.match(plan.text,
    new RegExp(`${ordinalCall.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\(memory_value\\."Name"\\)`, 'u'));
  assert.match(plan.text,
    new RegExp(`${ordinalCall.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\(selector\\."Name"\\)`, 'u'));
  assert.ok(plan.values.some(value => Array.isArray(value)
    && value.some(entry => Buffer.isBuffer(entry) && entry.equals(nativeTextOrdinalIgnoreCaseKey('\u00e9pop\u00e9e')))));
  assert.ok(plan.values.some(value => Array.isArray(value)
    && value.some(entry => Buffer.isBuffer(entry) && entry.equals(nativeTextOrdinalIgnoreCaseKey('\u00fcber')))));
  assert.doesNotMatch(plan.text,
    /translate\(COALESCE\(memory_value\."Name", ''\), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'/u);
  assert.ok(plan.values.includes(clrWhitespaceCharacters),
    'Genres use the fixed CLR trim set before exposing persisted pipe segments');
});

test('PostgreSQL provider candidates apply culture ordering and paging in the relational plan', () => {
  const firstId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const secondId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const plan = buildPostgresItemPageQuery(database, {
    ids: [secondId, firstId],
    startindex: 1,
    limit: 1,
  }, {
    searchScores: [
      { id: firstId, score: 100 },
      { id: secondId, score: 50 },
    ],
    searchCollation: { schema: 'pg_catalog', name: 'da-DK-x-icu' },
  });

  assert.equal(plan.startIndex, 1);
  assert.equal(plan.limit, 1);
  assert.match(plan.text, /search_scores\("Id", "Score"\) AS/u);
  assert.match(plan.text, /COALESCE\(\(SELECT search_score\."Score"[\s\S]+\), 0\) DESC/u);
  assert.match(plan.text, /COLLATE "pg_catalog"\."da-DK-x-icu" ASC NULLS FIRST/u);
  assert.match(plan.text, /page AS \(SELECT "Id", __ordinal FROM ordered ORDER BY __ordinal LIMIT \$\d+ OFFSET \$\d+\)/u);
  assert.doesNotMatch(plan.text, /array_position\(/u,
    'requested-id ordering must not replace provider score ordering');
  assert.ok(plan.values.some(value => Array.isArray(value) && value.includes(firstId.replaceAll('-', ''))));
  assert.ok(plan.values.some(value => Array.isArray(value) && value.includes(100) && value.includes(50)));
});

test('PostgreSQL repository search uses SQLite ASCII folding on both OriginalTitle operands', () => {
  const plan = buildPostgresItemPageQuery(database, {
    searchterm: '\u03a3I',
    limit: 10,
  });

  assert.deepEqual(plan.values.slice(0, 2).map(value => value.toString('utf8')), ['%\u03c3i%', '%\u03a3i%'],
    'CleanName uses its normalized key while OriginalTitle keeps non-ASCII characters unchanged');
  assert.deepEqual(plan.values.slice(3, 5).map(value => value.toString('utf8')), ['\u03c3i', '\u03a3i'],
    'relevance ordering uses the same pair of normalization contracts');
});

test('PostgreSQL item query decodes only the selected page and preserves SQL order', async () => {
  const captured = [];
  const rows = [
    { Id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', Name: 'A' },
    { Id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', Name: 'B' },
  ];
  const mock = {
    dialect: 'postgres',
    schemaName: 'media',
    client: {
      async query(plan) {
        captured.push(plan);
        return { rows: [
          { Id: nativeTextBytes(rows[1].Id), TotalRecordCount: 17n },
          { Id: nativeTextBytes(rows[0].Id), TotalRecordCount: 17n },
        ] };
      },
    },
    async rows(name, options) {
      assert.equal(name, 'BaseItems');
      assert.deepEqual(options.whereIn.Id, [rows[1].Id, rows[0].Id]);
      return rows;
    },
  };

  const result = await queryPostgresItemPage(mock, { limit: 2, startindex: 4 });
  assert.equal(captured.length, 1);
  assert.deepEqual(result.rows, [rows[1], rows[0]]);
  assert.equal(result.total, 17);
  assert.equal(result.startIndex, 4);
});

test('real PostgreSQL provider presence uses ordinal-ignore-case without locale false positives', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_provider_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const matchingId = '20f00000-0000-0000-0000-000000000001';
  const localeFalsePositiveId = '20f00000-0000-0000-0000-000000000002';
  const absentId = '20f00000-0000-0000-0000-000000000003';
  await postgres.insert('BaseItems', item(matchingId, 'Movies.Movie', { SortName: 'a-match' }));
  await postgres.insert('BaseItems', item(localeFalsePositiveId, 'Movies.Movie', { SortName: 'b-locale' }));
  await postgres.insert('BaseItems', item(absentId, 'Movies.Movie', { SortName: 'c-absent' }));
  await postgres.insert('BaseItemProviders', {
    ItemId: matchingId, ProviderId: 'iMdB', ProviderValue: 'tt-match',
  });
  await postgres.insert('BaseItemProviders', {
    ItemId: localeFalsePositiveId, ProviderId: '\u0130mdb', ProviderValue: 'tt-wrong',
  });

  const providers = await postgres.rows('BaseItemProviders', { where: { ItemId: localeFalsePositiveId } });
  assert.equal(providers[0].ProviderId, '\u0130mdb', 'stored provider identity retains the dotted capital I');
  const keys = (await postgres.client.query(`SELECT
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"($1::bytea) AS mixed_key,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"($2::bytea) AS dotted_key,
    "${schema}"."${postgresOrdinalIgnoreCaseKeyFunctionName}"($3::bytea) AS plain_key`,
  ['iMdB', '\u0130mdb', 'imdb'].map(nativeTextBytes))).rows[0];
  assert.deepEqual(keys.mixed_key, nativeTextOrdinalIgnoreCaseKey('iMdB'));
  assert.deepEqual(keys.dotted_key, nativeTextOrdinalIgnoreCaseKey('\u0130mdb'));
  assert.deepEqual(keys.plain_key, nativeTextOrdinalIgnoreCaseKey('imdb'));
  assert.deepEqual(keys.mixed_key, keys.plain_key, 'ASCII provider casing shares one ordinal key');
  assert.notDeepEqual(keys.dotted_key, keys.plain_key, 'ordinal comparison keeps dotted I distinct on every database locale');

  const present = await queryPostgresItemPage(postgres, {
    ids: [matchingId, localeFalsePositiveId, absentId], hasimdbid: true, sortby: ['SortName'], limit: 10,
  });
  assert.deepEqual(present.rows.map(row => row.Id), [matchingId]);

  const absent = await queryPostgresItemPage(postgres, {
    ids: [matchingId, localeFalsePositiveId, absentId], hasimdbid: false, sortby: ['SortName'], limit: 10,
  });
  assert.deepEqual(absent.rows.map(row => row.Id), [localeFalsePositiveId, absentId]);
});

test('real PostgreSQL extra filters include direct, descendant, and linked-child owners before counting and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_extras_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const id = suffix => `20d00000-0000-0000-0000-${String(suffix).padStart(12, '0')}`;
  const directId = id(1);
  const descendantFolderId = id(2);
  const descendantOwnerId = id(3);
  const linkedFolderId = id(4);
  const negativeId = id(5);
  const alternatePrimaryId = id(6);
  const alternateId = id(7);
  await postgres.insert('BaseItems', item(directId, 'Movies.Movie', { SortName: 'a-direct' }));
  await postgres.insert('BaseItems', item(descendantFolderId, 'Folder', {
    SortName: 'b-descendant', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(descendantOwnerId, 'Movies.Movie', {
    SortName: 'descendant-owner', ParentId: descendantFolderId,
  }));
  await postgres.insert('AncestorIds', { ItemId: descendantOwnerId, ParentItemId: descendantFolderId });
  await postgres.insert('BaseItems', item(linkedFolderId, 'Collections.BoxSet', {
    SortName: 'c-linked', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(alternatePrimaryId, 'Movies.Movie', {
    SortName: 'd-alternate-primary',
  }));
  await postgres.insert('BaseItems', item(alternateId, 'Movies.Movie', {
    SortName: 'alternate-owner', PrimaryVersionId: alternatePrimaryId,
  }));
  await postgres.insert('BaseItems', item(negativeId, 'Movies.Movie', { SortName: 'e-negative' }));

  const filters = [
    ['hasspecialfeature', 1],
    ['hastrailer', 2],
    ['hasthemesong', 8],
    ['hasthemevideo', 9],
  ];
  for (const [index, [, extraType]] of filters.entries()) {
    for (const [ownerIndex, ownerId] of [directId, descendantOwnerId].entries()) {
      await postgres.insert('BaseItems', item(id(10 + index * 2 + ownerIndex), 'Movies.Movie', {
        SortName: `extra-${index}-${ownerIndex}`, OwnerId: ownerId, ExtraType: extraType,
      }));
    }
    const linkedOwnerId = id(30 + index);
    await postgres.insert('BaseItems', item(linkedOwnerId, 'Movies.Movie', {
      SortName: `linked-owner-${index}`,
    }));
    await postgres.insert('LinkedChildren', {
      ParentId: linkedFolderId, ChildId: linkedOwnerId, ChildType: index, SortOrder: index,
    });
    await postgres.insert('BaseItems', item(id(40 + index), 'Movies.Movie', {
      SortName: `linked-extra-${index}`, OwnerId: linkedOwnerId, ExtraType: extraType,
    }));
    await postgres.insert('BaseItems', item(id(50 + index), 'Movies.Movie', {
      SortName: `alternate-extra-${index}`, OwnerId: alternateId, ExtraType: extraType,
    }));
  }

  const candidateIds = [directId, descendantFolderId, linkedFolderId, alternatePrimaryId, negativeId];
  for (const [filter] of filters) {
    const matching = await queryPostgresItemPage(postgres, {
      ids: candidateIds, [filter]: true, sortby: ['SortName'], limit: 10,
    });
    assert.equal(matching.total, 4, `${filter}=true count`);
    assert.deepEqual(matching.rows.map(row => row.Id),
      [directId, descendantFolderId, linkedFolderId, alternatePrimaryId],
      `${filter}=true relation and alternate-owner paths`);

    const secondPage = await queryPostgresItemPage(postgres, {
      ids: candidateIds, [filter]: true, sortby: ['SortName'], startindex: 1, limit: 1,
    });
    assert.equal(secondPage.total, 4, `${filter}=true paged count`);
    assert.deepEqual(secondPage.rows.map(row => row.Id), [descendantFolderId],
      `${filter}=true stable second page`);

    const nonmatching = await queryPostgresItemPage(postgres, {
      ids: candidateIds, [filter]: false, sortby: ['SortName'], limit: 10,
    });
    assert.equal(nonmatching.total, 1, `${filter}=false count`);
    assert.deepEqual(nonmatching.rows.map(row => row.Id), [negativeId],
      `${filter}=false rejects every positive relation path`);
  }
});

test('real PostgreSQL SeriesStatus patterns preserve literal escaping, case, counting, and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_status_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const id = suffix => `20c00000-0000-0000-0000-${String(suffix).padStart(12, '0')}`;
  const continuingId = id(1);
  const endedId = id(2);
  const lowerCaseId = id(3);
  const missingId = id(4);
  const literalId = id(5);
  const wildcardLookalikeId = id(6);
  for (const [Id, SortName, Data] of [
    [continuingId, 'a-continuing', '{"Status":"Continuing"}'],
    [endedId, 'b-ended', '{"Status":"Ended"}'],
    [lowerCaseId, 'c-lowercase', '{"Status":"continuing"}'],
    [missingId, 'd-missing', '{"Note":"Continuing elsewhere"}'],
    [literalId, 'e-literal', '{"Status":"100%_Done"}'],
    [wildcardLookalikeId, 'f-lookalike', '{"Status":"100XXDone"}'],
  ]) {
    await postgres.insert('BaseItems', item(Id, 'TV.Series', { SortName, Data }));
  }
  const ids = [continuingId, endedId, lowerCaseId, missingId, literalId, wildcardLookalikeId];

  const single = await queryPostgresItemPage(postgres, {
    ids, seriesstatuses: ['Continuing'], sortby: ['SortName'], limit: 10,
  });
  assert.equal(single.total, 2);
  assert.deepEqual(single.rows.map(row => row.Id), [continuingId, missingId],
    'native Data.Contains matches ordinal text anywhere, including after NUL');

  const multiPage = await queryPostgresItemPage(postgres, {
    ids, seriesstatuses: ['Continuing', 'Ended'], sortby: ['SortName'], startindex: 1, limit: 1,
  });
  assert.equal(multiPage.total, 3, 'all status patterns are counted before paging');
  assert.deepEqual(multiPage.rows.map(row => row.Id), [endedId]);
  assert.doesNotMatch(multiPage.plan.text, /LIKE ANY\([^\n]*ESCAPE/u,
    'PostgreSQL does not permit an ESCAPE clause after LIKE ANY');
  assert.match(multiPage.plan.text, /position\(series_status_pattern\."Pattern" IN i\."Data"\) > 0/u);

  const absent = await queryPostgresItemPage(postgres, {
    ids, seriesstatuses: ['Unreleased'], limit: 10,
  });
  assert.equal(absent.total, 0);
  assert.deepEqual(absent.rows, []);

  const literal = await queryPostgresItemPage(postgres, {
    ids, seriesstatuses: ['100%_Done'], limit: 10,
  });
  assert.equal(literal.total, 1, 'percent and underscore remain literal status characters');
  assert.deepEqual(literal.rows.map(row => row.Id), [literalId]);
});

test('PostgreSQL child source groups reject malformed scopes before sending SQL', () => {
  for (const sourceChildren of ['all', [null], [{ key: 1, parentIds: [] }],
    [{ key: 'source', parentIds: 'all' }], [{ key: 'source', parentIds: [null] }]]) {
    assert.throws(() => buildPostgresItemPageQuery(database, {}, {
      scope: { sourceChildren }, resumableMode: 'memory',
    }), /Invalid child source groups/u);
  }
});

test('real PostgreSQL child source groups deduplicate within each source and preserve cross-source order and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_child_sources_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });
  const id = value => `20d00000-0000-0000-0000-${String(value).padStart(12, '0')}`;
  const [firstParent, secondParent, alpha, beta, zulu] = [1, 2, 3, 4, 5].map(id);
  for (const parent of [firstParent, secondParent]) {
    await postgres.insert('BaseItems', item(parent, 'Folder', { IsFolder: true }));
  }
  await postgres.insert('BaseItems', item(alpha, 'Movies.Movie', { SortName: 'a', ParentId: secondParent }));
  await postgres.insert('BaseItems', item(beta, 'Movies.Movie', { SortName: 'b' }));
  await postgres.insert('BaseItems', item(zulu, 'Movies.Movie', { SortName: 'z', ParentId: firstParent }));
  for (const parent of [firstParent, secondParent]) {
    await postgres.insert('LinkedChildren', { ParentId: parent, ChildId: beta, SortOrder: 0, ChildType: 0 });
  }
  // A direct child also linked through the same source must not multiply.
  await postgres.insert('LinkedChildren', { ParentId: firstParent, ChildId: alpha, SortOrder: 1, ChildType: 0 });
  const scope = { sourceChildren: [
    { key: firstParent, parentIds: [firstParent, firstParent.toUpperCase(), secondParent] },
    { key: secondParent, parentIds: [secondParent] },
  ] };
  const hydrated = [];
  const bounded = {
    dialect: postgres.dialect, schemaName: postgres.schemaName, client: postgres.client,
    rows: async (tableName, options) => {
      assert.equal(tableName, 'BaseItems');
      assert.deepEqual(Object.keys(options), ['whereIn']);
      assert.deepEqual(Object.keys(options.whereIn), ['Id']);
      hydrated.push(options.whereIn.Id);
      return postgres.rows(tableName, options);
    },
  };
  const options = { scope, resumableMode: 'memory', memorySourceOrder: 'stored-sort-name' };
  const first = await queryPostgresItemPage(bounded, { limit: 4 }, options);
  const last = await queryPostgresItemPage(bounded, { startindex: 4, limit: 4 }, options);
  assert.equal(first.total, 5);
  assert.equal(last.total, 5);
  assert.deepEqual(first.rows.map(row => row.Id), [alpha, beta, zulu, alpha]);
  assert.deepEqual(last.rows.map(row => row.Id), [beta]);
  assert.deepEqual(hydrated, [[alpha, beta, zulu, alpha], [beta]], 'only the requested pages are hydrated');
  const filtered = await queryPostgresItemPage(bounded, { excludeitemids: [beta], limit: 10 }, options);
  assert.equal(filtered.total, 3);
  assert.deepEqual(filtered.rows.map(row => row.Id), [alpha, zulu, alpha]);
  const empty = await queryPostgresItemPage(bounded, { limit: 10 }, {
    ...options, scope: { sourceChildren: [] },
  });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.rows, []);
  const secondOnly = id(6);
  await postgres.insert('BaseItems', item(secondOnly, 'Movies.Movie', { SortName: '0000-second-only', ParentId: secondParent }));
  const physicalSources = { scope: { sourceChildren: [{ key: firstParent, parentIds: [firstParent, secondParent] }] },
    resumableMode: 'memory', memorySourceOrder: 'stored-sort-name' };
  const boundaryPage = await queryPostgresItemPage(bounded, { startindex: 2, limit: 2 }, physicalSources);
  assert.equal(boundaryPage.total, 4);
  assert.deepEqual(boundaryPage.rows.map(row => row.Id), [zulu, secondOnly],
    'physical folders concatenate before pagination even when the second folder sorts earlier globally');
  assert.deepEqual(hydrated.at(-1), [zulu, secondOnly], 'only the cross-folder page is hydrated');
});

test('real PostgreSQL date boundaries compare native short and ISO strings without losing 100ns precision', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_date_ticks_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });
  const dates = ['2026-10-01 00:00:00', '2026-10-01T00:00:00.0000000Z',
    '2026-10-01 00:00:00.0000001', '2026-10-01T00:00:00.0000002Z', null];
  const ids = dates.map((_, index) => `20d10000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`);
  for (const [index, date] of dates.entries()) {
    await postgres.insert('BaseItems', item(ids[index], 'Movies.Movie', {
      SortName: String(index), PremiereDate: date, DateLastSaved: date ?? dates[0],
    }));
  }
  for (const filter of ['minpremieredate', 'mindatelastsaved', 'mindatelastsavedforuser']) {
    const page = await queryPostgresItemPage(postgres, {
      ids, [filter]: '2026-10-01T00:00:00.0000001Z', sortby: ['SortName'], limit: 10,
    });
    assert.equal(page.total, 2, filter);
    assert.deepEqual(page.rows.map(row => row.Id), ids.slice(2, 4), filter);
  }
  const maximum = await queryPostgresItemPage(postgres, {
    ids, maxpremieredate: '2026-10-01T00:00:00.0000001Z', sortby: ['SortName'], limit: 10,
  });
  assert.equal(maximum.total, 3);
  assert.deepEqual(maximum.rows.map(row => row.Id), ids.slice(0, 3));
  const zero = await queryPostgresItemPage(postgres, {
    ids, minpremieredate: '2026-10-01T00:00:00.0000000Z',
    maxpremieredate: '2026-10-01T00:00:00.0000000Z', sortby: ['SortName'], limit: 10,
  });
  assert.deepEqual(zero.rows.map(row => row.Id), ids.slice(0, 2));
});

test('real PostgreSQL repository parental-rating branches honor native HasParentalRating precedence', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_rating_branch_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });
  const ids = [1, 2, 3].map(value => `20d20000-0000-0000-0000-${String(value).padStart(12, '0')}`);
  for (const [index, score] of [null, 5, 10].entries()) {
    await postgres.insert('BaseItems', item(ids[index], 'Movies.Movie', {
      SortName: String(index), InheritedParentalRatingValue: score, UnratedType: 'Movie',
    }));
  }
  const query = { ids, sortby: ['SortName'], limit: 10 };
  const blocked = { visibility: { blockUnratedTypes: ['Movie'] } };
  const hasTrue = await queryPostgresItemPage(postgres, { ...query, hasparentalrating: true }, blocked);
  assert.deepEqual(hasTrue.rows.map(row => row.Id), ids, 'Has=true bypasses the BlockUnrated branch');
  const hasFalse = await queryPostgresItemPage(postgres, { ...query, hasparentalrating: false }, blocked);
  assert.deepEqual(hasFalse.rows.map(row => row.Id), ids.slice(1), 'BlockUnrated overrides Has=false');
  const noPolicy = await queryPostgresItemPage(postgres, { ...query, hasparentalrating: false });
  assert.deepEqual(noPolicy.rows.map(row => row.Id), [ids[0]]);
  const ranged = await queryPostgresItemPage(postgres, {
    ...query, hasparentalrating: false, minparentalrating: { score: 5 },
  });
  assert.deepEqual(ranged.rows.map(row => row.Id), ids, 'an explicit range takes precedence over Has=false');
});

test('real PostgreSQL played ordering derives folder state before counting and paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const postgres = await createPostgresTestDatabase(t, 'played_order');
  const userId = '20df0000-0000-0000-0000-000000000001';
  await postgres.insert('Users', { ...blank('Users'), Id: userId, Username: 'played-order-user' });
  const ids = [1, 2, 3, 4].map(value => `20df0000-0000-0000-0001-${String(value).padStart(12, '0')}`);
  for (const [index, id] of ids.entries()) {
    await postgres.insert('BaseItems', item(id, index === 3 ? 'Movies.BoxSet' : 'TV.Series', {
      IsFolder: true, Name: String(index), CleanName: String(index), SortName: String(index),
    }));
    // These stored flags deliberately contradict the descendants. Folder
    // playback is derived even when an old imported folder row has UserData.
    await postgres.insert('UserData', {
      ...blank('UserData'), ItemId: id, UserId: userId, CustomDataKey: id, Played: index === 1,
    });
  }
  const leaves = [[0, true], [1, true], [1, false], [3, true]];
  for (const [index, [parent, played]] of leaves.entries()) {
    const id = `20df0000-0000-0000-0002-${String(index).padStart(12, '0')}`;
    await postgres.insert('BaseItems', item(id, parent === 3 ? 'Movies.Movie' : 'TV.Episode', {
      ParentId: parent === 3 ? null : ids[parent], MediaType: 'Video',
    }));
    if (parent === 3) await postgres.insert('LinkedChildren', { ParentId: ids[parent], ChildId: id, ChildType: 0, SortOrder: 0 });
    else await postgres.insert('AncestorIds', { ItemId: id, ParentItemId: ids[parent] });
    if (played) await postgres.insert('UserData', {
      ...blank('UserData'), ItemId: id, UserId: userId, CustomDataKey: id, Played: true,
    });
  }
  const playedFirst = [ids[0], ids[2], ids[3], ids[1]], unplayedFirst = [ids[1], ids[0], ids[2], ids[3]];
  for (const [sort, direction, expected] of [
    ['IsPlayed', 'Ascending', unplayedFirst], ['IsPlayed', 'Descending', playedFirst],
    ['IsUnplayed', 'Ascending', playedFirst], ['IsUnplayed', 'Descending', unplayedFirst],
  ]) {
    const actual = [];
    for (const startindex of [0, 2]) {
      const page = await queryPostgresItemPage(postgres, {
        ids, sortby: [sort, 'Name'], sortorder: [direction, 'Ascending'], startindex, limit: 2,
      }, { userId });
      assert.equal(page.total, 4);
      actual.push(...page.rows.map(row => row.Id));
    }
    assert.deepEqual(actual, expected, `${sort} ${direction}`);
  }
  for (const [isplayed, expected] of [[true, ids.filter((_, index) => index !== 1)], [false, [ids[1]]]]) {
    const page = await queryPostgresItemPage(postgres, { ids, isplayed, sortby: ['Name'], limit: 4 }, { userId });
    assert.equal(page.total, expected.length);
    assert.deepEqual(page.rows.map(row => row.Id), expected);
  }
});

test('real PostgreSQL version families unify D-format ids with N-format primary ids', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_version_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const userId = '20e00000-0000-0000-0000-000000000001';
  const folderId = '20e00000-0000-0000-0000-000000000002';
  const primaryId = '20e00000-0000-0000-0000-000000000003';
  const alternateId = '20e00000-0000-0000-0000-000000000004';
  const storedUserId = userId.replaceAll('-', '');
  const storedFolderId = folderId.replaceAll('-', '');
  await postgres.insert('Users', { ...blank('Users'), Id: storedUserId, Username: 'version-family-user' });
  await postgres.insert('BaseItems', item(storedFolderId, 'Folder', {
    IsFolder: true, MediaType: 'Unknown', SortName: 'folder',
  }));
  await postgres.insert('BaseItems', item(primaryId, 'Movies.Movie', {
    ParentId: storedFolderId, TopParentId: storedFolderId, MediaType: 'Video', SortName: 'primary',
  }));
  await postgres.insert('BaseItems', item(alternateId, 'Movies.Movie', {
    TopParentId: storedFolderId, MediaType: 'Video', SortName: 'alternate',
    PrimaryVersionId: primaryId.replaceAll('-', ''), Width: 4000,
  }));
  await postgres.insert('UserData', {
    ...blank('UserData'), ItemId: primaryId, UserId: storedUserId, CustomDataKey: primaryId,
    PlaybackPositionTicks: 100n, LastPlayedDate: '2026-10-01 00:00:00',
  });
  await postgres.insert('UserData', {
    ...blank('UserData'), ItemId: alternateId, UserId: storedUserId, CustomDataKey: alternateId,
    Played: true, PlaybackPositionTicks: 200n, LastPlayedDate: '2026-10-02 00:00:00',
  });

  const externallyAddressed = await queryPostgresItemPage(postgres, {
    ids: [folderId], limit: 1,
  });
  assert.deepEqual(externallyAddressed.rows.map(row => row.Id), [storedFolderId],
    'a D-format API id resolves an N-format stored BaseItems id');
  const scopedChildren = await queryPostgresItemPage(postgres, { limit: 10 }, {
    scope: { parentId: folderId },
  });
  assert.deepEqual(scopedChildren.rows.map(row => row.Id), [primaryId],
    'a D-format API parent id resolves an N-format stored ParentId');

  const played = await queryPostgresItemPage(postgres, {
    ids: [primaryId], isplayed: true, limit: 10,
  }, {
    userId, resumableMode: 'memory', memoryFolderPlayback: true,
  });
  assert.deepEqual(played.rows.map(row => row.Id), [primaryId],
    'memory played state follows an N-format PrimaryVersionId to its D-format primary');

  const repositoryPlayed = await queryPostgresItemPage(postgres, {
    ids: [primaryId], isplayed: true, is4k: true, limit: 10,
  }, { userId });
  assert.deepEqual(repositoryPlayed.rows.map(row => row.Id), [primaryId],
    'repository version predicates follow an N-format PrimaryVersionId to its D-format primary');

  const resumable = await queryPostgresItemPage(postgres, {
    ids: [primaryId, alternateId], isresumable: true, limit: 10,
  }, { userId, includeAlternateVersions: true });
  assert.deepEqual(resumable.rows.map(row => row.Id), [alternateId],
    'repository resume ranking chooses one winner across mixed GUID spellings');

  const stats = (await queryPostgresFolderStats(postgres, [folderId], userId)).get(idKey(folderId));
  assert.deepEqual(stats, {
    RecursiveItemCount: 1,
    UnplayedItemCount: 0,
    Played: true,
    PlayedPercentage: 100,
  }, 'folder stats inherit played state from the mixed-format alternate family');
});

test('real PostgreSQL preserves non-ASCII memory paging, rating scores, and dynamic rating visibility', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_invariant_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const lowerNameId = '21000000-0000-0000-0000-000000000001';
  const upperNameId = '21000000-0000-0000-0000-000000000002';
  await postgres.insert('BaseItems', item(lowerNameId, 'Audio.Audio', {
    Name: '\u00E9clair', CleanName: '\u00E9clair', SortName: 'stable-name',
  }));
  await postgres.insert('BaseItems', item(upperNameId, 'Audio.Audio', {
    Name: '\u00C9CLAIR', CleanName: '\u00E9clair', SortName: 'stable-name',
  }));

  const firstNamePage = await queryPostgresItemPage(postgres, {
    ids: [upperNameId, lowerNameId], sortby: ['Name'], startindex: 0, limit: 1,
  }, { resumableMode: 'memory' });
  const secondNamePage = await queryPostgresItemPage(postgres, {
    ids: [upperNameId, lowerNameId], sortby: ['Name'], startindex: 1, limit: 1,
  }, { resumableMode: 'memory' });
  assert.deepEqual(firstNamePage.rows.map(row => row.Id), [lowerNameId]);
  assert.deepEqual(secondNamePage.rows.map(row => row.Id), [upperNameId]);

  const nameFilter = await queryPostgresItemPage(postgres, {
    ids: [upperNameId, lowerNameId], namestartswith: '\u00E9', sortby: ['Name'], limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(nameFilter.rows.map(row => row.Id), [lowerNameId, upperNameId]);

  const bomNameId = '21000000-0000-0000-0000-000000000003';
  const nullStoredSortId = '21000000-0000-0000-0000-000000000004';
  await postgres.insert('BaseItems', item(bomNameId, 'Audio.Audio', {
    Name: '\ufeffAlpha', CleanName: '\ufeffalpha', SortName: '\ufeffalpha',
  }));
  await postgres.insert('BaseItems', item(nullStoredSortId, 'Audio.Audio', {
    Name: 'Null stored sort', CleanName: 'null stored sort', SortName: null,
  }));
  const memorySpacePrefix = await queryPostgresItemPage(postgres, {
    ids: [upperNameId, lowerNameId], namestartswith: ' ', limit: 10,
  }, { resumableMode: 'memory' });
  assert.equal(memorySpacePrefix.total, 2,
    'Folder.ApplyPostFilters ignores CLR-whitespace-only name boundaries');
  const memoryBomPrefix = await queryPostgresItemPage(postgres, {
    ids: [bomNameId, lowerNameId], namestartswith: '\ufeff', limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(memoryBomPrefix.rows.map(row => row.Id), [bomNameId],
    'memory name filters do not apply ECMAScript trim before comparing the materialized SortName');
  const repositoryNelPrefix = await queryPostgresItemPage(postgres, {
    ids: [upperNameId, lowerNameId], namestartswith: '\u0085', limit: 10,
  });
  assert.equal(repositoryNelPrefix.total, 2,
    'repository name filters ignore a CLR-whitespace-only boundary');
  const repositoryBomPrefix = await queryPostgresItemPage(postgres, {
    ids: [bomNameId, lowerNameId], namestartswith: '\ufeff', limit: 10,
  });
  assert.deepEqual(repositoryBomPrefix.rows.map(row => row.Id), [bomNameId],
    'FEFF is not CLR whitespace and remains an active repository name boundary');
  const repositoryNullSort = await queryPostgresItemPage(postgres, {
    ids: [nullStoredSortId, lowerNameId], namelessthan: 'z', limit: 10,
  });
  assert.deepEqual(repositoryNullSort.rows.map(row => row.Id), [lowerNameId],
    'an active repository name boundary rejects a null persisted SortName');

  const plainSortId = '21000000-0000-0000-0000-000000000005';
  const punctuatedSortId = '21000000-0000-0000-0000-000000000006';
  const loneArticleId = '21000000-0000-0000-0000-000000000007';
  const nelPersonId = '21000000-0000-0000-0000-000000000008';
  const bomPersonId = '21000000-0000-0000-0000-000000000009';
  await postgres.insert('BaseItems', item(plainSortId, 'Movies.Movie', {
    Name: 'Alpha', SortName: 'stored-plain',
  }));
  await postgres.insert('BaseItems', item(punctuatedSortId, 'Movies.Movie', {
    Name: '.Alpha.', SortName: 'stored-punctuated',
  }));
  await postgres.insert('BaseItems', item(loneArticleId, 'Movies.Movie', {
    Name: 'the', SortName: 'stored-article',
  }));
  await postgres.insert('BaseItems', item(nelPersonId, 'Person', {
    Name: '\u0085Alpha', SortName: 'stored-nel-person', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(bomPersonId, 'Person', {
    Name: '\ufeffAlpha', SortName: 'stored-bom-person', IsFolder: true,
  }));
  const punctuationOrder = await queryPostgresItemPage(postgres, {
    ids: [plainSortId, punctuatedSortId], sortby: ['SortName'], limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(punctuationOrder.rows.map(row => row.Id), [punctuatedSortId, plainSortId],
    'replacement punctuation can intentionally leave leading and trailing spaces in the native sort key');
  const loneArticle = await queryPostgresItemPage(postgres, {
    ids: [loneArticleId, plainSortId], namestartswith: 'the', limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(loneArticle.rows.map(row => row.Id), [loneArticleId],
    'a sort key equal to a configured removable word is preserved');
  const nelPerson = await queryPostgresItemPage(postgres, {
    ids: [nelPersonId, bomPersonId], namestartswith: 'alpha', limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(nelPerson.rows.map(row => row.Id), [nelPersonId],
    'Person sort names use CLR TrimStart, including U+0085');
  const bomPerson = await queryPostgresItemPage(postgres, {
    ids: [nelPersonId, bomPersonId], namestartswith: '\ufeff', limit: 10,
  }, { resumableMode: 'memory' });
  assert.deepEqual(bomPerson.rows.map(row => row.Id), [bomPersonId],
    'Person sort names retain FEFF because it is not CLR whitespace');

  const knownRatingId = '21000000-0000-0000-0000-000000000011';
  const unknownRatingId = '21000000-0000-0000-0000-000000000012';
  await postgres.insert('BaseItems', item(knownRatingId, 'Movies.Movie', {
    Name: 'Known KZ rating', SortName: 'stable-rating', OfficialRating: '\u0411\u0410',
  }));
  await postgres.insert('BaseItems', item(unknownRatingId, 'Movies.Movie', {
    Name: 'Unknown KZ rating', SortName: 'stable-rating', OfficialRating: 'unmapped',
  }));
  const ratingPage = await queryPostgresItemPage(postgres, {
    ids: [knownRatingId, unknownRatingId], sortby: ['OfficialRating'], limit: 10,
  }, {
    resumableMode: 'memory', memorySortConfiguration: { MetadataCountryCode: 'KZ' },
  });
  assert.deepEqual(ratingPage.rows.map(row => row.Id), [unknownRatingId, knownRatingId],
    '\u0411\u0410 retains its KZ score instead of falling back to zero');

  const oversizedRatingId = '21000000-0000-0000-0000-000000000019';
  await postgres.insert('BaseItems', item(oversizedRatingId, 'Movies.Movie', {
    Name: 'Oversized numeric rating', SortName: 'oversized-rating', OfficialRating: '9'.repeat(10000),
  }));
  const oversizedRating = await queryPostgresItemPage(postgres, {
    ids: [oversizedRatingId], sortby: ['OfficialRating'], limit: 10,
  }, { resumableMode: 'memory', memorySortConfiguration: { MetadataCountryCode: 'US' } });
  assert.deepEqual(oversizedRating.rows.map(row => row.Id), [oversizedRatingId],
    'an oversized numeric rating falls back to an unknown score instead of aborting');

  const tabPrefixId = '21000000-0000-0000-0000-000000000013';
  const nbspPrefixId = '21000000-0000-0000-0000-000000000014';
  const tabTrimId = '21000000-0000-0000-0000-000000000015';
  const nbspTrimId = '21000000-0000-0000-0000-000000000016';
  const nelTrimId = '21000000-0000-0000-0000-000000000017';
  const byteOrderMarkId = '21000000-0000-0000-0000-000000000018';
  await postgres.insert('BaseItems', item(tabPrefixId, 'Movies.Movie', {
    Name: 'Tab is not a Rated prefix separator', SortName: 'z-unknown-rating', OfficialRating: 'Rated\tR',
  }));
  await postgres.insert('BaseItems', item(nbspPrefixId, 'Movies.Movie', {
    Name: 'NBSP is not a Rated prefix separator', SortName: 'y-unknown-rating', OfficialRating: 'Rated\u00a0R',
  }));
  await postgres.insert('BaseItems', item(tabTrimId, 'Movies.Movie', {
    Name: 'Tabs are trimmed', SortName: 'b-known-rating', OfficialRating: '\tR\t',
  }));
  await postgres.insert('BaseItems', item(nbspTrimId, 'Movies.Movie', {
    Name: 'NBSP is trimmed', SortName: 'a-known-rating', OfficialRating: '\u00a0R\u00a0',
  }));
  await postgres.insert('BaseItems', item(nelTrimId, 'Movies.Movie', {
    Name: 'NEL is trimmed', SortName: 'c-known-rating', OfficialRating: '\u0085R\u0085',
  }));
  await postgres.insert('BaseItems', item(byteOrderMarkId, 'Movies.Movie', {
    Name: 'BOM is not CLR whitespace', SortName: 'x-unknown-rating', OfficialRating: '\ufeffR\ufeff',
  }));
  const whitespaceRatingPage = await queryPostgresItemPage(postgres, {
    ids: [tabTrimId, nbspTrimId, nelTrimId, byteOrderMarkId, tabPrefixId, nbspPrefixId],
    sortby: ['OfficialRating'], limit: 10,
  }, { resumableMode: 'memory', memorySortConfiguration: { MetadataCountryCode: 'US' } });
  assert.deepEqual(whitespaceRatingPage.rows.map(row => row.Id),
    [byteOrderMarkId, nbspPrefixId, tabPrefixId, nbspTrimId, tabTrimId, nelTrimId],
    'Rated uses exact ASCII-space literals and rating resolution uses the actual CLR trim whitespace contract');

  const boxId = '21000000-0000-0000-0000-000000000021';
  const childId = '21000000-0000-0000-0000-000000000022';
  await postgres.insert('BaseItems', item(boxId, 'Collections.BoxSet', {
    Name: 'Turkish rating box', SortName: 'turkish-rating-box', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(childId, 'Movies.Movie', {
    Name: 'Turkish rating child', SortName: 'turkish-rating-child',
    OfficialRating: 'Genel \u0130zleyici Kitlesi',
  }));
  await postgres.insert('LinkedChildren', {
    ParentId: boxId, SortOrder: 0, ChildId: childId, ChildType: 0,
  });
  const visible = await queryPostgresItemPage(postgres, { ids: [boxId], limit: 10 }, {
    resumableMode: 'memory',
    visibility: {
      maxRating: 0,
      maxSubRating: 0,
      boxSetChildRatingMode: 'memory',
      ratingContext: { defaultCountry: 'TR', folders: [] },
    },
  });
  assert.deepEqual(visible.rows.map(row => row.Id), [boxId]);
  await postgres.update('BaseItems', { Id: childId }, { OfficialRating: '9'.repeat(10000) });
  const oversizedChildRating = await queryPostgresItemPage(postgres, { ids: [boxId], limit: 10 }, {
    resumableMode: 'memory',
    visibility: {
      maxRating: 0, maxSubRating: 0, boxSetChildRatingMode: 'memory',
      ratingContext: { defaultCountry: 'US', folders: [] },
      blockUnratedTypes: ['Movie'],
    },
  });
  assert.equal(oversizedChildRating.total, 0,
    'an oversized child rating is not allowed and cannot abort the visibility query');

  const taggedId = '21000000-0000-0000-0000-000000000031';
  await postgres.insert('BaseItems', item(taggedId, 'Movies.Movie', {
    Name: 'Unicode tag', SortName: 'unicode-tag', Tags: 'RÖCK',
  }));
  const blockedTag = await queryPostgresItemPage(postgres, { ids: [taggedId], limit: 10 }, {
    resumableMode: 'memory', visibility: { blockedTags: ['Rock'] },
  });
  assert.equal(blockedTag.total, 0,
    'direct Tags use the same diacritic-insensitive CleanValue key as policy tags');
  const allowedTag = await queryPostgresItemPage(postgres, { ids: [taggedId], limit: 10 }, {
    resumableMode: 'memory', visibility: { allowedTags: ['Rock'] },
  });
  assert.deepEqual(allowedTag.rows.map(row => row.Id), [taggedId]);

  const nullUnratedId = '21000000-0000-0000-0000-000000000041';
  const personId = '21000000-0000-0000-0000-000000000042';
  const personRowId = '21000000-0000-0000-0000-000000000043';
  const topParentId = '21000000-0000-0000-0000-000000000044';
  await postgres.insert('BaseItems', item(nullUnratedId, 'Movies.Movie', {
    Name: 'Nullable unrated media', SortName: 'nullable-unrated-media',
    TopParentId: topParentId, InheritedParentalRatingValue: null, UnratedType: null,
  }));
  await postgres.insert('BaseItems', item(personId, 'Person', {
    Name: 'Nullable Unrated Person', CleanName: 'nullable unrated person',
    SortName: 'nullable unrated person',
  }));
  await postgres.insert('Peoples', {
    Id: personRowId, Name: 'Nullable Unrated Person', PersonType: 'Actor',
  });
  await postgres.insert('PeopleBaseItemMap', {
    ItemId: nullUnratedId, PeopleId: personRowId, Role: '', ListOrder: null, SortOrder: null,
  });
  const nullUnrated = await queryPostgresItemPage(postgres, { ids: [nullUnratedId], limit: 10 }, {
    visibility: { blockUnratedTypes: ['Movie'] },
  });
  assert.deepEqual(nullUnrated.rows.map(row => row.Id), [nullUnratedId]);
  const relatedPerson = await queryPostgresItemPage(postgres, { ids: [personId], limit: 10 }, {
    nameAccessTypes: ['Person'],
    requireRelatedNameAccess: true,
    visibility: { topParentIds: [topParentId], blockUnratedTypes: ['Movie'] },
  });
  assert.deepEqual(relatedPerson.rows.map(row => row.Id), [personId],
    'nullable related-media UnratedType grants by-name access when no blocked type matches');
});

test('real PostgreSQL applies non-ASCII memory genre and studio filters before paging', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_memory_values_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const firstId = '21500000-0000-0000-0000-000000000001';
  const secondId = '21500000-0000-0000-0000-000000000002';
  const genreId = '21500000-0000-0000-0000-000000000011';
  const studioId = '21500000-0000-0000-0000-000000000012';
  const whitespaceId = '21500000-0000-0000-0000-000000000003';
  const whitespaceGenreId = '21500000-0000-0000-0000-000000000013';
  await postgres.insert('BaseItems', item(firstId, 'Audio.Audio', {
    Name: 'A upper Unicode values', SortName: 'memory-values-a', Genres: '\u00c9POP\u00c9E', Studios: '\u00dcBER',
  }));
  await postgres.insert('BaseItems', item(secondId, 'Audio.Audio', {
    Name: 'B lower Unicode values', SortName: 'memory-values-b', Genres: '\u00e9pop\u00e9e', Studios: '\u00fcber',
  }));
  await postgres.insert('BaseItems', item(whitespaceId, 'Audio.Audio', {
    Name: 'CLR whitespace-only genre', SortName: 'memory-values-whitespace', Genres: '\u0085',
  }));
  await postgres.insert('BaseItems', item(genreId, 'Genre', {
    Name: '\u00e9pop\u00e9e', SortName: 'genre-selector', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(studioId, 'Studio', {
    Name: '\u00fcber', SortName: 'studio-selector', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(whitespaceGenreId, 'Genre', {
    Name: '\u0085', SortName: 'whitespace-genre-selector', IsFolder: true,
  }));

  const assertPaged = async (filter, label) => {
    const query = { ids: [firstId, secondId], ...filter, sortby: ['SortName'], limit: 1 };
    const first = await queryPostgresItemPage(postgres, { ...query, startindex: 0 }, {
      resumableMode: 'memory',
    });
    const second = await queryPostgresItemPage(postgres, { ...query, startindex: 1 }, {
      resumableMode: 'memory',
    });
    assert.equal(first.total, 2, `${label} counts both Unicode case variants before paging`);
    assert.equal(second.total, 2, `${label} keeps the full count on the second page`);
    assert.deepEqual(first.rows.map(row => row.Id), [firstId], `${label} first page`);
    assert.deepEqual(second.rows.map(row => row.Id), [secondId], `${label} second page`);
  };

  await assertPaged({ genres: ['\u00e9pop\u00e9e'] }, 'Genres');
  await assertPaged({ genreids: [genreId] }, 'GenreIds');
  await assertPaged({ studionames: ['\u00fcber'] }, 'Studios');
  await assertPaged({ studioids: [studioId] }, 'StudioIds');

  for (const selector of [{ genres: ['\u0085'] }, { genreids: [whitespaceGenreId] }]) {
    const emptyGenre = await queryPostgresItemPage(postgres, {
      ids: [whitespaceId], ...selector, limit: 10,
    }, { resumableMode: 'memory' });
    assert.equal(emptyGenre.total, 0,
      'a CLR-whitespace-only persisted Genres value maps to the native empty array');
  }
});

test('real PostgreSQL memory BoxSet roots preserve native path containment semantics', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_boxset_path_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const aggregateId = '22000000-0000-0000-0000-000000000001';
  await postgres.insert('BaseItems', item(aggregateId, 'AggregateFolder', {
    Name: 'Aggregate', SortName: 'aggregate', IsFolder: true,
  }));
  const cases = [
    {
      name: 'POSIX paths remain case-sensitive',
      collectionPath: '/srv/App/data/collections',
      rootPath: '/srv/app/data/collections',
      collapse: false,
    },
    {
      name: 'a normalized POSIX ancestor contains the collections path',
      collectionPath: '/srv/App/data/collections/./',
      rootPath: '/srv/App/data/staging/..',
      collapse: true,
    },
    {
      name: 'a POSIX sibling prefix stops at the segment boundary',
      collectionPath: '/srv/App/data/collections',
      rootPath: '/srv/App/data/collect',
      collapse: false,
    },
    {
      name: 'Windows paths normalize slashes and dot segments with ordinal non-ASCII case folding',
      collectionPath: 'Z:\\MÉDIA\\data\\collections',
      rootPath: 'z:/méDIA/data/staging/../collections/.',
      collapse: true,
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const suffix = String(index + 1).padStart(2, '0');
    const rootId = `22000000-0000-0000-0000-0000000001${suffix}`;
    const boxId = `22000000-0000-0000-0000-0000000002${suffix}`;
    const movieId = `22000000-0000-0000-0000-0000000003${suffix}`;
    await postgres.insert('BaseItems', item(rootId, 'Folder', {
      Name: `${scenario.name} root`, SortName: `${index}-root`, ParentId: aggregateId,
      Path: scenario.rootPath, IsFolder: true,
    }));
    await postgres.insert('BaseItems', item(boxId, 'Collections.BoxSet', {
      Name: `${scenario.name} box`, SortName: `${index}-box`, ParentId: rootId,
      IsFolder: true,
    }));
    await postgres.insert('BaseItems', item(movieId, 'Movies.Movie', {
      Name: `${scenario.name} movie`, SortName: `${index}-movie`,
    }));
    await postgres.insert('LinkedChildren', {
      ParentId: boxId, SortOrder: index, ChildId: movieId, ChildType: 0,
    });

    assert.equal(nativePathWithin(scenario.collectionPath, scenario.rootPath), scenario.collapse,
      `${scenario.name}: fixture expectation follows collectionBoxSets authority`);
    const page = await queryPostgresItemPage(postgres, { ids: [movieId], limit: 10 }, {
      resumableMode: 'memory',
      collapseMode: 'memory',
      collapseTypes: ['Movie'],
      collapseCollectionPath: scenario.collectionPath,
    });
    assert.deepEqual(page.rows.map(row => row.Id), [scenario.collapse ? boxId : movieId], scenario.name);
  }
});

test('real PostgreSQL repository search preserves ASCII-only OriginalTitle folding', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_search_ascii_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const id = '22500000-0000-0000-0000-000000000001';
  await postgres.insert('BaseItems', item(id, 'Movies.Movie', {
    Name: 'Unrelated',
    CleanName: 'unrelated',
    SortName: 'unrelated',
    OriginalTitle: '\u03a3Igma',
  }));
  const page = await queryPostgresItemPage(postgres, {
    ids: [id],
    searchterm: '\u03a3I',
    limit: 10,
  });
  assert.deepEqual(page.rows.map(row => row.Id), [id]);
});

test('real PostgreSQL memory SeriesSortName resolves an unbounded acyclic parent chain', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `item_series_depth_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const postgres = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await postgres.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await postgres.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await postgres.close();
  });

  const alphaSeriesId = '22600000-0000-0000-0000-000000000001';
  const alphaEpisodeId = '22600000-0000-0000-0000-000000000002';
  const zuluSeriesId = '22600000-0000-0000-0000-000000000003';
  const deepEpisodeId = '22600000-0000-0000-0000-000000000004';
  await postgres.insert('BaseItems', item(alphaSeriesId, 'TV.Series', {
    Name: 'Alpha Series', SortName: 'alpha series', IsFolder: true,
  }));
  await postgres.insert('BaseItems', item(alphaEpisodeId, 'TV.Episode', {
    Name: 'Alpha episode', SortName: 'alpha episode', SeriesId: alphaSeriesId,
    SeriesName: 'Alpha Series',
  }));
  await postgres.insert('BaseItems', item(zuluSeriesId, 'TV.Series', {
    Name: 'Zulu Series', SortName: 'zulu series', IsFolder: true,
  }));
  let parentId = zuluSeriesId;
  for (let depth = 1; depth <= 70; depth++) {
    const folderId = `22600000-0000-0000-0001-${String(depth).padStart(12, '0')}`;
    await postgres.insert('BaseItems', item(folderId, 'Folder', {
      Name: `Depth ${depth}`, SortName: `depth-${String(depth).padStart(2, '0')}`,
      ParentId: parentId, IsFolder: true,
    }));
    parentId = folderId;
  }
  await postgres.insert('BaseItems', item(deepEpisodeId, 'TV.Episode', {
    Name: 'Deep episode', SortName: 'deep episode', ParentId: parentId,
    SeriesId: null, SeriesName: 'A misleading fallback',
  }));

  const query = {
    ids: [deepEpisodeId, alphaEpisodeId],
    sortby: ['SeriesSortName'],
    limit: 1,
  };
  const first = await queryPostgresItemPage(postgres, { ...query, startindex: 0 }, {
    resumableMode: 'memory',
  });
  const second = await queryPostgresItemPage(postgres, { ...query, startindex: 1 }, {
    resumableMode: 'memory',
  });
  assert.deepEqual(first.rows.map(row => row.Id), [alphaEpisodeId]);
  assert.deepEqual(second.rows.map(row => row.Id), [deepEpisodeId]);
  assert.equal(first.total, 2);
});
