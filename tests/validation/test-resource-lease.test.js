import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestResource, withTestResource } from '../helpers/test-resource-lease.js';
import { acquireTestResources } from '../helpers/test-resource-group.js';
import { resourceLeaseChildFilename } from './fixtures/resource-lease-child.mjs';
import { fileTestResourceChildFilename } from './fixtures/file-test-resource-child.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-resource-lease-'));
  const root = path.join(directory, 'leases'), diagnostics = path.join(directory, 'diagnostics'), children = [];
  await mkdir(root);
  t.after(async () => {
    for (const child of children) await child.cleanup();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mediamanager-resource-lease-'));
    await rm(directory, { recursive: true, force: true });
  });
  const ownerBytes = resource => readFile(path.join(root, resource, 'owner.json'));
  const start = (options, { filename = resourceLeaseChildFilename } = {}) => {
    const environment = { ...process.env, MEDIAMANAGER_TEST_RESOURCE_ROOT: root,
      MEDIAMANAGER_TEST_DIAGNOSTICS_ROOT: diagnostics };
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
          catch (error) { if (!['ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED', 'EPIPE', 'ENOTCONN'].includes(error.code)) throw error; }
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
  return { directory, root, diagnostics, ownerBytes, start, async empty() { assert.deepEqual(await readdir(root), []); } };
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
  const journal = (await Promise.all((await readdir(value.diagnostics)).map(async name =>
    (await readFile(path.join(value.diagnostics, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))))).flat();
  for (const child of [first, second]) {
    const records = journal.filter(record => record.pid === child.pid && record.resource === resource);
    const requested = records.find(record => record.event === 'requested'), acquired = records.find(record => record.event === 'acquired');
    const released = records.find(record => record.event === 'released');
    assert.ok(requested && acquired && released);
    assert.ok(acquired.elapsedMs >= requested.elapsedMs && released.elapsedMs >= acquired.elapsedMs);
    assert.ok(records.every(record => record.fixture === 'tests/validation/fixtures/resource-lease-child.mjs'));
    assert.ok(records.every(record => !Object.hasOwn(record, 'token') && !Object.hasOwn(record, 'processEntry')));
  }
  assert.ok(journal.some(record => record.pid === second.pid && record.event === 'waiting' && record.ownerPid === first.pid
    && record.ownerFixture === 'tests/validation/fixtures/resource-lease-child.mjs'));
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

test('a failed initialization hook closes its actual owners before releasing its file lease to a real successor', { timeout: 30000 }, async t => {
  const value = await workspace(t), resource = 'file-initialization-failure', criticalFile = path.join(value.directory, 'initialization-owner');
  const owner = value.start({ resource, mode: 'initialization-failure', criticalFile }, { filename: fileTestResourceChildFilename });
  const initialized = await owner.wait('initialization-started'), bytes = await value.ownerBytes(resource);
  assert.equal(initialized.owner.pid, owner.pid); assert.ok(initialized.port > 0);
  const successor = value.start({ resource }); await successor.wait('waiting');
  await owner.send('release');
  const closing = await owner.wait('finally-entered');
  assert.equal(closing.listening, true); assert.equal(closing.port, initialized.port);
  assert.deepEqual(await value.ownerBytes(resource), bytes);
  assert.equal(successor.records.some(record => record.event === 'acquired'), false);
  assert.equal(owner.records.some(record => record.event === 'after-finished'), false);
  await owner.send('finish-finally');
  const completed = await owner.wait('finally-completed');
  assert.equal(completed.listening, false); assert.equal(completed.portRebound, true); assert.equal(completed.fileOwnerClosed, true);
  await owner.wait('after-finished');
  assert.deepEqual(await owner.exited, { code: 1, signal: null, spawnError: null }, owner.output);
  assert.match(owner.output, /Controlled Native initialization failed before candidate registration\./u);
  assert.equal(owner.records.some(record => record.event === 'unexpected-body-started'), false);
  const admitted = await successor.wait('acquired');
  assert.equal(admitted.owner.pid, successor.pid); assert.notEqual(admitted.owner.token, initialized.owner.token);
  await assert.rejects(readFile(criticalFile), { code: 'ENOENT' });
  await successor.send('release'); await successor.wait('released'); await successor.finish(); await value.empty();
  t.diagnostic(JSON.stringify({ expectedInitializationFailure: true, owner: owner.records, successor: successor.records }));
});

test('a reverse-declared file waits for alpha without occupying beta needed by an independent consumer', { timeout: 30000 }, async t => {
  const value = await workspace(t), alpha = value.start({ resource: 'alpha' });
  await alpha.wait('acquired');
  const alphaBytes = await value.ownerBytes('alpha');
  const file = value.start({ resources: ['beta', 'alpha'], mode: 'group-auto', businessTimeout: 500,
    criticalFile: path.join(value.directory, 'file-critical') }, { filename: fileTestResourceChildFilename });
  const blocked = await file.wait('waiting');
  assert.equal(blocked.owner.resource, 'alpha'); assert.equal(blocked.owner.pid, alpha.pid);
  const betaCritical = path.join(value.directory, 'beta-critical');
  const beta = value.start({ resource: 'beta', criticalFile: betaCritical }), admittedBeta = await beta.wait('acquired');
  assert.equal(admittedBeta.owner.pid, beta.pid);
  assert.equal(JSON.parse(await readFile(betaCritical, 'utf8')).pid, beta.pid);
  assert.deepEqual(await value.ownerBytes('alpha'), alphaBytes);
  assert.equal(file.records.some(record => record.event === 'body-started'), false);
  await beta.send('release'); await beta.wait('released'); await beta.finish();
  await alpha.send('release'); await alpha.wait('released'); await alpha.finish();
  const admittedFile = await file.wait('body-started');
  for (const { owner } of admittedFile.owners) assert.equal(owner.pid, file.pid);
  await file.wait('body-finished'); await file.wait('after-finished'); await file.finish(); await value.empty();
  await assert.rejects(readFile(path.join(value.directory, 'file-critical')), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ alpha: alpha.records, beta: beta.records, file: file.records }));
});

