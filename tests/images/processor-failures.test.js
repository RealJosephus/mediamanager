import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fstatSync } from 'node:fs';
import { request } from 'node:http';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ImageProcessor } from '../../src/images/processor.js';
import { ImageService } from '../../src/images/service.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createTestApplication } from '../helpers/application.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const source = new URL('./fixtures/processor/grid.png', import.meta.url);
const sourceSha = 'dae6cccb9c43213b28013b3877bc48ae64c8613d8dfbde6efabdb4529ba7cd1e';
const itemId = '79c70af2-ff3f-4d37-a987-1201253e518f';
const errorBody = Buffer.from('Error processing request.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const fdStat = descriptor => {
  try { return Promise.resolve(fstatSync(descriptor)); }
  catch (error) { return Promise.reject(error); }
};
const reasons = () => [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('The actual image resource failed.', { cause: { name: 'business-cause', stack: 'business-stack' } }),
    { code: 'IMAGE_SOURCE', status: 500, statusCode: 509, errors: [false, 0, '', null, undefined], details: { source: 'owned-local' } })],
  ['business', { name: 'business-name', stack: 'business-stack', message: 'The image resource refused the operation.',
    code: 'IMAGE_SOURCE', status: 500, statusCode: 507, cause: undefined, errors: [false, null], details: { source: 'owned-local' } }]];
const functional = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(functional)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error
    ? ['message', 'code', 'status', 'statusCode', 'cause', 'errors'].filter(key => key in value) : [])])]
    .filter(key => !(value instanceof Error && ['name', 'stack'].includes(key))).map(key => [key, functional(value[key])]));
