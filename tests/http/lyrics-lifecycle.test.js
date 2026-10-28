import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { MIN_DATE } from '../../src/library/records.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { lyricProviderSource } from './fixtures/lyrics-providers-current/source.js';
import { hash, inputAsset, inputSha256, bytesAt } from './fixtures/lyrics-management/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && postgresTestConnectionString;

test('lyric deletion preserves an actually deleted prefix and shutdown drains an admitted refresh before cold recovery', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'lyrics-lifecycle-' + randomUUID()));
  await mkdir(output.root);
  const root = output.root, programDataPath = path.join(root, 'program'), mediaRoot = path.join(root, 'audio'),
    metadataSidecars = path.join(root, 'metadata-sidecars'), storageConfiguration = path.join(root, 'storage.json'),
    mediaPath = path.join(mediaRoot, 'sound.flac'), itemId = 'fa6e2000000000000000000000000001',
    cleanupEntered = Promise.withResolvers(), releaseCleanup = Promise.withResolvers(),
    report = { scope: { actualNodeHttpPostgresLocal: true, actualProbeDiscovery: true, actualIndependentMetadataMount: true,
      actualInstalledMetadataPlugin: true, actualUpstreamHttpCancellation: true,
      controlled: ['A second valid persisted lyric descriptor solely for delete-prefix failure injection', 'Metadata plugin waits after actual upstream cleanup'],
      excluded: ['Native fault injection equivalence', 'full release acceptance'] }, observations: [], cleanup: [] };
  const secrets = new Set([postgresTestConnectionString]); output.addSecret(postgresTestConnectionString);
  let current, database, runtime, source, token, closing, metadataRoot = path.join(programDataPath, 'metadata'), failed = false, primary;
  const wait = async (operation, message) => {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(90000)]), aborted = Promise.withResolvers(),
      abort = () => aborted.reject(new Error(message, { cause: signal.reason }));
    signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([operation, aborted.promise]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  const start = async () => {
    runtime = await createTestRuntime({ database, serverId: 'fa6e2000000000000000000000000099', programDataPath,
      configurationDirectoryPath: path.join(root, 'config'), storageConfiguration,
      configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', MetadataPath: metadataRoot }, mediaEncoderOptions: { startupFFmpegPath: current.ffmpeg },
      pluginOptions: { options: { 'lyric-refresh-fixture': { sourceUrl: source.url, cleanupEntered, cleanup: releaseCleanup.promise } } },
      onError: (error, context) => report.observations.push({ diagnosticOnly: true, route: context?.request?.url, message: error?.message, code: error?.code }) });
  };
  const stop = async () => {
    const owner = runtime; runtime = undefined; if (!owner) return;
    const listeners = owner.networkHost.listeners; await owner.close();
    assert.ok(listeners.every(value => !value.server.listening));
  };
  const request = async (method, route, bytes) => {
    const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
    const response = await fetch(origin + route, { method, headers: { Accept: 'application/json', Authorization: 'MediaBrowser Token="' + token + '"',
      ...(bytes ? { 'Content-Type': 'text/plain' } : {}) }, ...(bytes ? { body: bytes } : {}),
    signal: AbortSignal.any([t.signal, AbortSignal.timeout(90000)]) });
    return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
  };
  const streamRows = () => database.rows('MediaStreamInfos', { where: { ItemId: nativeGuid(itemId) },
    orderBy: [{ column: 'StreamIndex', direction: 'ASC' }] });
  try {
    current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LyricsController.cs',
      'MediaBrowser.Providers/Lyric/LyricManager.cs', 'MediaBrowser.Providers/MediaInfo/AudioFileProber.cs',
      'Jellyfin.Server.Implementations/Item/MediaStreamRepository.cs']);
    await mkdir(mediaRoot); await mkdir(metadataSidecars); await copyFile(inputAsset, mediaPath);
    const lyric = Buffer.from('[00:01.25] Original metadata-sidecar lyric\n');
    await writeFile(path.join(metadataSidecars, 'sound.lrc'), lyric);
    await writeFile(storageConfiguration, JSON.stringify({ instances: [{ id: 'private', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/lyrics', instanceId: 'private', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: root, accessRoot: '/lyrics', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'Owned actual original audio, instance state and lyric fixture paths.' }] }));
    source = await lyricProviderSource(Buffer.from('Original held metadata provider input.\n'));
    database = await createPostgresTestDatabase(null, 'lyric_lifecycle'); await start();
    const definition = runtime.storage.configuration(); definition.instances.push({ id: 'sidecars', type: 'local', config: { root: metadataSidecars, writable: true } });
    await runtime.storage.configure(definition);
    await runtime.storage.bindPath({ identityRoot: mediaRoot, instanceId: 'sidecars', purpose: 'metadata',
      style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
      capabilities: { create: true, replace: true, mkdir: true, delete: true }, returnAccess: 'Read/write lyric sidecars independently of the original audio body.' });
    const password = randomUUID(); secrets.add(password); output.addSecret(password);
    const created = await runtime.users.createUser({ Name: 'Lyrics lifecycle owner', Password: password });
    const original = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(created.Id, { ...original.Policy, IsAdministrator: true, EnableAllFolders: true, EnableLyricManagement: true });
    const login = await runtime.authentication.login({ Username: created.Name, Pw: password },
      { Client: 'Lyric lifecycle', Device: 'Private', DeviceId: 'lyric-lifecycle', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    token = login.AccessToken; secrets.add(token); output.addSecret(token);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: nativeGuid(itemId), Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
      Name: 'Original sound', CleanName: 'Original sound', SortName: 'Original sound', MediaType: 'Audio', Path: mediaPath,
      PresentationUniqueKey: itemId, Data: '{}', DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }));
    await runtime.metadata.refresh(itemId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    const initialStreams = await streamRows(), discovered = initialStreams.filter(row => row.StreamType === 5);
    assert.equal(discovered.length, 1); assert.equal(discovered[0].Path, path.join(mediaRoot, 'sound.lrc'));
    assert.equal((await request('GET', '/Audio/' + itemId + '/Lyrics')).status, 200);
    // The discovery above is real. This additional descriptor is an explicit
    // valid database input for the separate attempt-first/stop-on-error case.
    const directoryPath = path.join(metadataSidecars, 'sound.txt'); await mkdir(directoryPath);
    await database.insert('MediaStreamInfos', { ...discovered[0], StreamIndex: Math.max(...initialStreams.map(row => row.StreamIndex)) + 1,
      Path: path.join(mediaRoot, 'sound.txt') });
    const beforeDelete = await streamRows(), rejected = await request('DELETE', '/Audio/' + itemId + '/Lyrics');
    assert.equal(rejected.status, 500);
    assert.equal((await bytesAt(path.join(metadataSidecars, 'sound.lrc'))).exists, false);
    assert.equal((await bytesAt(directoryPath)).directory, true);
    assert.deepEqual(await streamRows(), beforeDelete, 'Failed deletion must not claim a refresh committed different descriptors.');
    assert.equal(hash(await readFile(mediaPath)), inputSha256);
    report.observations.push({ operation: 'delete committed prefix', beforeDelete, response: rejected,
      deleted: await bytesAt(path.join(metadataSidecars, 'sound.lrc')), failingTarget: await bytesAt(directoryPath), afterDelete: await streamRows() });
    await rmdir(directoryPath); await writeFile(path.join(metadataSidecars, 'sound.lrc'), lyric);
    assert.equal((await request('DELETE', '/Audio/' + itemId + '/Lyrics')).status, 204);
    assert.ok(!(await streamRows()).some(row => row.StreamType === 5));

    const packageRoot = path.join(root, 'refresh-package'); await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@test/lyric-refresh', version: '0.1.0', type: 'module',
      mediamanager: { id: 'lyric-refresh-fixture', name: 'Controlled lyric refresh boundary', entry: 'index.js' } }));
    await writeFile(path.join(packageRoot, 'index.js'), [
      "export async function activate(context){",
      " await context.register('metadata',{id:context.id,name:'Controlled lyric refresh boundary',providers:[{",
      "  id:'lyric-refresh-local',name:'Controlled lyric refresh boundary',kind:'local',itemTypes:['Audio'],",
      "  async getMetadata(_item,{signal}){",
      "   try{const response=await fetch(context.options.sourceUrl+'/refresh',{signal});await response.arrayBuffer();return {HasMetadata:false};}",
      "   finally{context.options.cleanupEntered.resolve();await context.options.cleanup;}",
      "  }",
      " }]});return {};",
      "}",
    ].join('\n'));
    assert.equal((await runtime.plugins.install(packageRoot)).status, 'active');
    const uploaded = Buffer.from('[00:06.78] Uploaded before shutdown\n'), internal = path.join(programDataPath, 'metadata', 'library', itemId.slice(0, 2), itemId, 'sound.lrc'),
      upload = await request('POST', '/Audio/' + itemId + '/Lyrics?fileName=source.lrc', uploaded);
    assert.equal(upload.status, 200);
    await wait(source.gate('refresh').entered.promise, 'The admitted lyric upload must reach its actual queued metadata provider.');
    const owner = runtime, schema = database.schemaName; runtime = undefined;
    let firstDone = false, secondDone = false;
    const first = owner.close().then(() => { firstDone = true; }, error => { firstDone = true; throw error; }),
      second = owner.close().then(() => { secondDone = true; }, error => { secondDone = true; throw error; });
    closing = Promise.allSettled([first, second]);
    const upstream = await wait(source.gate('refresh').closed.promise, 'Runtime shutdown must close the actual upstream response.');
    await wait(cleanupEntered.promise, 'The cancelled metadata provider must enter actual resource cleanup.');
    assert.equal(upstream.completed, false); assert.equal(firstDone, false); assert.equal(secondDone, false);
    assert.equal(hash(await readFile(internal)), hash(uploaded));
    releaseCleanup.resolve();
    const results = await wait(closing, 'Runtime shutdown must drain the admitted metadata provider after its resource cleanup.');
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Both runtime shutdown consumers rejected.', { cause: errors[0] });
    await assert.rejects(() => database.rows('BaseItems'), 'The actual database owner must be closed after its refresh drains.');
    report.observations.push({ operation: 'shutdown drained admitted refresh', upload, upstream, saved: await bytesAt(internal) });
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await start();
    await runtime.plugins.setEnabled('lyric-refresh-fixture', false);
    await runtime.metadata.refresh(itemId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    const recovered = await request('GET', '/Audio/' + itemId + '/Lyrics');
    assert.equal(recovered.status, 200); assert.equal(parseLosslessJson(recovered.body).Lyrics[0].Text, 'Uploaded before shutdown');
    const stored = await streamRows(), macro = path.join('%MetadataPath%', 'library', itemId.slice(0, 2), itemId, 'sound.lrc');
    assert.equal(stored.find(row => row.StreamType === 5).Path, macro, 'The actual PG cell retains Native instance-relative stream storage.');
    const itemBody = parseLosslessJson((await request('GET', '/Items/' + itemId + '?Fields=MediaStreams')).body);
    assert.equal(itemBody.MediaStreams.find(stream => stream.Type === 'Lyric').Path, internal);
    assert.equal(hash(await readFile(mediaPath)), inputSha256);
    report.observations.push({ operation: 'cold recovery discovers committed upload', response: recovered, streams: stored, dto: itemBody, saved: await bytesAt(internal) });

    const relocatedRoot = path.join(root, 'relocated-metadata'), relocated = path.join(relocatedRoot, 'library', itemId.slice(0, 2), itemId, 'sound.lrc');
    await mkdir(path.dirname(relocated), { recursive: true }); await copyFile(internal, relocated); await rm(internal);
    await runtime.configurationStore.replaceConfiguration({ ...runtime.configuration, MetadataPath: relocatedRoot });
    metadataRoot = relocatedRoot;
    assert.equal((await bytesAt(internal)).exists, false);
    const relocatedRead = await request('GET', '/Audio/' + itemId + '/Lyrics'),
      relocatedDto = parseLosslessJson((await request('GET', '/Items/' + itemId + '?Fields=MediaStreams')).body);
    assert.equal(relocatedRead.status, 200); assert.deepEqual(parseLosslessJson(relocatedRead.body), parseLosslessJson(recovered.body));
    assert.equal(relocatedDto.MediaStreams.find(stream => stream.Type === 'Lyric').Path, relocated);
    assert.deepEqual(await streamRows(), stored, 'Changing the instance metadata root restores the same stored macros without rewriting stream rows.');
    await stop(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await start();
    const relocatedCold = await request('GET', '/Audio/' + itemId + '/Lyrics');
    assert.equal(relocatedCold.status, 200); assert.deepEqual(parseLosslessJson(relocatedCold.body), parseLosslessJson(recovered.body));
    assert.equal(hash(await readFile(relocated)), hash(uploaded)); assert.equal(hash(await readFile(mediaPath)), inputSha256);
    report.observations.push({ operation: 'actual metadata root change and cold stream read', before: stored, after: await streamRows(),
      oldFile: await bytesAt(internal), newFile: await bytesAt(relocated), response: relocatedRead, dto: relocatedDto, cold: relocatedCold });
    report.passed = true;
  } catch (error) { failed = true; primary = error; report.failure = { name: error?.name, message: error?.message, stack: error?.stack }; }
  releaseCleanup.resolve();
  const failures = [];
  for (const [label, close] of [['runtime', stop], ['admitted shutdown', () => closing], ['postgres', () => dropPostgresTestDatabase(database)],
    ['source', () => source?.close()], ['reference', () => current?.finish()]]) {
    try { await close(); report.cleanup.push({ label, closed: true }); }
    catch (error) { failures.push(error); report.cleanup.push({ label, closed: false, message: error?.message }); }
  }
  await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
  if (!runtime) await output.publishAndClose();
  const errors = [...(failed ? [primary] : []), ...failures];
  if (errors.length === 1) throw output.publicError(errors[0]);
  if (errors.length > 1) throw output.publicError(new AggregateError(errors, 'Lyric lifecycle validation and cleanup failed.', { cause: errors[0] }));
});
