import { testFileSystem } from '../storage/plugin-files.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { ArtistsPostScanTask } from '../../src/library/artists-post-scan-task.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { UnsafeItemDeletionService } from '../../src/library/unsafe-item-deletion-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { LibraryMetadataScanService, metadataScanOptions } from '../../src/library/metadata-scan-service.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { isNativeItemEntity, acquireNativeItemLinkOwner } from '../../src/library/native-item-entity.js';
import { EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { persistFolderLinks } from '../../src/metadata/persistence.js';
import { postgresCleanValueFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { metadataFields } from '../../src/library/metadata-context.js';
import { dateText, guid, idKey, mapRecord } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds, nativeGuid } from '../../src/users/native.js';
import { createRuntime } from '../../src/runtime.js';
import { StorageError } from '../../src/storage/errors.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';

const fixtureRoot = new URL('./fixtures/artist-maintenance/', import.meta.url);
const [inputBytes, nativeBytes, provenanceBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(name => readFile(new URL(name, fixtureRoot))));
const input = JSON.parse(inputBytes), native = parseLosslessJson(nativeBytes.toString('utf8')), provenance = JSON.parse(provenanceBytes);
const recordings = [...native.results];
for (const suffix of ['reverse/', 'refresh-state/']) {
  const root = new URL(suffix, fixtureRoot);
  const bytes = await readFile(new URL('native.json', root));
  const recorded = parseLosslessJson(bytes.toString());
  const sealed = JSON.parse(await readFile(new URL('provenance.json', root)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sealed.nativeSha256);
  assert.equal(createHash('sha256').update(await readFile(new URL('input.json', root))).digest('hex'), sealed.inputSha256);
  for (const source of sealed.oracleSources) assert.equal(createHash('sha256').update(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, root))).digest('hex'), source.sha256);
  recordings.push(...recorded.results);
}
const columns = tableDefinition('BaseItems').columns;
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);
// jsonb_populate_record consumes PostgreSQL's physical bytea input strings.
// Native recordings remain decoded independent inputs; only this SQL seed is encoded.
const physicalSeed = row => encode(Object.fromEntries(columns.filter(column => !column.generated).map(column => {
  const value = row[column.name];
  return [column.name, column.type === 'TEXT' && value != null ? '\\x' + nativeTextBytes(value).toString('hex') : value];
})));
const rebase = (value, from, to) => typeof value === 'string' ? value.replaceAll(from, to)
  .replaceAll(JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)) : value;
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

test('Artist post-scan seals actual validators, independent rows, files and registration order', async () => {
  assert.equal(hash(nativeBytes), provenance.nativeSha256); assert.equal(hash(inputBytes), provenance.inputSha256);
  assert.equal(native.inputSha256, provenance.inputSha256);
  assert.equal(native.results.length, 36); assert.equal(input.length, 36); assert.equal(columns.length, 72);
  for (const flag of ['actualPostScanTasks', 'actualValidators', 'actualLibraryManager', 'actualRepository',
    'actualSqlitePersistence', 'actualUnsafeFastFiles', 'metadataProviderControlled']) assert.equal(native[flag], true, flag);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  assert.equal(provenance.completeBuildInputClosure, false); assert.equal(provenance.phaseAcceptance, false);
  assert.deepEqual(native.sqliteRuntime, provenance.sqliteRuntime);
  assert.deepEqual(native.registrationTypes.filter(name => ['ArtistsPostScanTask', 'GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask'].includes(name)),
    ['ArtistsPostScanTask', 'GenresPostScanTask', 'MusicGenresPostScanTask', 'StudiosPostScanTask']);
  for (const source of provenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixtureRoot))), source.sha256, source.name);
  for (const sample of native.results) for (const side of ['before', 'after']) for (const row of sample[side].rows) {
    assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
  }
});

