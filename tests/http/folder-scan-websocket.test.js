import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';
import { refreshProgressThrottleMs } from '../../src/sessions/refresh-progress-notifier.js';
import { dateText } from '../../src/library/records.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

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

async function collectLibraryChanges(messages, expectedAddedIds, observe, timeoutMs = 4000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  const fields = ['FoldersAddedTo', 'FoldersRemovedFrom', 'ItemsAdded', 'ItemsRemoved', 'ItemsUpdated', 'CollectionFolders'];
  const combined = Object.fromEntries(fields.map(field => [field, new Set()]));
  let lastMessageAt = 0;
  let firstWindowRecorded = false;
  const snapshot = () => Object.fromEntries(fields.map(field => [field, [...combined[field]]]));
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
    if (!firstWindowRecorded && Date.now() - startedAt >= 4000) {
      firstWindowRecorded = true;
      observe({ phase: 'first-window', startedAt, observedAt: Date.now(), value: snapshot() });
    }
    if (expectedAddedIds.every(id => combined.ItemsAdded.has(id)) && lastMessageAt && Date.now() - lastMessageAt >= 100) break;
    await delay(10);
  } while (Date.now() < deadline);
  observe({ phase: 'complete', startedAt, observedAt: Date.now(), timeoutMs, expectedAddedIds, value: snapshot() });
  return snapshot();
}

async function connect(origin, token, observe) {
  const socket = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${token}`);
  const messages = [];
  socket.on('message', bytes => {
    const bodyText = bytes.toString();
    observe({ receivedAt: Date.now(), bodyText });
    messages.push(parseLosslessJson(bodyText));
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await nextMessage(messages, 'ForceKeepAlive');
  return { socket, messages };
}

test('elevated folder Refresh scans folders and an ordinary root movie, then publishes progress and library changes', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const output = path.join(validationOutputRoot(), 'folder-scan-websocket-' + randomUUID());
  await mkdir(output, { recursive: true });
  const observation = { scope: 'Actual scan events, complete WebSocket wire bodies, per-user SQL projections and observed delivery windows.',
    wire: { admin: [], reader: [] }, libraryEvents: [], projections: [], deliveryWindows: [] };
  t.after(() => writeFile(path.join(output, 'candidate.json'), JSON.stringify(observation,
    (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' }));
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
  let blockValidationListing = false;
  let validationListingBlocked = false;
  adapter.listPage = async (...args) => {
    if (blockValidationListing) {
      blockValidationListing = false;
      validationListingBlocked = true;
      enteredListing();
      await listingReleased;
    }
    return listPage(...args);
  };

  const errors = [];
  const runtime = await createTestRuntime({ database, vfs, identityMap,
    ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap, identityRoots: [physicalPath] }),
    programDataPath: stateRoot,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryUpdateDuration: 0 },
    serverId: 'folder-scan-websocket-test', onError: error => errors.push(error) });
  runtime.library.options.userRoot = item(ids.root, 'UserRootFolder', { Name: 'Media Folders', IsFolder: true });
  for (const type of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
    const listener = event => observation.libraryEvents.push({ type, observedAt: Date.now(),
      item: Object.fromEntries(['Id', 'NativeType', 'Name', 'Path', 'ParentId', 'SourceType', 'IsFolder']
        .map(name => [name, event.Item[name]])) });
    runtime.library.on(type, listener);
    t.after(() => runtime.library.off(type, listener));
  }
  const projectChanges = runtime.library.getLibraryUpdateInfo;
  runtime.library.getLibraryUpdateInfo = async function (changes, options) {
    const entry = { startedAt: Date.now(), userId: options.user.Id,
      changes: Object.fromEntries(Object.entries(changes).map(([name, values]) => [name, values.map(item => item.Id)])) };
    observation.projections.push(entry);
    try { const result = await projectChanges.call(this, changes, options); entry.result = result; return result; }
    catch (error) { entry.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
    finally { entry.settledAt = Date.now(); }
  };
  t.after(() => runtime.close());
  // ProviderManager refreshes the folder's own metadata before ValidateChildren.
  // Hold an actual validation listing after its RefreshStarted event; holding
  // the earlier metadata listing would prevent that event from being emitted.
  const onRefreshStarted = event => {
    if (!validationListingBlocked && guidN(event.Item.Id) === guidN(ids.physical)) {
      blockValidationListing = true;
    }
  };
  runtime.refreshes.on('RefreshStarted', onRefreshStarted);
  t.after(() => runtime.refreshes.off('RefreshStarted', onRefreshStarted));
  assert.equal(runtime.libraryScanner.capabilities.completeLibraryScan, true);
  assert.equal(runtime.libraryScanner.capabilities.scope, 'aggregate-folder-validation');
  assert.equal(runtime.libraryScanner.capabilities.scansMediaFiles, true);
  assert.equal(runtime.libraryScanner.capabilities.resolvesProductionMediaFiles, true);
  assert.deepEqual(runtime.libraryScanner.capabilities.productionMediaScopes,
    ['playlist-files-and-logical-directories', 'book-files-and-single-file-directories', 'photos-and-homevideos-photo-albums',
      'tv-ordinary-video-files', 'music-ordinary-tracks-and-conventional-albums',
      'ordinary-movies-homevideos-and-musicvideos', 'audiobook-files-and-single-file-directories']);
  assert.equal(runtime.libraryScanner.capabilities.relationshipRows, true);
  assert.equal(runtime.libraryScanner.capabilities.structuralCompletenessProof, true);
  assert.equal(runtime.libraryScanner.capabilities.directStructuralRoots, true);
  assert.equal(runtime.libraryScanner.capabilities.typeReclassification, true);
  assert.equal(runtime.libraryScanner.capabilities.secondaryOwnershipTransfer, true);
  assert.equal(runtime.libraryScanner.capabilities.groupedOwnership, true);
  assert.equal(runtime.libraryScanner.capabilities.runsPostScanTasks, true);
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

    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    const adminSocket = await connect(origin, adminLogin.AccessToken, value => observation.wire.admin.push(value));
    const readerSocket = await connect(origin, readerLogin.AccessToken, value => observation.wire.reader.push(value));
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
    await runtime.metadata.drain();
    const rows = await database.rows('BaseItems');
    observation.afterScan = rows;
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
    // Each native scan addition has its own notification batch. Completion of
    // the movie's batch does not imply that the nested folder's batch arrived.
    const expectedAddedIds = [movie, ...rows.filter(row => row.Path !== physicalPath && scannedPaths.includes(row.Path))]
      .map(row => guidN(row.Id));
    const changed = await collectLibraryChanges(readerSocket.messages, expectedAddedIds, value => observation.deliveryWindows.push(value));
    assert.deepEqual(changed.ItemsAdded.toSorted(), expectedAddedIds.toSorted(), JSON.stringify(changed));
    assert.ok(changed.CollectionFolders.includes(guidN(ids.collection)), JSON.stringify(changed));
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
