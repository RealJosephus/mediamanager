import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';

async function server(t, handler) {
  const service = http.createServer(async (request, response) => {
    try { await handler(request, response); }
    catch { if (response.destroyed) return; if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => new Promise((resolve) => { service.closeAllConnections(); service.close(resolve); }));
  return `http://127.0.0.1:${service.address().port}`;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function resource(href, { directory = false, size = 10, etag = '"v1"', modified = 'Sun, 04 Oct 2026 01:02:03 GMT',
  created = '2026-10-04T01:02:03Z', contentType = 'application/octet-stream', prefix = 'd', missingProperty = true } = {}) {
  return `<${prefix}:response><${prefix}:href>${escapeXml(href)}</${prefix}:href><${prefix}:propstat><${prefix}:prop>`
    + `<${prefix}:resourcetype>${directory ? `<${prefix}:collection/>` : ''}</${prefix}:resourcetype>`
    + `${directory || size === null ? '' : `<${prefix}:getcontentlength>${size}</${prefix}:getcontentlength>`}`
    + `${modified === null ? '' : `<${prefix}:getlastmodified>${modified}</${prefix}:getlastmodified>`}`
    + `${created === null ? '' : `<${prefix}:creationdate>${created}</${prefix}:creationdate>`}`
    + `${etag === null ? '' : `<${prefix}:getetag>${escapeXml(etag)}</${prefix}:getetag>`}`
    + `${contentType === null ? '' : `<${prefix}:getcontenttype>${contentType}</${prefix}:getcontenttype>`}`
    + `</${prefix}:prop><${prefix}:status>HTTP/1.1 200 OK</${prefix}:status></${prefix}:propstat>`
    + `${missingProperty ? `<${prefix}:propstat><${prefix}:prop><${prefix}:displayname/></${prefix}:prop><${prefix}:status>HTTP/1.1 404 Not Found</${prefix}:status></${prefix}:propstat>` : ''}`
    + `</${prefix}:response>`;
}

function multistatus(resources, prefix = 'd') {
  return `<?xml version="1.0" encoding="utf-8"?><${prefix}:multistatus xmlns:${prefix}="DAV:">${resources.join('')}</${prefix}:multistatus>`;
}

function sendXml(response, resources, prefix = 'd') {
  response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
  response.end(multistatus(resources, prefix));
}

async function requestBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts);
}

async function read(handle) {
  try {
    const parts = [];
    for await (const part of handle.stream) parts.push(part);
    return Buffer.concat(parts);
  } finally { await handle.close(); }
}

async function writableDav(t, { before, afterBody } = {}) {
  const files = new Map(), collections = new Set(['/dav']), requests = [];
  const pathname = value => decodeURIComponent(new URL(value, 'http://example.test').pathname).replace(/\/$/u, '') || '/';
  const href = value => value.split('/').map(encodeURIComponent).join('/');
  const origin = await server(t, async (request, response) => {
    const path = pathname(request.url), record = { method: request.method, path, headers: request.headers };
    requests.push(record);
    const context = { request, response, path, record, files, collections };
    if (await before?.(context)) return;
    record.body = await requestBody(request);
    if (await afterBody?.(context)) return;
    if (request.method === 'MKCOL') {
      if (collections.has(path) || files.has(path)) { response.writeHead(405); response.end(); return; }
      if (!collections.has(path.slice(0, path.lastIndexOf('/')))) { response.writeHead(409); response.end(); return; }
      collections.add(path); response.writeHead(201); response.end(); return;
    }
    if (request.method === 'PUT') {
      if (!collections.has(path.slice(0, path.lastIndexOf('/')))) { response.writeHead(409); response.end(); return; }
      // This controlled HTTP endpoint deliberately has the actual provider's
      // unsafe PUT behavior: it ignores If-None-Match and replaces the entity.
      const existed = files.has(path); files.set(path, record.body);
      response.writeHead(existed ? 204 : 201, { ETag: '"uploaded"' }); response.end(); return;
    }
    if (request.method === 'MOVE') {
      const destination = pathname(request.headers.destination);
      if (!files.has(path)) { response.writeHead(404); response.end(); return; }
      const existed = files.has(destination) || collections.has(destination);
      if (existed && request.headers.overwrite === 'F') { response.writeHead(412); response.end(); return; }
      files.set(destination, files.get(path)); files.delete(path);
      response.writeHead(existed ? 204 : 201, { ETag: '"published"' }); response.end(); return;
    }
    if (request.method === 'DELETE') {
      const existed = collections.delete(path) || files.delete(path);
      for (const key of files.keys()) if (key.startsWith(path + '/')) files.delete(key);
      for (const key of collections) if (key.startsWith(path + '/')) collections.delete(key);
      response.writeHead(existed ? 204 : 404); response.end(); return;
    }
    if (request.method === 'GET') {
      const bytes = files.get(path);
      response.writeHead(bytes ? 200 : 404, bytes ? { 'Content-Length': bytes.length } : {}); response.end(bytes); return;
    }
    if (request.method === 'PROPFIND') {
      if (!files.has(path) && !collections.has(path)) { response.writeHead(404); response.end(); return; }
      const paths = [path];
      if (request.headers.depth === '1') for (const key of [...collections, ...files.keys()]) {
        if (key.slice(0, key.lastIndexOf('/')) === path) paths.push(key);
      }
      sendXml(response, paths.map(key => resource(href(key), { directory: collections.has(key), size: files.get(key)?.length })));
      return;
    }
    response.writeHead(405); response.end();
  });
  return { origin, files, collections, requests,
    get: async path => {
      const response = await fetch(origin + href('/dav' + path));
      return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
    } };
}

function createAdapter(service, dependencies) {
  return new WebDavAdapter({ baseUrl: service.origin + '/dav/', capabilities: { create: true } }, dependencies);
}

function assertNoStaging(service, paths) {
  assert.deepEqual([...service.collections], ['/dav'], 'Every owned staging collection must be removed.');
  assert.deepEqual([...service.files.keys()].sort(), paths.map(path => '/dav' + path).sort(),
    'Only the declared complete destination entities may remain.');
}

test('WebDAV exclusive publish preserves complete entities and keeps caller capabilities separate', async t => {
  const service = await writableDav(t), adapter = createAdapter(service);
  t.after(() => adapter.close());
  const path = '/中文 %2F #.nfo', original = Buffer.from('Complete original\0中文 entity.'), replacement = Buffer.from('different replacement');
  const result = await adapter.write(path, original, { overwrite: false });
  assert.deepEqual(result, { size: BigInt(original.length), atomic: false, version: '"published"' });
  assert.deepEqual(await service.get(path), { status: 200, bytes: original });
  await assert.rejects(adapter.write(path, replacement, { overwrite: false }), { code: 'already-exists' });
  assert.deepEqual(await service.get(path), { status: 200, bytes: original });
  await adapter.write('/empty', Buffer.alloc(0), { overwrite: false });
  assert.deepEqual(await service.get('/empty'), { status: 200, bytes: Buffer.alloc(0) });
  const chunks = [Buffer.from('streamed '), Buffer.from('中文'), Buffer.from(' complete entity')];
  await adapter.write('/streamed', (async function* () { yield* chunks; })(), {
    overwrite: false, size: chunks.reduce((size, chunk) => size + BigInt(chunk.length), 0n),
  });
  assert.deepEqual(await service.get('/streamed'), { status: 200, bytes: Buffer.concat(chunks) });
  await assert.rejects(adapter.mkdir('/public-directory'), { code: 'not-supported' });
  await assert.rejects(adapter.delete(path), { code: 'not-supported' });
  await assert.rejects(adapter.rename(path, '/other'), { code: 'not-supported' });
  assert.deepEqual(await service.get(path), { status: 200, bytes: original });
  assertNoStaging(service, [path, '/empty', '/streamed']);
});

test('WebDAV competing exclusive writes publish exactly one complete candidate', async t => {
  const service = await writableDav(t), adapter = createAdapter(service);
  t.after(() => adapter.close());
  const candidates = [Buffer.alloc(128 * 1024, 'A'), Buffer.alloc(192 * 1024, 'B')];
  const outcomes = await Promise.allSettled(candidates.map(bytes => adapter.write('/winner', bytes, { overwrite: false })));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(value => value.status === 'rejected');
  assert.equal(rejected.reason.code, 'already-exists');
  const winner = outcomes.findIndex(value => value.status === 'fulfilled');
  assert.deepEqual(await service.get('/winner'), { status: 200, bytes: candidates[winner] });
  assertNoStaging(service, ['/winner']);
});

test('WebDAV failed uploads and publication preserve destinations and remove only owned staging', async t => {
  for (const [method, status, code] of [['MKCOL', 403, 'permission-denied'], ['PUT', 503, 'unavailable'], ['MOVE', 403, 'permission-denied']]) {
    await t.test(method, async t => {
      const service = await writableDav(t, { afterBody: ({ request, response, path, record, files }) => {
        if (request.method !== method) return false;
        if (method === 'PUT') files.set(path, record.body.subarray(0, 3));
        response.writeHead(status); response.end(); return true;
      } });
      const adapter = createAdapter(service); t.after(() => adapter.close());
      const original = Buffer.from('existing complete entity'); service.files.set('/dav/existing', original);
      await assert.rejects(adapter.write('/destination', Buffer.from('complete candidate'), { overwrite: false }), { code });
      assert.deepEqual(await service.get('/existing'), { status: 200, bytes: original });
      assert.equal((await service.get('/destination')).status, 404);
      assertNoStaging(service, ['/existing']);
    });
  }
  for (const lostResponse of [false, true]) await t.test(lostResponse ? 'unknown MKCOL response' : 'foreign collection collision', async t => {
    let foreign;
    const sentinel = Buffer.from('foreign ownership remains intact');
    const service = await writableDav(t, { before: ({ request, response, path, files, collections }) => {
      if (request.method !== 'MKCOL') return false;
      foreign = path; collections.add(path); files.set(path + '/sentinel', sentinel);
      if (lostResponse) response.destroy(); else { response.writeHead(405); response.end(); }
      return true;
    } });
    const adapter = createAdapter(service); t.after(() => adapter.close());
    await assert.rejects(adapter.write('/destination', Buffer.from('candidate'), { overwrite: false }),
      { code: lostResponse ? 'unavailable' : 'already-exists' });
    assert.deepEqual(service.files.get(foreign + '/sentinel'), sentinel);
    assert.ok(service.collections.has(foreign));
    assert.equal((await service.get('/destination')).status, 404);
  });
});

test('WebDAV publication and ordered cleanup failures retain their separate outcomes', async t => {
  for (const published of [true, false]) await t.test(published ? 'published target survives failed cleanup' : 'conflict remains the primary failure', async t => {
    const service = await writableDav(t, { before: ({ request, response }) => {
      if (request.method !== 'DELETE') return false;
      response.writeHead(403); response.end(); return true;
    } });
    const adapter = createAdapter(service), original = Buffer.from('original'), candidate = Buffer.from('candidate');
    t.after(() => Promise.allSettled([adapter.close()]));
    if (!published) service.files.set('/dav/target', original);
    await assert.rejects(adapter.write('/target', candidate, { overwrite: false }), error => {
      assert.equal(error.code, published ? 'permission-denied' : 'already-exists');
      assert.equal(error.details.publicationConfirmed, published);
      assert.deepEqual(error.cause.errors.map(value => value.code), published ? ['permission-denied'] : ['already-exists', 'permission-denied']);
      return true;
    });
    assert.deepEqual(await service.get('/target'), { status: 200, bytes: published ? candidate : original });
    assert.ok([...service.collections].some(path => path !== '/dav'));
    await assert.rejects(adapter.close(), error => error.errors.every(value => value.code === 'permission-denied'));
  });
});

async function remainsPending(promise, message) {
  const pending = Symbol('pending');
  assert.equal(await Promise.race([promise.then(() => false, () => false),
    new Promise(resolve => setImmediate(() => resolve(pending)))]), pending, message);
}

async function beforeAbort(promise, signal) {
  signal.throwIfAborted();
  let aborted;
  const cancellation = new Promise((_resolve, reject) => {
    aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
  });
  try { return await Promise.race([promise, cancellation]); }
  finally { signal.removeEventListener('abort', aborted); }
}

function containsCause(error, reason, seen = new Set()) {
  if (error === reason) return true;
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (Object.hasOwn(error, 'cause') && containsCause(error.cause, reason, seen)) return true;
  return Array.isArray(error.errors) && error.errors.some(value => containsCause(value, reason, seen));
}

test('WebDAV real upload failures preserve source next errors and every primitive rejection', { timeout: 30000 }, async t => {
  for (const reason of [false, 0, '', null, undefined,
    Object.assign(new Error('Controlled source next failure.', { cause: null }), { code: 'CONTROLLED_NEXT', status: 502 }),
  ]) await t.test('source next rejection ' + String(reason), async t => {
    const arrived = Promise.withResolvers(), sourceClosed = Promise.withResolvers(), upstreamClosed = Promise.withResolvers();
    const service = await writableDav(t, { before: ({ request }) => {
      if (request.method === 'PUT') {
        request.once('data', () => arrived.resolve()); request.once('close', () => upstreamClosed.resolve());
      }
    } });
    const adapter = createAdapter(service); t.after(() => adapter.close());
    async function* source() {
      try { yield Buffer.from('prefix'); await beforeAbort(arrived.promise, t.signal); throw reason; }
      finally { sourceClosed.resolve(); }
    }
    await assert.rejects(adapter.write('/failed', source(), { size: 100, overwrite: false, signal: t.signal }), error => {
      assert.equal(error.code, 'unavailable');
      assert.ok(containsCause(error, reason), 'The actual source rejection must remain in the retained operation cause.');
      return true;
    });
    await sourceClosed.promise; await upstreamClosed.promise;
    assert.equal((await service.get('/failed')).status, 404); assertNoStaging(service, []);
    await adapter.close();
  });
});

test('WebDAV cancelled and closing creates drain the actual upload source before releasing staging', { timeout: 30000 }, async t => {
  for (const [label, closeAdapter, fault] of [
    ['caller cancellation', false, null], ['adapter close', true, null],
    ...[false, 0, '', null, undefined,
      Object.assign(new Error('Controlled producer close failure.', { cause: false }), { code: 'CONTROLLED_CLOSE', status: 503 }),
    ].map(reason => ['source cleanup rejection ' + String(reason), false, { reason }]),
  ]) await t.test(label, async t => {
    const arrived = Promise.withResolvers(), upstreamClosed = Promise.withResolvers(), release = Promise.withResolvers(), sourceClosed = Promise.withResolvers();
    const service = await writableDav(t, { before: ({ request }) => {
      if (request.method === 'PUT') {
        request.once('data', () => arrived.resolve());
        request.once('close', () => upstreamClosed.resolve());
      }
    } });
    const adapter = createAdapter(service), controller = new AbortController();
    async function* source() {
      try { yield Buffer.from('prefix'); await release.promise; yield Buffer.from('tail'); }
      finally { sourceClosed.resolve(); }
    }
    const producer = source();
    const data = { [Symbol.asyncIterator]: () => ({ next: () => producer.next(), return: async () => {
      const result = await producer.return();
      if (fault) throw fault.reason;
      return result;
    } }) };
    const writing = adapter.write('/cancelled', data, { size: 10, overwrite: false, signal: AbortSignal.any([controller.signal, t.signal]) })
      .then(result => ({ result }), error => ({ error }));
    let closing;
    try {
      await beforeAbort(arrived.promise, t.signal);
      if (closeAdapter) closing = adapter.close(); else controller.abort();
      await remainsPending(writing, 'Cancellation must await the actual held producer and owned staging cleanup.');
      if (closing) await remainsPending(closing, 'Adapter close must retain ownership of its admitted upload.');
      release.resolve();
      const outcome = await writing;
      assert.equal(outcome.error.code, 'cancelled');
      if (fault) {
        assert.equal(outcome.error.cause.errors[0].code, 'cancelled');
        const cleanup = outcome.error.cause.errors[1];
        assert.equal(cleanup.code, 'unavailable'); assert.ok(Object.hasOwn(cleanup, 'cause'));
        assert.equal(cleanup.message, 'The WebDAV upload source did not close.');
        if (fault.reason instanceof Error) {
          assert.deepEqual({ code: cleanup.cause.code, status: cleanup.cause.status, message: cleanup.cause.message, cause: cleanup.cause.cause },
            { code: fault.reason.code, status: fault.reason.status, message: fault.reason.message, cause: fault.reason.cause });
        } else assert.equal(cleanup.cause, fault.reason);
        await assert.rejects(adapter.close(), error => error.errors.some(value => Object.hasOwn(value, 'cause') && value.cause === fault.reason));
      } else await (closing ?? adapter.close());
      await sourceClosed.promise; await upstreamClosed.promise;
      assert.equal((await service.get('/cancelled')).status, 404);
      assertNoStaging(service, []);
      await assert.rejects(adapter.write('/late', Buffer.from('late'), { overwrite: false }), { code: 'closed' });
      assert.equal((await service.get('/late')).status, 404);
    } finally {
      release.resolve();
      await Promise.allSettled([writing, closing, adapter.close()]);
    }
  });
});

test('WebDAV admitted mutation response-close failures retain the actual HTTP outcome and original reason', async t => {
  for (const published of [false, true]) await t.test(published ? 'published response close fails' : 'conflict and response close both fail', async t => {
    const service = await writableDav(t), original = Buffer.from('original complete entity'), candidate = Buffer.from('candidate complete entity');
    if (!published) service.files.set('/dav/target', original);
    const responseFailure = Object.assign(new Error('Controlled response close failure.', { cause: '' }), { code: 'CONTROLLED_RESPONSE_CLOSE', status: 599 });
    const observedResponses = [];
    const adapter = createAdapter(service, { fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'MOVE') {
        observedResponses.push({ status: response.status, headers: Object.fromEntries(response.headers) });
        const body = response.body, cancel = body.cancel.bind(body);
        let inject = true;
        Object.defineProperty(body, 'cancel', { value: async () => {
          await cancel(); if (inject) { inject = false; throw responseFailure; }
        } });
      }
      return response;
    } });
    t.after(() => Promise.allSettled([adapter.close()]));
    await assert.rejects(adapter.write('/target', candidate, { overwrite: false }), error => {
      assert.equal(error.code, published ? 'unavailable' : 'already-exists');
      assert.equal(error.details.publicationConfirmed, published);
      if (!published) assert.equal(error.details.status, 412);
      const failures = error.cause.errors;
      if (!published) {
        assert.equal(failures[0].code, 'already-exists'); assert.equal(failures[0].details.status, 412);
      }
      const closing = failures.at(-1);
      assert.equal(closing.code, 'unavailable');
      assert.deepEqual({ code: closing.cause.code, status: closing.cause.status, message: closing.cause.message, cause: closing.cause.cause },
        { code: responseFailure.code, status: responseFailure.status, message: responseFailure.message, cause: responseFailure.cause });
      return true;
    });
    assert.equal(observedResponses.at(-1).status, published ? 201 : 412);
    assert.deepEqual(await service.get('/target'), { status: 200, bytes: published ? candidate : original });
    assertNoStaging(service, ['/target']);
    await assert.rejects(adapter.close(), error => error.errors.some(value => value.cause === responseFailure));
  });
});

