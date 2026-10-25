import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, request as httpRequest, validateHeaderValue } from 'node:http';
import { createSocket } from 'node:dgram';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { startProductionInstance } from '../../src/main.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { defaultConfiguration, parseConfigurationXml, readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, quoteIdentifier } from '../../src/database/model.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { validationOutputRoot, assertValidationOutputChild, validationExecutable } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite'];
const enabled = { skip: !postgresTestConnectionString, timeout: 120000 };
const failureValue = value => value == null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(failureValue)
    : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name'] : [])])]
      .map(name => [name, failureValue(value[name])]));
// Only the known error tree carries diagnostic name/stack fields. Ordinary
// details and context records retain every field, including those same names.
const failurePayload = (value, errorNode = true) => value == null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(entry => failurePayload(entry, errorNode))
    : Object.fromEntries(Object.entries(value).filter(([name]) => !errorNode || name !== 'name' && name !== 'stack')
      .map(([name, entry]) => [name, failurePayload(entry, errorNode && (name === 'cause' || name === 'errors'))]));
const authorization = token => ({ Authorization: 'MediaBrowser Token="' + token + '"' });

async function scenario(t, name, execute, { networkBytes, missingNetwork = false, malformedNetwork = false, rejectedMap = false } = {}) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'network-runtime-')); assertValidationOutputChild(root);
  const instance = path.join(root, 'instance'), configurationDirectoryPath = path.join(instance, 'config');
  const report = { name, scope: 'Formal PostgreSQL runtime, network XML, actual HTTP/WebSocket/UDP consumers and cold reopen.',
    actualNativeExecuted: false, http: [], errors: [], observations: [], cleanup: {}, phaseAcceptance: false };
  const state = { report, releases: [], sockets: [], prefix: '/a', instance, configurationDirectoryPath };
  const operations = new Map(), expectedDiagnostics = new Map();
  let independentXmlFailure;
  if (malformedNetwork) {
    try { readConfigurationDocument(networkBytes, 'network'); }
    catch (error) { independentXmlFailure = failureValue(error); }
    assert.ok(independentXmlFailure, 'The declared malformed input must fail its independent original-bytes parse.');
    report.observations.push({ operation: 'independent-original-network-xml-parse',
      scope: 'A separate parse of the exact original bytes; this is not the later NamedConfigurationStore load operation.',
      bytesBase64: networkBytes.toString('base64'), error: independentXmlFailure });
  }
  let operationIndex = 0;
  const diagnose = (error, context, loadOwner) => {
    const id = context?.request?.headers['x-network-operation'], operation = loadOwner ?? operations.get(id);
    const owner = operation?.open ? { id: operation.id, method: operation.method, path: operation.path } : null;
    report.errors.push({ owner, phase: context?.phase ?? 'background',
      source: context?.request ? null : context, error: failureValue(error) });
  };
  state.assertDiagnostics = () => {
    for (const entry of report.errors) {
      const expected = entry.owner && expectedDiagnostics.get(entry.owner.id);
      assert.ok(expected, 'Unexpected or unowned Network diagnostic: ' + JSON.stringify(entry));
      assert.equal(entry.phase, expected.phase);
      assert.deepEqual(entry.source, expected.source ?? null);
      assert.deepEqual(failurePayload(entry.error), failurePayload(expected.error));
    }
  };
  let token;
  state.request = (route, { method = 'GET', body, rawBody, headers = {}, token: credential = token, prefix = state.prefix, expectedError, expectedPhase = 'action' } = {}) => {
    const source = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const operation = { id: 'request-' + ++operationIndex, open: true, method, path: prefix + route, requestBody: source ?? null, requestHeaders: headers };
    operations.set(operation.id, operation);
    if (expectedError) expectedDiagnostics.set(operation.id, { phase: expectedPhase, error: failureValue(expectedError) });
    report.http.push(operation);
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: state.runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port, path: operation.path, method, signal: t.signal, headers: {
        Accept: 'application/json', ...(credential && authorization(credential)),
        'X-Network-Operation': operation.id,
        ...(source !== undefined && { 'Content-Type': 'application/json' }), ...headers,
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
          Object.assign(operation, { status: response.statusCode, headers: response.headers, text, bodyBase64: bytes.toString('base64') });
          if (text && response.headers['content-type']?.includes('json')) operation.value = JSON.parse(text);
          operation.open = false;
          resolve(operation);
        });
      });
      request.setTimeout(30000, () => request.destroy(new Error('Network runtime request timed out.')));
      request.once('error', error => { operation.open = false; operation.error = failureValue(error); reject(error); });
      request.end(source);
    });
  };
  state.open = async () => {
    const loadOwner = { id: 'load-' + ++operationIndex, method: 'READ', path: path.join(configurationDirectoryPath, 'network.xml'), open: true };
    if (malformedNetwork) expectedDiagnostics.set(loadOwner.id, { phase: 'configuration-xml', error: independentXmlFailure,
      source: { key: 'network', filename: loadOwner.path, phase: 'configuration-xml' } });
    let settings;
    try { settings = await readInstanceConfiguration(instance, { onError: (error, context) => diagnose(error, context, loadOwner) }); }
    finally { loadOwner.open = false; }
    state.runtime = await createRuntime({ database: state.database, ...settings,
      storageConfiguration: path.join(instance, 'storage.json'),
      autoDiscoveryOptions: { host: '127.0.0.1', port: 0 },
      onError: diagnose });
    await state.runtime.start();
    state.origin = 'http://127.0.0.1:' + state.runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
    state.prefix = state.runtime.networkConfiguration.BaseUrl;
  };
  state.reopen = async () => {
    const schema = state.database.schemaName;
    await state.runtime.close(); assert.equal(state.database.closed, true);
    state.database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema });
    await state.open();
  };
  state.current = async () => { const response = await state.request('/System/Configuration/network'); assert.equal(response.status, 200); return response.value; };
  state.save = async changes => {
    const next = { ...await state.current(), ...changes };
    const response = await state.request('/System/Configuration/network', { method: 'POST', body: next });
    assert.equal(response.status, 204, response.text); return next;
  };
  state.disk = async () => {
    const bytes = await fs.readFile(path.join(configurationDirectoryPath, 'network.xml'));
    report.observations.push({ operation: 'network.xml', bytes: bytes.toString('base64') });
    return { bytes, value: parseConfigurationXml(bytes, 'network') };
  };
  state.upgrade = (headers = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(state.origin.replace('http:', 'ws:') + state.prefix + '/socket?ApiKey=' + token, { headers });
    const messages = [], waiters = [];
    socket.on('message', bytes => {
      const value = JSON.parse(bytes.toString()); messages.push(value);
      for (const waiter of [...waiters]) if (waiter.type === value.MessageType) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value); }
    });
    const closed = new Promise(done => socket.once('close', (code, reason) => done({ code, reason: reason.toString() })));
    const entry = { socket, closed, messages, next(type) {
      const existing = messages.find(value => value.MessageType === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, reject, timer: setTimeout(() => reject(new Error('Missing WebSocket ' + type)), 30000) }; waiters.push(waiter);
      });
    } };
    state.sockets.push(entry);
    socket.once('close', () => { for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('WebSocket closed before ' + waiter.type)); } });
    socket.once('open', () => resolve(entry));
    socket.once('error', error => { entry.error = failureValue(error); if (entry.observation) entry.observation.clientError = entry.error; reject(error); });
    socket.once('unexpected-response', (_request, response) => {
      const chunks = []; response.on('data', value => chunks.push(value));
      response.once('end', () => { const result = { status: response.statusCode, headers: response.headers,
        bodyBase64: Buffer.concat(chunks).toString('base64') }; const observation = { operation: 'upgrade', ...result };
        report.observations.push(observation); entry.observation = observation; socket.terminate(); resolve(result); });
      response.once('error', reject);
    });
  });
  t.after(async () => {
    const errors = [], attempt = async (name, operation) => {
      try { await operation(); report.cleanup[name] = true; }
      catch (error) { report.cleanup[name] = failureValue(error); errors.push(error); }
    };
    for (const release of state.releases.reverse()) await attempt('release', release);
    await attempt('runtime', () => state.runtime?.close());
    for (const entry of state.sockets) { if (entry.socket.readyState !== WebSocket.CLOSED) entry.socket.terminate(); }
    await attempt('postgres', () => dropPostgresTestDatabase(state.database));
    await attempt('diagnostics', () => state.assertDiagnostics());
    await attempt('instance', () => fs.rm(instance, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (errors.length) throw new AggregateError(errors, 'Network runtime cleanup failed.', { cause: errors[0] });
  });
  try {
    await fs.mkdir(configurationDirectoryPath, { recursive: true });
    await fs.mkdir(path.join(instance, 'data/data'), { recursive: true });
    await fs.writeFile(path.join(instance, 'data/data/device.txt'), 'c4170000000000000000000000000001');
    await writeConfigurationFile(path.join(configurationDirectoryPath, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
    if (networkBytes !== undefined) await fs.writeFile(path.join(configurationDirectoryPath, 'network.xml'), networkBytes);
    else if (!missingNetwork) await writeConfigurationFile(path.join(configurationDirectoryPath, 'network.xml'), 'network', {
      ...defaultConfiguration('network'), BaseUrl: '/a', KnownProxies: ['127.0.0.1'], EnablePublishedServerUriByRequest: true,
    });
    await fs.writeFile(path.join(instance, 'storage.json'), JSON.stringify({
      instances: [{ id: 'network-state', type: 'local', config: { root: instance, writable: true } }],
      mounts: [{ path: '/network-state', instanceId: 'network-state', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: instance, accessRoot: '/network-state', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', purpose: 'application', returnAccess: 'The isolated Network runtime retains its physical state identity.' }],
    }));
    state.database = await createPostgresTestDatabase(null, 'network_runtime');
    if (rejectedMap) {
      try { await state.open(); assert.fail('A rejected startup path prefix was admitted.'); }
      catch (error) { assert.equal(error.code, 'invalid-application-path'); report.observations.push({ operation: 'rejected-cold-map', error: failureValue(error) }); }
      assert.equal(state.database.closed, true);
      assert.ok(state.runtime.networkHost.listeners.every(entry => !entry.server.listening));
      await execute(state); state.assertDiagnostics(); return;
    }
    await state.open();
    token = (await state.runtime.apiKeys.create('Network runtime')).AccessToken;
    await execute(state);
    state.assertDiagnostics();
    report.phaseAcceptance = true;
  } catch (error) { report.failure = failureValue(error); throw error; }
}

test('postgres: network current, Startup failure prefix, hot LAN/remote rules and raw-key cold continuation share one XML owner', enabled, t => scenario(t, 'current', async state => {
  assert.equal((await state.request('/System/Configuration/network', { token: null })).status, 401);
  await state.runtime.startup.getUser();
  const reader = await state.runtime.users.createUser({ Name: 'Network configuration reader', Password: 'Network reader password' });
  const login = await state.runtime.authentication.authenticateDirect(reader.Id, { Client: 'Network runtime', Device: 'Reader', DeviceId: 'network-reader', Version: '1' });
  assert.equal(login.User.Policy.IsAdministrator, false);
  assert.equal((await state.request('/System/Configuration/network', { token: login.AccessToken })).status, 200);
  assert.equal((await state.request('/System/Configuration/network', { method: 'POST', body: await state.current(), token: login.AccessToken })).status, 403);
  const old = state.runtime.networkConfiguration;
  await state.save({ LocalNetworkSubnets: ['203.0.113.0/24', '!203.0.113.128/25'], RemoteIPFilter: ['198.51.100.0/24'], EnableRemoteAccess: false });
  const lan = await state.request('/System/Endpoint', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(lan.status, 200); assert.deepEqual(lan.value, { IsLocal: false, IsInNetwork: true });
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '203.0.113.200' } })).status, 503);
  const incoming = state.runtime.namedConfiguration.getCurrentConfiguration('network'), persisted = await state.disk();
  incoming.EnableRemoteAccess = true; old.EnableRemoteAccess = false;
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status, 200);
  assert.deepEqual((await state.disk()).bytes, persisted.bytes);
  incoming.BaseUrl = 'alias///';
  assert.equal((await state.request('/System/Info/Public')).status, 302);
  assert.equal(incoming.BaseUrl, '/alias//'); incoming.BaseUrl = '/a';
  const cause = Object.assign(new Error('Controlled network observer cause.'), { code: 'EIO' });
  const failure = Object.assign(new AggregateError([cause, new Error('Controlled second observer detail.')], 'Controlled network updating failure.', { cause }), { code: 'network-updating', status: 507 });
  const observer = ({ key }) => { if (key === 'network') throw failure; };
  state.runtime.namedConfiguration.on('updating', observer);
  try {
    assert.equal((await state.request('/Startup/RemoteAccess', { method: 'POST', body: { EnableRemoteAccess: false }, expectedError: failure })).status, 507);
    assert.equal((await state.current()).EnableRemoteAccess, false);
    assert.deepEqual((await state.disk()).bytes, persisted.bytes);
    state.assertDiagnostics();
  } finally { state.runtime.namedConfiguration.off('updating', observer); }
  assert.equal((await state.request('/Startup/RemoteAccess', { method: 'POST', body: { EnableRemoteAccess: true } })).status, 204);
  assert.equal((await state.disk()).value.EnableRemoteAccess, true);
  await state.save({ LocalNetworkSubnets: ['10.0.0.0/8'], RemoteIPFilter: ['198.51.100.0/24'] });
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 503);
  await state.save({ RemoteIPFilter: [] });
  assert.equal((await state.current()).RemoteIPFilter.length, 0);
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 503);
  state.runtime.networkConfiguration.IsRemoteIPFilterBlacklist = true;
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status, 503);
  const alternate = { ...await state.current(), EnableRemoteAccess: false, BaseUrl: '/cold', RemoteIPFilter: ['203.0.113.0/24'] };
  assert.equal((await state.request('/System/Configuration/NETWORK', { method: 'POST', body: alternate })).status, 204);
  assert.equal((await state.request('/System/Configuration/NETWORK')).value.BaseUrl, '/cold');
  assert.equal((await state.current()).BaseUrl, '/a');
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 200);
  await state.reopen(); assert.equal(state.prefix, '/cold');
  assert.equal((await state.current()).EnableRemoteAccess, false);
  assert.equal((await state.request('/System/Info/Public', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 503);
}));

