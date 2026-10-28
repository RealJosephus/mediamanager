import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../../../src/runtime.js';
import { readInstanceConfiguration } from '../../../src/configuration.js';
import { defaultConfiguration } from '../../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../../src/core/configuration-file.js';
import { parseLosslessJson } from '../../../src/core/json.js';
import { PostgresDatabase } from '../../../src/database/postgres.js';
import { probeStreamRow } from '../../../src/library/probe-service.js';
import { convertSubtitle } from '../../../src/playback/subtitles.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../../database/postgres-fixture.js';
import { localStateStorage } from '../../helpers/local-state-storage.js';
import { subtitleLayoutProjection } from '../layout-projection.js';
import { filterEvidenceJson } from '../../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../../tools/validation/paths.js';
import { captureSubtitleText, subtitleSourceBytes, hash, errorValue } from '../fixtures/subtitle-text-current/capture.js';
import media from '../fixtures/hls-reference.json' with { type: 'json' };

const cues = text => {
  const value = parseLosslessJson(text);
  return { ...value, TrackEvents: value.TrackEvents.map(cue => ({ ...cue, Text: cue.Text.split(/\r\n|\r|\n/u) })) };
};

export async function runSubtitleTextScenario(t, { prefix, scenarios, fixtureFiles = [],
  generatedBodyProjection = subtitleLayoutProjection,
  readGeneratedBody = (text, format) => convertSubtitle(text, format, 'json', { copyTimestamps: true }),
}) {
  const output = path.join(validationOutputRoot(), prefix + '-' + randomUUID()); await fs.mkdir(output);
  const inputDirectory = path.join(output, 'inputs'); await fs.mkdir(inputDirectory);
  const config = path.join(output, 'config'); await fs.mkdir(config);
  await writeConfigurationFile(path.join(config, 'system.xml'), 'server', { ...defaultConfiguration('server'), IsStartupWizardCompleted: true });
  await writeConfigurationFile(path.join(config, 'network.xml'), 'network', { ...defaultConfiguration('network'), InternalHttpPort: 0,
    LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true });
  const sourceMedia = path.join(output, 'source.mkv'); await fs.writeFile(sourceMedia, Buffer.from(media.media, 'base64'), { flag: 'wx' });
  const sources = new Map();
  for (const [index, source] of scenarios.sources.entries()) {
    const filename = path.join(inputDirectory, source.name + '.' + source.format), bytes = subtitleSourceBytes(source);
    await fs.writeFile(filename, bytes, { flag: 'wx' });
    sources.set(source.name, { ...source, filename, index: index + 1, bytes: bytes.length, sha256: hash(bytes) });
  }
  const report = { schemaVersion: 1, scope: 'Actual current Native text conversion and public Node Local/PostgreSQL subtitle consumers; no AV generation or rendering.',
    inputs: [...sources.values()].map(({ text, ...source }) => source), conversions: [], originals: [], readers: [], mediaProcesses: [], diagnostics: [], cleanup: [], failures: [],
    componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  const Id = 'F8600000-0000-0000-0000-000000000001', id = Id.replaceAll('-', '').toLowerCase();
  const failures = [], recordFailure = error => { failures.push(error); report.failures.push(errorValue(error)); };
  const atBoundary = async (operation, message) => {
    const deadline = new AbortController();
    try {
      return await Promise.race([operation, delay(10000, undefined, { ref: false, signal: AbortSignal.any([t.signal, deadline.signal]) })
        .then(() => { throw new Error(message); })]);
    } finally { deadline.abort(); }
  };
  const assertPublicFailure = (observation, native) => {
    assert.equal(observation.status, native.wire.status, observation.name + ': actual Native public error status');
    assert.equal(observation.headers['content-type'], native.wire.contentType, observation.name + ': actual Native public error MIME');
    assert.equal(observation.bytes, native.wire.bytes, observation.name + ': actual Native public error body');
  };
  let database, runtime, storage, origin, token, generation = 0, gate, pendingRequest, cancellation;
  const create = async () => {
    generation++;
    storage = await localStateStorage(output);
    const adapter = storage.fileSystem.vfs.resolve('/state/inputs').adapter, openRead = adapter.openRead.bind(adapter);
    adapter.openRead = async (location, options = {}) => {
      const handle = await openRead(location, options);
      if (!location.startsWith('/inputs/')) return handle;
      const reader = { generation, location, closed: false }; report.readers.push(reader);
      const selected = gate;
      if (selected) {
        Object.assign(reader, { bytesRead: 0, readCompleted: false }); selected.reader = reader;
      }
      return { ...handle, stream: (async function* () {
        if (selected) {
          const aborted = Promise.withResolvers(), abort = () => {
            reader.abortReason = errorValue(options.signal.reason); selected.ownerAborted.resolve(reader.abortReason);
            aborted.reject(options.signal.reason);
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          try {
            options.signal?.throwIfAborted(); selected.opened.resolve();
            await Promise.race([selected.release.promise, aborted.promise]); options.signal?.throwIfAborted();
          }
          finally { options.signal?.removeEventListener('abort', abort); }
        }
        const digest = selected && createHash('sha256');
        for await (const bytes of handle.stream) {
          if (selected) { reader.bytesRead += bytes.length; digest.update(bytes); }
          yield bytes;
        }
        if (selected) { reader.sha256 = digest.digest('hex'); reader.readCompleted = true; }
      })(), close: async () => {
        try { await handle.close(); reader.closed = true; }
        catch (error) { reader.closeError = errorValue(error); throw error; }
        finally { selected?.closed.resolve(); selected?.release.resolve(); }
      } };
    };
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(output), vfs: storage.fileSystem.vfs,
      identityMap: storage.fileSystem.identityMap, autoDiscoveryOptions: { enabled: false },
      extractionOptions: { onProcess: process => report.mediaProcesses.push({ generation, kind: 'extraction', ...process }) },
      remuxOptions: { onProcess: process => report.mediaProcesses.push({ generation, kind: 'remux', ...process }) },
      hlsOptions: { onProcess: process => report.mediaProcesses.push({ generation, kind: 'hls', ...process }) },
      onError: error => report.diagnostics.push(errorValue(error)) });
    await runtime.start();
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port;
    for (const listener of runtime.networkHost.listeners) listener.server.on('request', (incoming, response) => {
      const selected = gate;
      if (selected && incoming.method === 'GET' && incoming.url === selected.route) response.once('close', () => selected.publicClosed.resolve({
        generation, method: incoming.method, route: incoming.url, writableFinished: response.writableFinished,
      }));
    });
  };
  const close = async () => {
    gate?.release.resolve(); gate = undefined;
    const errors = [], selectedRuntime = runtime, selectedStorage = storage; runtime = undefined; storage = undefined;
    if (selectedRuntime) try {
      await selectedRuntime.close(); const listenersClosed = selectedRuntime.networkHost.listeners.every(listener => !listener.server.listening);
      report.cleanup.push({ generation, runtimeClosed: true, listenersClosed }); assert.ok(listenersClosed);
    } catch (error) { errors.push(error); }
    if (selectedStorage) try { await selectedStorage.close(); report.cleanup.push({ generation, storageClosed: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Subtitle runtime and storage cleanup failed.', { cause: errors[0] });
  };
  const route = (source, format, settings = {}) => `/Videos/${id}/${id}/Subtitles/${source.index}/Stream.${format}`
    + `?startPositionTicks=${settings.start ?? '0'}&endPositionTicks=${settings.end ?? '0'}&copyTimestamps=${settings.copy ?? true}`;
  const request = async (name, source, format, settings, signal = t.signal) => {
    const observation = { generation, name, source: source.name, format, route: route(source, format, settings) };
    try {
      const response = await fetch(origin + observation.route, { signal, headers: { 'X-Emby-Token': token } });
      const bytes = Buffer.from(await response.arrayBuffer());
      Object.assign(observation, { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64'), sha256: hash(bytes) });
      const length = response.headers.get('content-length');
      if (length != null) assert.equal(Number(length), bytes.length, name + ': actual public Content-Length');
    } catch (error) { observation.error = errorValue(error); throw Object.assign(error, { subtitleObservation: observation }); }
    return observation;
  };
  const collect = async () => {
    for (const sample of scenarios.conversions) report.conversions.push(await request(sample.name, sources.get(sample.source), sample.format, sample));
    for (const source of sources.values()) {
      for (const format of source.format === 'ssa' ? ['ssa', 'ass'] : [source.format]) {
        report.originals.push(await request(source.name, source, format));
      }
    }
  };
  try {
    database = await createPostgresTestDatabase(null, 'subtitle_text'); await create();
    token = (await runtime.apiKeys.create('Current subtitle text consumer')).AccessToken;
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video',
      Name: 'Current subtitle text inputs', SortName: 'current subtitle text inputs', Path: sourceMedia, IsFolder: false,
      RunTimeTicks: 120000000n }));
    for (const source of sources.values()) await database.insert('MediaStreamInfos', probeStreamRow(Id, { Type: 'Subtitle', Index: source.index,
      Codec: source.format, Language: 'eng', IsExternal: true, IsTextSubtitleStream: true, SupportsExternalStream: true, Path: source.filename }));
    const beforeAnonymous = report.readers.length;
    const anonymous = await fetch(origin + route(sources.values().next().value, 'vtt'), { signal: t.signal });
    report.anonymousStatus = anonymous.status; await anonymous.arrayBuffer(); assert.equal(anonymous.status, 401);
    assert.equal(report.readers.length, beforeAnonymous, 'Unauthorized text delivery does not open the Local source.');
    await collect();
    report.warmItems = await database.rows('BaseItems', { where: { Id } });
    report.warmStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    const schema = database.schemaName; report.postgresSchemas = [database.schemaName, database.controlSchema]; await close();
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create();
    report.coldItems = await database.rows('BaseItems', { where: { Id } });
    report.coldStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    assert.deepEqual(report.coldItems, report.warmItems); assert.deepEqual(report.coldStreams, report.warmStreams);
    await collect();
    const reference = report.conversions.find(observation => observation.generation === generation);
    assert.ok(reference, 'The declared comparison matrix has a complete cold public response.');
    const sample = scenarios.conversions.find(sample => sample.name === reference.name), source = sources.get(sample.source);
    const heldFormat = sample.format, heldRoute = route(source, heldFormat, sample);
    assert.equal(reference.route, heldRoute, 'The held reader uses the actual declared conversion, source and playback window.');
    const hold = () => ({ route: heldRoute, opened: Promise.withResolvers(), closed: Promise.withResolvers(),
      release: Promise.withResolvers(), publicClosed: Promise.withResolvers(), ownerAborted: Promise.withResolvers() });
    gate = hold();
    cancellation = new AbortController();
    pendingRequest = request('actual-controller-disconnect', source, heldFormat, sample, AbortSignal.any([t.signal, cancellation.signal]));
    pendingRequest.catch(() => {});
    await atBoundary(gate.opened.promise, 'The actual Local subtitle reader did not open.');
    const disconnectReason = Object.assign(new Error('The controlled subtitle HTTP client disconnected.'), { code: 'subtitle-client-disconnect' });
    cancellation.abort(disconnectReason);
    await assert.rejects(pendingRequest, error => {
      report.cancelled = errorValue(error);
      assert.equal(error.code, disconnectReason.code); assert.equal(error.message, disconnectReason.message); return true;
    });
    assert.equal(cancellation.signal.aborted, true);
    report.clientDisconnect = { boundary: 'The formatted Controller uses CancellationToken.None; release the held actual source only after the public response closes.',
      referenceName: reference.name, reader: gate.reader,
      publicDisconnect: await atBoundary(gate.publicClosed.promise, 'The actual subtitle HTTP response did not close after its client disconnected.') };
    gate.release.resolve();
    await atBoundary(gate.closed.promise, 'The detached subtitle producer did not close its actual Local reader after source release.');
    assert.equal(gate.reader.closed, true); assert.equal(gate.reader.readCompleted, true);
    assert.equal(gate.reader.bytesRead, source.bytes); assert.equal(gate.reader.sha256, source.sha256);
    await atBoundary(runtime.playback.drainSubtitlePreparations(), 'The detached subtitle producer did not finish after its actual reader closed.');
    await atBoundary(runtime.drainRequests(), 'The detached subtitle HTTP action did not finish.');
    report.clientDisconnect.producerDrained = true;
    gate = undefined; pendingRequest = undefined; cancellation = undefined;
    report.clientDisconnect.readback = await request('after-controller-disconnect', source, heldFormat, sample);
    const publicValue = value => ({ status: value.status, contentType: value.headers['content-type'], bytes: value.bytes, sha256: value.sha256 });
    assert.deepEqual(publicValue(report.clientDisconnect.readback), publicValue(reference), 'Complete cold HTTP delivery after the detached producer drains.');
    gate = hold();
    pendingRequest = request('actual-runtime-owner-cancellation', source, heldFormat, sample); pendingRequest.catch(() => {});
    await atBoundary(gate.opened.promise, 'The shutdown preparation did not open its actual Local subtitle reader.');
    report.shutdown = { boundary: 'Actual Node runtime.close cancels its admitted subtitle owner while the Local source remains held.', reader: gate.reader };
    const shutdown = runtime.close(); shutdown.catch(() => {});
    report.shutdown.ownerAbort = await atBoundary(gate.ownerAborted.promise, 'Runtime close did not cancel its actual held subtitle source.');
    assert.equal(report.shutdown.ownerAbort.code, 'closed');
    await atBoundary(gate.closed.promise, 'Runtime close did not settle its actual Local subtitle reader close.');
    assert.equal(gate.reader.closed, true);
    report.shutdown.publicDisconnect = await atBoundary(gate.publicClosed.promise, 'Runtime close did not close the admitted subtitle HTTP response.');
    await shutdown; report.shutdown.runtimeClosed = true;
    await assert.rejects(pendingRequest, error => { report.shutdown.clientError = errorValue(error); return true; });
    await close(); gate = undefined; pendingRequest = undefined;
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    const captured = await captureSubtitleText(output, scenarios, report.conversions.map(({ name, generation, format, bytes, status }) => ({ name, generation, format, bytes, status })), { signal: t.signal, fixtureFiles });
    report.native = captured.report.captures;
    const expected = new Map(captured.first.conversions.map(row => [row.name, row]));
    const nativeReads = new Map(captured.first.candidateReaders.map(row => [`${row.generation}:${row.name}`, row]));
    for (const observation of report.conversions) {
      const sample = scenarios.conversions.find(sample => sample.name === observation.name), source = sources.get(sample.source), native = expected.get(observation.name);
      if (native.error) {
        assertPublicFailure(observation, native);
        assert.equal(nativeReads.get(`${observation.generation}:${observation.name}`).textConsumerApplicable, false, 'A public error body is not a subtitle input.');
        continue;
      }
      assert.equal(observation.status, 200, observation.name + ': public HTTP conversion');
      assert.equal(observation.headers['content-type'], native.contentType, observation.name + ': public MIME');
      const bytes = Buffer.from(observation.bytes, 'base64'), text = bytes.toString('utf8');
      if (source.format === sample.format) assert.equal(observation.bytes, native.bytes, observation.name + ': original format bytes');
      else if (sample.format === 'json') assert.deepEqual(cues(text), cues(native.text), observation.name + ': complete cue text, timing and markup');
      else assert.deepEqual(generatedBodyProjection(text, sample.format), generatedBodyProjection(native.text, sample.format), observation.name + ': complete generated subtitle lines');
      const read = nativeReads.get(`${observation.generation}:${observation.name}`);
      const nativeReaderFailed = sample.format === 'json' ? false : Boolean(native.readerError);
      assert.equal(Boolean(read.error), nativeReaderFailed, observation.name + ': actual Native reader outcome');
      if (!read.error) {
        const baseline = sample.format === 'json' ? native.text : native.readerJson;
        assert.deepEqual(cues(read.readerJson), cues(baseline), observation.name + ': actual Native reads of delivered bytes');
        if (sample.format !== 'json') assert.deepEqual(cues(readGeneratedBody(native.text, sample.format)), cues(native.readerJson),
          observation.name + ': Node reads the actual Native writer output');
      }
    }
    for (const observation of report.originals) {
      const native = captured.first.originals.find(row => row.name === observation.name && row.format === observation.format);
      if (native.error) { assertPublicFailure(observation, native); continue; }
      assert.equal(observation.status, 200);
      assert.equal(observation.bytes, native.bytes, observation.name + ': actual Native original-format delivery');
    }
    assert.ok(report.readers.every(reader => reader.closed), 'All actual Local subtitle readers closed.');
    assert.deepEqual(report.mediaProcesses, [], 'Text delivery does not start extraction or AV processing.');
    report.sourceAfter = await Promise.all([...sources.values()].map(async source => ({ name: source.name, sha256: hash(await fs.readFile(source.filename)) })));
    for (const source of report.sourceAfter) assert.equal(source.sha256, sources.get(source.name).sha256, source.name);
    assert.equal(hash(await fs.readFile(sourceMedia)), hash(Buffer.from(media.media, 'base64')));
    report.componentAcceptance = true;
  } catch (error) { recordFailure(error); }
  finally {
    cancellation?.abort();
    try { await close(); } catch (error) { recordFailure(error); }
    if (pendingRequest) await pendingRequest.catch(() => {});
    if (database) try { await dropPostgresTestDatabase(database); report.cleanup.push({ postgresSchemasRemoved: true }); } catch (error) { recordFailure(error); }
    if (report.failures.length) report.componentAcceptance = false;
    try { await fs.writeFile(path.join(output, 'node-report.json'), filterEvidenceJson(report,
      new Set([token, postgresTestConnectionString].filter(Boolean))), { flag: 'wx' }); }
    catch (error) { throw new AggregateError([...failures, error], 'Subtitle execution or observation persistence failed.', { cause: failures[0] ?? error }); }
  }
  if (failures.length) throw new AggregateError(failures, 'Current subtitle text conversion or resource cleanup failed.', { cause: failures[0] });
}
