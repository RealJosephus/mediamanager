import { attachEmptyCollectionLinks, addCollectionMembers, removeCollectionMembers } from './postgres-collection-mutation.js';
import { CollectionEventScope } from './collection-event-items.js';
import { nativeTextBytes } from '../database/native-text.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { defaultLibraryOptions } from './options.js';
import { nativeDateFromUnixNanoseconds, nativeGuid } from '../users/native.js';
import { libraryError, mapRecord } from './records.js';
import { nativeItemDescriptor, newNativeItemEntity } from './native-item-entity.js';
import { updateLiveItemRepository } from './live-item-repository.js';
import { nativeContainsSubPath } from './native-path.js';
import { nativeFileSystemPathsEqual } from './root-folder-file-data.js';
import { queryPostgresItemPage } from '../database/postgres-item-query.js';
import { quoteIdentifier } from '../database/model.js';

const boxSetType = 'MediaBrowser.Controller.Entities.Movies.BoxSet';
const defaultRefresh = () => ({ MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true });
function* creationItemIds(ids) {
  for (const value of ids) {
    try { yield nativeGuid(value); }
    catch (error) {
      if (error.status !== 400) throw error;
      throw libraryError(500, 'Invalid collection member identifier.');
    }
  }
}
const inside = (root, value) => {
  const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(value));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Collection mutations retain their live entity and the native side-effect
 * order. Queries only select the requested IDs or a single physical root. */
export class CollectionService extends EventEmitter {
  #tail = Promise.resolve();
  #closed = false;
  #postScanOperations = new Map();
  #closing;

  constructor({ store, library, itemCreation, loadContext, updates, metadata, host, libraryConfiguration,
    monitor = {}, programDataPath, dataPath, localization, fileSystem = library?.options.fileSystem,
    linkedChildren, updateRepository, findByPath, onError = () => {} } = {}) {
    super();
    if (!store || !library || !itemCreation || typeof loadContext !== 'function' || typeof loadContext.withContext !== 'function' || !updates || !metadata || !host
      || typeof host.getCachedChildrenPage !== 'function'
      || typeof libraryConfiguration?.admitOperation !== 'function'
      || typeof itemCreation.retainItem !== 'function' || typeof itemCreation.withItem !== 'function'
      || ['createFromSession', 'plan', 'recordResolution', 'retain', 'page', 'release', 'flushReleases']
        .some(name => typeof linkedChildren?.[name] !== 'function')
      || !path.isAbsolute(programDataPath ?? '') || !path.isAbsolute(dataPath ?? '')) {
      throw new TypeError('Collection management requires live persistence, metadata, library configuration and absolute instance paths.');
    }
    Object.assign(this, { store, library, itemCreation, loadContext, updates, metadata, host, libraryConfiguration,
      monitor, localization, fileSystem, linkedChildren, onError });
    this.eventScope = new CollectionEventScope();
    this.programDataPath = path.resolve(programDataPath);
    this.dataPath = path.resolve(dataPath);
    this.collectionsPath = path.join(this.dataPath, 'collections');
    this.updateRepository = updateRepository ?? (item => updateLiveItemRepository(item,
      { loadContext, itemCreation, updates, includeChildren: false, updateReason: ItemUpdateType.MetadataEdit }));
    this.findByPath = findByPath ?? (identity => this.store.run(async db => {
      const stored = this.library.options?.reversePath?.(identity) ?? identity;
      const rows = (await queryPostgresItemPage(db,
        { sortby: ['DateCreated'], sortorder: ['Descending'], limit: 1, enabletotalrecordcount: false },
        { groupByPresentationKey: false, itemIdsPlan: {
          text: `SELECT "Id" FROM ${quoteIdentifier(db.schemaName)}."BaseItems" WHERE "Path" = $1`, values: [nativeTextBytes(stored)]
        } })).rows;
      const item = rows.length ? mapRecord(rows[0]) : null;
      if (item) item.Path = this.library.options?.expandPath?.(item.Path) ?? item.Path;
      return item;
    }, { readOnly: true }));
  }

