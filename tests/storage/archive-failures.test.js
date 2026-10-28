import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const sourceBytes = Buffer.alloc(196731, 0x6d), prefix = sourceBytes.subarray(0, 65536);
const structured = message => Object.assign(new Error(message, { cause: { name: 'business-name', stack: 'business-stack' } }),
  { code: 'ARCHIVE_SOURCE', status: 503, statusCode: 509, errors: [false, 0, '', null, undefined] });
const reasons = [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['error', structured('The archive operation failed.')],
  ['business', { message: 'The archive source was rejected.', code: 'ARCHIVE_SOURCE', status: 507,
    name: 'business-name', stack: 'business-stack', errors: [false, null] }]];
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  return Object.fromEntries((value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value))
    .map(key => [key, functional(value[key])]));
};
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const outcome = promise => Promise.resolve(promise).then(value => ({ failed: false, value }), error => ({ failed: true, error }));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const observation = value => value instanceof Error ? errorObservation(value) : Array.isArray(value) ? value.map(observation)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, observation(entry)])) : value;
function ordered(actual, expected) {
  sameReason(actual.errors, expected); sameReason(actual.cause, expected[0]);
  for (const key of ['code', 'status', 'statusCode']) assert.equal(actual[key], expected[0]?.[key]);
}
async function pendingBeforeRelease(pending) {
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The operation waits for the actual owned cleanup.');
}

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'archive-failures-'));
  const files = path.join(root, 'files'), spool = path.join(files, 'spool'), evidence = path.join(root, 'evidence');
  await fs.mkdir(files); await fs.mkdir(spool); await fs.mkdir(evidence);
  await fs.writeFile(path.join(files, 'source.bin'), sourceBytes);
  await fs.copyFile(new URL('../metadata/fixtures/book-opf-epub/assets/archive/local-central-name-mismatch.zip', import.meta.url), path.join(files, 'valid.zip'));
  const identityMap = new IdentityAccessMap(); identityMap.bind('source', '/source.bin'); identityMap.bind('valid', '/valid.zip');
  const item = name => ({ Id: name, Path: 'Z:\\OriginalBooks\\' + name + '.zip' });
  const sources = [], workers = [], operations = [];
  let selectedSource, selectedWorker;
  const vfs = { async openRead(access, { signal } = {}) {
    const state = selectedSource, file = await fs.open(path.join(files, access.slice(1)), 'r');
    const owner = { file, entered: Promise.withResolvers(), release: Promise.withResolvers(), ...state };
    sources.push(owner); if (!state) owner.release.resolve();
    owner.opened?.resolve(owner);
    owner.stream = (async function* () {
      let position = 0;
      while (true) {
        if (position > 0 && owner.advance) { owner.nextEntered.resolve(); await owner.advance.promise; }
        signal?.throwIfAborted();
        if (position > 0 && Object.hasOwn(owner, 'readFailure')) throw owner.readFailure;
        if (position > 0 && owner.controller) { owner.controller.abort(owner.abortReason); signal.throwIfAborted(); }
        const bytes = Buffer.alloc(65536), { bytesRead } = await file.read(bytes, 0, bytes.length, position);
        if (!bytesRead) return;
        position += bytesRead; yield bytes.subarray(0, bytesRead);
      }
    })();
    let closing;
    owner.close = () => closing ??= (async () => {
      owner.entered.resolve(); await owner.release.promise;
      await file.close(); owner.closed = true;
      if (Object.hasOwn(owner, 'closeFailure')) throw owner.closeFailure;
    })();
    return owner;
  } };
  const service = new BookArchiveService({ vfs, identityMap, spoolPath: spool, createWorker(workerData) {
    const state = selectedWorker;
    const worker = new Worker(new URL('../../src/storage/archive-worker.js', import.meta.url), { workerData, trackUnmanagedFds: true });
    const terminate = worker.terminate.bind(worker), owner = { worker, workerData, terminate,
      entered: Promise.withResolvers(), release: Promise.withResolvers(), ...state };
    workers.push(owner); if (!state) owner.release.resolve();
    owner.opened?.resolve(owner);
    worker.on('message', message => { if (Object.hasOwn(message, 'error')) owner.initialFailure = message.error; });
    worker.terminate = async () => {
      owner.entered.resolve(); await owner.release.promise;
      const value = await terminate();
      if (owner.blockSpools) {
        await fs.unlink(workerData.filename); await fs.mkdir(workerData.filename); await fs.mkdir(workerData.filename + '.entry');
      }
      if (Object.hasOwn(owner, 'terminateFailure')) throw owner.terminateFailure;
      return value;
    };
    return worker;
  } });
  t.after(async () => {
    selectedSource = undefined; selectedWorker = undefined;
    for (const owner of [...sources, ...workers]) { owner.advance?.resolve(); owner.release.resolve(); }
    await Promise.allSettled(operations); await Promise.allSettled([service.close()]);
    await Promise.allSettled(workers.map(owner => owner.terminate()));
    await Promise.allSettled(sources.map(owner => owner.file.close()));
    assert.equal(path.dirname(root), output); assert.equal(path.dirname(files), root);
    await fs.rm(files, { recursive: true });
  });
  return {
    service, sources, workers, spool, item,
    selectSource(state) { selectedSource = { ...state, opened: Promise.withResolvers() }; return selectedSource.opened.promise; },
    selectWorker(state) { selectedWorker = { ...state, opened: Promise.withResolvers() }; return selectedWorker.opened.promise; },
    track(promise) { const pending = outcome(promise); operations.push(pending); return pending; },
    async record(name, value, bytes) {
      await fs.writeFile(path.join(evidence, name + '.json'), JSON.stringify(observation(value), null, 2) + '\n');
      if (bytes) await fs.writeFile(path.join(evidence, name + '.bin'), bytes);
    },
    async recovery() {
      selectedSource = undefined; selectedWorker = undefined;
      const archive = await service.openArchive(item('valid'), { zipOnly: true });
      try { assert.equal(digest(await archive.read(archive.entries[0])), '5acbfff1b086e0f920c5857527976199018afe0cbf16e28d42c7eb9c683508e5'); }
      finally { await archive.close(); }
      assert.deepEqual(await fs.readdir(spool), []);
    },
  };
}

