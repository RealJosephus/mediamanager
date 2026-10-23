import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { localGenreTagSimilarQuery, queryPostgresLocalSimilarRows, queryPostgresMovieSimilarRows } from '../../src/library/postgres-similar-items-query.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { createTmdbMovieSimilarProvider } from '../../plugins/tmdb/similar.js';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { databaseDigest, exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { mapRecord } from '../../src/library/records.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { blank, currentMovieSimilar, id, input, recordCandidate, seedCandidate, typeNames } from './movie-similar-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('movie Similar records this run’s designated Native providers and concrete repository', async () => {
  const { native, report } = await currentMovieSimilar();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.equal(native.results.length, input.cases.length);
  assert.equal(native.results.length, 14);
  for (const result of native.results) assert.equal(result.failed, result.name === 'userless-candidates-throw-before-access', result.name);
  assert.equal(native.liveTv.length, 4);
  assert.equal(native.tmdbMovie.cases.length, input.tmdb.cases.length);
});

test('relational identifier scopes preserve actual Native IsMovie type results on PostgreSQL', async t => {
  const { native } = await currentMovieSimilar();
  const db = await createPostgresTestDatabase(t, 'movie_scope'); await seedCandidate(db);
  for (const [index, scenario] of input.identifierScopes.entries()) {
    const selected = await queryPostgresItemPage(db, { includeitemtypes: scenario.types, ismovie: scenario.isMovie }, {
      itemIdsPlan: { text: `SELECT "Id" FROM ${q(db.schemaName)}."BaseItems" WHERE "Id" IN (${scenario.ids.map((_, index) => '$' + (index + 1)).join(', ')})`,
        values: scenario.ids.map(value => nativeTextBytes(id(value))) },
    });
    const actual = selected.rows.map(row => ({ id: row.Id, name: row.Name, sortName: mapRecord(row).SortName }));
    await recordCandidate(scenario.name, actual);
    assert.deepEqual(actual, native.identifierScopes[index].selected, scenario.name);
  }
  await assert.rejects(queryPostgresItemPage(db, {}, { itemIdsPlan: { text: '', values: [] } }));
});

