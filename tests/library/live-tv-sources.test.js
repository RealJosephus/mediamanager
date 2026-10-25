import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { PluginHost } from '../../src/plugins/host.js';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { liveTvConfigurationReader } from '../../src/core/live-tv-configuration-store.js';
import { LiveTvSourcesService } from '../../src/library/live-tv-sources-service.js';
import { bindListingsProviderInfo, bindSetChannelMapping, bindTunerHostInfo } from '../../src/http/live-tv-source-binding.js';
import { deserializeLiveTvConfiguration } from '../../src/http/live-tv-configuration-binding.js';
import { readConfigurationFile } from '../../src/core/configuration-file.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function errorDiagnostic(error, seen = new Set()) {
  if (error == null || typeof error !== 'object') return { thrown: error };
  if (seen.has(error)) return { cycle: true };
  seen.add(error);
  return { name: error.name, code: error.code, status: error.status, message: error.message, path: error.path,
    errors: error.errors, controlToken: error.controlToken, stack: error.stack,
    cause: error.cause === undefined ? undefined : errorDiagnostic(error.cause, seen) };
}
const tunerId = 'a9500000000000000000000000000001', listingId = 'a9500000000000000000000000000002';
const channel = { Id: 'T1', Name: 'A-B channel', Number: '3', TunerChannelId: 'I42.json.schedulesdirect.org', TunerHostId: tunerId };

