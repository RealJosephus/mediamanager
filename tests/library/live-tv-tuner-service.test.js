import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { PluginHost } from '../../src/plugins/host.js';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { LiveTvSourcesService } from '../../src/library/live-tv-sources-service.js';
import { LiveTvTunerService } from '../../src/library/live-tv-tuner-service.js';
import { deserializeLiveTvConfiguration } from '../../src/http/live-tv-configuration-binding.js';
import { controlledProviderFailure } from './live-tv-failure-control.js';

const failureFields = error => ({ message: error?.message, code: error?.code ?? null,
  status: error?.status ?? error?.statusCode ?? null });

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plugin = fileURLToPath(new URL('./fixtures/live-tv-tuner-service/plugin/', import.meta.url));
const sourceInfo = { Id: 'native_controlled', Path: 'http://fixture.invalid/native', Protocol: 'Http', SupportsTranscoding: true,
  UseMostCompatibleTranscodingProfile: true, RequiredHttpHeaders: { 'X-Fixture': 'retained' } };

function fixture() {
  const channel = { Id: 'Same', Name: 'First channel', Number: '1', TunerHostId: 'tuner-first', TunerChannelId: null };
  const other = { Id: 'SAME', Name: 'Second channel', Number: '2', TunerHostId: 'tuner-second', TunerChannelId: null };
  const tuner = (type, channels = [], changes = {}) => ({ type, channels, ...changes });
  const tuners = () => [tuner('first', [channel]), tuner('second', [other]), tuner('unsupported', [], { isSupported: false })];
  const sample = (name, operation, values = {}) => ({ name, operation, tuners: tuners(), ...values });
  return { configuration: { ListingProviders: [{ Id: 'controlled-listing', Type: 'controlled' }] },
    epgChannels: [{ Id: 'same', Name: 'EPG channel', Number: '1', ImageUrl: 'http://fixture.invalid/guide-image' }], cases: [
      sample('channel hosts precede metadata and public enumeration disables cache', 'channels'),
      sample('channel failures including cancellation are caught per host', 'channels', { tuners: [
        tuner('first', [], { channelsFailure: 'IOException' }), tuner('second', [other]), tuner('third', [], { channelsFailure: 'OperationCanceledException' })] }),
      sample('all channel host failures return empty after metadata consumer', 'channels', { tuners: [
        tuner('first', [], { channelsFailure: 'IOException' }), tuner('second', [], { channelsFailure: 'OperationCanceledException' })] }),
      sample('metadata provider failure retains tuner channels', 'channels', { listingsFailure: 'IOException' }),
      sample('metadata unsupported provider is swallowed', 'channels', { listingsFailure: 'NotSupportedException' }),
      sample('program lookup refreshes cached channels and selects the first ignore-case id', 'programs', { channelId: 'sAME' }),
      sample('program lookup missing channel fails after channel metadata', 'programs', { channelId: 'missing' }),
      sample('program lookup metadata failure is retried by program consumer and propagates', 'programs', { channelId: 'same', listingsFailure: 'IOException' }),
      sample('program provider failure propagates after metadata', 'programs', { channelId: 'same', programsFailure: 'NotSupportedException' }),
      sample('media source selection skips only unimplemented and empty providers', 'sources', { channelId: 'same', tuners: [
        tuner('first', [], { sourcesFailure: 'NotImplementedException' }), tuner('second'), tuner('third', [], { sources: [sourceInfo] })] }),
      sample('all empty media sources throw unimplemented', 'sources', { channelId: 'same' }),
      sample('media source unsupported is not a fallback', 'sources', { channelId: 'same', tuners: [
        tuner('first', [], { sourcesFailure: 'NotSupportedException' }), tuner('second', [], { sources: [sourceInfo] })] }),
      sample('media source io failure is not a fallback', 'sources', { channelId: 'same', tuners: [
        tuner('first', [], { sourcesFailure: 'IOException' }), tuner('second', [], { sources: [sourceInfo] })] }),
      sample('media source cancellation is not a fallback', 'sources', { channelId: 'same', tuners: [
        tuner('first', [], { sourcesFailure: 'OperationCanceledException' }), tuner('second', [], { sources: [sourceInfo] })] }),
      sample('null media channel id fails before providers', 'sources', { channelId: null }),
      sample('blank media channel id fails before providers', 'sources', { channelId: '\u2003' }),
    ] };
}

