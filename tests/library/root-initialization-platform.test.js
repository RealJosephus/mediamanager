import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { copyNativeItemRepositoryFrame } from '../../src/library/native-item-entity.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { mapRecord, repositoryValue } from '../../src/library/records.js';
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
    runtime = await createRuntime({ database, programDataPath, dataPath,
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
    assert.equal(aggregateUpdates.every(event => event.item === aggregate), true,
      'Repeated refreshes publish the same initialized AggregateFolder instance.');
    assert.deepEqual(aggregateUpdates.map(event => event.studios), aggregateUpdates.map(() => []));
    assert.equal((await database.rows('BaseItems', { where: { Id: aggregate.Id } }))[0].Studios, '',
      'Refreshing the live constructor value does not change its persisted representation.');
    const userRoot = await runtime.libraryScanHost.getUserRootFolder();
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), [],
      'Native GetUserRootFolder registers the singleton without saving it.');
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
    runtime = await createRuntime({ database, programDataPath: movedProgram, dataPath: movedData,
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
