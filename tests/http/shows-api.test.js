import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect, isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { dateTicks, idKey } from '../../src/library/records.js';
import { similarCachePath } from '../../src/library/similar-items.js';
import { registerDomainRoutes } from '../../src/http/routes.js';
import { captureShows } from './fixtures/shows-current/capture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const oracleInputBytes = await readFile(new URL('./fixtures/shows-current/input.json', import.meta.url));
const oracleInput = JSON.parse(oracleInputBytes);
let capture, native, upcomingNative;
const nativeResult = name => native.results.find(result => result.name === name);
const failureValue = cause => cause == null || typeof cause !== 'object' ? cause : ({
  ...Object.fromEntries(['message', 'code', 'status', 'statusCode', 'errno', 'path', 'syscall', 'retryAfter']
    .map(key => [key, cause[key] ?? null])),
  ...(cause.cause !== undefined ? { cause: failureValue(cause.cause) } : {}),
  ...(Array.isArray(cause.errors) ? { errors: cause.errors.map(failureValue) } : {}),
});
const diagnosticFailure = cause => ({ value: failureValue(cause),
  raw: inspect(cause, { depth: null, maxArrayLength: null }) });
let actualRequestIndex = 0;

async function withProviderFailures(t, fixture, operation) {
  const manager = fixture.runtime.similarItems, matching = manager.matchingProviders, failures = [];
  const rejected = (provider, args, cause) => {
    failures.push({ kind: provider.kind, itemId: args[0]?.Id, userless: args[1]?.user == null,
      failure: failureValue(cause), raw: diagnosticFailure(cause).raw });
    t.diagnostic('actual Similar provider rejection ' + inspect(cause, { depth: null, maxArrayLength: null }));
  };
  manager.matchingProviders = function (...args) {
    return matching.apply(this, args).map(provider => provider.kind === 'local' ? {
      ...provider, async getItems(...args) {
        try { return await provider.getItems(...args); }
        catch (cause) { rejected(provider, args, cause); throw cause; }
      },
    } : provider.kind === 'remote' ? {
      ...provider, async *getReferences(...args) {
        try { yield* provider.getReferences(...args); }
        catch (cause) { rejected(provider, args, cause); throw cause; }
      },
    } : provider);
  };
  try { return await operation(failures); }
  finally { manager.matchingProviders = matching; }
}

before(async () => {
  capture = await captureShows(oracleInputBytes); native = capture.native;
  upcomingNative = nativeResult('upcoming builds the native episode query and counts the paged list');
}, { timeout: 600000 });
after(async () => { await capture?.finish(); });

