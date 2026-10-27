import { Worker } from 'node:worker_threads';

const failed = message => Object.assign(new Error(message), { code: 'invalid-image' });
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'JPEG decoder cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
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
    const finish = async (error, result, errorPresent = true) => {
      if (finishing) return;
      finishing = true;
      signal?.removeEventListener('abort', abort);
      const errors = errorPresent ? [error] : [];
      try { await worker.terminate(); }
      catch (failure) { errors.push(failure); }
      if (signal?.aborted && !errorPresent) errors.unshift(signal.reason);
      if (errors.length) reject(operationFailure(errors));
      else resolve({ data: Buffer.from(result.pixels), info: { width: result.width, height: result.height, channels: 4 } });
    };
    const abort = () => { finish(signal.reason).catch(reject); };
    worker.once('message', ({ error, ...result }) => {
      finish(error ? failed(error.message) : undefined, result, Boolean(error)).catch(reject);
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
