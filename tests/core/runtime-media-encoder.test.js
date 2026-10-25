import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { validationExecutable, validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { mediaEncoderInput } from '../playback/fixtures/media-encoder-current/input.js';

export const requiredValidationServices = ['postgres'];
const input = mediaEncoderInput();
const failureValue = error => error == null || typeof error !== 'object' ? error : Array.isArray(error) ? error.map(failureValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), ...(error instanceof Error ? ['message', 'name', 'code', 'status', 'statusCode', 'stack', 'cause', 'errors'] : [])])]
    .map(key => [key, failureValue(error[key])]));
const json = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n';

test('postgres: one startup encoder persists Display and reaches real Local probe, subtitle HTTP, current named POST and cold startup', {
  skip: !postgresTestConnectionString, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'runtime-media-encoder-')); assertValidationOutputChild(root);
  const programDataPath = path.join(root, 'data'), configurationDirectoryPath = path.join(root, 'config'); await fs.mkdir(configurationDirectoryPath);
  const filename = path.join(configurationDirectoryPath, 'encoding.xml'), selected = validationExecutable('ffmpeg');
  await writeConfigurationFile(filename, 'encoding', { ...defaultConfiguration('encoding'), EncoderAppPath: path.join(root, 'missing-xml-choice'),
    EncoderAppPathDisplay: 'Before startup', EncodingThreadCount: 2 });
  const source = Buffer.from(input.source.media, 'base64'), media = path.join(root, 'media.mkv'); await fs.writeFile(media, source);
  const Id = 'F8420000-0000-0000-0000-000000000001', id = Id.replaceAll('-', '').toLowerCase();
  const report = { schemaVersion: 1, scope: 'Formal runtime startup, actual XML, PostgreSQL media rows, Local original input, real subtitle HTTP and cold reopen.',
    actualNativeExecuted: false, nativeEvidence: 'tests/playback/media-encoder-current-native.test.js', http: [], probes: [], errors: [], startupDiagnostics: [],
    phaseAcceptance: false, releaseAcceptance: false, cleanup: {} };
  const failures = []; let database, runtime, storage, origin, token;
  const create = async () => {
    runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath,
      networkConfiguration: { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true },
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, serverId: 'runtime-media-encoder',
      vfs: storage.fileSystem.vfs, identityMap: storage.fileSystem.identityMap, mediaEncoderOptions: { startupFFmpegPath: selected },
      onError: error => report.errors.push(failureValue(error)) });
    const actualProbe = runtime.probe.probe.bind(runtime.probe);
    runtime.probe.probe = async (bridge, virtualPath, options) => {
      const observation = { phase: 'actual-runtime-probe', virtualPath, executable: options.executable, threads: options.threads }; report.probes.push(observation);
      try { const result = await actualProbe(bridge, virtualPath, options); observation.result = result; return result; }
      catch (error) { observation.error = failureValue(error); throw error; }
    };
    await runtime.start();
    origin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
  };
  const call = async (route, body) => {
    const observation = { route, method: body === undefined ? 'GET' : 'POST', requestBody: body === undefined ? null : json(body) }; report.http.push(observation);
    const response = await fetch(origin + route, { method: observation.method, signal: t.signal,
      headers: { 'X-Emby-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: observation.requestBody }) });
    const bytes = Buffer.from(await response.arrayBuffer()); Object.assign(observation, { status: response.status,
      headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64'), text: bytes.toString() });
    if (response.headers.get('content-type')?.includes('json') && bytes.length) observation.value = JSON.parse(bytes.toString());
    assert.equal(response.status, body === undefined ? 200 : 204, route + ': ' + observation.text); return observation;
  };
  try {
    storage = await localStateStorage(root); database = await createPostgresTestDatabase(null, 'encoder_runtime'); await create();
    token = (await runtime.apiKeys.create('Media encoder runtime')).AccessToken;
    let encoding = (await call('/System/Configuration/encoding')).value;
    assert.equal(encoding.EncoderAppPathDisplay, selected); assert.equal(encoding.EncoderAppPath, path.join(root, 'missing-xml-choice'));
    report.initialXml = (await fs.readFile(filename)).toString('base64'); assert.equal(parseConfigurationXml(await fs.readFile(filename), 'encoding').EncoderAppPathDisplay, selected);
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', MediaType: 'Video',
      Name: 'Original subtitle container', SortName: 'original subtitle container', CleanName: 'original subtitle container', Path: media, IsFolder: false,
      Data: '{"UnknownExtension":{"preserve":true}}' }));
    report.firstProbe = await runtime.probe.refresh(id, { force: true, signal: t.signal }); assert.equal(report.firstProbe.changed, true);
    report.mediaRows = await database.rows('BaseItems', { where: { Id } }); report.streams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    assert.ok(report.streams.some(stream => stream.Codec === 'pcm_s16le')); assert.ok(report.streams.some(stream => stream.Codec === 'subrip'));
    const firstSubtitle = await call(`/Videos/${id}/${id}/Subtitles/1/Stream.srt`);
    assert.ok(firstSubtitle.bytes.length > 0); assert.equal(firstSubtitle.headers['content-type'].split(';')[0], 'application/x-subrip');
    encoding = { ...encoding, EncoderAppPath: null, EncoderAppPathDisplay: 'Client supplied display', EncodingThreadCount: 7 };
    await call('/System/Configuration/encoding', encoding);
    // Actual named MVC JSON omits this null reference; the typed current and
    // the real XML retain its null value independently of that public wire.
    const expectedEncodingWire = { ...encoding }; delete expectedEncodingWire.EncoderAppPath;
    const hotEncodingWire = (await call('/System/Configuration/encoding')).value;
    assert.deepEqual(hotEncodingWire, expectedEncodingWire);
    assert.equal(Object.hasOwn(hotEncodingWire, 'EncoderAppPath'), false);
    report.hotCurrent = structuredClone(runtime.namedConfiguration.getCurrentConfiguration('encoding'));
    assert.equal(report.hotCurrent.EncoderAppPath, null);
    report.hotXml = (await fs.readFile(filename)).toString('base64');
    assert.equal(parseConfigurationXml(Buffer.from(report.hotXml, 'base64'), 'encoding').EncoderAppPath, null);
    report.hotProbe = await runtime.probe.refresh(id, { force: true, signal: t.signal }); assert.equal(report.hotProbe.changed, true);
    assert.equal((await call(`/Videos/${id}/${id}/Subtitles/1/Stream.srt`)).bytes, firstSubtitle.bytes);
    for (const probe of report.probes) {
      assert.equal(probe.executable, selected.replace(/[^/\\]+?(\.[^/\\\n.]+)?$/u, 'ffprobe$1'));
      assert.equal(probe.threads, Math.min(2, availableParallelism())); assert.equal(probe.error, undefined);
      assert.ok(probe.result.raw.streams.some(stream => stream.codec_name === 'pcm_s16le'));
    }
    assert.deepEqual(await fs.readFile(media), source);
    const savedStreams = await database.rows('MediaStreamInfos', { where: { ItemId: Id } });
    const schema = database.schemaName; await runtime.close(); runtime = undefined; await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create();
    const cold = (await call('/System/Configuration/encoding')).value;
    assert.deepEqual(cold, { ...expectedEncodingWire, EncoderAppPathDisplay: selected });
    report.coldCurrent = structuredClone(runtime.namedConfiguration.getCurrentConfiguration('encoding'));
    assert.equal(report.coldCurrent.EncoderAppPath, null);
    assert.deepEqual(await database.rows('MediaStreamInfos', { where: { ItemId: Id } }), savedStreams);
    assert.equal((await call(`/Videos/${id}/${id}/Subtitles/1/Stream.srt`)).bytes, firstSubtitle.bytes);
    report.cold = cold; report.coldXml = (await fs.readFile(filename)).toString('base64');
    assert.equal(parseConfigurationXml(Buffer.from(report.coldXml, 'base64'), 'encoding').EncoderAppPath, null);
    assert.deepEqual(await fs.readFile(media), source);
    await runtime.close(); runtime = undefined;
    database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); const beforeFailure = await fs.readFile(filename);
    const invalid = path.join(root, 'missing-cli-encoder'); let actualStartupFailure;
    runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath,
      networkConfiguration: { ...defaultConfiguration('network'), InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true },
      configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, serverId: 'runtime-media-encoder',
      vfs: storage.fileSystem.vfs, identityMap: storage.fileSystem.identityMap, mediaEncoderOptions: { startupFFmpegPath: invalid },
      onError: error => report.startupDiagnostics.push(failureValue(error)) });
    await assert.rejects(runtime.start(), error => {
      actualStartupFailure = error; assert.equal(error.message, 'Failed to find valid ffmpeg.'); return true;
    });
    report.startupFailure = failureValue(actualStartupFailure); assert.deepEqual(await fs.readFile(filename), beforeFailure);
    report.failedStartupListeners = runtime.networkHost.listeners.map(entry => ({ scheme: entry.scheme, address: entry.address, port: entry.port, bound: entry.bound, listening: entry.server.listening }));
    assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening));
    await assert.rejects(database.rows('BaseItems'), /closed|not open/iu);
    for (const diagnostic of report.startupDiagnostics) {
      assert.equal(diagnostic.code, 'unavailable'); assert.equal(diagnostic.process.executable, invalid);
      assert.deepEqual(diagnostic.process.args, ['-version']); assert.equal(diagnostic.cause.code, 'ENOENT');
    }
    assert.ok(report.startupDiagnostics.some(diagnostic => diagnostic.process?.executable === invalid));
    assert.deepEqual(report.errors, []); report.componentAcceptance = true;
  } catch (error) { failures.push(error); }
  finally {
    try { await runtime?.close(); report.cleanup.runtimeClosed = runtime ? !runtime.networkHost.listeners.some(entry => entry.server.listening) : null; } catch (error) { failures.push(error); }
    try { await storage?.close(); report.cleanup.storageClosed = true; } catch (error) { failures.push(error); }
    try { await dropPostgresTestDatabase(database); report.cleanup.postgresSchemaRemoved = true; } catch (error) { failures.push(error); }
    try { assert.deepEqual(report.errors, []); } catch (error) { failures.push(error); }
    report.failures = failures.map(failureValue); await fs.writeFile(path.join(root, 'comparison.json'), json(report), { flag: 'wx' });
    t.diagnostic(json({ report: path.join(root, 'comparison.json'), completed: failures.length === 0 }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Runtime media encoder behavior or cleanup failed.', { cause: failures[0] });
});
