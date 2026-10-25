import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { nativeGuid } from '../../src/users/native.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('an admitted login builds its complete user DTO from the current receiver configuration after session I/O', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async () => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'configuration-login-'));
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const errors = [], requests = [];
  let database, runtime, login, baseline, expected, received, before, after, failure, closed = false;
  try {
    database = await createPostgresTestDatabase(null, 'configuration_login');
    runtime = await createTestRuntime({ database, programDataPath: path.join(root, 'data'), configurationDirectoryPath: path.join(root, 'config'),
      serverId: 'configuration-login', configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true,
        CastReceiverApplications: [{ Id: 'initial-receiver', Name: 'Initial receiver' }] }, onError: error => errors.push(error) });
    const user = await runtime.users.createUser({ Name: 'Configuration login', Password: 'Controlled login password' });
    const userId = nativeGuid(user.Id);
    await runtime.apiKeys.create('Receiver configuration writer');
    const token = (await runtime.apiKeys.list()).Items[0].AccessToken;
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    const original = runtime.sessions.logActivity.bind(runtime.sessions);
    runtime.sessions.logActivity = async (auth, options) => {
      const result = await original(auth, options);
      if (auth.Client === 'ConfigurationRace') {
        baseline = JSON.parse(stringifyNativeJson(runtime.users.getUserDto(auth.User)));
        entered.resolve(); await resume.promise;
      }
      return result;
    };
    const call = async (route, options = {}) => {
      const response = await fetch(origin + route, options);
      const text = await response.text(), contentType = response.headers.get('content-type');
      const observation = { route, status: response.status, contentType, text,
        body: contentType?.includes('json') ? JSON.parse(text) : text };
      requests.push(observation); return observation;
    };
    login = call('/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="ConfigurationRace", Device="Controlled", DeviceId="configuration-login", Version="1"' },
      body: JSON.stringify({ Username: user.Name, Pw: 'Controlled login password' }) });
    void login.catch(() => {});
    await Promise.race([entered.promise, login.then(() => { throw new Error('The login must reach its actual session I/O boundary.'); })]);
    assert.equal(baseline.Configuration.CastReceiverId, 'initial-receiver');
    before = await runtime.store.run(async db => ({ users: await db.rows('Users', { where: { Id: userId } }),
      preferences: await db.rows('Preferences', { where: { UserId: userId } }) }));
    assert.equal(before.users.length, 1); assert.ok(before.preferences.length > 0);
    const headers = { 'X-Emby-Token': token, 'Content-Type': 'application/json' };
    const configuration = (await call('/System/Configuration', { headers })).body;
    const response = await call('/System/Configuration', { method: 'POST', headers,
      body: JSON.stringify({ ...configuration, CastReceiverApplications: [{ Id: 'current-receiver', Name: 'Current receiver' }] }) });
    assert.equal(response.status, 204);
    after = await runtime.store.run(async db => ({ users: await db.rows('Users', { where: { Id: userId } }),
      preferences: await db.rows('Preferences', { where: { UserId: userId } }) }));
    assert.deepEqual(after, before, 'Changing receiver availability does not rewrite stored user preferences or its original receiver id.');
    expected = { ...baseline, Configuration: { ...baseline.Configuration, CastReceiverId: 'current-receiver' } };
    resume.resolve();
    received = await login; assert.equal(received.status, 200);
    assert.deepEqual(received.body.User, expected);
    const current = await call('/Users/' + user.Id, { headers });
    assert.equal(current.status, 200); assert.deepEqual(current.body.Configuration, expected.Configuration);
    assert.deepEqual(errors, []);
    await runtime.close(); closed = true; runtime = undefined;
    assert.deepEqual(errors, []);
  } catch (error) { failure = error; throw error; }
  finally {
    resume.resolve(); await Promise.allSettled([login]);
    const describeFailure = error => error == null ? null : { message: error.message, code: error.code, status: error.status,
      ...(error.cause !== undefined && { cause: describeFailure(error.cause) }), ...(Array.isArray(error.errors) && { errors: error.errors.map(describeFailure) }) };
    try { await runtime?.close(); if (runtime) closed = true; }
    finally {
      await fs.writeFile(path.join(output, 'server-configuration-login.json'), JSON.stringify({ requests, baseline, expected, before, after,
        closed, errors: errors.map(describeFailure), failure: describeFailure(failure) }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
      await dropPostgresTestDatabase(database);
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('configuration-login-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
