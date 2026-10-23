import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid, permissionNames } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { currentQuickConnect, directAuthenticationObservation, quickConnectInput } from './quick-connect-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !postgresTestConnectionString };
const device = { Client: 'Target TV', Device: 'Living room', DeviceId: 'quick-tv', Version: '2.0' };
const clientHeader = (token, info = device) => ({ Authorization: 'MediaBrowser ' + Object.entries({ ...info, ...(token && { Token: token }) }).map(([key, value]) => `${key}="${encodeURIComponent(value)}"`).join(', ') });
const password = 'Isolated Quick Connect password';

async function setup(t) {
  let database = await createPostgresTestDatabase(null, 'quick_connect'), runtime;
  const configuration = { IsStartupWizardCompleted: true, BaseUrl: '/media', QuickConnectAvailable: true };
  const errors = [], authenticated = [], cleanup = [];
  const create = async () => {
    runtime = await createRuntime({ database, configuration, serverId: 'quick-connect-runtime', onError: error => errors.push(error) });
    runtime.authentication.on('AuthenticationResult', result => authenticated.push(result));
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  };
  t.after(async () => {
    const failures = [];
    for (const release of [...cleanup.reverse(), () => runtime?.close(), () => dropPostgresTestDatabase(database)]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Quick Connect runtime cleanup failed.');
  });
  await create();
  async function request(url, { token, method = 'GET', body, headers, ...rest } = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/media${url}`, { method,
      headers: { Accept: 'application/json', ...clientHeader(token), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }), ...rest });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { }
    return { status: response.status, body: result, text, language: response.headers.get('content-language') };
  }
  async function user(name, policy = {}) {
    const created = await runtime.users.createUser({ Name: name, Password: password });
    const current = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(created.Id, { ...current.Policy, ...policy });
    return created.Id;
  }
  async function login(name, info = device) {
    return runtime.authentication.login({ Username: name, Pw: password }, info, { remoteEndPoint: '127.0.0.1' });
  }
  return { request, user, login, configuration, errors, authenticated, cleanup,
    get runtime() { return runtime; }, get database() { return database; },
    async reopen() { const schema = database.schemaName; await runtime.close(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create(); }
  };
}

test('postgres: Quick Connect authorizes the initiating device, rotates its token and preserves real sessions across restart', enabled, async t => {
  const state = await setup(t);
  const id = await state.user('Owner');
  const first = await state.login('Owner');
  const approving = await state.login('Owner', { ...device, DeviceId: 'approving-phone', Device: 'Phone' });
  const prior = await state.runtime.users.getUser(id);
  const before = state.authenticated.length;
  const initiated = await state.request('/QuickConnect/Initiate', { method: 'POST' });
  assert.equal(initiated.status, 200); assert.equal(initiated.body.Authenticated, false);
  assert.equal((await state.database.rows('Devices')).length, 2);
  assert.equal((await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.body.Secret } })).status, 404);
  const approved = await state.request('/QuickConnect/Authorize?code=' + initiated.body.Code, { method: 'POST', token: approving.AccessToken });
  assert.equal(approved.status, 200); assert.equal(approved.body, true); assert.equal(approved.language, 'en-US');
  assert.equal(state.authenticated.length, before + 1, 'authentication and persistence happen during approval');
  const status = await state.request('/QuickConnect/Connect?secret=' + initiated.body.Secret);
  assert.equal(status.body.Authenticated, true); assert.ok(Date.parse(status.body.DateAdded) > Date.now() + 50_000);
  const redeemed = await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.body.Secret } });
  assert.equal(redeemed.status, 200); assert.equal(redeemed.body.User.Id, id);
  assert.notEqual(redeemed.body.AccessToken, first.AccessToken);
  assert.equal(redeemed.body.SessionInfo.DeviceId, device.DeviceId); assert.equal(redeemed.body.SessionInfo.DeviceName, device.Device);
  assert.equal(redeemed.body.SessionInfo.Client, device.Client); assert.equal(redeemed.body.SessionInfo.ApplicationVersion, device.Version);
  assert.equal(redeemed.body.SessionInfo.RemoteEndPoint, undefined, 'approval does not substitute the phone remote address');
  assert.equal((await state.runtime.users.getUser(id)).LastLoginDate, prior.LastLoginDate, 'direct authentication does not invoke password authentication');
  assert.equal((await state.request('/Users/Me', { token: first.AccessToken })).status, 401);
  assert.equal((await state.request('/Users/Me', { token: redeemed.body.AccessToken })).status, 200);
  const repeated = await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.body.Secret } });
  assert.deepEqual(repeated.body, redeemed.body); assert.equal(state.authenticated.length, before + 1);
  assert.equal((await state.database.rows('Devices')).length, 2);
  await state.reopen();
  assert.equal((await state.request('/QuickConnect/Connect?secret=' + initiated.body.Secret)).status, 404);
  assert.equal((await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.body.Secret } })).status, 404);
  assert.equal((await state.request('/Users/Me', { token: redeemed.body.AccessToken })).status, 200);
});

test('postgres: Quick Connect checks caller access and target device limits before token mutation', enabled, async t => {
  const state = await setup(t);
  const first = await state.user('First'), second = await state.user('Second');
  await state.user('Admin', { IsAdministrator: true });
  const normal = await state.login('First', { ...device, DeviceId: 'first-phone' });
  const elevated = await state.login('Admin', { ...device, DeviceId: 'admin-phone' });
  const initiated = (await state.request('/QuickConnect/Initiate', { method: 'POST' })).body;
  const approve = token => state.request(`/QuickConnect/Authorize?code=${initiated.Code}&userId=${second}`, { method: 'POST', token });
  assert.equal((await approve(normal.AccessToken)).status, 403);
  assert.equal((await state.request('/QuickConnect/Authorize?userId=bad', { method: 'POST' })).status, 401);
  const current = await state.runtime.users.getUser(second);
  await state.runtime.users.updatePolicy(second, { ...current.Policy, EnableAllDevices: false, EnabledDevices: ['different-device'] });
  const before = await state.database.rows('Devices');
  assert.equal((await approve(elevated.AccessToken)).status, 403);
  assert.deepEqual(await state.database.rows('Devices'), before);
  await state.runtime.users.updatePolicy(second, { ...(await state.runtime.users.getUser(second)).Policy, EnableAllDevices: true, MaxActiveSessions: 1 });
  await state.login('Second', { ...device, DeviceId: 'second-phone' });
  assert.equal((await approve(elevated.AccessToken)).status, 403);
  assert.equal((await state.request('/QuickConnect/Connect?secret=' + initiated.Secret)).body.Authenticated, false);
  const key = await state.runtime.apiKeys.create('Quick Connect fixture');
  const noUser = await state.request('/QuickConnect/Authorize?code=' + initiated.Code, { method: 'POST', token: key.AccessToken });
  assert.equal(noUser.status, 400); assert.equal(noUser.text, 'Error processing request.');
  assert.equal((await state.request(`/QuickConnect/Authorize?code=${initiated.Code}&userId=${first}`, { method: 'POST', token: key.AccessToken })).status, 200);
});

test('postgres: Quick Connect token insertion failure preserves logout and request extension, then permits retry', enabled, async t => {
  const state = await setup(t);
  const id = await state.user('Retry');
  const previous = await state.login('Retry');
  const key = await state.runtime.apiKeys.create('Retry approval');
  const initiated = (await state.request('/QuickConnect/Initiate', { method: 'POST' })).body;
  const schema = state.database.schemaName;
  await state.database.client.query(`CREATE FUNCTION "${schema}".fail_quick_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected quick token failure'; END $$`);
  await state.database.client.query(`CREATE TRIGGER fail_quick_token BEFORE INSERT ON "Devices" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_quick_token()`);
  const approve = () => state.request(`/QuickConnect/Authorize?code=${initiated.Code}&userId=${id}`, { method: 'POST', token: key.AccessToken });
  assert.equal((await approve()).status, 500);
  assert.deepEqual(await state.database.rows('Devices', { where: { UserId: nativeGuid(id) } }), []);
  assert.equal((await state.request('/Users/Me', { token: previous.AccessToken })).status, 401);
  const status = (await state.request('/QuickConnect/Connect?secret=' + initiated.Secret)).body;
  assert.equal(status.Authenticated, false); assert.ok(Date.parse(status.DateAdded) > Date.parse(initiated.DateAdded) + 50_000);
  await state.database.client.query('DROP TRIGGER fail_quick_token ON "Devices"');
  await state.database.client.query(`DROP FUNCTION "${schema}".fail_quick_token()`);
  assert.equal((await approve()).status, 200);
  const result = await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.Secret } });
  assert.equal(result.status, 200);
  await state.runtime.authentication.logout(result.body.AccessToken);
  const repeated = await state.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: initiated.Secret } });
  assert.deepEqual(repeated.body, result.body, 'stored authentication results are not regenerated or consumed');
  assert.equal((await state.request('/Users/Me', { token: repeated.body.AccessToken })).status, 401);
});

