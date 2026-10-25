import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { refreshLibraryTaskId } from '../../src/tasks/refresh-library-task.js';
import { scheduledTaskFilename } from '../../src/tasks/scheduled-task-store.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase,
  postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['postgres'];

const describeFailure = error => error == null ? null : ({
  ...Object.fromEntries(['message', 'code', 'status', 'path', 'syscall', 'stack'].filter(key => error[key] !== undefined)
    .map(key => [key, error[key]])),
  ...(error.cause !== undefined && { cause: describeFailure(error.cause) }),
  ...(Array.isArray(error.errors) && { errors: error.errors.map(describeFailure) }),
});
const bytes = value => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex'), base64: value.toString('base64') });

function libraryCompletions(tasks, signal, count) {
  const completion = Promise.withResolvers(), results = [];
  const release = () => { tasks.off('completed', completed); signal.removeEventListener('abort', aborted); };
  const completed = event => {
    if (event.Result.Id !== refreshLibraryTaskId) return;
    results.push(event.Result);
    if (results.length === count) { release(); completion.resolve(results); }
  };
  const aborted = () => { release(); completion.reject(signal.reason); };
  tasks.on('completed', completed);
  if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  void completion.promise.catch(() => {});
  return { promise: completion.promise, release };
}

function taskInbox(socket, signal, observations) {
  const pending = new Set();
  const messages = [];
  const abort = () => {
    for (const waiter of pending) waiter.reject(signal.reason);
    pending.clear();
  };
  signal.addEventListener('abort', abort, { once: true });
  socket.on('message', data => {
    const text = data.toString(), message = parseLosslessJson(text);
    messages.push(message); observations.websocketFrames.push({ text, message });
    for (const waiter of [...pending]) if (waiter.matches(message)) {
      pending.delete(waiter); waiter.resolve(message);
    }
  });
  socket.on('error', error => observations.websocketErrors.push(describeFailure(error)));
  const closed = new Promise(resolve => socket.once('close', (code, reason) => {
    signal.removeEventListener('abort', abort);
    const result = { code, reason: reason.toString() };
    for (const waiter of pending) waiter.reject(new Error(`WebSocket closed before its expected task message: ${code} ${result.reason}`));
    pending.clear(); resolve(result);
  }));
  return { messages, closed, next(matches) {
    signal.throwIfAborted();
    const existing = messages.find(matches);
    if (existing) return Promise.resolve(existing);
    const completion = Promise.withResolvers(); pending.add({ matches, ...completion });
    void completion.promise.catch(() => {}); return completion.promise;
  } };
}

