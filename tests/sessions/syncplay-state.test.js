import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SyncPlayGroup } from '../../src/syncplay/group.js';
import { SyncPlayQueue, emptyGuid } from '../../src/syncplay/queue.js';
import { SyncPlayService } from '../../src/syncplay/service.js';
import { parseJsonDateTime } from '../../src/http/json-date-time.js';
import { cloneNativeValue } from '../../src/core/json.js';

const first = '11111111111111111111111111111111', second = '22222222222222222222222222222222';
const a = { Id: 'a', UserId: first, UserName: 'First', NowPlayingQueue: [], PlayState: {} };
const b = { Id: 'b', UserId: second, UserName: 'Second', NowPlayingQueue: [], PlayState: {} };
const ticks = value => BigInt(value) * 10000n;

async function harness() {
  let now = 639261072000000000n, elapsed = 0;
  const events = [];
  const group = new SyncPlayGroup({ name: 'Test', clock: () => now, monotonic: () => elapsed, waitTimeout: 30000,
    item: async id => ({ Id: id, RunTimeTicks: 72000000000n }), access: async () => true,
    send: (session, type, value) => events.push({ session, type, data: cloneNativeValue(value) }) });
  await group.create(a); await group.join(b); events.length = 0;
  const run = (action, body = {}, session = a) => group.handle(action, body, session);
  const ready = (session, position = group.position, extra = {}) => run('Ready', { When: { ticks: now, kind: 'Utc' }, PositionTicks: position, IsPlaying: false, PlaylistItemId: group.queue.currentId, ...extra }, session);
  const play = async (position = 6000000000n) => {
    await run('Play', { PlayingQueue: [first, second, first], PlayingItemPosition: 0, StartPositionTicks: position });
    await ready(a); await ready(b); events.length = 0;
  };
  return { group, events, run, ready, play, advance: milliseconds => { elapsed += milliseconds; now += ticks(milliseconds); }, get now() { return now; } };
}

test('shuffle preserves duplicate identities, current selection and sorted restoration through edits', () => {
  let count = 0;
  const queue = new SyncPlayQueue({ choose: () => 0, createId: () => String(++count).padStart(32, '0') });
  queue.setPlaylist([first, second, first, second]); queue.setIndex(2);
  const initial = [...queue.playlist], playing = queue.current;
  queue.setShuffle('Shuffle'); assert.equal(queue.current, playing); assert.equal(queue.index, 0);
  assert.deepEqual(new Set(queue.playlist), new Set(initial)); assert.equal(new Set(queue.playlist.map(item => item.PlaylistItemId)).size, 4);
  queue.setShuffle('Shuffle'); assert.equal(queue.current, playing);
  queue.append([first, first], true); const inserted = queue.playlist.slice(1, 3);
  assert.equal(inserted.length, 2); assert.notEqual(inserted[0].PlaylistItemId, inserted[1].PlaylistItemId);
  queue.move(playing.PlaylistItemId, 999); assert.equal(queue.current, playing);
  queue.setShuffle('Sorted'); assert.deepEqual(queue.playlist, [...initial.slice(0, 3), ...inserted, initial[3]]);
  assert.equal(queue.current, playing); queue.setShuffle('Sorted'); assert.equal(queue.current, playing);
  queue.remove([initial[0].PlaylistItemId, playing.PlaylistItemId]); assert.equal(queue.current, initial[1]);
  queue.setShuffle('Shuffle'); queue.clear(false); assert.deepEqual(queue.playlist, [initial[1]]);
  queue.clear(true); assert.equal(queue.index, -1); assert.equal(queue.currentId, emptyGuid);
});

for (const offset of [5000000n, 5000001n]) test(`ready after a seek uses the 500 ms tolerance even for a playing client: ${offset}`, async () => {
  const h = await harness(); await h.play(); await h.run('Seek', { PositionTicks: 30000000000n }); h.events.length = 0;
  await h.ready(a, h.group.position - offset, { IsPlaying: true });
  assert.equal(h.events.some(event => event.data.Command === 'Seek'), offset > 5000000n);
  assert.equal(h.group.members.get('a').buffering, offset > 5000000n);
  assert.equal(h.group.state.type, 'Waiting');
});

