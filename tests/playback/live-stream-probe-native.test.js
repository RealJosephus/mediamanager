import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LiveStreamProbe, addLiveMediaInfo } from '../../src/playback/live-stream-probe.js';
import { readLiveMediaInfoCache } from '../../src/playback/live-stream-info.js';
import { md5Guid } from '../../src/core/identity.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wire = value => parseLosslessJson(stringifyNativeJson(value));
const infoOnly = ['Chapters', 'Album', 'Artists', 'AlbumArtists', 'Studios', 'Genres', 'ShowName', 'ForcedSortName', 'IndexNumber', 'ParentIndexNumber', 'ProductionYear', 'PremiereDate', 'People', 'ProviderIds', 'OfficialRating', 'OfficialRatingDescription', 'Overview'];
const sourceFrom = text => { const value = readLiveMediaInfoCache(Buffer.from(text)); for (const field of infoOnly) delete value[field]; return value; };
const exception = cause => cause.nativeException ?? (cause.name === 'AbortError' ? 'TaskCanceledException' : cause.name === 'BindingError' || cause.status === 400 ? 'JsonException'
  : ['EACCES', 'EPERM', 'EISDIR'].includes(cause.code) ? 'UnauthorizedAccessException' : cause.code ? 'IOException' : cause.name);
const encode = value => Buffer.from(value).toString('base64');
function barrier(pending, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    const complete = callback => value => { signal.removeEventListener('abort', aborted); callback(value); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(pending).then(complete(resolve), complete(reject));
  });
}
const source = changes => JSON.stringify({ Id: 'native-component', Path: '/controlled/original.ts', Protocol: 'File', SupportsDirectStream: false,
  IsInfiniteStream: true, RunTimeTicks: null, AnalyzeDurationMs: 0, RequiredHttpHeaders: { 'X-Controlled': 'retained' },
  MediaStreams: [{ Type: 'Video', Index: -1, Width: 1920, Height: 1080, Codec: 'h264', IsAVC: false }, { Type: 'Audio', Index: -1, Codec: 'ac3' }], ...changes });
const information = JSON.stringify({ Bitrate: 99, Container: 'mpegts', Formats: ['mpegts'], Size: '9007199254740993', RunTimeTicks: '123456789', Timestamp: 'Valid', VideoType: 'VideoFile',
  MediaStreams: [{ Type: 'Video', Index: 2, Width: 1920, Height: 1080, Language: 'eng', Codec: 'h264', IsAVC: false },
    { Type: 'Video', Index: 3, Width: 720, Codec: 'mpeg2video' }, { Type: 'Audio', Index: 4, Language: 'fra', Codec: 'ac3', BitRate: 448000 },
    { Type: 'Audio', Index: 5, Codec: 'aac' }, { Type: 'Subtitle', Index: 6, Language: 'eng', Codec: 'srt' }] });
const providerPrefix = md5Guid('ProbeProvider') + '_';
const action = changes => ({ mode: 'helper', addProbeDelay: false, source: source(), information, ...changes });

