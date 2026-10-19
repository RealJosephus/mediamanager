import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
// Isolated frozen-Jellyfin oracle for HTTP(S) .strm static playback.
// The reference runtime and source database are copied; neither is modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArgument, nativePortArgument, upstreamPortArgument, tlsPortArgument] = process.argv.slice(2);
if (!outputArgument || !nativePortArgument || !upstreamPortArgument || !tlsPortArgument) {
  throw new Error('Usage: node tools/compat/record-remote-static.js <new-evidence-directory> <native-port> <upstream-port> <tls-port>');
}
const evidence = validationPath(path.resolve(repo, outputArgument));
const allowedRoot = validationOutputRoot();
if (evidence === allowedRoot || !evidence.startsWith(allowedRoot + path.sep) || existsSync(evidence)) {
  throw new Error('Evidence must be a new child directory of the configured validation output root.');
}
const nativePort = Number(nativePortArgument), upstreamPort = Number(upstreamPortArgument), tlsPort = Number(tlsPortArgument);
if (![nativePort, upstreamPort, tlsPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
    new Set([nativePort, upstreamPort, tlsPort]).size !== 3) {
  throw new Error('Three distinct non-privileged loopback ports are required.');
}
const sourceRoot = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repo, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const reference = path.join(evidence, 'reference');
const databasePath = path.join(reference, 'data/data/jellyfin.db');
const dotnet = validationExecutable('dotnet');
const dll = validationPath(path.join(repo, '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const origin = `http://127.0.0.1:${nativePort}`;
const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
const crossHostOrigin = `http://127.0.0.2:${upstreamPort}`;
const tlsOrigin = `https://127.0.0.1:${tlsPort}`;
const tlsCertificate = validationPath(path.join(repo, 'tests/playback/fixtures/localhost-tls.crt'));
const tlsKey = validationPath(path.join(repo, 'tests/playback/fixtures/localhost-tls.key'));
const adminId = '5C6B5F77-BEA9-4A9A-98AA-FAE5909892B7';
const password = 'isolated-core-flow-password';
const payload = Buffer.from('native-remote-static-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cases = [
  { name: 'full', id: '94000000-0000-0000-0000-000000000001', route: '/full' },
  { name: 'partial', id: '94000000-0000-0000-0000-000000000002', route: '/partial', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'redirect', id: '94000000-0000-0000-0000-000000000003', route: '/redirect' },
  { name: 'chunked', id: '94000000-0000-0000-0000-000000000004', route: '/chunked' },
  { name: 'upstream-503', id: '94000000-0000-0000-0000-000000000005', route: '/error' },
  { name: 'upstream-416', id: '94000000-0000-0000-0000-000000000006', route: '/unsatisfied', headers: { Range: 'bytes=1000-' } },
  { name: 'redirect-range', id: '94000000-0000-0000-0000-000000000007', route: '/redirect-partial', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'partial-no-accept', id: '94000000-0000-0000-0000-000000000008', route: '/partial-no-accept', headers: { Range: 'bytes=4-8' } },
  { name: 'redirect-loop', id: '94000000-0000-0000-0000-000000000009', route: '/redirect-loop' },
  { name: 'compressed-gzip', id: '94000000-0000-0000-0000-000000000010', route: '/compressed-gzip' },
  { name: 'compressed-deflate', id: '94000000-0000-0000-0000-000000000011', route: '/compressed-deflate' },
  { name: 'compressed-br', id: '94000000-0000-0000-0000-000000000012', route: '/compressed-br' },
  { name: 'compressed-partial', id: '94000000-0000-0000-0000-000000000013', route: '/compressed-partial', headers: { Range: 'bytes=4-8' } },
  { name: 'unknown-encoding', id: '94000000-0000-0000-0000-000000000014', route: '/unknown-encoding' },
  { name: 'https-untrusted', id: '94000000-0000-0000-0000-000000000015', target: tlsOrigin + '/full' },
  { name: 'redirect-to-untrusted-https', id: '94000000-0000-0000-0000-000000000016', route: '/redirect-tls' },
  { name: 'close-before-headers', id: '94000000-0000-0000-0000-000000000017', route: '/close-before-headers' },
  { name: 'close-once', id: '94000000-0000-0000-0000-000000000018', route: '/close-once' },
  { name: 'truncated-length', id: '94000000-0000-0000-0000-000000000019', route: '/truncated-length' },
  { name: 'truncated-chunked', id: '94000000-0000-0000-0000-000000000020', route: '/truncated-chunked' },
  { name: 'corrupt-gzip', id: '94000000-0000-0000-0000-000000000021', route: '/corrupt-gzip' },
  { name: 'stacked-gzip-br', id: '94000000-0000-0000-0000-000000000022', route: '/stacked-gzip-br' },
  { name: 'stacked-br-gzip', id: '94000000-0000-0000-0000-000000000023', route: '/stacked-br-gzip' },
  { name: 'redirect-other-host', id: '94000000-0000-0000-0000-000000000024', route: '/redirect-other-host', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'redirect-cross-return', id: '94000000-0000-0000-0000-000000000025', route: '/redirect-cross-return' },
  { name: 'redirect-file-scheme', id: '94000000-0000-0000-0000-000000000026', route: '/redirect-file-scheme' },
  { name: 'redirect-300', id: '94000000-0000-0000-0000-000000000027', route: '/redirect-300' },
  { name: 'redirect-301-range', id: '94000000-0000-0000-0000-000000000028', route: '/redirect-301', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'redirect-303-cross-host', id: '94000000-0000-0000-0000-000000000029', route: '/redirect-303', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'redirect-307-relative', id: '94000000-0000-0000-0000-000000000030', route: '/nested/redirect-307', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'redirect-308-cross-return', id: '94000000-0000-0000-0000-000000000031', route: '/redirect-308' },
  { name: 'redirect-302-no-location', id: '94000000-0000-0000-0000-000000000032', route: '/redirect-302-no-location' },
  { name: 'redirect-305', id: '94000000-0000-0000-0000-000000000033', route: '/redirect-305' },
  { name: 'invalid-content-range', id: '94000000-0000-0000-0000-000000000034', route: '/invalid-content-range', headers: { Range: 'bytes=4-8' } },
  { name: 'invalid-content-type', id: '94000000-0000-0000-0000-000000000035', route: '/invalid-content-type' },
  { name: 'range-ignored', id: '94000000-0000-0000-0000-000000000001', route: '/full', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'invalid-range', id: '94000000-0000-0000-0000-000000000001', route: '/full', headers: { Range: 'bytes=not-a-range' } },
  { name: 'head-partial', id: '94000000-0000-0000-0000-000000000002', route: '/partial', method: 'HEAD', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
  { name: 'head', id: '94000000-0000-0000-0000-000000000001', route: '/full', method: 'HEAD' },
  { name: 'head-redirect-307', id: '94000000-0000-0000-0000-000000000030', route: '/nested/redirect-307', method: 'HEAD', headers: { Range: 'bytes=4-8', 'If-Range': '"remote-tag"' } },
];

async function available(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else files.push(item);
  }
  return files;
}

async function prepareReference() {
  await mkdir(evidence);
  await cp(sourceRoot, reference, { recursive: true, filter(source) {
    const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
    return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
  } });
  await mkdir(path.join(reference, 'log'), { recursive: true });
  await cp(sourceDatabase, databasePath, { force: false, errorOnExist: true });
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(reference)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const oldPath of sourceForms) content = content.replaceAll(oldPath, reference);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_, name) => `<${name}>${nativePort}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }
  const shortcutDirectory = path.join(reference, 'library-content');
  await mkdir(shortcutDirectory, { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    const template = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get('22222222-2222-2222-2222-222222222222');
    assert.ok(template);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of cases.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)) {
        const shortcutPath = path.join(shortcutDirectory, `${entry.name}.strm`);
        const target = entry.target ?? upstreamOrigin + entry.route;
        await writeFile(shortcutPath, target + '\n');
        const row = { ...template, Id: entry.id.toUpperCase(), Name: `Remote Static ${entry.name}`,
          CleanName: `remote static ${entry.name}`, SortName: `remote static ${entry.name}`,
          Path: shortcutPath, PresentationUniqueKey: entry.id.replaceAll('-', '').toLowerCase(),
          Data: JSON.stringify({ VideoType: 'VideoFile', IsHD: false, IsShortcut: true,
            ShortcutPath: target, RemoteTrailers: [] }) };
        const columns = Object.keys(row);
        const quoted = column => `"${column.replaceAll('"', '""')}"`;
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quoted).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(column => row[column]));
        database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") SELECT ?, "ParentItemId" FROM "AncestorIds" WHERE "ItemId" = ?')
          .run(row.Id, template.Id);
      }
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
}

