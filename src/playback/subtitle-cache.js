import path from 'node:path';
import { nativeGuid } from '../users/native.js';
import { requireCapability, StorageError } from '../storage/errors.js';
import { decodeNativeTextEncoding } from '../core/native-text.js';

const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error?.code);
const ioError = error => ['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EBUSY', 'EIO', 'ENOSPC', 'EROFS', 'ETIMEDOUT',
  'ENAMETOOLONG', 'EMFILE', 'ENFILE'].includes(error?.details?.nativeCode ?? error?.code);
const combine = errors => errors.length === 1 ? errors[0] : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Subtitle conversion failed.', { cause: errors[0] }),
  Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
const abort = signal => { if (signal?.aborted) throw Object.assign(new StorageError('cancelled', 'Subtitle conversion was cancelled.'), { cause: signal.reason }); };
const failed = message => Object.assign(new Error(message), { status: 500 });

export function subtitleSourceFingerprint(info) {
  if (!info || info.kind !== 'file') return null;
  if (info.size == null || typeof info.modified !== 'string') throw new StorageError('not-supported', 'Subtitle cache validation requires source size and modification time.');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/u.exec(info.modified);
  if (!match) throw new StorageError('invalid-response', 'The subtitle modification time is invalid.');
  const milliseconds = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(milliseconds)) throw new StorageError('invalid-response', 'The subtitle modification time is invalid.');
  const ticks = BigInt(milliseconds) * 10000n + BigInt((match[2] ?? '').padEnd(7, '0').slice(0, 7)) + 621355968000000000n;
  return String(info.size) + ':' + ticks;
}

/** Persist the SRT and source revision consumed by the Native subtitle reader. */
export class SubtitleCache {
  #tails = new Map();
  #pending = new Set();
  #closed = false;
  #closing;

  constructor({ fileSystem, dataPath, onError = () => {} }) {
    if (!fileSystem?.resolve || !fileSystem?.readFile || !fileSystem?.writeFile || !fileSystem?.stat || !fileSystem?.mkdir || !fileSystem?.unlink) {
      throw new TypeError('Subtitle caching requires its metadata storage filesystem.');
    }
    if (dataPath !== undefined && (typeof dataPath !== 'string' || !path.isAbsolute(dataPath))) throw new TypeError('Subtitle caching requires an absolute instance data path.');
    Object.assign(this, { fileSystem, dataPath, onError });
  }

  get available() { return this.dataPath !== undefined; }

  paths(sourceId, index) {
    if (!this.available) throw new StorageError('not-supported', 'Subtitle conversion requires the instance data path.');
    let id;
    try { id = nativeGuid(sourceId).toLowerCase(); }
    catch { throw Object.assign(new Error('The media source has no subtitle cache.'), { status: 404 }); }
    if (!Number.isInteger(index) || index < -2147483648 || index > 2147483647) throw new TypeError('The subtitle index must be an Int32.');
    const filename = path.join(this.dataPath, 'subtitles', id.slice(0, 2), id, String(index) + '.srt');
    return { filename, metadata: filename + '.meta', directory: path.dirname(filename) };
  }

  async #stat(filename) {
    try { return await this.fileSystem.stat(filename, { bigint: true }); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  async #source(statSource) {
    try {
      const info = await statSource();
      return info?.kind === 'file' ? info : null;
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async #remove(filename) {
    try { await this.fileSystem.unlink(filename); }
    catch (error) {
      if (missing(error)) return;
      if (ioError(error)) { this.onError(error); return; }
      throw error;
    }
  }

  async #load(paths, statSource) {
    const cached = await this.#stat(paths.filename);
    if (!cached?.isFile() || cached.size === 0n) return null;
    const source = await this.#source(statSource);
    let fresh = !source;
    if (source) {
      const metadata = await this.#stat(paths.metadata);
      if (!metadata?.isFile()) return null;
      try { fresh = decodeNativeTextEncoding(await this.fileSystem.readFile(paths.metadata)) === subtitleSourceFingerprint(source); }
      catch (error) { if (ioError(error)) { this.onError(error); return null; } throw error; }
    }
    if (!fresh) return null;
    try { return await this.fileSystem.readFile(paths.filename); }
    catch (error) { if (missing(error)) error.status ??= 404; throw error; }
  }

  getOrCreate(source, stream, { statSource, produce, signal }) {
    abort(signal);
    if (this.#closed) return Promise.reject(new StorageError('closed', 'Subtitle caching is closed.'));
    const paths = this.paths(source.Id, stream.Index);
    const previous = this.#tails.get(paths.filename) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      abort(signal);
      const cached = await this.#load(paths, statSource);
      if (cached !== null) return { bytes: cached, format: 'srt', consistency: 'persistent' };
      for (const filename of [paths.filename, paths.metadata]) {
        const target = this.fileSystem.resolve(filename);
        requireCapability(target, 'create'); requireCapability(target, 'replace');
      }
      await this.fileSystem.mkdir(paths.directory, { recursive: true });
      const current = await this.#stat(paths.filename);
      const initial = current?.isFile() ? await this.fileSystem.readFile(paths.filename) : null;
      const result = await produce(initial);
      const errors = [];
      if (result.exists && result.error?.code !== 'subtitle-start-failure') {
        try { await this.fileSystem.writeFile(paths.filename, result.bytes); }
        catch (error) { errors.push(error); }
      }
      if (result.failed) {
        errors.unshift(result.error);
        if (result.remove) try { await this.#remove(paths.filename); } catch (error) { errors.push(error); }
        throw combine(errors);
      }
      if (errors.length) throw combine(errors);
      if (!result.exists || result.bytes.length === 0) {
        const primary = Object.assign(failed('ffmpeg subtitle conversion did not produce a readable subtitle.'), {
          code: 'subtitle-conversion-failure', exitCode: result.execution?.exitCode, diagnostics: result.execution?.diagnostics,
        });
        try { await this.#remove(paths.filename); } catch (error) { throw combine([primary, error]); }
        throw primary;
      }
      try {
        const latest = await this.#source(statSource);
        if (latest) await this.fileSystem.writeFile(paths.metadata, subtitleSourceFingerprint(latest));
      } catch (error) { if (ioError(error)) this.onError(error); else throw error; }
      return { bytes: result.bytes, format: 'srt', consistency: 'persistent' };
    });
    this.#tails.set(paths.filename, operation); this.#pending.add(operation);
    void operation.finally(() => {
      this.#pending.delete(operation);
      if (this.#tails.get(paths.filename) === operation) this.#tails.delete(paths.filename);
    }).catch(() => {});
    return operation;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = Promise.allSettled([...this.#pending]).then(() => {});
  }
}
