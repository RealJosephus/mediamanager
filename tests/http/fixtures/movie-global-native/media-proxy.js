import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeSegment = value => encodeURIComponent(value).replace(/[!'()*]/gu,
  character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const proxyPath = filename => {
  const escaped = filename.replaceAll('\\', '/').split('/').map(escapeSegment).join('/');
  return '/d' + (escaped.startsWith('/') ? escaped : '/' + escaped);
};

// The designated Native workspace routes local files through this fixed port.
// Read only the four exact business copies, never a caller-supplied filesystem
// path or the common frozen input in place of a missing/deleted business file.
export async function startMovieMediaProxy({ root, specification, media }) {
  const targets = new Map(['first', 'repeat'].flatMap(label => specification.movies.map(name => {
    const filename = path.join(root, 'native-' + label, 'case', 'media', name + '.mkv');
    return [proxyPath(filename), filename];
  })));
  const report = { host: '127.0.0.1', port: 5244, targets: Object.fromEntries(targets), requests: [], errors: [], closed: false };
  const server = http.createServer((request, response) => {
    const entry = { method: request.method, url: request.url, range: request.headers.range ?? null,
      completed: false, closed: false };
    report.requests.push(entry);
    response.on('finish', () => { entry.completed = true; });
    response.on('close', () => { entry.closed = true; });
    response.setHeader('Connection', 'close');
    const respond = (status, bytes, headers = {}) => {
      entry.status = status;
      response.writeHead(status, { 'Content-Length': bytes?.length ?? 0, ...headers });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    (async () => {
      const filename = targets.get(request.url);
      if (!filename) return respond(404);
      if (!['GET', 'HEAD'].includes(request.method)) return respond(405, undefined, { Allow: 'GET, HEAD' });
      const info = await lstat(filename);
      assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false);
      assert.equal(info.size, media.bytes);
      const bytes = await readFile(filename);
      assert.equal(bytes.length, media.bytes); assert.equal(sha(bytes), media.sha256);
      entry.filename = filename; entry.fileBytes = bytes.length; entry.fileSha256 = sha(bytes);
      let start = 0, end = bytes.length - 1;
      if (entry.range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(entry.range);
        if (!match || !match[1] && !match[2]) return respond(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length)
          return respond(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
      }
      const body = bytes.subarray(start, end + 1);
      entry.start = start; entry.end = end; entry.contentLength = body.length;
      entry.bodyBytes = request.method === 'HEAD' ? 0 : body.length;
      entry.bodySha256 = sha(request.method === 'HEAD' ? Buffer.alloc(0) : body);
      respond(entry.range === null ? 200 : 206, body, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes',
        ...(entry.range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }) });
    })().catch(error => {
      entry.error = { name: error.name, code: error.code, message: error.message };
      report.errors.push(entry.error);
      if (!response.headersSent) respond(error.code === 'ENOENT' ? 404 : 500);
      else response.destroy(error);
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(5244, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', error => { report.errors.push({ name: error.name, code: error.code, message: error.message }); });
  assert.equal(server.address().address, report.host); assert.equal(server.address().port, report.port);
  let closing;
  return { report, close: () => closing ??= new Promise((resolve, reject) => {
    server.close(error => {
      report.closed = !server.listening;
      if (error) reject(error); else resolve();
    });
    server.closeIdleConnections();
  }) };
}
