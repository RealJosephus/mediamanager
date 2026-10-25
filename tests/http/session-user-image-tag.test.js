import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';

import { PostgresDatabase } from '../../src/database/postgres.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { userImageTag } from '../../src/users/user-service.js';
import { SessionService } from '../../src/sessions/service.js';
import nativeImageStages from '../sessions/fixtures/session-user-image-tag.json' with { type: 'json' };

const client = {
  Client: 'SessionUserImageTagTest',
  Device: 'Image tag device',
  DeviceId: 'session-user-image-tag',
  Version: '1.0'
};

const images = nativeImageStages;

test('user image tags use strict native DateTime ticks and Guid byte order', () => {
  for (const [LastModified, expected] of [
    ['0001-01-01 00:00:00', '586c868d3c5016358873f00cf1a5ddd7'],
    ['2026-09-27 12:34:56', '542da255d0efe6dff9ce7fe2f9058170'],
    ['2026-09-27 12:34:56.1', '45f352b805407265712e0a5ef17df337'],
    ['2026-09-27 12:34:56.123456', '40e0a7bb7919d9955c0fbe2113e0fc73'],
    ['2026-09-27 12:34:56.1234567', '00206177c12fb024418ef56f33be2308'],
    ['2000-02-29 12:34:56.1', '48734c2fc0c1bcd2c6ad25a19e634014'],
    ['9999-12-31 23:59:59.9999999', '3577d937ddfea76dc26d53744182f3b5']
  ]) assert.equal(userImageTag({ Path: 'X', LastModified }), expected, LastModified);
  for (const LastModified of ['0000-01-01 00:00:00', '2026-02-30 00:00:00', '2026-09-27 24:00:00',
    '2026-09-27 12:34:56.12345678', '2026-09-27 12:34:56+00:00']) {
    assert.throws(() => userImageTag({ Path: 'X', LastModified }), /Invalid stored user image date/, LastModified);
  }
});

