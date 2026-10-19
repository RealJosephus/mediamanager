import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import {
  createTvItemResolver,
  episodeNativeType,
  seasonNativeType,
  seriesNativeType
} from '../../src/library/tv-item-resolver.js';
import {
  audioNativeType,
  createAudioItemResolver,
  musicAlbumNativeType,
  musicArtistNativeType
} from '../../src/library/audio-item-resolver.js';
import { idKey, repositoryTopParentId } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { ensureFixtureDirectory, prepareIgnoreFileFixture } from './ignore-file-fixture.js';

// This is a production-integration control over the JavaScript runtime path,
// not a newly captured or substituted native execution/oracle.
const ids = Object.freeze({
  aggregate: 'FA130000-0000-0000-0000-000000000001',
  userRoot: 'FA130000-0000-0000-0000-000000000002',
  collection: 'FA130000-0000-0000-0000-000000000003',
  physical: 'FA130000-0000-0000-0000-000000000004'
});

const commonArrayFields = Object.freeze([
  'Genres', 'Studios', 'Tags', 'ProductionLocations', 'ImageInfos',
  'LockedFields', 'RemoteTrailers', 'UserData'
]);
const folderArrayFields = commonArrayFields;
const videoArrayFields = Object.freeze([
  ...commonArrayFields, 'AdditionalParts', 'LocalAlternateVersions',
  'LinkedAlternateVersions', 'SubtitleFiles', 'AudioFiles'
]);

function expectedItemId(fixture, identityPath, nativeType) {
  return nativeGuid(getNewItemId(identityPath, nativeType, {
    programDataPath: fixture.stateRoot,
    enableCaseSensitiveItemIds: fixture.configuration.EnableCaseSensitiveItemIds
  }));
}

function assertEmptyArrays(item, fields, { cold = false } = {}) {
  for (const field of fields) {
    // BaseItemMapper.Split('|') preserves the single empty Studios segment
    // produced by the native empty-list column; live constructors start at [].
    assert.deepEqual(item[field], cold && field === 'Studios' ? [''] : [], `${item.Type}.${field}`);
  }
}

async function assertEmptyFolder(fixture, item, options) {
  assertEmptyArrays(item, folderArrayFields, options);
  assert.equal(await fixture.linkedChildren.count(item.LinkedChildren), 0n, `${item.Type}.LinkedChildren`);
}

async function storedRow(database, Id) {
  const rows = await database.rows('BaseItems', { where: { Id } });
  assert.equal(rows.length, 1, `one BaseItems row for ${Id}`);
  return rows[0];
}

async function ancestorIds(database, Id) {
  return new Set((await database.rows('AncestorIds', { where: { ItemId: Id } }))
    .map(row => idKey(row.ParentItemId)));
}

async function coldLookup(creator, live) {
  creator.unregisterItem(live.Id);
  const cold = await creator.getItemById(live.Id);
  assert.ok(cold, `cold lookup for ${live.Type}`);
  assert.notEqual(cold, live);
  return cold;
}

async function validateSingle(library, parent, expectedId) {
  const result = await library.validateChildren(parent);
  assert.equal(result.created.length, 1);
  assert.equal(result.resolved.length, 1);
  assert.equal(idKey(result.created[0].Id), idKey(expectedId));
  return result.created[0];
}

