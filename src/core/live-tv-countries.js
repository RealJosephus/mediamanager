import path from 'node:path';
import * as fs from 'node:fs/promises';
import { decodeNativeText } from './native-text.js';
import { parseInvariantDate } from './invariant-date-parse.js';

const countryUrl = 'https://json.schedulesdirect.org/20141201/available/countries';
const cacheMilliseconds = 7 * 86400000;
const ioCodes = new Set(['EIO', 'ENOENT', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EBUSY', 'ENOSPC', 'EEXIST', 'ENAMETOOLONG', 'EROFS', 'EFBIG', 'EINVAL']);
const io = error => ioCodes.has(error?.code);
const unavailable = () => Object.assign(new Error('Live TV country discovery has closed.'), { status: 503 });
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
function day(value, utc = true) {
  const date = new Date(value);
  return utc ? date.toISOString().slice(0, 10) : `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** SchedulesDirect.GetAvailableCountries is a raw-byte discovery/cache client.
 * This does not implement authenticated SD listings or its execution paths. */
export class LiveTvCountriesClient {
  #cache;
  #closed = false;
  #closing;
  #work = new Set();
  #initialization;
  #imageLimitDate = null;
  constructor(options = {}) {
    const { cachePath, fileSystem = fs, fetch = globalThis.fetch, now = () => new Date(), url = countryUrl,
      timeoutMs = 100000, userAgent } = options;
    if (typeof cachePath !== 'string' || !cachePath || typeof fileSystem?.stat !== 'function'
      || typeof fileSystem?.readFile !== 'function' || typeof fileSystem?.open !== 'function'
      || typeof fileSystem?.mkdir !== 'function' || typeof fileSystem?.unlink !== 'function'
      || typeof fetch !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647
      || userAgent !== undefined && typeof userAgent !== 'string') throw new TypeError('Country discovery requires its instance cache, filesystem, HTTP client and clock.');
    Object.assign(this, { fileSystem, fetch, now, url, timeoutMs, userAgent, pathOptions: options });
  }
  get cachePath() { return this.pathOptions.cachePath; }

  #admit(operation) {
    if (this.#closed) return Promise.reject(unavailable());
    const completion = Promise.withResolvers(); this.#work.add(completion.promise);
    return (async () => {
      try { return await operation(); }
      finally { this.#work.delete(completion.promise); completion.resolve(); }
    })();
  }

  initialize() { return this.#admit(() => this.#initialize()); }
  #initialize() {
    return this.#initialization ??= this.#loadDailyLimitDate().then(value => { this.#imageLimitDate = value; });
  }
  async #exists(filename) {
    try { return !(await this.fileSystem.stat(filename)).isDirectory(); }
    catch { return false; }
  }
  async #tryDelete(filename) {
    try { await this.fileSystem.unlink(filename); }
    catch (error) { if (!io(error)) throw error; }
  }
  async #loadDailyLimitDate() {
    const filename = path.join(this.cachePath, 'sd-image-limit.txt');
    if (!await this.#exists(filename)) return null;
    try {
      const text = trim(decodeNativeText(await this.fileSystem.readFile(filename)));
      const parsed = parseInvariantDate(text, { now: new Date(this.now()) });
      if (parsed !== null) {
        // RoundtripKind preserves a Z DateTime as UTC; explicit offsets and
        // unspecified dates are local DateTime wall values before DateOnly.
        const date = day(parsed, /Z$/iu.test(text.replace(/\0+$/gu, '')));
        if (date < day(this.now())) { await this.fileSystem.unlink(filename); return null; }
        return date;
      }
    } catch (error) { if (!io(error)) throw error; await this.#tryDelete(filename); }
    return null;
  }

  isImageDailyLimitActive() {
    return this.#admit(async () => {
      await this.#initialize();
      if (this.#imageLimitDate === null) return false;
      if (this.#imageLimitDate < day(this.now())) {
        this.#imageLimitDate = null;
        await this.#tryDelete(path.join(this.cachePath, 'sd-image-limit.txt'));
        return false;
      }
      return true;
    });
  }

  getCountries() { return this.#admit(async () => { await this.#initialize(); return this.#getCountries(); }); }

  async #getCountries() {
    if (this.#cache !== undefined) return Buffer.from(this.#cache);
    const filename = path.join(this.cachePath, 'sd-countries.json');
    // File.Exists suppresses filesystem observation errors and excludes dirs.
    const exists = await this.#exists(filename);
    if (exists) {
      let modified;
      try { modified = (await this.fileSystem.stat(filename)).mtimeMs; }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        modified = Date.parse('1601-01-01T00:00:00Z');
      }
      if (new Date(this.now()).getTime() - modified < cacheMilliseconds) {
        try {
          const bytes = await this.fileSystem.readFile(filename);
          this.#cache = Buffer.from(bytes); return Buffer.from(this.#cache);
        } catch (error) {
          if (!io(error)) throw error;
          await this.#tryDelete(filename);
        }
      }
    }
    let response, bytes; const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('The HTTP client request timed out.', 'TimeoutError')), this.timeoutMs); timer.unref?.();
    try {
      response = await this.fetch(this.url, { signal: timeout.signal, headers: { Accept: 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8',
        ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}) } });
      // Default HttpClient.GetAsync buffers content before EnsureSuccessStatusCode.
      bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw Object.assign(new Error(`Response status code does not indicate success: ${response.status}.`),
        { code: 'http-error', httpStatus: response.status, status: 500 });
    } catch (error) {
      if (error.status != null && error.status !== 500) error.httpStatus ??= error.status;
      error.status = 500;
      throw error;
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => {}); }
    await this.fileSystem.mkdir(path.dirname(filename), { recursive: true });
    // Match File.WriteAllBytesAsync: create/truncate before the async write,
    // and do not publish memory bytes until both write and disposal succeed.
    const file = await this.fileSystem.open(filename, 'w'); let primary;
    try { await file.writeFile(bytes); }
    catch (error) { primary = error; throw error; }
    finally {
      try { await file.close(); }
      catch (error) { throw primary ? new AggregateError([primary, error], primary.message, { cause: primary }) : error; }
    }
    this.#cache = bytes; return Buffer.from(bytes);
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = (async () => { while (this.#work.size) await Promise.allSettled([...this.#work]); })();
  }
}
