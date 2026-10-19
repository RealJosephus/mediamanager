import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TmdbMissingEpisodeLifecycleHost } from '../../plugins/tmdb/missing-episode-lifecycle.js';
import { createTmdbMissingEpisodeProvider } from '../../plugins/tmdb/missing-episodes.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { SeriesMetadataLifecycleHost } from '../../src/metadata/series-lifecycle-host.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { cloneNativeItemEntity, isNativeItemEntity, newNativeItemEntity, acquireNativeItemLinkOwner, releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { setupChildrenFixture } from './children-fixture.js';

const ids = {
  series: 'B0000000-0000-0000-0000-000000000001',
  season: 'B0000000-0000-0000-0000-000000000002',
  episode: 'B0000000-0000-0000-0000-000000000003',
  newSeason: 'B0000000-0000-0000-0000-000000000004',
  newEpisode: 'B0000000-0000-0000-0000-000000000005',
};

const native = (type, values = {}) => Object.assign(newNativeItemEntity(`MediaBrowser.Controller.Entities.TV.${type}`), values);

function fixture({ refreshError, removeError, repositoryError } = {}) {
  const events = [], rows = new Map();
  const series = native('Series', { Id: ids.series, Name: 'Live Series', PresentationUniqueKey: 'live-key',
    ProviderIds: { Tmdb: '42' }, DisplayOrder: 'absolute' });
  const season = native('Season', { Id: ids.season, Name: 'Season 1', ParentId: series.Id, SeriesId: series.Id,
    IndexNumber: 1, ProviderIds: { Tmdb: '100' } });
  const episode = native('Episode', { Id: ids.episode, Name: 'Episode', ParentId: season.Id, SeasonId: season.Id,
    SeriesId: series.Id, ParentIndexNumber: 1, IndexNumber: 1, IsVirtualItem: true, ProviderIds: { Tmdb: '101' } });
  for (const item of [series, season, episode]) rows.set(item.Id, item);
  const loadContext = async (reference,{draft}={}) => {
    const source = rows.get(typeof reference === 'string' ? reference : reference.Id);
    if (!source) throw Object.assign(new Error('missing'), { status: 404 });
    const item = draft??cloneNativeItemEntity(source),owner=acquireNativeItemLinkOwner(item);
    item.IsFileProtocol = false;
    const loaded = {
      item,
      parent: item.Type === 'Episode' ? season : item.Type === 'Season' ? series : null,
      parents: item.Type === 'Episode' ? [season, series] : item.Type === 'Season' ? [series] : [],
      collectionFolders: state.collectionFolders,
      libraryOptions: state.libraryOptions,
      globalOptions: { PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US' },
      libraryRuntimeOptions: { marker: 'target-runtime-options' },
      context: { images: structuredClone(source.ImageInfos ?? []), collectionFolderIds: state.collectionFolders.map(folder=>folder.Id) },
      relationships: {}, versionLinks: [],
      lookup: { SeriesProviderIds: structuredClone(series.ProviderIds), SeasonProviderIds: structuredClone(season.ProviderIds) },
      lookupFor: value => ({ ProviderIds: structuredClone(value.ProviderIds), SeriesProviderIds: {}, SeasonProviderIds: {} }),
      refreshPreferredMetadata(value, preferred = {}) {
        value.MetadataLanguage = preferred.parents?.[0]?.PreferredMetadataLanguage
          ?? preferred.libraryOptions?.PreferredMetadataLanguage ?? 'stored';
        value.MetadataCountryCode = preferred.parents?.[0]?.PreferredMetadataCountryCode
          ?? preferred.libraryOptions?.MetadataCountryCode ?? 'stored';
      },
      getLocalAlternateVersionIds: async () => [],
      reloadMetadataContext: loadContext,
      async dispose(){owner.release();releaseNativeItemLinks(item);},
    };
    return loaded;
  };
  loadContext.linkedChildren={async flushReleases(){}};
  loadContext.withContext=async(reference,options,operation)=>{const loaded=await loadContext(reference,options);
    try{return await operation(loaded);}finally{await loaded.dispose();}};
  const updates = {
    registry: { discover: () => [] },
    async update(loaded, result, reason, options) {
      events.push(['repository', loaded, result, reason, options]);
      if (repositoryError) throw repositoryError;
      rows.set(result.Item.Id, cloneNativeItemEntity(result.Item));
      return [];
    },
  };
  const images = {
    async saveRemote(loaded, current, image, options) {
      events.push(['image', loaded, current, image, options]);
      current.push({ Type: image.Type, Path: '/metadata/still.jpg' });
    },
  };
  const itemCreation = {
    retainItem:acquireNativeItemLinkOwner,
    async createItems(items, parent, options) {
      events.push(['create', items, parent, options]);
      for (const item of items) rows.set(item.Id, item);
      return items;
    },
    async getItemById(value) { return rows.get(value) ?? null; },
    unregisterItem(value) { events.push(['unregister', value]); },
  };
  const seriesLifecycle = {
    load: async () => ({ marker: 'loaded' }),
    async remove(item) {
      events.push(['remove', item.Id]);
      if (removeError) throw removeError;
      itemCreation.unregisterItem(item.Id);
    },
  };
  const refreshSeason = async (child, parent, options) => {
    events.push(['refresh-season', child, parent, options]);
    if (refreshError) throw refreshError;
    child.ProviderIds = { Tmdb: 'season-remote' };
    rows.set(child.Id, child);
  };
  const lifecycle = new TmdbMissingEpisodeLifecycleHost({ seriesLifecycle, itemCreation, loadContext, updates, images,
    refreshSeason, now: () => '2026-10-08T01:02:03.000Z' });
  const state = {
    presentationUniqueKey: 'live-key',
    getNewItemId: (_key, type) => type.endsWith('.Season') ? ids.newSeason : ids.newEpisode,
    collectionFolders: [{ Id: 'B0000000-0000-0000-0000-000000000020' }],
    libraryOptions: { PreferredMetadataLanguage: 'fr', MetadataCountryCode: 'FR' },
    globalOptions: { PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US' },
    libraryRuntimeOptions: { marker: 'target-runtime-options' },
  };
  return { lifecycle, state, events, rows, series, season, episode };
}

test('TMDB child lifecycle creates branded Season/Episode through ItemCreation and refreshes only the Season with its live parent', async () => {
  const current = fixture();
  const signal = new AbortController().signal;
  const season = await current.lifecycle.createSeason(current.series, 2, 'Remote Season Two', current.state, signal);
  const episode = await current.lifecycle.createEpisode(current.series, season,
    { id: 5002, episode_number: 3, name: 'Remote Episode', overview: 'Overview', air_date: '2026-10-07' },
    3, '2026-10-07T00:00:00.000Z', current.state);

  assert.equal(isNativeItemEntity(season), true);
  assert.deepEqual({ Id: season.Id, Name: season.Name, IndexNumber: season.IndexNumber, ParentId: season.ParentId,
    IsVirtualItem: season.IsVirtualItem, SeriesId: season.SeriesId, SeriesName: season.SeriesName,
    SeriesPresentationUniqueKey: season.SeriesPresentationUniqueKey, ProviderIds: season.ProviderIds }, {
    Id: ids.newSeason.toLowerCase(), Name: 'Remote Season Two', IndexNumber: 2, ParentId: current.series.Id,
    IsVirtualItem: true, SeriesId: current.series.Id, SeriesName: 'Live Series',
    SeriesPresentationUniqueKey: 'live-key', ProviderIds: { Tmdb: 'season-remote' },
  });
  assert.equal(isNativeItemEntity(episode), true);
  assert.deepEqual({ Id: episode.Id, ParentId: episode.ParentId, SeasonId: episode.SeasonId, SeriesId: episode.SeriesId,
    IndexNumber: episode.IndexNumber, ParentIndexNumber: episode.ParentIndexNumber, IsVirtualItem: episode.IsVirtualItem,
    ProviderIds: episode.ProviderIds, PresentationUniqueKey: episode.PresentationUniqueKey }, {
    Id: ids.newEpisode.toLowerCase(), ParentId: season.Id, SeasonId: season.Id, SeriesId: current.series.Id,
    IndexNumber: 3, ParentIndexNumber: 2, IsVirtualItem: true, ProviderIds: { Tmdb: '5002' },
    PresentationUniqueKey: ids.newEpisode.replaceAll('-', '').toLowerCase(),
  });
  const creates = current.events.filter(value => value[0] === 'create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0][2], current.series);
  assert.equal(creates[1][2], season);
  assert.equal(creates[0][3], undefined, 'CreateItem must not receive the request cancellation token');
  assert.equal(creates[1][3], undefined, 'Episode AddChild/CreateItem also has no request token');
  const refresh = current.events.find(value => value[0] === 'refresh-season');
  assert.equal(refresh[1].Id, season.Id);
  assert.equal(refresh[2], current.series);
  assert.deepEqual({ ...refresh[3], signal: undefined }, {
    MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true, signal: undefined,
  });
  assert.equal(refresh[3].signal, signal);
  assert.equal(current.events.some(value => value[0] === 'refresh-season' && value[1].Id === episode.Id), false);
  assert.equal(season, await current.lifecycle.itemCreation.getItemById(season.Id),
    'the working tree adopts the exact post-refresh cache entity');
});
test('Season creation stays committed when its nested refresh fails', async () => {
  const failure = new Error('nested season refresh failed');
  const current = fixture({ refreshError: failure });
  await assert.rejects(current.lifecycle.createSeason(current.series, 2, 'Season 2', current.state), failure);
  assert.equal(current.rows.has(ids.newSeason.toLowerCase()), true);
  assert.equal(current.events.filter(event=>event[0]==='create').length,1);
  assert.equal(current.events.filter(event=>event[0]==='refresh-season').length,1);
});

test('repository updates use the live target parent chain and still persistence reuses one loaded context', async () => {
  const current = fixture();
  current.episode.ParentId = current.season.Id;
  current.episode.SeasonId = current.season.Id;
  await current.lifecycle.update(current.episode, ItemUpdateType.MetadataImport, undefined, current.state);
  const repository = current.events.find(value => value[0] === 'repository');
  assert.equal(repository[1].parent, current.season);
  assert.deepEqual(repository[1].parents, [current.season, current.series]);
  assert.deepEqual(repository[1].lookup.SeriesProviderIds, { Tmdb: '42' });
  assert.deepEqual(repository[1].lookup.SeasonProviderIds, { Tmdb: '100' });
  assert.equal(repository[1].collectionFolders, current.state.collectionFolders);
  assert.equal(repository[1].libraryOptions, current.state.libraryOptions);
  assert.deepEqual(repository[1].context.collectionFolderIds, current.state.collectionFolders.map(value => value.Id));

  current.events.length = 0;
  const changed = await current.lifecycle.saveStill(current.episode, 'https://image.invalid/still.jpg', new AbortController().signal);
  assert.equal(changed, true);
  const image = current.events.find(value => value[0] === 'image');
  const imageRepository = current.events.find(value => value[0] === 'repository');
  assert.equal(image[1], imageRepository[1]);
  assert.equal(imageRepository[2].Images, image[2]);
  assert.equal(imageRepository[3], ItemUpdateType.ImageUpdate);
});

test('still download publishes the live Primary image before a repository failure', async () => {
  const failure = new Error('repository failed after image download');
  const current = fixture({ repositoryError: failure });
  await assert.rejects(current.lifecycle.saveStill(current.episode, 'https://image.invalid/still.jpg'), failure);
  assert.deepEqual(current.episode.ImageInfos.map(image => [image.Type, image.Path]),
    [['Primary', '/metadata/still.jpg']]);
  assert.equal(current.events.filter(value => value[0] === 'image').length, 1);
  await current.lifecycle.saveStill(current.episode, 'https://image.invalid/still.jpg');
  assert.equal(current.events.filter(value => value[0] === 'image').length, 1,
    'the retained live image prevents a second download attempt');
});

test('full TV removal unregisters only after the ordinary deletion lifecycle commits', async () => {
  const current = fixture();
  await current.lifecycle.remove(current.episode);
  assert.deepEqual(current.events.slice(-2), [['remove', current.episode.Id], ['unregister', current.episode.Id]]);

  const failure = new Error('delete failed');
  const failed = fixture({ removeError: failure });
  await assert.rejects(failed.lifecycle.remove(failed.episode), failure);
  assert.equal(failed.events.some(value => value[0] === 'unregister'), false);
});

test('nested Season refresh reads the live unsaved Series provider ids and fields', async t => {
  const current = await setupChildrenFixture(t);
  const seen = [];
  current.registry.register({ id: 'live-series-parent-test', name: 'Live parent test', providers: [{
    id: 'season-live-parent', name: 'Live parent', kind: 'remote', itemTypes: ['Season'],
    async getMetadata(lookup) { seen.push(structuredClone(lookup)); return { HasMetadata: false }; },
  }] });
  const seriesId = 'B1000000-0000-0000-0000-000000000001';
  const seasonId = 'B1000000-0000-0000-0000-000000000002';
  await current.seed({ target: 'season', items: [
    { key: 'series', Id: seriesId, type: 'Series', Name: 'Stored Series', ProviderIds: { Tmdb: 'old' },
      PresentationUniqueKey: 'stored-key', DateLastRefreshed: current.now },
    { key: 'season', Id: seasonId, type: 'Season', Name: 'Season 1', parent: 'series', IndexNumber: 1,
      SeriesId: seriesId, SeriesName: 'Stored Series', SeriesPresentationUniqueKey: 'stored-key', DateLastRefreshed: current.now },
  ] });
  const liveSeries = (await current.loadContext(seriesId)).item;
  liveSeries.Name = 'Live Unsaved Series';
  liveSeries.ProviderIds = { Tmdb: 'new' };
  liveSeries.PresentationUniqueKey = 'live-unsaved-key';
  liveSeries.PreferredMetadataLanguage = 'ja';
  liveSeries.PreferredMetadataCountryCode = 'JP';
  const season = (await current.loadContext(seasonId)).item;

  await current.host.refreshSeasonWithLiveSeries(season, liveSeries,
    { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].SeriesProviderIds, { Tmdb: 'new' });
  assert.equal(seen[0].MetadataLanguage, 'ja');
  assert.equal(seen[0].MetadataCountryCode, 'JP');
  const [savedSeason] = await current.database.rows('BaseItems', { where: { Id: seasonId } });
  const [storedSeries] = await current.database.rows('BaseItems', { where: { Id: seriesId } });
  assert.equal(savedSeason.SeriesName, 'Live Unsaved Series');
  assert.equal(savedSeason.SeriesPresentationUniqueKey, 'live-unsaved-key');
  assert.equal(storedSeries.Name, 'Stored Series', 'nested refresh must not save the live parent first');
  assert.deepEqual(await current.database.rows('BaseItemProviders', { where: { ItemId: seriesId } }),
    [{ ItemId: seriesId, ProviderId: 'Tmdb', ProviderValue: 'old' }]);
});

for (const dialect of ['postgres']) test(`${dialect}: cross-library reparent persists the target collection and complete ancestor chain`, async t => {
  const current = await setupChildrenFixture(t, dialect);
  const cross = Object.fromEntries(['aggregate', 'userRoot', 'oldFolder', 'newFolder', 'oldCollection', 'newCollection',
    'oldSeries', 'oldSeason', 'newSeries', 'newSeason', 'episode'].map((key, index) =>
    [key, `B3000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
  await current.seed({ target: 'episode', items: [
    { key: 'aggregate', Id: cross.aggregate, type: 'AggregateFolder' },
    { key: 'userRoot', Id: cross.userRoot, type: 'UserRootFolder' },
    { key: 'oldFolder', Id: cross.oldFolder, type: 'Folder', parent: 'aggregate', Path: 'Z:\\ChildSelection\\Old' },
    { key: 'newFolder', Id: cross.newFolder, type: 'Folder', parent: 'aggregate', Path: 'Z:\\ChildSelection\\New' },
    { key: 'oldCollection', Id: cross.oldCollection, type: 'CollectionFolder', parent: 'userRoot',
      PhysicalFolderIds: [cross.oldFolder], PhysicalLocationsList: ['Z:\\ChildSelection\\Old'] },
    { key: 'newCollection', Id: cross.newCollection, type: 'CollectionFolder', parent: 'userRoot',
      PhysicalFolderIds: [cross.newFolder], PhysicalLocationsList: ['Z:\\ChildSelection\\New'] },
    { key: 'oldSeries', Id: cross.oldSeries, type: 'Series', parent: 'oldFolder', Path: 'Z:\\ChildSelection\\Old\\Show' },
    { key: 'oldSeason', Id: cross.oldSeason, type: 'Season', parent: 'oldSeries', IndexNumber: 1,
      SeriesId: cross.oldSeries },
    { key: 'newSeries', Id: cross.newSeries, type: 'Series', parent: 'newFolder', Path: 'Z:\\ChildSelection\\New\\Show' },
    { key: 'newSeason', Id: cross.newSeason, type: 'Season', parent: 'newSeries', IndexNumber: 1,
      SeriesId: cross.newSeries },
    { key: 'episode', Id: cross.episode, type: 'Episode', parent: 'oldSeason', IsVirtualItem: true,
      IndexNumber: 1, ParentIndexNumber: 1, SeriesId: cross.oldSeries, SeasonId: cross.oldSeason,
      ProviderIds: { Tmdb: '301' }, ancestors: ['oldSeason', 'oldSeries', 'oldFolder', 'oldCollection'] },
  ] });
  current.library.options.libraryOptions = new Map([
    [cross.oldCollection.replaceAll('-', '').toLowerCase(), { PreferredMetadataLanguage: 'de', MetadataCountryCode: 'DE' }],
    [cross.newCollection.replaceAll('-', '').toLowerCase(), { PreferredMetadataLanguage: 'fr', MetadataCountryCode: 'FR' }],
  ]);
  const images = new MetadataImages();
  const updates = new MetadataUpdateHost({ registry: current.registry, store: current.store, images,
    library: current.library, now: () => current.now });
  const itemCreation = new ItemCreationService({ store: current.store, library: current.library, linkedChildren: current.linkedChildren,
    loadContext: current.loadContext });
  current.library.itemCreation = itemCreation;
  const externalData = new ExternalDataManager({fileSystem: testFileSystem,  store: current.store, vfs: current.vfs,
    identityMap: current.identityMap, dataPath: current.library.options.dataPath,
    metadataPath: current.library.options.metadataPath });
  const seriesLifecycle = new SeriesMetadataLifecycleHost({ store: current.store, loadContext: current.loadContext,
    updates, externalData, itemCreation, refresh: async () => {}, now: () => current.now });
  const lifecycle = new TmdbMissingEpisodeLifecycleHost({ seriesLifecycle, itemCreation,
    loadContext: current.loadContext, updates, images, refreshSeason: async () => {}, now: () => current.now });
  t.after(async () => { await itemCreation.close(); await images.close(); });

  const targetSeries = (await current.loadContext(cross.newSeries)).item;
  const state = await seriesLifecycle.load(targetSeries);
  const episode = (await current.loadContext(cross.episode)).item;
  episode.ParentId = cross.newSeason;
  episode.SeasonId = cross.newSeason;
  episode.SeriesId = cross.newSeries;
  try { await lifecycle.update(episode, ItemUpdateType.MetadataImport, undefined, state); }
  finally { await state.close(); }

  const ancestors = (await current.database.rows('AncestorIds', { where: { ItemId: cross.episode } }))
    .map(row => row.ParentItemId.toLowerCase()).sort();
  assert.deepEqual(ancestors, [cross.aggregate, cross.newSeason, cross.newSeries, cross.newFolder, cross.newCollection]
    .map(value => value.toLowerCase()).sort());
  assert.equal(episode.MetadataLanguage, 'fr');
  assert.equal(episode.MetadataCountryCode, 'FR');
});

for (const dialect of ['postgres']) test(`${dialect}: disabled provider composes the complete TV deletion and cache lifecycle`, async t => {
  const current = await setupChildrenFixture(t, dialect);
  const fixtureIds = {
    series: 'B2000000-0000-0000-0000-000000000001',
    season: 'B2000000-0000-0000-0000-000000000002',
    episode: 'B2000000-0000-0000-0000-000000000003',
  };
  await current.seed({ target: 'series', items: [
    { key: 'series', Id: fixtureIds.series, type: 'Series', ProviderIds: { Tmdb: '42' },
      PresentationUniqueKey: 'series-key' },
    { key: 'season', Id: fixtureIds.season, type: 'Season', parent: 'series', IndexNumber: 1,
      SeriesId: fixtureIds.series, SeriesPresentationUniqueKey: 'series-key' },
    { key: 'episode', Id: fixtureIds.episode, type: 'Episode', parent: 'season', IsVirtualItem: true,
      IndexNumber: 1, ParentIndexNumber: 1, SeriesId: fixtureIds.series, SeasonId: fixtureIds.season,
      SeriesPresentationUniqueKey: 'series-key', ProviderIds: { Tmdb: '101' } },
  ] });
  const images = new MetadataImages();
  const updates = new MetadataUpdateHost({ registry: current.registry, store: current.store, images,
    library: current.library, now: () => current.now });
  const externalData = new ExternalDataManager({fileSystem: testFileSystem,  store: current.store, vfs: current.vfs, identityMap: current.identityMap,
    dataPath: current.library.options.dataPath, metadataPath: current.library.options.metadataPath });
  const itemCreation = new ItemCreationService({ store: current.store, library: current.library, linkedChildren: current.linkedChildren,
    loadContext: current.loadContext });
  current.library.itemCreation = itemCreation;
  const linkedChildReferences = new LinkedChildReferenceService({ ...current, itemCreation, updates });
  current.library.itemDeletion = new ItemDeletionService({ ...current, itemCreation, updates, externalData, linkedChildReferences,
    now: () => current.now });
  const seriesLifecycle = new SeriesMetadataLifecycleHost({ store: current.store, loadContext: current.loadContext,
    updates, externalData, itemCreation, refresh: async () => { throw new Error('disabled cleanup must not refresh'); }, now: () => current.now });
  const lifecycle = new TmdbMissingEpisodeLifecycleHost({ seriesLifecycle, itemCreation,
    loadContext: current.loadContext, updates, images,
    refreshSeason: async () => { throw new Error('disabled cleanup must not refresh a season'); }, now: () => current.now });
  t.after(async () => { await itemCreation.close(); await images.close(); });

  assert.ok(await itemCreation.getItemById(fixtureIds.episode), 'control: the deleted entity begins in the item cache');
  const removed = [];
  current.library.on('ItemRemoved', event => removed.push([event.Item.Id, event.Parent?.Id,
    itemCreation.getItemById(event.Item.Id)]));
  const provider = createTmdbMissingEpisodeProvider({ configuration: tmdbConfiguration() });
  const series = (await current.loadContext(fixtureIds.series)).item;
  const result = await provider.fetch(series, { lifecycle: lifecycle,
    signal: AbortSignal.abort(new Error('disabled cleanup ignores request cancellation')) });

  assert.equal(result.UpdateType, ItemUpdateType.MetadataImport);
  assert.deepEqual(result.RemovedItemIds, [fixtureIds.episode]);
  assert.equal(series.Children, null);
  assert.equal((await current.database.rows('BaseItems', { where: { Id: fixtureIds.episode } })).length, 0);
  assert.equal(await itemCreation.getItemById(fixtureIds.episode), null, 'completed DeleteItem unregisters its cache entry');
  assert.deepEqual(await Promise.all(removed.map(async ([item, parent, cached]) => [item, parent, await cached])),
    [[fixtureIds.episode, fixtureIds.season, null]], 'cache eviction precedes ItemRemoved');
});