function definitions() {
  return { typed: [
    { name: 'defaults', body: '{}' }, { name: 'null', body: 'null' },
    { name: 'quoted-numbers-and-case', body: '{"Size":"9007199254740993","size":"bad","Bitrate":"42","Container":true,"IndexNumber":"-2","Unknown":{},"MediaStreams":[{"Type":"Video","Index":"3","Width":"1920","AverageFrameRate":"29.97","IsAVC":null,"Language":"eng","DisplayTitle":"ignored","VideoRange":"ignored"}]}' },
    { name: 'null-collections', body: '{"MediaStreams":null,"Formats":null,"Chapters":null,"Artists":null,"ProviderIds":null}' },
    { name: 'dictionary-case-and-null', body: '{"ProviderIds":{"Tmdb":"1","tmdb":"2","Null":null},"RequiredHttpHeaders":{"X-Test":"value","Null":null}}' },
    { name: 'invalid-earlier-duplicate', body: '{"Bitrate":"bad","Bitrate":42}' },
    { name: 'boolean-remains-strict', body: '{"SupportsProbing":"false"}' },
    { name: 'unknown-case-ignored', body: '{"mediaStreams":[null],"bitrate":"bad","SUPPORTSPROBING":false}' },
  ], cases: [
    { name: 'miss-then-hit-retains-full-cache-before-first-av', cacheKey: 'cache AV', actions: [action({}), action({ probeFailure: 'IOException' })] },
    { name: 'no-key-retains-all-streams-and-runtime', cacheKey: null, actions: [action({ source: source({ RunTimeTicks: '10', IsInfiniteStream: true }) })] },
    { name: 'empty-key-disables-cache', cacheKey: '', actions: [action({})] },
    { name: 'null-cache-is-miss', cacheKey: 'null cache', cacheBase64: encode('null'), actions: [action({})] },
    { name: 'nontruncate-bad-tail-reprobes', cacheKey: 'short-write', cacheBase64: encode('x'.repeat(16000)), actions: [action({ information: '{}' }), action({ information: '{}' })] },
    { name: 'typed-invalid-cache-reprobes', cacheKey: 'bad type', cacheBase64: encode('{"Bitrate":"bad","Bitrate":42}'), actions: [action({})] },
    { name: 'unknown-case-cache-is-hit', cacheKey: 'unknown case', cacheBase64: encode('{"mediastreams":[null],"bitrate":"bad"}'), actions: [action({ probeFailure: 'IOException' })] },
    { name: 'null-probe-is-written-before-failure', cacheKey: 'null result', actions: [action({ information: 'null' })] },
    { name: 'null-streams-written-before-failure', cacheKey: 'null streams', actions: [action({ information: '{"MediaStreams":null}' })] },
    { name: 'null-stream-member-written-before-failure', cacheKey: 'null member', actions: [action({ information: '{"MediaStreams":[null]}' })] },
    { name: 'probe-failure-fallback-preserves-known-bitrate', cacheKey: 'failed', actions: [action({ mode: 'helper-fallback', probeFailure: 'IOException', source: source({ Bitrate: 123 }) })] },
    { name: 'fallback-width-estimate', cacheKey: null, actions: [action({ mode: 'fallback-only', source: source({ MediaStreams: [{ Type: 'Video', Index: -1, Width: 3000 }, { Type: 'Audio', Index: 7, BitRate: 256000 }] }) })] },
    { name: 'manager-skip-known-index', cacheKey: providerPrefix + 'component', actions: [action({ mode: 'manager', source: source({ LiveStreamId: providerPrefix + 'controlled', MediaStreams: [{ Type: 'Video', Index: 1, Width: 1280 }, { Type: 'Audio', Index: 2, BitRate: 128000 }] }) })] },
    { name: 'manager-hit-native-cache', cacheKey: providerPrefix + 'component', cacheBase64: encode(information), actions: [action({ mode: 'manager', probeFailure: 'IOException', source: source({ LiveStreamId: providerPrefix + 'controlled' }) })] },
    { name: 'manager-probe-failure-after-delay', cacheKey: providerPrefix + 'component', actions: [action({ mode: 'manager', addProbeDelay: true, probeFailure: 'IOException', source: source({ LiveStreamId: providerPrefix + 'controlled' }) })] },
    { name: 'manager-cancel-during-delay-falls-back', cacheKey: providerPrefix + 'component', actions: [action({ mode: 'manager', cancelAfterMs: 40, addProbeDelay: true, source: source({ AnalyzeDurationMs: 5000, LiveStreamId: providerPrefix + 'controlled' }) })] },
    { name: 'manager-cancel-inside-encoder-falls-back', cacheKey: providerPrefix + 'component', actions: [action({ mode: 'manager', holdUntilCancel: true, addProbeDelay: true, source: source({ LiveStreamId: providerPrefix + 'controlled' }) })] },
  ] };
}

