import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { idKey } from '../../src/library/records.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { nativeArtistIdentity, nativeGenreIdentity, nativeMusicGenreIdentity, nativePersonIdentity, nativeStudioIdentity } from '../../src/library/identity.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const movieId = nativeGuid('128f0000000000000000000000000001');
const empty = nativeGuid('00000000000000000000000000000000');
const fixedDate = '2026-10-01 00:00:00';
const authBase = 'MediaBrowser Client="Image writer", Device="Isolated", DeviceId="image-writer", Version="1"';
const authorization = token => `${authBase}, Token="${token}"`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const namedImage = 'Artwork % — A';
const nameIdentities = [
  ['Artists', 'Audio.MusicArtist', nativeArtistIdentity], ['Genres', 'Genre', nativeGenreIdentity],
  ['MusicGenres', 'Audio.MusicGenre', nativeMusicGenreIdentity], ['Persons', 'Person', nativePersonIdentity],
  ['Studios', 'Studio', nativeStudioIdentity],
];

async function seed(root, current, port) {
  await cp(current.sourceRoot, root, { recursive: true });
  await current.prepareClone(root, port);
  const settings = await readInstanceConfiguration(root);
  const databasePath = path.join(settings.dataPath, 'jellyfin.db');
  const database = new SqliteDatabase(databasePath, { requireMigrationHistory: true });
  const media = path.join(root, 'image-writer-media');
  await mkdir(media);
  const filename = path.join(media, 'Image writer.mkv');
  await writeFile(filename, Buffer.alloc(0));
  const bytes = await readFile(new URL('./fixtures/processor/single.png', import.meta.url));
  const chapterFolder = path.join(settings.metadataPath, 'fixture-chapters'), chapterPaths = [];
  await mkdir(chapterFolder, { recursive: true });
  for (const [index, asset] of ['single.png', 'grid.png'].entries()) {
    const chapterPath = path.join(chapterFolder, `chapter-${index}.png`);
    await writeFile(chapterPath, await readFile(new URL('./fixtures/processor/' + asset, import.meta.url)));
    const knownTime = new Date('2026-10-01T00:00:00Z');
    await utimes(chapterPath, knownTime, knownTime);
    chapterPaths.push(chapterPath);
  }
  const named = [];
  for (const [, type, getIdentity] of nameIdentities) {
    const identity = getIdentity(namedImage, settings);
    await mkdir(identity.Path, { recursive: true });
    const imagePath = path.join(identity.Path, 'route-artwork.png');
    await writeFile(imagePath, bytes);
    const knownTime = new Date('2026-10-01T00:00:00Z');
    await utimes(imagePath, knownTime, knownTime);
    named.push({ identity, type, imagePath });
  }
  try {
    const parent = database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.AggregateFolder' } })[0];
    assert.ok(parent);
    database.transaction(() => {
      database.insert('BaseItems', postgresTestRow('BaseItems', { Id: movieId, ParentId: parent.Id,
        ChannelId: empty, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Image writer',
        CleanName: 'image writer', SortName: 'image writer', Path: filename, IsMovie: true, MediaType: 'Video',
        PresentationUniqueKey: idKey(movieId), Data: '{"VideoType":"VideoFile"}',
        DateCreated: fixedDate, DateModified: fixedDate, DateLastSaved: fixedDate }));
      database.insert('AncestorIds', { ItemId: movieId, ParentItemId: parent.Id });
      for (const [ChapterIndex, ImagePath] of chapterPaths.entries()) database.insert('Chapters', postgresTestRow('Chapters', {
        ItemId: movieId, ChapterIndex, ImagePath, ImageDateModified: fixedDate, StartPositionTicks: BigInt(ChapterIndex) * 10000000n,
      }));
      for (const { identity, type, imagePath } of named) {
        database.insert('BaseItems', postgresTestRow('BaseItems', { Id: identity.Id, Path: identity.Path, ChannelId: empty,
          Type: 'MediaBrowser.Controller.Entities.' + type, Name: namedImage, SortName: namedImage, CleanName: namedImage,
          Data: '{}', IsFolder: type === 'Audio.MusicArtist', MediaType: 'Unknown', PresentationUniqueKey: idKey(identity.Id),
          DateCreated: fixedDate, DateModified: fixedDate, DateLastSaved: fixedDate }));
        database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', { Id: randomUUID().toUpperCase(), ItemId: identity.Id,
          Path: imagePath, ImageType: 0, DateModified: fixedDate }));
      }
    });
  } finally { database.close(); }
  return { settings, databasePath, media };
}

