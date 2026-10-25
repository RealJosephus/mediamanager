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
const errorDiagnostic = error => ({ name: error.name, code: error.code, status: error.status, message: error.message, stack: error.stack });
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
    const input = { parsers, sources, cacheInfo, multiInfos, cacheBytesBase64: cacheBytes.toString('base64'), nodeCacheFile };
    const inputFile = path.join(root, 'input.json'), inputBytes = Buffer.from(JSON.stringify(input)); await writeFile(inputFile, inputBytes);
    const record = await recordOracle({ project: 'tests/plugins/fixtures/m3u/Oracle.csproj', output: path.join(root, 'native'), args: [inputFile, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(root, 'native/native.json')), native = JSON.parse(nativeBytes);
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
