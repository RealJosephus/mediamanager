import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LibraryTaskScheduler } from '../../src/library/library-task-scheduler.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

const provenanceUrl = new URL('./fixtures/library-task-scheduler/provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const repository = new URL('../../', import.meta.url);
const read = async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'));
const [native, lowCpu, repeat, provenance] = await Promise.all(['cpu4.json', 'cpu3.json', 'cpu4-repeat.json', 'provenance.json'].map(read));
const nativeCase = name => native.results.find(sample => sample.name === name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('shared scheduler oracle binds three actual native executions and their functional boundaries', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(hash(await readFile(new URL(file.path, repository))), file.sha256, file.path);
  for (const prefix of ['cpu4', 'cpu3', 'cpu4-repeat']) {
    const [record, sources] = await Promise.all([read(prefix + '-record.json'), read(prefix + '-source.json')]);
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
    for (const file of record.sourceFiles) {
      const name = file.filename.replaceAll('\\', '/').split('/').at(-1);
      const target = name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(name, root);
      assert.equal(hash(await readFile(target)), file.sha256, name);
    }
    for (const file of sources.referenceSources) {
      assert.equal(hash(await readFile(recordedInputPath(file.path, [file.sha256]))), file.sha256, file.path);
    }
  }
  assert.equal(native.results.length, 16); assert.equal(lowCpu.results.length, 16); assert.equal(repeat.results.length, 16);
  assert.equal(native.processorCount, 4); assert.equal(lowCpu.processorCount, 3);
  assert.deepEqual(nativeCase('half-even-progress').progress, [1, 0, -1, 25, 26, 50, 63, 100]);
});

function sequence(items, { onRelease = () => {} } = {}) {
  return { async count() { return BigInt(items.length); }, async *pages() {
    for (let index = 0; index < items.length; index += 128) {
      const page = items.slice(index, index + 128);
      try { yield page; } finally { onRelease(page); }
    }
  } };
}
function gate() { return Promise.withResolvers(); }
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [setting, processors, expected] of [[1, 4, true], [0, 4, false], [-9, 4, false], [0, 3, true]]) {
  test(`shared scheduler: setting ${setting}, CPU ${processors} preserves native overlapping-workset mode`, async t => {
    const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: setting }, processors: () => processors });
    t.after(() => scheduler.close());
    const aEntered = gate(), aRelease = gate(), bEntered = gate(), bRelease = gate();
    const a = scheduler.enqueue(sequence([0]), async () => { aEntered.resolve(); await aRelease.promise; });
    await aEntered.promise;
    let bStarted = false;
    const b = scheduler.enqueue(sequence([0]), async () => { bStarted = true; bEntered.resolve(); await bRelease.promise; });
    await tick(); assert.equal(bStarted, expected);
    const recording = (processors === 3 ? lowCpu : native).results.find(sample => sample.name === (setting === 1 ? 'explicit-one' : setting < 0 ? 'negative-default' : 'default'));
    assert.equal(bStarted, recording.secondStartedBeforeRelease);
    aRelease.resolve(); await bEntered.promise; bRelease.resolve(); await Promise.all([a, b]);
  });
}

test('shared pooled work dispatches remaining older slots but overlaps the next workset before prior completion', async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } });
  t.after(() => scheduler.close());
  const entered = Array.from({ length: 5 }, gate), release = Array.from({ length: 5 }, gate), calls = [];
  const worker = async item => { calls.push(item); entered[item].resolve(); await release[item].promise; };
  const a = scheduler.enqueue(sequence([0, 1, 2]), worker);
  await Promise.all([entered[0].promise, entered[1].promise]);
  const b = scheduler.enqueue(sequence([3, 4]), worker);
  release[0].resolve(); await entered[2].promise; assert.deepEqual(calls, [0, 1, 2]);
  let firstDone = false; void a.then(() => { firstDone = true; });
  release[1].resolve(); await entered[3].promise; assert.equal(firstDone, nativeCase('pooled-overlap-fifo').firstDoneAtSecondStart);
  release[2].resolve(); await entered[4].promise;
  release[3].resolve(); release[4].resolve(); await Promise.all([a, b]);
});