async function open(root, tuners, invoke, configuration = fixture().configuration) {
  const configurationDirectoryPath = path.join(root, 'config'), cachePath = path.join(root, 'cache');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(configurationDirectoryPath); await fs.mkdir(cachePath);
  let plugins, liveTv, sources, service;
  const close = async () => {
    const failures = [];
    for (const owner of [service, sources, liveTv, plugins]) try { await owner?.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'The tuner fixture owners failed to close.');
  };
  try {
    plugins = await PluginHost.open({ directory: path.join(root, 'plugins'), preinstalled: false,
      options: { 'tuner-service-controls': { tuners, invoke } } });
    await plugins.install(plugin);
    liveTv = new LiveTvService({ configurationDirectoryPath });
    await liveTv.saveConfiguration(deserializeLiveTvConfiguration({ source: JSON.stringify(configuration) }));
    sources = new LiveTvSourcesService({ liveTv, plugins, fileSystem: fs, cachePath, refreshGuide() { throw new Error('Reader operations cannot queue guide refresh.'); } });
    service = new LiveTvTunerService({ plugins, sources });
    return { service, sources, liveTv, plugins, close };
  } catch (error) { await close(); throw error; }
}

const projectChannel = channel => Object.fromEntries(['Id', 'Name', 'Number', 'TunerHostId', 'TunerChannelId', 'ImageUrl'].map(name => [name, channel[name] ?? null]));
const projectSource = source => Object.fromEntries(['Id', 'Path', 'Protocol', 'SupportsTranscoding', 'UseMostCompatibleTranscodingProfile', 'RequiredHttpHeaders']
  .map(name => [name, source.mediaSource[name] ?? null]));

const streamState = values => values.map(value => ({ OriginalStreamId: value.OriginalStreamId, ConsumerCount: value.ConsumerCount,
  EnableStreamSharing: value.EnableStreamSharing, MediaSourceId: value.MediaSource.Id }));
function controlledInput(source = sourceInfo) {
  const owners = new Set(), input = { enabled: true, closes: 0 };
  const sharing = { get enabled() { return input.enabled && owners.size > 0; }, retain: () => acquire() };
  const acquire = () => {
    const owner = {}; owners.add(owner); let closed = false;
    return { mode: 'native', tunerHostId: 'controlled', mediaSource: structuredClone(source), sharing, close() {
      if (closed) return; closed = true; owners.delete(owner); if (!owners.size) input.closes++;
    } };
  };
  return Object.assign(input, { acquire });
}

function controlledBytes() {
  const records = [];
  const sharing = { get enabled() { return records.some(record => !record.closed); }, retain: () => acquire() };
  const acquire = () => {
    const record = { closed: false, closes: 0, returns: 0, reads: [], readStarted: Promise.withResolvers(), closeStarted: Promise.withResolvers() };
    records.push(record);
    const iterator = { next() { const pending = Promise.withResolvers(); record.reads.push(pending); record.readStarted.resolve(); return pending.promise; },
      return() { record.returns++; return { done: true }; } };
    return { mode: 'native', tunerHostId: 'controlled', mediaSource: sourceInfo, sharing, stream: { [Symbol.asyncIterator]: () => iterator }, async close() {
      if (record.closed) return; record.closed = true; record.closes++; record.reads.forEach(pending => pending.resolve({ done: true }));
      record.closeStarted.resolve(); await record.closeGate?.promise;
    } };
  };
  return { records, sharing, acquire };
}

async function streamPipeline(t, invoke) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-stream-consumer-')); let pipeline;
  t.after(async () => { try { await pipeline?.close(); } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^mm-stream-consumer-/u);
    await fs.rm(root, { recursive: true, force: true });
  } });
  pipeline = await open(root, [{ type: 'controlled', channels: [] }], invoke); return pipeline;
}

