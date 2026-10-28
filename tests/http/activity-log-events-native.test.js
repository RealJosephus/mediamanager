import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { startProductionInstance } from '../../src/main.js';
import { dateText } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { databaseFilename, idKey, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase,
  unusedPort } from '../helpers/library-exchange-state.js';
import { startDownloadSource } from './fixtures/item-download-http/source.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const mediaLease = declareFileTestResource('native-media-5244', { enabled: Boolean(enabled) });
const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(enabled) });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(enabled) });
const inputBytes = await readFile(new URL('./fixtures/activity-log-events-current/input.json', import.meta.url));
const input = JSON.parse(inputBytes), types = new Set(input.types);
const authorization = (token, deviceId = 'activity-events-admin') => `MediaBrowser Client="${input.client}", Device="${input.device}", DeviceId="${deviceId}", Version="1"${token ? `, Token="${token}"` : ''}`;

test('real user, authentication and Download producers commit activity before real ActivityLog WS consumption', {
  skip: !enabled, timeout: 900000,
}, nativeCallback(t => discovery.run(() => mediaLease.run(async () => {
  const destination = path.join(validationOutputRoot(), 'activity-log-events-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES].filter(Boolean));
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), mediaRoot = path.join(root, 'media');
  await mkdir(mediaRoot);
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const book = { key: 'activity-book', Id: nativeGuid(input.source.itemId), path: path.join(mediaRoot, input.source.filename),
    Name: 'Activity event download', bytes: Buffer.from(input.source.hex, 'hex') };
  const passwords = Object.fromEntries(['reader', 'initial', 'changed', 'wrong'].map(key => [key, randomUUID()]));
  const secret = value => { if (value) { output.addSecret(value); secrets.add(String(value)); } return value; };
  Object.values(passwords).forEach(secret);
  const report = { inputSha256: sha(inputBytes), preparation: [], native: [], node: [], identitiesByRuntime: {}, sourceReads: [], cleanup: [], diagnostics: [],
    mismatches: [], coveredTypes: input.types, outOfScopeProducers: ['Session', 'Playback', 'scheduled tasks', 'plugins'],
    fullInstanceVerified: false, productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false };
  let current, native, runtime, database, reader, nativeFailureDatabase, proxy, side, activeStep, failure, restoreSourceRead;
  let safeToRemove = true;
  const base = {};
  const clients = [];
  const request = async (route, { token = base.admin?.token, method = 'GET', body, deviceId, cleanup = false } = {}) => {
    if (!cleanup) t.signal.throwIfAborted();
    const started = Date.now();
    const response = await fetch(origin + route, { method,
      signal: cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: authorization(token, deviceId), Accept: 'application/json', 'Accept-Language': 'en-US',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const result = { route, method, ...(body === undefined ? {} : { body }), status: response.status,
      headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: sha(bytes),
      clock: { started, completed: Date.now() } };
    if (response.headers.get('content-type')?.includes('json')) {
      result.bodyText = bytes.toString('utf8');
      if (bytes.length) { result.json = JSON.parse(result.bodyText); secret(result.json.AccessToken); }
    } else if (route.endsWith('/Download') && response.status === 200) result.base64 = bytes.toString('base64');
    else result.bodyText = bytes.toString('utf8');
    return result;
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.json.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.json;
      assert.ok(performance.now() < deadline, 'Actual scheduled owners must drain before the business event controls.');
      await delay(100, undefined, { signal: t.signal });
    }
  };
  const waitFor = async (predicate, label) => {
    const deadline = performance.now() + 30000;
    while (!predicate()) {
      t.signal.throwIfAborted(); assert.ok(performance.now() < deadline, label);
      await delay(20, undefined, { signal: t.signal });
    }
  };
  const stopNative = async label => {
    if (!native) return;
    const result = await native.stop(async () => (await request('/System/Shutdown', { method: 'POST', cleanup: true })).status,
      () => portAvailable(port));
    report.cleanup.push({ label, ...result }); safeToRemove &&= result.pidGone;
    if (result.pidGone) native = undefined;
    assert.ok(result.cleanShutdown && result.pidGone && result.portAvailable, label);
  };
  const allRows = () => side.label === 'native' ? reader.rows('ActivityLogs') : database.rows('ActivityLogs');
  const closeNativeFailure = () => {
    if (!nativeFailureDatabase) return;
    const handle = nativeFailureDatabase;
    try { handle.database.exec('DROP TRIGGER activity_events_failure'); }
    finally { handle.close(); nativeFailureDatabase = undefined; }
  };
  const setFailure = async enabled => {
    const values = input.types.map(value => `'${value}'`).join(',');
    if (side.label === 'native') {
      if (!enabled) return closeNativeFailure();
      const handle = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
      try {
        handle.database.exec(`CREATE TRIGGER activity_events_failure BEFORE INSERT ON ActivityLogs WHEN NEW.Type IN (${values}) BEGIN SELECT RAISE(ABORT, 'Controlled activity producer failure'); END`);
        nativeFailureDatabase = handle;
      } catch (error) { handle.close(); throw error; }
    } else if (enabled) {
      await database.client.query(`CREATE FUNCTION ${q(database.schemaName)}.activity_events_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled activity producer failure'; END $$`);
      await database.client.query(`CREATE TRIGGER activity_events_failure BEFORE INSERT ON ${q(database.schemaName)}."ActivityLogs" FOR EACH ROW WHEN (NEW."Type" IN (${input.types.map(value => `convert_to('${value}','UTF8')`).join(',')})) EXECUTE FUNCTION ${q(database.schemaName)}.activity_events_failure()`);
    } else {
      await database.client.query(`DROP TRIGGER activity_events_failure ON ${q(database.schemaName)}."ActivityLogs"`);
      await database.client.query(`DROP FUNCTION ${q(database.schemaName)}.activity_events_failure()`);
    }
  };
  const aliasFor = id => {
    const key = idKey(id);
    if (key === '00000000000000000000000000000000') return '$empty';
    const alias = Object.entries(side.users).find(([, user]) => idKey(user.id) === key)?.[0];
    assert.ok(alias, 'Each event user is bound to an actual same-runtime HTTP or frozen-input identity.');
    return alias;
  };
  const businessUsers = async () => {
    const target = side.label === 'native' ? reader : database, result = {};
    for (const [alias, identity] of Object.entries(side.users)) {
      const [row] = await target.rows('Users', { where: { Id: nativeGuid(identity.id) } });
      const permissions = await target.rows('Permissions', { where: { UserId: nativeGuid(identity.id) } });
      result[alias] = row ? { Id: row.Id, Username: row.Username, InvalidLoginAttemptCount: row.InvalidLoginAttemptCount,
        LoginAttemptsBeforeLockout: row.LoginAttemptsBeforeLockout, MaxActiveSessions: row.MaxActiveSessions,
        HasPassword: Boolean(row.Password), IsDisabled: permissions.some(value => value.Kind === 2 && value.Value === true) } : null;
    }
    return result;
  };
  const activityProjection = (row, clock) => {
    assert.ok(Number.isSafeInteger(row.Id) && row.Id > 0);
    const instant = Date.parse(dateText(row.DateCreated));
    assert.ok(instant >= clock.started - 1000 && instant <= clock.completed + 1000, 'The actual committed event belongs to this business request.');
    return { Name: row.Name, Type: row.Type, User: aliasFor(row.UserId), ItemId: row.ItemId,
      Overview: row.Overview, ShortOverview: row.ShortOverview, LogSeverity: row.LogSeverity, RowVersion: String(row.RowVersion) };
  };
  const sourceObservation = async target => {
    if (!side || !activeStep) return null;
    const rows = (await allRows()).filter(row => !activeStep.beforeIds.has(row.Id));
    const observation = { runtime: side.label, step: activeStep.name, target: target.key ?? target.path, rows };
    report.sourceReads.push(observation); return observation;
  };
  const activityFrames = client => client.frames.filter(frame => frame.message.MessageType === 'ActivityLogEntry');
  const barrier = async (client, message) => {
    const before = client.frames.filter(frame => frame.message.MessageType === 'KeepAlive').length;
    if (message) client.socket.send(JSON.stringify(message));
    client.socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    await waitFor(() => client.frames.filter(frame => frame.message.MessageType === 'KeepAlive').length > before,
      'The real WebSocket consumer must acknowledge its subscription/keepalive messages.');
  };
  const connect = async identity => {
    const deviceId = 'activity-events-ws-' + identity, token = base[identity].token;
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/socket?' + new URLSearchParams({ ApiKey: token, DeviceId: deviceId }),
      { headers: { Authorization: authorization(token, deviceId), 'Accept-Language': 'en-US' } });
    const client = { runtime: side.label, identity, socket, frames: [], errors: [], snapshots: Promise.resolve() };
    clients.push(client); side.clients.push(client);
    socket.on('message', bytes => {
      const text = bytes.toString('utf8'), message = JSON.parse(text);
      const frame = { body: text, sha256: sha(bytes), message, receivedAt: new Date().toISOString() };
      client.frames.push(frame);
      if (message.MessageType === 'ActivityLogEntry') client.snapshots = client.snapshots.then(async () => {
        frame.committedRows = await allRows();
      }).catch(error => { frame.snapshotError = { name: error.name, message: error.message }; });
      if (message.MessageType === 'ForceKeepAlive' && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    });
    socket.on('error', error => client.errors.push({ name: error.name, code: error.code, message: error.message }));
    await once(socket, 'open', { signal: t.signal });
    await waitFor(() => client.frames.some(frame => frame.message.MessageType === 'ForceKeepAlive'), 'The actual WS host must send its greeting.');
    await barrier(client, { MessageType: 'ActivityLogEntryStart', Data: '0,1000000' });
    return client;
  };
  const closeClients = async () => {
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.CLOSED) {
        const closed = once(client.socket, 'close'); client.socket.close();
        const timer = setTimeout(() => client.socket.terminate(), 10000); timer.unref();
        try { await closed; } finally { clearTimeout(timer); }
      }
      await client.snapshots;
      client.closed = client.socket.readyState === WebSocket.CLOSED;
    }
  };
  const responseProjection = (response, sample) => {
    const headers = Object.fromEntries(['content-type', 'content-disposition', 'content-range']
      .filter(name => response.headers[name] !== undefined).map(name => [name, response.headers[name]]));
    if (response.status === 200 && sample.operation === 'create') return { status: response.status, headers,
      User: aliasFor(response.json.Id), Name: response.json.Name, HasPassword: response.json.HasPassword };
    if (response.status === 200 && sample.operation === 'login') return { status: response.status, headers,
      User: aliasFor(response.json.User.Id), SessionUser: aliasFor(response.json.SessionInfo.UserId),
      Client: response.json.SessionInfo.Client, DeviceId: response.json.SessionInfo.DeviceId,
      DeviceName: response.json.SessionInfo.DeviceName, authenticatedTokenConsumed: true };
    if (response.json !== undefined) {
      const json = projectProblemTrace(structuredClone(response.json), response.status), hasTraceId = Object.hasOwn(json, 'traceId');
      return { status: response.status, headers, hasTraceId, json };
    }
    return { status: response.status, headers, bytes: response.bytes, sha256: response.sha256 };
  };
  const runStep = async sample => {
    const before = await allRows(), beforeIds = new Set(before.map(row => row.Id));
    const offsets = new Map(side.clients.map(client => [client.identity, client.frames.length]));
    const observation = { name: sample.name, before, beforeUsers: await businessUsers(), auxiliary: [] };
    report[side.label].push(observation); activeStep = { name: sample.name, beforeIds };
    const actor = sample.identity === 'anonymous' ? { token: null } : base[sample.identity ?? 'admin'];
    const identity = side.users[sample.user];
    const options = { token: actor.token, method: 'POST' };
    const observe = async (route, options) => observation.response = await request(route, options);
    let failureInjected = false;
    try {
      if (sample.activityFailure) { await setFailure(true); failureInjected = true; }
      let response;
      if (sample.operation === 'create') {
        response = await observe('/Users/New', { ...options, body: { Name: input.users[sample.user],
          ...(sample.password ? { Password: passwords[sample.password] } : {}) } });
        if (response.status === 200) {
          assert.ok(response.json.Id); side.users[sample.user] = { id: response.json.Id, name: response.json.Name };
        }
      } else if (sample.operation === 'password') response = await observe('/Users/' + idKey(identity.id) + '/Password',
        { ...options, body: { NewPw: passwords[sample.password] } });
      else if (sample.operation === 'policy') {
        const currentUser = await request('/Users/' + idKey(identity.id)); observation.auxiliary.push(currentUser);
        assert.equal(currentUser.status, 200);
        response = await observe('/Users/' + idKey(identity.id) + '/Policy', { ...options,
          body: { ...currentUser.json.Policy, ...sample.policy } });
      } else if (sample.operation === 'delete') response = await observe('/Users/' + idKey(identity.id), { ...options, method: 'DELETE' });
      else if (sample.operation === 'download') response = await observe('/Items/' + input.source.itemId + '/Download', { token: actor.token });
      else if (sample.operation === 'login') {
        response = await observe('/Users/AuthenticateByName', { token: null, method: 'POST', deviceId: sample.device,
          body: { Username: sample.username ?? identity.name, Pw: passwords[sample.password] } });
        if (response.status === 200) {
          assert.equal(idKey(response.json.User.Id), idKey(identity.id));
          assert.equal(typeof response.json.AccessToken, 'string');
          const me = await request('/Users/Me', { token: response.json.AccessToken, deviceId: sample.device });
          observation.auxiliary.push(me); assert.equal(me.status, 200); assert.equal(idKey(me.json.Id), idKey(identity.id));
        }
      } else throw new Error('Unknown declared activity operation.');
    } finally {
      try { if (failureInjected) await setFailure(false); }
      finally {
        observation.after = await allRows(); observation.afterUsers = await businessUsers();
        observation.clock = { started: observation.response?.clock.started ?? Date.now(), completed: Date.now() };
        activeStep = undefined;
      }
    }
    const added = observation.after.filter(row => !beforeIds.has(row.Id));
    observation.added = added; observation.scopedAdded = added.filter(row => types.has(row.Type));
    observation.outOfScopeAdded = added.filter(row => !types.has(row.Type));
    observation.functional = { response: responseProjection(observation.response, sample),
      activity: observation.scopedAdded.map(row => activityProjection(row, observation.clock)),
      users: Object.fromEntries(Object.entries(observation.afterUsers).map(([alias, user]) => [alias, user && {
        ...user, Id: aliasFor(user.Id) }])) };
    if (sample.operation === 'download') {
      assert.equal(observation.response.bytes, book.bytes.length); assert.equal(observation.response.sha256, sha(book.bytes));
      const opened = report.sourceReads.filter(entry => entry.runtime === side.label && entry.step === sample.name);
      assert.ok(opened.length, 'The successful download must open its actual source.');
      for (const entry of opened) assert.equal(entry.rows.filter(row => types.has(row.Type)).length, sample.events.length,
        'The declared activity prefix must be committed before the real source opens.');
    }
    for (const client of side.clients.filter(client => client.identity !== 'reader')) {
      if (observation.scopedAdded.length) await waitFor(() => activityFrames(client).some(frame =>
        client.frames.indexOf(frame) >= offsets.get(client.identity) && frame.committedRows
        && observation.scopedAdded.every(row => frame.committedRows.some(committed => committed.Id === row.Id))),
      'A real activity notification must expose its committed business prefix to the subscribed consumer.');
      await barrier(client); await client.snapshots;
    }
    assert.equal(observation.response.status, sample.status, sample.name);
    assert.deepEqual(observation.scopedAdded.map(row => row.Type), sample.events, sample.name + ' persistent activity prefix');
    if (sample.operation === 'create' && sample.status === 200) {
      assert.equal(idKey(observation.afterUsers[sample.user].Id), idKey(side.users[sample.user].id));
      assert.equal(observation.afterUsers[sample.user].Username, input.users[sample.user]);
    }
    if (sample.operation === 'password') assert.equal(observation.afterUsers[sample.user].HasPassword, true);
    if (sample.operation === 'delete') assert.equal(observation.afterUsers[sample.user], null);
    if (sample.name.includes('lockout') && sample.operation === 'login') assert.equal(observation.afterUsers[sample.user].IsDisabled, true);
    observation.completed = true;
  };
  const runPhase = async label => {
    side = { label, clients: [], users: { admin: { id: base.admin.id, name: base.admin.name }, reader: { id: base.reader.id, name: input.users.reader } } };
    report.identitiesByRuntime[label] = side.users;
    report[label + 'InitialRows'] = await allRows();
    for (const identity of ['admin', 'api', 'reader']) await connect(identity);
    for (const sample of input.steps) await runStep(sample);
    await closeClients();
    for (const client of side.clients) {
      const frames = activityFrames(client);
      if (client.identity === 'reader') assert.deepEqual(frames, [], 'An ordinary user cannot subscribe to ActivityLogEntry.');
      else assert.ok(frames.length, 'Actual committed activity must reach an elevated WS subscriber.');
      for (const frame of frames) {
        assert.deepEqual(frame.message.Data, []); assert.equal(typeof frame.message.MessageId, 'string');
        assert.equal(frame.snapshotError, undefined); assert.ok(Array.isArray(frame.committedRows));
      }
    }
    report[label + 'Aliases'] = side.users;
    report[label + 'FinalRows'] = await allRows();
  };
  try {
    current = await currentNativeReference(); base.admin = { id: current.userId, token: secret(current.accessToken) };
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'Jellyfin.Api/Controllers/UserController.cs', 'Jellyfin.Api/Controllers/LibraryController.cs',
      'Jellyfin.Server.Implementations/Users/UserManager.cs', 'Emby.Server.Implementations/Session/SessionManager.cs',
      'Jellyfin.Server.Implementations/Events/EventManager.cs', 'Jellyfin.Server.Implementations/Activity/ActivityManager.cs',
      ...['UserCreatedLogger', 'UserDeletedLogger', 'UserPasswordChangedLogger', 'UserLockedOutLogger']
        .map(name => 'Jellyfin.Server.Implementations/Events/Consumers/Users/' + name + '.cs'),
      ...['AuthenticationSucceededLogger', 'AuthenticationFailedLogger']
        .map(name => 'Jellyfin.Server.Implementations/Events/Consumers/Security/' + name + '.cs'),
      'Jellyfin.Api/WebSocketListeners/ActivityLogWebSocketListener.cs', 'MediaBrowser.Controller/Net/BasePeriodicWebSocketListener.cs',
      'Emby.Server.Implementations/HttpServer/WebSocketConnection.cs',
      'Jellyfin.Server.Implementations/Devices/DeviceManager.cs', 'MediaBrowser.Model/Session/ClientCapabilities.cs',
      'Emby.Server.Implementations/Localization/Core/en-US.json',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ActivityLog.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinDbContext.cs',
    ]);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-events-preparation', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const administrator = await request('/Users/' + idKey(current.userId)); assert.equal(administrator.status, 200);
    base.admin.name = administrator.json.Name;
    const observer = await request('/Users/New', { method: 'POST', body: { Name: input.users.reader, Password: passwords.reader } });
    assert.equal(observer.status, 200); assert.equal(observer.json.Policy.IsAdministrator, false);
    const observerLogin = await request('/Users/AuthenticateByName', { token: null, method: 'POST', deviceId: 'activity-events-reader',
      body: { Username: input.users.reader, Pw: passwords.reader } });
    assert.equal(observerLogin.status, 200); base.reader = { id: observer.json.Id, token: observerLogin.json.AccessToken };
    assert.equal((await request('/Auth/Keys?app=ActivityEventsConsumer', { method: 'POST' })).status, 204);
    const keys = await request('/Auth/Keys'); assert.equal(keys.status, 200);
    const api = keys.json.Items.find(entry => entry.AppName === 'ActivityEventsConsumer'); assert.ok(api?.AccessToken);
    base.api = { token: secret(api.AccessToken) };
    const options = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false, MetadataSavers: [],
      PathInfos: [{ Path: mediaRoot }] };
    assert.equal((await request('/Library/VirtualFolders?name=Activity%20event%20files&collectionType=homevideos&refreshLibrary=false',
      { method: 'POST', body: { LibraryOptions: options } })).status, 204);
    const views = await request('/Library/VirtualFolders'); assert.equal(views.status, 200);
    const folder = views.json.find(entry => entry.Name === 'Activity event files'); assert.ok(folder?.ItemId);
    report.preparation.push(administrator, observer, observerLogin, views);
    await idle(); await stopNative('native-activity-events-preparation');
    await writeFile(book.path, book.bytes, { flag: 'wx' });
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
    try {
      const parent = nativeGuid(folder.ItemId);
      reader.insert('BaseItems', postgresTestRow('BaseItems', { Id: book.Id, Name: book.Name,
        Type: 'MediaBrowser.Controller.Entities.Book', Path: book.path, ParentId: parent, TopParentId: parent,
        MediaType: 'Book', DateCreated: '2026-10-20 12:34:56.1234567', Data: '{}' }));
      reader.insert('AncestorIds', { ItemId: book.Id, ParentItemId: parent });
    } finally { reader.close(); reader = undefined; }
    const baseline = path.join(root, 'baseline.db'); await stoppedDatabase(databaseFilename(instanceRoot));
    await copyFile(databaseFilename(instanceRoot), baseline); report.baselineSha256 = sha(await readFile(baseline));
    proxy = await startDownloadSource({ localFiles: [book], remoteFiles: [], observe: sourceObservation }); report.source = proxy.report;
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-events-matrix', origin });
    await native.ready(); await idle();
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    await runPhase('native'); reader.close(); reader = undefined; await stopNative('native-activity-events-matrix');
    const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const contract = { mounts: [{ mountId: 'activity-events', identityRoot: root, accessRoot: '/activity-events',
      pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'activity-events', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/activity-events', instanceId: 'activity-events', capabilities: {} },
        { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/activity-events', style, caseSensitive,
        returnAccess: 'The isolated activity-producing users, instance and real Download file.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty host ancestors of this isolated fixture.' }],
    }, null, 2) + '\n');
    database = await createPostgresTestDatabase(null, 'activity_events');
    reader = new SqliteDatabase(baseline, { readOnly: true, requireMigrationHistory: true });
    try {
      report.imported = await transferDatabase(reader, database, { instanceBinding: { serverId: current.preparation.nativeServerId,
        originIdentityDigest: report.baselineSha256 }, portableMountContract: contract });
      assert.deepEqual(await databaseDigest(database), await databaseDigest(reader));
    } finally { reader.close(); reader = undefined; }
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') },
      onError: error => report.diagnostics.push({ name: error.name, code: error.code, message: error.message }) });
    // Both configured VFS and plugin adapter methods pass through facades.
    // The adapter's runtime prototype is the actual installed Local read owner.
    const sourceAccessPath = path.posix.join('/activity-events', path.relative(root, book.path).split(path.sep).join('/'));
    const { adapter: sourceAdapter, path: sourcePath } = runtime.playback.vfs.resolve(sourceAccessPath);
    const sourceRoot = sourceAdapter.root, sourcePrototype = Object.getPrototypeOf(sourceAdapter);
    const readDescriptor = Object.getOwnPropertyDescriptor(sourcePrototype, 'openRead'), openRead = readDescriptor.value;
    Object.defineProperty(sourcePrototype, 'openRead', { ...readDescriptor, value: async function (...args) {
      if (this.root === sourceRoot && args[0] === sourcePath) await sourceObservation({ key: book.key, path: args[0] });
      return openRead.apply(this, args);
    } });
    restoreSourceRead = () => Object.defineProperty(sourcePrototype, 'openRead', readDescriptor);
    await idle(); await runPhase('node');
    for (const sample of input.steps) {
      const expected = report.native.find(entry => entry.name === sample.name), actual = report.node.find(entry => entry.name === sample.name);
      try { assert.deepEqual(actual.functional, expected.functional); }
      catch (error) { report.mismatches.push({ name: sample.name, message: error.message }); }
    }
    assert.deepEqual(report.mismatches, []);
    assert.equal(sha(await readFile(baseline)), report.baselineSha256);
  } catch (error) { failure = error; report.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; }
  finally {
    const attempt = async operation => { try { await operation(); } catch (error) {
      failure ??= error; report.cleanup.push({ error: { name: error.name, code: error.code, message: error.message } });
    } };
    activeStep = undefined;
    await attempt(closeNativeFailure); await attempt(closeClients);
    await attempt(() => stopNative('native-finally')); await attempt(() => { reader?.close(); reader = undefined; });
    await attempt(() => { restoreSourceRead?.(); restoreSourceRead = undefined; });
    await attempt(async () => {
      if (!runtime) return;
      const listeners = runtime.networkHost.listeners; await runtime.close(); runtime = undefined;
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      report.cleanup.push({ runtimeClosed: true, portAvailable: true });
    });
    if (!runtime) await attempt(async () => { if (database) { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresSchemaRemoved: true }); } });
    else { safeToRemove = false; await attempt(() => database?.close()); }
    await attempt(async () => { if (proxy) { await proxy.close(); assert.equal(proxy.report.closed, true); proxy = undefined; } });
    await attempt(() => current?.finish());
    report.webSockets = clients.map(({ socket, snapshots, ...client }) => ({ ...client, closed: socket.readyState === WebSocket.CLOSED }));
    report.passed = !failure;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes), sourceBindings: report.sourceBindings,
      actualNativeResponses: report.native.filter(entry => entry.response).length,
      productionNodeResponses: report.node.filter(entry => entry.response).length,
      completeNativeSteps: report.native.filter(entry => entry.completed).length,
      completeNodeSteps: report.node.filter(entry => entry.completed).length, expectedSteps: input.steps.length,
      nativePhaseCompleted: Boolean(report.nativeAliases), nodePhaseCompleted: Boolean(report.nodeAliases),
      unimplementedProducerScopesCompleted: false,
      fullInstanceVerified: false, productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || proxy || reader || nativeFailureDatabase || database && !database.closed
      || clients.some(client => client.socket.readyState !== WebSocket.CLOSED)) safeToRemove = false;
    if (safeToRemove) await attempt(() => output.publishAndClose());
    else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      failure ??= new Error('The activity event HTTP/WS owners did not release their private root.');
    }
  }
  if (failure) throw output.publicError(failure);
}, { signal: t.signal }), { signal: t.signal })));