for (const offset of [450000000n, 600000000n, 600000001n]) test(`buffer recovery uses the native 60 second catch-up tolerance: ${offset}`, async () => {
  const h = await harness(); await h.play(); h.advance(2000);
  await h.run('Buffer', { PlaylistItemId: h.group.queue.currentId }); h.events.length = 0;
  await h.ready(a, h.group.position - offset, { IsPlaying: true });
  assert.equal(h.events.some(event => event.data.Command === 'Seek'), offset > 600000000n);
  if (offset <= 600000000n) {
    const commands = h.events.filter(event => event.data.Command === 'Unpause');
    assert.deepEqual(commands.map(event => event.session), ['b']);
    assert.equal(parseJsonDateTime(commands[0].data.When).ticks - h.now, offset);
    assert.equal(h.group.state.type, 'Playing');
  } else assert.equal(h.group.state.type, 'Waiting');
});

test('paused reports and clocks more than two seconds out of sync ignore elapsed client time', async () => {
  const h = await harness();
  for (const [isPlaying, offset, seek] of [[false, 10000000n, false], [true, 20000000n, true], [true, 20000001n, false]]) {
    await h.run('Play', { PlayingQueue: [first], PlayingItemPosition: 0, StartPositionTicks: 6000000000n }); h.events.length = 0;
    await h.ready(a, h.group.position, { IsPlaying: isPlaying, When: { ticks: h.now - offset } });
    assert.equal(h.events.some(event => event.data.Command === 'Seek'), seek);
  }
});

test('repeated buffering does not extend the deadline; a new seek starts a fresh period', async () => {
  const h = await harness(); await h.play(); await h.run('Buffer', { PlaylistItemId: h.group.queue.currentId });
  assert.equal(h.group.deadline, 30000); h.advance(29000);
  await h.run('Buffer', { PlaylistItemId: h.group.queue.currentId }); assert.equal(h.group.deadline, 30000);
  await h.run('Seek', { PositionTicks: 3000000000n }); assert.equal(h.group.deadline, 59000);
  h.advance(29999); await h.group.timeout(); assert.equal(h.group.state.type, 'Waiting');
  h.advance(1); await h.group.timeout(); assert.equal(h.group.state.type, 'Playing');
  assert.equal(h.group.deadline, null); assert.equal(h.group.buffering, false);
  await h.run('Buffer', { PlaylistItemId: h.group.queue.currentId }); assert.equal(h.group.state.type, 'Playing');
  await h.run('SetPlaylistItem', { PlaylistItemId: h.group.queue.currentId }); assert.equal(h.group.state.type, 'Waiting');
  assert.ok(h.group.deadline > 59000);
});

test('paused timeout retains position and notifies every participant without elapsed playback', async () => {
  const h = await harness(); await h.play(); await h.run('Pause'); const position = h.group.position;
  h.advance(120000); await h.group.join({ ...a, Id: 'joiner' }); assert.equal(h.group.state.type, 'Waiting');
  h.advance(30000); h.events.length = 0; await h.group.timeout();
  assert.equal(h.group.position, position); assert.equal(h.group.state.type, 'Paused');
  assert.deepEqual(h.events.filter(event => event.data.Type === 'StateUpdate').map(event => event.session), ['a', 'b', 'joiner']);
  assert.ok(h.events.filter(event => event.data.Command).every(event => event.data.Command === 'Pause' && event.data.PositionTicks === position));
});

test('a joining participant blocks playback until ready, ignoring wait or leaving releases it', async () => {
  const h = await harness(); await h.play(); h.advance(2000);
  const joiner = { ...a, Id: 'joiner' };
  await h.group.join(joiner); assert.equal(h.group.position, 6010000000n); assert.equal(h.group.state.type, 'Waiting');
  await h.run('IgnoreWait', { IgnoreWait: true }, joiner); assert.equal(h.group.state.type, 'Playing'); assert.equal(h.group.deadline, null);
  await h.run('IgnoreWait', { IgnoreWait: false }, joiner); await h.run('Buffer', { PlaylistItemId: h.group.queue.currentId }, joiner);
  assert.equal(h.group.state.type, 'Waiting'); await h.group.leave(joiner); assert.equal(h.group.state.type, 'Playing');
  assert.equal(h.group.members.has('joiner'), false);
});

