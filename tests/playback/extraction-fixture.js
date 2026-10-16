import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageError } from '../../src/storage/errors.js';
import { rangeHeader, resolveRange } from '../../src/storage/range.js';

// A conditional HTTP object fixture, never a production media backend.
export async function extractionFixture(files, { reliableVersion = true, advisoryVersion = false, delayMs = 0, chunkBytes, chunkDelayMs = 0 } = {}) {
  const objects = new Map(Object.entries(files).map(([name, bytes]) => [name, { bytes, revision: 1 }]));
  const requests = [];
  let closedReads = 0;
  const server = http.createServer((request, response) => {
    const entry = objects.get(request.url);
    requests.push({ method: request.method, path: request.url, range: request.headers.range, ifMatch: request.headers['if-match'], authorization: request.headers.authorization });
    if (!entry) { response.writeHead(404); response.end(); return; }
    const version = `"revision-${entry.revision}"`;
    if (request.headers['if-match'] && request.headers['if-match'] !== version) { response.writeHead(412); response.end(); return; }
    response.setHeader('ETag', version);
    response.setHeader('Accept-Ranges', 'bytes');
    let start = 0, end = entry.bytes.length - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end;
      if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${entry.bytes.length}` }); response.end(); return; }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${entry.bytes.length}`);
    }
    response.setHeader('Content-Length', end - start + 1);
    if (request.method === 'HEAD') { response.end(); return; }
    let finished = false;
    let chunks;
    const timer = setTimeout(() => {
      if (!chunkBytes) { finished = true; response.end(entry.bytes.subarray(start, end + 1)); return; }
      chunks = setInterval(() => {
        const next = Math.min(start + chunkBytes, end + 1); response.write(entry.bytes.subarray(start, next)); start = next;
        if (start > end) { finished = true; clearInterval(chunks); response.end(); }
      }, chunkDelayMs);
    }, delayMs);
    response.once('close', () => { clearTimeout(timer); clearInterval(chunks); if (!finished) closedReads++; });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = {
    capabilities: Object.freeze({ randomRead: true, reliableLength: true, reliableVersion, directorySnapshot: false,
      create: false, replace: false, mkdir: false, delete: false, rename: false, atomicReplace: false,
      conditionalWrite: false, directLease: false, watch: false }),
    async stat(path, { signal } = {}) {
      const response = await fetch(origin + path, { method: 'HEAD', signal });
      if (response.status === 404) throw new StorageError('not-found', 'Missing fixture object.');
      return { kind: 'file', name: path.split('/').at(-1), size: BigInt(response.headers.get('content-length')), version: reliableVersion || advisoryVersion ? response.headers.get('etag') : null };
    },
    async openRead(path, { range, ifMatch, signal } = {}) {
      const response = await fetch(origin + path, { headers: { ...(range ? { Range: rangeHeader(range) } : {}), ...(ifMatch ? { 'If-Match': ifMatch } : {}) }, signal });
      if (response.status === 412) throw new StorageError('version-changed', 'The fixture object changed.');
      if (response.status === 416) throw new StorageError('range-not-satisfiable', 'The fixture range is invalid.');
      const bytes = objects.get(path).bytes;
      const stream = Readable.fromWeb(response.body);
      return { stream, totalSize: BigInt(bytes.length), contentLength: BigInt(response.headers.get('content-length')), rangeHonored: response.status === 206,
        range: response.status === 206 ? resolveRange(range, bytes.length) : null, version: reliableVersion || advisoryVersion ? response.headers.get('etag') : null,
        async close() { stream.destroy(); } };
    },
    async listPage() { throw new Error('Enumeration is outside this fixture.'); },
    async health() { return { state: 'available' }; }, async close() {},
  };
  const registry = new StorageRegistry(); registry.registerType('network-fixture', () => adapter); await registry.createInstance('fixture', 'network-fixture', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Extraction', accessRoot: '/', style: 'windows', returnAccess: 'Isolated HTTP fixture only.' });
  return { vfs, identityMap, requests, adapter, get closedReads() { return closedReads; }, setDelay(value) { delayMs = value; },
    replace(name, bytes) { const current = objects.get(name); objects.set(name, { bytes, revision: (current?.revision ?? 0) + 1 }); },
    async close() { await registry.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