function inputFixture() {
  const configuration = { TunerHosts: [{ Id: tunerId, Type: 'controlled', DeviceId: 'existing', Url: 'old' }],
    ListingProviders: [{ Id: listingId, Type: 'controlled', EnableAllTuners: true, ChannelMappings: [] }] };
  const operation = (name, kind, values = {}) => ({ name, operation: kind, ...values });
  return { bindings: [
    { name: 'tuner defaults', type: 'tuner', source: '{}' },
    { name: 'tuner case insensitive and quoted integer', type: 'tuner', source: '{"type":"controlled","tunercount":"+2","friendlyname":false}' },
    { name: 'tuner repeated case insensitive winner', type: 'tuner', source: '{"TunerCount":1,"tunercount":2,"Unknown":[]}' },
    { name: 'tuner null value type rejected', type: 'tuner', source: '{"IgnoreDts":null}' },
    { name: 'tuner invalid earlier duplicate rejected', type: 'tuner', source: '{"TunerCount":"invalid","TunerCount":2}' },
    { name: 'tuner quoted bool rejected', type: 'tuner', source: '{"AllowStreamSharing":"true"}' },
    { name: 'listing defaults', type: 'listings', source: '{}' },
    { name: 'listing nested case insensitive token conversion', type: 'listings', source: '{"channelmappings":[{"name":4,"value":false}],"enabledtuners":null}' },
    { name: 'listing nested null array entries', type: 'listings', source: '{"ChannelMappings":[null],"NewsCategories":[null]}' },
    { name: 'listing object cannot be string', type: 'listings', source: '{"Username":{}}' },
    { name: 'mapping required strings', type: 'mapping', source: '{}' },
    { name: 'mapping whitespace and null rejected', type: 'mapping', source: '{"ProviderId":" ","TunerChannelId":null,"ProviderChannelId":"ok"}' },
    { name: 'mapping token values become strings', type: 'mapping', source: '{"providerid":123,"tunerchannelid":true,"providerchannelid":"epg"}' },
  ], cacheFiles: [tunerId + '_channels', 'xmltv/' + listingId + '.xml'],
    tuners: [{ type: 'controlled', name: 'Tuner 10', channels: [channel, { Id: 'other', Name: 'Other', Number: '9', TunerHostId: 'other' }],
      devices: [{ DeviceId: 'EXISTING', Url: 'changed', Type: 'controlled' }, { DeviceId: 'fresh', Url: 'new', Type: 'controlled' }] },
    { type: 'failed', name: 'Tuner 2', channels: [], devices: [], channelsFailure: true, discoveryFailure: true },
    { type: 'unsupported', name: 'Tuner 1', isSupported: false, channels: [], devices: [] }],
    listings: [{ type: 'controlled', name: 'Controlled listings', channels: [
      { Id: 'T1', Name: 'First duplicate', Number: '3', ImageUrl: 'first' },
      { Id: 't1', Name: 'Last duplicate', Number: '4', ImageUrl: 'last' },
      { Id: '42', Name: 'SD match', Number: '5', ImageUrl: 'sd' },
      { Id: 'family', Name: 'ABchannel', Number: '8', ImageUrl: 'name' },
      { Id: 'number', Name: 'Number match', Number: '9', ImageUrl: 'number' },
    ] }], cases: [
      { name: 'retained-management', configuration, operations: [
        operation('types exclude unsupported and sort name', 'types'),
        operation('all discoveries retain duplicates and swallow host failures', 'discover'),
        operation('new discovery uses configured device ids ignore case', 'discover', { newDevicesOnly: true }),
        operation('scan saves changed device url and refreshes', 'scan'),
        operation('update tuner clones its input', 'saveTuner', { info: { Id: tunerId.toUpperCase(), Type: 'CONTROLLED', FriendlyName: 'Updated' } }),
        operation('new tuner receives an independent Guid', 'saveTuner', { info: { Type: 'controlled', FriendlyName: 'New' }, assignedId: 'new-tuner' }),
        operation('unchanged source suppresses refresh', 'saveTuner', { info: { Id: '@new-tuner', Type: 'controlled' }, unchanged: true }),
        operation('provider is required before validation', 'saveTuner', { info: { Type: 'unknown' } }),
        operation('validation failure does not save', 'saveTuner', { info: { Type: 'controlled' }, failure: 'validate' }),
        operation('lineups without a configured id use type', 'lineups', { type: 'controlled', country: 'US', location: '10001' }),
        operation('lineups select stored type over query type', 'lineups', { id: listingId.toUpperCase(), type: 'unknown', country: 'GB', location: 'AB' }),
        operation('lineups unknown id', 'lineups', { id: 'missing', type: 'controlled' }),
        operation('mapping default and last duplicate winner', 'mapping', { id: listingId }),
        operation('prime epg cache', 'programs', { channel }), operation('reuse epg cache', 'programs', { channel }),
        operation('metadata shares the cache', 'metadata', { channels: [channel] }),
        operation('save listing validates original argument and invalidates cache', 'saveListings', {
          info: { Id: listingId.toUpperCase(), Type: 'controlled', Username: 'Controlled account' }, validateLogin: true, validateListings: false }),
        operation('refetch after invalidation', 'programs', { channel }),
        operation('append explicit mapping', 'setMapping', { id: listingId, tunerChannelId: 'T1', providerChannelId: '42' }),
        operation('identical mapping toggles off', 'setMapping', { id: listingId, tunerChannelId: 't1', providerChannelId: '42' }),
        operation('mapping equal id adds no explicit pair', 'setMapping', { id: listingId, tunerChannelId: 'T1', providerChannelId: 't1' }),
        operation('missing target fails after save and refresh', 'setMapping', { id: listingId, tunerChannelId: 'absent', providerChannelId: '42' }),
        operation('provider failure keeps saved mapping without refresh', 'setMapping', { id: listingId, tunerChannelId: 'T1', providerChannelId: '42', failure: 'providerChannels' }),
        operation('new listing receives an independent Guid', 'saveListings', { info: { Type: 'controlled' }, assignedId: 'new-listing' }),
        operation('delete invalid id still saves and refreshes', 'deleteTuner', { id: '../outside' }),
        operation('delete generated tuner', 'deleteTuner', { id: '@new-tuner' }),
        operation('delete tuner canonical cache id with surrounding whitespace', 'deleteTuner', { id: ' ' + tunerId.toUpperCase() + ' ' }),
        operation('delete listing invalidates case insensitive id and disk cache', 'deleteListings', { id: listingId.toUpperCase() }),
      ] },
      { name: 'failure-prefixes', configuration, operations: [
        operation('scan validation failure leaves the earlier url cache mutation', 'scan', { failure: 'validate' }),
        operation('failed tuner save mutates cache but not input or disk', 'saveTuner', { info: { Type: 'controlled' }, failure: 'save' }),
        operation('failed listing save mutates input and cache before disk', 'saveListings', { info: { Type: 'controlled' }, failure: 'save' }),
        operation('refresh failure keeps a successful saved listing', 'saveListings', { info: { Id: listingId, Type: 'controlled' }, failure: 'refresh' }),
        operation('listing validation failure does not save', 'saveListings', { info: { Type: 'controlled' }, failure: 'validate' }),
        operation('missing mapping provider', 'mapping', { id: 'missing' }),
      ] },
      { name: 'null-configured-arrays', configuration: { TunerHosts: null, ListingProviders: null }, operations: [
        operation('null tuners fail after validation', 'saveTuner', { info: { Type: 'controlled' } }),
        operation('null listings fail after validation', 'saveListings', { info: { Type: 'controlled' } }),
        operation('null discovery source', 'discover'), operation('null deletion source', 'deleteListings'),
      ] },
    ] };
}

