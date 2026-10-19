import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { CollectionPostScanTask } from '../../src/library/collection-post-scan-task.js';
import { buildPostgresCollectionRootQuery, buildPostgresCollectionMoviePageQuery,
  buildPostgresCollectionBoxSetQuery, createPostgresCollectionMaintenanceSource } from '../../src/library/postgres-collection-maintenance.js';
import { guid } from '../../src/library/records.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
const text = value => value == null ? null : decodeNativeTextBytes(value);
const nativeId = value => guid(text(value));
async function setupCollectionQueryFixture(t) {
  const database = await createPostgresTestDatabase(null, 'collection_query'), store = new DomainStore(database);
  t.after(async () => { await dropPostgresTestDatabase(database); await store.close(); });
  const seed = async ({ items }) => {
    for (const [index, specification] of items.entries()) {
      const { key, type, parent, ancestors, ...fields } = specification;
      const base = { Id: fields.Id, Name: fields.Name ?? key, SortName: fields.SortName ?? String(index).padStart(3, '0'),
        Type: 'MediaBrowser.Controller.Entities.' + (['Movie', 'BoxSet'].includes(type) ? 'Movies.' : '') + type,
        ParentId: parent ? items.find(item => item.key === parent).Id : null,
        IsFolder: ['AggregateFolder', 'Folder', 'BoxSet'].includes(type), IsMovie: type === 'Movie',
        MediaType: fields.MediaType, IsVirtualItem: fields.IsVirtualItem ?? false,
        PrimaryVersionId: fields.PrimaryVersionId, DateCreated: '2026-10-14 00:00:00.0000000',
        DateModified: '2026-10-14 00:00:00.0000000', Data: JSON.stringify({ TmdbCollectionName: fields.TmdbCollectionName }) };
      await database.insert('BaseItems', postgresTestRow('BaseItems', base));
    }
    for (const specification of items) for (const ancestor of specification.ancestors ?? []) await database.insert('AncestorIds',
      { ItemId: specification.Id, ParentItemId: items.find(item => item.key === ancestor).Id });
  };
  return { database, store, seed };
}

const fixture = new URL('./fixtures/collection-post-scan/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixture))));
const samples = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), provenance = JSON.parse(provenanceBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const id = number => 'bc100000-0000-0000-0000-' + String(number).padStart(12, '0');
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const manager = operations => ({ admitPostScanOperation: () => ({ ...operations, release() {} }) });

test('Collection post-scan seals the actual task and its controlled dependency boundary', async () => {
  assert.equal(hash(inputBytes), provenance.inputSha256); assert.equal(hash(nativeBytes), provenance.nativeSha256);
  assert.equal(native.inputSha256, provenance.inputSha256); assert.equal(samples.length, 22); assert.equal(native.results.length, 22);
  assert.equal(native.actualCollectionPostScanTask, true);
  assert.equal(native.repositoryBoxSetsAndCachedManagerItemsAreIndependent, true);
  assert.equal(provenance.fullLibraryManagerExecution, false); assert.equal(native.rootAndRepositoryControlled, true);
  assert.equal(native.collectionManagerControlled, true); assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(provenance.completeBuildInputClosure, false); assert.equal(provenance.phaseAcceptance, false);
  for (const source of provenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256, source.name);
  if (provenance.recorder) assert.equal(hash(await readFile(provenance.recorder.filename)), provenance.recorder.sha256);
  for (const source of provenance.sources) {
    assert.equal(hash(await readFile(path.join('D:/jellyfin', source.path))), source.sha256, source.path);
    assert.equal(source.designatedSourceMatchesOracleBuildCopy, true);
  }
});

async function withDatabase(t) {
  const schema = 'collection_task_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  t.after(async () => {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`); await store.close();
  });
  return { database, store };
}