test('postgres: current redirects, cold proxy options and published URLs reach real HTTP and discovery consumers', enabled, t => scenario(t, 'addresses', async state => {
  const headers = { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'edge.example:8443' };
  assert.equal((await state.request('/System/Info/Public', { headers })).value.LocalAddress, 'https://edge.example:8443/a');
  await state.save({ EnablePublishedServerUriByRequest: false, PublishedServerUriBySubnet: ['all=https://published.example/external/'] });
  assert.equal((await state.request('/System/Info/Public', { headers })).value.LocalAddress, 'https://published.example/external');
  await state.runtime.startAutoDiscovery();
  const socket = createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { socket.once('error', reject).bind(0, '127.0.0.1', resolve); });
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Network discovery response timed out.')), 30000);
      socket.once('message', bytes => { clearTimeout(timer); resolve(JSON.parse(bytes)); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    socket.send('who is JellyfinServer?', state.runtime.autoDiscovery.address().port, '127.0.0.1');
    assert.equal((await received).Address, 'https://published.example/external');
  } finally { socket.close(); }
  await state.save({ KnownProxies: [], EnableRemoteAccess: false, PublishedServerUriBySubnet: [], EnablePublishedServerUriByRequest: true });
  assert.equal((await state.request('/System/Info/Public', { headers })).status, 503, 'The admitted proxy options remain active until cold reopen.');
  await state.save({ BaseUrl: '/b' });
  const oldRoute = await state.request('/System/Info/Public'); assert.equal(oldRoute.status, 302);
  assert.equal(new URL(oldRoute.headers.location, state.origin + oldRoute.path).pathname, '/b/web/');
  assert.equal((await state.request('/b/System/Info/Public', { prefix: '' })).status, 404);
  await state.reopen(); assert.equal(state.prefix, '/b');
  // The old proxy configuration did not change in place; the new runtime now
  // ignores forwarded fields because its cold KnownProxies list is empty.
  const reopened = await state.request('/System/Info/Public', { headers });
  assert.equal(reopened.status, 200); assert.equal(reopened.value.LocalAddress, state.origin + '/b');
}));