test('Movie/Trailer weighted Similar matches actual native provider on real PostgreSQL', async t => {
  const { native } = await currentMovieSimilar();
  const db = await createPostgresTestDatabase(t, 'movie_similar'), schema = db.schemaName;
  await seedCandidate(db);
  const actualRows = db.rows.bind(db), hydration = [];
  db.rows = async (name, options = {}) => {
    if (name === 'BaseItems') {
      assert.ok(options.whereIn?.Id?.length, 'Only already-selected identifiers may be hydrated');
      hydration.push(options.whereIn.Id.length);
    }
    return actualRows(name, options);
  };
  for (const [index, scenario] of input.cases.entries()) {
    const hydrationStart = hydration.length;
    const expected = native.results[index];
    const options = {
      sourceId: id(scenario.source), limit: scenario.limit,
      excludeItemIds: [id(scenario.source), ...(scenario.exclude ?? []).map(id)],
      enableExternalContent: scenario.external ?? true,
      userId: scenario.user ? id(scenario.playedUser ? 80 : 81) : undefined,
      visibility: scenario.user && scenario.access !== false ? { topParentIds: [id(90)] } : undefined,
    };
    let rows, failure;
    try { rows = await queryPostgresMovieSimilarRows(db, options); } catch (error) { failure = error; }
    const actual = { failed: Boolean(failure), ...(rows ? { ids: rows.map(row => row.Id),
      items: rows.map(row => row.Name), sortNames: rows.map(row => mapRecord(row).SortName) } : {}),
    ...(failure ? { diagnostic: { name: failure.name, message: failure.message } } : {}) };
    await recordCandidate(scenario.name, actual);
    assert.equal(actual.failed, expected.failed, scenario.name);
    if (!expected.failed) {
      assert.deepEqual(actual.ids, expected.ids, scenario.name);
      assert.deepEqual(actual.items, expected.items, scenario.name);
      assert.deepEqual(actual.sortNames, expected.sortNames, scenario.name);
      assert.ok(hydration.length === hydrationStart || hydration.at(-1) <= (scenario.limit ?? 50));
    }
  }
  const bulkTemplate = { ...blank('BaseItems'), Type: typeNames.Movie, Data: '{}',
    TopParentId: id(90), MediaType: 'Video' };
  const physicalTemplate = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    bulkTemplate[column.name] == null || column.type !== 'TEXT' ? bulkTemplate[column.name]
      : '\\x' + nativeTextBytes(bulkTemplate[column.name]).toString('hex')]));
  await db.client.query({ text: `INSERT INTO ${q(schema)}."BaseItems"
    SELECT row.* FROM generate_series(1, 20000) entry(number)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${q(schema)}."BaseItems", $1::jsonb || jsonb_build_object(
      'Id', convert_to('15000000-0000-0000-0000-' || lpad(entry.number::text, 12, '0'), 'UTF8'),
      'Name', convert_to('Bulk movie ' || entry.number, 'UTF8'), 'SortName', convert_to('Bulk movie ' || entry.number, 'UTF8'),
      'PresentationUniqueKey', convert_to('bulk-' || entry.number, 'UTF8'))) row`,
  values: [JSON.stringify(physicalTemplate, (_key, value) => typeof value === 'bigint' ? value.toString() : value)] });
  await db.client.query({ text: `INSERT INTO ${q(schema)}."ItemValuesMap" ("ItemValueId", "ItemId")
    SELECT $1::bytea, convert_to('15000000-0000-0000-0000-' || lpad(number::text, 12, '0'), 'UTF8') FROM generate_series(1, 20000) entry(number)`,
  values: [nativeTextBytes(id(901))] });
  await db.client.query(`ANALYZE ${q(schema)}."BaseItems"`);
  await db.client.query(`ANALYZE ${q(schema)}."ItemValuesMap"`);
  const query = db.client.query.bind(db.client);
  let weightedPlan;
  db.client.query = async (...args) => {
    const result = await query(...args);
    if (args[0]?.text?.includes('movie-similar-weighted-page')) {
      weightedPlan = args[0];
      assert.ok(result.rows.length <= 3, 'SQL must return only its final page, not catalogue candidates');
    }
    return result;
  };
  const selected = await queryPostgresMovieSimilarRows(db, { sourceId: id(1), userId: id(81), limit: 3 });
  assert.deepEqual(selected.map(row => row.Id), native.results[0].ids.slice(0, 3));
  assert.equal(hydration.at(-1), 3);
  const explain = await query({ ...weightedPlan, text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + weightedPlan.text });
  const plan = explain.rows[0]['QUERY PLAN'][0];
  assert.equal(plan.Plan['Actual Rows'], 3);
  await recordCandidate('large-catalogue', { candidates: 20000, selected: selected.map(row => ({ id: row.Id,
    name: row.Name, sortName: mapRecord(row).SortName })), hydrated: hydration.at(-1), plan });
  t.diagnostic(`20,000-candidate weighted query: ${plan['Execution Time']} ms, 3 SQL result rows and 3 hydrated rows.`);
});

test('TMDb Movie Similar retains Int32 gating, pagination, cancellation and empty-page stop', async () => {
  const calls = [], signal = new AbortController().signal;
  const provider = createTmdbMovieSimilarProvider({ client: { configuration: { SimilarItemsCacheDays: 2 },
    recommendations: async (...args) => {
      calls.push(args);
      return args[2] === 1 ? { Results: [{ id: 31 }, { id: 32 }], TotalPages: 3 } : { Results: [], TotalPages: 3 };
    } } });
  const refs = [];
  for await (const ref of provider.getReferences({ ProviderIds: { tmdb: ' +17 ' } }, {}, signal)) refs.push(ref);
  assert.deepEqual(refs, [{ ProviderName: 'Tmdb', ProviderId: '31', Score: null }, { ProviderName: 'Tmdb', ProviderId: '32', Score: null }]);
  assert.deepEqual(calls, [['Movie', 17, 1, 'null,en', { signal }], ['Movie', 17, 2, 'null,en', { signal }]]);
  assert.equal(provider.cacheDuration(), 172_800_000);
  for await (const _ref of provider.getReferences({ ProviderIds: { Tmdb: '2147483648' } }, {}, signal)) assert.fail('Invalid id yielded a reference');
  assert.equal(calls.length, 2);
});