test('session activity returns no image tag on failure and restores it in the same session', async t => {
  const marker = Object.assign(new Error('profile image tag failed'), { code: 'controlled-profile-image' });
  const failureValue = error => ({ message: error?.message, code: error?.code ?? null,
    status: error?.status ?? error?.statusCode ?? null });
  const imageTagFailures = [];
  const errors = [];
  let failImageTag = true;
  const users = new EventEmitter();
  users.primaryImageTag = () => {
    if (failImageTag) { imageTagFailures.push(marker); throw marker; }
    return images.updated.tag;
  };
  const database = { rows: async () => [] };
  const store = { run: operation => operation(database), transaction: operation => operation(database) };
  const sessions = new SessionService({ store, users, serverId: 'image-tag-error-test', automaticProgress: false,
    onError: error => errors.push({ duringImageFailure: failImageTag, error }) });
  const auth = { Client: 'ImageTagError', Device: 'Device', DeviceId: 'image-tag-error',
    Version: '1', User: { Id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', Username: 'ImageTagErrorUser' } };
  try {
    const session = await sessions.logActivity(auth);
    assert.equal(session.UserPrimaryImageTag, null);
    assert.ok(imageTagFailures.length > 0, 'The controlled image lookup must actually fail.');
    assert.deepEqual(await sessions.getSessions(auth, { deviceId: auth.DeviceId }), [session]);

    failImageTag = false;
    const recovered = await sessions.logActivity({ ...auth, Device: 'Recovered device', Version: '2' });
    assert.equal(recovered.Id, session.Id);
    assert.equal(recovered.UserPrimaryImageTag, images.updated.tag);
    assert.equal(recovered.DeviceName, 'Recovered device');
    assert.equal(recovered.ApplicationVersion, '2');
    assert.equal(recovered.UserName, auth.User.Username);
    assert.deepEqual(await sessions.getSessions(auth, { deviceId: auth.DeviceId }), [recovered]);
  } finally {
    failImageTag = false;
    try { await sessions.close(); }
    finally { t.diagnostic(inspect({ imageTagFailures, errors }, { depth: null })); }
  }
  for (const { duringImageFailure, error } of errors) {
    assert.equal(duringImageFailure, true, 'Recovery and normal close must not report a session failure.');
    assert.ok(imageTagFailures.some(failure => {
      const actual = failureValue(error), expected = failureValue(failure);
      return actual.message === expected.message && actual.code === expected.code && actual.status === expected.status;
    }), 'Only an actual controlled image lookup failure may classify its diagnostic.');
  }
});

test('PostgreSQL: session user image tags follow profile image changes without mutating ImageInfos',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const schema = `session_image_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const database = await PostgresDatabase.open({ connectionString, schema, create: true });
    const errors = [];
    const runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: 'session-user-image-tag-test', serverName: 'Session user image tag test', onError: error => errors.push(error) });
    runtime.sessions.automaticProgress = false;

    try {
      const created = await runtime.users.createUser({ Name: 'SessionImageUser', Password: 'test-password' });
      const userId = nativeGuid(created.Id);
      const image = await database.insert('ImageInfos', { UserId: userId,
        Path: images.initial.Path, LastModified: images.initial.LastModified });

      const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
      const authorization = token => `MediaBrowser Client="${client.Client}", Device="${client.Device}", DeviceId="${client.DeviceId}", Version="${client.Version}"${token ? `, Token="${token}"` : ''}`;
      async function call(route, { token, method = 'GET', body } = {}) {
        const response = await fetch(origin + route, { method, headers: {
          Authorization: authorization(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        }, ...(body === undefined ? {} : { body: stringifyNativeJson(body) }) });
        const text = await response.text();
        return { status: response.status,
          body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
      }
      const imageState = async () => (await database.rows('ImageInfos', { where: { UserId: userId } })).map(row => ({
        Id: row.Id, UserId: row.UserId, Path: row.Path, LastModified: row.LastModified
      }));
      const expectedImage = values => [{ Id: image.Id, UserId: userId, Path: values.Path, LastModified: values.LastModified }];
      const userTag = value => value?.PrimaryImageTag ?? null;
      const sessionTag = value => value?.UserPrimaryImageTag ?? null;

      const login = await call('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'SessionImageUser', Pw: 'test-password' } });
      assert.equal(login.status, 200);
      const token = login.body.AccessToken;
      const readProjection = async () => {
        const user = await call(`/Users/${created.Id}`, { token });
        const sessions = await call(`/Sessions?deviceId=${client.DeviceId}`, { token });
        assert.equal(user.status, 200);
        assert.equal(sessions.status, 200);
        assert.equal(sessions.body.length, 1);
        return { user: userTag(user.body), session: sessionTag(sessions.body[0]) };
      };

      const observed = {
        initial: {
          loginUser: userTag(login.body.User),
          loginSession: sessionTag(login.body.SessionInfo),
          ...await readProjection()
        }
      };
      assert.deepEqual(await imageState(), expectedImage(images.initial));

      await database.update('ImageInfos', { Id: image.Id }, {
        Path: images.updated.Path, LastModified: images.updated.LastModified
      });
      observed.updatedBeforeActivity = await readProjection();
      assert.equal((await call('/Sessions/Capabilities', { token, method: 'POST' })).status, 204);
      observed.updated = await readProjection();
      assert.deepEqual(await imageState(), expectedImage(images.updated));

      await database.delete('ImageInfos', { Id: image.Id });
      observed.deletedBeforeActivity = await readProjection();
      assert.equal((await call('/Sessions/Capabilities', { token, method: 'POST' })).status, 204);
      observed.deleted = await readProjection();
      assert.deepEqual(await imageState(), []);
      assert.deepEqual(errors, []);

      assert.deepEqual(observed, {
        initial: { loginUser: images.initial.tag, loginSession: images.initial.tag,
          user: images.initial.tag, session: images.initial.tag },
        updatedBeforeActivity: { user: images.updated.tag, session: images.initial.tag },
        updated: { user: images.updated.tag, session: images.updated.tag },
        deletedBeforeActivity: { user: null, session: images.updated.tag },
        deleted: { user: null, session: null }
      });
    } finally {
      await runtime.close();
      const cleanup = await PostgresDatabase.open({ connectionString, schema });
      try {
        await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`);
      } finally {
        await cleanup.close();
      }
    }
    assert.deepEqual(errors, [], 'Successful image updates and normal runtime close must not report a failure.');
  });