test('WebDAV close waits for acknowledged publication cleanup and blocks late business admission', { timeout: 30000 }, async t => {
  await t.test('successful EOF retains actual source return ownership', async t => {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    const service = await writableDav(t), adapter = createAdapter(service), bytes = Buffer.from('complete source entity');
    let yielded = false;
    const source = { [Symbol.asyncIterator]: () => ({
      next: async () => { if (yielded) return { done: true }; yielded = true; return { value: bytes, done: false }; },
      return: async () => { arrived.resolve(); await release.promise; return { done: true }; },
    }) };
    const writing = adapter.write('/published', source, { size: bytes.length, overwrite: false, signal: t.signal });
    writing.catch(() => {});
    let closing;
    try {
      await beforeAbort(arrived.promise, t.signal);
      assert.deepEqual(await service.get('/published'), { status: 200, bytes });
      closing = adapter.close();
      await remainsPending(writing, 'Observed EOF cannot replace actual source return completion.');
      await remainsPending(closing, 'Close must retain the successful producer until its actual return completes.');
      release.resolve(); await writing; await closing;
      assert.deepEqual(await service.get('/published'), { status: 200, bytes }); assertNoStaging(service, ['/published']);
    } finally { release.resolve(); await Promise.allSettled([writing, closing, adapter.close()]); }
  });
  await t.test('owned DELETE can finish after close begins', async t => {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    const service = await writableDav(t, { before: async ({ request }) => {
      if (request.method === 'DELETE') { arrived.resolve(); await release.promise; }
    } });
    const adapter = createAdapter(service), bytes = Buffer.from('published before cleanup');
    const writing = adapter.write('/published', bytes, { overwrite: false, signal: t.signal });
    writing.catch(() => {});
    let closing;
    try {
      await beforeAbort(arrived.promise, t.signal);
      assert.deepEqual(await service.get('/published'), { status: 200, bytes });
      closing = adapter.close();
      await remainsPending(writing, 'A successful write must wait for its real staging DELETE.');
      await remainsPending(closing, 'Close must await cleanup of an already published create.');
      release.resolve();
      assert.equal((await writing).size, BigInt(bytes.length)); await closing;
      assert.deepEqual(await service.get('/published'), { status: 200, bytes });
      assertNoStaging(service, ['/published']);
    } finally { release.resolve(); await Promise.allSettled([writing, closing, adapter.close()]); }
  });
  await t.test('credential completion after close cannot start publication', async t => {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    let pause = true;
    const service = await writableDav(t);
    const adapter = new WebDavAdapter({ baseUrl: service.origin + '/dav/', credentialRef: 'DAV_AUTH', capabilities: { create: true } }, {
      resolveCredential: async () => {
        if (pause && service.files.size) { arrived.resolve(); await release.promise; }
        return 'Basic controlled';
      },
    });
    const writing = adapter.write('/late', Buffer.from('complete candidate'), { overwrite: false, signal: t.signal })
      .then(result => ({ result }), error => ({ error }));
    let closing;
    try {
      await beforeAbort(arrived.promise, t.signal); closing = adapter.close();
      await remainsPending(closing, 'Close must await the already admitted credential resolution.');
      pause = false; release.resolve();
      assert.equal((await writing).error.code, 'cancelled'); await closing;
      assert.equal((await service.get('/late')).status, 404); assertNoStaging(service, []);
    } finally { pause = false; release.resolve(); await Promise.allSettled([writing, closing, adapter.close()]); }
  });
});

