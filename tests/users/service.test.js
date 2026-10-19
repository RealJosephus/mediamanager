import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserService, AuthenticationService, ApiKeyService } from '../../src/users/index.js';
import { SessionService } from '../../src/sessions/index.js';
import { nativeGuid, nativeDate, upperInvariant, wireDate, scheduleAllowed } from '../../src/users/native.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import expectedNewUser from './fixtures/native-new-user.json' with { type: 'json' };
import expectedPersistence from './fixtures/native-persistence.json' with { type: 'json' };
import { serializePasswordHash } from '../../src/core/password.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const serverId = '123456781234123412341234567890ab';
const client = { Client: 'UnitTest', Device: 'Isolated device', DeviceId: 'isolated-device', Version: '1.0' };
const network = { remoteEndPoint: '127.0.0.1' };

async function fixture(t, { logger } = {}) {
  const database = await createPostgresTestDatabase(null, 'users');
  const store = new DomainStore(database);
  let time = new Date('2026-09-26T01:02:03.123Z');
  const now = () => time;
  const users = new UserService({ store, serverId, now, castReceiverApplications: [{ Id: 'F007D354' }] });
  const sessions = new SessionService({ store, users, serverId, clock: now, automaticProgress: false });
  const authentication = new AuthenticationService({ store, users, sessions, serverId, now, logger });
  const apiKeys = new ApiKeyService({ store, now });
  t.after(async () => {
    await apiKeys.close();
    await store.close();
    await dropPostgresTestDatabase(database);
  });
  return { database, store, users, sessions, authentication, apiKeys, setTime: value => { time = new Date(value); } };
}

