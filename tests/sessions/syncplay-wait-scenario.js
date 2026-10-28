import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

export async function recordSyncPlayWait(origin) {
  const actors = {}, records = [], raw = [], sockets = [];
  async function call(route, actor, body) {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `MediaBrowser Client="SyncPlayWait", Device="Isolated", DeviceId="sync-wait-${actor}", Version="1"${actors[actor]?.token ? `, Token="${actors[actor].token}"` : ''}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : stringifyNativeJson(body) });
    const text = await response.text(); let value = text; try { value = parseLosslessJson(text); } catch {}
    return { status: response.status, body: value };
  }
  async function step(name, route, actor, body) {
    const response = await call(route, actor, body); await delay(70);
    records.push({ name, ...response, messages: Object.fromEntries(Object.entries(actors).map(([key, value]) => [key, value.messages.splice(0)])) });
    return response.body;
  }
  try {
    for (const actor of ['playing', 'paused']) {
      const login = await call('/Users/AuthenticateByName', actor, { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' }); assert.equal(login.status, 200);
      actors[actor] = { token: login.body.AccessToken, messages: [] };
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/socket?ApiKey=${login.body.AccessToken}`); sockets.push(ws);
      ws.on('message', bytes => { const message = parseLosslessJson(bytes.toString()); raw.push({ actor, message }); if (message.MessageType.startsWith('SyncPlay')) actors[actor].messages.push(message); });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    }
    for (const actor of ['playing', 'paused']) {
      const group = await step(`create-${actor}`, '/SyncPlay/New', actor, { GroupName: actor }); actors[actor].groupId = group.GroupId;
      await step(`queue-${actor}`, '/SyncPlay/SetNewQueue', actor, { PlayingQueue: ['22222222222222222222222222222222'], StartPositionTicks: 123456789 });
      actors[actor].playlistId = records.at(-1).messages[actor].find(message => message.Data.Type === 'PlayQueue').Data.Data.Playlist[0].PlaylistItemId;
      if (actor === 'paused') await step('pause-waiting', '/SyncPlay/Pause', actor, {});
    }
    const started = performance.now();
    await step('repeat-buffer-keeps-deadline', '/SyncPlay/Buffering', 'playing', { PlaylistItemId: actors.playing.playlistId });
    await delay(31500);
    const waitedMs = performance.now() - started;
    await step('playing-timeout', `/SyncPlay/${actors.playing.groupId}`, 'playing');
    await step('paused-timeout', `/SyncPlay/${actors.paused.groupId}`, 'paused');
    await step('late-buffer-ignored', '/SyncPlay/Buffering', 'playing', { PlaylistItemId: actors.playing.playlistId });
    await step('late-ready-resumes-client', '/SyncPlay/Ready', 'playing', { PlaylistItemId: actors.playing.playlistId });
    await step('new-item-restores-wait', '/SyncPlay/SetPlaylistItem', 'playing', { PlaylistItemId: actors.playing.playlistId });
    await step('waiting-again', `/SyncPlay/${actors.playing.groupId}`, 'playing');
    assert.equal(records.find(entry => entry.name === 'playing-timeout').body.State, 'Playing');
    assert.equal(records.find(entry => entry.name === 'paused-timeout').body.State, 'Paused');
    assert.equal(records.at(-1).body.State, 'Waiting');
    return { records, raw, waitedMs };
  } finally { for (const ws of sockets) ws.terminate(); }
}
