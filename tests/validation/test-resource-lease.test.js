import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestResource, withTestResource } from '../helpers/test-resource-lease.js';
import { resourceLeaseChildFilename } from './fixtures/resource-lease-child.mjs';
import { fileTestResourceChildFilename } from './fixtures/file-test-resource-child.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-resource-lease-'));
  const root = path.join(directory, 'leases'), children = [];
  await mkdir(root);
  t.after(async () => {
    for (const child of children) await child.cleanup();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mediamanager-resource-lease-'));
    await rm(directory, { recursive: true, force: true });
  });
  const ownerBytes = resource => readFile(path.join(root, resource, 'owner.json'));
  const start = (options, { filename = resourceLeaseChildFilename } = {}) => {
    const environment = { ...process.env, MEDIAMANAGER_TEST_RESOURCE_ROOT: root };
    delete environment.NODE_TEST_CONTEXT;
    const processChild = spawn(process.execPath, [filename, JSON.stringify(options)], {
      env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const records = [], waiters = new Set(); let output = '', spawnError, closed;
    processChild.stdout.on('data', bytes => { output += bytes; });
    processChild.stderr.on('data', bytes => { output += bytes; });
    processChild.on('error', error => { spawnError = error; });
    const exited = new Promise(resolve => processChild.once('close', (code, signal) => {
      closed = { code, signal, spawnError: spawnError?.message ?? null };
      for (const pending of [...waiters]) pending.reject(new Error('Resource child closed before its expected event: ' + JSON.stringify({ closed, records, output })));
      resolve(closed);
    }));
    processChild.on('message', record => {
      records.push(record);
      for (const pending of [...waiters]) if (pending.event === record.event) pending.resolve(record);
    });
    const wait = event => {
      const observed = records.find(record => record.event === event);
      if (observed) return Promise.resolve(observed);
      if (closed) return Promise.reject(new Error('Resource child already closed: ' + JSON.stringify({ closed, records, output })));
      return new Promise((resolve, reject) => {
        const settle = (operation, value) => { waiters.delete(pending); t.signal.removeEventListener('abort', abort); operation(value); };
        const abort = () => settle(reject, t.signal.reason);
        const pending = { event, resolve: value => settle(resolve, value), reject: error => settle(reject, error) };
        waiters.add(pending); t.signal.addEventListener('abort', abort, { once: true });
        if (t.signal.aborted) abort();
      });
    };
    const send = action => new Promise((resolve, reject) => processChild.send({ action }, error => error ? reject(error) : resolve()));
    const value = { records, wait, send, exited, pid: processChild.pid, get output() { return output; },
      async finish() {
        if (!closed && processChild.connected) {
          try { await send('exit'); }
          catch (error) { if (!['ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED', 'EPIPE'].includes(error.code)) throw error; }
        }
        assert.deepEqual(await exited, { code: 0, signal: null, spawnError: null }, output);
      },
      async cleanup() {
        if (closed) return;
        if (processChild.connected) {
          await send('cancel').catch(() => {});
          await send('release').catch(() => {});
          await send('exit').catch(() => {});
        }
        const timer = setTimeout(() => processChild.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(timer); }
      } };
    children.push(value); return value;
  };
  return { directory, root, ownerBytes, start, async empty() { assert.deepEqual(await readdir(root), []); } };
}

test('resource admission requires an explicit absolute output root and cancellation creates no owner', async t => {
  const value = await workspace(t);
  for (const root of ['', 'relative-resource-root']) await assert.rejects(acquireTestResource('controlled', { root }), { code: 'test-resource-root-required' });
  for (const key of ['../escape', 'nested/key', 'UPPER', '']) await assert.rejects(acquireTestResource(key, { root: value.root }), { code: 'test-resource-key-invalid' });
  await assert.rejects(acquireTestResource('controlled', { root: value.root, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await value.empty();
});

test('release preserves unexpected files and its owner until the controlled directory is empty', async t => {
  const value = await workspace(t), resource = 'unexpected-file';
  const lease = await acquireTestResource(resource, { root: value.root }), bytes = await value.ownerBytes(resource);
  const extra = path.join(lease.directory, 'preserve.txt'); await writeFile(extra, 'unexpected data');
  await assert.rejects(lease.release(), { code: 'test-resource-not-empty' });
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  assert.equal(await readFile(extra, 'utf8'), 'unexpected data');
  await unlink(extra); await lease.release(); await lease.release(); await value.empty();
});

test('independent processes serialize a shared critical file and a released handle cannot remove its successor', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'same-resource', criticalFile = path.join(value.directory, 'critical');
  const first = value.start({ resource, criticalFile }), initial = await first.wait('acquired');
  const second = value.start({ resource, criticalFile }); await second.wait('waiting');
  assert.notEqual(first.pid, second.pid); assert.notEqual(first.pid, process.pid);
  assert.equal(JSON.parse(await readFile(criticalFile, 'utf8')).pid, first.pid);
  assert.equal(second.records.some(record => record.event === 'acquired'), false);
  await first.send('release'); await first.wait('released');
  const successor = await second.wait('acquired');
  assert.equal(JSON.parse(await readFile(criticalFile, 'utf8')).pid, second.pid);
  assert.notEqual(initial.owner.token, successor.owner.token);
  const bytes = await value.ownerBytes(resource);
  await first.send('release-again'); await first.wait('released-again');
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  await second.send('release'); await second.wait('released');
  await Promise.all([first.finish(), second.finish()]); await value.empty();
  t.diagnostic(JSON.stringify({ first: first.records, second: second.records }));
});

test('different resource keys are held concurrently by independent live processes', { timeout: 30000 }, async t => {
  const value = await workspace(t);
  const first = value.start({ resource: 'alpha', criticalFile: path.join(value.directory, 'alpha') });
  const second = value.start({ resource: 'beta', criticalFile: path.join(value.directory, 'beta') });
  await Promise.all([first.wait('acquired'), second.wait('acquired')]);
  assert.notEqual(first.pid, second.pid);
  assert.equal(JSON.parse(await value.ownerBytes('alpha')).pid, first.pid);
  assert.equal(JSON.parse(await value.ownerBytes('beta')).pid, second.pid);
  assert.deepEqual((await readdir(value.root)).sort(), ['alpha', 'beta']);
  await Promise.all([first.send('release'), second.send('release')]);
  await Promise.all([first.wait('released'), second.wait('released')]);
  await Promise.all([first.finish(), second.finish()]); await value.empty();
});

test('cancelling a waiting process preserves the live resource owner', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'cancelled-waiter';
  const owner = value.start({ resource }); await owner.wait('acquired');
  const bytes = await value.ownerBytes(resource), waiter = value.start({ resource }); await waiter.wait('waiting');
  await waiter.send('cancel'); const failure = await waiter.wait('failed');
  assert.equal(failure.cancelled, true); assert.equal(failure.error.name, 'AbortError');
  assert.equal(waiter.records.some(record => record.event === 'acquired'), false);
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  await waiter.finish(); await owner.send('release'); await owner.wait('released'); await owner.finish(); await value.empty();
});

test('cancelling a waiting protected operation never runs its callback or disturbs the owner', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'cancelled-operation';
  const owner = value.start({ resource }); await owner.wait('acquired');
  const bytes = await value.ownerBytes(resource), waiting = Promise.withResolvers();
  const controller = new AbortController();
  const cancellation = Object.assign(new Error('Controlled resource wait cancellation.'), { code: 'controlled-resource-cancel' });
  let callbackEntered = false;
  const operation = withTestResource(resource, async () => { callbackEntered = true; }, {
    root: value.root, signal: controller.signal, onWait: () => waiting.resolve(),
  });
  const rejected = assert.rejects(operation, error => {
    assert.equal(error.message, cancellation.message);
    assert.equal(error.code, cancellation.code);
    return true;
  });
  await waiting.promise; controller.abort(cancellation); await rejected;
  assert.equal(callbackEntered, false);
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  await owner.send('release'); await owner.wait('released'); await owner.finish(); await value.empty();
  assert.equal(await withTestResource(resource, async () => {
    assert.equal(JSON.parse(await value.ownerBytes(resource)).pid, process.pid);
    return 'completed';
  }, { root: value.root, signal: t.signal }), 'completed');
  assert.equal(callbackEntered, false);
  await value.empty();
});

test('an exited owner fails its real contender without reclaiming the abandoned lease', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'abandoned-resource';
  const owner = value.start({ resource }); const acquired = await owner.wait('acquired');
  const bytes = await value.ownerBytes(resource), waiter = value.start({ resource }); await waiter.wait('waiting');
  await owner.send('crash'); assert.deepEqual(await owner.exited, { code: 23, signal: null, spawnError: null });
  const failure = await waiter.wait('failed');
  assert.equal(failure.error.code, 'test-resource-owner-exited');
  assert.equal(failure.error.owner.pid, owner.pid); assert.equal(failure.error.owner.token, acquired.owner.token);
  assert.equal(waiter.records.some(record => record.event === 'acquired'), false);
  assert.deepEqual(await value.ownerBytes(resource), bytes); assert.deepEqual(await readdir(value.root), [resource]);
  await waiter.finish(); t.diagnostic(JSON.stringify({ abandoned: acquired.owner, contender: failure }));
  // Retire only this deliberately abandoned private test fixture, after proving
  // that the lease implementation preserved it and both children have exited.
  await unlink(path.join(value.root, resource, 'owner.json')); await rmdir(path.join(value.root, resource)); await value.empty();
});

