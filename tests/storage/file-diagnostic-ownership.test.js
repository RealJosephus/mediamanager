import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, StorageError } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));
const fields = { code: 'reader-rejected', status: 409, statusCode: 503 };
const properties = ['message', 'code', 'status', 'statusCode'];
function reason(property, asError = false) {
  const value = Object.assign(asError ? new Error('The actual file reader was rejected.')
    : { message: 'The actual file reader was rejected.' }, fields);
  if (property) Object.defineProperty(value, property, { get() { throw new Error(`The ${property} diagnostic getter must not replace the rejection.`); } });
  return Object.freeze(value);
}
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [key, !Object.hasOwn(descriptor, 'value') ? { accessor: true }
      : key === 'errors' ? descriptor.value.map(observation)
        : key === 'cause' ? observation(descriptor.value) : descriptor.value];
  }));
}

test('storage error diagnostics cannot replace failures after actual Local stat and reader cleanup', { timeout: 60000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'file-diagnostic-ownership-')), disk = path.join(root, 'disk');
  await fs.mkdir(disk);
  const source = Buffer.alloc(131079, 0x62), prefix = source.subarray(0, 65536);
  await fs.writeFile(path.join(disk, 'source.bin'), source);
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  registry.registerType('local', config => LocalAdapter.open(config));
  const adapter = await registry.createInstance('local', 'local', { root: disk, writable: true });
  vfs.mount({ path: '/local', instanceId: 'local', capabilities: { create: true, replace: true, delete: true } });
  const identityRoot = path.join(root, 'identities'), filename = path.join(identityRoot, 'source.bin');
  identityMap.addPrefix({ identityRoot, accessRoot: '/local', style: process.platform === 'win32' ? 'windows' : 'posix',
    returnAccess: 'The diagnostic regression uses the actual Local adapter and its file descriptor.' });
  const files = new StorageFileSystem({ vfs, identityMap }), samples = [];
  const stat = adapter.fileStat.bind(adapter), openRead = adapter.openRead.bind(adapter);
  let selected;
  t.after(async () => {
    selected = undefined; adapter.fileStat = stat; adapter.openRead = openRead;
    for (const sample of samples) { sample.consumed.resolve(); sample.release.resolve(); }
    await Promise.allSettled(samples.map(sample => sample.pending));
    const errors = [];
    for (const operation of [...samples.map(sample => () => sample.file?.close()), () => files.close(), () => registry.close()]) {
      try { await operation(); } catch (error) { errors.push(error); }
    }
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ errors: errors.map(observation),
      descriptors: samples.filter(sample => sample.file).map(sample => sample.file.fd) }, null, 2) + '\n');
    assert.deepEqual(errors, []); assert.ok(samples.every(sample => !sample.file || sample.file.fd === -1));
    assert.equal(path.dirname(disk), root); await fs.rm(disk, { recursive: true });
  });
  adapter.fileStat = async (...args) => {
    const value = await stat(...args);
    if (selected?.mode === 'stat') { selected.actualStats++; assert.equal(value.size, source.length); throw selected.primary; }
    return value;
  };
  for (const property of [...properties, 'errors']) await t.test('native-error-' + property, async () => {
    const primary = Object.assign(new StorageError('permission-denied', 'The stat completion was rejected.'), { status: 409, statusCode: 503, errors: [] });
    Object.defineProperty(primary, property, { get() { throw new Error('The native error diagnostic getter failed.'); } });
    Object.freeze(primary);
    const sample = selected = { mode: 'stat', primary, actualStats: 0 };
    const result = await outcome(files.stat(filename)); selected = undefined;
    assert.equal(sample.actualStats, 1); assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(result.error, primary);
    assert.equal((await files.stat(filename)).size, source.length); assert.deepEqual(await fs.readFile(path.join(disk, 'source.bin')), source);
    await fs.writeFile(path.join(root, 'native-error-' + property + '.json'), JSON.stringify({ property, actualStats: sample.actualStats,
      failure: observation(result.error), originalIdentityPreserved: true, recovered: true }, null, 2) + '\n');
  });
  adapter.openRead = async (...args) => {
    const sample = selected;
    if (!sample || sample.mode === 'stat') return openRead(...args);
    const file = await adapter.openFile(args[0], 'r'); sample.file = file;
    const info = await file.stat({ bigint: true }); let closing;
    return {
      size: info.size, contentLength: info.size, totalSize: info.size,
      stream: (async function* () {
        const bytes = Buffer.alloc(65536), read = await file.read(bytes, 0, bytes.length, 0);
        sample.prefix = Buffer.from(bytes.subarray(0, read.bytesRead));
        yield sample.prefix;
        if (sample.mode === 'stream') await sample.consumed.promise;
        throw sample.primary;
      })(),
      close: () => closing ??= (async () => {
        sample.closing.resolve(); await sample.release.promise;
        await file.close(); sample.closes++;
        if (sample.cleanup) throw false;
      })(),
    };
  };
  const cases = ['readFile', 'stream'].flatMap(mode => [
    ...[undefined, ...properties].map(property => ({ mode, property, cleanup: true, label: `${mode}-aggregate-${property ?? 'public'}` })),
    ...properties.map(property => ({ mode, property, cleanup: false, label: `${mode}-single-${property}` })),
  ]).concat(['message', 'code'].map(property => ({ mode: 'readFile', property, cleanup: true, asError: true, label: 'frozen-error-' + property })));
  for (const definition of cases) await t.test(definition.label, async () => {
    const sample = { ...definition, primary: reason(definition.property, definition.asError), closes: 0,
      closing: Promise.withResolvers(), release: Promise.withResolvers(), consumed: Promise.withResolvers(), received: [] };
    samples.push(sample); selected = sample;
    const work = sample.mode === 'readFile' ? files.readFile(filename) : (async () => {
      for await (const bytes of files.createReadStream(filename)) { sample.received.push(Buffer.from(bytes)); sample.consumed.resolve(); }
    })();
    sample.pending = outcome(work);
    // An unexpected pre-read failure also ends the barrier wait so teardown
    // can release every admitted FD without waiting for an impossible event.
    await Promise.race([sample.closing.promise, sample.pending.then(() => { throw new Error('The reader ended before its actual close barrier.'); })]);
    let settled = false; void sample.pending.then(() => { settled = true; });
    await immediate(); assert.equal(settled, false); assert.ok(sample.file.fd >= 0);
    assert.deepEqual(sample.prefix, prefix);
    if (sample.mode === 'stream') assert.deepEqual(Buffer.concat(sample.received), prefix);
    sample.release.resolve(); const result = await sample.pending; selected = undefined;
    assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(sample.closes, 1); assert.equal(sample.file.fd, -1);
    if (sample.cleanup) {
      assert.ok(result.error instanceof AggregateError); assert.equal(result.error.cause, sample.primary);
      assert.deepEqual(result.error.errors, [sample.primary, false]);
    } else if (sample.mode === 'readFile') assert.equal(result.error, sample.primary);
    else { assert.ok(result.error instanceof Error); assert.equal(result.error.cause, sample.primary); }
    if (sample.cleanup || sample.mode === 'stream') for (const [key, value] of Object.entries(fields)) {
      assert.equal(result.error[key], sample.property === key ? undefined : value);
    }
    assert.deepEqual(await files.readFile(filename), source);
    await fs.writeFile(path.join(root, definition.label + '.json'), JSON.stringify({ sample: definition.label,
      failure: observation(result.error), descriptor: sample.file.fd, closes: sample.closes,
      prefix: sample.prefix.toString('base64'), received: Buffer.concat(sample.received).toString('base64'), recovered: true }, null, 2) + '\n');
  });
});
