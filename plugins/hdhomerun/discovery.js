import dgram from 'node:dgram';

export const discoveryPacket = Buffer.from([0, 2, 0, 12, 1, 4, 255, 255, 255, 255, 2, 4, 255, 255, 255, 255, 115, 204, 125, 143]);
const cancelled = error => error?.code === 'ABORT_ERR' || ['AbortError', 'TimeoutError'].includes(error?.name);
async function closeSocket(socket) {
  await new Promise((resolve, reject) => {
    try { socket.close(resolve); } catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error); }
  });
}

/** The native discover payload deliberately checks only count and byte 1.
 * Packet identity/CRC fields are not device identities or deduplication keys. */
export async function discoverDevices(duration, { signal, getDevice, onError, createSocket = options => dgram.createSocket(options),
  address = '255.255.255.255', port = 65001 } = {}) {
  if (!Number.isInteger(duration) || duration < -1 || duration > 2147483647) throw new RangeError('Invalid discovery duration.');
  const socket = createSocket({ type: 'udp4', reuseAddr: true }), queued = []; let waiting, socketError;
  const deadline = new AbortController(), combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = duration === -1 ? undefined : setTimeout(() => deadline.abort(), duration); timer?.unref?.();
  const received = (bytes, remote) => {
    const value = { bytes: bytes.subarray(0, 8192), address: remote.address };
    if (waiting) { waiting.resolve(value); waiting = null; }
    else queued.push(value);
  };
  const failed = error => { socketError = error; waiting?.reject(error); waiting = null; };
  const aborted = () => { waiting?.reject(combined.reason); waiting = null; };
  socket.on('message', received); socket.on('error', failed); combined.addEventListener('abort', aborted);
  try {
    // Native socket factory/bind failures escape its discovery try/catch.
    await new Promise((resolve, reject) => {
      const error = cause => { socket.removeListener('listening', ready); reject(cause); };
      const ready = () => { socket.removeListener('error', error); resolve(); };
      socket.once('error', error); socket.once('listening', ready); socket.bind(0, '0.0.0.0');
    });
    socket.setBroadcast(true);
    const result = [];
    try {
      combined.throwIfAborted();
      await new Promise((resolve, reject) => {
        const abort = () => reject(combined.reason); combined.addEventListener('abort', abort, { once: true });
        const done = error => { combined.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        try { socket.send(discoveryPacket, port, address, done); } catch (error) { done(error); }
      });
      while (!combined.aborted) {
        if (socketError) throw socketError;
        const packet = queued.shift() ?? await (waiting = Promise.withResolvers()).promise;
        if (packet.bytes.length > 13 && packet.bytes[1] === 3) {
          const info = await getDevice('http://' + packet.address, combined);
          if (info !== null) result.push(info);
        }
      }
    } catch (error) { if (!combined.aborted && !cancelled(error)) onError(error); }
    return result;
  } finally {
    clearTimeout(timer); combined.removeEventListener('abort', aborted);
    socket.removeListener('message', received);
    try { await closeSocket(socket); } finally { socket.removeListener('error', failed); }
  }
}
