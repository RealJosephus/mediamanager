import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { localGenreTagSimilarQuery, queryPostgresLocalSimilarRows, queryPostgresMovieSimilarRows } from '../../src/library/postgres-similar-items-query.js';
import { buildPostgresItemPageQuery } from '../../src/database/postgres-item-query.js';
import { createTmdbMovieSimilarProvider } from '../../plugins/tmdb/similar.js';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { exportCurrentSqlite, transferDatabase } from '../../src/migration/database-transfer.js';
import { mapRecord } from '../../src/library/records.js';
import { nativeTextBytes } from '../../src/database/native-text.js';

const root = new URL('./fixtures/movie-similar/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const id = value => `14000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, type === 'DateTime' ? '2026-10-09 00:00:00' : column.nullable ? null
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
}));
const typeNames = { Movie: 'MediaBrowser.Controller.Entities.Movies.Movie', Trailer: 'MediaBrowser.Controller.Entities.Trailer',
  Series: 'MediaBrowser.Controller.Entities.TV.Series', LiveTvProgram: 'MediaBrowser.Controller.LiveTv.LiveTvProgram' };

async function verifyFile(entry) {
  assert.equal(entry.available, true, entry.filename);
  const bytes = await readFile(entry.filename);
  assert.equal(bytes.length, entry.bytes, entry.filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.filename);
}

test('movie Similar oracle seals native-only output, shared input, source pin and actual runtime', async () => {
  assert.equal(provenance.candidateVerified, false);
  assert.equal(provenance.native.sha256, 'bf9949376bb9c599fc1fe44c6061a88c2a4a264bc06d01847873dacc6f3870fb');
  assert.equal(createHash('sha256').update(await readFile(new URL('provenance.json', root))).digest('hex'),
    '57bf53eb3a6f8d963cbeab510339cdbf04061ef52028678aca162a232ceecfeb');
  assert.equal(native.candidateVerified, false);
  assert.match(native.boundary, /Actual pinned MovieSimilarItemsProvider with concrete BaseItemRepository and EF Core SQLite/u);
  assert.equal(provenance.jellyfin.commit, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  const git = args => execFileSync('git', ['-C', provenance.jellyfin.source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), provenance.jellyfin.commit);
  assert.equal(git(['status', '--short']), '');
  for (const entry of [provenance.record, provenance.raw, provenance.native, provenance.dotnet, provenance.jellyfinDll,
    ...provenance.files, ...provenance.resolution, ...provenance.jellyfin.sources]) await verifyFile(entry);
  for (const entry of [...native.assemblies, native.nativeSqlite]) {
    const bytes = await readFile(entry.path);
    if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.path);
  }
  const record = JSON.parse(await readFile(provenance.record.filename, 'utf8'));
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
  assert.equal(native.inputSha256, provenance.files.find(entry => entry.filename.endsWith('input.json')).sha256);
  assert.equal(native.results.length, input.cases.length);
});

test('relational identifier scopes bind parameters and preserve native IsMovie type semantics', () => {
  const database = { dialect: 'postgres', schemaName: 'movie_shape' };
  const plan = buildPostgresItemPageQuery(database, { includeitemtypes: ['Movie', 'LiveTvProgram'], ismovie: true }, {
    itemIdsPlan: { text: 'SELECT "Id" FROM "other" WHERE "Name" = $1', values: ['bound-name'] },
  });
  assert.match(plan.text, /requested_item_ids AS/u);
  assert.ok(plan.values.includes('bound-name'));
  assert.doesNotMatch(plan.text, /i\."IsMovie" IS TRUE/u);
  const program = buildPostgresItemPageQuery(database, { includeitemtypes: ['LiveTvProgram'], ismovie: true });
  assert.match(program.text, /i\."IsMovie" IS TRUE/u);
  const negative = buildPostgresItemPageQuery(database, { includeitemtypes: ['Movie'], ismovie: false });
  assert.match(negative.text, /i\."IsMovie" IS FALSE/u);
  assert.throws(() => buildPostgresItemPageQuery(database, {}, { itemIdsPlan: { text: '', values: [] } }), /identifier/u);
});

