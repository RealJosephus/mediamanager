import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSessionControlRecord } from './control-projection.js';

const originalIds = { controllerId: '1'.repeat(32), playerId: '2'.repeat(32), userId: '3'.repeat(32) };
const currentIds = { controllerId: '4'.repeat(32), playerId: '5'.repeat(32), userId: '6'.repeat(32) };
const opaque = { UserName: originalIds.userId, MessageId: 'business-message', traceId: originalIds.controllerId,
  Extra: { ControllingUserId: originalIds.userId }, Queue: [{ Id: 'second' }, { Id: 'first' }] };
const argumentsValue = { Volume: '37', Text: originalIds.userId, ItemName: originalIds.playerId,
  MessageId: 'business-message', ControllingUserId: originalIds.userId };
const project = (rows, identities) => rows.map(row => projectSessionControlRecord(row, identities));
function recording(identities, messageId) {
  const command = (name, MessageType, Data) => ({ name, body: { MessageType, MessageId: messageId, Data, Unknown: structuredClone(opaque) } });
  return [
    { name: 'remote-with-socket', body: [{ Id: identities.playerId, SupportsRemoteControl: true, Unknown: structuredClone(opaque) }] },
    { name: 'sessions-event', body: { MessageType: 'Sessions', Data: [
      { Id: identities.playerId, SupportedCommands: ['SetVolume'] }, { Id: identities.controllerId, SupportedCommands: [] },
    ] } },
    command('force-keepalive', 'ForceKeepAlive', 60),
    command('pause-wire', 'Playstate', { Command: 'Pause', ControllingUserId: identities.userId, ...structuredClone(opaque) }),
    command('full-command-wire', 'GeneralCommand', { Name: 'SetVolume', ControllingUserId: identities.userId, Arguments: { ...argumentsValue } }),
    command('play-wire', 'Play', { ItemIds: ['a'.repeat(32)], ControllingUserId: identities.userId, StartPositionTicks: 9007199254740993n }),
  ];
}

test('remote control projection binds only the recorded session and controller roles', () => {
  const original = recording(originalIds, 'a'.repeat(32)), current = recording(currentIds, 'b'.repeat(32));
  current[1].body.Data.reverse();
  assert.deepEqual(project(original, originalIds), project(current, currentIds));
  const projected = project(original, originalIds);
  assert.deepEqual(projected[0].body[0].Unknown, opaque);
  assert.deepEqual(projected[3].body.Data.Extra, opaque.Extra);
  assert.deepEqual(projected[4].body.Data.Arguments, argumentsValue);
  assert.equal(projected[5].body.Data.StartPositionTicks, 9007199254740993n);
  for (const change of [rows => { rows[0].body[0].Id = currentIds.controllerId; },
    rows => { rows[3].body.Data.ControllingUserId = currentIds.playerId; },
    rows => { rows[5].body.Data.ItemIds = [currentIds.userId]; },
    rows => { delete rows[3].body.MessageId; },
    rows => { rows[1].body.Data.push(rows[1].body.Data[0]); }]) {
    const changed = structuredClone(current); change(changed);
    assert.notDeepEqual(project(original, originalIds), project(changed, currentIds));
  }
});

test('remote control projection preserves identity-shaped command text, unknown fields and array order', () => {
  for (const field of ['Text', 'ItemName', 'MessageId', 'ControllingUserId']) {
    const original = recording(originalIds, 'a'.repeat(32)), current = recording(currentIds, 'b'.repeat(32));
    original[4].body.Data.Arguments[field] = originalIds.userId;
    current[4].body.Data.Arguments[field] = currentIds.userId;
    assert.notDeepEqual(project(original, originalIds), project(current, currentIds), field);
  }
  for (const change of [rows => { rows[4].body.Unknown.Queue.reverse(); },
    rows => { rows[0].body[0].Unknown.UserName = currentIds.userId; },
    rows => { rows[4].body.Unknown.Extra.ControllingUserId = currentIds.userId; }]) {
    const original = recording(originalIds, 'a'.repeat(32)), current = recording(currentIds, 'b'.repeat(32));
    change(current);
    assert.notDeepEqual(project(original, originalIds), project(current, currentIds));
  }
  const unrecognized = { name: 'other-wire', body: { MessageType: 'Other', MessageId: 'business-id', Data: structuredClone(opaque) } };
  assert.deepEqual(projectSessionControlRecord(unrecognized, originalIds), unrecognized);
});

test('remote control HTTP trace projection keeps presence, type and unrelated business values', () => {
  const problem = { name: 'invalid-ticks', status: 400, body: { status: 400, title: 'Bad request', traceId: 'actual-trace',
    errors: { traceId: [originalIds.userId], MessageId: ['business-message'] }, Unknown: structuredClone(opaque) } };
  const projected = projectSessionControlRecord(problem, originalIds);
  assert.equal(projected.body.traceId, '$trace');
  assert.deepEqual(projected.body.errors, problem.body.errors);
  assert.deepEqual(projected.body.Unknown, opaque);
  const absent = structuredClone(problem); delete absent.body.traceId;
  assert.notDeepEqual(projectSessionControlRecord(absent, originalIds), projected);
  const invalid = structuredClone(problem); invalid.body.traceId = false;
  assert.throws(() => projectSessionControlRecord(invalid, originalIds), assert.AssertionError);
  const success = { ...problem, status: 200 };
  assert.deepEqual(projectSessionControlRecord(success, originalIds), success);
  const httpWithWireShape = { name: 'pause-wire', status: 200, body: { MessageType: 'Playstate', MessageId: 'business-message',
    Data: { ControllingUserId: originalIds.userId } } };
  assert.deepEqual(projectSessionControlRecord(httpWithWireShape, originalIds), httpWithWireShape);
});
