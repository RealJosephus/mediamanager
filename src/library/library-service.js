import { postgresUserDataKeyMap, readUserDataRows } from '../sessions/user-data.js';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';
import { EventEmitter } from 'node:events';
import { getNewItemId } from '../core/identity.js';
import { loadLibrary, mapRecord, idKey, sameId, nonemptyId, guid, cleanValue, dateText, dateTicks, libraryError, unsupported, repositoryCleanName, repositoryTopParentId, repositoryValue, repositoryIdPresent, NAME_TYPES, VIDEO_TYPES, MIN_DATE, EMPTY_ID } from './records.js';
import { visibleItem, visibleLibrary } from './permissions.js';
import { collectionFoldersForItem, userRootFolders } from './collection-membership.js';
import { canDeleteItem } from './delete-permission.js';
import { parseQuery, resolveOfficialRatingRanges, binaryCompare } from './query.js';
import { dtoOptions, prefetchPostgresDtoRelations, projectItem, projectUserData, mediaSources } from './dto.js';
import { sortMediaSources } from './media-versions.js';
import { nativeContainsSubPath, nativePathWithin, sameNativePath } from './native-path.js';
import { nativeArtistIdentity, nativeGenreIdentity, nativeMusicGenreIdentity, nativeStudioIdentity, nativeUserSubviewIdentity } from './identity.js';
import { nativeDateFromUnixNanoseconds } from '../users/native.js';
import { newNativeItemEntity, isNativeItemEntity, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { BoundedItemCache } from './bounded-item-cache.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { queryPostgresInstantMix, queryPostgresInstantMixGenres } from './playback-items.js';
import { querySplashscreenImagePaths } from './splashscreen-image-query.js';
import { boxSetCollapsePlan } from './boxset-collapse.js';
import { prepareItemsController, itemsDispatch } from './items-dispatch.js';
import { boxSetDisplayOrder, isLegacyBoxSet } from './boxset-state.js';
import { collectionType, groupedMediaFolders, eligibleForGrouping } from './user-view-query.js';
import { UserViewService } from './user-view-service.js';
import { createVirtualPathExpander } from './options.js';
import { nextUpTopParentIds } from './next-up.js';
import { childCountSourceIds } from './child-counts.js';
import { postgresParentalRatingContext, preferredMetadataCountry } from './parental-rating.js';
import { resolveSeries } from './series-reference.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { createPresentationUniqueKey } from './presentation-key.js';
import { SimilarItemsManager } from './similar-items.js';
import { queryPostgresDtoChildCounts, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { loadPostgresItemGraph, loadPostgresNavigationRows, loadPostgresPageGraph, loadPostgresRowsByIds, queryPostgresFolderStats,
  countPostgresNullVideoTypeRows, queryPostgresAlbumSelectorIds, queryPostgresArtistSelectorId,
  queryPostgresArtistSelectorIds,
  queryPostgresLinkTypes, queryPostgresLinkedChildCounts } from './postgres-library-query.js';
import { NativeItemJsonError } from './native-item-data.js';
import { postgresUpcomingScope, queryPostgresSeriesSeasonPage, queryPostgresUpcomingEpisodePage } from './postgres-shows-query.js';
import { queryPostgresNextUpPage } from './postgres-next-up-query.js';
import { queryPostgresExternalViewPresence, queryPostgresUserViewChildPresence } from './postgres-user-views-query.js';
import { queryPostgresBuiltInSearch, resolvePostgresSearchCollation, releasePostgresSearchCollation } from './postgres-search-provider.js';
import { matchesPostgresUserViewGenre, queryPostgresUserViewGenrePage } from './postgres-user-view-genre-query.js';
import { queryPostgresSeriesEpisodePage } from './postgres-series-episodes-query.js';
import { filterPostgresSimilarAccessRows, hasPostgresVisibleArtistRelation, localGenreTagSimilarQuery, queryPostgresLocalSimilarRows,
  queryPostgresMovieSimilarRows,
  resolvePostgresRemoteSimilarRows } from './postgres-similar-items-query.js';
import { queryPostgresUserViewMenuPage } from './postgres-user-view-menu-query.js';
import { buildPostgresPlaylistVisibility, queryPostgresPlaylistAccess,
  queryPostgresPlaylistAccessBatch } from './postgres-playlist-query.js';

const resumeQueryKeys = new Set(['userid', 'startindex', 'limit', 'searchterm', 'parentid', 'fields', 'mediatypes',
  'enableuserdata', 'imagetypelimit', 'enableimagetypes', 'excludeitemtypes', 'includeitemtypes',
  'enabletotalrecordcount', 'enableimages']);

function versionFamilyKey(item) {
  return idKey(nonemptyId(item.PrimaryVersionId) ? item.PrimaryVersionId : item.Id);
}

function latestUserDataDate(rows, predicate = () => true) {
  let latest = null;
  let latestTicks = null;
  for (const row of rows) {
    if (!predicate(row) || row.LastPlayedDate == null) continue;
    const ticks = dateTicks(row.LastPlayedDate);
    if (latestTicks == null || ticks > latestTicks) {
      latest = dateText(row.LastPlayedDate);
      latestTicks = ticks;
    }
  }
  return latest;
}

function resolvedPhysicalFolderIds(folder, state) {
  const stored = folder.PhysicalFolderIds ?? [];
  if (stored.length) return stored;
  const locations = [...(folder.PhysicalLocations ?? []), ...(folder.PhysicalLocationsList ?? [])];
  const result = new Map();
  for (const location of locations) {
    const matches = state.items.filter(candidate => candidate.IsFolder && candidate.Type !== 'CollectionFolder'
      && sameNativePath(candidate.Path, location));
    const physical = matches.find(candidate => state.byId.get(idKey(candidate.ParentId))?.Type === 'AggregateFolder')
      ?? matches.find(candidate => sameId(candidate.Id, repositoryTopParentId(candidate)))
      ?? matches[0];
    if (physical) result.set(idKey(physical.Id), physical.Id);
  }
  return [...result.values()];
}

function queryTopParentIds(item, state, user, rootFolders, seen = new Set()) {
  if (!item || seen.has(idKey(item.Id))) return [];
  seen = new Set(seen).add(idKey(item.Id));
  if (item.Type === 'UserView') {
    if (collectionType(item) === 'livetv') return [item.Id];
    const displayId = nonemptyId(item.DisplayParentId) ? item.DisplayParentId : item.ParentId;
    if (nonemptyId(displayId)) return queryTopParentIds(state.byId.get(idKey(displayId)), state, user, rootFolders, seen);
    const type = collectionType(item);
    if (user && type !== 'unknown' && ['', 'movies', 'tvshows'].includes(type)
      && user.Configuration?.GroupedFolders?.length) {
      return groupedMediaFolders(rootFolders, user).filter(folder => !collectionType(folder) || collectionType(folder) === type)
        .flatMap(folder => queryTopParentIds(folder, state, user, rootFolders, seen));
    }
    return [];
  }
  if (item.Type === 'CollectionFolder') return resolvedPhysicalFolderIds(item, state);
  let top = item;
  while (true) {
    const parent = state.byId.get(idKey(top.ParentId));
    // BaseItem.GetTopParent searches the live ParentId chain for IsTopParent;
    // an orphan is not its own top parent and stored TopParentId/OwnerId do
    // not supply a replacement parent for this API.
    if (['BasePluginFolder', 'Channel'].includes(top.Type) || collectionType(top) === 'livetv'
      || parent?.Type === 'AggregateFolder') return [top.Id];
    if (!parent || seen.has(idKey(parent.Id))) break;
    seen.add(idKey(parent.Id));
    top = parent;
  }
  return [];
}

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const librarySource = item => item?.SourceType == null || item.SourceType === 0 || item.SourceType === 'Library';
const arrayValue = value => Array.isArray(value) ? value : [];
const physicalFolder = item => itemType(item) === 'Folder' && item?.NativeType === 'MediaBrowser.Controller.Entities.Folder'
  && item.IsFolder === true && !item.IsVirtualItem && !nonemptyId(item.OwnerId) && !nonemptyId(item.PrimaryVersionId)
  && librarySource(item) && typeof item.Path === 'string' && item.Path.length > 0
  && !/^[a-z][a-z\d+.-]*:\/\//iu.test(item.Path);

function requestedParent(query, state) {
  if (!Object.hasOwn(query, 'parentid')) return null;
  if (!nonemptyId(query.parentid)) throw libraryError(400, 'Error processing request.');
  const parent = state.byId.get(idKey(query.parentid));
  // LibraryManager.GetParentItem dispatches a supplied nullable Guid through
  // GetItemById even when it is Guid.Empty. Both Empty and a missing id surface
  // as an ArgumentException/HTTP 400 rather than selecting an implicit root.
  if (!parent) throw libraryError(400, 'Error processing request.');
  return parent;
}

function physicalFoldersForCollection(collection, items, byId) {
  const result = new Map();
  for (const value of arrayValue(collection.PhysicalFolderIds)) {
    const item = byId.get(idKey(value));
    if (physicalFolder(item)) result.set(idKey(item.Id), item);
  }
  for (const location of [...arrayValue(collection.PhysicalLocations), ...arrayValue(collection.PhysicalLocationsList)]) {
    const matches = items.filter(item => physicalFolder(item) && sameNativePath(item.Path, location));
    for (const item of matches) result.set(idKey(item.Id), item);
  }
  return [...result.values()];
}

function outermostPhysicalFolders(items) {
  const unique = [];
  for (const item of items.sort((left, right) => left.Path.localeCompare(right.Path, 'en')
    || idKey(left.Id).localeCompare(idKey(right.Id), 'en'))) {
    if (unique.some(candidate => sameNativePath(candidate.Path, item.Path))) {
      throw libraryError(500, 'Multiple physical library roots own the same native path.');
    }
    unique.push(item);
  }
  return unique.filter((item, index) => !unique.some((candidate, candidateIndex) => candidateIndex !== index
    && !sameNativePath(item.Path, candidate.Path) && nativePathWithin(item.Path, candidate.Path)));
}

export class LibraryService extends EventEmitter {
  #userViews;
  #stateScopes = new AsyncLocalStorage();
  #operations = new Set();
  #records;
  #recordOwners = new WeakMap();
  #closing = false;
  #closePromise;
  constructor({ fileSystem, store, linkedChildren, serverId, libraryOptions = {}, programDataPath, dataPath, metadataPath, configuration = {}, expandPath, userRoot, userRootPath, localization, externalUrlRegistry, musicBrainzServer, logger = {}, clock = () => new Date(), onError = () => {} }) {
    super();
    if (!store || !serverId) throw new TypeError('LibraryService requires store and serverId.');
    expandPath ??= programDataPath ? createVirtualPathExpander({ programDataPath, dataPath, metadataPath }) : undefined;
    Object.assign(this, { store, options: { fileSystem, linkedChildren, serverId, libraryOptions, programDataPath, dataPath, metadataPath, configuration, expandPath, userRoot, userRootPath, localization, externalUrlRegistry, musicBrainzServer, logger }, clock, onError });
    this.#records = new BoundedItemCache(configuration.CacheSize ?? availableParallelism() * 100,
      { onRemove: item => { this.#recordOwners.get(item)?.release(); this.#recordOwners.delete(item); } });
  }

  get userViews() { return this.#userViews ??= new UserViewService({ library: this }); }
  set userViews(value) { this.#userViews = value; }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#userViews?.dispose();
    this.#closing = true;
    return this.#closePromise = (async () => {
      while (this.#operations.size) await Promise.allSettled([...this.#operations]);
      try { await this.#userViews?.close(); }
      finally { this.#records.clear(); await this.options.linkedChildren?.flushReleases(); }
    })();
  }

  #rememberRecord(item) {
    if (!this.#recordOwners.has(item)) this.#recordOwners.set(item, acquireNativeItemLinkOwner(item));
    this.#records.set(idKey(item.Id), item);
    return item;
  }

  #runWithStates(operation, options) {
    if (this.#closing && !this.#stateScopes.getStore()?.active) return Promise.reject(libraryError(503, 'The library is closing.'));
    const scope={active:true,states:new Set()};
    const task = this.store.run(db => this.#stateScopes.run(scope, async () => {
      let primary;
      try { return await operation(db); }
      catch (error) { primary = error; throw error; }
      finally {
        try {
        const failures = [];
        for (const state of scope.states) try { await state.dispose({ session: db }); } catch (error) { failures.push(error); }
        try { await this.options.linkedChildren?.flushReleases({ session: db }); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(primary ? [primary,...failures] : failures,
          primary?.message ?? 'Library query state release failed.', primary ? { cause:primary } : undefined);
        } finally { scope.active=false; }
      }
    }), options);
    this.#operations.add(task);
    void task.finally(() => this.#operations.delete(task)).catch(() => {});
    return task;
  }

  async withItemRecord(id, options, operation) {
    if (typeof operation !== 'function') throw new TypeError('An item record consumer is required.');
    return this.#runWithStates(async () => {
      const item = await this.getItemRecord(id, options), owner = acquireNativeItemLinkOwner(item);
      try { return await operation(item); }
      finally { owner.release(); await this.options.linkedChildren?.flushReleases(); }
    });
  }

  #report(name, event) {
    try { this.emit(name, event); }
    catch (error) { try { this.onError(error); } catch { /* Library observers cannot break a committed write. */ } }
  }

  reportItemAdded(Item, Parent = null) { this.#report('ItemAdded', { Item, Parent }); }
  reportItemUpdated(Item, Parent = null, UpdateReason = 0) { this.#report('ItemUpdated', { Item, Parent, UpdateReason }); }
  reportItemRemoved(Item, Parent = null) { this.#report('ItemRemoved', { Item, Parent }); }

  createItems(items, parent, options) {
    if (!this.itemCreation) throw libraryError(501, 'Item creation requires mapped media storage and metadata.');
    return this.itemCreation.createItems(items, parent, options);
  }

  validateChildren(parent, options) {
    if (!this.folderValidation) throw libraryError(501, 'Folder validation requires mapped media storage and metadata.');
    return this.folderValidation.validateChildren(parent, options);
  }

  deleteItem(item, options, parent, notifyParentItem) {
    if (!this.itemDeletion) throw libraryError(501, 'Item deletion requires mapped media storage and metadata.');
    return this.itemDeletion.deleteItem(item, options, parent, notifyParentItem);
  }

  deleteQueryItemsUnsafeFast(query, options) {
    if (!this.unsafeItemDeletion) throw libraryError(501, 'Batch deletion requires the native entity lifecycle.');
    return this.unsafeItemDeletion.deleteQueryItems(query, options);
  }

  async getPhysicalScanRoots({ collectionId, signal } = {}) {
    return this.#runWithStates(async db => {
      const baseRows = await loadPostgresNavigationRows(db, collectionId);
      const items = baseRows.filter(row => row.Type !== 'PLACEHOLDER').map(row => mapRecord(row)).filter(Boolean);
      const byId = new Map(items.map(item => [idKey(item.Id), item]));
      const collections = items.filter(item => itemType(item) === 'CollectionFolder');
      let selectedCollections = collections;
      if (collectionId != null) {
        const collection = byId.get(idKey(collectionId));
        if (!collection || itemType(collection) !== 'CollectionFolder') throw libraryError(404, 'Collection folder not found.');
        selectedCollections = [collection];
      }

      const roots = new Map();
      if (collectionId == null) {
        for (const item of items) {
          if (physicalFolder(item) && itemType(byId.get(idKey(item.ParentId))) === 'AggregateFolder') {
            roots.set(idKey(item.Id), item);
          }
        }
      }
      for (const collection of selectedCollections) {
        for (const item of physicalFoldersForCollection(collection, items, byId)) roots.set(idKey(item.Id), item);
      }

      return outermostPhysicalFolders([...roots.values()])
        .sort((left, right) => left.Path.localeCompare(right.Path, 'en') || idKey(left.Id).localeCompare(idKey(right.Id), 'en'));
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
  }

  async load(db, user, { includeUserData = true, baseRows, includeManualLinks = false, includeFolderLinks = false, includeLinkGraph = true } = {}) {
    if (baseRows === undefined) throw new TypeError('LibraryService.load requires SQL-scoped baseRows.');
    if (!this.options.userRoot && this.options.programDataPath) {
      const rootPaths = /^[A-Za-z]:[\\/]|^\\\\/u.test(this.options.programDataPath) ? path.win32 : path.posix;
      const rootPath = this.options.userRootPath ?? rootPaths.join(this.options.programDataPath, 'root', 'default');
      const nativeType = 'MediaBrowser.Controller.Entities.UserRootFolder';
      const id = getNewItemId(rootPath, nativeType, { programDataPath: this.options.programDataPath, enableCaseSensitiveItemIds: this.options.configuration.EnableCaseSensitiveItemIds });
      // ManagedFileSystem leaves DirectoryInfo timestamps at MinValue, so
      // ResolverHelper uses the initialization time for this transient root.
      this.options.userRoot = { Id: guid(id).toUpperCase(), Type: nativeType, Name: rootPaths.basename(rootPath), Path: rootPath, ParentId: EMPTY_ID, IsFolder: true, IsRoot: true, IsLocked: /\[dontfetchmeta\]/i.test(rootPath), SourceType: 'Library', MediaType: 'Unknown', DateCreated: this.clock().toISOString(), DateModified: MIN_DATE, DateLastSaved: MIN_DATE, Data: '{}' };
    }
    const state = await loadLibrary(db, this.options, { baseRows, includeManualLinks, includeFolderLinks, includeLinkGraph });
    const scope = this.#stateScopes.getStore();
    if (scope?.active) {
      scope.states.add(state);
      const dispose = state.dispose.bind(state);
      state.dispose = async options => { try { await dispose(options); } finally { scope.states.delete(state); } };
    }
    try {
    state.now = dateText(this.clock().toISOString());
    state.visible = item => visibleItem(item, user, state, this.options);
    state.getChildCount = item => this.getDtoChildCount(item, state, user);
    state.newUserView = item => this.#userViews?.createdInThisInstance(item.Id) === true;
    const scopedIds = state.items
      .filter(item => item !== state.transientUserRoot).map(item => item.Id);
    const valueLinks = scopedIds.length ? await db.rows('ItemValuesMap', { whereIn: { ItemId: scopedIds } }) : [];
    const valueIds = [...new Set(valueLinks.map(link => link.ItemValueId))];
    const values = valueIds.length ? await db.rows('ItemValues', { whereIn: { ItemValueId: valueIds } }) : [];
    state.itemValues = values;
    state.itemValueLinks = valueLinks;
    state.valuesFor = (item, type) => valueLinks.filter(link => sameId(link.ItemId, item.Id)).map(link => values.find(value => sameId(value.ItemValueId, link.ItemValueId))).filter(value => value?.Type === type).map(value => value.CleanValue);
    const valuesById = new Map(values.map(value => [idKey(value.ItemValueId), value]));
    const minimumValuesByItem = new Map();
    for (const link of valueLinks) {
      const value = valuesById.get(idKey(link.ItemValueId));
      if (!value || ![0, 1, 3].includes(value.Type)) continue;
      const itemId = idKey(link.ItemId);
      if (!minimumValuesByItem.has(itemId)) minimumValuesByItem.set(itemId, new Map());
      const itemValues = minimumValuesByItem.get(itemId);
      if (!itemValues.has(value.Type) || binaryCompare(value.CleanValue, itemValues.get(value.Type)) < 0) {
        itemValues.set(value.Type, value.CleanValue);
      }
    }
    state.memoryContext = { byId: state.byId, ancestors: state.ancestors,
      seriesFor: item => resolveSeries(item, state.byId),
      defaultMetadataCountry: this.options.configuration.MetadataCountryCode,
      preferredMetadataCountryFor: item => preferredMetadataCountry(item, state, this.options) };
    const peopleLinks = scopedIds.length ? await db.rows('PeopleBaseItemMap', { whereIn: { ItemId: scopedIds } }) : [];
    const peopleIds = [...new Set(peopleLinks.map(link => link.PeopleId))];
    const people = peopleIds.length ? await db.rows('Peoples', { whereIn: { Id: peopleIds } }) : [];
    state.people = people;
    state.peopleLinks = peopleLinks;
    const peopleLinksByItem = new Map(state.items.map(item => [idKey(item.Id), []]));
    for (const link of peopleLinks) {
      const key = idKey(link.ItemId);
      if (!peopleLinksByItem.has(key)) peopleLinksByItem.set(key, []);
      peopleLinksByItem.get(key).push(link);
    }
    state.dtoRelations.peopleLinksByItem = peopleLinksByItem;
    state.dtoRelations.peopleById = new Map(people.map(person => [idKey(person.Id), person]));
    state.relatedItems = nameItem => {
      const ids = new Set();
      if (nameItem.Type === 'Person') {
        for (const person of people.filter(person => person.Name === nameItem.Name)) for (const link of peopleLinks.filter(link => sameId(link.PeopleId, person.Id))) ids.add(idKey(link.ItemId));
      } else {
        const types = { Genre: [2], MusicGenre: [2], MusicArtist: [0, 1], Studio: [3] }[nameItem.Type] ?? [];
        for (const value of values.filter(value => types.includes(value.Type) && value.CleanValue === repositoryCleanName(nameItem))) for (const link of valueLinks.filter(link => sameId(link.ItemValueId, value.ItemValueId))) ids.add(idKey(link.ItemId));
      }
      return [...ids].map(id => state.byId.get(id)).filter(Boolean);
    };
    state.userData = new Map();
    const loadUserData = Boolean(user && includeUserData);
    state.userDataRows = loadUserData ? state.repositoryUserDataRows.filter(row => sameId(row.UserId, user.Id)) : [];
    const userDataRowsByItem = new Map();
    for (const row of state.userDataRows) {
      const key = idKey(row.ItemId);
      if (!userDataRowsByItem.has(key)) userDataRowsByItem.set(key, []);
      userDataRowsByItem.get(key).push(row);
    }
    state.rowsFor = item => userDataRowsByItem.get(idKey(item.Id)) ?? [];
    const orderRowsByItem = loadUserData ? userDataRowsByItem : new Map();
    const addOrderRows = rows => { for (const row of rows) {
      const key = idKey(row.ItemId);
      if (!orderRowsByItem.has(key)) orderRowsByItem.set(key, []);
      orderRowsByItem.get(key).push(row);
    } };
    state.orderRowsFor = item => orderRowsByItem.get(idKey(item.Id)) ?? [];
    let seriesPlayedDates = null;
    const rebuildSeriesPlayedDates = () => {
      seriesPlayedDates = new Map();
      for (const member of state.items) {
        const date = latestUserDataDate(state.orderRowsFor(member), row => row.Played);
        if (date == null) continue;
        const key = member.SeriesPresentationUniqueKey ?? null;
        const previous = seriesPlayedDates.get(key);
        if (previous == null || dateTicks(date) > dateTicks(previous)) {
          seriesPlayedDates.set(key, date);
        }
      }
    };
    state.repositorySortValue = (item, column, query) => {
      if (column === 'SeriesDatePlayed') {
        if (seriesPlayedDates === null) rebuildSeriesPlayedDates();
        const hasSearch = query?.searchterm != null && query.searchterm !== '';
        if (!hasSearch && item.PresentationUniqueKey == null) return null;
        return seriesPlayedDates.get(item.PresentationUniqueKey ?? null) ?? null;
      }
      const type = { Artist: 0, AlbumArtist: 1, Studio: 3 }[column];
      if (type === undefined) throw libraryError(501, `Unsupported repository sort value: ${column}`);
      return minimumValuesByItem.get(idKey(item.Id))?.get(type) ?? null;
    };
    if (loadUserData) for (const item of state.items) {
      let keyedItem = item;
      if (['Episode', 'Season'].includes(item.Type)) {
        keyedItem = { ...item, Series: resolveSeries(item, state.byId) };
      }
      state.userData.set(idKey(item.Id), await readUserDataRows(db, keyedItem, state.rowsFor(item)));
    }
    state.alternatesByPrimary = new Map();
    state.foldersByPresentationKey = new Map();
    state.linkedChildrenByParent = new Map();
    for (const item of state.items) {
      if (repositoryIdPresent(item, 'PrimaryVersionId')) {
        const key = idKey(repositoryValue(item, 'PrimaryVersionId'));
        if (!state.alternatesByPrimary.has(key)) state.alternatesByPrimary.set(key, []);
        state.alternatesByPrimary.get(key).push(item);
      }
      if (item.IsFolder && item.PresentationUniqueKey) {
        if (!state.foldersByPresentationKey.has(item.PresentationUniqueKey)) state.foldersByPresentationKey.set(item.PresentationUniqueKey, []);
        state.foldersByPresentationKey.get(item.PresentationUniqueKey).push(item);
      }
    }
    for (const link of state.links) {
      const key = idKey(link.ParentId);
      if (!state.linkedChildrenByParent.has(key)) state.linkedChildrenByParent.set(key, []);
      const child = state.byId.get(idKey(link.ChildId));
      if (child) state.linkedChildrenByParent.get(key).push(child);
    }
    const descendantCandidateCache = new Map();
    const descendantCandidates = folder => {
      const key = idKey(folder.Id);
      if (descendantCandidateCache.has(key)) return descendantCandidateCache.get(key);
      const candidates = new Map(state.descendants(folder).map(item => [idKey(item.Id), item]));
      for (const child of state.linkedChildrenByParent.get(key) ?? []) {
        candidates.set(idKey(child.Id), child);
        if (child.IsFolder) for (const item of state.descendants(child)) candidates.set(idKey(item.Id), item);
      }
      const result = [...candidates.values()];
      descendantCandidateCache.set(key, result);
      return result;
    };
    const countableLeafCache = new Map();
    state.countableLeaves = (folder, { includeOwnedItems = false, mergePresentationKey = false } = {}) => {
      const cacheKey = `${idKey(folder.Id)}:${includeOwnedItems ? 'all' : 'default'}:${mergePresentationKey ? 'merged' : 'single'}`;
      if (countableLeafCache.has(cacheKey)) return countableLeafCache.get(cacheKey);
      const members = mergePresentationKey && folder.PresentationUniqueKey
        ? state.foldersByPresentationKey.get(folder.PresentationUniqueKey) ?? [folder]
        : [folder];
      const candidates = new Map();
      for (const member of members) for (const item of descendantCandidates(member)) candidates.set(idKey(item.Id), item);
      const leaves = [...candidates.values()].filter(item => {
        if (item.IsFolder || item.IsVirtualItem || !state.visible(item)) return false;
        if (includeOwnedItems) return true;
        if (nonemptyId(item.OwnerId) && item.ExtraType == null) return false;
        if (nonemptyId(item.PrimaryVersionId)) {
          const primary = state.byId.get(idKey(item.PrimaryVersionId));
          if (primary && sameId(repositoryTopParentId(primary), repositoryTopParentId(item))) return false;
        }
        return true;
      });
      countableLeafCache.set(cacheKey, leaves);
      return leaves;
    };
    const playedVersionFamilies = new Set(state.items
      .filter(item => state.rowsFor(item).some(row => row.Played))
      .map(versionFamilyKey));
    state.leafIsPlayed = item => playedVersionFamilies.has(versionFamilyKey(item));
    state.isPlayed = item => item.IsFolder ? state.countableLeaves(item).every(state.leafIsPlayed) : state.leafIsPlayed(item);

    const resumeWinnerBuckets = new Map();
    for (const item of state.items) {
      const rows = state.rowsFor(item);
      if (!rows.some(row => row.PlaybackPositionTicks > 0n)) continue;
      const family = versionFamilyKey(item);
      const lastPlayedDate = latestUserDataDate(rows, row => row.PlaybackPositionTicks > 0n);
      if (!resumeWinnerBuckets.has(family)) resumeWinnerBuckets.set(family, new Map());
      const bucket = lastPlayedDate == null ? 'undated' : 'dated';
      const winners = resumeWinnerBuckets.get(family), previous = winners.get(bucket);
      const played = lastPlayedDate == null ? null : dateTicks(lastPlayedDate);
      const previousPlayed = previous?.lastPlayedDate == null ? null : dateTicks(previous.lastPlayedDate);
      if (!previous || played != null && played > previousPlayed
        || played === previousPlayed && idKey(item.Id) < idKey(previous.item.Id)) {
        winners.set(bucket, { item, lastPlayedDate });
      }
    }
    state.resumeWinnerIds = new Map([...resumeWinnerBuckets].map(([family, buckets]) =>
      [family, new Set([...buckets.values()].map(entry => idKey(entry.item.Id)))]));
    state.isResumable = item => {
      if (!item.IsFolder) return state.resumeWinnerIds.get(versionFamilyKey(item))?.has(idKey(item.Id)) ?? false;
      if (!['Series', 'Season'].includes(item.Type)) return false;
      if (state.countableLeaves(item, { includeOwnedItems: true })
        .some(leaf => state.rowsFor(leaf).some(row => row.PlaybackPositionTicks > 0n))) return true;
      return new Set(state.countableLeaves(item).map(state.leafIsPlayed)).size > 1;
    };

    // Native DatePlayed ordering aggregates every user-data key and the direct
    // alternate versions of a primary. DTO projection still uses readUserData's
    // preferred key, so sorting cannot change the UserData object clients see.
    const rebuildOrderUserData = () => {
      state.orderUserData = new Map(state.userData);
      for (const item of state.items) {
        const rows = [...state.orderRowsFor(item)];
        if (!nonemptyId(item.PrimaryVersionId)) {
          for (const alternate of state.alternatesByPrimary.get(idKey(item.Id)) ?? []) rows.push(...state.orderRowsFor(alternate));
        }
        state.orderUserData.set(idKey(item.Id), {
          ...state.orderUserData.get(idKey(item.Id)),
          LastPlayedDate: latestUserDataDate(rows),
        });
      }
    };
    if (loadUserData) rebuildOrderUserData();
    else state.orderUserData = state.userData;
    let allUserDataLoad = null;
    state.ensureAllUserDataForOrdering = () => {
      if (user) return Promise.resolve();
      allUserDataLoad ??= Promise.resolve(state.repositoryUserDataRows).then(rows => {
        addOrderRows(rows);
        rebuildOrderUserData();
        seriesPlayedDates = null;
      });
      return allUserDataLoad;
    };
    return state;
    } catch(error) { await state.dispose({session:db}); throw error; }
  }

  async #loadPostgresItemState(db, ids, user, { includeUserData = true } = {}) {
    const graphRows = await loadPostgresItemGraph(db, ids);
    const requestedIds = new Set(ids.map(idKey));
    const itemRows = graphRows.filter(row => requestedIds.has(idKey(row.Id)));
    const state = await this.load(db, user, { includeUserData, baseRows: graphRows });
    if (user) {
      state.folderStats = await queryPostgresFolderStats(db,
        itemRows.filter(row => row.IsFolder === true).map(row => row.Id), user.Id);
    }
    return state;
  }

  #postgresPhysicalIds(folders, state) {
    return [...new Map(folders.flatMap(folder => folder.Type === 'CollectionFolder'
      ? resolvedPhysicalFolderIds(folder, state) : [repositoryTopParentId(folder) ?? folder.Id])
      .filter(nonemptyId).map(id => [idKey(id), id])).values()];
  }

  #postgresVisibility(state, user) {
    if (!user) return undefined;
    const policy = user.Policy;
    const libraryFolders = state.items.filter(item => item.Type === 'CollectionFolder');
    const allowedLibraries = state.items
      .filter(item => item.Type === 'CollectionFolder' && visibleLibrary(item, user, this.options.libraryOptions));
    const libraryTopParentIds = [...new Map([...this.#postgresPhysicalIds(libraryFolders, state),
      ...libraryFolders.map(item => item.Id)].map(id => [idKey(id), id])).values()];
    const topParentIds = [...new Map([...this.#postgresPhysicalIds(allowedLibraries, state),
      ...allowedLibraries.map(item => item.Id)].map(id => [idKey(id), id])).values()];
    const maxRating = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating;
    const maxSubRating = user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore ?? policy.MaxParentalSubRating;
    return {
      ...(libraryFolders.length ? { topParentIds, libraryTopParentIds } : {}),
      blockedTags: policy.BlockedTags ?? [],
      allowedTags: policy.AllowedTags ?? [],
      maxRating,
      maxSubRating,
      ratingContext: postgresParentalRatingContext(state, this.options),
      blockUnratedTypes: policy.BlockUnratedItems ?? [],
    };
  }

  async #postgresStandaloneVisible(db, item, user, state, { checkStandaloneParents = true } = {}) {
    if (!item) return false;
    if (!user) return true;
    if (item.Type === 'Playlist') {
      const dataPath = this.options.dataPath
        ?? (this.options.programDataPath && path.join(this.options.programDataPath, 'data'));
      const managed = item.Path && dataPath && nativeContainsSubPath(item.Path, dataPath);
      if (!managed && !visibleItem(item, user, state, {
        ...this.options,
        query: false,
        checkStandaloneParents,
        playlistVisibilityChecked: true,
      })) return false;
      return queryPostgresPlaylistAccess(db, item, {
        user,
        dataPath,
        programDataPath: this.options.programDataPath,
        visibility: buildPostgresPlaylistVisibility(state.items, user, this.options.libraryOptions),
      });
    }
    if (item.Type !== 'BoxSet') {
      return visibleItem(item, user, state, { ...this.options, query: false, checkStandaloneParents });
    }
    const linked = await db.rows('LinkedChildren', {
      where: { ParentId: item.Id },
      columns: ['ParentId'],
      limit: 1,
    });
    if (isLegacyBoxSet(item, linked.length > 0, this.options.programDataPath)) {
      return visibleItem(item, user, state, { ...this.options, query: false, checkStandaloneParents });
    }
    const visibility = this.#postgresVisibility(state, user);
    const page = await queryPostgresItemPage(db, { ids: [item.Id], limit: 1 }, {
      userId: user.Id,
      visibility: {
        ...visibility,
        boxSetStandalone: true,
        boxSetChildRatingMode: 'both',
        boxSetUnknownMembershipBypass: true,
      },
    });
    return page.total === 1;
  }

  async #postgresChildCountRequest(item, state, user) {
    const sources = childCountSourceIds(item, state, user, { ...this.options,
      rootChildren: (current, reader) => this.rootChildren(current, reader) });
    if (item.Type === 'UserView' && collectionType(item) === 'folders') {
      return { count: this.rootChildren(state, user).length };
    }
    if (item.Type === 'UserView' && ['movies', 'tvshows'].includes(collectionType(item))
      && Array.isArray(sources) && !sources.length) {
      return { count: (await this.userViews.menu(collectionType(item), item, state.db, state)).length };
    }
    const displayParent = item.Type === 'UserView' && sources == null
      ? state.byId.get(idKey(nonemptyId(item.DisplayParentId) ? item.DisplayParentId : item.ParentId))
      : null;
    const displaySources = displayParent?.Type === 'CollectionFolder'
      ? resolvedPhysicalFolderIds(displayParent, state)
      : displayParent?.IsFolder ? [displayParent.Id] : [];
    return {
      key: idKey(item.Id),
      parentIds: sources?.length ? sources : displaySources.length ? displaySources : [item.Id],
      linkEligible: !Array.isArray(sources) || sources.length > 0
        || item.Type === 'CollectionFolder' && user != null,
    };
  }

  async #prefetchPostgresDtos(items, state, user, selected) {
    await prefetchPostgresDtoRelations(items, state, user, selected, this.options);
    if (!user) return;
    const implicitCountItems = items.filter(item => item.IsFolder
      && ['MusicAlbum', 'Season', 'Playlist'].includes(item.Type)
      && (item.SourceType == null || item.SourceType === 'Library' || item.SourceType === 0));
    if (implicitCountItems.length) state.dtoLinkedChildCounts = await queryPostgresLinkedChildCounts(state.db,
      implicitCountItems.map(item => item.Id));
    if (!selected.fields.has('childcount')) return;
    const cached = new Map();
    const requests = [];
    for (const item of items) {
      if (!item.IsFolder) continue;
      const request = await this.#postgresChildCountRequest(item, state, user);
      if (Object.hasOwn(request, 'count')) cached.set(idKey(item.Id), request.count);
      else requests.push(request);
    }
    if (requests.length) {
      const hideMissing = !(user.DisplayMissingEpisodes ?? user.Configuration?.DisplayMissingEpisodes);
      const { topParentIds: _ignoredTopParents, ...visibility } = this.#postgresVisibility(state, user) ?? {};
      const counts = await queryPostgresDtoChildCounts(state.db, requests,
        hideMissing ? { ismissing: false } : {}, {
          userId: user.Id,
          visibility,
        });
      for (const [key, count] of counts) cached.set(key, count);
    }
    state.dtoChildCounts = cached;
  }

  async #filterPostgresStandalonePage(db, items, user, state, {
    skipRelatedNameCheck = false,
  } = {}) {
    if (!user || !items.length) return items;
    const boxSetIds = items.filter(item => item.Type === 'BoxSet').map(item => item.Id);
    const linkTypes = boxSetIds.length ? await queryPostgresLinkTypes(db, boxSetIds) : new Map();
    const modernBoxSets = new Set(items.filter(item => item.Type === 'BoxSet'
      && !isLegacyBoxSet(item, linkTypes.has(idKey(item.Id)), this.options.programDataPath))
      .map(item => idKey(item.Id)));
    const ordinary = items.filter(item => !modernBoxSets.has(idKey(item.Id)));
    const baseVisibility = this.#postgresVisibility(state, user) ?? {};
    const queryVisibleIds = async (candidates, visibility, nameAccessTypes = []) => {
      if (!candidates.length) return [];
      const page = await queryPostgresItemPage(db, { ids: candidates.map(item => item.Id) }, {
        scope: { ids: candidates.map(item => item.Id) },
        userId: user.Id,
        includeOwnedItems: true,
        includeAlternateVersions: true,
        resumableMode: 'memory',
        nameAccessTypes,
        requireRelatedNameAccess: nameAccessTypes.length > 0,
        memorySortConfiguration: this.options.configuration,
        memoryRatingContext: postgresParentalRatingContext(state, this.options),
        visibility,
      });
      return page.rows.map(row => idKey(row.Id));
    };
    const relatedNameTypes = skipRelatedNameCheck ? [] : [...NAME_TYPES];
    const visible = new Set(await queryVisibleIds(ordinary, {
      ...baseVisibility,
      itemMode: 'standalone',
      scopeTopParentAccess: false,
    }, relatedNameTypes));
    const modern = items.filter(item => modernBoxSets.has(idKey(item.Id)));
    for (const key of await queryVisibleIds(modern, {
      ...baseVisibility,
      itemMode: 'standalone',
      boxSetStandalone: true,
      boxSetChildRatingMode: 'both',
      boxSetUnknownMembershipBypass: true,
    })) visible.add(key);

    const playlistVisibility = buildPostgresPlaylistVisibility(state.items, user,
      this.options.libraryOptions);
    const visiblePlaylists = ordinary.filter(item => item.Type === 'Playlist'
      && visible.has(idKey(item.Id)));
    if (visiblePlaylists.length) {
      const playlistAccess = await queryPostgresPlaylistAccessBatch(db, visiblePlaylists, {
        user,
        dataPath: this.options.dataPath,
        programDataPath: this.options.programDataPath,
        visibility: playlistVisibility,
      });
      for (const item of visiblePlaylists) {
        if (playlistAccess.get(idKey(item.Id)) !== true) visible.delete(idKey(item.Id));
      }
    }
    return items.filter(item => visible.has(idKey(item.Id)));
  }

  async #filterPostgresStandaloneBatch(db, items, user, state) {
    if (!user || !items.length) return items;
    const boxSets = items.filter(item => item.Type === 'BoxSet');
    const linkTypes = boxSets.length
      ? await queryPostgresLinkTypes(db, boxSets.map(item => item.Id)) : new Map();
    const modernBoxSets = boxSets.filter(item => !isLegacyBoxSet(item,
      linkTypes.has(idKey(item.Id)), this.options.programDataPath));
    const modernKeys = new Set(modernBoxSets.map(item => idKey(item.Id)));
    const visible = new Set();
    const playlists = [];
    const dataPath = this.options.dataPath
      ?? (this.options.programDataPath && path.join(this.options.programDataPath, 'data'));
    for (const item of items) {
      if (modernKeys.has(idKey(item.Id))) continue;
      if (item.Type === 'Playlist') {
        const managed = item.Path && dataPath && nativeContainsSubPath(item.Path, dataPath);
        if (managed || visibleItem(item, user, state, {
          ...this.options,
          query: false,
          checkStandaloneParents: true,
          playlistVisibilityChecked: true,
        })) playlists.push(item);
      } else if (visibleItem(item, user, state, {
        ...this.options,
        query: false,
        checkStandaloneParents: true,
      })) visible.add(idKey(item.Id));
    }
    if (modernBoxSets.length) {
      const page = await queryPostgresItemPage(db, { ids: modernBoxSets.map(item => item.Id) }, {
        userId: user.Id,
        visibility: {
          ...this.#postgresVisibility(state, user),
          boxSetStandalone: true,
          boxSetChildRatingMode: 'both',
          boxSetUnknownMembershipBypass: true,
        },
      });
      for (const row of page.rows) visible.add(idKey(row.Id));
    }
    if (playlists.length) {
      const access = await queryPostgresPlaylistAccessBatch(db, playlists, {
        user,
        dataPath,
        programDataPath: this.options.programDataPath,
        visibility: buildPostgresPlaylistVisibility(state.items, user, this.options.libraryOptions),
      });
      for (const item of playlists) if (access.get(idKey(item.Id)) === true) visible.add(idKey(item.Id));
    }
    return items.filter(item => visible.has(idKey(item.Id)));
  }

  async queryItems(input = {}, { user = null, isApiKey = false, fromUserViewChildren = false } = {}) {
    return this.#queryItems(input, { user, isApiKey, fromUserViewChildren }, true);
  }

  async queryUpcomingEpisodes(input = {}, { user = null } = {}) {
    const minimum = new Date(this.clock());
    minimum.setUTCHours(0, 0, 0, 0);
    minimum.setUTCDate(minimum.getUTCDate() - 1);
    return this.#runWithStates(async db => {
      const requestedParentId = nonemptyId(input.parentid) ? guid(input.parentid) : input.parentid;
      const navigationRows = await loadPostgresNavigationRows(db, requestedParentId);
      const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationRows });
      const parent = nonemptyId(requestedParentId) ? navigation.byId.get(idKey(requestedParentId)) : null;
      const rootFolders = user ? this.rootChildren(navigation, user) : [];
      const scope = postgresUpcomingScope({
        parentId: requestedParentId,
        parent,
        state: navigation,
        user,
        rootFolders,
        physicalIdsFor: folder => resolvedPhysicalFolderIds(folder, navigation),
      });
      let visibility = this.#postgresVisibility(navigation, user);
      if (visibility && nonemptyId(requestedParentId)) {
        const { topParentIds: _repositoryScope, ...explicitVisibility } = visibility;
        visibility = explicitVisibility;
      }
      const startIndex = input.startindex ?? 0;
      const page = await queryPostgresUpcomingEpisodePage(db, {
        scope,
        userId: user?.Id,
        visibility,
        // Native dates are stored as sortable text. The cutoff is always a
        // UTC midnight, so use the repository's space-separated floor form.
        minimumPremiereDate: minimum.toISOString().slice(0, 19).replace('T', ' '),
        startIndex,
        limit: input.limit,
        groupByPresentationKey: Boolean(user),
      });
      const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
      const state = await this.load(db, user, { baseRows: graphRows });
      const options = dtoOptions(input);
      if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
      const projectionItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
      await this.#prefetchPostgresDtos(projectionItems, state, user, options);
      const dtos = [];
      for (const item of projectionItems) dtos.push(await projectItem(item, state, user, options, this.options));
      return { Items: dtos, TotalRecordCount: dtos.length, StartIndex: startIndex };
    });
  }

  async queryNextUpEpisodes(input = {}, { user } = {}) {
    return this.#runWithStates(db => this.#queryNextUpEpisodesPostgres(db, input, user));
  }

  async #queryNextUpEpisodesPostgres(db, input, user) {
    if (!user) throw libraryError(400, 'Error processing request.');
    if (input.parentId !== undefined && sameId(input.parentId, EMPTY_ID)) {
      throw libraryError(400, "Guid can't be empty (Parameter 'id')");
    }

    const navigationRows = await loadPostgresNavigationRows(db);
    const requestedRows = await loadPostgresRowsByIds(db, [input.seriesId, input.parentId].filter(nonemptyId));
    const navigationGraph = await loadPostgresPageGraph(db, requestedRows, navigationRows);
    const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationGraph });
    const series = nonemptyId(input.seriesId) ? navigation.byId.get(idKey(input.seriesId)) : null;
    const seriesKey = series?.Type === 'Series'
      ? series.PresentationUniqueKey ?? createPresentationUniqueKey(series,
        { libraryOptions: this.options.libraryOptions })
      : null;

    let parents = [];
    if (!seriesKey) {
      if (input.parentId !== undefined) {
        const parent = navigation.byId.get(idKey(input.parentId));
        parents = parent ? [parent] : [];
      } else {
        const excluded = user.Configuration?.LatestItemsExcludes ?? [];
        parents = this.rootChildren(navigation, user)
          .filter(item => item.IsFolder && !excluded.some(id => sameId(id, item.Id)));
      }
    }

    const topParentIds = seriesKey ? [] : [...nextUpTopParentIds(parents, navigation,
      folder => resolvedPhysicalFolderIds(folder, navigation), user, this.options)];
    const { topParentIds: _topParentIds, libraryTopParentIds: _libraryTopParentIds,
      ...visibility } = this.#postgresVisibility(navigation, user) ?? {};
    const page = await queryPostgresNextUpPage(db, {
      ...(seriesKey ? { seriesKeys: [seriesKey] } : { seriesDiscovery: {
        topParentIds,
        nextUpDateCutoff: input.nextUpDateCutoff ?? MIN_DATE,
        limit: series?.Type === 'Series' ? 11 : undefined,
      } }),
      userId: user.Id,
      // Key discovery already applies the parent/library scope. Native's
      // episode batch deliberately permits another copy of that series key in
      // a different library, while retaining tag/rating visibility checks.
      visibility,
      displaySpecialsWithinSeasons: this.options.configuration.DisplaySpecialsWithinSeasons === true,
      enableRewatching: input.enableRewatching === true,
      enableResumable: input.enableResumable !== false,
      enableUserData: input.enableuserdata !== false,
      startIndex: input.startIndex ?? 0,
      limit: input.limit,
      enableTotalRecordCount: input.enableTotalRecordCount !== false,
    });
    const graphRows = await loadPostgresPageGraph(db, page.rows, navigationGraph);
    const state = await this.load(db, user, { baseRows: graphRows, includeManualLinks: false });
    const streamIds = state.items.filter(item => VIDEO_TYPES.has(item.Type)).map(item => item.Id);
    state.mediaStreams = streamIds.length
      ? await db.rows('MediaStreamInfos', { whereIn: { ItemId: streamIds } }) : [];
    const options = dtoOptions(input);
    if (user.Policy.AllowedTags?.length) options.fields.add('tags');
    const projectionItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
    await this.#prefetchPostgresDtos(projectionItems, state, user, options);
    const items = [];
    for (const item of projectionItems) items.push(await projectItem(item, state, user, options, this.options));
    return { Items: items, TotalRecordCount: page.total, StartIndex: input.startIndex ?? 0 };
  }

  async querySeriesEpisodes(input = {}, { user = null, isApiKey = false } = {}) {
    return this.#runWithStates(async db => {
      const requestedId = input.seasonId ?? input.seriesId;
      const requestedRows = await loadPostgresRowsByIds(db, [requestedId]);
      const navigationRows = await loadPostgresNavigationRows(db, requestedId);
      const targetGraph = await loadPostgresPageGraph(db, requestedRows, navigationRows);
      const navigation = await this.load(db, user, { includeUserData: false, baseRows: targetGraph });
      const target = navigation.byId.get(idKey(requestedId));
      let series;
      let mode;
      if (input.seasonId) {
        if (!target || target.Type !== 'Season' || user && !visibleItem(target, user, navigation,
          { ...this.options, query: false })) {
          throw Object.assign(libraryError(404, `No season exists with Id ${guid(input.seasonId)}`),
            { showsNotFound: true });
        }
        series = resolveSeries(target, navigation.byId);
        mode = 'season';
      } else {
        if (!target || target.Type !== 'Series' || user && !visibleItem(target, user, navigation,
          { ...this.options, query: false })) {
          throw Object.assign(libraryError(404, 'Series not found'), { showsNotFound: true });
        }
        series = target;
        mode = input.season === undefined ? 'series' : 'number';
      }

      // Season.GetEpisodes short-circuits channel series before issuing its
      // repository query. Series.GetEpisodes supplies a preloaded episode list.
      if (mode !== 'series' && (!series || series.SourceType === 'Channel' || series.SourceType === 1)) {
        return { Items: [], TotalRecordCount: 0, StartIndex: input.startIndex ?? 0 };
      }
      const seriesKey = series?.PresentationUniqueKey ?? (series
        ? createPresentationUniqueKey(series, { libraryOptions: this.options.libraryOptions }) : null);
      let visibility = this.#postgresVisibility(navigation, user);
      if (visibility) {
        const { topParentIds: _repositoryScope, ...explicitVisibility } = visibility;
        visibility = explicitVisibility;
      }
      const includeMissing = Boolean(isApiKey
        || (user?.DisplayMissingEpisodes ?? user?.Configuration?.DisplayMissingEpisodes));
      const page = await queryPostgresSeriesEpisodePage(db, {
        mode,
        seriesKey,
        seasonId: target?.Id,
        seasonNumber: input.season,
        includeMissing,
        includeSpecials: this.options.configuration.DisplaySpecialsWithinSeasons ?? true,
        groupByPresentationKey: Boolean(user),
        isMissing: input.isMissing,
        startItemId: input.startItemId,
        adjacentTo: input.adjacentTo,
        random: String(input.sortBy ?? '').toLowerCase() === 'random',
        startIndex: input.startIndex,
        limit: input.limit,
        visibility,
      });
      const graphRows = await loadPostgresPageGraph(db, page.rows, targetGraph);
      const state = await this.load(db, user, { baseRows: graphRows });
      const options = dtoOptions(input);
      if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
      const projectionItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
      await this.#prefetchPostgresDtos(projectionItems, state, user, options);
      const items = [];
      for (const episode of projectionItems) items.push(await projectItem(episode, state, user, options, this.options));
      return { Items: items, TotalRecordCount: page.total, StartIndex: input.startIndex ?? 0 };
    });
  }

  async querySeriesSeasons(input = {}, { user = null, beforeProjection = null } = {}) {
    return this.#runWithStates(async db => {
      if (sameId(input.seriesId, EMPTY_ID)) throw libraryError(400, "Guid can't be empty (Parameter 'id')");
      const seriesId = guid(input.seriesId);
      const navigationRows = await loadPostgresNavigationRows(db, seriesId);
      const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationRows });
      const target = navigation.byId.get(idKey(seriesId));
      if (!target || target.Type !== 'Series' || user && !visibleItem(target, user, navigation,
        { ...this.options, query: false })) {
        throw Object.assign(libraryError(404, 'Series not found'), { showsNotFound: true });
      }
      const seriesKey = target.PresentationUniqueKey ?? createPresentationUniqueKey(target,
        { libraryOptions: this.options.libraryOptions });
      let isMissing = input.isMissing;
      if (user && !(user.DisplayMissingEpisodes ?? user.Configuration?.DisplayMissingEpisodes)) isMissing = false;
      let visibility = this.#postgresVisibility(navigation, user);
      if (visibility) {
        const { topParentIds: _repositoryScope, ...explicitVisibility } = visibility;
        visibility = explicitVisibility;
      }
      const page = await queryPostgresSeriesSeasonPage(db, {
        seriesKey,
        isSpecialSeason: input.isSpecialSeason,
        isMissing,
        adjacentTo: input.adjacentTo,
        userId: user?.Id,
        visibility,
        groupByPresentationKey: Boolean(user),
      });
      const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
      const state = await this.load(db, user, { baseRows: graphRows });
      state.folderStats = await queryPostgresFolderStats(db, page.rows.map(row => row.Id), user?.Id);
      beforeProjection?.();
      const options = dtoOptions(input);
      if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
      const projectionItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
      await this.#prefetchPostgresDtos(projectionItems, state, user, options);
      const items = [];
      for (const season of projectionItems) items.push(await projectItem(season, state, user, options, this.options));
      return { Items: items, TotalRecordCount: page.total, StartIndex: 0 };
    });
  }

  async querySimilarItems(input = {}, { user = null, beforeProjection = null, signal } = {}) {
    return this.#runWithStates(db => this.#querySimilarItemsPostgres(
      db, input, { user, beforeProjection, signal }));
  }
  async #querySimilarItemsPostgres(db, input, { user, beforeProjection, signal }) {
    const navigationRows = await loadPostgresNavigationRows(db,
      sameId(input.itemId, EMPTY_ID) ? undefined : input.itemId);
    const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationRows });
    let source;
    if (sameId(input.itemId, EMPTY_ID)) {
      source = navigation.items.find(item => item.Type === (user ? 'UserRootFolder' : 'AggregateFolder'));
    } else {
      source = navigation.byId.get(idKey(input.itemId));
      if (source && user) {
        const policy = user.Policy;
        const maxRating = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore
          ?? policy.MaxParentalRating;
        const requiresRelatedArtist = source.Type === 'MusicArtist' && (policy.EnableAllFolders !== true
          || maxRating != null || policy.BlockUnratedItems?.length || policy.BlockedTags?.length
          || policy.AllowedTags?.length);
        if (!visibleItem(source, user, navigation,
          { ...this.options, query: false, skipRelatedNameCheck: requiresRelatedArtist })) source = null;
        else if (requiresRelatedArtist && !await hasPostgresVisibleArtistRelation(db, source.Id, {
          userId: user.Id,
          visibility: this.#postgresVisibility(navigation, user),
          signal,
        })) source = null;
      }
    }
    if (!source) throw Object.assign(libraryError(404, 'Item not found'), { showsNotFound: true });

    // LibraryController returns these types before constructing DtoOptions,
    // reading library options, invoking a provider, or projecting DTOs.
    if (source.Type === 'Episode' || NAME_TYPES.has(source.Type) && source.Type !== 'MusicArtist') {
      return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    }

    beforeProjection?.();
    const requestedLimit = input.limit ?? 50;
    const projectionInput = { ...input,
      fields: [...new Set([...(input.fields ?? []), 'ProviderIds'])] };
    if (requestedLimit <= 0) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    if (!['Series', 'MusicArtist', 'MusicAlbum', 'Audio', 'Movie', 'Trailer', 'LiveTvProgram'].includes(source.Type)) {
      return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    }

    const optionsFor = id => this.options.libraryOptions instanceof Map
      ? this.options.libraryOptions.get(idKey(id)) ?? this.options.libraryOptions.get(id)
      : this.options.libraryOptions?.[id] ?? this.options.libraryOptions?.[idKey(id)];
    const itemStates = new WeakMap([[source, navigation]]);
    const foldersFor = item => item.Type === 'CollectionFolder' ? [item]
      : collectionFoldersForItem(item, itemStates.get(item) ?? navigation);
    const libraryOptionsFor = item => optionsFor(foldersFor(item)
      .find(folder => folder.Type === 'CollectionFolder')?.Id) ?? {};
    const libraryOptions = libraryOptionsFor(source);
    const typeOptions = (libraryOptions.TypeOptions ?? []).find(options =>
      String(options.Type ?? '').toLowerCase() === source.Type.toLowerCase());
    const providerKey = value => ordinalIgnoreCaseKey(String(value));
    const remote = new Set((typeOptions?.SimilarItemProviders ?? []).map(providerKey));
    const providerId = name => Object.entries(source.ProviderIds ?? {})
      .find(([key]) => providerKey(key) === providerKey(name))?.[1];

    const sourceNameAccessTypes = NAME_TYPES.has(source.Type) ? [source.Type] : [];
    const restrictedNameAccess = Boolean(user && (user.Policy.EnableAllFolders !== true
      || user.Policy.BlockedMediaFolders?.length
      || (user.MaxParentalRatingScore ?? user.Policy.MaxParentalRatingScore
        ?? user.Policy.MaxParentalRating) != null
      || user.Policy.BlockUnratedItems?.length || user.Policy.BlockedTags?.length
      || user.Policy.AllowedTags?.length));
    const accessVisibility = async () => {
      if (!user) return undefined;
      // SimilarItemsAccessFilter resolves views lazily for each provider/access
      // boundary. Besides defining reachability, this preserves creation and
      // refresh side effects of the native user-view lifecycle.
      const views = await this.userViews.views(navigation, user, { includeHidden: true });
      const reachableKeys = nextUpTopParentIds(views, navigation,
        folder => resolvedPhysicalFolderIds(folder, navigation), user, this.options);
      // nextUpTopParentIds exposes normalized comparison keys; SQL compares
      // the persisted GUID spelling and therefore needs the stored ids. Keep
      // collection-configured physical ids even when their Folder row is
      // temporarily absent from this navigation snapshot.
      const baseVisibility = this.#postgresVisibility(navigation, user);
      const spellings = new Map([...navigation.items.map(item => item.Id),
        ...(baseVisibility?.topParentIds ?? [])].map(id => [idKey(id), id]));
      const reachable = [...reachableKeys].map(key => spellings.get(key) ?? guid(key));
      const visibility = { ...baseVisibility, topParentIds: reachable };
      if (sourceNameAccessTypes.length && !restrictedNameAccess) {
        delete visibility.topParentIds;
        delete visibility.libraryTopParentIds;
      }
      return visibility;
    };
    const hydrateRows = async rows => {
      if (!rows.length) return [];
      const graphRows = await loadPostgresPageGraph(db, rows, navigationRows);
      const state = await this.load(db, user, { includeUserData: false, baseRows: graphRows });
      const items = rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
      for (const item of items) itemStates.set(item, state);
      return items;
    };

    const presentationKey = item => item.PresentationUniqueKey ?? createPresentationUniqueKey(item,
      { libraryOptions: libraryOptionsFor(item), collectionFolders: foldersFor(item) });
    const localProvider = {
      name: 'Local Genre/Tag', kind: 'local', itemTypes: [source.Type],
      getItems: async (_item, providerQuery, providerSignal) => {
        providerSignal?.throwIfAborted();
        const enableExternalContent = this.options.configuration?.EnableExternalContentInSuggestions ?? true;
        if (['Movie', 'Trailer'].includes(source.Type)) {
          return hydrateRows(await queryPostgresMovieSimilarRows(db, {
            sourceId: source.Id,
            excludeItemIds: providerQuery.excludeItemIds,
            enableExternalContent,
            limit: Math.max(0, providerQuery.limit ?? 50),
            userId: user?.Id,
            visibility: await accessVisibility(),
            signal: providerSignal,
          }));
        }
        const rows = await queryPostgresLocalSimilarRows(db, {
          ...localGenreTagSimilarQuery(source, providerQuery, { enableExternalContent }),
          userId: user?.Id,
          visibility: await accessVisibility(),
          nameAccessTypes: sourceNameAccessTypes,
          groupByPresentationKey: Boolean(user),
          signal: providerSignal,
        });
        return hydrateRows(rows);
      },
    };
    const manager = this.similarItems ??= new SimilarItemsManager({ fileSystem: this.options.fileSystem, logger: this.options.logger });
    const resolveRemote = async (references, {
      limit, after, referencePositions, providerOrderIndex,
    }) => {
      const page = await resolvePostgresRemoteSimilarRows(db, {
        itemType: source.Type,
        references,
        referencePositions,
        providerOrderIndex,
        limit,
        after,
        userId: user?.Id,
        visibility: await accessVisibility(),
        nameAccessTypes: sourceNameAccessTypes,
        signal,
      });
      return { items: await hydrateRows(page.rows), nextCursor: page.nextCursor };
    };
    const filterAccess = async allowed => {
      if (!user || !allowed.length) return allowed;
      const rows = await filterPostgresSimilarAccessRows(db, allowed.map(item => item.Id), {
        userId: user.Id,
        visibility: await accessVisibility(),
        nameAccessTypes: sourceNameAccessTypes,
        signal,
      });
      const selected = new Set(rows.map(row => idKey(row.Id)));
      return allowed.filter(item => selected.has(idKey(item.Id)));
    };
    const allowed = await manager.getSimilarItems({
      item: source,
      itemType: source.Type,
      typeOptions,
      additionalProviders: [localProvider],
      excludeArtistIds: input.excludeArtistIds ?? [],
      user,
      fields: projectionInput.fields,
      limit: input.limit,
      signal,
      idKey,
      presentationKey,
      presentationKeyKey: ordinalIgnoreCaseKey,
      resolveRemote,
      filterAccess,
    });

    if (!allowed.length) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
    const selectedRows = await loadPostgresRowsByIds(db, allowed.map(item => item.Id));
    const graphRows = await loadPostgresPageGraph(db, selectedRows, navigationRows);
    const state = await this.load(db, user, { baseRows: graphRows });
    state.folderStats = await queryPostgresFolderStats(db, allowed.map(item => item.Id), user?.Id);
    const options = dtoOptions(projectionInput);
    if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
    const projectionItems = allowed.map(selected => state.byId.get(idKey(selected.Id))).filter(Boolean);
    await this.#prefetchPostgresDtos(projectionItems, state, user, options);
    const items = [];
    for (const item of projectionItems) items.push(await projectItem(item, state, user, options, this.options));
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  async getItemList(input = {}, { user = null, checkParentAccess = true } = {}) {
    // PlayedFolderScope is an internal service contract. Keep it out of the
    // public query binder while still applying its exact predicate in SQL.
    const { PlayedFolderScope: playedFolderScope = null, ...publicInput } = input;
    return (await this.#queryItems(publicInput,
      { user, fromUserViewChildren: true, playedFolderScope, checkParentAccess }, false)).Items;
  }

  async #queryItems(input, {
    user = null, isApiKey = false, fromUserViewChildren = false, playedFolderScope = null, checkParentAccess = true,
  }, project) {
    const query = resolveOfficialRatingRanges(parseQuery(input, { allowNegativePaging: true }), this.options.configuration);
    return this.#runWithStates(db => this.#queryItemsPostgres(db, query,
      { user, isApiKey, fromUserViewChildren, playedFolderScope, checkParentAccess, project }));
  }
  async #queryItemsPostgres(db, query, {
    user, isApiKey, fromUserViewChildren, playedFolderScope, checkParentAccess, project,
  }) {
    let ownedSearchCollation, primaryError;
    try {
    let navigationRows = await loadPostgresNavigationRows(db, query.parentid);
    const requestedParentRow = nonemptyId(query.parentid)
      ? navigationRows.find(row => sameId(row.Id, query.parentid)) : null;
    if (requestedParentRow) {
      // Parent authorization for linked containers depends on their bounded
      // linked/ancestor graph, not merely the navigation entity itself.
      navigationRows = await loadPostgresPageGraph(db, [requestedParentRow], navigationRows);
    }
    const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationRows });
    const suppliedParent = query.parentid && navigation.byId.get(idKey(query.parentid));
    if (query.ids?.length || suppliedParent?.Type !== 'UserView' || collectionType(suppliedParent) !== 'tvnextup') {
      for (const key of ['startindex', 'limit']) if (query[key] < 0) throw libraryError(400, `${key} must not be negative.`);
    }

    if (Object.hasOwn(query, 'artists')) {
      const resolved = [];
      const selectorIds = await queryPostgresArtistSelectorIds(db, query.artists);
      const selectedRows = await loadPostgresRowsByIds(db, selectorIds.filter(nonemptyId));
      const selectedById = new Map(selectedRows.map(row => [idKey(row.Id), row]));
      let selectorsChanged = false;
      for (let index = 0; index < query.artists.length; index++) {
        const name = query.artists[index];
        try {
          if (selectorsChanged) {
            // A preceding creation is visible to every later native lookup,
            // including an unfiltered blank selector. Keep the normal read-only
            // path batched and refresh only the still-pending bounded selectors.
            const pendingIds = await queryPostgresArtistSelectorIds(db, query.artists.slice(index));
            selectorIds.splice(index, pendingIds.length, ...pendingIds);
            const pendingRows = await loadPostgresRowsByIds(db, pendingIds.filter(nonemptyId));
            for (const row of pendingRows) selectedById.set(idKey(row.Id), row);
            selectorsChanged = false;
          }
          const selector = await this.#getArtistPostgres(db, name, {
            selectorResolved: true,
            selectorRow: selectorIds[index] ? selectedById.get(idKey(selectorIds[index])) : null,
            onCreated: () => { selectorsChanged = true; },
          });
          resolved.push(selector.Id);
        } catch {
          // Jellyfin drops a failed selector while retaining earlier effects.
        }
      }
      if (resolved.length) query.artistids = resolved;
      else delete query.artistids;
      delete query.artists;
    }
    if (Object.hasOwn(query, 'albums')) {
      const resolved = await queryPostgresAlbumSelectorIds(db, query.albums);
      if (resolved.length) query.albumids = resolved;
      else delete query.albumids;
      delete query.albums;
    }
    if (Object.hasOwn(query, 'studios')) {
      const selectors = [];
      for (const name of query.studios) {
        try {
          selectors.push(await this.getStudio(name));
        } catch {
          // Match the controller's per-name failure boundary.
        }
      }
      query.studioids = selectors.map(selector => selector.Id);
      delete query.studios;
    }
    if (!query.sortby?.length && (query.artistids?.length || query.artistcleannames?.length)
      && query.includeitemtypes?.length === 1
      && query.includeitemtypes[0].toLowerCase() === 'musicalbum') {
      query.sortby = ['ProductionYear', 'SortName'];
      query.sortorder = ['Descending', 'Ascending'];
    }

    const explicitParent = requestedParent(query, navigation);
    // The controller may rewrite an IncludeItemTypes=BoxSet/Playlist request
    // to the user root before it performs the access check. Resolve that
    // synchronous dispatch first, then perform its potentially relational
    // PostgreSQL standalone check against the actual access item.
    const prepared = prepareItemsController(query, explicitParent, navigation, user, undefined,
      { controller: !fromUserViewChildren });
    const accessItem = prepared.item;
    const parentAccessAllowed = !checkParentAccess || !accessItem || accessItem.Type === 'UserRootFolder' || !user || isApiKey
      ? true
      : await this.#postgresStandaloneVisible(db, accessItem, user, navigation,
        { checkStandaloneParents: false });
    if (!parentAccessAllowed) {
      throw libraryError(401, `${user.Username} is not permitted to access Library ${accessItem.Name}.`);
    }
    const searchParentId = query.parentid;
    const rootFolders = user ? this.rootChildren(navigation, user) : this.rootChildren(navigation, null);
    const physicalIds = folders => this.#postgresPhysicalIds(folders, navigation);
    const baseVisibility = this.#postgresVisibility(navigation, user);
    const groupTypes = query.includeitemtypes?.map(type => type.toLowerCase()) ?? [];
    const excludedTypes = new Set(query.excludeitemtypes?.map(type => type.toLowerCase()) ?? []);
    const explicitNameTypes = [...NAME_TYPES].filter(nameType => groupTypes.includes(nameType.toLowerCase()));
    const providerNameTypes = [...NAME_TYPES].filter(nameType => (!groupTypes.length || groupTypes.includes(nameType.toLowerCase()))
      && !excludedTypes.has(nameType.toLowerCase()));
    let searchScores;
    let searchCollation;
    if (!fromUserViewChildren && clrTrim(query.searchterm ?? '')) {
      try {
        // SearchQueryAccessFilter configures the user's named views before
        // asking providers for matches.  Besides supplying the access scope,
        // that call owns the observable lazy-creation lifecycle even when the
        // provider returns no rows.  The PostgreSQL provider applies the same
        // access predicate in SQL, but must still run the view builder here.
        if (user) await this.userViews.views(navigation, user, { includeHidden: true });
        const results = await queryPostgresBuiltInSearch(db, query, {
          userId: user?.Id,
          parentId: searchParentId,
          visibility: baseVisibility,
          nameAccessTypes: nonemptyId(searchParentId) ? explicitNameTypes
            : providerNameTypes.length ? providerNameTypes : explicitNameTypes,
        });
        if (results.size) {
          const resolvedSearchCollation = await resolvePostgresSearchCollation(db,
            this.options.configuration.UICulture || 'en-US');
          ownedSearchCollation = resolvedSearchCollation;
          searchScores = results;
          searchCollation = resolvedSearchCollation;
          query.ids = [...new Map([...(query.ids ?? []), ...results.keys()]
            .map(id => [idKey(id), guid(id)])).values()];
          delete query.searchterm;
        }
      } catch (error) {
        // SearchManager observes a failed provider and continues through the
        // ordinary item path when no provider produced a result.
        try { this.onError(error); } catch { /* Error observers do not alter the search result. */ }
      }
    }
    const dispatch = itemsDispatch(query, explicitParent, navigation, user, undefined, { prepared });
    const { parent, isUserRoot, recursive, repository: repositoryQuery } = dispatch;
    if (user && repositoryQuery && isUserRoot && !query.ids?.length && !searchScores) {
      // AddUserToQuery obtains named views for an otherwise unscoped user-root
      // repository request. The lazy view creation is observable even when a
      // filter returns no media.
      await this.userViews.views(navigation, user, { includeHidden: true });
    }
    const searchProviderOrdering = Boolean(searchScores);
    if (!repositoryQuery && !user) {
      const requiringUser = query.sortby?.map(sort => ({
        dateplayed: 'DatePlayed', playcount: 'PlayCount', isunplayed: 'IsUnplayed', isfavoriteorliked: 'IsFavoriteOrLiked',
      })[sort.toLowerCase()]).find(Boolean);
      if (requiringUser) throw libraryError(400, `Sort key '${requiringUser}' requires a user, but none was provided.`);
    }

    // Synthetic user-view menus are persisted entities rather than catalogue
    // rows.  Their construction is being kept explicit so a future view type
    // cannot silently fall back to an unbounded JavaScript scan.
    if (dispatch.nextUpView) {
      return this.#queryNextUpViewPostgres(db, query, user, parent, navigationRows, navigation, project);
    }
    if (dispatch.foldersView) {
      return this.#queryUserViewItemsPostgres(db, query, user,
        rootFolders.map(item => item.Id), navigationRows, navigation, project);
    }
    if (dispatch.defaultViewChildren) {
      const aggregate = navigation.items.find(item => item.Type === 'AggregateFolder');
      const folders = user ? groupedMediaFolders(rootFolders, user)
        : navigation.items.filter(item => sameId(item.ParentId, aggregate?.Id) && eligibleForGrouping(item));
      const childScope = { sourceChildren: folders.map(folder => ({ key: folder.Id,
        parentIds: folder.Type === 'CollectionFolder' ? resolvedPhysicalFolderIds(folder, navigation) : [folder.Id] })) };
      const { topParentIds: _topParents, libraryTopParentIds: _libraryParents, ...visibility } = baseVisibility ?? {};
      return this.#queryUserViewItemsPostgres(db, query, user, [], navigationRows, navigation, project, { childScope,
        visibility: user ? { ...visibility, itemMode: 'standalone' } : undefined });
    }
    if (['movies', 'tvshows'].includes(dispatch.menuType)) {
      return this.#queryUserViewMenuPostgres(db, query, user, dispatch.menuType,
        parent, navigationRows, navigation, project);
    }
    if (['moviegenres', 'tvgenres'].includes(dispatch.menuType)) {
      return this.#queryUserViewGenreMenuPostgres(db, query, user, dispatch.menuType,
        parent, navigationRows, navigation, project);
    }
    if (dispatch.menuType || dispatch.memoryView && parent?.Type === 'UserView') {
      throw libraryError(501, `PostgreSQL query plan for user view '${dispatch.menuType ?? collectionType(parent)}' is not implemented.`);
    }

    if (parent?.Type === 'CollectionFolder' && !repositoryQuery && !query.ids?.length) {
      const childScope = { sourceChildren: [{ key: parent.Id,
        parentIds: [...resolvedPhysicalFolderIds(parent, navigation), ...(user ? [parent.Id] : [])] }] };
      const { topParentIds: _topParents, libraryTopParentIds: _libraryParents, ...visibility } = baseVisibility ?? {};
      return this.#queryUserViewItemsPostgres(db, query, user, [], navigationRows, navigation, project, { childScope,
        visibility: user ? { ...visibility, itemMode: 'standalone' } : undefined });
    }

    if (!fromUserViewChildren && prepared.item?.Type === 'UserRootFolder' && !repositoryQuery) {
      // ItemsController returns GetChildren directly for the plain user root;
      // its cached folder order and complete result bypass sorting and paging.
      const result = { Items: rootFolders, TotalRecordCount: rootFolders.length, StartIndex: query.startindex ?? 0 };
      if (!project) return result;
      const options = dtoOptions(query);
      if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
      await this.#prefetchPostgresDtos(rootFolders, navigation, user, options);
      const items = [];
      for (const item of rootFolders) items.push(await projectItem(item, navigation, user, options, this.options));
      return { ...result, Items: items };
    }

    if (repositoryQuery && (query.searchterm == null || query.searchterm === '')) {
      // ApplySeriesDatePlayedOrder replaces the complete requested chain with
      // its own direction and a SortName ascending tie-break. Do this before
      // building the relational page so COUNT, adjacency and paging all share
      // the same native order.
      const index = query.sortby?.findIndex(sort => sort.toLowerCase() === 'seriesdateplayed') ?? -1;
      if (index >= 0) query = { ...query, sortby: ['SeriesDatePlayed', 'SortName'],
        sortorder: [query.sortorder?.[index] ?? query.sortorder?.[0] ?? 'Ascending', 'Ascending'] };
    }
    if (repositoryQuery && !user
      && query.sortby?.some(sort => ['playcount', 'isplayed', 'isunplayed', 'isfavoriteorliked']
        .includes(sort.toLowerCase()))) {
      // ApplySeriesDatePlayedOrder replaces the original chain before the
      // repository captures query.User.Id for any surviving user-data sort.
      throw libraryError(500, 'Error processing request.');
    }

    const linkedParentTypes = ['BoxSet', 'Playlist'].includes(parent?.Type)
      ? await queryPostgresLinkTypes(db, [parent.Id])
      : new Map();
    const parentHasLinks = linkedParentTypes.has(idKey(parent?.Id));
    const legacyBoxSet = parent?.Type === 'BoxSet'
      && isLegacyBoxSet(parent, parentHasLinks, this.options.programDataPath);
    let scope = {};
    const preauthorizedRootScope = dispatch.foldersView || isUserRoot && !recursive;
    if (query.ids?.length) scope = {};
    else if (preauthorizedRootScope) {
      scope = { ids: rootFolders.map(item => item.Id) };
    } else if (parent?.Type === 'CollectionFolder') {
      const roots = resolvedPhysicalFolderIds(parent, navigation);
      scope = roots.length ? recursive ? { topParentIds: roots } : { parentIds: roots }
        : fromUserViewChildren && user ? { linkedParentId: parent.Id }
          : { ids: [] };
    } else if (parent?.Type === 'UserView') {
      const displayId = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId : parent.ParentId;
      const topParents = queryTopParentIds(parent, navigation, user, rootFolders);
      scope = topParents.length ? { topParentIds: topParents }
        : { ancestorId: nonemptyId(displayId) ? displayId : parent.Id };
    } else if (isUserRoot) {
      scope = { topParentIds: physicalIds(rootFolders.filter(folder => folder.IsFolder)) };
    } else if (parent?.Type === 'BoxSet') {
      if (repositoryQuery) {
        scope = { boxSetRepositoryId: parent.Id };
        if (user && parentHasLinks) {
          scope.topParentIds = physicalIds(rootFolders.filter(folder => folder.IsFolder));
        }
      }
      else if (legacyBoxSet) scope = { parentId: parent.Id };
      else scope = user ? { linkedParentId: parent.Id } : { ids: [] };
      // Only the modern in-memory LinkedChildren path intersects members with
      // the user's visible root folders. Legacy Folder.Children and recursive
      // repository traversal deliberately do not inherit that library scope.
      if (user && !repositoryQuery && !legacyBoxSet) {
        const visibleTopParents = physicalIds(rootFolders.filter(folder => folder.IsFolder));
        scope.linkedTopParentIds = visibleTopParents;
      }
    } else if (parent?.Type === 'Playlist') {
      scope = { linkedParentId: parent.Id };
    } else if (parent) scope = recursive ? { ancestorId: parent.Id } : { parentId: parent.Id };
    if (dispatch.linkedChildAncestorIds.length) {
      scope.linkedChildAncestorIds = dispatch.linkedChildAncestorIds;
    }

    let visibility = baseVisibility;
    // RootChildren has already applied library/entity visibility before its
    // exact identifiers become the SQL scope. Likewise, CollectionFolder's
    // internal GetChildren path authorizes the container before following its
    // links. Reapplying the repository TopParentIds predicate would discard
    // the synthetic playlists root and linked rows whose stored top parent is
    // intentionally empty.
    if (visibility && preauthorizedRootScope && !query.ids?.length) visibility = undefined;
    else if (visibility && fromUserViewChildren && parent?.Type === 'CollectionFolder'
      && scope.linkedParentId != null) {
      const { topParentIds: _topParentIds, ...directVisibility } = visibility;
      visibility = directVisibility;
    }
    if (visibility) {
      const boxSetStandalone = !repositoryQuery || dispatch.postFilter
        || parent?.Type === 'CollectionFolder' && collectionType(parent) === 'boxsets';
      visibility = {
      ...visibility,
      boxSetStandalone,
      boxSetTopParentExempt: repositoryQuery,
      boxSetChildRatingMode: boxSetStandalone ? 'both' : 'repository',
      };
      if (parent?.Type === 'BoxSet' && (legacyBoxSet || repositoryQuery && !parentHasLinks)
        && visibility.libraryTopParentIds) {
        // BoxSet.GetItems applies per-item parental visibility with library
        // scoping disabled. Keep the complete library universe available for
        // standalone nested-BoxSet rules without restricting it to the user's
        // enabled folders.
        visibility.topParentIds = visibility.libraryTopParentIds;
      }
    }
    const repositoryNeedsLibraryScope = isUserRoot || ['UserView', 'BoxSet'].includes(parent?.Type);
    if (visibility && !searchProviderOrdering && repositoryQuery && !repositoryNeedsLibraryScope
      && (!visibility.boxSetStandalone || parent?.Type === 'PlaylistsFolder')) {
      const { topParentIds: _repositoryScope, ...directVisibility } = visibility;
      visibility = directVisibility;
    }
    const nameAccessTypes = searchProviderOrdering
      ? providerNameTypes.length ? providerNameTypes : explicitNameTypes
      : explicitNameTypes;
    const groupByPresentationKey = Boolean(repositoryQuery && user && !query.isresumable
      && (!groupTypes.length || groupTypes.some(type => ['episode', 'video', 'movie', 'musicvideo', 'series', 'season'].includes(type))));
    const collapse = dispatch.directRepository
      ? { active: query.collapseboxsetitems === true && !query.ids?.length && !query.searchterm?.trim(), types: [] }
      : boxSetCollapsePlan(query, {
        parent,
        user,
        configuration: this.options.configuration,
        repository: repositoryQuery,
      });
    const boxSetMemoryOrder = !repositoryQuery && !recursive && !query.ids?.length
      && parent?.Type === 'BoxSet';
    const postgresQueryOptions = {
      scope,
      userId: user?.Id,
      includeOwnedItems: repositoryQuery && (query.ishd !== undefined || query.is4k !== undefined || query.is3d !== undefined
        || Boolean(query.videotypes?.length || query.hassubtitles !== undefined || query.audiolanguages?.length || query.subtitlelanguages?.length)),
      includeAlternateVersions: repositoryQuery && query.isresumable === true,
      groupByPresentationKey,
      nameAccessTypes,
      searchScores: searchScores ? [...searchScores].map(([id, score]) => ({ id, score })) : null,
      searchCollation,
      resumableMode: repositoryQuery ? 'repository' : 'memory',
      collapseTypes: collapse.active ? collapse.types : null,
      collapseMode: repositoryQuery ? 'repository' : 'memory',
      collapseCollectionPath: !repositoryQuery && this.options.programDataPath
        ? path.join(this.options.programDataPath, 'data', 'collections') : null,
      memorySortConfiguration: this.options.configuration,
      memoryRatingContext: postgresParentalRatingContext(navigation, this.options),
      memoryPresort: boxSetMemoryOrder && user ? boxSetDisplayOrder(parent) : null,
      memorySourceOrder: boxSetMemoryOrder ? 'stored-sort-name' : null,
      memoryFolderPlayback: boxSetMemoryOrder && Boolean(user),
      playedFolderScope,
      playlistSharing: dispatch.postFilter && user ? {
        userId: user.Id,
        dataPath: this.options.dataPath ?? (this.options.programDataPath && path.join(this.options.programDataPath, 'data')),
        metadataPath: this.options.metadataPath,
      } : null,
      visibility,
    };
    const leadingEmptyMemorySelector = !repositoryQuery
      ? ['studioids', 'genreids'].find(key => query[key]?.length && !nonemptyId(query[key][0]))
      : undefined;
    if (leadingEmptyMemorySelector) {
      // UserViewBuilder evaluates selector Any() lazily for each candidate.
      // A leading Guid.Empty therefore throws only after the candidate scope
      // and earlier named-entity predicates have produced at least one row.
      // Probe that existence relationally so an empty folder or a failing
      // Genres/Studios precondition retains the native successful empty page.
      const selectorProbe = { ...query, startindex: 0, limit: 1 };
      delete selectorProbe[leadingEmptyMemorySelector];
      const probe = await queryPostgresItemPage(db, selectorProbe, {
        ...postgresQueryOptions,
        includeOwnedItems: true,
        includeAlternateVersions: true,
        groupByPresentationKey: false,
      });
      if (probe.total > 0) throw libraryError(400, 'Error processing request.');
    }
    if (query.videotypes?.length && query.ids?.length) {
      const nullVideoTypes = await countPostgresNullVideoTypeRows(db, query.ids);
      for (let index = 0; index < nullVideoTypes; index++) {
        try {
          this.onError(new NativeItemJsonError('null-nonnullable', '$.VideoType',
            'A nonnullable VideoType cannot read null.'));
        } catch { /* Error observers do not alter item queries. */ }
      }
    }
    const page = await queryPostgresItemPage(db, query, postgresQueryOptions);
    const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
    const state = await this.load(db, user, { baseRows: graphRows });
    const items = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
    const start = page.startIndex;
    state.folderStats = await queryPostgresFolderStats(db,
      items.filter(item => item.IsFolder).map(item => item.Id), user?.Id);
    if (!project) return { Items: items, TotalRecordCount: page.total, StartIndex: start };
    const options = dtoOptions(query);
    if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
    const projectionItems = searchScores && user
      ? await this.#filterPostgresStandalonePage(db, items, user, state, { skipRelatedNameCheck: true })
      : items;
    await this.#prefetchPostgresDtos(projectionItems, state, user, options);
    const dtos = [];
    for (const item of projectionItems) {
      dtos.push(await projectItem(item, state, user, options, this.options));
    }
    const totalRecordCount = searchScores ? page.total : dispatch.pageResult ? dtos.length
      : query.enabletotalrecordcount === false && dispatch.postFilter ? 0
        : repositoryQuery && query.enabletotalrecordcount === false ? dtos.length : page.total;
    return { Items: dtos, TotalRecordCount: totalRecordCount, StartIndex: start };
    } catch (error) { primaryError = error; throw error; }
    finally { await releasePostgresSearchCollation(ownedSearchCollation, primaryError); }
  }

  async #queryNextUpViewPostgres(db, query, user, parent, navigationRows, navigation, project) {
    if (!user) throw libraryError(400, 'Error processing request.');
    const parents = parent?.Type === 'UserView'
      ? groupedMediaFolders(this.rootChildren(navigation, user), user)
        .filter(folder => collectionType(folder) === 'tvshows')
      : parent ? [parent] : [];
    const topParentIds = [...nextUpTopParentIds(parents, navigation,
      folder => resolvedPhysicalFolderIds(folder, navigation), user, this.options)];
    const { topParentIds: _topParentIds, libraryTopParentIds: _libraryTopParentIds,
      ...visibility } = this.#postgresVisibility(navigation, user) ?? {};
    const page = await queryPostgresNextUpPage(db, {
      seriesDiscovery: { topParentIds, nextUpDateCutoff: MIN_DATE },
      userId: user.Id,
      visibility,
      displaySpecialsWithinSeasons: this.options.configuration.DisplaySpecialsWithinSeasons === true,
      enableUserData: query.enableuserdata !== false,
      startIndex: query.startindex ?? 0,
      limit: query.limit,
    });
    const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
    const state = await this.load(db, user, { baseRows: graphRows, includeManualLinks: false });
    const streamIds = state.items.filter(item => VIDEO_TYPES.has(item.Type)).map(item => item.Id);
    state.mediaStreams = streamIds.length
      ? await db.rows('MediaStreamInfos', { whereIn: { ItemId: streamIds } }) : [];
    const selectedItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
    const result = { Items: selectedItems, TotalRecordCount: page.total, StartIndex: query.startindex ?? 0 };
    if (!project) return result;
    const options = dtoOptions(query);
    if (user.Policy.AllowedTags?.length) options.fields.add('tags');
    await this.#prefetchPostgresDtos(result.Items, state, user, options);
    const items = [];
    for (const item of result.Items) items.push(await projectItem(item, state, user, options, this.options));
    return { ...result, Items: items };
  }

  async #queryUserViewMenuPostgres(db, query, user, menuType, parent,
    navigationRows, navigation, project) {
    const generated = await this.userViews.menu(menuType, parent, db, navigation);
    return this.#queryUserViewItemsPostgres(db, query, user,
      generated.map(item => item.Id), navigationRows, navigation, project);
  }

  async #queryUserViewItemsPostgres(db, query, user, itemIds, navigationRows, navigation, project, scopeOptions = {}) {
    const start = query.startindex ?? 0;
    const page = await queryPostgresUserViewMenuPage(db, query, itemIds, {
      userId: user?.Id,
      memorySortConfiguration: this.options.configuration,
      memoryRatingContext: postgresParentalRatingContext(navigation, this.options),
      ...scopeOptions,
    });
    const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
    const state = await this.load(db, user, { baseRows: graphRows });
    const items = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
    if (!project) return { Items: items, TotalRecordCount: page.total, StartIndex: start };
    const options = dtoOptions(query);
    if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
    await this.#prefetchPostgresDtos(items, state, user, options);
    const dtos = [];
    for (const item of items) dtos.push(await projectItem(item, state, user, options, this.options));
    return { Items: dtos, TotalRecordCount: page.total, StartIndex: start };
  }

  async #queryUserViewGenreMenuPostgres(db, query, user, menuType, parent,
    navigationRows, navigation, project) {
    let sourceScope;
    if (parent?.Type === 'CollectionFolder') {
      sourceScope = { topParentIds: resolvedPhysicalFolderIds(parent, navigation) };
    } else if (parent?.Type === 'UserView') {
      const type = collectionType(parent);
      if (user && ['', 'movies', 'tvshows'].includes(type)) {
        const folders = groupedMediaFolders(this.rootChildren(navigation, user), user)
          .filter(folder => collectionType(folder) === '' || collectionType(folder) === type);
        sourceScope = { topParentIds: this.#postgresPhysicalIds(folders, navigation) };
      } else {
        const ancestorId = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId
          : nonemptyId(parent.ParentId) ? parent.ParentId : parent.Id;
        sourceScope = { ancestorId };
      }
    } else sourceScope = { ancestorId: parent?.Id };

    const baseVisibility = this.#postgresVisibility(navigation, user);
    let sourceVisibility;
    if (baseVisibility) {
      const {
        topParentIds: _topParentIds,
        libraryTopParentIds: _libraryTopParentIds,
        ratingContext: _ratingContext,
        ...directVisibility
      } = baseVisibility;
      sourceVisibility = directVisibility;
    }
    const viewType = menuType === 'moviegenres' ? 'moviegenre' : 'tvgenre';
    const subviewId = nativeUserSubviewIdentity(parent.Id, viewType, this.options).Id;
    const seedRows = await loadPostgresRowsByIds(db, [subviewId]);
    const scopedRows = new Map([...navigationRows, ...seedRows].map(row => [idKey(row.Id), row]));
    const state = await this.load(db, user, { baseRows: [...scopedRows.values()] });
    const page = await queryPostgresUserViewGenrePage(db, query, {
      itemType: menuType === 'moviegenres' ? 'Movie' : 'Series',
      scope: sourceScope,
      groupByPresentationKey: Boolean(user),
      visibility: sourceVisibility,
      itemId: subviewId,
    });

    if (page.seedName === undefined) {
      return { Items: [], TotalRecordCount: 0, StartIndex: page.startIndex };
    }

    // SQL selects the page and shared-view seed before GetGenre performs its
    // native name lookup and creation. Those entities need no DTO graph.
    const hydrateName = async name => {
      let generated;
      for await (const item of this.userViews.genreMenu(menuType, parent, [{ Genres: [name] }], db, state)) {
        generated ??= item;
      }
      return generated;
    };

    const menuItem = await hydrateName(page.seedName);
    if (!menuItem) return { Items: [], TotalRecordCount: 0, StartIndex: page.startIndex };
    if ([...(query.genreids ?? []), ...(query.studioids ?? [])].some(id => !nonemptyId(id))) {
      throw libraryError(400, 'Error processing request.');
    }
    const matches = await matchesPostgresUserViewGenre(db, query, {
      itemId: menuItem.Id,
      userId: user?.Id,
      memorySortConfiguration: this.options.configuration,
      memoryRatingContext: postgresParentalRatingContext(navigation, this.options),
    });
    const items = [];
    let seedAvailable = true;
    for (const row of page.rows) {
      let item;
      if (seedAvailable && row.name === page.seedName) {
        seedAvailable = false;
        item = menuItem;
      } else item = await hydrateName(row.name);
      if (matches && item) items.push(item);
    }
    const total = matches ? page.total : 0;
    if (!project) return { Items: items, TotalRecordCount: total, StartIndex: page.startIndex };
    const options = dtoOptions(query);
    if (user?.Policy.AllowedTags?.length) options.fields.add('tags');
    await this.#prefetchPostgresDtos(items, state, user, options);
    const dtos = [];
    for (const item of items) dtos.push(await projectItem(item, state, user, options, this.options));
    return { Items: dtos, TotalRecordCount: total, StartIndex: page.startIndex };
  }

  async #getArtistPostgres(db, name, { selectorResolved = false, selectorRow = null, onCreated } = {}) {
    if (!selectorResolved) {
      const selectorId = await queryPostgresArtistSelectorId(db, name);
      selectorRow = selectorId ? (await loadPostgresRowsByIds(db, [selectorId]))[0] : null;
    }
    if (selectorRow) {
      const selector = mapRecord(selectorRow);
      selector.Path = this.options.expandPath?.(selector.Path) ?? selector.Path;
      return selector;
    }
    return this.#getItemByName(name, nativeArtistIdentity, 'MusicArtist',
      'MediaBrowser.Controller.Entities.Audio.MusicArtist', { onCreated });
  }

  getArtist(name) {
    if (typeof name !== 'string') return Promise.reject(new TypeError('An artist name is required.'));
    return this.store.serializeWrites(db => this.#getArtistPostgres(db, name));
  }

  getGenre(name) {
    return this.#getItemByName(name, nativeGenreIdentity, 'Genre', 'MediaBrowser.Controller.Entities.Genre');
  }

  getStudio(name) {
    return this.#getItemByName(name, nativeStudioIdentity, 'Studio', 'MediaBrowser.Controller.Entities.Studio');
  }

  getMusicGenre(name) {
    return this.#getItemByName(name, nativeMusicGenreIdentity, 'MusicGenre', 'MediaBrowser.Controller.Entities.Audio.MusicGenre');
  }

  async #getItemByName(name, identify, type, nativeType, { onCreated } = {}) {
    const identity = identify(name, this.options);
    return this.store.serializeWrites(async db => {
      const existing = this.itemCreation ? await this.itemCreation.getItemById(identity.Id)
        : mapRecord((await loadPostgresRowsByIds(db, [identity.Id]))[0]);
      if (existing?.Type === type) {
        existing.Path = this.options.expandPath?.(existing.Path) ?? existing.Path;
        return existing;
      }
      if (!this.itemCreation) throw libraryError(501, `${type} creation requires the native entity lifecycle.`);
      const metadataPath = this.options.metadataPath ?? path.join(this.options.programDataPath, 'metadata');
      const assets = new MetadataImageAssets({ fileSystem: this.options.fileSystem, metadataPath });
      const target = await assets.resolve(identity.Path);
      if (!target.localPath) throw libraryError(501, `${type} creation requires the isolated metadata directory.`);
      const directory = await assets.createDirectory(identity.Path);
      const item = newNativeItemEntity(nativeType);
      Object.assign(item, { Id: identity.Id, Name: name, Path: identity.Path,
        DateCreated: nativeDateFromUnixNanoseconds(directory.birthtimeNs),
        DateModified: nativeDateFromUnixNanoseconds(directory.mtimeNs) });
      await this.itemCreation.createItems([item], null, { creationIntent: 'library-save' });
      onCreated?.();
      return item;
    });
  }

  async queryInstantMix(input = {}, { user = null, playlistOnly = false, beforeProjection } = {}) {
    return this.#runWithStates(async db => {
      let source = null;
      if (input.genreName === undefined) {
        if (!nonemptyId(input.itemId)) throw libraryError(400, 'Error processing request.');
        try {
          if (this.itemCreation) {
            source = await this.itemCreation.getItemById(input.itemId);
            if (source && user && source.Type !== 'UserRootFolder') {
              const state = await this.#loadPostgresItemState(db,
                [source.Id, source.ParentId, source.OwnerId].filter(nonemptyId), user, { includeUserData: false });
              if (!await this.#postgresStandaloneVisible(db, source, user, state)) source = null;
            }
            if (!source) throw libraryError(404, 'Item not found.');
          } else source = await this.getItemRecord(input.itemId, { user });
        }
        catch (error) {
          if (error.status === 404) error.instantMixNotFound = true;
          throw error;
        }
        if (playlistOnly && source.Type !== 'Playlist') {
          throw Object.assign(libraryError(404, 'Item not found.'), { instantMixNotFound: true });
        }
      }
      const mixed = source ? await queryPostgresInstantMix(db, this, source, user)
        : await queryPostgresInstantMixGenres(db, this, [input.genreName], user);
      const total = mixed.length;
      const selected = input.limit === undefined ? mixed : mixed.slice(0, Math.max(0, input.limit));
      if (!selected.length) return { Items: [], TotalRecordCount: total, StartIndex: 0 };
      beforeProjection?.();
      const state = await this.#loadPostgresItemState(db, selected.map(item => item.Id), user);
      const options = dtoOptions(input);
      const items = selected.map(item => state.byId.get(idKey(item.Id)) ?? item);
      await this.#prefetchPostgresDtos(items, state, user, options);
      const dtos = [];
      for (const item of items) dtos.push(await projectItem(item, state, user, options, this.options));
      return { Items: dtos, TotalRecordCount: total, StartIndex: 0 };
    });
  }

  async queryResumeItems(input = {}, { user, activeItemIds = [] } = {}) {
    if (!user) throw libraryError(400, 'userId is required');
    const query = parseQuery(input);
    for (const key of Object.keys(query)) {
      if (!resumeQueryKeys.has(key)) unsupported(`Resume query parameter '${key}' is not implemented.`);
    }
    query.recursive = true;
    query.isresumable = true;
    query.sortby = ['DatePlayed'];
    query.sortorder = ['Descending'];
    return this.#runWithStates(db => this.#queryResumeItemsPostgres(db, query, user, activeItemIds));
  }

  async #queryResumeItemsPostgres(db, query, user, activeItemIds) {
    const hasParent = nonemptyId(query.parentid);
    const navigationRows = await loadPostgresNavigationRows(db, hasParent ? query.parentid : undefined);
    const navigation = await this.load(db, user, { includeUserData: false, baseRows: navigationRows });
    const explicitParent = hasParent ? navigation.byId.get(idKey(query.parentid)) : null;
    const rootFolders = this.rootChildren(navigation, user);
    let scope = {};
    if (explicitParent?.Type === 'CollectionFolder') {
      const roots = resolvedPhysicalFolderIds(explicitParent, navigation);
      scope = roots.length ? { topParentIds: roots } : { ancestorId: explicitParent.Id };
    } else if (explicitParent?.Type === 'UserView') {
      const displayId = nonemptyId(explicitParent.DisplayParentId) ? explicitParent.DisplayParentId : explicitParent.ParentId;
      const display = navigation.byId.get(idKey(displayId));
      if (display?.Type === 'CollectionFolder') scope = { topParentIds: resolvedPhysicalFolderIds(display, navigation) };
      else scope = { ancestorId: nonemptyId(displayId) ? displayId : explicitParent.Id };
    } else if (explicitParent && ['BoxSet', 'Playlist'].includes(explicitParent.Type)) {
      const linked = await db.rows('LinkedChildren', { where: { ParentId: explicitParent.Id }, columns: ['ParentId'], limit: 1 });
      scope = linked.length ? { linkedParentId: explicitParent.Id } : { ancestorId: explicitParent.Id };
    } else if (explicitParent) scope = { ancestorId: explicitParent.Id };
    else if (hasParent) scope = { parentId: query.parentid };
    else {
      const latestExcludes = user.Configuration?.LatestItemsExcludes ?? [];
      if (latestExcludes.length) scope = { ancestorIds: rootFolders
        .filter(folder => folder.IsFolder && !latestExcludes.some(id => sameId(id, folder.Id)))
        .map(folder => folder.Id) };
    }

    let visibility = this.#postgresVisibility(navigation, user);
    if (visibility && (hasParent || user.Configuration?.LatestItemsExcludes?.length)) {
      const { topParentIds: _repositoryScope, ...explicitVisibility } = visibility;
      visibility = explicitVisibility;
    }
    const page = await queryPostgresItemPage(db, query, {
      scope,
      userId: user.Id,
      includeOwnedItems: true,
      includeAlternateVersions: true,
      excludeVersionFamilyIds: activeItemIds,
      resumableMode: 'repository',
      visibility,
    });
    const graphRows = await loadPostgresPageGraph(db, page.rows, navigationRows);
    const state = await this.load(db, user, { baseRows: graphRows });
    state.folderStats = await queryPostgresFolderStats(db,
      page.rows.filter(row => row.IsFolder).map(row => row.Id), user.Id);
    const options = dtoOptions(query);
    if (user.Policy.AllowedTags?.length) options.fields.add('tags');
    const pagedItems = page.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean);
    const projectionItems = await this.#filterPostgresStandalonePage(db, pagedItems, user, state);
    await this.#prefetchPostgresDtos(projectionItems, state, user, options);
    const dtos = [];
    for (const item of projectionItems) dtos.push(await projectItem(item, state, user, options, this.options));
    return {
      Items: dtos,
      TotalRecordCount: query.enabletotalrecordcount === false ? page.rows.length : page.total,
      StartIndex: page.startIndex,
    };
  }

  rootChildren(state, user) {
    // CreateRootFolder registers the plug-in at DataPath/playlists using its
    // derived identity. Other stored PlaylistsFolder rows are not virtual
    // children merely because they share an Aggregate parent or path.
    const programDataPath = this.options.programDataPath;
    const playlistPath = programDataPath ? path.join(programDataPath, 'data', 'playlists') : null;
    const playlistId = playlistPath ? getNewItemId(playlistPath, 'Emby.Server.Implementations.Playlists.PlaylistsFolder', {
      programDataPath, enableCaseSensitiveItemIds: this.options.configuration.EnableCaseSensitiveItemIds,
    }) : null;
    const playlist = playlistId ? state.byId.get(idKey(playlistId)) : null;
    const virtual = playlist?.Type === 'PlaylistsFolder' && typeof playlist.Path === 'string'
      && ordinalIgnoreCaseKey(playlist.Path) === ordinalIgnoreCaseKey(playlistPath) ? [playlist] : [];
    const children = new Map();
    for (const item of [...userRootFolders(state), ...virtual]) {
      if (item.Type === 'CollectionFolder' && !visibleLibrary(item, user, this.options.libraryOptions)) continue;
      if (user && !visibleItem(item, user, state, { ...this.options, query: false, checkStandaloneParents: false })) continue;
      children.set(idKey(item.Id), item);
    }
    return [...children.values()];
  }

  async hasVisibleUserViewChild(folder, state, user) {
    const parentIds = folder.Type === 'CollectionFolder'
      ? resolvedPhysicalFolderIds(folder, state) : [folder.Id];
    const { topParentIds: _topParentIds, libraryTopParentIds: _libraryTopParentIds,
      ...visibility } = this.#postgresVisibility(state, user) ?? {};
    return queryPostgresUserViewChildPresence(state.db, {
      parentIds,
      userId: user?.Id,
      // RootChildren has already authorized this collection folder. The
      // native repository child query disables its separate library scope.
      visibility: user ? visibility : undefined,
    });
  }

  async getDtoChildCount(item, state, user) {
    const key = idKey(item.Id);
    if (state.dtoChildCounts?.has(key)) return state.dtoChildCounts.get(key);
    const request = await this.#postgresChildCountRequest(item, state, user);
    if (Object.hasOwn(request, 'count')) return request.count;
    const hideMissing = user && !(user.DisplayMissingEpisodes ?? user.Configuration?.DisplayMissingEpisodes);
    const { topParentIds: _ignoredTopParents, ...visibility } = this.#postgresVisibility(state, user) ?? {};
    const counts = await queryPostgresDtoChildCounts(state.db, [request],
      hideMissing ? { ismissing: false } : {}, {
        userId: user?.Id,
        visibility: user ? visibility : undefined,
      });
    return counts.get(key) ?? 0;
  }

  async getCollectionFolders(reference) {
    return this.#runWithStates(async db => {
      const referenceIds = reference?.Id
        ? [reference.Id, reference.ParentId, reference.OwnerId, repositoryTopParentId(reference)].filter(nonemptyId)
        : [];
      const state = await this.#loadPostgresItemState(db, referenceIds, null, { includeUserData: false });
      try {
        const item = reference?.Id ? reference : state.byId.get(idKey(reference)) ?? null;
        return item ? collectionFoldersForItem(item, state).map(value => this.#rememberRecord(value)) : [];
      } finally { await state.dispose(); }
    });
  }

  async getLibraryUpdateInfo({ itemsAdded = [], itemsUpdated = [], itemsRemoved = [], foldersAddedTo = [], foldersRemovedFrom = [] } = {}, { user } = {}) {
    if (!user) throw libraryError(404, 'User not found.');
    return this.#runWithStates(async db => {
      const references = [...itemsAdded, ...itemsUpdated, ...itemsRemoved, ...foldersAddedTo, ...foldersRemovedFrom]
        .map(item => item?.Id).filter(nonemptyId);
      const state = await this.#loadPostgresItemState(db, references, user, { includeUserData: false });
      const root = state.items.find(item => item.Type === 'UserRootFolder');
      const type = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
      const standaloneVisibility = new Map();
      const unique = new Map([...itemsAdded, ...itemsUpdated, ...foldersAddedTo, ...foldersRemovedFrom]
        .filter(item => nonemptyId(item?.Id)).map(item => [idKey(item.Id), item]));
      const candidates = [...unique].map(([key, reference]) => state.byId.get(key) ?? reference);
      const visible = new Set((await this.#filterPostgresStandaloneBatch(db, candidates, user, state))
        .map(item => idKey(item.Id)));
      for (const key of unique.keys()) standaloneVisibility.set(key, visible.has(key));
      const isVisible = item => standaloneVisibility.has(idKey(item.Id))
        ? standaloneVisibility.get(idKey(item.Id))
        : visibleItem(item, user, state, { ...this.options, query: false });
      const translate = (items, includeIfNotFound = false) => {
        const result = [];
        const seen = new Set();
        for (const item of items) {
          let translated = item;
          if (type(item) === 'AggregateFolder') translated = root;
          else if (!includeIfNotFound && !isVisible(item)) continue;
          if (!translated) continue;
          const id = idKey(translated.Id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          result.push(id);
        }
        return result;
      };
      const changedParents = [...foldersAddedTo, ...foldersRemovedFrom];
      const collectionFolders = changedParents.some(item => type(item) !== 'AggregateFolder')
        ? [...new Set(this.rootChildren(state, user).filter(item => item.IsFolder
          && isVisible(item)).map(item => idKey(item.Id)))]
        : [];
      return {
        FoldersAddedTo: translate(foldersAddedTo),
        FoldersRemovedFrom: translate(foldersRemovedFrom),
        ItemsAdded: translate(itemsAdded),
        ItemsRemoved: translate(itemsRemoved, true),
        ItemsUpdated: translate(itemsUpdated),
        CollectionFolders: collectionFolders
      };
    });
  }

  async getItemRecord(id, { user = null } = {}) {
    const normalized = guid(id);
    return this.#runWithStates(async db => {
      const state = await this.#loadPostgresItemState(db, nonemptyId(normalized) ? [normalized] : [], user);
      const item = nonemptyId(normalized) ? state.byId.get(idKey(normalized)) : state.items.find(item => item.Type === 'UserRootFolder');
      const visible = item && (!user || await this.#postgresStandaloneVisible(db, item, user, state));
      if (!visible) throw libraryError(404, 'Item not found.');
      return this.#rememberRecord(item);
    });
  }

  async getDeletionItem(id, { user = null } = {}) {
    const normalized = guid(id);
    // LibraryManager.GetItemById rejects Guid.Empty; unlike DTO/root reads it
    // never treats this deletion ID as the user-root selector.
    if (!nonemptyId(normalized)) throw libraryError(400, "Guid can't be empty. (Parameter 'id')");
    if (!this.itemCreation) throw libraryError(501, 'Item deletion requires native entity hydration.');
    const item = await this.itemCreation.getItemById(normalized);
    if (!item) return null;
    return this.#runWithStates(async db => {
      const state = await this.#loadPostgresItemState(db, [normalized], user, { includeUserData: false });
      // Authorization uses the bounded current SQL frame. A queued Playlist
      // mutation may retain a live deletion entity with older share metadata.
      const permissionItem = state.byId.get(idKey(normalized)) ?? item;
      if (user && permissionItem.Type !== 'UserRootFolder' && !await this.#postgresStandaloneVisible(db, permissionItem, user, state)) return null;
      return { item, canDelete: !user || canDeleteItem(permissionItem, user, {
        collectionFolders: () => collectionFoldersForItem(permissionItem, state),
        isActiveRecording: this.options.isActiveRecording,
      }) };
    });
  }

  async getItem(id, { user = null, ...query } = {}) {
    const normalized = guid(id);
    return this.#runWithStates(async db => {
      const state = await this.#loadPostgresItemState(db, nonemptyId(normalized) ? [normalized] : [], user);
      const item = nonemptyId(normalized) ? state.byId.get(idKey(normalized)) : state.items.find(item => item.Type === 'UserRootFolder');
      const visible = item && (!user || await this.#postgresStandaloneVisible(db, item, user, state));
      if (!visible) throw libraryError(404, 'Item not found.');
      return projectItem(item, state, user, dtoOptions(parseQuery(query), true), this.options);
    });
  }

  async getItemDto(item, { user = null, ...query } = {}) {
    return this.getItem(item.Id, { user, ...query });
  }

  async getUserDataList(references, { user } = {}) {
    if (!user) throw libraryError(404, 'User not found.');
    return this.#runWithStates(async db => {
      const ids = references.flatMap(reference => [reference.item?.Id, reference.id, reference.fallbackId]).filter(nonemptyId);
      const state = await this.#loadPostgresItemState(db, ids, user);
      const prepared = [];
      for (const reference of references) {
        let item = reference.item ?? state.byId.get(idKey(reference.id));
        if (!item && nonemptyId(reference.fallbackId)) item = state.byId.get(idKey(reference.fallbackId));
        if (!item) continue;
        let keyedItem = null;
        if (reference.item) {
          keyedItem = ['Episode', 'Season'].includes(item.Type)
            ? { ...item, Series: resolveSeries(item, state.byId) }
            : item;
        }
        prepared.push({ item, keyedItem });
      }
      const keyedItems = prepared.map(entry => entry.keyedItem).filter(Boolean);
      const keyMap = keyedItems.length ? await postgresUserDataKeyMap(db, keyedItems) : null;
      const result = new Map();
      for (const { item, keyedItem } of prepared) {
        let ownData = null;
        if (keyedItem) {
          ownData = await readUserDataRows(db, keyedItem, state.rowsFor(item),
            keyMap?.get(idKey(item.Id)));
        }
        const dto = await projectUserData(item, state, user, ownData);
        if (dto) result.set(idKey(item.Id), dto);
      }
      return [...result.values()];
    });
  }

  async getMediaSources(id, { user = null } = {}) {
    return this.#runWithStates(async db => {
      const normalized = guid(id);
      const state = await this.#loadPostgresItemState(db, [normalized], user);
      const item = state.byId.get(idKey(normalized));
      const visible = item && (!user || await this.#postgresStandaloneVisible(db, item, user, state));
      if (!visible) throw libraryError(404, 'Item not found.');
      if (!VIDEO_TYPES.has(item.Type) && !['Audio', 'AudioBook'].includes(item.Type)) return [];
      const sources = await mediaSources(item, state, user, this.options);
      return sortMediaSources(sources, sources[0]?.Id ?? item.Id, true);
    });
  }

  getSplashscreenImagePaths(imageType) {
    return this.#runWithStates(async db => {
      const paths = await querySplashscreenImagePaths(db, imageType);
      return paths.map(value => this.options.expandPath?.(value) ?? value);
    });
  }

  async getLiveMediaSources(item) {
    if (!isNativeItemEntity(item)) throw new TypeError('Live media sources require a native entity.');
    if (item.SourceType === 'Channel') unsupported('Static channel media sources require a channel manager.');
    if (!VIDEO_TYPES.has(item.Type) && !['Audio', 'AudioBook'].includes(item.Type)) return [];
    return this.#runWithStates(async db => {
      const state = await this.#loadPostgresItemState(db, [item.Id], null, { includeUserData: false });
      state.byId.set(idKey(item.Id), item);
      return mediaSources(item, state, null, this.options);
    });
  }

  async getRoot({ user = null } = {}) {
    return this.#runWithStates(async db => {
      const state = await this.#loadPostgresItemState(db, [], user);
      const root = state.items.find(item => item.Type === 'UserRootFolder');
      if (!root) unsupported('The native user root has not been initialized.');
      return projectItem(root, state, user, dtoOptions({}, true), this.options);
    });
  }

  async getViews(input = {}, { user } = {}) {
    if (!user) throw libraryError(400, 'userId is required');
    const query = Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
    for (const key of Object.keys(query)) if (!['includehidden', 'includeexternalcontent', 'presetviews', 'userid'].includes(key)) unsupported(`User view parameter '${key}' is not implemented.`);
    return this.#runWithStates(async db => {
      const state = await this.load(db, user, { baseRows: await loadPostgresNavigationRows(db) });
      const hasExternal = await queryPostgresExternalViewPresence(db);
      if (hasExternal && query.includeexternalcontent !== false) unsupported('External user views are not implemented.');
      const items = await this.userViews.views(state, user, { includeHidden: query.includehidden === true, presetViews: query.presetviews ?? [] });
      const options = dtoOptions({}, true);
      await this.#prefetchPostgresDtos(items, state, user, options);
      const dtos = [];
      for (const item of items) dtos.push(await projectItem(item, state, user, options, this.options));
      return { Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 };
    });
  }
}
