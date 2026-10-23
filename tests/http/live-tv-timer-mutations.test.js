import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/http/application.js';
import { registerLiveTvTimerRoutes } from '../../src/http/live-tv-timer-routes.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';

const userId = 'a9500000000000000000000000000001';
const user = (access, management, administrator = false) => ({ Id: userId, Policy: { EnableLiveTvAccess: access,
  EnableLiveTvManagement: management, IsAdministrator: administrator, EnableRemoteAccess: true, BlockUnratedItems: [] } });

test('timer mutation route inventory statically binds the public methods, policies and DTO bodies', () => {
  const routes = [];
  registerLiveTvTimerRoutes((method, route, run, options) => routes.push({ method, route, run, options }), { liveTvTimers: {} });
  for (const route of ['/LiveTv/Timers/{timerId}', '/LiveTv/SeriesTimers/{timerId}']) {
    const selected = routes.find(value => value.method === 'DELETE' && value.route === route);
    assert.equal(selected.options.policy, 'LiveTvManagement'); assert.equal(selected.options.body, undefined);
  }
  for (const [route, parameter] of [
    ['/LiveTv/Timers', 'timerInfo'], ['/LiveTv/Timers/{timerId}', 'timerInfo'],
    ['/LiveTv/SeriesTimers', 'seriesTimerInfo'], ['/LiveTv/SeriesTimers/{timerId}', 'seriesTimerInfo'],
  ]) {
    const selected = routes.find(value => value.method === 'POST' && value.route === route);
    assert.equal(selected.options.policy, 'LiveTvManagement'); assert.equal(selected.options.body, true);
    assert.equal(selected.options.bodyParameter, parameter);
  }
});

async function fixture(t) {
  const subjects = { access: user(true, false), management: user(false, true), denied: user(false, false),
    admin: user(false, false, true) };
  const authorization = new AuthenticationService({ store: {}, users: {}, serverId: 'timer-mutation-http' });
  const calls = [], errors = [];
  const liveTvTimers = {
    cancelTimer: async id => { calls.push({ operation: 'timer', id }); return id !== 'missing' && id !== 'not-a-guid'; },
    cancelSeriesTimer: async id => { calls.push({ operation: 'series', id }); return id !== 'missing'; },
    getTimers: async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }), getTimer: async () => null,
    getSeriesTimers: async () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 }), getSeriesTimer: async () => null,
    getNewTimerDefaults: async () => ({}),
  };
  const app = await createApplication({ liveTvTimers, configuration: { IsStartupWizardCompleted: true }, onError: error => errors.push(error),
    authentication: { authorize: authorization.authorize.bind(authorization), authenticate: async request => {
      const role = request.headers['x-fixture-subject'];
      if (role === 'apiKey') return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true, UserId: '0'.repeat(32) };
      const selected = subjects[role];
      return { IsAuthenticated: Boolean(selected), IsApiKey: false, IsAdministrator: selected?.Policy.IsAdministrator ?? false,
        UserId: selected?.Id, User: selected };
    } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const request = async (route, { method = 'DELETE', role = 'management', body, contentType = 'application/json' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method,
      headers: { 'X-Fixture-Subject': role, ...(body !== undefined && { 'Content-Type': contentType }) },
      ...(body !== undefined && { body }) });
    const text = await response.text();
    return { status: response.status, allow: response.headers.get('allow'), text,
      ...(/json/u.test(response.headers.get('content-type') ?? '') && text && { json: JSON.parse(text) }) };
  };
  return { request, calls, errors };
}

test('LiveTvManagement DELETE routes bind string ids and distinguish 400, 404 and 204', async t => {
  const current = await fixture(t);
  assert.equal((await current.request('/LiveTv/Timers/existing', { role: 'absent' })).status, 401);
  assert.equal((await current.request('/LiveTv/Timers/existing', { role: 'access' })).status, 403);
  assert.equal((await current.request('/LiveTv/Timers/existing', { role: 'denied' })).status, 403);
  assert.equal((await current.request('/LiveTv/Timers/existing')).status, 204);
  assert.equal((await current.request('/LiveTv/SeriesTimers/Series-Route')).status, 204);
  assert.equal((await current.request('/LiveTv/Timers/api-key-route', { role: 'apiKey' })).status, 204);
  assert.equal((await current.request('/LiveTv/SeriesTimers/admin-route', { role: 'admin' })).status, 204);
  assert.equal((await current.request('/LiveTv/Timers/missing')).status, 404);
  assert.equal((await current.request('/LiveTv/Timers/not-a-guid')).status, 404);
  const whitespace = await current.request('/LiveTv/SeriesTimers/%20');
  assert.equal(whitespace.status, 400); assert.deepEqual(whitespace.json.errors.timerId, ['The timerId field is required.']);
  assert.deepEqual(current.calls, [
    { operation: 'timer', id: 'existing' }, { operation: 'series', id: 'Series-Route' },
    { operation: 'timer', id: 'api-key-route' }, { operation: 'series', id: 'admin-route' },
    { operation: 'timer', id: 'missing' }, { operation: 'timer', id: 'not-a-guid' },
  ]);
});

