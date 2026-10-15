import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { StorageError, checkAbort } from './errors.js';
import { normalizePath, baseName, parentPath } from './paths.js';

function parseRange(header) {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) throw new StorageError('range-not-satisfiable', 'The probe range is invalid.');
  if (!match[1]) {
    if (BigInt(match[2]) === 0n) throw new StorageError('range-not-satisfiable', 'The probe suffix is empty.');
    return { suffix: BigInt(match[2]) };
  }
  const range = { start: BigInt(match[1]) };
  if (match[2]) range.end = BigInt(match[2]);
  if (range.end !== undefined && range.end < range.start) throw new StorageError('range-not-satisfiable', 'The probe range is reversed.');
  return range;
}

// Private seekable VFS transport for probing and copy-only stream extraction.
export class ProbeReadBridge {
  #vfs;
  #server;
  #origin;
  #leases = new Map();
  #starting;
  #closed = false;
  #maxConcurrent;

  constructor(vfs, { maxConcurrentReads = 8 } = {}) {
    if (!Number.isSafeInteger(maxConcurrentReads) || maxConcurrentReads < 1) throw new TypeError('A positive read concurrency limit is required.');
    this.#vfs = vfs;
    this.#maxConcurrent = maxConcurrentReads;
  }

  async start() {
    if (this.#closed) throw new StorageError('closed', 'The probe bridge is closed.');
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      this.#server = http.createServer((request, response) => { void this.#serve(request, response); });
      this.#server.requestTimeout = 30000;
      this.#server.headersTimeout = 10000;
      this.#server.listen(0, '127.0.0.1');
      await once(this.#server, 'listening');
      this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
    })();
    return this.#starting;
  }

  async lease(path, { signal, expiresInMs = 60000, version, relatedPaths = [] } = {}) {
    checkAbort(signal);
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1) throw new TypeError('A positive lease lifetime is required.');
    path = normalizePath(path);
    await this.start();
    const info = await this.#vfs.stat(path, { signal });
    checkAbort(signal);
    if (this.#closed) throw new StorageError('closed', 'The probe bridge is closed.');
    if (info.kind !== 'file') throw new StorageError('is-directory', 'A probe lease requires a file.');
    if (version != null && info.version !== version) throw new StorageError('version-changed', 'The leased object changed before it was opened.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + expiresInMs;
    const objects = new Map();
    const object = { path, version: version ?? info.version };
    objects.set(relatedPaths.length ? encodeURIComponent(baseName(path)) : '', object);
    for (const related of relatedPaths) {
      const relatedPath = normalizePath(related);
      if (parentPath(relatedPath) !== parentPath(path)) throw new StorageError('invalid-path', 'Related probe objects must share their directory.');
      const relatedInfo = await this.#vfs.stat(relatedPath, { signal });
      if (relatedInfo.kind !== 'file') throw new StorageError('is-directory', 'Related probe objects must be files.');
      objects.set(encodeURIComponent(baseName(relatedPath)), { path: relatedPath, version: relatedInfo.version });
    }
    const lease = { ...object, objects, expiresAt, reads: new Set(), release: null };
    let timer;
    const release = async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.#leases.delete(token);
      for (const controller of lease.reads) controller.abort();
    };
    const onAbort = () => { void release(); };
    lease.release = release;
    this.#leases.set(token, lease);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, expiresInMs);
    timer.unref();
    return { url: `${this.#origin}/${token}${relatedPaths.length ? '/' + encodeURIComponent(baseName(path)) : ''}`, expiresAt, release,
      consistency: lease.version ? 'version-precondition' : 'unversioned' };
  }

  async #serve(request, response) {
    let lease;
    let controller;
    let handle;
    const stop = () => controller?.abort();
    try {
      const match = /^\/([a-f0-9]{64})(?:\/([^/]+))?$/u.exec(request.url ?? '');
      const token = match?.[1];
      lease = this.#leases.get(token);
      if (!lease || Date.now() >= lease.expiresAt) { response.writeHead(404); response.end(); return; }
      const object = lease.objects.get(match?.[2] ?? '');
      if (!object) { response.writeHead(404); response.end(); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
      if (lease.reads.size >= this.#maxConcurrent) { response.writeHead(429); response.end(); return; }
      controller = new AbortController();
      lease.reads.add(controller);
      request.once('aborted', stop);
      response.once('close', stop);
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'HEAD') {
        const info = await this.#vfs.stat(object.path, { signal: controller.signal });
        if (object.version && object.version !== info.version) throw new StorageError('version-changed', 'The leased object changed.');
        if (info.size !== null) response.setHeader('Content-Length', String(info.size));
        if (info.version) response.setHeader('ETag', info.version);
        response.setHeader('Accept-Ranges', this.#vfs.capabilities(object.path).randomRead === true ? 'bytes' : 'none');
        response.writeHead(200); response.end(); return;
      }
      handle = await this.#vfs.openRead(object.path, { signal: controller.signal, range: parseRange(request.headers.range),
        ifMatch: object.version ?? undefined, ifRange: request.headers['if-range'] });
      if (object.version && handle.version !== object.version) throw new StorageError('version-changed', 'The leased object changed during its read.');
      response.setHeader('Content-Type', handle.contentType ?? 'application/octet-stream');
      if (handle.contentLength !== null) response.setHeader('Content-Length', String(handle.contentLength));
      if (handle.version) response.setHeader('ETag', handle.version);
      if (handle.rangeHonored) {
        response.setHeader('Content-Range', `bytes ${handle.range.start}-${handle.range.end}/${handle.totalSize ?? '*'}`);
        response.setHeader('Accept-Ranges', 'bytes');
      }
      response.writeHead(handle.rangeHonored ? 206 : 200);
      for await (const chunk of handle.stream) {
        checkAbort(controller.signal);
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        const status = ({ 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403,
          'version-changed': 412, 'range-not-satisfiable': 416, 'not-supported': 502,
          cancelled: 499, timeout: 504 })[error.code] ?? 502;
        if (error.code === 'range-not-satisfiable' && error.details?.totalSize != null) response.setHeader('Content-Range', `bytes */${error.details.totalSize}`);
        response.writeHead(status); response.end();
      }
    } finally {
      request.removeListener('aborted', stop);
      response.removeListener('close', stop);
      if (controller) lease?.reads.delete(controller);
      try { await handle?.close(); }
      catch { response.destroy(); }
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#starting) await this.#starting;
    await Promise.all([...this.#leases.values()].map((lease) => lease.release()));
    if (this.#server) await new Promise((resolve, reject) => {
      this.#server.closeAllConnections();
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }
}