function startUpstream(requests) {
  let closeOnceCount = 0;
  return createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    const common = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/x-matroska', ETag: '"remote-tag"',
      'Last-Modified': 'Sun, 27 Sep 2026 12:00:00 GMT', 'X-Upstream-Only': 'not-forwarded' };
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/full', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-partial') {
      response.writeHead(302, { Location: '/partial', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-loop') {
      response.writeHead(302, { Location: '/redirect-loop', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-tls') {
      response.writeHead(302, { Location: tlsOrigin + '/full', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-other-host') {
      response.writeHead(302, { Location: crossHostOrigin + '/partial', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-cross-return') {
      response.writeHead(302, { Location: crossHostOrigin + '/return-first', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/return-first') {
      response.writeHead(302, { Location: upstreamOrigin + '/full', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-file-scheme') {
      response.writeHead(302, { Location: 'file:///C:/isolated-oracle/not-a-network-source', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-300') {
      response.writeHead(300, { Location: '/full', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-301') {
      response.writeHead(301, { Location: '/partial', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-303') {
      response.writeHead(303, { Location: crossHostOrigin + '/partial', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/nested/redirect-307') {
      response.writeHead(307, { Location: '../partial', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-308') {
      response.writeHead(308, { Location: crossHostOrigin + '/return-first', 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-302-no-location') {
      response.writeHead(302, { 'Content-Length': '0' }); response.end(); return;
    }
    if (request.url === '/redirect-305') {
      response.writeHead(305, { Location: '/full', 'Content-Length': '0' }); response.end(); return;
    }
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
    if (request.url === '/chunked') {
      response.writeHead(200, { 'X-Upstream-Only': 'not-forwarded' });
      response.write(payload.subarray(0, 8)); response.end(payload.subarray(8)); return;
    }
    if (request.url === '/error') {
      const bytes = Buffer.from('upstream temporarily unavailable');
      response.writeHead(503, { 'Content-Type': 'text/plain', 'Content-Length': String(bytes.length), 'Accept-Ranges': 'none' });
      response.end(bytes); return;
    }
    if (request.url === '/unsatisfied') {
      response.writeHead(416, { ...common, 'Content-Range': `bytes */${payload.length}`, 'Content-Length': '0' });
      response.end(); return;
    }
    if (request.url === '/partial') {
      const bytes = payload.subarray(4, 9);
      response.writeHead(206, { ...common, 'Content-Range': `bytes 4-8/${payload.length}`, 'Content-Length': String(bytes.length) });
      response.end(bytes); return;
    }
    if (request.url === '/partial-no-accept') {
      const bytes = payload.subarray(4, 9);
      response.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': `bytes 4-8/${payload.length}`, 'Content-Length': String(bytes.length) });
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
    response.writeHead(200, { ...common, 'Content-Length': String(payload.length) });
    response.end(payload);
  });
}

function startReference() {
  const stdout = openSync(path.join(evidence, 'reference-stdout.log'), 'wx');
  const stderr = openSync(path.join(evidence, 'reference-stderr.log'), 'wx');
  const child = spawn(dotnet, [dll, '--datadir', path.join(reference, 'data'), '--configdir', path.join(reference, 'config'),
    '--cachedir', path.join(reference, 'cache'), '--logdir', path.join(reference, 'log'), '--nowebclient'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', stdout, stderr],
  });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: { name: error.name, message: error.message } }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, closeDescriptors() { closeSync(stdout); closeSync(stderr); } };
}

async function waitForReady(instance) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode ?? instance.child.signalCode}`);
    }
    try {
      const startupLog = await readFile(path.join(evidence, 'reference-stdout.log'), 'utf8');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1000) });
      const ready = startupLog.includes('Main: Startup complete') && response.ok;
      await response.body?.cancel();
      if (ready) return;
    }
    catch { /* Wait for the frozen process to bind. */ }
    await delay(500);
  }
  throw new Error('Frozen reference did not become ready.');
}

const authorization = token => `MediaBrowser Client="RemoteStaticOracle", Device="Isolated", DeviceId="remote-static-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
async function request(route, { method = 'GET', token, headers = {}, body } = {}) {
  const response = await fetch(origin + route, { method, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: authorization(token), ...headers,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const chunks = [];
  let bodyReadError = null;
  try {
    for await (const chunk of response.body ?? []) chunks.push(Buffer.from(chunk));
  } catch (error) {
    bodyReadError = { name: error.name, message: error.message };
  }
  const bytes = Buffer.concat(chunks);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* Binary response. */ }
  return { status: response.status, headers: Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))),
    size: bytes.length, sha256: sha256(bytes), bodyText: bytes.length <= 256 ? bytes.toString('utf8') : null,
    bodyReadError,
    ...(parsed === undefined ? {} : { bodyJson: parsed }) };
}

assert.equal(await available(nativePort), true, 'Native loopback port is occupied.');
assert.equal(await available(upstreamPort), true, 'Upstream loopback port is occupied.');
assert.equal(await available(upstreamPort, '127.0.0.2'), true, 'Cross-host loopback port is occupied.');
assert.equal(await available(tlsPort), true, 'TLS loopback port is occupied.');
await prepareReference();
const upstreamRequests = [];
const upstream = startUpstream(upstreamRequests);
const crossUpstream = startUpstream(upstreamRequests);
const tlsRequests = [];
const tlsUpstream = createHttpsServer({ cert: await readFile(tlsCertificate), key: await readFile(tlsKey) }, (request, response) => {
  tlsRequests.push({ method: request.method, url: request.url, headers: request.headers });
  response.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes' });
  response.end(payload);
});
let instance, token, outcomeError, processResult;
const records = [];
try {
  await new Promise((resolve, reject) => upstream.once('error', reject).listen(upstreamPort, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => crossUpstream.once('error', reject).listen(upstreamPort, '127.0.0.2', resolve));
  await new Promise((resolve, reject) => tlsUpstream.once('error', reject).listen(tlsPort, '127.0.0.1', resolve));
  instance = startReference();
  await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password } });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  assert.equal(login.bodyJson.User.Id.replaceAll('-', '').toLowerCase(), adminId.replaceAll('-', '').toLowerCase());
  token = login.bodyJson.AccessToken;
  for (const entry of cases) {
    const before = upstreamRequests.length;
    const route = `/Videos/${entry.id}/stream?static=true&mediaSourceId=${entry.id.replaceAll('-', '')}`;
    const response = await request(route, { method: entry.method, token, headers: entry.headers });
    records.push({ name: entry.name, itemId: entry.id, method: entry.method ?? 'GET', route,
      requestHeaders: entry.headers ?? {}, response, upstreamRequests: upstreamRequests.slice(before) });
  }
  const beforeUnauthorized = upstreamRequests.length;
  const unauthorized = await request(`/Videos/${cases[0].id}/stream?static=true`);
  records.push({ name: 'unauthorized', response: unauthorized, upstreamRequests: upstreamRequests.slice(beforeUnauthorized) });
} catch (error) { outcomeError = error; }
finally {
  if (instance) {
    if (token && instance.child.exitCode === null) {
      try { await request('/System/Shutdown', { method: 'POST', token }); }
      catch (error) { outcomeError ??= error; }
    }
    processResult = await Promise.race([instance.completion, delay(20000).then(() => null)]);
    if (!processResult && instance.child.exitCode === null) {
      instance.child.kill();
      processResult = await Promise.race([instance.completion, delay(10000).then(() => null)]);
    }
    instance.closeDescriptors();
  }
  if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
  if (crossUpstream.listening) await new Promise(resolve => crossUpstream.close(resolve));
  if (tlsUpstream.listening) await new Promise(resolve => tlsUpstream.close(resolve));
  await writeFile(path.join(evidence, 'native-http.json'), json({ origin, upstreamOrigin, crossHostOrigin, tlsOrigin, records, upstreamRequests, tlsRequests }), { flag: 'wx' });
  const summary = { passed: !outcomeError && processResult?.code === 0 && await available(nativePort) && await available(upstreamPort) && await available(upstreamPort, '127.0.0.2') && await available(tlsPort),
    cases: records.length, upstreamRequestCount: upstreamRequests.length, tlsRequestCount: tlsRequests.length, processResult,
    nativePortAvailable: await available(nativePort), upstreamPortAvailable: await available(upstreamPort),
    crossHostPortAvailable: await available(upstreamPort, '127.0.0.2'), tlsPortAvailable: await available(tlsPort),
    inputSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sourceDatabaseSha256: sha256(await readFile(sourceDatabase)), dllSha256: sha256(await readFile(dll)),
    error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null };
  await writeFile(path.join(evidence, 'summary.json'), json(summary), { flag: 'wx' });
  if (!summary.passed) throw new Error(`Remote static oracle failed: ${JSON.stringify(summary.error ?? summary.processResult)}`);
  console.log(JSON.stringify({ evidence: path.relative(repo, evidence), cases: records.length, upstreamRequestCount: upstreamRequests.length,
    tlsRequestCount: tlsRequests.length, processResult, nativePortAvailable: summary.nativePortAvailable,
    upstreamPortAvailable: summary.upstreamPortAvailable, tlsPortAvailable: summary.tlsPortAvailable }));
}
