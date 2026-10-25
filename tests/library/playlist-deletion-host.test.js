import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, symlink, mkdtemp, rm } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { createTestApplication } from '../helpers/application.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { createVirtualPathReverser } from '../../src/library/options.js';
import { setupPlaylistDeletion, playlistDeletionId as id } from './playlist-deletion-fixture.js';
import { fixturePathStyle } from './fixture-state-path.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const root = new URL('./fixtures/playlist-deletion/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root))), native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const owner = { Id: id(9), Policy: { IsAdministrator: false, EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] }, MaxParentalRatingScore: null };
const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
async function setup(t, name = 'managed-directory', extra = {}) {
  const sample = input.find(sample => sample.name === name);
  const value = await setupPlaylistDeletion(t, sample, native.results.find(row => row.name === name));
  const { fixture, loaded } = value;
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store: fixture.store, library: fixture.library, linkedChildren: fixture.linkedChildren,
    spoolRoot: fixture.spoolRoot, programDataPath: fixture.stateRoot,
    dataPath: loaded.dataPath, vfs: fixture.vfs, identityMap: fixture.identityMap, ...extra });
  // The shared fixture closes its host before the relation repository.
  // Give that owner the dependent Playlist queue so no later after hook can
  // wait behind a repository which is already draining its retained links.
  const closeHost = fixture.host.close.bind(fixture.host);
  fixture.host.close = async () => {
    const errors = [];
    for (const close of [() => playlists.close(), closeHost]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Playlist deletion fixture cleanup failed.');
  };
  return { ...value, playlists, sample };
}
async function app(t, value, user = owner, isApiKey = false) {
  const application = await createTestApplication({ playlists: value.playlists, library: value.fixture.library,
    users: { getUser: async reference => reference?.replaceAll('-', '').toLowerCase() === user?.Id.replaceAll('-', '').toLowerCase() ? user : null },
    configuration: { IsStartupWizardCompleted: true },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, IsApiKey: isApiKey, User: user, UserId: user?.Id,
      IsAdministrator: user?.Policy.IsAdministrator ?? isApiKey }), authorize: () => {} } });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  return async reference => { const suffix = Array.isArray(reference) ? '?ids=' + reference.join(',') : '/' + reference;
    const response = await fetch(`http://127.0.0.1:${application.server.address().port}/Items${suffix}`, { method: 'DELETE' });
    await response.body?.cancel(); return response.status; };
}
for (const [name, code] of [['managed-directory', 204], ['external-m3u', 204], ['managed-sql-failure', 500]]) {
  test(`postgres: Playlist HTTP deletion uses the entity lifecycle for ${name}`, options, async t => {
    const value = await setup(t, name), request = await app(t, value);
    assert.equal(await request(id(1)), code);
    assert.equal((await value.state()).sourceExists, false);
    assert.equal((await value.state()).databaseExists, code !== 204);
    assert.equal(value.events.length, code === 204 ? 1 : 0);
  });
}
test('postgres: Playlist visibility precedes owner/admin delete permission and API keys bypass user visibility', options, async t => {
  const value = await setup(t), other = { ...owner, Id: id(10) };
  const data = parseLosslessJson((await value.fixture.database.rows('BaseItems', { where: { Id: id(1) } }))[0].Data);
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Data: JSON.stringify({ ...data, OpenAccess: false, Shares: [] }) });
  const invisible = await app(t, value, other);
  assert.equal(await invisible(id(1)), 404);
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Data: JSON.stringify({ ...data, Shares: [{ UserId: other.Id, CanEdit: true }] }) });
  assert.equal(await invisible(id(1)), 401, 'CanEdit does not grant CanDelete.');
  assert.deepEqual(value.calls, []); assert.equal((await value.state()).sourceExists, true);
  const apiKey = await app(t, value, null, true);
  assert.equal(await apiKey(id(1)), 204);
});
test('postgres: readonly external Playlist rejects before metadata, files or SQL mutation', options, async t => {
  const value = await setup(t, 'external-m3u');
  value.fixture.vfs.mount({ path: '/playlist-readonly', instanceId: 'fixture', capabilities: {} });
  value.fixture.identityMap.bind(id(1), '/playlist-readonly/media/Target.m3u');
  const rows = await value.fixture.database.rows('BaseItems'), files = await value.files();
  await assert.rejects(value.playlists.delete(id(1), { user: owner }), { code: 'not-supported' });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows); assert.deepEqual(await value.files(), files); assert.deepEqual(value.calls, []);
});
test('postgres: external Playlist cannot delete a media mount root', options, async t => {
  const value = await setup(t, 'external-directory');
  value.fixture.identityMap.bind(id(1), '/playlist-source');
  const rows = await value.fixture.database.rows('BaseItems'), files = await value.files();
  await assert.rejects(value.playlists.delete(id(1), { user: owner }), { code: 'permission-denied' });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows); assert.deepEqual(await value.files(), files); assert.deepEqual(value.calls, []);
});
test('postgres: imported native AppData Playlist paths retain raw SQL while deleting configured state identity', options, async t => {
  const value = await setup(t);
  const virtualPath = createVirtualPathReverser({ programDataPath: value.fixture.stateRoot,
    dataPath: value.loaded.dataPath, metadataPath: value.loaded.metadataPath })(value.item.Path);
  assert.match(virtualPath, /^%AppDataPath%/);
  assert.equal(value.fixture.library.options.expandPath(virtualPath), value.item.Path, 'Native replacement preserves all separator bytes.');
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Path: virtualPath });
  await value.playlists.delete(id(1), { user: owner });
  assert.equal((await value.state()).databaseExists, false); assert.equal((await value.state()).sourceExists, false);
  assert.equal(value.events.length, 1);
});
test('postgres: changed Playlist source identity rejects before any deletion phase', options, async t => {
  const value = await setup(t);
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Path: path.join(value.loaded.dataPath, 'playlists', 'Changed') });
  const rows = await value.fixture.database.rows('BaseItems'), files = await value.files();
  await assert.rejects(value.playlists.delete(id(1), { user: owner }), { status: 409 });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows); assert.deepEqual(await value.files(), files); assert.deepEqual(value.calls, []);
});
for (const name of ['playlists', 'collections']) test(`postgres: managed Playlist cannot delete the shared ${name} state root`, options, async t => {
  const value = await setup(t), target = path.join(value.loaded.dataPath, name);
  await mkdir(target, { recursive: true });
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Path: target }); value.item.Path = target;
  const rows = await value.fixture.database.rows('BaseItems'), files = await value.files();
  await assert.rejects(value.playlists.delete(id(1), { user: owner }), { status: 501 });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows); assert.deepEqual(await value.files(), files); assert.deepEqual(value.calls, []);
});
test('postgres: managed Playlist directory link escape has no file or database side effect', options, async t => {
  const value = await setup(t), outside = await mkdtemp(path.join(os.tmpdir(), 'playlist-delete-outside-'));
  t.after(async () => { assert.equal(path.dirname(outside), os.tmpdir()); await rm(outside, { recursive: true }); });
  const link = path.join(value.loaded.dataPath, 'playlists', 'Escape');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { Path: link }); value.item.Path = link;
  const rows = await value.fixture.database.rows('BaseItems');
  await assert.rejects(value.playlists.delete(id(1), { user: owner }), { code: 'permission-denied' });
  assert.deepEqual(await value.fixture.database.rows('BaseItems'), rows); assert.deepEqual(value.calls, []);
});
test('postgres: user cleanup keeps Playlist source and uses the explicit physical parent', options, async t => {
  const value = await setup(t);
  await initializeLibraryRoot({fileSystem: testFileSystem,  store: value.fixture.store, programDataPath: value.fixture.stateRoot,
    dataPath: value.loaded.dataPath, now: () => value.fixture.now });
  const parentRow = (await value.fixture.database.rows('BaseItems', {
    where: { Type: 'Emby.Server.Implementations.Playlists.PlaylistsFolder' }
  }))[0];
  const physicalParent = await value.creator.getItemById(parentRow.Id);
  setFolderChildren(physicalParent, [value.item]); physicalParent.UserData = [];
  const row = (await value.fixture.database.rows('BaseItems', { where: { Id: id(1) } }))[0];
  await value.fixture.database.update('BaseItems', { Id: id(1) }, { ParentId: physicalParent.Id,
    OwnerId: id(3), Data: JSON.stringify({ ...parseLosslessJson(row.Data), OpenAccess: false }) });
  value.item.ParentId = physicalParent.Id; value.item.OwnerId = id(3);
  await value.playlists.removeForDeletedUser(owner);
  assert.equal((await value.state()).sourceExists, true);
  assert.equal((await value.state()).databaseExists, false);
  assert.equal(value.events.length, 1); assert.equal(value.events[0].parentId, physicalParent.Id.toLowerCase());
  assert.equal(readCachedFolderChildren(physicalParent, null, () => null), null);
  assert.equal(physicalParent.UserData, null);
  assert.deepEqual(readCachedFolderChildren(value.parent, null, () => null), [value.item]);
});
test('postgres: queued managed XML completes before batch HTTP Playlist deletion without a late recreation', options, async t => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; }), starting = new Promise(resolve => { entered = resolve; });
  const fileSystem = { ...fs, rename: async (...args) => {
    if (String(args[1]).endsWith('playlist.xml')) { entered(); await pending; }
    return fs.rename(...args);
  } };
  const value = await setup(t, 'managed-directory', { fileSystem }), request = await app(t, value);
  let timeout, deleting;
  try {
    await value.playlists.add(id(1), [id(3)], { user: owner });
    await Promise.race([starting, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The queued XML did not reach the atomic replacement boundary.')), 5000);
    })]);
    let done = false;
    deleting = request([id(1)]).then(status => { assert.equal(status, 204); done = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  } finally { clearTimeout(timeout); release(); }
  await deleting;
  assert.equal((await value.state()).sourceExists, false); assert.equal(value.events.length, 1);
});
test('postgres: mixed Playlist and Audio batch HTTP deletion commits both real item lifecycles in order', options, async t => {
  const value = await setup(t), request = await app(t, value, { ...owner, Policy: { ...owner.Policy, EnableContentDeletion: true } });
  const member = await value.creator.getItemById(id(3));
  assert.ok(member);
  assert.equal(await request([id(1), id(3)]), 204);
  assert.equal((await value.state()).sourceExists, false);
  assert.equal((await value.fixture.database.rows('BaseItems', { where: { Id: id(3) } })).length, 0);
  await assert.rejects(value.fixture.vfs.stat('/playlist-source/media/member.flac'), { code: 'not-found' });
  assert.deepEqual(value.events.map(event => event.id), [id(1), id(3)]);
});

