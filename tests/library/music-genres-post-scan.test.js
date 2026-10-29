import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { guid, idKey } from '../../src/library/records.js';
import { nativeMusicGenreIdentity } from '../../src/library/identity.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { cloneNativeItemValue } from '../../src/library/native-item-value.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MusicGenresPostScanTask } from '../../src/library/music-genres-post-scan-task.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { metadataScanOptions } from '../../src/library/metadata-scan-service.js';
import { StorageError } from '../../src/storage/errors.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const fixtureRoot = new URL('./fixtures/music-genres-post-scan/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixtureRoot))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), provenance = JSON.parse(provenanceBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, column.nullable ? null : type === 'DateTime' ? '2026-10-01 00:00:00'
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
}));
const id = index => `ba320000-0000-0000-0000-${String(index).padStart(12, '0')}`;

for (const phase of ['lookup', 'refresh']) test(
  `postgres: MusicGenre caller cancellation during ${phase} stops later tasks and drains SQL resources`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
  }, async t => {
    const fixture = await setupChildrenFixture(t);
    const { database, store, library, linkedChildren, loadContext, configuration, host: metadata } = fixture;
    configuration.EnableNormalizedItemByNameIds = true;
    const sourceId = 'ba490000-0000-0000-0000-000000000001';
    const first = 'A caller cancellation music genre', later = 'Z untouched music genre';
    await fixture.seed({ target: 'source', items: [{ key: 'source', Id: sourceId, type: 'Audio',
      Name: 'Cancellation source', Genres: [first, later] }] });
    const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
    library.itemCreation = creator;
    const before = await database.rows('BaseItems'), calls = [], errors = [], progress = [];
    const relationTables = ['ItemValues', 'ItemValuesMap', 'LinkedChildren'];
    const beforeRelations = await Promise.all(relationTables.map(table => database.rows(table)));
    const controller = new AbortController();
    const reason = Object.assign(new Error('Controlled MusicGenre caller cancellation.'), { code: 'caller-music-genre-stop' });
    const lookup = library.getMusicGenre.bind(library);
    library.getMusicGenre = async name => {
      calls.push({ action: 'lookup', name });
      if (phase === 'lookup') { controller.abort(reason); controller.signal.throwIfAborted(); }
      return lookup(name);
    };
    let laterTask = 0, inheritedCleanup = 0;
    const task = new MusicGenresPostScanTask({ store, library, metadataScanner: {
      async refreshLiveItem(item, { signal }) {
        calls.push({ action: 'refresh', name: item.Name });
        assert.equal(signal.aborted, false);
        controller.abort(reason);
        assert.equal(signal.aborted, true);
        assert.deepEqual({ message: signal.reason.message, code: signal.reason.code },
          { message: reason.message, code: reason.code });
        signal.throwIfAborted();
      },
    }, logger: { error: error => errors.push({ name: error.name, message: error.message, code: error.code, stack: error.stack }) } });
    const postHost = Object.fromEntries(['getAggregateFolder', 'getUserRootFolder', 'clearIgnoreRuleCache', 'invalidateChildren',
      'refreshMetadata', 'validateChildren', 'withChildren', 'collectionDirectoryExists'].map(name => [name, async () => {}]));
    postHost.updateInheritedValues = async () => { inheritedCleanup++; };
    const lifecycle = new LibraryScanLifecycle({ host: postHost, monitor: { async stop() {}, async start() {} },
      postScanTasks: [task, { name: 'CleanDatabase', async run() { laterTask++; } }],
      logger: { error: error => errors.push({ name: error.name, message: error.message, code: error.code, stack: error.stack }) } });
    let result;
    await store.run(async db => {
      const temporaryTables = () => db.client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname");
      const original = (await temporaryTables()).rows;
      [result] = await Promise.allSettled([lifecycle.runPostScanTasks({ signal: controller.signal,
        reportProgress: value => progress.push(value) })]);
      assert.deepEqual((await temporaryTables()).rows, original, 'Cancellation must drop every actual MusicGenre TEMP table.');
    });
    t.diagnostic(JSON.stringify({ phase, outcome: result.status, reason: result.status === 'rejected'
      ? { name: result.reason?.name, message: result.reason?.message, code: result.reason?.code } : null,
      calls, errors, progress, laterTask, inheritedCleanup }));
    assert.equal(result.status, 'rejected');
    assert.deepEqual({ message: result.reason?.message, code: result.reason?.code }, { message: reason.message, code: reason.code });
    assert.deepEqual(calls, [{ action: 'lookup', name: first }, ...(phase === 'refresh' ? [{ action: 'refresh', name: first }] : [])]);
    assert.deepEqual([laterTask, inheritedCleanup], [0, 0]); assert.deepEqual(progress, []);
    assert.ok(errors.every(error => error.message === reason.message && error.code === reason.code),
      'Only this actual caller cancellation may be reported as a diagnostic.');
    const after = await database.rows('BaseItems');
    assert.deepEqual(after.find(row => guid(row.Id) === sourceId), before.find(row => guid(row.Id) === sourceId));
    assert.deepEqual(after.filter(row => guid(row.Id) !== sourceId).map(row => ({ Type: row.Type, Name: row.Name })),
      phase === 'refresh' ? [{ Type: 'MediaBrowser.Controller.Entities.Audio.MusicGenre', Name: first }] : [],
      'The completed first lookup is retained without admitting any later name.');
    assert.deepEqual(await Promise.all(relationTables.map(table => database.rows(table))), beforeRelations,
      'All original name and linked-child relations remain unchanged.');
    await metadata.close(); await creator.close(); await library.close();
    await linkedChildren.flushOwnedReleases(); await linkedChildren.flushReleases(); await linkedChildren.resourceGraph.flush();
    await linkedChildren.withSession(async db => {
      for (const table of ['sets', 'rows', 'pins', 'item_states', 'item_cohorts', 'folder_child_ids']) {
        assert.equal(BigInt((await db.client.query(`SELECT count(*) AS count FROM ${q(linkedChildren.schemaName)}.${q(table)}`)).rows[0].count), 0n, table);
      }
    });
    await linkedChildren.close();
    assert.deepEqual((await database.client.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [linkedChildren.schemaName])).rows, []);
  });

