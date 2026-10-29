import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { GenresPostScanTask, StudiosPostScanTask } from '../../src/library/by-name-post-scan-task.js';
import { LibraryScanLifecycle } from '../../src/library/library-scan-lifecycle.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { UnsafeItemDeletionService } from '../../src/library/unsafe-item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { metadataScanOptions } from '../../src/library/metadata-scan-service.js';
import { nativeGenreIdentity, nativeMusicGenreIdentity, nativeStudioIdentity } from '../../src/library/identity.js';
import { dateText, guid } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds, nativeGuid } from '../../src/users/native.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { StorageError } from '../../src/storage/errors.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { expandStatePath } from './fixture-state-path.js';

const fixtureRoot = new URL('./fixtures/by-name-post-scan/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixtureRoot))));
const input = JSON.parse(inputBytes), native = parseLosslessJson(nativeBytes.toString('utf8')), provenance = JSON.parse(provenanceBytes);
const classes = { Genre: GenresPostScanTask, Studio: StudiosPostScanTask };
const getters = { Genre: 'getGenre', Studio: 'getStudio' };
const identities = { Genre: nativeGenreIdentity, Studio: nativeStudioIdentity };
const columns = tableDefinition('BaseItems').columns;
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);
// Only the recorded instance Path is relocated. Keep all other columns and
// unknown Data bytes intact, including unrelated Windows media identities.
const rebaseRecordedPath = (value, from, to) => expandStatePath(
  expandStatePath(value, from, to), '%MetadataPath%', '%MetadataPath%');
const normalize = row => Object.fromEntries(columns.map(column => {
  let value = row[column.name];
  if (value != null && column.clrType.includes('Guid')) value = guid(value);
  if (value != null && column.clrType.includes('DateTime')) value = dateText(value);
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) value = Number(value);
  return [column.name, value];
}));
const order = (rows, keys) => rows.sort((left, right) => {
  for (const key of keys) { if (left[key] < right[key]) return -1; if (left[key] > right[key]) return 1; }
  return 0;
});
const normalizeCalls = calls => calls.map(call => ({ ...call,
  ...(call.id ? { id: guid(call.id) } : {}), ...(call.ids ? { ids: call.ids.map(guid) } : {}),
  ...(call.parent ? { parent: guid(call.parent) } : {}) }));

