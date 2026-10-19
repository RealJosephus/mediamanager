import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { FolderValidationService } from '../../src/library/folder-validation-service.js';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { LibraryMetadataScanService } from '../../src/library/metadata-scan-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ResolvedItemLifecycleHost } from '../../src/library/resolved-item-lifecycle.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import {
  createTvItemResolver,
  episodeNativeType,
  seasonNativeType,
  seriesNativeType
} from '../../src/library/tv-item-resolver.js';
import { createVideoFileResolver, trailerNativeType, videoNativeType } from '../../src/library/video-file-resolver.js';
import {
  audioNativeType,
  createAudioItemResolver,
  musicAlbumNativeType,
  musicArtistNativeType
} from '../../src/library/audio-item-resolver.js';
import { dateText, idKey, nonemptyId, repositoryTopParentId } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { ensureFixtureDirectory, prepareIgnoreFileFixture } from './ignore-file-fixture.js';
import { fixturePathStyle } from './fixture-state-path.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';

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

async function typedValidationFixture(t, dialect, collectionType, resolver, { metadata = false } = {}) {
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
    style: fixturePathStyle,
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
        Path: path.join(fixture.stateRoot, 'root', 'collections', String(collectionType)),
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

  const loadContext = fixture.trackContextLoader(createMetadataContextLoader({fileSystem: testFileSystem, ...fixture, ignoreRule: fixture.ignoreRule }));
  fixture.loadContext = fixture.host.loadContext = loadContext;
  const creator = new ItemCreationService({ ...fixture, loadContext });
  fixture.library.itemCreation = creator;
  fixture.host.seriesLifecycle.loadContext = loadContext;
  fixture.host.seriesLifecycle.itemCreation = creator;
  t.after(() => creator.close());
  const resolverPipeline = new DirectoryItemResolverPipeline({
    resolvers: Array.isArray(resolver) ? resolver : [resolver],
    programDataPath: fixture.stateRoot,
    configuration: fixture.configuration
  });
  const errors = [];
  fixture.configuration.LibraryScanFanoutConcurrency = 1;
  const scheduler = new LibraryTaskScheduler({ configuration: fixture.configuration, onError: error => errors.push(error) });
  t.after(() => scheduler.close());
  const metadataScanner = metadata ? new LibraryMetadataScanService({ library: fixture.library,
    metadata: fixture.host, configuration: fixture.configuration, scheduler,
    logger: { error: error => errors.push(error) } }) : {
    async refreshAccessibleChildren() {}, async refreshContainer() {}
  };
  const validation = new FolderValidationService({
    scheduler,
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
    metadataScanner,
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
    errors,
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
      Name: 'Season 1',
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
      SeasonName: 'Season 1',
      IndexNumber: null,
      ParentIndexNumber: null,
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

test('postgres: ordinary TV scan refreshes special, range, date, flat and nested episodes and survives a cold repeat',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, 'postgres', 'tvshows', createTvItemResolver(), { metadata: true });
    const show = 'Ordinary Show (2024) [tvdbid=123]';
    const seriesPath = path.join(fixture.physicalPath, show);
    const specialPath = path.join(seriesPath, 'Specials'), numberedPath = path.join(seriesPath, '1');
    const unnumberedPath = path.join(seriesPath, 'Unnumbered');
    const files = [
      ['Specials/Show.S00E01 [tvdbid=789].mkv', 0, 1, null],
      ['1/Show.S01E02-E03.1080p.mkv', 1, 2, 3],
      ['1/Show.2026-01-02.mkv', 1, null, null],
      ['Show.S02E04.1080p.mkv', 2, 4, null],
      ['Unnumbered/Unnumbered.mkv', null, null, null],
      ['Unnumbered/Nested/Unnumbered.mkv', null, null, null],
      ['Show.S01E05/video.mkv', 1, 5, null]
    ];
    for (const [relative] of files) {
      const accessPath = `/typed-validation/library/${show}/${relative}`;
      await ensureFixtureDirectory(fixture, path.posix.dirname(accessPath));
      await fixture.vfs.write(accessPath, Buffer.from('ordinary TV filename fixture'), {
        modified: '2026-10-04T01:02:03.0000000Z'
      });
    }
    await ensureFixtureDirectory(fixture, `/typed-validation/library/${show}/Empty`);
    const rootFile = 'Root.Show.S03E05.mkv';
    const rootEpisodePath = path.join(fixture.physicalPath, rootFile);
    const rootEpisodeId = expectedItemId(fixture, rootEpisodePath, episodeNativeType);
    await fixture.vfs.write(`/typed-validation/library/${rootFile}`, Buffer.from('root TV filename fixture'), {
      modified: '2026-10-04T01:02:03.0000000Z'
    });
    const scan = () => fixture.library.validateChildren(fixture.root, {
      recursive: true, refreshChildMetadata: true, ImageRefreshMode: 'None'
    });
    await scan();
    assert.deepEqual(fixture.errors, []);
    const seriesId = expectedItemId(fixture, seriesPath, seriesNativeType);
    const specialId = expectedItemId(fixture, specialPath, seasonNativeType);
    const numberedId = expectedItemId(fixture, numberedPath, seasonNativeType);
    const unnumberedId = expectedItemId(fixture, unnumberedPath, seasonNativeType);
    const virtual = (await fixture.database.rows('BaseItems')).filter(row => row.Type === seasonNativeType
      && idKey(row.SeriesId) === idKey(seriesId) && row.Path == null);
    assert.equal(virtual.length, 1);
    assert.equal(virtual[0].IndexNumber, 2);
    assert.equal(idKey(virtual[0].ParentId), idKey(seriesId));
    const cold = async id => {
      fixture.creator.unregisterItem(id);
      const item = await fixture.creator.getItemById(id);
      assert.ok(item); return item;
    };
    const series = await cold(seriesId), special = await cold(specialId), numbered = await cold(numberedId);
    assert.equal(series.ProviderIds.Tvdb, '123');
    assert.equal(special.IndexNumber, 0); assert.equal(special.Name, 'Specials');
    assert.equal(numbered.IndexNumber, 1);
    const unnumbered = await cold(unnumberedId);
    assert.equal(unnumbered.IndexNumber, null); assert.equal(unnumbered.Name, 'Unnumbered');
    assert.equal(unnumbered.Path, unnumberedPath);
    const physicalParents = new Map([[seriesPath, seriesId], [specialPath, specialId],
      [numberedPath, numberedId], [unnumberedPath, unnumberedId]]);
    for (const [relative, parentId] of [['Unnumbered/Nested', unnumberedId], ['Show.S01E05', seriesId], ['Empty', seriesId]]) {
      const folderPath = path.join(seriesPath, ...relative.split('/'));
      const folderId = expectedItemId(fixture, folderPath, 'MediaBrowser.Controller.Entities.Folder');
      const folder = await cold(folderId);
      assert.equal(folder.Type, 'Folder'); assert.equal(folder.Path, folderPath);
      assert.equal(idKey(folder.ParentId), idKey(parentId));
      physicalParents.set(folderPath, folderId);
    }
    const observed = [];
    for (const [relative, seasonNumber, episodeNumber, end] of files) {
      const filename = path.join(seriesPath, ...relative.split('/'));
      const item = await cold(expectedItemId(fixture, filename, episodeNativeType));
      const physicalParentId = physicalParents.get(path.dirname(filename));
      const displaySeasonId = seasonNumber == null ? unnumberedId
        : seasonNumber === 0 ? specialId : seasonNumber === 1 ? numberedId : virtual[0].Id;
      assert.equal(item.Path, filename);
      assert.equal(idKey(item.ParentId), idKey(physicalParentId));
      assert.equal(idKey(item.SeriesId), idKey(seriesId));
      assert.equal(idKey(item.SeasonId), idKey(displaySeasonId));
      assert.equal(item.ParentIndexNumber, seasonNumber);
      assert.equal(item.IndexNumber, episodeNumber); assert.equal(item.IndexNumberEnd, end);
      const folders = relative.split('/').slice(0, -1);
      assert.deepEqual(await ancestorIds(fixture.database, item.Id), new Set([
        ...folders.map((_, index) => physicalParents.get(path.join(seriesPath, ...folders.slice(0, index + 1)))),
        displaySeasonId, seriesId, ids.physical, ids.aggregate, ids.collection
      ].map(idKey)));
      if (relative.includes('2026-01-02')) {
        // Filename dates are local calendar dates. SQL native dates hold UTC
        // without a suffix, so normalize that representation before parsing.
        assert.equal(Date.parse(dateText(item.PremiereDate)), new Date(2026, 0, 2).getTime());
        assert.equal(item.ProductionYear, 2026);
      }
      if (relative.includes('tvdbid')) assert.equal(item.ProviderIds.Tvdb, '789');
      observed.push({ Id: item.Id, ParentId: item.ParentId, SeriesId: item.SeriesId, SeasonId: item.SeasonId,
        IndexNumber: item.IndexNumber, IndexNumberEnd: item.IndexNumberEnd,
        ParentIndexNumber: item.ParentIndexNumber, PremiereDate: item.PremiereDate });
    }
    const rootEpisode = await cold(rootEpisodeId);
    assert.equal(rootEpisode.Path, rootEpisodePath);
    assert.equal(idKey(rootEpisode.ParentId), idKey(ids.physical));
    assert.equal(idKey(repositoryTopParentId(rootEpisode)), idKey(ids.physical));
    assert.equal(nonemptyId(rootEpisode.SeriesId), false);
    assert.equal(nonemptyId(rootEpisode.SeasonId), false);
    assert.equal(rootEpisode.ParentIndexNumber, 3);
    assert.equal(rootEpisode.IndexNumber, 5);
    assert.deepEqual(await ancestorIds(fixture.database, rootEpisodeId),
      new Set([ids.physical, ids.aggregate, ids.collection].map(idKey)));
    assert.equal((await fixture.database.rows('BaseItems', { where: { Type: seriesNativeType } })).length, 1);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Type: seasonNativeType } })).length, 4);
    observed.push({ Id: rootEpisode.Id, ParentId: rootEpisode.ParentId, SeriesId: rootEpisode.SeriesId,
      SeasonId: rootEpisode.SeasonId, ParentIndexNumber: rootEpisode.ParentIndexNumber,
      IndexNumber: rootEpisode.IndexNumber });
    const count = (await fixture.database.rows('BaseItems')).length;
    await scan();
    assert.deepEqual(fixture.errors, []);
    assert.equal((await fixture.database.rows('BaseItems')).length, count, 'repeat scan does not duplicate the synthetic season');
    for (const before of observed) {
      const item = await cold(before.Id);
      assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, item[key]])), before);
    }
  });

