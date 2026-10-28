import test from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { copyFile, chmod, stat, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { validationExecutable } from '../../tools/validation/paths.js';
import { MediaEncoder, readMediaEncoderStartupOptions, getEncodingThreadCount } from '../../src/playback/media-encoder.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration, readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { probeRaw } from '../../src/storage/ffprobe.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { ExtractionService } from '../../src/playback/extraction.js';
import { HlsService, hlsArguments, hlsPlan } from '../../src/playback/hls.js';
import { RemuxService } from '../../src/playback/remux.js';
import { PlaybackService } from '../../src/playback/service.js';
import { createTestApplication } from '../helpers/application.js';
import { bindStreaming } from '../../src/http/playback-routes.js';
import { HttpResult } from '../../src/http/binding.js';
import { extractionFixture } from './extraction-fixture.js';
import { currentMediaEncoder, encoderInput, encoderHash, encoderFailure, encoderFailurePayload, encoderJson } from './media-encoder-current.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const suffix = process.platform === 'win32' ? '.exe' : '';
const payload = value => JSON.parse(encoderJson(value));
const localThreads = (value, count) => value <= 0 ? 0 : Math.min(value, count);
const wireValue = value => ({ status: value.status, contentType: value.contentType ?? null, bytes: value.bytes });
const selectedFlag = (args, flag) => args[args.indexOf(flag) + 1];
const threadFlag = args => Number(selectedFlag(args, '-threads'));
const copyTrace = trace => trace.forwarded && trace.arguments.includes('-hls_segment_type');

async function releasedEndpoint(port) {
  const refusal = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('The closed listener connection did not finish.')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('The closed listener still accepts connections.')); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve(encoderFailure(error)) : reject(error); });
  });
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const rebound = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { refusal, rebound, released: true };
}

async function closeApplication(application) {
  if (!application) return null;
  const endpoint = application.server.address(), errors = [];
  const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
  await attempt(() => application.beginClose());
  await attempt(() => application.webSockets?.close());
  await attempt(() => application.drainRequests());
  await attempt(() => application.server.listening && new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())));
  let released;
  if (endpoint) await attempt(async () => { released = await releasedEndpoint(endpoint.port); });
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'HTTP component cleanup failed.', { cause: errors[0] });
  return released;
}

async function inspectFirstFragment(root, name, initialization, segment) {
  const filename = path.join(root, name + '.mp4'); await writeFile(filename, Buffer.concat([Buffer.from(initialization, 'base64'), Buffer.from(segment, 'base64')]), { flag: 'wx' });
  const executable = validationExecutable('ffprobe');
  const args = ['-v', 'error', '-show_format', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', filename];
  const run = spawnSync(executable, args, { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000 });
  const raw = { filename, args, pid: run.pid, status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr,
    error: run.error && encoderFailure(run.error) };
  await writeFile(path.join(root, name + '-probe.json'), encoderJson(raw), { flag: 'wx' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.signal, null); assert.equal(run.error, undefined);
  const parsed = JSON.parse(run.stdout);
  return { raw, complete: parsed, packets: parsed.packets.map(packet => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags']
    .filter(key => packet[key] != null).map(key => [key, packet[key]]))),
    streams: parsed.streams.map(stream => Object.fromEntries(['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels']
      .filter(key => stream[key] != null).map(key => [key, stream[key]]))) };
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const child of await files(filename)) result.push({ ...child, name: entry.name + '/' + child.name });
    else result.push({ name: entry.name, bytes: (await readFile(filename)).toString('base64') });
  }
  return result;
}
async function traces(directory) {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).sort().map(async name => ({ filename: name, ...JSON.parse(await readFile(path.join(directory, name), 'utf8')) })));
}
async function executable(launcher, filename) { await copyFile(launcher, filename); if (process.platform !== 'win32') await chmod(filename, (await stat(launcher)).mode); }
function disk(filename) {
  try {
    if (statSync(filename).isDirectory()) return { directory: true, bytes: null, value: null, error: null };
    const bytes = readFileSync(filename); return { directory: false, bytes: bytes.toString('base64'), value: readConfigurationDocument(bytes, 'encoding').value, error: null };
  } catch (error) { if (error.code === 'ENOENT') return { directory: false, bytes: null, value: null, error: null }; return { directory: false, bytes: null, value: null, error: encoderFailure(error) }; }
}
function normalizeState(value, row) {
  const pathValue = value => {
    if (typeof value !== 'string') return value;
    for (const [source, token] of [[row.a, '@a'], [row.b, '@b'], [row.root, '@state']]) {
      if (value === source || value.startsWith(source + path.sep)) return token + value.slice(source.length);
    }
    return value;
  };
  if (typeof value === 'string') return pathValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const projected = structuredClone(value);
  for (const field of ['EncoderAppPath', 'EncoderAppPathDisplay', 'TranscodingTempPath']) {
    if (Object.hasOwn(projected, field)) projected[field] = pathValue(projected[field]);
  }
  return projected;
}
const functionalState = (state, row) => ({ current: normalizeState(state.current, row), retained: normalizeState(state.retained, row),
  disk: { directory: state.disk.directory, value: normalizeState(state.disk.value, row), accepted: state.disk.error == null } });