const ids = Object.fromEntries(['aggregate', 'userRoot', 'physical', 'physicalOther', 'collection', 'collectionOther',
  'view', 'series', 'season0', 'season1', 'season2', 'old', 'special', 'one', 'two', 'missing', 'three', 'alternate',
  'otherSeries', 'otherSeason', 'otherEpisode', 'flagOnly', 'pathOnly', 'nonFolderDescendant',
  'missingParent', 'duplicateSeries', 'duplicateSeason', 'duplicateAlternate', 'duplicateLow', 'duplicateHigh',
  'seasonMissing', 'seasonNull', 'duplicateSeasonAlternate', 'duplicateSeasonHigh',
  'emptySeries', 'liveView', 'liveSeries', 'liveSeason', 'livePlayed', 'liveNext', 'musicView', 'musicCollection',
  'groupedView', 'orphanCollection', 'genre', 'musicArtist', 'similarBoth', 'similarGenreOnly', 'similarTagOnly',
  'similarNeither', 'similarDuplicateLow', 'similarDuplicateHigh', 'similarDenied', 'similarOwned', 'similarAlternate',
  'movie', 'musicAlbum', 'audio', 'trailer', 'excludedArtist',
  'musicArtistInvalid', 'musicArtistValid',
  'artistBoth', 'artistGenreOnly', 'artistTagOnly', 'artistExcluded', 'artistDuplicateLow',
  'artistDuplicateHigh', 'artistDenied',
  'albumBoth', 'albumGenreOnly', 'albumTagOnly', 'albumExcluded',
  'audioBoth', 'audioGenreOnly', 'audioTagOnly', 'audioExcluded', 'liveTvProgram',
  ]
  .map((name, index) => [name, `9a000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, type === 'DateTime' ? '2026-10-01 00:00:00' : column.nullable ? null
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
}));
const item = (Id, Type, values = {}) => ({ ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`,
  Name: values.Name ?? Type.split('.').at(-1), CleanName: (values.Name ?? Type).toLowerCase(),
  SortName: (values.Name ?? Type).toLowerCase(), Data: '{}', MediaType: 'Unknown', ...values });
const episode = (key, season, index, values = {}) => item(ids[key], 'TV.Episode', {
  Name: key, ParentId: ids[`season${season}`], SeasonId: ids[`season${season}`], SeriesId: ids.series,
  TopParentId: ids.physical, SeriesName: 'Fixture Show', SeasonName: `Season ${season}`,
  SeriesPresentationUniqueKey: 'shows-api-series', PresentationUniqueKey: `shows-api-s${season}e${index}`,
  ParentIndexNumber: season, IndexNumber: index, Path: `Z:\\Shows\\Fixture\\S${season}E${index}.mkv`,
  MediaType: 'Video', PremiereDate: '2026-10-08 00:00:00', ...values,
});

async function setup(t) {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `shows_api_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-shows-similar-'));
  const similarCacheRoot=path.join(temporaryRoot,'host','cache','tmdb');
  const similarNow = Date.parse('2026-10-08T03:00:00.000Z');
  const tmdb = { mode: 'success', requests: [] };
  let requestDiagnostics = null;
  const fetchTmdb = async (request, options = {}) => {
      const url = request instanceof URL ? request : new URL(request);
      tmdb.requests.push({ url: url.toString(), aborted: options.signal?.aborted ?? false });
      if (url.pathname.endsWith('/configuration')) return Response.json({ images: {
        base_url: 'http://images.invalid/', secure_base_url: 'https://images.invalid/',
        backdrop_sizes: ['original'], logo_sizes: ['original'], poster_sizes: ['original'],
        profile_sizes: ['original'], still_sizes: ['original'],
      }, change_keys: [] }, { status: 200 });
      if (tmdb.mode === 'throw') throw new TypeError('controlled TMDB transport failure');
      if (tmdb.mode === 'null') return Response.json(null, { status: 200 });
      if (tmdb.mode === 'rate-limit') return Response.json({ status_code: 25,
        status_message: 'controlled rate limit' }, { status: 429, headers: { 'retry-after': '0' } });
      if (tmdb.mode === 'server-error') return Response.json({ status_code: 9,
        status_message: 'controlled server error' }, { status: 500 });
      if (tmdb.mode === 'unresolved') return Response.json({ page: 1,
        results: [{ id: 997, name: 'Missing One' }, { id: 998, name: 'Missing Two' }],
        total_pages: 1, total_results: 2 });
      const page = Number(url.searchParams.get('page'));
      return Response.json(page === 2
        ? { page: 2, results: [{ id: 222222, name: 'Remote Two' }], total_pages: 2, total_results: 3 }
        : { page: 1, results: [{ id: 123456, name: 'Remote One' },
          { id: 999999, name: 'Missing' }], total_pages: 2, total_results: 3 });
    };
  const tmdbOptions = { apiKey: 'fixture-key', baseUrl: 'http://tmdb.invalid/3/',
    configuration: { SimilarItemsCacheDays: 14 }, now: () => similarNow,
    fetch: async (request, options = {}) => {
      const observations = requestDiagnostics?.upstreamObservations;
      if (!observations) return fetchTmdb(request, options);
      const url = new URL(request); url.searchParams.delete('api_key');
      const observation = { source: tmdbClientSource, method: options.method ?? 'GET',
        route: url.pathname + url.search, status: null };
      observations.push(observation);
      let response;
      try { response = await fetchTmdb(request, options); }
      catch (cause) { observation.failure = diagnosticFailure(cause); throw cause; }
      observation.status = response.status; observation.ok = response.ok;
      observation.retryAfter = response.headers.get('retry-after');
      observation.raw = inspect(response, { depth: null, maxArrayLength: null });
      const bytes = Buffer.from(await response.clone().arrayBuffer());
      observation.body = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'), text: bytes.toString('utf8') };
      return response;
    } };
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const errors = [];
  const runtime = await createTestRuntime({ database,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true,
      EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false,
      DisplaySpecialsWithinSeasons: true }, serverId: 'shows-api-test', onError: error => {
      (requestDiagnostics?.errors ?? errors).push(error);
      t.diagnostic('Shows runtime diagnostic ' + inspect(error, { depth: null, maxArrayLength: null }));
    },
    pluginOptions: {directory:path.join(temporaryRoot,'host'),options:{tmdb:tmdbOptions}},
    metadataOptions: { similarCachePath: similarCacheRoot, similarNow: () => similarNow,
    } });
  await runtime.plugins.configure('tmdb',{SimilarItemsCacheDays:14});
  runtime.library.clock = () => new Date('2026-10-08T12:00:00Z');
  t.after(async () => {
    try { await runtime.close(); }
    finally {
      try {
        const cleanup = await PostgresDatabase.open({ connectionString, schema });
        try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`); }
        finally { await cleanup.close(); }
      } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    }
    assert.deepEqual(errors, [], 'Success, background and close diagnostics must have no unclassified failure.');
  });
  const pluginState = JSON.parse(await readFile(path.join(runtime.plugins.directory, 'state.json'), 'utf8'));
  const tmdbClientFile = path.join(runtime.plugins.directory, 'packages', pluginState.plugins.tmdb.package.release, 'client.js');
  const tmdbClientBytes = await readFile(tmdbClientFile), tmdbClientSource = { filename: tmdbClientFile,
    bytes: tmdbClientBytes.length, sha256: createHash('sha256').update(tmdbClientBytes).digest('hex') };
  let aggregate = (await database.rows('BaseItems')).find(row => row.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
  aggregate ??= await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', item(ids.userRoot, 'UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', item(ids.physical, 'Folder', { IsFolder: true, ParentId: aggregate.Id,
    TopParentId: ids.physical, Path: 'Z:\\Shows' }));
  await database.insert('BaseItems', item(ids.physicalOther, 'Folder', { IsFolder: true, ParentId: aggregate.Id,
    TopParentId: ids.physicalOther, Path: 'Y:\\Shows' }));
  await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', { IsFolder: true, ParentId: ids.userRoot,
    Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [ids.physical], PhysicalLocationsList: ['Z:\\Shows'] }) }));
  await database.insert('BaseItems', item(ids.collectionOther, 'CollectionFolder', { IsFolder: true, ParentId: ids.userRoot,
    Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [ids.physicalOther], PhysicalLocationsList: ['Y:\\Shows'] }) }));
  await database.insert('BaseItems', item(ids.musicCollection, 'CollectionFolder', { IsFolder: true, ParentId: aggregate.Id,
    Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.physicalOther], PhysicalLocationsList: ['Y:\\Shows'] }) }));
  await database.insert('BaseItems', item(ids.orphanCollection, 'CollectionFolder', { IsFolder: true, ParentId: aggregate.Id,
    Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [ids.physicalOther], PhysicalLocationsList: ['Y:\\Shows'] }) }));
  await database.insert('BaseItems', item(ids.view, 'UserView', { IsFolder: true, ParentId: ids.userRoot,
    Data: JSON.stringify({ ViewType: 'tvshows', DisplayParentId: ids.collection }) }));
  await database.insert('BaseItems', item(ids.series, 'TV.Series', { Name: 'Fixture Show', IsFolder: true,
    ParentId: ids.physical, TopParentId: ids.physical, Path: 'Z:\\Shows\\Fixture',
    PresentationUniqueKey: 'shows-api-series', Genres: 'Drama|Mystery', Tags: 'Network|Epic', IsSeries: true }));
  await database.insert('BaseItems', item(ids.emptySeries, 'TV.Series', { Name: 'Empty Key Show', IsFolder: true,
    ParentId: ids.physical, TopParentId: ids.physical, Path: 'Z:\\Shows\\Empty',
    PresentationUniqueKey: '', IsSeries: true }));
  for (const season of [0, 1, 2]) await database.insert('BaseItems', item(ids[`season${season}`], 'TV.Season', {
    Name: season ? `Season ${season}` : 'Specials', IsFolder: true, ParentId: ids.series, SeriesId: ids.series,
    TopParentId: ids.physical, Path: `Z:\\Shows\\Fixture\\Season ${season}`, IndexNumber: season,
    SeriesName: 'Fixture Show', SeriesPresentationUniqueKey: 'shows-api-series',
    PresentationUniqueKey: `shows-api-series-${String(season).padStart(3, '0')}`,
    SortName: String(season).padStart(4, '0') }));
  const rows = [
    episode('old', 1, 0, { PremiereDate: '2026-10-05 23:59:59.9999999', SortName: '001 - 0000 - old' }),
    episode('special', 0, 1, { Data: JSON.stringify({ AirsAfterSeasonNumber: 1 }), SortName: '000 - 0001 - special' }),
    episode('one', 1, 1, { PremiereDate: '2026-10-06 00:00:00', SortName: '001 - 0001 - one' }),
    episode('two', 1, 2, { PremiereDate: '2026-10-09 00:00:00', SortName: '001 - 0002 - two' }),
    episode('missing', 1, 3, { Path: null, IsVirtualItem: true, PremiereDate: '2026-10-10 00:00:00', SortName: '001 - 0003 - missing' }),
    episode('three', 2, 1, { PremiereDate: '2026-10-11 00:00:00', SortName: '002 - 0001 - three' }),
    episode('alternate', 1, 2, { Name: 'two-alt', PrimaryVersionId: ids.two,
      PresentationUniqueKey: 'shows-api-s1e2', Path: 'Z:\\Shows\\Fixture\\S1E2-alt.mkv' }),
    episode('flagOnly', 1, 4, { IsVirtualItem: true, PremiereDate: '2026-10-12 00:00:00',
      SortName: '001 - 0004 - flag-only' }),
    episode('pathOnly', 1, 5, { Path: null, IsVirtualItem: false, PremiereDate: '2026-10-13 00:00:00',
      SortName: '001 - 0005 - path-only' }),
  ];
  for (const row of rows) await database.insert('BaseItems', row);
  await database.insert('BaseItems', item(ids.otherSeries, 'TV.Series', { Name: 'Other Show', IsFolder: true,
    ParentId: ids.physicalOther, TopParentId: ids.physicalOther, Path: 'Y:\\Shows\\Other', Tags: 'Blocked',
    PresentationUniqueKey: 'other-series', IsSeries: true }));
  await database.insert('BaseItems', item(ids.otherSeason, 'TV.Season', { Name: 'Other Season', IsFolder: true,
    ParentId: ids.otherSeries, SeriesId: ids.otherSeries, TopParentId: ids.physicalOther, IndexNumber: 1,
    SeriesPresentationUniqueKey: 'other-series', PresentationUniqueKey: 'other-series-001' }));
  await database.insert('BaseItems', item(ids.otherEpisode, 'TV.Episode', { Name: 'other', ParentId: ids.otherSeason,
    SeasonId: ids.otherSeason, SeriesId: ids.otherSeries, TopParentId: ids.physicalOther, MediaType: 'Video',
    ParentIndexNumber: 1, IndexNumber: 1, Path: 'Y:\\Shows\\Other\\S1E1.mkv', PremiereDate: '2026-10-12 00:00:00',
    SeriesPresentationUniqueKey: 'other-series', PresentationUniqueKey: 'other-s1e1' }));
  const nonFolderDescendant = item(ids.nonFolderDescendant, 'TV.Episode', { Name: 'nonfolder-descendant',
    ParentId: ids.otherSeason, SeasonId: ids.otherSeason, SeriesId: ids.otherSeries, TopParentId: ids.physicalOther,
    MediaType: 'Video', ParentIndexNumber: 1, IndexNumber: 3, Path: 'Y:\\Shows\\Other\\descendant.mkv',
    PremiereDate: '2026-10-15 00:00:00', SortName: '901 - nonfolder-descendant',
    SeriesPresentationUniqueKey: 'other-series', PresentationUniqueKey: 'nonfolder-descendant' });
  await database.insert('BaseItems', nonFolderDescendant);

  await database.insert('BaseItems', item(ids.duplicateSeries, 'TV.Series', { Name: 'Duplicate Show', IsFolder: true,
    ParentId: ids.physical, TopParentId: ids.physical, Path: 'Z:\\Shows\\Duplicate',
    PresentationUniqueKey: 'duplicate-series', IsSeries: true }));
  await database.insert('BaseItems', item(ids.duplicateSeason, 'TV.Season', { Name: 'Duplicate Season', IsFolder: true,
    ParentId: ids.duplicateSeries, SeriesId: ids.duplicateSeries, TopParentId: ids.physical, IndexNumber: 1,
    SeriesPresentationUniqueKey: 'duplicate-series', PresentationUniqueKey: 'duplicate-series-001',
    IsVirtualItem: true, SortName: '0001' }));
  const duplicate = (key, name, primaryVersionId, sortName) => item(ids[key], 'TV.Episode', { Name: name,
    ParentId: ids.duplicateSeason, SeasonId: ids.duplicateSeason, SeriesId: ids.duplicateSeries,
    TopParentId: ids.physical, MediaType: 'Video', ParentIndexNumber: 1, IndexNumber: 1,
    Path: `Z:\\Shows\\Duplicate\\${name}.mkv`, PremiereDate: '2025-01-01 00:00:00', SortName: sortName,
    SeriesPresentationUniqueKey: 'duplicate-series', PresentationUniqueKey: 'duplicate-episode', PrimaryVersionId: primaryVersionId });
  const duplicateRows = [
    duplicate('duplicateAlternate', 'duplicate-alternate', ids.otherEpisode, '0000'),
    duplicate('duplicateLow', 'duplicate-low', null, '0001'),
    duplicate('duplicateHigh', 'duplicate-high', null, '0002'),
  ];
  for (const row of duplicateRows) await database.insert('BaseItems', row);
  const additionalSeasons = [
    item(ids.seasonMissing, 'TV.Season', { Name: 'Missing Season', IsFolder: true, IsVirtualItem: true,
      ParentId: ids.series, SeriesId: ids.series, TopParentId: ids.physical, IndexNumber: 3,
      SeriesPresentationUniqueKey: 'shows-api-series', PresentationUniqueKey: 'shows-api-series-003', SortName: '0003' }),
    item(ids.seasonNull, 'TV.Season', { Name: 'Unnumbered Season', IsFolder: true,
      ParentId: ids.series, SeriesId: ids.series, TopParentId: ids.physical, IndexNumber: null,
      SeriesPresentationUniqueKey: 'shows-api-series', PresentationUniqueKey: 'shows-api-series-null', SortName: '9999' }),
    item(ids.duplicateSeasonAlternate, 'TV.Season', { Name: 'Duplicate Season Alternate', IsFolder: true,
      ParentId: ids.duplicateSeries, SeriesId: ids.duplicateSeries, TopParentId: ids.physical, IndexNumber: 1,
      SeriesPresentationUniqueKey: 'duplicate-series', PresentationUniqueKey: 'duplicate-series-001',
      PrimaryVersionId: ids.otherSeason, IsVirtualItem: true, SortName: '0000' }),
    item(ids.duplicateSeasonHigh, 'TV.Season', { Name: 'Duplicate Season High', IsFolder: true,
      ParentId: ids.duplicateSeries, SeriesId: ids.duplicateSeries, TopParentId: ids.physical, IndexNumber: 1,
      SeriesPresentationUniqueKey: 'duplicate-series', PresentationUniqueKey: 'duplicate-series-001', SortName: '0002' }),
  ];
  for (const row of additionalSeasons) await database.insert('BaseItems', row);

  await database.insert('BaseItems', item(ids.genre, 'Genre', { Name: 'Drama' }));
  await database.insert('BaseItems', item(ids.musicArtist, 'Audio.MusicArtist', { Name: 'Fixture Artist',
    IsFolder: true, ParentId: ids.physical, TopParentId: ids.physical,
    Genres: 'Drama|Mystery', Tags: 'Network|Epic', PresentationUniqueKey: 'fixture-artist' }));
  await database.insert('BaseItems', item(ids.movie, 'Movies.Movie', { Name: 'Fixture Movie', MediaType: 'Video',
    PresentationUniqueKey: 'fixture-movie' }));
  await database.insert('BaseItems', item(ids.musicAlbum, 'Audio.MusicAlbum', { Name: 'Fixture Album', IsFolder: true,
    ParentId: ids.physical, TopParentId: ids.physical,
    Genres: 'Drama|Mystery', Tags: 'Network|Epic', PresentationUniqueKey: 'fixture-album' }));
  await database.insert('BaseItems', item(ids.audio, 'Audio.Audio', { Name: 'Fixture Audio', MediaType: 'Audio',
    ParentId: ids.physical, TopParentId: ids.physical,
    Genres: 'Drama|Mystery', Tags: 'Network|Epic', PresentationUniqueKey: 'fixture-audio' }));
  await database.insert('BaseItems', item(ids.trailer, 'Trailer', { Name: 'Fixture Trailer', MediaType: 'Video',
    PresentationUniqueKey: 'fixture-trailer' }));
  await database.insert('BaseItems', item(ids.excludedArtist, 'Audio.MusicArtist', {
    Name: 'Excluded Artist', IsFolder: true, ParentId: ids.physical, TopParentId: ids.physical,
    PresentationUniqueKey: 'excluded-artist' }));
  await database.insert('BaseItems', item(ids.musicArtistInvalid, 'Audio.MusicArtist', {
    Name: 'Invalid Remote Artist', IsFolder: true, ParentId: ids.physical, TopParentId: ids.physical,
    PresentationUniqueKey: 'invalid-remote-artist' }));
  await database.insert('BaseItems', item(ids.musicArtistValid, 'Audio.MusicArtist', {
    Name: 'Valid Remote Artist', IsFolder: true, ParentId: ids.physical, TopParentId: ids.physical,
    PresentationUniqueKey: 'valid-remote-artist' }));
  const similarSeries = (key, name, presentationUniqueKey, topParentId = ids.physical, values = {}) =>
    item(ids[key], 'TV.Series', { Name: name, IsFolder: true, IsSeries: true,
      ParentId: topParentId, TopParentId: topParentId,
      Path: `${topParentId === ids.physical ? 'Z' : 'Y'}:\\Shows\\${name}`,
      PresentationUniqueKey: presentationUniqueKey, ...values });
  const similarRows = [
    similarSeries('similarBoth', 'Similar Both', 'similar-both'),
    similarSeries('similarGenreOnly', 'Similar Genre Only', 'similar-genre-only'),
    similarSeries('similarTagOnly', 'Similar Tag Only', 'similar-tag-only'),
    similarSeries('similarNeither', 'Similar Neither', 'similar-neither'),
    similarSeries('similarDuplicateLow', 'Similar Duplicate Low', 'similar-shared'),
    similarSeries('similarDuplicateHigh', 'Similar Duplicate High', 'similar-shared'),
    similarSeries('similarDenied', 'Similar Denied', 'similar-denied', ids.physicalOther),
    similarSeries('similarOwned', 'Similar Owned', 'similar-owned', ids.physical, { OwnerId: ids.series }),
    similarSeries('similarAlternate', 'Similar Alternate', 'similar-alternate', ids.physical,
      { PrimaryVersionId: ids.similarBoth }),
  ];
  for (const row of similarRows) await database.insert('BaseItems', row);
  const similarMusic = (key, nativeType, name, presentationUniqueKey, topParentId = ids.physical) =>
    item(ids[key], nativeType, { Name: name, IsFolder: nativeType !== 'Audio.Audio',
      MediaType: nativeType === 'Audio.Audio' ? 'Audio' : 'Unknown', ParentId: topParentId,
      TopParentId: topParentId, PresentationUniqueKey: presentationUniqueKey });
  const similarMusicRows = [
    similarMusic('artistBoth', 'Audio.MusicArtist', 'Artist Both', 'artist-both'),
    similarMusic('artistGenreOnly', 'Audio.MusicArtist', 'Artist Genre Only', 'artist-genre-only'),
    similarMusic('artistTagOnly', 'Audio.MusicArtist', 'Artist Tag Only', 'artist-tag-only'),
    similarMusic('artistExcluded', 'Audio.MusicArtist', 'Artist Excluded', 'artist-excluded'),
    similarMusic('artistDuplicateLow', 'Audio.MusicArtist', 'Artist Duplicate Low', 'artist-shared'),
    similarMusic('artistDuplicateHigh', 'Audio.MusicArtist', 'Artist Duplicate High', 'artist-shared'),
    similarMusic('artistDenied', 'Audio.MusicArtist', 'Artist Denied', 'artist-denied', ids.physicalOther),
    similarMusic('albumBoth', 'Audio.MusicAlbum', 'Album Both', 'album-both'),
    similarMusic('albumGenreOnly', 'Audio.MusicAlbum', 'Album Genre Only', 'album-genre-only'),
    similarMusic('albumTagOnly', 'Audio.MusicAlbum', 'Album Tag Only', 'album-tag-only'),
    similarMusic('albumExcluded', 'Audio.MusicAlbum', 'Album Excluded', 'album-excluded'),
    similarMusic('audioBoth', 'Audio.Audio', 'Audio Both', 'audio-both'),
    similarMusic('audioGenreOnly', 'Audio.Audio', 'Audio Genre Only', 'audio-genre-only'),
    similarMusic('audioTagOnly', 'Audio.Audio', 'Audio Tag Only', 'audio-tag-only'),
    similarMusic('audioExcluded', 'Audio.Audio', 'Audio Excluded', 'audio-excluded'),
  ];
  for (const row of similarMusicRows) await database.insert('BaseItems', row);
  const valueRows = [
    ['b1000000-0000-0000-0000-000000000001', 2, 'Drama',
      [ids.series, ids.similarBoth, ids.similarGenreOnly, ids.similarDuplicateHigh, ids.similarDenied,
        ids.similarOwned, ids.similarAlternate, ids.musicArtist, ids.musicAlbum, ids.audio,
        ids.artistBoth, ids.artistGenreOnly, ids.artistExcluded, ids.artistDenied,
        ids.albumBoth, ids.albumGenreOnly, ids.albumExcluded,
        ids.audioBoth, ids.audioGenreOnly, ids.audioExcluded]],
    ['b1000000-0000-0000-0000-000000000002', 2, 'Mystery',
      [ids.musicArtist, ids.musicAlbum, ids.audio, ids.similarDuplicateLow,
        ids.artistDuplicateLow, ids.artistDuplicateHigh]],
    ['b1000000-0000-0000-0000-000000000003', 2, 'Comedy', [ids.similarNeither]],
    ['b1000000-0000-0000-0000-000000000004', 4, 'Network',
      [ids.series, ids.similarBoth, ids.similarTagOnly, ids.similarDuplicateHigh, ids.similarDenied,
        ids.similarOwned, ids.similarAlternate, ids.musicArtist, ids.musicAlbum, ids.audio,
        ids.artistBoth, ids.artistTagOnly, ids.artistExcluded, ids.artistDenied,
        ids.albumBoth, ids.albumTagOnly, ids.albumExcluded,
        ids.audioBoth, ids.audioTagOnly, ids.audioExcluded]],
    ['b1000000-0000-0000-0000-000000000005', 4, 'Epic',
      [ids.musicArtist, ids.musicAlbum, ids.audio, ids.similarDuplicateLow,
        ids.artistDuplicateLow, ids.artistDuplicateHigh]],
    ['b1000000-0000-0000-0000-000000000006', 4, 'Other', [ids.similarNeither]],
    ['b1000000-0000-0000-0000-000000000007', 0, 'Excluded Artist',
      [ids.artistExcluded, ids.albumExcluded, ids.audioExcluded]],
  ];
  for (const [ItemValueId, Type, Value, itemIds] of valueRows) {
    await database.insert('ItemValues', { ItemValueId, Type, Value, CleanValue: Value.toLowerCase() });
    for (const ItemId of itemIds) await database.insert('ItemValuesMap', { ItemValueId, ItemId });
  }
  await database.insert('BaseItemProviders', {
    ItemId: ids.similarBoth, ProviderId: 'Tmdb', ProviderValue: '123456',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.similarGenreOnly, ProviderId: 'Tmdb', ProviderValue: '222222',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.series, ProviderId: 'Tmdb', ProviderValue: '654321',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.artistBoth, ProviderId: 'MusicBrainzArtist',
    ProviderValue: 'b1000000-0000-0000-0000-000000000099',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.musicArtistInvalid, ProviderId: 'MusicBrainzArtist', ProviderValue: 'not-a-guid',
  });
  await database.insert('BaseItemProviders', {
    ItemId: ids.musicArtistValid, ProviderId: 'MusicBrainzArtist',
    ProviderValue: 'b1000000-0000-0000-0000-000000000098',
  });

  await database.insert('BaseItems', item(ids.liveView, 'UserView', { Name: 'Live TV', IsFolder: true,
    Data: JSON.stringify({ ViewType: 'livetv' }) }));
  await database.insert('BaseItems', item(ids.musicView, 'UserView', { Name: 'Music', IsFolder: true,
    Data: JSON.stringify({ ViewType: 'music' }) }));
  await database.insert('BaseItems', item(ids.groupedView, 'UserView', { Name: 'Grouped TV', IsFolder: true,
    Data: JSON.stringify({ ViewType: 'tvshows' }) }));
  await database.insert('BaseItems', item(ids.liveSeries, 'TV.Series', { Name: 'Live Show', IsFolder: true,
    ParentId: ids.liveView, TopParentId: ids.liveView, PresentationUniqueKey: 'live-series', IsSeries: true }));
  await database.insert('BaseItems', item(ids.liveSeason, 'TV.Season', { Name: 'Live Season', IsFolder: true,
    ParentId: ids.liveSeries, SeriesId: ids.liveSeries, TopParentId: ids.liveView, IndexNumber: 1,
    SeriesPresentationUniqueKey: 'live-series', PresentationUniqueKey: 'live-series-001' }));
  for (const [key, index] of [['livePlayed', 1], ['liveNext', 2]]) {
    await database.insert('BaseItems', item(ids[key], 'TV.Episode', { Name: key, ParentId: ids.liveSeason,
      SeasonId: ids.liveSeason, SeriesId: ids.liveSeries, TopParentId: ids.liveView, MediaType: 'Video',
      ParentIndexNumber: 1, IndexNumber: index, Path: `L:\\Live\\${key}.mkv`,
      SeriesPresentationUniqueKey: 'live-series', PresentationUniqueKey: `live-series-${index}` }));
  }

  const parents = new Map([[ids.series, [ids.physical, aggregate.Id]],
    [ids.otherSeries, [ids.physicalOther, aggregate.Id]], [ids.duplicateSeries, [ids.physical, aggregate.Id]],
    [ids.emptySeries, [ids.physical, aggregate.Id]],
    [ids.liveSeries, [ids.liveView]], [ids.liveSeason, [ids.liveSeries, ids.liveView]],
    ...[0, 1, 2].map(number => [ids[`season${number}`], [ids.series, ids.physical, aggregate.Id]]),
    [ids.seasonMissing, [ids.series, ids.physical, aggregate.Id]],
    [ids.seasonNull, [ids.series, ids.physical, aggregate.Id]],
    [ids.otherSeason, [ids.otherSeries, ids.physicalOther, aggregate.Id]],
    [ids.duplicateSeason, [ids.duplicateSeries, ids.physical, aggregate.Id]],
    [ids.duplicateSeasonAlternate, [ids.duplicateSeries, ids.physical, aggregate.Id]],
    [ids.duplicateSeasonHigh, [ids.duplicateSeries, ids.physical, aggregate.Id]]]);
  for (const key of ['musicArtist', 'musicAlbum', 'audio', 'excludedArtist', 'musicArtistInvalid',
    'musicArtistValid', 'artistBoth', 'artistGenreOnly', 'artistTagOnly', 'artistExcluded',
    'artistDuplicateLow', 'artistDuplicateHigh', 'artistDenied', 'albumBoth', 'albumGenreOnly',
    'albumTagOnly', 'albumExcluded', 'audioBoth', 'audioGenreOnly', 'audioTagOnly', 'audioExcluded']) {
    const top = key === 'artistDenied' ? ids.physicalOther : ids.physical;
    parents.set(ids[key], [top, aggregate.Id]);
  }
  for (const row of [...rows, { Id: ids.otherEpisode, ParentId: ids.otherSeason }, nonFolderDescendant,
    ...duplicateRows, { Id: ids.livePlayed, ParentId: ids.liveSeason }, { Id: ids.liveNext, ParentId: ids.liveSeason }]) {
    const chain = row.Id === ids.otherEpisode ? [ids.otherSeason, ids.otherSeries, ids.physicalOther, aggregate.Id]
      : row.Id === ids.nonFolderDescendant ? [ids.otherSeason, ids.otherSeries, ids.physicalOther, aggregate.Id, ids.two]
        : [ids.livePlayed, ids.liveNext].includes(row.Id) ? [ids.liveSeason, ids.liveSeries, ids.liveView]
          : duplicateRows.includes(row) ? [ids.duplicateSeason, ids.duplicateSeries, ids.physical, aggregate.Id]
            : [row.ParentId, ids.series, ids.physical, aggregate.Id];
    parents.set(row.Id, chain);
  }
  for (const [ItemId, ancestors] of parents) for (const ParentItemId of ancestors) {
    await database.insert('AncestorIds', { ItemId, ParentItemId });
  }
  const created = await runtime.users.createUser({ Name: 'ShowsReader', Password: 'password' });
  const other = await runtime.users.createUser({ Name: 'OtherShowsReader', Password: 'password' });
  const persistedUser = (await database.rows('Users')).find(row => row.Username === 'ShowsReader');
  const userData = (ItemId, values = {}) => ({ ItemId, UserId: persistedUser.Id, CustomDataKey: ItemId,
    AudioStreamIndex: null, IsFavorite: false, LastPlayedDate: null, Likes: null, PlayCount: 0,
    PlaybackPositionTicks: 0n, Played: false, Rating: null, RetentionDate: null,
    SubtitleStreamIndex: null, ...values });
  const seedNextUpUserData = async () => {
    await database.insert('UserData', userData(ids.old, {
      LastPlayedDate: '2026-10-07 00:00:00', PlayCount: 1, Played: true }));
    await database.insert('UserData', userData(ids.one, {
      LastPlayedDate: '2026-10-06 00:00:00', PlayCount: 1, Played: true }));
    await database.insert('UserData', userData(ids.two, {
      LastPlayedDate: '2026-10-06 12:00:00', PlaybackPositionTicks: 1000n }));
    await database.insert('UserData', userData(ids.otherEpisode, {
      LastPlayedDate: '2026-10-05 20:00:00', PlayCount: 1, Played: true }));
    await database.insert('UserData', userData(ids.livePlayed, {
      LastPlayedDate: '2026-10-04 00:00:00', PlayCount: 1, Played: true }));
  };
  const login = await runtime.authentication.login({ Username: 'ShowsReader', Pw: 'password' }, {
    Client: 'ShowsApiTest', Device: 'Test', DeviceId: 'shows-postgres', Version: '1'
  }, { remoteEndPoint: '127.0.0.1' });
  const api = await runtime.apiKeys.create('Shows API PostgreSQL');
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  // This fixture sends requests sequentially. Keep diagnostics with the actual
  // response; a 200 fallback may only admit the explicitly observed failure.
  const request = async (route, token = login.AccessToken, { providerFailures = [], upstreamObservations, inputFailures = [] } = {}) => {
    const receipt = { name: 'actual-shows-request', index: ++actualRequestIndex, fixture: schema,
      method: 'GET', route, status: null, errors: [], upstreamObservations }, previous = requestDiagnostics;
    requestDiagnostics = receipt;
    try {
      const response = await fetch(origin + route, {
        method: receipt.method,
        headers: token ? { Authorization: `MediaBrowser Token="${token}"` } : {},
      });
      receipt.status = response.status;
      for (const error of receipt.errors) {
        const publicFailure = response.status >= 400 && response.status < 500
          && (error.status ?? error.statusCode) === response.status;
        const value = failureValue(error);
        const observedFailure = providerFailures.map(entry => entry.failure).concat(inputFailures,
          (upstreamObservations ?? []).flatMap(entry => entry.failure ? [entry.failure.value] : []))
          .some(observed => isDeepStrictEqual(value, observed));
        // The real client cancels each non-404 error response and throws its
        // actual HTTP status and Retry-After. An unrelated PG/IO failure must
        // not be admitted merely because this request also saw an HTTP error.
        const upstreamHttpFailure = (upstreamObservations ?? []).some(entry => entry.status != null
          && !entry.ok && entry.status !== 404 && value?.status === entry.status && value.retryAfter === entry.retryAfter
          && ['code', 'statusCode', 'errno', 'path', 'syscall'].every(key => value[key] == null)
          && !Object.hasOwn(value, 'cause') && !Object.hasOwn(value, 'errors'));
        if (!publicFailure && !observedFailure && !upstreamHttpFailure) errors.push(error);
      }
      return response;
    } catch (cause) {
      receipt.failure = diagnosticFailure(cause);
      errors.push(...receipt.errors); throw cause;
    } finally {
      requestDiagnostics = previous;
      t.diagnostic(JSON.stringify({ ...receipt, errors: receipt.errors.map(diagnosticFailure),
        providerFailures, upstreamObservations: upstreamObservations ?? [], inputFailures }));
    }
  };
  const similarReads = new AsyncLocalStorage(), querySimilarItems = runtime.library.querySimilarItems.bind(runtime.library);
  runtime.library.querySimilarItems = (...args) => similarReads.run(true, () => querySimilarItems(...args));
  const originalRows = database.rows.bind(database);
  database.rows = (name, options) => {
    const bounded = options?.where || options?.whereIn || options?.limit !== undefined;
    if (similarReads.getStore() && name === 'BaseItems' && !bounded) {
      throw new Error('Similar items attempted an unbounded PostgreSQL BaseItems read.');
    }
    return originalRows(name, options);
  };
  return { runtime, database, errors, request, seedNextUpUserData, tmdb, similarCacheRoot, similarNow,
    userId: idKey(created.Id), otherUserId: idKey(other.Id), apiKey: api.AccessToken };
}

