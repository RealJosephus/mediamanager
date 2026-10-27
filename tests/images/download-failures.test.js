import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const input = new URL('./fixtures/processor/single.png', import.meta.url);
const inputSha = '7ce78e46a0340f336b19b46c5ae401650bd9ef87073dc096b22d8f523c8e9ca3';
const mediaBytes = Buffer.from('Original image-download fixture media.\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reasons = (code = 'IMAGE_SOURCE') => [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('The actual image source failed.', { cause: { name: 'business-cause', stack: 'business-stack' } }),
    { code, status: 503, statusCode: 509, errors: [false, 0, '', null, undefined] })],
  ['business', { name: 'business-name', stack: 'business-stack', message: 'The image provider refused the request.',
    code, statusCode: 507, cause: undefined, errors: [false, null], details: { source: 'owned-loopback' } }]];
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const keys = value instanceof Error ? [...new Set([...Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)),
    ...['message', 'code'].filter(key => key in value)])] : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functional(value[key])]));
};
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const observed = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(observed)
  : Object.fromEntries([...new Set([...(value instanceof Error ? ['name', ...Object.getOwnPropertyNames(value),
    ...['message', 'code'].filter(key => key in value)] : Object.keys(value))])].map(key => [key, observed(value[key])]));
const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const combined = errors => errors.length === 1 ? errors[0] : new AggregateError(errors, 'Image download fixture cleanup failed.', { cause: errors[0] });

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'image-download-failures-')), files = path.join(root, 'files');
  await fs.mkdir(files); const bytes = await fs.readFile(input); assert.equal(hash(bytes), inputSha);
  await fs.writeFile(path.join(root, 'source.png'), bytes);
  const report = { input: { filename: fileURLToPath(input), bytes: bytes.length, sha256: inputSha },
    sourceReads: [], requests: [], diagnostics: [], cases: [], cleanup: {}, fixtureDisposal: {},
    serialization: 'Precise primitive and own-property comparisons execute before JSON, including undefined. Error name/stack are diagnostic.',
    phaseAcceptance: false, releaseAcceptance: false };
  const registry = new StorageRegistry(); registry.registerType('download-local', config => LocalAdapter.open(config));
  await registry.createInstance('images', 'download-local', { root: files, writable: true });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/images', instanceId: 'images', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: files, accessRoot: '/images',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnAccess: 'Owned download fixture assets.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap }), metadataPath = path.join(files, 'metadata');
  const assets = new MetadataImageAssets({ fileSystem, vfs, identityMap, metadataPath });
  const blocked = new Set(), faults = [], operations = [];
  const server = createServer((request, response) => {
    const denied = blocked.has(request.url), payload = denied ? Buffer.from('The original source is temporarily unavailable.') : bytes;
    response.once('finish', () => report.requests.push({ path: request.url, status: response.statusCode, bodyBytes: payload.length, finished: true }));
    response.writeHead(denied ? 503 : 200, { 'Content-Type': denied ? 'text/plain' : 'image/png', 'Content-Length': payload.length }); response.end(payload);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let selected, activeCase;
  const transport = async (url, { signal } = {}, fault = selected) => {
    const response = await fetch(url, { signal }), read = { url, case: activeCase, status: response.status, sourceBytes: null, cancelled: false };
    report.sourceReads.push(read);
    const consume = async () => {
      const reader = response.body.getReader(), chunks = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); } }
      finally { reader.releaseLock(); }
      const actual = Buffer.concat(chunks); read.sourceBytes = actual.length; read.sha256 = hash(actual); read.readComplete = true; return actual;
    };
    const close = async () => { await response.body.cancel(); read.cancelled = true; };
    if (fault && ['fetch', 'cancel'].includes(fault.stage)) {
      await consume(); await close();
      if (fault.stage === 'cancel') { fault.entered.resolve(); await fault.release.promise; signal.throwIfAborted(); }
      fault.injected = true;
      throw fault.reason;
    }
    const body = new Proxy(response.body, { get(target, key) {
      if (key === 'cancel') return close;
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new Proxy(response, { get(target, key) {
      if (key === 'body') return body;
      if (key === 'arrayBuffer') return async () => {
        const actual = await consume();
        if (fault?.stage === 'body') { fault.injected = true; throw fault.reason; }
        return Uint8Array.from(actual).buffer;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const processor = new ImageProcessor(), service = new MetadataImages({ fetch: transport, processor,
    logger: { error: (reason, message) => report.diagnostics.push({ case: activeCase, reasonType: typeof reason, reason: observed(reason), message }) } });
  const record = (name, value) => report.cases.push({ name, ...observed(value) });
  const caseFor = async label => {
    activeCase = label; selected = undefined;
    const directory = path.join(files, label); await fs.mkdir(directory);
    const movie = path.join(directory, 'movie.mkv'); await fs.writeFile(movie, mediaBytes);
    const loaded = { item: { Id: randomUUID(), Type: 'Movie', Path: movie, IsFileProtocol: true, SupportsLocalMetadata: true,
      IsInMixedFolder: false, MetadataLanguage: 'en' }, context: {}, imageAssets: assets, metadataPath,
      saveLocalMetadataEnabled: true, globalOptions: { ImageSavingConvention: 'Compatible' }, libraryOptions: {},
      capturePathScope() { return { metadataPath, imageAssets: assets }; } };
    return { label, loaded, movie, directory, target: path.join(directory, 'poster.png'), images: [], url: origin + '/' + label + '.png' };
  };
  const probe = async current => {
    const response = await transport(current.url, {}, undefined);
    try { assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); }
    finally { await response.body.cancel(); }
  };
  const cache = async current => {
    selected = undefined;
    const result = await service.download(current.url); assert.deepEqual(result.bytes, bytes); assert.equal(result.mimeType, 'image/png');
    blocked.add(new URL(current.url).pathname);
    try { assert.deepEqual((await service.download(current.url)).bytes, bytes); }
    finally { blocked.delete(new URL(current.url).pathname); }
  };
  const written = async current => {
    assert.equal(current.images.length, 1); assert.equal(current.images[0].Type, 'Primary'); assert.equal(current.images[0].Path, current.target);
    assert.deepEqual(await assets.read(current.target), bytes); assert.deepEqual(await fs.readFile(current.target), bytes);
    assert.deepEqual(await fs.readFile(current.movie), mediaBytes); assert.deepEqual(await fs.readFile(input), bytes);
    const handle = await fs.open(current.target, 'r'); try { assert.deepEqual(await handle.readFile(), bytes); } finally { await handle.close(); }
    await assert.rejects(handle.stat(), { code: 'EBADF' });
    await fs.writeFile(path.join(root, current.label + '.png'), await fs.readFile(current.target));
    return { path: current.target, bytes: bytes.length, sha256: hash(await fs.readFile(current.target)) };
  };
  const remote = current => ({ name: 'owned-remote-' + current.label, imageSource: 'remote', imageTypes: ['Primary'],
    async getImages() { return [{ Type: 'Primary', Url: current.url }]; },
    getImageResponse: (url, options) => transport(url, options) });
  t.after(async () => {
    for (const fault of faults) fault.release?.resolve();
    await Promise.allSettled(operations);
    const errors = [];
    for (const [name, close] of [['downloads', () => service.close()], ['processor', () => processor.close()],
      ['storage', () => registry.close()], ['http', () => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
      })]]) try { await close(); report.cleanup[name] = 'closed'; } catch (error) { errors.push(error); }
    try {
      const admission = await outcome(service.download(origin + '/after-close.png')); assert.equal(admission.failed, true);
      record('closed-admission', { admission });
    } catch (error) { errors.push(error); }
    report.cleanup.errors = observed(errors);
    assert.equal(path.dirname(root), output); assert.equal(path.dirname(files), root);
    try { await fs.rm(files, { recursive: true }); report.fixtureDisposal = { directory: files, removed: true }; }
    catch (error) { errors.push(error); report.fixtureDisposal = { failed: true, reasonType: typeof error, reason: observed(error) }; }
    try { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); } catch (error) { errors.push(error); }
    if (errors.length) throw combined(errors);
  });
  return { service, assets, caseFor, transport, probe, cache, written, remote, record,
    fault(stage, reason) { const fault = { stage, reason, entered: Promise.withResolvers(), release: Promise.withResolvers() }; faults.push(fault); selected = fault; return fault; },
    clearFault() { selected = undefined; }, track(pending) { const result = outcome(pending); operations.push(result); return result; } };
}

test('real image downloads preserve fetch causes and body-read reasons, then recover and serve their owned cache', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const stage of ['fetch', 'body']) for (const [label, reason] of reasons()) await t.test(stage + '/' + label, async () => {
    const state = await current.caseFor(stage + '-' + label), original = structuredClone(functional(reason)), fault = current.fault(stage, reason);
    const result = await current.track(current.service.download(state.url)); assert.equal(result.failed, true);
    assert.equal(fault.injected, true, 'The controlled failure follows a completed read of the actual loopback source.');
    if (stage === 'body') sameReason(result.reason, reason);
    else {
      assert.equal(result.reason.code, 'http-error'); assert.equal(Object.hasOwn(result.reason, 'cause'), true); sameReason(result.reason.cause, reason);
      if (reason?.message !== undefined) assert.equal(result.reason.message, reason.message);
      for (const key of ['status', 'statusCode', 'errors', 'details']) if (reason?.[key] !== undefined) assert.deepEqual(result.reason[key], reason[key]);
    }
    assert.deepEqual(functional(reason), original); current.clearFault();
    await current.service.saveRemote(state.loaded, state.images, { Url: state.url, Type: 'Primary' });
    const saved = await current.written(state); await current.cache(state);
    current.record(state.label, { reasonType: typeof reason, result, saved, cachedWithSourceUnavailable: true });
  });
});

