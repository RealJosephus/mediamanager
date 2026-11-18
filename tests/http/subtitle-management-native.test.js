import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { getNewItemId } from '../../src/core/identity.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { idKey } from '../../src/library/records.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { portAvailable } from './fixtures/lyrics-management/scenario.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const entity = type => 'MediaBrowser.Controller.Entities.' + type;
const movieId = nativeGuid('83200000-0000-0000-0000-000000000001');
const date = '2026-01-02 03:04:05';
const authorization = 'MediaBrowser Client="Subtitle fixture", Device="Isolated", DeviceId="subtitle-writer", Version="1"';
const primary = Buffer.from('1\r\n00:00:00,000 --> 00:00:01,500\r\nFirst line\r\n\r\n');
const secondary = Buffer.from('1\n00:00:00,000 --> 00:00:01,500\nSecond line\n\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function seed(settings, media, collection, filename) {
  const { programDataPath, configuration, dataPath } = settings;
  const pathId = (type, filename) => nativeGuid(getNewItemId(filename, entity(type), {
    programDataPath, enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds,
  }));
  const sqlite = new SqliteDatabase(path.join(dataPath, 'jellyfin.db'), { requireMigrationHistory: true });
  const folderId = pathId('Folder', media), collectionId = pathId('CollectionFolder', collection);
  const userRootPath = path.dirname(collection);
  const insert = (type, fields) => sqlite.insert('BaseItems', postgresTestRow('BaseItems', {
    Type: entity(type), MediaType: 'Unknown', CleanName: fields.Name.toLowerCase(), SortName: fields.Name.toLowerCase(),
    ChannelId: nativeGuid('0'.repeat(32)), PresentationUniqueKey: idKey(fields.Id),
    DateCreated: date, DateModified: date, DateLastSaved: date, Data: '{}', ...fields,
  }));
  try {
    const aggregate = sqlite.rows('BaseItems', { where: { Type: entity('AggregateFolder') } })[0];
    const userRoot = sqlite.rows('BaseItems', { where: { Type: entity('UserRootFolder') } })[0];
    const rootId = userRoot?.Id ?? pathId('UserRootFolder', userRootPath);
    sqlite.transaction(() => {
      if (!userRoot) insert('UserRootFolder', { Id: rootId, Path: userRootPath, Name: 'default', IsFolder: true, Data: '{"IsRoot":true}' });
      insert('CollectionFolder', { Id: collectionId, ParentId: rootId, Path: collection, Name: 'Subtitle Library',
        IsFolder: true, Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [folderId], PhysicalLocationsList: [media] }) });
      insert('Folder', { Id: folderId, ParentId: aggregate.Id, TopParentId: folderId, Path: media, Name: 'Media', IsFolder: true });
      insert('Movies.Movie', { Id: movieId, ParentId: folderId, TopParentId: folderId, Path: filename, Name: 'Subtitle fixture',
        MediaType: 'Video', IsMovie: true, Data: '{"VideoType":"VideoFile","Container":"mkv"}' });
      for (const [ItemId, ParentItemId] of [[folderId, aggregate.Id], [movieId, folderId], [movieId, aggregate.Id]]) {
        sqlite.insert('AncestorIds', { ItemId, ParentItemId });
      }
    });
    sqlite.preflight();
  } finally { sqlite.close(); }
}

