import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CollectionService } from '../../src/library/collection-service.js';
import { LibraryConfigurationService } from '../../src/library/library-configuration-service.js';
import { newNativeItemEntity, acquireNativeItemLinkOwner } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PostgresLinkedChildrenStore, EMPTY_NATIVE_LINKS } from '../../src/library/postgres-linked-children.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { readTestLinks, assignTestLinks, captureTestEvent } from './collection-test-consumers.js';
const pg = { skip: !postgresTestConnectionString };
async function boundary(t, items = new Map(), excluded = []) {
  const database = await createPostgresTestDatabase(null, 'collection_native');
  const store = new DomainStore(database), linkedChildren = new PostgresLinkedChildrenStore({ database });
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'collection-native-test', configuration: { MetadataCountryCode: 'US' } });
  const owners = new Set();
  t.after(async () => {
    for (const owner of owners) owner.release();
    await linkedChildren.flushReleases(); await linkedChildren.close();
    await dropPostgresTestDatabase(database); await store.close();
  });
  await linkedChildren.initialize();
  const seed = async item => {
    owners.add(acquireNativeItemLinkOwner(item));
    if (excluded.includes(guid(item.Id))) return;
    if (item.OwnerId && guid(item.OwnerId) !== guid(Id(0)) && !items.has(guid(item.OwnerId))) {
      if (!(await database.rows('BaseItems', { where: { Id: item.OwnerId } })).length) await database.insert('BaseItems',
        postgresTestRow('BaseItems', { Id: item.OwnerId, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Controlled owner' }));
    }
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: item.Id, Type: item.NativeType ?? 'MediaBrowser.Controller.Entities.Folder',
      Name: item.Name ?? '', Path: item.Path, ParentId: item.ParentId && guid(item.ParentId) !== guid(Id(0)) ? item.ParentId : null, IsFolder: item.IsFolder,
      IsMovie: item.Type === 'Movie', MediaType: item.Type === 'Movie' ? 'Video' : null,
      OwnerId: item.OwnerId && guid(item.OwnerId) !== guid(Id(0)) ? item.OwnerId : null, OfficialRating: item.OfficialRating,
      DateCreated: item.DateCreated, DateModified: item.DateModified, SortName: item.SortName ?? item.Name ?? '',
      Data: JSON.stringify({ PrimaryVersionId: item.PrimaryVersionId, LockedFields: item.LockedFields }) }));
  };
  for (const item of items.values()) await seed(item);
  const itemCreation = { retainItem: acquireNativeItemLinkOwner,
    getItemById: async id => items.get(guid(id)) ?? null,
    async withItem(id, operation) {
      const item = await this.getItemById(id), owner = item ? this.retainItem(item) : null;
      try { return await operation(item); }
      finally { owner?.release(); await linkedChildren.flushReleases(); }
    } };
  const loadContext = async (_id, { draft } = {}) => ({ item: draft ?? items.get(guid(_id)) });
  loadContext.withContext = async (reference, options, operation) => operation(await loadContext(reference, options));
  return { database, store, linkedChildren, library, itemCreation, loadContext, seed };
}

