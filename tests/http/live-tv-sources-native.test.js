import test, { after } from 'node:test';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { startProductionInstance } from '../../src/main.js';
import { dateTicks } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { prepareNativeMediaSeed } from './native-media-seed.js';
import { errorObservation } from '../helpers/error-observation.js';
import { canonical, canonicalRows, databaseFilename, idKey, initialConfiguration,
  portableMountContract, prepareSources, sha, snapshot, sqliteSnapshot, stateFiles, storageDocument } from './fixtures/live-tv-sources-http/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const resourceLease = enabled ? await acquireTestResource('hdhomerun-discovery-65001') : null;
const inputBytes = await readFile(new URL('./fixtures/live-tv-sources-http/input.json', import.meta.url)), input = JSON.parse(inputBytes);
const authorization = token => `MediaBrowser Client="Live TV sources", Device="Isolated", DeviceId="live-tv-sources-http", Version="1"${token ? `, Token="${token}"` : ''}`;
const wire = (response, route, options) => ({ status: response.status, contentType: response.contentType,
  body: Object.hasOwn(response, 'bodyJson') ? canonical(response.bodyJson,
    { ...options, role: 'http', route, status: response.status }) : response.bodyText });
const sha1 = value => createHash('sha1').update(value, 'utf8').digest('hex');
const sleep = () => new Promise(resolve => setTimeout(resolve, 100));
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(error => error ? reject(error) : resolve(port));
  });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer(); server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

