import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { defaultTmdbApiKey } from '../../plugins/tmdb/default-key.js';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { MIN_DATE, idKey, dateTicks } from '../../src/library/records.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { serializeLibraryOptions } from '../../src/library/library-options-store.js';
import { getNewItemId } from '../../src/core/identity.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { errorObservation } from '../helpers/error-observation.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { movieId, configuration, cultures, itemFields, providerProjection } from './fixtures/tmdb-public-current/input.js';
import { publicTmdbTransport } from './fixtures/tmdb-public-current/transport.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const asset = new URL('../fixtures/frozen-av/source.m2ts', import.meta.url);
const assetSha256 = '719919ca910fdaf4b035d2dac56cdbb4c95efe7c5a465f93303901e8b747f027';
const collectionId = 'a7c20000-0000-0000-0000-000000000100', folderId = 'a7c20000-0000-0000-0000-000000000101';
const cancellationSample = { language: 'ja-JP', country: 'JP', itemId: 'a7c20000-0000-0000-0000-000000000003' };
const hash = value => createHash('sha256').update(value).digest('hex');
const row = values => postgresTestRow('BaseItems', { Data: '{}', Name: 'Incoming movie', CleanName: 'incoming movie',
  SortName: 'incoming movie', MediaType: 'Unknown', DateCreated: MIN_DATE, DateModified: MIN_DATE,
  DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE, ...values,
  ...Object.fromEntries(['Id', 'ParentId', 'TopParentId'].filter(key => values[key] != null)
    .map(key => [key, nativeGuid(values[key])])) });

