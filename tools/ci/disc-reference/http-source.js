import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const defaults = Object.freeze({ rangeBytes: 32 * 1024 * 1024, concurrency: 4,
  rangeTimeoutMs: 5 * 60_000, maxAttempts: 3, retryDelayMs: 250 });
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRedirects = 8;

class ArchiveSourceError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

function requireValue(condition, code, message) {
  if (!condition) throw new ArchiveSourceError(code, message);
}

function archiveUrl(value) {
  const url = new URL(value);
  requireValue(url.protocol === 'https:' && !url.username && !url.password
    && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')),
  'ARCHIVE_ORIGIN', 'Original ISO requests must remain on HTTPS Internet Archive origins.');
  return url;
}

const strongETag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/u.test(value) ? value : null;
/** JSON-safe observations never replace or rewrite the actual thrown value. */
export function archiveFailureObservation(value) {
  const ancestors = new Map();
  const visit = (value, location) => {
    if (value === null) return { kind: 'null', value: null };
    const kind = typeof value;
    if (kind === 'undefined') return { kind, value: 'undefined' };
    if (kind === 'number') return { kind, value: Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0'
      : value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : value };
    if (['string', 'boolean'].includes(kind)) return { kind, value };
    if (kind === 'bigint') return { kind, value: value.toString() };
    if (kind === 'symbol') return { kind, value: String(value) };
    if (ancestors.has(value)) return { kind: 'circular-reference', reference: ancestors.get(value) };
    ancestors.set(value, location);
    const read = key => {
      try { return { available: true, value: value[key] }; }
      catch (error) { return { available: false, observation: { kind: 'unreadable-property', error: visit(error, location + '.' + key + '.error') } }; }
    };
    try {
      if (value instanceof Error) {
        const result = { kind: 'error' };
        for (const key of ['name', 'message', 'stack', 'code']) {
          const entry = read(key);
          if (!entry.available) result[key] = entry.observation;
          else if (entry.value !== undefined || key !== 'code') {
            result[key] = typeof entry.value === 'string' ? entry.value : visit(entry.value, location + '.' + key);
          }
        }
        if (Object.hasOwn(value, 'cause')) {
          const cause = read('cause'); result.cause = cause.available ? visit(cause.value, location + '.cause') : cause.observation;
        }
        if (value instanceof AggregateError) {
          const errors = read('errors');
          result.errors = errors.available ? Array.from(errors.value, (entry, index) => visit(entry, `${location}.errors[${index}]`)) : errors.observation;
        }
        return result;
      }
      if (Array.isArray(value)) return { kind: 'array', values: Array.from(value, (entry, index) => visit(entry, `${location}[${index}]`)) };
      const properties = Object.create(null);
      for (const key of Object.keys(value)) {
        const entry = read(key); properties[key] = entry.available ? visit(entry.value, location + '.' + key) : entry.observation;
      }
      return { kind, properties };
    } catch (error) {
      return { kind, inspectionFailure: error === value ? { kind: 'circular-reference', reference: location }
        : visit(error, location + '.inspectionFailure') };
    } finally { ancestors.delete(value); }
  };
  return visit(value, '$');
}
const errorObservation = archiveFailureObservation;