for (const independent of [false, true]) test(`nested ${independent ? 'independent' : 'shared'} scheduler work stays sequential within an active pooled worker`, async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } });
  const other = independent ? new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } }) : scheduler;
  t.after(async () => { await scheduler.close(); await other.close(); });
  const first = gate(), release = gate(), calls = [];
  const work = scheduler.enqueue(sequence([0]), () => other.enqueue(sequence([1, 2]), async item => {
    calls.push(item); if (item === 1) { first.resolve(); await release.promise; }
  }));
  await first.promise; await tick(); assert.deepEqual(calls, [1]);
  release.resolve(); await work; assert.deepEqual(calls, [1, 2]);
});

test('per-slot half-even progress and ordinary worker failures preserve native averages and continuation', async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } });
  t.after(() => scheduler.close());
  const progress = [];
  await scheduler.enqueue(sequence([0, 1]), (item, report) => {
    for (const value of item === 0 ? [.5, 1.5, 2.5, -.5, -1.5, 50.5, 51.5, 99.5, 100.5] : [25.5]) report(value);
  }, { reportProgress: value => progress.push(value) });
  assert.deepEqual(progress, nativeCase('half-even-progress').progress);
  const calls = [], errors = [], failure = new Error('Controlled library worker failure.');
  await scheduler.enqueue(sequence([0, 1, 2]), item => { calls.push(item); if (item === 1) throw failure; },
    { onError: error => errors.push(error) });
  assert.deepEqual(calls, nativeCase('worker-failure').calls); assert.deepEqual(errors, [failure]);
});

test('cancellation skips queued callbacks, drains active errors and completes the workset', async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } });
  t.after(() => scheduler.close());
  const controller = new AbortController(), entered = [gate(), gate()], release = [gate(), gate()];
  const calls = [], errors = [], progress = [];
  const work = scheduler.enqueue(sequence([0, 1, 2]), async item => {
    calls.push(item); entered[item].resolve(); await release[item].promise; controller.signal.throwIfAborted();
  }, { signal: controller.signal, onError: error => errors.push(error), reportProgress: value => progress.push(value) });
  await Promise.all(entered.map(item => item.promise)); controller.abort(); release[0].resolve(); await tick(); release[1].resolve();
  await work; assert.deepEqual(calls, [0, 1]); assert.equal(errors.length, 2); assert.equal(progress.at(-1), 100);
});

test('empty and initially cancelled worksets complete progress without reading or invoking children', async t => {
  const scheduler = new LibraryTaskScheduler(); t.after(() => scheduler.close());
  const empty = [], cancelled = [], controller = new AbortController(); controller.abort();
  await scheduler.enqueue(sequence([]), () => assert.fail('No empty callback.'), { reportProgress: value => empty.push(value) });
  await scheduler.enqueue({ count() { assert.fail('No cancelled count.'); }, pages() { assert.fail('No cancelled enumeration.'); } },
    () => assert.fail('No cancelled callback.'), { signal: controller.signal, reportProgress: value => cancelled.push(value) });
  assert.deepEqual(empty, nativeCase('empty-and-pre-cancelled').empty);
  assert.deepEqual(cancelled, nativeCase('empty-and-pre-cancelled').cancelled);
});

test('scheduler close drains active callbacks and their page ownership, releases queued waiters and rejects new work by omission', async () => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } });
  const entered = [gate(), gate()], release = gate(), calls = []; let pageReleased = false, closed = false;
  const work = scheduler.enqueue(sequence([0, 1, 2], { onRelease: () => { pageReleased = true; } }), async item => {
    calls.push(item); entered[item].resolve(); await release.promise; assert.equal(pageReleased, false);
  });
  await Promise.all(entered.map(item => item.promise));
  const closing = scheduler.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(pageReleased, false);
  await scheduler.enqueue(sequence([9]), () => assert.fail('No new callback after close.'));
  release.resolve(); await Promise.all([work, closing]); assert.deepEqual(calls, [0, 1]); assert.equal(pageReleased, true);
});