for (const [sampleIndex, sample] of samples.entries()) test(`postgres: Collection post-scan native ${sample.Name}`, pg, async t => {
  const { store } = await withDatabase(t), expected = native.results[sampleIndex];
  const calls = [], progress = [], logs = []; let created = 0, failure;
  await store.run(async db => {
    await db.client.query(`CREATE TEMP TABLE fixture_roots ("Ordinal" bigint, "Id" bytea, "Name" bytea, "Enabled" boolean);
      CREATE TEMP TABLE fixture_movies ("RootOrdinal" bigint, "Ordinal" bigint, "Id" bytea, "CollectionName" bytea, "PrimaryVersionId" bytea);
      CREATE TEMP TABLE fixture_boxes ("Ordinal" bigint, "Id" bytea, "Name" bytea)`);
    await db.client.query({ text: `INSERT INTO fixture_roots SELECT ordinal, convert_to($2 || lpad(ordinal::text, 12, '0'), 'UTF8'),
      convert_to(definition ->> 'Name', 'UTF8'), COALESCE((definition ->> 'Enabled')::boolean, true)
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entry(definition, ordinal)`, values: [JSON.stringify(sample.Libraries ?? []), id(0).slice(0, -12)] });
    await db.client.query({ text: `INSERT INTO fixture_movies SELECT library.ordinal, movie.ordinal,
      convert_to($2 || lpad(movie.definition ->> 'Number', 12, '0'), 'UTF8'), convert_to(movie.definition ->> 'Collection', 'UTF8'), convert_to(movie.definition ->> 'Primary', 'UTF8')
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS library(definition, ordinal)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(library.definition -> 'Movies', '[]'::jsonb))
        WITH ORDINALITY AS movie(definition, ordinal)`, values: [JSON.stringify(sample.Libraries ?? []), id(0).slice(0, -12)] });
    await db.client.query({ text: `INSERT INTO fixture_boxes SELECT ordinal,
      convert_to($2 || lpad((9999 + ordinal)::text, 12, '0'), 'UTF8'), convert_to(definition #>> '{}', 'UTF8')
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entry(definition, ordinal)`, values: [JSON.stringify(sample.Boxes ?? []), id(0).slice(0, -12)] });
    const source = {
      getRootFolder() { if (sample.FailRoot) throw new Error('Controlled root failure'); return { Id: id(9999) }; },
      rootQuery: () => ({ text: 'SELECT * FROM fixture_roots ORDER BY "Ordinal"', values: [] }),
      getLibraryOptions(root) { calls.push({ action: 'options', Name: root.Name }); return { AutomaticallyAddToCollection: root.Enabled }; },
      moviePageQuery(_db, root, query) {
        calls.push({ action: 'movies', Name: root.Name, ParentId: guid(query.ParentId), ParentType: 10,
          includeTypes: query.IncludeItemTypes.map(name => ({ Movie: 13 })[name]), MediaTypes: query.MediaTypes.map(name => ({ Video: 1 })[name]),
          IsVirtualItem: query.IsVirtualItem, order: query.OrderBy, StartIndex: query.StartIndex, Limit: query.Limit, Recursive: query.Recursive });
        if (sample.FailMovies) throw new Error('Controlled Movie selection failure');
        return { text: 'SELECT "Ordinal", "Id", "CollectionName", "PrimaryVersionId" FROM fixture_movies WHERE "RootOrdinal" = $1 ORDER BY "Ordinal" LIMIT $2 OFFSET $3',
          values: [root.Ordinal, query.Limit, query.StartIndex] };
      },
      boxSetQuery(_db, query) {
        calls.push({ action: 'boxsets', includeTypes: query.IncludeItemTypes.map(name => ({ BoxSet: 5 })[name]),
          CollapseBoxSetItems: query.CollapseBoxSetItems, Recursive: query.Recursive });
        if (sample.FailBoxes) throw new Error('Controlled BoxSet selection failure');
        return { text: 'SELECT * FROM fixture_boxes ORDER BY "Ordinal"', values: [] };
      },
    };
    const collections = {
      async create(options) {
        calls.push({ action: 'create', Name: options.Name, IsLocked: options.IsLocked ?? false,
          ParentId: options.ParentId ?? null, ItemIdList: options.ItemIdList ?? [], ProviderIds: options.ProviderIds ?? {}, UserIds: options.UserIds ?? [] });
        if (sample.FailCreate === options.Name) throw new Error('Controlled creation failure');
        if (sample.CancelCreate === options.Name) throw Object.assign(new Error('Controlled provider cancellation'), { code: 'cancelled' });
        return { Id: id(20000 + created++), Name: options.Name };
      },
      async addFromQuery(boxId, plan) {
        // The harness collects diagnostics; the task transfers only this SQL relation.
        const members = []; let offset = 0;
        while (true) {
          const page = (await db.client.query({ text: `SELECT * FROM (${plan.text}) members LIMIT 128 OFFSET $2`, values: [...plan.values, offset] })).rows;
          members.push(...page.map(row => nativeId(row.Id))); if (page.length < 128) break; offset += 128;
        }
        calls.push({ action: 'add', id: guid(boxId), members });
        if (sample.FailAdd) throw new Error('Controlled membership failure');
        // RenameFirstBox affects a separate native cache branch in the oracle.
      },
    };
    let released = 0;
    const task = new CollectionPostScanTask({ store, source,
      collections: { admitPostScanOperation: () => ({ ...collections, release() { released++; } }) },
      logger: { error: (error, message) => logs.push({ message, failure: error.message, code: error.code }) } });
    const controller = new AbortController(); if (sample.CancelInitial) controller.abort();
    try { await task.run({ signal: controller.signal, reportProgress(value) {
      progress.push(value); if (sample.FailProgressAt === progress.length) throw new Error('Controlled progress failure');
    } }); } catch (error) { failure = error; }
    assert.equal(released, 1);
    assert.deepEqual((await db.client.query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_collection_%'")).rows, []);
    await db.client.query('DROP TABLE fixture_boxes, fixture_movies, fixture_roots');
  });
  assert.deepEqual(calls, expected.calls); assert.deepEqual(progress, expected.progress);
  assert.equal(logs.length, expected.logs.length); assert.equal(failure?.message ?? null, expected.failure?.Message ?? null);
  if (process.env.MEDIAMANAGER_COLLECTION_POST_SCAN_EVIDENCE) {
    const directory = process.env.MEDIAMANAGER_COLLECTION_POST_SCAN_EVIDENCE; await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, String(sampleIndex).padStart(2, '0') + '.json'), JSON.stringify({
      name: sample.Name, calls, progress, logs, failure: failure && { message: failure.message },
      rootAndRepositoryControlled: true, collectionManagerControlled: true, phaseAcceptance: false,
    }, null, 2) + '\n', { flag: 'wx' });
  }
});