const functionalEvents = row => row.events.map(event => ({ phase: event.phase, value: normalizeState(event.value, row), state: functionalState(event.state, row) }));
const sourceInfo = information => information && ({ Container: information.Container,
  RunTimeTicks: information.RunTimeTicks == null ? information.RunTimeTicks : BigInt(information.RunTimeTicks),
  Size: information.Size == null ? information.Size : BigInt(information.Size),
  MediaStreams: information.MediaStreams.map(stream => ({ Type: stream.Type, Index: stream.Index, Codec: stream.Codec, Width: stream.Width ?? null,
    Height: stream.Height ?? null, Channels: stream.Channels ?? null, Language: stream.Language ?? null })) });

async function nodeCase(sample, index, captured, t) {
  const root = path.join(captured.output, 'node-' + index); await mkdir(root); const directory = path.join(root, 'config'); await mkdir(directory);
  const a = path.join(captured.native.toolDirectory, 'node-' + index + ' pick.choice' + suffix), b = path.join(captured.native.toolDirectory, 'node-' + index + ' pick.other' + suffix);
  await executable(captured.native.launcher.filename, a); await executable(captured.native.launcher.filename, b);
  const expand = value => ({ '@a': a, '@b': b, '@missing': path.join(root, 'missing-executable' + suffix) })[value] ?? value;
  const filename = path.join(directory, 'encoding.xml');
  await writeConfigurationFile(filename, 'encoding', { ...defaultConfiguration('encoding'), EncoderAppPath: expand(sample.configPath ?? null), EncoderAppPathDisplay: 'Before startup', EncodingThreadCount: 2 });
  const unowned = [], diagnostics = [], events = [], pendingSaves = [];
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory, onError: error => unowned.push({ phase: 'named-read', error: encoderFailure(error) }) });
  const retained = await store.getConfiguration('encoding'), getEncodingOptions = () => store.getCurrentConfiguration('encoding');
  const snapshot = () => payload({ current: getEncodingOptions(), retained, disk: disk(filename) });
  const traceDirectory = path.join(root, 'trace'); await mkdir(traceDirectory); const controlFile = path.join(root, 'control.json');
  const control = { ffmpeg: captured.native.ffmpeg.filename, ffprobe: captured.native.ffprobe.filename, traceDirectory,
    ...(sample.versionText === undefined ? {} : { versionText: sample.versionText }), ...(sample.exitCode === undefined ? {} : { exitCode: sample.exitCode }) };
  writeFileSync(controlFile, encoderJson(control));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path' && !/^jellyfin_(?:ffmpeg|ffmpeg__novalidation)$/iu.test(name)));
  environment.PATH = captured.native.toolDirectory + path.delimiter + (process.env.PATH ?? process.env.Path ?? '');
  environment.MEDIAMANAGER_ENCODER_CONTROL = controlFile;
  if (sample.environmentPath !== undefined) environment.JELLYFIN_FFMPEG = expand(sample.environmentPath);
  environment.JELLYFIN_FFmpeg__novalidation = sample.skip ? 'true' : 'false';
  const startup = readMediaEncoderStartupOptions({ args: sample.cli === undefined ? [] : ['--ffmpeg', expand(sample.cli)], environment });
  let saveFailure;
  const observerFailure = Object.assign(new Error('Controlled ' + sample.observer + ' failure.', { cause: new Error('Original observer cause.') }),
    { code: 'observer-failure', status: 503, statusCode: 503, errors: [new Error('First observer detail.'), new Error('Second observer detail.')] });
  const encoder = new MediaEncoder({ ...startup, environment, getEncodingOptions, saveEncodingOptions: async value => {
    try { await store.saveConfiguration('encoding', value); } catch (error) { saveFailure = error; throw error; }
  },
    onError: error => diagnostics.push({ phase: 'actual-version-process', error, snapshot: encoderFailure(error) }) });
  let nested = false;
  store.on('updating', change => {
    events.push(payload({ phase: 'updating', value: change.configuration, state: snapshot() }));
    if (sample.observer === 'updating') throw observerFailure;
  });
  store.on('updated', change => {
    events.push(payload({ phase: 'updated', value: change.configuration, state: snapshot() }));
    if (sample.observer === 'updated') throw observerFailure;
    if (sample.observer === 'late-alias' && !nested) {
      nested = true; retained.EncoderAppPathDisplay = 'Late retained display'; retained.EncodingThreadCount = 1;
      const pending = store.saveConfiguration('encoding', { ...defaultConfiguration('encoding'), EncoderAppPath: retained.EncoderAppPath, EncodingThreadCount: 3 });
      pendingSaves.push(pending); void pending.catch(() => {});
    }
    if (sample.afterSave === 'remove') renameSync(a, a + '.removed');
    else if (sample.afterSave) { control.versionMode = sample.afterSave; writeFileSync(controlFile, encoderJson(control)); }
  });
  const original = Buffer.from(encoderInput.source.media, 'base64'), originalHls = Buffer.from(encoderInput.hls.media, 'base64');
  const fixture = await extractionFixture({ '/media.mkv': original, '/hls.bin': originalHls });
  const bridge = new ProbeReadBridge(fixture.vfs), urls = [], actualRelease = bridge.lease.bind(bridge);
  bridge.lease = async (...args) => { const lease = await actualRelease(...args); urls.push(lease.url); return lease; };
  const row = { name: sample.name, root, a, b, before: snapshot(), accepted: null, initializationFailed: false, initializationError: null, probes: [], hls: [],
    controlledEnvironment: { JELLYFIN_FFMPEG: environment.JELLYFIN_FFMPEG, JELLYFIN_FFmpeg__novalidation: environment.JELLYFIN_FFmpeg__novalidation,
      fixtureControl: controlFile, pathPrefix: captured.native.toolDirectory }, processorCount: availableParallelism() };
  let app, extraction, remux, hls, failed = false, failure;
  try {
    if (sample.saveDirectory) { await rename(filename, filename + '.original'); await mkdir(filename); }
    try { row.accepted = await encoder.initialize(); await Promise.all(pendingSaves); }
    catch (error) { row.initializationFailed = true; row.initializationError = encoderFailure(error); row.initializationErrorPayload = encoderFailurePayload(error); }
    if (sample.observer === 'updating' || sample.observer === 'updated') assert.deepEqual(row.initializationErrorPayload, encoderFailurePayload(observerFailure));
    if (sample.saveDirectory) {
      assert.deepEqual(row.initializationErrorPayload, encoderFailurePayload(saveFailure));
      assert.ok(saveFailure.code); assert.equal(saveFailure.path, filename); row.actualSaveFailure = encoderFailure(saveFailure);
    }
    row.afterInitialize = snapshot(); row.encoderPath = encoder.encoderPath; row.probePath = encoder.probePath; row.version = encoder.version;
    row.events = events;
    for (const phase of ['before-late-write', 'after-late-write']) {
      if (phase === 'after-late-write') { retained.EncodingThreadCount = 7; retained.EncoderAppPathDisplay = 'After startup retained display'; }
      try {
        const result = await probeRaw(bridge, '/media.mkv', { executable: encoder.probePath, environment, threads: encoder.probeThreads, signal: t.signal });
        row.probes.push({ phase, raw: result, information: normalizeProbe(result.raw, { path: 'http://127.0.0.1/original.mkv', protocol: 'Http', isAudio: false, videoType: 'VideoFile' }), failed: false, error: null });
      } catch (error) { row.probes.push({ phase, information: null, failed: true, error: encoderFailure(error) }); }
    }
    if (row.accepted) {
      const source = structuredClone(encoderInput.source.source), hlsSource = structuredClone(encoderInput.hls.source);
      source.Id = ('f8400000-0000-0000-0000-' + String(index + 1).padStart(12, '0')).replaceAll('-', ''); source.Path = 'Z:\\Extraction\\media.mkv';
      hlsSource.Id = ('f8410000-0000-0000-0000-' + String(index + 1).padStart(12, '0')).replaceAll('-', ''); hlsSource.Path = 'Z:\\Extraction\\hls.bin';
      const actualFailures = [], httpDiagnostics = [], processObservations = []; let activeRequest;
      extraction = new ExtractionService({ vfs: fixture.vfs, bridge, subtitleCache: fixture.createSubtitleCache(), mediaEncoder: encoder, getEncodingOptions });
      remux = new RemuxService({ vfs: fixture.vfs, bridge, mediaEncoder: encoder });
      const cache = path.join(root, 'transcodes'); await mkdir(cache);
      hls = new HlsService({ vfs: fixture.vfs, bridge, remux, mediaEncoder: encoder, getEncodingOptions, getCacheDirectory: async () => cache,
        onProcess: process => processObservations.push(process), onError: error => unowned.push({ phase: 'hls-background-or-close', error: encoderFailure(error) }) });
      for (const [target, method] of [[extraction, 'subtitle'], [hls, 'segment']]) {
        const operation = target[method].bind(target);
        target[method] = async (...args) => { try { return await operation(...args); } catch (error) {
          actualFailures.push({ method, sourceId: args[0].Id, route: activeRequest, error, beforeHttp: encoderFailure(error) }); throw error;
        } };
      }
      const library = { async getItemRecord(id) { const value = id === source.Id ? source : hlsSource; return { Id: value.Id, Path: value.Path, MediaType: 'Video' }; },
        async getMediaSources(id) { return [id === source.Id ? source : hlsSource]; } };
      const playback = new PlaybackService({ library, vfs: fixture.vfs, identityMap: fixture.identityMap, extraction, remux, hls, getEncodingOptions });
      app = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, playback,
        authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
        onError: error => httpDiagnostics.push({ route: activeRequest, error, snapshot: encoderFailure(error) }) });
      await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); }); });
      const origin = 'http://127.0.0.1:' + app.server.address().port;
      const wire = async route => {
        activeRequest = route;
        try { const response = await fetch(origin + route, { signal: t.signal }); const bytes = Buffer.from(await response.arrayBuffer());
          return { route, status: response.status, contentType: response.headers.get('content-type'), headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64'), text: bytes.toString() }; }
        finally { activeRequest = undefined; }
      };
      const subtitle = source.MediaStreams.find(stream => stream.Type === 'Subtitle');
      row.subtitle = { wire: await wire(`/Videos/${source.Id}/${source.Id}/Subtitles/${subtitle.Index}/Stream.srt`) };
      if (sample.executeHls) for (const [index, cpuCoreLimit] of encoderInput.cpuLimits.entries()) {
        const before = new Set((await traces(traceDirectory)).map(trace => trace.filename));
        const processStart = processObservations.length;
        const options = { MediaType: 'Video', Container: 'mp4', SegmentContainer: 'mp4', SegmentLength: 6, CpuCoreLimit: cpuCoreLimit };
        const query = `SegmentLength=6&VideoCodec=copy&AudioCodec=copy&runtimeTicks=0&actualSegmentLengthTicks=60000000&playSessionId=encoder-${index}`
          + (cpuCoreLimit === null ? '' : '&cpuCoreLimit=' + cpuCoreLimit);
        const initialization = await wire(`/Videos/${hlsSource.Id}/hls1/main/-1.mp4?${query}`);
        const segment = initialization.status === 200 ? await wire(`/Videos/${hlsSource.Id}/hls1/main/0.mp4?${query}`) : null;
        const execution = { threads: getEncodingThreadCount(getEncodingOptions(), cpuCoreLimit), version: encoder.version,
          maxMuxingQueueSize: getEncodingOptions().MaxMuxingQueueSize > 128 ? getEncodingOptions().MaxMuxingQueueSize : 128 };
        const flacPlan = hlsPlan(hlsSource, options); flacPlan.audio = { ...flacPlan.audio, Codec: 'flac' };
        row.hls.push({ cpuCoreLimit, configuredThreads: getEncodingOptions().EncodingThreadCount, initialization, segment, execution,
          flacArguments: hlsArguments('http://127.0.0.1:1/' + 'a'.repeat(64), flacPlan, cache, 0, 0n, execution),
          files: await files(cache), traces: (await traces(traceDirectory)).filter(trace => !before.has(trace.filename)), processObservations: payload(processObservations.slice(processStart)) });
        await hls.stop(null, 'encoder-' + index);
      }
      row.httpFailures = actualFailures.map(value => ({ ...value, error: encoderFailure(value.error) }));
      row.httpDiagnostics = httpDiagnostics.map(value => ({ ...value, error: encoderFailure(value.error) }));
    } else row.subtitle = { boundary: 'HTTP is not admitted after startup initialization failed; the Native post-failure component call is retained separately.' };
    row.afterLateWrite = snapshot();
    const cold = new NamedConfigurationStore({ configurationDirectoryPath: directory });
    try { row.cold = await cold.getConfiguration('encoding'); } finally { await cold.close(); }
    row.traces = await traces(traceDirectory); row.diagnostics = diagnostics.map(value => ({ phase: value.phase, error: encoderFailure(value.error), snapshot: value.snapshot }));
    row.sourceBefore = original.toString('base64'); const handle = await fixture.vfs.openRead('/media.mkv');
    try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); row.sourceAfter = Buffer.concat(chunks).toString('base64'); } finally { await handle.close(); }
  } catch (error) { failed = true; failure = error; row.failure = encoderFailure(error); }
  finally {
    const cleanup = [];
    const attempt = async (phase, operation) => { try { await operation(); } catch (error) { cleanup.push({ phase, error }); } };
    await attempt('http', async () => { row.httpReleased = await closeApplication(app); });
    for (const [name, close] of [['hls', () => hls?.close()], ['remux', () => remux?.close()], ['extraction', () => extraction?.close()],
      ['encoder', () => encoder.close()], ['named', () => store.close()]]) await attempt(name, close);
    row.revokedLeases = [];
    for (const url of urls) await attempt('revoked-lease', async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) }), bytes = Buffer.from(await response.arrayBuffer());
      row.revokedLeases.push({ url, status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64') });
      assert.equal(response.status, 404);
    });
    await attempt('bridge', () => bridge.close());
    row.bridgeReleased = [];
    for (const port of new Set(urls.map(url => Number(new URL(url).port)))) await attempt('bridge-listener', async () => {
      row.bridgeReleased.push(await releasedEndpoint(port));
    });
    await attempt('fixture', () => fixture.close());
    await attempt('process-traces', async () => { row.traces = await traces(traceDirectory); });
    for (const trace of row.traces ?? []) for (const pid of [trace.wrapperPid, trace.childPid].filter(value => value != null))
      await attempt('process-exit', () => assert.equal(alive(pid), false));
    for (const process of row.hls.flatMap(run => run.processObservations).filter(value => Number.isInteger(value.pid)))
      await attempt('hls-process-exit', () => assert.equal(alive(process.pid), false));
    row.cleanup = cleanup.map(value => ({ phase: value.phase, error: encoderFailure(value.error) })); row.unowned = unowned;
    await attempt('observation-write', () => writeFile(path.join(root, 'observation.json'), encoderJson(row), { flag: 'wx' }));
    if (cleanup.length) {
      const errors = [...(failed ? [failure] : []), ...cleanup.map(value => value.error)];
      throw new AggregateError(errors, 'Media encoder fixture cleanup failed.', { cause: errors[0] });
    }
  }
  if (failed) throw failure;
  return row;
}

