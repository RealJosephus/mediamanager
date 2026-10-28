import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE);
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
const helper = fileURLToPath(new URL('../helpers/production-failure-process.js', import.meta.url));

function startProcess(environment, signal) {
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [helper], { env: environment, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', timeout: 100000 });
  const records = [], waiters = new Set();
  let stdout = '', stderr = '', spawnError, result;
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', error => { spawnError = errorObservation(error); });
  const closed = new Promise(resolve => child.once('close', (code, closeSignal) => {
    result = { code, signal: closeSignal, spawnError: spawnError ?? null, stdout, stderr };
    for (const pending of [...waiters]) pending.reject(new Error('Production process closed before its response.'));
    resolve(result);
  }));
  child.on('message', record => {
    records.push(record);
    for (const pending of [...waiters]) if (pending.matches(record)) pending.resolve(record);
  });
  const wait = matches => {
    const observed = records.find(matches);
    if (observed) return Promise.resolve(observed);
    if (result) return Promise.reject(new Error('Production process has already closed.'));
    return new Promise((resolve, reject) => {
      const settle = (operation, value) => { waiters.delete(pending); signal.removeEventListener('abort', aborted); operation(value); };
      const pending = { matches, resolve: value => settle(resolve, value), reject: error => settle(reject, error) };
      const aborted = () => pending.reject(signal.reason);
      waiters.add(pending);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  };
  const send = value => new Promise((resolve, reject) => child.send(value, error => error ? reject(error) : resolve()));
  return { child, closed, records, wait, send,
    async inspect() {
      const id = randomUUID(), response = wait(record => record.type === 'observed' && record.id === id);
      await send({ type: 'inspect', id });
      return response;
    },
    async stop() {
      if (result) return result;
      if (child.connected) await send({ type: 'close' });
      return closed;
    },
    async cleanup() {
      if (result) return result;
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        if (child.connected) await send({ type: 'close' }).catch(() => {});
        return await closed;
      } finally { clearTimeout(timer); }
    },
  };
}

async function assertPortReleased(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('the production default logger preserves primitive plugin HTTP failures and permits subsequent committed work and shutdown', {
  skip: !enabled, timeout: 120000,
}, async t => discovery.run(async () => {
  const root = path.join(validationOutputRoot(), 'production-failures-' + randomUUID());
  await mkdir(root);
  const instance = path.join(root, 'instance'), temporary = path.join(root, 'temporary');
  for (const relative of ['config', 'cache', 'log', 'data/data', 'data/metadata']) {
    await mkdir(path.join(instance, relative), { recursive: true });
  }
  await mkdir(temporary);
  const serverId = randomUUID().replaceAll('-', '');
  await writeFile(path.join(instance, 'data/data/device.txt'), serverId);
  await writeFile(path.join(instance, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted><UICulture>en-US</UICulture></ServerConfiguration>');
  await writeFile(path.join(instance, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><InternalHttpsPort>8920</InternalHttpsPort><EnableHttps>false</EnableHttps><AutoDiscovery>false</AutoDiscovery><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>');
  const storage = path.join(root, 'storage.json');
  await writeFile(storage, JSON.stringify({ instances: [], mounts: [], prefixes: [] }));
  const packageRoot = path.join(root, 'plugin');
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@test/production-failures', version: '0.1.0', type: 'module',
    mediamanager: { id: 'production-failures', name: 'Controlled production failures', entry: 'index.js' } }));
  await writeFile(path.join(packageRoot, 'index.js'), `export async function activate(context) {
    for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]) {
      await context.register('route', { method: 'GET', path: '/ProductionFailures/' + name,
        handle() { throw reason; } });
    }
  }
`);
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const connection = new URL(connectionString), owner = 'production_failures_' + randomUUID().replaceAll('-', '');
  connection.searchParams.set('application_name', owner);
  const token = randomUUID().replaceAll('-', ''), secrets = new Set([connectionString, connection.href, token]);
  const report = { requests: [], failures: [], users: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  let database, source, worker, failed = false, failure;
  try {
    const supplied = await currentNativeSqliteInputs(), sourceFile = path.join(root, 'source.db');
    report.input = { inputs: supplied.inputs, mountContract: supplied.receipt.mountContract };
    await copyFile(supplied.filename, sourceFile);
    source = new SqliteDatabase(sourceFile, { requireMigrationHistory: true });
    await source.snapshot(path.join(instance, 'data/data/jellyfin.db'));
    const state = await discoverInstanceState({ instanceRoot: instance });
    database = await createPostgresTestDatabase(null, 'production_fail');
    await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: state.identity.digest },
      portableMountContract: { mounts: [] } });
    source.close(); source = undefined;
    await database.insert('ApiKeys', { Name: 'Production failures', AccessToken: token,
      DateCreated: '2026-10-26 00:00:00', DateLastActivity: '0001-01-01 00:00:00' });
    const environment = { ...process.env, MEDIAMANAGER_INSTANCE: instance, MEDIAMANAGER_STORAGE: storage,
      MEDIAMANAGER_POSTGRES: connection.href, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      JELLYFIN_FFMPEG: validationExecutable('ffmpeg'), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    delete environment.MEDIAMANAGER_TARGET;
    delete environment.MEDIAMANAGER_DATABASE;
    worker = startProcess(environment, t.signal);
    const ready = await worker.wait(value => value.type === 'ready' || value.type === 'failure');
    assert.equal(ready.type, 'ready'); assert.notEqual(ready.pid, process.pid);
    assert.equal(ready.schema, database.schemaName); assert.equal(ready.serverId, serverId);
    report.process = ready;
    const origin = `http://127.0.0.1:${ready.port}`;
    const request = async (route, { method = 'GET', body } = {}) => {
      const startedAt = new Date().toISOString();
      const response = await fetch(origin + route, { method,
        headers: { 'X-Emby-Token': token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(10000)]) });
      const text = await response.text();
      const result = { route, method, startedAt, endedAt: new Date().toISOString(), status: response.status,
        headers: Object.fromEntries(response.headers), text };
      report.requests.push(result);
      return result;
    };
    const installed = await request('/Plugins/Install', { method: 'POST', body: { path: packageRoot } });
    assert.equal(installed.status, 200, installed.text);
    assert.equal(JSON.parse(installed.text).status, 'active');
    for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]) {
      const before = await worker.inspect();
      const response = await request('/ProductionFailures/' + name);
      assert.equal(response.status, 500);
      assert.equal(response.text, 'Error processing request.');
      assert.match(response.headers['content-type'], /^text\/plain(?:;|$)/u);
      assert.equal(response.headers['content-language'], 'en-US');
      const observed = await worker.inspect(), failureReports = observed.reports.slice(before.reports.length);
      assert.ok(failureReports.some(entry => entry.arguments.some(argument => argument.type === typeof reason
        && Object.hasOwn(argument, 'value') && Object.is(argument.value, reason))), 'The same failed request must retain its original logger value.');
      report.failures.push({ route: response.route, type: typeof reason, reason, reports: failureReports });
      const ping = await request('/System/Ping');
      assert.equal(ping.status, 200); assert.match(ping.headers['content-type'], /^application\/json(?:;|$)/u);
      assert.equal(JSON.parse(ping.text), 'MediaManager');
      const info = await request('/System/Info/Public');
      assert.equal(info.status, 200); assert.equal(JSON.parse(info.text).Id, serverId);
      const created = await request('/Users/New', { method: 'POST', body: { Name: 'Recovered after ' + name } });
      assert.equal(created.status, 200, created.text);
      const user = JSON.parse(created.text);
      const persisted = await database.rows('Users', { where: { Id: nativeGuid(user.Id) } });
      assert.equal(persisted.length, 1); assert.equal(persisted[0].Username, user.Name);
      report.users.push({ dto: user, persisted: persisted[0] });
    }
    const [stopped, exit] = await Promise.all([worker.wait(value => value.type === 'closed'), worker.stop()]);
    report.shutdown = stopped; report.exit = exit;
    assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.spawnError, null);
    assert.equal(stopped.listenersClosed, true); assert.equal(stopped.databaseClosed, true);
    const connections = await database.client.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1', [owner]);
    assert.deepEqual(connections.rows, []);
    await assertPortReleased(ready.port);
    report.cleanup.portReleased = true; report.cleanup.childConnectionsReleased = true;
    for (const user of report.users) assert.deepEqual(await database.rows('Users', { where: { Id: nativeGuid(user.dto.Id) } }), [user.persisted]);
    assert.deepEqual((await currentNativeSqliteInputs()).inputs, supplied.inputs);
    report.protectedInputsUnchanged = true;
  } catch (error) { failed = true; failure = error; }
  finally {
    const errors = [];
    try { if (worker) report.exit = await worker.cleanup(); report.cleanup.processClosed = true; } catch (error) { errors.push(error); }
    try { source?.close(); } catch (error) { errors.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.schemasRemoved = true; } catch (error) { errors.push(error); }
    report.failed = failed;
    report.failureType = failed ? typeof failure : null;
    report.failure = failed ? errorObservation(failure) : null;
    report.cleanupErrors = errors.map(error => errorObservation(error));
    try { await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets), { flag: 'wx' }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Production HTTP verification or cleanup failed.');
  }
  if (failed) throw failure;
}, { signal: t.signal }));
