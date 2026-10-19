import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeInstanceInputs } from '../../tools/validation/native-instance-inputs.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';

const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_DOTNET && process.env.MEDIAMANAGER_NATIVE_INSTANCE_ROOT;

test('same-run native supply preserves a stopped empty instance and a separate controlled media seed', { skip: !enabled }, async t => {
  const supplied = await nativeInstanceInputs();
  const { initialization, seed } = supplied;
  assert.equal(initialization.credentialsRecorded, false);
  assert.equal(initialization.build.runtimeUnchanged, true);
  assert.equal(initialization.process.exitCode, 0);
  assert.equal(initialization.process.stopped, true);
  for (const route of ['/Startup/User', '/Users/AuthenticateByName', '/Startup/Configuration', '/Startup/Complete', '/System/Info', '/System/Shutdown']) {
    assert.ok(initialization.observations.some(response => response.route === route && response.status >= 200 && response.status < 300), route);
  }
  assert.equal(seed.credentialsRecorded, false);
  assert.equal(seed.mediaBytesCreated, false);
  assert.equal(seed.completeLibraryVerified, false);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-instance-consumer-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copies = [];
  for (const [name, source] of [['empty', initialization.root], ['seeded', process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE]]) {
    const state = await discoverInstanceState({ instanceRoot: source });
    assert.equal(state.identity.serverId, initialization.serverId);
    const destination = path.join(directory, name);
    await cloneStoppedInstance({ instanceState: state, destination });
    const copied = await discoverInstanceState({ instanceRoot: destination });
    const database = new SqliteDatabase(copied.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
    try {
      assert.equal(database.schema.history.length, initialization.database.migrationHistory);
      assert.ok(database.schema.history.length > 0);
      const administratorIds = new Set(database.rows('Permissions', { where: { Kind: 0, Value: true } })
        .map(permission => permission.UserId.toLowerCase()));
      assert.ok(database.rows('Devices').some(device => device.AccessToken && typeof device.UserId === 'string' && administratorIds.has(device.UserId.toLowerCase())),
        'the controlled instance retains its actual authenticated administrator for subsequent migration consumers');
      copies.push(database.rows('BaseItems'));
    } finally { database.close(); }
  }
  const [empty, seeded] = copies;
  assert.ok(empty.every(item => ['PLACEHOLDER', 'MediaBrowser.Controller.Entities.AggregateFolder',
    'Emby.Server.Implementations.Playlists.PlaylistsFolder'].includes(item.Type)));
  assert.equal(empty.some(item => item.Id === seed.ids.movie || item.Id === seed.ids.folder), false);
  assert.equal(seeded.length, empty.length + 2);
  const movie = seeded.find(item => item.Id === seed.ids.movie), folder = seeded.find(item => item.Id === seed.ids.folder);
  assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
  assert.equal(movie.ParentId, folder.Id);
  assert.equal(movie.Path, 'Z:\\SyntheticMedia\\feature.mkv');
  assert.equal(folder.Path, 'Z:\\SyntheticMedia');
  assert.ok((await readFile(path.join(supplied.root, 'empty/initialization.log'), 'utf8')).length > 0);
  // Read only private copies: subsequent consumers must see the same stopped inputs.
  assert.deepEqual((await nativeInstanceInputs()).inputs, supplied.inputs);
});