test('Native and Node upload and remove external subtitles through real storage and published stream metadata', {
  skip: !enabled, timeout: 360000,
}, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'subtitle-management-' + randomUUID()));
  await mkdir(output.root);
  const reference = path.join(output.root, 'reference'), report = { native: [], node: [], cleanup: [] };
  const nativeOrigin = 'http://127.0.0.1:' + port;
  let current, native, runtime, database, proxy, primaryError;
  const stopNative = async () => {
    if (!native) return;
    const process = native;
    native = undefined;
    report.stop = await process.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST',
        headers: { Authorization: authorization + ', Token="' + current.accessToken + '"', Connection: 'close' } });
      await response.arrayBuffer();
      return response.status;
    }, () => portAvailable(port));
    assert.ok(report.stop.cleanShutdown && report.stop.portAvailable && report.stop.pidGone);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    report.sources = await current.sourceBindings(['Jellyfin.Api/Controllers/SubtitleController.cs',
      'MediaBrowser.Providers/Subtitles/SubtitleManager.cs', 'Emby.Naming/Common/NamingOptions.cs']);
    await cp(current.sourceRoot, reference, { recursive: true });
    await current.prepareClone(reference, port);
    const settings = await readInstanceConfiguration(reference);
    const media = path.join(settings.programDataPath, 'subtitle-fixture-media');
    const collection = path.join(settings.programDataPath, 'root/default/Subtitle Library');
    const filename = path.join(media, 'Title.mkv'), stem = path.join(media, 'Title.en.forced.sdh');
    const destinations = [stem + '.srt', stem + '.0.srt'];
    await mkdir(media, { recursive: true });
    await mkdir(collection, { recursive: true });
    await writeFile(path.join(collection, 'movies.collection'), '');
    await writeFile(path.join(collection, 'media.mblink'), media);
    await writeFile(path.join(collection, 'options.xml'), '<LibraryOptions><SaveSubtitlesWithMedia>true</SaveSubtitlesWithMedia><EnableRealtimeMonitor>false</EnableRealtimeMonitor></LibraryOptions>');
    const video = await readFile(new URL('../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url));
    await writeFile(filename, video);
    seed(settings, media, collection, filename);
    const snapshot = path.join(settings.dataPath, 'jellyfin.db');
    database = await createPostgresTestDatabase(null, 'subtitle_management');
    const sqlite = new SqliteDatabase(snapshot, { readOnly: true, requireMigrationHistory: true });
    try {
      await transferDatabase(sqlite, database, { instanceBinding: {
        serverId: settings.serverId, originIdentityDigest: sha(await readFile(snapshot)),
      } });
    } finally { sqlite.close(); }
    proxy = await startOwnedMediaProxy([[filename, video, 'video/x-matroska'],
      [destinations[0], primary, 'text/plain'], [destinations[1], secondary, 'text/plain']]
      .map(([filename, bytes, contentType]) => ({ filename, contentType, expected: { bytes: bytes.length, sha256: sha(bytes) } })));
    report.proxy = proxy.report;
    const execute = async (origin, observations, persistentRows) => {
      const item = idKey(movieId), route = '/Videos/' + item + '/Subtitles';
      const request = async (label, method, target, { token = current.accessToken, authentication, body } = {}) => {
        const response = await fetch(origin + target, { method, body: body === undefined ? undefined : JSON.stringify(body),
          headers: { Connection: 'close', Accept: 'application/json',
            ...(authentication ? { Authorization: authentication } : token ? { Authorization: authorization + ', Token="' + token + '"' } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]) });
        const text = await response.text();
        observations.push({ name: label, status: response.status, contentType: response.headers.get('content-type') });
        return { status: response.status, body: text };
      };
      const upload = bytes => ({ Language: 'EN', Format: 'SRT', IsForced: true, IsHearingImpaired: true, Data: bytes.toString('base64') });
      const flags = row => [row.IsExternal, row.IsForced, row.IsHearingImpaired];
      const handlerRows = async () => (await persistentRows()).filter(row => row.StreamType === 2 && row.IsExternal);
      const waitFor = async count => {
        const deadline = Date.now() + 55000;
        for (;;) {
          const result = await handlerRows();
          if (result.length === count) return result;
          assert.ok(Date.now() < deadline, JSON.stringify(result));
          await delay(75, undefined, { signal: t.signal });
        }
      };
      const send = async (name, bytes, token) => {
        const response = await request(name, 'POST', route, { body: upload(bytes), token });
        assert.equal(response.status, 204, response.body);
      };
      assert.equal((await request('anonymous upload', 'POST', route, { body: upload(primary), token: null })).status, 401);
      assert.equal((await request('unsupported format', 'POST', route, { body: { ...upload(primary), Format: 'idx' } })).status, 400);
      const name = 'Subtitle Manager', password = randomUUID();
      output.addSecret(password);
      const created = await request('create an ordinary account', 'POST', '/Users/New', { body: { Name: name, Password: password } });
      assert.equal(created.status, 200);
      const { Id, Policy } = JSON.parse(created.body);
      const login = await request('ordinary client login', 'POST', '/Users/AuthenticateByName', { token: null,
        authentication: authorization.replace('subtitle-writer', 'subtitle-reader'), body: { Username: name, Pw: password } });
      assert.equal(login.status, 200);
      const managerToken = JSON.parse(login.body).AccessToken;
      output.addSecret(managerToken);
      const setPermission = async enabled => {
        const decision = await request(enabled ? 'grant subtitle management' : 'deny subtitle management', 'POST', '/Users/' + Id + '/Policy',
          { body: { ...Policy, IsAdministrator: false, EnableAllFolders: true, EnableSubtitleManagement: enabled } });
        assert.equal(decision.status, 204);
      };
      await setPermission(false);
      assert.equal((await request('ordinary upload denied', 'POST', route, { body: upload(primary), token: managerToken })).status, 403);
      await setPermission(true);
      await send('permitted subtitle manager upload', primary, managerToken);
      const initial = await waitFor(1);
      assert.deepEqual(flags(initial[0]), [true, true, true]);
      await send('repeat upload', secondary);
      const streams = await waitFor(2);
      assert.ok(streams.every(row => row.Codec === 'subrip' && row.Language === 'eng'));
      const playback = await request('read selected media streams', 'GET', '/Items/' + item + '/PlaybackInfo');
      assert.equal(playback.status, 200);
      const publicStreams = JSON.parse(playback.body).MediaSources.flatMap(source => source.MediaStreams)
        .filter(row => row.Type === 'Subtitle' && row.IsExternal);
      assert.equal(publicStreams.length, 2);
      assert.ok(publicStreams.every(row => row.Codec === 'subrip' && row.Language === 'eng'));
      const stream = streams.find(row => typeof row.Path === 'string' && row.Path.endsWith('.sdh.srt'));
      assert.ok(stream);
      assert.equal(sha(await readFile(destinations[0])), sha(primary));
      assert.equal(sha(await readFile(destinations[1])), sha(secondary));
      observations.push({ name: 'committed subtitle streams', flags: streams.map(flags), bytes: await Promise.all(destinations.map(async filename => sha(await readFile(filename)))) });
      assert.equal((await request('subtitle manager cannot delete without elevation', 'DELETE', route + '/' + stream.StreamIndex,
        { token: managerToken })).status, 403);
      const deleted = await request('delete selected index', 'DELETE', route + '/' + stream.StreamIndex);
      assert.equal(deleted.status, 204, deleted.body);
      await assert.rejects(readFile(destinations[0]), { code: 'ENOENT' });
      const remaining = await waitFor(1);
      assert.ok(remaining[0].Path.endsWith('.sdh.0.srt'));
      assert.equal(sha(await readFile(destinations[1])), sha(secondary));
      observations.push({ name: 'remaining subtitle', flags: flags(remaining[0]), bytes: sha(secondary) });
      assert.equal(sha(await readFile(filename)), sha(video));
    };
    const where = { ItemId: movieId };
    native = current.start({ referenceRoot: reference, outputRoot: output.root, label: 'native', origin: nativeOrigin });
    await native.ready();
    await execute(nativeOrigin, report.native, () => {
      const db = new SqliteDatabase(snapshot, { readOnly: true, requireMigrationHistory: true });
      try { return db.rows('MediaStreamInfos', { where }); }
      finally { db.close(); }
    });
    await stopNative();
    await rm(destinations[1]);
    await writeFile(path.join(reference, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><AutoDiscovery>false</AutoDiscovery><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>');
    runtime = await createTestRuntime({ ...await readInstanceConfiguration(reference), database,
      mediaEncoderOptions: { startupFFmpegPath: current.ffmpeg }, onError: error => { (report.runtimeErrors ??= []).push(error?.message); } });
    const nodeOrigin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
    await execute(nodeOrigin, report.node, () => database.rows('MediaStreamInfos', { where }));
    assert.deepEqual(report.node, report.native);
  } catch (error) { primaryError = output.publicError(error); throw primaryError; }
  finally {
    const failures = [];
    for (const [name, close] of [['native', stopNative], ['node', () => runtime?.close()], ['proxy', () => proxy?.close()],
      ['postgres', () => dropPostgresTestDatabase(database)], ['source', () => current?.finish()]]) {
      try { await close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { failures.push(output.publicError(error)); }
    }
    try {
      await writeFile(path.join(output.root, 'observations.json'), filterEvidenceJson(report));
      await output.publishAndClose();
    } catch (error) { failures.push(output.publicError(error)); }
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, 'Subtitle fixture cleanup failed.');
  }
}, { signal: t.signal })));
