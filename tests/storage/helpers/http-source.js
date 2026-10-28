import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

export async function startHttpSource() {
  const events = [], waiters = new Set(), sockets = new Set();
  const bytes = Buffer.from('0123456789');
  const server = http.createServer((request, response) => {
    const closed = Promise.withResolvers(), socketClosed = Promise.withResolvers();
    const entry = { method: request.method, target: request.url, headers: { ...request.headers },
      closed: closed.promise, socketClosed: socketClosed.promise, destroy: () => response.destroy() };
    events.push(entry);
    response.once('close', () => closed.resolve({ complete: response.writableFinished }));
    request.socket.once('close', () => socketClosed.resolve());
    for (const waiter of [...waiters]) if (waiter.matches(entry)) { waiters.delete(waiter); waiter.resolve(entry); }
    if (request.method !== 'GET') { response.writeHead(405); response.end('GET only'); return; }
    const name = new URL(request.url, 'http://127.0.0.1').pathname;
    if (name === '/headers-hold') return;
    if (name === '/redirect') { response.writeHead(302, { Location: '/bytes?redirected=%2f+%252F' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (name === '/denied' || name === '/missing') {
      response.writeHead(name === '/denied' ? 403 : 404); response.end(name === '/denied' ? 'source denied body' : 'source missing body'); return;
    }
    if (name === '/multi') { response.writeHead(418); response.end(request.headers.range + '|' + request.headers['if-range']); return; }
    if (name === '/gzip') {
      const compressed = gzipSync(bytes);
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); response.end(compressed); return;
    }
    if (name === '/chunked') { response.write(bytes.subarray(0, 3)); response.end(bytes.subarray(3)); return; }
    if (name === '/slow' || name === '/truncated') {
      response.writeHead(200, { 'Content-Length': bytes.length }); response.write(bytes.subarray(0, 3)); return;
    }
    response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('ETag', '"http-source"');
    const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '');
    if (name !== '/ignore-range' && range && (!request.headers['if-range'] || request.headers['if-range'] === '"http-source"')) {
      const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start >= bytes.length || end < start) { response.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length }); response.end('outside'); return; }
      const body = bytes.subarray(start, end + 1);
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': body.length }); response.end(body); return;
    }
    response.setHeader('Content-Length', bytes.length); response.end(bytes);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`, events, bytes,
    observe(matches) {
      const existing = events.find(matches);
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.add({ matches, resolve }));
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

export async function readStorageHandle(handle) {
  const chunks = [];
  try { for await (const chunk of handle.stream) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await handle.close(); }
}