async function seedRecording({ database, store, stateRoot }, recording) {
  // Seed complete pre-action rows and relations, independently of the outcomes.
  await store.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const row of recording.before.insertionOrder.map(Id => recording.before.rows.find(row => row.Id === Id))) await db.insert('BaseItems', Object.fromEntries(columns.map(column => {
      let entry = rebase(row[column.name], recording.root, stateRoot);
      if (entry != null && column.clrType.includes('Guid')) entry = nativeGuid(entry);
      return [column.name, entry];
    })));
    for (const row of recording.before.values) await db.insert('ItemValues', {
      ItemValueId: nativeGuid(row.ItemValueId), Type: row.type, Value: row.Value, CleanValue: row.CleanValue });
    for (const row of recording.before.maps) await db.insert('ItemValuesMap', {
      ItemId: nativeGuid(row.ItemId), ItemValueId: nativeGuid(row.ItemValueId) });
    for (const row of recording.before.providers ?? []) await db.insert('BaseItemProviders', { ...row, ItemId: nativeGuid(row.ItemId) });
    for (const row of recording.before.locked ?? []) await db.insert('BaseItemMetadataFields', { ...row, ItemId: nativeGuid(row.ItemId) });
    for (const row of recording.before.images ?? []) await db.insert('BaseItemImageInfos', { ...row,
      Id: nativeGuid(row.Id), ItemId: nativeGuid(row.ItemId), Path: rebase(row.Path, recording.root, stateRoot) });
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
}