test('Live TV Similar returns actual Native type, metadata, count and bounded membership results', async t => {
  const { native } = await currentMovieSimilar();
  const db = await createPostgresTestDatabase(t, 'movie_live_tv'); await seedCandidate(db);
  const program = mapRecord({ ...blank('BaseItems'), Id: id(999), Type: typeNames.LiveTvProgram,
    Data: '{"IsMovie":false,"IsSeries":true}', IsMovie: true, IsSeries: false,
    EpisodeTitle: 'Stored episode', IsRepeat: true });
  assert.equal(program.IsMovie, true); assert.equal(program.IsSeries, false);
  assert.equal(program.EpisodeTitle, 'Stored episode'); assert.equal(program.IsRepeat, true);
  const projected = rows => rows.map(row => {
    const item = mapRecord(row);
    return { id: row.Id, name: item.Name, type: item.Type === 'LiveTvProgram' ? 'Program' : item.Type,
      sortName: item.SortName, genres: item.Genres, tags: item.Tags };
  });
  const byId = values => [...values].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (const [index, scenario] of input.liveTv.cases.entries()) {
    const expected = native.liveTv[index];
    const source = { Type: 'LiveTvProgram', Genres: input.liveTv.genres, Tags: input.liveTv.tags,
      IsMovie: scenario.isMovie, IsSeries: scenario.isSeries };
    const select = async limit => projected(await queryPostgresLocalSimilarRows(db,
      { ...localGenreTagSimilarQuery(source, { limit, excludeItemIds: [input.liveTv.sourceId, ...input.liveTv.exclude].map(id) },
        { enableExternalContent: scenario.external }), userId: id(80) }));
    let pool, selected, failure;
    try { pool = await select(input.liveTv.poolLimit); selected = await select(input.liveTv.limit); } catch (error) { failure = error; }
    const actual = { failed: Boolean(failure), pool, selected,
      ...(failure ? { diagnostic: { name: failure.name, message: failure.message } } : {}) };
    await recordCandidate('live-tv-' + scenario.name, actual);
    assert.equal(expected.failed, false, scenario.name + ': the declared Native query must execute.');
    assert.equal(actual.failed, expected.failed, scenario.name);
    if (scenario.isMovie) assert.ok(expected.pool.length > input.liveTv.limit,
      scenario.name + ': the declared catalogue must exercise limited selection.');
    if (!scenario.isMovie && scenario.isSeries) assert.ok(expected.pool.length > 0,
      scenario.name + ': the declared catalogue must exercise Series results.');
    assert.deepEqual(byId(pool), byId(expected.pool), scenario.name + ': complete eligible content');
    assert.equal(selected.length, expected.selected.length, scenario.name + ': actual provider limit/count');
    assert.equal(new Set(selected.map(item => item.id)).size, selected.length);
    for (const item of [...selected, ...expected.selected]) {
      assert.deepEqual(item, pool.find(value => value.id === item.id), scenario.name + ': random result membership and metadata');
    }
  }
});

