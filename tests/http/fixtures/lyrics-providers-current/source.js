import http from 'node:http';
import { once } from 'node:events';

export async function lyricProviderSource(bytes) {
  const sockets = new Set(), gates = new Map(), receipts = [];
  const gate = name => {
    if (!gates.has(name)) gates.set(name, { entered: Promise.withResolvers(), released: Promise.withResolvers(), closed: Promise.withResolvers() });
    return gates.get(name);
  };
  const server = http.createServer(async (request, response) => {
    const name = request.url.slice(1), selected = gate(name), receipt = { name, method: request.method, bodyWritten: false, closed: false };
    receipts.push(receipt);
    response.once('close', () => { receipt.closed = true; receipt.completed = response.writableFinished; selected.closed.resolve(receipt); });
    response.on('error', () => {});
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': bytes.length });
    response.flushHeaders(); selected.entered.resolve(receipt);
    const write = await Promise.race([selected.released.promise.then(() => true), selected.closed.promise.then(() => false)]);
    if (write) { response.end(bytes); receipt.bodyWritten = true; }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: 'http://127.0.0.1:' + server.address().port, receipts, gate,
    async close() {
      for (const value of gates.values()) value.released.resolve();
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    } };
}
