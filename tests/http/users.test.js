import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

async function setup(t) {
  const prefix = path.join(tmpdir(), 'mediamanager-http-users-');
  const programDataPath = await mkdtemp(prefix);
  let database, runtime;
  t.after(async () => {
    try {
      if (runtime) await runtime.close();
      else await database?.close();
      await dropPostgresTestDatabase(database);
    } finally {
      assert.ok(path.resolve(programDataPath).startsWith(path.resolve(prefix)));
      await rm(programDataPath, { recursive: true });
    }
  });
  database = await createPostgresTestDatabase(null, 'http_users');
  runtime = await createTestRuntime({ database,
    configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', CastReceiverApplications: [{ Id: 'F007D354' }] },
    serverId: '123456781234123412341234567890ab', serverName: 'Isolated Test', programDataPath, metadataPath: path.join(programDataPath, 'metadata') });
  const admin = await runtime.users.createUser({ Name: 'Administrator', Password: 'admin password' });
  await runtime.users.updatePolicy(admin.Id, { ...admin.Policy, IsAdministrator: true, IsHidden: false });
  const base = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  async function request(route, { method = 'GET', body, token, device = 'http-device', contentType = 'application/json', headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { Accept: 'application/json',
      Authorization: `MediaBrowser Client="HttpTests", Device="Isolated HTTP test", DeviceId="${device}", Version="1.0"${token ? `, Token="${token}"` : ''}`,
      ...(body === undefined ? {} : { 'Content-Type': contentType }), ...headers },
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, data };
  }
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Administrator', Pw: 'admin password' }, device: 'admin-device' });
  assert.equal(login.status, 200);
  return { runtime, request, admin, adminToken: login.data.AccessToken };
}

test('HTTP user deletion revokes tokens, transfers ownership and preserves the removed private Playlist source', async t => {
  const { runtime, request, admin, adminToken } = await setup(t);
  assert.ok(runtime.metadata); assert.ok(runtime.library.itemCreation); assert.ok(runtime.library.itemDeletion);
  assert.equal(typeof runtime.probe?.refresh, 'function', 'The configured storage exposes the probe service.');
  assert.equal(runtime.libraryScanner?.capabilities.completeLibraryScan, true);
  const victim = await runtime.users.createUser({ Name: 'PlaylistOwner', Password: 'owner password' });
  const victimRecord = await runtime.users.getUser(victim.Id);
  const administrator = await runtime.users.getUser(admin.Id);
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'PlaylistOwner', Pw: 'owner password' } });
  assert.equal(login.status, 200);
  const shared = await runtime.playlists.create({ name: 'Transfer on delete', user: victimRecord, isPublic: false,
    users: [{ UserId: administrator.Id, CanEdit: true }] });
  const privateItem = await runtime.playlists.create({ name: 'Remove on delete', user: victimRecord, isPublic: false });
  const publicItem = await runtime.playlists.create({ name: 'Keep on delete', user: victimRecord, isPublic: true });
  const privateEntity = await runtime.library.itemCreation.getItemById(privateItem.Id);
  const privateSource = path.join(privateEntity.Path, 'playlist.xml'), privateBytes = await readFile(privateSource);
  assert.equal((await request(`/Users/${victim.Id}`, { method: 'DELETE', token: adminToken })).status, 204);
  assert.equal(await runtime.users.getUser(victim.Id), null);
  assert.equal((await request('/Users/Me', { token: login.data.AccessToken })).status, 401);
  assert.deepEqual(await runtime.playlists.get(shared.Id, { user: administrator }), { Shares: [], OpenAccess: false, ItemIds: [] });
  await assert.rejects(runtime.playlists.get(privateItem.Id, { user: administrator }), error => error.status === 404);
  assert.deepEqual(await readFile(privateSource), privateBytes, 'RemovePlaylistsAsync uses DeleteFileLocation=false.');
  assert.equal((await runtime.playlists.get(publicItem.Id, { user: administrator })).OpenAccess, true);
  assert.equal((await request(`/Users/${victim.Id}`, { method: 'DELETE', token: adminToken })).status, 404);
});

