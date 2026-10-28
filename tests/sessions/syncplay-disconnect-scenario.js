import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const positionTicks = 123456789n;

// This consumer exercises the public disconnect path. It is not a frozen
// recording or a claim that a native instance ran alongside this scenario.
export async function recordSyncPlayDisconnect(origin) {
  const actors = {}, sockets = [], requests = [], raw = [], socketErrors = [];
  const header = actor => `MediaBrowser Client="SyncPlayDisconnect", Device="Isolated", DeviceId="sync-disconnect-${actor}", Version="1"${actors[actor]?.token ? `, Token="${actors[actor].token}"` : ''}`;
  const request = async (route, actor, body) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: header(actor), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : stringifyNativeJson(body) });
    const bodyText = await response.text();
    return { status: response.status, bodyText, body: bodyText === '' ? null : parseLosslessJson(bodyText) };
  };
  const call = async (route, actor, body, status) => {
    const result = await request(route, actor, body);
    requests.push({ route, actor, ...result }); assert.equal(result.status, status, route);
    return result;
  };
  const waitFor = async condition => {
    const deadline = performance.now() + 10000;
    while (!await condition()) {
      assert.ok(performance.now() < deadline, 'The public SyncPlay disconnect state did not settle.');
      await delay(20);
    }
  };
  const disconnect = async actor => {
    const socket = actors[actor].socket;
    const closed = once(socket, 'close'); socket.terminate(); await closed;
  };
  let waiting, playing, finalGroups;
  try {
    for (const actor of ['ready', 'buffering', 'observer']) {
      const login = await request('/Users/AuthenticateByName', actor, { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' });
      assert.equal(login.status, 200);
      actors[actor] = { token: login.body.AccessToken, messages: [] };
      if (actor === 'observer') continue;
      const socket = new WebSocket(`${origin.replace('http', 'ws')}/socket?ApiKey=${login.body.AccessToken}`); sockets.push(socket);
      actors[actor].socket = socket;
      socket.on('error', error => socketErrors.push({ message: error.message, code: error.code }));
      socket.on('message', bytes => {
        const message = parseLosslessJson(bytes.toString()); raw.push({ actor, message });
        actors[actor].messages.push(message);
      });
      await once(socket, 'open');
      await waitFor(() => actors[actor].messages.some(message => message.MessageType === 'ForceKeepAlive'));
    }
    const group = (await call('/SyncPlay/New', 'ready', { GroupName: 'Disconnect recovery' }, 200)).body;
    await call('/SyncPlay/Join', 'buffering', { GroupId: group.GroupId }, 204);
    await call('/SyncPlay/SetNewQueue', 'ready', { PlayingQueue: ['22222222222222222222222222222222'], StartPositionTicks: positionTicks }, 204);
    await waitFor(() => actors.ready.messages.some(message => message.Data?.Type === 'PlayQueue'));
    const playlist = actors.ready.messages.find(message => message.Data?.Type === 'PlayQueue').Data.Data;
    await call('/SyncPlay/Ready', 'ready', { PlaylistItemId: playlist.Playlist[0].PlaylistItemId,
      PositionTicks: positionTicks, When: '0001-01-01T00:00:00Z', IsPlaying: false }, 204);
    waiting = (await call(`/SyncPlay/${group.GroupId}`, 'observer', undefined, 200)).body;
    assert.equal(waiting.State, 'Waiting');
    const beforeDisconnect = actors.ready.messages.length;
    await disconnect('buffering');
    await waitFor(async () => {
      playing = (await call(`/SyncPlay/${group.GroupId}`, 'observer', undefined, 200)).body;
      return playing.State === 'Playing';
    });
    await waitFor(() => actors.ready.messages.slice(beforeDisconnect).some(message => message.Data?.Type === 'UserLeft')
      && actors.ready.messages.slice(beforeDisconnect).some(message => message.MessageType === 'SyncPlayCommand' && message.Data.Command === 'Unpause'));
    const recovery = actors.ready.messages.slice(beforeDisconnect);
    assert.ok(recovery.filter(message => message.MessageType === 'SyncPlayCommand').every(message => BigInt(message.Data.PositionTicks) === positionTicks));
    await disconnect('ready');
    await waitFor(async () => {
      finalGroups = (await call('/SyncPlay/List', 'observer', undefined, 200)).body;
      return finalGroups.length === 0;
    });
    assert.deepEqual(socketErrors, []);
    return { requests, raw, states: { waiting, playing, finalGroups },
      cleanup: { clientSocketsClosed: sockets.every(socket => socket.readyState === WebSocket.CLOSED) } };
  } finally {
    await Promise.all(sockets.map(socket => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise(resolve => socket.once('close', resolve)); socket.terminate(); return closed;
    }));
  }
}
