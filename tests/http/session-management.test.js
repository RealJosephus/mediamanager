import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { AUTHENTICATION_PROVIDER, PASSWORD_RESET_PROVIDER } from '../../src/users/native.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

test('session listing, provider discovery and additional-user management match the native HTTP contract', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const stateRoot = await mkdtemp(path.join(temporaryRoot, 'mediamanager-session-management-'));
  t.after(async () => {
    assert.equal(path.dirname(stateRoot), temporaryRoot);
    assert.ok(path.basename(stateRoot).startsWith('mediamanager-session-management-'));
    await rm(stateRoot, { recursive: true, force: true });
  });
  const database = await createPostgresTestDatabase(t, 'http_sessions');
  const runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'session-management-test', programDataPath: path.join(stateRoot, 'program'), configurationDirectoryPath: path.join(stateRoot, 'config') });
  runtime.sessions.automaticProgress = false;
  let sessionNow = new Date('2026-09-27T12:00:00.000Z');
  runtime.sessions.clock = () => new Date(sessionNow);
  try {
    const adminUser = await runtime.users.createUser({ Name: 'ManagementAdmin', Password: 'admin-password' });
    const readerUser = await runtime.users.createUser({ Name: 'ManagementReader', Password: 'reader-password' });
    await runtime.users.updatePolicy(adminUser.Id, { ...(await runtime.users.getUser(adminUser.Id)).Policy, IsAdministrator: true });
    const admin = await runtime.authentication.login({ Username: 'ManagementAdmin', Pw: 'admin-password' },
      { Client: 'SessionManagementTest', Device: 'Admin Device', DeviceId: 'management-admin', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    sessionNow = new Date('2026-09-27T12:00:05.000Z');
    const reader = await runtime.authentication.login({ Username: 'ManagementReader', Pw: 'reader-password' },
      { Client: 'SessionManagementTest', Device: 'Reader Device', DeviceId: 'management-reader', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const authorization = (token, device) => `MediaBrowser Client="SessionManagementTest", Device="Device", DeviceId="${device}", Version="1"${token ? `, Token="${token}"` : ''}`;
    async function call(route, { token = admin.AccessToken, device = 'management-admin', method = 'GET' } = {}) {
      const response = await fetch(origin + route, { method, headers: { Authorization: authorization(token, device) } });
      const text = await response.text();
      return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
    }
    const expectSessions = async (route, expectedIds) => {
      const result = await call(route);
      assert.equal(result.status, 200, route);
      assert.deepEqual(result.body.map(session => session.Id).toSorted(), expectedIds.toSorted(), route);
      return result.body;
    };
    const both = [admin.SessionInfo.Id, reader.SessionInfo.Id];

    await expectSessions('/Sessions', both);
    await expectSessions('/Sessions?controllableByUserId=', both);
    await expectSessions('/Sessions?controllableByUserId=%20', both);
    await expectSessions('/Sessions?activeWithinSeconds=', both);
    await expectSessions('/Sessions?activeWithinSeconds=%20', both);
    await expectSessions('/Sessions?activeWithinSeconds=2147483647', both);
    await expectSessions('/Sessions?activeWithinSeconds=-1', both);
    await expectSessions('/Sessions?activeWithinSeconds=1&activeWithinSeconds=2147483647', [reader.SessionInfo.Id]);
    await expectSessions('/Sessions?deviceId=', both);
    await expectSessions('/Sessions?deviceId=%20', both);
    await expectSessions('/Sessions?deviceId=management-admin&deviceId=management-reader', [admin.SessionInfo.Id]);
    await expectSessions('/Sessions?controllableByUserId=00000000000000000000000000000000', []);
    await expectSessions(`/Sessions?controllableByUserId=${adminUser.Id}`, []);
    await expectSessions(`/Sessions?controllableByUserId=${readerUser.Id}`, []);

    for (const [route, errors] of [
      ['/Sessions?controllableByUserId=bad', { controllableByUserId: ["The value 'bad' is not valid."] }],
      ['/Sessions?activeWithinSeconds=x', { activeWithinSeconds: ["The value 'x' is not valid."] }],
      ['/Sessions?activeWithinSeconds=2147483648', { activeWithinSeconds: ["The value '2147483648' is not valid."] }],
      ['/Sessions?controllableByUserId=bad&activeWithinSeconds=x', {
        controllableByUserId: ["The value 'bad' is not valid."], activeWithinSeconds: ["The value 'x' is not valid."]
      }]
    ]) {
      const result = await call(route);
      assert.equal(result.status, 400, route);
      assert.deepEqual(result.body.errors, errors, route);
      assert.equal(result.body.title, 'One or more validation errors occurred.', route);
      if (route.includes('controllableByUserId=bad&')) assert.deepEqual(Object.keys(result.body.errors), ['activeWithinSeconds', 'controllableByUserId']);
    }
    const forbiddenFilter = await call(`/Sessions?controllableByUserId=${adminUser.Id}`, {
      token: reader.AccessToken, device: 'management-reader'
    });
    assert.deepEqual(forbiddenFilter, { status: 403, body: 'Error processing request.' });

    assert.deepEqual(await call('/Auth/Providers'), { status: 200, body: [{ Name: 'Default', Id: AUTHENTICATION_PROVIDER }] });
    assert.deepEqual(await call('/Auth/PasswordResetProviders'), { status: 200, body: [{ Name: 'Default Password Reset Provider', Id: PASSWORD_RESET_PROVIDER }] });
    assert.deepEqual(await call('/Auth/Providers', { token: reader.AccessToken, device: 'management-reader' }), { status: 403, body: '' });
    assert.deepEqual(await call('/Auth/PasswordResetProviders', { token: reader.AccessToken, device: 'management-reader' }), { status: 403, body: '' });
    assert.deepEqual(await call('/Auth/Providers', { token: null, device: 'management-none' }), { status: 401, body: '' });

    const target = admin.SessionInfo.Id;
    const route = userId => `/Sessions/${target}/User/${userId}`;
    let result = await call(route('bad'), { method: 'POST' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body.errors, { userId: ["The value 'bad' is not valid."] });
    assert.deepEqual(await call(route('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { method: 'POST' }), { status: 400, body: 'Error processing request.' });
    assert.deepEqual(await call(route(readerUser.Id), { method: 'POST' }), { status: 204, body: '' });
    let sessions = await expectSessions('/Sessions?deviceId=management-admin', [target]);
    assert.deepEqual(sessions[0].AdditionalUsers, [{ UserId: readerUser.Id, UserName: 'ManagementReader' }]);
    assert.deepEqual(await call(route(readerUser.Id), { method: 'POST' }), { status: 204, body: '' });
    sessions = await expectSessions('/Sessions?deviceId=management-admin', [target]);
    assert.equal(sessions[0].AdditionalUsers.length, 1);
    assert.deepEqual(await call(route(adminUser.Id), { method: 'POST' }), { status: 400, body: 'Error processing request.' });
    result = await call(route('bad'), { method: 'DELETE' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body.errors, { userId: ["The value 'bad' is not valid."] });
    assert.deepEqual(await call(route(readerUser.Id), { method: 'DELETE' }), { status: 204, body: '' });
    sessions = await expectSessions('/Sessions?deviceId=management-admin', [target]);
    assert.deepEqual(sessions[0].AdditionalUsers, []);
    assert.deepEqual(await call(route(readerUser.Id), { method: 'DELETE' }), { status: 204, body: '' });
    assert.deepEqual(await call(`/Sessions/missing/User/${readerUser.Id}`, { method: 'POST' }), { status: 404, body: 'Error processing request.' });

    assert.equal(stringifyNativeJson({ providers: [{ Name: null, Id: AUTHENTICATION_PROVIDER }] }),
      `{"providers":[{"Id":"${AUTHENTICATION_PROVIDER}"}]}`);
  } finally { await runtime.close(); }
});