test('WebDAV has one strict configuration and a complete conservative capability contract', () => {
  for (const config of [undefined, null, [], {}, { baseUrl: 'ftp://example.test/dav/' },
    { baseUrl: 'http://user:secret@example.test/dav/' }, { baseUrl: 'http://example.test/dav/?query=1' },
    { baseUrl: 'http://example.test/dav/%2e%2e/root/' }, { baseUrl: 'http://example.test/dav/', oldEndpoint: true },
    { baseUrl: 'http://example.test/dav/', pageSize: 0 },
    { baseUrl: 'http://example.test/dav/', capabilities: { write: true } },
    { baseUrl: 'http://example.test/dav/', capabilities: { replace: false, conditionalWrite: true } }]) {
    assert.throws(() => new WebDavAdapter(config), TypeError);
  }
  assert.throws(() => new WebDavAdapter({ baseUrl: 'http://example.test/dav/', credentialRef: 'DAV_AUTH' }), TypeError);
  const adapter = new WebDavAdapter({ baseUrl: 'http://example.test/dav/', capabilities: {
    create: true, replace: true, conditionalWrite: true, mkdir: true, delete: true, rename: true,
  } });
  assert.equal(Object.isFrozen(adapter.capabilities), true);
  assert.deepEqual(adapter.capabilities, {
    randomRead: 'conditional', reliableLength: false, reliableVersion: false, directorySnapshot: false,
    create: true, replace: true, conditionalWrite: true, mkdir: true, delete: true, rename: true,
    atomicReplace: false, directLease: false, watch: false,
  });
  assert.equal(Object.hasOwn(adapter.capabilities, 'write'), false);
});