test('release rejects a different live process token and preserves its published receipt', { timeout: 30000 }, async t => {
  const value = await workspace(t), first = value.start({ resource: 'replaced-owner' }), second = value.start({ resource: 'other-owner' });
  await first.wait('acquired'); const current = await second.wait('acquired');
  const replacement = Buffer.from(JSON.stringify({ ...current.owner, resource: 'replaced-owner' }) + '\n');
  await writeFile(path.join(value.root, 'replaced-owner', 'owner.json'), replacement);
  await first.send('release'); const failure = await first.wait('failed');
  assert.equal(failure.error.code, 'test-resource-owner-mismatch');
  assert.deepEqual(await value.ownerBytes('replaced-owner'), replacement);
  assert.equal(JSON.parse(await value.ownerBytes('other-owner')).pid, second.pid);
  await first.finish();
  await unlink(path.join(value.root, 'replaced-owner', 'owner.json')); await rmdir(path.join(value.root, 'replaced-owner'));
  await second.send('release'); await second.wait('released'); await second.finish(); await value.empty();
});

test('the final file hook releases only after real listener rebind and earlier cleanup hooks finish', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'file-cleanup', stateFile = path.join(value.directory, 'cleanup.json');
  const owner = value.start({ resource, mode: 'hooks', stateFile }); const body = await owner.wait('body-finished');
  const waiter = value.start({ resource }); await waiter.wait('waiting');
  await owner.wait('test-cleanup-start'); assert.equal(JSON.parse(await value.ownerBytes(resource)).pid, owner.pid);
  await owner.send('finish-test-cleanup'); await owner.wait('test-cleanup-finished'); await owner.wait('file-cleanup-start');
  assert.equal(JSON.parse(await value.ownerBytes(resource)).pid, owner.pid);
  assert.equal(waiter.records.some(record => record.event === 'acquired'), false);
  await owner.send('finish-file-cleanup'); await owner.wait('file-cleanup-finished'); await owner.wait('released');
  const admitted = await waiter.wait('acquired'); assert.equal(admitted.owner.pid, waiter.pid);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { testCleanupFinished: true, portRebound: true, fileCleanupFinished: true });
  assert.ok(body.port > 0);
  await owner.finish(); await waiter.send('release'); await waiter.wait('released'); await waiter.finish(); await value.empty();
  t.diagnostic(JSON.stringify({ owner: owner.records, waiter: waiter.records }));
});