test('postgres: user DTO defaults match the real pinned Jellyfin HTTP response', async t => {
    const { database, users } = await fixture(t);
    const dto = await users.createUser({ Name: 'NativeReader' });
    const comparable = JSON.parse(stringifyNativeJson(dto));
    for (const key of ['Name', 'Id', 'ServerId']) delete comparable[key];
    assert.deepEqual(comparable, expectedNewUser);
    const persisted = await users.getUser(dto.Id);
    assert.match(persisted.Id, /^[0-9A-F-]{36}$/);
    assert.equal(persisted.Password, null);
    assert.equal(persisted.InternalId, 1n);
    assert.equal(persisted.RowVersion, 0n);
    assert.equal((await database.rows('Permissions')).length, 24);
    assert.equal((await database.rows('Preferences')).length, 13);
    await assert.rejects(users.createUser({ Name: 'nativereader' }), { status: 400 });
    assert.deepEqual(await users.listUsers({ publicOnly: true, ...network }), []);
  });

  test('postgres: password login persists native Devices and reauth rotates only the same user/device token', async t => {
    const { database, users, authentication, sessions } = await fixture(t);
    const created = await users.createUser({ Name: 'Reader', Password: 'correct password' });
    await assert.rejects(authentication.login({ Username: 'Reader', Pw: 'wrong' }, client, network), { status: 401 });
    assert.equal((await users.getUser(created.Id)).InvalidLoginAttemptCount, 1);
    const first = await authentication.login({ Username: 'rEaDeR', Pw: 'correct password' }, client, network);
    assert.equal(first.User.Policy.InvalidLoginAttemptCount, 1);
    assert.equal((await users.getUser(created.Id)).InvalidLoginAttemptCount, 0);
    assert.equal((await database.rows('Devices'))[0].IsActive, false);
    const request = { headers: { Authorization: `MediaBrowser Token="${first.AccessToken}"` }, url: '/' };
    const auth = await authentication.authenticate(request);
    assert.equal(auth.UserId, created.Id);
    assert.equal(auth.Client, client.Client);
    assert.equal(auth.DeviceId, client.DeviceId);
    assert.equal(authentication.authorize(auth, network), true);
    const second = await authentication.login({ Username: 'Reader', Pw: 'correct password' }, client, network);
    assert.notEqual(first.AccessToken, second.AccessToken);
    assert.equal(first.SessionInfo.Id, second.SessionInfo.Id);
    assert.equal((await database.rows('Devices')).length, 1);
    await assert.rejects(authentication.authenticate(request), { status: 401 });
    await authentication.logout(second.AccessToken);
    assert.equal((await database.rows('Devices')).length, 0);
    assert.equal(sessions.countUserSessions(created.Id), 0);
  });

  test('postgres: login keeps native token rotation commit boundaries under SQL failures', async t => {
    const errors = [];
    const { database, users, authentication } = await fixture(t, {
      logger: { error: error => errors.push(error.message) },
    });
    const created = await users.createUser({ Name: 'RotationFailure', Password: 'password' });
    const first = await authentication.login({ Username: 'RotationFailure', Pw: 'password' }, client, network);
    const insertFunction = `"${database.schemaName}".test_device_insert_failure`;
    await database.client.query(`CREATE FUNCTION ${insertFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected replacement token insert failure'; END $$`);
    await database.client.query(`CREATE TRIGGER test_device_insert_failure BEFORE INSERT ON "Devices"
      FOR EACH ROW EXECUTE FUNCTION ${insertFunction}()`);
    await assert.rejects(authentication.login({ Username: 'RotationFailure', Pw: 'password' }, client, network),
      /Injected replacement token insert failure/u);
    assert.deepEqual(await database.rows('Devices', { where: { UserId: nativeGuid(created.Id) } }), [],
      'replacement insertion failure does not restore independently deleted old tokens');
    await database.client.query('DROP TRIGGER test_device_insert_failure ON "Devices"');
    await database.client.query(`DROP FUNCTION ${insertFunction}()`);

    const replacement = await authentication.login({ Username: 'RotationFailure', Pw: 'password' }, client, network);
    assert.notEqual(replacement.AccessToken, first.AccessToken);
    const deleteFunction = `"${database.schemaName}".test_device_delete_failure`;
    await database.client.query(`CREATE FUNCTION ${deleteFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected old token delete failure'; END $$`);
    await database.client.query(`CREATE TRIGGER test_device_delete_failure BEFORE DELETE ON "Devices"
      FOR EACH ROW EXECUTE FUNCTION ${deleteFunction}()`);
    const afterFailedDelete = await authentication.login({ Username: 'RotationFailure', Pw: 'password' }, client, network);
    const tokens = await database.rows('Devices', { where: { UserId: nativeGuid(created.Id) } });
    assert.equal(tokens.length, 2, 'a failed old-token logout is isolated before the new token is created');
    assert.equal(tokens.some(row => row.AccessToken === replacement.AccessToken), true);
    assert.equal(tokens.some(row => row.AccessToken === afterFailedDelete.AccessToken), true);
    assert.deepEqual(errors, ['Injected old token delete failure']);
    await database.client.query('DROP TRIGGER test_device_delete_failure ON "Devices"');
    await database.client.query(`DROP FUNCTION ${deleteFunction}()`);
  });

  test('postgres: revoking one user never deletes another user device with the same token', async t => {
    const { database, users, authentication } = await fixture(t);
    const first = await users.createUser({ Name: 'First' });
    const second = await users.createUser({ Name: 'Second' });
    const token = 'shared-imported-token';
    const date = nativeDate(new Date('2026-09-26T01:02:03.123Z'));
    for (const [userId, deviceId] of [[first.Id, 'first-device'], [second.Id, 'second-device']]) {
      await database.insert('Devices', {
        UserId: nativeGuid(userId), AppName: 'Imported', AppVersion: '1.0', DeviceName: deviceId,
        DeviceId: deviceId, AccessToken: token, DateCreated: date, DateModified: date,
        DateLastActivity: date, IsActive: false,
      });
    }
    const ended = [];
    authentication.sessions = { endByDevice: async deviceId => { ended.push(deviceId); } };

    await authentication.revokeUserTokens(first.Id);

    assert.deepEqual((await database.rows('Devices')).map(row => row.DeviceId), ['second-device']);
    assert.deepEqual(ended, ['first-device']);
  });

  test('postgres: policies, preferences and schedules persist with source-specific projection and lockout', async t => {
    const { database, users, authentication } = await fixture(t);
    const admin = await users.createUser({ Name: 'Admin', Password: 'password' });
    await users.updatePolicy(admin.Id, { ...admin.Policy, IsAdministrator: true });
    const created = await users.createUser({ Name: 'Reader', Password: 'password' });
    await users.updatePolicy(created.Id, { ...created.Policy, IsHidden: false, LoginAttemptsBeforeLockout: 2, EnableLyricManagement: true,
      EnabledFolders: ['012345670123012301230123456789ab'], BlockUnratedItems: ['Movie'], AccessSchedules: [{ DayOfWeek: 'Everyday', StartHour: 0, EndHour: 24 }] });
    const user = await users.getUser(created.Id);
    assert.equal(user.Policy.EnableLyricManagement, false);
    assert.equal(user.Permissions.find(p => p.Kind === 23).Value, true);
    assert.equal((await database.rows('Preferences', { where: { UserId: user.Id, Kind: 5 } }))[0].Value, '01234567-0123-0123-0123-0123456789AB');
    assert.equal(user.Policy.AccessSchedules[0].UserId, created.Id);
    assert.deepEqual(user.Policy.BlockUnratedItems, ['Movie']);
    assert.equal((await users.listUsers({ publicOnly: true, ...network })).length, 1);
    assert.equal(await users.authenticateUser('Reader', 'wrong', network), null);
    assert.equal(await users.authenticateUser('Reader', 'wrong', network), null);
    const locked = await users.getUser(created.Id);
    assert.equal(locked.InvalidLoginAttemptCount, 3);
    assert.equal(locked.Policy.IsDisabled, true);
    await assert.rejects(authentication.login({ Username: 'Reader', Pw: 'password' }, client, network), { status: 403 });
    await assert.rejects(users.updatePolicy(admin.Id, { ...admin.Policy, IsAdministrator: false }), { status: 403 });
    await assert.rejects(users.changePassword(admin.Id, ''), { status: 400 });
  });

  test('postgres: native authorization handles API keys, disabled users, device changes and policy boundaries', async t => {
    const { database, users, authentication, apiKeys, setTime } = await fixture(t);
    const created = await users.createUser({ Name: 'Reader', Password: 'password' });
    const login = await authentication.login({ Username: 'Reader', Pw: 'password' }, client, network);
    setTime('2026-09-26T01:06:03.123Z');
    const request = { headers: { Authorization: `MediaBrowser Token="${login.AccessToken}", Device="Updated", Version="2.0"` }, url: '/' };
    const auth = await authentication.authenticate(request);
    const changed = (await database.rows('Devices'))[0];
    assert.equal(changed.DeviceName, 'Updated');
    assert.equal(changed.AppVersion, '2.0');
    assert.equal(wireDate(changed.DateLastActivity), '2026-09-26T01:06:03.123Z');
    assert.equal(wireDate(changed.DateModified), '2026-09-26T01:02:03.123Z');
    await authentication.authenticate({ headers: { Authorization: `MediaBrowser Token="${login.AccessToken}", Client="Chromecast", Device="Cast", Version="3.0"` }, url: '/' });
    assert.equal((await database.rows('Devices'))[0].DeviceName, 'Updated');
    await users.updatePolicy(created.Id, { ...created.Policy, EnableRemoteAccess: false });
    const restricted = await authentication.authenticate(request);
    assert.throws(() => authentication.authorize(restricted, { remoteEndPoint: '203.0.113.1' }), { status: 403 });
    assert.throws(() => authentication.authorize(auth, { policy: 'RequiresElevation' }), { status: 403 });
    const api = await apiKeys.create('Tests');
    const apiAuth = await authentication.authenticate({ headers: {}, url: `/?ApiKey=${api.AccessToken}` });
    assert.equal(apiAuth.IsApiKey, true);
    assert.equal(apiAuth.User, null);
    assert.equal(authentication.authorize(apiAuth, { policy: 'RequiresElevation' }), true);
    const keyDtos = await apiKeys.list();
    assert.equal(keyDtos.Items[0].Id, 0);
    assert.equal(keyDtos.Items[0].AppName, 'Tests');
    await apiKeys.revoke(api.AccessToken);
    await assert.rejects(authentication.authenticate({ headers: {}, url: `/?ApiKey=${api.AccessToken}` }), { status: 401 });
  });

  test('postgres: user edits reset omitted configuration to native defaults and delete cascades', async t => {
    const { database, users } = await fixture(t);
    await users.createUser({ Name: 'Keeper' });
    const created = await users.createUser({ Name: 'Reader' });
    await users.updateConfiguration(created.Id, { RememberAudioSelections: false, SubtitleMode: 'Always', AudioLanguagePreference: 'zho', CastReceiverId: 'F007D354' });
    const configured = await users.getUser(created.Id);
    assert.equal(configured.SubtitleMode, 1);
    assert.equal(configured.AudioLanguagePreference, 'zho');
    await users.updateUser(created.Id, { Name: 'Renamed', Configuration: { CastReceiverId: 'unknown' } });
    const renamed = await users.getUser(created.Id);
    assert.equal(renamed.NormalizedUsername, 'RENAMED');
    assert.equal(renamed.RememberAudioSelections, true);
    assert.equal(renamed.SubtitleMode, 0);
    assert.equal(renamed.AudioLanguagePreference, null);
    assert.equal(renamed.CastReceiverId, 'F007D354');
    await users.deleteUser(created.Id);
    assert.equal(await users.getUser(created.Id), null);
    assert.equal((await database.rows('Preferences', { where: { UserId: nativeGuid(created.Id) } })).length, 0);
  });

  test('postgres: native persisted versions, lockout and discarded legacy hash upgrade match isolated Jellyfin', async t => {
    const { database, users, authentication } = await fixture(t);
    const defaults = await users.createUser({ Name: 'NativeDefaults' });
    await users.updateConfiguration(defaults.Id, { AudioLanguagePreference: 'zho' });
    const lockout = await users.createUser({ Name: 'NativeLockout', Password: 'isolated-lock-password' });
    await users.updatePolicy(lockout.Id, { ...lockout.Policy, LoginAttemptsBeforeLockout: 2, EnableLyricManagement: true });
    await users.authenticateUser('NativeLockout', 'wrong', network);
    await users.authenticateUser('NativeLockout', 'wrong', network);
    for (const expected of expectedPersistence.users) {
      const row = (await database.rows('Users', { where: { Username: expected.Name } }))[0];
      const actual = { Name: row.Username, RowVersion: String(row.RowVersion), InvalidLoginAttemptCount: row.InvalidLoginAttemptCount,
        Permissions: (await database.rows('Permissions', { where: { UserId: row.Id } })).map(p => ({ Kind: p.Kind, RowVersion: String(p.RowVersion), Value: p.Value })),
        Preferences: (await database.rows('Preferences', { where: { UserId: row.Id } })).map(p => ({ Kind: p.Kind, RowVersion: String(p.RowVersion), Value: p.Value })) };
      assert.deepEqual(actual, expected);
    }
    const legacy = await users.createUser({ Name: 'Legacy' });
    const salt = Buffer.from('0102030405060708', 'hex');
    const hash = serializePasswordHash({ id: 'PBKDF2', parameters: new Map([['iterations', '1000']]), salt,
      hash: pbkdf2Sync('isolated-legacy-password', salt, 1000, 32, 'sha1') });
    await database.update('Users', { Id: nativeGuid(legacy.Id) }, { Password: hash });
    await authentication.login({ Username: 'Legacy', Pw: 'isolated-legacy-password' }, client, network);
    assert.equal((await users.getUser(legacy.Id)).Password === hash, expectedPersistence.legacyHashUnchanged);
    await users.changePassword(legacy.Id, 'new password');
    assert.match((await users.getUser(legacy.Id)).Password, /^\$PBKDF2-SHA512\$iterations=210000\$/);
  });

  test('postgres: concurrent logins honor session limits and persistent device restrictions', async t => {
    const { database, users, authentication, sessions } = await fixture(t);
    const created = await users.createUser({ Name: 'Restricted', Password: 'password' });
    await users.updatePolicy(created.Id, { ...created.Policy, MaxActiveSessions: 1, EnableAllDevices: false, EnabledDevices: [client.DeviceId] });
    await assert.rejects(authentication.login({ Username: 'Restricted', Pw: 'password' }, { ...client, DeviceId: 'unapproved' }, network), { status: 403 });
    const outcomes = await Promise.allSettled([1, 2].map(() => authentication.login({ Username: 'Restricted', Pw: 'password' }, client, network)));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.status, 403);
    assert.equal(sessions.countUserSessions(created.Id), 1);
    assert.equal((await database.rows('Devices')).length, 1);
    const current = await users.getUser(created.Id);
    await assert.rejects(users.updatePolicy(created.Id, { ...current.Policy, EnabledDevices: null }), { status: 400 });
    assert.deepEqual((await users.getUser(created.Id)).Policy, current.Policy);
  });

