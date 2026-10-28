import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeGuid } from '../../src/users/native.js';
import { sourceUriPath } from '../../src/storage/uri.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { acquireTestResource } from '../helpers/test-resource-lease.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { createSubtitleHttpSource } from '../playback/http-subtitle-source.js';
import { hash, databaseFilename, proxyTarget, inputSha256, unusedPort, portAvailable, checkpoint,
  bytesAt, resetMedia, responseValue } from './fixtures/lyrics-management/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && postgresTestConnectionString;
const idKey = value => value.replaceAll('-', '').toLowerCase();

test('Lyrics management uses actual Native refresh and Node Local/PG writes, metadata overrides, delete prefixes and cold reads', {
  skip: !enabled, timeout: 720000,
}, async t => {
  const destination = path.join(validationOutputRoot(), 'lyrics-management-' + randomUUID()), output = await createPrivateFilterOutput(destination);
  output.addSecret(postgresTestConnectionString); await mkdir(output.root); const root = await realpath(output.root),
    instanceRoot = path.join(root, 'instance'), baselineRoot = path.join(root, 'baseline'), mediaRoot = path.join(root, 'audio'),
    storageFile = path.join(root, 'storage.json'), nativePort = await unusedPort(), nativeOrigin = 'http://127.0.0.1:' + nativePort;
  const report = { scope: { actualNativeHostHttpMetadata: true, actualNodeRuntimeHttpMetadata: true, actualPostgres: true,
    actualLocalVfs: true, actualHttpMediaStorage: true, originalAudioReadOnly: true, noRemoteLyricProviders: true, noGeneratedMedia: true,
    excluded: ['remote-provider behavior', 'immediate POST-to-DELETE concurrency equivalence', 'full library/release acceptance'] }, inputSha256, requests: [], pairs: [],
    overrides: [], states: [], diagnostics: [], cleanup: [], differences: [], releaseAcceptance: false };
  const secrets = new Set([postgresTestConnectionString]), tokens = {}, sourceSamples = new Map();
  let current, native, runtime, database, source, lease, failure, origin, libraryId, ids, metadataPath, nativePaths, sqlite;
  const request = async (route, { method = 'GET', body, bytes, identity = 'admin', authorization, accept = 'application/json', headers = {} } = {}) => {
    const token = identity === 'anonymous' ? null : tokens[identity], response = await fetch(origin + route, { method,
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(60000)]),
      headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : token ? { Authorization: `MediaBrowser Token="${token}"` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : bytes !== undefined ? { 'Content-Type': 'text/plain' } : {}), ...headers },
      ...(body === undefined ? bytes === undefined ? {} : { body: bytes } : { body: JSON.stringify(body) }) });
    const result = { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
    report.requests.push({ origin, route, method, identity, ...(bytes === undefined ? {} : { inputBytes: bytes.length, inputSha256: hash(bytes) }), result }); return result;
  };
  const json = response => parseLosslessJson(response.body);
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST' })).status, () => portAvailable(nativePort));
    report.cleanup.push({ label, ...result }); if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable);
  };
  const stopNode = async label => {
    if (!runtime) return; const owned = runtime; runtime = undefined;
    const listeners = owned.networkHost.listeners; await owned.close(); assert.ok(listeners.every(value => !value.server.listening)); report.cleanup.push({ label, closed: true });
  };
  const startNative = async label => { origin = nativeOrigin; native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label, origin }); await native.ready(); };
  const startNode = async () => {
    runtime = await createTestRuntime({ database, ...await readInstanceConfiguration(instanceRoot), storageConfiguration: storageFile,
      mediaEncoderOptions: { startupFFmpegPath: current.ffmpeg }, onError: (error, context) => report.diagnostics.push({ route: context?.request?.url,
        message: error?.message, code: error?.code, status: error?.status }) });
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
  };
  const addSource = filename => { sourceSamples.set(filename, { filename, definition: { name: filename, sourceTarget: proxyTarget(filename) }, source: { extension: path.extname(filename) } }); };
  const lyricPath = (which, format, internal = false) => internal
    ? path.join(metadataPath, 'library', ids[which].slice(0, 2), ids[which], which + '.' + format) : path.join(mediaRoot, which + '.' + format);
  const waitLyrics = async (which, expected) => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const response = await request('/Audio/' + ids[which] + '/Lyrics');
      if (response.status === expected) return response;
      assert.ok(Date.now() < deadline, 'The real metadata owner must publish the new lyric state.'); await delay(50);
    }
  };
  const updateOptions = async save => {
    const folders = json(await request('/Library/VirtualFolders')), selected = folders.find(folder => idKey(folder.ItemId) === libraryId);
    assert.ok(selected); assert.equal((await request('/Library/VirtualFolders/LibraryOptions', { method: 'POST',
      body: { Id: selected.ItemId, LibraryOptions: { ...selected.LibraryOptions, SaveLyricsWithMedia: save } } })).status, 204);
  };
  const state = async (label, which, timing, record = true) => {
    const owner = label === 'Native' ? new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true }) : database;
    try {
      const value = { label, timing, item: await owner.rows('BaseItems', { where: { Id: nativeGuid(ids[which]) } }),
        streams: await owner.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(ids[which]) }, orderBy: [{ column: 'StreamIndex', direction: 'ASC' }] }),
        media: await bytesAt(lyricPath(which, 'lrc')), internal: await bytesAt(lyricPath(which, 'lrc', true)) };
      if (record) report.states.push(value); return value;
    } finally { if (label === 'Native') owner.close(); }
  };
  const waitMetadataPublication = async (label, which, filename, bytes) => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const value = await state(label, which, 'upload metadata published', false), data = parseLosslessJson(value.item[0].Data),
        expand = label === 'Native' ? createVirtualPathExpander(nativePaths) : runtime.library.options.expandPath,
        published = data.HasLyrics === true && data.LyricFiles?.includes(filename)
          && value.streams.some(stream => stream.StreamType === 5 && (expand?.(stream.Path) ?? stream.Path) === filename);
      if (published) {
        assert.equal((await bytesAt(filename)).sha256, hash(bytes)); report.states.push(value); return;
      }
      if (Date.now() >= deadline) { report.states.push(value); assert.fail('The actual upload metadata must publish HasLyrics, LyricFiles and its corresponding stored stream before a steady-state consumer.'); }
      await delay(50, undefined, { signal: t.signal });
    }
  };
  const phase = async label => {
    const values = [], upload = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('[00:01.25] First line\n[00:02.50] Second line\n')]);
    const record = async (name, route, options, status) => {
      const response = await request(route, options); if (status !== undefined) assert.equal(response.status, status, label + ': ' + name);
      values.push({ name, response: responseValue(response) }); return response;
    };
    for (const [name, suffix, options, status] of [
      ['denied manager', '?fileName=denied.lrc', { identity: 'denied', bytes: upload }, 403],
      ['missing filename', '', { bytes: upload }, 400], ['missing extension', '?fileName=no-extension', { bytes: upload }, 400],
      ['empty upload', '?fileName=empty.lrc', { bytes: Buffer.alloc(0) }, 400],
      ['unsupported format', '?fileName=x.srt', { bytes: upload }, 400],
    ]) await record(name, '/Audio/' + ids.alpha + '/Lyrics' + suffix, { method: 'POST', ...options }, status);
    await updateOptions(true);
    await record('permitted regular upload uses persisted lyric permission', '/Audio/' + ids.alpha + '/Lyrics?fileName=ignored-name.LRC',
      { method: 'POST', identity: 'manager', bytes: upload }, 200);
    const first = await waitLyrics('alpha', 200); values.push({ name: 'metadata discovers original uploaded bytes', response: responseValue(first),
      media: await bytesAt(lyricPath('alpha', 'lrc')), internal: await bytesAt(lyricPath('alpha', 'lrc', true)) });
    assert.equal(values.at(-1).media.sha256, hash(upload)); assert.equal(values.at(-1).internal.exists, false);
    await state(label, 'alpha', 'upload first became publicly readable');
    await waitMetadataPublication(label, 'alpha', lyricPath('alpha', 'lrc'), upload);
    await state(label, 'alpha', 'before first delete');
    await record('delete waits for real refresh', '/Audio/' + ids.alpha + '/Lyrics', { method: 'DELETE', identity: 'manager' }, 204);
    await state(label, 'alpha', 'after first delete');
    // Observe the actual owner result; do not prescribe 404 or project a 500
    // away. Native persistence and a cold host distinguish cache from state.
    await record('actual immediate read after delete', '/Audio/' + ids.alpha + '/Lyrics', {});
    if (label === 'Native') { await stopNative('native-after-delete-warm'); await startNative('native-after-delete-cold'); }
    else { const schema = database.schemaName; await stopNode('node-after-delete-warm');
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await startNode(); }
    await record('actual cold read after delete', '/Audio/' + ids.alpha + '/Lyrics', {});
    await state(label, 'alpha', 'cold after first delete');
    assert.equal((await bytesAt(lyricPath('alpha', 'lrc'))).exists, false);
    await mkdir(lyricPath('alpha', 'lrc')); // Real file-open failure, not a mocked writer.
    await record('media write failure falls back internally', '/Audio/' + ids.alpha + '/Lyrics?fileName=x.lrc', { method: 'POST', bytes: upload }, 200);
    await rmdir(lyricPath('alpha', 'lrc')); const fallback = await waitLyrics('alpha', 200);
    values.push({ name: 'internal fallback bytes are consumed after refresh', response: responseValue(fallback), internal: await bytesAt(lyricPath('alpha', 'lrc', true)) });
    assert.equal(values.at(-1).internal.sha256, hash(upload));
    await waitMetadataPublication(label, 'alpha', lyricPath('alpha', 'lrc', true), upload);
    await record('delete internal stream', '/Audio/' + ids.alpha + '/Lyrics', { method: 'DELETE' }, 204);
    await record('actual read after internal deletion', '/Audio/' + ids.alpha + '/Lyrics', {});
    await state(label, 'alpha', 'after internal delete');
    for (const [name, route, method] of [
      ['default provider search', '/Audio/' + ids.alpha + '/RemoteSearch/Lyrics', 'GET'],
      ['unknown provider read', '/Providers/Lyrics/no-provider_opaque', 'GET'],
      ['unknown provider download', '/Audio/' + ids.alpha + '/RemoteSearch/Lyrics/no-provider_opaque', 'POST'],
    ]) await record(name, route, { method }, name === 'default provider search' ? 200 : 404);
    await updateOptions(false);
    await record('internal-only upload', '/Audio/' + ids.beta + '/Lyrics?fileName=x.txt', { method: 'POST', bytes: Buffer.from(' Last text \r\n\r\n') }, 200);
    const final = await waitLyrics('beta', 200); values.push({ name: 'final internal plain text persists', response: responseValue(final), internal: await bytesAt(lyricPath('beta', 'txt', true)) });
    await waitMetadataPublication(label, 'beta', lyricPath('beta', 'txt', true), Buffer.from(' Last text \r\n\r\n'));
    for (const which of ['alpha', 'beta']) assert.equal(hash(await readFile(path.join(mediaRoot, which + '.flac'))), inputSha256);
    return values;
  };
  try {
    current = await currentNativeReference(); tokens.admin = current.accessToken; output.addSecret(tokens.admin); secrets.add(tokens.admin);
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LyricsController.cs', 'MediaBrowser.Providers/Lyric/LyricManager.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Providers/MediaInfo/LyricResolver.cs',
      'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs', 'Emby.Server.Implementations/AppBase/BaseApplicationPaths.cs',
      'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs', 'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs']);
    lease = await acquireTestResource('native-media-5244', { signal: t.signal });
    await cp(current.sourceRoot, instanceRoot, { recursive: true, errorOnExist: true, force: false }); await current.prepareClone(instanceRoot, nativePort);
    await resetMedia(mediaRoot); for (const name of ['alpha', 'beta']) addSource(path.join(mediaRoot, name + '.flac'));
    source = createSubtitleHttpSource(sourceSamples); await source.start(); await startNative('native-prepare');
    const tasks = json(await request('/ScheduledTasks'));
    for (const task of tasks) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    for (const [identity, enabled] of [['manager', true], ['denied', false]]) {
      const name = 'Lyrics ' + identity, password = randomUUID(); secrets.add(password); output.addSecret(password);
      const created = json(await request('/Users/New', { method: 'POST', body: { Name: name, Password: password } }));
      const selected = json(await request('/Users/' + created.Id));
      assert.equal((await request('/Users/' + created.Id + '/Policy', { method: 'POST', body: { ...selected.Policy,
        IsAdministrator: false, EnableAllFolders: true, EnableLyricManagement: enabled } })).status, 204);
      const login = json(await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: name, Pw: password }, identity: 'anonymous',
        authorization: `MediaBrowser Client="Lyrics management", Device="Private", DeviceId="lyrics-${identity}", Version="1"` }));
      tokens[identity] = login.AccessToken; secrets.add(login.AccessToken); output.addSecret(login.AccessToken);
    }
    assert.equal((await request('/Library/VirtualFolders?name=Lyrics%20management&collectionType=music&refreshLibrary=false', { method: 'POST',
      body: { LibraryOptions: { Enabled: true, EnableInternetProviders: false, EnableRealtimeMonitor: false, SaveLyricsWithMedia: true,
        SaveLocalMetadata: false, MetadataSavers: [], EnableLUFSScan: false, PathInfos: [{ Path: mediaRoot }],
        TypeOptions: ['Audio', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] })) } } })).status, 204);
    const folders = json(await request('/Library/VirtualFolders')), library = folders.find(folder => folder.Name === 'Lyrics management');
    assert.ok(library); libraryId = idKey(library.ItemId); report.library = library;
    const scan = json(await request('/ScheduledTasks')).find(task => task.Key === 'RefreshLibrary');
    assert.ok(scan); assert.equal((await request('/ScheduledTasks/Running/' + scan.Id, { method: 'POST' })).status, 204);
    const deadline = Date.now() + 120000;
    for (;;) {
      const state = json(await request('/ScheduledTasks/' + scan.Id));
      if (state.State === 'Idle' && state.LastExecutionResult?.StartTimeUtc !== scan.LastExecutionResult?.StartTimeUtc) {
        assert.equal(state.LastExecutionResult.Status, 'Completed'); break;
      }
      assert.ok(Date.now() < deadline, 'The actual original-audio library scan must finish.'); await delay(100);
    }
    const audio = json(await request('/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path')).Items;
    ids = Object.fromEntries(['alpha', 'beta'].map(name => { const item = audio.find(value => value.Path === path.join(mediaRoot, name + '.flac')); assert.ok(item); return [name, idKey(item.Id)]; }));
    const system = json(await request('/System/Info'));
    metadataPath = system.InternalMetadataPath; report.identities = ids; report.metadataPath = metadataPath;
    nativePaths = { programDataPath: system.ProgramDataPath, dataPath: path.join(system.ProgramDataPath, 'data'), metadataPath };
    report.nativePaths = nativePaths;
    for (const which of ['alpha', 'beta']) for (const format of ['lrc', 'txt']) for (const internal of [false, true]) addSource(lyricPath(which, format, internal));
    await stopNative('native-prepared'); checkpoint(instanceRoot); await cp(instanceRoot, baselineRoot, { recursive: true, force: false, errorOnExist: true });
    await startNative('native-management'); const nativeValues = await phase('Native'); await stopNative('native-management');
    assert.equal(path.dirname(instanceRoot), root); await rm(instanceRoot, { recursive: true }); await cp(baselineRoot, instanceRoot, { recursive: true }); await resetMedia(mediaRoot);
    database = await createPostgresTestDatabase(null, 'lyrics_management');
    sqlite = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    report.import = await transferDatabase(sqlite, database, { instanceBinding: { serverId: current.preparation.nativeServerId,
      originIdentityDigest: hash(await readFile(databaseFilename(instanceRoot))) } }); sqlite.close(); sqlite = undefined;
    const style = process.platform === 'win32' ? 'windows' : 'posix';
    await writeFile(storageFile, JSON.stringify({ instances: [{ id: 'private', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/lyrics', instanceId: 'private', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: root, accessRoot: '/lyrics', style, caseSensitive: style === 'posix', returnAccess: 'Retain isolated original media and instance paths for the paired lyric consumer.' }] }));
    await startNode(); const nodeValues = await phase('Node'); report.pairs = nativeValues.map((value, index) => ({ native: value, node: nodeValues[index] }));
    assert.deepEqual(nodeValues, nativeValues);
    const httpMedia = runtime.storage.configuration(), originalHttpUri = source.origin + proxyTarget(path.join(mediaRoot, 'alpha.flac'));
    httpMedia.instances.push({ id: 'lyrics-original-http', type: 'http', config: {} });
    httpMedia.mounts.push({ path: '/lyrics-original-http', instanceId: 'lyrics-original-http', root: '/', capabilities: {} });
    httpMedia.prefixes.push({ identityRoot: source.origin, accessRoot: '/lyrics-original-http', style: 'uri', caseSensitive: true,
      purpose: 'library', returnAccess: 'Read the same original audio over the owned HTTP source; preserve its persistent identity Path.' });
    httpMedia.bindings = [...(httpMedia.bindings ?? []).filter(binding => idKey(binding.itemId) !== ids.alpha),
      { itemId: ids.alpha, accessPath: '/lyrics-original-http' + sourceUriPath(originalHttpUri) }];
    const httpReceiptStart = source.receipts.length;
    await runtime.storage.configure(httpMedia);
    await updateOptions(true);
    // A body-specific item binding must not move metadata directory discovery
    // out of its ordinary Local prefix when no metadata override is declared.
    const defaultLyric = Buffer.from('[00:04.56] DEFAULT LOCAL METADATA');
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics?fileName=default.lrc', { method: 'POST', bytes: defaultLyric })).status, 200);
    const defaultRead = await waitLyrics('alpha', 200);
    await runtime.metadata.drain();
    assert.deepEqual(json(defaultRead).Lyrics, [{ Text: 'DEFAULT LOCAL METADATA', Start: 45600000, Cues: [] }]);
    await waitMetadataPublication('Node', 'alpha', lyricPath('alpha', 'lrc'), defaultLyric);
    const defaultState = await state('Node', 'alpha', 'HTTP body with default Local metadata'),
      defaultHttpReads = source.receipts.slice(httpReceiptStart).filter(receipt => receipt.target === proxyTarget(path.join(mediaRoot, 'alpha.flac')));
    assert.ok(defaultHttpReads.length > 0, 'The original audio must actually be probed through its HTTP item binding.');
    assert.equal(defaultState.item[0].Path, path.join(mediaRoot, 'alpha.flac'));
    report.overrides.push({ operation: 'HTTP body and default Local metadata', read: responseValue(defaultRead), state: defaultState, originalHttpReads: defaultHttpReads });
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics', { method: 'DELETE' })).status, 204);
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics')).status, 404);
    assert.equal((await bytesAt(lyricPath('alpha', 'lrc'))).exists, false);

    const overrides = path.join(root, 'metadata-override'); await mkdir(overrides);
    const definition = runtime.storage.configuration(); definition.instances.push({ id: 'lyrics-metadata', type: 'local', config: { root: overrides, writable: true } });
    await runtime.storage.configure(definition);
    await runtime.storage.bindPath({ identityRoot: mediaRoot, instanceId: 'lyrics-metadata', purpose: 'metadata', style,
      caseSensitive: style === 'posix', capabilities: { create: true, replace: true, mkdir: true, delete: true },
      returnAccess: 'Lyric metadata sidecars are independent of original audio bytes.' });
    const independentReceiptStart = source.receipts.length;
    const decoy = Buffer.from('[00:00.00] MEDIA DECOY'), real = Buffer.from('[00:03.45] METADATA OWNER');
    await writeFile(path.join(mediaRoot, 'alpha.lrc'), decoy);
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics?fileName=metadata.lrc', { method: 'POST', bytes: real })).status, 200);
    const overridden = await waitLyrics('alpha', 200);
    await runtime.metadata.drain();
    assert.deepEqual(json(overridden).Lyrics, [{ Text: 'METADATA OWNER', Start: 34500000, Cues: [] }]);
    assert.equal(hash(await readFile(path.join(overrides, 'alpha.lrc'))), hash(real)); assert.equal(hash(await readFile(path.join(mediaRoot, 'alpha.lrc'))), hash(decoy));
    const stored = await database.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(ids.alpha) }, columns: ['Path', 'StreamType'] });
    assert.ok(stored.some(row => row.StreamType === 5 && row.Path === path.join(mediaRoot, 'alpha.lrc')));
    const [published] = await database.rows('BaseItems', { where: { Id: nativeGuid(ids.alpha) }, columns: ['Path', 'Data'] });
    assert.equal(published.Path, path.join(mediaRoot, 'alpha.flac'));
    assert.equal(parseLosslessJson(published.Data).HasLyrics, true);
    const originalHttpReads = source.receipts.slice(independentReceiptStart).filter(receipt => receipt.target === proxyTarget(path.join(mediaRoot, 'alpha.flac')));
    assert.ok(originalHttpReads.length > 0, 'Actual metadata refresh must inspect the original audio through the HTTP storage owner.');
    report.overrides.push({ read: responseValue(overridden), metadata: await bytesAt(path.join(overrides, 'alpha.lrc')), media: await bytesAt(path.join(mediaRoot, 'alpha.lrc')), stored,
      originalAudioHttpUri: originalHttpUri, published, originalHttpReads });
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics', { method: 'DELETE' })).status, 204);
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics')).status, 404);
    assert.equal((await bytesAt(path.join(overrides, 'alpha.lrc'))).exists, false); assert.equal(hash(await readFile(path.join(mediaRoot, 'alpha.lrc'))), hash(decoy));
    assert.ok(!(await database.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(ids.alpha) } })).some(row => row.StreamType === 5));
    assert.equal(parseLosslessJson((await database.rows('BaseItems', { where: { Id: nativeGuid(ids.alpha) }, columns: ['Data'] }))[0].Data).HasLyrics, false);
    const schema = database.schemaName; await stopNode('node-management');
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await startNode();
    assert.equal((await request('/Audio/' + ids.alpha + '/Lyrics')).status, 404); assert.equal((await request('/Audio/' + ids.beta + '/Lyrics')).status, 200);
    for (const which of ['alpha', 'beta']) assert.equal(hash(await readFile(path.join(mediaRoot, which + '.flac'))), inputSha256);
    report.passed = true;
  } catch (error) { failure = error; report.failure = { name: error?.name, message: error?.message, stack: error?.stack }; }
  for (const [label, close] of [['native', () => stopNative('native-finally')], ['node', () => stopNode('node-finally')], ['sqlite', () => sqlite?.close()],
    ['postgres', () => dropPostgresTestDatabase(database)], ['source', async () => { await source?.stop(); report.sourceRequests = source?.receipts; }],
    ['5244-lease', () => lease?.release()], ['reference', () => current?.finish()]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); } catch (error) { failure ??= error; report.cleanup.push({ label, message: error?.message }); }
  }
  await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
  await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ nativeInput: current?.preparation, sourceBindings: report.sourceBindings,
    originalAudioSha256: inputSha256, actualNativeHttp: true, actualPostgresHttp: true, releaseAcceptance: false }, secrets));
  if (!native && !runtime) await output.publishAndClose();
  if (failure) throw output.publicError(failure);
});