function streamFixture() {
  const host = (type, failure) => ({ type, channels: [], streamSource: sourceInfo, ...(failure ? { streamFailure: failure } : {}) });
  const seed = (originalStreamId, enabled = true) => ({ originalStreamId, enabled });
  const sample = (name, originalStreamId, seeds = [], tuners = [host('first')], channelId = 'channel') => ({ name, originalStreamId, seeds, tuners, channelId });
  return { cases: [], streamSource: sourceInfo, streamCases: [
    sample('new stream preserves unrelated original identity', 'different-original'),
    sample('reuse ignores original id case and channel id before providers', 'mIxEd', [seed('MiXeD')], [host('never', 'IOException')], 'other-channel'),
    sample('first matching disabled input blocks a later matching enabled input', 'same', [seed('SAME', false), seed('same')]),
    sample('first enabled duplicate alone gains a consumer', 'same', [seed('SAME'), seed('same')]),
    sample('unmatched earlier input retains its registry order', 'same', [seed('other'), seed('SAME')]),
    sample('empty original key bypasses reuse and is passed empty', '', [seed('')]),
    sample('null original key bypasses reuse and is passed null', null, [seed(null)]),
    sample('whitespace original key participates in exact matching', ' \t', [seed(' \t')]),
    sample('ordinal matching preserves dotted I distinction', 'i', [seed('İ')]),
    sample('not found and controlled cancellation fall through in provider order', 'key', [], [host('missing', 'FileNotFoundException'), host('canceled', 'OperationCanceledException'), host('last')]),
    sample('all missing and controlled canceled providers end with resource not found', 'key', [], [host('missing', 'FileNotFoundException'), host('canceled', 'OperationCanceledException')]),
    sample('io is not a stream fallback', 'key', [], [host('io', 'IOException'), host('later')]),
    sample('unimplemented is not a stream fallback', 'key', [], [host('unimplemented', 'NotImplementedException'), host('later')]),
    sample('unsupported is not a stream fallback', 'key', [], [host('unsupported', 'NotSupportedException'), host('later')]),
  ] };
}

test('byte reader holds preserve the actual tuner host without becoming public stream consumers', async t => {
  const input = controlledBytes(), gate = Promise.withResolvers();
  const pipeline = await streamPipeline(t, (_kind, operation) => {
    assert.equal(operation, 'stream'); return input.acquire();
  });
  const options = { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: [] };
  let first, second, reader, reading, closing;
  try {
    first = await pipeline.service.getChannelStream('channel', 'original', options);
    options.currentLiveStreams = [first];
    reader = await first.forkRead();
    assert.equal(reader.tunerHostId, 'controlled');
    assert.equal(pipeline.service.getLiveStreams()[0].TunerHostId, 'controlled');
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 1);
    reading = reader.stream.next(); void reading.catch(() => {}); await input.records[1].readStarted.promise;
    second = await pipeline.service.getChannelStream('other-channel', 'ORIGINAL', options);
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 2);
    await first.close();
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 1);
    assert.equal(input.records[1].closed, false, 'Closing one public consumer preserves another consumer\'s reader.');
    input.records[1].closeGate = gate;
    let drained = false; closing = second.close().then(() => { drained = true; });
    await input.records[1].closeStarted.promise; await Promise.resolve();
    assert.equal(drained, false, 'Last public close waits for held byte-reader cleanup.');
    gate.resolve(); await closing; await Promise.allSettled([reading]);
    assert.deepEqual(pipeline.service.getLiveStreams(), []);
    assert.ok(input.records.every(record => record.closed && record.closes === 1));
    await assert.rejects(first.forkRead());
  } finally {
    gate.resolve(); await Promise.allSettled([closing, reading, reader?.close(), first?.close(), second?.close()]);
  }
});

test('a canceled private byte reader cannot close a surviving public stream owner', async t => {
  const input = controlledBytes();
  const pipeline = await streamPipeline(t, (_kind, operation) => { assert.equal(operation, 'stream'); return input.acquire(); });
  const owner = await pipeline.service.getChannelStream('channel', 'original', { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: [] });
  const controller = new AbortController(); let reader, reading;
  try {
    reader = await owner.forkRead({ signal: controller.signal });
    reading = reader.stream.next(); void reading.catch(() => {}); await input.records[1].readStarted.promise;
    controller.abort(); await Promise.allSettled([reading, reader.close()]);
    assert.equal(input.records[0].closed, false); assert.equal(input.records[1].closed, true);
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 1);
    const next = await owner.forkRead(); await next.close();
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 1);
  } finally { controller.abort(); await Promise.allSettled([reading, reader?.close(), owner.close()]); }
});