test('opposite file declaration sets normalize root aliases and serialize complete real critical operations', { timeout: 30000 }, async t => {
  const value = await workspace(t), otherRoot = path.join(value.directory, 'other-leases');
  const aliasRoot = value.root + path.sep + '..' + path.sep + path.basename(value.root);
  const declarations = [{ key: 'gamma', root: otherRoot }, { key: 'beta' }, { key: 'alpha', root: aliasRoot }, { key: 'alpha' }];
  const criticalFile = path.join(value.directory, 'group-critical');
  const first = value.start({ resources: declarations, mode: 'group', criticalFile }, { filename: fileTestResourceChildFilename });
  const firstBody = await first.wait('body-started');
  for (const declaration of firstBody.owners) {
    const actual = JSON.parse(await readFile(path.join(declaration.root, declaration.key, 'owner.json'), 'utf8'));
    assert.equal(actual.pid, first.pid); assert.equal(actual.token, declaration.owner.token);
  }
  assert.equal(firstBody.owners[2].owner.token, firstBody.owners[3].owner.token);
  const second = value.start({ resources: declarations.toReversed(), mode: 'group', criticalFile }, { filename: fileTestResourceChildFilename });
  const waiting = await second.wait('waiting'); assert.equal(waiting.owner.pid, first.pid);
  assert.equal(JSON.parse(await readFile(criticalFile, 'utf8')).pid, first.pid);
  assert.equal(second.records.some(record => record.event === 'body-started'), false);
  await first.send('release'); await first.wait('body-finished'); await first.wait('after-finished');
  const secondBody = await second.wait('body-started');
  for (const declaration of secondBody.owners) {
    const actual = JSON.parse(await readFile(path.join(declaration.root, declaration.key, 'owner.json'), 'utf8'));
    assert.equal(actual.pid, second.pid); assert.equal(actual.token, declaration.owner.token);
    const previous = firstBody.owners.find(item => path.resolve(item.root) === path.resolve(declaration.root) && item.key === declaration.key);
    assert.notEqual(actual.token, previous.owner.token);
  }
  assert.equal(JSON.parse(await readFile(criticalFile, 'utf8')).pid, second.pid);
  await first.finish();
  await second.send('release'); await second.wait('body-finished'); await second.wait('after-finished'); await second.finish();
  await value.empty(); assert.deepEqual(await readdir(otherRoot), []);
  await assert.rejects(readFile(criticalFile), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ first: first.records, second: second.records }));
});

