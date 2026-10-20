import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { md5Guid } from '../../src/core/identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

// The unmodified Emby Web 26.0.37 ApiClient and UserSettingsBuilder consume a
// flat nullable string dictionary, with full and partial saves from 4.9.0.23.
const enabled = { skip: !postgresTestConnectionString, timeout: 60000 };
async function setup(t) {
  const output = path.resolve(validationOutputRoot());
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(output, 'emby-user-settings-')));
  const configuration = { IsStartupWizardCompleted: true, BaseUrl: '/media' }, errors = [];
  let runtime, database;
  async function open() {
    runtime = await createRuntime({ database, configuration, serverId: 'emby-user-settings',
      programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config'),
      onError: error => errors.push({ status: error.status, code: error.code }) });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => {
    const failures = [];
    for (const operation of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(output));
      assert.ok(path.basename(root).startsWith('emby-user-settings-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await operation(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Emby user settings cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'emby_settings');
  await open();
  async function request(route, { token, method = 'GET', body, raw } = {}) {
    const url = new URL(`/media${route}`, `http://127.0.0.1:${runtime.server.address().port}`);
    if (body !== undefined || raw !== undefined) url.searchParams.set('reqformat', 'json');
    const response = await fetch(url, { method, headers: {
      Accept: 'application/json', Authorization: `MediaBrowser Client="Emby Web", Device="Browser", DeviceId="settings-device", Version="26.0.37"${token ? `, Token="${token}"` : ''}`,
      ...((body !== undefined || raw !== undefined) && { 'Content-Type': 'text/plain; charset=UTF-8' }),
    }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    return { status: response.status, text, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  }
  const admin = await runtime.users.createUser({ Name: 'Settings administrator', Password: randomUUID() });
  const password = randomUUID();
  const owner = await runtime.users.createUser({ Name: 'Settings owner', Password: password });
  const another = await runtime.users.createUser({ Name: 'Another settings owner', Password: randomUUID() });
  const key = await runtime.apiKeys.create('Settings administrator');
  const login = await request('/emby/Users/AuthenticateByName', { method: 'POST', body: { Username: owner.Name, Pw: password } });
  assert.equal(login.status, 200);
  return { request, owner, admin, another, token: login.body.AccessToken, adminToken: key.AccessToken, errors,
    get runtime() { return runtime; }, get database() { return database; },
    async reopen() {
      const schema = database.schemaName;
      await runtime.close();
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema });
      await open();
    } };
}

test('Emby user settings enforce ownership and persist full and partial nullable string dictionaries across restart', enabled, async t => {
  const state = await setup(t), route = `/emby/usersettings/${state.owner.Id}`, token = state.token;
  assert.equal((await state.request(route)).status, 401);
  assert.deepEqual((await state.request(route, { token })).body, {});
  const initial = JSON.parse('{"enableNextVideoInfoOverlay":"false","homesection0":"resume","unknown":"a\\u0000b","nullable":null,"__proto__":"preserved","大写键":"設定"}');
  assert.equal((await state.request(route, { token, method: 'POST', body: initial })).status, 204);
  assert.deepEqual((await state.request(route, { token })).body, initial);
  const patch = { homesection0: 'smalllibrarytiles', nullable: 'now saved', removed: null };
  assert.equal((await state.request(route + '/Partial', { token, method: 'POST', body: patch })).status, 204);
  const expected = { ...initial, ...patch };
  assert.deepEqual((await state.request(route, { token })).body, expected);
  const legacy = await state.request(`/DisplayPreferences/usersettings?client=emby&userId=${state.owner.Id}`, { token });
  assert.equal(legacy.status, 200);
  assert.equal(Object.hasOwn(legacy.body.CustomPrefs, 'unknown'), false);
  for (const suffix of ['', '/Partial']) {
    assert.equal((await state.request(`/emby/usersettings/${state.another.Id}${suffix}`, { token, method: 'POST', body: { denied: 'write' } })).status, 403);
  }
  assert.equal((await state.request(`/emby/usersettings/${state.another.Id}`, { token })).status, 403);
  assert.deepEqual((await state.request(`/emby/usersettings/${state.another.Id}`, { token: state.adminToken })).body, {});
  assert.equal((await state.request(`/emby/usersettings/${randomUUID()}`, { token: state.adminToken })).status, 404);
  assert.equal((await state.request('/emby/usersettings/invalid', { token })).status, 400);
  for (const raw of ['{', 'null', '[]', '{"invalid":{}}']) {
    assert.equal((await state.request(route + '/Partial', { token, method: 'POST', raw })).status, 400);
    assert.deepEqual((await state.request(route, { token })).body, expected);
  }
  await state.reopen();
  assert.deepEqual((await state.request(route, { token })).body, expected);
  assert.equal((await state.request(route, { token, method: 'POST', body: { replacement: 'only' } })).status, 204);
  assert.deepEqual((await state.request(route, { token })).body, { replacement: 'only' });
  assert.equal((await state.request(route, { token, method: 'POST', body: {} })).status, 204);
  assert.deepEqual((await state.request(route, { token })).body, {});
  assert.deepEqual(state.errors.map(error => error.status).sort(), [403, 403, 403, 404]);
});

test('Emby partial settings saves serialize concurrent writers and scope bounded SQL pages to one user', enabled, async t => {
  const state = await setup(t), token = state.token, route = `/emby/usersettings/${state.owner.Id}`;
  const initial = Object.fromEntries(Array.from({ length: 270 }, (_, index) => [`key-${index}`, String(index)]));
  assert.equal((await state.request(route, { token, method: 'POST', body: initial })).status, 204);
  await state.database.insertBatch('CustomItemDisplayPreferences', Array.from({ length: 300 }, (_, index) => ({
    UserId: nativeGuid(state.another.Id), ItemId: nativeGuid(md5Guid('usersettings')), Client: 'emby-usersettings', Key: `unrelated-${index}`, Value: 'other',
  })));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => state.request(route + '/Partial', {
    token, method: 'POST', body: { [`parallel-${index}`]: String(index) },
  })));
  assert.ok(results.every(result => result.status === 204));
  const queries = [], original = state.database.client.query.bind(state.database.client);
  state.database.client.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    const result = await original(...args);
    if (/^SELECT .* FROM "CustomItemDisplayPreferences"/u.test(sql)) queries.push({ sql, count: result.rows.length });
    return result;
  };
  try {
    const result = await state.request(route, { token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ...initial, ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`parallel-${index}`, String(index)])) });
  } finally { state.database.client.query = original; }
  assert.equal(queries.length, 3);
  assert.ok(queries.every(query => query.count <= 128 && query.sql.includes(' WHERE ') && query.sql.includes(' LIMIT ')));
  assert.deepEqual(state.errors, []);
});