test('HTTP user deletion stops after token revocation if playlist persistence fails', async t => {
  const { runtime, request, adminToken } = await setup(t);
  const victim = await runtime.users.createUser({ Name: 'FailedPlaylistOwner', Password: 'owner password' });
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'FailedPlaylistOwner', Pw: 'owner password' } });
  const original = runtime.playlists.removeForDeletedUser.bind(runtime.playlists);
  runtime.playlists.removeForDeletedUser = async () => { throw new Error('injected playlist failure'); };
  try { assert.equal((await request(`/Users/${victim.Id}`, { method: 'DELETE', token: adminToken })).status, 500); }
  finally { runtime.playlists.removeForDeletedUser = original; }
  assert.ok(await runtime.users.getUser(victim.Id));
  assert.equal((await request('/Users/Me', { token: login.data.AccessToken })).status, 401,
    'The native controller commits token revocation before playlist cleanup.');
});

test('HTTP user creation, public listing, configuration and rename use persisted native users', async t => {
  const { runtime, request, adminToken } = await setup(t);
  assert.equal((await request('/Users')).status, 401);
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { name: 'Reader', password: 'reader password' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.Name, 'Reader');
  assert.equal(created.data.Policy.IsAdministrator, false);
  assert.equal((await request('/Users/Public')).data.length, 1);
  const id = created.data.Id;
  const login = await request('/Users/AuthenticateByName', { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'username=Reader&pw=reader+password', device: 'reader-device' });
  assert.equal(login.status, 200);
  const token = login.data.AccessToken;
  assert.equal((await request(`/Users/${id}/Configuration`, { method: 'POST', token, body: { subtitleMode: 'Always', audioLanguagePreference: 'zho' } })).status, 204);
  const current = await request('/Users/Me', { token });
  assert.equal(current.data.Configuration.SubtitleMode, 'Always');
  assert.equal(current.data.Configuration.AudioLanguagePreference, 'zho');
  assert.equal((await request('/Users', { method: 'POST', token, body: { Name: 'Renamed', Policy: null, Configuration: { RememberAudioSelections: false } } })).status, 204);
  const persisted = await runtime.users.getUser(id);
  assert.equal(persisted.Username, 'Renamed');
  assert.equal(persisted.NormalizedUsername, 'RENAMED');
  assert.equal(persisted.SubtitleMode, 0);
  assert.equal(persisted.RememberAudioSelections, false);
  assert.equal((await request('/Users?isHidden=invalid', { token })).status, 400);
  assert.equal((await request('/Users/not-a-guid', { token })).status, 400);
});

test('HTTP permissions enforce elevation, own-user updates, last administrator and disabled token revocation', async t => {
  const { request, runtime, admin, adminToken } = await setup(t);
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 'Reader', Password: 'reader password' } });
  assert.equal(created.status, 200);
  const id = created.data.Id;
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'reader password' }, device: 'reader-device' });
  const token = login.data.AccessToken;
  assert.equal((await request('/Users/New', { method: 'POST', token, body: { Name: 'Forbidden' } })).status, 403);
  assert.equal((await request(`/Users/${admin.Id}/Configuration`, { method: 'POST', token, body: {} })).status, 403);
  assert.equal((await request(`/Users/${admin.Id}/Policy`, { method: 'POST', token: adminToken, body: { ...admin.Policy, IsAdministrator: false } })).status, 403);
  assert.equal((await request(`/Users/${id}/Policy`, { method: 'POST', token: adminToken, body: { ...created.data.Policy, EnableUserPreferenceAccess: false } })).status, 204);
  assert.equal((await request('/Users/Configuration', { method: 'POST', token, body: {} })).status, 403);
  assert.equal((await request(`/Users/${id}/Policy`, { method: 'POST', token: adminToken, body: { ...created.data.Policy, IsDisabled: true } })).status, 204);
  assert.equal((await request('/Users/Me', { token })).status, 401);
  assert.equal((await runtime.store.run(db => db.rows('Devices', { where: { UserId: nativeGuid(id) } }))).length, 0);
  assert.equal((await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'reader password' } })).status, 403);
});