for (const recording of recordings) test(`postgres: native ${recording.kind} post-scan ${recording.sample.Name}`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, configuration, stateRoot, linkedChildren, spoolRoot } = value;
  configuration.EnableNormalizedItemByNameIds = true;
  const sample = recording.sample, lookupName = 'getArtist';
  const creator = new ItemCreationService({ store, library, linkedChildren, loadContext: value.trackContextLoader(createMetadataContextLoader({fileSystem: testFileSystem,  store, library, configuration, linkedChildren, spoolRoot })) });
  library.itemCreation = creator; t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  library.unsafeItemDeletion = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  await seedRecording(value, recording);
  const calls = [], progress = [], logged = [], returned = new Map(), lookupDirectories = new Map(), controller = new AbortController();
  if (sample.CancelInitial) controller.abort(new StorageError('cancelled', 'Controlled initial cancellation'));
  library.on('ItemAdded', ({ Item }) => calls.push({ action: 'added', id: guid(Item.Id), name: Item.Name }));
  library.on('ItemRemoved', ({ Item, Parent }) => calls.push({ action: 'removed', id: guid(Item.Id), name: Item.Name, parent: Parent ? guid(Parent.Id) : null }));
  const lookup = library[lookupName].bind(library);
  library[lookupName] = async name => {
    calls.push({ action: 'lookup', name });
    if (sample.CancelLookup === name) throw new StorageError('cancelled', 'Controlled lookup cancellation');
    if (sample.FailLookup.includes(name)) throw new Error('Controlled lookup failure');
    if (sample.NullLookup === name) return null;
    const item = await lookup(name); returned.set(idKey(item.Id), item);
    let info; try { info = await stat(item.Path, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; return item; }
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
    const originalName = item.Name, bound = metadataScanOptions(options), modes = ['None', 'ValidationOnly', 'Default', 'FullRefresh'];
    if (recording.before.providers) calls.push({ action: 'refreshState', Id: guid(item.Id), Name: item.Name,
      DateLastRefreshed: dateText(item.DateLastRefreshed), Overview: item.Overview, ProviderIds: { ...item.ProviderIds },
      LockedFields: item.LockedFields.map(field => typeof field === 'number' ? field : Object.entries(metadataFields).find(([, value]) => value === field)?.[0]).map(Number),
      Tags: [...item.Tags], Genres: [...item.Genres], images: item.ImageInfos.map(image => ({
        Path: image.Path, type: image.Type, Width: image.Width, Height: image.Height })), linkedChildrenLoaded: item.LinkedChildrenLoaded });
    calls.push({ action: 'refresh', id: guid(item.Id), name: item.Name,
      metadataMode: modes.indexOf(bound.MetadataRefreshMode), imageMode: modes.indexOf(bound.ImageRefreshMode),
      IsAutomated: bound.IsAutomated, ForceSave: bound.ForceSave, ReplaceAllMetadata: bound.ReplaceAllMetadata,
      ReplaceAllImages: bound.ReplaceAllImages, RemoveOldMetadata: bound.RemoveOldMetadata });
    if (sample.CancelRefresh === item.Name) controller.abort(new StorageError('cancelled', 'Controlled refresh cancellation'));
    bound.signal?.throwIfAborted();
    if (sample.MutateRefresh) { item.Name = 'Updated ' + item.Name; item.DateLastRefreshed = '2026-10-02T00:00:00.0000000Z'; }
    if (sample.MutateOther) await database.client.query({ text: 'UPDATE "BaseItems" SET "Name" = $1, "DateLastRefreshed" = $2 WHERE "Name" = $3',
      values: ['Changed in repository', '2026-10-02T00:00:00.0000000Z', 'Rock'].map(nativeTextBytes) });
    if (sample.FailRefresh.includes(originalName)) throw new Error('Controlled refresh failure');
    if (sample.PersistRefresh) await creator.saveItems([item]);
  } };
  const task = new ArtistsPostScanTask({ store, library, linkedChildren, metadataScanner, logger: { error: error => logged.push(error.message) } });
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
        calls.push({ action: 'persist', ids: roots.map(row => guid(decodeNativeTextBytes(row.Id, 'runtime'))) });
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
  if (sample.SourceKinds || sample.DeadNullPath) assert.equal(failure?.name, 'TypeError');
  assert.equal(logged.length, recording.logs.filter(entry => entry.level === 'Error').length, JSON.stringify(logged));
  assert.deepEqual(calls, normalizeCalls(recording.calls).map(call => call.action === 'refreshState' ? { ...call,
    Id: guid(call.Id), DateLastRefreshed: dateText(call.DateLastRefreshed),
    images: call.images.map(image => ({ ...image, Path: rebase(image.Path, recording.root, stateRoot) })) } : call)); assert.deepEqual(progress, recording.progress);
  const actualRows = order((await database.rows('BaseItems')).map(normalize), ['Id']);
  const expectedRows = order(recording.after.rows.map(row => normalize(Object.fromEntries(Object.entries(row)
    .map(([key, entry]) => [key, rebase(entry, recording.root, stateRoot)])))), ['Id']);
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
  for (const [name, nativeKey] of [['BaseItemProviders', 'providers'], ['BaseItemMetadataFields', 'locked'], ['BaseItemImageInfos', 'images']]) {
    if (!recording.after[nativeKey]) continue;
    const actual = (await database.rows(name)).map(row => ({ ...row, ItemId: guid(row.ItemId),
      ...(row.Id && typeof row.Id === 'string' ? { Id: guid(row.Id) } : {}),
      ...(row.DateModified ? { DateModified: dateText(row.DateModified) } : {}) }));
    const expected = recording.after[nativeKey].map(row => ({ ...row, ItemId: guid(row.ItemId),
      ...(row.DateModified ? { DateModified: dateText(row.DateModified) } : {}), ...(row.Path ? { Path: rebase(row.Path, recording.root, stateRoot) } : {}) }));
    // Image IDs are independently allocated each time persistence replaces images.
    if (name === 'BaseItemImageInfos' && sample.PersistRefresh) for (const rows of [actual, expected]) for (const row of rows) {
      assert.match(row.Id, /^[a-f0-9-]{36}$/u); delete row.Id;
    }
    assert.deepEqual(order(actual, ['ItemId', 'ProviderId', 'Id', 'Path']), order(expected, ['ItemId', 'ProviderId', 'Id', 'Path']), name);
  }
  const files = await tree(stateRoot); assert.deepEqual(files, recording.after.tree);
  if (process.env.MEDIAMANAGER_ARTISTS_POST_SCAN_EVIDENCE) {
    const directory = process.env.MEDIAMANAGER_ARTISTS_POST_SCAN_EVIDENCE; await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, String(recordings.indexOf(recording)).padStart(2, '0') + '.json'), encode({
      kind: recording.kind, name: sample.Name, calls, progress, logged, rows: actualRows, values, maps, tree: files,
      failure: failure && { name: failure.name, code: failure.code, message: failure.message },
      nativeProviderControlled: true, candidateProviderControlled: true, phaseAcceptance: false }) + '\n', { flag: 'wx' });
  }
});

