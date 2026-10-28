import assert from 'node:assert/strict';
import http from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeSegment = value => encodeURIComponent(value).replace(/[!'()*]/gu,
  character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const proxyPath = filename => {
  const escaped = filename.replaceAll('\\', '/').split('/').map(escapeSegment).join('/');
  return '/d' + (escaped.startsWith('/') ? escaped : '/' + escaped);
};

/** The designated Native file controller reads only these actual private files. */
export async function startOwnedMediaProxy(files) {
  const routes = files.flatMap(file => [proxyPath(file.filename), ...(file.aliases ?? [])].map(route => [route, file]));
  const targets = new Map(routes);
  assert.equal(targets.size, routes.length, 'Each owned media route has one declared source.');
  const report = { port: 5244, requests: [], errors: [], closed: false };
  const server = http.createServer((request, response) => {
    const observed = { method: request.method, url: request.url, range: request.headers.range ?? null,
      ...(report.phase === undefined ? {} : { phase: report.phase }) };
    report.requests.push(observed);
    response.on('finish', () => { observed.completed = true; });
    response.on('close', () => { observed.closed = true; });
    response.setHeader('Connection', 'close');
    const send = (status, bytes = Buffer.alloc(0), headers = {}) => {
      observed.status = status; observed.bodyBytes = request.method === 'HEAD' ? 0 : bytes.length;
      response.writeHead(status, { 'Content-Length': bytes.length, ...headers });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    (async () => {
      const target = targets.get(request.url);
      if (!target) return send(404);
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, undefined, { Allow: 'GET, HEAD' });
      const info = await lstat(target.filename);
      assert.ok(info.isFile() && !info.isSymbolicLink());
      const bytes = await readFile(target.filename);
      assert.equal(bytes.length, target.expected.bytes); assert.equal(sha(bytes), target.expected.sha256);
      Object.assign(observed, { filename: target.filename, sourceBytes: bytes.length, sourceSha256: sha(bytes) });
      let start = 0, end = bytes.length - 1;
      if (observed.range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(observed.range);
        if (!match || !match[1] && !match[2]) return send(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length)
          return send(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
      }
      const body = bytes.subarray(start, end + 1);
      observed.sha256 = sha(body);
      send(observed.range === null ? 200 : 206, body, { 'Content-Type': target.contentType, 'Accept-Ranges': 'bytes',
        ...(observed.range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }) });
    })().catch(error => {
      if (error.code === 'ENOENT') return send(404);
      const failure = { name: error.name, code: error.code, message: error.message };
      observed.error = failure; report.errors.push(failure);
      if (response.headersSent) response.destroy(error); else send(500);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject).listen(5244, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', error => report.errors.push({ name: error.name, code: error.code, message: error.message }));
  let closing;
  return { report, close: () => closing ??= new Promise((resolve, reject) => {
    server.close(error => { report.closed = !server.listening; if (error) reject(error); else resolve(); });
  }) };
}
