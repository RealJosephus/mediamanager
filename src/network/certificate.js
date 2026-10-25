import * as fs from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { clrTrim } from '../metadata/whitespace.js';

const blank = value => value == null || clrTrim(value) === '';

function cancelledFailure(reason, error) {
  if (error === reason || (error?.code === 'ABORT_ERR' && error.cause === reason)) return reason;
  const failure = new AggregateError([reason, error], 'Certificate loading was cancelled after a file operation failed.', { cause: reason });
  for (const key of ['code', 'status', 'statusCode']) if (reason?.[key] !== undefined) failure[key] = reason[key];
  return failure;
}

export async function loadServerCertificate({ filename, password, fileSystem = fs, signal, onError } = {}) {
  signal?.throwIfAborted();
  if (blank(filename)) return null;
  let phase = 'stat';
  try {
    let stat;
    try { stat = await fileSystem.stat(filename); }
    catch (error) {
      if (!signal?.aborted && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      throw error;
    }
    signal?.throwIfAborted();
    if (!stat.isFile()) return null;
    phase = 'read';
    const pfx = await fileSystem.readFile(filename, { signal });
    signal?.throwIfAborted();
    const options = { pfx, ...(blank(password) ? {} : { passphrase: password }) };
    phase = 'parse';
    createSecureContext(options);
    signal?.throwIfAborted();
    return options;
  } catch (original) {
    const cancelled = signal?.aborted === true;
    const error = cancelled ? cancelledFailure(signal.reason, original) : original;
    try { await onError?.(error, { filename, phase, cancelled, original }); }
    catch (reportingError) {
      throw new AggregateError([error, reportingError], 'Certificate loading and error reporting failed.', { cause: error });
    }
    if (cancelled) throw error;
    signal?.throwIfAborted();
    return null;
  }
}
