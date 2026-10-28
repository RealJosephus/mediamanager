import { once } from 'node:events';
import { StorageError, checkAbort } from '../storage/errors.js';
export { singleRange } from '../storage/range.js';

export class BinaryResult {
  constructor(send) { this.send = send; }
  static bytes(bytes, contentType, { knownLength = true } = {}) {
    return new BinaryResult(async (request, response) => {
      response.setHeader('Content-Type', contentType);
      if (knownLength) response.setHeader('Content-Length', bytes.length);
      if (request.method !== 'HEAD') response.write(bytes);
      response.end();
    });
  }
}

export function contentDisposition(filename) {
  // ASP.NET ContentDispositionHeaderValue.SetHttpFileName replaces non-ASCII
  // characters in filename and retains Unicode in the RFC 5987 parameter.
  const safe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '\\$&');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const token = /^[!#$%&'*+.^_`|~\w-]+$/.test(safe) ? safe : `"${safe}"`;
  return `attachment; filename=${token}; filename*=UTF-8''${encoded}`;
}

export function vfsStreamResult(vfs, accessPath, { contentType, filename, requestHeaders, preserveErrorHeaders = [] } = {}) {
  return new BinaryResult(async (request, response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    if (request.aborted || response.destroyed) abort();
    const previousHeaders = new Map();
    const setHeader = (name, value) => {
      const key = name.toLowerCase();
      if (!previousHeaders.has(key)) previousHeaders.set(key, response.getHeader(name));
      response.setHeader(name, value);
    };
    let handle, failed = false, primary, cleanupFailed = false;
    try {
      // The pinned proxy uses GET even for HEAD; opening then closing preserves
      // upstream range metadata without consuming the media body.
      handle = await vfs.openResponse(accessPath, { rangeHeader: request.headers.range,
        ifRange: request.headers['if-range'], requestHeaders, signal: controller.signal });
      checkAbort(controller.signal);
      response.statusCode = handle.statusCode;
      for (const [name, value] of Object.entries(handle.headers)) setHeader(name, value);
      if (!response.hasHeader('Content-Type')) setHeader('Content-Type', contentType ?? 'application/octet-stream');
      if (filename) setHeader('Content-Disposition', contentDisposition(filename));
      if (request.method === 'HEAD') { response.end(); return; }
      let written = 0n;
      for await (const chunk of handle.stream) {
        checkAbort(controller.signal);
        written += BigInt(chunk.byteLength);
        if (handle.contentLength != null && written > BigInt(handle.contentLength)) throw new StorageError('invalid-response', 'The media stream exceeded its declared length.');
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      if (handle.contentLength != null && written !== BigInt(handle.contentLength)) throw new StorageError('invalid-response', 'The media stream was truncated.');
      response.end();
    } catch (error) {
      failed = true; primary = error;
      if (response.headersSent || controller.signal.aborted) { response.destroy(); abort(); }
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
      try { await handle?.close(); }
      catch (error) {
        if (!failed) {
          if (error === null || !['object', 'function'].includes(typeof error)) error = new Error('Media source cleanup failed.', { cause: error });
          throw error;
        }
        cleanupFailed = true;
        primary = Object.assign(new AggregateError([primary, error], primary?.message ?? 'Media stream and source cleanup failed.', { cause: primary }),
          Object.fromEntries(['code', 'status', 'statusCode'].filter(key => primary?.[key] !== undefined).map(key => [key, primary[key]])));
      }
    }
    if (!failed) return;
    let error = primary;
    if (error === null || !['object', 'function'].includes(typeof error)) error = new Error('Media stream failed.', { cause: error });
    if (response.headersSent || controller.signal.aborted) {
      if (!response.destroyed) response.destroy();
      if (cleanupFailed) throw error;
      return;
    }
    // An error response owns its body framing and type. Restore this send's
    // unpublished headers except source metadata explicitly retained by its
    // caller; existing outer response metadata remains authoritative.
    for (const [name, value] of previousHeaders) {
      if (preserveErrorHeaders.includes(name)) continue;
      if (value === undefined) response.removeHeader(name); else response.setHeader(name, value);
    }
    if (error.code === 'range-not-satisfiable') {
      const details = cleanupFailed ? error.cause?.details : error.details;
      response.statusCode = 416;
      if (details?.totalSize != null) response.setHeader('Content-Range', `bytes */${details.totalSize}`);
      if (details?.contentType || contentType) response.setHeader('Content-Type', details?.contentType ?? contentType);
      if (filename) response.setHeader('Content-Disposition', contentDisposition(filename));
      response.setHeader('Accept-Ranges', details?.acceptRanges || 'bytes');
      response.setHeader('Content-Length', '0');
      response.end();
      if (cleanupFailed) throw error;
      return;
    }
    error.status ??= error.statusCode ?? ({ 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403,
      'version-changed': 412, 'not-supported': 501, timeout: 504 })[error.code] ?? 502;
    throw error;
  });
}
