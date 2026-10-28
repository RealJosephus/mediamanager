import http from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';

const hash = value => createHash('sha256').update(value).digest('hex');
const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };

/** Real input server for Node consumers of the independent Native recording. */
export function createSubtitleHttpSource(samples, origin = 'http://127.0.0.1:5244') {
  const receipts = [], sockets = new Set(), drains = new Map(), lifecycle = [];
  let server, gate;
  const source = {
    origin, receipts, lifecycle,
    get online() { return Boolean(server); },
    setGate(value) { gate = value; },
    async write(sample, revision) {
      const changed = revision === 'changed';
      await writeFile(sample.filename, Buffer.from(sample.source[changed ? 'changedBase64' : 'base64'], 'base64'));
      sample.changed = changed;
    },
    async start() {
      if (server) return;
      const owned = http.createServer(async (request, response) => {
        const target = request.url, matching = [...samples.values()].find(sample => decoded(sample.definition.sourceTarget) === decoded(target));
        const redirected = [...samples.values()].find(sample => '/redirected/' + sample.definition.name + sample.source.extension === target);
        const sample = matching ?? redirected;
        if (!sample || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end(); return; }
        const closed = Promise.withResolvers(), socketClosed = Promise.withResolvers(), drained = Promise.withResolvers();
        const receipt = { caseName: sample.definition.name, method: request.method, target, headers: { ...request.headers },
          mode: sample.mode, bodyWritten: 0, finished: false, responseClosed: false, socketClosed: false };
        receipts.push(receipt); drains.set(receipt, Promise.all([drained.promise, closed.promise, socketClosed.promise]));
        response.once('close', () => { receipt.responseClosed = true; receipt.responseCompleted = response.writableFinished; closed.resolve(); });
        request.socket.once('close', () => { receipt.socketClosed = true; socketClosed.resolve(); });
        response.on('error', error => { receipt.responseError = { name: error.name, message: error.message, code: error.code }; });
        try {
          if (!redirected && sample.mode === 'redirect') {
            response.writeHead(302, { Location: '/redirected/' + sample.definition.name + sample.source.extension, 'Content-Length': 0 }); response.end(); return;
          }
          const failed = ['403', '404'].includes(sample.mode);
          let bytes = failed ? Buffer.from('Owned HTTP ' + sample.mode + ' response.\r\n') : await readFile(sample.filename);
          response.statusCode = failed ? Number(sample.mode) : 200;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Accept-Ranges', 'bytes');
          response.setHeader('ETag', sample.changed ? '"owned-changed"' : '"owned-original"');
          response.setHeader('Last-Modified', sample.changed ? 'Fri, 03 Jan 2025 03:04:05 GMT' : 'Thu, 02 Jan 2025 03:04:05 GMT');
          let first = 0, last = bytes.length - 1;
          const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? '');
          if (!failed && sample.mode !== 'ignore-range' && range && (!request.headers['if-range'] || request.headers['if-range'] === response.getHeader('ETag'))) {
            first = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
            last = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
            if (first >= bytes.length || last < first) { response.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length, 'Content-Length': 0 }); response.end(); return; }
            response.statusCode = 206; response.setHeader('Content-Range', `bytes ${first}-${last}/${bytes.length}`);
          }
          bytes = bytes.subarray(first, last + 1);
          const compressor = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[sample.mode];
          if (compressor) { bytes = compressor(bytes); response.setHeader('Content-Encoding', sample.mode); }
          receipt.responseBody = { bytes: bytes.length, base64: bytes.toString('base64'), sha256: hash(bytes) };
          if (sample.mode !== 'chunked') response.setHeader('Content-Length', bytes.length);
          receipt.first = first; receipt.last = last; receipt.servedSha256 = hash(bytes);
          if (request.method === 'HEAD') { response.end(); return; }
          const current = gate?.caseName === sample.definition.name ? gate : undefined;
          if (current && (current.stage === 'charset' || ['ffmpeg', 'controller-disconnect'].includes(current.stage) && current.ffmpegSpawned && current.bridgeRead)) {
            response.flushHeaders(); receipt.heldAt = current.stage; current.entered.resolve(receipt);
            if (current.stage !== 'controller-disconnect') { await closed.promise; return; }
            const released = await Promise.race([closed.promise.then(() => false), current.release.promise.then(() => true)]);
            if (!released) return;
          }
          if (current?.stage === 'raw-response') {
            const prefix = bytes.subarray(0, Math.min(bytes.length, current.cancelAfterBytes + 7));
            response.write(prefix); receipt.bodyWritten = prefix.length; receipt.heldAt = current.stage; current.entered.resolve(receipt);
            await closed.promise; return;
          }
          if (sample.mode === 'chunked') { const midpoint = Math.floor(bytes.length / 2); response.write(bytes.subarray(0, midpoint)); response.end(bytes.subarray(midpoint)); }
          else response.end(bytes);
          receipt.bodyWritten = bytes.length;
          await closed.promise;
        } catch (error) {
          receipt.error = { name: error.name, message: error.message, code: error.code };
          response.destroy(error);
        } finally {
          receipt.status = response.statusCode; receipt.responseHeaders = response.getHeaders(); receipt.finished = true; drained.resolve();
        }
      });
      owned.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      owned.listen(Number(new URL(origin).port), '127.0.0.1'); await once(owned, 'listening'); server = owned;
      lifecycle.push({ sourceStarted: true, origin });
    },
    async stop() {
      if (!server) return;
      const owned = server; server = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => owned.close(error => error ? reject(error) : resolve()));
      await source.drain(); lifecycle.push({ sourceStopped: true, origin });
    },
    async drain(start = 0) { await Promise.all(receipts.slice(start).map(receipt => drains.get(receipt))); },
  };
  return source;
}
