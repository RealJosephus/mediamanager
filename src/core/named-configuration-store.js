import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lowerInvariant } from './identity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { clrTrim } from '../metadata/whitespace.js';
import { defaultConfiguration, readConfigurationDocument } from './configuration-xml.js';
import { writeConfigurationFile } from './configuration-file.js';
import { networkConfigurationBaseUrl } from './network-configuration.js';

const roots = ['encoding', 'metadata', 'xbmcmetadata', 'network'];
export const namedConfigurationRoot = key => roots.find(root => ordinalIgnoreCaseEquals(root, key));
const closed = () => Object.assign(new Error('Named configuration persistence is closing.'), { code: 'closed', status: 503 });
const missing = key => Object.assign(new Error('Configuration with key ' + key + ' not found.'), { code: 'configuration-not-found', status: 404 });
const existenceFailures = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'EIO', 'ENODEV', 'ENXIO', 'ERR_INVALID_ARG_VALUE']);
const nonempty = value => value != null && clrTrim(value) !== '';
const publicIoFailure = error => {
  if (['ENOENT', 'ENOTDIR'].includes(error.code) && error.status == null && error.statusCode == null) error.status = 404;
  return error;
};

export class NamedConfigurationStore extends EventEmitter {
  #current = new Map();
  #loading = new Map();
  #tail = Promise.resolve();
  #closed = false;
  #closing;
  #operations = new Set();
  #activity = new AsyncLocalStorage();

  constructor({ configurationDirectoryPath, fileSystem = fs, onError = () => {}, loadedConfigurations = [] } = {}) {
    super();
    if (!path.isAbsolute(configurationDirectoryPath ?? '')) throw new TypeError('Named configuration persistence requires an absolute configuration directory.');
    Object.assign(this, { directory: path.resolve(configurationDirectoryPath), fileSystem, onError });
    for (const [key, value] of loadedConfigurations) {
      const root = this.#root(key);
      this.#current.set(key, root === 'network' ? networkConfigurationBaseUrl(value) : value);
    }
  }

