import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { WebSocket } from 'ws';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { publishProductionTarget, readProductionTarget } from '../../src/production-target.js';
import { nativeGuid } from '../../src/users/native.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { errorObservation } from '../helpers/error-observation.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE;
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const main = fileURLToPath(new URL('../../src/main.js', import.meta.url));
const bytesValue = value => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex'), base64: value.toString('base64') });

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function observeMaintenanceDdl(client, sql, connectionString, backendPid, observation, acknowledged) {
  Object.assign(observation, { started: new Date().toISOString(), samples: [], waitCounts: {}, diagnosticFailures: [] });
  const started = performance.now();
  const describe = reason => {
    try { return errorObservation(reason); }
    catch { return { unavailable: true, reasonType: typeof reason }; }
  };
  let settled = false, failed = false, queryAcknowledged = false, failure, result, wake;
  const completed = new Promise(resolve => { wake = resolve; });
  const operation = (async () => {
    try { result = await client.query(sql); queryAcknowledged = true; acknowledged(); }
    catch (reason) { failed = true; failure = reason; }
    finally {
      settled = true; observation.finished = new Date().toISOString();
      observation.elapsedMilliseconds = performance.now() - started;
      observation.acknowledged = queryAcknowledged;
      if (failed) observation.failure = describe(failure);
      wake();
    }
  })();
  const reader = new pg.Client({ connectionString, connectionTimeoutMillis: 10000,
    query_timeout: 0, statement_timeout: 1000, application_name: 'mm_lifecycle_ddl_observer' });
  const diagnosticError = reason => { observation.diagnosticFailures.push(describe(reason)); };
  reader.on('error', diagnosticError);
  let readerConnected = false, closeFailed = false, closeFailure;
  const diagnose = async action => {
    try { return await action(); }
    catch (reason) { observation.diagnosticFailures.push(describe(reason)); }
  };
  const observing = (async () => {
    try {
      if (settled) return;
      await reader.connect(); readerConnected = true;
      observation.readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      observation.firstCheckpointSample = await diagnose(async () => (await reader.query('SELECT * FROM pg_stat_checkpointer')).rows);
      while (!settled) {
        await diagnose(async () => {
          const rows = (await reader.query(`SELECT clock_timestamp() AS observed_at,pid,datname,state,backend_type,
            wait_event_type,wait_event,xact_start,query_start,pg_blocking_pids(pid) AS blocked_by
            FROM pg_stat_activity WHERE pid=$1 OR pid=ANY(pg_blocking_pids($1)) ORDER BY pid`, [backendPid])).rows;
          const sample = { elapsedMilliseconds: performance.now() - started, rows };
          observation.firstActivitySample ??= sample;
          observation.samples.push(sample);
          if (observation.samples.length > 64) observation.samples.shift();
          for (const row of rows) if (row.pid === backendPid) {
            const key = JSON.stringify([row.state, row.wait_event_type, row.wait_event]);
            observation.waitCounts[key] = (observation.waitCounts[key] ?? 0) + 1;
          }
        });
        if (!settled) await Promise.race([completed, delay(200)]);
      }
      observation.lastCheckpointSample = await diagnose(async () => (await reader.query('SELECT * FROM pg_stat_checkpointer')).rows);
      observation.databaseStateAfter = await diagnose(async () => (await reader.query(
        'SELECT oid,datname,datconnlimit,datallowconn FROM pg_database WHERE datname=$1', [observation.database])).rows);
    } catch (reason) { observation.diagnosticFailures.push(describe(reason)); }
    finally {
      try { await reader.end(); observation.readerClosed = true; reader.off('error', diagnosticError); }
      catch (reason) { closeFailed = true; closeFailure = reason; }
      observation.readerConnected = readerConnected;
    }
  })();
  await operation; await observing;
  if (closeFailed) {
    if (failed) throw new AggregateError([failure, closeFailure], 'Database maintenance and observer cleanup failed.', { cause: failure });
    throw closeFailure;
  }
  if (failed) throw failure;
  return result;
}