async function disk(filename) { return fs.readFile(filename).then(bytes => bytes.toString('base64'), cause => cause.code === 'ENOENT' ? null : Promise.reject(cause)); }
async function observeNode(sample, root, { io = fs } = {}) {
  await fs.mkdir(root, { recursive: true }); const filename = path.join(root, 'mediainfo', md5Guid(sample.cacheKey ?? '') + '.json');
  if (sample.cacheBase64 !== undefined) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, Buffer.from(sample.cacheBase64, 'base64')); }
  const observations = [];
  for (const step of sample.actions) {
    const current = sourceFrom(step.source), calls = [], logs = [], start = performance.now(), request = new AbortController(); let timer, error = null, clone = null;
    if (step.cancelAfterMs !== undefined) timer = setTimeout(() => request.abort(), step.cancelAfterMs);
    const before = await disk(filename), probe = new LiveStreamProbe({ cachePath: root, fileSystem: io,
      onError: cause => logs.push(exception(cause)), probeFile: async (value, options) => {
        calls.push({ MediaType: 'Video', ExtractChapters: options.extractChapters, AnalyzeDurationMs: value.AnalyzeDurationMs,
          Path: value.Path, Protocol: value.Protocol, RequiredHttpHeaders: wire(value.RequiredHttpHeaders), elapsedMs: performance.now() - start, canCancel: options.signal instanceof AbortSignal });
        if (step.holdUntilCancel) {
          timer = setTimeout(() => request.abort(), 40);
          await new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
        }
        if (step.probeFailure) throw Object.assign(new Error('Controlled media probe failure.'), { nativeException: step.probeFailure });
        return readLiveMediaInfoCache(Buffer.from(step.information));
      } });
    try {
      if (step.mode === 'fallback-only') addLiveMediaInfo(current);
      else try { await probe.addMediaInfo(current, { cacheKey: sample.cacheKey, signal: request.signal, addProbeDelay: step.mode === 'manager' || step.addProbeDelay }); }
      catch (cause) { if (!['manager', 'helper-fallback'].includes(step.mode)) throw cause; logs.push(exception(cause)); addLiveMediaInfo(current); }
      if (step.mode === 'manager') clone = wire(current);
    } catch (cause) { error = exception(cause); }
    finally { clearTimeout(timer); await probe.close(); }
    observations.push({ error, source: wire(current), clone, calls, logs, cacheBefore: before, cacheAfter: await disk(filename), elapsedMs: performance.now() - start });
  }
  return observations;
}
function comparable(value) {
  const cache = encoded => {
    if (encoded == null) return null;
    const bytes = Buffer.from(encoded, 'base64');
    try { return { kind: 'typed-value', value: wire(readLiveMediaInfoCache(bytes)) }; }
    catch (cause) { return { kind: 'invalid-json', error: exception(cause), length: bytes.length }; }
  };
  const normalize = input => {
    const result = { ...input, logs: (input.logs ?? []).map(value => typeof value === 'string' ? value : value.exception),
      calls: input.calls.map(({ elapsedMs: _elapsed, ...call }) => call), cacheBefore: cache(input.cacheBefore), cacheAfter: cache(input.cacheAfter) };
    delete result.elapsedMs; delete result.owner; return wire(result);
  };
  return normalize(value);
}