const observed = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(observed)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error
    ? ['name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors'].filter(key => key in value) : [])])]
    .map(key => [key, observed(value[key])]));
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const bytesValue = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
const capture = (url, signal) => new Promise(resolve => {
  const pending = request(url, { signal }, response => {
    const chunks = [], errors = [];
    const finish = ended => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), ended, transportErrors: errors });
    response.on('data', chunk => chunks.push(chunk)); response.once('end', () => finish(true));
    response.once('error', error => { errors.push(observed(error)); finish(false); }); response.once('close', () => finish(false));
  });
  pending.once('error', error => resolve({ requestFailed: true, bytes: Buffer.alloc(0), ended: false, transportError: observed(error) })); pending.end();
});

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'image-processor-failures-')), files = path.join(root, 'files');
  await fs.mkdir(files); const bytes = await fs.readFile(source); assert.equal(hash(bytes), sourceSha);
  await fs.writeFile(path.join(root, 'source.png'), bytes); await fs.writeFile(path.join(files, 'grid.png'), bytes);
  const report = { input: { filename: fileURLToPath(source), ...bytesValue(bytes) }, cases: [], reads: [], faults: [], diagnostics: [], sends: [], http: [],
    cleanup: {}, fixtureDisposal: {}, scope: 'Real Local adapter, VFS, image assets and processor; actual HTTP image route with controlled item/image input, no PostgreSQL or Native execution claim.',
    serialization: 'Primitive and own-property comparisons execute before JSON, including undefined. Only actual Error name/stack are projected for functional comparisons.',
    phaseAcceptance: false, releaseAcceptance: false };
  const registry = new StorageRegistry(), operations = [], readers = [], actualSends = [], diagnostics = [];
  let processor, service, application, selected, activeCase, baseline, assets;
  const track = pending => { const result = outcome(pending); operations.push(result); return result; };
  t.after(async () => {
    const errors = [];
    await Promise.allSettled(operations);
    try { for (const { observation } of readers) assert.equal(observation.closed, true); } catch (error) { errors.push(error); }
    for (const reader of readers) if (!reader.observation.closed) try { await reader.close(); } catch (error) { errors.push(error); }
    for (const [name, close] of [['images', () => service?.close()], ['processor', () => processor?.close()],
      ['application', async () => { application?.beginClose(); await application?.drainRequests(); }],
      ['http', () => application && new Promise((resolve, reject) => {
        application.server.close(error => error ? reject(error) : resolve()); application.server.closeIdleConnections();
      })], ['storage', () => registry.close()]]) {
      try { await close(); report.cleanup[name] = 'closed'; } catch (error) { errors.push(error); }
    }
    try {
      for (const { observation } of readers) assert.equal(observation.closed, true);
      if (processor && assets) {
        const late = await outcome(processor.process({ image: { Path: path.join(files, 'grid.png') }, assets }));
        assert.equal(late.failed, true); report.cleanup.processorAdmission = observed(late);
      }
      if (assets) { const late = await outcome(assets.stat(path.join(files, 'grid.png'))); assert.equal(late.failed, true); report.cleanup.storageAdmission = observed(late); }
      if (application) assert.equal(application.server.listening, false);
    } catch (error) { errors.push(error); }
    report.cleanup.errors = observed(errors);
    try {
      assert.equal(path.dirname(root), output); assert.equal(path.dirname(files), root);
      await fs.rm(files, { recursive: true }); report.fixtureDisposal = { directory: files, removed: true };
    } catch (error) { errors.push(error); report.fixtureDisposal = { failed: true, reason: observed(error), reasonType: typeof error }; }
    try { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Image processor fixture cleanup failed.', { cause: errors[0] });
  });
  registry.registerType('processor-local', config => LocalAdapter.open(config));
  const adapter = await registry.createInstance('processor', 'processor-local', { root: files, writable: true });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/processor', instanceId: 'processor', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: files, accessRoot: '/processor',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnAccess: 'Owned image processor fixture files.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap }), filename = path.join(files, 'grid.png');
  assets = new MetadataImageAssets({ fileSystem, vfs, identityMap });
  const stat = adapter.stat.bind(adapter), openRead = adapter.openRead.bind(adapter), readFile = fileSystem.readFile.bind(fileSystem);
  const mark = (fault, stage, value) => { fault.entered = true; report.faults.push({ case: activeCase, stage, reasonType: typeof fault.reason, reason: observed(fault.reason), ...value }); };
  adapter.stat = async (value, options) => {
    const actual = await stat(value, options), fault = selected;
    if (value === '/grid.png' && fault?.stage === 'stat') { mark(fault, 'stat', { size: String(actual.size), kind: actual.kind }); throw fault.reason; }
    return actual;
  };
  adapter.openRead = async (value, options) => {
    const fault = selected;
    if (value === '/grid.png' && ['read', 'http-open'].includes(fault?.stage)) {
      const file = await adapter.openFile(value, 'r', options), descriptor = file.fd, info = await file.stat({ bigint: true });
      const observation = { case: activeCase, path: value, descriptor, closed: false, bytes: 0, stage: fault.stage };
      report.reads.push(observation); let closing;
      const close = () => closing ??= (async () => {
        await file.close(); observation.closed = true;
        const released = await outcome(fdStat(descriptor)); assert.equal(released.failed, true); assert.equal(released.reason?.code, 'EBADF');
        observation.fdRelease = observed(released);
        if (fault.cleanupFailure) { observation.cleanupReason = 0; throw 0; }
      })();
      readers.push({ close, observation });
      if (fault.stage === 'http-open') { await close(); mark(fault, 'http-open', { size: String(info.size) }); throw fault.reason; }
      return { size: info.size, modified: new Date(Number(info.mtimeNs / 1000000n)).toISOString(), close,
        stream: (async function* () {
          const buffer = Buffer.alloc(Number(info.size)), result = await file.read(buffer, 0, buffer.length, 0);
          const actual = buffer.subarray(0, result.bytesRead); assert.deepEqual(actual, bytes);
          observation.bytes = actual.length; observation.source = bytesValue(actual); yield actual;
          mark(fault, 'read', { source: bytesValue(actual) }); throw fault.reason;
        })() };
    }
    const handle = await openRead(value, options), observation = { case: activeCase, path: value, closed: false };
    report.reads.push(observation);
    const close = async () => { await handle.close(); observation.closed = true; };
    readers.push({ close, observation }); return { ...handle, close };
  };
  fileSystem.readFile = async (...args) => {
    const actual = await readFile(...args), fault = selected;
    if (fault?.stage === 'cache' && args[0] === baseline?.path) { assert.deepEqual(actual, baseline.bytes); mark(fault, 'cache', { source: bytesValue(actual) }); throw fault.reason; }
    return actual;
  };
  const logger = { error: (reason, message) => {
    diagnostics.push({ case: activeCase, reason, message });
    report.diagnostics.push({ case: activeCase, reasonType: typeof reason, reason: observed(reason), message });
  } };
  processor = new ImageProcessor({ fileSystem, cachePath: path.join(files, 'cache'), logger });
  const image = { Path: filename, Type: 'Primary', Width: 20, Height: 12, DateModified: '2024-01-01T00:00:00Z' };
  const processImage = () => processor.process({ image, assets, Width: 8, Quality: 80, SupportedOutputFormats: ['Png'] });
  const recovery = async name => {
    selected = undefined; const result = await processImage(); assert.equal(result.original, false); assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(await processor.getImageSize(result.bytes, result.path), { Width: 8, Height: 5 });
    if (baseline) assert.deepEqual(result.bytes, baseline.bytes);
    assert.deepEqual(await fs.readFile(result.path), result.bytes); assert.deepEqual(await assets.read(filename), bytes);
    assert.deepEqual(await fs.readFile(source), bytes); await fs.writeFile(path.join(root, name + '.png'), result.bytes);
    return result;
  };
  baseline = await recovery('baseline'); report.baseline = { path: baseline.path, ...bytesValue(baseline.bytes) };
  const record = (name, result, extra = {}) => report.cases.push({ name, ...observed(result), ...observed(extra) });
  const fault = (name, stage, reason, extra = {}) => { activeCase = name; selected = { stage, reason, entered: false, ...extra }; return selected; };
  const http = async () => {
    service = new ImageService({ fileSystem, vfs, identityMap, processor, logger });
    service.load = async id => { assert.equal(id.replaceAll('-', '').toLowerCase(), itemId.replaceAll('-', '').toLowerCase());
      return { item: { Id: itemId, Name: 'Controlled image input', Type: 'Movie' }, imageAssets: assets, images: [image] }; };
    const result = service.result.bind(service);
    service.result = input => {
      const value = result(input), send = value.send;
      value.send = async (...args) => {
        const actual = await outcome(send(...args)); actualSends.push({ case: activeCase, ...actual });
        report.sends.push({ case: activeCase, reasonType: typeof actual.reason, ...observed(actual) });
        if (actual.failed) throw actual.reason;
        return actual.value;
      };
      return value;
    };
    application = await createTestApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      authentication: { async authenticate() { return { IsAuthenticated: true, IsAdministrator: true }; }, authorize() {} }, images: service,
      onError: (reason, context) => report.diagnostics.push({ case: activeCase, reasonType: typeof reason, reason: observed(reason), phase: context?.phase, request: context?.request.url }) });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', resolve); });
    return 'http://127.0.0.1:' + application.server.address().port + '/Items/' + itemId + '/Images/Primary';
  };
  return { root, bytes, filename, assets, processor, process: processImage, recovery, fault, record, track, http,
    sendResults: () => actualSends, diagnosticsFor: name => diagnostics.filter(value => value.case === name),
    capture: async url => { const value = await capture(url, t.signal); report.http.push({ case: activeCase, ...value, bytes: bytesValue(value.bytes) }); return value; },
    readersClosed: () => { for (const { observation } of readers) if (observation.case === activeCase) assert.equal(observation.closed, true); },
    read: () => assets.read(filename), clearFault() { selected = undefined; } };
}

