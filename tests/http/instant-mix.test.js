import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { cleanValue, guid, idKey } from '../../src/library/records.js';
import { nativeMusicGenreIdentity } from '../../src/library/identity.js';
import { withMusicGenreSelector } from '../../src/library/music-mix-genres.js';
import { seedPostgresRuntime } from '../sessions/postgres-seed.js';

const fixtureRoot = new URL('./fixtures/instant-mix/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixtureRoot))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), provenance = JSON.parse(provenanceBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = index => `ac310000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const blank = name => Object.fromEntries(tableDefinition(name).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, column.nullable ? null : type === 'DateTime' ? '2026-10-01 00:00:00'
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
}));
const nativeType = type => type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist'
  : `MediaBrowser.Controller.Entities.${({ Audio: 'Audio.Audio', MusicAlbum: 'Audio.MusicAlbum', MusicArtist: 'Audio.MusicArtist',
    MusicGenre: 'Audio.MusicGenre', Movie: 'Movies.Movie' })[type] ?? type}`;
const projection = body => ({ ...body, Items: body.Items.map(item => ({
  Id: item.Id, Name: item.Name, Type: item.Type, ...(Object.hasOwn(item, 'Overview') ? { Overview: item.Overview } : {}),
})).toSorted((a, b) => a.Id.localeCompare(b.Id)) });
const problemProjection = text => { const { traceId: _traceId, ...body } = JSON.parse(text); return body; };

test('InstantMix HTTP recorder seals native MVC, manager, traversal, lookup and controlled DTO boundaries', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256);
  assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.inputSha256, provenance.inputSha256);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  assert.equal(provenance.completeBuildInputClosure, false); assert.equal(provenance.phaseAcceptance, false);
  assert.equal(provenance.cases, input.requests.length); assert.equal(native.results.length, 74);
  for (const flag of ['actualMvc', 'actualInstantMixController', 'actualMusicManager', 'actualFolderTraversal',
    'actualLibraryLookup', 'actualMusicGenreIdentity']) assert.equal(native[flag], true, flag);
  assert.equal(native.actualDtoService, false); assert.equal(native.databaseOpened, true);
  assert.equal(native.httpDatabaseOpened, false);
  assert.deepEqual(native.sqliteRuntime, provenance.sqliteRuntime);
  for (const flag of ['actualMusicManager', 'actualLibraryManager', 'actualRepository', 'sqliteOpened'])
    assert.equal(native.repositoryProbe[flag], true, flag);
  for (const source of provenance.oracleSources) {
    const filename = source.name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url)
      : new URL(source.name, fixtureRoot);
    assert.equal(hash(await readFile(filename)), source.sha256, source.name);
  }
  const result = name => native.results.find(entry => entry.name === name);
  assert.equal(JSON.parse(result('genre name nonmatching selector').body).TotalRecordCount, 0);
  assert.equal(JSON.parse(result('genre lookup reuses curated name').body).Items[0].Id, idKey(id(12)));
  assert.equal(result('api key no selected user folder').status, 400);
  assert.equal(result('api key no selected user view').status, 500);
  assert.deepEqual(result('generic item 37').calls.filter(call => call.method === 'GetMusicGenre').map(call => call.name), ['Novel']);
});

