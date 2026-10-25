import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { parseLosslessJson } from '../../../../src/core/json.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const errorRecord = error => ({ name: error.name, code: error.code, message: error.message, stack: error.stack });

export async function within(promise, description, milliseconds = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + description + '.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function until(read, matches, description, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + description + '.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// The input is a one-second PCM WAV, written in memory without an encoder.
// Its .ts URL selects the official M3U original-HTTP branch; real ffprobe
// identifies the bytes rather than relying on that extension or MIME.
export function originalWave() {
  const samples = 8000, result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) result.writeInt16LE((index * 37 % 2000) - 1000, 44 + index * 2);
  return result;
}

export async function originalServer(bytes) {
  const records = [], held = new Map(), prefixLength = 1024, middleEnd = 4096;
  let mode = 'finite';
  const server = createServer((request, response) => {
    const record = { id: records.length + 1, method: request.method, path: request.url, mode, bytesWritten: 0, closed: false, finished: false };
    records.push(record);
    response.once('finish', () => { record.finished = true; });
    response.once('close', () => { record.closed = true; held.delete(record.id); });
    if (request.method !== 'GET' || request.url !== '/original.ts') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'audio/wav');
    if (mode === 'finite') {
      response.setHeader('Content-Length', bytes.length); record.bytesWritten = bytes.length; response.end(bytes);
    } else {
      held.set(record.id, { response, record });
      response.write(bytes.subarray(0, prefixLength)); record.bytesWritten = prefixLength;
    }
  });
  await within(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'owned original HTTP listen');
  return {
    records, prefixLength, middleEnd, origin: 'http://127.0.0.1:' + server.address().port,
    hold() { mode = 'held'; },
    async write(id, from, to) {
      const state = held.get(id); assert.ok(state && !state.response.destroyed, 'The selected original HTTP input must still be owned.');
      assert.equal(state.record.bytesWritten, from, 'Controlled input chunks remain contiguous.');
      const bytesReady = state.response.write(bytes.subarray(from, to)); state.record.bytesWritten = to;
      if (!bytesReady) await within(new Promise((resolve, reject) => {
        const drain = () => { cleanup(); resolve(); }, close = () => { cleanup(); reject(new Error('The original input closed before drain.')); };
        const cleanup = () => { state.response.off('drain', drain); state.response.off('close', close); };
        state.response.once('drain', drain); state.response.once('close', close);
      }), 'original HTTP drain');
    },
    async close() { server.closeAllConnections(); await within(new Promise(resolve => server.close(resolve)), 'original HTTP close'); },
  };
}

export function rawReader(url, label) {
  const chunks = [], record = { label, url: new URL(url).pathname, events: [], received: 0, cancelled: false, complete: false };
  const ready = Promise.withResolvers(), closed = Promise.withResolvers();
  let incoming;
  const request = get(url, { agent: false }, response => {
    incoming = response; record.status = response.statusCode; record.contentType = response.headers['content-type'];
    record.contentLength = response.headers['content-length'] ?? null; record.contentRange = response.headers['content-range'] ?? null;
    record.events.push('response'); ready.resolve(record);
    response.on('data', value => { chunks.push(Buffer.from(value)); record.received += value.length; });
    response.on('end', () => { record.complete = response.complete; record.events.push('end'); });
    response.on('aborted', () => record.events.push('aborted'));
    response.on('error', error => { record.events.push('response-error'); record.responseError = errorRecord(error); });
    response.on('close', () => { record.events.push('response-close'); closed.resolve(record); });
  });
  request.on('error', error => {
    record.requestError = errorRecord(error); record.events.push('request-error');
    if (!incoming) { ready.resolve(record); closed.resolve(record); }
  });
  request.once('close', () => {
    record.events.push('request-close');
    if (!incoming) { ready.resolve(record); closed.resolve(record); }
  });
  return {
    record, ready: ready.promise, closed: closed.promise,
    bytes() { return Buffer.concat(chunks); },
    async waitBytes(count) {
      return until(() => record, value => {
        if (value.events.includes('response-close') && value.received < count) throw new Error(label + ' closed after ' + value.received + ', before ' + count + ' original bytes.');
        if (value.requestError && !incoming) throw new Error(label + ' failed before an HTTP response: ' + value.requestError.message);
        return value.received >= count;
      }, label + ' original bytes');
    },
    async cancel() { record.cancelled = true; request.destroy(); incoming?.destroy(); return within(closed.promise, label + ' cancellation'); },
    destroy() { request.destroy(); incoming?.destroy(); },
  };
}

export async function socketClient(origin, token, label) {
  const socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/socket?ApiKey=' + token);
  const messages = [], record = { label, messages, errors: [], closed: false }, closed = Promise.withResolvers();
  socket.on('message', value => {
    try {
      const message = parseLosslessJson(value.toString()); messages.push(message);
      if (message.MessageType === 'ForceKeepAlive' && socket.readyState === WebSocket.OPEN) socket.send('{"MessageType":"KeepAlive"}');
    } catch (error) { record.errors.push(errorRecord(error)); socket.terminate(); }
  });
  socket.on('error', error => record.errors.push(errorRecord(error)));
  socket.on('close', (code, reason) => { record.closed = true; record.closeCode = code; record.closeReason = reason.toString(); closed.resolve(record); });
  const client = {
    socket, record, closed: closed.promise,
    async message(type, matches = () => true) {
      return until(() => messages, entries => {
        const found = entries.some(entry => entry.MessageType === type && matches(entry));
        if (!found && record.closed) throw new Error(label + ' closed before ' + type + '.');
        return found;
      }, label + ' ' + type)
        .then(entries => entries.findLast(entry => entry.MessageType === type && matches(entry)));
    },
    async barrier() {
      const start = messages.length; socket.send('{"MessageType":"KeepAlive"}');
      return until(() => messages.slice(start), entries => entries.some(entry => entry.MessageType === 'KeepAlive'), label + ' KeepAlive barrier');
    },
    async close() { socket.close(1000); return within(closed.promise, label + ' WebSocket close'); },
    terminate() { socket.terminate(); },
  };
  try {
    await within(new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), label + ' WebSocket open');
    await client.message('ForceKeepAlive'); await client.barrier(); return client;
  } catch (error) {
    socket.terminate(); await within(closed.promise, label + ' failed WebSocket cleanup'); throw error;
  }
}