test('image processor retains actual stat reasons and recovers the same real PNG conversion', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons()) await t.test(label, async () => {
    const fault = current.fault('stat-' + label, 'stat', reason), original = structuredClone(functional(reason));
    const result = await current.track(current.process()); assert.equal(result.failed, true); assert.equal(fault.entered, true);
    sameReason(result.reason, reason); assert.deepEqual(functional(reason), original);
    const recovered = await current.recovery('stat-' + label); current.record('stat-' + label, result, { reasonType: typeof reason, recovered: bytesValue(recovered.bytes) });
  });
});

test('real cache read failures keep original-image fallback and recover existing converted bytes', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons()) await t.test(label, async () => {
    const name = 'cache-' + label, fault = current.fault(name, 'cache', reason), result = await current.process(); assert.equal(fault.entered, true);
    assert.equal(result.original, true); assert.equal(result.path, current.filename); assert.equal(result.mimeType, 'image/png');
    for (const entry of current.diagnosticsFor(name)) sameReason(entry.reason, reason);
    assert.deepEqual(await current.read(), current.bytes);
    const recovered = await current.recovery('cache-' + label); current.record('cache-' + label, { result }, { reasonType: typeof reason, recovered: bytesValue(recovered.bytes) });
  });
});

test('image asset reads retain real chunk failures and ordered cleanup after actual descriptor release', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const cleanupFailure of [false, true]) for (const [label, reason] of reasons()) await t.test((cleanupFailure ? 'read-and-close/' : 'read/') + label, async () => {
    const name = (cleanupFailure ? 'read-close-' : 'read-') + label, fault = current.fault(name, 'read', reason, { cleanupFailure });
    const result = await current.track(current.read()); assert.equal(result.failed, true); assert.equal(fault.entered, true);
    current.readersClosed();
    if (!cleanupFailure) sameReason(result.reason, reason);
    else {
      assert.equal(Object.hasOwn(result.reason, 'cause'), true); sameReason(result.reason.cause, reason);
      sameReason(result.reason.errors, [reason, 0]);
      for (const key of ['code', 'status', 'statusCode']) if (reason?.[key] !== undefined) assert.equal(result.reason[key], reason[key]);
    }
    current.clearFault(); assert.deepEqual(await current.read(), current.bytes);
    const recovered = await current.recovery(name); current.record(name, result, { reasonType: typeof reason, recovered: bytesValue(recovered.bytes) });
  });
});

