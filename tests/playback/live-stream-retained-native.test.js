import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { LiveStreamsService } from '../../src/playback/live-streams.js';
import { PlaybackService } from '../../src/playback/service.js';
import { createTestApplication } from '../helpers/application.js';
import { md5Guid } from '../../src/core/identity.js';
import { inspect } from 'node:util';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const inputFile = new URL('./fixtures/live-stream-retained/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const bytesFor = value => Buffer.from(Array.from({ length: value.length }, (_value, index) => (index * 37 + value.seed) & 255));
const providerId = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider'), serviceId = md5Guid('Jellyfin.LiveTv.DefaultLiveTvService');
const channelId = 'a9c00000000000000000000000000001';
const unusedPort = () => new Promise((resolve, reject) => { const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => { const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port)); }); });
const portAvailable = port => new Promise(resolve => { const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
const missingRoute = '/LiveTv/LiveStreamFiles/missing/stream.ts';
async function requestHttp(origin, route, { token, method = 'GET' } = {}) {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', ...(token ? { Authorization: 'MediaBrowser Token="' + token + '"' } : {}) } });
  const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
  let value;
  try { if (text) value = JSON.parse(text); } catch { /* Preserve complete non-JSON failure bodies. */ }
  return { status: response.status, headers: Object.fromEntries(response.headers), contentType: response.headers.get('content-type'),
    contentLength: response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null,
    acceptRanges: response.headers.get('accept-ranges'), contentRange: response.headers.get('content-range'),
    bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64'), text, value };
}
function problemObservation(wire) {
  const value = structuredClone(wire.value);
  assert.equal(wire.status, 404); assert.equal(value.status, 404);
  assert.equal(typeof value.traceId, 'string'); assert.ok(value.traceId.length > 0);
  value.traceId = '$validated-request-trace';
  return { status: wire.status, contentType: wire.contentType, contentLength: wire.contentLength,
    acceptRanges: wire.acceptRanges, contentRange: wire.contentRange, value };
}
async function observeMissingHttp(playback, diagnostics) {
  const application = await createTestApplication({ configuration: { UICulture: 'en-US' }, playback,
    authentication: { async authenticate() { return { IsAuthenticated: false }; },
      authorize() { assert.fail('The retained byte route must remain public.'); } },
    onError: error => diagnostics.push(error.message) });
  let port;
  try {
    await new Promise((resolve, reject) => application.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    port = application.server.address().port;
    return await requestHttp('http://127.0.0.1:' + port, missingRoute);
  } finally {
    application.beginClose(); await application.drainRequests();
    await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    if (port != null) assert.equal(await portAvailable(port), true);
  }
}
class Response extends Writable {
  constructor() { super({ highWaterMark: 1 }); this.statusCode = 200; this.headers = new Map(); this.headersSent = false; this.chunks = []; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  _write(chunk, _encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); setImmediate(done); }
}

async function observe(sample, bytes, native) {
  const owners = [], diagnostics = [], request = new EventEmitter(), response = new Response();
  request.method = sample.method; request.headers = sample.range ? { range: sample.range } : {};
  const completed = finished(response); void completed.catch(() => {});
  let streams, failed = false, failure, result, missingHttp, missingController;
  const source = { Id: 'retained-source', Protocol: 'Http', Path: 'http://127.0.0.1/controlled-original',
    SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false, MediaStreams: [] };
  const sharing = Object.freeze({ get enabled() { return owners.some(owner => !owner.reader && !owner.closed); }, retain: () => lease() });
  function lease({ reader = false, signal } = {}) {
    const owner = { reader, reads: 0, bytes: 0, closed: false, closes: 0, offset: 0 }; owners.push(owner);
    const stream = { [Symbol.asyncIterator]() { return this; }, async next() {
      signal?.throwIfAborted(); if (owner.closed) return { done: true };
      owner.reads++;
      if (sample.cancelAfter != null && owner.offset >= sample.cancelAfter) {
        request.emit('aborted'); signal?.throwIfAborted(); throw new Error('Cancellation did not reach the controlled reader.');
      }
      if (owner.offset >= bytes.length) return { done: true };
      const end = Math.min(bytes.length, owner.offset + 127, sample.cancelAfter ?? bytes.length);
      const chunk = bytes.subarray(owner.offset, end); owner.offset = end; owner.bytes += chunk.length;
      return { done: false, value: chunk };
    }, async return() { return { done: true }; } };
    return Object.freeze({ mode: 'native', mediaSource: structuredClone(source), tunerHostId: 'controlled-retained', sharing, stream,
      async forkRead(options) { return lease({ reader: true, signal: options.signal }); },
      async close() { if (owner.closed) return; owner.closed = true; owner.closes++; } });
  }
  try {
    streams = new LiveStreamsService({ tuners: { name: 'Emby',
      async getChannelStreamMediaSources() { return [{ mode: 'native', mediaSource: structuredClone(source) }]; }, async getChannelStream() { return lease(); } },
      library: { itemCreation: { async getItemById(id) { assert.equal(id.replaceAll('-', ''), channelId);
        return { Type: 'LiveTvChannel', ChannelType: 'TV', ExternalId: 'retained', ServiceName: 'Emby' }; } } },
      probe: { async addMediaInfo() {} }, getLocalApiUrl: () => 'http://127.0.0.1:1', onError: error => diagnostics.push(inspect(error, { depth: null })) });
    const opened = await streams.open({ OpenToken: providerId + '_LiveTvChannel_' + channelId + '_' + source.Id });
    assert.equal(opened.MediaSource.LiveStreamId, native.publicId);
    const unique = streams.snapshot()[0].UniqueId;
    assert.equal(typeof unique, 'string'); assert.ok(unique.length > 0); assert.equal(streams.snapshot()[0].ConsumerCount, 1);
    const publicLookups = [];
    for (const expected of native.lookups.slice(0, 5)) {
      let found = false, status = null, value = null;
      try { value = streams.getLiveStream(expected.id); found = value?.Id === source.Id; }
      catch (error) { status = error.status; }
      assert.equal(found, expected.found); assert.equal(status, expected.error?.status ?? null);
      if (found) assert.deepEqual(value, opened.MediaSource);
      publicLookups.push({ found, status, source: value });
    }
    assert.equal(streams.snapshot()[0].ConsumerCount, 1);
    const playback = new PlaybackService({ getLiveStreams: () => streams, getEncodingOptions: () => defaultConfiguration('encoding') });
    const selected = sample.missing ? 'missing' : sample.upperUnique ? unique.toUpperCase() : unique;
    const delivery = playback.liveStreamFile(selected, sample.container);
    if (typeof delivery.send === 'function') await delivery.send(request, response);
    else {
      assert.equal(sample.missing, true); assert.equal(delivery.status, 404);
      missingController = { status: delivery.status, body: delivery.body };
      missingHttp = await observeMissingHttp(playback, diagnostics);
      assert.deepEqual(problemObservation({ ...missingHttp, value: delivery.body }), problemObservation(missingHttp));
      response.end();
    }
    const outcome = await Promise.allSettled([completed]);
    if (sample.cancelAfter == null) assert.equal(outcome[0].status, 'fulfilled');
    else assert.equal(outcome[0].status, 'rejected', 'A deliberately aborted live consumer must not be reported as completed.');
    const payload = missingHttp ? Buffer.from(missingHttp.base64, 'base64') : Buffer.concat(response.chunks), readers = owners.filter(owner => owner.reader);
    result = { name: sample.name, openedSource: opened.MediaSource, status: missingHttp?.status ?? response.statusCode, contentType: missingHttp?.contentType ?? response.headers.get('content-type') ?? null,
      contentLength: missingHttp ? missingHttp.contentLength : response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null,
      acceptRanges: missingHttp ? missingHttp.acceptRanges : response.headers.get('accept-ranges') ?? null,
      contentRange: missingHttp ? missingHttp.contentRange : response.headers.get('content-range') ?? null,
      bytes: payload.length, sha256: hash(payload), readers: readers.map(owner => ({ reads: owner.reads, bytes: owner.bytes, closes: owner.closes })),
      consumerCountAfterResult: streams.snapshot()[0].ConsumerCount, readerCountAfterResult: streams.snapshot()[0].ReaderCount,
      originalOwnerReads: owners.filter(owner => !owner.reader).map(owner => owner.reads), publicLookups, diagnostics: [...diagnostics] };
    if (missingHttp) { result.http = missingHttp; result.controller = missingController; }
    if (sample.cancelAfter != null) result.explicitCancellation = { responseDestroyed: response.destroyed, readerReleased: readers.every(owner => owner.closed) };
    assert.equal(result.consumerCountAfterResult, 1); assert.equal(result.readerCountAfterResult, 0);
    assert.ok(readers.every(owner => owner.closed));
    await streams.closeLiveStream(native.publicId.toUpperCase()); assert.deepEqual(streams.snapshot(), []);
    assert.ok(owners.every(owner => owner.closed));
  } catch (error) { failed = true; failure = error; if (missingHttp) result ??= { name: sample.name, http: missingHttp, controller: missingController }; }
  finally {
    response.destroy();
    await Promise.allSettled([completed]);
    const cleanup = [];
    try { await streams?.close(); } catch (error) { cleanup.push(error); }
    if (owners.some(owner => !owner.closed)) cleanup.push(new Error('A retained source or reader survived close.'));
    if (cleanup.length) {
      failure = new AggregateError([...(failed ? [failure] : []), ...cleanup], 'Retained source cleanup failed.', { cause: failed ? failure : cleanup[0] });
      failed = true;
    }
  }
  return { result, failed, failure, owners };
}

test('retained live bytes match actual controller and progressive result with independent reader ownership', { skip: !enabled, timeout: 300000 }, async t => {
  const output = path.join(validationOutputRoot(), 'live-stream-retained-' + randomUUID()); await mkdir(output);
  const publication = await createPrivateFilterOutput(path.join(output, 'native-http')); await mkdir(publication.root);
  const privateRoot = path.join(output, 'private-inputs');
  const report = { cases: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false }; let current, nativeHost, nativePort, nativeOrigin, failure;
  const stopNative = async () => {
    if (!nativeHost) return;
    const receipt = await nativeHost.stop(async () => (await requestHttp(nativeOrigin, '/System/Shutdown', { method: 'POST', token: current.accessToken })).status,
      () => portAvailable(nativePort));
    nativeHost = undefined; report.cleanup.push({ nativeHttp: receipt });
    assert.ok(receipt.cleanShutdown && receipt.pidGone && receipt.portAvailable);
  };
  try {
    current = await currentNativeReference(); publication.addSecret(current.accessToken); report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'Jellyfin.Api/Controllers/LiveTvController.cs', 'MediaBrowser.Controller/Streaming/ProgressiveFileStream.cs',
      'MediaBrowser.Controller/Library/ILiveStream.cs', 'MediaBrowser.Controller/Library/IDirectStreamProvider.cs',
      'src/Jellyfin.LiveTv/TunerHosts/LiveStream.cs', 'src/Jellyfin.LiveTv/TunerHosts/SharedHttpStream.cs',
      'MediaBrowser.Common/Configuration/EncodingConfigurationExtensions.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs']);
    const receipt = await recordOracle({ project: 'tests/playback/fixtures/live-stream-retained/Oracle.csproj', output: path.join(output, 'native'),
      args: [fileURLToPath(inputFile), '{output}/native.json', privateRoot] });
    assert.equal(receipt.passed, true);
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes), bytes = bytesFor(input.payload);
    assert.equal(native.inputSha256, hash(inputBytes)); assert.equal(native.payloadSha256, hash(bytes));
    assert.equal(native.publicId, providerId + '_' + serviceId + '_retained-source');
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const name of ['actualRetainedMediaSourceManager', 'actualLiveTvController', 'actualFileStreamResultExecutor', 'actualProgressiveFileStream', 'controlledMemoryLiveStream']) assert.equal(native[name], true);
    assert.equal(native.sharedHttpStreamOpened, false); assert.equal(native.tunerOrRecordingStarted, false); assert.equal(native.nativeEfOpened, false);
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.deepEqual(native.results.map(value => value.name), input.controllerCases.map(value => value.name));
    assert.deepEqual(native.lookups.slice(0, 3).map(value => value.found), [true, true, false]);
    assert.equal(native.lookups[3].error.status, 400); assert.equal(native.lookups[4].error.status, 400);
    assert.equal(native.lookups[5].directProvider, false);
    assert.equal(native.timeout.first, bytes.length); assert.equal(native.timeout.eof, 0); assert.equal(native.timeout.sha256, hash(bytes));
    report.nativeLookups = native.lookups; report.nativeExplicitTimeout = native.timeout;
    report.nativePreparedFiles = native.fileCases;
    for (const [index, sample] of input.fileCases.entries()) {
      const expected = native.fileCases[index], prepared = bytesFor(sample);
      assert.equal(expected.actualBaseLiveStreamGetStream, true); assert.equal(expected.inputUnchanged, true);
      assert.equal(expected.preparedSourceSha256, hash(prepared));
      if (sample.missing) {
        assert.equal(expected.error.status, 404); assert.equal(expected.bytes, 0); assert.equal(expected.sha256, hash(Buffer.alloc(0)));
      }
      else {
        const offset = sample.ageSeconds > 10 && prepared.length >= 20000 ? prepared.length - 20000 : 0;
        assert.equal(expected.position, offset); assert.equal(expected.bytes, prepared.length - offset); assert.equal(expected.sha256, hash(prepared.subarray(offset)));
      }
    }
    const referenceRoot = path.join(publication.root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    nativePort = await unusedPort(); nativeOrigin = 'http://127.0.0.1:' + nativePort;
    await current.prepareClone(referenceRoot, nativePort);
    nativeHost = current.start({ referenceRoot, outputRoot: publication.root, label: 'native-missing-wire', origin: nativeOrigin });
    await nativeHost.ready(); report.nativeMissingHttp = await requestHttp(nativeOrigin, missingRoute);
    problemObservation(report.nativeMissingHttp); await stopNative();
    for (const sample of input.controllerCases) await t.test(sample.name, { timeout: 30000 }, async () => {
      const expected = native.results.find(value => value.name === sample.name), observed = await observe(sample, bytes, native);
      const record = { name: sample.name, actual: observed.result, native: expected, owners: observed.owners, passed: false }; report.cases.push(record);
      try {
        if (observed.failed) throw observed.failure;
        if (sample.missing) {
          assert.deepEqual(problemObservation(observed.result.http), problemObservation(report.nativeMissingHttp));
          assert.equal(expected.status, 404); assert.equal(expected.contentType, null); assert.equal(expected.contentLength, null);
          assert.equal(expected.acceptRanges, null); assert.equal(expected.contentRange, null);
          assert.equal(expected.bytes, 0); assert.equal(expected.sha256, hash(Buffer.alloc(0)));
          assert.equal(observed.result.consumerCountAfterResult, expected.consumerCountAfterResult);
        } else {
          const fields = ['status', 'contentType', 'contentLength', 'acceptRanges', 'contentRange', 'bytes', 'sha256', 'consumerCountAfterResult'];
          assert.deepEqual(Object.fromEntries(fields.map(name => [name, observed.result[name]])), Object.fromEntries(fields.map(name => [name, expected[name]])));
        }
        assert.equal(expected.actualProgressive, !sample.missing);
        if (sample.cancelAfter != null) { assert.equal(expected.requestAborted, true);
          assert.ok(expected.executionFailure != null || expected.contextAborted === true);
          assert.deepEqual(observed.result.explicitCancellation, { responseDestroyed: true, readerReleased: true }); }
        record.passed = true;
      } catch (error) { record.error = error.stack; throw error; }
    });
    report.inputSha256 = hash(inputBytes); report.nativeOutputSha256 = hash(nativeBytes);
  } catch (error) { failure = error; report.error = error.stack; }
  finally {
    try { await stopNative(); } catch (error) { failure ??= error; report.cleanup.push({ nativeHttpClosed: false, error: error.message }); }
    if (current) try { await current.finish(); report.cleanup.push({ protectedInputsUnchanged: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ protectedInputsUnchanged: false, error: error.message }); }
    try { assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-inputs'); await rm(privateRoot, { recursive: true, force: true }); report.cleanup.push({ privateInputsRemoved: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ privateInputsRemoved: false, error: error.message }); }
    report.passed = !failure && report.cases.length === input.controllerCases.length && report.cases.every(value => value.passed);
    report.boundary = 'Actual retained MediaSourceManager lookup, LiveTvController, MVC FileStreamResult executor and ProgressiveFileStream over controlled memory ILiveStream; base LiveStream.GetStream reads prewritten private fixture inputs only. Node executes actual public registry, PlaybackService and BinaryResult with controlled tuner/probe and writable response component. Missing identity additionally compares complete same-run actual Native and Node public HTTP ProblemDetails, preserving raw wire bodies and validating request-specific trace IDs before full JSON comparison. Positive retained bytes do not claim native host/auth/model binding, SharedHttpStream.Open, spool, packet-copy, physical tuner, recording or final release acceptance.';
    await writeFile(path.join(output, 'comparison.json'), filterEvidenceJson(report, new Set([current?.accessToken].filter(Boolean))));
    await publication.publishAndClose();
  }
  if (failure) throw publication.publicError(failure);
  assert.equal(report.passed, true);
});
