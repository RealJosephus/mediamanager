import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, StorageError } from '../../src/storage/index.js';
import { vfsStreamResult } from '../../src/http/binary-result.js';
import { createTestApplication } from '../helpers/application.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const payload = Buffer.from('0123456789'.repeat(7));
const itemId = 'f9b10000000000000000000000000001';
const failurePayload = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(failurePayload);
  const keys = value instanceof Error ? Object.getOwnPropertyNames(value).filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, failurePayload(value[key])]));
};
const closeServer = server => server?.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined;

async function fixture(t) {
  const output = path.resolve(validationOutputRoot()); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'binary-result-'));
  const filename = path.join(root, 'source.bin');
  const registry = new StorageRegistry(), diagnostics = [], sends = [];
  let application, faults = { failRead: false, failClose: false };
  t.after(async () => {
    const errors = [];
    for (const operation of [() => application?.beginClose(), () => application?.server.closeAllConnections(),
      () => application?.drainRequests(), () => closeServer(application?.server), () => registry.close(), async () => {
        assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('binary-result-'));
        await rm(root, { recursive: true, force: true });
      }]) try { await operation(); } catch (error) { errors.push(error); }
    t.diagnostic(inspect({ diagnostics, sends }, { depth: null }));
    if (errors.length) throw new AggregateError(errors, 'Binary response fixture cleanup failed.', { cause: errors[0] });
  });
  await writeFile(filename, payload);
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('source', 'local', { root });
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/media', instanceId: 'source', capabilities: {} });
  const openResponse = vfs.openResponse.bind(vfs);
  vfs.openResponse = async (access, options) => {
    const selected = faults, handle = await openResponse(access, options);
    return { ...handle, contentLength: handle.size,
      headers: { ...handle.headers, 'content-length': String(handle.size), 'content-type': 'application/x-binary-fixture',
        'content-language': 'fr-FR', etag: handle.version, 'x-upstream-result': 'source metadata' },
      stream: selected.failRead ? (async function* () {
        for await (const chunk of handle.stream) {
          // Pull actual local-file bytes before failing the public iterator.
          if (selected.position === 'first') throw selected.readFailure;
          yield chunk.subarray(0, 1);
          await selected.readRelease;
          if (selected.position === 'abort' && !options.signal.aborted) await once(options.signal, 'abort');
          throw selected.readFailure;
        }
      })() : handle.stream,
      async close() {
        selected.closeEntered?.resolve(options.signal);
        await selected.closeRelease;
        await handle.close(); if (selected.failClose) throw selected.closeFailure;
      },
    };
  };
  application = await createTestApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    playback: { file: () => {
      const result = vfsStreamResult(vfs, '/media/source.bin', { filename: 'source.bin' }), send = result.send.bind(result);
      result.send = async (...args) => {
        try { const value = await send(...args); sends.push({ failed: false }); return value; }
        catch (reason) { sends.push({ failed: true, reason }); throw reason; }
      };
      return result;
    } },
    authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
    onError: (error, context) => diagnostics.push({ error, phase: context?.phase }),
  });
  application.server.prependListener('request', (_request, response) => response.setHeader('X-Outer-Result', 'retained'));
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening', { signal: t.signal });
  const url = `http://127.0.0.1:${application.server.address().port}/Videos/${itemId}/stream.bin?static=true`;
  const request = async ({ range = 'bytes=2-4', method = 'GET' } = {}) => {
    const firstDiagnostic = diagnostics.length, firstSend = sends.length, result = {};
    try {
      const response = await fetch(url, { method, headers: range ? { Range: range } : {},
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(10000)]) });
      result.status = response.status; result.headers = Object.fromEntries(response.headers);
      result.bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) { result.transportError = error; }
    await application.drainRequests();
    result.diagnostics = diagnostics.slice(firstDiagnostic);
    result.sends = sends.slice(firstSend);
    return result;
  };
  return { request, url, diagnostics, sends, vfs, application,
    setFaults(value = {}) { faults = { failRead: false, failClose: false, position: 'first', ...value }; },
    async verifyRecovered() {
      faults = { failRead: false, failClose: false };
      const recovered = await request({ range: null });
      assert.equal(recovered.status, 200, JSON.stringify(failurePayload(recovered.transportError)));
      assert.deepEqual(recovered.bytes, payload);
      const partial = await request();
      assert.equal(partial.status, 206, JSON.stringify(failurePayload(partial.transportError)));
      assert.equal(partial.headers['content-range'], `bytes 2-4/${payload.length}`);
      assert.deepEqual(partial.bytes, payload.subarray(2, 5));
      assert.deepEqual(await readFile(filename), payload);
    },
    async closeStorage() { await registry.close(); await assert.rejects(vfs.openResponse('/media/source.bin'), { code: 'closed' }); },
  };
}

