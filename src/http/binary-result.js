import { once } from 'node:events';
import { StorageError, checkAbort } from '../storage/errors.js';

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

export function singleRange(value) {
  if (value === undefined) return undefined;
  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(value);
  if (!match || !match[1] && !match[2]) throw new StorageError('not-supported', 'Only a single byte range is supported.');
  if (!match[1]) {
    if (BigInt(match[2]) === 0n) throw new StorageError('range-not-satisfiable', 'The suffix range is empty.');
    return { suffix: BigInt(match[2]) };
  }
  const result = { start: BigInt(match[1]) };
  if (match[2]) result.end = BigInt(match[2]);
  if (result.end !== undefined && result.end < result.start) throw new StorageError('range-not-satisfiable', 'The range is reversed.');
  return result;
}

export function contentDisposition(filename) {
  // ASP.NET ContentDispositionHeaderValue.SetHttpFileName replaces non-ASCII
  // characters in filename and retains Unicode in the RFC 5987 parameter.
  const safe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '\\$&');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const token = /^[!#$%&'*+.^_`|~\w-]+$/.test(safe) ? safe : `"${safe}"`;
  return `attachment; filename=${token}; filename*=UTF-8''${encoded}`;
}

export function vfsStreamResult(vfs, accessPath, { contentType, filename } = {}) {
  return new BinaryResult(async (request, response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    let handle;
    try {
      // The pinned proxy uses GET even for HEAD; opening then closing preserves
      // upstream range metadata without consuming the media body.
      handle = await vfs.openRead(accessPath, { range: singleRange(request.headers.range),
        ifRange: request.headers['if-range'], signal: controller.signal });
      checkAbort(controller.signal);
      response.statusCode = handle.rangeHonored ? 206 : 200;
      response.setHeader('Content-Type', handle.contentType ?? contentType ?? 'application/octet-stream');
      response.setHeader('Accept-Ranges', handle.acceptRanges || (handle.rangeHonored || vfs.capabilities(accessPath).randomRead === true ? 'bytes' : 'none'));
      if (handle.contentLength != null) response.setHeader('Content-Length', String(handle.contentLength));
      if (handle.rangeHonored) response.setHeader('Content-Range', `bytes ${handle.range.start}-${handle.range.end}/${handle.totalSize ?? '*'}`);
      if (filename) response.setHeader('Content-Disposition', contentDisposition(filename));
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
      if (response.headersSent || controller.signal.aborted) { response.destroy(); return; }
      if (error.code === 'range-not-satisfiable') {
        response.statusCode = 416;
        if (error.details?.totalSize != null) response.setHeader('Content-Range', `bytes */${error.details.totalSize}`);
        if (error.details?.contentType || contentType) response.setHeader('Content-Type', error.details?.contentType ?? contentType);
        response.setHeader('Accept-Ranges', error.details?.acceptRanges || 'bytes');
        response.setHeader('Content-Length', '0');
        response.end();
      } else {
        error.status ??= ({ 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403,
          'version-changed': 412, 'not-supported': 501, timeout: 504 })[error.code] ?? 502;
        throw error;
      }
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
      await handle?.close();
    }
  });
}