function idNormalizer(input) {
  const known = new Set();
  const visit = value => {
    if (typeof value === 'string' && /^[a-f\d]{32}$/iu.test(value)) known.add(value.toLowerCase());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }; visit(input);
  const ids = new Map();
  const bind = configuration => {
    for (const info of [...configuration.TunerHosts ?? [], ...configuration.ListingProviders ?? []]) {
      if (info?.Id && !known.has(info.Id.toLowerCase()) && !ids.has(info.Id.toLowerCase())) {
        assert.match(info.Id, /^[a-f\d]{32}$/u); ids.set(info.Id.toLowerCase(), '$GENERATED_' + ids.size);
      }
    }
  };
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalize(child)]))
    : typeof value === 'string' ? ids.get(value.toLowerCase()) ?? value : value;
  return { bind, normalize, ids };
}

test('source managers match actual native validation, mapping, cache and failure prefixes with installed Node providers and XML state', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const input = inputFixture(), inputBytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'live-tv-sources-' + randomUUID()); await fs.mkdir(output);
  const inputFile = path.join(output, 'input.json'); await fs.writeFile(inputFile, inputBytes, { flag: 'wx' });
  const privateRoot = path.join(output, 'private-inputs'), report = { comparisons: [], diagnostics: [], cleanup: [] };
  let failure;
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/TunerHosts/TunerHostManager.cs',
      'src/Jellyfin.LiveTv/Listings/ListingsManager.cs', 'src/Jellyfin.LiveTv/Listings/EpgChannelData.cs',
      'Jellyfin.Api/Controllers/LiveTvController.cs', 'MediaBrowser.Model/LiveTv/TunerHostInfo.cs', 'MediaBrowser.Model/LiveTv/ListingsProviderInfo.cs',
      'Jellyfin.Api/Models/LiveTvDtos/SetChannelMappingDto.cs', 'src/Jellyfin.Extensions/Json/JsonDefaults.cs',
      'Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-sources/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json', path.join(privateRoot, 'native')] });
    const nativeBytes = await fs.readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualTunerHostManager && native.actualListingsManager && native.actualXmlSerializer && native.actualCacheFiles);
    assert.ok(native.controlledProviders && native.controlledGuideQueue && native.controlledConfigurationSaveBoundary);
    assert.equal(native.recordingExecutorsStarted, false); assert.equal(native.inputSha256, hash(inputBytes));
    report.inputSha256 = hash(inputBytes); report.nativeOutputSha256 = hash(nativeBytes);
    for (const assembly of native.assemblies) assert.equal(hash(await fs.readFile(assembly.filename)), assembly.sha256);
    for (const binding of input.bindings) {
      let value = null, errors = null, path = null, bindingError;
      try { value = ({ tuner: bindTunerHostInfo, listings: bindListingsProviderInfo, mapping: bindSetChannelMapping })[binding.type](null, binding.source); }
      catch (error) {
        bindingError = error;
        assert.equal(error.status, 400);
        if (typeof error.path === 'string') path = error.path; else errors = error.errors;
      }
      const actual = { name: binding.name, value, errors, path };
      const expected = native.bindings.find(result => result.name === binding.name);
      report.comparisons.push({ sample: 'typed-json-and-required-attributes', actual, expected,
        errorDiagnostic: bindingError && errorDiagnostic(bindingError) });
      assert.deepEqual(actual, expected, binding.name);
    }
    for (const sample of input.cases) {
      const root = path.join(privateRoot, 'node', sample.name), cachePath = path.join(root, 'cache'), configurationDirectoryPath = path.join(root, 'config');
      await fs.mkdir(path.join(cachePath, 'xmltv'), { recursive: true }); await fs.mkdir(configurationDirectoryPath);
      for (const name of input.cacheFiles) await fs.writeFile(path.join(cachePath, name), 'cache marker');
      const calls = [], errors = [], bindings = {};
      const nativeNormalizer = idNormalizer(input), nodeNormalizer = idNormalizer(input);
      const controlledFailures = new Map();
      let operation, liveTv, service, plugins, sampleFailure, phase = 'setup';
      const trace = (action, value = null) => calls.push({ action, value: structuredClone(value) });
      const controlledFailure = (stage, message) => {
        const controlToken = JSON.stringify([sample.name, operation?.name, stage]);
        controlledFailures.set(controlToken, { operation: operation?.name, stage });
        return Object.assign(new Error(message), { code: 'EIO', controlToken });
      };
      const diagnostic = owner => error => {
        let control = error; const seen = new Set();
        while (control?.cause && !control.controlToken && !seen.has(control)) { seen.add(control); control = control.cause; }
        const declared = controlledFailures.get(control?.controlToken);
        errors.push({ owner, phase, operation: operation?.name, error: errorDiagnostic(error),
          classified: phase === 'operation' && control?.code === 'EIO' && declared?.operation === operation?.name });
      };
      try {
        plugins = await PluginHost.open({ directory: path.join(root, 'plugins'), preinstalled: false,
          options: { 'source-controls': { tuners: input.tuners, listings: input.listings, invoke(kind, method, definition, args) {
            assert.ok(args.at(-1).signal instanceof AbortSignal, 'Installed source methods receive the formal plugin cancellation scope.');
            const type = definition.type;
            if (kind === 'tuner' && method === 'validate') {
              trace('tuner.validate', { type, info: args[0] });
              if (operation.failure === 'validate') throw controlledFailure('tuner.validate:' + type, 'Controlled tuner validation failure.');
              args[0].FriendlyName = (args[0].FriendlyName ?? '') + ' verified';
            } else if (kind === 'tuner' && method === 'channels') {
              trace('tuner.channels', { type, enableCache: args[0] });
              if (definition.channelsFailure) throw controlledFailure('tuner.channels:' + type, 'Controlled tuner channel failure.');
              return structuredClone(definition.channels);
            } else if (kind === 'tuner' && method === 'discover') {
              trace('tuner.discover', { type, duration: args[0] });
              if (definition.discoveryFailure) throw controlledFailure('tuner.discover:' + type, 'Controlled discovery failure.');
              return definition.devices.map(value => bindTunerHostInfo(value));
            } else if (kind === 'listings' && method === 'validate') {
              trace('listings.validate', { type, info: args[0], validateLogin: args[1], validateListings: args[2] });
              if (operation.failure === 'validate') throw controlledFailure('listings.validate:' + type, 'Controlled listing validation failure.');
              args[0].Username = (args[0].Username ?? '') + ' verified';
            } else if (kind === 'listings' && method === 'channels') {
              trace('listings.channels', { type, id: args[0].Id });
              if (operation.failure === 'providerChannels') throw controlledFailure('listings.channels:' + type, 'Controlled listing channel failure.');
              return structuredClone(definition.channels);
            } else if (kind === 'listings' && method === 'lineups') {
              trace('listings.lineups', { type, id: args[0]?.Id ?? null, country: args[1], location: args[2] });
              return [{ Name: args[1], Id: args[2] }];
            } else if (kind === 'listings' && method === 'programs') {
              trace('listings.programs', { type, channelId: args[1] });
              return [{ Id: 'program', Name: 'Controlled program' }];
            }
          } } }, onError: diagnostic('plugins') });
        await plugins.install(fileURLToPath(new URL('./fixtures/live-tv-sources/plugin/', import.meta.url)));
        liveTv = new LiveTvService({ configurationDirectoryPath, fileSystem: { ...fs, async open(...args) {
          if (operation?.failure === 'save') throw Object.assign(new Error('Controlled configuration save failure.'), { code: 'EIO' });
          return fs.open(...args);
        } } });
        await liveTv.saveConfiguration(deserializeLiveTvConfiguration({ source: JSON.stringify(sample.configuration) }));
        liveTv.on('updating', ({ configuration }) => trace('save', configuration));
        service = new LiveTvSourcesService({ liveTv, plugins, fileSystem: fs, cachePath,
          refreshGuide: () => { trace('refresh'); if (operation.failure === 'refresh') throw new Error('Controlled refresh failure.'); },
          onError: diagnostic('sources') });
        const resolve = value => typeof value === 'string' && value.startsWith('@') ? bindings[value.slice(1)] : value;
        const expectedCase = native.results.find(value => value.name === sample.name);
        for (operation of sample.operations) {
          phase = 'operation';
          calls.length = 0; let value = null, argument = null, error;
          try {
            const kind = operation.operation;
            if (kind === 'types') value = await service.getTunerHostTypes();
            else if (kind === 'discover') value = await service.discoverTuners(operation.newDevicesOnly);
            else if (kind === 'saveTuner') {
              argument = bindTunerHostInfo({ ...operation.info, Id: resolve(operation.info.Id) ?? null });
              value = await service.saveTunerHost(argument, { dataSourceChanged: !operation.unchanged });
            } else if (kind === 'deleteTuner') await service.deleteTunerHost(resolve(operation.id) ?? null);
            else if (kind === 'scan') await service.scanForTunerDeviceChanges();
            else if (kind === 'saveListings') {
              argument = bindListingsProviderInfo({ ...operation.info, Id: resolve(operation.info.Id) ?? null });
              value = await service.saveListingProvider(argument, { validateLogin: operation.validateLogin, validateListings: operation.validateListings });
            } else if (kind === 'deleteListings') await service.deleteListingsProvider(resolve(operation.id) ?? null);
            else if (kind === 'lineups') value = await service.getLineups({ type: operation.type, id: resolve(operation.id), country: operation.country, location: operation.location });
            else if (kind === 'mapping') value = await service.getChannelMappingOptions(resolve(operation.id));
            else if (kind === 'setMapping') value = await service.setChannelMapping(resolve(operation.id), operation.tunerChannelId, operation.providerChannelId);
            else if (kind === 'programs') value = await service.getPrograms(structuredClone(operation.channel), '2500-01-01T00:00:00.0000000Z', '2500-01-02T00:00:00.0000000Z');
            else if (kind === 'metadata') {
              const channels = structuredClone(operation.channels); await service.addProviderMetadata(channels, { enableCache: !operation.disableCache });
              value = channels.map(channel => ({ Id: channel.Id, ImageUrl: channel.ImageUrl ?? null }));
            }
            if (operation.assignedId) bindings[operation.assignedId] = value.Id;
          } catch (caught) { error = caught; }
          const expected = expectedCase.observations.find(value => value.name === operation.name), configuration = structuredClone(await liveTv.getConfiguration());
          nativeNormalizer.bind(expected.configuration); nodeNormalizer.bind(configuration);
          const cacheFiles = await Promise.all(input.cacheFiles.map(async name => {
            try { await fs.stat(path.join(cachePath, name)); return { name, exists: true }; }
            catch (error) { if (error.code === 'ENOENT') return { name, exists: false }; throw error; }
          }));
          const actual = { name: operation.name, value, argument, calls: structuredClone(calls), configuration,
            diskConfiguration: await readConfigurationFile(path.join(configurationDirectoryPath, 'livetv.xml'), 'livetv', { reader: liveTvConfigurationReader }), cacheFiles };
          const normalizedExpected = nativeNormalizer.normalize(expected); delete normalizedExpected.error;
          const normalizedActual = nodeNormalizer.normalize(actual);
          report.comparisons.push({ sample: sample.name, name: operation.name, nativeError: expected.error,
            nodeError: error && errorDiagnostic(error), nodeStatus: error?.status ?? (error ? 500 : null),
            actual: normalizedActual, expected: normalizedExpected });
          if (expected.error) assert.equal(error?.status ?? (error ? 500 : null), ['ArgumentNullException', 'ArgumentException'].includes(expected.error) ? 400
            : expected.error === 'ResourceNotFoundException' ? 404 : 500, operation.name);
          else assert.equal(error, undefined, error?.stack);
          assert.deepEqual(normalizedActual, normalizedExpected, sample.name + ': ' + operation.name);
        }
        assert.equal(nodeNormalizer.ids.size, nativeNormalizer.ids.size);
      } catch (error) { sampleFailure = error; throw error;
      } finally {
        phase = 'close';
        const cleanup = { sample: sample.name }, cleanupErrors = [];
        for (const [name, resource] of [['serviceClosed', service], ['configurationClosed', liveTv], ['pluginsClosed', plugins]]) {
          try { await resource?.close(); cleanup[name] = Boolean(resource); }
          catch (error) { cleanup[name] = false; cleanupErrors.push(error); }
        }
        phase = 'closed';
        const unclassified = errors.filter(error => !error.classified);
        report.diagnostics.push({ sample: sample.name, node: errors, unclassified });
        report.cleanup.push({ ...cleanup, errors: cleanupErrors.map(error => errorDiagnostic(error)) });
        if (!sampleFailure) {
          if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Source management resources failed to close.');
          assert.deepEqual(unclassified, [], sample.name + ': unclassified, successful or closing diagnostics must not be hidden.');
        }
      }
    }
  } catch (error) { failure = error; }
  finally {
    assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-inputs');
    await fs.rm(privateRoot, { recursive: true, force: true });
    report.cleanup.push({ privateInputsRemoved: true });
    await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure, phaseAcceptance: false,
      releaseAcceptance: false, error: failure?.stack }, null, 2) + '\n');
  }
  if (failure) throw failure;
});