/** Leaf dependencies permit bounded transport/IO fault tests without network access. */
export function createArchiveIsoDownloader({ fetch: request = globalThis.fetch, openFile = open,
  rangeBytes = defaults.rangeBytes, concurrency = defaults.concurrency,
  rangeTimeoutMs = defaults.rangeTimeoutMs, maxAttempts = defaults.maxAttempts,
  retryDelayMs = defaults.retryDelayMs } = {}) {
  for (const [name, value, maximum, minimum] of [
    ['rangeBytes', rangeBytes, defaults.rangeBytes, 1], ['concurrency', concurrency, defaults.concurrency, 1],
    ['rangeTimeoutMs', rangeTimeoutMs, defaults.rangeTimeoutMs, 1], ['maxAttempts', maxAttempts, defaults.maxAttempts, 1],
    ['retryDelayMs', retryDelayMs, defaults.retryDelayMs, 0],
  ]) requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'ARCHIVE_OPTIONS', `${name} is outside the bounded original ISO transport limits.`);
  requireValue(typeof request === 'function' && typeof openFile === 'function', 'ARCHIVE_OPTIONS', 'Supply actual transport and file functions.');

  return async function download(source, filename, { signal, onResponse, onProgress } = {}) {
    requireValue(source && Number.isSafeInteger(source.bytes) && source.bytes > 0
      && /^[a-f0-9]{40}$/u.test(source.sha1) && /^[a-f0-9]{32}$/u.test(source.md5)
      && (source.sha256 == null || /^[a-f0-9]{64}$/u.test(source.sha256)),
    'ARCHIVE_SOURCE', 'The original ISO needs its fixed size and published digests.');
    const originalUrl = archiveUrl(source.url);
    const expected = { bytes: source.bytes, sha1: source.sha1, md5: source.md5,
      ...(source.sha256 == null ? {} : { sha256: source.sha256 }) };
    requireValue(typeof filename === 'string' && filename.length > 0, 'ARCHIVE_TARGET', 'Supply a new original ISO filename.');
    requireValue((onResponse === undefined || typeof onResponse === 'function')
      && (onProgress === undefined || typeof onProgress === 'function'), 'ARCHIVE_OPTIONS', 'Transport observers must be functions.');
    const controller = new AbortController(), rangeCount = Math.ceil(expected.bytes / rangeBytes);
    let failed = false, failure, file, syncAttempted = false, observerTail = Promise.resolve(), workers = [];
    let coveredBytes = 0, lastProgress = 0, digests;
    const cleanup = [];
    const transport = { kind: 'bounded-parallel-original-iso-ranges', rangeBytes, concurrency, rangeCount,
      rangeTimeoutMs, maxAttempts, maximumRedirects, phase: 'opening', complete: false,
      wireBytes: 0, probeBytes: 0, payloadBytes: 0, retryBytes: 0, retries: 0,
      byteCountScope: 'Observed identity response-body bytes; headers and unread canceled bodies are excluded. File bytes count nonoverlapping completed writes, not file extent.',
      retryByteScope: 'Bytes observed on attempts after the first; every failed earlier attempt remains separately recorded.',
      activeRequests: 0, maximumActiveRequests: 0, requestsDrained: false, workersDrained: false,
      fileCreated: false, fileSynced: false, fileClosed: false, coveredBytes: 0, completedRanges: 0,
      hashedBytes: 0, strongETag: null, probeETag: null, attempts: [], ranges: [], cleanup: [] };
    const fail = error => {
      if (!failed) { failed = true; failure = error; controller.abort(error); }
    };
    const aborted = () => fail(signal.reason);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();

    const cleanupOperation = async (stage, operation, beforeFailure) => {
      const entry = { stage, failed: false, primary: false }; cleanup.push(entry);
      try { await operation(); }
      catch (error) {
        entry.failed = true; entry.error = error;
        beforeFailure?.();
        if (!failed) { entry.primary = true; fail(error); }
      }
      return entry;
    };
    const publish = async (observer, value, stage) => {
      if (!observer) return;
      const pending = observerTail.then(() => observer(value)).catch(error => {
        const entry = { stage, failed: true, error, primary: !failed }; cleanup.push(entry);
        fail(error);
        throw error;
      });
      // Continue the serialization chain after a failed observer so the final
      // incomplete diagnostic is still attempted. Its caller keeps the raw error.
      observerTail = pending.then(() => {}, () => {});
      return pending;
    };
    const progress = (stage = 'progress-observer') => publish(onProgress, { bytes: coveredBytes, complete: false,
      ...(digests ?? {}), transport: structuredClone(transport) }, stage);
    const occasionalProgress = async () => {
      if (Date.now() - lastProgress >= 30_000) { lastProgress = Date.now(); await progress(); }
    };

    const readAttempt = async (range, attempt, purpose) => {
      const timeout = new AbortController();
      const timeoutError = new ArchiveSourceError('ARCHIVE_RANGE_TIMEOUT', 'An original ISO range exceeded its bounded request deadline.', true);
      const timer = setTimeout(() => timeout.abort(timeoutError), rangeTimeoutMs);
      const requestSignal = AbortSignal.any([controller.signal, timeout.signal]);
      const record = { purpose, range: { start: range.start, end: range.end, total: expected.bytes }, attempt,
        startedAt: new Date().toISOString(), receivedBytes: 0, redirects: 0, bodyVerified: false, settled: false };
      transport.attempts.push(record); transport.activeRequests++;
      transport.maximumActiveRequests = Math.max(transport.maximumActiveRequests, transport.activeRequests);
      let response, reader, bodyEnded = false, cancelPromise, phase = 'fetch', localFailed = false, localFailure, retryable = false;
      const cancelBody = () => {
        if (cancelPromise) return cancelPromise;
        if (!response?.body || bodyEnded) return Promise.resolve();
        cancelPromise = cleanupOperation('range-body-cancel', async () => {
          if (reader) await reader.cancel(requestSignal.reason);
          else await response.body.cancel(requestSignal.reason);
          record.bodyCancelled = true;
        }, () => {
          if (localFailed) fail(localFailure);
          else if (requestSignal.aborted) fail(requestSignal.reason);
        });
        return cancelPromise;
      };
      const cancelOnAbort = () => { void cancelBody(); };
      requestSignal.addEventListener('abort', cancelOnAbort, { once: true });
      try {
        let current = originalUrl;
        for (let redirects = 0; ; redirects++) {
          requestSignal.throwIfAborted(); phase = 'fetch';
          response = await request(current, { method: 'GET', redirect: 'manual', signal: requestSignal,
            headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'MediaManager-original-disc-validation/1',
              Range: `bytes=${range.start}-${range.end}`,
              ...(transport.strongETag ? { 'If-Match': transport.strongETag } : {}) } });
          phase = 'observer';
          await publish(onResponse, { purpose, url: current.href, status: response.status,
            headers: Object.fromEntries(response.headers), range: { ...record.range }, attempt,
            receivedAt: new Date().toISOString() }, 'response-observer');
          phase = 'validate'; requestSignal.throwIfAborted();
          if (!redirectStatuses.has(response.status)) break;
          record.redirects++;
          requireValue(redirects < maximumRedirects, 'ARCHIVE_REDIRECT_LIMIT', 'The original ISO range exceeded its redirect limit.');
          const location = response.headers.get('location');
          requireValue(location, 'ARCHIVE_REDIRECT', 'An original ISO redirect is missing Location.');
          const next = archiveUrl(new URL(location, current));
          await cancelBody(); controller.signal.throwIfAborted();
          response = undefined; reader = undefined; cancelPromise = undefined; bodyEnded = false; current = next;
        }
        record.status = response.status;
        if ([408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) {
          throw new ArchiveSourceError('ARCHIVE_HTTP_TRANSIENT', `Original ISO range HTTP ${response.status}.`, true);
        }
        requireValue(response.status === 206, 'ARCHIVE_RANGE_STATUS', 'The original ISO server must honor each exact byte range with HTTP 206.');
        const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(response.headers.get('content-range') ?? '');
        requireValue(match && [match[1], match[2], match[3]].every(value => Number.isSafeInteger(Number(value)))
          && Number(match[1]) === range.start && Number(match[2]) === range.end && Number(match[3]) === expected.bytes,
        'ARCHIVE_CONTENT_RANGE', 'The original ISO Content-Range differs from the requested range or fixed total.');
        const length = response.headers.get('content-length'), wanted = range.end - range.start + 1;
        requireValue(length === null || /^[0-9]+$/u.test(length) && Number(length) === wanted,
          'ARCHIVE_CONTENT_LENGTH', 'A declared original ISO range Content-Length must be exact.');
        const encoding = response.headers.get('content-encoding');
        requireValue(encoding === null || encoding.toLowerCase() === 'identity', 'ARCHIVE_CONTENT_ENCODING', 'Original ISO ranges must use identity content encoding.');
        const etag = response.headers.get('etag'); record.etag = etag;
        requireValue(!transport.strongETag || etag === transport.strongETag, 'ARCHIVE_ETAG', 'The original ISO strong ETag changed or disappeared.');
        requireValue(response.body && typeof response.body.getReader === 'function', 'ARCHIVE_BODY', 'The original ISO range response has no byte body.');
        reader = response.body.getReader();
        const body = Buffer.allocUnsafe(wanted);
        for (;;) {
          requestSignal.throwIfAborted(); phase = 'read';
          let next;
          try { next = await reader.read(); }
          catch (error) { bodyEnded = true; record.bodyErrored = true; throw error; }
          requestSignal.throwIfAborted();
          if (next.done) { bodyEnded = true; break; }
          requireValue(next.value instanceof Uint8Array, 'ARCHIVE_BODY', 'The original ISO range did not deliver byte chunks.');
          const bytes = next.value.byteLength;
          record.receivedBytes += bytes; transport.wireBytes += bytes;
          if (purpose === 'ISO range probe') transport.probeBytes += bytes;
          else transport.payloadBytes += bytes;
          if (attempt > 1) transport.retryBytes += bytes;
          requireValue(record.receivedBytes <= wanted, 'ARCHIVE_RANGE_EXCESS', 'The original ISO range body exceeded its exact byte count.');
          body.set(next.value, record.receivedBytes - bytes); phase = 'observer'; await occasionalProgress();
        }
        requireValue(record.receivedBytes === wanted, 'ARCHIVE_RANGE_TRUNCATED', 'The original ISO range body was truncated.');
        record.bodyVerified = true;
        return { ok: true, bytes: body, etag };
      } catch (error) {
        localFailed = true; localFailure = error; record.error = errorObservation(error);
        retryable = !controller.signal.aborted && (error instanceof ArchiveSourceError ? error.retryable : ['fetch', 'read'].includes(phase));
        record.retryable = retryable;
        if (!retryable || attempt === maxAttempts) fail(error);
      } finally {
        clearTimeout(timer);
        await cancelBody();
        if (reader) await cleanupOperation('range-reader-release', () => reader.releaseLock(), () => { if (localFailed) fail(localFailure); });
        requestSignal.removeEventListener('abort', cancelOnAbort);
        transport.activeRequests--; record.settled = true; record.completedAt = new Date().toISOString();
      }
      return { ok: false, error: localFailure, retryable };
    };

    const readRange = async (range, purpose) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        controller.signal.throwIfAborted();
        if (attempt > 1) transport.retries++;
        const result = await readAttempt(range, attempt, purpose);
        controller.signal.throwIfAborted();
        if (result.ok) return result;
        if (!result.retryable || attempt === maxAttempts) throw result.error;
        if (retryDelayMs) await delay(retryDelayMs, undefined, { signal: controller.signal });
      }
    };

    try {
      controller.signal.throwIfAborted();
      file = await openFile(filename, 'wx+'); transport.fileCreated = true;
      await progress(); transport.phase = 'probing';
      const probe = await readRange({ start: 0, end: 0 }, 'ISO range probe');
      transport.probeETag = probe.etag; transport.strongETag = strongETag(probe.etag);
      transport.phase = 'downloading'; await progress();
      let nextIndex = 0;
      const worker = async () => {
        try {
          while (!controller.signal.aborted) {
            const index = nextIndex++;
            if (index >= rangeCount) return;
            const range = { index, start: index * rangeBytes, end: Math.min(expected.bytes - 1, (index + 1) * rangeBytes - 1), writtenBytes: 0, complete: false };
            transport.ranges.push(range);
            const result = await readRange(range, 'ISO range');
            let offset = 0;
            while (offset < result.bytes.length) {
              controller.signal.throwIfAborted();
              const { bytesWritten } = await file.write(result.bytes, offset, result.bytes.length - offset, range.start + offset);
              requireValue(Number.isSafeInteger(bytesWritten) && bytesWritten > 0 && bytesWritten <= result.bytes.length - offset,
                'ARCHIVE_FILE_WRITE', 'The original ISO file write did not consume a valid byte count.');
              offset += bytesWritten; range.writtenBytes += bytesWritten; coveredBytes += bytesWritten; transport.coveredBytes = coveredBytes;
            }
            controller.signal.throwIfAborted(); range.complete = true; transport.completedRanges++;
            await progress();
          }
        } catch (error) { fail(error); }
      };
      workers = Array.from({ length: Math.min(concurrency, rangeCount) }, () => worker());
      const settled = await Promise.allSettled(workers);
      for (const result of settled) if (result.status === 'rejected') fail(result.reason);
      transport.workersDrained = true; controller.signal.throwIfAborted();
      const ranges = [...transport.ranges].sort((left, right) => left.index - right.index);
      requireValue(coveredBytes === expected.bytes && ranges.length === rangeCount
        && ranges.every((range, index) => range.index === index && range.complete
          && range.start === index * rangeBytes && range.end === Math.min(expected.bytes - 1, (index + 1) * rangeBytes - 1)
          && range.writtenBytes === range.end - range.start + 1),
      'ARCHIVE_COVERAGE', 'The complete original ISO must have exact nonoverlapping range coverage without gaps.');
      transport.phase = 'hashing'; syncAttempted = true;
      const sync = await cleanupOperation('file-sync', async () => { await file.sync(); transport.fileSynced = true; });
      if (sync.failed) throw sync.error;
      const before = await file.stat({ bigint: true });
      requireValue(before.isFile() && before.size === BigInt(expected.bytes), 'ARCHIVE_FILE_SIZE', 'The complete original ISO file has a different size.');
      const hashes = new Map(['sha256', 'sha1', 'md5'].map(name => [name, createHash(name)]));
      const buffer = Buffer.alloc(Math.min(1024 * 1024, expected.bytes));
      while (transport.hashedBytes < expected.bytes) {
        controller.signal.throwIfAborted();
        const wanted = Math.min(buffer.length, expected.bytes - transport.hashedBytes);
        const { bytesRead } = await file.read(buffer, 0, wanted, transport.hashedBytes);
        requireValue(Number.isSafeInteger(bytesRead) && bytesRead > 0 && bytesRead <= wanted,
          'ARCHIVE_FILE_READ', 'The complete original ISO sequential hash read was truncated.');
        for (const digest of hashes.values()) digest.update(buffer.subarray(0, bytesRead));
        transport.hashedBytes += bytesRead; await occasionalProgress();
      }
      const after = await file.stat({ bigint: true });
      requireValue(after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs,
        'ARCHIVE_FILE_CHANGED', 'The original ISO changed during its complete sequential hash read.');
      digests = Object.fromEntries([...hashes].map(([name, digest]) => [name, digest.digest('hex')]));
      for (const name of ['sha256', 'sha1', 'md5']) if (expected[name] !== undefined) {
        requireValue(digests[name] === expected[name], 'ARCHIVE_ISO_HASH', `The complete original ISO ${name} differs from the fixed source.`);
      }
      controller.signal.throwIfAborted();
    } catch (error) { fail(error); }
    finally {
      if (failed && !controller.signal.aborted) controller.abort(failure);
      const settled = await Promise.allSettled(workers);
      for (const result of settled) if (result.status === 'rejected') fail(result.reason);
      transport.workersDrained = true;
      transport.requestsDrained = transport.activeRequests === 0
        && !cleanup.some(entry => entry.failed && entry.stage.startsWith('range-'));
      if (file) {
        if (!syncAttempted) await cleanupOperation('file-sync', async () => { syncAttempted = true; await file.sync(); transport.fileSynced = true; });
        await cleanupOperation('file-close', async () => { await file.close(); transport.fileClosed = true; });
      }
      await observerTail;
      transport.cleanup = cleanup.filter(entry => entry.failed).map(entry => ({ stage: entry.stage, error: errorObservation(entry.error) }));
      transport.phase = failed ? 'failed' : 'verified';
      if (failed) transport.failure = errorObservation(failure);
      const failedBeforePublication = failed;
      try { await progress('final-progress'); } catch { /* The observer retains its ordered raw failure above. */ }
      if (!failedBeforePublication && failed) {
        transport.phase = 'failed'; transport.failure = errorObservation(failure);
        transport.cleanup = cleanup.filter(entry => entry.failed).map(entry => ({ stage: entry.stage, error: errorObservation(entry.error) }));
        try { await progress('failed-progress'); } catch { /* Keep both actual publication failures. */ }
      }
      await observerTail;
      signal?.removeEventListener('abort', aborted);
    }
    if (failed) {
      const errors = [failure, ...cleanup.filter(entry => entry.failed && !entry.primary).map(entry => entry.error)];
      if (errors.length === 1) throw failure;
      throw new AggregateError(errors, 'Original ISO download and cleanup failed.', { cause: failure });
    }
    transport.complete = true;
    return { bytes: coveredBytes, ...digests, complete: true, transport: structuredClone(transport) };
  };
}

export const downloadOriginalArchiveIso = createArchiveIsoDownloader();
