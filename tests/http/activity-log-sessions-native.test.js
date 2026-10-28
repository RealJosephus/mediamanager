import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { startProductionInstance } from '../../src/main.js';
import { nativeGuid } from '../../src/users/native.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { databaseFilename, portAvailable, removeSyntheticPreparation, sha, stoppedDatabase,
  unusedPort } from '../helpers/library-exchange-state.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCallback = declareNativeHttpTestFile({ enabled });
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled });
const inputBytes = await readFile(new URL('./fixtures/activity-log-sessions-current/input.json', import.meta.url));
const input = JSON.parse(inputBytes), scopedTypes = new Set(input.activityTypes);
const emptyId = '00000000000000000000000000000000', epochTicks = 621355968000000000n;
const errorRecord = (reason, seen = new Set()) => {
  if (!reason || typeof reason !== 'object') return { type: typeof reason,
    ...(reason === undefined ? {} : { value: typeof reason === 'symbol' ? String(reason) : reason }) };
  if (seen.has(reason)) return { repeatedCause: true };
  seen.add(reason);
  return { name: reason.name, message: reason.message, code: reason.code, stack: reason.stack,
    ...(Object.hasOwn(reason, 'cause') ? { cause: errorRecord(reason.cause, seen) } : {}),
    ...(Array.isArray(reason.errors) ? { errors: reason.errors.map(value => errorRecord(value, seen)) } : {}) };
};
const ordered = values => values.toSorted((left, right) => left.Id < right.Id ? -1 : left.Id > right.Id ? 1 : 0);

