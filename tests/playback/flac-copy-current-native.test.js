import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { captureCurrentFlac, profile, hash, json, errorValue, inspectPackets, packets, audioStreams } from './fixtures/flac-copy-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && postgresTestConnectionString;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function eventually(check, message) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail(message);
}

test('existing mono FLAC copies through current Native audio admission and formal Local/PG HTTP, cold reopen and real cancellation', {
  skip: !enabled, timeout: 600000,
}, async t => {
  const captured = await captureCurrentFlac(), output = path.join(captured.output, 'node'); await fs.mkdir(output);
  const originalBytes = await fs.readFile(captured.assetPath), media = path.join(output, 'original.flac'); await fs.writeFile(media, originalBytes, { flag: 'wx' });
  const Id = profile.itemId.toUpperCase(), id = profile.itemId.replaceAll('-', '');
  const config = path.join(output, 'config'); await fs.mkdir(config);
  await writeConfigurationFile(path.join(config, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
  await writeConfigurationFile(path.join(config, 'network.xml'), 'network', { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true });
  const report = { schemaVersion: 1, scope: captured.report.scope, actualNativeEvidence: captured.report.captures,
    actualNodeExecutables: { ffmpeg: captured.native.ffmpeg, ffprobe: captured.native.ffprobe },
    http: [], probes: [], readers: [], leases: [], leaseRequestsAfterRelease: [], processes: [], mediaCommands: [], diagnostics: [], cleanup: [], failures: [],
    phaseAcceptance: false, releaseAcceptance: false, componentAcceptance: false };
  let database, runtime, storage, origin, token, userId, gate, stopping, cancelled, cancellation, generation = 0;
  const clientCancellation = new AbortController();
  // Observe the actual tools directly. A cancelled .NET launcher can stop while
  // writing its JSON trace, before it installs ownership of its own FFmpeg child.
  const processChannel = 'tracing:child_process.spawn:start';
  const observeMediaProcess = ({ process: child }) => {
    const tool = Object.entries(report.actualNodeExecutables).find(([, value]) => value.filename === child.spawnfile)?.[0];
    if (!tool) return;
    const observation = { generation, tool, executable: child.spawnfile, arguments: child.spawnargs.slice(1),
      pid: null, spawned: false, closed: false, errors: [] };
    report.mediaCommands.push(observation);
    child.once('spawn', () => Object.assign(observation, { pid: child.pid, spawned: true, startedAt: new Date().toISOString() }));
    child.once('error', error => observation.errors.push(errorValue(error)));
    child.once('close', (exitCode, signal) => Object.assign(observation, { closed: true, exitCode, signal, closedAt: new Date().toISOString() }));
  };
  subscribe(processChannel, observeMediaProcess);
  const create = async () => {
    generation++;
    storage = await localStateStorage(output);
    const adapter = storage.fileSystem.vfs.resolve('/state/original.flac').adapter, openRead = adapter.openRead.bind(adapter);
    adapter.openRead = async (location, options = {}) => {
      const handle = await openRead(location, options);
      if (location !== '/original.flac') return handle;
      const observation = { generation, location, closed: false }; report.readers.push(observation);
      const selected = gate; if (selected) selected.opened.resolve();
      let closed = false;
      return { ...handle, stream: (async function* () {
        if (selected) {
          const abort = Promise.withResolvers(), aborted = () => abort.reject(options.signal.reason);
          options.signal?.addEventListener('abort', aborted, { once: true });
          try { options.signal?.throwIfAborted(); await Promise.race([selected.release.promise, abort.promise]); options.signal?.throwIfAborted(); }
          finally { options.signal?.removeEventListener('abort', aborted); }
        }
        if (!closed) yield* handle.stream;
      })(), close: async () => {
        try { await handle.close(); observation.closed = true; }
        catch (error) { observation.closeError = errorValue(error); throw error; }
        finally { closed = true; selected?.closed.resolve(); selected?.release.resolve(); }
      } };
    };
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(output),
      vfs: storage.fileSystem.vfs, identityMap: storage.fileSystem.identityMap,
      mediaEncoderOptions: { startupFFmpegPath: captured.native.ffmpeg.filename },
      autoDiscoveryOptions: { enabled: false },
      remuxOptions: { onProcess: process => report.processes.push({ generation, kind: 'remux', ...process }) },
      hlsOptions: { onProcess: process => report.processes.push({ generation, kind: 'hls', ...process }) },
      onError: error => report.diagnostics.push(errorValue(error)) });
    const bridge = runtime.remux.bridge, lease = bridge.lease.bind(bridge);
    bridge.lease = async (...args) => {
      const result = await lease(...args);
      report.leases.push({ generation, location: args[0], url: result.url, expiresAt: result.expiresAt, consistency: result.consistency });
      return result;
    };
    await runtime.start();
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
  };
  const close = async () => {
    gate?.release.resolve(); gate = undefined;
    const errors = [];
    const currentRuntime = runtime, currentStorage = storage; runtime = undefined; storage = undefined;
    if (currentRuntime) try {
      await currentRuntime.close();
      const listenersClosed = currentRuntime.networkHost.listeners.every(entry => !entry.server.listening);
      report.cleanup.push({ generation, runtimeClosed: true, listenersClosed }); assert.ok(listenersClosed);
    } catch (error) { errors.push(error); }
    if (currentStorage) try { await currentStorage.close(); report.cleanup.push({ generation, storageClosed: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'FLAC runtime and storage cleanup failed.', { cause: errors[0] });
  };
  const request = async (route, { method = 'GET', body, signal = t.signal } = {}) => {
    const observation = { generation, route, method, requestBody: body }; report.http.push(observation);
    try {
      const response = await fetch(origin + route, { method, signal, headers: { 'X-Emby-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: json(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()); Object.assign(observation, { status: response.status,
        headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64') });
      const contentType = response.headers.get('content-type') ?? '';
      if (token && /json|mpegurl|^text\//iu.test(contentType)) {
        const text = bytes.toString('utf8'), filtered = text.replaceAll(token, 'sha256:' + hash(Buffer.from(token)));
        if (filtered !== text) {
          observation.bytes = Buffer.from(filtered).toString('base64');
          observation.credentialProjection = { kind: 'API key replaced by its SHA-256', originalBytes: bytes.length, originalSha256: hash(bytes) };
        }
      }
      return { ...observation, raw: bytes };
    } catch (error) { observation.error = errorValue(error); throw error; }
  };
  const releasedLeases = async () => {
    for (const lease of report.leases.filter(value => value.generation === generation)) {
      await eventually(async () => {
        const response = await fetch(lease.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
        report.leaseRequestsAfterRelease.push({ generation, url: lease.url, status: response.status });
        return response.status === 404;
      }, 'Released original-media URLs must no longer serve bytes.');
    }
  };
  const removedHlsCaches = async () => {
    for (const entry of report.processes.filter(value => value.generation === generation && value.kind === 'hls')) {
      const directory = path.dirname(entry.args.at(-1));
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
      report.cleanup.push({ generation, removedHlsCache: directory });
    }
  };
  const comparePayload = async (label, bytes, expected) => {
    const filename = path.join(output, label + '.mp4'); await fs.writeFile(filename, bytes, { flag: 'wx' });
    const probe = await inspectPackets(filename, filename + '.ffprobe.json', t.signal); report.probes.push({ label, probe });
    assert.deepEqual(packets(probe.raw), packets(expected.probe.raw), label + ': Native packet hashes, order and complete rational timing');
    assert.deepEqual(audioStreams(probe.raw), audioStreams(expected.probe.raw), label + ': Native audio stream parameters');
    return probe;
  };
  const positive = async label => {
    const selection = await request(`/Items/${id}/PlaybackInfo`, { method: 'POST', body: {
      UserId: userId,
      DeviceProfile: { MaxStreamingBitrate: 1000000000, DirectPlayProfiles: [{ Type: 'Audio', Container: 'mp4', AudioCodec: 'flac' }], TranscodingProfiles: [] } } });
    assert.equal(selection.status, 200); const selected = JSON.parse(selection.raw).MediaSources[0];
    assert.equal(selected.SupportsTranscoding, true); assert.equal(selected.TranscodingContainer, 'mp4');
    assert.match(selected.TranscodingUrl, /\/audio\/.*\/stream\.mp4\?/iu);
    const direct = await request(selected.TranscodingUrl); assert.equal(direct.status, 200);
    const nativeDirect = captured.native.cases.find(row => row.name === 'http-copy');
    assert.equal(direct.headers['content-type'], nativeDirect.mime);
    await comparePayload(label + '-progressive', direct.raw, nativeDirect);
    const query = `MediaSourceId=${id}&AudioCodec=copy&SegmentContainer=mp4&SegmentLength=3&DeviceId=flac-copy-device&PlaySessionId=${label}`;
    const master = await request(`/Audio/${id}/master.m3u8?${query}`); assert.equal(master.status, 200);
    assert.ok(master.raw.toString().includes(`CODECS="${captured.native.cases.find(row => row.name === 'hls-copy').manifestAudioCodec}"`));
    const mainRoute = `/Audio/${id}/main.m3u8?${query}`, main = await request(mainRoute); assert.equal(main.status, 200);
    const text = main.raw.toString(), initialization = /#EXT-X-MAP:URI="([^"]+)"/u.exec(text)?.[1]; assert.ok(initialization);
    const parts = [initialization, ...text.split(/\r?\n/u).filter(line => line && !line.startsWith('#'))], payloads = [];
    for (const part of parts) {
      const url = new URL(part, origin + mainRoute), response = await request(url.pathname + url.search);
      assert.equal(response.status, 200); payloads.push(response.raw);
    }
    await comparePayload(label + '-hls', Buffer.concat(payloads), captured.native.cases.find(row => row.name === 'hls-copy'));
    const stop = await request(`/Videos/ActiveEncodings?deviceId=flac-copy-device&playSessionId=${label}`, { method: 'DELETE' }); assert.equal(stop.status, 204);
    await releasedLeases(); await removedHlsCaches();
  };
  try {
    database = await createPostgresTestDatabase(null, 'flac_copy_current'); await create(); token = (await runtime.apiKeys.create('Existing FLAC copy')).AccessToken;
    const playbackUser = await runtime.users.createUser({ Name: 'Original FLAC playback' }); userId = playbackUser.Id;
    report.playbackUser = { Id: userId, Policy: playbackUser.Policy };
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', MediaType: 'Audio',
      Name: 'IETF mono FLAC original', SortName: 'ietf mono flac original', Path: media, IsFolder: false }));
    report.actualProbeRefresh = await runtime.probe.refresh(id, { force: true, signal: t.signal });
    report.warmStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    assert.ok(report.warmStreams.some(stream => stream.Codec === 'flac' && stream.Channels === 1));
    await positive('warm');
    const differentSampleRate = report.warmStreams.find(stream => stream.Codec === 'flac').SampleRate === 8000 ? 16000 : 8000;
    for (const parameters of ['AudioCodec=aac', 'AllowAudioStreamCopy=false', 'AudioChannels=2', `AudioSampleRate=${differentSampleRate}`]) {
      const before = report.readers.length, response = await request(`/Audio/${id}/stream.mp4?${parameters}`);
      assert.equal(response.status, 400, parameters); assert.equal(report.readers.length, before, 'A rejected transform never opens the original reader.');
    }
    assert.equal((await request(`/Audio/${id}/master.m3u8?MediaSourceId=${id}&SegmentContainer=ts&AudioCodec=copy`)).status, 400);
    const orderedProfile = await request(`/Items/${id}/PlaybackInfo`, { method: 'POST', body: { UserId: userId, DeviceProfile: {
      MaxStreamingBitrate: 1000000000, DirectPlayProfiles: [{ Type: 'Audio', Container: 'ts', AudioCodec: 'flac' }, { Type: 'Audio', Container: 'mp4', AudioCodec: 'flac' }], TranscodingProfiles: [] } } });
    assert.equal(orderedProfile.status, 200); assert.equal(JSON.parse(orderedProfile.raw).MediaSources[0].SupportsTranscoding, false);
    for (const sample of profile.cases.filter(value => ['different-codec', 'bitrate-limit'].includes(value.name))) {
      const selection = await request(`/Items/${id}/PlaybackInfo`, { method: 'POST', body: { UserId: userId, DeviceProfile: {
        MaxStreamingBitrate: sample.maxBitrate, DirectPlayProfiles: [{ Type: 'Audio', Container: sample.container, AudioCodec: sample.codec }], TranscodingProfiles: [] } } });
      assert.equal(selection.status, 200); assert.equal(JSON.parse(selection.raw).MediaSources[0].SupportsTranscoding,
        captured.native.cases.find(value => value.name === sample.name).accepted, sample.name + ': complete Native copy admission');
    }
    report.warmItems = await database.rows('BaseItems', { where: { Id } });
    report.warmStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    const schema = database.schemaName; report.postgresSchemas = [database.schemaName, database.controlSchema]; await close();
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create();
    report.coldStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } }); assert.deepEqual(report.coldStreams, report.warmStreams);
    report.coldItems = await database.rows('BaseItems', { where: { Id } }); assert.deepEqual(report.coldItems, report.warmItems);
    await positive('cold');
    await fs.rename(media, media + '.held');
    try { const response = await request(`/Audio/${id}/stream.mp4?AudioCodec=copy`); report.actualMissingInput = response; assert.equal(response.status, 404); }
    finally { await fs.rename(media + '.held', media); }
    gate = { opened: Promise.withResolvers(), closed: Promise.withResolvers(), release: Promise.withResolvers() };
    stopping = Promise.allSettled([request(`/Audio/${id}/hls1/main/-1.mp4?MediaSourceId=${id}&AudioCodec=copy&SegmentContainer=mp4&SegmentLength=3&DeviceId=flac-copy-device&PlaySessionId=held-hls&runtimeTicks=0&actualSegmentLengthTicks=0`, {
      signal: AbortSignal.any([t.signal, clientCancellation.signal]),
    })]);
    await Promise.race([gate.opened.promise, delay(10000).then(() => { throw new Error('The actual HLS FLAC reader did not open.'); })]);
    const stopped = await request('/Videos/ActiveEncodings?deviceId=flac-copy-device&playSessionId=held-hls', { method: 'DELETE' }); assert.equal(stopped.status, 204);
    report.heldHlsResponse = (await stopping).map(result => result.status === 'rejected' ? { status: result.status, reason: errorValue(result.reason) } : result);
    assert.ok(report.heldHlsResponse.every(result => result.status === 'rejected' || result.value.status >= 400), 'Stopping the blocked input cannot return a successful fragment.');
    await Promise.race([gate.closed.promise, delay(10000).then(() => { throw new Error('Stopping HLS did not close its actual FLAC reader.'); })]);
    gate = undefined; await releasedLeases(); await removedHlsCaches();
    gate = { opened: Promise.withResolvers(), closed: Promise.withResolvers(), release: Promise.withResolvers() };
    cancellation = new AbortController();
    cancelled = assert.rejects(request(`/Audio/${id}/stream.mp4?AudioCodec=copy`, { signal: cancellation.signal }), { name: 'AbortError' });
    cancelled.catch(() => {}); // The fixture awaits and reports this assertion during ordinary and failing cleanup.
    await Promise.race([gate.opened.promise, delay(10000).then(() => { throw new Error('The actual FLAC reader did not open.'); })]);
    cancellation.abort(); await cancelled;
    await Promise.race([gate.closed.promise, delay(10000).then(() => { throw new Error('The actual FLAC reader did not close.'); })]);
    gate = undefined;
    await runtime.remux.close(); await releasedLeases();
    await close();
    assert.ok(report.readers.every(reader => reader.closed), 'All actual Local original readers closed.');
    assert.deepEqual(await fs.readFile(media), originalBytes); assert.equal(hash(await fs.readFile(captured.assetPath)), profile.asset.sha256);
    report.componentAcceptance = true;
  } catch (error) { report.failures.push(errorValue(error)); }
  finally {
    clientCancellation.abort(); cancellation?.abort();
    try { await close(); } catch (error) { report.failures.push(errorValue(error)); }
    for (const result of await Promise.allSettled([stopping, cancelled])) if (result.status === 'rejected') report.failures.push(errorValue(result.reason));
    if (database) try { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresSchemasRemoved: true }); } catch (error) { report.failures.push(errorValue(error)); }
    try {
      const mediaPids = () => [...new Set([...report.mediaCommands.map(command => command.pid), ...report.processes.map(command => command.pid),
        ...report.probes.map(row => row.probe.pid)].filter(pid => pid != null))];
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline && (report.mediaCommands.some(command => !command.closed) || mediaPids().some(alive))) await delay(20);
      report.processesAfterClose = mediaPids().map(pid => ({ pid, alive: alive(pid) }));
      assert.ok(report.mediaCommands.every(command => command.closed), 'Every actual original-media child must emit close, including cancellation.');
      assert.ok(report.processesAfterClose.every(process => !process.alive), 'Original copy/version/probe processes must actually exit.');
      for (const process of report.processes) assert.ok(report.mediaCommands.some(command => command.pid === process.pid
        && command.tool === 'ffmpeg' && command.closed), 'Every remux/HLS process is the observed original FFmpeg child.');
      for (const row of report.probes) assert.ok(report.mediaCommands.some(command => command.pid === row.probe.pid
        && command.tool === 'ffprobe' && command.closed), 'Every packet comparison probe is an observed, closed original FFprobe child.');
      assert.ok(report.mediaCommands.some(command => command.tool === 'ffmpeg' && command.arguments.length === 1
        && command.arguments[0] === '-version'), 'The actual startup encoder was observed.');
      assert.ok(report.mediaCommands.some(command => command.tool === 'ffprobe' && command.arguments.includes('-i')),
        'The actual current-media probe was observed.');
      for (const command of report.mediaCommands) {
        assert.ok(command.spawned && command.pid != null, 'Each observed media command actually started.');
        assert.deepEqual(command.errors, [], 'Original-media process errors must remain visible.');
        const args = command.arguments;
        if (command.tool === 'ffprobe') {
          assert.ok(args.includes('-show_streams') && args.includes('-show_format') && !args.includes('-show_frames'),
            'FFprobe only inspects the original streams and packets.');
          command.admission = 'probe';
        } else if (args.length === 1 && args[0] === '-version') command.admission = 'version';
        else {
          const codecFlags = args.flatMap((value, index) => /^-(?:c|codec)(?::|$)|^-(?:acodec|vcodec|scodec)$/u.test(value) ? [index] : []);
          assert.ok(codecFlags.length && codecFlags.every(index => args[index + 1] === 'copy'), 'Every actual FFmpeg output codec is explicit packet copy.');
          assert.ok(!args.some(value => ['lavfi', '-init_hw_device', '-vf', '-af', '-ac', '-show_frames'].includes(value)
            || value.startsWith('-hwaccel') || value.startsWith('-filter') || value.startsWith('nullsrc')), 'No actual AV generation, filters or hardware path executes.');
          command.admission = 'copy';
        }
      }
    } catch (error) { report.failures.push(errorValue(error)); }
    finally { unsubscribe(processChannel, observeMediaProcess); }
    report.originalSourceAfter = hash(await fs.readFile(captured.assetPath));
    if (report.failures.length) report.componentAcceptance = false;
    await fs.writeFile(path.join(output, 'report.json'), filterEvidenceJson(report,
      new Set([token, postgresTestConnectionString].filter(Boolean))), { flag: 'wx' });
  }
  if (report.failures.length) throw new AggregateError(report.failures, 'Existing FLAC copy or actual resource cleanup failed.', { cause: report.failures[0] });
});
