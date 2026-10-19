import { StorageError, checkAbort } from './errors.js';

const requiredMethods = ['stat', 'listPage', 'openRead', 'health', 'close'];
const operationCapabilities = Object.freeze({ create: 'write', replace: 'write', mkdir: 'mkdir', delete: 'delete', rename: 'rename' });
export const storageCapabilityNames = Object.freeze([
  'randomRead', 'reliableLength', 'reliableVersion', 'directorySnapshot',
  'create', 'replace', 'mkdir', 'delete', 'rename', 'atomicReplace', 'conditionalWrite', 'directLease'
]);

function validateAdapter(instance) {
  if (requiredMethods.some(method => typeof instance?.[method] !== 'function')) {
    throw new TypeError('The storage adapter does not implement the required contract.');
  }
  const capabilities = instance.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
    || !Object.isFrozen(capabilities)
    || Object.keys(capabilities).length !== storageCapabilityNames.length
    || Object.keys(capabilities).some(name => !storageCapabilityNames.includes(name))) {
    throw new TypeError('The storage adapter must expose the complete frozen capability contract.');
  }
  for (const name of storageCapabilityNames) {
    const value = capabilities[name];
    if (name === 'randomRead' ? ![true, false, 'conditional'].includes(value) : typeof value !== 'boolean') {
      throw new TypeError(`The storage adapter capability ${name} is invalid.`);
    }
  }
  for (const [capability, method] of Object.entries(operationCapabilities)) {
    if (capabilities[capability] && typeof instance[method] !== 'function') {
      throw new TypeError(`The storage adapter capability ${capability} requires ${method}().`);
    }
  }
  if (capabilities.atomicReplace && !capabilities.replace) {
    throw new TypeError('The storage adapter cannot declare atomicReplace without replace.');
  }
}

export class StorageRegistry {
  #types = new Map();
  #instances = new Map();
  #instanceTypes = new Map();
  #failures = new Map();
  #pending = new Map();
  #closed = false;
  #closing;

  registerType(type, factory) {
    if (this.#closed) throw new StorageError('closed', 'The storage registry is closed.');
    if (typeof type !== 'string' || !type || typeof factory !== 'function') throw new TypeError('A type and factory are required.');
    if (this.#types.has(type)) throw new StorageError('already-exists', 'The storage type is already registered.');
    this.#types.set(type, factory);
  }

  hasInstance(id) { return this.#instances.has(id); }

  async unregisterType(type) {
    this.#types.delete(type);
    await Promise.allSettled([...this.#pending.values()].filter(value => value.type === type).map(value => value.done.promise));
    const instances = [];
    for (const [id, owner] of this.#instanceTypes) if (owner === type) {
      const instance = this.#instances.get(id); if (instance) instances.push(instance);
      this.#instances.delete(id); this.#instanceTypes.delete(id);
      this.#failures.delete(id);
    }
    const results = await Promise.allSettled(instances.map(instance => instance.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Storage instances failed to close.');
  }

  async createInstance(id, type, config, context = {}) {
    if (this.#closed) throw new StorageError('closed', 'The storage registry is closed.');
    if (typeof id !== 'string' || !id) throw new TypeError('An instance ID is required.');
    if (this.#instances.has(id) || this.#pending.has(id)) throw new StorageError('already-exists', 'The storage instance already exists.');
    const factory = this.#types.get(type);
    if (!factory) throw new StorageError('not-supported', 'The storage type is not registered.');
    checkAbort(context.signal);
    const done = Promise.withResolvers();
    this.#pending.set(id, { type, done });
    let instance;
    try {
      instance = await factory(config, context);
      validateAdapter(instance);
      checkAbort(context.signal);
      if (this.#closed) throw new StorageError('closed', 'The storage registry closed during initialization.');
      if (this.#types.get(type) !== factory) throw new StorageError('not-supported', 'The storage type was removed during initialization.');
      this.#instances.set(id, instance);
      this.#failures.delete(id);
      this.#instanceTypes.set(id, type);
      return instance;
    } catch (error) {
      if (instance?.close) await instance.close();
      if (!this.#closed && this.#types.get(type) === factory) { this.#failures.set(id,error); this.#instanceTypes.set(id,type); }
      throw error;
    } finally {
      this.#pending.delete(id);
      done.resolve();
    }
  }

  getInstance(id) {
    if (this.#closed) throw new StorageError('closed', 'The storage registry is closed.');
    if (this.#failures.has(id)) throw this.#failures.get(id);
    const instance = this.#instances.get(id);
    if (!instance) throw new StorageError('not-supported', 'The storage plugin or instance is unavailable.');
    return instance;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = (async () => {
    await Promise.allSettled([...this.#pending.values()].map(value => value.done.promise));
    const results = await Promise.allSettled([...this.#instances.values()].map((instance) => instance.close()));
    this.#instances.clear();
    this.#instanceTypes.clear();
    this.#failures.clear();
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Some storage instances failed to close.');
    })();
  }
}