test('Movie/Trailer weighted Similar matches actual native provider on real PostgreSQL', async t => {
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'A real PostgreSQL instance is required; this test must not skip.');
  const schema = `movie_similar_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    await db.client.query(`DROP SCHEMA ${q(schema)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${q(schema + '__mm')} CASCADE`);
    await db.close();
  });
  for (const key of [80, 81]) await db.insert('Users', {
    ...blank('Users'), Id: id(key), Username: `movie-${key}`, NormalizedUsername: `MOVIE-${key}`,
  });
  for (const row of input.items) await db.insert('BaseItems', {
    ...blank('BaseItems'), Id: id(row.id), Type: typeNames[row.type], Data: '{}',
    Name: row.name, CleanName: row.name, SortName: `reverse-${String(1000 - row.id).padStart(4, '0')}`,
    PresentationUniqueKey: Object.hasOwn(row, 'puk') ? row.puk : `puk-${row.id}`,
    TopParentId: id(row.top ?? 90), PrimaryVersionId: row.primary ? id(row.primary) : null,
    OwnerId: row.owner ? id(row.owner) : null, ExtraType: row.extraType ?? null,
    IsMovie: row.isMovie ?? true, IsFolder: row.type === 'Series', MediaType: 'Video',
  });
  for (const value of input.values) {
    await db.insert('ItemValues', { ItemValueId: id(value.id), Type: value.type, Value: value.value, CleanValue: value.clean });
    for (const item of value.items) await db.insert('ItemValuesMap', { ItemId: id(item), ItemValueId: id(value.id) });
  }
  for (const person of input.people) {
    await db.insert('Peoples', { Id: id(person.id), Name: person.name, PersonType: person.type });
    for (const [list, rows] of [[0, person.items], [1, person.duplicateItems ?? []]]) {
      for (const item of rows) await db.insert('PeopleBaseItemMap', {
        ItemId: id(item), PeopleId: id(person.id), ListOrder: list, SortOrder: list, Role: `role-${list}`,
      });
    }
  }
  for (const key of input.played) await db.insert('UserData', {
    ...blank('UserData'), ItemId: id(key), UserId: id(80), CustomDataKey: `puk-${key}`, Played: true, PlayCount: 1,
  });
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
    if (expected.error) {
      assert.equal(expected.parameter, 'user');
      await assert.rejects(queryPostgresMovieSimilarRows(db, options), /requires a user/u);
    } else {
      const rows = await queryPostgresMovieSimilarRows(db, options);
      assert.deepEqual(rows.map(row => row.Id), expected.ids, scenario.name);
      assert.deepEqual(rows.map(row => row.Name), expected.items, scenario.name);
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
  assert.match(JSON.stringify(plan), /mm_runtime_item_values_map|IX_ItemValuesMap/u, 'weighted matching uses indexed relationships');
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

test('Live TV queries match actual native type branches, overfetch and unmapped Program behavior', async () => {
  const program = mapRecord({ ...blank('BaseItems'), Id: id(999), Type: typeNames.LiveTvProgram,
    Data: '{"IsMovie":false,"IsSeries":true}', IsMovie: true, IsSeries: false,
    EpisodeTitle: 'Stored episode', IsRepeat: true });
  assert.equal(program.IsMovie, true); assert.equal(program.IsSeries, false);
  assert.equal(program.EpisodeTitle, 'Stored episode'); assert.equal(program.IsRepeat, true);
  const scenarios = [
    { IsMovie: true, IsSeries: true, enableExternalContent: true },
    { IsMovie: true, IsSeries: false, enableExternalContent: false },
    { IsMovie: false, IsSeries: true, enableExternalContent: true },
    { IsMovie: false, IsSeries: false, enableExternalContent: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const expected = native.liveTv[index];
    const query = localGenreTagSimilarQuery({ Type: 'LiveTvProgram', Genres: ['Drama'], Tags: ['Epic'], ...scenario },
      { limit: 7, excludeItemIds: [id(999)] }, scenario);
    assert.deepEqual(query.includeItemTypes, expected.includeItemTypes, expected.name);
    assert.deepEqual(query.genres, expected.genres, expected.name);
    assert.deepEqual(query.tags, expected.tags, expected.name);
    assert.equal(query.limit, expected.preparedLimit, expected.name);
    assert.equal(expected.IsMovie, null); assert.equal(expected.IsPlayed, null);
    assert.deepEqual(expected.order, [{ key: 'Random', direction: 'Ascending' }]);
    if (query.matchNoItems) assert.deepEqual(await queryPostgresLocalSimilarRows({ dialect: 'postgres' }, query), []);
  }
});

test('TMDb Movie Similar references and transport requests match actual native TMDbLib provider', async t => {
  let mode = 'success'; const requests = [];
  const client = new TmdbClient({ baseUrl: 'http://tmdb.invalid/3/', apiKey: 'oracle-key',
    configuration: { SimilarItemsCacheDays: 2 }, fetch: async request => {
      requests.push(request.toString());
      if (request.pathname.endsWith('/configuration')) return Response.json({ images: {
        base_url: 'http://images.invalid/', secure_base_url: 'https://images.invalid/',
        backdrop_sizes: ['original'], logo_sizes: ['original'], poster_sizes: ['original'],
        profile_sizes: ['original'], still_sizes: ['original'],
      }, change_keys: [] });
      if (mode === 'failure') throw new Error('Controlled movie transport failure');
      return Response.json(mode === 'empty' ? { page: 1, results: [], total_pages: 3 }
        : request.searchParams.get('page') === '2' ? { page: 2, results: [{ id: 33, title: 'Third' }], total_pages: 2 }
          : { page: 1, results: [{ id: 31, title: 'First' }, { id: 32, title: 'Second' }], total_pages: 2 });
    } });
  t.after(() => client.close());
  const provider = createTmdbMovieSimilarProvider({ client });
  assert.equal(provider.cacheDuration(), native.tmdbMovie.cacheMilliseconds);
  const requestShape = text => {
    const url = new URL(text);
    return { origin: url.origin, path: url.pathname, query: [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)) };
  };
  for (const expected of native.tmdbMovie.cases) {
    mode = expected.mode; requests.length = 0;
    const references = [];
    for await (const reference of provider.getReferences({ ProviderIds: expected.value ? { Tmdb: expected.value } : {} }, {})) {
      references.push(reference);
    }
    assert.deepEqual(references, expected.references, expected.name);
    assert.deepEqual(requests.map(requestShape), expected.requests.map(requestShape), expected.name);
  }
});

test('ItemValues native insertion order survives SQLite/PostgreSQL exchange and runtime reinsertion', async t => {
  assert.ok(process.env.MEDIAMANAGER_TEST_POSTGRES, 'A real PostgreSQL instance is required.');
  const schema = `movie_value_order_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const sqlite = new SqliteDatabase(':memory:', { create: true });
  const directory = await mkdtemp(path.join(tmpdir(), 'mediamanager-movie-value-order-'));
  t.after(async () => {
    sqlite.close();
    await db.client.query(`DROP SCHEMA ${q(schema)} CASCADE`);
    await db.client.query(`DROP SCHEMA ${q(schema + '__mm')} CASCADE`);
    await db.close();
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
  const output = path.join(directory, 'current.sqlite');
  await exportCurrentSqlite(db, output, { batchSize: 1, testOnlyAllowSyntheticEnvelope: true });
  const exported = new SqliteDatabase(output);
  try {
    const after = await exported.relationRowsInInsertionOrder('ItemValues', { limit: 10 });
    assert.deepEqual(after.rows, before.rows);
  } finally { exported.close(); }
});