function portAvailable(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function startRemoteArtworkFixture(signal) {
  const artwork = await readFile(new URL('./fixtures/processor/grid.png', import.meta.url));
  const requests = [];
  const server = createHttpServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'GET' && request.url === '/poster.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': artwork.length });
      response.end(artwork);
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening', { signal });
  return { url: `http://127.0.0.1:${server.address().port}/poster.png`, requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function waitForProfileFrame(check, signal) {
  const deadline = performance.now() + 6000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'The expected profile WebSocket frame was not delivered.');
    await delay(10, undefined, { signal });
  }
}

async function withProfileSocket(origin, token, signal, run) {
  const url = new URL('/socket', origin.replace(/^http/, 'ws'));
  url.searchParams.set('ApiKey', token);
  url.searchParams.set('DeviceId', 'image-writer');
  const socket = new WebSocket(url, { handshakeTimeout: 6000, headers: { Authorization: authorization(token) } });
  const frames = [], socketErrors = [];
  socket.on('message', bytes => frames.push(parseLosslessJson(bytes.toString('utf8'))));
  socket.on('error', error => socketErrors.push(error));
  try {
    await once(socket, 'open', { signal });
    await waitForProfileFrame(() => frames.some(frame => frame.MessageType === 'ForceKeepAlive'), signal);
    await run(frames, async () => {
      const before = frames.filter(frame => frame.MessageType === 'KeepAlive').length;
      socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
      await waitForProfileFrame(() => frames.filter(frame => frame.MessageType === 'KeepAlive').length > before, signal);
    });
    assert.deepEqual(socketErrors, []);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(6000) });
      socket.close();
      try { await closed; } finally { socket.terminate(); }
    }
  }
}

