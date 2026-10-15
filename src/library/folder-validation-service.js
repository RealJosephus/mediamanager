import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { StorageError } from '../storage/errors.js';
import { joinPath } from '../storage/paths.js';
import { EMPTY_ID, VIDEO_TYPES, idKey, nonemptyId, repositoryTopParentId } from './records.js';
import { compareNativePaths, nativeFileName, nativeFileNameWithoutExtension, nativePathKey, sameNativePath } from './native-path.js';
import { filterResolutionCandidates } from './resolution-ignore.js';
import { createResolvedItemEntity } from './resolved-item-entity.js';
import { releaseCachedFolderChildren } from './folder-cache.js';
import { collectionFoldersForItem, parentChainForItem } from './collection-membership.js';
import { buildScanCollectionContext } from './scan-context.js';
import { itemTopParentId } from './item-save-tuple.js';
import { resolvedItemStructuralSnapshot } from './resolved-item-lifecycle.js';
import { isFileProtocol } from './owned-items.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { setPrimaryVersion } from './live-item-repository.js';
import { userDataKeys } from '../sessions/user-data.js';
import { reattachUserData } from '../metadata/persistence.js';
import { loadPostgresNavigationRows, loadPostgresPageGraph,
  loadPostgresRowsByIds, queryPostgresValidationChildren } from './postgres-library-query.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { getNewItemId } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';
import { DotIgnoreRule } from './dot-ignore-rule.js';
import { stateIgnoreFileAccess, stateOwnedFiles } from './state-owned-files.js';

const pathStyle = value => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value) ? 'windows' : 'posix';
const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

/**
 * Native Folder.ValidateChildren boundary. Each folder completes its directory
 * snapshot before mutating persistence, commits independently, and always
 * releases its live cached children.
 */
