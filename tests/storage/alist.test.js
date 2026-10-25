import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';

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

const file = (name, size = 10) => ({ name, size, is_dir: false, modified: '2026-01-02T03:04:05.1234567Z' });
function json(response, data, code = 200, message = 'success') {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ code, message, data }));
}
async function body(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts);
}
async function read(handle) {
  try { const parts = []; for await (const part of handle.stream) parts.push(part); return Buffer.concat(parts); }
  finally { await handle.close(); }
}

test('AList uses API tokens only at the API origin and never follows API redirects', async (t) => {
  const rawRequests = [];
  const target = await server(t, (request, response) => { rawRequests.push(request.headers); response.end('0123456789'); });
  const apiRequests = [];
  let redirectApi = false;
  const api = await server(t, async (request, response) => {
    apiRequests.push({ headers: request.headers, body: JSON.parse(await body(request)) });
    if (redirectApi) { response.writeHead(307, { Location: `${target}/stolen` }); response.end(); }
    else json(response, { ...file('name'), raw_url: `${target}/object?sign=object-only-secret` });
  });
  const adapter = new AListAdapter({ baseUrl: api, credentialRef: 'test', password: 'directory-secret' }, { resolveCredential: async () => 'api-secret' });
  t.after(() => adapter.close());
  assert.equal((await read(await adapter.openRead('/name'))).toString(), '0123456789');
  assert.equal(apiRequests[0].headers.authorization, 'api-secret');
  assert.equal(apiRequests[0].body.password, 'directory-secret');
  assert.equal(rawRequests[0].authorization, undefined);
  assert.equal(rawRequests[0].password, undefined);
  assert.equal(rawRequests[0].cookie, undefined);
  redirectApi = true;
  await assert.rejects(adapter.stat('/name'), { code: 'invalid-response' });
  assert.equal(rawRequests.length, 1);
});

test('AList exact metadata integers do not round at the JavaScript safe integer boundary', async (t) => {
  const api = await server(t, (_request, response) => {
    response.end('{"code":200,"data":{"name":"large","size":9223372036854775807,"is_dir":false}}');
  });
  const adapter = new AListAdapter({ baseUrl: api });
  t.after(() => adapter.close());
  assert.equal((await adapter.stat('/large')).size, 9223372036854775807n);
});

test('AList destination conflicts remain distinct from permission failures', async (t) => {
  let message = 'file exists';
  const api = await server(t, async (request, response) => { await body(request); json(response, null, 403, message); });
  const adapter = new AListAdapter({ baseUrl: api, capabilities: { create: true, replace: true, rename: true } });
  t.after(() => adapter.close());
  await assert.rejects(adapter.write('/existing', Buffer.from('bytes'), { overwrite: false }), { code: 'already-exists' });
  message = 'file [existing] exists';
  await assert.rejects(adapter.rename('/source', '/existing'), { code: 'already-exists' });
  message = 'permission denied';
  await assert.rejects(adapter.write('/existing', Buffer.from('bytes')), { code: 'permission-denied' });
  await assert.rejects(adapter.rename('/source', '/existing'), { code: 'permission-denied' });
});

test('AList Range, suffix, If-Range, ignored ranges and 416 preserve actual upstream semantics', async (t) => {
  const requested = [];
  let mode = 'range';
  let api;
  api = await server(t, async (request, response) => {
    if (request.url === '/api/fs/get') { json(response, { ...file('bytes'), raw_url: `${api}/raw` }); return; }
    requested.push(request.headers);
    response.setHeader('ETag', '"v1"');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'application/octet-stream');
    if (mode === 'range') { response.writeHead(206, { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' }); response.end('234'); }
    else if (mode === 'suffix') { response.writeHead(206, { 'Content-Range': 'bytes 7-9/10', 'Content-Length': '3' }); response.end('789'); }
    else if (mode === 'invalid') { response.writeHead(206, { 'Content-Range': 'bytes 1-3/10', 'Content-Length': '3' }); response.end('123'); }
    else if (mode === 'outside') { response.writeHead(416, { 'Content-Range': 'bytes */10' }); response.end(); }
    else { response.end('0123456789'); }
  });
  const adapter = new AListAdapter({ baseUrl: api });
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
  const full = await adapter.openRead('/bytes', { range: { start: 2 }, ifRange: '"old"' });
  assert.equal(full.rangeHonored, false);
  assert.equal(full.range, null);
  assert.equal(full.totalSize, 10n);
  assert.equal((await read(full)).toString(), '0123456789');
  assert.equal(requested[2]['if-range'], '"old"');
  mode = 'invalid';
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 2, end: 4 } }), { code: 'invalid-response' });
  mode = 'outside';
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 10 } }), (error) => error.code === 'range-not-satisfiable' && error.details.totalSize === 10n && error.details.acceptRanges === 'bytes' && error.details.contentType === 'application/octet-stream');
});