for (const kind of ['Genre', 'Studio']) for (const phase of ['lookup', 'refresh']) test(
  `postgres: ${kind} caller cancellation during ${phase} stops later tasks and drains SQL resources`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
  }, async t => {
    const fixture = await setupChildrenFixture(t);
    const { database, store, library, linkedChildren, loadContext, configuration, host: metadata } = fixture;
    configuration.EnableNormalizedItemByNameIds = true;
    const sourceId = 'ba470000-0000-0000-0000-000000000001';
    const first = 'A caller cancellation ' + kind, later = 'Z untouched ' + kind;
    await fixture.seed({ target: 'source', items: [{ key: 'source', Id: sourceId, type: 'Movie',
      Name: 'Cancellation source', [kind === 'Genre' ? 'Genres' : 'Studios']: [first, later] }] });
    const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
    library.itemCreation = creator;
    const before = await database.rows('BaseItems'), calls = [], errors = [], progress = [];
    const relationTables = ['ItemValues', 'ItemValuesMap', 'LinkedChildren'];
    const beforeRelations = await Promise.all(relationTables.map(table => database.rows(table)));
    const controller = new AbortController();
    const reason = Object.assign(new Error('Controlled post-scan caller cancellation.'), { code: 'caller-post-scan-stop' });
    const cancel = () => { controller.abort(reason); controller.signal.throwIfAborted(); };
    const lookup = library[getters[kind]].bind(library);
    library[getters[kind]] = async name => {
      calls.push({ action: 'lookup', name });
      if (phase === 'lookup') cancel();
      return lookup(name);
    };
    let deadCleanup = 0, laterTask = 0, inheritedCleanup = 0;
    library.deleteQueryItemsUnsafeFast = async () => { deadCleanup++; };
    const task = new classes[kind]({ store, library, metadataScanner: {
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
      assert.deepEqual((await temporaryTables()).rows, original, 'Cancellation must finish the actual task TEMP-table cleanup.');
    });
    t.diagnostic(JSON.stringify({ kind, phase, outcome: result.status, reason: result.status === 'rejected'
      ? { name: result.reason?.name, message: result.reason?.message, code: result.reason?.code } : null,
      calls, errors, progress, deadCleanup, laterTask, inheritedCleanup }));
    assert.equal(result.status, 'rejected');
    assert.deepEqual({ message: result.reason?.message, code: result.reason?.code }, { message: reason.message, code: reason.code });
    assert.deepEqual(calls, [{ action: 'lookup', name: first }, ...(phase === 'refresh' ? [{ action: 'refresh', name: first }] : [])]);
    assert.deepEqual([deadCleanup, laterTask, inheritedCleanup], [0, 0, 0]); assert.deepEqual(progress, []);
    assert.ok(errors.every(error => error.message === reason.message && error.code === reason.code),
      'Only this actual caller cancellation may be reported as a diagnostic.');
    const after = await database.rows('BaseItems');
    assert.deepEqual(after.find(row => guid(row.Id) === sourceId), before.find(row => guid(row.Id) === sourceId), 'The original source row is unchanged.');
    assert.deepEqual(await Promise.all(relationTables.map(table => database.rows(table))), beforeRelations,
      'All original name and linked-child relations remain unchanged.');
    const created = after.filter(row => guid(row.Id) !== sourceId);
    assert.deepEqual(created.map(row => ({ Type: row.Type, Name: row.Name })),
      phase === 'refresh' ? [{ Type: 'MediaBrowser.Controller.Entities.' + kind, Name: first }] : [],
      'Only the completed first lookup may remain committed.');
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

async function tree(root) {
  const entries = [];
  async function visit(folder) {
    for (const name of await readdir(folder)) {
      const filename = path.join(folder, name), info = await stat(filename), directory = info.isDirectory();
      entries.push({ path: path.relative(root, filename).replaceAll('\\', '/'), directory,
        sha256: directory ? null : hash(await readFile(filename)) });
      if (directory) await visit(filename);
    }
  }
  for (const folder of ['metadata', 'data']) {
    const filename = path.join(root, folder);
    try { await stat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await visit(filename);
  }
  return order(entries, ['path']);
}

test('by-name post-scan seals actual validators, complete SQLite rows, files and task registration order', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256); assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.inputSha256, provenance.inputSha256);
  assert.equal(native.results.length, 64); assert.equal(input.length, 32); assert.equal(columns.length, 72);
  for (const flag of ['actualPostScanTasks', 'actualValidators', 'actualLibraryManager', 'actualRepository',
    'actualSqlitePersistence', 'actualUnsafeFastFiles', 'metadataProviderControlled']) assert.equal(native[flag], true, flag);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  assert.equal(provenance.completeBuildInputClosure, false); assert.equal(provenance.phaseAcceptance, false);
  assert.deepEqual(native.sqliteRuntime, provenance.sqliteRuntime);
  assert.deepEqual(native.registrationTypes.filter(name => ['GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask'].includes(name)),
    ['GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask']);
  for (const source of provenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixtureRoot))), source.sha256, source.name);
  for (const sample of native.results) for (const side of ['before', 'after']) for (const row of sample[side].rows) {
    assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  }
});

