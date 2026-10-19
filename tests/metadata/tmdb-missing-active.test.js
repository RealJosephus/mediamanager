import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { SeriesMetadataLifecycleHost } from '../../src/metadata/series-lifecycle-host.js';
import { tmdbConfiguration } from '../../plugins/tmdb/configuration.js';
import { TmdbClient } from '../../plugins/tmdb/client.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { TmdbMissingEpisodeLifecycleHost } from '../../plugins/tmdb/missing-episode-lifecycle.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { setupChildrenFixture } from './children-fixture.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { newNativeItemEntity, isNativeItemEntity, acquireNativeItemLinkOwner } from '../../src/library/native-item-entity.js';
import {
  buildTmdbSeasonSortNameTemplate,
  createTmdbMissingEpisodeProvider,
  parseTmdbSeriesId,
  shouldImportTmdbEpisode,
  shouldPruneTmdbEpisode,
  tmdbEpisodePremiereDate,
} from '../../plugins/tmdb/missing-episodes.js';

const collectionId = 'A0000000-0000-0000-0000-000000000001';
const seriesId = 'A0000000-0000-0000-0000-000000000002';
const id = number => `A0000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const native=value=>{if(isNativeItemEntity(value))return value;
  const {Type,...fields}=value;return Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.TV.'+Type),fields);};
const episode = (number, values = {}) => native({ Id: id(number), Type: 'Episode', ParentId: id(10), ParentIndexNumber: 1,
  IndexNumber: number, IsVirtualItem: true, IsFileProtocol: false, ProviderIds: { Tmdb: String(1000 + number) },
  ImageInfos: [], SeriesName: 'Show', ...values });

async function controlled(t, { configuration = {}, items = [], remoteSeries = { seasons: [] }, remoteSeasons = new Map(),
  today = '2026-10-08T00:00:00.000Z', onRemove, onSaveStill } = {}) {
  const events = [], errors = [];
  const database=await createPostgresTestDatabase(null,'tmdb_active_ctrl'),store=new DomainStore(database);
  const linkedChildren=new PostgresLinkedChildrenStore({database});await linkedChildren.initialize();
  const cohort=await createNativeItemCohort({linkedChildren}),owners=[];
  const typed=native;
  for(let index=0;index<items.length;index++){
    const item=typed(items[index]);items[index]=item;const owner=acquireNativeItemLinkOwner(item);owners.push(owner);
    await cohort.capture(item,{ordinal:BigInt(index+1)});
  }
  const sequence=metadataChildSequence(cohort,linkedChildren,store);
  t.after(async()=>{await sequence.close();for(const owner of owners)owner.release();
    await linkedChildren.flushReleases();await linkedChildren.close();await dropPostgresTestDatabase(database);});
  const client = {
    configuration: tmdbConfiguration({ ...configuration,
      EnabledMissingEpisodeLibraries: [collectionId.replaceAll('-', '').toUpperCase()] }),
    async series(...args) { events.push(['series', ...args.slice(0, 4)]); return remoteSeries; },
    async season(series, number, ...args) { events.push(['season', series, number, ...args.slice(0, 3)]); return remoteSeasons.get(number); },
    imageUrl(path, size) { events.push(['image-url', path, size]); return `https://image.invalid/${size ?? 'original'}${path}`; },
  };
  const state = {
    linkedChildren,recursive: async () => sequence,close: ()=>sequence.close(),
    contextFor: current => ({ parent: items.find(value => value.Id === current.ParentId), series: { DisplayOrder: null } }),
  };
  const lifecycle = {
    async withItem(item,operation){const owner=acquireNativeItemLinkOwner(item);try{return await operation(item);}finally{owner.release();await linkedChildren.flushReleases();}},
    logger: { error: (error, message) => errors.push([error, message]) },
    utcToday: () => today,
    async load(liveSeries) { events.push(['load', liveSeries.Id]); return state; },
    async remove(item) { events.push(['remove', item.Id]); await onRemove?.(item); },
    async update(item, reason) { events.push(['update', item.Id, reason, structuredClone({
      Name: item.Name, Overview: item.Overview, PremiereDate: item.PremiereDate, ProductionYear: item.ProductionYear,
      ParentId: item.ParentId, SeasonId: item.SeasonId, SeasonName: item.SeasonName,
      PresentationUniqueKey: item.PresentationUniqueKey, ForcedSortName: item.ForcedSortName,
    })]); },
    async createSeason(series, number, name) {
      const value = typed({ Id: id(100 + number), Type: 'Season', ParentId: series.Id, IndexNumber: number,
        Name: name, IsVirtualItem: true, ForcedSortName: null, ProviderIds: {} });
      events.push(['create-season', number, name]); return value;
    },
    async createEpisode(series, season, remote, episodeNumber, premiere) {
      const value = typed(episode(200 + events.length, { ParentId: season.Id, ParentIndexNumber: season.IndexNumber,
        IndexNumber: episodeNumber, Name: remote.name, PremiereDate: premiere,
        ProviderIds: remote.id > 0 ? { Tmdb: String(remote.id) } : {} }));
      events.push(['create-episode', season.IndexNumber, episodeNumber, remote.episode_number, premiere]); return value;
    },
    async saveStill(item, url) { events.push(['still', item.Id, url]); return await onSaveStill?.(item, url) ?? true; },
  };
  return { provider: createTmdbMissingEpisodeProvider(client), lifecycle, state, events, errors };
}

