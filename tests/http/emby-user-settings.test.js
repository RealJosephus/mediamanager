import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { md5Guid } from '../../src/core/identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

// The unmodified Emby Web 26.0.37 ApiClient and UserSettingsBuilder consume a
// flat nullable string dictionary, with full and partial saves from 4.9.0.23.
const enabled = { skip: !postgresTestConnectionString, timeout: 60000 };
const errorDiagnostic = error => ({ ...error, name: error?.name, message: error?.message, stack: error?.stack,
  cause: error?.cause, errors: error?.errors });
async function setup(t) {
  const output = path.resolve(validationOutputRoot());
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(output, 'emby-user-settings-')));
  const configuration = { IsStartupWizardCompleted: true }, errors = [], requests = [];
  const requestContext = new AsyncLocalStorage(), pendingRequests = new Set();
  const assertRequestDiagnostics = () => {
    t.diagnostic(JSON.stringify({ requests, diagnostics: errors.map(({ error, ...context }) => ({ ...context,
      error: errorDiagnostic(error) })) }, (_key, value) => value instanceof Error ? errorDiagnostic(value) : value));
    for (const diagnostic of errors) {
      const request = requests[diagnostic.requestIndex];
      assert.ok(request && diagnostic.requestOpen && request.failureStatus !== undefined,
        'Successful requests, background work and runtime closure must not hide unexpected errors.');
      assert.equal(diagnostic.method, request.method); assert.equal(diagnostic.route, request.path);
      assert.equal(request.response.status, request.failureStatus);
      assert.equal(diagnostic.error.status ?? diagnostic.error.statusCode ?? 500, request.response.status);
    }
  };
  let runtime, database;
  async function open() {
    runtime = await createTestRuntime({ database, configuration, networkConfiguration: { BaseUrl: '/media' }, serverId: 'emby-user-settings',
      programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config'),
      onError: error => {
        const context = requestContext.getStore();
        errors.push({ requestIndex: context?.request.index ?? null, requestOpen: context?.request.open === true,
          method: context?.method ?? null, route: context?.route ?? null, error });
      } });
    // Concurrent successful writes need no diagnostic exception. Ambiguous
    // origins remain unclassified instead of borrowing another request.
    runtime.networkHost.listeners.find(listener => listener.scheme === 'http').server.prependListener('request', incoming => {
      const matching = [...pendingRequests].filter(value => value.method === incoming.method && value.path === incoming.url);
      requestContext.enterWith(matching.length === 1 ? { request: matching[0], method: incoming.method, route: incoming.url } : null);
    });

  }
  t.after(async () => {
    const failures = [];
    for (const operation of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(output));
      assert.ok(path.basename(root).startsWith('emby-user-settings-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await operation(); } catch (error) { failures.push(error); }
    try { assertRequestDiagnostics(); } catch (error) { failures.push(error); }
    requestContext.disable();
    if (failures.length) throw new AggregateError(failures, 'Emby user settings cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'emby_settings');
  await open();
  async function request(route, { token, method = 'GET', body, raw, failureStatus } = {}) {
    const url = new URL(`/media${route}`, `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`);
    if (body !== undefined || raw !== undefined) url.searchParams.set('reqformat', 'json');
    const observation = { index: requests.length, method, path: url.pathname + url.search, failureStatus, open: true };
    requests.push(observation); pendingRequests.add(observation);
    try {
    const response = await fetch(url, { method, headers: {
      Accept: 'application/json', Authorization: `MediaBrowser Client="Emby Web", Device="Browser", DeviceId="settings-device", Version="26.0.37"${token ? `, Token="${token}"` : ''}`,
      ...((body !== undefined || raw !== undefined) && { 'Content-Type': 'text/plain; charset=UTF-8' }),
    }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    const result = { status: response.status, text, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
    // Keep the complete failed wire value. Successful authentication bodies
    // contain credentials and need no diagnostic copy.
    observation.response = { status: response.status, ...(failureStatus === undefined ? {} : {
      contentType: response.headers.get('content-type'), text: result.text, body: result.body }) };
    return result;
    } finally { observation.open = false; pendingRequests.delete(observation); }
  }
  const admin = await runtime.users.createUser({ Name: 'Settings administrator', Password: randomUUID() });
  const password = randomUUID();
  const owner = await runtime.users.createUser({ Name: 'Settings owner', Password: password });
  const another = await runtime.users.createUser({ Name: 'Another settings owner', Password: randomUUID() });
  const key = await runtime.apiKeys.create('Settings administrator');
  const login = await request('/emby/Users/AuthenticateByName', { method: 'POST', body: { Username: owner.Name, Pw: password } });
  assert.equal(login.status, 200);
  return { request, owner, admin, another, token: login.body.AccessToken, adminToken: key.AccessToken, assertRequestDiagnostics,
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
  assert.equal((await state.request(route, { failureStatus: 401 })).status, 401);
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
    assert.equal((await state.request(`/emby/usersettings/${state.another.Id}${suffix}`, { token, method: 'POST', body: { denied: 'write' }, failureStatus: 403 })).status, 403);
  }
  assert.equal((await state.request(`/emby/usersettings/${state.another.Id}`, { token, failureStatus: 403 })).status, 403);
  assert.deepEqual((await state.request(`/emby/usersettings/${state.another.Id}`, { token: state.adminToken })).body, {});
  assert.equal((await state.request(`/emby/usersettings/${randomUUID()}`, { token: state.adminToken, failureStatus: 404 })).status, 404);
  assert.equal((await state.request('/emby/usersettings/invalid', { token, failureStatus: 400 })).status, 400);
  for (const raw of ['{', 'null', '[]', '{"invalid":{}}']) {
    assert.equal((await state.request(route + '/Partial', { token, method: 'POST', raw, failureStatus: 400 })).status, 400);
    assert.deepEqual((await state.request(route, { token })).body, expected);
  }
  await state.reopen();
  assert.deepEqual((await state.request(route, { token })).body, expected);
  assert.equal((await state.request(route, { token, method: 'POST', body: { replacement: 'only' } })).status, 204);
  assert.deepEqual((await state.request(route, { token })).body, { replacement: 'only' });
  assert.equal((await state.request(route, { token, method: 'POST', body: {} })).status, 204);
  assert.deepEqual((await state.request(route, { token })).body, {});
  state.assertRequestDiagnostics();
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
  state.assertRequestDiagnostics();
});
