import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { StorageError } from '../../src/storage/errors.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
async function pending(operation) {
  let settled = false;
  void Promise.resolve(operation).then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The actual resource cleanup must finish before its owner.');
}
async function server(t, handler) {
  const service = http.createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(() => response.destroy());
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
  return `http://127.0.0.1:${service.address().port}/`;
}
const json = (response, data = null) => {
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 200, data }));
};

test('AList close waits for an admitted credential or actual HTTP response and rejects new work', async t => {
  for (const held of ['credential', 'response']) await t.test(held, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let requests = 0;
    const baseUrl = await server(t, (_request, response) => { requests++; json(response, { name: 'file', is_dir: false, size: 4 }); });
    const adapter = new AListAdapter({ baseUrl, credentialRef: 'owned' }, {
      async resolveCredential() {
        if (held === 'credential') { entered.resolve(); await release.promise; }
        return 'owned-token';
      },
      async fetch(url, options) {
        const response = await fetch(url, options);
        if (held === 'response') { entered.resolve(); await release.promise; }
        return response;
      },
    });
    t.after(async () => { release.resolve(); await adapter.close(); });
    const operation = outcome(adapter.stat('/file')); await entered.promise;
    const closing = adapter.close(); assert.equal(adapter.close(), closing);
    await pending(closing); await pending(operation);
    await assert.rejects(adapter.stat('/late'), { code: 'closed' });
    release.resolve(); await closing;
    assert.equal((await operation).error.code, 'cancelled');
    assert.equal(requests, held === 'credential' ? 0 : 1);
  });
});

test('AList registry close joins unread and partially consumed HTTP reader cleanup', async t => {
  for (const consumed of [false, true]) await t.test(consumed ? 'partial' : 'unread', async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), disconnected = Promise.withResolvers();
    let baseUrl, cancellations = 0;
    baseUrl = await server(t, (request, response) => {
      if (request.url === '/api/fs/get') return json(response, { name: 'file', is_dir: false, size: 1000000, raw_url: baseUrl + 'raw' });
      request.once('close', disconnected.resolve);
      response.writeHead(200, { 'Content-Length': '1000000' }); response.write(Buffer.alloc(1024, 0x61));
    });
    const adapter = new AListAdapter({ baseUrl }, { async fetch(url, options) {
      const response = await fetch(url, options);
      if (new URL(url).pathname === '/raw') {
        const delay = (target, method) => {
          const original = target[method].bind(target);
          target[method] = async (...args) => { cancellations++; entered.resolve(); await release.promise; return original(...args); };
        };
        if (!consumed) delay(response.body, 'cancel');
        else {
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...args) => { const reader = getReader(...args); delay(reader, 'cancel'); return reader; };
        }
      }
      return response;
    } });
    const registry = new StorageRegistry();
    registry.registerType('alist', () => adapter); await registry.createInstance('remote', 'alist', {});
    let handle;
    t.after(async () => { release.resolve(); await registry.close(); await handle?.close(); });
    handle = await adapter.openRead('/file');
    if (consumed) assert.equal((await handle.stream.next()).done, false);
    const closing = registry.close(); await entered.promise;
    const readClosing = handle.close(); assert.equal(handle.close(), readClosing);
    await pending(closing); await pending(readClosing);
    release.resolve(); await closing; await readClosing; await disconnected.promise;
    assert.equal(cancellations, 1);
    await handle.stream.return();
    await assert.rejects(adapter.openRead('/late'), { code: 'closed' });
  });
});