test('postgres: an untyped library discovers Series and refreshes their flat and nested Episodes through a cold repeat',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, 'postgres', null,
      [createTvItemResolver(), createVideoFileResolver()], { metadata: true });
    const markerShow = 'Marker Show [tvdbid=123]', seasonShow = 'Season Show';
    const files = [
      [`${markerShow}/Show.S01E02.mkv`, markerShow, 1, 2],
      [`${seasonShow}/Season 2/Show.S02E03.mkv`, seasonShow, 2, 3],
      [`${seasonShow}/Season 2/Archive/Show.S02E04.mkv`, seasonShow, 2, 4]
    ];
    for (const [relative] of files) {
      const accessPath = '/typed-validation/library/' + relative;
      await ensureFixtureDirectory(fixture, path.posix.dirname(accessPath));
      await fixture.vfs.write(accessPath, Buffer.from('untyped TV filename fixture'), {
        modified: '2026-10-04T01:02:03.0000000Z'
      });
    }
    await fixture.vfs.write(`/typed-validation/library/${markerShow}/tvshow.nfo`, Buffer.from('<tvshow/>'));
    const scan = () => fixture.library.validateChildren(fixture.root, {
      recursive: true, refreshChildMetadata: true, ImageRefreshMode: 'None'
    });
    await scan();
    assert.deepEqual(fixture.errors, []);
    const cold = async Id => {
      fixture.creator.unregisterItem(Id);
      const item = await fixture.creator.getItemById(Id);
      assert.ok(item); return item;
    };
    const markerSeriesId = expectedItemId(fixture, path.join(fixture.physicalPath, markerShow), seriesNativeType);
    const seasonalSeriesId = expectedItemId(fixture, path.join(fixture.physicalPath, seasonShow), seriesNativeType);
    const seriesByName = new Map([[markerShow, markerSeriesId], [seasonShow, seasonalSeriesId]]);
    for (const [name, Id] of seriesByName) {
      const item = await cold(Id);
      assert.equal(item.Type, 'Series');
      assert.equal(item.Path, path.join(fixture.physicalPath, name));
      assert.equal(idKey(item.ParentId), idKey(ids.physical));
    }
    assert.equal((await cold(markerSeriesId)).ProviderIds.Tvdb, '123');
    const seasonId = expectedItemId(fixture, path.join(fixture.physicalPath, seasonShow, 'Season 2'), seasonNativeType);
    const season = await cold(seasonId);
    assert.equal(season.IndexNumber, 2);
    assert.equal(idKey(season.SeriesId), idKey(seasonalSeriesId));
    const archivePath = path.join(season.Path, 'Archive');
    const archiveId = expectedItemId(fixture, archivePath, 'MediaBrowser.Controller.Entities.Folder');
    const archive = await cold(archiveId);
    assert.equal(archive.Type, 'Folder'); assert.equal(archive.Path, archivePath);
    assert.equal(idKey(archive.ParentId), idKey(seasonId));
    const virtual = (await fixture.database.rows('BaseItems', { where: { Type: seasonNativeType } }))
      .filter(row => idKey(row.SeriesId) === idKey(markerSeriesId) && row.Path == null);
    assert.equal(virtual.length, 1); assert.equal(virtual[0].IndexNumber, 1);
    const observed = [];
    for (const [relative, show, seasonNumber, episodeNumber] of files) {
      const filename = path.join(fixture.physicalPath, ...relative.split('/'));
      const item = await cold(expectedItemId(fixture, filename, episodeNativeType));
      const seriesId = seriesByName.get(show);
      const displaySeasonId = show === markerShow ? virtual[0].Id : seasonId;
      const parentId = show === markerShow ? seriesId : relative.includes('/Archive/') ? archiveId : seasonId;
      assert.equal(item.Type, 'Episode'); assert.equal(item.Path, filename);
      assert.equal(idKey(item.ParentId), idKey(parentId));
      assert.equal(idKey(item.SeriesId), idKey(seriesId));
      assert.equal(idKey(item.SeasonId), idKey(displaySeasonId));
      assert.equal(item.ParentIndexNumber, seasonNumber); assert.equal(item.IndexNumber, episodeNumber);
      assert.deepEqual(await ancestorIds(fixture.database, item.Id), new Set([
        parentId, displaySeasonId, seriesId, ids.physical, ids.aggregate, ids.collection
      ].map(idKey)));
      observed.push({ Id: item.Id, ParentId: item.ParentId, SeriesId: item.SeriesId,
        SeasonId: item.SeasonId, ParentIndexNumber: item.ParentIndexNumber, IndexNumber: item.IndexNumber });
    }
    const rows = await fixture.database.rows('BaseItems');
    assert.equal(rows.filter(row => row.Type === seriesNativeType).length, 2);
    assert.equal(rows.filter(row => row.Type === episodeNativeType).length, 3);
    await scan();
    assert.deepEqual(fixture.errors, []);
    assert.equal((await fixture.database.rows('BaseItems')).length, rows.length);
    for (const before of observed) {
      const item = await cold(before.Id);
      assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, item[key]])), before);
    }
  });