  #root(key) {
    const root = namedConfigurationRoot(key);
    if (!root) throw missing(key);
    return root;
  }

  #filename(key) { return path.join(this.directory, lowerInvariant(key) + '.xml'); }

  #enqueue(operation) {
    const internal = this.#activity.getStore()?.active === true;
    if (this.#closed && !internal) return Promise.reject(closed());
    const work = internal ? this.#run(operation) : this.#tail.then(() => this.#run(operation));
    if (!internal) this.#tail = work.catch(() => {});
    this.#operations.add(work);
    void work.then(() => this.#operations.delete(work), () => this.#operations.delete(work));
    return work;
  }

  #run(operation) {
    const permission = { active: true };
    return this.#activity.run(permission, () => {
      try {
        const value = operation();
        if (value == null || typeof value.then !== 'function') {
          permission.active = false; return Promise.resolve(value);
        }
        return Promise.resolve(value).finally(() => { permission.active = false; });
      } catch (error) { permission.active = false; return Promise.reject(error); }
    });
  }

  #updating(event) {
    for (const handler of this.rawListeners('updating')) {
      const permission = { active: true };
      this.#activity.run(permission, () => {
        try { handler.call(this, event); }
        finally { permission.active = false; }
      });
    }
  }

  async #diagnose(error, context) {
    try { await this.onError(error, context); }
    catch (failure) { throw new AggregateError([error, failure], 'Named configuration load diagnostics failed.', { cause: error }); }
  }

  async #read(key, root) {
    const filename = this.#filename(key), defaults = () => defaultConfiguration(root);
    try { if ((await this.fileSystem.stat(filename)).isDirectory()) return defaults(); }
    catch (error) { if (existenceFailures.has(error.code)) return defaults(); throw error; }
    let bytes;
    try { bytes = await this.fileSystem.readFile(filename); }
    catch (error) {
      // A failed read after File.Exists is distinct from an absent file. Native
      // I/O failures propagate; access denial is logged before using defaults.
      if (!['EACCES', 'EPERM'].includes(error.code)) throw publicIoFailure(error);
      await this.#diagnose(error, { key, filename, phase: 'configuration-read' }); return defaults();
    }
    try { return readConfigurationDocument(bytes, root).value; }
    catch (error) { await this.#diagnose(error, { key, filename, phase: 'configuration-xml' }); return defaults(); }
  }

  async #ensureCurrent(key, root) {
    if (!this.#current.has(key)) this.#current.set(key, await this.#read(key, root));
    return this.#current.get(key);
  }

  getConfiguration(key) {
    const internal = this.#activity.getStore()?.active === true;
    if (this.#closed && !internal) return Promise.reject(closed());
    let root;
    try { root = this.#root(key); } catch (error) { return Promise.reject(error); }
    if (this.#current.has(key)) return Promise.resolve(this.#current.get(key));
    const loading = this.#loading.get(key);
    // An external cold read can be queued behind this handler's own save.
    // It cannot satisfy a reentrant read until that handler has returned.
    if (loading && (!internal || loading.internal)) return loading.work;
    const work = this.#enqueue(() => this.#ensureCurrent(key, root));
    const entry = { work, internal }; this.#loading.set(key, entry);
    const completed = () => { if (this.#loading.get(key) === entry) this.#loading.delete(key); };
    void work.then(completed, completed);
    return work;
  }

  getCurrentConfiguration(key) {
    this.#root(key);
    if (!this.#current.has(key)) throw Object.assign(new Error('Named configuration has not been loaded: ' + key), { code: 'configuration-not-loaded', status: 503 });
    return this.#current.get(key);
  }

  saveConfiguration(key, configuration) {
    return this.#enqueue(async () => {
      const root = namedConfigurationRoot(key);
      if (!root) throw Object.assign(new Error('No configuration factory is registered for ' + key + '.'), { code: 'configuration-factory-not-found' });
      if (configuration == null) throw new TypeError('A named configuration value is required.');
      if (root === 'network') networkConfigurationBaseUrl(configuration);
      if (root === 'encoding') {
        const current = await this.#ensureCurrent(key, root);
        if (nonempty(configuration.TranscodingTempPath) && configuration.TranscodingTempPath !== current.TranscodingTempPath) {
          let directory = false, failure;
          try { directory = (await this.fileSystem.stat(configuration.TranscodingTempPath)).isDirectory(); }
          catch (error) { if (!existenceFailures.has(error.code)) throw error; failure = error; }
          if (!directory) throw Object.assign(new Error(configuration.TranscodingTempPath + ' does not exist.', failure ? { cause: failure } : undefined), { code: 'ENOENT', status: 404 });
        }
        if (nonempty(configuration.EncoderAppPath) && configuration.EncoderAppPath !== current.EncoderAppPath) {
          throw Object.assign(new Error('Unable to update encoder app path.'), { code: 'encoder-path-change-not-supported' });
        }
      }
      this.#updating({ key, configuration });
      this.#current.set(key, configuration);
      const filename = this.#filename(key);
      try {
        await this.fileSystem.mkdir(this.directory, { recursive: true });
        let source;
        try { source = readConfigurationDocument(await this.fileSystem.readFile(filename), root).node; }
        catch { /* Native saving does not require an old document to be readable. */ }
        await writeConfigurationFile(filename, root, configuration, { fileSystem: this.fileSystem, source });
      } catch (error) { throw publicIoFailure(error); }
      const event = { key, configuration };
      for (const handler of this.rawListeners('updated')) await this.#run(() => handler.call(this, event));
    });
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => {
      for (;;) {
        await this.#tail;
        const pending = [...this.#operations];
        if (!pending.length) return;
        await Promise.allSettled(pending);
      }
    })();
  }
}
