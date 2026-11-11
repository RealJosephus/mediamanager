import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StorageError, checkAbort, requireCapability } from '@mediamanager/plugin-sdk/storage/errors';
import { baseName, normalizePath, parentPath, validateName } from '@mediamanager/plugin-sdk/storage/paths';
import { normalizeRange, parseContentRange, rangeHeader, resolveRange, unsignedInteger } from '@mediamanager/plugin-sdk/storage/range';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const configurableCapabilities = Object.freeze(['create', 'replace', 'mkdir', 'delete', 'rename']);

function writableCapabilities(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(name => !configurableCapabilities.includes(name))) {
    throw new TypeError('AList capabilities contain unsupported fields.');
  }
  for (const enabled of Object.values(value)) if (typeof enabled !== 'boolean') throw new TypeError('AList capability values must be boolean.');
  return Object.fromEntries(configurableCapabilities.map(name => [name, value[name] === true]));
}

function safeUrl(value, base) {
  let url;
  try { url = new URL(value, base); }
  catch { throw new StorageError('invalid-response', 'The backend supplied an invalid download URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new StorageError('invalid-response', 'The backend supplied an unsupported download URL.');
  }
  return url;
}

function statusError(status, operation, retryAfter = null, message = '') {
  let code = ({ 401: 'authentication-required', 403: 'permission-denied', 404: 'not-found',
    405: 'not-supported', 408: 'timeout', 409: 'version-changed', 412: 'version-changed',
    416: 'range-not-satisfiable', 429: 'rate-limited', 501: 'not-supported', 504: 'timeout' })[status] ?? 'unavailable';
  // FsStream and FsRename report destination conflicts with a code-403 envelope.
  if (status === 403 && (operation === 'put' && message === 'file exists' ||
    operation === 'rename' && /^file \[.*\] exists$/su.test(message))) code = 'already-exists';
  // AList wraps typed Go errors into a code-500 envelope. Only known terminal errors are classified.
  if (status === 500) {
    if (/(?:^|: )object not found$/u.test(message)) code = 'not-found';
    else if (/(?:^|: )not a folder$/u.test(message)) code = 'not-directory';
    else if (/(?:^|: )not a file$/u.test(message)) code = 'is-directory';
    else if (/(?:^|: )permission denied$/u.test(message)) code = 'permission-denied';
  }
  return new StorageError(code, `The AList ${operation} operation failed.`, { status, operation, retryAfter });
}

function parseJsonExact(text) {
  try {
    return JSON.parse(text, (_key, value, context) => {
      if (typeof value === 'number' && context?.source && /^-?\d+$/u.test(context.source) && !Number.isSafeInteger(value)) {
        return BigInt(context.source);
      }
      return value;
    });
  } catch { throw new StorageError('invalid-response', 'AList returned malformed JSON.'); }
}

function objectInfo(value) {
  if (!value || typeof value.name !== 'string' || typeof value.is_dir !== 'boolean') {
    throw new StorageError('invalid-response', 'AList returned invalid object metadata.');
  }
  // Root responses may use an empty name. Directory pages validate nonempty names separately.
  if (value.name) validateName(value.name);
  let size = null;
  if (!value.is_dir && value.size != null) {
    try { size = unsignedInteger(value.size, 'object size'); }
    catch { throw new StorageError('invalid-response', 'AList returned an invalid object size.'); }
  }
  return { name: value.name, kind: value.is_dir ? 'directory' : 'file', size,
    modified: typeof value.modified === 'string' ? value.modified : null,
    created: typeof value.created === 'string' ? value.created : null,
    version: null, sizeReliability: 'reported', versionReliability: 'unavailable' };
}

function lengthHeader(value) {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) throw new StorageError('invalid-response', 'The backend returned an invalid content length.');
  return BigInt(value);
}

const sourceFailure = (reason, message) => reason instanceof StorageError ? reason
  : Object.assign(new StorageError('unavailable', message), { cause: reason });
