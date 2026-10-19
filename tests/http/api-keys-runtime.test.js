import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/runtime.js';
import { ApiKeyService } from '../../src/users/api-key-service.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

const enabled = { skip: !postgresTestConnectionString };
const serverId = 'e6100000000000000000000000000001';

async function setup(t) {
  const state = { database: await createPostgresTestDatabase(null, 'api_key_runtime'), errors: [], releases: [] };
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const release of state.releases.reverse()) await attempt(release);
    await attempt(() => state.runtime?.close()); await attempt(() => dropPostgresTestDatabase(state.database));
    if (failures.length) throw new AggregateError(failures, 'API-key runtime cleanup failed.');
  });
  const open = async () => {
    state.runtime = await createRuntime({ database: state.database, configuration: { IsStartupWizardCompleted: true, ServerName: 'Key server' },
      serverId, onError: error => state.errors.push(error) });
    await new Promise(resolve => state.runtime.server.listen(0, '127.0.0.1', resolve));
    state.origin = `http://127.0.0.1:${state.runtime.server.address().port}`;
  };
  state.request = async (route, { token, method = 'GET' } = {}) => {
    const response = await fetch(state.origin + route, { method, headers: { Accept: 'application/json',
      ...(token && { Authorization: `MediaBrowser Token="${token}"` }) } });
    const text = await response.text(); let body = text; try { body = JSON.parse(text); } catch { }
    return { status: response.status, body, language: response.headers.get('content-language') };
  };
  state.reopen = async () => {
    await state.runtime.close(); state.database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: state.database.schemaName });
    await open();
  };
  await open(); return state;
}

test('postgres: real API-key management enforces elevated authorization, persists across restart and revokes only the exact token without session side effects', enabled, async t => {
  const state = await setup(t), runtime = state.runtime;
  const bootstrap = await runtime.apiKeys.create('Bootstrap');
  assert.equal((await state.request('/Auth/Keys')).status, 401);
  const regular = await runtime.users.createUser({ Name: 'Regular', Password: 'regular password' });
  const login = await runtime.authentication.login({ Username: 'Regular', Pw: 'regular password' },
    { Client: 'Key test', DeviceId: 'regular-device', Device: 'Regular device', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
  assert.equal((await state.request('/Auth/Keys', { token: login.AccessToken })).status, 403);
  const events = []; runtime.authentication.on('AuthenticationResult', value => events.push(value));
  const sessionCount = runtime.sessions.countUserSessions(regular.Id);
  for (const name of ['A', 'A', '播放器\0🎬']) assert.equal((await state.request('/Auth/Keys?app=' + encodeURIComponent(name), { token: bootstrap.AccessToken, method: 'POST' })).status, 204);
  const result = await state.request('/Auth/Keys', { token: bootstrap.AccessToken });
  assert.equal(result.status, 200); assert.equal(result.language, 'en-US');
  assert.deepEqual(result.body.Items.map(key => key.AppName), ['Bootstrap', 'A', 'A', '播放器\0🎬']);
  assert.equal(result.body.TotalRecordCount, 4); assert.equal(result.body.StartIndex, 0);
  const selected = result.body.Items.at(-1).AccessToken;
  assert.match(selected, /^[0-9a-f]{32}$/u);
  const keyAuth = await runtime.authentication.authenticate({ headers: { authorization: `MediaBrowser Token="${selected}", Client="Ignored"` } });
  assert.equal(keyAuth.IsApiKey, true); assert.equal(keyAuth.IsAdministrator, true); assert.equal(keyAuth.User, null);
  assert.equal(keyAuth.Client, '播放器\0🎬'); assert.equal(keyAuth.Device, 'Key server'); assert.equal(keyAuth.DeviceId, serverId);
  assert.equal(runtime.sessions.countUserSessions(regular.Id), sessionCount); assert.deepEqual(events, []);
  assert.equal((await state.database.rows('ApiKeys', { where: { AccessToken: selected }, limit: 1 }))[0].DateLastActivity, '0001-01-01 00:00:00');
  await state.reopen();
  assert.deepEqual((await state.request('/Auth/Keys', { token: bootstrap.AccessToken })).body, result.body);
  assert.equal((await state.request('/Auth/Keys/' + selected.toUpperCase(), { token: selected, method: 'DELETE' })).status, 204);
  assert.equal((await state.request('/Auth/Keys', { token: selected })).status, 200);
  assert.equal((await state.request('/Auth/Keys/' + selected, { token: selected, method: 'DELETE' })).status, 204);
  assert.equal((await state.request('/Auth/Keys', { token: selected })).status, 401);
  assert.equal((await state.request('/Auth/Keys', { token: login.AccessToken })).status, 403);
  assert.equal((await state.database.rows('Devices', { where: { AccessToken: login.AccessToken }, limit: 1 })).length, 1);
  assert.equal((await state.request('/Auth/Keys', { token: bootstrap.AccessToken })).body.TotalRecordCount, 3);
  assert.deepEqual(state.errors, []);
});

for (const operation of ['create', 'list', 'revoke']) test('postgres: runtime close drains admitted API-key ' + operation + ' and rejects new operations before releasing PostgreSQL', enabled, async t => {
  const state = await setup(t); const initial = await state.runtime.apiKeys.create('Original');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), connection = state.database.client;
  const original = connection.query.bind(connection);
  let blocked = false;
  connection.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (!blocked && sql.includes('"ApiKeys"') && sql.startsWith({ create: 'INSERT', list: 'SELECT', revoke: 'DELETE' }[operation])) {
      blocked = true; entered.resolve(); await release.promise;
    }
    return original(...args);
  };
  state.releases.push(() => { release.resolve(); connection.query = original; });
  const keys = state.runtime.apiKeys, pending = keys[operation](operation === 'revoke' ? initial.AccessToken : 'Drained');
  await entered.promise;
  let closed = false; const closing = state.runtime.close(); const same = state.runtime.close();
  assert.equal(closing, same); void closing.then(() => { closed = true; });
  await assert.rejects(keys.create('Late'), { status: 503 }); await assert.rejects(keys.list(), { status: 503 });
  await assert.rejects(keys.revoke(initial.AccessToken), { status: 503 }); assert.equal(closed, false); assert.equal(state.database.closed, false);
  release.resolve(); await pending; await closing;
  assert.equal(closed, true); assert.equal(state.database.closed, true); assert.equal(state.runtime.server.listening, false);
  await state.reopen(); const result = await state.runtime.apiKeys.list();
  assert.deepEqual(result.Items.map(key => key.AppName), operation === 'create' ? ['Original', 'Drained'] : operation === 'list' ? ['Original'] : []);
  assert.deepEqual(state.errors, []);
});

