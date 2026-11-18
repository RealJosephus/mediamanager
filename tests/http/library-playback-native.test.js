import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, cp, mkdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { getNewItemId, md5Guid } from '../../src/core/identity.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { idKey } from '../../src/library/records.js';
import { nativePersonIdentity } from '../../src/library/identity.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const nativeType = kind => 'MediaBrowser.Controller.Entities.' + kind;
const id = number => nativeGuid('25220000-0000-0000-0000-' + String(number).padStart(12, '0'));
const movieType = nativeType('Movies.Movie'), audioType = nativeType('Audio.Audio');
const audioId = id(20), movies = [id(21), id(22), id(23)];
const artistType = nativeType('Audio.MusicArtist'), artistId = id(24), orphanArtistId = id(25);
const features = [id(34), id(35)];
const fixedDate = '2026-10-01 00:00:00';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const authorization = token => `MediaBrowser Client="Contract fixture", Device="Isolated", DeviceId="fixture-oracle", Version="1", Token="${token}"`;
const audioFixture = new URL('../playback/fixtures/flac-copy-current/assets/upstream/subset/60 - mono audio.flac', import.meta.url);
const tileFixture = new URL('../images/fixtures/processor/single.jpg', import.meta.url);
const headersToCompare = ['content-type', 'content-disposition', 'accept-ranges', 'content-range', 'last-modified', 'allow'];

