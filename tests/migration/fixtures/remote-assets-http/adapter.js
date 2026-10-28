import { StorageError, checkAbort } from '../../../../src/storage/errors.js';
import { storageCapabilityNames } from '../../../../src/storage/registry.js';

/** A fixture SDK adapter for the independently owned conditional HTTP service. */
export class ConditionalHttpAdapter {
  #closed = false;
  #closing;
  #pending = new Set();
  #handles = new Set();
  #controller = new AbortController();
  constructor(origin) {
    this.origin = origin;
    this.capabilities = Object.freeze(Object.fromEntries(storageCapabilityNames.map(name => [name,
      ['reliableLength', 'reliableVersion', 'create', 'replace', 'atomicReplace', 'conditionalWrite'].includes(name)])));
  }
  #run(operation) {
    if (this.#closed) return Promise.reject(new StorageError('closed', 'The conditional HTTP adapter is closed.'));
    const pending = Promise.resolve().then(operation); this.#pending.add(pending);
    pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
  #signal(signal) { return signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal; }
  async #fetch(filename, options) {
    const response = await fetch(this.origin + filename.split('/').map(encodeURIComponent).join('/'), options);
    if (response.ok) return response;
    await response.body?.cancel();
    throw new StorageError(response.status === 404 ? 'not-found' : response.status === 412 ? 'version-changed' : 'unavailable',
      'The conditional HTTP object request failed.', { httpStatus: response.status });
  }
  health({ signal } = {}) { return this.#run(() => { checkAbort(signal); return { state: 'available' }; }); }
  listPage() { return Promise.reject(new StorageError('not-supported', 'The fixture does not advertise directory enumeration.')); }
  stat(filename, { signal } = {}) {
    return this.#run(async () => {
      const response = await this.#fetch(filename, { method: 'HEAD', signal: this.#signal(signal) });
      return { kind: 'file', name: filename.split('/').at(-1), size: BigInt(response.headers.get('content-length')),
        modified: null, created: null, version: response.headers.get('etag') };
    });
  }
  openRead(filename, { ifMatch, signal } = {}) {
    return this.#run(async () => {
      const response = await this.#fetch(filename, { signal: this.#signal(signal), headers: ifMatch ? { 'If-Match': ifMatch } : {} });
      const iterator = response.body[Symbol.asyncIterator]();
      let closing;
      const close = () => closing ??= Promise.resolve().then(() => iterator.return()).finally(() => this.#handles.delete(close));
      this.#handles.add(close);
      return { stream: { [Symbol.asyncIterator]: () => iterator }, version: response.headers.get('etag'),
        contentLength: BigInt(response.headers.get('content-length')), close };
    });
  }
  write(filename, data, { overwrite, ifMatch, size, atomic, signal } = {}) {
    return this.#run(async () => {
      if (!(data instanceof Uint8Array) || BigInt(data.length) !== BigInt(size) || atomic !== true) {
        throw new TypeError('The fixture writer requires explicitly bounded atomic bytes.');
      }
      if (overwrite !== false && typeof ifMatch !== 'string') throw new TypeError('An explicit write precondition is required.');
      const response = await this.#fetch(filename, { method: 'PUT', body: data, signal: this.#signal(signal),
        headers: overwrite === false ? { 'If-None-Match': '*' } : { 'If-Match': ifMatch } });
      const receipt = await response.json();
      return { ...receipt, size: BigInt(receipt.size) };
    });
  }
  close() {
    this.#closed = true;
    return this.#closing ??= (async () => {
      this.#controller.abort(new StorageError('closed', 'The conditional HTTP adapter is closing.'));
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled([...this.#handles].map(close => close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Conditional HTTP readers failed to close.', { cause: failures[0] });
    })();
  }
}
