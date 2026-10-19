import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { createRuntime } from '../../src/runtime.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { StorageError } from '../../src/storage/errors.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { knownAncestorIgnoreIdentityMap } from './ignore-namespace-fixture.js';

const nativeGlobal = JSON.parse(await readFile(new URL('./fixtures/global-scan/native.json', import.meta.url), 'utf8'));
const nativeProof = JSON.parse(await readFile(new URL('./fixtures/global-scan/provenance.json', import.meta.url), 'utf8'));
const nativeRetrievalFailure = nativeGlobal.cases.find(sample => sample.name === 'deep-enumeration-after-baseline');
const nativeCancellation = nativeGlobal.cases.find(sample => sample.name === 'cancel-aggregate-at-7');
const identityRoot = 'Z:\\Movies\\Film';
const moviePath = identityRoot + '\\Film.mkv';
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const controlledGenre = 'Controlled scan genre';
const pg = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
const stable = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);

async function sourceSnapshot(database) {
  const tables = {};
  for (const { name } of nativeModel.tables) {
    tables[name] = (await database.rows(name)).sort((left, right) => {
      const a = stable(left), b = stable(right); return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return tables;
}

async function fixture(t, { knownAncestors = true, seedMovie = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-ignore-runtime-'));
  const programDataPath = path.join(directory, 'data');
  const movieId = nativeGuid(getNewItemId(moviePath, movieType, { programDataPath }));
  const database = await createPostgresTestDatabase(null, 'scan_ignore', { max: 1 });
  const registry = new StorageRegistry(); let runtime;
  t.after(async () => {
    const errors = [];
    for (const close of [() => runtime?.close(), () => registry.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('scan-ignore-runtime-'));
      await rm(directory, { recursive: true, force: true });
    }]) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Runtime ignore fixture cleanup failed.');
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('media', 'memory', {}), vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows', returnAccess: 'Controlled runtime media namespace' });
  const ignoreIdentityMap = knownAncestors
    ? await knownAncestorIgnoreIdentityMap({ registry, vfs, identityMap, identityRoots: [identityRoot] }) : identityMap;
  // Establish actual configuration and native top-level admission before adding
  // the existing Movie. The hidden sentinel satisfies the empty-root guard.
  await adapter.write('/.keep', Buffer.from('controlled nonempty library'));
  const collectionPath = path.join(programDataPath, 'root', 'default', 'Movies');
  await mkdir(collectionPath, { recursive: true });
  await writeFile(path.join(collectionPath, 'movies.collection'), '');
  await writeFile(path.join(collectionPath, 'root.mblink'), identityRoot);
  await writeFile(path.join(collectionPath, 'options.xml'), '<LibraryOptions><SaveLocalMetadata>false</SaveLocalMetadata><EnablePhotos>true</EnablePhotos><TypeOptions>'
    + ['Movie', 'Person'].map(type => `<TypeOptions><Type>${type}</Type><MetadataFetchers/><ImageFetchers/></TypeOptions>`).join('')
    + '</TypeOptions></LibraryOptions>');
  const errors = [], remoteRequests = [];
  t.after(() => assert.deepEqual(remoteRequests, [], 'This isolated ignore fixture never uses public TMDb transport.'));
  runtime = await createRuntime({ database, vfs, identityMap, ignoreIdentityMap, programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryScanFanoutConcurrency: 1 },
    pluginOptions: { options: { tmdb: { async fetch(url) {
      const request = new URL(url);
      remoteRequests.push(request.origin + request.pathname);
      throw new Error('Unexpected remote metadata request in the isolated ignore fixture.');
    } } } },
    serverId: 'scan-ignore-runtime', onError: error => errors.push(error) });
  await runtime.libraryScanLifecycle.validateTopLibraryFolders();
  const rows = await database.rows('BaseItems');
  const physical = rows.find(item => item.Type === 'MediaBrowser.Controller.Entities.Folder' && item.Path === identityRoot);
  assert.ok(physical, 'The real AggregateFolder resolves the configured .mblink into a physical root.');
  const aggregate = await runtime.libraryScanHost.getAggregateFolder();
  assert.equal(idKey(physical.ParentId), idKey(aggregate.Id));
  const collections = rows.filter(item => item.Type === 'MediaBrowser.Controller.Entities.CollectionFolder');
  assert.equal(collections.length, 1);
  await runtime.itemCreation.withItem(collections[0].Id, async collection => {
    assert.equal(collection.CollectionType, 'movies');
    assert.deepEqual(collection.PhysicalFolderIds.map(idKey), [idKey(physical.Id)]);
    assert.deepEqual(collection.PhysicalLocationsList, [collectionPath, identityRoot]);
  });
  await adapter.write('/Film.mkv', Buffer.from('controlled ordinary media'));
  await adapter.write('/Film-trailer.mkv', Buffer.from('controlled trailer'));
  await adapter.write('/Film.nfo', Buffer.from(`<movie><title>Film</title><genre>${controlledGenre}</genre></movie>`));
  if (seedMovie) await runtime.itemCreation.withItem(physical.Id, async parent => {
    const movie = newNativeItemEntity(movieType);
    Object.assign(movie, { Id: movieId, Name: 'Film', Path: moviePath, ParentId: parent.Id, VideoType: 'VideoFile' });
    await runtime.library.createItems([movie], parent);
  });
  errors.length = 0;
  return { database, adapter, vfs, runtime, identityMap, ignoreIdentityMap, movieId, rootId: physical.Id, errors };
}

function observePhysicalValidation({ database, runtime }) {
  const observations = [];
  const validateChildren = runtime.folderValidation.validateChildren.bind(runtime.folderValidation);
  runtime.folderValidation.validateChildren = async (parent, options) => {
    if (parent.Path !== identityRoot || options.recursive !== true) return validateChildren(parent, options);
    const observation = { before: await sourceSnapshot(database), phases: [], result: null, error: null, active: true };
    observations.push(observation);
    try {
      observation.result = await validateChildren(parent, { ...options, reportProgress(value) {
        observation.phases.push(value); options.reportProgress?.(value);
      } });
      return observation.result;
    } catch (error) { observation.error = error; throw error; }
    finally { observation.active = false; observation.after = await sourceSnapshot(database); }
  };
  return observations;
}

function assertUnchangedFolder(observation) {
  assert.deepEqual(observation.after, observation.before,
    'All source database tables retain the exact committed prefix while failed or cancelled enumeration cannot write children.');
}

for (const mode of ['success', 'failure', 'cancel']) {
  test(`postgres: runtime shares ignore discovery and clears scan directory caches after ${mode}`, pg, async t => {
    const f = await fixture(t), { database, adapter, runtime, movieId, errors } = f, rule = runtime.ignoreRule;
    assert.equal(runtime.folderScanner.ignoreRule, rule);
    assert.equal(runtime.folderValidation.ignoreRule, rule);
    assert.equal(runtime.folderValidation.metadataScanner, runtime.metadataScanner);
    assert.equal(runtime.folderScanner.metadataScanner, runtime.metadataScanner);
    assert.equal(runtime.folderValidation.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.folderScanner.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.itemDeletion.linkedChildReferences, runtime.linkedChildReferences);
    assert.equal(runtime.library.folderValidation, runtime.folderValidation);
    await runtime.metadata.loadContext.withContext(movieId, {}, async loaded => {
      assert.equal(loaded.videoVersionDiscovery.ignoreRule, rule);
      await runtime.store.run(async db => {
        const state = await runtime.library.load(db, null, { includeUserData: false, baseRows: await db.rows('BaseItems') });
        try { assert.equal((await loaded.findOwnedExtras(state)).extras.length, 1, 'Extra discovery primes this same runtime cache.'); }
        finally { await state.dispose({ session: db }); }
      });
    });
    assert.ok(rule.directoryCache.size > 0);
    await adapter.write('/.ignore', Buffer.from('*.mkv'));
    assert.equal(await rule.shouldIgnore(moviePath), false, 'Native cached absence lasts until directory cache clear.');
    const controller = new AbortController(), trace = [], progress = [], added = [], removed = [], eventDetails = [];
    let postTask = null;
    for (const task of runtime.libraryScanLifecycle.postScanTasks) {
      const run = task.run.bind(task);
      task.run = async (...args) => {
        postTask = task.name;
        try { return await run(...args); } finally { postTask = null; }
      };
    }
    const captureEvent = (action, event) => eventDetails.push({ action, Id: event.Item.Id,
      Type: event.Item.Type, NativeType: event.Item.NativeType, Name: event.Item.Name, Path: event.Item.Path, ParentId: event.Item.ParentId, postTask,
      phase: observations.at(-1)?.active ? 'physical-validation' : observations.length ? 'after-physical-validation' : 'before-physical-validation',
    });
    runtime.library.on('ItemAdded', event => { added.push(event.Item.Id); captureEvent('ItemAdded', event); });
    runtime.library.on('ItemRemoved', event => { removed.push(event.Item.Id); captureEvent('ItemRemoved', event); });
    const clear = rule.clearDirectoryCache.bind(rule), listPage = adapter.listPage.bind(adapter);
    rule.clearDirectoryCache = () => { trace.push('clear'); clear(); };
    adapter.listPage = async (...args) => { trace.push('media-list'); return listPage(...args); };
    const stop = runtime.libraryMonitor.stop.bind(runtime.libraryMonitor), start = runtime.libraryMonitor.start.bind(runtime.libraryMonitor);
    runtime.libraryMonitor.stop = async () => { trace.push('monitor-stop'); await stop(); };
    runtime.libraryMonitor.start = async () => { await start(); trace.push('monitor-start'); };
    const observations = observePhysicalValidation(f), shouldIgnore = rule.shouldIgnore.bind(rule);
    const failure = new StorageError('permission-denied', 'Controlled ignore resolution failure');
    const cancelled = new StorageError('cancelled', 'Controlled cancellation during complete directory resolution');
    let intercepted = 0;
    rule.shouldIgnore = async (identityPath, options) => {
      const ignored = await shouldIgnore(identityPath, options);
      if (mode !== 'success' && identityPath === moviePath && observations.at(-1)?.active && !intercepted) {
        intercepted++;
        assert.equal(options.signal, undefined, 'Native complete resolution runs before the request-token checkpoint.');
        if (mode === 'failure') throw failure;
        controller.abort(cancelled);
      }
      return ignored;
    };
    const scan = () => runtime.libraryScanner.runCompleteScan({ signal: controller.signal, reportProgress: value => progress.push(value) });
    if (mode === 'cancel') {
      assert.match(nativeCancellation.exception, /OperationCanceledException$/u);
      await assert.rejects(scan(), { code: 'cancelled' });
    } else {
      assert.equal(nativeGlobal.rawSha256, nativeProof.rawSha256);
      assert.equal(nativeRetrievalFailure.exception, null, 'The actual native global scan logs retrieval failure and continues.');
      assert.equal(await scan(), null);
      assert.equal(progress.at(-1), 99, 'The real global lifecycle reaches its public completion progress.');
    }
    assert.equal(observations.length, 1, 'The actual global scan reaches the configured physical directory once.');
    const [observation] = observations;
    if (mode === 'success') {
      assert.equal(observation.error, null);
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
      assert.ok(removed.some(id => idKey(id) === idKey(movieId)), 'Ignoring a real existing child publishes its removal.');
    } else {
      assert.equal(intercepted, 1, 'The named failure/cancellation really executes in physical directory resolution.');
      assertUnchangedFolder(observation);
      const [persistedMovie] = await database.rows('BaseItems', { where: { Id: movieId } });
      assert.ok(persistedMovie);
      const previousMovie = observation.before.BaseItems.find(item => idKey(item.Id) === idKey(movieId));
      for (const field of ['Id', 'Type', 'Path', 'ParentId', 'TopParentId', 'IsFolder', 'OwnerId', 'PrimaryVersionId']) {
        assert.deepEqual(persistedMovie[field], previousMovie[field], 'Failed/cancelled discovery retains Movie ' + field);
      }
      assert.deepEqual(eventDetails.filter(event => event.phase === 'physical-validation'), [], 'Failed/cancelled physical validation publishes no events.');
      assert.deepEqual(removed, []);
      if (mode === 'failure') {
        // Native global traversal still runs metadata and post-scan tasks after
        // a folder retrieval failure; this local NFO supplies their real input.
        const afterFault = nativeRetrievalFailure.trace.slice(nativeRetrievalFailure.trace.findIndex(event => event.action === 'injected-fault') + 1);
        assert.ok(afterFault.some(event => event.action === 'metadata-completed'));
        assert.ok(afterFault.some(event => event.action === 'post-task-end'));
        await runtime.itemCreation.withItem(movieId, movie => assert.deepEqual(movie.Genres, [controlledGenre]));
        const genres = await database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Genre' } });
        assert.deepEqual(genres.map(item => item.Name), [controlledGenre]);
        assert.ok(added.length > 0, 'Real Genres maintenance consumes the metadata saved after the failed directory validation.');
        for (const event of eventDetails) {
          assert.equal(event.action, 'ItemAdded'); assert.equal(event.phase, 'after-physical-validation');
          assert.equal(event.postTask, 'Genres'); assert.equal(event.Type, 'Genre');
          assert.equal(event.NativeType, 'MediaBrowser.Controller.Entities.Genre');
          assert.equal(event.Name, controlledGenre);
          const persisted = genres.find(item => idKey(item.Id) === idKey(event.Id));
          assert.ok(persisted, 'Every later event names an actual committed Genre row.');
          assert.equal(runtime.library.options.expandPath(persisted.Path), event.Path);
          assert.equal(persisted.ParentId, null);
        }
        assert.deepEqual(new Set(added.map(idKey)), new Set(genres.map(item => idKey(item.Id))));
        t.diagnostic(stable({ eventDetails, persisted: genres.map(item => ({ Id: item.Id, Type: item.Type, Name: item.Name, Path: item.Path, ParentId: item.ParentId })) }));
        assert.equal(observation.error, null);
        assert.equal(observation.result.skipped, true);
        assert.deepEqual(observation.result.created, []); assert.deepEqual(observation.result.resolved, []);
        assert.equal(errors.filter(error => error === failure).length, 1, 'The exact permission failure is reported, never converted into absence.');
        assert.equal(observation.phases.includes(7), false, 'Failure returns before current-child reconciliation.');
      } else {
        assert.deepEqual(added, []);
        assert.equal(observation.error, cancelled);
        assert.ok(observation.phases.includes(6)); assert.ok(observation.phases.includes(7));
        assert.equal(observation.phases.includes(8), false, 'Cancellation is observed after complete resolution and before sibling writes.');
      }
    }
    assert.equal((await adapter.stat('/Film.mkv')).kind, 'file');
    assert.equal((await adapter.stat('/Film-trailer.mkv')).kind, 'file');
    assert.equal(trace[0], 'clear');
    assert.ok(trace.indexOf('monitor-stop') < trace.indexOf('media-list'), 'Caches clear and the monitor stops before actual media traversal.');
    assert.ok(trace.lastIndexOf('clear') > trace.lastIndexOf('media-list'), 'The final clear follows the final real media operation.');
    assert.equal(trace.at(-1), 'monitor-start');
    assert.equal(runtime.libraryScanLifecycle.isScanRunning, false);
    assert.equal(rule.directoryCache.size, 0);
    assert.equal(rule.rulesCache.size, 1, 'Directory cache clears retain the actual parsed rules.');
  });
}

test('postgres: runtime reports an unknown ignore ancestor without deleting existing children', pg, async t => {
  const f = await fixture(t, { knownAncestors: false }), { database, runtime, identityMap, movieId, errors } = f;
  assert.equal(runtime.ignoreRule.identityMap, identityMap);
  await assert.rejects(runtime.ignoreRule.shouldIgnore(moviePath), { code: 'ignore-search-unmapped', status: 501 });
  const observations = observePhysicalValidation(f), removed = [];
  runtime.library.on('ItemRemoved', event => removed.push(event.Item.Id));
  assert.equal(nativeRetrievalFailure.exception, null);
  assert.equal(await runtime.libraryScanner.runCompleteScan(), null);
  assert.equal(observations.length, 1, 'Unknown ancestor failure occurs in the configured library, not an unvisited fake root.');
  assertUnchangedFolder(observations[0]);
  assert.equal(observations[0].result.skipped, true);
  assert.deepEqual(observations[0].result.created, []); assert.deepEqual(observations[0].result.resolved, []);
  assert.ok(errors.some(error => error.code === 'ignore-search-unmapped' && error.status === 501));
  assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 1);
  assert.deepEqual(removed, []);
  assert.equal(runtime.ignoreRule.directoryCache.size, 0);
  assert.equal(runtime.libraryScanLifecycle.isScanRunning, false);
});

test('postgres: runtime validates new children with inherited library content type', pg, async t => {
  const { database, adapter, runtime, movieId, rootId } = await fixture(t, { seedMovie: false });
  await adapter.delete('/Film-trailer.mkv');
  const added = [];
  runtime.library.on('ItemAdded', event => added.push(event.Item));
  await runtime.itemCreation.withItem(rootId, async parent => {
    const result = await runtime.library.validateChildren(parent, { refreshChildMetadata: false });
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].Type, 'Movie');
    assert.equal(result.created[0].Id, movieId);
    assert.equal(result.created[0].ParentId, parent.Id);
    assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 1);
    assert.deepEqual(added, result.created);
    assert.equal((await runtime.library.validateChildren(parent, { refreshChildMetadata: false })).created.length, 0);
    assert.equal(added.length, 1);
  });
});
