import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { md5Guid } from '../../src/core/identity.js';
import { decodeM3u, parseM3uText } from '../../plugins/m3u/parser.js';
import { createMediaSource } from '../../plugins/m3u/source.js';
import { M3uTuner } from '../../plugins/m3u/tuner.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureUrl = new URL('./fixtures/m3u/input.json', import.meta.url);
const wire = value => JSON.parse(JSON.stringify(value, (_key, entry) => entry === null ? undefined : entry));
const cacheValues = entries => entries.map(({ error, failed, ...value }) => ({ ...value, failed: failed ?? (error != null) }));
const errorDiagnostic = error => ({ reasonType: typeof error, name: error?.name, code: error?.code, status: error?.status, message: error?.message, stack: error?.stack });
const defaults = values => ({ Id: 'm3u-native-component', Url: 'http://fixture.invalid/playlist', Type: 'm3u',
  UserAgent: null, AllowHWTranscoding: true, AllowStreamSharing: true, AllowFmp4TranscodingContainer: false,
  FallbackMaxStreamingBitrate: 30000000, EnableStreamLooping: false, TunerCount: 0,
  IgnoreDts: true, ReadAtNativeFramerate: false, ...values });
const bytesFor = sample => {
  const text = sample.text;
  if (!sample.encoding) return Buffer.from(text);
  if (sample.encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (sample.encoding === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  if (sample.encoding === 'utf32le') {
    const bytes = Buffer.alloc(4 + [...text].length * 4); bytes.set([0xff, 0xfe, 0, 0]);
    [...text].forEach((point, index) => bytes.writeUInt32LE(point.codePointAt(0), 4 + index * 4)); return bytes;
  }
  throw new Error('Unknown controlled playlist encoding.');
};
const producerFields = ['Protocol', 'Id', 'Path', 'ReadAtNativeFramerate', 'IgnoreDts', 'IgnoreIndex', 'GenPtsInput',
  'SupportsTranscoding', 'SupportsDirectStream', 'SupportsDirectPlay', 'IsInfiniteStream', 'UseMostCompatibleTranscodingProfile',
  'RequiresOpening', 'RequiresClosing', 'RequiresLooping', 'SupportsProbing', 'IsRemote', 'FallbackMaxStreamingBitrate', 'RequiredHttpHeaders'];
const producerSource = value => ({ ...Object.fromEntries(producerFields.map(key => [key, value[key]])),
  MediaStreams: value.MediaStreams.map(stream => ({ Type: stream.Type, Index: stream.Index, IsInterlaced: stream.IsInterlaced })) });

async function observeCacheIdentity({ sample, native, root, fileSystem, sourceBytes, observed }) {
  const owners = [], closed = new Set(), cleanupErrors = [], requests = [];
  let sourceFails = false, failure, failed = false;
  const create = (cachePath, name) => {
    const tuner = new M3uTuner({ cachePath, fetch: async (uri, options) => {
      requests.push({ uri, userAgent: new Headers(options.headers).get('User-Agent') ?? '' });
      options.signal.throwIfAborted();
      if (sourceFails) throw new Error('Controlled playlist source failure.');
      return new Response(sourceBytes);
    }, logger: { error: error => observed.diagnostics.push(errorDiagnostic(error)) } });
    tuner.connect({ fileSystem, liveTv: { admitRead: () => ({ getConfiguration: async () => ({ TunerHosts: [sample.info] }), release() {} }) } });
    owners.push({ tuner, name }); return tuner;
  };
  const close = async ({ tuner, name }) => {
    try {
      await tuner.close(); closed.add(tuner);
      observed.cleanup[name] = { closedAt: new Date().toISOString() };
      const late = await Promise.resolve().then(() => tuner.getChannels(true)).then(
        value => ({ fulfilled: true, value }), reason => ({ fulfilled: false, reason }));
      observed.cleanup[name].late = { fulfilled: late.fulfilled, error: errorDiagnostic(late.reason) };
      assert.equal(late.fulfilled, false); assert.equal(late.reason?.status, 503);
    } catch (error) { cleanupErrors.push(error); observed.cleanup[name] = { ...observed.cleanup[name], error: errorDiagnostic(error) }; }
  };
  const capture = async (name, enabled, tuner) => {
    const before = requests.length; let channels = null, failed = false, error;
    try { channels = wire(await tuner.getChannels(enabled)); }
    catch (reason) { failed = true; error = errorDiagnostic(reason); }
    const filename = path.join(tuner.cachePath, sample.info.Id + '_channels');
    const bytes = await readFile(filename).catch(reason => { if (reason.code === 'ENOENT') return null; throw reason; });
    observed.observations.push({ name, channels, failed, error, requests: requests.slice(before), cache: bytes === null ? null : {
      filename: path.basename(filename), bytesBase64: bytes.toString('base64'), length: bytes.length, sha256: hash(bytes) } });
  };
  try {
    const cachePath = path.join(root, 'node-cache-identities', sample.name);
    const force = create(cachePath, 'force');
    try { await capture('force', false, force); } finally { await close(owners.at(-1)); }
    sourceFails = true;
    const cold = create(cachePath, 'cold-own-cache');
    try { await capture('cold-source-failure', true, cold); } finally { await close(owners.at(-1)); }
    const nativeCache = native.observations.find(value => value.name === 'force').cache;
    assert.ok(nativeCache, 'The actual Native producer must provide its complete cache before Node consumes it.');
    const importedPath = path.join(root, 'native-cache-identities', sample.name); await mkdir(importedPath, { recursive: true });
    await writeFile(path.join(importedPath, sample.info.Id + '_channels'), Buffer.from(nativeCache.bytesBase64, 'base64'));
    const imported = create(importedPath, 'cold-native-cache');
    try { await capture('cold-native-source-failure', true, imported); } finally { await close(owners.at(-1)); }
  } catch (error) { failed = true; failure = error; }
  finally {
    for (const owner of owners) if (!closed.has(owner.tuner)) await close(owner);
    if (cleanupErrors.length) {
      const errors = failed ? [failure, ...cleanupErrors] : cleanupErrors;
      failure = errors.length === 1 ? errors[0] : new AggregateError(errors, 'M3U cache identity consumers failed to close.', { cause: errors[0] });
      failed = true;
    }
  }
  if (failed) throw failure;
}

test('official M3U parser, source-owned fields and native channel cache readers match actual designated components', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async () => {
  const sourceBytes = await readFile(fixtureUrl), fixture = JSON.parse(sourceBytes);
  const root = path.join(validationOutputRoot(), 'm3u-native-' + randomUUID()); await mkdir(root);
  let host, storage, tuner, failure; const cleanup = {}, observed = { parsed: [], sources: [], cache: [], cacheErrorDiagnostics: [], validation: [] }, errors = [];
  try {
    host = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false });
    await host.install(path.resolve('plugins/local'));
    storage = await createConfiguredStorage(undefined, { plugins: host });
    await storage.configure({ instances: [{ id: 'controlled', type: 'local', config: { root, writable: true } }],
      mounts: [{ path: '/controlled', instanceId: 'controlled', root: '/', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } }],
      prefixes: [{ identityRoot: root, accessRoot: '/controlled', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', returnAccess: 'The isolated native component consumes the actual Node cache.', purpose: 'library' }] });
    const cacheInfo = defaults(), cachePath = path.join(root, 'node-cache'), cacheBytes = bytesFor(fixture.parsers[0]);
    let payload = cacheBytes, fail = false, requests = 0;
    const fetch = async (_url, options) => { requests++; options.signal?.throwIfAborted(); if (fail) throw new Error('Controlled playlist source failure.'); return new Response(payload); };
    const liveTv = { admitRead() { return { async getConfiguration() { return { TunerHosts: [cacheInfo] }; }, release() {} }; } };
    const connect = value => value.connect({ liveTv, fileSystem: storage.fileSystem, users: { isLocalNetwork: () => false } });
    const logger = owner => ({ error: error => errors.push({ owner, error: errorDiagnostic(error) }) });
    tuner = new M3uTuner({ cachePath, fetch, logger: logger('primary') }); connect(tuner);
    const capture = async (name, enabled, value = tuner) => {
      const before = requests; let channels = null, error = null, failed = false;
      try { channels = wire(await value.getChannels(enabled)); }
      catch (caught) { failed = true; error = caught.name; observed.cacheErrorDiagnostics.push({ name, error: errorDiagnostic(caught) }); }
      observed.cache.push({ name, channels, error, failed, requests: requests - before });
    };
    await capture('first-force', false);
    const nodeCacheFile = path.join(root, 'node-produced-cache.json');
    const firstCache = await readFile(path.join(cachePath, cacheInfo.Id + '_channels')); await writeFile(nodeCacheFile, firstCache);
    observed.cacheFiles = [{ name: 'first-force', bytesBase64: firstCache.toString('base64'), length: firstCache.length, sha256: hash(firstCache) }];
    fail = true; await capture('memory-after-source-failure', true); await capture('force-failure', false);
    const cold = new M3uTuner({ cachePath, fetch, logger: logger('cold') }); connect(cold);
    try { await capture('cold-native-disk-fallback', true, cold); } finally { await cold.close(); }
    fail = false; payload = Buffer.from('#EXTM3U\n'); await capture('force-empty', false); await capture('nonempty-memory-survives-empty', true);
    const shortCache = await readFile(path.join(cachePath, cacheInfo.Id + '_channels'));
    observed.cacheFiles.push({ name: 'force-empty', bytesBase64: shortCache.toString('base64'), length: shortCache.length, sha256: hash(shortCache) });
    fail = true;
    const empty = new M3uTuner({ cachePath, fetch, logger: logger('empty') }); connect(empty);
    try { await capture('cold-empty-native-disk', true, empty); } finally { await empty.close(); }
    const multiInfos = [defaults({ Id: 'Host-İ', Type: 'M3U' }), defaults({ Id: 'host-i', Type: 'm3u' }), defaults({ Id: 'ignored', Type: 'm3ű' })];
    fail = false; payload = cacheBytes;
    const multiple = new M3uTuner({ cachePath: path.join(root, 'multiple-cache'), fetch, logger: logger('multiple') });
    multiple.connect({ liveTv: { admitRead: () => ({ getConfiguration: async () => ({ TunerHosts: multiInfos }), release() {} }) },
      fileSystem: storage.fileSystem, users: { isLocalNetwork: () => false } });
    try { const before = requests; observed.multipleHosts = { channels: wire(await multiple.getChannels(false)), requests: requests - before }; }
    finally { await multiple.close(); }
    const parsers = fixture.parsers.map((sample, index) => ({ ...sample, info: defaults({ Id: 'parser-' + index,
      Url: 'http://fixture.invalid/playlist-' + index, UserAgent: 'ControlledM3U/1.2' }), bytesBase64: bytesFor(sample).toString('base64') }));
    for (const sample of parsers) {
      const bytes = Buffer.from(sample.bytesBase64, 'base64');
      const chunks = Array.from({ length: bytes.length }, (_, offset) => bytes.subarray(offset, offset + 1));
      observed.parsed.push({ name: sample.name, channels: wire(parseM3uText(await decodeM3u(chunks), {
        channelIdPrefix: 'm3u_' + md5Guid(sample.info.Url), tunerHostId: sample.info.Id })) });
    }
    const sources = fixture.sources.map(sample => ({ ...sample, info: defaults(sample.info) }));
    for (const sample of sources) observed.sources.push({ name: sample.name, mediaSource: await createMediaSource(sample.info, { Path: sample.path }, { isLocalNetwork: () => sample.local }) });
    for (const status of [200, 204, 404]) {
      let canceled = 0;
      const value = new M3uTuner({ cachePath, fetch: async () => ({ ok: status < 400, status,
        body: { cancel: async () => { canceled++; } } }), logger: logger('validate-' + status) }); connect(value);
      let error;
      try { await value.validate(defaults({ Url: 'http://fixture.invalid/validate' })); } catch (cause) { error = cause.message; }
      finally { await value.close(); }
      observed.validation.push({ status, error, canceled }); assert.equal(canceled, 1);
    }
    const cacheIdentities = fixture.cacheIdentities.map(sample => ({ ...sample,
      info: defaults({ Id: sample.id, Url: 'http://fixture.invalid/cache-identity-' + sample.name }) }));
    const input = { parsers, sources, cacheInfo, multiInfos, cacheIdentities, cacheBytesBase64: cacheBytes.toString('base64'), nodeCacheFile };
    const inputFile = path.join(root, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input)); await writeFile(inputFile, inputBytes);
    const record = await recordOracle({ project: 'tests/plugins/fixtures/m3u/Oracle.csproj', output: path.join(root, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(root, 'native/native.json')), native = JSON.parse(nativeBytes);
    observed.nativeCacheIdentities = native.cacheIdentities;
    observed.cacheIdentities = [];
    for (const sample of cacheIdentities) {
      const result = { name: sample.name, info: sample.info, observations: [], diagnostics: [], cleanup: {} };
      observed.cacheIdentities.push(result);
      await observeCacheIdentity({ sample, native: native.cacheIdentities.find(value => value.name === sample.name),
        root, fileSystem: storage.fileSystem, sourceBytes: cacheBytes, observed: result });
    }
    assert.equal(record.passed, true); assert.equal(native.inputSha256, hash(inputBytes));
    assert.ok(native.actualM3uParser && native.actualBaseTunerHost && native.actualM3uTunerHost && native.actualPathProtocol && native.privateInputsRemoved);
    assert.equal(native.recordingOrTranscodingStarted, false);
    assert.equal(record.outputs.find(entry => path.basename(entry.filename) === 'native.json').sha256, hash(nativeBytes));
    assert.deepEqual(observed.parsed, native.parsed.map(({ name, channels }) => ({ name, channels })));
    for (const value of native.parsed) { assert.equal(value.streamsDisposed, 1); assert.equal(value.requests.length, 1); assert.equal(value.requests[0].userAgent, 'ControlledM3U/1.2'); }
    assert.deepEqual(observed.sources.map(({ name, mediaSource }) => ({ name, mediaSource: producerSource(mediaSource) })),
      native.sources.map(({ name, mediaSource }) => ({ name, mediaSource: producerSource(mediaSource) })));
    assert.deepEqual(wire(cacheValues(observed.cache)), wire(cacheValues(native.cache.filter(value => value.name !== 'actual-native-reads-node-cache'))));
    assert.equal(cacheValues(observed.cache).find(value => value.name === 'cold-empty-native-disk').failed, true);
    for (const snapshots of [native.cacheFiles, observed.cacheFiles]) {
      const before = Buffer.from(snapshots[0].bytesBase64, 'base64'), after = Buffer.from(snapshots[1].bytesBase64, 'base64');
      for (const entry of snapshots) { const bytes = Buffer.from(entry.bytesBase64, 'base64'); assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.length); }
      assert.equal(after.length, before.length); assert.equal(after.subarray(0, 2).toString(), '[]'); assert.deepEqual(after.subarray(2), before.subarray(2));
    }
    assert.deepEqual(native.cache.find(value => value.name === 'actual-native-reads-node-cache').channels, observed.cache[0].channels);
    assert.deepEqual(observed.multipleHosts, native.multipleHosts);
    const behavior = ({ name, channels, failed, requests }) => ({ name, channels, failed, requests });
    for (const result of observed.cacheIdentities) {
      const target = native.cacheIdentities.find(value => value.name === result.name);
      assert.deepEqual(result.observations.slice(0, 2).map(behavior), target.observations.map(behavior), result.name);
      const imported = result.observations[2];
      assert.deepEqual({ ...behavior(imported), name: 'cold-source-failure' }, behavior(target.observations[1]), result.name + ':native-cache-reader');
      assert.deepEqual(imported.cache, target.observations[0].cache, 'A cold Node consumer must preserve the complete actual Native cache bytes.');
      for (const snapshots of [result.observations.slice(0, 2), target.observations]) {
        const before = Buffer.from(snapshots[0].cache.bytesBase64, 'base64');
        for (const value of snapshots) {
          const bytes = Buffer.from(value.cache.bytesBase64, 'base64');
          assert.equal(hash(bytes), value.cache.sha256); assert.equal(bytes.length, value.cache.length);
          assert.deepEqual(bytes, before);
          assert.deepEqual(wire(JSON.parse(bytes).map(channel => ({ ...channel, ChannelType: channel.ChannelType === 0 ? 'TV' : channel.ChannelType }))), wire(value.channels));
        }
      }
    }
    for (const value of observed.validation) assert.equal(Boolean(value.error), Boolean(native.validation.find(native => native.status === value.status).error));
    observed.nativeCache = native.cache;
    observed.nativeSummary = { parsed: native.parsed.length, sources: native.sources.length, cache: native.cache.length, validation: native.validation };
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    for (const [name, close] of [['tuner', () => tuner?.close()], ['storage', () => storage?.close()], ['host', () => host?.close()]]) {
      try { await close(); cleanup[name] = true; } catch (error) { cleanupErrors.push(error); cleanup[name] = error.message; }
    }
    if (!failure && cleanupErrors.length) failure = new AggregateError(cleanupErrors, 'M3U component cleanup failed.');
    await writeFile(path.join(root, 'comparison.json'), JSON.stringify({ passed: !failure, sourceSha256: hash(sourceBytes), observed, diagnostics: errors, cleanup,
      phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack,
      scope: 'Actual native parser/BaseTunerHost/MediaSourceInfo producer fields and native consumption of Node cache. Native HTTP transport and network classification are controlled; no public playback, byte-sharing or recording executor claim.' }, null, 2) + '\n');
  }
  if (failure) throw failure;
});
