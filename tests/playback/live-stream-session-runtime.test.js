import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { md5Guid } from '../../src/core/identity.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { guidN } from '../../src/sessions/user-data.js';
import { loadPostgresUserDataRows } from '../../src/sessions/postgres-user-data-mutation.js';
import { readLiveMediaInfoCache } from '../../src/playback/live-stream-info.js';
import { refreshGuideTaskId } from '../../src/tasks/refresh-guide-task.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { errorRecord, originalServer, originalWave, rawReader, sha256, socketClient, until, within } from './fixtures/live-stream-session-runtime/scenario.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';

export const requiredValidationServices = ['postgres'];
const discovery = declareFileTestResource('hdhomerun-discovery-65001', { enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES) });

async function fileSnapshot(root) {
  const files = [];
  async function visit(directory, relative = '') {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name), name = relative ? relative + '/' + entry.name : entry.name;
      assert.equal(entry.isSymbolicLink(), false, 'Private fixture trees cannot contain an indirect input.');
      if (entry.isDirectory()) await visit(filename, name);
      else { const bytes = await readFile(filename); files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
  }
  await visit(root); return files;
}

// M3U preparation queues Guide, including the official HDHomeRun discovery scan.
test('production PG official M3U raw HTTP readers compose with Session HTTP, WebSocket detach, UserData and runtime close', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => discovery.run(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-live-session-runtime-'));
  const output = path.join(validationOutputRoot(), 'live-stream-session-runtime-' + randomUUID()); await mkdir(output);
  const bytes = originalWave(), errors = [], readers = [], sockets = [], saved = [], ended = [], playback = [];
  const secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES, 'controlled'].filter(Boolean));
  const report = { scope: 'production createRuntime with fresh real PostgreSQL; actual HTTP/WS, official M3U, original bytes and real ffprobe',
    input: { bytes: bytes.length, sha256: sha256(bytes), preparation: 'handwritten PCM WAV, served at .ts without an encoder' },
    phases: [], requests: [], observations: [], userData: {}, phaseAcceptance: false, releaseAcceptance: false,
    actualNativeHttpCompared: false, actualSharedHttpStreamOpenExecuted: false, recordingSpoolOrTranscodeExecuted: false };
  let database, runtime, source, failure, closing, channel, cacheFile, cacheBytes, origin, openToken;
  const mark = async phase => {
    report.phases.push(phase); await appendFile(path.join(output, 'progress.log'), phase + '\n');
  };
  const observe = label => {
    const snapshot = runtime.liveStreams.snapshot(); report.observations.push({ label, streams: snapshot }); return snapshot;
  };
  const userRows = db => loadPostgresUserDataRows(db, null, [channel.Id]);
  try {
    source = await originalServer(bytes);
    const programDataPath = path.join(root, 'data'), cachePath = path.join(programDataPath, 'cache');
    await mkdir(cachePath, { recursive: true });
    await writeFile(path.join(cachePath, 'sd-countries.json'), '{"Controlled":[]}\n');
    const playlist = path.join(programDataPath, 'source.m3u');
    const playlistBytes = Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="memory-original" tvg-chno="1",Original byte channel\n' + source.origin + '/original.ts\n');
    await writeFile(playlist, playlistBytes);
    database = await createPostgresTestDatabase(null, 'live_session');
    t.signal.throwIfAborted();
    runtime = await createTestRuntime({ database, programDataPath, cachePath, configuration: { IsStartupWizardCompleted: true },
      serverId: 'live-stream-session-runtime', mediaEncoderOptions: { startupFFmpegPath: validationExecutable('ffmpeg') }, probeOptions: { timeoutMs: 15000 },
      onError: error => errors.push(error) });
    assert.ok(runtime.liveTvSources && runtime.liveTvTuners && runtime.liveStreams && runtime.liveStreamProbe);
    runtime.userData.on('UserDataSaved', event => saved.push({ reason: event.SaveReason, userId: guidN(event.UserId), itemId: guidN(event.Item.Id) }));
    runtime.sessions.on('SessionEnded', event => ended.push(event.SessionInfo));
    for (const event of ['PlaybackStart', 'PlaybackProgress', 'PlaybackStopped']) runtime.sessions.on(event, value => playback.push({ event,
      sessionId: value.Session.Id, position: value.PlaybackPositionTicks, playSessionId: value.PlaySessionId }));
    const admin = await runtime.users.createUser({ Name: 'Original administrator', Password: 'controlled' });
    await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
    const firstUser = await runtime.users.createUser({ Name: 'Original first', Password: 'controlled' });
    const secondUser = await runtime.users.createUser({ Name: 'Original second', Password: 'controlled' });
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;

    const authorization = client => 'MediaBrowser Client="OriginalRuntime", Device="HTTP and WS", DeviceId="' + client.deviceId + '", Version="1", Token="' + (client.token ?? '') + '"';
    const request = async (client, route, { method = 'GET', body } = {}) => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: authorization(client), Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: stringifyNativeJson(body) }) });
      const text = await response.text(); let value; if (text && response.headers.get('content-type')?.startsWith('application/json')) value = parseLosslessJson(text);
      report.requests.push({ deviceId: client.deviceId, route, method, status: response.status,
        ...(route === '/Users/AuthenticateByName' ? {} : { value, text, ...(body === undefined ? {} : { requestBody: stringifyNativeJson(body) }) }) });
      return { status: response.status, value };
    };
    const login = async (user, deviceId) => {
      const client = { deviceId }; const response = await request(client, '/Users/AuthenticateByName', { method: 'POST', body: { Username: user.Name, Pw: 'controlled' } });
      assert.equal(response.status, 200); client.token = response.value.AccessToken; client.sessionId = response.value.SessionInfo.Id; client.userId = user.Id;
      secrets.add(client.token);
      return client;
    };
    const administrator = await login(admin, 'original-administrator'), first = await login(firstUser, 'original-first'), second = await login(secondUser, 'original-second');
    const configured = await request(administrator, '/LiveTv/TunerHosts', { method: 'POST', body: { Type: 'm3u', Url: playlist, AllowStreamSharing: true, TunerCount: 0 } });
    assert.equal(configured.status, 200);
    await until(async () => {
      const task = await runtime.tasks.get(refreshGuideTaskId);
      const response = await request(first, '/LiveTv/Channels?enableImages=false'); assert.equal(response.status, 200);
      return { task, channels: response.value.Items };
    }, state => {
      if (state.task.State === 'Idle' && state.task.LastExecutionResult?.Status === 'Failed') throw new Error('The real official-M3U guide failed: ' + stringifyNativeJson(state.task));
      if (state.task.State !== 'Idle' || state.task.LastExecutionResult?.Status !== 'Completed' || state.channels.length !== 1) return false;
      channel = state.channels[0]; return true;
    }, 'official M3U guide channel', 60000);
    assert.equal(channel.Name, 'Original byte channel');
    const discovery = await request(first, '/Items/' + channel.Id + '/PlaybackInfo'); assert.equal(discovery.status, 200);
    assert.equal(discovery.value.MediaSources.length, 1); openToken = discovery.value.MediaSources[0].OpenToken;
    assert.equal(discovery.value.MediaSources[0].Path, source.origin + '/original.ts');
    assert.equal(source.records.length, 0, 'Discovery must not acquire original bytes.');
    const open = async client => {
      const response = await request(client, '/LiveStreams/Open', { method: 'POST', body: { OpenToken: openToken, ItemId: channel.Id } });
      assert.equal(response.status, 200); assert.equal(response.value.MediaSource.SupportsTranscoding, false);
      assert.equal(response.value.MediaSource.Protocol, 'Http'); assert.equal(new URL(response.value.MediaSource.Path).origin, origin);
      assert.match(new URL(response.value.MediaSource.Path).pathname, /^\/LiveTv\/LiveStreamFiles\/[a-f0-9]{32}\/stream\.ts$/u);
      return response.value.MediaSource;
    };
    const warmed = await open(first);
    cacheFile = path.join(cachePath, 'mediainfo', md5Guid(openToken) + '.json'); cacheBytes = await readFile(cacheFile);
    const cache = readLiveMediaInfoCache(cacheBytes);
    assert.equal(cache.MediaStreams[0].Codec, 'pcm_s16le'); assert.equal(cache.MediaStreams[0].Index, 0);
    report.mediaProbe = { executable: validationExecutable('ffprobe'), actualFfprobeExecuted: true,
      cacheBytes: cacheBytes.length, cacheSha256: sha256(cacheBytes), cacheStreams: cache.MediaStreams };
    assert.equal(warmed.MediaStreams[0].Codec, 'pcm_s16le'); assert.equal(warmed.MediaStreams[0].Index, -1);
    assert.equal(source.records.length, 1); assert.equal(source.records[0].mode, 'finite'); assert.equal(source.records[0].bytesWritten, bytes.length);
    assert.equal((await request(first, '/LiveStreams/Close?liveStreamId=' + warmed.LiveStreamId, { method: 'POST' })).status, 204);
    assert.deepEqual(observe('actual ffprobe warm owner closed'), []);
    await mark('official-m3u-guide-real-open-ffprobe-cache');
    source.hold();
    const firstSource = await open(first), secondSource = await open(second), liveId = firstSource.LiveStreamId;
    assert.equal(secondSource.LiveStreamId, liveId); assert.equal(secondSource.Path, firstSource.Path);
    assert.equal(source.records.length, 2, 'Two public consumers retain one actual original HTTP input.');
    const held = source.records[1]; assert.equal(held.mode, 'held'); assert.equal(held.bytesWritten, source.prefixLength);
    assert.equal(observe('two public opens, no readers')[0].ConsumerCount, 2);
    assert.equal(runtime.liveStreams.snapshot()[0].ReaderCount, 0, 'A real typed-cache hit must not open a probe reader.');
    assert.deepEqual(await readFile(cacheFile), cacheBytes);
    report.filesBeforePlayback = await fileSnapshot(root);
    const hostLockPath = path.join(programDataPath, 'plugins', 'node', 'host.lock');
    const hostLock = await readFile(hostLockPath), hostLockRelative = path.relative(root, hostLockPath).replaceAll('\\', '/');
    assert.equal(JSON.parse(hostLock.toString()).pid, process.pid, 'The diagnostic lock must belong to this actual plugin host.');
    assert.equal(report.filesBeforePlayback.find(file => file.path === hostLockRelative)?.sha256, sha256(hostLock));
    report.pluginHostLease = { path: hostLockRelative, pid: process.pid, sha256: sha256(hostLock) };
    const adminSocket = await socketClient(origin, administrator.token, 'administrator'); sockets.push(adminSocket);
    adminSocket.socket.send('{"MessageType":"SessionsStart","Data":"0,0"}'); await adminSocket.barrier();
    const firstSocket = await socketClient(origin, first.token, 'first playback'); sockets.push(firstSocket);
    const secondSocket = await socketClient(origin, second.token, 'second playback one'); sockets.push(secondSocket);
    const secondSocketOther = await socketClient(origin, second.token, 'second playback two'); sockets.push(secondSocketOther);
    const firstPlay = randomUUID().replaceAll('-', ''), secondPlay = randomUUID().replaceAll('-', ''), exactPosition = 9007199254740993n;
    const playing = (sourceInfo, playSessionId, position = 0n) => ({ ItemId: channel.Id, MediaSourceId: sourceInfo.Id,
      LiveStreamId: sourceInfo.LiveStreamId, PlaySessionId: playSessionId, PositionTicks: position, PlayMethod: 'DirectStream', IsPaused: true, CanSeek: false });
    assert.equal((await request(first, '/Sessions/Playing', { method: 'POST', body: playing(firstSource, firstPlay) })).status, 204);
    assert.equal((await request(second, '/Sessions/Playing', { method: 'POST', body: playing(secondSource, secondPlay) })).status, 204);
    await adminSocket.message('Sessions', message => message.Data.some(value => value.Id === first.sessionId && value.NowPlayingItem?.Id === channel.Id)
      && message.Data.some(value => value.Id === second.sessionId && value.NowPlayingItem?.Id === channel.Id));
    const firstChange = await firstSocket.message('UserDataChanged', value => value.Data.UserDataList.some(data => data.ItemId === channel.Id && data.PlayCount === 1));
    const secondChange = await until(() => [...secondSocket.record.messages, ...secondSocketOther.record.messages], values => values.some(value => value.MessageType === 'UserDataChanged'
      && value.Data.UserDataList.some(data => data.ItemId === channel.Id && data.PlayCount === 1)), 'second session UserDataChanged')
      .then(values => values.find(value => value.MessageType === 'UserDataChanged' && value.Data.UserDataList.some(data => data.ItemId === channel.Id && data.PlayCount === 1)));
    report.userData.startMessages = [firstChange, secondChange];
    const readData = async client => {
      const response = await request(client, '/UserItems/' + channel.Id + '/UserData'); assert.equal(response.status, 200); return response.value;
    };
    const assertLiveData = (data, count) => { assert.equal(data.PlayCount, count); assert.equal(data.PlaybackPositionTicks, 0); assert.equal(data.Played, false); assert.ok(data.LastPlayedDate); };
    assertLiveData(await readData(first), 1); assertLiveData(await readData(second), 1);
    report.userData.afterStarts = await database.withConnection(userRows);
    report.userData.sqlItemKey = guidN(channel.Id);
    report.userData.rawItemIds = [...new Set(report.userData.afterStarts.map(row => row.ItemId))];
    assert.deepEqual([...new Set(report.userData.afterStarts.map(row => guidN(row.UserId)))].sort(),
      [guidN(firstUser.Id), guidN(secondUser.Id)].sort(), 'SQL readback must contain both committed playback users before testing shutdown preservation.');
    assert.ok(report.userData.afterStarts.every(row => guidN(row.ItemId) === report.userData.sqlItemKey && row.PlayCount === 1));
    assert.equal((await request(first, '/Sessions/Playing/Progress', { method: 'POST', body: playing(firstSource, firstPlay, exactPosition) })).status, 204);
    const progressSnapshot = await adminSocket.message('Sessions', message => message.Data.some(value => value.Id === first.sessionId && value.PlayState.PositionTicks === exactPosition));
    report.userData.progressSession = progressSnapshot.Data.find(value => value.Id === first.sessionId);
    assertLiveData(await readData(first), 1);
    const firstReader = rawReader(firstSource.Path, 'first raw reader'); readers.push(firstReader);
    await firstReader.waitBytes(source.prefixLength); assert.deepEqual(firstReader.bytes(), bytes.subarray(0, source.prefixLength));
    const secondReader = rawReader(secondSource.Path, 'later raw reader'); readers.push(secondReader);
    await until(() => runtime.liveStreams.snapshot(), values => values.length === 1 && values[0].ReaderCount === 2, 'both HTTP readers');
    observe('both actual HTTP readers admitted');
    await source.write(held.id, source.prefixLength, source.middleEnd);
    await firstReader.waitBytes(source.middleEnd); await secondReader.waitBytes(source.middleEnd - source.prefixLength);
    assert.deepEqual(firstReader.bytes(), bytes.subarray(0, source.middleEnd));
    assert.deepEqual(secondReader.bytes(), bytes.subarray(source.prefixLength, source.middleEnd), 'A later reader consumes current original bytes without historical spool.');
    for (const reader of readers) { assert.equal(reader.record.status, 200); assert.equal(reader.record.contentType, 'video/mp2t'); assert.equal(reader.record.contentRange, null); }
    await firstReader.cancel();
    await until(() => runtime.liveStreams.snapshot(), values => values.length === 1 && values[0].ReaderCount === 1, 'cancelled reader release');
    assert.equal(observe('one reader cancelled, both public consumers retained')[0].ConsumerCount, 2); assert.equal(held.closed, false);
    await mark('real-http-bytes-two-readers-cancel-isolated');
    const changeCount = firstSocket.record.messages.length;
    assert.equal((await request(first, '/Sessions/Playing/Stopped', { method: 'POST', body: playing(firstSource, firstPlay, exactPosition) })).status, 204);
    assert.equal(observe('first HTTP Stop leaves second public consumer')[0].ConsumerCount, 1);
    assert.equal(runtime.sessions.getSession(first.sessionId).NowPlayingItem, null);
    assert.equal(runtime.sessions.getSession(second.sessionId).NowPlayingItem.Id, channel.Id);
    assertLiveData(await readData(first), 1);
    await adminSocket.message('Sessions', message => message.Data.some(value => value.Id === first.sessionId && value.NowPlayingItem == null)
      && message.Data.some(value => value.Id === second.sessionId && value.NowPlayingItem?.Id === channel.Id));
    await firstSocket.message('UserDataChanged', value => firstSocket.record.messages.indexOf(value) >= changeCount && value.Data.UserDataList.some(data => data.ItemId === channel.Id));
    const endedBefore = ended.length; await secondSocket.close(); await secondSocketOther.barrier();
    assert.equal(ended.length, endedBefore); assert.equal(observe('first of two WebSockets disconnected')[0].ConsumerCount, 1);
    await source.write(held.id, source.middleEnd, bytes.length); await secondReader.waitBytes(bytes.length - source.prefixLength);
    assert.deepEqual(secondReader.bytes(), bytes.subarray(source.prefixLength)); assert.equal(held.closed, false);
    assert.equal(secondReader.record.events.includes('response-close'), false); assert.equal(runtime.liveStreams.snapshot()[0].ReaderCount, 1);
    secondReader.record.expectedEnd = 'last session WebSocket disconnect';
    await secondSocketOther.close();
    await until(() => ended, values => values.some(value => value.Id === second.sessionId), 'last-controller SessionEnded');
    await within(secondReader.closed, 'last WS detach closes its independent HTTP reader');
    await until(() => held.closed, value => value, 'last session closes original HTTP input');
    assert.deepEqual(observe('last WS detach removes public input and readers'), []);
    assert.equal(secondReader.record.complete, false, 'The held live response ends through owner cancellation, not a forged EOF.');
    assert.throws(() => runtime.sessions.getSession(second.sessionId), { status: 404 });
    await adminSocket.message('Sessions', message => message.Data.every(value => value.Id !== second.sessionId));
    report.userData.beforeRuntimeClose = await database.withConnection(userRows);
    assert.equal(saved.filter(event => event.userId === guidN(second.userId) && event.reason === 'PlaybackFinished').length, 0, 'Native controller detach closes the live owner without inventing a Stop report.');
    await mark('http-stop-and-final-ws-detach-distinct-owners');
    const finalClient = await login(firstUser, 'original-runtime-close');
    const finalSocket = await socketClient(origin, finalClient.token, 'runtime-close playback'); sockets.push(finalSocket);
    const finalSource = await open(finalClient), finalPlay = randomUUID().replaceAll('-', '');
    assert.equal((await request(finalClient, '/Sessions/Playing', { method: 'POST', body: playing(finalSource, finalPlay) })).status, 204);
    const finalReader = rawReader(finalSource.Path, 'runtime-close raw reader'); readers.push(finalReader);
    await finalReader.waitBytes(source.prefixLength); assert.deepEqual(finalReader.bytes(), bytes.subarray(0, source.prefixLength));
    const finalInput = source.records[2]; assert.ok(finalInput && !finalInput.closed); assert.equal(source.records.length, 3);
    assert.equal(observe('runtime close admitted reader and live session')[0].ConsumerCount, 1);
    assert.equal(runtime.liveStreams.snapshot()[0].ReaderCount, 1); assert.equal(finalReader.record.events.includes('response-close'), false);
    finalReader.record.expectedEnd = 'runtime shutdown';
    report.userData.preShutdown = await database.withConnection(userRows);
    assertLiveData(await readData(finalClient), 2);
    await mark('runtime-close-with-active-ws-public-owner-and-pending-byte-read');
    closing = runtime.close(); await within(closing, 'production runtime close with original byte read and WebSockets');
    await within(Promise.all([finalReader.closed, finalSocket.closed, adminSocket.closed, firstSocket.closed]), 'runtime HTTP and WS transports close');
    await until(() => finalInput.closed, value => value, 'runtime closes final original HTTP input');
    assert.equal(finalReader.record.complete, false); assert.deepEqual(observe('runtime fully closed'), []);
    assert.deepEqual(finalReader.bytes(), bytes.subarray(0, source.prefixLength));
    assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening)); assert.equal(database.closed, true);
    assert.throws(() => runtime.sessions.getSession(finalClient.sessionId), { status: 404 });
    assert.equal(finalSocket.record.closeCode, 1000); assert.equal(finalSocket.record.closeReason, 'System Shutdown');
    assert.deepEqual(await readFile(cacheFile), cacheBytes); assert.deepEqual(await readFile(playlist), playlistBytes);
    const reopened = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
    try { report.userData.reopenedAfterShutdown = await reopened.withConnection(userRows); }
    finally { await reopened.close(); }
    assert.deepEqual(report.userData.reopenedAfterShutdown, report.userData.preShutdown, 'Runtime shutdown cannot drop or invent a playback UserData save.');
    const actualRows = report.userData.reopenedAfterShutdown;
    for (const user of [firstUser, secondUser]) {
      const rows = actualRows.filter(row => guidN(row.UserId) === guidN(user.Id)); assert.ok(rows.length > 0);
      for (const row of rows) { assert.equal(row.PlayCount, user === firstUser ? 2 : 1); assert.equal(row.PlaybackPositionTicks, 0n); assert.equal(row.Played, false); }
    }
    report.filesAfterShutdown = await fileSnapshot(root);
    await assert.rejects(readFile(hostLockPath), { code: 'ENOENT' }); report.pluginHostLease.removedAfterShutdown = true;
    assert.deepEqual(report.filesAfterShutdown, report.filesBeforePlayback.filter(file => file.path !== hostLockRelative),
      'Shutdown removes its owned plugin-host lock; all persistent bytes remain identical and no media spool is added.');
    assert.equal(source.records.every(value => value.closed), true); assert.deepEqual(errors, []);
    for (const client of sockets) assert.deepEqual(client.record.errors, []);
    assert.deepEqual(saved.map(value => value.reason), ['PlaybackStart', 'PlaybackStart', 'PlaybackProgress', 'PlaybackFinished', 'PlaybackStart']);
    assert.deepEqual(playback.map(value => value.event), ['PlaybackStart', 'PlaybackStart', 'PlaybackProgress', 'PlaybackStopped', 'PlaybackStart']);
    await mark('runtime-closed-pg-reopened-and-input-bytes-preserved');
    report.passed = true;
  } catch (error) { failure = error; }
  finally {
    for (const reader of readers) reader.destroy();
    for (const client of sockets) client.terminate();
    try { await source?.close(); } catch (error) { failure ??= error; }
    try { if (runtime) await within(closing ?? runtime.close(), 'finally runtime drain'); } catch (error) { failure ??= error; }
    report.upstream = source?.records; report.rawReaders = readers.map(reader => ({ ...reader.record, sha256: sha256(reader.bytes()) }));
    report.webSockets = sockets.map(client => client.record); report.userData.saves = saved; report.sessionEnded = ended; report.playbackEvents = playback;
    report.diagnostics = errors.map(errorRecord); report.cleanup = {};
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresSchemasRemoved = true; }
    catch (error) { failure ??= error; report.cleanup.postgresError = errorRecord(error); }
    try {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-live-session-runtime-'));
      await rm(root, { recursive: true, force: true }); report.cleanup.privateTreeRemoved = true;
    } catch (error) { failure ??= error; report.cleanup.privateTreeError = errorRecord(error); }
    if (failure) { report.passed = false; report.failure = errorRecord(failure); }
    await writeFile(path.join(output, 'report.json'), filterEvidenceJson(report, secrets));
  }
  if (failure) throw failure;
}, { signal: t.signal }));
