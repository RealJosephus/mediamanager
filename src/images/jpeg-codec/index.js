import { Worker } from 'node:worker_threads';

const failed = message => Object.assign(new Error(message), { code: 'invalid-image' });
function jpegScaleNumerator(scale) {
  for (let numerator = 8; numerator >= 2; numerator--) if (scale >= (numerator - 0.5) / 8) return numerator;
  return 1;
}

export async function decodeJpegScaled(bytes, scale, { signal } = {}) {
  signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw failed('JPEG decoding requires nonempty image bytes.');
  const numerator = jpegScaleNumerator(scale), input = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { trackUnmanagedFds: true });
  return new Promise((resolve, reject) => {
    let finishing = false;
    const finish = async (error, result) => {
      if (finishing) return;
      finishing = true;
      signal?.removeEventListener('abort', abort);
      try { await worker.terminate(); }
      catch (failure) { error ??= failure; }
      if (signal?.aborted) error ??= signal.reason;
      if (error) reject(error);
      else resolve({ data: Buffer.from(result.pixels), info: { width: result.width, height: result.height, channels: 4 } });
    };
    const abort = () => { finish(signal.reason).catch(reject); };
    worker.once('message', ({ error, ...result }) => {
      finish(error ? failed(error.message) : null, result).catch(reject);
    });
    worker.once('error', error => { finish(error).catch(reject); });
    worker.once('exit', () => { finish(failed('The JPEG decoder stopped before returning its pixels.')).catch(reject); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try { worker.postMessage({ bytes: input, numerator }, [input.buffer]); }
      catch (error) { finish(error).catch(reject); }
    }
  });
}
