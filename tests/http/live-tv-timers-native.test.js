import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateTicks } from '../../src/library/records.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { createTimerRuntime, databaseFilename, documentSnapshot, guid, idKey, itemIdentity, makeDocuments,
  seedGuide, sha, sqliteSnapshot, timerIdentity, writeDocuments } from './fixtures/live-tv-timers-http/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const inputBytes = await readFile(new URL('./fixtures/live-tv-timers-http/input.json', import.meta.url));
const input = JSON.parse(inputBytes);
const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Saved Live TV timers", Device="Isolated", DeviceId="saved-live-tv-timers", Version="1"${token ? `, Token="${token}"` : ''}`;
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer(); server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const dates = new Set(['StartDate', 'EndDate', 'DateCreated', 'DateLastSaved', 'DateLastRefreshed', 'PremiereDate']);
const wire = response => {
  const project = (value, key) => {
    if (Array.isArray(value)) return value.map(entry => project(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, project(entry, name)]));
    if (key === 'traceId') { assert.ok(typeof value === 'string' && value); return '$trace'; }
    if (dates.has(key) && typeof value === 'string') return { ticks: String(dateTicks(value)), utc: value.endsWith('Z') };
    return value;
  };
  return { status: response.status, contentType: response.contentType,
    body: Object.hasOwn(response, 'bodyJson') ? project(response.bodyJson) : response.bodyText };
};
const guidForms = n => {
  const d = guid(n).toLowerCase(), raw = idKey(n);
  return [raw, d, '{' + d + '}', '(' + d + ')', `{0x${raw.slice(0,8)},0x${raw.slice(8,12)},0x${raw.slice(12,16)},{${raw.slice(16).match(/../gu).map(value => '0x' + value).join(',')}}}`];
};
const mutationMessageTypes = new Set(['TimerCancelled', 'SeriesTimerCancelled']);
const sourceDocument = (snapshot, filename) => JSON.parse(Buffer.from(snapshot[filename].base64, 'base64').toString('utf8'));
const sourceDocuments = snapshot => Object.fromEntries(['timers.json', 'seriestimers.json'].map(filename => [filename,
  Buffer.from(snapshot[filename].base64, 'base64').toString('utf8')]));
const mutationDocumentProjection = snapshot => ({
  timers: sourceDocument(snapshot, 'timers.json').map(value => ({ Id: value.Id ?? null,
    SeriesTimerId: value.SeriesTimerId ?? null, Status: value.Status, IsManual: value.IsManual ?? false })),
  seriesTimers: sourceDocument(snapshot, 'seriestimers.json').map(value => ({ Id: value.Id ?? null })),
});
const mutationEventProjection = messages => messages.filter(message => mutationMessageTypes.has(message.MessageType))
  .map(message => ({ MessageType: message.MessageType, Data: message.Data }));
const mutationEnvelopes = messages => messages.filter(message => mutationMessageTypes.has(message.MessageType));
const stateText = value => value == null ? null : Buffer.from(value, 'hex').toString('utf8');

function assertRequestErrors(observation, label) {
  if (!observation.runtimeErrors) return;
  const { response } = observation;
  // Failure responses are compared in full with Native. Keep their diagnostic
  // errors with that request instead of treating them as later background work.
  if (response.status >= 400 && response.contentType === 'text/plain'
    && response.bodyText === 'Error processing request.') return;
  assert.deepEqual(observation.runtimeErrors, [], `${label}: a successful or binding response must not hide a runtime failure`);
}

function assertMutationEnvelopes(type, connections, expectedCount) {
  const recipients = ['allowed', 'manager'].map(role => mutationEnvelopes(connections[role].messages));
  for (const [index, messages] of recipients.entries()) {
    const role = ['allowed', 'manager'][index];
    assert.equal(messages.length, expectedCount, `${type}: ${role} cancellation envelope count`);
    for (const message of messages) {
      assert.deepEqual(Object.keys(message).toSorted(), ['Data', 'MessageId', 'MessageType']);
      assert.match(message.MessageId, /^[0-9a-f]{32}$/u);
    }
    assert.equal(new Set(messages.map(message => message.MessageId)).size, messages.length,
      `${type}: each cancellation notification has a fresh MessageId`);
  }
  assert.deepEqual(recipients[0].map(message => message.MessageId), recipients[1].map(message => message.MessageId),
    `${type}: one public MessageId is shared by all target sessions for each notification`);
  return Object.fromEntries(Object.entries(connections).map(([role, connection]) => [role,
    mutationEnvelopes(connection.messages)]));
}

function assertNodeTimerAuthority(database, documents) {
  const state = JSON.parse(database.liveTvNativeState);
  for (const [kind, filename] of [['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']]) {
    const bytes = Buffer.from(state[kind].sourceHex, 'hex'), values = JSON.parse(bytes.toString('utf8'));
    assert.equal(state[kind].issue, null);
    assert.equal(sha(bytes), state[kind].sourceSha256);
    assert.equal(state[kind].sourceSha256, documents[filename].sha256);
    assert.equal(bytes.toString('base64'), documents[filename].base64);
    assert.equal(state[kind].rows.length, values.length);
    assert.deepEqual(state[kind].rows.map(row => stateText(row.id)), values.map(value => value.Id ?? null));
    if (kind === 'timers') assert.deepEqual(state[kind].rows.map(row => row.status), values.map(value => value.Status));
  }
}