test('live stream probe uses actual native helper/manager and bidirectional typed MediaInfo caches with real files and failure prefixes', { skip: !enabled, timeout: 300000 }, async () => {
  const root = path.join(validationOutputRoot(), 'live-stream-probe-' + randomUUID()); await fs.mkdir(root);
  const input = definitions(), report = { typed: [], comparisons: [], cleanup: {},
    nodeProductionHelperExecuted: true, nodeProductionManagerExecuted: false, nodeManagerCatchWrapperControlled: true }; let failure;
  try {
    const reference = await currentNativeReference(); report.sourceBindings = await reference.sourceBindings([
      'Emby.Server.Implementations/Library/LiveStreamHelper.cs', 'Emby.Server.Implementations/Library/MediaSourceManager.cs',
      'MediaBrowser.Model/MediaInfo/MediaInfo.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs', 'MediaBrowser.Model/Entities/MediaStream.cs',
      'MediaBrowser.Controller/MediaEncoding/MediaInfoRequest.cs', 'MediaBrowser.Controller/Library/ILiveStream.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs']);
    const produced = await observeNode(input.cases[0], path.join(root, 'node-cache-producer'));
    const nodeCache = produced[0].cacheAfter; assert.ok(nodeCache);
    input.typed.push({ name: 'actual-native-reads-node-produced-cache', body: Buffer.from(nodeCache, 'base64').toString('utf8') });
    input.cases.push({ name: 'native-helper-reads-node-produced-cache', cacheKey: 'node producer', cacheBase64: nodeCache, actions: [action({ probeFailure: 'IOException' })] });
    report.nodeProducedCacheSha256 = sha(Buffer.from(nodeCache, 'base64'));
    const inputBytes = Buffer.from(JSON.stringify(input)), filename = path.join(root, 'input.json'); await fs.writeFile(filename, inputBytes, { flag: 'wx' });
    const receipt = await recordOracle({ project: 'tests/playback/fixtures/live-stream-probe/Oracle.csproj', output: path.join(root, 'native'), args: [filename, '{output}/native.json'] });
    const nativeBytes = await fs.readFile(path.join(root, 'native/native.json')), native = parseLosslessJson(nativeBytes.toString());
    assert.ok(receipt.passed && native.actualLiveStreamHelper && native.actualMediaSourceManagerOpen && native.actualMediaSourceManagerAdd && native.actualTypedMediaInfo && native.privateInputsRemoved);
    assert.equal(native.controlledEncoder, true); assert.equal(native.nativeFfprobeExecuted, false); assert.equal(native.nativeStreamOpenExecuted, false); assert.equal(native.recordingOrTranscodingStarted, false);
    assert.equal(native.providerPrefix, providerPrefix); assert.equal(native.inputSha256, sha(inputBytes));
    for (const assembly of native.assemblies) assert.equal(sha(await fs.readFile(assembly.filename)), assembly.sha256);
    report.inputSha256 = sha(inputBytes); report.nativeSha256 = sha(nativeBytes);
    for (const sample of input.typed) {
      let value = null, error = null; try { value = readLiveMediaInfoCache(Buffer.from(sample.body)); } catch (cause) { error = exception(cause); }
      const actual = wire({ name: sample.name, value, error }), expected = native.typed.find(value => value.name === sample.name);
      report.typed.push({ actual, expected }); assert.deepEqual(actual, expected, sample.name);
    }
    for (const sample of input.cases) {
      const expected = native.results.find(value => value.name === sample.name).observations, observed = await observeNode(sample, path.join(root, 'node', sample.name));
      for (const [index, value] of observed.entries()) {
        const target = expected[index], actual = comparable(value), expectation = comparable(target);
        report.comparisons.push({ name: sample.name, index, actual, expected: expectation, actualElapsedMs: value.elapsedMs, nativeElapsedMs: target.elapsedMs,
          raw: { actual: value, expected: target }, cacheHashes: { actualBefore: value.cacheBefore == null ? null : sha(Buffer.from(value.cacheBefore, 'base64')),
            actualAfter: value.cacheAfter == null ? null : sha(Buffer.from(value.cacheAfter, 'base64')), nativeBefore: target.cacheBefore == null ? null : sha(Buffer.from(target.cacheBefore, 'base64')),
            nativeAfter: target.cacheAfter == null ? null : sha(Buffer.from(target.cacheAfter, 'base64')) } });
        assert.deepEqual(actual, expectation, sample.name + ':' + index);
        assert.equal(target.owner.OpenCalls, 0); assert.equal(target.owner.ReadCalls, 0);
        if (sample.actions[index].mode === 'manager') { assert.equal(target.owner.CloseCalls, 1); assert.equal(target.owner.ConsumerCount, 0); }
        for (const observation of [value, target]) for (const call of observation.calls) {
          const requiredDelay = sample.actions[index].mode === 'manager' || sample.actions[index].addProbeDelay;
          assert.equal(call.AnalyzeDurationMs, 3000); if (requiredDelay) assert.ok(call.elapsedMs >= 2990, 'The actual probe must start after its minimum delay.');
        }
      }
    }
    // A fresh Node typed reader consumes the actual native serialized cache,
    // independently of the response snapshots and the Node-produced cache.
    const nativeCache = native.results[0].observations[0].cacheAfter;
    const cross = { name: 'node-helper-reads-native-cache', cacheKey: 'native producer', cacheBase64: nativeCache, actions: [action({ probeFailure: 'IOException' })] };
    const observed = await observeNode(cross, path.join(root, 'native-cache-consumer'));
    assert.equal(observed[0].calls.length, 0); assert.deepEqual(observed[0].source, native.results[0].observations[1].source);
    assert.equal(observed[0].cacheAfter, nativeCache); report.nativeProducedCacheSha256 = sha(Buffer.from(nativeCache, 'base64')); report.crossCache = observed;
    for (const entry of report.comparisons.filter(value => value.name === 'nontruncate-bad-tail-reprobes')) {
      for (const value of [entry.raw.actual, entry.raw.expected]) {
        const after = Buffer.from(value.cacheAfter, 'base64'), before = Buffer.from(value.cacheBefore, 'base64');
        assert.equal(after.length, 16000); assert.equal(value.calls.length, 1);
        assert.equal(after[0], 123); assert.equal(after.at(-1), 120);
        let writtenPrefixLength = after.length; while (writtenPrefixLength && after[writtenPrefixLength - 1] === 120) writtenPrefixLength--;
        assert.ok(writtenPrefixLength > 0 && writtenPrefixLength < after.length); assert.equal(after[writtenPrefixLength - 1], 125);
        assert.deepEqual(after.subarray(writtenPrefixLength), before.subarray(writtenPrefixLength));
      }
    }
    report.cleanup.nativePrivateInputsRemoved = native.privateInputsRemoved; report.cleanup.nodeProbeOwnersClosed = true;
  } catch (cause) { failure = cause; }
  finally { await fs.writeFile(path.join(root, 'comparison.json'), stringifyNativeJson({ ...report, passed: !failure, phaseAcceptance: false, releaseAcceptance: false,
    actualFfprobeExecuted: false, publicPlaybackValidated: false, error: failure?.stack }) + '\n'); }
  if (failure) throw failure;
});

