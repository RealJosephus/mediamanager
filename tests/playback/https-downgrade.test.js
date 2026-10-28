import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { remoteStaticStreamResult } from '../../src/playback/remote-static.js';
import { openHttpStorage } from '../storage/http-fixture.js';

const certificate = await readFile(new URL('./fixtures/localhost-tls.crt', import.meta.url));
const key = await readFile(new URL('./fixtures/localhost-tls.key', import.meta.url));
const emptyDigest = createHash('sha256').update('').digest('hex');
const oracleRoot = fileURLToPath(new URL('./fixtures/https-downgrade-oracle/', import.meta.url));

async function directorySnapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const metadata = await lstat(filename);
      assert.equal(metadata.isSymbolicLink(), false, `Oracle source cannot contain links: ${relative}`);
      if (metadata.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await visit(filename);
      } else {
        const bytes = await readFile(filename);
        entries.push({ path: relative, type: 'file', size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function withDowngradeServers(callback) {
  const plainRequests = [], tlsRequests = [];
  const plain = createServer((request, response) => {
    plainRequests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('downgraded');
  });
  plain.listen(0, '127.0.0.1');
  await once(plain, 'listening');
  const plainUrl = `http://127.0.0.1:${plain.address().port}/insecure`;
  const secure = createHttpsServer({ cert: certificate, key }, (request, response) => {
    tlsRequests.push(request.url);
    response.writeHead(302, { Location: plainUrl, 'Content-Length': '0' });
    response.end();
  });
  try {
    secure.listen(0, '127.0.0.1');
    await once(secure, 'listening');
    const secureUrl = `https://127.0.0.1:${secure.address().port}/redirect`;
    await callback({ secureUrl, plainUrl, plainRequests, tlsRequests });
  } finally {
    secure.closeAllConnections();
    if (secure.listening) await new Promise(resolve => secure.close(resolve));
    plain.closeAllConnections();
    await new Promise(resolve => plain.close(resolve));
  }
}

async function runDotnetOracle(url) {
  const project = path.join(oracleRoot, 'Oracle.csproj');
  const fingerprint = new X509Certificate(certificate).fingerprint256;
  const sourceBefore = await directorySnapshot(oracleRoot);
  const buildRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-https-downgrade-'));
  let result;
  try {
    const child = spawn(process.env.MEDIAMANAGER_DOTNET, ['run', '--project', project, '--configuration', 'Release',
      `-p:BaseOutputPath=${path.join(buildRoot, 'bin')}${path.sep}`,
      `-p:BaseIntermediateOutputPath=${path.join(buildRoot, 'obj')}${path.sep}`,
      '--', url, fingerprint], { windowsHide: true, timeout: 30000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr || stdout);
    result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
    assert.deepEqual(await directorySnapshot(oracleRoot), sourceBefore,
      'The HTTPS downgrade oracle build must not alter its source fixture.');
  }
  return result;
}

test('the frozen runtime handler type does not follow a trusted HTTPS to HTTP downgrade', {
  skip: !process.env.MEDIAMANAGER_DOTNET,
}, async t => withDowngradeServers(async ({ secureUrl, plainUrl, plainRequests, tlsRequests }) => {
  const result = await runDotnetOracle(secureUrl);
  assert.deepEqual(result, { status: 302, requestUri: secureUrl, location: plainUrl, size: 0, sha256: emptyDigest });
  assert.deepEqual(tlsRequests, ['/redirect']);
  assert.deepEqual(plainRequests, []);
  t.diagnostic(JSON.stringify({ status: result.status, finalScheme: new URL(result.requestUri).protocol,
    locationScheme: new URL(result.location).protocol, tlsRequests: tlsRequests.length, plainRequests: plainRequests.length }));
}));

test('static remote proxy does not fetch an HTTP target after trusted HTTPS redirects', async t => {
  const storage = await openHttpStorage(); t.after(() => storage.close());
  await withDowngradeServers(async ({ secureUrl, plainRequests, tlsRequests }) => {
    const proxy = createServer((request, response) => {
      remoteStaticStreamResult(storage.vfs, storage.access(secureUrl)).send(request, response).catch(error => response.destroy(error));
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const trusted = getCACertificates('default');
    try {
      setDefaultCACertificates([...trusted, certificate.toString('utf8')]);
      const response = await fetch(`http://127.0.0.1:${proxy.address().port}/stream`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.equal(response.headers.has('location'), false);
      assert.equal(response.headers.get('accept-ranges'), 'none');
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(tlsRequests, ['/redirect']);
      assert.deepEqual(plainRequests, []);
      t.diagnostic(JSON.stringify({ status: response.status, forwardedLocation: response.headers.has('location'),
        tlsRequests: tlsRequests.length, plainRequests: plainRequests.length }));
    } finally {
      setDefaultCACertificates(trusted);
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
});

test('static remote proxy follows an HTTPS redirect to trusted HTTPS bytes', async t => {
  const storage = await openHttpStorage(); t.after(() => storage.close());
  const bytes = Buffer.from('trusted-https-redirect-bytes\n');
  const requests = [];
  const servers = [];
  const trusted = getCACertificates('default');
  try {
    const destination = createHttpsServer({ cert: certificate, key }, (request, response) => {
      requests.push(['destination', request.url]);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) });
      response.end(bytes);
    });
    servers.push(destination);
    destination.listen(0, '127.0.0.1');
    await once(destination, 'listening');
    const redirect = createHttpsServer({ cert: certificate, key }, (request, response) => {
      requests.push(['redirect', request.url]);
      response.writeHead(302, { Location: `https://127.0.0.1:${destination.address().port}/bytes`, 'Content-Length': '0' });
      response.end();
    });
    servers.push(redirect);
    redirect.listen(0, '127.0.0.1');
    await once(redirect, 'listening');
    const proxy = createServer((request, response) => {
      remoteStaticStreamResult(storage.vfs, storage.access(`https://127.0.0.1:${redirect.address().port}/redirect`)).send(request, response)
        .catch(error => response.destroy(error));
    });
    servers.push(proxy);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    setDefaultCACertificates([...trusted, certificate.toString('utf8')]);
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/stream`);
    const result = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(result).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.has('location'), false);
    assert.deepEqual(requests, [['redirect', '/redirect'], ['destination', '/bytes']]);
    t.diagnostic(JSON.stringify({ status: response.status, httpsRequests: requests.length, bytes: result.length }));
  } finally {
    setDefaultCACertificates(trusted);
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
});
