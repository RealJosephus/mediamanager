import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveFailureObservation, createArchiveIsoDownloader } from '../../tools/ci/disc-reference/http-source.js';

// These controlled opaque byte streams exercise transport ownership only.
// They are not an ISO, licensed media acquisition, or a real-source receipt.
const payload = Buffer.from(Array.from({ length: 41 }, (_, index) => index * 37 & 255));
const sha = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const sourceFor = bytes => ({ url: 'https://archive.org/download/controlled-unit/original.iso', bytes: bytes.length,
  sha256: sha(bytes, 'sha256'), sha1: sha(bytes, 'sha1'), md5: sha(bytes, 'md5') });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

async function fixture(t, { syncFailure, closeFailure, failSync = false, failClose = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-disc-http-'));
  const handles = [], writes = [], cleanup = [];
  t.after(async () => {
    for (const operation of cleanup) await operation();
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  const openFile = async (filename, flags) => {
    const handle = await open(filename, flags); handles.push(handle);
    return { stat: options => handle.stat(options), read: (...args) => handle.read(...args),
      async write(...args) {
        const result = await handle.write(...args); writes.push({ position: args[3], bytes: result.bytesWritten }); return result;
      },
      async sync() { if (failSync) throw syncFailure; await handle.sync(); },
      async close() { await handle.close(); if (failClose) throw closeFailure; } };
  };
  return { filename: path.join(root, 'original.iso'), openFile, handles, writes, cleanup };
}

function controlledBody(chunks, { wait, cancelWait, cancelFailure, failCancel = false, readFailure,
  failRead = false, onClosed = () => {}, onCancel = () => {} } = {}) {
  let index = 0, closed = false;
  const finish = () => { if (!closed) { closed = true; onClosed(); } };
  return new ReadableStream({
    async pull(controller) {
      if (wait) await wait.promise;
      if (closed) return;
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else if (failRead) { finish(); controller.error(readFailure); }
      else { finish(); controller.close(); }
    },
    async cancel(reason) {
      onCancel(reason);
      if (cancelWait) await cancelWait.promise;
      wait?.resolve(); finish();
      if (failCancel) throw cancelFailure;
    },
  });
}

function responseFor(bytes, start, end, { status = 206, etag = '"fixed-unit-generation"',
  headers = {}, body, chunks, ...bodyOptions } = {}) {
  const values = new Headers({ 'content-range': `bytes ${start}-${end}/${bytes.length}`,
    'content-length': String(end - start + 1), ...(etag === null ? {} : { etag }), ...headers });
  for (const [name, value] of Object.entries(headers)) if (value === null) values.delete(name);
  return new Response(body === undefined ? controlledBody(chunks ?? [bytes.subarray(start, end + 1)], bodyOptions) : body,
    { status, headers: values });
}

function requestRange(options) {
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  const match = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.Range); assert.ok(match);
  return { start: Number(match[1]), end: Number(match[2]) };
}

async function rejection(operation) {
  let rejected = false, error;
  try { await operation(); } catch (value) { rejected = true; error = value; }
  assert.equal(rejected, true, 'The complete download must reject its actual failure.');
  return error;
}

test('parallel archive ranges finish out of order but preserve one exact file, hashes and serialized observers', { timeout: 10000 }, async t => {
  const io = await fixture(t), first = deferred(), completionOrder = [], requests = [], publications = [];
  io.cleanup.push(() => first.resolve());
  let publishing = false;
  const observer = async (kind, value) => {
    assert.equal(publishing, false, 'Response/progress publication has one shared serialization owner.');
    publishing = true; await Promise.resolve(); publications.push({ kind, value });
    if (kind === 'progress' && value.transport.ranges.some(range => range.index > 0 && range.complete)) first.resolve();
    publishing = false;
  };
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, concurrency: 4, retryDelayMs: 0,
    fetch: async (url, options) => {
      const range = requestRange(options); requests.push({ url: String(url), ...range, validator: options.headers['If-Match'] });
      return responseFor(payload, range.start, range.end, {
        ...(range.start === 0 && range.end !== 0 ? { wait: first } : {}),
        onClosed: () => { if (range.end !== 0) completionOrder.push(range.start); },
      });
    } });
  const source = Object.freeze(sourceFor(payload));
  const result = await download(source, io.filename, {
    onResponse: value => observer('response', value), onProgress: value => observer('progress', value),
  });
  assert.notEqual(completionOrder[0], 0); assert.deepEqual(await readFile(io.filename), payload);
  for (const algorithm of ['sha256', 'sha1', 'md5']) assert.equal(result[algorithm], source[algorithm]);
  assert.equal(result.bytes, payload.length); assert.equal(result.complete, true);
  assert.equal(result.transport.coveredBytes, payload.length); assert.equal(result.transport.hashedBytes, payload.length);
  assert.equal(result.transport.probeBytes, 1); assert.equal(result.transport.wireBytes, payload.length + 1);
  assert.equal(result.transport.maximumActiveRequests, 4); assert.equal(result.transport.requestsDrained, true);
  assert.equal(result.transport.workersDrained, true); assert.equal(result.transport.fileSynced, true); assert.equal(result.transport.fileClosed, true);
  assert.ok(io.handles.every(handle => handle.fd === -1));
  assert.ok(requests.filter(range => range.end !== 0).every(range => range.validator === '"fixed-unit-generation"'));
  assert.ok(publications.filter(row => row.kind === 'progress').every(row => row.value.complete === false),
    'Progress never substitutes for the caller\'s independent whole-file acceptance.');
  const covered = io.writes.toSorted((left, right) => left.position - right.position);
  let after = 0; for (const range of covered) { assert.equal(range.position, after); after += range.bytes; }
  assert.equal(after, payload.length, 'Every original byte is written once without a gap or overlap.');
});

