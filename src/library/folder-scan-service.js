import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { StorageError } from '../storage/errors.js';
import { joinPath, parentPath } from '../storage/paths.js';
import { normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { nativeDate } from '../sessions/user-data.js';
import { nativeGuid } from '../users/native.js';
import { sortName } from './dto.js';
import { DirectoryItemResolverPipeline, folderNativeType } from './directory-item-resolver.js';
import { cleanValue, EMPTY_ID, extraTypeCode, idKey, mapRecord, nonemptyId, repositoryTopParentId, sameId, unsupported,
  VIDEO_TYPES } from './records.js';
import { compareNativePaths, nativePathKey, nativePathWithin, sameNativePath } from './native-path.js';
import { filterResolutionCandidates } from './resolution-ignore.js';
import { buildScanCollectionContext, scanCollectionContextForItem } from './scan-context.js';
import { episodeNativeType, seasonNativeType, seriesNativeType } from './tv-item-resolver.js';
import { movieNativeType, musicVideoNativeType, videoNativeType } from './video-file-resolver.js';
import { bookNativeType } from './book-photo-item-resolver.js';
import { audioBookNativeType } from './audio-book-item-resolver.js';
import { metadataScanOptions } from './metadata-scan-service.js';
import { itemRequiresJson } from './item-data.js';
import { collectionFoldersForItem, parentChainForItem } from './collection-membership.js';
import { persistItemProviderIds, persistItemRelations } from './item-relations.js';
import { prepareItemSaveTuple } from './item-save-tuple.js';
import { itemListColumn, itemListFields } from './item-list-columns.js';
import { updateFromResolvedItem } from './resolved-item-update.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { collectItemDeletionIds, deleteItemsInDatabase } from './item-persistence.js';
import { DotIgnoreRule } from './dot-ignore-rule.js';
import { setResolverProviderIdsFromPath, setResolverInitialValues } from './resolver-initial-values.js';
import { cloneNativeItemEntity, nativeItemDescriptor } from './native-item-entity.js';
import { serializeNativeItemData } from './native-item-data.js';
import { resolvedItemStructuralSnapshot as structuralSnapshot } from './resolved-item-lifecycle.js';
import { createResolvedItemEntity } from './resolved-item-entity.js';
import { setPrimaryVersion } from './live-item-repository.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { userDataKeys } from '../sessions/user-data.js';
import { reattachUserData } from '../metadata/persistence.js';
import { loadPostgresRowsByIds, loadPostgresRowsByPaths } from './postgres-library-query.js';

const folderScanWriteLocks = Object.freeze(['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'UserData']);
const folderScanLockTimeoutMs = 250;
const postgresPathOwnershipBatchSize = 256;
const folderScanContext = new AsyncLocalStorage();

export const folderScanCapabilities = Object.freeze({
  scope: 'generic-folder-tree-reconciliation',
  itemTypes: Object.freeze(['Folder']),
  entryKinds: Object.freeze(['directory']),
  structuralCompletenessProof: true,
  directStructuralRoots: true,
  completeLibraryScan: false,
  scansMediaFiles: false,
  typeReclassification: true,
  secondaryOwnershipTransfer: false,
  groupedOwnership: false,
  relationshipRows: false,
  runsMetadataProbeRefresh: false,
  resolvesProductionMediaFiles: false,
  productionMediaScopes: Object.freeze([]),
  deletionRequiresSnapshot: true
});

export const folderScanIncompleteReasonCodes = Object.freeze({
  WEAK_DIRECTORY_SNAPSHOT: 'weak-directory-snapshot',
  EMPTY_TOP_FOLDER_PROTECTED: 'empty-top-folder-protected',
  UNSAFE_DELETION_SKIPPED: 'unsafe-deletion-skipped',
  EXTERNAL_REFERENCE_DELETION_SKIPPED: 'external-reference-deletion-skipped',
  RESOLVER_PATH_WITHHELD: 'resolver-path-withheld',
  NESTED_VALIDATION_FAILED: 'nested-validation-failed',
  DELETION_SKIPPED: 'deletion-skipped'
});

const itemType = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
const pathKey = value => nativePathKey(value);
const samePath = (left, right) => sameNativePath(left, right);
const pathStyle = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value) ? 'windows' : 'posix';
const librarySource = value => value == null || value === 0 || value === 'Library';
const relationshipFields = Object.freeze(['OwnerId', 'PrimaryVersionId', 'SeriesId', 'SeasonId']);
const ownershipFields = Object.freeze(['CanDelete', 'ExtraType']);
const persistData = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint'
  ? JSON.rawJSON(entry.toString()) : entry);

const identityWithin = (value, root) => nativePathWithin(value, root);

function incompleteReason(code, item = null, reasonPath = item?.Path) {
  return {
    code,
    itemId: typeof item?.Id === 'string' ? item.Id : null,
    path: typeof reasonPath === 'string' ? reasonPath : null
  };
}

function freezeIncompleteReasons(reasons) {
  const unique = new Map();
  for (const reason of reasons) {
    const normalized = incompleteReason(reason?.code, { Id: reason?.itemId, Path: reason?.path });
    const key = JSON.stringify([normalized.code, normalized.path, normalized.itemId]);
    unique.set(key, normalized);
  }
  return Object.freeze([...unique.values()]
    .sort((left, right) => [left.code, left.path ?? '', left.itemId ?? ''].join('\0')
      .localeCompare([right.code, right.path ?? '', right.itemId ?? ''].join('\0'), 'en'))
    .map(Object.freeze));
}

function scanReceipt(result, reasons = []) {
  if (result.skippedDeletion && reasons.length === 0) {
    reasons = [incompleteReason(folderScanIncompleteReasonCodes.DELETION_SKIPPED)];
  }
  const incompleteReasons = freezeIncompleteReasons(reasons);
  return Object.freeze({
    ...result,
    structurallyComplete: incompleteReasons.length === 0,
    incompleteReasons
  });
}

function entryDate(value) {
  if (value == null) return null;
  try { return nativeDate(normalizeProbeFileDate(value)); }
  catch (cause) { throw new StorageError('invalid-response', 'A directory timestamp is invalid.', { cause }); }
}

function closedError() {
  return Object.assign(new StorageError('closed', 'The folder scanner is closed.'), { status: 503, statusCode: 503 });
}

function reentrant(owner) {
  for (let context = folderScanContext.getStore(); context; context = context.parent) {
    if (context.owner === owner && context.active === true) return true;
  }
  return false;
}

function activeParent() {
  let context = folderScanContext.getStore() ?? null;
  while (context && context.active !== true) context = context.parent;
  return context;
}

function reentrantError(operation) {
  return new StorageError('invalid-operation', `${operation} cannot wait on the folder scan operation that invoked it.`);
}

function errorField(error, key) {
  try { return error?.[key]; }
  catch { return undefined; }
}

function cancelled(error) {
  return errorField(error, 'name') === 'AbortError' || errorField(error, 'code') === 'cancelled';
}

function checkAbort(signal) {
  if (signal?.aborted) throw new StorageError('cancelled', 'Folder scan was cancelled.');
}

function directChildrenSignature(items, parentId) {
  return JSON.stringify(items.filter(item => sameId(item.ParentId, parentId)).map(item => ({
    Id: idKey(item.Id),
    ParentId: idKey(item.ParentId),
    TopParentId: idKey(repositoryTopParentId(item)),
    Type: item.NativeType ?? item.Type,
    Path: item.Path,
    IsFolder: item.IsFolder,
    IsVirtualItem: item.IsVirtualItem,
    SourceType: librarySource(item.SourceType),
    CanDelete: item.CanDelete !== false,
    OwnerId: idKey(item.OwnerId),
    PrimaryVersionId: idKey(item.PrimaryVersionId),
    SeriesId: idKey(item.SeriesId),
    SeasonId: idKey(item.SeasonId),
    IndexNumber: item.IndexNumber,
    ParentIndexNumber: item.ParentIndexNumber
  })).sort((left, right) => left.Id.localeCompare(right.Id, 'en')));
}

function scanLineageSignature(items) {
  return JSON.stringify(items.map(item => ({
    ...structuralSnapshot(item),
    CollectionType: item.CollectionType,
    PhysicalFolderIds: item.PhysicalFolderIds,
    PhysicalLocationsList: item.PhysicalLocationsList
  })));
}

function sameStructure(left, right) {
  return sameId(left.Id, right.Id)
    && sameId(left.ParentId, right.ParentId)
    && sameId(repositoryTopParentId(left), repositoryTopParentId(right))
    && samePath(left.Path, right.Path)
    && itemType(left) === itemType(right)
    && left.IsFolder === right.IsFolder
    && sameId(left.SeriesId, right.SeriesId)
    && sameId(left.SeasonId, right.SeasonId)
    && left.IndexNumber === right.IndexNumber
    && left.ParentIndexNumber === right.ParentIndexNumber;
}

function parseItems(rows) {
  return rows.map(row => mapRecord(row)).filter(Boolean);
}

function byId(items) {
  return new Map(items.map(item => [idKey(item.Id), item]));
}

function createPathCatalog(rows) {
  const items = new Map();
  const paths = new Map();
  const remove = value => {
    const key = idKey(typeof value === 'object' ? value?.Id : value);
    const existing = items.get(key);
    if (!existing) return;
    items.delete(key);
    const path = pathKey(existing.Path);
    const owners = paths.get(path);
    owners?.delete(key);
    if (owners?.size === 0) paths.delete(path);
  };
  const set = item => {
    remove(item);
    if (!idKey(item?.Id) || typeof item?.Path !== 'string') return;
    const key = idKey(item.Id);
    const path = pathKey(item.Path);
    const owners = paths.get(path) ?? new Map();
    owners.set(key, item);
    paths.set(path, owners);
    items.set(key, item);
  };
  for (const row of rows) set({ Id: row.Id, Path: row.Path, NativeType: row.Type, Type: itemType(row) });
  return { remove, set, owners: value => [...(paths.get(pathKey(value))?.values() ?? [])] };
}

function scanTargetPaths(target, values) {
  if (!target || typeof target !== 'object') return;
  for (const value of [target.identityPath, target.primary?.identityPath,
    ...(target.consumedPaths ?? []), ...(target.replacementPaths ?? [])]) {
    if (typeof value === 'string' && value.length) values.add(value);
  }
  for (const group of ['localAlternates', 'ownedParts', 'directoryParts', 'ownedExtras']) {
    for (const nested of target[group] ?? []) scanTargetPaths(nested, values);
  }
}

function scanPlanPaths(plan) {
  const values = new Set();
  for (const target of plan?.desired ?? []) scanTargetPaths(target, values);
  return [...values];
}

function tvStructure(target, parent, root) {
  const type = target.nativeType;
  if (![seriesNativeType, seasonNativeType, episodeNativeType].includes(type)) return null;
  const parentNativeType = parent?.NativeType ?? parent?.Type;
  const initial = target.draft.initialColumns ?? {};
  if (type === seriesNativeType) {
    if (!sameId(parent?.Id, root?.Id) || parentNativeType !== folderNativeType) {
      throw new StorageError('invalid-response', 'A TV Series must be a direct child of the physical scan root.');
    }
    return { relationships: { SeriesId: null, SeasonId: null }, indices: {} };
  }
  if (type === seasonNativeType) {
    if (parentNativeType !== seriesNativeType || !Number.isSafeInteger(initial.IndexNumber) || initial.IndexNumber <= 0) {
      throw new StorageError('invalid-response', 'A TV Season requires a positive initial index and a Series parent.');
    }
    return {
      relationships: { SeriesId: parent.Id, SeasonId: null },
      indices: { IndexNumber: initial.IndexNumber }
    };
  }
  if (parentNativeType !== seasonNativeType || !nonemptyId(parent.SeriesId)
    || !Number.isSafeInteger(initial.IndexNumber) || initial.IndexNumber <= 0
    || !Number.isSafeInteger(initial.ParentIndexNumber) || initial.ParentIndexNumber <= 0
    || initial.ParentIndexNumber !== parent.IndexNumber) {
    throw new StorageError('invalid-response', 'A TV Episode requires positive initial indices and a related Season parent.');
  }
  return {
    relationships: { SeriesId: parent.SeriesId, SeasonId: parent.Id },
    indices: { IndexNumber: initial.IndexNumber, ParentIndexNumber: initial.ParentIndexNumber }
  };
}

function matchesTvStructure(item, structure) {
  if (structure == null) return true;
  for (const [field, expected] of Object.entries(structure.relationships)) {
    if (expected == null ? nonemptyId(item?.[field]) : !sameId(item?.[field], expected)) return false;
  }
  return Object.entries(structure.indices).every(([field, expected]) => item?.[field] === expected);
}

function plannedTraversalItem(target, parent, root) {
  const structure = tvStructure(target, parent, root);
  return {
    Id: target.Id,
    Path: target.identityPath,
    ParentId: parent.Id,
    TopParentId: root.Id,
    Type: target.nativeType.split('.').at(-1),
    NativeType: target.nativeType,
    IsFolder: target.draft.IsFolder,
    IsVirtualItem: false,
    SourceType: target.draft.SourceType ?? target.draft.data?.SourceType ?? 'Library',
    ...(structure?.relationships ?? {}),
    ...(structure?.indices ?? {})
  };
}

const movieCollapsedTypes = new Set([movieNativeType]);
const musicVideoCollapsedTypes = new Set([musicVideoNativeType]);
const bookCollapsedTypes = new Set([bookNativeType, audioBookNativeType]);
const movableCollapsedTypes = new Set([bookNativeType, audioBookNativeType]);

function collapsedItemNativeTypes(context) {
  return context?.collectionType === 'movies' ? movieCollapsedTypes
    : context?.collectionType === 'musicvideos' ? musicVideoCollapsedTypes
      : context?.collectionType === 'books' ? bookCollapsedTypes : null;
}

function supportsCollapsedItemType(context, nativeType) {
  return collapsedItemNativeTypes(context)?.has(nativeType) === true;
}

export class FolderScanService {
  #lifetime = new AbortController();
  #current = null;
  #pending = new Map();
  #runner = null;
  #scanTail = Promise.resolve();
  #active = new Set();
  #closed = false;

  constructor({ store, library, vfs, identityMap, ignoreRule = new DotIgnoreRule({ vfs, identityMap }), refreshes, programDataPath, configuration = {}, resolverPipeline, metadataScanner, resolvedItemLifecycle,
    itemCreation = library?.itemCreation, linkedChildReferences,
    metadataConfiguration = { UseFileCreationTimeForDateAdded: true }, clock = () => new Date(), onError = () => {},
    reattach = reattachUserData }) {
    if (!store || !library || !vfs || !identityMap || !refreshes) {
      throw new TypeError('Folder scanning requires persistence, library, storage, identity mapping and refresh services.');
    }
    if (typeof programDataPath !== 'string' || !programDataPath) {
      throw new TypeError('Folder scanning requires the native program data path.');
    }
    resolverPipeline ??= new DirectoryItemResolverPipeline({ programDataPath, configuration });
    if (!(resolverPipeline instanceof DirectoryItemResolverPipeline)
      || resolverPipeline.programDataPath !== programDataPath
      || resolverPipeline.caseSensitive !== (configuration.EnableCaseSensitiveItemIds === true)) {
      throw new TypeError('Folder scanning requires a directory item resolver pipeline.');
    }
    if (!resolvedItemLifecycle || typeof resolvedItemLifecycle.apply !== 'function') {
      throw new TypeError('Folder scanning requires a resolved-item lifecycle host.');
    }
    if (typeof reattach !== 'function') throw new TypeError('Folder scanning user data reattachment must be a function.');
    Object.assign(this, { store, library, vfs, identityMap, ignoreRule, refreshes, programDataPath, configuration,
      resolverPipeline, metadataScanner, resolvedItemLifecycle, itemCreation, linkedChildReferences,
      metadataConfiguration, clock, onError, reattach });
    const nativePath = pathStyle(programDataPath) === 'windows' ? path.win32 : path.posix;
    this.applicationRootPath = nativePath.join(programDataPath, 'root');
    this.caseSensitive = configuration.EnableCaseSensitiveItemIds === true;
    this.capabilities = Object.freeze({
      ...folderScanCapabilities,
      runsMetadataProbeRefresh: metadataScanner != null,
      resolvesProductionMediaFiles: resolverPipeline.capabilities.resolvesProductionMediaFiles,
      productionMediaScopes: resolverPipeline.capabilities.productionMediaScopes
    });
  }

  supports(item) {
    const nativeType = item?.NativeType ?? item?.Type;
    return itemType(item) === String(nativeType ?? '').split('.').at(-1)
      && this.#supportsTraversal(item);
  }

  #supportsPhysicalRoot(item) {
    return itemType(item) === 'Folder'
      && (item?.NativeType == null || item.NativeType === folderNativeType)
      && item?.IsFolder === true
      && typeof item.Path === 'string'
      && item.Path.length > 0
      && !item.IsVirtualItem
      && !nonemptyId(item.OwnerId)
      && !nonemptyId(item.PrimaryVersionId)
      && librarySource(item.SourceType)
      && !/^[a-z][a-z\d+.-]*:\/\//iu.test(item.Path);
  }

  #supportsTraversal(item) {
    return itemType(item) !== 'Playlist'
      && this.resolverPipeline.manages(item)
      && item?.IsFolder === true
      && typeof item.Path === 'string'
      && item.Path.length > 0
      && !item.IsVirtualItem
      && !nonemptyId(item.OwnerId)
      && !nonemptyId(item.PrimaryVersionId)
      && librarySource(item.SourceType)
      && !/^[a-z][a-z\d+.-]*:\/\//iu.test(item.Path);
  }

  #validateDirectRootLineage(folder, root, parents) {
    if (sameId(folder.Id, root.Id)) return;
    if (!this.#isManagedItem(folder, root.Id)) {
      throw new StorageError('invalid-response', 'A direct scan root must retain its managed physical identity.');
    }
    let child = folder;
    for (const parent of parents) {
      if (!this.#isDirectAccessChild(child, parent)) {
        throw new StorageError('invalid-response', 'A direct scan root must retain its physical parent chain.');
      }
      if (sameId(parent.Id, root.Id)) return;
      if (!this.#isManagedItem(parent, root.Id) || !this.#supportsTraversal(parent)) {
        throw new StorageError('invalid-response', 'A direct scan root has an unsupported physical ancestor.');
      }
      child = parent;
    }
    throw new StorageError('invalid-response', 'A direct scan root is detached from its physical top parent.');
  }

  validateRefresh(item, options = {}) {
    if (!this.supports(item)) unsupported(`Folder tree reconciliation is not implemented for ${item?.Type ?? 'this item'}.`);
    if (this.metadataScanner) return this.metadataScanner.validateRefresh(item, options);
    if (!['None', 'ValidationOnly'].includes(options.MetadataRefreshMode ?? 'None')
      || (options.ImageRefreshMode ?? 'None') !== 'None'
      || options.ReplaceAllMetadata || options.ReplaceAllImages || options.RegenerateTrickplay) {
      unsupported('Folder metadata and image refresh are not implemented; only directory-tree validation is available.');
    }
  }

  queue(reference, options = {}) {
    if (this.#closed) throw closedError();
    if (reentrant(this)) throw reentrantError('Folder scan queueing');
    const key = idKey(typeof reference === 'object' ? reference?.Id : reference);
    if (!key) throw new TypeError('A folder reference with an Id is required.');
    this.#pending.set(key, { reference, options: metadataScanOptions(options) });
    if (this.#current?.key === key) this.#current.controller.abort();
    this.#startRunner();
    return this.#runner;
  }

  #startRunner() {
    if (this.#runner || this.#closed || !this.#pending.size) return;
    // Register the runner first, then synchronously let it reserve #scanTail so
    // a following direct scan cannot overtake the earlier queue request.
    const deferred = Promise.withResolvers();
    const task = deferred.promise;
    this.#runner = task;
    this.#runQueue().then(deferred.resolve, deferred.reject);
    task.finally(() => {
      if (this.#runner !== task) return;
      this.#runner = null;
      this.#startRunner();
    }).catch(() => {});
  }

  async #runQueue() {
    while (!this.#closed && this.#pending.size) {
      const [key, { reference, options }] = this.#pending.entries().next().value;
      this.#pending.delete(key);
      const controller = new AbortController();
      const current = { key, controller };
      this.#current = current;
      const signal = AbortSignal.any([controller.signal, this.#lifetime.signal]);
      try { await this.scan(reference, { ...options, signal }); }
      catch (error) { if (!cancelled(error)) this.#report(error); }
      finally { if (this.#current === current) this.#current = null; }
    }
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Error reporting cannot replace the scan outcome. */ }
  }

  async whenIdle() {
    if (reentrant(this)) throw reentrantError('Folder scan idle waiting');
    while (this.#runner || this.#active.size || this.#pending.size) {
      this.#startRunner();
      await Promise.allSettled([...(this.#runner ? [this.#runner] : []), ...this.#active]);
    }
  }

  async close() {
    const invokedFromActiveScan = reentrant(this);
    if (!this.#closed) {
      this.#closed = true;
      this.#pending.clear();
      this.#lifetime.abort();
      this.#current?.controller.abort();
    }
    if (invokedFromActiveScan) return;
    await this.whenIdle();
  }

  scan(reference, options = {}) {
    if (this.#closed) return Promise.reject(closedError());
    if (reentrant(this)) return Promise.reject(reentrantError('A nested folder scan'));
    // Register and serialize before collaborators can re-enter scan()/close().
    const context = { owner: this, active: true, parent: activeParent() };
    const run = () => folderScanContext.run(context, () => this.#scan(reference, options));
    const task = this.#scanTail.then(run, run);
    this.#scanTail = task.catch(() => {});
    this.#active.add(task);
    task.finally(() => {
      context.active = false;
      context.owner = null;
      this.#active.delete(task);
    }).catch(() => {});
    return task;
  }

  async #scan(reference, options = {}) {
    const { signal } = options;
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    checkAbort(combined);
    const lifecycle = new Map();
    const refreshOptions = metadataScanOptions({ ...options, signal: combined });
    let rootRefresh;
    try {
      if (this.metadataScanner) {
        const { folder } = await this.#loadContext(reference, combined);
        this.validateRefresh(folder, refreshOptions);
        lifecycle.set(idKey(folder.Id), folder);
        this.refreshes.reportStarted(folder);
        const refreshed = await this.metadataScanner.refreshItem(folder.Id, refreshOptions);
        rootRefresh = Object.freeze({ changed: refreshed.changed === true, UpdateType: refreshed.UpdateType,
          Failures: refreshed.Failures ?? 0 });
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        let context;
        try { context = await this.#loadContext(reference, combined); }
        catch (error) {
          if (attempt > 0 && !cancelled(error)) {
            throw new StorageError('version-changed', 'The folder hierarchy changed while retrying enumeration.', {
              cause: error
            });
          }
          throw error;
        }
        const state = {
          pathCatalog: null,
          touchedPaths: new Map(),
          claimedPaths: new Map(),
          libraryState: null,
          journals: [],
          progress: [],
          lifecycleUpdates: new Set(),
          lifecycleApplied: new Set(),
          irreversibleLifecycle: false
        };
        let structuralCommitted = false;
        try {
          checkAbort(combined);
          const plan = await this.#enumerateFolder(context.folder, context.root, context.collectionContext,
            null, combined, true, true, lifecycle, null, context.parents);
          checkAbort(combined);
          this.#validateLifecyclePlan(plan);
          const hasLinkedActions = await this.#preflightLinkedPlanActions(plan, combined);
          if (!hasLinkedActions) {
            await this.#applyResolvedItemLifecycles(plan, combined, state);
            const structuralResult = await this.store.transaction(async db => {
              checkAbort(combined);
              state.libraryState = await this.#relationState(db, plan.root);
              const currentFolder = sameId(plan.folder.Id, plan.root.Id)
                ? state.libraryState.byId.get(idKey(plan.root.Id))
                : await this.#item(db, plan.folder.Id);
              if (!currentFolder) {
                throw new StorageError('version-changed', 'The direct scan root changed during enumeration.');
              }
              this.#rememberRelationItem(state.libraryState, currentFolder);
              await this.#loadLineage(db, currentFolder, state.libraryState);
              const currentParents = parentChainForItem(currentFolder, state.libraryState);
              if (scanLineageSignature(currentParents) !== context.parentSignature) {
                throw new StorageError('version-changed', 'The direct scan root lineage changed during enumeration.');
              }
              const currentContext = await this.#collectionContext(db, plan.root, state.libraryState);
              if (currentContext.signature !== context.collectionContext.signature) {
                throw new StorageError('version-changed', 'The library collection context changed during enumeration.');
              }
              state.pathCatalog = createPathCatalog([]);
              const applied = await this.#applyPlan(db, plan, plan.folder, plan.root, combined, state);
              await this.#verifyPathOwnership(db, state);
              checkAbort(combined);
              return applied;
            }, {
              writeLockTables: folderScanWriteLocks,
              isolation: 'read-committed',
              signal: combined,
              lockTimeoutMs: folderScanLockTimeoutMs
            });
            structuralCommitted = true;
            const structurallyUpdated = new Set(state.journals.flatMap(journal => journal.updated.map(({ item }) => idKey(item.Id))));
            const lifecycleOnlyUpdates = [...state.lifecycleUpdates].filter(id => !structurallyUpdated.has(id)).length;
            const result = lifecycleOnlyUpdates ? Object.freeze({ ...structuralResult,
              updated: structuralResult.updated + lifecycleOnlyUpdates }) : structuralResult;
            for (const event of state.progress) this.refreshes.reportProgress(event.folder, event.progress);
            for (const journal of state.journals) this.#publish(journal);
            if (this.metadataScanner) {
              const children = await this.metadataScanner.refreshChildren(plan.folder.Id, refreshOptions, {
                reportProgress: progress => this.refreshes.reportProgress(plan.folder, Math.min(99, 50 + progress / 2))
              });
              checkAbort(combined);
              return Object.freeze({ ...result, metadata: Object.freeze({ root: rootRefresh, children }),
                metadataComplete: !rootRefresh.Failures && !children.providerFailures && !children.errors.length && !children.cancelled });
            }
            return result;
          }
          this.#validateLinkedActionPlan(plan);
          state.linkedChanges = { added: new Set(), updated: new Set(), removed: new Set() };
          const structuralResult = await this.#applyPlanByScope(plan, context, combined, state,
            () => { structuralCommitted = true; });
          const result = this.#linkedResult(structuralResult, state);
          if (this.metadataScanner) {
            const children = await this.metadataScanner.refreshChildren(plan.folder.Id, refreshOptions, {
              reportProgress: progress => this.refreshes.reportProgress(plan.folder, Math.min(99, 50 + progress / 2))
            });
            checkAbort(combined);
            return Object.freeze({ ...result, metadata: Object.freeze({ root: rootRefresh, children }),
              metadataComplete: !rootRefresh.Failures && !children.providerFailures && !children.errors.length && !children.cancelled });
          }
          return result;
        } catch (error) {
          if (!structuralCommitted && !state.irreversibleLifecycle
            && attempt === 0 && errorField(error, 'code') === 'version-changed') continue;
          throw error;
        }
      }
      throw new StorageError('version-changed', 'The folder hierarchy kept changing during enumeration.');
    } finally {
      for (const folder of [...lifecycle.values()].reverse()) this.refreshes.reportCompleted(folder);
    }
  }

  async #loadStructuralScopeState(db, plan, context, state) {
    state.libraryState = await this.#relationState(db, plan.root);
    const scanRoot = sameId(context.folder.Id, plan.root.Id)
      ? state.libraryState.byId.get(idKey(plan.root.Id))
      : await this.#item(db, context.folder.Id);
    if (!scanRoot) throw new StorageError('version-changed', 'The direct scan root changed during enumeration.');
    this.#rememberRelationItem(state.libraryState, scanRoot);
    await this.#loadLineage(db, scanRoot, state.libraryState);
    const currentParents = parentChainForItem(scanRoot, state.libraryState);
    if (scanLineageSignature(currentParents) !== context.parentSignature) {
      throw new StorageError('version-changed', 'The direct scan root lineage changed during enumeration.');
    }
    const currentContext = await this.#collectionContext(db, plan.root, state.libraryState);
    if (currentContext.signature !== context.collectionContext.signature) {
      throw new StorageError('version-changed', 'The library collection context changed during enumeration.');
    }
    state.pathCatalog = createPathCatalog(await this.#pathRows(db, scanPlanPaths(plan)));
    state.touchedPaths = new Map();
    state.claimedPaths = new Map();
  }

  async #commitStructuralScope(plan, folder, context, signal, state) {
    return this.store.transaction(async db => {
      checkAbort(signal);
      await this.#loadStructuralScopeState(db, plan, context, state);
      const applied = await this.#applyScopePlan(db, plan, folder, plan.root, signal, state);
      await this.#verifyPathOwnership(db, state);
      checkAbort(signal);
      return applied;
    }, {
      writeLockTables: folderScanWriteLocks,
      isolation: 'read-committed',
      signal,
      lockTimeoutMs: folderScanLockTimeoutMs
    });
  }

  #isVideoPlanTarget(target) {
    return target?.draft?.IsFolder === false
      && [movieNativeType, musicVideoNativeType, videoNativeType].includes(target.nativeType);
  }

  #isVideoItem(item) {
    return VIDEO_TYPES.has(item?.Type)
      || [movieNativeType, musicVideoNativeType, videoNativeType].includes(item?.NativeType);
  }

  #directoryDiscIdentityChanges(plan) {
    if (plan.emptyTopFolder) return [];
    const desiredByContainer = new Map();
    for (const target of plan.desired ?? []) {
      const container = target.primary?.identityPath;
      if (container != null) desiredByContainer.set(pathKey(container), target);
    }
    const changes = [];
    for (const source of plan.existingItems ?? []) {
      if (!this.#isMultiDiscDirectoryItem(source)) continue;
      const containerPath = this.#directoryDiscContainerPath(source, plan.folder);
      if (containerPath == null) continue;
      const target = desiredByContainer.get(pathKey(containerPath)) ?? null;
      if (!target || !sameId(target.Id, source.Id)) changes.push({ source, target, containerPath });
    }
    return changes;
  }

  #directoryDiscContainerPath(item, parent) {
    if (typeof item?.Path !== 'string' || item.Path.length === 0
      || typeof parent?.Path !== 'string' || parent.Path.length === 0) return null;
    const nativePath = pathStyle(item.Path) === 'windows' ? path.win32 : path.posix;
    const containerPath = nativePath.dirname(item.Path);
    return pathKey(nativePath.dirname(containerPath)) === pathKey(parent.Path)
      ? containerPath : null;
  }

  #directoryDiscPathFamily(item) {
    if (!this.#isMultiDiscDirectoryItem(item) || typeof item.Path !== 'string' || item.Path.length === 0) return null;
    return [item.Path, ...item.AdditionalParts];
  }

  #directoryDiscTargetFamily(target) {
    const additional = target?.draft?.data?.AdditionalParts;
    if (target?.entry?.kind !== 'directory' || target?.primary?.entry?.kind !== 'directory'
      || target?.draft?.IsFolder !== false || !Array.isArray(target?.directoryParts)
      || !Array.isArray(additional) || additional.length !== target.directoryParts.length) return null;
    if (!additional.every((value, index) => typeof value === 'string' && value.length > 0
      && samePath(value, target.directoryParts[index]?.identityPath)
      && target.directoryParts[index]?.entry?.kind === 'directory')) return null;
    return [target.identityPath, ...additional];
  }

  #orderedDirectDirectoryFamily(paths, containerPath) {
    if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || value.length === 0)) return false;
    const nativePath = pathStyle(containerPath) === 'windows' ? path.win32 : path.posix;
    const seen = new Set();
    for (const value of paths) {
      const key = pathKey(value);
      if (key == null || seen.has(key) || pathKey(nativePath.dirname(value)) !== pathKey(containerPath)) return false;
      seen.add(key);
    }
    const ordered = [...paths].sort(compareNativePaths);
    return paths.every((value, index) => samePath(value, ordered[index]));
  }

  #sameDirectoryDiscSource(left, right) {
    const leftPaths = this.#directoryDiscPathFamily(left), rightPaths = this.#directoryDiscPathFamily(right);
    return Boolean(leftPaths && rightPaths && sameId(left.Id, right.Id)
      && left.NativeType === right.NativeType && left.IsFolder === right.IsFolder
      && sameId(left.ParentId, right.ParentId) && sameId(repositoryTopParentId(left), repositoryTopParentId(right))
      && left.VideoType === right.VideoType && left.IsInMixedFolder === right.IsInMixedFolder
      && left.CanDelete === right.CanDelete && left.SourceType === right.SourceType
      && Boolean(left.IsVirtualItem) === Boolean(right.IsVirtualItem)
      && Boolean(left.IsShortcut) === Boolean(right.IsShortcut)
      && Boolean(left.IsPlaceHolder) === Boolean(right.IsPlaceHolder)
      && sameId(left.ChannelId, right.ChannelId)
      && !nonemptyId(left.OwnerId) && !nonemptyId(right.OwnerId)
      && !nonemptyId(left.PrimaryVersionId) && !nonemptyId(right.PrimaryVersionId)
      && leftPaths.length === rightPaths.length
      && leftPaths.every((value, index) => samePath(value, rightPaths[index]))
      && (left.LocalAlternateVersions ?? []).length === 0 && (right.LocalAlternateVersions ?? []).length === 0
      && (left.LinkedAlternateVersions ?? []).length === 0 && (right.LinkedAlternateVersions ?? []).length === 0);
  }

  #directoryDiscPromotionFailure(action, detail) {
    const lifecycle = action?.mode === 'folder' ? '2-to-Folder reclassification' : '3-to-2 primary-loss lifecycle';
    return new StorageError('unsupported/type-reclassification-required',
      `Changing the multi-disc directory stack at ${action.containerPath} requires an isolated ${lifecycle}${detail ? `: ${detail}` : '.'}`);
  }

  async #validateDirectoryDiscPromotion(db, plan, action, signal) {
    checkAbort(signal);
    const { source, target, containerPath } = action;
    const oldPaths = this.#directoryDiscPathFamily(source), newPaths = this.#directoryDiscTargetFamily(target);
    const oldAlternates = [...(source.LocalAlternateVersions ?? []), ...(source.LinkedAlternateVersions ?? [])];
    const targetLocal = target?.draft?.data?.LocalAlternateVersions ?? [];
    const targetLinked = target?.draft?.data?.LinkedAlternateVersions ?? [];
    const scope = plan.peekScopes?.get(pathKey(containerPath));
    const folderTarget = target?.nativeType === folderNativeType && target?.draft?.IsFolder === true;
    action.mode = folderTarget ? 'folder' : 'promotion';
    if (plan.deletionSafe !== true || !target || sameId(source.Id, target.Id)
      || (plan.existingItems ?? []).length !== 1 || (plan.desired ?? []).length !== 1
      || !this.#isManagedItem(source, plan.root.Id)
      || source.IsFolder !== false
      || !['Dvd', 'BluRay'].includes(source.VideoType)
      || source.IsInMixedFolder !== false || (target.draft?.columns?.IsInMixedFolder ?? false) !== false
      || oldAlternates.length || !Array.isArray(targetLocal) || targetLocal.length
      || !Array.isArray(targetLinked) || targetLinked.length
      || target.localAlternates?.length || target.ownedParts?.length || target.ownedExtras?.length
      || !this.#orderedDirectDirectoryFamily(oldPaths, containerPath)
      || !plan.observedPaths.has(pathKey(containerPath)) || !plan.directoryPaths.has(pathKey(containerPath))
      || scope?.deletionSafe !== true
      || scope.observedPaths.has(pathKey(source.Path))) {
      throw this.#directoryDiscPromotionFailure(action, 'the resolver or snapshot contract is incomplete');
    }
    if (action.mode === 'promotion') {
      if (oldPaths.length !== 3 || newPaths?.length !== 2 || source.NativeType !== target.nativeType
        || target.draft?.data?.VideoType !== source.VideoType
        || !samePath(target.primary?.identityPath, containerPath)
        || !this.#orderedDirectDirectoryFamily(newPaths, containerPath)
        || newPaths.some(value => !scope.observedPaths.has(pathKey(value)))) {
        throw this.#directoryDiscPromotionFailure(action, 'the resolver or snapshot contract is incomplete');
      }
      const expectedNew = oldPaths.slice(1);
      if (!newPaths.every((value, index) => samePath(value, expectedNew[index]))) {
        throw this.#directoryDiscPromotionFailure(action, 'the surviving directory family is not the old ordered tail');
      }
    } else {
      const childPlan = plan.children?.get(idKey(target.Id));
      const nested = childPlan?.desired?.[0];
      if (oldPaths.length !== 2 || newPaths != null || target.traversal !== 'children'
        || target.entry?.kind !== 'directory' || target.primary?.entry?.kind !== 'directory'
        || !samePath(target.identityPath, containerPath) || !samePath(target.primary.identityPath, containerPath)
        || target.consumedPaths?.length !== 1 || !samePath(target.consumedPaths[0], containerPath)
        || target.directoryParts?.length || target.replacementPaths?.length || target.ownsLocalAlternates
        || target.ownsOwnedParts || target.ownsOwnedExtras
        || plan.children.size !== 1 || !childPlan || childPlan.persisted !== false
        || !sameId(childPlan.folder?.Id, target.Id) || !samePath(childPlan.folder?.Path, containerPath)
        || childPlan.folder?.NativeType !== folderNativeType || childPlan.folder?.IsFolder !== true
        || childPlan.deletionSafe !== true || childPlan.emptyTopFolder || childPlan.existingItems?.length
        || childPlan.desired?.length !== 1 || childPlan.children?.size !== 0
        || childPlan.withheldPaths?.size > 0 || childPlan.withheldPaths?.length > 0
        || childPlan.observedPaths?.size !== 1 || childPlan.directoryPaths?.size !== 1
        || !nested || nested.nativeType !== source.NativeType || nested.draft?.IsFolder !== false
        || nested.draft?.data?.VideoType !== source.VideoType || nested.traversal !== 'none'
        || nested.entry?.kind !== 'directory' || nested.primary?.entry?.kind !== 'directory'
        || !samePath(nested.identityPath, oldPaths[1]) || !samePath(nested.primary.identityPath, oldPaths[1])
        || nested.consumedPaths?.length !== 1 || !samePath(nested.consumedPaths[0], oldPaths[1])
        || nested.replacementPaths?.length || nested.localAlternates?.length || nested.directoryParts?.length
        || nested.ownedParts?.length || nested.ownedExtras?.length
        || nested.draft?.data?.AdditionalParts?.length || nested.draft?.data?.LocalAlternateVersions?.length
        || nested.draft?.data?.LinkedAlternateVersions?.length
        || !scope.observedPaths.has(pathKey(oldPaths[1]))
        || !childPlan.observedPaths.has(pathKey(oldPaths[1]))
        || !childPlan.directoryPaths.has(pathKey(oldPaths[1]))) {
        throw this.#directoryDiscPromotionFailure(action, 'the recursive Folder and direct-disc plan is incomplete');
      }
      action.nestedPlan = childPlan;
      action.nestedTarget = nested;
    }
    const current = await this.#item(db, source.Id);
    if (!current || !this.#sameDirectoryDiscSource(source, current)) {
      throw this.#directoryDiscPromotionFailure(action, 'the persisted source changed after enumeration');
    }
    if (await this.#item(db, target.Id) || action.nestedTarget && await this.#item(db, action.nestedTarget.Id)) {
      throw this.#directoryDiscPromotionFailure(action, 'the new deterministic identity is already persisted');
    }
    const familyPaths = [containerPath, ...oldPaths, ...(newPaths ?? [])];
    const pathCatalog = createPathCatalog(await this.#pathRows(db, familyPaths));
    for (const familyPath of familyPaths) {
      const owners = pathCatalog.owners(familyPath).filter(owner => !sameId(owner.Id, source.Id));
      if (owners.length) throw this.#directoryDiscPromotionFailure(action, 'a directory path has another repository owner');
    }
    const closure = await collectItemDeletionIds(db, [source.Id]);
    if (closure.size !== 1 || !closure.has(idKey(source.Id))) {
      throw this.#directoryDiscPromotionFailure(action, 'the old identity owns a deletion closure');
    }
    const storageIds = this.#idValues(source.Id);
    const sql=nativeTextSql(db.schemaName),linksTable=`${q(db.schemaName)}."LinkedChildren"`;
    if ((await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${linksTable} WHERE "ChildType" IN (2,3)
      AND (${sql.guidKey('"ParentId"')}=$1 OR ${sql.guidKey('"ChildId"')}=$1)) AS present`,[idKey(source.Id)])).rows[0].present) {
      throw this.#directoryDiscPromotionFailure(action, 'the old identity participates in a version family');
    }
    action.removedUserDataKeys = Object.freeze(await userDataKeys(db, current));
    return action;
  }

  #linkedScopeActions(plan) {
    const directoryDiscPromotions = this.#directoryDiscIdentityChanges(plan);
    const empty = { stale: [], deletions: [], replacements: [], demotions: [], directoryDiscPromotions,
      directoryDiscCreations: [] };
    if (plan.emptyTopFolder || !plan.deletionSafe) return empty;
    const primaries = (plan.desired ?? []).filter(target => this.#isVideoPlanTarget(target));
    const desiredPrimaryIds = new Set(primaries.map(target => idKey(target.Id)));
    const desiredIds = new Set();
    const primaryByAlternatePath = new Map();
    for (const target of primaries) {
      desiredIds.add(idKey(target.Id));
      for (const alternate of target.localAlternates ?? []) {
        desiredIds.add(idKey(alternate.Id));
        primaryByAlternatePath.set(ordinalIgnoreCaseKey(alternate.identityPath), target);
      }
      for (const part of target.ownedParts ?? []) desiredIds.add(idKey(part.Id));
      for (const extra of target.ownedExtras ?? []) desiredIds.add(idKey(extra.Id));
    }
    for (const target of plan.desired ?? []) desiredIds.add(idKey(target.Id));
    const stale = [];
    for (const target of plan.desired ?? []) {
      if ((plan.existingItems ?? []).some(item => sameId(item.Id, target.Id))) continue;
      const occupied = (plan.existingItems ?? []).find(item => samePath(item.Path, target.identityPath)
        && !sameId(item.Id, target.Id));
      if (occupied) stale.push(occupied);
    }
    const staleIds = new Set(stale.map(item => idKey(item.Id)));
    const removed = (plan.existingItems ?? []).filter(item => this.#isVideoItem(item)
      && !desiredPrimaryIds.has(idKey(item.Id)));
    const replacements = [], demotions = [], assigned = new Set(directoryDiscPromotions.map(action => idKey(action.source.Id)));
    for (const source of removed) {
      if (nonemptyId(source.OwnerId) || nonemptyId(source.PrimaryVersionId)
        || typeof source.Path !== 'string' || primaryByAlternatePath.has(ordinalIgnoreCaseKey(source.Path))) continue;
      const priorPaths = new Set((source.LocalAlternateVersions ?? []).filter(Boolean).map(ordinalIgnoreCaseKey));
      if (!priorPaths.size) continue;
      // Native only defers an old primary when one of its prior alternates is
      // still advertised as an alternate of a valid primary. If the sole
      // surviving version is itself the new primary, DeleteItem runs before
      // CreateItems and performs the promotion.
      const target = primaries.find(value => (value.localAlternates ?? [])
        .some(alternate => priorPaths.has(ordinalIgnoreCaseKey(alternate.identityPath))));
      if (!target || !this.#isSafeLinkedDeletionCandidate(plan, source)) continue;
      replacements.push({ source, target });
      assigned.add(idKey(source.Id));
    }
    for (const source of removed) {
      if (assigned.has(idKey(source.Id)) || nonemptyId(source.OwnerId) || nonemptyId(source.PrimaryVersionId)
        || typeof source.Path !== 'string') continue;
      const target = primaryByAlternatePath.get(ordinalIgnoreCaseKey(source.Path));
      if (!target || !this.#isSafeLinkedObservedCandidate(plan, source)) continue;
      demotions.push({ source, target });
      assigned.add(idKey(source.Id));
    }
    const deletions = (plan.existingItems ?? []).filter(item => !assigned.has(idKey(item.Id))
      && !staleIds.has(idKey(item.Id))
      && !desiredIds.has(idKey(item.Id))
      && !plan.observedPaths.has(pathKey(item.Path))
      && this.#isSafeLinkedDeletionCandidate(plan, item));
    return { stale, deletions, replacements, demotions, directoryDiscPromotions,
      directoryDiscCreations: [] };
  }

  #isSafeLinkedDeletionCandidate(plan, item) {
    if (!this.#isManagedIdentity(item, plan.root.Id)
      || !identityWithin(item.Path, plan.folder.Path)
      || !identityWithin(item.Path, plan.root.Path)) return false;
    const withheld = new Set((plan.withheldPaths ?? []).map(pathKey));
    if (withheld.has(pathKey(item.Path))) return false;
    // Owned parts/extras have their own family-level deletion proof. They must
    // remain in structural reconciliation even when another item in this scope
    // requires the live DeleteItem path. Local alternates are safe direct
    // candidates because DeleteItem must reroute their incoming manual links.
    if (nonemptyId(item.OwnerId) && !nonemptyId(item.PrimaryVersionId)) return false;
    const containerPath = this.#collapsedItemContainerPath(item, plan.folder, plan.collectionContext);
    if (containerPath == null) return this.#isDirectAccessChild(item, plan.folder);
    const containerKey = pathKey(containerPath);
    if (withheld.has(containerKey)) return false;
    if (!plan.observedPaths.has(containerKey)) return plan.deletionSafe === true;
    if (!plan.directoryPaths.has(containerKey)) return true;
    const scope = plan.peekScopes.get(containerKey);
    return scope?.deletionSafe === true && !scope.observedPaths.has(pathKey(item.Path));
  }

  #isSafeLinkedObservedCandidate(plan, item) {
    if (!this.#isManagedIdentity(item, plan.root.Id)
      || !identityWithin(item.Path, plan.folder.Path)
      || !identityWithin(item.Path, plan.root.Path)
      || nonemptyId(item.OwnerId) && !nonemptyId(item.PrimaryVersionId)) return false;
    const withheld = new Set((plan.withheldPaths ?? []).map(pathKey)), itemPath = pathKey(item.Path);
    if (withheld.has(itemPath)) return false;
    if (this.#isDirectAccessChild(item, plan.folder)) return true;
    if (!(plan.desired ?? []).some(target => samePath(target.identityPath, item.Path)
      || (target.localAlternates ?? []).some(alternate => samePath(alternate.identityPath, item.Path)))) return false;
    for (const [containerPath, scope] of plan.peekScopes ?? []) {
      if (withheld.has(containerPath) || !plan.directoryPaths.has(containerPath)) continue;
      if (scope?.deletionSafe === true && scope.observedPaths.has(itemPath)) return true;
    }
    return false;
  }

  #linkedDeletionRoots(actions) {
    const candidates = new Map([...actions.stale, ...actions.deletions]
      .map(item => [idKey(item.Id), item]));
    return [...candidates.values()].filter(item => {
      for (const owner of [item.OwnerId, item.ParentId]) {
        if (nonemptyId(owner) && candidates.has(idKey(owner))) return false;
      }
      return true;
    });
  }

  async #preflightLinkedPlanActions(plan, signal) {
    const scopes = [];
    const visit = current => {
      const actions = this.#linkedScopeActions(current);
      actions.deletionRoots = this.#linkedDeletionRoots(actions);
      current.linkedActions = actions;
      scopes.push({ plan: current, actions });
      for (const child of current.children.values()) visit(child);
    };
    visit(plan);
    if (scopes.every(scope => !scope.actions.replacements.length && !scope.actions.demotions.length
      && !scope.actions.deletionRoots.length && !scope.actions.directoryDiscPromotions.length
      && !scope.actions.directoryDiscCreations.length)) {
      for (const scope of scopes) scope.plan.linkedNativeAction = false;
      return false;
    }
    return this.store.run(async db => {
      const storageIds = [];
      for (const scope of scopes) {
        const promotions = scope.actions.directoryDiscPromotions;
        if (promotions.length > 1 || promotions.length && (scope.actions.replacements.length
          || scope.actions.demotions.length || scope.actions.deletionRoots.length)) {
          throw this.#directoryDiscPromotionFailure(promotions[0], 'the scan scope contains another native action');
        }
        for (const action of promotions) {
          await this.#validateDirectoryDiscPromotion(db, scope.plan, action, signal);
          if (action.mode === 'folder') {
            const nestedScope = scopes.find(candidate => candidate.plan === action.nestedPlan);
            if (!nestedScope || nestedScope.actions.directoryDiscCreations.length) {
              throw this.#directoryDiscPromotionFailure(action, 'the recursive creation scope is ambiguous');
            }
            nestedScope.actions.directoryDiscCreations.push({ parentAction: action, target: action.nestedTarget });
          }
        }
        const sources = new Map([...scope.actions.replacements, ...scope.actions.demotions, ...promotions]
          .map(action => [idKey(action.source.Id), action.source.Id]));
        if (scope.actions.deletionRoots.length) {
          scope.deletionClosures = new Map();
          scope.deletionClosureItems = new Map();
          scope.externallyReferencedStaleRoots = new Set();
          const staleIds = new Set(scope.actions.stale.map(item => idKey(item.Id)));
          for (const root of scope.actions.deletionRoots) {
            const closure = await collectItemDeletionIds(db, [root.Id]);
            scope.deletionClosures.set(idKey(root.Id), new Set(closure.keys()));
            const rows = closure.size ? await db.rows('BaseItems', {
              whereIn: { Id: [...new Set(closure.values())] }
            }) : [];
            const items = parseItems(rows);
            scope.deletionClosureItems.set(idKey(root.Id), items);
            if (staleIds.has(idKey(root.Id))
              && await this.#hasExternalReferences(db, items.map(item => ({ item })), signal)) {
              scope.externallyReferencedStaleRoots.add(idKey(root.Id));
            }
            for (const [key, id] of closure) sources.set(key, id);
          }
        }
        scope.sourceIds = sources;
        for (const id of sources.values()) storageIds.push(...this.#idValues(id));
      }
      if (!storageIds.length) {
        for (const scope of scopes) scope.plan.linkedNativeAction = false;
        return false;
      }
      const values = [...new Set(storageIds)];
      const sql=nativeTextSql(db.schemaName),linksTable=`${q(db.schemaName)}."LinkedChildren"`,keys=[...new Set(values.map(idKey))];
      // The relation stays in SQL even when one child has millions of incoming
      // manual references. Only flags for this already selected scan scope cross
      // into its existing structural plan.
      const manualSources=new Set(),remoteSources=new Set(),remoteChildren=new Set(),versionSources=new Set();
      const flags=await db.client.query(`SELECT requested.key,
        EXISTS(SELECT 1 FROM ${linksTable} WHERE ${sql.guidKey('"ChildId"')}=requested.key AND "ChildType"=0) AS manual,
        EXISTS(SELECT 1 FROM ${linksTable} WHERE ${sql.guidKey('"ParentId"')}=requested.key AND "ChildType"=3) AS remote,
        EXISTS(SELECT 1 FROM ${linksTable} WHERE ${sql.guidKey('"ChildId"')}=requested.key AND "ChildType"=2
          OR ${sql.guidKey('"ParentId"')}=requested.key AND "ChildType" IN (2,3)) AS version
        FROM unnest($1::text[]) requested(key)`,[keys]);
      for(const row of flags.rows){if(row.manual)manualSources.add(row.key);if(row.remote)remoteSources.add(row.key);if(row.version)versionSources.add(row.key);}
      const childKeys=(await db.client.query(`SELECT DISTINCT ${sql.guidKey('"ChildId"')} AS key FROM ${linksTable}
        WHERE "ChildType"=3 AND ${sql.guidKey('"ParentId"')}=ANY($1::text[])`,[keys])).rows;
      for(const row of childKeys)remoteChildren.add(row.key);
      for (const scope of scopes) {
        const candidates = [...scope.actions.replacements.map(action => action.source),
          ...scope.actions.demotions.map(action => action.source), ...scope.actions.deletionRoots];
        for (const item of candidates) {
          if (nonemptyId(item.PrimaryVersionId) || (item.LocalAlternateVersions ?? []).length
            || (item.LinkedAlternateVersions ?? []).length) versionSources.add(idKey(item.Id));
        }
      }
      const needsVersionAction = id => remoteSources.has(id) || manualSources.has(id) && versionSources.has(id);
      let found = false;
      for (const scope of scopes) {
        const discCreations = scope.actions.directoryDiscCreations;
        if (discCreations.length && (discCreations.length !== 1 || scope.actions.replacements.length
          || scope.actions.demotions.length || scope.actions.deletionRoots.length
          || scope.actions.directoryDiscPromotions.length)) {
          throw this.#directoryDiscPromotionFailure(discCreations[0]?.parentAction,
            'the recursive creation scope contains another native action');
        }
        const replacements = scope.actions.replacements.filter(action => remoteSources.has(idKey(action.source.Id))
          || manualSources.has(idKey(action.source.Id)));
        const demotions = scope.actions.demotions.filter(action => remoteSources.has(idKey(action.source.Id))
          || manualSources.has(idKey(action.source.Id)));
        const staleIds = new Set(scope.actions.stale.map(item => idKey(item.Id)));
        const linkedRoots = scope.actions.deletionRoots.filter(root => {
          if (staleIds.has(idKey(root.Id))) return false;
          const closureIds = [...(scope.deletionClosures?.get(idKey(root.Id)) ?? [idKey(root.Id)])];
          if (!closureIds.some(needsVersionAction)) return false;
          // DeleteItem may own a remote ChildType=3 row, but it must not turn
          // unrelated descendants, owned parts/extras, or weak/withheld
          // collapsed entries into an eager deletion closure.
          return (scope.deletionClosureItems?.get(idKey(root.Id)) ?? [root]).every(item =>
            sameId(item.Id, root.Id) || remoteChildren.has(idKey(item.Id))
              || this.#isSafeLinkedDeletionCandidate(scope.plan, item));
        });
        const active = replacements.length > 0 || demotions.length > 0 || linkedRoots.length > 0
          || scope.actions.directoryDiscPromotions.length > 0 || discCreations.length > 0;
        // Same-path stale rows are required prerequisites for this scope's one
        // CreateItems batch. Other ordinary removals remain for structural
        // reconciliation so their established safety and transaction behavior
        // are unchanged.
        const stalePrerequisites = scope.actions.deletionRoots.filter(root => {
          if (!staleIds.has(idKey(root.Id))
            || scope.externallyReferencedStaleRoots?.has(idKey(root.Id))) return false;
          return (scope.deletionClosureItems?.get(idKey(root.Id)) ?? [root]).every(item =>
            sameId(item.Id, root.Id) ? this.#isSafeLinkedObservedCandidate(scope.plan, item)
              : remoteChildren.has(idKey(item.Id)) || this.#isSafeLinkedDeletionCandidate(scope.plan, item));
        });
        const deletionRoots = active ? [...new Map([
          ...linkedRoots,
          ...stalePrerequisites
        ].map(item => [idKey(item.Id), item])).values()] : [];
        scope.plan.linkedActions = { ...scope.actions, replacements, demotions, deletionRoots };
        scope.plan.linkedNativeAction = active;
        found ||= active;
      }
      return found;
    }, { signal, readOnly: true, lockTimeoutMs: folderScanLockTimeoutMs });
  }

  #requireLinkedActionServices(actions = {}) {
    if (!this.itemCreation || typeof this.itemCreation.getItemById !== 'function'
      || typeof this.itemCreation.registerItem !== 'function' || typeof this.itemCreation.unregisterItem !== 'function'
      || typeof this.resolvedItemLifecycle.updateRepository !== 'function'
      || typeof this.library.deleteItem !== 'function') {
      throw new TypeError('Folder native actions require live items, deletion and repository updates.');
    }
    if ((actions.replacements?.length || actions.demotions?.length)
      && (!this.linkedChildReferences || typeof this.linkedChildReferences.reroute !== 'function')) {
      throw new TypeError('Folder linked-version actions require reference rerouting.');
    }
    if (actions.directoryDiscPromotions?.some(action => action.mode !== 'folder') && typeof this.reattach !== 'function') {
      throw new TypeError('Directory-disc identity promotion requires user data reattachment.');
    }
  }

  #validateLinkedActionPlan(plan) {
    this.#requireLinkedActionServices();
    const visit = current => {
      if (current.linkedNativeAction === true) {
        const actions = current.linkedActions ?? this.#linkedScopeActions(current);
        this.#requireLinkedActionServices(actions);
        const unsupported = (actions.deletionRoots ?? this.#linkedDeletionRoots(actions))
          .find(item => !['Movie', 'MusicVideo', 'Video', 'Folder'].includes(itemType(item)));
        if (unsupported) {
          throw new StorageError('not-supported',
            `Linked folder reconciliation cannot run the deletion lifecycle for ${unsupported.NativeType ?? unsupported.Type}.`);
        }
      }
      for (const child of current.children.values()) visit(child);
    };
    visit(plan);
  }

  async #updateVersion(item, signal) {
    await this.resolvedItemLifecycle.updateRepository(item, { itemCreation: this.itemCreation, signal,
      updateReason: ItemUpdateType.MetadataEdit });
  }

  async #promoteVersion(item, signal) {
    if (item.PrimaryVersionId == null && !nonemptyId(item.OwnerId)) {
      this.itemCreation.registerItem(item);
      return false;
    }
    setPrimaryVersion(item, null);
    item.OwnerId = EMPTY_ID;
    await this.#updateVersion(item, signal);
    return true;
  }

  async #alternateVersions(item) {
    const links = await this.store.run(db => db.rows('LinkedChildren', { where: { ParentId: item.Id }, whereIn:{ChildType:[2,3]},
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }), { readOnly: true });
    const localIds = new Set(links.filter(link => Number(link.ChildType) === 2).map(link => idKey(link.ChildId)));
    const ids = new Map(links.filter(link => [2, 3].includes(Number(link.ChildType)))
      .map(link => [idKey(link.ChildId), link.ChildId]));
    const items = [];
    for (const id of ids.values()) {
      const alternate = await this.itemCreation.getItemById(id);
      if (alternate && this.#isVideoItem(alternate)) items.push(alternate);
    }
    return { links, localIds, items };
  }

  async #transferVersions(source, target, signal, versions = null) {
    const { localIds, items } = versions ?? await this.#alternateVersions(source);
    const updated = new Set();
    for (const alternate of items) {
      if (sameId(alternate.Id, target.Id)) continue;
      setPrimaryVersion(alternate, target.Id);
      alternate.OwnerId = localIds.has(idKey(alternate.Id)) ? target.Id : EMPTY_ID;
      await this.#updateVersion(alternate, signal);
      updated.add(idKey(alternate.Id));
    }
    return updated;
  }

  async #refreshScopeSnapshot(plan, removed) {
    const direct = await this.store.run(db => this.#children(db, plan.folder.Id), {
      readOnly: true,
      lockTimeoutMs: folderScanLockTimeoutMs
    });
    if (removed) {
      const remaining = new Set(direct.map(item => idKey(item.Id)));
      for (const item of plan.existingItems) if (!remaining.has(idKey(item.Id))) removed.add(idKey(item.Id));
    }
    plan.existingItems = direct;
    plan.directSignature = directChildrenSignature(direct, plan.folder.Id);
  }

  #assertActionTarget(plan, target, item) {
    if (!item || !this.#isManagedIdentity(item, plan.root.Id) || item.NativeType !== target.nativeType
      || item.IsFolder !== target.draft.IsFolder || !samePath(item.Path, target.identityPath)
      || !sameId(item.ParentId, plan.folder.Id)) {
      throw new StorageError('invalid-response', 'The linked reroute target conflicts with an existing item.');
    }
  }

  async #prepareScopeCreations(plan, removalIds, signal) {
    return this.store.run(async db => {
      const folder = await this.#item(db, plan.folder.Id), root = await this.#item(db, plan.root.Id);
      const direct = folder ? await this.#children(db, folder.Id) : [];
      if (!folder || !root || directChildrenSignature(direct, folder.Id) !== plan.directSignature) {
        throw new StorageError('version-changed', 'The folder changed before its linked targets were created.');
      }
      const relationState = await this.#relationState(db, root);
      this.#rememberRelationItem(relationState, folder);
      await this.#loadLineage(db, folder, relationState);
      const parents = parentChainForItem(folder, relationState);
      const pathCatalog = createPathCatalog(await this.#pathRows(db, scanPlanPaths(plan)));
      // Folder validation's current-child set includes ordinary children and
      // owned extras, but excludes owned version/part rows. An alternate that
      // already has the desired identity must therefore still pass through
      // the one CreateItems sibling batch when it becomes a direct target.
      const directById = new Map(direct.filter(item => !nonemptyId(item.OwnerId) || item.ExtraType != null)
        .map(item => [idKey(item.Id), item]));
      const items = [];
      for (const target of plan.desired) {
        const directExisting = directById.get(idKey(target.Id));
        if (directExisting) {
          const existing = directExisting;
          if (!this.#isManagedIdentity(existing, plan.root.Id) || existing.NativeType !== target.nativeType
            || existing.IsFolder !== target.draft.IsFolder || !samePath(existing.Path, target.identityPath)
            || !sameId(existing.ParentId, plan.folder.Id)) {
            throw new StorageError('invalid-response', 'A linked scope target conflicts with an existing item.');
          }
          continue;
        }
        const persisted = await this.#item(db, target.Id);
        if (persisted && (!this.#isManagedIdentity(persisted, plan.root.Id) || persisted.NativeType !== target.nativeType
          || persisted.IsFolder !== target.draft.IsFolder || !samePath(persisted.Path, target.identityPath))) {
          throw new StorageError('invalid-response', 'A linked scope target conflicts with an existing item.');
        }
        if (pathCatalog.owners(target.identityPath).some(owner => !sameId(owner.Id, target.Id)
          && !removalIds.has(idKey(owner.Id)))) {
          throw new StorageError('invalid-response', `The linked scope target path is already owned by another item: ${target.identityPath}`);
        }
        items.push(createResolvedItemEntity(target, {
          parent: folder,
          parents,
          metadataConfiguration: this.metadataConfiguration,
          clock: this.clock
        }));
      }
      return items;
    }, { signal, readOnly: true, lockTimeoutMs: folderScanLockTimeoutMs });
  }

  async #materializeScopeCreations(plan, items, signal, state) {
    if (!items.length) return;
    state.irreversibleLifecycle = true;
    const parent = await this.itemCreation.getItemById(plan.folder.Id) ?? plan.folder;
    await this.library.createItems(items, parent, { signal });
    for (const item of items) state.linkedChanges.added.add(idKey(item.Id));
    await this.#refreshScopeSnapshot(plan);
  }

  async #ensureActionTarget(plan, target, signal, state) {
    const item = await this.itemCreation.getItemById(target.Id);
    this.#assertActionTarget(plan, target, item);
    if (await this.#promoteVersion(item, signal)) state.linkedChanges.updated.add(idKey(item.Id));
    return item;
  }

  async #runLinkedScopeActions(plan, signal, state) {
    if (plan.linkedNativeAction !== true) return;
    const actions = plan.linkedActions ?? this.#linkedScopeActions(plan);
    if (!actions.stale.length && !actions.deletions.length
      && !actions.replacements.length && !actions.demotions.length
      && !actions.directoryDiscPromotions.length && !actions.directoryDiscCreations.length) return;
    this.#requireLinkedActionServices(actions);
    const promotions = actions.directoryDiscPromotions;
    const discCreations = actions.directoryDiscCreations;
    const removals = [...new Map([
      ...(actions.deletionRoots ?? this.#linkedDeletionRoots(actions)),
      ...promotions.map(action => action.source)
    ].map(item => [idKey(item.Id), item])).values()];
    const unsupportedRemoval = removals.find(item => !['Movie', 'MusicVideo', 'Video', 'Folder'].includes(itemType(item)));
    if (unsupportedRemoval) {
      throw new StorageError('not-supported',
        `Linked folder reconciliation cannot run the deletion lifecycle for ${unsupportedRemoval.NativeType ?? unsupportedRemoval.Type}.`);
    }
    for (const action of [...actions.replacements, ...actions.demotions, ...promotions]) {
      action.liveSource = await this.itemCreation.getItemById(action.source.Id);
      if (!action.liveSource) throw new StorageError('version-changed', 'A linked action source disappeared.');
      if (promotions.includes(action) && !this.#sameDirectoryDiscSource(action.source, action.liveSource)) {
        throw this.#directoryDiscPromotionFailure(action, 'the live source changed after enumeration');
      }
    }
    // Folder.ValidateChildren materializes the complete new-sibling batch once,
    // after ordinary removals and before either linked-version action loop.
    // Resolve and preflight the whole batch before the first deletion side effect.
    const creations = await this.#prepareScopeCreations(plan,
      new Set(removals.map(item => idKey(item.Id))), signal);
    if (promotions.length || discCreations.length) {
      const nativeTargets = new Set([
        ...promotions.map(action => idKey(action.target.Id)),
        ...discCreations.map(action => idKey(action.target.Id))
      ]);
      if (creations.length !== nativeTargets.size
        || creations.some(item => !nativeTargets.has(idKey(item.Id)))) {
        throw this.#directoryDiscPromotionFailure(promotions[0] ?? discCreations[0]?.parentAction,
          'the creation batch is not isolated to the reclassified identities');
      }
    }
    if (promotions.length) {
      await this.store.run(async db => {
        for (const action of promotions) {
          const previousKeys = action.removedUserDataKeys;
          await this.#validateDirectoryDiscPromotion(db, plan, action, signal);
          if (previousKeys.length !== action.removedUserDataKeys.length
            || previousKeys.some((key, index) => key !== action.removedUserDataKeys[index])) {
            throw this.#directoryDiscPromotionFailure(action, 'the user-data identity keys changed before deletion');
          }
        }
      }, { signal, readOnly: true, lockTimeoutMs: folderScanLockTimeoutMs });
    }
    const parent = await this.itemCreation.getItemById(plan.folder.Id) ?? plan.folder;
    // DeleteItem owns primary promotion, alternate rerouting, primary cleanup,
    // final relation closure, live-cache eviction and removal events.
    for (const snapshot of removals) {
      const item = await this.itemCreation.getItemById(snapshot.Id);
      if (!item) {
        if (state.linkedChanges.removed.has(idKey(snapshot.Id))) continue;
        throw new StorageError('version-changed', 'A linked deletion candidate disappeared.');
      }
      state.irreversibleLifecycle = true;
      await this.library.deleteItem(item, { DeleteFileLocation: false }, parent, false);
      state.linkedChanges.removed.add(idKey(item.Id));
      await this.#refreshScopeSnapshot(plan, state.linkedChanges.removed);
    }
    await this.#materializeScopeCreations(plan, creations, signal, state);
    for (const action of promotions.filter(value => value.mode !== 'folder')) {
      const target = await this.itemCreation.getItemById(action.target.Id);
      this.#assertActionTarget(plan, action.target, target);
      const matches = await this.store.run(async db => {
        const keys = await userDataKeys(db, target);
        return keys.some(key => action.removedUserDataKeys.includes(key));
      }, { signal, readOnly: true, lockTimeoutMs: folderScanLockTimeoutMs });
      if (matches) {
        state.irreversibleLifecycle = true;
        await this.reattach(this.store, target, { signal });
      }
    }
    // Native processes each replacement to completion before advancing to the
    // next: promote -> reroute -> transfer -> clear/delete.
    for (const action of actions.replacements) {
      const source = action.liveSource;
      if (!source) throw new StorageError('version-changed', 'A replaced primary disappeared.');
      const target = await this.#ensureActionTarget(plan, action.target, signal, state);
      const versions = await this.#alternateVersions(source);
      state.irreversibleLifecycle = true;
      await this.linkedChildReferences.reroute(source.Id, target.Id);
      const transferred = await this.#transferVersions(source, target, signal, versions);
      for (const id of transferred) state.linkedChanges.updated.add(id);
      source.LocalAlternateVersions = [];
      source.LinkedAlternateVersions = [];
      await this.library.deleteItem(source, { DeleteFileLocation: false }, parent, false);
      state.linkedChanges.removed.add(idKey(source.Id));
      await this.#refreshScopeSnapshot(plan, state.linkedChanges.removed);
    }
    // Demotions have the inverse native boundary: all owned versions and the
    // old primary are saved under the new primary before external rerouting.
    for (const action of actions.demotions) {
      const source = action.liveSource;
      if (!source) throw new StorageError('version-changed', 'A demoted primary disappeared.');
      const target = await this.#ensureActionTarget(plan, action.target, signal, state);
      const versions = await this.#alternateVersions(source);
      const transferred = await this.#transferVersions(source, target, signal, versions);
      for (const id of transferred) state.linkedChanges.updated.add(id);
      source.LocalAlternateVersions = [];
      source.LinkedAlternateVersions = [];
      setPrimaryVersion(source, target.Id);
      source.OwnerId = target.Id;
      await this.#updateVersion(source, signal);
      state.linkedChanges.updated.add(idKey(source.Id));
      state.irreversibleLifecycle = true;
      await this.linkedChildReferences.reroute(source.Id, target.Id);
      await this.#refreshScopeSnapshot(plan);
    }
  }

  async #applyPlanByScope(plan, context, signal, state, committed, folder = plan.folder) {
    await this.#applyResolvedItemLifecycleScope(plan, signal, state);
    await this.#runLinkedScopeActions(plan, signal, state);
    const scope = await this.#commitStructuralScope(plan, folder, context, signal, state);
    committed();
    if (scope.journal) {
      state.journals.push(scope.journal);
      this.#publish(scope.journal);
    }
    this.refreshes.reportProgress(folder, 10);
    const aggregate = {
      added: scope.receipt.added,
      updated: scope.receipt.updated,
      removed: scope.receipt.removed,
      skippedDeletion: scope.receipt.skippedDeletion,
      incompleteReasons: [...scope.receipt.incompleteReasons]
    };
    for (let index = 0; index < scope.children.length; index++) {
      checkAbort(signal);
      const child = scope.children[index];
      const childPlan = plan.children.get(idKey(child.Id));
      if (!childPlan) throw new StorageError('version-changed', 'The storage plan changed during reconciliation.');
      let childResult;
      try {
        childResult = await this.#applyPlanByScope(childPlan, context, signal, state, committed, child);
      } catch (error) {
        if (!childPlan.linkedActions?.directoryDiscCreations?.length) throw error;
        // Native ValidateSubFolders isolates and reports a nested validation
        // failure after the outer Folder has already completed its own
        // DeleteItem/CreateItems lifecycle.
        this.#report(error);
        aggregate.skippedDeletion = true;
        aggregate.incompleteReasons.push(incompleteReason(
          folderScanIncompleteReasonCodes.NESTED_VALIDATION_FAILED, child));
        this.refreshes.reportProgress(folder, 10 + 40 * (index + 1) / scope.children.length);
        continue;
      }
      aggregate.added += childResult.added;
      aggregate.updated += childResult.updated;
      aggregate.removed += childResult.removed;
      aggregate.skippedDeletion ||= childResult.skippedDeletion;
      aggregate.incompleteReasons.push(...childResult.incompleteReasons);
      this.refreshes.reportProgress(folder, 10 + 40 * (index + 1) / scope.children.length);
    }
    this.refreshes.reportProgress(folder, 50);
    const { incompleteReasons, ...counts } = aggregate;
    return scanReceipt({ ...counts, emptyTopFolder: scope.receipt.emptyTopFolder }, incompleteReasons);
  }

  #linkedResult(structuralResult, state) {
    const added = new Set(state.linkedChanges.added);
    const updated = new Set([...state.linkedChanges.updated, ...state.lifecycleUpdates]);
    const removed = new Set(state.linkedChanges.removed);
    for (const journal of state.journals) {
      for (const { item } of journal.added) added.add(idKey(item.Id));
      for (const { item } of journal.updated) updated.add(idKey(item.Id));
      for (const { item } of journal.removed) removed.add(idKey(item.Id));
    }
    for (const id of removed) {
      added.delete(id);
      updated.delete(id);
    }
    for (const id of added) updated.delete(id);
    return Object.freeze({ ...structuralResult,
      added: added.size,
      updated: updated.size,
      removed: removed.size });
  }

  #pathRows(db, paths = []) {
    return loadPostgresRowsByPaths(db, paths);
  }

  async #verifyPathOwnership(db, state) {
    const touched = [...state.touchedPaths.values()], claimed = [...state.claimedPaths.values()];
    const verify = (current, selectedTouched, selectedClaimed) => {
      for (const target of selectedTouched) {
        const owners = current.owners(target.path);
        if (!owners.some(owner => sameId(owner.Id, target.Id))
          || owners.some(owner => !sameId(owner.Id, target.Id))) {
          throw new StorageError('invalid-response', 'The folder path changed ownership during reconciliation.');
        }
      }
      for (const target of selectedClaimed) {
        const owners = current.owners(target.path);
        if (target.persistedId == null ? owners.length
          : !owners.some(owner => sameId(owner.Id, target.persistedId))
            || owners.some(owner => !sameId(owner.Id, target.persistedId))) {
          throw new StorageError('invalid-response', 'A consumed sibling path changed ownership during reconciliation.');
        }
      }
    };
    const targets = new Map([...touched, ...claimed].map(target => [pathKey(target.path), target.path]));
    const paths = [...targets.values()];
    for (let offset = 0; offset < paths.length; offset += postgresPathOwnershipBatchSize) {
      const batch = paths.slice(offset, offset + postgresPathOwnershipBatchSize);
      const keys = new Set(batch.map(pathKey));
      verify(createPathCatalog(await this.#pathRows(db, batch)),
        touched.filter(target => keys.has(pathKey(target.path))),
        claimed.filter(target => keys.has(pathKey(target.path))));
    }
  }

  #idValues(value) {
    let native;
    try { native = nativeGuid(value); } catch { native = String(value); }
    const compact = native.replaceAll('-', '');
    return [...new Set([native, String(value), native.toLowerCase(), compact, compact.toLowerCase()])];
  }

  async #item(db, value) {
    if (!nonemptyId(value)) return null;
    const [row] = await loadPostgresRowsByIds(db, [value]);
    if (row) {
      const item = mapRecord(row);
      if (!item) return null;
      if (this.library.options.expandPath) item.Path = this.library.options.expandPath(item.Path);
      for (const provider of await db.rows('BaseItemProviders', { where: { ItemId: item.Id } })) {
        item.ProviderIds[provider.ProviderId] = provider.ProviderValue;
      }
      return item;
    }
    return null;
  }

  async #children(db, parentId) {
    const items = parseItems(await db.rows('BaseItems', { where: { ParentId: parentId } }));
    if (this.library.options.expandPath) for (const item of items) item.Path = this.library.options.expandPath(item.Path);
    return items;
  }

  async #owned(db, ownerId) {
    const items = parseItems(await db.rows('BaseItems', { where: { OwnerId: ownerId } }));
    if (this.library.options.expandPath) for (const item of items) item.Path = this.library.options.expandPath(item.Path);
    return items;
  }

  async #loadContext(reference, signal) {
    const requestedId = typeof reference === 'object' ? reference?.Id : reference;
    if (!requestedId) throw new TypeError('A folder reference with an Id is required.');
    return this.store.run(async db => {
      const folder = await this.#item(db, requestedId);
      if (!folder) throw Object.assign(new Error('Folder not found.'), { status: 404, statusCode: 404 });
      if (!this.supports(folder)) unsupported(`Folder tree reconciliation is not implemented for ${folder.Type}.`);
      let root = nonemptyId(repositoryTopParentId(folder))
        ? sameId(repositoryTopParentId(folder), folder.Id) ? folder : await this.#item(db, repositoryTopParentId(folder))
        : null;
      if (!root) {
        root = folder;
        const visited = new Set();
        while (root && !visited.has(idKey(root.Id))) {
          visited.add(idKey(root.Id));
          const parent = await this.#item(db, root.ParentId);
          if (!parent || itemType(parent) === 'AggregateFolder') break;
          root = parent;
        }
      }
      if (!root || !this.#supportsPhysicalRoot(root)) {
        throw new StorageError('invalid-response', 'The folder has no supported physical top parent.');
      }
      const state = await this.#relationState(db, root);
      this.#rememberRelationItem(state, folder);
      await this.#loadLineage(db, folder, state);
      const parents = parentChainForItem(folder, state);
      this.#validateDirectRootLineage(folder, root, parents);
      return {
        folder,
        root,
        parents,
        parentSignature: scanLineageSignature(parents),
        collectionContext: await this.#collectionContext(db, root, state)
      };
    }, {
      signal,
      readOnly: true,
      lockTimeoutMs: folderScanLockTimeoutMs
    });
  }

  #rememberRelationItem(state, item, persisted = true) {
    const key = idKey(item.Id), previous = state.items.findIndex(value => sameId(value.Id, item.Id));
    state.byId.set(key, item);
    if (previous < 0) state.items.push(item); else state.items[previous] = item;
    if (persisted) state.persistedIds.add(key);
  }

  async #loadLineage(db, item, state) {
    const visited = new Set();
    while (item && !visited.has(idKey(item.Id))) {
      visited.add(idKey(item.Id));
      const lookup = async id => {
        if (!nonemptyId(id)) return null;
        const key = idKey(id);
        if (state.byId.has(key)) return state.byId.get(key);
        if (state.missing.has(key)) return null;
        const found = await this.#item(db, id);
        if (found) this.#rememberRelationItem(state, found); else state.missing.add(key);
        return found;
      };
      item = await lookup(item.ParentId) ?? await lookup(item.OwnerId);
    }
  }

  async #relationState(db, root) {
    const state = { items: [], byId: new Map(), persistedIds: new Set(), missing: new Set(), values: null };
    this.#rememberRelationItem(state, root);
    const [row] = await db.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.UserRootFolder' }, limit: 1 });
    const userRoot = row ? mapRecord(row) : this.library.options.userRoot ? mapRecord(this.library.options.userRoot) : null;
    if (userRoot) {
      if (this.library.options.expandPath) userRoot.Path = this.library.options.expandPath(userRoot.Path);
      this.#rememberRelationItem(state, userRoot, row != null);
      for (const child of await this.#children(db, userRoot.Id)) {
        this.#rememberRelationItem(state, child);
        if (nonemptyId(child.PrimaryVersionId)) {
          const primary = await this.#item(db, child.PrimaryVersionId);
          if (primary) this.#rememberRelationItem(state, primary);
        }
      }
    }
    await this.#loadLineage(db, root, state);
    return state;
  }

  async #collectionContext(db, root, state) {
    state ??= await this.#relationState(db, root);
    return buildScanCollectionContext({
      root,
      collectionFolders: collectionFoldersForItem(root, state),
      state,
      libraryOptions: this.library.options.libraryOptions,
      configuration: this.configuration
    });
  }

  #accessPath(folder) {
    const style = pathStyle(folder.Path);
    const accessPath = this.identityMap.resolve({ itemId: folder.Id, identityPath: folder.Path, style });
    const reverse = this.identityMap.identityFor(accessPath);
    if (reverse.style !== style || !samePath(reverse.identityPath, folder.Path)
      || this.identityMap.resolve({ identityPath: reverse.identityPath, style: reverse.style }) !== accessPath) {
      throw new StorageError('invalid-response', 'The folder access mapping is not reversibly bound to its identity path.');
    }
    return accessPath;
  }

  #isDirectAccessChild(item, parent) {
    try { return parentPath(this.#accessPath(item)) === this.#accessPath(parent); }
    catch { return false; }
  }

  #classifyEntries(accessPath, entries) {
    const paths = new Set();
    const candidates = [];
    for (const entry of entries) {
      const childAccessPath = joinPath(accessPath, entry.name);
      const identity = this.identityMap.identityFor(childAccessPath);
      const forward = this.identityMap.resolve({ identityPath: identity.identityPath, style: identity.style });
      if (forward !== childAccessPath) throw new StorageError('invalid-response', 'A child folder identity mapping is not reversible.');
      const identityKey = pathKey(identity.identityPath);
      if (paths.has(identityKey)) {
        throw new StorageError('invalid-response', 'The directory listing contains ambiguous native paths.');
      }
      paths.add(identityKey);
      candidates.push({ identityPath: identity.identityPath, accessPath: childAccessPath, entry });
    }
    candidates.sort((left, right) => compareNativePaths(left.identityPath, right.identityPath));
    return { candidates, observedPaths: paths };
  }

  async #filterResolutionCandidates(classified, parent, root, signal) {
    const candidates = await filterResolutionCandidates(classified.candidates, {
      ignoreRule: this.ignoreRule,
      parent, root, applicationRootPath: this.applicationRootPath, signal
    });
    return { candidates, observedPaths: new Set(candidates.map(candidate => pathKey(candidate.identityPath))) };
  }

  async #filterExtraCandidates(snapshot, signal) {
    const candidates = [];
    for (const candidate of snapshot.candidates) {
      checkAbort(signal);
      const ignored = await this.ignoreRule.shouldIgnore(candidate.identityPath, {
        isDirectory: candidate.entry.kind === 'directory', signal
      });
      checkAbort(signal);
      if (!ignored) candidates.push(candidate);
    }
    return { ...snapshot, candidates };
  }

  async #capture(folderSnapshot, rootSnapshot, signal) {
    return this.store.run(async db => {
      const folder = await this.#item(db, folderSnapshot.Id);
      const root = sameId(folderSnapshot.Id, rootSnapshot.Id) ? folder : await this.#item(db, rootSnapshot.Id);
      if (!folder || !root || !this.#supportsTraversal(folder) || !this.#supportsPhysicalRoot(root)
        || !sameId(folder.Id, root.Id) && !sameId(repositoryTopParentId(folder), root.Id)) {
        throw new StorageError('version-changed', 'The folder hierarchy changed before enumeration.');
      }
      const direct = await this.#children(db, folder.Id);
      return { folder, root, direct, directSignature: directChildrenSignature(direct, folder.Id) };
    }, {
      signal,
      readOnly: true,
      lockTimeoutMs: folderScanLockTimeoutMs
    });
  }

  async #enumerateFolder(folder, root, collectionContext, accessPath, signal, persisted, top, lifecycle, preparedListing = null,
    parents = collectionContext.parents) {
    checkAbort(signal);
    let captured;
    if (persisted) {
      captured = await this.#capture(folder, root, signal);
      folder = captured.folder;
      if (top) root = captured.root;
    } else {
      const direct = await this.store.run(db => this.#children(db, folder.Id), {
        signal,
        readOnly: true,
        lockTimeoutMs: folderScanLockTimeoutMs
      });
      captured = { folder, root, direct, directSignature: directChildrenSignature(direct, folder.Id) };
    }
    const lifecycleKey = idKey(folder.Id);
    if (!lifecycle.has(lifecycleKey)) {
      lifecycle.set(lifecycleKey, folder);
      this.refreshes.reportStarted(folder);
    }
    accessPath ??= this.#accessPath(folder);
    const listing = preparedListing == null ? await this.vfs.list(accessPath, { signal })
      : typeof preparedListing === 'function' ? await preparedListing()
        : preparedListing;
    checkAbort(signal);
    const pathCollectionContext = scanCollectionContextForItem(collectionContext, folder, parents);
    const raw = { listing, ...this.#classifyEntries(accessPath, listing.entries) };
    const classified = await this.#filterResolutionCandidates(
      raw, folder, root, signal);
    if (top && sameId(folder.Id, root.Id) && listing.entries.length === 0) {
      return { folder, root, persisted, existingItems: captured.direct, children: new Map(), deletionSafe: listing.deletionSafe === true,
        emptyTopFolder: true };
    }
    const directorySnapshots = new Map();
    const peekDirectory = (candidate, { forExtras = false } = {}) => {
      if (candidate?.entry?.kind !== 'directory') throw new TypeError('Only directory candidates can be enumerated.');
      const key = pathKey(candidate.identityPath);
      if (!directorySnapshots.has(key)) directorySnapshots.set(key, { raw: (async () => {
        const childListing = await this.vfs.list(candidate.accessPath, { signal });
        checkAbort(signal);
        return { listing: childListing, ...this.#classifyEntries(candidate.accessPath, childListing.entries) };
      })() });
      const snapshots = directorySnapshots.get(key);
      // FindExtras counts every nested file before ResolveExtraFile applies
      // ignore rules. Keep that observation separate from the resolver view.
      if (forExtras) return snapshots.raw;
      snapshots.filtered ??= (async () => {
        const raw = await snapshots.raw;
        const childClassified = await this.#filterResolutionCandidates(raw, folder, root, signal);
        return { listing: { ...raw.listing, entries: childClassified.candidates.map(child => child.entry) }, ...childClassified };
      })();
      return snapshots.filtered;
    };
    let rootExtraSnapshot;
    const getExtraCandidates = candidate => {
      if (candidate == null) return rootExtraSnapshot ??= this.#filterExtraCandidates(raw, signal);
      const rawSnapshot = peekDirectory(candidate, { forExtras: true }), snapshots = directorySnapshots.get(pathKey(candidate.identityPath));
      return snapshots.extras ??= rawSnapshot.then(snapshot => this.#filterExtraCandidates(snapshot, signal));
    };
    const resolution = await this.resolverPipeline.resolve({
      parent: folder,
      root,
      collectionContext: pathCollectionContext,
      candidates: classified.candidates,
      peekDirectory,
      getExtraCandidates,
      resolveExtra: async ({ candidate }) => (await filterResolutionCandidates([candidate], {
        ignoreRule: this.ignoreRule, applicationRootPath: this.applicationRootPath, signal
      })).length > 0,
      deletionSafe: listing.deletionSafe === true,
      signal
    });
    const directoryPaths = new Set(classified.candidates
      .filter(candidate => candidate.entry.kind === 'directory')
      .map(candidate => pathKey(candidate.identityPath)));
    const peekScopes = new Map();
    for (const candidate of classified.candidates) {
      const key = pathKey(candidate.identityPath);
      if (candidate.entry.kind !== 'directory' || !directorySnapshots.has(key)) continue;
      const snapshots = directorySnapshots.get(key), snapshot = await (snapshots.filtered ?? snapshots.raw);
      peekScopes.set(key, {
        path: candidate.identityPath,
        deletionSafe: snapshot.listing?.deletionSafe === true,
        observedPaths: new Set(snapshot.observedPaths ?? [])
      });
    }
    const direct = byId(captured.direct);
    const children = new Map();
    for (const target of resolution.claims.filter(claim => claim.traversal === 'children')) {
      const existing = direct.get(idKey(target.Id));
      const targetStructure = tvStructure(target, folder, root);
      const compatibleIdentity = Boolean(existing && this.#isManagedItem(existing, root.Id)
        && existing.NativeType === target.nativeType
        && existing.IsFolder === target.draft.IsFolder
        && samePath(existing.Path, target.identityPath)
        && sameId(existing.ParentId, folder.Id));
      if (compatibleIdentity) this.#assertExistingTvStructure(existing, target, folder, root);
      const useExisting = compatibleIdentity;
      const child = useExisting ? existing : plannedTraversalItem(target, folder, root);
      children.set(idKey(target.Id), await this.#enumerateFolder(child, root, collectionContext, target.accessPath, signal,
        useExisting, false, lifecycle, async () => (await peekDirectory(target.primary)).listing, [folder, ...parents]));
    }
    return {
      folder,
      root,
      persisted,
      existingItems: captured.direct,
      desired: resolution.claims,
      observedPaths: classified.observedPaths,
      withheldPaths: resolution.withheldPaths,
      directoryPaths,
      peekScopes,
      collectionContext: pathCollectionContext,
      deletionSafe: listing.deletionSafe === true,
      directSignature: captured.directSignature,
      children,
      emptyTopFolder: false
    };
  }

  async #applyScopePlan(db, plan, folder, root, signal, state) {
    if (plan.emptyTopFolder) {
      const reasons = [incompleteReason(folderScanIncompleteReasonCodes.EMPTY_TOP_FOLDER_PROTECTED, folder)];
      if (!plan.deletionSafe) {
        reasons.push(incompleteReason(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, folder));
      }
      return {
        receipt: scanReceipt(
          { added: 0, updated: 0, removed: 0, skippedDeletion: true, emptyTopFolder: true }, reasons),
        journal: null,
        children: []
      };
    }
    const result = await this.#reconcile(db, folder, root, plan.desired, plan.observedPaths,
      plan.withheldPaths, plan.directoryPaths, plan.peekScopes, plan.collectionContext,
      plan.deletionSafe, plan.directSignature, signal, state, plan);
    const counts = {
      added: result.journal.added.length,
      updated: result.journal.updated.length,
      removed: result.journal.removed.length,
      skippedDeletion: result.skippedDeletion
    };
    return {
      receipt: scanReceipt({ ...counts, emptyTopFolder: false }, result.incompleteReasons),
      journal: result.journal,
      children: result.children
    };
  }

  async #applyPlan(db, plan, folder, root, signal, state) {
    if (plan.emptyTopFolder) {
      const reasons = [incompleteReason(folderScanIncompleteReasonCodes.EMPTY_TOP_FOLDER_PROTECTED, folder)];
      if (!plan.deletionSafe) {
        reasons.push(incompleteReason(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, folder));
      }
      return scanReceipt(
        { added: 0, updated: 0, removed: 0, skippedDeletion: true, emptyTopFolder: true }, reasons);
    }
    state.pathCatalog = createPathCatalog(await this.#pathRows(db, scanPlanPaths(plan)));
    const result = await this.#reconcile(db, folder, root, plan.desired, plan.observedPaths,
      plan.withheldPaths, plan.directoryPaths, plan.peekScopes, plan.collectionContext,
      plan.deletionSafe, plan.directSignature, signal, state, plan);
    state.journals.push(result.journal);
    state.progress.push({ folder, progress: 10 });
    const aggregate = {
      added: result.journal.added.length,
      updated: result.journal.updated.length,
      removed: result.journal.removed.length,
      skippedDeletion: result.skippedDeletion,
      incompleteReasons: [...result.incompleteReasons]
    };
    for (let index = 0; index < result.children.length; index++) {
      checkAbort(signal);
      const child = result.children[index];
      const childPlan = plan.children.get(idKey(child.Id));
      if (!childPlan) throw new StorageError('version-changed', 'The storage plan changed during reconciliation.');
      const childResult = await this.#applyPlan(db, childPlan, child, root, signal, state);
      aggregate.added += childResult.added;
      aggregate.updated += childResult.updated;
      aggregate.removed += childResult.removed;
      aggregate.skippedDeletion ||= childResult.skippedDeletion;
      aggregate.incompleteReasons.push(...childResult.incompleteReasons);
      state.progress.push({ folder, progress: 10 + 40 * (index + 1) / result.children.length });
    }
    state.progress.push({ folder, progress: 50 });
    const { incompleteReasons, ...counts } = aggregate;
    return scanReceipt({ ...counts, emptyTopFolder: false }, incompleteReasons);
  }

  #resolvedDraft(target) {
    return { ...target.draft.data, Type: target.nativeType,
      IsInMixedFolder: target.draft.columns?.IsInMixedFolder ?? false };
  }

  #isSameIdentityDirectoryStackUpdate(existing, target, plan) {
    const desiredParts = target.draft.data?.AdditionalParts;
    if (plan.deletionSafe !== true || existing.IsFolder !== false
      || target.entry?.kind !== 'directory' || target.primary?.entry?.kind !== 'directory'
      || !Array.isArray(target.directoryParts) || target.directoryParts.length === 0
      || !Array.isArray(desiredParts) || desiredParts.length !== target.directoryParts.length
      || !Array.isArray(existing.AdditionalParts) || existing.AdditionalParts.length === 0
      || !['Dvd', 'BluRay'].includes(existing.VideoType)
      || target.draft.data?.VideoType !== existing.VideoType
      || (existing.LocalAlternateVersions ?? []).length
      || (target.draft.data?.LocalAlternateVersions ?? []).length
      || target.localAlternates?.length || target.ownedParts?.length || target.ownedExtras?.length) return false;
    const scope = plan.peekScopes.get(pathKey(target.primary.identityPath));
    if (scope?.deletionSafe !== true
      || !scope.observedPaths.has(pathKey(target.identityPath))
      || target.directoryParts.some(part => !scope.observedPaths.has(pathKey(part.identityPath)))) return false;
    const nativePath = pathStyle(target.primary.identityPath) === 'windows' ? path.win32 : path.posix;
    const outer = pathKey(target.primary.identityPath), persisted = new Set();
    for (const part of existing.AdditionalParts) {
      if (typeof part !== 'string' || part.length === 0) return false;
      const key = pathKey(part);
      if (key === pathKey(existing.Path) || pathKey(nativePath.dirname(part)) !== outer || persisted.has(key)) return false;
      persisted.add(key);
    }
    return desiredParts.every((part, index) => samePath(part, target.directoryParts[index].identityPath));
  }

  #validateLifecyclePlan(plan) {
    if (!plan.persisted && plan.existingItems?.length) {
      throw new StorageError('version-changed',
        'An uncommitted folder acquired repository children before reconciliation.');
    }
    for (const child of plan.children.values()) this.#validateLifecyclePlan(child);
  }

  async #applyResolvedItemLifecycleScope(plan, signal, state) {
    if (plan.emptyTopFolder) return;
    checkAbort(signal);
    const direct = byId(plan.existingItems ?? []);
    for (const target of plan.desired) {
      const existing = direct.get(idKey(target.Id));
      if (!existing || !this.#isManagedItem(existing, plan.root.Id)
        || existing.NativeType !== target.nativeType
        || existing.IsFolder !== target.draft.IsFolder
        || !samePath(existing.Path, target.identityPath)
        || !sameId(existing.ParentId, plan.folder.Id)) continue;
      const structureChanged = field => {
        const current = Array.isArray(existing[field]) ? existing[field] : [];
        const desired = Array.isArray(target.draft.data?.[field]) ? target.draft.data[field] : [];
        return current.length !== desired.length || current.some((value, index) => value !== desired[index]);
      };
      // Ownership rows and their declaring path arrays form one structural
      // transaction. Defer changed arrays to reconciliation so an owned-row
      // failure cannot leave the primary advertising a partial family.
      const additionalPartsChanged = structureChanged('AdditionalParts');
      if (structureChanged('LocalAlternateVersions')
        || additionalPartsChanged && !this.#isSameIdentityDirectoryStackUpdate(existing, target, plan)) continue;
      // Native mixed-folder state includes direct video extras. When this
      // resolver owns the extra family, persist the flag with the owned rows
      // so a failed insert or delete rolls the whole structural change back.
      if (target.ownsOwnedExtras === true
        && existing.IsInMixedFolder !== (target.draft.columns?.IsInMixedFolder ?? false)) continue;
      // A weak listing cannot prove a previously owned local version is gone.
      // Leave the primary's version array untouched; structural reconciliation
      // either adds a fully observed version or preserves the existing family.
      if (!plan.deletionSafe && (Array.isArray(existing.LocalAlternateVersions)
        && existing.LocalAlternateVersions.length || Array.isArray(existing.AdditionalParts)
        && existing.AdditionalParts.length)) continue;
      this.#assertExistingTvStructure(existing, target, plan.folder, plan.root);
      // Once native existing-item work begins, saver, image or repository
      // side effects can survive any later failure. Never retry the tree.
      const outcome = await this.resolvedItemLifecycle.apply(existing.Id, {
        resolved: this.#resolvedDraft(target),
        expected: structuralSnapshot(existing),
        signal,
        markIrreversible: () => { state.irreversibleLifecycle = true; }
      });
      state.lifecycleApplied.add(idKey(existing.Id));
      if (outcome?.changed === true) state.lifecycleUpdates.add(idKey(existing.Id));
    }
    // Native completes the current folder before starting ValidateSubFolders.
    // The scope runner observes cancellation and applies child lifecycles only
    // after this folder's structural journal has committed and published.
    checkAbort(signal);
  }

  async #applyResolvedItemLifecycles(plan, signal, state) {
    if (plan.emptyTopFolder) return;
    await this.#applyResolvedItemLifecycleScope(plan, signal, state);
    for (const target of plan.desired) {
      const childPlan = plan.children.get(idKey(target.Id));
      if (childPlan) await this.#applyResolvedItemLifecycles(childPlan, signal, state);
    }
  }

  #isManagedIdentity(item, rootId, allowMissingTopParent = false) {
    const nativeType = item?.NativeType ?? item?.Type;
    if (!this.resolverPipeline.manages(item) || item?.CanDelete === false || !librarySource(item?.SourceType)
      || item?.IsVirtualItem || typeof item?.Path !== 'string' || !item.Path) return false;
    if (!sameId(repositoryTopParentId(item), rootId)
      && !(allowMissingTopParent && !nonemptyId(repositoryTopParentId(item)))) return false;
    try {
      const expected = nativeGuid(getNewItemId(item.Path, nativeType, {
        programDataPath: this.programDataPath,
        enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
      }));
      return sameId(expected, item.Id);
    } catch { return false; }
  }

  #isManagedExtraIdentity(item) {
    const nativeType = item?.NativeType ?? item?.Type;
    if (!this.resolverPipeline.manages(item) || item?.CanDelete === false || !librarySource(item?.SourceType)
      || item?.IsVirtualItem || item?.IsFolder !== false || typeof item?.Path !== 'string' || !item.Path
      || !nonemptyId(item?.OwnerId) || nonemptyId(item?.PrimaryVersionId) || nonemptyId(item?.ParentId)
      || nonemptyId(repositoryTopParentId(item)) || !Number.isInteger(extraTypeCode(item?.ExtraType))
      || extraTypeCode(item.ExtraType) < 0 || extraTypeCode(item.ExtraType) > 11) return false;
    try {
      const expected = nativeGuid(getNewItemId(item.Path, nativeType, {
        programDataPath: this.programDataPath,
        enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
      }));
      return sameId(expected, item.Id);
    } catch { return false; }
  }

  #isManagedPartIdentity(item, rootId) {
    return this.#isManagedIdentity(item, rootId) && item?.NativeType === videoNativeType
      && item?.IsFolder === false && nonemptyId(item?.OwnerId) && !nonemptyId(item?.PrimaryVersionId)
      && nonemptyId(item?.ParentId) && item?.ExtraType == null;
  }

  #isManagedItem(item, rootId) {
    return this.#isManagedIdentity(item, rootId)
      && !nonemptyId(item?.OwnerId) && !nonemptyId(item?.PrimaryVersionId);
  }

  async #localAlternateOwner(db, item, rootId) {
    if (!this.#isManagedIdentity(item, rootId) || !nonemptyId(item?.OwnerId)
      || !sameId(item.OwnerId, item.PrimaryVersionId)) return null;
    const owner = await this.#item(db, item.OwnerId);
    if (!owner || !this.#isManagedItem(owner, rootId)
      || owner.NativeType !== item.NativeType || owner.IsFolder !== item.IsFolder
      || !sameId(owner.ParentId, item.ParentId)) return null;
    const links = await db.rows('LinkedChildren', { where: { ParentId: owner.Id,ChildId:item.Id,ChildType:2 },limit:1 });
    return links.some(link => sameId(link.ChildId, item.Id) && Number(link.ChildType) === 2) ? owner : null;
  }

  async #ownedExtraOwner(db, item, rootId) {
    if (!this.#isManagedExtraIdentity(item)) return null;
    const owner = await this.#item(db, item.OwnerId);
    if (!owner || !this.#isManagedIdentity(owner, rootId) || owner.ExtraType != null) return null;
    if (!nonemptyId(owner.OwnerId) && !nonemptyId(owner.PrimaryVersionId)) return owner;
    return await this.#localAlternateOwner(db, owner, rootId) ? owner : null;
  }

  async #ownedPartOwner(db, item, rootId) {
    if (!this.#isManagedPartIdentity(item, rootId)) return null;
    const owner = await this.#item(db, item.OwnerId);
    if (!owner || !this.#isManagedIdentity(owner, rootId) || owner.ExtraType != null
      || !sameId(owner.ParentId, item.ParentId) || !sameId(repositoryTopParentId(owner), repositoryTopParentId(item))) return null;
    if (!nonemptyId(owner.OwnerId) && !nonemptyId(owner.PrimaryVersionId)) return owner;
    return await this.#localAlternateOwner(db, owner, rootId) ? owner : null;
  }

  #collapsedItemContainerPath(item, parent, collectionContext) {
    if (!supportsCollapsedItemType(collectionContext, item?.NativeType)
      || item?.IsFolder !== false
      || item?.IsInMixedFolder !== false
      || !sameId(item?.ParentId, parent?.Id)) return null;
    try {
      const itemAccessPath = this.#accessPath(item);
      const parentAccessPath = this.#accessPath(parent);
      const containerAccessPath = parentPath(itemAccessPath);
      if (parentPath(containerAccessPath) !== parentAccessPath) return null;
      const container = this.identityMap.identityFor(containerAccessPath);
      if (!nativePathWithin(item.Path, container.identityPath)
        || samePath(item.Path, container.identityPath)) return null;
      return container.identityPath;
    } catch { return null; }
  }

  #isMultiDiscDirectoryItem(item) {
    return item?.IsFolder === false && ['Dvd', 'BluRay'].includes(item?.VideoType)
      && Array.isArray(item?.AdditionalParts) && item.AdditionalParts.length > 0;
  }

  async #subtree(db, folder, parent, signal) {
    const result = [];
    const visited = new Set();
    const visiting = new Set();
    let cycle = false;
    const visit = async (item, itemParent) => {
      checkAbort(signal);
      const key = idKey(item.Id);
      if (visiting.has(key)) { cycle = true; return; }
      if (visited.has(key)) return;
      visiting.add(key);
      for (const child of await this.#children(db, item.Id)) await visit(child, item);
      for (const child of await this.#owned(db, item.Id)) {
        const actualParent = sameId(child.ParentId, itemParent?.Id) ? itemParent
          : await this.#item(db, child.ParentId) ?? itemParent;
        await visit(child, actualParent);
      }
      visiting.delete(key);
      visited.add(key);
      result.push({ item, parent: itemParent });
    };
    await visit(folder, parent);
    return cycle ? null : result;
  }

  async #hasExternalReferences(db, subtree, signal) {
    const subtreeIds = new Set(subtree.map(({ item }) => idKey(item.Id)));
    for (const { item } of subtree) {
      checkAbort(signal);
      if ((await db.rows('UserData', { where: { ItemId: item.Id }, limit: 1 })).length) return true;
      const sql=nativeTextSql(db.schemaName),linksTable=`${q(db.schemaName)}."LinkedChildren"`;
      if((await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${linksTable}
        WHERE ${sql.guidKey('"ParentId"')}=$1 AND NOT ${sql.guidKey('"ChildId"')}=ANY($2::text[])
          OR ${sql.guidKey('"ChildId"')}=$1 AND NOT ${sql.guidKey('"ParentId"')}=ANY($2::text[])) AS present`,[idKey(item.Id),[...subtreeIds]])).rows[0].present)return true;
      for (const referenceId of this.#idValues(item.Id)) {
        checkAbort(signal);
        const descendants = await db.rows('AncestorIds', { where: { ParentItemId: referenceId } });
        if (descendants.some(row => !subtreeIds.has(idKey(row.ItemId)))) return true;
      }
      for (const field of ['OwnerId', 'PrimaryVersionId', 'SeriesId', 'SeasonId', 'TopParentId']) {
        for (const referenceId of this.#idValues(item.Id)) {
          checkAbort(signal);
          const references = await db.rows('BaseItems', { where: { [field]: referenceId } });
          if (references.some(reference => !subtreeIds.has(idKey(reference.Id)))) return true;
        }
      }
    }
    return false;
  }

  async #transferLinkedAlternates(db, fromId, toId) {
    if (sameId(fromId, toId)) return false;
    let changed = false;
    const sql=nativeTextSql(db.schemaName),table=`${q(db.schemaName)}."LinkedChildren"`;
    const links=await db.rows('LinkedChildren',{where:{ParentId:fromId,ChildType:3},orderBy:[{column:'SortOrder',direction:'ASC'}]});
    let nextOrder=Number((await db.client.query(`SELECT COALESCE(max("SortOrder"),-1)+1 AS next FROM ${table}
      WHERE ${sql.guidKey('"ParentId"')}=$1`,[idKey(toId)])).rows[0].next);
    for(const link of links){
      const duplicate=(await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${sql.guidKey('"ParentId"')}=$1
        AND ${sql.guidKey('"ChildId"')}=$2 AND "ChildType"=3) AS present`,[idKey(toId),idKey(link.ChildId)])).rows[0].present;
      await db.delete('LinkedChildren',{ParentId:link.ParentId,SortOrder:link.SortOrder});
      if(!duplicate)await db.insert('LinkedChildren',{ParentId:toId,SortOrder:nextOrder++,ChildId:link.ChildId,ChildType:3});
      changed=true;
    }
    return changed;
  }

  async #upsertLocalAlternateLink(db, primaryId, alternateId) {
    const links = await db.rows('LinkedChildren', { where: { ParentId: primaryId,ChildId:alternateId },limit:1 });
    const existing = links.find(link => sameId(link.ChildId, alternateId));
    if (existing) {
      if (Number(existing.ChildType) === 2) return false;
      await db.update('LinkedChildren', { ParentId: existing.ParentId, SortOrder: existing.SortOrder }, { ChildType: 2 });
      return true;
    }
    const sql=nativeTextSql(db.schemaName),table=`${q(db.schemaName)}."LinkedChildren"`;
    const SortOrder=Number((await db.client.query(`SELECT COALESCE(max("SortOrder"),-1)+1 AS next FROM ${table} WHERE ${sql.guidKey('"ParentId"')}=$1`,[idKey(primaryId)])).rows[0].next);
    await db.insert('LinkedChildren', { ParentId: primaryId, SortOrder, ChildId: alternateId, ChildType: 2 });
    return true;
  }

  #draftItem(row, desired, initialize = false) {
    const item = mapRecord(row);
    for (const field of itemListFields) if (Object.hasOwn(desired.draft.data ?? {}, field)) item[field] = desired.draft.data[field];
    if (initialize) setResolverProviderIdsFromPath(item);
    return item;
  }

  #listColumns(item) {
    return Object.fromEntries(itemListFields.map(field => [field, itemListColumn(item, field)]));
  }

  async #prepareSaveTuple(db, item, state) {
    await this.#loadLineage(db, item, state);
    return prepareItemSaveTuple(db, item, { parents: parentChainForItem(item, state), collectionFolders: collectionFoldersForItem(item, state) });
  }

  async #saveRelations(db, item, state, tuple) {
    this.#rememberRelationItem(state, item);
    await this.#loadLineage(db, item, state);
    await persistItemRelations(db, item, { parents: parentChainForItem(item, state), collectionFolders: collectionFoldersForItem(item, state),
      validIds: state.persistedIds,
      preparedRelations: tuple?.relations });
  }

  #draftData(desired, existing = {}) {
    const data = desired.draft.data;
    if (data != null && (!data || typeof data !== 'object' || Array.isArray(data))) {
      throw new StorageError('invalid-response', 'A directory resolver returned invalid native item data.');
    }
    return { ...existing, ...(data ?? {}), SourceType: desired.draft.SourceType ?? data?.SourceType ?? 'Library' };
  }

  #draftColumns(desired, field = 'columns') {
    const columns = desired.draft[field];
    if (columns != null && (!columns || typeof columns !== 'object' || Array.isArray(columns))) {
      throw new StorageError('invalid-response', `A directory resolver returned invalid native item ${field}.`);
    }
    const protectedColumns = new Set(['Id', 'Type', 'Path', 'ParentId', 'TopParentId', 'Data', 'DateCreated',
      'DateModified', 'DateLastSaved', 'Name', 'CleanName', 'SortName', 'IsFolder', 'IsVirtualItem', 'MediaType', 'Size',
      ...relationshipFields, ...ownershipFields]);
    if (Object.keys(columns ?? {}).some(key => protectedColumns.has(key))) {
      throw new StorageError('invalid-response', 'A directory resolver attempted to replace a scanner-owned native column.');
    }
    return Object.fromEntries(Object.entries(columns ?? {}).map(([key, value]) => [key,
      itemListFields.includes(key) ? itemListColumn({ Type: desired.nativeType, [key]: value }, key) : value]));
  }

  #assertDraftRelationships(desired) {
    if (Object.keys(desired.draft.columns ?? {})
      .some(field => Object.hasOwn(desired.draft.initialColumns ?? {}, field))) {
      throw new StorageError('invalid-response', 'A directory resolver returned overlapping persistent and initial columns.');
    }
    for (const field of relationshipFields) {
      if (Object.hasOwn(desired.draft, field) || Object.hasOwn(desired.draft.columns ?? {}, field)
        || Object.hasOwn(desired.draft.initialColumns ?? {}, field)
        || Object.hasOwn(desired.draft.data ?? {}, field)) {
        throw new StorageError('invalid-response', `A directory resolver attempted to set unsupported relationship field ${field}.`);
      }
    }
    for (const field of ownershipFields) {
      if (Object.hasOwn(desired.draft, field) || Object.hasOwn(desired.draft.columns ?? {}, field)
        || Object.hasOwn(desired.draft.initialColumns ?? {}, field)
        || Object.hasOwn(desired.draft.data ?? {}, field)) {
        throw new StorageError('invalid-response', `A directory resolver attempted to set scanner-owned field ${field}.`);
      }
    }
  }

  #assertExistingTvStructure(existing, desired, parent, root) {
    const structure = tvStructure(desired, parent, root);
    if (structure != null && !matchesTvStructure(existing, structure)) {
      throw new StorageError('unsupported/relationship-reclassification-required',
        `The existing TV relationship or numbering at ${existing.Path} does not match its scan hierarchy.`);
    }
    return structure;
  }

  #newItemRow(desired, parent, root, primaryId = null, extraType = undefined, ownedPart = false, relationState) {
    this.#assertDraftRelationships(desired);
    const now = nativeDate(this.clock());
    const name = desired.draft.Name ?? desired.entry.name;
    const size = desired.entry.kind === 'file' ? desired.entry.size ?? null : null;
    const columns = this.#draftColumns(desired);
    const initialColumns = this.#draftColumns(desired, 'initialColumns');
    const structure = tvStructure(desired, parent, root);
    const ownedExtra = extraType !== undefined;
    const initial = setResolverInitialValues({ Type: desired.nativeType.split('.').at(-1), Path: desired.identityPath,
      Name: name, IsFolder: desired.draft.IsFolder, IsInMixedFolder: columns.IsInMixedFolder ?? false,
      ...this.#draftData(desired) }, { identityPath: desired.identityPath, entry: desired.entry, parent,
      parents: relationState ? parentChainForItem(parent, relationState) : [],
      metadataConfiguration: this.metadataConfiguration, clock: this.clock });
    const row = {
      Id: desired.Id,
      Type: desired.nativeType,
      Name: name,
      CleanName: cleanValue(name),
      SortName: sortName({ Type: desired.nativeType, Name: name, ...columns, ...initialColumns }, this.library.options) ?? null,
      Path: desired.identityPath,
      ParentId: ownedExtra ? null : parent.Id,
      TopParentId: ownedExtra ? null : root.Id,
      OwnerId: primaryId,
      PrimaryVersionId: ownedExtra || ownedPart ? null : primaryId,
      ExtraType: ownedExtra ? extraType : null,
      IsFolder: desired.draft.IsFolder,
      IsInMixedFolder: false,
      IsLocked: initial.IsLocked,
      IsMovie: false,
      IsRepeat: false,
      IsSeries: false,
      IsVirtualItem: false,
      MediaType: desired.draft.MediaType,
      UnratedType: nativeItemDescriptor(desired.nativeType).unratedType,
      Size: size,
      DateCreated: nativeDate(initial.DateCreated),
      DateModified: nativeDate(initial.DateModified),
      DateLastSaved: now,
      ...columns,
      ...initialColumns,
      ...(structure?.relationships ?? {}),
      Data: itemRequiresJson(desired.nativeType) ? persistData(this.#draftData(desired)) : null
    };
    return row;
  }

  #changesFor(existing, desired, parent, root) {
    this.#assertDraftRelationships(desired);
    this.#assertExistingTvStructure(existing, desired, parent, root);
    const resolved = this.#resolvedDraft(desired);
    const updated = cloneNativeItemEntity(existing);
    if (updateFromResolvedItem(updated, resolved) <= ItemUpdateType.None) return {};
    const changes = {};
    if (updated.IsInMixedFolder !== existing.IsInMixedFolder) changes.IsInMixedFolder = updated.IsInMixedFolder;
    updated.DateLastSaved = this.clock().toISOString();
    changes.Data = serializeNativeItemData(updated);
    changes.DateLastSaved = nativeDate(updated.DateLastSaved);
    return changes;
  }

  async #reconcile(db, folderSnapshot, rootSnapshot, desired, observedPaths, withheldPaths,
    directoryPaths, peekScopes, collectionContext, deletionSafe, directSignature, signal, state, plan) {
    const pathCatalog = state.pathCatalog;
    checkAbort(signal);
    const folder = await this.#item(db, folderSnapshot.Id);
    const root = sameId(folderSnapshot.Id, rootSnapshot.Id) ? folder : await this.#item(db, rootSnapshot.Id);
    const direct = folder ? await this.#children(db, folder.Id) : [];
    if (!folder || !root || !this.#supportsTraversal(folder) || !this.#supportsPhysicalRoot(root)
      || !sameStructure(folder, structuralSnapshot(folderSnapshot))
      || !sameStructure(root, structuralSnapshot(rootSnapshot))
      || directChildrenSignature(direct, folder.Id) !== directSignature) {
      throw new StorageError('version-changed', 'The folder hierarchy changed during enumeration.');
    }
    const journal = { removed: [], updated: [], added: [] };
    const desiredEntries = [];
    const desiredParts = [];
    const desiredExtras = [];
    const desiredRoles = new Map();
    const desiredPartRoles = new Map();
    const desiredExtraRoles = new Map();
    const desiredByPath = new Map();
    const reserveDesired = (target, entry, roles) => {
      const key = idKey(target?.Id), targetPath = pathKey(target?.identityPath);
      if (!key || targetPath == null || desiredRoles.has(key) || desiredPartRoles.has(key) || desiredExtraRoles.has(key)
        || desiredByPath.has(targetPath)) {
        throw new StorageError('invalid-response', 'The storage plan contains duplicate local item identities.');
      }
      roles.set(key, entry);
      desiredByPath.set(targetPath, entry);
    };
    const registerDesired = (target, primaryId = null) => {
      const entry = { target, primaryId };
      reserveDesired(target, entry, desiredRoles);
      desiredEntries.push(entry);
    };
    const partFamilies = [];
    const extraFamilies = [];
    for (const target of desired) {
      registerDesired(target);
      if (!Array.isArray(target.localAlternates)) {
        throw new StorageError('invalid-response', 'A directory resolver returned invalid local alternate versions.');
      }
      for (const alternate of target.localAlternates) {
        if (alternate.nativeType !== target.nativeType || alternate.draft.IsFolder !== false
          || alternate.traversal !== 'none' || !target.consumedPaths.some(value => samePath(value, alternate.identityPath))
          || samePath(target.identityPath, alternate.identityPath)) {
          throw new StorageError('invalid-response', 'A directory resolver returned an invalid local alternate version plan.');
        }
        registerDesired(alternate, target.Id);
      }
      if (!Array.isArray(target.ownedParts) || typeof target.ownsOwnedParts !== 'boolean'
        || typeof target.ownedPartsDeletionSafe !== 'boolean'
        || !target.ownsOwnedParts && target.ownedParts.length) {
        throw new StorageError('invalid-response', 'A directory resolver returned invalid owned parts.');
      }
      const familyOwnerIds = new Set([idKey(target.Id), ...target.localAlternates.map(value => idKey(value.Id))]);
      const familyParts = [];
      for (const part of target.ownedParts) {
        if (!part || part.nativeType !== videoNativeType || part.draft?.IsFolder !== false || part.traversal !== 'none'
          || !familyOwnerIds.has(idKey(part.ownerId)) || !target.consumedPaths.some(value => samePath(value, part.identityPath))
          || samePath(target.identityPath, part.identityPath)
          || target.localAlternates.some(alternate => samePath(alternate.identityPath, part.identityPath))) {
          throw new StorageError('invalid-response', 'A directory resolver returned an invalid owned part plan.');
        }
        const entry = { target: part, ownerId: part.ownerId, family: target };
        reserveDesired(part, entry, desiredPartRoles);
        desiredParts.push(entry);
        familyParts.push(entry);
      }
      if (!Array.isArray(target.directoryParts)) {
        throw new StorageError('invalid-response', 'A directory resolver returned invalid directory parts.');
      }
      const directoryPartPaths = new Set();
      for (const part of target.directoryParts) {
        const partKey = pathKey(part?.identityPath);
        if (!part || part.entry?.kind !== 'directory' || target.entry?.kind !== 'directory'
          || target.primary?.entry?.kind !== 'directory' || partKey == null || directoryPartPaths.has(partKey)
          || samePath(part.identityPath, target.identityPath)
          || parentPath(part.accessPath) !== target.primary.accessPath
          || !target.consumedPaths.some(value => samePath(value, part.identityPath))) {
          throw new StorageError('invalid-response', 'A directory resolver returned an invalid directory-part plan.');
        }
        directoryPartPaths.add(partKey);
      }
      const declaredParts = target.draft.data?.AdditionalParts ?? [];
      const actualParts = [
        ...familyParts.filter(entry => sameId(entry.ownerId, target.Id)).map(entry => entry.target.identityPath),
        ...target.directoryParts.map(part => part.identityPath)
      ];
      if (!Array.isArray(declaredParts) || declaredParts.length !== actualParts.length
        || declaredParts.some((value, index) => !samePath(value, actualParts[index]))) {
        throw new StorageError('invalid-response', 'A directory resolver returned inconsistent additional-part paths.');
      }
      if (target.ownsOwnedParts) partFamilies.push({ target, ownerIds: familyOwnerIds,
        parts: familyParts, deletionSafe: target.ownedPartsDeletionSafe });
      if (!Array.isArray(target.ownedExtras) || typeof target.ownsOwnedExtras !== 'boolean'
        || typeof target.ownedExtrasDeletionSafe !== 'boolean'
        || !target.ownsOwnedExtras && target.ownedExtras.length) {
        throw new StorageError('invalid-response', 'A directory resolver returned invalid owned extras.');
      }
      const familyExtras = [];
      for (const extra of target.ownedExtras) {
        if (!extra || extra.draft?.IsFolder !== false || extra.traversal !== 'none'
          || !Number.isInteger(extra.extraType) || extra.extraType < 0 || extra.extraType > 11
          || !familyOwnerIds.has(idKey(extra.ownerId)) || samePath(target.identityPath, extra.identityPath)
          || target.localAlternates.some(alternate => samePath(alternate.identityPath, extra.identityPath))) {
          throw new StorageError('invalid-response', 'A directory resolver returned an invalid owned extra plan.');
        }
        const entry = { target: extra, ownerId: extra.ownerId, extraType: extra.extraType, family: target };
        reserveDesired(extra, entry, desiredExtraRoles);
        desiredExtras.push(entry);
        familyExtras.push(entry);
      }
      if (target.ownsOwnedExtras) extraFamilies.push({ target, ownerIds: familyOwnerIds,
        extras: familyExtras, deletionSafe: target.ownedExtrasDeletionSafe });
    }
    const desiredIds = new Set([...desiredEntries, ...desiredParts, ...desiredExtras].map(({ target }) => idKey(target.Id)));
    const removedIds = new Set();
    const structurallyUpdatedIds = new Set();
    const structuralEventParents = new Map();
    let skippedDeletion = !deletionSafe;
    const incompleteReasons = [];
    const markIncomplete = (code, item = folder, reasonPath = item?.Path) => {
      incompleteReasons.push(incompleteReason(code, item, reasonPath));
      skippedDeletion = true;
    };
    if (!deletionSafe) {
      markIncomplete(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, folder);
    }

    const withheldKeys = new Set((withheldPaths ?? []).map(pathKey));
    for (const withheldPath of withheldPaths ?? []) {
      markIncomplete(folderScanIncompleteReasonCodes.RESOLVER_PATH_WITHHELD, folder, withheldPath);
    }
    directoryPaths ??= new Set();
    peekScopes ??= new Map();
    const desiredByPrimaryPath = new Map();
    const replacements = new Map();
    const collapsedExpansions = new Map();
    for (const target of desired) {
      const primaryPath = target.primary?.identityPath;
      const primaryKey = pathKey(primaryPath);
      if (primaryKey != null) {
        const previous = desiredByPrimaryPath.get(primaryKey);
        if (previous && !sameId(previous.Id, target.Id)) {
          throw new StorageError('invalid-response', 'The storage plan contains ambiguous primary paths.');
        }
        desiredByPrimaryPath.set(primaryKey, target);
      }
      if (!Array.isArray(target.replacementPaths)) {
        throw new StorageError('invalid-response', 'A directory resolver returned invalid replacement paths.');
      }
      const local = new Set();
      for (const replacementPath of target.replacementPaths) {
        const replacementKey = pathKey(replacementPath);
        const scope = peekScopes.get(replacementKey);
        if (replacementKey == null || local.has(replacementKey) || replacements.has(replacementKey)
          || !samePath(primaryPath, replacementPath)
          || !target.consumedPaths.some(path => samePath(path, replacementPath))
          || !observedPaths.has(replacementKey) || !directoryPaths.has(replacementKey)
          || !identityWithin(target.identityPath, replacementPath)
          || samePath(target.identityPath, replacementPath)
          || !supportsCollapsedItemType(collectionContext, target.nativeType) || target.draft.IsFolder !== false
          || target.entry?.kind !== 'file' && !(target.entry?.kind === 'directory' && target.directoryParts.length > 0)
          || !scope?.deletionSafe || !scope.observedPaths.has(pathKey(target.identityPath))) {
          throw new StorageError('invalid-response', 'The storage plan contains an invalid replacement path.');
        }
        local.add(replacementKey);
        replacements.set(replacementKey, target);
      }
    }

    const withheldOwner = direct.find(item => {
      if (!this.resolverPipeline.manages(item) || !this.#isManagedIdentity(item, root.Id)) return false;
      const collapsedContainer = this.#collapsedItemContainerPath(item, folder, collectionContext);
      return withheldKeys.has(pathKey(item.Path))
        || collapsedContainer != null && withheldKeys.has(pathKey(collapsedContainer));
    });
    if (withheldOwner) {
      throw new StorageError('unsupported/type-reclassification-required',
        `A managed item already exists at withheld resolver path ${withheldOwner.Path}; replacing it is not implemented.`);
    }

    const reclassifications = [];
    const stackRoleReroutes = new Map();
    const demotedStackOwners = new Map();
    for (const { target } of [...desiredEntries, ...desiredParts]) {
      const staleType = direct.find(item => !sameId(item.Id, target.Id)
        && samePath(item.Path, target.identityPath)
        && sameId(item.ParentId, folder.Id)
        && (this.#isManagedItem(item, root.Id) || this.#isManagedPartIdentity(item, root.Id))
        && (item.NativeType !== target.nativeType || item.IsFolder !== target.draft.IsFolder));
      if (staleType) {
        if (!deletionSafe) {
          throw new StorageError('unsupported/type-reclassification-required',
            `Changing the managed type at ${staleType.Path} requires an authoritative directory snapshot.`);
        }
        const desiredRole = desiredRoles.get(idKey(target.Id));
        const desiredPartRole = desiredPartRoles.get(idKey(target.Id));
        if (desiredRole?.primaryId == null && this.#isManagedPartIdentity(staleType, root.Id)) {
          const previousStackOwner = await this.#ownedPartOwner(db, staleType, root.Id);
          if (!previousStackOwner) {
            throw new StorageError('unsupported/type-reclassification-required',
              `The owned part at ${staleType.Path} has no safe stack owner.`);
          }
          stackRoleReroutes.set(idKey(previousStackOwner.Id), target.Id);
        }
        if (desiredPartRole && this.#isManagedItem(staleType, root.Id)) {
          stackRoleReroutes.set(idKey(staleType.Id), desiredPartRole.ownerId);
          demotedStackOwners.set(idKey(target.Id), staleType);
          continue;
        }
        reclassifications.push(staleType);
      }
    }

    const pendingRemovals = new Map();
    const removableSubtree = async (owner, containingPath, required) => {
      const subtree = await this.#subtree(db, owner, folder, signal);
      const subtreeIds = new Set((subtree ?? []).map(({ item }) => idKey(item.Id)));
      let structurallyUnsafe = !subtree;
      for (const { item } of subtree ?? []) {
        const owned = nonemptyId(item.OwnerId) && subtreeIds.has(idKey(item.OwnerId));
        const managed = owned && item.ExtraType != null
          ? this.#isManagedExtraIdentity(item)
          : this.#isManagedPartIdentity(item, root.Id) ? true
            : owned ? this.#isManagedIdentity(item, root.Id) : this.#isManagedItem(item, root.Id);
        if (!managed || !(identityWithin(item.Path, containingPath)
          || owned && identityWithin(item.Path, folder.Path) && identityWithin(item.Path, root.Path))
          || desiredIds.has(idKey(item.Id))) {
          structurallyUnsafe = true;
          break;
        }
      }
      const externallyReferenced = !structurallyUnsafe && await this.#hasExternalReferences(db, subtree, signal);
      const unsafe = structurallyUnsafe || externallyReferenced;
      if (unsafe) {
        if (required) {
          throw new StorageError('unsupported/type-reclassification-required',
            `The managed item at ${owner.Path} cannot be safely replaced.`);
        }
        markIncomplete(externallyReferenced
          ? folderScanIncompleteReasonCodes.EXTERNAL_REFERENCE_DELETION_SKIPPED
          : folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, owner);
        return null;
      }
      return subtree;
    };
    const scheduleRemoval = async (owner, containingPath, required) => {
      const ownerKey = idKey(owner.Id);
      if (pendingRemovals.has(ownerKey)) return true;
      const subtree = await removableSubtree(owner, containingPath, required);
      if (!subtree) return false;
      pendingRemovals.set(ownerKey, { owner, subtree });
      return true;
    };
    const moveCollapsedIdentity = async (source, target, parent) => {
      const current = await this.#item(db, source.Id);
      const closure = current ? await collectItemDeletionIds(db, [current.Id]) : new Map();
      if (!current || !this.#isManagedItem(current, root.Id)
        || !movableCollapsedTypes.has(current.NativeType) || current.IsFolder !== false
        || target.nativeType !== current.NativeType || target.draft.IsFolder !== false
        || !sameId(current.Id, target.Id) || !samePath(current.Path, target.identityPath)
        || closure.size !== 1 || !closure.has(idKey(current.Id))) {
        throw new StorageError('unsupported/type-reclassification-required',
          `The collapsed identity at ${source.Path} cannot move across the directory boundary.`);
      }
      const changes = this.#changesFor(current, target, parent, root);
      if (!sameId(current.ParentId, parent.Id)) changes.ParentId = parent.Id;
      if (!sameId(repositoryTopParentId(current), root.Id)) changes.TopParentId = root.Id;
      if (!Object.keys(changes).length) return current;
      changes.DateLastSaved = nativeDate(this.clock());
      const [stored] = await db.rows('BaseItems', { where: { Id: current.Id } });
      const prospective = this.#draftItem({ ...stored, ...changes }, target);
      const tuple = await this.#prepareSaveTuple(db, prospective, state.libraryState);
      await db.update('BaseItems', { Id: current.Id }, changes);
      const updated = await this.#item(db, current.Id);
      await this.#saveRelations(db, updated, state.libraryState, tuple);
      structurallyUpdatedIds.add(idKey(updated.Id));
      structuralEventParents.set(idKey(updated.Id), parent);
      pathCatalog.set(updated);
      return updated;
    };

    for (const staleType of reclassifications) {
      if (!identityWithin(staleType.Path, folder.Path) || !identityWithin(staleType.Path, root.Path)
        || !this.#isDirectAccessChild(staleType, folder)) {
        throw new StorageError('unsupported/type-reclassification-required',
          `The managed item at ${staleType.Path} is outside the direct scan scope.`);
      }
      await scheduleRemoval(staleType, staleType.Path, true);
    }

    const removeSubtree = async (owner, subtree) => {
      checkAbort(signal);
      const expected = new Set(subtree.map(({ item }) => idKey(item.Id)));
      const removed = await deleteItemsInDatabase(db, [owner.Id], { now: () => nativeDate(this.clock()) });
      if (removed.size !== expected.size || [...removed].some(id => !expected.has(id))) {
        throw new StorageError('version-changed', 'The deletion ownership closure changed during reconciliation.');
      }
      for (const event of subtree) {
        journal.removed.push(event);
        removedIds.add(idKey(event.item.Id));
      }
    };

    for (const [replacementKey, target] of replacements) {
      const owner = direct.find(item => pathKey(item.Path) === replacementKey);
      if (!owner) continue;
      if (owner.NativeType !== folderNativeType || owner.IsFolder !== true
        || !sameId(owner.ParentId, folder.Id)
        || !identityWithin(owner.Path, folder.Path)
        || !identityWithin(owner.Path, root.Path)
        || !this.#isDirectAccessChild(owner, folder)
        || !this.#isManagedItem(owner, root.Id)) {
        throw new StorageError('unsupported/type-reclassification-required',
          `The item at ${owner.Path} cannot be safely replaced by a collapsed item.`);
      }
      if (movableCollapsedTypes.has(target.nativeType)) {
        const source = await this.#item(db, target.Id);
        if (source) {
          if (!sameId(source.ParentId, owner.Id)) {
            throw new StorageError('unsupported/type-reclassification-required',
              `The collapsed identity at ${source.Path} is not owned by its Folder.`);
          }
          await moveCollapsedIdentity(source, target, folder);
        }
      }
      await scheduleRemoval(owner, owner.Path, true);
    }

    const deferredCollapsedRemovals = new Map();
    for (const item of direct) {
      if (desiredIds.has(idKey(item.Id)) || pendingRemovals.has(idKey(item.Id))
        || !this.#isManagedItem(item, root.Id)) continue;
      const containerPath = this.#collapsedItemContainerPath(item, folder, collectionContext);
      if (containerPath == null) continue;
      const containerKey = pathKey(containerPath);
      const desiredAtContainer = desiredByPrimaryPath.get(containerKey);
      if (this.#isMultiDiscDirectoryItem(item)
        && (!desiredAtContainer || !sameId(desiredAtContainer.Id, item.Id))) {
        throw new StorageError('unsupported/type-reclassification-required',
          `Changing or removing the multi-disc directory stack at ${containerPath} is not implemented.`);
      }
      const containerObserved = observedPaths.has(containerKey);
      let remove = false;
      let required = false;
      if (!containerObserved) {
        if (deletionSafe) remove = true;
        else markIncomplete(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, item, containerPath);
      } else if (!directoryPaths.has(containerKey)) {
        remove = true;
        required = Boolean(desiredAtContainer);
      } else {
        const scope = peekScopes.get(containerKey);
        if (!scope?.deletionSafe) {
          if (desiredAtContainer) {
            throw new StorageError('version-changed',
              `The collapsed item container ${containerPath} has no authoritative directory snapshot.`);
          }
          markIncomplete(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, item, containerPath);
        } else if (scope.observedPaths.has(pathKey(item.Path))) {
          if (desiredAtContainer && !sameId(desiredAtContainer.Id, item.Id)) {
            const childPlan = plan?.children?.get(idKey(desiredAtContainer.Id));
            const nested = childPlan?.desired?.find(target => sameId(target.Id, item.Id));
            const collapsedExpansion = movableCollapsedTypes.has(item.NativeType)
              && collectionContext?.collectionType === 'books'
              && desiredAtContainer.nativeType === folderNativeType
              && desiredAtContainer.draft.IsFolder === true
              && desiredAtContainer.traversal === 'children'
              && nested?.nativeType === item.NativeType
              && nested?.draft?.IsFolder === false
              && samePath(nested.identityPath, item.Path)
              && childPlan?.deletionSafe === true;
            if (!collapsedExpansion) {
              throw new StorageError('unsupported/type-reclassification-required',
                `The observed collapsed item at ${item.Path} is not represented by the resolver plan.`);
            }
            collapsedExpansions.set(idKey(item.Id), { source: item, target: nested,
              parentTarget: desiredAtContainer, childPlan });
            continue;
          }
          markIncomplete(folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, item);
        } else {
          remove = true;
          required = Boolean(desiredAtContainer);
        }
      }
      if (remove) {
        // Promotion must detach retained local versions, parts and extras
        // before checking the old primary's final deletion ownership closure.
        // The same complete safety check still runs inside this transaction.
        deferredCollapsedRemovals.set(idKey(item.Id), { item, required });
      }
    }

    for (const { owner, subtree } of pendingRemovals.values()) {
      await removeSubtree(owner, subtree);
    }

    for (const target of desired) {
      checkAbort(signal);
      for (const consumedPath of target.consumedPaths) {
        const consumedKey = pathKey(consumedPath);
        const persisted = desiredByPath.get(consumedKey)?.target ?? null;
        const plannedClaim = state.claimedPaths.get(consumedKey);
        if (plannedClaim && (!sameId(plannedClaim.claimId, target.Id)
          || !sameId(plannedClaim.persistedId, persisted?.Id))) {
          throw new StorageError('invalid-response', 'The storage plan contains overlapping sibling claims.');
        }
        state.claimedPaths.set(consumedKey, {
          claimId: target.Id,
          persistedId: persisted?.Id ?? null,
          path: consumedPath
        });
        const claimedOwners = [...direct, ...pathCatalog.owners(consumedPath)]
          .filter(item => !removedIds.has(idKey(item.Id)) && samePath(item.Path, consumedPath));
        const demotedOwner = persisted ? demotedStackOwners.get(idKey(persisted.Id)) : null;
        if (claimedOwners.some(item => (!persisted || !sameId(item.Id, persisted.Id))
          && (!demotedOwner || !sameId(item.Id, demotedOwner.Id)))) {
          throw new StorageError('invalid-response', 'A consumed sibling path is already owned by another item.');
        }
      }
    }

    const priorLocalOwners = new Map();
    const priorPartOwners = new Map();
    for (const item of direct.filter(value => !removedIds.has(idKey(value.Id))
      && (nonemptyId(value.OwnerId) || nonemptyId(value.PrimaryVersionId)))) {
      const localOwner = nonemptyId(item.PrimaryVersionId) ? await this.#localAlternateOwner(db, item, root.Id) : null;
      const partOwner = !nonemptyId(item.PrimaryVersionId) ? await this.#ownedPartOwner(db, item, root.Id) : null;
      if (localOwner) priorLocalOwners.set(idKey(item.Id), localOwner);
      else if (partOwner) priorPartOwners.set(idKey(item.Id), partOwner);
      else if (desiredIds.has(idKey(item.Id))) {
        throw new StorageError('invalid-response', `The desired local alternate at ${item.Path} has invalid existing ownership.`);
      }
    }
    const weakPreservedIds = new Set();
    // Mixed-folder flags and declaring version arrays belong to the same
    // existing owned family. A weak extra observation cannot rewrite its
    // owner while retaining the old owned rows.
    for (const family of extraFamilies.filter(value => !value.deletionSafe)) {
      for (const ownerId of family.ownerIds) if (direct.some(item => sameId(item.Id, ownerId))) weakPreservedIds.add(idKey(ownerId));
    }
    if (!deletionSafe) {
      const preserveFamily = ownerId => {
        weakPreservedIds.add(idKey(ownerId));
        for (const [alternateId, owner] of priorLocalOwners) {
          if (sameId(owner.Id, ownerId)) weakPreservedIds.add(alternateId);
        }
        for (const [partId, owner] of priorPartOwners) {
          if (sameId(owner.Id, ownerId)) weakPreservedIds.add(partId);
        }
      };
      for (const [alternateId, owner] of priorLocalOwners) {
        const alternateRole = desiredRoles.get(alternateId);
        const ownerRole = desiredRoles.get(idKey(owner.Id));
        if (!alternateRole || !sameId(alternateRole.primaryId, owner.Id)
          || !ownerRole || ownerRole.primaryId != null) preserveFamily(owner.Id);
      }
      for (const [partId, owner] of priorPartOwners) {
        const partRole = desiredPartRoles.get(partId);
        const ownerRole = desiredRoles.get(idKey(owner.Id));
        if (!partRole || !sameId(partRole.ownerId, owner.Id) || !ownerRole) preserveFamily(owner.Id);
      }
      let expanded;
      do {
        expanded = false;
        for (const { target, relatedId } of [
          ...desiredEntries.map(entry => ({ target: entry.target, relatedId: entry.primaryId })),
          ...desiredParts.map(entry => ({ target: entry.target, relatedId: entry.ownerId }))
        ]) {
          if (!weakPreservedIds.has(idKey(target.Id)) && !weakPreservedIds.has(idKey(relatedId))) continue;
          for (const value of [target.Id, relatedId]) {
            if (!nonemptyId(value) || weakPreservedIds.has(idKey(value))) continue;
            weakPreservedIds.add(idKey(value));
            expanded = true;
          }
        }
      } while (expanded);
    }

    const previousOwners = new Map();
    const addedIds = new Set();
    const weakSkippedIds = new Set();
    for (const { target, primaryId } of desiredEntries) {
      checkAbort(signal);
      const targetKey = pathKey(target.identityPath);
      const catalogOwners = pathCatalog.owners(target.identityPath);
      const collision = [...direct, ...catalogOwners].find(item => !sameId(item.Id, target.Id)
        && !removedIds.has(idKey(item.Id)) && samePath(item.Path, target.identityPath));
      if (collision) throw new StorageError('invalid-response', 'The item path is already owned by ' + collision.Type + '.');
      let existing = await this.#item(db, target.Id);
      if (!existing && weakPreservedIds.has(idKey(target.Id))) {
        const claimed = state.claimedPaths.get(targetKey);
        if (claimed && sameId(claimed.persistedId, target.Id)) {
          state.claimedPaths.set(targetKey, { ...claimed, persistedId: null });
        }
        weakSkippedIds.add(idKey(target.Id));
        continue;
      }
      const planned = state.touchedPaths.get(targetKey);
      if (planned && !sameId(planned.Id, target.Id)) {
        throw new StorageError('invalid-response', 'The storage plan contains ambiguous item paths.');
      }
      state.touchedPaths.set(targetKey, { Id: target.Id, path: target.identityPath });
      if (existing) {
        const linkedCreation = state.linkedChanges?.added.has(idKey(existing.Id)) === true;
        if (!this.#isManagedIdentity(existing, root.Id, linkedCreation) || existing.NativeType !== target.nativeType
          || existing.IsFolder !== target.draft.IsFolder || !samePath(existing.Path, target.identityPath)
          || !sameId(existing.ParentId, folder.Id)) {
          throw new StorageError('invalid-response', 'The deterministic scan identity conflicts with an existing item.');
        }
        const hasRelationship = nonemptyId(existing.OwnerId) || nonemptyId(existing.PrimaryVersionId);
        const previousOwner = hasRelationship ? await this.#localAlternateOwner(db, existing, root.Id) : null;
        const previousPartOwner = hasRelationship && !previousOwner
          ? await this.#ownedPartOwner(db, existing, root.Id) : null;
        if (hasRelationship && !previousOwner && !previousPartOwner) {
          throw new StorageError('invalid-response', 'The existing subordinate relationship is invalid.');
        }
        previousOwners.set(idKey(existing.Id), previousOwner);
        if (previousPartOwner) priorPartOwners.set(idKey(existing.Id), previousPartOwner);
      } else {
        const row = this.#newItemRow(target, folder, root, primaryId, undefined, false, state.libraryState), draft = this.#draftItem(row, target, true);
        const tuple = await this.#prepareSaveTuple(db, draft, state.libraryState);
        const inserted = await db.insert('BaseItems', { ...row, ...this.#listColumns(draft) });
        existing = this.#draftItem(inserted, target, true);
        await persistItemProviderIds(db, existing);
        await this.#saveRelations(db, existing, state.libraryState, tuple);
        addedIds.add(idKey(existing.Id));
        pathCatalog.set(existing);
        if (primaryId == null) journal.added.push({ item: existing, parent: folder });
      }
    }

    for (const action of collapsedExpansions.values()) {
      const parent = await this.#item(db, action.parentTarget.Id);
      if (!parent || parent.NativeType !== folderNativeType || parent.IsFolder !== true) {
        throw new StorageError('version-changed', 'The expanded collapsed-item Folder was not created.');
      }
      await moveCollapsedIdentity(action.source, action.target, parent);
      action.childPlan.existingItems = await this.#children(db, parent.Id);
      action.childPlan.directSignature = directChildrenSignature(action.childPlan.existingItems, parent.Id);
    }

    const reroutes = new Map();
    const addReroute = (fromId, toId) => {
      if (!nonemptyId(fromId) || !nonemptyId(toId) || sameId(fromId, toId)) return;
      const key = idKey(fromId), previous = reroutes.get(key);
      if (previous && !sameId(previous, toId)) {
        throw new StorageError('invalid-response', 'Local version ownership requires ambiguous primary rerouting.');
      }
      reroutes.set(key, toId);
    };
    for (const [fromId, toId] of stackRoleReroutes) addReroute(fromId, toId);
    for (const { target, primaryId } of desiredEntries) {
      if (addedIds.has(idKey(target.Id))) continue;
      const previousOwner = previousOwners.get(idKey(target.Id));
      const previousPartOwner = priorPartOwners.get(idKey(target.Id));
      if (weakPreservedIds.has(idKey(target.Id))
        || weakPreservedIds.has(idKey(previousOwner?.Id))
        || weakPreservedIds.has(idKey(previousPartOwner?.Id))
        || weakPreservedIds.has(idKey(primaryId))) continue;
      if (primaryId != null) {
        if (!previousOwner) addReroute(target.Id, primaryId);
        else if (!sameId(previousOwner.Id, primaryId)) {
          const previousRole = desiredRoles.get(idKey(previousOwner.Id));
          if (!previousRole || previousRole.primaryId != null) addReroute(previousOwner.Id, primaryId);
        }
      } else if (previousOwner) {
        const previousRole = desiredRoles.get(idKey(previousOwner.Id));
        if (!previousRole || previousRole.primaryId != null) addReroute(previousOwner.Id, target.Id);
      } else if (previousPartOwner) {
        addReroute(previousPartOwner.Id, target.Id);
      }
    }
    for (const [fromKey, toId] of reroutes) {
      const from = direct.find(item => idKey(item.Id) === fromKey) ?? await this.#item(db, fromKey);
      if (!from) continue;
      const transferred = await this.#transferLinkedAlternates(db, from.Id, toId);
      if (transferred && !addedIds.has(idKey(toId))) structurallyUpdatedIds.add(idKey(toId));
    }

    for (const { target, primaryId } of desiredEntries) {
      const existing = await this.#item(db, target.Id);
      if (weakPreservedIds.has(idKey(target.Id)) || weakPreservedIds.has(idKey(primaryId))) continue;
      const changes = {};
      if (primaryId == null) {
        if (nonemptyId(existing.OwnerId)) changes.OwnerId = null;
        if (nonemptyId(existing.PrimaryVersionId)) changes.PrimaryVersionId = null;
      } else {
        if (!sameId(existing.OwnerId, primaryId)) changes.OwnerId = primaryId;
        if (!sameId(existing.PrimaryVersionId, primaryId)) changes.PrimaryVersionId = primaryId;
      }
      if (Object.keys(changes).length) {
        await db.update('BaseItems', { Id: existing.Id }, changes);
        if (!addedIds.has(idKey(existing.Id))) structurallyUpdatedIds.add(idKey(existing.Id));
      }
    }

    const hasLocalVersionPlan = desiredEntries.some(entry => entry.primaryId != null) || priorLocalOwners.size > 0;
    if (hasLocalVersionPlan) {
      const desiredStorageIds = [...new Set(desiredEntries.flatMap(({ target }) => this.#idValues(target.Id)))];
      for (const link of desiredStorageIds.length
        ? await db.rows('LinkedChildren', { where:{ChildType:2},whereIn: { ChildId: desiredStorageIds } }) : []) {
        if (Number(link.ChildType) !== 2) continue;
        const role = desiredRoles.get(idKey(link.ChildId));
        if (role && !weakPreservedIds.has(idKey(link.ChildId)) && !weakPreservedIds.has(idKey(link.ParentId))
          && (role.primaryId == null || !sameId(role.primaryId, link.ParentId))) {
          await db.delete('LinkedChildren', { ParentId: link.ParentId, SortOrder: link.SortOrder });
          if (!addedIds.has(idKey(link.ParentId))) structurallyUpdatedIds.add(idKey(link.ParentId));
        }
      }
      for (const { target, primaryId } of desiredEntries.filter(entry => entry.primaryId != null)) {
        if (!weakPreservedIds.has(idKey(target.Id)) && !weakPreservedIds.has(idKey(primaryId))
          && await this.#upsertLocalAlternateLink(db, primaryId, target.Id)
          && !addedIds.has(idKey(primaryId))) structurallyUpdatedIds.add(idKey(primaryId));
      }
    }

    for (const family of partFamilies) {
      for (const [fromId, toId] of reroutes) if (family.ownerIds.has(idKey(toId))) family.ownerIds.add(fromId);
      if (!family.deletionSafe) {
        markIncomplete(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, family.target,
          family.target.primary?.identityPath ?? family.target.identityPath);
      }
    }
    const partOwnerStorageIds = [...new Set(partFamilies.flatMap(family => [...family.ownerIds]
      .flatMap(ownerId => this.#idValues(ownerId))))];
    const currentParts = partOwnerStorageIds.length
      ? parseItems(await db.rows('BaseItems', { whereIn: { OwnerId: partOwnerStorageIds } }))
        .filter(item => item.ExtraType == null && !nonemptyId(item.PrimaryVersionId)
          && sameId(item.ParentId, folder.Id)) : [];
    if (this.library.options.expandPath) for (const item of currentParts) item.Path = this.library.options.expandPath(item.Path);
    const currentPartById = new Map(currentParts.map(item => [idKey(item.Id), item]));
    const familyForPart = item => partFamilies.find(family => family.ownerIds.has(idKey(item.OwnerId))) ?? null;
    const removeManagedPart = async (item, family, required = false) => {
      const owner = await this.#ownedPartOwner(db, item, root.Id);
      const safePath = identityWithin(item.Path, folder.Path) && identityWithin(item.Path, root.Path);
      const subtree = owner && safePath ? await this.#subtree(db, item, folder, signal) : null;
      const safeSubtree = subtree?.length === 1 && sameId(subtree[0].item.Id, item.Id);
      const externallyReferenced = safeSubtree && await this.#hasExternalReferences(db, subtree, signal);
      if (!owner || !safePath || !safeSubtree || externallyReferenced) {
        if (required) {
          throw new StorageError('unsupported/type-reclassification-required',
            `The owned part at ${item.Path} cannot be safely replaced.`);
        }
        markIncomplete(externallyReferenced
          ? folderScanIncompleteReasonCodes.EXTERNAL_REFERENCE_DELETION_SKIPPED
          : folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, item);
        return false;
      }
      const removed = await deleteItemsInDatabase(db, [item.Id], { now: () => nativeDate(this.clock()) });
      if (removed.size !== 1 || !removed.has(idKey(item.Id))) {
        throw new StorageError('version-changed', 'The owned-part deletion ownership changed during reconciliation.');
      }
      journal.removed.push({ item, parent: folder });
      removedIds.add(idKey(item.Id));
      currentPartById.delete(idKey(item.Id));
      pathCatalog.remove(item);
      return true;
    };

    const orderedDesiredParts = [...desiredParts].sort((left, right) =>
      Number(demotedStackOwners.has(idKey(left.target.Id))) - Number(demotedStackOwners.has(idKey(right.target.Id))));
    for (const entry of orderedDesiredParts) {
      checkAbort(signal);
      const { target, ownerId, family: familyTarget } = entry;
      const family = partFamilies.find(value => value.target === familyTarget);
      if (!family) throw new StorageError('invalid-response', 'An owned part has no authoritative owner family.');
      if (weakPreservedIds.has(idKey(target.Id)) || weakPreservedIds.has(idKey(ownerId))) continue;
      const owner = await this.#item(db, ownerId);
      if (!owner || !this.#isManagedIdentity(owner, root.Id) || owner.ExtraType != null
        || !sameId(owner.ParentId, folder.Id)) {
        throw new StorageError('invalid-response', 'An owned part references an invalid managed owner.');
      }
      const demotedOwner = demotedStackOwners.get(idKey(target.Id));
      if (demotedOwner && !removedIds.has(idKey(demotedOwner.Id))) {
        for (const child of await this.#owned(db, demotedOwner.Id)) {
          const partRole = desiredPartRoles.get(idKey(child.Id));
          const extraRole = desiredExtraRoles.get(idKey(child.Id));
          const desiredOwnerId = partRole?.ownerId ?? extraRole?.ownerId ?? null;
          if (!sameId(desiredOwnerId, ownerId)) continue;
          const prospective = { ...child, OwnerId: ownerId };
          const tuple = await this.#prepareSaveTuple(db, prospective, state.libraryState);
          await db.update('BaseItems', { Id: child.Id }, { OwnerId: ownerId, DateLastSaved: nativeDate(this.clock()) });
          const updated = await this.#item(db, child.Id);
          await this.#saveRelations(db, updated, state.libraryState, tuple);
          pathCatalog.set(updated);
          if (currentPartById.has(idKey(updated.Id))) currentPartById.set(idKey(updated.Id), updated);
          structurallyUpdatedIds.add(idKey(updated.Id));
          structuralEventParents.set(idKey(updated.Id), updated.ExtraType == null ? folder : owner);
        }
        const subtree = await removableSubtree(demotedOwner, demotedOwner.Path, true);
        await removeSubtree(demotedOwner, subtree);
      }
      const targetPath = pathKey(target.identityPath);
      const collisions = pathCatalog.owners(target.identityPath)
        .filter(item => !sameId(item.Id, target.Id) && !removedIds.has(idKey(item.Id)));
      for (const collision of collisions) {
        const storedCollision = await this.#item(db, collision.Id) ?? collision;
        const collisionFamily = familyForPart(storedCollision);
        if (!family.deletionSafe || collisionFamily !== family) {
          throw new StorageError('invalid-response', `The owned-part path is already owned by ${collision.Type}.`);
        }
        await removeManagedPart(storedCollision, family, true);
      }
      const planned = state.touchedPaths.get(targetPath);
      if (planned && !sameId(planned.Id, target.Id)) {
        throw new StorageError('invalid-response', 'The storage plan contains ambiguous item paths.');
      }
      state.touchedPaths.set(targetPath, { Id: target.Id, path: target.identityPath });
      let existing = await this.#item(db, target.Id);
      if (existing) {
        const previousOwner = await this.#ownedPartOwner(db, existing, root.Id);
        const directOwner = this.#isManagedItem(existing, root.Id) ? existing : null;
        const mappedOwner = previousOwner ? reroutes.get(idKey(previousOwner.Id)) : null;
        if ((!previousOwner && !directOwner)
          || previousOwner && !family.ownerIds.has(idKey(previousOwner.Id)) && !sameId(mappedOwner, ownerId)
          || existing.NativeType !== target.nativeType || existing.IsFolder !== false
          || !samePath(existing.Path, target.identityPath) || !sameId(existing.ParentId, folder.Id)) {
          throw new StorageError('invalid-response', 'The deterministic owned-part identity conflicts with an existing item.');
        }
        const changes = this.#changesFor(existing, target, folder, root);
        if (!sameId(existing.OwnerId, ownerId)) changes.OwnerId = ownerId;
        if (nonemptyId(existing.PrimaryVersionId)) changes.PrimaryVersionId = null;
        if (!sameId(existing.ParentId, folder.Id)) changes.ParentId = folder.Id;
        if (!sameId(repositoryTopParentId(existing), root.Id)) changes.TopParentId = root.Id;
        if (existing.ExtraType != null) changes.ExtraType = null;
        if (Object.keys(changes).length) {
          changes.DateLastSaved = nativeDate(this.clock());
          const [stored] = await db.rows('BaseItems', { where: { Id: existing.Id } });
          const prospective = this.#draftItem({ ...stored, ...changes }, target);
          const tuple = await this.#prepareSaveTuple(db, prospective, state.libraryState);
          await db.update('BaseItems', { Id: existing.Id }, changes);
          existing = await this.#item(db, existing.Id);
          await this.#saveRelations(db, existing, state.libraryState, tuple);
          structurallyUpdatedIds.add(idKey(existing.Id));
          structuralEventParents.set(idKey(existing.Id), folder);
          pathCatalog.set(existing);
        }
      } else {
        const row = this.#newItemRow(target, folder, root, ownerId, undefined, true, state.libraryState), draft = this.#draftItem(row, target, true);
        const tuple = await this.#prepareSaveTuple(db, draft, state.libraryState);
        const inserted = await db.insert('BaseItems', { ...row, ...this.#listColumns(draft) });
        existing = this.#draftItem(inserted, target, true);
        await persistItemProviderIds(db, existing);
        await this.#saveRelations(db, existing, state.libraryState, tuple);
        addedIds.add(idKey(existing.Id));
        pathCatalog.set(existing);
      }
      currentPartById.set(idKey(existing.Id), existing);
    }

    for (const item of [...currentPartById.values()]) {
      if (desiredPartRoles.has(idKey(item.Id)) || removedIds.has(idKey(item.Id))) continue;
      const family = familyForPart(item);
      if (!family) continue;
      if (!family.deletionSafe) continue;
      if (observedPaths.has(pathKey(item.Path)) && !desiredByPath.has(pathKey(item.Path))) {
        markIncomplete(folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, item);
        continue;
      }
      await removeManagedPart(item, family);
    }

    for (const family of extraFamilies) {
      for (const [fromId, toId] of reroutes) if (family.ownerIds.has(idKey(toId))) family.ownerIds.add(fromId);
      if (!family.deletionSafe) {
        markIncomplete(folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, family.target,
          family.target.primary?.identityPath ?? family.target.identityPath);
      }
    }
    const extraOwnerStorageIds = [...new Set(extraFamilies.flatMap(family => [...family.ownerIds]
      .flatMap(ownerId => this.#idValues(ownerId))))];
    const currentExtras = extraOwnerStorageIds.length
      ? parseItems(await db.rows('BaseItems', { whereIn: { OwnerId: extraOwnerStorageIds } }))
        .filter(item => item.ExtraType != null) : [];
    if (this.library.options.expandPath) for (const item of currentExtras) item.Path = this.library.options.expandPath(item.Path);
    const currentExtraById = new Map(currentExtras.map(item => [idKey(item.Id), item]));
    const familyForExtra = item => extraFamilies.find(family => family.ownerIds.has(idKey(item.OwnerId))) ?? null;
    const removeManagedExtra = async (item, family, required = false) => {
      const owner = await this.#ownedExtraOwner(db, item, root.Id);
      const safePath = identityWithin(item.Path, folder.Path) && identityWithin(item.Path, root.Path);
      const subtree = owner && safePath ? await this.#subtree(db, item, owner, signal) : null;
      const safeSubtree = subtree?.length === 1 && sameId(subtree[0].item.Id, item.Id);
      const externallyReferenced = safeSubtree && await this.#hasExternalReferences(db, subtree, signal);
      if (!owner || !safePath || !safeSubtree || externallyReferenced) {
        if (required) {
          throw new StorageError('unsupported/type-reclassification-required',
            `The owned extra at ${item.Path} cannot be safely replaced.`);
        }
        markIncomplete(externallyReferenced
          ? folderScanIncompleteReasonCodes.EXTERNAL_REFERENCE_DELETION_SKIPPED
          : folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, item);
        return false;
      }
      const removed = await deleteItemsInDatabase(db, [item.Id], { now: () => nativeDate(this.clock()) });
      if (removed.size !== 1 || !removed.has(idKey(item.Id))) {
        throw new StorageError('version-changed', 'The owned-extra deletion ownership changed during reconciliation.');
      }
      journal.removed.push({ item, parent: owner });
      removedIds.add(idKey(item.Id));
      currentExtraById.delete(idKey(item.Id));
      pathCatalog.remove(item);
      return true;
    };

    for (const entry of desiredExtras) {
      checkAbort(signal);
      const { target, ownerId, extraType, family: familyTarget } = entry;
      const family = extraFamilies.find(value => value.target === familyTarget);
      if (!family) throw new StorageError('invalid-response', 'An owned extra has no authoritative owner family.');
      const owner = await this.#item(db, ownerId);
      if (!owner || !this.#isManagedIdentity(owner, root.Id) || owner.ExtraType != null) {
        throw new StorageError('invalid-response', 'An owned extra references an invalid managed owner.');
      }
      const targetPath = pathKey(target.identityPath);
      const collisions = pathCatalog.owners(target.identityPath)
        .filter(item => !sameId(item.Id, target.Id) && !removedIds.has(idKey(item.Id)));
      for (const collision of collisions) {
        const storedCollision = await this.#item(db, collision.Id) ?? collision;
        const collisionFamily = familyForExtra(storedCollision);
        if (!family.deletionSafe || collisionFamily !== family || storedCollision.ExtraType == null) {
          throw new StorageError('invalid-response', `The owned-extra path is already owned by ${collision.Type}.`);
        }
        await removeManagedExtra(storedCollision, family, true);
      }
      const planned = state.touchedPaths.get(targetPath);
      if (planned && !sameId(planned.Id, target.Id)) {
        throw new StorageError('invalid-response', 'The storage plan contains ambiguous item paths.');
      }
      state.touchedPaths.set(targetPath, { Id: target.Id, path: target.identityPath });
      let existing = await this.#item(db, target.Id);
      if (existing) {
        const previousOwner = await this.#ownedExtraOwner(db, existing, root.Id);
        if (!previousOwner || !family.ownerIds.has(idKey(previousOwner.Id))
          || existing.NativeType !== target.nativeType || existing.IsFolder !== false
          || !samePath(existing.Path, target.identityPath)) {
          throw new StorageError('invalid-response', 'The deterministic owned-extra identity conflicts with an existing item.');
        }
        const changes = this.#changesFor(existing, target, folder, root);
        if (!sameId(existing.OwnerId, ownerId)) changes.OwnerId = ownerId;
        if (nonemptyId(existing.ParentId)) changes.ParentId = null;
        if (nonemptyId(repositoryTopParentId(existing))) changes.TopParentId = null;
        if (nonemptyId(existing.PrimaryVersionId)) changes.PrimaryVersionId = null;
        if ((existing.ExtraType == null || extraTypeCode(existing.ExtraType) === 0 || extraType !== 0)
          && extraTypeCode(existing.ExtraType) !== extraType) changes.ExtraType = extraType;
        const lockedName = (await db.rows('BaseItemMetadataFields', {
          where: { ItemId: existing.Id },
          columns: ['Id']
        })).some(value => Number(value.Id) === 5);
        if (!lockedName && target.draft.Name && existing.Name !== target.draft.Name) {
          changes.Name = target.draft.Name;
          changes.CleanName = cleanValue(target.draft.Name);
          changes.SortName = sortName({ ...existing, ...changes }, this.library.options) ?? null;
        }
        if (Object.keys(changes).length) {
          changes.DateLastSaved = nativeDate(this.clock());
          const [stored] = await db.rows('BaseItems', { where: { Id: existing.Id } });
          const prospective = this.#draftItem({ ...stored, ...changes }, target);
          const tuple = await this.#prepareSaveTuple(db, prospective, state.libraryState);
          await db.update('BaseItems', { Id: existing.Id }, changes);
          existing = await this.#item(db, existing.Id);
          await this.#saveRelations(db, existing, state.libraryState, tuple);
          structurallyUpdatedIds.add(idKey(existing.Id));
          structuralEventParents.set(idKey(existing.Id), owner);
          pathCatalog.set(existing);
        }
      } else {
        const row = this.#newItemRow(target, folder, root, ownerId, extraType, false, state.libraryState), draft = this.#draftItem(row, target, true);
        const tuple = await this.#prepareSaveTuple(db, draft, state.libraryState);
        const inserted = await db.insert('BaseItems', { ...row, ...this.#listColumns(draft) });
        existing = this.#draftItem(inserted, target, true);
        await persistItemProviderIds(db, existing);
        await this.#saveRelations(db, existing, state.libraryState, tuple);
        addedIds.add(idKey(existing.Id));
        pathCatalog.set(existing);
      }
      currentExtraById.set(idKey(existing.Id), existing);
    }

    for (const item of [...currentExtraById.values()]) {
      if (desiredExtraRoles.has(idKey(item.Id)) || removedIds.has(idKey(item.Id))) continue;
      const family = familyForExtra(item);
      if (!family) continue;
      const mappedOwner = reroutes.get(idKey(item.OwnerId));
      if (mappedOwner && family.ownerIds.has(idKey(mappedOwner))) {
        const owner = await this.#item(db, mappedOwner);
        const prospective = { ...item, OwnerId: mappedOwner };
        const tuple = await this.#prepareSaveTuple(db, prospective, state.libraryState);
        await db.update('BaseItems', { Id: item.Id }, { OwnerId: mappedOwner, DateLastSaved: nativeDate(this.clock()) });
        const updated = await this.#item(db, item.Id);
        await this.#saveRelations(db, updated, state.libraryState, tuple);
        currentExtraById.set(idKey(item.Id), updated);
        item.OwnerId = mappedOwner;
        structurallyUpdatedIds.add(idKey(item.Id));
        structuralEventParents.set(idKey(item.Id), owner);
      }
      if (!family.deletionSafe) continue;
      await removeManagedExtra(item, family);
    }

    for (const item of direct) {
      const itemKey = idKey(item.Id), previousOwner = priorLocalOwners.get(itemKey);
      if (!previousOwner || desiredIds.has(itemKey) || removedIds.has(itemKey)) continue;
      if (!deletionSafe || observedPaths.has(pathKey(item.Path))) {
        const mappedOwner = reroutes.get(idKey(previousOwner.Id));
        if (mappedOwner) {
          throw new StorageError('unsupported/type-reclassification-required',
            `The observed local alternate at ${item.Path} cannot remain attached to a replaced primary.`);
        }
        markIncomplete(deletionSafe
          ? folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED
          : folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT, item);
        continue;
      }
      const remainingOwned = (await this.#owned(db, item.Id)).filter(value => !removedIds.has(idKey(value.Id)));
      if (remainingOwned.length) {
        throw new StorageError('unsupported/type-reclassification-required',
          `The missing local alternate at ${item.Path} still owns items.`);
      }
      const removed = await deleteItemsInDatabase(db, [item.Id], { now: () => nativeDate(this.clock()) });
      if (removed.size !== 1 || !removed.has(itemKey)) {
        throw new StorageError('version-changed', 'The local alternate deletion ownership changed during reconciliation.');
      }
      journal.removed.push({ item, parent: folder });
      removedIds.add(itemKey);
    }

    for (const { target, primaryId } of desiredEntries) {
      if (addedIds.has(idKey(target.Id))) continue;
      if (weakPreservedIds.has(idKey(target.Id)) || weakPreservedIds.has(idKey(primaryId))) continue;
      let existing = await this.#item(db, target.Id);
      const changes = this.#changesFor(existing, target, folder, root);
      const linkedCreation = state.linkedChanges?.added.has(idKey(existing.Id)) === true;
      if (linkedCreation && !sameId(repositoryTopParentId(existing), root.Id)) changes.TopParentId = root.Id;
      const previousOwner = previousOwners.get(idKey(target.Id));
      const roleChanged = primaryId == null ? Boolean(previousOwner) : !sameId(previousOwner?.Id, primaryId);
      if (Object.keys(changes).length) {
        if (state.lifecycleApplied.has(idKey(existing.Id)) && !roleChanged) {
          throw new StorageError('version-changed',
            'The resolved item changed after its existing-item lifecycle completed.');
        }
        await db.update('BaseItems', { Id: existing.Id }, changes);
        if (!linkedCreation) structurallyUpdatedIds.add(idKey(existing.Id));
        existing = await this.#item(db, existing.Id);
        if (linkedCreation) {
          const live = await this.itemCreation.getItemById(existing.Id);
          if (live) live.NativeTopParentId = repositoryTopParentId(existing);
        }
        this.#rememberRelationItem(state.libraryState, existing);
      }
    }

    for (const { item, required } of deferredCollapsedRemovals.values()) {
      if (removedIds.has(idKey(item.Id))) continue;
      const current = await this.#item(db, item.Id);
      if (!current) throw new StorageError('version-changed', 'A collapsed primary disappeared during reconciliation.');
      const subtree = await removableSubtree(current, current.Path, required);
      if (subtree) await removeSubtree(current, subtree);
    }

    if (deletionSafe) {
      const currentDirect = await this.#children(db, folder.Id);
      for (const missing of currentDirect.filter(item => this.resolverPipeline.manages(item)
        && !nonemptyId(item.OwnerId) && !nonemptyId(item.PrimaryVersionId)
        && !desiredIds.has(idKey(item.Id)) && !removedIds.has(idKey(item.Id)))) {
        if (observedPaths.has(pathKey(missing.Path))) {
          markIncomplete(folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, missing);
          continue;
        }
        if (!identityWithin(missing.Path, folder.Path)
          || !identityWithin(missing.Path, root.Path)
          || !this.#isDirectAccessChild(missing, folder)
          || !this.#isManagedItem(missing, root.Id)) {
          markIncomplete(folderScanIncompleteReasonCodes.UNSAFE_DELETION_SKIPPED, missing);
          continue;
        }
        const subtree = await removableSubtree(missing, missing.Path, false);
        if (!subtree) continue;
        await removeSubtree(missing, subtree);
      }
    }

    if (removedIds.size) {
      state.libraryState.items = state.libraryState.items.filter(item => !removedIds.has(idKey(item.Id)));
      for (const id of removedIds) { state.libraryState.byId.delete(id); state.libraryState.persistedIds.delete(id); }
    }

    for (const id of structurallyUpdatedIds) {
      if (addedIds.has(id) || removedIds.has(id)) continue;
      const item = await this.#item(db, id);
      if (!item) throw new StorageError('version-changed', 'A locally versioned item changed during reconciliation.');
      this.#rememberRelationItem(state.libraryState, item);
      journal.updated.push({ item, parent: structuralEventParents.get(id) ?? folder });
    }

    const children = [];
    for (const target of desired) {
      if (weakSkippedIds.has(idKey(target.Id))) continue;
      const child = await this.#item(db, target.Id);
      if (!child) throw new StorageError('version-changed', 'A desired scan item disappeared during reconciliation.');
      if (target.traversal === 'children') children.push(child);
    }
    checkAbort(signal);
    const result = { journal, children, skippedDeletion, incompleteReasons: freezeIncompleteReasons(incompleteReasons) };
    for (const { item } of result.journal.removed) pathCatalog.remove(item);
    for (const { item } of result.journal.updated) pathCatalog.set(item);
    for (const { item } of result.journal.added) pathCatalog.set(item);
    return result;
  }

  #publish(journal) {
    for (const { item, parent } of journal.removed) this.library.reportItemRemoved(item, parent);
    for (const { item, parent } of journal.updated) this.library.reportItemUpdated(item, parent, 2);
    for (const { item, parent } of journal.added) this.library.reportItemAdded(item, parent);
  }
}