test('actual startup selection, Display persistence, retained writes and second version discovery match the current Native component', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentMediaEncoder(), report = { scope: captured.report.scope, comparisons: [], componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let failed = false, failure;
  try {
    for (const [index, sample] of encoderInput.cases.entries()) {
      const expected = captured.native.results[index], repeated = captured.repeat.results[index], actual = await nodeCase(sample, index, captured, t);
      report.comparisons.push({ sample, actual, expected, repeated });
      assert.equal(repeated.accepted, expected.accepted, sample.name); assert.equal(actual.accepted, expected.accepted, sample.name);
      assert.equal(repeated.version, expected.version, sample.name + ': repeated post-save version');
      assert.deepEqual(functionalState(repeated.afterInitialize, repeated), functionalState(expected.afterInitialize, expected), sample.name + ': independent Native current/save observation');
      assert.deepEqual(normalizeState(repeated.cold, repeated), normalizeState(expected.cold, expected), sample.name + ': independent Native cold observation');
      assert.deepEqual(functionalEvents(repeated), functionalEvents(expected), sample.name + ': independent ordered configuration events');
      assert.deepEqual(functionalEvents(actual), functionalEvents(expected), sample.name + ': ordered configuration values and persistence effects');
      assert.equal(actual.initializationFailed, expected.initializationError != null, sample.name);
      assert.deepEqual(functionalState(actual.afterInitialize, actual), functionalState(expected.afterInitialize, expected), sample.name + ': saved current and retained values');
      assert.deepEqual(functionalState(actual.afterLateWrite, actual), functionalState(expected.afterLateWrite, expected), sample.name + ': late retained writes');
      assert.deepEqual(normalizeState(actual.cold, actual), normalizeState(expected.cold, expected), sample.name + ': independent cold XML reader');
      assert.equal(normalizeState(actual.encoderPath, actual), normalizeState(expected.encoderPath, expected), sample.name + ': literal selected executable');
      assert.equal(normalizeState(actual.probePath, actual), normalizeState(expected.probePath, expected), sample.name + ': literal derived probe executable');
      assert.equal(actual.version, expected.version, sample.name + ': independently read post-save version');
      assert.equal(actual.sourceAfter, actual.sourceBefore); assert.equal(expected.sourceAfter, expected.sourceBefore);
      for (const [index, probe] of actual.probes.entries()) {
        assert.equal(probe.failed, expected.probes[index].error != null, sample.name + ': actual public probe result');
        if (!probe.failed) assert.deepEqual(sourceInfo(probe.information), sourceInfo(expected.probes[index].information), sample.name + ': actual original media values');
      }
      if (actual.accepted) assert.deepEqual(wireValue(actual.subtitle.wire), wireValue(expected.subtitle.wire), sample.name + ': complete subtitle public wire');
      const expectedProbeThreads = localThreads(sample.observer === 'late-alias' ? 1 : 2, captured.native.processorCount);
      for (const trace of expected.traces.filter(trace => trace.forwarded && trace.arguments.includes('-show_streams')))
        assert.equal(threadFlag(trace.arguments), expectedProbeThreads, sample.name + ': Native fixed startup probe threads');
      for (const trace of actual.traces.filter(trace => trace.forwarded && trace.arguments.includes('-show_streams')))
        assert.equal(threadFlag(trace.arguments), localThreads(sample.observer === 'late-alias' ? 1 : 2, availableParallelism()), sample.name + ': Node fixed startup probe threads');
      for (const [index, run] of actual.hls.entries()) {
        const native = expected.hls[index]; assert.equal(native.commandError, null, sample.name + ': actual Native HLS builder');
        assert.equal(native.helperThreads, localThreads(native.cpuCoreLimit ?? native.configuredThreads, native.processorCount));
        const nodeCopy = run.processObservations.filter(process => process.args.includes('-hls_segment_type'));
        assert.ok(nodeCopy.length > 0, sample.name + ': real Node packet-copy process observed');
        for (const process of nodeCopy) assert.equal(threadFlag(process.args), localThreads(run.cpuCoreLimit ?? run.configuredThreads, availableParallelism()));
        const nativeCopy = expected.traces.filter(trace => copyTrace(trace) && trace.arguments.at(-1).replaceAll('\\', '/').endsWith('/hls-' + index + '/main.m3u8'));
        assert.ok(nativeCopy.length > 0, sample.name + ': real Native packet-copy process observed');
        for (const trace of nativeCopy) {
          assert.equal(threadFlag(trace.arguments), native.helperThreads);
          for (const node of nodeCopy) {
            assert.equal(node.args.includes('-hls_ts_options'), trace.arguments.includes('-hls_ts_options'));
            assert.equal(node.args.includes('-hls_segment_options'), trace.arguments.includes('-hls_segment_options'));
            assert.equal(selectedFlag(node.args, '-max_muxing_queue_size'), selectedFlag(trace.arguments, '-max_muxing_queue_size'));
          }
        }
        assert.equal(run.flacArguments.includes('-strict'), /(?:^| )-strict -2(?: |$)/u.test(native.flacArguments), 'FLAC version consumer uses actual Native GetAudioArguments; no FLAC source execution claim.');
        if (native.processResult.ExitCode === 0) {
          assert.equal(run.initialization.status, 200); assert.equal(run.segment?.status, 200);
          assert.ok(native.files.some(file => file.bytes.length > 0)); assert.ok(run.files.some(file => file.name.endsWith('.mp4') && file.bytes.length > 0));
          const playlist = Buffer.from(native.files.find(file => file.name === 'main.m3u8').bytes, 'base64').toString();
          const initName = /#EXT-X-MAP:URI="([^"]+)"/u.exec(playlist)[1].split(/[\\/]/u).at(-1);
          const firstName = playlist.split(/\r?\n/u).find(line => line && !line.startsWith('#')).split(/[\\/]/u).at(-1);
          const reference = await inspectFirstFragment(actual.root, 'native-' + index, native.files.find(file => file.name === initName).bytes,
            native.files.find(file => file.name === firstName).bytes);
          const observed = await inspectFirstFragment(actual.root, 'node-' + index, run.initialization.bytes, run.segment.bytes);
          run.packetInspection = { native: reference, node: observed };
          assert.ok(reference.packets.length > 0); assert.deepEqual(observed.streams, reference.streams); assert.deepEqual(observed.packets, reference.packets);
        } else assert.ok(run.initialization.status >= 400, 'Both attempts preserve actual executor rejection of a controlled reported legacy version.');
      }
      for (const trace of [...expected.traces, ...actual.traces].filter(trace => trace.forwarded))
        assert.equal(trace.arguments.some(value => value === 'lavfi' || value === '-init_hw_device' || value.startsWith('nullsrc')), false);
      for (const process of actual.hls.flatMap(run => run.processObservations))
        assert.equal(process.args.some(value => value === 'lavfi' || value === '-init_hw_device' || value.startsWith('nullsrc')), false);
    }
    report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = encoderFailure(error); }
  finally { await writeFile(path.join(captured.output, 'comparison.json'), encoderJson(report), { flag: 'wx' }); }
  if (failed) throw failure;
});

