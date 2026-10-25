import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';

const folderId = '41000000-0000-0000-0000-000000000001';
const movieId = '41000000-0000-0000-0000-000000000002';

function item(overrides) {
  const defaults = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-09-27 00:00:00' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
  return { ...defaults, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Folder', CleanName: 'folder', SortName: 'folder',
    Data: '{}', MediaType: 'Unknown', Path: 'Z:\\UserData', IsFolder: true, ...overrides };
}

async function connect(origin, token) {
  const ws = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${token}`);
  const messages = [];
  ws.on('message', bytes => messages.push(parseLosslessJson(bytes.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await nextMessage(messages, 'ForceKeepAlive');
  return { ws, messages };
}

async function nextMessage(messages, type, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  do {
    const index = messages.findIndex(message => message.MessageType === type);
    if (index >= 0) return messages.splice(index, 1)[0];
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Missing ${type} WebSocket message.`);
}

function userDataWebSocketTest(name, run) {
  test(`PostgreSQL: ${name}`, { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, run);
}

userDataWebSocketTest('UserDataChanged WebSocket batches fresh item and parent data and targets primary or additional user sessions', async () => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `userdata_ws_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const errors = [];
  const runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'user-data-websocket-test', onError: error => errors.push(error) });
  const sockets = [];
  try {
    await database.insert('BaseItems', item({ Id: folderId }));
    await database.insert('BaseItems', item({ Id: movieId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Movie', CleanName: 'movie',
      SortName: 'movie', MediaType: 'Video', Path: 'Z:\\UserData\\movie.mkv', IsFolder: false, ParentId: folderId, TopParentId: folderId, RunTimeTicks: 100000000000n }));
    const firstUser = await runtime.users.createUser({ Name: 'SocketFirst', Password: 'password' });
    const secondUser = await runtime.users.createUser({ Name: 'SocketSecond', Password: 'password' });
    const login = (name, deviceId) => runtime.authentication.login({ Username: name, Pw: 'password' },
      { Client: 'UserDataSocketTest', Device: 'Device', DeviceId: deviceId, Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const firstLogin = await login('SocketFirst', 'user-data-first');
    const secondLogin = await login('SocketSecond', 'user-data-second');
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    const first = await connect(origin, firstLogin.AccessToken); sockets.push(first.ws);
    const second = await connect(origin, secondLogin.AccessToken); sockets.push(second.ws);

    const reasons = [];
    runtime.userData.on('UserDataSaved', event => reasons.push(event.SaveReason));
    const update = body => fetch(`${origin}/UserItems/${movieId}/UserData`, { method: 'POST', headers: {
      Authorization: `MediaBrowser Client="UserDataSocketTest", Device="Device", DeviceId="user-data-first", Version="1.0", Token="${firstLogin.AccessToken}"`,
      'Content-Type': 'application/json'
    }, body: stringifyNativeJson(body) });

    const updateResponse = await update({ IsFavorite: true, Likes: true });
    assert.equal(updateResponse.status, 200);
    const updateData = parseLosslessJson(await updateResponse.text());
    assert.equal(updateData.IsFavorite, true);
    assert.equal(updateData.Likes, true);
    assert.equal(updateData.Rating, 10);
    const firstChange = await nextMessage(first.messages, 'UserDataChanged');
    await delay(75);
    assert.equal(first.messages.some(message => message.MessageType === 'UserDataChanged'), false, 'rapid changes share one fixed-window batch');
    assert.equal(second.messages.some(message => message.MessageType === 'UserDataChanged'), false, 'unrelated users do not receive the batch');
    assert.deepEqual(Object.keys(firstChange).toSorted(), ['Data', 'MessageId', 'MessageType']);
    assert.match(firstChange.MessageId, /^[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(firstChange.Data).toSorted(), ['UserDataList', 'UserId']);
    assert.equal(firstChange.Data.UserId, guidN(firstUser.Id));
    assert.deepEqual(firstChange.Data.UserDataList.map(dto => dto.ItemId).toSorted(), [guidN(movieId), guidN(folderId)].toSorted());
    const movieData = firstChange.Data.UserDataList.find(dto => dto.ItemId === guidN(movieId));
    const folderData = firstChange.Data.UserDataList.find(dto => dto.ItemId === guidN(folderId));
    assert.deepEqual(movieData, parseLosslessJson(stringifyNativeJson(await runtime.userData.get(firstUser.Id, movieId))));
    assert.deepEqual(folderData, parseLosslessJson(stringifyNativeJson(await runtime.userData.get(firstUser.Id, folderId))));
    assert.equal(movieData.IsFavorite, true);
    assert.equal(movieData.Likes, true, 'DTO values are loaded when the batch is flushed');
    assert.equal(movieData.Rating, 10, 'Likes is persisted through the native personal-rating mapping');
    assert.deepEqual(reasons, ['UpdateUserData']);

    first.messages.length = 0; second.messages.length = 0;
    const movie = await runtime.library.getItemRecord(movieId);
    await runtime.userData.playback(await runtime.users.getUser(firstUser.Id), movie, 'progress', { PositionTicks: 6000000000n });
    await delay(650);
    assert.equal(first.messages.some(message => message.MessageType === 'UserDataChanged'), false, 'PlaybackProgress is excluded before a timer starts');

    await runtime.sessions.addUser(firstLogin.SessionInfo.Id, secondUser.Id);
    await runtime.userData.setFavorite(secondUser.Id, movieId, true);
    const [additionalChange, ownChange] = await Promise.all([
      nextMessage(first.messages, 'UserDataChanged'), nextMessage(second.messages, 'UserDataChanged')
    ]);
    assert.equal(additionalChange.Data.UserId, guidN(secondUser.Id));
    assert.equal(ownChange.Data.UserId, guidN(secondUser.Id));
    assert.equal(additionalChange.MessageId, ownChange.MessageId, 'one native message id is shared across all target sessions');
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
