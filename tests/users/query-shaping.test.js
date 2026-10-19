import test from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../../src/users/user-service.js';
import { DeviceService } from '../../src/users/device-service.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { ApiKeyService } from '../../src/users/api-key-service.js';
import { SessionService } from '../../src/sessions/service.js';
import { emptyGuid } from '../../src/sessions/user-data.js';
import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { AUTHENTICATION_PROVIDER, PASSWORD_RESET_PROVIDER } from '../../src/users/native.js';

const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';
const storeFor = database => ({
  database,
  run: operation => operation(database),
  transaction: operation => operation(database)
});

test('PostgreSQL user discovery and creation use parameterized aggregate/filter SQL instead of whole-table rows', async () => {
  const queries = [], inserts = [], batches = [], rowCalls = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    client: { async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes('COALESCE(MAX')) return { rows: [{ duplicate: false, maximum: 50000n }] };
      return { rows: [{ Id: nativeTextBytes(userId) }] };
    } },
    async rows(name, options) { rowCalls.push({ name, options }); throw new Error(`unexpected rows(${name})`); },
    async insert(name, values) { inserts.push({ name, values }); return values; },
    async insertBatch(name, values) { batches.push({ name, values }); return BigInt(values.length); }
  };
  const users = new UserService({ store: storeFor(database), serverId: 'a'.repeat(32) });
  users.loadUser = async (_database, id) => ({ Id: id, Username: 'Visible', Policy: {
    IsHidden: false, IsDisabled: false, EnableRemoteAccess: true
  } });
  users.loadUsers = async (_database, ids) => ids.map(id => ({ Id: id, Username: 'Visible', Policy: {
    IsHidden: false, IsDisabled: false, EnableRemoteAccess: true
  } }));
  users.getUserDto = user => ({ Id: user.Id, Name: user.Username });

  assert.deepEqual(await users.listUsers({ publicOnly: true, startupWizardCompleted: false }), [
    { Id: userId, Name: 'Visible' }
  ]);
  const created = await users.createUser({ Name: 'New User', Password: null });
  assert.equal(created.Name, 'Visible');
  assert.equal(inserts.find(call => call.name === 'Users').values.InternalId, 50001n);
  assert.deepEqual(batches.map(call => call.name), ['Permissions', 'Preferences']);
  assert.ok(batches.every(call => call.values.length > 1));
  assert.equal(inserts.some(call => call.name === 'Permissions' || call.name === 'Preferences'), false);
  assert.equal(rowCalls.length, 0);
  assert.match(queries[0].sql, /EXISTS .*"Permissions"/su);
  assert.deepEqual(queries[0].parameters, [1, 2]);
  assert.match(queries[1].sql, /EXISTS .*\$1.*MAX\("InternalId"\)/su);
  assert.deepEqual(queries[1].parameters, [nativeTextBytes('NEW USER')]);
});

test('PostgreSQL user listing filters and sorts identities in SQL then bulk-loads every relation', async () => {
  const queries = [], rowCalls = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    client: { async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{ Id: nativeTextBytes(otherUserId) }, { Id: nativeTextBytes(userId) }] };
    } },
    async rows(name, options) {
      rowCalls.push({ name, options });
      if (name === 'Users') return [
        { Id: userId, Username: 'Zulu', AuthenticationProviderId: AUTHENTICATION_PROVIDER, PasswordResetProviderId: PASSWORD_RESET_PROVIDER },
        { Id: otherUserId, Username: 'Alpha', AuthenticationProviderId: AUTHENTICATION_PROVIDER, PasswordResetProviderId: PASSWORD_RESET_PROVIDER },
      ];
      return [];
    }
  };
  const users = new UserService({
    store: storeFor(database),
    serverId: 'a'.repeat(32),
    isLocalNetwork: () => false,
    getDeviceCapabilities: () => ({ SupportsPersistentIdentifier: true })
  });
  users.getPolicy = () => ({ IsHidden: false, IsDisabled: false, EnableRemoteAccess: true,
    EnableAllDevices: false, IsAdministrator: false, EnabledDevices: ['device'] });
  users.getConfiguration = () => ({});
  users.getUserDto = user => ({ Id: user.Id, Name: user.Username });

  assert.deepEqual(await users.listUsers({ publicOnly: true, deviceId: 'device', remoteEndPoint: 'remote' }), [
    { Id: otherUserId, Name: 'Alpha' },
    { Id: userId, Name: 'Zulu' },
  ]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /"EnableRemoteAccess"|"Permissions"/u);
  assert.match(queries[0].sql, /CROSS JOIN LATERAL unnest[\s\S]*mm_ordinal_ignore_case_key[\s\S]*ORDER BY/u);
  assert.doesNotMatch(queries[0].sql, /btrim\(/u,
    'stored device identifiers retain their exact whitespace semantics');
  assert.deepEqual(rowCalls.map(call => call.name), [
    'Users', 'Permissions', 'Preferences', 'AccessSchedules', 'ImageInfos'
  ]);
  assert.ok(rowCalls.every(call => call.name === 'Users' || call.options.whereIn?.UserId.length === 2));
});