test('the actual production CLI retains its selected target across HTTP restarts and uses a published replacement only in the next process', {
  skip: !enabled, timeout: 300000,
}, async t => discovery.run(async () => {
  const root = path.join(validationOutputRoot(), 'system-lifecycle-process-' + randomUUID()); await mkdir(root, { recursive: true });
  const report = { schemaVersion: 1, actualNativeExecuted: false, phaseAcceptance: false, releaseAcceptance: false,
    scope: 'Direct production src/main.js child processes in one fixture-owned PostgreSQL database; two verified transferred targets, installed Local plugins, authenticated HTTP, WebSocket, same-port restart, next-process selection and natural process exit. Native HTTP policy comparison is independent.',
    requests: [], stages: [], normalShutdown: {}, fixtureCleanup: {} };
  let database, nextDatabase, source, storage, nextStorage, child, childResult, childClosed, socket, failed = false, failure;
  let stdout = '', stderr = '';
  const secrets = new Set();
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const isolatedDatabaseName = 'mm_system_cli_' + randomUUID().replaceAll('-', '');
  const peerSchemaName = 'mm_links_peer_' + randomUUID().replaceAll('-', '');
  let admin, isolatedConnectionString, childConnectionString, isolatedDatabaseCreated = false, peerSchemaCreated = false;
  const verifyPeerRetained = async label => {
    const rows = (await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [peerSchemaName])).rows;
    report.sharedPostgresPeer.retained.push({ label, rows });
    assert.deepEqual(rows, [{ nspname: peerSchemaName }]);
  };
  try {
    // The pinned CI setup-postgres action creates validation with createuser -s.
    // Keep every mm_links schema in this scenario's own database, since sibling
    // test files concurrently own runtime schemas in the shared test database.
    // The server retains the 15-second execution deadline. An equally timed
    // client read deadline can reject before its cancellation/ReadyForQuery
    // arrives, losing the actual outcome of a database-owning DDL command.
    admin = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, query_timeout: 0, statement_timeout: 15000 });
    await admin.connect();
    const maintenance = (await admin.query("SELECT current_database() AS database, current_user AS role, pg_backend_pid() AS pid, current_setting('statement_timeout') AS statement_timeout")).rows[0];
    assert.notEqual(isolatedDatabaseName, maintenance.database);
    report.isolatedPostgres = { database: isolatedDatabaseName, maintenance, created: false, dropped: false };
    report.sharedPostgresPeer = { database: maintenance.database, schema: peerSchemaName, created: false, retained: [], dropped: false };
    report.isolatedPostgres.create = { database: isolatedDatabaseName };
    await observeMaintenanceDdl(admin, `CREATE DATABASE ${quoteIdentifier(isolatedDatabaseName)}`,
      connectionString, maintenance.pid, report.isolatedPostgres.create, () => {
        isolatedDatabaseCreated = true; report.isolatedPostgres.created = true;
      });
    const endpoint = new URL(connectionString); endpoint.pathname = '/' + isolatedDatabaseName;
    isolatedConnectionString = endpoint.href;
    const supplied = await currentNativeSqliteInputs(); report.input = supplied.inputs;
    const sourceFile = path.join(root, 'source.db'); await copyFile(supplied.filename, sourceFile);
    source = new SqliteDatabase(sourceFile, { requireMigrationHistory: true });
    const instance = path.join(root, 'instance'), serverId = randomUUID().replaceAll('-', ''), port = await unusedPort();
    for (const relative of ['config', 'data/data', 'data/metadata', 'cache', 'log']) await mkdir(path.join(instance, relative), { recursive: true });
    await writeFile(path.join(instance, 'data/data/device.txt'), serverId);
    await writeFile(path.join(instance, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><IsPortAuthorized>true</IsPortAuthorized><ServerName>Before lifecycle</ServerName></ServerConfiguration>');
    await writeFile(path.join(instance, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>' + port + '</InternalHttpPort><InternalHttpsPort>8920</InternalHttpsPort><EnableHttps>false</EnableHttps><AutoDiscovery>false</AutoDiscovery><EnableRemoteAccess>true</EnableRemoteAccess><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses><LocalNetworkSubnets><string>10.44.0.0/24</string></LocalNetworkSubnets><KnownProxies><string>127.0.0.1</string></KnownProxies></NetworkConfiguration>');
    await source.snapshot(path.join(instance, 'data/data/jellyfin.db'));
    const state = await discoverInstanceState({ instanceRoot: instance });
    database = await createPostgresTestDatabase(null, 'system_cli', { connectionString: isolatedConnectionString });
    await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: state.identity.digest }, portableMountContract: { mounts: [] } });
    const token = randomUUID().replaceAll('-', '');
    secrets.add(token);
    await database.insert('ApiKeys', { Name: 'System lifecycle CLI', AccessToken: token,
      DateCreated: '2026-10-27 00:00:00', DateLastActivity: '0001-01-01 00:00:00' });
    const definitionFile = path.join(root, 'storage.json');
    const storageDefinition = instanceRoot => ({ instances: [{ id: 'instance', type: 'local', config: { root: instanceRoot, writable: true } }],
      mounts: [{ path: '/instance', instanceId: 'instance', root: '/', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: instanceRoot, accessRoot: '/instance', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'Controlled production instance identity.', purpose: 'application' }] });
    await writeFile(definitionFile, JSON.stringify(storageDefinition(instance)));
    storage = await localStateStorage(instance);
    const witness = path.join(instance, 'data/metadata/lifecycle-original.bin'), original = Buffer.from('Real Local source retained through CLI restart.\0\n');
    await storage.fileSystem.writeFile(witness, original); report.original = bytesValue(await storage.fileSystem.readFile(witness));
    const applicationName = 'mm_system_cli_' + randomUUID().replaceAll('-', '');
    const connection = new URL(isolatedConnectionString); connection.searchParams.set('application_name', applicationName); childConnectionString = connection.href;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (['MEDIAMANAGER_TARGET', 'MEDIAMANAGER_INSTANCE', 'MEDIAMANAGER_POSTGRES',
      'MEDIAMANAGER_POSTGRES_SCHEMA', 'MEDIAMANAGER_STORAGE', 'MEDIAMANAGER_DATABASE'].includes(key.toUpperCase())) delete environment[key];
    const targetFile = path.join(root, 'current-target.json'), connectionEnvironment = 'SYSTEM_LIFECYCLE_TEST_POSTGRES';
    Object.assign(environment, { MEDIAMANAGER_TARGET: targetFile, [connectionEnvironment]: childConnectionString,
      JELLYFIN_FFMPEG: validationExecutable('ffmpeg') });
    const initialTarget = { instancePath: instance, postgresSchema: database.schemaName,
      storageConfigurationPath: definitionFile, postgresUrlEnvironment: connectionEnvironment };
    const nextInstance = path.join(root, 'next-instance'), nextServerId = randomUUID().replaceAll('-', '');
    for (const relative of ['config', 'data/data', 'data/metadata', 'cache', 'log']) await mkdir(path.join(nextInstance, relative), { recursive: true });
    await writeFile(path.join(nextInstance, 'data/data/device.txt'), nextServerId);
    await writeFile(path.join(nextInstance, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><IsPortAuthorized>true</IsPortAuthorized><ServerName>Published next-process target</ServerName></ServerConfiguration>');
    await copyFile(path.join(instance, 'config/network.xml'), path.join(nextInstance, 'config/network.xml'));
    await source.snapshot(path.join(nextInstance, 'data/data/jellyfin.db'));
    const nextState = await discoverInstanceState({ instanceRoot: nextInstance });
    nextDatabase = await createPostgresTestDatabase(null, 'system_next', { connectionString: isolatedConnectionString });
    await transferDatabase(source, nextDatabase, { instanceBinding: { serverId: nextServerId, originIdentityDigest: nextState.identity.digest }, portableMountContract: { mounts: [] } });
    source.close(); source = undefined;
    const nextToken = randomUUID().replaceAll('-', ''); secrets.add(nextToken);
    await nextDatabase.insert('ApiKeys', { Name: 'Next production process', AccessToken: nextToken,
      DateCreated: '2026-10-27 00:00:00', DateLastActivity: '0001-01-01 00:00:00' });
    const nextDefinitionFile = path.join(root, 'next-storage.json');
    await writeFile(nextDefinitionFile, JSON.stringify(storageDefinition(nextInstance)));
    nextStorage = await localStateStorage(nextInstance);
    const nextWitness = path.join(nextInstance, 'data/metadata/lifecycle-next.bin'), nextOriginal = Buffer.from('Local bytes in the published next-process target.\0\n');
    await nextStorage.fileSystem.writeFile(nextWitness, nextOriginal);
    const nextTarget = { instancePath: nextInstance, postgresSchema: nextDatabase.schemaName,
      storageConfigurationPath: nextDefinitionFile, postgresUrlEnvironment: connectionEnvironment };
    await publishProductionTarget(targetFile, initialTarget, { environment });
    assert.deepEqual(await readProductionTarget(targetFile), initialTarget);
    report.targets = { initial: initialTarget, next: nextTarget };
    report.isolatedPostgres.initialRuntimeSchemas = (await database.client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mm_links_%' ORDER BY nspname")).rows.map(row => row.nspname);
    assert.deepEqual(report.isolatedPostgres.initialRuntimeSchemas, []);
    // Admit this real peer only after the runtime-schema baseline. The old
    // shared-database delta would wrongly include it as this CLI's schema.
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(peerSchemaName)}`);
    peerSchemaCreated = true; report.sharedPostgresPeer.created = true;
    await verifyPeerRetained('before first CLI launch');
    const launchCli = () => {
      childResult = undefined;
      child = spawn(process.execPath, [main], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', error => { stderr += '\n' + String(error); });
      childClosed = new Promise(resolve => child.once('close', (code, signal) => { childResult = { code, signal }; resolve(childResult); }));
      return child.pid;
    };
    launchCli();
    report.process = { pid: child.pid, executable: process.execPath, entry: main, port, schema: database.schemaName };
    const origin = 'http://127.0.0.1:' + port;
    const call = async (route, { method = 'GET', accessToken = token, remote, body, record = true } = {}) => {
      const response = await fetch(origin + route, { method, headers: { Accept: 'application/json',
        ...(accessToken !== null && { 'X-Emby-Token': accessToken }), ...(remote && { 'X-Forwarded-For': remote }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.any([t.signal, AbortSignal.timeout(2000)]) });
      const text = await response.text(); let value = null; if (text) try { value = JSON.parse(text); } catch { value = text; }
      const result = { route, method, ...(remote && { remote }), status: response.status, contentType: response.headers.get('content-type'), text, body: value };
      if (record) report.requests.push(result);
      return result;
    };
    const until = async (label, operation, accept) => {
      const deadline = Date.now() + 45000; let last;
      for (;;) {
        if (childResult) throw new Error('The real CLI exited before ' + label + '.', { cause: { ...childResult, stderr } });
        try { last = await operation(); if (accept(last)) return last; } catch (error) { last = error; }
        if (Date.now() >= deadline) throw new Error('The real CLI did not reach ' + label + '.', { cause: last });
        await delay(50, undefined, { signal: t.signal });
      }
    };
    const ready = () => until('authenticated configuration on the actual listener', () => call('/System/Configuration', { record: false }), value => value.status === 200);
    await ready();
    const created = await call('/Users/New', { method: 'POST', body: { Name: 'Lifecycle retained user' } }); assert.equal(created.status, 200);
    const userId = created.body.Id;
    const policy = { ...created.body.Policy, IsAdministrator: false, EnableRemoteAccess: true };
    assert.equal((await call('/Users/' + userId + '/Policy', { method: 'POST', body: policy })).status, 204);
    const userConfiguration = { ...created.body.Configuration, AudioLanguagePreference: 'jpn', SubtitleLanguagePreference: 'zho', RememberAudioSelections: false };
    assert.equal((await call('/Users/' + userId + '/Configuration', { method: 'POST', body: userConfiguration })).status, 204);
    const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Lifecycle CLI", Device="Actual process", DeviceId="system-lifecycle", Version="1"',
    }, body: JSON.stringify({ Username: created.body.Name, Pw: '' }), signal: t.signal });
    const loginText = await login.text();
    report.requests.push({ route: '/Users/AuthenticateByName', status: login.status, text: loginText });
    assert.equal(login.status, 200); const regularToken = JSON.parse(loginText).AccessToken;
    assert.equal(typeof regularToken, 'string'); assert.ok(regularToken.length > 0);
    secrets.add(regularToken);
    const current = await call('/System/Configuration');
    assert.equal((await call('/System/Configuration', { method: 'POST', body: { ...current.body, ServerName: 'Lifecycle saved Local configuration' } })).status, 204);
    const savedConfiguration = (await call('/System/Configuration')).body;
    const userRows = async () => Object.fromEntries(await Promise.all(['Users', 'Permissions', 'Preferences', 'AccessSchedules'].map(async table => [table,
      await database.rows(table, { where: { [table === 'Users' ? 'Id' : 'UserId']: nativeGuid(userId) },
        orderBy: tableDefinition(table).primaryKey.map(column => ({ column, direction: 'ASC' })) })])));
    const savedRows = await userRows(), savedXml = await storage.fileSystem.readFile(path.join(instance, 'config/system.xml'));
    report.savedUserRows = savedRows; report.savedSystemXml = bytesValue(savedXml);
    const resources = async () => ({
      schemas: (await database.client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'mm_links_%' ORDER BY nspname")).rows.map(row => row.nspname),
      connections: (await database.client.query('SELECT pid,backend_start::text AS started,state FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 ORDER BY pid', [applicationName])).rows,
    });
    const verifyRetained = async label => {
      const user = await call('/Users/' + userId); assert.equal(user.status, 200); assert.deepEqual(user.body.Configuration, userConfiguration);
      assert.deepEqual(await userRows(), savedRows); assert.deepEqual((await call('/System/Configuration')).body, savedConfiguration);
      assert.deepEqual(await storage.fileSystem.readFile(path.join(instance, 'config/system.xml')), savedXml);
      assert.deepEqual(await storage.fileSystem.readFile(witness), original);
      report.stages.push({ label, userRows: await userRows(), systemXml: bytesValue(await storage.fileSystem.readFile(path.join(instance, 'config/system.xml'))),
        original: bytesValue(await storage.fileSystem.readFile(witness)), resources: await resources() });
      await verifyPeerRetained(label);
    };
    for (const [route, accessToken, remote, expected] of [
      ['/System/Shutdown', null, undefined, 401], ['/System/Shutdown', 'invalid', undefined, 401],
      ['/System/Shutdown', regularToken, undefined, 403], ['/System/Restart', null, '203.0.113.10', 401],
      ['/System/Restart', 'invalid', '203.0.113.10', 401], ['/System/Restart', regularToken, '203.0.113.10', 403],
    ]) assert.equal((await call(route, { method: 'POST', accessToken, remote })).status, expected);
    await verifyRetained('after denied lifecycle requests');
    await publishProductionTarget(targetFile, nextTarget, { environment });
    assert.deepEqual(await readProductionTarget(targetFile), nextTarget);
    for (const [label, accessToken, remote] of [['LAN regular restart', regularToken, '10.44.0.3'],
      ['remote elevated restart', token, '203.0.113.10'], ['loopback anonymous restart', null, undefined]]) {
      const before = await resources(); assert.ok(before.schemas.length > 0); assert.ok(before.connections.length > 0);
      socket = new WebSocket(origin + '/socket?api_key=' + token); await once(socket, 'open', { signal: t.signal });
      const socketClosed = once(socket, 'close', { signal: t.signal });
      const accepted = await call('/System/Restart', { method: 'POST', accessToken, remote });
      assert.equal(accepted.status, 204); assert.equal(accepted.text, ''); assert.equal(accepted.contentType, null);
      const closedSocket = await Promise.race([socketClosed, delay(30000, undefined, { signal: t.signal, ref: false }).then(() => {
        throw new Error('The actual old WebSocket did not close after the lifecycle response.');
      })]);
      assert.equal(socket.readyState, WebSocket.CLOSED); socket = undefined;
      await until('actual old runtime schema removal', async () => (await database.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [before.schemas])).rows, value => value.length === 0);
      await ready();
      const oldConnections = (await database.client.query('SELECT pid,backend_start::text AS started,state FROM pg_stat_activity WHERE pid=ANY($1::integer[])', [before.connections.map(row => row.pid)])).rows;
      assert.deepEqual(oldConnections, []); assert.equal(childResult, undefined);
      assert.equal(child.pid, report.process.pid);
      assert.deepEqual(await readProductionTarget(targetFile), nextTarget);
      assert.equal((await call('/System/Info/Public')).body.Id, serverId);
      assert.deepEqual(await nextDatabase.rows('Users', { where: { Id: nativeGuid(userId) } }), []);
      report.requests.push({ phase: label + ' actual old owners released', before, oldConnections, socketClose: closedSocket });
      await verifyRetained(label);
    }
    const beforeShutdown = await resources();
    const shutdown = await call('/System/Shutdown', { method: 'POST', remote: '203.0.113.10' });
    assert.equal(shutdown.status, 204); assert.equal(shutdown.text, ''); assert.equal(shutdown.contentType, null);
    const exited = await Promise.race([childClosed, delay(30000, undefined, { signal: t.signal, ref: false }).then(() => {
      throw new Error('The actual CLI did not exit after the completed shutdown response.');
    })]);
    assert.deepEqual(exited, { code: 0, signal: null });
    const remaining = await resources(); assert.deepEqual(remaining, { schemas: [], connections: [] });
    await verifyPeerRetained('after first natural CLI shutdown');
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(await userRows(), savedRows);
    assert.deepEqual(await storage.fileSystem.readFile(path.join(instance, 'config/system.xml')), savedXml);
    assert.deepEqual(await storage.fileSystem.readFile(witness), original);
    report.normalShutdown = { response: shutdown, process: childResult, before: beforeShutdown, remaining, actualPortReboundAfterExit: true,
      persistedUserRows: await userRows(), source: bytesValue(await storage.fileSystem.readFile(witness)) };
    const replacementPid = launchCli();
    assert.notEqual(replacementPid, report.process.pid);
    await until('authenticated replacement target on the actual listener',
      () => call('/System/Configuration', { accessToken: nextToken, record: false }), value => value.status === 200);
    assert.equal((await call('/System/Info/Public', { accessToken: nextToken })).body.Id, nextServerId);
    assert.equal((await call('/System/Configuration', { accessToken: nextToken })).body.ServerName, 'Published next-process target');
    assert.equal((await call('/Users/' + userId, { accessToken: nextToken })).status, 404);
    assert.equal((await call('/System/Configuration')).status, 401);
    assert.deepEqual(await userRows(), savedRows);
    assert.deepEqual(await nextDatabase.rows('Users', { where: { Id: nativeGuid(userId) } }), []);
    assert.deepEqual(await storage.fileSystem.readFile(witness), original);
    assert.deepEqual(await nextStorage.fileSystem.readFile(nextWitness), nextOriginal);
    const nextShutdown = await call('/System/Shutdown', { method: 'POST', accessToken: nextToken });
    assert.equal(nextShutdown.status, 204); assert.equal(nextShutdown.text, ''); assert.equal(nextShutdown.contentType, null);
    assert.deepEqual(await Promise.race([childClosed, delay(30000, undefined, { signal: t.signal, ref: false }).then(() => {
      throw new Error('The actual replacement CLI did not exit after its shutdown response.');
    })]), { code: 0, signal: null });
    assert.deepEqual(await resources(), { schemas: [], connections: [] });
    await verifyPeerRetained('after replacement natural CLI shutdown');
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    report.nextProcess = { pid: replacementPid, serverId: nextServerId, target: await readProductionTarget(targetFile),
      shutdown: nextShutdown, process: childResult, resources: await resources(), actualPortReboundAfterExit: true,
      originalTargetUserRows: await userRows(), nextSource: bytesValue(await nextStorage.fileSystem.readFile(nextWitness)) };
    assert.deepEqual((await currentNativeSqliteInputs()).inputs, supplied.inputs); report.protectedInputsUnchanged = true;
  } catch (error) { failed = true; failure = error; report.failure = errorObservation(error); }
  finally {
    const cleanupFailures = [];
    const cleanup = async (name, close) => {
      try { await close(); report.fixtureCleanup[name] = true; }
      catch (error) { cleanupFailures.push(error); }
    };
    if (socket) await cleanup('WebSocket', () => { socket.terminate(); socket = undefined; });
    if (child && !childResult) {
      report.fixtureCleanup.forcedProcessStop = true;
      cleanupFailures.push(new Error('The production CLI required emergency termination during fixture cleanup.'));
      await cleanup('emergency child stop', async () => {
        child.kill('SIGTERM');
        const stopped = await Promise.race([childClosed, delay(5000, undefined, { ref: false }).then(() => null)]);
        if (stopped === null) { child.kill('SIGKILL'); await childClosed; }
      });
    }
    for (const [name, close] of [['source', () => source?.close()], ['local fixture', () => storage?.close()],
      ['next local fixture', () => nextStorage?.close()], ['first PostgreSQL fixture connections', () => database?.close()],
      ['next PostgreSQL fixture connections', () => nextDatabase?.close()]]) {
      await cleanup(name, close);
    }
    if (peerSchemaCreated) await cleanup('shared PostgreSQL peer before database drop', () => verifyPeerRetained('before isolated PostgreSQL database drop'));
    if (isolatedDatabaseCreated) {
      await cleanup('isolated PostgreSQL database', async () => {
        // Only the exact database acknowledged by our CREATE is owned. Never
        // terminate backends or drop a shared database to make cleanup pass.
        assert.notEqual(isolatedDatabaseName, report.isolatedPostgres.maintenance.database);
        const deadline = Date.now() + 5000;
        let connections;
        for (;;) {
          connections = (await admin.query('SELECT pid,backend_start::text AS started,state,application_name FROM pg_stat_activity WHERE datname=$1 ORDER BY pid', [isolatedDatabaseName])).rows;
          report.isolatedPostgres.connectionsAfterFixtureClose = connections;
          if (connections.length === 0 || Date.now() >= deadline) break;
          await delay(50);
        }
        assert.deepEqual(connections, []);
        report.isolatedPostgres.allConnectionsNaturallyClosed = true;
        const started = performance.now();
        const drop = report.isolatedPostgres.drop = { startedAt: new Date().toISOString() };
        let dropRejected = false, dropError;
        try {
          drop.observation = { database: isolatedDatabaseName };
          await observeMaintenanceDdl(admin, `DROP DATABASE ${quoteIdentifier(isolatedDatabaseName)}`,
            connectionString, report.isolatedPostgres.maintenance.pid, drop.observation,
            () => { report.isolatedPostgres.dropAcknowledged = true; });
        } catch (error) {
          dropRejected = true; dropError = error; drop.failure = errorObservation(error);
        } finally {
          drop.finishedAt = new Date().toISOString();
          drop.elapsedMilliseconds = performance.now() - started;
        }
        let remaining, stateReadRejected = false, stateReadError;
        try {
          remaining = (await admin.query('SELECT datname,datconnlimit FROM pg_database WHERE datname=$1', [isolatedDatabaseName])).rows;
          report.isolatedPostgres.remainingDatabases = remaining;
        } catch (error) {
          stateReadRejected = true; stateReadError = error; drop.stateReadFailure = errorObservation(error);
        }
        // A failed DDL stays failed even when its later catalog observation is
        // empty. Never replay an uncertain DROP or treat absence as its receipt.
        if (dropRejected) {
          if (stateReadRejected) throw new AggregateError([dropError, stateReadError], 'Owned PostgreSQL database drop and state observation failed.', { cause: dropError });
          throw dropError;
        }
        if (stateReadRejected) throw stateReadError;
        assert.deepEqual(remaining, []);
        report.isolatedPostgres.dropped = true;
      });
    }
    if (peerSchemaCreated) {
      if (report.isolatedPostgres.dropped) await cleanup('shared PostgreSQL peer after database drop', () => verifyPeerRetained('after isolated PostgreSQL database drop'));
      await cleanup('shared PostgreSQL peer schema', async () => {
        await admin.query(`DROP SCHEMA ${quoteIdentifier(peerSchemaName)}`);
        const remaining = (await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [peerSchemaName])).rows;
        report.sharedPostgresPeer.remainingSchemas = remaining;
        assert.deepEqual(remaining, []);
        report.sharedPostgresPeer.dropped = true;
      });
    }
    if (admin) await cleanup('PostgreSQL maintenance connection', () => admin.end());
    report.fixtureCleanup.processResult = childResult;
    const redact = text => {
      let result = [childConnectionString, isolatedConnectionString, connectionString].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[isolated PostgreSQL redacted]'), text);
      for (const secret of secrets) result = result.replaceAll(secret, '[credential-sha256:' + createHash('sha256').update(secret).digest('hex') + ']');
      return result;
    };
    // Collect any credential-bearing report fields before publishing process logs.
    try { filterEvidenceJson(report, secrets); }
    catch (error) { cleanupFailures.push(error); }
    for (const [name, text] of [['stdout.log', stdout], ['stderr.log', stderr]]) {
      try { await writeFile(path.join(root, name), redact(text)); }
      catch (error) { cleanupFailures.push(error); }
    }
    report.fixtureCleanup.failures = cleanupFailures.map(error => errorObservation(error));
    try { await writeFile(path.join(root, 'report.json'), redact(filterEvidenceJson(report, secrets))); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupFailures], 'Production lifecycle fixture cleanup failed.', { cause: failed ? failure : cleanupFailures[0] });
  }
  if (failed) throw failure;
}, { signal: t.signal }));