test('source cache deletion uses filesystem codes and preserves the already saved configuration before failures', { timeout: 120000 }, async t => {
  const cases = [
    ['tuner unlink io', 'tuner', 'unlink', 'EIO', false],
    ['tuner unlink busy', 'tuner', 'unlink', 'EBUSY', false],
    ['tuner missing', 'tuner', 'unlink', 'ENOENT', false],
    ['tuner permission', 'tuner', 'unlink', 'EACCES', true],
    ['tuner directory', 'tuner', 'unlink', 'EISDIR', true],
    ['tuner unknown failure', 'tuner', 'unlink', 'ERR_INVALID_ARG_TYPE', true],
    ['listing stat io', 'listing', 'stat', 'EIO', false],
    ['listing stat permission', 'listing', 'stat', 'EPERM', false],
    ['listing stat unknown failure', 'listing', 'stat', 'ERR_INVALID_ARG_TYPE', true],
    ['listing unlink io', 'listing', 'unlink', 'EIO', false],
    ['listing unlink permission', 'listing', 'unlink', 'EACCES', false],
    ['listing unlink unknown failure', 'listing', 'unlink', 'ERR_INVALID_ARG_TYPE', true],
  ];
  for (const [name, kind, stage, code, rejects] of cases) await t.test(name, async () => {
    const root = path.join(validationOutputRoot(), 'source-cache-code-' + randomUUID()), cachePath = path.join(root, 'cache');
    const configurationDirectoryPath = path.join(root, 'config'), target = kind === 'tuner'
      ? path.join(cachePath, tunerId + '_channels') : path.join(cachePath, 'xmltv', listingId + '.xml');
    await fs.mkdir(path.join(cachePath, 'xmltv'), { recursive: true });
    await fs.writeFile(target, 'retained cache bytes');
    const liveTv = new LiveTvService({ configurationDirectoryPath });
    await liveTv.saveConfiguration(deserializeLiveTvConfiguration({ source: JSON.stringify({
      TunerHosts: [{ Id: tunerId, Type: 'controlled' }], ListingProviders: [{ Id: listingId, Type: 'controlled' }],
    }) }));
    const expected = structuredClone(await liveTv.getConfiguration());
    expected[kind === 'tuner' ? 'TunerHosts' : 'ListingProviders'] = [];
    const diagnostics = [];
    let phase = 'operation', refreshes = 0, faultObserved = false, service;
    const failed = () => { faultObserved = true; throw Object.assign(new Error('Controlled cache operation failure.'), { code }); };
    try {
      service = new LiveTvSourcesService({ liveTv, plugins: { entries: () => [] }, cachePath,
        fileSystem: { ...fs, async stat(filename) {
          if (filename === target && stage === 'stat') failed();
          return fs.stat(filename);
        }, async unlink(filename) {
          if (filename === target && stage === 'unlink') failed();
          return fs.unlink(filename);
        } }, refreshGuide: async () => { refreshes++; },
        onError: error => diagnostics.push({ phase, error: errorDiagnostic(error) }) });
      const pending = kind === 'tuner' ? service.deleteTunerHost(tunerId) : service.deleteListingsProvider(listingId);
      if (rejects) await assert.rejects(pending, error => {
        assert.equal(error.code, code); assert.equal(error.message, 'Controlled cache operation failure.'); return true;
      });
      else await pending;
      assert.equal(faultObserved, true);
      assert.deepEqual(await liveTv.getConfiguration(), expected);
      assert.deepEqual(await readConfigurationFile(path.join(configurationDirectoryPath, 'livetv.xml'), 'livetv', { reader: liveTvConfigurationReader }), expected);
      assert.equal(await fs.readFile(target, 'utf8'), 'retained cache bytes');
      assert.equal(refreshes, rejects ? 0 : 1);
      phase = 'close'; await service.close(); await liveTv.close(); phase = 'closed';
      await assert.rejects(service.getTunerHostTypes(), { status: 503 });
      const unclassified = diagnostics.filter(value => value.phase !== 'operation' || value.error.code !== code);
      t.diagnostic(JSON.stringify({ name, kind, stage, code, rejects, refreshes, savedConfiguration: expected,
        cacheBytes: await fs.readFile(target, 'utf8'), resourcesClosed: true, diagnostics, unclassified }));
      assert.deepEqual(unclassified, [], 'Only the actual controlled cache failure is an admitted diagnostic.');
    } finally { await Promise.allSettled([service?.close(), liveTv.close()]); }
  });
});

