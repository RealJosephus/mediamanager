import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { nativeGuid } from '../../src/users/native.js';
import { copyUserData } from '../../src/users/user-data-copy.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const bytes = await readFile(new URL('./fixtures/emby-user-data-copy/reference.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a589a699d61ee42e3d58687fad8d3a3e3f4a0b91a5c6cafe614ace5ed360dbbb');
const reference = JSON.parse(bytes), native = label => reference.records.find(record => record.label === label);

for (const [label, reason] of [['false', false], ['zero', 0], ['empty string', ''], ['null', null], ['undefined', undefined]]) {
  test(`user copy preserves a ${label} failure after its first real PostgreSQL target commits`, {
    skip: !postgresTestConnectionString, timeout: 60000,
  }, async t => {
    const database = await createPostgresTestDatabase(null, 'copy_prefix');
    const store = new DomainStore(database);
    let observer;
    t.after(async () => {
      const failures = [];
      for (const close of [() => store.close(), () => observer?.close(), () => dropPostgresTestDatabase(database)]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'User copy prefix fixture cleanup failed.');
    });
    observer = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    const sourceId = nativeGuid('6c010000-0000-0000-0000-000000000001');
    const targetIds = [2, 3, 4].map(index => nativeGuid(`6c010000-0000-0000-0000-${String(index).padStart(12, '0')}`));
    const itemId = nativeGuid('6c020000-0000-0000-0000-000000000001');
    await database.insertBatch('Users', [sourceId, ...targetIds].map((Id, index) => postgresTestRow('Users', {
      Id, InternalId: BigInt(index + 1), Username: `Copy prefix ${index}`, NormalizedUsername: `COPY PREFIX ${index}`,
    })));
    await database.insert('BaseItems', postgresTestRow('BaseItems', {
      Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Data: '{}', Name: 'Copy prefix original',
      SortName: 'copy prefix original', Path: '/copy-prefix/original.mkv', IsFolder: false,
    }));
    await database.insert('UserData', postgresTestRow('UserData', {
      ItemId: itemId, UserId: sourceId, CustomDataKey: 'original\0台', IsFavorite: true, Played: true,
      PlayCount: 7, PlaybackPositionTicks: 9007199254740993n, LastPlayedDate: '2026-10-20 16:59:43.1234567',
      Likes: false, Rating: 8.25, AudioStreamIndex: 2, SubtitleStreamIndex: null,
    }));
    await database.insert('UserData', postgresTestRow('UserData', {
      ItemId: itemId, UserId: targetIds[0], CustomDataKey: 'target-only', PlayCount: 19,
    }));
    const sourceRows = await observer.rows('UserData', { where: { UserId: sourceId } });
    const retainedRows = await observer.rows('UserData', { where: { UserId: targetIds[0] } });
    const users = { async loadUser(db, Id) { return (await db.rows('Users', { where: { Id }, limit: 1 }))[0]; } };
    const services = { store, users };
    const transaction = store.transaction;
    let completedTargets = 0, rolledBackRows;
    store.transaction = (operation, options) => transaction.call(store, async db => {
      const value = await operation(db);
      if (++completedTargets === 2) {
        rolledBackRows = await db.rows('UserData', { where: { UserId: targetIds[1] } });
        throw reason;
      }
      return value;
    }, options);
    let outcome;
    try {
      outcome = await copyUserData(services, sourceId, targetIds, ['userdata']).then(
        value => ({ fulfilled: true, value }), error => ({ fulfilled: false, reason: error }));
    } finally { store.transaction = transaction; }
    const afterFailure = await Promise.all(targetIds.map(UserId => observer.rows('UserData', { where: { UserId } })));
    const sourceAfterFailure = await observer.rows('UserData', { where: { UserId: sourceId } });
    await copyUserData(services, sourceId, targetIds, ['userdata']);
    const afterRecovery = await Promise.all(targetIds.map(UserId => observer.rows('UserData', { where: { UserId } })));
    t.diagnostic(JSON.stringify({ label, outcome: { fulfilled: outcome.fulfilled, reasonType: typeof outcome.reason },
      sourceRows, rolledBackRows, afterFailure, afterRecovery }, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    const copied = UserId => sourceRows.map(row => ({ ...row, UserId }));
    const byKey = rows => Object.fromEntries(rows.map(row => [row.ItemId + '/' + row.CustomDataKey, row]));
    assert.deepEqual(sourceAfterFailure, sourceRows);
    assert.deepEqual(rolledBackRows, copied(targetIds[1]), 'The failing target must actually write before its transaction rolls back.');
    assert.deepEqual(byKey(afterFailure[0]), byKey([...copied(targetIds[0]), ...retainedRows]));
    assert.deepEqual(afterFailure[1], []); assert.deepEqual(afterFailure[2], []);
    for (let index = 0; index < targetIds.length; index++) {
      assert.deepEqual(byKey(afterRecovery[index]), byKey([...copied(targetIds[index]), ...(index === 0 ? retainedRows : [])]));
    }
    assert.deepEqual(await observer.rows('UserData', { where: { UserId: sourceId } }), sourceRows);
    assert.equal(outcome.fulfilled, false, 'A failed copy must not report success after preserving its committed prefix.');
    assert.ok(Object.is(outcome.reason, reason));
  });
}

test('Emby user copy preserves SQL histories, replaces settings and sends each client its own update message', {
  skip: !postgresTestConnectionString, timeout: 90000,
}, async t => {
  assert.equal(reference.source.referenceUnchanged, true);
  assert.equal(reference.source.runtimeUnchanged, true);
  assert.equal(reference.source.processesStopped, true);
  assert.equal(reference.source.instanceRemoved, true);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-user-copy-')));
  const configuration = { IsStartupWizardCompleted: true };
  const serverId = randomUUID().replaceAll('-', ''), errors = [], sockets = [], secrets = new Set([postgresTestConnectionString]);
  let runtime, database, phase = 'setup';
  const options = { configuration, networkConfiguration: { BaseUrl: '/media' }, serverId, programDataPath: path.join(root, 'program'),
    configurationDirectoryPath: path.join(root, 'config'), onError: error => errors.push({ phase, name: error.name, code: error.code, message: error.message }) };
  const closeSockets = async ({ graceful = false } = {}) => {
    const failures = [];
    for (const socket of [...sockets]) try {
      if (socket.readyState === WebSocket.CLOSED) {
        if (graceful) assert.fail('The client socket closed before its normal handshake.');
        continue;
      }
      const closed = once(socket, 'close');
      if (graceful) socket.close(1000);
      else socket.terminate();
      const [code] = await closed;
      t.diagnostic(JSON.stringify({ phase, socketClose: graceful ? 'normal-handshake' : 'failure-cleanup', code }));
      if (graceful) assert.equal(code, 1000, 'The actual close handshake must complete normally.');
    } catch (error) { failures.push(error); }
    finally {
      const index = sockets.indexOf(socket);
      if (socket.readyState === WebSocket.CLOSED && index >= 0) sockets.splice(index, 1);
    }
    if (failures.length) throw new AggregateError(failures, 'User copy client socket close failed: ' + failures[0].message);
  };
  const open = async () => {
    runtime = await createTestRuntime({ database, ...options });
  };
  t.after(async () => {
    phase = 'cleanup';
    const failures = [];
    for (const operation of [closeSockets, () => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mediamanager-user-copy-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await operation(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'User copy cleanup failed.');
  });
  try {
    database = await createPostgresTestDatabase(null, 'emby_user_copy');
    await open();
    const adminToken = (await runtime.apiKeys.create('Controlled user copy')).AccessToken;
    secrets.add(adminToken);
    const source = await runtime.users.createUser({ Name: 'Source copy reader', Password: randomUUID() });
    const targetPassword = randomUUID(); secrets.add(targetPassword);
    const target = await runtime.users.createUser({ Name: 'Target copy reader', Password: targetPassword });
    const unrelated = await runtime.users.createUser({ Name: 'Unrelated copy reader', Password: randomUUID() });
    const sourceId = nativeGuid(source.Id), targetId = nativeGuid(target.Id), unrelatedId = nativeGuid(unrelated.Id);
    const request = async (route, { method = 'GET', body, token = adminToken } = {}) => {
      const response = await fetch(`http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}/media/emby${route}${body === undefined ? '' : '?reqformat=json'}`, {
        method, headers: { Accept: 'application/json', 'Content-Type': 'text/plain',
          Authorization: `Emby Client="Emby Web", Token="${token ?? ''}"` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, type: response.headers.get('content-type'), text,
        body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined };
    };
    const login = async (client, deviceId) => {
      const result = await runtime.authentication.login({ Username: target.Name, Pw: targetPassword }, {
        Client: client, Device: 'Controlled browser', DeviceId: deviceId, Version: '1.0',
      });
      secrets.add(result.AccessToken);
      const messages = [], socket = new WebSocket(`ws://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}/media/emby?api_key=${result.AccessToken}&deviceId=${deviceId}`);
      sockets.push(socket);
      socket.on('message', data => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      const deadline = Date.now() + 10000;
      while (!messages.some(message => message.MessageType === 'ForceKeepAlive')) {
        assert.ok(Date.now() < deadline, 'The actual socket must finish session registration.');
        await delay(20);
      }
      return { messages, token: result.AccessToken };
    };
    const emby = await login('Emby Web', 'copy-emby'), jellyfin = await login('Jellyfin Web', 'copy-jellyfin');
    phase = 'copy-business';
    assert.deepEqual((await request('/Users/CopyDataOptions')).body, native('copy-options-admin').bodyJson);
    assert.equal((await request('/Users/CopyDataOptions', { token: emby.token })).status, native('copy-options-reader').status);
    assert.equal((await request('/Users/CopyDataOptions', { token: null })).status, native('copy-options-anonymous').status);
    const route = `/Users/${source.Id}/CopyData`, post = body => request(route, { method: 'POST', body });
    assert.equal((await request(route, { method: 'POST', token: emby.token,
      body: { ToUserIds: [target.Id], CopyOptions: ['userconfiguration'] } })).status, 403);
    const settings = new Map(Object.entries(native('update-reader-settings').requestBody));
    settings.set('__proto__', 'retained'); settings.set('Unicode 設定', '原值\0'); settings.set('nullable', null);
    await runtime.displayPreferences.updateUserSettings(source.Id, settings);
    await runtime.displayPreferences.updateUserSettings(target.Id, new Map(Object.entries(native('update-target-settings-before-copy').requestBody)));
    const before = await runtime.users.getUser(target.Id);
    const sourceUser = await runtime.users.getUser(source.Id);
    await runtime.users.updateConfiguration(source.Id, { ...sourceUser.Configuration,
      AudioLanguagePreference: native('update-reader-configuration').requestBody.AudioLanguagePreference,
      SubtitleLanguagePreference: native('update-reader-configuration').requestBody.SubtitleLanguagePreference });
    assert.equal((await post({ ToUserIds: [target.Id], CopyOptions: ['userconfiguration'] })).status, native('copy-user-settings').status);
    assert.deepEqual(await runtime.displayPreferences.getUserSettings(target.Id), settings);
    assert.deepEqual(await runtime.displayPreferences.getUserSettings(source.Id), settings);
    assert.equal(native('other-settings-after-copy').bodyJson.targetOnlyKey, undefined);
    const copied = await runtime.users.getUser(target.Id);
    assert.deepEqual(copied.Configuration, (await runtime.users.getUser(source.Id)).Configuration);
    for (const field of ['Id', 'Username', 'NormalizedUsername', 'Password', 'InternalId', 'LastLoginDate']) assert.deepEqual(copied[field], before[field]);
    const waitMessage = async (state, type, matches = () => true) => {
      const deadline = Date.now() + 10000;
      while (!state.messages.some(message => message.MessageType === type && matches(message))) {
        assert.ok(Date.now() < deadline, `The ${type} update must reach its actual client socket.`);
        await delay(20);
      }
      return state.messages.find(message => message.MessageType === type && matches(message));
    };
    const configurationMessage = await waitMessage(emby, 'UserConfigurationUpdated');
    const wireUser = await request(`/Users/${target.Id}`);
    assert.equal(wireUser.status, 200);
    assert.equal(configurationMessage.Data.Id, target.Id);
    assert.deepEqual(configurationMessage.Data.Configuration, wireUser.body.Configuration);
    assert.deepEqual((await waitMessage(jellyfin, 'UserUpdated')).Data.Configuration, wireUser.body.Configuration);
    assert.equal(emby.messages.some(message => message.MessageType === 'UserUpdated'), false);
    assert.equal(jellyfin.messages.some(message => message.MessageType === 'UserConfigurationUpdated'), false);
    const itemIds = Array.from({ length: 3 }, () => nativeGuid(randomUUID()));
    await database.insertBatch('BaseItems', itemIds.map((Id, index) => postgresTestRow('BaseItems', {
      Id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: 'Controlled copy audio ' + index,
      SortName: 'controlled copy audio ' + index, CleanName: 'controlled copy audio ' + index,
      MediaType: 'Audio', IsFolder: false, RunTimeTicks: 10000000n, Data: '{}', PresentationUniqueKey: Id,
    })));
    const sourceRows = Array.from({ length: 270 }, (_, index) => postgresTestRow('UserData', {
      ItemId: itemIds[0], UserId: sourceId, CustomDataKey: index === 269 ? 'Unicode\0設定' : 'source-' + index,
      IsFavorite: true, Played: true, PlayCount: index + 1, PlaybackPositionTicks: 9007199254740993n + BigInt(index),
      LastPlayedDate: '2026-10-20 16:59:43.1234567', Likes: index % 2 ? null : false,
      Rating: index % 2 ? 8.25 : null, AudioStreamIndex: 2, SubtitleStreamIndex: null,
    }));
    sourceRows.push(postgresTestRow('UserData', { ItemId: itemIds[1], UserId: sourceId, CustomDataKey: 'overlap' }));
    await database.insertBatch('UserData', sourceRows);
    await database.insertBatch('UserData', [postgresTestRow('UserData', { ItemId: itemIds[1], UserId: targetId, CustomDataKey: 'overlap', IsFavorite: true }),
      postgresTestRow('UserData', { ItemId: itemIds[2], UserId: targetId, CustomDataKey: 'target-only', IsFavorite: true }),
      postgresTestRow('UserData', { ItemId: itemIds[2], UserId: unrelatedId, CustomDataKey: 'unrelated', PlayCount: 99 })]);
    const originalRows = await database.rows('UserData', { where: { UserId: sourceId } });
    const queries = [], originalQuery = database.client.query.bind(database.client);
    database.client.query = async (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      const result = await originalQuery(...args);
      if (/"UserData"/u.test(sql)) queries.push({ sql, returned: result.rows.length, changed: result.rowCount });
      return result;
    };
    try { assert.equal((await post({ ToUserIds: [target.Id], CopyOptions: ['userdata'] })).status, native('copy-playback-data').status); }
    finally { database.client.query = originalQuery; }
    assert.ok(queries[0].sql.startsWith('INSERT INTO ') && queries[0].sql.includes('SELECT ') && queries[0].sql.includes(' WHERE "UserId" = '));
    assert.equal(queries[0].returned, 0); assert.equal(queries[0].changed, sourceRows.length);
    const targetRows = await database.rows('UserData', { where: { UserId: targetId } });
    assert.equal(targetRows.length, sourceRows.length + 1);
    const key = row => row.ItemId + '/' + row.CustomDataKey;
    const byKey = new Map(targetRows.map(row => [key(row), row]));
    for (const row of originalRows) assert.deepEqual(byKey.get(key(row)), { ...row, UserId: targetId });
    assert.equal(targetRows.find(row => row.CustomDataKey === 'target-only').IsFavorite, native('target-only-after-copy').bodyJson.UserData.IsFavorite);
    assert.equal(targetRows.find(row => row.CustomDataKey === 'overlap').IsFavorite, native('target-overlap-after-copy').bodyJson.UserData.IsFavorite);
    assert.deepEqual(await database.rows('UserData', { where: { UserId: sourceId } }), originalRows);
    assert.equal((await database.rows('UserData', { where: { UserId: unrelatedId } }))[0].PlayCount, 99);
    await delay(800);
    assert.equal(emby.messages.some(message => message.MessageType === 'UserDataChanged'), false);
    assert.equal(reference.copyMessageWindow.before, reference.copyMessageWindow.after);
    const policyInput = native('update-source-policy').requestBody;
    await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy,
      EnableContentDownloading: policyInput.EnableContentDownloading, EnableLiveTvAccess: policyInput.EnableLiveTvAccess,
      RemoteClientBitrateLimit: policyInput.RemoteClientBitrateLimit });
    assert.equal((await post({ ToUserIds: [target.Id], CopyOptions: ['userpolicy'] })).status, native('copy-user-policy').status);
    const policy = (await runtime.users.getUser(target.Id)).Policy;
    assert.deepEqual(policy, (await runtime.users.getUser(source.Id)).Policy);
    assert.equal(policy.RemoteClientBitrateLimit, native('target-policy-after-copy').bodyJson.Policy.RemoteClientBitrateLimit);
    const wirePolicy = await request(`/Users/${target.Id}`);
    assert.equal(wirePolicy.status, 200);
    assert.deepEqual((await waitMessage(emby, 'UserPolicyUpdated')).Data.Policy, wirePolicy.body.Policy);
    assert.deepEqual((await waitMessage(jellyfin, 'UserUpdated', message => message.Data.Policy.RemoteClientBitrateLimit === policy.RemoteClientBitrateLimit)).Data.Policy, wirePolicy.body.Policy);
    assert.equal(jellyfin.messages.some(message => message.MessageType === 'UserPolicyUpdated'), false);
    assert.equal((await post({ ToUserIds: [target.Id], CopyOptions: [] })).status, native('copy-with-empty-options').status);
    assert.equal((await post({ ToUserIds: [target.Id], CopyOptions: ['unknown-option'] })).status, native('copy-with-unknown-option').status);
    const missing = await post({ ToUserIds: ['00000000000000000000000000001234'], CopyOptions: ['userconfiguration'] });
    assert.equal(missing.status, native('copy-with-missing-target').status); assert.equal(missing.text, native('copy-with-missing-target').bodyText);
    assert.equal(missing.type, native('copy-with-missing-target').contentType);
    phase = 'normal-client-close';
    await closeSockets({ graceful: true });
    const schemaName = database.schemaName;
    phase = 'first-runtime-close';
    await runtime.close(); runtime = undefined;
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: schemaName });
    phase = 'cold-reopen';
    await open();
    assert.deepEqual(await runtime.displayPreferences.getUserSettings(target.Id), settings);
    assert.deepEqual((await runtime.users.getUser(target.Id)).Policy, policy);
    assert.deepEqual(await database.rows('UserData', { where: { UserId: targetId } }), targetRows);
  } catch (error) {
    let message = error.message;
    for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[credential redacted]');
    throw new Error(message);
  }
});