async function setup(t) {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = 'instant_mix_http_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-instant-mix-http-'));
  const programDataPath = path.join(root, 'instance');
  const database = await PostgresDatabase.open({ connectionString, schema, create: true, max: 3 });
  const errors = [], lookups = [], additions = [], boundRequests = [];
  const runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(root, 'config'),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableNormalizedItemByNameIds: true,
      EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    serverId: 'instant-mix-http', onError: error => errors.push({ status: error.status ?? 500, message: error.message }) });
  t.after(async () => {
    await runtime.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try {
      await cleanup.client.query(`DROP SCHEMA ${quoteIdentifier(schema)}, ${quoteIdentifier(schema + '__mm')} CASCADE`);
      assert.deepEqual((await cleanup.client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)',
        [[schema, schema + '__mm']])).rows, []);
    } finally { await cleanup.close(); }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mediamanager-instant-mix-http-'));
    await rm(root, { recursive: true, force: true });
  });
  const admin = await runtime.users.createUser({ Name: 'InstantMixAdmin', Password: 'password' });
  const reader = await runtime.users.createUser({ Name: 'InstantMixReader', Password: 'password' });
  for (const [user, administrator] of [[admin, true], [reader, false]]) {
    const actual = await runtime.users.getUser(user.Id);
    await runtime.users.updatePolicy(user.Id, { ...actual.Policy, IsAdministrator: administrator, EnableAllFolders: true });
  }
  const login = async name => (await runtime.authentication.login({ Username: name, Pw: 'password' }, {
    Client: 'InstantMixHttp', Device: 'Fixture', DeviceId: name, Version: '1',
  }, { remoteEndPoint: '127.0.0.1' })).AccessToken;
  const tokens = { admin: await login('InstantMixAdmin'), reader: await login('InstantMixReader'),
    apiKey: (await runtime.apiKeys.create('InstantMix HTTP fixture')).AccessToken };
  let current = {};
  const getMusicGenre = runtime.library.getMusicGenre.bind(runtime.library);
  runtime.library.getMusicGenre = async name => {
    lookups.push(name);
    if (name === 'Blocked') throw new Error('Controlled genre failure');
    return getMusicGenre(name);
  };
  runtime.library.on('ItemAdded', ({ Item }) => additions.push({ id: idKey(Item.Id), name: Item.Name }));
  const queryInstantMix = runtime.library.queryInstantMix.bind(runtime.library);
  runtime.library.queryInstantMix = async (query, options) => {
    boundRequests.push({ query, user: options.user?.Id ?? null });
    return queryInstantMix(query, options);
  };
  const load = runtime.library.load.bind(runtime.library);
  runtime.library.load = (db, user, options) => {
    assert.ok(Array.isArray(options?.baseRows), 'InstantMix attempted to load the complete library');
    return load(db, user, options);
  };
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const q = name => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const state = {
    runtime, database, errors, lookups, additions, boundRequests,
    async seed(sample) {
      current = sample; lookups.length = 0; additions.length = 0; boundRequests.length = 0; errors.length = 0;
      runtime.itemCreation.close();
      await database.client.query(`TRUNCATE ${q('BaseItems')}, ${q('ItemValues')} CASCADE`);
      const rows = input.items.map((item, index) => ({ ...blank('BaseItems'), Id: id(item.id), Type: nativeType(item.type),
        Name: item.name, CleanName: cleanValue(item.name), SortName: String(index).padStart(5, '0'),
        Overview: 'Controlled overview', Genres: item.genres.join('|'),
        Data: JSON.stringify(item.type === 'UserView' ? { ViewType: 'books', DisplayParentId: id(item.displayParent) }
          : item.type === 'Playlist' ? { OpenAccess: true } : {}),
        IsFolder: ['Folder', 'MusicAlbum', 'Playlist', 'UserView'].includes(item.type),
        MediaType: ['Audio', 'AudioBook'].includes(item.type) ? 'Audio' : item.type === 'Movie' ? 'Video' : 'Unknown',
        ParentId: item.parent ? id(item.parent) : null,
        Path: item.type === 'UserView' ? path.join(programDataPath, 'metadata/views', idKey(id(item.id))) : `Z:\\FixtureMix\\${item.id}`,
        PresentationUniqueKey: idKey(id(item.id)),
      }));
      if (current.curated) {
        const identity = nativeMusicGenreIdentity('Rock', runtime.library.options);
        rows.push({ ...blank('BaseItems'), Id: identity.Id, Path: identity.StoredPath, Type: nativeType('MusicGenre'), Name: 'Jazz', CleanName: 'jazz',
          SortName: 'jazz', Data: '{"Retained":"curated"}' });
      }
      await seedPostgresRuntime(database, { BaseItems: rows });
      const genreValues = new Map();
      for (const definition of input.items) for (const genre of definition.genres) {
        if (!genreValues.has(genre)) {
          const ItemValueId = randomUUID(); genreValues.set(genre, ItemValueId);
          await database.insert('ItemValues', { ItemValueId, Type: 2, Value: genre, CleanValue: cleanValue(genre) });
        }
        await database.insert('ItemValuesMap', { ItemId: id(definition.id), ItemValueId: genreValues.get(genre) });
      }
      const byNumber = new Map(input.items.map(item => [item.id, item]));
      for (const definition of input.items) {
        let parent = definition.parent;
        while (parent) {
          await database.insert('AncestorIds', { ItemId: id(definition.id), ParentItemId: id(parent) });
          parent = byNumber.get(parent)?.parent;
        }
        for (const [index, child] of (definition.links ?? []).entries())
          await database.insert('LinkedChildren', { ParentId: id(definition.id), ChildId: id(child), ChildType: 0, SortOrder: index });
      }
      if (sample.warmSource) {
        await runtime.itemCreation.getItemById(id(sample.warmSource));
        if (sample.removeWarmSource) await database.delete('BaseItems', { Id: id(sample.warmSource) });
        else await database.update('BaseItems', { Id: id(sample.warmSource) }, { Name: 'Repository replacement', Genres: 'Jazz',
          ...(sample.replaceWarmType ? { Type: nativeType('Movie'), IsFolder: false, MediaType: 'Video' } : {}) });
      }
    },
    async request(sample) {
      const pathname = sample.path.replaceAll(id(1), admin.Id).replaceAll(id(2), reader.Id);
      const token = sample.anonymous ? null : sample.apiKey ? tokens.apiKey : sample.reader ? tokens.reader : tokens.admin;
      const response = await fetch(origin + pathname, { headers: token ? { Authorization: `MediaBrowser Token="${token}"` } : {} });
      return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
    },
  };
  return state;
}