const diagnostic = (error, key) => {
  try { return error?.[key]; } catch { return undefined; }
};
function combinedFailure(errors) {
  if (errors.length === 1) return errors[0];
  const primary = errors[0];
  const code = diagnostic(primary, 'code') ?? 'unavailable';
  const message = diagnostic(primary, 'message');
  const text = typeof message === 'string' ? message : 'The AList operation failed during cleanup.';
  let failure;
  try { failure = new StorageError(code, text, diagnostic(primary, 'details')); }
  catch { failure = new StorageError(code, text); }
  for (const key of ['status', 'statusCode']) {
    const value = diagnostic(primary, key);
    if (value !== undefined) failure[key] = value;
  }
  return Object.assign(failure, { cause: new AggregateError(errors, text, { cause: primary }), errors });
}
const expectedAbort = (error, scope) => scope.signal.aborted
  && (diagnostic(error, 'name') === 'AbortError' || diagnostic(error, 'code') === 'ABORT_ERR');

export class AListAdapter {
  #baseUrl;
  #credentialRef;
  #resolveCredential;
  #password;
  #fetch;
  #timeoutMs;
  #pageSize;
  #maxJsonBytes;
  #closed = false;
  #closing;
  #operations = new Set();

  constructor(config, { resolveCredential, fetch: fetchImplementation = globalThis.fetch } = {}) {
    this.#baseUrl = safeUrl(config.baseUrl);
    if (this.#baseUrl.search || this.#baseUrl.hash) throw new TypeError('The AList base URL cannot contain a query or fragment.');
    this.#baseUrl.pathname = this.#baseUrl.pathname.replace(/\/*$/u, '/');
    this.#credentialRef = config.credentialRef;
    if (this.#credentialRef && typeof resolveCredential !== 'function') throw new TypeError('A credential resolver is required.');
    this.#resolveCredential = resolveCredential;
    this.#password = config.password ?? '';
    if (typeof this.#password !== 'string' || /[\r\n\0]/u.test(this.#password)) throw new TypeError('The directory password is invalid.');
    this.#fetch = fetchImplementation;
    this.#timeoutMs = config.timeoutMs ?? 30000;
    this.#pageSize = config.pageSize ?? 200;
    this.#maxJsonBytes = config.maxJsonBytes ?? 8 * 1024 * 1024;
    for (const value of [this.#timeoutMs, this.#pageSize, this.#maxJsonBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('AList limits must be positive safe integers.');
    }
    const writable = writableCapabilities(config.capabilities);
    this.capabilities = Object.freeze({ randomRead: 'conditional', reliableLength: false, reliableVersion: false,
      directorySnapshot: false, create: writable.create, replace: writable.replace, mkdir: writable.mkdir,
      delete: writable.delete, rename: writable.rename,
      atomicReplace: false, conditionalWrite: false, directLease: false, watch: false });
  }

  #scope(options) {
    checkAbort(options.signal);
    if (this.#closed) throw new StorageError('closed', 'The AList adapter is closed.');
    const timeout = options.deadline === undefined ? this.#timeoutMs : Math.min(this.#timeoutMs, options.deadline - Date.now());
    if (!Number.isFinite(timeout)) throw new TypeError('The operation deadline must be a timestamp.');
    if (timeout <= 0) throw new StorageError('timeout', 'The storage operation deadline expired.');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, timeout));
    timer.unref();
    const completed = Promise.withResolvers();
    const scope = {
      done: completed.promise, cleanupErrors: [],
      signal: controller.signal,
      abort: () => controller.abort(),
      error: (error) => {
        if (timedOut && diagnostic(error, 'code') === 'cancelled') {
          return Object.assign(new StorageError('timeout', 'The storage operation timed out.'), { cause: error });
        }
        if (error instanceof StorageError) return error;
        if (controller.signal.aborted) {
          return Object.assign(new StorageError(timedOut ? 'timeout' : 'cancelled',
            timedOut ? 'The storage operation timed out.' : 'The storage operation was cancelled.'), { cause: error });
        }
        return Object.assign(new StorageError('unavailable', 'The storage transport failed.'), { cause: error });
      },
      dispose: () => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
        this.#operations.delete(scope); completed.resolve(scope.cleanupErrors);
      },
    };
    this.#operations.add(scope);
    return scope;
  }

  async #jsonBody(response) {
    const parts = [];
    let count = 0;
    for await (const chunk of response.body ?? []) {
      count += chunk.byteLength;
      if (count > this.#maxJsonBytes) throw new StorageError('invalid-response', 'The AList response exceeded the metadata size limit.');
      parts.push(chunk);
    }
    return parseJsonExact(Buffer.concat(parts).toString('utf8'));
  }

  async #cancelBody(response, scope) {
    if (response?.body && !response.bodyUsed) {
      try { await response.body.cancel(); }
      catch (error) { if (!expectedAbort(error, scope)) throw sourceFailure(error, 'The AList response did not close.'); }
    }
  }

