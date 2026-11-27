import path from 'node:path';
import * as fs from 'node:fs/promises';
import { decodeNativeText } from './native-text.js';
import { parseInvariantDate } from './invariant-date-parse.js';

const countryUrl = 'https://json.schedulesdirect.org/20141201/available/countries';
const cacheMilliseconds = 7 * 86400000;
const ioCodes = new Set(['EIO', 'ENOENT', 'ENOTDIR', 'EMFILE', 'ENFILE', 'EBUSY', 'ENOSPC', 'EEXIST', 'ENAMETOOLONG', 'EROFS', 'EFBIG', 'EINVAL']);
const io = error => ioCodes.has(error?.code);
const unavailable = () => Object.assign(new Error('Live TV country discovery has closed.'), { status: 503 });
const httpFailure = reason => Object.assign(new Error(reason?.message ?? 'The country discovery HTTP request failed.', { cause: reason }),
  Object.fromEntries(['code', 'statusCode', 'errors'].filter(key => reason?.[key] !== undefined).map(key => [key, reason[key]])),
  { status: 500 }, reason?.httpStatus != null || reason?.status != null && reason.status !== 500
    ? { httpStatus: reason.httpStatus ?? reason.status } : {});
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Country cache cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
function day(value, utc = true) {
  const date = new Date(value);
  return utc ? date.toISOString().slice(0, 10) : `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const imageKey = url => url.replace(/^.*?\/image\//iu, '').split('?')[0];

/** Shared Schedules Direct country cache and per-image admission state. */
export class LiveTvCountriesClient {
  #cache;
  #closed = false;
  #closing;
  #work = new Set();
  #initialization;
  #imageLimitDate = null;
  #metadataInitialization;
  #metadataLimitDate = null;
  #tokenGeneration = 0;
  #rejectedImages;
  #consecutiveFailures = 0;
  #rejectionWrite = Promise.resolve();
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
  get tokenGeneration() { return this.#tokenGeneration; }

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
  async #loadDailyLimitDate(name = 'sd-image-limit.txt') {
    const filename = path.join(this.cachePath, name);
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

  async #limitActive(metadata) {
    if (metadata) await (this.#metadataInitialization ??= this.#loadDailyLimitDate('sd-metadata-limit.txt').then(date => { this.#metadataLimitDate = date; }));
    else await this.#initialize();
    const date = metadata ? this.#metadataLimitDate : this.#imageLimitDate;
    if (date === null) return false;
    if (date >= day(this.now())) return true;
    if (metadata) this.#metadataLimitDate = null;
    else { this.#imageLimitDate = null; this.#consecutiveFailures = 0; }
    await this.#tryDelete(path.join(this.cachePath, metadata ? 'sd-metadata-limit.txt' : 'sd-image-limit.txt'));
    return false;
  }
  isImageDailyLimitActive() { return this.#admit(() => this.#limitActive(false)); }
  isMetadataDailyLimitActive() { return this.#admit(() => this.#limitActive(true)); }

  async #imageKeys() {
    return this.#rejectedImages ??= (async () => {
      const keys = new Set(), cutoff = day(new Date(this.now()).getTime() - 30 * 86400000);
      const file = path.join(this.cachePath, 'sd-rejected-images.txt');
      if (await this.#exists(file)) {
        const lines = decodeNativeText(await this.fileSystem.readFile(file)).split(/\r?\n/u);
        for (const line of lines) {
          const match = /^(\d{4}-\d{2}-\d{2})\t(.+)$/u.exec(line);
          if (match && match[1] >= cutoff && keys.size < 10000) keys.add(match[2]);
        }
      }
      return keys;
    })();
  }
  canDownloadImage(url) {
    return this.#admit(async () => !/schedulesdirect/iu.test(url) || !await this.#limitActive(false)
      && !(await this.#imageKeys()).has(imageKey(url)));
  }
  async #markLimit(metadata) {
    await this.#limitActive(metadata);
    const stamp = new Date(this.now());
    if (metadata) this.#metadataLimitDate = day(stamp);
    else this.#imageLimitDate = day(stamp);
    try {
      await this.fileSystem.mkdir(this.cachePath, { recursive: true });
      await this.fileSystem.writeFile(path.join(this.cachePath, metadata ? 'sd-metadata-limit.txt' : 'sd-image-limit.txt'), stamp.toISOString());
    } catch (error) { if (!io(error)) throw error; }
  }
  markImageLimit() { return this.#admit(() => this.#markLimit(false)); }
  markMetadataLimit() { return this.#admit(() => this.#markLimit(true)); }
  reportImageSuccess(url) { if (/schedulesdirect/iu.test(url)) this.#consecutiveFailures = 0; }
  reportImageFailure(url, error) {
    return this.#admit(async () => {
      if (!/schedulesdirect/iu.test(url)) return false;
      const code = error.sdCode;
      if (code == null) {
        if (++this.#consecutiveFailures === 10) await this.#markLimit(false);
        return false;
      }
      this.#consecutiveFailures = 0;
      if ([1004, 1010, 4006].includes(code)) this.#tokenGeneration++;
      if ([4009, 4010].includes(code)) await this.#markLimit(true);
      if ([4009, 4010, 5002, 5003, 5004].includes(code)) await this.#markLimit(false);
      if (code === 5000) {
        const keys = await this.#imageKeys(), key = imageKey(url);
        if (key && !/[\r\n\t]/u.test(key) && keys.size < 10000 && !keys.has(key)) {
          keys.add(key);
          const file = path.join(this.cachePath, 'sd-rejected-images.txt');
          const write = this.#rejectionWrite.then(async () => {
            await this.fileSystem.mkdir(this.cachePath, { recursive: true });
            const prior = await this.#exists(file) ? await this.fileSystem.readFile(file, 'utf8') : '';
            await this.fileSystem.writeFile(file, prior + day(this.now()) + '\t' + key + '\n');
          });
          this.#rejectionWrite = write.catch(() => {});
          await this.#rejectionWrite;
        }
      }
      return [1004, 1010, 4006, 5000, 5004].includes(code);
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
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
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
      throw httpFailure(error);
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => {}); }
    await this.fileSystem.mkdir(path.dirname(filename), { recursive: true });
    // Match File.WriteAllBytesAsync: create/truncate before the async write,
    // and do not publish memory bytes until both write and disposal succeed.
    const file = await this.fileSystem.open(filename, 'w'), errors = [];
    try { await file.writeFile(bytes); }
    catch (error) { errors.push(error); }
    try { await file.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw operationFailure(errors);
    this.#cache = bytes; return Buffer.from(bytes);
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = (async () => { while (this.#work.size) await Promise.allSettled([...this.#work]); })();
  }
}