test('AList truncated downloads release the actual HTTP reader and retain independent cleanup failures', { timeout: 90000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'alist-read-ownership-'));
  const cases = [{ name: 'transport-only' }, ...[['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]]
    .map(([name, reason]) => ({ name: 'independent-' + name, readReason: reason, cleanupReason: reason }))];
  for (const key of ['message', 'code', 'details', 'status', 'statusCode']) {
    const primary = Object.assign(new StorageError('invalid-response', 'The typed reader failed.', { operation: 'read' }), { status: 409, statusCode: 503 });
    Object.defineProperty(primary, key, { get() { throw new Error('The primary diagnostic is unavailable.'); } });
    const cleanup = new StorageError('unavailable', 'The reader cleanup failed.');
    Object.defineProperty(cleanup, 'name', { get() { throw new Error('The cleanup diagnostic is unavailable.'); } });
    cases.push({ name: 'getter-' + key, key, readReason: Object.freeze(primary), cleanupReason: Object.freeze(cleanup) });
  }
  for (const fault of cases) await t.test(fault.name, async t => {
    const cancelEntered = Promise.withResolvers(), releaseCancel = Promise.withResolvers(), disconnected = Promise.withResolvers();
    const prefix = Buffer.from('actual AList HTTP bytes'), recovered = Buffer.from('AList HTTP read recovered');
    let baseUrl, rawResponse, body, transportFailure, nativeCancelFailure, cancels = 0, reads = 0;
    const hasCleanup = Object.hasOwn(fault, 'cleanupReason');
    baseUrl = await server(t, (request, response) => {
      if (request.url === '/api/fs/get') {
        return json(response, { name: 'file', is_dir: false, size: 1000000, raw_url: baseUrl + (rawResponse ? 'recovered' : 'truncated') });
      }
      if (request.url === '/recovered') {
        response.writeHead(200, { 'Content-Length': recovered.length }); response.end(recovered); return;
      }
      rawResponse = response;
      response.socket.once('close', disconnected.resolve);
      response.writeHead(200, { 'Content-Length': '1000000' }); response.write(prefix);
    });
    const adapter = new AListAdapter({ baseUrl }, { async fetch(url, options) {
      const response = await fetch(url, options);
      if (new URL(url).pathname !== '/truncated') return response;
      body = response.body;
      const getReader = body.getReader.bind(body);
      body.getReader = (...args) => {
        const reader = getReader(...args), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
        reader.read = async () => {
          reads++;
          try { return await read(); }
          catch (error) { transportFailure = error; throw hasCleanup ? fault.readReason : error; }
        };
        reader.cancel = async () => {
          cancels++;
          try { await cancel(); }
          catch (error) { nativeCancelFailure = error; }
          cancelEntered.resolve(); await releaseCancel.promise;
          if (hasCleanup) throw fault.cleanupReason;
          throw nativeCancelFailure;
        };
        return reader;
      };
      return response;
    } });
    const fresh = new AListAdapter({ baseUrl });
    let handle;
    t.after(async () => {
      releaseCancel.resolve();
      await Promise.allSettled([handle?.close(), adapter.close()]);
      await fresh.close();
    });
    handle = await adapter.openRead('/truncated');
    const first = (await handle.stream.next()).value;
    assert.deepEqual(Buffer.from(first), prefix);
    const reading = outcome(handle.stream.next());
    rawResponse.destroy(); await disconnected.promise; await cancelEntered.promise;
    assert.ok(transportFailure instanceof Error); assert.equal(nativeCancelFailure, transportFailure);
    assert.equal(body.locked, true);
    const closing = adapter.close(), readClosing = handle.close();
    assert.equal(adapter.close(), closing); assert.equal(handle.close(), readClosing);
    const owner = outcome(closing), cleanup = outcome(readClosing);
    await pending(owner); await pending(reading);
    releaseCancel.resolve();
    const failure = (await reading).error, ownerResult = await owner, cleanupResult = await cleanup;
    assert.equal(body.locked, false); assert.equal(cancels, 1); assert.equal(reads, 2);
    assert.equal(failure.code, fault.key && fault.key !== 'code' ? 'invalid-response' : 'unavailable');
    if (!hasCleanup) {
      assert.equal(failure.cause, transportFailure); assert.equal(failure.errors, undefined);
      assert.ok(Object.hasOwn(ownerResult, 'value')); assert.ok(Object.hasOwn(cleanupResult, 'value'));
    } else {
      assert.equal(failure.errors.length, 2);
      assert.equal(failure.cause.cause, failure.errors[0]);
      if (fault.key) {
        assert.equal(failure.errors[0], fault.readReason); assert.equal(failure.errors[1], fault.cleanupReason);
        assert.equal(failure.status, fault.key === 'status' ? undefined : 409);
        assert.equal(failure.statusCode, fault.key === 'statusCode' ? undefined : 503);
        assert.equal(failure.details.operation, fault.key === 'details' ? undefined : 'read');
      } else {
        assert.equal(failure.errors[0].cause, fault.readReason); assert.equal(failure.errors[1].cause, fault.cleanupReason);
      }
      assert.equal(cleanupResult.error, failure.errors[1]); assert.equal(ownerResult.error, cleanupResult.error);
    }
    const followup = await fresh.openRead('/recovered');
    const chunks = [];
    try { for await (const chunk of followup.stream) chunks.push(chunk); }
    finally { await followup.close(); }
    assert.deepEqual(Buffer.concat(chunks), recovered);
    await fs.writeFile(path.join(root, fault.name + '.json'), JSON.stringify({ case: fault.name, reads, cancels,
      socketClosed: rawResponse.destroyed, lockReleased: !body.locked, sameTransportError: nativeCancelFailure === transportFailure,
      primaryCode: failure.code, cleanupFailures: failure.errors?.length ? failure.errors.length - 1 : 0,
      recoveredBytes: recovered.length }) + '\n');
  });
});