test('postgres: network updates reject new HTTP and WS work while admitted writes and established sockets complete', enabled, t => scenario(t, 'admission', async state => {
  const headers = { 'X-Forwarded-For': '203.0.113.9' };
  const entry = await state.upgrade(headers); await entry.next('ForceKeepAlive');
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = state.runtime.users.createUser.bind(state.runtime.users);
  state.runtime.users.createUser = async input => { if (input.Name === 'Admitted network user') { entered.resolve(); await released.promise; } return original(input); };
  state.releases.push(() => { released.resolve(); state.runtime.users.createUser = original; });
  const pending = state.request('/Users/New', { method: 'POST', body: { Name: 'Admitted network user' }, headers });
  await Promise.race([entered.promise, pending.then(() => { throw new Error('User write returned before the controlled admission boundary.'); })]);
  await state.save({ EnableRemoteAccess: false });
  for (const route of ['/System/Info/Public', '/missing']) assert.equal((await state.request(route, { headers })).status, 503);
  assert.equal((await state.request('/System/Ping', { method: 'DELETE', headers })).status, 503);
  assert.equal((await state.request('/System/Configuration/network', { method: 'POST', rawBody: '{bad', headers })).status, 503);
  assert.equal((await state.request('/System/Configuration/network', { method: 'POST', rawBody: '{bad', headers, token: null })).status, 401);
  const rejected = await state.upgrade(headers); assert.equal(rejected.status, 503); assert.equal(rejected.bodyBase64, '');
  released.resolve(); const saved = await pending; assert.equal(saved.status, 200); assert.equal(saved.value.Name, 'Admitted network user');
  assert.equal((await state.runtime.users.getUser(saved.value.Id)).Username, 'Admitted network user');
  entry.socket.send(JSON.stringify({ MessageType: 'KeepAlive' })); assert.equal((await entry.next('KeepAlive')).MessageType, 'KeepAlive');
  const port = state.runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
  await state.runtime.close(); const closed = await entry.closed;
  assert.equal(closed.code, 1000); assert.equal(state.database.closed, true);
  const replacement = createServer();
  await new Promise((resolve, reject) => replacement.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()));
  state.report.observations.push({ operation: 'normal-close', webSocket: closed, listenerPortRebound: true, postgresClosed: true });
}));