test('allowed redirects retain exact range conditions while weak or absent ETags remain hash verified', async t => {
  for (const etag of ['"fixed-unit-generation"', 'W/"weak-unit-generation"', null]) {
    const io = await fixture(t), requests = [];
    const source = sourceFor(payload); delete source.sha256;
    const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, retryDelayMs: 0,
      fetch: async (url, options) => {
        const range = requestRange(options); requests.push({ url: String(url), validator: options.headers['If-Match'], ...range });
        if (new URL(url).hostname === 'archive.org') return responseFor(payload, range.start, range.end,
          { status: 302, headers: { location: 'https://dn.controlled.archive.org/original.iso' } });
        return responseFor(payload, range.start, range.end, { etag });
      } });
    const result = await download(source, io.filename);
    assert.deepEqual(await readFile(io.filename), payload); assert.equal(result.sha256, sha(payload, 'sha256'));
    assert.equal(result.sha1, source.sha1); assert.equal(result.md5, source.md5);
    assert.equal(result.transport.strongETag, etag?.startsWith('"') ? etag : null);
    assert.ok(requests.filter(range => range.end !== 0).every(range => range.validator === (etag?.startsWith('"') ? etag : undefined)));
    assert.ok(io.handles.every(handle => handle.fd === -1));
  }
});

const protocolFaults = [
  ['ignored range', 'ARCHIVE_RANGE_STATUS', { status: 200 }],
  ['wrong offset', 'ARCHIVE_CONTENT_RANGE', { headers: { 'content-range': `bytes 1-1/${payload.length}` } }],
  ['wrong end', 'ARCHIVE_CONTENT_RANGE', { headers: { 'content-range': `bytes 0-1/${payload.length}` } }],
  ['wrong total', 'ARCHIVE_CONTENT_RANGE', { headers: { 'content-range': `bytes 0-0/${payload.length + 1}` } }],
  ['wrong length', 'ARCHIVE_CONTENT_LENGTH', { headers: { 'content-length': '2' } }],
  ['encoded body', 'ARCHIVE_CONTENT_ENCODING', { headers: { 'content-encoding': 'gzip' } }],
  ['missing body', 'ARCHIVE_BODY', { body: null }],
  ['excess body', 'ARCHIVE_RANGE_EXCESS', { chunks: [payload.subarray(0, 2)] }],
  ['truncated body', 'ARCHIVE_RANGE_TRUNCATED', { chunks: [] }],
];