test('initial queue is taken from the session only when its library item is available', async () => {
  const h = await harness();
  const session = { ...a, NowPlayingItem: { Id: first }, NowPlayingQueue: [{ Id: first }, { Id: second }], PlayState: { PositionTicks: 123n, IsPaused: true } };
  await h.group.create(session, { Id: second, RunTimeTicks: 9000000000n });
  assert.equal(h.group.queue.itemId, second); assert.equal(h.group.position, 123n); assert.equal(h.group.runtime, 9000000000n);
  assert.equal(h.group.state.type, 'Waiting'); assert.equal(h.group.state.resumePlaying, false);
  const fresh = await harness(); await fresh.group.create(session);
  assert.equal(fresh.group.queue.playlist.length, 0); assert.equal(fresh.group.state.type, 'Idle');
});

test('rejoining retains original member identity and latency instead of resetting group state', async () => {
  const h = await harness(); await h.run('Ping', { Ping: 999999999999n }); assert.equal(h.group.ping, 10000n);
  await h.group.join({ ...a, UserName: 'Renamed' }); assert.deepEqual(h.group.info().Participants, ['First', 'Second']);
  assert.equal(h.group.members.get('a').ping, 10000n);
  await h.run('Ping', { Ping: -1n }); assert.equal(h.group.members.get('a').ping, 0n);
});

test('manager tracks repeated joins, distinct user sessions and SessionEnded without leaked membership', async () => {
  const sessions = new EventEmitter(); sessions.getPlaybackItem = () => null; sessions.sendCommand = async () => {};
  const users = { getUser: async id => ({ Id: id }) }, library = { getItemRecord: async id => ({ Id: id, RunTimeTicks: 72000000000n }) };
  const service = new SyncPlayService({ sessions, users, library });
  try {
    const info = await service.create(a, 'Test'); const other = { ...a, Id: 'same-user' };
    await service.join(a, info.GroupId); await service.join(other, info.GroupId); await service.leave(a);
    assert.equal(service.isUserActive(first), true);
    sessions.emit('SessionEnded', { SessionInfo: other }); await service.drain();
    assert.equal(service.isUserActive(first), false); assert.deepEqual(await service.list(a), []);
  } finally { await service.close(); }
  assert.equal(sessions.listenerCount('SessionEnded'), 0);
});

test('manager timer automatically releases a group and shutdown drains queued delivery', async () => {
  const sessions = new EventEmitter(), messages = [];
  sessions.getPlaybackItem = () => null; sessions.sendCommand = async (id, type, data) => { await delay(1); messages.push({ id, type, data }); };
  const service = new SyncPlayService({ sessions, users: { getUser: async id => ({ Id: id }) }, library: { getItemRecord: async id => ({ Id: id, RunTimeTicks: 72000000000n }) }, groupOptions: { waitTimeout: 100 } });
  try {
    const info = await service.create(a, 'Test');
    await service.handle(a, 'Play', { PlayingQueue: [first], PlayingItemPosition: 0, StartPositionTicks: 0n });
    for (let attempts = 0; attempts < 40 && (await service.get(a, info.GroupId)).State !== 'Playing'; attempts++) await delay(50);
    assert.equal((await service.get(a, info.GroupId)).State, 'Playing');
  } finally { await service.close(); }
  assert.ok(messages.some(message => message.data.Command === 'Unpause')); assert.equal(sessions.listenerCount('SessionEnded'), 0);
});

test('a blocked connection cannot delay another member, and each member retains message order', async () => {
  const sessions = new EventEmitter(), messages = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  sessions.getPlaybackItem = () => null;
  sessions.sendCommand = async (id, type, data) => { if (id === 'a') await blocked; messages.push({ id, type, data }); };
  const service = new SyncPlayService({ sessions, users: { getUser: async id => ({ Id: id }) }, library: {} });
  try {
    const info = await service.create(a, 'Test'); await service.join(b, info.GroupId);
    for (let count = 0; count < 20 && messages.length < 2; count++) await delay(5);
    assert.deepEqual(messages.map(message => [message.id, message.data.Type ?? message.data.Command]), [['b', 'GroupJoined'], ['b', 'Stop']]);
  } finally { release(); await service.close(); }
  assert.deepEqual(messages.filter(message => message.id === 'a').map(message => message.data.Type ?? message.data.Command), ['GroupJoined', 'Stop', 'UserJoined']);
});
