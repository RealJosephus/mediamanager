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
import { newNativeItemEntity } from './native-item-entity.js';
import { updateLiveItemRepository } from './live-item-repository.js';
import { queryPostgresItemPage } from '../database/postgres-item-query.js';
import { quoteIdentifier } from '../database/model.js';
import { ownStorageDirectories } from '../storage/ownership.js';

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
const classifiedPathFailure = (error, codes) => {
  try { return !Array.isArray(error?.errors) && codes.includes(error?.code); }
  catch { return false; }
};

async function withCollectionCleanup(operation, cleanups) {
  const errors = [];
  let result;
  try { result = await operation(); } catch (error) { errors.push(error); }
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    const primary = errors[0];
    let message = 'Collection operation cleanup failed.';
    try { if (typeof primary?.message === 'string') message = primary.message; } catch { /* Preserve the original reason. */ }
    const failure = new AggregateError(errors, message, { cause: primary });
    for (const name of ['code', 'status', 'statusCode']) {
      try { if (primary != null && Object.hasOwn(primary, name)) failure[name] = primary[name]; }
      catch { /* Diagnostic access cannot replace the original reason. */ }
    }
    throw failure;
  }
  return result;
}

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
      || typeof host.withCachedChildren !== 'function'
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
    return this.#enqueue(() => withCollectionCleanup(() => operation(admission), [() => admission.release()]));
  }

  #stateRoot(filename) {
    const stateRoot = [this.programDataPath, this.dataPath].find(root => inside(root, filename));
    if (!path.isAbsolute(filename) || !stateRoot) {
      throw libraryError(501, 'Managed collections must remain inside the isolated instance.');
    }
    return stateRoot;
  }

  #ownStatePath(filename) {
    const stateRoot = this.#stateRoot(filename), identities = [stateRoot];
    // Identity prefixes can select unrelated access namespaces. Retain every
    // checked path's actual mount, including missing mkdir ancestors, without
    // turning those paths into new protected mount roots.
    for (let ancestor = filename; path.relative(stateRoot, ancestor) !== ''; ancestor = path.dirname(ancestor)) identities.push(ancestor);
    return ownStorageDirectories(this.fileSystem, identities, { requiredCapabilities: [], preserveMountRoots: true });
  }

  async #statePath(filename, fileSystem = this.fileSystem) {
    const stateRoot = this.#stateRoot(filename);
    let root;
    try { root = await fileSystem.realpath(stateRoot); }
    catch (error) { if (!classifiedPathFailure(error, ['ENOENT'])) throw error; }
    let ancestor = filename;
    while (true) {
      try {
        const actual = await fileSystem.realpath(ancestor);
        if (!root || !inside(root, actual)) throw libraryError(501, 'Managed collections traverse an external link or junction.');
        return filename;
      } catch (error) {
        if (!classifiedPathFailure(error, ['ENOENT', 'ENOTDIR'])) throw error;
        try {
          await fileSystem.lstat(ancestor);
          throw libraryError(501, 'Managed collections traverse an unresolved link or reparse point.');
        } catch (linkError) { if (!classifiedPathFailure(linkError, ['ENOENT', 'ENOTDIR'])) throw linkError; }
        if (ancestor === stateRoot) return filename;
        ancestor = path.dirname(ancestor);
      }
    }
  }

  async #findFolder() {
    const root = await this.host.getAggregateFolder();
    return this.host.withCachedChildren(root, children => children.firstContainingPath(this.collectionsPath));
  }

  async #collectionsFolder(createIfNeeded, admission) {
    const existing = await this.#findFolder();
    if (existing || !createIfNeeded) return existing;
    const files = this.#ownStatePath(this.collectionsPath);
    await withCollectionCleanup(async () => {
      await files.fileSystem.mkdir(await this.#statePath(this.collectionsPath, files.fileSystem), { recursive: true });
      await this.#statePath(this.collectionsPath, files.fileSystem);
    }, [() => files.close()]);
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
    return withCollectionCleanup(async () => {
      const filename = path.join(parent.Path, folderName);
      // Directory checks, creation and CreateItems' metadata context observe
      // one admitted storage generation. Later member/queue stages commit
      // independently and must capture their own current storage access.
      const files = this.#ownStatePath(filename);
      let itemOwner, item, monitorBegan = false;
      return withCollectionCleanup(async () => {
        await withCollectionCleanup(async () => {
          await withCollectionCleanup(async () => {
            await this.#statePath(filename, files.fileSystem);
            await this.monitor.reportFileSystemChangeBeginning?.(filename);
            monitorBegan = true;
            await files.fileSystem.mkdir(filename, { recursive: true });
            await this.#statePath(filename, files.fileSystem);
            const info = await files.fileSystem.stat(filename, { bigint: true });
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
            const paths = this.loadContext.capturePathScope?.({ fileSystem: files.fileSystem });
            await this.itemCreation.createItems([item], parent, { paths });
          }, [() => files.close()]);
          await this.store.run(session => attachEmptyCollectionLinks(this, item, session));
          const ids = options.ItemIdList === undefined ? [] : options.ItemIdList;
          if (ids.length) await this.#add(item.Id, creationItemIds(ids), false,
            { ...defaultRefresh(), MetadataRefreshMode: 'FullRefresh' });
          else this.#queue(item, defaultRefresh());
          this.emit('CollectionCreated', { Collection: item, Options: options });
        }, [() => monitorBegan ? this.monitor.reportFileSystemChangeComplete?.(filename, false) : undefined]);
        // The controller projects after the native monitor completion, while
        // the exact created instance still owns its current live relation.
        return consume ? await consume(item) : item;
      }, [() => itemOwner?.release(), () => this.store.run(session => this.linkedChildren.flushReleases({ session }))]);
    }, [() => parentOwner.release(), () => this.store.run(session => this.linkedChildren.flushReleases({ session }))]);
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