test('music genre post-scan recorder seals actual task, validator, names, SQLite and creation boundaries', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256);
  assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.inputSha256, provenance.inputSha256);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  assert.equal(provenance.completeBuildInputClosure, false); assert.equal(provenance.phaseAcceptance, false);
  for (const flag of ['actualPostScanTask', 'actualValidator', 'actualLibraryManager', 'actualRepository',
    'actualSqlitePersistence', 'metadataProviderControlled']) assert.equal(native[flag], true, flag);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(native.results.length, 17); assert.equal(input.length, 17);
  assert.deepEqual(native.sqliteRuntime, provenance.sqliteRuntime);
  for (const source of provenance.oracleSources) {
    const filename = source.name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url)
      : new URL(source.name, fixtureRoot);
    assert.equal(hash(await readFile(filename)), source.sha256, source.name);
  }
  const result = name => native.results.find(entry => entry.Name === name);
  assert.equal(result('case collision refreshes twice').calls.filter(call => call.action === 'refresh').length, 2);
  assert.equal(result('initial cancellation skips existing').failure, null);
  assert.equal(result('initial cancellation creates first').calls.filter(call => call.action === 'added').length, 1);
  assert.equal(result('initial cancellation creates first').progress.length, 0);
  assert.ok(!result('source kinds and grouping').names.some(name => ['Book', 'Movie', 'Missing relation', 'Tag', 'Z lower'].includes(name)));
});