test('postgres: a large API-key list uses bounded SQL projection and a single snapshot despite concurrent delete and insert', enabled, async t => {
  const state = await setup(t);
  await state.database.insertBatch('ApiKeys', Array.from({ length: 20000 }, (_, index) => ({ Id: index + 1,
    Name: 'Key ' + index, AccessToken: 'token-' + index, DateCreated: '2026-01-01 01:02:03.1234567', DateLastActivity: '2026-02-01 00:00:00' })));
  const peer = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: state.database.schemaName });
  state.releases.push(() => peer.close());
  const connection = state.database.client, original = connection.query.bind(connection), selections = [];
  let changed = false;
  connection.query = async (...args) => {
    const result = await original(...args), sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (sql.startsWith('SELECT') && sql.includes('"ApiKeys"')) {
      selections.push({ sql, rows: result.rows.length });
      if (!changed) {
        changed = true;
        await peer.delete('ApiKeys', { Id: 200 });
        await peer.insert('ApiKeys', { Id: 30000, Name: 'Concurrent', AccessToken: 'concurrent-key', DateCreated: '2026-03-01 00:00:00', DateLastActivity: '0001-01-01 00:00:00' });
      }
    }
    return result;
  };
  let before;
  try { before = await state.runtime.apiKeys.list(); } finally { connection.query = original; }
  assert.equal(before.TotalRecordCount, 20000);
  assert.deepEqual(before.Items.map(key => key.AccessToken), Array.from({ length: 20000 }, (_, index) => 'token-' + index));
  assert.ok(selections.length > 1); assert.ok(selections.every(query => query.rows <= 128 && /LIMIT/u.test(query.sql) && !/DateLastActivity/u.test(query.sql)));
  assert.ok(before.Items.every(key => key.Id === 0 && key.DateLastActivity === '0001-01-01T00:00:00.0000000Z'));
  const after = await state.runtime.apiKeys.list(); assert.equal(after.TotalRecordCount, 20000);
  assert.equal(after.Items.some(key => key.AccessToken === 'token-199'), false);
  assert.equal(after.Items.at(-1).AccessToken, 'concurrent-key'); assert.deepEqual(state.errors, []);
});

test('postgres: late runtime construction failure closes the API-key owner before its PostgreSQL store', enabled, async t => {
  const database = await createPostgresTestDatabase(t, 'key_rollback');
  const original = ApiKeyService.prototype.close, closed = [];
  ApiKeyService.prototype.close = function () { closed.push({ owner: this, databaseClosed: database.closed }); return original.call(this); };
  try {
    await assert.rejects(createRuntime({ database, configuration: {}, serverId, autoDiscoveryOptions: false }), /autoDiscoveryOptions must be an object/u);
  } finally { ApiKeyService.prototype.close = original; }
  assert.equal(closed.length, 1); assert.equal(closed[0].databaseClosed, false); assert.equal(database.closed, true);
  await assert.rejects(closed[0].owner.create('Late'), { status: 503 });
});