test('provider metadata failures consume semantic support codes and retain channel values', { timeout: 30000 }, async t => {
  const configuration = deserializeLiveTvConfiguration({ source: JSON.stringify({ ListingProviders: [
    { Id: listingId, Type: 'controlled', EnableAllTuners: true, ChannelMappings: [] },
  ] }) });
  for (const code of ['not-supported', 'EIO']) {
    const diagnostics = [], channels = [{ ...channel, ImageUrl: 'retained image' }], expected = structuredClone(channels);
    let admitted = 0, released = 0, calls = 0, phase = 'operation';
    const service = new LiveTvSourcesService({ liveTv: {
      admitRead: () => { admitted++; return { getConfiguration: async () => configuration, release() { released++; } }; },
      admitMutation() { throw new Error('Unexpected mutation admission.'); },
    }, plugins: { entries: kind => kind === 'listings' ? [{ type: 'controlled', async getChannels() {
      calls++; throw Object.assign(new Error('Controlled provider metadata failure.'), { code });
    } }] : [] }, fileSystem: fs, cachePath: path.resolve('isolated-source-metadata-cache'), refreshGuide: async () => {},
    onError: error => diagnostics.push({ phase, error: errorDiagnostic(error) }) });
    try {
      await service.addProviderMetadata(channels);
      assert.deepEqual(channels, expected); assert.equal(calls, 1); assert.equal(admitted, released);
      phase = 'close'; await service.close(); phase = 'closed';
      const unclassified = diagnostics.filter(value => value.phase !== 'operation' || value.error.code !== code);
      t.diagnostic(JSON.stringify({ code, channels, admitted, released, calls, diagnostics, unclassified, resourcesClosed: true }));
      assert.deepEqual(unclassified, [], 'Unknown or closing provider errors are not hidden by the metadata fallback.');
      await assert.rejects(service.addProviderMetadata(channels), { status: 503 });
    } finally { await Promise.allSettled([service.close()]); }
  }
});