test('postgres: music genre maintenance refreshes actual state metadata once across runs', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = 'music_genre_runtime_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'music-genre-runtime-'));
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  let runtime;
  t.after(async () => {
    if (runtime) await runtime.close();
    else await database.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try { await cleanup.client.query(`DROP SCHEMA ${q(schema)}, ${q(schema + '__mm')} CASCADE`); }
    finally { await cleanup.close(); }
    assert.equal(path.dirname(path.resolve(stateRoot)), path.resolve(tmpdir()));
    assert.ok(path.basename(stateRoot).startsWith('music-genre-runtime-'));
    await rm(stateRoot, { recursive: true, force: true });
  });
  runtime = await createTestRuntime({ database, programDataPath: stateRoot, serverId: 'music-genre-post-scan',
    configurationDirectoryPath: path.join(stateRoot, 'config'),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableNormalizedItemByNameIds: true } });
  const { library } = runtime;
  const rock = nativeMusicGenreIdentity('Rock', library.options), jazz = nativeMusicGenreIdentity('Jazz', library.options);
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: rock.Id, Name: 'Existing Rock',
    Type: 'MediaBrowser.Controller.Entities.Audio.MusicGenre',
    Path: '%MetadataPath%' + rock.Path.slice(path.join(stateRoot, 'metadata').length) });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: id(400), Name: 'Audio source', Type: 'MediaBrowser.Controller.Entities.Audio.Audio' });
  for (const [index, name] of ['Rock', 'Jazz'].entries()) {
    await database.insert('ItemValues', { ItemValueId: id(500 + index), Type: 2, Value: name, CleanValue: name.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemId: id(400), ItemValueId: id(500 + index) });
  }
  const updates = [], additions = [];
  library.on('ItemUpdated', ({ Item }) => updates.push(guid(Item.Id)));
  library.on('ItemAdded', ({ Item }) => additions.push(guid(Item.Id)));
  const task = runtime.musicGenresPostScanTask;
  task.logger = { error(error) { throw error; } };
  const lookup = library.getMusicGenre.bind(library), lookedUp = new Map();
  const overview = 'Unsaved lookup draft reaches the actual metadata save.';
  library.getMusicGenre = async name => {
    const item = await lookup(name);
    if (guid(item.Id) === guid(jazz.Id)) item.Overview = overview;
    lookedUp.set(guid(item.Id), cloneNativeItemValue(item));
    return item;
  };
  const refresh = runtime.metadataScanner.refreshLiveItem.bind(runtime.metadataScanner), refreshedIds = [];
  runtime.metadataScanner.refreshLiveItem = (item, options) => {
    assert.deepEqual(cloneNativeItemValue(item), lookedUp.get(guid(item.Id)), 'The actual metadata host receives every live lookup draft value.');
    refreshedIds.push(guid(item.Id)); return refresh(item, options);
  };
  const before = (await database.rows('BaseItems', { where: { Id: rock.Id } }))[0];
  await task.run();
  assert.deepEqual(additions, [guid(jazz.Id)]);
  assert.deepEqual(refreshedIds, [guid(jazz.Id)]);
  assert.ok(updates.length > 0 && updates.every(value => value === guid(jazz.Id)));
  const firstUpdates = [...updates];
  assert.deepEqual((await database.rows('BaseItems', { where: { Id: rock.Id } }))[0], before);
  const refreshed = (await database.rows('BaseItems', { where: { Id: jazz.Id } }))[0];
  assert.equal(refreshed.Overview, overview, 'The unsaved lookup mutation reaches the actual PostgreSQL metadata commit.');
  assert.ok(refreshed.DateLastRefreshed);
  assert.equal(refreshed.DateLastRefreshed.slice(0, 10), new Date().toISOString().slice(0, 10));
  await task.run();
  assert.deepEqual(additions, [guid(jazz.Id)]);
  assert.deepEqual(refreshedIds, [guid(jazz.Id)]);
  assert.deepEqual(updates, firstUpdates);
  assert.deepEqual((await database.rows('BaseItems', { where: { Id: jazz.Id } }))[0], refreshed);
});

