import assert from 'node:assert/strict';
import { parseLosslessJson } from '../../src/core/json.js';
import { userDataBindingCases } from './user-data-binding-cases.js';

const itemId = '22222222222222222222222222222222';
const missingId = 'ffffffffffffffffffffffffffffffff';
const baseline = '{"Rating":4,"PlaybackPositionTicks":0,"PlayCount":0,"IsFavorite":false,"Played":false,"LastPlayedDate":"2026-09-20T12:00:00Z"}';
export async function recordUserDataBinding(origin) {
  const actors = {}, records = [];
  const authorization = actor => `MediaBrowser Client="UserDataBinding", Device="Isolated", DeviceId="user-data-${actor}", Version="1"${actors[actor]?.AccessToken ? `, Token="${actors[actor].AccessToken}"` : ''}`;
  async function request(route, { actor = 'admin', method = 'POST', source, contentType = 'application/json' } = {}) {
    const response = await fetch(origin + route, { method, headers: { Authorization: authorization(actor), ...(contentType === null ? {} : { 'Content-Type': contentType }) }, body: source });
    const rawText = await response.text();
    let body = rawText; try { body = parseLosslessJson(rawText); } catch {}
    return { status: response.status, contentType: response.headers.get('content-type'), language: response.headers.get('content-language'), body, rawText };
  }
  for (const [actor, username, password] of [['admin', 'CoreFlowAdmin', 'isolated-core-flow-password'], ['reader', 'CoreFlowReader', 'isolated-reader-password']]) {
    const login = await request('/Users/AuthenticateByName', { actor, source: JSON.stringify({ Username: username, Pw: password }) });
    assert.equal(login.status, 200, `${actor} login`);
    actors[actor] = login.body;
  }
  const route = `/UserItems/${itemId}/UserData`;
  const record = async (name, target, options) => {
    const reset = await request(route, { source: baseline });
    assert.equal(reset.status, 200, `reset before ${name}`);
    const response = await request(target, options);
    const state = await request(route, { method: 'GET' });
    records.push({ name, response, state });
  };
  for (const entry of userDataBindingCases()) await record(entry.name, route, { source: entry.source });
  for (const [name, source, contentType] of [['empty-body', '', 'application/json'], ['missing-content-type', '{}', null], ['text-content-type', '{}', 'text/plain'], ['vendor-json', '{"PlayCount":5}', 'application/vnd.test+json'], ['multiline-error', '{\n  "LastPlayedDate":false\n}', 'application/json']]) await record(name, route, { source, contentType });
  const userId = actors.admin.User.Id;
  for (const [name, target, options] of [
    ['legacy-valid-date', `/Users/${userId}/Items/${itemId}/UserData`, { source: '{"LastPlayedDate":"2026-09-27T12:34:56.1234567+08:00"}' }],
    ['legacy-invalid-field', `/Users/${userId}/Items/${itemId}/UserData`, { source: '{"PlayedPercentage":false}' }],
    ['missing-item', `/UserItems/${missingId}/UserData`, { source: '{}' }],
    ['invalid-before-missing-item', `/UserItems/${missingId}/UserData`, { source: '{"PlayCount":false}' }],
    ['missing-user', `${route}?userId=${missingId}`, { source: '{}' }],
    ['cross-user', `${route}?userId=${userId}`, { actor: 'reader', source: '{}' }],
    ['binding-before-cross-user', `${route}?userId=${userId}`, { actor: 'reader', source: '{"PlayCount":false}' }],
    ['authentication-before-binding', route, { actor: 'anonymous', source: '{"PlayCount":false}' }]
  ]) await record(name, target, options);
  return { records };
}

export function normalizeUserDataBinding(recording) {
  const normalize = ({ rawText: _rawText, ...response }) => {
    const body = response.body && typeof response.body === 'object' ? { ...response.body } : response.body;
    if (body?.traceId) {
      assert.match(body.traceId, /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
      body.traceId = '<trace-id>';
    }
    return { ...response, body };
  };
  return recording.records.map(({ name, response, state }) => ({ name, response: normalize(response), state: normalize(state) }));
}
