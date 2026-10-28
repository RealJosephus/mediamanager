import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { errorObservation } from '../helpers/error-observation.js';

const movie = '22222222222222222222222222222222';
const initialPosition = 123456789n, soughtPosition = 987654321n;
const pressureBytes = 8 * 1024 * 1024;
const maxPressureRequests = 4;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function waitFor(condition, description, signal, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (!await condition()) {
    signal?.throwIfAborted();
    assert.ok(performance.now() < deadline, description);
    await delay(10, undefined, { signal });
  }
}

async function slowDownlink(origin, report) {
  const target = new URL(origin), connections = [];
  const server = createServer(client => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    const observation = { openedAt: new Date().toISOString(), errors: [] };
    report.push(observation);
    const connection = { client, upstream, observation };
    connections.push(connection);
    connection.closed = Promise.all([client, upstream].map(socket => new Promise(resolve => {
      socket.once('close', hadError => {
        observation[socket === client ? 'clientClosed' : 'upstreamClosed'] = { at: new Date().toISOString(), hadError };
        resolve();
      });
      socket.on('error', error => observation.errors.push(errorObservation(error)));
    })));
    client.pipe(upstream); upstream.pipe(client);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `ws://127.0.0.1:${server.address().port}`,
    pause() {
      const connection = connections.at(-1);
      assert.ok(connection && !connection.upstream.destroyed);
      connection.upstream.unpipe(connection.client); connection.upstream.pause();
      connection.observation.pausedAt = new Date().toISOString();
      connection.observation.bytesReadAtPause = connection.upstream.bytesRead;
    },
    resume() {
      for (const connection of connections) if (!connection.upstream.destroyed) {
        connection.observation.resumedAt = new Date().toISOString();
        connection.upstream.pipe(connection.client); connection.upstream.resume();
      }
    },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const connection of connections) { connection.client.destroy(); connection.upstream.destroy(); }
      await Promise.all([closed, ...connections.map(connection => connection.closed)]);
      assert.ok(connections.every(connection => connection.client.destroyed && connection.upstream.destroyed));
    }
  };
}

