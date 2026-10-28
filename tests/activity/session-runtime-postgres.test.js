import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tableDefinition, quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];
const options = { skip: !postgresTestConnectionString, timeout: 90000 };
const itemId = '8ac00100-0000-0000-0000-000000000001';
const types = ['SessionStarted', 'SessionEnded', 'VideoPlayback', 'VideoPlaybackStopped', 'AudioPlayback', 'AudioPlaybackStopped', 'Playback'];
const errorRecord = error => ({ name: error?.name, code: error?.code, status: error?.status,
  message: error?.message, detail: error?.detail });

function itemRow() {
  return { ...Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-10-20 00:00:00'
      : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
        : column.clrType === 'long' ? 0n : 0])),
  Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Stored activity movie',
  CleanName: 'stored activity movie', SortName: 'stored activity movie', Data: '{}', MediaType: 'Video',
  RunTimeTicks: 72000000000n, Path: null, IsFolder: false };
}

/** Actual production runtime, HTTP host, PG writes and independent PG reads. */
async function fixture(t, prefix) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, 'mediamanager-session-activity-'));
  const report = { scope: 'node-session-activity-http-postgres', http: [], observations: [], diagnostics: [], cleanup: {} };
  let database, runtime, observer;
  t.after(async () => {
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    if (runtime) await attempt(async () => { await runtime.close(); report.cleanup.runtimeClosed = true; });
    if (observer) await attempt(async () => { await observer.close(); report.cleanup.observerClosed = true; });
    if (database) await attempt(async () => { await dropPostgresTestDatabase(database); report.cleanup.schemasRemoved = true; });
    if (!runtime || report.cleanup.runtimeClosed) await attempt(async () => {
      assert.equal(path.dirname(root), parent);
      assert.ok(path.basename(root).startsWith('mediamanager-session-activity-'));
      await rm(root, { recursive: true, force: true }); report.cleanup.privateRemoved = true;
    });
    report.cleanup.errors = failures.map(errorRecord);
    t.diagnostic(stringifyNativeJson(report));
    if (failures.length) throw new AggregateError(failures, 'Session activity runtime cleanup failed.', { cause: failures[0] });
  });
  database = await createPostgresTestDatabase(null, prefix);
  runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: '123456781234123412341234567890ab', programDataPath: path.join(root, 'program'),
    configurationDirectoryPath: path.join(root, 'config'), dataPath: path.join(root, 'program', 'data'),
    metadataPath: path.join(root, 'program', 'metadata'), cachePath: path.join(root, 'program', 'cache'),
    onError: error => report.diagnostics.push(errorRecord(error)) });
  runtime.sessions.automaticProgress = false;
  observer = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName, max: 1 });
  await database.insert('BaseItems', itemRow());
  const user = await runtime.users.createUser({ Name: 'SessionActivityReader', Password: 'controlled session activity password' });
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const call = async (route, { token, body, method = body ? 'POST' : 'GET', device = 'session-activity-device' } = {}) => {
    const before = new Date().toISOString();
    const response = await fetch(origin + route, { method, signal: t.signal,
      headers: { Authorization: `MediaBrowser Client="Session activity consumer", Device="Activity runtime device", DeviceId="${device}", Version="1"${token ? `, Token="${token}"` : ''}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: stringifyNativeJson(body) } : {}) });
    const text = await response.text(), after = new Date().toISOString();
    report.http.push({ route, method, device, status: response.status, before, after });
    return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text };
  };
  const logs = async () => (await observer.rows('ActivityLogs')).filter(row => types.includes(row.Type));
  return { database, runtime, observer, report, user, call, logs };
}

const playback = { ItemId: itemId, PositionTicks: 0n, PlayMethod: 'DirectPlay', PlaySessionId: '',
  Item: { Id: wireGuid(itemId), Name: 'Client title', MediaType: 'Video', SeriesName: 'Declared series', Artists: ['Declared artist', 'Second artist'] } };

test('HTTP session and playback callers expose committed activity prefixes to independent PG readers', options, async t => {
  const { runtime, observer, report, user, call, logs } = await fixture(t, 'activity_session_http');
  const login = await call('/Users/AuthenticateByName', { body: { Username: user.Name, Pw: 'controlled session activity password' } });
  assert.equal(login.status, 200);
  const token = login.body.AccessToken, sessionId = login.body.SessionInfo.Id;
  let rows = await logs();
  assert.deepEqual(rows.map(row => row.Type), ['SessionStarted']);
  assert.equal(rows[0].Name, 'SessionActivityReader is online from Activity runtime device');
  assert.equal(rows[0].ShortOverview, 'IP address: 127.0.0.1');
  assert.equal(rows[0].UserId, nativeGuid(user.Id)); assert.equal(rows[0].ItemId, null); assert.equal(rows[0].RowVersion, 0n);
  report.observations.push({ afterLogin: rows });
  assert.equal((await call('/Sessions/Capabilities/Full', { token, body: {} })).status, 204);
  assert.equal((await call('/Sessions', { token })).body.find(session => session.Id === sessionId).UserId, user.Id);
  assert.deepEqual(await logs(), rows, 'Reusing the current session does not create another online activity.');
  assert.equal((await call('/Sessions/Playing', { token, body: playback })).status, 204);
  rows = await logs();
  assert.deepEqual(rows.map(row => row.Type), ['SessionStarted', 'VideoPlayback']);
  assert.equal(rows.at(-1).Name, 'SessionActivityReader is playing Declared artist - Declared series - Client title on Activity runtime device');
  assert.equal(rows.at(-1).ItemId, wireGuid(itemId));
  assert.equal((await call('/Sessions/Playing/Progress', { token, body: { ItemId: itemId, PositionTicks: 6010000000n, IsPaused: true } })).status, 204);
  assert.deepEqual(await logs(), rows, 'Progress keeps its actual session/UserData behavior without adding playback activities.');
  assert.equal((await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } }))[0].PlaybackPositionTicks, 6010000000n);
  assert.equal((await call('/Sessions/Playing/Stopped', { token, body: { ...playback, PositionTicks: 6020000000n } })).status, 204);
  rows = await logs();
  assert.deepEqual(rows.map(row => row.Type), ['SessionStarted', 'VideoPlayback', 'VideoPlaybackStopped']);
  assert.equal(rows.at(-1).Name, 'SessionActivityReader has finished playing Declared artist - Declared series - Client title on Activity runtime device');
  assert.equal(rows.at(-1).UserId, nativeGuid(user.Id)); assert.equal(rows.at(-1).ItemId, wireGuid(itemId));
  assert.equal((await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } }))[0].PlaybackPositionTicks, 6020000000n);
  assert.equal((await call('/Sessions/Logout', { token, method: 'POST' })).status, 204);
  rows = await logs();
  assert.deepEqual(rows.map(row => row.Type), ['SessionStarted', 'VideoPlayback', 'VideoPlaybackStopped', 'SessionEnded']);
  assert.equal(rows.at(-1).Name, 'SessionActivityReader has disconnected from Activity runtime device');
  assert.equal(rows.at(-1).ShortOverview, 'IP address: 127.0.0.1');
  assert.equal(runtime.sessions.countUserSessions(user.Id), 0);
  const beforeClose = await logs(); await runtime.close();
  assert.deepEqual(await logs(), beforeClose, 'Shutdown drains the real owners without inventing a session-ended event.');
  report.observations.push({ afterLogoutAndClose: await logs(), userData: await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } }) });
});

test('real activity insert failures preserve HTTP session events, token state and playback commits', options, async t => {
  const { database, runtime, observer, report, user, call, logs } = await fixture(t, 'activity_session_failure');
  const schema = q(database.schemaName), events = [];
  for (const name of ['SessionStarted', 'SessionEnded', 'PlaybackStart', 'PlaybackStopped']) runtime.sessions.on(name,
    event => events.push({ name, userIds: event.Users?.map(value => wireGuid(value.Id)), itemId: event.Item?.Id,
      sessionId: event.SessionInfo?.Id ?? event.Session?.Id }));
  await database.client.query(`CREATE FUNCTION ${schema}.session_activity_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = 'P7502', MESSAGE = 'Controlled session activity insert rejection',
      DETAIL = convert_from(NEW."Type", 'UTF8'); END $$`);
  let injected = false, token;
  try {
    await database.client.query(`CREATE TRIGGER session_activity_failure BEFORE INSERT ON ${schema}."ActivityLogs"
      FOR EACH ROW WHEN (NEW."Type" IN (${types.map(value => `convert_to('${value}','UTF8')`).join(',')}))
      EXECUTE FUNCTION ${schema}.session_activity_failure()`);
    injected = true;
    const login = await call('/Users/AuthenticateByName', { body: { Username: user.Name, Pw: 'controlled session activity password' } });
    assert.equal(login.status, 200); token = login.body.AccessToken;
    assert.equal(login.body.SessionInfo.UserId, user.Id);
    assert.ok((await observer.rows('Devices', { where: { UserId: nativeGuid(user.Id) } })).some(device => device.AccessToken === token));
    assert.equal((await call('/Sessions/Playing', { token, body: playback })).status, 204);
    assert.equal((await call('/Sessions/Playing/Progress', { token, body: { ItemId: itemId, PositionTicks: 6010000000n, IsPaused: true } })).status, 204);
    let persisted = await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } });
    assert.equal(persisted[0].PlayCount, 1); assert.equal(persisted[0].PlaybackPositionTicks, 6010000000n);
    assert.equal((await call('/Sessions/Playing/Stopped', { token, body: { ...playback, PositionTicks: 6020000000n } })).status, 204);
    persisted = await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } });
    assert.equal(persisted[0].PlayCount, 1); assert.equal(persisted[0].PlaybackPositionTicks, 6020000000n);
    assert.equal((await call('/Sessions/Logout', { token, method: 'POST' })).status, 204);
    assert.deepEqual(await logs(), []);
    assert.equal(runtime.sessions.countUserSessions(user.Id), 0);
    assert.deepEqual(await observer.rows('Devices', { where: { UserId: nativeGuid(user.Id) } }), []);
    assert.deepEqual(events.map(event => event.name), ['SessionStarted', 'PlaybackStart', 'PlaybackStopped', 'SessionEnded']);
    for (const type of ['SessionStarted', 'VideoPlayback', 'VideoPlaybackStopped', 'SessionEnded']) assert.ok(
      report.diagnostics.some(error => error.code === 'P7502' && error.detail === type), type + ' reached the controlled real PG failure.');
    report.observations.push({ failedActivities: await logs(), persisted, actualEvents: [...events] });
  } finally {
    try { if (injected) await database.client.query(`DROP TRIGGER session_activity_failure ON ${schema}."ActivityLogs"`); }
    finally { await database.client.query(`DROP FUNCTION ${schema}.session_activity_failure()`); }
  }
  const recovered = await call('/Users/AuthenticateByName', { body: { Username: user.Name, Pw: 'controlled session activity password' } });
  assert.equal(recovered.status, 200);
  assert.equal((await call('/Sessions/Playing', { token: recovered.body.AccessToken, body: playback })).status, 204);
  assert.deepEqual((await logs()).map(row => row.Type), ['SessionStarted', 'VideoPlayback']);
  assert.equal((await observer.rows('UserData', { where: { UserId: nativeGuid(user.Id), ItemId: itemId } }))[0].PlayCount, 2);
  assert.equal((await call('/Sessions/Logout', { token: recovered.body.AccessToken, method: 'POST' })).status, 204);
  report.observations.push({ restoredActivities: await logs() });
});
