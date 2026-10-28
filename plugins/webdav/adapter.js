import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { StorageError, checkAbort, requireCapability } from '@mediamanager/plugin-sdk/storage/errors';
import { baseName, isWithin, normalizePath, parentPath, validateName } from '@mediamanager/plugin-sdk/storage/paths';
import { normalizeRange, parseContentRange, rangeHeader, resolveRange, unsignedInteger } from '@mediamanager/plugin-sdk/storage/range';

const redirectStatuses = new Set([300, 301, 302, 303, 304, 305, 306, 307, 308]);
const configurationKeys = new Set(['baseUrl', 'credentialRef', 'timeoutMs', 'pageSize', 'maxXmlBytes', 'capabilities']);
const capabilityKeys = new Set(['create', 'replace', 'conditionalWrite', 'mkdir', 'delete', 'rename']);
const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:creationdate/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function statusError(status, operation, retryAfter = null, { destinationExclusive = false } = {}) {
  let code = ({
    401: 'authentication-required', 403: 'permission-denied', 404: 'not-found',
    405: 'not-supported', 408: 'timeout', 409: 'version-changed', 412: 'version-changed',
    416: 'range-not-satisfiable', 423: 'unavailable', 429: 'rate-limited',
    500: 'unavailable', 501: 'not-supported', 502: 'unavailable', 503: 'unavailable',
    504: 'timeout', 507: 'unavailable',
  })[status] ?? 'unavailable';
  if (operation === 'mkdir' && status === 405) code = 'already-exists';
  if (status === 412 && destinationExclusive) code = 'already-exists';
  return new StorageError(code, `The WebDAV ${operation} operation failed.`, { status, operation, retryAfter });
}

function invalidResponse(message) {
  return new StorageError('invalid-response', message);
}

function pathPart(reference) {
  const end = reference.search(/[?#]/u);
  const withoutQuery = end < 0 ? reference : reference.slice(0, end);
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(.*)$/su.exec(withoutQuery);
  if (absolute) return absolute[1] || '/';
  if (withoutQuery.startsWith('//')) {
    const slash = withoutQuery.indexOf('/', 2);
    return slash < 0 ? '/' : withoutQuery.slice(slash);
  }
  return withoutQuery;
}

function validateRawReferencePath(reference, errorFactory) {
  if (typeof reference !== 'string' || !reference || /[\r\n\0\\]/u.test(reference)) throw errorFactory();
  const path = pathPart(reference);
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) {
      if (index !== 0 && index !== segments.length - 1) throw errorFactory();
      continue;
    }
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw errorFactory(); }
    if (decoded === '.' || decoded === '..' || /[/\\\0]/u.test(decoded)) throw errorFactory();
  }
}

function decodedPathSegments(url, errorFactory) {
  const encoded = url.pathname.split('/');
  if (encoded[0] === '') encoded.shift();
  if (encoded.at(-1) === '') encoded.pop();
  const decoded = [];
  for (const segment of encoded) {
    if (!segment) throw errorFactory();
    let value;
    try { value = decodeURIComponent(segment); }
    catch { throw errorFactory(); }
    if (!value || value === '.' || value === '..' || /[/\\\0]/u.test(value)) throw errorFactory();
    decoded.push(value);
  }
  return decoded;
}

function parseBaseUrl(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('WebDAV baseUrl is required.');
  const invalid = () => new TypeError('The WebDAV base URL is invalid.');
  validateRawReferencePath(value, invalid);
  let url;
  try { url = new URL(value); }
  catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
  decodedPathSegments(url, invalid);
  url.pathname = `${url.pathname.replace(/\/*$/u, '')}/`;
  return url;
}

function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function nodeText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value['#text'] === 'string') return value['#text'].trim();
  return null;
}

function namespaceBindings(node, inherited) {
  const bindings = new Map(inherited);
  if (!node || typeof node !== 'object' || Array.isArray(node)) return bindings;
  for (const [key, value] of Object.entries(node)) {
    if (key === '@_xmlns') bindings.set('', String(value));
    else if (key.startsWith('@_xmlns:')) bindings.set(key.slice(8), String(value));
  }
  return bindings;
}

function qualifiedName(name) {
  const separator = name.indexOf(':');
  return separator < 0 ? { prefix: '', local: name }
    : { prefix: name.slice(0, separator), local: name.slice(separator + 1) };
}

