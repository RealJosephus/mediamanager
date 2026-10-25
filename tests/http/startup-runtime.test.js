import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSocket } from 'node:dgram';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid, permissionNames } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const enabled = { skip: !postgresTestConnectionString };
const serverId = 'e5300000000000000000000000000001';

async function setup(t, { discovery = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediamanager-startup-runtime-'));
  await fs.mkdir(path.join(root, 'config')); await fs.mkdir(path.join(root, 'data/data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/data/device.txt'), serverId);
  await fs.writeFile(path.join(root, 'config/system.xml'), '<?xml version="1.0" encoding="utf-8"?><ServerConfiguration><IsStartupWizardCompleted>false</IsStartupWizardCompleted><ServerName>Initial</ServerName><UICulture>en-US</UICulture><MetadataCountryCode>US</MetadataCountryCode><PreferredMetadataLanguage>en</PreferredMetadataLanguage><ContentTypes/><Future xmlns:p="urn:future">keep<p:Mixed>值</p:Mixed><![CDATA[<value>]]></Future></ServerConfiguration>');
  await fs.writeFile(path.join(root, 'config/network.xml'), '<NetworkConfiguration><BaseUrl>/media</BaseUrl><EnableRemoteAccess>true</EnableRemoteAccess><InternalHttpPort>0</InternalHttpPort><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses><EnablePublishedServerUriByRequest>true</EnablePublishedServerUriByRequest><AutoDiscovery>' + discovery + '</AutoDiscovery><FutureNetwork>keep</FutureNetwork></NetworkConfiguration>');
  const state = { root, errors: [], releases: [], database: await createPostgresTestDatabase(null, 'startup_runtime') };
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const release of state.releases.reverse()) await attempt(release);
    await attempt(() => state.runtime?.close()); await attempt(() => dropPostgresTestDatabase(state.database));
    await attempt(async () => {
      for (const name of ['system.xml', 'network.xml']) await fs.chmod(path.join(root, 'config', name), 0o666);
      assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('mediamanager-startup-runtime-'));
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Startup runtime cleanup failed.');
  });
  async function open() {
    state.runtime = await createRuntime({ database: state.database, ...await readInstanceConfiguration(root),
      ...(discovery && { autoDiscoveryOptions: { host: '127.0.0.1', port: 0 } }), onError: error => state.errors.push(error) });
    await state.runtime.start();
    state.origin = `http://127.0.0.1:${state.runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  }
  state.request = async (url, { token, method = 'GET', body } = {}) => {
    const response = await fetch(state.origin + '/media' + url, { method,
      headers: { Accept: 'application/json', ...(token && { Authorization: `MediaBrowser Token="${token}"` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, body: value, language: response.headers.get('content-language') };
  };
  state.login = async (name, password) => {
    const response = await fetch(state.origin + '/media/Users/AuthenticateByName', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Startup test", Device="Isolated", DeviceId="startup-device", Version="1.0"' },
      body: JSON.stringify({ Username: name, Pw: password }) });
    assert.equal(response.status, 200); return (await response.json()).AccessToken;
  };
  state.reopen = async () => {
    await state.runtime.close();
    state.database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: state.database.schemaName });
    await open();
  };
  await open(); return state;
}

test('postgres: real startup creates an administrator, configures and authenticates it, persists configuration and locks anonymous setup after completion', enabled, async t => {
  const state = await setup(t, { discovery: true }), events = [];
  for (const event of ['UserCreated', 'UserUpdated', 'UserPasswordChanged']) state.runtime.users.on(event, () => events.push(event));
  const first = await state.request('/Startup/User'); assert.equal(first.status, 200); assert.equal(first.body.Name, os.userInfo().username);
  assert.deepEqual(events, []);
  const user = await state.runtime.users.getFirstUser();
  assert.equal(user.Password, null);
  for (const permission of ['IsAdministrator', 'EnableContentDeletion', 'EnableRemoteControlOfOtherUsers']) assert.equal(user.Permissions.find(row => row.Kind === permissionNames.indexOf(permission)).Value, true);
  assert.equal((await state.request('/Startup/User', { method: 'POST', body: { Name: 'Setup owner', Password: 'Setup password' } })).status, 204);
  assert.deepEqual(events, ['UserUpdated', 'UserPasswordChanged']);
  const token = await state.login('Setup owner', 'Setup password');
  assert.equal((await state.request('/Startup/Configuration', { method: 'POST', body: { ServerName: 'Configured server', UICulture: 'zh-CN', MetadataCountryCode: 'TW', PreferredMetadataLanguage: 'zh-Hant' } })).status, 204);
  assert.equal((await state.request('/Startup/RemoteAccess', { method: 'POST', body: { EnableRemoteAccess: false } })).status, 204);
  const info = await state.request('/System/Info/Public'); assert.equal(info.body.ServerName, 'Configured server'); assert.equal(info.body.ProductName, 'MediaManager'); assert.equal(info.language, 'en-US');
  await state.runtime.startAutoDiscovery();
  const socket = createSocket('udp4');
  try {
    const reply = new Promise((resolve, reject) => { socket.once('message', bytes => resolve(JSON.parse(bytes))); socket.once('error', reject); });
    socket.send('who is JellyfinServer?', state.runtime.autoDiscovery.address().port, '127.0.0.1');
    assert.equal((await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error('Discovery reply timed out.')), 2000))])).Name, 'Configured server');
  } finally { socket.close(); }
  const key = await state.runtime.apiKeys.create('Setup key');
  assert.equal((await state.runtime.authentication.authenticate({ headers: { authorization: `MediaBrowser Token="${key.AccessToken}"` } })).Device, 'Configured server');
  assert.equal((await state.request('/Startup/Complete', { method: 'POST' })).status, 204);
  assert.equal((await state.request('/Startup/Configuration')).status, 401);
  assert.equal((await state.request('/Startup/Configuration', { token })).status, 200);
  assert.equal((await state.request('/Startup/User', { method: 'POST', token, body: { Password: 'another' } })).status, 403);
  await state.reopen();
  assert.equal((await state.request('/System/Info/Public')).body.StartupWizardCompleted, true);
  const result = await state.request('/Startup/Configuration', { token });
  assert.equal(result.status, 200); assert.deepEqual(result.body, { ServerName: 'Configured server', UICulture: 'zh-CN', MetadataCountryCode: 'TW', PreferredMetadataLanguage: 'zh-Hant' });
  assert.equal(state.runtime.networkConfiguration.EnableRemoteAccess, false);
  assert.equal((await state.request('/Startup/Configuration', { token: key.AccessToken })).status, 200);
  assert.equal((await state.login('Setup owner', 'Setup password')).length > 0, true);
  const document = readConfigurationDocument(await fs.readFile(path.join(state.root, 'config/system.xml')), 'server');
  const future = document.node.children.find(node => node.name === 'Future');
  assert.deepEqual(future.content.map(value => typeof value === 'string' ? value : { name: value.name, namespace: value.namespaces.p, text: value.text }),
    ['keep', { name: 'p:Mixed', namespace: 'urn:future', text: '值' }, '<value>']);
  assert.match(await fs.readFile(path.join(state.root, 'config/network.xml'), 'utf8'), /<FutureNetwork>keep<\/FutureNetwork>/u);
  assert.deepEqual(state.errors, []);
});

test('postgres: closing startup rejects new work and drains admitted snapshot, rename and password operations before PostgreSQL closes', enabled, async t => {
  const state = await setup(t); await state.request('/Startup/User');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), users = state.runtime.users, save = users.saveUserSnapshot.bind(users);
  users.saveUserSnapshot = async (...args) => { entered.resolve(); await release.promise; return save(...args); };
  state.releases.push(() => { release.resolve(); users.saveUserSnapshot = save; });
  const pending = state.request('/Startup/User', { method: 'POST', body: { Name: 'Drained owner', Password: 'Drained password' } }); await entered.promise;
  let closed = false; const closing = state.runtime.close().then(() => { closed = true; });
  await assert.rejects(state.runtime.startup.complete(), { status: 503 }); assert.equal(closed, false);
  release.resolve(); assert.equal((await pending).status, 204); await closing;
  assert.equal(state.database.closed, true); assert.equal(state.runtime.networkHost.listeners.some(listener => listener.server.listening), false);
  await state.reopen(); assert.equal((await state.runtime.users.getFirstUser()).Username, 'Drained owner');
  assert.ok(await state.login('Drained owner', 'Drained password')); assert.deepEqual(state.errors, []);
});

test('postgres: the first user remains the original insertion after 20000 lower-ID users, with one-row SQL selection and scoped hydration', enabled, async t => {
  const state = await setup(t); await state.request('/Startup/User'); const first = await state.runtime.users.getFirstUser();
  await state.database.insertBatch('Users', Array.from({ length: 20000 }, (_, index) => postgresTestRow('Users', {
    Id: nativeGuid(`00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`), Username: 'Noise' + index, NormalizedUsername: 'NOISE' + index,
    InternalId: 0n, AuthenticationProviderId: first.AuthenticationProviderId, PasswordResetProviderId: first.PasswordResetProviderId
  })));
  const intercepted = state.database, original = intercepted.client.query.bind(intercepted.client), queries = [];
  intercepted.client.query = async (...args) => {
    const result = await original(...args); queries.push({ text: typeof args[0] === 'string' ? args[0] : args[0].text, parameters: args[1] ?? args[0].values, rows: result.rows.length }); return result;
  };
  try { assert.equal((await state.runtime.users.getFirstUser()).Id, first.Id); }
  finally { intercepted.client.query = original; }
  const selection = queries.filter(query => query.text.includes('user_order'));
  assert.equal(selection.length, 1); assert.equal(selection[0].rows, 1); assert.equal(selection[0].parameters[0], 1);
  assert.ok(queries.filter(query => /SELECT/u.test(query.text)).every(query => query.rows <= 24));
});

test('postgres: a failed Complete save changes live authorization, while restart uses the unchanged native configuration file', enabled, async t => {
  const state = await setup(t), store = state.runtime.startup.configurationStore, fileSystem = store.fileSystem;
  let writeAttempted = false;
  store.fileSystem = { ...fileSystem, open: async (filename, flags, ...args) => {
    if (flags === 'w' && path.basename(filename) === 'system.xml') {
      writeAttempted = true;
      throw Object.assign(new Error('Controlled configuration write admission failure.'), { code: 'EACCES' });
    }
    return fileSystem.open(filename, flags, ...args);
  } };
  try {
    assert.equal((await state.request('/Startup/Complete', { method: 'POST' })).status, 500);
    assert.equal(writeAttempted, true);
    assert.equal((await state.request('/System/Info/Public')).body.StartupWizardCompleted, true);
    assert.equal((await state.request('/Startup/Configuration')).status, 401);
  } finally { store.fileSystem = fileSystem; }
  await state.reopen(); assert.equal((await state.request('/System/Info/Public')).body.StartupWizardCompleted, false);
  assert.equal((await state.request('/Startup/Configuration')).status, 200);
  for (const error of state.errors) assert.deepEqual({ code: error.code, message: error.message },
    { code: 'EACCES', message: 'Controlled configuration write admission failure.' });
});
