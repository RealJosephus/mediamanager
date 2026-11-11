import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await immediate();
  assert.equal(settled, false, 'Closing must wait until the actual file descriptor is released.');
}
async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'local-handle-close-'));
  const registry = new StorageRegistry(), releases = [], pending = [], reports = [];
  registry.registerType('local', config => LocalAdapter.open(config));
  const adapter = await registry.createInstance('files', 'local', { root, writable: true });
  t.after(async () => {
    for (const release of releases) release.resolve();
    await Promise.allSettled(pending);
    await registry.close().catch(() => {});
    await fs.writeFile(path.join(output, path.basename(root) + '.json'), JSON.stringify(reports, null, 2) + '\n', { flag: 'wx' });
    assert.equal(path.dirname(root), output);
    await fs.rm(root, { recursive: true });
  });
  return { root, adapter, registry, releases, pending, reports };
}

test('Local file and registry closes join a real FileHandle write until its descriptor closes', { timeout: 30000 }, async t => {
  const state = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  state.releases.push(release);
  const file = await state.adapter.openFile('/pending.bin', 'w'), fd = file.fd;
  const prefix = Buffer.alloc(65536, 0x41), suffix = Buffer.alloc(8193, 0x42);
  const writing = file.writeFile((async function* () {
    yield prefix; entered.resolve(); await release.promise; yield suffix;
  })());
  state.pending.push(writing);
  await entered.promise;
  const first = file.close(), second = file.close(), closing = state.registry.close();
  state.pending.push(first, second, closing);
  await remainsPending(first); await remainsPending(second); await remainsPending(closing);
  assert.equal(fstatSync(fd).size, prefix.length);
  assert.throws(() => file.writeSync(Buffer.from('late')), { code: 'closed' });
  release.resolve();
  await Promise.all([writing, first, second, closing]);
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  assert.deepEqual(await fs.readFile(path.join(state.root, 'pending.bin')), Buffer.concat([prefix, suffix]));
  await file.close(); await state.registry.close();
  state.reports.push({ actualWriteDrained: true, descriptorClosed: true, repeatedCloseWaited: true });

  const recovered = await LocalAdapter.open({ root: state.root, writable: true });
  try {
    const reader = await recovered.openRead('/pending.bin');
    const chunks = []; for await (const chunk of reader.stream) chunks.push(chunk);
    await Promise.all([reader.close(), reader.close(), recovered.close()]);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([prefix, suffix]));
  } finally { await recovered.close(); }
});

test('Local concurrent closes retain a failure after the real descriptor release', { timeout: 30000 }, async t => {
  for (const [label, failure] of [['error', new Error('Controlled file close failure.')], ['false', false], ['zero', 0],
    ['empty', ''], ['null', null], ['undefined', undefined]]) await t.test(label, async t => {
    const state = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
    state.releases.push(release);
    const file = await state.adapter.openFile('/failure.bin', 'w'), fd = file.fd;
    await file.writeFile('Complete bytes before the close failure.');
    // The proxy exposes the actual FileHandle's descriptor. Delay only this
    // owner's native close, then fail after it really releases the descriptor.
    const descriptor = Object.getOwnPropertyDescriptor(file, 'close');
    assert.equal(typeof descriptor?.value, 'function');
    Object.defineProperty(file, 'close', { ...descriptor, value: async () => {
      entered.resolve(); await release.promise; await descriptor.value.call(file); throw failure;
    } });
    const first = outcome(file.close()); await entered.promise;
    const second = outcome(file.close()), closing = outcome(state.registry.close());
    state.pending.push(first, second, closing);
    await remainsPending(first); await remainsPending(second); await remainsPending(closing);
    assert.ok(fstatSync(fd).isFile());
    release.resolve();
    const results = await Promise.all([first, second, closing]);
    assert.throws(() => fstatSync(fd), { code: 'EBADF' });
    for (const result of results.slice(0, 2)) { assert.equal(result.failed, true); assert.equal(result.reason, failure); }
    assert.equal(results[2].failed, true); assert.deepEqual(results[2].reason.errors, [failure]);
    const repeated = await outcome(file.close()); assert.equal(repeated.failed, true); assert.equal(repeated.reason, failure);
    state.reports.push({ failure: label, results: results.map(errorObservation), descriptorClosed: true });
  });
});