test('user rename and deletion checks are indexed or bounded even with a large logical user set', async () => {
  const rowCalls = [], updates = [], deletes = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    async rows(name, options) {
      rowCalls.push({ name, options });
      assert.ok(options, `rows(${name}) must be shaped`);
      if (name === 'Users' && options.where?.NormalizedUsername) return [{ Id: otherUserId }];
      if (name === 'Users' && options.limit === 2) return [{ Id: userId }, { Id: otherUserId }];
      if (name === 'Permissions') return [{ Id: 1 }, { Id: 2 }];
      throw new Error(`unexpected rows(${name})`);
    },
    async update(name, where, values) { updates.push({ name, where, values }); },
    async delete(name, where) { deletes.push({ name, where }); }
  };
  const users = new UserService({ store: storeFor(database), serverId: 'a'.repeat(32) });
  users.loadUser = async () => ({ Id: userId, Username: 'Original', RowVersion: 0n, Policy: { IsAdministrator: true } });
  users.updateConfiguration = async () => {};
  users.getUser = async () => ({ Id: userId });

  await assert.rejects(users.updateUser(userId, { Name: 'Taken', Configuration: {} }), /already exists/u);
  await users.deleteUser(userId);
  assert.equal(updates.length, 0);
  assert.deepEqual(deletes, [{ name: 'Users', where: { Id: userId } }]);
  assert.ok(rowCalls.every(call => call.options.where || call.options.limit === 2));
  assert.equal(rowCalls.find(call => call.options.where?.NormalizedUsername).options.limit, 2);
  assert.equal(rowCalls.filter(call => call.options.limit === 2).length, 3);
});

test('PostgreSQL enabled-user safety check uses a parameterized anti-join capped at two rows', async () => {
  const queries = [], rowCalls = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    client: { async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{ Id: nativeTextBytes(userId) }, { Id: nativeTextBytes(otherUserId) }] };
    } },
    async rows(name, options) {
      rowCalls.push({ name, options });
      if (name === 'Permissions') return [{ Id: 1 }, { Id: 2 }];
      throw new Error(`unexpected rows(${name})`);
    },
    async update() {},
    async insert(_name, values) { return values; },
    async insertBatch() {},
    async delete() {},
    async deleteWhere() {}
  };
  const current = { Id: userId, RowVersion: 0n, Policy: { IsAdministrator: false, IsDisabled: false },
    Permissions: [], Preferences: [], AccessSchedules: [] };
  const users = new UserService({ store: storeFor(database), serverId: 'a'.repeat(32) });
  users.loadUser = async () => current;

  await users.updatePolicy(userId, {
    IsDisabled: true,
    AuthenticationProviderId: 'authentication-provider',
    PasswordResetProviderId: 'password-reset-provider'
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /NOT EXISTS .*"Permissions"[\s\S]*LIMIT 2/u);
  assert.deepEqual(queries[0].parameters, [2]);
  assert.deepEqual(rowCalls, [{ name: 'Permissions', options: {
    where: { Kind: 0, Value: true }, columns: ['Id'], limit: 2
  } }]);
});

test('PostgreSQL policy replacement writes an arbitrary access-schedule set in two statements', async () => {
  const deletes = [], batches = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    async rows(name) {
      if (name === 'Permissions') return [{ Id: 1 }, { Id: 2 }];
      throw new Error(`unexpected rows(${name})`);
    },
    async update() {},
    async deleteWhere(name, where) { deletes.push({ name, where }); },
    async insertBatch(name, values) { batches.push({ name, values }); },
  };
  const current = { Id: userId, RowVersion: 0n, Policy: { IsAdministrator: false, IsDisabled: false },
    Permissions: [], Preferences: [], AccessSchedules: [{ Id: 1 }, { Id: 2 }] };
  const users = new UserService({ store: storeFor(database), serverId: 'a'.repeat(32) });
  users.loadUser = async () => current;
  users.setPermission = async () => {};
  users.setPreference = async () => {};

  await users.updatePolicy(userId, {
    AuthenticationProviderId: 'authentication-provider',
    PasswordResetProviderId: 'password-reset-provider',
    AccessSchedules: Array.from({ length: 64 }, (_, index) => ({
      DayOfWeek: 'Everyday', StartHour: index % 24, EndHour: (index % 24) + 1,
    })),
  });

  assert.deepEqual(deletes, [{ name: 'AccessSchedules', where: { UserId: userId } }]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].name, 'AccessSchedules');
  assert.equal(batches[0].values.length, 64);
});