for (const recording of native.results) test(`postgres: native ${recording.kind} post-scan ${recording.sample.Name}`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, linkedChildren, loadContext, configuration, stateRoot } = value;
  configuration.EnableNormalizedItemByNameIds = true;
  const sample = recording.sample, lookupName = getters[recording.kind];
  const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = creator; t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  library.unsafeItemDeletion = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  // Seed complete pre-action rows and relations, independently of the outcomes.
  await store.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const row of recording.before.rows) await db.insert('BaseItems', Object.fromEntries(columns.map(column => {
      let entry = column.name === 'Path'
        ? rebaseRecordedPath(row[column.name], recording.root, stateRoot) : row[column.name];
      if (entry != null && column.clrType.includes('Guid')) entry = nativeGuid(entry);
      return [column.name, entry];
    })));
    for (const row of recording.before.values) await db.insert('ItemValues', {
      ItemValueId: nativeGuid(row.ItemValueId), Type: row.type, Value: row.Value, CleanValue: row.CleanValue });
    for (const row of recording.before.maps) await db.insert('ItemValuesMap', {
      ItemId: nativeGuid(row.ItemId), ItemValueId: nativeGuid(row.ItemValueId) });
  });
  for (const entry of recording.before.tree) {
    const filename = path.join(stateRoot, entry.path);
    if (entry.directory) await mkdir(filename, { recursive: true });
    else {
      const content = path.basename(filename) === 'data.bin' ? 'external' : path.basename(filename) === 'internal.jpg' ? 'internal' : 'source';
      assert.equal(hash(content), entry.sha256); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, content);
    }
  }
  assert.deepEqual(await tree(stateRoot), recording.before.tree);
  const calls = [], progress = [], logged = [], lookupDirectories = new Map(), controller = new AbortController();
  if (sample.CancelInitial) controller.abort(new StorageError('cancelled', 'Controlled initial cancellation'));
  library.on('ItemAdded', ({ Item }) => calls.push({ action: 'added', id: guid(Item.Id), name: Item.Name }));
  library.on('ItemRemoved', ({ Item, Parent }) => calls.push({ action: 'removed', id: guid(Item.Id), name: Item.Name, parent: Parent ? guid(Parent.Id) : null }));
  const lookup = library[lookupName].bind(library);
  library[lookupName] = async name => {
    calls.push({ action: 'lookup', name });
    if (sample.CancelLookup === name) throw new StorageError('cancelled', 'Controlled lookup cancellation');
    if (sample.FailLookup.includes(name)) throw new Error('Controlled lookup failure');
    const item = await lookup(name);
    const info = await stat(item.Path, { bigint: true });
    if (!lookupDirectories.has(guid(item.Id))) lookupDirectories.set(guid(item.Id), {
      created: dateText(nativeDateFromUnixNanoseconds(info.birthtimeNs)), modified: dateText(nativeDateFromUnixNanoseconds(info.mtimeNs)) });
    return item;
  };
  const deleteFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = item => {
    calls.push({ action: 'external', id: guid(item.Id), name: item.Name });
    if (sample.FailExternal && item.Name === 'DeadSecond') throw new Error('Controlled external failure');
    return deleteFiles(item);
  };
  const metadataScanner = { async refreshLiveItem(item, options) {
    const bound = metadataScanOptions(options), modes = ['None', 'ValidationOnly', 'Default', 'FullRefresh'];
    calls.push({ action: 'refresh', id: guid(item.Id), name: item.Name,
      metadataMode: modes.indexOf(bound.MetadataRefreshMode), imageMode: modes.indexOf(bound.ImageRefreshMode),
      IsAutomated: bound.IsAutomated, ForceSave: bound.ForceSave, ReplaceAllMetadata: bound.ReplaceAllMetadata,
      ReplaceAllImages: bound.ReplaceAllImages, RemoveOldMetadata: bound.RemoveOldMetadata });
    if (sample.CancelRefresh === item.Name) controller.abort(new StorageError('cancelled', 'Controlled refresh cancellation'));
    bound.signal?.throwIfAborted();
    if (sample.FailRefresh.includes(item.Name)) throw new Error('Controlled refresh failure');
  } };
  const task = new classes[recording.kind]({ store, library, metadataScanner, logger: { error: error => logged.push(error.message) } });
  const transaction = store.transaction.bind(store);
  let failure;
  await store.run(async db => {
    const query = db.client.query.bind(db.client); let rootRelation;
    db.client.query = async (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      const match = /^CREATE TEMP TABLE ("mm_unsafe_[a-z0-9]+_roots")/u.exec(sql);
      const result = await query(...args); if (match) rootRelation = match[1]; return result;
    };
    store.transaction = async (...args) => {
      if (rootRelation) {
        const roots = (await query(`SELECT "Id" FROM ${rootRelation} ORDER BY "__ordinal" LIMIT 129`)).rows;
        assert.ok(roots.length < 129, 'Only the small recording is observed.');
        calls.push({ action: 'persist', ids: roots.map(row => guid(row.Id)) });
      }
      return transaction(...args);
    };
    try {
      if (sample.FailDatabase) await query(`CREATE FUNCTION controlled_maintenance_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Controlled database failure'; END; $$;
        CREATE TRIGGER controlled_maintenance_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION controlled_maintenance_failure()`);
      try { await task.run({ signal: controller.signal, reportProgress: value => progress.push(value) }); }
      catch (error) { failure = error; }
      assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_%'")).rows, []);
    } finally { db.client.query = query; store.transaction = transaction; }
  });
  assert.equal(Boolean(failure), Boolean(recording.failure), failure?.stack ?? 'Native failure boundary');
  if (recording.failure?.type === 'OperationCanceledException') assert.equal(failure?.code, 'cancelled');
  if (sample.FailDatabase) assert.equal(failure?.code, 'P0001');
  t.diagnostic(encode({ failure: failure && { name: failure.name, code: failure.code, message: failure.message },
    nativeFailure: recording.failure, logged }));
  assert.deepEqual(calls, normalizeCalls(recording.calls)); assert.deepEqual(progress, recording.progress);
  const actualRows = order((await database.rows('BaseItems')).map(normalize), ['Id']);
  const expectedRows = order(recording.after.rows.map(row => normalize(Object.fromEntries(Object.entries(row)
    .map(([key, entry]) => [key, key === 'Path'
      ? rebaseRecordedPath(entry, recording.root, stateRoot) : entry])))), ['Id']);
  const initialIds = new Set(recording.before.rows.map(row => guid(row.Id)));
  for (const row of actualRows) if (!initialIds.has(row.Id)) {
    const expected = expectedRows.find(item => item.Id === row.Id), info = lookupDirectories.get(row.Id);
    const nativeInfo = recording.lookupDirectories.find(item => guid(item.Id) === row.Id);
    assert.ok(expected && info && nativeInfo, 'A new row is bound to its own directory observation.');
    assert.equal(row.DateCreated, info.created); assert.equal(row.DateModified, info.modified);
    assert.equal(expected.DateCreated, dateText(nativeInfo.created)); assert.equal(expected.DateModified, dateText(nativeInfo.modified));
    row.DateCreated = expected.DateCreated = '$DIRECTORY_CREATED'; row.DateModified = expected.DateModified = '$DIRECTORY_MODIFIED';
  }
  assert.deepEqual(actualRows, expectedRows, 'Every persistent column and unknown Data value is compared.');
  const values = order((await database.rows('ItemValues')).map(row => ({ ItemValueId: guid(row.ItemValueId), type: row.Type, Value: row.Value, CleanValue: row.CleanValue })), ['ItemValueId']);
  const maps = order((await database.rows('ItemValuesMap')).map(row => ({ ItemId: guid(row.ItemId), ItemValueId: guid(row.ItemValueId) })), ['ItemId', 'ItemValueId']);
  assert.deepEqual(values, order([...recording.after.values], ['ItemValueId']));
  assert.deepEqual(maps, order([...recording.after.maps], ['ItemId', 'ItemValueId']));
  const files = await tree(stateRoot); assert.deepEqual(files, recording.after.tree);
  if (process.env.MEDIAMANAGER_BY_NAME_POST_SCAN_EVIDENCE) {
    const directory = process.env.MEDIAMANAGER_BY_NAME_POST_SCAN_EVIDENCE; await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, String(native.results.indexOf(recording)).padStart(2, '0') + '.json'), encode({
      kind: recording.kind, name: sample.Name, calls, progress, logged, rows: actualRows, values, maps, tree: files,
      failure: failure && { name: failure.name, code: failure.code, message: failure.message },
      nativeProviderControlled: true, candidateProviderControlled: true, phaseAcceptance: false }) + '\n', { flag: 'wx' });
  }
});