for (const input of [
  { name: 'missing-network', missing: true, baseUrl: '' },
  { name: 'malformed-network', bytes: Buffer.from('<NetworkConfiguration><EnableRemoteAccess>not-a-boolean</EnableRemoteAccess></NetworkConfiguration>'), malformed: true, baseUrl: '' },
]) test('postgres: readInstance and runtime cold reads preserve ' + input.name + ' bytes without saving defaults', enabled, t => scenario(t, input.name, async state => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const filename = path.join(state.configurationDirectoryPath, 'network.xml');
    let bytes = null;
    try { bytes = await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.deepEqual(bytes, input.bytes ?? null);
    assert.equal(state.runtime.networkConfiguration.BaseUrl, input.baseUrl);
    state.report.observations.push({ operation: 'cold-network-read', iteration, bytes: bytes?.toString('base64') ?? null,
      baseUrl: state.runtime.networkConfiguration.BaseUrl });
    if (iteration < 2) await state.reopen();
  }
}, { networkBytes: input.bytes, missingNetwork: input.missing, malformedNetwork: input.malformed }));

test('postgres: a cold rejected Map prefix keeps original network bytes and releases the runtime', enabled, t => {
  const bytes = Buffer.from('<NetworkConfiguration><BaseUrl>///</BaseUrl><AutoDiscovery>false</AutoDiscovery></NetworkConfiguration>');
  return scenario(t, 'original-multiple-slashes', async state => {
    assert.deepEqual(await fs.readFile(path.join(state.configurationDirectoryPath, 'network.xml')), bytes);
    const settings = await readInstanceConfiguration(state.instance);
    assert.equal(settings.networkConfiguration.BaseUrl, '//');
    assert.equal(state.runtime.networkConfiguration.BaseUrl, '//');
  }, { networkBytes: bytes, rejectedMap: true });
});