test('formal streaming CPU query binding matches actual Native MVC action binding and complete public errors', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentMediaEncoder(), report = { scope: 'Actual DynamicHlsController action descriptors and MVC binding with a disclosed action filter, versus formal Node route binding and controlled downstream result.',
    actionExecuted: false, http: [], phaseAcceptance: false, releaseAcceptance: false }; let app, failed = false, failure;
  const parameterErrors = [];
  try {
    app = await createTestApplication({ configuration: defaultConfiguration('server'),
      playback: { async hlsStream(_id, _kind, options) { return new HttpResult(200, { CpuCoreLimit: options.CpuCoreLimit ?? null }); } },
      authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
      onError: error => parameterErrors.push(error) });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); }); });
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const publicValue = wire => {
      const value = projectProblemTrace(parseLosslessJson(wire.text), wire.status);
      return { status: wire.status, contentType: wire.contentType ?? null, value };
    };
    for (const [index, query] of encoderInput.binding.entries()) {
      const route = '/Videos/f8400000000000000000000000000001/hls1/main/0.mp4?runtimeTicks=0&actualSegmentLengthTicks=60000000&' + query;
      const response = await fetch(origin + route, { signal: t.signal }); const bytes = Buffer.from(await response.arrayBuffer());
      const actual = { route, status: response.status, contentType: response.headers.get('content-type'), headers: Object.fromEntries(response.headers), bytes: bytes.toString('base64'), text: bytes.toString() };
      const expected = captured.native.binding[index], repeated = captured.repeat.binding[index]; report.http.push({ query, actual, expected, repeated });
      assert.deepEqual(publicValue(repeated.wire), publicValue(expected.wire)); assert.deepEqual(publicValue(actual), publicValue(expected.wire));
    }
    report.diagnostics = parameterErrors.map(encoderFailure); report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = encoderFailure(error); }
  finally {
    try { report.httpReleased = await closeApplication(app); } catch (error) {
      report.cleanupFailure = encoderFailure(error);
      failure = failed ? new AggregateError([failure, error], 'CPU binding cleanup failed.', { cause: failure }) : error;
      failed = true;
    }
    try { await writeFile(path.join(captured.output, 'binding-comparison.json'), encoderJson(report), { flag: 'wx' }); }
    catch (error) { failure = failed ? new AggregateError([failure, error], 'CPU binding observation failed.', { cause: failure }) : error; failed = true; }
  }
  if (failed) throw failure;
});