test('archive spooling retains source and cancellation failures while draining the real source and destination', { timeout: 90000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons) for (const mode of ['read', 'read-close', 'close', 'cancel-close']) {
    await t.test(mode + '/' + label, async () => {
      const cleanup = structured('The source failed after actually closing.'), controller = new AbortController();
      const selection = mode === 'close' ? { closeFailure: reason }
        : mode === 'cancel-close' ? { controller, abortReason: reason, closeFailure: cleanup }
          : { readFailure: reason, ...(mode === 'read-close' ? { closeFailure: cleanup } : {}) };
      const opened = current.selectSource(selection);
      const pending = current.track(current.service.openArchive(current.item('source'), { signal: controller.signal, zipOnly: true }));
      // The source is an actual open file and the destination already contains
      // its real prefix when cleanup starts. No worker has substituted bytes.
      const owner = await opened; await owner.entered.promise;
      await owner.file.stat(); await pendingBeforeRelease(pending);
      const names = await fs.readdir(current.spool); assert.equal(names.length, 1);
      const copied = await fs.readFile(path.join(current.spool, names[0]));
      assert.deepEqual(copied, mode === 'close' ? sourceBytes : prefix);
      owner.release.resolve(); const result = await pending; assert.equal(result.failed, true);
      await assert.rejects(owner.file.stat(), { code: 'EBADF' });
      if (mode === 'read-close' || mode === 'cancel-close') ordered(result.error, [mode === 'cancel-close' ? controller.signal.reason : reason, cleanup]);
      else sameReason(result.error, reason);
      assert.deepEqual(await fs.readdir(current.spool), []);
      await current.record(mode + '-' + label, { result, sourceClosed: owner.closed, spoolEmpty: true }, copied);
      await current.recovery();
    });
  }
});

