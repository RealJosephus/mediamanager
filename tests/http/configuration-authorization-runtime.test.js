import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { nativeGuid } from '../../src/users/native.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres'];

test('configuration controller combines user remote access and elevation through real HTTP and PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'configuration-authorization-'));
  const configurationDirectoryPath = path.join(root, 'config');
  const report = { http: [], snapshots: [], errors: [], actualNativeExecuted: false };
  let database, runtime;
  t.after(async () => {
    const errors = [];
    try { await runtime?.close(); report.runtimeClosed = true; } catch (error) { errors.push(error); }
    try { await dropPostgresTestDatabase(database); report.databaseDropped = true; } catch (error) { errors.push(error); }
    report.cleanupErrors = errors.map(errorObservation);
    await fs.writeFile(path.join(output, path.basename(root) + '.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
    assert.equal(path.dirname(root), output); await fs.rm(root, { recursive: true });
    if (errors.length) throw new AggregateError(errors, 'Configuration authorization fixture cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'configuration_authorization');
  runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'data'), configurationDirectoryPath,
    serverId: 'configuration-authorization', configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true },
    networkConfiguration: { KnownProxies: ['127.0.0.1'], EnableRemoteAccess: true },
    onError: error => report.errors.push(errorObservation(error)) });
  const origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port;
  const request = async (route, { method = 'GET', token, body, remote = false, actor = 'administrator' } = {}) => {
    const response = await fetch(origin + route, { method, signal: t.signal,
      headers: { Authorization: `MediaBrowser Client="Configuration authorization", Device="Isolated", DeviceId="${actor}", Version="1"${token ? `, Token="${token}"` : ''}`,
        ...(remote ? { 'X-Forwarded-For': '203.0.113.41' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(), contentType = response.headers.get('content-type');
    const result = { status: response.status, contentType, text, body: text && contentType?.includes('json') ? JSON.parse(text) : null };
    report.http.push({ route, method, remote, actor, status: result.status, contentType,
      ...(route === '/Users/AuthenticateByName' ? { userPolicy: result.body?.User?.Policy } : { text }) });
    return result;
  };
  const administrator = await runtime.users.createUser({ Name: 'Restricted administrator', Password: 'Isolated administrator password' });
  await runtime.users.updatePolicy(administrator.Id, { ...administrator.Policy, IsAdministrator: true, EnableRemoteAccess: false });
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: administrator.Name, Pw: 'Isolated administrator password' } });
  assert.equal(login.status, 200); assert.equal(login.body.User.Policy.IsAdministrator, true);
  assert.equal(login.body.User.Policy.EnableRemoteAccess, false);
  const token = login.body.AccessToken;
  const key = (await runtime.apiKeys.create('Configuration regression')).AccessToken;
  const routes = ['/System/Configuration', '/System/Configuration/metadata', '/System/Configuration/livetv', '/System/Configuration/Branding'];
  const configurations = [];
  for (const route of routes) {
    const read = await request(route, { token }); assert.equal(read.status, 200);
    configurations.push(read.body);
    assert.equal((await request(route, { method: 'POST', token, body: read.body })).status, 204);
  }
  const snapshot = async () => {
    const files = {};
    for (const name of ['system.xml', 'metadata.xml', 'livetv.xml', 'branding.xml']) files[name] = (await fs.readFile(path.join(configurationDirectoryPath, name))).toString('base64');
    const permissions = await database.rows('Permissions', { where: { UserId: nativeGuid(administrator.Id) } });
    const state = { files, permissions }; report.snapshots.push(state); return state;
  };
  const before = await snapshot(), denied = [];
  for (const [index, route] of routes.entries()) {
    denied.push(await request(route, { token, remote: true }));
    const changes = index === 0 ? { ServerName: 'Unauthorized remote replacement' }
      : index === 1 ? { UseFileCreationTimeForDateAdded: !configurations[index].UseFileCreationTimeForDateAdded }
        : index === 2 ? { GuideDays: 11 } : { CustomCss: 'body { color: red; }' };
    denied.push(await request(route, { method: 'POST', token, remote: true, body: { ...configurations[index], ...changes } }));
  }
  denied.push(await request('/System/Configuration/MetadataOptions/Default', { token, remote: true }));
  const after = await snapshot();
  assert.deepEqual(denied.map(value => value.status), Array(routes.length * 2 + 1).fill(403));
  assert.deepEqual(after, before, 'Rejected configuration requests leave the actual XML bytes and persisted user permissions intact.');
  assert.equal((await request('/Auth/Providers', { token, remote: true })).status, 200,
    'An action with only the native elevation policy keeps its original authorization semantics.');
  for (const [index, route] of routes.entries()) {
    assert.equal((await request(route, { token: key, remote: true, actor: 'api-key' })).status, 200);
    assert.equal((await request(route, { method: 'POST', token: key, remote: true, actor: 'api-key', body: configurations[index] })).status, 204);
  }
  const reader = await runtime.users.createUser({ Name: 'Configuration reader', Password: 'Isolated reader password' });
  const readerLogin = await request('/Users/AuthenticateByName', { method: 'POST', actor: 'reader', body: { Username: reader.Name, Pw: 'Isolated reader password' } });
  assert.equal(readerLogin.status, 200);
  for (const [index, route] of routes.entries()) {
    assert.equal((await request(route, { token: readerLogin.body.AccessToken, remote: true, actor: 'reader' })).status, 200);
    assert.equal((await request(route, { method: 'POST', token: readerLogin.body.AccessToken, remote: true, actor: 'reader', body: configurations[index] })).status, 403);
  }
  assert.deepEqual(report.errors, []);
});