test('AList joins the actual HTTP responses discarded before following links', { timeout: 90000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'alist-discard-ownership-'));
  const cases = [
    { name: 'expired-link', status: 403, code: 'permission-denied', reason: undefined },
    { name: 'missing-location', status: 302, code: 'invalid-response', reason: false },
    { name: 'locked-redirect', status: 302, code: 'unavailable', locked: true, location: '/unexpected' },
  ];
  for (const fault of cases) await t.test(fault.name, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), disconnected = Promise.withResolvers();
    const recovered = Buffer.from('AList download after discarding a response'), requests = [];
    let baseUrl, heldSocket, reader, nativeCancelError, cancellations = 0, fresh;
    baseUrl = await server(t, (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === '/api/fs/get') {
        return json(response, { name: 'file', is_dir: false, size: recovered.length, raw_url: baseUrl + (heldSocket ? 'recovered' : 'discard') });
      }
      if (request.url === '/recovered') {
        response.writeHead(200, { 'Content-Length': recovered.length }); response.end(recovered); return;
      }
      if (request.url !== '/discard') { response.writeHead(500).end(); return; }
      heldSocket = response.socket;
      heldSocket.once('close', disconnected.resolve);
      if (fault.location) response.setHeader('Location', fault.location);
      if (fault.status === 403) response.setHeader('Retry-After', '4');
      response.writeHead(fault.status, { 'Content-Length': '1000000' }); response.write('response body still open');
    });
    const adapter = new AListAdapter({ baseUrl }, { async fetch(url, options) {
      const response = await fetch(url, options);
      if (new URL(url).pathname !== '/discard') return response;
      const cancel = response.body.cancel.bind(response.body);
      if (fault.locked) {
        reader = response.body.getReader();
        void reader.closed.catch(() => {});
      }
      response.body.cancel = async (...args) => {
        cancellations++;
        try { await cancel(...args); }
        catch (error) { nativeCancelError = error; throw error; }
        entered.resolve(); await release.promise;
        throw fault.reason;
      };
      return response;
    } });
    t.after(async () => {
      release.resolve(); reader?.releaseLock();
      if (fault.locked) await adapter.close();
      else await outcome(adapter.close());
      await fresh?.close();
    });

    const opening = outcome(adapter.openRead('/file'));
    let owner;
    if (!fault.locked) {
      await entered.promise;
      const closing = adapter.close(); owner = outcome(closing);
      assert.equal(adapter.close(), closing);
      await pending(owner); await pending(opening);
      release.resolve();
    }
    const { error } = await opening;
    await disconnected.promise;
    assert.equal(heldSocket.destroyed, true);
    assert.equal(cancellations, 1);
    assert.deepEqual(requests, ['POST /api/fs/get', 'GET /discard']);
    assert.equal(error.code, fault.code);
    if (fault.locked) {
      assert.ok(nativeCancelError instanceof TypeError);
      assert.equal(error.cause, nativeCancelError);
      assert.equal(error.errors, undefined);
      reader.releaseLock(); reader = undefined;
    } else {
      assert.equal(error.errors.length, 2);
      const [primary, cleanup] = error.errors;
      assert.equal(primary.code, fault.code);
      assert.equal(error.cause.cause, primary);
      assert.equal(cleanup.code, 'unavailable');
      assert.ok(Object.hasOwn(cleanup, 'cause'));
      assert.equal(cleanup.cause, fault.reason);
      assert.equal((await owner).error, cleanup);
      if (fault.status === 403) assert.deepEqual(error.details, { status: 403, operation: 'read', retryAfter: '4' });
      fresh = new AListAdapter({ baseUrl });
    }

    const handle = await (fresh ?? adapter).openRead('/file');
    const chunks = [];
    try { for await (const chunk of handle.stream) chunks.push(chunk); }
    finally { await handle.close(); }
    assert.deepEqual(Buffer.concat(chunks), recovered);
    await fs.writeFile(path.join(root, fault.name + '.json'), JSON.stringify({ case: fault.name, httpStatus: fault.status,
      primaryCode: error.code, cancellations, socketClosed: heldSocket.destroyed, requestsBeforeRecovery: 2,
      ownerRetainedCleanup: Boolean(owner), nativeCancelRejected: Boolean(nativeCancelError), recoveredBytes: recovered.length }) + '\n');
  });
});