test('Movie, Trailer and Live TV Similar run configured providers through PostgreSQL HTTP paths', async t => {
  const fixture = await setup(t);
  const itemIds = body => new Set(body.Items.map(row => row.Id));
  const movieFirst = '9a000000-0000-0000-0000-000000000970';
  const movieSecond = '9a000000-0000-0000-0000-000000000971';
  const movieValue = 'b1000000-0000-0000-0000-000000000001';
  await fixture.database.update('BaseItems', { Id: ids.movie }, { Name: 'Movie Source', ParentId: ids.physical,
    TopParentId: ids.physical, Genres: 'Drama', Tags: 'Network' });
  await fixture.database.update('BaseItems', { Id: ids.trailer }, { ParentId: ids.physical, TopParentId: ids.physical,
    Genres: 'Drama', Tags: 'Network' });
  for (const [Id, Name] of [[movieFirst, 'Movie First'], [movieSecond, 'Movie Second']]) {
    await fixture.database.insert('BaseItems', item(Id, 'Movies.Movie', {
      Name, ParentId: ids.physical, TopParentId: ids.physical,
      PresentationUniqueKey: Name, MediaType: 'Video', Genres: 'Drama', IsMovie: true,
    }));
  }
  for (const ItemId of [ids.movie, ids.trailer, movieFirst, movieSecond]) {
    await fixture.database.insert('ItemValuesMap', { ItemId, ItemValueId: movieValue });
  }
  await fixture.database.insert('ItemValuesMap', { ItemId: movieFirst, ItemValueId: 'b1000000-0000-0000-0000-000000000004' });
  let response = await fixture.request(`/Movies/${ids.movie}/Similar?Limit=50&EnableImages=false&EnableUserData=false`);
  assert.equal(response.status, 200); let body = await response.json();
  assert.ok(itemIds(body).has(idKey(movieFirst)) && itemIds(body).has(idKey(movieSecond)));
  assert.ok(body.Items.every(row => Object.hasOwn(row, 'ProviderIds') && !Object.hasOwn(row, 'UserData')));
  response = await fixture.request(`/Trailers/${ids.trailer}/Similar?Limit=50&EnableImages=false`);
  assert.equal(response.status, 200); assert.ok(itemIds(await response.json()).has(idKey(movieFirst)));
  await withProviderFailures(t, fixture, async failures => {
    response = await fixture.request(`/Movies/${ids.movie}/Similar?Limit=2&EnableImages=false`, fixture.apiKey,
      { providerFailures: failures });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    assert.ok(failures.some(value => value.kind === 'local' && idKey(value.itemId) === idKey(ids.movie) && value.userless),
      'The actual userless local provider rejected after the same source returned scored candidates for a user.');
  });
  assert.deepEqual(fixture.errors, []);

  await fixture.database.insert('BaseItems', { ...item(ids.liveTvProgram, 'LiveTvProgram', {
    Name: 'Similarity Program', ParentId: ids.physical, TopParentId: ids.physical,
    Genres: 'Drama', Tags: 'Network', PresentationUniqueKey: 'similarity-program', IsMovie: true, IsSeries: true,
  }), Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram' });
  response = await fixture.request(`/Items/${ids.liveTvProgram}/Similar?Limit=50&EnableImages=false`, fixture.apiKey);
  assert.equal(response.status, 200); body = await response.json();
  assert.ok(itemIds(body).has(idKey(movieFirst)) && !itemIds(body).has(idKey(movieSecond)), 'live-TV movie branch uses AND genre/tag, not weighted union');
  await fixture.database.update('BaseItems', { Id: ids.liveTvProgram }, { IsMovie: false });
  response = await fixture.request(`/Items/${ids.liveTvProgram}/Similar?Limit=50&EnableImages=false`, fixture.apiKey);
  assert.equal(response.status, 200); body = await response.json();
  assert.ok(body.Items.length > 0 && body.Items.every(row => row.Type === 'Series'));
  await fixture.database.update('BaseItems', { Id: ids.liveTvProgram }, { IsSeries: false });
  response = await fixture.request(`/Items/${ids.liveTvProgram}/Similar?Limit=50&EnableImages=false`, fixture.apiKey);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0, StartIndex: 0 });

  for (const [ItemId, ProviderValue] of [[ids.movie, '17'], [movieFirst, '123456'], [movieSecond, '222222']]) {
    await fixture.database.insert('BaseItemProviders', { ItemId, ProviderId: 'Tmdb', ProviderValue });
  }
  fixture.runtime.library.options.libraryOptions = new Map([[idKey(ids.collection), { TypeOptions: [{
    Type: 'Movie', SimilarItemProviders: ['TheMovieDb'], SimilarItemProviderOrder: ['TheMovieDb', 'Local Genre/Tag'],
  }] }]]);
  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Movies/${ids.movie}/Similar?Limit=2&EnableImages=false`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).Items.map(row => row.Id), [movieFirst, movieSecond].map(idKey));
  assert.ok(fixture.tmdb.requests.some(entry => new URL(entry.url).pathname === '/3/movie/17/recommendations'));
  assert.ok(fixture.tmdb.requests.every(entry => !new URL(entry.url).pathname.includes('/tv/')));
  const cache = JSON.parse(await readFile(similarCachePath(fixture.similarCacheRoot, 'TheMovieDb', 'Movie', ids.movie), 'utf8'));
  assert.equal(cache.ExpiresAt, '2026-10-22T03:00:00.0000000Z');
  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Movies/${ids.movie}/Similar?Limit=2&EnableImages=false`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).Items.map(row => row.Id), [movieFirst, movieSecond].map(idKey));
  assert.deepEqual(fixture.tmdb.requests, []);
  assert.deepEqual(fixture.errors, []);
});

