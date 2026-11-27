import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { createPlaylistItemsPlugin, parseM3uPlaylist } from '../../src/metadata/playlist-items.js';
import { preparePlaylistFile } from '../../src/library/playlist-file.js';
import { PlaylistService } from '../../src/library/playlist-service.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createTestApplication } from '../helpers/application.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';

const ids = {
  aggregate: '17000000-0000-0000-0000-000000000001',
  userRoot: '17000000-0000-0000-0000-000000000002',
  folder: '17000000-0000-0000-0000-000000000003',
  music: '17000000-0000-0000-0000-000000000004',
  live: '17000000-0000-0000-0000-000000000005',
  untyped: '17000000-0000-0000-0000-000000000006',
  nested: '17000000-0000-0000-0000-000000000007',
  playlist: '17000000-0000-0000-0000-000000000008',
  songA: '17000000-0000-0000-0000-000000000009',
  songB: '17000000-0000-0000-0000-000000000010'
};

const baseItem = values => postgresTestRow('BaseItems', { Data: '{}', ...values });

test('extended M3U decodes each whole path as a single value', () => {
  const paths = ['A+B & C.mp3', 'A%20B&x=y.mp3', 'A%26B.mp3', 'A&amp;B.mp3'];
  assert.deepEqual(parseM3uPlaylist(['#EXTM3U', ...paths].join('\n')),
    ['A+B & C.mp3', 'A B&x=y.mp3', 'A&B.mp3', 'A&amp;B.mp3']);
});

