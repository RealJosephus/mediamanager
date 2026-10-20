import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

for (const separateData of [false, true]) test(`postgres: initialized playlists resolve through the aggregate root with ${separateData ? 'separate' : 'default'} DataPath on the current platform`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mm-root-platform-'));
  const root = await realpath(temporary), programDataPath = path.join(root, 'state');
  const dataPath = separateData ? path.join(root, 'separate-data') : path.join(programDataPath, 'data');
  let database, runtime;
  try {
    database = await createPostgresTestDatabase(null, 'root_platform');
    runtime = await createRuntime({ database, programDataPath, dataPath,
      configuration: { UICulture: 'en-US' }, serverId: 'root-platform' });
    const aggregate = await runtime.libraryScanHost.getAggregateFolder();
    const userRoot = await runtime.libraryScanHost.getUserRootFolder();
    const userRootBefore = await database.rows('BaseItems', { where: { Id: userRoot.Id } });
    assert.equal(userRootBefore.length, 1, 'Move a persisted UserRootFolder, rather than only its transient form.');
    const playlists = aggregate.VirtualChildren.find(item => item.Type === 'PlaylistsFolder');
    assert.ok(playlists, 'The registered aggregate must expose its real playlists child.');
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
    await runtime.close();
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
    assert.equal(relocated.Path, path.join(movedProgram, 'root'),
      'Native CreateRootFolder resets its live Path even when the playlist parent already matches.');
    assert.equal((await stat(relocated.Path)).isDirectory(), true);
    assert.equal(relocated.VirtualChildren.find(item => item.Type === 'PlaylistsFolder').Path, path.join(movedData, 'playlists'));
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: aggregate.Id } }), aggregateBefore,
      'Hydrating the relocated root does not introduce a repository write.');
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: playlists.Id } }), before);
    const relocatedUserRoot = await runtime.libraryScanHost.getUserRootFolder();
    assert.equal(relocatedUserRoot.Id, userRoot.Id);
    assert.equal(relocatedUserRoot.Path, path.join(movedProgram, 'root', 'default'));
    assert.equal((await stat(relocatedUserRoot.Path)).isDirectory(), true);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: userRoot.Id } }), userRootBefore,
      'Native GetUserRootFolder also resets only the live Path until its next repository save.');
  } finally {
    const errors = [];
    for (const cleanup of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(temporary), os.tmpdir());
      assert.ok(path.basename(temporary).startsWith('mm-root-platform-'));
      await rm(temporary, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Platform root fixture cleanup failed.');
  }
});