test('all four timer POST routes authenticate and bind bodies before an operation-specific 409 capability rejection', async t => {
  const current = await fixture(t), routes = [
    ['/LiveTv/Timers', 'timer creation'], ['/LiveTv/Timers/route-only-required', 'timer update'],
    ['/LiveTv/SeriesTimers', 'series timer creation'], ['/LiveTv/SeriesTimers/route-only-required', 'series timer update'],
  ];
  for (const [route, operation] of routes) {
    assert.equal((await current.request(route, { method: 'POST', role: 'access', body: '{}' })).status, 403);
    assert.equal((await current.request(route, { method: 'POST', body: '{}', contentType: 'text/plain' })).status, 415);
    const empty = await current.request(route, { method: 'POST', body: '' });
    assert.equal(empty.status, 400); assert.ok(empty.json.errors);
    for (const invalidRoot of ['null', '[]', '7', '"scalar"']) {
      const invalid = await current.request(route, { method: 'POST', body: invalidRoot });
      assert.equal(invalid.status, 400, `${route} must reject root ${invalidRoot}`);
    }
    const rejected = await current.request(route, { method: 'POST', body: '{"Id":"body-target"}' });
    assert.equal(rejected.status, 409); assert.equal(rejected.text, 'Error processing request.');
    assert.match(current.errors.at(-1).message, new RegExp(operation, 'u'));
  }
  const required = await current.request('/LiveTv/Timers/%20', { method: 'POST', body: '{"Id":"body-target"}' });
  assert.equal(required.status, 400); assert.ok(required.json.errors.timerId);
  assert.deepEqual(current.calls, [], 'rejected create/update operations cannot enter cancellation persistence');
});

test('timer POST DTO binding rejects malformed public members before the recorder capability boundary', async t => {
  const current = await fixture(t);
  for (const [route, body] of [
    ['/LiveTv/Timers', '{"ChannelId":7}'],
    ['/LiveTv/Timers', '{"StartDate":"not-a-date"}'],
    ['/LiveTv/Timers/target-from-body', '{"KeepUntil":"Forever"}'],
    ['/LiveTv/Timers/target-from-body', '{"ProgramInfo":[]}'],
    ['/LiveTv/Timers/target-from-body', '{"ProgramInfo":{"Id":[]}}'],
    ['/LiveTv/SeriesTimers', '{"RecordAnyTime":"true"}'],
    ['/LiveTv/SeriesTimers', '{"Days":"Monday"}'],
    ['/LiveTv/SeriesTimers/target-from-body', '{"Days":["NotADay"]}'],
    ['/LiveTv/SeriesTimers/target-from-body', '{"ImageTags":{"NotAnImageType":"tag"}}'],
  ]) {
    const response = await current.request(route, { method: 'POST', body });
    assert.equal(response.status, 400, `${route} must reject ${body}`);
    assert.equal(response.json.status, 400);
  }
  assert.deepEqual(current.errors, [], 'binding failures do not reach the unavailable recorder operation');
});

test('timer POST DTO binding is case insensitive, ignores unknown members and accepts native enum arrays', async t => {
  const current = await fixture(t);
  const timer = await current.request('/LiveTv/Timers', { method: 'POST', body: JSON.stringify({
    channelid: '00000000-0000-0000-0000-000000000000', STARTDATE: '2026-10-23T01:02:03Z',
    keepuntil: 'untildeleted', RunTimeTicks: '42',
    ProgramInfo: { Id: 'ffeeddcc-bbaa-9988-7766-554433221100', Name: 'Episode' },
    UnknownFutureMember: { nested: true },
  }) });
  assert.equal(timer.status, 409);
  assert.match(current.errors.at(-1).message, /timer creation/u);

  const series = await current.request('/LiveTv/SeriesTimers', { method: 'POST', body: JSON.stringify({
    DAYS: ['monday', 6], recordanytime: true, ImageTags: { primary: 'tag' }, UnknownFutureMember: 7,
  }) });
  assert.equal(series.status, 409);
  assert.match(current.errors.at(-1).message, /series timer creation/u);
});
