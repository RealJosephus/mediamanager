import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { createRuntime } from '../../src/runtime.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { copyNativeItemRepositoryFrame, observeNativeItemLinkOwnership } from '../../src/library/native-item-entity.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { mapRecord, repositoryValue, sameId } from '../../src/library/records.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

for (const separateData of [false, true]) test(`postgres: initialized playlists resolve through the aggregate root with ${separateData ? 'separate' : 'default'} DataPath on the current platform`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const phase = name => t.diagnostic('Root lifecycle phase: ' + name);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mm-root-platform-'));
  const root = await realpath(temporary), programDataPath = path.join(root, 'state');
  const dataPath = separateData ? path.join(root, 'separate-data') : path.join(programDataPath, 'data');
  let database, runtime, primary;
  try {
    database = await createPostgresTestDatabase(null, 'root_platform');
    runtime = await createTestRuntime({ database, programDataPath, dataPath,
      configuration: { UICulture: 'en-US' }, serverId: 'root-platform' });
    const aggregate = await runtime.libraryScanHost.getAggregateFolder();
    const storedAggregate = await database.rows('BaseItems', { where: { Id: aggregate.Id } });
    assert.equal(storedAggregate[0].Studios, '', 'The repository retains the native empty pipe column.');
    assert.deepEqual(aggregate.Studios, [],
      'A newly constructed AggregateFolder retains its live constructor value after the initial saves.');
    const aggregateUpdates = [];
    const captureAggregateUpdate = event => {
      if (event.Item === aggregate) aggregateUpdates.push({ item: event.Item, studios: [...event.Item.Studios] });
    };
    runtime.library.on('ItemUpdated', captureAggregateUpdate);
    const aggregateRefreshEvents = [];
    try {
      const refresh = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: true };
      for (let index = 0; index < 2; index++) {
        const start = aggregateUpdates.length;
        await runtime.libraryScanHost.refreshMetadata(aggregate, { ...refresh });
        aggregateRefreshEvents.push(aggregateUpdates.slice(start));
      }
    } finally { runtime.library.off('ItemUpdated', captureAggregateUpdate); }
    assert.equal(aggregateRefreshEvents.every(events => events.length > 0), true,
      'Both the first and repeated refresh publish their committed AggregateFolder events.');
    assert.equal(aggregateUpdates.every(event => sameId(event.item.Id, aggregate.Id)), true,
      'Repeated refreshes publish updates for the initialized AggregateFolder.');
    assert.deepEqual(aggregateUpdates.map(event => event.studios), aggregateUpdates.map(() => []));
    assert.equal((await database.rows('BaseItems', { where: { Id: aggregate.Id } }))[0].Studios, '',
      'Refreshing the live constructor value does not change its persisted representation.');
    const userRoot = await runtime.libraryScanHost.getUserRootFolder();
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), [],
      'Native GetUserRootFolder retains its first singleton without saving it.');
    assert.equal((await stat(userRoot.Path)).isDirectory(), true, 'The first root read creates its real directory.');
    await runtime.libraryConfiguration.getVirtualFolders();
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), [],
      'Reading virtual folders must retain the absent repository baseline.');
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runtime.libraryScanHost.refreshMetadata(userRoot, { signal: cancelled.signal }), { name: 'AbortError' });
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), [],
      'A cancelled refresh must not save the transient root.');
    await runtime.libraryScanHost.refreshMetadata(userRoot, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ForceSave: true });
    const userRootBefore = await database.rows('BaseItems', { where: { Id: userRoot.Id } });
    assert.equal(userRootBefore.length, 1, 'Move a persisted UserRootFolder, rather than only its transient form.');
    const playlists = aggregate.VirtualChildren.find(item => item.Type === 'PlaylistsFolder');
    assert.ok(playlists, 'The registered aggregate must expose its real playlists child.');
    assert.deepEqual(playlists.Studios, [], 'The newly constructed playlists child also retains its live constructor value.');
    assert.equal(playlists.Path, path.join(dataPath, 'playlists'));
    assert.equal((await stat(playlists.Path)).isDirectory(), true);
    const before = await database.rows('BaseItems', { where: { Id: playlists.Id } });
    assert.equal(before.length, 1);
    assert.equal(before[0].Path, '%AppDataPath%' + path.sep + 'playlists');
    const expandPath = createVirtualPathExpander({ programDataPath, dataPath });
    assert.equal(expandPath(before[0].Path), playlists.Path, 'Repository placeholders must hydrate to the same physical path.');
    await initializeLibraryRoot({ fileSystem: runtime.fileSystem, store: runtime.store, programDataPath, dataPath });
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: playlists.Id } }), before,
      'Repeated initialization reuses the registered folder without rewriting its timestamps.');
    const aggregateBefore = await database.rows('BaseItems', { where: { Id: aggregate.Id } });
    const schema = database.schemaName;
    phase('initial runtime close');
    await runtime.close();
    phase('initial runtime closed');
    const movedProgram = path.join(root, 'moved-state');
    assert.equal(await realpath(programDataPath), programDataPath);
    assert.equal(path.dirname(movedProgram), root);
    await rename(programDataPath, movedProgram);
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    const movedData = separateData ? dataPath : path.join(movedProgram, 'data');
    runtime = await createTestRuntime({ database, programDataPath: movedProgram, dataPath: movedData,
      configuration: { UICulture: 'en-US' }, serverId: 'root-platform' });
    const relocated = await runtime.libraryScanHost.getAggregateFolder();
    assert.equal(relocated.Id, aggregate.Id);
    assert.deepEqual(relocated.Studios, [''],
      'An existing AggregateFolder still uses the native cold BaseItemMapper representation after restart.');
    assert.equal(relocated.Path, path.join(movedProgram, 'root'),
      'Native CreateRootFolder resets its live Path even when the playlist parent already matches.');
    assert.equal((await stat(relocated.Path)).isDirectory(), true);
    const relocatedPlaylists = relocated.VirtualChildren.find(item => item.Type === 'PlaylistsFolder');
    assert.equal(relocatedPlaylists.Path, path.join(movedData, 'playlists'));
    assert.deepEqual(relocatedPlaylists.Studios, [''],
      'The fresh-item retention does not normalize existing folders during cold hydration.');
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: aggregate.Id } }), aggregateBefore,
      'Hydrating the relocated root does not introduce a repository write.');
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: playlists.Id } }), before);
    const relocatedUserRoot = await runtime.libraryScanHost.getUserRootFolder();
    assert.equal(relocatedUserRoot.Id, userRoot.Id);
    assert.equal(relocatedUserRoot.Path, path.join(movedProgram, 'root', 'default'));
    assert.equal((await stat(relocatedUserRoot.Path)).isDirectory(), true);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), userRootBefore,
      'Native GetUserRootFolder also resets only the live Path until its next repository save.');
    // Initialization publishes repository records, without borrowing the
    // registered Folder's raw links or recursively cloning its virtual items.
    const aggregateSeed = mapRecord(relocated.NativeRepositoryColumns);
    const playlistsSeed = mapRecord(relocatedPlaylists.NativeRepositoryColumns);
    aggregateSeed.Path = relocated.Path; playlistsSeed.Path = relocatedPlaylists.Path;
    aggregateSeed.Studios = []; playlistsSeed.Studios = [];
    runtime.libraryScanHost.adoptRootInitialization({ aggregateFolder: aggregateSeed, playlistsFolder: playlistsSeed,
      freshAggregateFolder: true, freshPlaylistsFolder: true });
    assert.equal(await runtime.libraryScanHost.getAggregateFolder(), relocated,
      'Late storage adoption preserves a root identity that raced the repository commits.');
    assert.deepEqual(relocated.Studios, []);
    assert.deepEqual(relocatedPlaylists.Studios, []);
    relocated.Studios = ['Live metadata'];
    const replacementPlaylistsSeed = mapRecord(relocatedPlaylists.NativeRepositoryColumns);
    replacementPlaylistsSeed.Path = relocatedPlaylists.Path;
    replacementPlaylistsSeed.Studios = [];
    runtime.libraryScanHost.adoptRootInitialization({ aggregateFolder: null, playlistsFolder: replacementPlaylistsSeed,
      freshAggregateFolder: false, freshPlaylistsFolder: true });
    assert.deepEqual(relocated.Studios, ['Live metadata'],
      'A later partial playlists creation never replays a consumed AggregateFolder seed.');
    const committedFrame = { ...relocatedPlaylists.NativeRepositoryColumns,
      DateLastSaved: '2026-10-23T01:02:03.0000000Z' };
    const committedPlaylists = mapRecord(committedFrame);
    committedPlaylists.Path = relocatedPlaylists.Path;
    runtime.libraryScanHost.adoptRootInitialization({ aggregateFolder: null, playlistsFolder: committedPlaylists });
    assert.equal(repositoryValue(relocatedPlaylists, 'DateLastSaved'), committedFrame.DateLastSaved,
      'A reused live identity receives the committed immutable repository frame.');
    assert.equal(relocatedPlaylists.DateLastSaved, committedPlaylists.DateLastSaved);
    assert.deepEqual(relocatedPlaylists.Studios, [], 'A committed repair delta preserves unrelated live metadata.');
    assert.equal(copyNativeItemRepositoryFrame(relocatedPlaylists, committedPlaylists), relocatedPlaylists);
  } catch (error) { primary = error; throw error; }
  finally {
    const errors = [];
    for (const cleanup of [async () => { phase('final runtime close'); await runtime?.close(); phase('final runtime closed'); },
      () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(temporary), os.tmpdir());
      assert.ok(path.basename(temporary).startsWith('mm-root-platform-'));
      await rm(temporary, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { if (error !== primary) errors.push(error); }
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors,
      primary?.message ?? 'Platform root fixture cleanup failed.', primary ? { cause: primary } : undefined);
  }
});