test('TMDb Movie Similar references and transport requests match actual native TMDbLib provider', async t => {
  const { native } = await currentMovieSimilar();
  let mode = 'success'; const requests = [];
  const client = new TmdbClient({ baseUrl: 'http://tmdb.invalid/3/', apiKey: 'oracle-key',
    configuration: { SimilarItemsCacheDays: input.tmdb.cacheDays }, fetch: async request => {
      requests.push(request.toString());
      if (request.pathname.endsWith('/configuration')) return Response.json(input.tmdb.configuration);
      if (mode === 'failure') throw new Error('Controlled movie transport failure');
      return Response.json(mode === 'empty' ? input.tmdb.emptyPage
        : request.searchParams.get('page') === '2' ? input.tmdb.secondPage : input.tmdb.firstPage);
    } });
  t.after(() => client.close());
  const provider = createTmdbMovieSimilarProvider({ client });
  assert.equal(provider.cacheDuration(), native.tmdbMovie.cacheMilliseconds);
  const requestShape = text => {
    const url = new URL(text);
    return { origin: url.origin, path: url.pathname, query: [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)) };
  };
  for (const [index, scenario] of input.tmdb.cases.entries()) {
    const expected = native.tmdbMovie.cases[index];
    mode = scenario.mode; requests.length = 0;
    const references = [];
    const cancellation = new AbortController(); if (scenario.cancelled) cancellation.abort();
    for await (const reference of provider.getReferences({ ProviderIds: scenario.value ? { Tmdb: scenario.value } : {} }, {}, cancellation.signal)) {
      references.push(reference);
    }
    await recordCandidate('tmdb-' + scenario.name, { references, requests });
    assert.deepEqual(references, expected.references, expected.name);
    assert.deepEqual(requests.map(requestShape), expected.requests.map(requestShape), expected.name);
  }
});

test('ItemValues native insertion order survives SQLite/PostgreSQL exchange and runtime reinsertion', async t => {
  const db = await createPostgresTestDatabase(t, 'movie_value');
  const sqlite = new SqliteDatabase(':memory:', { create: true });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-movie-value-order-'));
  t.after(async () => {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });
  const value = number => ({ ItemValueId: id(number), Type: 2, Value: `Value ${number}`, CleanValue: 'same-clean-value' });
  sqlite.insert('ItemValues', value(990)); sqlite.insert('ItemValues', value(989));
  const instanceBinding = { serverId: id(80).replaceAll('-', ''), originIdentityDigest: 'f'.repeat(64) };
  await transferDatabase(sqlite, db, { instanceBinding, batchSize: 1 });
  let first = await db.relationRowsInInsertionOrder('ItemValues', { limit: 1 });
  const second = await db.relationRowsInInsertionOrder('ItemValues', { limit: 1, after: first.after });
  assert.equal(first.rows[0].ItemValueId, id(990)); assert.equal(second.rows[0].ItemValueId, id(989));
  await db.insert('ItemValues', value(991));
  await db.delete('ItemValues', { ItemValueId: id(989) });
  await db.insert('ItemValues', value(989));
  const before = await db.relationRowsInInsertionOrder('ItemValues', { limit: 10 });
  assert.deepEqual(before.rows.map(row => row.ItemValueId), [990, 991, 989].map(id));
  await db.preflight();
  const completeBefore = await databaseDigest(db);
  const output = path.join(directory, 'current.sqlite');
  await exportCurrentSqlite(db, output, { batchSize: 1, testOnlyAllowSyntheticEnvelope: true });
  const exported = new SqliteDatabase(output);
  try {
    const after = await exported.relationRowsInInsertionOrder('ItemValues', { limit: 10 });
    assert.deepEqual(after.rows, before.rows);
    const completeExport = await databaseDigest(exported);
    assert.deepEqual(completeExport, completeBefore);
    const returned = await createPostgresTestDatabase(t, 'movie_returned');
    await transferDatabase(exported, returned, { instanceBinding, batchSize: 1 });
    const completeReturned = await databaseDigest(returned);
    const returnedValues = await returned.relationRowsInInsertionOrder('ItemValues', { limit: 10 });
    assert.deepEqual(completeReturned, completeBefore); assert.deepEqual(returnedValues.rows, before.rows);
    await recordCandidate('item-values-exchange', { before: before.rows, after: after.rows, returned: returnedValues.rows,
      completeBefore, completeExport, completeReturned });
  } finally { exported.close(); }
});
