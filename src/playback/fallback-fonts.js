import path from 'node:path';
import { once } from 'node:events';
import { BinaryResult } from '../http/binary-result.js';
import { HttpResult } from '../http/binding.js';
import { getMimeType } from '../http/mime-types.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { nativeDateFromUnixNanoseconds, wireDate } from '../users/native.js';
import { dateTicks } from '../library/records.js';
import { parseInvariantDateExact } from '../core/invariant-date-format.js';
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';

const extensions = ['.woff', '.woff2', '.ttf', '.otf'];
const maximumBytes = 20n * 1024n * 1024n;
const pathApi = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
const closedError = () => Object.assign(new Error('Fallback font access is closing.'), { code: 'closed', status: 503 });
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const dateWhitespace = new RegExp(`[${clrWhitespace}]+`, 'gu');
const httpDateFormats = [
  ...['yyyy', 'yy'].flatMap(year => ['', 'ddd, '].flatMap(prefix => ['', " 'GMT'"].map(zone => `${prefix}d MMM ${year} H:m:s${zone}`))),
  "dddd, d-MMM-yy H:m:s 'GMT'", 'dddd, d-MMM-yy H:m:s', "ddd, d-MMM-yyyy H:m:s 'GMT'", 'ddd MMM d H:m:s yyyy',
  'ddd, d MMM yyyy H:m:s zzz', 'd MMM yyyy H:m:s zzz',
];
function httpDate(value) {
  if (typeof value !== 'string') return NaN;
  const text = clrTrim(value).replace(dateWhitespace, ' ').replace(/ *, */gu, ', ').replace(/ *: */gu, ':');
  for (const format of httpDateFormats) {
    const parsed = parseInvariantDateExact(text, format); if (parsed !== null) return Date.parse(parsed);
  }
  return NaN;
}
const cancelled = (error, signal) => signal.aborted && (error instanceof AggregateError
  ? error.errors.length > 0 && error.errors.every(value => cancelled(value, signal))
  : error === signal.reason || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'cancelled');
const failure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Fallback font resources failed to close.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(name => errors[0]?.[name] !== undefined).map(name => [name, errors[0][name]])));

/** The configured directory is an identity path resolved by storage plugins. */
export class FallbackFonts {
  #closed = false;
  #closing;
  #lifetime = new AbortController();
  #operations = new Set();
  #responses = new Set();
  #closeFailures = [];

  constructor({ fileSystem, getEncodingOptions, localization }) {
    if (typeof getEncodingOptions !== 'function' || !fileSystem
      || ['resolve', 'stat', 'readdir', 'openRead'].some(name => typeof fileSystem[name] !== 'function')) {
      throw new TypeError('Fallback fonts require mapped file access and a current encoding configuration getter.');
    }
    Object.assign(this, { fileSystem, getEncodingOptions, localization });
  }