test('HTTP password changes preserve only the current token and reject old credentials', async t => {
  const { request, runtime, adminToken } = await setup(t);
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 'Reader', Password: 'old password' } });
  assert.equal(created.status, 200);
  const first = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'old password' }, device: 'reader-first' });
  const second = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'old password' }, device: 'reader-second' });
  assert.equal((await request('/Users/Password', { method: 'POST', token: first.data.AccessToken, body: { CurrentPw: 'wrong', NewPw: 'new password' } })).status, 403);
  assert.equal((await request('/Users/Password', { method: 'POST', token: first.data.AccessToken, body: { CurrentPw: 'old password', NewPw: 'new password' } })).status, 204);
  assert.equal((await request('/Users/Me', { token: first.data.AccessToken })).status, 200);
  assert.equal((await request('/Users/Me', { token: second.data.AccessToken })).status, 401);
  assert.equal((await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'old password' }, device: 'reader-third' })).status, 401);
  assert.equal((await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'new password' }, device: 'reader-third' })).status, 200);
  assert.equal((await runtime.store.run(db => db.rows('Devices', { where: { UserId: nativeGuid(created.data.Id) } }))).length, 2);
});

test('HTTP API keys authorize administration without a user and deletion revokes existing sessions', async t => {
  const { request, runtime, adminToken } = await setup(t);
  assert.equal((await request('/Auth/Keys?app=Integration', { method: 'POST', token: adminToken })).status, 204);
  const keys = await request('/Auth/Keys', { token: adminToken });
  assert.equal(keys.status, 200);
  assert.equal(keys.data.Items[0].AppName, 'Integration');
  const token = keys.data.Items[0].AccessToken;
  assert.equal((await request('/Users/Me', { token })).status, 400);
  const created = await request('/Users/New', { method: 'POST', token, body: { Name: 'Disposable', Password: 'password' } });
  assert.equal(created.status, 200);
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Disposable', Pw: 'password' } });
  assert.equal(login.status, 200);
  assert.equal((await request(`/Users/${created.data.Id}`, { method: 'DELETE', token })).status, 204);
  assert.equal((await request('/Users/Me', { token: login.data.AccessToken })).status, 401);
  assert.equal(await runtime.users.getUser(created.data.Id), null);
  assert.equal((await request(`/Auth/Keys/${token}`, { method: 'DELETE', token: adminToken })).status, 204);
  assert.equal((await request('/Users', { token })).status, 401);
});

test('HTTP native user binding rejects malformed types before changing users, permissions or credentials', async t => {
  const { request, runtime, adminToken } = await setup(t);
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 'Reader', Password: 'password' } });
  const id = created.data.Id;
  const initial = await runtime.users.getUser(id);
  const badConfig = await request(`/Users/${id}/Configuration`, { method: 'POST', token: adminToken, body: { RememberAudioSelections: 0 } });
  assert.equal(badConfig.status, 400);
  assert.deepEqual(badConfig.data.errors, {
    userConfig: ['The userConfig field is required.'],
    '$.RememberAudioSelections': ['The JSON value could not be converted to System.Boolean. Path: $.RememberAudioSelections | LineNumber: 0 | BytePositionInLine: 28.']
  });
  const badUser = await request(`/Users/${id}`, { method: 'POST', token: adminToken, body: { Name: 'ShouldNotPersist', Configuration: {} } });
  assert.equal(badUser.status, 400);
  assert.deepEqual(Object.keys(badUser.data.errors).sort(), ['Policy.AuthenticationProviderId', 'Policy.PasswordResetProviderId']);
  assert.equal((await request(`/Users/${id}/Policy`, { method: 'POST', token: adminToken, body: { ...created.data.Policy, MaxActiveSessions: 2147483648 } })).status, 400);
  assert.equal((await request(`/Users/${id}/Password`, { method: 'POST', token: adminToken, body: { ResetPassword: 'true', NewPw: 'changed' } })).status, 400);
  const unchanged = await runtime.users.getUser(id);
  assert.equal(unchanged.Username, initial.Username);
  assert.equal(unchanged.Password, initial.Password);
  assert.equal(unchanged.RowVersion, initial.RowVersion);
  assert.deepEqual(unchanged.Policy, initial.Policy);
  assert.equal((await request(`/Users/${id}/Configuration`, { method: 'POST', token: adminToken, body: { SubtitleMode: 'Always, OnlyForced' } })).status, 204);
  assert.equal((await runtime.users.getUser(id)).SubtitleMode, 3);
  const numericName = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 123, Password: true } });
  assert.equal(numericName.status, 200);
  assert.equal(numericName.data.Name, '123');
});