async function typedValidationFixture(t, dialect, collectionType, resolver) {
  const fixture = await setupChildrenFixture(t, dialect);
  fixture.configuration.EnableCaseSensitiveItemIds = false;
  const physicalPath = path.join(fixture.stateRoot, `${collectionType}-library`);
  fixture.vfs.mount({
    path: '/typed-validation',
    instanceId: 'fixture',
    capabilities: { create: true, replace: true, mkdir: true, delete: true }
  });
  fixture.identityMap.addPrefix({
    identityRoot: physicalPath,
    accessRoot: '/typed-validation/library',
    style: 'windows',
    returnAccess: 'isolated typed folder-validation media'
  });
  await fixture.adapter.mkdir('/library');
  await prepareIgnoreFileFixture(fixture);
  await fixture.seed({
    target: 'physical',
    items: [
      {
        key: 'aggregate', type: 'AggregateFolder', Id: ids.aggregate,
        Name: 'Aggregate', Path: null
      },
      {
        key: 'userRoot', type: 'UserRootFolder', Id: ids.userRoot,
        Name: 'User root', Path: null
      },
      {
        key: 'collection', type: 'CollectionFolder', Id: ids.collection,
        Name: `${collectionType} collection`,
        Path: path.join(fixture.stateRoot, 'root', 'collections', collectionType),
        parent: 'userRoot',
        CollectionType: collectionType,
        PhysicalFolderIds: [ids.physical],
        PhysicalLocationsList: [physicalPath]
      },
      {
        key: 'physical', type: 'Folder', Id: ids.physical,
        Name: `${collectionType} physical root`, Path: physicalPath,
        parent: 'aggregate', TopParentId: ids.physical
      }
    ]
  });

  const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  ...fixture, ignoreRule: fixture.ignoreRule });
  fixture.loadContext = fixture.host.loadContext = loadContext;
  const creator = new ItemCreationService({ ...fixture, loadContext });
  fixture.library.itemCreation = creator;
  t.after(() => creator.close());
  const resolverPipeline = new DirectoryItemResolverPipeline({
    resolvers: [resolver],
    programDataPath: fixture.stateRoot,
    configuration: fixture.configuration
  });
  const validation = new FolderValidationService({
    scheduler: new LibraryTaskScheduler({ configuration: fixture.configuration }),
    store: fixture.store,
    library: fixture.library,
    itemCreation: creator,
    resolvedItemLifecycle: new ResolvedItemLifecycleHost({ store: fixture.store, loadContext,
      updates: fixture.host.updates, images: fixture.host.images }),
    vfs: fixture.vfs,
    identityMap: fixture.identityMap,
    ignoreRule: fixture.ignoreRule,
    resolverPipeline,
    loadContext,
    programDataPath: fixture.stateRoot,
    configurationDirectoryPath: path.join(fixture.stateRoot, 'config'),
    refreshes: new ProviderRefreshService(),
    linkedChildReferences: { reroute: async () => [] },
    metadataScanner: {
      async refreshAccessibleChildren() {},
      async refreshContainer() {}
    },
    clock: () => new Date(fixture.now)
  });
  fixture.library.folderValidation = validation;
  const events = [];
  fixture.library.on('ItemAdded', event => events.push({
    Id: event.Item.Id,
    ParentId: event.Parent?.Id ?? null
  }));
  return {
    ...fixture,
    creator,
    events,
    physicalPath,
    root: await fixture.library.getItemRecord(ids.physical)
  };
}

