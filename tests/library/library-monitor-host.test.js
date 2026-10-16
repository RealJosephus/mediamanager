import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryMonitorHost } from '../../src/library/library-monitor-host.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { newNativeItemEntity, acquireNativeItemLinkOwner } from '../../src/library/native-item-entity.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000 };
const id = value => 'cd710000-0000-0000-0000-' + String(value).padStart(12, '0');
const nativeTypes = { Folder: 'MediaBrowser.Controller.Entities.Folder', Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder', MusicArtist: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
  MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum' };
const entity = (number, type = 'Folder', fields = {}) => Object.assign(newNativeItemEntity(nativeTypes[type] ?? type),
  { Id: id(number), Name: 'Item ' + number, Path: 'Z:\\Media\\' + number, ...fields });

function controlledHost(overrides = {}) {
  const items = new Map(), calls = [], library = Object.assign(new EventEmitter(), { options: { configuration: { UICulture: 'en-US' } } });
  const linkedChildren = { async flushReleases() {} };
  const itemCreation = { linkedChildren, async getItemById(key) { return items.get(idKey(key)) ?? null; },
    retainItem: item => acquireNativeItemLinkOwner(item),
    async withItem(key, operation) { return operation(await this.getItemById(key)); } };
  const dependencies = { store: {}, library, itemCreation,
    scanHost: { async validateChildren(item, options) { calls.push(['validate', item.Id, options]); } },
    metadata: { queue(itemId, options, priority) { calls.push(['queue', itemId, options, priority]); } },
    metadataScanner: { async refreshLiveItem(item, options) { calls.push(['refresh', item.Id, options]); } },
    loadContext: { async withContext(_id, _options, operation) { return operation({ libraryOptions: { EnableRealtimeMonitor: true } }); } },
    fileSystem: { async stat() { return { isDirectory: () => true, isFile: () => false }; } },
    vfs: {}, identityMap: {}, ...overrides };
  return { host: new LibraryMonitorHost(dependencies), dependencies, items, calls, library, itemCreation };
}

test('monitor events project storage paths back to their watched identity root and reject escapes', async () => {
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\Media', accessRoot: '/media', style: 'windows', returnAccess: 'Monitor test' });
  let options;
  const owner = { close() {} }, changes = [], errors = [];
  const { host } = controlledHost({ identityMap, vfs: { async watch(access, input) {
    assert.equal(access, '/media/Films'); options = input; return owner;
  } } });
  assert.equal(await host.watchPath('Z:\\Media\\Films', { onChange: value => changes.push(value), onError: error => errors.push(error) }), owner);
  options.onChange({ path: '/media/Films/One/movie.nfo', type: 'change' });
  options.onChange({ path: '/media/Films', type: 'rename' });
  options.onChange({ path: '/media/Other/file.nfo', type: 'change' });
  assert.deepEqual(changes, [{ path: 'Z:\\Media\\Films\\One\\movie.nfo', type: 'change' }, { path: 'Z:\\Media\\Films', type: 'rename' }]);
  assert.equal(errors.length, 1);
});

test('ChangedExternally admits default automated High work without waiting, and skips plugin folders for monitoring', async () => {
  const deferred = Promise.withResolvers(), logged = [], failure = new Error('Queued failure');
  let admitted;
  const { host } = controlledHost({ metadata: { queue(...args) { admitted = args; return deferred.promise; } },
    logger: { error(error) { logged.push(error); } } });
  const item = entity(1, 'Movie');
  assert.equal(host.changedExternally(item), undefined);
  assert.equal(admitted[0], item.Id); assert.equal(admitted[2], 0);
  assert.equal(admitted[1].IsAutomated, true); assert.equal(admitted[1].MetadataRefreshMode, 'Default');
  assert.equal(admitted[1].ImageRefreshMode, 'Default'); assert.equal(admitted[1].ForceSave, false);
  assert.equal(await host.getWatchPath(item), item.Path, 'The ItemAdded branch does not require Folder.');
  assert.equal(await host.getWatchPath(entity(2, 'Emby.Server.Implementations.Playlists.PlaylistsFolder')), null);
  deferred.reject(failure); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(logged, [failure]);
});

test('an unmapped identity can use state storage only inside a declared application root', async () => {
  const identityMap = new IdentityAccessMap(), observed = [];
  identityMap.addPrefix({ identityRoot: 'Z:\\Media', accessRoot: '/media', style: 'windows', returnAccess: 'Preserve media identity.' });
  const { host, library } = controlledHost({ identityMap,
    vfs: { async stat(access) { observed.push(['media', access]); return { kind: 'directory' }; } },
    fileSystem: { async stat(identity) { observed.push(['state', identity]); return { isDirectory: () => true, isFile: () => false }; } } });
  library.options.programDataPath = 'Z:\\State';
  assert.deepEqual(await host.getFileInfo('Z:\\State\\root'), { isDirectory: true, exists: true });
  assert.deepEqual(await host.getFileInfo('Z:\\Media\\Film'), { isDirectory: true, exists: true });
  assert.deepEqual(await host.getFileInfo('Z:\\State-other\\Film'), { isDirectory: false, exists: false });
  assert.deepEqual(await host.getFileInfo('Z:\\Unknown\\Film'), { isDirectory: false, exists: false });
  assert.deepEqual(observed, [['state', 'Z:\\State\\root'], ['media', '/media/Film']]);
});

test('queued batch cache boundaries finish after ordinary failures and omit the final clear during shutdown', async () => {
  const { host } = controlledHost(), calls = [];
  host.scanHost.clearIgnoreRuleCache = () => calls.push('clear');
  const failure = new Error('Provider boundary failure');
  await assert.rejects(host.runQueuedBatch(async () => { calls.push('process'); throw failure; }), error => error === failure);
  assert.deepEqual(calls, ['clear', 'process', 'clear']);
  calls.length = 0;
  const lifetime = new AbortController();
  await host.runQueuedBatch(async () => { calls.push('process'); lifetime.abort(); }, { signal: lifetime.signal });
  assert.deepEqual(calls, ['clear', 'process']);
  calls.length = 0;
  await assert.rejects(host.runQueuedBatch(() => assert.fail('Closed queues cannot run.'), { signal: lifetime.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, []);
});

test('queued leaf, Folder and CollectionFolder work follows metadata then actual child validation order', async () => {
  const f = controlledHost(), leaf = entity(1, 'Movie'), folder = entity(2), collection = entity(3, 'CollectionFolder',
    { PhysicalFolderIds: [id(2), id(999), id(1), id(2)] });
  for (const item of [leaf, folder, collection]) f.items.set(idKey(item.Id), item);
  await f.host.refreshQueuedItem(id(999));
  await f.host.refreshQueuedItem(leaf.Id, { IsAutomated: true });
  await f.host.refreshQueuedItem(folder.Id, { IsAutomated: true });
  await f.host.refreshQueuedItem(collection.Id, { IsAutomated: true });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['refresh', leaf.Id], ['refresh', folder.Id], ['validate', folder.Id],
    ['refresh', collection.Id], ['refresh', folder.Id], ['validate', folder.Id], ['refresh', folder.Id], ['validate', folder.Id]]);
  for (const call of f.calls.filter(call => call[0] === 'validate')) {
    assert.equal(call[2].recursive, true); assert.equal(call[2].refreshChildMetadata, true); assert.equal(call[2].allowRemoveRoot, false);
  }
  f.dependencies.metadataScanner.refreshLiveItem = async () => { throw new Error('Metadata failed'); };
  const count = f.calls.length;
  await assert.rejects(f.host.refreshQueuedItem(folder.Id), /Metadata failed/u); assert.equal(f.calls.length, count);
});

async function postgresFixture(t) {
  const database = await createPostgresTestDatabase(null, 'monitor_host', { max: 1 });
  const store = new DomainStore(database), links = new PostgresLinkedChildrenStore({ database });
  await links.initialize();
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } });
  const f = controlledHost({ store, scheduler });
  f.itemCreation.linkedChildren = links;
  t.after(async () => {
    const failures = [];
    for (const close of [() => scheduler.close(), () => links.close(), () => store.close(), () => dropPostgresTestDatabase(database)]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Monitor fixture cleanup failed.');
  });
  const seed = async (number, type = 'Folder', fields = {}) => {
    const item = entity(number, type, fields); f.items.set(idKey(item.Id), item);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: item.Id, Type: item.NativeType, Name: item.Name,
      Path: item.Path, SortName: item.Name, IsFolder: item.IsFolder, DateCreated: '2026-10-16 00:00:00.0000000',
      Data: '{}', ...fields }));
    return item;
  };
  const released = async () => {
    await links.flushReleases();
    for (const table of ['item_states', 'item_cohorts', 'pins', 'sets']) assert.equal(BigInt((await database.client.query(
      `SELECT count(*) AS count FROM "${links.schemaName}".${table}`)).rows[0].count), 0n, table);
    assert.deepEqual((await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
      AND relname LIKE 'mm_monitor_%'`)).rows, []);
  };
  return { ...f, store, database, links, scheduler, seed, released };
}

test('postgres: affected lookup chooses the newest exact path, ascends deleted owners and retains its final item', pg, async t => {
  const f = await postgresFixture(t);
  const owner = await f.seed(1), parent = await f.seed(2);
  const older = await f.seed(3, 'Movie', { Path: 'Z:\\Media\\Movie.mkv' });
  const recent = await f.seed(4, 'Movie', { Path: older.Path, DateCreated: '2026-10-16 01:00:00.0000000', OwnerId: owner.Id, ParentId: parent.Id, ExtraType: 1 });
  const observed = [];
  f.host.fileSystem.stat = async identity => {
    observed.push(identity);
    if (identity === recent.Path) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    return { isDirectory: () => true, isFile: () => false };
  };
  const result = await f.host.resolveAffectedItem(recent.Path + '\\sidecar.nfo');
  assert.equal(result.item, owner); assert.deepEqual(observed, [recent.Path, owner.Path]);
  await result.dispose(); await result.dispose();
  f.items.delete(idKey(owner.Id)); observed.length = 0;
  const fallback = await f.host.resolveAffectedItem(recent.Path);
  assert.equal(fallback.item, parent); await fallback.dispose();
  assert.equal(await f.host.resolveAffectedItem('Z:\\Unmapped\\Nothing'), null);
  await f.released();
});

test('postgres: watch paths remain distinct, sorted and bounded across pages, with early iterator cleanup', pg, async t => {
  const f = await postgresFixture(t);
  const roots = Array.from({ length: 260 }, (_, index) => entity(index + 1, 'CollectionFolder',
    { Path: 'Z:\\Views\\' + index, PhysicalLocationsList: ['Z:\\Media\\' + String(index).padStart(3, '0')] }));
  roots.push(entity(500, 'Movie'), entity(501, 'Emby.Server.Implementations.Playlists.PlaylistsFolder'));
  roots.push(entity(502, 'CollectionFolder', { PhysicalLocationsList: roots[0].PhysicalLocationsList }));
  f.host.scanHost.getAggregateFolder = async () => ({});
  f.host.scanHost.withChildSnapshot = async (_root, operation) => operation({ async *pages() {
    for (let offset = 0; offset < roots.length; offset += 128) yield roots.slice(offset, offset + 128);
  } });
  const paths = []; for await (const identity of f.host.getWatchPaths()) paths.push(identity);
  assert.deepEqual(paths, Array.from({ length: 260 }, (_, index) => 'Z:\\Media\\' + String(index).padStart(3, '0')));
  for await (const identity of f.host.getWatchPaths()) { assert.equal(identity, paths[0]); break; }
  await f.released();
});

test('postgres: queued Artist validates unique physical album artists before itself and preserves failure boundaries', pg, async t => {
  const f = await postgresFixture(t);
  const requested = await f.seed(1, 'MusicArtist', { Name: 'Selected', CleanName: 'selected' });
  await f.seed(10);
  const physical = await f.seed(2, 'MusicArtist', { ParentId: id(10) });
  const fallback = await f.seed(3, 'MusicArtist', { ParentId: id(10) });
  const seeds = [[4, physical.Id, []], [5, physical.Id, []], [6, null, ['Fallback']]];
  const ItemValueId = id(104);
  await f.database.insert('ItemValues', { ItemValueId, Type: 1, Value: 'Selected', CleanValue: 'selected' });
  for (const [number, ParentId, AlbumArtists] of seeds) {
    const album = await f.seed(number, 'MusicAlbum', { ParentId, AlbumArtists: AlbumArtists.join('|'), Data: JSON.stringify({ AlbumArtists }) });
    await f.database.insert('ItemValuesMap', { ItemValueId, ItemId: album.Id });
  }
  f.library.getArtist = async name => { assert.equal(name, 'Fallback'); return fallback; };
  await f.host.refreshQueuedItem(requested.Id, { IsAutomated: true });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['validate', physical.Id], ['validate', fallback.Id], ['refresh', requested.Id]]);
  f.calls.length = 0;
  f.host.scanHost.validateChildren = async artist => { f.calls.push(['validate', artist.Id]); if (artist.Id === physical.Id) throw new Error('Validation failed'); };
  await assert.rejects(f.host.refreshQueuedItem(requested.Id), /Validation failed/u);
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['validate', physical.Id], ['validate', fallback.Id]]);
  await f.released();
});

async function runtimeFixture(t) {
  const programDataPath = await mkdtemp(path.join(os.tmpdir(), 'library-monitor-host-'));
  const database = await createPostgresTestDatabase(null, 'monitor_pipeline', { max: 1 });
  const registry = new StorageRegistry(); let runtime;
  t.after(async () => {
    const failures = [];
    for (const close of [() => runtime?.close(), () => registry.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(programDataPath), os.tmpdir()); assert.ok(path.basename(programDataPath).startsWith('library-monitor-host-'));
      await rm(programDataPath, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Monitor runtime cleanup failed.');
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {});
  await adapter.mkdir('/Watched');
  await adapter.mkdir('/Watched/Existing');
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap(), identityRoot = 'Z:\\MonitorHostMedia';
  identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'Monitor pipeline fixture' });
  const ignoreIdentityMap = await knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots: [identityRoot] });
  const directory = path.join(programDataPath, 'root', 'default', 'Watched'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'location.mblink'), identityRoot + '\\Watched');
  await writeFile(path.join(directory, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>true</EnableRealtimeMonitor><SaveLocalMetadata>false</SaveLocalMetadata></LibraryOptions>');
  runtime = await createRuntime({ database, programDataPath, vfs, identityMap, ignoreIdentityMap, serverId: 'monitor-pipeline',
    configuration: { UICulture: 'en-US', EnableCaseSensitiveItemIds: true, LibraryScanFanoutConcurrency: 1 } });
  await runtime.libraryScanLifecycle.validateTopLibraryFolders();
  return { database, runtime, adapter, identityRoot, host: runtime.libraryMonitorHost };
}

test('postgres: an admitted filesystem change executes the actual metadata and Folder validation pipeline', pg, async t => {
  const { database, runtime, adapter, identityRoot, host } = await runtimeFixture(t);
  await adapter.mkdir('/Watched/Added');
  const selected = await host.resolveAffectedItem(identityRoot + '\\Watched\\Added');
  assert.ok(selected, JSON.stringify((await database.rows('BaseItems')).map(row => ({ type: row.Type, path: row.Path }))));
  assert.equal(selected.item.Path, identityRoot + '\\Watched', JSON.stringify((await database.rows('BaseItems')).map(row => ({ id: row.Id, type: row.Type, path: row.Path }))));
  host.changedExternally(selected.item); await selected.dispose(); await runtime.metadata.drain();
  const added = await database.rows('BaseItems', { where: { Path: identityRoot + '\\Watched\\Added' } });
  assert.equal(added.length, 1); assert.equal(added[0].Type, nativeTypes.Folder); assert.ok(added[0].DateLastRefreshed);
});

test('postgres: queued Artist cancellation reaches every physical validation and preserves the final metadata catch boundary', pg, async t => {
  const { database, runtime, adapter, identityRoot } = await runtimeFixture(t);
  const [parent] = await database.rows('BaseItems', { where: { Path: identityRoot + '\\Watched' } });
  assert.ok(parent);
  const seed = async (number, type, name, ParentId = parent.Id, relative = name) => {
    const item = { Id: id(number), Type: nativeTypes[type], Name: name, CleanName: name.toLowerCase(),
      SortName: name, Path: identityRoot + '\\Watched\\' + relative.replaceAll('/', '\\'), ParentId, TopParentId: parent.Id,
      IsFolder: true, DateCreated: '2026-10-16 00:00:00.0000000', Data: '{}' };
    await database.insert('BaseItems', postgresTestRow('BaseItems', item));
    await adapter.mkdir('/Watched/' + relative);
    return item;
  };
  const selected = await seed(701, 'MusicArtist', 'Selected');
  const empty = await seed(702, 'MusicArtist', 'NoAlbums');
  const physical = [await seed(703, 'MusicArtist', 'PhysicalA'), await seed(704, 'MusicArtist', 'PhysicalB')];
  const ItemValueId = id(705);
  await database.insert('ItemValues', { ItemValueId, Type: 1, Value: selected.Name, CleanValue: selected.CleanName });
  for (let index = 0; index < physical.length; index++) {
    const album = await seed(706 + index, 'MusicAlbum', 'Album' + index, physical[index].Id, physical[index].Name + '/Album' + index);
    await database.insert('ItemValuesMap', { ItemValueId, ItemId: album.Id });
  }
  const physicalIds = physical.map(item => item.Id).sort(), started = [], completed = [], metadata = [], metadataFailures = [];
  let controller, cancelWhenStarted = false, reason;
  const onStarted = ({ Item }) => {
    if (!physicalIds.includes(Item.Id)) return;
    started.push(Item.Id);
    if (cancelWhenStarted) { cancelWhenStarted = false; controller.abort(reason); }
  };
  const onCompleted = ({ Item }) => { if (physicalIds.includes(Item.Id)) completed.push(Item.Id); };
  runtime.refreshes.on('RefreshStarted', onStarted);
  runtime.refreshes.on('RefreshCompleted', onCompleted);
  const refresh = runtime.metadataScanner.refreshLiveItem.bind(runtime.metadataScanner);
  runtime.metadataScanner.refreshLiveItem = async (item, options) => {
    metadata.push(item.Id);
    try { return await refresh(item, options); }
    catch (error) { metadataFailures.push(error); throw error; }
  };
  try {
    for (const phase of ['before-physical-validation', 'during-physical-validation']) {
      started.length = completed.length = metadata.length = metadataFailures.length = 0;
      controller = new AbortController(); reason = new DOMException(phase, 'AbortError');
      cancelWhenStarted = phase === 'during-physical-validation';
      if (!cancelWhenStarted) controller.abort(reason);
      // Both entries use the actual shared provider queue. Its second entry
      // has no physical artists, so native RefreshArtist catches its own
      // metadata cancellation and still lets the queue finish normally.
      const results = await Promise.allSettled([
        runtime.metadata.queue(selected.Id, { signal: controller.signal }),
        runtime.metadata.queue(empty.Id, { signal: controller.signal })
      ]);
      await runtime.metadata.drain();
      assert.equal(results[0].status, 'rejected', phase);
      assert.equal(results[0].reason, reason, phase);
      assert.equal(results[1].status, 'fulfilled', phase);
      assert.deepEqual(started.sort(), physicalIds, phase);
      assert.deepEqual(completed.sort(), physicalIds, phase);
      assert.deepEqual(metadata, [empty.Id], phase);
      assert.deepEqual(metadataFailures, [reason], phase);
      assert.equal(runtime.metadata.getRefreshQueue().size, 0);
      assert.equal(runtime.refreshes.snapshot().size, 0);
      await runtime.linkedChildren.flushReleases();
      for (const table of ['item_states', 'item_cohorts']) assert.equal(BigInt((await database.client.query(
        `SELECT count(*) AS count FROM "${runtime.linkedChildren.schemaName}".${table}`)).rows[0].count), 0n, table);
      assert.deepEqual((await database.client.query(`SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema()
        AND relname LIKE 'mm_monitor_%'`)).rows, []);
    }
  } finally {
    runtime.refreshes.off('RefreshStarted', onStarted);
    runtime.refreshes.off('RefreshCompleted', onCompleted);
    runtime.metadataScanner.refreshLiveItem = refresh;
  }
});