test('an undeclared Content-Length still requires exact range bodies and complete original hashes', async t => {
  const io = await fixture(t);
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, retryDelayMs: 0,
    fetch: async (_url, options) => {
      const range = requestRange(options); return responseFor(payload, range.start, range.end,
        { headers: { 'content-length': null } });
    } });
  const result = await download(sourceFor(payload), io.filename);
  assert.deepEqual(await readFile(io.filename), payload); assert.equal(result.complete, true);
  for (const algorithm of ['sha256', 'sha1', 'md5']) assert.equal(result[algorithm], sourceFor(payload)[algorithm]);
  assert.ok(io.handles.every(handle => handle.fd === -1));
});
for (const [name, code, options] of protocolFaults) test(`archive range rejects ${name} and never publishes a complete input`, async t => {
  const io = await fixture(t), progress = [];
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, maxAttempts: 1,
    fetch: async (_url, request) => { requestRange(request); return responseFor(payload, 0, 0, options); } });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(error.code, code); assert.ok(progress.length); assert.ok(progress.every(value => value.complete === false));
  assert.equal(progress.at(-1).transport.requestsDrained, true); assert.equal(progress.at(-1).transport.fileClosed, true);
  assert.equal(progress.at(-1).bytes, 0); assert.equal((await readFile(io.filename)).length, 0);
  assert.ok(io.handles.every(handle => handle.fd === -1));
});

for (const etag of ['"changed-generation"', null]) test(`a pinned strong validator rejects ${etag === null ? 'a missing' : 'a changed'} ETag`, async t => {
  const io = await fixture(t), progress = [];
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, maxAttempts: 1,
    fetch: async (_url, options) => {
      const range = requestRange(options);
      return responseFor(payload, range.start, range.end, { etag: range.end === 0 ? '"fixed-unit-generation"' : etag });
    } });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(error.code, 'ARCHIVE_ETAG'); assert.equal(progress.at(-1).complete, false);
  assert.equal(progress.at(-1).transport.requestsDrained, true); assert.ok(io.handles.every(handle => handle.fd === -1));
});

for (const location of ['http://archive.org/original.iso', 'https://archive.org.invalid/original.iso',
  'https://user:password@archive.org/original.iso', null]) test(`archive redirects reject ${location ?? 'missing Location'} without a second request`, async t => {
  const io = await fixture(t); let requests = 0, canceled = false;
  const download = createArchiveIsoDownloader({ openFile: io.openFile, maxAttempts: 1,
    fetch: async () => { requests++; return responseFor(payload, 0, 0, { status: 302,
      headers: { location }, onCancel: () => { canceled = true; } }); } });
  await rejection(() => download(sourceFor(payload), io.filename));
  assert.equal(requests, 1); assert.equal(canceled, true); assert.ok(io.handles.every(handle => handle.fd === -1));
});

test('archive redirect loops and temporary responses have finite bounds without a sequential fallback', async t => {
  const io = await fixture(t); let redirects = 0;
  const download = createArchiveIsoDownloader({ openFile: io.openFile, maxAttempts: 1,
    fetch: async () => { redirects++; return responseFor(payload, 0, 0, { status: 307, headers: { location: '/same.iso' } }); } });
  const error = await rejection(() => download(sourceFor(payload), io.filename));
  assert.equal(error.code, 'ARCHIVE_REDIRECT_LIMIT'); assert.equal(redirects, 9);
  const retryIo = await fixture(t), requests = [], progress = [];
  const temporary = createArchiveIsoDownloader({ openFile: retryIo.openFile, rangeBytes: 8, concurrency: 1, maxAttempts: 3, retryDelayMs: 0,
    fetch: async (_url, options) => {
      const range = requestRange(options); requests.push(range);
      return responseFor(payload, range.start, range.end, range.end === 0 ? {} : { status: 503 });
    } });
  const transient = await rejection(() => temporary(sourceFor(payload), retryIo.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(transient.code, 'ARCHIVE_HTTP_TRANSIENT'); assert.equal(requests.length, 4);
  assert.equal(progress.at(-1).transport.retries, 2); assert.equal(progress.at(-1).complete, false);
  assert.ok([...io.handles, ...retryIo.handles].every(handle => handle.fd === -1));
});

test('a retried partial network body is separate from final coverage and all three complete-file hashes', async t => {
  const io = await fixture(t), attempts = new Map(), progress = [];
  const failure = new TypeError('controlled interrupted identity body');
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, concurrency: 2, retryDelayMs: 0,
    fetch: async (_url, options) => {
      const range = requestRange(options), key = options.headers.Range;
      const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
      if (range.start === 0 && range.end === 7 && attempt === 1) return responseFor(payload, 0, 7,
        { chunks: [payload.subarray(0, 3)], failRead: true, readFailure: failure });
      return responseFor(payload, range.start, range.end);
    } });
  const result = await download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } });
  assert.deepEqual(await readFile(io.filename), payload); assert.equal(result.bytes, payload.length);
  assert.equal(result.transport.wireBytes, payload.length + 1 + 3); assert.equal(result.transport.probeBytes, 1);
  assert.equal(result.transport.retries, 1); assert.equal(result.transport.retryBytes, 8);
  assert.equal(result.transport.attempts.find(entry => entry.receivedBytes === 3).bodyVerified, false);
  assert.equal(result.transport.complete, true); assert.ok(progress.every(value => !value.complete));
});

