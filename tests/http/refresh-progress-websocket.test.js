import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';

const ids = {
  root: '43000000-0000-0000-0000-000000000001',
  aggregate: '43000000-0000-0000-0000-000000000002',
  collection: '43000000-0000-0000-0000-000000000003',
  first: '43000000-0000-0000-0000-000000000004',
  second: '43000000-0000-0000-0000-000000000005',
  movie: '43000000-0000-0000-0000-000000000006'
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

test('PostgreSQL: provider refresh lifecycle publishes unsolicited admin RefreshProgress messages',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const schema = `refresh_progress_ws_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
    const errors = [];
    const runtime = await createTestRuntime({ database, configuration: {
      UICulture: 'en-US', IsStartupWizardCompleted: true
    }, serverId: 'refresh-progress-websocket-test', onError: error => errors.push(error) });
    const sockets = [];
    try {
      await database.insert('BaseItems', item(ids.root, 'UserRootFolder', { Name: 'Media Folders', IsFolder: true }));
      await database.insert('BaseItems', item(ids.aggregate, 'AggregateFolder', { Name: 'Aggregate', IsFolder: true }));
      await database.insert('BaseItems', item(ids.collection, 'CollectionFolder', { Name: 'Movies', IsFolder: true, ParentId: ids.root,
        Data: JSON.stringify({ CollectionType: 'movies', PhysicalLocationsList: ['Z:\\First', 'Z:\\Second'],
          PhysicalFolderIds: [ids.first, ids.second] }) }));
      await database.insert('BaseItems', item(ids.first, 'Folder', { Name: 'First', IsFolder: true, ParentId: ids.aggregate,
        TopParentId: ids.first, Path: 'Z:\\First' }));
      await database.insert('BaseItems', item(ids.second, 'Folder', { Name: 'Second', IsFolder: true, ParentId: ids.aggregate,
        TopParentId: ids.second, Path: 'Z:\\Second' }));
      await database.insert('BaseItems', item(ids.movie, 'Movies.Movie', { Name: 'Movie', ParentId: ids.first,
        TopParentId: ids.first, Path: 'Z:\\First\\movie.mkv', MediaType: 'Video' }));

      const admin = await runtime.users.createUser({ Name: 'Refresh admin', Password: 'password' });
      await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
      const reader = await runtime.users.createUser({ Name: 'Refresh reader', Password: 'password' });
      const login = async (name, device) => runtime.authentication.login({ Username: name, Pw: 'password' }, {
        Client: 'RefreshProgressTest', Device: 'Device', DeviceId: device, Version: '1.0'
      }, { remoteEndPoint: '127.0.0.1' });
      const adminLogin = await login('Refresh admin', 'refresh-admin-device');
      const readerLogin = await login('Refresh reader', 'refresh-reader-device');
      const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
      const adminSocket = await connect(origin, adminLogin.AccessToken);
      const readerSocket = await connect(origin, readerLogin.AccessToken);
      sockets.push(adminSocket.socket, readerSocket.socket);

      const first = await runtime.library.getItemRecord(ids.first);
      const second = await runtime.library.getItemRecord(ids.second);
      const movie = await runtime.library.getItemRecord(ids.movie);
      runtime.refreshes.reportStarted(first);
      const startedItem = await nextMessage(adminSocket.messages, 'RefreshProgress');
      const startedCollection = await nextMessage(adminSocket.messages, 'RefreshProgress');
      assert.deepEqual(startedItem.Data, { ItemId: guidN(ids.first), Progress: '0' });
      assert.deepEqual(startedCollection.Data, { ItemId: guidN(ids.collection), Progress: '0' });
      for (const message of [startedItem, startedCollection]) {
        assert.deepEqual(Object.keys(message).toSorted(), ['Data', 'MessageId', 'MessageType']);
        assert.match(message.MessageId, /^[0-9a-f]{32}$/);
      }
      assert.notEqual(startedItem.MessageId, startedCollection.MessageId, 'each native session send has its own message id');

      runtime.refreshes.reportStarted(second);
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.second), Progress: '0' });
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.collection), Progress: '0' });

      runtime.refreshes.reportCompleted(first);
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.first), Progress: '100' });
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.collection), Progress: '0' });
      runtime.refreshes.reportCompleted(second);
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.second), Progress: '100' });
      assert.deepEqual((await nextMessage(adminSocket.messages, 'RefreshProgress')).Data,
        { ItemId: guidN(ids.collection), Progress: '0' });

      runtime.refreshes.reportStarted(movie);
      runtime.refreshes.reportCompleted(movie);
      await delay(75);
      assert.equal(adminSocket.messages.some(message => message.MessageType === 'RefreshProgress'), false,
        'ordinary metadata items are not refresh progress producers');
      assert.equal(readerSocket.messages.some(message => message.MessageType === 'RefreshProgress'), false,
        'a non-administrator receives no refresh progress without or with subscriptions');
      assert.deepEqual(errors, []);
    } finally {
      const closing = runtime.close();
      try {
        await Promise.race([closing, delay(3000).then(() => { throw new Error('Runtime close timed out with open WebSockets.'); })]);
      } catch (error) {
        for (const socket of sockets) socket.terminate();
        await closing;
        throw error;
      }
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try {
      await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
    } finally { await cleanup.close(); }
    }
  });
