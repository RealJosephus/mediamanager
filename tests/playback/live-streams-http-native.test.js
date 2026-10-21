import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { startProductionInstance } from '../../src/main.js';
import { readLiveMediaInfoCache } from '../../src/playback/live-stream-info.js';
import { stringifyNativeJson, parseLosslessJson } from '../../src/core/json.js';
import { md5Guid } from '../../src/core/identity.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { prepareNativeMediaSeed } from '../http/native-media-seed.js';
import { databaseFilename, snapshot, sqliteSnapshot, canonicalRows, portableMountContract, storageDocument } from '../http/fixtures/live-tv-sources-http/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = () => new Promise(resolve => setTimeout(resolve, 100));
const authorize = token => `MediaBrowser Client="Public Live Streams", Device="Private", DeviceId="public-live-http", Version="1"${token ? `, Token="${token}"` : ''}`;
const portAvailable = port => new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
const unusedPort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject).listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
const wave = () => {
  const bytes = Buffer.alloc(16044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40); return bytes;
};

test('public live Open Close and PlaybackInfo match actual native HTTP and real original probing through production PostgreSQL', { skip: !enabled, timeout: 600000 }, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'public-live-http-' + randomUUID())); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root); const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), mediaRoot = path.join(root, 'media');
  const port = await unusedPort(), nativeOrigin = 'http://127.0.0.1:' + port, report = { cases: [], cacheFiles: [], diagnostics: [], cleanup: [], stages: [], upstream: [], rows: {} };
  report.requestedProbeExecutable = validationExecutable('ffprobe');
  let current, native, database, application, sourceServer, failure, sourceOrigin, channelId, openToken, fixtureBytes, playlistFile, playlistBytes;
  const tokens = { anonymous: undefined, invalid: 'invalid-live-public-token' }, users = {};
  const request = async (origin, route, { mode = 'apiKey', token = tokens[mode], method = 'GET', body, rawBody, contentType = 'application/json' } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: authorize(token), Accept: 'application/json',
      ...((rawBody !== undefined || body !== undefined) ? { 'Content-Type': contentType } : {}) },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: stringifyNativeJson(body) } : {}) });
    const text = await response.text(); let value; try { if (text) value = parseLosslessJson(text); } catch { /* Preserve native complete error bodies. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), text, ...(value === undefined ? {} : { value }) };
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request(nativeOrigin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status, () => portAvailable(port));
    report.stages.push({ label, ...result }); native = undefined; assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable);
  };
  const startNative = async label => { native = current.start({ referenceRoot, outputRoot: root, label, origin: nativeOrigin }); await native.ready(); };
  const rows = engine => engine.name === 'native' ? sqliteSnapshot(referenceRoot) : application.store.run(snapshot);
  const timerBytes = async () => Promise.all(['timers.json', 'seriestimers.json'].map(name => readFile(path.join(referenceRoot, 'data/data/livetv', name))));
  const waitIdle = async origin => {
    const deadline = Date.now() + 90000;
    while (true) {
      const tasks = await request(origin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(tasks.status, 200);
      if (tasks.value.every(task => !['Running', 'Cancelling'].includes(task.State))) return tasks.value;
      assert.ok(Date.now() < deadline, 'The actual native preparation tasks must finish.'); await sleep();
    }
  };
  const scenario = async engine => {
    const records = [], baseline = await rows(engine), baselineConfiguration = await readFile(path.join(referenceRoot, 'config/livetv.xml'));
    report.rows[engine.name] = { before: baseline };
    const record = async (name, route, options = {}) => {
      const diagnosticStart = report.diagnostics.length;
      const result = await request(engine.origin, route, options); records.push({ name, route, method: options.method ?? 'GET', mode: options.mode ?? 'apiKey', response: result });
      if (engine.name === 'node') {
        const expected = ['typed missing token', 'typed null body'].includes(name) ? [{ name: 'Error', message: 'Open token cannot be empty.', status: 400 }]
          : ['action cross-user playback forbidden', 'action cross-user open forbidden'].includes(name) ? [{ name: 'Error', message: 'Forbidden', status: 403 }]
          : name === 'unknown user fails after open' ? [{ name: 'Error', message: 'Object reference not set to an instance of an object.', status: 500 }]
          : name === 'profile failure after registration' ? [{ name: 'Error', message: "Guid can't be empty. (Parameter 'id')", status: 400 }]
          : result.status === 500 && ['existing opened PlaybackInfo', 'fresh replacement removed'].includes(name)
            ? [{ name: 'Error', message: 'The requested live stream is unavailable.', status: 500 }]
            : name === 'public unknown byte stream' ? [{ name: 'Error', message: 'Live stream not found.', status: 404 }] : [];
        const diagnostics = report.diagnostics.slice(diagnosticStart);
        assert.deepEqual(diagnostics.map(({ name, message, status }) => ({ name, message, status })), expected,
          name + ': only the exact observed request diagnostic is expected.');
        for (const diagnostic of diagnostics) diagnostic.expectedRequest = name;
      }
      assert.deepEqual(await timerBytes(), [Buffer.from('[]\n'), Buffer.from('[]\n')]); return result;
    };
    for (const mode of ['anonymous', 'invalid', 'allowed', 'denied', 'admin', 'apiKey']) {
      const result = await record('playback authorization ' + mode, '/Items/' + channelId + '/PlaybackInfo', { mode });
      assert.equal(result.status, ['anonymous', 'invalid'].includes(mode) ? 401 : 200);
    }
    const discovery = await record('pre-open media source', '/Items/' + channelId + '/PlaybackInfo'); assert.equal(discovery.status, 200);
    const selected = discovery.value.MediaSources.find(source => source.RequiresOpening); assert.ok(selected);
    assert.equal(selected.Id, md5Guid(sourceOrigin + '/original.wav'));
    assert.equal(selected.OpenToken, md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider') + '_LiveTvChannel_' + channelId + '_' + selected.Id);
    openToken ??= selected.OpenToken; assert.equal(selected.OpenToken, openToken);
    assert.equal((await record('action cross-user playback forbidden', '/Items/' + channelId + '/PlaybackInfo?userId=' + users.allowed.Id, { mode: 'denied' })).status, 403);
    assert.equal((await record('action cross-user open forbidden', '/LiveStreams/Open', { mode: 'denied', method: 'POST', body: { OpenToken: openToken, UserId: users.allowed.Id } })).status, 403);
    assert.equal((await record('empty user ID falls back to current user', '/Items/' + channelId + '/PlaybackInfo?userId=00000000-0000-0000-0000-000000000000', { mode: 'denied' })).status, 200);
    for (const mode of ['anonymous', 'invalid']) assert.equal((await record('open authorization ' + mode, '/LiveStreams/Open', { mode, method: 'POST', body: { OpenToken: openToken } })).status, 401);
    for (const [name, route, options] of [
      ['missing token', '/LiveStreams/Open', {}], ['null body', '/LiveStreams/Open', { rawBody: 'null' }],
      ['array body', '/LiveStreams/Open', { rawBody: '[]' }], ['truncated body', '/LiveStreams/Open', { rawBody: '{"OpenToken":' }],
      ['wrong content type', '/LiveStreams/Open', { rawBody: '{}', contentType: 'text/plain' }],
      ['strict boolean body', '/LiveStreams/Open', { rawBody: '{"EnableDirectPlay":"true"}' }],
      ['invalid number prefix', '/LiveStreams/Open', { rawBody: '{"AudioStreamIndex":"bad","AudioStreamIndex":1}' }],
      ['query and body errors', '/LiveStreams/Open?maxAudioChannels=bad&enableDirectPlay=wrong', { rawBody: '{"StartTimeTicks":{}}' }],
      ['int64 overflow', '/LiveStreams/Open', { rawBody: '{"StartTimeTicks":"9223372036854775808"}' }],
      ['protocol collection required', '/LiveStreams/Open', { rawBody: '{"DirectPlayProtocols":null}' }],
      ['close missing', '/LiveStreams/Close', {}], ['close blank', '/LiveStreams/Close?liveStreamId=%20', {}],
    ]) assert.ok((await record('typed ' + name, route, { ...options, method: 'POST' })).status >= 400);
    const opened = await record('open actual original with no LiveTv permission', '/LiveStreams/Open', { mode: 'denied', method: 'POST', body: { OpenToken: openToken } });
    assert.equal(opened.status, 200); const identity = opened.value.MediaSource.LiveStreamId;
    assert.equal(identity, md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider') + '_' + md5Guid('Jellyfin.LiveTv.DefaultLiveTvService') + '_' + selected.Id);
    assert.equal(opened.value.MediaSource.Path, sourceOrigin + '/original.wav'); assert.equal(opened.value.MediaSource.MediaStreams[0].Index, -1);
    const cache = path.join(engine.cachePath, 'mediainfo', md5Guid(openToken) + '.json'), cacheBytes = await readFile(cache);
    report.cacheFiles.push({ name: engine.name + '/original', filename: cache, length: cacheBytes.length, sha256: sha(cacheBytes), base64: cacheBytes.toString('base64') });
    const second = await record('same reservation retained from API key', '/LiveStreams/Open', { method: 'POST', body: { OpenToken: openToken, UserId: '00000000-0000-0000-0000-000000000000' } });
    assert.equal(second.status, 200); assert.equal(second.value.MediaSource.LiveStreamId, identity); assert.deepEqual(await readFile(cache), cacheBytes);
    const readOpen = () => record('existing opened PlaybackInfo', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { LiveStreamId: identity.toUpperCase(), MediaSourceId: 'ignored-by-existing-stream' } });
    assert.equal((await readOpen()).status, 200);
    assert.equal((await record('first counter close ignores case', '/LiveStreams/Close?liveStreamId=' + identity.toUpperCase(), { method: 'POST' })).status, 204);
    assert.equal((await readOpen()).status, 200);
    assert.equal((await record('last public close', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    assert.equal((await readOpen()).status, 500);
    assert.equal((await record('unknown counter close', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    const blank = openToken.slice(0, openToken.lastIndexOf('_') + 1);
    for (const suffix of ['first', 'replacement']) assert.equal((await record('blank OriginalStreamId ' + suffix, '/LiveStreams/Open?openToken=' + encodeURIComponent(blank), { method: 'POST', body: { OpenToken: 'body-token-must-be-overridden' } })).status, 200);
    const blankCache = path.join(engine.cachePath, 'mediainfo', md5Guid(blank) + '.json'), blankBytes = await readFile(blankCache);
    report.cacheFiles.push({ name: engine.name + '/blank', filename: blankCache, length: blankBytes.length, sha256: sha(blankBytes), base64: blankBytes.toString('base64') });
    assert.equal((await record('fresh replacement only needs one close', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    assert.equal((await record('fresh replacement removed', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { LiveStreamId: identity } })).status, 500);
    const auto = await record('PlaybackInfo AutoOpen', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { AutoOpenLiveStream: true } });
    assert.equal(auto.status, 200); assert.equal(auto.value.MediaSources[0].LiveStreamId, identity);
    assert.equal((await record('close AutoOpen', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    assert.equal((await record('profile failure after registration', '/LiveStreams/Open', { method: 'POST', body: { OpenToken: openToken, DeviceProfile: {} } })).status, 400);
    assert.equal((await record('profile failure ownership remains closable', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { LiveStreamId: identity } })).status, 200);
    assert.equal((await record('close profile-failed ownership', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    assert.equal((await record('unknown user playback remains userless', '/Items/' + channelId + '/PlaybackInfo?userId=ffffffffffffffffffffffffffffffff')).status, 200);
    assert.equal((await record('unknown user fails after open', '/LiveStreams/Open', { method: 'POST', body: { OpenToken: openToken, UserId: 'ffffffffffffffffffffffffffffffff' } })).status, 500);
    assert.equal((await record('unknown user ownership remains closable', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { LiveStreamId: identity } })).status, 200);
    assert.equal((await record('close unknown-user ownership', '/LiveStreams/Close?liveStreamId=' + identity, { method: 'POST' })).status, 204);
    const notAuto = await record('AutoOpen selection is case sensitive', '/Items/' + channelId + '/PlaybackInfo', { method: 'POST', body: { AutoOpenLiveStream: true, MediaSourceId: selected.Id.toUpperCase() } });
    assert.equal(notAuto.status, 200); assert.equal(notAuto.value.MediaSources[0].LiveStreamId, undefined);
    assert.equal((await record('public unknown byte stream', '/LiveTv/LiveStreamFiles/00000000000000000000000000000000/stream.ts', { mode: 'anonymous' })).status, 404);
    assert.equal((await record('public typed byte container', '/LiveTv/LiveStreamFiles/00000000000000000000000000000000/stream.' + 'x'.repeat(41), { mode: 'anonymous' })).status, 400);
    report.rows[engine.name].after = await rows(engine);
    assert.deepEqual(canonicalRows(report.rows[engine.name].after), canonicalRows(baseline), 'Read/open/close must preserve complete bounded library rows.');
    assert.deepEqual(await readFile(path.join(referenceRoot, 'config/livetv.xml')), baselineConfiguration); return records;
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/MediaInfoController.cs', 'Jellyfin.Api/Controllers/LiveTvController.cs',
      'Jellyfin.Api/Models/MediaInfoDtos/OpenLiveStreamDto.cs', 'Jellyfin.Api/Helpers/MediaInfoHelper.cs',
      'src/Jellyfin.LiveTv/LiveTvMediaSourceProvider.cs', 'src/Jellyfin.LiveTv/DefaultLiveTvService.cs', 'src/Jellyfin.LiveTv/TunerHosts/M3UTunerHost.cs',
      'src/Jellyfin.LiveTv/TunerHosts/LiveStream.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'Emby.Server.Implementations/Library/LiveStreamHelper.cs',
      'MediaBrowser.Model/MediaInfo/MediaInfo.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs', 'MediaBrowser.Model/Entities/MediaStream.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port); await mkdir(mediaRoot);
    report.seed = await prepareNativeMediaSeed(referenceRoot, mediaRoot);
    fixtureBytes = wave(); sourceServer = createServer((request, response) => {
      report.upstream.push({ engine: application ? 'node' : 'native', method: request.method, route: request.url, userAgent: request.headers['user-agent'] });
      response.setHeader('Content-Type', 'audio/wav'); response.setHeader('Content-Length', fixtureBytes.length); response.end(fixtureBytes);
    });
    await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve)); sourceOrigin = 'http://127.0.0.1:' + sourceServer.address().port;
    playlistFile = path.join(mediaRoot, 'original.m3u'); playlistBytes = Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="original" tvg-chno="1",Original wave\n' + sourceOrigin + '/original.wav\n');
    await writeFile(playlistFile, playlistBytes, { flag: 'wx' });
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><TunerHosts /><ListingProviders /></LiveTvOptions>');
    await mkdir(path.join(referenceRoot, 'data/data/livetv'), { recursive: true });
    for (const name of ['timers.json', 'seriestimers.json']) await writeFile(path.join(referenceRoot, 'data/data/livetv', name), '[]\n');
    await startNative('native-prepare');
    const allTasks = await request(nativeOrigin, '/ScheduledTasks', { token: current.accessToken }); assert.equal(allTasks.status, 200);
    for (const task of allTasks.value) assert.equal((await request(nativeOrigin, '/ScheduledTasks/' + task.Id + '/Triggers', { token: current.accessToken, method: 'POST', body: [] })).status, 204);
    await waitIdle(nativeOrigin);
    for (const [mode, policy] of Object.entries({ allowed: { EnableLiveTvAccess: true }, denied: { EnableLiveTvAccess: false }, admin: { IsAdministrator: true } })) {
      const password = randomUUID(); output.addSecret(password); const name = 'PublicLive_' + mode + '_' + randomUUID().slice(0, 8);
      const created = await request(nativeOrigin, '/Users/New', { token: current.accessToken, method: 'POST', body: { Name: name, Password: password } }); assert.equal(created.status, 200); users[mode] = created.value;
      assert.equal((await request(nativeOrigin, '/Users/' + created.value.Id + '/Policy', { token: current.accessToken, method: 'POST', body: { ...created.value.Policy, ...policy } })).status, 204);
      const login = await request(nativeOrigin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: name, Pw: password } }); assert.equal(login.status, 200);
      tokens[mode] = login.value.AccessToken; output.addSecret(tokens[mode]);
    }
    const appName = 'PublicLive ' + randomUUID();
    assert.equal((await request(nativeOrigin, '/Auth/Keys?app=' + encodeURIComponent(appName), { token: current.accessToken, method: 'POST' })).status, 204);
    const keys = await request(nativeOrigin, '/Auth/Keys', { token: current.accessToken }); tokens.apiKey = keys.value.Items.find(key => key.AppName === appName).AccessToken; output.addSecret(tokens.apiKey);
    const configured = await request(nativeOrigin, '/LiveTv/TunerHosts', { method: 'POST', body: { Type: 'm3u', Url: playlistFile, AllowStreamSharing: false,
      EnableStreamLooping: false, TunerCount: 0, UserAgent: 'PublicOriginal/1.0' } }); assert.equal(configured.status, 200); assert.equal(configured.value.AllowStreamSharing, false);
    const deadline = Date.now() + 90000;
    while (true) {
      await waitIdle(nativeOrigin); const channels = await request(nativeOrigin, '/LiveTv/Channels?enableImages=false&enableUserData=false'); assert.equal(channels.status, 200);
      if (channels.value.Items.length === 1) { channelId = channels.value.Items[0].Id; break; }
      assert.ok(Date.now() < deadline, 'Actual native Guide must create the configured channel.'); await sleep();
    }
    await stopNative('native-prepare'); report.initialTimers = (await timerBytes()).map(sha);
    const source = new SqliteDatabase(databaseFilename(referenceRoot), { readOnly: true, requireMigrationHistory: true });
    try {
      database = await createPostgresTestDatabase(null, 'public_live_http'); const state = await discoverInstanceState({ instanceRoot: referenceRoot });
      report.transfer = await transferDatabase(source, database, { instanceBinding: { serverId: current.preparation.nativeServerId, originIdentityDigest: state.identity.digest }, portableMountContract: portableMountContract(mediaRoot) });
    } finally { source.close(); }
    await database.close(); await startNative('native-observe'); const expected = await scenario({ name: 'native', origin: nativeOrigin, cachePath: path.join(referenceRoot, 'cache') }); await stopNative('native-observe');
    report.rows.native.afterShutdown = await sqliteSnapshot(referenceRoot);
    assert.deepEqual(canonicalRows(report.rows.native.afterShutdown), canonicalRows(report.rows.native.after));
    const storageFile = path.join(root, 'storage.json'); await writeFile(storageFile, JSON.stringify(storageDocument(mediaRoot)));
    application = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: referenceRoot, MEDIAMANAGER_STORAGE: storageFile,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName, MEDIAMANAGER_PORT: '0' },
    onError: error => report.diagnostics.push({ name: error.name, message: error.message, status: error.status, stack: error.stack }) });
    const closeStore = application.store.close.bind(application.store);
    application.store.close = async () => { report.rows.node.afterShutdown = await application.store.run(snapshot); return closeStore(); };
    const actual = await scenario({ name: 'node', origin: 'http://127.0.0.1:' + application.server.address().port, cachePath: path.join(referenceRoot, 'data/cache') });
    assert.deepEqual(canonicalRows(report.rows.node.before), canonicalRows(report.rows.native.before), 'Both public sequences use the same stopped transferred rows.');
    assert.equal(actual.length, expected.length);
    const canonical = (response, candidate = false) => {
      const value = structuredClone(Object.hasOwn(response, 'value') ? response.value : response.text);
      if (value && typeof value === 'object') {
        if (Object.hasOwn(value, 'traceId')) { assert.ok(value.traceId); value.traceId = '$validated-trace'; }
        if (Object.hasOwn(value, 'PlaySessionId')) { assert.match(value.PlaySessionId, /^[a-f0-9]{32}$/u); value.PlaySessionId = '$validated-play-session'; }
        for (const source of [...(value.MediaSources ?? []), ...(value.MediaSource ? [value.MediaSource] : [])]) {
          assert.equal(typeof source.SupportsTranscoding, 'boolean');
          if (candidate) assert.equal(source.SupportsTranscoding, false, 'Public original sources cannot advertise encoding capability.');
          source.SupportsTranscoding = false;
        }
      }
      return { status: response.status, contentType: response.contentType, value };
    };
    for (const [index, candidate] of actual.entries()) {
      const counterpart = expected[index]; report.cases.push({ name: candidate.name, actual: candidate, expected: counterpart });
      assert.equal(candidate.name, counterpart.name); assert.deepEqual(canonical(candidate.response, true), canonical(counterpart.response), candidate.name);
    }
    const files = report.cacheFiles.map(({ name, filename }) => ({ name, filename })), file = path.join(root, 'cache-input.json'); await writeFile(file, JSON.stringify({ files }));
    const receipt = await recordOracle({ project: 'tests/playback/fixtures/live-streams-http/Oracle.csproj', output: path.join(root, 'cache-reader'), args: [file, '{output}/native.json'] });
    assert.equal(receipt.passed, true); const readerBytes = await readFile(path.join(root, 'cache-reader/native.json')), typed = parseLosslessJson(readerBytes.toString());
    assert.equal(typed.actualTypedMediaInfoReader, true); assert.equal(typed.inputSha256, sha(await readFile(file))); report.cacheReader = typed;
    for (const assembly of typed.assemblies) assert.equal(sha(await readFile(assembly.filename)), assembly.sha256);
    assert.deepEqual(typed.values.map(value => value.name), report.cacheFiles.map(value => value.name));
    for (const value of typed.values) {
      assert.equal(value.error, undefined); assert.ok(value.value && typeof value.value === 'object');
      assert.equal(value.sha256, report.cacheFiles.find(file => file.name === value.name).sha256);
    }
    for (const kind of ['original', 'blank']) assert.deepEqual(typed.values.find(value => value.name === 'node/' + kind).value,
      typed.values.find(value => value.name === 'native/' + kind).value, 'Actual native typed cache values must match: ' + kind);
    for (const entry of report.cacheFiles) {
      const bytes = Buffer.from(entry.base64, 'base64'); assert.equal(sha(bytes), entry.sha256);
      assert.deepEqual(parseLosslessJson(stringifyNativeJson(readLiveMediaInfoCache(bytes))), typed.values.find(value => value.name === entry.name).value);
    }
    assert.ok(report.upstream.some(value => value.engine === 'native' && value.method === 'GET')); assert.ok(report.upstream.some(value => value.engine === 'node' && value.method === 'GET'));
    assert.ok(report.upstream.every(value => value.route === '/original.wav' && value.userAgent === 'PublicOriginal/1.0'));
    report.originalBytes = { length: fixtureBytes.length, sha256: sha(fixtureBytes), generator: 'handwritten PCM WAV, no media generation process' };
    assert.deepEqual(await readFile(playlistFile), playlistBytes); report.playlist = { length: playlistBytes.length, sha256: sha(playlistBytes), sourceBytesUnchanged: true };
    const nodePort = application.server.address().port; await application.close(); application = undefined; assert.equal(await portAvailable(nodePort), true);
    assert.deepEqual(canonicalRows(report.rows.node.afterShutdown), canonicalRows(report.rows.node.after));
    assert.deepEqual(report.diagnostics.filter(value => !value.expectedRequest), [], 'Unknown provider/probe/close/background errors are never ignored.');
    report.cleanup.push({ productionRuntimeClosed: true, listenerReleased: true });
  } catch (error) { failure = error; report.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    for (const [name, operation] of [['native', () => stopNative('native-finally')], ['production', () => application?.close()], ['postgres', () => dropPostgresTestDatabase(database)],
      ['protected-inputs', () => current?.finish()], ['source-server', async () => { if (sourceServer) { sourceServer.closeAllConnections(); await new Promise(resolve => sourceServer.close(resolve)); } }]]) {
      try { await operation(); report.cleanup.push({ name, closed: true }); } catch (error) { failure ??= error; report.cleanup.push({ name, error: error.stack }); }
    }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.boundary = 'Actual current native HTTP/controller/auth/binder/DefaultLiveTvService and reservation-only M3U, actual ffprobe HTTP, stopped SQLite transfer to production PostgreSQL and actual typed cache consumers. Native SharedHttpStream/file copy/recording/encoding never execute. Positive retained raw transport and SessionManager component evidence are separate.';
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report)); await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
