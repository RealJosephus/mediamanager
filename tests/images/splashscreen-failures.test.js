import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { SplashscreenImageGenerator } from '../../src/images/splashscreen.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = bytes => ({ bytes: bytes.length, sha256: hash(bytes) });
const bytesValue = bytes => ({ ...descriptor(bytes), base64: bytes.toString('base64') });
const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const functional = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(functional)
  : Object.fromEntries(Object.getOwnPropertyNames(value).filter(key => !(value instanceof Error && ['name', 'stack'].includes(key)))
    .map(key => [key, functional(value[key])]));
const reasons = () => [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', Object.assign(new Error('The actual splashscreen storage operation rejected.', {
    cause: { name: 'Business source cause', stack: 'Retained business stack', value: undefined },
  }), { code: 'splashscreen-source', status: 409, statusCode: 503, errors: [false, 0, '', null, undefined] })],
  ['business', { name: 'Business source failure', stack: 'Retained business stack',
    message: 'The actual splashscreen storage operation refused completion.', code: 0, status: 422, statusCode: 507,
    cause: undefined, errors: [false, 0, '', null, undefined] }]];

test('splashscreen preserves source stat and completed output rejection reasons and accepts a real subsequent generation', { timeout: 180000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'splashscreen-failures-')); assertValidationOutputChild(root);
  const files = path.join(root, 'files'); await fs.mkdir(files);
  const source = path.join(files, 'source.png'), target = path.join(files, 'splashscreen.png');
  const input = await fs.readFile(new URL('./fixtures/processor/grid.png', import.meta.url));
  const report = { schemaVersion: 1, scope: 'Real Local adapter, VFS, metadata image assets, raster generation and complete output file; no Native execution or HTTP claim.',
    input: bytesValue(input), cases: [], diagnostics: [], cleanup: {}, phaseAcceptance: false, releaseAcceptance: false,
    serialization: 'Primitive and own fields are compared in process, including undefined. JSON omits undefined object fields and uses null in array slots; inspections retain raw reasons diagnostically.' };
  const registry = new StorageRegistry(); let generator, fileSystem, selected, current, writtenBytes;
  t.after(async () => {
    const errors = [];
    for (const [name, operation] of [['generator', () => generator?.close()], ['storage', () => registry.close()]]) {
      try { await operation(); report.cleanup[name] = 'closed'; } catch (error) { errors.push(error); }
    }
    try {
      const late = await outcome(generator.createSplashscreen([source], [source]));
      report.cleanup.late = { failed: late.failed, inspection: inspect(late.reason, { depth: null }) };
      assert.equal(late.failed, true);
      const lateStorage = await outcome(fileSystem.stat(source));
      report.cleanup.lateStorage = { failed: lateStorage.failed, inspection: inspect(lateStorage.reason, { depth: null }) };
      assert.equal(lateStorage.failed, true);
      assert.equal(path.dirname(files), root); await fs.rm(files, { recursive: true }); report.cleanup.filesRemoved = true;
    } catch (error) { errors.push(error); }
    report.cleanup.errors = errors.map(error => inspect(error, { depth: null }));
    try { await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Splashscreen failure fixture cleanup failed.', { cause: errors[0] });
  });
  registry.registerType('splashscreen-local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('source', 'splashscreen-local', { root: files, writable: true });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/splashscreen', instanceId: 'source', capabilities: {
    create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: files, accessRoot: '/splashscreen',
    style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnAccess: 'Owned splashscreen failure fixture.' });
  fileSystem = new StorageFileSystem({ vfs, identityMap }); await fileSystem.writeFile(source, input);
  const stat = fileSystem.stat.bind(fileSystem), write = fileSystem.writeFile.bind(fileSystem);
  fileSystem.stat = async (filename, options) => {
    const actual = await stat(filename, options);
    if (selected?.stage === 'stat' && filename === source) {
      selected.entered = true; current.sourceStat = { bytes: String(actual.size), file: actual.isFile() }; throw selected.reason;
    }
    return actual;
  };
  fileSystem.writeFile = async (filename, bytes, options) => {
    const actual = await write(filename, bytes, options);
    if (filename === target && current) { writtenBytes = Buffer.from(bytes); current.written = descriptor(writtenBytes); }
    if (selected?.stage === 'write' && filename === target) { selected.entered = true; throw selected.reason; }
    return actual;
  };
  const assets = new MetadataImageAssets({ fileSystem, stateRoots: [files] });
  generator = new SplashscreenImageGenerator({ dataPath: files, assets, random: () => 0,
    logger: { error: (...args) => report.diagnostics.push(inspect(args, { depth: null })) } });
  await generator.createSplashscreen([source], [source]);
  const baseline = await fs.readFile(target), baselineFilename = path.join(root, 'baseline.png');
  await fs.writeFile(baselineFilename, baseline, { flag: 'wx' });
  report.baseline = { filename: 'baseline.png', ...descriptor(baseline) };
  assert.deepEqual(baseline.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(baseline.readUInt32BE(16), 1920); assert.equal(baseline.readUInt32BE(20), 1080);
  for (const stage of ['stat', 'write']) for (const [label, reason] of reasons()) await t.test(stage + '/' + label, async () => {
    current = { stage, label, reason: functional(reason), reasonType: typeof reason,
      reasonInspection: inspect(reason, { depth: null }) }; report.cases.push(current);
    selected = { stage, reason, entered: false };
    const failed = await outcome(generator.createSplashscreen([source], [source]));
    current.outcome = { failed: failed.failed, reason: functional(failed.reason), reasonType: typeof failed.reason,
      reasonInspection: inspect(failed.reason, { depth: null }) };
    assert.equal(selected.entered, true); current.sourceEntered = true;
    assert.equal(failed.failed, true); assert.equal(typeof failed.reason, typeof reason);
    assert.deepEqual(functional(failed.reason), functional(reason));
    const after = await fs.readFile(target); current.afterFailure = descriptor(after);
    assert.deepEqual(after, baseline);
    if (stage === 'stat') assert.equal(Object.hasOwn(current, 'written'), false);
    else { assert.deepEqual(writtenBytes, after); current.failedWritten = current.written; }
    selected = undefined;
    const recovered = await outcome(generator.createSplashscreen([source], [source]));
    assert.equal(recovered.failed, false); const bytes = await fs.readFile(target); current.recovery = descriptor(bytes);
    assert.deepEqual(bytes, baseline); assert.deepEqual(await fileSystem.readFile(source), input);
    assert.deepEqual(writtenBytes, bytes);
    current = undefined;
  });
});
