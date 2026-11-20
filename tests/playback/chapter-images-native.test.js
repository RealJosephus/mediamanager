import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { chapterImagesTaskId } from '../../src/tasks/chapter-images-task.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { extractionFixture } from './extraction-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function execute(request, id) {
  const before = await request('/ScheduledTasks/' + id);
  await request('/ScheduledTasks/Running/' + id, { method: 'POST' }, 204);
  const deadline = Date.now() + 90000;
  while (true) {
    const state = await request('/ScheduledTasks/' + id);
    if (state.State === 'Idle' && state.LastExecutionResult?.StartTimeUtc && state.LastExecutionResult.StartTimeUtc !== before.LastExecutionResult?.StartTimeUtc) {
      assert.equal(state.LastExecutionResult.Status, 'Completed', JSON.stringify(state.LastExecutionResult)); return state;
    }
    assert.ok(Date.now() < deadline, 'The scheduled task must finish.');
    await delay(100);
  }
}

test('scheduled chapter images generate the native JPEG at the stored chapter position and are served over HTTP', { skip: !enabled, timeout: 240000 }, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'chapter-images-' + randomUUID()));
  const root = output.root, referenceRoot = path.join(root, 'reference'), mediaRoot = path.join(root, 'fixture');
  const filename = path.join(mediaRoot, 'Chapter Test.m2ts'), nativeOrigin = 'http://127.0.0.1:' + port;
  const evidence = { native: {}, node: {} };
  let native, proxy, fixture, database, runtime, authorization, failure;
  const requestAt = origin => async (route, init, expected = 200) => {
    const response = await fetch(origin + route, { ...init, headers: { Authorization: authorization, 'Content-Type': 'application/json' }, signal: t.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, route + ' ' + bytes.toString());
    const type = response.headers.get('content-type');
    return type?.includes('application/json') ? JSON.parse(bytes) : { type, bytes };
  };
  async function closeNative() {
    if (!native) return;
    const instance = native; native = undefined;
    const outcome = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization, Connection: 'close' }, signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
    }));
    (evidence.shutdowns ??= []).push(outcome); assert.ok(outcome.cleanShutdown && outcome.pidGone);
  }
  try {
    await mkdir(root); await mkdir(mediaRoot);
    const current = await currentNativeReference();
    output.addSecret(current.accessToken); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="Chapter image fixture", Device="Isolated", DeviceId="fixture-oracle", Version="1", Token="${current.accessToken}"`;
    evidence.reference = current.preparation;
    evidence.bindings = await current.sourceBindings(['Emby.Server.Implementations/Chapters/ChapterManager.cs',
      'Emby.Server.Implementations/ScheduledTasks/Tasks/ChapterImagesTask.cs', 'MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true }); await current.prepareClone(referenceRoot, port);
    const { bytes, source } = await readFrozenAv('dual-avc.m2ts', { signal: t.signal });
    evidence.source = source; await writeFile(filename, bytes);
    proxy = await startOwnedMediaProxy([{ filename, contentType: 'video/mp2t', expected: source }]);
    const systemXml = path.join(referenceRoot, 'config', 'system.xml');
    const settings = (await readFile(systemXml, 'utf8')).replace(/<ChapterImageResolution>[^<]*<\/ChapterImageResolution>/u, '<ChapterImageResolution>P240</ChapterImageResolution>');
    assert.ok(settings.includes('<ChapterImageResolution>P240</ChapterImageResolution>')); await writeFile(systemXml, settings);
    const startNative = async label => { native = current.start({ referenceRoot, outputRoot: root, label, origin: nativeOrigin }); await native.ready(); };
    await startNative('native-prepare');
    const request = requestAt(nativeOrigin), tasks = await request('/ScheduledTasks');
    for (const task of tasks) await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: '[]' }, 204);
    await request('/Library/VirtualFolders?name=Chapter%20images&collectionType=movies&refreshLibrary=false', { method: 'POST', body: JSON.stringify({
      LibraryOptions: { Enabled: true, EnableChapterImageExtraction: true, ExtractChapterImagesDuringLibraryScan: false,
        EnableRealtimeMonitor: false, EnableInternetProviders: false, PathInfos: [{ Path: mediaRoot }],
        TypeOptions: [{ Type: 'Movie', MetadataFetchers: [], ImageFetchers: [] }] },
    }) }, 204);
    await execute(request, tasks.find(task => task.Key === 'RefreshLibrary').Id);
    const item = (await request('/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Path')).Items.find(value => value.Path === filename);
    assert.ok(item, 'Native indexed the designated video bytes.');
    const imageRoute = `/Items/${item.Id}/Images/Chapter/0`;
    await closeNative();
    const configuration = await readInstanceConfiguration(referenceRoot), sqlitePath = path.join(configuration.dataPath, 'jellyfin.db');
    const itemId = nativeGuid(item.Id);
    const sqlite = new SqliteDatabase(sqlitePath, { requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'chapter_images');
    try {
      sqlite.transaction(() => {
        sqlite.deleteWhere('Chapters', { ItemId: itemId });
        sqlite.insert('Chapters', { ItemId: itemId, ChapterIndex: 0, StartPositionTicks: 5000000n, Name: 'At half a second', ImagePath: null, ImageDateModified: null });
      });
      evidence.transfer = await transferDatabase(sqlite, database, { instanceBinding: { serverId: configuration.serverId, originIdentityDigest: sha256(await readFile(sqlitePath)) } });
    } finally { sqlite.close(); }
    await startNative('native-chapters');
    evidence.native.task = await execute(request, chapterImagesTaskId);
    const nativeImage = await request(imageRoute);
    evidence.native.image = { type: nativeImage.type, bytes: nativeImage.bytes.length, sha256: sha256(nativeImage.bytes) };
    await closeNative();
    const currentStore = new SqliteDatabase(sqlitePath, { readOnly: true, requireMigrationHistory: true });
    try { [evidence.native.chapter] = currentStore.rows('Chapters', { where: { ItemId: itemId } }); }
    finally { currentStore.close(); }
    const generated = evidence.native.chapter.ImagePath;
    assert.equal(path.dirname(generated).startsWith(configuration.metadataPath + path.sep), true);
    assert.match(path.basename(generated), /^\d+_5000000\.jpg$/u);
    await rename(generated, path.join(root, 'native-chapter.jpg'));
    fixture = await extractionFixture({ '/chapter.m2ts': bytes });
    const identityMap = new IdentityAccessMap(); identityMap.bind(item.Id, '/chapter.m2ts');
    runtime = await createTestRuntime({ ...configuration, database, vfs: fixture.vfs, identityMap });
    const nodeRequest = requestAt('http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port);
    evidence.node.task = await execute(nodeRequest, chapterImagesTaskId);
    const nodeImage = await nodeRequest(imageRoute);
    evidence.node.image = { type: nodeImage.type, bytes: nodeImage.bytes.length, sha256: sha256(nodeImage.bytes) };
    [evidence.node.chapter] = await database.rows('Chapters', { where: { ItemId: itemId } });
    assert.deepEqual(evidence.node.image, evidence.native.image);
    assert.equal(evidence.node.chapter.ImagePath, generated);
    assert.ok(evidence.node.chapter.ImageDateModified);
    assert.ok(fixture.requests.some(entry => entry.method === 'GET'));
    await current.finish();
  } catch (error) { failure = output.publicError(error); evidence.error = failure.message; }
  finally {
    const errors = failure ? [failure] : [];
    for (const cleanup of [closeNative, () => runtime?.close(), () => proxy?.close(), () => fixture?.close(), () => dropPostgresTestDatabase(database)]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); }
    finally { await output.publishAndClose(); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Chapter image validation failed.');
  }
}, { signal: t.signal })));