test('only explicit visible owned inputs participate in original identity reuse and provider capacity', async t => {
  const inputs = [], observed = [];
  const pipeline = await streamPipeline(t, (_kind, operation, _definition, args) => {
    assert.equal(operation, 'stream'); observed.push(streamState(args[2]));
    const input = controlledInput(); inputs.push(input); return input.acquire();
  });
  const source = { mode: 'native', mediaSource: sourceInfo };
  let hidden, visible, retained;
  try {
    hidden = await pipeline.service.getChannelStream('channel', 'same', { source, currentLiveStreams: [] });
    visible = await pipeline.service.getChannelStream('channel', 'same', { source, currentLiveStreams: [] });
    assert.equal(inputs.length, 2);
    retained = await pipeline.service.getChannelStream('other-channel', 'SAME', { source, currentLiveStreams: [visible, visible] });
    assert.equal(inputs.length, 2);
    assert.deepEqual(observed, [[], []]);
    assert.deepEqual(pipeline.service.getLiveStreams().map(value => value.ConsumerCount), [1, 2]);
    await assert.rejects(pipeline.service.getChannelStream('channel', 'same', { source }), /current visible owned/);
    await assert.rejects(pipeline.service.getChannelStream('channel', 'same', { source, currentLiveStreams: [{}] }), /active consumer owned/);
    await hidden.close();
    assert.equal(visible.sharing.enabled, true); assert.equal(retained.sharing.enabled, true);
    await assert.rejects(pipeline.service.getChannelStream('channel', 'same', { source, currentLiveStreams: [hidden] }), /active consumer owned/);
    await retained.close(); await visible.close(); assert.deepEqual(pipeline.service.getLiveStreams(), []);
    assert.ok(inputs.every(input => input.closes === 1));
  } finally { await Promise.allSettled([hidden?.close(), retained?.close(), visible?.close()]); }
});