test('cancelled or failed group admission releases its real prefix and preserves every falsy primary', { timeout: 30000 }, async t => {
  const value = await workspace(t), owner = value.start({ resource: 'omega' });
  await owner.wait('acquired'); const ownerBytes = await value.ownerBytes('omega');
  for (const scenario of [{ cancel: true, primary: 0 }, { primary: undefined }, { primary: null }, { primary: false }, { primary: 0 }, { primary: '' }]) {
    const controller = new AbortController(); let observedPrefix = false;
    await assert.rejects(acquireTestResources([{ key: 'omega', root: value.root, onWait: async () => {
      assert.equal(JSON.parse(await value.ownerBytes('alpha')).pid, process.pid);
      assert.equal(JSON.parse(await value.ownerBytes('beta')).pid, process.pid);
      observedPrefix = true;
      if (scenario.cancel) controller.abort(scenario.primary); else throw scenario.primary;
    } }, { key: 'beta', root: value.root }, { key: 'alpha', root: value.root }], { signal: controller.signal }), error => {
      assert.equal(error, scenario.primary); return true;
    });
    assert.equal(observedPrefix, true);
    assert.deepEqual(await value.ownerBytes('omega'), ownerBytes);
    assert.deepEqual(await readdir(value.root), ['omega']);
  }
  await owner.send('release'); await owner.wait('released'); await owner.finish(); await value.empty();
});

test('failed group rollback retains its falsy primary followed by reverse release failures and preserves foreign receipts', { timeout: 30000 }, async t => {
  const value = await workspace(t), owner = value.start({ resource: 'omega' });
  const acquired = await owner.wait('acquired'), ownerBytes = await value.ownerBytes('omega');
  const replacements = new Map(), controller = new AbortController();
  await assert.rejects(acquireTestResources([{ key: 'omega', root: value.root, onWait: async () => {
    for (const key of ['alpha', 'beta']) {
      assert.equal(JSON.parse(await value.ownerBytes(key)).pid, process.pid);
      const bytes = Buffer.from(JSON.stringify({ ...acquired.owner, resource: key }) + '\n');
      replacements.set(key, bytes);
      await writeFile(path.join(value.root, key, 'owner.json'), bytes);
    }
    controller.abort(false);
  } }, { key: 'beta', root: value.root }, { key: 'alpha', root: value.root }], { signal: controller.signal }), error => {
    assert.equal(error.cause, false); assert.equal(error.errors[0], false);
    assert.deepEqual(error.errors.slice(1).map(item => ({ code: item.code, resource: item.resource })), [
      { code: 'test-resource-owner-mismatch', resource: 'beta' }, { code: 'test-resource-owner-mismatch', resource: 'alpha' },
    ]);
    return true;
  });
  for (const [key, bytes] of replacements) assert.deepEqual(await value.ownerBytes(key), bytes);
  assert.deepEqual(await value.ownerBytes('omega'), ownerBytes);
  await owner.send('release'); await owner.wait('released'); await owner.finish();
  // These private receipts intentionally replaced the original owners. Retire
  // them only after proving preservation and the foreign process's real exit.
  for (const key of replacements.keys()) {
    await unlink(path.join(value.root, key, 'owner.json')); await rmdir(path.join(value.root, key));
  }
  await value.empty();
});