test('archive opening preserves a real worker initialization failure through termination failures', { timeout: 90000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons) await t.test(label, async () => {
    const opened = current.selectWorker({ terminateFailure: reason });
    const pending = current.track(current.service.openArchive(current.item('source'), { zipOnly: true }));
    const owner = await opened; await owner.entered.promise; await pendingBeforeRelease(pending);
    owner.release.resolve(); const result = await pending; assert.equal(result.failed, true);
    assert.equal(typeof result.error.errors?.[0]?.message, 'string');
    assert.equal(result.error.errors[0].message, owner.initialFailure.message);
    assert.equal(result.error.errors[0].code, owner.initialFailure.code);
    ordered(result.error, [result.error.errors[0], reason]);
    assert.equal(owner.worker.threadId, -1); assert.deepEqual(await fs.readdir(current.spool), []);
    await current.record('initialize-' + label, { result, workerFailure: owner.initialFailure, workerStopped: true, spoolEmpty: true });
    await current.recovery();
  });
});

test('archive close waits for the real worker and retains every cleanup failure', { timeout: 90000 }, async t => {
  const current = await fixture(t);
  for (const [label, reason] of reasons) await t.test('terminate/' + label, async () => {
    current.selectWorker({ terminateFailure: reason });
    const archive = await current.service.openArchive(current.item('valid'), { zipOnly: true });
    assert.equal(digest(await archive.read(archive.entries[0])), '5acbfff1b086e0f920c5857527976199018afe0cbf16e28d42c7eb9c683508e5');
    const owner = current.workers.at(-1), first = current.track(archive.close()), second = current.track(archive.close());
    await owner.entered.promise; await pendingBeforeRelease(first); await pendingBeforeRelease(second);
    owner.release.resolve(); const results = await Promise.all([first, second]);
    for (const result of results) { assert.equal(result.failed, true); sameReason(result.error, reason); }
    assert.equal(owner.worker.threadId, -1); assert.deepEqual(await fs.readdir(current.spool), []);
    await current.record('terminate-' + label, { results, workerStopped: true, spoolEmpty: true });
    await current.recovery();
  });
  await t.test('both-spool-removals-after-termination', async () => {
    current.selectWorker({ terminateFailure: false, blockSpools: true });
    const archive = await current.service.openArchive(current.item('valid'), { zipOnly: true }), owner = current.workers.at(-1);
    const pending = current.track(archive.close()); await owner.entered.promise; owner.release.resolve();
    const result = await pending; assert.equal(result.failed, true); assert.equal(owner.worker.threadId, -1);
    const cleanup = result.error.errors?.[1]; ordered(result.error, [false, cleanup]);
    assert.equal(cleanup.errors.length, 2);
    for (const [index, suffix] of ['', '.entry'].entries()) {
      assert.equal(cleanup.errors[index].path, owner.workerData.filename + suffix);
      assert.equal((await fs.stat(owner.workerData.filename + suffix)).isDirectory(), true);
    }
    await current.record('blocked-spools', { result, workerStopped: true, remaining: await fs.readdir(current.spool) });
    for (const suffix of ['', '.entry']) await fs.rmdir(owner.workerData.filename + suffix);
    await current.recovery();
  });
});