test('native uppercase, GUID/date formatting and inclusive parental schedule use pinned rules', () => {
  assert.equal(upperInvariant('straße ı i σ ς'), 'STRAßE ı I Σ Σ');
  assert.equal(nativeGuid('{01234567-0123-0123-0123-0123456789ab}'), '01234567-0123-0123-0123-0123456789AB');
  assert.equal(wireDate('0001-01-01 00:00:00'), '0001-01-01T00:00:00.0000000Z');
  assert.equal(wireDate('2026-09-26 01:02:03.1234500'), '2026-09-26T01:02:03.12345Z');
  assert.equal(wireDate('2026-09-26 01:02:03.0000001'), '2026-09-26T01:02:03.0000001Z');
  assert.equal(nativeDate(new Date('2026-09-26T12:00:00.000Z')), '2026-09-26 12:00:00');
  assert.equal(nativeDate(new Date('2026-09-26T12:00:00.120Z')), '2026-09-26 12:00:00.12');
  const noon = new Date(2026, 8, 26, 12, 0, 0);
  assert.equal(scheduleAllowed({ AccessSchedules: [{ DayOfWeek: 9, StartHour: 11, EndHour: 12 }] }, noon), true);
  assert.equal(scheduleAllowed({ AccessSchedules: [{ DayOfWeek: 8, StartHour: 0, EndHour: 24 }] }, noon), false);
});