test('WebDAV stat uses protocol metadata, fresh credentials and one-time path decoding', async (t) => {
  const authorizations = [];
  const bodies = [];
  const origin = await server(t, async (request, response) => {
    authorizations.push(request.headers.authorization);
    bodies.push(await requestBody(request));
    assert.equal(request.method, 'PROPFIND');
    assert.equal(request.headers.depth, '0');
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.equal(request.url, '/dav/%E7%94%B5%E5%BD%B1/%252e%20%23.mkv');
    sendXml(response, [resource(`${origin}${request.url}`, { size: '9223372036854775807', prefix: 'x' })], 'x');
  });
  let credential = 0;
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, credentialRef: 'DAV_AUTH' }, {
    resolveCredential: async (reference) => { assert.equal(reference, 'DAV_AUTH'); return `Basic rotated-${++credential}`; },
  });
  t.after(() => adapter.close());
  const first = await adapter.stat('/电影/%2e #.mkv');
  const second = await adapter.stat('/电影/%2e #.mkv');
  assert.equal(first.name, '%2e #.mkv');
  assert.equal(first.kind, 'file');
  assert.equal(first.size, 9223372036854775807n);
  assert.equal(first.version, '"v1"');
  assert.equal(first.modified, '2026-10-04T01:02:03.000Z');
  assert.deepEqual(second, first);
  assert.deepEqual(authorizations, ['Basic rotated-1', 'Basic rotated-2']);
  assert.ok(bodies.every((value) => value.toString().includes('<d:propfind')));
});