test('same-run full Native session and playback loggers match fresh PostgreSQL HTTP, committed prefixes and real WS consumers', {
  skip: !enabled, timeout: 900000,
}, nativeCallback(t => discovery.run(async () => {
  const destination = path.join(validationOutputRoot(), 'activity-log-sessions-' + randomUUID());
  const output = await createPrivateFilterOutput(destination), secrets = new Set();
  const secret = value => {
    if (value) { secrets.add(String(value)); output.addSecret(value); }
    return value;
  };
  secret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), instanceRoot = path.join(root, 'instance'), mediaRoot = path.join(root, 'media');
  await mkdir(mediaRoot);
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const password = secret(randomUUID());
  const report = { inputSha256: sha(inputBytes), preparation: [], native: [], node: [], actions: { native: [], node: [] },
    identitiesByRuntime: {}, triggerControls: [], diagnostics: [], cleanup: [], mismatches: [],
    coveredLoggerTypes: input.activityTypes, fullInstanceVerified: false, productionScaleVerified: false,
    phaseAcceptance: false, releaseAcceptance: false };
  await writeFile(path.join(root, 'neutral-input.log'), inputBytes, { flag: 'wx' });
  let current, native, runtime, database, reader, nativeFailureDatabase, postCloseObserver, side;
  let postgresFailureControl = false;
  let postgresOwnerReleased = false;
  let failed = false, primaryFailure, safeToRemove = true;
  const cleanupFailures = [], clients = [], base = { users: {} };
  const rememberFailure = reason => {
    if (!failed) { failed = true; primaryFailure = reason; }
  };
  const actor = name => side?.actors[name] ?? {
    name, ...input.devices[name], token: name === 'control' || name === 'observer' ? base.admin?.token : base.api?.token,
  };
  const authorization = (identity, token) => `MediaBrowser Client="${input.client}", Device="${identity.name}", DeviceId="${identity.id}", Version="${input.version}"${token ? `, Token="${token}"` : ''}`;
  const request = async (route, options = {}) => {
    const identity = actor(options.actor ?? 'control');
    const token = Object.hasOwn(options, 'token') ? options.token : identity.token;
    if (!options.cleanup) t.signal.throwIfAborted();
    const started = Date.now();
    const response = await fetch(origin + route, { method: options.method ?? 'GET',
      signal: options.cleanup ? AbortSignal.timeout(30000) : AbortSignal.any([t.signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: authorization(identity, token), Accept: 'application/json', 'Accept-Language': 'en-US',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: stringifyNativeJson(options.body) }) });
    const bytes = Buffer.from(await response.arrayBuffer()), bodyText = bytes.toString('utf8');
    const result = { route, method: options.method ?? 'GET', actor: options.actor ?? 'control',
      ...(options.body === undefined ? {} : { requestBody: options.body }), status: response.status,
      headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: sha(bytes), bodyText,
      clock: { started, completed: Date.now() } };
    if (response.headers.get('content-type')?.includes('json') && bytes.length) {
      result.json = parseLosslessJson(bodyText); secret(result.json?.AccessToken);
    }
    return result;
  };
  const waitFor = async (predicate, label) => {
    const deadline = performance.now() + 30000;
    for (;;) {
      const value = predicate(); if (value) return value;
      t.signal.throwIfAborted(); assert.ok(performance.now() < deadline, label);
      await delay(20, undefined, { signal: t.signal });
    }
  };
  const idle = async () => {
    const deadline = performance.now() + 120000;
    for (;;) {
      const response = await request('/ScheduledTasks'); assert.equal(response.status, 200);
      if (response.json.every(task => !['Running', 'Cancelling'].includes(task.State))) return response.json;
      assert.ok(performance.now() < deadline, 'Actual scheduled owners must finish before the session matrix.');
      await delay(100, undefined, { signal: t.signal });
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
  const target = () => side.label === 'native' ? reader : database;
  const allRows = async () => ordered(await target().rows('ActivityLogs'));
  const userAlias = value => {
    if (idKey(value ?? emptyId) === emptyId) return '$empty';
    const entry = Object.entries(base.users).find(([, user]) => idKey(user.id) === idKey(value));
    assert.ok(entry, 'An activity/UserData user must bind to this runtime\'s actual HTTP and SQL user.');
    return entry[0];
  };
  const itemIds = new Set(input.items.map(item => idKey(item.id)));
  const businessRows = async () => {
    const users = new Set(['primary', 'additional'].map(name => idKey(base.users[name].id)));
    const rows = (await target().rows('UserData')).filter(row => users.has(idKey(row.UserId)) && itemIds.has(idKey(row.ItemId)));
    return rows.toSorted((left, right) => {
      const key = row => `${idKey(row.UserId)}\0${idKey(row.ItemId)}\0${row.CustomDataKey}`;
      return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
    });
  };
  const ownedTime = (value, clock, label) => {
    const ticks = dateTicks(value), lower = epochTicks + BigInt(clock.started - 1000) * 10000n;
    const upper = epochTicks + BigInt(clock.completed + 1000) * 10000n;
    assert.ok(ticks >= lower && ticks <= upper, label + ': the generated instant belongs to its real request.');
    return { original: value, ticks: String(ticks), requestBounds: [String(lower), String(upper)] };
  };
  const projectUserData = (rows, before, response, label) => rows.map(row => {
    const key = `${idKey(row.UserId)}\0${idKey(row.ItemId)}\0${row.CustomDataKey}`;
    const previous = before.find(value => idKey(value.UserId) === idKey(row.UserId)
      && idKey(value.ItemId) === idKey(row.ItemId) && value.CustomDataKey === row.CustomDataKey);
    let dateOwner = null;
    if (row.LastPlayedDate != null) {
      const changed = previous?.LastPlayedDate == null || dateTicks(previous.LastPlayedDate) !== dateTicks(row.LastPlayedDate);
      if (changed) { ownedTime(row.LastPlayedDate, response.clock, label + ' LastPlayedDate'); side.dateOwners.set(key, label); }
      dateOwner = side.dateOwners.get(key) ?? '$frozen';
    }
    return { user: userAlias(row.UserId), itemId: idKey(row.ItemId), key: row.CustomDataKey,
      PlayCount: String(row.PlayCount), PlaybackPositionTicks: String(row.PlaybackPositionTicks), Played: row.Played,
      IsFavorite: row.IsFavorite, Rating: row.Rating, AudioStreamIndex: row.AudioStreamIndex,
      SubtitleStreamIndex: row.SubtitleStreamIndex, LastPlayedDateOwner: dateOwner };
  });
  const sessionFor = (sessions, identity) => sessions.find(session => session.DeviceId === identity.id
    && idKey(session.UserId ?? emptyId) === (identity.user ? idKey(base.users[identity.user].id) : emptyId));
  const sessionProjection = session => session ? {
    user: userAlias(session.UserId), UserName: session.UserName ?? null, Client: session.Client,
    DeviceId: session.DeviceId, DeviceName: session.DeviceName,
    additional: session.AdditionalUsers.map(user => ({ user: userAlias(user.UserId), UserName: user.UserName })),
    item: session.NowPlayingItem == null ? null : { Id: idKey(session.NowPlayingItem.Id), Name: session.NowPlayingItem.Name,
      SeriesName: session.NowPlayingItem.SeriesName ?? null, Artists: session.NowPlayingItem.Artists ?? null,
      MediaType: session.NowPlayingItem.MediaType },
    playState: { PositionTicks: session.PlayState?.PositionTicks == null ? null : String(session.PlayState.PositionTicks),
      IsPaused: session.PlayState?.IsPaused, MediaSourceId: session.PlayState?.MediaSourceId ?? null },
  } : null;
  const barrier = async (client, message) => {
    const before = client.frames.filter(frame => frame.message.MessageType === 'KeepAlive').length;
    if (message) client.socket.send(stringifyNativeJson(message));
    client.socket.send(stringifyNativeJson({ MessageType: 'KeepAlive' }));
    await waitFor(() => client.frames.filter(frame => frame.message.MessageType === 'KeepAlive').length > before,
      'The actual socket must acknowledge its real subscription/keepalive messages.');
  };
  const connect = async () => {
    const identity = actor('observer'), socket = new WebSocket(origin.replace('http:', 'ws:') + '/socket?'
      + new URLSearchParams({ ApiKey: identity.token, DeviceId: identity.id }),
    { headers: { Authorization: authorization(identity, identity.token), 'Accept-Language': 'en-US' } });
    const client = { runtime: side.label, socket, frames: [], malformedFrames: [], errors: [], observations: Promise.resolve(), closed: false };
    client.closePromise = new Promise(resolve => socket.once('close', (code, reason) => {
      client.closed = true; client.close = { code, reason: reason.toString('utf8'), at: new Date().toISOString() }; resolve();
    }));
    clients.push(client); side.client = client;
    socket.on('error', error => client.errors.push(errorRecord(error)));
    socket.on('message', bytes => {
      const text = bytes.toString('utf8'), receivedAt = new Date().toISOString();
      let message;
      try { message = parseLosslessJson(text); }
      catch (reason) {
        client.malformedFrames.push({ body: text, sha256: sha(bytes), receivedAt, error: errorRecord(reason) });
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        client.malformedFrames.push({ body: text, sha256: sha(bytes), receivedAt, parsed: message });
        return;
      }
      const frame = { body: text, sha256: sha(bytes), message, receivedAt };
      client.frames.push(frame);
      if (['ActivityLogEntry', 'Sessions'].includes(message.MessageType)) {
        client.observations = client.observations.then(async () => {
          frame.committedRows = await allRows(); frame.userData = await businessRows();
        }).catch(reason => { frame.observationFailure = errorRecord(reason); });
      }
      if (message.MessageType === 'ForceKeepAlive' && socket.readyState === WebSocket.OPEN)
        socket.send(stringifyNativeJson({ MessageType: 'KeepAlive' }));
    });
    await once(socket, 'open', { signal: t.signal });
    await waitFor(() => client.frames.some(frame => frame.message.MessageType === 'ForceKeepAlive'), 'The actual host must send its WS greeting.');
    await barrier(client, { MessageType: 'ActivityLogEntryStart', Data: '0,1000000' });
    await barrier(client, { MessageType: 'SessionsStart', Data: '0,1000000' });
    return client;
  };
  const closeClient = async client => {
    if (client.socket.readyState !== WebSocket.CLOSED) {
      const timer = setTimeout(() => { client.terminatedAfterCloseDeadline = true; client.socket.terminate(); }, 10000);
      timer.unref();
      try { client.socket.close(1000, 'Activity sessions complete'); await client.closePromise; }
      finally { clearTimeout(timer); }
    }
    await client.observations;
    assert.equal(client.socket.readyState, WebSocket.CLOSED);
    assert.equal(client.close.code, 1000, 'The actual WS close handshake must complete.');
  };
  const closeNativeFailure = () => {
    if (!nativeFailureDatabase) return;
    const owner = nativeFailureDatabase;
    const errors = [];
    try { owner.database.exec('DROP TRIGGER IF EXISTS activity_sessions_failure'); } catch (reason) { errors.push(reason); }
    try { owner.close(); nativeFailureDatabase = undefined; } catch (reason) { errors.push(reason); }
    if (errors.length) throw new AggregateError(errors, 'The SQLite activity failure control did not release.', { cause: errors[0] });
    report.triggerControls.push({ runtime: 'native', active: false });
  };
  const setFailure = async enabled => {
    if (side.label === 'native') {
      if (!enabled) return closeNativeFailure();
      const owner = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
      try {
        const values = input.activityTypes.map(value => `'${value.replaceAll("'", "''")}'`).join(',');
        owner.database.exec(`CREATE TRIGGER activity_sessions_failure BEFORE INSERT ON ActivityLogs
          WHEN NEW.Type IN (${values}) BEGIN SELECT RAISE(ABORT, 'Controlled session activity failure'); END`);
        nativeFailureDatabase = owner;
        report.triggerControls.push({ runtime: side.label, active: true,
          definition: owner.database.prepare("SELECT sql FROM sqlite_schema WHERE name='activity_sessions_failure'").get().sql });
      } catch (error) {
        nativeFailureDatabase ??= owner;
        try { closeNativeFailure(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'The SQLite activity failure control could not initialize.', { cause: error }); }
        throw error;
      }
    } else if (enabled) {
      await database.client.query(`CREATE FUNCTION ${q(database.schemaName)}.activity_sessions_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled session activity failure'; END $$`);
      postgresFailureControl = true;
      try {
        const values = input.activityTypes.map(value => `convert_to('${value.replaceAll("'", "''")}','UTF8')`).join(',');
        await database.client.query(`CREATE TRIGGER activity_sessions_failure BEFORE INSERT ON ${q(database.schemaName)}."ActivityLogs"
          FOR EACH ROW WHEN (NEW."Type" IN (${values})) EXECUTE FUNCTION ${q(database.schemaName)}.activity_sessions_failure()`);
      } catch (error) {
        try { await setFailure(false); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'The PostgreSQL activity failure control could not initialize.', { cause: error }); }
        throw error;
      }
      report.triggerControls.push({ runtime: side.label, active: true, types: input.activityTypes,
        definition: (await database.client.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
          WHERE tgname='activity_sessions_failure' AND tgrelid=$1::regclass`, [`${q(database.schemaName)}."ActivityLogs"`])).rows[0].definition });
    } else {
      const errors = [];
      for (const sql of [`DROP TRIGGER IF EXISTS activity_sessions_failure ON ${q(database.schemaName)}."ActivityLogs"`,
        `DROP FUNCTION IF EXISTS ${q(database.schemaName)}.activity_sessions_failure()`]) {
        try { await database.client.query(sql); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'The PostgreSQL activity failure control did not release.');
      postgresFailureControl = false;
    }
    if (!enabled) report.triggerControls.push({ runtime: side.label, active: false });
  };
  const activityProof = async (row, response, label, proofs) => {
    const proof = { rowId: row.Id };
    proofs.push(proof);
    proof.time = ownedTime(row.DateCreated, response.clock, label + ' activity');
    const stamp = dateText(row.DateCreated);
    const route = '/System/ActivityLog/Entries?' + new URLSearchParams({ type: row.Type,
      minDate: stamp, maxDate: stamp, startIndex: '0', limit: '128' });
    proof.request = { route, method: 'GET' };
    const query = await request(route);
    proof.query = query;
    assert.equal(query.status, 200);
    const entry = query.json.Items.find(value => String(value.Id) === String(row.Id));
    assert.ok(entry, 'The same-runtime HTTP reader must expose the actually committed activity row.');
    assert.equal(dateTicks(entry.Date), dateTicks(row.DateCreated), 'HTTP and SQL must retain the same complete 100ns instant.');
    assert.equal(entry.Name, row.Name); assert.equal(entry.Type, row.Type);
    assert.equal(idKey(entry.UserId), idKey(row.UserId));
    assert.equal(entry.ItemId ?? null, row.ItemId ?? null);
    assert.equal(entry.Overview ?? null, row.Overview ?? null); assert.equal(entry.ShortOverview ?? null, row.ShortOverview ?? null);
    let itemBinding;
    if (row.ItemId != null) {
      const [item] = await target().rows('BaseItems', { where: { Id: nativeGuid(row.ItemId) } });
      assert.ok(item, 'A library activity ItemId must bind to its actual same-runtime SQL media item.');
      assert.equal(idKey(item.Id), idKey(row.ItemId)); itemBinding = { Id: item.Id, Name: item.Name, Type: item.Type };
    }
    proof.itemBinding = itemBinding;
    return proof;
  };
  const recordCall = async ({ label, identity = 'primary', route, method = 'POST', body, events = [], status = 204,
    login = false, phase, mediaId, noUserDataMutation = false, expectEnded = false, sessionIdentity = identity }) => {
    const before = await allRows(), beforeUserData = await businessRows(), beforeIds = new Set(before.map(row => String(row.Id)));
    const offset = side.client.frames.length;
    const observation = { label, before, beforeUserData, request: { identity, route, method, body },
      frameOffset: offset, proofs: [], auxiliary: [] };
    report[side.label].push(observation);
    const response = await request(route, { actor: identity, method, ...(login ? { token: null } : {}), ...(body === undefined ? {} : { body }) });
    // This is the first read after the HTTP response. Never poll a missing
    // activity write into an apparently synchronous committed prefix.
    const immediate = await allRows(), afterUserData = await businessRows();
    const added = immediate.filter(row => !beforeIds.has(String(row.Id))), scopedAdded = added.filter(row => scopedTypes.has(row.Type));
    Object.assign(observation, { response, immediate, afterUserData, added, scopedAdded });
    assert.equal(response.status, status, label);
    assert.deepEqual(scopedAdded.map(row => row.Type), events, label + ' immediate committed activity prefix');
    const identityOwner = actor(identity);
    if (login) {
      assert.equal(idKey(response.json.User.Id), idKey(base.users.primary.id));
      identityOwner.token = secret(response.json.AccessToken); identityOwner.sessionId = response.json.SessionInfo.Id;
      identityOwner.additional = Boolean(response.json.SessionInfo.AdditionalUsers?.some(user => idKey(user.UserId) === idKey(base.users.additional.id)));
      const [storedDevice] = await target().rows('Devices', { where: { AccessToken: identityOwner.token } });
      assert.ok(storedDevice); assert.equal(idKey(storedDevice.UserId), idKey(base.users.primary.id));
      assert.equal(storedDevice.DeviceId, identityOwner.id); assert.equal(storedDevice.AppName, input.client);
      assert.equal(response.json.SessionInfo.DeviceId, storedDevice.DeviceId);
      assert.equal(idKey(response.json.SessionInfo.UserId), idKey(storedDevice.UserId));
      const me = await request('/Users/Me', { actor: identity }); observation.auxiliary.push(me);
      assert.equal(me.status, 200); assert.equal(idKey(me.json.Id), idKey(storedDevice.UserId));
      observation.identityBinding = { storedDevice, session: response.json.SessionInfo, me };
    }
    if (noUserDataMutation) assert.deepEqual(afterUserData, beforeUserData, label + ' must retain the existing committed user playback state.');
    if (mediaId && identityOwner.user) {
      for (const name of ['primary', ...(identityOwner.additional ? ['additional'] : [])]) {
        const rows = afterUserData.filter(row => idKey(row.UserId) === idKey(base.users[name].id) && idKey(row.ItemId) === idKey(mediaId));
        assert.ok(rows.length, label + ': actual user playback data must persist.');
        if (phase === 'start') {
          const previous = beforeUserData.filter(row => idKey(row.UserId) === idKey(base.users[name].id) && idKey(row.ItemId) === idKey(mediaId));
          const previousCount = Math.max(0, ...previous.map(row => Number(row.PlayCount)));
          assert.ok(rows.some(row => Number(row.PlayCount) === previousCount + 1), label + ': the actual user-visible play count must advance.');
        }
        const definition = input.items.find(item => idKey(item.id) === idKey(mediaId));
        if (phase !== 'start' && ['video', 'book'].includes(definition.key))
          assert.ok(rows.some(row => String(row.PlaybackPositionTicks) === String(input.positions[phase])), label + ': exact reported position ticks must persist.');
      }
    }
    for (const row of scopedAdded) await activityProof(row, response, label, observation.proofs);
    const sessionOwner = actor(sessionIdentity);
    const listed = await request('/Sessions?deviceId=' + encodeURIComponent(sessionOwner.id)); observation.auxiliary.push(listed);
    assert.equal(listed.status, 200);
    const session = sessionFor(listed.json, sessionOwner);
    if (expectEnded) {
      assert.equal(session, undefined);
      assert.ok(listed.json.every(value => value.DeviceId !== identityOwner.id), 'Real logout must end every session on the actual device.');
      assert.deepEqual(await target().rows('Devices', { where: { AccessToken: identityOwner.token } }), []);
      const invalidated = await request('/Users/Me', { actor: identity }); observation.auxiliary.push(invalidated);
      assert.equal(invalidated.status, 401);
    } else {
      assert.ok(session); sessionOwner.sessionId = session.Id;
      assert.equal(session.Client, sessionOwner.client ?? input.client); assert.equal(session.DeviceId, sessionOwner.id);
      if (phase === 'stop') {
        assert.ok(session.NowPlayingItem == null); assert.ok(session.PlayState?.MediaSourceId == null);
      } else if (phase) {
        assert.equal(session.NowPlayingItem?.Name ?? null, body.Item?.Name ?? null);
        assert.equal(String(session.PlayState.PositionTicks), String(body.PositionTicks)); assert.equal(session.PlayState.IsPaused, true);
      }
    }
    if (scopedAdded.length) {
      observation.activityFrame = await waitFor(() => side.client.frames.slice(offset).find(frame => frame.message.MessageType === 'ActivityLogEntry'
        && frame.committedRows && scopedAdded.every(row => frame.committedRows.some(value => String(value.Id) === String(row.Id)))),
      label + ': a real activity notification must observe the committed business prefix.');
      assert.deepEqual(observation.activityFrame.message.Data, []);
    }
    if (phase || login || expectEnded) {
      observation.sessionFrame = await waitFor(() => side.client.frames.slice(offset).find(frame => {
        if (frame.message.MessageType !== 'Sessions' || !Array.isArray(frame.message.Data)
          || !frame.committedRows || !Array.isArray(frame.userData)) return false;
        const value = sessionFor(frame.message.Data, identityOwner);
        // Native SessionEnded queues its session event before Publish. Start
        // and playback queue theirs only after the logger has been awaited.
        if (!expectEnded && !scopedAdded.every(row => frame.committedRows.some(committed => String(committed.Id) === String(row.Id)))) return false;
        if (expectEnded) return value == null;
        if (!value) return false;
        if (phase === 'stop') return value.NowPlayingItem == null && value.PlayState?.MediaSourceId == null;
        if (phase) return (value.NowPlayingItem?.Name ?? null) === (body.Item?.Name ?? null)
          && String(value.PlayState?.PositionTicks) === String(body.PositionTicks) && value.PlayState?.IsPaused === true;
        return idKey(value.UserId) === idKey(base.users.primary.id);
      }), label + ': the real Sessions consumer must receive the actual committed session/playback state.');
      if (!expectEnded) assert.equal(sessionFor(observation.sessionFrame.message.Data, identityOwner).Client,
        identityOwner.client ?? input.client, 'The Sessions event retains the actual authenticated client identity.');
      if (phase) assert.deepEqual(observation.sessionFrame.userData, afterUserData,
        'Playback publication must expose the already committed user playback prefix.');
    }
    await barrier(side.client); await side.client.observations;
    observation.functional = { status: response.status,
      activity: scopedAdded.map(row => ({ Name: row.Name, Type: row.Type, user: userAlias(row.UserId), ItemId: row.ItemId ?? null,
        Overview: row.Overview ?? null, ShortOverview: row.ShortOverview ?? null, LogSeverity: row.LogSeverity,
        RowVersion: String(row.RowVersion) })),
      producerOrder: added.filter(row => scopedTypes.has(row.Type) || row.Type === 'AuthenticationSucceeded').map(row => row.Type),
      userData: projectUserData(afterUserData, beforeUserData, response, label), session: sessionProjection(session) };
    observation.completed = true;
    return observation;
  };
  const login = async (label, events, identity = 'primary') => {
    const previousToken = actor(identity).token;
    const observation = await recordCall({ label, identity, route: '/Users/AuthenticateByName', status: 200, login: true, events,
      body: { Username: input.users.primary, Pw: password } });
    if (previousToken) {
      const old = await request('/Users/Me', { actor: identity, token: previousToken });
      observation.auxiliary.push(old); assert.equal(old.status, 401);
    }
    return observation;
  };
  const reuseSession = (label, identity = 'primary', events = []) => recordCall({ label, identity,
    route: '/Sessions/Capabilities/Full', body: { PlayableMediaTypes: [], SupportedCommands: [],
      SupportsMediaControl: false, SupportsPersistentIdentifier: true }, events, noUserDataMutation: true });
  const cycle = async (sample, identity = 'primary', suffix = '') => {
    const definition = input.items.find(item => item.key === sample.item);
    const infoKey = Object.hasOwn(sample, 'mediaInfo') ? sample.mediaInfo : sample.item;
    const supplied = infoKey == null ? null : { ...input.mediaInfo[infoKey],
      Id: definition?.id ?? input.externalMediaId, RunTimeTicks: definition?.runtimeTicks ?? 6000000000 };
    for (const [phase, routeSuffix] of [['start', ''], ['progress', '/Progress'], ['stop', '/Stopped']]) {
      const body = { ItemId: definition?.id ?? emptyId, MediaSourceId: definition?.id ?? emptyId,
        PositionTicks: input.positions[phase], IsPaused: true, CanSeek: true, PlayMethod: 'DirectPlay',
        ...(supplied === null ? {} : { Item: structuredClone(supplied) }) };
      await recordCall({ label: sample.name + suffix + '/' + phase, identity, route: '/Sessions/Playing' + routeSuffix,
        body, events: sample.events[phase], phase, mediaId: definition?.id,
        noUserDataMutation: !definition || identity === 'api' });
    }
  };
  const runPhase = async label => {
    side = { label, dateOwners: new Map(), actors: {
      control: { ...input.devices.control, token: base.admin.token, user: 'control' },
      observer: { ...input.devices.observer, token: base.admin.token, user: 'control' },
      primary: { ...input.devices.primary, token: null, user: 'primary' },
      failure: { ...input.devices.failure, token: null, user: 'primary' },
      api: { ...input.devices.api, token: base.api.token, user: null },
    } };
    const bindings = {};
    for (const [name, identity] of Object.entries(base.users)) {
      const [stored] = await target().rows('Users', { where: { Id: nativeGuid(identity.id) }, columns: ['Id', 'Username'] });
      assert.ok(stored); assert.equal(stored.Username, identity.name); bindings[name] = stored;
    }
    const [apiKey] = await target().rows('ApiKeys', { where: { AccessToken: base.api.token } });
    assert.ok(apiKey); assert.equal(apiKey.Name, input.apiKeyName);
    // API-key authorization uses its stored application name even when the
    // real request supplies a different Client header.
    side.actors.api.client = apiKey.Name;
    const control = await request('/Sessions/Capabilities/Full', { method: 'POST', body: {
      PlayableMediaTypes: [], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true,
    } });
    assert.equal(control.status, 204); report.preparation.push({ runtime: label, controlSession: control });
    await connect(); report[label + 'InitialRows'] = await allRows();
    report.identitiesByRuntime[label] = { users: base.users, sqlUsers: bindings, apiKey, actors: side.actors };
    for (const sample of input.steps) {
      const action = { name: sample.name, firstHttpIndex: report[label].length };
      report.actions[label].push(action);
      let injection = false, actionFailed = false, actionFailure;
      try {
        if (sample.activityFailure) { await setFailure(true); injection = true; }
        if (sample.operation === 'login') await login(sample.name, sample.events);
        else if (sample.operation === 'reuse') await reuseSession(sample.name, 'primary', sample.events);
        else if (sample.operation === 'additional') {
          const attached = await recordCall({ label: sample.name, identity: 'control', sessionIdentity: 'primary',
            route: `/Sessions/${encodeURIComponent(actor('primary').sessionId)}/User/${idKey(base.users.additional.id)}`, events: sample.events,
            noUserDataMutation: true });
          assert.deepEqual(attached.functional.session.additional, [{ user: 'additional', UserName: input.users.additional }]);
          actor('primary').additional = true;
        } else if (sample.operation === 'cycle') await cycle(sample);
        else if (sample.operation === 'api-cycles') {
          await cycle(sample, 'api', '/without-additional');
          const attached = await recordCall({ label: sample.name + '/attach-additional', identity: 'control', sessionIdentity: 'api',
            route: `/Sessions/${encodeURIComponent(actor('api').sessionId)}/User/${idKey(base.users.additional.id)}`,
            noUserDataMutation: true });
          assert.deepEqual(attached.functional.session.additional, [{ user: 'additional', UserName: input.users.additional }]);
          actor('api').additional = true;
          await cycle(sample, 'api', '/with-additional');
        } else if (sample.operation === 'failed-session') {
          await login(sample.name + '/login', [], 'failure');
          await reuseSession(sample.name + '/reuse', 'failure');
          await recordCall({ label: sample.name + '/logout', identity: 'failure', route: '/Sessions/Logout', expectEnded: true, noUserDataMutation: true });
        } else if (sample.operation === 'logout') await recordCall({ label: sample.name, route: '/Sessions/Logout', events: sample.events,
          expectEnded: true, noUserDataMutation: true });
        else throw new Error('Unknown declared session activity operation.');
      } catch (reason) { actionFailed = true; actionFailure = reason;
      } finally {
        if (injection) try { await setFailure(false); }
        catch (reason) {
          actionFailure = actionFailed ? new AggregateError([actionFailure, reason], 'Session activity action and failure-control cleanup failed.', { cause: actionFailure }) : reason;
          actionFailed = true;
        }
        action.actualHttpCalls = report[label].length - action.firstHttpIndex;
      }
      if (actionFailed) throw actionFailure;
      action.completed = true;
    }
    await closeClient(side.client); report[label + 'FinalRows'] = await allRows();
  };
  const observeAfterRuntimeClose = async () => {
    postCloseObserver = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema: database.schemaName, max: 1 });
    let observerFailed = false, observerFailure;
    try {
      report.nodeAfterRuntimeCloseRows = await postCloseObserver.rows('ActivityLogs');
      for (const observation of report.node) for (const row of observation.scopedAdded ?? []) {
        assert.deepEqual(report.nodeAfterRuntimeCloseRows.find(value => String(value.Id) === String(row.Id)), row,
          'An independent connection after real runtime close must retain the exact committed activity prefix.');
      }
    } catch (reason) { observerFailed = true; observerFailure = reason; }
    try {
      await postCloseObserver.close(); postCloseObserver = undefined;
      report.cleanup.push({ independentPostCloseObserverClosed: true });
    } catch (reason) {
      observerFailure = observerFailed ? new AggregateError([observerFailure, reason], 'Post-close readback and observer close failed.', { cause: observerFailure }) : reason;
      observerFailed = true;
    }
    if (observerFailed) throw observerFailure;
  };
  try {
    current = await currentNativeReference(); base.admin = { token: secret(current.accessToken), id: current.userId };
    base.users.control = { id: current.userId };
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings([
      'Emby.Server.Implementations/Session/SessionManager.cs', 'Jellyfin.Server.Implementations/Events/EventManager.cs',
      ...['SessionStartedLogger', 'SessionEndedLogger', 'PlaybackStartLogger', 'PlaybackStopLogger']
        .map(name => 'Jellyfin.Server.Implementations/Events/Consumers/Session/' + name + '.cs'),
      'Jellyfin.Api/Controllers/SessionController.cs', 'Jellyfin.Api/Controllers/PlaystateController.cs',
      'Jellyfin.Api/Controllers/ActivityLogController.cs',
      'Jellyfin.Server.Implementations/Security/AuthorizationContext.cs',
      'Jellyfin.Api/Helpers/RequestHelpers.cs', 'MediaBrowser.Controller/Session/SessionInfo.cs',
      'MediaBrowser.Model/Dto/BaseItemDto.cs', 'Jellyfin.Data/Enums/MediaType.cs', 'MediaBrowser.Model/Entities/ExtraType.cs',
      'Emby.Server.Implementations/Library/UserDataManager.cs', 'MediaBrowser.Controller/Entities/BaseItem.cs',
      'Jellyfin.Server.Implementations/Activity/ActivityManager.cs', 'Jellyfin.Api/WebSocketListeners/ActivityLogWebSocketListener.cs',
      'src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ActivityLog.cs',
      'Jellyfin.Api/WebSocketListeners/SessionInfoWebSocketListener.cs', 'MediaBrowser.Controller/Net/BasePeriodicWebSocketListener.cs',
      'Emby.Server.Implementations/Localization/Core/en-US.json',
    ]);
    await cp(current.sourceRoot, instanceRoot, { recursive: true, force: false, errorOnExist: true });
    await current.prepareClone(instanceRoot, port); report.syntheticPreparation = removeSyntheticPreparation(instanceRoot);
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-sessions-preparation', origin });
    await native.ready();
    for (const task of await idle()) assert.equal((await request('/ScheduledTasks/' + task.Id + '/Triggers', { method: 'POST', body: [] })).status, 204);
    const administrator = await request('/Users/' + idKey(current.userId)); assert.equal(administrator.status, 200);
    base.users.control.name = administrator.json.Name;
    for (const name of ['primary', 'additional']) {
      const created = await request('/Users/New', { method: 'POST', body: { Name: input.users[name], Password: password } });
      assert.equal(created.status, 200); base.users[name] = { id: created.json.Id, name: created.json.Name };
      report.preparation.push(created);
    }
    assert.equal((await request('/Auth/Keys?app=' + encodeURIComponent(input.apiKeyName), { method: 'POST' })).status, 204);
    const keys = await request('/Auth/Keys'); assert.equal(keys.status, 200);
    const key = keys.json.Items.find(value => value.AppName === input.apiKeyName); assert.ok(key);
    base.api = { token: secret(key.AccessToken) };
    const options = { Enabled: true, EnableRealtimeMonitor: false, EnableInternetProviders: false, MetadataSavers: [], PathInfos: [{ Path: mediaRoot }] };
    assert.equal((await request('/Library/VirtualFolders?name=Activity%20session%20media&collectionType=homevideos&refreshLibrary=false',
      { method: 'POST', body: { LibraryOptions: options } })).status, 204);
    const folders = await request('/Library/VirtualFolders'); assert.equal(folders.status, 200);
    const folder = folders.json.find(value => value.Name === 'Activity session media'); assert.ok(folder?.ItemId);
    report.preparation.push(administrator, keys, folders);
    await idle(); await stopNative('native-activity-sessions-preparation');
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { requireMigrationHistory: true });
    try {
      const parent = nativeGuid(folder.ItemId);
      for (const item of input.items) {
        reader.insert('BaseItems', postgresTestRow('BaseItems', { Id: nativeGuid(item.id), Name: item.name,
          Type: item.kind === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
            : item.kind === 'Audio' ? 'MediaBrowser.Controller.Entities.Audio.Audio' : 'MediaBrowser.Controller.Entities.' + item.kind,
          MediaType: item.mediaType, Path: path.join(mediaRoot, item.filename), ParentId: parent, TopParentId: parent,
          IsFolder: false, IsVirtualItem: false, RunTimeTicks: BigInt(item.runtimeTicks), ExtraType: item.extraType ?? null,
          DateCreated: '2026-10-20 12:34:56.1234567',
          Data: item.kind === 'Audio' ? '{"Artists":[],"AlbumArtists":[],"Genres":[]}' : '{}' }));
        reader.insert('AncestorIds', { ItemId: nativeGuid(item.id), ParentItemId: parent });
      }
      report.preparedMedia = reader.rows('BaseItems', { whereIn: { Id: input.items.map(item => nativeGuid(item.id)) } });
      report.preparedUsers = reader.rows('Users', { whereIn: { Id: Object.values(base.users).map(user => nativeGuid(user.id)) }, columns: ['Id', 'Username'] });
    } finally { reader.close(); reader = undefined; }
    const baseline = path.join(root, 'baseline.db'); await stoppedDatabase(databaseFilename(instanceRoot));
    await copyFile(databaseFilename(instanceRoot), baseline); report.baselineSha256 = sha(await readFile(baseline));
    native = current.start({ referenceRoot: instanceRoot, outputRoot: root, label: 'native-activity-sessions-matrix', origin });
    await native.ready(); await idle();
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    await runPhase('native'); reader.close(); reader = undefined; await stopNative('native-activity-sessions-matrix');
    reader = new SqliteDatabase(databaseFilename(instanceRoot), { readOnly: true, requireMigrationHistory: true });
    try { report.nativeAfterHostStopRows = reader.rows('ActivityLogs'); }
    finally { reader.close(); reader = undefined; }
    const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
    const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
    const contract = { mounts: [{ mountId: 'activity-sessions', identityRoot: root, accessRoot: '/activity-sessions', pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
    await writeFile(path.join(root, 'storage.json'), JSON.stringify({
      instances: [{ id: 'activity-sessions', type: 'local', config: { root, writable: true } },
        { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
      mounts: [{ path: '/activity-sessions', instanceId: 'activity-sessions', capabilities: {} },
        { path: '/empty-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
      prefixes: [{ identityRoot: root, accessRoot: '/activity-sessions', style, caseSensitive,
        returnAccess: 'The actual private session media, instance and metadata identities.' }],
      ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
        returnAccess: 'Declared empty host ancestors of the private fixture.' }],
    }, null, 2) + '\n');
    database = await createPostgresTestDatabase(null, 'activity_sessions');
    reader = new SqliteDatabase(baseline, { readOnly: true, requireMigrationHistory: true });
    try {
      report.imported = await transferDatabase(reader, database, { instanceBinding: { serverId: current.preparation.nativeServerId,
        originIdentityDigest: report.baselineSha256 }, portableMountContract: contract });
      assert.deepEqual(await databaseDigest(database), await databaseDigest(reader));
    } finally { reader.close(); reader = undefined; }
    runtime = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instanceRoot,
      MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName,
      MEDIAMANAGER_STORAGE: path.join(root, 'storage.json') }, onError: reason => report.diagnostics.push(errorRecord(reason)) });
    await idle(); await runPhase('node');
    for (let index = 0; index < report.native.length; index++) {
      const expected = report.native[index], actual = report.node[index];
      try { assert.equal(actual?.label, expected.label); assert.deepEqual(actual.functional, expected.functional); }
      catch (error) { report.mismatches.push({ label: expected.label, error: errorRecord(error) }); }
    }
    assert.deepEqual(report.node.map(value => value.label), report.native.map(value => value.label));
    assert.deepEqual(report.mismatches, []);
    assert.deepEqual(report.actions.native.filter(action => action.completed).map(action => action.name), input.steps.map(step => step.name));
    assert.deepEqual(report.actions.node.filter(action => action.completed).map(action => action.name), input.steps.map(step => step.name));
    assert.equal(sha(await readFile(baseline)), report.baselineSha256);
    report.declaredSessionLoggerMatrixCompleted = true;
  } catch (reason) { rememberFailure(reason); report.failure = errorRecord(reason); }
  finally {
    const attempt = async operation => { try { await operation(); } catch (reason) {
      cleanupFailures.push(reason); report.cleanup.push({ error: errorRecord(reason) });
    } };
    await attempt(closeNativeFailure);
    if (postgresFailureControl) await attempt(() => setFailure(false));
    for (const client of clients) await attempt(() => closeClient(client));
    await attempt(() => stopNative('native-finally'));
    await attempt(() => { reader?.close(); reader = undefined; });
    await attempt(async () => {
      if (!runtime) return;
      const listeners = runtime.networkHost.listeners;
      await runtime.close(); runtime = undefined;
      assert.ok(listeners.every(listener => !listener.server.listening)); assert.equal(await portAvailable(port), true);
      await observeAfterRuntimeClose();
      report.cleanup.push({ runtimeClosed: true, portAvailable: true });
    });
    if (postCloseObserver) await attempt(async () => {
      await postCloseObserver.close(); postCloseObserver = undefined;
      report.cleanup.push({ independentPostCloseObserverClosed: true });
    });
    await attempt(async () => {
      if (!database) return;
      if (!runtime && !postCloseObserver) {
        await dropPostgresTestDatabase(database); postgresOwnerReleased = true;
        report.cleanup.push({ postgresSchemaRemoved: true, postgresOwnerReleased: true });
      } else {
        safeToRemove = false; await database.close(); postgresOwnerReleased = true;
      }
    });
    await attempt(() => current?.finish());
    report.webSockets = clients.map(({ socket, observations, closePromise, ...client }) => ({ ...client, closed: socket.readyState === WebSocket.CLOSED }));
    if (cleanupFailures.length) {
      if (failed) primaryFailure = new AggregateError([primaryFailure, ...cleanupFailures], 'Session activity execution and cleanup failed.', { cause: primaryFailure });
      else { rememberFailure(new AggregateError(cleanupFailures, 'Session activity owners failed to close.', { cause: cleanupFailures[0] })); }
    }
    report.passed = !failed;
    if (failed) report.finalFailure = errorRecord(primaryFailure);
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report, secrets));
    await writeFile(path.join(root, 'provenance.json'), filterEvidenceJson({ inputSha256: sha(inputBytes),
      originalInput: 'neutral-input.log', sourceBindings: report.sourceBindings,
      expectedDeclaredActions: input.steps.length,
      nativeCompletedActions: report.actions.native.filter(action => action.completed).length,
      nodeCompletedActions: report.actions.node.filter(action => action.completed).length,
      attemptedNativeBusinessHttpCalls: report.native.length, attemptedNodeBusinessHttpCalls: report.node.length,
      actualNativeBusinessHttpResponses: report.native.filter(call => call.response).length,
      actualNodeBusinessHttpResponses: report.node.filter(call => call.response).length,
      completeNativeBusinessHttpCalls: report.native.filter(call => call.completed).length,
      completeNodeBusinessHttpCalls: report.node.filter(call => call.completed).length,
      declaredSessionLoggerMatrixCompleted: report.declaredSessionLoggerMatrixCompleted === true && !failed,
      fullInstanceVerified: false, productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false }, secrets));
    if (native || runtime || reader || nativeFailureDatabase || postCloseObserver || database && !postgresOwnerReleased
      || clients.some(client => client.socket.readyState !== WebSocket.CLOSED)) safeToRemove = false;
    if (safeToRemove) {
      try {
        await output.publishAndClose();
        assert.deepEqual(await readFile(path.join(destination, 'neutral-input.log')), inputBytes, 'Published neutral input bytes must remain original.');
      } catch (reason) {
        if (failed) primaryFailure = new AggregateError([primaryFailure, reason], 'Session activity evidence publication failed.', { cause: primaryFailure });
        else rememberFailure(reason);
      }
    } else {
      await mkdir(destination); await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }, secrets));
      if (!failed) rememberFailure(new Error('The session activity HTTP/WS owners did not release their private root.'));
    }
  }
  if (failed) {
    const reason = primaryFailure && typeof primaryFailure === 'object' ? primaryFailure : new Error(String(primaryFailure), { cause: primaryFailure });
    throw output.publicError(reason);
  }
}, { signal: t.signal })));