async function uploadFixture(t, { complete = false, empty = false, reject = false, cleanup } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alist-upload-owner-'));
  const bytes = empty ? Buffer.alloc(0) : Buffer.alloc(131079, 0x85);
  const filename = path.join(root, 'source.bin'); await fs.writeFile(filename, bytes);
  const file = await fs.open(filename, 'r');
  const arrived = Promise.withResolvers(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const nextRelease = Promise.withResolvers(), disconnected = Promise.withResolvers();
  let returned = 0, position = 0, received = Buffer.alloc(0), responseComplete = false;
  const baseUrl = await server(t, async (request, response) => {
    request.once('close', disconnected.resolve);
    if (reject) { response.writeHead(403); response.end('The upload is forbidden.'); return; }
    for await (const chunk of request) {
      received = Buffer.concat([received, chunk]);
      if (received.length >= Math.min(65536, bytes.length)) arrived.resolve();
    }
    responseComplete = true; json(response);
  });
  const adapter = new AListAdapter({ baseUrl, capabilities: { create: true, replace: true } });
  const registry = new StorageRegistry(); registry.registerType('alist', () => adapter);
  await registry.createInstance('remote', 'alist', {});
  const source = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (!complete && position) return nextRelease.promise;
      const chunk = Buffer.alloc(65536);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position); position += bytesRead;
      return bytesRead ? { done: false, value: chunk.subarray(0, bytesRead) } : { done: true };
    },
    async return() {
      returned++; entered.resolve(); await release.promise;
      try { await file.close(); }
      finally { nextRelease.resolve({ done: true }); }
      if (cleanup) throw cleanup.reason;
      return { done: true };
    },
  };
  t.after(async () => {
    release.resolve(); nextRelease.resolve({ done: true });
    try { await registry.close(); } catch { /* The test observes the retained close failure. */ }
    await file.close(); assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true });
  });
  return { adapter, registry, source, bytes, arrived, entered, release, disconnected, file,
    observed: () => ({ returned, received, responseComplete }) };
}

test('AList upload cancellation and adapter or registry close wait for the actual source descriptor', async t => {
  for (const stop of ['caller', 'adapter', 'registry']) await t.test(stop, async t => {
    const f = await uploadFixture(t), controller = new AbortController();
    const operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length), signal: controller.signal }));
    await f.arrived.promise;
    if (stop === 'caller') controller.abort(new Error('The upload owner stopped.'));
    const closing = stop === 'registry' ? f.registry.close() : f.adapter.close();
    assert.equal(stop === 'registry' ? f.registry.close() : f.adapter.close(), closing);
    await f.entered.promise; await pending(operation); await pending(closing);
    assert.equal((await f.file.stat()).size, f.bytes.length);
    await assert.rejects(f.adapter.write('/late', Buffer.alloc(0)), { code: 'closed' });
    f.release.resolve(); await closing;
    assert.equal((await operation).error.code, 'cancelled');
    await assert.rejects(f.file.stat(), { code: 'EBADF' }); await f.disconnected.promise;
    assert.equal(f.observed().returned, 1);
    assert.deepEqual(f.observed().received, f.bytes.subarray(0, 65536));
  });
});

test('AList completed and zero-byte uploads also await source cleanup', async t => {
  for (const empty of [false, true]) await t.test(empty ? 'empty' : 'complete', async t => {
    const f = await uploadFixture(t, { complete: true, empty });
    const operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length) }));
    await f.entered.promise; await pending(operation);
    assert.equal(f.observed().responseComplete, true);
    assert.deepEqual(f.observed().received, f.bytes);
    f.release.resolve(); assert.equal((await operation).value.size, BigInt(f.bytes.length));
    await assert.rejects(f.file.stat(), { code: 'EBADF' });
    assert.equal(f.observed().returned, 1); await f.registry.close();
  });
});

test('AList early HTTP rejection retains its error and still waits for the upload producer', async t => {
  const f = await uploadFixture(t, { reject: true });
  const operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length) }));
  await f.entered.promise; await pending(operation);
  const closing = f.registry.close(); await pending(closing);
  f.release.resolve(); await closing;
  assert.equal((await operation).error.code, 'permission-denied');
  await assert.rejects(f.file.stat(), { code: 'EBADF' }); assert.equal(f.observed().returned, 1);
});

test('AList close retains upload cleanup failures without replacing the cancellation', async t => {
  for (const reason of [false, 0, '', null, undefined, new Error('The source cleanup failed.')]) await t.test(String(reason), async t => {
    const f = await uploadFixture(t, { cleanup: { reason } });
    const operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length) }));
    await f.arrived.promise; const closing = outcome(f.registry.close());
    await f.entered.promise; await pending(closing); f.release.resolve();
    const writeFailure = (await operation).error, closeFailure = (await closing).error;
    assert.equal(writeFailure.code, 'cancelled'); assert.equal(writeFailure.errors.length, 2);
    assert.equal(writeFailure.errors[0].code, 'cancelled');
    assert.equal(writeFailure.errors[1].cause, reason);
    assert.equal(closeFailure, writeFailure.errors[1]);
    await assert.rejects(f.file.stat(), { code: 'EBADF' }); assert.equal(f.observed().returned, 1);
  });
});
