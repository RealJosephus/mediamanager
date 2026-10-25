import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import model from './resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration, readConfigurationDocument } from './configuration-xml.js';
import { writeConfigurationFile } from './configuration-file.js';
import { ServerConfigurationPaths } from './server-configuration-paths.js';
import { configurationVersionAliases } from './configuration-version.js';

const serverFields = Object.keys(model.definitions.ServerConfiguration.defaults);
const startupFields = new Set(['ServerName', 'UICulture', 'MetadataCountryCode', 'PreferredMetadataLanguage', 'IsStartupWizardCompleted']);
const closed = () => Object.assign(new Error('Server configuration persistence is closing.'), { code: 'closed', status: 503 });

export class ServerConfigurationStore extends EventEmitter {
  #closed = false;
  #tail = Promise.resolve();
  #initialization;
  #events = new Set();
  #operations = new Set();
  #activity = new AsyncLocalStorage();
  #closing;

  constructor({ configuration, configurationDirectoryPath, applicationPaths, metadataFileSystem, fileSystem = fs, onError = () => {} }) {
    super();
    if (!configuration || !path.isAbsolute(configurationDirectoryPath ?? '') || !applicationPaths
      || !path.isAbsolute(applicationPaths.programDataPath ?? '') || !path.isAbsolute(applicationPaths.defaultMetadataPath ?? '')) {
      throw new TypeError('Server configuration persistence requires configuration, shared application paths and an absolute configuration directory.');
    }
    configurationVersionAliases(configuration);
    const defaults = defaultConfiguration('server');
    for (const name of serverFields) if (!Object.hasOwn(configuration, name)) configuration[name] = defaults[name];
    Object.assign(this, { configuration, applicationPaths, fileSystem, onError, directory: path.resolve(configurationDirectoryPath) });
    this.filename = path.join(this.directory, 'system.xml');
    this.paths = new ServerConfigurationPaths({ applicationPaths, metadataFileSystem, fileSystem });
  }

  initialize() {
    return this.#initialization ??= this.#enqueue(async () => {
      await this.paths.updateCache(this.configuration);
      await this.paths.updateMetadata(this.configuration);
    }, false).catch(error => { this.#initialization = undefined; throw error; });
  }

  replaceConfiguration(value) {
    return this.#enqueue(async () => {
      if (!value) throw new TypeError('A server configuration is required.');
      configurationVersionAliases(value);
      await this.paths.validateMetadata(this.configuration, value);
      this.#updating(value);
      await this.paths.validateCache(this.configuration, value);
      this.configuration = value;
      await this.#saveServer();
    });
  }

  saveConfiguration() { return this.#enqueue(() => this.#saveServer()); }

  updateContentTypes(transform) {
    return this.#enqueue(async () => {
      this.configuration.ContentTypes = transform(structuredClone(this.configuration.ContentTypes ?? []));
      await this.#saveServer();
    });
  }

  updateServerValues(values) {
    if (Object.keys(values).some(name => !startupFields.has(name))) throw new TypeError('Unsupported server configuration field.');
    return this.#enqueue(async () => {
      Object.assign(this.configuration, values);
      await this.#saveServer();
    });
  }

  #enqueue(work, initialized = true) {
    const permission = this.#activity.getStore();
    const internal = permission?.active === true, inline = internal && permission.inline;
    if (this.#closed && !internal) return Promise.reject(closed());
    if (initialized && !this.#initialization) return Promise.reject(new Error('Server configuration persistence must be initialized before use.'));
    const initialization = this.#initialization;
    const operation = inline ? this.#run(work) : this.#tail.then(async () => {
      if (initialized) await initialization;
      return this.#run(work);
    });
    if (!inline) this.#tail = operation.catch(() => {});
    this.#operations.add(operation);
    void operation.then(() => this.#operations.delete(operation), () => this.#operations.delete(operation));
    return operation;
  }

  #run(work, inline = true) {
    const permission = { active: true, inline };
    return this.#activity.run(permission, () => {
      try {
        const value = work();
        if (value == null || typeof value.then !== 'function') {
          permission.active = false; return Promise.resolve(value);
        }
        return Promise.resolve(value).finally(() => { permission.active = false; });
      } catch (error) { permission.active = false; return Promise.reject(error); }
    });
  }

  #updating(value) {
    for (const handler of this.rawListeners('updating')) {
      const permission = { active: true, inline: true };
      this.#activity.run(permission, () => {
        try { handler.call(this, value); }
        finally { permission.active = false; }
      });
    }
  }

  async #saveServer() {
    await this.#save('system.xml', 'server', this.configuration);
    await this.paths.updateMetadata(this.configuration);
    await this.paths.updateCache(this.configuration);
    this.#updated();
  }

  async #save(name, root, value) {
    const filename = path.join(this.directory, name);
    await this.fileSystem.mkdir(this.directory, { recursive: true });
    let source;
    try { source = readConfigurationDocument(await this.fileSystem.readFile(filename), root).node; }
    catch { /* A missing, unreadable or invalid old document does not prevent a new save. */ }
    await writeConfigurationFile(filename, root, value, { fileSystem: this.fileSystem, source });
  }

  #updated() {
    const handlers = this.rawListeners('updated');
    if (!handlers.length) return;
    const task = new Promise(resolve => setImmediate(resolve)).then(async () => {
      // Queued handlers do not own the serialization tail. Their accepted
      // saves enter it normally, including while external admission is closed.
      for (const handler of handlers) await this.#run(() => handler.call(this), false);
    }).catch(async error => { try { await this.onError(error); } catch { /* Error reporting must not invalidate a completed save. */ } });
    this.#events.add(task);
    void task.finally(() => this.#events.delete(task));
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => {
      for (;;) {
        await this.#tail;
        const pending = [...this.#operations, ...this.#events];
        if (!pending.length) return;
        await Promise.allSettled(pending);
      }
    })();
  }
}