test('live probe close waits for an admitted real cache write and file close before finishing', { timeout: 30000 }, async t => {
  const root = path.join(validationOutputRoot(), 'live-probe-held-write-' + randomUUID()); await fs.mkdir(root);
  const entered = Promise.withResolvers(), released = Promise.withResolvers(); let closes = 0, delivered = false;
  const finish = () => released.resolve(); t.signal.addEventListener('abort', finish, { once: true });
  const files = { ...fs, async open(...args) {
    const file = await fs.open(...args);
    return { async write(...args) { entered.resolve(); await released.promise; return file.write(...args); }, async close() { closes++; await file.close(); } };
  } };
  const probe = new LiveStreamProbe({ cachePath: root, fileSystem: files, probeFile: async () => readLiveMediaInfoCache(Buffer.from('{}')) });
  const item = sourceFrom(source()), filename = path.join(root, 'mediainfo', md5Guid('held-write') + '.json');
  try {
    const pending = probe.addMediaInfo(item, { cacheKey: 'held-write', addProbeDelay: false }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await barrier(entered.promise, t.signal); const closing = probe.close().then(() => { delivered = true; });
    await assert.rejects(probe.addMediaInfo(item, {}), /closed/); await new Promise(resolve => setImmediate(resolve)); assert.equal(delivered, false); assert.equal(closes, 0);
    finish(); await rejected; await closing; assert.equal(closes, 1); assert.equal(delivered, true);
    assert.equal(item.AnalyzeDurationMs, 3000); assert.equal(item.MediaStreams[0].Index, -1); assert.equal(item.MediaStreams[0].Codec, 'h264');
    const bytes = await fs.readFile(filename); assert.deepEqual(wire(readLiveMediaInfoCache(bytes)), wire(readLiveMediaInfoCache(Buffer.from('{}'))));
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ passed: true, fileClosed: closes, sha256: sha(bytes), cacheWriteCompletedBeforeClose: delivered,
      controlledWriteSuspension: true, nativeEquivalentSuspensionClaimed: false, phaseAcceptance: false, releaseAcceptance: false }) + '\n');
  } finally { finish(); await probe.close(); }
});