test('Shows API oracle binds designated sources, real DLL execution, inputs and independent repeat', async t => {
  assert.equal(capture.sourceBindings.length, 48);
  assert.equal(capture.receipts.length, 2);
  assert.notEqual(capture.receipts[0].process.args[0], capture.receipts[1].process.args[0]);
  for(const recording of capture.receipts){
    assert.equal(recording.passed,true);assert.equal(recording.build.status,0);assert.equal(recording.process.status,0);
  }
  const second = capture.repeat;
  for(const result of [native,second]) {
    assert.equal(result.inputSha256,capture.inputSha256);
    assert.match(result.runtimeAssemblyScope,/not a complete build-input dependency closure/);
    assert.equal(result.candidateVerified, false);
  }
  const projection=value=>{
    const result=structuredClone(value);
    // The native cache expiry is tied to each real execution clock. Its
    // duration is tested by the provider contract; paths identify each build.
    const cache = result.similarProviderOrchestration.first.cache;
    assert.match(cache.expiresAtTicks,/^\d+$/u);
    assert.equal(cache.expiresAtKind, 'Utc');
    assert.equal(Buffer.byteLength(cache.rawJson, 'utf8'), cache.byteLength);
    const document = JSON.parse(cache.rawJson);
    assert.deepEqual(Object.keys(document), cache.propertyNames);
    assert.equal(dateTicks(document.ExpiresAt).toString(), cache.expiresAtTicks);
    assert.equal(cache.rawJson.replace(JSON.stringify(document.ExpiresAt), '"$EXPIRES_AT"'), cache.rawJsonTemplate);
    // The raw bytes remain evidence. Their length varies with the real clock's
    // fractional-second encoding even when the complete cache template agrees.
    cache.rawJson='<execution-clock-json>';
    cache.byteLength='<execution-clock-json-length>';
    cache.expiresAtTicks='<execution-clock>';
    result.runtimeAssemblies=result.runtimeAssemblies.filter(entry=>entry.name!=='Oracle').map(({path,...entry})=>entry);
    return result;
  };
  assert.deepEqual(projection(native),projection(second));
  assert.equal(native.results.length,oracleInput.length);
  assert.match(native.boundary, /^Actual designated TvShowsController/u);
  assert.deepEqual(upcomingNative.queries[0].includeItemTypes, ['Episode']);
  assert.deepEqual(upcomingNative.queries[0].orderBy, [
    { OrderBy: 'PremiereDate', SortOrder: 'Ascending' }, { OrderBy: 'SortName', SortOrder: 'Ascending' },
  ]);
  assert.deepEqual(upcomingNative.dto, [{
    fields: ['SortName', 'ParentId'], EnableImages: false, EnableUserData: false,
    ImageTypeLimit: 1, imageTypes: ['Primary', 'Backdrop'], user: 'shows-reader',
  }]);
  assert.equal(upcomingNative.queries[0].ParentId, '91000000-0000-0000-0000-000000000099');
  const zeroParent = nativeResult('upcoming Guid.Empty remains unscoped at the controller boundary');
  assert.equal(zeroParent.queries[0].ParentId, '00000000-0000-0000-0000-000000000000');
  assert.equal(zeroParent.queries[0].Recursive, true);
  assert.equal(nativeResult('upcoming preserves a persisted series parent for LibraryManager translation')
    .queries[0].ParentId, '91000000-0000-0000-0000-000000000001');
  assert.equal(nativeResult('upcoming preserves a persisted nonfolder parent for LibraryManager translation')
    .queries[0].ParentId, '91000000-0000-0000-0000-000000000013');
  const negativePaging = nativeResult('upcoming preserves negative StartIndex and Limit on the repository query');
  assert.equal(negativePaging.startIndex, -1);
  assert.equal(negativePaging.queries[0].StartIndex, -1); assert.equal(negativePaging.queries[0].Limit, -1);
  const userEpisodes = nativeResult('series episodes hide missing episodes for the default user');
  const userlessEpisodes = nativeResult('series episodes include missing episodes for an api key without a user');
  assert.equal(userEpisodes.queries[0].user, 'shows-reader');
  assert.equal(userEpisodes.queries[0].GroupByPresentationUniqueKey, true);
  assert.equal(userlessEpisodes.queries[0].user, null);
  assert.deepEqual(native.sqliteRepository.userless,
    ['dup-alternate-lower-id', 'dup-primary-low', 'dup-primary-high', 'unique']);
  assert.deepEqual(native.sqliteRepository.grouped, ['dup-primary-low', 'unique']);
  assert.deepEqual(native.sqliteRepository.negativeLimit, native.sqliteRepository.userless);
  assert.deepEqual(native.sqliteRepository.negativeStart, ['dup-alternate-lower-id', 'dup-primary-low']);
  assert.equal(native.sqliteRepository.negativeStartIndex, -1);
  assert.equal(native.sqliteRepository.negativeLimitValue, -1);
  assert.deepEqual(native.sqliteRepository.emptyParentScope,
    { topParentIds: 0, ancestorIds: 1, sentinelIsNonEmpty: true, keys: [] });
  assert.deepEqual(native.sqliteRepository.userViewParentScopes,
    { liveTv: ['92000000-0000-0000-0000-000000000081'], music: [] });
  assert.deepEqual(native.sqliteRepository.seasonsUserless,
    ['season-alternate', 'season-primary-low', 'season-primary-high']);
  assert.deepEqual(native.sqliteRepository.seasonsGrouped, ['season-primary-low']);
  assert.deepEqual(native.sqliteRepository.seasonsFilteredBeforeGrouping, ['season-primary-high']);
  assert.deepEqual(native.sqliteRepository.nextUp, {
    keys: ['repository-next-up'], cutoffKeys: [], lastWatched: 'next-last', next: 'next-candidate',
    specials: ['next-special'], lastForRewatching: 'next-old', nextForRewatching: 'next-last',
  });
  const nextUpBound = nativeResult('next up binds every controller option and preserves negative paging');
  assert.equal(nextUpBound.startIndex, -1); assert.equal(nextUpBound.totalRecordCount, 7);
  assert.deepEqual(nextUpBound.items, ['one', 'two']);
  assert.deepEqual(nextUpBound.queries[0], {
    operation: 'GetNextUp', user: 'shows-reader', StartIndex: -1, Limit: -1,
    SeriesId: '91000000-0000-0000-0000-000000000001',
    ParentId: '91000000-0000-0000-0000-000000000003', EnableTotalRecordCount: false,
    NextUpDateCutoff: '2026-10-06T00:00:00Z', EnableResumable: false, EnableRewatching: true,
    dtoFields: ['SortName', 'ParentId'], EnableImages: false, EnableUserData: false,
    ImageTypeLimit: 1, imageTypes: ['Primary', 'Backdrop'],
  });
  const nextUpDefaults = nativeResult('next up applies controller defaults').queries[0];
  assert.deepEqual({ StartIndex: nextUpDefaults.StartIndex, Limit: nextUpDefaults.Limit,
    SeriesId: nextUpDefaults.SeriesId, ParentId: nextUpDefaults.ParentId,
    EnableTotalRecordCount: nextUpDefaults.EnableTotalRecordCount,
    NextUpDateCutoff: nextUpDefaults.NextUpDateCutoff, EnableResumable: nextUpDefaults.EnableResumable,
    EnableRewatching: nextUpDefaults.EnableRewatching }, {
    StartIndex: null, Limit: null, SeriesId: null, ParentId: null, EnableTotalRecordCount: true,
    NextUpDateCutoff: '0001-01-01T00:00:00', EnableResumable: true, EnableRewatching: false,
  });
  assert.deepEqual(nativeResult('next up returns not found for an unresolved user'), {
    name: 'next up returns not found for an unresolved user', status: 404, error: null, queries: [], dto: [],
  });
  const emptyManager = nativeResult('next up controller preserves requested start over an empty manager result');
  assert.deepEqual({ startIndex: emptyManager.startIndex, totalRecordCount: emptyManager.totalRecordCount,
    items: emptyManager.items }, { startIndex: -2, totalRecordCount: 0, items: [] });
  const managerCase = name => native.tvSeriesManager.cases.find(entry => entry.name === name);
  assert.deepEqual(managerCase('resumable disabled rejects the next episode').items, []);
  assert.deepEqual(managerCase('rewatching adds the played successor').items, ['one', 'two']);
  assert.deepEqual(managerCase('negative paging is preserved and unbounded'), {
    name: 'negative paging is preserved and unbounded', items: ['one', 'two'], TotalRecordCount: 2,
    StartIndex: -1, calls: managerCase('negative paging is preserved and unbounded').calls,
  });
  assert.equal(managerCase('total count can be disabled').TotalRecordCount, 0);
  assert.deepEqual(managerCase('series scope bypasses key discovery').calls.map(call => call.operation),
    ['GetNextUpEpisodesBatch']);
  assert.equal(managerCase('missing series scope keeps unbounded key discovery').calls[0].limit, null);
  assert.equal(managerCase('non-series scope keeps unbounded key discovery').calls[0].limit, null);
  assert.equal(managerCase('empty series key caps discovery at eleven').calls[0].limit, 11);
  assert.deepEqual(managerCase('empty series key caps discovery at eleven').calls[0].parents, ['Season 1']);
  assert.deepEqual(managerCase('parent scope passes the resolved parent').calls[0].parents, ['Season 1']);
  assert.deepEqual(managerCase('missing parent passes an empty parent list').calls[0].parents, []);
  assert.equal(managerCase('date cutoff reaches key discovery').calls[0].cutoff, '2026-10-06T00:00:00Z');
  assert.deepEqual(managerCase('empty keys reset the requested start index').items, []);
  assert.equal(managerCase('empty keys reset the requested start index').StartIndex, 0);
  assert.deepEqual(native.dateTimeBinding.results, [
    { input: '', IsModelSet: true, value: null, kind: null, errors: [] },
    { input: ' ', IsModelSet: true, value: null, kind: null, errors: [] },
    { input: '2026-10-06', IsModelSet: true, value: '2026-10-06T00:00:00.0000000', kind: 'Unspecified', errors: [] },
    { input: '2026-10-06T00:00:00Z', IsModelSet: true, value: '2026-10-06T00:00:00.0000000Z', kind: 'Utc', errors: [] },
    { input: '2026-10-06T00:00:00+08:00', IsModelSet: true, value: '2026-10-05T16:00:00.0000000Z', kind: 'Utc', errors: [] },
    { input: 'bad', IsModelSet: false, value: null, kind: null, errors: ["The value 'bad' is not valid."] },
  ]);
  assert.deepEqual(native.guidEmptyHttp.nextUpParent,
    { name: 'next up Guid.Empty parent', status: 400, contentType: 'text/plain', body: 'Error processing request.' });
  assert.deepEqual(native.guidEmptyHttp.seasonsSeries,
    { name: 'seasons Guid.Empty series', status: 400, contentType: 'text/plain', body: 'Error processing request.' });
  const seasonsDefault = nativeResult('seasons hide missing rows for the default user');
  assert.deepEqual(seasonsDefault.items, ['Specials', 'Season 1', 'Season 2', 'Unnumbered Season']);
  assert.equal(seasonsDefault.queries[0].user, 'shows-reader');
  assert.equal(seasonsDefault.queries[0].IsMissing, false);
  assert.deepEqual(nativeResult('seasons respect missing filter when the user displays missing episodes').items,
    ['Missing Season']);
  const seasonsUserless = nativeResult('seasons are userless for an api key');
  assert.equal(seasonsUserless.queries[0].user, null); assert.equal(seasonsUserless.queries[0].IsMissing, null);
  assert.deepEqual(seasonsUserless.items,
    ['Specials', 'Season 1', 'Season 2', 'Missing Season', 'Unnumbered Season']);
  assert.deepEqual(nativeResult('seasons select the special season').items, ['Specials']);
  assert.deepEqual(nativeResult('season adjacency follows native filtered sort order').items,
    ['Specials', 'Season 1', 'Season 2']);
  assert.deepEqual(nativeResult('user seasons group duplicate presentation keys').items, ['Duplicate Season High']);
  assert.deepEqual(nativeResult('userless seasons retain duplicate presentation keys').items,
    ['Duplicate Season Alternate', 'Duplicate Season', 'Duplicate Season High']);
  assert.equal(nativeResult('missing series seasons returns an empty not found').status, 404);
  assert.deepEqual(nativeResult('missing series seasons precedes dto construction'), {
    name: 'missing series seasons precedes dto construction', status: 404, error: null, queries: [], dto: [],
  });
  assert.equal(native.similarContract.declaringType, 'Jellyfin.Api.Controllers.LibraryController');
  assert.deepEqual(native.similarContract.routes.map(route => route.Template), [
    'Artists/{itemId}/Similar', 'Items/{itemId}/Similar', 'Albums/{itemId}/Similar',
    'Shows/{itemId}/Similar', 'Movies/{itemId}/Similar', 'Trailers/{itemId}/Similar',
  ]);
  assert.equal(native.similarContract.authorize.length, 1);
  assert.deepEqual(native.similarContract.parameters.map(parameter => parameter.Name),
    ['itemId', 'excludeArtistIds', 'userId', 'limit', 'fields', 'cancellationToken']);
  assert.equal(native.similarContract.parameters[0].required, true);
  assert.match(native.similarContract.parameters[1].binder, /CommaDelimitedCollectionModelBinder$/);
  assert.match(native.similarContract.parameters[4].binder, /CommaDelimitedCollectionModelBinder$/);
  assert.deepEqual(native.similarBinding.itemId.map(entry => ({ set: entry.IsModelSet, value: entry.value,
    errors: entry.errors.length })), [
    { set: false, value: null, errors: 0 }, { set: false, value: null, errors: 1 },
    { set: true, value: '00000000-0000-0000-0000-000000000000', errors: 0 },
    { set: false, value: null, errors: 1 },
    { set: true, value: '91000000-0000-0000-0000-000000000001', errors: 0 },
  ]);
  assert.deepEqual(native.similarBinding.excludeArtistIds[2].values, [
    '91000000-0000-0000-0000-000000000091', '91000000-0000-0000-0000-000000000092',
  ]);
  assert.deepEqual(native.similarBinding.excludeArtistIds[4].values,
    ['91000000-0000-0000-0000-000000000092']);
  const similarDefault = nativeResult('similar series applies action defaults before manager projection');
  assert.deepEqual({ status: similarDefault.status, startIndex: similarDefault.startIndex,
    totalRecordCount: similarDefault.totalRecordCount, items: similarDefault.items },
  { status: 200, startIndex: 0, totalRecordCount: 1, items: ['Duplicate Show'] });
  assert.deepEqual(similarDefault.managerCalls[0], {
    item: 'Fixture Show', itemType: 'Series', excludeArtistIds: [], user: 'shows-reader', fields: [],
    limit: null, libraryTypeOptions: [], cancellationRequested: false,
  });
  assert.equal(nativeResult('similar Guid.Empty chooses the user root').managerCalls[0].itemType, 'UserRootFolder');
  assert.equal(nativeResult('similar Guid.Empty chooses the aggregate root without a user').managerCalls[0].itemType,
    'AggregateFolder');
  for (const name of ['similar missing item returns not found before dto or manager',
    'similar Episode returns empty before dto or manager', 'similar IItemByName returns empty before dto or manager']) {
    const result = nativeResult(name);
    assert.deepEqual(result.dto, [], name); assert.deepEqual(result.managerCalls, [], name);
  }
  const controllerMusic = [
    ['similar MusicArtist is not an IItemByName early return', 'MusicArtist',
      ['91000000-0000-0000-0000-000000000091', '91000000-0000-0000-0000-000000000092']],
    ['similar MusicAlbum reaches the shared manager', 'MusicAlbum',
      ['91000000-0000-0000-0000-000000000091']],
    ['similar Audio reaches the shared manager', 'Audio',
      ['91000000-0000-0000-0000-000000000092']],
  ];
  for (const [name, itemType, excludeArtistIds] of controllerMusic) {
    const call = nativeResult(name).managerCalls[0];
    assert.equal(call.itemType, itemType); assert.deepEqual(call.excludeArtistIds, excludeArtistIds);
  }
  assert.equal(nativeResult('similar administrator may request an unresolved user as userless').managerCalls[0].user,
    null);
  assert.equal(nativeResult('similar cross-user rejection precedes user item dto and manager').exception,
    'MediaBrowser.Controller.Net.SecurityException');
  assert.deepEqual(native.localSimilarProviders.officialDefaults,
    { user: null, Limit: null, dtoOptions: null, ExcludeItemIds: [], ExcludeArtistIds: [] });
  for (const provider of native.localSimilarProviders.providers) {
    assert.equal(provider.name, 'Local Genre/Tag'); assert.equal(provider.type, 'LocalSimilarityProvider');
    const providerQuery = provider.configuredCalls[0];
    assert.deepEqual({ includeItemTypes: providerQuery.includeItemTypes, orderBy: providerQuery.orderBy,
      Limit: providerQuery.Limit, ParentId: providerQuery.ParentId, Recursive: providerQuery.Recursive,
      SearchTerm: providerQuery.SearchTerm,
      GroupByPresentationUniqueKey: providerQuery.GroupByPresentationUniqueKey,
      EnableGroupByMetadataKey: providerQuery.EnableGroupByMetadataKey,
      EnableTotalRecordCount: providerQuery.EnableTotalRecordCount,
      genres: providerQuery.genres, Tags: providerQuery.Tags,
      ExcludeItemIds: providerQuery.ExcludeItemIds,
      ExcludeArtistIds: providerQuery.ExcludeArtistIds }, {
      includeItemTypes: [provider.itemType], orderBy: [{ OrderBy: 'Random', SortOrder: 'Ascending' }],
      Limit: 7, ParentId: '00000000-0000-0000-0000-000000000000', Recursive: false,
      SearchTerm: null, GroupByPresentationUniqueKey: true, EnableGroupByMetadataKey: false,
      EnableTotalRecordCount: true, genres: ['Drama', 'Mystery'], Tags: ['Network', 'Epic'],
      ExcludeItemIds: [provider.itemType === 'Series'
        ? '91000000-0000-0000-0000-000000000001'
        : provider.itemType === 'MusicArtist' ? '91000000-0000-0000-0000-000000000036'
          : provider.itemType === 'MusicAlbum' ? '91000000-0000-0000-0000-000000000037'
            : '91000000-0000-0000-0000-000000000038',
      '91000000-0000-0000-0000-000000000030'],
      ExcludeArtistIds: provider.itemType === 'Series' ? [] : ['91000000-0000-0000-0000-000000000091'],
    });
  }
  assert.deepEqual(native.similarItemsManager.defaultLimitAndAccess.items, ['manager-allowed']);
  assert.ok(native.similarItemsManager.defaultLimitAndAccess.dtoFieldsAfterManager.includes('ProviderIds'));
  assert.equal(native.similarItemsManager.defaultLimitAndAccess.providerQueries[0].Limit, 50);
  assert.deepEqual(native.similarItemsManager.limitedBeforeAccessFilter.items, []);
  assert.deepEqual(native.similarItemsManager.idAndPresentationKeyDeduplication.items, ['manager-allowed']);
  assert.deepEqual(native.similarItemsManager.negativeLimit, { items: [], providerQueries: [] });
  assert.deepEqual(native.similarItemsManager.zeroLimit, { items: [], providerQueries: [] });
  const remoteSimilar = native.similarProviderOrchestration;
  assert.deepEqual(remoteSimilar.provider,
    { Name: 'TheMovieDb', Type: 'SimilarityProvider', cacheDays: 14 });
  assert.deepEqual(remoteSimilar.first.items, ['remote-one', 'remote-two', 'local-one']);
  assert.deepEqual(remoteSimilar.first.requests, [
    'http://tmdb.invalid/3/configuration?api_key=oracle-key',
    'http://tmdb.invalid/3/tv/42/recommendations?page=1&language=null%2Cen&api_key=oracle-key',
    'http://tmdb.invalid/3/tv/42/recommendations?page=2&language=null%2Cen&api_key=oracle-key',
  ]);
  assert.deepEqual(remoteSimilar.first.localCalls.map(call => call.Limit), [1]);
  assert.deepEqual(remoteSimilar.first.cache.propertyNames, ['References', 'ExpiresAt']);
  assert.equal(remoteSimilar.first.cache.path,
    'themoviedb-similar-series/95000000000000000000000000000001.json');
  assert.equal(remoteSimilar.first.cache.rawJsonTemplate,
    '{"References":[{"ProviderName":"Tmdb","ProviderId":"101"},{"ProviderName":"Tmdb","ProviderId":"999"},{"ProviderName":"Tmdb","ProviderId":"102"}],"ExpiresAt":"$EXPIRES_AT"}');
  assert.equal(remoteSimilar.first.cache.utf8Bom, false);
  assert.equal(remoteSimilar.first.cache.expiresAtKind, 'Utc');
  assert.match(remoteSimilar.first.cache.expiresAtTicks, /^\d+$/u);
  assert.equal(remoteSimilar.first.cache.expiresWithinConfiguredWindow, true);
  assert.deepEqual(remoteSimilar.cacheHit.requests, []);
  assert.deepEqual(remoteSimilar.numericStringScores.items, ['remote-two', 'remote-one']);
  assert.deepEqual(remoteSimilar.numericStringScores.requests, []);
  assert.equal(remoteSimilar.numericStringScores.originalCacheRetained, true);
  assert.deepEqual(remoteSimilar.exactDecimalMidpointScores.items, ['remote-two', 'remote-one']);
  assert.deepEqual(remoteSimilar.exactDecimalMidpointScores.requests, []);
  assert.equal(remoteSimilar.exactDecimalMidpointScores.originalCacheRetained, true);
  for (const key of ['invalidStringScore', 'singleOverflowScore']) {
    assert.deepEqual(remoteSimilar[key].items, ['remote-one', 'remote-two'], key);
    assert.ok(remoteSimilar[key].requests.length > 0, key);
    assert.equal(remoteSimilar[key].originalCacheRetained, false, key);
    assert.equal(remoteSimilar[key].replacementHasScores, false, key);
    assert.equal(remoteSimilar[key].temporaryFiles, 0, key);
  }
  t.diagnostic('native score controls ' + JSON.stringify(remoteSimilar.scoreMath));
  assert.deepEqual(remoteSimilar.stableFloatScoreOrder, {
    items: ['remote-one', 'remote-two'], Yielded: 2,
  });
  assert.equal(remoteSimilar.corruptCacheFallback.replacementIsJson, true);
  assert.equal(remoteSimilar.corruptCacheFallback.temporaryFiles, 0);
  assert.equal(remoteSimilar.expiredCacheFallback.replacementExpiresInFuture, true);
  assert.equal(remoteSimilar.expiredCacheFallback.temporaryFiles, 0);
  assert.deepEqual(remoteSimilar.unresolvedRemoteReferences.items, ['local-one', 'local-two']);
  assert.equal(remoteSimilar.unresolvedRemoteReferences.sourceTmdbId, '42');
  assert.equal(remoteSimilar.unresolvedRemoteReferences.cacheExists, true);
  for (const key of ['nullResponse', 'httpFailure', 'rateLimited', 'serverError']) {
    assert.deepEqual(remoteSimilar[key].items, ['local-one', 'local-two'], key);
    assert.equal(remoteSimilar[key].cacheExists, false, key);
  }
  assert.equal(remoteSimilar.rateLimited.requests.length, 2);
  assert.deepEqual(remoteSimilar.configuredOrder.items, ['local-two', 'local-one', 'local-three']);
  assert.deepEqual(remoteSimilar.configuredOrder.calls.map(call => call.Limit), [3, 2, 1]);
  assert.deepEqual(remoteSimilar.stableRegistrationOrder.calls.map(call => call.provider),
    ['First', 'Second', 'Third']);
  assert.deepEqual(remoteSimilar.failureBoundary.items, ['local-one', 'local-two']);
  assert.deepEqual(remoteSimilar.cancellationBoundary.items, ['local-one']);
  assert.deepEqual(remoteSimilar.preCancellationBoundary, { items: [], calls: [] });
  assert.deepEqual(remoteSimilar.batches.map(batch => ({ yielded: batch.Yielded,
    querySizes: batch.querySizes, items: batch.items })), [
    { yielded: 21, querySizes: [20, 1], items: [] },
    { yielded: 500, querySizes: Array(25).fill(20), items: [] },
    { yielded: 20, querySizes: [20], items: ['batch-zero', 'batch-one'] },
  ]);
  assert.deepEqual(native.sqliteRepository.similar.userless,
    ['similar-both', 'similar-duplicate-low', 'similar-duplicate-high', 'similar-denied']);
  assert.deepEqual(native.sqliteRepository.similar.groupedAndAccessFiltered,
    ['similar-both', 'similar-duplicate-low']);
  assert.deepEqual(native.sqliteRepository.similar.paged, ['similar-both']);
  assert.equal(native.sqliteRepository.similar.TotalRecordCount, 2);
  assert.deepEqual(native.similarHttp.crossUser,
    { name: 'cross-user SecurityException', status: 403, contentType: 'text/plain', body: 'Error processing request.' });
  assert.deepEqual(native.similarHttp.managerFailure,
    { name: 'manager failure', status: 500, contentType: 'text/plain', body: 'Error processing request.' });
  const repositoryFiltered = nativeResult('series episodes hide missing episodes for the default user');
  assert.ok(repositoryFiltered.items.includes('pathOnly'));
  assert.ok(!repositoryFiltered.items.includes('flagOnly') && !repositoryFiltered.items.includes('missing'));
  assert.equal(repositoryFiltered.queries[0].IsMissing, false);
  assert.deepEqual(nativeResult('isMissing is a post-selection filter').items, ['missing', 'pathOnly']);
  assert.ok(nativeResult('isMissing false uses location rather than the repository virtual flag').items.includes('flagOnly'));
});

