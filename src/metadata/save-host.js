import { ItemUpdateType, saveMetadata } from './save-manager.js';

export class MetadataSaveHost {
  #source;
  #pending = new Set();
  #eventTail = Promise.resolve();

  constructor({ registry, loadContext, logger = { error() {} }, monitor, now }) {
    if (!registry || typeof loadContext !== 'function') throw new TypeError('MetadataSaveHost requires a registry and authoritative context loader.');
    Object.assign(this, { registry, loadContext, logger, monitor, now });
    this.onUserDataSaved = (event) => {
      const operation = this.#eventTail.then(() => this.#dispatch(event)).catch((error) => logger.error(error, 'Error dispatching metadata user data event'));
      this.#eventTail = operation;
      this.#pending.add(operation);
      void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    };
  }

  async #load(item) {
    const loaded = await this.loadContext(item);
    if (!loaded?.item || !loaded.context || !loaded.libraryOptions || typeof loaded.exists !== 'function') {
      throw new TypeError('The metadata context loader must return item, context, libraryOptions, and exists.');
    }
    return loaded;
  }

  async #saveLoaded(loaded, updateType, saverNames) {
    const value = typeof updateType === 'string' ? ItemUpdateType[updateType] : updateType;
    if (!Number.isInteger(value)) throw new TypeError('A native metadata update reason is required.');
    const providers = this.registry.plugins().filter((plugin) => plugin.enabled !== false).flatMap((plugin) => plugin.providers)
      .filter((provider) => provider.kind === 'saver' && provider.itemTypes.includes(loaded.item.Type)
        && (saverNames == null || saverNames.some((name) => name.toLowerCase() === provider.name.toLowerCase())));
    return saveMetadata(loaded.item, value, providers, { ...loaded, logger: this.logger, monitor: this.monitor, now: this.now });
  }

  save(item, updateType, saverNames) {
    const operation = Promise.resolve().then(async () => {
      const loaded = await this.#load(item);
      try { return await this.#saveLoaded(loaded, updateType, saverNames); }
      finally { await loaded.dispose?.(); }
    });
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }

  async #dispatch(event) {
    const plugins = this.registry.plugins().filter((plugin) => plugin.enabled !== false && typeof plugin.onUserDataSaved === 'function'
      && (!plugin.shouldHandleUserDataSaved || plugin.shouldHandleUserDataSaved(event)));
    if (!plugins.length) return;
    const loaded = await this.#load(event.Item);
    try {
      for (const plugin of plugins) await plugin.onUserDataSaved({ ...event, Item: loaded.item },
        (_item, updateType, names) => this.#saveLoaded(loaded, updateType, names));
    } finally { await loaded.dispose?.(); }
  }

  start(userDataManager) {
    if (this.#source === userDataManager) return;
    if (this.#source) throw new Error('The metadata saver host is already subscribed to another source.');
    if (typeof userDataManager?.on !== 'function' || typeof userDataManager?.off !== 'function') throw new TypeError('A user data event source is required.');
    this.#source = userDataManager;
    userDataManager.on('UserDataSaved', this.onUserDataSaved);
  }

  stop() {
    this.#source?.off('UserDataSaved', this.onUserDataSaved);
    this.#source = undefined;
  }

  async drain() {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  async dispose() { this.stop(); await this.drain(); }
}
