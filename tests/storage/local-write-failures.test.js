import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, StorageError } from '../../src/storage/index.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const original = Buffer.from('Original complete target.\n');
const sourceBytes = Buffer.alloc(196731, 0x6d), prefix = sourceBytes.subarray(0, 65536);
const primitives = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined]];
const structured = message => Object.assign(new Error(message, { cause: { name: 'business-name', stack: 'business-stack', value: false } }),
  { code: 'CONTROLLED_UPLOAD', status: 503, statusCode: 509, errors: [false, 0, '', null, undefined] });
const reasons = [...primitives, ['structured', structured('The source failed after reading real bytes.')],
  ['native-code', Object.assign(new Error('The source denied its next read.'), { code: 'EACCES', status: 403 })],
  ['business', { code: 'constructor', message: 'The source rejected the upload.', status: 507, statusCode: 508,
    name: 'business-name', stack: 'business-stack', errors: [false, null] }],
  ['storage', Object.assign(new StorageError('rate-limited', 'The source throttled its next read.', { retryAfter: 1 }),
    { status: 429, cause: { name: 'business-name', stack: 'business-stack' }, errors: [0, false] })]];
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  return Object.fromEntries((value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value))
    .map(key => [key, functional(value[key])]));
};
const outcome = pending => Promise.resolve(pending).then(value => ({ failed: false, value }), error => ({ failed: true, error }));
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
function wrapped(actual, reason) {
  if (reason instanceof StorageError) { sameReason(actual, reason); return; }
  assert.equal(actual.code, reason?.code === 'EACCES' ? 'permission-denied' : 'unavailable');
  assert.equal(actual.details.nativeCode, reason?.code);
  assert.ok(Object.hasOwn(actual, 'cause')); sameReason(actual.cause, reason);
  if (reason?.message !== undefined) assert.equal(actual.message, reason.message);
  for (const key of ['status', 'statusCode', 'errors']) if (reason != null && Object.hasOwn(reason, key)) sameReason(actual[key], reason[key]);
}
function combined(actual, first, cleanup) {
  assert.equal(actual.code, first instanceof StorageError ? first.code : first?.code === 'EACCES' ? 'permission-denied' : 'unavailable');
  sameReason(actual.errors, [first, cleanup]); sameReason(actual.cause.errors, [first, cleanup]);
  assert.ok(Object.hasOwn(actual.cause, 'cause')); sameReason(actual.cause.cause, first);
  if (first instanceof StorageError) sameReason(actual.details, first.details);
  else assert.equal(actual.details.nativeCode, first?.code);
  if (first?.message !== undefined) assert.equal(actual.message, first.message);
  for (const key of ['status', 'statusCode']) assert.equal(actual[key], first?.[key]);
}
async function remainsPending(pending, message) {
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, message);
}
const describe = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(t, atomic) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-write-failures-'));
  const files = path.join(root, 'files'), destination = path.join(files, 'destination'), evidence = path.join(root, 'evidence');
  await fs.mkdir(files); await fs.mkdir(destination); await fs.mkdir(evidence);
  const source = path.join(files, 'source.bin'), target = path.join(destination, 'target.bin');
  await fs.writeFile(source, sourceBytes); await fs.writeFile(target, original);
  const report = { scope: 'Actual Local/VFS streamed upload, real source file descriptor, destination prefix and atomic publication boundary.',
    atomic, assertions: {}, observations: {}, cleanup: {}, phaseAcceptance: false, releaseAcceptance: false };
  const sources = [], operations = [], registries = [];
  const open = async () => {
    const adapter = await LocalAdapter.open({ root: destination, writable: true });
    const registry = new StorageRegistry(); registry.registerType('local', () => adapter);
    await registry.createInstance('local', 'local', {}); registries.push(registry);
    const vfs = new VirtualFileSystem(registry);
    vfs.mount({ path: '/files', instanceId: 'local', capabilities: { create: true, replace: true, mkdir: true,
      delete: true, rename: true, atomicReplace: true } });
    return { adapter, vfs };
  };
  const current = await open();
  t.after(async () => {
    const failures = [];
    for (const state of sources) { state.advance.resolve(); state.release.resolve(); }
    await Promise.allSettled(operations);
    // Fixture disposal is separate from the assertions made before it.
    await Promise.allSettled(sources.map(state => state.returning));
    for (const registry of registries) try { await registry.close(); } catch (error) { failures.push(error); }
    for (const state of sources) try { await state.file.close(); } catch (error) { failures.push(error); }
    try {
      assert.equal(path.dirname(files), root); assert.equal(path.dirname(root), output);
      await fs.rm(files, { recursive: true, force: false }); report.cleanup.filesRemoved = true;
    } catch (error) { failures.push(error); }
    report.cleanup.errors = failures.map(error => errorObservation(error));
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'Local upload fixture cleanup failed.', { cause: failures[0] });
  });
  return { ...current, report,
    async source({ primaryFailed = false, primary, cleanupFailed = false, cleanup, waitForNext = false } = {}) {
      const file = await fs.open(source, 'r');
      const state = { file, advance: Promise.withResolvers(), release: Promise.withResolvers(),
        nextEntered: Promise.withResolvers(), returnEntered: Promise.withResolvers(), returning: undefined };
      if (!waitForNext) state.advance.resolve();
      let sent = false;
      const pending = new Set();
      const iterator = {
        next() {
          const reading = (async () => {
            if (!sent) {
              sent = true;
              const bytes = Buffer.alloc(prefix.length);
              for (let offset = 0; offset < bytes.length;) {
                const read = await file.read(bytes, offset, bytes.length - offset, offset);
                assert.ok(read.bytesRead > 0); offset += read.bytesRead;
              }
              return { done: false, value: bytes };
            }
            state.nextEntered.resolve(); await state.advance.promise;
            if (primaryFailed) throw primary;
            return { done: true };
          })();
          pending.add(reading);
          reading.then(() => pending.delete(reading), () => pending.delete(reading));
          return reading;
        },
        return() {
          if (!state.returning) state.returning = (async () => {
            state.returnEntered.resolve(); await state.release.promise;
            await Promise.allSettled([...pending]); await file.close();
            if (cleanupFailed) throw cleanup;
            return { done: true };
          })();
          return state.returning;
        },
      };
      sources.push(state);
      return Object.assign(state, { data: { [Symbol.asyncIterator]: () => iterator } });
    },
    writing(state, options = {}) {
      const operation = current.vfs.write('/files/target.bin', state.data, { atomic, overwrite: true, ...options });
      operations.push(operation); return operation;
    },
    async inFlight(state, writing) {
      await state.returnEntered.promise;
      await remainsPending(writing, 'Upload remains owned until actual source return and file close finish.');
      assert.equal((await state.file.stat()).size, sourceBytes.length);
      const bytes = await fs.readFile(target), names = await fs.readdir(destination);
      await fs.writeFile(path.join(evidence, 'target-during-return.bin'), bytes);
      report.observations.targetDuringReturn = describe(bytes);
      if (atomic) {
        assert.deepEqual(bytes, original);
        const staged = await Promise.all(names.filter(name => name !== 'target.bin').map(async name => {
          const bytes = await fs.readFile(path.join(destination, name));
          await fs.writeFile(path.join(evidence, 'staged-' + name + '.bin'), bytes);
          return { path: name, ...describe(bytes) };
        }));
        assert.ok(staged.some(value => value.bytes === prefix.length && value.sha256 === describe(prefix).sha256),
          'The actual uncommitted atomic file contains the bytes already consumed from its real source.');
        report.observations.stagedDuringReturn = staged;
      } else assert.deepEqual(bytes, prefix);
      report.assertions.writerRetainedUntilSourceReturn = true;
      report.assertions.sourceFileOpenDuringReturn = true;
    },
    async afterFailure(state, error) {
      await assert.rejects(state.file.stat(), { code: 'EBADF' });
      const bytes = await fs.readFile(target);
      assert.deepEqual(bytes, atomic ? original : prefix);
      assert.deepEqual(await fs.readdir(destination), ['target.bin']);
      await fs.writeFile(path.join(evidence, 'target-after-failure.bin'), bytes);
      report.observations.targetAfterFailure = describe(bytes); report.observations.error = errorObservation(error);
      report.assertions.sourceFileClosedAfterWrite = true; report.assertions.destinationRetainedOnlyCommittedTarget = true;
      if (atomic) report.assertions.atomicStagingRemoved = true;
    },
    async recovery(reopen = false) {
      const owner = reopen ? await open() : current;
      const result = await owner.vfs.write('/files/target.bin', sourceBytes, { atomic, overwrite: true, size: sourceBytes.length });
      assert.equal(result.size, BigInt(sourceBytes.length)); assert.equal(result.atomic, atomic);
      const handle = await owner.vfs.openRead('/files/target.bin');
      try {
        const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), sourceBytes);
      } finally { await handle.close(); }
      assert.deepEqual(await fs.readdir(destination), ['target.bin']);
      report.assertions.recoveredCompleteWriteAndRead = true;
    },
  };
}