test('streaming CpuCoreLimit binds as nullable Int32 and zero and negative values override current encoding threads', () => {
  const configuration = { ...defaultConfiguration('encoding'), EncodingThreadCount: 2147483647 };
  for (const [query, expected] of [['', undefined], ['cpuCoreLimit=', undefined], ['cpuCoreLimit=0', 0], ['CPUCORELIMIT=-2', -2], ['cpuCoreLimit=%2B1', 1], ['cpuCoreLimit=2147483647', 2147483647]]) {
    const result = bindStreaming({ query: new URLSearchParams(query), params: { container: 'mp4' } }, 'Videos');
    assert.equal(result.CpuCoreLimit, expected); assert.equal(getEncodingThreadCount(configuration, result.CpuCoreLimit), localThreads(expected ?? configuration.EncodingThreadCount, availableParallelism()));
  }
  for (const value of ['2147483648', '1.2', 'abc']) assert.throws(() => bindStreaming({ query: new URLSearchParams({ cpuCoreLimit: value }), params: {} }, 'Videos'),
    error => { assert.deepEqual(error.errors, { cpuCoreLimit: [`The value '${value}' is not valid.`] }); return true; });
});

test('closing an actual held startup version process cancels initialization, drains its PID and permits no late configuration save', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentMediaEncoder(), root = path.join(captured.output, 'node-held-version'); await mkdir(root);
  const traceDirectory = path.join(root, 'trace'); await mkdir(traceDirectory);
  const selected = path.join(captured.native.toolDirectory, 'node-held-version.choice' + suffix); await executable(captured.native.launcher.filename, selected);
  const controlFile = path.join(root, 'control.json'); await writeFile(controlFile, encoderJson({ ffmpeg: captured.native.ffmpeg.filename,
    ffprobe: captured.native.ffprobe.filename, traceDirectory, holdVersion: true }));
  const directory = path.join(root, 'config'); await mkdir(directory); const store = new NamedConfigurationStore({ configurationDirectoryPath: directory });
  await store.getConfiguration('encoding'); const diagnostics = [], environment = { ...process.env, MEDIAMANAGER_ENCODER_CONTROL: controlFile };
  const encoder = new MediaEncoder({ startupFFmpegPath: selected, environment, getEncodingOptions: () => store.getCurrentConfiguration('encoding'),
    saveEncodingOptions: value => store.saveConfiguration('encoding', value), onError: error => diagnostics.push(encoderFailure(error)) });
  const report = { scope: 'Actual startup version apphost after its real ffmpeg child exited; normal owner cancellation drains the remaining process.',
    phaseAcceptance: false, releaseAcceptance: false, diagnostics }; let failed = false, failure, actual;
  const initializing = encoder.initialize(); void initializing.catch(() => {});
  try {
    let held;
    while (!held) {
      t.signal.throwIfAborted();
      try { held = JSON.parse(await readFile(path.join(traceDirectory, 'version-held.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await Promise.race([delay(10, undefined, { signal: t.signal }), initializing.then(() => { throw new Error('The actual held version process ended before cancellation.'); })]);
      }
    }
    assert.equal(alive(held.wrapperPid), true); assert.equal(alive(held.childPid), false); report.held = held;
    await encoder.close();
    await assert.rejects(initializing, error => { actual = error; assert.equal(error.code, 'cancelled');
      assert.equal(error.cause.code, 'closed'); assert.equal(error.cause.message, 'The media encoder is closed.'); return true; });
    report.initializationError = encoderFailure(actual); report.processes = await traces(traceDirectory);
    for (const process of report.processes) for (const pid of [process.wrapperPid, process.childPid].filter(value => value != null)) assert.equal(alive(pid), false);
    await assert.rejects(readFile(path.join(directory, 'encoding.xml')), { code: 'ENOENT' });
    assert.equal(store.getCurrentConfiguration('encoding').EncoderAppPathDisplay, null);
    await assert.rejects(encoder.initialize(), { code: 'closed' }); report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = encoderFailure(error); }
  finally {
    const errors = []; try { await encoder.close(); } catch (error) { errors.push(error); } try { await store.close(); } catch (error) { errors.push(error); }
    report.cleanup = errors.map(encoderFailure); await writeFile(path.join(root, 'comparison.json'), encoderJson(report), { flag: 'wx' });
    if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Held version cleanup failed.', { cause: failed ? failure : errors[0] });
  }
  if (failed) throw failure;
});

test('close drains an admitted real Display XML write and initialize preserves a real file-close failure without redelivering it as close failure', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentMediaEncoder();
  const reasons = [
    { label: 'drain', closeFailure: false },
    { label: 'failure', closeFailure: true, reason: Object.assign(new Error('The actual Display file closed before its reported cleanup failure.', { cause: new Error('Original Display close cause.') }),
      { code: 'EIO', status: 507, statusCode: 507, errors: [new Error('First close detail.'), new Error('Second close detail.')] }) },
    { label: 'business-failure', closeFailure: true, reason: { name: 'Business close failure', stack: 'Business stack value',
      message: 'The actual Display file closed before its business rejection.', code: 'EIO', status: 507, statusCode: 507,
      cause: { name: 'Business close cause', stack: 'Retained cause stack', value: undefined }, errors: [false, 0, '', null, undefined] } },
  ];
  for (const { label, closeFailure, reason: originalCloseFailure } of reasons) {
    const root = path.join(captured.output, 'node-actual-save-close-' + label); await mkdir(root);
    const directory = path.join(root, 'config'); await mkdir(directory); const filename = path.join(directory, 'encoding.xml');
    const initial = defaultConfiguration('encoding'); await writeConfigurationFile(filename, 'encoding', initial);
    const entered = Promise.withResolvers(), released = Promise.withResolvers(), events = [], diagnostics = [];
    let firstWrite = true;
    const fileSystem = { ...fs, async open(target, flags) {
      const file = await fs.open(target, flags); if (target !== filename || flags !== 'w') return file;
      return { async write(...args) { if (firstWrite) { firstWrite = false; entered.resolve(); await released.promise; } return file.write(...args); },
        async close() { await file.close(); if (closeFailure) throw originalCloseFailure; } };
    } };
    const store = new NamedConfigurationStore({ configurationDirectoryPath: directory, fileSystem }); await store.getConfiguration('encoding');
    store.on('updated', change => events.push(payload({ phase: 'updated', value: change.configuration, disk: disk(filename) })));
    const selected = captured.native.ffmpeg.filename, encoder = new MediaEncoder({ startupFFmpegPath: selected,
      getEncodingOptions: () => store.getCurrentConfiguration('encoding'), saveEncodingOptions: value => store.saveConfiguration('encoding', value), onError: error => diagnostics.push(encoderFailure(error)) });
    const report = { scope: 'Actual manager save opened/truncated encoding.xml before owner close; full persisted value and actual closed file failure.',
      closeFailure, reason: encoderFailure(originalCloseFailure), phaseAcceptance: false, releaseAcceptance: false, events, diagnostics };
    let failed = false, failure, initializing, closing, closeFinished = false;
    const release = () => released.resolve(); t.signal.addEventListener('abort', release, { once: true });
    try {
      initializing = encoder.initialize(); void initializing.catch(() => {});
      await Promise.race([entered.promise, initializing.then(() => { throw new Error('The actual Display save was not held.'); })]);
      closing = encoder.close().then(() => { closeFinished = true; });
      assert.deepEqual(await readFile(filename), Buffer.alloc(0)); assert.equal(closeFinished, false);
      release(); let actual;
      await assert.rejects(initializing, error => { actual = error;
        if (closeFailure) assert.deepEqual(encoderFailurePayload(error), encoderFailurePayload(originalCloseFailure));
        else { assert.equal(error.code, 'cancelled'); assert.equal(error.cause.code, 'closed'); }
        return true;
      });
      await closing; assert.equal(closeFinished, true); report.initializationError = encoderFailure(actual);
      report.disk = disk(filename); assert.equal(report.disk.value.EncoderAppPathDisplay, selected);
      const cold = new NamedConfigurationStore({ configurationDirectoryPath: directory });
      try { report.cold = await cold.getConfiguration('encoding'); assert.equal(report.cold.EncoderAppPathDisplay, selected); }
      finally { await cold.close(); }
      if (!closeFailure) assert.ok(events.some(event => event.phase === 'updated' && event.value.EncoderAppPathDisplay === selected));
      report.componentAcceptance = true;
    } catch (error) { failed = true; failure = error; report.failure = encoderFailure(error); }
    finally {
      release(); t.signal.removeEventListener('abort', release); const errors = [];
      for (const operation of [() => closing, () => encoder.close(), () => store.close()]) try { await operation(); } catch (error) { errors.push(error); }
      report.cleanup = errors.map(encoderFailure); await writeFile(path.join(root, 'comparison.json'), encoderJson(report), { flag: 'wx' });
      if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Display save cleanup failed.', { cause: failed ? failure : errors[0] });
    }
    if (failed) throw failure;
  }
});

test('raw probe cancellation retains the original reason and ordered real lease-release failure after process and readers end', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentMediaEncoder(), root = path.join(captured.output, 'node-probe-release-failure'); await mkdir(root);
  const original = Buffer.from(encoderInput.source.media, 'base64'), fixture = await extractionFixture({ '/media.mkv': original }, { delayMs: 2000 });
  const bridge = new ProbeReadBridge(fixture.vfs), entered = Promise.withResolvers(), readerClosed = Promise.withResolvers(), controller = new AbortController(); let url;
  const reason = Object.assign(new Error('The actual probe reader cancelled.', { cause: new Error('Original caller reason.') }), { code: 'reader-stopped', status: 499 });
  const releaseFailure = Object.assign(new Error('The actual probe lease was revoked before its reported cleanup failure.', { cause: new Error('Original lease cleanup cause.') }),
    { code: 'EIO', status: 507, statusCode: 507, errors: [new Error('First release detail.'), new Error('Second release detail.')] });
  const open = fixture.adapter.openRead.bind(fixture.adapter); fixture.adapter.openRead = async (...args) => {
    const handle = await open(...args); handle.stream.once('close', readerClosed.resolve); entered.resolve(); return handle;
  };
  const lease = bridge.lease.bind(bridge); bridge.lease = async (...args) => { const value = await lease(...args); url = value.url;
    return { ...value, async release() { await value.release(); assert.equal((await fetch(value.url)).status, 404); throw releaseFailure; } }; };
  const report = { scope: 'Actual ffprobe PID, owner-signal cancellation and bridge reader release; no constructed private lease state.',
    reason: encoderFailure(reason), releaseFailure: encoderFailure(releaseFailure), phaseAcceptance: false, releaseAcceptance: false }; let failed = false, failure, work;
  const abort = () => controller.abort(t.signal.reason); t.signal.addEventListener('abort', abort, { once: true });
  try {
    work = probeRaw(bridge, '/media.mkv', { executable: captured.native.ffprobe.filename, signal: controller.signal }); void work.catch(() => {});
    await Promise.race([entered.promise, work.then(() => { throw new Error('The real probe input did not remain active.'); })]);
    controller.abort(reason); let actual;
    await assert.rejects(work, error => { actual = error; assert.equal(error.code, 'cancelled');
      assert.deepEqual(encoderFailurePayload(error.cause.cause), encoderFailurePayload(reason));
      assert.deepEqual(error.errors.map(encoderFailurePayload), [error.cause, releaseFailure].map(encoderFailurePayload));
      assert.equal(alive(error.cause.process.pid), false); return true;
    });
    await readerClosed.promise; report.readerCloseObserved = true;
    report.error = encoderFailure(actual); assert.equal((await fetch(url)).status, 404); fixture.setDelay(0);
    const handle = await fixture.vfs.openRead('/media.mkv'); try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), original); report.originalAfter = Buffer.concat(chunks).toString('base64'); } finally { await handle.close(); }
    report.componentAcceptance = true;
  } catch (error) { failed = true; failure = error; report.failure = encoderFailure(error); }
  finally {
    controller.abort(reason); t.signal.removeEventListener('abort', abort); const errors = [];
    await Promise.allSettled([work]); try { await bridge.close(); } catch (error) { errors.push(error); } try { await fixture.close(); } catch (error) { errors.push(error); }
    report.cleanup = errors.map(encoderFailure); await writeFile(path.join(root, 'comparison.json'), encoderJson(report), { flag: 'wx' });
    if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Probe release fixture cleanup failed.', { cause: failed ? failure : errors[0] });
  }
  if (failed) throw failure;
});