for (const dialect of ['postgres']) test(
  `${dialect}: nonrecursive folder validation creates and cold-hydrates a typed TV hierarchy`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, dialect, 'tvshows', createTvItemResolver());
    const seriesPath = path.join(fixture.physicalPath, 'Typed Show (2024)');
    const seasonPath = path.join(seriesPath, 'Season 01');
    const episodePath = path.join(seasonPath, 'Typed.Show.S01E02.mkv');
    await ensureFixtureDirectory(fixture, '/typed-validation/library/Typed Show (2024)/Season 01');
    await fixture.vfs.write('/typed-validation/library/Typed Show (2024)/Season 01/Typed.Show.S01E02.mkv',
      Buffer.from('typed episode'), { modified: '2026-10-07T01:02:03.0000000Z' });

    const expectedSeriesId = expectedItemId(fixture, seriesPath, seriesNativeType);
    const expectedSeasonId = expectedItemId(fixture, seasonPath, seasonNativeType);
    const expectedEpisodeId = expectedItemId(fixture, episodePath, episodeNativeType);

    const liveSeries = await validateSingle(fixture.library, fixture.root, expectedSeriesId);
    assert.deepEqual({
      NativeType: liveSeries.NativeType,
      Type: liveSeries.Type,
      Name: liveSeries.Name,
      Path: liveSeries.Path,
      ParentId: liveSeries.ParentId,
      TopParentId: repositoryTopParentId(liveSeries),
      ProductionYear: liveSeries.ProductionYear,
      IsFolder: liveSeries.IsFolder
    }, {
      NativeType: seriesNativeType,
      Type: 'Series',
      Name: 'Typed Show',
      Path: seriesPath,
      ParentId: ids.physical,
      TopParentId: ids.physical,
      ProductionYear: 2024,
      IsFolder: true
    });
    await assertEmptyFolder(fixture, liveSeries);
    assert.deepEqual(liveSeries.AirDays, []);
    const series = await coldLookup(fixture.creator, liveSeries);
    await assertEmptyFolder(fixture, series, { cold: true });
    assert.deepEqual(series.AirDays, []);

    const liveSeason = await validateSingle(fixture.library, series, expectedSeasonId);
    assert.deepEqual({
      NativeType: liveSeason.NativeType,
      Type: liveSeason.Type,
      Name: liveSeason.Name,
      Path: liveSeason.Path,
      ParentId: liveSeason.ParentId,
      TopParentId: repositoryTopParentId(liveSeason),
      SeriesId: liveSeason.SeriesId,
      SeriesName: liveSeason.SeriesName,
      SeriesPresentationUniqueKey: liveSeason.SeriesPresentationUniqueKey,
      IndexNumber: liveSeason.IndexNumber,
      IsFolder: liveSeason.IsFolder
    }, {
      NativeType: seasonNativeType,
      Type: 'Season',
      Name: 'Season 01',
      Path: seasonPath,
      ParentId: expectedSeriesId,
      TopParentId: ids.physical,
      SeriesId: expectedSeriesId,
      SeriesName: 'Typed Show',
      SeriesPresentationUniqueKey: null,
      IndexNumber: 1,
      IsFolder: true
    });
    await assertEmptyFolder(fixture, liveSeason);
    assert.equal((await storedRow(fixture.database, expectedSeasonId)).Data, null);
    const season = await coldLookup(fixture.creator, liveSeason);
    await assertEmptyFolder(fixture, season, { cold: true });
    assert.equal(idKey(season.SeriesId), idKey(expectedSeriesId));
    assert.equal(season.SeriesName, 'Typed Show');

    const liveEpisode = await validateSingle(fixture.library, season, expectedEpisodeId);
    assert.deepEqual({
      NativeType: liveEpisode.NativeType,
      Type: liveEpisode.Type,
      Name: liveEpisode.Name,
      Path: liveEpisode.Path,
      ParentId: liveEpisode.ParentId,
      TopParentId: repositoryTopParentId(liveEpisode),
      SeriesId: liveEpisode.SeriesId,
      SeriesName: liveEpisode.SeriesName,
      SeasonId: liveEpisode.SeasonId,
      SeasonName: liveEpisode.SeasonName,
      IndexNumber: liveEpisode.IndexNumber,
      ParentIndexNumber: liveEpisode.ParentIndexNumber,
      VideoType: liveEpisode.VideoType,
      IsFolder: liveEpisode.IsFolder
    }, {
      NativeType: episodeNativeType,
      Type: 'Episode',
      Name: 'Typed.Show.S01E02',
      Path: episodePath,
      ParentId: expectedSeasonId,
      TopParentId: ids.physical,
      SeriesId: expectedSeriesId,
      SeriesName: 'Typed Show',
      SeasonId: expectedSeasonId,
      SeasonName: 'Season 01',
      IndexNumber: 2,
      ParentIndexNumber: 1,
      VideoType: 'VideoFile',
      IsFolder: false
    });
    assertEmptyArrays(liveEpisode, videoArrayFields);
    const episode = await coldLookup(fixture.creator, liveEpisode);
    assertEmptyArrays(episode, videoArrayFields, { cold: true });
    assert.equal(idKey(episode.SeriesId), idKey(expectedSeriesId));
    assert.equal(idKey(episode.SeasonId), idKey(expectedSeasonId));

    assert.deepEqual(await ancestorIds(fixture.database, expectedSeriesId),
      new Set([ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(await ancestorIds(fixture.database, expectedSeasonId),
      new Set([expectedSeriesId, ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(await ancestorIds(fixture.database, expectedEpisodeId),
      new Set([expectedSeasonId, expectedSeriesId, ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(fixture.events.map(event => ({
      Id: idKey(event.Id), ParentId: idKey(event.ParentId)
    })), [
      { Id: idKey(expectedSeriesId), ParentId: idKey(ids.physical) },
      { Id: idKey(expectedSeasonId), ParentId: idKey(expectedSeriesId) },
      { Id: idKey(expectedEpisodeId), ParentId: idKey(expectedSeasonId) }
    ]);
  }
);

for (const dialect of ['postgres']) test(
  `${dialect}: nonrecursive folder validation creates and cold-hydrates a typed music hierarchy`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, dialect, 'music', createAudioItemResolver());
    const artistPath = path.join(fixture.physicalPath, 'Typed Artist');
    const albumPath = path.join(artistPath, 'Typed Album');
    const audioPath = path.join(albumPath, '01 Typed Track.mp3');
    await ensureFixtureDirectory(fixture, '/typed-validation/library/Typed Artist/Typed Album');
    await fixture.vfs.write('/typed-validation/library/Typed Artist/Typed Album/01 Typed Track.mp3',
      Buffer.from('typed audio'), { modified: '2026-10-07T01:02:03.0000000Z' });

    const expectedArtistId = expectedItemId(fixture, artistPath, musicArtistNativeType);
    const expectedAlbumId = expectedItemId(fixture, albumPath, musicAlbumNativeType);
    const expectedAudioId = expectedItemId(fixture, audioPath, audioNativeType);

    const liveArtist = await validateSingle(fixture.library, fixture.root, expectedArtistId);
    assert.deepEqual({
      NativeType: liveArtist.NativeType,
      Type: liveArtist.Type,
      Name: liveArtist.Name,
      Path: liveArtist.Path,
      ParentId: liveArtist.ParentId,
      TopParentId: repositoryTopParentId(liveArtist),
      IsFolder: liveArtist.IsFolder,
      IsAccessedByName: liveArtist.IsAccessedByName
    }, {
      NativeType: musicArtistNativeType,
      Type: 'MusicArtist',
      Name: 'Typed Artist',
      Path: artistPath,
      ParentId: ids.physical,
      TopParentId: ids.physical,
      IsFolder: true,
      IsAccessedByName: false
    });
    await assertEmptyFolder(fixture, liveArtist);
    assert.equal((await storedRow(fixture.database, expectedArtistId)).Data, null);
    const artist = await coldLookup(fixture.creator, liveArtist);
    await assertEmptyFolder(fixture, artist, { cold: true });
    assert.equal(artist.IsFolder, true);
    assert.equal(artist.IsAccessedByName, false);

    const liveAlbum = await validateSingle(fixture.library, artist, expectedAlbumId);
    assert.deepEqual({
      NativeType: liveAlbum.NativeType,
      Type: liveAlbum.Type,
      Name: liveAlbum.Name,
      Path: liveAlbum.Path,
      ParentId: liveAlbum.ParentId,
      TopParentId: repositoryTopParentId(liveAlbum),
      IsFolder: liveAlbum.IsFolder,
      Artists: liveAlbum.Artists,
      AlbumArtists: liveAlbum.AlbumArtists
    }, {
      NativeType: musicAlbumNativeType,
      Type: 'MusicAlbum',
      Name: 'Typed Album',
      Path: albumPath,
      ParentId: expectedArtistId,
      TopParentId: ids.physical,
      IsFolder: true,
      Artists: [],
      AlbumArtists: []
    });
    await assertEmptyFolder(fixture, liveAlbum);
    assert.equal((await storedRow(fixture.database, expectedAlbumId)).Data, null);
    const album = await coldLookup(fixture.creator, liveAlbum);
    await assertEmptyFolder(fixture, album, { cold: true });
    assert.deepEqual(album.Artists, []);
    assert.deepEqual(album.AlbumArtists, []);

    const liveAudio = await validateSingle(fixture.library, album, expectedAudioId);
    assert.deepEqual({
      NativeType: liveAudio.NativeType,
      Type: liveAudio.Type,
      Name: liveAudio.Name,
      Path: liveAudio.Path,
      ParentId: liveAudio.ParentId,
      TopParentId: repositoryTopParentId(liveAudio),
      MediaType: liveAudio.MediaType,
      IsInMixedFolder: liveAudio.IsInMixedFolder,
      IsFolder: liveAudio.IsFolder,
      Artists: liveAudio.Artists,
      AlbumArtists: liveAudio.AlbumArtists,
      LyricFiles: liveAudio.LyricFiles
    }, {
      NativeType: audioNativeType,
      Type: 'Audio',
      Name: '01 Typed Track',
      Path: audioPath,
      ParentId: expectedAlbumId,
      TopParentId: ids.physical,
      MediaType: 'Audio',
      IsInMixedFolder: true,
      IsFolder: false,
      Artists: [],
      AlbumArtists: [],
      LyricFiles: []
    });
    assertEmptyArrays(liveAudio, commonArrayFields);
    const audio = await coldLookup(fixture.creator, liveAudio);
    assertEmptyArrays(audio, commonArrayFields, { cold: true });
    assert.deepEqual(audio.Artists, []);
    assert.deepEqual(audio.AlbumArtists, []);
    assert.deepEqual(audio.LyricFiles, []);

    assert.deepEqual(await ancestorIds(fixture.database, expectedArtistId),
      new Set([ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(await ancestorIds(fixture.database, expectedAlbumId),
      new Set([expectedArtistId, ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(await ancestorIds(fixture.database, expectedAudioId),
      new Set([expectedAlbumId, expectedArtistId, ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.deepEqual(fixture.events.map(event => ({
      Id: idKey(event.Id), ParentId: idKey(event.ParentId)
    })), [
      { Id: idKey(expectedArtistId), ParentId: idKey(ids.physical) },
      { Id: idKey(expectedAlbumId), ParentId: idKey(expectedArtistId) },
      { Id: idKey(expectedAudioId), ParentId: idKey(expectedAlbumId) }
    ]);
  }
);