function normalizeDavNode(node, inheritedNamespaces = new Map()) {
  if (Array.isArray(node)) return node.map((item) => normalizeDavNode(item, inheritedNamespaces));
  if (!node || typeof node !== 'object') return node;
  const namespaces = namespaceBindings(node, inheritedNamespaces);
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === '#text') { normalized[key] = value; continue; }
    const { prefix, local } = qualifiedName(key);
    if (!local || namespaces.get(prefix) !== 'DAV:') throw invalidResponse('WebDAV returned an element outside the DAV namespace.');
    const items = list(value).map((item) => normalizeDavNode(item, namespaces));
    if (Object.hasOwn(normalized, local)) normalized[local] = [...list(normalized[local]), ...items];
    else normalized[local] = Array.isArray(value) ? items : items[0];
  }
  return normalized;
}

function normalizeDavDocument(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidResponse('WebDAV returned an invalid XML document.');
  const roots = Object.entries(parsed).filter(([key]) => !key.startsWith('?') && !key.startsWith('@_'));
  if (roots.length !== 1) throw invalidResponse('WebDAV returned an invalid XML document.');
  const [qualifiedRoot, rootNode] = roots[0];
  const namespaces = namespaceBindings(rootNode, new Map());
  const { prefix, local } = qualifiedName(qualifiedRoot);
  if (local !== 'multistatus' || namespaces.get(prefix) !== 'DAV:') {
    throw invalidResponse('WebDAV returned a multistatus document outside the DAV namespace.');
  }
  return normalizeDavNode(rootNode, namespaces);
}

function statusCode(value) {
  const match = /^HTTP\/(?:1\.[01]|2(?:\.0)?)\s+(\d{3})(?:\s|$)/iu.exec(nodeText(value) ?? '');
  if (!match) throw invalidResponse('WebDAV returned an invalid multistatus status line.');
  return Number(match[1]);
}

function propertyText(properties, name) {
  if (!Object.hasOwn(properties, name)) return null;
  if (Array.isArray(properties[name])) throw invalidResponse(`WebDAV repeated the ${name} property.`);
  const value = nodeText(properties[name]);
  if (value === null) throw invalidResponse(`WebDAV returned an invalid ${name} property.`);
  return value || null;
}

function lastModified(properties) {
  const value = propertyText(properties, 'getlastmodified');
  if (value === null) return null;
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw invalidResponse('WebDAV returned an invalid last-modified date.');
  }
  const timestamp = Date.parse(value);
  return new Date(timestamp).toISOString();
}

function entityTag(value) {
  if (value === null) return null;
  if (/[\r\n\0]/u.test(value) || !/^(?:W\/)?"[^"\r\n]*"$/u.test(value)) {
    throw invalidResponse('WebDAV returned an invalid entity tag.');
  }
  return value;
}

function strongEntityTag(value, operation = 'operation') {
  if (typeof value !== 'string' || !/^"[^"\r\n\0]*"$/u.test(value)) {
    throw new StorageError('not-supported', `The WebDAV ${operation} requires a strong entity tag.`);
  }
  return value;
}

function safeHeader(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function validateIfRange(value) {
  safeHeader(value, 'WebDAV If-Range');
  if (/^W\/"[^"\r\n\0]*"$/u.test(value)) {
    throw new StorageError('not-supported', 'WebDAV If-Range does not accept weak entity tags.');
  }
  if (/^"[^"\r\n\0]*"$/u.test(value)) return;
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('WebDAV If-Range must be a strong entity tag or an HTTP date.');
  }
}

function responseInfo(path, properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !Object.hasOwn(properties, 'resourcetype')) {
    throw invalidResponse('WebDAV omitted the resource type.');
  }
  const resourceType = properties.resourcetype;
  const directory = resourceType && typeof resourceType === 'object' && !Array.isArray(resourceType)
    && Object.hasOwn(resourceType, 'collection');
  if (Array.isArray(resourceType)) throw invalidResponse('WebDAV repeated the resource type.');
  let size = null;
  if (!directory) {
    const length = propertyText(properties, 'getcontentlength');
    if (length !== null) {
      try { size = unsignedInteger(length, 'object size'); }
      catch { throw invalidResponse('WebDAV returned an invalid object size.'); }
    }
  }
  const version = entityTag(propertyText(properties, 'getetag'));
  return {
    name: baseName(path), kind: directory ? 'directory' : 'file', size,
    modified: lastModified(properties),
    created: propertyText(properties, 'creationdate'),
    version,
    contentType: propertyText(properties, 'getcontenttype'),
    sizeReliability: size === null ? 'unavailable' : 'reported',
    versionReliability: version === null ? 'unavailable' : version.startsWith('W/') ? 'weak' : 'reported',
  };
}

function exactLength(value) {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) throw invalidResponse('WebDAV returned an invalid content length.');
  return BigInt(value);
}

