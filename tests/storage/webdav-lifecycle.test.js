import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
const capabilities = { create: true, replace: true, mkdir: true };
async function pending(operation) {
  let settled = false;
  void Promise.resolve(operation).then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The owner must wait for actual resource cleanup.');
}
async function server(t, handler) {
  const service = http.createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(() => response.destroy());
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
  return `http://127.0.0.1:${service.address().port}/`;
}
function properties(request, response) {
  response.writeHead(207, { 'Content-Type': 'application/xml' });
  response.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${request.url}</d:href><d:propstat><d:prop>`
    + '<d:resourcetype/><d:getcontentlength>1000000</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status>'
    + '</d:propstat></d:response></d:multistatus>');
}
async function writeReadReport(name, observations) {
  const output = path.resolve(validationOutputRoot());
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'webdav-read-ownership-'));
  await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(observations) + '\n');
}

test('WebDAV close joins admitted credentials and actual PROPFIND responses', { timeout: 30000 }, async t => {
  for (const held of ['credential', 'response']) await t.test(held, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); let requests = 0;
    const baseUrl = await server(t, (request, response) => { requests++; properties(request, response); });
    const adapter = new WebDavAdapter({ baseUrl, credentialRef: 'owned' }, {
      async resolveCredential() {
        if (held === 'credential') { entered.resolve(); await release.promise; }
        return 'Basic b3duZWQ6b3duZWQ=';
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

test('WebDAV registry close joins unread and partially consumed actual HTTP bodies', { timeout: 30000 }, async t => {
  for (const consumed of [false, true]) await t.test(consumed ? 'partial' : 'unread', async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), disconnected = Promise.withResolvers();
    let body, socket, cancellations = 0;
    const baseUrl = await server(t, (request, response) => {
      if (request.method === 'PROPFIND') return properties(request, response);
      socket = response.socket; socket.once('close', disconnected.resolve);
      response.writeHead(200, { 'Content-Length': '1000000' }); response.write(Buffer.alloc(1024, 0x61));
    });
    const adapter = new WebDavAdapter({ baseUrl }, { async fetch(url, options) {
      const response = await fetch(url, options);
      if (options.method === 'GET') {
        body = response.body;
        const delay = target => {
          const cancel = target.cancel.bind(target);
          target.cancel = async (...args) => { cancellations++; entered.resolve(); await release.promise; return cancel(...args); };
        };
        if (!consumed) delay(response.body);
        else {
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...args) => { const reader = getReader(...args); delay(reader); return reader; };
        }
      }
      return response;
    } });
    const registry = new StorageRegistry(); registry.registerType('webdav', () => adapter);
    await registry.createInstance('remote', 'webdav', {}); let handle;
    t.after(async () => { release.resolve(); await registry.close(); await handle?.close(); });
    handle = await adapter.openRead('/file');
    if (consumed) assert.equal((await handle.stream.next()).done, false);
    assert.equal(body.locked, consumed);
    const closing = registry.close(); await entered.promise;
    const readClosing = handle.close(); assert.equal(handle.close(), readClosing);
    await pending(closing); await pending(readClosing);
    release.resolve(); await closing; await readClosing; await disconnected.promise;
    assert.equal(body.locked, false); assert.equal(socket.destroyed, true);
    assert.equal(cancellations, 1); await handle.stream.return();
    await assert.rejects(adapter.openRead('/late'), { code: 'closed' });
    await writeReadReport(consumed ? 'partial' : 'unread', { consumed, cancellations, lockedAfterClose: body.locked,
      socketClosed: socket.destroyed });
  });
});

test('WebDAV truncated reads separate the stored transport error from an independent cancel failure', { timeout: 30000 }, async t => {
  for (const fault of [null, ...[false, 0, '', null, undefined, new Error('Read cleanup failed.')].map(reason => ({ reason })),
    ...[false, 0, '', null, undefined].map(reason => ({ reason, readReason: reason }))]) {
    await t.test(fault ? (Object.hasOwn(fault, 'readReason') ? 'read-and-cleanup/' : 'cleanup/') + String(fault.reason) : 'transport-only', async t => {
      const disconnected = Promise.withResolvers();
      let responseOwner, socket, body, transportFailure, cancelFailure;
      const baseUrl = await server(t, (request, response) => {
        if (request.method === 'PROPFIND') return properties(request, response);
        responseOwner = response;
        socket = response.socket; socket.once('close', disconnected.resolve);
        response.writeHead(200, { 'Content-Length': '1000000' }); response.write(Buffer.from('prefix'));
      });
      const adapter = new WebDavAdapter({ baseUrl }, { async fetch(url, options) {
        const response = await fetch(url, options);
        if (options.method === 'GET') {
          body = response.body;
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...args) => {
            const reader = getReader(...args), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
            reader.read = async (...values) => {
              try { return await read(...values); }
              catch (error) { transportFailure = error; throw fault && Object.hasOwn(fault, 'readReason') ? fault.readReason : error; }
            };
            reader.cancel = async (...values) => {
              try { await cancel(...values); } catch (error) { cancelFailure = error; if (!fault) throw error; }
              if (fault) throw fault.reason;
            };
            return reader;
          };
        }
        return response;
      } });
      t.after(() => outcome(adapter.close()));
      const handle = await adapter.openRead('/truncated');
      assert.equal(Buffer.from((await handle.stream.next()).value).toString(), 'prefix');
      responseOwner.destroy();
      const failure = (await outcome(handle.stream.next())).error;
      assert.equal(failure.code, 'unavailable'); assert.equal(cancelFailure, transportFailure);
      await disconnected.promise; assert.equal(socket.destroyed, true);
      assert.equal(body.locked, false);
      if (!fault) {
        assert.equal(failure.cause, transportFailure); assert.equal(failure.errors, undefined);
        await handle.close(); await adapter.close();
        await writeReadReport('truncated', { lockedAfterClose: body.locked, sameTransportError: cancelFailure === transportFailure,
          socketClosed: socket.destroyed });
      } else {
        assert.equal(failure.errors[0].cause, Object.hasOwn(fault, 'readReason') ? fault.readReason : transportFailure);
        assert.equal(failure.errors[1].cause, fault.reason);
        assert.equal((await outcome(handle.close())).error, failure.errors[1]);
        assert.equal((await outcome(adapter.close())).error.errors[0], failure.errors[1]);
      }
    });
  }
});

test('WebDAV aborts an actual response when cancellation fails before the read opens', { timeout: 30000 }, async t => {
  const disconnected = Promise.withResolvers();
  const recovered = Buffer.from('WebDAV read after discarding a response'), requests = [];
  let socket, reader, cancellations = 0;
  const baseUrl = await server(t, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'PROPFIND') return properties(request, response);
    if (request.url === '/recovered') {
      response.writeHead(200, { 'Content-Length': recovered.length }); response.end(recovered); return;
    }
    if (request.url !== '/rejected') { response.writeHead(500).end(); return; }
    socket = response.socket; socket.once('close', disconnected.resolve);
    response.writeHead(302, { Location: '/unexpected', 'Content-Length': '1000000' });
    response.write('response body still open');
  });
  const adapter = new WebDavAdapter({ baseUrl }, { async fetch(url, options) {
    const response = await fetch(url, options);
    if (options.method === 'GET' && new URL(url).pathname === '/rejected') {
      const cancel = response.body.cancel.bind(response.body);
      reader = response.body.getReader();
      void reader.closed.catch(() => {});
      response.body.cancel = (...args) => { cancellations++; return cancel(...args); };
    }
    return response;
  } });
  t.after(async () => { reader?.releaseLock(); await outcome(adapter.close()); });

  const { error } = await outcome(adapter.openRead('/rejected'));
  assert.equal(error.code, 'invalid-response');
  assert.equal(error.errors.length, 2);
  const [primary, cleanup] = error.errors;
  assert.equal(error.cause.cause, primary); assert.equal(primary.code, 'invalid-response');
  assert.equal(cleanup.code, 'unavailable'); assert.ok(cleanup.cause instanceof TypeError);
  await disconnected.promise;
  assert.equal(socket.destroyed, true); assert.equal(cancellations, 1);
  assert.deepEqual(requests, ['PROPFIND /rejected', 'GET /rejected']);

  const handle = await adapter.openRead('/recovered'), chunks = [];
  try { for await (const chunk of handle.stream) chunks.push(chunk); }
  finally { await handle.close(); }
  assert.deepEqual(Buffer.concat(chunks), recovered);
  const closing = adapter.close(); assert.equal(adapter.close(), closing);
  const ownerFailure = (await outcome(closing)).error;
  assert.deepEqual(ownerFailure.errors, [cleanup]);
  await writeReadReport('failed-open', { primaryCode: error.code, cleanupCode: cleanup.code, cancellations,
    socketClosed: socket.destroyed, ownerRetainedCleanup: ownerFailure.errors[0] === cleanup, recoveredBytes: recovered.length });
});

async function uploadFixture(t, { complete = false, empty = false, reject = false, cleanup } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webdav-upload-owner-'));
  const bytes = empty ? Buffer.alloc(0) : Buffer.alloc(131079, 0x85);
  const filename = path.join(root, 'source.bin'); await fs.writeFile(filename, bytes);
  const file = await fs.open(filename, 'r');
  const arrived = Promise.withResolvers(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const nextRelease = Promise.withResolvers(), disconnected = Promise.withResolvers();
  let returned = 0, position = 0, received = Buffer.alloc(0), responseComplete = false;
  const baseUrl = await server(t, async (request, response) => {
    response.once('close', disconnected.resolve);
    if (reject) { response.writeHead(403); response.end('The upload is forbidden.'); return; }
    for await (const chunk of request) {
      received = Buffer.concat([received, chunk]);
      if (received.length >= Math.min(65536, bytes.length)) arrived.resolve();
    }
    responseComplete = true; response.writeHead(204); response.end();
  });
  const adapter = new WebDavAdapter({ baseUrl, capabilities });
  const registry = new StorageRegistry(); registry.registerType('webdav', () => adapter);
  await registry.createInstance('remote', 'webdav', {});
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
      await file.close(); nextRelease.resolve({ done: true });
      if (cleanup) throw cleanup.reason;
      return { done: true };
    },
  };
  t.after(async () => {
    release.resolve(); nextRelease.resolve({ done: true }); await outcome(registry.close()); await file.close();
    assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true });
  });
  return { adapter, registry, source, bytes, arrived, entered, release, disconnected, file,
    observed: () => ({ returned, received, responseComplete }) };
}

test('WebDAV ordinary PUT cancellation joins the actual source FD and repeated close', { timeout: 30000 }, async t => {
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

test('WebDAV completed, empty and rejected ordinary PUTs still close their real producers', { timeout: 30000 }, async t => {
  for (const mode of ['complete', 'empty', 'rejected']) await t.test(mode, async t => {
    const reject = mode === 'rejected', f = await uploadFixture(t, { complete: !reject, empty: mode === 'empty', reject });
    const operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length) }));
    await f.entered.promise; await pending(operation);
    if (!reject) { assert.equal(f.observed().responseComplete, true); assert.deepEqual(f.observed().received, f.bytes); }
    f.release.resolve(); const result = await operation;
    if (reject) assert.equal(result.error.code, 'permission-denied');
    else assert.equal(result.value.size, BigInt(f.bytes.length));
    await assert.rejects(f.file.stat(), { code: 'EBADF' });
    assert.equal(f.observed().returned, 1); await f.registry.close();
  });
});

test('WebDAV keeps original failures and falsy cleanup rejections after actual network and FD release', { timeout: 30000 }, async t => {
  for (const resource of ['source', 'response']) for (const reason of [false, 0, '', null, undefined, new Error('Cleanup failed.')]) {
    await t.test(resource + '/' + String(reason), async t => {
      let operation, closing, failure;
      if (resource === 'source') {
        const f = await uploadFixture(t, { cleanup: { reason } });
        operation = outcome(f.adapter.write('/upload.bin', f.source, { size: BigInt(f.bytes.length) }));
        await f.arrived.promise; closing = outcome(f.registry.close());
        await f.entered.promise; await pending(closing); f.release.resolve();
        failure = (await operation).error;
        assert.equal(failure.code, 'cancelled'); await assert.rejects(f.file.stat(), { code: 'EBADF' });
        assert.equal(f.observed().returned, 1);
      } else {
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const baseUrl = await server(t, (_request, response) => { response.writeHead(403); response.end('Forbidden'); });
        const adapter = new WebDavAdapter({ baseUrl, capabilities }, { async fetch(url, options) {
          const response = await fetch(url, options), cancel = response.body.cancel.bind(response.body);
          response.body.cancel = async () => { await cancel(); entered.resolve(); await release.promise; throw reason; };
          return response;
        } });
        t.after(async () => { release.resolve(); await outcome(adapter.close()); });
        operation = outcome(adapter.mkdir('/directory')); await entered.promise;
        closing = outcome(adapter.close()); await pending(closing); release.resolve();
        failure = (await operation).error; assert.equal(failure.code, 'permission-denied');
      }
      assert.equal(failure.errors.length, 2); assert.equal(failure.errors[1].cause, reason);
      assert.equal((await closing).error.errors[0], failure.errors[1]);
    });
  }
});