test('postgres: music genre maintenance keeps names and initial IDs in SQL with bounded pages', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const fixture = await setupChildrenFixture(t);
  const { database, store, library, linkedChildren, loadContext, configuration } = fixture;
  configuration.EnableNormalizedItemByNameIds = true;
  const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = creator; t.after(() => creator.close());
  const table = `${q(database.schemaName)}.${q('BaseItems')}`;
  const columns = tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => `"${column.name}"`).join(', ');
  const template = JSON.stringify(blank('BaseItems'), (_, value) => typeof value === 'bigint' ? String(value) : value);
  await database.client.query({ text: `INSERT INTO ${table} (${columns})
    SELECT ${columns} FROM generate_series(1, 12000) AS series(index)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, $1::jsonb || jsonb_build_object(
      'Id', md5('post-scan-unrelated-' || index::text), 'Name', 'Unrelated',
      'Type', CASE WHEN index <= 1000 THEN 'MediaBrowser.Controller.Entities.Audio.MusicGenre'
        ELSE 'MediaBrowser.Controller.Entities.Movies.Movie' END)) seed`, values: [template] });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: id(300), Name: 'Genre source', Type: 'MediaBrowser.Controller.Entities.Audio.Audio' });
  for (let index = 0; index < 225; index++) {
    const ItemValueId = id(2000 + index), name = 'Genre ' + String(index).padStart(3, '0');
    await database.insert('ItemValues', { ItemValueId, Type: 2, Value: name, CleanValue: name.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemId: id(300), ItemValueId });
  }
  const libraryLoad = library.load.bind(library);
  library.load = (db, user, options) => { assert.ok(options?.baseRows); assert.ok(options.baseRows.length <= 128); return libraryLoad(db, user, options); };
  const seen = new WeakSet(), pages = [];
  const withConnection = database.withConnection.bind(database);
  database.withConnection = (operation, options) => withConnection(db => {
    if (!seen.has(db.client)) {
      seen.add(db.client);
      const query = db.client.query.bind(db.client);
      db.client.query = async (...args) => {
        const result = await query(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
        for (const part of Array.isArray(result) ? result : [result]) assert.ok((part.rows?.length ?? 0) <= 128, 'No whole name or initial-ID relation leaves PostgreSQL.');
        if (sql.includes('music-genre-maintenance-page')) pages.push(result.rows.length);
        return result;
      };
    }
    return operation(db);
  }, options);
  const refreshed = [], progress = [];
  await new MusicGenresPostScanTask({ store, library, metadataScanner: { refreshLiveItem: async item => refreshed.push(item.Id) } })
    .run({ reportProgress: value => progress.push(value) });
  assert.equal(refreshed.length, 225);
  assert.equal(new Set(refreshed).size, 225);
  assert.deepEqual(pages, [128, 97]);
  assert.equal(progress.length, 226); assert.equal(progress.at(-1), 100);
});

