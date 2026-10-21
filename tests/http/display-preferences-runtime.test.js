import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { md5Guid } from '../../src/core/identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { captureDisplayPreferenceSnapshot, currentPreferenceInputsAvailable } from './fixtures/display-preferences-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = { skip: !postgresTestConnectionString }, password = 'Display preferences password';
async function setup(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'display-preferences-runtime-'));
  const configuration = { IsStartupWizardCompleted: true, BaseUrl: '/media' }, errors = [], releases = [];
  let database, runtime;
  const create = async () => {
    runtime = await createRuntime({ database, configuration, serverId: 'display-preferences-runtime',
      programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config'), onError: error => errors.push(error) });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  };
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const release of releases.reverse()) await attempt(release);
    await attempt(() => runtime?.close()); await attempt(() => dropPostgresTestDatabase(database));
    await attempt(async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('display-preferences-runtime-'));
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Display preferences runtime cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'display_runtime'); await create();
  async function request(url, { token, method = 'GET', body } = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/media${url}`, { method,
      headers: { Accept: 'application/json', Authorization: `MediaBrowser Client="Preferences test", Device="Browser", DeviceId="preferences-web", Version="1.0"${token ? `, Token="${token}"` : ''}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { }
    return { status: response.status, body: result, text, language: response.headers.get('content-language') };
  }
  async function user(name) { return runtime.users.createUser({ Name: name, Password: password }); }
  async function login(name) { const result = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: name, Pw: password } }); assert.equal(result.status, 200); return result.body.AccessToken; }
  return { root, request, user, login, errors, releases, get runtime() { return runtime; }, get database() { return database; },
    async reopen() { const schema = database.schemaName; await runtime.close(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create(); } };
}

test('postgres: display preferences use real authentication, retain client and item scope, and survive restart', enabled, async t => {
  const state = await setup(t); const admin = await state.user('Administrator'), regular = await state.user('Regular');
  const user = await state.runtime.users.getUser(regular.Id);
  await state.runtime.users.updatePolicy(user.Id, { ...user.Policy, EnableUserPreferenceAccess: false });
  const token = await state.login('Regular'), url = '/DisplayPreferences/usersettings?client=emby';
  const defaults = await state.request(url, { token });
  assert.equal(defaults.status, 200); assert.equal(defaults.language, 'en-US');
  assert.equal(defaults.body.Id, nativeGuid(md5Guid('usersettings')).toLowerCase());
  assert.equal(defaults.body.CustomPrefs.skipForwardLength, '30000'); assert.equal(defaults.body.CustomPrefs.enableNextVideoInfoOverlay, 'False');
  const custom = JSON.parse('{"homesection0":"Resume","chromecastVersion":"unstable","skipForwardLength":"42000","landing-movies":"Movies","__proto__":"kept","foo":"a\\u0000b","nullable":null}');
  assert.equal((await state.request(url, { token, method: 'POST', body: { Id: 'ignored', Client: 'ignored', SortBy: 'DateCreated',
    SortOrder: 'Descending', ShowSidebar: true, PrimaryImageWidth: 900, CustomPrefs: custom } })).status, 204);
  const saved = await state.request(url, { token });
  assert.equal(saved.body.SortBy, 'DateCreated'); assert.equal(saved.body.SortOrder, 'Descending'); assert.equal(saved.body.PrimaryImageWidth, 250);
  assert.equal(saved.body.CustomPrefs.foo, 'a\0b'); assert.equal(saved.body.CustomPrefs.__proto__, 'kept'); assert.equal(saved.body.CustomPrefs.nullable, null);
  assert.equal(saved.body.CustomPrefs.homesection0, 'resume'); assert.equal(saved.body.CustomPrefs.skipBackLength, '15000');
  assert.equal((await state.request('/DisplayPreferences/usersettings?client=Emby', { token })).body.SortBy, 'SortName');
  assert.equal((await state.request('/DisplayPreferences/other?client=emby', { token })).body.SortBy, 'SortName');
  assert.equal((await state.request(url + '&userId=' + admin.Id, { token })).status, 403);
  assert.equal((await state.request(url)).status, 401);
  await state.reopen(); assert.deepEqual((await state.request(url, { token })).body, saved.body);
  assert.deepEqual(state.errors.map(error => ({ status: error.status, message: error.message })), [{ status: 403, message: 'Forbidden' }]);
});

