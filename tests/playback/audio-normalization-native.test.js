import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { audioNormalizationTaskId } from '../../src/tasks/audio-normalization-task.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { extractionFixture } from './extraction-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function wave(amplitude, frequency) {
  const samples = 48000 * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(amplitude * Math.sin(index * 2 * Math.PI * frequency / 48000)), 44 + index * 2);
  return bytes;
}

async function runTask(request, task) {
  const before = await request('/ScheduledTasks/' + task);
  await request('/ScheduledTasks/Running/' + task, { method: 'POST' }, 204);
  const until = Date.now() + 90000;
  for (;;) {
    const state = await request('/ScheduledTasks/' + task);
    if (state.State === 'Idle' && state.LastExecutionResult && state.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
      assert.equal(state.LastExecutionResult.Status, 'Completed', JSON.stringify(state.LastExecutionResult));
      return state;
    }
    assert.ok(Date.now() < until, task + ' did not finish');
    await delay(100);
  }
}

test('the scheduled LUFS task matches Native album and track results and respects the library option', { skip: !enabled, timeout: 240000 }, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'audio-normalization-' + randomUUID()));
  const root = output.root, referenceRoot = path.join(root, 'reference'), mediaRoot = path.join(root, 'audio');
  const nativeOrigin = 'http://127.0.0.1:' + port;
  const evidence = { native: {}, node: {} };
  let native, database, runtime, proxy, vfsFixture, authorization, failure;
  const requestAt = origin => async (route, init, expected = 200) => {
    const response = await fetch(origin + route, { ...init, headers: { 'Content-Type': 'application/json', Authorization: authorization, ...init?.headers }, signal: t.signal });
    const bytes = await response.text();
    assert.equal(response.status, expected, route + ' ' + bytes);
    return bytes ? JSON.parse(bytes) : null;
  };
  async function stopNative() {
    if (!native) return;
    const instance = native; native = undefined;
    evidence.shutdown = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization, Connection: 'close' }, signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
    }));
    assert.equal(evidence.shutdown.cleanShutdown, true);
    assert.equal(evidence.shutdown.pidGone, true);
  }
  try {
    await mkdir(root);
    const current = await currentNativeReference();
    output.addSecret(current.accessToken); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="Audio normalization fixture", Device="Isolated", DeviceId="fixture-oracle", Version="1", Token="${current.accessToken}"`;
    evidence.reference = current.preparation;
    evidence.bindings = await current.sourceBindings(['Emby.Server.Implementations/ScheduledTasks/Tasks/AudioNormalizationTask.cs', 'MediaBrowser.Controller/Entities/Audio/MusicAlbum.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true });
    await current.prepareClone(referenceRoot, port);
    const audio = [
      ['enabled/Artist/Album/01-Quiet.wav', wave(1300, 401)],
      ['enabled/Artist/Album/02-Loud.wav', wave(7300, 797)],
      ['disabled/Other/Album/01-Disabled.wav', wave(5100, 911)],
    ];
    for (const [name, bytes] of audio) {
      const filename = path.join(mediaRoot, name);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    }
    proxy = await startOwnedMediaProxy(audio.map(([name, bytes]) => ({ filename: path.join(mediaRoot, name), contentType: 'audio/wav',
      expected: { bytes: bytes.length, sha256: digest(bytes) } })));
    native = current.start({ referenceRoot, outputRoot: root, label: 'native', origin: nativeOrigin });
    await native.ready();
    const request = requestAt(nativeOrigin);
    const tasks = await request('/ScheduledTasks');
    for (const task of tasks) await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: '[]' }, 204);
    for (const [index, name] of ['enabled', 'disabled'].entries()) {
      await request('/Library/VirtualFolders?name=Loudness%20' + name + '&collectionType=music&refreshLibrary=false', { method: 'POST', body: JSON.stringify({
        LibraryOptions: { Enabled: true, EnableLUFSScan: index === 0, EnableRealtimeMonitor: false, EnableInternetProviders: false,
          PathInfos: [{ Path: path.join(mediaRoot, name) }],
          TypeOptions: ['Audio', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] })) },
      }) }, 204);
    }
    await runTask(request, tasks.find(task => task.Key === 'RefreshLibrary').Id);
    const projection = async request => (await request('/Items?Recursive=true&IncludeItemTypes=Audio,MusicAlbum&Fields=Path')).Items
      .filter(item => item.Path && path.relative(mediaRoot, item.Path).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(mediaRoot, item.Path)))
      .map(({ Id, Type, Path, NormalizationGain, AlbumNormalizationGain }) => ({ Id, Type, path: path.relative(mediaRoot, Path), NormalizationGain, AlbumNormalizationGain }))
      .sort((left, right) => left.Id.localeCompare(right.Id));
    const baseline = await projection(request);
    assert.equal(baseline.filter(item => item.Type === 'Audio').length, audio.length, JSON.stringify(baseline));
    assert.ok(baseline.every(item => item.NormalizationGain == null));
    await stopNative();
    const configuration = await readInstanceConfiguration(referenceRoot);
    const sqlitePath = path.join(configuration.dataPath, 'jellyfin.db');
    database = await createPostgresTestDatabase(null, 'audio_normalization');
    const snapshot = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    try {
      evidence.transfer = await transferDatabase(snapshot, database, { instanceBinding: { serverId: configuration.serverId,
        originIdentityDigest: digest(await readFile(sqlitePath)) } });
    } finally { snapshot.close(); }
    native = current.start({ referenceRoot, outputRoot: root, label: 'native-loudness', origin: nativeOrigin });
    await native.ready();
    evidence.native.task = await runTask(request, audioNormalizationTaskId);
    evidence.native.warm = await projection(request);
    await stopNative();
    native = current.start({ referenceRoot, outputRoot: root, label: 'native-cold', origin: nativeOrigin });
    await native.ready();
    evidence.native.dto = await projection(request);
    await stopNative();
    const readLufs = async db => {
      const rows = await Promise.all(baseline.map(item => db.rows('BaseItems', { where: { Id: nativeGuid(item.Id) }, columns: ['Id', 'LUFS', 'NormalizationGain'] })));
      return rows.flat();
    };
    const persisted = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    try { evidence.native.persisted = await readLufs(persisted); } finally { persisted.close(); }
    assert.equal(evidence.native.dto.filter(item => Number.isFinite(item.NormalizationGain)).length, 3);
    assert.equal(evidence.native.dto.filter(item => Number.isFinite(item.AlbumNormalizationGain)).length, 2);
    vfsFixture = await extractionFixture(Object.fromEntries(audio.map(([name, bytes]) => ['/' + name, bytes])));
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: mediaRoot, accessRoot: '/', style: process.platform === 'win32' ? 'windows' : 'posix',
      returnAccess: 'Retain the isolated audio library identities for the Native comparison.' });
    runtime = await createTestRuntime({ ...configuration, database, vfs: vfsFixture.vfs, identityMap });
    const nodeRequest = requestAt('http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port);
    evidence.node.folders = (await nodeRequest('/Library/VirtualFolders')).filter(folder => folder.Name.startsWith('Loudness '))
      .map(folder => ({ id: folder.ItemId, name: folder.Name, enabled: folder.LibraryOptions?.EnableLUFSScan }));
    evidence.node.task = await runTask(nodeRequest, audioNormalizationTaskId);
    evidence.node.dto = await projection(nodeRequest);
    evidence.node.persisted = await readLufs(database);
    assert.deepEqual(evidence.node.persisted, evidence.native.persisted);
    assert.deepEqual(evidence.node.dto, evidence.native.dto);
    await current.finish();
  } catch (error) { failure = output.publicError(error); evidence.failure = failure.message; }
  finally {
    const errors = failure ? [failure] : [];
    for (const cleanup of [stopNative, () => runtime?.close(), () => proxy?.close(), () => vfsFixture?.close(), () => dropPostgresTestDatabase(database)]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); }
    finally { await output.publishAndClose(); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Audio normalization validation failed.');
  }
}, { signal: t.signal })));