test('playlist refresh resolves real PostgreSQL library roots and persists ordered duplicate links',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const database = await createPostgresTestDatabase(t, 'playlist_items');
    const store = new DomainStore(database);
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'playlist-items-state-'));
    const linkedChildren=new PostgresLinkedChildrenStore({database});await linkedChildren.initialize();
    const spoolRoot=path.join(stateRoot,'metadata-spool');await mkdir(spoolRoot);
    const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, serverId: 'playlist-items-test', programDataPath: stateRoot });
    const storage = new StorageRegistry();
    storage.registerType('memory', () => new MemoryStorageAdapter());
    storage.registerType('local', configuration => LocalAdapter.open(configuration));
    const mediaRoot = path.join(stateRoot, 'tracks');
    await mkdir(mediaRoot);
    const adapter = await storage.createInstance('playlist-fixture', 'local', { root: mediaRoot, writable: true });
    const vfs = new VirtualFileSystem(storage);
    vfs.mount({ path: '/fixture', instanceId: 'playlist-fixture',
      capabilities: { create: true, replace: true, delete: true } });
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: 'Z:\\Fixture', accessRoot: '/fixture', style: 'windows',
      returnAccess: 'isolated playlist PostgreSQL fixture' });
    await storage.createInstance('playlist-ancestors', 'memory', {});
    vfs.mount({ path: '/playlist-ancestors', instanceId: 'playlist-ancestors', capabilities: {} });
    identityMap.addPrefix({ identityRoot: 'Z:\\', accessRoot: '/playlist-ancestors', style: 'windows',
      returnAccess: 'known empty ancestors of the playlist fixture' });
    const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap });
    const itemCreation=new ItemCreationService({store,library,linkedChildren,loadContext});library.itemCreation=itemCreation;
    const registry = new MetadataRegistry();
    registry.register(createPlaylistItemsPlugin({fileSystem: testFileSystem,  vfs, linkedChildren, spoolRoot }));
    const errors = [];
    const host = new MetadataRefreshHost({ registry, store, vfs, loadContext, linkedChildren,
      logger: { error: error => errors.push(error), warn: error => errors.push(error) },
      now: () => '2026-10-10T12:00:00.000Z' });
    t.after(async () => {
      await host.close();
      await itemCreation.close();
      await library.close();
      await linkedChildren.flushReleases();await linkedChildren.close();
      await storage.close();
      await store.close();
      await rm(stateRoot, { recursive: true, force: true });
    });
    t.after(() => t.diagnostic(inspect({ background: errors }, { depth: null })));

    await database.insert('BaseItems', baseItem({ Id: ids.aggregate,
      Type: 'MediaBrowser.Controller.Entities.AggregateFolder', Name: 'Aggregate', IsFolder: true }));
    await database.insert('BaseItems', baseItem({ Id: ids.userRoot,
      Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'User root', IsFolder: true }));
    await database.insert('BaseItems', baseItem({ Id: ids.folder,
      Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Fixture', Path: 'Z:\\Fixture',
      ParentId: ids.aggregate, IsFolder: true }));
    await database.insert('BaseItems', baseItem({ Id: ids.music,
      Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Music', ParentId: ids.userRoot,
      IsFolder: true, Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.folder],
        PhysicalLocationsList: ['Z:\\Fixture', 'Z:\\Fixture'] }) }));
    await database.insert('BaseItems', baseItem({ Id: ids.live,
      Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Live', ParentId: ids.userRoot,
      IsFolder: true, Data: JSON.stringify({ CollectionType: 'livetv', PhysicalLocationsList: ['Z:\\Ignored'] }) }));
    await database.insert('BaseItems', baseItem({ Id: ids.untyped,
      Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Untyped', ParentId: ids.userRoot,
      IsFolder: true, Data: JSON.stringify({ PhysicalLocationsList: ['Z:\\IgnoredUntyped'] }) }));
    await database.insert('BaseItems', baseItem({ Id: ids.nested,
      Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Nested', ParentId: ids.aggregate,
      IsFolder: true, Data: JSON.stringify({ CollectionType: 'music', PhysicalLocationsList: ['Z:\\IgnoredNested'] }) }));
    await database.insert('BaseItems', baseItem({ Id: ids.playlist,
      Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'External playlist', Data: '{"OpenAccess":true,"Shares":[]}',
      Path: 'Z:\\Fixture\\lists\\mix.m3u', ParentId: ids.folder, TopParentId: ids.folder,
      IsFolder: true }));
    for (const [Id, Name, Path] of [
      [ids.songA, 'Song A', 'Z:\\Fixture\\Rhythm & Blues.mp3'],
      [ids.songB, 'Song B', 'Z:\\Fixture\\Song B.mp3']
    ]) await database.insert('BaseItems', baseItem({ Id,
      Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name, Path, ParentId: ids.folder,
      TopParentId: ids.folder, MediaType: 'Audio', IsFolder: false }));

    await adapter.write('/Rhythm & Blues.mp3', Buffer.from('song-a'));
    await adapter.write('/Song B.mp3', Buffer.from('song-b'));
    await adapter.mkdir('/lists');
    const tracks = ['Rhythm & Blues.mp3', 'Song B.mp3', 'Rhythm & Blues.mp3'].map((name, index) => ({
      Ordinal: BigInt(index + 1), item: { Name: name, Path: 'Z:\\Fixture\\' + name, Type: 'Audio' },
    }));
    const spool = await preparePlaylistFile('Z:\\Fixture\\lists\\mix.m3u', {
      count: async () => tracks.length,
      page: async ({ after }) => ({ entries: tracks.filter(track => track.Ordinal > after), release() {} }),
    }, { fileSystem: testFileSystem, spoolRoot });
    try { await adapter.write('/lists/mix.m3u', Buffer.concat(await Array.fromAsync(spool.stream()))); }
    finally { await spool.close(); }

    const loaded = await loadContext(ids.playlist);
    assert.equal(loaded.context.accessPath, '/fixture/lists/mix.m3u');
    assert.deepEqual(await loaded.context.playlistLibraryRoots(), ['Z:\\Fixture']);
    assert.equal(await loaded.context.playlistFileExists('Z:\\Fixture\\Rhythm & Blues.mp3'), true);
    assert.equal((await loaded.context.findMetadataItemByPath('Z:\\Fixture\\Rhythm & Blues.mp3', null)).Id,
      ids.songA);
    assert.equal(await loaded.context.findMetadataItemByPath('Z:\\Fixture\\Rhythm & Blues.mp3', true), null);
    await loaded.dispose();

    const user = { Id: '71000000000000000000000000000001', Policy: { IsAdministrator: true,
      EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [],
      BlockUnratedItems: [], EnableContentDeletionFromFolders: [] }, MaxParentalRatingScore: null, MaxParentalRatingSubScore: null };
    const playlists = new PlaylistService({ store, library, linkedChildren, spoolRoot, programDataPath: stateRoot,
      dataPath: stateRoot, fileSystem: testFileSystem, vfs, identityMap });
    const app = await createTestApplication({ library, playlists, users: { getUser: async () => user },
      authentication: { authenticate: async () => ({ IsAuthenticated: true, IsAdministrator: true, User: user, UserId: user.Id }), authorize() {} },
      configuration: { IsStartupWizardCompleted: true } });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(async () => {
      app.beginClose(); await app.drainRequests(); await new Promise(resolve => app.server.close(resolve)); await playlists.close();
    });
    const expected = [ids.songA, ids.songB, ids.songA];
    const refresh = { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' };
    for (const [stage, replace] of [['initial import', false], ['existing members', false], ['replace all metadata', true]]) {
      const refreshed = await host.refresh(ids.playlist, { ...refresh, ReplaceAllMetadata: replace });
      assert.equal(refreshed.Failures, 0, stage);
      if (stage === 'initial import') assert.equal(refreshed.changed, true);
      const rows = await database.rows('LinkedChildren', { where: { ParentId: ids.playlist }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
      assert.deepEqual(rows.map(row => [row.ChildId, row.ChildType, row.SortOrder]), expected.map((id, i) => [id, 0, i]), stage);
      const page = await fetch('http://127.0.0.1:' + app.server.address().port + '/Playlists/' + ids.playlist + '/Items?enableImages=false&enableUserData=false');
      assert.equal(page.status, 200, stage);
      const body = await page.json();
      assert.equal(body.TotalRecordCount, 3, stage);
      assert.deepEqual(body.Items.map(item => item.Id), expected.map(id => id.replaceAll('-', '')), stage);
    }

    await adapter.write('/lists/mix.m3u', Buffer.from('../Song B.mp3\n'),
      { modified: '2026-10-10T13:00:00.000Z' });
    const replaced = await host.refresh(ids.playlist, {
      MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: true
    });
    assert.equal(replaced.Failures, 0);
    assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: ids.playlist } }))
      .map(row => row.ChildId), [ids.songB]);
  });
