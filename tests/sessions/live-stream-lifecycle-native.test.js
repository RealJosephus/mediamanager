import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { SessionService } from '../../src/sessions/service.js';
import { LiveStreamsService } from '../../src/playback/live-streams.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { md5Guid } from '../../src/core/identity.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const inputFile = new URL('./fixtures/live-stream-lifecycle/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const providerId = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider'), defaultServiceId = md5Guid('Jellyfin.LiveTv.DefaultLiveTvService');
const json = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n';
const project = run => ({ action: run.action, failure: run.failure && { status: run.failure.status, Message: run.failure.Message },
  held: run.held, closeCalls: run.closeCalls, sessions: run.sessions,
  trace: run.trace.map(entry => entry.kind === 'error' ? { kind: entry.kind, message: entry.message } : entry),
  mediaLookups: run.mediaLookups, dtoLookups: run.dtoLookups });
const itemInfo = dto => dto == null ? null : ({ Name: dto.Name,
  tracks: dto.MediaStreams?.map(stream => ({ type: stream.Type, Index: stream.Index, Codec: stream.Codec })) ?? null });
const state = session => ({ NowPlaying: session.NowPlayingItem != null, item: itemInfo(session.NowPlayingItem),
  LiveStreamId: session.PlayState.LiveStreamId, PositionTicks: session.PlayState.PositionTicks == null ? null : String(session.PlayState.PositionTicks),
  IsPaused: session.PlayState.IsPaused, MediaSourceId: session.PlayState.MediaSourceId });