test('postgres: native supplementary-plane Artist cleaning is consumed by the relational batch selector', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, library } = value;
  const recording = recordings.find(row => row.sample.Name === 'unicode');
  await seedRecording(value, { ...recording, before: recording.after });
  const supplementary = recording.after.rows.find(row => row.Name === '𐐀');
  assert.equal(supplementary.CleanName, '');
  const clean = decodeNativeTextBytes((await database.client.query({ text: `SELECT ${q(database.schemaName)}.${q(postgresCleanValueFunctionName)}($1) AS "Value"`,
    values: [nativeTextBytes(supplementary.Name)] })).rows[0].Value, 'runtime');
  assert.equal(clean, supplementary.CleanName);
  const refreshed = [];
  await new ArtistsPostScanTask({ store: value.store, linkedChildren: value.linkedChildren, library: { ...library, options: library.options,
    getArtist: () => { throw new Error('The frozen batch must resolve every recorded name.'); },
    deleteQueryItemsUnsafeFast: async () => {} }, metadataScanner: {
    refreshLiveItem: async item => refreshed.push(guid(item.Id)),
  } }).run();
  assert.deepEqual(refreshed, recording.calls.filter(call => call.action === 'refresh').map(call => guid(call.id)));
});

test('postgres: Artist maintenance sends its captured entity through the real metadata host and skips the next run', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, configuration, host, stateRoot, loadContext, linkedChildren } = value;
  configuration.EnableNormalizedItemByNameIds = true;
  const recording = recordings.find(row => row.sample.Name === 'matched curated refresh state');
  await seedRecording(value, recording);
  const creator = new ItemCreationService({ store, library, loadContext, linkedChildren }); library.itemCreation = creator;
  t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  library.unsafeItemDeletion = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  const seen = [], context = host.loadContext;
  const controlledContext = Object.assign(async (reference, options) => {
    assert.equal(isNativeItemEntity(options?.draft), true);
    const loaded = await context(reference, options);
    assert.equal(loaded.item, options.draft);
    assert.equal(loaded.item.LinkedChildrenLoaded, false);
    assert.deepEqual(loaded.item.ProviderIds, {}); assert.deepEqual(loaded.item.LockedFields, []);
    assert.deepEqual(loaded.item.ImageInfos, []);
    assert.ok(loaded.item.Path.startsWith(stateRoot)); seen.push(loaded.item);
    return loaded;
  }, context);
  controlledContext.withContext = async (reference, options, operation) => {
    const loaded = await controlledContext(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  host.loadContext = controlledContext;
  const errors = [], scanner = new LibraryMetadataScanService({ library, metadata: host, scheduler: new LibraryTaskScheduler() });
  const task = new ArtistsPostScanTask({ store, library, linkedChildren, metadataScanner: scanner, logger: { error: error => errors.push(error) } });
  await task.run(); assert.deepEqual(errors, []); assert.equal(seen.length, 1);
  const Id = nativeGuid(recording.before.rows.find(row => row.Type.endsWith('.MusicArtist')).Id);
  const saved = (await database.rows('BaseItems', { where: { Id } }))[0];
  assert.equal(dateText(saved.DateLastRefreshed), value.now);
  for (const name of ['BaseItemProviders', 'BaseItemMetadataFields']) {
    assert.deepEqual(await database.rows(name, { where: { ItemId: Id } }), []);
  }
  const images = await database.rows('BaseItemImageInfos', { where: { ItemId: Id } });
  assert.equal(images.length, 1); assert.equal(images[0].ImageType, 0);
  assert.equal(images[0].Path, path.join(stateRoot, 'metadata', 'artists', 'Initial100', 'poster.jpg'));
  await task.run(); assert.deepEqual(errors, []); assert.equal(seen.length, 1);
  assert.deepEqual((await database.rows('BaseItems', { where: { Id } }))[0], saved);
  assert.throws(() => host.refreshLiveItem({ Id, Type: 'MusicArtist' }), /branded/u);
});