export class FolderValidationService {
  #ownership = new AsyncLocalStorage();
  #retain(item) {
    if (!item) return item;
    const owner = this.itemCreation.retainItem(item);
    this.#ownership.getStore().push(() => owner.release());
    return item;
  }
  async #context(reference, options) {
    const loaded = await this.loadContext(reference, options);
    this.#ownership.getStore().push(() => loaded.dispose());
    return loaded;
  }
  async #state(db, user, options) {
    const state = await this.library.load(db, user, options);
    this.#ownership.getStore().push(() => state.dispose());
    return state;
  }
  constructor({ store, library, itemCreation, resolvedItemLifecycle, vfs, identityMap, ignoreRule, resolverPipeline, loadContext,
    programDataPath, configurationDirectoryPath, metadataConfiguration = { UseFileCreationTimeForDateAdded: true },
    configuration = library?.options?.configuration ?? {}, refreshes, linkedChildReferences, metadataScanner, scheduler,
    clock = () => new Date(), onError = () => {}, reattach = reattachUserData } = {}) {
    if (!store || !library || !itemCreation || !vfs || !identityMap || !ignoreRule
      || !resolverPipeline || typeof resolverPipeline.resolve !== 'function' || typeof loadContext !== 'function') {
      throw new TypeError('Folder validation requires persistence, library, item creation, storage, identity mapping, ignore rules, resolution and metadata context.');
    }
    if (typeof programDataPath !== 'string' || !programDataPath) {
      throw new TypeError('Folder validation requires the native program data path.');
    }
    if (typeof onError !== 'function') throw new TypeError('Folder validation error reporting must be a function.');
    if (typeof reattach !== 'function') throw new TypeError('Folder validation user data reattachment must be a function.');
    if (!refreshes || typeof refreshes.reportStarted !== 'function' || typeof refreshes.reportProgress !== 'function'
      || typeof refreshes.reportCompleted !== 'function') {
      throw new TypeError('Folder validation requires provider refresh lifecycle reporting.');
    }
    if (!linkedChildReferences || typeof linkedChildReferences.reroute !== 'function') {
      throw new TypeError('Folder validation requires linked child reference rerouting.');
    }
    if (!metadataScanner || typeof metadataScanner.refreshAccessibleChildren !== 'function'
      || typeof metadataScanner.refreshContainer !== 'function') {
      throw new TypeError('Folder validation requires child metadata traversal.');
    }
    if (!scheduler || typeof scheduler.enqueue !== 'function') throw new TypeError('Folder validation requires the shared library scheduler.');
    if (!resolvedItemLifecycle || typeof resolvedItemLifecycle.apply !== 'function'
      || typeof resolvedItemLifecycle.updateRepository !== 'function') {
      throw new TypeError('Folder validation requires the existing-item repository lifecycle.');
    }
    Object.assign(this, { store, library, itemCreation, resolvedItemLifecycle, vfs, identityMap, ignoreRule, resolverPipeline, loadContext,
      programDataPath, configurationDirectoryPath, metadataConfiguration, configuration, refreshes, linkedChildReferences,
      metadataScanner, scheduler, clock, onError, reattach });
    const nativePath = pathStyle(programDataPath) === 'windows' ? path.win32 : path.posix;
    this.applicationRootPath = nativePath.join(programDataPath, 'root');
  }

  #accessPath(folder) {
    const style = pathStyle(folder.Path);
    const accessPath = this.identityMap.resolve({ itemId: folder.Id, identityPath: folder.Path, style });
    const reverse = this.identityMap.identityFor(accessPath);
    if (reverse.style !== style || !sameNativePath(reverse.identityPath, folder.Path)
      || this.identityMap.resolve({ identityPath: reverse.identityPath, style: reverse.style }) !== accessPath) {
      throw new StorageError('invalid-response', 'The folder access mapping is not reversibly bound to its identity path.');
    }
    return accessPath;
  }

  #report(error) {
    try { void Promise.resolve(this.onError(error)).catch(() => {}); }
    catch { /* Folder validation diagnostics cannot replace native no-op recovery. */ }
  }

  #classifyEntries(accessPath, entries) {
    const paths = new Set(), candidates = [];
    for (const entry of entries) {
      const childAccessPath = joinPath(accessPath, entry.name);
      const identity = this.identityMap.identityFor(childAccessPath);
      const forward = this.identityMap.resolve({ identityPath: identity.identityPath, style: identity.style });
      if (forward !== childAccessPath) {
        throw new StorageError('invalid-response', 'A child folder identity mapping is not reversible.');
      }
      const key = nativePathKey(identity.identityPath);
      if (paths.has(key)) throw new StorageError('invalid-response', 'The directory listing contains ambiguous native paths.');
      paths.add(key);
      candidates.push({ identityPath: identity.identityPath, accessPath: childAccessPath, entry });
    }
    candidates.sort((left, right) => compareNativePaths(left.identityPath, right.identityPath));
    return { candidates, observedPaths: paths };
  }

  async #filterCandidates(snapshot, parent, root, signal) {
    return {
      ...snapshot,
      candidates: await filterResolutionCandidates(snapshot.candidates, {
        ignoreRule: this.ignoreRule,
        parent,
        root,
        applicationRootPath: this.applicationRootPath,
        signal
      })
    };
  }

  async #filterExtraCandidates(snapshot, signal) {
    const candidates = [];
    for (const candidate of snapshot.candidates) {
      throwIfAborted(signal);
      const ignored = await this.ignoreRule.shouldIgnore(candidate.identityPath, {
        isDirectory: candidate.entry.kind === 'directory',
        signal
      });
      throwIfAborted(signal);
      if (!ignored) candidates.push(candidate);
    }
    return { ...snapshot, candidates };
  }

  async #currentChildren(parent) {
    return this.store.run(async db => {
      const navigationRows = await loadPostgresNavigationRows(db, parent.Id);
      const childRows = await queryPostgresValidationChildren(db, parent.Id);
      const childIds = childRows.map(row => idKey(row.Id));
      const graphRows = await loadPostgresPageGraph(db,
        [...await loadPostgresRowsByIds(db, [parent.Id]), ...childRows], navigationRows);
      const state = await this.#state(db, null, { includeUserData: false, baseRows: graphRows });
      const persisted = state.byId.get(idKey(parent.Id));
      if (!persisted || !persisted.IsFolder || itemType(persisted) !== itemType(parent)) {
        throw Object.assign(new Error('Folder not found.'), { status: 404, statusCode: 404 });
      }
      return childIds.map(id => state.byId.get(id)).filter(Boolean);
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  async #collectionContext(parent, collectionType) {
    return this.store.run(async db => {
      const navigationRows = await loadPostgresNavigationRows(db, parent.Id);
      const targetRows = await loadPostgresRowsByIds(db, [parent.Id]);
      const graphRows = await loadPostgresPageGraph(db, targetRows, navigationRows);
      const state = await this.#state(db, null, { includeUserData: false, baseRows: graphRows });
      const persistedParent = state.byId.get(idKey(parent.Id)) ?? parent;
      const parents = parentChainForItem(persistedParent, state);
      const topParentId = itemTopParentId(persistedParent, parents);
      const root = topParentId == null ? null : [persistedParent, ...parents].find(item => idKey(item.Id) === idKey(topParentId));
      const context = buildScanCollectionContext({
        root: parent,
        state,
        collectionFolders: collectionFoldersForItem(parent, state),
        libraryOptions: this.library.options.libraryOptions,
        configuration: this.library.options.configuration
      });
      // An explicitly supplied null is the oracle's unknown-type control;
      // ordinary production calls inherit the real library configuration.
      return {
        root,
        collectionContext: collectionType === undefined ? context : Object.freeze({ ...context, collectionType })
      };
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  async #resolve(parent, root, collectionContext, onEnumerationReady) {
    if (itemType(parent) === 'AggregateFolder') return this.#resolveAggregate(parent, onEnumerationReady);
    if (itemType(parent) === 'PlaylistsFolder') return this.#resolveInstanceFolder(parent, root, collectionContext, onEnumerationReady);
    const accessPath = this.#accessPath(parent);
    const listing = await this.vfs.list(accessPath);
    if (root && idKey(root.Id) === idKey(parent.Id) && itemType(parent) !== 'BoxSet'
      && nativeFileNameWithoutExtension(parent.Path)?.toLowerCase() !== 'collections' && listing.entries.length === 0) return null;
    const raw = { listing, ...this.#classifyEntries(accessPath, listing.entries) };
    const filtered = await this.#filterCandidates(raw, parent, root);
    const directorySnapshots = new Map();
    const peekDirectory = (candidate, { forExtras = false } = {}) => {
      if (candidate?.entry?.kind !== 'directory') throw new TypeError('Only directory candidates can be enumerated.');
      const key = nativePathKey(candidate.identityPath);
      if (!directorySnapshots.has(key)) directorySnapshots.set(key, { raw: (async () => {
        const childListing = await this.vfs.list(candidate.accessPath);
        return { listing: childListing, ...this.#classifyEntries(candidate.accessPath, childListing.entries) };
      })() });
      const snapshots = directorySnapshots.get(key);
      if (forExtras) return snapshots.raw;
      snapshots.filtered ??= snapshots.raw.then(snapshot => this.#filterCandidates(snapshot, parent, root));
      return snapshots.filtered;
    };
    let rootExtraSnapshot;
    const getExtraCandidates = candidate => {
      if (candidate == null) return rootExtraSnapshot ??= this.#filterExtraCandidates(raw);
      const snapshot = peekDirectory(candidate, { forExtras: true });
      const snapshots = directorySnapshots.get(nativePathKey(candidate.identityPath));
      return snapshots.extras ??= snapshot.then(value => this.#filterExtraCandidates(value));
    };
    const resolution = await this.resolverPipeline.resolve({
      parent,
      root,
      collectionContext,
      candidates: filtered.candidates,
      peekDirectory,
      getExtraCandidates,
      resolveExtra: async ({ candidate }) => (await filterResolutionCandidates([candidate], {
        ignoreRule: this.ignoreRule,
        applicationRootPath: this.applicationRootPath
      })).length > 0,
      deletionSafe: listing.deletionSafe === true,
      onEnumerationReady
    });
    return Object.freeze({ ...resolution, deletionSafe: listing.deletionSafe === true });
  }

  async #resolveAggregate(parent, onEnumerationReady) {
    const loaded = await this.#context(parent.Id, { draft: parent });
    // AggregateFolder.GetFileSystemChildren updates the live location list.
    // A later metadata save persists that state, including across scans.
    const resolution = await loaded.rootFolderResolveArgs(true);
    onEnumerationReady();
    const claims = [];
    for (const file of resolution.files) if (file.IsDirectory && file.Exists !== false) {
      const nativeType = 'MediaBrowser.Controller.Entities.Folder';
      claims.push(Object.freeze({
        Id: nativeGuid(getNewItemId(file.Path, nativeType, {
          programDataPath: this.programDataPath,
          enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
        })),
        nativeType, identityPath: file.Path,
        entry: { kind: 'directory', name: file.Name ?? nativeFileName(file.Path) },
        draft: { Name: file.Name ?? nativeFileName(file.Path), IsFolder: true, MediaType: 'Unknown', SourceType: 'Library' }
      }));
    }
    // CreateRootFolder appends its registered plug-in entities after resolving
    // physical locations. They are live entities, not resolver constructions.
    for (const item of parent.VirtualChildren) claims.push(Object.freeze({
      Id: item.Id, nativeType: item.NativeType, identityPath: item.Path,
      entry: { kind: 'directory', name: nativeFileName(item.Path) },
      draft: { Name: item.Name, IsFolder: true, MediaType: item.MediaType, SourceType: item.SourceType },
      resolvedEntity: item
    }));
    return Object.freeze({ claims: Object.freeze(claims), withheldPaths: Object.freeze([]), deletionSafe: true });
  }

  async #resolveInstanceFolder(parent, root, collectionContext, onEnumerationReady) {
    const loaded = await this.#context(parent.Id, { draft: parent });
    const assets = loaded.context.imageAssets, files = stateOwnedFiles(assets);
    const ignoreRule = new DotIgnoreRule({ fileAccess: stateIgnoreFileAccess(assets, this.ignoreRule.fileAccess) });
    const snapshots = new Map();
    const snapshot = identityPath => {
      const key = nativePathKey(identityPath);
      if (!snapshots.has(key)) snapshots.set(key, (async () => {
        const listing = await files.list(identityPath);
        // This namespace is used only for direct-child provenance checks;
        // every actual read is through the confined instance asset source.
        const candidates = listing.entries.map(entry => ({ identityPath: entry.Path,
          accessPath: entry.Path.replaceAll('\\', '/'), entry }));
        return { listing, candidates };
      })());
      return snapshots.get(key);
    };
    const filter = async raw => ({ ...raw, candidates: await filterResolutionCandidates(raw.candidates, {
      ignoreRule, parent, root, applicationRootPath: this.applicationRootPath }) });
    const initial = await filter(await snapshot(parent.Path));
    const resolution = await this.resolverPipeline.resolve({ parent, root, collectionContext,
      candidates: initial.candidates, deletionSafe: true, onEnumerationReady,
      peekDirectory: async (candidate, { forExtras = false } = {}) => {
        const raw = await snapshot(candidate.identityPath);
        return forExtras ? raw : filter(raw);
      },
      getExtraCandidates: async candidate => {
        const raw = await snapshot(candidate?.identityPath ?? parent.Path);
        return filter(raw);
      },
      resolveExtra: async ({ candidate }) => (await filterResolutionCandidates([candidate], {
        ignoreRule, applicationRootPath: this.applicationRootPath })).length > 0 });
    return Object.freeze({ ...resolution, deletionSafe: true });
  }

  async #isAccessibleTopParent(parent, allowRemoveRoot, resolvedParent) {
    if (itemType(parent) !== 'PlaylistsFolder' && itemType(resolvedParent) !== 'AggregateFolder'
      && parent.IsTopParent !== true && idKey(repositoryTopParentId(parent)) !== idKey(parent.Id)) return true;
    if (!allowRemoveRoot && (itemType(parent) === 'BoxSet'
      || nativeFileNameWithoutExtension(parent.Path)?.toLowerCase() === 'collections')) return true;
    if (itemType(parent) === 'PlaylistsFolder') {
      const loaded = await this.#context(parent.Id, { draft: parent });
      try { return (await loaded.rootFolderResolveArgs(false)).files.length > 0; }
      catch (error) {
        if (['not-found', 'not-directory', 'permission-denied', 'authentication-required'].includes(error?.code)) return false;
        throw error;
      }
    }
    const accessPath = this.#accessPath(parent);
    try { return (await this.vfs.list(accessPath)).entries.length > 0; }
    catch (error) {
      if (['not-found', 'not-directory', 'permission-denied', 'authentication-required'].includes(error?.code)) return false;
      throw error;
    }
  }

  async #withAlternateVersions(item, operation) {
    const linkedChildren = this.loadContext.linkedChildren;
    let links, cohort;
    try {
      links = await this.store.run(db => {
        const sql = nativeTextSql(db.schemaName), table = `${q(db.schemaName)}.${q('LinkedChildren')}`;
        return linkedChildren.createFromSnapshot({ session: db, parentId: item.Id, plan: {
          text: `WITH source AS (SELECT *,${sql.guidKey('"ChildId"')} AS key FROM ${table}
            WHERE ${sql.guidKey('"ParentId"')}=$1 AND "ChildType" IN (2,3)), grouped AS (
            SELECT key,bool_or("ChildType"=2) AS local,
              COALESCE(min("SortOrder") FILTER(WHERE "ChildType"=2),min("SortOrder")) AS position FROM source GROUP BY key)
            SELECT row_number() OVER(ORDER BY grouped.local DESC,grouped.position) AS "Ordinal",
              (SELECT "ChildId" FROM source WHERE source.key=grouped.key ORDER BY "SortOrder" LIMIT 1) AS "ItemId",
              CASE WHEN grouped.local THEN 2 ELSE 3 END AS "Type",NULL::bytea AS "Path",NULL::bytea AS "LibraryItemId"
            FROM grouped ORDER BY grouped.local DESC,grouped.position`, values: [idKey(item.Id)] } });
      }, { readOnly: true });
      cohort = await createNativeItemCohort({ linkedChildren });
      // Complete all original lookups before the first version update.
      for await (const page of linkedChildren.pages(links)) for (const row of page) {
        await this.itemCreation.withItem(row.ItemId, async alternate => {
          if (alternate && VIDEO_TYPES.has(alternate.Type)) await cohort.capture(alternate, { ordinal: row.Ordinal });
        });
      }
      for (let after = 0n; ;) {
        const page = await cohort.page({ after, limit: 128 });
        try {
          if (!page.entries.length) break;
          for (const entry of page.entries) {
            const [raw] = await linkedChildren.page(links, { after: entry.Ordinal - 1n, limit: 1 });
            await operation(entry.item, raw.Type === 2);
          }
          after = page.entries.at(-1).Ordinal;
        } finally { await page.release(); }
      }
    } finally {
      try { await cohort?.release(); } finally { if (links) await linkedChildren.release(links); }
    }
  }

  #updateVersion(item, signal) {
    return this.resolvedItemLifecycle.updateRepository(item, { itemCreation: this.itemCreation, signal });
  }

  async #promoteVersion(item, signal) {
    if (item.PrimaryVersionId == null && !nonemptyId(item.OwnerId)) return;
    setPrimaryVersion(item, null); item.OwnerId = EMPTY_ID;
    await this.#updateVersion(item, signal);
  }

  async #transferVersions(oldPrimary, newPrimary, signal) {
    await this.#withAlternateVersions(oldPrimary, async (alternate, local) => { if (idKey(alternate.Id) !== idKey(newPrimary.Id)) {
      setPrimaryVersion(alternate, newPrimary.Id);
      alternate.OwnerId = local ? newPrimary.Id : EMPTY_ID;
      await this.#updateVersion(alternate, signal);
    } });
  }

  async #reattachRemovedUserData(removed, valid, signal) {
    if (removed.size === 0) return;
    const matching = await this.store.run(async db => {
      const removedKeys = new Set();
      for (const item of removed.values()) {
        for (const key of await userDataKeys(db, item)) removedKeys.add(key);
      }
      const children = [];
      for (const child of valid.values()) {
        if ((await userDataKeys(db, child)).some(key => removedKeys.has(key))) children.push(child);
      }
      return children;
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
    // Native reattaches each valid child independently. A later failure or
    // cancellation therefore retains deletions, creation and earlier moves.
    for (const child of matching) await this.reattach(this.store, child, { signal });
  }

  async #assertAcyclic(parent) {
    await this.store.run(async db => {
      const navigationRows = await loadPostgresNavigationRows(db, parent.Id);
      const targetRows = await loadPostgresRowsByIds(db, [parent.Id]);
      const graphRows = await loadPostgresPageGraph(db, targetRows, navigationRows);
      const state = await this.#state(db, null, { includeUserData: false, baseRows: graphRows });
      const origin = idKey(parent.Id);
      let current = state.byId.get(origin) ?? parent;
      const visited = new Set();
      while (nonemptyId(current?.ParentId)) {
        const key = idKey(current.ParentId);
        if (key === origin) {
          throw new StorageError('invalid-operation', 'Recursive datastructure detected abort processing this item.');
        }
        if (visited.has(key)) break;
        visited.add(key);
        current = state.byId.get(key);
        if (!current) break;
      }
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  #progress(reportProgress, value) {
    try { reportProgress(value); }
    catch { /* A progress observer cannot replace folder validation. */ }
  }

  async #accessibleChildren(children) {
    const cohort = await createNativeItemCohort({ linkedChildren: this.loadContext.linkedChildren });
    this.#ownership.getStore().push(() => cohort.release());
    let ordinal = 0n;
    for (const child of children.values()) await cohort.capture(child, { ordinal: ++ordinal });
    const sequence = metadataChildSequence(cohort, this.loadContext.linkedChildren, this.store);
    this.#ownership.getStore().push(() => sequence.close());
    return sequence;
  }

  async #validateSubFolders(children, { collectionType, signal, reportProgress }) {
    await this.scheduler.enqueue(children, (folder, progress) => this.validateChildren(folder, {
      collectionType, signal, recursive: true, refreshChildMetadata: false, allowRemoveRoot: false,
      reportProgress: progress
    }), { signal, reportProgress: value => this.#progress(reportProgress, value),
      predicate: child => child?.IsFolder === true, onError: error => this.#report(error) });
  }

  async validateChildren(parent, { collectionType, signal, recursive = false,
    refreshChildMetadata = true, allowRemoveRoot = false, reportProgress = () => {}, ...metadataRefreshOptions } = {}) {
    const cleanups = [];
    let failure;
    return this.#ownership.run(cleanups, () => this.loadContext.withScope(async () => {
      try { if (parent) this.#retain(parent);
        return await this.#validateChildren(parent, { collectionType, signal, recursive,
          refreshChildMetadata, allowRemoveRoot, reportProgress, ...metadataRefreshOptions });
      } catch (error) { failure = error; throw error; }
      finally {
        const errors=[];
        for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){errors.push(error);}
        try{await this.loadContext.linkedChildren.flushReleases();}catch(error){errors.push(error);}
        if(errors.length)throw new AggregateError(failure?[failure,...errors]:errors,'Folder validation ownership cleanup failed.',failure?{cause:failure}:undefined);
      }
    }));
  }

  async #validateChildren(parent, { collectionType, signal, recursive,
    refreshChildMetadata, allowRemoveRoot, reportProgress, ...metadataRefreshOptions }) {
    // Playlist and CollectionFolder override validation with a completed task.
    // The outer Folder wrapper still clears children, without touching the
    // filesystem, persistence, refresh lifecycle, progress or cancellation.
    if (['Playlist', 'CollectionFolder'].includes(itemType(parent)) && parent?.IsFolder === true) {
      releaseCachedFolderChildren(parent);
      return Object.freeze({ created: Object.freeze([]), resolved: Object.freeze([]), skipped: false });
    }
    if (!parent || parent.IsFolder !== true || typeof parent.Id !== 'string'
      || typeof parent.Path !== 'string' || !parent.Path) {
      throw new TypeError('Folder validation requires a persisted physical folder.');
    }
    if (recursive !== false && recursive !== true) throw new TypeError('Folder validation recursive mode must be a boolean.');
    if (refreshChildMetadata !== false && refreshChildMetadata !== true) {
      throw new TypeError('Folder validation child metadata mode must be a boolean.');
    }
    if (typeof reportProgress !== 'function') throw new TypeError('Folder validation progress reporting must be a function.');
    if (signal !== undefined) metadataRefreshOptions.signal = signal;
    const progress = value => {
      this.#progress(reportProgress, value);
      if (recursive) this.refreshes.reportProgress(parent, value);
    };
    if (recursive) this.refreshes.reportStarted(parent);
    try {
      if (recursive) await this.#assertAcyclic(parent);
      // Native checks an empty or inaccessible top-level root before observing
      // the request token. BoxSet and the collections root are exempt unless
      // the caller explicitly asks to apply the root-removal guard to them.
      if (!await this.#isAccessibleTopParent(parent, allowRemoveRoot)) {
        return Object.freeze({ created: Object.freeze([]), resolved: Object.freeze([]), skipped: true });
      }
      throwIfAborted(signal);
      // Native completes resolution and reads current children without the
      // request token, then observes cancellation after reporting phase 7.
      // Retrieval failures return before that second cancellation boundary.
      let resolution;
      try {
        const { root, collectionContext } = await this.#collectionContext(parent, collectionType);
        resolution = await this.#resolve(parent, root, collectionContext, () => {
          progress(5);
          progress(5.5);
        });
        if (resolution != null) progress(6);
      }
      catch (error) {
        this.#report(error);
        return Object.freeze({ created: Object.freeze([]), resolved: Object.freeze([]), skipped: true });
      }
      if (resolution == null) return Object.freeze({ created: Object.freeze([]), resolved: Object.freeze([]), skipped: true });
      if (resolution.withheldPaths.length > 0) {
        throw new StorageError('not-supported', 'Folder validation cannot persist a partial sibling batch with withheld paths.');
      }
      const current = await this.#currentChildren(parent);
      const claims = new Map(resolution.claims.map(claim => [idKey(claim.Id), claim]));
      const currentById = new Map(current.map(item => [idKey(item.Id), item]));
      const currentByPath = new Map();
      for (const item of current) if (item.Path && !currentByPath.has(ordinalIgnoreCaseKey(item.Path))) currentByPath.set(ordinalIgnoreCaseKey(item.Path), item);
      progress(7);
      throwIfAborted(signal);
      const loaded = await this.#context(parent.Id, { draft: parent });
      const entities = new Map(resolution.claims.map(claim => [idKey(claim.Id), this.#retain(claim.resolvedEntity ?? createResolvedItemEntity(claim, {
        parent,
        parents: loaded.parents,
        metadataConfiguration: this.metadataConfiguration,
        clock: this.clock
      }))]));
      for (const item of current) {
        const claim = claims.get(idKey(item.Id));
        if (claim && (item.NativeType !== claim.nativeType || !sameNativePath(item.Path, claim.identityPath))) {
          throw new StorageError('not-supported', 'Changing an existing folder child requires structural reconciliation.');
        }
      }
      const stale = current.filter(item => !claims.has(idKey(item.Id)));
      if (stale.some(item => isFileProtocol(item) && item.CanDelete !== false && !item.IsRoot) && !resolution.deletionSafe) {
        throw new StorageError('not-supported', 'Removing folder children requires a strong complete directory snapshot.');
      }
      const created = [], valid = new Map(), accessible = new Map(), actuallyRemoved = new Map();
      let processedChildren = 0;
      const childProcessed = () => {
        processedChildren++;
        if (processedChildren % 25 === 0 || processedChildren === resolution.claims.length) {
          progress(7 + processedChildren / resolution.claims.length);
        }
      };
      // Native lifecycles and same-path type replacement run in resolver order;
      // remaining removals then precede the single new-sibling CreateItems batch.
      for (const claim of resolution.claims) {
        const item = currentById.get(idKey(claim.Id));
        const entity = entities.get(idKey(claim.Id));
        if (!await this.#isAccessibleTopParent(entity, allowRemoveRoot, parent)) {
          if (item) valid.set(idKey(item.Id), item);
          childProcessed();
          continue;
        }
        if (item) {
          await this.resolvedItemLifecycle.apply(item.Id, {
            resolved: entity,
            expected: resolvedItemStructuralSnapshot(item),
            parent,
            signal
          });
          const refreshed = this.#retain(await this.itemCreation.getItemById(item.Id));
          valid.set(idKey(item.Id), refreshed);
          accessible.set(idKey(item.Id), refreshed);
          childProcessed();
          continue;
        }
        const replaced = currentByPath.get(ordinalIgnoreCaseKey(claim.identityPath));
        if (replaced && idKey(replaced.Id) !== idKey(claim.Id)) {
          currentById.delete(idKey(replaced.Id));
          currentByPath.delete(ordinalIgnoreCaseKey(replaced.Path));
          replaced.ParentId = EMPTY_ID;
          await this.library.deleteItem(replaced, { DeleteFileLocation: false }, parent, false);
          actuallyRemoved.set(idKey(replaced.Id), replaced);
        }
        created.push(entity);
        valid.set(idKey(claim.Id), entity);
        accessible.set(idKey(claim.Id), entity);
        childProcessed();
      }
      progress(8);
      const validVideos = [...valid.values()].filter(item => VIDEO_TYPES.has(item.Type));
      const alternatePaths = new Set(validVideos.flatMap(item => item.LocalAlternateVersions ?? [])
        .filter(Boolean).map(ordinalIgnoreCaseKey));
      const removed = [...currentById.values()].filter(item => !valid.has(idKey(item.Id))), replacedPrimaries = [];
      for (const item of removed) {
        if (item.CanDelete === false || item.IsRoot) continue;
        if (VIDEO_TYPES.has(item.Type)) {
          if (item.Path && alternatePaths.has(ordinalIgnoreCaseKey(item.Path))) continue;
          const oldPaths = new Set((item.LocalAlternateVersions ?? []).filter(Boolean).map(ordinalIgnoreCaseKey));
          if (item.PrimaryVersionId == null && !nonemptyId(item.OwnerId)
            && [...oldPaths].some(value => alternatePaths.has(value))) {
            const primary = validVideos.find(video => (video.LocalAlternateVersions ?? [])
              .some(value => value && oldPaths.has(ordinalIgnoreCaseKey(value))));
            if (primary) {
              replacedPrimaries.push([item, primary]); actuallyRemoved.set(idKey(item.Id), item);
              item.ParentId = EMPTY_ID;
              continue;
            }
          }
        }
        if (isFileProtocol(item)) {
          actuallyRemoved.set(idKey(item.Id), item); item.ParentId = EMPTY_ID;
          await this.library.deleteItem(item, { DeleteFileLocation: false }, parent, false);
        }
      }
      if (created.length) await this.library.createItems(created, parent, { signal });
      for (const [oldPrimary, newPrimary] of replacedPrimaries) {
        await this.#promoteVersion(newPrimary, signal);
        await this.linkedChildReferences.reroute(oldPrimary.Id, newPrimary.Id);
        await this.#transferVersions(oldPrimary, newPrimary, signal);
        oldPrimary.LocalAlternateVersions = []; oldPrimary.LinkedAlternateVersions = [];
        // DeleteItem consults persisted links even after these live arrays are
        // cleared. Its independent promotion/save may therefore fail here.
        await this.library.deleteItem(oldPrimary, { DeleteFileLocation: false }, parent, false);
      }
      for (const oldPrimary of removed) {
        if (actuallyRemoved.has(idKey(oldPrimary.Id)) || !VIDEO_TYPES.has(oldPrimary.Type)
          || nonemptyId(oldPrimary.OwnerId) || !oldPrimary.Path || !alternatePaths.has(ordinalIgnoreCaseKey(oldPrimary.Path))) continue;
        const newPrimary = validVideos.find(item => (item.LocalAlternateVersions ?? [])
          .some(value => value && ordinalIgnoreCaseKey(value) === ordinalIgnoreCaseKey(oldPrimary.Path)));
        if (!newPrimary) continue;
        await this.#promoteVersion(newPrimary, signal);
        // Transfer owned versions first so clearing the old arrays cannot
        // orphan-delete their rows from under the new primary.
        await this.#transferVersions(oldPrimary, newPrimary, signal);
        oldPrimary.LocalAlternateVersions = []; oldPrimary.LinkedAlternateVersions = [];
        setPrimaryVersion(oldPrimary, newPrimary.Id); oldPrimary.OwnerId = newPrimary.Id;
        await this.#updateVersion(oldPrimary, signal);
        await this.linkedChildReferences.reroute(oldPrimary.Id, newPrimary.Id);
      }
      await this.#reattachRemovedUserData(actuallyRemoved, valid, signal);
      progress(9);
      progress(10);
      throwIfAborted(signal);
      const container = ['Series', 'MusicAlbum'].includes(itemType(parent));
      const children = recursive || refreshChildMetadata && !container ? await this.#accessibleChildren(accessible) : null;
      if (recursive) await this.#validateSubFolders(children, {
        collectionType,
        signal,
        reportProgress: progress => {
          const value = 10 + progress * 0.4;
          this.#progress(reportProgress, value);
          this.refreshes.reportProgress(parent, value);
        }
      });
      if (refreshChildMetadata) {
        this.#progress(reportProgress, 50);
        if (recursive) this.refreshes.reportProgress(parent, 50);
        const progress = inner => {
          const value = 50 + inner * 0.5;
          this.#progress(reportProgress, value);
          if (recursive) this.refreshes.reportProgress(parent, value);
        };
        if (container) {
          await this.metadataScanner.refreshContainer(parent.Id, metadataRefreshOptions, { reportProgress: progress });
        } else {
          await this.metadataScanner.refreshAccessibleChildren(children, metadataRefreshOptions,
            { recursive, reportProgress: progress });
        }
      }
      return Object.freeze({ created: Object.freeze(created), resolved: resolution.claims });
    } finally {
      if (recursive) this.refreshes.reportCompleted(parent);
      releaseCachedFolderChildren(parent);
    }
  }
}