test('public TMDB Movie responses preserve culture, cache, retries, cancellation and real PG/NFO cold recovery', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'tmdb-public-' + randomUUID()); await mkdir(output);
  const root = path.join(output, 'node'), programDataPath = path.join(root, 'program'), mediaRoot = path.join(root, 'media'),
    storageConfiguration = path.join(root, 'storage.json'), collectionPath = path.join(programDataPath, 'root/default/Public');
  const secrets = new Set([defaultTmdbApiKey, process.env.MEDIAMANAGER_TEST_POSTGRES]);
  const redact = text => [...secrets].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
  const safe = value => redact(stringifyNativeJson(value));
  const report = { phaseAcceptance: false, releaseAcceptance: false, requests: [], providers: [], refreshes: [], events: [], closes: [],
    scope: { publicRequests: 'Actual HTTPS configuration and Movie requests with the designated built-in credential.',
      native: 'Current manager and Movie provider replay the exact same-run public response bytes.',
      candidate: 'Actual installed TMDB/NFO plugins, PostgreSQL, Local storage, original-media probe, HTTP refresh and cold HTTP reads.',
      controls: ['cast and crew limits of zero', 'two injected HTTP 429 replies over a previously successful public endpoint',
        'caller cancellation immediately after a real fetch starts'],
      excluded: ['public rate-limit exhaustion', 'Native public network transport', 'people and image downloads', 'all provider types', 'full instance exchange'] } };
  const providerCases = [], media = new Map(), nfo = new Map(), observedRegistries = new WeakSet(), refreshFailures = new WeakMap();
  let runtime, database, schema, controlSchema, token, transport, nativeBuild, stage = 'setup', primary, failed = false;
  const errors = [];
  const writeReport = () => writeFile(path.join(output, 'comparison.json'), safe(report) + '\n');
  const stop = async () => {
    const owner = runtime; runtime = undefined; if (!owner) return;
    const listeners = owner.networkHost.listeners;
    await owner.close();
    const observation = { listenersClosed: listeners.every(listener => !listener.server.listening), databaseClosed: database.closed };
    report.closes.push(observation); assert.equal(observation.listenersClosed, true); assert.equal(observation.databaseClosed, true);
  };
  const libraryOptions = { ...defaultLibraryOptions(), PathInfos: [{ Path: mediaRoot }], SaveLocalMetadata: true, MetadataSavers: ['Nfo'],
    EnableInternetProviders: true, EnableRealtimeMonitor: false, AutomaticallyAddToCollection: false,
    TypeOptions: [{ Type: 'Movie', MetadataFetchers: ['TheMovieDb'], MetadataFetcherOrder: ['TheMovieDb'], ImageFetchers: [], ImageOptions: [] }] };
  const observeProviders = () => {
    const registry = runtime.metadata.registry;
    assert.ok(registry.plugins().some(plugin => plugin.providers.some(value => value.id === 'TmdbMovieProvider')),
      'The installed official TMDB plugin must be connected to the production registry.');
    if (observedRegistries.has(registry)) return;
    observedRegistries.add(registry);
    const discover = registry.discover;
    registry.discover = function (...args) {
      return discover.apply(this, args).map(provider => {
        if (provider.id !== 'TmdbMovieProvider') return provider;
        const getMetadata = provider.getMetadata;
        return { ...provider, async getMetadata(info, options) {
          const observation = { stage, language: info.MetadataLanguage, country: info.MetadataCountryCode };
          report.providers.push(observation);
          try {
            const result = await getMetadata.call(provider, info, options);
            observation.result = structuredClone(result);
            if (result.HasMetadata) {
              assert.ok(Object.keys(result.Item).every(key => itemFields.includes(key)), 'Every emitted Movie field must be compared.');
              observation.responses = transport.providerResponses(info.MetadataLanguage);
              if (!stage.endsWith('-warm')) providerCases.push({ name: stage, language: info.MetadataLanguage,
                country: info.MetadataCountryCode, result: observation.result, responses: observation.responses });
            }
            return result;
          } catch (error) { observation.failure = errorObservation(error); throw error; }
        } };
      });
    };
  };
  const start = async () => {
    runtime = await createTestRuntime({ database, programDataPath, configurationDirectoryPath: path.join(root, 'config'),
      storageConfiguration, serverId: 'tmdb-public',
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true,
        PreferredMetadataLanguage: 'en-US', MetadataCountryCode: 'US' },
      mediaEncoderOptions: { startupFFmpegPath: validationExecutable('ffmpeg') },
      probeOptions: { ffprobePath: validationExecutable('ffprobe') },
      pluginOptions: { options: { tmdb: { fetch: transport.fetch } } },
      onError: error => errors.push({ stage, failure: errorObservation(error) }) });
    observeProviders();
    const original = runtime.metadata.refresh;
    runtime.metadata.refresh = async function (...args) {
      const observation = { stage, itemId: typeof args[0] === 'string' ? args[0] : args[0].Id }; report.refreshes.push(observation);
      try {
        const result = await original.apply(this, args);
        observation.result = { changed: result.changed, UpdateType: result.UpdateType, Failures: result.Failures, ErrorMessage: result.ErrorMessage };
        return result;
      } catch (error) { observation.failure = errorObservation(error); refreshFailures.set(observation, error); throw error; }
    };
    runtime.library.on('ItemUpdated', ({ Item, UpdateReason }) => report.events.push({ stage, kind: 'updated',
      itemId: Item.Id, Name: Item.Name, ProviderIds: { ...Item.ProviderIds }, UpdateReason }));
  };
  const request = async (method, route) => {
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    const response = await fetch(origin + route, { method, headers: { Authorization: 'MediaBrowser Token="' + token + '"' },
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]) });
    const observation = { method, route, status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
    (report.httpResponses ??= []).push(observation);
    return observation;
  };
  const refresh = async (sample, { replaceAllMetadata = true } = {}) => {
    const start = report.refreshes.length;
    const response = await request('POST', '/Items/' + sample.itemId + '/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=' + replaceAllMetadata + '&imageRefreshMode=None');
    assert.equal(response.status, 204); await runtime.metadata.drain();
    const observations = report.refreshes.slice(start).filter(value => idKey(value.itemId) === idKey(sample.itemId));
    assert.equal(observations.length, 1, 'The acknowledged HTTP refresh must settle its actual metadata owner.');
    const observation = observations[0];
    observation.options = { MetadataRefreshMode: 'FullRefresh', ReplaceAllMetadata: replaceAllMetadata, ImageRefreshMode: 'None' };
    if (refreshFailures.has(observation)) throw refreshFailures.get(observation);
    assert.ok(observation.result, 'The actual metadata refresh must return its completed result.');
    return { response, result: observation.result };
  };
  const verifyStored = async (sample, expected) => {
    const item = await runtime.metadata.loadContext(sample.itemId);
    try {
      const scope = { itemId: sample.itemId, collectionIds: item.collectionFolders.map(folder => idKey(folder.Id)),
        saveLocalMetadata: item.libraryOptions.SaveLocalMetadata,
        savers: item.libraryOptions.MetadataSavers == null ? null : [...item.libraryOptions.MetadataSavers] };
      (report.libraryScopes ??= []).push(scope);
      assert.deepEqual(scope.collectionIds, [idKey(collectionId)], 'The actual Movie refresh must belong to the supplied library.');
      assert.equal(scope.saveLocalMetadata, true); assert.deepEqual(scope.savers, ['Nfo']);
      const actual = item.item;
      for (const key of ['Name', 'OriginalTitle', 'Overview', 'Tagline', 'OfficialRating', 'OriginalLanguage', 'ProductionYear', 'TmdbCollectionName'])
        assert.equal(actual[key] ?? null, expected.Item[key] ?? null, key);
      assert.equal(actual.CommunityRating, expected.Item.CommunityRating, 'CommunityRating');
      if (expected.Item.PremiereDate == null) assert.equal(actual.PremiereDate, null, 'PremiereDate');
      else {
        assert.notEqual(actual.PremiereDate, null, 'PremiereDate');
        assert.equal(dateTicks(actual.PremiereDate), dateTicks(expected.Item.PremiereDate), 'PremiereDate');
      }
      assert.deepEqual(actual.RemoteTrailers.map(({ Url, Name }) => ({ Url, Name })),
        expected.Item.RemoteTrailers.map(({ Url, Name }) => ({ Url, Name })), 'RemoteTrailers');
      for (const key of ['Genres', 'Tags', 'Studios', 'ProductionLocations']) assert.deepEqual([...actual[key]], expected.Item[key], key);
      assert.deepEqual({ ...actual.ProviderIds }, { OpaqueProvider: 'opaque:traceId:public-source', ...expected.Item.ProviderIds });
      assert.equal(actual.Path, media.get(sample.itemId));
    } finally { await item.dispose(); }
    const filename = path.join(path.dirname(media.get(sample.itemId)), 'movie.nfo'), bytes = await readFile(filename);
    const parsed = parseNfo(bytes.toString('utf8'), { type: 'Movie' });
    assert.equal(parsed.Item.Name, expected.Item.Name); assert.equal(parsed.Item.Overview, expected.Item.Overview);
    assert.equal(parsed.Item.ProviderIds.Tmdb, String(movieId));
    // The provider's array order is separately checked in PostgreSQL. NFO's
    // actual common writer orders its genre elements; bind that exact output
    // in both fresh Native replays before this test can pass.
    (report.nfoReadbacks ??= []).push({ sample, provider: expected, genres: parsed.Item.Genres,
      filename, bytes: bytes.length, sha256: hash(bytes), nativeComparisons: [] });
    nfo.set(sample.itemId, { filename, sha256: hash(bytes), bytes: bytes.length });
    assert.equal(hash(await readFile(media.get(sample.itemId))), assetSha256);
    return { row: (await database.rows('BaseItems', { where: { Id: nativeGuid(sample.itemId) } }))[0],
      providers: await database.rows('BaseItemProviders', { where: { ItemId: nativeGuid(sample.itemId) } }), nfo: nfo.get(sample.itemId) };
  };
  try {
    nativeBuild = await verifyNativeBuild();
    const utils = path.join(nativeBuild.sourceRoot, 'MediaBrowser.Providers/Plugins/Tmdb/TmdbUtils.cs');
    const source = await readFile(utils, 'utf8');
    const sourceKey = /\bApiKey\s*=\s*"([^"\r\n]+)"/u.exec(source)?.[1];
    assert.ok(sourceKey && sourceKey === defaultTmdbApiKey, 'The Node default credential must match the sealed designated source.');
    report.builtInCredentialMatched = true;
    report.sourceBindings = await Promise.all(['MediaBrowser.Providers/Plugins/Tmdb/TmdbUtils.cs',
      'MediaBrowser.Providers/Plugins/Tmdb/TmdbClientManager.cs', 'MediaBrowser.Providers/Plugins/Tmdb/Movies/TmdbMovieProvider.cs',
      'MediaBrowser.Providers/Manager/MetadataService.cs', 'MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs',
      'MediaBrowser.XbmcMetadata/Savers/BaseNfoSaver.cs', 'MediaBrowser.XbmcMetadata/Savers/MovieNfoSaver.cs',
      'MediaBrowser.Model/Configuration/XbmcMetadataOptions.cs', 'MediaBrowser.XbmcMetadata/Configuration/NfoConfigurationExtension.cs',
      'Jellyfin.Api/Controllers/UserLibraryController.cs',
      'Jellyfin.Api/Helpers/RequestHelpers.cs']
      .map(relative => describeFile(path.join(nativeBuild.sourceRoot, relative))));
    await mkdir(path.dirname(collectionPath), { recursive: true }); await mkdir(mediaRoot, { recursive: true });
    const emptyAncestors = path.join(root, 'empty-ancestors'); await mkdir(emptyAncestors);
    await writeFile(storageConfiguration, JSON.stringify({
      instances: [{ id: 'private', type: 'local', config: { root, writable: true } },
        { id: 'ancestors', type: 'local', config: { root: emptyAncestors, writable: false } }],
      mounts: [{ path: '/public', instanceId: 'private', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
        { path: '/empty-ancestors', instanceId: 'ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/public', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'Owned public TMDB metadata, original media and instance state.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'Known empty ancestors outside the isolated public metadata inputs.' }],
    }, null, 2) + '\n');
    assert.equal(hash(await readFile(asset)), assetSha256);
    transport = await publicTmdbTransport({ output, apiKey: defaultTmdbApiKey, signal: t.signal, report });
    database = await createPostgresTestDatabase(null, 'tmdb_public'); schema = database.schemaName; controlSchema = database.controlSchema;
    const userRootPath = path.dirname(collectionPath), userRootId = nativeGuid(getNewItemId(userRootPath,
      'MediaBrowser.Controller.Entities.UserRootFolder', { programDataPath, enableCaseSensitiveItemIds: true }));
    await database.insert('BaseItems', row({ Id: userRootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder',
      Name: 'default', Path: userRootPath, IsFolder: true, Data: JSON.stringify({ IsRoot: true }) }));
    await mkdir(collectionPath);
    const serializedOptions = serializeLibraryOptions(libraryOptions);
    if (serializedOptions.failure) throw serializedOptions.failure;
    const optionsFile = path.join(collectionPath, 'options.xml'); await writeFile(optionsFile, serializedOptions.bytes, { flag: 'wx' });
    await writeFile(path.join(collectionPath, 'location.mblink'), mediaRoot, { flag: 'wx' });
    await writeFile(path.join(collectionPath, 'movies.collection'), '', { flag: 'wx' });
    report.libraryOptions = { filename: optionsFile, bytes: serializedOptions.bytes.length, sha256: hash(serializedOptions.bytes), values: libraryOptions };
    await database.insert('BaseItems', row({ Id: folderId, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Public media',
      Path: mediaRoot, IsFolder: true }));
    await database.insert('BaseItems', row({ Id: collectionId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Public movies',
      Path: collectionPath, ParentId: userRootId, TopParentId: collectionId, IsFolder: true,
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [nativeGuid(folderId)], PhysicalLocationsList: [mediaRoot] }) }));
    for (const sample of [...cultures, cancellationSample]) {
      const directory = path.join(mediaRoot, sample.language); await mkdir(directory);
      const filename = path.join(directory, 'movie.m2ts'); await copyFile(asset, filename); media.set(sample.itemId, filename);
      await database.insert('BaseItems', row({ Id: sample.itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', ParentId: folderId,
        TopParentId: folderId, MediaType: 'Video', Path: filename, IsInMixedFolder: true,
        PreferredMetadataLanguage: sample.language, PreferredMetadataCountryCode: sample.country }));
      await database.insert('AncestorIds', { ItemId: nativeGuid(sample.itemId), ParentItemId: nativeGuid(folderId) });
      for (const [ProviderId, ProviderValue] of Object.entries({ Tmdb: String(movieId), OpaqueProvider: 'opaque:traceId:public-source' }))
        await database.insert('BaseItemProviders', { ItemId: nativeGuid(sample.itemId), ProviderId, ProviderValue });
    }
    report.seededRows = { BaseItems: await database.rows('BaseItems'), BaseItemProviders: await database.rows('BaseItemProviders'),
      AncestorIds: await database.rows('AncestorIds') };
    await start(); await runtime.plugins.configure('tmdb', configuration); observeProviders();
    report.initialRows = { BaseItems: await database.rows('BaseItems'), BaseItemProviders: await database.rows('BaseItemProviders'),
      AncestorIds: await database.rows('AncestorIds') };
    token = (await runtime.apiKeys.create('TMDB public validation')).AccessToken; secrets.add(token);
    report.coldReaderId = (await runtime.users.createUser({ Name: 'TMDB public cold reader' })).Id;
    report.successes = [];
    for (const sample of cultures) {
      stage = sample.language;
      const observed = await refresh(sample); assert.equal(observed.result.Failures, 0);
      assert.equal(report.providers.at(-1).language, sample.language); assert.equal(report.providers.at(-1).country, sample.country);
      const result = report.providers.at(-1).result; assert.equal(result.HasMetadata, true); assert.ok(result.Item.Name?.length > 0);
      const beforeWarm = report.requests.length, expected = providerProjection(result);
      const stored = await verifyStored(sample, expected);
      stage += '-warm'; const warm = await refresh(sample); assert.equal(warm.result.Failures, 0);
      assert.equal(report.requests.length, beforeWarm, 'A warm Movie refresh must reuse the actual client cache.');
      assert.deepEqual(providerProjection(report.providers.at(-1).result), expected);
      report.successes.push({ sample, response: observed.response, expected, stored });
    }
    stage = 'rate-limit'; transport.setMode('limited'); await runtime.plugins.clearCache('tmdb'); observeProviders();
    // A forced replacement first imports the container's embedded fields, even
    // if the remote provider subsequently fails. Retention exercises the real
    // non-replacement refresh, while FullRefresh still forces provider traffic.
    const limited = await refresh(cultures[0], { replaceAllMetadata: false });
    assert.equal(limited.result.Failures, 1); assert.match(limited.result.ErrorMessage, /429/u);
    const limitedRequests = report.requests.filter(value => value.mode === 'limited' && value.controlled);
    assert.equal(limitedRequests.length, 2);
    assert.ok(limitedRequests[1].startedMs - limitedRequests[0].completedMs >= 900);
    assert.ok(performance.now() - limitedRequests[1].completedMs >= 900, 'The final failed rate-limit attempt must also wait.');
    const preserved = await verifyStored(cultures[0], report.successes[0].expected);
    report.rateLimit = { ...limited, preserved, publicRateLimitObserved: false, controlledStatuses: limitedRequests.map(value => value.status) };
    transport.setMode('live'); stage = 'rate-limit-recovery';
    const recovered = await refresh(cultures[0]); assert.equal(recovered.result.Failures, 0);
    report.rateLimit.recovery = { ...recovered, stored: await verifyStored(cultures[0], providerProjection(report.providers.at(-1).result)) };
    report.successes[0].expected = providerProjection(report.providers.at(-1).result);

    stage = 'cancellation'; await runtime.plugins.clearCache('tmdb'); observeProviders();
    assert.equal((await request('GET', '/Tmdb/ClientConfiguration')).status, 200);
    const entered = transport.armCancellation(), controller = new AbortController(), reason = Object.assign(new Error('Cancelled the actual public Movie request.'), { code: 'public-tmdb-cancelled' });
    const pending = runtime.metadata.refresh(cancellationSample.itemId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None',
      ReplaceAllMetadata: true, ForceSave: true, signal: controller.signal }).then(value => ({ failed: false, value }), error => ({ failed: true, error }));
    await Promise.race([entered, pending.then(value => { throw new Error('The refresh ended before the actual public Movie request started.', { cause: value.error }); })]);
    controller.abort(reason);
    const cancelled = await pending; assert.equal(cancelled.failed, true); assert.equal(cancelled.error, reason);
    const cancelledRow = (await database.rows('BaseItems', { where: { Id: nativeGuid(cancellationSample.itemId) } }))[0];
    assert.equal(cancelledRow.Name, 'Incoming movie'); assert.equal(dateTicks(cancelledRow.DateLastRefreshed), dateTicks(MIN_DATE));
    report.cancellation = { failure: errorObservation(cancelled.error), row: cancelledRow,
      actualFetchAttempted: true, publicServerAcceptanceProved: false };
    stage = 'cancellation-recovery';
    const cancellationRecovery = await refresh(cancellationSample); assert.equal(cancellationRecovery.result.Failures, 0);
    assert.equal(report.providers.at(-1).language, cancellationSample.language); assert.equal(report.providers.at(-1).country, cancellationSample.country);
    const cancellationExpected = providerProjection(report.providers.at(-1).result);
    report.cancellation.recovery = { ...cancellationRecovery, stored: await verifyStored(cancellationSample, cancellationExpected) };
    report.successes.push({ sample: cancellationSample, expected: cancellationExpected });

    report.beforeClose = await databaseDigest(database);
    await stop();
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema });
    transport.setMode('blocked'); stage = 'cold-read'; await start();
    const beforeCold = report.requests.length; report.coldReads = [];
    for (const { sample, expected } of report.successes) {
      const response = await request('GET', '/Items/' + sample.itemId + '?userId=' + report.coldReaderId + '&fields=OriginalTitle,Overview,Genres,Tags,Studios,ProviderIds');
      assert.equal(response.status, 200); const body = parseLosslessJson(response.body);
      assert.equal(body.Name, expected.Item.Name); assert.equal(body.Overview, expected.Item.Overview);
      assert.deepEqual(body.Genres, expected.Item.Genres); assert.deepEqual(body.ProviderIds, { OpaqueProvider: 'opaque:traceId:public-source', ...expected.Item.ProviderIds });
      report.coldReads.push({ sample, response, stored: await verifyStored(sample, expected) });
    }
    assert.equal(report.requests.length, beforeCold);
    report.afterCold = await databaseDigest(database); assert.deepEqual(report.afterCold, report.beforeClose);
    await stop();

    stage = 'native-replay';
    const input = { movieId, configuration, cases: providerCases }, inputFile = path.join(output, 'native-input.json');
    const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n'); await writeFile(inputFile, inputBytes, { flag: 'wx' });
    const oracle = await compileOracle({ project: 'tests/metadata/fixtures/tmdb-public-current/Oracle.csproj', output: path.join(output, 'build') });
    report.native = [];
    for (const label of ['native', 'native-repeat']) {
      const nativeRoot = path.join(output, label), receipt = await oracle.record({ output: nativeRoot, args: [inputFile, '{output}/native.json'] });
      const bytes = await readFile(path.join(nativeRoot, 'native.json')), result = parseLosslessJson(bytes.toString('utf8'));
      assert.equal(receipt.passed, true); assert.equal(result.inputSha256, hash(inputBytes));
      assert.equal(result.actualManager, true); assert.equal(result.actualMovieProvider, true);
      assert.equal(result.actualCommonNfoWriter, true);
      assert.equal(result.observations.length, providerCases.length);
      assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(bytes));
      for (const assembly of result.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
      for (const [index, observation] of result.observations.entries()) {
        const expected = providerCases[index]; assert.equal(observation.name, expected.name);
        assert.deepEqual(providerProjection(observation.results[0]), providerProjection(expected.result));
        assert.deepEqual(providerProjection(observation.results[1]), providerProjection(expected.result));
        for (const readback of report.nfoReadbacks.filter(row => isDeepStrictEqual(row.provider, providerProjection(expected.result)))) {
          assert.deepEqual(readback.genres, observation.results[0].commonNfo.genres, 'Actual persisted NFO genre order must match the current Native common writer.');
          assert.deepEqual(readback.genres, observation.results[1].commonNfo.genres);
          if (!readback.nativeComparisons.includes(label)) readback.nativeComparisons.push(label);
        }
        assert.equal(observation.results[0].requestCount, 2); assert.equal(observation.results[1].requestCount, 2);
        assert.deepEqual(observation.requests, expected.responses.map(value => value.request));
      }
      report.native.push({ label, receipt, sha256: hash(bytes), observations: result.observations });
    }
    for (const readback of report.nfoReadbacks) assert.deepEqual(readback.nativeComparisons, ['native', 'native-repeat']);
    for (const response of report.requests.filter(value => value.publicResponse)) assert.equal(hash(await readFile(response.filename)), response.sha256);
    assert.equal(hash(await readFile(optionsFile)), report.libraryOptions.sha256, 'The persisted library writer policy remains unchanged.');
    const after = await verifyNativeBuild(); assert.equal(after.identitySha256, nativeBuild.identitySha256);
    report.nativeInputsUnchanged = true;
  } catch (error) { primary = error; failed = true; report.failure = errorObservation(error); }
  finally {
    const failures = [];
    try { await stop(); } catch (error) { failures.push(error); }
    try { if (database) { await dropPostgresTestDatabase(database); const audit = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
      try { await audit.connect(); assert.deepEqual((await audit.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)', [[schema, controlSchema]])).rows, []);
        report.ownedSchemasRemoved = true; } finally { await audit.end(); } } }
    catch (error) { failures.push(error); }
    report.errors = errors;
    if (failures.length) report.cleanupFailures = failures.map(error => errorObservation(error));
    try { await writeReport(); } catch (error) { failures.push(error); }
    if (failures.length) {
      const reasons = [...(failed ? [primary] : []), ...failures];
      const failure = reasons.length === 1 ? reasons[0] : new AggregateError(reasons, 'Public TMDB validation and resource cleanup failed.', { cause: reasons[0] });
      throw new Error(redact(failure.message), { cause: JSON.parse(safe(errorObservation(failure))) });
    }
  }
  if (failed) throw new Error(redact(primary.message), { cause: JSON.parse(safe(errorObservation(primary))) });
});