  #enqueue(operation, lease) {
    if (this.#closed && !this.#postScanOperations.has(lease)) return Promise.reject(libraryError(503, 'Collection management is closing.'));
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #enqueueWithConfiguration(operation) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Collection management is closing.'));
    let admission;
    try { admission = this.libraryConfiguration.admitOperation(); }
    catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      try { return await operation(admission); }
      finally { admission.release(); }
    });
  }

  async #statePath(filename) {
    const stateRoot = [this.programDataPath, this.dataPath].find(root => inside(root, filename));
    if (!path.isAbsolute(filename) || !stateRoot) {
      throw libraryError(501, 'Managed collections must remain inside the isolated instance.');
    }
    let root;
    try { root = await this.fileSystem.realpath(stateRoot); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let ancestor = filename;
    while (true) {
      try {
        const actual = await this.fileSystem.realpath(ancestor);
        if (!root || !inside(root, actual)) throw libraryError(501, 'Managed collections traverse an external link or junction.');
        return filename;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        try {
          await this.fileSystem.lstat(ancestor);
          throw libraryError(501, 'Managed collections traverse an unresolved link or reparse point.');
        } catch (linkError) { if (!['ENOENT', 'ENOTDIR'].includes(linkError.code)) throw linkError; }
        if (ancestor === stateRoot) return filename;
        ancestor = path.dirname(ancestor);
      }
    }
  }

  async #findFolder() {
    const root = await this.host.getAggregateFolder();
    for (let startIndex = 0; ; startIndex += 128) {
      const { items: children, hasMore } = await this.host.getCachedChildrenPage(root, { startIndex, limit: 128 });
      const existing = children.find(item => nativeItemDescriptor(item.NativeType).family === 'folder' && (nativeFileSystemPathsEqual(this.collectionsPath, item.Path)
        || nativeContainsSubPath(this.collectionsPath, item.Path)));
      if (existing) return await this.itemCreation.getItemById(existing.Id) ?? existing;
      if (!hasMore) return null;
    }
  }

  async #collectionsFolder(createIfNeeded, admission) {
    const existing = await this.#findFolder();
    if (existing || !createIfNeeded) return existing;
    await this.fileSystem.mkdir(await this.#statePath(this.collectionsPath), { recursive: true });
    await this.#statePath(this.collectionsPath);
    const options = { ...defaultLibraryOptions(), PathInfos: [{ Path: this.collectionsPath }],
      EnableRealtimeMonitor: false, SaveLocalMetadata: true };
    const name = this.localization?.text('Collections', { culture: this.localization.serverCulture }) ?? 'Collections';
    await admission.addVirtualFolder(name, 'boxsets', options, true);
    this.host.invalidateChildren(await this.host.getAggregateFolder());
    return this.#findFolder();
  }

  getCollectionsFolder(createIfNeeded = false) {
    return createIfNeeded ? this.#enqueueWithConfiguration(admission => this.#collectionsFolder(true, admission))
      : this.#enqueue(() => this.#collectionsFolder(false));
  }

  #queue(item, options) {
    // Admit the refresh immediately, but let the enclosing collection mutation
    // finish before its background worker captures a repository baseline.
    const ready = Promise.all([this.#tail, this.store.currentOperationCompletion()]);
    const queued = this.metadata.queue(item.Id, options, 0, { ready });
    queued?.catch?.(error => { try { this.onError(error); } catch { /* Reporting cannot change a completed mutation. */ } });
  }

  create(options = {}) { return this.#enqueueWithConfiguration(admission => this.#create(options, admission)); }

  withCreatedItem(options, consume) {
    if (typeof consume !== 'function') throw new TypeError('Collection creation requires an item consumer.');
    return this.#enqueueWithConfiguration(admission => this.#create(options, admission, consume));
  }

  async #create(options, admission, consume) {
    const name = options.Name;
    if (typeof name !== 'string') throw libraryError(500, 'A collection name is required.');
    const folderName = name.replace(/["<>|\x00-\x1f:*?\\/]/gu, ' ') + ' [boxset]';
    const parent = await this.#collectionsFolder(true, admission);
    if (!parent) throw libraryError(500, 'Unable to resolve the collections library folder, so the collection cannot be created.');
    const parentOwner = this.itemCreation.retainItem(parent);
    try {
    const filename = path.join(parent.Path, folderName);
    await this.#statePath(filename);
    await this.monitor.reportFileSystemChangeBeginning?.(filename);
    let itemOwner, item;
    try {
    try {
      await this.fileSystem.mkdir(filename, { recursive: true });
      await this.#statePath(filename);
      const info = await this.fileSystem.stat(filename, { bigint: true });
      item = newNativeItemEntity(boxSetType);
      itemOwner = this.itemCreation.retainItem(item);
      item.Name = name; item.Path = filename; item.IsLocked = options.IsLocked === true;
      item.ProviderIds = options.ProviderIds === undefined ? {} : options.ProviderIds;
      item.DateCreated = nativeDateFromUnixNanoseconds(info.birthtimeNs);
      item.DateModified = nativeDateFromUnixNanoseconds(info.mtimeNs);
      item.ParentId = parent.Id;
      item.Id = nativeGuid(getNewItemId(filename, boxSetType, {
        programDataPath: this.programDataPath,
        enableCaseSensitiveItemIds: this.library.options?.configuration?.EnableCaseSensitiveItemIds
      }));
      await this.itemCreation.createItems([item], parent);
      await this.store.run(session => attachEmptyCollectionLinks(this, item, session));
      const ids = options.ItemIdList === undefined ? [] : options.ItemIdList;
      if (ids.length) await this.#add(item.Id, creationItemIds(ids), false,
        { ...defaultRefresh(), MetadataRefreshMode: 'FullRefresh' });
      else this.#queue(item, defaultRefresh());
      this.emit('CollectionCreated', { Collection: item, Options: options });
    } finally { await this.monitor.reportFileSystemChangeComplete?.(filename, false); }
      // The controller projects after the native monitor completion, while
      // the exact created instance still owns its current live relation.
      return consume ? await consume(item) : item;
    } finally {
      itemOwner?.release();
      await this.store.run(session => this.linkedChildren.flushReleases({ session }));
    }
    } finally {
      parentOwner.release();
      await this.store.run(session => this.linkedChildren.flushReleases({ session }));
    }
  }

  #withCollection(id, action, operation) {
    return this.itemCreation.withItem(nativeGuid(id), collection => {
      if (collection?.Type !== 'BoxSet') throw libraryError(400, action === 'add'
        ? `No collection exists with the supplied collectionId ${id}` : 'No collection exists with the supplied Id');
      return operation(collection);
    });
  }

  add(id, ids) { return this.#enqueue(() => this.#add(id, ids, true, defaultRefresh())); }

  async #add(id, ids, fireEvent, options) {
    return this.#withCollection(id, 'add', collection =>
      addCollectionMembers(this, collection, { ids, fireEvent, refreshOptions: options }));
  }

  queueCollection(item, options) { this.#queue(item, options); }

  admitPostScanOperation() {
    if (this.#closed) throw libraryError(503, 'Collection management is closing.');
    const configurationAdmission = this.libraryConfiguration.admitOperation();
    const completion = Promise.withResolvers();
    const entry = { released: false, pending: 0, completion: completion.promise };
    const finish = () => {
      if (!entry.released || entry.pending) return;
      this.#postScanOperations.delete(lease);
      configurationAdmission.release(); completion.resolve();
    };
    const enqueue = operation => {
      if (entry.released) return Promise.reject(libraryError(503, 'Collection post-scan admission is released.'));
      entry.pending++;
      return this.#enqueue(operation, lease).finally(() => { entry.pending--; finish(); });
    };
    const lease = Object.freeze({
      create: options => enqueue(() => this.#create(options, configurationAdmission)),
      addFromQuery: (id, query) => enqueue(() => this.#withCollection(id, 'add', collection =>
        addCollectionMembers(this, collection, { query, refreshOptions: defaultRefresh() }))),
      release: () => { entry.released = true; finish(); }
    });
    this.#postScanOperations.set(lease, entry);
    return lease;
  }

  remove(id, ids) { return this.#enqueue(() => this.#withCollection(id, 'remove', collection =>
    removeCollectionMembers(this, collection, ids, defaultRefresh()))); }

  drainForItem() { return this.#tail; }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      while (this.#postScanOperations.size) await Promise.all([...this.#postScanOperations.values()].map(value => value.completion));
      await this.#tail;
      await this.eventScope.drain();
    })();
    return this.#closing;
  }
}