test('active TMDB reconciliation preserves remote order, physical/foreign slots, update/create/still and final sort order', async t => {
  const physicalSeason = native({ Id: id(10), Type: 'Season', IndexNumber: 1, IsVirtualItem: false, ForcedSortName: 'Season 01' });
  const specialSeason = native({ Id: id(11), Type: 'Season', IndexNumber: 0, IsVirtualItem: true, ForcedSortName: 'old' });
  const updating = episode(1, { Name: 'Old', Overview: 'Old overview', PremiereDate: '2026-10-01T00:00:00.000Z',
    ProductionYear: 1999, ParentId: id(99), SeasonId: id(99), SeasonName: 'Wrong', PresentationUniqueKey: '' });
  const physical = episode(2, { Path: 'Z:\\Show\\Show.S01E02.mkv', ParentIndexNumber: null, IndexNumber: null,
    IsVirtualItem: false, IsFileProtocol: true, ProviderIds: {} });
  const foreign = episode(3, { ProviderIds: { Tvdb: '3003' } });
  const duplicate = episode(22, { ParentIndexNumber: 1, IndexNumber: 2 });
  const special = episode(9, { ParentId: specialSeason.Id, ParentIndexNumber: 0, IndexNumber: 9 });
  const remoteSeasons = new Map([
    [1, { name: 'Season One', episodes: [
      { id: 1001, episode_number: 1, name: 'Updated', overview: 'Updated overview', air_date: '2026-10-02', still_path: '/one.jpg' },
      { id: 1002, episode_number: 2, name: 'Physical duplicate', air_date: '2026-10-03' },
      { id: 1003, episode_number: 3, name: 'Foreign virtual duplicate', air_date: '2026-10-04' },
      { id: 1004, episode_number: 4, name: 'New episode', overview: 'New', air_date: '2026-10-05' },
      { id: 1005, episode_number: 5, name: 'Undated', air_date: null },
    ] }],
    [0, { name: 'Specials', episodes: [{ id: 9, episode_number: 9, name: 'Special', air_date: '2026-10-01' }] }],
    [2, { name: 'Season Two', episodes: null }],
  ]);
  const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true, ImportUnairedEpisodes: true, ImportSpecials: false,
    StillSize: 'w300' }, items: [physicalSeason, specialSeason, updating, physical, foreign, duplicate, special],
    remoteSeries: { seasons: [{ season_number: 1 }, { season_number: 0 }, { season_number: 2 }] }, remoteSeasons });
  const series = { Id: seriesId, Type: 'Series', Name: 'Show', ProviderIds: { tmDB: ' +42 ' }, MetadataLanguage: 'zh-TW',
    MetadataCountryCode: 'TW', PresentationUniqueKey: 'series-live' };

  const result = await fixture.provider.fetch(series, {
    collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle, signal: new AbortController().signal
  });

  assert.equal(result.UpdateType, ItemUpdateType.MetadataImport);
  assert.deepEqual(fixture.events.filter(value => value[0] === 'season').map(value => value[2]), [1, 0, 2]);
  assert.deepEqual(fixture.events.filter(value => value[0] === 'remove').map(value => value[1]), [special.Id, duplicate.Id]);
  assert.deepEqual(fixture.events.filter(value => value[0] === 'create-episode').map(value => value.slice(1, 3)), [[1, 4]]);
  assert.equal(fixture.events.some(value => value[0] === 'create-episode' && [2, 3, 5].includes(value[2])), false);
  const update = fixture.events.find(value => value[0] === 'update' && value[1] === updating.Id);
  assert.deepEqual(update.slice(2, 4), [ItemUpdateType.MetadataImport, {
    Name: 'Updated', Overview: 'Updated overview', PremiereDate: tmdbEpisodePremiereDate('2026-10-02'), ProductionYear: 2026,
    ParentId: physicalSeason.Id, SeasonId: physicalSeason.Id, SeasonName: physicalSeason.Name,
    PresentationUniqueKey: updating.Id.replaceAll('-', '').toLowerCase(), ForcedSortName: null,
  }]);
  assert.deepEqual(fixture.events.find(value => value[0] === 'still').slice(1),
    [updating.Id, 'https://image.invalid/w300/one.jpg']);
  const lastUpdate = fixture.events.filter(value => value[0] === 'update').at(-1);
  assert.equal(lastUpdate[1], specialSeason.Id);
  assert.equal(lastUpdate[2], ItemUpdateType.MetadataEdit);
  assert.equal(lastUpdate[3].ForcedSortName, 'Season 00');
  assert.equal(series.Children, null);
});
test('active pruning keeps the exact grace boundary and undated/foreign virtuals, then cancellation preserves earlier deletes', async t => {
  const controller = new AbortController();
  const special = episode(1, { ParentIndexNumber: 0, PremiereDate: null });
  const aged = episode(2, { PremiereDate: '2026-10-05T00:00:00.000Z' });
  const boundary = episode(3, { PremiereDate: '2026-10-06T00:00:00.000Z' });
  const undated = episode(4, { PremiereDate: null });
  const foreign = episode(5, { PremiereDate: '2026-01-01T00:00:00.000Z', ProviderIds: { Tvdb: '5' } });
  const fixture = await controlled(t, { configuration: { ImportUnairedEpisodes: true, ImportMissingEpisodes: false,
    UpcomingEpisodeGracePeriodDays: 2 }, items: [special, aged, boundary, undated, foreign],
    remoteSeries: { seasons: [{ season_number: 1 }] }, onRemove: item => {
      if (item.Id === aged.Id) controller.abort(new Error('cancel after committed prune'));
    } });
  const series = { Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } };
  await assert.rejects(fixture.provider.fetch(series, { collectionFolderIds: [collectionId],
    lifecycle: fixture.lifecycle, signal: controller.signal }), /cancel after committed prune/);
  assert.deepEqual(fixture.events.filter(value => value[0] === 'remove').map(value => value[1]), [special.Id, aged.Id]);
  assert.equal(fixture.events.some(value => value[0] === 'season'), false);
});