test('postgres: TV versions and stacked parts retain their concrete types and episode relationships through cold repeat scans',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, 'postgres', 'tvshows',
      [createTvItemResolver(), createVideoFileResolver()], { metadata: true });
    const show = 'Versioned Show', season = 'Season 01';
    const seriesPath = path.join(fixture.physicalPath, show), seasonPath = path.join(seriesPath, season);
    const seriesId = expectedItemId(fixture, seriesPath, seriesNativeType);
    const seasonId = expectedItemId(fixture, seasonPath, seasonNativeType);
    const filenames = [
      'Show.S01E01 - 1080p cd1.mkv', 'Show.S01E01 - 1080p cd2.mkv',
      'Show.S01E01 - 720p cd1.mkv', 'Show.S01E02.mkv', 'Show.S01E01 - 720p cd2.mkv'
    ];
    const [primaryPath, partPath, alternatePath, secondPath, alternatePartPath] = filenames.map(name => path.join(seasonPath, name));
    const primaryId = expectedItemId(fixture, primaryPath, episodeNativeType);
    const alternateId = expectedItemId(fixture, alternatePath, episodeNativeType);
    const secondId = expectedItemId(fixture, secondPath, episodeNativeType);
    const partId = expectedItemId(fixture, partPath, videoNativeType);
    const alternatePartId = expectedItemId(fixture, alternatePartPath, videoNativeType);
    const directory = `/typed-validation/library/${show}/${season}`;
    await ensureFixtureDirectory(fixture, directory);
    // This existing host runs real TV metadata and ownership lifecycles with
    // filename inputs. Media probing has its separate real-media consumers.
    for (const filename of filenames) await fixture.vfs.write(`${directory}/${filename}`,
      Buffer.from(`TV version fixture: ${filename}`), { modified: '2026-10-04T01:02:03.0000000Z' });
    const extraFilename = 'Show.S01E02.trailer.strm';
    await fixture.vfs.write(`${directory}/${extraFilename}`, Buffer.from('https://media.invalid/season-trailer'));
    const cold = async id => {
      fixture.creator.unregisterItem(id);
      const item = await fixture.creator.getItemById(id);
      assert.ok(item, `persisted item ${id}`);
      return item;
    };
    let count;
    for (let pass = 0; pass < 2; pass++) {
      await fixture.library.validateChildren(fixture.root, {
        recursive: true, refreshChildMetadata: true, ImageRefreshMode: 'None'
      });
      assert.deepEqual(fixture.errors, []);
      const series = await cold(seriesId), physicalSeason = await cold(seasonId);
      assert.equal(series.Type, 'Series'); assert.equal(series.Path, seriesPath);
      assert.equal(physicalSeason.Type, 'Season'); assert.equal(physicalSeason.Path, seasonPath);
      assert.equal(idKey(physicalSeason.ParentId), idKey(seriesId));
      const episodes = new Map();
      for (const [id, filename, number] of [
        [primaryId, primaryPath, 1], [alternateId, alternatePath, 1], [secondId, secondPath, 2]
      ]) {
        const episode = await cold(id);
        episodes.set(idKey(id), episode);
        assert.equal(episode.Type, 'Episode'); assert.equal(episode.Path, filename);
        assert.equal(idKey(episode.ParentId), idKey(seasonId));
        assert.equal(idKey(episode.SeriesId), idKey(seriesId));
        assert.equal(idKey(episode.SeasonId), idKey(seasonId));
        assert.equal(episode.ParentIndexNumber, 1); assert.equal(episode.IndexNumber, number);
        assert.deepEqual(await ancestorIds(fixture.database, id),
          new Set([seasonId, seriesId, ids.physical, ids.aggregate, ids.collection].map(idKey)));
      }
      const primary = episodes.get(idKey(primaryId)), alternate = episodes.get(idKey(alternateId));
      assert.deepEqual(primary.LocalAlternateVersions, [alternatePath]);
      assert.deepEqual(primary.AdditionalParts, [partPath]);
      assert.ok(!nonemptyId(primary.PrimaryVersionId));
      assert.equal(idKey(alternate.PrimaryVersionId), idKey(primaryId));
      assert.equal(idKey(alternate.OwnerId), idKey(primaryId));
      assert.deepEqual(alternate.AdditionalParts, [alternatePartPath]);
      const second = episodes.get(idKey(secondId));
      assert.ok(!nonemptyId(second.PrimaryVersionId));
      assert.deepEqual(second.LocalAlternateVersions, []);
      assert.deepEqual(second.AdditionalParts, []);
      const links = await fixture.database.rows('LinkedChildren', { where: { ParentId: primaryId } });
      assert.deepEqual(links.filter(link => Number(link.ChildType) === 2).map(link => idKey(link.ChildId)), [idKey(alternateId)]);
      for (const [id, filename, ownerId] of [[partId, partPath, primaryId], [alternatePartId, alternatePartPath, alternateId]]) {
        const part = await cold(id);
        assert.equal(part.Type, 'Video'); assert.equal(part.Path, filename);
        assert.equal(idKey(part.OwnerId), idKey(ownerId));
        // RefreshMetadataForOwnedVideo coerces an Episode resolution to base
        // Video for a stack part; it is owned, not a second numbered Episode.
        assert.ok(!nonemptyId(part.ParentId));
        assert.equal((await fixture.database.rows('BaseItems', {
          where: { Id: expectedItemId(fixture, filename, episodeNativeType) }
        })).length, 0);
      }
      const rows = await fixture.database.rows('BaseItems');
      const extras = rows.filter(row => row.Path === path.join(seasonPath, extraFilename));
      assert.equal(extras.length, 1);
      assert.equal(extras[0].Type, trailerNativeType,
        'the Season metadata lifecycle owns the extra without creating another Episode');
      assert.equal(idKey(extras[0].OwnerId), idKey(seasonId));
      assert.ok(!nonemptyId(extras[0].ParentId));
      assert.equal((await cold(extras[0].Id)).IsShortcut, true);
      assert.deepEqual(new Set(rows.filter(row => row.Type === episodeNativeType).map(row => idKey(row.Id))),
        new Set([primaryId, alternateId, secondId].map(idKey)));
      if (pass === 0) count = rows.length;
      else assert.equal(rows.length, count, 'repeat scan preserves the same versions and owned part');
    }
  });