test('M3U XMLTV source management matches actual native HTTP, configuration and queued Guide consumers through production PostgreSQL', {
  skip: !enabled, timeout: 720000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-sources-http-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES); await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), nativeCache = path.join(referenceRoot, 'cache');
  const nodeCache = path.join(referenceRoot, 'data/cache'), port = await unusedPort(), nativeOrigin = `http://127.0.0.1:${port}`;
  const report = { inputSha256: sha(inputBytes), cases: [], differences: [], stages: [], processes: [], cleanup: [], runtimeErrors: [], nodeShutdownStates: [] };
  const failures = [];
  const tokens = { anonymous: undefined, invalid: 'invalid-live-tv-source-token' }, users = {}, probes = [], engines = {};
  report.engines = engines;
  let current, native, database, application, sources, initialFiles;
  const request = async (origin, route, { mode = 'apiKey', token = tokens[mode], method = 'GET', body, rawBody, contentType = 'application/json' } = {}) => {
    const startedAt = Date.now();
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000), headers: {
      Authorization: authorization(token), Accept: 'application/json', ...((body !== undefined || rawBody !== undefined) ? { 'Content-Type': contentType } : {}) },
    ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text(); let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Preserve full raw non-JSON errors and raw country bytes. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }), startedAt, finishedAt: Date.now() };
  };
  const collect = (name, operation) => { try { operation(); } catch (cause) { report.differences.push({ name, message: cause.message }); } };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status,
      () => portAvailable(port));
    report.processes.push({ label, ...result }); native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const startNative = async label => { native = current.start({ referenceRoot, outputRoot: root, label, origin: nativeOrigin }); await native.ready(); };
  const capture = async engine => ({ database: engine.name === 'native' ? await sqliteSnapshot(referenceRoot) : await application.store.run(snapshot),
    ...(engine.name === 'node' ? { nativeState: await application.store.run(database => database.getState('liveTvNativeState')) } : {}),
    files: await stateFiles(referenceRoot, engine.cachePath, sources) });
  const guideTask = async engine => {
    const response = await request(engine.origin, '/ScheduledTasks'); assert.equal(response.status, 200);
    const task = response.bodyJson.find(value => value.Key === 'RefreshGuide'); assert.ok(task, 'The actual registered Guide task must be present.'); return task;
  };
  const finishGuide = async (engine, previous, expected) => {
    const deadline = Date.now() + 90000, observations = [];
    engine.currentGuideObservation = { operation: engine.currentOperation, previous, expected, observations };
    while (true) {
      const task = await guideTask(engine); observations.push(task);
      if (task.State === 'Idle' && task.LastExecutionResult?.StartTimeUtc !== previous?.LastExecutionResult?.StartTimeUtc) {
        assert.equal(task.LastExecutionResult?.Status, 'Completed', 'The actual queued Guide task must complete.');
        const state = await capture(engine), live = state.database.BaseItems.filter(row => /\.LiveTv(?:Channel|Program)$/u.test(row.Type));
        engine.currentGuideObservation.state = state;
        if (expected) {
          assert.equal(live.filter(row => row.Type.endsWith('.LiveTvChannel')).length, expected.channels);
          assert.equal(live.filter(row => row.Type.endsWith('.LiveTvProgram')).length, expected.programs);
        }
        return { task, observations, state };
      }
      assert.ok(Date.now() < deadline, 'The source mutation must produce a new completed Guide execution.'); await sleep();
    }
  };
  const probeFiles = async (engine, name, state) => {
    const directory = path.join(root, 'captured-files'); await mkdir(directory, { recursive: true });
    for (const [relative, description] of [['configuration', state.files.configuration], ...Object.entries(state.files.cache).filter(([name]) => name.endsWith('_channels'))]) {
      const kind = relative === 'configuration' ? 'configuration' : 'channels', filename = path.join(directory, String(probes.length) + (kind === 'configuration' ? '.xml' : '.json'));
      const bytes = Buffer.from(description.base64, 'base64'); assert.equal(sha(bytes), description.sha256); await writeFile(filename, bytes, { flag: 'wx' });
      probes.push({ name: engine.name + '/' + name + '/' + relative, engine: engine.name, stage: name, relative, kind, filename, sha256: sha(bytes) });
    }
  };
  const assertInputs = state => {
    for (const key of ['timers', 'seriesTimers', 'playlist', 'guide', 'retainedSeed', 'countries', 'sentinel']) assert.deepEqual(state.files[key], initialFiles[key], key + ': controlled source bytes must be preserved');
    assert.deepEqual(JSON.parse(Buffer.from(state.files.timers.base64, 'base64')), []);
    assert.deepEqual(JSON.parse(Buffer.from(state.files.seriesTimers.base64, 'base64')), []);
    assert.ok(!Object.keys(state.files.cache).some(name => name.endsWith('.tmp')), 'No XMLTV temporary download may escape task completion.');
  };
  const observe = async (engine, name, route, options = {}) => {
    const errorIndex = report.runtimeErrors.length;
    engine.currentOperation = { name, route, method: options.method ?? 'GET' };
    const before = await capture(engine), previous = options.guide ? await guideTask(engine) : null;
    const requestErrorIndex = report.runtimeErrors.length, index = engine.cases.length;
    const response = await request(engine.origin, route, options);
    const requestErrorEnd = report.runtimeErrors.length;
    const guide = options.guide ? await finishGuide(engine, previous, options.expectedGuide) : undefined;
    const after = guide?.state ?? await capture(engine);
    engine.currentObservation = { name, route, method: options.method ?? 'GET', mode: options.mode ?? 'apiKey', response, before, after };
    assertInputs(after);
    const errors = engine.name === 'node' ? report.runtimeErrors.slice(errorIndex) : [];
    if (engine.name === 'node') {
      for (const error of report.runtimeErrors.slice(requestErrorIndex, requestErrorEnd)) {
        error.requestObservation = { index, name, method: options.method ?? 'GET', route, mode: options.mode ?? 'apiKey', status: response.status };
      }
    }
    if (options.unchanged) {
      assert.deepEqual(canonicalRows(after.database), canonicalRows(before.database), name + ': rejected/read-only requests must preserve rows');
      assert.deepEqual(after.files, before.files, name + ': rejected requests must preserve all captured files');
    }
    const value = { name, request: { route, method: options.method ?? 'GET', mode: options.mode ?? 'apiKey',
      ...(options.body === undefined ? {} : { body: options.body }), ...(options.rawBody === undefined ? {} : { rawBody: options.rawBody }),
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }) }, response, before, after, errors, ...(guide ? { guide } : {}) };
    engine.cases.push(value); await probeFiles(engine, name, after);
    await writeFile(path.join(root, engine.name + '-progress.log'), filterEvidenceJson({ name, request: value.request, response }) + '\n', { flag: 'a' });
    return value;
  };
  const identify = async (engine, value, kind) => {
    assert.equal(value.response.status, 200); const info = value.response.bodyJson;
    assert.match(info.Id, /^[a-f\d]{32}$/u); assert.equal(info.Type.toLowerCase(), kind === 'tuner' ? 'm3u' : 'xmltv');
    assert.ok(!Object.hasOwn(engine.ids, info.Id), 'Generated source identities must be unique.');
    const configuration = await request(engine.origin, '/System/Configuration/livetv'); assert.equal(configuration.status, 200);
    const matches = configuration.bodyJson[kind === 'tuner' ? 'TunerHosts' : 'ListingProviders'].filter(item => item.Id === info.Id);
    assert.equal(matches.length, 1); assert.deepEqual(matches[0], info);
    assert.ok(Buffer.from(value.after.files.configuration.base64, 'base64').toString().includes('<Id>' + info.Id + '</Id>'));
    assert.equal(info[kind === 'tuner' ? 'Url' : 'Path'], kind === 'tuner' ? sources.playlist : sources.guide);
    (engine.identityChecks ??= []).push({ kind, returned: info, configuration }); engine.ids[info.Id] = '$' + kind;
    return info;
  };
  const sourceState = async (engine, name) => {
    const configuration = await observe(engine, name + ': named configuration', '/System/Configuration/livetv', { unchanged: true });
    assert.equal(configuration.response.status, 200); return configuration.response.bodyJson;
  };
  const guideReaders = async (engine, name, count) => {
    const channels = await observe(engine, name + ': channels', '/LiveTv/Channels?enableImages=false&enableUserData=false&addCurrentProgram=false', { mode: 'allowed', unchanged: true });
    const programs = await observe(engine, name + ': programmes', '/LiveTv/Programs?enableImages=false&enableUserData=false', { mode: 'allowed', unchanged: true });
    assert.equal(channels.response.status, 200); assert.equal(programs.response.status, 200);
    assert.equal(channels.response.bodyJson.TotalRecordCount, 2); assert.equal(programs.response.bodyJson.TotalRecordCount, count);
    for (const channel of sources.channels) {
      const item = channels.response.bodyJson.Items.find(value => idKey(value.Id) === idKey(channel.internalId));
      assert.ok(item, 'Persisted channel DTO must have the actual native typed identity.'); assert.equal(item.Name, channel.name); assert.equal(item.ChannelNumber, channel.number);
    }
    for (const item of programs.response.bodyJson.Items) {
      assert.ok(sources.channels.some(value => idKey(value.internalId) === idKey(item.ChannelId)));
      assert.equal(dateTicks(item.StartDate), dateTicks(sources.start)); assert.equal(dateTicks(item.EndDate), dateTicks(sources.end));
      assert.ok(item.StartDate.endsWith('Z') && item.EndDate.endsWith('Z')); assert.ok(input.channels.some(channel => channel.title === item.Name));
    }
  };
  const scenario = async engine => {
    engine.cases = []; engine.ids = {}; engines[engine.name] = engine;
    const baseline = await capture(engine); assertInputs(baseline); engine.baseline = baseline;
    for (const [name, route] of [['types', '/LiveTv/TunerHosts/Types'], ['listing default', '/LiveTv/ListingProviders/Default'],
      ['lineups', '/LiveTv/ListingProviders/Lineups?type=not-installed-source-fixture'], ['mapping options', '/LiveTv/ChannelMappingOptions?providerId=missing'],
      ['countries', '/LiveTv/ListingProviders/SchedulesDirect/Countries']]) {
      for (const mode of ['anonymous', 'invalid', 'allowed', 'denied', 'manager', 'admin', 'apiKey']) {
        const item = await observe(engine, 'authorization ' + name + ':' + mode, route, { mode, unchanged: true });
        if (mode === 'anonymous' || mode === 'invalid') assert.equal(item.response.status, 401);
        if (name === 'types' && item.response.status === 200) engine.inventory ??= item.response.bodyJson;
        if (name === 'countries' && item.response.status === 200) assert.equal(item.response.bodyText, input.countries);
      }
    }
    for (const route of ['/LiveTv/TunerHosts', '/LiveTv/ListingProviders', '/LiveTv/ChannelMappings']) {
      for (const mode of ['anonymous', 'invalid', 'allowed', 'denied', 'manager']) {
        const item = await observe(engine, 'write authorization ' + route + ':' + mode, route, { method: 'POST', mode, body: {}, unchanged: true });
        assert.equal(item.response.status, ['anonymous', 'invalid'].includes(mode) ? 401 : 403);
      }
    }
    for (const route of ['/LiveTv/TunerHosts?id=missing', '/LiveTv/ListingProviders?id=missing', '/LiveTv/Tuners/Discover', '/LiveTv/Tuners/Discvover']) {
      for (const mode of ['anonymous', 'invalid', 'allowed', 'denied', 'manager']) {
        const item = await observe(engine, 'delete/discovery authorization ' + route + ':' + mode, route,
          { method: route.includes('Providers') || route.includes('TunerHosts') ? 'DELETE' : 'GET', mode, unchanged: true });
        assert.equal(item.response.status, ['anonymous', 'invalid'].includes(mode) ? 401 : 403);
      }
    }
    for (const route of ['/LiveTv/Tuners/Discover', '/LiveTv/Tuners/Discvover']) for (const mode of ['admin', 'apiKey']) {
      const item = await observe(engine, 'discovery bool binding ' + route + ':' + mode, route + '?newDevicesOnly=invalid', { mode, unchanged: true }); assert.equal(item.response.status, 400);
    }
    const invalidBodies = [{ name: 'empty body', rawBody: '' }, { name: 'null body', rawBody: 'null' }, { name: 'array body', rawBody: '[]' },
      { name: 'malformed body', rawBody: '{"Id":' }, { name: 'wrong content type', rawBody: '{}', contentType: 'text/plain' }];
    for (const route of ['/LiveTv/TunerHosts', '/LiveTv/ListingProviders', '/LiveTv/ChannelMappings']) {
      for (const item of invalidBodies) {
        const observed = await observe(engine, 'typed ' + route + ':' + item.name, route, { ...item, method: 'POST', unchanged: true }); assert.ok(observed.response.status >= 400);
      }
    }
    for (const [name, route, rawBody] of [
      ['quoted Boolean', '/LiveTv/TunerHosts', '{"Type":"m3u","AllowHWTranscoding":"true"}'],
      ['invalid first duplicate', '/LiveTv/TunerHosts', '{"Type":"m3u","TunerCount":{},"TunerCount":1}'],
      ['int overflow', '/LiveTv/TunerHosts', '{"Type":"m3u","TunerCount":"2147483648"}'],
      ['listings categories type', '/LiveTv/ListingProviders', '{"Type":"xmltv","KidsCategories":{}}'],
      ['mapping required fields', '/LiveTv/ChannelMappings', '{}'],
      ['mapping null required fields', '/LiveTv/ChannelMappings', '{"ProviderId":null,"TunerChannelId":"","ProviderChannelId":" "}'],
    ]) assert.ok((await observe(engine, 'typed ' + name, route, { rawBody, method: 'POST', unchanged: true })).response.status >= 400);
    for (const route of ['/LiveTv/ListingProviders?validateLogin=invalid', '/LiveTv/ListingProviders?validateListings=invalid']) {
      assert.equal((await observe(engine, 'typed query ' + route, route, { method: 'POST', body: { Type: 'xmltv', Path: sources.guide }, unchanged: true })).response.status, 400);
    }
    for (const [name, route, body] of [['unknown tuner', '/LiveTv/TunerHosts', { Type: 'not-installed-source-fixture' }],
      ['unknown listings', '/LiveTv/ListingProviders', { Type: 'not-installed-source-fixture' }],
      ['missing mapping provider', '/LiveTv/ChannelMappings', { ProviderId: 'missing', TunerChannelId: 'missing', ProviderChannelId: 'c1' }]]) {
      assert.ok((await observe(engine, name, route, { method: 'POST', body, unchanged: true })).response.status >= 400);
    }
    const listingResult = await observe(engine, 'create XMLTV listing', '/LiveTv/ListingProviders?validateLogin=true&validateListings=true&pw=controlled-password',
      { method: 'POST', body: { Type: 'xmltv', Path: sources.guide, Name: 'Controlled listings', EnableAllTuners: true }, guide: true, expectedGuide: { channels: 0, programs: 0 } });
    engine.listing = await identify(engine, listingResult, 'listing');
    assert.equal(engine.listing.Password, sha1('controlled-password'));
    const tunerResult = await observe(engine, 'create M3U tuner', '/LiveTv/TunerHosts', { method: 'POST',
      body: { Type: 'm3u', Url: sources.playlist, UserAgent: input.userAgent, TunerCount: '0', AllowHWTranscoding: true }, guide: true, expectedGuide: { channels: 2, programs: 1 } });
    engine.tuner = await identify(engine, tunerResult, 'tuner');
    let configuration = await sourceState(engine, 'created');
    assert.equal(configuration.TunerHosts[0].Id, engine.tuner.Id); assert.equal(configuration.ListingProviders[0].Id, engine.listing.Id);
    await guideReaders(engine, 'before mapping', 1);
    const options = await observe(engine, 'real provider mapping options', '/LiveTv/ChannelMappingOptions?providerId=' + engine.listing.Id);
    assert.equal(options.response.status, 200);
    assert.deepEqual(options.response.bodyJson.TunerChannels.map(value => value.Id), sources.channels.map(value => value.externalId));
    assert.equal(options.response.bodyJson.TunerChannels[0].ProviderChannelId, undefined);
    assert.equal(options.response.bodyJson.TunerChannels[1].ProviderChannelId, 'c2');
    assert.deepEqual(options.response.bodyJson.ProviderChannels.map(value => value.Id), ['c1', 'c2']);
    const mapBody = { ProviderId: engine.listing.Id, TunerChannelId: sources.channels[0].externalId, ProviderChannelId: 'c1' };
    for (const [name, count] of [['set explicit mapping', 2], ['identical mapping removes existing pair', 1], ['restore explicit mapping', 2]]) {
      const mapped = await observe(engine, name, '/LiveTv/ChannelMappings', { method: 'POST', body: mapBody, guide: true, expectedGuide: { channels: 2, programs: count } });
      assert.equal(mapped.response.status, 200); await guideReaders(engine, name, count);
    }
    const failedMapping = await observe(engine, 'missing tuner mapping saves before lookup failure', '/LiveTv/ChannelMappings', {
      method: 'POST', body: { ...mapBody, TunerChannelId: 'missing-tuner' }, guide: true, expectedGuide: { channels: 2, programs: 2 } });
    assert.equal(failedMapping.response.status, 500);
    configuration = await sourceState(engine, 'failed mapping prefix');
    assert.ok(configuration.ListingProviders[0].ChannelMappings.some(value => value.Name === 'missing-tuner' && value.Value === 'c1'));
    engine.listing = configuration.ListingProviders[0];
    const disabled = await observe(engine, 'disable listing for all tuners', '/LiveTv/ListingProviders', { method: 'POST',
      body: { ...engine.listing, EnableAllTuners: false, EnabledTuners: [] }, guide: true, expectedGuide: { channels: 2, programs: 0 } });
    assert.equal(disabled.response.status, 200); assert.equal(disabled.response.bodyJson.Id, engine.listing.Id);
    assert.equal(disabled.after.files.cache['xmltv/' + engine.listing.Id + '.xml'], undefined, 'Saving listings must invalidate its actual XML cache even when Guide skips it.');
    const restored = await observe(engine, 'enable listing by case insensitive tuner identity', '/LiveTv/ListingProviders', { method: 'POST',
      body: { ...disabled.response.bodyJson, EnabledTuners: [engine.tuner.Id.toUpperCase()] }, guide: true, expectedGuide: { channels: 2, programs: 2 } });
    assert.equal(restored.response.status, 200); engine.listing = restored.response.bodyJson;
    const lineups = await observe(engine, 'lineups consume real configured XMLTV', '/LiveTv/ListingProviders/Lineups?id=' + engine.listing.Id + '&type=ignored&country=CC&location=controlled');
    assert.equal(lineups.response.status, 200); assert.deepEqual(lineups.response.bodyJson.map(value => value.Id), ['c1', 'c2']);
    await guideReaders(engine, 'warm persisted guide', 2); await sourceState(engine, 'warm');
    engine.beforeCold = await capture(engine); await engine.restart(); engine.afterCold = await capture(engine); assertInputs(engine.afterCold);
    assert.deepEqual(canonicalRows(engine.afterCold.database), canonicalRows(engine.beforeCold.database), 'Cold startup must preserve persisted current rows.');
    assert.deepEqual(engine.afterCold.files, engine.beforeCold.files, 'Cold startup must preserve source/config/cache bytes.');
    await guideReaders(engine, 'cold persisted guide', 2); await sourceState(engine, 'cold');
    assert.equal((await observe(engine, 'cold mapping cache consumers', '/LiveTv/ChannelMappingOptions?providerId=' + engine.listing.Id)).response.status, 200);
    const updated = await observe(engine, 'update existing tuner preserves identity and flags', '/LiveTv/TunerHosts', { method: 'POST',
      body: { ...engine.tuner, Type: 'M3U', AllowHWTranscoding: false, DeviceId: 'controlled-device' }, guide: true, expectedGuide: { channels: 2, programs: 2 } });
    assert.equal(updated.response.status, 200); assert.equal(updated.response.bodyJson.Id, engine.tuner.Id); assert.equal(updated.response.bodyJson.AllowHWTranscoding, false);
    const listingDelete = await observe(engine, 'delete listing ignores id case', '/LiveTv/ListingProviders?id=' + engine.listing.Id.toUpperCase(),
      { method: 'DELETE', guide: true, expectedGuide: { channels: 2, programs: 0 } });
    assert.equal(listingDelete.response.status, 204); assert.equal(listingDelete.after.files.cache['xmltv/' + engine.listing.Id + '.xml'], undefined);
    assert.equal((await observe(engine, 'non GUID tuner delete cannot touch cache sentinel', '/LiveTv/TunerHosts?id=..%2Fdata%2Fsource-sentinel', {
      method: 'DELETE', guide: true, expectedGuide: { channels: 2, programs: 0 } })).response.status, 204);
    const deleted = await observe(engine, 'delete tuner ignores id case', '/LiveTv/TunerHosts?id=' + engine.tuner.Id.toUpperCase(),
      { method: 'DELETE', guide: true, expectedGuide: { channels: 0, programs: 0 } });
    assert.equal(deleted.response.status, 204); assert.equal(deleted.after.files.cache[engine.tuner.Id + '_channels'], undefined);
    for (const route of ['/LiveTv/TunerHosts', '/LiveTv/ListingProviders']) assert.equal((await observe(engine, 'delete absent ' + route, route,
      { method: 'DELETE', guide: true, expectedGuide: { channels: 0, programs: 0 } })).response.status, 204);
    await sourceState(engine, 'cleared'); engine.final = await capture(engine); engine.clock.end = Date.now();
    assertInputs(engine.final);
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LiveTvController.cs', 'Jellyfin.Api/Models/LiveTvDtos/SetChannelMappingDto.cs',
      'src/Jellyfin.LiveTv/TunerHosts/TunerHostManager.cs', 'src/Jellyfin.LiveTv/TunerHosts/BaseTunerHost.cs', 'src/Jellyfin.LiveTv/TunerHosts/M3UTunerHost.cs',
      'src/Jellyfin.LiveTv/Listings/ListingsManager.cs', 'src/Jellyfin.LiveTv/Listings/XmlTvListingsProvider.cs', 'src/Jellyfin.LiveTv/Listings/EpgChannelData.cs',
      'src/Jellyfin.LiveTv/Guide/GuideManager.cs', 'src/Jellyfin.LiveTv/Guide/RefreshGuideScheduledTask.cs',
      'src/Jellyfin.LiveTv/DefaultLiveTvService.cs', 'src/Jellyfin.LiveTv/Timers/TimerManager.cs', 'src/Jellyfin.LiveTv/Timers/SeriesTimerManager.cs',
      'src/Jellyfin.LiveTv/Listings/SchedulesDirect.cs', 'Emby.Server.Implementations/Serialization/MyXmlSerializer.cs',
      'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonStringConverter.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    sources = await prepareSources(path.join(root, 'sources'), input); report.sources = sources;
    report.originalSeedPreparation = await prepareNativeMediaSeed(referenceRoot, sources.root);
    sources.retainedSeed = report.originalSeedPreparation.files.retainedSeed;
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), initialConfiguration(input.guideDays));
    await mkdir(path.join(referenceRoot, 'data/data/livetv'), { recursive: true });
    for (const name of ['timers.json', 'seriestimers.json']) await writeFile(path.join(referenceRoot, 'data/data/livetv', name), '[]\n');
    await mkdir(nativeCache, { recursive: true });
    await writeFile(path.join(nativeCache, 'sd-countries.json'), input.countries);
    await writeFile(path.join(path.dirname(nativeCache), 'data/source-sentinel_channels'), input.sentinel, { flag: 'wx' });
    await startNative('native-prepare');
    const taskResponse = await request(nativeOrigin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(taskResponse.status, 200);
    for (const task of taskResponse.bodyJson) assert.equal((await request(nativeOrigin, '/ScheduledTasks/' + task.Id + '/Triggers', {
      token: current.accessToken, method: 'POST', body: [] })).status, 204);
    const deadline = Date.now() + 60000;
    while (true) {
      const response = await request(nativeOrigin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(response.status, 200);
      if (response.bodyJson.every(task => task.State !== 'Running' && task.State !== 'Cancelling')) {
        assert.ok(response.bodyJson.every(task => task.Triggers.length === 0)); report.backgroundControls = response.bodyJson; break;
      }
      assert.ok(Date.now() < deadline, 'Fresh native startup tasks must finish before baseline transfer.'); await sleep();
    }
    for (const [mode, policy] of Object.entries({ allowed: { EnableLiveTvAccess: true, EnableLiveTvManagement: false },
      denied: { EnableLiveTvAccess: false, EnableLiveTvManagement: false }, manager: { EnableLiveTvAccess: true, EnableLiveTvManagement: true },
      admin: { IsAdministrator: true, EnableLiveTvAccess: false, EnableLiveTvManagement: false } })) {
      const name = 'Sources_' + mode + '_' + randomUUID().slice(0, 8), password = randomUUID(); output.addSecret(password);
      const created = await request(nativeOrigin, '/Users/New', { token: current.accessToken, method: 'POST', body: { Name: name, Password: password } });
      assert.equal(created.status, 200); users[mode] = created.bodyJson;
      assert.equal((await request(nativeOrigin, '/Users/' + created.bodyJson.Id + '/Policy', { token: current.accessToken,
        method: 'POST', body: { ...created.bodyJson.Policy, ...policy } })).status, 204);
      const login = await request(nativeOrigin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: name, Pw: password } });
      assert.equal(login.status, 200); tokens[mode] = login.bodyJson.AccessToken; output.addSecret(tokens[mode]);
    }
    const appName = 'Sources ' + randomUUID();
    assert.equal((await request(nativeOrigin, '/Auth/Keys?app=' + encodeURIComponent(appName), { token: current.accessToken, method: 'POST' })).status, 204);
    const keys = await request(nativeOrigin, '/Auth/Keys', { token: current.accessToken }); assert.equal(keys.status, 200);
    tokens.apiKey = keys.bodyJson.Items.find(value => value.AppName === appName).AccessToken; output.addSecret(tokens.apiKey);
    assert.equal((await request(nativeOrigin, '/LiveTv/Channels?enableImages=false&enableUserData=false')).status, 200);
    await stopNative('native-prepare');
    const baselineXml = await readFile(path.join(referenceRoot, 'config/livetv.xml'));
    initialFiles = await stateFiles(referenceRoot, nativeCache, sources); report.initialFiles = initialFiles;
    const source = new SqliteDatabase(databaseFilename(referenceRoot), { readOnly: true, requireMigrationHistory: true });
    try {
      database = await createPostgresTestDatabase(null, 'source_http'); const instance = await discoverInstanceState({ instanceRoot: referenceRoot });
      report.transfer = await transferDatabase(source, database, { instanceBinding: { serverId: current.preparation.nativeServerId,
        originIdentityDigest: instance.identity.digest }, portableMountContract: portableMountContract(sources.root) });
    } finally { source.close(); }
    await database.close();
    const nativeEngine = { name: 'native', origin: nativeOrigin, cachePath: nativeCache, clock: { start: Date.now() },
      async restart() { const before = await capture(nativeEngine); await stopNative('native-warm'); await startNative('native-cold');
        report.stages.push({ name: 'native cold restart', before, after: await capture(nativeEngine) }); } };
    await startNative('native-warm'); await scenario(nativeEngine); await stopNative('native-cold');
    report.nativeAfterShutdown = await capture(nativeEngine); assert.deepEqual(report.nativeAfterShutdown, nativeEngine.final);
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), baselineXml);
    await mkdir(nodeCache, { recursive: true }); await writeFile(path.join(nodeCache, 'sd-countries.json'), input.countries);
    await writeFile(path.join(path.dirname(nodeCache), 'data/source-sentinel_channels'), input.sentinel, { flag: 'wx' });
    const storageFile = path.join(root, 'storage.json'); await writeFile(storageFile, JSON.stringify(storageDocument(sources.root)));
    const environment = { ...process.env, MEDIAMANAGER_INSTANCE: referenceRoot, MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES,
      MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName, MEDIAMANAGER_STORAGE: storageFile };
    const startNode = async () => {
      const networkFilename = path.join(referenceRoot, 'config/network.xml'), networkBytes = await readFile(networkFilename);
      (report.nodeNetworkInputs ??= []).push({ bytes: networkBytes.length, sha256: sha(networkBytes), base64: networkBytes.toString('base64'),
        scope: 'Native is stopped; warm and cold Node lifetimes reuse its unchanged current copy and reserved port.' });
      const app = await startProductionInstance({ environment, onError: cause => report.runtimeErrors.push({ name: cause?.name, code: cause?.code, failure: errorObservation(cause),
        message: cause?.message ?? String(cause), status: cause?.status ?? cause?.statusCode, stack: cause?.stack, value: inspect(cause, { depth: 8 }) }) });
      application = app;
      assert.equal(app.networkHost.listeners.find(entry => entry.scheme === 'http').port, port);
      assert.deepEqual(await readFile(networkFilename), networkBytes);
      const closeStore = app.store.close.bind(app.store);
      app.store.close = async () => {
        report.nodeShutdownStates.push({ database: await app.store.run(snapshot), nativeState: await app.store.run(database => database.getState('liveTvNativeState')),
          files: await stateFiles(referenceRoot, nodeCache, sources) });
        return closeStore();
      };
      return app;
    };
    const nodeEngine = { name: 'node', cachePath: nodeCache, clock: { start: Date.now() }, async restart() {
      const before = await capture(nodeEngine), listeners = application.networkHost.listeners;
      await application.close(); assert.ok(listeners.every(listener => !listener.server.listening));
      for (const listener of listeners.filter(entry => entry.bound)) assert.equal(await portAvailable(listener.port), true);
      application = await startNode(); nodeEngine.origin = 'http://127.0.0.1:' + application.networkHost.listeners.find(entry => entry.scheme === 'http').port;
      report.stages.push({ name: 'node cold restart', before, after: await capture(nodeEngine) }); } };
    application = await startNode(); nodeEngine.origin = 'http://127.0.0.1:' + application.networkHost.listeners.find(entry => entry.scheme === 'http').port;
    assert.ok(application.liveTvSources && application.liveTvTuners && application.liveTvGuide && application.liveTvCountries);
    await scenario(nodeEngine);
    assert.deepEqual(canonicalRows(nodeEngine.baseline.database), canonicalRows(nativeEngine.baseline.database), 'Both HTTP sequences must begin with the same stopped transferred rows.');
    report.inventories = { native: nativeEngine.inventory, node: nodeEngine.inventory };
    assert.deepEqual(nodeEngine.inventory, nativeEngine.inventory, 'The installed official tuner inventory must match the complete native inventory.');
    assert.equal(nodeEngine.cases.length, nativeEngine.cases.length);
    const routeIdentity = (value, engine) => {
      for (const [identity, label] of Object.entries(engine.ids)) {
        if (value === identity + '_channels') return label + '_channels';
        if (value === 'xmltv/' + identity + '.xml') return 'xmltv/' + label + '.xml';
      }
      return value.replace(/([?&](?:id|providerId)=)([^&#]*)/giu, (match, prefix, identity) => {
        try { return prefix + (engine.ids[idKey(decodeURIComponent(identity))] ?? identity); } catch { return match; }
      });
    };
    for (const [index, candidate] of nodeEngine.cases.entries()) {
      const expected = nativeEngine.cases[index], name = candidate.name; assert.equal(name, expected.name);
      const options = engine => ({ ids: engine.ids, clock: engine.clock,
        baselineItems: new Map(engine.baseline.database.BaseItems.map(row => [idKey(row.Id), row])),
        inheritedItemValueIds: new Set(engine.baseline.database.ItemValues.map(value => idKey(value.ItemValueId))) });
      collect(name + ': request', () => {
        assert.deepEqual(canonical({ ...candidate.request, route: routeIdentity(candidate.request.route, nodeEngine) },
          { ...options(nodeEngine), role: 'request', route: candidate.request.route }),
        canonical({ ...expected.request, route: routeIdentity(expected.request.route, nativeEngine) },
          { ...options(nativeEngine), role: 'request', route: expected.request.route }));
      });
      collect(name + ': HTTP', () => {
        assert.deepEqual(wire(candidate.response, candidate.request.route, options(nodeEngine)),
          wire(expected.response, expected.request.route, options(nativeEngine)));
      });
      collect(name + ': current rows', () => assert.deepEqual(canonicalRows(candidate.after.database, options(nodeEngine)), canonicalRows(expected.after.database, options(nativeEngine))));
      const cacheKeys = (value, engine) => Object.keys(value.after.files.cache).map(key => routeIdentity(key, engine)).sort();
      collect(name + ': raw cache membership', () => assert.deepEqual(cacheKeys(candidate, nodeEngine), cacheKeys(expected, nativeEngine)));
      collect(name + ': protected files and task bytes', () => {
        const retained = value => Object.fromEntries(Object.entries(value.after.files).filter(([key]) => !['cache', 'configuration'].includes(key)));
        assert.deepEqual(retained(candidate), retained(expected));
      });
      for (const [key, description] of Object.entries(candidate.after.files.cache).filter(([key]) => key.startsWith('xmltv/'))) {
        const counterpart = Object.entries(expected.after.files.cache).find(([nativeKey]) => routeIdentity(nativeKey, nativeEngine) === routeIdentity(key, nodeEngine));
        collect(name + ': raw XMLTV cache ' + key, () => { assert.ok(counterpart); assert.deepEqual(description, counterpart[1]); });
      }
      report.cases.push({ name, stateEvidence: { nodeIndex: index, nativeIndex: index },
        node: { request: candidate.request, response: candidate.response }, native: { request: expected.request, response: expected.response } });
    }
    const typedInput = Buffer.from(JSON.stringify({ files: probes })), typedFilename = path.join(root, 'typed-input.json'); await writeFile(typedFilename, typedInput);
    const receipt = await recordOracle({ project: 'tests/http/fixtures/live-tv-sources-http/Oracle.csproj', output: path.join(root, 'typed'), args: [typedFilename, '{output}/typed.json'] });
    const typedBytes = await readFile(path.join(root, 'typed/typed.json')), typed = JSON.parse(typedBytes);
    assert.ok(receipt.passed && typed.actualXmlSerializer && typed.actualTypedChannelCacheReader && !typed.executorsStarted);
    assert.equal(typed.inputSha256, sha(typedInput)); report.typedConsumer = { inputSha256: sha(typedInput), outputSha256: sha(typedBytes), results: typed.results };
    for (const assembly of typed.assemblies) assert.equal(sha(await readFile(assembly.filename)), assembly.sha256);
    for (const entry of probes) assert.equal(typed.results.find(value => value.name === entry.name).sha256, entry.sha256);
    for (const candidate of probes.filter(value => value.engine === 'node')) {
      const relative = routeIdentity(candidate.relative, nodeEngine), expected = probes.find(value => value.engine === 'native'
        && value.stage === candidate.stage && routeIdentity(value.relative, nativeEngine) === relative);
      assert.ok(expected, candidate.name + ': native must produce the same cache/configuration file identity');
      const left = typed.results.find(value => value.name === candidate.name), right = typed.results.find(value => value.name === expected.name);
      collect(candidate.name + ': actual typed file consumer', () => assert.deepEqual(
        { value: canonical(left.value, { ids: nodeEngine.ids, role: candidate.kind }), error: left.error },
        { value: canonical(right.value, { ids: nativeEngine.ids, role: expected.kind }), error: right.error }));
    }
    const listeners = application.networkHost.listeners;
    await application.close(); assert.ok(listeners.every(listener => !listener.server.listening)); application = undefined;
    for (const listener of listeners.filter(entry => entry.bound)) assert.equal(await portAvailable(listener.port), true);
    report.cleanup.push({ name: 'production-runtime', closed: true, listenerReleased: true,
      listeners: listeners.map(({ scheme, address, port, server }) => ({ scheme, address, port, listening: server.listening })) });
    assert.deepEqual(report.nodeShutdownStates.at(-1), nodeEngine.final, 'Shutdown must preserve complete final rows, authoritative timer state and source/cache bytes.');
    assert.deepEqual(report.differences, []);
  } catch (cause) { failures.push(cause); report.failure = errorObservation(cause); report.failureRaw = inspect(cause, { depth: null }); }
  finally {
    try { await stopNative('native-finally'); } catch (cause) { failures.push(cause); report.cleanup.push({ name: 'native', error: errorObservation(cause), raw: inspect(cause, { depth: null }) }); }
    if (application) try {
      const listeners = application.networkHost.listeners;
      await application.close(); assert.ok(listeners.every(listener => !listener.server.listening));
      for (const listener of listeners.filter(entry => entry.bound)) assert.equal(await portAvailable(listener.port), true);
      report.cleanup.push({ name: 'production-runtime-finally', closed: true, listenerReleased: true });
    }
    catch (cause) { failures.push(cause); report.cleanup.push({ name: 'production-runtime', error: errorObservation(cause), raw: inspect(cause, { depth: null }) }); }
    try { await dropPostgresTestDatabase(database); report.cleanup.push({ name: 'postgres-schema', removed: true }); }
    catch (cause) { failures.push(cause); report.cleanup.push({ name: 'postgres-schema', error: errorObservation(cause), raw: inspect(cause, { depth: null }) }); }
    if (current) try { await current.finish(); report.cleanup.push({ name: 'protected-inputs', unchanged: true }); }
    catch (cause) { failures.push(cause); report.inputVerificationFailure = errorObservation(cause); }
    for (const [source, destination] of [['record.json', 'typed-receipt.json'], ['typed.json', 'typed-native.json'],
      ['build.stdout.txt', 'typed-build-stdout.log'], ['build.stderr.txt', 'typed-build-stderr.log'], ['stdout.txt', 'typed-stdout.log'], ['stderr.txt', 'typed-stderr.log']]) {
      try { await writeFile(path.join(root, destination), await readFile(path.join(root, 'typed', source)), { flag: 'wx' }); }
      catch (cause) { if (cause?.code !== 'ENOENT') { failures.push(cause); report.cleanup.push({ name: 'typed-evidence-publication', error: errorObservation(cause), raw: inspect(cause, { depth: null }) }); } }
    }
    report.failures = failures.map(cause => ({ value: errorObservation(cause), raw: inspect(cause, { depth: null }) }));
    report.passed = failures.length === 0; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.discoveryBoundary = 'Discover and Discvover establish authorization and typed bool failure only. Successful ambient HDHomeRun discovery is not claimed. Actual native Guide device scans remain real and visible in native process logs.';
    report.boundary = 'Actual native HTTP/controller/provider/queued Guide with explicitly empty timer inputs, stopped private SQLite core transfer and production PostgreSQL entry with official mapped M3U/XMLTV. Complete response bodies/files/current rows and the complete installed tuner-type inventory are compared. Dynamic source IDs are mapped only after format/uniqueness/config identity checks. Only bounded creation/save/refresh timestamps are compared as observed clocks. No playback, recorder, encoder, full listings-provider execution, CLI import/export roundtrip or final release acceptance.';
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report)); await output.publishAndClose();
  }
  if (failures.length) throw output.publicError(failures.length === 1 && failures[0] instanceof Error ? failures[0]
    : new AggregateError(failures, 'Live TV sources HTTP and cleanup failed.', { cause: failures[0] }));
});

// Release after all test hooks, streams, processes and resource postconditions.
after(async () => { await resourceLease?.release(); });
