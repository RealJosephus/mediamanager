import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { LiveStreamsService } from '../../src/playback/live-streams.js';
import { PlaybackService } from '../../src/playback/service.js';
import { md5Guid } from '../../src/core/identity.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const inputFile = new URL('./fixtures/live-stream-retained/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const bytesFor = value => Buffer.from(Array.from({ length: value.length }, (_value, index) => (index * 37 + value.seed) & 255));
const json = value => JSON.stringify(value, null, 2) + '\n';
const providerId = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider'), serviceId = md5Guid('Jellyfin.LiveTv.DefaultLiveTvService');
const channelId = 'a9c00000000000000000000000000001';
class Response extends Writable {
  constructor() { super({ highWaterMark: 1 }); this.statusCode = 200; this.headers = new Map(); this.headersSent = false; this.chunks = []; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  _write(chunk, _encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); setImmediate(done); }
}

async function observe(sample, bytes, native) {
  const owners = [], diagnostics = [], request = new EventEmitter(), response = new Response();
  request.method = sample.method; request.headers = sample.range ? { range: sample.range } : {};
  const completed = finished(response); void completed.catch(() => {});
  let streams, failure, result;
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
      probe: { async addMediaInfo() {} }, getLocalApiUrl: () => 'http://127.0.0.1:1', onError: error => diagnostics.push(error.message) });
    const opened = await streams.open({ OpenToken: providerId + '_LiveTvChannel_' + channelId + '_' + source.Id });
    assert.equal(opened.MediaSource.LiveStreamId, native.publicId);
    const unique = streams.snapshot()[0].UniqueId;
    assert.match(unique, /^[a-f0-9]{32}$/u); assert.equal(streams.snapshot()[0].ConsumerCount, 1);
    const publicLookups = [];
    for (const expected of native.lookups.slice(0, 5)) {
      let found = false, status = null;
      try { found = streams.getLiveStream(expected.id)?.Id === source.Id; }
      catch (error) { status = error.status; }
      assert.equal(found, expected.found); assert.equal(status, expected.error?.status ?? null);
      publicLookups.push({ found, status });
    }
    assert.equal(owners.filter(owner => owner.reader).length, 0, 'Public retained lookup must not acquire a byte reader.');
    assert.equal(streams.snapshot()[0].ConsumerCount, 1);
    const playback = new PlaybackService({ getLiveStreams: () => streams });
    const selected = sample.missing ? 'missing' : sample.upperUnique ? unique.toUpperCase() : unique;
    try { await playback.liveStreamFile(selected, sample.container).send(request, response); }
    catch (error) { if (error.status !== 404 || !sample.missing) throw error; response.statusCode = error.status; response.end(); }
    const outcome = await Promise.allSettled([completed]);
    if (sample.cancelAfter == null) assert.equal(outcome[0].status, 'fulfilled');
    else assert.equal(outcome[0].status, 'rejected', 'A deliberately aborted live consumer must not be reported as completed.');
    const payload = Buffer.concat(response.chunks), readers = owners.filter(owner => owner.reader);
    result = { name: sample.name, status: response.statusCode, contentType: response.headers.get('content-type') ?? null,
      contentLength: response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null,
      acceptRanges: response.headers.get('accept-ranges') ?? null, contentRange: response.headers.get('content-range') ?? null,
      bytes: payload.length, sha256: hash(payload), readers: readers.map(owner => ({ reads: owner.reads, bytes: owner.bytes, closes: owner.closes })),
      consumerCountAfterResult: streams.snapshot()[0].ConsumerCount, readerCountAfterResult: streams.snapshot()[0].ReaderCount,
      originalOwnerReads: owners.filter(owner => !owner.reader).map(owner => owner.reads), publicLookups, diagnostics: [...diagnostics] };
    if (sample.cancelAfter != null) result.explicitCancellation = { responseDestroyed: response.destroyed, readerReleased: readers.every(owner => owner.closed) };
    assert.equal(result.consumerCountAfterResult, 1); assert.equal(result.readerCountAfterResult, 0);
    assert.deepEqual(result.originalOwnerReads, [0], 'Byte delivery may consume only the independent retained reader.');
    assert.equal(readers.length, sample.missing ? 0 : 1);
    assert.ok(readers.every(owner => owner.closed && owner.closes === 1));
    if (sample.method === 'HEAD') assert.ok(readers.every(owner => owner.reads === 0 && owner.bytes === 0));
    await streams.closeLiveStream(native.publicId.toUpperCase()); assert.deepEqual(streams.snapshot(), []);
    assert.ok(owners.every(owner => owner.closed && owner.closes === 1));
    assert.deepEqual(diagnostics, []);
  } catch (error) { failure = error; }
  finally {
    response.destroy();
    await Promise.allSettled([completed]);
    try { await streams?.close(); } catch (error) { failure ??= error; }
    if (owners.some(owner => !owner.closed || owner.closes !== 1)) failure ??= new Error('A retained source or reader survived close.');
  }
  return { result, failure, owners };
}