test('file resource admission can wait longer than the unchanged business timeout before its callback begins', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'file-admission-budget', businessTimeout = 500;
  const owner = value.start({ resource }); await owner.wait('acquired');
  const bytes = await value.ownerBytes(resource);
  const consumer = value.start({ resource, mode: 'wait', businessTimeout }, { filename: fileTestResourceChildFilename });
  await consumer.wait('waiting');
  const waitingSince = performance.now();
  await delay(businessTimeout + 250, undefined, { signal: t.signal });
  assert.ok(performance.now() - waitingSince >= businessTimeout);
  assert.equal(consumer.records.some(record => record.event === 'body-started'), false);
  assert.equal(consumer.records.some(record => record.event === 'after-entered'), false);
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  await owner.send('release'); await owner.wait('released');
  const admitted = await consumer.wait('body-started'); assert.equal(admitted.owner.pid, consumer.pid);
  assert.notEqual(admitted.owner.token, JSON.parse(bytes).token);
  await consumer.wait('body-finished'); await consumer.wait('after-finished');
  await Promise.all([owner.finish(), consumer.finish()]); await value.empty();
  t.diagnostic(JSON.stringify({ businessTimeout, waitedMilliseconds: performance.now() - waitingSince, owner: owner.records, consumer: consumer.records }));
});

test('a timed-out file callback retains its real owner until its listener finally closes and rebinds', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'file-timeout-cleanup';
  const owner = value.start({ resource, mode: 'timeout', businessTimeout: 250 }, { filename: fileTestResourceChildFilename });
  const body = await owner.wait('body-started'), bytes = await value.ownerBytes(resource);
  assert.equal(body.owner.pid, owner.pid); assert.notEqual(owner.pid, process.pid); assert.ok(body.port > 0);
  const cleaning = await owner.wait('finally-entered');
  assert.equal(cleaning.aborted, true); assert.equal(cleaning.listening, true); assert.equal(cleaning.port, body.port);
  await owner.wait('after-entered');
  const contender = value.start({ resource }); await contender.wait('waiting');
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  assert.equal(contender.records.some(record => record.event === 'acquired'), false);
  assert.equal(owner.records.some(record => record.event === 'finally-completed' || record.event === 'after-finished'), false);
  await owner.send('finish-finally');
  const completed = await owner.wait('finally-completed');
  assert.equal(completed.listening, false); assert.equal(completed.portRebound, true); assert.equal(completed.port, body.port);
  await owner.wait('after-finished');
  const admitted = await contender.wait('acquired'); assert.equal(admitted.owner.pid, contender.pid);
  assert.notEqual(admitted.owner.token, body.owner.token);
  assert.deepEqual(await owner.exited, { code: 1, signal: null, spawnError: null }, owner.output);
  await contender.send('release'); await contender.wait('released'); await contender.finish(); await value.empty();
  t.diagnostic(JSON.stringify({ expectedChildFailure: 'testTimeoutFailure', owner: owner.records, contender: contender.records }));
});
