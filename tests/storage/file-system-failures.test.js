import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, StorageError } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const sourceBytes = Buffer.alloc(196731, 0x6d);
const reasons = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined]];
const failure = message => Object.assign(new Error(message, { cause: { name: 'business-name', stack: 'business-stack' } }),
  { code: 'controlled-file-failure', status: 503, statusCode: 509 });
function functionalFailure(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functionalFailure);
  const keys = value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functionalFailure(value[key])]));
}
const rejected = async pending => {
  const result = await Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
  assert.equal(result.failed, true, 'The real failed operation must reject.');
  return result.reason;
};
const assertReason = (actual, expected) => assert.deepEqual(functionalFailure(actual), functionalFailure(expected));
function assertReasons(actual, expected) {
  assert.ok(Array.isArray(actual.errors));
  assertReason(actual.cause, expected[0]);
  assert.deepEqual(actual.errors.map(functionalFailure), expected.map(functionalFailure));
  for (const key of ['code', 'status', 'statusCode']) assert.equal(actual[key], expected[0]?.[key]);
}

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'file-system-failures-'));
  const diskRoot = path.join(root, 'disk'), remoteRoot = path.join(root, 'remote');
  await fs.mkdir(diskRoot); await fs.mkdir(remoteRoot); await fs.mkdir(path.join(diskRoot, 'spool'));
  await fs.writeFile(path.join(diskRoot, 'source.bin'), sourceBytes);
  const registry = new StorageRegistry(), states = [];
  let selected;
  const disk = await LocalAdapter.open({ root: diskRoot, writable: true });
  const remoteDisk = await LocalAdapter.open({ root: remoteRoot, writable: true });
  // A sequential storage instance has real files but intentionally exposes no random handles.
  const remote = { capabilities: remoteDisk.capabilities };
  for (const name of ['stat', 'listPage', 'openRead', 'health', 'close', 'write', 'mkdir', 'delete', 'rename', 'watch']) {
    remote[name] = remoteDisk[name].bind(remoteDisk);
  }
  registry.registerType('disk', () => disk); registry.registerType('sequential', () => remote);
  await registry.createInstance('disk', 'disk', {}); await registry.createInstance('remote', 'sequential', {});
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
  vfs.mount({ path: '/disk', instanceId: 'disk', capabilities });
  vfs.mount({ path: '/remote', instanceId: 'remote', capabilities });
  for (const name of ['disk', 'remote']) identityMap.addPrefix({ identityRoot: 'Z:\\' + name, accessRoot: '/' + name,
    style: 'windows', returnAccess: 'The original mapped identity is retained for real storage failure observations.' });
  const files = new StorageFileSystem({ vfs, identityMap }); files.spoolRoot = 'Z:\\disk\\spool';
  const openRead = disk.openRead.bind(disk), fileStat = disk.fileStat.bind(disk), stat = disk.stat.bind(disk);
  const remove = disk.delete.bind(disk), write = disk.write.bind(disk);
  disk.fileStat = async (...args) => { const value = await fileStat(...args); if (selected?.kind === 'stat') throw selected.primary; return value; };
  disk.stat = async (...args) => { const value = await stat(...args); if (selected?.kind === 'mkdir') throw selected.primary; return value; };
  disk.delete = async (...args) => {
    const state = selected, value = await remove(...args);
    if (state?.kind === 'remove') throw state.primary;
    if (state?.kind === 'spool' && Object.hasOwn(state, 'removeFailure')) throw state.removeFailure;
    return value;
  };
  disk.openRead = async (...args) => {
    const state = selected;
    if (state?.kind === 'open') {
      const handle = await openRead(...args); await handle.close(); throw state.primary;
    }
    if (!state || !['read', 'copy', 'spool'].includes(state.kind)) return openRead(...args);
    const filename = path.resolve(diskRoot, ...args[0].split('/').filter(Boolean));
    assert.ok(filename.startsWith(diskRoot + path.sep));
    const file = await fs.open(filename, 'r'), info = await file.stat(); state.file = file;
    const iterator = (async function* () {
      let position = 0;
      while (position < info.size) {
        const bytes = Buffer.alloc(Math.min(65536, info.size - position));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
        if (!bytesRead) throw new Error('The controlled source ended early.');
        position += bytesRead; yield bytes.subarray(0, bytesRead);
      }
    })();
    state.iterator = iterator;
    const stream = state.kind === 'read' ? {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        const value = await iterator.next();
        if (!state.prefix) { state.prefix = Buffer.from(value.value); return value; }
        if (state.mode === 'stream') await state.prefixConsumed.promise;
        throw state.primary;
      },
      return: value => iterator.return(value),
    } : { [Symbol.asyncIterator]: () => iterator };
    return { size: BigInt(info.size), totalSize: BigInt(info.size), stream, async close() {
      state.closeEntered.resolve(); await state.release.promise;
      await file.close();
      if (Object.hasOwn(state, 'cleanup')) throw state.cleanup;
    } };
  };
  const partialWrite = async (directory, value, data, options) => {
    const state = selected;
    if (!state || !['copy', 'spool'].includes(state.kind)) return directory === diskRoot ? write(value, data, options) : remoteDisk.write(value, data, options);
    const iterator = data[Symbol.asyncIterator](), first = await iterator.next();
    state.prefix = Buffer.from(first.value);
    state.destination = path.join(directory, ...value.split('/').filter(Boolean));
    await fs.writeFile(state.destination, state.prefix);
    throw state.primary;
  };
  disk.write = (value, data, options) => partialWrite(diskRoot, value, data, options);
  remote.write = (value, data, options) => partialWrite(remoteRoot, value, data, options);
  t.after(async () => {
    selected = undefined;
    for (const state of states) { state.release.resolve(); state.prefixConsumed.resolve(); }
    await Promise.allSettled(states.flatMap(state => state.pending ? [state.pending] : []));
    try { await registry.close(); }
    finally {
      await Promise.all(states.map(state => state.file?.close()));
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('file-system-failures-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  return {
    files, diskRoot, remoteRoot,
    select(values) {
      const state = { closeEntered: Promise.withResolvers(), release: Promise.withResolvers(), prefixConsumed: Promise.withResolvers(), ...values };
      states.push(state); selected = state; return state;
    },
    async recovery() {
      selected = undefined;
      assert.deepEqual(await files.readFile('Z:\\disk\\source.bin'), sourceBytes);
      await files.copyFile('Z:\\disk\\source.bin', 'Z:\\remote\\recovered.bin');
      assert.deepEqual(await fs.readFile(path.join(remoteRoot, 'recovered.bin')), sourceBytes);
    },
  };
}

async function releaseRead(state, pending) {
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await state.closeEntered.promise; await immediate();
  assert.equal(settled, false, 'The failed operation waits for its actual reader cleanup.');
  state.release.resolve();
}
async function assertReadClosed(state) {
  await assert.rejects(state.file.stat(), { code: 'EBADF' });
  await state.iterator.return();
}

test('mapped stat, recursive mkdir and forced removal preserve primitive failures and actual side effects', { timeout: 30000 }, async t => {
  const current = await fixture(t);
  for (const kind of ['stat', 'mkdir', 'remove']) for (const [label, primary] of reasons) await t.test(kind + '/' + label, async () => {
    const name = 'Z:\\disk\\remove.bin';
    if (kind === 'remove') await current.files.writeFile(name, sourceBytes);
    current.select({ kind, primary });
    const operation = kind === 'stat' ? current.files.stat('Z:\\disk\\source.bin')
      : kind === 'mkdir' ? current.files.mkdir('Z:\\disk\\uncreated', { recursive: true }) : current.files.rm(name, { force: true });
    assertReason(await rejected(operation), primary);
    if (kind === 'mkdir') await assert.rejects(fs.stat(path.join(current.diskRoot, 'uncreated')), { code: 'ENOENT' });
    if (kind === 'remove') await assert.rejects(fs.stat(path.join(current.diskRoot, 'remove.bin')), { code: 'ENOENT' });
    await current.recovery();
  });
  const known = Object.assign(new StorageError('permission-denied', 'The provider denied the file.', { path: 'source.bin' }),
    { status: 403, statusCode: 409 });
  current.select({ kind: 'stat', primary: known });
  const mapped = await rejected(current.files.stat('Z:\\disk\\source.bin'));
  assert.equal(mapped.code, 'EACCES'); assert.equal(mapped.storageCode, 'permission-denied');
  assert.equal(mapped.status, 403); assert.equal(mapped.statusCode, 409); assertReason(mapped.cause, known);
  const business = { code: 'constructor', message: 'The provider rejected this file.', name: 'business-name', stack: 'business-stack' };
  current.select({ kind: 'stat', primary: business }); assertReason(await rejected(current.files.stat('Z:\\disk\\source.bin')), business);
  await current.recovery();
});

test('mapped whole-file and Node stream readers retain source failures and ordered real close failures', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [label, primary] of reasons) await t.test('stream-open/' + label, async () => {
    current.select({ kind: 'open', primary });
    const actual = await rejected((async () => { for await (const _chunk of current.files.createReadStream('Z:\\disk\\source.bin')) assert.fail('An open failure cannot yield source bytes.'); })());
    assertReason(actual.cause, primary); await current.recovery();
  });
  for (const mode of ['file', 'stream']) for (const [label, primary] of reasons) for (const closeFails of [false, true]) {
    await t.test(mode + '/' + label + '/' + closeFails, async () => {
      const cleanup = failure('The file reader failed after actually closing.');
      const state = current.select({ kind: 'read', mode, primary, ...(closeFails ? { cleanup } : {}) });
      const delivered = [];
      const pending = mode === 'file' ? current.files.readFile('Z:\\disk\\source.bin') : (async () => {
        for await (const chunk of current.files.createReadStream('Z:\\disk\\source.bin')) {
          delivered.push(Buffer.from(chunk)); state.prefixConsumed.resolve();
        }
      })();
      state.pending = pending;
      const result = rejected(pending); await releaseRead(state, pending);
      const actual = await result;
      if (closeFails) assertReasons(actual, [primary, cleanup]);
      else if (mode === 'stream') assertReason(actual.cause, primary);
      else assertReason(actual, primary);
      assert.deepEqual(state.prefix, sourceBytes.subarray(0, 65536));
      if (mode === 'stream') assert.deepEqual(Buffer.concat(delivered), state.prefix);
      await assertReadClosed(state); await current.recovery();
    });
  }
});

