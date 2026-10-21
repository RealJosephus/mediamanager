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
  const close = async () => { await service?.close(); await sources?.close(); await liveTv?.close(); await plugins?.close(); };
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
      const fail = name => { if (name) throw Object.assign(new Error('Controlled provider failure.'), { nativeException: name }); };
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
        const actual = { name: sample.name, value, error: error?.nativeException ?? error?.name ?? null, calls };
        const comparable = { ...expected }; delete comparable.initializedSources;
        report.comparisons.push({ actual, expected: comparable });
        assert.deepEqual(actual, comparable, sample.name);
        assert.equal(pipeline.service.getChannelStream, undefined, 'A reader slice must not advertise unimplemented core stream sharing.');
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
  else { assert.equal(result.status, 'rejected'); assert.equal(result.reason.nativeException ?? result.reason.name, operation === 'programs' ? 'InvalidOperationException' : 'AbortError'); }
  await pipeline.close(); ownersClosed = true;
  assert.deepEqual(pipeline.plugins.entries('tuner'), []); assert.deepEqual(pipeline.plugins.entries('listings'), []);
});
