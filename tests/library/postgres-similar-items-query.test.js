import { testFileSystem } from '../storage/plugin-files.js';
import { nativeTextBytes, nativeTextProjection } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q, tableDefinition } from '../../src/database/model.js';
import { postgresOrdinalIgnoreCaseKeyFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { ordinalIgnoreCaseKey } from '../../src/storage/ordinal-comparer.js';
import {
  filterPostgresSimilarAccessRows,
  hasPostgresVisibleArtistRelation,
  queryPostgresLocalSimilarRows,
  resolvePostgresRemoteSimilarRows,
} from '../../src/library/postgres-similar-items-query.js';
import { SimilarItemsManager } from '../../src/library/similar-items.js';

const ids = Object.freeze({
  source: '13000000-0000-0000-0000-000000000001',
  first: '13000000-0000-0000-0000-000000000002',
  duplicateLow: '13000000-0000-0000-0000-000000000003',
  duplicateHigh: '13000000-0000-0000-0000-000000000004',
  artistExcluded: '13000000-0000-0000-0000-000000000005',
  excluded: '13000000-0000-0000-0000-000000000006',
  owned: '13000000-0000-0000-0000-000000000007',
  alternate: '13000000-0000-0000-0000-000000000008',
});

const blank = table => Object.fromEntries(tableDefinition(table).columns
  .filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00'
      : column.nullable ? null : type === 'bool' ? false
        : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));

const item = (Id, values = {}) => ({
  ...blank('BaseItems'), Id, Type: 'MediaBrowser.Controller.Entities.TV.Series',
  Name: Id, CleanName: Id, SortName: Id, Data: '{}', IsFolder: true,
  TopParentId: '13000000-0000-0000-0000-000000000099', ...values,
});

function planIndexNames(value, result = new Set()) {
  if (Array.isArray(value)) for (const entry of value) planIndexNames(entry, result);
  else if (value && typeof value === 'object') {
    if (typeof value['Index Name'] === 'string') result.add(value['Index Name']);
    for (const entry of Object.values(value)) planIndexNames(entry, result);
  }
  return result;
}

test('PostgreSQL Similar local provider plans filtering, grouping, random ordering and bounded hydration', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres', schemaName: 'similar_shape',
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [{ Id: nativeTextBytes(ids.first), TotalRecordCount: '1' }] };
    } },
    rows: async (name, options) => {
      assert.equal(name, 'BaseItems');
      assert.deepEqual(options, { whereIn: { Id: [ids.first] } });
      return [{ Id: ids.first }];
    },
  };
  const rows = await queryPostgresLocalSimilarRows(database, {
    itemType: 'Series', genres: ['Drama'], tags: ['Network'],
    excludeItemIds: [ids.source.replaceAll('-', '')], limit: 3,
    groupByPresentationKey: true,
  });

  assert.deepEqual(rows, [{ Id: ids.first }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /"ItemValuesMap"/u);
  assert.match(calls[0].text, /PARTITION BY "PresentationUniqueKey"/u);
  assert.match(calls[0].text, /ORDER BY random\(\)/u);
  assert.match(calls[0].text, /LIMIT \$\d+/u);
  assert.doesNotMatch(calls[0].text, /SELECT \* FROM "similar_shape"\."BaseItems"\s*$/u);
});

test('PostgreSQL remote Similar plan binds native ordinal provider keys', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres', schemaName: 'similar_shape',
    client: { query: async plan => { calls.push(plan); return { rows: [] }; } },
  };
  const result = await resolvePostgresRemoteSimilarRows(database, {
    itemType: 'Series',
    references: [
      { ProviderName: '\u03a3', ProviderId: 'VALUE\u03a3' },
      { ProviderName: '\u03c2', ProviderId: 'other' },
      { ProviderName: '\u0130', ProviderId: '\u0130' },
      { ProviderName: 'i\u0307', ProviderId: 'i\u0307' },
    ],
    limit: 10,
  });

  assert.deepEqual(result, { rows: [], nextCursor: null });
  assert.equal(calls.length, 1);
  const ordinalCall = `"similar_shape"."${postgresOrdinalIgnoreCaseKeyFunctionName}"`;
  assert.equal(calls[0].text.split(ordinalCall).length - 1, 4,
    'both provider columns and both reference columns use the schema-bound key');
  assert.doesNotMatch(calls[0].text,
    /lower\((?:provider\."Provider(?:Id|Value)"|reference\."Provider(?:Name|Value)")\)/u);
  assert.deepEqual(calls[0].values[2], [0, 0, 1, 2],
    'provider-name ordering groups only native OrdinalIgnoreCase equivalents');
  assert.equal(ordinalIgnoreCaseKey('\u03a3'), ordinalIgnoreCaseKey('\u03c2'));
  assert.notEqual(ordinalIgnoreCaseKey('\u0130'), ordinalIgnoreCaseKey('i\u0307'));
});

