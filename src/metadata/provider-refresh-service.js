import { EventEmitter } from 'node:events';
import { idKey } from '../library/records.js';

function itemKey(item) {
  const key = idKey(item?.Id);
  if (!key) throw new TypeError('A provider refresh item with an Id is required.');
  return key;
}

export class ProviderRefreshService extends EventEmitter {
  #active = new Map();

  constructor({ onError = () => {} } = {}) {
    super();
    this.onError = onError;
  }

  #report(error) {
    try { this.onError(error); } catch { /* Refresh observers and error reporting cannot break a refresh. */ }
  }

  #notify(name, event) {
    try { this.emit(name, event); }
    catch (error) { this.#report(error); }
  }

  reportStarted(item) {
    const key = itemKey(item);
    this.#active.set(key, 0);
    this.#notify('RefreshStarted', { Item: item });
  }

  reportProgress(item, progress) {
    if (typeof progress !== 'number') throw new TypeError('Provider refresh progress must be a number.');
    const key = itemKey(item);
    const current = this.#active.get(key);
    if (current === undefined || progress <= current) return false;
    this.#active.set(key, progress);
    this.#notify('RefreshProgress', { Item: item, Progress: progress });
    return true;
  }

  reportCompleted(item) {
    this.#active.delete(itemKey(item));
    this.#notify('RefreshCompleted', { Item: item });
  }

  getRefreshProgress(id) {
    const key = idKey(id);
    return this.#active.has(key) ? this.#active.get(key) : null;
  }
  snapshot() { return new Map(this.#active); }
}