test('restricted PostgreSQL device listing filters, joins and orders in one relational query', async () => {
  const queries = [];
  const selected = 'device-8765';
  const database = {
    dialect: 'postgres', schemaName: 'public',
    client: { async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{ DeviceId: nativeTextBytes(selected), DeviceName: nativeTextBytes('Selected'), UserId: nativeTextBytes(otherUserId),
        AppName: nativeTextBytes('Client'), AppVersion: nativeTextBytes('1'), DateLastActivity: nativeTextBytes('2026-01-01 00:00:00'),
        LastUserName: nativeTextBytes('Owner'), CustomName: nativeTextBytes('Custom'), __TotalRecordCount: '1' }] };
    } }
  };
  const restricted = { Id: userId, Username: 'Owner', Policy: {
    EnableAllDevices: false, IsAdministrator: false, EnabledDevices: [selected]
  } };
  const users = {
    async loadUser(_database, id) { return id === userId || id === otherUserId ? restricted : null; },
    canAccessDevice(user, id) { return user.Policy.EnabledDevices.includes(id); }
  };
  const sessions = {
    getDeviceCapabilities: () => ({ IconUrl: null }),
    getDeviceIdsWithoutPersistentIdentifier: () => []
  };
  const devices = new DeviceService({ store: storeFor(database), users, sessions });

  const result = await devices.list(userId);
  assert.equal(result.TotalRecordCount, 1);
  assert.equal(result.Items[0].Id, selected);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /count\(\*\) OVER[\s\S]*JOIN "Users"[\s\S]*LEFT JOIN LATERAL[\s\S]*mm_ordinal_ignore_case_key[\s\S]*ORDER BY/u);
  assert.deepEqual(queries[0].parameters, [[nativeTextOrdinalIgnoreCaseKey('device-8765')]]);
});

test('API-key listing projects a complete stable response from bounded database pages', async () => {
  const calls = [];
  const database = { dialect: 'postgres', schemaName: 'public', async transaction(operation, options) {
    calls.push({ transaction: options }); return operation(this);
  }, async rows(name, options) {
    calls.push({ name, options });
    assert.equal(options.limit, 128);
    const start = options.after?.Id ?? 0;
    return Array.from({ length: Math.min(options.limit, 10000 - start) }, (_, offset) => ({
      Id: start + offset + 1, AccessToken: `token-${start + offset}`, Name: `key-${start + offset}`, DateCreated: '2026-01-01 00:00:00'
    }));
  } };
  const apiKeys = new ApiKeyService({ store: storeFor(database) });
  const result = await apiKeys.list(); await apiKeys.close();
  assert.equal(result.TotalRecordCount, 10000);
  assert.equal(result.Items[0].AccessToken, 'token-0'); assert.equal(result.Items.at(-1).AccessToken, 'token-9999');
  assert.deepEqual(calls[0], { transaction: { readOnly: true, isolation: 'repeatable-read' } });
  assert.ok(calls.slice(1).every(call => call.name === 'ApiKeys' && call.options.columns.join(',') === 'Id,AccessToken,Name,DateCreated'));
});