async function seed(referenceRoot, current) {
  const settings = await readInstanceConfiguration(referenceRoot);
  const { programDataPath, dataPath } = settings;
  const physical = path.join(programDataPath, 'media'), rootPath = path.join(programDataPath, 'root/default');
  const collection = path.join(rootPath, 'Contract Media'), audio = path.join(physical, 'Echo Track.flac');
  const resolveId = (filename, type) => nativeGuid(getNewItemId(filename, type, { programDataPath,
    enableCaseSensitiveItemIds: settings.configuration.EnableCaseSensitiveItemIds }));
  const folderId = resolveId(physical, nativeType('Folder')), collectionId = resolveId(collection, nativeType('CollectionFolder'));
  const groupingLibraries = [['Zulu Films', 'movies'], ['Alpha TV', 'tvshows']].map(([Name, type]) => {
    const Path = path.join(rootPath, Name);
    return { Name, type, Path, Id: resolveId(Path, nativeType('CollectionFolder')) };
  });
  const disabledPath = path.join(rootPath, 'Disabled Photos');
  const disabledLibrary = { Name: 'Disabled Photos', type: 'photos', Path: disabledPath,
    Id: resolveId(disabledPath, nativeType('CollectionFolder')), disabled: true };
  const configuredLibraries = [...groupingLibraries, disabledLibrary];
  const tileDir = path.join(dataPath, 'trickplay', movies[0].slice(0, 2).toLowerCase(), movies[0].toLowerCase(), '320 - 2x2');
  await mkdir(physical, { recursive: true });
  await mkdir(collection, { recursive: true });
  await mkdir(tileDir, { recursive: true });
  await writeFile(path.join(collection, 'music.collection'), '');
  await writeFile(path.join(collection, 'media.mblink'), physical);
  await writeFile(path.join(collection, 'options.xml'), '<LibraryOptions><EnableRealtimeMonitor>false</EnableRealtimeMonitor></LibraryOptions>');
  for (const library of configuredLibraries) {
    await mkdir(library.Path);
    await writeFile(path.join(library.Path, library.type + '.collection'), '');
    await writeFile(path.join(library.Path, 'options.xml'), `<LibraryOptions><EnableRealtimeMonitor>false</EnableRealtimeMonitor><Enabled>${!library.disabled}</Enabled></LibraryOptions>`);
  }
  await copyFile(audioFixture, audio);
  const tile = path.join(tileDir, '0.jpg');
  await copyFile(tileFixture, tile);
  for (const filename of [audio, tile]) await utimes(filename, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const databasePath = path.join(dataPath, 'jellyfin.db');
  const database = new SqliteDatabase(databasePath, { requireMigrationHistory: true });
  const apiKey = randomUUID().replaceAll('-', '');
  const people = Object.fromEntries(['Ada Ledger', 'Bela Ledger'].map(name => [name, nativePersonIdentity(name, settings)]));
  try {
    const aggregate = database.rows('BaseItems', { where: { Type: nativeType('AggregateFolder') } })[0];
    assert.ok(aggregate, 'The frozen instance must contain its actual aggregate root.');
    const userRoot = database.rows('BaseItems', { where: { Type: nativeType('UserRootFolder') } })[0];
    const rootId = userRoot?.Id ?? resolveId(rootPath, nativeType('UserRootFolder'));
    const addItem = fields => database.insert('BaseItems', postgresTestRow('BaseItems', {
      CleanName: fields.Name.toLowerCase(), SortName: fields.Name.toLowerCase(), PresentationUniqueKey: idKey(fields.Id),
      DateCreated: fixedDate, DateModified: fixedDate, DateLastSaved: fixedDate, MediaType: 'Unknown',
      ChannelId: nativeGuid('00000000000000000000000000000000'), Data: '{}', ...fields,
    }));
    database.transaction(() => {
      if (!userRoot) addItem({ Id: rootId, Type: nativeType('UserRootFolder'), Name: 'default', Path: rootPath,
        IsFolder: true, Data: '{"IsRoot":true}' });
      for (const { Id, Name, Path, type } of configuredLibraries) {
        addItem({ Id, Name, Path, ParentId: rootId, Type: nativeType('CollectionFolder'), IsFolder: true,
          Data: JSON.stringify({ CollectionType: type, PhysicalFolderIds: [], PhysicalLocationsList: [] }) });
      }
      addItem({ Id: collectionId, ParentId: rootId, Type: nativeType('CollectionFolder'), Name: 'Contract Media', Path: collection,
        IsFolder: true, Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [folderId], PhysicalLocationsList: [physical] }) });
      addItem({ Id: folderId, ParentId: aggregate.Id, TopParentId: folderId, Type: nativeType('Folder'),
        IsFolder: true, Name: 'Contract Physical', Path: physical });
      database.insert('AncestorIds', { ItemId: folderId, ParentItemId: aggregate.Id });
      addItem({ Id: audioId, ParentId: folderId, TopParentId: folderId, Type: audioType, MediaType: 'Audio',
        Name: 'Echo Track', Path: audio, TotalBitrate: 192000, RunTimeTicks: 600000000n,
        Artists: 'Echo Artist', AlbumArtists: 'Echo Artist', Album: 'Frozen Audio', Data: '{"Container":"flac"}' });
      for (const [index, Name] of ['Echo', 'Echo Bloom', 'Other Echo Result'].entries()) {
        const tick = fixedDate + '.123456' + (6 + index);
        addItem({ Id: movies[index], ParentId: folderId, TopParentId: folderId, Type: movieType, IsMovie: true,
          Name, Path: path.join(physical, Name + '.mkv'), MediaType: 'Video', PremiereDate: tick, DateLastSaved: tick,
          ProductionYear: 2026, Data: index === 0 ? '{"VideoType":"VideoFile"}'
            : '{"VideoType":"VideoFile","DefaultVideoStreamIndex":0,"Container":"mkv"}' });
        if (index !== 0) database.insert('MediaStreamInfos', postgresTestRow('MediaStreamInfos', {
          ItemId: movies[index], StreamIndex: 0, StreamType: 1, Codec: 'h264', Width: index === 1 ? 1280 : 1920, Height: 1080,
        }));
      }
      for (const ItemId of [audioId, ...movies]) for (const ParentItemId of [folderId, aggregate.Id]) {
        database.insert('AncestorIds', { ItemId, ParentItemId });
      }
      for (const [Name, person] of Object.entries(people)) {
        addItem({ Id: person.Id, Type: nativeType('Person'), Name, Path: person.Path, Overview: Name + ' biography' });
      }
      for (const [index, Name, PersonType] of [
        [30, 'Ada Ledger', 'Actor'], [31, 'ada ledger', 'GuestStar'], [32, 'Bela Ledger', 'Writer'], [33, 'Missing credit', 'Actor'],
      ]) {
        const PeopleId = id(index);
        database.insert('Peoples', postgresTestRow('Peoples', { Id: PeopleId, Name, PersonType }));
        database.insert('PeopleBaseItemMap', postgresTestRow('PeopleBaseItemMap', {
          ItemId: index === 32 ? movies[1] : movies[0], PeopleId, ListOrder: index - 30,
        }));
      }
      database.insert('Peoples', postgresTestRow('Peoples', { Id: id(37), Name: 'Cora Vale', PersonType: 'Director' }));
      for (const ItemId of movies.slice(1)) {
        for (const [ListOrder, PeopleId] of [[4, id(30)], [5, id(37)]]) {
          database.insert('PeopleBaseItemMap', postgresTestRow('PeopleBaseItemMap', { ItemId, PeopleId, ListOrder }));
        }
      }
      for (const [Id, Name, ExtraType] of [
        [features[0], 'A look backstage', 3], [features[1], 'Shorter story', 11], [id(36), 'Theme clip', 9],
      ]) {
        addItem({ Id, Type: nativeType('Video'), Name, ExtraType, OwnerId: movies[0], TopParentId: folderId,
          Path: path.join(physical, Name + '.mkv'), MediaType: 'Video', Data: '{"VideoType":"VideoFile","Container":"mkv"}' });
      }
      database.insert('MediaStreamInfos', postgresTestRow('MediaStreamInfos', {
        ItemId: audioId, StreamIndex: 0, StreamType: 0, Codec: 'flac', SampleRate: 44100, BitDepth: 16,
        Channels: 1, BitRate: 192000, IsDefault: true,
      }));
      for (const [StreamIndex, Path] of [[1, audio], [2, null], [3, path.join(physical, 'Missing Track.flac')]]) {
        database.insert('MediaStreamInfos', postgresTestRow('MediaStreamInfos', {
          ItemId: movies[0], StreamIndex, StreamType: 0, Codec: 'flac', Path, IsExternal: Path !== null,
        }));
      }
      addItem({ Id: artistId, Type: artistType, IsFolder: true, Name: 'Related Musician' });
      addItem({ Id: orphanArtistId, Type: artistType, IsFolder: true, Name: 'Detached Musician' });
      database.insert('ItemValues', { ItemValueId: id(26), Type: 0, Value: 'Related Musician', CleanValue: 'related musician' });
      database.insert('ItemValuesMap', { ItemId: artistId, ItemValueId: id(26) });
      database.insert('TrickplayInfos', { ItemId: movies[0], Width: 320, Height: 180, Bandwidth: 32100,
        Interval: 1501, ThumbnailCount: 5, TileWidth: 2, TileHeight: 2 });
      database.insert('UserData', postgresTestRow('UserData', {
        ItemId: movies[0], UserId: current.userId, CustomDataKey: '', IsFavorite: true,
      }));
      database.insert('UserData', postgresTestRow('UserData', {
        ItemId: movies[1], UserId: current.userId, CustomDataKey: '', Played: true, PlayCount: 1, LastPlayedDate: fixedDate,
      }));
      database.insert('UserData', postgresTestRow('UserData', {
        ItemId: people['Ada Ledger'].Id, UserId: current.userId, CustomDataKey: '', IsFavorite: true,
      }));
      database.insert('ApiKeys', { AccessToken: apiKey, Name: 'Contract read fixture', DateCreated: fixedDate, DateLastActivity: fixedDate });
    });
    database.preflight();
  } finally { database.close(); }
  return { settings, databasePath, folderId, apiKey, audio, tile, people, groupingLibraries, physical };
}

