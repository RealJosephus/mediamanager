import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { StorageRegistry } from '../../src/storage/registry.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';

const observed = promise => promise.then(value => ({ failed: false, value }), error => ({ failed: true, error }));
const source = Buffer.from('Owned Local adapter input.\n');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'mm-registry-failures-'));
  await fs.writeFile(path.join(directory, 'source.bin'), source);
  const registry = new StorageRegistry(), locals = [], releases = [];
  let closeFailureObserved = false, closeFailure;
  t.after(async () => {
    for (const release of releases) release();
    const errors = [], outcome = await observed(registry.close());
    if (outcome.failed && !(closeFailureObserved && Object.is(outcome.error, closeFailure))) errors.push(outcome.error);
    for (const local of locals) try { await local.close(); } catch (error) { errors.push(error); }
    try {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
      assert.ok(path.basename(directory).startsWith('mm-registry-failures-'));
      await fs.rm(directory, { recursive: true });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Storage registry fixture cleanup failed.', { cause: errors[0] });
  });
  const local = async () => {
    const adapter = await LocalAdapter.open({ root: directory });
    const close = adapter.close.bind(adapter);
    const file = await adapter.openFile('/source.bin', 'r'), fd = file.fd;
    assert.equal(fstatSync(fd).size, source.length);
    const owner = { adapter, close, file, fd };
    locals.push(owner);
    return owner;
  };
  const markCloseFailure = error => { closeFailureObserved = true; closeFailure = error; };
  return { directory, registry, local, markCloseFailure, releaseOnCleanup: release => releases.push(release) };
}

async function localBytes(adapter) {
  const reader = await adapter.openRead('/source.bin'), chunks = [];
  try { for await (const chunk of reader.stream) chunks.push(chunk); }
  finally { await reader.close(); }
  return Buffer.concat(chunks);
}

async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await immediate();
  assert.equal(settled, false);
}

test('failed adapter initialization preserves every falsy primary after real Local cleanup and permits the same id to recover', { timeout: 30000 }, async t => {
  for (const [name, reason] of [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]) for (const cleanupFails of [false, true]) {
    await t.test(name + (cleanupFails ? ' with cleanup failure' : ''), async t => {
      const f = await fixture(t), first = await f.local();
      Object.defineProperty(first.adapter, 'health', { get() { throw reason; }, configurable: true });
      const cleanup = { operation: 'local-adapter-cleanup' };
      first.adapter.close = async () => { await first.close(); if (cleanupFails) throw cleanup; };
      let candidate = first.adapter;
      f.registry.registerType('local-fixture', () => candidate);
      const outcome = await observed(f.registry.createInstance('same-id', 'local-fixture', {}));
      assert.equal(outcome.failed, true);
      if (cleanupFails) {
        assert.ok(outcome.error instanceof AggregateError); assert.ok(Object.hasOwn(outcome.error, 'cause'));
        assert.equal(outcome.error.cause, reason); assert.deepEqual(outcome.error.errors, [reason, cleanup]);
      } else assert.equal(outcome.error, reason);
      assert.throws(() => fstatSync(first.fd), { code: 'EBADF' });
      assert.equal(f.registry.hasInstance('same-id'), false);
      assert.throws(() => f.registry.getInstance('same-id'), failure => Object.is(failure, outcome.error));
      candidate = (await f.local()).adapter;
      await f.registry.createInstance('same-id', 'local-fixture', {});
      assert.deepEqual(await localBytes(f.registry.getInstance('same-id')), source);
      await f.registry.close();
    });
  }
});

test('adapter validation and cleanup failures retain their primary cause, public fields and stored unavailable state', { timeout: 30000 }, async t => {
  const f = await fixture(t), first = await f.local();
  const primary = Object.assign(new Error('Controlled adapter validation failure.'), { code: 'invalid-response', status: 502, statusCode: 503 });
  const cleanup = undefined;
  Object.defineProperty(first.adapter, 'health', { get() { throw primary; }, configurable: true });
  first.adapter.close = async () => { await first.close(); throw cleanup; };
  let candidate = first.adapter;
  f.registry.registerType('local-fixture', () => candidate);
  const outcome = await observed(f.registry.createInstance('same-id', 'local-fixture', {}));
  assert.equal(outcome.failed, true); assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.cause, primary); assert.deepEqual(outcome.error.errors, [primary, cleanup]);
  assert.equal(outcome.error.code, primary.code); assert.equal(outcome.error.status, primary.status);
  assert.equal(outcome.error.statusCode, primary.statusCode);
  assert.throws(() => f.registry.getInstance('same-id'), failure => failure === outcome.error);
  assert.throws(() => fstatSync(first.fd), { code: 'EBADF' });
  candidate = (await f.local()).adapter;
  await f.registry.createInstance('same-id', 'local-fixture', {});
  assert.deepEqual(await localBytes(f.registry.getInstance('same-id')), source);
  await f.registry.close();
});

test('a diagnostic getter cannot replace a plain adapter failure when cleanup also fails', { timeout: 30000 }, async t => {
  const f = await fixture(t), first = await f.local();
  const primary = Object.defineProperty({ code: 'controlled', status: 409 }, 'message', {
    get() { throw new Error('A diagnostic getter must not run.'); },
  });
  Object.defineProperty(first.adapter, 'health', { get() { throw primary; }, configurable: true });
  first.adapter.close = async () => { await first.close(); throw false; };
  f.registry.registerType('local-fixture', () => first.adapter);
  const outcome = await observed(f.registry.createInstance('invalid', 'local-fixture', {}));
  assert.equal(outcome.failed, true); assert.equal(outcome.error.cause, primary);
  assert.deepEqual(outcome.error.errors, [primary, false]);
  assert.equal(outcome.error.code, 'controlled'); assert.equal(outcome.error.status, 409);
  assert.throws(() => fstatSync(first.fd), { code: 'EBADF' });
});

