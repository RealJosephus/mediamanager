import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageError } from '../../src/storage/errors.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const original = Buffer.from('The complete target before this upload.\n');
const bytes = Buffer.alloc(131079, 0x65), prefix = bytes.subarray(0, 65536);
const properties = ['code', 'message', 'status', 'statusCode', 'errors'];
const primitives = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const fallbackMessage = 'The local storage operation failed.';
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
function reason(property, storage = false) {
  const value = Object.assign(storage ? new StorageError('rate-limited', 'The source rejected its completed operation.', { retryAfter: 1 })
    : Object.assign(new Error('The source rejected its completed operation.'), { code: 'EACCES' }),
  { status: 409, statusCode: 503, errors: [false, 0, '', null, undefined] });
  // Materialize the native stack before installing hostile diagnostic fields.
  void value.stack;
  if (property) Object.defineProperty(value, property, { get() { throw new Error(`The ${property} diagnostic getter must not escape.`); } });
  return Object.freeze(value);
}
const ownValue = (value, key) => value == null ? undefined : Object.getOwnPropertyDescriptor(Object(value), key)?.value;
function observation(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(observation);
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) =>
    [key, Object.hasOwn(descriptor, 'value') ? observation(descriptor.value) : { accessor: true }]));
}
async function deadline(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The real Local source did not reach its ownership boundary.')), 15000);
  })]); } finally { clearTimeout(timer); }
}
async function pending(operation) {
  let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The source still owns an actual file descriptor.');
}

