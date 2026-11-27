import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { nativeGuid } from '../../src/users/native.js';
import { retainedUserDataItemId } from '../../src/library/item-persistence.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { loadStreams } from '../../src/library/media-streams.js';
import { createLyricService } from '../../src/lyrics/service.js';
import { CleanupUserDataTaskWorker } from '../../src/tasks/maintenance-tasks.js';
import { DownloadMediaTaskWorker } from '../../src/tasks/download-media-tasks.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const id = n => nativeGuid(n.toString().padStart(32, '0'));

test('cleanup deletes only detached rows strictly older than 90 days at native tick precision', {
  skip: !postgresTestConnectionString,
}, async t => {
  const db = await createPostgresTestDatabase(t, 'cleanup');
  const attached = id(30), user = id(31), cutoff = Date.UTC(2026, 1, 1);
  for (const Id of [retainedUserDataItemId, attached]) await db.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: Id === attached ? 'MediaBrowser.Controller.Entities.Movies.Movie' : 'PLACEHOLDER',
  }));
  await db.insert('Users', postgresTestRow('Users', { Id: user, InternalId: 1, Username: 'Player', NormalizedUsername: 'PLAYER' }));
  const expired = '2026-01-31 23:59:59.9999999';
  for (const [key, value] of [['old', expired], ['at', '2026-02-01T00:00:00Z'],
    ['new', '2026-02-01 00:00:00.0000001'], ['unknown', null], ['attached', expired]]) {
    await db.insert('UserData', postgresTestRow('UserData', { UserId: user,
      ItemId: key === 'attached' ? attached : retainedUserDataItemId, CustomDataKey: key, RetentionDate: value }));
  }
  const worker = new CleanupUserDataTaskWorker({ databaseStore: { run: fn => fn(db) }, clock: () => new Date(cutoff + 90 * 86400000) });
  t.after(() => worker.close());
  assert.deepEqual(worker.definition.defaultTriggers, []);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await worker.execute()).Status, 'Completed');
    assert.deepEqual((await db.rows('UserData')).map(row => row.CustomDataKey).sort(), ['at', 'attached', 'new', 'unknown']);
  }
});

test('daily workers select missing media streams, honor provider and language settings, and save the downloaded sidecars', {
  skip: !postgresTestConnectionString,
}, async t => {
  const db = await createPostgresTestDatabase(t, 'sidecars'), store = { run: fn => fn(db) };
  const root = id(50), collection = id(51), media = path.resolve('task-fixture-media'), items = new Map();
  await db.insert('BaseItems', postgresTestRow('BaseItems', { Id: root, Type: 'MediaBrowser.Controller.Entities.Folder' }));
  async function put(number, name, kind) {
    const Id = id(number), audio = kind === 'Audio', item = { Id, Type: kind, MediaType: audio ? 'Audio' : 'Video',
      Name: name, Path: path.join(media, name + (audio ? '.mp3' : '.mkv')) };
    await db.insert('BaseItems', postgresTestRow('BaseItems', { ...item, IsVirtualItem: false, ParentId: root, TopParentId: root,
      Type: 'MediaBrowser.Controller.Entities.' + (audio ? 'Audio.Audio' : 'Movies.Movie') }));
    items.set(Id, item); return item;
  }
  await put(52, 'song', 'Audio');
  const existing = await put(53, 'existing', 'Audio'), movie = await put(54, 'movie', 'Movie');
  const stream = (item, index, type, language) => db.insert('MediaStreamInfos', postgresTestRow('MediaStreamInfos', {
    ItemId: item.Id, StreamIndex: index, StreamType: type, Language: language, IsDefault: true, Codec: type === 2 ? 'subrip' : 'aac',
  }));
  await stream(existing, 0, 5, 'eng'); await stream(movie, 0, 0, 'deu'); await stream(movie, 1, 2, 'ita');
  const registry = new StorageRegistry(); t.after(() => registry.close());
  registry.registerType('memory', () => new MemoryStorageAdapter()); await registry.createInstance('local', 'memory', {});
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({ path: '/fixture', instanceId: 'local', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Private task media' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  const library = { options: { metadataPath: path.join(media, 'metadata'), libraryOptions: new Map([[collection, {
    ...defaultLibraryOptions(), SaveLyricsWithMedia: true, DisabledLyricFetchers: ['BAD'], LyricFetcherOrder: ['Preferred'],
    SubtitleDownloadLanguages: ['deu', 'ita', 'eng'], DisabledSubtitleFetchers: ['BAD'],
  }]]) }, getPhysicalScanRoots: async () => [{ Id: root }], getCollectionFolders: async () => [{ Id: collection, Type: 'CollectionFolder' }],
    withItemRecord: (Id, _options, run) => run(items.get(Id)),
    getMediaSources: async Id => [{ Id, MediaStreams: await loadStreams(db, items.get(Id), {}) }] };
  const calls = [], errors = [], refresh = [];
  const lyric = name => ({ name, search: async request => {
    calls.push([name, request.songName, request.isAutomated]);
    return [{ id: 'found', providerName: name, lyrics: { format: 'txt', bytes: Buffer.from(name) }, metadata: {} }];
  }, getLyrics: async () => ({ format: 'txt', bytes: Buffer.from(name) }) });
  const subtitle = name => ({ name, supportedMediaTypes: ['Movie'], search: async request => {
    calls.push([name, request.Language, request.IsAutomated, request.IsPerfectMatch]); return [{ id: 'result' }];
  }, getSubtitles: async () => ({ format: 'srt', bytes: Buffer.from('Subtitle text'), language: 'eng', forced: false, hearingImpaired: false }) });
  const services = { store, library, plugins: { entries: kind => kind === 'lyric' ? ['Bad', 'Other', 'Preferred'].map(lyric) : ['Bad', 'Subtitle'].map(subtitle) },
    storage: { vfs, identityMap }, fileSystem, runBackground: fn => fn(), onError: error => errors.push(error),
    metadata: { refreshLiveItem: async item => refresh.push([item.Id, await fileSystem.readFile(path.join(media, 'movie.eng.srt'), 'utf8')]) } };
  services.lyrics = createLyricService(services);
  for (const key of ['DownloadLyrics', 'DownloadSubtitles']) {
    const worker = new DownloadMediaTaskWorker({ key, services, onError: services.onError });
    t.after(() => worker.close());
    assert.deepEqual(worker.definition.defaultTriggers, [{ Type: 'IntervalTrigger', IntervalTicks: 864000000000n }]);
    assert.equal((await worker.execute()).Status, 'Completed');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [['Preferred', 'song', true], ['Other', 'song', true], ['Subtitle', 'eng', true, true]]);
  assert.equal(await fileSystem.readFile(path.join(media, 'song.txt'), 'utf8'), 'Preferred');
  assert.deepEqual(refresh, [[movie.Id, 'Subtitle text']]);
});
