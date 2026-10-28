import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

const sockets = new Set(), requests = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proxyTarget = filename => {
  const normalized = filename.replaceAll('\\', '/'), escaped = normalized.split('/').map(encodeURIComponent).join('/');
  return '/d' + (escaped.startsWith('/') ? escaped : '/' + escaped);
};
const targets = new Map(workerData.map(file => [file.http ? new URL(file.identity).pathname : proxyTarget(file.filename), file]));
const server = http.createServer(async (request, response) => {
  const file = targets.get(request.url), receipt = { target: request.url, method: request.method,
    status: file?.sourceStatus ?? (file ? 200 : 404) };
  requests.push(receipt);
  try {
    const bytes = file ? await readFile(file.filename) : Buffer.from('Private lyric input was not found.');
    receipt.sha256 = hash(bytes); receipt.contentType = file?.contentType ?? 'text/plain';
    response.writeHead(receipt.status, { 'Content-Type': receipt.contentType, 'Content-Length': bytes.length, Connection: 'close' });
    response.end(bytes);
  } catch (error) { receipt.error = { name: error?.name, message: error?.message, code: error?.code }; response.destroy(error); }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
server.listen(5244, '127.0.0.1'); await once(server, 'listening');
parentPort.postMessage({ type: 'ready' });
parentPort.once('message', async message => {
  if (message !== 'close') throw new Error('Unknown lyric source control message.');
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  parentPort.postMessage({ type: 'closed', requests }); parentPort.close();
});
