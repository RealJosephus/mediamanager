import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createConnection, isIPv4 } from 'node:net';
import { crc32 } from 'node:zlib';

const port = 65001;
const rtpHeaderBytes = 12;
const unavailable = message => Object.assign(new Error(message), { status: 409 });

function controlRequest(tuner, name, value, lock) {
  const text = (tag, text) => {
    const bytes = Buffer.from(text + '\0');
    return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
  };
  const fields = [text(3, `/tuner${tuner}/${name}`)];
  if (value !== undefined) fields.push(text(4, value));
  if (lock !== undefined) {
    const key = Buffer.from([21, 4, 0, 0, 0, 0]);
    key.writeUInt32BE(lock, 2);
    fields.push(key);
  }
  const body = Buffer.concat(fields), packet = Buffer.alloc(body.length + 8);
  packet.writeUInt16BE(4); packet.writeUInt16BE(body.length, 2); body.copy(packet, 4);
  packet.writeUInt32LE(crc32(packet.subarray(0, -4)), packet.length - 4);
  return packet;
}

function controlValue(packet) {
  if (packet.readUInt16BE() !== 5 || packet.readUInt32LE(packet.length - 4) !== crc32(packet.subarray(0, -4))) return null;
  const nameEnd = 6 + packet[5];
  if (packet[4] !== 3 || packet[nameEnd] !== 4) return null;
  const end = nameEnd + 2 + packet[nameEnd + 1];
  if (end > packet.length - 4 || packet[end - 1] !== 0) return null;
  return packet.toString('utf8', nameEnd + 2, end - 1);
}

/** Tune a configured legacy HDHomeRun through its TCP control protocol and
 * hand the received transport bytes to the same retained input as HTTP tuners. */
export async function openLegacyStream(deviceUrl, channelUrl, numTuners, signal) {
  const host = new URL(deviceUrl).hostname;
  if (!isIPv4(host)) throw unavailable('Legacy HDHomeRun requires an IPv4 device address.');
  const channel = /\/ch(\d+)-?(\d*)/u.exec(channelUrl);
  const commands = [['channel', channel?.[1]], ['program', channel?.[2]]].filter(([, value]) => value);
  const tcp = createConnection({ host, port });
  tcp.on('error', () => {});
  const udp = createSocket('udp4');
  const key = randomInt(1, 0x80000000);
  let tuner, reading, pending = Buffer.alloc(0), udpOpened = false, closeWork, deadline;
  const udpClosed = Promise.withResolvers();
  udp.once('close', udpClosed.resolve);
  const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const exchange = async (index, name, value, lock, active) => {
    active.throwIfAborted();
    const abort = () => tcp.destroy();
    active.addEventListener('abort', abort, { once: true });
    try {
      await new Promise((resolve, reject) => tcp.write(controlRequest(index, name, value, lock), error => error ? reject(error) : resolve()));
      while (pending.length < 4 || pending.length < pending.readUInt16BE(2) + 8) {
        const next = await reading.next();
        active.throwIfAborted();
        if (next.done) throw unavailable('The HDHomeRun control connection ended.');
        pending = Buffer.concat([pending, next.value]);
      }
      const length = pending.readUInt16BE(2) + 8, packet = pending.subarray(0, length);
      pending = pending.subarray(length);
      return controlValue(packet);
    } finally { active.removeEventListener('abort', abort); }
  };
  const release = async () => {
    if (tuner === undefined || tcp.destroyed) return;
    const active = AbortSignal.timeout(5000);
    try { await exchange(tuner, 'target', 'none', key, active); }
    finally {
      try { await exchange(tuner, 'lockkey', 'none', key, active); }
      finally { tuner = undefined; }
    }
  };
  const close = () => closeWork ??= (async () => {
    clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
    if (udpOpened) udp.close();
    try { await release(); }
    finally {
      tcp.destroy();
      if (udpOpened) await udpClosed.promise;
    }
  })();
  let stream;
  const end = error => {
    try { stream?.error(error); } catch { /* The reader already closed. */ }
    void close().catch(() => {});
  };
  const onAbort = () => end(signal.reason);
  udp.on('error', error => { if (udpOpened) end(error); });
  const timeout = () => end(Object.assign(new Error('The HDHomeRun sent no RTP data.'), { name: 'TimeoutError' }));
  try {
    await once(tcp, 'connect', { signal: connectSignal });
    reading = tcp[Symbol.asyncIterator]();
    const listening = once(udp, 'listening');
    udp.bind(0, '0.0.0.0');
    await listening;
    udpOpened = true;
    const body = new ReadableStream({
      start(controller) { stream = controller; },
      cancel: close,
    }, { highWaterMark: 16 * 1024 * 1024, size: chunk => chunk.length });
    udp.on('message', (packet, remote) => {
      if (remote.address !== host || packet.length <= rtpHeaderBytes || closeWork) return;
      if (stream.desiredSize <= 0) { end(unavailable('The HDHomeRun RTP reader fell behind.')); return; }
      clearTimeout(deadline); deadline = setTimeout(timeout, 30000).unref();
      stream.enqueue(packet.subarray(rtpHeaderBytes));
    });
    for (let index = 0; index < numTuners; index++) {
      if ((await exchange(index, 'lockkey', undefined, undefined, connectSignal))?.toLowerCase() !== 'none') continue;
      if (await exchange(index, 'lockkey', String(key), undefined, connectSignal) === null) continue;
      tuner = index;
      let tuned = true;
      for (const [name, value] of commands) {
        if (await exchange(index, name, value, key, connectSignal) === null) { tuned = false; break; }
      }
      const target = `rtp://${tcp.localAddress}:${udp.address().port}`;
      if (tuned && await exchange(index, 'target', target, key, connectSignal) !== null) {
        signal.addEventListener('abort', onAbort, { once: true });
        signal.throwIfAborted();
        if (!deadline) deadline = setTimeout(timeout, 30000).unref();
        return new Response(body, { headers: { 'Content-Type': 'video/mp2t' } });
      }
      await release();
    }
    throw unavailable('No HDHomeRun tuners are available.');
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