function observationDigest(entries) {
  const records = entries.map((entry) => [entry.name, entry.kind, entry.size === null ? null : String(entry.size),
    entry.modified, entry.created, entry.version]).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export class WebDavAdapter {
  #baseUrl;
  #baseSegments;
  #credentialRef;
  #resolveCredential;
  #fetch;
  #timeoutMs;
  #pageSize;
  #maxXmlBytes;
  #closed = false;
  #operations = new Set();
  #creates = new Set();
  #closePromise;

  constructor(config, { resolveCredential, fetch: fetchImplementation = globalThis.fetch } = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('WebDAV configuration must be an object.');
    if (Object.keys(config).some((key) => !configurationKeys.has(key))) throw new TypeError('WebDAV configuration contains unsupported fields.');
    this.#baseUrl = parseBaseUrl(config.baseUrl);
    this.#baseSegments = decodedPathSegments(this.#baseUrl, () => new TypeError('The WebDAV base URL is invalid.'));
    this.#credentialRef = config.credentialRef;
    if (this.#credentialRef !== undefined && (typeof this.#credentialRef !== 'string' || !this.#credentialRef)) {
      throw new TypeError('WebDAV credentialRef must be a nonempty string.');
    }
    if (this.#credentialRef !== undefined && typeof resolveCredential !== 'function') throw new TypeError('A credential resolver is required.');
    if (typeof fetchImplementation !== 'function') throw new TypeError('A fetch implementation is required.');
    this.#resolveCredential = resolveCredential;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = config.timeoutMs ?? 30000;
    this.#pageSize = config.pageSize ?? 200;
    this.#maxXmlBytes = config.maxXmlBytes ?? 8 * 1024 * 1024;
    for (const value of [this.#timeoutMs, this.#pageSize, this.#maxXmlBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('WebDAV limits must be positive safe integers.');
    }
    const declared = config.capabilities ?? {};
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)
      || Object.keys(declared).some((key) => !capabilityKeys.has(key))
      || Object.values(declared).some((value) => typeof value !== 'boolean')) {
      throw new TypeError('WebDAV capabilities must contain only supported boolean fields.');
    }
    if (declared.conditionalWrite === true && declared.replace !== true) {
      throw new TypeError('WebDAV conditionalWrite requires replace capability.');
    }
    this.capabilities = Object.freeze({
      randomRead: 'conditional', reliableLength: false, reliableVersion: false, directorySnapshot: false,
      create: declared.create === true, replace: declared.replace === true,
      conditionalWrite: declared.conditionalWrite === true,
      mkdir: declared.mkdir === true, delete: declared.delete === true, rename: declared.rename === true,
      atomicReplace: false, directLease: false, watch: false,
    });
  }

  #scope(options, { cleanup = false, retained = false } = {}) {
    checkAbort(options.signal);
    if (this.#closed && !cleanup) throw new StorageError('closed', 'The WebDAV adapter is closed.');
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
      cleanup, retained,
      responseCloseFailures: [],
      signal: controller.signal,
      abort: () => controller.abort(),
      error: (error) => {
        let result;
        if (timedOut && error?.code === 'cancelled') result = new StorageError('timeout', 'The storage operation timed out.');
        else if (error instanceof StorageError) return error;
        else if (controller.signal.aborted) result = new StorageError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'The storage operation timed out.' : 'The storage operation was cancelled.');
        else result = new StorageError('unavailable', 'The WebDAV transport failed.');
        if (retained || cleanup) Object.defineProperty(result, 'cause', { value: error });
        return result;
      },
      dispose: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.#operations.delete(scope);
      },
    };
    this.#operations.add(scope);
    return scope;
  }

  #url(path, directory = false) {
    path = normalizePath(path);
    const url = new URL(this.#baseUrl);
    const suffix = path === '/' ? '' : path.slice(1).split('/').map((part) => encodeURIComponent(part)).join('/');
    url.pathname = `${this.#baseUrl.pathname}${suffix}${directory && suffix && !suffix.endsWith('/') ? '/' : ''}`;
    return url;
  }

  #pathFromHref(value, requestUrl) {
    const href = nodeText(value);
    if (!href) throw invalidResponse('WebDAV returned an invalid resource href.');
    validateRawReferencePath(href, () => invalidResponse('WebDAV returned an unsafe resource href.'));
    let url;
    try { url = new URL(href, requestUrl); }
    catch { throw invalidResponse('WebDAV returned an invalid resource href.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== this.#baseUrl.origin || url.username || url.password || url.search || url.hash) {
      throw invalidResponse('WebDAV returned a resource href outside the configured origin.');
    }
    const segments = decodedPathSegments(url, () => invalidResponse('WebDAV returned an unsafe resource href.'));
    if (segments.length < this.#baseSegments.length
      || this.#baseSegments.some((segment, index) => segments[index] !== segment)) {
      throw invalidResponse('WebDAV returned a resource href outside the configured collection.');
    }
    const relative = segments.slice(this.#baseSegments.length);
    for (const segment of relative) validateName(segment);
    return normalizePath(`/${relative.join('/')}`);
  }

  async #headers(scope, initial = {}) {
    const headers = new Headers(initial);
    if (this.#credentialRef !== undefined) {
      let credential;
      try { credential = await this.#resolveCredential(this.#credentialRef, { signal: scope.signal }); }
      catch (error) {
        if (scope.signal.aborted || error instanceof StorageError && error.code === 'cancelled') throw error;
        throw new StorageError('authentication-required', 'WebDAV credentials are unavailable.');
      }
      if (typeof credential !== 'string' || !credential || /[\r\n\0]/u.test(credential)) {
        throw new StorageError('authentication-required', 'WebDAV credentials are unavailable.');
      }
      headers.set('Authorization', credential);
    }
    checkAbort(scope.signal);
    return headers;
  }

  async #cancelBody(response, scope, preserveFailure = false) {
    if (response?.body && !response.bodyUsed) {
      try { await response.body.cancel(); }
      catch (error) {
        if (preserveFailure) throw error;
        if (!scope.signal.aborted) throw scope.error(error);
      }
    }
  }

  async #xmlBody(response) {
    const parts = [];
    let count = 0;
    for await (const chunk of response.body ?? []) {
      count += chunk.byteLength;
      if (count > this.#maxXmlBytes) throw invalidResponse('The WebDAV response exceeded the metadata size limit.');
      parts.push(Buffer.from(chunk));
    }
    let xml;
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)); }
    catch { throw invalidResponse('WebDAV returned metadata that is not valid UTF-8.'); }
    if (!xml || /<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) {
      throw invalidResponse('WebDAV returned malformed XML.');
    }
    let parsed;
    try { parsed = xmlParser.parse(xml); }
    catch { throw invalidResponse('WebDAV returned malformed XML.'); }
    const root = normalizeDavDocument(parsed);
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw invalidResponse('WebDAV returned an invalid multistatus document.');
    return list(root.response);
  }

  #parseResponse(node, requestUrl, operation) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || Array.isArray(node.href)) {
      throw invalidResponse('WebDAV returned an invalid resource response.');
    }
    const path = this.#pathFromHref(node.href, requestUrl);
    const successful = [];
    const failures = [];
    for (const propstat of list(node.propstat)) {
      if (!propstat || typeof propstat !== 'object' || Array.isArray(propstat)) throw invalidResponse('WebDAV returned an invalid property response.');
      const status = statusCode(propstat.status);
      if (status >= 200 && status < 300) successful.push(propstat.prop);
      else failures.push(status);
    }
    if (!successful.length) {
      const status = node.status === undefined ? failures[0] : statusCode(node.status);
      if (!status) throw invalidResponse('WebDAV returned no successful properties for a resource.');
      throw statusError(status, operation);
    }
    const properties = {};
    for (const prop of successful) {
      if (!prop || typeof prop !== 'object' || Array.isArray(prop)) throw invalidResponse('WebDAV returned invalid resource properties.');
      for (const [key, value] of Object.entries(prop)) {
        if (Object.hasOwn(properties, key)) throw invalidResponse(`WebDAV repeated the ${key} property.`);
        properties[key] = value;
      }
    }
    return { path, info: responseInfo(path, properties) };
  }

  async #propfind(path, depth, options = {}) {
    path = normalizePath(path);
    const scope = this.#scope(options);
    const requestUrl = this.#url(path, depth === 1);
    let response;
    try {
      const headers = await this.#headers(scope, {
        Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8', 'Accept-Encoding': 'identity',
      });
      response = await this.#fetch(requestUrl, {
        method: 'PROPFIND', headers, body: propfindBody, redirect: 'manual', signal: scope.signal,
      });
      if (redirectStatuses.has(response.status)) throw invalidResponse('WebDAV redirects are not allowed.');
      if (response.status !== 207) {
        if (response.status >= 200 && response.status < 300) throw invalidResponse('WebDAV returned an unexpected successful PROPFIND status.');
        throw statusError(response.status, 'propfind', response.headers.get('retry-after'));
      }
      const nodes = await this.#xmlBody(response);
      return nodes.map((node) => this.#parseResponse(node, requestUrl, 'propfind'));
    } catch (error) { throw scope.error(error); }
    finally {
      try { await this.#cancelBody(response, scope); }
      finally { scope.dispose(); }
    }
  }

  async health(options = {}) {
    try { await this.stat('/', options); return { state: 'available' }; }
    catch (error) {
      if (!(error instanceof StorageError) || ['cancelled', 'closed'].includes(error.code)) throw error;
      return { state: error.code, retryAfter: error.details.retryAfter ?? null };
    }
  }

  async stat(path, options = {}) {
    path = normalizePath(path);
    const responses = await this.#propfind(path, 0, options);
    if (responses.length !== 1 || responses[0].path !== path) throw invalidResponse('WebDAV returned the wrong resource for a property request.');
    return responses[0].info;
  }

  async listPage(path, options = {}) {
    path = normalizePath(path);
    const cursor = options.cursor ?? null;
    if (cursor !== null && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).some((key) => !['path', 'digest', 'offset'].includes(key))
      || cursor.path !== path || typeof cursor.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(cursor.digest)
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 1)) {
      throw new TypeError('The WebDAV cursor is invalid.');
    }
    const responses = await this.#propfind(path, 1, options);
    const seen = new Set();
    let self = null;
    const entries = [];
    for (const response of responses) {
      if (seen.has(response.path)) throw new StorageError('incomplete-listing', 'WebDAV repeated a normalized directory entry.');
      seen.add(response.path);
      if (response.path === path) { self = response.info; continue; }
      if (parentPath(response.path) !== path) throw invalidResponse('WebDAV returned a resource that is not a direct child of the requested directory.');
      validateName(response.info.name);
      entries.push(response.info);
    }
    if (!self) throw invalidResponse('WebDAV omitted the requested directory from its listing.');
    if (self.kind !== 'directory') throw new StorageError('not-directory', 'The WebDAV object is not a directory.');
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const digest = observationDigest(entries);
    if (cursor && cursor.digest !== digest) throw new StorageError('version-changed', 'The WebDAV directory changed during enumeration.');
    const offset = cursor?.offset ?? 0;
    if (offset >= entries.length && offset !== 0) throw new TypeError('The WebDAV cursor is outside the directory listing.');
    const pageEntries = entries.slice(offset, offset + this.#pageSize);
    const nextOffset = offset + pageEntries.length;
    const complete = nextOffset === entries.length;
    return {
      entries: pageEntries,
      complete,
      nextCursor: complete ? null : { path, digest, offset: nextOffset },
      consistency: 'weak',
      snapshot: null,
      deletionSafe: false,
    };
  }

  async openRead(path, options = {}) {
    path = normalizePath(path);
    const requestedRange = normalizeRange(options.range);
    if (options.ifMatch !== undefined) strongEntityTag(options.ifMatch, 'conditional read');
    if (options.ifRange !== undefined) validateIfRange(options.ifRange);
    const metadata = await this.stat(path, options);
    if (metadata.kind !== 'file') throw new StorageError('is-directory', 'The WebDAV object is a directory.');
    if (options.ifMatch && metadata.version && metadata.version !== options.ifMatch) {
      throw new StorageError('version-changed', 'The WebDAV object version changed.');
    }
    const scope = this.#scope(options);
    let response;
    try {
      const headers = await this.#headers(scope, { 'Accept-Encoding': 'identity' });
      if (requestedRange) headers.set('Range', rangeHeader(requestedRange));
      if (options.ifMatch) headers.set('If-Match', options.ifMatch);
      if (options.ifRange) headers.set('If-Range', options.ifRange);
      response = await this.#fetch(this.#url(path), { method: 'GET', headers, redirect: 'manual', signal: scope.signal });
      if (redirectStatuses.has(response.status)) throw invalidResponse('WebDAV redirects are not allowed.');
      if (![200, 206].includes(response.status)) {
        const error = statusError(response.status, 'read', response.headers.get('retry-after'));
        if (response.status === 416) {
          const total = /^bytes \*\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
          throw new StorageError(error.code, error.message, {
            ...error.details, totalSize: total ? BigInt(total[1]) : null,
            contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'),
          });
        }
        throw error;
      }
      if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
        throw invalidResponse('WebDAV encoded a raw byte response.');
      }
      const version = entityTag(response.headers.get('etag'));
      if (options.ifMatch && version !== options.ifMatch) {
        throw new StorageError(version ? 'version-changed' : 'not-supported', 'WebDAV did not prove the requested object version.');
      }
      if (response.status === 206 && typeof options.ifRange === 'string' && /^"[^"\r\n\0]*"$/u.test(options.ifRange)
        && version !== options.ifRange) {
        throw new StorageError(version ? 'version-changed' : 'not-supported', 'WebDAV returned a different entity for the conditional range.');
      }
      const rangeHonored = response.status === 206;
      let range = null;
      let totalSize = null;
      const contentLength = exactLength(response.headers.get('content-length'));
      if (rangeHonored) {
        if (!requestedRange) throw invalidResponse('WebDAV returned an unsolicited partial response.');
        const parsed = parseContentRange(response.headers.get('content-range'));
        range = { start: parsed.start, end: parsed.end };
        totalSize = parsed.totalSize;
        if (contentLength !== null && contentLength !== range.end - range.start + 1n) {
          throw invalidResponse('The WebDAV range length is inconsistent.');
        }
        if (totalSize !== null) {
          const expected = resolveRange(requestedRange, totalSize);
          if (range.start !== expected.start || range.end !== expected.end) throw invalidResponse('WebDAV returned a different byte range.');
        } else if (requestedRange.suffix !== undefined || range.start !== requestedRange.start
          || requestedRange.end !== null && range.end > requestedRange.end) {
          throw invalidResponse('The WebDAV range cannot be verified.');
        }
      } else {
        if (response.headers.has('content-range')) throw invalidResponse('WebDAV returned a full response with a partial range header.');
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
            if (expectedLength !== null && count > expectedLength) throw invalidResponse('WebDAV sent more bytes than declared.');
            yield value;
          }
          if (expectedLength !== null && count !== expectedLength) throw invalidResponse('The WebDAV read ended before its declared length.');
        } catch (error) { throw scope.error(error); }
        finally { await close(); }
      }
      return {
        stream: stream(), rangeHonored, range, totalSize, contentLength, version,
        contentType: response.headers.get('content-type'), acceptRanges: response.headers.get('accept-ranges'), close,
      };
    } catch (error) {
      try { await this.#cancelBody(response, scope); }
      finally { scope.dispose(); }
      throw scope.error(error);
    }
  }

  #writeCapabilities(options) {
    if (options.overwrite === false && options.ifMatch !== undefined) throw new TypeError('A create-only WebDAV write cannot also require an existing version.');
    if (options.overwrite === false) requireCapability(this, 'create');
    else if (options.ifMatch !== undefined) {
      requireCapability(this, 'replace');
      requireCapability(this, 'conditionalWrite');
    } else {
      requireCapability(this, 'create');
      requireCapability(this, 'replace');
    }
  }

  async #mutation(operation, path, { method, headers: initialHeaders = {}, body, statuses, options,
    errorContext = {}, scope: admittedScope, accepted }) {
    const scope = admittedScope ?? this.#scope(options);
    let response, result, failed = false, failure;
    try {
      const headers = await this.#headers(scope, initialHeaders);
      checkAbort(scope.signal);
      const request = { method, headers, redirect: 'manual', signal: scope.signal };
      if (body !== undefined) {
        request.body = body;
        if (!(body instanceof Uint8Array) && typeof body !== 'string') request.duplex = 'half';
      }
      response = await this.#fetch(this.#url(path), request);
      if (redirectStatuses.has(response.status)) throw invalidResponse('WebDAV redirects are not allowed.');
      if (!statuses.includes(response.status)) {
        if (response.status >= 200 && response.status < 300) throw invalidResponse(`WebDAV returned an unsafe successful ${operation} status.`);
        throw statusError(response.status, operation, response.headers.get('retry-after'), errorContext);
      }
      accepted?.();
      result = { version: entityTag(response.headers.get('etag')) };
    } catch (error) {
      failed = true; failure = scope.error(error);
    }
    finally {
      try { await this.#cancelBody(response, scope, Boolean(admittedScope)); }
      catch (error) {
        if (!admittedScope) throw error;
        const closeFailure = scope.error(error);
        scope.responseCloseFailures.push(closeFailure);
        if (!failed) { failed = true; failure = closeFailure; }
      }
      finally { if (!admittedScope) scope.dispose(); }
    }
    if (failed) throw failure;
    return result;
  }

  async #create(path, data, size, headers, options) {
    const scope = this.#scope(options, { retained: true });
    const pending = Promise.withResolvers();
    this.#creates.add(pending.promise);
    const parent = parentPath(path);
    const scratch = `${parent === '/' ? '' : parent}/.mediamanager-create-${randomUUID()}`;
    let owned = false, published = false, failed = false, failure;
    let upload, uploadClosed, uploadFinished, iterator, sourceClose;
    const cleanupErrors = [];
    const cancellation = new StorageError('cancelled', 'The WebDAV upload was cancelled.');
    const closeSource = () => {
      if (!sourceClose) {
        sourceClose = (async () => {
          const release = iterator?.return;
          if (release != null) {
            const result = await release.call(iterator);
            await result?.value;
          }
        })();
        // The owner awaits this exact rejection during teardown.
        sourceClose.catch(() => {});
      }
      return sourceClose;
    };
    const cancelUpload = () => { upload?.destroy(cancellation); closeSource(); };
    try {
      const input = data instanceof Uint8Array ? [data] : data;
      const iterate = input?.[Symbol.asyncIterator] ?? input?.[Symbol.iterator];
      if (typeof iterate !== 'function') throw new TypeError('An upload must provide bytes.');
      iterator = iterate.call(input);
      await this.#mutation('mkdir', scratch, { method: 'MKCOL', statuses: [201], options, scope,
        // A lost/unsafe MKCOL response cannot establish ownership. Never delete
        // a collection unless this request observed its exclusive creation.
        accepted: () => { owned = true; } });
      checkAbort(scope.signal);
      async function* body() {
        let count = 0n;
        for (;;) {
          checkAbort(scope.signal);
          let part;
          try { part = await iterator.next(); }
          catch (reason) {
            if (reason instanceof Error) throw reason;
            const error = new StorageError('unavailable', 'The WebDAV upload source failed.');
            Object.defineProperty(error, 'cause', { value: reason });
            throw error;
          }
          checkAbort(scope.signal);
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw new TypeError('Upload chunks must be bytes.');
          count += BigInt(part.value.byteLength);
          if (count > size) throw invalidResponse('The WebDAV upload exceeded its declared length.');
          yield part.value;
        }
        if (count !== size) throw invalidResponse('The WebDAV upload ended before its declared length.');
      }
      upload = Readable.from(body(), { objectMode: false, autoDestroy: true });
      uploadClosed = new Promise(resolve => upload.once('close', resolve));
      uploadFinished = finished(upload, { cleanup: true });
      uploadFinished.catch(() => {});
      scope.signal.addEventListener('abort', cancelUpload, { once: true });
      let requestBody = upload;
      if (size === 0n) {
        for await (const _chunk of upload) { /* Validate and drain an empty entity's real producer. */ }
        requestBody = Buffer.alloc(0);
      }
      await this.#mutation('write', scratch + '/payload', { method: 'PUT', headers, body: requestBody,
        statuses: [200, 201, 204], options, scope });
      await uploadFinished;
      checkAbort(scope.signal);
      const result = await this.#mutation('rename', scratch + '/payload', {
        method: 'MOVE', headers: { Destination: this.#url(path).href, Overwrite: 'F' }, statuses: [201],
        errorContext: { destinationExclusive: true }, options, scope,
        accepted: () => { published = true; },
      });
      return { size, atomic: false, version: result.version };
    } catch (error) {
      failed = true; failure = scope.error(error);
    } finally {
      scope.signal.removeEventListener('abort', cancelUpload);
      cleanupErrors.push(...scope.responseCloseFailures);
      // No business stage may resume during teardown. Abort its transport even
      // when response cancellation itself rejected; cleanup has its own scope.
      scope.abort();
      if (upload) upload.destroy(cancellation);
      try { await closeSource(); }
      catch (error) {
        const safe = error instanceof StorageError ? error
          : new StorageError('unavailable', 'The WebDAV upload source did not close.');
        if (!(error instanceof StorageError)) Object.defineProperty(safe, 'cause', { value: error });
        cleanupErrors.push(safe);
      }
      if (uploadClosed) await uploadClosed;
      if (uploadFinished) {
        try { await uploadFinished; }
        catch (error) {
          if (!failed && error !== cancellation) { failed = true; failure = scope.error(error); }
        }
      }
      if (owned) {
        // Cleanup belongs to this admitted create. It has its own bounded
        // transport lifetime after caller cancellation or adapter close.
        const cleanupScope = this.#scope({}, { cleanup: true });
        try {
          await this.#mutation('delete', scratch, { method: 'DELETE', statuses: [200, 204, 404],
            options: {}, scope: cleanupScope });
        } catch (error) { cleanupErrors.push(cleanupScope.error(error)); }
        finally {
          for (const error of cleanupScope.responseCloseFailures) if (!cleanupErrors.includes(error)) cleanupErrors.push(error);
          cleanupScope.dispose();
        }
      }
      scope.dispose();
      pending.resolve(cleanupErrors);
      // A failed cleanup remains visible to close; it cannot be acknowledged
      // as released merely because its request has settled.
      if (!cleanupErrors.length) this.#creates.delete(pending.promise);
      if (cleanupErrors.length) {
        const primary = failed ? failure : cleanupErrors[0];
        const error = new StorageError(primary.code, 'The WebDAV create could not finish every owned operation.',
          { ...primary.details, publicationConfirmed: published });
        const causes = failed ? [failure, ...cleanupErrors.filter(error => error !== failure)] : cleanupErrors;
        Object.defineProperty(error, 'cause', { value: new AggregateError(causes,
          'WebDAV create and staging cleanup failures.', { cause: primary }) });
        throw error;
      }
      if (failed) {
        if (published) {
          const error = new StorageError(failure.code, failure.message, { ...failure.details, publicationConfirmed: true });
          Object.defineProperty(error, 'cause', { value: failure });
          throw error;
        }
        throw failure;
      }
    }
  }

  async write(path, data, options = {}) {
    this.#writeCapabilities(options);
    if (options.atomic === true) throw new StorageError('not-supported', 'WebDAV does not guarantee atomic replacement.');
    if (options.modified !== undefined) throw new StorageError('not-supported', 'WebDAV does not provide a portable modification-time write.');
    path = normalizePath(path);
    if (path === '/') throw new StorageError('permission-denied', 'The WebDAV root cannot be replaced.');
    if (options.ifMatch !== undefined) strongEntityTag(options.ifMatch, 'conditional write');
    const bytes = data instanceof Uint8Array ? data : null;
    const size = bytes ? BigInt(bytes.byteLength) : unsignedInteger(options.size, 'upload size');
    if (options.size !== undefined && unsignedInteger(options.size, 'upload size') !== size) {
      throw new TypeError('The upload size does not match its byte array.');
    }
    const headers = {
      'Content-Type': options.contentType === undefined ? 'application/octet-stream' : safeHeader(options.contentType, 'WebDAV content type'),
      'Content-Length': String(size),
    };
    if (options.overwrite === false) return this.#create(path, data, size, headers, options);
    if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
    let upload = bytes;
    if (!bytes) {
      async function* checkedBody() {
        let count = 0n;
        for await (const chunk of data) {
          checkAbort(options.signal);
          if (!(chunk instanceof Uint8Array)) throw new TypeError('Upload chunks must be bytes.');
          count += BigInt(chunk.byteLength);
          if (count > size) throw invalidResponse('The WebDAV upload exceeded its declared length.');
          yield chunk;
        }
        if (count !== size) throw invalidResponse('The WebDAV upload ended before its declared length.');
      }
      upload = checkedBody();
    }
    const result = await this.#mutation('write', path, {
      method: 'PUT', headers, body: upload,
      statuses: options.ifMatch !== undefined ? [200, 204] : [200, 201, 204], options,
    });
    return { size, atomic: false, version: result.version };
  }

  async mkdir(path, options = {}) {
    requireCapability(this, 'mkdir');
    path = normalizePath(path);
    if (path === '/') throw new StorageError('permission-denied', 'The WebDAV root cannot be created.');
    await this.#mutation('mkdir', path, { method: 'MKCOL', statuses: [201], options });
  }

  async delete(path, options = {}) {
    requireCapability(this, 'delete');
    path = normalizePath(path);
    if (path === '/') throw new StorageError('permission-denied', 'The WebDAV root cannot be removed.');
    const headers = {};
    if (options.ifMatch !== undefined) {
      requireCapability(this, 'conditionalWrite');
      headers['If-Match'] = strongEntityTag(options.ifMatch, 'conditional delete');
    }
    await this.#mutation('delete', path, { method: 'DELETE', headers, statuses: [200, 204], options });
  }

  async rename(path, destination, options = {}) {
    requireCapability(this, 'rename');
    path = normalizePath(path);
    destination = normalizePath(destination);
    if (path === '/' || destination === '/') throw new StorageError('permission-denied', 'The WebDAV root cannot be renamed.');
    if (path === destination) return;
    if (isWithin(destination, path)) throw new StorageError('invalid-path', 'A WebDAV object cannot be moved into itself.');
    if (options.overwrite === true) requireCapability(this, 'replace');
    const headers = { Destination: this.#url(destination).href, Overwrite: options.overwrite === true ? 'T' : 'F' };
    if (options.ifMatch !== undefined) {
      requireCapability(this, 'conditionalWrite');
      headers['If-Match'] = strongEntityTag(options.ifMatch, 'conditional rename');
    }
    await this.#mutation('rename', path, {
      method: 'MOVE', headers, statuses: options.overwrite === true ? [201, 204] : [201], options,
      errorContext: { destinationExclusive: options.overwrite !== true && options.ifMatch === undefined },
    });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    const closing = Promise.withResolvers();
    this.#closePromise = closing.promise;
    this.#closed = true;
    for (const scope of this.#operations) if (!scope.cleanup) {
      scope.abort(); if (!scope.retained) scope.dispose();
    }
    (async () => {
      const failures = (await Promise.all([...this.#creates])).flat();
      if (failures.length) throw new AggregateError(failures, 'WebDAV staging resources failed to close.', { cause: failures[0] });
    })().then(closing.resolve, closing.reject);
    return this.#closePromise;
  }
}
