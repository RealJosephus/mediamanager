import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { StorageError } from '../storage/errors.js';
import { joinPath, normalizePath, validateName } from '../storage/paths.js';
import { singleRange } from '../storage/range.js';

const playlistLimit = 4 * 1024 * 1024;

function checkMappedPlaylist(text, url, root) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const references = line.startsWith('#') ? [...line.slice(line.indexOf(':') + 1)
      .matchAll(/(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/gu)]
      .filter(([, name]) => name === 'URI' || name.endsWith('-URI')).map(([, , quoted, unquoted]) => quoted ?? unquoted) : [line];
    for (const reference of references) {
      const target = URL.parse(reference, url);
      if (!target || target.origin !== url.origin || !target.pathname.startsWith(root)
        || /^[\/\\]|^[A-Za-z][A-Za-z0-9+.-]*:|[\\\u0000-\u001f]|\{\$/u.test(reference.trim())) {
        throw new StorageError('permission-denied', 'A mapped HLS reference must stay inside its storage mount.');
      }
    }
  }
}

async function* mappedHlsBody(stream, url, root) {
  const parts = [];
  let size = 0, playlist;
  for await (const bytes of stream) {
    if (playlist === false) { yield bytes; continue; }
    parts.push(bytes);
    size += bytes.byteLength;
    if (playlist === undefined && size >= 10) {
      // FFmpeg requires the EXTM3U magic in every playlist, including children
      // with extensionless names. Media bytes remain streaming.
      playlist = Buffer.concat(parts, 10).toString('utf8').replace(/^\ufeff/u, '').startsWith('#EXTM3U');
      if (!playlist) { yield* parts; parts.length = 0; }
    }
    if (playlist && size > playlistLimit) throw new StorageError('invalid-response', 'The mapped HLS playlist is too large.');
  }
  if (playlist) checkMappedPlaylist(Buffer.concat(parts, size).toString('utf8'), url, root);
  yield* parts;
}

/** Private forward-only original bytes for ffprobe. Each HTTP request owns an
 * independent byte reader; it never creates another public open consumer. */
export class LiveStreamReadBridge {
  #server;
  #starting;
  #origin;
  #closed = false;
  #leases = new Map();
  #requests = new Set();
  #closeFailures = [];
  #closing;

