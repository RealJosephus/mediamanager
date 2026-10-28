import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startProductionInstance } from '../../src/main.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { readServerIdentity } from '../../src/core/server-identity.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { databaseFilename, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase, unusedPort } from '../helpers/library-exchange-state.js';
import { errorObservation } from '../helpers/error-observation.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { observeLogFiles } from './fixtures/client-log-current/real-files.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
const inputBytes = await readFile(new URL('./fixtures/client-log-current/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const authorization = (token, client = input.client, version = input.version) => 'MediaBrowser '
  + `Client="${encodeURIComponent(client)}", Device="Client log CI", DeviceId="client-log-ci", Version="${encodeURIComponent(version)}"`
  + (token ? `, Token="${token}"` : '');
const payload = sample => sample.payload === 'maximum' ? Buffer.from(Array.from({ length: 1_000_000 }, (_value, index) => index % 251))
  : sample.payload === 'binary' ? Buffer.from(Array.from({ length: 769 }, (_value, index) => index % 256))
    : sample.payload === 'unicode' ? Buffer.from('CI log: 客户端 Café\nUnknown traceId=literal-business-value\0\uffff\r\n', 'utf8')
      : sample.payload === 'opaque-json' ? Buffer.from('{ malformed JSON\0\xff', 'latin1') : Buffer.alloc(0);
const fileBytes = bytes => ({ bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });

test('actual Native client log HTTP principals, limits and bytes match production PostgreSQL with real file ownership', {
  skip: !enabled, timeout: 900000,
}, async t => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'client-log-http-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), logDirectory = path.join(instanceRoot, 'log');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { inputSha256: sha(inputBytes), native: [], node: [], preparation: [], diagnostics: [], mismatches: [],
    cleanup: [], fullInstanceVerified: false, completeLibraryVerified: false, productionScaleVerified: false,
    phaseAcceptance: false, releaseAcceptance: false };
  const identities = {};
  let current, native, runtime, database, source, files, failure, phase = 'prepare';
  const bounded = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const control = async (route, { method = 'GET', body, token = identities.admin, cleanup = false } = {}) => {
    const response = await fetch(origin + route, { method, signal: bounded(cleanup ? undefined : t.signal),
      headers: { Authorization: authorization(token), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let json;
    if (text) try { json = JSON.parse(text); } catch { /* Retain the actual non-JSON response. */ }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: text, json };
  };
  const poll = async (operation, label) => {
    const deadline = performance.now() + 30000;
    for (;;) {
      t.signal.throwIfAborted();
      const result = await operation(); if (result !== undefined) return result;
      assert.ok(performance.now() < deadline, label);
      await delay(25, undefined, { signal: t.signal });
    }
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await control('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.json.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.json;
      assert.ok(performance.now() < deadline, 'Native task owners must settle.'); await delay(100, undefined, { signal: t.signal });
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const stopped = await native.stop(async () => (await control('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.cleanup.push({ label, ...stopped }); if (stopped.pidGone) native = undefined;
    assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable, label);
  };
  const uploadNames = async () => (await readdir(logDirectory)).filter(name => name.startsWith('upload_')).sort();
  const setEnabled = async value => {
    const response = await control('/System/Configuration'); assert.equal(response.status, 200);
    if (response.json.AllowClientLogUpload !== value) {
      assert.equal((await control('/System/Configuration', { method: 'POST',
        body: { ...response.json, AllowClientLogUpload: value } })).status, 204);
    }
    assert.equal((await control('/System/Configuration')).json.AllowClientLogUpload, value);
  };
  const upload = sample => new Promise((resolve, reject) => {
    const bytes = payload(sample), token = sample.identity === 'anonymous' ? undefined
      : sample.identity === 'invalid' ? 'invalid-client-log-token' : identities[sample.identity ?? 'ordinary'];
    const startedAt = new Date().toISOString();
    const pending = httpRequest(origin + '/ClientLog/Document' + (sample.query ?? ''), { method: 'POST', agent: false,
      signal: bounded(t.signal), headers: { Accept: sample.accept ?? 'application/json',
        'Content-Type': sample.contentType ?? 'text/plain', 'Content-Length': sample.declaredBytes ?? bytes.length,
        ...(sample.identity === 'anonymous' ? {} : { Authorization: authorization(token, sample.client, sample.version) }) } }, response => {
      const parts = []; response.on('data', bytes => parts.push(bytes)); response.once('error', reject);
      response.once('end', () => {
        const raw = Buffer.concat(parts), body = raw.toString('utf8'); let json;
        if (response.headers['content-type']?.includes('json') && raw.length) try { json = JSON.parse(body); } catch { /* Keep the original body. */ }
        resolve({ startedAt, completedAt: new Date().toISOString(), status: response.statusCode,
          headers: { ...response.headers }, body, ...(json === undefined ? {} : { json }), bytes: raw.length, sha256: sha(raw) });
      });
    });
    pending.once('error', reject); pending.end(sample.headersOnly ? undefined : bytes);
  });
  const checkFile = async (sample, response, added, expectedBytes = payload(sample)) => {
    assert.deepEqual(Object.keys(response.json), ['FileName']);
    const name = response.json.FileName; assert.equal(typeof name, 'string'); assert.equal(path.basename(name), name);
    assert.equal(added.length, 1, sample.name + ' creates exactly one upload.');
    const client = sample.identity === 'api' ? input.apiKeyName
      : process.platform === 'win32' && sample.windowsClient !== undefined ? sample.windowsClient : sample.safeClient ?? sample.client ?? input.client;
    const version = sample.identity === 'api' ? 'apikey'
      : process.platform === 'win32' && sample.windowsVersion !== undefined ? sample.windowsVersion : sample.safeVersion ?? sample.version ?? input.version;
    const matched = new RegExp('^upload_' + escaped(client) + '_' + escaped(version) + '_(\\d{14})_([a-f0-9]{32})\\.log$', 'u').exec(name);
    assert.ok(matched, sample.name + ' preserves the actual principal leaf names.');
    const value = matched[1], timestamp = Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8),
      +value.slice(8, 10), +value.slice(10, 12), +value.slice(12, 14));
    assert.ok(timestamp >= Math.floor(Date.parse(response.startedAt) / 1000) * 1000
      && timestamp <= Math.floor(Date.parse(response.completedAt) / 1000) * 1000, 'The filename contains this request\'s actual UTC second.');
    const filename = path.join(logDirectory, name), actual = await readFile(filename);
    assert.deepEqual(actual, expectedBytes, sample.name + ' retains every request byte.');
    const [returned, enumerated] = await Promise.all([lstat(filename, { bigint: true }), lstat(path.join(logDirectory, added[0]), { bigint: true })]);
    assert.ok(returned.isFile() && !returned.isSymbolicLink());
    assert.equal(returned.dev, enumerated.dev); assert.equal(returned.ino, enumerated.ino);
    return { returnedFileName: name, directoryEntry: added[0], safeClient: client, safeVersion: version, ...fileBytes(actual) };
  };
  const functional = observation => {
    const response = observation.response;
    const body = projectProblemTrace(response.json, response.status);
    return { status: response.status, contentType: response.headers['content-type'] ?? null,
      allow: response.headers.allow ?? null, authenticate: response.headers['www-authenticate'] ?? null,
      ...(response.json === undefined ? { body: response.body } : { json: observation.file ? { ...body, FileName: '$own-upload-file' } : body }),
      ...(observation.file ? { file: { safeClient: observation.file.safeClient, safeVersion: observation.file.safeVersion,
        bytes: observation.file.bytes, sha256: observation.file.sha256 } } : {}) };
  };
  const runCases = async label => {
    let allow = true;
    await setEnabled(allow);
    assert.equal((await control('/System/Info')).json.LogPath, logDirectory);
    for (const sample of input.cases) {
      phase = label + ': ' + sample.name;
      if (sample.enabled !== undefined && sample.enabled !== allow) { allow = sample.enabled; await setEnabled(allow); }
      const before = await uploadNames(), observation = { name: sample.name, request: sample,
        requestBytes: { bytes: payload(sample).length, sha256: sha(payload(sample)) }, before }; report[label].push(observation);
      observation.response = await upload(sample); observation.after = await uploadNames();
      const added = observation.after.filter(name => !before.includes(name));
      try {
        assert.equal(observation.response.status, sample.status, sample.name);
        if (observation.response.status === 200) observation.file = await checkFile(sample, observation.response, added);
        else assert.deepEqual(observation.after, before, sample.name + ' must reject before creating a log file.');
      } catch (error) { observation.assertion = errorObservation(error); report.mismatches.push({ label, name: sample.name, error: errorObservation(error) }); }
      observation.functional = functional(observation);
    }
    await setEnabled(true);
  };
  const admittedUploadFile = (before, label, live) => poll(async () => {
    live();
    const added = (await uploadNames()).filter(name => !before.includes(name));
    assert.ok(added.length <= 1, 'An admitted upload owns one actual file.');
    if (!added.length) return undefined;
    const filename = path.join(logDirectory, added[0]), info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    return filename;
  }, label + ' did not create its actual upload owner.');
  const writtenUploadPrefix = (filename, submittedBytes, observation, label, live) => poll(async () => {
    live();
    const info = await lstat(filename);
    assert.ok(info.size <= submittedBytes);
    const witness = { at: new Date().toISOString(), visibleBytes: info.size, submittedBytes,
      requestClosed: observation.requestClosed, responseStarted: observation.responseStarted };
    const progress = observation.writeProgress ??= [];
    if (progress.at(-1)?.visibleBytes !== info.size) progress.push(witness);
    if (!info.size) return undefined;
    live();
    observation.writeWitness = witness;
    return witness;
  }, label + ' did not write a real prefix while its request remained active.');
  const partial = async label => {
    const before = await uploadNames(), prefix = Buffer.alloc(65536, 65), closed = Promise.withResolvers();
    const observation = { label, requestClosed: false, responseStarted: false,
      submittedPrefix: { bytes: prefix.length, sha256: sha(prefix) } }; (report.partial ??= []).push(observation);
    const pending = httpRequest(origin + '/ClientLog/Document', { method: 'POST', agent: false, signal: bounded(t.signal),
      headers: { Authorization: authorization(identities.ordinary), Accept: 'application/json',
        'Content-Type': 'application/octet-stream', 'Content-Length': 100000 } }, response => {
      observation.responseStarted = true; observation.responseStatus = response.statusCode; response.resume();
    });
    pending.once('error', error => { observation.error = errorObservation(error); });
    pending.once('close', () => { observation.requestClosed = true; observation.requestClosedAt = new Date().toISOString(); closed.resolve(); });
    const live = () => {
      assert.equal(observation.requestClosed, false, label + ' closed before its write witness.');
      assert.equal(pending.destroyed, false, label + ' was destroyed before its write witness.');
      assert.equal(observation.responseStarted, false, label + ' completed before its write witness.');
      assert.equal(observation.error, undefined, label + ' failed before its write witness.');
    };
    pending.flushHeaders();
    try {
      const filename = await admittedUploadFile(before, label, live);
      observation.filename = path.basename(filename);
      pending.write(prefix);
      await writtenUploadPrefix(filename, prefix.length, observation, label, live);
      live();
      return { pending, filename, prefix, closed: closed.promise, observation, live };
    } catch (error) { pending.destroy(); throw error; }
  };
  const disconnect = async label => {
    const active = await partial(label);
    active.live(); active.observation.controlledDisconnectAt = new Date().toISOString();
    active.pending.destroy(new Error('Controlled client disconnect.')); await active.closed;
    const bytes = await poll(async () => {
      try { return await readFile(active.filename); } catch (error) { if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return undefined; throw error; }
    }, label + ' did not release its real partial file.');
    Object.assign(active.observation, { filename: path.basename(active.filename), ...fileBytes(bytes) });
    assert.deepEqual(bytes, active.prefix);
    const recovery = { name: label + ' subsequent write', identity: 'ordinary', payload: 'unicode', status: 200 };
    const before = await uploadNames(), response = await upload(recovery); assert.equal(response.status, 200);
    active.observation.recovery = await checkFile(recovery, response, (await uploadNames()).filter(name => !before.includes(name)));
  };
  const chunkedUpload = async (label, attempt, { success = false } = {}) => {
    const name = label + (success ? ' near-limit chunked success' : ' streamed body limit attempt ' + attempt);
    phase = name;
    const scenario = success ? input.chunkedSuccess : input.chunkedLimit;
    const before = await uploadNames(), prefix = Buffer.alloc(success ? scenario.bytes : scenario.prefixBytes, 66);
    const first = prefix.subarray(0, scenario.handshakeBytes);
    const last = success ? prefix.subarray(first.length)
      : Buffer.concat([prefix.subarray(first.length), Buffer.alloc(scenario.overflowBytes, 67)]);
    const sent = Buffer.concat([first, last]);
    const startedAt = new Date().toISOString();
    const completed = Promise.withResolvers(), observation = { label, attempt, contentLengthDeclared: false,
      role: success ? 'acknowledged-complete-chunked-upload' : 'failed-unacknowledged-stream-prefix',
      requestClosed: false, responseStarted: false, submitted: fileBytes(sent),
      clientWrites: [first, last].map(bytes => ({ bytes: bytes.length, sha256: sha(bytes) })) };
    const observations = success ? (report.chunkedSuccesses ??= []) : (report.chunkedLimits ??= []);
    observations.push(observation);
    const encodedChunkBytes = chunk => Buffer.byteLength(chunk.length.toString(16)) + 2 + chunk.length + 2;
    observation.chunkedBodyWireBytes = encodedChunkBytes(first) + encodedChunkBytes(last) + 5;
    if (success) assert.ok(observation.chunkedBodyWireBytes < input.chunkedLimit.prefixBytes,
      'The successful control stays below the limit including both chunk frames and the terminating chunk.');
    completed.promise.catch(() => {});
    let requestSocket;
    const pending = httpRequest(origin + '/ClientLog/Document', { method: 'POST', agent: false, signal: bounded(t.signal),
      headers: { Authorization: authorization(identities.ordinary), Accept: 'application/json',
        'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, response => {
      observation.responseStarted = true;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', completed.reject);
      response.once('end', () => {
        const bytes = Buffer.concat(chunks), body = bytes.toString('utf8'); let json;
        if (response.headers['content-type']?.includes('json') && bytes.length) try { json = JSON.parse(body); } catch { /* Retain the original body. */ }
        completed.resolve({ startedAt, completedAt: new Date().toISOString(), status: response.statusCode, headers: { ...response.headers },
          contentType: response.headers['content-type'] ?? null, body, ...(json === undefined ? {} : { json }), ...fileBytes(bytes) });
      });
    });
    pending.once('socket', socket => { requestSocket = socket; });
    pending.once('error', error => { observation.error = errorObservation(error); completed.reject(error); });
    pending.once('close', () => { observation.requestClosed = true; observation.requestClosedAt = new Date().toISOString(); });
    const live = () => {
      assert.equal(observation.requestClosed, false, label + ' closed before its streamed write witness.');
      assert.equal(pending.destroyed, false, label + ' was destroyed before its streamed write witness.');
      assert.equal(observation.responseStarted, false, label + ' completed before its streamed write witness.');
      assert.equal(observation.error, undefined, label + ' failed before its streamed write witness.');
    };
    pending.flushHeaders();
    try {
      const filename = await admittedUploadFile(before, name, live);
      observation.filename = path.basename(filename);
      pending.write(first);
      await writtenUploadPrefix(filename, first.length, observation, name, live);
      live(); observation.finalWriteSubmittedAt = new Date().toISOString(); pending.end(last);
      observation.response = await completed.promise;
      observation.wireBytesWritten = requestSocket?.bytesWritten ?? null;
      assert.equal(observation.response.status, scenario.status);
      const added = (await uploadNames()).filter(entry => !before.includes(entry));
      assert.deepEqual(added, [path.basename(filename)], 'The streamed request retains exactly its own admitted file.');
      if (success) {
        assert.ok(Number.isSafeInteger(observation.wireBytesWritten)
          && observation.wireBytesWritten >= observation.chunkedBodyWireBytes
          && observation.wireBytesWritten < input.chunkedLimit.prefixBytes,
        'The real successful HTTP socket sends less than one million bytes including headers and framing.');
        observation.file = await checkFile({ name, identity: 'ordinary' }, observation.response, added, sent);
        observation.functional = functional(observation);
        return observation.functional;
      }
      const bytes = await poll(async () => {
        try { return await readFile(filename); }
        catch (error) { if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return undefined; throw error; }
      }, name + ' did not release its streamed failure file.');
      Object.assign(observation, fileBytes(bytes));
      const invariants = observation.prefixInvariants = {
        witnessedPositiveWrite: observation.writeWitness.visibleBytes > 0,
        witnessedBytesRetained: bytes.length >= observation.writeWitness.visibleBytes,
        withinOneMillionBytes: bytes.length <= prefix.length,
        exactOwnRequestPrefix: bytes.equals(prefix.subarray(0, bytes.length)),
        overflowByteAbsent: !bytes.includes(67),
      };
      assert.ok(Object.values(invariants).every(value => value === true),
        'The complete failed-stream file retains its witnessed original prefix without overflow.');
      const recovery = { name: name + ' recovery', identity: 'ordinary', payload: 'unicode', status: 200 };
      const recoveryBefore = await uploadNames(), response = await upload(recovery);
      observation.recovery = { response };
      assert.equal(response.status, 200);
      observation.recovery.file = await checkFile(recovery, response,
        (await uploadNames()).filter(name => !recoveryBefore.includes(name)));
      const { status, contentType, body } = observation.response;
      observation.functional = { role: observation.role, response: { status, contentType, body },
        prefixInvariants: invariants, recovery: functional(observation.recovery) };
      return observation.functional;
    } finally { pending.destroy(); }
  };
  const chunkedRepeatability = label => {
    const observations = report.chunkedLimits.filter(row => row.label === label);
    return { diagnosticOnly: true, sameProcess: true, attempts: observations.length,
      payloadHashes: observations.map(row => row.submitted.sha256), fileLengths: observations.map(row => row.bytes),
      fileHashes: observations.map(row => row.sha256),
      sameCompleteFiles: new Set(observations.map(row => `${row.bytes}:${row.sha256}`)).size === 1 };
  };
  try {
    current = await currentNativeReference(); identities.admin = current.accessToken; output.addSecret(current.accessToken);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/ClientLogController.cs',
      'Jellyfin.Api/BaseJellyfinApiController.cs',
      'MediaBrowser.Controller/ClientEvent/ClientEventLogger.cs', 'src/Jellyfin.Extensions/PathHelper.cs',
      'Jellyfin.Server.Implementations/Security/AuthorizationContext.cs', 'Jellyfin.Api/Attributes/AcceptsFileAttribute.cs',
      'Jellyfin.Api/Models/ClientLogDtos/ClientLogDocumentResponseDto.cs']);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-client-log', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await control('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const password = randomUUID(); output.addSecret(password);
    const user = await control('/Users/New', { method: 'POST', body: { Name: 'Client_log_ordinary', Password: password } });
    assert.equal(user.status, 200); assert.equal(user.json.Policy.IsAdministrator, false);
    const login = await control('/Users/AuthenticateByName', { method: 'POST', token: null,
      body: { Username: 'Client_log_ordinary', Pw: password } });
    assert.equal(login.status, 200); identities.ordinary = login.json.AccessToken; output.addSecret(identities.ordinary);
    assert.equal((await control('/Auth/Keys?app=' + encodeURIComponent(input.apiKeyName), { method: 'POST' })).status, 204);
    const keys = await control('/Auth/Keys'); assert.equal(keys.status, 200);
    identities.api = keys.json.Items.find(key => key.AppName === input.apiKeyName)?.AccessToken; assert.ok(identities.api); output.addSecret(identities.api);
    report.preparation.push({ ordinaryUserId: user.json.Id, administrator: user.json.Policy.IsAdministrator, actualApiKeyCreated: true });
    await runCases('native'); await disconnect('native-disconnect');
    const nativeChunkedSuccess = await chunkedUpload('native', 1, { success: true });
    const nativeChunkedLimits = [];
    for (let attempt = 1; attempt <= input.chunkedLimit.repetitions; attempt++) nativeChunkedLimits.push(await chunkedUpload('native', attempt));
    report.chunkedRepeatability = { native: chunkedRepeatability('native') };
    await stopNative('native-client-log-complete');
    await stoppedDatabase(databaseFilename(instanceRoot));
    const serverId = await readServerIdentity(path.join(instanceRoot, 'data', 'data'));
    const originFiles = [];
    for (const filename of [databaseFilename(instanceRoot), path.join(instanceRoot, 'data', 'data', 'device.txt'),
      path.join(instanceRoot, 'config', 'system.xml'), path.join(instanceRoot, 'config', 'network.xml')]) {
      const bytes = await readFile(filename);
      originFiles.push({ filename: path.relative(instanceRoot, filename), bytes: bytes.length, sha256: sha(bytes) });
    }
    report.binding = { serverId, originIdentityDigest: sha(Buffer.from(JSON.stringify(originFiles))) };
    report.stoppedOrigin = { scope: 'actual-stopped-sqlite-and-critical-instance-files', files: originFiles,
      wholeInstanceGeneration: false };
    const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const contract = { mounts: [{ mountId: 'client-log-instance', identityRoot: root, accessRoot: '/client-log-instance',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'client-log-instance', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/client-log-instance', instanceId: 'client-log-instance', capabilities: {
        create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
      { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/client-log-instance', style, caseSensitive,
        returnAccess: 'The isolated HTTP instance and its internal metadata.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty ancestors of the isolated HTTP instance.' }],
    }, null, 2) + '\n');
    database = await createPostgresTestDatabase(null, 'client_log_http');
    source = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    try {
      report.imported = await transferDatabase(source, database, { instanceBinding: report.binding, portableMountContract: contract });
      assert.deepEqual(await databaseDigest(database), await databaseDigest(source));
    } finally { source.close(); source = undefined; }
    files = observeLogFiles(logDirectory);
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') }, onError: error => report.diagnostics.push({ phase, error: errorObservation(error) }) });
    assert.ok(runtime.implementedRoutes.includes('POST /ClientLog/Document'));
    await idle(); await runCases('node'); await disconnect('node-disconnect');
    const nodeChunkedSuccess = await chunkedUpload('node', 1, { success: true });
    try { assert.deepEqual(nodeChunkedSuccess, nativeChunkedSuccess,
      'The near-limit chunked success response and complete own-file bytes must match Native.'); }
    catch (error) { report.mismatches.push({ name: 'near-limit chunked success', error: errorObservation(error) }); }
    for (let attempt = 1; attempt <= input.chunkedLimit.repetitions; attempt++) {
      const nodeChunkedLimit = await chunkedUpload('node', attempt);
      try { assert.deepEqual(nodeChunkedLimit, nativeChunkedLimits[attempt - 1],
        'The public streamed-limit response, own-prefix invariants and exact recovery must match Native attempt ' + attempt + '.'); }
      catch (error) { report.mismatches.push({ name: 'streamed body limit attempt ' + attempt, error: errorObservation(error) }); }
    }
    report.chunkedRepeatability.node = chunkedRepeatability('node');
    await runtime.drainRequests();
    for (const sample of input.cases) {
      const expected = report.native.find(row => row.name === sample.name), actual = report.node.find(row => row.name === sample.name);
      try { assert.deepEqual(actual.functional, expected.functional, sample.name); }
      catch (error) { report.mismatches.push({ name: sample.name, error: errorObservation(error) }); }
    }
    for (const opened of files.opened) { assert.equal(opened.closed, true); await assert.rejects(opened.handle.stat(), { code: 'EBADF' }); }
    const gate = files.holdNextClose(), active = await partial('node-shutdown');
    active.live(); active.observation.runtimeCloseRequestedAt = new Date().toISOString();
    const listeners = runtime.networkHost.listeners, closing = runtime.close(); let settled = false;
    closing.then(() => { settled = true; }, () => { settled = true; });
    try {
      const handle = await Promise.race([gate.entered, delay(30000, undefined, { signal: t.signal, ref: false }).then(() => { throw new Error('Runtime close did not reach its real file owner.'); })]);
      assert.equal(settled, false); assert.equal(handle.closed, false);
      assert.equal((await handle.handle.stat()).size, active.prefix.length);
      gate.release(); await closing; runtime = undefined; await active.closed;
      assert.equal(handle.closed, true); await assert.rejects(handle.handle.stat(), { code: 'EBADF' });
      const bytes = await readFile(active.filename);
      Object.assign(active.observation, { filename: path.basename(active.filename), ...fileBytes(bytes), actualHandleClosed: true });
      assert.deepEqual(bytes, active.prefix);
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      report.cleanup.push({ runtimeClosed: true, actualHandlesClosed: files.opened.every(owner => owner.closed), portAvailable: true });
    } finally { gate.release(); active.pending.destroy(); await closing; runtime = undefined; }
    report.fileOwners = files.opened.map(owner => ({ filename: path.basename(owner.filename), closed: owner.closed }));
    assert.deepEqual(report.mismatches, []);
  } catch (error) { failure = error; report.error = errorObservation(error); }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: errorObservation(error) });
    } };
    await attempt(() => { source?.close(); source = undefined; });
    await attempt(() => stopNative('finally-native-client-log'));
    files?.restore();
    await attempt(async () => { if (runtime) { await runtime.close(); runtime = undefined; } });
    await attempt(async () => { if (!runtime) { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresOwnerClosed: true }); } });
    await attempt(async () => { if (current) { await current.finish(); report.protectedCurrentInputUnchanged = true; } });
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), sourceBindings: report.sourceBindings,
      actualNativeHttp: report.native.length === input.cases.length, productionNodePostgresHttp: report.node.length === input.cases.length,
      scope: 'client-log-upload-http-and-files', completeLibraryVerified: false, fullInstanceVerified: false,
      productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false }));
    if (!native && !runtime) await attempt(() => output.publishAndClose());
    else await attempt(async () => {
      failure ??= new Error('Client log owners did not release their private instance.');
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, passed: false, privateRootRetained: true }));
    });
  }
  if (failure) throw output.publicError(failure);
}, { signal: t.signal }));