async function runNode(sample, native) {
  const report = { name: sample.name, snapshots: [], opens: [], resources: {}, phaseAcceptance: false, releaseAcceptance: false };
  let database, store, sessions, streams, failure, closeRelease;
  const trace = [], errors = [], unexpectedErrors = [], closeCalls = [], identities = new Map(), disconnect = new Map(), controllers = new Map();
  const onError = error => {
    errors.push({ name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack });
    if (error.code !== 'controlled-close-failure') unexpectedErrors.push(error);
  };
  const leases = new Set(); let now = Date.now(), closedLeases = 0, openedLeases = 0, closeEntered;
  let sourceRevision = 0, mediaLookups = 0, dtoLookups = 0;
  try {
    database = await createPostgresTestDatabase(null, 'session_live'); store = new DomainStore(database);
    const channel = newNativeItemEntity('MediaBrowser.Controller.LiveTv.LiveTvChannel');
    Object.assign(channel, { Id: native.itemId, Name: 'Supplied live DTO', ServiceName: 'Emby', ExternalId: 'session-channel', ChannelType: 'TV' });
    const source = { Id: 'session-original', Path: 'http://127.0.0.1/controlled-original', Protocol: 'Http',
      SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false, MediaStreams: [], Type: 'Default' };
    const sharing = Object.freeze({ get enabled() { return leases.size > 0; }, retain: () => acquireLease() });
    async function acquireLease() {
      const owner = { closed: false }; leases.add(owner); openedLeases++;
      return Object.freeze({ mode: 'native', sharing, mediaSource: structuredClone(source), tunerHostId: 'controlled-session-tuner',
        async forkRead() { throw new Error('Session lifecycle must not open an original-byte reader.'); },
        async close() { if (owner.closed) return; owner.closed = true; leases.delete(owner); closedLeases++; } });
    }
    // Media identity/DTO and source discovery/probe are declared controls. The
    // public registry, its real leases and all SessionService paths execute.
    const library = { itemCreation: { async getItemById() { return channel; } },
      async getItemRecord() { return channel; }, async getItemDto() { return { Id: channel.Id, Name: 'Generated DTO ' + ++dtoLookups }; } };
    streams = new LiveStreamsService({ library, getLocalApiUrl: () => 'http://127.0.0.1:1', probe: { async addMediaInfo() {} },
      tuners: { name: 'Emby', async getChannelStreamMediaSources() { return [{ mediaSource: structuredClone(source) }]; },
        getChannelStream: () => acquireLease() }, onError });
    for (let index = 0; index < sample.opens; index++) {
      const opened = await streams.open({ OpenToken: providerId + '_' + defaultServiceId + '_' + channel.Id + '_' + source.Id });
      assert.equal(opened.MediaSource.LiveStreamId, native.streamId); report.opens.push(opened.MediaSource);
    }
    assert.equal(streams.snapshot()[0]?.ConsumerCount ?? 0, sample.opens);
    sessions = new SessionService({ store, library, userData: { async playback() { throw new Error('No user-data writes are admitted in this userless scope.'); } },
      serverId: 'session-native', configuration: { InactiveSessionThreshold: 1 }, clock: () => new Date(now), automaticProgress: true,
      onError });
    let throwClose = sample.throwCloseOnce === true;
    sessions.liveStreams = { getLiveStream: id => {
      mediaLookups++; const source = streams.getLiveStream(id);
      if (source) source.MediaStreams = source.MediaStreams.map(stream => ({ ...stream, Codec: 'revision-' + sourceRevision }));
      return source;
    }, async closeLiveStream(id) {
      closeCalls.push(id); trace.push({ kind: 'close', id });
      if (closeEntered) { closeEntered.resolve(); await closeRelease.promise; }
      await streams.closeLiveStream(id);
      if (throwClose) { throwClose = false; throw Object.assign(new Error('Controlled close failure.'), { code: 'controlled-close-failure' }); }
    } };
    for (const [event, kind] of [['PlaybackStart', 'PlaybackStartEventArgs'], ['PlaybackProgress', 'PlaybackProgressEventArgs'], ['PlaybackStopped', 'PlaybackStopEventArgs']]) {
      sessions.on(event, value => trace.push({ kind, session: value.Session.DeviceId, play: value.PlaySessionId,
        position: value.PlaybackPositionTicks == null ? null : String(value.PlaybackPositionTicks), item: itemInfo(value.MediaInfo) }));
    }
    sessions.on('SessionEnded', value => trace.push({ kind: 'SessionEnded', session: value.SessionInfo.DeviceId }));
    sessions.on('SessionError', error => errors.push(error.message));
    for (const alias of sample.sessions) {
      const session = await sessions.logActivity({ Client: 'Lifecycle', Version: '1', DeviceId: alias, Device: alias });
      identities.set(alias, session.Id);
      const controller = { active: true, isActive() { return this.active; }, supportsMediaControl: true,
        async sendMessage(type, _messageId, command) { trace.push({ kind: 'command', session: alias, type,
          command: command.Command, ControllingUserId: command.ControllingUserId, position: command.SeekPositionTicks == null ? null : String(command.SeekPositionTicks) }); } };
      controllers.set(alias, controller); disconnect.set(alias, sessions.attachController(session.Id, controller));
    }
    trace.length = 0;
    for (const action of sample.actions) {
      const sessionId = identities.get(action.session) ?? 'missing';
      const selectedLive = native.streamId + (action.unknownStream ? '-unknown' : '');
      const live = action.upperStream ? selectedLive.toUpperCase() : selectedLive;
      const info = { Item: { Id: native.itemId, Name: 'Supplied live DTO' }, LiveStreamId: live,
        PlaySessionId: action.play ?? null, PositionTicks: BigInt(action.position ?? '123'), IsPaused: true, PlayMethod: 'DirectPlay' };
      if (action.noItem) { info.Item = null; info.ItemId = native.itemId; }
      let rejected = null, held = null;
      try {
        switch (action.kind) {
          case 'start': await sessions.playbackStart(sessionId, info); break;
          case 'progress': await sessions.playbackProgress(sessionId, info); break;
          case 'source-revision': sourceRevision++; break;
          case 'stop': await sessions.playbackStopped(sessionId, info); break;
          case 'close': {
            const identity = action.identity === '$session' ? sessionId : action.identity;
            await sessions.closeLiveStreamIfNeeded(live, action.upperIdentity ? identity.toUpperCase() : identity); break;
          }
          case 'end': await sessions.endSession(sessionId); break;
          case 'disconnect': controllers.get(action.session).active = false; await disconnect.get(action.session)(); break;
          case 'idle': now += 360001; await sessions.checkIdlePlayback(); break;
          case 'inactive': now += 120001; await sessions.checkInactivePlayback(); break;
          case 'held-negative': {
            closeEntered = Promise.withResolvers(); closeRelease = Promise.withResolvers();
            const pending = sessions.playbackStopped(sessionId, info), settled = Promise.allSettled([pending]); let finished = false;
            void pending.then(() => { finished = true; }, () => { finished = true; });
            let deadline;
            try {
              await Promise.race([closeEntered.promise, pending.then(() => { throw new Error('The stop skipped its controlled close boundary.'); }),
                new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The controlled close boundary did not arrive.')), 20000); })]);
              held = { pending: !finished, nowPlaying: sessions.getSession(sessionId).NowPlayingItem != null, closeCalls: closeCalls.length };
              assert.equal(streams.snapshot()[0].ConsumerCount, 1, 'The actual public lease remains held until its controlled close callback continues.');
            } finally { clearTimeout(deadline); closeRelease.resolve(); }
            const [result] = await settled; if (result.status === 'rejected') throw result.reason;
            break;
          }
          default: throw new Error('Unknown lifecycle action.');
        }
      } catch (error) {
        rejected = { type: error.name, status: error.status, Message: error.message, code: error.code, stack: error.stack };
        trace.push({ kind: 'error', type: rejected.type, message: rejected.Message });
      } finally { closeRelease?.resolve(); closeEntered = closeRelease = undefined; }
      const active = await sessions.getSessions({ IsApiKey: true });
      // Paused reports use the real 1s progress timer without permitting an
      // automatic position update. Each owner is drained by the real close.
      report.snapshots.push({ action: action.kind, failure: rejected, held, closeCalls: [...closeCalls],
        mediaLookups, dtoLookups,
        sessions: active.sort((left, right) => left.DeviceId.localeCompare(right.DeviceId)).map(session => ({ alias: session.DeviceId, state: state(session) })),
        trace: structuredClone(trace), errors: [...errors], registry: streams.snapshot(), openedLeases, closedLeases });
      const remaining = Math.max(0, sample.opens - closeCalls.filter(id => id.toUpperCase() === native.streamId.toUpperCase()).length);
      assert.equal(streams.snapshot().reduce((count, entry) => count + entry.ConsumerCount, 0), remaining);
      assert.ok(streams.snapshot().every(entry => entry.ReaderCount === 0));
      assert.equal(leases.size, remaining);
    }
    assert.deepEqual(await database.rows('UserData'), []);
    assert.deepEqual(await database.rows('DeviceOptions'), []);
    assert.deepEqual(unexpectedErrors, []);
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    closeRelease?.resolve();
    for (const [name, operation] of [['sessions', () => sessions?.close()], ['sessionStateReleased', async () => {
      if (!sessions) return;
      assert.deepEqual(await sessions.getSessions({ IsApiKey: true }), []);
      for (const id of identities.values()) await sessions.advanceProgress(id);
    }], ['streams', () => streams?.close()], ['closedStateUnchanged', async () => {
      if (!database) return;
      assert.deepEqual(await database.rows('UserData'), []); assert.deepEqual(await database.rows('DeviceOptions'), []);
    }],
      ['store', () => store?.close()], ['database', () => dropPostgresTestDatabase(database)]]) {
      try { await operation(); report.resources[name] = true; } catch (error) { cleanup.push(error); report.resources[name] = false; }
    }
    report.resources.openedLeases = openedLeases; report.resources.closedLeases = closedLeases; report.resources.activeLeases = leases.size;
    if (leases.size || openedLeases !== closedLeases) cleanup.push(new Error('A real controlled tuner lease survived owner shutdown.'));
    if (!failure && cleanup.length) failure = new AggregateError(cleanup, 'Session lifecycle owners failed to close.');
    report.error = failure?.stack;
  }
  return { report, failure };
}

test('live session lifecycle matches actual SessionManager and composes real PostgreSQL sessions with public stream ownership', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'live-stream-lifecycle-' + randomUUID()); await mkdir(output);
  const report = { cases: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false }; let current, failure;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Emby.Server.Implementations/Session/SessionManager.cs',
      'MediaBrowser.Controller/Session/SessionInfo.cs', 'MediaBrowser.Controller/Session/ISessionController.cs',
      'MediaBrowser.Model/Session/PlaybackStartInfo.cs', 'MediaBrowser.Model/Session/PlaybackProgressInfo.cs',
      'MediaBrowser.Model/Session/PlaybackStopInfo.cs', 'MediaBrowser.Controller/Library/PlaybackProgressEventArgs.cs',
      'MediaBrowser.Controller/Events/Session/SessionEndedEventArgs.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'MediaBrowser.Common/Extensions/BaseExtensions.cs',
      'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'src/Jellyfin.LiveTv/LiveTvMediaSourceProvider.cs']);
    const receipt = await recordOracle({ project: 'tests/sessions/fixtures/live-stream-lifecycle/Oracle.csproj', output: path.join(output, 'native'),
      args: [fileURLToPath(inputFile), '{output}/native.json'] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualSessionManager', 'actualSessionInfoTimers', 'actualPrivateIdleAndInactiveCallbacks', 'mediaSourceCloseControlled', 'usersAndSuppliedDtoControlled']) assert.equal(native[name], true);
    assert.equal(native.nativeEfOpened, false); assert.equal(native.tunerOrRecorderStarted, false);
    assert.equal(native.streamId, providerId + '_' + defaultServiceId + '_session-original');
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    report.nativeOutputSha256 = hash(nativeBytes); report.inputSha256 = hash(inputBytes);
    assert.deepEqual(native.results.map(value => value.name), input.cases.map(value => value.name));
    for (const sample of input.cases) await t.test(sample.name, { timeout: 60000 }, async () => {
      const expected = native.results.find(value => value.name === sample.name), result = await runNode(sample, native);
      const record = { ...result.report, native: expected, passed: false }; report.cases.push(record);
      try {
        if (result.failure) throw result.failure;
        assert.equal(expected.actualSessionManagerDisposed, true); assert.equal(expected.timersReleased, true);
        assert.equal(expected.deviceSubscriptions, 1); assert.equal(expected.deviceUnsubscriptions, 1);
        assert.deepEqual(expected.disposedControllers, [...sample.sessions].sort());
        assert.ok(expected.timerEvidence.every(value => value.progressTimerReleased));
        if (sample.sessions.length) {
          assert.ok(expected.timerEvidence.some(value => value.progressTimerCreated));
          assert.ok(expected.snapshots.some(value => value.managerTimers.idle && value.managerTimers.inactive));
        }
        assert.deepEqual(result.report.snapshots.map(project), expected.snapshots.map(project), sample.name);
        assert.equal(result.report.resources.activeLeases, 0); record.passed = true;
      } catch (error) { record.error = error.stack; throw error; }
    });
  } catch (error) { failure = error; report.error = error.stack; }
  finally {
    if (current) try { await current.finish(); report.cleanup.push({ protectedInputsUnchanged: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ protectedInputsUnchanged: false, error: error.message }); }
    report.passed = !failure && report.cases.length === input.cases.length && report.cases.every(value => value.passed);
    report.boundary = 'Actual SessionManager constructor, reports, stream mappings, disconnect/end, idle/inactive callbacks and actual SessionInfo timers; native media-source Close, userless identities and supplied DTO are controls. Node uses real PostgreSQL DeviceOptions reads, SessionService and LiveStreamsService counters/leases with controlled tuners and probe. No native EF, physical tuner, byte reader, recording, codec probe or authenticated user-data claim. This is targeted component evidence, not release acceptance.';
    await writeFile(path.join(output, 'comparison.json'), json(report));
  }
  if (failure) throw failure;
  assert.equal(report.passed, true);
});