test('PostgreSQL device deletion is atomic while token revocation preserves per-device commits', async () => {
  const deleted = [], ended = [];
  const database = {
    dialect: 'postgres', schemaName: 'public',
    async rows(name, options) {
      if (name === 'Devices' && options.whereIn?.DeviceId) {
        return options.whereIn.DeviceId.map(DeviceId => ({ DeviceId }));
      }
      if (name === 'Devices' && options.where?.UserId) return [
        { Id: 1, DeviceId: 'first-device', AccessToken: 'FIRST-TOKEN' },
        { Id: 2, DeviceId: 'second-device', AccessToken: 'SECOND-TOKEN' },
      ];
      throw new Error(`unexpected rows(${name})`);
    },
    async deleteWhere(name, where, options) {
      deleted.push({ name, where, options, ended: [...ended] });
      return 1n;
    },
    async delete(name, where) {
      deleted.push({ name, where, options: undefined, ended: [...ended] });
      return 1n;
    },
  };
  const sessions = { async endByDevice(id) { ended.push(id); } };
  const devices = new DeviceService({ store: storeFor(database), users: {}, sessions });
  assert.equal(await devices.delete(['device-a', 'device-b']), true);
  assert.deepEqual(deleted[0], { name: 'Devices', where: {},
    options: { whereIn: { DeviceId: ['device-a', 'device-b'] } }, ended: [] });
  assert.deepEqual(ended, ['device-a', 'device-b']);

  ended.length = 0;
  const authentication = new AuthenticationService({
    store: storeFor(database), users: {}, sessions, serverId: 'a'.repeat(32),
  });
  await authentication.revokeUserTokens(userId, 'first-token');
  assert.deepEqual(deleted[1], { name: 'Devices', where: { Id: 2 }, options: undefined, ended: [] });
  assert.deepEqual(ended, ['second-device']);

  const apiKeys = new ApiKeyService({ store: storeFor(database) });
  await apiKeys.revoke('api-token'); await apiKeys.close();
  assert.deepEqual(deleted[2], { name: 'ApiKeys', where: { AccessToken: 'api-token' },
    options: undefined, ended: ['second-device'] });
});

test('PostgreSQL login preserves native per-device delete commits before inserting the replacement', async () => {
  const operations = [], notifications = [];
  const user = { Id: userId, MaxActiveSessions: 0, Policy: { IsAdministrator: false } };
  const database = {
    dialect: 'postgres', schemaName: 'public',
    async rows(name, options) {
      operations.push(['rows', name, options]);
      return [
        { Id: 1, DeviceId: 'same-device', AccessToken: 'old-1' },
        { Id: 2, DeviceId: 'same-device', AccessToken: 'old-2' },
      ];
    },
    async delete(name, where) { operations.push(['delete', name, where]); },
    async insert(name, values) {
      operations.push(['insert', name, values]);
      return values;
    },
  };
  const users = {
    async authenticateUser() { return user; },
    canAccessDevice() { return true; },
    getUserDto(value) { return { Id: value.Id }; },
  };
  const sessions = {
    countUserSessions() { return 0; },
    async endByDevice(id) { notifications.push(`end:${id}`); },
    async logActivity() {
      notifications.push('log');
      return { Id: 'session' };
    },
  };
  const authentication = new AuthenticationService({
    store: storeFor(database), users, sessions, serverId: 'a'.repeat(32),
    now: () => new Date('2026-10-09T00:00:00Z'),
  });
  const result = await authentication.login({ Username: 'name', Pw: 'password' }, {
    Client: 'Client', DeviceId: 'same-device', Device: 'Device', Version: '1',
  });

  assert.equal(result.SessionInfo.Id, 'session');
  assert.deepEqual(operations.slice(0, 3), [
    ['rows', 'Devices', { where: { UserId: userId, DeviceId: 'same-device' },
      columns: ['Id', 'DeviceId', 'AccessToken'] }],
    ['delete', 'Devices', { Id: 1 }],
    ['delete', 'Devices', { Id: 2 }],
  ]);
  assert.equal(operations.filter(call => call[0] === 'delete').length, 2);
  assert.equal(operations.filter(call => call[0] === 'insert').length, 1);
  assert.deepEqual(notifications, ['end:same-device', 'end:same-device', 'log']);
});

test('session fallback user lookup is an exact bounded query', async t => {
  const calls = [];
  const database = { dialect: 'postgres', schemaName: 'public', async rows(name, options) {
    calls.push({ name, options });
    if (name === 'DeviceOptions') return [];
    if (name === 'Users') return [{ Id: userId, Username: 'Attached', Policy: { IsAdministrator: false } }];
    throw new Error(`unexpected rows(${name})`);
  } };
  const sessions = new SessionService({ store: storeFor(database), library: {}, userData: {}, users: null,
    serverId: 'a'.repeat(32), automaticProgress: false });
  t.after(() => sessions.close());
  const session = await sessions.logActivity({ Client: 'Client', DeviceId: 'device', Device: 'Device', Version: '1',
    User: null, UserId: emptyGuid });
  await sessions.addUser(session.Id, userId);
  const lookup = calls.find(call => call.name === 'Users');
  assert.deepEqual(lookup.options, { where: { Id: userId }, limit: 1 });
  assert.ok(calls.every(call => call.options));
});