// The proxy changes actual TCP consumption only. Every HTTP operation, WS frame,
// permission check and PostgreSQL lookup still uses the production runtime.
export async function recordSyncPlaySlowConnection({ runtime, signal, report, shutdownWhileBlocked = false, disconnectCaller = false,
  sessionsWhileBlocked = false, readUserData }) {
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
  const actors = {}, sockets = [], pendingRequests = [], cleanupErrors = [];
  Object.assign(report, { requests: [], raw: [], proxy: [], socketErrors: [], writes: [], pressureResponses: [], cleanup: {},
    scope: 'Current Node production PG/HTTP/WS consumer with one paused TCP downlink; not a simultaneous Native capture, WAN or long-duration result.',
    budget: { maxPressureRequests, maxTextBytes: maxPressureRequests * pressureBytes,
      maxPressureControls: sessionsWhileBlocked ? 0 : maxPressureRequests * 5 + Number(disconnectCaller),
      ...(sessionsWhileBlocked ? { maxPlaybackReports: 4, maxPressureReadbacks: 1 } : {}), nativeWaitTimeoutChanged: false } });
  let proxy, keepAlive, failure, failed = false, closing, pressure, callerAbort, pressureOrdinal = 0, observedPhase = 'preparation';
  const authorization = actor => `MediaBrowser Client="SyncPlayNetwork", Device="Isolated", DeviceId="sync-network-${actor}", Version="1"${actors[actor]?.token ? `, Token="${actors[actor].token}"` : ''}`;
  const request = async (route, actor, body, expectedStatus, { independent = false, clientSignal } = {}) => {
    const requestSignal = AbortSignal.any([AbortSignal.timeout(independent ? 30000 : 10000),
      ...(!independent && signal ? [signal] : []), ...(clientSignal ? [clientSignal] : [])]);
    const observation = { route, actor, startedAt: new Date().toISOString() };
    report.requests.push(observation);
    try {
      const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', signal: requestSignal,
        headers: { Authorization: authorization(actor), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : stringifyNativeJson(body) });
      const text = await response.text();
      Object.assign(observation, { status: response.status, bodyText: text });
      observation.body = text === '' ? null : response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text;
      if (Array.isArray(expectedStatus)) assert.ok(expectedStatus.includes(response.status), route + ': ' + text);
      else assert.equal(response.status, expectedStatus, route + ': ' + text);
      return observation;
    } catch (error) { observation.error = errorObservation(error); throw error; }
    finally { observation.finishedAt = new Date().toISOString(); }
  };
  const post = (route, actor, body = {}) => request('/SyncPlay/' + route, actor, body, 204);
  const syncMessages = (actor, start = 0) => actors[actor].messages.slice(start).filter(message => message.MessageType.startsWith('SyncPlay'));
  const hasState = (actor, start, state, reason) => syncMessages(actor, start).some(message => message.Data?.Type === 'StateUpdate'
    && message.Data.Data.State === state && message.Data.Data.Reason === reason);
  const connect = async actor => {
    const wsOrigin = actor === 'slow' ? proxy.origin : origin.replace('http', 'ws');
    const socket = new WebSocket(`${wsOrigin}/socket?ApiKey=${actors[actor].token}&networkConsumer=${actor}`);
    const messages = []; sockets.push(socket); actors[actor].socket = socket; actors[actor].messages = messages;
    socket.on('error', error => report.socketErrors.push({ actor, error: errorObservation(error) }));
    socket.on('message', bytes => {
      const message = parseLosslessJson(bytes.toString());
      if (message.MessageType === 'GeneralCommand' && message.Data?.Name === 'DisplayMessage') {
        const text = message.Data.Arguments.Text;
        const pressureMessage = { MessageType: message.MessageType, MessageId: message.MessageId,
          header: message.Data.Arguments.Header, textBytes: Buffer.byteLength(text), sha256: digest(text) };
        (actors[actor].pressureMessages ??= []).push(pressureMessage);
        report.raw.push({ actor, pressureMessage });
      } else { messages.push(message); report.raw.push({ actor, message }); }
    });
    await once(socket, 'open', { signal });
    await waitFor(() => messages.some(message => message.MessageType === 'ForceKeepAlive'), 'The actual WS handshake must complete.', signal);
  };
  const startKeepAlive = () => {
    keepAlive = setInterval(() => {
      for (const { socket } of Object.values(actors)) if (socket?.readyState === WebSocket.OPEN) {
        socket.send(stringifyNativeJson({ MessageType: 'KeepAlive' }), error => {
          if (error) report.socketErrors.push({ phase: observedPhase, error: errorObservation(error) });
        });
      }
    }, 10000);
    keepAlive.unref();
  };
  const upgradeObserver = (incoming, socket) => {
    if (new URL(incoming.url, 'http://consumer.invalid').searchParams.get('networkConsumer') !== 'slow') return;
    const write = socket.write;
    socket.write = function (...args) {
      const accepted = write.apply(this, args);
      if (observedPhase === 'pressure' && !accepted) report.writes.push({ at: new Date().toISOString(),
        bytes: typeof args[0] === 'string' ? Buffer.byteLength(args[0], typeof args[1] === 'string' ? args[1] : 'utf8') : args[0].byteLength,
        accepted, phase: observedPhase, pressureOrdinal });
      return accepted;
    };
    socket.on('drain', () => { if (observedPhase === 'pressure') (report.drains ??= []).push({ at: new Date().toISOString() }); });
    socket.once('close', () => { socket.write = write; });
  };
  const listener = runtime.networkHost.listeners.find(entry => entry.scheme === 'http').server;
  const requestObserver = (request, response) => {
    if (!/^\/Sessions\/[^/]+\/Message$/u.test(request.url)) return;
    const observation = { pressureOrdinal, admittedAt: new Date().toISOString(), closed: false };
    report.pressureResponses.push(observation);
    response.once('close', () => Object.assign(observation, { closed: true, closedAt: new Date().toISOString(),
      writableFinished: response.writableFinished }));
  };
  const recordSessionSubscription = async () => {
    report.scope = 'Current Node production PG/HTTP/WS Sessions subscribers under one paused TCP downlink; public playback states consumed by the designated remote UI, without claiming an actual browser or simultaneous Native capture.';
    report.sessions = { targetId: actors.fast.sessionId, subscribers: ['slow', 'observer'], observations: [], playbackReports: [] };
    const subscribers = report.sessions.subscribers;
    const target = message => message.MessageType === 'Sessions'
      ? message.Data.find(session => session.Id === actors.fast.sessionId) : undefined;
    const starts = () => Object.fromEntries(subscribers.map(actor => [actor, actors[actor].messages.length]));
    const received = async (actor, start, phase, predicate) => {
      const match = () => actors[actor].messages.slice(start).map(target).find(session => session && predicate(session));
      await waitFor(() => Boolean(match()), `The ${actor} Sessions subscriber must receive ${phase}.`, signal);
      const session = match();
      report.sessions.observations.push({ actor, phase, observedAt: new Date().toISOString(), session });
      return session;
    };
    const playback = (position, paused) => ({ ItemId: movie, MediaSourceId: movie, PlaySessionId: '',
      PositionTicks: position, IsPaused: paused, CanSeek: true, PlayMethod: 'DirectPlay' });
    const reportPlayback = async (suffix, input) => {
      const operation = { suffix, input, startedAt: new Date().toISOString() };
      report.sessions.playbackReports.push(operation);
      operation.response = await request('/Sessions/Playing' + suffix, 'fast', input, 204);
      return operation;
    };
    const initial = 6000000000n, resumed = initial + 10000000n, paused = resumed + 10000000n;
    const state = (position, isPaused) => session => session.NowPlayingItem?.Id === movie
      && session.PlayState.MediaSourceId === movie && session.PlayState.IsPaused === isPaused
      && (isPaused ? BigInt(session.PlayState.PositionTicks) === position : BigInt(session.PlayState.PositionTicks) >= position);
    const saved = async (phase, position) => {
      const rows = await readUserData(actors.fast.userId, movie);
      report.sessions[phase] = rows;
      assert.ok(rows.length > 0, 'The actual PostgreSQL playback rows must exist.');
      assert.ok(rows.every(row => row.PlaybackPositionTicks === position && row.PlayCount > 0),
        'The accepted playback report must commit its actual resume position.');
    };
    for (const actor of subscribers) {
      const start = actors[actor].messages.length;
      for (const message of [{ MessageType: 'SessionsStart', Data: '100,800' }, { MessageType: 'KeepAlive' }]) {
        await new Promise((resolve, reject) => actors[actor].socket.send(stringifyNativeJson(message), error => error ? reject(error) : resolve()));
      }
      // This reply follows SessionsStart on the same real TCP connection.
      // No periodic client keep-alive has been sent before this subscription.
      await waitFor(() => actors[actor].messages.slice(start).some(message => message.MessageType === 'KeepAlive'),
        'The public subscription fence must complete before playback starts.', signal);
    }
    startKeepAlive();
    await request('/Sessions/Capabilities/Full', 'fast', { SupportsMediaControl: true, PlayableMediaTypes: ['Video'],
      SupportedCommands: ['DisplayMessage'] }, 204);
    const baseline = starts();
    await reportPlayback('', playback(initial, true));
    for (const actor of subscribers) {
      const session = await received(actor, baseline[actor], 'initial paused playback', state(initial, true));
      assert.equal(session.SupportsRemoteControl, true);
    }
    // A genuinely paused baseline leaves the native automatic-progress timer
    // intact without creating an unrelated playing-progress batch.
    proxy.pause(); observedPhase = 'pressure';
    const text = 'S'.repeat(pressureBytes);
    report.pressure = { textBytesPerRequest: Buffer.byteLength(text), sha256: digest(text), attempts: [] };
    // Submit a fixed total of 32 MiB. No loop depends on a private buffer size,
    // and no extra publication is needed to manufacture a blocked batch.
    for (pressureOrdinal = 1; pressureOrdinal <= maxPressureRequests; pressureOrdinal++) {
      const ordinal = pressureOrdinal;
      const attempt = { ordinal, startedAt: new Date().toISOString(), completed: false };
      report.pressure.attempts.push(attempt);
      pressure = request(`/Sessions/${actors.slow.sessionId}/Message`, 'fast',
        { Header: 'Bounded Sessions pressure ' + ordinal, Text: text }, 204, { independent: true })
        .then(response => { attempt.completed = true; attempt.response = { status: response.status, body: response.body }; return { response, failed: false }; },
          error => { attempt.completed = true; attempt.error = errorObservation(error); return { error, failed: true }; });
      pendingRequests.push(pressure);
      await waitFor(() => report.writes.some(write => write.pressureOrdinal === ordinal && write.bytes >= pressureBytes && !write.accepted),
        'Each bounded pressure request must reach an actual backpressured socket write.', signal);
    }
    report.sessions.healthyHttpWhileBlocked = (await request('/Sessions', 'observer', undefined, 200)).body;
    report.pressure.blockedOrdinals = report.pressure.attempts.filter(attempt => !attempt.completed).map(attempt => attempt.ordinal);
    assert.ok(report.pressure.blockedOrdinals.length > 0,
      'The explicit TCP pressure budget must leave a real public delivery pending after healthy HTTP readback.');
    for (const attempt of report.pressure.attempts) if (attempt.completed) {
      const delivered = await pendingRequests[attempt.ordinal - 1];
      if (delivered.failed) throw delivered.error;
      assert.equal(delivered.response.status, 204);
    }
    const changing = starts();
    await reportPlayback('/Progress', playback(resumed, false));
    await saved('userDataWhileBlocked', resumed);
    // Native sends all eligible connections concurrently within this one batch.
    // Its channel still waits for that batch before processing the next event;
    // resume the downlink before requiring any later playback transition.
    report.sessions.healthyWhileBlocked = await received('observer', changing.observer, 'resumed playback while another subscriber is blocked', state(resumed, false));
    assert.ok(report.pressure.attempts.some(attempt => !attempt.completed),
      'Healthy Sessions delivery must finish while the paused downlink still blocks a real HTTP delivery.');
    observedPhase = 'recovery'; proxy.resume();
    for (const delivered of await Promise.all(pendingRequests)) {
      if (delivered.failed) throw delivered.error;
      assert.equal(delivered.response.status, 204);
    }
    await received('slow', changing.slow, 'resumed playback after TCP recovery', state(resumed, false));
    assert.deepEqual(actors.slow.pressureMessages.map(message => ({ header: message.header, textBytes: message.textBytes, sha256: message.sha256 })),
      report.pressure.attempts.map(attempt => ({ header: 'Bounded Sessions pressure ' + attempt.ordinal, textBytes: pressureBytes, sha256: digest(text) })));
    const pausing = starts();
    await reportPlayback('/Progress', playback(paused, true));
    for (const actor of subscribers) await received(actor, pausing[actor], 'paused playback after recovery', state(paused, true));
    const stopping = starts();
    await reportPlayback('/Stopped', { ItemId: movie, MediaSourceId: movie,
      PlaySessionId: '', PositionTicks: paused, Failed: false });
    for (const actor of subscribers) await received(actor, stopping[actor], 'stopped playback after recovery',
      session => session.NowPlayingItem == null && session.PlayState?.MediaSourceId == null);
    await saved('userDataAfterStop', paused);
  };
  listener.on('upgrade', upgradeObserver);
  listener.on('request', requestObserver);
  try {
    proxy = await slowDownlink(origin, report.proxy);
    for (const actor of sessionsWhileBlocked ? ['slow', 'fast', 'observer'] : ['fast', 'slow', 'observer']) {
      const login = await request('/Users/AuthenticateByName', actor,
        { Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' }, 200);
      actors[actor] = { token: login.body.AccessToken, sessionId: login.body.SessionInfo.Id, userId: login.body.User.Id };
      if (actor !== 'observer' || sessionsWhileBlocked) await connect(actor);
    }
    if (sessionsWhileBlocked) await recordSessionSubscription();
    else {
      startKeepAlive();
      const group = (await request('/SyncPlay/New', 'fast', { GroupName: 'TCP downlink recovery' }, 200)).body;
      report.groupId = group.GroupId;
      await post('Join', 'slow', { GroupId: group.GroupId });
      await post('SetNewQueue', 'fast', { PlayingQueue: [movie, movie], StartPositionTicks: initialPosition });
      await waitFor(() => syncMessages('fast').some(message => message.Data?.Type === 'PlayQueue'), 'The actual queue must reach the active member.', signal);
      const playlist = syncMessages('fast').find(message => message.Data?.Type === 'PlayQueue').Data.Data.Playlist;
      const ready = actor => post('Ready', actor, { PlaylistItemId: playlist[0].PlaylistItemId,
        PositionTicks: initialPosition, When: '0001-01-01T00:00:00Z', IsPlaying: false });
      await ready('fast'); await ready('slow');
      await waitFor(() => hasState('fast', 0, 'Playing', 'Ready') && hasState('slow', 0, 'Playing', 'Ready'),
        'Both real clients must reach Playing before the downlink is paused.', signal);
      const starts = Object.fromEntries(['fast', 'slow'].map(actor => [actor, actors[actor].messages.length]));
      proxy.pause(); observedPhase = 'pressure';
      const text = 'S'.repeat(pressureBytes);
      report.pressure = { textBytesPerRequest: Buffer.byteLength(text), sha256: digest(text), attempts: [] };
      let blocked;
      // A completed socket write may only have reached an OS buffer. Fill that
      // real buffer within a fixed budget; never require equal OS buffer sizes.
      for (pressureOrdinal = 1; pressureOrdinal <= maxPressureRequests; pressureOrdinal++) {
        const attempt = { ordinal: pressureOrdinal, startedAt: new Date().toISOString(), completed: false };
        report.pressure.attempts.push(attempt);
        callerAbort = new AbortController();
        pressure = request(`/Sessions/${actors.slow.sessionId}/Message`, 'fast',
          { Header: 'Bounded TCP pressure ' + pressureOrdinal, Text: text }, [204, 500], { independent: true, clientSignal: callerAbort.signal })
          .then(response => { attempt.completed = true; attempt.response = { status: response.status, body: response.body }; return { response, failed: false }; },
            error => { attempt.completed = true; attempt.error = errorObservation(error); return { error, failed: true }; });
        pendingRequests.push(pressure);
        await waitFor(() => report.writes.some(write => write.pressureOrdinal === pressureOrdinal && write.bytes >= pressureBytes && !write.accepted),
          'The bounded public message must encounter actual TCP backpressure.', signal);
        const fastStart = actors.fast.messages.length;
        for (const Mode of ['RepeatAll', 'RepeatOne', 'RepeatNone']) await post('SetRepeatMode', 'fast', { Mode });
        await post('Seek', 'fast', { PositionTicks: soughtPosition });
        await post('Pause', 'fast');
        await waitFor(() => syncMessages('fast', fastStart).some(message => message.Data?.Type === 'StateUpdate' && message.Data.Data.Reason === 'Pause'),
          'A slow socket must not block the other member controls.', signal);
        const healthy = syncMessages('fast', fastStart);
        assert.deepEqual(healthy.filter(message => message.Data?.Type === 'PlayQueue').map(message => message.Data.Data.RepeatMode),
          ['RepeatAll', 'RepeatOne', 'RepeatNone']);
        assert.deepEqual(healthy.filter(message => message.MessageType === 'SyncPlayCommand').map(message => [message.Data.Command, BigInt(message.Data.PositionTicks)]),
          [['Seek', soughtPosition]]);
        assert.deepEqual(healthy.filter(message => message.Data?.Type === 'StateUpdate').map(message => [message.Data.Data.State, message.Data.Data.Reason]),
          [['Waiting', 'Seek'], ['Waiting', 'Pause']]);
        if (!attempt.completed) { blocked = attempt; break; }
        const delivered = await pressure; if (delivered.failed) throw delivered.error;
        assert.equal(delivered.response.status, 204, 'Pressure preparation cannot hide an earlier failed public request.');
      }
      assert.ok(blocked, 'The explicit TCP pressure budget must leave a public delivery blocked while the healthy member receives every control.');
      report.pressure.blockedOrdinal = blocked.ordinal;
      if (disconnectCaller) {
        callerAbort.abort(new Error('The isolated HTTP controller disconnected.'));
        const disconnected = await pressure;
        assert.equal(disconnected.failed, true);
        await waitFor(() => report.pressureResponses.some(response => response.pressureOrdinal === blocked.ordinal
          && response.closed && !response.writableFinished), 'The actual HTTP response must observe its client disconnect.', signal);
        assert.equal(actors.slow.socket.readyState, WebSocket.OPEN);
        report.clientDisconnect = { requestRejected: true, serverObservedIncompleteResponseClose: true,
          reason: errorObservation(disconnected.error) };
        const afterDisconnect = actors.fast.messages.length;
        await post('SetRepeatMode', 'fast', { Mode: 'RepeatAll' });
        await waitFor(() => syncMessages('fast', afterDisconnect).some(message => message.Data?.Type === 'PlayQueue'
          && message.Data.Data.RepeatMode === 'RepeatAll'), 'The healthy member must receive a fresh control after the HTTP client disconnects.', signal);
      }
      report.fastWhileBlocked = syncMessages('fast', starts.fast);

      if (shutdownWhileBlocked) {
        observedPhase = 'shutdown';
        report.shutdown = { startedAt: new Date().toISOString(), observationBudgetMs: 10000, completedBeforeDownlinkRecovery: false };
        closing = runtime.close().then(() => { report.shutdown.completedBeforeDownlinkRecovery = observedPhase === 'shutdown'; },
          error => { report.shutdown.failed = true; report.shutdown.error = errorObservation(error); throw error; });
        // Attach a rejection observer immediately, while retaining the actual
        // promise for final cleanup. This timer observes completion only.
        void closing.catch(() => {});
        await waitFor(() => report.shutdown.completedBeforeDownlinkRecovery || report.shutdown.failed,
          'Runtime close must settle before this test recovers the paused downlink.', signal, report.shutdown.observationBudgetMs);
        assert.equal(report.shutdown.completedBeforeDownlinkRecovery, true,
          'Runtime close must release a backpressured WS send before HTTP request drain can finish.');
        await closing;
        const cancelled = await pressure; if (cancelled.failed) throw cancelled.error;
        assert.equal(cancelled.response.status, 500);
        assert.equal(cancelled.response.body, 'Error processing request.');
        report.shutdown.listenersClosed = runtime.networkHost.listeners.every(entry => !entry.server.listening);
        assert.equal(report.shutdown.listenersClosed, true);
      } else {
        observedPhase = 'recovery'; proxy.resume();
        const delivered = await pressure; if (delivered.failed && !disconnectCaller) throw delivered.error;
        await waitFor(() => syncMessages('slow', starts.slow).length === report.fastWhileBlocked.length,
          'The slow member must receive every queued control after real TCP recovery.', signal);
        report.slowAfterRecovery = syncMessages('slow', starts.slow);
        const deliveredContent = messages => messages.map(({ MessageId, ...message }) => {
          assert.equal(typeof MessageId, 'string'); assert.ok(MessageId.length > 0); return message;
        });
        assert.deepEqual(deliveredContent(report.slowAfterRecovery), deliveredContent(report.fastWhileBlocked));
        assert.deepEqual(actors.slow.pressureMessages.map(message => ({ header: message.header, textBytes: message.textBytes, sha256: message.sha256 })),
          report.pressure.attempts.map(attempt => ({ header: 'Bounded TCP pressure ' + attempt.ordinal, textBytes: pressureBytes, sha256: digest(text) })));
        const beforePause = actors.fast.messages.length;
        for (const actor of ['fast', 'slow']) await post('Ready', actor, { PlaylistItemId: playlist[0].PlaylistItemId,
          PositionTicks: soughtPosition, When: '0001-01-01T00:00:00Z', IsPlaying: false });
        assert.equal((await request(`/SyncPlay/${group.GroupId}`, 'observer', undefined, 200)).body.State, 'Paused');
        await waitFor(() => syncMessages('fast', beforePause).some(message => message.MessageType === 'SyncPlayCommand' && message.Data.Command === 'Pause'),
          'The actual pause command must establish the retained position.', signal);
        const retainedPosition = BigInt(syncMessages('fast', beforePause).find(message => message.MessageType === 'SyncPlayCommand' && message.Data.Command === 'Pause').Data.PositionTicks);
        report.retainedPositionTicks = retainedPosition;
        const departed = actors.fast.messages.length, oldSocket = actors.slow.socket;
        const disconnected = once(oldSocket, 'close'); oldSocket.close(1000, 'Reconnect consumer'); await disconnected;
        await waitFor(() => syncMessages('fast', departed).some(message => message.Data?.Type === 'UserLeft'),
          'The actual old connection must leave the group before reconnect.', signal);
        await connect('slow');
        await post('Pause', 'slow');
        await waitFor(() => syncMessages('slow').some(message => message.Data?.Type === 'NotInGroup'),
          'Reconnecting a session must not restore membership without Join.', signal);
        await post('Join', 'slow', { GroupId: group.GroupId });
        await waitFor(() => syncMessages('slow').some(message => message.Data?.Type === 'PlayQueue'),
          'The rejoined socket must receive the current queue.', signal);
        const rejoined = syncMessages('slow').find(message => message.Data?.Type === 'PlayQueue').Data.Data;
        assert.deepEqual(rejoined.Playlist, playlist); assert.equal(BigInt(rejoined.StartPositionTicks), retainedPosition);
        await post('Ready', 'slow', { PlaylistItemId: playlist[0].PlaylistItemId,
          PositionTicks: retainedPosition, When: '0001-01-01T00:00:00Z', IsPlaying: false });
        report.rejoined = (await request(`/SyncPlay/${group.GroupId}`, 'observer', undefined, 200)).body;
        assert.equal(report.rejoined.State, 'Paused');
        await post('SetRepeatMode', 'fast', { Mode: 'RepeatAll' });
        await waitFor(() => syncMessages('slow').some(message => message.Data?.Type === 'PlayQueue' && message.Data.Data.RepeatMode === 'RepeatAll'),
          'The real rejoined connection must consume fresh controls.', signal);
        report.reconnected = { sameToken: true, handshakeObserved: true, membershipRejoined: true, positionTicks: retainedPosition };
        assert.deepEqual(report.socketErrors, []);
      }
    }
  } catch (error) { failed = true; failure = error; }
  finally {
    clearInterval(keepAlive); observedPhase = 'cleanup'; proxy?.resume();
    const actions = [
      ['pressure-request', async () => { await Promise.all(pendingRequests); }],
      ['client-sockets', async () => {
        await Promise.all(sockets.map(socket => {
          if (socket.readyState === WebSocket.CLOSED) return;
          const closed = new Promise(resolve => socket.once('close', resolve)); socket.close(1000, 'Consumer cleanup'); return closed;
        }));
      }],
      ['runtime-close', async () => { if (closing) await closing; }],
      ['proxy', async () => { await proxy?.close(); }]
    ];
    for (const [name, action] of actions) {
      try { await action(); report.cleanup[name] = true; }
      catch (error) { cleanupErrors.push(error); report.cleanup[name] = errorObservation(error); }
    }
    listener.off('upgrade', upgradeObserver);
    listener.off('request', requestObserver);
    report.tokens = Object.values(actors).map(actor => actor.token);
    report.closedClientSockets = sockets.every(socket => socket.readyState === WebSocket.CLOSED);
  }
  if (failed && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'SyncPlay network operation and cleanup failed.', { cause: failure });
  if (failed) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'SyncPlay network cleanup failed.', { cause: cleanupErrors[0] });
  return report;
}