test('Collection post-scan requires a relational membership manager', () => {
  assert.throws(() => new CollectionPostScanTask({ store: {}, source: {}, collections: { add() {} } }), TypeError);
  assert.throws(() => createPostgresCollectionMaintenanceSource({ host: {} }), TypeError);
});

test('postgres: collection repository plans preserve page gates, typed Movie names and initial order', pg, async t => {
  const { database, store, seed } = await setupCollectionQueryFixture(t);
  await seed({ target: 'root', items: [
    { key: 'root', Id: id(5000), type: 'AggregateFolder' },
    { key: 'second', Id: id(5002), type: 'Folder', parent: 'root', SortName: '2' },
    { key: 'first', Id: id(5001), type: 'Folder', parent: 'root', SortName: '1' },
    { key: 'physical', Id: id(5003), type: 'Movie', parent: 'first', ancestors: ['first'], MediaType: 'Video', TmdbCollectionName: 'Saga' },
    { key: 'other-root', Id: id(5004), type: 'Movie', parent: 'second', ancestors: ['second'], MediaType: 'Video', TmdbCollectionName: 'Other' },
    { key: 'virtual', Id: id(5005), type: 'Movie', parent: 'first', ancestors: ['first'], MediaType: 'Video', IsVirtualItem: true, TmdbCollectionName: 'Saga' },
    { key: 'not-video', Id: id(5006), type: 'Movie', parent: 'first', ancestors: ['first'], MediaType: 'Audio', TmdbCollectionName: 'Saga' },
    { key: 'primary-empty', Id: id(5007), type: 'Movie', parent: 'first', ancestors: ['first'], MediaType: 'Video', PrimaryVersionId: id(0), TmdbCollectionName: 'Saga' },
    { key: 'first-box', Id: id(5008), type: 'BoxSet', SortName: 'a' },
    { key: 'second-box', Id: id(5009), type: 'BoxSet', SortName: 'b' },
    { key: 'broken-data', Id: id(5010), type: 'Movie', parent: 'first', ancestors: ['first'], MediaType: 'Video', TmdbCollectionName: 'Original' },
  ] });
  await database.client.query({ text: 'UPDATE "BaseItems" SET "Data" = $1 WHERE "Id" = $2', values: [nativeTextBytes('{"TmdbCollectionName":"Saga","TmdbCollectionName":{}}'), nativeTextBytes(id(5010))] });
  await store.run(async db => {
    const roots = await db.client.query(buildPostgresCollectionRootQuery(db, { Id: id(5000) }));
    assert.deepEqual(roots.rows.map(row => nativeId(row.Id)), [id(5001), id(5002)]);
    const movies = await db.client.query(buildPostgresCollectionMoviePageQuery(db, { Id: id(5001) }, { StartIndex: 0, Limit: 1000 }));
    assert.deepEqual(movies.rows.map(row => nativeId(row.Id)), [id(5003), id(5007), id(5010)]);
    assert.deepEqual(movies.rows.map(row => text(row.CollectionName)), ['Saga', 'Saga', null]);
    assert.equal(nativeId(movies.rows[1].PrimaryVersionId), id(0));
    const page = await db.client.query(buildPostgresCollectionMoviePageQuery(db, { Id: id(5001) }, { StartIndex: 1, Limit: 1 }));
    assert.deepEqual(page.rows.map(row => nativeId(row.Id)), [id(5007)]);
    const boxes = await db.client.query(buildPostgresCollectionBoxSetQuery(db));
    assert.deepEqual(boxes.rows.map(row => nativeId(row.Id)), [id(5008), id(5009)]);
  });
});