test('postgres: artist.nfo admits a physical Artist and refreshes its metadata through a cold repeat scan',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, 'postgres', 'music', createAudioItemResolver(), { metadata: true });
    fixture.registry.register(createNfoPlugin({ fileSystem: testFileSystem, vfs: fixture.vfs, spoolRoot: fixture.spoolRoot }));
    const artistPath = path.join(fixture.physicalPath, 'Marked Artist');
    const artistId = expectedItemId(fixture, artistPath, musicArtistNativeType);
    await ensureFixtureDirectory(fixture, '/typed-validation/library/Marked Artist');
    await fixture.vfs.write('/typed-validation/library/Marked Artist/artist.nfo', Buffer.from(
      '<artist><name>NFO Artist</name><biography>Artist metadata from the explicit sidecar.</biography>'
      + '<uniqueid type="musicbrainzartist">c3108e4d-9b93-4e73-a095-99fe2c6986f3</uniqueid></artist>'
    ), { modified: '2026-10-04T01:02:03.0000000Z' });
    for (let pass = 0; pass < 2; pass++) {
      await fixture.library.validateChildren(fixture.root, {
        recursive: true, refreshChildMetadata: true, ImageRefreshMode: 'None'
      });
      assert.deepEqual(fixture.errors, []);
      fixture.creator.unregisterItem(artistId);
      const artist = await fixture.creator.getItemById(artistId);
      assert.ok(artist);
      assert.equal(artist.Type, 'MusicArtist');
      assert.equal(artist.Path, artistPath);
      assert.equal(idKey(artist.ParentId), idKey(ids.physical));
      assert.equal(artist.IsFolder, true);
      assert.equal(artist.IsAccessedByName, false);
      assert.equal(artist.Name, 'NFO Artist');
      assert.equal(artist.Overview, 'Artist metadata from the explicit sidecar.');
      assert.equal(artist.ProviderIds.MusicBrainzArtist, 'c3108e4d-9b93-4e73-a095-99fe2c6986f3');
      const rows = await fixture.database.rows('BaseItems', { where: { Path: artistPath } });
      assert.equal(rows.length, 1);
      assert.equal(idKey(rows[0].Id), idKey(artistId));
      assert.equal((await fixture.database.rows('BaseItems', { where: { Type: musicAlbumNativeType } })).length, 0);
    }
  });

