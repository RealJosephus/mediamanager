import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escapeSegment = value => encodeURIComponent(value).replace(/[!'()*]/gu,
  character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
export const localProxyPath = filename => {
  const escaped = filename.replaceAll('\\', '/').split('/').map(escapeSegment).join('/');
  return '/d' + (escaped.startsWith('/') ? escaped : '/' + escaped);
};

/** Only declared real files and explicitly controlled HTTP sources are served. */
export async function startDownloadSource({ localFiles, remoteFiles, observe }) {
  const targets = new Map([...localFiles.map(file => [localProxyPath(file.path), file]),
    ...remoteFiles.map(file => [new URL(file.path).pathname, file])]);
  const report = { requests: [], errors: [], closed: false };
  const server = http.createServer((request, response) => {
    const entry = { method: request.method, url: request.url, range: request.headers.range ?? null,
      ifRange: request.headers['if-range'] ?? null };
    report.requests.push(entry);
    response.setHeader('Connection', 'close');
    response.on('finish', () => { entry.completed = true; });
    const send = (status, bytes = Buffer.alloc(0), headers = {}) => {
      entry.status = status; entry.bodySha256 = sha(bytes);
      response.writeHead(status, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes', ...headers });
      response.end(bytes);
    };
    (async () => {
      const target = targets.get(request.url);
      if (!target || request.method !== 'GET') return send(404);
      entry.key = target.key;
      entry.beforeSource = await observe(target);
      if (target.missing) return send(404, Buffer.from('Declared download source is missing.'), { 'Content-Type': 'text/plain' });
      let bytes;
      if (target.remote) bytes = target.bytes;
      else {
        const metadata = await lstat(target.path); assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
        bytes = await readFile(target.path); assert.deepEqual(bytes, target.bytes);
      }
      entry.sourceSha256 = sha(bytes);
      let start = 0, end = bytes.length - 1;
      const range = entry.ifRange === null || entry.ifRange === '"download-source"' ? entry.range : null;
      if (range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
        if (!match || !match[1] && !match[2]) return send(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= bytes.length) return send(416, undefined, { 'Content-Range': `bytes */${bytes.length}` });
      }
      send(range === null ? 200 : 206, bytes.subarray(start, end + 1), {
        ...(target.remote ? { 'Content-Type': 'image/jpeg', ETag: '"download-source"' } : {}),
        ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }),
      });
    })().catch(error => {
      entry.error = { name: error.name, code: error.code, message: error.message }; report.errors.push(entry.error);
      if (!response.headersSent) send(500); else response.destroy(error);
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