test('postgres: collection task consumes repository getters and freezes initial membership across repository writes', pg, async t => {
  const { database, store, seed } = await setupCollectionQueryFixture(t);
  await seed({ target: 'root', items: [
    { key: 'root', Id: id(6000), type: 'AggregateFolder' },
    { key: 'disabled', Id: id(6001), type: 'Folder', parent: 'root', SortName: '1' },
    { key: 'enabled', Id: id(6002), type: 'Folder', parent: 'root', SortName: '2' },
    { key: 'ignored', Id: id(6003), type: 'Movie', parent: 'disabled', ancestors: ['disabled'], MediaType: 'Video', TmdbCollectionName: 'Disabled' },
    { key: 'saga-a', Id: id(6004), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Saga' },
    { key: 'saga-b', Id: id(6005), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Saga' },
    { key: 'next', Id: id(6006), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Next' },
    { key: 'gamma-a', Id: id(6007), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Gamma' },
    { key: 'gamma-b', Id: id(6008), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Gamma' },
    { key: 'delta', Id: id(6009), type: 'Movie', parent: 'enabled', ancestors: ['enabled'], MediaType: 'Video', TmdbCollectionName: 'Delta' },
    { key: 'box', Id: id(6010), type: 'BoxSet', Name: 'Saga', SortName: 'a' },
  ] });
  const rootOptions = [], calls = [], progress = [];
  const source = createPostgresCollectionMaintenanceSource({ host: { getAggregateFolder: () => ({ Id: id(6000) }) },
    getLibraryOptions: parent => { rootOptions.push(guid(parent.Id)); return { AutomaticallyAddToCollection: guid(parent.Id) === id(6002) }; } });
  const task = new CollectionPostScanTask({ store, source, collections: manager({
    async create(options) {
      calls.push({ action: 'create', name: options.Name });
      // A separately persisted change cannot rename a captured initial object.
      await database.client.query({ text: 'UPDATE "BaseItems" SET "Name" = $1 WHERE "Id" = $2', values: [nativeTextBytes('Repository name'), nativeTextBytes(id(6010))] });
      return { Id: id(6011), Name: 'Delta' };
    },
    async addFromQuery(boxId, plan) {
      const members = await store.run(db => db.client.query(plan));
      calls.push({ action: 'add', id: guid(boxId), members: members.rows.map(row => nativeId(row.Id)) });
      // A later cache instance rename does not alter the captured initial Name.
    },
  }) });
  await task.run({ reportProgress: value => progress.push(value) });
  assert.deepEqual(rootOptions, [id(6001), id(6002)]);
  assert.deepEqual(calls, [
    { action: 'add', id: id(6010), members: [id(6004), id(6005)] },
    { action: 'create', name: 'Gamma' },
    { action: 'add', id: id(6011), members: [id(6007), id(6008)] },
  ]);
  assert.deepEqual(progress, [25, 50, 75, 100, 100]);
});

test('postgres: collection task keeps 257 roots and groups bounded and one large member relation in SQL', pg, async t => {
  const { store } = await withDatabase(t);
  await store.run(async db => {
    const query = db.client.query.bind(db.client), observations = [];
    db.client.query = async (...args) => {
      const result = await query(...args), text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/collection-maintenance-(root-page|group-page)/u.test(text)) { observations.push(result.rows.length); assert.ok(result.rows.length <= 128); }
      return result;
    };
    let created = 0, added = 0, moviePages = 0, lastProgress;
    const source = {
      getRootFolder: () => ({ Id: id(9999) }), getLibraryOptions: () => ({ AutomaticallyAddToCollection: true }),
      rootQuery: () => ({ text: `SELECT number AS "Ordinal", convert_to(lpad(number::text, 32, '0'), 'UTF8') AS "Id", convert_to(number::text, 'UTF8') AS "Name" FROM generate_series(1, 257) number`, values: [] }),
      moviePageQuery(_db, parent, options) {
        moviePages++;
        return { text: `SELECT number AS "Ordinal", convert_to(lpad((($1::bigint * 10000) + number)::text, 32, '0'), 'UTF8') AS "Id",
          convert_to('Group ' || $1::text, 'UTF8') AS "CollectionName", NULL::bytea AS "PrimaryVersionId"
          FROM generate_series(1, CASE WHEN $1::bigint = 1 THEN 2050 ELSE 2 END) number
          ORDER BY number LIMIT $2 OFFSET $3`, values: [parent.Ordinal, options.Limit, options.StartIndex] };
      },
      boxSetQuery: () => ({ text: 'SELECT NULL::bigint AS "Ordinal", NULL::bytea AS "Id", NULL::bytea AS "Name" WHERE false', values: [] }),
    };
    const task = new CollectionPostScanTask({ store, source, collections: manager({
      create: () => ({ Id: id(30000 + created++) }),
      async addFromQuery(_id, plan) {
        const count = Number((await db.client.query({ text: `SELECT count(*) AS "Count" FROM (${plan.text}) members`, values: plan.values })).rows[0].Count);
        assert.equal(count, added++ === 0 ? 2050 : 2);
      },
    }) });
    try { await task.run({ reportProgress: value => { lastProgress = value; } }); }
    finally { db.client.query = query; }
    assert.equal(created, 257); assert.equal(added, 257); assert.equal(moviePages, 259); assert.equal(lastProgress, 100);
    assert.deepEqual(observations, [128, 128, 1, 128, 128, 1]);
    assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_collection_%'")).rows, []);
  });
});
