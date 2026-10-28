import { BinaryResult, vfsStreamResult } from '../http/binary-result.js';

/** HTTP media delivery uses the same owned storage response as raw subtitles. */
export function remoteStaticStreamResult(vfs, accessPath, { headers = {}, serverVersion = '13.0.0', contentType = 'application/octet-stream', filename } = {}) {
  const userAgent = headers?.get?.('User-Agent') ?? headers?.['User-Agent'] ?? headers?.['user-agent'];
  const result = vfsStreamResult(vfs, accessPath, { contentType, filename, preserveErrorHeaders: ['accept-ranges'],
    requestHeaders: { 'User-Agent': userAgent || `Jellyfin-Server/${serverVersion}` } });
  return new BinaryResult(async (request, response) => {
    try { await result.send(request, response); }
    catch (error) {
      if (error === null || !['object', 'function'].includes(typeof error)) error = new Error('Remote media delivery failed.', { cause: error });
      error.status = 500; throw error;
    }
  });
}