for (const input of [
  { name: 'origin-form', baseUrl: '///prefix', encodedPrefix: '///prefix' },
  { name: 'unicode-prefix', baseUrl: '/中文', encodedPrefix: '/%E4%B8%AD%E6%96%87' },
]) test('postgres: ' + input.name + ' reaches real HTTP and WebSocket consumers', enabled, t => scenario(t, input.name, async state => {
  assert.equal(state.prefix, input.baseUrl);
  if (input.name === 'unicode-prefix') {
    for (const route of ['/System/Info/Public', '/System/Configuration/net%77ork']) {
      const response = await state.request(route, { prefix: input.encodedPrefix });
      assert.equal(response.status, 302); assert.equal(response.headers.location, '../../web/'); assert.equal(response.text, '');
    }
    const upgrade = await state.upgrade(); assert.equal(upgrade.status, 302); assert.equal(upgrade.headers.location, 'web/');
    let original;
    try { validateHeaderValue('Location', '../../中文/web/'); } catch (error) { original = error; }
    assert.ok(original);
    const rejected = await state.request('/System/Configuration/network', { prefix: '', expectedError: original, expectedPhase: 'base-url-redirect' });
    assert.equal(rejected.status, 500); assert.equal(rejected.text, ''); assert.equal(rejected.headers['content-type'], undefined);
    return;
  }
  const response = await state.request('/System/Info/Public', { prefix: input.encodedPrefix }); assert.equal(response.status, 200);
  assert.equal(new URL(response.value.LocalAddress).pathname, input.encodedPrefix);
  const configuration = await state.request('/System/Configuration/net%77ork', { prefix: input.encodedPrefix });
  assert.equal(configuration.status, 200); assert.equal(configuration.value.BaseUrl, input.baseUrl);
  const entry = await state.upgrade(); await entry.next('ForceKeepAlive');
  entry.socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
  assert.equal((await entry.next('KeepAlive')).MessageType, 'KeepAlive');
}, { networkBytes: Buffer.from('<NetworkConfiguration><BaseUrl>' + input.baseUrl + '</BaseUrl><AutoDiscovery>false</AutoDiscovery><EnablePublishedServerUriByRequest>true</EnablePublishedServerUriByRequest></NetworkConfiguration>') }));