test('retained DefaultLiveTvService readers match actual native managers through installed Node providers, sources and XML configuration', {
  skip: !enabled, timeout: 180000,
}, async () => {
  const input = fixture(), bytes = Buffer.from(JSON.stringify(input)), output = path.join(validationOutputRoot(), 'live-tv-tuner-service-' + randomUUID());
  await fs.mkdir(output); const inputFile = path.join(output, 'input.json'); await fs.writeFile(inputFile, bytes, { flag: 'wx' });
  const privateRoot = path.join(output, 'private-inputs'), report = { comparisons: [], cleanup: [] }; let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/DefaultLiveTvService.cs', 'src/Jellyfin.LiveTv/TunerHosts/TunerHostManager.cs',
      'src/Jellyfin.LiveTv/Listings/ListingsManager.cs', 'src/Jellyfin.LiveTv/Listings/EpgChannelData.cs', 'MediaBrowser.Controller/LiveTv/ITunerHost.cs',
      'MediaBrowser.Controller/LiveTv/IListingsManager.cs', 'MediaBrowser.Controller/LiveTv/ChannelInfo.cs', 'MediaBrowser.Model/Dto/MediaSourceInfo.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-tuner-service/Oracle.csproj', output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await fs.readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualDefaultServiceReaders && native.actualTunerHostManager && native.actualListingsManager && native.controlledProviders);
    assert.equal(native.constructorTimerSubscriptionBypassed, true); assert.equal(native.rawStreamSharingValidated, false); assert.equal(native.executorsStarted, false);
    assert.equal(native.inputSha256, hash(bytes)); report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const assembly of native.assemblies) assert.equal(hash(await fs.readFile(assembly.filename)), assembly.sha256);
    for (const [caseIndex, sample] of input.cases.entries()) {
      const expected = native.results.find(value => value.name === sample.name), calls = [];
      const trace = (action, value) => calls.push({ action, value: structuredClone(value) });
      const fail = name => { if (name) throw controlledProviderFailure(name); };
      const pipeline = await open(path.join(privateRoot, 'case-' + caseIndex), sample.tuners, (kind, method, definition, args) => {
        assert.ok(args.at(-1).signal instanceof AbortSignal);
        if (kind === 'tuner' && method === 'channels') {
          trace('tuner.channels', { type: definition.type, enableCache: args[0] }); fail(definition.channelsFailure);
          return structuredClone(definition.channels);
        }
        if (kind === 'tuner' && method === 'sources') {
          trace('tuner.sources', { type: definition.type, channelId: args[0] }); fail(definition.sourcesFailure);
          return expected.initializedSources.find(value => value.type === definition.type).sources.map(mediaSource => ({ mode: 'native', mediaSource: structuredClone(mediaSource) }));
        }
        if (kind === 'listings' && method === 'channels') {
          trace('listings.channels', { id: args[0].Id }); fail(sample.listingsFailure); return structuredClone(input.epgChannels);
        }
        if (kind === 'listings' && method === 'programs') {
          trace('listings.programs', { id: args[0].Id, channelId: args[1] }); fail(sample.programsFailure);
          return [{ Id: 'program', Name: 'Controlled program' }];
        }
        throw new Error('Unexpected formal provider operation.');
      }, input.configuration);
      try {
        let value = null, error = null;
        try {
          if (sample.operation === 'channels') value = (await pipeline.service.getChannels()).map(projectChannel);
          else if (sample.operation === 'programs') value = await pipeline.service.getPrograms(sample.channelId, '2500-01-01T00:00:00.0000000Z', '2500-01-02T00:00:00.0000000Z');
          else value = (await pipeline.service.getChannelStreamMediaSources(sample.channelId)).map(projectSource);
        } catch (caught) { error = caught; }
        if (sample.name === 'all empty media sources throw unimplemented') assert.equal(error?.code, 'not-implemented');
        if (sample.name === 'null media channel id fails before providers' || sample.name === 'blank media channel id fails before providers') assert.equal(error?.status, 400);
        const actual = { name: sample.name, value, error: error != null, calls };
        const comparable = { ...expected, error: expected.error != null }; delete comparable.initializedSources;
        report.comparisons.push({ actual, expected: comparable,
          errorDiagnostics: { native: expected.error, node: error && { name: error.name, message: error.message, code: error.code, status: error.status } } });
        assert.deepEqual(actual, comparable, sample.name);
        assert.equal(typeof pipeline.service.getChannelStream, 'function', 'Owned streams have an independently validated consumer path.');
      } finally { await pipeline.close(); report.cleanup.push({ sample: sample.name, ownersClosed: true }); }
    }
  } catch (error) { failure = error; }
  finally {
    assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-inputs');
    await fs.rm(privateRoot, { recursive: true, force: true }); report.cleanup.push({ privateInputsRemoved: true });
    await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, readerSliceOnly: true,
      rawStreamSharingValidated: false, phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack }, null, 2) + '\n');
  }
  if (failure) throw failure;
});