const fixture = fileURLToPath(new URL('./fixtures/collection-manager/', import.meta.url));
const input = JSON.parse(await fs.readFile(path.join(fixture, 'input.json'), 'utf8'));
const native = JSON.parse(await fs.readFile(path.join(fixture, 'native.json'), 'utf8'));
const provenance = JSON.parse(await fs.readFile(path.join(fixture, 'provenance.json'), 'utf8'));
const Id = index => index === 0 ? '00000000-0000-0000-0000-000000000000' : `969d0000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const guid = value => value == null ? null : idKey(value);
const ratingScore = value => {
  const score = ({ G: 1, PG: 5, 'PG-13': 8, R: 9 })[value.toUpperCase()];
  return score === undefined ? null : { score, subScore: 0 };
};
const project = async item => ({ id: guid(item.Id), name: item.Name, path: item.Path, parentId: guid(item.ParentId),
  isLocked: item.IsLocked, providerIds: item.ProviderIds, officialRating: item.OfficialRating,
  links: (await readTestLinks(item) ?? []).map(link => ({ itemId: guid(link.ItemId), type: link.Type ?? 0,
    path: link.Path ?? null, libraryItemId: link.LibraryItemId ?? null })) });

function normalize(value, program, createdId) {
  if (typeof value === 'string') {
    if (value === guid(createdId)) return '{collection}';
    const text = value.replaceAll(program, '{program}');
    return text.startsWith('{program}') ? text.replaceAll('\\', '/') : text;
  }
  if (Array.isArray(value)) return value.map(entry => normalize(entry, program, createdId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, normalize(entry, program, createdId)]));
  return value;
}

async function runSample(t, sample, directory, { dataPath, blockCreate } = {}) {
  const program = path.join(directory, 'program'), data = dataPath ?? path.join(program, 'data'), collections = path.join(data, 'collections');
  await fs.mkdir(program, { recursive: true });
  const map = value => value?.replaceAll('{collections}', collections).replaceAll('{data}', data).replaceAll('{program}', program);
  const pending = [], calls = [], trace = (action, value = null) => {
    calls.push({ action, value: structuredClone(value) });
    if (sample.failure === action) throw new Error(`Controlled ${action} failure.`);
  };
  const root = { Id: Id(1), Path: path.join(program, 'root'), Type: 'AggregateFolder', IsFolder: true };
  const parent = newNativeItemEntity(sample.parentType === 'MusicArtist' ? 'MediaBrowser.Controller.Entities.Audio.MusicArtist' : 'MediaBrowser.Controller.Entities.Folder');
  Object.assign(parent, { Id: Id(2), Name: 'collection-root', ParentId: sample.parentType === 'MusicArtist' ? Id(0) : root.Id, Path: map(sample.parentPath ?? '{collections}') });
  let children = [];
  if (sample.existingFolder !== false) { await fs.mkdir(parent.Path, { recursive: true }); children = [parent]; }
  if (sample.blockedDirectory) { await fs.mkdir(collections, { recursive: true }); await fs.writeFile(path.join(collections, sample.blockedDirectory + ' [boxset]'), 'blocked'); }
  const items = new Map([[guid(root.Id), root], [guid(parent.Id), parent]]);
  for (const specification of sample.items) {
    const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
    Object.assign(item, { Id: Id(specification.id), Name: specification.name, Path: map(specification.path ?? '{program}/movie.mkv'),
      OfficialRating: specification.rating ?? null, DateCreated: specification.created ?? '0001-01-01T00:00:00.0000000Z',
      OwnerId: Id(specification.ownerId ?? 0), PrimaryVersionId: specification.primaryVersionId == null ? null : Id(specification.primaryVersionId) });
    items.set(guid(item.Id), item);
  }
  const runtime = await boundary(t, items, (sample.excludedFromBatch ?? []).map(index => guid(Id(index))));
  const capturedTrace = (action, capture) => {
    const call = { action, value: null }; calls.push(call);
    pending.push(Promise.resolve(capture).then(value => { call.value = value; }));
    if (sample.failure === action) throw new Error('Controlled ' + action + ' failure.');
  };
  let collection;
  if (!['create', 'ensure'].includes(sample.operation)) {
    collection = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.BoxSet');
    Object.assign(collection, { Id: Id(100), Name: 'Existing', Path: path.join(collections, 'Existing [boxset]'), ParentId: parent.Id,
      OfficialRating: sample.officialRating === undefined ? 'R' : sample.officialRating,
      IsLocked: sample.isLocked === true, LockedFields: sample.lockedFields ?? [] });
    const initialLinks = sample.links === null ? null : (sample.links ?? []).map(link => ({
      ItemId: link.id == null ? null : Id(link.id), Type: link.type ?? 0, Path: map(link.path) ?? null,
      LibraryItemId: link.libraryItemId == null ? null : guid(Id(link.libraryItemId)) }));
    items.set(guid(collection.Id), collection);
    await runtime.seed(collection);
    await assignTestLinks(runtime, collection, initialLinks);
  }
  if (sample.ratingScores) {
    const scores = JSON.stringify(sample.ratingScores).replaceAll("'", "''");
    await runtime.database.client.query('CREATE OR REPLACE FUNCTION "' + runtime.database.schemaName + '".mm_parental_rating_score(source_bytes bytea,context jsonb) RETURNS integer[] LANGUAGE sql AS $score$ SELECT ARRAY[(entry->>\'score\')::integer,(entry->>\'subScore\')::integer] FROM (SELECT \'' + scores + '\'::jsonb->convert_from($1,\'UTF8\') entry) scores $score$');
  }
  const service = new CollectionService({fileSystem: testFileSystem,  store: runtime.store, linkedChildren: runtime.linkedChildren,
  programDataPath: program, dataPath: data, library: { options: { configuration: { MetadataCountryCode: 'US' } },
    load: runtime.library.load.bind(runtime.library),
    getItemList: async ({ Ids }) => Ids.filter(id => !(sample.excludedFromBatch ?? []).some(index => guid(Id(index)) === guid(id)))
      .map(id => items.get(guid(id))).filter(Boolean) },
  itemCreation: { ...runtime.itemCreation, createItems: async ([item]) => {
    collection = item; trace('create', await project(item)); await blockCreate?.(); items.set(guid(item.Id), item); await runtime.seed(item);
  } }, loadContext: runtime.loadContext,
  updates: {}, updateRepository: async item => trace('save', await project(item)),
  findByPath: async value => [...items.values()].filter(item => item.Path === value && (!item.OwnerId || guid(item.OwnerId) === guid(Id(0)) || item.ExtraType != null)
    && (item.PrimaryVersionId == null || !items.has(guid(item.PrimaryVersionId)))).sort((left, right) => (right.DateCreated ?? '').localeCompare(left.DateCreated ?? ''))[0] ?? null,
  metadata: { queue: (id, options, priority) => trace('queue', { id: guid(id), options: { ...options, ForceSave: options.ForceSave ?? false }, priority: priority === 0 ? 'High' : priority }) },
  localization: { serverCulture: 'en-US', text: () => sample.serverName ?? 'Collections' },
  host: { getAggregateFolder: async () => root, getCachedChildrenPage: async (_root, { startIndex, limit }) => ({
    items: children.slice(startIndex, startIndex + limit), hasMore: startIndex + limit <= children.length
  }), invalidateChildren: () => trace('root-invalidate') },
  libraryConfiguration: { admitCollectionOperation: () => ({ addVirtualFolder: async (name, type, options, refresh) => {
    trace('library-add', { name, type, options: { PathInfos: options.PathInfos, EnableRealtimeMonitor: options.EnableRealtimeMonitor,
      SaveLocalMetadata: options.SaveLocalMetadata }, refresh });
    if (sample.resolveCreatedFolder !== false) children = [parent];
  }, release() {} }) }, monitor: { reportFileSystemChangeBeginning: filename => trace('begin', filename),
    reportFileSystemChangeComplete: (filename, refresh) => trace('complete', { path: filename, refresh }) } });
  service.on('CollectionCreated', ({ Collection }) => capturedTrace('created-event', project(Collection)));
  service.on('ItemsAddedToCollection', ({ Items }) => capturedTrace('added-event', captureTestEvent(Items)));
  service.on('ItemsRemovedFromCollection', ({ Items }) => capturedTrace('removed-event', captureTestEvent(Items)));
  let failed = false, foundFolder = null;
  try {
    const ids = (sample.ids ?? []).map(Id), collectionId = Id(sample.collectionId ?? 100);
    if (sample.operation === 'create') await service.create({ Name: sample.name === undefined ? 'Collection' : sample.name,
      IsLocked: sample.isLocked === true, ProviderIds: sample.providerIds === undefined ? {} : sample.providerIds, ItemIdList: ids, ParentId: Id(999), UserIds: [Id(998)] });
    else if (sample.operation === 'add') await service.add(collectionId, ids);
    else if (sample.operation === 'remove') await service.remove(collectionId, ids);
    else foundFolder = await service.getCollectionsFolder(sample.createIfNeeded === true) !== null;
  } catch { failed = true; }
  await Promise.all(pending); await service.close();
  const directories = (await fs.readdir(program, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory())
    .map(entry => path.relative(program, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
  return { result: { key: sample.key, failed, foundFolder, calls,
    collection: collection?.LinkedChildren != null ? await project(collection) : null, directories }, service, collection, program, data };
}

test('collection manager fixture binds actual source and loaded assemblies', async () => {
  for (const [filename, expected] of Object.entries(provenance.fixtureSha256)) {
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(fixture, filename))).digest('hex'), expected, filename);
  }
  assert.equal(native.inputSha256, provenance.fixtureSha256['input.json']);
  assert.equal(native.actualCollectionManager, true);
  assert.equal(native.actualBoxSet, true);
  assert.equal(native.realDirectories, true);
  assert.equal(native.results.length, input.length);
  assert.ok(native.assemblies.every(assembly => /^[a-f0-9]{64}$/u.test(assembly.sha256)));
  assert.deepEqual(native.assemblies, provenance.actualAssemblyBinding);
  assert.ok(provenance.sourceFiles.every(source => source.designatedSourceMatchesOracleBuildCopy && /^[a-f0-9]{64}$/u.test(source.sha256)));
  assert.equal(createHash('sha256').update(await fs.readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.sharedBuildPropsSha256);
  assert.equal(provenance.build.status, 0); assert.equal(provenance.process.status, 0);
  for (const sample of native.results) for (const query of sample.pathQueries ?? []) {
    assert.equal(query.IncludeOwnedItems, false); assert.equal(query.IncludeAlternateVersions, false); assert.equal(query.Limit, 1);
    assert.deepEqual(query.order, [{ name: 'DateCreated', direction: 'Descending' }]);
  }
});

for (const sample of input) test(`CollectionManager differential: ${sample.key}`, pg, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-manager-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('collection-manager-'));
    return fs.rm(directory, { recursive: true, force: true }); });
  const expected = native.results.find(result => result.key === sample.key);
  const { result, program, collection } = await runSample(t, sample, directory);
  const expectedProgram = expected.collection?.path.slice(0, expected.collection.path.indexOf('\\program') + '\\program'.length)
    ?? native.results.find(result => result.key === 'create-empty').collection.path.replace('create-empty', sample.key).split('\\data')[0];
  const { exception: _exception, timestamps: _timestamps, pathQueries: _pathQueries, ...contract } = expected;
  contract.directories = contract.directories.map(value => value.replaceAll('\\', '/'));
  assert.deepEqual(normalize(result, program, collection?.Id ?? Id(100)), normalize(contract, expectedProgram, Id(100)));
});

test('managed collections support a declared external data root', pg, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-external-data-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('collection-external-data-'));
    return fs.rm(directory, { recursive: true, force: true }); });
  const sample = { key: 'external-data', operation: 'create', name: 'External', existingFolder: false, items: [] };
  const { result, collection, data } = await runSample(t, sample, directory, { dataPath: path.join(directory, 'external-data') });
  assert.equal(result.failed, false);
  assert.equal(collection.Path, path.join(data, 'collections', 'External [boxset]'));
  assert.equal((await fs.stat(collection.Path)).isDirectory(), true);
});

test('managed collection creation rejects junction traversal', pg, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-junction-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('collection-junction-'));
    return fs.rm(directory, { recursive: true, force: true }); });
  const program = path.join(directory, 'program'), external = path.join(directory, 'external');
  await fs.mkdir(path.join(program, 'data'), { recursive: true }); await fs.mkdir(external);
  await fs.symlink(external, path.join(program, 'data', 'collections'), process.platform === 'win32' ? 'junction' : 'dir');
  const { result } = await runSample(t, { key: 'junction', operation: 'create', name: 'Escape', items: [] }, directory);
  assert.equal(result.failed, true);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(await fs.readdir(external), []);
});

test('collection folder lookup pages roots and keeps the first matching folder', pg, async t => {
  const program = path.join(os.tmpdir(), 'collection-page-instance'), data = path.join(program, 'data');
  const descendants = Array.from({ length: 129 }, (_, index) => ({ Id: Id(index + 1000), NativeType: 'MediaBrowser.Controller.Entities.Movies.Movie', IsFolder: false, Path: data }));
  descendants.push({ Id: Id(2000), NativeType: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true, Path: path.join(data, 'collections', 'child') });
  const ancestor = { Id: Id(2001), NativeType: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true, Path: data };
  descendants.push(ancestor, { Id: Id(2002), NativeType: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true, Path: path.join(data, 'collections') });
  const requests = [], runtime = await boundary(t);
  const service = new CollectionService({fileSystem: testFileSystem,  store: runtime.store, linkedChildren: runtime.linkedChildren, library: {}, itemCreation: { ...runtime.itemCreation, getItemById: async id => descendants.find(item => guid(item.Id) === guid(id)) },
    loadContext: runtime.loadContext, updates: {}, metadata: {},
    libraryConfiguration: { admitCollectionOperation() { throw new Error('Read-only lookup must not acquire configuration admission.'); } },
    programDataPath: program, dataPath: data,
    host: { getAggregateFolder: async () => ({ Id: Id(1) }), getCachedChildrenPage: async (_parent, page) => {
      requests.push(page); return { items: descendants.slice(page.startIndex, page.startIndex + page.limit),
        hasMore: page.startIndex + page.limit <= descendants.length };
    } } });
  assert.equal(await service.getCollectionsFolder(false), ancestor);
  assert.deepEqual(requests, [{ startIndex: 0, limit: 128 }, { startIndex: 128, limit: 128 }]);
  await service.close(); await assert.rejects(service.getCollectionsFolder(false), { status: 503 });
});

async function controlledOwners(t, { gateLookup = false, gatedLibrary, gateScan = false, failLibrary = false } = {}) {
  const program = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-lifecycle-'));
  const data = path.join(program, 'data'), views = path.join(program, 'root', 'default'), collections = path.join(data, 'collections');
  await fs.mkdir(views, { recursive: true }); await fs.mkdir(data);
  const lookupEntered = Promise.withResolvers(), lookupResume = Promise.withResolvers(),
    saveEntered = Promise.withResolvers(), saveResume = Promise.withResolvers(),
    scanEntered = Promise.withResolvers(), scanResume = Promise.withResolvers();
  const root = { Id: Id(1) }, parent = newNativeItemEntity('MediaBrowser.Controller.Entities.Folder');
  Object.assign(parent, { Id: Id(2), Path: collections, ParentId: root.Id });
  const calls = [], items = new Map([[guid(root.Id), root], [guid(parent.Id), parent]]);
  let children = [], firstLookup = true, collectionLibrarySaved = false;
  const host = {
    getAggregateFolder: async () => {
      calls.push('lookup');
      if (firstLookup && gateLookup) { firstLookup = false; lookupEntered.resolve(); await lookupResume.promise; }
      return root;
    },
    getCachedChildrenPage: async (_root, { startIndex, limit }) => ({
      items: children.slice(startIndex, startIndex + limit), hasMore: startIndex + limit <= children.length
    }),
    getUserRootFolder: async () => root, withCachedChildren: async (_root, operation) => operation({ firstByPath: async directory => children.find(item => item.Path === directory) ?? null }),
    invalidateChildren: () => calls.push('invalidate')
  };
  const configuration = new LibraryConfigurationService({fileSystem: testFileSystem,  programDataPath: program, host,
    optionsStore: { reversePath: value => value, save: async (directory, options) => {
      calls.push(`save:${path.basename(directory)}`);
      if (path.basename(directory) === gatedLibrary) { saveEntered.resolve(); await saveResume.promise; }
      if (path.basename(directory) === 'Collections' && failLibrary) throw new Error('Controlled library save failure.');
      collectionLibrarySaved ||= options.PathInfos?.some(info => info.Path === collections) === true;
    } },
    mediaAssets: { stat: async identity => ({ kind: (await fs.stat(identity)).isDirectory() ? 'directory' : 'file' }) },
    lifecycle: { isScanRunning: false, validateTopLibraryFolders: async () => {
      calls.push('validate'); if (collectionLibrarySaved) children = [parent];
    } },
    monitor: { stop: async () => calls.push('stop'), start: async () => calls.push('start') }, sleep: async () => {},
    queueLibraryScan: async () => { calls.push('scan'); scanEntered.resolve(); if (gateScan) await scanResume.promise; }
  });
  const runtime = await boundary(t, items);
  const service = new CollectionService({fileSystem: testFileSystem,  store: runtime.store, linkedChildren: runtime.linkedChildren, library: {}, programDataPath: program, dataPath: data, host,
    libraryConfiguration: configuration, updates: {}, loadContext: runtime.loadContext, metadata: { queue: () => calls.push('queue') },
    itemCreation: { ...runtime.itemCreation, getItemById: async id => items.get(guid(id)) ?? null,
      createItems: async ([item]) => { calls.push('create'); items.set(guid(item.Id), item); await runtime.seed(item); } } });
  t.after(async () => {
    lookupResume.resolve(); saveResume.resolve(); scanResume.resolve();
    await Promise.allSettled([service.close(), configuration.close()]);
    assert.equal(path.dirname(path.resolve(program)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(program).startsWith('collection-lifecycle-'));
    await fs.rm(program, { recursive: true, force: true });
  });
  return { service, configuration, calls, program, views, parent, lookupEntered, lookupResume,
    saveEntered, saveResume, scanEntered, scanResume };
}

test('collection and configuration closure reject late requests while admitted queued work and background scans drain', { ...pg, timeout: 30000 }, async t => {
  const owners = await controlledOwners(t, { gateLookup: true, gatedLibrary: 'Earlier', gateScan: true });
  const { service, configuration, calls, views, parent, lookupEntered, lookupResume, saveEntered, saveResume, scanEntered, scanResume } = owners;
  const earlier = configuration.addVirtualFolder('Earlier', 'boxsets', { PathInfos: [] });
  await saveEntered.promise;
  const created = service.create({ Name: 'Admitted' }), ensured = service.getCollectionsFolder(true);
  await lookupEntered.promise;
  const collectionClosing = service.close(), configurationClosing = configuration.close();
  let configurationClosed = false;
  const observedClose = configurationClosing.then(() => { configurationClosed = true; });
  assert.equal(configuration.close(), configurationClosing);
  assert.throws(() => configuration.admitCollectionOperation(), { status: 503 });
  await assert.rejects(configuration.addVirtualFolder('Late', 'boxsets', { PathInfos: [] }), { status: 503 });
  await assert.rejects(configuration.getVirtualFolders(), { status: 503 });
  await assert.rejects(configuration.addMediaPath('Earlier', { Path: views }), { status: 503 });
  await assert.rejects(configuration.updateMediaPath('Earlier', {}), { status: 503 });
  await assert.rejects(configuration.removeMediaPath('Earlier', views), { status: 503 });
  await assert.rejects(configuration.removeVirtualFolder('Earlier'), { status: 503 });
  await assert.rejects(service.create({ Name: 'Late' }), { status: 503 });
  await assert.rejects(service.getCollectionsFolder(true), { status: 503 });
  await assert.rejects(service.getCollectionsFolder(false), { status: 503 });
  await assert.rejects(service.add(Id(100), []), { status: 503 });
  await assert.rejects(service.remove(Id(100), []), { status: 503 });
  saveResume.resolve(); await earlier;
  assert.equal(configurationClosed, false);
  lookupResume.resolve();
  const collection = await created;
  assert.equal(collection.Name, 'Admitted'); assert.equal(await ensured, parent);
  await scanEntered.promise; await collectionClosing;
  assert.equal(configurationClosed, false, 'Configuration close must also wait for the admitted background scan.');
  scanResume.resolve(); await observedClose;
  assert.deepEqual(calls.filter(call => call.startsWith('save:')), ['save:Earlier', 'save:Collections']);
  assert.equal(calls.filter(call => call === 'create').length, 1);
  assert.deepEqual((await fs.readdir(views)).sort(), ['Collections', 'Earlier']);
});

test('an admitted collections folder request can create its dependency after both owners close', { ...pg, timeout: 30000 }, async t => {
  const { service, configuration, parent, calls, lookupEntered, lookupResume } = await controlledOwners(t, { gateLookup: true });
  const ensured = service.getCollectionsFolder(true);
  await lookupEntered.promise;
  const closing = Promise.all([service.close(), configuration.close()]);
  lookupResume.resolve();
  assert.equal(await ensured, parent); await closing;
  assert.deepEqual(calls.filter(call => call.startsWith('save:')), ['save:Collections']);
  assert.equal(calls.includes('create'), false);
});

test('collection creation releases configuration admission after an early failure', { ...pg, timeout: 30000 }, async t => {
  const { service, configuration, calls, views } = await controlledOwners(t);
  const failed = assert.rejects(service.create({ Name: null }), { status: 500 });
  const closing = Promise.all([service.close(), configuration.close()]);
  await failed; await closing;
  assert.deepEqual(calls, []); assert.deepEqual(await fs.readdir(views), []);
});

test('collection creation releases configuration admission after a gated dependency failure', { ...pg, timeout: 30000 }, async t => {
  const { service, configuration, calls, saveEntered, saveResume } = await controlledOwners(t, { gatedLibrary: 'Collections', failLibrary: true });
  const failed = assert.rejects(service.create({ Name: 'Failed' }), /Controlled library save failure/u);
  await saveEntered.promise;
  const closing = Promise.all([service.close(), configuration.close()]);
  await assert.rejects(configuration.getVirtualFolders(), { status: 503 });
  saveResume.resolve(); await failed; await closing;
  assert.equal(calls.includes('validate'), true); assert.equal(calls.includes('create'), false);
});

test('released configuration admission rejects further writes and close waits for its queued write', { ...pg, timeout: 30000 }, async t => {
  const { configuration, views, saveEntered, saveResume } = await controlledOwners(t, { gatedLibrary: 'Admitted' });
  const admission = configuration.admitCollectionOperation();
  assert.equal(Object.isFrozen(admission), true);
  const pending = admission.addVirtualFolder('Admitted', 'boxsets', { PathInfos: [] });
  await saveEntered.promise;
  admission.release(); admission.release();
  let closed = false;
  const closing = configuration.close().then(() => { closed = true; });
  await assert.rejects(admission.addVirtualFolder('Released', 'boxsets', { PathInfos: [] }), { status: 503 });
  await assert.rejects(configuration.addVirtualFolder('Late', 'boxsets', { PathInfos: [] }, false, admission), { status: 503 });
  assert.equal(closed, false);
  saveResume.resolve(); await pending; await closing;
  assert.deepEqual(await fs.readdir(views), ['Admitted']);
});