test('a genuine partial file stays incomplete when a later range fails', async t => {
  const io = await fixture(t), progress = [];
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, concurrency: 1, maxAttempts: 1,
    fetch: async (_url, options) => {
      const range = requestRange(options);
      return responseFor(payload, range.start, range.end, range.start === 8
        ? { headers: { 'content-range': `bytes 9-15/${payload.length}` } } : {});
    } });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(error.code, 'ARCHIVE_CONTENT_RANGE'); assert.deepEqual(await readFile(io.filename), payload.subarray(0, 8));
  assert.equal(progress.at(-1).bytes, 8); assert.equal(progress.at(-1).complete, false);
  assert.equal(progress.at(-1).transport.completedRanges, 1); assert.equal(progress.at(-1).transport.hashedBytes, 0);
  assert.equal(progress.at(-1).transport.requestsDrained, true); assert.ok(io.handles.every(handle => handle.fd === -1));
});

test('one failed range aborts and drains every sibling before the real file closes', { timeout: 10000 }, async t => {
  const io = await fixture(t), allStarted = deferred(), allCanceled = deferred(), drain = deferred(), progress = [];
  let active = 0, canceled = 0, settled = false;
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, concurrency: 4, maxAttempts: 1,
    fetch: async (_url, options) => {
      const range = requestRange(options);
      if (range.end === 0) return responseFor(payload, 0, 0);
      active++; if (active === 4) allStarted.resolve();
      return responseFor(payload, range.start, range.end, { wait: drain, cancelWait: drain,
        ...(range.start === 0 ? { headers: { 'content-range': `bytes 1-7/${payload.length}` } } : {}),
        onCancel: () => { canceled++; if (canceled === 4) allCanceled.resolve(); }, onClosed: () => { active--; } });
    } });
  const pending = download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } })
    .then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  void pending.catch(() => {});
  io.cleanup.push(async () => { drain.resolve(); await pending.catch(() => {}); });
  await allStarted.promise; await allCanceled.promise; await Promise.resolve();
  assert.equal(settled, false); assert.ok(io.handles.some(handle => handle.fd !== -1));
  drain.resolve(); const error = await rejection(() => pending);
  assert.equal(error.code, 'ARCHIVE_CONTENT_RANGE'); assert.equal(active, 0);
  assert.equal(progress.at(-1).complete, false); assert.equal(progress.at(-1).transport.requestsDrained, true);
  assert.ok(io.handles.every(handle => handle.fd === -1));
});

test('external cancellation drains every concurrent body before closing the actual file and preserves a falsy reason', { timeout: 10000 }, async t => {
  const io = await fixture(t), controller = new AbortController(), allStarted = deferred(), allCanceled = deferred(), drain = deferred();
  const progress = []; let active = 0, canceled = 0, settled = false;
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeBytes: 8, concurrency: 4,
    fetch: async (_url, options) => {
      const range = requestRange(options);
      if (range.end === 0) return responseFor(payload, 0, 0);
      active++; if (active === 4) allStarted.resolve();
      return responseFor(payload, range.start, range.end, { wait: drain, cancelWait: drain,
        onCancel: () => { canceled++; if (canceled === 4) allCanceled.resolve(); }, onClosed: () => { active--; } });
    } });
  const pending = download(sourceFor(payload), io.filename, { signal: controller.signal,
    onProgress: value => { progress.push(value); } }).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  void pending.catch(() => {});
  io.cleanup.push(async () => { controller.abort(); drain.resolve(); await pending.catch(() => {}); });
  await allStarted.promise; controller.abort(false); await allCanceled.promise; await Promise.resolve();
  assert.equal(settled, false); assert.ok(io.handles.some(handle => handle.fd !== -1), 'The file remains owned while actual bodies are draining.');
  drain.resolve(); const error = await rejection(() => pending);
  assert.equal(error, false); assert.equal(active, 0); assert.ok(io.handles.every(handle => handle.fd === -1));
  assert.equal(progress.at(-1).bytes, 0); assert.equal(progress.at(-1).complete, false);
  assert.equal(progress.at(-1).transport.requestsDrained, true); assert.equal(progress.at(-1).transport.workersDrained, true);
});