test('AList refuses unproven If-Match versions, malformed ranges and encoded raw responses', async (t) => {
  let headers = {};
  let status = 200;
  let api;
  api = await server(t, (request, response) => {
    if (request.url === '/api/fs/get') json(response, { ...file('bytes'), raw_url: `${api}/raw` });
    else { response.writeHead(status, headers); response.end('0123456789'); }
  });
  const adapter = new AListAdapter({ baseUrl: api });
  t.after(() => adapter.close());
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: '"v1"' }), { code: 'not-supported' });
  headers = { ETag: '"v2"' };
  await assert.rejects(adapter.openRead('/bytes', { ifMatch: '"v1"' }), { code: 'version-changed' });
  headers = { 'Content-Range': 'bytes 0-9/5' }; status = 206;
  await assert.rejects(adapter.openRead('/bytes', { range: { start: 0 } }), { code: 'invalid-response' });
  headers = { 'Content-Encoding': 'gzip' }; status = 200;
  await assert.rejects(adapter.openRead('/bytes'), { code: 'invalid-response' });
});

test('expired object links refresh once before any bytes are returned', async (t) => {
  let gets = 0;
  let api;
  api = await server(t, (request, response) => {
    if (request.url === '/api/fs/get') json(response, { ...file('bytes'), raw_url: `${api}/${++gets === 1 ? 'old' : 'new'}` });
    else if (request.url === '/old') { response.writeHead(403); response.end('expired'); }
    else response.end('0123456789');
  });
  const adapter = new AListAdapter({ baseUrl: api });
  t.after(() => adapter.close());
  assert.equal((await read(await adapter.openRead('/bytes'))).toString(), '0123456789');
  assert.equal(gets, 2);
});

test('AList directory pagination rejects failures and mutations without returning partial success', async (t) => {
  let mode = 'success';
  const calls = [];
  const api = await server(t, async (request, response) => {
    const input = JSON.parse(await body(request)); calls.push(input);
    if (input.page === 2 && mode === 'failure') { json(response, null, 503, 'secret upstream credentials'); return; }
    const names = input.page === 1 ? ['a', 'b'] : mode === 'repeat' ? ['a'] : ['c'];
    json(response, { content: names.map((name) => file(name)), total: mode === 'mutation' && input.page === 2 ? 4 : 3 });
  });
  const registry = new StorageRegistry();
  registry.registerType('alist', (config) => new AListAdapter(config));
  await registry.createInstance('remote', 'alist', { baseUrl: api, pageSize: 2 });
  t.after(() => registry.close());
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/network', instanceId: 'remote', capabilities: {} });
  const result = await vfs.list('/network');
  assert.deepEqual(result.entries.map((entry) => entry.name), ['a', 'b', 'c']);
  assert.equal(result.consistency, 'weak');
  assert.equal(result.deletionSafe, false);
  assert.equal(calls[0].page, 1); assert.equal(calls[1].page, 2);
  mode = 'failure';
  await assert.rejects(vfs.list('/network'), (error) => error.code === 'unavailable' && !error.message.includes('secret'));
  mode = 'repeat';
  await assert.rejects(vfs.list('/network'), { code: 'incomplete-listing' });
  mode = 'mutation';
  await assert.rejects(vfs.list('/network'), { code: 'version-changed' });
});

