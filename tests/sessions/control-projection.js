import assert from 'node:assert/strict';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

const wireTypes = new Map([
  ['force-keepalive', 'ForceKeepAlive'], ['keepalive', 'KeepAlive'],
  ['pause-wire', 'Playstate'], ['seek-wire', 'Playstate'],
  ['latest-socket-wire', 'Playstate'], ['remaining-socket-wire', 'Playstate'],
  ['command-wire', 'GeneralCommand'], ['system-wire', 'GeneralCommand'],
  ['full-command-wire', 'GeneralCommand'], ['message-wire', 'GeneralCommand'], ['browse-wire', 'GeneralCommand'],
  ['play-wire', 'Play'], ['play-missing-wire', 'Play'],
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// These bindings belong to the recorded actor roles, not to arbitrary text
// equal to an actor ID. The object token cannot collide with an unbound string.
function identity(value, identities, roles) {
  assert.equal(typeof value, 'string');
  for (const role of roles) if (value === identities[role]) return { $sessionControlIdentity: role };
  return value;
}

function sessionSummary(value, identities) {
  if (!object(value) || !Object.hasOwn(value, 'Id')) return value;
  return { ...value, Id: identity(value.Id, identities, ['controllerId', 'playerId']) };
}

export function projectSessionControlRecord(row, identities) {
  if (Object.hasOwn(row, 'status')) return { ...row, body: projectProblemTrace(row.body, row.status) };
  if (['remote-before-socket', 'remote-with-socket'].includes(row.name) && Array.isArray(row.body)) {
    return { ...row, body: row.body.map(value => sessionSummary(value, identities)) };
  }
  // This producer explicitly records an Id-sorted subset of each session. It
  // does not retain the full SessionInfo DTO or its LastActivityDate ordering.
  if (row.name === 'sessions-event' && object(row.body) && row.body.MessageType === 'Sessions' && Array.isArray(row.body.Data)) {
    const sessions = row.body.Data.map(value => sessionSummary(value, identities));
    sessions.sort((left, right) => (JSON.stringify(left?.Id) ?? '').localeCompare(JSON.stringify(right?.Id) ?? ''));
    return { ...row, body: { ...row.body, Data: sessions } };
  }
  const type = wireTypes.get(row.name);
  if (!type || !object(row.body) || row.body.MessageType !== type) return row;
  const body = { ...row.body };
  if (Object.hasOwn(body, 'MessageId')) {
    assert.match(body.MessageId, /^[0-9a-f]{32}$/u);
    body.MessageId = '<message-id>';
  }
  if (['Playstate', 'GeneralCommand', 'Play'].includes(type) && object(body.Data) && Object.hasOwn(body.Data, 'ControllingUserId')) {
    body.Data = { ...body.Data, ControllingUserId: identity(body.Data.ControllingUserId, identities, ['userId']) };
  }
  return { ...row, body };
}
