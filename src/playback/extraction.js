import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { StorageError } from '../storage/errors.js';
import { createNativeCharsetStreamDetector } from '../core/native-charset.js';
import { isExternalSubtitleFallback, subtitleExtensionHint } from './subtitle-source.js';

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const checkAbort = signal => { if (signal?.aborted) throw failure('cancelled', 'Media extraction was cancelled.', signal.reason); };
const combinedFailure = (errors, message) => Object.assign(new AggregateError(errors, message, { cause: errors[0] }),
  Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
function subtitleTimeoutMilliseconds(options) {
  const milliseconds = options.SubtitleExtractionTimeoutMinutes * 60000;
  if (!Number.isFinite(milliseconds) || milliseconds < -1 || milliseconds > 4294967294) {
    throw Object.assign(new RangeError('The subtitle extraction delay exceeds the supported timeout range.'), { code: 'invalid-subtitle-timeout' });
  }
  return milliseconds;
}
function deadline(milliseconds, expired) {
  if (milliseconds === -1) return () => {};
  const end = performance.now() + milliseconds;
  let timer;
  const arm = () => {
    const remaining = Math.max(0, end - performance.now());
    timer = setTimeout(remaining > 2147483647 ? arm : expired, Math.min(remaining, 2147483647)); timer.unref();
  };
  arm(); return () => clearTimeout(timer);
}
const copyMuxers = { ass: 'ass', ssa: 'ass', srt: 'srt', subrip: 'srt', pgssub: 'sup' };
const vobSub = codec => /dvdsub|vobsub/i.test(codec ?? '');
export function subtitleExtractionFormat(stream) {
  const codec = stream.Codec?.toLowerCase();
  const muxer = copyMuxers[codec];
  if (muxer) return [['srt', 'subrip'].includes(codec) ? 'srt' : stream.Codec, muxer];
  return vobSub(stream.Codec) ? ['mks', 'matroska'] : undefined;
}

export function subtitleInputIndex(source, stream) {
  let index = 0;
  for (const current of source.MediaStreams) {
    if (current === stream) return index;
    if ((current.Path ?? null) === (stream.Path ?? null)) index++;
  }
  throw failure('not-found', 'The subtitle does not belong to this media source.');
}

function privateInput(url) {
  const value = new URL(url);
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}(?:\.(?:smi|sami|srt|subrip|ass|ssa|vtt|webvtt))?$/.test(value.pathname)
    || value.username || value.password || value.search || value.hash) throw new TypeError('Extraction requires a private VFS bridge lease.');
  return value.href;
}
function streamIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('A nonnegative stream index is required.');
  return value;
}

export function buildExtractionArguments(url, { kind, index, muxer, encoding, directory, output }) {
  url = privateInput(url);
  index = streamIndex(index);
  const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
  if (kind === 'attachment') {
    // No output stream is selected. Dumping extradata does not decode media.
    return [...common, `-dump_attachment:${index}`, 'pipe:1', '-i', url];
  }
  if (kind === 'text-subtitle') {
    if (muxer !== 'srt' || typeof directory !== 'string' || path.dirname(directory) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('mediamanager-subtitle-') || output !== path.join(directory, 'converted.srt')) {
      throw new TypeError('External text conversion requires its private SRT output.');
    }
    if (typeof encoding !== 'string' || !/^[A-Za-z0-9._-]*$/u.test(encoding)) throw new TypeError('The subtitle input encoding is invalid.');
    return [...common, '-y', ...(encoding ? ['-sub_charenc', encoding] : []), '-i', url, '-map', `0:s:${index}`,
      '-an', '-vn', '-dn', '-c:s', 'srt', '-f', 'srt', output];
  }
  if (kind !== 'subtitle' || !['ass', 'srt', 'sup', 'matroska'].includes(muxer)) throw new TypeError('Only audited subtitle copy muxers are allowed.');
  return [...common, '-i', url, '-map', `0:${index}`, '-an', '-vn', '-dn', '-c:s', 'copy', '-flush_packets', '1', '-f', muxer, 'pipe:1'];
}

function waitFor(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('cancelled', 'Media extraction was cancelled.', signal.reason));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

export class ExtractionService {
  #jobs = new Map();
  #cache = new Map();
  #cacheSize = 0;
  #adapters = new WeakMap();
  #adapterSequence = 0;
  #closed = false;
  #closing;
  #closeFailures = [];
  #processes = new Set();