test('postgres: Artist maintenance bounds name, object-state and deletion pages against a larger catalogue', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, configuration, stateRoot, loadContext, linkedChildren } = value;
  configuration.EnableNormalizedItemByNameIds = true;
  const creator = new ItemCreationService({ store, library, loadContext, linkedChildren }); library.itemCreation = creator;
  t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  library.unsafeItemDeletion = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  const movie = native.results.find(row => row.sample.Name === 'fresh').before.rows.find(row => row.Type.endsWith('.Movie'));
  const artist = native.results.find(row => row.sample.Name === 'existing').before.rows.find(row => row.Type.endsWith('.MusicArtist'));
  const table = `${q(database.schemaName)}.${q('BaseItems')}`;
  await database.client.query({ text: `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},
    CASE WHEN position <= 1000 THEN $2::jsonb ELSE $1::jsonb END || jsonb_build_object(
      'Id', convert_to(md5($3::text || position::text), 'UTF8'), 'Name', convert_to('Background ' || position::text, 'UTF8'),
      'Path', convert_to($4::text || '/' || position::text, 'UTF8')))).* FROM generate_series(1, 12000) position`,
    values: [physicalSeed(movie), physicalSeed(artist), 'artist-maintenance-scale-', path.join(stateRoot, 'metadata', 'artists')] });
  await database.insert('BaseItems', { ...movie, Id: nativeGuid(movie.Id) });
  await database.client.query({ text: `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, $1::jsonb
    || jsonb_build_object('Id', convert_to(md5('artist-live-' || position::text), 'UTF8'), 'Name', convert_to('Name ' || lpad(position::text, 3, '0'), 'UTF8'),
      'CleanName', convert_to('name ' || lpad(position::text, 3, '0'), 'UTF8'), 'DateLastRefreshed', NULL,
      'Path', convert_to($2::text || '/' || position::text, 'UTF8')))).* FROM generate_series(0, 224) position`,
    values: [physicalSeed(artist), path.join(stateRoot, 'metadata', 'artists', 'live')] });
  for (let index = 0; index < 225; index++) {
    const name = 'Name ' + String(index).padStart(3, '0'), ItemValueId = `ba390000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    await database.insert('ItemValues', { ItemValueId, Type: index % 2, Value: name, CleanValue: name.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemId: nativeGuid(movie.Id), ItemValueId });
    const aliasId = `ba390000-0000-0000-0001-${String(index).padStart(12, '0')}`;
    await database.insert('ItemValues', { ItemValueId: aliasId, Type: index % 2, Value: name.toUpperCase() + '!!!', CleanValue: name.toLowerCase() + ' alias' });
    await database.insert('ItemValuesMap', { ItemId: nativeGuid(movie.Id), ItemValueId: aliasId });
  }
  const pages = [], refreshed = [], removed = [], errors = [], load = library.load.bind(library);
  library.load = (db, user, options) => { assert.ok(options?.baseRows && options.baseRows.length <= 128); return load(db, user, options); };
  library.on('ItemRemoved', ({ Item }) => removed.push(Item.Id));
  library.getArtist = () => { throw new Error('The captured initial batch covers the scale input.'); };
  await store.run(async db => {
    const query = db.client.query.bind(db.client);
    db.client.query = async (...args) => {
      const result = await query(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      for (const part of Array.isArray(result) ? result : [result]) assert.ok((part.rows?.length ?? 0) <= 128, 'Maintenance relations stay in PostgreSQL.');
      if (sql.includes('artist-maintenance-page')) pages.push(result.rows.length);
      return result;
    };
    try { await new ArtistsPostScanTask({ store, library, linkedChildren, metadataScanner: {
      refreshLiveItem: async item => { assert.equal(isNativeItemEntity(item), true); refreshed.push(item.Id);
        item.DateLastRefreshed = '2026-10-02T00:00:00.0000000Z'; },
    }, logger: { error: error => errors.push(error) } }).run(); }
    finally { db.client.query = query; }
    assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_%'")).rows, []);
  });
  assert.deepEqual(errors, []); assert.deepEqual(pages, [128, 128, 128, 66]);
  assert.equal(refreshed.length, 225); assert.equal(new Set(refreshed).size, 225);
  assert.equal(removed.length, 1000); assert.equal(new Set(removed).size, 1000);
  assert.equal(Number((await database.client.query('SELECT count(*) FROM "BaseItems"')).rows[0].count), 11226);
});



test('postgres: native partial Artist refresh preserves unknown links while cold and explicit branches stay authoritative', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t);
  const { database, store, library, linkedChildren, loadContext, host } = value;
  const recording = recordings.find(row => row.sample.Name === 'matched curated refresh state');
  await seedRecording(value, recording);
  const Id = nativeGuid(recording.before.rows.find(row => row.Type.endsWith('.MusicArtist')).Id);
  const childId = nativeGuid(recording.before.rows.find(row => row.Type.endsWith('.Movie')).Id);
  await database.insert('LinkedChildren', { ParentId: Id, SortOrder: 0, ChildType: 0, ChildId: childId });
  await database.insert('LinkedChildren', { ParentId: Id, SortOrder: 1, ChildType: 0, ChildId: childId });
  const storedLinks = () => database.rows('LinkedChildren', { where: { ParentId: Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
  const before = await storedLinks();
  const draft = mapRecord((await database.rows('BaseItems', { where: { Id }, limit: 1 }))[0]);
  draft.Path = library.options.expandPath(draft.Path);
  const owner = acquireNativeItemLinkOwner(draft);
  try {
    assert.equal(draft.LinkedChildrenLoaded, false);
    assert.equal(draft.LinkedChildren, EMPTY_NATIVE_LINKS);
    await loadContext.withContext(Id, { draft, includeChildren: false }, async loaded => {
      assert.equal(loaded.item, draft);
      assert.equal(loaded.item.LinkedChildrenLoaded, false);
      assert.equal(loaded.item.LinkedChildren, EMPTY_NATIVE_LINKS);
    });
    // The native FindArtists batch omits LinkedChildEntities, and native SaveItems
    // skips that unknown branch. Run the same real refresh/save host as above.
    await new LibraryMetadataScanService({ library, metadata: host, scheduler: new LibraryTaskScheduler() }).refreshLiveItem(draft);
    assert.equal(draft.LinkedChildrenLoaded, false);
    assert.deepEqual(await storedLinks(), before, 'The real metadata save retains both original link rows and their order.');

    await loadContext.withContext(Id, { includeChildren: false }, async loaded => {
      assert.equal(loaded.item.LinkedChildrenLoaded, true);
      assert.equal(await linkedChildren.count(loaded.item.LinkedChildren), 2n);
    });
    library.itemCreation.unregisterItem(Id);
    await linkedChildren.flushReleases();
    await library.itemCreation.withItem(Id, async warm => {
      const branch = warm.LinkedChildren;
      assert.equal(warm.LinkedChildrenLoaded, true);
      await loadContext.withContext(Id, { draft: warm, includeChildren: false }, async loaded => {
        assert.equal(loaded.item, warm);
        assert.equal(loaded.item.LinkedChildren, branch, 'An existing complete branch is not replaced by a new cold lookup.');
        assert.equal(await linkedChildren.count(loaded.item.LinkedChildren), 2n);
      });
    });

    draft.LinkedChildren = null;
    await loadContext.withContext(Id, { draft }, async loaded => {
      assert.equal(loaded.item.LinkedChildrenLoaded, true);
      assert.equal(loaded.item.LinkedChildren, null, 'The explicit null sentinel remains observable.');
      await assert.rejects(store.transaction(db => persistFolderLinks(db, loaded.item, { linkedChildren })), TypeError);
    });
    assert.deepEqual(await storedLinks(), before);

    draft.LinkedChildren = EMPTY_NATIVE_LINKS;
    await loadContext.withContext(Id, { draft }, async loaded => {
      assert.equal(loaded.item.LinkedChildrenLoaded, true);
      assert.equal(loaded.item.LinkedChildren, EMPTY_NATIVE_LINKS);
      await store.transaction(db => persistFolderLinks(db, loaded.item, { linkedChildren }));
    });
    assert.deepEqual(await storedLinks(), [], 'An explicit complete empty branch still clears stored links.');
  } finally { owner.release(); await linkedChildren.flushReleases(); }
});