const readReasons = () => [
  ['error', Object.assign(new Error('The actual source iterator failed.', { cause: new Error('The local read was interrupted.') }), { code: 'unavailable', status: 503 }), 503],
  ['status-code', Object.assign(new Error('The source supplied an explicit response status.', { cause: new Error('The source refused delivery.') }), { code: 'timeout', statusCode: 509 }), 509],
  ['false', false, 502], ['zero', 0, 502], ['undefined', undefined, 502], ['null', null, 502],
];
const closeReason = () => Object.assign(new Error('The source close failed after releasing the actual file.', { cause: new Error('The read owner was released.') }),
  { code: 'close-failed', status: 507 });
const sendError = result => result.sends.find(value => value.failed)?.reason;
function assertErrorResponse(result, status) {
  assert.equal(result.status, status);
  assert.equal(result.bytes?.toString(), 'Error processing request.');
  assert.equal(result.headers['content-language'], 'en-US');
  assert.equal(result.headers['x-outer-result'], 'retained');
  for (const name of ['content-range', 'accept-ranges', 'content-disposition', 'etag', 'x-upstream-result']) assert.equal(result.headers[name], undefined, name);
  assert.notEqual(result.headers['content-length'], '3');
  assert.match(result.headers['content-type'], /^text\/plain/u);
}

test('first-pull binary failures retain the read and close reasons and release unpublished source headers', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const [kind, readFailure, status] of readReasons()) await t.test(kind, async () => {
    const closeFailure = closeReason(); owned.setFaults({ failRead: true, readFailure, failClose: true, closeFailure });
    const result = await owned.request(); assertErrorResponse(result, status);
    const observed = sendError(result);
    assert.deepEqual(observed.errors.map(failurePayload), [readFailure, closeFailure].map(failurePayload));
    assert.equal(Object.hasOwn(observed, 'cause'), true); assert.deepEqual(failurePayload(observed.cause), failurePayload(readFailure));
    if (readFailure && typeof readFailure === 'object') {
      assert.equal(observed.code, readFailure.code);
      assert.equal(observed.status, status); assert.equal(observed.statusCode, readFailure.statusCode);
    }
    await owned.verifyRecovered();
  });
  await owned.closeStorage();
});

test('a solitary binary read rejection retains its original reason and complete HTTP error body', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const [kind, readFailure, status] of readReasons()) await t.test(kind, async () => {
    owned.setFaults({ failRead: true, readFailure });
    const result = await owned.request(); assertErrorResponse(result, status);
    const observed = sendError(result);
    if (readFailure && typeof readFailure === 'object') assert.deepEqual(failurePayload(observed), failurePayload(readFailure));
    else { assert.equal(Object.hasOwn(observed, 'cause'), true); assert.equal(observed.cause, readFailure); }
    await owned.verifyRecovered();
  });
});

test('range rejection metadata survives a simultaneous source close failure', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const failClose of [false, true]) await t.test(failClose ? 'close-failure' : 'closed', async () => {
    const readFailure = new StorageError('range-not-satisfiable', 'The opened source rejected the range while reading.',
      { totalSize: BigInt(payload.length), contentType: 'application/x-source-range', acceptRanges: 'none' });
    const closeFailure = closeReason(); owned.setFaults({ failRead: true, readFailure, failClose, closeFailure });
    const result = await owned.request();
    assert.equal(result.status, 416); assert.equal(result.headers['content-range'], `bytes */${payload.length}`);
    assert.equal(result.headers['content-type'], readFailure.details.contentType);
    assert.equal(result.headers['accept-ranges'], readFailure.details.acceptRanges);
    assert.equal(result.headers['content-length'], '0'); assert.equal(result.bytes.length, 0);
    assert.equal(result.headers['content-language'], 'en-US'); assert.equal(result.headers['x-outer-result'], 'retained');
    // An unsatisfied file range retains the selected attachment name.
    assert.equal(result.headers['content-disposition'], "attachment; filename=source.bin; filename*=UTF-8''source.bin");
    for (const name of ['etag', 'x-upstream-result']) assert.equal(result.headers[name], undefined, name);
    if (failClose) {
      const observed = sendError(result);
      assert.equal(observed.code, readFailure.code);
      assert.deepEqual(observed.errors.map(failurePayload), [readFailure, closeFailure].map(failurePayload));
      assert.deepEqual(failurePayload(observed.cause), failurePayload(readFailure));
    }
    await owned.verifyRecovered();
  });
  await owned.closeStorage();
});