test('owned original stream selection and closing match actual default-service and media-source-manager components', {
  skip: !enabled, timeout: 180000,
}, async () => {
  const input = streamFixture(), bytes = Buffer.from(JSON.stringify(input)), output = path.join(validationOutputRoot(), 'live-tv-stream-consumer-' + randomUUID());
  await fs.mkdir(output); const filename = path.join(output, 'input.json'); await fs.writeFile(filename, bytes, { flag: 'wx' });
  const privateRoot = path.join(output, 'private-inputs'), report = { comparisons: [], cleanup: [] }; let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/DefaultLiveTvService.cs', 'src/Jellyfin.LiveTv/TunerHosts/TunerHostManager.cs',
      'Emby.Server.Implementations/Library/MediaSourceManager.cs', 'MediaBrowser.Controller/Library/ILiveStream.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-tuner-service/Oracle.csproj', output: path.join(output, 'native'), args: [filename, '{output}/native.json'] });
    const nativeBytes = await fs.readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualDefaultStreamSelection && native.actualMediaSourceManagerClose && native.controlledProviders);
    report.nativeComponentExecuted = true;
    assert.equal(native.inputSha256, hash(bytes)); assert.equal(native.executorsStarted, false); assert.equal(native.rawStreamSharingValidated, false);
    report.inputSha256 = hash(bytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const assembly of native.assemblies) assert.equal(hash(await fs.readFile(assembly.filename)), assembly.sha256);
    for (const [index, sample] of input.streamCases.entries()) {
      const calls = [], inputs = [], handles = []; let preparing;
      const pipeline = await open(path.join(privateRoot, String(index)), sample.tuners, (kind, method, definition, args) => {
        assert.equal(kind, 'tuner'); assert.equal(method, 'stream'); assert.ok(args[3].signal instanceof AbortSignal);
        calls.push({ action: 'tuner.stream', value: { type: definition.type, channelId: args[0], originalStreamId: args[1], current: streamState(args[2]) } });
        if (!preparing && definition.streamFailure) throw controlledProviderFailure(definition.streamFailure);
        const selected = preparing ?? controlledInput(); if (!preparing) inputs.push(selected); return selected.acquire();
      });
      try {
        for (const seed of sample.seeds) {
          preparing = controlledInput(); inputs.push(preparing);
          handles.push(await pipeline.service.getChannelStream('seed-channel', seed.originalStreamId, { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: handles }));
          preparing.enabled = false;
        }
        inputs.forEach((value, offset) => { value.enabled = sample.seeds[offset].enabled; }); preparing = null; calls.length = 0;
        let result, error = null, selected = null;
        try {
          result = await pipeline.service.getChannelStream(sample.channelId, sample.originalStreamId, { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: handles });
          selected = handles.findIndex(value => value.sharing === result.sharing); if (selected < 0) selected = handles.length;
        } catch (caught) { error = caught; }
        if (sample.name === 'all missing and controlled canceled providers end with resource not found') assert.equal(error?.status, 404);
        const afterOpen = streamState(pipeline.service.getLiveStreams()), afterClose = [];
        if (result) handles.push(result);
        for (const handle of handles) { await handle.close(); afterClose.push(streamState(pipeline.service.getLiveStreams())); }
        const actual = { name: sample.name, error: error != null, selected, source: result ? projectSource(result) : null,
          afterOpen, afterClose, calls, closed: inputs.map(value => value.closes) };
        const expected = native.streamResults.find(value => value.name === sample.name), comparable = { ...expected, error: expected.error != null };
        report.comparisons.push({ actual, expected: comparable,
          errorDiagnostics: { native: expected.error, node: error && { name: error.name, message: error.message, code: error.code, status: error.status } } });
        assert.deepEqual(actual, comparable, sample.name);
      } finally { await pipeline.close(); report.cleanup.push({ name: sample.name, ownersClosed: true }); }
    }
  } catch (error) { failure = error; }
  finally {
    assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-inputs');
    await fs.rm(privateRoot, { recursive: true, force: true }); report.cleanup.push({ privateInputsRemoved: true });
    await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure,
      actualNativeSelectionAndCounterClose: report.nativeComponentExecuted === true, nativeStreamObjectsControlled: true, nativeByteTransportCompared: false,
      phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack }, null, 2) + '\n');
  }
  if (failure) throw failure;
});

test('stream consumer cancellation and shutdown own retained bytes and registry counts independently', { timeout: 20000 }, async t => {
  const input = controlledBytes(), gate = Promise.withResolvers();
  const release = () => gate.resolve(); t.signal.addEventListener('abort', release, { once: true });
  const pipeline = await streamPipeline(t, (kind, method) => { assert.equal(kind, 'tuner'); assert.equal(method, 'stream'); return input.acquire(); });
  try {
    const request = new AbortController(), options = { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: [] };
    const first = await pipeline.service.getChannelStream('channel', 'MiXeD', { ...options, signal: request.signal });
    options.currentLiveStreams = [first];
    const second = await pipeline.service.getChannelStream('other-channel', 'mixed', options);
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 2);
    const firstRead = first.stream.next(), rejected = assert.rejects(firstRead, error => error.name === 'AbortError' || error.status === 503);
    await input.records[0].readStarted.promise; request.abort(); await rejected; await first.close();
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 1); assert.equal(input.records[1].closed, false);
    const third = await first.sharing.retain({});
    assert.equal(pipeline.service.getLiveStreams()[0].ConsumerCount, 2);
    const secondRead = second.stream.next(), thirdRead = third.stream.next();
    const rejectedReads = [secondRead, thirdRead].map(pending => assert.rejects(pending, error => error.name === 'AbortError' || error.status === 503));
    await Promise.all(input.records.slice(1).map(record => record.readStarted.promise)); input.records[1].closeGate = gate;
    let closed = false; const closing = pipeline.service.close().then(() => { closed = true; });
    assert.equal(first.sharing.enabled, false); await input.records[1].closeStarted.promise;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    await assert.rejects(pipeline.service.getChannelStream('channel', 'mixed', options), { status: 503 });
    await assert.rejects(first.sharing.retain({}), { status: 503 });
    release(); await Promise.all(rejectedReads); await closing;
    assert.deepEqual(pipeline.service.getLiveStreams(), []);
    assert.deepEqual(input.records.map(record => [record.closes, record.returns]), [[1, 1], [1, 1], [1, 1]]);
  } finally { release(); }
});