async function setup(t, sample, recording) {
  const fixture = await setupChildrenFixture(t);
  const { database, store, library, linkedChildren, loadContext, configuration, stateRoot } = fixture;
  configuration.EnableNormalizedItemByNameIds = true;
  const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = creator; t.after(() => creator.close());
  const libraryLoad = library.load.bind(library);
  library.load = (db, user, options) => { assert.ok(options?.baseRows, 'maintenance uses bounded hydration'); return libraryLoad(db, user, options); };
  if (sample.existingOwner) await database.insert('BaseItems', { ...blank('BaseItems'), Id: id(901), Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Owner anchor' });
  if (sample.existingAlternate) await database.insert('BaseItems', { ...blank('BaseItems'), Id: id(902), Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Primary anchor' });
  for (const name of sample.existing ?? []) {
    const identity = nativeMusicGenreIdentity(name, library.options);
    await database.insert('BaseItems', { ...blank('BaseItems'), Id: identity.Id, Name: 'Existing ' + name,
      Path: '%MetadataPath%' + identity.Path.slice(path.join(stateRoot, 'metadata').length),
      Type: sample.existingType === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie' : 'MediaBrowser.Controller.Entities.Audio.MusicGenre',
      OwnerId: sample.existingOwner ? id(901) : null, PrimaryVersionId: sample.existingAlternate ? id(902) : null });
  }
  for (const row of recording.inputRows) await database.insert('BaseItems', { ...blank('BaseItems'),
    Id: nativeGuid(row.Id), Type: row.Type, Name: row.Name });
  for (const value of recording.values) await database.insert('ItemValues', {
    ItemValueId: nativeGuid(value.ItemValueId), Type: value.type, Value: value.Value, CleanValue: value.CleanValue });
  for (const map of recording.maps) await database.insert('ItemValuesMap', {
    ItemId: nativeGuid(map.ItemId), ItemValueId: nativeGuid(map.ItemValueId) });
  return fixture;
}

for (const recording of native.results) test('postgres: native music genre post-scan ' + recording.Name, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const sample = input.find(value => value.name === recording.Name);
  const fixture = await setup(t, sample, recording);
  const { database, store, library } = fixture;
  const calls = [], progress = [], logged = [], returned = new Map(), controller = new AbortController();
  if (sample.cancelInitial) controller.abort(new StorageError('cancelled', 'Controlled initial cancellation'));
  library.on('ItemAdded', ({ Item }) => calls.push({ action: 'added', id: guid(Item.Id), name: Item.Name }));
  const lookup = library.getMusicGenre.bind(library);
  library.getMusicGenre = async name => {
    calls.push({ action: 'lookup', name });
    if (sample.cancelLookup === name) throw new StorageError('cancelled', 'Controlled lookup cancellation');
    if (sample.failLookup?.includes(name)) throw new Error('Controlled lookup failure');
    const item = await lookup(name); returned.set(idKey(item.Id), cloneNativeItemValue(item)); return item;
  };
  const metadataScanner = { async refreshLiveItem(item, options) {
    assert.deepEqual(cloneNativeItemValue(item), returned.get(idKey(item.Id)),
      'New music-genre metadata refresh preserves the complete visible lookup draft.');
    const bound = metadataScanOptions(options);
    const modes = ['None', 'ValidationOnly', 'Default', 'FullRefresh'];
    calls.push({ action: 'refresh', id: guid(item.Id), name: item.Name,
      metadataMode: modes.indexOf(bound.MetadataRefreshMode), imageMode: modes.indexOf(bound.ImageRefreshMode),
      IsAutomated: bound.IsAutomated, ForceSave: bound.ForceSave, ReplaceAllMetadata: bound.ReplaceAllMetadata,
      ReplaceAllImages: bound.ReplaceAllImages, RemoveOldMetadata: bound.RemoveOldMetadata });
    if (sample.cancelRefresh === item.Name) controller.abort(new StorageError('cancelled', 'Controlled refresh cancellation'));
    bound.signal?.throwIfAborted();
    if (sample.failRefresh?.includes(item.Name)) throw new Error('Controlled refresh failure');
  } };
  const task = new MusicGenresPostScanTask({ store, library, metadataScanner, logger: { error: (...args) => logged.push(args[0].message) } });
  let failure = null;
  try { await task.run({ signal: controller.signal, reportProgress: value => progress.push(value) }); }
  catch (error) { failure = error; }
  assert.equal(Boolean(failure), Boolean(recording.failure), recording.failure?.type);
  if (recording.failure?.type === 'OperationCanceledException') assert.equal(failure?.code, 'cancelled');
  assert.deepEqual(calls, recording.calls, 'Native lookup, creation and refresh order is preserved.');
  assert.deepEqual(progress, recording.progress);
  const genres = (await database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Audio.MusicGenre' } }))
    .map(row => ({ Id: guid(row.Id), Name: row.Name })).sort((a, b) => a.Id.localeCompare(b.Id));
  assert.deepEqual(genres, recording.genres);
  assert.deepEqual((await database.client.query("SELECT relname FROM pg_class WHERE relname LIKE 'mm_music_genres_%'")).rows, []);
  if (process.env.MEDIAMANAGER_MUSIC_GENRES_POST_SCAN_EVIDENCE) {
    const directory = process.env.MEDIAMANAGER_MUSIC_GENRES_POST_SCAN_EVIDENCE;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, String(native.results.indexOf(recording)).padStart(2, '0') + '.json'),
      JSON.stringify({ name: recording.Name, calls, progress, genres, logged,
        failure: failure && { name: failure.name, code: failure.code, message: failure.message },
        nativeProviderControlled: true, candidateProviderControlled: true, phaseAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
  }
});