test('actual image HTTP failures preserve source causes, complete error bodies and subsequent original PNGs', { timeout: 60000 }, async t => {
  const current = await fixture(t), url = await current.http();
  for (const stage of ['stat', 'http-open']) for (const [label, reason] of reasons()) await t.test(stage + '/' + label, async () => {
    const name = 'http-' + stage + '-' + label, fault = current.fault(name, stage, reason);
    const response = await current.capture(url); assert.equal(fault.entered, true); assert.equal(response.ended, true);
    assert.equal(response.status, 500); assert.deepEqual(response.bytes, errorBody); assert.equal(response.headers['content-type']?.split(';')[0], 'text/plain');
    if (response.headers['content-length'] !== undefined) assert.equal(Number(response.headers['content-length']), response.bytes.length);
    const send = current.sendResults().find(value => value.case === name); assert.equal(send?.failed, true);
    sameReason(send.reason, reason); current.readersClosed();
    current.clearFault(); const recovered = await current.capture(url); assert.equal(recovered.status, 200); assert.equal(recovered.ended, true);
    assert.deepEqual(recovered.bytes, current.bytes); assert.equal(recovered.headers['content-type']?.split(';')[0], 'image/png');
    if (recovered.headers['content-length'] !== undefined) assert.equal(Number(recovered.headers['content-length']), recovered.bytes.length);
    await fs.writeFile(path.join(current.root, name + '.png'), recovered.bytes);
    current.record(name, { response: { status: response.status, headers: response.headers, body: bytesValue(response.bytes) },
      recovered: { status: recovered.status, headers: recovered.headers, body: bytesValue(recovered.bytes) }, sourceFailure: send });
  });
});