test('postgres: Playlist deletion uses actual WebDAV for files, directories and source failure prefixes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE
}, async t => {
  const service = await startActualWebDav({ evidenceDirectory: process.env.MEDIAMANAGER_PLAYLIST_DELETE_WEBDAV_EVIDENCE });
  t.after(() => service.stop());
  for (const name of ['external-m3u', 'external-m3u8', 'external-pls', 'external-wpl', 'external-zpl', 'external-dot-directory', 'external-missing', 'external-source-failure']) {
    await t.test(name, async t => {
      const value = await setup(t, name), requests = [];
      value.fixture.storage.registerType('webdav', config => new WebDavAdapter(config, { resolveCredential: async () => service.authorization,
        fetch: async (url, options) => { requests.push({ method: options.method, path: new URL(url).pathname });
          if (name === 'external-source-failure' && options.method === 'DELETE') return new Response('Controlled deletion failure', { status: 503 });
          return fetch(url, options); } }));
      await value.fixture.storage.createInstance('actual-delete', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'isolated-playlist-delete',
        capabilities: { create: true, replace: true, mkdir: true, delete: true } });
      value.fixture.vfs.mount({ path: '/actual-delete', instanceId: 'actual-delete', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
      const directory = '/actual-delete/' + name, remote = directory + '/' + value.sample.filename;
      await value.fixture.vfs.mkdir(directory);
      value.fixture.identityMap.addPrefix({ identityRoot: value.item.Path, accessRoot: remote, style: fixturePathStyle, returnAccess: 'Isolated actual Playlist deletion source.' });
      if (!value.sample.missing) {
        if (value.sample.directory) { await value.fixture.vfs.mkdir(remote); await value.fixture.vfs.write(remote + '/source.txt', Buffer.from('source')); }
        else await value.fixture.vfs.write(remote, Buffer.from('source'));
      }
      if (name === 'external-source-failure') {
        await assert.rejects(value.playlists.delete(id(1), { user: owner }), { code: 'unavailable' });
        assert.equal((await value.state()).sourceExists, true); assert.equal((await value.state()).internalExists, false);
        assert.equal((await value.state()).databaseExists, true); assert.equal(value.events.length, 0);
      } else {
        await value.playlists.delete(id(1), { user: owner });
        await assert.rejects(value.fixture.vfs.stat(remote), { code: 'not-found' });
        assert.equal((await value.state()).databaseExists, false); assert.equal(value.events.length, 1);
      }
      assert.equal(requests.some(request => request.method === 'DELETE'), !value.sample.missing);
    });
  }
});