test('saved timers, series timers and defaults match real native HTTP with fresh first-import PostgreSQL state', {
  skip: !enabled, timeout: 720000,
}, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'live-tv-timers-http-' + randomUUID()));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), referenceRoot = path.join(root, 'reference'), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const clock = Math.floor(Date.now() / 3600000) * 3600000;
  const report = { inputSha256: sha(inputBytes), clock: new Date(clock).toISOString(), stages: [], cases: [], differences: [], cleanup: [] };
  let current, native, fixture, takeoverFixture, failure, liveRootId, guide;
  const nativeCredentials = {};
  const openSockets = new Set();
  const request = async (server, route, { token, body, method = 'GET' } = {}) => {
    const response = await fetch(server + route, { method, signal: AbortSignal.timeout(20000), headers: {
      Authorization: authorization(token), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bodyText = await response.text();
    let bodyJson;
    try { if (bodyText !== '') bodyJson = JSON.parse(bodyText); } catch { /* Keep non-JSON and empty wire bodies distinct. */ }
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText,
      ...(bodyJson === undefined ? {} : { bodyJson }) };
  };
  const nextSocketMessage = async (connection, predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const index = connection.messages.findIndex(predicate);
      if (index >= 0) return connection.messages.splice(index, 1)[0];
      if (connection.errors.length) throw connection.errors[0];
      await delay(10);
    } while (Date.now() < deadline);
    throw new Error(`Missing ${connection.label} WebSocket message.`);
  };
  const connectSocket = async (server, token, label) => {
    const socket = new WebSocket(server.replace(/^http/u, 'ws') + `/socket?ApiKey=${encodeURIComponent(token)}`);
    const connection = { label, socket, messages: [], errors: [] };
    openSockets.add(connection);
    socket.on('message', bytes => {
      try { connection.messages.push(parseLosslessJson(bytes.toString())); }
      catch (error) { connection.errors.push(error); }
    });
    socket.on('error', error => connection.errors.push(error));
    await new Promise((resolve, reject) => {
      const opened = () => { socket.off('error', failed); resolve(); };
      const failed = error => { socket.off('open', opened); reject(error); };
      socket.once('open', opened); socket.once('error', failed);
    });
    connection.handshake = await nextSocketMessage(connection, message => message.MessageType === 'ForceKeepAlive');
    return connection;
  };
  const closeSocket = async connection => {
    if (!openSockets.delete(connection) || connection.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => connection.socket.once('close', () => resolve(true)));
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close();
    const graceful = await Promise.race([closed, delay(2000).then(() => false)]);
    if (!graceful) { connection.socket.terminate(); await closed; }
  };
  const waitForMutationEvents = async (connection, count) => {
    const deadline = Date.now() + 20000;
    while (mutationEventProjection(connection.messages).length < count) {
      if (connection.errors.length) throw connection.errors[0];
      assert.ok(Date.now() < deadline, `Missing ${connection.label} cancellation events.`);
      await delay(10);
    }
  };
  const collect = (name, action) => { try { action(); } catch (error) { report.differences.push({ name, message: error.message }); } };
  const nativeSnapshot = async () => ({ database: sqliteSnapshot(referenceRoot), documents: await documentSnapshot(referenceRoot) });
  const credentials = async (server, administratorToken, label, existing) => {
    const result = {}, password = randomUUID(); output.addSecret(password);
    for (const [role, policy] of [['allowed', { EnableLiveTvAccess: true, EnableLiveTvManagement: false }],
      ['manager', { EnableLiveTvAccess: true, EnableLiveTvManagement: true }],
      ['management', { EnableLiveTvAccess: false, EnableLiveTvManagement: true }],
      ['denied', { EnableLiveTvAccess: false, EnableLiveTvManagement: false }],
      ['admin', { IsAdministrator: true, EnableLiveTvAccess: false, EnableLiveTvManagement: false }]]) {
      const username = `Timers_${label}_${role}_${randomUUID().slice(0,8)}`;
      const created = await request(server, '/Users/New', { token: administratorToken, method: 'POST', body: { Name: username, Password: password } });
      assert.equal(created.status, 200);
      const user = created.bodyJson;
      assert.equal((await request(server, '/Users/' + user.Id + '/Policy', { token: administratorToken, method: 'POST', body: { ...user.Policy, ...policy } })).status, 204);
      const login = await request(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
      assert.equal(login.status, 200); output.addSecret(login.bodyJson.AccessToken); result[role] = login.bodyJson.AccessToken;
    }
    const app = 'Timer fixture ' + randomUUID();
    assert.equal((await request(server, '/Auth/Keys?app=' + encodeURIComponent(app), { token: administratorToken, method: 'POST' })).status, 204);
    const listed = await request(server, '/Auth/Keys', { token: administratorToken }); assert.equal(listed.status, 200);
    result.apiKey = listed.bodyJson.Items.find(item => item.AppName === app).AccessToken; output.addSecret(result.apiKey);
    result.anonymous = undefined; result.invalid = 'invalid-timer-token';
    Object.assign(existing ?? {}, result); return result;
  };
  const routes = populated => {
    const samples = [];
    const add = (name, route, modes = ['allowed', 'apiKey']) => samples.push({ name, route, modes });
    for (const route of ['/LiveTv/Timers', '/LiveTv/SeriesTimers', '/LiveTv/Timers/Defaults']) add('authorization ' + route, route,
      ['anonymous', 'invalid', 'denied', 'allowed', 'admin', 'apiKey']);
    add('ignored unbound timer selectors', '/LiveTv/Timers?userId=not-a-guid&StartIndex=100&Limit=0&SortBy=Name&Fields=Path');
    add('series default name order', '/LiveTv/SeriesTimers');
    for (const query of ['sortBy=Priority', 'sortBy=PRIORITY&sortOrder=Descending', 'sortBy=Name&sortOrder=Descending',
      'sortBy=unknown&sortOrder=42', 'sortBy=Priority&sortOrder=unknown', 'StartIndex=99&Limit=0&userId=bad']) add('series ' + query, '/LiveTv/SeriesTimers?' + query);
    for (const query of ['isActive=true', 'isActive=false', 'isScheduled=true', 'isScheduled=false',
      'isActive=true&isScheduled=true', 'isActive=false&isScheduled=false', 'isActive=not-a-bool', 'isScheduled=not-a-bool',
      'channelId=', 'seriesTimerId=', 'channelId=not-a-guid', 'seriesTimerId=not-a-guid']) add('timer filter ' + query, '/LiveTv/Timers?' + query);
    add('missing timer', '/LiveTv/Timers/' + '0'.repeat(32));
    add('missing series timer', '/LiveTv/SeriesTimers/' + '0'.repeat(32));
    add('malformed timer detail remains a string lookup', '/LiveTv/Timers/not-a-guid');
    add('malformed series detail remains a string lookup', '/LiveTv/SeriesTimers/not-a-guid');
    add('required timer whitespace', '/LiveTv/Timers/%20');
    add('defaults ignored user and fields', '/LiveTv/Timers/Defaults?userId=not-a-guid&Fields=unknown');
    add('defaults malformed program', '/LiveTv/Timers/Defaults?programId=not-a-guid');
    add('defaults missing program', '/LiveTv/Timers/Defaults?programId=' + '0'.repeat(32));
    if (populated) {
      for (const item of input.timers) {
        add('timer detail ' + item.Id, '/LiveTv/Timers/' + timerIdentity(item.Id));
        add('timer detail upper ' + item.Id, '/LiveTv/Timers/' + timerIdentity(item.Id).toUpperCase());
      }
      add('timer D format is not an external identity', '/LiveTv/Timers/' + guid(timerIdentity('new-one')));
      for (const item of input.seriesTimers) add('series detail ' + item.Id, '/LiveTv/SeriesTimers/' + timerIdentity(item.Id));
      for (const value of guidForms(itemIdentity('LiveTvChannel', 'channel-one'))) add('channel GUID form ' + value, '/LiveTv/Timers?channelId=' + encodeURIComponent(value));
      for (const value of guidForms(timerIdentity('series-two'))) add('series GUID form ' + value, '/LiveTv/Timers?seriesTimerId=' + encodeURIComponent(value));
      for (const [index, id] of guide.programIds.entries()) add('program defaults ' + index, '/LiveTv/Timers/Defaults?programId=' + id);
      add('defaults wrong item type', '/LiveTv/Timers/Defaults?programId=' + guide.channelIds[0]);
      add('defaults GUID D form', '/LiveTv/Timers/Defaults?programId=' + guid(guide.programIds[0]));
    }
    return samples;
  };
  const observations = async (type, server, tokens, populated, runtimeErrors) => {
    const values = [];
    for (const sample of routes(populated)) for (const mode of sample.modes) {
      const errorIndex = runtimeErrors?.length ?? 0;
      const response = await request(server, sample.route, { token: tokens[mode] });
      const value = { name: sample.name, mode, request: { method: 'GET', route: sample.route }, response,
        ...(runtimeErrors ? { runtimeErrors: runtimeErrors.slice(errorIndex) } : {}) };
      assertRequestErrors(value, sample.name);
      values.push(value);
      await writeFile(path.join(root, `${type}-${populated ? 'populated' : 'empty'}-progress.log`), filterEvidenceJson(value), { flag: 'a' });
    }
    return values;
  };
  const mutationSamples = {
    rejected: [
      { name: 'anonymous timer cancellation', mode: 'anonymous', route: '/LiveTv/Timers/' + timerIdentity('unlinked'), status: 401 },
      { name: 'invalid timer cancellation', mode: 'invalid', route: '/LiveTv/Timers/' + timerIdentity('unlinked'), status: 401 },
      { name: 'access-only timer cancellation', mode: 'allowed', route: '/LiveTv/Timers/' + timerIdentity('unlinked'), status: 403 },
      { name: 'denied timer cancellation', mode: 'denied', route: '/LiveTv/Timers/' + timerIdentity('unlinked'), status: 403 },
      { name: 'unknown timer cancellation', mode: 'management', route: '/LiveTv/Timers/not-a-guid', status: 404 },
      { name: 'whitespace series cancellation', mode: 'manager', route: '/LiveTv/SeriesTimers/%20', status: 400 },
      { name: 'completed timer cancellation', mode: 'management', route: '/LiveTv/Timers/' + timerIdentity('completed-series'), status: 404 },
      { name: 'missing series cancellation', mode: 'manager', route: '/LiveTv/SeriesTimers/' + '0'.repeat(32), status: 404 },
    ],
    accepted: [
      { name: 'administrator repeats cancelled timer', mode: 'admin', route: '/LiveTv/Timers/' + timerIdentity('cancelled'), status: 204 },
      { name: 'API key repeats cancelled timer', mode: 'apiKey', route: '/LiveTv/Timers/' + timerIdentity('cancelled'), status: 204 },
      { name: 'management-only user cancels unlinked timer', mode: 'management', route: '/LiveTv/Timers/' + timerIdentity('unlinked'),
        status: 204, notifications: 1 },
      { name: 'manager cancels linked timer', mode: 'manager', route: '/LiveTv/Timers/' + timerIdentity('new-one'),
        status: 204, notifications: 1 },
      { name: 'manager cancels series and every child', mode: 'manager',
        route: '/LiveTv/SeriesTimers/' + timerIdentity('series-ten').toUpperCase(), status: 204, notifications: 4 },
    ],
  };
  const expectedMutationEvents = [
    { MessageType: 'TimerCancelled', Data: { Id: 'unlinked' } },
    { MessageType: 'TimerCancelled', Data: { Id: 'new-one' } },
    { MessageType: 'TimerCancelled', Data: { Id: 'active-two' } },
    { MessageType: 'TimerCancelled', Data: { Id: 'error' } },
    { MessageType: 'TimerCancelled', Data: { Id: 'completed-series' } },
    { MessageType: 'SeriesTimerCancelled', Data: { Id: timerIdentity('series-ten').toUpperCase() } },
  ];
  const postMutationRoutes = [
    '/LiveTv/Timers', '/LiveTv/SeriesTimers',
    '/LiveTv/Timers/' + timerIdentity('new-one'), '/LiveTv/Timers/' + timerIdentity('cancelled'),
    '/LiveTv/Timers/' + timerIdentity('unlinked'), '/LiveTv/Timers/' + timerIdentity('active-two'),
    '/LiveTv/Timers/' + timerIdentity('error'), '/LiveTv/Timers/' + timerIdentity('completed-series'),
    '/LiveTv/Timers/' + timerIdentity('cancelled-series'),
    '/LiveTv/SeriesTimers/' + timerIdentity('series-ten'),
  ];
  const expectedPostMutationDocuments = {
    timers: [
      { Id: 'new-one', SeriesTimerId: 'series-two', Status: 'Cancelled', IsManual: true },
      { Id: 'conflicted', SeriesTimerId: null, Status: 'ConflictedOk', IsManual: false },
      { Id: 'cancelled', SeriesTimerId: 'series-two', Status: 'Cancelled', IsManual: true },
      { Id: 'completed', SeriesTimerId: null, Status: 'Completed', IsManual: false },
    ],
    seriesTimers: [{ Id: 'series-two' }, { Id: 'series-zero-two' }, { Id: 'series-empty-days' }],
  };
  const continuationRoutes = [
    '/LiveTv/Timers', '/LiveTv/SeriesTimers',
    '/LiveTv/Timers/' + timerIdentity('new-one'), '/LiveTv/Timers/' + timerIdentity('cancelled'),
    '/LiveTv/Timers/' + timerIdentity('conflicted'), '/LiveTv/Timers/' + timerIdentity('completed'),
    '/LiveTv/SeriesTimers/' + timerIdentity('series-two'),
    '/LiveTv/SeriesTimers/' + timerIdentity('series-zero-two'),
    '/LiveTv/SeriesTimers/' + timerIdentity('series-empty-days'),
  ];
  const nodeExportRoutes = [
    '/LiveTv/Timers', '/LiveTv/SeriesTimers',
    '/LiveTv/SeriesTimers/' + timerIdentity('series-zero-two'),
    '/LiveTv/SeriesTimers/' + timerIdentity('series-two'),
  ];
  const expectedNodeExportDocuments = {
    timers: expectedPostMutationDocuments.timers,
    seriesTimers: [{ Id: 'series-two' }, { Id: 'series-empty-days' }],
  };
  const expectedContinuationDocuments = {
    timers: [
      { Id: 'conflicted', SeriesTimerId: null, Status: 'ConflictedOk', IsManual: false },
      { Id: 'completed', SeriesTimerId: null, Status: 'Completed', IsManual: false },
    ],
    seriesTimers: [{ Id: 'series-empty-days' }],
  };
  const runMutations = async (type, server, tokens, runtimeErrors, capture) => {
    const roles = ['allowed', 'manager', 'management', 'denied', 'admin', 'apiKey'];
    const connections = Object.fromEntries(await Promise.all(roles.map(async role => [role,
      await connectSocket(server, tokens[role], `${type}:${role}`)])));
    const before = await capture(), requests = [];
    const observe = async sample => {
      const errorIndex = runtimeErrors?.length ?? 0;
      const response = await request(server, sample.route, { token: tokens[sample.mode], method: 'DELETE' });
      const observation = { name: sample.name, mode: sample.mode, request: { method: 'DELETE', route: sample.route }, response,
        ...(runtimeErrors ? { runtimeErrors: runtimeErrors.slice(errorIndex) } : {}) };
      assert.equal(response.status, sample.status, `${type}: ${sample.name}`);
      if (sample.status === 204) {
        assert.equal(response.contentType, null); assert.equal(response.bodyText, '');
      }
      assertRequestErrors(observation, `${type}: ${sample.name}`);
      requests.push(observation);
      await writeFile(path.join(root, `${type}-mutations-progress.log`), filterEvidenceJson(observation), { flag: 'a' });
    };
    try {
      for (const sample of mutationSamples.rejected) await observe(sample);
      const afterRejected = await capture();
      assert.deepEqual(afterRejected, before, `${type}: rejected and missing cancellations cannot change durable state`);
      let notificationCount = 0;
      for (const sample of mutationSamples.accepted) {
        await observe(sample); notificationCount += sample.notifications ?? 0;
        if (sample.notifications) await Promise.all(['allowed', 'manager'].map(role => waitForMutationEvents(connections[role], notificationCount)));
      }
      assert.equal(notificationCount, expectedMutationEvents.length);
      await delay(100);
      const events = Object.fromEntries(roles.map(role => [role, mutationEventProjection(connections[role].messages)]));
      assert.deepEqual(events.allowed, expectedMutationEvents, `${type}: LiveTvAccess recipient event order and data`);
      assert.deepEqual(events.manager, expectedMutationEvents, `${type}: management recipient with LiveTvAccess event order and data`);
      for (const role of ['management', 'denied', 'admin', 'apiKey']) {
        assert.deepEqual(events[role], [], `${type}: ${role} without explicit LiveTvAccess cannot receive timer events`);
      }
      for (const connection of Object.values(connections)) {
        assert.deepEqual(connection.errors, []);
        assert.equal(connection.socket.readyState, WebSocket.OPEN,
          `${connection.label} must remain connected through the recipient-visibility observation`);
      }
      const envelopes = assertMutationEnvelopes(type, connections, expectedMutationEvents.length);
      const reads = [];
      for (const route of postMutationRoutes) reads.push({ request: { method: 'GET', route },
        response: await request(server, route, { token: tokens.allowed }) });
      return { before, afterRejected, after: await capture(), requests, reads, events, envelopes,
        handshakes: Object.fromEntries(roles.map(role => [role, connections[role].handshake])) };
    } finally { await Promise.all(Object.values(connections).map(closeSocket)); }
  };
  const runNativeMutationTakeover = async nativeMutation => {
    const takeoverRoot = path.join(root, 'node-native-mutation-takeover'), errors = [], shutdownStates = [];
    takeoverFixture = await createTimerRuntime({ sourceRoot: referenceRoot, root: takeoverRoot,
      serverId: current.preparation.nativeServerId, errors, documents: sourceDocuments(nativeMutation.after.documents),
      shutdownStates, reservedPorts: [port, Number(new URL(fixture.origin).port)] });
    const takeoverPort = Number(new URL(takeoverFixture.origin).port);
    const imported = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(imported.documents, nativeMutation.after.documents,
      'A fresh Node runtime must consume the actual Native-mutated timer files without rewriting them.');
    assertNodeTimerAuthority(imported.database, imported.documents);
    assert.deepEqual(mutationDocumentProjection(imported.documents), expectedPostMutationDocuments);
    assert.deepEqual(errors, [], 'Native-mutated files must initialize a fresh PostgreSQL runtime without background failures.');

    const password = randomUUID(); output.addSecret(password);
    const user = await takeoverFixture.application.users.createUser({ Name: 'TimersTakeover_' + randomUUID(), Password: password });
    await takeoverFixture.application.users.updatePolicy(user.Id, {
      ...(await takeoverFixture.application.users.getUser(user.Id)).Policy,
      IsAdministrator: false, EnableLiveTvAccess: true, EnableLiveTvManagement: true,
    });
    const login = await request(takeoverFixture.origin, '/Users/AuthenticateByName', { method: 'POST',
      body: { Username: user.Name, Pw: password } });
    assert.equal(login.status, 200); output.addSecret(login.bodyJson.AccessToken);
    const beforeReads = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) }, reads = [];
    for (const route of postMutationRoutes) reads.push({ request: { method: 'GET', route },
      response: await request(takeoverFixture.origin, route, { token: login.bodyJson.AccessToken }) });
    assert.equal(reads.length, nativeMutation.reads.length);
    for (const [index, value] of reads.entries()) {
      const expected = nativeMutation.reads[index];
      report.cases.push({ stage: 'native-mutation-fresh-pg', request: value.request,
        native: expected.response, node: value.response });
      collect('native-mutation-fresh-pg: ' + value.request.route, () => {
        assert.deepEqual(value.request, expected.request); assert.deepEqual(wire(value.response), wire(expected.response));
      });
    }
    const afterReads = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(afterReads, beforeReads, 'Fresh-PG reads of Native-mutated state must remain read-only.');
    assert.deepEqual(errors, [], 'Fresh-PG Native takeover reads must not hide background failures.');
    const mutationRoute = '/LiveTv/SeriesTimers/' + timerIdentity('series-zero-two');
    const mutationResponse = await request(takeoverFixture.origin, mutationRoute, {
      token: login.bodyJson.AccessToken, method: 'DELETE',
    });
    assert.equal(mutationResponse.status, 204); assert.equal(mutationResponse.contentType, null);
    assert.equal(mutationResponse.bodyText, '');
    const afterMutation = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(afterMutation.database.tables, afterReads.database.tables,
      'The PG2 cancellation must mutate only PostgreSQL timer authority and its published files.');
    assert.notEqual(afterMutation.database.liveTvNativeState, afterReads.database.liveTvNativeState,
      'PG2 must commit its cancellation to PostgreSQL authority.');
    assert.deepEqual(afterMutation.documents['timers.json'], nativeMutation.after.documents['timers.json']);
    assert.notEqual(afterMutation.documents['seriestimers.json'].sha256,
      nativeMutation.after.documents['seriestimers.json'].sha256,
      'PG2 must publish its series timer deletion before exporting state back to Native.');
    assertNodeTimerAuthority(afterMutation.database, afterMutation.documents);
    assert.deepEqual(mutationDocumentProjection(afterMutation.documents), expectedNodeExportDocuments);
    const mutationReads = [];
    for (const route of nodeExportRoutes) mutationReads.push({ request: { method: 'GET', route },
      response: await request(takeoverFixture.origin, route, { token: login.bodyJson.AccessToken }) });
    const afterMutationReads = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(afterMutationReads, afterMutation, 'PG2 post-mutation reads must remain read-only.');
    assert.deepEqual(errors, [], 'PG2 cancellation and reads must not hide background failures.');
    await takeoverFixture.close(); takeoverFixture = undefined;
    assert.deepEqual(errors, [], 'The normal PG2 close must drain cancellation notifications without failures.');
    assert.equal(await portAvailable(takeoverPort), true, 'The Native-mutation takeover listener must be released.');
    assert.equal(shutdownStates.length, 1);
    assert.deepEqual(shutdownStates[0], afterMutationReads);
    const exportedDocuments = await documentSnapshot(takeoverRoot);
    assert.deepEqual(exportedDocuments, shutdownStates[0].documents,
      'The stopped PG2 runtime must leave its authoritative export on disk.');
    assert.notDeepEqual(exportedDocuments, nativeMutation.after.documents,
      'The normal Node shutdown must export the PG2 cancellation, not its unchanged Native input.');
    report.cleanup.push({ name: 'node-native-mutation-takeover', runtimeClosed: true,
      postgresSchemaDropped: true, listenerPortsReleased: true });
    return { imported, beforeReads, afterReads, reads, errors, shutdownStates,
      mutation: { request: { method: 'DELETE', route: mutationRoute }, response: mutationResponse,
        after: afterMutation, reads: mutationReads, afterReads: afterMutationReads },
      exportedDocuments, port: takeoverPort };
  };
  const runNativeContinuation = async nodeTakeover => {
    await writeDocuments(referenceRoot, sourceDocuments(nodeTakeover.exportedDocuments));
    const restored = await documentSnapshot(referenceRoot);
    assert.deepEqual(restored, nodeTakeover.exportedDocuments,
      'Actual Native must start from the exact timer bytes exported by the closed Node runtime.');
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference-node-export-continuation', origin });
    await native.ready();
    const before = await nativeSnapshot();
    assert.deepEqual(before.documents, nodeTakeover.exportedDocuments);
    assert.deepEqual(mutationDocumentProjection(before.documents), expectedNodeExportDocuments);
    const importedReads = [];
    for (const readRoute of nodeExportRoutes) importedReads.push({ request: { method: 'GET', route: readRoute },
      response: await request(origin, readRoute, { token: nativeCredentials.allowed }) });
    assert.equal(importedReads.length, nodeTakeover.mutation.reads.length);
    for (const [index, value] of importedReads.entries()) {
      const expected = nodeTakeover.mutation.reads[index];
      report.cases.push({ stage: 'node-export-native-continuation', request: value.request,
        native: value.response, node: expected.response });
      collect('node-export-native-continuation: ' + value.request.route, () => {
        assert.deepEqual(value.request, expected.request); assert.deepEqual(wire(value.response), wire(expected.response));
      });
    }
    assert.deepEqual(await nativeSnapshot(), before, 'Native reads of the Node-mutated export must remain read-only.');
    const route = '/LiveTv/SeriesTimers/' + timerIdentity('series-two');
    const response = await request(origin, route, { token: nativeCredentials.manager, method: 'DELETE' });
    assert.equal(response.status, 204); assert.equal(response.contentType, null); assert.equal(response.bodyText, '');
    const after = await nativeSnapshot();
    assert.deepEqual(after.database, before.database,
      'The continued Native cancellation must mutate timer files without changing SQLite business tables.');
    for (const filename of ['timers.json', 'seriestimers.json']) {
      assert.notEqual(after.documents[filename].sha256, before.documents[filename].sha256,
        `Continued Native cancellation must publish ${filename}.`);
    }
    assert.deepEqual(mutationDocumentProjection(after.documents), expectedContinuationDocuments);
    const reads = [];
    for (const readRoute of continuationRoutes) reads.push({ request: { method: 'GET', route: readRoute },
      response: await request(origin, readRoute, { token: nativeCredentials.allowed }) });
    await stopNative('native-node-export-continuation');
    const afterShutdown = await nativeSnapshot();
    assert.deepEqual(afterShutdown, after,
      'A clean Native shutdown must preserve the continuation cancellation output.');
    return { restored, before, importedReads, request: { method: 'DELETE', route }, response, after, reads, afterShutdown };
  };
  const runContinuationTakeover = async nativeContinuation => {
    const takeoverRoot = path.join(root, 'node-native-continuation-takeover'), errors = [], shutdownStates = [];
    takeoverFixture = await createTimerRuntime({ sourceRoot: referenceRoot, root: takeoverRoot,
      serverId: current.preparation.nativeServerId, errors,
      documents: sourceDocuments(nativeContinuation.afterShutdown.documents), shutdownStates,
      reservedPorts: [port, Number(new URL(fixture.origin).port)] });
    const takeoverPort = Number(new URL(takeoverFixture.origin).port);
    const imported = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(imported.documents, nativeContinuation.afterShutdown.documents,
      'A third absent-state PostgreSQL schema must retain the exact continued-Native timer files.');
    assertNodeTimerAuthority(imported.database, imported.documents);
    assert.deepEqual(mutationDocumentProjection(imported.documents), expectedContinuationDocuments);
    assert.deepEqual(errors, [], 'Continued-Native files must initialize a fresh PostgreSQL runtime without background failures.');

    const password = randomUUID(); output.addSecret(password);
    const user = await takeoverFixture.application.users.createUser({
      Name: 'TimersContinuationTakeover_' + randomUUID(), Password: password,
    });
    await takeoverFixture.application.users.updatePolicy(user.Id, {
      ...(await takeoverFixture.application.users.getUser(user.Id)).Policy,
      IsAdministrator: false, EnableLiveTvAccess: true, EnableLiveTvManagement: false,
    });
    const login = await request(takeoverFixture.origin, '/Users/AuthenticateByName', { method: 'POST',
      body: { Username: user.Name, Pw: password } });
    assert.equal(login.status, 200); output.addSecret(login.bodyJson.AccessToken);
    const beforeReads = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) }, reads = [];
    for (const route of continuationRoutes) reads.push({ request: { method: 'GET', route },
      response: await request(takeoverFixture.origin, route, { token: login.bodyJson.AccessToken }) });
    assert.equal(reads.length, nativeContinuation.reads.length);
    for (const [index, value] of reads.entries()) {
      const expected = nativeContinuation.reads[index];
      report.cases.push({ stage: 'continued-native-fresh-pg', request: value.request,
        native: expected.response, node: value.response });
      collect('continued-native-fresh-pg: ' + value.request.route, () => {
        assert.deepEqual(value.request, expected.request); assert.deepEqual(wire(value.response), wire(expected.response));
      });
    }
    const afterReads = { database: await takeoverFixture.snapshot(), documents: await documentSnapshot(takeoverRoot) };
    assert.deepEqual(afterReads, beforeReads, 'Fresh-PG reads of continued-Native state must remain read-only.');
    assert.deepEqual(errors, [], 'Fresh-PG continued-Native reads must not hide background failures.');
    await takeoverFixture.close(); takeoverFixture = undefined;
    assert.deepEqual(errors, [], 'The normal PG3 close must complete without background failures.');
    assert.equal(await portAvailable(takeoverPort), true, 'The continued-Native takeover listener must be released.');
    assert.equal(shutdownStates.length, 1); assert.deepEqual(shutdownStates[0], afterReads);
    report.cleanup.push({ name: 'node-native-continuation-takeover', runtimeClosed: true,
      postgresSchemaDropped: true, listenerPortsReleased: true });
    return { imported, beforeReads, afterReads, reads, errors, shutdownStates, port: takeoverPort };
  };
  const stopNative = async label => {
    if (!native) return;
    const process = await native.stop(async () => (await request(origin, '/System/Shutdown', { token: current.accessToken, method: 'POST' })).status,
      () => portAvailable(port));
    report.cleanup.push({ name: label, ...process }); native = undefined;
    assert.ok(process.cleanShutdown && process.pidGone && process.portAvailable, label);
  };
  try {
    current = await currentNativeReference(); output.addSecret(current.accessToken); report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/LiveTvController.cs',
      'Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs',
      'Jellyfin.Api/Auth/UserPermissionPolicy/UserPermissionHandler.cs',
      'src/Jellyfin.LiveTv/LiveTvManager.cs', 'src/Jellyfin.LiveTv/DefaultLiveTvService.cs',
      'src/Jellyfin.LiveTv/Timers/TimerManager.cs', 'src/Jellyfin.LiveTv/Timers/SeriesTimerManager.cs',
      'src/Jellyfin.LiveTv/LiveTvDtoService.cs', 'src/Jellyfin.LiveTv/Recordings/RecordingNotifier.cs',
      'Emby.Server.Implementations/Dto/DtoService.cs', 'Emby.Server.Implementations/HttpServer/WebSocketConnection.cs',
      'Emby.Server.Implementations/Session/SessionManager.cs', 'Emby.Server.Implementations/Session/WebSocketController.cs',
      'src/Jellyfin.Extensions/Json/JsonDefaults.cs', 'src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs',
      'Jellyfin.Data/UserEntityExtensions.cs',
      'MediaBrowser.Model/LiveTv/BaseTimerInfoDto.cs', 'MediaBrowser.Model/LiveTv/TimerInfoDto.cs', 'MediaBrowser.Model/LiveTv/SeriesTimerInfoDto.cs',
      'MediaBrowser.Controller/LiveTv/TimerInfo.cs', 'MediaBrowser.Controller/LiveTv/SeriesTimerInfo.cs', 'MediaBrowser.Controller/LiveTv/TimerEventInfo.cs',
      'MediaBrowser.Controller/Net/WebSocketMessages/OutboundWebSocketMessage.cs',
      'MediaBrowser.Controller/Net/WebSocketMessages/OutboundWebSocketMessageOfT.cs',
      'MediaBrowser.Controller/Net/WebSocketMessages/Outbound/TimerCancelledMessage.cs',
      'MediaBrowser.Controller/Net/WebSocketMessages/Outbound/SeriesTimerCancelledMessage.cs',
      'MediaBrowser.Controller/LiveTv/LiveTvChannel.cs', 'MediaBrowser.Controller/LiveTv/LiveTvProgram.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true, filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true }); await current.prepareClone(referenceRoot, port);
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><PrePaddingSeconds>-7</PrePaddingSeconds><PostPaddingSeconds>13</PostPaddingSeconds><TunerHosts><TunerHostInfo><Id>controlled</Id><Type>unregistered</Type><Url>controlled://timers</Url></TunerHostInfo></TunerHosts></LiveTvOptions>');
    const emptyDocuments = makeDocuments(input, clock, true);
    await writeDocuments(referenceRoot, emptyDocuments);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference-empty', origin }); await native.ready();
    await credentials(origin, current.accessToken, 'native', nativeCredentials);
    const views = await request(origin, '/UserViews?IncludeHidden=true&UserId=' + idKey(current.userId), { token: nativeCredentials.apiKey }); assert.equal(views.status, 200);
    const view = views.bodyJson.Items.find(item => item.CollectionType === 'livetv'); assert.ok(view);
    liveRootId = idKey(view.Id); report.liveTvView = view;
    const deadline = Date.now() + 30000;
    while (true) {
      const db = new SqliteDatabase(databaseFilename(referenceRoot), { readOnly: true, requireMigrationHistory: true });
      let row;
      try { row = db.rows('BaseItems', { where: { Id: guid(liveRootId) } })[0]; } finally { db.close(); }
      if (row?.DateLastRefreshed && dateTicks(row.DateLastRefreshed) > dateTicks('0001-01-01T00:00:00Z')) { report.liveTvViewCommittedRow = row; break; }
      assert.ok(Date.now() < deadline, 'The native view must commit its initial metadata refresh before read-only evidence starts.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const populated of [false, true]) {
      const stage = { name: populated ? 'populated' : 'empty', nodeShutdownStates: [], nodeErrors: [] };
      report.stages.push(stage);
      const documents = makeDocuments(input, clock, !populated);
      if (populated) {
        guide = await seedGuide(referenceRoot, liveRootId, clock, path.join(root, 'guide-assets')); report.guide = guide;
        await writeDocuments(referenceRoot, documents);
      }
      const nodeRoot = path.join(root, populated ? 'node-populated' : 'node-empty');
      // The native process is stopped for the source SQLite copy used to seed
      // each fresh PG runtime. No PG timer state exists before runtime startup.
      if (!populated) {
        stage.nativeBeforeReads = await nativeSnapshot();
        stage.native = await observations('native', origin, nativeCredentials, false);
        stage.nativeAfterReads = await nativeSnapshot(); assert.deepEqual(stage.nativeAfterReads, stage.nativeBeforeReads);
        await stopNative('native-empty'); stage.nativeAfterShutdown = await nativeSnapshot();
        assert.deepEqual(stage.nativeAfterShutdown, stage.nativeAfterReads);
      }
      fixture = await createTimerRuntime({ sourceRoot: referenceRoot, root: nodeRoot, serverId: current.preparation.nativeServerId,
        errors: stage.nodeErrors, documents, shutdownStates: stage.nodeShutdownStates, reservedPorts: [port] });
      stage.nodePorts = [Number(new URL(fixture.origin).port)];
      const bootstrapPassword = randomUUID(); output.addSecret(bootstrapPassword);
      const bootstrap = await fixture.application.users.createUser({ Name: 'TimersBootstrap_' + randomUUID(), Password: bootstrapPassword });
      await fixture.application.users.updatePolicy(bootstrap.Id, { ...(await fixture.application.users.getUser(bootstrap.Id)).Policy, IsAdministrator: true });
      const bootstrapLogin = await request(fixture.origin, '/Users/AuthenticateByName', { method: 'POST', body: { Username: bootstrap.Name, Pw: bootstrapPassword } });
      assert.equal(bootstrapLogin.status, 200); output.addSecret(bootstrapLogin.bodyJson.AccessToken);
      const nodeCredentials = await credentials(fixture.origin, bootstrapLogin.bodyJson.AccessToken, 'node');
      assert.deepEqual(stage.nodeErrors, [], 'The fresh runtime and preparation must not hide background failures.');
      if (populated) {
        native = current.start({ referenceRoot, outputRoot: root, label: 'reference-populated', origin }); await native.ready();
        stage.nativeBeforeReads = await nativeSnapshot(); stage.native = await observations('native', origin, nativeCredentials, true);
        stage.nativeAfterReads = await nativeSnapshot(); assert.deepEqual(stage.nativeAfterReads, stage.nativeBeforeReads);
      }
      stage.nodeBeforeReads = { database: await fixture.snapshot(), documents: await documentSnapshot(nodeRoot) };
      const nativeSource = stage.nativeBeforeReads.documents;
      assert.deepEqual(stage.nodeBeforeReads.documents, nativeSource, 'Both first readers consume the same original document bytes.');
      const imported = JSON.parse(stage.nodeBeforeReads.database.liveTvNativeState);
      for (const [kind, filename] of [['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']]) {
        assert.equal(imported[kind].issue, null);
        assert.equal(imported[kind].rows.length, populated ? input[kind].length : 0);
        assert.equal(imported[kind].sourceSha256, nativeSource[filename].sha256);
        assert.equal(Buffer.from(imported[kind].sourceHex, 'hex').toString('base64'), nativeSource[filename].base64);
        assert.equal(sha(Buffer.from(imported[kind].sourceHex, 'hex')), imported[kind].sourceSha256);
      }
      stage.node = await observations('node', fixture.origin, nodeCredentials, populated, stage.nodeErrors);
      const requestErrors = stage.node.flatMap(value => value.runtimeErrors);
      stage.nodeAfterReads = { database: await fixture.snapshot(), documents: await documentSnapshot(nodeRoot) };
      assert.deepEqual(stage.nodeAfterReads, stage.nodeBeforeReads);
      assert.deepEqual(stage.nodeErrors, requestErrors, 'Read-only snapshots must not hide background failures.');
      assert.equal(stage.node.length, stage.native.length);
      for (const [index, value] of stage.node.entries()) {
        const expected = stage.native[index]; report.cases.push({ stage: stage.name, name: value.name, mode: value.mode, request: value.request,
          native: expected.response, node: value.response });
        collect(stage.name + ': ' + value.name + ':' + value.mode, () => {
          assert.deepEqual(value.request, expected.request); assert.equal(value.name, expected.name); assert.equal(value.mode, expected.mode);
          assert.deepEqual(wire(value.response), wire(expected.response));
        });
      }
      if (populated) {
        const rows = stage.native.find(item => item.name === 'authorization /LiveTv/Timers' && item.mode === 'allowed').response.bodyJson;
        assert.equal(rows.TotalRecordCount, input.timers.filter(item => item.Status !== 'Completed').length); assert.equal(rows.StartIndex, 0);
        assert.ok(rows.Items.every(item => item.Status !== 'Completed'));
        const newTimer = rows.Items.find(item => item.ExternalId === 'new-one');
        assert.equal(newTimer.Id, timerIdentity('new-one')); assert.equal(newTimer.ChannelId, guide.channelIds[0]);
        assert.equal(newTimer.ProgramInfo.Id, guide.programIds[0]); assert.ok(newTimer.ChannelPrimaryImageTag);
        assert.ok(newTimer.ProgramInfo.ParentThumbImageTag); assert.ok(newTimer.ProgramInfo.ParentPrimaryImageTag);
        const nativeMutation = await runMutations('native', origin, nativeCredentials, undefined, nativeSnapshot);
        await stopNative('native-populated'); stage.nativeAfterShutdown = await nativeSnapshot();
        assert.deepEqual(stage.nativeAfterShutdown, nativeMutation.after);
        stage.nativeMutationTakeover = await runNativeMutationTakeover(nativeMutation);
        stage.nativeContinuation = await runNativeContinuation(stage.nativeMutationTakeover);
        stage.nativeContinuationTakeover = await runContinuationTakeover(stage.nativeContinuation);
        stage.mutations = { native: nativeMutation,
          node: await runMutations('node', fixture.origin, nodeCredentials, stage.nodeErrors,
            async () => ({ database: await fixture.snapshot(), documents: await documentSnapshot(nodeRoot) })) };
        requestErrors.push(...stage.mutations.node.requests.flatMap(value => value.runtimeErrors));
        assert.deepEqual(stage.mutations.native.after.database, stage.mutations.native.before.database,
          'Native timer cancellation only persists its timer documents.');
        assert.deepEqual(stage.mutations.node.after.database.tables, stage.mutations.node.before.database.tables,
          'Node timer cancellation only persists its PostgreSQL control state and timer documents.');
        assertNodeTimerAuthority(stage.mutations.node.after.database, stage.mutations.node.after.documents);
        assert.deepEqual(mutationDocumentProjection(stage.mutations.native.after.documents), expectedPostMutationDocuments);
        assert.deepEqual(mutationDocumentProjection(stage.mutations.node.after.documents), expectedPostMutationDocuments);
        assert.equal(stage.mutations.node.requests.length, stage.mutations.native.requests.length);
        for (const [index, value] of stage.mutations.node.requests.entries()) {
          const expected = stage.mutations.native.requests[index];
          report.cases.push({ stage: 'mutations', name: value.name, mode: value.mode, request: value.request,
            native: expected.response, node: value.response });
          collect('mutations: ' + value.name + ':' + value.mode, () => {
            assert.equal(value.name, expected.name); assert.equal(value.mode, expected.mode);
            assert.deepEqual(value.request, expected.request); assert.deepEqual(wire(value.response), wire(expected.response));
          });
        }
        assert.equal(stage.mutations.node.reads.length, stage.mutations.native.reads.length);
        for (const [index, value] of stage.mutations.node.reads.entries()) {
          const expected = stage.mutations.native.reads[index];
          report.cases.push({ stage: 'post-mutation-read', request: value.request,
            native: expected.response, node: value.response });
          collect('post-mutation-read: ' + value.request.route, () => {
            assert.deepEqual(value.request, expected.request); assert.deepEqual(wire(value.response), wire(expected.response));
          });
        }
        assert.deepEqual(stage.mutations.node.events, stage.mutations.native.events);
        assert.deepEqual(stage.nodeErrors, requestErrors, 'Mutations and WebSocket notification delivery must not hide background failures.');
        const original = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        await writeDocuments(nodeRoot, { 'timers.json': '[]\n', 'seriestimers.json': '[]\n' });
        const warm = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        assert.deepEqual(wire(warm), wire(original)); assert.deepEqual(await fixture.snapshot(), stage.mutations.node.after.database);
        stage.sourceMutation = { original, warm, changedDocuments: await documentSnapshot(nodeRoot), stateUnchanged: true };
        for (const filename of ['timers.json', 'seriestimers.json']) {
          assert.notEqual(stage.sourceMutation.changedDocuments[filename].sha256, stage.nodeBeforeReads.documents[filename].sha256);
          assert.equal(stage.sourceMutation.changedDocuments[filename].base64, Buffer.from('[]\n').toString('base64'));
        }
        await fixture.restart();
        stage.nodePorts.push(Number(new URL(fixture.origin).port));
        const cold = await request(fixture.origin, '/LiveTv/Timers', { token: nodeCredentials.allowed });
        assert.deepEqual(wire(cold), wire(original)); assert.deepEqual(await fixture.snapshot(), stage.mutations.node.after.database);
        stage.sourceMutation.cold = cold; stage.sourceMutation.reconciledDocuments = await documentSnapshot(nodeRoot);
        assert.deepEqual(stage.sourceMutation.reconciledDocuments, stage.mutations.node.after.documents,
          'A restart must reconcile drifted native files from authoritative PostgreSQL source bytes.');
      }
      await fixture.close(); fixture = undefined;
      assert.deepEqual(stage.nodeErrors, requestErrors, 'Source reconciliation and normal runtime close must not hide background failures.');
      for (const port of new Set(stage.nodePorts)) assert.equal(await portAvailable(port), true, 'Every closed Node listener must be released.');
      report.cleanup.push({ name: 'node-' + stage.name, runtimeClosed: true, postgresSchemaDropped: true, listenerPortsReleased: true });
      assert.ok(stage.nodeShutdownStates.length >= 1);
      for (const state of stage.nodeShutdownStates) assert.deepEqual(state.database,
        populated ? stage.mutations.node.after.database : stage.nodeBeforeReads.database);
      if (!populated) assert.deepEqual(stage.nodeShutdownStates[0].documents, stage.nodeBeforeReads.documents);
      else {
        assert.deepEqual(stage.nodeShutdownStates[0].documents, stage.sourceMutation.changedDocuments);
        for (const state of stage.nodeShutdownStates.slice(1)) assert.deepEqual(state.documents, stage.sourceMutation.reconciledDocuments);
      }
    }
    assert.deepEqual(report.differences, []);
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    for (const connection of [...openSockets]) try { await closeSocket(connection); } catch (error) { failure ??= error; }
    if (native) try { await stopNative('native-finally'); } catch (error) { failure ??= error; }
    if (takeoverFixture) try { await takeoverFixture.close(); } catch (error) { failure ??= error; }
    if (fixture) try { await fixture.close(); } catch (error) { failure ??= error; }
    if (current) try { await current.finish(); report.cleanup.push({ name: 'protected-inputs', unchanged: true }); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    report.passed = !failure; report.phaseAcceptance = false; report.releaseAcceptance = false;
    report.boundary = 'Actual designated native HTTP/WebSocket DELETE cancellation, fresh PostgreSQL runtime HTTP/WebSocket cancellation, and a Native-to-PG2-Node-deletion-to-Native-deletion-to-PG3 continuation through exact timer files, clean shutdowns and absent-state PostgreSQL imports. POST create/update recorder boundaries, production CLI import, tuner/listing/recording execution, state-package success after source mutation, pixels and complete Live TV acceptance are outside this fixture.';
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
