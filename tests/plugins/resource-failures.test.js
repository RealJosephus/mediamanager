import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { inspect, isDeepStrictEqual } from 'node:util';
import { PluginHost } from '../../src/plugins/host.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const originalBytes = Buffer.from('Controlled plugin resource bytes.\n');
const appliedBytes = Buffer.from('Applied metadata.\n');
const source = { mode: 'native', mediaSource: { Id: 'resource-source', Path: 'http://127.0.0.1:12345/original', Protocol: 'Http' } };
const primitiveReasons = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined]];
const failure = label => Object.assign(new Error(label, { cause: { name: 'business-name', stack: 'business-stack', value: label } }),
  { code: 'controlled-resource', status: 509, statusCode: 508 });
const functionalFailure = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functionalFailure);
  const keys = value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functionalFailure(value[key])]));
};
const rejected = async pending => {
  const result = await Promise.resolve(pending).then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
  assert.equal(result.failed, true, 'The operation must reject rather than return an empty or successful result.');
  return result.reason;
};
function assertFailure(actual, expected) {
  assert.deepEqual(functionalFailure(actual), functionalFailure(expected));
}
function assertFailures(actual, expected) {
  assert.equal(Object.hasOwn(actual, 'cause'), true);
  assertFailure(actual.cause, expected[0]);
  assert.deepEqual(actual.errors.map(functionalFailure), expected.map(functionalFailure));
  if (expected[0]?.message !== undefined) assert.equal(actual.message, expected[0].message);
  for (const key of ['code', 'status', 'statusCode']) assert.equal(actual[key], expected[0]?.[key]);
}

const pluginSource = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';