test('request deadlines are bounded and preaborted downloads never create a file or start a request', async t => {
  const io = await fixture(t), progress = [];
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeTimeoutMs: 10, maxAttempts: 1,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }) });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(error.code, 'ARCHIVE_RANGE_TIMEOUT'); assert.equal(progress.at(-1).transport.fileClosed, true);
  const beforeIo = await fixture(t), aborted = new AbortController(); aborted.abort(0); let requests = 0;
  const before = createArchiveIsoDownloader({ openFile: beforeIo.openFile, fetch: async () => { requests++; } });
  const original = await rejection(() => before(sourceFor(payload), beforeIo.filename, { signal: aborted.signal,
    onProgress: value => { assert.equal(value.complete, false); } }));
  assert.equal(original, 0); assert.equal(requests, 0); assert.equal(beforeIo.handles.length, 0);
});

test('a range timeout stays primary when its actual body cancellation also fails', { timeout: 10000 }, async t => {
  const io = await fixture(t), wait = deferred(), progress = [];
  io.cleanup.push(() => wait.resolve());
  const cancelFailure = new Error('controlled timeout body cancellation failure');
  const download = createArchiveIsoDownloader({ openFile: io.openFile, rangeTimeoutMs: 10, maxAttempts: 2,
    fetch: async () => responseFor(payload, 0, 0, { wait, failCancel: true, cancelFailure }) });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => { progress.push(value); } }));
  assert.ok(error instanceof AggregateError); assert.equal(error.cause.code, 'ARCHIVE_RANGE_TIMEOUT');
  assert.equal(error.errors[0], error.cause); assert.equal(error.errors[1], cancelFailure);
  assert.equal(progress.at(-1).complete, false); assert.equal(progress.at(-1).transport.requestsDrained, false);
  assert.ok(io.handles.every(handle => handle.fd === -1));
});

test('observer undefined and ordered falsy cleanup failures keep their actual primary values', async t => {
  const io = await fixture(t), progress = [];
  const download = createArchiveIsoDownloader({ openFile: io.openFile,
    fetch: async () => responseFor(payload, 0, 0) });
  const error = await rejection(() => download(sourceFor(payload), io.filename,
    { onResponse: () => { throw undefined; }, onProgress: value => { progress.push(value); } }));
  assert.equal(error, undefined); assert.equal(progress.at(-1).complete, false); assert.equal(progress.at(-1).transport.fileClosed, true);
  const badIo = await fixture(t, { failClose: true, closeFailure: null });
  const primary = new Error('controlled range rejection');
  const broken = createArchiveIsoDownloader({ openFile: badIo.openFile,
    fetch: async () => responseFor(payload, 0, 0, { failCancel: true, cancelFailure: 0 }) });
  const combined = await rejection(() => broken(sourceFor(payload), badIo.filename, {
    onResponse: () => { throw primary; },
    onProgress: value => { if (value.transport.phase === 'failed') throw ''; },
  }));
  assert.ok(combined instanceof AggregateError); assert.equal(combined.cause, primary);
  assert.deepEqual(combined.errors, [primary, 0, null, '']); assert.ok(badIo.handles.every(handle => handle.fd === -1));
  const syncIo = await fixture(t, { failSync: true, syncFailure: false, failClose: true, closeFailure: 0 });
  const sync = createArchiveIsoDownloader({ openFile: syncIo.openFile, fetch: async (_url, options) => {
    const range = requestRange(options); return responseFor(payload, range.start, range.end);
  } });
  const syncError = await rejection(() => sync(sourceFor(payload), syncIo.filename));
  assert.deepEqual(syncError.errors, [false, 0]); assert.equal(syncError.cause, false);
});