test('an admitted configuration POST saves and hands off its real library task before runtime shutdown drains dependencies', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'runtime-configuration-close-'));
  const programDataPath = path.join(root, 'program'), configurationDirectoryPath = path.join(root, 'config');
  const filename = path.join(configurationDirectoryPath, 'system.xml');
  const historyPath = path.join(programDataPath, 'data', 'ScheduledTasks', scheduledTaskFilename(refreshLibraryTaskId));
  const writeEntered = Promise.withResolvers(), releaseWrite = Promise.withResolvers();
  const scanEntered = Promise.withResolvers(), releaseScan = Promise.withResolvers(), updated = Promise.withResolvers();
  void updated.promise.catch(() => {});
  const observations = { http: [], taskEvents: [], websocketFrames: [], websocketErrors: [], onError: [], phaseAcceptance: false, releaseAcceptance: false };
  const failures = [], pids = new Set();
  let database, runtime, pendingPost, activeExecution, closing, listeners, socket, received, normalCompletion, shutdownCompletion, held = false;
  const abortWrite = () => { releaseWrite.resolve(); releaseScan.resolve(); updated.reject(t.signal.reason); };
  t.signal.addEventListener('abort', abortWrite, { once: true });
  try {
    database = await createPostgresTestDatabase(null, 'config_close');
    const trackConnection = client => pids.add(client.processID);
    database.pool.on('connect', trackConnection);
    pids.add((await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath,
      networkConfiguration: { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true },
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: false },
      serverId: 'runtime-configuration-close', onError: error => observations.onError.push(describeFailure(error)) });
    const relations = runtime.linkedChildren.relationDatabase;
    relations.pool.on('connect', trackConnection);
    pids.add((await relations.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const resourceSchema = runtime.linkedChildren.schemaName;
    for (const name of ['started', 'completed']) runtime.tasks.on(name, event => {
      if (event.Task.Id === refreshLibraryTaskId) observations.taskEvents.push({ event: name, ...event });
    });
    await runtime.apiKeys.create('Configuration shutdown regression');
    const token = (await runtime.apiKeys.list()).Items[0].AccessToken;
    const admin = await runtime.users.createUser({ Name: 'Configuration Shutdown Administrator', Password: 'controlled configuration password' });
    const adminRecord = await runtime.users.getUser(admin.Id);
    await runtime.users.updatePolicy(admin.Id, { ...adminRecord.Policy, IsAdministrator: true });
    await runtime.start();
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    const call = async (route, body) => {
      const response = await fetch(origin + route, { headers: { 'X-Emby-Token': token,
        ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }) });
      const text = await response.text(), contentType = response.headers.get('content-type');
      const result = { route, status: response.status, contentType, text,
        ...(text && contentType?.includes('json') && { body: JSON.parse(text) }) };
      observations.http.push(result); return result;
    };
    const loginResponse = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: {
      'Content-Type': 'application/json',
      Authorization: 'MediaBrowser Client="RuntimeClose", DeviceId="configuration-close-ws", Device="RuntimeClose", Version="1.0"',
    }, body: JSON.stringify({ Username: admin.Name, Pw: 'controlled configuration password' }) });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.equal(login.User.Policy.IsAdministrator, true);
    socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/socket?ApiKey=' + encodeURIComponent(login.AccessToken));
    received = taskInbox(socket, t.signal, observations);
    await once(socket, 'open', { signal: t.signal });
    await received.next(message => message.MessageType === 'ForceKeepAlive');
    socket.send(JSON.stringify({ MessageType: 'ScheduledTasksInfoStart', Data: '0,1000' }));
    socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    await received.next(message => message.MessageType === 'KeepAlive');
    const initial = await call('/System/Configuration'); assert.equal(initial.status, 200);
    normalCompletion = libraryCompletions(runtime.tasks, t.signal, 1);
    const normalValue = { ...initial.body, IsStartupWizardCompleted: true, ServerName: 'Normal configuration save' };
    const normalPost = await call('/System/Configuration', normalValue);
    assert.equal(normalPost.status, 204); assert.equal(normalPost.text, '');
    [observations.normalResult] = await normalCompletion.promise;
    assert.equal(observations.normalResult.Status, 'Completed');
    const normalEnded = await received.next(message => message.MessageType === 'ScheduledTaskEnded'
      && message.Data.Id === refreshLibraryTaskId && message.Data.Status === 'Completed');
    assert.deepEqual(normalEnded.Data, observations.normalResult);
    await received.next(message => message.MessageType === 'ScheduledTasksInfo'
      && message.Data.some(task => task.Id === refreshLibraryTaskId && task.LastExecutionResult?.Status === 'Completed'));
    observations.normalHistory = bytes(await fs.readFile(historyPath));
    assert.deepEqual(JSON.parse(Buffer.from(observations.normalHistory.base64, 'base64')), observations.normalResult);

    // The same real scan owner completes another full lifecycle, then holds
    // its return. Shutdown must cancel this operation without requiring its
    // completion before the independently admitted XML save can finish.
    const runScan = runtime.libraryScanner.lifecycle.run.bind(runtime.libraryScanner.lifecycle);
    runtime.libraryScanner.lifecycle.run = async options => {
      const result = await runScan(options);
      scanEntered.resolve(options.signal); await releaseScan.promise;
      return result;
    };
    shutdownCompletion = libraryCompletions(runtime.tasks, t.signal, 2);
    activeExecution = runtime.tasks.execute(refreshLibraryTaskId);
    void activeExecution.catch(() => {});
    const actualScanSignal = await Promise.race([scanEntered.promise,
      activeExecution.then(() => { throw new Error('The scan completed before its held actual lifecycle return.'); })]);
    await received.next(message => message.MessageType === 'ScheduledTasksInfo'
      && message.Data.some(task => task.Id === refreshLibraryTaskId && task.State === 'Running'
        && task.LastExecutionResult?.Status === 'Completed'));

    // Hold the first write on the real system.xml handle after truncation.
    // Releasing the barrier resumes the complete configuration writer.
    runtime.configurationStore.fileSystem = { ...fs, async open(target, flags, ...args) {
      const handle = await fs.open(target, flags, ...args);
      if (path.resolve(target) !== filename || flags !== 'w') return handle;
      return {
        async write(...writeArgs) {
          if (!held) { held = true; writeEntered.resolve({ filename: target, flags }); await releaseWrite.promise; }
          return handle.write(...writeArgs);
        },
        close: () => handle.close(),
      };
    } };
    runtime.configurationStore.once('updated', () => updated.resolve());
    const savedValue = { ...normalValue, IsStartupWizardCompleted: false, ServerName: 'Admitted configuration during shutdown' };
    let responseFinished = false, closeFinished = false;
    pendingPost = call('/System/Configuration', savedValue);
    void pendingPost.then(() => { responseFinished = true; }, () => { responseFinished = true; });
    observations.writeBarrier = await Promise.race([writeEntered.promise,
      pendingPost.then(() => { throw new Error('The configuration POST completed before its held real write.'); })]);
    listeners = runtime.networkHost.listeners;
    closing = runtime.close();
    void closing.then(() => { closeFinished = true; }, () => { closeFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responseFinished, false, 'The admitted POST must retain its real unfinished write.');
    assert.equal(closeFinished, false, 'Runtime shutdown must wait for its admitted configuration save.');
    const rejected = await call('/System/Configuration');
    assert.equal(rejected.status, 503); assert.equal(rejected.text, '');
    releaseWrite.resolve();
    const saved = await pendingPost;
    assert.equal(saved.status, 204); assert.equal(saved.text, '');
    await updated.promise;
    assert.equal(actualScanSignal.aborted, true);
    assert.equal(closeFinished, false, 'The saved updated event hands off before the cancelled scan has drained.');
    releaseScan.resolve();
    observations.shutdownResults = await shutdownCompletion.promise;
    assert.deepEqual(observations.shutdownResults.map(result => result.Status), ['Aborted', 'Aborted']);
    assert.deepEqual(await activeExecution, observations.shutdownResults[0]);
    observations.shutdownResult = observations.shutdownResults.at(-1);
    assert.equal(observations.shutdownResult.Status, 'Aborted');
    assert.equal(observations.shutdownResult.Id, refreshLibraryTaskId);
    assert.equal('ErrorMessage' in observations.shutdownResult, false);
    await closing;
    observations.websocketClose = await received.closed;
    assert.deepEqual(observations.websocketClose, { code: 1000, reason: 'System Shutdown' });
    const wireResults = received.messages.filter(message => message.MessageType === 'ScheduledTaskEnded'
      && message.Data.Id === refreshLibraryTaskId).map(message => message.Data);
    assert.deepEqual(wireResults, [observations.normalResult, ...observations.shutdownResults]);
    const lastTaskInfo = received.messages.filter(message => message.MessageType === 'ScheduledTasksInfo').at(-1);
    assert.deepEqual(lastTaskInfo.Data.find(task => task.Id === refreshLibraryTaskId).LastExecutionResult, observations.shutdownResult);
    assert.deepEqual(observations.websocketErrors, []);
    observations.runtimeClosed = true;
    assert.ok(listeners.every(entry => !entry.server.listening));
    observations.savedXml = bytes(await fs.readFile(filename));
    const cold = await readConfigurationFile(filename, 'server');
    assert.equal(cold.IsStartupWizardCompleted, false); assert.equal(cold.ServerName, savedValue.ServerName);
    observations.shutdownHistory = bytes(await fs.readFile(historyPath));
    assert.deepEqual(JSON.parse(Buffer.from(observations.shutdownHistory.base64, 'base64')), observations.shutdownResult);
    assert.deepEqual(observations.taskEvents.filter(event => event.event === 'completed').map(event => event.Result.Status), ['Completed', 'Aborted', 'Aborted']);
    assert.deepEqual(observations.onError, []);
    await assert.rejects(database.rows('Users'), /closed|not open/iu);

    const audit = new pg.Client({ connectionString: postgresTestConnectionString });
    await audit.connect();
    try {
      observations.postgres = {
        remainingConnections: (await audit.query('SELECT pid,state FROM pg_stat_activity WHERE pid=ANY($1::integer[]) ORDER BY pid', [[...pids]])).rows,
        relationSchema: (await audit.query('SELECT to_regnamespace($1)::text AS name', [resourceSchema])).rows[0].name,
      };
      assert.deepEqual(observations.postgres.remainingConnections, []);
      assert.equal(observations.postgres.relationSchema, null);
    } finally { await audit.end(); }
  } catch (error) { failures.push(error); }
  finally {
    t.signal.removeEventListener('abort', abortWrite);
    releaseWrite.resolve(); releaseScan.resolve(); normalCompletion?.release(); shutdownCompletion?.release();
    for (const result of await Promise.allSettled([pendingPost, activeExecution].filter(Boolean))) {
      if (result.status === 'rejected' && !failures.includes(result.reason)) failures.push(result.reason);
    }
    try { await (closing ?? runtime?.close()); } catch (error) { if (!failures.includes(error)) failures.push(error); }
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    for (const [name, target] of [['finalXml', filename], ['finalHistory', historyPath]]) {
      try { observations[name] = bytes(await fs.readFile(target)); }
      catch (error) { if (error.code !== 'ENOENT') observations[name + 'ReadFailure'] = describeFailure(error); }
    }
    try { await dropPostgresTestDatabase(database); observations.postgresSchemasRemoved = true; }
    catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(root), output); assert.match(path.basename(root), /^runtime-configuration-close-/u);
      await fs.rm(root, { recursive: true, force: true }); observations.privateDirectoryRemoved = true;
    } catch (error) { failures.push(error); }
    observations.failures = failures.map(describeFailure);
    const report = path.join(output, path.basename(root) + '.json');
    try {
      await fs.writeFile(report, JSON.stringify(observations, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
      t.diagnostic(JSON.stringify({ report, failures: observations.failures }));
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Configuration shutdown and cleanup failed.', { cause: failures[0] });
});