export async function activate(context) {
  const bytes = Buffer.from('Controlled plugin resource bytes.\n');
  const applied = Buffer.from('Applied metadata.\n');
  async function openFile(current, phase) {
    const filename = path.join(context.dataPath, current.id + '-' + phase + '.bin');
    const handle = await fs.open(filename, 'wx+');
    await handle.writeFile(bytes);
    current.files.push({ filename, handle });
    let position = 0;
    return {
      handle,
      async read() {
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        return buffer.subarray(0, bytesRead);
      },
      async close() {
        current.entered[phase].resolve();
        await current.release.promise;
        await handle.close();
        if (current.cleanup[phase].failed) throw current.cleanup[phase].reason;
      },
    };
  }
  function iterator(current, opened) {
    const value = {
      async next() {
        const bytes = await (await opened).read();
        current.read.resolve(bytes);
        await current.advance.promise;
        if (current.primaryFailed) throw current.primary;
        return bytes.length ? { done: false, value: bytes } : { done: true };
      },
      async return(value) { await (await opened).close(); return { done: true, value }; },
    };
    if (current.hasThrow) value.throw = async cause => {
      current.read.resolve(await (await opened).read());
      await current.advance.promise;
      throw cause;
    };
    return value;
  }
  await context.register('similar', {
    name: 'Controlled resource references', itemTypes: ['Movie'],
    getReferences() {
      const current = context.options.current;
      const opened = openFile(current, 'iterator');
      return { [Symbol.asyncIterator]: () => iterator(current, opened) };
    },
  });
  await context.register('metadata', { id: context.id, name: 'Controlled resource saver', providers: [{
    id: 'resource-saver', name: 'Controlled resource saver', kind: 'saver', itemTypes: ['Movie'],
    async prepareSave() {
      const current = context.options.current, file = await openFile(current, 'prepared');
      return {
        async apply() {
          current.read.resolve(await file.read());
          await current.advance.promise;
          await file.handle.write(applied, 0, applied.length, bytes.length);
          if (current.primaryFailed) throw current.primary;
          return { applied: true, name: 'business-result', stack: 'business-result-stack' };
        },
        close: () => file.close(),
      };
    },
  }] });
  await context.register('tuner', {
    type: 'controlled-resource-tuner', name: 'Controlled original input',
    getChannels() { return []; }, discoverDevices() { return []; },
    getChannelStreamMediaSources() { return []; },
    async getChannelStream(_channel, _stream, _current, { source }) {
      const current = context.options.current;
      const [body, lease] = await Promise.all([openFile(current, 'body'), openFile(current, 'lease')]);
      return {
        ...source, ...(current.invalidSource ? { profile: 'heavy' } : {}), tunerHostId: 'controlled-host',
        stream: { [Symbol.asyncIterator]: () => iterator(current, Promise.resolve(body)) },
        close: () => lease.close(),
      };
    },
  });
}
`;

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'plugin-resource-failures-'));
  const directory = path.join(root, 'source'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@test/resource-failures', version: '0.1.0', type: 'module',
    mediamanager: { id: 'resource-failures', name: 'Controlled resource failures', entry: 'index.js' } }));
  await fs.writeFile(path.join(directory, 'index.js'), pluginSource);
  const options = {}, states = [], expectedHostFailures = [];
  const host = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false,
    options: { 'resource-failures': options }, onError: cause => t.diagnostic('plugin diagnostic ' + inspect(cause, { depth: null })) });
  t.after(async () => {
    for (const state of states) { state.advance.resolve(); state.release.resolve(); }
    try {
      const result = await host.close().then(() => ({ failed: false }), reason => ({ failed: true, reason }));
      if (!expectedHostFailures.length) {
        if (result.failed) throw result.reason;
      } else {
        assert.equal(result.failed, true, 'A live source cleanup failure remains visible when its plugin owner closes.');
        const leaves = value => value instanceof AggregateError ? value.errors.flatMap(leaves) : [value];
        for (const cause of leaves(result.reason)) assert.ok(expectedHostFailures.some(expected =>
          isDeepStrictEqual(functionalFailure(cause), functionalFailure(expected))), inspect(cause, { depth: null }));
        t.diagnostic('plugin owner cleanup ' + inspect(result.reason, { depth: null }));
      }
      for (const state of states) await verifyFilesClosed(state);
    } finally {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('plugin-resource-failures-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await host.install(directory);
  return {
    host, expectedHostFailures,
    state(values = {}) {
      const state = { id: randomUUID(), files: [], read: Promise.withResolvers(), advance: Promise.withResolvers(), release: Promise.withResolvers(),
        entered: Object.fromEntries(['iterator', 'prepared', 'body', 'lease'].map(name => [name, Promise.withResolvers()])),
        cleanup: Object.fromEntries(['iterator', 'prepared', 'body', 'lease'].map(name => [name, { failed: false }])), ...values };
      states.push(state); options.current = state; return state;
    },
    references() { return host.entries('similar')[0].getReferences({}, {}); },
    prepare() { return host.entries('metadata')[0].providers[0].prepareSave({ Type: 'Movie' }, {}); },
    open() { return host.entries('tuner')[0].getChannelStream('channel', null, [], { source }); },
  };
}

async function verifyFilesClosed(state) {
  for (const { handle } of state.files) await assert.rejects(handle.stat(), { code: 'EBADF' });
}
async function waitForCleanup(state, phases, pending) {
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.all(phases.map(phase => state.entered[phase].promise));
  await immediate(); assert.equal(settled, false, 'The operation waits for its actual file cleanup.');
  state.release.resolve();
}

test('loaded plugin iterators preserve caller failures and ordered cleanup failures after real file access', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const method of ['next', 'throw', 'missing-throw']) {
    for (const [kind, primary] of [...primitiveReasons, ['error', failure('The iterator failed after reading its source.')]]) await t.test(method + '/' + kind, async () => {
      const cleanup = failure('The iterator cleanup failed after closing its source.');
      const state = current.state({ primaryFailed: true, primary, hasThrow: method === 'throw' });
      state.cleanup.iterator = { failed: true, reason: cleanup };
      const iterator = current.references(), pending = method === 'next' ? iterator.next() : iterator.throw(primary);
      const result = rejected(pending);
      if (method !== 'missing-throw') assert.deepEqual(await state.read.promise, originalBytes);
      state.advance.resolve(); await waitForCleanup(state, ['iterator'], pending);
      assertFailures(await result, [primary, cleanup]);
      assertFailure(await rejected(iterator.return()), cleanup);
      await verifyFilesClosed(state);
      assert.deepEqual(await fs.readFile(state.files[0].filename), originalBytes);
    });
  }
  for (const [kind, cleanup] of primitiveReasons) await t.test('primitive-cleanup/' + kind, async () => {
    const primary = failure('The iterator read was rejected.');
    const state = current.state({ primaryFailed: true, primary }); state.cleanup.iterator = { failed: true, reason: cleanup };
    const pending = current.references().next(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve();
    await waitForCleanup(state, ['iterator'], pending); assertFailures(await result, [primary, cleanup]); await verifyFilesClosed(state);
  });
  for (const [kind, primary] of primitiveReasons) await t.test('successful-cleanup/' + kind, async () => {
    const state = current.state({ primaryFailed: true, primary }), pending = current.references().next(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['iterator'], pending);
    assertFailure(await result, primary); await verifyFilesClosed(state);
  });
});

test('loaded prepared saves retain committed file prefixes, apply failures and cleanup reasons', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [kind, primary] of [...primitiveReasons, ['error', failure('The metadata apply failed after writing its file prefix.')]]) await t.test('apply/' + kind, async () => {
    const cleanup = failure('The prepared save cleanup failed after releasing its file.');
    const state = current.state({ primaryFailed: true, primary }); state.cleanup.prepared = { failed: true, reason: cleanup };
    const prepared = await current.prepare(), pending = prepared.apply(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['prepared'], pending);
    assertFailures(await result, [primary, cleanup]);
    assertFailure(await rejected(prepared.close()), cleanup);
    await verifyFilesClosed(state); assert.deepEqual(await fs.readFile(state.files[0].filename), Buffer.concat([originalBytes, appliedBytes]));
  });
  for (const [kind, cleanup] of primitiveReasons) await t.test('successful-apply/' + kind, async () => {
    const state = current.state(); state.cleanup.prepared = { failed: true, reason: cleanup };
    const prepared = await current.prepare(), pending = prepared.apply(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['prepared'], pending);
    assertFailure(await result, cleanup); await verifyFilesClosed(state);
    assert.deepEqual(await fs.readFile(state.files[0].filename), Buffer.concat([originalBytes, appliedBytes]));
  });
  for (const [kind, primary] of primitiveReasons) await t.test('successful-cleanup/' + kind, async () => {
    const state = current.state({ primaryFailed: true, primary }), prepared = await current.prepare(), pending = prepared.apply(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['prepared'], pending);
    assertFailure(await result, primary); await verifyFilesClosed(state);
  });
  const state = current.state(), prepared = await current.prepare(), pending = prepared.apply();
  assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['prepared'], pending);
  assert.deepEqual(await pending, { applied: true, name: 'business-result', stack: 'business-result-stack' });
  await prepared.close(); await verifyFilesClosed(state);
});

test('loaded original live inputs preserve read and parallel resource cleanup failures without repeating EOF failures', { timeout: 60000 }, async t => {
  const current = await fixture(t);
  for (const [kind, primary] of [...primitiveReasons, ['error', failure('The live input failed after reading original bytes.')]]) await t.test('read/' + kind, async () => {
    const leaseCleanup = failure('The live lease failed after closing its file.');
    const bodyCleanup = kind === 'error' ? failure('The live body failed after closing its file.') : primary;
    const state = current.state({ primaryFailed: true, primary });
    state.cleanup.lease = { failed: true, reason: leaseCleanup }; state.cleanup.body = { failed: true, reason: bodyCleanup };
    current.expectedHostFailures.push(leaseCleanup, bodyCleanup);
    const lease = await current.open(), pending = lease.stream.next(), result = rejected(pending);
    assert.deepEqual(await state.read.promise, originalBytes); state.advance.resolve(); await waitForCleanup(state, ['lease', 'body'], pending);
    const actual = await result, cleanup = await rejected(lease.close());
    assertFailures(cleanup, [leaseCleanup, bodyCleanup]); assertFailures(actual, [primary, cleanup]); await verifyFilesClosed(state);
  });
  for (const [kind, leaseCleanup] of primitiveReasons) await t.test('EOF/' + kind, async () => {
    const bodyCleanup = failure('The exhausted live body failed after closing its file.');
    const state = current.state(); state.cleanup.lease = { failed: true, reason: leaseCleanup }; state.cleanup.body = { failed: true, reason: bodyCleanup };
    current.expectedHostFailures.push(leaseCleanup, bodyCleanup);
    const lease = await current.open(); state.advance.resolve();
    assert.deepEqual(await lease.stream.next(), { done: false, value: originalBytes });
    const pending = lease.stream.next(), result = rejected(pending);
    await waitForCleanup(state, ['lease', 'body'], pending);
    assertFailures(await result, [leaseCleanup, bodyCleanup]); await verifyFilesClosed(state);
    await assert.rejects(lease.stream.next(), { status: 503 });
  });
  const invalidCleanup = failure('The rejected input still closed its real lease.');
  const invalid = current.state({ invalidSource: true }); invalid.cleanup.lease = { failed: true, reason: invalidCleanup };
  current.expectedHostFailures.push(invalidCleanup);
  const opening = current.open(), invalidResult = rejected(opening);
  await waitForCleanup(invalid, ['lease', 'body'], opening);
  const rejectedInput = await invalidResult;
  assert.equal(rejectedInput.cause.code, 'not-supported'); assert.equal(rejectedInput.cause.status, 400);
  assertFailures(rejectedInput.errors[1], [invalidCleanup]); assertFailures(rejectedInput, [rejectedInput.cause, rejectedInput.errors[1]]);
  await verifyFilesClosed(invalid);
  const recovered = current.state(), lease = await current.open(); recovered.advance.resolve();
  assert.deepEqual(await lease.stream.next(), { done: false, value: originalBytes });
  const ending = lease.stream.next(); await waitForCleanup(recovered, ['lease', 'body'], ending);
  assert.deepEqual(await ending, { done: true }); await lease.close(); await verifyFilesClosed(recovered);
});

test('plugin owner close waits for an explicitly closing prepared file and rejects stale work', { timeout: 30000 }, async t => {
  const current = await fixture(t), state = current.state(), prepared = await current.prepare();
  const closing = prepared.close(); await state.entered.prepared.promise;
  const stopping = current.host.close(); let settled = false;
  stopping.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'Plugin host close retains a manually closing prepared file.');
  assert.equal((await state.files[0].handle.stat()).size, originalBytes.length);
  assert.throws(() => prepared.apply(), { status: 503 });
  state.release.resolve(); await closing; await prepared.close(); await stopping; await verifyFilesClosed(state);
  assert.deepEqual(await fs.readFile(state.files[0].filename), originalBytes);
});