test('Local streamed failures retain primitive and business reasons, committed prefixes and ordered source cleanup failures', { timeout: 60000 }, async t => {
  for (const atomic of [false, true]) for (const [label, primary] of reasons) for (const cleanupFailed of [false, true]) {
    await t.test((atomic ? 'atomic/' : 'direct/') + label + '/' + cleanupFailed, async t => {
      const current = await fixture(t, atomic), cleanup = structured('Source return rejected after closing its real file.');
      const state = await current.source({ primaryFailed: true, primary, cleanupFailed, cleanup });
      const writing = current.writing(state), result = outcome(writing);
      await current.inFlight(state, writing); state.release.resolve();
      const { failed, error } = await result; assert.equal(failed, true);
      if (cleanupFailed) combined(error, primary, cleanup); else wrapped(error, primary);
      current.report.observations.primaryType = typeof primary; current.report.observations.primary = errorObservation(primary);
      current.report.observations.cleanupFailed = cleanupFailed;
      await current.afterFailure(state, error); await current.recovery();
    });
  }
});

test('Local EOF cannot publish an atomic target or settle before actual source return failures', { timeout: 60000 }, async t => {
  for (const atomic of [false, true]) for (const [label, cleanup] of [...primitives, ['structured', structured('EOF cleanup rejected after closing its real file.')]]) {
    await t.test((atomic ? 'atomic/' : 'direct/') + label, async t => {
      const current = await fixture(t, atomic), state = await current.source({ cleanupFailed: true, cleanup });
      const writing = current.writing(state, { size: prefix.length }), result = outcome(writing);
      await current.inFlight(state, writing); state.release.resolve();
      const { failed, error } = await result; assert.equal(failed, true); wrapped(error, cleanup);
      current.report.observations.cleanupType = typeof cleanup;
      await current.afterFailure(state, error); await current.recovery();
    });
  }
});