test('image provider failures preserve best-effort query, HTTP response and dynamic-provider behavior with real saved PNGs', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  const run = async (mode, label, reason, failures) => {
    const state = await current.caseFor(mode + '-' + label), provider = current.remote(state), fault = { stage: 'fetch', reason };
    if (mode === 'query') provider.getImages = async () => { await current.probe(state); fault.injected = true; throw reason; };
    else if (mode === 'dynamic') Object.assign(provider, { imageSource: 'dynamic', getImage: async () => { await current.probe(state); fault.injected = true; throw reason; } });
    else provider.getImageResponse = (url, options) => current.transport(url, options, fault);
    const result = await current.service.refreshProviders(state.loaded, state.images, [provider, current.remote(state)], { ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true });
    assert.equal(fault.injected, true, 'The requested provider failure must execute after its actual source read.');
    assert.deepEqual(result, { changed: true, failures, errorMessage: failures ? reason?.message : undefined });
    const saved = await current.written(state); await current.cache(state);
    current.record(state.label, { reasonType: typeof reason, result, saved, cachedWithSourceUnavailable: true });
  };
  for (const mode of ['query', 'response', 'dynamic']) for (const [label, reason] of reasons(mode === 'response' ? 'http-error' : 'IMAGE_SOURCE')) {
    await t.test(mode + '/' + label, () => run(mode, label, reason, mode === 'dynamic' ? 1 : 0));
  }
  const reason = reasons('IMAGE_SOURCE').find(([label]) => label === 'error')[1];
  await t.test('response/known-source-code', () => run('source-code', 'error', reason, 1));
});

test('falsy caller cancellation writes no image, retains its actual reason and allows the same URL to recover', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const entry of ['download', 'provider']) for (const [label, reason] of reasons()) await t.test(entry + '/' + label, async () => {
    const state = await current.caseFor('cancel-' + entry + '-' + label), controller = new AbortController(), fault = current.fault('cancel');
    const operation = entry === 'download'
      ? current.service.saveRemote(state.loaded, state.images, { Url: state.url, Type: 'Primary' }, { signal: controller.signal })
      : current.service.refreshProviders(state.loaded, state.images, [current.remote(state)], { ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true, signal: controller.signal });
    const pending = current.track(operation); await fault.entered.promise; controller.abort(reason);
    fault.release.resolve(); const result = await pending; assert.equal(result.failed, true); sameReason(result.reason, controller.signal.reason);
    assert.deepEqual(state.images, []); await assert.rejects(fs.stat(state.target), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(state.movie), mediaBytes); current.clearFault();
    await current.service.saveRemote(state.loaded, state.images, { Url: state.url, Type: 'Primary' });
    const saved = await current.written(state); await current.cache(state);
    current.record(state.label, { reasonType: typeof reason, actualReason: controller.signal.reason, result, saved, noImageBeforeRecovery: true });
  });
});
