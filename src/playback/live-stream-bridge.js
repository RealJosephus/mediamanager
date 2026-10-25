import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

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
    signal?.throwIfAborted(); await this.#start(); signal?.throwIfAborted();
    if (this.#closed) throw new Error('The live stream probe bridge is closed.');
    const token = randomBytes(32).toString('hex'), lifetime = new AbortController();
    const state = { openRead, signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal, requests: new Set(), failures: [] };
    let closing;
    const release = () => closing ??= (async () => {
      this.#leases.delete(token); lifetime.abort(); signal?.removeEventListener('abort', aborted);
      while (state.requests.size) await Promise.allSettled([...state.requests]);
      if (state.failures.length) throw new AggregateError(state.failures, 'A live probe byte reader failed to close.');
    })();
    const aborted = () => { void release().catch(() => {}); };
    state.release = release; this.#leases.set(token, state); signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { await release(); signal.throwIfAborted(); }
    return Object.freeze({ url: `${this.#origin}/${token}`, release });
  }

  async #serve(request, response) {
    const state = /^\/[a-f0-9]{64}$/u.test(request.url ?? '') && this.#leases.get(request.url.slice(1));
    if (!state || state.signal.aborted) { response.writeHead(404); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    if (state.requests.size >= 8) { response.writeHead(429); response.end(); return; }
    const lifetime = new AbortController(), signal = AbortSignal.any([state.signal, lifetime.signal]);
    let handle;
    const aborted = () => { lifetime.abort(); void Promise.resolve(handle?.close()).catch(() => {}); };
    request.once('aborted', aborted); response.once('close', aborted); signal.addEventListener('abort', aborted, { once: true });
    const completion = Promise.withResolvers(); state.requests.add(completion.promise);
    try {
      response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
      handle = await state.openRead({ signal }); signal.throwIfAborted();
      if (!handle?.stream?.[Symbol.asyncIterator]) throw new TypeError('The original input has no byte reader.');
      response.writeHead(200);
      for await (const bytes of handle.stream) {
        signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array)) throw new TypeError('An original stream must yield bytes.');
        if (!response.write(bytes)) await once(response, 'drain', { signal });
      }
      response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else { response.writeHead(signal.aborted ? 499 : 502); response.end(); }
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
