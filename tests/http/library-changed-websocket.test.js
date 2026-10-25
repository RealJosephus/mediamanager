import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';

const ids = {
  root: '42000000-0000-0000-0000-000000000001',
  collection: '42000000-0000-0000-0000-000000000002',
  folder: '42000000-0000-0000-0000-000000000003',
  movie: '42000000-0000-0000-0000-000000000004'
};

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
    column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
}

function item(Id, Type, values = {}) {
  return { ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type.split('.').at(-1),
    CleanName: Type.toLowerCase(), SortName: Type.toLowerCase(), MediaType: 'Unknown', Data: '{}', ...values };
}

async function nextMessage(messages, type, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const index = messages.findIndex(message => message.MessageType === type);
    if (index >= 0) return messages.splice(index, 1)[0];
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Missing ${type} WebSocket message.`);
}

async function connect(origin, token) {
  const socket = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${token}`);
  const messages = [];
  socket.on('message', bytes => messages.push(parseLosslessJson(bytes.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await nextMessage(messages, 'ForceKeepAlive');
  return { socket, messages };
}

test('PostgreSQL: committed metadata refresh publishes LibraryChanged through the runtime WebSocket',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const schema = `library_changed_ws_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
    const storage = new StorageRegistry();
    storage.registerType('memory', () => new MemoryStorageAdapter());
    const adapter = await storage.createInstance('fixture', 'memory', {});
    const vfs = new VirtualFileSystem(storage);
    vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: 'Z:\\LibraryChanged', accessRoot: '/fixture', style: 'windows', returnAccess: 'library changed test' });
    const errors = [];
    const runtime = await createTestRuntime({ database, vfs, identityMap,
      ignoreIdentityMap: await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap,
        identityRoots: ['Z:\\LibraryChanged'] }), configuration: {
      UICulture: 'en-US', IsStartupWizardCompleted: true, LibraryUpdateDuration: 0
    }, serverId: 'library-changed-websocket-test', onError: error => errors.push(error) });
    let socket;
    try {
      await database.insert('BaseItems', item(ids.root, 'UserRootFolder', { Name: 'Media Folders', IsFolder: true }));
      await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', { Name: 'Movies', IsFolder: true, ParentId: ids.root,
        Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.folder] }) }));
      await database.insert('BaseItems', item(ids.folder, 'Folder', { Name: 'Physical movies', Path: 'Z:\\LibraryChanged', IsFolder: true }));
      await database.insert('BaseItems', item(ids.movie, 'Movies.Movie', { Name: 'Changed movie', Path: 'Z:\\LibraryChanged\\movie.mkv',
        ParentId: ids.folder, TopParentId: ids.folder, MediaType: 'Video', RunTimeTicks: 600000000n,
        DateLastSaved: '2000-01-01 00:00:00' }));
      await adapter.write('/movie.mkv', Buffer.from('library changed fixture'));

      const created = await runtime.users.createUser({ Name: 'Library change admin', Password: 'password' });
      await runtime.users.updatePolicy(created.Id, { ...(await runtime.users.getUser(created.Id)).Policy, IsAdministrator: true });
      const login = await runtime.authentication.login({ Username: 'Library change admin', Pw: 'password' }, {
        Client: 'LibraryChangedTest', Device: 'Device', DeviceId: 'library-changed-device', Version: '1.0'
      }, { remoteEndPoint: '127.0.0.1' });
      const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
      const connected = await connect(origin, login.AccessToken);
      ({ socket } = connected);
      const { messages } = connected;

      assert.equal(runtime.metadata.updates, runtime.metadataUpdates);
      assert.equal(runtime.images.metadataUpdates, runtime.metadataUpdates);
      const before = (await database.rows('BaseItems', { where: { Id: ids.movie } }))[0].DateLastSaved;
      const response = await fetch(`${origin}/Items/${ids.movie}/Refresh?metadataRefreshMode=None&imageRefreshMode=None&replaceAllMetadata=true`, {
        method: 'POST', headers: { Authorization: `MediaBrowser Token="${login.AccessToken}"` }
      });
      assert.equal(response.status, 204);
      const message = await nextMessage(messages, 'LibraryChanged');
      const after = (await database.rows('BaseItems', { where: { Id: ids.movie } }))[0].DateLastSaved;
      assert.notEqual(after, before, 'the notification follows the committed metadata update');
      assert.deepEqual(Object.keys(message).toSorted(), ['Data', 'MessageId', 'MessageType']);
      assert.match(message.MessageId, /^[0-9a-f]{32}$/);
      assert.deepEqual(message.Data, {
        FoldersAddedTo: [], FoldersRemovedFrom: [], ItemsAdded: [], ItemsRemoved: [],
        ItemsUpdated: [guidN(ids.movie)], CollectionFolders: []
      });
      assert.deepEqual(errors, []);
    } finally {
      const closing = runtime.close();
      try {
        await Promise.race([closing, delay(3000).then(() => { throw new Error('Runtime close timed out with an open WebSocket.'); })]);
      } catch (error) {
        socket?.terminate();
        await closing;
        throw error;
      }
      await storage.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try {
      await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
    } finally { await cleanup.close(); }
    }
  });