test('postgres: display preference API keys select explicit users and preserve foreign-key failures', enabled, async t => {
  const state = await setup(t); const owner = await state.user('Owner');
  const key = await state.runtime.apiKeys.create('Preferences API');
  const url = '/DisplayPreferences/usersettings?client=web', token = key.AccessToken;
  assert.equal((await state.request(url, { token })).status, 500);
  assert.equal((await state.request(url + '&userId=00000000000000000000000000000099', { token })).status, 500);
  assert.equal((await state.database.rows('DisplayPreferences')).length, 0);
  assert.equal((await state.request(url + '&userId=' + owner.Id, { token })).status, 200);
  const rows = await state.database.rows('DisplayPreferences'); assert.equal(rows.length, 1); assert.equal(rows[0].UserId, nativeGuid(owner.Id));
  assert.equal(state.errors.length, 2); assert.ok(state.errors.every(error => error.code === '23503'));
});

test('postgres: runtime closure drains admitted display preference commits and rejects new work', enabled, async t => {
  const state = await setup(t); await state.user('Closing'); const token = await state.login('Closing');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const interceptedDatabase = state.database, original = interceptedDatabase.client.query.bind(interceptedDatabase.client);
  let captured = false;
  state.database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (!captured && text.startsWith('UPDATE "ItemDisplayPreferences"')) { captured = true; entered.resolve(); await release.promise; }
    return original(...args);
  };
  state.releases.push(() => { release.resolve(); interceptedDatabase.client.query = original; });
  const closingService = state.runtime.displayPreferences, originalClose = closingService.close.bind(closingService);
  const serviceCloseEntered = Promise.withResolvers();
  closingService.close = (...args) => {
    const draining = originalClose(...args); serviceCloseEntered.resolve(); return draining;
  };
  state.releases.push(() => { closingService.close = originalClose; });
  const pending = state.request('/DisplayPreferences/usersettings?client=emby', { token, method: 'POST', body: { SortBy: 'Name', CustomPrefs: { foo: 'saved' } } });
  // Observe rejection immediately while the write is held, then still await
  // the original request below so transport failures cannot become success.
  void pending.catch(() => {});
  await entered.promise;
  let closed = false; const closing = state.runtime.close().then(() => { closed = true; });
  assert.equal((await state.request('/DisplayPreferences/usersettings?client=emby', { token })).status, 503);
  // Runtime first drains previously admitted configuration dependencies. A
  // direct service call is rejected only once that service's actual close has
  // synchronously closed admission; an earlier call would be admitted work.
  await serviceCloseEntered.promise;
  await assert.rejects(state.runtime.displayPreferences.get('usersettings', nativeGuid('00000000000000000000000000000001'), 'emby'), { status: 503 });
  assert.equal(closed, false); release.resolve(); assert.equal((await pending).status, 204); await closing;
  assert.equal(state.runtime.server.listening, false); assert.equal(state.database.closed, true);
  await state.reopen();
  const result = await state.request('/DisplayPreferences/usersettings?client=emby', { token });
  assert.equal(result.status, 200); assert.equal(result.body.SortBy, 'Name'); assert.equal(result.body.CustomPrefs.foo, 'saved');
});

test('postgres: display preference queries scope unrelated data and page large final dictionaries', enabled, async t => {
  const state = await setup(t); const owner = await state.user('Scale'), userId = nativeGuid(owner.Id), itemId = nativeGuid(md5Guid('usersettings'));
  const defaults = await state.runtime.displayPreferences.get('usersettings', owner.Id, 'emby'); assert.equal(defaults.SortBy, 'SortName');
  const display = (await state.database.rows('DisplayPreferences'))[0];
  await state.database.insertBatch('DisplayPreferences', Array.from({ length: 20000 }, (_, index) => postgresTestRow('DisplayPreferences', {
    UserId: userId, ItemId: nativeGuid(md5Guid('unrelated-' + index)), Client: 'background'
  })));
  await state.database.insertBatch('CustomItemDisplayPreferences', Array.from({ length: 300 }, (_, index) => ({ UserId: userId, ItemId: itemId, Client: 'emby', Key: 'custom-' + index, Value: String(index) })));
  await state.database.insertBatch('HomeSection', Array.from({ length: 260 }, (_, index) => ({ DisplayPreferencesId: display.Id, Order: index, Type: index % 10 })));
  const queries = [], original = state.database.client.query.bind(state.database.client);
  state.database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text, result = await original(...args);
    if (/^SELECT .* FROM "(?:DisplayPreferences|ItemDisplayPreferences|HomeSection|CustomItemDisplayPreferences)"/u.test(text)) queries.push({ text, count: result.rows.length });
    return result;
  };
  state.releases.push(() => { state.database.client.query = original; });
  const actual = await state.runtime.displayPreferences.get('usersettings', owner.Id, 'emby');
  assert.equal(actual.CustomPrefs.size, 566); assert.equal(actual.CustomPrefs.get('custom-299'), '299'); assert.equal(actual.CustomPrefs.get('homesection259'), 'resumebook');
  assert.equal(queries.length, 8); assert.ok(queries.every(query => query.count <= 128 && query.text.includes(' WHERE ') && query.text.includes(' LIMIT ')));
});