  #run(signal, operation) {
    if (this.#closed) return Promise.reject(closedError());
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const operationState = {};
    const pending = Promise.resolve().then(async () => {
      try { combined.throwIfAborted(); return await operation(combined, operationState); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error?.code)) error.status ??= 404;
        throw error;
      }
    });
    this.#operations.add(pending);
    const finished = (failed, error) => {
      this.#operations.delete(pending);
      // Record each operation once. A cleanup failure remains observable at
      // owner close even if its HTTP response has already finished.
      if (Object.hasOwn(operationState, 'cleanupFailure')) this.#closeFailures.push(operationState.cleanupFailure);
      else if (this.#closed && failed && !cancelled(error, this.#lifetime.signal)) this.#closeFailures.push(error);
    };
    pending.then(() => finished(false), error => finished(true, error));
    return pending;
  }

  async #files(root, signal) {
    // Establish an actual mapped backend before treating a missing directory
    // as Directory.Exists=false. Missing mappings and instances are failures.
    this.fileSystem.resolve(root);
    let directory;
    try { directory = await this.fileSystem.stat(root, { signal }); }
    catch (error) {
      // Directory.Exists also returns false for an impossible filename. The
      // mapping above must succeed before a backend path probe is classified.
      if (['ENOENT', 'ENOTDIR', 'invalid-path'].includes(error?.code)) return [];
      throw error;
    }
    signal.throwIfAborted();
    if (!directory.isDirectory()) return [];
    const entries = await this.fileSystem.readdir(root, { withFileTypes: true, signal });
    signal.throwIfAborted(); return entries.filter(entry => entry.isFile());
  }

  list({ signal } = {}) {
    return this.#run(signal, async currentSignal => {
      const options = await this.getEncodingOptions(), root = options.FallbackFontPath;
      currentSignal.throwIfAborted();
      if (root === null || root === '') { options.EnableFallbackFont = false; return []; }
      const api = pathApi(root), files = await this.#files(root, currentSignal), fonts = [];
      for (const entry of files) {
        const dot = entry.name.lastIndexOf('.'), suffix = dot < 0 || dot === entry.name.length - 1 ? '' : entry.name.slice(dot);
        if (!extensions.some(extension => ordinalIgnoreCaseEquals(extension, suffix))) continue;
        const info = await this.fileSystem.stat(api.join(root, entry.name), { bigint: true, signal: currentSignal });
        currentSignal.throwIfAborted();
        fonts.push({ Name: entry.name, Size: BigInt(info.size),
          DateCreated: wireDate(nativeDateFromUnixNanoseconds(info.birthtimeNs)),
          DateModified: wireDate(nativeDateFromUnixNanoseconds(info.mtimeNs)) });
      }
      const names = new Intl.Collator(this.localization?.context.culture ?? 'en-US');
      fonts.sort((left, right) => compare(left.Size, right.Size) || names.compare(left.Name, right.Name)
        || compare(dateTicks(right.DateModified), dateTicks(left.DateModified))
        || compare(dateTicks(right.DateCreated), dateTicks(left.DateCreated)));
      let size = 0n;
      const result = [];
      for (const font of fonts) { size += font.Size; if (size >= maximumBytes) break; result.push(font); }
      return result;
    });
  }

  file(name, { signal } = {}) {
    return this.#run(signal, async currentSignal => {
      const options = await this.getEncodingOptions(), root = options.FallbackFontPath;
      currentSignal.throwIfAborted();
      if (root === null || root === '') { options.EnableFallbackFont = false; return new HttpResult(200); }
      const entries = await this.#files(root, currentSignal);
      const selected = entries.find(entry => ordinalIgnoreCaseEquals(entry.name, name));
      if (!selected) return new HttpResult(200);
      const filename = pathApi(root).join(root, selected.name);
      const info = await this.fileSystem.stat(filename, { bigint: true, signal: currentSignal });
      currentSignal.throwIfAborted();
      if (info.size <= 0n) return new HttpResult(200);
      return new BinaryResult((request, response) => this.#run(signal, (active, operation) => this.#send(filename, request, response, active, operation)));
    });
  }

  async #send(filename, request, response, active, operation) {
    const controller = new AbortController(), abort = () => controller.abort();
    const signal = AbortSignal.any([active, controller.signal]);
    request.once('aborted', abort); response.once('close', abort); this.#responses.add(response);
    if (request.aborted || response.destroyed) controller.abort();
    const previousHeaders = new Map();
    const setHeader = (name, value) => {
      const key = name.toLowerCase();
      if (!previousHeaders.has(key)) previousHeaders.set(key, response.getHeader(name));
      response.setHeader(name, value);
    };
    let handle, failed = false, primary;
    try {
      signal.throwIfAborted();
      // PhysicalFile resolves its file information when the result executes.
      const info = await this.fileSystem.stat(filename, { bigint: true, signal });
      if (!info.isFile()) throw Object.assign(new Error('The fallback font is no longer a file.'), { code: 'ENOENT', status: 404 });
      const fraction = (info.mtimeNs % 1_000_000_000n + 1_000_000_000n) % 1_000_000_000n;
      const modified = Number((info.mtimeNs - fraction) / 1_000_000_000n) * 1000;
      setHeader('Last-Modified', new Date(modified).toUTCString());
      const since = httpDate(request.headers['if-modified-since']), unmodified = httpDate(request.headers['if-unmodified-since']);
      const now = Math.floor(Date.now() / 1000) * 1000;
      const validSince = Number.isFinite(since) && since <= now, validUnmodified = Number.isFinite(unmodified) && unmodified <= now;
      if (validUnmodified && modified > unmodified) {
        response.statusCode = 412; response.end(); return;
      }
      if (validSince && modified <= since && !validUnmodified) {
        response.statusCode = 304; response.end(); return;
      }
      setHeader('Content-Type', getMimeType(filename));
      setHeader('Content-Length', String(info.size));
      if (request.method === 'HEAD') { response.end(); return; }
      handle = await this.fileSystem.openRead(filename, { signal });
      let written = 0n;
      for await (const chunk of handle.stream) {
        signal.throwIfAborted(); written += BigInt(chunk.byteLength);
        if (written > info.size) throw Object.assign(new Error('The fallback font exceeded its declared length.'), { code: 'invalid-response' });
        if (!response.write(chunk)) await once(response, 'drain', { signal });
      }
      if (written !== info.size) throw Object.assign(new Error('The fallback font ended before its declared length.'), { code: 'invalid-response' });
      response.end();
    } catch (error) {
      failed = true; primary = error;
      if (response.headersSent || cancelled(error, signal)) response.destroy();
      if (!cancelled(error, signal)) {
        // An unpublished file selection must not frame the middleware's error body.
        if (!response.headersSent) for (const [name, value] of previousHeaders) {
          if (value === undefined) response.removeHeader(name); else response.setHeader(name, value);
        }
        throw error;
      }
    } finally {
      request.removeListener('aborted', abort); response.removeListener('close', abort); this.#responses.delete(response);
      try { await handle?.close(); }
      catch (cleanup) {
        operation.cleanupFailure = failed ? failure([primary, cleanup]) : cleanup;
        throw operation.cleanupFailure;
      }
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    this.#lifetime.abort(closedError());
    for (const response of this.#responses) response.destroy();
    void (async () => {
      while (this.#operations.size) {
        await Promise.allSettled([...this.#operations]);
      }
      if (this.#closeFailures.length) throw failure(this.#closeFailures);
    })().then(completion.resolve, completion.reject);
    return this.#closing;
  }
}