test('retained live bytes match actual controller and progressive result with independent reader ownership', { skip: !enabled, timeout: 300000 }, async t => {
  const output = path.join(validationOutputRoot(), 'live-stream-retained-' + randomUUID()); await mkdir(output);
  const privateRoot = path.join(output, 'private-inputs');
  const report = { cases: [], cleanup: [], phaseAcceptance: false, releaseAcceptance: false }; let current, failure;
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
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
    assert.equal(native.lookups[0].sameSource, true); assert.equal(native.lookups[0].directProvider, true);
    assert.ok(native.lookups.slice(0, 3).every(value => value.infoMatched && value.getLiveStreamMatched));
    assert.equal(native.lookups[1].sameSource, true); assert.equal(native.lookups[2].found, false);
    assert.equal(native.lookups[3].error.status, 400); assert.equal(native.lookups[4].error.status, 400);
    assert.equal(native.lookups[5].directProvider, false);
    assert.equal(native.timeout.first, bytes.length); assert.equal(native.timeout.eof, 0); assert.equal(native.timeout.sha256, hash(bytes));
    report.nativeLookups = native.lookups; report.nativeExplicitTimeout = native.timeout;
    report.nativePreparedFiles = native.fileCases;
    for (const [index, sample] of input.fileCases.entries()) {
      const expected = native.fileCases[index], prepared = bytesFor(sample);
      assert.equal(expected.actualBaseLiveStreamGetStream, true); assert.equal(expected.inputUnchanged, true);
      assert.equal(expected.preparedSourceSha256, hash(prepared));
      if (sample.missing) { assert.equal(expected.error.status, 404); assert.equal(expected.error.type, 'FileNotFoundException'); }
      else {
        const offset = sample.ageSeconds > 10 && prepared.length >= 20000 ? prepared.length - 20000 : 0;
        assert.equal(expected.position, offset); assert.equal(expected.bytes, prepared.length - offset); assert.equal(expected.sha256, hash(prepared.subarray(offset)));
      }
    }
    for (const sample of input.controllerCases) await t.test(sample.name, { timeout: 30000 }, async () => {
      const expected = native.results.find(value => value.name === sample.name), observed = await observe(sample, bytes, native);
      const record = { name: sample.name, actual: observed.result, native: expected, owners: observed.owners, passed: false }; report.cases.push(record);
      try {
        if (observed.failure) throw observed.failure;
        const fields = ['status', 'contentType', 'contentLength', 'acceptRanges', 'contentRange', 'bytes', 'sha256', 'consumerCountAfterResult'];
        assert.deepEqual(Object.fromEntries(fields.map(name => [name, observed.result[name]])), Object.fromEntries(fields.map(name => [name, expected[name]])));
        assert.equal(expected.openCalls, 0);
        assert.equal(expected.getStreamCalls, sample.missing ? 0 : 1);
        assert.equal(expected.actualProgressive, !sample.missing);
        assert.ok(expected.readers.every(reader => reader.DisposeCalls === 1));
        if (!sample.missing) { assert.equal(expected.canSeek, false); assert.equal(expected.lengthError.type, 'NotSupportedException'); }
        if (sample.method === 'HEAD') assert.ok(expected.readers.every(reader => reader.ReadCalls === 0 && reader.BytesRead === 0));
        if (sample.cancelAfter != null) { assert.equal(expected.requestAborted, true);
          if (expected.executionFailure) assert.match(expected.executionFailure.type, /^(?:OperationCanceledException|TaskCanceledException)$/u);
          else assert.equal(expected.contextAborted, true);
          assert.deepEqual(observed.result.explicitCancellation, { responseDestroyed: true, readerReleased: true }); }
        record.passed = true;
      } catch (error) { record.error = error.stack; throw error; }
    });
    report.inputSha256 = hash(inputBytes); report.nativeOutputSha256 = hash(nativeBytes);
  } catch (error) { failure = error; report.error = error.stack; }
  finally {
    if (current) try { await current.finish(); report.cleanup.push({ protectedInputsUnchanged: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ protectedInputsUnchanged: false, error: error.message }); }
    try { assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-inputs'); await rm(privateRoot, { recursive: true, force: true }); report.cleanup.push({ privateInputsRemoved: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ privateInputsRemoved: false, error: error.message }); }
    report.passed = !failure && report.cases.length === input.controllerCases.length && report.cases.every(value => value.passed);
    report.boundary = 'Actual retained MediaSourceManager lookup, LiveTvController, MVC FileStreamResult executor and ProgressiveFileStream over controlled memory ILiveStream; base LiveStream.GetStream reads prewritten private fixture inputs only. Node executes actual public registry, PlaybackService and BinaryResult with controlled tuner/probe and writable response component. No native host/auth/model-binding claim, SharedHttpStream.Open, spool, packet-copy, physical tuner, recording or final release acceptance.';
    await writeFile(path.join(output, 'comparison.json'), json(report));
  }
  if (failure) throw failure;
  assert.equal(report.passed, true);
});