test('postgres: display preferences retain the native display and home snapshot across later item lookup', {
  ...enabled, skip: !postgresTestConnectionString || !currentPreferenceInputsAvailable, timeout: 300000,
}, async t => {
  const { native } = await captureDisplayPreferenceSnapshot();
  const state = await setup(t); await state.user('Snapshot'); const token = await state.login('Snapshot');
  const url = '/DisplayPreferences/usersettings?client=emby';
  assert.equal((await state.request(url, { token, method: 'POST', body: { ShowBackdrop: true, CustomPrefs: { homesection0: 'Resume' } } })).status, 204);
  const display = (await state.database.rows('DisplayPreferences'))[0];
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), database = state.database;
  const original = database.client.query.bind(database.client); let captured = false;
  database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text;
    if (!captured && text.startsWith('SELECT ') && text.includes(' FROM "ItemDisplayPreferences"')) { captured = true; entered.resolve(); await release.promise; }
    return original(...args);
  };
  state.releases.push(() => { release.resolve(); database.client.query = original; });
  const pending = state.request(url, { token }); await entered.promise;
  await database.transaction(async database => {
    await database.update('DisplayPreferences', { Id: display.Id }, { ShowBackdrop: false });
    await database.updateWhere('HomeSection', { DisplayPreferencesId: display.Id }, { Type: 6 });
  });
  release.resolve(); const result = await pending; assert.equal(result.status, 200);
  assert.deepEqual({ ShowBackdrop: result.body.ShowBackdrop, home: result.body.CustomPrefs.homesection0 }, native.observation.actual);
  const current = await state.request(url, { token }); assert.equal(current.body.ShowBackdrop, false); assert.equal(current.body.CustomPrefs.homesection0, 'latestmedia');
});

test('postgres: display preference dictionary pages retain one read snapshot across concurrent updates', enabled, async t => {
  const state = await setup(t); const owner = await state.user('Dictionary'), token = await state.login('Dictionary');
  const url = '/DisplayPreferences/usersettings?client=emby';
  assert.equal((await state.request(url, { token, method: 'POST', body: {} })).status, 204);
  const where = { UserId: nativeGuid(owner.Id), ItemId: nativeGuid(md5Guid('usersettings')), Client: 'emby' };
  await state.database.insertBatch('CustomItemDisplayPreferences', Array.from({ length: 300 }, (_, index) => ({ ...where, Key: 'entry-' + index, Value: 'old' })));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), database = state.database;
  const original = database.client.query.bind(database.client); let captured = false;
  database.client.query = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0].text, result = await original(...args);
    if (!captured && text.startsWith('SELECT ') && text.includes(' FROM "CustomItemDisplayPreferences"')) { captured = true; entered.resolve(); await release.promise; }
    return result;
  };
  state.releases.push(() => { release.resolve(); database.client.query = original; });
  const pending = state.request(url, { token }); await entered.promise;
  await database.updateWhere('CustomItemDisplayPreferences', where, { Value: 'new' });
  release.resolve(); const result = await pending; assert.equal(result.status, 200);
  for (let index = 0; index < 300; index++) assert.equal(result.body.CustomPrefs['entry-' + index], 'old');
  assert.equal((await state.request(url, { token })).body.CustomPrefs['entry-299'], 'new');
});
