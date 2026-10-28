export const StorageErrorCode = Object.freeze({
  NOT_FOUND: 'not-found', NOT_DIRECTORY: 'not-directory', IS_DIRECTORY: 'is-directory',
  PERMISSION_DENIED: 'permission-denied', AUTHENTICATION_REQUIRED: 'authentication-required',
  VERSION_CHANGED: 'version-changed', RATE_LIMITED: 'rate-limited', TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable', NOT_SUPPORTED: 'not-supported', CANCELLED: 'cancelled',
  INVALID_PATH: 'invalid-path', INVALID_RESPONSE: 'invalid-response',
  INCOMPLETE_LISTING: 'incomplete-listing', RANGE_NOT_SATISFIABLE: 'range-not-satisfiable',
  ALREADY_EXISTS: 'already-exists', CLOSED: 'closed',
});

export class StorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new StorageError('cancelled', 'Storage operation was cancelled.'), { cause: signal.reason });
}

export function requireCapability(adapter, capability) {
  if (!adapter.capabilities?.[capability]) {
    throw new StorageError('not-supported', `Storage does not support ${capability}.`);
  }
}
