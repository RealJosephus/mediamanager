import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
      const selected = gate; selected?.opened.resolve();
      return { ...handle, stream: (async function* () {
        if (selected) {
          const aborted = Promise.withResolvers(), abort = () => aborted.reject(options.signal.reason);
          options.signal?.addEventListener('abort', abort, { once: true });
          try { options.signal?.throwIfAborted(); await Promise.race([selected.release.promise, aborted.promise]); options.signal?.throwIfAborted(); }
          finally { options.signal?.removeEventListener('abort', abort); }
        }
        yield* handle.stream;
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
    gate = { opened: Promise.withResolvers(), closed: Promise.withResolvers(), release: Promise.withResolvers() };
    cancellation = new AbortController();
    pendingRequest = request('actual-reader-cancellation', sources.values().next().value, 'vtt', {}, AbortSignal.any([t.signal, cancellation.signal]));
    pendingRequest.catch(() => {});
    await Promise.race([gate.opened.promise, delay(10000, undefined, { ref: false }).then(() => { throw new Error('The actual Local subtitle reader did not open.'); })]);
    cancellation.abort();
    await assert.rejects(pendingRequest, error => { report.cancelled = errorValue(error); return error.name === 'AbortError'; });
    await Promise.race([gate.closed.promise, delay(10000, undefined, { ref: false }).then(() => { throw new Error('Cancelling the public subtitle request did not close its actual Local reader.'); })]);
    gate = undefined; await close();
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