test('TMDB missing episode scalar rules match Int32, local-midnight UTC, specials, grace and sort templates', () => {
  for (const [value, expected] of [['42', 42], [' +42 ', 42], ['0', null], ['-1', null], ['2147483647', 2147483647],
    ['2147483648', null], [`\u000b+42\u000b`, 42], [`\u0085+42\u0085`, null], [`\ufeff42`, null],
    ['1.0', null], ['', null], [null, null]]) {
    assert.equal(parseTmdbSeriesId(value), expected, JSON.stringify(value));
  }
  const premiere = tmdbEpisodePremiereDate('2026-10-08');
  assert.equal(new Date(premiere).toISOString(), new Date(2026, 9, 8).toISOString());
  assert.equal(shouldImportTmdbEpisode(premiere, '2026-10-08T00:00:00Z', { importUnaired: true }),
    utcDay(premiere) >= utcDay('2026-10-08T00:00:00Z'));
  assert.equal(shouldImportTmdbEpisode(premiere, '2026-10-08T00:00:00Z',
    { importUnaired: true, importMissing: true, isSpecial: true, importSpecials: false }), false);
  assert.equal(shouldPruneTmdbEpisode(episode(9, { PremiereDate: '2026-10-06T23:59:59Z' }), '2026-10-08T00:00:00Z',
    { pruneAgedOut: true, gracePeriodDays: 2, importSpecials: true }), false);
  assert.equal(shouldPruneTmdbEpisode(episode(9, { PremiereDate: '2026-10-05T23:59:59Z' }), '2026-10-08T00:00:00Z',
    { pruneAgedOut: true, gracePeriodDays: 2, importSpecials: true }), true);
  const template = buildTmdbSeasonSortNameTemplate([
    { IsVirtualItem: false, IndexNumber: 12, ForcedSortName: 'Volume 2 - Season 012 suffix 9x' },
  ]);
  assert.equal(template(3), 'Volume 2 - Season 012 suffix 3x');
  const multiline = buildTmdbSeasonSortNameTemplate([
    { IsVirtualItem: false, IndexNumber: 12, ForcedSortName: 'Season 07\nsuffix' },
  ]);
  assert.equal(multiline(3), 'Season 03\nsuffix');
  const unicode = buildTmdbSeasonSortNameTemplate([
    { IsVirtualItem: false, IndexNumber: 12, ForcedSortName: 'Season ٠٧ suffix' },
  ]);
  assert.equal(unicode(3), 'Season 03 suffix');
  assert.equal(buildTmdbSeasonSortNameTemplate([{ IsVirtualItem: false, IndexNumber: 1, ForcedSortName: 'Season' }]), null);
});