  async #start() {
    if (this.#closed) throw new Error('The live stream probe bridge is closed.');
    return this.#starting ??= (async () => {
      this.#server = http.createServer((request, response) => {
        const pending = this.#serve(request, response); this.#requests.add(pending);
        void pending.finally(() => this.#requests.delete(pending)).catch(() => {});
      });
      this.#server.requestTimeout = 0; this.#server.headersTimeout = 10000;
      this.#server.listen(0, '127.0.0.1'); await once(this.#server, 'listening');
      this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
    })();
  }

  async lease(openRead, { signal } = {}) {
    if (typeof openRead !== 'function') throw new TypeError('A live probe bridge requires owned byte readers.');
    return this.#lease({ openRead }, signal);
  }

  async leaseMappedHls(vfs, filename, { signal } = {}) {
    filename = normalizePath(filename);
    const { mount, adapter } = vfs.resolve(filename);
    const suffix = filename.slice(mount.path === '/' ? 1 : mount.path.length + 1).split('/').map(encodeURIComponent).join('/');
    const openMapped = (relative, options) => {
      const parts = relative.split('/').map(name => validateName(decodeURIComponent(name)));
      const target = joinPath(mount.path, parts.join('/'));
      const resolved = vfs.resolve(target);
      if (resolved.mount !== mount || resolved.adapter !== adapter) throw new StorageError('permission-denied', 'The HLS storage mount changed.');
      return vfs.openRead(target, options);
    };
    return this.#lease({ suffix, openMapped }, signal);
  }

  async #lease(input, signal) {
    signal?.throwIfAborted(); await this.#start(); signal?.throwIfAborted();
    if (this.#closed) throw new Error('The live stream probe bridge is closed.');
    const token = randomBytes(32).toString('hex'), lifetime = new AbortController();
    const state = { ...input, signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal, requests: new Set(), failures: [] };
    let closing;
    const release = () => closing ??= (async () => {
      this.#leases.delete(token); lifetime.abort(); signal?.removeEventListener('abort', aborted);
      while (state.requests.size) await Promise.allSettled([...state.requests]);
      if (state.failures.length) throw new AggregateError(state.failures, 'A live probe byte reader failed to close.');
    })();
    const aborted = () => { void release().catch(() => {}); };
    state.release = release; this.#leases.set(token, state); signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { await release(); signal.throwIfAborted(); }
    return Object.freeze({ url: `${this.#origin}/${token}${input.suffix ? '/' + input.suffix : ''}`, release });
  }

  async #serve(request, response) {
    const match = /^\/([a-f0-9]{64})(?:\/([^?#]+)(?:\?[^#]*)?)?$/u.exec(request.url ?? '');
    const state = this.#leases.get(match?.[1]);
    const relative = match?.[2];
    if (!state || Boolean(relative) !== Boolean(state.openMapped) || state.signal.aborted) { response.writeHead(404); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    if (state.requests.size >= 8) { response.writeHead(429); response.end(); return; }
    const lifetime = new AbortController(), signal = AbortSignal.any([state.signal, lifetime.signal]);
    let handle;
    const aborted = () => { lifetime.abort(); void Promise.resolve(handle?.close()).catch(() => {}); };
    request.once('aborted', aborted); response.once('close', aborted); signal.addEventListener('abort', aborted, { once: true });
    const completion = Promise.withResolvers(); state.requests.add(completion.promise);
    try {
      response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Cache-Control', 'no-store');
      if (!relative && request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
      handle = await (relative ? state.openMapped(relative, { signal, range: singleRange(request.headers.range) }) : state.openRead({ signal }));
      signal.throwIfAborted();
      if (!handle?.stream?.[Symbol.asyncIterator]) throw new TypeError('The original input has no byte reader.');
      let stream = handle.stream;
      if (relative) {
        if (handle.contentLength != null) response.setHeader('Content-Length', String(handle.contentLength));
        if (handle.rangeHonored) {
          response.setHeader('Accept-Ranges', 'bytes');
          response.setHeader('Content-Range', `bytes ${handle.range.start}-${handle.range.end}/${handle.totalSize ?? '*'}`);
        }
        if (request.method === 'HEAD') { response.writeHead(handle.rangeHonored ? 206 : 200).end(); return; }
        stream = mappedHlsBody(stream, new URL(request.url, this.#origin), `/${match[1]}/`);
      }
      if (relative) response.statusCode = handle.rangeHonored ? 206 : 200;
      else response.writeHead(200);
      for await (const bytes of stream) {
        signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array)) throw new TypeError('An original stream must yield bytes.');
        if (!response.write(bytes)) await once(response, 'drain', { signal });
      }
      response.end();
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        response.removeHeader('Content-Length');
        response.removeHeader('Content-Range');
        const status = signal.aborted ? 499 : ({ 'not-found': 404, 'permission-denied': 403, 'range-not-satisfiable': 416 })[error?.code] ?? 502;
        response.writeHead(status).end();
      }
    } finally {
      request.removeListener('aborted', aborted); response.removeListener('close', aborted); signal.removeEventListener('abort', aborted);
      try { await handle?.close(); }
      catch (error) { state.failures.push(error); this.#closeFailures.push(error); }
      finally { state.requests.delete(completion.promise); completion.resolve(); }
    }
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => {
      if (this.#starting) await this.#starting;
      await Promise.allSettled([...this.#leases.values()].map(state => state.release()));
      while (this.#requests.size) await Promise.allSettled([...this.#requests]);
      if (this.#server) await new Promise((resolve, reject) => {
        this.#server.closeAllConnections(); this.#server.close(error => error ? reject(error) : resolve());
      });
      if (this.#closeFailures.length) throw new AggregateError(this.#closeFailures, 'Live probe byte readers failed to drain.');
    })();
  }
}
