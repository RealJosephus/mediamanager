import path from 'node:path';
import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import model from './resources/live-tv-configuration-model.json' with { type: 'json' };
import { createConfigurationReader } from './configuration-xml.js';
import { assertPhysicalStatePath, createConfigurationWriter, readConfigurationFile } from './configuration-file.js';

export const liveTvConfigurationReader = createConfigurationReader(model);
export const serializeLiveTvConfiguration = createConfigurationWriter(model);

export class LiveTvConfigurationStore extends EventEmitter {
  #configurations = new Map();
  #tail = Promise.resolve();
  #closed = false;
  #closing;
  #saveObserver;
  #consumerWork = new Set();
  #operationWork = new Set();
  constructor({ configurationDirectoryPath, fileSystem = fs, onError = () => {} } = {}) {
    super();
    Object.assign(this, { configurationDirectoryPath, fileSystem, onError });
  }

  #filename(key) {
    if (typeof key !== 'string' || key.toLowerCase() !== 'livetv') throw new TypeError('Unknown Live TV configuration key.');
    return this.configurationDirectoryPath && path.join(this.configurationDirectoryPath, 'livetv.xml');
  }

  async #readConfiguration(key) {
    const filename = this.#filename(key);
    const defaults = () => liveTvConfigurationReader.defaultConfiguration('livetv');
    if (!filename) return defaults();
    try {
      await assertPhysicalStatePath(filename, this.fileSystem);
      if (!(await this.fileSystem.stat(filename)).isFile()) return defaults();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return defaults();
      throw error;
    }
    try { return await readConfigurationFile(filename, 'livetv', { fileSystem: this.fileSystem, reader: liveTvConfigurationReader }); }
    catch (error) {
      if (error.code && !['EACCES', 'EPERM'].includes(error.code)) throw error;
      this.onError(error);
      return defaults();
    }
  }

  #unavailable(scope) {
    return scope ? !scope.active || scope.reservation?.active === false : this.#closed;
  }

  #closedError() {
    return Object.assign(new Error('Live TV configuration is closing.'), { status: 503 });
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Observer failures cannot undo a saved configuration. */ }
  }

  // A multi-step reader keeps its admission while waiting for mapped storage,
  // but each configuration lookup still observes the current named cache.
  admitRead() {
    if (this.#closed) throw this.#closedError();
    const completion = Promise.withResolvers(), scope = { active: true };
    this.#operationWork.add(completion.promise);
    return Object.freeze({
      getConfiguration: (key = 'livetv') => this.#getConfiguration(key, scope),
      release: () => {
        if (!scope.active) return;
        scope.active = false;
        this.#operationWork.delete(completion.promise);
        completion.resolve();
      },
    });
  }

  // Source validation can await a provider before it saves. Reserve the save
  // observer's dependencies now, while admitting only actual saves as updates.
  admitMutation() {
    if (this.#closed) throw this.#closedError();
    const observer = this.#saveObserver?.active ? this.#saveObserver : null;
    const reserved = observer ? this.#reserveObserver(observer) : null;
    if (observer && !reserved) throw this.#closedError();
    const scope = reserved ?? { active: true, observer: null };
    const completion = Promise.withResolvers();
    this.#operationWork.add(completion.promise);
    return Object.freeze({
      getConfiguration: (key = 'livetv') => this.#getConfiguration(key, scope),
      saveConfiguration: (configuration, key = 'livetv') => this.#saveConfiguration(configuration, key, scope),
      release: () => {
        if (!scope.active) return;
        scope.active = false;
        if (reserved) this.#completeObserver(reserved, false);
        this.#operationWork.delete(completion.promise);
        completion.resolve();
      },
    });
  }

  // The observer reserves its dependencies in the caller's admission stack,
  // independently of the native updating/updated notification contract.
  bindSaveObserver(reserve) {
    if (this.#closed) throw this.#closedError();
    if (this.#saveObserver || typeof reserve !== 'function') throw new TypeError('A single configuration save observer is required.');
    const binding = { active: true, reserve };
    this.#saveObserver = binding;
    return Object.freeze({
      enqueue: () => {
        if (this.#closed || !binding.active) return Promise.reject(this.#closedError());
        const scope = this.#reserveObserver(binding);
        if (!scope) return Promise.resolve();
        this.#completeObserver(scope, true);
        return scope.reservation.completion;
      },
      close: () => { binding.active = false; },
    });
  }

  #reserveObserver(binding, parent) {
    let reservation;
    try { reservation = binding.reserve(parent?.reservation); }
    catch (error) { this.#report(error); return null; }
    const scope = { active: true, observer: binding, reservation };
    scope.access = Object.freeze({
      getConfiguration: (key = 'livetv') => this.#getConfiguration(key, scope),
      saveConfiguration: (configuration, key = 'livetv') => this.#saveConfiguration(configuration, key, scope),
    });
    this.#consumerWork.add(reservation.completion);
    const finished = () => { scope.active = false; this.#consumerWork.delete(reservation.completion); };
    reservation.completion.then(finished, finished);
    return scope;
  }

  #completeObserver(scope, saved) {
    if (!scope) return;
    try { if (saved) scope.reservation.commit(scope.access); else scope.reservation.cancel(); }
    catch (error) { this.#report(error); scope.reservation.cancel(); }
  }

  getConfiguration(key = 'livetv') { return this.#getConfiguration(key); }

  #getConfiguration(key, scope) {
    if (this.#unavailable(scope)) return Promise.reject(this.#closedError());
    if (this.#configurations.has(key)) return this.#configurations.get(key);
    const operation = this.#tail.then(() => this.#readConfiguration(key)).catch(error => {
      if (this.#configurations.get(key) === operation) this.#configurations.delete(key);
      throw error;
    });
    this.#tail = operation.catch(() => {});
    this.#configurations.set(key, operation);
    return operation;
  }

  saveConfiguration(configuration, key = 'livetv') { return this.#saveConfiguration(configuration, key); }

  #saveConfiguration(configuration, key, scope) {
    if (this.#unavailable(scope)) return Promise.reject(this.#closedError());
    const binding = scope ? scope.observer : this.#saveObserver?.active ? this.#saveObserver : null;
    const consumer = binding ? this.#reserveObserver(binding, scope) : null;
    const operation = this.#tail.then(async () => {
      let saved = false;
      try {
        const filename = this.#filename(key);
        this.emit('updating', { key, configuration });
        this.#configurations.set(key, Promise.resolve(configuration));
        if (!filename) throw Object.assign(new Error('Native configuration storage is unavailable.'), { status: 501 });
        await assertPhysicalStatePath(filename, this.fileSystem);
        await this.fileSystem.mkdir(path.dirname(filename), { recursive: true });
        await assertPhysicalStatePath(filename, this.fileSystem);
        let info;
        try { info = await this.fileSystem.stat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (process.platform === 'win32' && info?.isFile() && !(info.mode & 0o222)) {
          throw Object.assign(new Error('Native configuration is read-only.'), { code: 'EACCES' });
        }
        // Native FileMode.Create truncates before serialization. A serialization
        // or write failure keeps both the new live object and the file prefix.
        const file = await this.fileSystem.open(filename, 'w');
        try { await file.writeFile(serializeLiveTvConfiguration('livetv', configuration)); }
        finally { await file.close(); }
        saved = true;
        this.emit('updated', { key, configuration });
      } finally { this.#completeObserver(consumer, saved); }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  close() {
    this.#closed = true;
    return this.#closing ??= this.#drain();
  }

  async #drain() {
    while (true) {
      const tail = this.#tail;
      await tail;
      await Promise.allSettled([...this.#consumerWork]);
      await Promise.all([...this.#operationWork]);
      if (tail === this.#tail && this.#consumerWork.size === 0 && this.#operationWork.size === 0) return;
    }
  }
}
