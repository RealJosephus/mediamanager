import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';
import { refreshProgressThrottleMs } from '../../src/sessions/refresh-progress-notifier.js';
import { dateText } from '../../src/library/records.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

const ids = {
  root: '44000000-0000-0000-0000-000000000001',
  aggregate: '44000000-0000-0000-0000-000000000002',
  collection: '44000000-0000-0000-0000-000000000003',
  physical: '44000000-0000-0000-0000-000000000004'
};
const physicalPath = 'Z:\\FolderScanWebSocket';
const moviePath = `${physicalPath}\\Feature Film (2024).mkv`;

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2026-09-27 00:00:00'
      : column.nullable ? null : type === 'bool' ? false : column.type === 'TEXT' ? '' : type === 'long' || type === 'uint' ? 0n : 0];
  }));
}

function item(Id, Type, values = {}) {
  return { ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type,
    CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(), MediaType: 'Unknown', Data: '{}', ...values };
}

async function nextMessage(messages, type, matches = () => true, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const index = messages.findIndex(message => message.MessageType === type && matches(message));
    if (index >= 0) return messages.splice(index, 1)[0];
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Missing matching ${type} WebSocket message.`);
}

async function collectLibraryChanges(messages, expectedAddedId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  const fields = ['FoldersAddedTo', 'FoldersRemovedFrom', 'ItemsAdded', 'ItemsRemoved', 'ItemsUpdated', 'CollectionFolders'];
  const combined = Object.fromEntries(fields.map(field => [field, new Set()]));
  let lastMessageAt = 0;
  do {
    let received = false;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.MessageType !== 'LibraryChanged') continue;
      messages.splice(index, 1);
      received = true;
      for (const field of fields) for (const id of message.Data[field] ?? []) combined[field].add(id);
    }
    if (received) lastMessageAt = Date.now();
    if (combined.ItemsAdded.has(expectedAddedId) && lastMessageAt && Date.now() - lastMessageAt >= 100) break;
    await delay(10);
  } while (Date.now() < deadline);
  return Object.fromEntries(fields.map(field => [field, [...combined[field]]]));
}

async function connect(origin, token) {
  const socket = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${token}`);
  const messages = [];
  socket.on('message', bytes => messages.push(parseLosslessJson(bytes.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await nextMessage(messages, 'ForceKeepAlive');
  return { socket, messages };
}

test('elevated folder Refresh scans folders and an ordinary root movie, then publishes progress and library changes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const database = await createPostgresTestDatabase(t, 'folder_scan_ws');
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'folder-scan-websocket-state-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(stateRoot)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(stateRoot).startsWith('folder-scan-websocket-state-'), true);
    await rm(stateRoot, { recursive: true, force: true });
  });
  const storage = new StorageRegistry();
  t.after(() => storage.close());
  storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('library', 'memory', {});
  await adapter.mkdir('/Alpha');
  await adapter.mkdir('/Alpha/Deep');
  await adapter.write('/Feature Film (2024).mkv', Buffer.from('ordinary physical-root movie'));
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/library', instanceId: 'library', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: physicalPath, accessRoot: '/library', style: 'windows', returnAccess: 'folder scan HTTP E2E' });

  let releaseListing;
  let enteredListing;
  const listingEntered = new Promise(resolve => { enteredListing = resolve; });
  const listingReleased = new Promise(resolve => { releaseListing = resolve; });
  const listPage = adapter.listPage.bind(adapter);
  let blockFirstListing = true;
  adapter.listPage = async (...args) => {
    if (blockFirstListing) {
      blockFirstListing = false;
      enteredListing();
      await listingReleased;
    }
    return listPage(...args);
  };

  const errors = [];
  const runtime = await createRuntime({ database, vfs, identityMap,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [physicalPath] }),
    programDataPath: stateRoot,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryUpdateDuration: 0 },
    serverId: 'folder-scan-websocket-test', onError: error => errors.push(error) });
  t.after(() => runtime.close());
  assert.equal(runtime.folderScanner.capabilities.completeLibraryScan, false);
  assert.equal(runtime.folderScanner.capabilities.scope, 'generic-folder-tree-reconciliation');
  assert.equal(runtime.folderScanner.capabilities.scansMediaFiles, false);
  assert.equal(runtime.folderScanner.capabilities.resolvesProductionMediaFiles, true);
  assert.deepEqual(runtime.folderScanner.capabilities.productionMediaScopes,
    ['playlist-files-and-logical-directories', 'book-files-and-single-file-directories', 'photos-and-homevideos-photo-albums',
      'conventional-tv-series-season-single-episodes', 'conventional-music-artist-album-tracks',
      'ordinary-movies-homevideos-and-musicvideos', 'audiobook-files-and-single-file-directories']);
  assert.equal(runtime.folderScanner.capabilities.relationshipRows, false);
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, false);
  assert.equal(runtime.libraryScanner.capabilities.scope, 'physical-folder-root-coordination');
  assert.equal(runtime.libraryScanner.capabilities.scansMediaFiles, false);
  assert.equal(runtime.libraryScanner.capabilities.resolvesProductionMediaFiles, true);
  assert.deepEqual(runtime.libraryScanner.capabilities.productionMediaScopes,
    ['playlist-files-and-logical-directories', 'book-files-and-single-file-directories', 'photos-and-homevideos-photo-albums',
      'conventional-tv-series-season-single-episodes', 'conventional-music-artist-album-tracks',
      'ordinary-movies-homevideos-and-musicvideos', 'audiobook-files-and-single-file-directories']);
  assert.equal(runtime.libraryScanner.capabilities.relationshipRows, false);
  const sockets = [];
  try {
    await database.insert('BaseItems', item(ids.root, 'UserRootFolder', { Name: 'Media Folders', IsFolder: true }));
    await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder', { Name: 'Aggregate', IsFolder: true }));
    await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', { Name: 'Movies', IsFolder: true, ParentId: ids.root,
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalLocationsList: [physicalPath], PhysicalFolderIds: [ids.physical] }) }));
    await database.insert('BaseItems', item(ids.physical, 'Folder', { Name: 'Physical movies', IsFolder: true,
      ParentId: ids.aggregate, TopParentId: ids.physical, Path: physicalPath, Data: JSON.stringify({ SourceType: 'Library' }) }));
    await database.insert('AncestorIds', { ItemId: ids.physical, ParentItemId: ids.collection });

    const admin = await runtime.users.createUser({ Name: 'Scan admin', Password: 'password' });
    await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
    await runtime.users.createUser({ Name: 'Scan reader', Password: 'password' });
    const login = (Username, DeviceId) => runtime.authentication.login({ Username, Pw: 'password' }, {
      Client: 'FolderScanTest', Device: 'Device', DeviceId, Version: '1.0'
    }, { remoteEndPoint: '127.0.0.1' });
    const adminLogin = await login('Scan admin', 'folder-scan-admin');
    const readerLogin = await login('Scan reader', 'folder-scan-reader');

    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const adminSocket = await connect(origin, adminLogin.AccessToken);
    const readerSocket = await connect(origin, readerLogin.AccessToken);
    sockets.push(adminSocket.socket, readerSocket.socket);
    const refresh = token => fetch(`${origin}/Items/${ids.physical}/Refresh`, {
      method: 'POST', headers: { Authorization: `MediaBrowser Token="${token}"` }
    });

    assert.equal((await refresh(readerLogin.AccessToken)).status, 403);
    const response = await Promise.race([
      refresh(adminLogin.AccessToken),
      delay(2000).then(() => { throw new Error('Refresh response waited for the blocked folder listing.'); })
    ]);
    assert.equal(response.status, 204);
    await Promise.race([
      listingEntered,
      delay(2000).then(() => {
        throw new Error('Folder listing was not entered: ' + errors.map(error => error?.stack ?? String(error)).join('\n'));
      })
    ]);
    assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
      { ItemId: guidN(ids.physical), Progress: '0' });
    assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
      { ItemId: guidN(ids.collection), Progress: '0' });

    // Let an intermediate notification pass the native throttle before completion.
    await delay(refreshProgressThrottleMs + 50);
    releaseListing();
    await runtime.folderScanner.whenIdle();
    const rows = await database.rows('BaseItems');
    const scannedPaths = rows.filter(row => row.Type === 'MediaBrowser.Controller.Entities.Folder').map(row => row.Path).toSorted();
    assert.deepEqual(scannedPaths, [physicalPath, `${physicalPath}\\Alpha`, `${physicalPath}\\Alpha\\Deep`]);
    const movie = rows.find(row => row.Path === moviePath);
    assert.ok(movie);
    assert.equal(movie.Type, 'MediaBrowser.Controller.Entities.Movies.Movie');
    assert.equal(movie.Name, 'Feature Film');
    assert.equal(movie.MediaType, 'Video');
    assert.equal(movie.IsFolder, false);
    assert.equal(movie.IsMovie, false);
    assert.equal(movie.IsInMixedFolder, true);
    assert.equal(movie.ProductionYear, 2024);
    const serializedDateLastSaved = dateText(movie.DateLastSaved).replace(/(\.\d*?[1-9])0+Z$/u, '$1Z');
    assert.deepEqual(JSON.parse(movie.Data), {
      AdditionalParts: [], LocalAlternateVersions: [], LinkedAlternateVersions: [], SubtitleFiles: [], AudioFiles: [],
      HasSubtitles: false, IsPlaceHolder: false, VideoType: 'VideoFile', Size: 28, IsHD: false, IsShortcut: false,
      Width: 0, Height: 0, DateLastSaved: serializedDateLastSaved, RemoteTrailers: []
    });

    const intermediate = await nextMessage(adminSocket.messages, 'RefreshProgress', message =>
      message.Data?.ItemId === guidN(ids.physical) && Number(message.Data.Progress) > 0 && Number(message.Data.Progress) < 100);
    assert.deepEqual(Object.keys(intermediate.Data).toSorted(), ['ItemId', 'Progress']);
    assert.equal(typeof intermediate.Data.Progress, 'string');
    assert.ok(Number.isFinite(Number(intermediate.Data.Progress)));
    const completion = await nextMessage(adminSocket.messages, 'RefreshProgress', message =>
      message.Data?.ItemId === guidN(ids.physical) && message.Data.Progress === '100');
    const aggregate = await nextMessage(adminSocket.messages, 'RefreshProgress', message =>
      message.Data?.ItemId === guidN(ids.collection) && message.Data.Progress === '0');
    assert.deepEqual(completion.Data, { ItemId: guidN(ids.physical), Progress: '100' });
    assert.deepEqual(aggregate.Data, { ItemId: guidN(ids.collection), Progress: '0' });
    const changed = await collectLibraryChanges(readerSocket.messages, guidN(movie.Id));
    assert.ok(changed.ItemsAdded.includes(guidN(movie.Id)), JSON.stringify(changed));
    assert.ok(changed.ItemsAdded.length >= 3, JSON.stringify(changed));
    assert.ok(changed.CollectionFolders.includes(guidN(ids.collection)), JSON.stringify(changed));
    assert.deepEqual(errors, []);
  } finally {
    releaseListing();
    const closing = runtime.close();
    try {
      await Promise.race([closing, delay(3000).then(() => { throw new Error('Runtime close timed out with open WebSockets.'); })]);
    } catch (error) {
      for (const socket of sockets) socket.terminate();
      await closing;
      throw error;
    }
    await storage.close();
  }
});