test('production main publishes the actual startup environment and command-line values over persisted named overrides', {
  skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'network-production-')); assertValidationOutputChild(root);
  const instance = path.join(root, 'instance'), config = path.join(instance, 'config'), data = path.join(instance, 'data/data');
  const serverId = 'c4170000000000000000000000000002', report = { scope: 'Actual main entry and immutable Native SQLite-to-PostgreSQL transfer contract, startup URL input and HTTP output.',
    observations: [], errors: [], cleanup: {}, phaseAcceptance: false, actualNativeServerExecuted: false };
  let application, database, source;
  t.after(async () => {
    const failures = [], attempt = async (name, operation) => {
      try { await operation(); report.cleanup[name] = true; } catch (error) { report.cleanup[name] = failureValue(error); failures.push(error); }
    };
    await attempt('main', () => application?.close()); await attempt('sqlite', () => source?.close());
    await attempt('postgres', () => dropPostgresTestDatabase(database));
    await attempt('diagnostics', () => assert.deepEqual(report.errors, []));
    await attempt('instance', () => fs.rm(instance, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'Production Network startup cleanup failed.', { cause: failures[0] });
  });
  try {
    await fs.mkdir(config, { recursive: true }); await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'device.txt'), serverId);
    await writeConfigurationFile(path.join(config, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
    await writeConfigurationFile(path.join(config, 'network.xml'), 'network', { ...defaultConfiguration('network'), AutoDiscovery: false,
      InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'],
      PublishedServerUriBySubnet: ['all=https://named.example/value/'], EnablePublishedServerUriByRequest: false });
    const storage = path.join(instance, 'storage.json');
    await fs.writeFile(storage, JSON.stringify({ instances: [{ id: 'state', type: 'local', config: { root: instance, writable: true } }],
      mounts: [{ path: '/state', instanceId: 'state', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: instance, accessRoot: '/state', style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
        purpose: 'application', returnAccess: 'The isolated production entry retains its physical state identity.' }] }));
    const original = await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE), digest = createHash('sha256').update(original).digest('hex');
    report.nativeSqliteInput = { bytes: original.length, sha256: digest };
    const filename = path.join(data, 'jellyfin.db'); await fs.writeFile(filename, original, { flag: 'wx' });
    source = new SqliteDatabase(filename, { requireMigrationHistory: true });
    source.transaction(() => { source.database.exec('PRAGMA defer_foreign_keys = ON'); for (const table of nativeModel.tables) source.database.exec('DELETE FROM ' + quoteIdentifier(table.name)); });
    database = await createPostgresTestDatabase(null, 'network_main');
    await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: digest }, portableMountContract: { mounts: [] } });
    source.close(); source = undefined; await database.close();
    const baseEnvironment = { MEDIAMANAGER_INSTANCE: instance, MEDIAMANAGER_STORAGE: storage,
      MEDIAMANAGER_POSTGRES: postgresTestConnectionString, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      JELLYFIN_FFMPEG: validationExecutable('ffmpeg') };
    for (const input of [
      { environment: { JELLYFIN_PublishedServerUrl: 'https://environment.example/base/' }, args: [], expected: 'https://environment.example/base' },
      { environment: { JELLYFIN_PublishedServerUrl: 'https://environment.example/base/' }, args: ['--published-server-url', 'http://command.example/selected/'], expected: 'http://command.example/selected' },
      { environment: { JELLYFIN_PublishedServerUrl: '   ' }, args: [], expected: '   ' },
    ]) {
      application = await startProductionInstance({ environment: { ...baseEnvironment, ...input.environment }, args: input.args,
        onError: (error, context) => report.errors.push({ owner: context?.request?.headers['x-network-operation'] ?? null, phase: context?.phase ?? 'background', error: failureValue(error) }) });
      const response = await fetch('http://127.0.0.1:' + application.networkHost.listeners.find(entry => entry.scheme === 'http').port + '/System/Info/Public', { headers: { 'X-Network-Operation': 'published-main' } });
      const bytes = Buffer.from(await response.arrayBuffer()), body = JSON.parse(bytes);
      report.observations.push({ input, status: response.status, headers: Object.fromEntries(response.headers), bodyBase64: bytes.toString('base64'), body });
      assert.equal(response.status, 200); assert.equal(body.LocalAddress, input.expected);
      await application.close(); assert.ok(application.networkHost.listeners.every(entry => !entry.server.listening));
    }
    assert.equal(createHash('sha256').update(await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE)).digest('hex'), digest);
    assert.deepEqual(report.errors, []); report.phaseAcceptance = true;
  } catch (error) { report.failure = failureValue(error); throw error; }
});
