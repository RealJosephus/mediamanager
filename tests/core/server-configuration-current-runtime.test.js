import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile, serializeConfiguration } from '../../src/core/configuration-file.js';
import { cloneNativeValue, parseLosslessJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];

const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';
const bytesValue = value => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex'), base64: value.toString('base64') });
const retainedValues = value => cloneNativeValue(Object.fromEntries(['ServerName', 'PreviousVersion', 'PreviousVersionStr',
  'CastReceiverApplications', 'QuickConnectAvailable', 'CorsHosts', 'ContentTypes'].map(name => [name, value[name]])));
const sortedRows = rows => rows.sort((left, right) => String(left.Id) < String(right.Id) ? -1 : String(left.Id) > String(right.Id) ? 1 : 0);

function diagnostic(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => diagnostic(entry, seen));
    return Object.fromEntries((value instanceof Error ? [...new Set(['name', ...Object.getOwnPropertyNames(value)])] : Object.keys(value))
      .map(name => [name, diagnostic(value[name], seen)]));
  } finally { seen.delete(value); }
}

test('full configuration replacement connects retained incoming writes to real runtime readers and cold persistence', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'server-configuration-current-runtime-'));
  assertValidationOutputChild(root);
  const configDirectory = path.join(root, 'config'), filename = path.join(configDirectory, 'system.xml');
  const report = { schemaVersion: 1, scope: 'Real PostgreSQL, Local storage, configuration replacement and current HTTP consumers, direct save and cold runtime reopen.',
    http: [], stages: [], closures: [], onError: [], xml: [], localStorage: [],
    actualNativeExecuted: false, phaseAcceptance: false, releaseAcceptance: false };
  const failures = [];
  const onError = error => report.onError.push(diagnostic(error));
  let database, runtime, previous, incoming, token, userId, baselineRows, initialUserConfiguration, origin, generation = 0;
  let connectionPids, relationSchema, serverId;
  const orderedViewId = 'f32a0000000000000000000000000001';
  const witness = path.join(root, 'data', 'metadata', 'current-runtime-witness.txt');
  const witnessBytes = Buffer.from('Actual Local plugin bytes retained across configuration replacement and restart.\n');
  const initial = { ServerName: 'Initial current source', PreviousVersion: '1.2.3', PreviousVersionStr: '1.2.3',
    CastReceiverApplications: [{ Id: 'stored-receiver', Name: 'Stored receiver' }], QuickConnectAvailable: true,
    CorsHosts: ['https://initial.example'], ContentTypes: [{ Name: path.join(root, 'initial-content'), Value: 'movies' }] };
  const posted = { ...initial, ServerName: 'POST current source', PreviousVersion: '2.3.4', PreviousVersionStr: '2.3.4',
    CastReceiverApplications: [{ Id: 'posted-receiver', Name: 'Posted receiver' }], CorsHosts: ['https://posted.example'],
    ContentTypes: [{ Name: path.join(root, 'posted-content'), Value: 'music' }] };
  const late = { ...posted, ServerName: 'Late incoming current source', PreviousVersion: '4.5.6', PreviousVersionStr: '4.5.6',
    CastReceiverApplications: [{ Id: 'late-receiver', Name: 'Late receiver' }], QuickConnectAvailable: false,
    CorsHosts: ['https://late.example'] };
  const detached = { ...initial, ServerName: 'Detached initial source', PreviousVersion: '9.9.9', PreviousVersionStr: '9.9.9',
    CastReceiverApplications: [{ Id: 'detached-receiver', Name: 'Detached receiver' }], QuickConnectAvailable: true,
    CorsHosts: ['https://detached.example'], ContentTypes: [{ Name: path.join(root, 'detached-content'), Value: 'books' }] };
  const reverse = { ...late, ServerName: 'Current writes retained incoming', PreviousVersion: '7.8.9', PreviousVersionStr: '7.8.9',
    CastReceiverApplications: [{ Id: 'reverse-receiver', Name: 'Reverse receiver' }], QuickConnectAvailable: true,
    CorsHosts: ['https://reverse.example'], ContentTypes: [{ Name: path.join(root, 'reverse-content'), Value: 'tvshows' }] };

  const open = async settings => {
    generation++; connectionPids = new Set();
    const track = client => connectionPids.add(client.processID);
    database.pool.on('connect', track);
    connectionPids.add((await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    runtime = await createRuntime({ ...settings, database, onError });
    const relations = runtime.linkedChildren.relationDatabase;
    relations.pool.on('connect', track);
    connectionPids.add((await relations.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    relationSchema = runtime.linkedChildren.schemaName;
    await runtime.start();
    origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  };
  const close = async () => {
    if (!runtime) return;
    const observation = { generation, completed: false }; report.closures.push(observation);
    try {
      await runtime.close();
      observation.httpListening = runtime.networkHost.listeners.some(entry => entry.server.listening);
      assert.equal(observation.httpListening, false);
      await assert.rejects(database.rows('Users'), /closed|not open/iu);
      observation.databaseReadsClosed = true;
      const audit = new pg.Client({ connectionString: postgresTestConnectionString });
      await audit.connect();
      try {
        observation.postgres = {
          remainingConnections: (await audit.query('SELECT pid,state FROM pg_stat_activity WHERE pid=ANY($1::integer[]) ORDER BY pid', [[...connectionPids]])).rows,
          relationSchema: (await audit.query('SELECT to_regnamespace($1)::text AS name', [relationSchema])).rows[0].name,
        };
        assert.deepEqual(observation.postgres.remainingConnections, []);
        assert.equal(observation.postgres.relationSchema, null);
      } finally { await audit.end(); }
      observation.completed = true; runtime = undefined;
    } catch (error) { observation.error = diagnostic(error); throw error; }
  };
  const call = async (route, { method = 'GET', body, browserOrigin } = {}) => {
    const observation = { index: report.http.length, generation, route, method,
      ...(body !== undefined && { requestBody: json(body) }), ...(browserOrigin && { origin: browserOrigin }), open: true };
    report.http.push(observation);
    try {
      const response = await fetch(origin + route, { method, signal: t.signal,
        headers: { Accept: 'application/json', 'X-Emby-Token': token,
          ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(browserOrigin && { Origin: browserOrigin }) },
        ...(body !== undefined && { body: observation.requestBody }) });
      const payload = Buffer.from(await response.arrayBuffer()), text = payload.toString('utf8');
      let value = text; if (response.headers.get('content-type')?.includes('json') && text) value = parseLosslessJson(text);
      Object.assign(observation, { status: response.status, headers: Object.fromEntries(response.headers), text, body: value,
        payload: bytesValue(payload) });
      return observation;
    } catch (error) { observation.error = diagnostic(error); throw error; }
    finally { observation.open = false; }
  };
  const userRows = () => runtime.store.run(async db => ({
    users: sortedRows(await db.rows('Users', { where: { Id: nativeGuid(userId) } })),
    preferences: sortedRows(await db.rows('Preferences', { where: { UserId: nativeGuid(userId) } })),
  }));
  const checkpoint = async (label, expected) => {
    const stage = { label, generation, requests: {} }; report.stages.push(stage);
    const read = async (name, route, options) => {
      const response = await call(route, options); stage.requests[name] = response.index;
      assert.equal(response.status, 200, label + ': ' + route); return response;
    };
    const configuration = await read('configuration', '/System/Configuration');
    assert.deepEqual(retainedValues(configuration.body), expected, label + ': public server configuration');
    const info = await read('systemInfo', '/System/Info');
    assert.equal(info.body.ServerName, expected.ServerName);
    assert.deepEqual(info.body.CastReceiverApplications, expected.CastReceiverApplications);
    assert.equal(info.body.Id, serverId);
    const user = await read('userConfiguration', '/Users/' + userId);
    assert.deepEqual(user.body.Configuration, { ...initialUserConfiguration, CastReceiverId: expected.CastReceiverApplications[0].Id });
    const enabled = await read('quickConnect', '/QuickConnect/Enabled');
    assert.equal(enabled.body, expected.QuickConnectAvailable);
    const startup = await read('startupConfiguration', '/Startup/Configuration');
    assert.deepEqual(startup.body, { ServerName: expected.ServerName, UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' });
    const allowed = await read('allowedOrigin', '/System/Configuration', { browserOrigin: expected.CorsHosts[0] });
    assert.equal(allowed.headers['access-control-allow-origin'], expected.CorsHosts[0]);
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
    assert.deepEqual(allowed.body, configuration.body);
    const denied = await read('deniedOrigin', '/System/Configuration', { browserOrigin: detached.CorsHosts[0] });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(denied.headers['access-control-allow-credentials'], undefined);
    assert.deepEqual(denied.body, configuration.body);
    stage.database = await userRows();
    assert.deepEqual(stage.database, baselineRows, label + ': receiver fallback leaves original user and preference rows unchanged');
    stage.current = cloneNativeValue(runtime.configuration);
    stage.retainedIncoming = incoming && cloneNativeValue(incoming);
    stage.retainedInitial = cloneNativeValue(previous);
  };

  try {
    await fs.mkdir(configDirectory);
    await fs.writeFile(filename, serializeConfiguration('server', { ...defaultConfiguration('server'), ...cloneNativeValue(initial), IsStartupWizardCompleted: true }));
    await fs.writeFile(path.join(configDirectory, 'network.xml'), serializeConfiguration('network', { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true }));
    database = await createPostgresTestDatabase(null, 'config_current');
    const settings = await readInstanceConfiguration(root, { onError }); previous = settings.configuration; serverId = settings.serverId;
    await open(settings);
    await runtime.apiKeys.create('Current configuration runtime evidence');
    token = (await runtime.apiKeys.list()).Items[0].AccessToken;
    const status = await call('/Storage/Status'); assert.equal(status.status, 200);
    assert.equal(status.body.application.ready, true);
    assert.ok(status.body.instances.some(instance => instance.type === 'local' && instance.available));
    await runtime.fileSystem.writeFile(witness, witnessBytes);
    assert.deepEqual(await runtime.fileSystem.readFile(witness), witnessBytes);
    assert.deepEqual(await fs.readFile(witness), witnessBytes);
    report.localStorage.push({ generation, filename: witness, payload: bytesValue(await runtime.fileSystem.readFile(witness)) });
    const user = await runtime.users.createUser({ Name: 'Retained configuration reader' }); userId = user.Id;
    const userBefore = await call('/Users/' + userId); assert.equal(userBefore.status, 200);
    const userSaved = await call('/Users/' + userId + '/Configuration', { method: 'POST',
      body: { ...userBefore.body.Configuration, CastReceiverId: initial.CastReceiverApplications[0].Id, OrderedViews: [orderedViewId] } });
    assert.equal(userSaved.status, 204);
    const configuredUser = await call('/Users/' + userId); assert.equal(configuredUser.status, 200);
    initialUserConfiguration = cloneNativeValue(configuredUser.body.Configuration);
    assert.equal(initialUserConfiguration.CastReceiverId, initial.CastReceiverApplications[0].Id);
    assert.deepEqual(initialUserConfiguration.OrderedViews, [orderedViewId]);
    baselineRows = await userRows(); report.initialDatabase = baselineRows;
    assert.equal(baselineRows.users.length, 1); assert.ok(baselineRows.preferences.length > 0);
    assert.equal(baselineRows.users[0].CastReceiverId, initial.CastReceiverApplications[0].Id);
    report.xml.push({ label: 'initial', ...bytesValue(await fs.readFile(filename)) });
    await checkpoint('initial', initial);
    runtime.configurationStore.once('updating', value => { incoming = value; });
    const beforePost = await call('/System/Configuration'); assert.equal(beforePost.status, 200);
    const post = await call('/System/Configuration', { method: 'POST', body: { ...beforePost.body, ...cloneNativeValue(posted) } });
    assert.equal(post.status, 204); assert.equal(post.text, ''); assert.ok(incoming);
    await checkpoint('full POST', posted);
    const postedXml = await fs.readFile(filename); report.xml.push({ label: 'full POST', ...bytesValue(postedXml) });

    incoming.ServerName = late.ServerName; incoming.PreviousVersionStr = ' +4 . 05 .6 ';
    incoming.CastReceiverApplications = cloneNativeValue(late.CastReceiverApplications);
    incoming.QuickConnectAvailable = late.QuickConnectAvailable; incoming.CorsHosts = [...late.CorsHosts];
    await checkpoint('late incoming root writes', late);
    assert.deepEqual(await fs.readFile(filename), postedXml, 'Direct live writes do not save themselves.');

    previous.ServerName = detached.ServerName; previous.PreviousVersionStr = detached.PreviousVersionStr;
    previous.CastReceiverApplications = cloneNativeValue(detached.CastReceiverApplications);
    previous.QuickConnectAvailable = detached.QuickConnectAvailable; previous.CorsHosts = [...detached.CorsHosts];
    previous.ContentTypes = cloneNativeValue(detached.ContentTypes);
    assert.deepEqual(retainedValues(previous), detached);
    await checkpoint('old initial root stays detached', late);
    assert.deepEqual(await fs.readFile(filename), postedXml);

    const current = runtime.configuration;
    current.ServerName = reverse.ServerName; current.PreviousVersion = reverse.PreviousVersion;
    current.CastReceiverApplications = cloneNativeValue(reverse.CastReceiverApplications);
    current.QuickConnectAvailable = reverse.QuickConnectAvailable; current.CorsHosts = [...reverse.CorsHosts];
    current.ContentTypes = cloneNativeValue(reverse.ContentTypes);
    assert.deepEqual(retainedValues(incoming), reverse, 'Current writes remain visible through the retained incoming value.');
    assert.deepEqual(retainedValues(previous), detached);
    await checkpoint('current writes retained incoming', reverse);
    await runtime.configurationStore.saveConfiguration();
    const saved = await fs.readFile(filename), cold = await readConfigurationFile(filename, 'server');
    report.xml.push({ label: 'direct save', ...bytesValue(saved), cold: cloneNativeValue(cold) });
    assert.deepEqual(retainedValues(cold), reverse);
    await checkpoint('saved current', reverse);
    await close();

    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    const coldSettings = await readInstanceConfiguration(root, { onError });
    assert.deepEqual(retainedValues(coldSettings.configuration), reverse);
    assert.equal(coldSettings.serverId, serverId);
    report.xml.push({ label: 'cold reopen', ...bytesValue(await fs.readFile(filename)) });
    await open(coldSettings);
    await checkpoint('cold reopened runtime', reverse);
    assert.deepEqual(await runtime.fileSystem.readFile(witness), witnessBytes);
    report.localStorage.push({ generation, filename: witness, payload: bytesValue(await runtime.fileSystem.readFile(witness)) });
    await close();
  } catch (error) { failures.push(error); }
  finally {
    try { await close(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    try { await dropPostgresTestDatabase(database); report.postgresSchemasRemoved = true; }
    catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(root), output); assert.match(path.basename(root), /^server-configuration-current-runtime-/u);
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true }); report.privateDirectoryRemoved = true;
    } catch (error) { failures.push(error); }
    report.failures = failures.map(error => diagnostic(error)); report.completed = failures.length === 0;
    const filename = path.join(output, path.basename(root) + '.json');
    try { await fs.writeFile(filename, json(report), { flag: 'wx' }); t.diagnostic(json({ report: filename, completed: report.completed })); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Current configuration runtime evidence and cleanup failed.', { cause: failures[0] });
});