async function fixture(t, label, atomic) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-diagnostic-ownership-')), work = path.join(root, 'files');
  const destination = path.join(work, 'destination'), target = path.join(destination, 'target.bin'), sourcePath = path.join(work, 'source.bin');
  await fs.mkdir(destination, { recursive: true }); await fs.writeFile(sourcePath, bytes); await fs.writeFile(target, original);
  const adapters = [], operations = [], sources = [];
  const report = { label, atomic, observations: {}, uncaught: [], cleanupErrors: [] };
  const uncaught = (error, origin) => report.uncaught.push({ origin, error: observation(error) });
  process.on('uncaughtExceptionMonitor', uncaught);
  const open = async () => {
    const adapter = await LocalAdapter.open({ root: destination, writable: true }); adapters.push(adapter); return adapter;
  };
  t.after(async () => {
    for (const source of sources) { source.advance.resolve(); source.releaseReturn.resolve(); }
    await Promise.allSettled(operations);
    for (const source of sources) await Promise.allSettled([source.nextOperation, source.returning]);
    for (const release of [...adapters.map(value => () => value.close()),
      ...sources.flatMap(source => [() => source.file.close(), () => source.nextFile?.close()])]) {
      try { await release(); } catch (error) { report.cleanupErrors.push(observation(error)); }
    }
    process.off('uncaughtExceptionMonitor', uncaught);
    report.descriptors = sources.map(source => ({ original: source.file.fd, inFlight: source.nextFile?.fd }));
    await fs.writeFile(path.join(root, 'observations.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
    assert.deepEqual(report.cleanupErrors, []); assert.deepEqual(report.uncaught, []);
    assert.ok(sources.every(source => source.file.fd === -1 && (!source.nextFile || source.nextFile.fd === -1)));
  });
  const adapter = await open();
  return { adapter, report, track(operation) { operations.push(operation); return operation; },
    async source({ primaryFailed = false, primary, cleanupFailed = false, cleanup, lateReject = false, returnChunk = false } = {}) {
      const file = await fs.open(sourcePath, 'r');
      const state = { file, calls: 0, returns: 0, nextRead: false, advance: Promise.withResolvers(),
        nextEntered: Promise.withResolvers(), returnEntered: Promise.withResolvers(), returned: Promise.withResolvers(), releaseReturn: Promise.withResolvers() };
      sources.push(state);
      const source = { [Symbol.asyncIterator]() { return this; },
        next() {
          const operation = (async () => {
            if (++state.calls === 1) {
              const chunk = Buffer.alloc(prefix.length), read = await file.read(chunk, 0, chunk.length, 0);
              assert.equal(read.bytesRead, prefix.length); assert.deepEqual(chunk, prefix); return { done: false, value: chunk };
            }
            assert.equal(state.calls, 2);
            state.nextFile = await fs.open(sourcePath, 'r'); state.nextEntered.resolve();
            try {
              await state.advance.promise;
              const chunk = Buffer.alloc(prefix.length), read = await state.nextFile.read(chunk, 0, chunk.length, prefix.length);
              assert.equal(read.bytesRead, prefix.length); assert.deepEqual(chunk, prefix); state.nextRead = true;
              if (lateReject) { state.nextRejected = true; throw false; }
              if (primaryFailed) throw primary;
              state.nextYielded = returnChunk;
              return returnChunk ? { done: false, value: chunk } : { done: true };
            } finally { await state.nextFile.close(); }
          })();
          state.nextOperation = operation; return operation;
        },
        return() {
          state.returns++;
          return state.returning ??= (async () => {
            state.returnEntered.resolve(); await state.releaseReturn.promise;
            await file.close(); state.returned.resolve();
            if (cleanupFailed) throw cleanup;
            return { done: true };
          })();
        },
      };
      return Object.assign(state, { source });
    },
    async prefix() {
      const current = await fs.readFile(target), names = (await fs.readdir(destination)).sort();
      assert.deepEqual(current, atomic ? original : prefix);
      if (atomic) {
        const staged = names.filter(name => name !== 'target.bin'); assert.equal(staged.length, 1);
        assert.match(staged[0], /^\.storage-[a-f0-9-]+\.tmp$/u);
        assert.deepEqual(await fs.readFile(path.join(destination, staged[0])), prefix);
      } else assert.deepEqual(names, ['target.bin']);
      report.observations.prefix = { target: current.toString('base64'), names };
    },
    async released(state) {
      assert.equal(state.file.fd, -1); assert.equal(state.nextFile.fd, -1);
      assert.equal(state.nextRead, true); assert.equal(state.calls, 2); assert.equal(state.returns, 1);
      assert.deepEqual(await fs.readFile(target), atomic ? original : prefix);
      assert.deepEqual(await fs.readdir(destination), ['target.bin']);
      assert.deepEqual(await fs.readFile(sourcePath), bytes);
      report.observations.released = { originalFd: state.file.fd, inFlightFd: state.nextFile.fd,
        calls: state.calls, returns: state.returns, nextRead: state.nextRead, nextRejected: state.nextRejected === true,
        nextYielded: state.nextYielded === true };
    },
    async recover() {
      const recovered = await open();
      const result = await recovered.write('/target.bin', bytes, { atomic, size: bytes.length });
      assert.equal(result.size, BigInt(bytes.length)); assert.equal(result.atomic, atomic);
      const reader = await recovered.openRead('/target.bin'), chunks = [];
      try { for await (const chunk of reader.stream) chunks.push(Buffer.from(chunk)); }
      finally { await reader.close(); }
      assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(await fs.readdir(destination), ['target.bin']);
      report.observations.recovered = true;
    },
  };
}

function mapped(actual, primary, cleanup, combined) {
  assert.ok(actual instanceof StorageError);
  const storage = primary instanceof StorageError, nativeCode = ownValue(primary, 'code');
  assert.equal(actual.code, storage ? nativeCode ?? 'unavailable' : nativeCode === 'EACCES' ? 'permission-denied' : 'unavailable');
  assert.equal(actual.message, ownValue(primary, 'message') ?? fallbackMessage);
  if (storage) assert.deepEqual(actual.details, ownValue(primary, 'details'));
  else assert.deepEqual(actual.details, { nativeCode });
  for (const key of ['status', 'statusCode']) assert.equal(actual[key], ownValue(primary, key));
  if (combined) {
    assert.deepEqual(actual.errors, [primary, cleanup]); assert.ok(actual.cause instanceof AggregateError);
    assert.deepEqual(actual.cause.errors, [primary, cleanup]); assert.equal(actual.cause.cause, primary);
  } else {
    assert.equal(actual.cause, primary); assert.equal(actual.errors, ownValue(primary, 'errors'));
  }
}

test('Local diagnostics preserve real source and close failures, committed file prefixes and safe public error mapping', { timeout: 120000 }, async t => {
  const definitions = [
    ...properties.flatMap(property => [
      { label: 'source-single-' + property, primary: reason(property) },
      { label: 'source-cleanup-' + property, primary: reason(property), combined: true, cleanup: false },
      { label: 'storage-cleanup-' + property, primary: reason(property, true), combined: true, cleanup: 0 },
    ]),
    ...primitives.map(([label, primary]) => ({ label: label + '-cleanup-getter', primary, combined: true, cleanup: reason('errors') })),
    ...['code', 'errors'].map(property => ({ label: 'return-single-' + property, primary: reason(property), fromReturn: true })),
    { label: 'native-public-fields', primary: reason() },
    { label: 'storage-public-fields', primary: reason(undefined, true), combined: true, cleanup: false },
  ];
  for (const atomic of [false, true]) for (const definition of definitions) await t.test((atomic ? 'atomic/' : 'direct/') + definition.label, async t => {
    const f = await fixture(t, definition.label, atomic);
    const state = await f.source({ primaryFailed: !definition.fromReturn, primary: definition.primary,
      cleanupFailed: definition.fromReturn || definition.combined, cleanup: definition.fromReturn ? definition.primary : definition.cleanup });
    const writing = f.track(outcome(f.adapter.write('/target.bin', state.source, { atomic })));
    await deadline(state.nextEntered.promise); await f.prefix(); state.advance.resolve();
    await deadline(state.returnEntered.promise); await pending(writing);
    assert.equal(state.nextFile.fd, -1); assert.ok(state.file.fd >= 0);
    const closing = f.track(f.adapter.close()), closingAgain = f.track(f.adapter.close());
    await pending(closing); await pending(closingAgain); state.releaseReturn.resolve();
    const result = await writing; await closing; await closingAgain;
    assert.ok(Object.hasOwn(result, 'error')); mapped(result.error, definition.primary, definition.cleanup, definition.combined);
    await f.released(state); await f.recover(); await immediate();
    assert.deepEqual(f.report.uncaught, []);
    f.report.observations.failure = observation(result.error);
  });
});

test('Local caller cancellation cannot escape through frozen diagnostic getters or abandon an in-flight source descriptor', { timeout: 90000 }, async t => {
  for (const atomic of [false, true]) for (const property of [undefined, 'status', 'statusCode', 'errors']) {
    for (const lateReject of [false, true]) await t.test((atomic ? 'atomic/' : 'direct/') + (property ?? 'public') + '/' + lateReject, async t => {
      const f = await fixture(t, 'cancel-' + (property ?? 'public') + '-' + lateReject, atomic), requested = reason(property);
      const state = await f.source({ cleanupFailed: true, cleanup: false, lateReject, returnChunk: true }), controller = new AbortController();
      const writing = f.track(outcome(f.adapter.write('/target.bin', state.source, { atomic, signal: controller.signal })));
      await deadline(state.nextEntered.promise); await f.prefix();
      controller.abort(requested);
      await deadline(state.returnEntered.promise);
      const closing = f.track(f.adapter.close()), closingAgain = f.track(f.adapter.close());
      await pending(writing); await pending(closing); await pending(closingAgain);
      state.releaseReturn.resolve(); await deadline(state.returned.promise);
      assert.equal(state.file.fd, -1); assert.ok(state.nextFile.fd >= 0); assert.equal(state.nextRead, false);
      await pending(writing); await pending(closing); await pending(closingAgain);
      state.advance.resolve(); const result = await writing; await closing; await closingAgain;
      assert.ok(Object.hasOwn(result, 'error')); assert.equal(result.error.code, 'cancelled');
      const cancellation = result.error.errors[0];
      assert.equal(cancellation.code, 'cancelled'); assert.equal(cancellation.cause, controller.signal.reason);
      assert.equal(cancellation.cause, requested); assert.equal(cancellation.errors, ownValue(requested, 'errors'));
      assert.deepEqual(result.error.errors, [cancellation, false]);
      assert.deepEqual(result.error.cause.errors, [cancellation, false]); assert.equal(result.error.cause.cause, cancellation);
      for (const key of ['status', 'statusCode']) {
        assert.equal(cancellation[key], ownValue(requested, key)); assert.equal(result.error[key], ownValue(requested, key));
      }
      assert.equal(state.nextRejected === true, lateReject); assert.equal(state.nextYielded === true, !lateReject);
      await f.released(state); await f.recover(); await immediate(); assert.deepEqual(f.report.uncaught, []);
      f.report.observations.failure = observation(result.error);
      f.report.observations.cancelledWithExactFrozenReason = true;
    });
  }
});