test('WebDAV pagination re-enumerates, orders entries and detects directory changes', async (t) => {
  let names = ['c', 'a', 'b'];
  let bVersion = 'b';
  let calls = 0;
  let failureCountdown = null;
  let failureStatus = 503;
  const origin = await server(t, (request, response) => {
    calls++;
    assert.equal(request.method, 'PROPFIND');
    assert.equal(request.headers.depth, '1');
    assert.equal(request.url, '/dav/library/');
    if (failureCountdown !== null && --failureCountdown === 0) {
      failureCountdown = null;
      response.writeHead(failureStatus);
      response.end('private partial-listing failure');
      return;
    }
    const order = calls % 2 ? names : [...names].reverse();
    sendXml(response, [resource('/dav/library/', { directory: true, prefix: 'q' }),
      ...order.map((name) => resource(name, { size: name.charCodeAt(0), etag: `"${name === 'b' ? bVersion : name}"`, prefix: 'q' }))], 'q');
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, pageSize: 2 });
  t.after(() => adapter.close());
  const first = await adapter.listPage('/library');
  assert.deepEqual(first.entries.map((entry) => entry.name), ['a', 'b']);
  assert.equal(first.complete, false);
  assert.equal(first.consistency, 'weak');
  assert.equal(first.snapshot, null);
  assert.deepEqual(Object.keys(first.nextCursor).sort(), ['digest', 'offset', 'path']);
  const second = await adapter.listPage('/library', { cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.name), ['c']);
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, null);

  const beforeMutation = await adapter.listPage('/library');
  names = ['c', 'a', 'b', 'd'];
  await assert.rejects(adapter.listPage('/library', { cursor: beforeMutation.nextCursor }), { code: 'version-changed' });
  names = ['c', 'a', 'b'];
  const beforeReplacement = await adapter.listPage('/library');
  bVersion = 'b-replaced';
  await assert.rejects(adapter.listPage('/library', { cursor: beforeReplacement.nextCursor }), { code: 'version-changed' });
  bVersion = 'b';
  const beforeDeletion = await adapter.listPage('/library');
  names = ['c', 'a'];
  await assert.rejects(adapter.listPage('/library', { cursor: beforeDeletion.nextCursor }), { code: 'version-changed' });
  await assert.rejects(adapter.listPage('/other', { cursor: beforeMutation.nextCursor }), TypeError);

  names = ['c', 'a', 'b'];
  const registry = new StorageRegistry();
  registry.registerType('webdav', () => adapter);
  await registry.createInstance('remote', 'webdav', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/network', instanceId: 'remote', root: '/library', capabilities: {} });
  const listing = await vfs.list('/network');
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['a', 'b', 'c']);
  assert.equal(listing.consistency, 'weak');
  assert.equal(listing.deletionSafe, false);
  for (const [status, code] of [[503, 'unavailable'], [401, 'authentication-required'], [429, 'rate-limited']]) {
    failureStatus = status;
    failureCountdown = 2;
    await assert.rejects(vfs.list('/network'), (error) => error.code === code
      && !JSON.stringify(error).includes('private partial-listing'));
  }
});