test('postgres: InstantMix routes match native HTTP binding, lookup order, selector membership and totals', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const state = await setup(t), observations = [];
  try {
    for (const sample of input.requests) await t.test(sample.name, async () => {
      await state.seed(sample);
      const actual = await state.request(sample);
      const expected = native.results.find(result => result.name === sample.name);
      const observation = { name: sample.name, ...actual, lookups: [...state.lookups], additions: [...state.additions],
        boundRequests: [...state.boundRequests], errors: [...state.errors] };
      observations.push(observation);
      assert.equal(actual.status, expected.status, sample.name);
      assert.equal(actual.contentType, expected.contentType, sample.name);
      assert.deepEqual(state.lookups, expected.calls.filter(call => call.method === 'GetMusicGenre').map(call => call.name));
      if (expected.status === 200) {
        const actualBody = JSON.parse(actual.body), expectedBody = JSON.parse(expected.body);
        assert.deepEqual(projection(actualBody), projection(expectedBody));
        if (expectedBody.Items.length && ['Audio', 'AudioBook'].includes(expectedBody.Items[0].Type)) {
          const sourceNumber = Number(sample.path.match(/\/([0-9a-f-]{36})\/InstantMix/iu)?.[1].slice(-12)
            ?? new URL(sample.path, 'http://fixture').searchParams.get('Id')?.slice(-12));
          if (['Audio', 'AudioBook'].includes(input.items.find(item => item.id === sourceNumber)?.type))
            assert.equal(actualBody.Items[0].Id, idKey(id(sourceNumber)));
        }
        assert.equal(new Set(actualBody.Items.map(item => item.Id)).size, actualBody.Items.length);
        const dtoCall = expected.calls.find(call => call.method === 'GetBaseItemDtos');
        if (dtoCall) {
          const query = state.boundRequests[0].query;
          assert.equal(query.enableimages ?? true, dtoCall.EnableImages);
          assert.equal(query.enableuserdata ?? true, dtoCall.EnableUserData);
          assert.equal(query.imagetypelimit ?? 2147483647, dtoCall.ImageTypeLimit);
          assert.deepEqual(query.fields, dtoCall.fields.filter(field => !/^\d+$/u.test(field)));
          if (query.enableimagetypes) assert.deepEqual(query.enableimagetypes, dtoCall.imageTypes);
          else assert.equal(dtoCall.imageTypes.length, 13, 'An explicit numeric image selector must not become the default');
          assert.ok(actualBody.Items.every(item => Object.hasOwn(item, 'BackdropImageTags')
            === Boolean(dtoCall.EnableImages && dtoCall.ImageTypeLimit > 0 && dtoCall.imageTypes.includes('Backdrop'))));
          assert.ok(actualBody.Items.every(item => Object.hasOwn(item, 'UserData')
            === Boolean((query.enableuserdata ?? true) && state.boundRequests[0].user)));
        }
      } else if (expected.contentType?.includes('json')) assert.deepEqual(problemProjection(actual.body), problemProjection(expected.body));
      else assert.equal(actual.body, expected.body);
      const successfulIds = expected.calls.filter(call => call.method === 'GetMusicGenre' && call.id).map(call => call.id);
      const existing = new Set([idKey(id(23)), idKey(id(28))]);
      if (sample.curated) existing.add(idKey(nativeMusicGenreIdentity('Rock', state.runtime.library.options).Id));
      assert.deepEqual(state.additions.map(item => item.id).toSorted(), [...new Set(successfulIds.map(idKey))]
        .filter(value => !existing.has(value)).toSorted(), 'Successful lookups must persist and emit Added before selection');
      assert.deepEqual((await state.runtime.store.run(db => db.client.query(`SELECT relname FROM pg_class
        WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_mix_%'`))).rows, []);
    });
  } finally {
    if (process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE) {
      const root = path.resolve(process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'http.json'), JSON.stringify({ fixtureSha256: hash(nativeBytes), observations,
        actualCandidateHttp: true, candidatePostgres: true, nativeDtoControlled: true, nativeAuthenticationControlled: true,
        nativeHttpDatabaseOpened: false, fullDtoDifferential: false, phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
    }
  }
});

test('postgres: genre ID selectors match native LibraryManager and SQLite persisted-name relations', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = 'instant_mix_selector_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    try { await database.client.query(`DROP SCHEMA ${quoteIdentifier(schema)}, ${quoteIdentifier(schema + '__mm')} CASCADE`); }
    finally { await database.close(); }
  });
  const probe = native.repositoryProbe;
  await seedPostgresRuntime(database, {
    BaseItems: probe.rows.map(row => ({ ...blank('BaseItems'), ...row, Id: guid(row.Id), SortName: row.Name, Data: '{}',
      MediaType: row.Type.endsWith('.Audio') || row.Type.endsWith('.AudioBook') ? 'Audio' : 'Unknown' })),
    ItemValues: probe.values.map(row => ({ ...row, ItemValueId: guid(row.ItemValueId) })),
    ItemValuesMap: probe.maps.map(row => ({ ItemId: guid(row.ItemId), ItemValueId: guid(row.ItemValueId) })),
  });
  const observations = [];
  for (const sample of probe.observations) await t.test(sample.name, async () => {
    const expected = sample.ids.map(idKey).toSorted();
    await database.withConnection(async db => {
      const query = { includeitemtypes: ['Audio'], sortby: ['Random'], limit: 200 };
      const options = { groupByPresentationKey: false };
      const direct = (await queryPostgresItemPage(db, { ...query, genreids: sample.genreIds }, options)).rows.map(row => idKey(row.Id)).toSorted();
      const lookups = [];
      const planned = await withMusicGenreSelector(db, { getMusicGenre: async name => {
        lookups.push(name); return { Id: name };
      } }, [sample.genreIds], async genreIdsPlan => (await queryPostgresItemPage(db, query, { ...options, genreIdsPlan }))
        .rows.map(row => idKey(row.Id)).toSorted());
      observations.push({ name: sample.name, direct, planned, lookups });
      assert.deepEqual(direct, expected);
      // MusicManager excludes Guid.Empty returned by a name lookup before its
      // genre-ID query, while a direct ID selector preserves that ID.
      assert.deepEqual(planned, sample.genreIds.length === 1 && /^0+$/.test(idKey(sample.genreIds[0]))
        ? probe.observations.find(entry => entry.name === 'empty selector').ids.map(idKey).toSorted() : expected);
      assert.deepEqual(lookups, sample.genreIds);
      assert.deepEqual((await db.client.query(`SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema()
        AND relname LIKE 'mm_mix_%'`)).rows, []);
    });
  });
  if (process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE) {
    const root = path.resolve(process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'genre-selectors.json'), JSON.stringify({ fixtureSha256: hash(nativeBytes), observations,
      actualNativeSqlite: true, candidatePostgres: true, phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
  }
});