for (const grouped of [false, true]) test(`postgres: a multi-disc Album ${grouped ? 'inside Artist groups' : 'at the library root'} keeps its physical folders and AlbumId through cold repeat scans`,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const fixture = await typedValidationFixture(t, 'postgres', 'music', createAudioItemResolver(), { metadata: true });
    // This hierarchy fixture controls probe content. Admit Audio to the real
    // save/aggregation lifecycle; actual probing is covered by the HTTP scan.
    fixture.host.supportedItemTypes = [...fixture.host.supportedItemTypes, 'Audio'];
    const relativeAlbum = grouped ? 'Grouped Artist/Albums/Multi Disc Album' : 'Multi Disc Album';
    const albumPath = path.join(fixture.physicalPath, ...relativeAlbum.split('/'));
    const albumId = expectedItemId(fixture, albumPath, musicAlbumNativeType);
    const artistId = expectedItemId(fixture, path.join(fixture.physicalPath, 'Grouped Artist'), musicArtistNativeType);
    const groupId = expectedItemId(fixture, path.join(fixture.physicalPath, 'Grouped Artist', 'Albums'), 'MediaBrowser.Controller.Entities.Folder');
    const groupAncestors = grouped ? [groupId, artistId] : [];
    const tracks = [];
    for (const disc of ['CD1', 'CD2']) {
      const directory = `/typed-validation/library/${relativeAlbum}/${disc}`;
      await ensureFixtureDirectory(fixture, directory);
      await fixture.vfs.write(`${directory}/01 Track.flac`, Buffer.from('multi-disc hierarchy fixture'), {
        modified: '2026-10-04T01:02:03.0000000Z'
      });
      await fixture.vfs.write(`${directory}/disc.cue`, Buffer.from('FILE "01 Track.flac" WAVE'));
      const discPath = path.join(albumPath, disc), audioPath = path.join(discPath, '01 Track.flac');
      tracks.push({ discPath, audioPath, folderParentId: albumId, extraAncestors: [],
        discId: expectedItemId(fixture, discPath, 'MediaBrowser.Controller.Entities.Folder'),
        audioId: expectedItemId(fixture, audioPath, audioNativeType) });
    }
    if (grouped) {
      const directory = `/typed-validation/library/${relativeAlbum}/CD1/Archive`;
      await ensureFixtureDirectory(fixture, directory);
      await fixture.vfs.write(`${directory}/Bonus.flac`, Buffer.from('nested album track'), {
        modified: '2026-10-04T01:02:03.0000000Z'
      });
      const discPath = path.join(albumPath, 'CD1', 'Archive'), audioPath = path.join(discPath, 'Bonus.flac');
      tracks.push({ discPath, audioPath, folderParentId: tracks[0].discId, extraAncestors: [tracks[0].discId],
        discId: expectedItemId(fixture, discPath, 'MediaBrowser.Controller.Entities.Folder'),
        audioId: expectedItemId(fixture, audioPath, audioNativeType) });
    }
    let count;
    for (let pass = 0; pass < 2; pass++) {
      await fixture.library.validateChildren(fixture.root, {
        recursive: true, refreshChildMetadata: true, ImageRefreshMode: 'None'
      });
      assert.deepEqual(fixture.errors, []);
      const albums = await fixture.database.rows('BaseItems', { where: { Type: musicAlbumNativeType } });
      assert.equal((await fixture.database.rows('BaseItems')).some(item => /\.cue$/iu.test(item.Path ?? '')), false);
      assert.equal(albums.length, 1);
      assert.equal(idKey(albums[0].Id), idKey(albumId));
      assert.equal(idKey(albums[0].ParentId), idKey(grouped ? groupId : ids.physical));
      assert.equal((await fixture.database.rows('BaseItems', { where: { Type: musicArtistNativeType } })).length, grouped ? 1 : 0);
      if (grouped) {
        fixture.creator.unregisterItem(groupId);
        const group = await fixture.creator.getItemById(groupId);
        assert.equal(group.Type, 'Folder');
        assert.equal(idKey(group.ParentId), idKey(artistId));
      }
      for (const { discPath, discId, audioPath, audioId, folderParentId, extraAncestors } of tracks) {
        fixture.creator.unregisterItem(discId);
        fixture.creator.unregisterItem(audioId);
        const disc = await fixture.creator.getItemById(discId), audio = await fixture.creator.getItemById(audioId);
        assert.ok(disc); assert.ok(audio);
        assert.equal(disc.Type, 'Folder'); assert.equal(disc.Path, discPath);
        assert.equal(idKey(disc.ParentId), idKey(folderParentId));
        assert.equal(audio.Type, 'Audio'); assert.equal(audio.Path, audioPath);
        assert.equal(idKey(audio.ParentId), idKey(discId));
        assert.equal(idKey(repositoryTopParentId(audio)), idKey(ids.physical));
        assert.deepEqual(await ancestorIds(fixture.database, audioId),
          new Set([discId, ...extraAncestors, albumId, ...groupAncestors, ids.physical, ids.aggregate, ids.collection].map(idKey)));
        const dto = await fixture.library.getItemDto(audio, { EnableImages: false });
        assert.equal(idKey(dto.AlbumId), idKey(albumId));
      }
      const currentCount = (await fixture.database.rows('BaseItems')).length;
      if (pass === 0) count = currentCount;
      else assert.equal(currentCount, count, 'repeat scan preserves the physical hierarchy');
    }
  });

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