for (const phase of ['open', 'retain']) test(`stream consumer ${phase} closes late resources and drains their held cleanup after shutdown`, { timeout: 20000 }, async t => {
  const input = controlledBytes(), entered = Promise.withResolvers(), late = Promise.withResolvers(), gate = Promise.withResolvers();
  let resource, capturedSignal;
  const release = () => { late.resolve(resource ??= input.acquire()); gate.resolve(); };
  t.signal.addEventListener('abort', release, { once: true });
  const pipeline = await streamPipeline(t, (_kind, method, _definition, args) => {
    assert.equal(method, 'stream'); capturedSignal = args[3].signal;
    if (phase === 'open') { entered.resolve(); return late.promise; }
    return input.acquire();
  });
  const options = { source: { mode: 'native', mediaSource: sourceInfo }, currentLiveStreams: [] };
  try {
    let pending;
    if (phase === 'open') pending = pipeline.service.getChannelStream('channel', 'key', options);
    else {
      const first = await pipeline.service.getChannelStream('channel', 'key', options);
      input.sharing.retain = ({ signal }) => { capturedSignal = signal; entered.resolve(); return late.promise; };
      pending = first.sharing.retain({});
    }
    const rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.status === 503); await entered.promise;
    let closed = false; const closing = pipeline.service.close().then(() => { closed = true; });
    assert.equal(capturedSignal.aborted, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    resource = input.acquire(); const record = input.records.at(-1); record.closeGate = gate; late.resolve(resource);
    await record.closeStarted.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(record.returns, 1);
    release(); await rejected; await closing; assert.equal(record.closes, 1); assert.deepEqual(pipeline.service.getLiveStreams(), []);
  } finally { release(); }
});

for (const operation of ['channels', 'programs', 'sources']) test(`tuner ${operation} close cancels and drains late provider work before owner disposal`, { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-tuner-service-close-')), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let pipeline, capturedSignal, pending, returned = false, ownersClosed = false;
  t.after(async () => {
    release.resolve(); await Promise.allSettled([pending]); await pipeline?.close(); ownersClosed = true;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-tuner-service-close-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  pipeline = await open(root, [{ type: 'held', channels: [] }], async (kind, method, _definition, args) => {
    assert.equal(kind, 'tuner'); assert.equal(method, operation === 'sources' ? 'sources' : 'channels');
    capturedSignal = args.at(-1).signal; entered.resolve(); await release.promise; returned = true;
    return operation === 'sources' ? [{ mode: 'native', mediaSource: sourceInfo }] : [];
  });
  pending = operation === 'channels' ? pipeline.service.getChannels() : operation === 'programs'
    ? pipeline.service.getPrograms('same', '2500-01-01T00:00:00Z', '2500-01-02T00:00:00Z') : pipeline.service.getChannelStreamMediaSources('same');
  const outcome = Promise.allSettled([pending]); await entered.promise;
  let drained = false; const closing = pipeline.service.close().then(() => { drained = true; });
  assert.equal(capturedSignal.aborted, true); assert.equal(returned, false);
  await assert.rejects(pipeline.service.getChannels(), { status: 503 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(ownersClosed, false);
  release.resolve(); const [result] = await outcome; await closing;
  assert.equal(drained, true); assert.equal(returned, true);
  if (operation === 'channels') { assert.equal(result.status, 'fulfilled'); assert.deepEqual(result.value, []); }
  else {
    assert.equal(result.status, 'rejected');
    if (operation === 'programs') assert.equal(result.reason.status, 500);
    else assert.deepEqual(failureFields(result.reason), failureFields(capturedSignal.reason));
  }
  await pipeline.close(); ownersClosed = true;
  assert.deepEqual(pipeline.plugins.entries('tuner'), []); assert.deepEqual(pipeline.plugins.entries('listings'), []);
});