test('archive service shutdown drains all real readers before reporting their failures', { timeout: 30000 }, async t => {
  const current = await fixture(t), owners = [];
  for (const reason of [false, 0]) {
    current.selectWorker({ terminateFailure: reason });
    const archive = await current.service.openArchive(current.item('valid'), { zipOnly: true });
    assert.ok((await archive.read(archive.entries[0])).length > 0); owners.push(current.workers.at(-1));
  }
  const pending = current.track(current.service.close());
  await Promise.all(owners.map(owner => owner.entered.promise)); await pendingBeforeRelease(pending);
  owners[0].release.resolve(); await pendingBeforeRelease(pending);
  owners[1].release.resolve(); const result = await pending; assert.equal(result.failed, true);
  ordered(result.error, [false, 0]);
  for (const owner of owners) assert.equal(owner.worker.threadId, -1);
  assert.deepEqual(await fs.readdir(current.spool), []);
  const admission = await outcome(current.service.openArchive(current.item('valid')));
  assert.equal(admission.failed, true); assert.equal(admission.error.code, 'closed');
  await current.record('shutdown', { result, allWorkersStopped: true, spoolEmpty: true, admission });
});

test('archive shutdown retains a reader failure while a separate opening still drains', { timeout: 30000 }, async t => {
  const current = await fixture(t);
  const workerOpened = current.selectWorker({ terminateFailure: false });
  const archive = await current.service.openArchive(current.item('valid'), { zipOnly: true }), worker = await workerOpened;
  const sourceOpened = current.selectSource({ readFailure: 0 });
  const opening = current.track(current.service.openArchive(current.item('source'), { zipOnly: true }));
  const source = await sourceOpened; await source.entered.promise;
  const closing = current.track(current.service.close()); await worker.entered.promise;
  const readerClosing = current.track(archive.close()); worker.release.resolve();
  const readerResult = await readerClosing; assert.equal(readerResult.failed, true); sameReason(readerResult.error, false);
  assert.equal(worker.worker.threadId, -1); await pendingBeforeRelease(closing);
  source.release.resolve(); const [openResult, closeResult] = await Promise.all([opening, closing]);
  assert.equal(openResult.failed, true); sameReason(openResult.error, 0);
  assert.equal(closeResult.failed, true); sameReason(closeResult.error, false);
  await assert.rejects(source.file.stat(), { code: 'EBADF' });
  assert.deepEqual(await fs.readdir(current.spool), []);
  await current.record('shutdown-during-opening', { readerResult, openResult, closeResult, workerStopped: true, sourceClosed: true, spoolEmpty: true });
});

test('archive shutdown reports opening cleanup failures while preserving normal lifetime cancellation', { timeout: 30000 }, async t => {
  for (const closeFails of [false, true]) await t.test(String(closeFails), async t => {
    const current = await fixture(t);
    const opened = current.selectSource({ advance: Promise.withResolvers(), nextEntered: Promise.withResolvers(),
      ...(closeFails ? { closeFailure: false } : {}) });
    const opening = current.track(current.service.openArchive(current.item('source'), { zipOnly: true }));
    const source = await opened; await source.nextEntered.promise;
    const names = await fs.readdir(current.spool); assert.equal(names.length, 1);
    const copied = await fs.readFile(path.join(current.spool, names[0])); assert.deepEqual(copied, prefix);
    const closing = current.track(current.service.close()); source.advance.resolve();
    await source.entered.promise; await pendingBeforeRelease(closing); source.release.resolve();
    const [openResult, closeResult] = await Promise.all([opening, closing]);
    assert.equal(openResult.failed, true);
    if (closeFails) {
      assert.equal(openResult.error.errors[0].code, 'closed'); ordered(openResult.error, [openResult.error.errors[0], false]);
      assert.equal(closeResult.failed, true); sameReason(closeResult.error, false);
    } else { assert.equal(openResult.error.code, 'closed'); assert.equal(closeResult.failed, false); }
    await assert.rejects(source.file.stat(), { code: 'EBADF' }); assert.deepEqual(await fs.readdir(current.spool), []);
    await current.record('shutdown-opening-cleanup', { closeFails, openResult, closeResult, sourceClosed: true, spoolEmpty: true }, copied);
  });
});