test('live probe close drains a real private HTTP reader and held cleanup without starting ffprobe or leaving its URL open', { timeout: 30000 }, async t => {
  const root = path.join(validationOutputRoot(), 'live-probe-held-reader-' + randomUUID()); await fs.mkdir(root);
  const read = Promise.withResolvers(), closeStarted = Promise.withResolvers(), releaseClose = Promise.withResolvers(), pendingRead = Promise.withResolvers();
  let opened = 0, closes = 0, servedUrl, closed = false;
  const finish = () => { releaseClose.resolve(); pendingRead.resolve({ done: true }); }; t.signal.addEventListener('abort', finish, { once: true });
  const probe = new LiveStreamProbe({ cachePath: root, probe: async (url, options) => {
    servedUrl = url; const response = await fetch(url, { signal: options.signal }), reader = response.body.getReader();
    try {
      assert.equal(Buffer.from((await reader.read()).value).toString(), 'controlled original bytes'); read.resolve();
      await new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      throw new Error('A canceled controlled probe cannot publish a result.');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } });
  const openRead = async ({ signal }) => {
    opened++; let offset = 0, closing;
    const close = () => closing ??= (async () => { closes++; closeStarted.resolve(); await releaseClose.promise; pendingRead.resolve({ done: true }); })();
    signal.addEventListener('abort', () => { void close(); }, { once: true });
    return { stream: { [Symbol.asyncIterator]() { return this; }, next() { return ++offset === 1 ? Promise.resolve({ done: false, value: Buffer.from('controlled original bytes') }) : pendingRead.promise; },
      async return() { await close(); return { done: true }; } }, close };
  };
  try {
    const item = sourceFrom(source({ Protocol: 'Http', Path: 'http://fixture.invalid/original' }));
    const pending = probe.addMediaInfo(item, { cacheKey: 'held-reader', addProbeDelay: false, openRead }), rejected = assert.rejects(pending, { name: 'AbortError' });
    await barrier(read.promise, t.signal); const closing = probe.close().then(() => { closed = true; }); await barrier(closeStarted.promise, t.signal);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(opened, 1); assert.equal(closes, 1);
    finish(); await rejected; await closing; assert.equal(closed, true); assert.equal(closes, 1);
    await assert.rejects(fetch(servedUrl)); assert.equal(await disk(path.join(root, 'mediainfo', md5Guid('held-reader') + '.json')), null);
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify({ passed: true, readersOpened: opened, readersClosed: closes, privateHttpClosed: closed,
      controlledProbe: true, ffprobeExecuted: false, phaseAcceptance: false, releaseAcceptance: false }) + '\n');
  } finally { finish(); await probe.close(); }
});