test('real PostgreSQL Similar helpers resolve and filter without unbounded BaseItems reads', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `similar_query_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  for (const row of [
    item(ids.source, { PresentationUniqueKey: 'source' }),
    item(ids.first, { PresentationUniqueKey: 'first' }),
    item(ids.duplicateLow, { PresentationUniqueKey: 'duplicate' }),
    item(ids.duplicateHigh, { PresentationUniqueKey: 'duplicate' }),
    item(ids.artistExcluded, { Type: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
      Name: 'Excluded Artist', CleanName: 'excluded artist', PresentationUniqueKey: 'excluded-artist' }),
    item(ids.excluded, { PresentationUniqueKey: 'excluded' }),
    item(ids.owned, { PresentationUniqueKey: 'owned', OwnerId: ids.source }),
    item(ids.alternate, { PresentationUniqueKey: 'alternate', PrimaryVersionId: ids.first }),
  ]) await database.insert('BaseItems', row);

  const values = [
    ['13000000-0000-0000-0001-000000000001', 2, 'Drama',
      [ids.source, ids.first, ids.duplicateLow, ids.duplicateHigh, ids.excluded]],
    ['13000000-0000-0000-0001-000000000002', 4, 'Network',
      [ids.source, ids.first, ids.duplicateLow, ids.duplicateHigh, ids.excluded]],
    ['13000000-0000-0000-0001-000000000003', 0, 'Excluded Artist', [ids.excluded]],
  ];
  for (const [ItemValueId, Type, Value, itemIds] of values) {
    await database.insert('ItemValues', { ItemValueId, Type, Value, CleanValue: Value.toLowerCase() });
    for (const ItemId of itemIds) await database.insert('ItemValuesMap', { ItemValueId, ItemId });
  }
  await database.insert('BaseItemProviders', {
    ItemId: ids.first, ProviderId: 'Tmdb', ProviderValue: '101',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.duplicateLow, ProviderId: 'Tmdb', ProviderValue: '102',
  });

  const rows = database.rows.bind(database);
  const baseReads = [];
  database.rows = (name, options) => {
    if (name === 'BaseItems') {
      baseReads.push(options);
      if (!options?.where && !options?.whereIn && options?.limit === undefined) {
        throw new Error('Similar items attempted an unbounded PostgreSQL BaseItems read.');
      }
    }
    return rows(name, options);
  };

  const local = await queryPostgresLocalSimilarRows(database, {
    itemType: 'Series', genres: ['Drama'], tags: ['Network'],
    excludeItemIds: [ids.source.replaceAll('-', '')],
    excludeArtistIds: [ids.artistExcluded.replaceAll('-', '')],
    limit: 10, groupByPresentationKey: true,
  });
  assert.deepEqual(new Set(local.map(row => row.Id)), new Set([ids.first, ids.duplicateLow]));

  const remote = await resolvePostgresRemoteSimilarRows(database, {
    itemType: 'Series', references: [
      { ProviderName: 'TMDB', ProviderId: '102' },
      { ProviderName: 'Tmdb', ProviderId: '101' },
    ],
    limit: 10,
  });
  assert.deepEqual(remote.rows.map(row => row.Id), [ids.duplicateLow, ids.first]);
  assert.equal(remote.nextCursor, null);

  await database.insert('BaseItemProviders', { ItemId: ids.first, ProviderId: 'Native\0Provider', ProviderValue: 'Value\0' });
  await database.insert('BaseItemProviders', { ItemId: ids.duplicateLow, ProviderId: 'Native\u00010Provider', ProviderValue: 'Value\u00010' });
  const exactControlReference = await resolvePostgresRemoteSimilarRows(database, {
    itemType: 'Series', references: [{ ProviderName: 'NATIVE\0PROVIDER', ProviderId: 'Value\0' }], limit: 1,
  });
  assert.deepEqual(exactControlReference.rows.map(row => row.Id), [ids.first],
    'native provider case folding preserves NUL and distinguishes the canonical-looking SOH0 sequence');
  const literalControlReference = await resolvePostgresRemoteSimilarRows(database, {
    itemType: 'Series', references: [{ ProviderName: 'native\u00010provider', ProviderId: 'Value\u00010' }], limit: 1,
  });
  assert.deepEqual(literalControlReference.rows.map(row => row.Id), [ids.duplicateLow]);

  const final = await filterPostgresSimilarAccessRows(database,
    [ids.owned, ids.alternate, ids.first]);
  assert.deepEqual(final.map(row => row.Id), [ids.first]);
  assert.deepEqual((await filterPostgresSimilarAccessRows(database, [ids.artistExcluded], {
    visibility: { topParentIds: ['13000000-0000-0000-0000-000000000099'] },
    nameAccessTypes: ['MusicArtist'],
  })).map(row => row.Id), [ids.artistExcluded]);
  assert.deepEqual(await filterPostgresSimilarAccessRows(database, [ids.artistExcluded], {
    visibility: {
      topParentIds: ['13000000-0000-0000-0000-000000000099'],
      blockedTags: ['Network'],
    },
    nameAccessTypes: ['MusicArtist'],
  }), [], 'a blocked related item cannot grant repository by-name access');
  assert.equal(await hasPostgresVisibleArtistRelation(database, ids.artistExcluded, {
    visibility: { topParentIds: ['13000000-0000-0000-0000-000000000099'] },
  }), true);
  assert.equal(await hasPostgresVisibleArtistRelation(database, ids.artistExcluded, {
    visibility: {
      topParentIds: ['13000000-0000-0000-0000-000000000099'],
      blockedTags: ['Network'],
    },
  }), false, 'a blocked related item cannot grant by-name access');
  assert.ok(baseReads.length >= 3);
  assert.ok(baseReads.every(options => options?.where || options?.whereIn || options?.limit !== undefined));
});

test('real PostgreSQL remote Similar uses indexed native ordinal Unicode identity', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `similar_unicode_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  const unicodeIds = Object.freeze({
    sigma: '13500000-0000-0000-0000-000000000001',
    dotted: '13500000-0000-0000-0000-000000000002',
    kelvin: '13500000-0000-0000-0000-000000000003',
    sharp: '13500000-0000-0000-0000-000000000004',
  });
  for (const [name, Id] of Object.entries(unicodeIds)) {
    await database.insert('BaseItems', item(Id, { PresentationUniqueKey: `unicode-${name}` }));
  }
  for (const [ItemId, ProviderId, ProviderValue] of [
    [unicodeIds.sigma, '\u03a3', 'VALUE\u03a3'],
    [unicodeIds.dotted, '\u0130', '\u0130'],
    [unicodeIds.kelvin, '\u212a', '\u212a'],
    [unicodeIds.sharp, '\u1e9e', '\u1e9e'],
  ]) await database.insert('BaseItemProviders', { ItemId, ProviderId, ProviderValue });

  const databaseLower = (await database.client.query(`SELECT
    lower($1::text COLLATE "C") = lower($2::text COLLATE "C") AS sigma_equal`,
  ['\u03a3', '\u03c2'])).rows[0];
  assert.equal(databaseLower.sigma_equal, false,
    'the previous database-locale lower predicate misses native-equivalent sigma forms');
  assert.equal('\u0130'.toLowerCase(), 'i\u0307');
  assert.equal('\u212a'.toLowerCase(), 'k');
  assert.equal('\u1e9e'.toLowerCase(), '\u00df');

  const ordinal = `${q(schema)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}`;
  const equivalence = (await database.client.query(`SELECT
    ${ordinal}($1::text) = ${ordinal}($2::text) AS sigma,
    ${ordinal}($3::text) = ${ordinal}($4::text) AS dotted,
    ${ordinal}($5::text) = ${ordinal}($6::text) AS kelvin,
    ${ordinal}($7::text) = ${ordinal}($8::text) AS sharp`,
  ['\u03a3', '\u03c2', '\u0130', 'i\u0307', '\u212a', 'K', '\u1e9e', '\u00df'])).rows[0];
  assert.deepEqual(equivalence, { sigma: true, dotted: false, kelvin: false, sharp: false });

  const query = database.client.query.bind(database.client);
  let captured;
  database.client.query = (...args) => {
    const plan = args[0];
    if (typeof plan === 'object' && /WITH reference\("ProviderName"/u.test(plan.text)) {
      captured = { text: plan.text, values: plan.values };
    }
    return query(...args);
  };
  const resolved = await resolvePostgresRemoteSimilarRows(database, {
    itemType: 'Series',
    references: [
      { ProviderName: '\u03c2', ProviderId: 'value\u03c2' },
      { ProviderName: 'i\u0307', ProviderId: 'i\u0307' },
      { ProviderName: 'K', ProviderId: 'K' },
      { ProviderName: '\u00df', ProviderId: '\u00df' },
    ],
    limit: 10,
  });
  database.client.query = query;

  assert.deepEqual(resolved.rows.map(row => row.Id), [unicodeIds.sigma]);
  assert.equal(resolved.nextCursor, null);
  assert.ok(captured, 'the production remote resolver query was captured');
  const explained = await database.transaction(async session => {
    await session.client.query('SET LOCAL enable_seqscan = off');
    const production = (await session.client.query({
      text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${captured.text}`,
      values: captured.values,
    })).rows[0]['QUERY PLAN'];
    const providerLookup = (await session.client.query({
      text: `EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT "ItemId" FROM ${q(schema)}."BaseItemProviders"
        WHERE ${ordinal}("ProviderId") = ${ordinal}($1::text)
          AND ${ordinal}("ProviderValue") = ${ordinal}($2::text)`,
      values: ['\u03c2', 'value\u03c2'],
    })).rows[0]['QUERY PLAN'];
    return { production, providerLookup };
  }, { readOnly: true, isolation: 'read-committed' });
  const productionIndexes = planIndexNames(explained.production);
  assert.ok(productionIndexes.has('mm_runtime_providers_provider_value_ordinal_idx')
    || productionIndexes.has('mm_runtime_providers_item_provider_ordinal_idx'),
  'the complete resolver remains indexed whichever bounded join side the optimizer leads with');
  assert.ok(planIndexNames(explained.providerLookup)
    .has('mm_runtime_providers_provider_value_ordinal_idx'),
  'the production provider/value predicate is supported by its ordinal expression index');
});

test('real PostgreSQL remote Similar pages duplicate-heavy matches by the manager remaining limit', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `similar_bounds_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true,
  });
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await database.close();
  });

  const candidateId = index => `14000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
  const source = candidateId(1);
  for (let index = 1; index <= 96; index++) {
    const presentation = index === 1 ? 'bounds-source'
      : index <= 3 ? 'bounds-collapsed' : `bounds-${index}`;
    const Id = candidateId(index);
    await database.insert('BaseItems', item(Id, { PresentationUniqueKey: presentation }));
    await database.insert('BaseItemProviders', {
      ItemId: Id, ProviderId: 'Tmdb', ProviderValue: '999',
    });
  }

  const query = database.client.query.bind(database.client);
  const sqlPages = [];
  database.client.query = (...args) => {
    const plan = args[0];
    if (typeof plan === 'object' && /WITH reference\("ProviderName"/u.test(plan.text)) {
      sqlPages.push({ limit: plan.values.at(-1), afterOrdinal: plan.values.at(-3), afterId: plan.values.at(-2) });
    }
    return query(...args);
  };
  const rows = database.rows.bind(database);
  const hydrationSizes = [];
  database.rows = (name, options) => {
    if (name === 'BaseItems') hydrationSizes.push(options?.whereIn?.Id?.length ?? null);
    return rows(name, options);
  };

  const pageSizes = [];
  const manager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [{
    name: 'Bounds Remote', kind: 'remote', itemTypes: ['Series'],
    async *getReferences() { yield { ProviderName: 'Tmdb', ProviderId: '999' }; },
  }] });
  const result = await manager.getSimilarItems({
    item: { Id: source, PresentationUniqueKey: 'bounds-source', ProviderIds: { Tmdb: '999' } },
    itemType: 'Series',
    typeOptions: { SimilarItemProviders: ['Bounds Remote'] },
    limit: 2,
    idKey: value => String(value).replaceAll('-', '').toLowerCase(),
    presentationKey: value => value.PresentationUniqueKey,
    presentationKeyKey: value => String(value).toLowerCase(),
    resolveRemote: async (references, { limit, after }) => {
      const page = await resolvePostgresRemoteSimilarRows(database, {
        itemType: 'Series', references, limit, after,
      });
      pageSizes.push(page.rows.length);
      return {
        items: page.rows.map(row => ({ ...row, ProviderIds: { Tmdb: '999' } })),
        nextCursor: page.nextCursor,
      };
    },
  });

  assert.deepEqual(result.map(value => value.Id), [candidateId(2), candidateId(4)]);
  assert.deepEqual(sqlPages.map(page => page.limit), [2, 1, 1]);
  assert.deepEqual(pageSizes, [2, 1, 1]);
  assert.deepEqual(hydrationSizes, [2, 1, 1]);
  assert.equal(Math.max(...hydrationSizes), 2, 'maximum observed BaseItems hydration batch');
  assert.ok(sqlPages.every((page, index) => page.limit <= [2, 1, 1][index]));
  assert.equal(hydrationSizes.reduce((total, size) => total + size, 0), 4,
    'only cursor pages needed to fill two unique presentation keys are hydrated');

  const lowScoreId = candidateId(200);
  const highScoreId = candidateId(201);
  await database.insert('BaseItems', item(lowScoreId, { PresentationUniqueKey: 'score-low' }));
  await database.insert('BaseItems', item(highScoreId, { PresentationUniqueKey: 'score-high' }));
  await database.insert('BaseItemProviders', {
    ItemId: lowScoreId, ProviderId: 'Tmdb', ProviderValue: 'score-low',
  });
  await database.insert('BaseItemProviders', {
    ItemId: highScoreId, ProviderId: 'Tmdb', ProviderValue: 'score-high',
  });
  sqlPages.length = 0;
  hydrationSizes.length = 0;
  const scoredManager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [{
    name: 'Scored Remote', kind: 'remote', itemTypes: ['Series'],
    async *getReferences() {
      yield { ProviderName: 'Tmdb', ProviderId: 'score-low', Score: 0.1 };
      yield { ProviderName: 'Tmdb', ProviderId: 'score-high', Score: 0.9 };
    },
  }] });
  const scored = await scoredManager.getSimilarItems({
    item: { Id: source, PresentationUniqueKey: 'bounds-source', ProviderIds: { Tmdb: '999' } },
    itemType: 'Series',
    typeOptions: { SimilarItemProviders: ['Scored Remote'] },
    limit: 1,
    idKey: value => String(value).replaceAll('-', '').toLowerCase(),
    presentationKey: value => value.PresentationUniqueKey,
    presentationKeyKey: value => String(value).toLowerCase(),
    resolveRemote: async (references, { limit, after, referencePositions, providerOrderIndex }) => {
      const page = await resolvePostgresRemoteSimilarRows(database, {
        itemType: 'Series', references, referencePositions, providerOrderIndex, limit, after,
      });
      return {
        items: page.rows.map(entry => ({ ...entry, ProviderIds: {
          Tmdb: entry.Id === highScoreId ? 'score-high' : 'score-low',
        } })),
        nextCursor: page.nextCursor,
      };
    },
  });
  assert.deepEqual(scored.map(value => value.Id), [highScoreId],
    'a later explicit provider score must win before the bounded resolver stops');
  assert.deepEqual(sqlPages.map(page => page.limit), [1]);
  assert.deepEqual(hydrationSizes, [1]);

  sqlPages.length = 0;
  hydrationSizes.length = 0;
  const saturatedManager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [{
    name: 'Saturated Remote', kind: 'remote', itemTypes: ['Series'],
    async *getReferences() {
      yield { ProviderName: 'Tmdb', ProviderId: 'score-low', Score: 0.98 };
      yield { ProviderName: 'Tmdb', ProviderId: 'score-high', Score: 0.99 };
    },
  }] });
  const saturated = await saturatedManager.getSimilarItems({
    item: { Id: source, PresentationUniqueKey: 'bounds-source', ProviderIds: { Tmdb: '999' } },
    itemType: 'Series',
    typeOptions: { SimilarItemProviders: ['Saturated Remote'] },
    limit: 1,
    idKey: value => String(value).replaceAll('-', '').toLowerCase(),
    presentationKey: value => value.PresentationUniqueKey,
    presentationKeyKey: value => String(value).toLowerCase(),
    resolveRemote: async (references, {
      limit, after, referencePositions, providerOrderIndex,
    }) => {
      const page = await resolvePostgresRemoteSimilarRows(database, {
        itemType: 'Series', references, referencePositions, providerOrderIndex, limit, after,
      });
      return {
        items: page.rows.map(entry => ({ ...entry, ProviderIds: {
          Tmdb: entry.Id === highScoreId ? 'score-high' : 'score-low',
        } })),
        nextCursor: page.nextCursor,
      };
    },
  });
  assert.deepEqual(saturated.map(value => value.Id), [lowScoreId],
    'provider boost saturation must preserve stable reference order');
  assert.deepEqual(sqlPages.map(page => page.limit), [1]);
  assert.deepEqual(hydrationSizes, [1]);
});