for (const kind of Object.keys(classes)) test(`postgres: ${kind} maintenance bounds source, initial names, refresh and deletion pages`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const { database, store, library, linkedChildren, loadContext, configuration, stateRoot } = await setupChildrenFixture(t);
  configuration.EnableNormalizedItemByNameIds = true;
  const creator = new ItemCreationService({ store, library, linkedChildren, loadContext });
  library.itemCreation = creator; t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  library.unsafeItemDeletion = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  const source = native.results.find(entry => entry.kind === kind && entry.sample.Name === 'new names').before.rows;
  const template = source.find(row => row.Type.endsWith('.Movie'));
  const initial = native.results.find(entry => entry.kind === kind && entry.sample.Name === 'existing custom identity')
    .before.rows.find(row => row.Type.endsWith('.' + kind));
  const table = `${q(database.schemaName)}.${q('BaseItems')}`;
  const nativeTextColumns = columns.filter(column => column.type === 'TEXT').map(column => column.name);
  const projection = columns.map(column => column.type === 'TEXT'
    ? `convert_to(source.document->>'${column.name}','UTF8')` : `scalar.${q(column.name)}`).join(',');
  await database.client.query({ text: `INSERT INTO ${table} SELECT ${projection} FROM generate_series(1, 12000) position
    CROSS JOIN LATERAL (SELECT (
    CASE WHEN position <= 1000 THEN $2::jsonb ELSE $1::jsonb END || jsonb_build_object(
      'Id', md5($3::text || position::text), 'Name', 'Background ' || position::text,
      'Path', $4::text || '/' || position::text)) AS document) source
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},source.document-$5::text[]) scalar`,
    values: [encode(template), encode(initial), 'by-name-scale-' + kind, path.join(stateRoot, 'metadata', kind), nativeTextColumns] });
  const ItemId = nativeGuid(template.Id); await database.insert('BaseItems', { ...template, Id: ItemId });
  for (let index = 0; index < 225; index++) {
    const name = 'Name ' + String(index).padStart(3, '0'), ItemValueId = `ba390000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    await database.insert('ItemValues', { ItemValueId, Type: kind === 'Genre' ? 2 : 3, Value: name, CleanValue: name.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemId, ItemValueId });
  }
  const pages = [], refreshed = [], removed = [], load = library.load.bind(library);
  library.load = (db, user, options) => { assert.ok(options?.baseRows && options.baseRows.length <= 128); return load(db, user, options); };
  library.on('ItemRemoved', ({ Item }) => removed.push(Item.Id));
  await store.run(async db => {
    const query = db.client.query.bind(db.client);
    db.client.query = async (...args) => {
      const result = await query(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      for (const part of Array.isArray(result) ? result : [result]) assert.ok((part.rows?.length ?? 0) <= 128, 'Maintenance relations remain in PostgreSQL.');
      if (sql.includes('by-name-maintenance-page')) pages.push(result.rows.length);
      return result;
    };
    try { await new classes[kind]({ store, library, metadataScanner: { refreshLiveItem: async item => refreshed.push(item.Id) } }).run(); }
    finally { db.client.query = query; }
    assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_%'")).rows, []);
  });
  assert.deepEqual(pages, [128, 97]); assert.equal(refreshed.length, 225); assert.equal(new Set(refreshed).size, 225);
  assert.equal(removed.length, 1000); assert.equal(new Set(removed).size, 1000);
  assert.equal(Number((await database.client.query('SELECT count(*) FROM "BaseItems"')).rows[0].count), 11226);
});

test('postgres: runtime registers Genre, MusicGenre and Studio maintenance and saves metadata only for new identities', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = 'by_name_runtime_' + randomUUID().replaceAll('-', '').slice(0, 16), connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'by-name-runtime-')), registry = new StorageRegistry();
  const database = await PostgresDatabase.open({ connectionString, schema, create: true }); let runtime;
  t.after(async () => {
    if (runtime) await runtime.close(); else await database.close(); await registry.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try { await cleanup.client.query(`DROP SCHEMA ${q(schema)}, ${q(schema + '__mm')} CASCADE`); } finally { await cleanup.close(); }
    assert.equal(path.dirname(path.resolve(stateRoot)), path.resolve(tmpdir())); assert.ok(path.basename(stateRoot).startsWith('by-name-runtime-'));
    await rm(stateRoot, { recursive: true, force: true });
  });
  registry.registerType('memory', () => new MemoryStorageAdapter()); await registry.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\ByNameRuntime', accessRoot: '/media', style: 'windows', returnAccess: 'Controlled runtime media' });
  runtime = await createTestRuntime({ database, programDataPath: stateRoot, vfs, identityMap, serverId: 'by-name-post-scan',
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableNormalizedItemByNameIds: true } });
  const registered = runtime.libraryScanLifecycle.postScanTasks;
  assert.deepEqual(registered.map(task => task.name), ['Splashscreen', 'Artists', 'CollectionPosterVerify', 'Collections', 'Genres', 'MusicGenres', 'Studios', 'CleanDatabase']);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true); assert.equal(runtime.libraryScanLifecycle.capabilities.runsPostScanTasks, true);
  const template = native.results.find(entry => entry.kind === 'Genre' && entry.sample.Name === 'new names').before.rows.find(row => row.Type.endsWith('.Movie'));
  const movie = { ...template, Id: 'ba390000-0000-0000-0000-000000005001', Name: 'Movie source' };
  const audio = { ...template, Id: 'ba390000-0000-0000-0000-000000005002', Name: 'Audio source', Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Data: null };
  await database.insert('BaseItems', movie); await database.insert('BaseItems', audio);
  const seeds = [[movie.Id, 2, 'Rock'], [audio.Id, 2, 'Jazz'], [movie.Id, 3, 'Studio']];
  for (const [index, [ItemId, Type, Value]] of seeds.entries()) {
    const ItemValueId = `ba390000-0000-0000-0000-${String(6000 + index).padStart(12, '0')}`;
    await database.insert('ItemValues', { ItemValueId, Type, Value, CleanValue: Value.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemId, ItemValueId });
  }
  const ids = [identities.Genre('Rock', runtime.library.options).Id, nativeMusicGenreIdentity('Jazz', runtime.library.options).Id,
    identities.Studio('Studio', runtime.library.options).Id];
  const calls = [], refresh = runtime.metadataScanner.refreshLiveItem.bind(runtime.metadataScanner);
  runtime.metadataScanner.refreshLiveItem = (item, options) => { calls.push('refresh:' + guid(item.Id)); return refresh(item, options); };
  for (const task of registered) {
    task.logger = { error(error) { throw error; } }; const run = task.run.bind(task);
    task.run = options => { calls.push(task.name); return run(options); };
  }
  const inherited = runtime.libraryScanHost.updateInheritedValues.bind(runtime.libraryScanHost);
  runtime.libraryScanHost.updateInheritedValues = () => { calls.push('inherited'); return inherited(); };
  const events = []; runtime.library.on('ItemAdded', ({ Item }) => events.push(guid(Item.Id)));
  await runtime.libraryScanLifecycle.runPostScanTasks();
  assert.deepEqual(calls, ['Splashscreen', 'Artists', 'CollectionPosterVerify', 'Collections', 'Genres', 'refresh:' + guid(ids[0]), 'MusicGenres', 'refresh:' + guid(ids[1]), 'Studios', 'refresh:' + guid(ids[2]), 'CleanDatabase', 'inherited']);
  assert.deepEqual(events, ids.map(guid));
  const saved = [];
  for (const Id of ids) {
    const row = (await database.rows('BaseItems', { where: { Id } }))[0]; assert.ok(row.DateLastRefreshed); saved.push(row);
  }
  calls.length = 0; await runtime.libraryScanLifecycle.runPostScanTasks();
  assert.deepEqual(calls, ['Splashscreen', 'Artists', 'CollectionPosterVerify', 'Collections', 'Genres', 'MusicGenres', 'Studios', 'CleanDatabase', 'inherited']); assert.deepEqual(events, ids.map(guid));
  for (const [index, Id] of ids.entries()) assert.deepEqual((await database.rows('BaseItems', { where: { Id } }))[0], saved[index]);
});
