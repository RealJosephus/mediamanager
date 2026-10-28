import http from 'node:http';
import https from 'node:https';
import { MIMEType } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { StorageError, checkAbort } from '@mediamanager/plugin-sdk/storage/errors';
import { normalizeRange, rangeHeader, parseContentRange, resolveRange } from '@mediamanager/plugin-sdk/storage/range';
import { sourceUriFromPath } from '@mediamanager/plugin-sdk/storage/uri';

const redirects = new Set([300, 301, 302, 303, 307, 308]);
const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
const ignoreError = () => {};

function sourceUrl(path) {
  const url = new URL(sourceUriFromPath(path));
  if (!['http:', 'https:'].includes(url.protocol)) throw new StorageError('invalid-path', 'HTTP storage requires an HTTP source URI.');
  return url;
}

function length(value) {
  if (value === undefined) return null;
  if (!/^\d+$/u.test(value)) throw new StorageError('invalid-response', 'The HTTP source returned an invalid content length.');
  return BigInt(value);
}

function responseType(value) {
  if (typeof value !== 'string') return undefined;
  try { new MIMEType(value); return value; } catch { return undefined; }
}

function responseRange(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^([!#$%&'*+.^_`|~\w-]+) (?:(\d+)-(\d+)\/(\d+|\*)|\*\/(\d+))$/u.exec(value);
  if (!match) return undefined;
  const [, , start, end, total, unsatisfied] = match;
  const numbers = [start, end, total === '*' ? undefined : total, unsatisfied].filter(value => value !== undefined).map(BigInt);
  if (numbers.some(value => value > 9223372036854775807n)) return undefined;
  if (start !== undefined && (BigInt(start) > BigInt(end) || total !== '*' && BigInt(end) >= BigInt(total))) return undefined;
  return value;
}

function httpFailure(status, headers) {
  const code = ({ 401: 'authentication-required', 403: 'permission-denied', 404: 'not-found',
    405: 'not-supported', 408: 'timeout', 412: 'version-changed', 416: 'range-not-satisfiable',
    429: 'rate-limited', 501: 'not-supported', 504: 'timeout' })[status] ?? 'unavailable';
  const total = /^bytes \*\/(\d+)$/u.exec(headers['content-range'] ?? '');
  return new StorageError(code, 'The HTTP source read failed.', { status,
    ...(total ? { totalSize: BigInt(total[1]) } : {}), contentType: headers['content-type'], acceptRanges: headers['accept-ranges'] });
}

export class HttpAdapter {
  #timeoutMs;
  #closed = false;
  #closing;
  #operations = new Set();
  #opening = new Set();

  constructor(configuration = {}) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || Object.keys(configuration).some(name => name !== 'timeoutMs')) throw new TypeError('HTTP storage configuration contains unsupported fields.');
    this.#timeoutMs = configuration.timeoutMs ?? 100000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new TypeError('The HTTP timeout must be a positive safe integer.');
    this.capabilities = Object.freeze({ randomRead: 'conditional', reliableLength: false, reliableVersion: false,
      directorySnapshot: false, create: false, replace: false, mkdir: false, delete: false, rename: false,
      atomicReplace: false, conditionalWrite: false, directLease: false, watch: false });
  }

  #scope(options) {
    checkAbort(options.signal);
    if (this.#closed) throw new StorageError('closed', 'HTTP storage is closed.');
    const duration = options.deadline === undefined ? this.#timeoutMs : Math.min(this.#timeoutMs, options.deadline - Date.now());
    if (!Number.isFinite(duration)) throw new TypeError('The HTTP operation deadline must be a timestamp.');
    if (duration <= 0) throw new StorageError('timeout', 'The HTTP operation deadline expired.');
    const controller = new AbortController(), resources = new Set();
    let timedOut = false, closing;
    const aborted = () => controller.abort(options.signal?.reason);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration); timer.unref();
    const scope = {
      signal: controller.signal,
      own(resource) {
        resource.on('error', ignoreError);
        const closed = resource.closed ? Promise.resolve() : new Promise(resolve => resource.once('close', resolve));
        resources.add({ resource, closed });
        if (controller.signal.aborted) resource.destroy();
        return resource;
      },
      error(cause) {
        if (cause instanceof StorageError && !(timedOut && cause.code === 'cancelled')) return cause;
        const code = controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : 'unavailable';
        const result = new StorageError(code, timedOut ? 'The HTTP source read timed out.' : controller.signal.aborted
          ? 'The HTTP source read was cancelled.' : 'The HTTP source transport failed.');
        result.cause = cause;
        return result;
      },
      close: () => closing ??= Promise.resolve().then(async () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        controller.signal.removeEventListener('abort', stop);
        controller.abort();
        let count;
        do {
          count = resources.size;
          for (const { resource } of resources) resource.destroy();
          await Promise.all([...resources].map(value => value.closed));
        } while (count !== resources.size);
        this.#operations.delete(scope);
      }),
    };
    const stop = () => { void scope.close().catch(ignoreError); };
    this.#operations.add(scope);
    options.signal?.addEventListener('abort', aborted, { once: true });
    controller.signal.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) aborted();
    return scope;
  }

  #get(url, headers, scope) {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      // NamedClient.Default selects UTF-8 for request header values. Node writes
      // HTTP/1 header strings as Latin-1, so supply their actual UTF-8 octets.
      const encodedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Buffer.from(String(value), 'utf8').toString('latin1')]));
      const request = scope.own(transport.request(url, { method: 'GET', headers: encodedHeaders, signal: scope.signal, agent: false }, response => resolve(scope.own(response))));
      request.once('socket', socket => scope.own(socket));
      request.once('error', reject);
      request.end();
    });
  }

  async #follow(url, headers, scope) {
    for (let count = 0; ; count++) {
      let response;
      for (let attempt = 0; ; attempt++) {
        try { response = await this.#get(url, headers, scope); break; }
        catch (cause) { if (scope.signal.aborted || cause.code !== 'ECONNRESET' || attempt >= 3) throw cause; }
      }
      if (!redirects.has(response.statusCode) || !response.headers.location || count >= 50) return response;
      const next = new URL(response.headers.location, url);
      if (!['http:', 'https:'].includes(next.protocol)) throw new StorageError('invalid-response', 'The HTTP redirect target uses an unsupported protocol.');
      if (url.protocol === 'https:' && next.protocol === 'http:') return response;
      const closed = response.closed ? Promise.resolve() : new Promise(resolve => response.once('close', resolve));
      response.destroy(); await closed;
      // Follow the source client contract without forwarding URL credentials to
      // the next origin. The public adapter has no application credentials.
      next.username = ''; next.password = '';
      url = next;
    }
  }

  openResponse(path, options = {}) {
    const opening = this.#openResponse(path, options);
    this.#opening.add(opening);
    void opening.finally(() => this.#opening.delete(opening)).catch(ignoreError);
    return opening;
  }

  async #openResponse(path, options) {
    const url = sourceUrl(path), scope = this.#scope(options);
    let upstream, decoder;
    try {
      const userAgent = options.requestHeaders?.get?.('User-Agent') ?? options.requestHeaders?.['User-Agent'] ?? options.requestHeaders?.['user-agent'];
      const headers = { 'User-Agent': userAgent || 'Jellyfin-Server/13.0.0', Accept: 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8',
        'Accept-Encoding': 'gzip, deflate, br' };
      if (options.rangeHeader !== undefined) headers.Range = options.rangeHeader;
      if (options.ifRange !== undefined) headers['If-Range'] = options.ifRange;
      if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
      upstream = await this.#follow(url, headers, scope);
      checkAbort(scope.signal);
      const encoding = upstream.headers['content-encoding']?.split(',').at(-1).trim().toLowerCase();
      const decompress = Object.hasOwn(decoders, encoding) ? decoders[encoding] : undefined;
      const contentLength = decompress ? null : length(upstream.headers['content-length']);
      const responseHeaders = { 'accept-ranges': upstream.headers['accept-ranges'] ?? (upstream.statusCode === 206 ? 'bytes' : 'none') };
      const type = responseType(upstream.headers['content-type']), range = responseRange(upstream.headers['content-range']);
      if (type !== undefined) responseHeaders['content-type'] = type;
      if (range !== undefined) responseHeaders['content-range'] = range;
      if (contentLength !== null) responseHeaders['content-length'] = String(contentLength);
      if (decompress) {
        decoder = scope.own(decompress());
        upstream.once('error', cause => decoder.destroy(cause));
        upstream.pipe(decoder);
      }
      const stream = async function* () {
        let count = 0n;
        try {
          for await (const chunk of decoder ?? upstream) {
            checkAbort(scope.signal);
            count += BigInt(chunk.byteLength);
            if (contentLength !== null && count > contentLength) throw new StorageError('invalid-response', 'The HTTP source exceeded its declared length.');
            yield chunk;
          }
          if (contentLength !== null && count !== contentLength) throw new StorageError('invalid-response', 'The HTTP source ended before its declared length.');
        } catch (cause) { throw scope.error(cause); }
        finally { await scope.close(); }
      };
      return { statusCode: upstream.statusCode, headers: Object.freeze(responseHeaders), contentLength,
        stream: stream(), close: scope.close };
    } catch (cause) { const failure = scope.error(cause); await scope.close(); throw failure; }
  }

  async openRead(path, options = {}) {
    if (options.ifMatch !== undefined) throw new StorageError('not-supported', 'HTTP storage cannot guarantee a source version.');
    const requestedRange = normalizeRange(options.range);
    const response = await this.openResponse(path, { ...options, rangeHeader: rangeHeader(requestedRange) });
    try {
      if (response.statusCode < 200 || response.statusCode >= 300) throw httpFailure(response.statusCode, response.headers);
      let range = null, totalSize = response.contentLength;
      const rangeHonored = response.statusCode === 206;
      if (rangeHonored) {
        if (!requestedRange) throw new StorageError('invalid-response', 'The HTTP source returned an unsolicited partial response.');
        const parsed = parseContentRange(response.headers['content-range']);
        range = { start: parsed.start, end: parsed.end }; totalSize = parsed.totalSize;
        if (response.contentLength !== null && response.contentLength !== range.end - range.start + 1n) throw new StorageError('invalid-response', 'The HTTP source range length is inconsistent.');
        if (totalSize !== null) {
          const expected = resolveRange(requestedRange, totalSize);
          if (range.start !== expected.start || range.end !== expected.end) throw new StorageError('invalid-response', 'The HTTP source returned a different byte range.');
        } else if (requestedRange.suffix !== undefined || range.start !== requestedRange.start
          || requestedRange.end !== null && range.end > requestedRange.end) throw new StorageError('invalid-response', 'The HTTP source range cannot be verified.');
      }
      return { ...response, rangeHonored, range, totalSize, version: null,
        contentType: response.headers['content-type'], acceptRanges: response.headers['accept-ranges'] };
    } catch (cause) { await response.close(); throw cause; }
  }

  async stat(path, options = {}) {
    // Ordinary HTTP sources may reject HEAD. A successful real GET proves the
    // object; close its body before exposing the reported metadata.
    const handle = await this.openRead(path, options);
    try { return { kind: 'file', size: handle.totalSize, modified: null, created: null, version: null,
      sizeReliability: 'reported', versionReliability: 'unavailable' }; }
    finally { await handle.close(); }
  }

  async listPage(_path, options = {}) {
    checkAbort(options.signal);
    if (this.#closed) throw new StorageError('closed', 'HTTP storage is closed.');
    throw new StorageError('not-supported', 'HTTP storage does not enumerate directories.');
  }

  async health(options = {}) {
    checkAbort(options.signal);
    if (this.#closed) throw new StorageError('closed', 'HTTP storage is closed.');
    return { state: 'available' };
  }

  close() {
    this.#closed = true;
    return this.#closing ??= Promise.resolve().then(async () => {
      await Promise.all([...this.#operations].map(scope => scope.close()));
      await Promise.allSettled([...this.#opening]);
    });
  }
}
