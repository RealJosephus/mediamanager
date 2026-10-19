import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

export async function recordSyncPlayAccess(origin) {
  const actors = {}, sockets = [], records = [], raw = [];
  async function call(route, actor = 'admin', body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + route, { method, headers: { Authorization: `MediaBrowser Client="SyncPlayAccess", Device="Isolated", DeviceId="sync-access-${actor}", Version="1"${actors[actor]?.AccessToken ? `, Token="${actors[actor].AccessToken}"` : ''}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : stringifyNativeJson(body) });
    const text = await response.text(); let value = text; try { value = parseLosslessJson(text); } catch {}
    return { status: response.status, body: value };
  }
  async function login(actor, username = 'CoreFlowAdmin', password = 'isolated-core-flow-password') {
    const result = await call('/Users/AuthenticateByName', actor, { Username: username, Pw: password }); assert.equal(result.status, 200);
    actors[actor] = { ...result.body, messages: [] };
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/socket?ApiKey=${result.body.AccessToken}`); sockets.push(ws); actors[actor].ws = ws;
    ws.on('message', bytes => { const message = parseLosslessJson(bytes.toString()); raw.push({ actor, message }); if (message.MessageType.startsWith('SyncPlay')) actors[actor].messages.push(message); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  }
  async function step(name, route, actor, body, method) {
    const response = await call(route, actor, body, method); await delay(70);
    records.push({ name, ...response, messages: Object.fromEntries(Object.entries(actors).filter(([, value]) => value.messages).map(([key, value]) => [key, value.messages.splice(0)])) });
    return response.body;
  }
  const post = (name, route, actor, body) => step(name, `/SyncPlay/${route}`, actor, body, 'POST');
  const policy = async (actor, fields) => {
    const current = await call(`/Users/${actors[actor].User.Id}`);
    const result = await call(`/Users/${actors[actor].User.Id}/Policy`, 'admin', { ...current.body.Policy, ...fields }); assert.equal(result.status, 204);
  };
  try {
    await login('admin');
    for (const [actor, access] of [['member', 'CreateAndJoinGroups'], ['joiner', 'JoinGroups'], ['blocked', 'None']]) {
      const name = `SyncPlay_${actor}`;
      const created = await call('/Users/New', 'admin', { Name: name, Password: 'sync-password' }); assert.equal(created.status, 200);
      await login(actor, name, 'sync-password');
      await policy(actor, { SyncPlayAccess: access });
    }
    await login('member2', 'SyncPlay_member', 'sync-password');
    await step('none-list', '/SyncPlay/List', 'blocked'); await post('none-create', 'New', 'blocked', {}); await post('none-ping', 'Ping', 'blocked', {});
    await post('member-not-active', 'Pause', 'member'); await post('joiner-create', 'New', 'joiner', {});
    const group = (await post('member-create', 'New', 'member', { GroupName: 'Members' })).GroupId;
    await post('joiner-join', 'Join', 'joiner', { GroupId: group });
    await post('joiner-rejoin', 'Join', 'joiner', { GroupId: group });
    await post('other-session-user-active', 'Pause', 'member2');
    await policy('member', { SyncPlayAccess: 'None' });
    await post('active-none-create', 'New', 'member', {}); await step('active-none-list', '/SyncPlay/List', 'member');
    await post('active-none-ping', 'Ping', 'member', { Ping: 20 }); await post('active-none-pause', 'Pause', 'member');
    await post('active-none-other-session', 'Pause', 'member2');
    await post('active-none-join', 'Join', 'member2', { GroupId: group });
    await post('active-none-leave', 'Leave', 'member'); await post('inactive-none-ping', 'Ping', 'member', {});
    await post('joiner-leave', 'Leave', 'joiner'); await post('rejoin-counter-cleared', 'Pause', 'joiner');
    const mediaGroup = (await post('admin-media-group', 'New', 'admin', { GroupName: 'Media' })).GroupId;
    await post('media-queue', 'SetNewQueue', 'admin', { PlayingQueue: ['22222222222222222222222222222222'] });
    await policy('joiner', { BlockUnratedItems: ['Movie'] });
    await step('hidden-list', '/SyncPlay/List', 'joiner'); await step('hidden-get', `/SyncPlay/${mediaGroup}`, 'joiner');
    await post('hidden-join', 'Join', 'joiner', { GroupId: mediaGroup });
    await post('admin-clear', 'RemoveFromPlaylist', 'admin', { ClearPlaylist: true, ClearPlayingItem: true });
    await post('empty-queue-join', 'Join', 'joiner', { GroupId: mediaGroup });
    await post('participant-denies-new-queue', 'SetNewQueue', 'admin', { PlayingQueue: ['22222222222222222222222222222222'] });
    await post('participant-denies-add', 'Queue', 'admin', { ItemIds: ['33333333333333333333333333333333'] });
    await policy('admin', { SyncPlayAccess: 'None' });
    await post('admin-none-create', 'New', 'admin', { GroupName: 'Administrator' });
    await step('admin-none-list', '/SyncPlay/List', 'admin');
    await policy('admin', { SyncPlayAccess: 'CreateAndJoinGroups' });
    await call('/Auth/Keys?app=SyncPlayAccessTest', 'admin', undefined, 'POST');
    const keys = await call('/Auth/Keys'); actors.api = { AccessToken: keys.body.Items.find(entry => entry.AppName === 'SyncPlayAccessTest').AccessToken };
    await step('api-key-list', '/SyncPlay/List', 'api'); await post('api-key-create', 'New', 'api', { GroupName: 'API' });
    await post('api-key-leave', 'Leave', 'api');
    // Closing a user's final socket invokes SessionEnded and removes membership.
    const ws = actors.joiner.ws; ws.close(); await new Promise(resolve => ws.once('close', resolve)); await delay(150);
    await step('session-ended-removes-group', '/SyncPlay/List', 'admin');
    return { records, raw };
  } finally { for (const ws of sockets) ws.terminate(); }
}