test('AList rejects truncated pages and accepts null content only for an empty directory', async (t) => {
  let data = { content: null, total: 0 };
  const api = await server(t, (_request, response) => json(response, data));
  const adapter = new AListAdapter({ baseUrl: api }); t.after(() => adapter.close());
  assert.equal((await adapter.listPage('/')).complete, true);
  data = { content: null, total: 1 };
  await assert.rejects(adapter.listPage('/'), { code: 'incomplete-listing' });
  data = { content: [file('bad/name')], total: 1 };
  await assert.rejects(adapter.listPage('/'), { code: 'invalid-path' });
});

test('AList synchronous upload, mkdir, rename and remove use actual protocol with independent capability gates', async (t) => {
  const requests = [];
  const api = await server(t, async (request, response) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: await body(request) });
    json(response, null);
  });
  assert.throws(() => new AListAdapter({ baseUrl: api, capabilities: { write: true } }), /unsupported fields/u);
  assert.throws(() => new AListAdapter({ baseUrl: api, capabilities: { create: 'true' } }), /must be boolean/u);
  const renameOnly = new AListAdapter({ baseUrl: api, capabilities: { rename: true } });
  t.after(() => renameOnly.close());
  await assert.rejects(renameOnly.rename('/old', '/new', { overwrite: true }), { code: 'not-supported' });
  const adapter = new AListAdapter({ baseUrl: api, password: 'directory-only', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true } });
  t.after(() => adapter.close());
  const data = Buffer.from('<movie>测试</movie>');
  await adapter.write('/电影/%2e #.nfo', data, { modified: '2026-09-26T01:02:03Z' });
  await adapter.mkdir('/电影/new');
  await adapter.rename('/电影/old.nfo', '/电影/new.nfo');
  await adapter.delete('/电影/new.nfo');
  assert.equal(requests[0].method, 'PUT'); assert.equal(requests[0].url, '/api/fs/put');
  assert.equal(decodeURIComponent(requests[0].headers['file-path']), '/电影/%2e #.nfo');
  assert.equal(requests[0].headers['content-length'], String(data.length));
  assert.equal(requests[0].headers['as-task'], 'false');
  assert.equal(requests[0].headers['last-modified'], String(Date.parse('2026-09-26T01:02:03Z')));
  assert.deepEqual(requests[0].body, data);
  assert.deepEqual(JSON.parse(requests[1].body), { path: '/电影/new' });
  assert.deepEqual(JSON.parse(requests[2].body), { path: '/电影/old.nfo', name: 'new.nfo', overwrite: false });
  assert.deepEqual(JSON.parse(requests[3].body), { dir: '/电影', names: ['new.nfo'] });
  assert.equal(adapter.capabilities.atomicReplace, false);
  assert.equal(adapter.capabilities.conditionalWrite, false);
  await assert.rejects(adapter.write('/file', data, { atomic: true }), { code: 'not-supported' });
  await assert.rejects(adapter.write('/file', data, { ifMatch: '"v1"' }), { code: 'not-supported' });
  await assert.rejects(adapter.delete('/file', { ifMatch: '"v1"' }), { code: 'not-supported' });
  await assert.rejects(adapter.rename('/one', '/two', { ifMatch: '"v1"' }), { code: 'not-supported' });
  await assert.rejects(adapter.rename('/one', '/other/two'), { code: 'not-supported' });
  const readonly = new AListAdapter({ baseUrl: api }); t.after(() => readonly.close());
  await assert.rejects(readonly.write('/file', data), { code: 'not-supported' });
  await assert.rejects(readonly.mkdir('/directory'), { code: 'not-supported' });
  assert.equal(requests.length, 4);
});

