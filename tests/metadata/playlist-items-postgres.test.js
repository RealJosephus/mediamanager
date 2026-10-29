import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { createPlaylistItemsPlugin } from '../../src/metadata/playlist-items.js';
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
    const adapter = await storage.createInstance('playlist-fixture', 'memory', {});
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
      Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'External playlist',
      Path: 'Z:\\Fixture\\lists\\mix.m3u', ParentId: ids.folder, TopParentId: ids.folder,
      IsFolder: true }));
    for (const [Id, Name, Path] of [
      [ids.songA, 'Song A', 'Z:\\Fixture\\SongA.mp3'],
      [ids.songB, 'Song B', 'Z:\\Fixture\\Song B.mp3']
    ]) await database.insert('BaseItems', baseItem({ Id,
      Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name, Path, ParentId: ids.folder,
      TopParentId: ids.folder, MediaType: 'Audio', IsFolder: false }));

    await adapter.write('/SongA.mp3', Buffer.from('song-a'));
    await adapter.write('/Song B.mp3', Buffer.from('song-b'));
    await adapter.mkdir('/lists');
    await adapter.write('/lists/mix.m3u', Buffer.from('#EXTM3U\n../SongA.mp3\n../Song B.mp3\n../SongA.mp3\n'));

    const loaded = await loadContext(ids.playlist);
    assert.equal(loaded.context.accessPath, '/fixture/lists/mix.m3u');
    assert.deepEqual(await loaded.context.playlistLibraryRoots(), ['Z:\\Fixture']);
    assert.equal(await loaded.context.playlistFileExists('Z:\\Fixture\\SongA.mp3'), true);
    assert.equal((await loaded.context.findMetadataItemByPath('Z:\\Fixture\\SongA.mp3', null)).Id,
      ids.songA);
    assert.equal(await loaded.context.findMetadataItemByPath('Z:\\Fixture\\SongA.mp3', true), null);
    await loaded.dispose();

    const refreshed = await host.refresh(ids.playlist,
      { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.Failures, 0);
    assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: ids.playlist },
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => ({
      child: row.ChildId, type: row.ChildType, order: row.SortOrder
    })), [
      { child: ids.songA, type: 0, order: 0 },
      { child: ids.songB, type: 0, order: 1 },
      { child: ids.songA, type: 0, order: 2 }
    ]);

    await adapter.write('/lists/mix.m3u', Buffer.from('../Song B.mp3\n'),
      { modified: '2026-10-10T13:00:00.000Z' });
    const replaced = await host.refresh(ids.playlist, {
      MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: true
    });
    assert.equal(replaced.Failures, 0);
    assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: ids.playlist } }))
      .map(row => row.ChildId), [ids.songB]);
  });
