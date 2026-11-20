import { captureMediaProcess } from './process.js';

const listings = {
  encoders: /^\s*[VAS][A-Z.]{5}\s+([\w-]+)\s/mgu,
  decoders: /^\s*[VAS][A-Z.]{5}\s+([\w-]+)\s/mgu,
  filters: /^\s*[T.][S.][C.]\s+([\w-]+)\s/mgu,
  bsfs: /^([\w-]+)\r?$/mgu,
  hwaccels: /^([\w-]+)\r?$/mgu,
};

export async function discoverMediaCapabilities(executable, { signal, environment, onCleanupError, onError }) {
  const result = await Promise.allSettled(Object.entries(listings).map(async ([kind, pattern]) => {
    try {
      const { stdout } = await captureMediaProcess(executable, ['-' + kind], {
        signal, environment, onCleanupError, timeoutMs: 15000, maxOutputBytes: 1024 * 1024,
      });
      return [kind, [...new Set(Array.from(stdout.toString('utf8').matchAll(pattern), match => match[1].toLowerCase()))]];
    } catch (error) {
      if (!signal.aborted) await onError(error);
      return [kind, []];
    }
  }));
  signal.throwIfAborted();
  const failures = result.filter(entry => entry.status === 'rejected').map(entry => entry.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Media capability discovery failed.');
  return Object.freeze(Object.fromEntries(result.map(({ value: [kind, names] }) => [kind, Object.freeze(names)])));
}
