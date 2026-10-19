import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { StorageError, checkAbort } from '../storage/errors.js';

const failure = (code, message) => new StorageError(code, message);
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
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{64}$/.test(value.pathname)
    || value.username || value.password || value.search || value.hash) throw new TypeError('Extraction requires a private VFS bridge lease.');
  return value.href;
}
function streamIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('A nonnegative stream index is required.');
  return value;
}

export function buildExtractionArguments(url, { kind, index, muxer }) {
  url = privateInput(url);
  index = streamIndex(index);
  const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
  if (kind === 'attachment') {
    // No output stream is selected. Dumping extradata does not decode media.
    return [...common, `-dump_attachment:${index}`, 'pipe:1', '-i', url];
  }
  if (kind !== 'subtitle' || !['ass', 'srt', 'sup', 'matroska'].includes(muxer)) throw new TypeError('Only audited subtitle copy muxers are allowed.');
  return [...common, '-i', url, '-map', `0:${index}`, '-an', '-vn', '-dn', '-c:s', 'copy', '-flush_packets', '1', '-f', muxer, 'pipe:1'];
}

function waitFor(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('cancelled', 'Media extraction was cancelled.'));
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
  #ready;
  #processes = new Set();

  constructor({ vfs, bridge, executable = 'ffmpeg', timeoutMs = 300000, maxOutputBytes = 32 * 1024 * 1024, maxCacheBytes = 64 * 1024 * 1024, maxConcurrentExtractions = 4, onProcess = () => {} }) {
    if (!vfs) throw new TypeError('Extraction requires VFS.');
    for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes, maxCacheBytes, maxConcurrentExtractions })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
    }
    Object.assign(this, { vfs, bridge: bridge ?? new ProbeReadBridge(vfs), ownsBridge: !bridge, executable, timeoutMs, maxOutputBytes, maxCacheBytes, maxConcurrentExtractions, onProcess });
    this.available = false;
  }

  async initialize() {
    if (this.#closed) throw failure('closed', 'Media extraction is closed.');
    this.#ready ??= this.#run(['-version'], { timeoutMs: Math.min(this.timeoutMs, 5000), maxOutputBytes: 1024 * 1024 }).then(result => {
      this.available = result.exitCode === 0 && /^ffmpeg version /m.test(result.bytes.toString());
      return this.available;
    }).catch(() => false);
    return this.#ready;
  }

  supportsSubtitle(source, stream, outputFormat) {
    const format = subtitleExtractionFormat(stream)?.[0]?.toLowerCase();
    const delivered = outputFormat?.toLowerCase();
    const outputs = format === 'srt' ? ['srt', 'subrip', 'vtt', 'webvtt', 'json']
      : format === 'ass' ? ['ass', 'vtt', 'webvtt']
        : format === 'ssa' ? ['ssa', 'ass', 'vtt', 'webvtt'] : [format];
    return this.available && Boolean(format) && (!delivered || outputs.includes(delivered)) && !source.IsInfiniteStream
      && (!source.VideoType || ['VideoFile', 'Iso'].includes(source.VideoType)) && stream.SupportsExternalStream !== false;
  }

  async subtitle(source, stream, virtualPath, { signal } = {}) {
    if (!await this.initialize()) throw failure('unavailable', 'The ffmpeg extraction process is unavailable.');
    if (!this.supportsSubtitle(source, stream)) throw failure('not-supported', 'This subtitle requires an unsupported extraction or conversion branch.');
    const [format, muxer] = subtitleExtractionFormat(stream);
    return this.#extract(source, stream, virtualPath, { kind: 'subtitle', format, muxer, index: subtitleInputIndex(source, stream), signal });
  }

  async attachment(source, attachment, virtualPath, { signal } = {}) {
    if (attachment.Codec?.toLowerCase() === 'mjpeg') throw failure('not-found', `Attachment with stream index ${attachment.Index} can't be extracted for MediaSource ${source.Id}`);
    if (!await this.initialize()) throw failure('unavailable', 'The ffmpeg extraction process is unavailable.');
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
    let job = this.#jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      job = { controller, clients: 0, settled: false };
      job.promise = this.#perform(virtualPath, resolved, before, operation, controller.signal).then(result => {
        if (reliable && !controller.signal.aborted && !this.#closed && result.bytes.length <= this.maxCacheBytes) {
          while (this.#cacheSize + result.bytes.length > this.maxCacheBytes && this.#cache.size) {
            const oldest = this.#cache.keys().next().value;
            this.#cacheSize -= this.#cache.get(oldest).bytes.length;
            this.#cache.delete(oldest);
          }
          this.#cache.set(key, result);
          this.#cacheSize += result.bytes.length;
        }
        return result;
      }).finally(() => { job.settled = true; if (this.#jobs.get(key) === job) this.#jobs.delete(key); });
      this.#jobs.set(key, job);
    }
    job.clients++;
    try {
      const result = await waitFor(job.promise, signal);
      return { ...result, bytes: Buffer.from(result.bytes) };
    } finally {
      job.clients--;
      if (!job.clients && !job.settled) job.controller.abort();
    }
  }

  async #perform(virtualPath, resolved, before, operation, signal) {
    const lease = await this.bridge.lease(virtualPath, { signal, version: before.version, expiresInMs: this.timeoutMs + 1000 });
    try {
      const result = await this.#run(buildExtractionArguments(lease.url, operation), { signal, redacted: lease.url });
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
      return { bytes, format: operation.format, consistency: resolved.capabilities.reliableVersion === true && before.version != null ? 'versioned' : 'unversioned' };
    } finally { await lease.release(); }
  }

  async #run(args, { signal, redacted, timeoutMs = this.timeoutMs, maxOutputBytes = this.maxOutputBytes } = {}) {
    checkAbort(signal);
    while (this.#processes.size >= this.maxConcurrentExtractions) await waitFor(Promise.race([...this.#processes]), signal);
    checkAbort(signal);
    const child = spawn(this.executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let failureReason, killTimer, timer, outputSize = 0, diagnosticSize = 0;
    const stdout = [], stderr = [];
    const terminate = error => {
      failureReason ??= error;
      child.kill();
      killTimer ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
      killTimer.unref();
    };
    const abort = () => terminate(failure('cancelled', 'Media extraction was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => terminate(failure('timeout', 'Media extraction timed out.')), timeoutMs);
    timer.unref();
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > maxOutputBytes) terminate(failure('invalid-response', 'Extraction output exceeded the configured limit.'));
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => { diagnosticSize += chunk.length; if (diagnosticSize <= 1024 * 1024) stderr.push(chunk); });
    const completion = new Promise(resolve => {
      child.once('error', () => { failureReason ??= failure('unavailable', 'The ffmpeg extraction process could not start.'); });
      child.once('close', resolve);
    });
    this.#processes.add(completion);
    try {
      try { this.onProcess({ args: args.map(value => value === redacted ? '[private source]' : value) }); }
      catch { terminate(failure('invalid-response', 'Extraction process observer failed.')); }
      await completion;
      if (failureReason) throw failureReason;
      return { bytes: Buffer.concat(stdout), diagnostics: Buffer.concat(stderr).toString('utf8').replaceAll(redacted ?? '\0', '[private source]'), exitCode: child.exitCode };
    } finally { this.#processes.delete(completion); clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map(job => job.promise));
    await Promise.allSettled([...this.#processes]);
    this.#cache.clear();
    this.#cacheSize = 0;
    if (this.ownsBridge) await this.bridge.close();
  }
}
