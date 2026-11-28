import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { readProductionTarget } from '../../src/production-target.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE;
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const sourceUrlName = 'PRODUCTION_TARGET_TEST_POSTGRES';
const helper = fileURLToPath(new URL('../helpers/production-target-process.js', import.meta.url));
const publisher = fileURLToPath(new URL('../../tools/publish-target.js', import.meta.url));

function launch(script, args, environment, ipc = false) {
  const child = spawn(process.execPath, [script, ...args], { env: environment, windowsHide: true, timeout: 120000,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', error => { stderr += error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const next = () => Promise.race([once(child, 'message').then(([value]) => value),
    closed.then(result => { throw new Error('Target process exited before its message: ' + result.stderr); })]);
  return { child, closed, next, async stop() {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: 'close' });
    return closed;
  } };
}

test('verified target publication preserves active HTTP writers and cold PostgreSQL and configuration state', {
  skip: !enabled, timeout: 300000,
}, async t => discovery.run(async () => {
  const root = path.join(validationOutputRoot(), 'production-target-' + randomUUID()); await mkdir(root);
  const temporary = path.join(root, 'temporary'); await mkdir(temporary);
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const sourceEnvironmentName = process.platform === 'win32' ? sourceUrlName.toLowerCase() : sourceUrlName;
  const targetEnvironmentName = process.platform === 'win32' ? 'mediamanager_target' : 'MEDIAMANAGER_TARGET';
  const environment = { ...process.env, [sourceEnvironmentName]: connectionString,
    JELLYFIN_FFMPEG: validationExecutable('ffmpeg'), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  for (const name of ['MEDIAMANAGER_TARGET', 'MEDIAMANAGER_INSTANCE', 'MEDIAMANAGER_POSTGRES', 'MEDIAMANAGER_POSTGRES_SCHEMA',
    'MEDIAMANAGER_STORAGE', 'MEDIAMANAGER_DATABASE']) delete environment[name];
  const currentFile = path.join(root, 'current.json'), proposal = path.join(root, 'proposal.json');
  const databases = [], processes = [], tokens = [];
  const report = { publications: [], processes: [], observedSelections: [], requests: [], persistedUsers: [], cleanup: {},
    fullInstanceVerified: false, productionScaleVerified: false };
  let source, failure, failed = false, firstProcess;
  const publish = async target => {
    await writeFile(proposal, JSON.stringify(target));
    const worker = launch(publisher, ['--source', proposal, '--output', currentFile], environment); processes.push(worker);
    const result = await worker.closed; report.publications.push(result);
    assert.equal(result.stdout.includes(connectionString), false); assert.equal(result.stderr.includes(connectionString), false);
    return result;
  };
  const start = async () => {
    const worker = launch(helper, [], { ...environment, [targetEnvironmentName]: currentFile }, true); processes.push(worker);
    const ready = await worker.next(); assert.equal(ready.type, 'ready'); report.processes.push(ready);
    return { worker, ready };
  };
  const call = async (active, targetIndex, route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${active.ready.port}${route}`, { method,
      headers: { 'X-Emby-Token': tokens[targetIndex], Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(10000)]) });
    const text = await response.text();
    let value = null;
    if (text) try { value = JSON.parse(text); } catch { value = text; }
    const observation = { pid: active.worker.child.pid, schema: active.ready.schema, route, method,
      ...(body === undefined ? {} : { request: body }), status: response.status,
      contentType: response.headers.get('content-type'), text, body: value };
    report.requests.push(observation);
    return observation;
  };
  const persistedUser = async (targetIndex, id, stage) => {
    const database = databases[targetIndex], key = nativeGuid(id);
    const value = {};
    for (const table of ['Users', 'Permissions', 'Preferences', 'AccessSchedules']) {
      value[table] = await database.rows(table, { where: { [table === 'Users' ? 'Id' : 'UserId']: key } });
    }
    report.persistedUsers.push({ stage, schema: database.schemaName, userId: id, value });
    return value;
  };
  const createUser = async (active, targetIndex, name) => {
    const created = await call(active, targetIndex, '/Users/New', { method: 'POST', body: { Name: name } });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.Name, name); assert.equal(created.body.ServerId, active.ready.serverId);
    const configuration = { ...created.body.Configuration, AudioLanguagePreference: 'jpn', SubtitleLanguagePreference: 'zho',
      SubtitleMode: 'Always', RememberAudioSelections: false, EnableNextEpisodeAutoPlay: false,
      OrderedViews: ['11111111111111111111111111111111', '22222222222222222222222222222222'] };
    const saved = await call(active, targetIndex, `/Users/${created.body.Id}/Configuration`, { method: 'POST', body: configuration });
    assert.equal(saved.status, 204); assert.equal(saved.text, '');
    const current = await call(active, targetIndex, `/Users/${created.body.Id}`);
    assert.equal(current.status, 200); assert.deepEqual(current.body.Configuration, configuration);
    const persisted = await persistedUser(targetIndex, created.body.Id, 'created');
    assert.equal(persisted.Users.length, 1); assert.equal(persisted.Users[0].Username, name);
    assert.equal(persisted.Users[0].AudioLanguagePreference, 'jpn');
    assert.equal(persisted.Users[0].SubtitleLanguagePreference, 'zho');
    assert.equal(persisted.Users[0].RememberAudioSelections, false);
    return { dto: current.body, persisted };
  };
  const saveServerName = async (active, targetIndex, name) => {
    const current = await call(active, targetIndex, '/System/Configuration');
    assert.equal(current.status, 200);
    const saved = await call(active, targetIndex, '/System/Configuration', { method: 'POST', body: { ...current.body, ServerName: name } });
    assert.equal(saved.status, 204); assert.equal(saved.text, '');
    const selected = await call(active, targetIndex, '/System/Configuration');
    assert.equal(selected.status, 200); assert.equal(selected.body.ServerName, name);
    return selected.body;
  };
  try {
    const supplied = await currentNativeSqliteInputs(), sourceFile = path.join(root, 'source.db');
    report.input = { inputs: supplied.inputs, mountContract: supplied.receipt.mountContract };
    await copyFile(supplied.filename, sourceFile); source = new SqliteDatabase(sourceFile, { requireMigrationHistory: true });
    const targets = [];
    for (const [index, suffix] of ['a', 'b'].entries()) {
      const instance = path.join(root, 'instance-' + suffix), serverId = String(index + 1).repeat(32);
      await mkdir(path.join(instance, 'config'), { recursive: true }); await mkdir(path.join(instance, 'data', 'data'), { recursive: true });
      for (const relative of ['cache', 'log', 'data/metadata']) await mkdir(path.join(instance, relative), { recursive: true });
      await writeFile(path.join(instance, 'data', 'data', 'device.txt'), serverId);
      await writeFile(path.join(instance, 'config', 'system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted></ServerConfiguration>');
      await writeFile(path.join(instance, 'config', 'network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><InternalHttpsPort>8920</InternalHttpsPort><EnableHttps>false</EnableHttps><AutoDiscovery>false</AutoDiscovery><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>');
      const storage = path.join(root, 'storage-' + suffix + '.json');
      await writeFile(storage, JSON.stringify({ instances: [], mounts: [], prefixes: [] }));
      await source.snapshot(path.join(instance, 'data', 'data', 'jellyfin.db'));
      const instanceState = await discoverInstanceState({ instanceRoot: instance });
      const database = await createPostgresTestDatabase(null, 'target_' + suffix); databases.push(database);
      await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: instanceState.identity.digest }, portableMountContract: { mounts: [] } });
      const token = randomUUID().replaceAll('-', ''); tokens.push(token);
      await database.insert('ApiKeys', { Name: 'Production target ' + suffix, AccessToken: token,
        DateCreated: '2026-10-26 00:00:00', DateLastActivity: '0001-01-01 00:00:00' });
      targets.push({ instancePath: instance, postgresSchema: database.schemaName, storageConfigurationPath: storage, postgresUrlEnvironment: sourceUrlName });
    }
    source.close(); source = undefined;
    const initialPublication = await publish(targets[0]);
    assert.equal(initialPublication.code, 0, initialPublication.stderr); assert.deepEqual(await readProductionTarget(currentFile), targets[0]);
    const originalSelection = await readFile(currentFile);
    const cases = [];
    const definition = {instances:[], mounts:[], prefixes:[], ignorePrefixes:[
      {identityRoot:'/incoming',accessRoot:'missing-leading-slash',style:'posix',returnAccess:'local'}]};
    const explicitStorage = path.join(root,'explicit-storage.json');
    await writeFile(explicitStorage,JSON.stringify(definition));
    const implicitStorage = path.join(targets[1].instancePath,'data','plugins','node','storage.json');
    await mkdir(path.dirname(implicitStorage),{recursive:true});
    await writeFile(implicitStorage,JSON.stringify({instances:[],mounts:[]}));
    for (const [kind, storageConfigurationPath] of [['explicit-ignore-prefix',explicitStorage],['implicit-definition',null]]) {
      const published = await publish({...targets[1],storageConfigurationPath});
      const changedSelection = !(await readFile(currentFile)).equals(originalSelection);
      let cold;
      if (published.code===0) {
        const worker=launch(helper,[],{...environment,[targetEnvironmentName]:currentFile},true);
        processes.push(worker);
        cold=await worker.next();
        if (cold.type==='ready') await worker.stop(); else await worker.closed;
      }
      cases.push({kind,publishCode:published.code,changedSelection,cold});
      assert.equal((await publish(targets[0])).code,0);
    }
    report.audit = cases;
    t.diagnostic('AUDIT '+JSON.stringify(cases));
    assert.ok(cases.every(c=>c.publishCode!==0 && !c.changedSelection),'An unusable proposal must preserve the previous selection');
  } catch (error) { failure = error; failed = true; }
  finally {
    const errors = [];
    for (const worker of processes) try { const result = await worker.stop(); report.processes.push(result); } catch (error) { errors.push(error); }
    try { source?.close(); } catch (error) { errors.push(error); }
    let schemasRemoved = 0;
    for (const database of databases) try { await dropPostgresTestDatabase(database); schemasRemoved++; } catch (error) { errors.push(error); }
    report.cleanup = { processesClosed: processes.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null),
      schemasRemoved: schemasRemoved === databases.length };
    report.failure = failed ? failure?.stack ?? String(failure) : null;
    report.cleanupErrors = errors.map(error => error?.stack ?? String(error));
    const serialized = JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
      .replaceAll(connectionString, '[isolated PostgreSQL redacted]');
    try { await writeFile(path.join(root, 'report.json'), serialized + '\n'); } catch (error) { errors.push(error); }
    t.diagnostic(JSON.stringify(report.cleanup));
    if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Production target verification or cleanup failed.');
  }
  if (failed) throw failure;
}, { signal: t.signal }));