test('source cache cleanup follows the active root and retains old tuner and XMLTV bytes', { timeout: 30000 }, async () => {
  const root = path.join(validationOutputRoot(), 'source-active-cache-' + randomUUID());
  const first = path.join(root, 'first'), second = path.join(root, 'second'), directory = path.join(root, 'config');
  const previousTuner = 'a9500000000000000000000000000003';
  const tunerBytes = Buffer.from('retained old tuner cache\n'), listingBytes = Buffer.from('<tv><channel id="retained"/></tv>\n');
  for (const cache of [first, second]) {
    await fs.mkdir(path.join(cache, 'xmltv'), { recursive: true });
    await fs.writeFile(path.join(cache, tunerId + '_channels'), tunerBytes);
    await fs.writeFile(path.join(cache, 'xmltv', listingId + '.xml'), listingBytes);
  }
  await fs.writeFile(path.join(first, previousTuner + '_channels'), 'first-root cleanup');
  const liveTv = new LiveTvService({ configurationDirectoryPath: directory });
  let cachePath = first, service;
  try {
    await liveTv.saveConfiguration(deserializeLiveTvConfiguration({ source: JSON.stringify({
      TunerHosts: [{ Id: previousTuner, Type: 'controlled' }, { Id: tunerId, Type: 'controlled' }],
      ListingProviders: [{ Id: listingId, Type: 'controlled' }],
    }) }));
    service = new LiveTvSourcesService({ liveTv, plugins: { entries: () => [] }, fileSystem: fs,
      get cachePath() { return cachePath; }, refreshGuide: async () => {} });
    await service.deleteTunerHost(previousTuner);
    await assert.rejects(fs.stat(path.join(first, previousTuner + '_channels')), { code: 'ENOENT' });
    cachePath = second;
    await service.deleteTunerHost(tunerId);
    await service.deleteListingsProvider(listingId);
    await assert.rejects(fs.stat(path.join(second, tunerId + '_channels')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(second, 'xmltv', listingId + '.xml')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(first, tunerId + '_channels')), tunerBytes);
    assert.deepEqual(await fs.readFile(path.join(first, 'xmltv', listingId + '.xml')), listingBytes);
    const configuration = structuredClone(await liveTv.getConfiguration());
    assert.deepEqual(configuration.TunerHosts, []); assert.deepEqual(configuration.ListingProviders, []);
    await service.close(); await liveTv.close();
    assert.deepEqual(await readConfigurationFile(path.join(directory, 'livetv.xml'), 'livetv', { reader: liveTvConfigurationReader }), configuration);
    await assert.rejects(service.getTunerHostTypes(), { status: 503 });
  } finally { await Promise.allSettled([service?.close(), liveTv.close()]); }
});
