import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

function endpointFor(identity) {
  const digest = createHash('sha256').update(identity).digest('hex');
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\mediamanager-operation-${digest}` };
  if (process.platform === 'linux') return { path: `\0mediamanager-operation-${digest}` };
  const bytes = Buffer.from(digest, 'hex');
  return {
    // macOS exposes 127.0.0.1 without requiring additional loopback aliases.
    // The finite TCP port space fails closed if an unrelated owner collides.
    host: '127.0.0.1',
    port: 20_000 + bytes.readUInt16BE(3) % 40_000,
    exclusive: true
  };
}

/**
 * Acquire an OS-owned exclusive lease. Named pipes, abstract Unix sockets and
 * listening TCP sockets are released by the kernel if the process is killed,
 * so no stale filesystem lock can outlive its owner.
 */
export async function acquireOperationLease(identity, { label = 'Operation' } = {}) {
  if (typeof identity !== 'string' || !identity || identity.includes('\0')) {
    throw new TypeError('Operation lease identity must be a nonempty string without NUL characters');
  }
  if (typeof label !== 'string' || !label) throw new TypeError('Operation lease label must be a nonempty string');
  const server = createServer({ pauseOnConnect: true }, socket => socket.destroy());
  const endpoint = endpointFor(identity);
  await new Promise((resolve, reject) => {
    const listening = () => { server.off('error', failed); resolve(); };
    const failed = (error) => {
      server.off('listening', listening);
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) {
        reject(new Error(`${label} is already active`, { cause: error }));
      } else reject(error);
    };
    server.once('listening', listening);
    server.once('error', failed);
    server.listen(endpoint);
  });

  // Avoid an unhandled process error while retaining the lease fail-closed:
  // the endpoint remains bound until release or process termination.
  let runtimeFailure;
  const runtimeError = error => { runtimeFailure = error; };
  server.on('error', runtimeError);
  let releasePromise;
  return Object.freeze({
    identity,
    assertHeld() {
      if (runtimeFailure || !server.listening) {
        throw new Error(`${label} lease is no longer held`, { cause: runtimeFailure });
      }
    },
    release() {
      if (!releasePromise) releasePromise = new Promise((resolve, reject) => {
        server.off('error', runtimeError);
        server.close(error => error ? reject(error) : resolve());
      });
      return releasePromise;
    }
  });
}