test('WebDAV rejects unsafe, duplicate and non-child hrefs without partial listings', async (t) => {
  let children = [];
  const origin = await server(t, (_request, response) => {
    sendXml(response, [resource('/dav/', { directory: true }), ...children.map((href) => resource(href))]);
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/` });
  t.after(() => adapter.close());
  for (const href of ['http://example.test/dav/file', '/outside/file', '/dav/a%2Fb', '/dav/a%5Cb',
    '/dav/%2e%2e/file', '/dav/parent/child']) {
    children = [href];
    await assert.rejects(adapter.listPage('/'), { code: 'invalid-response' });
  }
  children = ['/dav/a', '/dav/%61'];
  await assert.rejects(adapter.listPage('/'), { code: 'incomplete-listing' });
  children = ['/dav/%252F'];
  assert.equal((await adapter.listPage('/')).entries[0].name, '%2F');
});

test('WebDAV Range, suffix, If-Range, ignored ranges and 416 preserve server semantics', async (t) => {
  const requested = [];
  let mode = 'range';
  const origin = await server(t, (request, response) => {
    if (request.method === 'PROPFIND') {
      sendXml(response, [resource('/dav/bytes', { size: 10, etag: '"v1"' })]);
      return;
    }
    requested.push(request.headers);
    response.setHeader('ETag', mode === 'ifrange-mismatch' ? '"v2"' : '"v1"');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'application/octet-stream');
    if (mode === 'range') { response.writeHead(206, { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' }); response.end('234'); }
    else if (mode === 'suffix') { response.writeHead(206, { 'Content-Range': 'bytes 7-9/10', 'Content-Length': '3' }); response.end('789'); }
    else if (mode === 'invalid') { response.writeHead(206, { 'Content-Range': 'bytes 1-3/10', 'Content-Length': '3' }); response.end('123'); }
    else if (mode === 'ifrange-mismatch') { response.writeHead(206, { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' }); response.end('234'); }
    else if (mode === 'outside') { response.writeHead(416, { 'Content-Range': 'bytes */10' }); response.end(); }
    else { response.writeHead(200, { 'Content-Length': '10' }); response.end('0123456789'); }
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/` });
  t.after(() => adapter.close());
  const segment = await adapter.openRead('/bytes', { range: { start: 2, end: 4 }, ifMatch: '"v1"' });
  assert.equal(segment.rangeHonored, true);
  assert.equal(segment.acceptRanges, 'bytes');
  assert.deepEqual(segment.range, { start: 2n, end: 4n });
  assert.equal((await read(segment)).toString(), '234');
  assert.equal(requested[0].range, 'bytes=2-4');
  assert.equal(requested[0]['if-match'], '"v1"');
  mode = 'suffix';
  assert.equal((await read(await adapter.openRead('/bytes', { range: { suffix: 3 } }))).toString(), '789');
  assert.equal(requested[1].range, 'bytes=-3');
  mode = 'ignore';
  const unconditionalFull = await adapter.openRead('/bytes', { range: { start: 2 } });
  assert.equal(unconditionalFull.rangeHonored, false);
  assert.equal((await read(unconditionalFull)).toString(), '0123456789');
  assert.equal(requested[2]['if-range'], undefined);
  const full = await adapter.openRead('/bytes', { range: { start: 2 }, ifRange: '"old"' });
  assert.equal(full.rangeHonored, false);
  assert.equal(full.range, null);
  assert.equal(full.totalSize, 10n);
  assert.equal((await read(full)).toString(), '0123456789');
  assert.equal(requested[3]['if-range'], '"old"');
  mode = 'range';
  assert.equal((await read(await adapter.openRead('/bytes', {
    range: { start: 2, end: 4 }, ifRange: '"v1"',
  }))).toString(), '234');
  assert.equal(requested[4]['if-range'], '"v1"');
  const beforeWeak = requested.length;
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 2, end: 4 }, ifRange: 'W/"v1"' }), { code: 'not-supported' });
  assert.equal(requested.length, beforeWeak);
  mode = 'invalid';
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 2, end: 4 } }), { code: 'invalid-response' });
  mode = 'ifrange-mismatch';
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 2, end: 4 }, ifRange: '"v1"' }), { code: 'version-changed' });
  mode = 'outside';
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 10 } }), (error) => error.code === 'range-not-satisfiable'
    && error.details.totalSize === 10n && error.details.acceptRanges === 'bytes'
    && error.details.contentType === 'application/octet-stream');
});