async function scenario(origin, adminToken, signal, output, imageUrl, results = []) {
  const imageA = await readFile(new URL('./fixtures/processor/single.png', import.meta.url));
  const imageB = await readFile(new URL('./fixtures/processor/grid.png', import.meta.url));
  const fetchResponse = (route, { method = 'GET', token = adminToken, contentType, body, accept = 'application/json' } = {}) => fetch(origin + route, {
    method, body, headers: { Accept: accept, Connection: 'close',
      ...(token ? { Authorization: authorization(token) } : {}), ...(contentType ? { 'Content-Type': contentType } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const userName = 'Image Identity';
  const password = 'image-fixture-password';
  const payload = JSON.stringify({ Name: userName, Password: password });
  const created = await fetchResponse('/Users/New', { method: 'POST', body: payload, contentType: 'application/json' });
  assert.ok(created.ok, `Create isolated image user (${created.status})`);
  const userId = (await created.json()).Id;
  const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: authBase, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ Username: userName, Pw: password }), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  assert.equal(login.status, 200);
  const userToken = (await login.json()).AccessToken;
  output.addSecret(userToken);
  const image = (value, token = adminToken) => ({ method: 'POST', token, body: value.toString('base64'), contentType: 'image/png; charset=utf-8' });
  const adminUser = await fetchResponse('/Users/Me');
  assert.equal(adminUser.status, 200);
  const adminId = (await adminUser.json()).Id;
  const item = `/Items/${idKey(movieId)}/Images`, primary = item + '/Primary', backdrop = item + '/Backdrop', chapter = item + '/Chapter';
  const screenshot = item + '/Screenshot';
  const profile = `/Users/${userId}/Images/Primary`, readImage = { accept: 'image/png' };
  const remoteImages = `/Items/${idKey(movieId)}/RemoteImages`;
  const externalIds = `/Items/${idKey(movieId)}/ExternalIdInfos`;
  const jsonPost = value => ({ method: 'POST', contentType: 'application/json', body: JSON.stringify(value) });
  const noProvider = { SearchProviderName: 'Unconfigured image fixture provider', SearchInfo: { Name: 'Owned fixture' } };
  const samples = [
    ...nameIdentities.flatMap(([group]) => {
      const base = `/${group}/${encodeURIComponent(namedImage)}/Images/Primary`;
      const urls = group === 'Artists' ? [base + '/0'] : [base, base + '/0'];
      return urls.flatMap(url => [
        [`public ${url} GET`, url + '?format=Png', { ...readImage, token: null }, 200, sha(imageA)],
        [`public ${url} HEAD`, url + '?format=Png', { ...readImage, token: null, method: 'HEAD' }, 200, sha(Buffer.alloc(0))],
      ]);
    }),
    ['missing named Person', '/Persons/Missing%20Image%20Person/Images/Primary', { token: null }, 404],
    ['missing named Genre image', '/Genres/Missing%20Image%20Genre/Images/Primary', { token: null }, 404],
    ['remote image providers', remoteImages + '/Providers', {}, 200],
    ['remote image provider with no eligible results', remoteImages + '?type=Primary&startIndex=1&limit=2&providerName=Unconfigured', {}, 200],
    ['external identification fields', externalIds, {}, 200],
    ['external identification fields require elevation', externalIds, { token: userToken }, 403],
    ...['Movie', 'Trailer', 'MusicVideo', 'Series', 'BoxSet', 'MusicArtist', 'MusicAlbum', 'Person', 'Book'].map(type => [
      `identify ${type} with no eligible provider`, `/Items/RemoteSearch/${type}`, jsonPost(noProvider), 200,
    ]),
    ['identify inaccessible result target', '/Items/RemoteSearch/Apply/28110000000000000000000000000000', jsonPost({ Name: 'Unused result' }), 404],
    ['download remote item artwork', remoteImages + '/Download?type=Primary&imageUrl=' + encodeURIComponent(imageUrl), { method: 'POST' }, 204],
    ['read downloaded remote artwork', primary + '?format=Png', readImage, 200, sha(imageB)],
    ['anonymous item upload', primary, image(imageA, null), 401],
    ['ordinary item upload', primary, image(imageA, userToken), 403],
    ['invalid MIME', primary, { ...image(imageA), contentType: 'text/plain' }, 400],
    ['initialize poster', primary + '/92', image(imageA), 204],
    ['read poster', primary + '?format=Png', readImage, 200, sha(imageA)],
    ['delete poster', primary + '/0', { method: 'DELETE' }, 204],
    ['poster removed', primary, readImage, 404],
    ['delete absent poster', primary, { method: 'DELETE' }, 204],
    ['upload screenshot', screenshot, image(imageA), 204],
    ['indexed upload replaces screenshot', screenshot + '/97', image(imageB), 204],
    ['read replacement screenshot', screenshot + '?format=Png', readImage, 200, sha(imageB)],
    ['read screenshot info', item, { verifyScreenshot: true }, 200],
    ['delete screenshot', screenshot, { method: 'DELETE' }, 204],
    ['first backdrop', backdrop, image(imageA), 204],
    ['append indexed backdrop', backdrop + '/97', image(imageB), 204],
    ['first backdrop before swap', backdrop + '/0?format=Png', readImage, 200, sha(imageA)],
    ['second backdrop before swap', backdrop + '/1?format=Png', readImage, 200, sha(imageB)],
    ['swap backdrops', backdrop + '/0/Index?newIndex=1', { method: 'POST' }, 204],
    ['first backdrop after swap', backdrop + '/0?format=Png', readImage, 200, sha(imageB)],
    ['second backdrop after swap', backdrop + '/1?format=Png', readImage, 200, sha(imageA)],
    ['delete second backdrop by query index', backdrop + '?imageIndex=1', { method: 'DELETE' }, 204],
    ['second backdrop removed', backdrop + '/1', readImage, 404],
    ['append backdrop for cold read', backdrop + '/93', image(imageA), 204],
    ['first backdrop after append', backdrop + '/0?format=Png', readImage, 200, sha(imageB)],
    ['second backdrop after append', backdrop + '/1?format=Png', readImage, 200, sha(imageA)],
    ['swap chapter images', chapter + '/0/Index?newIndex=1', { method: 'POST' }, 204],
    ['first chapter after swap', chapter + '/0?format=Png', readImage, 200, sha(imageB)],
    ['delete second chapter asset', chapter + '/1', { method: 'DELETE' }, 204],
    ['swap against a missing chapter file', chapter + '/0/Index?newIndex=1', { method: 'POST' }, 404],
    ['swap against an absent chapter index', chapter + '/0/Index?newIndex=9', { method: 'POST' }, 204],
    ['anonymous user upload', '/UserImage?userId=' + userId, image(imageA, null), 401],
    ['another user upload is forbidden', '/UserImage?userId=' + adminId, image(imageA, userToken), 403],
    ['another user delete is forbidden', '/UserImage?userId=' + adminId, { method: 'DELETE', token: userToken }, 403],
    ['own user upload', '/UserImage', image(imageA, userToken), 204],
    ['own user image', '/UserImage?userId=' + userId + '&format=Png', readImage, 200, sha(imageA)],
    ['admin user upload alias', profile + '/7', image(imageB), 204],
    ['user image alias read', profile + '?format=Png', readImage, 200, sha(imageB)],
    ['user image alias delete', profile + '/7', { method: 'DELETE', token: userToken }, 204],
    ['user image removed', '/UserImage?userId=' + userId, readImage, 404],
    ['user image repeated delete', '/UserImage', { method: 'DELETE', token: userToken }, 204],
    ['user upload for cold read', profile, image(imageB), 204],
  ];
  const record = async ([name, route, options, status, expectedHash]) => {
    const response = await fetchResponse(route, options);
    const bytes = Buffer.from(await response.arrayBuffer()), contentType = response.headers.get('content-type');
    let body = /^(?:application\/json|application\/problem\+json)/.test(contentType ?? '')
      ? projectProblemTrace(parseLosslessJson(bytes.toString('utf8')), response.status) : bytes.toString('utf8');
    if (options.verifyScreenshot && response.status === 200) {
      assert.deepEqual(body.map(image => image.ImageType), ['Screenshot']);
      assert.ok(!Object.hasOwn(body[0], 'ImageIndex'));
      assert.ok(body[0].ImageTag);
      assert.equal(Number(body[0].Size), imageB.length);
      body = { type: body[0].ImageType, bytes: Number(body[0].Size), hasImageTag: Boolean(body[0].ImageTag) };
    }
    results.push({ name, status: response.status, contentType, body: expectedHash ? { sha256: sha(bytes), length: bytes.length } : body });
    assert.equal(response.status, status, `${name}: ${bytes.length <= 800 ? bytes.toString('utf8') : contentType}`);
    if (expectedHash) assert.equal(sha(bytes), expectedHash, name);
  };
  const profileReadbacks = [];
  await withProfileSocket(origin, userToken, signal, async (frames, barrier) => {
    for (const sample of samples) {
      await record(sample);
      const [name] = sample;
      if (!['own user upload', 'admin user upload alias', 'user upload for cold read', 'user image alias delete'].includes(name)) continue;
      const own = await fetchResponse(`/Users/${userId}`, { token: userToken });
      assert.equal(own.status, 200);
      const dto = await own.json();
      assert.equal(dto.Id, userId);
      assert.equal(dto.Name, userName);
      const hasImageTag = Boolean(dto.PrimaryImageTag);
      assert.equal(hasImageTag, name !== 'user image alias delete');
      profileReadbacks.push({ action: name, user: dto.Name, hasImageTag });
    }
    await barrier();
    assert.deepEqual(frames.filter(frame => frame.MessageType === 'UserUpdated'), [], 'Profile image mutations have no UserUpdated notification.');
  });
  const policySource = await fetchResponse(`/Users/${userId}`);
  const policy = { ...(await policySource.json()).Policy, EnableUserPreferenceAccess: false };
  const restrict = await fetchResponse(`/Users/${userId}/Policy`, { method: 'POST', contentType: 'application/json', body: JSON.stringify(policy) });
  assert.equal(restrict.status, 204);
  await restrict.arrayBuffer();
  await record(['restricted own upload', '/UserImage', image(imageA, userToken), 403]);
  await record(['restricted own delete', '/UserImage', { method: 'DELETE', token: userToken }, 403]);
  return { results, userId, profileReadbacks, expectedImageHash: sha(imageB), expectedSecondBackdropHash: sha(imageA) };
}

function shippedArtworkResponses(results) {
  // The designated Native bundle also loads OMDb. R14 ships TMDB artwork in Node.
  const nativeOmdb = 'The Open Movie Database';
  return results.map(result => {
    if (result.name === 'remote image providers') {
      return { ...result, body: result.body.filter(provider => provider.Name !== nativeOmdb) };
    }
    if (result.name === 'remote image provider with no eligible results') {
      return { ...result, body: { ...result.body, Providers: result.body.Providers.filter(name => name !== nativeOmdb) } };
    }
    return result;
  });
}

async function persisted(database, root, { userId, expectedImageHash, expectedSecondBackdropHash }) {
  const backdrops = database.dialect === 'postgres' ? await readItemImageRows(database, movieId)
    // Native's SQLite rows use freshly generated GUIDs. Compare the files the HTTP indexes selected.
    : (await database.rows('BaseItemImageInfos', { where: { ItemId: movieId } })).toSorted((a, b) => a.Path.localeCompare(b.Path));
  assert.deepEqual(backdrops.map(row => row.ImageType), [2, 2]);
  assert.deepEqual(backdrops.map(row => path.basename(row.Path)), ['backdrop.png', 'backdrop1.png']);
  const [profile] = await database.rows('ImageInfos', { where: { UserId: nativeGuid(userId) } });
  assert.ok(profile);
  const result = [];
  for (const { name, filename, expectedHash } of [
    { name: 'first backdrop', filename: backdrops[0].Path, expectedHash: expectedImageHash },
    { name: 'second backdrop', filename: backdrops[1].Path, expectedHash: expectedSecondBackdropHash },
    { name: 'profile', filename: profile.Path, expectedHash: expectedImageHash },
  ]) {
    const relative = path.relative(root, filename);
    assert.ok(relative && !relative.startsWith('..'), filename);
    const bytes = await readFile(filename);
    assert.equal(sha(bytes), expectedHash);
    result.push({ name, path: relative, sha256: sha(bytes) });
  }
  const chapters = (await database.rows('Chapters', { where: { ItemId: movieId } })).sort((left, right) => left.ChapterIndex - right.ChapterIndex);
  assert.deepEqual(chapters.map(value => value.ImageDateModified), [fixedDate, fixedDate], 'The native chapter records retain their image fields.');
  const chapterFile = await readFile(chapters[0].ImagePath);
  assert.equal(sha(chapterFile), expectedImageHash);
  await assert.rejects(() => readFile(chapters[1].ImagePath), { code: 'ENOENT' });
  result.push({ name: 'chapters', paths: chapters.map(chapter => path.relative(root, chapter.ImagePath)), firstSha256: sha(chapterFile), secondMissing: true });
  return result;
}

test('image management matches designated Native HTTP and leaves the same ordered files for cold readers', {
  skip: !enabled, timeout: 300000,
}, nativeCase(async (t, port) => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'image-management-' + randomUUID()));
  await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), nodeRoot = path.join(root, 'node');
  const origin = `http://127.0.0.1:${port}`;
  const report = {};
  let current, native, database, runtime, remoteArtwork, stopped, primary;
  const stopNative = async () => {
    if (!native || stopped) return;
    stopped = true;
    report.nativeShutdown = await native.stop(async () => {
      const response = await fetch(origin + '/System/Shutdown', { method: 'POST',
        headers: { Authorization: authorization(current.accessToken), Connection: 'close' }, signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer();
      return response.status;
    }, () => portAvailable(port));
    assert.equal(report.nativeShutdown.cleanShutdown, true);
    assert.equal(report.nativeShutdown.pidGone, true);
    assert.equal(report.nativeShutdown.portAvailable, true);
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    report.reference = current.preparation;
    report.sources = await current.sourceBindings(['Jellyfin.Api/Controllers/ImageController.cs',
      'Jellyfin.Api/Controllers/RemoteImageController.cs', 'Jellyfin.Api/Controllers/ItemLookupController.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Providers/Manager/ImageSaver.cs',
      'MediaBrowser.Providers/Manager/ProviderManager.cs',
      'Jellyfin.Server.Implementations/Users/UserManager.cs', 'Jellyfin.Server.Implementations/Events/Consumers/Users/UserUpdatedNotifier.cs']);
    remoteArtwork = await startRemoteArtworkFixture(t.signal);
    const node = await seed(nodeRoot, current, port), reference = await seed(referenceRoot, current, port);
    database = await createPostgresTestDatabase(null, 'image_write_http');
    const snapshot = new SqliteDatabase(node.databasePath, { readOnly: true, requireMigrationHistory: true });
    try { await transferDatabase(snapshot, database, { instanceBinding: {
      serverId: node.settings.serverId, originIdentityDigest: sha(await readFile(node.databasePath)),
    } }); } finally { snapshot.close(); }
    native = current.start({ referenceRoot, outputRoot: root, label: 'native', origin });
    await native.ready();
    report.nativePartial = [];
    report.native = await scenario(origin, current.accessToken, t.signal, output, remoteArtwork.url, report.nativePartial);
    delete report.nativePartial;
    await stopNative();
    const saved = new SqliteDatabase(reference.databasePath, { readOnly: true, requireMigrationHistory: true });
    try { report.nativePersisted = await persisted(saved, referenceRoot, report.native); }
    finally { saved.close(); }
    const storageConfiguration = path.join(nodeRoot, 'storage-fixture.json');
    await writeFile(storageConfiguration, JSON.stringify({
      instances: [{ id: 'fixture-media', type: 'local', config: { root: node.media, writable: true } }],
      mounts: [{ path: '/fixture-media', instanceId: 'fixture-media', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true } }],
      prefixes: [{ identityRoot: node.media, accessRoot: '/fixture-media', style: process.platform === 'win32' ? 'windows' : 'posix',
        returnAccess: 'isolated image writer media', purpose: 'library' }],
    }));
    report.nodeErrors = [];
    runtime = await createTestRuntime({ ...node.settings, database, storageConfiguration, onError: error => {
      if (report.nodeErrors.length === 16) return;
      const sanitized = output.publicError(error);
      report.nodeErrors.push({ name: sanitized.name, code: sanitized.code, message: sanitized.message, stack: sanitized.stack });
    } });
    const nodeOrigin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    report.nodePartial = [];
    report.node = await scenario(nodeOrigin, current.accessToken, t.signal, output, remoteArtwork.url, report.nodePartial);
    delete report.nodePartial;
    await runtime.close();
    runtime = undefined;
    const cold = await PostgresDatabase.open({ schema: database.schemaName, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES });
    try { report.nodePersisted = await persisted(cold, nodeRoot, report.node); }
    finally { await cold.close(); }
    assert.deepEqual(report.node.results, shippedArtworkResponses(report.native.results));
    assert.deepEqual(report.node.profileReadbacks, report.native.profileReadbacks);
    assert.deepEqual(remoteArtwork.requests, Array.from({ length: 2 }, () => ({ method: 'GET', path: '/poster.png' })));
    assert.deepEqual(report.nodePersisted, report.nativePersisted);
  } catch (error) { primary = output.publicError(error); throw primary; }
  finally {
    const errors = [];
    for (const cleanup of [stopNative, () => runtime?.close(), () => remoteArtwork?.close(), () => dropPostgresTestDatabase(database), () => current?.finish()]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try {
      await writeFile(path.join(root, 'observations.json'), filterEvidenceJson({ ...report, remoteRequests: remoteArtwork?.requests }));
      await output.publishAndClose();
    } catch (error) { errors.push(output.publicError(error)); }
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, 'Image management fixture cleanup failed.', { cause: primary });
  }
}));