function portAvailable(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function readResponse(origin, sample, token, signal) {
  const request = await fetch(origin + sample.route, { method: sample.method ?? 'GET', redirect: 'manual',
    headers: { Accept: 'application/json', Connection: 'close',
      ...(token ? { Authorization: authorization(token) } : {}),
      ...sample.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const bytes = Buffer.from(await request.arrayBuffer()), contentType = request.headers.get('content-type');
  const binary = /^(?:audio|image)\//u.test(contentType ?? '');
  const compared = binary || /^application\/vnd\.apple\.mpegurl/u.test(contentType ?? '')
    ? [...headersToCompare, 'content-length'] : headersToCompare;
  return { status: request.status, headers: Object.fromEntries(compared.map(name => [name, request.headers.get(name)])),
    body: binary ? bytes.toString('base64') : bytes.toString('utf8'), binary };
}

function comparable(result) {
  const { body, headers, status } = result;
  return { status, headers, body: body && /(?:^application\/json|\+json)/u.test(headers['content-type'] ?? '')
    ? projectProblemTrace(parseLosslessJson(body), status) : body };
}

function availableOptionsDefaults(body) {
  // Provider installations differ. Compare the representative items, shared
  // native image defaults and the built-in local similarity provider exactly.
  return body.TypeOptions.map(({ Type, DefaultImageOptions, SimilarItemProviders }) => ({ Type, DefaultImageOptions,
    LocalSimilarity: SimilarItemProviders.filter(provider => provider.Name === 'Local Genre/Tag') }));
}

function comparableMediaFolders(body) {
  return { ...body, Items: body.Items.map(item => {
    if (typeof item.DateCreated !== 'string') return item;
    // Native can omit trailing fractional zeros. Keep every 100 ns digit
    // that changes the instant while comparing these DTOs.
    return { ...item, DateCreated: item.DateCreated.replace(/(\.\d*?[1-9])0+Z$/u, '$1Z').replace(/\.0+Z$/u, 'Z') };
  }) };
}

function hlsSelection(response, route) {
  assert.equal(response.headers['content-type'], 'application/vnd.apple.mpegurl');
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
  const lines = response.body.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines[0], '#EXTM3U');
  const variant = new URL(lines.find(line => !line.startsWith('#')), 'http://127.0.0.1' + route);
  const query = new Map([...variant.searchParams].map(([name, value]) => [name.toLowerCase(), value]));
  return { path: variant.pathname, container: query.get('segmentcontainer'), audioCodec: query.get('audiocodec'),
    codecs: /\bCODECS="([^"]+)"/u.exec(lines.find(line => line.startsWith('#EXT-X-STREAM-INF:')))?.[1] };
}

async function changeVideoVersions(origin, token, readState, signal, evidence) {
  const [, lower, higher] = movies.map(idKey);
  const request = (method, route, accessToken = token) => readResponse(origin, { method, route }, accessToken, signal);
  const merge = '/Videos/MergeVersions?Ids=' + lower + ',' + higher;
  const split = '/Videos/' + lower + '/AlternateSources';
  assert.equal((await request('POST', merge, null)).status, 401);
  assert.equal((await request('POST', '/Videos/MergeVersions?Ids=' + lower)).status, 400);
  evidence.merge = await request('POST', merge);
  assert.equal(evidence.merge.status, 204, JSON.stringify(evidence.merge));
  evidence.merged = await readState();
  assert.deepEqual(evidence.merged, {
    items: [{ id: lower, primary: higher, key: higher }, { id: higher, primary: null, key: higher }],
    links: [{ parent: higher, child: lower, type: 3, position: 0 }],
  });
  const requestSources = async () => {
    const result = await request('GET', '/Items/' + higher + '/PlaybackInfo');
    assert.equal(result.status, 200);
    return JSON.parse(result.body).MediaSources.map(source => [source.Id, source.Type]);
  };
  evidence.mergedSources = await requestSources();
  assert.deepEqual(evidence.mergedSources, [[higher, 'Default'], [lower, 'Grouping']]);
  evidence.split = await request('DELETE', split);
  assert.equal(evidence.split.status, 204, JSON.stringify(evidence.split));
  evidence.separate = await readState();
  assert.deepEqual(evidence.separate, {
    items: [{ id: lower, primary: null, key: lower }, { id: higher, primary: null, key: higher }], links: [],
  });
  evidence.separateSources = await requestSources();
  assert.deepEqual(evidence.separateSources, [[higher, 'Default']]);
}

async function readVersionState(db) {
  const ids = movies.slice(1);
  const items = [], links = [];
  for (const Id of ids) {
    const [row] = await db.rows('BaseItems', { where: { Id } });
    items.push({ id: idKey(row.Id), primary: row.PrimaryVersionId ? idKey(row.PrimaryVersionId) : null, key: row.PresentationUniqueKey });
    for (const link of await db.rows('LinkedChildren', { where: { ParentId: Id } })) {
      links.push({ parent: idKey(link.ParentId), child: idKey(link.ChildId), type: link.ChildType, position: link.SortOrder });
    }
  }
  return { items, links };
}

test('existing playback assets, date ticks, counts and search hints match the designated Native HTTP host', {
  skip: !enabled, timeout: 300000,
}, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'library-playback-http-' + randomUUID()));
  await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference');
  const nativeOrigin = `http://127.0.0.1:${port}`, report = { cases: [], differences: [], cleanup: [] };
  let current, native, proxy, database, runtime, fixture, stopped, primary;
  const stopNative = async () => {
    if (!native || stopped) return;
    stopped = true;
    report.nativeShutdown = await native.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST',
        headers: { Authorization: authorization(current.accessToken), Connection: 'close' }, signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer();
      return response.status;
    }, () => portAvailable(port));
    assert.equal(report.nativeShutdown.cleanShutdown, true);
    assert.equal(report.nativeShutdown.code, 0);
    assert.equal(report.nativeShutdown.pidGone, true);
    assert.equal(report.nativeShutdown.portAvailable, true);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    report.reference = current.preparation;
    report.sources = await current.sourceBindings([
      'Jellyfin.Api/Controllers/UniversalAudioController.cs', 'Jellyfin.Api/Helpers/AudioHelper.cs',
      'Jellyfin.Api/Helpers/DynamicHlsHelper.cs', 'MediaBrowser.Model/Dlna/StreamBuilder.cs',
      'Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs', 'MediaBrowser.Controller/IO/LocalMediaProxy.cs',
      'Jellyfin.Api/Controllers/SubtitleController.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Jellyfin.Api/Controllers/TrickplayController.cs',
      'Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs', 'Jellyfin.Api/Controllers/ItemsController.cs',
      'Jellyfin.Api/Controllers/LibraryController.cs', 'Jellyfin.Server.Implementations/Item/ItemCountService.cs',
      'Jellyfin.Api/Controllers/SearchController.cs', 'Emby.Server.Implementations/Library/Search/SearchManager.cs',
      'Emby.Server.Implementations/Library/Search/SqlSearchProvider.cs',
      'Jellyfin.Api/Controllers/PersonsController.cs', 'Jellyfin.Server.Implementations/Item/PeopleRepository.cs',
      'Jellyfin.Api/Controllers/UserLibraryController.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'Jellyfin.Api/Controllers/UserViewsController.cs', 'MediaBrowser.Controller/Entities/UserView.cs',
      'Jellyfin.Api/Controllers/LiveTvController.cs', 'src/Jellyfin.LiveTv/LiveTvManager.cs',
      'src/Jellyfin.LiveTv/DefaultLiveTvService.cs',
      'Jellyfin.Api/Controllers/MoviesController.cs',
      'Jellyfin.Api/Controllers/VideosController.cs', 'MediaBrowser.Controller/Entities/Video.cs',
      'Emby.Server.Implementations/Library/SimilarItems/SimilarItemsManager.cs',
      'Emby.Server.Implementations/Library/SimilarItems/MovieSimilarItemsProvider.cs',
      'MediaBrowser.Controller/Entities/AggregateFolder.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
      'Emby.Server.Implementations/Playlists/PlaylistsFolder.cs', 'MediaBrowser.Controller/Dto/DtoOptions.cs',
      'Jellyfin.Api/ModelBinders/NullableEnumModelBinder.cs', 'MediaBrowser.Model/Configuration/TypeOptions.cs',
    ]);
    await cp(current.sourceRoot, referenceRoot, { recursive: true });
    await current.prepareClone(referenceRoot, port);
    fixture = await seed(referenceRoot, current);
    output.addSecret(fixture.apiKey);
    const frozenAudio = await readFile(audioFixture);
    proxy = await startOwnedMediaProxy([{ filename: fixture.audio, contentType: 'audio/flac',
      expected: { bytes: frozenAudio.length, sha256: sha(frozenAudio) } }]);
    report.nativeMedia = proxy.report;
    database = await createPostgresTestDatabase(null, 'library_playback_http');
    const snapshot = new SqliteDatabase(fixture.databasePath, { readOnly: true, requireMigrationHistory: true });
    try {
      report.sqliteSha256 = sha(await readFile(fixture.databasePath));
      report.transfer = await transferDatabase(snapshot, database, { instanceBinding: {
        serverId: fixture.settings.serverId, originIdentityDigest: report.sqliteSha256,
      } });
    } finally { snapshot.close(); }

    const ids = movies.map(idKey), audioRoute = `/Audio/${idKey(audioId)}/universal`;
    const audio = audioRoute + '?Container=flac%7Cflac&MaxStreamingBitrate=8000000';
    const externalAudio = (item, source, stream) => `/Videos/${item}/${source}/Audios/${stream}/Stream.aac`;
    const trickplay = `/Videos/${ids[0]}/Trickplay/320`;
    const datePath = '/Items?Recursive=true&EnableImages=false&EnableUserData=false&SortBy=SortName&Ids=' + ids.join(',');
    const tunerService = md5Guid('Jellyfin.LiveTv.DefaultLiveTvService');
    const tunerReset = tuner => '/LiveTv/Tuners/' + tuner + '/Reset';
    const samples = [
      { name: 'universal audio', route: audio, status: 200 },
      { name: 'universal audio HEAD', route: audio, method: 'HEAD', status: 200 },
      { name: 'universal audio range', route: audio, headers: { Range: 'bytes=7-31' }, status: 206 },
      { name: 'universal audio anonymous', route: audio, anonymous: true, status: 401 },
      { name: 'tile playlist', route: trickplay + '/tiles.m3u8', status: 200 },
      { name: 'selected source playlist', route: `/Videos/${ids[1]}/Trickplay/320/tiles.m3u8?MediaSourceId=${ids[0]}`, status: 200 },
      { name: 'tile JPEG', route: trickplay + '/0.jpg', status: 200 },
      { name: 'tile range is ignored', route: trickplay + '/0.jpg', headers: { Range: 'bytes=0-5' }, status: 200 },
      { name: 'missing tile', route: trickplay + '/1.jpg', status: 404 },
      { name: 'global counts', route: '/Items/Counts', apiKey: true, status: 200 },
      { name: 'current user counts', route: '/Items/Counts', status: 200 },
      { name: 'specified favorite counts', route: '/Items/Counts?IsFavorite=true&UserId=' + idKey(current.userId), status: 200 },
      { name: 'neighboring item detail', route: `/Items/${ids[0]}?EnableImages=false&EnableUserData=false`, status: 200 },
      { name: 'global hints', route: '/Search/Hints?SearchTerm=Echo', apiKey: true, status: 200 },
      { name: 'current user hints', route: '/Search/Hints?SearchTerm=Echo', status: 200 },
      { name: 'movie hints', route: '/Search/Hints?SearchTerm=Echo&IncludeItemTypes=Movie&StartIndex=1&Limit=3', status: 200 },
      { name: 'parented hints', route: '/Search/Hints?SearchTerm=Echo&ParentId=' + idKey(fixture.folderId), status: 200 },
      { name: 'audio hint', route: '/Search/Hints?SearchTerm=Echo&MediaTypes=Audio&IncludePeople=false', status: 200 },
      { name: 'associated artist hint', route: '/Search/Hints?SearchTerm=Related%20Musician&IncludeItemTypes=MusicArtist', apiKey: true, status: 200 },
      { name: 'detached artist hint', route: '/Search/Hints?SearchTerm=Detached%20Musician&IncludeItemTypes=MusicArtist', apiKey: true, status: 200 },
      { name: 'required hint term', route: '/Search/Hints', status: 400 },
      ...['MinPremiereDate', 'MaxPremiereDate', 'MinDateLastSaved', 'MinDateLastSavedForUser'].map(name => ({
        name, route: datePath + '&' + name + '=' + encodeURIComponent('2026-10-01T08:00:00.1234567+08:00'), status: 200,
      })),
      { name: 'external audio uses the file MIME', route: externalAudio(ids[0], ids[0], 1), status: 200 },
      { name: 'external audio range', route: externalAudio(ids[0], ids[0], 1), headers: { Range: 'bytes=7-31' }, status: 206 },
      { name: 'external audio anonymous', route: externalAudio(ids[0], ids[0], 1), anonymous: true, status: 401 },
      { name: 'external audio unknown item', route: externalAudio(idKey(id(999)), ids[0], 1), status: 404 },
      { name: 'external audio unknown source', route: externalAudio(ids[0], ids[1], 1), status: 404 },
      { name: 'external audio unknown stream', route: externalAudio(ids[0], ids[0], 9), status: 404 },
      { name: 'external audio pathless stream', route: externalAudio(ids[0], ids[0], 2), status: 404 },
      { name: 'external audio absent file', route: externalAudio(ids[0], ids[0], 3), status: 404 },
      { name: 'universal FLAC container copy', route: audioRoute + '?Container=mp4%7Cflac&TranscodingProtocol=hls&TranscodingContainer=mp4', status: 200, hls: true },
      { name: 'people search deduplicates credit roles', route: '/Persons?SearchTerm=ledger&Fields=Overview,ItemCounts', status: 200 },
      { name: 'people pagination and credit role', route: '/Persons?SearchTerm=ledger&PersonTypes=Writer,Actor&StartIndex=1&Limit=1&EnableUserData=false', status: 200 },
      { name: 'people derive scope from credited media', route: '/Persons?ParentId=' + idKey(fixture.folderId) + '&AppearsInItemId=' + ids[0], status: 200 },
      { name: 'people uses favorite data', route: '/Persons?Filters=IsFavorite&SearchTerm=ledger', status: 200 },
      { name: 'people counts the missing credited entity', route: '/Persons?SearchTerm=missing%20credit', status: 200, apiKey: true },
      { name: 'person detail resolves the normalized name', route: '/Persons/ada%20ledger', status: 200 },
      { name: 'missing person is not created', route: '/Persons/Missing%20credit', status: 404 },
      { name: 'people requires authentication', route: '/Persons', status: 401, anonymous: true },
      { name: 'item special features', route: '/Items/' + ids[0] + '/SpecialFeatures', status: 200 },
      { name: 'legacy item special features', route: '/Users/' + idKey(current.userId) + '/Items/' + ids[0] + '/SpecialFeatures', status: 200 },
      { name: 'features requires a user with API key', route: '/Items/' + ids[0] + '/SpecialFeatures', status: 400, apiKey: true },
      { name: 'features of a missing owner', route: '/Items/' + idKey(id(999)) + '/SpecialFeatures', status: 404 },
      { name: 'eligible user view groups', route: '/UserViews/GroupingOptions', status: 200 },
      { name: 'legacy eligible user view groups', route: '/Users/' + idKey(current.userId) + '/GroupingOptions', status: 200 },
      { name: 'user view groups require a user with API key', route: '/UserViews/GroupingOptions', status: 400, apiKey: true },
      { name: 'physical library paths', route: '/Library/PhysicalPaths', status: 200 },
      { name: 'physical library paths require elevation', route: '/Library/PhysicalPaths', status: 401, anonymous: true },
      { name: 'available media folders', route: '/Library/MediaFolders', status: 200, mediaFolders: true },
      { name: 'hidden media folders', route: '/Library/MediaFolders?IsHidden=true', status: 200, mediaFolders: true },
      { name: 'visible media folders', route: '/Library/MediaFolders?IsHidden=false', status: 200, mediaFolders: true },
      { name: 'media folders nullable filter', route: '/Library/MediaFolders?IsHidden=%20', status: 200, mediaFolders: true },
      { name: 'media folders rejects malformed filter', route: '/Library/MediaFolders?isHidden=invalid', status: 400 },
      { name: 'media folders authorize before binding', route: '/Library/MediaFolders?isHidden=invalid', status: 401, anonymous: true },
      { name: 'new movie library defaults', route: '/Libraries/AvailableOptions?libraryContentType=1&isNewLibrary=true', status: 200, libraryOptions: true },
      { name: 'television library defaults', route: '/Libraries/AvailableOptions?libraryContentType=TVShows', status: 200, libraryOptions: true },
      { name: 'unknown content type uses mixed defaults', route: '/Libraries/AvailableOptions?libraryContentType=invalid', status: 200, libraryOptions: true },
      { name: 'built-in tuner reset completes', route: tunerReset(tunerService.toUpperCase() + '_fixture_tuner'), method: 'POST', status: 204 },
      { name: 'tuner reset requires authentication', route: tunerReset(tunerService + '_fixture_tuner'), method: 'POST', status: 401, anonymous: true },
      { name: 'unknown tuner service', route: tunerReset('unknown_fixture'), method: 'POST', status: 400 },
      { name: 'tuner reset requires the separator', route: tunerReset(tunerService), method: 'POST', status: 500 },
      { name: 'missing active recording stream', route: '/LiveTv/LiveRecordings/fixture/stream', status: 404, anonymous: true },
      { name: 'movie recommendation category and item order', route: '/Movies/Recommendations?CategoryLimit=4&ItemLimit=2&Fields=Overview,MediaSourceCount', status: 200 },
      { name: 'movie recommendations respect category and item limits', route: '/Movies/Recommendations?CategoryLimit=1&ItemLimit=1&ParentId=' + idKey(fixture.folderId), status: 200 },
      { name: 'movie recommendations allow zero categories', route: '/Movies/Recommendations?CategoryLimit=0', status: 200 },
      { name: 'movie recommendations allow zero items', route: '/Movies/Recommendations?ItemLimit=0', status: 200 },
      { name: 'movie recommendations require a user with API key', route: '/Movies/Recommendations', status: 400, apiKey: true },
    ];
    native = current.start({ referenceRoot, outputRoot: root, label: 'native', origin: nativeOrigin });
    await native.ready();
    const token = sample => sample.anonymous ? null : sample.apiKey ? fixture.apiKey : current.accessToken;
    for (const sample of samples) report.cases.push({ sample, native: await readResponse(nativeOrigin, sample, token(sample), t.signal) });
    report.versions = { native: {}, node: {} };
    await changeVideoVersions(nativeOrigin, current.accessToken, async () => {
      const sqlite = new SqliteDatabase(fixture.databasePath, { readOnly: true, requireMigrationHistory: true });
      try { return await readVersionState(sqlite); } finally { sqlite.close(); }
    }, t.signal, report.versions.native);
    await stopNative();
    await writeFile(path.join(referenceRoot, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><AutoDiscovery>false</AutoDiscovery><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>');
    runtime = await createTestRuntime({ ...await readInstanceConfiguration(referenceRoot), database,
      onError: error => { (report.runtimeErrors ??= []).push({ message: error?.message, code: error?.code }); } });
    const nodeOrigin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    for (const entry of report.cases) {
      entry.node = await readResponse(nodeOrigin, entry.sample, token(entry.sample), t.signal);
      try {
        assert.equal(entry.native.status, entry.sample.status);
        assert.equal(entry.node.status, entry.sample.status);
        if (entry.sample.hls) {
          const expected = { path: `/Audio/${idKey(audioId)}/main.m3u8`, container: 'mp4', audioCodec: 'copy', codecs: 'fLaC' };
          assert.deepEqual(hlsSelection(entry.native, entry.sample.route), expected);
          assert.deepEqual(hlsSelection(entry.node, entry.sample.route), expected);
        } else if (entry.sample.libraryOptions) {
          const native = comparable(entry.native), node = comparable(entry.node);
          assert.deepEqual({ ...node, body: availableOptionsDefaults(node.body) },
            { ...native, body: availableOptionsDefaults(native.body) });
        } else if (entry.sample.mediaFolders) {
          const native = comparable(entry.native), node = comparable(entry.node);
          assert.deepEqual({ ...node, body: comparableMediaFolders(node.body) },
            { ...native, body: comparableMediaFolders(native.body) });
        } else assert.deepEqual(comparable(entry.node), comparable(entry.native));
      } catch (error) { report.differences.push({ name: entry.sample.name, message: error.message }); }
    }
    await changeVideoVersions(nodeOrigin, current.accessToken, () => readVersionState(database), t.signal, report.versions.node);
    assert.deepEqual(report.versions.node, report.versions.native);
    const observed = name => comparable(report.cases.find(entry => entry.sample.name === name).native).body;
    assert.equal(observed('specified favorite counts').MovieCount, 1);
    assert.equal(observed('global hints').SearchHints.length, 4);
    assert.equal(observed('current user hints').SearchHints.length, 4);
    assert.equal(observed('parented hints').SearchHints.length, 4);
    assert.deepEqual(observed('associated artist hint').SearchHints.map(hint => hint.Id), [idKey(artistId)]);
    assert.equal(observed('detached artist hint').TotalRecordCount, 0);
    assert.deepEqual(observed('people search deduplicates credit roles').Items.map(item => item.Name), ['Ada Ledger', 'Bela Ledger']);
    assert.deepEqual(observed('people pagination and credit role').Items.map(item => item.Name), ['Bela Ledger']);
    assert.deepEqual(observed('people uses favorite data').Items.map(item => item.Name), ['Ada Ledger']);
    assert.deepEqual(observed('people counts the missing credited entity'), { Items: [], StartIndex: 0, TotalRecordCount: 1 });
    assert.equal(observed('person detail resolves the normalized name').Id, idKey(fixture.people['Ada Ledger'].Id));
    assert.deepEqual(observed('item special features').map(item => item.Id), features.map(idKey));
    assert.deepEqual(observed('legacy item special features'), observed('item special features'));
    assert.deepEqual(observed('eligible user view groups'), [...fixture.groupingLibraries].reverse().map(({ Id, Name }) => ({ Id: idKey(Id), Name })));
    assert.deepEqual(observed('legacy eligible user view groups'), observed('eligible user view groups'));
    assert.ok(observed('physical library paths').includes(fixture.physical));
    const visibleLibraries = ['Alpha TV', 'Contract Media', 'Zulu Films'];
    assert.deepEqual(observed('visible media folders').Items.map(item => item.Name), visibleLibraries);
    assert.deepEqual(observed('hidden media folders').Items.map(item => [item.Name, item.Type]), [['Playlists', 'ManualPlaylistsFolder']]);
    assert.deepEqual(observed('available media folders').Items.map(item => item.Name), ['Alpha TV', 'Contract Media', 'Playlists', 'Zulu Films']);
    assert.deepEqual(observed('media folders nullable filter'), observed('available media folders'));
    assert.deepEqual(observed('new movie library defaults').TypeOptions.map(type => type.Type), ['Movie']);
    assert.deepEqual(observed('television library defaults').TypeOptions.map(type => type.Type), ['Series', 'Season', 'Episode']);
    assert.deepEqual(observed('unknown content type uses mixed defaults').TypeOptions.map(type => type.Type), ['Series', 'Season', 'Episode', 'Movie']);
    const recommended = observed('movie recommendation category and item order');
    assert.deepEqual(recommended.map(category => [category.RecommendationType, category.CategoryId, category.Items.map(item => item.Id)]), [
      ['SimilarToRecentlyPlayed', ids[1], [ids[2], ids[0]]],
      ['SimilarToLikedItem', ids[0], [ids[2]]],
      ['HasDirectorFromRecentlyPlayed', md5Guid('Cora Vale'), [ids[2]]],
      ['HasActorFromRecentlyPlayed', md5Guid('Ada Ledger'), [ids[0], ids[2]]],
    ]);
    const capped = observed('movie recommendations respect category and item limits');
    assert.equal(capped.length, 1);
    assert.deepEqual(capped[0].Items.map(item => item.Id), [ids[2]]);
    assert.deepEqual(observed('movie recommendations allow zero categories'), []);
    assert.deepEqual(observed('movie recommendations allow zero items'), []);
    for (const name of ['MinPremiereDate', 'MaxPremiereDate', 'MinDateLastSaved', 'MinDateLastSavedForUser']) {
      assert.equal(observed(name).TotalRecordCount, 2, name);
    }
    assert.equal(sha(Buffer.from(observed('universal audio'), 'base64')), sha(await readFile(fixture.audio)));
    assert.equal(observed('external audio uses the file MIME'), observed('universal audio'));
    assert.equal(observed('external audio range'), observed('universal audio range'));
    assert.equal(sha(Buffer.from(observed('tile JPEG'), 'base64')), sha(await readFile(fixture.tile)));
    assert.deepEqual(proxy.report.errors, []);
    assert.deepEqual(proxy.report.requests.map(({ method, range, status }) => [method, range, status]),
      [['GET', null, 200], ['GET', null, 200], ['GET', 'bytes=7-31', 206],
        ['GET', null, 200], ['GET', 'bytes=7-31', 206], ['GET', null, 404]]);
    assert.deepEqual(report.differences.map(difference => difference.name), [], 'See the recorded Native and PostgreSQL responses.');
  } catch (error) { primary = output.publicError(error); throw primary; }
  finally {
    const errors = [];
    for (const [name, close] of [['Native host', stopNative], ['Native media proxy', async () => {
      if (proxy) {
        await proxy.close();
        assert.equal(proxy.report.closed, true);
        assert.equal(await portAvailable(proxy.report.port), true);
      }
    }], ['Node runtime', () => runtime?.close()],
      ['owned PostgreSQL schema', () => dropPostgresTestDatabase(database)], ['frozen inputs', () => current?.finish()]]) {
      try { await close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { errors.push(output.publicError(error)); report.cleanup.push({ name, closed: false, message: error.message }); }
    }
    try {
      await writeFile(path.join(root, 'observations.json'), filterEvidenceJson(report));
      await output.publishAndClose();
    } catch (error) { errors.push(output.publicError(error)); }
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, 'Library HTTP fixture cleanup failed.', { cause: primary });
  }
}, { signal: t.signal })));