test('Local oversize, short upload, cancellation and adapter close drain delayed source return before closing the owner', { timeout: 60000 }, async t => {
  for (const atomic of [false, true]) for (const trigger of ['oversize', 'short', 'cancel', 'close']) await t.test((atomic ? 'atomic/' : 'direct/') + trigger, async t => {
    const current = await fixture(t, atomic), controller = new AbortController(), reason = structured('The caller cancelled its real upload.');
    const cleanup = { message: 'The source closed before rejecting return.', name: 'business-name', stack: 'business-stack', status: 508, errors: [false, undefined] };
    const state = await current.source({ waitForNext: trigger === 'cancel' || trigger === 'close', cleanupFailed: true, cleanup });
    const writing = current.writing(state, { signal: controller.signal, size: trigger === 'oversize' ? prefix.length - 1 : prefix.length + 1 });
    const result = outcome(writing); let closing;
    if (trigger === 'cancel' || trigger === 'close') {
      await state.nextEntered.promise;
      if (trigger === 'cancel') controller.abort(reason); else closing = current.adapter.close();
    }
    await current.inFlight(state, writing);
    closing ??= current.adapter.close(); const closingAgain = current.adapter.close();
    await remainsPending(closing, 'Local close waits for the actually admitted source cleanup.');
    await remainsPending(closingAgain, 'A repeated close retains the same real unfinished shutdown.');
    await assert.rejects(current.vfs.write('/files/late.bin', Buffer.from('late')), { code: 'closed' });
    state.advance.resolve(); state.release.resolve();
    const { failed, error } = await result; assert.equal(failed, true);
    const primary = error.errors[0]; assert.equal(primary.code, trigger === 'oversize' || trigger === 'short' ? 'invalid-response' : 'cancelled');
    if (trigger === 'cancel') sameReason(primary.cause, controller.signal.reason);
    combined(error, primary, cleanup);
    await closing; await closingAgain;
    current.report.assertions.closeRetainedUntilSourceReturn = true;
    current.report.observations.trigger = trigger;
    await current.afterFailure(state, error); await current.recovery(true);
  });
});

test('Local successful EOF waits for its real source return before normal publication and remains usable', { timeout: 30000 }, async t => {
  for (const atomic of [false, true]) await t.test(atomic ? 'atomic' : 'direct', async t => {
    const current = await fixture(t, atomic), state = await current.source();
    const writing = current.writing(state, { size: prefix.length });
    await current.inFlight(state, writing); state.release.resolve();
    const result = await writing; assert.equal(result.size, BigInt(prefix.length)); assert.equal(result.atomic, atomic);
    await assert.rejects(state.file.stat(), { code: 'EBADF' });
    current.report.assertions.successfulSourceFileClosed = true;
    await current.recovery(); await current.adapter.close();
    await assert.rejects(current.vfs.write('/files/late.bin', Buffer.from('late')), { code: 'closed' });
  });
});