test('Similar route observes aborts during optional user lookup and always removes its listener', async () => {
  const routes = [];
  let managerCalls = 0, providerCalls = 0, userCalls = 0;
  let enteredLookup, releaseLookup;
  const lookupEntered = new Promise(resolve => { enteredLookup = resolve; });
  const lookupRelease = new Promise(resolve => { releaseLookup = resolve; });
  const users = { async getUser(id) {
    userCalls++;
    enteredLookup();
    await lookupRelease;
    return { Id: id };
  } };
  const library = { async querySimilarItems() {
    managerCalls++;
    providerCalls++;
    return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  } };
  registerDomainRoutes((method, templates, handler) => routes.push({ method, templates, handler }), {
    configuration: {}, authentication: {}, users, devices: {}, library, playlists: null,
    sessions: {}, userData: {}, hls: null,
  });
  const route = routes.find(entry => entry.method === 'GET' && Array.isArray(entry.templates)
    && entry.templates.includes('/Shows/{itemId}/Similar'));
  assert.ok(route);
  const request = new EventEmitter();
  request.aborted = false;
  const removed = [];
  const removeListener = request.removeListener;
  request.removeListener = function (event, listener) {
    removed.push([event, listener]);
    return removeListener.call(this, event, listener);
  };
  const context = {
    query: new URLSearchParams(), params: { itemId: ids.series }, request,
    auth: { UserId: ids.series, IsAdministrator: false },
  };
  const pending = route.handler(context);
  await lookupEntered;
  const routeAbortListener = request.listeners('aborted')[0];
  assert.equal(typeof routeAbortListener, 'function');
  request.aborted = true;
  request.emit('aborted');
  releaseLookup();
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.equal(managerCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.ok(removed.some(([event, listener]) => event === 'aborted' && listener === routeAbortListener));

  const alreadyAborted = new EventEmitter();
  alreadyAborted.aborted = true;
  const beforeUserCalls = userCalls;
  await assert.rejects(route.handler({ ...context, request: alreadyAborted }), error => error?.name === 'AbortError');
  assert.equal(userCalls, beforeUserCalls);
  assert.equal(managerCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(alreadyAborted.listenerCount('aborted'), 0);
});

test('PostgreSQL: Shows Upcoming, NextUp, Episodes, Seasons and Similar preserve native selection, paging, DTO and HTTP boundaries', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const fixture = await setup(t);
  const ordinaryChannelInfo = async route => {
    const plainResponse = await fixture.request(route); assert.equal(plainResponse.status, 200);
    const expected = await plainResponse.json();
    const selectedResponse = await fixture.request(route + (route.includes('?') ? '&' : '?') + 'Fields=ChannelInfo');
    assert.equal(selectedResponse.status, 200); const selected = await selectedResponse.json();
    // The native controller capture still binds the field and selector. Its
    // controlled DtoProxy does not represent concrete DtoService internals.
    // For these ordinary episodes/series/artists ChannelInfo adds no fields:
    // the concrete native DTO branch is specific to LiveTvProgram.
    // Local Similar uses a new Random ordering on each request. Compare every
    // complete DTO by identity while retaining the count and paging envelope.
    const comparable = body => route.endsWith('/Similar')
      ? { ...body, Items: [...body.Items].sort((left, right) => left.Id.localeCompare(right.Id)) } : body;
    assert.deepEqual(comparable(selected), comparable(expected), route + ': selecting ChannelInfo must preserve the full ordinary-item response.');
    for (const item of selected.Items) for (const field of ['ChannelName', 'ChannelNumber', 'ChannelPrimaryImageTag']) {
      assert.equal(Object.hasOwn(item, field), false, route + ': ordinary item ' + item.Id + ' must omit ' + field);
    }
    return selected;
  };
  for (const [route, nativeName] of [
    ['/Shows/Upcoming'], ['/Shows/NextUp'],
    [`/Shows/${ids.series}/Episodes`, 'episodes accept fields without DTO consumers'],
    [`/Shows/${ids.series}/Seasons`, 'seasons accept fields without DTO consumers'],
    [`/Shows/${ids.series}/Similar`],
  ]) {
    const plainResponse = await fixture.request(route + '?EnableImages=false');
    assert.equal(plainResponse.status, 200, route);
    const plain = await plainResponse.json();
    const selectedResponse = await fixture.request(route + '?EnableImages=false&Fields=SeasonUserData,RefreshState,ExtraIds');
    assert.equal(selectedResponse.status, 200, route);
    const selected = await selectedResponse.json();
    const comparable = value => route.endsWith('/Similar')
      ? { ...value, Items: [...value.Items].sort((a, b) => a.Id.localeCompare(b.Id)) } : value;
    assert.deepEqual(comparable(selected), comparable(plain), route + ': declared fields without producers preserve the complete response.');
    if (nativeName) {
      const expected = nativeResult(nativeName);
      assert.equal(expected.status, 200);
      const seasonKeys = { Specials: 'season0', 'Season 1': 'season1', 'Season 2': 'season2', 'Unnumbered Season': 'seasonNull' };
      assert.deepEqual(selected.Items.map(item => item.Name), expected.items);
      assert.deepEqual(selected.Items.map(item => item.Id), expected.items.map(name => {
        const key = seasonKeys[name] ?? name;
        assert.ok(Object.hasOwn(ids, key), 'Every Native result must identify a declared scenario item: ' + name);
        return idKey(ids[key]);
      }));
      assert.equal(selected.TotalRecordCount, expected.totalRecordCount);
      assert.equal(selected.StartIndex, expected.startIndex);
    }
  }
  assert.equal((await fixture.request('/Shows/Upcoming', null)).status, 401);
  assert.equal((await fixture.request('/Shows/NextUp', null)).status, 401);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Episodes`, null)).status, 401);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Seasons`, null)).status, 401);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Similar`, null)).status, 401);
  for (const route of [`/Artists/${ids.musicArtist}/Similar`, `/Albums/${ids.musicAlbum}/Similar`,
    `/Items/${ids.audio}/Similar`, `/Movies/${ids.movie}/Similar`, `/Trailers/${ids.trailer}/Similar`]) {
    assert.equal((await fixture.request(route, null)).status, 401, route);
  }
  assert.equal((await fixture.request('/Shows/NextUp', fixture.apiKey)).status, 404);
  assert.equal((await fixture.request(`/Shows/Upcoming?UserId=${fixture.otherUserId}`)).status, 403);
  assert.equal((await fixture.request(`/Shows/NextUp?UserId=${fixture.otherUserId}`)).status, 403);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Episodes?UserId=${fixture.otherUserId}`)).status, 403);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Seasons?UserId=${fixture.otherUserId}`)).status, 403);
  assert.equal((await fixture.request(`/Shows/Upcoming?UserId=${fixture.otherUserId}&Fields=ChannelInfo`)).status, 403);
  assert.equal((await fixture.request(`/Shows/Upcoming?UserId=${fixture.otherUserId}&Fields=ChannelInfo&Limit=x`)).status, 400);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Episodes?UserId=${fixture.otherUserId}&Fields=ChannelInfo`)).status, 403);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Episodes?UserId=${fixture.otherUserId}&Fields=ChannelInfo&Season=x`)).status, 400);
  assert.equal((await fixture.request(`/Shows/NextUp?UserId=${fixture.otherUserId}&Fields=ChannelInfo&NextUpDateCutoff=bad`)).status, 400);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Seasons?UserId=${fixture.otherUserId}&Fields=ChannelInfo&IsMissing=x`)).status, 400);
  assert.equal((await fixture.request('/Shows/Upcoming?Fields=ChannelInfo&Limit=x')).status, 400);

  let response = await fixture.request('/Shows/Upcoming?StartIndex=1&Limit=3&Fields=SortName,ParentId,bad&EnableImages=false&EnableUserData=false');
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.StartIndex, 1); assert.equal(body.TotalRecordCount, 3);
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.two, ids.missing, ids.three].map(idKey));
  assert.ok(body.Items.every(entry => entry.SortName && entry.ParentId && !Object.hasOwn(entry, 'UserData')));

  body = await ordinaryChannelInfo('/Shows/Upcoming'); assert.ok(body.Items.length > 0);
  assert.deepEqual(fixture.errors, []);
  response = await fixture.request('/Shows/Upcoming?Fields=SortName,not-a-native-field&EnableImages=false');
  assert.equal(response.status, 200); body = await response.json();
  assert.ok(body.Items.every(entry => entry.SortName));

  const itemIds = value => new Set(value.Items.map(entry => entry.Id));
  const expectedSimilarUser = new Set([
    ids.similarBoth, ids.similarDuplicateLow, ids.similarDenied,
  ].map(idKey));
  response = await fixture.request(`/Shows/${ids.series}/Similar?Fields=SortName&EnableImages=false&EnableUserData=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(itemIds(body), expectedSimilarUser);
  assert.equal(body.StartIndex, 0); assert.equal(body.TotalRecordCount, 3);
  assert.ok(body.Items.every(entry => entry.SortName && Object.hasOwn(entry, 'ProviderIds')
    && !Object.hasOwn(entry, 'UserData')));
  assert.equal(body.Items.find(entry => entry.Id === idKey(ids.similarBoth)).ProviderIds.Tmdb, '123456');

  response = await fixture.request(`/Shows/${ids.series}/Similar?ParentId=${ids.physicalOther}&IncludeItemTypes=Episode&Recursive=true&SearchTerm=never&ExcludeArtistIds=${ids.genre},bad&ExcludeArtistIds=${ids.musicArtist}&EnableImages=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(itemIds(body), expectedSimilarUser);
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=1&EnableImages=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.equal(body.Items.length, 1); assert.equal(body.TotalRecordCount, 1); assert.equal(body.StartIndex, 0);
  for (const limit of [-1, 0]) {
    response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=${limit}&EnableImages=false`);
    assert.equal(response.status, 200); body = await response.json();
    assert.deepEqual(body, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  }
  for (const itemId of [ids.musicArtist, ids.musicAlbum, ids.audio, ids.movie, ids.trailer]) {
    for (const limit of [-1, 0]) {
      response = await fixture.request(`/Shows/${itemId}/Similar?Limit=${limit}&EnableImages=false`);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(),
        { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
  }
  const musicCases = [
    { route: 'Artists', source: ids.musicArtist, both: ids.artistBoth,
      genreOnly: ids.artistGenreOnly, tagOnly: ids.artistTagOnly,
      duplicates: [ids.artistDuplicateLow, ids.artistDuplicateHigh], denied: ids.artistDenied },
    { route: 'Albums', source: ids.musicAlbum, both: ids.albumBoth,
      genreOnly: ids.albumGenreOnly, tagOnly: ids.albumTagOnly, duplicates: [], denied: null },
    { route: 'Items', source: ids.audio, both: ids.audioBoth,
      genreOnly: ids.audioGenreOnly, tagOnly: ids.audioTagOnly, duplicates: [], denied: null },
  ];
  for (const entry of musicCases) {
    response = await fixture.request(`/${entry.route}/${entry.source}/Similar?ExcludeArtistIds=${ids.musicArtist},${ids.genre}&ExcludeArtistIds=${ids.excludedArtist}&Fields=SortName&EnableImages=false&EnableUserData=false`);
    assert.equal(response.status, 200, entry.route); body = await response.json();
    const actual = itemIds(body);
    assert.ok(actual.has(idKey(entry.both)), entry.route);
    assert.ok(!actual.has(idKey(entry.genreOnly)) && !actual.has(idKey(entry.tagOnly)), entry.route);
    assert.ok(!actual.has(idKey(ids[entry.route === 'Artists' ? 'artistExcluded'
      : entry.route === 'Albums' ? 'albumExcluded' : 'audioExcluded'])), entry.route);
    assert.ok(body.Items.every(item => item.SortName && Object.hasOwn(item, 'ProviderIds')
      && !Object.hasOwn(item, 'UserData')), entry.route);
    if (entry.denied) assert.ok(actual.has(idKey(entry.denied)), entry.route);
    if (entry.duplicates.length) assert.equal(entry.duplicates.filter(id => actual.has(idKey(id))).length, 1,
      JSON.stringify(body));
  }
  response = await fixture.request(`/Items/${ids.series}/Similar?EnableImages=false`);
  assert.equal(response.status, 200); assert.equal((await response.json()).TotalRecordCount, 3);
  for (const route of [`/Movies/${ids.movie}/Similar`, `/Trailers/${ids.trailer}/Similar`]) {
    response = await fixture.request(`${route}?EnableImages=false`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(),
      { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  }
  await fixture.database.insert('BaseItems', { ...item(ids.liveTvProgram, 'LiveTvProgram', {
    Name: 'Fixture Live TV Program', IsVirtualItem: true, ParentId: ids.physical, TopParentId: ids.physical,
    PresentationUniqueKey: 'fixture-live-tv-program',
  }), Type: 'MediaBrowser.Controller.LiveTv.LiveTvProgram' });
  try {
    response = await fixture.request(`/Items/${ids.liveTvProgram}/Similar?Limit=1&EnableImages=false`, fixture.apiKey);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(),
      { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    response = await fixture.request(`/Items/${ids.liveTvProgram}/Similar?Limit=0&EnableImages=false`, fixture.apiKey);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(),
      { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  } finally {
    await fixture.database.delete('BaseItems', { Id: ids.liveTvProgram });
  }
  response = await fixture.request(`/Shows/${ids.musicArtist}/Similar?Limit=0&Fields=ChannelInfo`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0, StartIndex: 0 });

  response = await fixture.request(`/Shows/${ids.series}/Similar?EnableImages=false`, fixture.apiKey);
  assert.equal(response.status, 200); body = await response.json();
  assert.equal(body.TotalRecordCount, 3);
  assert.ok(body.Items.some(entry => entry.Id === idKey(ids.similarBoth)));
  assert.ok(body.Items.some(entry => entry.Id === idKey(ids.similarDenied)));
  assert.equal(body.Items.filter(entry => [idKey(ids.similarDuplicateLow), idKey(ids.similarDuplicateHigh)]
    .includes(entry.Id)).length, 1);
  response = await fixture.request(`/Shows/${ids.series}/Similar?UserId=00000000-0000-0000-0000-000000000099&EnableImages=false`, fixture.apiKey);
  assert.equal(response.status, 200); body = await response.json(); assert.equal(body.TotalRecordCount, 3);

  for (const token of [undefined, fixture.apiKey]) {
    response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000000/Similar?EnableImages=false', token);
    assert.equal(response.status, 200); body = await response.json();
    assert.deepEqual(body, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  }
  response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000099/Similar?Fields=ChannelInfo');
  assert.equal(response.status, 404); assert.equal(await response.text(), '');
  for (const itemId of [ids.one, ids.genre]) {
    response = await fixture.request(`/Shows/${itemId}/Similar?Fields=ChannelInfo`);
    assert.equal(response.status, 200); body = await response.json();
    assert.deepEqual(body, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  }
  body = await ordinaryChannelInfo(`/Artists/${ids.musicArtist}/Similar`); assert.ok(body.Items.length > 0);
  body = await ordinaryChannelInfo(`/Shows/${ids.series}/Similar`); assert.deepEqual(itemIds(body), expectedSimilarUser);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Similar?UserId=${fixture.otherUserId}&Fields=ChannelInfo`)).status, 403);
  assert.equal((await fixture.request(`/Shows/${ids.series}/Similar?UserId=${fixture.otherUserId}&Fields=ChannelInfo&Limit=x`)).status, 400);
  assert.equal((await fixture.request('/Shows/not-a-guid/Similar')).status, 400);
  assert.equal((await fixture.request('/Shows/Similar')).status, 404);
  const savedLibraryOptions = fixture.runtime.library.options.libraryOptions;
  fixture.runtime.library.options.libraryOptions = new Map([[idKey(ids.collection), {
    TypeOptions: [{ Type: 'Series', SimilarItemProviders: ['themoviedb'],
      SimilarItemProviderOrder: ['THEMOVIEDB', 'local genre/tag'] }],
  }]]);
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=0&EnableImages=false`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(),
    { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=3&EnableImages=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.equal(body.TotalRecordCount, 3);
  assert.deepEqual(body.Items.slice(0, 2).map(entry => entry.Id),
    [ids.similarBoth, ids.similarGenreOnly].map(idKey));
  const normalizeTmdbRequest = value => {
    const url = new URL(value); if (url.searchParams.has('api_key')) url.searchParams.set('api_key', '$API_KEY');
    return url.toString().replace(/\/tv\/[+-]?\d+\/recommendations/u, '/tv/TMDB_ID/recommendations');
  };
  assert.deepEqual(fixture.tmdb.requests.map(entry => normalizeTmdbRequest(entry.url)),
    native.similarProviderOrchestration.first.requests.map(normalizeTmdbRequest));
  assert.ok(fixture.tmdb.requests.every(entry => !entry.aborted));
  const cacheFile = similarCachePath(fixture.similarCacheRoot, 'TheMovieDb', 'Series', ids.series);
  const normalizeCache = value => {
    let index = 0;
    return value.replace(/"ProviderId":"[^"]+"/gu, () => `"ProviderId":"$ID_${index++}"`)
      .replace(/"ExpiresAt":"[^"]+"/u, '"ExpiresAt":"$EXPIRES_AT"');
  };
  const candidateCacheRaw = await readFile(cacheFile, 'utf8');
  const candidateCache = JSON.parse(candidateCacheRaw);
  const cacheTemplate = normalizeCache(candidateCacheRaw);
  assert.equal(cacheTemplate, normalizeCache(native.similarProviderOrchestration.first.cache.rawJsonTemplate));
  assert.deepEqual(Object.keys(candidateCache), ['References', 'ExpiresAt']);
  assert.equal(candidateCache.ExpiresAt, '2026-10-22T03:00:00.0000000Z');
  assert.ok(candidateCache.References.every(reference => !Object.hasOwn(reference, 'Score')));

  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=3&EnableImages=false`);
  assert.equal(response.status, 200); const cachedBody = await response.json();
  assert.equal(cachedBody.TotalRecordCount, 3);
  assert.deepEqual(cachedBody.Items.slice(0, 2).map(entry => entry.Id),
    [ids.similarBoth, ids.similarGenreOnly].map(idKey));
  assert.deepEqual(fixture.tmdb.requests, []);

  const scoreCache = async (first, second) => {
    const raw = JSON.stringify({ References: [
      { ProviderName: 'Tmdb', ProviderId: '123456', Score: first },
      { ProviderName: 'Tmdb', ProviderId: '222222', Score: second },
    ], ExpiresAt: '9999-12-31T23:59:59.9999999Z' });
    await writeFile(cacheFile, raw);
    fixture.tmdb.requests.length = 0;
    const result = await fixture.request(`/Shows/${ids.series}/Similar?Limit=2&EnableImages=false`);
    assert.equal(result.status, 200);
    return { body: await result.json(), raw, replacement: await readFile(cacheFile, 'utf8') };
  };
  let scoredCache = await scoreCache('0.25', '0.75');
  assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
    [ids.similarGenreOnly, ids.similarBoth].map(idKey));
  assert.deepEqual(fixture.tmdb.requests, []);
  assert.equal(scoredCache.replacement, scoredCache.raw);
  assert.deepEqual(native.similarProviderOrchestration.numericStringScores.items,
    ['remote-two', 'remote-one']);

  scoredCache = await scoreCache('0.5', '0.5000000298023224');
  assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
    [ids.similarGenreOnly, ids.similarBoth].map(idKey));
  assert.deepEqual(fixture.tmdb.requests, []);
  assert.equal(scoredCache.replacement, scoredCache.raw);
  assert.deepEqual(native.similarProviderOrchestration.exactDecimalMidpointScores.items,
    ['remote-two', 'remote-one']);

  scoredCache = await scoreCache(0.5, 0.5000000298023224);
  assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
    [ids.similarGenreOnly, ids.similarBoth].map(idKey),
    'bare JSON number text must not be rounded through binary64 before Single conversion');
  assert.deepEqual(fixture.tmdb.requests, []);
  assert.equal(scoredCache.replacement, scoredCache.raw);

  scoredCache = await scoreCache('not-a-score', '0.75');
  assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
    [ids.similarBoth, ids.similarGenreOnly].map(idKey));
  assert.equal(fixture.tmdb.requests.length,
    native.similarProviderOrchestration.invalidStringScore.requests.length);
  assert.notEqual(scoredCache.replacement, scoredCache.raw);
  assert.ok(JSON.parse(scoredCache.replacement).References.every(reference => !Object.hasOwn(reference, 'Score')));

  scoredCache = await scoreCache(3.5e38, 0.75);
  assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
    [ids.similarBoth, ids.similarGenreOnly].map(idKey));
  assert.equal(fixture.tmdb.requests.length,
    native.similarProviderOrchestration.singleOverflowScore.requests.length);
  assert.notEqual(scoredCache.replacement, scoredCache.raw);
  assert.ok(JSON.parse(scoredCache.replacement).References.every(reference => !Object.hasOwn(reference, 'Score')));

  for (const invalidScore of [true, { value: 0.75 }]) {
    scoredCache = await scoreCache(invalidScore, 0.75);
    assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
      [ids.similarBoth, ids.similarGenreOnly].map(idKey));
    assert.equal(fixture.tmdb.requests.length,
      native.similarProviderOrchestration.invalidStringScore.requests.length);
    assert.notEqual(scoredCache.replacement, scoredCache.raw);
  }

  // This is an intentional candidate safety boundary, not native parity:
  // JsonDefaults accepts named floating-point strings, while cache scores must
  // remain finite here so the whole cache falls back to the remote provider.
  for (const namedNonFinite of ['NaN', 'Infinity', '-Infinity']) {
    scoredCache = await scoreCache(namedNonFinite, 0.75);
    assert.deepEqual(scoredCache.body.Items.map(entry => entry.Id),
      [ids.similarBoth, ids.similarGenreOnly].map(idKey));
    assert.ok(fixture.tmdb.requests.length > 0, namedNonFinite);
    assert.notEqual(scoredCache.replacement, scoredCache.raw);
  }

  await writeFile(cacheFile, '{');
  const invalidCacheBytes = await readFile(cacheFile);
  assert.deepEqual(invalidCacheBytes, Buffer.from('{'));
  let invalidCacheFailure;
  try { JSON.parse(invalidCacheBytes.toString('utf8')); } catch (cause) { invalidCacheFailure = failureValue(cause); }
  assert.ok(invalidCacheFailure, 'The actual corrupted cache input is rejected by the JSON reader.');
  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=3&EnableImages=false`, undefined,
    { inputFailures: [invalidCacheFailure] });
  assert.equal(response.status, 200); await response.json();
  assert.equal(fixture.tmdb.requests.length, 2);
  const replacementCache = await readFile(cacheFile, 'utf8');
  assert.doesNotThrow(() => JSON.parse(replacementCache));
  assert.deepEqual((await readdir(path.dirname(cacheFile))).filter(name => name.endsWith('.tmp')), []);

  await writeFile(cacheFile, JSON.stringify({ References: [
    { ProviderName: 'Tmdb', ProviderId: '123456' },
  ], ExpiresAt: '2026-10-08T03:00:00.0000000Z' }));
  fixture.tmdb.requests.length = 0;
  response = await fixture.request(`/Shows/${ids.series}/Similar?Limit=2&EnableImages=false`);
  assert.equal(response.status, 200); await response.json();
  assert.equal(fixture.tmdb.requests.length, 2, 'ExpiresAt equal to now is expired');

  const controlledRemote = async (mode, requestCount, cacheExists) => {
    await rm(cacheFile, { force: true }); fixture.tmdb.mode = mode; fixture.tmdb.requests.length = 0;
    const upstreamObservations = [];
    const result = await fixture.request(`/Shows/${ids.series}/Similar?Limit=2&EnableImages=false`, undefined,
      { upstreamObservations });
    assert.equal(result.status, 200, mode); const value = await result.json();
    assert.equal(value.TotalRecordCount, 2, mode); assert.equal(fixture.tmdb.requests.length, requestCount, mode);
    assert.equal(await readFile(cacheFile).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)),
      cacheExists, mode);
    return value;
  };
  await controlledRemote('unresolved', 1, true);
  await controlledRemote('null', 1, false);
  await controlledRemote('throw', 1, false);
  await controlledRemote('rate-limit', 2, false);
  await controlledRemote('server-error', 1, false);
  fixture.tmdb.mode = 'success';
  await rm(cacheFile, { force: true });
  fixture.runtime.library.options.libraryOptions = savedLibraryOptions;

  const unrestricted = await fixture.runtime.users.getUser(fixture.userId);
  await fixture.runtime.users.updatePolicy(fixture.userId, {
    ...unrestricted.Policy, EnableAllFolders: false, EnabledFolders: [ids.collection], BlockedTags: ['Blocked'],
  });
  response = await fixture.request(`/Shows/${ids.series}/Similar?EnableImages=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(itemIds(body), new Set([ids.similarBoth, ids.similarDuplicateLow].map(idKey)));
  assert.equal(body.TotalRecordCount, 2);
  response = await fixture.request(`/Shows/${ids.otherSeries}/Similar?Fields=ChannelInfo`);
  assert.equal(response.status, 404); assert.equal(await response.text(), '');
  await fixture.runtime.users.updatePolicy(fixture.userId, {
    ...(await fixture.runtime.users.getUser(fixture.userId)).Policy, EnableAllFolders: true, EnabledFolders: [], BlockedTags: [],
  });
  assert.deepEqual(fixture.errors, []);

  response = await fixture.request('/Shows/Upcoming?ParentId=00000000-0000-0000-0000-000000000000&StartIndex=-1&Limit=-1&EnableImages=false&EnableUserData=false', fixture.apiKey);
  body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.StartIndex, -1); assert.equal(body.TotalRecordCount, body.Items.length);
  assert.ok([ids.otherEpisode, ids.nonFolderDescendant]
    .every(id => body.Items.some(entry => entry.Id === idKey(id))));
  response = await fixture.request('/Shows/Upcoming?StartIndex=-1&Limit=2&EnableImages=false&EnableUserData=false', fixture.apiKey);
  body = await response.json(); assert.equal(body.StartIndex, -1); assert.equal(body.TotalRecordCount, 2);
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.special), idKey(ids.two)]);

  const parentItems = async parentId => {
    const result = await fixture.request(`/Shows/Upcoming?ParentId=${parentId}&EnableImages=false&EnableUserData=false`, fixture.apiKey);
    assert.equal(result.status, 200); return (await result.json()).Items.map(entry => entry.Id);
  };
  assert.deepEqual(await parentItems(ids.missingParent), []);
  assert.deepEqual(await parentItems(ids.two), [idKey(ids.nonFolderDescendant)]);
  for (const parentId of [ids.collection, ids.view, ids.series]) {
    const scoped = await parentItems(parentId);
    assert.ok(scoped.includes(idKey(ids.two)), parentId);
    assert.ok(!scoped.includes(idKey(ids.otherEpisode)) && !scoped.includes(idKey(ids.nonFolderDescendant)), parentId);
  }

  await fixture.seedNextUpUserData();
  response = await fixture.request('/Shows/NextUp?Fields=SortName,ParentId&EnableImages=false&EnableUserData=false');
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  assert.equal(body.TotalRecordCount, 2); assert.equal(body.StartIndex, 0);
  assert.ok(body.Items.every(entry => entry.SortName && entry.ParentId && !Object.hasOwn(entry, 'UserData')));

  response = await fixture.request('/Shows/NextUp?EnableResumable=false&EnableImages=false');
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.nonFolderDescendant)]);
  response = await fixture.request('/Shows/NextUp?EnableRewatching=true&EnableImages=false&EnableUserData=false');
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.one), idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  response = await fixture.request(`/Shows/NextUp?SeriesId=${ids.series}&ParentId=${ids.collectionOther}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two)]);
  response = await fixture.request(`/Shows/NextUp?SeriesId=${ids.missingParent}&EnableImages=false&EnableUserData=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  response = await fixture.request(`/Shows/NextUp?SeriesId=${ids.season1}&EnableImages=false&EnableUserData=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  response = await fixture.request(`/Shows/NextUp?SeriesId=${ids.emptySeries}&EnableImages=false&EnableUserData=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.collectionOther}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.nonFolderDescendant)]);
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.liveView}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.liveNext)]);
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, GroupedFolders: [ids.musicCollection] });
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.musicView}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items, []);
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, GroupedFolders: [ids.collection] });
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.groupedView}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two)]);
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, GroupedFolders: [ids.orphanCollection] });
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.groupedView}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items, []);
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, GroupedFolders: [] });
  const currentConfiguration = (await fixture.runtime.users.getUser(fixture.userId)).Configuration;
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...currentConfiguration, LatestItemsExcludes: [ids.collectionOther] });
  response = await fixture.request('/Shows/NextUp?EnableImages=false&EnableUserData=false');
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two)]);
  await fixture.runtime.users.updateConfiguration(fixture.userId,
    { ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, LatestItemsExcludes: [] });
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.series}&StartIndex=9&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items, []); assert.equal(body.StartIndex, 9);
  response = await fixture.request(`/Shows/NextUp?ParentId=${ids.missingParent}&EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items, []); assert.equal(body.StartIndex, 0);
  response = await fixture.request('/Shows/NextUp?ParentId=00000000-0000-0000-0000-000000000000');
  assert.equal(response.status, 400); assert.equal(await response.text(), 'Error processing request.');
  assert.deepEqual(fixture.errors, []);
  response = await fixture.request('/Shows/NextUp?ParentId=&EnableImages=false&EnableUserData=false');
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two), idKey(ids.nonFolderDescendant)]);
  response = await fixture.request('/Shows/NextUp?NextUpDateCutoff=2026-10-06T00%3A00%3A00Z&EnableTotalRecordCount=false&StartIndex=-1&Limit=-1&EnableImages=false&EnableUserData=false');
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two)]);
  assert.equal(body.TotalRecordCount, 0); assert.equal(body.StartIndex, -1);
  response = await fixture.request('/Shows/NextUp?NextUpDateCutoff=2026-10-06&EnableImages=false&EnableUserData=false');
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.two)]);
  response = await fixture.request('/Shows/NextUp?NextUpDateCutoff=2027-01-01&StartIndex=-2&EnableImages=false');
  body = await response.json(); assert.deepEqual(body.Items, []); assert.equal(body.TotalRecordCount, 0); assert.equal(body.StartIndex, -2);
  await ordinaryChannelInfo('/Shows/NextUp');
  assert.deepEqual(fixture.errors, []);

  response = await fixture.request(`/Shows/${ids.series}/Seasons?Fields=SortName,ParentId&EnableImages=false&EnableUserData=false`);
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.season0, ids.season1, ids.season2, ids.seasonNull].map(idKey));
  assert.equal(body.TotalRecordCount, 4); assert.equal(body.StartIndex, 0);
  assert.ok(body.Items.every(entry => entry.SortName && entry.ParentId && !Object.hasOwn(entry, 'UserData')));
  response = await fixture.request(`/Shows/${ids.series}/Seasons?IsSpecialSeason=true&EnableImages=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.season0)]);
  response = await fixture.request(`/Shows/${ids.series}/Seasons?IsMissing=true&EnableImages=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.season0, ids.season1, ids.season2, ids.seasonNull].map(idKey));
  response = await fixture.request(`/Shows/${ids.series}/Seasons?AdjacentTo=${ids.season1}&EnableImages=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.season0, ids.season1, ids.season2].map(idKey));
  response = await fixture.request(`/Shows/${ids.duplicateSeries}/Seasons?EnableImages=false&EnableUserData=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.duplicateSeasonHigh)]);
  response = await fixture.request(`/Shows/${ids.duplicateSeries}/Seasons?EnableImages=false&EnableUserData=false`, fixture.apiKey);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.duplicateSeasonAlternate, ids.duplicateSeason, ids.duplicateSeasonHigh].map(idKey));
  response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000099/Seasons');
  assert.equal(response.status, 404); assert.equal(await response.text(), '');
  response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000099/Seasons?Fields=ChannelInfo');
  assert.equal(response.status, 404); assert.equal(await response.text(), '');
  response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000000/Seasons');
  assert.equal(response.status, 400); assert.equal(await response.text(), 'Error processing request.');
  assert.deepEqual(fixture.errors, []);

  response = await fixture.request(`/Shows/${ids.series}/Episodes?Fields=SortName,ParentId,SpecialEpisodeNumbers&EnableImages=false`);
  assert.equal(response.status, 200); body = await response.json();
  let expected = nativeResult('series episodes hide missing episodes for the default user');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));
  assert.equal(body.TotalRecordCount, expected.totalRecordCount); assert.equal(body.StartIndex, 0);
  assert.ok(body.Items.every(entry => entry.UserData));

  response = await fixture.request(`/Shows/${ids.series}/Episodes?Season=99&EnableImages=false`);
  body = await response.json(); assert.deepEqual(body.Items, []); assert.equal(body.TotalRecordCount, 0);
  response = await fixture.request(`/Shows/${ids.series}/Episodes?Season=1&EnableImages=false`);
  body = await response.json(); expected = nativeResult('season number chooses the matching native season');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));
  assert.equal(body.TotalRecordCount, expected.totalRecordCount);
  response = await fixture.request(`/Shows/${ids.series}/Episodes?SortBy=PremiereDate&EnableImages=false`);
  body = await response.json(); expected = nativeResult('non-random sortBy is ignored');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));

  response = await fixture.request(`/Shows/${ids.duplicateSeries}/Episodes?EnableImages=false&EnableUserData=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.duplicateLow)]);
  response = await fixture.request(`/Shows/${ids.duplicateSeries}/Episodes?EnableImages=false&EnableUserData=false`, fixture.apiKey);
  body = await response.json();
  assert.deepEqual(new Set(body.Items.map(entry => entry.Id)), new Set([
    idKey(ids.duplicateAlternate), idKey(ids.duplicateLow), idKey(ids.duplicateHigh),
  ]));

  await fixture.runtime.users.updateConfiguration(fixture.userId, {
    ...(await fixture.runtime.users.getUser(fixture.userId)).Configuration, DisplayMissingEpisodes: true });
  response = await fixture.request(`/Shows/${ids.series}/Seasons?IsMissing=true&EnableImages=false`);
  body = await response.json(); assert.deepEqual(body.Items.map(entry => entry.Id), [idKey(ids.seasonMissing)]);
  response = await fixture.request(`/Shows/${ids.series}/Seasons?IsSpecialSeason=false&EnableImages=false`);
  body = await response.json();
  assert.deepEqual(body.Items.map(entry => entry.Id), [ids.season1, ids.season2, ids.seasonMissing].map(idKey));
  response = await fixture.request(`/Shows/${ids.series}/Episodes?Season=1&IsMissing=true&EnableImages=false`);
  body = await response.json();
  expected = nativeResult('isMissing is a post-selection filter');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));

  response = await fixture.request(`/Shows/${ids.series}/Episodes?IsMissing=false&EnableImages=false`);
  body = await response.json(); expected = nativeResult('isMissing false uses location rather than the repository virtual flag');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));

  response = await fixture.request(`/Shows/${ids.series}/Episodes?StartItemId=${ids.alternate}&AdjacentTo=${ids.special}&StartIndex=0&Limit=2&EnableImages=false`);
  body = await response.json();
  expected = nativeResult('alternate start then adjacency then paging preserves native order');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));
  assert.equal(body.TotalRecordCount, 3); assert.equal(body.StartIndex, 0);

  response = await fixture.request(`/Shows/00000000-0000-0000-0000-000000000099/Episodes?SeasonId=${ids.season2}&EnableImages=false`, fixture.apiKey);
  body = await response.json();
  expected = nativeResult('season id ignores the route series id');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));

  response = await fixture.request(`/Shows/${ids.series}/Episodes?IsMissing=true&EnableImages=false`, fixture.apiKey);
  body = await response.json(); expected = nativeResult('isMissing is a post-selection filter');
  assert.deepEqual(body.Items.map(entry => entry.Id), expected.items.map(key => idKey(ids[key])));

  response = await fixture.request('/Shows/00000000-0000-0000-0000-000000000099/Episodes');
  expected = nativeResult('missing series returns the native message');
  assert.equal(response.status, expected.status); assert.equal(await response.json(), expected.error);
  response = await fixture.request(`/Shows/${ids.series}/Episodes?SeasonId=00000000-0000-0000-0000-000000000099`);
  expected = nativeResult('missing season returns the dashed native id message');
  assert.equal(response.status, expected.status);
  assert.equal(await response.json(), expected.error.replace('91000000-0000-0000-0000-000000000098', '00000000-0000-0000-0000-000000000099'));
  for (const route of [`/Shows/${ids.series}/Episodes?Season=x`, `/Shows/${ids.series}/Episodes?IsMissing=x`,
    `/Shows/not-a-guid/Episodes`, '/Shows/Upcoming?Limit=x',
    '/Shows/NextUp?EnableRewatching=x', '/Shows/NextUp?NextUpDateCutoff=not-a-date',
    `/Shows/${ids.series}/Seasons?IsSpecialSeason=x`, '/Shows/not-a-guid/Seasons']) {
    response = await fixture.request(route); assert.equal(response.status, 400, route);
  }
  response = await fixture.request(`/Shows/${ids.series}/Episodes?EnableImages=false`);
  const defaultEpisodes = await response.json();
  response = await fixture.request(`/Shows/${ids.series}/Episodes?SortBy=NoSuchSort&EnableImages=false`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), defaultEpisodes);
  assert.deepEqual(fixture.errors, []);
});