test('TMDB date-only conversion freezes years 1-99 under the verified native Taipei calendar zone', () => {
  const module = new URL('../../plugins/tmdb/missing-episodes.js', import.meta.url).href;
  const script = `import { tmdbEpisodePremiereDate as convert } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify([Intl.DateTimeFormat().resolvedOptions().timeZone,
      convert('0001-01-01'), convert('0099-12-31'), convert('0100-01-01'), convert('0000-01-01')]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Taipei' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['Asia/Taipei', '0001-01-01T00:00:00.0000000Z',
    '0099-12-30T16:00:00.0000000Z', '0099-12-31T16:00:00.0000000Z', null]);
});

test('TMDB unchecked Int64 episode conversion is passed explicitly to creation', async t => {
  const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true },
    remoteSeries: { seasons: [{ season_number: 1 }] },
    remoteSeasons: new Map([[1, { name: 'Season One', episodes: [
      { id: 1, episode_number: 2147483648, name: 'Wrapped', air_date: '2026-10-01' },
    ] }]]) });
  await fixture.provider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } },
    { collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle });
  assert.deepEqual(fixture.events.find(value => value[0] === 'create-episode').slice(1, 4),
    [1, -2147483648, 2147483648]);
});

test('TMDB production client preserves raw Int64 episode numbers through the unchecked Int32 cast', async t => {
  const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true } });
  const client = new TmdbClient({ apiKey: 'fixture-key', configuration: {
    ImportMissingEpisodes: true,
    EnabledMissingEpisodeLibraries: [collectionId.replaceAll('-', '')],
  }, fetch: async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/configuration')) return Response.json({ images: {
      secure_base_url: 'https://images.invalid/', poster_sizes: ['original'], backdrop_sizes: ['original'],
    } });
    if (url.pathname.endsWith('/tv/42')) return new Response('{"seasons":[{"season_number":1}]}');
    if (url.pathname.endsWith('/tv/42/season/1')) return new Response('{"name":"Season One","episodes":['
      + '{"id":1,"episode_number":4294967296,"name":"Zero","air_date":"2026-10-01"},'
      + '{"id":2,"episode_number":9223372036854775807,"name":"Minus one","air_date":"2026-10-02"}]}');
    throw new Error(`Unexpected TMDB path: ${url.pathname}`);
  } });
  t.after(() => client.close());
  const provider = createTmdbMissingEpisodeProvider(client);
  await provider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } }, {
    collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle,
  });
  assert.deepEqual(fixture.events.filter(value => value[0] === 'create-episode')
    .map(value => value.slice(1, 4)), [
    [1, 0, 4294967296],
    [1, -1, 9223372036854775807n],
  ]);
});

test('season sorting uses only the first season for each number', async t => {
  const first = { Id: id(40), Type: 'Season', IndexNumber: 1, IsVirtualItem: true, ForcedSortName: 'keep' };
  const duplicate = { Id: id(41), Type: 'Season', IndexNumber: 1, IsVirtualItem: false, ForcedSortName: 'Season 01' };
  const other = { Id: id(42), Type: 'Season', IndexNumber: 2, IsVirtualItem: true, ForcedSortName: 'also keep' };
  const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true }, items: [first, duplicate, other] });
  const result = await fixture.provider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } },
    { collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle });
  assert.equal(result.UpdateType, ItemUpdateType.None);
  assert.equal(fixture.events.some(value => value[0] === 'update'), false);
});

test('a still repository failure retains the live Primary image and suppresses a duplicate retry', async t => {
  const existing = episode(1);
  let attempts = 0;
  let publishedImage;
  const failure = new Error('still repository failed');
  const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true }, items: [existing],
    remoteSeries: { seasons: [{ season_number: 1 }] },
    remoteSeasons: new Map([[1, { name: 'Season One', episodes: [
      { id: 1, episode_number: 1, name: 'One', air_date: '2026-10-01', still_path: '/one.jpg' },
      { id: 1, episode_number: 1, name: 'One', air_date: '2026-10-01', still_path: '/one.jpg' },
    ] }]]),
    onSaveStill(item) { attempts++; item.ImageInfos.push({ Type: 'Primary', Path: '/metadata/one.jpg' });
      publishedImage=item.ImageInfos[0];throw failure; } });
  await fixture.provider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } },
    { collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle });
  assert.equal(attempts, 1);
  assert.equal(publishedImage.Type, 'Primary');
  assert.deepEqual(fixture.errors.map(value => value[0]), [failure]);
});

function utcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

test('invalid or null series responses do not load or prune the live tree', async t => {
  for (const [providerId, remote, expectedCalls] of [['2147483648', { seasons: [] }, 0], ['42', null, 1], ['42', {}, 1]]) {
    const fixture = await controlled(t, { configuration: { ImportMissingEpisodes: true }, remoteSeries: remote });
    const result = await fixture.provider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: providerId } },
      { collectionFolderIds: [collectionId], lifecycle: fixture.lifecycle });
    assert.equal(result.UpdateType, ItemUpdateType.None);
    assert.equal(fixture.events.filter(value => value[0] === 'series').length, expectedCalls);
    assert.equal(fixture.events.some(value => value[0] === 'load'), false);
  }
});

test('a later season failure keeps earlier child commits and does not run final season sorting', async t => {
  const failure = new Error('second season failed');
  let calls = 0;
  const clientFixture = await controlled(t, { configuration: { ImportMissingEpisodes: true },
    items: [{ Id: id(10), Type: 'Season', IndexNumber: 1, IsVirtualItem: false, ForcedSortName: 'Season 01' },
      { Id: id(11), Type: 'Season', IndexNumber: 3, IsVirtualItem: true, ForcedSortName: 'stale' }],
    remoteSeries: { seasons: [{ season_number: 1 }, { season_number: 2 }] },
    remoteSeasons: new Map([[1, { name: 'Season One', episodes: [
      { id: 101, episode_number: 1, name: 'Committed first', air_date: '2026-10-01' },
    ] }]]) });
  const activeProvider = createTmdbMissingEpisodeProvider({
    configuration: tmdbConfiguration({ ImportMissingEpisodes: true,
      EnabledMissingEpisodeLibraries: [collectionId.replaceAll('-', '')] }),
    series: async () => ({ seasons: [{ season_number: 1 }, { season_number: 2 }] }),
    season: async (_series, number) => {
      calls++;
      if (number === 2) throw failure;
      return { name: 'Season One', episodes: [{ id: 101, episode_number: 1, name: 'Committed first', air_date: '2026-10-01' }] };
    },
    imageUrl: () => null,
  });
  await assert.rejects(activeProvider.fetch({ Id: seriesId, Type: 'Series', ProviderIds: { Tmdb: '42' } },
    { collectionFolderIds: [collectionId], lifecycle: clientFixture.lifecycle }), failure);
  assert.equal(calls, 2);
  assert.deepEqual(clientFixture.events.filter(value => value[0] === 'create-episode').map(value => value.slice(1, 3)), [[1, 1]]);
  assert.equal(clientFixture.events.some(value => value[0] === 'update' && value[2] === ItemUpdateType.MetadataEdit), false);
});

for (const dialect of ['postgres']) test(`${dialect}: active pass composes real creation, update, nested refresh and Series after-lifecycle boundaries`, async t => {
  const current = await setupChildrenFixture(t, dialect);
  const fixtureIds = {
    aggregate: 'A2000000-0000-0000-0000-000000000001', folder: 'A2000000-0000-0000-0000-000000000002',
    userRoot: 'A2000000-0000-0000-0000-000000000003', collection: 'A2000000-0000-0000-0000-000000000004',
    series: 'A2000000-0000-0000-0000-000000000005', season: 'A2000000-0000-0000-0000-000000000006',
    owned: 'A2000000-0000-0000-0000-000000000007', physical: 'A2000000-0000-0000-0000-000000000008',
    foreignDuplicate: 'A2000000-0000-0000-0000-000000000009', orphan: 'A2000000-0000-0000-0000-000000000010',
    duplicateSeason: 'A2000000-0000-0000-0000-000000000011', emptySeason: 'A2000000-0000-0000-0000-000000000012',
    physicalParsed: 'A2000000-0000-0000-0000-000000000013',
  };
  await current.seed({ target: 'series', items: [
    { key: 'aggregate', Id: fixtureIds.aggregate, type: 'AggregateFolder' },
    { key: 'folder', Id: fixtureIds.folder, type: 'Folder', parent: 'aggregate', Path: 'Z:\\ChildSelection' },
    { key: 'userRoot', Id: fixtureIds.userRoot, type: 'UserRootFolder' },
    { key: 'collection', Id: fixtureIds.collection, type: 'CollectionFolder', parent: 'userRoot',
      PhysicalFolderIds: [fixtureIds.folder], PhysicalLocationsList: ['Z:\\ChildSelection'] },
    { key: 'series', Id: fixtureIds.series, type: 'Series', parent: 'folder', Path: 'Z:\\ChildSelection\\Show',
      ProviderIds: { Tmdb: '42' }, PresentationUniqueKey: 'series-key' },
    { key: 'season', Id: fixtureIds.season, type: 'Season', parent: 'series', Path: 'Z:\\ChildSelection\\Show\\Season 1',
      IndexNumber: 1, SeriesId: fixtureIds.series, SeriesName: 'series', SeriesPresentationUniqueKey: 'series-key' },
    { key: 'owned', Id: fixtureIds.owned, type: 'Episode', parent: 'season', IsVirtualItem: true,
      IndexNumber: 1, ParentIndexNumber: 1, SeriesId: fixtureIds.series, SeasonId: fixtureIds.season,
      SeriesName: 'series', SeasonName: 'season', SeriesPresentationUniqueKey: 'series-key', ProviderIds: { Tmdb: '101' } },
    { key: 'physical', Id: fixtureIds.physical, type: 'Episode', parent: 'season',
      Path: 'Z:\\ChildSelection\\Show\\Season 1\\Show.S01E02.mkv', IndexNumber: 2, ParentIndexNumber: 1,
      SeriesId: fixtureIds.series, SeasonId: fixtureIds.season, SeriesName: 'series', SeasonName: 'season',
      SeriesPresentationUniqueKey: 'series-key' },
    { key: 'physicalParsed', Id: fixtureIds.physicalParsed, type: 'Episode', parent: 'season',
      Path: 'Z:\\ChildSelection\\Show\\Season 1\\Show.S01E04.mkv', IndexNumber: null, ParentIndexNumber: null,
      SeriesId: fixtureIds.series, SeasonId: fixtureIds.season, SeriesName: 'series', SeasonName: 'season',
      SeriesPresentationUniqueKey: 'series-key' },
    { key: 'foreignDuplicate', Id: fixtureIds.foreignDuplicate, type: 'Episode', parent: 'season', IsVirtualItem: true,
      IndexNumber: 2, ParentIndexNumber: 1, SeriesId: fixtureIds.series, SeasonId: fixtureIds.season,
      SeriesName: 'series', SeasonName: 'season', SeriesPresentationUniqueKey: 'series-key', ProviderIds: { Tvdb: '102' } },
    { key: 'orphan', Id: fixtureIds.orphan, type: 'Episode', parent: 'season', IsVirtualItem: true,
      IndexNumber: null, ParentIndexNumber: 1, SeriesId: fixtureIds.series, SeasonId: fixtureIds.season,
      SeriesName: 'series', SeasonName: 'season', SeriesPresentationUniqueKey: 'series-key', ProviderIds: { Tmdb: '199' } },
    { key: 'duplicateSeason', Id: fixtureIds.duplicateSeason, type: 'Season', parent: 'series', IsVirtualItem: true,
      IndexNumber: 1, SeriesId: fixtureIds.series, SeriesName: 'series', SeriesPresentationUniqueKey: 'series-key' },
    { key: 'emptySeason', Id: fixtureIds.emptySeason, type: 'Season', parent: 'series', IsVirtualItem: true,
      IndexNumber: 3, SeriesId: fixtureIds.series, SeriesName: 'series', SeriesPresentationUniqueKey: 'series-key' },
  ] });
  const configuration = tmdbConfiguration({ ImportMissingEpisodes: true,
    EnabledMissingEpisodeLibraries: [fixtureIds.collection.replaceAll('-', '')], ImportSeasonName: true });
  const calls = [];
  const remoteSeason = number => number === 1
    ? { id: 501, name: 'Remote Season One', episodes: [
      { id: 101, episode_number: 1, name: 'Updated Placeholder', overview: 'Updated', air_date: '2026-10-01' },
      { id: 102, episode_number: 2, name: 'Must Stay Physical', overview: 'Blocked', air_date: '2026-10-02' },
      { id: 104, episode_number: 4, name: 'Parsed Physical Slot', overview: 'Blocked', air_date: '2026-10-04' },
    ] }
    : { id: 502, name: 'Remote Season Two', episodes: [
      { id: 201, episode_number: 1, name: 'New Placeholder', overview: 'New', air_date: '2026-10-03' },
    ] };
  const client = {
    configuration,
    async series(series, language, images, country) {
      calls.push(['series', series, language, images, country]);
      return { seasons: [{ season_number: 1 }, { season_number: 2 }] };
    },
    async season(series, number, language, images, country) {
      calls.push(['season', series, number, language, images, country]);
      return remoteSeason(number);
    },
    convertImages: () => [],
    imageUrl: () => null,
    fetch: async t => { throw new Error('No image request expected'); },
  };
  current.registry.register({ id: 'tmdb-live-language-test', name: 'TMDB live language test', providers: [{
    id: 'tmdb-live-language-local', name: 'TMDB live language local', kind: 'local', itemTypes: ['Series'],
    hasChanged: () => true,
    async getMetadata() {
      return { HasMetadata: true, Item: { Type: 'Series', PreferredMetadataLanguage: 'ja',
        PreferredMetadataCountryCode: 'JP' }, People: null };
    },
  }] });
  const images = new MetadataImages();
  const updates = new MetadataUpdateHost({ registry: current.registry, store: current.store, images,
    library: current.library, now: () => current.now });
  const externalData = new ExternalDataManager({fileSystem: testFileSystem,  store: current.store, vfs: current.vfs, identityMap: current.identityMap,
    dataPath: current.library.options.dataPath, metadataPath: current.library.options.metadataPath });
  const itemCreation = new ItemCreationService({ store: current.store, library: current.library,
    linkedChildren: current.linkedChildren, loadContext: current.loadContext });
  current.library.itemCreation = itemCreation;
  let host;
  const seriesLifecycle = new SeriesMetadataLifecycleHost({ store: current.store, loadContext: current.loadContext, updates,
    externalData, itemCreation, refresh: (...args) => host.refresh(...args), now: () => current.now });
  const lifecycle = new TmdbMissingEpisodeLifecycleHost({ seriesLifecycle, itemCreation,
    loadContext: current.loadContext, updates, images, refreshSeason: (...args) => host.refreshSeasonWithLiveSeries(...args),
    now: () => current.now });
  current.registry.register(createTmdbPlugin({ client, lifecycle }));
  host = new MetadataRefreshHost({ registry: current.registry, store: current.store, linkedChildren: current.linkedChildren, vfs: current.vfs,
    loadContext: current.loadContext, updates, images, externalData, now: () => current.now });
  t.after(async t => { await host.close(); await itemCreation.close(); await images.close(); });

  const added = [], addedEvents = [], parentMetadataAtDelivery = [];
  current.library.on('ItemAdded', event => {
    parentMetadataAtDelivery.push({ type: event.Item.Type, id: event.Parent?.Id,
      name: event.Parent?.Name, language: event.Parent?.MetadataLanguage, country: event.Parent?.MetadataCountryCode });
    addedEvents.push(event);
    added.push([event.Item.Type, event.Item.Id, event.Parent?.Id]);
  });
  const result = await host.refresh(fixtureIds.series,
    { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' });

  assert.equal(result.Failures, 0);
  assert.equal(Boolean(result.UpdateType & ItemUpdateType.MetadataImport), true);
  const state = await current.state();
  const episodes = state.items.filter(item => item.Type === 'Episode');
  const seasons = state.items.filter(item => item.Type === 'Season');
  const updated = episodes.find(item => item.Id.toLowerCase() === fixtureIds.owned.toLowerCase());
  const created = episodes.find(item => item.ParentIndexNumber === 2 && item.IndexNumber === 1);
  const createdSeason = seasons.find(item => item.IndexNumber === 2);
  assert.equal(updated.Name, 'Updated Placeholder');
  assert.equal(updated.Overview, 'Updated');
  assert.ok(created);
  assert.ok(createdSeason);
  assert.equal(episodes.some(item => item.Id.toLowerCase() === fixtureIds.foreignDuplicate.toLowerCase()), false,
    'Series after-lifecycle removes a foreign virtual that duplicates a physical slot');
  assert.equal(episodes.some(item => item.Id.toLowerCase() === fixtureIds.orphan.toLowerCase()), false,
    'Series after-lifecycle removes an unnumbered virtual orphan');
  assert.equal(seasons.some(item => item.Id.toLowerCase() === fixtureIds.duplicateSeason.toLowerCase()), false,
    'Series after-lifecycle removes a virtual season that duplicates a physical season');
  assert.equal(seasons.some(item => item.Id.toLowerCase() === fixtureIds.emptySeason.toLowerCase()), false,
    'Series after-lifecycle removes an empty virtual season');
  assert.equal(episodes.some(item => item.ProviderIds.Tmdb === '104'), false,
    'the in-memory filename parse reserves a physical slot without creating a virtual duplicate');
  assert.equal(created.IsVirtualItem, true);
  assert.equal(created.ParentId.toLowerCase(), createdSeason.Id.toLowerCase());
  assert.equal(created.ProviderIds.Tmdb, '201');
  assert.equal(createdSeason.IsVirtualItem, true);
  assert.equal(createdSeason.Name, 'Remote Season Two');
  assert.deepEqual(added.map(value => value[0]), ['Season', 'Episode']);
  const episodeAdded = addedEvents.find(event => event.Item.Type === 'Episode');
  assert.equal(episodeAdded.Parent.Id.toLowerCase(), createdSeason.Id.toLowerCase());
  assert.equal(episodeAdded.Parent.Name, 'Remote Season Two');
  assert.deepEqual(parentMetadataAtDelivery.find(value => value.type === 'Episode'), {
    type: 'Episode', id: createdSeason.Id, name: 'Remote Season Two', language: 'ja', country: 'JP'
  }, 'Episode creation retains the refreshed parent metadata at event delivery');
  await itemCreation.withItem(episodeAdded.Parent.Id, parent => {
    assert.equal(parent.MetadataLanguage, 'ja'); assert.equal(parent.MetadataCountryCode, 'JP');
  });
  assert.deepEqual(calls.find(value => value[0] === 'series'), ['series', 42, 'ja', 'ja,null,en', 'JP']);
  assert.deepEqual(calls.filter(value => value[0] === 'season').map(value => value[2]), [1, 2, 2, 2]);
});