test('postgres: runtime shutdown drains an admitted first root lookup before releasing its real singleton and PostgreSQL owners', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-root-platform-')));
  const programDataPath = path.join(temporary, 'state');
  let database, runtime, rootLookup, closing, primary, stopObserver, count;
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), hostClosing = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  const abort = () => interrupted.reject(t.signal.reason);
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    database = await createPostgresTestDatabase(null, 'root_close');
    runtime = await createRuntime({ database, programDataPath, configuration: { UICulture: 'en-US' }, serverId: 'root-close' });
    const getItem = runtime.itemCreation.getItemById.bind(runtime.itemCreation);
    let held = true;
    runtime.itemCreation.getItemById = async (...args) => {
      if (held) { held = false; entered.resolve(); await release.promise; }
      return getItem(...args);
    };
    const retainItem = runtime.itemCreation.retainItem.bind(runtime.itemCreation);
    runtime.itemCreation.retainItem = item => {
      if (item.Type === 'UserRootFolder' && !stopObserver) stopObserver = observeNativeItemLinkOwnership(item, event => { count = event.count; });
      return retainItem(item);
    };
    rootLookup = runtime.libraryScanHost.getUserRootFolder();
    await Promise.race([entered.promise, interrupted.promise,
      rootLookup.then(() => { throw new Error('The real first root read did not reach its held lookup.'); })]);
    const closeHost = runtime.libraryScanHost.close.bind(runtime.libraryScanHost);
    runtime.libraryScanHost.close = () => { hostClosing.resolve(); return closeHost(); };
    let finished = false;
    closing = runtime.close().then(() => { finished = true; });
    await Promise.race([hostClosing.promise, interrupted.promise,
      closing.then(() => { throw new Error('Runtime shutdown did not reach the root owner.'); })]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'The actual runtime remains open while an admitted root read owns its pending lookup.');
    assert.equal(database.closed, false);
    await assert.rejects(runtime.libraryScanHost.getUserRootFolder(), 'Shutdown must reject a new root consumer.');
    release.resolve();
    const root = await rootLookup;
    assert.equal(root.Type, 'UserRootFolder');
    await closing;
    assert.equal(finished, true); assert.equal(database.closed, true);
    assert.equal(count, 0, 'Closing the runtime drains the singleton branch after its pending publication.');
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: root.Id } }), [], 'Closing a first lookup must not persist its transient root.');
  } catch (error) { primary = error; throw error; }
  finally {
    release.resolve();
    t.signal.removeEventListener('abort', abort);
    const errors = [];
    for (const cleanup of [() => rootLookup?.catch(() => {}), () => closing,
      () => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
        assert.equal(path.dirname(temporary), await realpath(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('mm-root-platform-'));
        await rm(temporary, { recursive: true, force: true });
      }]) try { await cleanup(); } catch (error) { if (error !== primary) errors.push(error); }
    stopObserver?.release();
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors,
      primary?.message ?? 'Pending root owner cleanup failed.', primary ? { cause: primary } : undefined);
  }
});
