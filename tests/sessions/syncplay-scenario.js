import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const movie = '22222222222222222222222222222222', other = '33333333333333333333333333333333';
const missing = 'ffffffffffffffffffffffffffffffff', empty = '00000000000000000000000000000000';
export async function recordSyncPlay(origin) {
  const records = [], raw = [], actors = {}, sockets = [];
  const auth = (actor = 'a') => `MediaBrowser Client="SyncPlayTest", Device="Isolated", DeviceId="sync-${actor}", Version="1"${actors[actor]?.AccessToken ? `, Token="${actors[actor].AccessToken}"` : ''}`;
  async function request(route, { actor = 'a', method = 'GET', body, source, contentType = 'application/json' } = {}) {
    const response = await fetch(origin + route, { method, headers: { Authorization: auth(actor), ...(method === 'POST' ? { 'Content-Type': contentType } : {}) }, body: source ?? (body === undefined ? undefined : stringifyNativeJson(body)) });
    const text = await response.text(); let value = text; try { value = parseLosslessJson(text); } catch {}
    return { status: response.status, body: value };
  }
  async function socket(actor) {
    const messages = [], ws = new WebSocket(`${origin.replace('http', 'ws')}/socket?ApiKey=${actors[actor].AccessToken}`);
    sockets.push(ws);
    ws.on('message', bytes => {
      const message = parseLosslessJson(bytes.toString()); raw.push({ actor, message });
      if (message.MessageType.startsWith('SyncPlay')) messages.push(message);
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, messages };
  }
  async function step(name, route, options) {
    const response = await request(route, options);
    await delay(70);
    const messages = Object.fromEntries(Object.entries(actors).filter(([, actor]) => actor.socket).map(([key, actor]) => [key, actor.socket.messages.splice(0)]));
    const record = { name, ...response, messages }; records.push(record); return record;
  }
  const post = (name, path, body, actor = 'a') => step(name, `/SyncPlay/${path}`, { method: 'POST', actor, body });
  try {
    for (const actor of ['a', 'b', 'c']) {
      const login = await request('/Users/AuthenticateByName', { actor, method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' } });
      assert.equal(login.status, 200); actors[actor] = login.body;
    }
    for (const actor of ['a', 'b']) actors[actor].socket = await socket(actor);
    await step('public-clock', '/GetUtcTime', { actor: 'anonymous' });
    await step('anonymous-list', '/SyncPlay/List', { actor: 'anonymous' });
    await step('unconstrained-route', '/SyncPlay/bad', { actor: 'anonymous' });
    await step('missing-group', `/SyncPlay/${missing}`);
    await step('initial-list', '/SyncPlay/List');
    await post('pause-without-membership', 'Pause');
    await post('ping-without-membership', 'Ping', { Ping: 10 });
    await post('join-unknown', 'Join', { GroupId: missing });
    let created = await post('create', 'New', { GroupName: '\u0085 Together 中文 \u0085' });
    let group = created.body.GroupId;
    for (const [name, endpoint, source] of [
      ['empty-body', 'New', ''], ['null-body', 'New', 'null'], ['array-body', 'New', '[]'],
      ['null-name', 'New', '{"GroupName":null}'], ['long-name', 'New', JSON.stringify({ GroupName: 'x'.repeat(201) })],
      ['object-name', 'New', '{"GroupName":{}}'], ['bad-id', 'Join', '{"GroupId":"bad"}'],
      ['invalid-queue', 'SetNewQueue', '{"PlayingQueue":"x"}'], ['null-queue', 'SetNewQueue', '{"PlayingQueue":null}'],
      ['null-remove', 'RemoveFromPlaylist', '{"PlaylistItemIds":null}'], ['null-add', 'Queue', '{"ItemIds":null}'],
      ['null-guid-element', 'Queue', '{"ItemIds":[null]}'], ['bad-integer', 'MovePlaylistItem', '{"NewIndex":2147483648}'],
      ['bad-long', 'Seek', '{"PositionTicks":9223372036854775808}'], ['null-bool', 'SetIgnoreWait', '{"IgnoreWait":null}'],
      ['bad-when', 'Ready', '{"When":"2024-02-30T00:00:00Z"}'], ['null-when', 'Buffering', '{"When":null}'],
      ['bad-enum', 'SetRepeatMode', '{"Mode":"bad"}'], ['enum-overflow', 'SetShuffleMode', '{"Mode":2147483648}'],
      ['duplicate-invalid', 'Ping', '{"Ping":false,"Ping":1}']
    ]) await step(name, `/SyncPlay/${endpoint}`, { method: 'POST', source });
    await step('unsupported-content', '/SyncPlay/New', { method: 'POST', source: '{}', contentType: 'text/plain' });
    await step('get-group', `/SyncPlay/${group}`);
    await step('get-group-dashed', `/SyncPlay/${group.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}`);
    await post('other-session-authorized', 'Pause', undefined, 'c');
    await post('join-idle', 'Join', { GroupId: group }, 'b');
    await post('rejoin-idle', 'Join', { GroupId: group }, 'b');
    await post('ping-a', 'Ping', { Ping: 10000 }); await post('ping-b', 'Ping', { Ping: '10000' }, 'b');
    await step('deduplicated-participants', '/SyncPlay/List');
    const setQueue = name => post(name, 'SetNewQueue', { PlayingQueue: [movie, other, movie], PlayingItemPosition: 1, StartPositionTicks: 100000000 });
    let queued = await setQueue('play');
    const playlist = () => [...records].reverse().flatMap(entry => Object.values(entry.messages).flat()).find(message => message.MessageType === 'SyncPlayGroupUpdate' && message.Data.Type === 'PlayQueue')?.Data.Data;
    let id = playlist().Playlist[1].PlaylistItemId;
    const ready = (name, actor, position = 100000000, playing = false, itemId = id) => post(name, 'Ready', { PlaylistItemId: itemId, When: '0001-01-01T00:00:00', PositionTicks: position, IsPlaying: playing }, actor);
    await ready('ready-wrong-item', 'a', 100000000, false, missing);
    await ready('ready-needs-seek', 'a', 0, true);
    await ready('ready-a', 'a'); await ready('ready-b', 'b');
    await step('playing-info', `/SyncPlay/${group}`);
    await post('unpause-playing', 'Unpause'); await post('pause-playing', 'Pause'); await post('pause-paused', 'Pause');
    await post('seek-paused', 'Seek', { PositionTicks: -1 }); await ready('ready-paused-a', 'a', 0); await ready('ready-paused-b', 'b', 0);
    await post('seek-runtime-clamp', 'Seek', { PositionTicks: '9223372036854775807' });
    await post('pause-waiting', 'Pause'); await post('unpause-waiting', 'Unpause'); await post('force-unpause', 'Unpause');
    await post('forced-buffer-ignored', 'Buffering', { PlaylistItemId: id });
    await post('stop-playing', 'Stop'); await post('stop-idle', 'Stop'); await post('seek-idle', 'Seek', { PositionTicks: 10 });
    await post('unpause-idle', 'Unpause'); await post('ignore-a', 'SetIgnoreWait', { IgnoreWait: true }); await post('ignore-b', 'SetIgnoreWait', { IgnoreWait: true }, 'b');
    await post('stop-after-ignore', 'Stop'); await post('restore-wait-a', 'SetIgnoreWait', { IgnoreWait: false }); await post('restore-wait-b', 'SetIgnoreWait', { IgnoreWait: false }, 'b');
    queued = await setQueue('replace-queue'); id = playlist().Playlist[1].PlaylistItemId;
    await post('queue-next', 'Queue', { ItemIds: [other, movie], Mode: 'QueueNext' });
    await post('queue-unknown-mode', 'Queue', { ItemIds: [other], Mode: 77 });
    await post('queue-denied', 'Queue', { ItemIds: [missing] });
    await post('move-current', 'MovePlaylistItem', { PlaylistItemId: id, NewIndex: 2147483647 });
    await post('move-missing', 'MovePlaylistItem', { PlaylistItemId: missing, NewIndex: 0 });
    await post('repeat-unknown', 'SetRepeatMode', { Mode: 77 }); await post('repeat-default', 'SetRepeatMode', {});
    await post('repeat-one-next', 'NextItem', { PlaylistItemId: id });
    await post('sorted-redundant', 'SetShuffleMode', {});
    await post('repeat-all', 'SetRepeatMode', { Mode: 'RepeatAll' });
    await post('next-wrap', 'NextItem', { PlaylistItemId: id }); id = playlist().Playlist[playlist().PlayingItemIndex].PlaylistItemId;
    await post('previous-wrap', 'PreviousItem', { PlaylistItemId: id }); id = playlist().Playlist[playlist().PlayingItemIndex].PlaylistItemId;
    await post('next-stale-id', 'NextItem', { PlaylistItemId: missing });
    await post('set-missing', 'SetPlaylistItem', { PlaylistItemId: missing });
    await post('restore-current', 'SetPlaylistItem', { PlaylistItemId: id });
    await post('remove-before-current', 'RemoveFromPlaylist', { PlaylistItemIds: playlist().Playlist.slice(0, 2).map(item => item.PlaylistItemId) });
    await post('clear-preserve-current', 'RemoveFromPlaylist', { ClearPlaylist: true });
    await post('clear-current', 'RemoveFromPlaylist', { ClearPlaylist: true, ClearPlayingItem: true });
    await post('empty-queue-rejected', 'SetNewQueue', {});
    await post('empty-guid-queue-rejected', 'SetNewQueue', { PlayingQueue: [empty] });
    await post('missing-queue-rejected', 'SetNewQueue', { PlayingQueue: [missing] });
    await post('wrong-index-queue-rejected', 'SetNewQueue', { PlayingQueue: [movie], PlayingItemPosition: -1 });
    await post('unknown-join-keeps-group', 'Join', {});
    created = await post('create-switches-group', 'New', { GroupName: 123 });
    const newGroup = created.body.GroupId;
    await step('two-groups', '/SyncPlay/List');
    await post('switch-join', 'Join', { GroupId: newGroup }, 'b'); group = newGroup;
    await step('one-group-after-switch', '/SyncPlay/List');
    await post('leave-b', 'Leave', undefined, 'b'); await post('leave-b-again', 'Leave', undefined, 'b');
    await post('leave-last', 'Leave'); await step('no-groups', '/SyncPlay/List');
    await post('in-group-policy-revoked', 'Seek', { PositionTicks: 0 }, 'b');
    return { records, raw, identities: { userId: actors.a.User.Id } };
  } finally { for (const ws of sockets) ws.terminate(); }
}

export function normalizeSyncPlay(recording) {
  const ids = new Map(); let sequence = 0;
  function normalize(value, key = '') {
    if (key === 'traceId') { assert.match(value, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/); return '<traceId>'; }
    if (key === 'MessageId') { assert.match(value, /^[0-9a-f]{32}$/); return '<MessageId>'; }
    if (['When', 'EmittedAt', 'LastUpdate', 'LastUpdatedAt', 'RequestReceptionTime', 'ResponseTransmissionTime'].includes(key)) {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/); assert.ok(Number.isFinite(Date.parse(value)));
      return '<server-time>';
    }
    if (typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && ![empty, movie, other, missing].includes(value)) {
      if (!ids.has(value)) ids.set(value, `<generated-${sequence++}>`); return ids.get(value);
    }
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) return normalize(value.replaceAll('-', ''));
    if (Array.isArray(value)) {
      const entries = value.map(entry => normalize(entry));
      // The native ConcurrentDictionary does not define group enumeration order.
      return entries.length && entries.every(entry => entry && Object.hasOwn(entry, 'GroupName')) ? entries.sort((a, b) => a.GroupId.localeCompare(b.GroupId)) : entries;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalize(entry, name)]));
    return value;
  }
  return normalize(recording.records);
}
