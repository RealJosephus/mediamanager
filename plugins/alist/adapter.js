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
      atomicReplace: false, conditionalWrite: false, directLease: false });
  }

  #scope(options) {
    checkAbort(options.signal);
    if (this.#closed) throw new StorageError('closed', 'The AList adapter is closed.');
    const timeout = options.deadline === undefined ? this.#timeoutMs : Math.min(this.#timeoutMs, options.deadline - Date.now());
    if (!Number.isFinite(timeout)) throw new TypeError('The operation deadline must be a timestamp.');
    if (timeout <= 0) throw new StorageError('timeout', 'The storage operation deadline expired.');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, timeout));
    timer.unref();
    const scope = {
      signal: controller.signal,
      abort: () => controller.abort(),
      error: (error) => {
        if (timedOut && error?.code === 'cancelled') return new StorageError('timeout', 'The storage operation timed out.');
        if (error instanceof StorageError) return error;
        if (controller.signal.aborted) return new StorageError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'The storage operation timed out.' : 'The storage operation was cancelled.');
        return new StorageError('unavailable', 'The storage transport failed.');
      },
      dispose: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); this.#operations.delete(scope); },
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
      catch (error) { if (!scope.signal.aborted) throw scope.error(error); }
    }
  }

  async #api(operation, body, options = {}, request = {}) {
    const scope = this.#scope(options);
    let response;
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
      if (redirectStatuses.has(response.status)) throw new StorageError('invalid-response', 'AList API redirects are not allowed.');
      if (!response.ok) throw statusError(response.status, operation, response.headers.get('retry-after'));
      const envelope = await this.#jsonBody(response);
      if (!envelope || !Number.isSafeInteger(envelope.code)) throw new StorageError('invalid-response', 'AList returned an invalid response envelope.');
      if (envelope.code !== 200) throw statusError(envelope.code, operation, response.headers.get('retry-after'), String(envelope.message ?? ''));
      return envelope.data;
    } catch (error) { throw scope.error(error); }
    finally {
      try { await this.#cancelBody(response, scope); }
      finally { scope.dispose(); }
    }
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

  async #download(url, headers, scope) {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await this.#fetch(url, { method: 'GET', headers, redirect: 'manual', signal: scope.signal });
      if (!redirectStatuses.has(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new StorageError('invalid-response', 'The backend download redirect chain is invalid.');
      url = safeUrl(location, url);
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
        if (attempt === 0 && [401, 403, 404, 410].includes(response.status)) {
          await response.body?.cancel();
          const refreshed = await this.#get(path, { ...options, signal: scope.signal });
          if (refreshed.raw_url && refreshed.raw_url !== data.raw_url) { data = refreshed; continue; }
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
      let closed = false;
      let reader;
      const close = async () => {
        if (closed) return;
        closed = true;
        try { if (reader) await reader.cancel(); else await response.body?.cancel(); }
        catch (error) { if (!scope.signal.aborted) throw scope.error(error); }
        finally { scope.abort(); scope.dispose(); }
      };
      async function* stream() {
        let count = 0n;
        try {
          if (closed) throw new StorageError('closed', 'The read handle is closed.');
          reader = response.body?.getReader();
          if (reader) while (true) {
            const { value, done } = await reader.read();
            checkAbort(scope.signal);
            if (done) break;
            count += BigInt(value.byteLength);
            if (expectedLength !== null && count > expectedLength) throw new StorageError('invalid-response', 'The backend sent more bytes than declared.');
            yield value;
          }
          if (expectedLength !== null && count !== expectedLength) throw new StorageError('invalid-response', 'The backend read ended before its declared length.');
        } catch (error) { throw scope.error(error); }
        finally { await close(); }
      }
      return { stream: stream(), rangeHonored, range, totalSize, contentLength,
        version, contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'), close };
    } catch (error) {
      try { await this.#cancelBody(response, scope); }
      finally { scope.dispose(); }
      throw scope.error(error);
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
    async function* body() {
      let count = 0n;
      for await (const chunk of bytes ? [bytes] : data) {
        checkAbort(options.signal);
        if (!(chunk instanceof Uint8Array)) throw new TypeError('Upload chunks must be bytes.');
        count += BigInt(chunk.byteLength);
        if (count > size) throw new StorageError('invalid-response', 'The upload exceeded its declared length.');
        yield chunk;
      }
      if (count !== size) throw new StorageError('invalid-response', 'The upload ended before its declared length.');
    }
    await this.#api('put', null, options, { method: 'PUT', headers, body: body() });
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

  async close() {
    this.#closed = true;
    for (const scope of this.#operations) { scope.abort(); scope.dispose(); }
  }
}
