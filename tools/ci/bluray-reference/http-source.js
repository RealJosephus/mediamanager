import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const responseHeaders = response => Object.fromEntries(['content-type', 'content-length', 'content-encoding',
  'content-range', 'last-modified', 'etag', 'location'].filter(name => response.headers.has(name))
  .map(name => [name, response.headers.get(name)]));

/** Obtain the entire original HTTPS object once, without an encoder or a range
 * substitute. The caller independently rereads the completed disk file. */
export async function downloadOriginalIso(descriptor, filename, { signal, timeoutMinutes, onResponse, onProgress }) {
  assert.ok(Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0);
  assert.ok(/^[a-f0-9]{32}$/u.test(descriptor.md5));
  assert.ok(descriptor.sha256 == null || /^[a-f0-9]{64}$/u.test(descriptor.sha256));
  assert.ok(Array.isArray(descriptor.allowedHosts) && descriptor.allowedHosts.length > 0);
  const idle = new AbortController(), lifetime = new AbortController(), duration = AbortSignal.timeout(timeoutMinutes * 60_000);
  const downloadSignal = AbortSignal.any([signal, duration, idle.signal, lifetime.signal]);
  let idleTimer, handle, primary, failed = false, savedAt = 0;
  const progress = { url: descriptor.url, filename: descriptor.filename, expectedBytes: descriptor.bytes,
    expectedMd5: descriptor.md5, startedAt: new Date().toISOString(), bytes: 0, streamComplete: false };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(Object.assign(new Error('Original ISO made no download progress for five minutes.'),
      { code: 'NO_DOWNLOAD_PROGRESS' })), 5 * 60_000);
  };
  resetIdle();
  try {
    let current = new URL(descriptor.url), response;
    for (let redirects = 0; redirects <= 6; redirects++) {
      assert.ok(current.protocol === 'https:' && descriptor.allowedHosts.includes(current.hostname)
        && !current.username && !current.password, 'Original ISO redirect left its declared HTTPS publisher.');
      response = await fetch(current, { redirect: 'manual', signal: downloadSignal,
        headers: { 'User-Agent': 'MediaManager-original-disc-reference/1', 'Accept-Encoding': 'identity' } });
      await onResponse({ purpose: 'complete original ISO', url: current.href, status: response.status,
        receivedAt: new Date().toISOString(), headers: responseHeaders(response) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      assert.ok(redirects < 6 && response.headers.has('location'), 'Original ISO exceeded its redirect limit.');
      current = new URL(response.headers.get('location'), current);
    }
    assert.equal(response.status, 200, 'The complete original ISO requires a successful full-object response.');
    assert.ok(!response.headers.has('content-range'), 'A partial original ISO response is not a complete source.');
    assert.ok(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity');
    const length = response.headers.get('content-length');
    if (length != null) assert.equal(length, String(descriptor.bytes), 'Original ISO Content-Length differs from the publisher size.');
    assert.ok(response.body, 'Original ISO response has no body.');
    progress.finalUrl = current.href;
    handle = await open(filename, 'wx', 0o600);
    const sha256 = createHash('sha256'), md5 = createHash('md5');
    for await (const chunk of response.body) {
      downloadSignal.throwIfAborted(); resetIdle();
      progress.bytes += chunk.length;
      assert.ok(progress.bytes <= descriptor.bytes, 'Original ISO exceeds its complete published size.');
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        assert.ok(bytesWritten > 0, 'Original ISO disk write made no progress.'); offset += bytesWritten;
      }
      sha256.update(chunk); md5.update(chunk);
      if (Date.now() - savedAt >= 60000) { await onProgress({ ...progress }); savedAt = Date.now(); }
    }
    assert.equal(progress.bytes, descriptor.bytes, 'Original ISO ended before its complete published size.');
    Object.assign(progress, { sha256: sha256.digest('hex'), md5: md5.digest('hex') });
    assert.equal(progress.md5, descriptor.md5, 'Original ISO differs from its adjacent publisher MD5.');
    if (descriptor.sha256 != null) assert.equal(progress.sha256, descriptor.sha256, 'Original ISO differs from its frozen SHA256.');
    await handle.sync();
    progress.streamComplete = true;
  } catch (error) {
    failed = true; primary = error;
    progress.error = { name: error.name, message: error.message, code: error.code };
  } finally {
    clearTimeout(idleTimer);
    lifetime.abort();
    try { await handle?.close(); }
    catch (error) {
      primary = failed ? new AggregateError([primary, error], 'Original ISO acquisition and file close failed', { cause: primary }) : error;
      failed = true; progress.streamComplete = false;
    }
    progress.finishedAt = new Date().toISOString();
    try { await onProgress({ ...progress }); }
    catch (error) {
      primary = failed ? new AggregateError([primary, error], 'Original ISO acquisition and progress publication failed', { cause: primary }) : error;
      failed = true;
    }
  }
  if (failed) throw primary;
  return progress;
}
