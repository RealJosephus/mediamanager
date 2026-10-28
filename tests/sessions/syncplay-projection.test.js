import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSyncPlay } from './syncplay-scenario.js';

const media = '22222222222222222222222222222222';
const stamp = '2026-10-27T00:00:00Z';
const opaque = { GroupId: '9'.repeat(32), GroupName: '9'.repeat(32), traceId: 'business-trace',
  MessageId: 'business-message', When: 'business-when', LastUpdatedAt: 'business-date' };
function recording(groupId, playlistId, messageId, when = stamp) {
  const info = { GroupId: groupId, GroupName: 'Room', State: 'Waiting', Participants: ['member'], LastUpdatedAt: when, Unknown: structuredClone(opaque) };
  const update = (Type, Data) => ({ MessageType: 'SyncPlayGroupUpdate', MessageId: messageId,
    Data: { GroupId: groupId, Type, Data, Unknown: structuredClone(opaque) } });
  return { records: [
    { name: 'create', status: 200, body: info, messages: { a: [update('GroupJoined', structuredClone(info))] } },
    { name: 'play', status: 204, body: '', messages: { a: [
      update('PlayQueue', { LastUpdate: when, Playlist: [{ ItemId: media, PlaylistItemId: playlistId, Unknown: structuredClone(opaque) }], PlayingItemIndex: 0 }),
      { MessageType: 'SyncPlayCommand', MessageId: messageId, Data: { GroupId: groupId, PlaylistItemId: playlistId,
        Command: 'Pause', When: when, EmittedAt: when, PositionTicks: 9007199254740993n, Unknown: structuredClone(opaque) } },
      update('UserJoined', '9'.repeat(32)), update('GroupLeft', groupId),
      update('StateUpdate', { State: 'Waiting', Reason: 'Ready', ...structuredClone(opaque) }),
    ] } },
  ] };
}

test('SyncPlay projection binds declared Group/Playlist roles and preserves opaque values', () => {
  const original = recording('a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32));
  const current = recording('d'.repeat(32), 'e'.repeat(32), 'f'.repeat(32), '2026-10-28T00:00:00Z');
  assert.deepEqual(normalizeSyncPlay(original), normalizeSyncPlay(current));
  const projected = normalizeSyncPlay(original);
  assert.deepEqual(projected[0].body.Unknown, opaque);
  assert.deepEqual(projected[1].messages.a[0].Data.Unknown, opaque);
  assert.deepEqual(projected[1].messages.a[1].Data.Unknown, opaque);
  assert.deepEqual(projected[1].messages.a[4].Data.Data, { State: 'Waiting', Reason: 'Ready', ...opaque });
  assert.equal(projected[1].messages.a[2].Data.Data, '9'.repeat(32));
  assert.equal(projected[1].messages.a[1].Data.PositionTicks, 9007199254740993n);
  const namedOriginal = structuredClone(original), namedCurrent = structuredClone(current);
  namedOriginal.records[0].body.GroupName = 'a'.repeat(32);
  namedCurrent.records[0].body.GroupName = 'd'.repeat(32);
  assert.notDeepEqual(normalizeSyncPlay(namedOriginal), normalizeSyncPlay(namedCurrent));
  const membersOriginal = structuredClone(original), membersCurrent = structuredClone(current);
  membersOriginal.records[0].body.Participants = ['a'.repeat(32)];
  membersCurrent.records[0].body.Participants = ['d'.repeat(32)];
  assert.notDeepEqual(normalizeSyncPlay(membersOriginal), normalizeSyncPlay(membersCurrent));
  for (const change of [value => { value[0].body.Unknown.GroupId = '8'.repeat(32); },
    value => { value[0].body.Participants = ['different']; },
    value => { value[1].messages.a[1].Data.GroupId = '7'.repeat(32); },
    value => { value[1].messages.a[1].Data.PlaylistItemId = '6'.repeat(32); },
    value => { value[1].messages.a[0].Data.Data.Playlist[0].ItemId = '3'.repeat(32); },
    value => { value[1].messages.a[2].Data.Data = '8'.repeat(32); }]) {
    const changed = structuredClone(current); change(changed.records);
    assert.notDeepEqual(normalizeSyncPlay(original), normalizeSyncPlay(changed));
  }
});

test('SyncPlay projects traces only on HTTP ProblemDetails and IDs only on known envelopes', () => {
  const source = { records: [{ name: 'problem', status: 400, body: { status: 400, title: 'Bad request', traceId: 'actual-trace',
    errors: { traceId: ['business-trace'] }, Unknown: structuredClone(opaque) }, messages: {} },
  { name: 'business', status: 200, body: structuredClone(opaque), messages: { a: [
    { MessageType: 'Unrelated', MessageId: 'business-id', Data: structuredClone(opaque) },
  ] } }] };
  const projected = normalizeSyncPlay(source);
  assert.equal(projected[0].body.traceId, '$trace');
  assert.deepEqual(projected[0].body.errors, source.records[0].body.errors);
  assert.deepEqual(projected[0].body.Unknown, opaque);
  assert.deepEqual(projected[1], source.records[1]);
  const absent = structuredClone(source); delete absent.records[0].body.traceId;
  assert.notDeepEqual(normalizeSyncPlay(absent), projected);
  const invalid = structuredClone(source); invalid.records[0].body.traceId = 0;
  assert.throws(() => normalizeSyncPlay(invalid), assert.AssertionError);
});

test('SyncPlay dictionary enumeration alignment does not reorder queues or unknown arrays', () => {
  const source = recording('a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32));
  const first = structuredClone(source.records[0].body), second = { ...first, GroupId: 'd'.repeat(32), GroupName: 'Second' };
  source.records.push({ name: 'create-second', status: 200, body: second, messages: {} },
    { name: 'list', status: 200, body: [second, first], messages: {} });
  source.records[0].body.Participants = ['second', 'first'];
  source.records[0].body.Unknown.Groups = [{ GroupId: 'a'.repeat(32), GroupName: 'first' }, { GroupId: 'd'.repeat(32), GroupName: 'second' }];
  const reordered = structuredClone(source);
  reordered.records.at(-1).body.reverse(); reordered.records[0].body.Participants.reverse();
  assert.deepEqual(normalizeSyncPlay(source), normalizeSyncPlay(reordered));
  const unknown = structuredClone(source); unknown.records[0].body.Unknown.Groups.reverse();
  assert.notDeepEqual(normalizeSyncPlay(source), normalizeSyncPlay(unknown));
  const duplicate = structuredClone(source); duplicate.records[0].body.Participants.push('first');
  assert.notDeepEqual(normalizeSyncPlay(source), normalizeSyncPlay(duplicate));
  source.records[1].messages.a[0].Data.Data.Playlist.push({ ItemId: '3'.repeat(32), PlaylistItemId: 'e'.repeat(32) });
  const queue = structuredClone(source); queue.records[1].messages.a[0].Data.Data.Playlist.reverse();
  assert.notDeepEqual(normalizeSyncPlay(source), normalizeSyncPlay(queue));
});