test('a solitary binary close failure preserves its reason after publication and HEAD closes the unread file', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const [kind, closeFailure] of [['error', closeReason()], ['false', false], ['zero', 0], ['undefined', undefined]]) await t.test(kind, async () => {
    owned.setFaults({ failClose: true, closeFailure });
    const result = await owned.request(), observed = sendError(result);
    if (closeFailure && typeof closeFailure === 'object') assert.deepEqual(failurePayload(observed), failurePayload(closeFailure));
    else { assert.equal(Object.hasOwn(observed, 'cause'), true); assert.equal(observed.cause, closeFailure); }
    if (result.status !== undefined) assert.equal(result.status, 206);
    if (result.bytes) assert.deepEqual(result.bytes, payload.subarray(2, 5)); else assert.ok(result.transportError);
    await owned.verifyRecovered();
  });
  owned.setFaults({ failRead: true, readFailure: new Error('HEAD must not pull the stream.') });
  const head = await owned.request({ method: 'HEAD' });
  assert.equal(head.status, 206); assert.equal(head.headers['content-length'], '3'); assert.equal(head.bytes.length, 0);
  owned.setFaults();
  const outside = await owned.request({ range: 'bytes=100-' });
  assert.equal(outside.status, 416); assert.equal(outside.headers['content-range'], `bytes */${payload.length}`);
  assert.equal(outside.headers['content-disposition'], "attachment; filename=source.bin; filename*=UTF-8''source.bin");
  assert.equal(outside.headers['content-length'], '0'); assert.equal(outside.bytes.length, 0);
  await owned.verifyRecovered(); await owned.closeStorage();
});

test('published binary failures and caller abort keep the destroy contract while exposing a failed cleanup', { timeout: 30000 }, async t => {
  const owned = await fixture(t);
  for (const position of ['after', 'abort']) for (const failClose of [false, true]) await t.test(`${position}/${failClose ? 'close-failure' : 'closed'}`, async () => {
    const readFailure = Object.assign(new StorageError(position === 'abort' ? 'cancelled' : 'unavailable', 'Controlled source read termination.'), { status: 503 });
    const closeFailure = closeReason();
    owned.setFaults({ failRead: true, readFailure, failClose, closeFailure, position });
    let result;
    if (position === 'abort') {
      const firstDiagnostic = owned.diagnostics.length, firstSend = owned.sends.length, controller = new AbortController();
      try {
        const response = await fetch(owned.url, { headers: { Range: 'bytes=2-4' }, signal: AbortSignal.any([t.signal, controller.signal]) });
        assert.equal(response.status, 206);
        const reader = response.body.getReader(), first = await reader.read(); assert.deepEqual(Buffer.from(first.value), payload.subarray(2, 3));
        controller.abort(); await reader.cancel().catch(() => {});
      } finally { controller.abort(); }
      await owned.application.drainRequests(); result = { diagnostics: owned.diagnostics.slice(firstDiagnostic), sends: owned.sends.slice(firstSend) };
    } else {
      result = await owned.request(); assert.ok(result.transportError);
      if (result.status !== undefined) assert.equal(result.status, 206);
    }
    if (failClose) {
      const observed = sendError(result);
      assert.deepEqual(observed.errors.map(failurePayload), [readFailure, closeFailure].map(failurePayload));
      assert.deepEqual(failurePayload(observed.cause), failurePayload(readFailure)); assert.equal(observed.status, 503); assert.equal(observed.code, readFailure.code);
    }
    await owned.verifyRecovered();
  });
});

test('a published binary read failure closes the client before a held source cleanup completes', { timeout: 30000 }, async t => {
  const owned = await fixture(t), readRelease = Promise.withResolvers(), closeEntered = Promise.withResolvers(), closeRelease = Promise.withResolvers();
  const readFailure = Object.assign(new Error('The opened source failed after its first bytes.'), { code: 'unavailable', status: 503 });
  const closeFailure = closeReason(), firstSend = owned.sends.length;
  owned.setFaults({ failRead: true, readFailure, failClose: true, closeFailure, position: 'after',
    readRelease: readRelease.promise, closeEntered, closeRelease: closeRelease.promise });
  try {
    const response = await fetch(owned.url, { headers: { Range: 'bytes=2-4' }, signal: t.signal });
    assert.equal(response.status, 206);
    const reader = response.body.getReader(), first = await reader.read();
    assert.deepEqual(Buffer.from(first.value), payload.subarray(2, 3));
    const disconnected = assert.rejects(reader.read());
    readRelease.resolve();
    const sourceSignal = await closeEntered.promise;
    await disconnected;
    assert.equal(sourceSignal.aborted, true, 'The source must receive cancellation before its cleanup waits.');
  } finally {
    readRelease.resolve(); closeRelease.resolve();
    await owned.application.drainRequests();
  }
  const observed = sendError({ sends: owned.sends.slice(firstSend) });
  assert.deepEqual(observed.errors.map(failurePayload), [readFailure, closeFailure].map(failurePayload));
  assert.deepEqual(failurePayload(observed.cause), failurePayload(readFailure));
  await owned.verifyRecovered(); await owned.closeStorage();
});