test('postgres: runtime closure drains admitted Quick Connect authentication before closing its database dependencies', enabled, async t => {
  const state = await setup(t);
  const id = await state.user('Closing');
  const initiated = state.runtime.quickConnect.initiate(device);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const direct = state.runtime.authentication.authenticateDirect.bind(state.runtime.authentication);
  state.runtime.authentication.authenticateDirect = async (...args) => { started.resolve(); await release.promise; return direct(...args); };
  const approval = state.runtime.quickConnect.authorize(id, initiated.Code); await started.promise;
  let closed = false; const closing = state.runtime.close().then(() => { closed = true; });
  await assert.rejects(state.runtime.quickConnect.authorize(id, initiated.Code), { status: 503 });
  assert.equal(closed, false); release.resolve(); assert.equal(await approval, true); await closing;
  assert.equal(closed, true); assert.equal(state.runtime.server.listening, false);
});

for (const name of quickConnectInput.directCases) test('postgres: current Native direct-authentication outcome and commit prefix: ' + name, { ...enabled, timeout: 600_000 }, async t => {
  const currentNative = await currentQuickConnect(), expected = currentNative.native.directResults.find(value => value.name === name);
  const state = await setup(t);
  const id = await state.user('Direct', name === 'device-denied' ? { EnableAllDevices: false, EnabledDevices: [] } : {});
  const persistedId = nativeGuid(id), client = { DeviceId: 'target-device', Device: 'Target', Client: 'Target app', Version: '1.2' };
  if (['disabled-user', 'remote-denied-user'].includes(name)) {
    const kind = permissionNames.indexOf(name === 'disabled-user' ? 'IsDisabled' : 'EnableRemoteAccess');
    const permission = (await state.database.rows('Permissions', { where: { UserId: persistedId, Kind: kind }, limit: 1 }))[0];
    await state.database.update('Permissions', { Id: permission.Id }, { Value: name === 'disabled-user' });
  }
  if (name === 'session-limit') {
    await state.database.update('Users', { Id: persistedId }, { MaxActiveSessions: 1 });
    await state.runtime.sessions.logActivity({ ...client, DeviceId: 'phone', User: await state.runtime.users.getUser(id) });
  }
  await state.database.update('Users', { Id: persistedId }, { InvalidLoginAttemptCount: 4, LastLoginDate: '1970-01-01 00:00:00', LastActivityDate: null });
  await state.database.insert('Devices', { UserId: persistedId, DeviceId: client.DeviceId, DeviceName: client.Device, AppName: client.Client,
    AppVersion: client.Version, AccessToken: 'old-token', IsActive: false, DateCreated: '2026-10-14 00:00:00', DateModified: '2026-10-14 00:00:00', DateLastActivity: '2026-10-14 00:00:00' });
  if (name === 'insert-failure' || name === 'delete-failure') {
    const event = name === 'insert-failure' ? 'INSERT' : 'DELETE';
    await state.database.client.query(`CREATE FUNCTION "${state.database.schemaName}".fail_direct_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled token failure'; END $$`);
    state.cleanup.push(() => state.database.client.query(`DROP FUNCTION "${state.database.schemaName}".fail_direct_token()`));
    await state.database.client.query(`CREATE TRIGGER fail_direct_token BEFORE ${event} ON "Devices" FOR EACH ROW EXECUTE FUNCTION "${state.database.schemaName}".fail_direct_token()`);
    state.cleanup.push(() => state.database.client.query('DROP TRIGGER fail_direct_token ON "Devices"'));
  }
  let status = 200, session = null;
  try {
    const result = await state.runtime.authentication.authenticateDirect(name === 'empty-user' ? '0'.repeat(32)
      : name === 'missing-user' ? 'ce100000000000000000000000000099' : id, client);
    session = { DeviceId: result.SessionInfo.DeviceId, DeviceName: result.SessionInfo.DeviceName, Client: result.SessionInfo.Client,
      ApplicationVersion: result.SessionInfo.ApplicationVersion, RemoteEndPoint: result.SessionInfo.RemoteEndPoint ?? null };
  } catch (error) { status = error.status ?? 500; }
  const devices = await state.database.rows('Devices'), current = await state.runtime.users.getUser(id);
  const actual = { name, status, session, deviceCount: devices.length, oldTokenRetained: devices.some(device => device.AccessToken === 'old-token'),
    loginUnchanged: current.LastLoginDate === '1970-01-01 00:00:00', InvalidLoginAttemptCount: current.InvalidLoginAttemptCount };
  await currentNative.recordComparison({ scope: 'postgres-direct-authentication', name, actual, expected });
  assert.deepEqual(actual, directAuthenticationObservation(expected));
});
