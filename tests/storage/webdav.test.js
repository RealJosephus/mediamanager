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
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
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
    atomicReplace: false, directLease: false,
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
  const origin = await server(t, async (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: await requestBody(request) });
    const status = forcedStatus ?? ({ PUT: request.headers['if-none-match'] === '*' ? 201 : 204,
      MKCOL: 201, DELETE: 204, MOVE: 201 })[request.method] ?? 500;
    forcedStatus = null;
    response.writeHead(status, request.method === 'PUT' ? { ETag: '"written"' } : {});
    response.end();
  });
  const adapter = new WebDavAdapter({ baseUrl: `${origin}/dav/`, capabilities: {
    create: true, replace: true, conditionalWrite: true, mkdir: true, delete: true, rename: true,
  } });
  t.after(() => adapter.close());
  const bytes = Buffer.from('<movie>测试</movie>');
  assert.deepEqual(await adapter.write('/电影/%2F #.nfo', bytes, { overwrite: false }), {
    size: BigInt(bytes.length), atomic: false, version: '"written"',
  });
  await adapter.write('/电影/current.nfo', bytes, { ifMatch: '"v1"' });
  await adapter.write('/电影/upsert.nfo', bytes, { overwrite: true });
  await adapter.mkdir('/电影/new');
  await adapter.delete('/电影/old.nfo', { ifMatch: '"v2"' });
  await adapter.rename('/电影/new/name.nfo', '/archive/%2F renamed.nfo');
  assert.equal(requests[0].url, '/dav/%E7%94%B5%E5%BD%B1/%252F%20%23.nfo');
  assert.equal(requests[0].headers['if-none-match'], '*');
  assert.equal(requests[0].headers['content-length'], String(bytes.length));
  assert.deepEqual(requests[0].body, bytes);
  assert.equal(requests[1].headers['if-match'], '"v1"');
  assert.equal(requests[4].headers['if-match'], '"v2"');
  assert.equal(requests[5].method, 'MOVE');
  assert.equal(requests[5].headers.overwrite, 'F');
  assert.equal(requests[5].headers.destination, `${origin}/dav/archive/%252F%20renamed.nfo`);
  const beforeNoop = requests.length;
  await adapter.rename('/same', '/same');
  assert.equal(requests.length, beforeNoop);

  forcedStatus = 412;
  await assert.rejects(adapter.rename('/source', '/destination'), { code: 'already-exists' });
  forcedStatus = 412;
  await assert.rejects(adapter.write('/existing', bytes, { overwrite: false }), { code: 'already-exists' });
  forcedStatus = 405;
  await assert.rejects(adapter.mkdir('/existing-directory'), { code: 'already-exists' });
  forcedStatus = 204;
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