  async #api(operation, body, options = {}, request = {}) {
    const scope = request.scope ?? this.#scope(options);
    let response, result;
    const errors = [];
    try {
      const headers = new Headers(request.headers);
      if (this.#credentialRef) {
        const token = await this.#resolveCredential(this.#credentialRef, { signal: scope.signal });
        if (typeof token !== 'string' || !token || /[\r\n]/u.test(token)) throw new StorageError('authentication-required', 'AList credentials are unavailable.');
        headers.set('Authorization', token);
      }
      checkAbort(scope.signal);
      if (!request.body) headers.set('Content-Type', 'application/json');
      response = await this.#fetch(new URL(`api/fs/${operation}`, this.#baseUrl), {
        method: request.method ?? 'POST', headers,
        body: request.body ?? JSON.stringify(body), redirect: 'manual', signal: scope.signal,
        ...(request.body ? { duplex: 'half' } : {}),
      });
      checkAbort(scope.signal);
      if (redirectStatuses.has(response.status)) throw new StorageError('invalid-response', 'AList API redirects are not allowed.');
      if (!response.ok) throw statusError(response.status, operation, response.headers.get('retry-after'));
      const envelope = await this.#jsonBody(response);
      checkAbort(scope.signal);
      if (!envelope || !Number.isSafeInteger(envelope.code)) throw new StorageError('invalid-response', 'AList returned an invalid response envelope.');
      if (envelope.code !== 200) throw statusError(envelope.code, operation, response.headers.get('retry-after'), String(envelope.message ?? ''));
      result = envelope.data;
    } catch (error) { errors.push(scope.error(error)); }
    finally {
      try { await this.#cancelBody(response, scope); }
      catch (error) { errors.push(error); scope.cleanupErrors.push(error); }
      finally { if (!request.scope) scope.dispose(); }
    }
    if (errors.length) throw combinedFailure(errors);
    return result;
  }

  async #get(path, options) {
    return this.#api('get', { path: normalizePath(path), password: this.#password }, options);
  }

  async health(options = {}) {
    try { await this.#get('/', options); return { state: 'available' }; }
    catch (error) {
      if (!(error instanceof StorageError) || ['cancelled', 'closed'].includes(error.code)) throw error;
      return { state: error.code, retryAfter: error.details.retryAfter ?? null };
    }
  }

  async stat(path, options = {}) { return objectInfo(await this.#get(path, options)); }

  async listPage(path, options = {}) {
    path = normalizePath(path);
    const cursor = options.cursor;
    const page = cursor?.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || (cursor && cursor.path !== path)) throw new TypeError('The AList cursor is invalid.');
    const data = await this.#api('list', { path, password: this.#password, page, per_page: this.#pageSize, refresh: options.refresh === true }, options);
    if (!data || (data.content !== null && !Array.isArray(data.content))) throw new StorageError('invalid-response', 'AList returned an invalid directory page.');
    let total;
    try { total = unsignedInteger(data.total, 'directory total'); }
    catch { throw new StorageError('invalid-response', 'AList returned an invalid directory total.'); }
    if (cursor && String(total) !== cursor.total) throw new StorageError('version-changed', 'The AList directory size changed during enumeration.');
    const entries = (data.content ?? []).map(objectInfo);
    const offset = BigInt(page - 1) * BigInt(this.#pageSize);
    const expected = total > offset ? (total - offset > BigInt(this.#pageSize) ? BigInt(this.#pageSize) : total - offset) : 0n;
    if (BigInt(entries.length) !== expected || offset > total) throw new StorageError('incomplete-listing', 'AList returned an incomplete directory page.');
    for (const entry of entries) validateName(entry.name);
    const complete = offset + BigInt(entries.length) === total;
    return { entries, complete, nextCursor: complete ? null : { page: page + 1, total: String(total), path },
      consistency: 'weak', snapshot: null, deletionSafe: false };
  }

  async #discardDownloadResponse(response, scope, primary) {
    try { await this.#cancelBody(response, scope); }
    catch (cleanup) {
      scope.cleanupErrors.push(cleanup);
      scope.abort();
      throw primary ? combinedFailure([primary, cleanup]) : cleanup;
    }
  }

  async #download(url, headers, scope) {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await this.#fetch(url, { method: 'GET', headers, redirect: 'manual', signal: scope.signal });
      if (!redirectStatuses.has(response.status)) return response;
      let next, primary;
      try {
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new StorageError('invalid-response', 'The backend download redirect chain is invalid.');
        next = safeUrl(location, url);
      } catch (error) { primary = scope.error(error); }
      await this.#discardDownloadResponse(response, scope, primary);
      if (primary) throw primary;
      checkAbort(scope.signal);
      url = next;
    }
  }

  async openRead(path, options = {}) {
    path = normalizePath(path);
    const requestedRange = normalizeRange(options.range);
    let data = await this.#get(path, options);
    const info = objectInfo(data);
    if (info.kind !== 'file') throw new StorageError('is-directory', 'The AList object is a directory.');
    const scope = this.#scope(options);
    let response;
    try {
      const headers = new Headers({ 'Accept-Encoding': 'identity' });
      if (requestedRange) headers.set('Range', rangeHeader(requestedRange));
      if (options.ifMatch) {
        if (!/^"[^"\r\n]*"$/u.test(options.ifMatch)) throw new StorageError('not-supported', 'Conditional reads require a strong entity tag.');
        headers.set('If-Match', options.ifMatch);
      }
      if (options.ifRange) headers.set('If-Range', options.ifRange);
      for (let attempt = 0; ; attempt++) {
        if (typeof data.raw_url !== 'string' || !data.raw_url) throw new StorageError('invalid-response', 'AList did not supply a download URL.');
        const url = safeUrl(data.raw_url, this.#baseUrl);
        response = await this.#download(url, headers, scope);
        checkAbort(scope.signal);
        if (attempt === 0 && [401, 403, 404, 410].includes(response.status)) {
          const expired = response;
          const primary = statusError(expired.status, 'read', expired.headers.get('retry-after'));
          response = undefined;
          await this.#discardDownloadResponse(expired, scope, primary);
          const refreshed = await this.#get(path, { ...options, signal: scope.signal });
          if (refreshed.raw_url && refreshed.raw_url !== data.raw_url) { data = refreshed; continue; }
          throw primary;
        }
        break;
      }
      if (![200, 206].includes(response.status)) {
        const error = statusError(response.status, 'read', response.headers.get('retry-after'));
        if (response.status === 416) {
          const total = /^bytes \*\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
          throw new StorageError(error.code, error.message, { ...error.details, totalSize: total ? BigInt(total[1]) : null,
            contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges') });
        }
        throw error;
      }
      if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
        throw new StorageError('invalid-response', 'The backend encoded a raw byte response.');
      }
      const version = response.headers.get('etag');
      if (options.ifMatch && version !== options.ifMatch) throw new StorageError(version ? 'version-changed' : 'not-supported', 'The backend did not prove the requested object version.');
      const rangeHonored = response.status === 206;
      let range = null;
      let totalSize = null;
      const contentLength = lengthHeader(response.headers.get('content-length'));
      if (rangeHonored) {
        if (!requestedRange) throw new StorageError('invalid-response', 'The backend returned an unsolicited partial response.');
        const parsed = parseContentRange(response.headers.get('content-range'));
        range = { start: parsed.start, end: parsed.end };
        totalSize = parsed.totalSize;
        if (contentLength !== null && contentLength !== range.end - range.start + 1n) throw new StorageError('invalid-response', 'The backend range length is inconsistent.');
        if (totalSize !== null) {
          const expected = resolveRange(requestedRange, totalSize);
          if (range.start !== expected.start || range.end !== expected.end) throw new StorageError('invalid-response', 'The backend returned a different range.');
        } else if (requestedRange.suffix !== undefined || range.start !== requestedRange.start || (requestedRange.end !== null && range.end > requestedRange.end)) {
          throw new StorageError('invalid-response', 'The backend range cannot be verified.');
        }
      } else {
        if (response.headers.has('content-range')) throw new StorageError('invalid-response', 'The backend returned a full response with a partial range header.');
        totalSize = contentLength;
      }
      const expectedLength = rangeHonored ? range.end - range.start + 1n : contentLength;
      let closing, reader, readFailure;
      const close = () => {
        if (closing) return closing;
        scope.signal.removeEventListener('abort', abort);
        closing = Promise.resolve().then(async () => {
          const failures = [];
          try { if (reader) await reader.cancel(); else await response.body?.cancel(); }
          catch (error) {
            // A failed ReadableStream repeats its stored error from cancel().
            // Only independent cleanup failures belong to the closing owner.
            if (!(readFailure instanceof Error && error === readFailure) && !expectedAbort(error, scope)) {
              failures.push(sourceFailure(error, 'The AList read did not close.'));
            }
          }
          try { reader?.releaseLock(); }
          catch (error) { failures.push(sourceFailure(error, 'The AList read lock did not release.')); }
          finally { scope.cleanupErrors.push(...failures); scope.abort(); scope.dispose(); }
          if (failures.length) throw combinedFailure(failures);
        });
        return closing;
      };
      const abort = () => { void close().catch(() => {}); };
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) { await close(); checkAbort(scope.signal); }
      async function* stream() {
        let count = 0n;
        const errors = [];
        try {
          if (closing) throw new StorageError('closed', 'The read handle is closed.');
          reader = response.body?.getReader();
          if (reader) while (true) {
            let part;
            try { part = await reader.read(); }
            catch (error) { readFailure = error; throw error; }
            const { value, done } = part;
            checkAbort(scope.signal);
            if (done) break;
            count += BigInt(value.byteLength);
            if (expectedLength !== null && count > expectedLength) throw new StorageError('invalid-response', 'The backend sent more bytes than declared.');
            yield value;
          }
          if (expectedLength !== null && count !== expectedLength) throw new StorageError('invalid-response', 'The backend read ended before its declared length.');
        } catch (error) { errors.push(scope.error(error)); }
        finally {
          try { await close(); } catch (error) { errors.push(error); }
          if (errors.length) throw combinedFailure(errors);
        }
      }
      return { stream: stream(), rangeHonored, range, totalSize, contentLength,
        version, contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'), close };
    } catch (error) {
      const primary = scope.error(error);
      try { await this.#discardDownloadResponse(response, scope, primary); }
      finally { scope.dispose(); }
      throw primary;
    }
  }

  async write(path, data, options = {}) {
    if (options.ifMatch !== undefined || options.atomic === true) throw new StorageError('not-supported', 'AList does not provide conditional or atomic writes.');
    requireCapability(this, 'create');
    if (options.overwrite !== false) requireCapability(this, 'replace');
    path = normalizePath(path);
    const bytes = data instanceof Uint8Array ? data : null;
    const size = bytes ? BigInt(bytes.byteLength) : unsignedInteger(options.size, 'upload size');
    if (options.size !== undefined && unsignedInteger(options.size) !== size) throw new TypeError('The upload size does not match its byte array.');
    const headers = { 'Content-Type': options.contentType ?? 'application/octet-stream',
      'Content-Length': String(size), 'File-Path': encodeURIComponent(path),
      Password: Buffer.from(this.#password, 'utf8').toString('latin1'),
      'As-Task': 'false', Overwrite: String(options.overwrite !== false) };
    if (options.modified !== undefined) {
      const modified = Date.parse(options.modified);
      if (!Number.isFinite(modified)) throw new TypeError('The modification time is invalid.');
      headers['Last-Modified'] = String(modified);
    }
    const scope = this.#scope(options), errors = [], aborted = Promise.withResolvers();
    const cancellation = new StorageError('cancelled', 'The AList upload was cancelled.');
    let iterator, upload, uploadFinished, uploadClosed, sourceClose, sourceNext, bodyFailed = false, bodyFailure;
    const closeSource = () => {
      if (!sourceClose) {
        sourceClose = (async () => { const result = await iterator?.return?.(); await result?.value; })();
        void sourceClose.catch(() => {});
      }
      return sourceClose;
    };
    const cancel = () => { aborted.reject(cancellation); upload?.destroy(cancellation); closeSource(); };
    void aborted.promise.catch(() => {});
    try {
      const input = bytes ? [bytes] : data;
      const iterate = input?.[Symbol.asyncIterator] ?? input?.[Symbol.iterator];
      if (typeof iterate !== 'function') throw new TypeError('An upload must provide bytes.');
      iterator = iterate.call(input);
      async function* body() {
        let count = 0n;
        try {
          for (;;) {
            checkAbort(scope.signal);
            sourceNext = Promise.resolve().then(() => iterator.next());
            const part = await Promise.race([sourceNext, aborted.promise]);
            checkAbort(scope.signal);
            if (part.done) break;
            const chunk = await part.value;
            checkAbort(scope.signal);
            if (!(chunk instanceof Uint8Array)) throw new TypeError('Upload chunks must be bytes.');
            count += BigInt(chunk.byteLength);
            if (count > size) throw new StorageError('invalid-response', 'The upload exceeded its declared length.');
            yield chunk;
          }
          if (count !== size) throw new StorageError('invalid-response', 'The upload ended before its declared length.');
        } catch (error) {
          bodyFailed = true; bodyFailure = error;
          throw sourceFailure(error, 'The AList upload source failed.');
        }
      }
      upload = Readable.from(body(), { objectMode: false, autoDestroy: true });
      uploadClosed = new Promise(resolve => upload.once('close', resolve));
      uploadFinished = finished(upload, { cleanup: true });
      void uploadFinished.catch(() => {});
      scope.signal.addEventListener('abort', cancel, { once: true });
      checkAbort(scope.signal);
      let requestBody = upload;
      if (size === 0n) {
        for await (const _chunk of upload) { /* Validate the empty entity's actual producer. */ }
        requestBody = Buffer.alloc(0);
      }
      await this.#api('put', null, options, { method: 'PUT', headers, body: requestBody, scope });
      await uploadFinished;
      checkAbort(scope.signal);
    } catch (error) {
      // Fetch wraps producer failures in a transport error. Keep an actual API
      // rejection authoritative when its early response also stops the body.
      const failedSource = bodyFailed && error?.code === 'unavailable' && !error.details?.operation && !error.errors;
      errors.push(failedSource ? scope.error(sourceFailure(bodyFailure, 'The AList upload source failed.')) : scope.error(error));
    } finally {
      // Closing the adapter joins this owner until both the upload stream and
      // its original producer have completed cleanup, including a pending next().
      scope.abort(); cancel(); scope.signal.removeEventListener('abort', cancel);
      try { await closeSource(); }
      catch (error) {
        const failure = sourceFailure(error, 'The AList upload source did not close.');
        errors.push(failure); scope.cleanupErrors.push(failure);
      }
      await Promise.allSettled([sourceNext]);
      if (uploadClosed) await uploadClosed;
      if (uploadFinished) {
        try { await uploadFinished; }
        catch (error) { if (!errors.length && error !== cancellation) errors.push(scope.error(error)); }
      }
      scope.dispose();
    }
    if (errors.length) throw combinedFailure(errors);
    return { size, atomic: false };
  }

  async mkdir(path, options = {}) {
    requireCapability(this, 'mkdir');
    return this.#api('mkdir', { path: normalizePath(path) }, options);
  }

  async delete(path, options = {}) {
    requireCapability(this, 'delete');
    if (options.ifMatch !== undefined) throw new StorageError('not-supported', 'AList does not provide conditional deletes.');
    path = normalizePath(path);
    if (path === '/') throw new StorageError('permission-denied', 'The AList root cannot be removed.');
    // FsRemove recursively removes directories. A prior empty listing cannot
    // make that operation nonrecursive when another writer adds a child.
    if (options.recursive !== true && (await this.stat(path, options)).kind === 'directory') {
      throw new StorageError('not-supported', 'AList directory deletion requires recursive: true.');
    }
    return this.#api('remove', { dir: parentPath(path), names: [baseName(path)] }, options);
  }

  async rename(path, destination, options = {}) {
    requireCapability(this, 'rename');
    if (options.overwrite === true) requireCapability(this, 'replace');
    if (options.ifMatch !== undefined) throw new StorageError('not-supported', 'AList does not provide conditional renames.');
    path = normalizePath(path);
    destination = normalizePath(destination);
    if (path === '/' || destination === '/') throw new StorageError('permission-denied', 'The AList root cannot be renamed.');
    if (parentPath(path) !== parentPath(destination)) throw new StorageError('not-supported', 'AList rename only supports the same parent directory.');
    return this.#api('rename', { path, name: baseName(destination), overwrite: options.overwrite === true }, options);
  }

  close() {
    if (this.#closing) return this.#closing;
    const completed = Promise.withResolvers(); this.#closing = completed.promise;
    this.#closed = true;
    const operations = [...this.#operations];
    for (const scope of operations) scope.abort();
    (async () => {
      const failures = (await Promise.all(operations.map(scope => scope.done))).flat();
      if (failures.length) throw combinedFailure(failures);
    })().then(completed.resolve, completed.reject);
    return this.#closing;
  }
}