  constructor({ vfs, bridge, mediaEncoder, subtitleCache, getEncodingOptions, timeoutMs = 300000, maxOutputBytes = 32 * 1024 * 1024, maxCacheBytes = 64 * 1024 * 1024, maxConcurrentExtractions = 4, onProcess = () => {} }) {
    if (!vfs) throw new TypeError('Extraction requires VFS.');
    if (!mediaEncoder) throw new TypeError('Extraction requires its startup media encoder.');
    if (!subtitleCache?.getOrCreate || !subtitleCache?.close) throw new TypeError('Extraction requires its metadata subtitle cache.');
    if (typeof getEncodingOptions !== 'function') throw new TypeError('Extraction requires current encoding configuration.');
    for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes, maxCacheBytes, maxConcurrentExtractions })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
    }
    Object.assign(this, { vfs, bridge: bridge ?? new ProbeReadBridge(vfs), ownsBridge: !bridge, mediaEncoder, subtitleCache, getEncodingOptions, timeoutMs, maxOutputBytes, maxCacheBytes, maxConcurrentExtractions, onProcess });
  }
  get available() { return this.mediaEncoder.ready; }

  supportsSubtitle(source, stream, outputFormat) {
    const format = isExternalSubtitleFallback(stream) ? 'srt' : subtitleExtractionFormat(stream)?.[0]?.toLowerCase();
    const delivered = outputFormat?.toLowerCase();
    const outputs = format === 'srt' ? ['srt', 'subrip', 'vtt', 'webvtt', 'json']
      : format === 'ass' ? ['ass', 'vtt', 'webvtt']
        : format === 'ssa' ? ['ssa', 'ass', 'vtt', 'webvtt'] : [format];
    return this.available && (!isExternalSubtitleFallback(stream) || this.subtitleCache.available) && Boolean(format) && (!delivered || outputs.includes(delivered)) && !source.IsInfiniteStream
      && (!source.VideoType || ['VideoFile', 'Iso'].includes(source.VideoType)) && stream.SupportsExternalStream !== false;
  }

  async subtitle(source, stream, virtualPath, { signal } = {}) {
    if (!this.available) throw failure('unavailable', 'The ffmpeg extraction process is unavailable.');
    if (!this.supportsSubtitle(source, stream)) throw failure('not-supported', 'This subtitle requires an unsupported extraction or conversion branch.');
    if (isExternalSubtitleFallback(stream)) return this.#requestJob(randomUUID(), (ownerSignal, reportCleanupFailure) => this.subtitleCache.getOrCreate(source, stream, {
      signal: ownerSignal, statSource: /^https?:\/\//iu.test(stream.Path) ? () => null : () => this.vfs.stat(virtualPath),
      produce: initial => this.#convertExternalText(source, stream, virtualPath, initial, ownerSignal, reportCleanupFailure),
    }), signal);
    const [format, muxer] = subtitleExtractionFormat(stream);
    return this.#extract(source, stream, virtualPath, { kind: 'subtitle', format, muxer, index: subtitleInputIndex(source, stream), signal });
  }

  async attachment(source, attachment, virtualPath, { signal } = {}) {
    if (attachment.Codec?.toLowerCase() === 'mjpeg') throw failure('not-found', `Attachment with stream index ${attachment.Index} can't be extracted for MediaSource ${source.Id}`);
    if (!this.available) throw failure('unavailable', 'The ffmpeg extraction process is unavailable.');
    if (source.IsInfiniteStream || source.VideoType && !['VideoFile', 'Iso'].includes(source.VideoType)) throw failure('not-supported', 'Attachment extraction requires a finite media file.');
    return this.#extract(source, attachment, virtualPath, { kind: 'attachment', index: attachment.Index, signal });
  }

  async #extract(source, stream, virtualPath, { signal, ...operation }) {
    checkAbort(signal);
    if (this.#closed) throw failure('closed', 'Media extraction is closed.');
    const resolved = this.vfs.resolve(virtualPath);
    const before = await this.vfs.stat(virtualPath, { signal });
    if (before.kind !== 'file') throw failure('is-directory', 'Extraction requires a media file.');
    const reliable = resolved.capabilities.reliableVersion === true && before.version != null;
    if (!this.#adapters.has(resolved.adapter)) this.#adapters.set(resolved.adapter, ++this.#adapterSequence);
    const key = reliable ? createHash('sha256').update(JSON.stringify([this.#adapters.get(resolved.adapter), resolved.path, virtualPath, before.version,
      source.Id, source.Path, stream.Index, stream.Codec, operation])).digest('hex') : randomUUID();
    const cached = this.#cache.get(key);
    if (cached) { this.#cache.delete(key); this.#cache.set(key, cached); return { ...cached, bytes: Buffer.from(cached.bytes) }; }
    return this.#requestJob(key, async (ownerSignal, reportCleanupFailure) => {
      const result = await this.#perform(virtualPath, resolved, before, operation, ownerSignal, reportCleanupFailure);
      if (reliable && !ownerSignal.aborted && !this.#closed && result.bytes.length <= this.maxCacheBytes) {
        while (this.#cacheSize + result.bytes.length > this.maxCacheBytes && this.#cache.size) {
          const oldest = this.#cache.keys().next().value;
          this.#cacheSize -= this.#cache.get(oldest).bytes.length; this.#cache.delete(oldest);
        }
        this.#cache.set(key, result); this.#cacheSize += result.bytes.length;
      }
      return result;
    }, signal);
  }

  async #requestJob(key, perform, signal) {
    checkAbort(signal);
    if (this.#closed) throw failure('closed', 'Media extraction is closed.');
    let job = this.#jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      job = { controller, clients: 0, settled: false };
      job.promise = perform(controller.signal, error => {
        if (this.#closed || job.clients === 0) this.#closeFailures.push(error);
      }).finally(() => { job.settled = true; if (this.#jobs.get(key) === job) this.#jobs.delete(key); });
      this.#jobs.set(key, job);
    }
    job.clients++;
    try {
      const result = await waitFor(job.promise, signal);
      return { ...result, bytes: Buffer.from(result.bytes) };
    } finally {
      job.clients--;
      if (!job.clients && !job.settled) job.controller.abort(signal?.reason);
    }
  }

  async #convertExternalText(source, stream, virtualPath, initial, signal, reportCleanupFailure) {
    let handle;
    const detector = createNativeCharsetStreamDetector();
    let encoding, detectionError, detectionFailed = false;
    try {
      handle = await this.vfs.openRead(virtualPath, { signal });
      for await (const chunk of handle.stream) { checkAbort(signal); detector.append(chunk); if (detector.done) break; }
      encoding = detector.finish().details?.[0]?.name ?? '';
    } catch (error) { detectionError = error; detectionFailed = true; }
    try { await handle?.close(); } catch (error) {
      const ordered = detectionFailed ? combinedFailure([detectionError, error], detectionError?.message ?? 'Subtitle charset detection failed.') : error;
      reportCleanupFailure(ordered); throw ordered;
    }
    if (detectionFailed) throw detectionError;
    if (stream.Path.endsWith('.sami') && /^utf-16(?:le|be)$/iu.test(encoding)) encoding = '';
    const temporaryRoot = path.resolve(tmpdir()), directory = await mkdtemp(path.join(temporaryRoot, 'mediamanager-subtitle-'));
    const output = path.join(directory, 'converted.srt');
    const errors = [];
    let lease, execution, bytes = Buffer.alloc(0), exists = false, remove = false, cleanupFailed = false;
    try {
      if (initial !== null) await writeFile(output, initial, { flag: 'wx' });
      lease = await this.bridge.lease(virtualPath, { signal, expiresInMs: null, extensionHint: subtitleExtensionHint(stream) });
      try {
        execution = await this.#run(buildExtractionArguments(lease.url, { kind: 'text-subtitle', muxer: 'srt', index: subtitleInputIndex(source, stream), encoding,
          directory, output }), { signal, redacted: lease.url, subtitle: true });
      } catch (error) { errors.push(error); remove = ['cancelled', 'subtitle-timeout'].includes(error?.code); }
      try { bytes = await readFile(output); exists = true; }
      catch (error) { if (error?.code !== 'ENOENT') errors.push(error); }
    } catch (error) { errors.push(error); }
    finally {
      try { await lease?.release(); } catch (error) { errors.push(error); cleanupFailed = true; }
      try {
        if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith('mediamanager-subtitle-')) throw new Error('The subtitle temporary directory is not owned.');
        await rm(directory, { recursive: true });
      } catch (error) { errors.push(error); cleanupFailed = true; }
    }
    const failed = errors.length > 0, error = errors.length === 1 ? errors[0] : failed ? combinedFailure(errors, errors[0]?.message ?? 'Subtitle conversion failed.') : undefined;
    if (cleanupFailed) reportCleanupFailure(error);
    return { bytes, exists, remove, failed, execution, ...(failed ? { error } : {}) };
  }

  async #perform(virtualPath, resolved, before, operation, signal, reportCleanupFailure) {
    const lease = await this.bridge.lease(virtualPath, { signal, version: before.version,
      expiresInMs: operation.kind === 'subtitle' ? null : this.timeoutMs + 1000 });
    let extracted;
    const errors = [];
    try {
      const result = await this.#run(buildExtractionArguments(lease.url, operation), { signal, redacted: lease.url, subtitle: operation.kind === 'subtitle' });
      checkAbort(signal);
      const attachmentDumpComplete = operation.kind === 'attachment' && result.exitCode === 1 && /(?:At least one output file must be specified|No output files specified)/i.test(result.diagnostics);
      if (result.exitCode !== 0 && !attachmentDumpComplete || result.bytes.length === 0) throw failure('invalid-response', 'ffmpeg could not extract the selected stream.');
      const after = await this.vfs.stat(virtualPath, { signal });
      const current = this.vfs.resolve(virtualPath);
      if (current.adapter !== resolved.adapter || current.path !== resolved.path || before.version != null && after.version !== before.version) throw failure('version-changed', 'Media changed during extraction.');
      let bytes = result.bytes;
      if (operation.format?.toLowerCase() === 'ass') {
        const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
        const replaced = text.replaceAll(',Arial,', ',Arial Unicode MS,');
        // The native StreamWriter emits its UTF-8 preamble only when rewriting the font.
        if (replaced !== text) bytes = Buffer.from('\uFEFF' + replaced);
      }
      extracted = { bytes, format: operation.format, consistency: resolved.capabilities.reliableVersion === true && before.version != null ? 'versioned' : 'unversioned' };
    } catch (error) { errors.push(error); }
    try { await lease.release(); } catch (error) {
      errors.push(error); reportCleanupFailure(errors.length === 1 ? error : combinedFailure(errors, errors[0]?.message ?? 'Media extraction failed.'));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw combinedFailure(errors, errors[0]?.message ?? 'Media extraction failed.');
    return extracted;
  }

  async #run(args, { signal, redacted, subtitle = false, timeoutMs = this.timeoutMs, maxOutputBytes = this.maxOutputBytes } = {}) {
    checkAbort(signal);
    while (this.#processes.size >= this.maxConcurrentExtractions) await waitFor(Promise.race([...this.#processes]), signal);
    checkAbort(signal);
    let child;
    try { child = spawn(this.mediaEncoder.encoderPath, args, { shell: false, windowsHide: true, env: this.mediaEncoder.environment, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { throw failure(subtitle ? 'subtitle-start-failure' : 'unavailable', 'The ffmpeg extraction process could not start.', error); }
    let failureReason, killTimer, cancelDeadline, outputSize = 0, diagnosticSize = 0;
    const processFailures = [], started = Promise.withResolvers();
    const stdout = [], stderr = [];
    const terminate = error => {
      failureReason ??= error;
      try { child.kill(); } catch (failure) { processFailures.push(failure); }
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) try { child.kill('SIGKILL'); } catch (failure) { processFailures.push(failure); }
      }, 1000);
      killTimer.unref();
    };
    const abort = () => terminate(failure('cancelled', 'Media extraction was cancelled.', signal.reason));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > maxOutputBytes) terminate(failure('invalid-response', 'Extraction output exceeded the configured limit.'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => { diagnosticSize += chunk.length; if (diagnosticSize <= 1024 * 1024) stderr.push(chunk); });
    const completion = new Promise(resolve => {
      child.once('spawn', () => started.resolve());
      child.once('error', error => {
        const unavailable = Object.assign(failure(subtitle ? 'subtitle-start-failure' : 'unavailable', 'The ffmpeg extraction process could not start.'), { cause: error });
        failureReason ??= unavailable; started.reject(unavailable);
      });
      child.once('close', resolve);
    });
    this.#processes.add(completion);
    try {
      try {
        await started.promise;
        try { this.onProcess({ pid: child.pid, args: args.map(value => value === redacted ? '[private source]' : value) }); }
        catch (cause) { throw Object.assign(failure('invalid-response', 'Extraction process observer failed.'), { cause }); }
        const milliseconds = subtitle ? subtitleTimeoutMilliseconds(this.getEncodingOptions()) : timeoutMs;
        cancelDeadline = deadline(milliseconds, () => terminate(failure(subtitle ? 'subtitle-timeout' : 'timeout', 'Media extraction timed out.')));
        if (signal?.aborted) abort();
      } catch (error) { terminate(error); }
      await completion;
      if (processFailures.length) throw combinedFailure(failureReason ? [failureReason, ...processFailures] : processFailures,
        failureReason?.message ?? 'Extraction process cleanup failed.');
      if (failureReason) throw failureReason;
      return { bytes: Buffer.concat(stdout), diagnostics: Buffer.concat(stderr).toString('utf8').replaceAll(redacted ?? '\0', '[private source]'), exitCode: child.exitCode };
    } finally { this.#processes.delete(completion); cancelDeadline?.(); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); }
  }

  close() {
    if (this.#closing) return this.#closing;
    const completed = Promise.withResolvers(); this.#closing = completed.promise;
    void (async () => {
      this.#closed = true;
      for (const job of this.#jobs.values()) job.controller.abort();
      await Promise.allSettled([...this.#jobs.values()].map(job => job.promise));
      await Promise.allSettled([...this.#processes]);
      this.#cache.clear();
      this.#cacheSize = 0;
      const errors = [...this.#closeFailures];
      try { await this.subtitleCache.close(); } catch (error) { errors.push(error); }
      try { if (this.ownsBridge) await this.bridge.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw combinedFailure(errors, 'Media extraction cleanup failed.');
    })().then(completed.resolve, completed.reject);
    return this.#closing;
  }
}
