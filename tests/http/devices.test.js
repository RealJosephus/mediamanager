import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

test('device listing, options and deletion match the recorded native controller contract', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const stateRoot = await mkdtemp(path.join(temporaryRoot, 'mediamanager-device-http-'));
  t.after(async () => {
    assert.equal(path.dirname(stateRoot), temporaryRoot);
    assert.ok(path.basename(stateRoot).startsWith('mediamanager-device-http-'));
    await rm(stateRoot, { recursive: true, force: true });
  });
  const database = await createPostgresTestDatabase(t, 'http_devices');
  const runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'device-http-test', programDataPath: path.join(stateRoot, 'program'), configurationDirectoryPath: path.join(stateRoot, 'config') });
  runtime.sessions.automaticProgress = false;
  try {
    const adminUser = await runtime.users.createUser({ Name: 'DeviceAdmin', Password: 'admin-password' });
    const readerUser = await runtime.users.createUser({ Name: 'DeviceReader', Password: 'reader-password' });
    await runtime.users.updatePolicy(adminUser.Id, { ...(await runtime.users.getUser(adminUser.Id)).Policy, IsAdministrator: true });
    let now = new Date('2026-09-27T12:00:00.000Z');
    runtime.authentication.now = () => new Date(now);
    const admin = await runtime.authentication.login({ Username: 'DeviceAdmin', Pw: 'admin-password' },
      { Client: 'DeviceTest', Device: 'Device', DeviceId: 'management-admin', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    now = new Date('2026-09-27T12:00:01.000Z');
    const reader = await runtime.authentication.login({ Username: 'DeviceReader', Pw: 'reader-password' },
      { Client: 'DeviceTest', Device: 'Device', DeviceId: 'management-reader', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    now = new Date('2026-09-27T12:00:02.000Z');
    await runtime.authentication.login({ Username: 'DeviceAdmin', Pw: 'admin-password' },
      { Client: 'DeviceTest', Device: 'Device', DeviceId: 'management-delete', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const authorization = (token, device) => `MediaBrowser Client="DeviceTest", Device="Device", DeviceId="${device}", Version="1"${token ? `, Token="${token}"` : ''}`;
    async function call(route, { token = admin.AccessToken, device = 'management-admin', method = 'GET', source, contentType } = {}) {
      const headers = { Authorization: authorization(token, device) };
      if (source !== undefined && contentType !== null) headers['Content-Type'] = contentType ?? 'application/json';
      const response = await fetch(origin + route, { method, headers, body: source });
      const text = await response.text();
      return { status: response.status, contentType: response.headers.get('content-type'),
        body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
    }
    const capabilities = { PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true };
    const expected = {
      'management-admin': { Name: 'Device', Id: 'management-admin', LastUserName: 'DeviceAdmin', AppName: 'DeviceTest', AppVersion: '1',
        LastUserId: adminUser.Id, DateLastActivity: '2026-09-27T12:00:00.0000000Z', Capabilities: capabilities },
      'management-reader': { Name: 'Device', Id: 'management-reader', LastUserName: 'DeviceReader', AppName: 'DeviceTest', AppVersion: '1',
        LastUserId: readerUser.Id, DateLastActivity: '2026-09-27T12:00:01.0000000Z', Capabilities: capabilities },
      'management-delete': { Name: 'Device', Id: 'management-delete', LastUserName: 'DeviceAdmin', AppName: 'DeviceTest', AppVersion: '1',
        LastUserId: adminUser.Id, DateLastActivity: '2026-09-27T12:00:02.0000000Z', Capabilities: capabilities }
    };
    const assertList = async route => {
      const result = await call(route);
      assert.equal(result.status, 200, route);
      assert.deepEqual(result.body, { Items: [expected['management-delete'], expected['management-reader'], expected['management-admin']],
        TotalRecordCount: 3, StartIndex: 0 }, route);
    };
    for (const route of ['/Devices', '/Devices?userId=', '/Devices?userId=%20', '/Devices?userId=00000000000000000000000000000000',
      `/Devices?userId=${adminUser.Id}`, `/Devices?userId=${readerUser.Id}`, `/Devices?userId=${adminUser.Id}&userId=bad`]) await assertList(route);
    assert.deepEqual(await call('/Devices?userId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { status: 404, contentType: 'text/plain', body: 'Error processing request.' });
    let result = await call('/Devices?userId=bad');
    assert.equal(result.status, 400);
    assert.deepEqual(result.body.errors, { userId: ["The value 'bad' is not valid."] });
    assert.deepEqual(await call('/Devices', { token: reader.AccessToken, device: 'management-reader' }), { status: 403, contentType: null, body: '' });
    assert.deepEqual(await call('/Devices', { token: null, device: 'management-none' }), { status: 401, contentType: null, body: '' });

    assert.deepEqual((await call('/Devices/Info?id=management-admin')).body, expected['management-admin']);
    assert.deepEqual((await call('/Devices/Info?id=management-admin&id=missing')).body, expected['management-admin']);
    for (const route of ['/Devices/Info', '/Devices/Info?id=', '/Devices/Info?id=%20', '/Devices/Options', '/Devices/Options?id=', '/Devices/Options?id=%20']) {
      result = await call(route);
      assert.equal(result.status, 400, route);
      assert.deepEqual(result.body.errors, { id: ['The id field is required.'] }, route);
    }
    for (const route of ['/Devices/Info?id=missing', '/Devices/Info?id=MANAGEMENT-ADMIN', '/Devices/Options?id=management-admin']) {
      result = await call(route);
      assert.equal(result.status, 404, route);
      assert.equal(result.body.title, 'Not Found', route);
    }

    result = await call('/Devices/Options?id=management-admin', { method: 'POST', source: '{}', contentType: null });
    assert.equal(result.status, 415);
    assert.equal(result.body.title, 'Unsupported Media Type');
    for (const source of ['', 'null']) {
      result = await call('/Devices/Options?id=management-admin', { method: 'POST', source });
      assert.equal(result.status, 400, source);
      assert.deepEqual(result.body.errors, { '': ['A non-empty request body is required.'], deviceOptions: ['The deviceOptions field is required.'] }, source);
    }
    result = await call('/Devices/Options?id=management-admin', { method: 'POST', source: '{"customName":{}}' });
    assert.equal(result.status, 400);
    assert.deepEqual(Object.keys(result.body.errors), ['deviceOptions', '$.customName']);
    assert.equal((await call('/Devices/Options?id=management-admin', { method: 'POST', source: '{"id":99,"deviceId":"ignored","customName":123}' })).status, 204);
    assert.deepEqual((await call('/Devices/Options?id=management-admin')).body, { Id: 1, DeviceId: 'management-admin', CustomName: '123' });
    assert.deepEqual((await call('/Devices/Info?id=management-admin')).body, { ...expected['management-admin'], CustomName: '123' });
    let session = (await call('/Sessions?deviceId=management-admin')).body[0];
    assert.equal(session.DeviceName, '123');
    assert.equal(session.HasCustomDeviceName, true);
    assert.equal((await call('/Devices/Options?id=management-admin', { method: 'POST', source: '{"customName":null}' })).status, 204);
    assert.deepEqual((await call('/Devices/Options?id=management-admin')).body, { Id: 1, DeviceId: 'management-admin' });
    session = (await call('/Sessions?deviceId=management-admin')).body[0];
    assert.equal(session.DeviceName, '123');
    assert.equal(session.HasCustomDeviceName, false);
    assert.equal((await call('/Devices/Options?id=unknown-device', { method: 'POST', source: '{"customName":"Unknown Custom"}' })).status, 204);
    assert.deepEqual((await call('/Devices/Options?id=unknown-device')).body, { Id: 2, DeviceId: 'unknown-device', CustomName: 'Unknown Custom' });
    assert.equal((await call('/Devices/Info?id=unknown-device')).status, 404);

    assert.deepEqual(await call('/Devices', { method: 'DELETE' }), { status: 204, contentType: null, body: '' });
    assert.deepEqual(await call('/Devices?id=', { method: 'DELETE' }), { status: 400, contentType: 'text/plain', body: 'Error processing request.' });
    for (const route of ['/Devices?id=management-delete,missing', '/Devices?id=management-delete&id=missing']) {
      result = await call(route, { method: 'DELETE' });
      assert.equal(result.status, 400, route);
      assert.equal(result.body.title, 'Bad Request', route);
    }
    assert.deepEqual((await call('/Devices/Info?id=management-delete')).body, expected['management-delete']);
    assert.deepEqual(await call('/Devices?id=management-delete&id=management-delete', { method: 'DELETE' }), { status: 204, contentType: null, body: '' });
    assert.equal((await call('/Devices/Info?id=management-delete')).status, 404);
    assert.equal((await runtime.store.run(db => db.rows('Devices', { where: { DeviceId: 'management-delete' } }))).length, 0);
  } finally { await runtime.close(); }
});