test('close waits an already admitted sequential callback and does not wait on itself when invoked inside work', async () => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1 } });
  const entered = gate(), release = gate(); let finished = false;
  const work = scheduler.enqueue(sequence([0]), async () => {
    entered.resolve(); await release.promise; await scheduler.close(); finished = true;
  });
  await entered.promise; const closing = scheduler.close(); await tick(); assert.equal(finished, false);
  release.resolve(); await Promise.all([work, closing]); assert.equal(finished, true);
});

test('bounded pages remain owned across callbacks and do not become an all-item progress collection', async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 4 } });
  t.after(() => scheduler.close());
  const released = [], calls = [], progress = [];
  await scheduler.enqueue(sequence(Array.from({ length: 389 }, (_, index) => index), { onRelease: page => released.push(page.length) }),
    async item => { calls.push(item); await tick(); }, { reportProgress: value => progress.push(value) });
  assert.deepEqual(released, [128, 128, 128, 5]); assert.equal(calls.length, 389); assert.equal(new Set(calls).size, 389);
  assert.equal(progress.at(-1), 100);
});

test('the pooled active-worker budget stays bounded across worksets even above the entity page limit', async t => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 1024 } });
  t.after(() => scheduler.close());
  const entered = gate(), release = gate(); let active = 0, peak = 0, calls = 0;
  const worker = async () => {
    active++; calls++; peak = Math.max(peak, active);
    if (active === 128) entered.resolve();
    try { await release.promise; } finally { active--; }
  };
  const work = [scheduler.enqueue(sequence(Array.from({ length: 70 }, (_, index) => index)), worker),
    scheduler.enqueue(sequence(Array.from({ length: 70 }, (_, index) => index)), worker)];
  await entered.promise; await tick(); assert.equal(calls, 128); assert.equal(peak, 128);
  release.resolve(); await Promise.all(work); assert.equal(calls, 140); assert.equal(peak, 128);
});

for (const phase of ['count', 'page']) test(`close waits an admitted ${phase} read before releasing its sequence`, async () => {
  const scheduler = new LibraryTaskScheduler({ configuration: { LibraryScanFanoutConcurrency: 2 } });
  const entered = gate(), release = gate(); let released = false, called = false, closed = false;
  const work = scheduler.enqueue({ async count() {
    if (phase === 'count') { entered.resolve(); await release.promise; }
    return 1n;
  }, async *pages() {
    try { if (phase === 'page') { entered.resolve(); await release.promise; } yield [0]; }
    finally { released = true; }
  } }, () => { called = true; });
  await entered.promise; const closing = scheduler.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); release.resolve(); await Promise.all([work, closing]);
  assert.equal(called, false); assert.equal(released, phase === 'page');
});

test('live configuration grows fanout without cancelling work already admitted by another traversal', async t => {
  const configuration = { LibraryScanFanoutConcurrency: 2 }, scheduler = new LibraryTaskScheduler({ configuration });
  t.after(() => scheduler.close());
  const entered = Array.from({ length: 4 }, gate), release = gate(), calls = [];
  const worker = async item => { calls.push(item); entered[item].resolve(); await release.promise; };
  const first = scheduler.enqueue(sequence([0, 1]), worker); await Promise.all([entered[0].promise, entered[1].promise]);
  configuration.LibraryScanFanoutConcurrency = 4;
  const second = scheduler.enqueue(sequence([2, 3]), worker); await Promise.all([entered[2].promise, entered[3].promise]);
  configuration.LibraryScanFanoutConcurrency = 2;
  release.resolve(); await Promise.all([first, second]); assert.deepEqual(calls, [0, 1, 2, 3]);
});