test('a final observer failure cannot turn verified file bytes into a successful acquisition', async t => {
  const io = await fixture(t), publications = [], failure = new Error('controlled final metadata failure');
  const download = createArchiveIsoDownloader({ openFile: io.openFile, fetch: async (_url, options) => {
    const range = requestRange(options); return responseFor(payload, range.start, range.end);
  } });
  const error = await rejection(() => download(sourceFor(payload), io.filename, { onProgress: value => {
    publications.push(value); if (value.transport.phase === 'verified') throw failure;
  } }));
  assert.equal(error, failure); assert.equal(publications.at(-1).transport.phase, 'failed');
  assert.equal(publications.at(-1).complete, false); assert.ok(io.handles.every(handle => handle.fd === -1));
});

for (const algorithm of ['sha256', 'sha1', 'md5']) test(`complete original ISO ${algorithm} remains mandatory when supplied`, async t => {
  const io = await fixture(t), source = sourceFor(payload), progress = [];
  source[algorithm] = '0'.repeat(source[algorithm].length);
  const download = createArchiveIsoDownloader({ openFile: io.openFile, fetch: async (_url, options) => {
    const range = requestRange(options); return responseFor(payload, range.start, range.end);
  } });
  const error = await rejection(() => download(source, io.filename, { onProgress: value => { progress.push(value); } }));
  assert.equal(error.code, 'ARCHIVE_ISO_HASH'); assert.equal(progress.at(-1).complete, false);
  assert.equal(progress.at(-1).bytes, payload.length); assert.deepEqual(await readFile(io.filename), payload);
  assert.ok(io.handles.every(handle => handle.fd === -1));
});

test('an existing target is never opened for mutation and an untrusted origin never starts network IO', async t => {
  const io = await fixture(t), original = Buffer.from('existing unrelated bytes'); await writeFile(io.filename, original);
  let requests = 0; const download = createArchiveIsoDownloader({ openFile: io.openFile, fetch: async () => { requests++; } });
  const error = await rejection(() => download(sourceFor(payload), io.filename));
  assert.equal(error.code, 'EEXIST'); assert.equal(requests, 0); assert.deepEqual(await readFile(io.filename), original);
  const invalid = { ...sourceFor(payload), url: 'https://archive.org.invalid/original.iso' };
  const denied = await rejection(() => download(invalid, io.filename));
  assert.equal(denied.code, 'ARCHIVE_ORIGIN'); assert.equal(io.handles.length, 0); assert.equal(requests, 0);
});

test('archive failure diagnostics preserve ordered falsy causes, special numbers and explicit cycles as JSON', () => {
  const ownCause = new Error('controlled own undefined cause', { cause: undefined });
  ownCause.code = 'CONTROLLED';
  const inherited = new Error('controlled inherited cause');
  const prototype = Object.create(Error.prototype); prototype.cause = false; Object.setPrototypeOf(inherited, prototype);
  const opaque = { name: 'controlled object' }; opaque.self = opaque;
  const error = new AggregateError([ownCause, null, false, 0, '', undefined, NaN, -0, Infinity, -Infinity, inherited, opaque],
    'controlled ordered failures', { cause: false });
  error.errors.push(error);
  const observation = archiveFailureObservation(error);
  assert.equal(observation.kind, 'error'); assert.equal(observation.name, 'AggregateError');
  assert.equal(observation.message, error.message); assert.equal(observation.stack, error.stack);
  assert.deepEqual(observation.cause, { kind: 'boolean', value: false });
  assert.equal(observation.errors[0].code, 'CONTROLLED');
  assert.deepEqual(observation.errors[0].cause, { kind: 'undefined', value: 'undefined' });
  assert.deepEqual(observation.errors.slice(1, 10), [
    { kind: 'null', value: null }, { kind: 'boolean', value: false }, { kind: 'number', value: 0 },
    { kind: 'string', value: '' }, { kind: 'undefined', value: 'undefined' },
    { kind: 'number', value: 'NaN' }, { kind: 'number', value: '-0' },
    { kind: 'number', value: '+Infinity' }, { kind: 'number', value: '-Infinity' },
  ]);
  assert.equal(Object.hasOwn(observation.errors[10], 'cause'), false);
  assert.equal(observation.errors[11].properties.self.kind, 'circular-reference');
  assert.equal(observation.errors[12].kind, 'circular-reference');
  assert.doesNotThrow(() => JSON.stringify(observation));
  assert.equal(error.cause, false); assert.equal(error.errors[0], ownCause); assert.equal(error.errors[12], error);
  assert.ok(Object.is(error.errors[7], -0), 'Diagnostic serialization does not rewrite the raw chain.');
});