test('business envelopes preserve typed failures and hide remote error bodies', async (t) => {
  let code = 401;
  let message = 'private-token-in-error';
  const api = await server(t, (_request, response) => json(response, null, code, message));
  const adapter = new AListAdapter({ baseUrl: api }); t.after(() => adapter.close());
  for (const [status, expected] of [[401, 'authentication-required'], [403, 'permission-denied'], [404, 'not-found'], [429, 'rate-limited'], [503, 'unavailable']]) {
    code = status;
    await assert.rejects(adapter.stat('/file'), (error) => error.code === expected && !JSON.stringify(error).includes(message));
  }
  code = 500; message = 'failed get object: object not found';
  await assert.rejects(adapter.stat('/file'), { code: 'not-found' });
  message = 'failed get list: not a folder';
  await assert.rejects(adapter.listPage('/file'), { code: 'not-directory' });
});

test('cancellation, timeout and adapter close abort network operations', async (t) => {
  let requested;
  let arrived = new Promise((resolve) => { requested = resolve; });
  const api = await server(t, (_request, _response) => { requested(); });
  const adapter = new AListAdapter({ baseUrl: api, timeoutMs: 1000 }); t.after(() => adapter.close());
  const controller = new AbortController();
  const operation = adapter.stat('/file', { signal: controller.signal });
  await arrived; controller.abort();
  await assert.rejects(operation, { code: 'cancelled' });
  const timeout = new AListAdapter({ baseUrl: api, timeoutMs: 25 }); t.after(() => timeout.close());
  await assert.rejects(timeout.stat('/file'), { code: 'timeout' });
  arrived = new Promise((resolve) => { requested = resolve; });
  const closing = adapter.stat('/file'); await arrived; await adapter.close();
  await assert.rejects(closing, { code: 'cancelled' });
  await assert.rejects(adapter.stat('/file'), { code: 'closed' });
});

test('closing a read after one chunk aborts the upstream connection', async (t) => {
  let rawClosed;
  const closed = new Promise((resolve) => { rawClosed = resolve; });
  let api;
  api = await server(t, (request, response) => {
    if (request.url === '/api/fs/get') json(response, { ...file('bytes'), raw_url: `${api}/raw` });
    else { response.writeHead(200, { 'Content-Length': '1000000' }); response.write('first'); request.on('close', rawClosed); }
  });
  const adapter = new AListAdapter({ baseUrl: api }); t.after(() => adapter.close());
  const handle = await adapter.openRead('/bytes');
  for await (const chunk of handle.stream) { assert.equal(Buffer.from(chunk).toString(), 'first'); break; }
  await closed;
});

test('cancelled and truncated reads fail instead of returning successful partial data', async (t) => {
  let mode = 'cancel';
  let api;
  api = await server(t, (request, response) => {
    if (request.url === '/api/fs/get') json(response, { ...file('bytes'), raw_url: `${api}/raw` });
    else {
      response.writeHead(200, { 'Content-Length': '10' }); response.write('first');
      if (mode === 'truncate') setTimeout(() => response.destroy(), 10);
    }
  });
  const adapter = new AListAdapter({ baseUrl: api }); t.after(() => adapter.close());
  const controller = new AbortController();
  const handle = await adapter.openRead('/bytes', { signal: controller.signal });
  await handle.stream.next(); controller.abort();
  await assert.rejects(handle.stream.next(), { code: 'cancelled' });
  mode = 'truncate';
  await assert.rejects(read(await adapter.openRead('/bytes')), { code: 'unavailable' });
});

test('download redirects preserve ranges but never obtain API credentials', async (t) => {
  let headers;
  const target = await server(t, (request, response) => {
    headers = request.headers;
    response.writeHead(206, { 'Content-Range': 'bytes 0-2/10' }); response.end('012');
  });
  let api;
  api = await server(t, (request, response) => {
    if (request.url === '/api/fs/get') json(response, { ...file('bytes'), raw_url: `${api}/redirect` });
    else { response.writeHead(302, { Location: `${target}/raw` }); response.end(); }
  });
  const adapter = new AListAdapter({ baseUrl: api, credentialRef: 'token' }, { resolveCredential: async () => 'api-secret' });
  t.after(() => adapter.close());
  assert.equal((await read(await adapter.openRead('/bytes', { range: { start: 0, end: 2 } }))).toString(), '012');
  assert.equal(headers.range, 'bytes=0-2'); assert.equal(headers.authorization, undefined);
});