test('registry shutdown attempts every adapter after a synchronous throw and waits for actual Local cleanup', { timeout: 30000 }, async t => {
  for (const operation of ['close', 'unregisterType']) for (const multiple of [false, true]) {
    await t.test(operation + (multiple ? ' ordered failures' : ' single failure'), async t => {
      const f = await fixture(t), first = await f.local(), second = await f.local(), third = await f.local();
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), healthyClosed = Promise.withResolvers();
      const attempted = [], primary = false, secondary = undefined;
      first.adapter.close = () => { attempted.push('first'); throw primary; };
      second.adapter.close = async () => { attempted.push('second'); await second.close(); healthyClosed.resolve(); };
      third.adapter.close = async () => {
        attempted.push('third'); entered.resolve(); await release.promise; await third.close();
        if (multiple) throw secondary;
      };
      const candidates = [first.adapter, second.adapter, third.adapter];
      f.registry.registerType('local-fixture', config => candidates[config.index]);
      for (let index = 0; index < candidates.length; index++) await f.registry.createInstance('local-' + index, 'local-fixture', { index });
      f.releaseOnCleanup(() => release.resolve());
      const closing = f.registry[operation]('local-fixture'), outcome = observed(closing);
      const closingAgain = operation === 'close' ? f.registry.close() : undefined;
      const repeatedOutcome = closingAgain && observed(closingAgain);
      try {
        await entered.promise; await healthyClosed.promise; await remainsPending(closing);
        if (closingAgain) await remainsPending(closingAgain);
        assert.deepEqual(attempted, ['first', 'second', 'third']);
        assert.throws(() => fstatSync(second.fd), { code: 'EBADF' });
        assert.equal(fstatSync(third.fd).size, source.length);
      } finally { release.resolve(); }
      const failure = await outcome;
      assert.equal(failure.failed, true);
      if (multiple) {
        assert.ok(failure.error instanceof AggregateError); assert.ok(Object.hasOwn(failure.error, 'cause'));
        assert.equal(failure.error.cause, primary); assert.deepEqual(failure.error.errors, [primary, secondary]);
      } else assert.equal(failure.error, primary);
      if (repeatedOutcome) {
        const repeated = await repeatedOutcome;
        assert.equal(repeated.failed, true); assert.equal(repeated.error, failure.error);
      }
      if (operation === 'close') f.markCloseFailure(failure.error);
      assert.throws(() => fstatSync(third.fd), { code: 'EBADF' });
      assert.equal(f.registry.hasInstance('local-1'), false);
      // The throwing third-party close failed before releasing its own file.
      // Recover that owner explicitly; the healthy closures above were real.
      await first.close(); assert.throws(() => fstatSync(first.fd), { code: 'EBADF' });
      if (operation === 'unregisterType') {
        const fresh = await f.local();
        f.registry.registerType('local-fixture', () => fresh.adapter);
        await f.registry.createInstance('local-1', 'local-fixture', {});
        assert.deepEqual(await localBytes(f.registry.getInstance('local-1')), source);
        await f.registry.close();
      }
    });
  }
});

test('registry shutdown waits for a pending factory and its failed real Local cleanup without redelivering the business failure', { timeout: 30000 }, async t => {
  for (const operation of ['close', 'unregisterType']) await t.test(operation, async t => {
    const f = await fixture(t), candidate = await f.local();
    const factoryEntered = Promise.withResolvers(), factoryRelease = Promise.withResolvers();
    const cleanupEntered = Promise.withResolvers(), cleanupRelease = Promise.withResolvers();
    candidate.adapter.close = async () => { cleanupEntered.resolve(); await cleanupRelease.promise; await candidate.close(); throw null; };
    f.registry.registerType('pending', async () => { factoryEntered.resolve(); await factoryRelease.promise; return candidate.adapter; });
    f.releaseOnCleanup(() => { factoryRelease.resolve(); cleanupRelease.resolve(); });
    const creating = observed(f.registry.createInstance('pending-id', 'pending', {}));
    await factoryEntered.promise;
    const closing = f.registry[operation]('pending');
    try {
      await remainsPending(closing); factoryRelease.resolve(); await cleanupEntered.promise;
      await remainsPending(closing); await remainsPending(creating);
      assert.equal(fstatSync(candidate.fd).size, source.length);
    } finally { factoryRelease.resolve(); cleanupRelease.resolve(); }
    const creation = await creating;
    assert.equal(creation.failed, true); assert.ok(creation.error instanceof AggregateError);
    assert.equal(creation.error.cause.code, operation === 'close' ? 'closed' : 'not-supported');
    assert.equal(creation.error.errors[0], creation.error.cause); assert.equal(creation.error.errors[1], null);
    await closing;
    assert.throws(() => fstatSync(candidate.fd), { code: 'EBADF' });
    assert.equal(f.registry.hasInstance('pending-id'), false);
    if (operation === 'unregisterType') {
      const recovered = await f.local();
      f.registry.registerType('pending', () => recovered.adapter);
      await f.registry.createInstance('pending-id', 'pending', {});
      assert.deepEqual(await localBytes(f.registry.getInstance('pending-id')), source);
      await f.registry.close();
    }
  });
});
