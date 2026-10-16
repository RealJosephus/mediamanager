import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { remoteStaticStreamResult } from '../../src/playback/remote-static.js';
import libraryFixture from '../library/fixtures/reference-media.json' with { type: 'json' };
import nativeContract from './fixtures/remote-static-native-redirect-matrix.json' with { type: 'json' };

const payload = Buffer.from('native-remote-static-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n');
const cases = [
  ['full', '/full'], ['partial', '/partial'], ['redirect', '/redirect'],
  ['chunked', '/chunked'], ['upstream-503', '/error'], ['upstream-416', '/unsatisfied'],
  ['redirect-range', '/redirect-partial'], ['partial-no-accept', '/partial-no-accept'],
  ['redirect-loop', '/redirect-loop'], ['compressed-gzip', '/compressed-gzip'],
  ['compressed-deflate', '/compressed-deflate'], ['compressed-br', '/compressed-br'],
  ['compressed-partial', '/compressed-partial'], ['unknown-encoding', '/unknown-encoding'],
  ['https-untrusted', '/full', 'https'], ['redirect-to-untrusted-https', '/redirect-tls'],
  ['close-before-headers', '/close-before-headers'],
  ['close-once', '/close-once'],
  ['truncated-length', '/truncated-length'], ['truncated-chunked', '/truncated-chunked'],
  ['corrupt-gzip', '/corrupt-gzip'], ['stacked-gzip-br', '/stacked-gzip-br'],
  ['stacked-br-gzip', '/stacked-br-gzip'],
  ['redirect-other-host', '/redirect-other-host'], ['redirect-cross-return', '/redirect-cross-return'],
  ['redirect-file-scheme', '/redirect-file-scheme'], ['redirect-300', '/redirect-300'],
  ['redirect-301-range', '/redirect-301'], ['redirect-303-cross-host', '/redirect-303'],
  ['redirect-307-relative', '/nested/redirect-307'], ['redirect-308-cross-return', '/redirect-308'],
  ['redirect-302-no-location', '/redirect-302-no-location'], ['redirect-305', '/redirect-305'],
  ['invalid-content-range', '/invalid-content-range'], ['invalid-content-type', '/invalid-content-type'],
];
const id = index => `94000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const comparedHeaders = ['accept-ranges', 'content-length', 'content-range', 'content-type'];
const tlsCertificate = await readFile(new URL('./fixtures/localhost-tls.crt', import.meta.url));
const tlsKey = await readFile(new URL('./fixtures/localhost-tls.key', import.meta.url));

async function seed(database, upstreamOrigin, tlsOrigin) {
  for (const [table, rows] of Object.entries(libraryFixture.tables)) {
    const columns = tableDefinition(table).columns;
    const pending = [...rows], inserted = new Set();
    while (pending.length) {
      const index = table === 'BaseItems' ? pending.findIndex(row => [row.ParentId, row.OwnerId].every(parent => !parent || inserted.has(parent))) : 0;
      assert.notEqual(index, -1);
      const [row] = pending.splice(index, 1);
      await database.insert(table, Object.fromEntries(Object.entries(row).map(([name, value]) =>
        [name, value != null && columns.find(column => column.name === name)?.type === 'INTEGER' && typeof value === 'string' ? BigInt(value) : value])));
      inserted.add(row.Id);
    }
  }
  const template = libraryFixture.tables.BaseItems.find(row => row.Id === '22222222-2222-2222-2222-222222222222');
  for (const [index, [name, route, scheme]] of cases.entries()) {
    const itemId = id(index);
    await database.insert('BaseItems', {
      ...template, Id: itemId, Name: `Remote Static ${name}`, CleanName: `remote static ${name}`,
      SortName: `remote static ${name}`, Path: `Z:\\RemoteStatic\\${name}.strm`,
      PresentationUniqueKey: itemId.replaceAll('-', ''),
      Data: JSON.stringify({ VideoType: 'VideoFile', IsHD: false, IsShortcut: true,
        ShortcutPath: (scheme === 'https' ? tlsOrigin : upstreamOrigin) + route, RemoteTrailers: [] }),
      RunTimeTicks: BigInt(template.RunTimeTicks),
    });
    for (const ancestor of libraryFixture.tables.AncestorIds.filter(row => row.ItemId === template.Id))
      await database.insert('AncestorIds', { ...ancestor, ItemId: itemId });
  }
}

function upstreamServer(requests, tlsOrigin, origins) {
  let closeOnceCount = 0;
  return createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.range ?? null, request.headers['if-range'] ?? null,
      request.headers['user-agent'] ?? null, request.headers.authorization ?? null,
      request.headers.accept ?? null, request.headers['accept-encoding'] ?? null, request.headers.host ?? null]);
    const common = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska', ETag: '"remote-tag"',
      'Last-Modified': 'Sun, 27 Sep 2026 12:00:00 GMT', 'X-Upstream-Only': 'not-forwarded' };
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/full', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-partial') { response.writeHead(302, { Location: '/partial', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-loop') { response.writeHead(302, { Location: '/redirect-loop', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-tls') { response.writeHead(302, { Location: tlsOrigin + '/full', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-other-host') { response.writeHead(302, { Location: origins.crossHost + '/partial', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-cross-return') { response.writeHead(302, { Location: origins.crossHost + '/return-first', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/return-first') { response.writeHead(302, { Location: origins.upstream + '/full', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-file-scheme') {
      response.writeHead(302, { Location: 'file:///C:/isolated-oracle/not-a-network-source', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-300') { response.writeHead(300, { Location: '/full', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-301') { response.writeHead(301, { Location: '/partial', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-303') { response.writeHead(303, { Location: origins.crossHost + '/partial', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/nested/redirect-307') { response.writeHead(307, { Location: '../partial', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-308') { response.writeHead(308, { Location: origins.crossHost + '/return-first', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-302-no-location') { response.writeHead(302, { 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/redirect-305') { response.writeHead(305, { Location: '/full', 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/close-before-headers') { request.socket.destroy(); return; }
    if (request.url === '/close-once' && closeOnceCount++ === 0) { request.socket.destroy(); return; }
    if (request.url === '/truncated-length' || request.url === '/truncated-chunked') {
      response.writeHead(200, {
        ...common,
        ...(request.url === '/truncated-length' ? { 'Content-Length': String(payload.length) } : {}),
      });
      response.write(payload.subarray(0, 8), () => setTimeout(() => response.socket?.destroy(), 20));
      return;
    }
    if (request.url === '/chunked') { response.writeHead(200, { 'X-Upstream-Only': 'not-forwarded' }); response.write(payload.subarray(0, 8)); response.end(payload.subarray(8)); return; }
    if (request.url === '/error') {
      const bytes = Buffer.from('upstream temporarily unavailable');
      response.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': String(bytes.length), 'Accept-Ranges': 'none' });
      response.end(bytes); return;
    }
    if (request.url === '/unsatisfied') { response.writeHead(416, { ...common, 'Content-Range': `bytes */${payload.length}`, 'Content-Length': '0' }); response.end(); return; }
    if (request.url === '/partial') {
      const bytes = payload.subarray(4, 9);
      response.writeHead(206, { ...common, 'Content-Range': `bytes 4-8/${payload.length}`, 'Content-Length': String(bytes.length) });
      response.end(bytes); return;
    }
    if (request.url === '/partial-no-accept') {
      const bytes = payload.subarray(4, 9);
      response.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': `bytes 4-8/${payload.length}`,
        'Content-Length': String(bytes.length) });
      response.end(bytes); return;
    }
    if (request.url === '/invalid-content-range') {
      const bytes = payload.subarray(4, 9);
      response.writeHead(206, { ...common, 'Content-Range': 'not-a-content-range', 'Content-Length': String(bytes.length) });
      response.end(bytes); return;
    }
    if (request.url === '/invalid-content-type') {
      response.writeHead(200, { ...common, 'Content-Type': 'not-a-media-type', 'Content-Length': String(payload.length) });
      response.end(payload); return;
    }
    const compressed = {
      '/compressed-gzip': ['gzip', gzipSync(payload)],
      '/compressed-deflate': ['deflate', deflateSync(payload)],
      '/compressed-br': ['br', brotliCompressSync(payload)],
      '/compressed-partial': ['gzip', gzipSync(payload.subarray(4, 9))],
    }[request.url];
    if (compressed) {
      const [encoding, bytes] = compressed;
      response.writeHead(request.url === '/compressed-partial' ? 206 : 200, {
        ...common, 'Content-Encoding': encoding, 'Content-Length': String(bytes.length),
        ...(request.url === '/compressed-partial' ? { 'Content-Range': `bytes 4-8/${payload.length}` } : {}),
      });
      response.end(bytes); return;
    }
    if (request.url === '/unknown-encoding') {
      response.writeHead(200, { ...common, 'Content-Encoding': 'constructor', 'Content-Length': String(payload.length) });
      response.end(payload); return;
    }
    const layered = {
      '/corrupt-gzip': ['gzip', Buffer.from('not-gzip-payload')],
      '/stacked-gzip-br': ['gzip, br', brotliCompressSync(gzipSync(payload))],
      '/stacked-br-gzip': ['br, gzip', gzipSync(brotliCompressSync(payload))],
    }[request.url];
    if (layered) {
      const [encoding, bytes] = layered;
      response.writeHead(200, { ...common, 'Content-Encoding': encoding, 'Content-Length': String(bytes.length) });
      response.end(bytes); return;
    }
    response.writeHead(200, { ...common, 'Content-Length': String(payload.length) }); response.end(payload);
  });
}

test('frozen native HTTP(S) .strm static byte proxy on PostgreSQL',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const servers = [];
    // Own listeners before any bind can fail, including an unavailable host
    // alias. A setup failure must not keep this test process alive indefinitely.
    t.after(async () => {
      const errors = [];
      for (const server of servers.toReversed()) {
        try {
          server.closeAllConnections();
          if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Remote static fixture listeners failed to close.');
    });
    const tlsRequests = [];
    const tlsUpstream = createHttpsServer({ cert: tlsCertificate, key: tlsKey }, (request, response) => {
      tlsRequests.push(request.url);
      response.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes' });
      response.end(payload);
    });
    servers.push(tlsUpstream);
    tlsUpstream.listen(0, '127.0.0.1'); await once(tlsUpstream, 'listening');
    const tlsOrigin = `https://127.0.0.1:${tlsUpstream.address().port}`;
    const requests = [], origins = {};
    const upstream = upstreamServer(requests, tlsOrigin, origins);
    servers.push(upstream);
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
    const crossHostOrigin = `http://127.0.0.2:${upstream.address().port}`;
    Object.assign(origins, { upstream: upstreamOrigin, crossHost: crossHostOrigin });
    const crossUpstream = upstreamServer(requests, tlsOrigin, origins);
    servers.push(crossUpstream);
    crossUpstream.listen(upstream.address().port, '127.0.0.2'); await once(crossUpstream, 'listening');
    let database, runtime;
    const candidateRecords = [];
    const schema = `remote_static_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    try {
      database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
      await seed(database, upstreamOrigin, tlsOrigin);
      runtime = await createRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
        serverId: libraryFixture.serverId, programDataPath: libraryFixture.programDataPath });
      const user = await runtime.users.createUser({ Name: 'CoreFlowAdmin', Password: 'isolated-core-flow-password' });
      await runtime.users.updatePolicy(user.Id, { ...libraryFixture.user.Policy });
      runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
      const origin = `http://127.0.0.1:${runtime.server.address().port}`;
      const authorization = token => `MediaBrowser Client="RemoteStaticOracle", Device="Isolated", DeviceId="remote-static-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
      const login = await fetch(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization() },
        body: JSON.stringify({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' }) });
      assert.equal(login.status, 200);
      const token = (await login.json()).AccessToken;
      for (const native of nativeContract) {
        const { itemId, method, requestHeaders, ...expected } = native;
        const route = `/Videos/${itemId}/stream?static=true&mediaSourceId=${itemId.replaceAll('-', '')}`;
        const before = requests.length;
        const response = await fetch(origin + route, { method,
          headers: { 'Accept-Encoding': 'identity', Authorization: authorization(native.name === 'unauthorized' ? null : token),
            ...requestHeaders } });
        const chunks = [];
        let bodyReadError = null;
        try {
          for await (const chunk of response.body ?? []) chunks.push(Buffer.from(chunk));
        } catch (error) {
          bodyReadError = error;
        }
        if (!Object.hasOwn(expected, 'complete') && bodyReadError) throw bodyReadError;
        const bytes = Buffer.concat(chunks);
        const actual = { name: native.name, status: response.status, size: bytes.length, sha256: digest(bytes),
          headers: Object.fromEntries(comparedHeaders.filter(key => response.headers.has(key)).map(key => [key, response.headers.get(key)])),
          requests: requests.slice(before).map(([method, url, range, ifRange]) => [method, url, range, ifRange]) };
        if (Object.hasOwn(expected, 'complete')) actual.complete = bodyReadError == null;
        if (Object.hasOwn(expected, 'hosts')) actual.hosts = requests.slice(before).map(entry => entry[8]?.split(':')[0] ?? null);
        candidateRecords.push({ name: native.name, expected, actual, upstreamRequests: requests.slice(before) });
        assert.deepEqual(actual, expected, native.name);
        assert.equal(requests.slice(before).every(entry => entry[4] === 'Jellyfin-Server/13.0.0'), true, `${native.name}: native User-Agent`);
        assert.equal(requests.slice(before).every(entry => entry[5] === null), true, `${native.name}: API token must not reach the remote source`);
        assert.equal(requests.slice(before).every(entry => entry[6] === 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8'), true,
          `${native.name}: native Accept`);
        assert.equal(requests.slice(before).every(entry => entry[7] === 'gzip, deflate, br'), true,
          `${native.name}: native Accept-Encoding`);
        assert.equal(response.headers.has('x-upstream-only'), false, `${native.name}: do not forward arbitrary upstream headers`);
        assert.equal(response.headers.has('location'), false, `${native.name}: the native helper never forwards Location`);
        if (native.name === 'https-untrusted' || native.name === 'redirect-to-untrusted-https')
          assert.deepEqual(tlsRequests, [], 'Untrusted TLS must fail before an HTTP request reaches the upstream.');
      }
    } finally {
      try {
        if (process.env.MEDIAMANAGER_REMOTE_STATIC_EVIDENCE) {
          const output = process.env.MEDIAMANAGER_REMOTE_STATIC_EVIDENCE;
          await mkdir(output, { recursive: true });
          await writeFile(path.join(output, 'postgres.json'), JSON.stringify({ engine: 'postgres', candidateRecords }, null, 2) + '\n', { flag: 'wx' });
        }
      } finally {
        if (database) {
          await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
          await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
        }
        if (runtime) await runtime.close(); else await database?.close();
      }
    }
  });

test('remote static proxy closes its upstream stream when the client disconnects', async () => {
  let upstreamClosed = false;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write(Buffer.alloc(8192, 0x61));
    const timer = setInterval(() => response.write(Buffer.alloc(8192, 0x62)), 10);
    response.once('close', () => { clearInterval(timer); upstreamClosed = true; });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createServer((request, response) => {
    remoteStaticStreamResult(`http://127.0.0.1:${upstream.address().port}/slow`).send(request, response)
      .catch(error => response.destroy(error));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/slow`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    for (let attempt = 0; attempt < 100 && !upstreamClosed; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(upstreamClosed, true);
  } finally {
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('remote static proxy reads HTTPS bytes when the isolated test certificate is trusted', async () => {
  const requests = [];
  const upstream = createHttpsServer({ cert: tlsCertificate, key: tlsKey }, (request, response) => {
    requests.push({ url: request.url, accept: request.headers.accept, encoding: request.headers['accept-encoding'] });
    response.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': String(payload.length) });
    response.end(payload);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createServer((request, response) => {
    remoteStaticStreamResult(`https://127.0.0.1:${upstream.address().port}/full`).send(request, response)
      .catch(error => response.destroy(error));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const trusted = getCACertificates('default');
  try {
    setDefaultCACertificates([...trusted, tlsCertificate.toString('utf8')]);
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/full`, { headers: { 'Accept-Encoding': 'identity' } });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(digest(bytes), digest(payload));
    assert.equal(response.headers.get('content-type'), 'video/x-matroska');
    assert.deepEqual(requests, [{ url: '/full', accept: 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8',
      encoding: 'gzip, deflate, br' }]);
  } finally {
    setDefaultCACertificates(trusted);
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