test('HTTP token-only login reuses persisted device metadata and rotates the existing token', async t => {
  const { request, adminToken } = await setup(t);
  const result = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Administrator', Pw: 'admin password' },
    headers: { Authorization: `MediaBrowser Token="${adminToken}"` } });
  assert.equal(result.status, 200);
  assert.equal(result.data.SessionInfo.DeviceId, 'admin-device');
  assert.equal(result.data.SessionInfo.Client, 'HttpTests');
  assert.equal((await request('/Users/Me', { token: adminToken })).status, 401);
  assert.equal((await request('/Users/Me', { token: result.data.AccessToken })).status, 200);
});

test('HTTP user data honors preference policy and session queries reject another user identity', async t => {
  const { request, runtime, admin, adminToken } = await setup(t);
  const itemId = '22222222-2222-2222-2222-222222222222';
  const row = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-09-26 00:00:00' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
  await runtime.store.transaction(db => db.insert('BaseItems', { ...row, Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: 'Policy Movie', CleanName: 'policy movie', SortName: 'policy movie', Data: '{}', MediaType: 'Video', RunTimeTicks: 600000000n,
    Path: 'Z:\\Isolated\\movie.mkv', IsFolder: false }));
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 'Reader', Password: 'password' } });
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'password' }, device: 'reader-device' });
  const token = login.data.AccessToken;
  assert.equal((await request(`/UserItems/${itemId}/UserData`, { token })).status, 200);
  assert.equal((await request(`/Users/${created.data.Id}/Policy`, { method: 'POST', token: adminToken,
    body: { ...created.data.Policy, EnableUserPreferenceAccess: false, EnableRemoteControlOfOtherUsers: true } })).status, 204);
  for (const [method, verb] of [['GET', 'view'], ['POST', 'update']]) {
    const denied = await request(`/UserItems/${itemId}/UserData`, { method, token, ...(method === 'POST' ? { body: { IsFavorite: true, PlayCount: 7 } } : {}) });
    assert.equal(denied.status, 403);
    assert.equal(denied.data, `User is not allowed to ${verb} this item user data.`);
  }
  const records = await runtime.store.run(db => db.rows('UserData', { where: { UserId: nativeGuid(created.data.Id) } }));
  assert.equal(records.some(record => record.IsFavorite || record.PlayCount === 7), false);
  assert.equal((await request(`/UserItems/${itemId}/UserData?userId=${created.data.Id}`, { token: adminToken })).status, 200);
  assert.equal((await request(`/Sessions?controllableByUserId=${admin.Id}`, { token })).status, 403);
  assert.equal((await request(`/Sessions?controllableByUserId=${created.data.Id}`, { token })).status, 200);
  assert.equal((await request('/Sessions?controllableByUserId=00000000000000000000000000000000', { token })).status, 200);
});

test('HTTP item queries reject an explicit nonexistent user instead of dropping its permission context', async t => {
  const { request, adminToken } = await setup(t);
  const result = await request('/Items?userId=11111111111111111111111111111111&Recursive=true', { token: adminToken });
  assert.equal(result.status, 404);
});

test('HTTP first-setup authorization policies ignore parental schedules after setup completes', async t => {
  const { request, adminToken } = await setup(t);
  const created = await request('/Users/New', { method: 'POST', token: adminToken, body: { Name: 'Reader', Password: 'password' } });
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'password' }, device: 'reader-device' });
  const token = login.data.AccessToken;
  assert.equal((await request(`/Users/${created.data.Id}/Policy`, { method: 'POST', token: adminToken,
    body: { ...created.data.Policy, AccessSchedules: [{ DayOfWeek: 'Everyday', StartHour: 25, EndHour: 26 }] } })).status, 204);
  assert.equal((await request('/Users', { token })).status, 403);
  assert.equal((await request('/Localization/Countries', { token })).status, 200);
  assert.equal((await request(`/Users/${created.data.Id}`, { token })).status, 200);
});
