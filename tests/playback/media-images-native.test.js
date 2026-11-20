import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { writeLocalFixtureStorage } from '../helpers/local-state-storage.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const describe = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });

test('library scans extract embedded audio art, video attachments and representative video frames', {
  skip: !enabled, timeout: 240000,
}, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'media-images-' + randomUUID()));
  const root = output.root, referenceRoot = path.join(root, 'reference'), origin = 'http://127.0.0.1:' + port;
  const moviePath = path.join(referenceRoot, 'fixture-video'), musicPath = path.join(referenceRoot, 'fixture-audio');
  const stillName = path.join(moviePath, 'Screen Grab.m2ts'), posterName = path.join(moviePath, 'Embedded Art.mkv');
  const audioName = path.join(musicPath, 'Embedded Audio.mp3'), coverName = path.join(root, 'cover.png');
  const evidence = { native: {}, node: {}, diagnostics: [] };
  let native, runtime, database, proxy, auth, failure, current;
  const client = endpoint => async (route, { status = 200, method = 'GET', body } = {}) => {
    const response = await fetch(endpoint + route, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' },
      signal: t.signal, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer()), mime = response.headers.get('content-type');
    assert.equal(response.status, status, route + ' ' + bytes.toString());
    return mime?.includes('application/json') ? JSON.parse(bytes) : { bytes, mime };
  };
  const startNative = async label => {
    native = current.start({ referenceRoot, outputRoot: root, label, origin });
    await native.ready();
  };
  const stopNative = async () => {
    if (!native) return;
    const instance = native; native = undefined;
    const receipt = await instance.stop(async () => {
      const response = await fetch(origin + '/System/Shutdown', { method: 'POST', headers: { Authorization: auth, Connection: 'close' },
        signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
    }));
    (evidence.shutdowns ??= []).push(receipt); assert.ok(receipt.cleanShutdown && receipt.pidGone && receipt.portAvailable);
  };
  try {
    await mkdir(root);
    current = await currentNativeReference();
    output.addSecret(root);
    output.addSecret(current.accessToken); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    auth = `MediaBrowser Client="Media art fixture", Device="Isolated", DeviceId="media-image-fixture", Version="1", Token="${current.accessToken}"`;
    evidence.reference = current.preparation;
    evidence.bindings = await current.sourceBindings(['MediaBrowser.Providers/MediaInfo/AudioImageProvider.cs',
      'MediaBrowser.Providers/MediaInfo/EmbeddedImageProvider.cs', 'MediaBrowser.Providers/MediaInfo/VideoImageProvider.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true }); await current.prepareClone(referenceRoot, port);
    await mkdir(moviePath); await mkdir(musicPath);
    const ignore = 'unused-fixture-file\n';
    await writeFile(path.join(moviePath, '.ignore'), ignore); await writeFile(path.join(musicPath, '.ignore'), ignore);
    const media = await readFrozenAv('dual-avc.m2ts', { signal: t.signal });
    await writeFile(stillName, media.bytes);
    await writeFile(coverName, await readFile(new URL('../images/fixtures/processor/single.png', import.meta.url)));
    const encode = async args => {
      const result = await captureMediaProcess(validationExecutable('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args],
        { signal: t.signal, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
      assert.equal(result.exitCode, 0, result.stderr.toString());
    };
    await encode(['-i', stillName, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-attach', coverName,
      '-metadata:s:t:0', 'mimetype=image/png', '-metadata:s:t:0', 'filename=poster.png', posterName]);
    await encode(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', coverName,
      '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'libmp3lame', '-c:v', 'png', '-metadata:s:v', 'comment=Cover (front)',
      '-metadata', 'album=Fixture Cover', '-metadata', 'album_artist=Fixture Artist', '-id3v2_version', '3', audioName]);
    const sources = [[stillName, 'video/mp2t'], [posterName, 'video/x-matroska'], [audioName, 'audio/mpeg']];
    const proxySources = await Promise.all(sources.map(async ([filename, contentType]) => ({
      filename, contentType, expected: describe(await readFile(filename)),
    })));
    evidence.sources = proxySources.map(value => value.expected);
    proxy = await startOwnedMediaProxy(proxySources);
    const request = client(origin);
    await startNative('native-prepare');
    const tasks = await request('/ScheduledTasks'), refresh = tasks.find(value => value.Key === 'RefreshLibrary').Id;
    for (const { Id } of tasks) await request('/ScheduledTasks/' + Id + '/Triggers', { method: 'POST', body: [], status: 204 });
    for (const [name, collection, mediaPath, Type, ImageFetchers] of [
      ['Image movies', 'movies', moviePath, 'Movie', ['Embedded Image Extractor', 'Screen Grabber']],
      ['Image music', 'music', musicPath, 'Audio', ['Image Extractor']],
    ]) await request(`/Library/VirtualFolders?name=${encodeURIComponent(name)}&collectionType=${collection}&refreshLibrary=false`, {
      method: 'POST', status: 204, body: { LibraryOptions: { Enabled: true, EnableInternetProviders: false,
        EnableRealtimeMonitor: false, PathInfos: [{ Path: mediaPath }], TypeOptions: [{ Type, MetadataFetchers: [], ImageFetchers }] } },
    });
    await stopNative();
    const configuration = await readInstanceConfiguration(referenceRoot);
    const sqlite = new SqliteDatabase(path.join(configuration.dataPath, 'jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    database = await createPostgresTestDatabase(null, 'media_art');
    try { await transferDatabase(sqlite, database); } finally { sqlite.close(); }
    const run = async (request, name) => {
      const taskPath = '/ScheduledTasks/' + refresh, prior = (await request(taskPath)).LastExecutionResult?.StartTimeUtc;
      await request('/ScheduledTasks/Running/' + refresh, { method: 'POST', status: 204 });
      const deadline = Date.now() + 90000;
      while (true) {
        const task = await request(taskPath), result = task.LastExecutionResult;
        if (task.State === 'Idle' && result?.StartTimeUtc && result.StartTimeUtc !== prior) {
          assert.equal(result.Status, 'Completed', name + ' library scan'); break;
        }
        assert.ok(Date.now() < deadline, name + ' library scan must finish'); await delay(100);
      }
      const { Items } = await request('/Items?IncludeItemTypes=Movie,Audio&Recursive=true&Fields=Path&enableUserData=false');
      evidence[name].items = Items.map(item => ({ type: item.Type, file: item.Path && path.basename(item.Path) })).filter(value => value.file)
        .sort((a, b) => a.file.localeCompare(b.file));
      const saved = [];
      for (const [kind, filename] of [['still', stillName], ['poster', posterName], ['audio', audioName]]) {
        const item = Items.find(value => value.Path === filename);
        assert.ok(item, name + ' did not load the ' + kind + ' media item.');
        const route = '/Items/' + item.Id + '/Images';
        const files = await request(route), image = files.find(value => value.ImageType === 'Primary');
        assert.ok(image, name + ' did not generate the ' + kind + ' image.');
        const observed = await request(route + '/Primary');
        assert.equal(observed.mime, kind === 'poster' ? 'image/png' : 'image/jpeg');
        evidence[name][kind] = { ...describe(observed.bytes), mime: observed.mime };
        saved.push({ kind, id: nativeGuid(item.Id) });
      }
      return saved;
    };
    const storagePath = value => {
      const relative = path.relative(referenceRoot, value);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The image must belong to the isolated instance.');
      return relative;
    };
    await startNative('native-scan');
    const saved = await run(request, 'native'); await stopNative();
    const generated = new SqliteDatabase(path.join(configuration.dataPath, 'jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    try {
      for (const { kind, id } of saved) {
        const [{ Path: filename }] = generated.rows('BaseItemImageInfos', { where: { ItemId: id, ImageType: 0 } });
        evidence.native[kind].path = storagePath(filename);
        await rename(filename, path.join(root, 'native-image-' + kind));
      }
    } finally { generated.close(); }
    await rename(path.join(referenceRoot, 'cache', 'extracted-audio-images'), path.join(root, 'native-audio-cache'));
    const storageConfiguration = await writeLocalFixtureStorage(path.join(root, 'fixture-storage.json'), referenceRoot);
    runtime = await createTestRuntime({ ...configuration, database, storageConfiguration,
      onError: error => evidence.diagnostics.push(output.publicError(error).message) });
    const candidates = await run(client('http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port), 'node');
    for (const { kind, id } of candidates) {
      const [{ Path: filename }] = await runtime.store.run(db => db.rows('BaseItemImageInfos', { where: { ItemId: id, ImageType: 0 } }));
      evidence.node[kind].path = storagePath(filename);
    }
    assert.deepEqual(evidence.node, evidence.native);
    await current.finish();
  } catch (error) { failure = output.publicError(error); evidence.error = failure.message; }
  finally {
    const errors = failure ? [failure] : [];
    for (const cleanup of [stopNative, () => runtime?.close(), () => proxy?.close(), () => database && dropPostgresTestDatabase(database)]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(evidence)); }
    finally { await output.publishAndClose(); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Media image validation failed.');
  }
}, { signal: t.signal })));