test('mapped copying preserves a committed destination prefix and source release failures', { timeout: 30000 }, async t => {
  const current = await fixture(t);
  for (const [label, primary] of [...reasons, ['error', failure('The destination rejected its real write.')]]) await t.test(label, async () => {
    const cleanup = failure('The copied source failed after its actual release.');
    const state = current.select({ kind: 'copy', primary, cleanup });
    const pending = current.files.copyFile('Z:\\disk\\source.bin', 'Z:\\remote\\partial.bin'), result = rejected(pending);
    state.pending = pending;
    await releaseRead(state, pending); assertReasons(await result, [primary, cleanup]);
    assert.deepEqual(await fs.readFile(state.destination), sourceBytes.subarray(0, 65536));
    await assertReadClosed(state); await current.recovery();
  });
});

test('sequential metadata close waits for actual copy cleanup, preserves every failure and removes its real spool', { timeout: 30000 }, async t => {
  const current = await fixture(t);
  for (const [label, primary] of reasons) await t.test(label, async () => {
    const cleanup = failure('The spool reader failed after its actual close.'), removeFailure = { message: 'The spool removal completed before rejection.', name: 'business-name', stack: 'business-stack' };
    const prepared = await current.files.open('Z:\\remote\\metadata.bin', 'w'); await prepared.writeFile(sourceBytes);
    const state = current.select({ kind: 'spool', primary, cleanup, removeFailure });
    const first = prepared.close(), second = prepared.close(), firstResult = rejected(first), secondResult = rejected(second);
    state.pending = first;
    await releaseRead(state, first);
    assertReasons(await firstResult, [primary, cleanup, removeFailure]); assertReasons(await secondResult, [primary, cleanup, removeFailure]);
    assertReasons(await rejected(prepared.close()), [primary, cleanup, removeFailure]);
    assert.deepEqual(await fs.readdir(path.join(current.diskRoot, 'spool')), []);
    assert.deepEqual(await fs.readFile(state.destination), sourceBytes.subarray(0, 65536));
    await assertReadClosed(state); await current.recovery();
  });
  const prepared = await current.files.open('Z:\\remote\\completed.bin', 'wx'); await prepared.writeFile(sourceBytes); await prepared.close();
  assert.deepEqual(await fs.readFile(path.join(current.remoteRoot, 'completed.bin')), sourceBytes);
  assert.deepEqual(await fs.readdir(path.join(current.diskRoot, 'spool')), []);
});