test('WebDAV conditional reads reject unproven versions, encoding and truncated bodies', async (t) => {
  let mode = 'missing-etag';
  const origin = await server(t, (request, response) => {
    if (request.method === 'PROPFIND') {
      sendXml(response, [resource('/dav/bytes', { size: 10, etag: mode === 'metadata-missing' ? null : '"v1"' })]);
      return;
    }
    if (mode === 'different-etag') { response.writeHead(200, { ETag: '"v2"', 'Content-Length': '10' }); response.end('0123456789'); }
    else if (mode === 'encoded') { response.writeHead(200, { ETag: '"v1"', 'Content-Encoding': 'gzip' }); response.end('not-compressed'); }
    else if (mode === 'truncate') { response.writeHead(200, { ETag: '"v1"', 'Content-Length': '10' }); response.end('short'); }
    else { response.writeHead(200, { 'Content-Length': '10' }); response.end('0123456789'); }
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/` });
  t.after(() => adapter.close());
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: 'weak-version' }), { code: 'not-supported' });
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: '"v1"' }), { code: 'not-supported' });
  mode = 'different-etag';
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: '"v1"' }), { code: 'version-changed' });
  mode = 'encoded';
  await assert.rejects(adapter.openRead('/bytes'), { code: 'invalid-response' });
  mode = 'truncate';
  await assert.rejects(read(await adapter.openRead('/bytes')), (error) => ['invalid-response', 'unavailable'].includes(error.code));
});

test('WebDAV create, replace, collection, delete and cross-directory MOVE are independently gated', async (t) => {
  const requests = [];
  let forcedStatus = null;
  let forcedMethod = null;
  const origin = await server(t, async (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: await requestBody(request) });
    const forced = forcedStatus !== null && (forcedMethod === null || forcedMethod === request.method);
    const status = (forced ? forcedStatus : null) ?? ({ PUT: 204,
      MKCOL: 201, DELETE: 204, MOVE: 201 })[request.method] ?? 500;
    if (forced) { forcedStatus = null; forcedMethod = null; }
    response.writeHead(status, request.method === 'PUT' ? { ETag: '"written"' } : {});
    response.end();
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: {
    create: true, replace: true, conditionalWrite: true, mkdir: true, delete: true, rename: true,
  } });
  t.after(() => adapter.close());
  const bytes = Buffer.from('<movie>测试</movie>');
  assert.deepEqual(await adapter.write('/电影/%2F #.nfo', bytes, { overwrite: false }), {
    size: BigInt(bytes.length), atomic: false, version: null,
  });
  await adapter.write('/电影/current.nfo', bytes, { ifMatch: '"v1"' });
  await adapter.write('/电影/upsert.nfo', bytes, { overwrite: true });
  await adapter.mkdir('/电影/new');
  await adapter.delete('/电影/old.nfo', { ifMatch: '"v2"' });
  await adapter.rename('/电影/new/name.nfo', '/archive/%2F renamed.nfo');
  const created = requests.find(request => request.method === 'MOVE'
    && request.headers.destination === `${origin}/dav/%E7%94%B5%E5%BD%B1/%252F%20%23.nfo`);
  assert.ok(created); assert.equal(created.headers.overwrite, 'F');
  const uploaded = requests.find(request => request.method === 'PUT' && request.url === created.url);
  assert.equal(uploaded.headers['content-length'], String(bytes.length));
  assert.deepEqual(uploaded.body, bytes);
  assert.equal(requests.find(request => request.method === 'PUT' && request.url.endsWith('/current.nfo')).headers['if-match'], '"v1"');
  assert.equal(requests.find(request => request.method === 'DELETE' && request.url.endsWith('/old.nfo')).headers['if-match'], '"v2"');
  const renamed = requests.find(request => request.method === 'MOVE' && request.url.endsWith('/new/name.nfo'));
  assert.equal(renamed.headers.overwrite, 'F');
  assert.equal(renamed.headers.destination, `${origin}/dav/archive/%252F%20renamed.nfo`);
  const beforeNoop = requests.length;
  await adapter.rename('/same', '/same');
  assert.equal(requests.length, beforeNoop);

  forcedStatus = 412;
  await assert.rejects(adapter.rename('/source', '/destination'), { code: 'already-exists' });
  forcedStatus = 412;
  forcedMethod = 'MOVE';
  await assert.rejects(adapter.write('/existing', bytes, { overwrite: false }), { code: 'already-exists' });
  forcedStatus = 405;
  await assert.rejects(adapter.mkdir('/existing-directory'), { code: 'already-exists' });
  forcedStatus = 204;
  forcedMethod = 'MOVE';
  await assert.rejects(adapter.write('/unsafe-create', bytes, { overwrite: false }), { code: 'invalid-response' });
  forcedStatus = 201;
  await assert.rejects(adapter.write('/unsafe-replacement', bytes, { ifMatch: '"v1"' }), { code: 'invalid-response' });
  forcedStatus = 204;
  await assert.rejects(adapter.rename('/source', '/unsafe-overwrite'), { code: 'invalid-response' });
  await assert.rejects(adapter.write('/file', bytes, { atomic: true }), { code: 'not-supported' });
  await assert.rejects(adapter.write('/file', bytes, { modified: '2026-10-04T00:00:00Z' }), { code: 'not-supported' });
  await assert.rejects(adapter.rename('/directory', '/directory/child'), { code: 'invalid-path' });

  const createOnly = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: { create: true } });
  t.after(() => createOnly.close());
  await assert.rejects(createOnly.write('/file', bytes), { code: 'not-supported' });
  await assert.rejects(createOnly.write('/file', bytes, { ifMatch: '"v1"' }), { code: 'not-supported' });
  const replaceOnly = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: { replace: true } });
  t.after(() => replaceOnly.close());
  await assert.rejects(replaceOnly.write('/file', bytes, { ifMatch: '"v1"' }), { code: 'not-supported' });
  const renameOnly = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: { rename: true } });
  t.after(() => renameOnly.close());
  const beforeDeniedOverwrite = requests.length;
  await assert.rejects(renameOnly.rename('/source', '/destination', { overwrite: true }), { code: 'not-supported' });
  assert.equal(requests.length, beforeDeniedOverwrite);
});

test('WebDAV authentication, remote failures and redirects fail closed without exposing bodies', async (t) => {
  let status = 401;
  const origin = await server(t, (_request, response) => {
    if (redirectStatusesForTest.has(status)) response.writeHead(status, { Location: 'http://example.test/stolen' });
    else response.writeHead(status, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
    response.end('private-password-in-error');
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, credentialRef: 'DAV_AUTH' }, {
    resolveCredential: async () => 'Basic private',
  });
  t.after(() => adapter.close());
  for (const [remote, expected] of [[401, 'authentication-required'], [403, 'permission-denied'], [404, 'not-found'],
    [429, 'rate-limited'], [503, 'unavailable']]) {
    status = remote;
    await assert.rejects(adapter.stat('/file'), (error) => error.code === expected
      && error.details.status === remote && !JSON.stringify(error).includes('private-password'));
  }
  status = 307;
  await assert.rejects(adapter.stat('/file'), { code: 'invalid-response' });
  const missing = new WebDavAdapter({ baseUrl: `${origin}/dav/`, credentialRef: 'DAV_AUTH' }, {
    resolveCredential: async () => { throw new Error('secret resolver detail'); },
  });
  t.after(() => missing.close());
  await assert.rejects(missing.stat('/file'), (error) => error.code === 'authentication-required'
    && !JSON.stringify(error).includes('secret resolver detail'));
  status = 401;
  assert.deepEqual(await adapter.health(), { state: 'authentication-required', retryAfter: '5' });
});

const redirectStatusesForTest = new Set([301, 302, 303, 307, 308]);

test('WebDAV cancellation, timeout, close and early read close abort upstream work', async (t) => {
  let mode = 'metadata-hang';
  let arrivedResolve;
  let arrived = new Promise((resolve) => { arrivedResolve = resolve; });
  let upstreamClosedResolve;
  const observeUpstreamClose = () => new Promise((resolve) => { upstreamClosedResolve = resolve; });
  let upstreamClosed = observeUpstreamClose();
  let streamClosedResolve;
  let streamClosed = new Promise((resolve) => { streamClosedResolve = resolve; });
  let streamEndedAtClose = null;
  const origin = await server(t, (request, response) => {
    if (['MKCOL', 'MOVE', 'DELETE'].includes(request.method)) {
      response.writeHead(request.method === 'DELETE' ? 204 : 201); response.end(); return;
    }
    if (request.method === 'PUT') {
      if (mode === 'write-hang') {
        const resolveClose = upstreamClosedResolve;
        response.on('close', () => resolveClose(response.writableEnded));
        arrivedResolve(); return;
      }
      response.writeHead(201); response.end(); return;
    }
    if (request.method === 'PROPFIND') {
      if (mode === 'metadata-hang') {
        const resolveClose = upstreamClosedResolve;
        response.on('close', () => resolveClose(response.writableEnded));
        arrivedResolve(); return;
      }
      sendXml(response, [resource(request.url, { size: 1000000 })]);
      return;
    }
    response.writeHead(200, { ETag: '"v1"', 'Content-Length': '1000000' });
    response.write('first');
    response.on('close', () => { streamEndedAtClose = response.writableEnded; streamClosedResolve(); });
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, timeoutMs: 1000 });
  t.after(() => adapter.close());
  const controller = new AbortController();
  const operation = adapter.stat('/file', { signal: controller.signal });
  await arrived;
  controller.abort();
  await assert.rejects(operation, { code: 'cancelled' });
  assert.equal(await upstreamClosed, false);
  mode = 'metadata-success';
  assert.equal((await adapter.stat('/file')).kind, 'file');

  mode = 'write-hang';
  arrived = new Promise((resolve) => { arrivedResolve = resolve; });
  upstreamClosed = observeUpstreamClose();
  const writing = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: { create: true } });
  t.after(() => writing.close());
  const writeController = new AbortController();
  const writeOperation = writing.write('/new', Buffer.from('bytes'), { overwrite: false, signal: writeController.signal });
  await arrived;
  writeController.abort();
  await assert.rejects(writeOperation, { code: 'cancelled' });
  assert.equal(await upstreamClosed, false);
  mode = 'metadata-success';
  assert.equal((await writing.stat('/file')).kind, 'file');

  mode = 'metadata-hang';
  upstreamClosed = observeUpstreamClose();
  const timeout = new WebDavAdapter({ baseUrl: `${origin}/dav/`, timeoutMs: 25 });
  t.after(() => timeout.close());
  await assert.rejects(timeout.stat('/file'), { code: 'timeout' });
  assert.equal(await upstreamClosed, false);

  arrived = new Promise((resolve) => { arrivedResolve = resolve; });
  upstreamClosed = observeUpstreamClose();
  const closing = adapter.stat('/file');
  await arrived;
  await adapter.close();
  await assert.rejects(closing, { code: 'cancelled' });
  assert.equal(await upstreamClosed, false);
  await assert.rejects(adapter.stat('/file'), { code: 'closed' });

  mode = 'metadata-success';
  const streaming = new WebDavAdapter({ baseUrl: `${origin}/dav/` });
  t.after(() => streaming.close());
  assert.equal((await streaming.stat('/file')).kind, 'file');
  const handle = await streaming.openRead('/bytes');
  for await (const chunk of handle.stream) { assert.equal(Buffer.from(chunk).toString(), 'first'); break; }
  await streamClosed;
  assert.equal(streamEndedAtClose, false);
  assert.equal((await streaming.stat('/file')).kind, 'file');
});

test('WebDAV rejects malformed, oversized and failed child multistatus documents', async (t) => {
  let mode = 'malformed';
  const origin = await server(t, (_request, response) => {
    response.writeHead(207, { 'Content-Type': 'application/xml' });
    if (mode === 'malformed') response.end('<d:multistatus xmlns:d="DAV:">');
    else if (mode === 'doctype') response.end('<!DOCTYPE x [<!ENTITY leak "value">]><d:multistatus xmlns:d="DAV:"/>');
    else if (mode === 'oversized') response.end('x'.repeat(2000));
    else if (mode === 'namespace') response.end('<?xml version="1.0"?><x:multistatus xmlns:x="urn:not-dav"><x:response>'
      + '<x:href>/dav/</x:href></x:response></x:multistatus>');
    else if (mode === 'date') response.end(multistatus([resource('/dav/', { directory: true, modified: 'not-an-http-date' })]));
    else response.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/private</d:href>'
      + '<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status>'
      + '</d:propstat></d:response></d:multistatus>');
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, maxXmlBytes: 1024 });
  t.after(() => adapter.close());
  await assert.rejects(adapter.stat('/'), { code: 'invalid-response' });
  mode = 'doctype';
  await assert.rejects(adapter.stat('/'), { code: 'invalid-response' });
  mode = 'oversized';
  await assert.rejects(adapter.stat('/'), { code: 'invalid-response' });
  mode = 'namespace';
  await assert.rejects(adapter.stat('/'), { code: 'invalid-response' });
  mode = 'date';
  await assert.rejects(adapter.stat('/'), { code: 'invalid-response' });
  mode = 'child-failure';
  await assert.rejects(adapter.listPage('/'), { code: 'permission-denied' });
});
